import type { OrderConfiguration } from "../../types";

// Quantizes Coinbase order quantities/prices against per-product increments so the
// REST API does not reject the order with "amount has too many decimal places".
//
// Coinbase Advanced Trade products expose `base_increment`, `quote_increment`, and
// `price_increment`; submitted `base_size` / `quote_size` / `*_price` strings must
// be exact multiples of the relevant increment. The LLM that emits the order JSON
// has no awareness of these grids and routinely produces over-precise values
// (e.g. `quote_size: "100.123456"` for BTC-USDC whose `quote_increment` is `0.01`).
//
// Sizes are FLOORED so we never exceed the user's stated intent (never spend more
// than asked, never sell more than available). Prices use round-half-up.
//
// Decimal arithmetic uses BigInt to avoid float drift (e.g. `0.1 + 0.2`).

export interface CoinbaseProductMeta {
    base_increment?: string;
    quote_increment?: string;
    price_increment?: string;
}

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
    // are guaranteed to be zero — drop them, then strip any remaining trailing zeros
    // so we emit a canonical decimal string (e.g. "0.5" not "0.5000").
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

    // Fix 5 (5d) — throw rather than silently returning undefined when a
    // non-positive value reaches the quantizer. The schema layer
    // (`positiveDecimalString`) and risk-engine `minOrderSize` rule
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
        // round-half-up
        quantized = ((valInt + incInt / 2n) / incInt) * incInt;
    }

    return formatScaledBigInt(quantized, scaleDec, incInfo.decimals);
}

function priceIncrement(meta: CoinbaseProductMeta): string | undefined {
    return meta.price_increment ?? meta.quote_increment;
}

type SizeFields = { base_size?: string; quote_size?: string };

function applySizeIncrements<T extends SizeFields>(target: T, meta: CoinbaseProductMeta): void {
    const baseQ = quantizeDecimalString(target.base_size, meta.base_increment, "floor");
    if (baseQ !== undefined) target.base_size = baseQ;
    const quoteQ = quantizeDecimalString(target.quote_size, meta.quote_increment, "floor");
    if (quoteQ !== undefined) target.quote_size = quoteQ;
}

function applyPriceField<T extends Record<string, unknown>>(
    target: T,
    field: keyof T & string,
    priceInc: string | undefined,
): void {
    const value = target[field];
    const q = quantizeDecimalString(value, priceInc, "round");
    if (q !== undefined) {
        (target as Record<string, unknown>)[field] = q;
    }
}

/**
 * Returns a NEW order configuration with sizes/prices rounded to Coinbase product
 * increments. Pure: does not mutate the input.
 *
 * If `meta` is empty or contains no usable increments, the configuration passes
 * through unchanged. Individual fields that cannot be parsed are also left as-is
 * (the existing upstream validator will reject the order before submit).
 */
export function quantizeCoinbaseOrderConfiguration(
    orderConfiguration: OrderConfiguration,
    meta: CoinbaseProductMeta,
): OrderConfiguration {
    const cloned: OrderConfiguration = JSON.parse(JSON.stringify(orderConfiguration));
    const priceInc = priceIncrement(meta);

    if (cloned.market_market_ioc) applySizeIncrements(cloned.market_market_ioc, meta);
    if (cloned.market_market_fok) applySizeIncrements(cloned.market_market_fok, meta);

    if (cloned.limit_limit_gtc) {
        applySizeIncrements(cloned.limit_limit_gtc, meta);
        applyPriceField(cloned.limit_limit_gtc, "limit_price", priceInc);
    }
    if (cloned.limit_limit_gtd) {
        applySizeIncrements(cloned.limit_limit_gtd, meta);
        applyPriceField(cloned.limit_limit_gtd, "limit_price", priceInc);
    }
    if (cloned.sor_limit_ioc) {
        applySizeIncrements(cloned.sor_limit_ioc, meta);
        applyPriceField(cloned.sor_limit_ioc, "limit_price", priceInc);
    }
    if (cloned.limit_limit_fok) {
        applySizeIncrements(cloned.limit_limit_fok, meta);
        applyPriceField(cloned.limit_limit_fok, "limit_price", priceInc);
    }
    if (cloned.stop_limit_stop_limit_gtc) {
        applySizeIncrements(cloned.stop_limit_stop_limit_gtc, meta);
        applyPriceField(cloned.stop_limit_stop_limit_gtc, "stop_price", priceInc);
        applyPriceField(cloned.stop_limit_stop_limit_gtc, "limit_price", priceInc);
    }
    if (cloned.stop_limit_stop_limit_gtd) {
        applySizeIncrements(cloned.stop_limit_stop_limit_gtd, meta);
        applyPriceField(cloned.stop_limit_stop_limit_gtd, "stop_price", priceInc);
        applyPriceField(cloned.stop_limit_stop_limit_gtd, "limit_price", priceInc);
    }
    if (cloned.trigger_bracket_gtc) {
        applyPriceField(cloned.trigger_bracket_gtc, "limit_price", priceInc);
        applyPriceField(cloned.trigger_bracket_gtc, "stop_trigger_price", priceInc);
    }
    if (cloned.trigger_bracket_gtd) {
        applyPriceField(cloned.trigger_bracket_gtd, "limit_price", priceInc);
        applyPriceField(cloned.trigger_bracket_gtd, "stop_trigger_price", priceInc);
    }

    return cloned;
}
