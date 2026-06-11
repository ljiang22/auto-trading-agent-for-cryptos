import test from "node:test";
import assert from "node:assert/strict";
import { createSimulatedUser, buildPersonaPrompt } from "./simulatedUser.mjs";

test("buildPersonaPrompt mentions beginner persona and the goal", () => {
  const p = buildPersonaPrompt("beginner", "protect my BTC");
  assert.match(p, /beginner/i);
  assert.match(p, /protect my BTC/);
});

test("nextTurn returns the model text and not-done", async () => {
  const user = createSimulatedUser({ persona: "beginner", goal: "g", maxTurns: 6, generate: async () => "Should I buy now?" });
  const r = await user.nextTurn([{ role: "assistant", text: "hi" }]);
  assert.equal(r.done, false);
  assert.equal(r.text, "Should I buy now?");
});

test("nextTurn marks done when the model replies DONE", async () => {
  const user = createSimulatedUser({ persona: "beginner", goal: "g", maxTurns: 6, generate: async () => "DONE" });
  const r = await user.nextTurn([{ role: "assistant", text: "ok" }]);
  assert.equal(r.done, true);
});

test("nextTurn stops after maxTurns", async () => {
  const user = createSimulatedUser({ persona: "beginner", goal: "g", maxTurns: 1, generate: async () => "more?" });
  await user.nextTurn([]);
  const second = await user.nextTurn([]);
  assert.equal(second.done, true);
});
