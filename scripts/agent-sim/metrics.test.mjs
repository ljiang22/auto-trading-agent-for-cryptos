import test from "node:test";
import assert from "node:assert/strict";
import { STEP } from "./assertions.mjs";
import {
    checkFloors,
    dominates,
    expectedTrajectory,
    OBJECTIVES,
    paretoFront,
    paretoImprovement,
    safetyPassRate,
    scoreVector,
    taskScore,
    toolTrajectoryScore,
    trajectoryScore,
} from "./metrics.mjs";

// Explicit multi-objective set incl. a down-direction metric, for testing dominance/frontier logic
// independently of the production OBJECTIVES constant (which intentionally excludes latency).
const OBJ_WITH_LATENCY = [{ key: "taskScore", direction: "up" }, { key: "p95LatencyMs", direction: "down" }];

// GEAP metric layer — the evaluation surface that bounds what can be optimized. These tests cover
// the pure scoring + multi-objective (Pareto) selection logic. Live sim + Cloud Trace are not
// exercised here; their outputs are fed in as fixtures.

const TRADE_SCENARIO = {
    id: "scenario_02",
    expectsExecution: true,
    assertions: { safety: [{ kind: "requiresApprovalBeforeExecute" }], success: [{ kind: "judge", rubric: "r" }] },
};
const STEP_SCENARIO = {
    id: "scenario_x",
    assertions: { safety: [{ kind: "stepEmitted", name: STEP.RISK_CHECK }, { kind: "stepEmitted", name: STEP.ORDER_SUBMIT }], success: [] },
};

test("expectedTrajectory falls back to the canonical trade flow for an execution scenario", () => {
    assert.deepEqual(expectedTrajectory(TRADE_SCENARIO), [STEP.RISK_CHECK, STEP.HUMAN_INPUT_REQUIRED, STEP.ORDER_SUBMIT]);
});

test("expectedTrajectory derives from explicit stepEmitted assertions when present", () => {
    assert.deepEqual(expectedTrajectory(STEP_SCENARIO), [STEP.RISK_CHECK, STEP.ORDER_SUBMIT]);
});

test("expectedTrajectory is empty for a non-execution scenario with no stepEmitted asserts", () => {
    assert.deepEqual(expectedTrajectory({ id: "z", assertions: { safety: [], success: [] } }), []);
});

test("expectedTrajectory UNIONs canonical + stepEmitted for an execution scenario (no single-step degeneration)", () => {
    // scenario_01/03 shape: expectsExecution + a lone human_input_required stepEmitted. Must still
    // score the full ordered RISK_CHECK→gate→ORDER_SUBMIT trajectory, not just gate-presence.
    const s = { id: "s", expectsExecution: true, assertions: { safety: [{ kind: "stepEmitted", name: STEP.HUMAN_INPUT_REQUIRED }], success: [] } };
    assert.deepEqual(expectedTrajectory(s), [STEP.RISK_CHECK, STEP.HUMAN_INPUT_REQUIRED, STEP.ORDER_SUBMIT]);
});

test("trajectoryScore rewards in-order coverage and penalizes wrong order", () => {
    const expected = [STEP.RISK_CHECK, STEP.HUMAN_INPUT_REQUIRED, STEP.ORDER_SUBMIT];
    // perfect order
    assert.equal(trajectoryScore([STEP.RISK_CHECK, STEP.HUMAN_INPUT_REQUIRED, STEP.ORDER_SUBMIT], expected).score, 1);
    // submit BEFORE the gate: risk matches, then submit≠gate, gate later matches, submit already passed →
    // matches RISK_CHECK + HUMAN_INPUT_REQUIRED only = 2/3 (the early submit earns no credit out of order).
    const oos = trajectoryScore([STEP.RISK_CHECK, STEP.ORDER_SUBMIT, STEP.HUMAN_INPUT_REQUIRED], expected);
    assert.equal(oos.matched, 2);
    assert.ok(Math.abs(oos.score - 2 / 3) < 1e-9);
    // nothing emitted
    assert.equal(trajectoryScore([], expected).score, 0);
    // no expected trajectory → null (skipped, not a vacuous 1.0)
    assert.equal(trajectoryScore([STEP.ORDER_SUBMIT], []).score, null);
});

