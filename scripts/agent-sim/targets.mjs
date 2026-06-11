/**
 * GEAP evolution — the MUTATION REGISTRY (risk-tiered optimization targets).
 *
 * The user mandate is to optimize *every aspect the evaluation allows*. What can be AUTONOMOUSLY
 * A/B-tested and emitted as a patch is bounded by what is read at runtime (no rebuild) and gated by
 * the deterministic safety floor; everything code-level is PROPOSED for human review. This module
 * declares the tiers and the per-target proposer/validator:
 *
 *   Tier 1 (autoAB, no rebuild):
 *     - "system"  : the live top-level system instruction — reuses optimize.mjs's proposer/validator.
 *     - "config"  : settings.modelConfig knobs (temperature / maxInputTokens / maxOutputTokens /
 *                   frequency_penalty / presence_penalty) — ALL read at runtime by generation.ts,
 *                   so a scratch agent picks them up directly. The lever for the "optimize config" ask.
 *   Tier 2 (needs a core rebuild; NOT yet wired into the evolve A/B loop — a future --allow-rebuild):
 *     - "cexMessageTemplate" : additive-only, Rule 9 verbatim (optimize.mjs validateTemplatePatch).
 *   Tier 3 (propose-only, NEVER auto-applied):
 *     - "architecture" : human-readable recommendations grounded in trace/metric evidence
 *                        (slow nodes, oscillation, errors). Surfaced in the report only.
 *
 * Pure (prompt build / parse / validate) functions are unit-tested; LLM calls are injected.
 */

import { buildProposerPrompt, parseProposerResponse, validateCandidate } from "./optimize.mjs";

// Re-export the system target's reused pieces so evolve.mjs has a single import surface.
export { buildProposerPrompt, parseProposerResponse, validateCandidate };

// ── Tier 1: config knobs ──────────────────────────────────────────────────────────────────────

// Allowed config knobs + their validation bounds. ONLY knobs that generation.ts actually reads
// from `runtime.character.settings.modelConfig` at runtime (verified: lines ~849-868) — so a scratch
// agent genuinely picks them up with no rebuild. `thinkingBudget` and `model` were deliberately
// EXCLUDED: thinkingBudget is a per-call generateText() arg (never sourced from modelConfig) and the
// Google provider resolves `model` from the static registry, so tuning them in modelConfig is a
// no-op — they would produce pure A/B noise.
export const CONFIG_BOUNDS = {
    temperature: { type: "number", min: 0, max: 1 },
    maxInputTokens: { type: "number", min: 1024, max: 200000 },
    maxOutputTokens: { type: "number", min: 256, max: 32768 },
    frequency_penalty: { type: "number", min: -2, max: 2 },
    presence_penalty: { type: "number", min: -2, max: 2 },
};

/**
 * Validate a config-knob candidate: every key must be a known knob and within bounds. An empty or
 * unknown-only config is rejected (nothing safe to apply). Returns optimize.mjs's {safe, ...} shape.
 */
export function validateConfigCandidate(candidate) {
    const cfg = candidate?.config;
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return { safe: false, missing: ["config"], violations: [] };
    const keys = Object.keys(cfg);
    if (!keys.length) return { safe: false, missing: ["config"], violations: [] };
    const violations = [];
    for (const k of keys) {
        const b = CONFIG_BOUNDS[k];
        if (!b) {
            violations.push(`unknown knob ${k}`);
            continue;
        }
        const v = cfg[k];
        if (b.type === "number") {
            if (typeof v !== "number" || !Number.isFinite(v) || v < b.min || v > b.max) violations.push(`${k} out of [${b.min},${b.max}]`);
        } else if (b.type === "string") {
            if (typeof v !== "string" || (b.enum && !b.enum.includes(v))) violations.push(`${k} not an allowed value`);
        }
    }
    return { safe: violations.length === 0, missing: [], violations };
}

