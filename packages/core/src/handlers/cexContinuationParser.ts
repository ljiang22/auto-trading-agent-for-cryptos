/**
 * CEX Plan — continuation parser.
 *
 * Maps the user's next-turn natural-language reply onto a structured
 * plan command. Deterministic, no LLM call. Runs ONLY when there's an
 * active plan in `awaiting_approval` for the (user, room) — outside
 * that context the parser is moot.
 *
 * Recognized commands:
 *
 *   APPROVE_NEXT     — execute the next pending write, stay in
 *                      step-by-step mode (default behavior).
 *                      Triggers: "yes", "y", "approve", "approved",
 *                      "confirm", "ok", "okay", "go", "do it",
 *                      "place it", "submit", "continue", "next",
 *                      zh-CN "是", "确认", "可以", "好", "继续".
 *
 *   APPROVE_BATCH    — flip the plan's approval_mode to "batch" and
 *                      execute all remaining writes back-to-back.
 *                      Triggers: "yes, all", "approve all", "all of
 *                      them", "place all", "batch approve", "yes
 *                      please all", zh-CN "全部确认", "全部下单".
 *
 *   CANCEL_PLAN      — terminal "cancelled" transition.
 *                      Triggers: "no", "cancel", "stop", "abort",
 *                      "don't", "skip all", "nevermind", "never mind",
 *                      zh-CN "取消", "停止", "不要", "算了".
 *
 *   SKIP_STEP        — advance the cursor past the current step,
 *                      mark it skipped. Triggers: "skip", "skip this",
 *                      "skip 2" (step index ignored if not numeric;
 *                      executor always skips the cursor).
 *
 *   EXECUTION_STATUS — user asks for order/plan status without
 *                      approving or cancelling. Triggers: "check
 *                      executing status", "order status", etc.
 *
 *   UNKNOWN          — none of the above. The caller should fall
 *                      through to the regular CEX classifier — the
 *                      user has likely changed topic.
 *
 * The parser is intentionally generous on the YES side and conservative
 * on the BATCH side: an isolated "yes" never triggers batch approval
 * because that's the safer default. The user must explicitly include
 * "all" / "batch" / "全部" to opt in.
 */

import { isExecutionStatusQuery } from "./cexExecutionIntent.ts";

export type CexContinuationCommand =
    | "APPROVE_NEXT"
    | "APPROVE_BATCH"
    | "CANCEL_PLAN"
    | "SKIP_STEP"
    | "EXECUTION_STATUS"
    | "DELEGATE"
    | "UNKNOWN";

export interface CexContinuationResult {
    command: CexContinuationCommand;
    /** Optional step id parsed from "place 2" / "skip 3" forms. */
    targetStepId?: string;
    /**
     * The matched substring, surfaced for debugging logs / test
     * assertions.
     */
    match?: string;
}

// ---------------------------------------------------------------------------
// Pattern bank
// ---------------------------------------------------------------------------

/**
 * Batch approval. Must include an explicit "all" / "batch" / "全部"
 * token; a bare "yes" must NOT match here. Order matters: batch is
 * checked BEFORE the generic approval list, so "yes, all" doesn't
 * trip the simpler `^yes\b` match first.
 */
const BATCH_PATTERNS: RegExp[] = [
    /\b(?:yes|y|ok(?:ay)?|sure)[\s,.]+(?:all|every(?:thing)?|the\s+rest|remaining)\b/i,
    /\b(?:approve|confirm|place|do|execute|run)[\s,.]+(?:all|every(?:thing)?|the\s+rest|remaining)\b/i,
    /\b(?:batch|bulk)[\s_-]?(?:approve|confirm|execute)?\b/i,
    /\b(?:all\s+of\s+them|all\s+at\s+once|approve\s+all|place\s+all|run\s+all|do\s+them\s+all)\b/i,
    // zh-CN
    /全部(?:确认|下单|执行|批准)/u,
    /一次(?:确认|下单|执行|批准)/u,
];

/**
 * Cancel. Checked early so an isolated "no" doesn't fall through to
 * the regular classifier.
 */
