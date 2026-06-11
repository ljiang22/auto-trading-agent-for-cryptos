import test from "node:test";
import assert from "node:assert/strict";
import {
    buildArchitecturePrompt,
    buildConfigProposerPrompt,
    CONFIG_BOUNDS,
    parseConfigCandidates,
    parseRecommendations,
    TARGETS,
    validateConfigCandidate,
} from "./targets.mjs";

// GEAP mutation registry — risk-tiered targets. Tests cover config-knob validation/bounds, config
// + recommendation parsing, and prompt construction. The system target reuses optimize.mjs (tested
// there); here we only verify it is re-exported and registered.

test("validateConfigCandidate accepts in-bounds knobs and rejects out-of-bounds / unknown / empty", () => {
    assert.equal(validateConfigCandidate({ config: { temperature: 0.2, maxOutputTokens: 2048 } }).safe, true);
    assert.equal(validateConfigCandidate({ config: { temperature: 1.5 } }).safe, false); // > max
    assert.equal(validateConfigCandidate({ config: { maxOutputTokens: 1 } }).safe, false); // < min
    assert.equal(validateConfigCandidate({ config: { frequency_penalty: 0.5 } }).safe, true);
    assert.equal(validateConfigCandidate({ config: { madeUpKnob: 1 } }).safe, false); // unknown knob
    // thinkingBudget + model were dropped (not runtime-read) → now unknown knobs → rejected
    assert.equal(validateConfigCandidate({ config: { thinkingBudget: 0 } }).safe, false);
    assert.equal(validateConfigCandidate({ config: { model: "gemini-2.5-flash" } }).safe, false);
    assert.equal(validateConfigCandidate({ config: {} }).safe, false); // nothing to apply
    assert.equal(validateConfigCandidate({}).safe, false); // no config
});

test("CONFIG_BOUNDS exposes ONLY the knobs generation.ts reads from settings.modelConfig (no rebuild, no no-ops)", () => {
    for (const k of ["temperature", "maxInputTokens", "maxOutputTokens", "frequency_penalty", "presence_penalty"]) assert.ok(k in CONFIG_BOUNDS, `${k} should be tunable`);
    // dead knobs (not sourced from modelConfig at runtime) must be ABSENT so they aren't proposed
    assert.ok(!("thinkingBudget" in CONFIG_BOUNDS));
    assert.ok(!("model" in CONFIG_BOUNDS));
});

test("buildConfigProposerPrompt embeds current config, bounds, and the digests", () => {
    const p = buildConfigProposerPrompt({ currentConfig: { temperature: 0.7 }, failureDigest: "low judge on scenario_02", traceDigest: "Cloud Trace signal: p95 latency 4200ms", n: 2 });
    assert.match(p, /"temperature":0\.7/);
    assert.match(p, /thinkingBudget/);
    assert.match(p, /low judge on scenario_02/);
    assert.match(p, /p95 latency 4200ms/);
    assert.match(p, /REDUCE latency/);
});

test("parseConfigCandidates parses fenced JSON and drops entries without a config object", () => {
    const text = '```json\n{"candidates":[{"target":"config","config":{"temperature":0.2},"rationale":"determinism"},{"target":"config","rationale":"no config"}]}\n```';
    const c = parseConfigCandidates(text);
    assert.equal(c.length, 1);
    assert.equal(c[0].target, "config");
    assert.equal(c[0].config.temperature, 0.2);
    assert.deepEqual(parseConfigCandidates("garbage"), []);
});

test("buildArchitecturePrompt + parseRecommendations round-trip", () => {
    const p = buildArchitecturePrompt({ failureDigest: "reapprovalOnThesisFlip failed", traceDigest: "slowest nodes: node:riskCheck p95=4200ms" });
    assert.match(p, /RECOMMENDATIONS/);
    assert.match(p, /node:riskCheck p95=4200ms/);
    const recs = parseRecommendations('{"recommendations":[{"title":"Cache riskCheck","rationale":"node:riskCheck is the latency bottleneck","evidence":"p95=4200ms"}]}');
    assert.equal(recs.length, 1);
    assert.equal(recs[0].title, "Cache riskCheck");
    assert.equal(recs[0].evidence, "p95=4200ms");
});

test("TARGETS registry tiers: system/config are autoAB tier-1; architecture is propose-only tier-3", () => {
    assert.equal(TARGETS.system.autoAB, true);
    assert.equal(TARGETS.config.tier, 1);
    assert.equal(TARGETS.cexMessageTemplate.needsRebuild, true);
    assert.equal(TARGETS.architecture.autoAB, false);
    assert.equal(TARGETS.architecture.proposeOnly, true);
});
