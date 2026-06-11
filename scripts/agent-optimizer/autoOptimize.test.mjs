import test from "node:test";
import assert from "node:assert/strict";
import { runOptimizationLoop } from "./autoOptimize.mjs";

// GEAP §8 loop controller — orchestration logic with all effects mocked. Verifies the approval
// model, the safety/security gate halt+notify, adopt-on-improvement, and the stop conditions.

const PASS_VEC = { safetyPassRate: 1, safetyByScenario: { "critical/a": true }, classificationOk: true };
const greenBuild = { build: { ok: true }, tests: { ok: true }, lint: { ok: true } };

// Build a harness with sane defaults; override per test.
function harness(over = {}) {
    const calls = { notify: [], promote: 0, discard: 0, approvals: 0 };
    const base = {
        targetScore: 90,
        maxIters: 6,
        autoApprove: true,
        log: () => {},
        evaluateBaseline: async () => ({ score: 68, evaluation: {}, capture: {}, metricVector: { ...PASS_VEC, rubricTotal: 68 } }),
        generateReport: async () => ({ markdown: "report" }),
        generatePlan: async () => ({ steps: [{ id: "s1", target: "prompt", requiresHumanApproval: false }], summary: "x" }),
        applyAndEvaluate: async () => ({
            score: 95,
            evaluation: {},
            capture: {},
            candidateVector: { ...PASS_VEC, rubricTotal: 95 },
            changedFiles: ["characters/CryptoTrader.json"],
            diff: "+ better prompt",
            ...greenBuild,
            promote: async () => { calls.promote += 1; },
            discard: async () => { calls.discard += 1; },
        }),
        requestHumanApproval: async () => { calls.approvals += 1; return true; },
        notify: async (ctx) => { calls.notify.push(ctx.reason); },
    };
    return { opts: { ...base, ...over }, calls };
}

test("adopts a safe improvement and stops at the target score", async () => {
    const { opts, calls } = harness();
    const res = await runOptimizationLoop(opts);
    assert.equal(res.status, "success");
    assert.equal(res.score, 95);
    assert.equal(res.iterations, 1);
    assert.equal(calls.promote, 1);
    assert.equal(calls.discard, 0);
    assert.equal(calls.notify.length, 0);
});

test("a failed safety/security gate → discard + notify + halt-gate (no adoption)", async () => {
    // candidate regresses a critical → behavioral gate fails
    const { opts, calls } = harness({
        applyAndEvaluate: async () => ({
            score: 99, evaluation: {}, capture: {},
            candidateVector: { safetyPassRate: 0.5, safetyByScenario: { "critical/a": false }, classificationOk: true, rubricTotal: 99 },
            changedFiles: ["x.ts"], diff: "+ x", ...greenBuild,
            promote: async () => { calls.promote += 1; }, discard: async () => { calls.discard += 1; },
        }),
    });
    const res = await runOptimizationLoop(opts);
    assert.equal(res.status, "halted-gate");
    assert.equal(calls.promote, 0);
    assert.equal(calls.discard, 1);
    assert.ok(calls.notify.includes("safety/security gate failed"));
    assert.ok(res.escalations.some((e) => e.gate === "behavioral"));
});

test("a build failure halts at the gate even if behavior is fine", async () => {
    const { opts, calls } = harness({
        applyAndEvaluate: async () => ({
            score: 95, evaluation: {}, capture: {}, candidateVector: { ...PASS_VEC, rubricTotal: 95 },
            changedFiles: ["x.ts"], diff: "+ x", build: { ok: false, summary: "tsc" }, tests: { ok: true },
            promote: async () => {}, discard: async () => { calls.discard += 1; },
        }),
    });
    const res = await runOptimizationLoop(opts);
    assert.equal(res.status, "halted-gate");
    assert.ok(res.escalations.some((e) => e.gate === "build"));
});

test("a step requiring human approval (protected / any code) halts BEFORE execution — never auto-applied", async () => {
    let applied = false;
    const { opts, calls } = harness({
        autoApprove: true,
        generatePlan: async () => ({ steps: [{ id: "s1", target: "code", requiresHumanApproval: true }] }),
        applyAndEvaluate: async () => { applied = true; return {}; },
        requestHumanApproval: async () => { calls.approvals += 1; return true; },
    });
    const res = await runOptimizationLoop(opts);
    assert.equal(res.status, "halted-awaiting-implement");
    assert.equal(applied, false); // protected/code is NEVER applied or executed by the loop, even under --auto-approve
    assert.equal(calls.approvals, 0); // not even requested in-loop — it's a human-only, out-of-loop change
    assert.ok(calls.notify.some((r) => /human\/Cursor implementation/i.test(r)));
    assert.equal(calls.promote, 0);
    assert.ok(res.deferredSteps.some((d) => d.id === "s1")); // surfaced for out-of-loop review
});

test("a MIXED plan auto-applies the safe prompt step and DEFERS the code step (no all-or-nothing halt)", async () => {
    let appliedStepIds = null;
    const { opts, calls } = harness({
        autoApprove: true,
        generatePlan: async () => ({
            steps: [
                { id: "s1", target: "prompt", requiresHumanApproval: false },
                { id: "s2", target: "code", requiresHumanApproval: true },
            ],
        }),
        applyAndEvaluate: async (plan) => {
            appliedStepIds = plan.steps.map((s) => s.id);
            return {
                score: 95, evaluation: {}, capture: {}, candidateVector: { ...PASS_VEC, rubricTotal: 95 },
                changedFiles: ["characters/CryptoTrader.json"], diff: "+ better prompt", ...greenBuild,
                promote: async () => { calls.promote += 1; }, discard: async () => { calls.discard += 1; },
            };
        },
    });
    const res = await runOptimizationLoop(opts);
    assert.deepEqual(appliedStepIds, ["s1"]); // ONLY the safe prompt step was executed
    assert.equal(calls.promote, 1); // adopted the safe improvement
    assert.equal(res.status, "success"); // 95 ≥ 90
    assert.ok(res.deferredSteps.some((d) => d.id === "s2")); // the code step surfaced for human review, not applied
});

