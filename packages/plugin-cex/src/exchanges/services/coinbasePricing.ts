/**
 * CEX post-PR237 Commit 11 — Coinbase public market-data helpers.
 *
 * Counterpart to `binancePricing.ts`. Used by:
 *  - The venue-aware modal-enrichment dispatcher (Commit 3 + 11)
 *  - The cross-check executable-side path (Commit 10)
 *  - Fix 15 ticker/orderbook actions for users on Coinbase
 *
 * Coinbase Exchange public endpoints accept dash-form product ids
 * (`BTC-USDT`, `BTC-USD`, `ETH-USDC`). The dispatcher in
 * `venuePricingDispatcher.ts` is responsible for converting whatever
 * symbol form the caller passes (concat / slash / dash) into the
 * canonical dash form before invoking these helpers, but we still
 * defend at the leaf in case a caller bypasses the dispatcher.
 *
 * Fail-soft contract: all helpers return null on any error so the
 * approval modal renders without the live snapshot rather than
 * blocking. Mirrors the Binance helpers' contract exactly so callers
 * can switch venues without re-implementing the null-handling code.
 *
 * 5-second per-process cache TTL — same as Binance — keyed on
 * `<endpoint>:<productId>` (e.g. `ticker:BTC-USDT`).
 */
import { elizaLogger, formatAxiosErrorLine, httpClient } from "@elizaos/core";
import type {
    BookTickerSnapshot,
    DepthSnapshot,
    Stats24hSnapshot,
} from "./binancePricing";

const COINBASE_API_BASE = "https://api.exchange.coinbase.com";

const CACHE_TTL_MS = 5_000;

interface PerSymbolCacheEntry<T> {
    value: T;
    fetchedAt: number;
}

const perSymbolCache = new Map<string, PerSymbolCacheEntry<unknown>>();
const perSymbolInflight = new Map<string, Promise<unknown>>();

/** Test-only: clear caches so a second call cold-fetches. */
export function __resetCoinbasePricingCacheForTests(): void {
    perSymbolCache.clear();
    perSymbolInflight.clear();
}

/**
 * Normalize a symbol to Coinbase's dash form. Accepts:
 *  - "BTC-USDT" / "btc-usd" → "BTC-USDT" / "BTC-USD" (passthrough + upper)
 *  - "BTCUSDT" / "BTCUSD" → "BTC-USDT" / "BTC-USD" (split on trailing quote)
 *  - "BTC/USDT" → "BTC-USDT" (separator swap)
 *
 * Returns null when the input doesn't look like a tradeable pair.
 */
function toCoinbaseProductId(raw: string): string | null {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim().toUpperCase();
    if (!trimmed) return null;
    if (trimmed.includes("-")) return trimmed;
    if (trimmed.includes("/")) return trimmed.replace("/", "-");
    // Concat form — split on trailing well-known quote currencies. Order
    // matters: USDT before USDC before USD so the longest match wins.
    const QUOTES = ["USDT", "USDC", "USD", "EUR", "BTC", "ETH"];
    for (const q of QUOTES) {
        if (trimmed.endsWith(q) && trimmed.length > q.length) {
            const base = trimmed.slice(0, -q.length);
            return `${base}-${q}`;
        }
    }
    return null;
}

async function withPerSymbolCache<T>(
    cacheKey: string,
    loader: () => Promise<T | null>,
): Promise<T | null> {
    const hit = perSymbolCache.get(cacheKey);
    if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
        return hit.value as T;
    }
    const existing = perSymbolInflight.get(cacheKey);
    if (existing) return (await existing) as T | null;

    const promise = (async (): Promise<T | null> => {
        try {
            const value = await loader();
            if (value !== null) {
                perSymbolCache.set(cacheKey, { value, fetchedAt: Date.now() });
            }
            return value;
        } catch (err) {
            elizaLogger.warn(
                `[plugin-cex] coinbase perSymbolCache loader failed for ${cacheKey}: ${formatAxiosErrorLine(err)}`,
            );
            return null;
        }
    })();
    perSymbolInflight.set(cacheKey, promise);
    try {
        return await promise;
    } finally {
        perSymbolInflight.delete(cacheKey);
    }
}

