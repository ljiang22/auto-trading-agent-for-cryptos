import type { CanonicalIntent } from "../intent/canonicalIntent";
import { assetAllowlist } from "./rules/assetAllowlist";
import { cooldown } from "./rules/cooldown";
import { dailyLossLimit } from "./rules/dailyLossLimit";
import { exposureCap } from "./rules/exposureCap";
import { killSwitch } from "./rules/killSwitch";
import { leverageCap } from "./rules/leverageCap";
import { liveTradingGlobalKill } from "./rules/liveTradingGlobalKill";
import { marketDataFreshness } from "./rules/marketDataFreshness";
import { maxOrderSize } from "./rules/maxOrderSize";
import { minOrderSize } from "./rules/minOrderSize";
import { priceDeviation } from "./rules/priceDeviation";
import { reconciliationHealth } from "./rules/reconciliationHealth";
import { slippageCap } from "./rules/slippageCap";
import { unknownStateBlocker } from "./rules/unknownStateBlocker";
import type {
    RiskDecision,
    RiskEvaluationContext,
    RiskRuleId,
    RiskRuleResult,
    RiskVerdict,
} from "./types";

type RuleFn = (intent: CanonicalIntent, ctx: RiskEvaluationContext) => RiskRuleResult;

/**
 * Order matters: killSwitch first so the highest-priority block fires
 * before anything cheaper can short-circuit later. The merge policy
 * itself doesn't depend on order, but stable rule_results ordering
 * makes the audit log readable.
 */
const RULES: RuleFn[] = [
    killSwitch,
    liveTradingGlobalKill,
    unknownStateBlocker,
    assetAllowlist,
    leverageCap,
    // Fix 5 — minOrderSize sits BEFORE maxOrderSize so a missing-size
    // case fails fast with a clearer message ("size missing") instead
    // of bouncing off maxOrderSize's "estimated notional unavailable"
    // skip path.
    minOrderSize,
    maxOrderSize,
    exposureCap,
    dailyLossLimit,
    slippageCap,
    priceDeviation,
    cooldown,
    marketDataFreshness,
    reconciliationHealth,
];

/**
 * Stable map of rule id → function. Used by the Fix 11 quote-freshness
 * re-check to run a filtered subset (`priceDeviation` + `slippageCap`)
 * without re-deriving the full `RULES` array order. The id keys must
 * stay in sync with the `RiskRuleId` union; TS narrows missing entries.
 */
const RULES_BY_ID: Readonly<Record<RiskRuleId, RuleFn>> = {
    killSwitch,
    liveTradingGlobalKill,
    unknownStateBlocker,
    assetAllowlist,
    leverageCap,
    minOrderSize,
    maxOrderSize,
    exposureCap,
    dailyLossLimit,
    slippageCap,
    priceDeviation,
    cooldown,
    marketDataFreshness,
    reconciliationHealth,
};

const VERDICT_RANK: Record<RiskVerdict, number> = {
    allow: 0,
    downgrade_read_only: 1,
    block: 2,
};

/**
 * Deterministic risk engine. Pure function — no I/O, no clock besides
 * `ctx.now_ms`. Every write intent must pass through here.
 *
 * Merge policy:
 *  - Any block → final = block
 *  - Any downgrade_read_only without block → final = downgrade_read_only
 *  - Otherwise → final = allow
 * Explanations from non-allow results are concatenated, deduped.
 *
 * `rulesToRun` — Fix 11. When provided, only the listed rule ids run
 * and the rest are skipped. Used by the Confirm-time quote-freshness
 * re-check to cheaply re-evaluate `priceDeviation` + `slippageCap`
 * against a fresh quote. Unknown ids are silently dropped (defensive;
 * a future rule rename shouldn't crash the engine).
 */
export function evaluate(
    intent: CanonicalIntent,
    ctx: RiskEvaluationContext,
    rulesToRun?: string[],
): RiskDecision {
    const activeRules: RuleFn[] =
        Array.isArray(rulesToRun) && rulesToRun.length > 0
            ? rulesToRun
                  .map((id) => RULES_BY_ID[id as RiskRuleId])
                  .filter((fn): fn is RuleFn => typeof fn === "function")
            : RULES;
    const rule_results: RiskRuleResult[] = activeRules.map((r) => r(intent, ctx));
    let verdict: RiskVerdict = "allow";
    for (const r of rule_results) {
        if (VERDICT_RANK[r.verdict] > VERDICT_RANK[verdict]) {
            verdict = r.verdict;
        }
    }
    const rules_fired: RiskRuleId[] = rule_results
        .filter((r) => r.verdict !== "allow")
        .map((r) => r.id);
    const seen = new Set<string>();
    const explanations: string[] = [];
    for (const r of rule_results) {
        if (r.verdict === "allow") continue;
        if (!r.explanation) continue;
        if (seen.has(r.explanation)) continue;
        seen.add(r.explanation);
        explanations.push(r.explanation);
    }
    return { verdict, rules_fired, explanations, rule_results };
}
