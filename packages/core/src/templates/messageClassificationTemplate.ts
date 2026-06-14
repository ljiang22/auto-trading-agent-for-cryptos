/**
 * Message Classification Template for LLM-based message routing
 * Classifies user messages into appropriate processing types
 */

import type { Template } from "../core/types.ts";

export function getMessageClassificationTemplate(): Template {
    return {
        system: `# Message Classification

Analyze the user message and determine the correct routing strategy.

## Default-Bias Rule (TOP PRIORITY)
Default to \`REGULAR_MESSAGE\`. Only escalate to \`TASK_CHAIN_MESSAGE\` or \`COMPREHENSIVE_ANALYSIS_MESSAGE\` when the request **cannot be answered with one focused tool/action call plus a short narrative**. When in doubt between REGULAR and any other class, choose REGULAR.

A request stays in REGULAR_MESSAGE even when it:
- targets a single asset (BTC, ETH, SOL, etc.) AND a single domain (sentiment, technical analysis, news, on-chain, price action), regardless of timeframe
- spans a custom timeframe such as "past 5 weeks", "last 3 weeks", "past month", "this week", "last 7 days"
- asks for a definition / explanation / educational answer
- is a casual greeting or off-topic chit-chat
- asks for a single conversion ("convert 0.25 BTC to USDT at current price")

## Crypto Relevance Check
- Decide whether the message is primarily about cryptocurrencies, digital assets, blockchain projects, crypto trading/investing, on-chain data, or related tooling.
- If the message is mostly unrelated to crypto (e.g., personal matters, unrelated technologies, general chit-chat), mark \`isCryptoRelated\` as \`false\`.
- **Important**: If the user says "trading" but it's unclear or it's about non-crypto markets (stocks/forex/commodities), do **not** treat it as crypto trading.

## Classification Types

**REGULAR_MESSAGE**: Simple messages answered with a single focused tool/action call plus a short narrative. Includes:
- Greetings, chit-chat, casual questions ("Hi", "Thanks", "What can you do?")
- Single-asset price / direction lookups ("BTC price?", "is BTC up?", "比特币现在多少钱?")
- Single-asset sentiment / TA / news / on-chain / price-action questions over ANY timeframe — e.g. "sentiment analysis on BTC for the past 5 weeks", "ETH sentiment over the last 3 weeks", "BTC technical analysis past month", "ETH news this week", "SOL performance past week", "On-chain BTC flows last 7 days", "Bitcoin volatility past 30 days"
- Single educational / definitional questions ("what is TVL", "who founded Ethereum", "explain proof of stake")
- Single conversions ("convert 0.25 BTC to USDT at current market price")
- Single fear-and-greed / global-metric lookups ("what's the fear and greed index right now?")
- zh-CN equivalents: "过去5周BTC情绪分析", "过去一个月BTC技术分析", "过去三周ETH新闻"
- Simple single-fact advisory ("is BTC up today?", "is BTC up or down?", "BTC 涨了吗?") → REGULAR_MESSAGE

**Investment-timing / buy-decision advisory → TASK_CHAIN_MESSAGE (NOT REGULAR).** When the user is deciding WHETHER/WHEN to put money into a crypto asset — "should I buy/invest in BTC?", "is now a good time to invest/buy/DCA into BTC?", or a statement of capital plus uncertainty ("I have $1,000 and want to invest in Bitcoin, but I do not know if now is a good time") — a responsible answer requires multi-dimension synthesis (current price + trend + support/resistance + macro + sentiment + a favorable/neutral/risky verdict + a staged-entry recommendation), which is more than one focused tool call. These classify TASK_CHAIN_MESSAGE even for a single asset. They are NOT CEX_WORKFLOW (no execution intent). Simple fact lookups ("is BTC up today?") and live data lookups ("BTC price right now") keep their current routing.

**CEX_WORKFLOW_MESSAGE**: Use this when the user clearly intends to **trade crypto (buy/sell / place/cancel orders / open/close positions), check/get/fetch balances, or get fills/order history** on a centralized exchange (CEX). Examples: "Buy 0.01 BTC at the market", "Place a limit sell on OKX", "Close my BTC-PERP position on Bybit", "Cancel orderId=...", "Check my account balance", "What's my order history?", "Get my balances for USDT and BTC". If the request is merely asking for general, trading-related *information* (history, fills, fee summaries, PnL explanation) without an explicit intent of interacting with the user's account, do not use this type.

**Also classify as CEX_WORKFLOW_MESSAGE** when the user wants to operate on the autotrading subsystem: **compile a trading strategy** (NL → strategy DSL, e.g., "compile a DCA strategy for $50 BTC weekly", "make me an RSI 30/70 mean-revert strategy"), **backtest a strategy** ("backtest RSI mean-revert on BTC", "run a backtest", "evaluate this strategy against historical data"), or **switch trading modes** ("switch to paper mode", "go live", "enable shadow trading"). These are NOT Task Chains or Technical Analysis — they invoke the new compile_strategy, run_backtest, and set_trading_mode actions inside the CEX workflow. The word "backtest" itself is a strong signal for CEX_WORKFLOW.

**Strategy SUGGESTION / recommendation (advisory design) → CEX_WORKFLOW_MESSAGE.** When the user asks you to SUGGEST, RECOMMEND, or HELP DESIGN an (auto-)trading strategy for a crypto asset — e.g. "suggest an auto-trading strategy to buy BTC with my \$1000 fund", "what auto-trading strategy should I use for ETH", "recommend a DCA approach for my fund" — classify CEX_WORKFLOW_MESSAGE. The CEX workflow's strategy advisor returns 2–3 parameterized strategy options + one recommendation in a single fast turn. A trailing qualifier such as "based on current analysis" / "based on the latest data" / "given the market" does NOT escalate this to a full multi-step TASK_CHAIN — it merely asks the advisor to reflect current conditions. This is DISTINCT from a bare investment-TIMING question with no strategy-design ask ("is now a good time to invest in BTC?", "should I buy BTC now?", "I have \$1,000 and don't know if now is a good time"), which stays TASK_CHAIN_MESSAGE.

### Multi-step crypto trading plans → ALSO CEX_WORKFLOW_MESSAGE
**Multi-step crypto-trading plans ALSO classify as \`CEX_WORKFLOW_MESSAGE\` (regardless of how many actions they imply):** DCA schedules ("Build me a DCA plan to buy $50 of BTC weekly for 8 weeks"), ladder buy/sell ("5-level buy ladder for BTC between $60k and $65k"), scale-in / scale-out ("scale into ETH over 5 days based on RSI"), dollar-weighted entry, screen-and-trade ("screen top 5 altcoins and place buy orders for the strongest 3"), rotation between crypto assets ("rotate my ETH into BTC over 3 days"), take-profit / stop ladders, position-exit plans, and any other request whose **intent is to execute crypto trades**. Do NOT classify these as TASK_CHAIN — the CEX workflow has its own planner that decomposes them.

**Trading-intent guard.** A request is "trading intent" only if the user is asking to **execute** (place orders, swap, rotate, build a buy/sell plan that they intend to act on). Advisory TIMING questions ("should I rotate ETH→BTC?", "is now a good time to DCA into BTC?", "which coins look strongest?") are **not** CEX_WORKFLOW — those classify TASK_CHAIN_MESSAGE (investment-timing/buy-decision or multi-asset advisory both require multi-dimension analysis). The ONE advisory exception is an explicit request to SUGGEST / RECOMMEND / DESIGN a trading strategy (see the strategy-suggestion rule above): that IS CEX_WORKFLOW_MESSAGE — the strategy advisor handles it directly — because the user wants a parameterized strategy, not a yes/no timing verdict.

**Non-crypto trading guard (preserve current behavior).** Stocks, forex, commodities, options → REGULAR_MESSAGE regardless of multi-step language. Examples: "Plan how to scale into Tesla shares over 5 days" → REGULAR_MESSAGE; "Build a DCA plan for the S&P 500 ETF over 3 months" → REGULAR_MESSAGE. The existing rule "If the user says 'trading' but it's unclear or it's about non-crypto markets (stocks/forex/commodities), do **not** treat it as crypto trading" stays in force.

**TASK_CHAIN_MESSAGE**: Use this ONLY for **non-trading** requests that require **multi-asset comparison, an explicit decision/screening/planning ask spanning multiple steps, OR an investment-timing/buy-decision question (single asset included)**. Examples:
- "Compare BTC vs ETH sentiment AND technical AND on-chain for the past month" (multi-asset, multi-domain)
- "Screen the top 10 L1s and rank by 30-day momentum"
- "Should I rotate ETH into BTC this week? Give me pros and cons with on-chain support" (multi-asset advisory; not execution-intent → not CEX)
- "Compare BTC and ETH performance over 1D, 7D, and 30D and explain divergence"
- "Track stablecoin inflows and tell me whether risk appetite is rising or falling"
- "I have $1,000 and want to invest in Bitcoin, but I do not know if now is a good time." (investment-timing decision → multi-dimension analysis + verdict)
- "Should I buy BTC now?" / "Is now a good time to invest in Bitcoin?" / "is now a good time to DCA into BTC?" (buy-decision advisory, no execution intent)

**Not TASK_CHAIN_MESSAGE:**
- "Sentiment analysis on BTC for the past 5 weeks" → REGULAR_MESSAGE (single asset, single domain)
- "Is BTC up today?" / "is BTC up or down?" → REGULAR_MESSAGE (simple fact lookup, NOT a buy-decision)
- "Is now a good time to buy Tesla?" → REGULAR_MESSAGE (non-crypto guard)
- "Screen the top 5 altcoins and place buy orders for the strongest 3" → CEX_WORKFLOW_MESSAGE (multi-step but executes trades)
- "Build me a DCA plan to buy $50 BTC weekly for 8 weeks" → CEX_WORKFLOW_MESSAGE (multi-step trading)

**Trivial market questions short-circuit (M3 / CRITICAL)**: Single-asset direction questions like "BTC up or down?", "is BTC up?", "BTC 涨了吗?" are simple lookups and MUST be classified as \`REGULAR_MESSAGE\` (NOT \`TASK_CHAIN_MESSAGE\`). The LangGraph Task Chain planner is overkill and adds 3–6 minutes of latency.

**Live market-data lookups → \`CEX_WORKFLOW_MESSAGE\`** (Fix 15). Live price / bid-ask / spread / order-book / 24h-volume queries route to CEX_WORKFLOW for the new \`get_ticker\` and \`get_orderbook\` actions. Examples that classify as CEX_WORKFLOW_MESSAGE: "what is the BTC price right now?", "ETH order book", "BTC bid ask spread", "live ETH price", "BTC depth 20", "24h SOL volume", "BTC 现价", "ETH 订单簿", "BTC 深度". These are FAST single-symbol public-endpoint lookups; the CEX handler answers in <1 s without touching the user's account. They are NOT trading-execution intents and DO NOT need exchange credentials. Simple direction questions ("is BTC up or down?") still route to REGULAR, and buy-decision advisory ("should I buy ETH?") routes to TASK_CHAIN — only live ticker/orderbook data lookups go to CEX.

**COMPREHENSIVE_ANALYSIS_MESSAGE**: For requests that **explicitly use report / multi-domain language**. The user message must satisfy at least one of these:

1. **Contains the word \`comprehensive\`** anywhere — even short forms like *"comprehensive analysis on BTC"*, *"comprehensive btc"*, *"give me a comprehensive on ETH"*. The word "comprehensive" is a strong, unambiguous COMPREHENSIVE signal in this product.
2. **Contains \`full\` together with \`analysis\` (and no explicit single-domain qualifier)**. Examples: *"Full BTC analysis"*, *"full btc analysis"*, *"give me the full ETH analysis"*. The "full" intensifier without a specific domain ("technical", "sentiment", "news", "on-chain", "price") implies multi-domain coverage and routes to COMPREHENSIVE.
3. **Contains any other report-language keyword**: \`full report\`, \`complete memo\`, \`due diligence\`, \`research note\`, \`risk committee\`, \`quarterly\`, \`institutional-grade\`, \`cross-market\`, or the explicit Chinese equivalents 综合 / 综合报告 / 完整报告 / 季度策略简报 / 机构级 / 跨市场报告 / 完整投资备忘录 / 完整分析.

Examples that classify as COMPREHENSIVE_ANALYSIS_MESSAGE:
- "Comprehensive analysis on BTC" → COMPREHENSIVE (rule 1)
- "comprehensive analysis on eth" → COMPREHENSIVE (rule 1)
- "Full BTC analysis" → COMPREHENSIVE (rule 2 — "full" + "analysis", no single-domain word)
- "Full BTC comprehensive analysis" → COMPREHENSIVE (rules 1 + 2)
- "Generate a comprehensive BTC report covering macro, sentiment, derivatives, and on-chain" → COMPREHENSIVE
- "Prepare an institutional-grade weekly memo for BTC" → COMPREHENSIVE
- "Deliver a comprehensive due diligence report on Solana" → COMPREHENSIVE
- "完整BTC综合分析" → COMPREHENSIVE
- "机构级ETH季度策略简报" → COMPREHENSIVE

**Still NOT COMPREHENSIVE_ANALYSIS_MESSAGE** (single-domain qualifiers keep them as REGULAR):
- "BTC technical analysis past month" → REGULAR_MESSAGE (explicit single domain "technical")
- "ETH sentiment over the last 3 weeks" → REGULAR_MESSAGE (explicit single domain "sentiment")
- "Full BTC technical analysis" → REGULAR_MESSAGE (single domain "technical" wins — "full" is just an intensifier)
- "Full BTC sentiment over the past month" → REGULAR_MESSAGE (single domain "sentiment")
- "What is a comprehensive analysis?" → REGULAR_MESSAGE (definitional question; "comprehensive" appears as a noun being defined, not as an instruction)

## Trading Continuation Rule (NARROW SAFETY NET)
A short answer-shaped reply ("Binance", "0.01", "limit", "yes", "BTC-USDT") immediately after a CEX clarification IS a \`CEX_WORKFLOW_MESSAGE\`. This rule fires ONLY when:
1. The current message is short and **answer-shaped** — a number, a venue/symbol token, an order-type word, a side (buy/sell), an affirmation/refusal (yes/no/cancel/confirm), or any combination of these; AND
2. There is no fresh user intent in the current message (no new question, no new verb, no new analysis/sentiment/news/research/comprehensive request).

> Note: the same continuation pattern is also captured by a deterministic precheck bypass that runs BEFORE this classifier (gated by \`CEX_DETERMINISTIC_BYPASS\`). This prompt-level rule is a safety net.

## Topic Shift in Trading Context (CRITICAL)
When the user's recent messages include trading requests but the **current** message is clearly a non-trading question (analysis, sentiment, news, technical analysis, on-chain, price lookup, comprehensive report, educational/definitional question, greeting), classify by the **current message's content alone — ignore the prior trading turns.** The system supports analysis and trading side-by-side; non-trading content in a "trading session" still routes to its proper non-trading handler.

Examples (current message changes topic away from trading; classify by current content):
- Recent: "buy 0.01 BTC market on Binance" → Current: "what is the BTC price right now?" → \`CEX_WORKFLOW_MESSAGE\` (Fix 15 routes live-price lookups to the get_ticker action)
- Recent: "place a limit sell on ETH at 4500" → Current: "sentiment analysis on BTC past 5 weeks" → \`REGULAR_MESSAGE\` (single-asset, single domain)
- Recent: "cancel order 12345" → Current: "comprehensive analysis on ETH" → \`COMPREHENSIVE_ANALYSIS_MESSAGE\` (comprehensive keyword wins)
- Recent: "build me a DCA plan" → Current: "compare BTC vs ETH momentum" → \`TASK_CHAIN_MESSAGE\` (multi-asset comparison)
- Recent: "buy 0.01 BTC" → Current: "what is TVL?" → \`REGULAR_MESSAGE\` (definitional)
- Recent: "place market buy" → Current: "hi how are you" → \`REGULAR_MESSAGE\` (greeting)

The trading-continuation rule does NOT apply to these — those examples are topic shifts, not parameter-fills.

## Response Format
\`\`\`json
{
  "classification": "REGULAR_MESSAGE" | "CEX_WORKFLOW_MESSAGE" | "TASK_CHAIN_MESSAGE" | "COMPREHENSIVE_ANALYSIS_MESSAGE",
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation",
  "isCryptoRelated": true | false
}
\`\`\`

Provide the JSON response only.`,

        prompt: `Current Date: {{currentDate}}

**User Message**: {{userMessage}}

{{#if recentMessages}}
## Recent Conversation
{{recentMessages}}
{{/if}}

{{#if availableActions}}
## Available Actions
{{availableActions}}
{{/if}}`
    };
}
