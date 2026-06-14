/**
 * CEX Plan — LLM contextual continuation decider.
 *
 * The deterministic `parseContinuation` (regex) is the FAST PATH for
 * high-confidence replies (bare "yes" / "no" / "cancel" / "skip" /
 * delegation phrases). It is cheap and safe, but it is anchored and
 * literal, so a clear-but-naturally-phrased reply like
 *   "yes, continue with the plan"
 * or a mid-plan non-trading question like
 *   "what's the difference between a stop-limit and a market order?"
 * falls through to UNKNOWN — which previously cancelled the plan and
 * (with the soft-UNKNOWN guard) re-prompts unhelpfully.
 *
 * This module adds an LLM classifier that runs ONLY when the regex
 * returns UNKNOWN. It receives the active plan's context + the recent
 * conversation and maps the reply onto a richer intent set, so the
 * decision is made WITH conversational context/memory instead of by a
 * standalone regex. It never executes anything itself — it only
 * classifies; the plan runner dispatches the result through the same
 * approval-gated handlers as the regex path. Fails safe to UNCLEAR.
 */

import type { IAgentRuntime } from "../core/types.ts";
import { ModelClass } from "../core/types.ts";
import { generateText } from "../ai/generation.ts";
import { elizaLogger } from "../utils/logger.ts";

export type LLMContinuationIntent =
    | "APPROVE_NEXT" // approve proceeding with the next pending step
    | "APPROVE_BATCH" // approve ALL remaining steps at once
    | "CANCEL_PLAN" // stop / abandon the plan
    | "SKIP_STEP" // skip the current step, keep the plan
    | "DELEGATE" // defer the decision to the agent
    | "MODIFY" // change plan parameters before proceeding
    | "NON_TRADING" // unrelated question/topic — answer elsewhere, keep the plan
    | "UNCLEAR"; // none of the above / genuinely ambiguous

const VALID_INTENTS: ReadonlySet<string> = new Set<string>([
    "APPROVE_NEXT",
    "APPROVE_BATCH",
    "CANCEL_PLAN",
    "SKIP_STEP",
    "DELEGATE",
    "MODIFY",
    "NON_TRADING",
    "UNCLEAR",
]);

export interface ContinuationClassifierContext {
    /** The user's latest reply (verbatim). */
    userMessage: string;
    /** Canonical action of the next pending write step (null if none pending). */
    nextStepAction: string | null;
    /** Human-readable description of the next pending write step. */
    nextStepDescription: string | null;
    /** Current plan status (e.g. "awaiting_approval"). */
    planStatus: string;
    /** One-line plan summary. */
    planSummary: string;
    /** Count of remaining write steps. */
    remainingWrites: number;
    /** Compact recent-conversation transcript for context. */
    recentMessages: string;
}

export interface LLMContinuationDecision {
    intent: LLMContinuationIntent;
    reason?: string;
}

/**
 * Build the (system, prompt) pair for the classifier. Pure.
 */
