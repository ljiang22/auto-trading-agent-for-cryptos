/**
 * Normalizes user/LLM pair strings to hyphenated BASE-QUOTE (e.g. BTC-USDC).
 * Used at exchange REST boundaries (Coinbase product_id, Binance symbol derivation).
 *
 * Limitations: suffix-split is heuristic; ambiguous tickers (e.g. multi-segment names)
 * may not split correctly—unknown shapes are uppercased and passed through.
 */

/** Longer / more specific quote assets first so USDC wins over USD where relevant. */
const QUOTE_SUFFIXES = [
    "USDC",
    "USDT",
    "FDUSD",
    "TUSD",
    "BUSD",
    "USDP",
    "USDD",
    "DAI",
    "PYUSD",
    "USDE",
    "USD",
    "EUR",
    "GBP",
    "JPY",
    "TRY",
    "BRL",
    "AUD",
    "CAD",
] as const;

export function canonicalSpotProductId(raw: string): string {
    let s = raw.trim().replace(/\s+/g, "").toUpperCase();
    if (!s) return s;

    s = s.replace(/\//g, "-").replace(/_/g, "-");
    s = s.replace(/-+/g, "-").replace(/^-|-$/g, "");

    if (s.includes("-")) {
        return s;
    }

    for (const q of QUOTE_SUFFIXES) {
        if (s.endsWith(q) && s.length > q.length) {
            const base = s.slice(0, -q.length);
            if (base.length >= 1 && /^[A-Z0-9]+$/.test(base)) {
                return `${base}-${q}`;
            }
        }
    }

    return s;
}
