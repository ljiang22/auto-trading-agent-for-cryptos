import test from "node:test";
import assert from "node:assert/strict";
import { assessCycleResult, formatImplementationBrief } from "./implementationBrief.mjs";
import { finalizeStep, HUMAN_IMPLEMENT_TARGETS } from "./optimizationPlannerAgent.mjs";

test("HUMAN_IMPLEMENT_TARGETS includes architecture/context/routing/tools/code", () => {
    for (const t of ["architecture", "context", "routing", "tools", "code"]) assert.ok(HUMAN_IMPLEMENT_TARGETS.has(t));
});

test("finalizeStep: architecture/context/routing/tools always require human implementation", () => {
    for (const target of ["architecture", "context", "routing", "tools"]) {
        const s = finalizeStep({ target, change: "fix routing", risk: "low" }, 0);
        assert.equal(s.target, target);
        assert.equal(s.requiresHumanApproval, true);
    }
});

test("assessCycleResult: success requires score AND criticalPass", () => {
    assert.equal(assessCycleResult({ score: 92, evaluation: { verdict: { criticalPass: true } } }, 90).success, true);
    assert.equal(assessCycleResult({ score: 92, evaluation: { verdict: { criticalPass: false } } }, 90).success, false);
    assert.equal(assessCycleResult({ score: 80, evaluation: { verdict: { criticalPass: true } } }, 90).needsPlan, true);
});

test("formatImplementationBrief includes plan steps and verify command", () => {
    const md = formatImplementationBrief({
        baselineScore: 55,
        targetScore: 90,
        evaluation: { verdict: { overall: "Fail" }, criticalResults: [{ key: "x", passed: false, detail: "bad" }] },
        evalReportMarkdown: "## diagnosis",
        plan: {
            summary: "fix routing",
            steps: [{ id: "s1", target: "routing", files: ["runtime.ts"], change: "route CEX", closesGap: "gate", expectedImpact: "+10", risk: "low", requiresHumanApproval: true }],
        },
    });
    assert.match(md, /optimize:cycle:verify/);
    assert.match(md, /routing/);
    assert.match(md, /\[ \] \*\*s1\*\*/);
});

test("formatImplementationBrief renders the Cloud Trace section (data + honest unavailable)", () => {
    const withData = formatImplementationBrief({
        baselineScore: 80,
        targetScore: 90,
        evaluation: {
            verdict: { overall: "Good" },
            criticalResults: [],
            traceSignals: { traceCount: 9, p50LatencyMs: 700, p95LatencyMs: 3100, maxLatencyMs: 5000, errorSpans: 1, oscillations: 0, perNode: { "node:riskCheck": { p50: 90, p95: 2900, count: 4 } } },
        },
        plan: { summary: "s", steps: [] },
    });
    assert.match(withData, /## Trace signals \(Cloud Trace\)/);
    assert.match(withData, /node:riskCheck/);
    const unavailable = formatImplementationBrief({
        baselineScore: 80,
        targetScore: 90,
        evaluation: { verdict: { overall: "Good" }, criticalResults: [], traceSignals: null },
        plan: { summary: "s", steps: [] },
    });
    assert.match(unavailable, /Trace data unavailable/i);
    // legacy callers without the field → no section at all
    const legacy = formatImplementationBrief({ baselineScore: 80, targetScore: 90, evaluation: { verdict: {}, criticalResults: [] }, plan: { summary: "s", steps: [] } });
    assert.ok(!legacy.includes("Trace signals"));
});
