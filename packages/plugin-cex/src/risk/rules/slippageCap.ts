import type { CanonicalIntent } from "../../intent/canonicalIntent";
import type { RiskEvaluationContext, RiskRuleResult } from "../types";

export function slippageCap(
    intent: CanonicalIntent,
    ctx: RiskEvaluationContext,
): RiskRuleResult {
    if (intent.action !== "create_order") {
        return { id: "slippageCap", verdict: "allow" };
    }
    const userCap = intent.execution_constraints?.slippage_bps_max;
    const profileCap = ctx.preferences.slippage_bps_max;
    const cap = userCap !== undefined ? Math.min(userCap, profileCap) : profileCap;
    const est = ctx.estimated_slippage_bps;
    if (est === undefined || est < 0) {
        return { id: "slippageCap", verdict: "allow" };
    }
    if (est > cap) {
        return {
            id: "slippageCap",
            verdict: "block",
            explanation: `Estimated slippage ${est} bps exceeds cap ${cap} bps`,
            metadata: { estimated_slippage_bps: est, slippage_bps_max: cap },
        };
    }
    return { id: "slippageCap", verdict: "allow" };
}
