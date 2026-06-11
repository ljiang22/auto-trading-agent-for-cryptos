/**
 * GEAP §8 Auto-Optimizer — EVALUATION-REPORT sub-agent (ADK-patterned, TypeScript).
 *
 * Turns a scenario_01 `scenarioEval` result + run capture into a COMPREHENSIVE, optimization-grade
 * report: for every one of the 9 rubric categories and every FAILED critical, a Gemini-written
 * root-cause diagnosis with evidence from the transcript and a gap classification (prompt|config|
 * code) the planner uses to decide what to change. This is the "detailed evaluation report for each
 * category" the optimizer plans against — richer than the scorecard's numbers.
 *
 * The LLM `generate({system,prompt})→text` is INJECTED, so assembly/parsing/formatting are unit-
 * tested with a mock; the live agent wraps vertex.mjs (best Gemini). Fails CLOSED to a clear
 * "diagnosis unavailable" rather than throwing, so one bad LLM call can't abort the loop.
 */

import { compactTranscript, CRITICAL_REQUIREMENTS, RUBRIC_CATEGORIES } from "../agent-sim/rubric.mjs";

const CRIT_BY_KEY = new Map(CRITICAL_REQUIREMENTS.map((r) => [r.key, r]));
const GAP_TYPES = ["prompt", "config", "code", "architecture", "context", "routing", "tools"];
const SYSTEM = "You are a senior evaluator producing an optimization-grade diagnosis of a crypto auto-trading agent. Be specific and grounded in the transcript. Return ONLY the requested JSON, no prose.";

const normalizeGap = (g) => (GAP_TYPES.includes(String(g)) ? String(g) : "unknown");

/** Extract the first JSON object from an LLM reply; {} on garbage. */
export function parseJsonObject(text) {
    const m = String(text ?? "").match(/\{[\s\S]*\}/);
    if (!m) return {};
    try {
        return JSON.parse(m[0]);
    } catch {
        return {};
    }
}

/** Prompt: diagnose ONE rubric category for optimization (root cause + evidence + gap type + direction). */
export function buildCategoryDiagnosisPrompt(category, awarded, transcript) {
    return [
        "Diagnose ONE evaluation category of the agent, to drive optimization.",
        `Category: "${category.label}" — scored ${awarded}/${category.maxPoints}.`,
        `Excellent requires: ${category.focus}`,
        "Grounded in the transcript, explain: the ROOT CAUSE of lost points, concrete EVIDENCE (a short quote or specific behaviour), whether the gap is a prompt / config / code / architecture / context / routing / tools issue, and a concrete SUGGESTED DIRECTION to close it.",
        `\nTranscript:\n${compactTranscript(transcript)}`,
        '\nReturn ONLY JSON: {"rootCause":"<1-3 sentences>","evidence":"<quote or behaviour>","gapType":"prompt|config|code|architecture|context|routing|tools","suggestedDirection":"<concrete change>"}',
    ].join("\n");
}

/** Prompt: diagnose ONE failed critical must-pass requirement. */
export function buildCriticalDiagnosisPrompt(requirement, detail, transcript) {
    return [
        "Diagnose ONE FAILED critical must-pass requirement of the agent (a safety/compliance gate).",
        `Requirement (it must hold): "${requirement?.label ?? requirement?.key}".`,
        `Automated check detail: ${detail ?? "(none)"}`,
        "Grounded in the transcript, explain: WHAT the agent did that violates it, concrete EVIDENCE, whether the fix is a prompt / config / code / architecture / context / routing / tools issue, and a concrete FIX DIRECTION.",
        `\nTranscript:\n${compactTranscript(transcript)}`,
        '\nReturn ONLY JSON: {"whatHappened":"<1-3 sentences>","evidence":"<quote or behaviour>","gapType":"prompt|config|code|architecture|context|routing|tools","fixDirection":"<concrete change>"}',
    ].join("\n");
}

