/**
 * Public-endpoint market-data helpers used by the order-editor refresh
 * (`fetchTradableProducts` + `fetchMarketMidUsd` provider hooks) and by
 * the `priceDeviation` risk gate.
 *
 * Both venues use unauthenticated REST. We cache aggressively because
 * `priceDeviation` runs on every order approval and the order editor
 * may issue several `account-snapshot` calls per session.
 */
import { elizaLogger } from "@elizaos/core";

const MID_TTL_MS = 5_000;
const PRODUCTS_TTL_MS = 15 * 60 * 1_000;

interface MidEntry {
    price: number;
    fetchedAt: number;
}

interface ProductInfo {
    product_id: string;
    base_asset: string;
    quote_asset: string;
    /** Binance only — permissions array from exchangeInfo (SPOT/MARGIN/…). */
    permissions?: string[];
}

interface ProductsEntry {
    products: ProductInfo[];
    fetchedAt: number;
}

const midCache = new Map<string, MidEntry>();
const productsCache = new Map<string, ProductsEntry>();

const SUPPORTED_QUOTE_ASSETS = new Set(["USDT", "USDC", "USD"]);

function canonVenue(v: string): string {
    return v.trim().toLowerCase();
}

function midKey(venue: string, symbol: string): string {
    return `${canonVenue(venue)}|${symbol.toUpperCase()}`;
}

export interface FetchMidArgs {
    venue: string;
    symbol: string;
    /** Optional caller-supplied timeout (default 1500 ms). */
    timeoutMs?: number;
    signal?: AbortSignal;
    /**
     * Skip the per-process 5 s mid-price cache and force a fresh
     * ticker round-trip. Used by Fix 11 (quote-freshness re-check on
     * Confirm): the parameter-review path warmed the cache with the
     * approved_mid; the Confirm-time re-check needs a NEW quote to
     * detect drift, not the same number that triggered the modal.
     * Successful fresh fetches still update the cache for the next
     * normal caller.
     */
    bypassCache?: boolean;
}

export async function fetchPublicMidPrice(args: FetchMidArgs): Promise<number | null> {
    const venue = canonVenue(args.venue);
    const symbol = (args.symbol ?? "").trim();
    if (!symbol) return null;

    const key = midKey(venue, symbol);
    if (!args.bypassCache) {
        const cached = midCache.get(key);
        if (cached && Date.now() - cached.fetchedAt < MID_TTL_MS) {
            return cached.price;
        }
    }

    const url = venue === "coinbase" ? coinbaseTickerUrl(symbol) : binanceTickerUrl(symbol);
    if (!url) return null;

    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (args.signal) {
        if (args.signal.aborted) return null;
        args.signal.addEventListener("abort", onAbort);
    }
    const timer = setTimeout(() => ctl.abort(), args.timeoutMs ?? 1_500);
    try {
        const resp = await fetch(url, { signal: ctl.signal });
        if (!resp.ok) return null;
        const data = (await resp.json()) as { price?: string };
        const price = Number.parseFloat(data?.price ?? "");
        if (!Number.isFinite(price) || price <= 0) return null;
        midCache.set(key, { price, fetchedAt: Date.now() });
        return price;
    } catch (err) {
        elizaLogger.debug(
            `[plugin-cex] fetchPublicMidPrice ${venue}:${symbol} failed: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
        return null;
    } finally {
        clearTimeout(timer);
        if (args.signal) args.signal.removeEventListener("abort", onAbort);
    }
}

function binanceTickerUrl(symbol: string): string {
    const symbolNoSep = symbol.replace(/[-_/]/g, "").toUpperCase();
    return `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbolNoSep)}`;
}

function coinbaseTickerUrl(symbol: string): string | null {
    const dash = symbol.includes("-")
        ? symbol
        : symbol.replace(/(USDT|USDC|USD|EUR|BTC|ETH)$/i, "-$1");
    if (!dash.includes("-")) return null;
    return `https://api.exchange.coinbase.com/products/${encodeURIComponent(dash)}/ticker`;
}

export interface FetchProductsArgs {
    venue: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Skip cache and force a refetch — for ops debugging. */
    force?: boolean;
    /**
     * Restrict the result to margin-eligible products. On Binance, filters
     * by `permissions` containing `MARGIN`. On Coinbase, always returns
     * null (no margin trading per CLAUDE.md) — the editor hides the
     * Cross/Isolated tabs upstream so this code path is defensive only.
     */
    marginType?: "cross" | "isolated";
}

