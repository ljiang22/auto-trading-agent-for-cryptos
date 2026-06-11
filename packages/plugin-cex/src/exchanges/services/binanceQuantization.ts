// Quantizes Binance Spot order params against per-symbol exchange filters so the
// REST API does not reject the order with the opaque "Filter failure: LOT_SIZE"
// / "PRICE_FILTER" messages.
//
// Binance Spot exposes per-symbol `filters[]` via `GET /api/v3/exchangeInfo`.
// The three filters that bind `quantity` / `price` / `stopPrice`:
//
//   - LOT_SIZE         { minQty, maxQty, stepSize }   → base quantity (all order types)
//   - MARKET_LOT_SIZE  { minQty, maxQty, stepSize }   → base quantity for MARKET orders
//   - PRICE_FILTER     { minPrice, maxPrice, tickSize } → price and stopPrice
//
// The LLM that emits the order JSON has no awareness of these grids and will
// produce values like `quantity: "0.0001234567"` for BTCUSDT (whose stepSize is
// `0.00001`) or `price: "65432.567"` (tickSize `0.01`). The exchange rejects
// these with `-1013 Filter failure: LOT_SIZE` even though the user's intent was
// perfectly valid.
//
// Quantities are FLOORED (never spend / sell more than the user asked for).
// Prices and stopPrices use round-half-up against the tickSize grid.
// Decimal arithmetic uses BigInt to avoid float drift (e.g. `0.1 + 0.2`).
//
// Note: math primitives (parseIncrement / toScaledBigInt / formatScaledBigInt /
// quantizeDecimalString) intentionally mirror `coinbaseQuantization.ts`. The two
// files stay separate because Binance and Coinbase have different field names
// and per-order-type rules; extracting a shared module is a follow-up after
// both have soaked.

export interface BinanceSymbolFilters {
    /** LOT_SIZE: applies to base quantity on all order types */
    stepSize?: string;
    minQty?: string;
    maxQty?: string;
    /** MARKET_LOT_SIZE: applies to base quantity on MARKET orders only */
    marketStepSize?: string;
    marketMinQty?: string;
    marketMaxQty?: string;
    /** PRICE_FILTER: applies to price and stopPrice */
    tickSize?: string;
    minPrice?: string;
    maxPrice?: string;
    /**
     * NOTIONAL / MIN_NOTIONAL: minimum order value in quote currency
     * (e.g. USDT for BTCUSDT). Fix 7 — plan-time min-notional check
     * surfaces this to the planner so a sub-minimum order is refused
     * before the venue is called.
     */
    minNotional?: string;
    /**
     * Symbol-level trading status from `exchangeInfo` (e.g. "TRADING",
     * "BREAK", "HALT", "END_OF_DAY"). Anything other than "TRADING" means
     * orders are not currently accepted. Fix 7 — plan-time symbol-status
     * gate.
     */
    status?: string;
}

/** Order types treated as MARKET for MARKET_LOT_SIZE enforcement. */
const MARKET_ORDER_TYPES = new Set(["MARKET"]);

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

function parseIncrement(raw: string | undefined): { decimals: number; raw: string } | null {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (!DECIMAL_RE.test(trimmed)) return null;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) return null;
    const decimals = trimmed.includes(".") ? trimmed.split(".")[1].length : 0;
    return { decimals, raw: trimmed };
}

function toScaledBigInt(value: string, scaleDec: number): bigint | null {
    if (!DECIMAL_RE.test(value)) return null;
    const negative = value.startsWith("-");
    const abs = negative ? value.slice(1) : value;
    const [intPart, fracPart = ""] = abs.split(".");
    const padded = fracPart.padEnd(scaleDec, "0").slice(0, scaleDec);
    const combined = `${intPart}${padded}` || "0";
    try {
        const big = BigInt(combined);
        return negative ? -big : big;
    } catch {
        return null;
    }
}

function formatScaledBigInt(value: bigint, scaleDec: number, incDec: number): string {
    if (scaleDec === 0) return value.toString();
    const negative = value < 0n;
    const abs = negative ? -value : value;
    const digits = abs.toString().padStart(scaleDec + 1, "0");
    const intPart = digits.slice(0, digits.length - scaleDec);
    const fracDigits = digits.slice(digits.length - scaleDec);
    // The quantized value is a multiple of the increment, so digits beyond `incDec`
    // are guaranteed to be zero — drop them, then strip remaining trailing zeros.
    const fracTrimmed = fracDigits.slice(0, incDec).replace(/0+$/, "");
    const sign = negative ? "-" : "";
    if (fracTrimmed.length === 0) return `${sign}${intPart}`;
    return `${sign}${intPart}.${fracTrimmed}`;
}

