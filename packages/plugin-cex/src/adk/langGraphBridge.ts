import { createTradingSubAgent } from "./tradingSubAgent";
import { withAdkTimeout } from "./abortableLlmCall";
import {
    assessRegexConfidence,
    llmExtractCreateOrderFields,
    mergeCreateOrderExtraction,
} from "./llmParameterExtractor";
import { elizaLogger } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";
import type {
    AdkAgentInput,
    AdkAgentResult,
    AdkCreateOrderInput,
    AdkRuntimeContext,
} from "./types";

let cachedAgent: ReturnType<typeof createTradingSubAgent> | null = null;
function getAgent() {
    if (cachedAgent === null) cachedAgent = createTradingSubAgent();
    return cachedAgent;
}

function fallback(context: AdkRuntimeContext): AdkAgentResult {
    return {
        kind: "clarification_question",
        text:
            context.locale === "zh-CN"
                ? "助理暂时繁忙,请稍后再试。"
                : "Trading assistant is busy — please retry shortly.",
        locale: context.locale,
    };
}

/**
 * Entry point used by the core CEX workflow handler. The current ADK
 * classifier is rules-only (synchronous), but the wrapper still routes
 * through `withAdkTimeout` so a future LLM-backed extraction path is
 * timeout-protected by default.
 *
 * Per plan §3.2:
 *   - workflow continues to risk → approval (write) or execute (read)
 *     when `kind === "canonical_intent"`
 *   - workflow ends with the localized text when
 *     `kind === "clarification_question"`
 */
export function runTradingSubAgent(input: AdkAgentInput): AdkAgentResult {
    // Synchronous fast path retained for the rules-only classifier so the
    // core spec provider type stays sync-return.
    return getAgent().run(input);
}

/**
 * §8.6 — async variant for any caller that wants the watchdog to fire on
 * a hung provider. Today's classifier resolves instantly so this is a
 * defensive wiring; tomorrow's LLM-backed extraction will benefit
 * automatically.
 */
export async function runTradingSubAgentSafe(input: AdkAgentInput): Promise<AdkAgentResult> {
    return withAdkTimeout<AdkAgentResult>({
        site: "adk.langGraphBridge.run",
        work: async (signal) => {
            if (signal.aborted) return fallback(input.context);
            const result = getAgent().run(input);
            // F7-r3 — enrich create_order canonical intent with LLM-
            // extracted advanced fields (order_type, TIF, post_only,
            // margin) when the source text trips the confidence gate.
            // Skipped when no runtime is plumbed through the context
            // (sync callers that don't await LLM cost).
            return await maybeEnrichCreateOrderWithLlm(input, result);
        },
        fallback: fallback(input.context),
        request_id: input.requestId,
        userId: input.context.userId,
    });
}

/**
 * F7-r3 — post-process the sub-agent's canonical_intent for create_order
 * with the LLM extractor when the source text has stop-limit / non-default
 * TIF / post-only / margin tokens. No-op for any other tool or when
 * runtime is absent from context.
 */
async function maybeEnrichCreateOrderWithLlm(
    input: AdkAgentInput,
    result: AdkAgentResult,
): Promise<AdkAgentResult> {
    if (result.kind !== "canonical_intent") return result;
    if (result.tool !== "create_order") return result;
    const runtime = input.context.runtime as IAgentRuntime | undefined;
    if (!runtime || typeof runtime !== "object") return result;
    const reasons = assessRegexConfidence(input.message);
    if (reasons.length === 0) return result;
    elizaLogger.info(
        `[plugin-cex F7] enriching create_order intent via LLM extractor; reasons=${reasons.join(",")}`,
    );
    const llmFields = await llmExtractCreateOrderFields(runtime, input.message);
    if (!llmFields) return result;
    // Merge the LLM-derived fields into both the canonical intent and
    // the extractedInput so downstream consumers (idempotency hash,
    // approval UI, audit) see the same enriched values.
    const enrichedInput = mergeCreateOrderExtraction(
        (result.extractedInput as unknown as AdkCreateOrderInput) ?? ({} as AdkCreateOrderInput),
        llmFields,
    );
    const enrichedIntent = {
        ...result.intent,
        // Carry advanced fields verbatim — the canonical intent already
        // has `order_type` / `execution_constraints` / `margin_context`
        // shapes from the regex path; here we layer the LLM additions.
        ...(llmFields.order_type ? { order_type: llmFields.order_type } : {}),
        execution_constraints: {
            ...(result.intent.execution_constraints ?? {}),
            ...(llmFields.time_in_force ? { time_in_force: llmFields.time_in_force } : {}),
            ...(llmFields.end_time ? { end_time: llmFields.end_time } : {}),
            ...(typeof llmFields.post_only === "boolean" ? { post_only: llmFields.post_only } : {}),
        },
        margin_context: {
            ...(result.intent.margin_context ?? {}),
            ...(llmFields.margin_type ? { margin_type: llmFields.margin_type } : {}),
            ...(llmFields.margin_action ? { margin_action: llmFields.margin_action } : {}),
            // Defensive String() coercion in case a future caller bypasses
            // the LLM-extractor schema and passes a raw number through.
            // Pairs with the leverageCap rule's numeric-tolerance and with
            // the llmCreateOrderSchema.leverage union coercion.
            ...(llmFields.leverage !== undefined && llmFields.leverage !== null
                ? { leverage: String(llmFields.leverage) }
                : {}),
        },
    };
    return {
        ...result,
        intent: enrichedIntent,
        extractedInput: enrichedInput as unknown as Record<string, unknown>,
    };
}

/**
 * Helper for the handler: given the existing classified action + parsed
 * params, run the ADK sub-agent to produce a canonical intent (the
 * `forcedTool` + `parameterHints` path bypasses NL classification entirely).
 *
 * This is the integration shape Phase 1's `cexRequestPreprocess` will feed
 * once that lands. Until then, plugins may construct context directly and
 * call this helper for canonical-intent generation.
 */
export function runTradingSubAgentForKnownAction(args: {
    actionName:
        | "get_balance"
        | "get_orders"
        | "get_fills"
        | "create_order"
        | "cancel_order"
        | "amend_order"
        | "preview_order";
    parameterHints: Record<string, unknown>;
    context: AdkRuntimeContext;
    rawMessage: string;
}): AdkAgentResult {
    return runTradingSubAgent({
        message: args.rawMessage,
        context: args.context,
        forcedTool: args.actionName,
        parameterHints: args.parameterHints,
    });
}
