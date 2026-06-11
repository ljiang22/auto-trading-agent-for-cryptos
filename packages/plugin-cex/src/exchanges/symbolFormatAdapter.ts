/**
 * Per-venue symbol-format adapter.
 *
 * The agent's canonical pair shape is BASE-QUOTE (e.g. "BTC-USDT"),
 * matching Coinbase's `product_id` wire field. Binance Spot REST takes
 * the same pair without the dash ("BTCUSDT") on the `symbol` query
 * parameter; mixing the two formats produces -1121 "Invalid symbol".
 *
 * This util centralizes the per-venue translation so callers don't
 * need to remember which venue strips the dash. Keep it small and
 * pure — no I/O, no caching, no exchange lookups — so it's safe to
 * call from anywhere (reconciliation poller, venue REST builders,
 * WS handshake builders).
 *
 * H4 — `BTC-USDT` for Binance was sent verbatim by the reconciliation
 * fallback poller, returning HTTP 400 / -1121 for every stale order.
 * Fix: route every wire-bound symbol through `toVenueSymbol(symbol,
 * venue)`.
 */
import type { ExchangeName } from "../types";

const STRIP_NON_ALNUM = /[-_/\s]+/g;

/**
 * Translate a canonical (BASE-QUOTE) symbol to whatever the named
 * venue expects on the wire. Idempotent — passing an already-correct
 * form returns it unchanged.
 *
 *   toVenueSymbol("BTC-USDT", "binance")  → "BTCUSDT"
 *   toVenueSymbol("BTCUSDT",  "binance")  → "BTCUSDT"
 *   toVenueSymbol("BTC-USDT", "coinbase") → "BTC-USDT"
 *   toVenueSymbol("BTC_USDT", "binance")  → "BTCUSDT"
 *   toVenueSymbol("btc-usdt", "binance")  → "BTCUSDT"
 */
export function toVenueSymbol(symbol: string, venue: ExchangeName): string {
    if (!symbol) return symbol;
    const trimmed = symbol.trim().toUpperCase();
    if (venue === "binance") {
        // Binance Spot symbol = base + quote concatenated, uppercase.
        return trimmed.replace(STRIP_NON_ALNUM, "");
    }
    if (venue === "coinbase") {
        // Coinbase uses BASE-QUOTE. Normalize slash/underscore variants
        // to the canonical hyphen form so input like "BTC/USDT" still
        // works, but otherwise pass through.
        if (trimmed.includes("-")) return trimmed;
        if (trimmed.includes("/")) return trimmed.replace("/", "-");
        if (trimmed.includes("_")) return trimmed.replace("_", "-");
        return trimmed;
    }
    // Unknown venue — return the input untouched. Caller should
    // surface a route-not-implemented error elsewhere; we don't want
    // silent symbol mangling for venues we haven't audited.
    return trimmed;
}
