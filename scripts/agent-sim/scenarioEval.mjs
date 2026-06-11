/**
 * GEAP scenario_01 evaluator — ties the test fixture + rubric + critical checks into one verdict
 * and the evolve metric vector. This is the bridge from "a captured agent run" to:
 *   - a 100-point scorecard + rating band (rubric.mjs),
 *   - a 14-point critical must-pass verdict (deterministic checks + LLM-judged checks),
 *   - a metric vector the evolve loop optimizes (critical→safety floor, rubric/100→task objective),
 *   - a critique digest that tells the proposer exactly which categories/criticals to improve.
 *
 * The LLM judge is INJECTED (`judge(prompt) → { points?, passed?, detail?, reasoning? }`), so the
 * aggregation/scoring/report logic is unit-tested with a mock; the live judge wraps Vertex
 * (judge.mjs pattern). Judged criticals fail CLOSED if the judge errors or returns nothing.
 */

import { evaluateDeterministicCritical } from "./criticalChecks.mjs";
import { CANONICAL_TRADE_TRAJECTORY, trajectoryScore } from "./metrics.mjs";
import {
    applyCriticalVeto,
    buildCategoryJudgePrompt,
    buildCriticalJudgePrompt,
    CRITICAL_REQUIREMENTS,
    RUBRIC_CATEGORIES,
    scoreRubric,
    toMetricVector,
} from "./rubric.mjs";

const CRIT_BY_KEY = new Map(CRITICAL_REQUIREMENTS.map((r) => [r.key, r]));
const CAT_BY_KEY = new Map(RUBRIC_CATEGORIES.map((c) => [c.key, c]));

/** Which critical requirements are deterministic (steps-checked) vs LLM-judged. */
export function splitCriticalRequirements() {
    return {
        deterministic: CRITICAL_REQUIREMENTS.filter((r) => r.deterministic).map((r) => r.key),
        judged: CRITICAL_REQUIREMENTS.filter((r) => !r.deterministic).map((r) => r.key),
    };
}

/**
 * Run the injected judge N times and aggregate. Critical checks use majority vote (fail-closed on
 * ties); rubric categories use the median awarded points. Mitigates LLM-judge variance vetoing a
 * genuine prompt improvement (e.g. validatesModifiedStrategy flipping run-to-run).
 * @param {(prompt:string)=>Promise<any>} judge
 * @param {string} prompt
 * @param {{ samples?: number, mode?: "critical"|"category", maxPoints?: number }} opts
 */
export async function judgeWithMajority(judge, prompt, { samples = 3, mode = "critical", maxPoints = 10 } = {}) {
    const n = Math.max(1, Math.floor(samples));
    const outs = [];
    for (let i = 0; i < n; i += 1) {
        try {
            outs.push(await judge(prompt));
        } catch {
            outs.push(null);
        }
    }
    if (mode === "category") {
        const pts = outs.map((o) => Number(o?.points)).filter(Number.isFinite).sort((a, b) => a - b);
        const median = pts.length ? pts[Math.floor(pts.length / 2)] : 0;
        return { points: Math.min(maxPoints, Math.max(0, median)), detail: `median of ${pts.length}/${n} samples` };
    }
    const passes = outs.filter((o) => o?.passed === true).length;
    const fails = outs.filter((o) => o?.passed === false).length;
    const passed = passes > fails && passes > n / 2;
    const detail = outs.find((o) => o?.detail)?.detail ?? outs.find((o) => o?.reasoning)?.reasoning ?? (passed ? "majority pass" : "majority fail");
    return { passed, detail: `[${passes}/${n} pass] ${detail}` };
}

/**
 * Evaluate a captured scenario run.
 * @param {{ capture: {steps:any[],transcript:any[],approvals:any[]}, judge: (prompt:string)=>Promise<any>, classificationOk?: boolean, judgeSamples?: number }} args
 * @returns {Promise<{ rubric, criticalResults, verdict, metricVector, critique, report }>}
 */
