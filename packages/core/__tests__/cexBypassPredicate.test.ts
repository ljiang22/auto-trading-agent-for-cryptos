import { describe, it, expect } from "vitest";
import {
    classifyCexIntentClassFromText,
    detectIntentShift,
    intentClassForAction,
    isCexContinuationMemory,
    isShortFollowUpText,
    shouldBypassToCexWorkflow,
} from "../src/utils/cexBypassPredicate";

// F6 — deterministic CEX continuation bypass. Plan §3.6.5 requires a
// negative test that a long, unrelated message during pending approval
// is NOT bypassed. Without this guard, the bypass would re-route any
// short OR long message after a CEX clarification into the CEX handler
// — including a user asking "What's the news on SOL?" while a previous
// trade still has a pending approval.

const AGENT_ID = "agent-1";
const NOW = 1_700_000_000_000;

const CONTINUATION_MEMORY = {
    userId: AGENT_ID,
    createdAt: NOW - 60_000, // 1 min old, comfortably inside the 10-min window
    content: {
        source: "cex_workflow",
        metadata: { cexRequestId: "req-abc" },
    },
};

describe("F6 isShortFollowUpText", () => {
    it("matches the canonical ≤120 char follow-up", () => {
        expect(isShortFollowUpText("0.001")).toBe(true);
        expect(isShortFollowUpText("yes")).toBe(true);
        expect(isShortFollowUpText("继续")).toBe(true);
        expect(isShortFollowUpText("ETH-USDT")).toBe(true);
    });
    it("rejects the empty string", () => {
        expect(isShortFollowUpText("")).toBe(false);
        expect(isShortFollowUpText("   ")).toBe(false);
    });
    it("rejects long unrelated paragraphs", () => {
        const longUnrelated =
            "I was wondering if you could explain how proof of stake compares to proof of work in terms of energy consumption — this paragraph is over 120 chars on purpose to trip the bypass off.";
        expect(longUnrelated.length).toBeGreaterThan(120);
        expect(isShortFollowUpText(longUnrelated)).toBe(false);
    });
});

describe("F6 isCexContinuationMemory", () => {
    it("matches a recent assistant memory tagged source=cex_workflow", () => {
        expect(
            isCexContinuationMemory(CONTINUATION_MEMORY, { agentId: AGENT_ID, nowMs: NOW }),
        ).toBe(true);
    });
    it("rejects an old (>10 min) memory", () => {
        const old = {
            ...CONTINUATION_MEMORY,
            createdAt: NOW - 11 * 60 * 1000,
        };
        expect(isCexContinuationMemory(old, { agentId: AGENT_ID, nowMs: NOW })).toBe(false);
    });
    it("rejects a memory not authored by the agent", () => {
        const userMsg = {
            ...CONTINUATION_MEMORY,
            userId: "some-other-user",
        };
        expect(
            isCexContinuationMemory(userMsg, { agentId: AGENT_ID, nowMs: NOW }),
        ).toBe(false);
    });
    it("rejects a memory whose source is not cex_workflow", () => {
        const regular = {
            ...CONTINUATION_MEMORY,
            content: { source: "regular_message", metadata: {} },
        };
        expect(
            isCexContinuationMemory(regular, { agentId: AGENT_ID, nowMs: NOW }),
        ).toBe(false);
    });
});

