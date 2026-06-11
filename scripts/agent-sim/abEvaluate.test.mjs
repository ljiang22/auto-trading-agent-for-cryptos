import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STEP } from "./assertions.mjs";
import { applyCandidateToCharacter, expectedRunCount, FAIL_CLOSED, makeEvaluateCandidate, waitForAgentReady } from "./abEvaluate.mjs";

// GEAP A/B evaluator — the orchestration logic that boots a scratch agent, re-runs the sim, and
// distills a metric vector. Every I/O seam is injected here so the control flow (readiness,
// fail-closed on boot/sim failure, always-teardown, metric assembly) is exercised without a live
// agent, MongoDB, or GCP.

const CHAR = { name: "Crypto Trader", system: undefined, settings: { system: "old persona", modelConfig: { temperature: 0.7 } } };

test("applyCandidateToCharacter sets the LIVE top-level system + a distinct name, drops id", () => {
    const out = applyCandidateToCharacter({ ...CHAR, id: "fixed-id" }, { target: "system", text: "RISK FIRST. Approval required. No leverage. Re-approve on flip." }, "run9");
    assert.equal(out.system, "RISK FIRST. Approval required. No leverage. Re-approve on flip.");
    assert.equal(out.settings.system, out.system); // mirrored
    assert.match(out.name, /\[scratch run9\]$/); // distinct ⇒ distinct agentId
    assert.equal("id" in out, false);
    assert.equal(CHAR.system, undefined); // original not mutated
});

test("applyCandidateToCharacter merges a config-knob candidate into settings.modelConfig", () => {
    const out = applyCandidateToCharacter(CHAR, { target: "config", config: { temperature: 0.2, maxOutputTokens: 2048 } }, "run9");
    assert.equal(out.settings.modelConfig.temperature, 0.2); // overridden
    assert.equal(out.settings.modelConfig.maxOutputTokens, 2048); // added
    assert.equal(CHAR.settings.modelConfig.temperature, 0.7); // original not mutated
});

test("applyCandidateToCharacter THROWS on an unsupported (rebuild-only) target — fails closed", () => {
    assert.throws(() => applyCandidateToCharacter(CHAR, { target: "cexMessageTemplate", text: "..." }, "run9"), /unsupported A\/B target/);
});

test("expectedRunCount counts scenario × environmentContext variants (≥1)", () => {
    assert.equal(expectedRunCount([{ environmentContext: [{ variant: "baseline" }, { variant: "thesisFlip" }] }, { environmentContext: [{ variant: "baseline" }] }]), 3);
    assert.equal(expectedRunCount([{ id: "no-ec" }]), 1); // missing environmentContext ⇒ counts as 1
    assert.equal(expectedRunCount([]), 1);
});

test("waitForAgentReady resolves once /agents returns a non-empty list", async () => {
    let calls = 0;
    const fetchImpl = async () => ({
        ok: true,
        json: async () => (++calls >= 3 ? { agents: [{ id: "agent-xyz" }] } : { agents: [] }),
    });
    const id = await waitForAgentReady({ server: "http://127.0.0.1:9", fetchImpl, sleep: async () => {}, intervalMs: 1, timeoutMs: 1000, now: () => 0 });
    assert.equal(id, "agent-xyz");
    assert.equal(calls, 3);
});

test("waitForAgentReady rejects on timeout", async () => {
    let t = 0;
    await assert.rejects(
        waitForAgentReady({
            server: "http://127.0.0.1:9",
            fetchImpl: async () => ({ ok: true, json: async () => ({ agents: [] }) }),
            sleep: async () => {},
            intervalMs: 10,
            timeoutMs: 25,
            now: () => (t += 20), // advances past the deadline
        }),
        /not ready/,
    );
});

test("waitForAgentReady matches the SCRATCH agent by name, ignoring a stale/other agent on the port", async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ agents: [{ id: "other", name: "Some Other Agent" }, { id: "mine", name: "Crypto Trader [scratch run42]" }] }) });
    const id = await waitForAgentReady({ server: "http://127.0.0.1:9", fetchImpl, sleep: async () => {}, intervalMs: 1, timeoutMs: 1000, now: () => 0, expectedName: "Crypto Trader [scratch run42]" });
    assert.equal(id, "mine");
});

test("waitForAgentReady times out (fail-safe) when only a non-matching agent answers on the port", async () => {
    let t = 0;
    await assert.rejects(
        waitForAgentReady({ server: "http://127.0.0.1:9", fetchImpl: async () => ({ ok: true, json: async () => ({ agents: [{ id: "other", name: "Other" }] }) }), sleep: async () => {}, intervalMs: 10, timeoutMs: 25, now: () => (t += 20), expectedName: "Crypto Trader [scratch run42]" }),
        /not ready/,
    );
});

