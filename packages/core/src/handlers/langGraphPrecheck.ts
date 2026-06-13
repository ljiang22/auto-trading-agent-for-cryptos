/**
 * LangGraph Streaming Message Precheck Service
 * Uses LangGraph workflow with real-time streaming updates
 * Provides transparent classification process with live feedback
 */

import { elizaLogger } from "../utils/logger.ts";
import { generateText } from "../ai/generation.ts";
import { composeContextSplit } from "../core/context.ts";
import { getMessageClassificationTemplate } from "../templates/messageClassificationTemplate.ts";
import { ModelClass } from "../core/types.ts";
import { StateGraph, Annotation } from "@langchain/langgraph";
import { buildLangSmithRunnableConfig } from "../utils/langsmith.ts";
import { getNonCEXActions } from "../utils/pluginFilter.ts";
import type {
    IAgentRuntime,
    Memory,
    State,
    MessageClassificationType
} from "../core/types.ts";

// LangGraph state for precheck workflow
export const PrecheckState = Annotation.Root({
    // Input
    message: Annotation<Memory>(),
    runtime: Annotation<IAgentRuntime>(),

    // Processing data
    messageText: Annotation<string>(),
    currentDate: Annotation<string>(),
    availableActions: Annotation<string>(),
    recentMessages: Annotation<string>(),

    // Results
    classification: Annotation<MessageClassificationType>(),
    confidence: Annotation<number>(),
    reasoning: Annotation<string>(),
    isCryptoRelated: Annotation<boolean>(),

    // Processing info
    phase: Annotation<string>(),
    startTime: Annotation<number>(),
});

export type PrecheckStateType = typeof PrecheckState.State;

/**
 * Log processing status
 */
function logProcessingStatus(
    phase: string,
    message?: string
): void {
    elizaLogger.info(`[LangGraphPrecheck] ${phase}: ${message || ''}`);
}

/**
 * Initialize workflow
 */
async function initializeWorkflow(state: PrecheckStateType): Promise<Partial<PrecheckStateType>> {
    const startTime = Date.now();
    const messageText = state.message.content.text || "";

    logProcessingStatus("initializing", "Starting message classification workflow...");

    // Get current date
    const currentDate = new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });

    // Format available actions (excludes trading-exclusive actions)
    const nonCEXActions = getNonCEXActions(state.runtime);
    const availableActions = nonCEXActions.length > 0 ?
        nonCEXActions.map(action =>
            `**${action.name}**: ${action.description}`
        ).join('\n') : "";

    // Fetch recent conversation history for context-aware classification.
    // Per the classifier rewrite, we only include the last 3 USER turns —
    // agent responses are dropped because they bias the LLM toward the
    // prior classification and overload "sentiment / past N weeks" between
    // three buckets. CEX continuation context is already covered by the
    // deterministic precheck bypass that runs BEFORE this classifier.
    let recentMessages = "";
    try {
        const recentMessagesData = await state.runtime.messageManager.getMemories({
            roomId: state.message.roomId,
            count: 20,
            unique: false,
        });
        recentMessages = recentMessagesData
            .filter((msg) => msg.userId !== state.runtime.agentId)
            .slice(-3)
            .map((msg) => `User: ${msg.content.text}`)
            .join("\n");
    } catch (error) {
        elizaLogger.warn(`[LangGraphPrecheck] Failed to load recent messages: ${error}`);
    }

    logProcessingStatus("preparing", "Preparing classification context...");

    return {
        messageText,
        currentDate,
        availableActions,
        recentMessages,
        startTime,
        phase: "preparing"
    };
}

// Pre-LLM short-circuit patterns. Each entry maps a name → regex →
// target classification; a match emits the classification deterministically
// without invoking the LLM classifier. Patterns must be HIGH-confidence:
// any false positive lands a request in the wrong handler. zh-CN patterns
// are included alongside English so the routing logic does not depend on
// the classifier model speaking Chinese.
//
// 2026-05-21 (this PR) — bug repro: `what is the my account balance`.
// The `definitional` rule's negative lookahead used `\s+` (immediately
// after "what is") which missed the typo `what is the my X` form. The
// price-lookup rule sitting right next to it already used `.*\b` for the
// same exclusion. The fix:
//   1. Normalize the `definitional` lookahead to `.*\b` parity with
//      `price_or_direction_lookup`, including the `do/does + I/we/you
//      + have` and `mine + in/on` variants.
//   2. Add a NEW positive-routing rule `cex_account_intent` that emits
//      `CEX_WORKFLOW_MESSAGE` directly for any message that clearly
//      references a personal exchange account (my/our/your +
//      account/balance/wallet/etc., or "check/show/get N balance",
//      or naked CEX-state nouns like "open orders" / "spot balances").
//      This guarantees the CEX workflow's `get_balance` /
//      `get_orders` / `get_fills` actions stay reachable even if the
//      user's phrasing dodges the LLM classifier (typos, CJK), without
//      relying on a non-default `CEX_DETERMINISTIC_BYPASS` flag.
//
// Earlier static-eval round (2026-05-21):
//   - removed `|now` from the price-lookup terminal alternation.
//   - added an EN-only "trivial greeting / affirmation" regex instead of
//     a bare `length <= 15` rule (the length rule over-fired on dense
//     CJK queries).
//
// Pattern order matters: the FIRST matching rule wins. We put the
// positive CEX-intent rule BEFORE the REGULAR-routing rules so an
// account-balance query never short-circuits to REGULAR even if the
// REGULAR rules' guards have edge-case holes.
// Fix 13 — `pnl|p&l|unrealized|leverage|margin` extend the account-noun
// set so "my pnl", "my unrealized pnl", "my leverage" route directly
// to the CEX workflow. The bare-state-noun branch below adds positional
// terms (`positions`, `liquidation price`, etc.) that don't need a
// possessive prefix.
const PERSONAL_ACCOUNT_NOUN_GROUP = "(?:account|balance|wallet|holdings?|portfolio|orders?|fills?|positions?|trades?|history|funds?|pnl|p&l|p\\s*and\\s*l|unrealized(?:\\s+pnl)?|realized(?:\\s+pnl)?|leverage|margin\\s+ratio)";
const POSSESSIVE_GROUP = "(?:my|our|your)";