describe("F6 shouldBypassToCexWorkflow — composite", () => {
    it("POSITIVE: short follow-up + recent CEX continuation → bypass fires", () => {
        expect(
            shouldBypassToCexWorkflow({
                text: "0.001",
                recentMemories: [CONTINUATION_MEMORY],
                agentId: AGENT_ID,
                nowMs: NOW,
            }),
        ).toBe(true);
    });

    it("NEGATIVE plan §3.6.5: long unrelated message with pending approval → bypass does NOT fire", () => {
        // The reviewer's exact concern: a user typing a long unrelated
        // paragraph during a pending CEX approval. The runtime must NOT
        // misroute this back into the CEX handler.
        const longUnrelated =
            "What is the news on SOL today? I'd like a brief summary of the past 24 hours of price action and any catalysts I should be aware of for the weekend.";
        expect(longUnrelated.length).toBeGreaterThan(120);
        expect(
            shouldBypassToCexWorkflow({
                text: longUnrelated,
                recentMemories: [CONTINUATION_MEMORY],
                agentId: AGENT_ID,
                nowMs: NOW,
            }),
        ).toBe(false);
    });

    it("NEGATIVE: short message without a CEX continuation → no bypass", () => {
        expect(
            shouldBypassToCexWorkflow({
                text: "0.001",
                recentMemories: [],
                agentId: AGENT_ID,
                nowMs: NOW,
            }),
        ).toBe(false);
    });

    it("NEGATIVE: short message + only a STALE continuation (>10 min) → no bypass", () => {
        const stale = {
            ...CONTINUATION_MEMORY,
            createdAt: NOW - 11 * 60 * 1000,
        };
        expect(
            shouldBypassToCexWorkflow({
                text: "0.001",
                recentMemories: [stale],
                agentId: AGENT_ID,
                nowMs: NOW,
            }),
        ).toBe(false);
    });
});

