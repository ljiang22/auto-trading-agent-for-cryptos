import type { AdkToolName } from "./types";

interface ClassifierSignal {
    tool: AdkToolName;
    /** Patterns: lowercase substrings tested against the user message. */
    patterns: RegExp[];
}

// IMPORTANT: Order matters. More specific verbs (cancel/amend/preview) are
// checked before the generic get_orders pattern because Chinese "订单" alone
// is ambiguous; the leading verb disambiguates.
const SIGNALS: ClassifierSignal[] = [
    {
        tool: "cancel_order",
        patterns: [
            // "cancel ... order(s)" — `orders?` so the plural form
            // ("cancel all my orders") matches without the trailing
            // `\b` rejecting on the `s`. This is the regression that
            // sent multi-id cancel-all requests to get_orders.
            /\bcancel\b.*\borders?\b/i,
            /\bcancel\s+(my\s+)?orders?\b/i,
            // "cancel all" / "cancel everything" / "cancel them" /
            // "cancel of them" — anaphoric / batch phrasings where
            // the user doesn't repeat the word "order" because the
            // assistant just rendered the table. Without these, the
            // ADK returns null and the LLM has been observed to
            // re-fetch orders instead of routing to cancel_order.
            /\bcancel\s+(all|everything|every|each|both|those|these|them|of\s+(them|those|these))\b/i,
            // Chinese — keyword-then-订单 (existing), batch forms
            // (全部 / 所有 取消) added.
            /(取消|撤销|撤单).*订单/u,
            /取消(我的)?订单/u,
            /(全部|所有|全部取消|全取消)\s*(取消|撤销|撤单|订单)/u,
            /(取消|撤销|撤单)\s*(全部|所有|这些|那些|它们)/u,
        ],
    },
    {
        tool: "amend_order",
        patterns: [
            /\b(amend|modify|change|edit|update)\b.*\border\b/i,
            /(修改|更新|更改).*订单/u,
        ],
    },
    {
        tool: "preview_order",
        patterns: [
            /\b(preview|estimate|simulate)\b.*\border\b/i,
            /(预览|估算|模拟).*订单/u,
            /\bhow much would\b.*\bcost/i,
            /\bestimated fees\b/i,
        ],
    },
    {
        tool: "get_balance",
        patterns: [
            /\b(balance|balances|holdings|portfolio)\b/i,
            /(余额|账户余额|持仓)/u,
            /\bhow much\b.*\b(do i have|crypto|btc|eth|sol|usd|usdt)\b/i,
            /\bwhat'?s my\b.*\b(balance|holdings)/i,
        ],
    },
    {
        tool: "get_orders",
        patterns: [
            /\b(open orders|my orders|order history|active orders|pending orders|recent orders)\b/i,
            /(挂单|未成交订单|订单历史|查看.*订单|订单)/u,
            /\bshow.*orders\b/i,
            /\blist.*orders\b/i,
            /\bwhat\s+orders\b/i,
            /\b(any|do\s+i\s+have|have\s+i\s+got)\b.*\borders\b/i,
            /\borders\b.*\b(do\s+i\s+have|i\s+have|exist|are\s+(there|open))\b/i,
        ],
    },
    {
        tool: "get_fills",
        patterns: [
            /\b(fills|trade history|executions|trades)\b/i,
            /(成交记录|执行记录|成交)/u,
            /\bshow.*fills\b/i,
        ],
    },
    {
        tool: "create_order",
        patterns: [
            /\b(buy|sell|long|short|place|submit|put|market\s+order|limit\s+order)\b/i,
            /(买|卖|做多|做空|下单|提交订单|市价单|限价单)/u,
        ],
    },
];

/**
 * Deterministic intent classifier — pattern-based, no LLM call.
 * Returns the first matching tool; ordering matters (cancel/amend before
 * create_order because "cancel my order" also contains "order").
 */
export function classifyTool(messageText: string): AdkToolName | null {
    const trimmed = messageText.trim();
    if (!trimmed) return null;
    for (const signal of SIGNALS) {
        if (signal.patterns.some((p) => p.test(trimmed))) return signal.tool;
    }
    return null;
}

/**
 * Returns ordered candidates by signal-count (most patterns matched wins).
 * Used by the parameter extractor to disambiguate when forcedTool is null.
 */
export function rankToolCandidates(messageText: string): AdkToolName[] {
    const counts = new Map<AdkToolName, number>();
    for (const signal of SIGNALS) {
        const hits = signal.patterns.reduce(
            (acc, p) => acc + (p.test(messageText) ? 1 : 0),
            0,
        );
        if (hits > 0) counts.set(signal.tool, hits);
    }
    return Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([tool]) => tool);
}