export interface PublicProductsResult {
    venue: string;
    products: Array<{ product_id: string; base_asset: string; quote_asset: string }>;
    fetched_at_ms: number;
    /** Echoes the request filter so the client cache key matches. */
    marginType?: "cross" | "isolated";
}

export async function fetchPublicTradableProducts(
    args: FetchProductsArgs,
): Promise<PublicProductsResult | null> {
    const venue = canonVenue(args.venue);
    if (venue !== "binance" && venue !== "coinbase") return null;
    if (args.marginType && venue !== "binance") return null;

    if (!args.force) {
        const cached = productsCache.get(venue);
        if (cached && Date.now() - cached.fetchedAt < PRODUCTS_TTL_MS) {
            const filtered = applyMarginFilter(cached.products, args.marginType);
            return {
                venue,
                products: filtered.map(({ permissions: _p, ...rest }) => rest),
                fetched_at_ms: cached.fetchedAt,
                marginType: args.marginType,
            };
        }
    }

    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (args.signal) {
        if (args.signal.aborted) return null;
        args.signal.addEventListener("abort", onAbort);
    }
    const timer = setTimeout(() => ctl.abort(), args.timeoutMs ?? 3_000);

    try {
        const products =
            venue === "binance"
                ? await fetchBinanceProducts(ctl.signal)
                : await fetchCoinbaseProducts(ctl.signal);
        if (!products || products.length === 0) return null;
        const fetched_at_ms = Date.now();
        productsCache.set(venue, { products, fetchedAt: fetched_at_ms });
        const filtered = applyMarginFilter(products, args.marginType);
        return {
            venue,
            products: filtered.map(({ permissions: _p, ...rest }) => rest),
            fetched_at_ms,
            marginType: args.marginType,
        };
    } catch (err) {
        elizaLogger.warn(
            `[plugin-cex] fetchPublicTradableProducts ${venue} failed: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
        return null;
    } finally {
        clearTimeout(timer);
        if (args.signal) args.signal.removeEventListener("abort", onAbort);
    }
}

function applyMarginFilter(
    products: ProductInfo[],
    marginType: "cross" | "isolated" | undefined,
): ProductInfo[] {
    if (!marginType) return products;
    return products.filter((p) => p.permissions?.includes("MARGIN"));
}

async function fetchBinanceProducts(signal: AbortSignal): Promise<ProductInfo[]> {
    const resp = await fetch("https://api.binance.com/api/v3/exchangeInfo", { signal });
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
        symbols?: Array<{
            symbol?: string;
            baseAsset?: string;
            quoteAsset?: string;
            status?: string;
            isSpotTradingAllowed?: boolean;
            permissions?: string[];
        }>;
    };
    const out: ProductInfo[] = [];
    for (const s of data.symbols ?? []) {
        if (s.status !== "TRADING") continue;
        if (s.isSpotTradingAllowed === false) continue;
        const base = (s.baseAsset ?? "").toUpperCase();
        const quote = (s.quoteAsset ?? "").toUpperCase();
        if (!base || !quote) continue;
        if (!SUPPORTED_QUOTE_ASSETS.has(quote)) continue;
        out.push({
            product_id: `${base}-${quote}`,
            base_asset: base,
            quote_asset: quote,
            permissions: Array.isArray(s.permissions) ? [...s.permissions] : undefined,
        });
    }
    return out.sort((a, b) => a.product_id.localeCompare(b.product_id));
}

async function fetchCoinbaseProducts(signal: AbortSignal): Promise<ProductInfo[]> {
    const resp = await fetch("https://api.exchange.coinbase.com/products", { signal });
    if (!resp.ok) return [];
    const data = (await resp.json()) as Array<{
        id?: string;
        base_currency?: string;
        quote_currency?: string;
        status?: string;
        trading_disabled?: boolean;
    }>;
    const out: ProductInfo[] = [];
    for (const p of data ?? []) {
        if (p.status !== "online") continue;
        if (p.trading_disabled === true) continue;
        const base = (p.base_currency ?? "").toUpperCase();
        const quote = (p.quote_currency ?? "").toUpperCase();
        if (!base || !quote) continue;
        if (!SUPPORTED_QUOTE_ASSETS.has(quote)) continue;
        out.push({ product_id: `${base}-${quote}`, base_asset: base, quote_asset: quote });
    }
    return out.sort((a, b) => a.product_id.localeCompare(b.product_id));
}

/** Test-only: clear caches between unit tests. */
export function __resetPublicMarketDataCaches(): void {
    midCache.clear();
    productsCache.clear();
}