describe("F6-r3 detectIntentShift", () => {
    it("returns null for trivial answer shapes (numeric, yes/no)", () => {
        expect(detectIntentShift("0.001")).toBe(null);
        expect(detectIntentShift("0.001 BTC")).toBe(null);
        expect(detectIntentShift("yes")).toBe(null);
        expect(detectIntentShift("继续")).toBe(null);
        expect(detectIntentShift("ETH-USDT")).toBe(null);
        expect(detectIntentShift("")).toBe(null);
    });

    it("detects fresh trading verbs as intent shifts", () => {
        expect(detectIntentShift("I want to buy some BTC")).toBe("fresh_trading_verb");
        expect(detectIntentShift("sell 0.1 ETH")).toBe("fresh_trading_verb");
        expect(detectIntentShift("cancel my order")).toBe("fresh_trading_verb");
        expect(detectIntentShift("place a market buy")).toBe("fresh_trading_verb");
        expect(detectIntentShift("close my position")).toBe("fresh_trading_verb");
        expect(detectIntentShift("买 0.1 BTC")).toBe("fresh_trading_verb");
    });

    it("detects topic-shift questions", () => {
        expect(detectIntentShift("What is the price of BTC?")).toBe("topic_shift_question");
        expect(detectIntentShift("price?")).toBe("topic_shift_question");
        expect(detectIntentShift("how do I deposit?")).toBe("topic_shift_question");
        expect(detectIntentShift("show me my balance")).toBe("topic_shift_question");
        expect(detectIntentShift("什么时候到账")).toBe("topic_shift_question");
    });

    it("does NOT misclassify size-with-asset as a trading verb", () => {
        // The bare "BTC" after a numeric is the answer-shape regex; it
        // should pass through. The fresh-verb regex requires an explicit
        // verb word (buy/sell/place/etc.) to fire.
        expect(detectIntentShift("0.5 BTC")).toBe(null);
        expect(detectIntentShift("USDT")).toBe(null);
    });

    // Round-6d — non-CEX intents (research / analysis / news / sentiment /
    // technical / on-chain) must decline the CEX bypass. QA root cause:
    // "perform a comprehensive analysis on eth" was bypassed to the CEX
    // handler and refused with "Market data too stale"; "what is current
    // btc price" was answered with "I cannot provide real-time market
    // data with the available tools" (CEX template has no get_price).
    it("detects 'comprehensive analysis on eth' as a non-CEX intent (round-6d)", () => {
        expect(detectIntentShift("perform a comprehensive analysis on eth")).toBe("non_cex_intent");
        expect(detectIntentShift("comprehensive analysis on btc")).toBe("non_cex_intent");
        expect(detectIntentShift("analyze ETH for me")).toBe("non_cex_intent");
        expect(detectIntentShift("research the SOL ecosystem")).toBe("non_cex_intent");
    });

    it("detects sentiment / news / technical / on-chain intents as non-CEX", () => {
        // Note: TOPIC_SHIFT_RE fires first for question-shaped phrasing
        // ("show me…", "?"), which is also a non-CEX signal — either
        // way the bypass declines. The non-CEX classifier kicks in when
        // there's no question shape but the message clearly references
        // research / analysis surfaces.
        expect(detectIntentShift("any breaking news on ETH")).toBe("non_cex_intent");
        expect(detectIntentShift("run technical analysis on solana")).toBe("non_cex_intent");
        expect(detectIntentShift("check on-chain flows for BTC")).toBe("non_cex_intent");
        expect(detectIntentShift("fear and greed today")).toBe("non_cex_intent");
        expect(detectIntentShift("BTC price prediction please")).toBe("non_cex_intent");
        // Question-shaped variants get topic_shift_question first.
        expect(detectIntentShift("any breaking news on ETH?")).toBe("topic_shift_question");
        expect(detectIntentShift("show me btc sentiment for the past week")).toBe("topic_shift_question");
    });

    it("detects zh-CN research / analysis intents as non-CEX", () => {
        expect(detectIntentShift("分析一下 ETH")).toBe("non_cex_intent");
        expect(detectIntentShift("帮我研究 BTC")).toBe("non_cex_intent");
        expect(detectIntentShift("查看链上数据")).toBe("non_cex_intent");
    });

    it("'what is current btc price' is caught by topic-shift (NOT misclassified as non-CEX)", () => {
        // "what" at the start is the topic-shift signal; the non-CEX
        // pattern also matches "price" so either way the bypass declines.
        // Asserting the discriminator order so future refactors stay
        // safe.
        expect(detectIntentShift("what is current btc price")).toBe("topic_shift_question");
    });

    // Round-7 — non-trading questions in a trading-context room must
    // decline the CEX bypass even when phrased as instructions (no `?`,
    // no `what/how`). The user feedback that prompted this: greetings
    // and "full BTC analysis" / "comprehensive analysis on BTC" were
    // sometimes hijacked into the CEX handler when a stale
    // clarification memo sat in the same room.
    it("round-7: comprehensive / full-analysis phrasings decline the bypass", () => {
        expect(detectIntentShift("full btc analysis")).toBe("non_cex_intent");
        expect(detectIntentShift("full btc comprehensive analysis")).toBe("non_cex_intent");
        expect(detectIntentShift("comprehensive btc")).toBe("non_cex_intent");
        expect(detectIntentShift("give me the comprehensive memo for ETH")).toBe("non_cex_intent");
    });

    it("round-7: greetings in a trading context are topic shifts", () => {
        expect(detectIntentShift("hi how are you")).toBe("non_trading_chitchat");
        expect(detectIntentShift("hello")).toBe("non_trading_chitchat");
        expect(detectIntentShift("hey there")).toBe("non_trading_chitchat");
        expect(detectIntentShift("good morning")).toBe("non_trading_chitchat");
        expect(detectIntentShift("你好")).toBe("non_trading_chitchat");
        expect(detectIntentShift("早上好")).toBe("non_trading_chitchat");
        // "thanks" / "thank you" — caught by the THANKS_RE branch.
        expect(detectIntentShift("thanks")).toBe("non_trading_chitchat");
        expect(detectIntentShift("thank you for the help")).toBe("non_trading_chitchat");
        expect(detectIntentShift("谢谢")).toBe("non_trading_chitchat");
    });

    it("round-7: 'define <X>' and momentum/volatility lookups are non-CEX", () => {
        expect(detectIntentShift("define proof of stake")).toBe("non_cex_intent");
        expect(detectIntentShift("definition of TVL")).toBe("non_cex_intent");
        expect(detectIntentShift("BTC volatility past 30 days")).toBe("non_cex_intent");
        expect(detectIntentShift("ETH funding rate this week")).toBe("non_cex_intent");
        expect(detectIntentShift("BTC momentum check")).toBe("non_cex_intent");
        // Chinese sentiment / chain-data signal.
        expect(detectIntentShift("综合一下 BTC")).toBe("non_cex_intent");
    });

    it("round-7: greetings still classify as trading when prefixed to a fresh verb", () => {
        // "hey can you cancel my order" — the FRESH_TRADING_VERB regex
        // runs BEFORE the greeting branch, so `cancel` wins over `hey`.
        expect(detectIntentShift("hey can you cancel my order")).toBe("fresh_trading_verb");
        expect(detectIntentShift("hi please buy 0.01 BTC")).toBe("fresh_trading_verb");
    });

    // Static-eval round (2026-05-21): closing the bypass-trap holes
    // found by scripts/eval-classifier-static.mjs against the fixture.
    it("static-eval: portfolio / risk review / stress test phrasings decline", () => {
        expect(detectIntentShift("Write a complete portfolio risk review for my crypto holdings including stress tests."))
            .toBe("non_cex_intent");
        expect(detectIntentShift("review my crypto portfolio")).toBe("non_cex_intent");
        expect(detectIntentShift("run a stress test on my holdings")).toBe("non_cex_intent");
    });

    it("static-eval: zh-CN report-language phrasings decline", () => {
        expect(detectIntentShift("机构级以太坊季度策略简报")).toBe("non_cex_intent");
        expect(detectIntentShift("跨市场报告")).toBe("non_cex_intent");
        expect(detectIntentShift("完整分析 BTC")).toBe("non_cex_intent");
    });

    it("static-eval: screen / compare / rank / track / RSI / headline decline", () => {
        expect(detectIntentShift("Screen the top 20 coins and identify 3 with strongest setups"))
            .toBe("non_cex_intent");
        expect(detectIntentShift("Compare BTC and ETH performance over 30D"))
            .toBe("non_cex_intent");
        expect(detectIntentShift("RSI on ETH right now")).toBe("non_cex_intent");
        expect(detectIntentShift("Latest ETH headline please")).toBe("non_cex_intent");
        expect(detectIntentShift("Track stablecoin inflows for me")).toBe("non_cex_intent");
    });

    it("static-eval: non-crypto instruments (stocks / forex / gold / ETF) decline", () => {
        expect(detectIntentShift("Plan how to scale into Tesla shares over 5 days"))
            .toBe("non_crypto_instrument");
        expect(detectIntentShift("Build a DCA plan for the S&P 500 ETF over 3 months"))
            .toBe("non_crypto_instrument");
        expect(detectIntentShift("Set up a take-profit ladder on my Apple stock position"))
            .toBe("non_crypto_instrument");
        expect(detectIntentShift("Plan a gold futures rotation over the next month"))
            .toBe("non_crypto_instrument");
        // Crypto-only phrasing still goes through as fresh trading verb
        // (or null if no verb), NOT non_crypto_instrument.
        expect(detectIntentShift("Plan how to scale into ETH over 5 days based on RSI"))
            .not.toBe("non_crypto_instrument");
    });
});

