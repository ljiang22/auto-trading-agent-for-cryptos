import type { CanonicalIntent } from "../../intent/canonicalIntent";
import type { RiskEvaluationContext, RiskRuleResult } from "../types";

const WRITE_ACTIONS = new Set([
    "create_order",
    "cancel_order",
    "amend_order",
    "preview_order",
]);

/**
 * When the user toggles `kill_switch_active`, write paths are blocked
 * and read paths fall through. Returned as the highest-priority rule
 * so a kill switch can never be unlocked by a lower-priority allow.
 */
export function killSwitch(
    intent: CanonicalIntent,
    ctx: RiskEvaluationContext,
): RiskRuleResult {
    if (!ctx.preferences.kill_switch_active) {
        return { id: "killSwitch", verdict: "allow" };
    }
    if (WRITE_ACTIONS.has(intent.action)) {
        return {
            id: "killSwitch",
            verdict: "block",
            explanation: "Trading is currently disabled — kill switch active",
            metadata: { kill_switch_active: true },
        };
    }
    return { id: "killSwitch", verdict: "allow" };
}