function quantizeDecimalString(
    value: unknown,
    increment: string | undefined,
    mode: "floor" | "round",
): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0 || !DECIMAL_RE.test(trimmed)) return undefined;

    const incInfo = parseIncrement(increment);
    if (!incInfo) return undefined;

    const scaleDec = Math.max(
        trimmed.includes(".") ? trimmed.split(".")[1].length : 0,
        incInfo.decimals,
    );
    const valInt = toScaledBigInt(trimmed, scaleDec);
    const incInt = toScaledBigInt(incInfo.raw, scaleDec);
    if (valInt === null || incInt === null || incInt <= 0n) return undefined;
    // Fix 5 (5d) — throw rather than silently returning undefined so the
    // upstream catch path produces a clearer error message. The schema
    // layer (`positiveDecimalString`) and risk-engine `minOrderSize` rule
    // both block non-positive sizes before they reach here; if anything
    // makes it through, this is an internal-state bug that should surface
    // loudly instead of being absorbed into a quantization no-op.
    if (valInt <= 0n) {
        throw new Error(
            `non-positive order quantity rejected by quantizer: ${value}`,
        );
    }

    let quantized: bigint;
    if (mode === "floor") {
        quantized = (valInt / incInt) * incInt;
    } else {
        quantized = ((valInt + incInt / 2n) / incInt) * incInt;
    }

    return formatScaledBigInt(quantized, scaleDec, incInfo.decimals);
}

/**
 * Compare two non-negative decimal strings. Returns -1, 0, or 1.
 * Returns `null` if either input cannot be parsed.
 */
function compareDecimalStrings(a: string, b: string): number | null {
    if (!DECIMAL_RE.test(a) || !DECIMAL_RE.test(b)) return null;
    const decA = a.includes(".") ? a.split(".")[1].length : 0;
    const decB = b.includes(".") ? b.split(".")[1].length : 0;
    const scale = Math.max(decA, decB);
    const ai = toScaledBigInt(a, scale);
    const bi = toScaledBigInt(b, scale);
    if (ai === null || bi === null) return null;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
    return 0;
}

/**
 * Extract LOT_SIZE / MARKET_LOT_SIZE / PRICE_FILTER from an exchangeInfo response
 * symbols[] entry. Accepts an arbitrary object so callers do not have to import
 * the Binance SDK types directly.
 *
 * Returns an empty object when the input cannot be parsed; the caller should
 * skip quantization in that case (Binance will reject any over-precise order
 * with the same opaque message as before).
 */
export function extractBinanceSymbolFilters(raw: unknown): BinanceSymbolFilters {
    if (raw === null || typeof raw !== "object") return {};
    const obj = raw as Record<string, unknown>;
    const out: BinanceSymbolFilters = {};

    // Symbol-level status (Fix 7) — pulled from the symbols[] entry, NOT
    // from any inner filter row. "TRADING" is the only state that accepts
    // orders; everything else (BREAK, HALT, AUCTION_MATCH, END_OF_DAY)
    // means the symbol is dormant and a write would bounce at the venue.
    if (typeof obj.status === "string") out.status = obj.status;

    const filters = obj.filters;
    if (!Array.isArray(filters)) return out;

    for (const entry of filters) {
        if (entry === null || typeof entry !== "object") continue;
        const f = entry as Record<string, unknown>;
        const filterType = typeof f.filterType === "string" ? f.filterType : undefined;
        if (filterType === "LOT_SIZE") {
            if (typeof f.stepSize === "string") out.stepSize = f.stepSize;
            if (typeof f.minQty === "string") out.minQty = f.minQty;
            if (typeof f.maxQty === "string") out.maxQty = f.maxQty;
        } else if (filterType === "MARKET_LOT_SIZE") {
            if (typeof f.stepSize === "string") out.marketStepSize = f.stepSize;
            if (typeof f.minQty === "string") out.marketMinQty = f.minQty;
            if (typeof f.maxQty === "string") out.marketMaxQty = f.maxQty;
        } else if (filterType === "PRICE_FILTER") {
            if (typeof f.tickSize === "string") out.tickSize = f.tickSize;
            if (typeof f.minPrice === "string") out.minPrice = f.minPrice;
            if (typeof f.maxPrice === "string") out.maxPrice = f.maxPrice;
        } else if (filterType === "NOTIONAL" || filterType === "MIN_NOTIONAL") {
            // Binance migrated the filter name from MIN_NOTIONAL → NOTIONAL.
            // Both shapes carry the same `minNotional` field; accept either.
            if (typeof f.minNotional === "string") out.minNotional = f.minNotional;
        }
    }
    return out;
}

/**
 * Pull the filters for a single symbol from a full ExchangeInfoResponse.
 * Convenience wrapper used by the orders service; tests prefer the lower-level
 * `extractBinanceSymbolFilters` on a symbols-array entry directly.
 */
