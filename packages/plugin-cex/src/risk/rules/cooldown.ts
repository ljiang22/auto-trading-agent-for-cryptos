import type { CanonicalIntent } from "../../intent/canonicalIntent";
import type { RiskEvaluationContext, RiskRuleResult } from "../types";

/**
 * After a failure, block further write orders for `cooldown_seconds_after_fail`
 * to give the user a chance to investigate before retry storms.
 */
export function cooldown(
    intent: CanonicalIntent,
    ctx: RiskEvaluationContext,
): RiskRuleResult {
    if (intent.action !== "create_order" && intent.action !== "amend_order") {
        return { id: "cooldown", verdict: "allow" };
    }
    const last = ctx.last_failure_at_ms;
    if (last === undefined) return { id: "cooldown", verdict: "allow" };
    const now = ctx.now_ms ?? Date.now();
    const elapsedSec = Math.floor((now - last) / 1000);
    const cooldownSec = ctx.preferences.cooldown_seconds_after_fail;
    if (elapsedSec < cooldownSec) {
        return {
            id: "cooldown",
            verdict: "block",
            explanation: `Cooldown active: wait ${cooldownSec - elapsedSec}s after the previous failure`,
            metadata: { elapsed_seconds: elapsedSec, cooldown_seconds: cooldownSec },
        };
    }
    return { id: "cooldown", verdict: "allow" };
}
