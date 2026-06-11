/**
 * §8.12 — operator-controlled global kill switch.
 *
 * When `LIVE_TRADING_GLOBAL_KILL` is set in the environment, every
 * live-mode write is refused regardless of per-user preferences.
 * Paper + shadow modes pass through so dev / CI keep running. Read
 * actions are unaffected.
 */

import type { CanonicalIntent } from "../../intent/canonicalIntent";
import type { RiskEvaluationContext, RiskRuleResult } from "../types";

const WRITE_ACTIONS = new Set([
    "create_order",
    "cancel_order",
    "amend_order",
    "preview_order",
]);

const TRUTHY = new Set(["1", "true", "yes", "on", "enabled"]);

function flagActive(): boolean {
    const raw = process.env.LIVE_TRADING_GLOBAL_KILL;
    if (raw === undefined) return false;
    return TRUTHY.has(raw.trim().toLowerCase());
}

export function liveTradingGlobalKill(
    intent: CanonicalIntent,
    _ctx: RiskEvaluationContext,
): RiskRuleResult {
    if (!flagActive()) {
        return { id: "liveTradingGlobalKill", verdict: "allow" };
    }
    if (intent.mode !== "live") {
        return { id: "liveTradingGlobalKill", verdict: "allow" };
    }
    if (!WRITE_ACTIONS.has(intent.action)) {
        return { id: "liveTradingGlobalKill", verdict: "allow" };
    }
    return {
        id: "liveTradingGlobalKill",
        verdict: "block",
        explanation:
            "Global live-trading kill switch is active — paper / shadow remain available",
        metadata: { source: "operator_global_kill" },
    };
}
