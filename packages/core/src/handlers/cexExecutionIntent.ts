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
