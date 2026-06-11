/**
 * F6 — pure helpers for the deterministic CEX-continuation precheck
 * bypass. Extracted from `runtime.ts` so the predicate is unit-testable
 * in isolation (the runtime path needs DB + plugin context that's
 * cumbersome to stub end-to-end).
 *
 * The runtime fires the bypass when ALL of:
 *   1. The current user message is short (≤120 chars) OR trivially
 *      affirmative (yes/no/cancel/confirm equivalents, EN + zh-CN) OR
 *      a pure number (with an optional symbol suffix like "0.001 BTC").
 *   2. A recent (≤10 min) assistant memory tagged `source=cex_workflow`
 *      and carrying either `cexAwaitingClarification=true` OR a
 *      `cexRequestId` exists in the same room.
 *   3. F6-r3: NEW intent-shift guard — the current message must NOT
 *      look like a fresh trading request OR an unrelated topic shift.
 *      A new `buy`/`sell` verb attached to a base asset (BTC/ETH/SOL/…)
 *      OR a quote-currency token (USDT/USDC) signals a fresh request,
 *      not a continuation; bypassing those caused the staging defect
 *      where "I want to buy some BTC" was routed as a follow-up to a
 *      prior "please specify size" clarification and got the same stale
 *      reply.
 *
 * Both (1) and (2) must pass AND (3) must NOT trip; otherwise no bypass.
 */

const TRIVIAL_AFFIRM_RE =
    /^(?:y(?:es)?|n(?:o)?|ok(?:ay)?|sure|cancel|confirm|abort|继续|确认|好的|取消|不|是)\s*[.!?。！？]*$/i;

const PURE_NUMERIC_RE =
    /^[-+]?\d+(?:\.\d+)?\s*(?:btc|eth|sol|usd|usdt|usdc)?\s*[.!?。！？]*$/i;

const MAX_SHORT_LEN = 120;

/**
 * F6-r3 intent-shift signals. If ANY of these match the new message,
 * the bypass declines to fire — the message looks like a fresh trading
 * request, not a continuation. The discriminator is "did the user type
 * a new verb attached to an asset" — `buy 0.001 BTC`, `sell ETH`, `cancel
 * my order`, `place a limit`. A bare numeric or affirmation
 * ("0.001", "yes", "USDT") is still allowed through because that IS the
 * shape of a clarification answer.
 *
 * Designed defensively: false-negative (over-bypass) is the more
 * dangerous failure mode because it re-routes a fresh question through
 * stale clarification context — better to fail-open and let the
 * precheck classifier run the new message through fresh.
 */
const FRESH_TRADING_VERB_EN_RE =
    /\b(?:buy|sell|place|open|short|long|go\s+long|go\s+short|cancel|amend|modify|edit|close|exit|liquidate|trade|swap)\b/i;
// CJK characters don't sit between \w / non-\w boundaries, so `\b买\b` never
// matches. Use a separate pattern without word-boundary anchors.
const FRESH_TRADING_VERB_CJK_RE =
    /(?:交易|买|卖|下单|撤销|取消)/;

/**
 * F6-r3 — explicit topic shift detector. If the message ASKS A QUESTION
 * (?, "what", "how", "price", "show me", "explain") it's almost
 * certainly a topic change rather than a parameter-fill, even if short.
 */
const TOPIC_SHIFT_RE =
    /(?:\?|^(?:what|how|why|when|where|which|who|tell\s+me|show\s+me|list|explain|price|什么|如何|为什么|价格|怎么))/i;

/**
 * Round-6d — non-CEX intent detector. Catches messages that clearly
 * belong to OTHER workflows (comprehensive analysis, sentiment, news,
 * research, technical analysis) so the F6 bypass doesn't hijack them
 * into the CEX handler just because a stale clarification memo sits
 * in the room.
 *
 * QA observed two failures from the same root cause:
 *   - "what is current btc price" → CEX handler replied "I cannot
 *     provide real-time market data with the available tools"
 *   - "perform a comprehensive analysis on eth" → CEX dep-health gate
 *     refused with "Market data too stale"
 *
 * Both messages were bypassed to CEX because the predicate only
 * declined on `buy/sell/cancel`-style verbs and `?`-style questions.
 * "perform a comprehensive analysis" matches neither, so the bypass
 * fired with stale CEX context.
 *
 * Pattern is anchored to recognizable analysis / research / data
 * verbs and nouns; conservative enough that legitimate clarification
 * answers ("BTC-USDT", "0.001") still pass.
 */
