import { describe, expect, it } from "vitest";
import {
    SHORT_CIRCUIT_PATTERNS,
    evaluateShortCircuit,
} from "../src/handlers/langGraphPrecheck";

describe("Pre-LLM short-circuit cascade", () => {
    it("exports all expected patterns in deterministic order", () => {
        const names = SHORT_CIRCUIT_PATTERNS.map((p) => p.name);
        // Positive CEX rules come FIRST so personal-account / trade
        // intent never falls into a REGULAR-routing rule with a
        // leaky guard, and never depends on the (occasionally flaky)
        // LLM classifier as the single point of routing truth.
        expect(names[0]).toBe("cex_account_intent");
        expect(names[1]).toBe("cex_asset_list_intent");
        expect(names[2]).toBe("cex_trade_intent");
        expect(names).toEqual([
            "cex_account_intent",
            // Fix 8 — user-editable asset allowlist + blocklist.
            "cex_asset_list_intent",
            "cex_trade_intent",
            // Fix 15 — live ticker / order-book intent (sits BETWEEN
            // cex_trade_intent and price_or_direction_lookup so live-price
            // queries route to the get_ticker action instead of falling
            // through to the REGULAR price-lookup rule).
            "cex_market_data_intent",
            "price_or_direction_lookup",
            "price_or_direction_lookup_zh",
            "definitional",
            "trivial_greeting_or_affirmation",
        ]);
    });

    it("handles empty / whitespace input safely", () => {
        expect(evaluateShortCircuit("")).toBeNull();
        expect(evaluateShortCircuit("   ")).toBeNull();
        expect(evaluateShortCircuit(undefined as unknown as string)).toBeNull();
    });
});

describe("cex_account_intent → CEX_WORKFLOW_MESSAGE", () => {
    const expectCex = (msg: string) => {
        const v = evaluateShortCircuit(msg);
        expect(v).not.toBeNull();
        expect(v?.name).toBe("cex_account_intent");
        expect(v?.classification).toBe("CEX_WORKFLOW_MESSAGE");
    };

    it("the 2026-05-21 production bug repro — 'what is the my account balance'", () => {
        // The typo `the my` was slipping past the definitional negative
        // lookahead and hitting the REGULAR short-circuit. Now it routes
        // to CEX via the positive intent matcher (defense in depth).
        expectCex("what is the my account balance");
    });

    it("vanilla 'what is my account balance'", () => {
        expectCex("what is my account balance");
    });

    it("'show me my balance on binance'", () => {
        expectCex("show me my balance on binance");
    });

    it("'check my open orders'", () => {
        expectCex("check my open orders");
    });

    it("'list my fills today'", () => {
        expectCex("list my fills today");
    });

    it("'open orders on coinbase'", () => {
        expectCex("open orders on coinbase");
    });

    it("'do i have any BTC'", () => {
        expectCex("do i have any BTC");
    });

    it("'how much do i have in eth'", () => {
        expectCex("how much do i have in eth");
    });

    it("'what is mine in btc'", () => {
        expectCex("what is mine in btc");
    });

    it("zh-CN: '我的账户余额'", () => {
        expectCex("我的账户余额");
    });

    it("zh-CN: '查看我的订单'", () => {
        expectCex("查看我的订单");
    });

    it("zh-CN: '挂单'", () => {
        expectCex("挂单");
    });

    // Fix 6 — get_trading_mode question patterns must route to CEX so
    // the read action can answer them instead of falling through to a
    // generic subscription/tier reply.
    it("'what is my current trading mode?'", () => {
        expectCex("what is my current trading mode?");
    });

    it("'my trading mode'", () => {
        expectCex("my trading mode");
    });

    it("'current mode'", () => {
        expectCex("current mode");
    });

    it("'am I in paper or live?'", () => {
        expectCex("am I in paper or live?");
    });

    it("'am i on shadow'", () => {
        expectCex("am i on shadow");
    });

    it("'am i using paper'", () => {
        expectCex("am i using paper");
    });

    it("zh-CN: '当前模式'", () => {
        expectCex("当前模式");
    });

    it("zh-CN: '什么模式'", () => {
        expectCex("什么模式");
    });

    it("zh-CN: '交易模式'", () => {
        expectCex("交易模式");
    });

    it("'what is the price of BTC?' must NOT match cex_account_intent (Fix 15 routes via cex_market_data_intent → CEX)", () => {
        const v = evaluateShortCircuit("what is the price of BTC?");
        expect(v).not.toBeNull();
        // Pre-Fix 15: this routed to REGULAR via price_or_direction_lookup.
        // Post-Fix 15: the new cex_market_data_intent pattern (which sits
        // BEFORE price_or_direction_lookup) catches the "price of" form and
        // routes to CEX so the new get_ticker action can answer
        // deterministically. The cex_account_intent rule (which is what
        // this assertion guards against) still must NOT match.
        expect(v?.name).not.toBe("cex_account_intent");
        expect(v?.classification).toBe("CEX_WORKFLOW_MESSAGE");
    });
});

