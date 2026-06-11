import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// GEAP §8 — live-seam import-path guard.
//
// `makeLiveSeams` (autoOptimize.mjs) lazily dynamic-imports the live stack so the unit-tested core
// never pulls it. The downside: a WRONG dynamic-import path (e.g. importing abEvaluate.mjs from
// ./ instead of ../agent-sim/) is invisible to every other test and only blows up at live-run time
// with ERR_MODULE_NOT_FOUND. This guard parses EVERY `import("…")` specifier out of autoOptimize.mjs
// and asserts it resolves — without executing any live-seam module (no creds / network needed).

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "autoOptimize.mjs"), "utf8");

test("every dynamic import() specifier in autoOptimize.mjs resolves", () => {
    const specs = [...src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    assert.ok(specs.length >= 8, `expected the live-seam dynamic imports, found ${specs.length}`);
    for (const spec of specs) {
        // node: builtins resolve trivially; relative specifiers must point at a real file on disk.
        assert.doesNotThrow(() => import.meta.resolve(spec), `dynamic import path does not resolve: ${spec}`);
    }
});
