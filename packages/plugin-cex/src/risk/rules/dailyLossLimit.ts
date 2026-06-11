import type { CanonicalIntent } from "../../intent/canonicalIntent";
import type { RiskEvaluationContext, RiskRuleResult } from "../types";

export function dailyLossLimit(
    intent: CanonicalIntent,
    ctx: RiskEvaluationContext,
): RiskRuleResult {
    if (intent.action !== "create_order") {
        return { id: "dailyLossLimit", verdict: "allow" };
    }
    const limit = ctx.preferences.daily_loss_limit_usd;
    const pnl = ctx.rolling_24h_pnl_usd;
    if (pnl === undefined) {
        return { id: "dailyLossLimit", verdict: "allow" };
    }
    const loss = pnl < 0 ? -pnl : 0;
    if (loss >= limit) {
        return {
            id: "dailyLossLimit",
            verdict: "block",
            explanation: `24h realized loss ${loss.toFixed(2)} USD has reached daily limit ${limit.toFixed(2)} USD`,
            metadata: { rolling_24h_pnl_usd: pnl, daily_loss_limit_usd: limit },
        };
    }
    return { id: "dailyLossLimit", verdict: "allow" };
}