const NON_CEX_INTENT_RE =
    /\b(?:analyze|analyse|analysis|comprehensive|research|investigate|sentiment|news|technical|fear|greed|on[-_\s]?chain|prediction|forecast|backtest|report|summary|summarize|signals?|trend|outlook|fundamentals|chart|graph|indicator|volatility|funding|momentum|memo|brief|update|define|definition|screen|compare|rank|track|evaluate|assess|watchlist|headline|headlines|rsi|macd|moving\s+average|bollinger|ema|sma|divergence|portfolio|risk\s+review|stress\s+tests?|holdings?|due\s+diligence|cross[-\s]market|quarterly|institutional[-\s]grade)\b/i;
const NON_CEX_INTENT_CJK_RE =
    /(?:分析|研究|新闻|情绪|预测|信号|趋势|图表|指标|基本面|链上|波动|资金费率|综合|对比|比较|排名|追踪|评估|筛选|观察|策略简报|机构级|季度|备忘录|跨市场|压力测试|完整分析)/;

/**
 * Non-crypto instrument markers — stocks / forex / commodities / ETFs.
 * Catches "Plan how to scale into Tesla shares" / "DCA the S&P 500 ETF"
 * etc. so the CEX bypass declines (the CEX workflow does not trade
 * stocks; the LLM classifier's non-crypto-trading guard would correctly
 * land these in REGULAR_MESSAGE if we let it run).
 *
 * Word-boundary anchors are sufficient for the EN list; "S&P" needs an
 * inline character class to handle the `&` reliably.
 */
const NON_CRYPTO_INSTRUMENT_RE =
    /\b(?:tesla|tsla|apple|aapl|microsoft|msft|nvidia|nvda|amazon|amzn|google|googl|spy|s\s?&\s?p|s\s?and\s?p|nasdaq|nas100|dow|djia|russell|stocks?|equit(?:y|ies)|forex|fx|eur[\/]?usd|gbp[\/]?usd|usd[\/]?jpy|gold|gld|silver|slv|oil|wti|brent|index\s+fund|etf|robinhood)\b/i;

/**
 * Greeting / chit-chat shift. A user typing "hi how are you" into a
 * trading-context room is changing the topic — the CEX handler has no
 * useful reply for a greeting, so route it through the regular
 * non-trading path instead. Anchored to the beginning of the message so
 * "hey can you cancel my order" still classifies as a fresh trading
 * verb (handled by FRESH_TRADING_VERB_EN_RE above, which runs first).
 */
// `\b` requires a word/non-word transition, which doesn't apply at the
// CJK ↔ EOF boundary — splitting EN (with `\b`) from CJK (without) avoids
// the same anchor-mismatch trap that `FRESH_TRADING_VERB_CJK_RE` hit.
const GREETING_RE_EN =
    /^(?:hi|hello|hey|howdy|yo|good\s+(?:morning|afternoon|evening|night)|gm|gn|hii+|hola)\b/i;
const GREETING_RE_CJK =
    /^(?:嗨|你好|您好|早上好|晚上好|早安|晚安)/u;
const THANKS_RE_EN =
    /^(?:thanks?|thank\s+you|thx|ty|cheers|appreciated)\b/i;
const THANKS_RE_CJK = /^(?:多谢|谢谢|感谢)/u;

export function isShortFollowUpText(raw: string): boolean {
    const text = (raw ?? "").trim();
    if (text.length === 0) return false;
    if (text.length <= MAX_SHORT_LEN) return true;
    if (TRIVIAL_AFFIRM_RE.test(text)) return true;
    if (PURE_NUMERIC_RE.test(text)) return true;
    return false;
}

/**
 * F6-r3 — returns a reason string if the message looks like a fresh
 * trading request or topic shift; null when no intent-shift signal is
 * present. The trivial-affirmation / pure-numeric shapes are
 * explicitly NOT considered shifts (those are legitimate clarification
 * answers).
 */
export function detectIntentShift(raw: string): string | null {
    const text = (raw ?? "").trim();
    if (!text) return null;
    // Bare answer-shape — never a shift.
    if (TRIVIAL_AFFIRM_RE.test(text)) return null;
    if (PURE_NUMERIC_RE.test(text)) return null;
    if (FRESH_TRADING_VERB_EN_RE.test(text) || FRESH_TRADING_VERB_CJK_RE.test(text)) {
        return "fresh_trading_verb";
    }
    if (TOPIC_SHIFT_RE.test(text)) return "topic_shift_question";
    // Round-6d — explicit non-CEX intents (research / analysis / news /
    // sentiment / technical / on-chain). These belong to OTHER workflows
    // and must not be hijacked by a stale CEX clarification context.
    if (NON_CEX_INTENT_RE.test(text) || NON_CEX_INTENT_CJK_RE.test(text)) {
        return "non_cex_intent";
    }
    // Round-7b — non-crypto trading instruments (stocks / forex / gold
    // / ETF / etc.). The CEX workflow doesn't trade these; the LLM's
    // non-crypto guard would route them to REGULAR.
    if (NON_CRYPTO_INSTRUMENT_RE.test(text)) {
        return "non_crypto_instrument";
    }
    // Round-7 — greetings / thank-yous / chit-chat in a trading context
    // are still topic shifts. The CEX handler has no useful response for
    // "hi how are you", so route through the regular non-trading path.
    if (
        GREETING_RE_EN.test(text) ||
        GREETING_RE_CJK.test(text) ||
        THANKS_RE_EN.test(text) ||
        THANKS_RE_CJK.test(text)
    ) {
        return "non_trading_chitchat";
    }
    return null;
}