describe("definitional → REGULAR_MESSAGE (after the fix)", () => {
    const expectDefinitional = (msg: string) => {
        const v = evaluateShortCircuit(msg);
        expect(v).not.toBeNull();
        expect(v?.classification).toBe("REGULAR_MESSAGE");
        // Could be either definitional OR trivial_greeting (e.g. "hi")
        // — what matters is REGULAR_MESSAGE classification.
    };

    it("'what is bitcoin'", () => {
        expectDefinitional("what is bitcoin");
    });

    it("'what is staking'", () => {
        expectDefinitional("what is staking");
    });

    it("'define proof of work'", () => {
        expectDefinitional("define proof of work");
    });

    it("'explain how DCA works'", () => {
        expectDefinitional("explain how DCA works");
    });

    it("'who founded bitcoin'", () => {
        expectDefinitional("who founded bitcoin");
    });

    it("the bug repro must NOT short-circuit to REGULAR", () => {
        // The whole point of this PR: this query was hitting the
        // `definitional` REGULAR short-circuit. After the fix, the
        // positive CEX-intent matcher catches it FIRST and routes
        // to CEX; even if order changed, the definitional rule's
        // negative lookahead also now excludes "the my X" forms.
        const v = evaluateShortCircuit("what is the my account balance");
        expect(v?.classification).not.toBe("REGULAR_MESSAGE");
    });
});

describe("price_or_direction_lookup → REGULAR_MESSAGE", () => {
    const expectRegular = (msg: string) => {
        const v = evaluateShortCircuit(msg);
        expect(v).not.toBeNull();
        expect(v?.classification).toBe("REGULAR_MESSAGE");
    };

    // After Fix 15, "what is the btc price" (a bare price-lookup
    // shape) STILL routes to REGULAR via price_or_direction_lookup
    // — the cex_market_data_intent rule requires the explicit
    // "price of <X>" / "current price" / "how much is" / "<X>
    // trading at" / "right now" markers. A naked "<X> price" stays
    // in REGULAR (the existing UX answers it via the news/general
    // path; CEX gets the explicit "live price" / "current price"
    // calls).
    it("'what is the btc price'", () => {
        expectRegular("what is the btc price");
    });

    it("'is BTC up or down?' (advisory direction)", () => {
        // Direction questions are still REGULAR per the spec — only
        // live-price/orderbook lookups route to CEX.
        const v = evaluateShortCircuit("is BTC up or down?");
        // Either matches price_or_direction_lookup (REGULAR) or no
        // short-circuit (defers to LLM); both are acceptable. The
        // assertion guards only against CEX_WORKFLOW_MESSAGE.
        if (v !== null) expect(v.classification).toBe("REGULAR_MESSAGE");
    });

    it("personal-account variant must NOT match — 'what is my account balance on btc'", () => {
        // The price-lookup rule's negative lookahead must continue to
        // exclude personal-account queries that happen to mention BTC.
        // This query should route to CEX via the cex_account_intent
        // matcher, not to REGULAR via price-lookup.
        const v = evaluateShortCircuit("what is my account balance on btc");
        expect(v?.classification).toBe("CEX_WORKFLOW_MESSAGE");
    });
});