const CANCEL_PATTERNS: RegExp[] = [
    /^\s*(?:no|n|nope|nah)\b[\s.,!?]*$/i,
    // Fix-NEW5 iter3 (post-PR243): negative lookahead so
    // "cancel order 62132339201" (an explicit cancel_order action for
    // a specific id, dispatched by the orders-table Cancel button)
    // is NOT misclassified as a plan-cancel command. The lookahead
    // skips cancel-followed-by-(order|trade|fill|the?-order). Plain
    // "cancel" alone, "cancel plan", "stop please", "cancel everything",
    // "yes but actually cancel" — all still match.
    /\b(?:cancel|abort|stop|halt|terminate)\b(?!\s+(?:the\s+)?(?:order|trade|fill)\b)/i,
    /\b(?:don't|do\s+not|never\s+mind|nevermind|forget\s+it)\b/i,
    /\bskip\s+all\b/i,
    // zh-CN
    /(取消|停止|中止|不要|算了|不用了|放弃)/u,
];

/**
 * Skip-this-step. Generous matching since the executor always
 * advances by exactly one cursor on a skip.
 */
const SKIP_PATTERNS: RegExp[] = [
    /^\s*skip(?:\s+(?:this|step|next))?\b[\s.,!?]*$/i,
    /\bskip\s+(?:this\s+one|the\s+next|step\s+\d+)\b/i,
    /(跳过|忽略)/u,
];

/**
 * Generic approval. Anything that signals "yes proceed" without the
 * batch token. Anchored to the start so a long off-topic message
 * doesn't accidentally match a "yes" mid-paragraph.
 */
const APPROVE_PATTERNS: RegExp[] = [
    /^\s*(?:yes|y|ok(?:ay)?|sure|fine|good|right|confirmed?)\b[\s.,!?]*$/i,
    /^\s*(?:approve|approved|confirm(?:ed)?|go|do\s+it|place\s+it|submit|continue|next|proceed)\b[\s.,!?]*$/i,
    /^\s*(?:yes|y)[\s,.]+(?:please|sir|ma'?am)\b[\s.,!?]*$/i,
    /^\s*(?:please\s+)?(?:do|place|submit|execute|run)\s+(?:it|that|this|the\s+(?:order|step|next))\b[\s.,!?]*$/i,
    // zh-CN
    /^\s*(?:是|是的|确认|可以|好|好的|继续|执行)[\s.,!?]*$/u,
];

/**
 * Delegation — the user defers the decision to the agent rather than
 * giving an explicit yes/no ("you decide", "use your best judgement",
 * "your call", "up to you", "whatever you think is best"). Distinct
 * from APPROVE_NEXT (an explicit "yes") and from UNKNOWN (a genuine
 * topic shift). The runner treats DELEGATE as "fill in sensible
 * defaults for any missing parameters, re-render the plan, and still
 * require one explicit confirmation before executing" — so a vague
 * deferral never silently executes, and never destructively cancels
 * the multi-step plan (the production-1 failure: "You can decide it
 * with your best judgement and practice" used to map to UNKNOWN →
 * plan cancelled → revert to re-offering strategies).
 *
 * NOT anchored to the start — the deferral often trails an
 * acknowledgement ("ok, you decide", "sounds good, your call"). Cancel
 * is checked BEFORE this bank, so "cancel, you decide later" still
 * cancels (safety bias). Order-creation shapes are rejected earlier.
 */
const DELEGATE_PATTERNS: RegExp[] = [
    /\byou\s+(?:can|could|should|may|get\s+to|please)?\s*decide\b/i,
    /\b(?:use\s+)?your\s+(?:best\s+)?judge?ment\b/i,
    /\bbest\s+judge?ment\b/i,
    /\byour\s+(?:call|choice|discretion)\b/i,
    /\bat\s+your\s+discretion\b/i,
    /\bup\s+to\s+you\b/i,
    /\bwhatever\s+you\s+(?:think|like|prefer|decide|want|feel)\b/i,
    /\bas\s+you\s+(?:see\s+fit|think\s+best|wish|prefer)\b/i,
    /\byou\s+(?:choose|pick)\b/i,
    /\b(?:i\s+)?trust\s+(?:your|you)\b/i,
    /\bleave\s+it\s+(?:up\s+)?to\s+you\b/i,
    /\byou\s+know\s+best\b/i,
    // zh-CN
    /(?:由)?你(?:来)?决定/u,
    /你看着办/u,
    /你做主/u,
    /听你的/u,
];

/**
 * "place 2" / "approve 3" forms — explicit step-number references.
 * Matched independently and the step id is captured for the executor
 * to honor.
 *
 * Fix-NEW8 iter4 (post-PR244): negative lookahead to exclude trade-
 * size phrases like "place 10 USDT buy BTC", "place 0.5 BTC", "buy
 * 20 USD worth". Without the guard, "place 10 USDT buy BTC at 60800"
 * matches \b place 10 \b → APPROVE_NEXT step 10 — hijacking a fresh
 * order-creation as a plan-approval and losing the user's intent.
 * Reject when the number is followed by a currency symbol, the word
 * "USDT"/"USDC"/"BTC"/"ETH"/etc, "worth", "of", or has a decimal
 * fraction (real step ids are integers ≤ 20).
 */
const STEP_REFERENCE_RE = /\b(?:approve|place|run|execute|do|step)\s+(\d+)(?!\.\d|\s+(?:USDT|USDC|USD|BUSD|FDUSD|TUSD|EUR|BTC|ETH|SOL|DOGE|XRP|ADA|MATIC|worth|of|at|buy|sell))\b/i;

/**
 * Fix-NEW8 iter4 (post-PR244): order-creation shape. When the user's
 * message looks like a NEW order request (e.g. "place 10 USDT buy BTC
 * at 68000", "buy 0.001 BTC", "sell 10 ETH at 1900"), it must NOT be
 * interpreted as plan-continuation — even when a multi-step plan is
 * awaiting approval. The parser returns UNKNOWN so the workflow falls
 * through to the normal classifier and routes a fresh create_order.
 */
const ORDER_CREATE_INTENT_RE = /\b(?:place|buy|sell)\s+\d+(?:\.\d+)?\s+(?:USDT|USDC|USD|BUSD|FDUSD|TUSD|EUR|BTC|ETH|SOL|DOGE|XRP|ADA|MATIC|worth|of)\b/i;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseContinuation(rawText: string): CexContinuationResult {
    const text = (rawText ?? "").trim();
    if (!text) return { command: "UNKNOWN" };

    if (isExecutionStatusQuery(text)) {
        return { command: "EXECUTION_STATUS", match: text };
    }

    // Fix-NEW8 iter4 (post-PR244): a fresh order-creation message is
    // NOT a plan continuation, even when a multi-step plan is awaiting
    // approval. Reject early so the normal classifier handles it.
    if (ORDER_CREATE_INTENT_RE.test(text)) {
        return { command: "UNKNOWN" };
    }

    // 1. Cancel runs FIRST — "no, never mind" must not be misread as
    //    a partial approval.
    for (const re of CANCEL_PATTERNS) {
        if (re.test(text)) {
            return { command: "CANCEL_PLAN", match: text.match(re)?.[0] };
        }
    }

    // 2. Batch approval — explicit "all" / "batch" / "全部" required.
    for (const re of BATCH_PATTERNS) {
        if (re.test(text)) {
            return { command: "APPROVE_BATCH", match: text.match(re)?.[0] };
        }
    }

    // 3. Skip — generous variants.
    for (const re of SKIP_PATTERNS) {
        if (re.test(text)) {
            return { command: "SKIP_STEP", match: text.match(re)?.[0] };
        }
    }

    // 4. Step reference — "place 2".
    const ref = STEP_REFERENCE_RE.exec(text);
    if (ref) {
        return {
            command: "APPROVE_NEXT",
            targetStepId: ref[1],
            match: ref[0],
        };
    }

    // 5. Generic approval — anchored to start so we don't grab a
    //    "yes" buried inside an unrelated paragraph.
    for (const re of APPROVE_PATTERNS) {
        if (re.test(text)) {
            return { command: "APPROVE_NEXT", match: text.match(re)?.[0] };
        }
    }

    // 6. Delegation — checked AFTER explicit approval so a clean "yes"
    //    stays APPROVE_NEXT, but a deferral ("you decide" / "use your
    //    best judgement") is captured here instead of falling to
    //    UNKNOWN (which would cancel the plan).
    for (const re of DELEGATE_PATTERNS) {
        if (re.test(text)) {
            return { command: "DELEGATE", match: text.match(re)?.[0] };
        }
    }

    return { command: "UNKNOWN" };
}
