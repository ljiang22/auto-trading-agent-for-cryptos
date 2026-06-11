/**
 * GEAP §8 Auto-Optimizer — OPTIMIZATION-PLANNER sub-agent (ADK-patterned, TypeScript).
 *
 * Consumes the eval-report agent's optimization-grade report + the agent's current state and asks
 * the BEST Gemini (gemini-3.1-pro-preview, fallback gemini-2.5-pro) for an ORDERED, structured plan
 * to close the gaps: each step targets the prompt / a config knob / a source file, with the concrete
 * change, the gap it closes, expected impact, and risk. Steps touching PROTECTED surfaces (policy.mjs)
 * are forced to require explicit human approval; the rest can auto-apply when the safety/security
 * gates pass. The LLM `generate` is injected (unit-tested with a mock); fails CLOSED to an empty plan.
 */

import { isAutoEditableCodePath, isProtectedPath } from "./policy.mjs";
import { parseChangedFiles } from "./executor.mjs";
import { parseJsonObject } from "./evalReportAgent.mjs";

const SYSTEM =
    "You are a principal engineer planning safe, high-impact optimizations to a SAFETY-CRITICAL crypto auto-trading agent. " +
    "Optimize ANY aspect needed to close evaluation gaps: system prompt, config knobs, message routing, context assembly, " +
    "tool/action usage, handler logic, workflow graphs, and templates — not prompt-only band-aids when architecture is the root cause. " +
    "Prefer the smallest change that closes a gap. You must NEVER weaken approval, risk, leverage, capital, or refusal (Rule 9) controls. " +
    "Return ONLY the requested JSON.";

// Case-insensitive synonyms → canonical target. Architecture/context/routing/tools/code are implemented
// by a human or Cursor OUT OF LOOP; only prompt/config may be auto-applied by the harness.
const TARGET_SYNONYMS = {
    prompt: "prompt",
    system: "prompt",
    config: "config",
    settings: "config",
    code: "code",
    source: "code",
    patch: "code",
    diff: "code",
    architecture: "architecture",
    context: "context",
    routing: "routing",
    tools: "tools",
    handlers: "architecture",
    workflow: "architecture",
    handler: "architecture",
};
const RISKS = ["low", "medium", "high"];
/** Targets that are ALWAYS implemented by a human/Cursor agent, never auto-applied in-loop. */
export const HUMAN_IMPLEMENT_TARGETS = new Set(["code", "architecture", "context", "routing", "tools"]);

/** Build the planner prompt from the report + current agent state + the score target. */
export function buildPlannerPrompt({ evalReport, agentState = {}, targetScore = 90 }) {
    return [
        `The agent scored ${evalReport.score}/${evalReport.max} (${evalReport.band}). Target: score ≥ ${targetScore} with ZERO critical failures.`,
        "Produce an ORDERED optimization plan to close ALL gaps in the report — highest-impact first.",
        'Each step uses target: "prompt" | "config" | "architecture" | "context" | "routing" | "tools" | "code".',
        "- prompt: character system instruction (characters/CryptoTrader.json).",
        "- config: settings.modelConfig knobs.",
        "- architecture: cross-cutting design (e.g. routing policy, when to invoke comprehensive workflow vs CEX).",
        "- context: how memory/RAG/user profile/transcript is composed into the model prompt.",
        "- routing: handler selection (regularMessageHandler vs cexWorkflow vs plan runner vs task chain).",
        "- tools: plugin actions — registration, descriptions, invocation policy, synthesizing tool output.",
        "- code: specific file patch (name exact paths).",
        "When diagnosis says gapType is architecture/context/routing/tools, prefer those targets over prompt-only.",
        "Hard rules: never weaken approval/risk/leverage/capital/Rule-9; each step needs concrete change + acceptance criteria.",
        "",
        "EVALUATION REPORT:",
        evalReport.markdown ?? "(no report)",
        "",
        "CURRENT SYSTEM PROMPT:",
        "<<<",
        String(agentState.currentSystem ?? ""),
        ">>>",
        `CURRENT CONFIG: ${JSON.stringify(agentState.currentConfig ?? {})}`,
        agentState.fileMap ? `\nEDITABLE FILE MAP:\n${agentState.fileMap}` : "",
        "",
        'Return ONLY JSON: {"summary":"<1-2 sentences>","steps":[{"id":"s1","target":"prompt|config|architecture|context|routing|tools|code","files":["path"],"change":"<concrete instructions, acceptance criteria, or replacement text>","closesGap":"<gap/critical it closes>","category":"<rubric category key>","expectedImpact":"<e.g. +6 pts / fixes honestMonitoring>","risk":"low|medium|high"}]}',
    ].join("\n");
}

