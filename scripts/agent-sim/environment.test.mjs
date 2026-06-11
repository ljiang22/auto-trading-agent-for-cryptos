import test from "node:test";
import assert from "node:assert/strict";
import { applyEnvironment } from "./environment.mjs";

test("hard no-op when SIM_MOCK_PROVIDER is unset", () => {
  delete process.env.SIM_MOCK_PROVIDER;
  const r = applyEnvironment("thesisFlip");
  assert.deepEqual(r.injectedTurns, []);
});

test("thesisFlip injects one scripted user turn when enabled", () => {
  process.env.SIM_MOCK_PROVIDER = "1";
  const r = applyEnvironment("thesisFlip");
  assert.equal(r.injectedTurns.length, 1);
  assert.match(r.injectedTurns[0], /negative|flip/i);
  delete process.env.SIM_MOCK_PROVIDER;
});

test("highVolatility injects a volatility context turn when enabled", () => {
  process.env.SIM_MOCK_PROVIDER = "1";
  const r = applyEnvironment("highVolatility");
  assert.equal(r.injectedTurns.length, 1);
  assert.match(r.injectedTurns[0], /volatil|swing/i);
  delete process.env.SIM_MOCK_PROVIDER;
});

test("baseline injects nothing even when enabled", () => {
  process.env.SIM_MOCK_PROVIDER = "1";
  assert.deepEqual(applyEnvironment("baseline").injectedTurns, []);
  delete process.env.SIM_MOCK_PROVIDER;
});
