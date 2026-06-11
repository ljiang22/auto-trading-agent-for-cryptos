import test from "node:test";
import assert from "node:assert/strict";
import { isAutoEditableCodePath, isProtectedPath, partitionPaths } from "./policy.mjs";
import { buildPlannerPrompt, finalizeStep, generateOptimizationPlan, parsePlan } from "./optimizationPlannerAgent.mjs";

// GEAP §8 optimization-planner agent — plan parsing/validation + the approval rules.
// Hardened 2026-06-10 (adversarial review): code is deny-by-default; protection is derived from the
// REAL diff targets, not just the LLM's self-declared files.

const evalReport = { score: 68, max: 100, band: "Acceptable", markdown: "# report\n- honestMonitoring failed (code)\n- strategy thin (prompt)" };
const agentState = { currentSystem: "You are a crypto trader.", currentConfig: { temperature: 0.7 } };

test("policy: protected paths catch the trading-safety core (now directory-anchored); prompt surface editable", () => {
    assert.equal(isProtectedPath("packages/core/src/templates/cexMessageTemplate.ts"), true);
    assert.equal(isProtectedPath("packages/core/src/handlers/cexWorkflowMessageHandler.ts"), true);
    assert.equal(isProtectedPath("characters/CryptoTrader.json"), false); // prompt surface is editable
    // The WHOLE handlers/ tree is now protected (was a false-negative before the review).
    assert.equal(isProtectedPath("packages/core/src/handlers/statusReport.ts"), true);
    const { protected: prot, editable } = partitionPaths(["cexMessageTemplate.ts", "statusReport.ts"]);
    assert.deepEqual(prot, ["cexMessageTemplate.ts"]);
    assert.deepEqual(editable, ["statusReport.ts"]); // bare filename, not under a protected dir path
    // Deny-by-default: no code path is auto-editable until the operator opts it into EDITABLE_ALLOWLIST.
    assert.equal(isAutoEditableCodePath("packages/plugin-news/src/index.ts"), false);
});

test("finalizeStep: prompt auto-eligible; ALL code → human (deny-by-default); protected → human", () => {
    const promptStep = finalizeStep({ target: "prompt", change: "add risk rules", risk: "low" }, 0);
    assert.equal(promptStep.requiresHumanApproval, false);
    assert.equal(promptStep.id, "s1");
    // non-protected code STILL requires human approval (heuristic scan can't certify arbitrary source)
    const codeStep = finalizeStep({ target: "code", files: ["packages/plugin-news/src/index.ts"], change: "tweak", risk: "medium" }, 1);
    assert.equal(codeStep.touchesProtected, false);
    assert.equal(codeStep.requiresHumanApproval, true);
    // protected code → human, touchesProtected true
    const protectedStep = finalizeStep({ target: "code", files: ["packages/core/src/templates/cexMessageTemplate.ts"], change: "tweak refusal", risk: "high" }, 2);
    assert.equal(protectedStep.touchesProtected, true);
    assert.equal(protectedStep.requiresHumanApproval, true);
    // bad target/risk default safely
    assert.equal(finalizeStep({ target: "weird", risk: "extreme" }, 3).target, "prompt");
    assert.equal(finalizeStep({ target: "weird", risk: "extreme" }, 3).risk, "medium");
});

test("finalizeStep: unknown/ambiguous target fails CLOSED to human; case + synonyms map correctly", () => {
    // unrecognized target → coerced to the SAFE "prompt" execution but REQUIRES human approval (ambiguous)
    const unknown = finalizeStep({ target: "patchwork-thing", change: "x" }, 0);
    assert.equal(unknown.target, "prompt");
    assert.equal(unknown.requiresHumanApproval, true);
    // case-insensitive + code synonyms ("CODE"/"source"/"patch") → code → human-by-default
    assert.equal(finalizeStep({ target: "CODE", files: ["packages/plugin-news/src/i.ts"] }, 0).requiresHumanApproval, true);
    assert.equal(finalizeStep({ target: "patch", files: ["packages/plugin-news/src/i.ts"] }, 0).requiresHumanApproval, true);
    // safe synonyms: "system" → prompt, "settings" → config (auto-eligible)
    assert.equal(finalizeStep({ target: "system", change: "x" }, 0).requiresHumanApproval, false);
    assert.equal(finalizeStep({ target: "settings", change: "{}" }, 0).requiresHumanApproval, false);
});