describe("cex_market_data_intent → CEX_WORKFLOW_MESSAGE (Fix 15)", () => {
    const expectMarketData = (msg: string) => {
        const v = evaluateShortCircuit(msg);
        expect(v).not.toBeNull();
        expect(v?.name).toBe("cex_market_data_intent");
        expect(v?.classification).toBe("CEX_WORKFLOW_MESSAGE");
    };

    it("'what is the BTC price right now?'", () => {
        expectMarketData("what is the BTC price right now?");
    });

    it("'ETH order book'", () => {
        expectMarketData("ETH order book");
    });

    it("'BTC orderbook'", () => {
        expectMarketData("BTC orderbook");
    });

    it("'BTC bid ask spread'", () => {
        expectMarketData("BTC bid ask spread");
    });

    it("'current price of BTC'", () => {
        expectMarketData("current price of BTC");
    });

    it("'how much is solana right now'", () => {
        expectMarketData("how much is solana right now");
    });

    it("'live BTC price'", () => {
        expectMarketData("live BTC price");
    });

    it("'24h ETH volume'", () => {
        expectMarketData("24h ETH volume");
    });

    it("zh-CN '现价'", () => {
        expectMarketData("现价");
    });

    it("zh-CN 'BTC 多少钱'", () => {
        expectMarketData("BTC 多少钱");
    });

    it("zh-CN '订单簿'", () => {
        expectMarketData("订单簿");
    });

    it("zh-CN '深度'", () => {
        expectMarketData("深度");
    });

    it("does NOT match an analysis verb — 'review my BTC portfolio price' (analysis veto)", () => {
        // ANALYSIS_INTENT_RE vetoes the market-data pattern when an
        // analysis verb appears. Falls through to the LLM classifier.
        const v = evaluateShortCircuit("review my BTC portfolio price");
        if (v !== null) {
            // Could match the personal-account rule first; the assertion
            // is just that cex_market_data_intent does NOT fire.
            expect(v.name).not.toBe("cex_market_data_intent");
        }
    });

    it("does NOT match a non-crypto instrument — 'live Tesla price' (non-crypto veto)", () => {
        const v = evaluateShortCircuit("live Tesla price");
        // The non-crypto guard vetoes the pattern; the LLM classifier
        // should send this to REGULAR.
        if (v !== null) expect(v.name).not.toBe("cex_market_data_intent");
    });
});

describe("trivial_greeting_or_affirmation → REGULAR_MESSAGE", () => {
    it("'hi'", () => {
        expect(evaluateShortCircuit("hi")?.classification).toBe("REGULAR_MESSAGE");
    });

    it("'thanks!'", () => {
        expect(evaluateShortCircuit("thanks!")?.classification).toBe("REGULAR_MESSAGE");
    });

    it("'ok.'", () => {
        expect(evaluateShortCircuit("ok.")?.classification).toBe("REGULAR_MESSAGE");
    });
});

