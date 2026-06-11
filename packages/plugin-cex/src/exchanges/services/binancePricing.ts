/**
 * Fix 2 — Shared Binance pricing helper.
 *
 * Fetches USDT spot prices for a batch of base assets via Binance's public
 * batched ticker endpoint and caches the result for 5 seconds per process.
 *
 * Used by:
 *  - Fix 1  (balance USD totals)
 *  - Fix 11 (quote freshness)
 *  - Fix 14 (modal enrichment: bookTicker / depth / 24h stats)
 *  - Fix 15 (ticker/orderbook actions)
 *
 * The cache key is the sorted symbol list so callers asking for the same set
 * in different orders hit the same entry; the shape mirrors the paper-venue
 * mid-price cache but is intentionally NOT shared (paper-venue caches per
 * productId, this caches per request set). Fail-soft: any network/parse
 * error returns `{}` so callers can drop the total row and keep rendering.
 *
 * Fix 14 added three additional helpers (`fetchBookTicker`, `fetchDepth`,
 * `fetch24hStats`) which share the same 5-second per-symbol cache TTL but
 * use a DIFFERENT cache map keyed on `endpoint:symbol[:limit]` to avoid
 * colliding with the batched-ticker cache (which keys on `symbols.join(",")`).
 */
import { elizaLogger, formatAxiosErrorLine, httpClient } from "@elizaos/core";

/** Public Binance batched ticker endpoint. */
const BINANCE_TICKER_URL = "https://api.binance.com/api/v3/ticker/price";

/** Public Binance per-symbol best bid/ask ticker. */
const BINANCE_BOOK_TICKER_URL = "https://api.binance.com/api/v3/ticker/bookTicker";

/** Public Binance order-book depth endpoint. */
const BINANCE_DEPTH_URL = "https://api.binance.com/api/v3/depth";

/** Public Binance 24-hour rolling statistics endpoint. */
const BINANCE_24H_STATS_URL = "https://api.binance.com/api/v3/ticker/24hr";

/** Per-process cache TTL — mirrors paperVenue's mid-price cache shape. */
const CACHE_TTL_MS = 5_000;

