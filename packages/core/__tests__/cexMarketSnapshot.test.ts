/**
 * Fix 14 — `buildMarketSnapshot` + `buildSymbolVerification` tests.
 *
 * These cover the LATENCY-BUDGET timeout path, symbol-verification
 * matching (positive / negative / quote-mismatch), and est-fill /
 * slippage math. The Binance HTTP layer is mocked via the provider's
 * fetchBookTicker / fetchDepth / fetch24hStats hooks (which the real
 * plugin registers on top of `httpClient`). Keeping the test at the
 * provider boundary lets us validate the latency budget without
 * depending on plugin-cex internals.
 */

import { describe, expect, it } from "vitest";
import {
    buildMarketSnapshot,
    buildSymbolVerification,
    extractLimitPriceFromAction,
    resolveBinanceSymbol,
} from "../src/handlers/cexMarketSnapshot.ts";
import type { CEXSpecProvider } from "../src/core/types.ts";

function delay<T>(ms: number, value: T): Promise<T> {
    return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

// In-memory provider stub. Only the hooks `buildMarketSnapshot`
// consults are populated; the rest is `as unknown as` since this
// module is structural and we only exercise a small slice.
function stubProvider(overrides: Partial<CEXSpecProvider>): CEXSpecProvider {
    return overrides as CEXSpecProvider;
}

const goodBook = {
    bid: "100.00",
    bidQty: "1",
    ask: "101.00",
    askQty: "1",
    spread_bps: 99.5,
};
const goodDepth = {
    bids: [
        ["100.10", "1"],
        ["100.00", "2"],
    ] as Array<[string, string]>,
    asks: [
        ["100.20", "1.5"],
        ["100.30", "2.5"],
    ] as Array<[string, string]>,
    lastUpdateId: 1,
};
const goodStats = {
    priceChangePercent: "1.234",
    weightedAvgPrice: "100.5",
    highPrice: "102",
    lowPrice: "99",
    volume: "1000",
    quoteVolume: "100500",
    openTime: 1,
    closeTime: 2,
};

describe("resolveBinanceSymbol", () => {
    it("strips dash from canonical pair", () => {
        expect(resolveBinanceSymbol("BTC-USDT", undefined)).toBe("BTCUSDT");
    });
    it("strips slash from `BTC/USDT`", () => {
        expect(resolveBinanceSymbol("BTC/USDT", undefined)).toBe("BTCUSDT");
    });
    it("passes through concatenated form", () => {
        expect(resolveBinanceSymbol("BTCUSDT", undefined)).toBe("BTCUSDT");
    });
    it("falls back to symbol hint when product_id missing", () => {
        expect(resolveBinanceSymbol(undefined, "ETHUSDT")).toBe("ETHUSDT");
    });
    it("returns null for empty input", () => {
        expect(resolveBinanceSymbol(undefined, undefined)).toBeNull();
    });
});

describe("extractLimitPriceFromAction", () => {
    it("reads top-level limit_price (legacy ADK path)", () => {
        expect(extractLimitPriceFromAction({ limit_price: "100" })).toBe(100);
    });
    it("reads from nested order_configuration", () => {
        const params = {
            order_configuration: { limit_limit_gtc: { limit_price: "76955" } },
        };
        expect(extractLimitPriceFromAction(params)).toBe(76955);
    });
    it("returns null when no price present", () => {
        expect(extractLimitPriceFromAction({})).toBeNull();
        expect(extractLimitPriceFromAction(undefined)).toBeNull();
    });
});

describe("buildSymbolVerification — Fix 14c", () => {
    const ident = (s: string) => (s.match(/[A-Z]+/g) ?? []).filter((t) => t.length > 1);

    it("positive — user typed `Buy 0.001 BTC at $80000`, extracted `BTCUSDT` → matches: true", () => {
        const out = buildSymbolVerification(
            "Buy 0.001 BTC at $80000",
            "BTCUSDT",
            "BTC-USDT",
            (text) => (text.toUpperCase().includes("BTC") ? ["BTC"] : []),
        );
        expect(out.matches).toBe(true);
        expect(out.extracted_symbol).toBe("BTCUSDT");
        expect(out.user_text_asset_mentions).toEqual(["BTC"]);
        expect(out.quote_currency_mismatch).toBeUndefined();
        expect(out.reason).toBe("matches");
    });

    it("negative — user typed `Buy BTC` but extracted `ETHUSDT` → matches: false", () => {
        const out = buildSymbolVerification(
            "Buy BTC",
            "ETHUSDT",
            "ETH-USDT",
            (text) => (text.toUpperCase().includes("BTC") ? ["BTC"] : []),
        );
        expect(out.matches).toBe(false);
        expect(out.extracted_symbol).toBe("ETHUSDT");
        expect(out.user_text_asset_mentions).toEqual(["BTC"]);
        expect(out.reason).toBe("extractor_symbol_missing_user_assets");
    });

    it("soft warning — user typed `BTC-USDC` but extractor produced `BTCUSDT` → matches: true + quote_currency_mismatch", () => {
        const out = buildSymbolVerification(
            "Buy 0.01 BTC on BTC-USDC",
            "BTCUSDT",
            "BTC-USDC",
            (text) => (text.toUpperCase().includes("BTC") ? ["BTC"] : []),
        );
        expect(out.matches).toBe(true);
        expect(out.quote_currency_mismatch).toBe(true);
        expect(out.reason).toBe("matches_with_quote_mismatch");
    });

    it("vague prompt with no asset mentions → matches: false (no_user_assets_mentioned)", () => {
        const out = buildSymbolVerification(
            "yes, please proceed",
            "BTCUSDT",
            "BTC-USDT",
            () => [],
        );
        expect(out.matches).toBe(false);
        expect(out.reason).toBe("no_user_assets_mentioned");
    });

    // Bind to silence the unused-var warning while keeping the test
    // file self-contained as a reference.
    void ident;
});

describe("buildMarketSnapshot — happy path + verification", () => {
    it("buy create_order on BTCUSDT — packs full snapshot, est_fill = ask, slippage from limit", async () => {
        const provider = stubProvider({
            fetchBookTicker: async () => goodBook,
            fetchDepth: async () => goodDepth,
            fetch24hStats: async () => goodStats,
            extractAssetMentions: () => ["BTC"],
        });

        const out = await buildMarketSnapshot({
            provider,
            symbol: "BTCUSDT",
            promptText: "Buy 0.001 BTC at $99",
            actionParams: {
                product_id: "BTC-USDT",
                side: "BUY",
                order_configuration: {
                    limit_limit_gtc: { limit_price: "99" },
                },
            },
            actionName: "create_order",
        });
        expect(out.market_snapshot).toBeTruthy();
        expect(out.market_snapshot?.bid).toBe("100.00");
        expect(out.market_snapshot?.ask).toBe("101.00");
        expect(out.market_snapshot?.spread_bps).toBeCloseTo(99.5, 1);
        // Buy → est_fill = ask = 101. Slippage vs limit 99: (101 - 99) / 99 * 10000 ≈ 202.02 bps.
        expect(out.market_snapshot?.est_fill_price).toBe(101);
        expect(out.market_snapshot?.slippage_vs_limit_bps).toBeCloseTo(202, 1);
        expect(out.market_snapshot?.depth_bids).toEqual([
            { price: "100.10", qty: "1" },
            { price: "100.00", qty: "2" },
        ]);
        expect(out.market_snapshot?.price_change_pct).toBe("1.234");
        expect(out.symbol_verification.matches).toBe(true);
    });

    it("sell — est_fill = bid", async () => {
        const provider = stubProvider({
            fetchBookTicker: async () => goodBook,
            fetchDepth: async () => goodDepth,
            fetch24hStats: async () => goodStats,
            extractAssetMentions: () => ["BTC"],
        });
        const out = await buildMarketSnapshot({
            provider,
            symbol: "BTCUSDT",
            promptText: "Sell 0.001 BTC",
            actionParams: {
                product_id: "BTC-USDT",
                side: "SELL",
            },
            actionName: "create_order",
        });
        expect(out.market_snapshot?.est_fill_price).toBe(100); // bid
    });
});

describe("buildMarketSnapshot — 600 ms latency budget", () => {
    it("all three fetches exceed the budget → market_snapshot omitted", async () => {
        const provider = stubProvider({
            fetchBookTicker: () => delay(2000, goodBook) as never,
            fetchDepth: () => delay(2000, goodDepth) as never,
            fetch24hStats: () => delay(2000, goodStats) as never,
            extractAssetMentions: () => ["BTC"],
        });
        const start = Date.now();
        const out = await buildMarketSnapshot({
            provider,
            symbol: "BTCUSDT",
            promptText: "Buy BTC",
            actionParams: { product_id: "BTC-USDT", side: "BUY" },
            actionName: "create_order",
            latencyBudgetMs: 100,
        });
        const elapsed = Date.now() - start;
        // The race must abort by the budget (allow some scheduler slack).
        expect(elapsed).toBeLessThan(500);
        expect(out.market_snapshot).toBeUndefined();
        // Verification is still produced.
        expect(out.symbol_verification.matches).toBe(true);
    });

    it("partial success — book fast, depth slow → snapshot includes book, omits depth", async () => {
        const provider = stubProvider({
            fetchBookTicker: async () => goodBook,
            fetchDepth: () => delay(2000, goodDepth) as never,
            fetch24hStats: async () => goodStats,
            extractAssetMentions: () => ["BTC"],
        });
        const out = await buildMarketSnapshot({
            provider,
            symbol: "BTCUSDT",
            promptText: "Buy BTC",
            actionParams: { product_id: "BTC-USDT", side: "BUY" },
            actionName: "create_order",
            latencyBudgetMs: 100,
        });
        expect(out.market_snapshot).toBeTruthy();
        expect(out.market_snapshot?.bid).toBe("100.00");
        expect(out.market_snapshot?.depth_bids).toBeUndefined();
    });
});

describe("buildMarketSnapshot — missing provider hooks", () => {
    it("returns only verification when fetchBookTicker is undefined", async () => {
        const provider = stubProvider({
            extractAssetMentions: () => ["BTC"],
            // no fetch* hooks
        });
        const out = await buildMarketSnapshot({
            provider,
            symbol: "BTCUSDT",
            promptText: "Buy BTC",
            actionParams: { product_id: "BTC-USDT", side: "BUY" },
            actionName: "create_order",
        });
        expect(out.market_snapshot).toBeUndefined();
        expect(out.symbol_verification.matches).toBe(true);
    });

    it("falls back to empty mentions when extractor hook missing", async () => {
        const provider = stubProvider({
            fetchBookTicker: async () => goodBook,
            fetchDepth: async () => goodDepth,
            fetch24hStats: async () => goodStats,
        });
        const out = await buildMarketSnapshot({
            provider,
            symbol: "BTCUSDT",
            promptText: "Buy BTC",
            actionParams: { product_id: "BTC-USDT", side: "BUY" },
            actionName: "create_order",
        });
        // No mentions → matches: false (safety bias).
        expect(out.symbol_verification.matches).toBe(false);
        expect(out.symbol_verification.reason).toBe("no_user_assets_mentioned");
        // Snapshot still populated.
        expect(out.market_snapshot).toBeTruthy();
    });
});

describe("buildMarketSnapshot — verification negative", () => {
    it("user typed BTC but extractor produced ETHUSDT → matches: false, snapshot still fetched against extracted symbol", async () => {
        const provider = stubProvider({
            fetchBookTicker: async () => goodBook,
            fetchDepth: async () => goodDepth,
            fetch24hStats: async () => goodStats,
            extractAssetMentions: () => ["BTC"],
        });
        const out = await buildMarketSnapshot({
            provider,
            symbol: "ETHUSDT",
            promptText: "Buy BTC",
            actionParams: { product_id: "ETH-USDT", side: "BUY" },
            actionName: "create_order",
        });
        // Snapshot is produced (so the UI can show "this is what we'd actually buy"),
        // but verification says NO — the client disables Confirm via the banner.
        expect(out.market_snapshot).toBeTruthy();
        expect(out.market_snapshot?.symbol).toBe("ETHUSDT");
        expect(out.symbol_verification.matches).toBe(false);
        expect(out.symbol_verification.extracted_symbol).toBe("ETHUSDT");
        expect(out.symbol_verification.user_text_asset_mentions).toEqual(["BTC"]);
    });
});