function computeSpreadBps(bid: number, ask: number): number {
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) return 0;
    if (bid <= 0 || ask <= 0) return 0;
    const mid = (ask + bid) / 2;
    if (mid <= 0) return 0;
    return ((ask - bid) / mid) * 10_000;
}

/**
 * Best bid / best ask from Coinbase Exchange's `/products/{id}/ticker`
 * endpoint. Response shape:
 *   { trade_id, price, size, bid, ask, volume, time }
 *
 * The endpoint does NOT return bid/ask quantities directly; we project
 * `size` (last trade size) into both `bidQty` and `askQty` as a
 * defensive best-effort so the BookTickerSnapshot shape is preserved.
 * The book endpoint (level=1) carries proper sizes — callers who need
 * accurate sizes should use `fetchDepth(productId, 1)` instead.
 */
export async function fetchBookTickerCoinbase(
    symbol: string,
): Promise<BookTickerSnapshot | null> {
    const productId = toCoinbaseProductId(symbol);
    if (!productId) return null;
    const cacheKey = `coinbase:ticker:${productId}`;
    return withPerSymbolCache<BookTickerSnapshot>(cacheKey, async () => {
        const resp = await httpClient.get<unknown>(
            `${COINBASE_API_BASE}/products/${encodeURIComponent(productId)}/ticker`,
            { timeout: 5_000 },
        );
        const body = resp.data;
        if (!body || typeof body !== "object") {
            elizaLogger.warn(
                `[plugin-cex] fetchBookTickerCoinbase(${productId}): unexpected response shape`,
            );
            return null;
        }
        const row = body as {
            bid?: unknown;
            ask?: unknown;
            size?: unknown;
        };
        const bidStr = typeof row.bid === "string" ? row.bid : null;
        const askStr = typeof row.ask === "string" ? row.ask : null;
        const sizeStr = typeof row.size === "string" ? row.size : "0";
        if (!bidStr || !askStr) {
            elizaLogger.warn(
                `[plugin-cex] fetchBookTickerCoinbase(${productId}): missing bid/ask`,
            );
            return null;
        }
        const bid = Number.parseFloat(bidStr);
        const ask = Number.parseFloat(askStr);
        return {
            bid: bidStr,
            bidQty: sizeStr,
            ask: askStr,
            askQty: sizeStr,
            spread_bps: computeSpreadBps(bid, ask),
        };
    });
}

/**
 * Top-N bids/asks from Coinbase Exchange's `/products/{id}/book?level=2`
 * endpoint. Response shape:
 *   { sequence, bids: [[price, size, num_orders], ...], asks: [...] }
 *
 * Coinbase returns up to 50 levels at level=2 (full book is level=3 and
 * requires authentication). We slice to `limit` to match the Binance
 * snapshot shape.
 */
export async function fetchDepthCoinbase(
    symbol: string,
    limit = 10,
): Promise<DepthSnapshot | null> {
    const productId = toCoinbaseProductId(symbol);
    if (!productId) return null;
    const clampedLimit = Math.min(Math.max(Math.trunc(limit), 1), 50);
    const cacheKey = `coinbase:depth:${productId}:${clampedLimit}`;
    return withPerSymbolCache<DepthSnapshot>(cacheKey, async () => {
        const resp = await httpClient.get<unknown>(
            `${COINBASE_API_BASE}/products/${encodeURIComponent(productId)}/book`,
            { params: { level: 2 }, timeout: 5_000 },
        );
        const body = resp.data;
        if (!body || typeof body !== "object") {
            elizaLogger.warn(
                `[plugin-cex] fetchDepthCoinbase(${productId}): unexpected response shape`,
            );
            return null;
        }
        const row = body as {
            bids?: unknown;
            asks?: unknown;
            sequence?: unknown;
        };
        const parseSide = (raw: unknown): Array<[string, string]> => {
            if (!Array.isArray(raw)) return [];
            const out: Array<[string, string]> = [];
            for (const item of raw) {
                if (!Array.isArray(item) || item.length < 2) continue;
                const price = item[0];
                const qty = item[1];
                if (typeof price !== "string" || typeof qty !== "string") continue;
                out.push([price, qty]);
                if (out.length >= clampedLimit) break;
            }
            return out;
        };
        return {
            bids: parseSide(row.bids),
            asks: parseSide(row.asks),
            lastUpdateId: typeof row.sequence === "number" ? row.sequence : 0,
        };
    });
}

