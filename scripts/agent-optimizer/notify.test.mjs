import test from "node:test";
import assert from "node:assert/strict";
import { buildNotification, notifyHalt } from "./notify.mjs";

// GEAP §8 notifications — halt report + optional email. SMTP mocked.

test("buildNotification embeds reason, score, failed gates, step, and diff", () => {
    const n = buildNotification({
        reason: "safety/security gate failed",
        iteration: 2,
        score: 68,
        target: 90,
        escalations: [{ gate: "protected", reasons: ["touches cexMessageTemplate"] }, { gate: "build", reasons: ["tsc error"] }],
        planStep: { id: "s2", target: "code" },
        diff: "+ risky line",
    });
    assert.match(n.subject, /HALT: safety\/security gate failed/);
    assert.match(n.subject, /68\/90/);
    assert.match(n.body, /protected.*cexMessageTemplate/);
    assert.match(n.body, /build.*tsc error/);
    assert.match(n.body, /"id": "s2"/);
    assert.match(n.body, /risky line/);
});

test("notifyHalt always writes the report; emails only when a sender + recipients exist", async () => {
    const writes = [];
    const sends = [];
    const notification = buildNotification({ reason: "x", iteration: 1, score: 1, target: 2 });

    // with sender + recipients → writes + emails
    const r1 = await notifyHalt({ notification, recipients: ["dev@example.com"], deps: { writeReport: async (p, c) => writes.push({ p, c }), send: async (m) => sends.push(m), reportPath: "/tmp/halt.md" } });
    assert.equal(writes.length, 1);
    assert.equal(r1.emailed, true);
    assert.equal(sends[0].to[0], "dev@example.com");

    // no sender → writes only, not emailed
    const r2 = await notifyHalt({ notification, recipients: ["dev@example.com"], deps: { writeReport: async () => {} } });
    assert.equal(r2.emailed, false);

    // no recipients → not emailed even with a sender
    const r3 = await notifyHalt({ notification, recipients: [], deps: { writeReport: async () => {}, send: async () => sends.push("x") } });
    assert.equal(r3.emailed, false);
});

test("notifyHalt tolerates a failing email sender (records error, no throw)", async () => {
    const notification = buildNotification({ reason: "x" });
    const r = await notifyHalt({ notification, recipients: ["dev@example.com"], deps: { writeReport: async () => {}, send: async () => { throw new Error("smtp down"); } } });
    assert.equal(r.emailed, false);
    assert.match(r.error, /smtp down/);
});