export interface ShortCircuitPattern {
    name: string;
    re: RegExp;
    classification: MessageClassificationType;
    /**
     * Optional decline-list. When the candidate pattern matches but ANY
     * `excludeIf` regex also matches, treat the pattern as if it had
     * not matched and continue to the next pattern. Used to avoid
     * over-firing on overlapping intents (e.g. "my portfolio" can be
     * either a CEX query or a comprehensive-analysis target — the
     * exclusion checks for analysis verbs / non-crypto instruments
     * before declaring CEX_WORKFLOW_MESSAGE).
     */
    excludeIf?: RegExp[];
}

/**
 * Analysis / research / comprehensive verbs and nouns. Used as an
 * exclusion guard on `cex_account_intent`: when the user is asking
 * for *analysis* of their crypto holdings the routing should go to
 * COMPREHENSIVE / TASK_CHAIN (via the LLM classifier), not to the
 * CEX get_balance / get_orders flow.
 */
const ANALYSIS_INTENT_RE =
    /\b(?:analy(?:z|s)e|analy(?:s|z)is|review|report|research|summary|summarize|memo|briefing|outlook|due\s+diligence|stress\s+tests?|risk\s+review|portfolio\s+review)\b/i;

/**
 * Non-crypto trading instruments. Avoids routing "my Apple stock
 * position" / "my Tesla shares" through the CEX workflow, which only
 * trades crypto. The LLM classifier's non-crypto-trading guard catches
 * these and lands them in REGULAR_MESSAGE with a polite decline.
 */
const NON_CRYPTO_INSTRUMENT_GUARD_RE =
    /\b(?:tesla|tsla|apple|aapl|microsoft|msft|nvidia|nvda|amazon|amzn|google|googl|spy|s\s?&\s?p|s\s?and\s?p|nasdaq|nas100|dow|djia|russell|stocks?|share[s]?|equit(?:y|ies)|forex|fx|eur[/]?usd|gbp[/]?usd|usd[/]?jpy|gold|gld|silver|slv|oil|wti|brent|index\s+fund|etf|robinhood)\b/i;

/**
 * Investment-timing / buy-decision advisory ("is now a good time to buy/invest/DCA…", "should I
 * buy/invest…", "I have $X and want to invest…"). These MUST reach the LLM classifier (which routes
 * them TASK_CHAIN for a multi-dimension timing analysis) — a deterministic price-lookup REGULAR
 * short-circuit on them produces a one-tool answer to a decision question.
 */
const BUY_DECISION_ADVISORY_GUARD_RE =
    /\b(?:good\s+time\s+to\s+(?:buy|invest|dca|enter|get\s+in)|should\s+i\s+(?:buy|invest|dca)|want\s+to\s+invest|worth\s+(?:buying|investing))\b/i;

/**
 * Re-exported so external tooling (e.g. `scripts/eval-classifier-static.mjs`)
 * can validate routing decisions against the same regex set the runtime
 * uses, without maintaining a parallel mirror that drifts.
 */