interface CacheEntry {
    prices: Record<string, number>;
    fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Single-flight map: dedupe concurrent cold callers asking for the same
 * sorted symbol set. Without this two callers racing the 5 s cache TTL
 * would both miss and both fire the Binance batched-ticker request.
 * Mirrors the `FileStorageService.getChartIndex` pattern (PR #131).
 */
const inflight = new Map<string, Promise<Record<string, number>>>();

/**
 * Fix 14 — endpoint-keyed cache for the three per-symbol modal-enrichment
 * helpers. Distinct from `cache` (which holds the batched USDT-pair map)
 * so a `book:BTCUSDT` lookup never returns a `prices: {}` shape. Keys:
 *  - `book:{SYMBOL}`
 *  - `depth:{SYMBOL}:{LIMIT}`
 *  - `24h:{SYMBOL}`
 */
interface PerSymbolCacheEntry<T> {
    value: T;
    fetchedAt: number;
}
const perSymbolCache = new Map<string, PerSymbolCacheEntry<unknown>>();
const perSymbolInflight = new Map<string, Promise<unknown>>();

/** Test-only: clear the module cache so a second call cold-fetches. */
export function __resetBinancePricingCacheForTests(): void {
    cache.clear();
    inflight.clear();
    perSymbolCache.clear();
    perSymbolInflight.clear();
}

/**
 * Build the canonical Binance batched-ticker symbol payload. Binance expects
 * a URL-encoded JSON array like `symbols=["BTCUSDT","ETHUSDT"]`.
 */
function buildSymbolsParam(symbols: string[]): string {
    return JSON.stringify(symbols);
}

/**
 * Convert a base asset (e.g. "BTC") into Binance's USDT pair symbol
 * ("BTCUSDT"). Inputs are case-insensitive but output is upper-case.
 */
function toUsdtPair(asset: string): string {
    return `${asset.toUpperCase()}USDT`;
}

/**
 * Fetch USDT spot prices for a set of base assets via Binance's public
 * batched ticker endpoint. Returns a map keyed by the BASE asset (e.g.
 * `{ BTC: 76955, ETH: 3500 }`), NOT by the trading pair, so callers can
 * look prices up by the row's `currency` field directly.
 *
 * Behavior:
 *  - Empty input → empty result, no network call.
 *  - Cache hit within 5 s of the previous call for the same sorted set → no
 *    network call.
 *  - On any error (network, non-2xx, malformed body, single bad symbol that
 *    400s the whole batch) the full failure returns `{}`. Callers should
 *    treat missing keys as "no quote available" and skip the total row.
 *  - `bypassCache: true` skips the 5 s per-process cache (Fix 11 quote-
 *    freshness re-check on Confirm needs a fresh tick, not whatever the
 *    parameter-review path put in the cache 30 s ago). The single-flight
 *    inflight map is still consulted so concurrent callers don't fan out.
 *    A successful fresh fetch updates the cache for subsequent normal
 *    callers.
 */
export async function fetchBinanceUsdtPrices(
    symbols: string[],
    opts?: { bypassCache?: boolean },
): Promise<Record<string, number>> {
    if (!Array.isArray(symbols) || symbols.length === 0) return {};

    // Normalize + dedupe; cache key is the sorted upper-case set.
    const upper = Array.from(new Set(symbols.map((s) => s.toUpperCase()))).sort();
    if (upper.length === 0) return {};
    const cacheKey = upper.join(",");

    if (!opts?.bypassCache) {
        const cached = cache.get(cacheKey);
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
            return cached.prices;
        }
    }

    // Single-flight: if another caller is already fetching the same set,
    // await its promise instead of firing a duplicate batched-ticker call.
    const existing = inflight.get(cacheKey);
    if (existing) return existing;

    const pairs = upper.map(toUsdtPair);

    const promise = (async (): Promise<Record<string, number>> => {
        try {
            const resp = await httpClient.get<unknown>(BINANCE_TICKER_URL, {
                params: { symbols: buildSymbolsParam(pairs) },
                timeout: 5_000,
            });
            const body = resp.data;
            if (!Array.isArray(body)) {
                elizaLogger.warn(
                    "[plugin-cex] fetchBinanceUsdtPrices: unexpected response shape (not an array)",
                );
                return {};
            }
            const prices: Record<string, number> = {};
            for (const row of body) {
                if (!row || typeof row !== "object") continue;
                const symbol = (row as { symbol?: unknown }).symbol;
                const priceStr = (row as { price?: unknown }).price;
                if (typeof symbol !== "string" || typeof priceStr !== "string") continue;
                const upperSym = symbol.toUpperCase();
                if (!upperSym.endsWith("USDT")) continue;
                const base = upperSym.slice(0, -4);
                const p = Number.parseFloat(priceStr);
                if (Number.isFinite(p) && p > 0) {
                    prices[base] = p;
                }
            }
            cache.set(cacheKey, { prices, fetchedAt: Date.now() });
            return prices;
        } catch (err) {
            elizaLogger.warn(
                `[plugin-cex] fetchBinanceUsdtPrices failed: ${formatAxiosErrorLine(err)}`,
            );
            return {};
        }
    })();

    inflight.set(cacheKey, promise);
    try {
        return await promise;
    } finally {
        inflight.delete(cacheKey);
    }
}

/** Stablecoins that are 1:1 with USD/USDT for balance-total purposes. */
export const STABLECOIN_ASSETS: ReadonlySet<string> = new Set([
    "USDT",
    "USDC",
    "BUSD",
    "FDUSD",
    "TUSD",
]);

/**
 * Return `true` when the asset is a USD-pegged stablecoin we treat as a
 * 1.0 USDT quote (so it never needs a Binance lookup).
 */
export function isStablecoin(asset: string): boolean {
    return STABLECOIN_ASSETS.has(asset.toUpperCase());
}

// ────────────────────────────────────────────────────────────────────────
// Fix 14 — modal-enrichment helpers (book ticker, order-book depth, 24h
// stats). All three:
//  - Use Binance's PUBLIC endpoints (no signing, no user creds).
//  - Cache 5 s per-process (matches the batched-ticker cache TTL).
//  - Single-flight de-dup concurrent cold callers.
//  - Fail-soft: any error returns null so the approval modal renders
//    without the live snapshot rather than blocking.
// ────────────────────────────────────────────────────────────────────────

/** Best bid / best ask payload, computed from the bookTicker endpoint. */
export interface BookTickerSnapshot {
    /** Best bid price (highest buy) — string to preserve precision. */
    bid: string;
    /** Quantity available at `bid`. */
    bidQty: string;
    /** Best ask price (lowest sell). */
    ask: string;
    /** Quantity available at `ask`. */
    askQty: string;
    /**
     * Bid-ask spread expressed in basis points (1 bp = 0.01%). Computed
     * as `((ask - bid) / ((ask + bid) / 2)) * 10000`. The mid-price
     * denominator is the standard market-microstructure convention.
     * `0` when bid or ask is non-positive (defensive; the endpoint
     * normally returns valid two-sided quotes during trading hours).
     */
    spread_bps: number;
}

/** Order-book depth snapshot. `[price, qty]` rows, top-of-book first. */
export interface DepthSnapshot {
    bids: Array<[string, string]>;
    asks: Array<[string, string]>;
    lastUpdateId: number;
}

/** 24-hour rolling statistics snapshot. Strings preserve venue precision. */
export interface Stats24hSnapshot {
    priceChangePercent: string;
    weightedAvgPrice: string;
    highPrice: string;
    lowPrice: string;
    volume: string;
    quoteVolume: string;
    openTime: number;
    closeTime: number;
}

/**
 * Internal helper — read from `perSymbolCache` when fresh; otherwise
 * single-flight the supplied loader, cache the result on success, and
 * return null on any error.
 */
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
                `[plugin-cex] perSymbolCache loader failed for ${cacheKey}: ${formatAxiosErrorLine(err)}`,
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

/**
 * Compute the bid-ask spread in basis points. Defensive against the
 * (rare) case where the venue returns 0/negative quotes during an outage.
 */
function computeSpreadBps(bid: number, ask: number): number {
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) return 0;
    if (bid <= 0 || ask <= 0) return 0;
    const mid = (ask + bid) / 2;
    if (mid <= 0) return 0;
    return ((ask - bid) / mid) * 10_000;
}