test("finalizeStep: a hand-edited plan can't disable approval — requiresHumanApproval is recomputed, not trusted", () => {
    // A human (or tampering) sets requiresHumanApproval:false on a code step in plan.json. On load the
    // loop re-finalizes every step, so the flag is recomputed from target/files and forced back to true.
    const tampered = finalizeStep({ target: "code", files: ["packages/plugin-cex/src/exchanges/services/binance.ts"], requiresHumanApproval: false }, 0);
    assert.equal(tampered.requiresHumanApproval, true);
    // Same for a protected file declared with the flag turned off.
    const tamperedProtected = finalizeStep({ target: "prompt", files: ["packages/core/src/templates/cexMessageTemplate.ts"], requiresHumanApproval: false }, 0);
    assert.equal(tamperedProtected.requiresHumanApproval, true);
});

test("finalizeStep: protection is derived from the DIFF, not just self-declared files", () => {
    // declares an innocuous file but the diff DELETES a protected risk control → touchesProtected
    const sneaky = finalizeStep(
        {
            target: "code",
            files: ["docs/readme.md"],
            diff: "diff --git a/packages/plugin-cex/src/risk/riskEngine.ts b/packages/plugin-cex/src/risk/riskEngine.ts\n--- a/packages/plugin-cex/src/risk/riskEngine.ts\n+++ /dev/null\n@@\n-killSwitch,",
        },
        0,
    );
    assert.equal(sneaky.touchesProtected, true);
    assert.equal(sneaky.requiresHumanApproval, true);
});

test("buildPlannerPrompt embeds report, current state, target, hard rules, JSON contract", () => {
    const p = buildPlannerPrompt({ evalReport, agentState, targetScore: 90 });
    assert.match(p, /score ≥ 90/);
    assert.match(p, /honestMonitoring failed/);
    assert.match(p, /You are a crypto trader/);
    assert.match(p, /never weaken approval\/risk\/leverage\/capital\/Rule-9/i);
    assert.match(p, /architecture\|context\|routing\|tools\|code/);
});

test("generateOptimizationPlan parses an ordered plan + applies the approval rules", async () => {
    const gen = async () => JSON.stringify({
        summary: "Close honestMonitoring + strengthen strategy step.",
        steps: [
            { id: "s1", target: "prompt", files: [], change: "Present 5 strategies + a recommended one with risk rules.", closesGap: "strategyDesignQuality", risk: "low" },
            { id: "s2", target: "code", files: ["packages/core/src/handlers/statusReport.ts"], change: "Filter status to the active strategy's orders.", closesGap: "canExplainTrades", risk: "medium" },
            { id: "s3", target: "code", files: ["packages/core/src/templates/cexMessageTemplate.ts"], change: "tweak", closesGap: "x", risk: "high" },
        ],
    });
    const plan = await generateOptimizationPlan({ evalReport, agentState, generate: gen, targetScore: 90 });
    assert.equal(plan.steps.length, 3);
    assert.equal(plan.steps[0].requiresHumanApproval, false); // prompt → auto-eligible
    assert.equal(plan.steps[1].requiresHumanApproval, true); // code (protected handlers dir) → human
    assert.equal(plan.steps[2].requiresHumanApproval, true); // protected template → human
    assert.match(plan.markdown, /Optimization Plan/);
    assert.match(plan.markdown, /IMPLEMENT IN CURSOR \/ CLAUDE/);
});

test("generateOptimizationPlan fails CLOSED to an empty plan on LLM error / garbage", async () => {
    const errPlan = await generateOptimizationPlan({ evalReport, agentState, generate: async () => { throw new Error("down"); } });
    assert.equal(errPlan.steps.length, 0);
    assert.match(errPlan.summary, /unavailable/);
    assert.deepEqual(parsePlan("not json").steps, []);
});