test("a code step with NO requiresHumanApproval flag is STILL halted before execution (independent enforcement)", async () => {
    let applied = false;
    const { opts } = harness({
        autoApprove: true,
        generatePlan: async () => ({ steps: [{ id: "s1", target: "code", change: "rm safety" }] }), // planner flag omitted/mis-set
        applyAndEvaluate: async () => { applied = true; return {}; },
    });
    const res = await runOptimizationLoop(opts);
    assert.equal(res.status, "halted-awaiting-implement");
    assert.equal(applied, false); // loop independently treats any non-prompt/config target as human-only
});

test("a throwing discard() on a halt path still fires the user notification", async () => {
    const { opts, calls } = harness({
        applyAndEvaluate: async () => ({
            score: 99, evaluation: {}, capture: {},
            candidateVector: { safetyPassRate: 0.5, safetyByScenario: { "critical/a": false }, classificationOk: true, rubricTotal: 99 },
            changedFiles: ["x.ts"], diff: "+ x", ...greenBuild,
            promote: async () => {}, discard: async () => { throw new Error("discard boom"); },
        }),
    });
    const res = await runOptimizationLoop(opts);
    assert.equal(res.status, "halted-gate");
    assert.ok(calls.notify.includes("safety/security gate failed")); // notification fired despite discard throwing
});

test("target-reached uses the single-sourced metric score, not the operator-supplied score field", async () => {
    // operator claims score 100 but the metric vector says 50 → must NOT declare premature success
    const { opts } = harness({
        evaluateBaseline: async () => ({ score: 100, evaluation: {}, capture: {}, metricVector: { ...PASS_VEC, rubricTotal: 50 } }),
        generatePlan: async () => ({ steps: [] }),
    });
    const res = await runOptimizationLoop(opts);
    assert.notEqual(res.status, "success");
    assert.equal(res.score, 50);
});

test("a claimed improvement with an empty diff is rejected (consistency gate, fail-closed)", async () => {
    const { opts, calls } = harness({
        applyAndEvaluate: async () => ({
            score: 95, evaluation: {}, capture: {},
            candidateVector: { ...PASS_VEC, rubricTotal: 95 },
            changedFiles: [], diff: "", ...greenBuild, // higher score but NO evidence of a change
            promote: async () => { calls.promote += 1; }, discard: async () => { calls.discard += 1; },
        }),
    });
    const res = await runOptimizationLoop(opts);
    assert.equal(res.status, "halted-gate");
    assert.equal(calls.promote, 0);
    assert.equal(calls.discard, 1);
    assert.ok(res.escalations.some((e) => e.gate === "consistency"));
});

test("without --auto-approve, the plan needs human approval before executing", async () => {
    let applied = false;
    const { opts } = harness({ autoApprove: false, requestHumanApproval: async () => false, applyAndEvaluate: async () => { applied = true; return {}; } });
    const res = await runOptimizationLoop(opts);
    assert.equal(res.status, "halted-awaiting-approval");
    assert.equal(applied, false); // never executed without approval
});

test("safe-but-no-improvement → discard + notify + halt", async () => {
    const { opts, calls } = harness({
        applyAndEvaluate: async () => ({
            score: 68, evaluation: {}, capture: {}, candidateVector: { ...PASS_VEC, rubricTotal: 68 }, // same score
            changedFiles: ["x"], diff: "+ x", ...greenBuild,
            promote: async () => { calls.promote += 1; }, discard: async () => { calls.discard += 1; },
        }),
    });
    const res = await runOptimizationLoop(opts);
    assert.equal(res.status, "halted-no-improvement");
    assert.equal(calls.discard, 1);
    assert.equal(calls.promote, 0);
});

test("multi-iteration climb adopts each safe gain until the target is reached", async () => {
    const scores = [75, 85, 92];
    let i = 0;
    const { opts, calls } = harness({
        targetScore: 90, maxIters: 6,
        applyAndEvaluate: async () => {
            const score = scores[i++];
            return { score, evaluation: {}, capture: {}, candidateVector: { ...PASS_VEC, rubricTotal: score }, changedFiles: ["c"], diff: "+", ...greenBuild, promote: async () => { calls.promote += 1; }, discard: async () => {} };
        },
    });
    const res = await runOptimizationLoop(opts);
    assert.equal(res.status, "success");
    assert.equal(res.score, 92);
    assert.equal(calls.promote, 3); // 68→75→85→92, three adoptions
    assert.equal(res.history.length, 3);
});

test("exhausts max-iters when gains never reach the target", async () => {
    let s = 68;
    const { opts } = harness({
        targetScore: 95, maxIters: 3,
        applyAndEvaluate: async () => { s += 1; return { score: s, evaluation: {}, capture: {}, candidateVector: { ...PASS_VEC, rubricTotal: s }, changedFiles: ["c"], diff: "+", ...greenBuild, promote: async () => {}, discard: async () => {} }; },
    });
    const res = await runOptimizationLoop(opts);
    assert.equal(res.status, "exhausted-max-iters");
    assert.equal(res.iterations, 3);
});

test("halts when the planner returns no steps", async () => {
    const { opts, calls } = harness({ generatePlan: async () => ({ steps: [] }) });
    const res = await runOptimizationLoop(opts);
    assert.equal(res.status, "halted-no-plan");
    assert.ok(calls.notify.includes("planner produced no steps"));
});
