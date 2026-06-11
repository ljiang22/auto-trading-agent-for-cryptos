import { describe, expect, it } from "vitest";

import {
    resolveAnaphoricOrderId,
    resolveSymbolForOrderId,
} from "../src/orderContext/anaphoricResolver";

function memo(id: string, text: string, ageSec: number) {
    return { id, text, createdAt: Date.now() - ageSec * 1000 };
}

const BINANCE_TABLE_MEMO = memo(
    "m-1",
    [
        "Binance Open Orders",
        "| Symbol | Order ID | Side | Price |",
        "|---|---|---|---|",
        "| BTCUSDT | 61908270229 | BUY | 76000 |",
    ].join("\n"),
    5,
);

const COINBASE_DETAIL_MEMO = memo(
    "m-2",
    [
        "Coinbase Order Report",
        "Order ID | 7d139d40-4e68-4e82-aed2-4e3895542ebf",
        "Trading Pair | BTC-USDC",
        "Side | BUY",
    ].join("\n"),
    30,
);

const MULTI_ORDER_MEMO = memo(
    "m-3",
    [
        "| Symbol | Order ID |",
        "|---|---|",
        "| BTCUSDT | 100000000001 |",
        "| ETHUSDT | 100000000002 |",
    ].join("\n"),
    1,
);

// Round-5 — paper-venue order memo. Paper order ids look like
// `paper-ord-<random>-<unix-ms>`. The resolver must recognize them as
// valid order ids in the open-orders table; previously they were
// missed entirely, so "cancel my latest paper order" never resolved.
const PAPER_ORDER_MEMO = memo(
    "m-paper",
    [
        "Your paper-venue open orders:",
        "| Symbol | Order ID | Side | Price |",
        "|---|---|---|---|",
        "| BTC-USDT | paper-ord-aox4yzqu-1779228447000 | BUY | 60000 |",
    ].join("\n"),
    3,
);

