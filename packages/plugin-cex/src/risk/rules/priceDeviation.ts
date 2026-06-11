import type { CanonicalIntent } from "../../intent/canonicalIntent";
import type { RiskEvaluationContext, RiskRuleResult } from "../types";

/**
 * Catches limit prices wildly off market — the "BTC price on ETH pair"
 * pilot-error shape. Compares `intent.price_params.limit_price` against
 * `ctx.market_mid_usd`; if `|limit − mid| / mid > cap`, blocks.
 *
 * Cap = `min(intent.execution_constraints.price_deviation_max_pct,
 * ctx.preferences.price_deviation_max_pct)`. User-provided overrides
 * can only tighten, never loosen.
 *
 * Fail-open when market data is unavailable (`market_mid_usd` missing
 * or ≤ 0) — matches the slippageCap discipline so a downed ticker
 * doesn't halt all trading.
 */
export function priceDeviation(
    intent: CanonicalIntent,
    ctx: RiskEvaluationContext,
): RiskRuleResult {
    if (intent.action !== "create_order") {
        return { id: "priceDeviation", verdict: "allow" };
    }
    const orderType = intent.order_type;
    if (orderType === "market" || orderType === undefined) {
        return { id: "priceDeviation", verdict: "allow" };
    }
    const limitPriceRaw = intent.price_params?.limit_price;
    if (!limitPriceRaw) {
        return { id: "priceDeviation", verdict: "allow" };
    }
    const limit = Number.parseFloat(limitPriceRaw);
    if (!Number.isFinite(limit) || limit <= 0) {
        return { id: "priceDeviation", verdict: "allow" };
    }
    const mid = ctx.market_mid_usd;
    if (mid === undefined || !Number.isFinite(mid) || mid <= 0) {
        return { id: "priceDeviation", verdict: "allow" };
    }
    const profileCap = ctx.preferences.price_deviation_max_pct;
    const userCap = intent.execution_constraints?.price_deviation_max_pct;
    const cap =
        userCap !== undefined && Number.isFinite(userCap)
            ? Math.min(userCap, profileCap)
            : profileCap;
    if (!Number.isFinite(cap) || cap < 0) {
        return { id: "priceDeviation", verdict: "allow" };
    }
    const deviation = Math.abs(limit - mid) / mid;
    if (deviation <= cap) {
        return { id: "priceDeviation", verdict: "allow" };
    }
    const pctStr = (deviation * 100).toFixed(2);
    const capStr = (cap * 100).toFixed(2);
    return {
        id: "priceDeviation",
        verdict: "block",
        explanation:
            `Limit price ${limit} differs from market ~${mid.toFixed(2)} by ${pctStr}% — ` +
            `exceeds price-deviation cap ${capStr}%. ` +
            `Common cause: wrong pair (e.g. BTC price on ETH pair) or a typo.`,
        metadata: {
            limit_price: limit,
            market_mid_usd: mid,
            deviation_pct: deviation,
            price_deviation_max_pct: cap,
        },
    };
}
