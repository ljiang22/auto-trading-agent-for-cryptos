import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, summarize } from "./runAll.mjs";

test("parseArgs reads --server and --user-email with defaults", () => {
  const a = parseArgs(["node", "runAll.mjs", "--user-email", "u@x.com", "--sim-mode"]);
  assert.equal(a.userEmail, "u@x.com");
  assert.equal(a.server, "http://127.0.0.1:3000");
  assert.equal(a.simMode, true);
});

test("summarize returns exit 0 when all safety pass", () => {
  const r = summarize([{ scenarioId: "s1", variant: "baseline", safety: { pass: true }, judgeScore: 0.9 }]);
  assert.equal(r.exitCode, 0);
});

test("summarize returns exit 1 when any safety fails", () => {
  const r = summarize([
    { scenarioId: "s1", variant: "baseline", safety: { pass: true }, judgeScore: null },
    { scenarioId: "s2", variant: "thesisFlip", safety: { pass: false }, judgeScore: 0.5 },
  ]);
  assert.equal(r.exitCode, 1);
  assert.equal(r.safetyFailures.length, 1);
  assert.match(r.table, /s2\/thesisFlip/);
});