/** Build the config-tuning proposer prompt (latency/quality oriented, bounded). */
export function buildConfigProposerPrompt({ currentConfig, failureDigest, traceDigest, n = 2 }) {
    return [
        "You are tuning the runtime model configuration of the SentiEdge crypto trading agent.",
        `Propose ${n} candidate config deltas that improve task quality and/or REDUCE latency without`,
        "harming response quality. You may ONLY set these knobs, within these bounds:",
        ...Object.entries(CONFIG_BOUNDS).map(([k, b]) => `  - ${k}: ${b.enum ? b.enum.join(" | ") : `${b.min}..${b.max}`}`),
        "",
        "Guidance: temperature near 0 improves determinism for a safety-critical agent; a tighter",
        "maxOutputTokens can reduce latency. Never propose changes that would degrade safety reasoning.",
        "",
        "Observed failures:",
        failureDigest || "(none)",
        traceDigest ? `\n${traceDigest}` : "",
        "",
        `Current config: ${JSON.stringify(currentConfig ?? {})}`,
        "",
        'Return ONLY JSON: {"candidates":[{"target":"config","config":{"temperature":0.2,"thinkingBudget":0},"rationale":"<one line>"}]}',
    ].join("\n");
}

/** Parse config candidates from the proposer reply (tolerant of fences / prose). */
export function parseConfigCandidates(text) {
    if (!text) return [];
    let body = String(text).trim();
    const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) body = fence[1].trim();
    else {
        const block = body.match(/[[{][\s\S]*[\]}]/);
        if (block) body = block[0];
    }
    let parsed;
    try {
        parsed = JSON.parse(body);
    } catch {
        return [];
    }
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.candidates) ? parsed.candidates : [];
    return arr
        .filter((c) => c && c.config && typeof c.config === "object")
        .map((c) => ({ target: "config", config: c.config, rationale: typeof c.rationale === "string" ? c.rationale : "" }));
}

// ── Tier 3: architecture / feature recommendations (propose-only) ─────────────────────────────

/** Build a prompt asking for human-reviewable architecture/feature improvements from evidence. */
export function buildArchitecturePrompt({ failureDigest, traceDigest }) {
    return [
        "You are a staff engineer reviewing the SentiEdge crypto trading agent for architecture and",
        "feature improvements. Based ONLY on the evidence below, propose concrete, code-level changes",
        "(e.g. caching a slow node, parallelizing independent steps, adding a guard, a new tool/feature).",
        "These are RECOMMENDATIONS for a human to implement and review — do not assume they are applied.",
        "Each must cite the evidence that motivates it.",
        "",
        "Failure evidence:",
        failureDigest || "(none)",
        "",
        "Trace / latency evidence:",
        traceDigest || "(no Cloud Trace signal available)",
        "",
        'Return ONLY JSON: {"recommendations":[{"title":"<short>","rationale":"<why>","evidence":"<which signal>"}]}',
    ].join("\n");
}

/** Parse architecture recommendations (tolerant). */
export function parseRecommendations(text) {
    if (!text) return [];
    let body = String(text).trim();
    const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) body = fence[1].trim();
    else {
        const block = body.match(/[[{][\s\S]*[\]}]/);
        if (block) body = block[0];
    }
    let parsed;
    try {
        parsed = JSON.parse(body);
    } catch {
        return [];
    }
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.recommendations) ? parsed.recommendations : [];
    return arr
        .filter((r) => r && typeof r.title === "string")
        .map((r) => ({ title: r.title, rationale: String(r.rationale ?? ""), evidence: String(r.evidence ?? "") }));
}

// ── Registry descriptor (drives evolve.mjs target selection + the report) ─────────────────────

export const TARGETS = {
    system: { tier: 1, autoAB: true, label: "top-level system instruction (character.system)" },
    config: { tier: 1, autoAB: true, label: "runtime model config (settings.modelConfig)" },
    // autoAB:false — A/B-with-rebuild can't be isolated (it mutates the shared packages/core/dist),
    // so the evolve loop EXCLUDES it. Listed to document the tier; would need a future --allow-rebuild.
    cexMessageTemplate: { tier: 2, autoAB: false, needsRebuild: true, label: "CEX safety template (additive; Rule 9 verbatim)" },
    architecture: { tier: 3, autoAB: false, proposeOnly: true, label: "architecture / feature recommendations" },
};