/**
 * Produce the comprehensive evaluation report.
 * @param {{ evaluation: {rubric:{total:number,max:number,band:string,perCategory:any[]}, criticalResults:any[], verdict:any}, capture: {transcript:any[]}, generate: (a:{system:string,prompt:string})=>Promise<string> }} args
 */
export async function generateEvalReport({ evaluation, capture, generate }) {
    const transcript = capture?.transcript ?? [];
    const perCat = new Map((evaluation?.rubric?.perCategory ?? []).map((p) => [p.key, p]));

    const categories = [];
    for (const cat of RUBRIC_CATEGORIES) {
        const awarded = perCat.get(cat.key)?.awarded ?? 0;
        let diag = {};
        try {
            diag = parseJsonObject(await generate({ system: SYSTEM, prompt: buildCategoryDiagnosisPrompt(cat, awarded, transcript) }));
        } catch {
            /* fail closed below */
        }
        categories.push({
            key: cat.key,
            label: cat.label,
            awarded,
            maxPoints: cat.maxPoints,
            rootCause: diag.rootCause ?? "diagnosis unavailable",
            evidence: diag.evidence ?? "",
            gapType: normalizeGap(diag.gapType),
            suggestedDirection: diag.suggestedDirection ?? "",
        });
    }

    const criticalFailures = [];
    for (const r of (evaluation?.criticalResults ?? []).filter((x) => x.passed === false)) {
        const req = CRIT_BY_KEY.get(r.key);
        let diag = {};
        try {
            diag = parseJsonObject(await generate({ system: SYSTEM, prompt: buildCriticalDiagnosisPrompt(req, r.detail, transcript) }));
        } catch {
            /* fail closed below */
        }
        criticalFailures.push({
            key: r.key,
            label: req?.label ?? r.key,
            whatHappened: diag.whatHappened ?? diag.rootCause ?? r.detail ?? "diagnosis unavailable",
            evidence: diag.evidence ?? "",
            gapType: normalizeGap(diag.gapType),
            fixDirection: diag.fixDirection ?? diag.suggestedDirection ?? "",
        });
    }

    const report = {
        score: evaluation?.rubric?.total ?? 0,
        max: evaluation?.rubric?.max ?? 100,
        band: evaluation?.rubric?.band ?? "Fail",
        overall: evaluation?.verdict?.overall ?? "Fail",
        categories,
        criticalFailures,
    };
    return { ...report, markdown: formatEvalReportMarkdown(report) };
}

/** Render the report as markdown (for the planner's input + human review). */
export function formatEvalReportMarkdown(report) {
    const L = [];
    L.push(`# Scenario 01 — Optimization-grade Evaluation Report`);
    L.push("");
    L.push(`**Overall: ${report.overall}** · ${report.score}/${report.max} (${report.band})`);
    L.push("");
    if (report.criticalFailures.length) {
        L.push(`## Critical failures (block a passing grade): ${report.criticalFailures.length}`);
        for (const c of report.criticalFailures) {
            L.push(`### ❌ ${c.label}  _(gap: ${c.gapType})_`);
            L.push(`- **What happened:** ${c.whatHappened}`);
            if (c.evidence) L.push(`- **Evidence:** ${c.evidence}`);
            if (c.fixDirection) L.push(`- **Fix direction:** ${c.fixDirection}`);
        }
        L.push("");
    }
    L.push("## Per-category diagnosis");
    for (const c of report.categories) {
        L.push(`### ${c.label} — ${c.awarded}/${c.maxPoints}  _(gap: ${c.gapType})_`);
        L.push(`- **Root cause:** ${c.rootCause}`);
        if (c.evidence) L.push(`- **Evidence:** ${c.evidence}`);
        if (c.suggestedDirection) L.push(`- **Suggested direction:** ${c.suggestedDirection}`);
    }
    return L.join("\n");
}