describe("F6-r3 shouldBypassToCexWorkflow with intent-shift guard", () => {
    it("PRODUCTION DEFECT REPRO: 'I want to buy some BTC' after a 'specify size' clarification → bypass declines (was: stale reply loop)", () => {
        expect(
            shouldBypassToCexWorkflow({
                text: "I want to buy some BTC",
                recentMemories: [CONTINUATION_MEMORY],
                agentId: AGENT_ID,
                nowMs: NOW,
            }),
        ).toBe(false);
    });

    it("PRODUCTION DEFECT REPRO: 'I want to trade crypto' after a 'specify size' clarification → bypass declines", () => {
        expect(
            shouldBypassToCexWorkflow({
                text: "I want to trade crypto",
                recentMemories: [CONTINUATION_MEMORY],
                agentId: AGENT_ID,
                nowMs: NOW,
            }),
        ).toBe(false);
    });

    it("legitimate pure-numeric answer still bypasses normally", () => {
        expect(
            shouldBypassToCexWorkflow({
                text: "0.001",
                recentMemories: [CONTINUATION_MEMORY],
                agentId: AGENT_ID,
                nowMs: NOW,
            }),
        ).toBe(true);
    });

    it("a question like 'price?' declines bypass (was: hijacked by stale clarification)", () => {
        expect(
            shouldBypassToCexWorkflow({
                text: "price?",
                recentMemories: [CONTINUATION_MEMORY],
                agentId: AGENT_ID,
                nowMs: NOW,
            }),
        ).toBe(false);
    });

    // Round-6d — full QA repros for the comprehensive-analysis + price
    // hijack defects.
    it("ROUND-6d REPRO: 'perform a comprehensive analysis on eth' is NOT bypassed", () => {
        expect(
            shouldBypassToCexWorkflow({
                text: "perform a comprehensive analysis on eth",
                recentMemories: [CONTINUATION_MEMORY],
                agentId: AGENT_ID,
                nowMs: NOW,
            }),
        ).toBe(false);
    });

    it("ROUND-6d REPRO: 'what is current btc price' is NOT bypassed", () => {
        expect(
            shouldBypassToCexWorkflow({
                text: "what is current btc price",
                recentMemories: [CONTINUATION_MEMORY],
                agentId: AGENT_ID,
                nowMs: NOW,
            }),
        ).toBe(false);
    });

    it("ROUND-6d: 'show me ETH sentiment' is NOT bypassed", () => {
        expect(
            shouldBypassToCexWorkflow({
                text: "show me ETH sentiment for the past week",
                recentMemories: [CONTINUATION_MEMORY],
                agentId: AGENT_ID,
                nowMs: NOW,
            }),
        ).toBe(false);
    });
});