export function extractBinanceSymbolFiltersFromResponse(
    response: unknown,
    symbol: string,
): BinanceSymbolFilters {
    if (response === null || typeof response !== "object") return {};
    const obj = response as Record<string, unknown>;
    const symbols = obj.symbols;
    if (!Array.isArray(symbols)) return {};
    const target = symbol.toUpperCase();
    for (const entry of symbols) {
        if (entry === null || typeof entry !== "object") continue;
        const e = entry as Record<string, unknown>;
        if (typeof e.symbol === "string" && e.symbol.toUpperCase() === target) {
            return extractBinanceSymbolFilters(e);
        }
    }
    return {};
}

/** Treat a stepSize of "0" / "0.0" / "0.00..." as "no constraint". */
function isMeaningfulIncrement(raw: string | undefined): boolean {
    const parsed = parseIncrement(raw);
    return parsed !== null;
}

type BinanceBody = Record<string, string | number | boolean | undefined>;

/**
 * Returns a NEW order body with `quantity` floored to LOT_SIZE.stepSize (and to
 * MARKET_LOT_SIZE.stepSize for MARKET orders), and `price` / `stopPrice` rounded
 * to PRICE_FILTER.tickSize. Pure: does not mutate the input.
 *
 * If `filters` is empty / contains no usable increments, the body passes through
 * unchanged. Individual fields that cannot be parsed are also left as-is — the
 * exchange will reject the order with its usual filter-failure message, which
 * is no worse than the pre-fix behavior.
 *
 * Throws if the post-floor `quantity` falls below `minQty` (LOT_SIZE for limits,
 * the max of LOT_SIZE and MARKET_LOT_SIZE for MARKET orders). Surfacing a clean
 * error here saves a round-trip and replaces the opaque exchange message.
 *
 * `quoteOrderQty` is intentionally NOT quantized: it is a quote-currency amount
 * (e.g. USDT) bound by separate filters (NOTIONAL / quote-asset precision) that
 * are not part of LOT_SIZE / PRICE_FILTER. Leaving it as-is preserves the
 * pre-fix behavior for that field.
 */
export function quantizeBinanceOrderBody(
    body: BinanceBody,
    filters: BinanceSymbolFilters,
): BinanceBody {
    const out: BinanceBody = { ...body };
    const orderType = typeof body.type === "string" ? body.type.toUpperCase() : "";
    const isMarket = MARKET_ORDER_TYPES.has(orderType);

    // ---- quantity: floor by LOT_SIZE, then (for MARKET) also by MARKET_LOT_SIZE
    if (typeof out.quantity === "string") {
        let q = out.quantity;
        if (isMeaningfulIncrement(filters.stepSize)) {
            const next = quantizeDecimalString(q, filters.stepSize, "floor");
            if (next !== undefined) q = next;
        }
        if (isMarket && isMeaningfulIncrement(filters.marketStepSize)) {
            const next = quantizeDecimalString(q, filters.marketStepSize, "floor");
            if (next !== undefined) q = next;
        }
        if (q !== out.quantity) out.quantity = q;

        // minQty check: only run when we actually have an increment to compare
        // against, so missing-filter symbols pass through unchanged.
        const effectiveMinQty = isMarket
            ? maxDecimalString(filters.minQty, filters.marketMinQty)
            : filters.minQty;
        if (typeof effectiveMinQty === "string" && DECIMAL_RE.test(effectiveMinQty)) {
            const cmp = compareDecimalStrings(String(out.quantity), effectiveMinQty);
            if (cmp !== null && cmp < 0) {
                throw new Error(
                    `Order quantity ${out.quantity} is below the minimum ${effectiveMinQty} ` +
                        `for symbol ${String(body.symbol ?? "")} after step-size flooring`,
                );
            }
        }
    }

    // ---- price / stopPrice: round to tickSize
    if (isMeaningfulIncrement(filters.tickSize)) {
        if (typeof out.price === "string") {
            const next = quantizeDecimalString(out.price, filters.tickSize, "round");
            if (next !== undefined) out.price = next;
        }
        if (typeof out.stopPrice === "string") {
            const next = quantizeDecimalString(out.stopPrice, filters.tickSize, "round");
            if (next !== undefined) out.stopPrice = next;
        }
    }

    return out;
}

/** Returns the larger of two non-negative decimal strings (either may be missing). */
function maxDecimalString(a: string | undefined, b: string | undefined): string | undefined {
    if (typeof a !== "string") return typeof b === "string" ? b : undefined;
    if (typeof b !== "string") return a;
    const cmp = compareDecimalStrings(a, b);
    if (cmp === null) return a;
    return cmp >= 0 ? a : b;
}
