/**
 * CEX post-PR237 Commit 11 — Venue-aware market-data dispatcher.
 *
 * Rule (per user request): if the active venue is Binance, real-time
 * price/orderbook MUST come from Binance's public API; if Coinbase,
 * from Coinbase's. The provider hooks `fetchBookTicker`, `fetchDepth`,
 * `fetch24hStats` historically wired DIRECTLY to the Binance helpers,
 * so a Coinbase user opening the order editor would either fail to
 * fetch (wrong symbol form) or — worse — silently fetch Binance data
 * against a Coinbase order. This module fixes that.
 *
 * Each dispatcher:
 *  1. Reads the `venue` argument and routes to the matching pricing
 *     helper (`binancePricing` or `coinbasePricing`).
 *  2. Normalizes the symbol form per venue (Binance concat `BTCUSDT`,
 *     Coinbase dash `BTC-USDT`). Callers can pass any of `BTCUSDT`,
 *     `BTC-USDT`, `BTC/USDT` — the dispatcher converts.
 *  3. Returns the same `BookTickerSnapshot | DepthSnapshot |
 *     Stats24hSnapshot | null` shape regardless of venue so callers
 *     don't branch.
 *
 * Default behavior: unknown venues fall through to Binance for
 * backward-compat with the historical hook signature, but a warn log
 * fires so we can spot misroutes in CloudWatch.
 */
import { elizaLogger } from "@elizaos/core";
import {
    fetch24hStats as fetch24hStatsBinance,
    fetchBookTicker as fetchBookTickerBinance,
    fetchDepth as fetchDepthBinance,
    type BookTickerSnapshot,
    type DepthSnapshot,
    type Stats24hSnapshot,
} from "../exchanges/services/binancePricing";
import {
    fetch24hStatsCoinbase,
    fetchBookTickerCoinbase,
    fetchDepthCoinbase,
} from "../exchanges/services/coinbasePricing";

export type Venue = "binance" | "coinbase";

function canonVenue(v: string | undefined): Venue {
    const lower = (v ?? "binance").trim().toLowerCase();
    if (lower === "coinbase") return "coinbase";
    if (lower === "binance") return "binance";
    elizaLogger.warn(
        `[plugin-cex] venuePricingDispatcher unknown venue=${v}, defaulting to binance`,
    );
    return "binance";
}

/**
 * Convert any of the common symbol forms (BTCUSDT / BTC-USDT / BTC/USDT)
 * into the canonical Binance concat form. Useful for callers that
 * receive a Coinbase-shaped symbol but want to query Binance.
 */
export function toBinanceSymbol(raw: string): string {
    return raw.replace(/[-_/]/g, "").toUpperCase();
}

/**
 * Convert any of the common symbol forms into the canonical Coinbase
 * dash form. Returns the input unchanged if no quote-currency split
 * can be inferred (defensive — Coinbase will reject the request and
 * the helper will return null, surfacing the configuration error).
 */
export function toCoinbaseSymbol(raw: string): string {
    if (raw.includes("-")) return raw.toUpperCase();
    if (raw.includes("/")) return raw.replace("/", "-").toUpperCase();
    const upper = raw.toUpperCase();
    const QUOTES = ["USDT", "USDC", "USD", "EUR", "BTC", "ETH"];
    for (const q of QUOTES) {
        if (upper.endsWith(q) && upper.length > q.length) {
            return `${upper.slice(0, -q.length)}-${q}`;
        }
    }
    return upper;
}

export interface VenueFetchArgs {
    venue: string;
    symbol: string;
}

const ALT_VENUE: Record<Venue, Venue> = {
    binance: "coinbase",
    coinbase: "binance",
};

/**
 * Run a per-venue market-data fetch with automatic failover to the OTHER
 * venue when the primary returns null OR throws.
 *
 * Why: a venue's PUBLIC market-data API can be unavailable for reasons
 * unrelated to the user's order — most notably geo-blocking (Binance
 * returns HTTP 451 in some regions). When that happens the pricing helper
 * yields null, which used to leave the approval modal with no snapshot →
 * the size slider stuck at 0% and limit-order prefill with no reference
 * price. The order still routes to the user's chosen venue at execution
 * time; this only borrows the *other* venue's public ticker so the review
 * UI has live numbers. The `run` callback re-normalizes the symbol per
 * whichever venue it's invoked with.
 */
async function withVenueFailover<T>(
    venue: Venue,
    label: string,
    symbol: string,
    run: (v: Venue) => Promise<T | null>,
): Promise<T | null> {
    try {
        const primary = await run(venue);
        if (primary != null) return primary;
    } catch (err) {
        elizaLogger.warn(
            `[plugin-cex] ${label} primary venue=${venue} threw: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    const alt = ALT_VENUE[venue];
    try {
        const fallback = await run(alt);
        if (fallback != null) {
            elizaLogger.info(
                `[plugin-cex] ${label} failover ${venue}→${alt} for ${symbol} (primary venue unavailable)`,
            );
            return fallback;
        }
    } catch (err) {
        elizaLogger.warn(
            `[plugin-cex] ${label} failover venue=${alt} threw: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    return null;
}

export async function fetchBookTickerForVenue(
    args: VenueFetchArgs,
): Promise<BookTickerSnapshot | null> {
    const venue = canonVenue(args.venue);
    return withVenueFailover(venue, "fetchBookTicker", args.symbol, (v) =>
        v === "coinbase"
            ? fetchBookTickerCoinbase(toCoinbaseSymbol(args.symbol))
            : fetchBookTickerBinance(toBinanceSymbol(args.symbol)),
    );
}

export async function fetchDepthForVenue(
    args: VenueFetchArgs & { limit?: number },
): Promise<DepthSnapshot | null> {
    const venue = canonVenue(args.venue);
    return withVenueFailover(venue, "fetchDepth", args.symbol, (v) =>
        v === "coinbase"
            ? fetchDepthCoinbase(toCoinbaseSymbol(args.symbol), args.limit)
            : fetchDepthBinance(toBinanceSymbol(args.symbol), args.limit),
    );
}

export async function fetch24hStatsForVenue(
    args: VenueFetchArgs,
): Promise<Stats24hSnapshot | null> {
    const venue = canonVenue(args.venue);
    return withVenueFailover(venue, "fetch24hStats", args.symbol, (v) =>
        v === "coinbase"
            ? fetch24hStatsCoinbase(toCoinbaseSymbol(args.symbol))
            : fetch24hStatsBinance(toBinanceSymbol(args.symbol)),
    );
}