// F6-r4 — intent-class match guard. Tightens the bypass beyond
// "detectIntentShift". Adjacent turns must have COMPATIBLE intent
// classes; a new buy/sell during a stale cancel-clarification must
// not be bypassed even if it would have otherwise looked like a
// trading verb (caught by detectIntentShift), and equally importantly
// a new cancel during a stale buy-clarification must decline.
describe("F6-r4 classifyCexIntentClassFromText", () => {
    it("classifies cancel verbs as 'cancel' (EN + zh-CN)", () => {
        expect(classifyCexIntentClassFromText("cancel my order")).toBe("cancel");
        expect(classifyCexIntentClassFromText("cancel order 123")).toBe("cancel");
        expect(classifyCexIntentClassFromText("撤销那个订单")).toBe("cancel");
        expect(classifyCexIntentClassFromText("取消订单")).toBe("cancel");
    });

    it("classifies buy/sell/place verbs as 'create' (EN + zh-CN)", () => {
        expect(classifyCexIntentClassFromText("buy 0.001 BTC")).toBe("create");
        expect(classifyCexIntentClassFromText("sell 0.01 ETH")).toBe("create");
        expect(classifyCexIntentClassFromText("place a limit")).toBe("create");
        expect(classifyCexIntentClassFromText("I want to short")).toBe("create");
        expect(classifyCexIntentClassFromText("买 0.1 BTC")).toBe("create");
        expect(classifyCexIntentClassFromText("做多")).toBe("create");
    });

    it("classifies amend/modify verbs as 'modify' (EN + zh-CN)", () => {
        expect(classifyCexIntentClassFromText("amend order 123 to 50000")).toBe("modify");
        expect(classifyCexIntentClassFromText("modify my order")).toBe("modify");
        expect(classifyCexIntentClassFromText("修改订单价格")).toBe("modify");
    });

    it("returns null for pure answer shapes (no class can be inferred)", () => {
        expect(classifyCexIntentClassFromText("0.001")).toBe(null);
        expect(classifyCexIntentClassFromText("yes")).toBe(null);
        expect(classifyCexIntentClassFromText("BTC-USDT")).toBe(null);
        expect(classifyCexIntentClassFromText("60000")).toBe(null);
        expect(classifyCexIntentClassFromText("")).toBe(null);
    });
});

describe("F6-r4 intentClassForAction", () => {
    it("maps canonical action names to classes", () => {
        expect(intentClassForAction("cancel_order")).toBe("cancel");
        expect(intentClassForAction("create_order")).toBe("create");
        expect(intentClassForAction("amend_order")).toBe("modify");
        expect(intentClassForAction("edit_order")).toBe("modify");
    });
    it("returns null for read-only actions (they shouldn't gate continuations)", () => {
        expect(intentClassForAction("get_balance")).toBe(null);
        expect(intentClassForAction("get_orders")).toBe(null);
        expect(intentClassForAction("get_fills")).toBe(null);
        expect(intentClassForAction(undefined)).toBe(null);
        expect(intentClassForAction(null)).toBe(null);
    });
});
