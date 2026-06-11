import type { CanonicalIntent } from "../../intent/canonicalIntent";
import type { RiskEvaluationContext, RiskRuleResult } from "../types";

/**
 * Fix 5 — defense-in-depth rejection of orders whose size is missing or
 * non-positive. The schema layer (`positiveDecimalString` on `base_size`
 * and `quote_size`) catches "0" / "-1" / "0.0" at parse time, but the
 * risk engine also runs on intents constructed bypassing that schema
 * (e.g. from the ADK fast-path or a future caller that builds a
 * partial intent in code). This rule fires last-resort BLOCK when
 * neither `base_size` nor `quote_size` resolves to a strictly-positive
 * decimal.
 *
 * Read-only / cancel / amend actions skip the rule — only
 * `create_order` and `preview_order` carry sizes.
 */
export function minOrderSize(
    intent: CanonicalIntent,
    _ctx: RiskEvaluationContext,
): RiskRuleResult {
    if (intent.action !== "create_order" && intent.action !== "preview_order") {
        return { id: "minOrderSize", verdict: "allow" };
    }

    const base = intent.size?.base_size;
    const quote = intent.size?.quote_size;
    const basePositive = isStrictlyPositiveDecimal(base);
    const quotePositive = isStrictlyPositiveDecimal(quote);

    if (basePositive || quotePositive) {
        return { id: "minOrderSize", verdict: "allow" };
    }

    if (base === undefined && quote === undefined) {
        return {
            id: "minOrderSize",
            verdict: "block",
            explanation: "Order size missing: both base_size and quote_size are absent",
            metadata: { base_size: base, quote_size: quote },
        };
    }

    return {
        id: "minOrderSize",
        verdict: "block",
        explanation:
            "Order size must be strictly positive (base_size and/or quote_size > 0)",
        metadata: { base_size: base, quote_size: quote },
    };
}

function isStrictlyPositiveDecimal(value: string | undefined): boolean {
    if (typeof value !== "string") return false;
    const trimmed = value.trim();
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return false;
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0;
}
