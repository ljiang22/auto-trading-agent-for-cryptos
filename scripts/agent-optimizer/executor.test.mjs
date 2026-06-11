import test from "node:test";
import assert from "node:assert/strict";
import { applyConfigToCharacter, applyPromptToCharacter, configFromStep, executeStep, parseChangedFiles, parseNameStatus } from "./executor.mjs";

// GEAP §8 executor — apply logic + step dispatch, with git/fs/LLM mocked (no real worktree).

const CHAR = `{
    "name": "Crypto Trader",
    "settings": {
        "system": "old persona",
        "modelConfig": { "temperature": 0.7 }
    }
}
`;

test("applyPromptToCharacter upserts the LIVE top-level system, leaving settings.system", () => {
    const out = applyPromptToCharacter(CHAR, "RISK FIRST. Approval required. No leverage. Re-approve on flip.");
    const p = JSON.parse(out);
    assert.match(p.system, /RISK FIRST/);
    assert.equal(p.settings.system, "old persona");
});

test("applyConfigToCharacter merges into settings.modelConfig", () => {
    const out = applyConfigToCharacter(CHAR, { temperature: 0.2, maxOutputTokens: 2048 });
    const p = JSON.parse(out);
    assert.equal(p.settings.modelConfig.temperature, 0.2);
    assert.equal(p.settings.modelConfig.maxOutputTokens, 2048);
});

test("configFromStep reads step.config, then JSON in change, else null", () => {
    assert.deepEqual(configFromStep({ config: { temperature: 0.3 } }), { temperature: 0.3 });
    assert.deepEqual(configFromStep({ change: 'set {"temperature":0.4}' }), { temperature: 0.4 });
    assert.equal(configFromStep({ change: "no json" }), null);
});

test("parseChangedFiles extracts +++ b/<path> entries", () => {
    const diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@\n+line\n--- a/y\n+++ b/y\n+z";
    assert.deepEqual(parseChangedFiles(diff).sort(), ["x", "y"]);
});

test("parseChangedFiles surfaces DELETIONS (path on --- a/, +++ /dev/null) and RENAMES", () => {
    const del = "diff --git a/packages/plugin-cex/src/risk/riskEngine.ts b/packages/plugin-cex/src/risk/riskEngine.ts\ndeleted file mode 100644\n--- a/packages/plugin-cex/src/risk/riskEngine.ts\n+++ /dev/null\n@@\n-content";
    assert.deepEqual(parseChangedFiles(del), ["packages/plugin-cex/src/risk/riskEngine.ts"]);
    const ren = "diff --git a/packages/core/src/handlers/cexWorkflowMessageHandler.ts b/packages/core/src/handlers/benign.ts\nsimilarity index 100%\nrename from packages/core/src/handlers/cexWorkflowMessageHandler.ts\nrename to packages/core/src/handlers/benign.ts";
    assert.deepEqual(parseChangedFiles(ren).sort(), ["packages/core/src/handlers/benign.ts", "packages/core/src/handlers/cexWorkflowMessageHandler.ts"]);
});

test("parseNameStatus reads A/M/D single paths + R/C both endpoints", () => {
    const out = "A\tnew.ts\nM\tmod.ts\nD\tpackages/plugin-cex/src/risk/rules/leverageCap.ts\nR100\told/protected.ts\tnew/benign.ts";
    assert.deepEqual(parseNameStatus(out).sort(), ["mod.ts", "new.ts", "new/benign.ts", "old/protected.ts", "packages/plugin-cex/src/risk/rules/leverageCap.ts"].sort());
});

test("parseChangedFiles tolerates git-QUOTED paths (special/non-ASCII names) + trailing TAB", () => {
    // git quotes a path with special bytes: `+++ "b/..."` / `diff --git "a/..." "b/..."`
    const quoted = 'diff --git "a/packages/plugin-cex/src/risk/café.ts" "b/packages/plugin-cex/src/risk/café.ts"\n--- /dev/null\n+++ "b/packages/plugin-cex/src/risk/café.ts"\n@@\n+x';
    assert.deepEqual(parseChangedFiles(quoted), ["packages/plugin-cex/src/risk/café.ts"]);
    // git appends a TAB after a whitespace-containing path on the +++ line
    const tabbed = "--- /dev/null\n+++ b/packages/plugin-cex/src/risk/evil rule.ts\t\n@@\n+k";
    assert.deepEqual(parseChangedFiles(tabbed), ["packages/plugin-cex/src/risk/evil rule.ts"]);
});

// Mock ctx: in-memory files + recorded git ops.
function mockCtx({ diff = "+++ b/characters/CryptoTrader.json\n+x" } = {}) {
    const files = new Map([["characters/CryptoTrader.json", CHAR]]);
    const applied = [];
    const ctx = {
        characterRel: "characters/CryptoTrader.json",
        readFile: async (rel) => { if (!files.has(rel)) throw new Error(`no ${rel}`); return files.get(rel); },
        writeFile: async (rel, content) => files.set(rel, content),
        gitApply: async (d) => applied.push(d),
        gitDiff: async () => diff,
        writeCode: async ({ file }) => `// rewritten ${file}\n`,
    };
    return { ctx, files, applied };
}

test("executeStep(prompt) applies + reports changed files", async () => {
    const { ctx, files } = mockCtx();
    const res = await executeStep({ target: "prompt", change: "RISK FIRST. Approval required. No leverage." }, ctx);
    assert.equal(res.ok, true);
    assert.deepEqual(res.changedFiles, ["characters/CryptoTrader.json"]);
    assert.match(files.get("characters/CryptoTrader.json"), /RISK FIRST/);
});

test("executeStep(config) merges modelConfig", async () => {
    const { ctx, files } = mockCtx();
    const res = await executeStep({ target: "config", config: { temperature: 0.1 } }, ctx);
    assert.equal(res.ok, true);
    assert.equal(JSON.parse(files.get("characters/CryptoTrader.json")).settings.modelConfig.temperature, 0.1);
});

test("executeStep(code) applies a provided diff, else uses the code-writer", async () => {
    const withDiff = mockCtx();
    const r1 = await executeStep({ target: "code", diff: "--- a/x\n+++ b/x\n+y", files: ["x"] }, withDiff.ctx);
    assert.equal(r1.ok, true);
    assert.equal(withDiff.applied.length, 1);

    const withWriter = mockCtx({ diff: "+++ b/packages/core/src/handlers/statusReport.ts\n+code" });
    const r2 = await executeStep({ target: "code", files: ["packages/core/src/handlers/statusReport.ts"] }, withWriter.ctx);
    assert.equal(r2.ok, true);
    assert.match(withWriter.files.get("packages/core/src/handlers/statusReport.ts"), /rewritten/);
});

test("executeStep fails CLOSED: unparseable config, code w/o diff-or-writer, unknown target", async () => {
    const noWriterCtx = { ...mockCtx().ctx, writeCode: undefined };
    assert.equal((await executeStep({ target: "config", change: "no json" }, mockCtx().ctx)).ok, false);
    assert.equal((await executeStep({ target: "code", files: [] }, noWriterCtx)).ok, false);
    assert.equal((await executeStep({ target: "code", files: ["x.ts"] }, noWriterCtx)).ok, false); // writer missing
    assert.equal((await executeStep({ target: "frobnicate" }, mockCtx().ctx)).ok, false);
});
