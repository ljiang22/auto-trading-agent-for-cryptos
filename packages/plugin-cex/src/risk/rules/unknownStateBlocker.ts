import type { CanonicalIntent } from "../../intent/canonicalIntent";
import type { RiskEvaluationContext, RiskRuleResult } from "../types";

const WRITE_ACTIONS = new Set<CanonicalIntent["action"]>([
    "create_order",
    "cancel_order",
    "amend_order",
    "preview_order",
]);

/**
 * Refuse any new write while the user has at least one order in
 * `unknown` state on the same `(venue, symbol)`. The dispatching handler
 * supplies `ctx.unknown_state_orders_on_pair` after consulting the
 * pending_orders_ledger; that decoupling keeps the rule pure.
 *
 * See plan §6.0.3.
 */
export function unknownStateBlocker(
    intent: CanonicalIntent,
    ctx: RiskEvaluationContext,
): RiskRuleResult {
    if (!WRITE_ACTIONS.has(intent.action)) {
        return { id: "unknownStateBlocker", verdict: "allow" };
    }
    const n = ctx.unknown_state_orders_on_pair ?? 0;
    if (n <= 0) {
        return { id: "unknownStateBlocker", verdict: "allow" };
    }
    return {
        id: "unknownStateBlocker",
        verdict: "block",
        explanation:
            "A previous submit on this venue+symbol is in an unknown state — refusing new writes until reconciliation resolves it.",
        metadata: { unknown_state_orders_on_pair: n },
    };
}
