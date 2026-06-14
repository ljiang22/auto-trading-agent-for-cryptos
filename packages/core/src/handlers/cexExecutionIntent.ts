/**
 * Detect explicit execute / status-query intents in CEX plan flows.
 */

const EXPLICIT_EXECUTE_RE = [
    /\b(?:please\s+)?(?:execute|run|start|activate|begin)\s+(?:this|the|my)?\s*(?:modified\s+)?(?:strategy|plan)\b/i,
    /\b(?:execute|run|place|start)\s+(?:this|the)\s+(?:modified\s+)?(?:strategy|plan)\b/i,
    /\b(?:go\s+ahead\s+and\s+)?(?:execute|run)\b/i,
];

const EXECUTION_STATUS_RE = [
    /\b(?:check|show|report|get|what\s+is)\s+(?:the\s+)?(?:executing|execution|order|trade|trading|strategy)\s+status\b/i,
    /\bexecuting\s+status\b/i,
    /\b(?:order|trade|execution|strategy)\s+status\b/i,
    /\bhow\s+(?:is|are)\s+(?:my|the)\s+(?:order|trade|strategy|plan)s?\s+(?:doing|going|executing)\b/i,
    /\bstatus\s+(?:of|on|for)\s+(?:my|the)\s+(?:order|trade|strategy|plan|execution)\b/i,
    /执行状态/u,
    /订单状态/u,
];

/** User explicitly commanded execution (counts as combined approval + execute in paper). */
export function isExplicitExecuteCommand(text: string): boolean {
    const t = (text ?? "").trim();
    if (!t) return false;
    return EXPLICIT_EXECUTE_RE.some((re) => re.test(t));
}

/** User is asking for execution / order status (must not cancel an active plan). */
export function isExecutionStatusQuery(text: string): boolean {
    const t = (text ?? "").trim();
    if (!t) return false;
    return EXECUTION_STATUS_RE.some((re) => re.test(t));
}

const STRATEGY_ADVICE_RE = [
    /\b(?:suggest|recommend|propose|advise)\b[^.?!]{0,80}\bstrateg/i,
    /\b(?:what|which)\s+(?:auto-?trading\s+)?strateg(?:y|ies)\b/i,
    /\bhelp\s+me\s+(?:choose|pick|find|design|come\s+up\s+with)\b[^.?!]{0,60}\bstrateg/i,
    /\badvice\s+(?:on|about|for)\b[^.?!]{0,60}\bstrateg/i,
    /(?:推荐|建议|帮我选)[^。？!]{0,40}策略/u,
];

/**
 * User is ASKING FOR strategy advice/recommendations — a consultation, not an executable order
 * sequence. These must NOT be decomposed into compile/backtest plans: the conversational layer
 * answers with parameterized options + a recommendation, and nothing executes. Distinct from
 * isExplicitExecuteCommand ("execute this strategy"), which IS an execution commitment.
 */
export function isStrategyAdviceQuery(text: string): boolean {
    const t = (text ?? "").trim();
    if (!t) return false;
    if (isExplicitExecuteCommand(t)) return false; // an execution commitment wins over advice phrasing
    return STRATEGY_ADVICE_RE.some((re) => re.test(t));
}

const STRATEGY_REFINEMENT_RE = [
    // edit verb aimed at the strategy/plan or a pronoun ("modify it",
    // "change the strategy", "adjust this", "tweak the DCA"). Requires a
    // strategy/plan/pronoun object so "modify order 123" (an amend) and
    // "cancel order 123" are NOT caught.
    /\b(?:modify|change|adjust|tweak|refine|revise|edit|rework)\b[^.?!]{0,40}\b(?:it|this|that|the\s+(?:strateg|plan|approach|dca|allocation|setup))/i,
    // "I like X but ..." — classic refinement framing.
    /\bi\s+(?:like|prefer)\b[^.?!]{0,60}\bbut\b/i,
    // counter-proposal framing.
    /\b(?:instead|rather\s+than)\b/i,
    /\bmake\s+it\b/i,
    /\bwhat\s+if\b/i,
    // zh-CN: 修改/调整/换成/改成/优化 … (策略|计划|方案)
    /(?:修改|调整|换成|改成|优化)[^。？!]{0,30}(?:策略|计划|方案)/u,
];

/**
 * User is REFINING a previously-discussed strategy (adjusting amounts /
 * levels / rules) WITHOUT an explicit execution instruction. Such messages
 * should re-present the updated strategy for review + iteration — they must
 * NOT be decomposed into an order-execution plan card (the user hasn't
 * committed). `isExplicitExecuteCommand` wins: "modify it … execute this
 * strategy" decomposes and executes as normal. A fresh standalone order
 * ("buy 0.1 BTC at 60000") has no refinement framing, so it is unaffected.
 */
export function isStrategyRefinementQuery(text: string): boolean {
    const t = (text ?? "").trim();
    if (!t) return false;
    if (isExplicitExecuteCommand(t)) return false; // explicit execute commitment wins
    return STRATEGY_REFINEMENT_RE.some((re) => re.test(t));
}
