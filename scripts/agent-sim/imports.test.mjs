import test from "node:test";
import assert from "node:assert/strict";
import { CORE_PKG } from "./vertex.mjs";

// The judge/simulated-user live paths dynamically import these deep node_modules modules.
// The stubbed unit tests never load them, so verify the paths actually resolve here —
// this is the check that would have caught a wrong zod entry path.

test("ai package resolves with generateText + generateObject", async () => {
  const ai = await import(CORE_PKG.ai);
  assert.equal(typeof ai.generateText, "function");
  assert.equal(typeof ai.generateObject, "function");
});

test("google-vertex package resolves with createVertex", async () => {
  const v = await import(CORE_PKG.vertex);
  assert.equal(typeof v.createVertex, "function");
});

test("zod package resolves with z.object", async () => {
  const { z } = await import(CORE_PKG.zod);
  assert.equal(typeof z.object, "function");
});
