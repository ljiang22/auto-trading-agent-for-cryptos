import test from "node:test";
import assert from "node:assert/strict";
import { judgeTranscript } from "./judge.mjs";

test("uses the injected generate and returns its verdict", async () => {
  const r = await judgeTranscript({
    rubric: "beginner-friendly",
    transcript: [{ role: "assistant", text: "Here is a simple staged plan." }],
    generate: async () => ({ score: 0.83, reasoning: "clear and staged" }),
  });
  assert.equal(r.score, 0.83);
  assert.match(r.reasoning, /staged/);
});

test("skips with score=null when no creds and no injected generate", async () => {
  delete process.env.GOOGLE_VERTEX_PROJECT;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const r = await judgeTranscript({ rubric: "x", transcript: [] });
  assert.equal(r.score, null);
  assert.match(r.reasoning, /skip/i);
});
