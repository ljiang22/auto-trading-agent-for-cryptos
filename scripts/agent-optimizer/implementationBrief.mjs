/**
 * GEAP §8 — Cursor / Claude Code implementation handoff.
 *
 * Turns an evaluation + optimization plan into a single markdown brief an external coding agent
 * can execute. After implementation the operator runs `pnpm optimize:cycle:verify` to re-test.
 */

import { formatTraceSignalsSection } from "./evalSuite.mjs";
import { formatPlanMarkdown } from "./optimizationPlannerAgent.mjs";

/**
 * @param {{
 *   baselineScore: number, targetScore: number,
 *   evaluation: { rubric?: any, criticalResults?: any[], verdict?: any },
 *   evalReportMarkdown?: string, plan: { summary?: string, steps?: any[] },
 *   iteration?: number,
 * }} ctx
 */
export function formatImplementationBrief(ctx) {
    const {
        baselineScore,
        targetScore,
        evaluation = {},
        evalReportMarkdown = "",
        plan = {},
        iteration = 1,
    } = ctx;
    const failedCriticals = (evaluation.criticalResults ?? []).filter((r) => r.passed === false);
    const L = [];

    L.push("# GEAP Agent Optimization — Implementation Brief");
    L.push("");
    L.push(`> **For Cursor / Claude Code.** Implement the plan below in the repo, then verify.`);
    L.push("");
    L.push("## Goal");
    L.push(`- **Target score:** ≥ ${targetScore}/100 on scenario_01 (variant B) + adversarial probes passing`);
    L.push(`- **Current score:** ${baselineScore}/100`);
    L.push(`- **Cycle iteration:** ${iteration}`);
    L.push(`- **Overall verdict:** ${evaluation.verdict?.overall ?? "unknown"}`);
    L.push(`- **Critical must-pass:** ${failedCriticals.length ? `${failedCriticals.length} failing` : "all passing"}`);
    L.push("");

    L.push("## Workflow (operator)");
    L.push("1. Implement every step in **Optimization Plan** below (any aspect: architecture, context, routing, tools, code, prompt).");
    L.push("2. Run `pnpm build` from repo root.");
    L.push("3. Restart the paper agent: `pnpm start` (must load your changes).");
    L.push("4. Re-test: `pnpm optimize:cycle:verify --user-email <paper-user>`");
    L.push("5. Repeat until verify reports **SUCCESS** (score ≥ target).");
    L.push("");

    L.push("## Constraints (do not weaken)");
    L.push("- CEX approval gate, risk engine, Rule-9 refusal corpus, capital/leverage limits.");
    L.push("- Protected paths in `scripts/agent-optimizer/policy.mjs` — edit only when the plan explicitly requires it and explain why.");
    L.push("- Run relevant tests after code changes (`pnpm --filter @elizaos-plugins/plugin-cex test`, agent-sim selftest).");
    L.push("");

    if (failedCriticals.length) {
        L.push("## Failing critical must-pass (fix first)");
        for (const f of failedCriticals) {
            L.push(`- **${f.key}:** ${f.detail ?? ""}`);
        }
        L.push("");
    }

    L.push("## Evaluation diagnosis (summary)");
    L.push(evalReportMarkdown.trim() || "_See optimizer_eval_report.md_");
    L.push("");

    // Trace evidence (Cloud Trace / Trace Explorer) — advisory runtime signals for the planner:
    // latency hot spots, error spans, and decision oscillation that the rubric can't see.
    // `traceSignals === undefined` means the eval ran without a collector (older callers) — omit;
    // `null` means the read was attempted and unavailable — say so honestly.
    if (evaluation.traceSignals !== undefined) {
        L.push(formatTraceSignalsSection(evaluation.traceSignals));
        L.push("");
    }

    L.push("## Optimization Plan");
    L.push("");
    L.push(formatPlanMarkdown(plan));
    L.push("");

    L.push("## Implementation checklist");
    const steps = plan.steps ?? [];
    if (!steps.length) L.push("_No steps — re-run plan generation._");
    for (const s of steps) {
        L.push(`- [ ] **${s.id}** (${s.target}) — ${s.closesGap || s.change?.slice(0, 80) || ""}`);
        if (s.files?.length) L.push(`  - Files: \`${s.files.join("`, `")}\``);
        L.push(`  - Expected: ${s.expectedImpact || "see change field"}`);
    }
    L.push("");

    L.push("## Verify command");
    L.push("```bash");
    L.push("pnpm build && pnpm start   # restart agent in another terminal");
    L.push("pnpm optimize:cycle:verify --user-email $VITE_TEST_USER_EMAIL --target-score " + targetScore);
    L.push("```");

    return L.join("\n");
}

/**
 * Decide whether the human-implement cycle reached the target.
 * @param {{ score: number, evaluation?: { verdict?: { criticalPass?: boolean } } }} baseline
 * @param {number} targetScore
 */
export function assessCycleResult(baseline, targetScore) {
    const score = baseline.score;
    const criticalPass = baseline.evaluation?.verdict?.criticalPass === true;
    const success = score >= targetScore && criticalPass;
    return {
        success,
        needsPlan: !success,
        score,
        targetScore,
        criticalPass,
        message: success
            ? `SUCCESS: score ${score}/${targetScore} with all criticals passing`
            : `CONTINUE: score ${score}/${targetScore}${criticalPass ? "" : " (critical must-pass still failing)"} — implement next plan`,
    };
}

/**
 * @param {string} outDir
 * @param {object} payload
 */
export function cycleArtifactPaths(outDir) {
    return {
        scorecard: `${outDir}/optimizer_scorecard.md`,
        evalReport: `${outDir}/optimizer_eval_report.md`,
        plan: `${outDir}/optimizer_plan.json`,
        brief: `${outDir}/optimizer_implementation_brief.md`,
        state: `${outDir}/optimizer_cycle_state.json`,
        capture: `${outDir}/optimizer_capture.json`,
    };
}