/** Normalize one raw step + enforce the approval rules (adversarial-review hardened, 2026-06-10). */
export function finalizeStep(raw, i) {
    const rawTarget = typeof raw?.target === "string" ? raw.target.trim().toLowerCase() : "";
    const normalized = TARGET_SYNONYMS[rawTarget];
    const target = normalized ?? "prompt"; // default to the SAFEST execution target (only edits the character file)
    const unknownTarget = raw?.target != null && raw?.target !== "" && normalized === undefined; // provided but unrecognized ⇒ ambiguous
    const declared = Array.isArray(raw?.files) ? raw.files.map(String) : raw?.files ? [String(raw.files)] : [];
    // Do NOT trust the LLM's self-declared `files`: also parse the REAL target paths out of the step's
    // diff (in `raw.diff`, or a unified diff embedded in `raw.change`) — including deletes/renames —
    // so a step that declares an innocuous file but patches a protected one is still caught.
    const diffText = String(
        raw?.diff ?? (typeof raw?.change === "string" && /^(?:diff --git |--- |\+\+\+ )/m.test(raw.change) ? raw.change : ""),
    );
    const diffTargets = diffText ? parseChangedFiles(diffText) : [];
    const allFiles = [...new Set([...declared, ...diffTargets])];
    const touchesProtected = allFiles.some(isProtectedPath);

    // Approval policy:
    //  - PROTECTED surface (any target) → always human.
    //  - architecture/context/routing/tools/code → ALWAYS human (Cursor implements out-of-loop).
    //  - prompt/config → auto-eligible when gates pass (legacy auto-apply path only).
    let requiresHumanApproval;
    if (HUMAN_IMPLEMENT_TARGETS.has(target)) {
        requiresHumanApproval =
            target === "code"
                ? touchesProtected || allFiles.length === 0 || !allFiles.every(isAutoEditableCodePath)
                : true;
    } else {
        requiresHumanApproval = touchesProtected || unknownTarget;
    }

    return {
        id: raw?.id ? String(raw.id) : `s${i + 1}`,
        target,
        files: declared,
        change: String(raw?.change ?? ""),
        closesGap: String(raw?.closesGap ?? ""),
        category: String(raw?.category ?? ""),
        expectedImpact: String(raw?.expectedImpact ?? ""),
        risk: RISKS.includes(raw?.risk) ? raw.risk : "medium",
        touchesProtected,
        requiresHumanApproval,
    };
}

/** Parse + normalize a plan from the LLM reply. */
export function parsePlan(text) {
    const obj = parseJsonObject(text);
    const rawSteps = Array.isArray(obj?.steps) ? obj.steps : [];
    return { summary: String(obj?.summary ?? ""), steps: rawSteps.map(finalizeStep) };
}

/**
 * Produce the optimization plan.
 * @param {{ evalReport: any, agentState?: any, generate: (a:{system:string,prompt:string})=>Promise<string>, targetScore?: number }} args
 */
export async function generateOptimizationPlan({ evalReport, agentState = {}, generate, targetScore = 90 }) {
    let plan;
    try {
        const raw = await generate({ system: SYSTEM, prompt: buildPlannerPrompt({ evalReport, agentState, targetScore }) });
        plan = parsePlan(raw);
    } catch (err) {
        plan = { summary: `planner unavailable: ${err?.message ?? err}`, steps: [] };
    }
    return { ...plan, markdown: formatPlanMarkdown(plan) };
}

/** Render the plan as markdown (for the approval gate + human review). */
export function formatPlanMarkdown(plan) {
    const L = [];
    L.push("# Optimization Plan");
    L.push("");
    L.push(plan.summary || "(no summary)");
    L.push("");
    if (!plan.steps.length) {
        L.push("_No steps proposed._");
        return L.join("\n");
    }
    for (const s of plan.steps) {
        const gate = s.requiresHumanApproval ? "🔒 IMPLEMENT IN CURSOR / CLAUDE (human)" : "auto-eligible (legacy prompt/config path only)";
        L.push(`## ${s.id} — ${s.target}${s.files.length ? ` \`${s.files.join(", ")}\`` : ""}  ·  risk: ${s.risk}  ·  ${gate}`);
        L.push(`- **Closes:** ${s.closesGap}${s.category ? ` (category: ${s.category})` : ""}`);
        L.push(`- **Expected impact:** ${s.expectedImpact}`);
        L.push(`- **Change:** ${s.change.length > 400 ? `${s.change.slice(0, 400)}…` : s.change}`);
        if (s.touchesProtected) L.push(`- ⚠️ touches a PROTECTED safety surface → always requires human approval.`);
    }
    return L.join("\n");
}