export async function evaluateScenario({ capture, judge, classificationOk = false, judgeSamples = 1, executionMode = "paper" }) {
    // 1. Deterministic critical checks (5).
    const deterministic = evaluateDeterministicCritical(capture);

    // 2. LLM-judged critical checks (9) — fail CLOSED on judge error / missing verdict.
    const judgedKeys = CRITICAL_REQUIREMENTS.filter((r) => !r.deterministic);
    const judged = [];
    for (const req of judgedKeys) {
        // A live-only requirement (e.g. handlesOrderFailures) is structurally untestable in paper —
        // the paper venue never fails — so mark it N/A rather than fail-closing. It is excluded from
        // the veto + safety floor (rubric.applyCriticalVeto / criticalPassRate) but still reported.
        if (req.liveOnly && executionMode !== "live") {
            judged.push({ key: req.key, passed: true, notApplicable: true, detail: "N/A — live-only requirement (no live order failures occur in paper mode)" });
            continue;
        }
        let passed = false;
        let detail = "judge unavailable — fail closed";
        try {
            const out = await judgeWithMajority(judge, buildCriticalJudgePrompt(req, { transcript: capture?.transcript ?? [] }), {
                samples: judgeSamples,
                mode: "critical",
            });
            passed = out?.passed === true;
            detail = String(out?.detail ?? (passed ? "passed" : "failed"));
        } catch (err) {
            detail = `judge error — fail closed: ${err?.message ?? err}`;
        }
        judged.push({ key: req.key, passed, detail });
    }
    const criticalResults = [...deterministic, ...judged];

    // 3. Per-category rubric judging (9) — missing/error ⇒ 0 for that category.
    const perCategory = {};
    for (const cat of RUBRIC_CATEGORIES) {
        try {
            const out = await judgeWithMajority(judge, buildCategoryJudgePrompt(cat, { transcript: capture?.transcript ?? [] }), {
                samples: judgeSamples,
                mode: "category",
                maxPoints: cat.maxPoints,
            });
            const pts = Number(out?.points);
            perCategory[cat.key] = Number.isFinite(pts) ? pts : 0;
        } catch {
            perCategory[cat.key] = 0;
        }
    }

    // 4. Aggregate → scorecard, veto, metric vector, critique.
    const rubric = scoreRubric(perCategory);
    const verdict = applyCriticalVeto({ rubric, criticalResults });
    const metricVector = toMetricVector({ rubric, criticalResults, classificationOk });
    const observed = (capture?.steps ?? []).map((s) => s.name);
    const { score: trajScore } = trajectoryScore(observed, CANONICAL_TRADE_TRAJECTORY);
    if (typeof trajScore === "number") metricVector.toolTrajectoryScore = trajScore;
    const critique = buildCritiqueDigest({ rubric, criticalResults });
    const report = formatScorecard({ rubric, criticalResults, verdict });

    return { rubric, criticalResults, verdict, metricVector, critique, report };
}

/** A critique digest for the proposer: failed criticals first, then sub-60% categories. */
export function buildCritiqueDigest({ rubric, criticalResults }) {
    const lines = [];
    const failed = (criticalResults ?? []).filter((r) => r.passed === false);
    if (failed.length) {
        lines.push("CRITICAL must-pass FAILURES (any one forces an overall Fail — fix these first):");
        for (const f of failed) lines.push(`  - ${CRIT_BY_KEY.get(f.key)?.label ?? f.key}: ${f.detail}`);
    }
    const low = (rubric?.perCategory ?? []).filter((p) => p.awarded < p.maxPoints * 0.6);
    if (low.length) {
        lines.push("Rubric categories scoring below 60% (raise these):");
        for (const c of low) lines.push(`  - ${c.label}: ${c.awarded}/${c.maxPoints} — needs: ${CAT_BY_KEY.get(c.key)?.focus ?? ""}`);
    }
    if (!lines.length) lines.push("No critical failures; all rubric categories ≥ 60%.");
    return lines.join("\n");
}

/** Render the spec's scorecard (per-category points + total/band + critical pass/fail + overall). */
export function formatScorecard({ rubric, criticalResults, verdict }) {
    const L = [];
    L.push(`# Scenario 01 — BTC Beginner Investment to User-Modified Auto-Trading — Scorecard`);
    L.push("");
    L.push(`**Overall: ${verdict.overall}**  ·  score ${rubric.total}/${rubric.max} (${rubric.band})`);
    L.push("");
    L.push("| Category | Points |");
    L.push("|---|---|");
    for (const c of rubric.perCategory) L.push(`| ${c.label} | ${c.awarded}/${c.maxPoints} |`);
    L.push(`| **Total** | **${rubric.total}/${rubric.max}** |`);
    L.push("");
    const failed = (criticalResults ?? []).filter((r) => r.passed === false && !r.notApplicable);
    const na = (criticalResults ?? []).filter((r) => r.notApplicable);
    const applicable = (criticalResults ?? []).length - na.length;
    L.push(`## Critical must-pass: ${applicable - failed.length}/${applicable} passed${na.length ? ` (${na.length} N/A)` : ""}`);
    if (!failed.length) L.push("- ✅ all applicable critical requirements passed");
    for (const f of failed) L.push(`- ❌ ${CRIT_BY_KEY.get(f.key)?.label ?? f.key} — ${f.detail}`);
    for (const n of na) L.push(`- ⊘ N/A ${CRIT_BY_KEY.get(n.key)?.label ?? n.key} — ${n.detail}`);
    if (failed.length) {
        L.push("");
        L.push(`> ⚠️ Critical failure ⇒ overall **Fail** regardless of the ${rubric.total}-point score.`);
    }
    return L.join("\n");
}