/**
 * Fetch the best bid / best ask snapshot for a single symbol. Returns
 * null on any failure (network, parse, malformed body, non-2xx). Cached
 * 5 s per symbol; single-flight de-dups concurrent cold callers.
 */
export async function fetchBookTicker(symbol: string): Promise<BookTickerSnapshot | null> {
    if (!symbol || typeof symbol !== "string") return null;
    const upperSym = symbol.toUpperCase();
    const cacheKey = `book:${upperSym}`;
    return withPerSymbolCache<BookTickerSnapshot>(cacheKey, async () => {
        const resp = await httpClient.get<unknown>(BINANCE_BOOK_TICKER_URL, {
            params: { symbol: upperSym },
            timeout: 5_000,
        });
        const body = resp.data;
        if (!body || typeof body !== "object") {
            elizaLogger.warn(
                `[plugin-cex] fetchBookTicker(${upperSym}): unexpected response shape`,
            );
            return null;
        }
        const row = body as {
            bidPrice?: unknown;
            bidQty?: unknown;
            askPrice?: unknown;
            askQty?: unknown;
        };
        const bidStr = typeof row.bidPrice === "string" ? row.bidPrice : null;
        const bidQtyStr = typeof row.bidQty === "string" ? row.bidQty : null;
        const askStr = typeof row.askPrice === "string" ? row.askPrice : null;
        const askQtyStr = typeof row.askQty === "string" ? row.askQty : null;
        if (!bidStr || !bidQtyStr || !askStr || !askQtyStr) {
            elizaLogger.warn(
                `[plugin-cex] fetchBookTicker(${upperSym}): missing required fields`,
            );
            return null;
        }
        const bid = Number.parseFloat(bidStr);
        const ask = Number.parseFloat(askStr);
        return {
            bid: bidStr,
            bidQty: bidQtyStr,
            ask: askStr,
            askQty: askQtyStr,
            spread_bps: computeSpreadBps(bid, ask),
        };
    });
}

