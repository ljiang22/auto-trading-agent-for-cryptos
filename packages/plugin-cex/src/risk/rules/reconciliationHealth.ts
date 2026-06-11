import type { CanonicalIntent } from "../../intent/canonicalIntent";
import type { RiskEvaluationContext, RiskRuleResult } from "../types";

/**
 * Reserved for Phase 2: if any of this user's open orders have been in
 * `submitted` state for > 60 s without a WS ack, the reconciliation
 * pipeline is degraded and we refuse to submit new write intents.
 *
 * Until Phase 2 wires the ledger, `stale_reconciliation_count` will be
 * undefined and the rule is a no-op.
 */
export function reconciliationHealth(
    intent: CanonicalIntent,
    ctx: RiskEvaluationContext,
): RiskRuleResult {
    if (intent.action !== "create_order" && intent.action !== "amend_order") {
        return { id: "reconciliationHealth", verdict: "allow" };
    }
    const stale = ctx.stale_reconciliation_count;
    if (stale === undefined || stale === 0) {
        return { id: "reconciliationHealth", verdict: "allow" };
    }
    // The explanation is fed to buildUserError via the risk_block code's body
    // template; the catalog adds the localized title + next-step action.
    // lint-error-contracts-allow: this is templated input to buildUserError, not a
    // raw user-facing string.
    return {
        id: "reconciliationHealth",
        verdict: "block",
        explanation:
            "Order-state reconciliation is lagging — refusing new writes until streams catch up.",
        metadata: { stale_reconciliation_count: stale },
    };
}