export function buildContinuationClassifierPrompt(ctx: ContinuationClassifierContext): {
    system: string;
    prompt: string;
} {
    const system = [
        "You are a continuation-intent classifier inside a crypto trading agent.",
        "A multi-step trading PLAN is currently awaiting the user's approval. Classify the user's LATEST reply into EXACTLY ONE intent, using the plan context and recent conversation. Output STRICT JSON only: {\"intent\":\"<INTENT>\",\"reason\":\"<short why>\"}.",
        "",
        "Intents:",
        "- APPROVE_NEXT: the user approves proceeding with the next step. Examples: \"yes\", \"yes, continue with the plan\", \"go ahead\", \"sounds good, do it\", \"proceed\", \"let's continue\".",
        "- APPROVE_BATCH: the user approves ALL remaining steps at once. Examples: \"do all of them\", \"approve everything\", \"run them all\", \"yes, all\".",
        "- CANCEL_PLAN: the user wants to STOP or abandon this plan. Examples: \"no\", \"cancel\", \"stop\", \"never mind\", \"forget it\".",
        "- SKIP_STEP: the user wants to skip the CURRENT step but keep the rest of the plan.",
        "- DELEGATE: the user defers the decision to you. Examples: \"you decide\", \"use your best judgement\", \"whatever you think is best\", \"your call\".",
        "- MODIFY: the user wants to CHANGE the plan's parameters before proceeding. Examples: \"make the second buy smaller\", \"use a limit price of 60000\", \"add a stop-loss\", \"change it to $500\".",
        "- NON_TRADING: the reply is NOT about approving/cancelling/modifying THIS plan — it is a general question, an analysis/educational/definitional request, a greeting, or a different topic. Examples: \"what is ethereum?\", \"what's the current BTC sentiment?\", \"how does staking work?\", \"explain stop-limit orders\". The plan should be kept; the question is answered elsewhere.",
        "- UNCLEAR: none of the above, or genuinely ambiguous.",
        "",
        "Rules: Prefer NON_TRADING for questions/explanations (they are not approvals). Prefer CANCEL_PLAN only for clear stop intent. When the reply both asks a question AND clearly approves, choose APPROVE_NEXT. Output ONLY the JSON object.",
    ].join("\n");

    const nextStep =
        ctx.nextStepAction
            ? `Next pending step: ${ctx.nextStepAction} — ${ctx.nextStepDescription ?? "(no description)"}`
            : "No pending write step (all approval-gated steps done).";

    const prompt = [
        `Plan summary: ${ctx.planSummary}`,
        `Plan status: ${ctx.planStatus}; remaining write steps: ${ctx.remainingWrites}.`,
        nextStep,
        "",
        "Recent conversation:",
        ctx.recentMessages || "(none)",
        "",
        `User's latest reply: "${ctx.userMessage}"`,
        "",
        "Classify it now. Output strict JSON only.",
    ].join("\n");

    return { system, prompt };
}

/**
 * Parse the classifier's raw LLM output into a validated decision.
 * Pure; tolerant of fenced blocks / surrounding prose. Fails safe to
 * UNCLEAR so a malformed response never auto-approves or auto-cancels.
 */
export function parseLLMContinuationDecision(raw: string): LLMContinuationDecision {
    const text = (raw ?? "").trim();
    if (!text) return { intent: "UNCLEAR" };
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return { intent: "UNCLEAR" };
    try {
        const obj = JSON.parse(text.slice(start, end + 1)) as {
            intent?: unknown;
            reason?: unknown;
        };
        const intent = String(obj.intent ?? "").toUpperCase().trim();
        if (!VALID_INTENTS.has(intent)) return { intent: "UNCLEAR" };
        return {
            intent: intent as LLMContinuationIntent,
            reason: typeof obj.reason === "string" ? obj.reason : undefined,
        };
    } catch {
        return { intent: "UNCLEAR" };
    }
}

/**
 * Classify an ambiguous continuation reply via the LLM. Fail-safe:
 * any error (no provider, parse failure) yields UNCLEAR so the caller
 * falls back to the deterministic re-prompt rather than guessing.
 */
export async function classifyContinuationWithLLM(args: {
    runtime: IAgentRuntime;
    userId?: string;
    ctx: ContinuationClassifierContext;
}): Promise<LLMContinuationDecision> {
    const { system, prompt } = buildContinuationClassifierPrompt(args.ctx);
    try {
        const raw = await generateText({
            runtime: args.runtime,
            system,
            prompt,
            modelClass: ModelClass.SMALL,
            userId: args.userId,
            temperature: 0,
            maxTokens: 200,
            thinkingBudget: 0,
        });
        const decision = parseLLMContinuationDecision(raw ?? "");
        elizaLogger.info(
            `[CexContinuationLLM] intent=${decision.intent} reason=${decision.reason ?? "(none)"}`,
        );
        return decision;
    } catch (err) {
        elizaLogger.warn(
            `[CexContinuationLLM] classify failed (fail-safe UNCLEAR): ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
        return { intent: "UNCLEAR" };
    }
}