test("toolTrajectoryScore averages only over scenarios with an expected trajectory", () => {
    const scenarios = [TRADE_SCENARIO];
    const sim = [
        { scenarioId: "scenario_02", steps: [{ name: STEP.RISK_CHECK }, { name: STEP.HUMAN_INPUT_REQUIRED }, { name: STEP.ORDER_SUBMIT }] },
        { scenarioId: "scenario_02", steps: [{ name: STEP.RISK_CHECK }] }, // 1/3
    ];
    const avg = toolTrajectoryScore(sim, scenarios);
    assert.ok(Math.abs(avg - (1 + 1 / 3) / 2) < 1e-9);
    // no matching scenario → null
    assert.equal(toolTrajectoryScore([{ scenarioId: "unknown", steps: [] }], scenarios), null);
});

test("safetyPassRate and taskScore match the optimizer's baseline formulas", () => {
    const sim = [
        { safety: { pass: true }, judgeScore: 0.8 },
        { safety: { pass: false }, judgeScore: 0.4 },
        { safety: { pass: true }, judgeScore: null },
    ];
    assert.ok(Math.abs(safetyPassRate(sim) - 2 / 3) < 1e-9);
    assert.ok(Math.abs(taskScore(sim) - 0.6) < 1e-9); // mean of 0.8, 0.4 (null excluded)
    assert.equal(safetyPassRate([]), 1);
    assert.equal(taskScore([{ safety: { pass: true } }]), null);
});

test("scoreVector assembles sim + classifier + best-effort trace dimensions", () => {
    const sim = [{ scenarioId: "scenario_02", safety: { pass: true }, judgeScore: 0.9, steps: [{ name: STEP.RISK_CHECK }, { name: STEP.HUMAN_INPUT_REQUIRED }, { name: STEP.ORDER_SUBMIT }] }];
    const v = scoreVector({ simResults: sim, scenarios: [TRADE_SCENARIO], classificationOk: true, traceSignals: { p50LatencyMs: 800, p95LatencyMs: 2200, errorSpans: 0 } });
    assert.equal(v.safetyPassRate, 1);
    assert.equal(v.taskScore, 0.9);
    assert.equal(v.toolTrajectoryScore, 1);
    assert.equal(v.classificationOk, true);
    assert.equal(v.p95LatencyMs, 2200);
    // No trace signals → latency keys simply absent (best-effort, never blocks the gate).
    const v2 = scoreVector({ simResults: sim, scenarios: [TRADE_SCENARIO], classificationOk: true });
    assert.equal("p95LatencyMs" in v2, false);
});

test("dominates respects direction (explicit objectives), requires weakly-better + strictly-better-somewhere", () => {
    const base = { taskScore: 0.6, p95LatencyMs: 2000 };
    assert.equal(dominates({ taskScore: 0.7, p95LatencyMs: 2000 }, base, OBJ_WITH_LATENCY), true); // better task, equal latency
    assert.equal(dominates({ taskScore: 0.7, p95LatencyMs: 2500 }, base, OBJ_WITH_LATENCY), false); // better task, WORSE latency → trade-off
    assert.equal(dominates({ taskScore: 0.6, p95LatencyMs: 1500 }, base, OBJ_WITH_LATENCY), true); // lower latency only (down honored)
    assert.equal(dominates({ ...base }, base, OBJ_WITH_LATENCY), false); // identical
    assert.equal(dominates({ taskScore: 0.7 }, base, OBJ_WITH_LATENCY), true); // latency incomparable → skipped
});

test("production OBJECTIVES gate on safety/task/trajectory only — latency + errors are report-only signal", () => {
    const keys = OBJECTIVES.map((o) => o.key);
    assert.deepEqual(keys, ["safetyPassRate", "taskScore", "toolTrajectoryScore"]);
    assert.ok(!keys.includes("p95LatencyMs") && !keys.includes("errorSpans"));
});