/**
 * F6-r4 — intent-class classifier used by the bypass predicate to
 * require continuity between adjacent turns. Returns the canonical
 * trading-action class implied by the message's verb, or null when
 * none is obvious (pure-numeric / affirm / quote-currency answers
 * fall into the null bucket — those are legitimate clarification
 * shapes for any class).
 *
 * Class taxonomy mirrors the canonical action names:
 *   - `cancel`  — cancel_order
 *   - `create`  — create_order (buy / sell / place / open / short / long)
 *   - `modify`  — amend_order  (amend / modify / edit / change)
 *
 * Read paths (`get_balance` / `get_orders` / `get_fills`) intentionally
 * do NOT have a class — they can run alongside any clarification
 * follow-up without hijacking it.
 */
export type CexIntentClass = "cancel" | "create" | "modify";

const VERB_TO_CLASS: Array<[RegExp, CexIntentClass]> = [
    // CJK first (no \b anchors), then English.
    [/(?:撤销|取消)/, "cancel"],
    [/\b(?:cancel)\b/i, "cancel"],
    [/(?:修改|改单|改价)/, "modify"],
    [/\b(?:amend|modify|edit|change|adjust)\b/i, "modify"],
    [/(?:买|卖|下单|做多|做空|平仓)/, "create"],
    [/\b(?:buy|sell|place|open|short|long|go\s+long|go\s+short|close|exit|liquidate|trade|swap)\b/i, "create"],
];

export function classifyCexIntentClassFromText(raw: string): CexIntentClass | null {
    const text = (raw ?? "").trim();
    if (!text) return null;
    for (const [re, cls] of VERB_TO_CLASS) {
        if (re.test(text)) return cls;
    }
    return null;
}

/**
 * Map a canonical action name (the workflow's classified tool) to its
 * intent class. Used by the CEX workflow handler when it stamps
 * `cexIntentClass` onto the clarification memory; the runtime bypass
 * reads it back on the follow-up turn.
 */
export function intentClassForAction(action: string | null | undefined): CexIntentClass | null {
    switch (action) {
        case "cancel_order":
            return "cancel";
        case "create_order":
            return "create";
        case "amend_order":
        case "edit_order":
            return "modify";
        default:
            return null;
    }
}

export interface CexContinuationMemoryLike {
    userId?: string;
    createdAt?: number;
    content?: {
        source?: string;
        metadata?: Record<string, unknown>;
    };
}

export function isCexContinuationMemory(
    memory: CexContinuationMemoryLike,
    opts: { agentId: string; nowMs: number; windowMs?: number },
): boolean {
    const windowMs = opts.windowMs ?? 10 * 60 * 1000;
    if (memory.userId !== opts.agentId) return false;
    if ((memory.createdAt ?? 0) < opts.nowMs - windowMs) return false;
    if (memory.content?.source !== "cex_workflow") return false;
    const meta = (memory.content?.metadata ?? {}) as Record<string, unknown>;
    return (
        meta.cexAwaitingClarification === true || typeof meta.cexRequestId === "string"
    );
}

/**
 * Composite predicate the runtime uses. Returns `true` iff a short
 * follow-up AND a recent CEX continuation memory both apply AND the
 * intent-shift detector finds no fresh-request / topic-shift signal.
 *
 * F6-r3 — the intent-shift guard is the third condition added to fix
 * the staging defect where "I want to buy some BTC" was misrouted as a
 * continuation of an earlier "please specify size" clarification.
 */
export function shouldBypassToCexWorkflow(args: {
    text: string;
    recentMemories: CexContinuationMemoryLike[];
    agentId: string;
    nowMs?: number;
    windowMs?: number;
}): boolean {
    if (!isShortFollowUpText(args.text)) return false;
    if (detectIntentShift(args.text) !== null) return false;
    const nowMs = args.nowMs ?? Date.now();
    return args.recentMemories.some((m) =>
        isCexContinuationMemory(m, { agentId: args.agentId, nowMs, windowMs: args.windowMs }),
    );
}
