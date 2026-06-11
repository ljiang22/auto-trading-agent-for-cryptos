import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CRITICAL_REQUIREMENTS, RUBRIC_CATEGORIES, STEPS } from "./rubric.mjs";

// Guards the encoded scenario_01 fixture against drift from rubric.mjs (mistyped category/critical
// keys, broken capital math, prompt mismatch).

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const spec = JSON.parse(readFileSync(join(REPO, "tests", "scenarios", "scenario_01_btc_investment.json"), "utf8"));

const CAT_KEYS = new Set(RUBRIC_CATEGORIES.map((c) => c.key));
const CRIT_KEYS = new Set(CRITICAL_REQUIREMENTS.map((r) => r.key));

test("fixture environment encodes the spec's $1000 paper / no-leverage frame", () => {
    assert.equal(spec.environment.startingCapitalUsd, 1000);
    assert.equal(spec.environment.tradingMode, "paper");
    assert.equal(spec.environment.leverageAllowed, false);
});

test("every referenced rubricCategory key exists in rubric.mjs", () => {
    for (const step of spec.steps) {
        for (const k of step.rubricCategories ?? []) assert.ok(CAT_KEYS.has(k), `unknown rubric category "${k}" in ${step.id}`);
    }
});

test("every referenced critical key exists in rubric.mjs (steps + criticalMustPass)", () => {
    const referenced = new Set(spec.criticalMustPass);
    for (const step of spec.steps) for (const k of step.criticalChecks ?? []) referenced.add(k);
    for (const k of referenced) assert.ok(CRIT_KEYS.has(k), `unknown critical key "${k}"`);
});

test("step prompts match rubric.STEPS verbatim (single source of truth)", () => {
    // step1/2/3/5 are flat; step4 carries the A/B branch
    for (const id of ["step1", "step2", "step3", "step5"]) {
        const fix = spec.steps.find((s) => s.id === id);
        const rub = STEPS.find((s) => s.id === id);
        assert.equal(fix.userPrompt, rub.userPrompt, `prompt mismatch on ${id}`);
    }
    const step4 = spec.steps.find((s) => s.id === "step4");
    assert.equal(step4.variants.A_chooseRecommended.userPrompt, STEPS.find((s) => s.id === "step4A").userPrompt);
    assert.equal(step4.variants.B_modified.userPrompt, STEPS.find((s) => s.id === "step4B").userPrompt);
});

test("step 4B modified strategy commits exactly $1000 ($800 exposure + $200 reserve), no leverage", () => {
    const ms = spec.steps.find((s) => s.id === "step4").variants.B_modified.modifiedStrategy;
    const orders = ms.orders.reduce((s, o) => s + o.usd, 0);
    assert.equal(orders, 800);
    assert.equal(orders + ms.reserveUsd, 1000);
    assert.equal(ms.totalCommittedUsd, 1000);
    assert.equal(ms.maxExposureUsd, 800);
    assert.equal(ms.leverage, false);
});

test("step 3 expects multiple strategy options + the Hybrid DCA + Risk-Control recommendation", () => {
    const step3 = spec.steps.find((s) => s.id === "step3");
    assert.ok(step3.expectedStrategyOptions.length >= 4, "expected several strategy options");
    assert.match(step3.recommendedStrategy, /Hybrid DCA \+ Risk-Control/);
});
