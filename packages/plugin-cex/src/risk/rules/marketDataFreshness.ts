import type { CanonicalIntent } from "../../intent/canonicalIntent";
import type { RiskEvaluationContext, RiskRuleResult } from "../types";

const DOWNGRADE_FLOOR_MS = 5_000;

/**
 * Stale market data → no write orders. Between 5 s and the
 * profile cap, downgrade to read-only (advisory). Past the cap, block
 * outright.
 *
 * For write-classified intents only.
 */
export function marketDataFreshness(
    intent: CanonicalIntent,
    ctx: RiskEvaluationContext,
): RiskRuleResult {
    if (intent.action !== "create_order" && intent.action !== "amend_order") {
        return { id: "marketDataFreshness", verdict: "allow" };
    }
    const age = ctx.market_data_age_ms;
    if (age === undefined) {
        return { id: "marketDataFreshness", verdict: "allow" };
    }
    const cap = ctx.preferences.market_data_freshness_max_ms;
    if (age > cap) {
        return {
            id: "marketDataFreshness",
            verdict: "block",
            explanation: `Market data is ${Math.round(age / 1000)}s stale (cap ${Math.round(
                cap / 1000,
            )}s) — refusing to submit`,
            metadata: { market_data_age_ms: age, cap_ms: cap },
        };
    }
    if (age > DOWNGRADE_FLOOR_MS) {
        return {
            id: "marketDataFreshness",
            verdict: "downgrade_read_only",
            explanation: `Market data is ${Math.round(age / 1000)}s old — returning a read-only response instead of submitting`,
            metadata: { market_data_age_ms: age, cap_ms: cap },
        };
    }
    return { id: "marketDataFreshness", verdict: "allow" };
}
