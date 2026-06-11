import test from "node:test";
import assert from "node:assert/strict";
import { STEP } from "./assertions.mjs";
import { makeRubricJudge, runScenario01, scriptedPrompts } from "./runScenario01.mjs";

// GEAP scenario_01 live runner — step-driving orchestration, mocked (no live agent/Vertex).

test("scriptedPrompts selects the 4A or 4B branch and yields the 6-step sequence (with the approval turn)", () => {
    const a = scriptedPrompts("A");
    const b = scriptedPrompts("B");
    assert.equal(a.length, 6);
    assert.equal(b.length, 6);
    assert.equal(a[3].id, "step4A");
    assert.equal(b[3].id, "step4B");
    assert.match(b[3].text, /Buy \$300 now/);
    assert.equal(b[4].id, "step4approve"); // batch-approve the plan → validation reads THEN the gated legs execute
    assert.match(b[4].text, /approve all remaining/i);
    assert.equal(b[5].id, "step5");
});

test("runScenario01 adopts a server room remap (room_created) for all subsequent turns", async () => {
    const postedRooms = [];
    const streamTurn = async ({ roomId }) => {
        postedRooms.push(roomId);
        // First turn: server rebirths the unknown room under a new id.
        const remap = postedRooms.length === 1 ? { roomId: "room-reborn-1" } : { roomId };
        return { assistantText: "PAPER mode, no real money. Comprehensive Analysis included.", ...remap };
    };
    const approvalDriver = { mintTestJwt: () => "jwt", postApproval: async () => ({ ok: true }) };
    const judge = async (prompt) => (/scoring ONE category/i.test(prompt) ? { points: 1 } : { passed: true });
    await runScenario01({ agentId: "a", userEmail: "u@x", roomId: "room-posted-0", deps: { streamTurn, approvalDriver }, judge });
    assert.equal(postedRooms[0], "room-posted-0");
    for (const r of postedRooms.slice(1)) assert.equal(r, "room-reborn-1", "later turns must post the reborn room id");
});

test("runScenario01 drives all 6 steps, approves the gate, builds a capture, and scores it", async () => {
    let turns = 0;
    const streamTurn = async ({ text, onStep }) => {
        turns += 1;
        if (/comprehensive analysis/i.test(text)) onStep({ name: "Comprehensive Analysis" });
        if (/execute|modify|market buy|place .*buy/i.test(text)) {
            onStep({ name: STEP.HUMAN_INPUT_REQUIRED, data: { threadId: "t1", approvalId: "a1", confirmationLevel: 1 } });
            onStep({ name: STEP.ORDER_SUBMIT, data: { notional: 300 } });
        }
        return { assistantText: "Running in PAPER mode — no real money. No guarantees; crypto is volatile and risky." };
    };
    const approvalDriver = { mintTestJwt: () => "jwt-token", postApproval: async () => ({ ok: true }) };
    // mock judge: full points per category, all criticals pass
    const judge = async (prompt) => {
        if (/scoring ONE category/i.test(prompt)) {
            const m = prompt.match(/max (\d+) points/);
            return { points: m ? Number(m[1]) : 10 };
        }
        return { passed: true, detail: "ok" };
    };

    const res = await runScenario01({ agentId: "agent-1", userEmail: "paper@example.com", variant: "B", deps: { streamTurn, approvalDriver }, judge, classificationOk: true });

    assert.equal(turns, 6); // 6 scripted steps driven (incl. the approval turn)
    assert.equal(res.capture.transcript.filter((t) => t.role === "user").length, 6);
    assert.ok(res.capture.approvals.length >= 1); // the execution gate was approved
    // The human approval-modal click must be visible to transcript-only judges (it really happened —
    // capture.approvals records it); without this marker a judge reads the fill as "executed without asking".
    assert.ok(res.capture.transcript.some((t) => t.role === "event" && /approval modal/i.test(t.text)));
    assert.equal(res.metricVector.safetyPassRate, 1); // all 14 criticals passed on this clean capture
    assert.equal(res.verdict.overall, "Excellent");
    assert.match(res.report, /Scorecard/);
    assert.equal(res.variant, "B");
});

test("makeRubricJudge extracts JSON from a generator's text and tolerates garbage", async () => {
    const j = makeRubricJudge(async () => 'sure: {"points": 12, "reasoning": "ok"} done');
    assert.equal((await j("score this")).points, 12);
    const garbage = makeRubricJudge(async () => "no json here");
    assert.deepEqual(await garbage("x"), {});
});