describe("cex_trade_intent → CEX_WORKFLOW_MESSAGE", () => {
    const expectCex = (msg: string) => {
        const v = evaluateShortCircuit(msg);
        expect(v).not.toBeNull();
        expect(v?.classification).toBe("CEX_WORKFLOW_MESSAGE");
    };

    it("the 2026-05-21 production bug repro — multi-order place", () => {
        // gemini-2.5-flash exhausted its thinking budget on this
        // input and returned no JSON → fallback routed REGULAR →
        // web search ran instead of trading. With cex_trade_intent
        // in place, the message bypasses the LLM classifier entirely.
        expectCex(
            "help me place a 10 usdt buy order for btc/usdt with 62000 and 10 usdt buy order for eth/usdt with 2100",
        );
    });

    it("'buy 0.01 BTC at market'", () => {
        expectCex("buy 0.01 BTC at market");
    });

    it("'sell my BTC position'", () => {
        // Matches cex_trade_intent OR cex_account_intent — both are CEX.
        expectCex("sell my BTC position");
    });

    it("'place a limit sell on Binance'", () => {
        expectCex("place a limit sell on Binance");
    });

    it("'please cancel order 12345'", () => {
        expectCex("please cancel order 12345");
    });

    it("'cancel all my orders'", () => {
        expectCex("cancel all my orders");
    });

    it("'swap BTC for ETH' falls through to LLM classifier (ambiguous verb)", () => {
        // `swap` was intentionally removed from cex_trade_intent's
        // verb set because of false-positive risk on non-crypto
        // contexts. The LLM classifier handles it correctly.
        expect(evaluateShortCircuit("swap BTC for ETH")).toBeNull();
    });

    it("'trade smarter' falls through (Q385 false-positive guard)", () => {
        // The original cex_trade_intent draft matched the verb `trade`
        // and over-fired on "Help me trade smarter". `trade` removed.
        expect(evaluateShortCircuit("Help me trade smarter")).toBeNull();
    });

    it("'help me buy 50 USDT worth of ETH'", () => {
        expectCex("help me buy 50 USDT worth of ETH");
    });

    it("'I want to buy more BTC'", () => {
        expectCex("I want to buy more BTC");
    });

    it("'i'd like to place a market buy'", () => {
        expectCex("i'd like to place a market buy");
    });

    it("'let me sell some ETH'", () => {
        expectCex("let me sell some ETH");
    });

    it("'liquidate my BTC position'", () => {
        expectCex("liquidate my BTC position");
    });

    it("zh-CN: '买 0.01 BTC'", () => {
        expectCex("买 0.01 BTC");
    });

    it("zh-CN: '帮我下单'", () => {
        expectCex("帮我下单");
    });

    it("zh-CN: '取消订单'", () => {
        expectCex("取消订单");
    });

    it("must NOT match opinion question 'should I buy more BTC?'", () => {
        // Anchored to ^ — verb has to come early; "should" doesn't.
        const v = evaluateShortCircuit("should I buy more BTC?");
        expect(v).toBeNull();
    });

    it("must NOT match 'do you think I should sell?'", () => {
        const v = evaluateShortCircuit("do you think I should sell?");
        expect(v).toBeNull();
    });

    it("must NOT match 'what is a buy wall?'", () => {
        // Definitional question containing 'buy' — should hit
        // the definitional rule and route REGULAR, not CEX.
        const v = evaluateShortCircuit("what is a buy wall?");
        expect(v?.classification).toBe("REGULAR_MESSAGE");
    });

    it("must NOT match 'sell my Tesla stock' (non-crypto instrument)", () => {
        // The excludeIf list catches this; CEX workflow only trades
        // crypto. The LLM classifier handles non-crypto-trading
        // requests with a polite REGULAR decline.
        expect(evaluateShortCircuit("sell my Tesla stock")).toBeNull();
    });

    it("must NOT match 'analyze whether I should sell BTC' (analysis intent)", () => {
        expect(
            evaluateShortCircuit("analyze whether I should sell BTC"),
        ).toBeNull();
    });
});

describe("cex_account_intent EXCLUSIONS — analysis verbs + non-crypto instruments", () => {
    it("excludes 'portfolio risk review for my crypto holdings' (analysis intent)", () => {
        // Q234 from the static-eval fixture. The cex_account_intent
        // regex matches ("my crypto holdings") but the ANALYSIS_INTENT
        // decline-list vetoes it so the LLM classifier can route to
        // COMPREHENSIVE_ANALYSIS.
        const v = evaluateShortCircuit(
            "Write a complete portfolio risk review for my crypto holdings including stress tests.",
        );
        expect(v).toBeNull();
    });

    it("excludes 'analyze my open positions'", () => {
        expect(evaluateShortCircuit("Analyze my open positions")).toBeNull();
    });

    it("excludes 'summary of my orders this week'", () => {
        expect(evaluateShortCircuit("Summary of my orders this week")).toBeNull();
    });

    it("excludes 'take-profit ladder on my Apple stock position' (non-crypto instrument)", () => {
        // Q343 from the static-eval fixture. The cex_account_intent
        // matches ("my Apple stock position") but the
        // NON_CRYPTO_INSTRUMENT decline-list vetoes it.
        expect(
            evaluateShortCircuit("Set up a take-profit ladder on my Apple stock position"),
        ).toBeNull();
    });

    it("excludes 'sell my TSLA shares'", () => {
        expect(evaluateShortCircuit("sell my TSLA shares")).toBeNull();
    });

    it("does NOT exclude 'check my balance' (no analysis verb, no stock)", () => {
        const v = evaluateShortCircuit("check my balance");
        expect(v?.classification).toBe("CEX_WORKFLOW_MESSAGE");
    });
});

describe("Fall-through (no short-circuit) — defers to LLM classifier", () => {
    it("ambiguous trading-ish question without explicit possessive", () => {
        // The LLM classifier handles these — we don't want a
        // deterministic decision here.
        expect(evaluateShortCircuit("Should I buy more BTC right now?")).toBeNull();
    });

    it("comprehensive analysis request", () => {
        expect(
            evaluateShortCircuit("Generate a comprehensive BTC analysis report"),
        ).toBeNull();
    });

    it("multi-asset comparison (task chain candidate)", () => {
        expect(
            evaluateShortCircuit("Compare Bitcoin and Ethereum performance over the past month"),
        ).toBeNull();
    });

    it("CJK comprehensive trigger", () => {
        // `BTC综合分析` is 7 chars but is a legit comprehensive-analysis
        // instruction. Used to short-circuit on the bare length rule —
        // confirming that no SHORT_CIRCUIT_PATTERN catches it now.
        expect(evaluateShortCircuit("BTC综合分析")).toBeNull();
    });
});

