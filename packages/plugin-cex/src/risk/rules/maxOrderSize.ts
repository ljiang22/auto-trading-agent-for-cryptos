import type { CanonicalIntent } from "../../intent/canonicalIntent";
import type { RiskEvaluationContext, RiskRuleResult } from "../types";

/**
 * Blocks orders whose estimated notional exceeds the user's max-order
 * notional. Read-only actions skip the rule.
 */
export function maxOrderSize(
    intent: CanonicalIntent,
    ctx: RiskEvaluationContext,
): RiskRuleResult {
    if (intent.action !== "create_order" && intent.action !== "preview_order") {
        return { id: "maxOrderSize", verdict: "allow" };
    }
    const max = ctx.preferences.max_order_notional_usd;
    const est = ctx.estimated_notional_usd;
    if (est === undefined || est <= 0) {
        return {
            id: "maxOrderSize",
            verdict: "allow",
            explanation: "estimated notional unavailable; rule skipped",
        };
    }
    if (est > max) {
        return {
            id: "maxOrderSize",
            verdict: "block",
            explanation: `Order notional ${est.toFixed(2)} USD exceeds max ${max.toFixed(2)} USD`,
            metadata: { estimated_notional_usd: est, max_order_notional_usd: max },
        };
    }
    return { id: "maxOrderSize", verdict: "allow" };
}
