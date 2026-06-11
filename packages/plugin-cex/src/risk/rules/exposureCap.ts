import type { CanonicalIntent } from "../../intent/canonicalIntent";
import type { RiskEvaluationContext, RiskRuleResult } from "../types";

/**
 * Caps total open exposure at 5x the max-order notional. Sized to the
 * user's risk profile via `max_order_notional_usd`.
 */
export function exposureCap(
    intent: CanonicalIntent,
    ctx: RiskEvaluationContext,
): RiskRuleResult {
    if (intent.action !== "create_order") {
        return { id: "exposureCap", verdict: "allow" };
    }
    const cap = ctx.preferences.max_order_notional_usd * 5;
    const open = ctx.open_exposure_usd ?? 0;
    const est = ctx.estimated_notional_usd ?? 0;
    const projected = open + est;
    if (projected > cap) {
        return {
            id: "exposureCap",
            verdict: "block",
            explanation: `Projected open exposure ${projected.toFixed(2)} USD exceeds cap ${cap.toFixed(2)} USD`,
            metadata: {
                open_exposure_usd: open,
                estimated_notional_usd: est,
                exposure_cap_usd: cap,
            },
        };
    }
    return { id: "exposureCap", verdict: "allow" };
}
