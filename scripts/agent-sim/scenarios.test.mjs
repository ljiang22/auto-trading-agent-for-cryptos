import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tests", "scenarios");
const KNOWN = new Set([
  "stepEmitted", "stepNotEmitted", "requiresApprovalBeforeExecute",
  "noLeverageUnlessApproved", "reapprovalOnThesisFlip", "refusedRedTeam", "judge",
]);

const files = readdirSync(DIR).filter((f) => /^scenario_\d+\.json$/.test(f));

test("three scenario files exist", () => {
  assert.equal(files.length, 3);
});

for (const f of files) {
  test(`${f} has required fields and known assertion kinds`, () => {
    const s = JSON.parse(readFileSync(join(DIR, f), "utf8"));
    for (const k of ["id", "name", "startingPrompt", "simulatedUser", "environmentContext", "assertions"]) {
      assert.ok(s[k] !== undefined, `${f} missing ${k}`);
    }
    assert.ok(Array.isArray(s.assertions.safety) && s.assertions.safety.length > 0, `${f} needs safety assertions`);
    for (const a of [...s.assertions.safety, ...s.assertions.success]) {
      assert.ok(KNOWN.has(a.kind), `${f} unknown assertion kind: ${a.kind}`);
    }
    for (const ec of s.environmentContext) {
      assert.ok(["baseline", "highVolatility", "thesisFlip"].includes(ec.variant), `${f} bad variant ${ec.variant}`);
    }
  });

  test(`${f} carries an imperative executionRequest and expects execution (so the gate is exercised)`, () => {
    const s = JSON.parse(readFileSync(join(DIR, f), "utf8"));
    // The server ignores client messageClassification for CEX; routing to the gate is reached
    // only via imperative trade phrasing (cex_trade_intent short-circuit). Without an imperative
    // executionRequest the gate never fires; without expectsExecution the safety tier passes
    // vacuously when nothing executes.
    assert.equal(typeof s.executionRequest, "string", `${f} must define an executionRequest string`);
    // Mirror of the server's cex_trade_intent short-circuit (packages/core/src/handlers/
    // langGraphPrecheck.ts:316-339): ANCHORED optional polite prefix + a fresh trade verb.
    // A non-anchored match (e.g. "Okay, please buy…") would route to REGULAR, not CEX.
    const CEX_TRADE_INTENT = /^\s*(?:help\s+me\s+|please\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+|i\s+(?:want|need|wanna|would\s+like|'d\s+like)\s+to\s+|let'?s?\s+(?:me\s+)?)*(?:buy|sell|place|cancel|amend|modify|liquidate)\b/i;
    assert.match(
      s.executionRequest,
      CEX_TRADE_INTENT,
      `${f} executionRequest must match the anchored cex_trade_intent short-circuit so it routes to CEX`,
    );
    assert.equal(s.expectsExecution, true, `${f} must set expectsExecution:true`);
  });
}
