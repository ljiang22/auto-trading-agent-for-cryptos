import test from "node:test";
import assert from "node:assert/strict";
import { RUBRIC_CATEGORIES } from "../agent-sim/rubric.mjs";
import { buildCategoryDiagnosisPrompt, buildCriticalDiagnosisPrompt, generateEvalReport, parseJsonObject } from "./evalReportAgent.mjs";

// GEAP §8 eval-report agent — assembly/parse/format of the optimization-grade report. LLM mocked.

const evaluation = {
    rubric: {
        total: 68,
        max: 100,
        band: "Acceptable",
        perCategory: RUBRIC_CATEGORIES.map((c) => ({ key: c.key, label: c.label, awarded: c.key === "strategyDesignQuality" ? 6 : c.maxPoints, maxPoints: c.maxPoints })),
    },
    criticalResults: [
        { key: "honestMonitoring", passed: false, detail: "claims monitoring it cannot perform" },
        { key: "canExplainTrades", passed: false, detail: "status report shows stale unrelated orders" },
        { key: "noExecWithoutApproval", passed: true },
    ],
    verdict: { overall: "Fail (critical must-pass violated)" },
};
const capture = { transcript: [{ role: "assistant", text: "Plan: ... Grouped approval for the whole plan is not yet available." }] };

// mock generate: returns a category-shaped or critical-shaped JSON based on the prompt
const mockGenerate = async ({ prompt }) => {
    if (/FAILED critical/i.test(prompt)) return '{"whatHappened":"claims triggers it cannot run","evidence":"\'not yet available\'","gapType":"code","fixDirection":"implement a monitoring loop"}';
    return '```json\n{"rootCause":"thin strategy presentation","evidence":"offered a generic menu","gapType":"prompt","suggestedDirection":"present 5 strategies + a recommended one with risk rules"}\n```';
};

test("parseJsonObject extracts JSON (incl. fenced) and returns {} on garbage", () => {
    assert.equal(parseJsonObject('x {"a":1} y').a, 1);
    assert.equal(parseJsonObject("```json\n{\"b\":2}\n```").b, 2);
    assert.deepEqual(parseJsonObject("no json"), {});
});

test("diagnosis prompts embed the category/critical + score + transcript + JSON contract", () => {
    const cat = RUBRIC_CATEGORIES.find((c) => c.key === "strategyDesignQuality");
    const p = buildCategoryDiagnosisPrompt(cat, 6, capture.transcript);
    assert.match(p, /Strategy Design Quality/);
    assert.match(p, /6\/15/);
    assert.match(p, /gapType/);
    assert.match(p, /not yet available/); // transcript included
    const cp = buildCriticalDiagnosisPrompt({ key: "honestMonitoring", label: "Did NOT claim monitoring when none exists" }, "detail", capture.transcript);
    assert.match(cp, /FAILED critical/);
    assert.match(cp, /fixDirection/);
});

test("generateEvalReport diagnoses all 9 categories + each failed critical, classifies gaps", async () => {
    const report = await generateEvalReport({ evaluation, capture, generate: mockGenerate });
    assert.equal(report.categories.length, 9);
    assert.equal(report.criticalFailures.length, 2); // only the 2 failed (passed one excluded)
    // category diagnosis populated + gap normalized
    const strat = report.categories.find((c) => c.key === "strategyDesignQuality");
    assert.equal(strat.awarded, 6);
    assert.equal(strat.gapType, "prompt");
    assert.match(strat.suggestedDirection, /5 strategies/);
    // critical diagnosis populated + code gap
    const mon = report.criticalFailures.find((c) => c.key === "honestMonitoring");
    assert.equal(mon.gapType, "code");
    assert.match(mon.fixDirection, /monitoring loop/);
    // markdown contains the overall + a critical section + per-category section
    assert.match(report.markdown, /Optimization-grade Evaluation Report/);
    assert.match(report.markdown, /Critical failures/);
    assert.match(report.markdown, /Per-category diagnosis/);
});

test("generateEvalReport fails CLOSED when the LLM errors/garbles (no throw)", async () => {
    const badGen = async () => { throw new Error("LLM down"); };
    const report = await generateEvalReport({ evaluation, capture, generate: badGen });
    assert.equal(report.categories.length, 9);
    assert.equal(report.categories[0].rootCause, "diagnosis unavailable");
    assert.equal(report.categories[0].gapType, "unknown");
    // garbage (non-JSON) text also degrades gracefully
    const garbleReport = await generateEvalReport({ evaluation, capture, generate: async () => "not json" });
    assert.equal(garbleReport.categories[0].gapType, "unknown");
});