/**
 * 24-hour rolling statistics from Coinbase Exchange's
 * `/products/{id}/stats` endpoint. Response shape:
 *   { open, high, low, last, volume, volume_30day }
 *
 * Coinbase does NOT directly return a percent-change figure; we
 * compute it from `(last - open) / open * 100`. `quote_volume` is
 * also missing; we approximate as `volume * weightedAvg` where
 * `weightedAvg = (open + last) / 2` (rough but bounded).
 */
export async function fetch24hStatsCoinbase(
    symbol: string,
): Promise<Stats24hSnapshot | null> {
    const productId = toCoinbaseProductId(symbol);
    if (!productId) return null;
    const cacheKey = `coinbase:24h:${productId}`;
    return withPerSymbolCache<Stats24hSnapshot>(cacheKey, async () => {
        const resp = await httpClient.get<unknown>(
            `${COINBASE_API_BASE}/products/${encodeURIComponent(productId)}/stats`,
            { timeout: 5_000 },
        );
        const body = resp.data;
        if (!body || typeof body !== "object") {
            elizaLogger.warn(
                `[plugin-cex] fetch24hStatsCoinbase(${productId}): unexpected response shape`,
            );
            return null;
        }
        const row = body as {
            open?: unknown;
            high?: unknown;
            low?: unknown;
            last?: unknown;
            volume?: unknown;
        };
        const openStr = typeof row.open === "string" ? row.open : null;
        const highStr = typeof row.high === "string" ? row.high : null;
        const lowStr = typeof row.low === "string" ? row.low : null;
        const lastStr = typeof row.last === "string" ? row.last : null;
        const volStr = typeof row.volume === "string" ? row.volume : null;
        if (!openStr || !highStr || !lowStr || !lastStr || !volStr) {
            elizaLogger.warn(
                `[plugin-cex] fetch24hStatsCoinbase(${productId}): missing required fields`,
            );
            return null;
        }
        const open = Number.parseFloat(openStr);
        const last = Number.parseFloat(lastStr);
        const vol = Number.parseFloat(volStr);
        const priceChangePct =
            Number.isFinite(open) && open > 0 && Number.isFinite(last)
                ? (((last - open) / open) * 100).toFixed(8)
                : "0";
        const weightedAvg =
            Number.isFinite(open) && Number.isFinite(last)
                ? ((open + last) / 2).toFixed(8)
                : lastStr;
        const quoteVolume =
            Number.isFinite(vol) && Number.isFinite(Number.parseFloat(weightedAvg))
                ? (vol * Number.parseFloat(weightedAvg)).toFixed(8)
                : "0";
        const now = Date.now();
        return {
            priceChangePercent: priceChangePct,
            weightedAvgPrice: weightedAvg,
            highPrice: highStr,
            lowPrice: lowStr,
            volume: volStr,
            quoteVolume,
            openTime: now - 24 * 60 * 60 * 1_000,
            closeTime: now,
        };
    });
}

// Re-exported helper so tests + dispatcher can probe the symbol form
// conversion without round-tripping through the network.
export { toCoinbaseProductId };