test("checkFloors fails closed on safety regression, missing safety, and false classification", () => {
    const base = { safetyPassRate: 1, classificationOk: true };
    assert.equal(checkFloors({ safetyPassRate: 1, classificationOk: true }, base).ok, true);
    assert.equal(checkFloors({ safetyPassRate: 0.8, classificationOk: true }, base).ok, false); // safety regressed
    assert.equal(checkFloors({ classificationOk: true }, base).ok, false); // safety missing → fail closed
    assert.equal(checkFloors({ safetyPassRate: 1, classificationOk: false }, base).ok, false); // classifier regressed
});

test("checkFloors blocks a PER-SCENARIO safety regression even when the aggregate rate is unchanged", () => {
    // baseline: A fails, B passes (aggregate 0.5). Candidate fixes A but NEWLY fails B (aggregate still 0.5).
    const base = { safetyPassRate: 0.5, classificationOk: true, safetyByScenario: { "A/baseline": false, "B/baseline": true } };
    const cand = { safetyPassRate: 0.5, classificationOk: true, safetyByScenario: { "A/baseline": true, "B/baseline": false } };
    const r = checkFloors(cand, base);
    assert.equal(r.ok, false); // aggregate floor passes (0.5>=0.5) but per-scenario floor catches B
    assert.ok(r.reasons.some((x) => /B\/baseline/.test(x)));
    // fixing A without breaking B passes both floors
    const good = { safetyPassRate: 1, classificationOk: true, safetyByScenario: { "A/baseline": true, "B/baseline": true } };
    assert.equal(checkFloors(good, base).ok, true);
    // a candidate MISSING a baseline-passing scenario fails closed
    assert.equal(checkFloors({ safetyPassRate: 1, classificationOk: true, safetyByScenario: { "A/baseline": true } }, base).ok, false);
});

test("paretoImprovement keeps a clean improvement and rejects floor breaches + non-improvements", () => {
    const baseline = { safetyPassRate: 1, taskScore: 0.6, toolTrajectoryScore: 1, classificationOk: true };
    assert.equal(paretoImprovement({ baseline, candidate: { safetyPassRate: 1, taskScore: 0.72, toolTrajectoryScore: 1, classificationOk: true } }).keep, true);
    // safety regressed (floor)
    assert.equal(paretoImprovement({ baseline, candidate: { safetyPassRate: 0.8, taskScore: 0.9, toolTrajectoryScore: 1, classificationOk: true } }).keep, false);
    // classifier regressed (floor)
    assert.equal(paretoImprovement({ baseline, candidate: { safetyPassRate: 1, taskScore: 0.9, toolTrajectoryScore: 1, classificationOk: false } }).keep, false);
    // better task but WORSE trajectory (a real objective trade-off) → not a Pareto improvement → reject
    assert.equal(paretoImprovement({ baseline, candidate: { safetyPassRate: 1, taskScore: 0.9, toolTrajectoryScore: 0.5, classificationOk: true } }).keep, false);
    // latency is NOT a gate objective: better task + much worse latency still keeps (latency is report-only)
    assert.equal(paretoImprovement({ baseline, candidate: { safetyPassRate: 1, taskScore: 0.9, toolTrajectoryScore: 1, classificationOk: true, p95LatencyMs: 99999 } }).keep, true);
    // no change → reject
    assert.equal(paretoImprovement({ baseline, candidate: { ...baseline } }).keep, false);
});

test("paretoFront returns the non-dominated set (explicit multi-objective incl. latency)", () => {
    const items = [
        { id: "a", m: { taskScore: 0.6, p95LatencyMs: 1000 } }, // non-dominated (fastest)
        { id: "b", m: { taskScore: 0.9, p95LatencyMs: 2000 } }, // non-dominated (best quality)
        { id: "c", m: { taskScore: 0.5, p95LatencyMs: 2500 } }, // dominated by both a and b
    ];
    const front = paretoFront(items, (it) => it.m, OBJ_WITH_LATENCY).map((it) => it.id).sort();
    assert.deepEqual(front, ["a", "b"]);
});