describe("anaphoric order-ID resolver", () => {
    it("returns null when no anaphoric phrase", () => {
        const r = resolveAnaphoricOrderId({
            messageText: "what is bitcoin price?",
            locale: "en",
            recentAssistantMemories: [BINANCE_TABLE_MEMO],
        });
        expect(r).toBeNull();
    });

    it("resolves 'cancel this order' from single Binance table row", () => {
        const r = resolveAnaphoricOrderId({
            messageText: "cancel this order",
            locale: "en",
            recentAssistantMemories: [BINANCE_TABLE_MEMO],
        });
        expect(r).not.toBeNull();
        expect(r?.order_id).toBe("61908270229");
        expect(r?.unambiguous).toBe(true);
    });

    it("resolves 'the one on binance you just show'", () => {
        const r = resolveAnaphoricOrderId({
            messageText: "the one on binance you just show",
            locale: "en",
            recentAssistantMemories: [BINANCE_TABLE_MEMO],
            venue: "binance",
        });
        expect(r?.order_id).toBe("61908270229");
        expect(r?.unambiguous).toBe(true);
    });

    it("resolves Coinbase UUID from detail-style memo", () => {
        const r = resolveAnaphoricOrderId({
            messageText: "cancel that order",
            locale: "en",
            recentAssistantMemories: [COINBASE_DETAIL_MEMO],
        });
        expect(r?.order_id).toBe("7d139d40-4e68-4e82-aed2-4e3895542ebf");
        expect(r?.unambiguous).toBe(true);
    });

    it("filters by venue: binance scoping drops UUID candidates", () => {
        const r = resolveAnaphoricOrderId({
            messageText: "cancel that order",
            locale: "en",
            recentAssistantMemories: [COINBASE_DETAIL_MEMO],
            venue: "binance",
        });
        expect(r).toBeNull();
    });

    it("returns first id but flags ambiguous when multiple visible", () => {
        const r = resolveAnaphoricOrderId({
            messageText: "cancel that order",
            locale: "en",
            recentAssistantMemories: [MULTI_ORDER_MEMO],
        });
        expect(r?.unambiguous).toBe(false);
    });

    it("ZH: '取消那个订单' resolves from binance table", () => {
        const r = resolveAnaphoricOrderId({
            messageText: "取消那个订单",
            locale: "zh-CN",
            recentAssistantMemories: [BINANCE_TABLE_MEMO],
        });
        expect(r?.order_id).toBe("61908270229");
    });

    it("ZH: '撤销刚才那个' resolves", () => {
        const r = resolveAnaphoricOrderId({
            messageText: "撤销刚才那个",
            locale: "zh-CN",
            recentAssistantMemories: [BINANCE_TABLE_MEMO],
        });
        expect(r?.order_id).toBe("61908270229");
    });

    // M1-r2 — "my latest" + zh-CN equivalents. Covers the deferred
    // patterns from the round-3 feedback. The resolver must fire when
    // the user references the most-recent order without an explicit ID
    // ("cancel my latest", "撤销最新的", "kill the most recent",
    // "取消我最近的订单") and resolve to whatever the agent last showed.
    it("EN: 'cancel my latest order' resolves", () => {
        const r = resolveAnaphoricOrderId({
            messageText: "cancel my latest order",
            locale: "en",
            recentAssistantMemories: [BINANCE_TABLE_MEMO],
        });
        expect(r?.order_id).toBe("61908270229");
    });

    it("EN: 'kill the most recent' (no explicit noun) resolves", () => {
        const r = resolveAnaphoricOrderId({
            messageText: "kill the most recent",
            locale: "en",
            recentAssistantMemories: [BINANCE_TABLE_MEMO],
        });
        expect(r?.order_id).toBe("61908270229");
    });

    it("EN: 'amend my last' (verb + my-last, no noun) resolves", () => {
        const r = resolveAnaphoricOrderId({
            messageText: "amend my last",
            locale: "en",
            recentAssistantMemories: [BINANCE_TABLE_MEMO],
        });
        expect(r?.order_id).toBe("61908270229");
    });

    it("EN: 'my latest trade' resolves", () => {
        const r = resolveAnaphoricOrderId({
            messageText: "show details for my latest trade",
            locale: "en",
            recentAssistantMemories: [BINANCE_TABLE_MEMO],
        });
        expect(r?.order_id).toBe("61908270229");
    });

    it("EN: trailing 'my latest news' does NOT misfire (no order context)", () => {
        // Guard against the bare-"my latest" pattern hijacking
        // non-trading phrases.
        const r = resolveAnaphoricOrderId({
            messageText: "show me my latest news",
            locale: "en",
            recentAssistantMemories: [BINANCE_TABLE_MEMO],
        });
        expect(r).toBe(null);
    });

    it("ZH: '撤销我最近的订单' resolves", () => {
        const r = resolveAnaphoricOrderId({
            messageText: "撤销我最近的订单",
            locale: "zh-CN",
            recentAssistantMemories: [BINANCE_TABLE_MEMO],
        });
        expect(r?.order_id).toBe("61908270229");
    });

    it("ZH: '取消最新一个' (no explicit noun) resolves", () => {
        const r = resolveAnaphoricOrderId({
            messageText: "取消最新一个",
            locale: "zh-CN",
            recentAssistantMemories: [BINANCE_TABLE_MEMO],
        });
        expect(r?.order_id).toBe("61908270229");
    });

    it("ZH: '改最近的' (verb+adj, no noun) resolves", () => {
        const r = resolveAnaphoricOrderId({
            messageText: "改最近的",
            locale: "zh-CN",
            recentAssistantMemories: [BINANCE_TABLE_MEMO],
        });
        expect(r?.order_id).toBe("61908270229");
    });

    // Round-5 QA repro — "cancel my latest paper order" was returning null
    // because (1) the pattern required `latest` adjacent to the noun, and
    // (2) ORDER_ID_PATTERNS didn't recognize paper-venue ids.
    it("EN: 'cancel my latest paper order' resolves to the paper-venue id", () => {
        const r = resolveAnaphoricOrderId({
            messageText: "cancel my latest paper order",
            locale: "en",
            recentAssistantMemories: [PAPER_ORDER_MEMO],
        });
        expect(r?.order_id).toBe("paper-ord-aox4yzqu-1779228447000");
        expect(r?.unambiguous).toBe(true);
    });

    it("EN: 'cancel my last open limit order' (two adjectives between latest and noun) resolves", () => {
        const r = resolveAnaphoricOrderId({
            messageText: "cancel my last open limit order",
            locale: "en",
            recentAssistantMemories: [BINANCE_TABLE_MEMO],
        });
        expect(r?.order_id).toBe("61908270229");
    });

    it("paper id passes the binance venue filter (paper is venue-agnostic)", () => {
        const r = resolveAnaphoricOrderId({
            messageText: "cancel my latest paper order",
            locale: "en",
            recentAssistantMemories: [PAPER_ORDER_MEMO],
            venue: "binance",
        });
        expect(r?.order_id).toBe("paper-ord-aox4yzqu-1779228447000");
    });

    it("prefers most-recent memory when both have orders", () => {
        const old = memo("m-old", "Order ID 99999999999", 600);
        const fresh = memo("m-fresh", "Order ID 11111111111", 5);
        const r = resolveAnaphoricOrderId({
            messageText: "cancel this",
            locale: "en",
            recentAssistantMemories: [old, fresh],
        });
        expect(r?.sourceMemoryId).toBe("m-fresh");
        expect(r?.order_id).toBe("11111111111");
    });

    it("returns null on memos with no order IDs", () => {
        const r = resolveAnaphoricOrderId({
            messageText: "cancel this",
            locale: "en",
            recentAssistantMemories: [memo("m", "Here is your balance", 1)],
        });
        expect(r).toBeNull();
    });

    it("skips client_order_id-style strings (no false-positive)", () => {
        // Client order IDs in this codebase are lowercase alnum with hyphens.
        // Make sure the numeric/UUID match doesn't accidentally grab them.
        const m = memo(
            "m",
            ["Order ID | bn-jkeqbpmyrwrn2l4y3bgdl24lit", "Some text"].join("\n"),
            1,
        );
        const r = resolveAnaphoricOrderId({
            messageText: "cancel this order",
            locale: "en",
            recentAssistantMemories: [m],
        });
        expect(r).toBeNull();
    });
});