export const SHORT_CIRCUIT_PATTERNS: ShortCircuitPattern[] = [
    {
        name: "mantle_swap_intent",
        re: /\b(?:swap|exchange|convert)\b.*\b(?:on\s+)?mantle\b|\b(?:on\s+)?mantle\b.*\b(?:swap|exchange|convert)\b|\bWMNT\b.*\b(?:swap|to)\b|\bMerchant\s+Moe\b/i,
        classification: "MANTLE_WORKFLOW_MESSAGE",
    },
    {
        name: "mantle_balance_intent",
        re: /\b(?:balance|holdings|wallet)\b.*\bmantle\b|\bmantle\b.*\b(?:balance|holdings|wallet)\b/i,
        classification: "MANTLE_WORKFLOW_MESSAGE",
    },
    {
        // Positive-routing CEX intent matcher. Fires on any of:
        //   - "my/our/your <account-noun>"               ("my balance", "your orders")
        //   - "the my/our/your <account-noun>"           ("the my account balance"  — the QA typo repro)
        //   - "do/does <i/we/you> have <X> in <venue>"   ("do i have BTC in binance")
        //   - "mine in/on <X>"                           ("what is mine in btc")
        //   - bare "open|recent|pending|filled <orders|fills|positions|trades>"
        //   - "check|show|get|fetch|list|view ... <account-noun>"
        //   - 中文：我的(账户|余额|钱包|持仓|订单)
        // Routes to CEX_WORKFLOW_MESSAGE directly. Anonymous users are
        // still force-rerouted to REGULAR by `runtime.ts:2271`, so
        // there is no anonymous-user blast radius here. Authenticated
        // users without trading enabled get the friendly "enable
        // trading in Settings" template from the CEX handler — strictly
        // better than the generic REGULAR decline.
        name: "cex_account_intent",
        re: new RegExp(
            // EN: possessive + noun, with optional filler ("the", "my old", "your new", etc.)
            `\\b(?:the\\s+)?${POSSESSIVE_GROUP}(?:\\s+\\w+){0,3}\\s+${PERSONAL_ACCOUNT_NOUN_GROUP}\\b` +
            // EN: do/does + i/we/you + have (asks about user's holdings)
            `|\\b(?:do|does)\\s+(?:i|we|you)\\s+have\\b` +
            // EN: "mine" + in/on (ownership query, e.g. "what is mine in btc")
            `|\\bmine\\s+(?:in|on)\\b` +
            // EN: bare CEX-state nouns with status qualifier
            `|\\b(?:open|recent|pending|filled|cancell?ed|active|live)\\s+(?:orders?|fills?|positions?|trades?)\\b` +
            // EN: imperative verb + ... + account-noun
            `|\\b(?:check|show|get|fetch|list|view|display)\\s+(?:me\\s+)?(?:\\w+\\s+){0,4}${PERSONAL_ACCOUNT_NOUN_GROUP}\\b` +
            // EN: "(my|current) (trading )?mode" — Fix 6 read of set_trading_mode
            `|\\b(?:my|current)\\s+(?:trading\\s+)?mode\\b` +
            // M2 iter6 — bare "trading mode" (no possessive, no "current").
            // Fires CEX before the definitional short-circuit so phrasings
            // like "what is trading mode" / "what is the trading mode" /
            // "trading mode?" route to the get_trading_mode action instead
            // of producing a generic Binance/Coinbase encyclopedia answer.
            `|\\btrading\\s+mode\\b` +
            // M2 iter6 — paper/live/shadow as adjectives ("is it paper or
            // live", "paper mode please") and bare "is it paper" / "is it
            // live" / "is it shadow" mode-state questions.
            `|\\b(?:paper|live|shadow)\\s+mode\\b` +
            `|\\bis\\s+it\\s+(?:paper|live|shadow|real)\\b` +
            // EN: "am i (in|on|using) (paper|live|shadow|real)" — mode-state question
            `|\\bam\\s+i\\s+(?:in|on|using)\\s+(?:paper|live|shadow|real)\\b` +
            // Fix 13 — bare positions/PnL/liquidation/leverage nouns.
            // These are common short-hand even without a possessive
            // ("show pnl", "what's the liq price", "leverage on
            // BTCUSDT"). The analysis-intent + non-crypto guard above
            // still vetoes "portfolio pnl review" → COMPREHENSIVE.
            `|\\b(?:p\\s*&\\s*l|p\\s*and\\s*l|pnl)\\b` +
            `|\\b(?:liquidation(?:\\s+price)?|liq\\s+price)\\b` +
            `|\\b(?:unrealized\\s+pnl|unrealized\\s+gains?|realized\\s+pnl)\\b` +
            // zh-CN: 我的 + (账户|余额|钱包|持仓|订单|成交|资产|仓位)
            `|我的(?:账户|余额|钱包|持仓|订单|成交|资产|仓位|交易)` +
            // zh-CN: bare CEX-state nouns
            `|(?:挂单|未成交|待成交|已成交|开仓|平仓)` +
            // Fix 13 — zh-CN positions / PnL / liquidation / leverage nouns.
            `|(?:仓位|持仓|盈亏|未实现盈亏|已实现盈亏|强平价|杠杆)` +
            // zh-CN: mode-question (什么模式 / 当前模式 / 交易模式) — Fix 6
            `|(?:什么模式|当前模式|交易模式)`,
            "iu",
        ),
        classification: "CEX_WORKFLOW_MESSAGE",
        // Decline-list. When the user is asking for a *report* or
        // *review* of their crypto holdings, that's a comprehensive
        // analysis — fall through to the LLM classifier. Same for
        // non-crypto instruments (Apple stock, S&P, etc.) which the
        // CEX workflow does not trade.
        excludeIf: [ANALYSIS_INTENT_RE, NON_CRYPTO_INSTRUMENT_GUARD_RE],
    },
    {
        // Fix 8 — positive-routing CEX asset-list matcher. Routes
        // user-editable allowlist / blocklist commands to the CEX
        // workflow so the write actions (`add_blocked_asset`, etc.)
        // can run. Matches:
        //   - "block DOGE" / "unblock DOGE"
        //   - "add DOGE to (my )?(block|allow|allowed|blocked)list"
        //   - "remove DOGE from (my )?(block|allow|allowed|blocked)list"
        //   - "show my (block|allow)list" / "list my (block|allow)list"
        //   - zh-CN: 屏蔽 / 拉黑 / 允许 / 加入(黑|白)名单
        //
        // Same excludeIf set as cex_account_intent so "block tesla
        // stock from my portfolio review" doesn't get trapped here.
        name: "cex_asset_list_intent",
        re: new RegExp(
            // EN: bare verb + ticker
            `^[\\s]*(?:please\\s+|can\\s+you\\s+|could\\s+you\\s+)?` +
            `(?:un)?block\\s+[A-Za-z0-9]{2,12}\\b` +
            // EN: add/remove + ticker + to/from + (block|allow)list
            `|\\b(?:add|put|append|remove|delete|drop|take\\s+off)\\s+[A-Za-z0-9]{2,12}\\s+` +
            `(?:to|from|onto|off\\s+of|out\\s+of)\\s+(?:my\\s+|the\\s+)?` +
            `(?:block(?:ed)?|allow(?:ed)?)\\s*list\\b` +
            // EN: show/list (my )?(block|allow)list
            `|\\b(?:show|list|view|get|see|display)\\s+(?:me\\s+)?(?:my\\s+|the\\s+)?` +
            `(?:asset\\s+)?(?:block(?:ed)?|allow(?:ed)?)\\s*list(?:s)?\\b` +
            // zh-CN: 屏蔽/拉黑/允许 + ticker / 加入黑名单 / 白名单
            `|(?:屏蔽|拉黑|加入黑名单|加入白名单|从黑名单移除|从白名单移除|查看黑名单|查看白名单|资产黑名单|资产白名单)`,
            "iu",
        ),
        classification: "CEX_WORKFLOW_MESSAGE",
        excludeIf: [ANALYSIS_INTENT_RE, NON_CRYPTO_INSTRUMENT_GUARD_RE],
    },
    {
        // Positive-routing CEX TRADE matcher. Catches imperative
        // fresh-trading-verb messages that the LLM classifier
        // (currently gemini-2.5-flash) sometimes fails to JSON-encode,
        // silently misrouting to REGULAR. Production bug 2026-05-21:
        // "help me place a 10 usdt buy order for btc/usdt with 62000
        // and 10 usdt buy order for eth/usdt with 2100" → classifier
        // returned non-JSON (thinking budget exhausted) → fallback
        // landed it in REGULAR → web search ran instead of trading.
        //
        // Anchored to the start so opinion questions like
        // "should I buy more BTC?" do NOT match (the verb has to
        // appear near the start, after at most a polite intro).
        //
        // Same excludeIf set as cex_account_intent: analysis verbs
        // and non-crypto instruments fall through.
        name: "cex_trade_intent",
        re: new RegExp(
            // EN: optional polite intro + fresh trading verb
            `^[\\s]*` +
            `(?:` +
                `help\\s+me\\s+|` +
                `please\\s+|` +
                `can\\s+you\\s+|` +
                `could\\s+you\\s+|` +
                `would\\s+you\\s+|` +
                `i\\s+(?:want|need|wanna|wanted|would\\s+like|'d\\s+like|d\\s+like)\\s+to\\s+|` +
                `i'd\\s+like\\s+to\\s+|` +
                `let'?s?\\s+(?:me\\s+)?` +
            `)*` +
            // Verbs intentionally exclude generic ones like `trade` and
            // `swap` — Q385 "Help me trade smarter" repro showed that
            // `trade` is ambiguous between trade-execution and
            // trading-advice. The LLM classifier handles those edge
            // cases. Only crystal-clear order-action verbs are listed
            // here.
            `(?:buy|sell|place|cancel|amend|modify|liquidate)\\b` +
            // zh-CN: optional polite intro + fresh trading verb
            `|^[\\s]*(?:帮我|请|麻烦)?[\\s]*(?:买|卖|下单|撤销|取消|平仓|开仓|对冲)`,
            "iu",
        ),
        classification: "CEX_WORKFLOW_MESSAGE",
        excludeIf: [ANALYSIS_INTENT_RE, NON_CRYPTO_INSTRUMENT_GUARD_RE],
    },
    {
        // Fix 15 — instant ticker / order-book intent. Routes
        // market-data questions (live price, bid/ask, order-book, 24h
        // volume, spread, depth) directly to the CEX workflow so the
        // new `get_ticker` / `get_orderbook` actions can answer
        // deterministically. The legacy `price_or_direction_lookup`
        // below would have sent these to REGULAR which has no
        // CEX-action plumbing — Fix 14 enriches the modal, Fix 15
        // exposes the same data as standalone actions for any direct
        // query. Spec-listed patterns (EN + zh-CN):
        //   EN: "price of", "current price", "how much is",
        //       "what is .* trading at", "live price", "order book",
        //       "orderbook", "bid ask", "bid/ask", "spread", "depth",
        //       "24h volume"
        //   zh-CN: 现价, 当前价格, 多少钱, 订单簿, 买一卖一, 深度,
        //         24小时成交量
        //
        // Same excludeIf set as `cex_account_intent` so analysis verbs
        // (review / report / due diligence) and non-crypto instruments
        // (Apple stock, S&P, etc.) fall through to the LLM classifier.
        name: "cex_market_data_intent",
        re: new RegExp(
            // EN: "price of <X>" / "current price (of/for) <X>"
            `\\bprice\\s+of\\b` +
            `|\\bcurrent\\s+price\\b` +
            // EN: "how much is" — but NOT "how much is in my balance"
            // (that's already caught by `cex_account_intent` above).
            `|\\bhow\\s+much\\s+is\\b` +
            // EN: "what is X trading at" / "what is X at right now"
            `|\\bwhat\\s+is\\b.*\\btrading\\s+at\\b` +
            // EN: "<X> price right now" / "<X>'s current price right now"
            `|\\bprice\\b.*\\bright\\s+now\\b` +
            // EN: "live price" / "spot price" — tolerate a single
            // intermediate symbol word ("live BTC price", "spot ETH
            // price"). The `\\b...\\b` boundary on each anchor keeps
            // "alive prices" / "deliveries" from matching.
            `|\\blive(?:\\s+\\w+){0,3}\\s+price\\b` +
            `|\\bspot(?:\\s+\\w+){0,3}\\s+price\\b` +
            // EN: "order book" / "orderbook" (one word or two)
            `|\\border\\s*book\\b` +
            // EN: "bid ask" / "bid/ask" / "bid-ask"
            `|\\bbid[\\s/-]?ask\\b` +
            // EN: "spread" — only when accompanied by another
            // market-data signal (price/bid/ask/bps). A naked
            // "spread" can also mean butterfly/calendar trading
            // strategy. Word-boundary on `bps` so "spreadbps" is
            // included.
            `|\\bspread\\b(?:[^\\n]*\\b(?:bps|price|bid|ask)\\b)?` +
            // EN: "depth" with order/book context — "market depth",
            // "order-book depth", "depth 20" near the start
            `|\\bmarket\\s+depth\\b` +
            `|\\border[\\s-]*book\\s+depth\\b` +
            `|^[\\s]*\\w+\\s+depth\\s+\\d+` +
            // EN: "24h volume" / "24 hour volume" / "24-hour volume" /
            // "24h ETH volume" — tolerate intermediate symbol words.
            `|\\b24[\\s-]*(?:h|hour|hr)(?:\\s+\\w+){0,3}\\s+volume\\b` +
            // zh-CN
            `|现价` +
            `|当前价格` +
            `|多少钱` +
            `|订单簿` +
            `|买一卖一` +
            // zh-CN: 深度 — accept on its own (the CJK boundary is
            // implicit; `深度` is unambiguous in trading context).
            `|深度` +
            `|24小时成交量` +
            `|24\\s*h?\\s*成交量`,
            "iu",
        ),
        classification: "CEX_WORKFLOW_MESSAGE",
        excludeIf: [ANALYSIS_INTENT_RE, NON_CRYPTO_INSTRUMENT_GUARD_RE],
    },
    {
        // Price / direction lookup. The negative lookahead skips
        // personal-account queries that happen to mention BTC/ETH/SOL.
        // Same shape as the `cex_account_intent` matcher above —
        // these two are deliberately symmetric guards.
        name: "price_or_direction_lookup",
        re: /^(what|how\s+much|how's|how\s+is|hows|is)\s+(?!.*(?:\b(?:my|our|your)\s+(?:account|balance|wallet|holdings?|portfolio|orders?|fills?|positions?|trades?|history)|\b(?:do|does)\s+(?:i|we|you)\s+have|\bmine\s+(?:in|on)))\s*.*(btc|eth|sol|bitcoin|ethereum|solana|price)\b/i,
        classification: "REGULAR_MESSAGE",
        // Buy-decision timing advisory must NOT short-circuit to REGULAR — the LLM classifier
        // routes it to TASK_CHAIN for the multi-dimension timing analysis.
        excludeIf: [BUY_DECISION_ADVISORY_GUARD_RE],
    },
    {
        name: "price_or_direction_lookup_zh",
        re: /(比特币|以太坊|索拉纳)\s*.*(多少|价格)|.*\s*(价格|涨了吗|跌了吗)/u,
        classification: "REGULAR_MESSAGE",
    },
    {
        // Definitional short-circuit. The negative lookahead skips
        // personal-account queries — see the file-level comment for
        // the 2026-05-21 bug repro. Lookahead now uses `.*\b` parity
        // with the price-lookup rule above so phrasings like
        // "what is the my account balance" no longer slip through.
        // The positive `cex_account_intent` rule above already routes
        // those to CEX — this lookahead is now just defense-in-depth.
        name: "definitional",
        re: /^(define|explain|what\s+is|what's|whats|who\s+founded|who\s+created)\b(?!.*(?:\b(?:my|our|your)\s+(?:account|balance|wallet|holdings?|portfolio|orders?|fills?|positions?|trades?|history|funds?)|\b(?:do|does)\s+(?:i|we|you)\s+have|\bmine\s+(?:in|on)))/i,
        classification: "REGULAR_MESSAGE",
    },
    {
        name: "trivial_greeting_or_affirmation",
        re: /^(?:hi|hello|hey|howdy|yo|good\s+(?:morning|afternoon|evening|night)|gm|gn|hii+|hola|thanks?|thank\s+you|thx|ty|cheers|yes|no|ok(?:ay)?|sure|continue|abort)\s*[.!?]*$/i,
        classification: "REGULAR_MESSAGE",
    },
    {
        name: "comprehensive_analysis_intent",
        re: /\bcomprehensive\s+analysis\b/i,
        classification: "COMPREHENSIVE_ANALYSIS_MESSAGE",
    },
];

/**
 * Pure helper: run the user's text through the short-circuit regex
 * cascade and return the matching pattern's classification (or null
 * when no pattern matches). Exposed for unit tests and the
 * static-eval harness; no runtime dependency on the agent.
 */
export function evaluateShortCircuit(
    text: string,
): { name: string; classification: MessageClassificationType } | null {
    const trimmed = (text ?? "").trim();
    if (!trimmed) return null;
    for (const { name, re, classification, excludeIf } of SHORT_CIRCUIT_PATTERNS) {
        if (!re.test(trimmed)) continue;
        if (excludeIf?.some((ex) => ex.test(trimmed))) {
            // Pattern matched but a decline-rule vetoed it — keep scanning.
            continue;
        }
        return { name, classification };
    }
    return null;
}

const CRYPTO_KEYWORD_RE = /\b(btc|eth|sol|xrp|ada|doge|bitcoin|ethereum|solana|crypto|coin|token|usdt|usdc|defi|on[-\s]chain|blockchain|wallet|tvl|airdrop|nft|staking)\b/i;
const CRYPTO_KEYWORD_RE_ZH = /(比特币|以太坊|索拉纳|加密|代币|链上|区块链)/u;

/**
 * Pre-LLM heuristic analysis.
 *
 * Promoted from a logging-only step to a real short-circuit: if the user
 * message matches a high-confidence "simple question" pattern, emit
 * REGULAR_MESSAGE deterministically and skip the LLM classifier. Drops
 * p50 latency for trivial lookups (e.g. "what is the btc price") and
 * removes a class of stochastic mis-classifications.
 */
async function analyzeMessage(state: PrecheckStateType): Promise<Partial<PrecheckStateType>> {
    logProcessingStatus("analyzing", "Analyzing message content and complexity...");

    const raw = state.messageText ?? "";
    const trimmed = raw.trim();

    // Named patterns (CEX-intent, price/direction lookup, definition,
    // greeting/affirmation). The bare `length <= 15` short-circuit was
    // removed in the static-eval round because CJK queries pack semantic
    // content into very few characters. Each pattern carries its own
    // target classification — CEX-intent fires CEX_WORKFLOW_MESSAGE
    // while the rest fire REGULAR_MESSAGE.
    for (const { name, re, classification, excludeIf } of SHORT_CIRCUIT_PATTERNS) {
        if (!re.test(trimmed)) continue;
        if (excludeIf?.some((ex) => ex.test(trimmed))) {
            // Pattern matched but a decline-rule vetoed it (e.g. an
            // analysis-verb on a cex_account_intent candidate). Keep
            // scanning so the LLM classifier gets the call.
            continue;
        }
        const isCryptoRelated = CRYPTO_KEYWORD_RE.test(trimmed) || CRYPTO_KEYWORD_RE_ZH.test(trimmed);
        logProcessingStatus(
            "short_circuit",
            `matched short-circuit pattern: ${name} → ${classification}`,
        );
        return {
            classification,
            confidence: 0.95,
            reasoning: `matched short-circuit pattern: ${name}`,
            isCryptoRelated,
            phase: "short_circuit",
        };
    }

    // Fall-through: defer to the LLM classifier in the next node.
    let analysisInfo = "";
    if (trimmed.length < 20) {
        analysisInfo = "Detected simple message";
    } else if (trimmed.includes("analyze") || trimmed.includes("compare") || trimmed.includes("research")) {
        analysisInfo = "Detected complex analysis request";
    } else if (trimmed.includes("comprehensive") || trimmed.includes("detailed") || trimmed.includes("report")) {
        analysisInfo = "Detected comprehensive analysis request";
    } else {
        analysisInfo = "Performing deep semantic analysis";
    }
    logProcessingStatus("analyzing", analysisInfo);

    return {
        phase: "analyzing"
    };
}

/**
 * LLM classification
 */
async function classifyWithLLM(state: PrecheckStateType): Promise<Partial<PrecheckStateType>> {
    logProcessingStatus("classifying", "Using AI model for classification...");

    try {
        // Prepare classification context - split for prompt caching
        const { system, prompt } = composeContextSplit({
            state: {
                userMessage: state.messageText,
                agentName: state.runtime.character?.name || "Agent",
                currentDate: state.currentDate,
                availableActions: state.availableActions,
                recentMessages: state.recentMessages || "",
                bio: "",
                lore: "",
                messageDirections: "",
                postDirections: "",
                actors: "",
                goals: "",
                roomId: state.message.roomId,
                recentMessagesData: []
            } as State,
            template: getMessageClassificationTemplate()
        });

        logProcessingStatus("classifying", "AI model processing...");

        // Generate classification.
        //
        // - `temperature=0` pins the model to deterministic output so the
        //   same prompt yields the same bucket.
        // - `maxTokens=256` caps the response size — the JSON payload is
        //   <100 tokens so this also catches runaway outputs.
        // - `thinkingBudget=0` disables Gemini 2.5 Flash/Pro's internal
        //   reasoning step. Without this, thinking tokens count against
        //   `maxTokens` and frequently consume the entire budget for
        //   ambiguous prompts, leaving the visible response empty — which
        //   silently lands the user in REGULAR_MESSAGE. Production
        //   incident 2026-05-21: a clear "place a 10 USDT BTC buy order"
        //   trade request misrouted to REGULAR via this path.
        const callClassifier = (maxTokens: number): Promise<string> =>
            generateText({
                runtime: state.runtime,
                system,
                prompt,
                modelClass: ModelClass.SMALL,
                userId: state.message.userId,
                temperature: 0,
                maxTokens,
                thinkingBudget: 0,
            });

        let response = await callClassifier(256);

        // Always log the raw response at debug level so future
        // debugging sessions don't need to hypothesize what the
        // model emitted. Truncated to the first 600 chars to keep
        // log volume manageable.
        elizaLogger.debug(
            `[LangGraphPrecheck] classifier raw response (len=${response.length}): ${String(response ?? "").slice(0, 600)}`,
        );

        logProcessingStatus("parsing", "Parsing classification results...");

        // Parse response. On failure (no JSON, malformed JSON, invalid
        // classification token, or empty response), retry ONCE with a
        // larger output budget. The 256-token cap can be exhausted by
        // a single edge case where the model emits a long preamble; a
        // 1024-token retry usually clears that and the retry path
        // never fires on healthy responses (so cost stays flat).
        let classification: ReturnType<typeof parseClassificationResponse>;
        try {
            classification = parseClassificationResponse(response);
        } catch (parseError: any) {
            elizaLogger.warn(
                `[LangGraphPrecheck] classifier parse failed (${parseError?.message ?? "unknown"}); retrying with maxTokens=1024`,
            );
            response = await callClassifier(1024);
            elizaLogger.debug(
                `[LangGraphPrecheck] classifier retry raw response (len=${response.length}): ${String(response ?? "").slice(0, 600)}`,
            );
            // Let the second parse failure bubble up to the outer catch
            // — at that point we've already paid for two LLM calls and
            // the deterministic fallback is the right move.
            classification = parseClassificationResponse(response);
        }

        logProcessingStatus("completed", `Classification complete: ${getClassificationDisplayName(classification.classification)}`);

        return {
            classification: classification.classification,
            confidence: classification.confidence,
            reasoning: classification.reasoning,
            isCryptoRelated: classification.isCryptoRelated,
            phase: "completed"
        };

    } catch (error: any) {
        logProcessingStatus("error", `Classification failed: ${error.message}`);

        // Default-bias rule: when the classifier fails after the retry,
        // fall back to REGULAR_MESSAGE rather than the (heavier)
        // task-chain path. The task-chain planner is expensive and a
        // noisy fallback there means routine queries silently get the
        // 3-6 min pipeline. The positive cex_account_intent and
        // cex_trade_intent short-circuits (Layer 1) are the
        // first-class catch for the high-value trade intents.
        return {
            classification: "REGULAR_MESSAGE",
            confidence: 0.5,
            reasoning: `Classification failed, defaulting to REGULAR_MESSAGE per rule #1: ${error.message}`,
            isCryptoRelated: true,
            phase: "error"
        };
    }
}

/**
 * Extract JSON text from model output: prefer ```json fence, else raw object (models often skip fences).
 */
function extractClassificationJsonText(response: string): string | null {
    const fenced = response.match(/```json\s*([\s\S]*?)\s*```/);
    if (fenced?.[1]?.trim()) {
        return fenced[1].trim();
    }
    const trimmed = response.trim();
    if (trimmed.startsWith("{")) {
        return trimmed;
    }
    for (let start = trimmed.indexOf("{"); start !== -1; start = trimmed.indexOf("{", start + 1)) {
        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let i = start; i < trimmed.length; i++) {
            const ch = trimmed[i];

            if (inString) {
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (ch === "\\") {
                    escaped = true;
                    continue;
                }
                if (ch === "\"") {
                    inString = false;
                }
                continue;
            }

            if (ch === "\"") {
                inString = true;
                continue;
            }

            if (ch === "{") {
                depth++;
                continue;
            }
            if (ch === "}") {
                depth--;
                if (depth === 0) {
                    const candidate = trimmed.slice(start, i + 1);
                    // LLM output can include prose + multiple JSON-looking spans; return the first valid object.
                    try {
                        JSON.parse(candidate);
                        return candidate;
                    } catch {
                        break;
                    }
                }
                if (depth < 0) {
                    break;
                }
            }
        }
    }
    return null;
}

/**
 * Parse LLM response
 */
function parseClassificationResponse(response: string): {
    classification: MessageClassificationType;
    confidence: number;
    reasoning: string;
    isCryptoRelated: boolean;
} {
    const jsonText = extractClassificationJsonText(response);
    if (!jsonText) {
        throw new Error("No JSON format response found");
    }

    const parsed = JSON.parse(jsonText) as {
        classification?: string;
        confidence?: number;
        reasoning?: string;
        isCryptoRelated?: boolean;
    };

    if (!parsed.classification || !['REGULAR_MESSAGE', 'CEX_WORKFLOW_MESSAGE', 'TASK_CHAIN_MESSAGE', 'COMPREHENSIVE_ANALYSIS_MESSAGE', 'MANTLE_WORKFLOW_MESSAGE'].includes(parsed.classification)) {
        throw new Error("Invalid classification type");
    }

    const classification = parsed.classification as MessageClassificationType;

    return {
        classification,
        confidence: Math.max(0, Math.min(1, parsed.confidence || 0.5)),
        reasoning: parsed.reasoning || "No reasoning provided",
        isCryptoRelated: typeof parsed.isCryptoRelated === "boolean" ? parsed.isCryptoRelated : true
    };
}

/**
 * Get display name for classification
 */
function getClassificationDisplayName(classification: MessageClassificationType): string {
    switch (classification) {
        case "REGULAR_MESSAGE":
            return "Regular Message";
        case "CEX_WORKFLOW_MESSAGE":
            return "Exchange Workflow";
        case "MANTLE_WORKFLOW_MESSAGE":
            return "Mantle On-Chain Workflow";
        case "TASK_CHAIN_MESSAGE":
            return "Task Chain Processing";
        case "COMPREHENSIVE_ANALYSIS_MESSAGE":
            return "Comprehensive Analysis";
        default:
            return "Unknown Type";
    }
}

/**
 * Create the LangGraph workflow
 */
function createPrecheckWorkflow() {
    const workflow = new StateGraph(PrecheckState)
        .addNode("initialize", initializeWorkflow)
        .addNode("analyze", analyzeMessage)
        .addNode("classify", classifyWithLLM)

        .addEdge("__start__", "initialize")
        .addEdge("initialize", "analyze")
        // If `analyzeMessage` already produced a deterministic short-circuit
        // classification, skip the LLM call entirely. Otherwise fall through
        // to the LLM classifier.
        .addConditionalEdges("analyze", (state: PrecheckStateType) => {
            return state.phase === "short_circuit" ? "__end__" : "classify";
        })
        .addEdge("classify", "__end__");

    return workflow.compile();
}

/**
 * LangGraph Precheck Service
 */
export class LangGraphPrecheckService {
    private runtime: IAgentRuntime;
    private workflow: ReturnType<typeof createPrecheckWorkflow>;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
        this.workflow = createPrecheckWorkflow();

        elizaLogger.info(`[LangGraphPrecheck] Service initialized`);
    }

    /**
     * Classify message using LangGraph workflow
     */
    async classifyMessage(
        message: Memory
    ): Promise<{
        classification: MessageClassificationType;
        confidence: number;
        reasoning: string;
        isCryptoRelated: boolean;
    }> {
        try {
            // Execute workflow
            const langSmithMetadataEntries = Object.entries({
                runType: "langgraph_precheck",
                agentId: this.runtime.agentId,
                character: this.runtime.character?.name,
                messageId: message.id,
                roomId: message.roomId
            }).filter(([, value]) => value !== undefined && value !== null && value !== "");

            const langSmithMetadata = Object.fromEntries(langSmithMetadataEntries) as Record<string, unknown>;

            const langSmithConfig = buildLangSmithRunnableConfig({
                apiKey: this.runtime.getSetting("LANGCHAIN_API_KEY")
                    ?? this.runtime.getSetting("LANGSMITH_API_KEY")
                    ?? undefined,
                endpoint: this.runtime.getSetting("LANGCHAIN_ENDPOINT")
                    ?? this.runtime.getSetting("LANGSMITH_ENDPOINT")
                    ?? undefined,
                projectName: this.runtime.getSetting("LANGSMITH_PROJECT")
                    ?? this.runtime.getSetting("LANGCHAIN_PROJECT")
                    ?? this.runtime.character?.name
                    ?? undefined,
                runName: message.id
                    ? `message-precheck:${message.id}`
                    : "message-precheck-workflow",
                tags: [
                    "message-precheck",
                    this.runtime.character?.name ? `agent:${this.runtime.character.name}` : undefined
                ].filter((tag): tag is string => typeof tag === "string" && tag.length > 0),
                metadata: langSmithMetadata
            });

            const workflowInput = {
                message,
                runtime: this.runtime
            };

            const result = langSmithConfig
                ? await this.workflow.invoke(workflowInput, langSmithConfig)
                : await this.workflow.invoke(workflowInput);

            elizaLogger.info(`[LangGraphPrecheck] Classification completed in ${Date.now() - result.startTime}ms`);

            return {
                classification: result.classification,
                confidence: result.confidence,
                reasoning: result.reasoning,
                isCryptoRelated: result.isCryptoRelated ?? true
            };

        } catch (error: any) {
            elizaLogger.error(`[LangGraphPrecheck] Workflow failed:`, error);

            return {
                classification: "REGULAR_MESSAGE",
                confidence: 0.5,
                reasoning: `Classification failed, defaulting to REGULAR_MESSAGE per rule #1: ${error.message}`,
                isCryptoRelated: true
            };
        }
    }

    /**
     * Get workflow for debugging
     */
    public getWorkflow() {
        return this.workflow;
    }
}
