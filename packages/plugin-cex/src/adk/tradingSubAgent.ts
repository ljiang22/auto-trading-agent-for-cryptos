import { ADK_TOOL_BY_NAME, ALL_ADK_TOOLS } from "./tools";
import { classifyTool, rankToolCandidates } from "./intentClassifier";
import { extractForTool } from "./parameterExtractor";
import type {
    AdkAgentInput,
    AdkAgentResult,
    AdkRuntimeContext,
    AdkTool,
    AdkToolName,
} from "./types";

/**
 * Tool exposure rules per the plan §3.3 + §8.7:
 *  - `preprocess.stake` — write tools hidden for read-classified queries.
 *  - `user.kill_switch_active` — ALL tools hidden (incl. read-only).
 *    Plan §8.7 closes the prior gap where read-only fast-path skipped the
 *    kill-switch evaluation, allowing balance checks while trading was
 *    paused. The clarification text routes to a localized "trading paused"
 *    error, not a venue call.
 *  - `intent.mode` — paper/shadow share the same tool surface as live;
 *    only the mode flag changes.
 *  - venue: locked to the resolved venue; the tool reads it from context.
 */
export function visibleTools(context: AdkRuntimeContext): AdkTool<unknown>[] {
    return ALL_ADK_TOOLS.filter((tool) => {
        if (context.killSwitchActive) return false;
        if (context.stake === "read_only" && tool.stake === "write") return false;
        return true;
    });
}

function clarificationText(
    reason: string,
    locale: AdkRuntimeContext["locale"],
): string {
    const isZh = locale === "zh-CN";
    switch (reason) {
        case "missing_order_id":
            return isZh
                ? "请提供订单 ID 以便我继续操作。"
                : "Please provide the order ID so I can proceed.";
        case "missing_side":
            return isZh
                ? "你想买入还是卖出？请明确指明。"
                : "Do you want to BUY or SELL? Please specify.";
        case "missing_symbol":
            return isZh
                ? "请说明你要交易哪个交易对，例如 BTC-USD。"
                : "Please specify which trading pair, e.g., BTC-USD.";
        case "missing_size":
            return isZh
                ? "请说明数量（例如 0.001 BTC 或 $50）。"
                : "Please specify the order size (e.g., 0.001 BTC or $50).";
        case "missing_limit_price":
            return isZh
                ? "限价单需要指定价格。请指定限价。"
                : "Limit orders require a price. Please specify the limit price.";
        case "kill_switch":
            return isZh
                ? "交易已被禁用 — 紧急开关已激活。"
                : "Trading is currently disabled — kill switch active.";
        case "tool_blocked_read_only":
            return isZh
                ? "该请求属于只读模式，无法执行下单操作。"
                : "This request is classified as read-only; order operations are not available.";
        case "unknown_intent":
            return isZh
                ? "我无法识别这个交易请求，请明确是查询余额、订单、成交记录，还是下单/取消订单。"
                : "I couldn't classify this trading request. Please clarify whether you want balances, orders, fills, or to place/cancel an order.";
        default:
            return isZh
                ? "需要更多信息才能继续。"
                : "I need a bit more information to continue.";
    }
}

export interface TradingSubAgent {
    run(input: AdkAgentInput): AdkAgentResult;
}

/**
 * Build the trading sub-agent. Deterministic — no LLM call in this layer;
 * the LangGraph node may pass `parameterHints` already extracted by a
 * higher-level LLM prompt, in which case those override the heuristic
 * extractor.
 */
export function createTradingSubAgent(): TradingSubAgent {
    return {
        run(input: AdkAgentInput): AdkAgentResult {
            const { context } = input;

            if (context.killSwitchActive && input.forcedTool === undefined) {
                // Hard-stop write intents. Read-only still runs.
            }

            const visible = visibleTools(context);
            const visibleNames = new Set(visible.map((t) => t.name));

            // Determine the tool to execute.
            let toolName: AdkToolName | null = input.forcedTool ?? null;
            if (toolName === null) {
                toolName = classifyTool(input.message);
            }
            if (toolName === null) {
                // Try ranked fallback before giving up.
                const candidates = rankToolCandidates(input.message);
                toolName = candidates.find((c) => visibleNames.has(c)) ?? null;
            }
            if (toolName === null) {
                return {
                    kind: "clarification_question",
                    text: clarificationText("unknown_intent", context.locale),
                    locale: context.locale,
                };
            }

            if (!visibleNames.has(toolName)) {
                const reason =
                    context.killSwitchActive ? "kill_switch" : "tool_blocked_read_only";
                return {
                    kind: "clarification_question",
                    text: clarificationText(reason, context.locale),
                    locale: context.locale,
                    tool: toolName,
                };
            }

            const tool = ADK_TOOL_BY_NAME[toolName];

            // Resolve input parameters.
            let toolInput: unknown;
            if (input.parameterHints) {
                toolInput = input.parameterHints;
            } else {
                const extraction = extractForTool(toolName, input.message);
                if (extraction.kind === "needs_clarification") {
                    return {
                        kind: "clarification_question",
                        text: clarificationText(extraction.reason, context.locale),
                        locale: context.locale,
                        tool: toolName,
                    };
                }
                toolInput = extraction.input;
            }

            const intentRaw = tool.buildIntent({ input: toolInput, context });
            // §6.8 — when the bridge propagated a request_id from the
            // workflow, reuse it so every downstream artifact joins on the
            // same id. Otherwise keep whatever the tool assigned.
            const intent =
                input.requestId && input.requestId.length > 0
                    ? { ...intentRaw, request_id: input.requestId }
                    : intentRaw;
            return {
                kind: "canonical_intent",
                tool: toolName,
                intent,
                extractedInput:
                    toolInput && typeof toolInput === "object"
                        ? (toolInput as Record<string, unknown>)
                        : {},
            };
        },
    };
}