describe("resolveSymbolForOrderId — explicit-id symbol back-fill", () => {
    it("finds the symbol for a numeric Binance id from a recent table", () => {
        const r = resolveSymbolForOrderId({
            orderId: "61908270229",
            recentAssistantMemories: [BINANCE_TABLE_MEMO],
            venue: "binance",
        });
        expect(r?.symbol).toBe("BTCUSDT");
        expect(r?.sourceMemoryId).toBe("m-1");
    });

    it("picks the correct row when multiple ids are visible", () => {
        const r = resolveSymbolForOrderId({
            orderId: "100000000002",
            recentAssistantMemories: [MULTI_ORDER_MEMO],
            venue: "binance",
        });
        expect(r?.symbol).toBe("ETHUSDT");
    });

    it("returns null when the id is not present in any memo", () => {
        const r = resolveSymbolForOrderId({
            orderId: "99999999999",
            recentAssistantMemories: [BINANCE_TABLE_MEMO, MULTI_ORDER_MEMO],
            venue: "binance",
        });
        expect(r).toBeNull();
    });

    it("returns null when the matching row carries no symbol", () => {
        const noSymbolMemo = memo(
            "m-bare",
            // Order Detail Report — single-line list, id only.
            ["Order ID 61915077249", "Status NEW"].join("\n"),
            1,
        );
        const r = resolveSymbolForOrderId({
            orderId: "61915077249",
            recentAssistantMemories: [noSymbolMemo],
            venue: "binance",
        });
        expect(r).toBeNull();
    });

    it("respects venue scoping (UUID id is dropped under binance)", () => {
        const r = resolveSymbolForOrderId({
            orderId: "7d139d40-4e68-4e82-aed2-4e3895542ebf",
            recentAssistantMemories: [COINBASE_DETAIL_MEMO],
            venue: "binance",
        });
        expect(r).toBeNull();
    });

    it("walks memories most-recent-first", () => {
        const old = memo(
            "m-old",
            ["| Symbol | Order ID |", "| BTCUSDT | 12345678901 |"].join("\n"),
            600,
        );
        const fresh = memo(
            "m-fresh",
            ["| Symbol | Order ID |", "| ETHUSDT | 12345678901 |"].join("\n"),
            5,
        );
        const r = resolveSymbolForOrderId({
            orderId: "12345678901",
            recentAssistantMemories: [old, fresh],
            venue: "binance",
        });
        expect(r?.symbol).toBe("ETHUSDT");
        expect(r?.sourceMemoryId).toBe("m-fresh");
    });
});