// Shared harness: a temp character file + injected seams.
function harness(overrides = {}) {
    const dir = mkdtempSync(join(tmpdir(), "geap-ab-test-"));
    const characterPath = join(dir, "CryptoTrader.json");
    writeFileSync(characterPath, JSON.stringify(CHAR, null, 2));
    const child = { killed: false, kill(sig) { this.killed = true; this.sig = sig; } };
    let rmCount = 0;
    let clock = 1000;
    const config = {
        characterPath,
        userEmail: "paper@example.com",
        scenarios: [{ id: "scenario_02", expectsExecution: true, assertions: { safety: [{ kind: "requiresApprovalBeforeExecute" }], success: [] } }],
        classificationOk: true,
        traceProjectId: "senti-agent-060626",
        spawnAgent: () => child,
        pickPort: async () => 31999,
        waitReady: async () => "agent-xyz",
        runSim: async () => [
            { scenarioId: "scenario_02", safety: { pass: true }, judgeScore: 0.85, steps: [{ name: STEP.RISK_CHECK }, { name: STEP.HUMAN_INPUT_REQUIRED }, { name: STEP.ORDER_SUBMIT }] },
        ],
        collectTrace: async () => ({ p50LatencyMs: 700, p95LatencyMs: 1900, errorSpans: 0, oscillations: 0 }),
        now: () => (clock += 1),
        mkdtemp: () => dir,
        rmdir: () => { rmCount += 1; },
        ...overrides,
    };
    return { dir, characterPath, child, config, rmCount: () => rmCount, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("makeEvaluateCandidate happy path returns the full metric vector + tears down", async () => {
    const h = harness();
    const evaluate = makeEvaluateCandidate(h.config);
    const v = await evaluate({ target: "system", text: "RISK FIRST. Approval required. No leverage. Re-approve on flip.", id: "c1" });
    assert.equal(v.safetyPassRate, 1);
    assert.equal(v.taskScore, 0.85);
    assert.equal(v.toolTrajectoryScore, 1);
    assert.equal(v.classificationOk, true);
    assert.equal(v.p95LatencyMs, 1900); // best-effort trace dimension folded in
    assert.ok(v.runId);
    // The scratch character was actually written with the candidate applied.
    const written = JSON.parse(readFileSync(join(h.dir, "character.scratch.json"), "utf8"));
    assert.match(written.system, /RISK FIRST/);
    // Teardown ran: child killed + temp dir removed.
    assert.equal(h.child.killed, true);
    assert.equal(h.rmCount(), 1);
    h.cleanup();
});

test("makeEvaluateCandidate fails CLOSED when the scratch agent never becomes ready", async () => {
    const h = harness({ waitReady: async () => { throw new Error("scratch agent not ready within 300000ms"); } });
    const evaluate = makeEvaluateCandidate(h.config);
    const v = await evaluate({ target: "system", text: "x", id: "c2" });
    assert.equal(v.safetyPassRate, FAIL_CLOSED.safetyPassRate);
    assert.equal(v.classificationOk, false);
    assert.match(v.error, /not-ready/);
    assert.equal(h.child.killed, true); // still torn down
    h.cleanup();
});

test("makeEvaluateCandidate fails CLOSED when the sim errors, and still tears down", async () => {
    const h = harness({ runSim: async () => { throw new Error("sim produced no readable results"); } });
    const evaluate = makeEvaluateCandidate(h.config);
    const v = await evaluate({ target: "system", text: "x", id: "c3" });
    assert.equal(v.classificationOk, false);
    assert.match(v.error, /sim-failed/);
    assert.equal(h.child.killed, true);
    assert.equal(h.rmCount(), 1);
    h.cleanup();
});

test("makeEvaluateCandidate fails CLOSED on a short/empty sim (NOT safetyPassRate:1 'nothing failed')", async () => {
    const h = harness({ runSim: async () => [] }); // scratch agent booted but ran/answered nothing
    const evaluate = makeEvaluateCandidate(h.config);
    const v = await evaluate({ target: "system", text: "x", id: "c4" });
    assert.equal(v.safetyPassRate, FAIL_CLOSED.safetyPassRate); // 0, NOT 1
    assert.equal(v.classificationOk, false);
    assert.match(v.error, /sim-incomplete/);
    assert.equal(h.child.killed, true);
    h.cleanup();
});

test("makeEvaluateCandidate maps a spawn 'error' event to FAIL_CLOSED instead of an uncaughtException", async () => {
    const child = new EventEmitter();
    child.pid = undefined;
    child.kill = () => { child.killed = true; child.emit("exit"); };
    const h = harness({
        spawnAgent: () => { process.nextTick(() => child.emit("error", new Error("spawn pnpm ENOENT"))); return child; },
        waitReady: () => new Promise(() => {}), // never resolves on its own → the spawn error must win
    });
    const evaluate = makeEvaluateCandidate(h.config);
    const v = await evaluate({ target: "system", text: "x", id: "c5" });
    assert.equal(v.classificationOk, false);
    assert.match(v.error, /not-ready/);
    assert.match(v.error, /ENOENT/);
    h.cleanup();
});

test("makeEvaluateCandidate fails CLOSED on an unsupported target (applyCandidateToCharacter throws)", async () => {
    const h = harness();
    const evaluate = makeEvaluateCandidate(h.config);
    const v = await evaluate({ target: "cexMessageTemplate", text: "...", id: "c6" });
    assert.equal(v.classificationOk, false);
    assert.match(v.error, /ab-error|unsupported/);
    h.cleanup();
});