/**
 * Fetch the top-N bids/asks from the order book. Returns null on any
 * failure. `limit` is clamped to 1–100 — the modal-enrichment path
 * uses ≤20, the Fix 15 `get_orderbook` action goes up to 100. Cache
 * keys include the limit so `limit=5` / `limit=10` / `limit=100` do
 * not share a cache entry. Binance's depth endpoint accepts the
 * specific values 5/10/20/50/100/500/1000/5000 — values in between
 * are tolerated by the venue (it picks the next-larger supported
 * limit), so we don't snap-to-the-grid here.
 */
export async function fetchDepth(
    symbol: string,
    limit = 10,
): Promise<DepthSnapshot | null> {
    if (!symbol || typeof symbol !== "string") return null;
    const upperSym = symbol.toUpperCase();
    const clampedLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const cacheKey = `depth:${upperSym}:${clampedLimit}`;
    return withPerSymbolCache<DepthSnapshot>(cacheKey, async () => {
        const resp = await httpClient.get<unknown>(BINANCE_DEPTH_URL, {
            params: { symbol: upperSym, limit: clampedLimit },
            timeout: 5_000,
        });
        const body = resp.data;
        if (!body || typeof body !== "object") {
            elizaLogger.warn(
                `[plugin-cex] fetchDepth(${upperSym}, ${clampedLimit}): unexpected response shape`,
            );
            return null;
        }
        const row = body as {
            bids?: unknown;
            asks?: unknown;
            lastUpdateId?: unknown;
        };
        const lastUpdateId =
            typeof row.lastUpdateId === "number" ? row.lastUpdateId : 0;
        const parseSide = (raw: unknown): Array<[string, string]> => {
            if (!Array.isArray(raw)) return [];
            const out: Array<[string, string]> = [];
            for (const item of raw) {
                if (!Array.isArray(item) || item.length < 2) continue;
                const price = item[0];
                const qty = item[1];
                if (typeof price !== "string" || typeof qty !== "string") continue;
                out.push([price, qty]);
            }
            return out;
        };
        return {
            bids: parseSide(row.bids),
            asks: parseSide(row.asks),
            lastUpdateId,
        };
    });
}

/**
 * Fetch the 24-hour rolling statistics for a single symbol. Returns
 * null on any failure. Strings preserve precision; callers parse on
 * demand.
 */
export async function fetch24hStats(symbol: string): Promise<Stats24hSnapshot | null> {
    if (!symbol || typeof symbol !== "string") return null;
    const upperSym = symbol.toUpperCase();
    const cacheKey = `24h:${upperSym}`;
    return withPerSymbolCache<Stats24hSnapshot>(cacheKey, async () => {
        const resp = await httpClient.get<unknown>(BINANCE_24H_STATS_URL, {
            params: { symbol: upperSym },
            timeout: 5_000,
        });
        const body = resp.data;
        if (!body || typeof body !== "object") {
            elizaLogger.warn(
                `[plugin-cex] fetch24hStats(${upperSym}): unexpected response shape`,
            );
            return null;
        }
        const row = body as {
            priceChangePercent?: unknown;
            weightedAvgPrice?: unknown;
            highPrice?: unknown;
            lowPrice?: unknown;
            volume?: unknown;
            quoteVolume?: unknown;
            openTime?: unknown;
            closeTime?: unknown;
        };
        const reqStr = (v: unknown): string | null =>
            typeof v === "string" ? v : null;
        const priceChangePercent = reqStr(row.priceChangePercent);
        const weightedAvgPrice = reqStr(row.weightedAvgPrice);
        const highPrice = reqStr(row.highPrice);
        const lowPrice = reqStr(row.lowPrice);
        const volume = reqStr(row.volume);
        const quoteVolume = reqStr(row.quoteVolume);
        if (
            priceChangePercent === null ||
            weightedAvgPrice === null ||
            highPrice === null ||
            lowPrice === null ||
            volume === null ||
            quoteVolume === null
        ) {
            elizaLogger.warn(
                `[plugin-cex] fetch24hStats(${upperSym}): missing required fields`,
            );
            return null;
        }
        return {
            priceChangePercent,
            weightedAvgPrice,
            highPrice,
            lowPrice,
            volume,
            quoteVolume,
            openTime: typeof row.openTime === "number" ? row.openTime : 0,
            closeTime: typeof row.closeTime === "number" ? row.closeTime : 0,
        };
    });
}
