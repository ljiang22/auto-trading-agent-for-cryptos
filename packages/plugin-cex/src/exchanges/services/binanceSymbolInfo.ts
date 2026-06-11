/**
 * Fix 7 — public Binance symbol-info fetcher used by the plan-time
 * validator chain.
 *
 * The class-scoped `BinanceOrdersService.fetchSymbolFilters` uses the
 * authenticated SDK (`spot.restAPI.exchangeInfo`) because it lives
 * inside an orders service that already has credentials. The plan
 * runner runs BEFORE any user-credentialed action handler is invoked,
 * so it needs an auth-free path against the same public endpoint:
 *
 *   GET https://api.binance.com/api/v3/exchangeInfo?symbol=<symbol>
 *
 * Behavior:
 *  - Returns `BinanceSymbolFilters` with `status` and `minNotional`
 *    populated when the venue surfaces them.
 *  - 1-hour per-symbol cache, deduped against concurrent cold callers
 *    via single-flight (mirrors the existing pattern in
 *    `binancePricing.ts` / `FileStorageService.getChartIndex`).
 *  - Returns null on any network / parse failure so the plan-time
 *    chain can degrade gracefully. The existing execute-time
 *    quantization/symbol layer remains the authoritative final check.
 */

import { elizaLogger, formatAxiosErrorLine, httpClient } from "@elizaos/core";
import {
    extractBinanceSymbolFiltersFromResponse,
    type BinanceSymbolFilters,
} from "./binanceQuantization";

const BINANCE_EXCHANGE_INFO_URL =
    "https://api.binance.com/api/v3/exchangeInfo";

/** 1 h per-symbol TTL — filters are stable, status flips are rare. */
const SYMBOL_FILTERS_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
    filters: BinanceSymbolFilters;
    expiresAt: number;
}

/**
 * Module-level cache scoped to this process. Plan-time callers share
 * with each other but NOT with the class-scoped cache in
 * `binance.ts` — the two paths serve different surface areas (public
 * vs. SDK-credentialed) and the values are interchangeable enough
 * that we accept the duplicated network request as a one-per-hour
 * trade-off.
 */
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<BinanceSymbolFilters | null>>();

/** Test-only — clears both the resolved cache and any in-flight promises. */
export function __resetBinanceSymbolInfoCacheForTests(): void {
    cache.clear();
    inflight.clear();
}

/**
 * Normalize an exchange symbol to Binance wire format. Accepts canonical
 * "BTC-USDT" / lower-case forms and emits "BTCUSDT".
 */
function normalizeSymbol(symbol: string): string {
    return symbol.replace(/-/g, "").toUpperCase().trim();
}

/**
 * Fetch the symbol's filters (status + LOT_SIZE + PRICE_FILTER + NOTIONAL)
 * via the public exchangeInfo endpoint. Returns the cached entry on hit;
 * fires a single network request on cold miss (deduped via `inflight`).
 * Returns null on any failure so callers can degrade gracefully.
 *
 * NOTE: Per-symbol query is preferred over the full unfiltered
 * exchangeInfo (~2 MB of JSON). Binance also exposes `symbols` array
 * form for multi-symbol fetches if a future caller needs it.
 */
export async function fetchBinanceSymbolFilters(
    symbol: string,
): Promise<BinanceSymbolFilters | null> {
    const key = normalizeSymbol(symbol);
    if (key.length === 0) return null;

    const now = Date.now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) return cached.filters;

    const existing = inflight.get(key);
    if (existing) return existing;

    const promise = (async (): Promise<BinanceSymbolFilters | null> => {
        try {
            const resp = await httpClient.get<unknown>(BINANCE_EXCHANGE_INFO_URL, {
                params: { symbol: key },
                timeout: 5_000,
            });
            const filters = extractBinanceSymbolFiltersFromResponse(resp.data, key);
            // Treat an entirely empty extraction as a miss — the symbol
            // either doesn't exist on Binance or the response shape
            // changed. Don't poison the cache with the empty value;
            // let the next caller retry.
            if (
                !filters.status &&
                !filters.minQty &&
                !filters.stepSize &&
                !filters.minNotional &&
                !filters.tickSize
            ) {
                return null;
            }
            cache.set(key, { filters, expiresAt: now + SYMBOL_FILTERS_TTL_MS });
            return filters;
        } catch (err) {
            elizaLogger.warn(
                `[plugin-cex] fetchBinanceSymbolFilters(${key}) failed: ${formatAxiosErrorLine(err)}`,
            );
            return null;
        }
    })();

    inflight.set(key, promise);
    try {
        return await promise;
    } finally {
        inflight.delete(key);
    }
}