// Fix 13 — positions / PnL / liquidation / leverage short-circuit.
describe("Fix 13 — positions/PnL/liquidation → CEX_WORKFLOW_MESSAGE", () => {
    const expectCex = (msg: string) => {
        const v = evaluateShortCircuit(msg);
        expect(v).not.toBeNull();
        // Positions/PnL/liquidation/leverage all hit cex_account_intent
        // (either via possessive+noun or bare-state-noun branch).
        expect(v?.classification).toBe("CEX_WORKFLOW_MESSAGE");
    };

    it("'show my positions'", () => {
        expectCex("show my positions");
    });

    it("'what are my open positions'", () => {
        expectCex("what are my open positions");
    });

    it("'what's my pnl'", () => {
        expectCex("what's my pnl");
    });

    it("'show pnl' (bare noun)", () => {
        expectCex("show pnl");
    });

    it("'my unrealized pnl'", () => {
        expectCex("my unrealized pnl");
    });

    it("'liquidation price for BTCUSDT'", () => {
        expectCex("liquidation price for BTCUSDT");
    });

    it("'what's the liq price on ETH'", () => {
        expectCex("what's the liq price on ETH");
    });

    it("'leverage on my position'", () => {
        expectCex("leverage on my position");
    });

    it("'p&l this month'", () => {
        expectCex("p&l this month");
    });

    it("zh-CN: '强平价'", () => {
        expectCex("强平价");
    });

    it("zh-CN: '我的仓位'", () => {
        expectCex("我的仓位");
    });

    it("zh-CN: '持仓'", () => {
        expectCex("持仓");
    });

    it("zh-CN: '盈亏'", () => {
        expectCex("盈亏");
    });

    it("zh-CN: '未实现盈亏'", () => {
        expectCex("未实现盈亏");
    });

    it("zh-CN: '杠杆'", () => {
        expectCex("杠杆");
    });

    it("does NOT route 'analyze my open positions' to CEX — analysis-intent exclusion fires", () => {
        // Smoke test for the decline-list guarantee under the new
        // bare-state nouns.
        expect(evaluateShortCircuit("Analyze my open positions")).toBeNull();
    });
});

// Fix 8 — user-editable asset allowlist + blocklist.
describe("cex_asset_list_intent → CEX_WORKFLOW_MESSAGE", () => {
    const expectAssetList = (msg: string) => {
        const v = evaluateShortCircuit(msg);
        expect(v).not.toBeNull();
        // Personal-account possessives ("my blocklist") fire
        // cex_account_intent first because the noun group includes
        // a generic "list" via the asset-list verbs; that's fine.
        expect(["cex_asset_list_intent", "cex_account_intent"]).toContain(v?.name);
        expect(v?.classification).toBe("CEX_WORKFLOW_MESSAGE");
    };

    it("'block DOGE'", () => {
        expectAssetList("block DOGE");
    });

    it("'unblock DOGE'", () => {
        expectAssetList("unblock DOGE");
    });

    it("'add DOGE to blocklist'", () => {
        expectAssetList("add DOGE to blocklist");
    });

    it("'add DOGE to my blocklist'", () => {
        expectAssetList("add DOGE to my blocklist");
    });

    it("'add BTC to my allowlist'", () => {
        expectAssetList("add BTC to my allowlist");
    });

    it("'remove DOGE from my allowlist'", () => {
        expectAssetList("remove DOGE from my allowlist");
    });

    it("zh-CN 屏蔽 DOGE", () => {
        expectAssetList("屏蔽 DOGE");
    });

    it("zh-CN 查看黑名单", () => {
        expectAssetList("查看黑名单");
    });

    it("does NOT trap analysis-style requests on Apple stock", () => {
        // "block tesla" alone would match, but the analysis-intent
        // exclude regex catches "review" so it falls through.
        expect(
            evaluateShortCircuit("review whether I should block tesla stock from my portfolio"),
        ).toBeNull();
    });
});
