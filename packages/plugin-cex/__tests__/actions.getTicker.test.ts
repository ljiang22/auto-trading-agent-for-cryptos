/**
 * Fix 15 — `get_ticker` action tests.
 *
 * Covers:
 *  - Default-symbol resolution (no product_ids + no holdings → static).
 *  - Explicit product_ids fan-out.
 *  - INVALID symbol noted in the row (not dropped).
 *  - Symbol-correctness guard refuses on extractor mismatch.
 *  - Override path (`yes, BNBUSDT`) bypasses the guard.
 *  - Render shape includes the source-line footer with ISO timestamp.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock `@elizaos/core` — the action file imports `createActionResponse`,
// `createActionErrorResponse`, `elizaLogger` from there. We provide
// minimal shims so the handler can be invoked without booting the runtime.
vi.mock("@elizaos/core", () => ({
    createActionResponse: (resp: unknown) => resp,
    createActionErrorResponse: (resp: unknown) => resp,
    elizaLogger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

// Mock the binancePricing helpers used by the action.
const fetchBookTicker = vi.fn();
const fetch24hStats = vi.fn();
vi.mock("../src/exchanges/services/binancePricing", () => ({
    fetchBookTicker: (sym: string) => fetchBookTicker(sym),
    fetch24hStats: (sym: string) => fetch24hStats(sym),
}));

// Mock the holdings enumerator + credentials resolver so we never
// touch the database adapter or registry.
const resolveExchangeCredentials = vi.fn();
vi.mock("../src/actions/shared", () => ({
    resolveExchangeCredentials: (...args: unknown[]) =>
        resolveExchangeCredentials(...args),
}));

const getCandidateHoldingsSymbols = vi.fn();
vi.mock("../src/exchanges/services/binance", () => ({
    getCandidateHoldingsSymbols: (...args: unknown[]) =>
        getCandidateHoldingsSymbols(...args),
}));

// Mock the asset extractor so we can drive the symbol guard
// deterministically.
const extractAssetMentions = vi.fn();
vi.mock("../src/intent/promptNumericExtractor", () => ({
    extractAssetMentions: (text: string) => extractAssetMentions(text),
}));

const {
    getTickerAction,
    renderTickerTable,
    symbolGuard,
    isExplicitOverride,
    extractBaseAsset,
    parseProductIds,
    completeProductId,
} = await import("../src/actions/getTicker");

function makeMemory(text: string) {
    return {
        userId: "user-uuid-1234",
        content: { text },
        roomId: "room-1",
    } as never;
}

function makeRuntime() {
    return {
        databaseAdapter: {},
    } as never;
}

beforeEach(() => {
    fetchBookTicker.mockReset();
    fetch24hStats.mockReset();
    resolveExchangeCredentials.mockReset();
    getCandidateHoldingsSymbols.mockReset();
    extractAssetMentions.mockReset();
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("Fix 15 — extractBaseAsset", () => {
    it("strips USDT suffix from concatenated form", () => {
        expect(extractBaseAsset("BTCUSDT")).toBe("BTC");
        expect(extractBaseAsset("ETHUSDC")).toBe("ETH");
    });

    it("handles BTC-USDT / BTC/USDT separators", () => {
        expect(extractBaseAsset("BTC-USDT")).toBe("BTC");
        expect(extractBaseAsset("BTC/USDT")).toBe("BTC");
    });

    it("returns null for empty / garbage input", () => {
        expect(extractBaseAsset("")).toBeNull();
        // 13-char base would fail the 2-12 token check used by the
        // bare-base branch; tests the boundary.
        expect(extractBaseAsset("X".repeat(13))).toBeNull();
    });
});

describe("Fix 15 — parseProductIds", () => {
    it("returns the array when given an array of strings", () => {
        expect(parseProductIds(["BTCUSDT", "ETHUSDT"])).toEqual(["BTCUSDT", "ETHUSDT"]);
    });
    it("upgrades a single string to a 1-element array", () => {
        expect(parseProductIds("BTCUSDT")).toEqual(["BTCUSDT"]);
    });
    it("parses a JSON-encoded string blob", () => {
        expect(parseProductIds('["BTCUSDT","ETHUSDT"]')).toEqual(["BTCUSDT", "ETHUSDT"]);
    });
    it("returns null when empty", () => {
        expect(parseProductIds(null)).toBeNull();
        expect(parseProductIds([])).toBeNull();
        expect(parseProductIds("")).toBeNull();
    });
});

describe("Fix 15 — symbolGuard", () => {
    it("PASSES when no assets are extracted from the user text", () => {
        extractAssetMentions.mockReturnValueOnce([]);
        expect(symbolGuard("show me prices", "BTCUSDT")).toBeNull();
    });

    it("PASSES when the extracted base appears in the user mentions", () => {
        extractAssetMentions.mockReturnValueOnce(["BTC"]);
        expect(symbolGuard("BTC price please", "BTCUSDT")).toBeNull();
    });

    it("REFUSES when the extracted base is absent from the user mentions", () => {
        extractAssetMentions.mockReturnValueOnce(["BTC"]);
        const out = symbolGuard("BTC price please", "BNBUSDT");
        expect(out).not.toBeNull();
        expect(out?.user_asset).toBe("BTC");
        expect(out?.extracted_symbol).toBe("BNBUSDT");
        expect(out?.clarification).toMatch(
            /You asked about BTC but I extracted BNBUSDT/,
        );
    });
});

describe("Fix 15 — isExplicitOverride", () => {
    it("matches `yes, BNBUSDT`", () => {
        expect(isExplicitOverride("yes, BNBUSDT", "BNBUSDT")).toBe(true);
    });
    it("matches `yes BNBUSDT`", () => {
        expect(isExplicitOverride("yes BNBUSDT", "BNBUSDT")).toBe(true);
    });
    it("does NOT match bare `yes`", () => {
        expect(isExplicitOverride("yes", "BNBUSDT")).toBe(false);
    });
});

describe("Fix 15 — get_ticker default symbol resolution", () => {
    it("defaults to BTCUSDT/ETHUSDT/SOLUSDT when no product_ids and no holdings", async () => {
        // No credentials resolve → fall through to static defaults.
        resolveExchangeCredentials.mockRejectedValueOnce(new Error("no creds"));

        // 3 default symbols × (fetchBookTicker + fetch24hStats).
        fetchBookTicker.mockImplementation(async (sym: string) => ({
            bid: sym === "BTCUSDT" ? "60000" : "1",
            bidQty: "1",
            ask: sym === "BTCUSDT" ? "60001" : "2",
            askQty: "1",
            spread_bps: 1,
        }));
        fetch24hStats.mockImplementation(async () => ({
            priceChangePercent: "1.5",
            weightedAvgPrice: "0",
            highPrice: "100",
            lowPrice: "90",
            volume: "0",
            quoteVolume: "1000000",
            openTime: 0,
            closeTime: 0,
        }));

        const cb = vi.fn();
        await getTickerAction.handler!(
            makeRuntime(),
            makeMemory(""),
            undefined,
            {},
            cb,
        );
        expect(cb).toHaveBeenCalledOnce();
        const resp = cb.mock.calls[0][0];
        expect(resp.content.symbols).toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
        expect(resp.content.defaultSource).toBe("static");
        expect(resp.text).toContain("BTCUSDT");
        expect(resp.text).toContain("ETHUSDT");
        expect(resp.text).toContain("SOLUSDT");
        expect(resp.text).toMatch(/_Source: Binance ticker @ \d{4}/);
        expect(resp.text).toMatch(/freshness: <5s/);
    });

    it("uses holdings when authenticated and Binance enumeration returns >0 symbols", async () => {
        resolveExchangeCredentials.mockResolvedValueOnce({
            exchange: "binance",
            authType: "api_key_name_secret",
            auth: { apiKeyName: "k", apiKeySecret: "s" },
        });
        getCandidateHoldingsSymbols.mockResolvedValueOnce([
            "BTCUSDT",
            "DOGEUSDT",
        ]);
        fetchBookTicker.mockResolvedValue({
            bid: "1",
            bidQty: "1",
            ask: "1",
            askQty: "1",
            spread_bps: 0,
        });
        fetch24hStats.mockResolvedValue({
            priceChangePercent: "0",
            weightedAvgPrice: "0",
            highPrice: "1",
            lowPrice: "1",
            volume: "0",
            quoteVolume: "0",
            openTime: 0,
            closeTime: 0,
        });

        const cb = vi.fn();
        await getTickerAction.handler!(
            makeRuntime(),
            makeMemory(""),
            undefined,
            {},
            cb,
        );
        const resp = cb.mock.calls[0][0];
        expect(resp.content.symbols).toEqual(["BTCUSDT", "DOGEUSDT"]);
        expect(resp.content.defaultSource).toBe("holdings");
    });
});

describe("Fix 15 — get_ticker explicit product_ids", () => {
    it("returns a single-row table for ['BTCUSDT']", async () => {
        // Set extractAssetMentions to return ["BTC"] so the symbol guard
        // passes for BTCUSDT.
        extractAssetMentions.mockReturnValue(["BTC"]);
        fetchBookTicker.mockResolvedValueOnce({
            bid: "60000",
            bidQty: "1",
            ask: "60001",
            askQty: "1",
            spread_bps: 0.17,
        });
        fetch24hStats.mockResolvedValueOnce({
            priceChangePercent: "2.5",
            weightedAvgPrice: "0",
            highPrice: "61000",
            lowPrice: "59000",
            volume: "0",
            quoteVolume: "1500000000",
            openTime: 0,
            closeTime: 0,
        });

        const cb = vi.fn();
        await getTickerAction.handler!(
            makeRuntime(),
            makeMemory("what is the BTC price right now?"),
            undefined,
            { product_ids: ["BTCUSDT"] },
            cb,
        );
        const resp = cb.mock.calls[0][0];
        expect(resp.content.rows).toHaveLength(1);
        expect(resp.content.rows[0].symbol).toBe("BTCUSDT");
        expect(resp.content.rows[0].last_mid).toBeCloseTo(60000.5, 1);
        expect(resp.text).toContain("BTCUSDT");
        expect(resp.text).toContain("+2.50%");
    });

    it("notes INVALID symbol with a note instead of dropping the row", async () => {
        extractAssetMentions.mockReturnValue([]);
        // BTCUSDT — both calls succeed
        fetchBookTicker.mockResolvedValueOnce({
            bid: "60000",
            bidQty: "1",
            ask: "60001",
            askQty: "1",
            spread_bps: 0.17,
        });
        fetch24hStats.mockResolvedValueOnce({
            priceChangePercent: "0",
            weightedAvgPrice: "0",
            highPrice: "1",
            lowPrice: "1",
            volume: "0",
            quoteVolume: "0",
            openTime: 0,
            closeTime: 0,
        });
        // INVALID — both calls return null
        fetchBookTicker.mockResolvedValueOnce(null);
        fetch24hStats.mockResolvedValueOnce(null);

        const cb = vi.fn();
        await getTickerAction.handler!(
            makeRuntime(),
            makeMemory("BTC and INVALID"),
            undefined,
            { product_ids: ["BTCUSDT", "INVALID"] },
            cb,
        );
        const resp = cb.mock.calls[0][0];
        expect(resp.content.rows).toHaveLength(2);
        // CEX post-PR237 Commit 3 — bare base assets are now
        // auto-completed to BASE+USDT before fan-out, so "INVALID" is
        // normalized to "INVALIDUSDT". The downstream fetchers still
        // return null for the unknown pair, so the row carries the
        // "venue returned no data" placeholder.
        const invalidRow = resp.content.rows.find(
            (r: { symbol: string }) => r.symbol === "INVALIDUSDT",
        );
        expect(invalidRow?.note).toBe("venue returned no data");
        expect(resp.text).toContain("INVALIDUSDT");
    });
});

describe("Fix 15 — symbol-correctness guard end-to-end", () => {
    it("REFUSES when LLM extracts BNBUSDT for a BTC user prompt", async () => {
        // User text contains BTC; extractor sees only BTC.
        extractAssetMentions.mockReturnValueOnce(["BTC"]);

        const cb = vi.fn();
        await getTickerAction.handler!(
            makeRuntime(),
            makeMemory("what is the BTC price right now?"),
            undefined,
            { product_ids: ["BNBUSDT"] },
            cb,
        );
        const resp = cb.mock.calls[0][0];
        expect(resp.type).toBe("get_ticker_clarification");
        expect(resp.text).toContain("You asked about BTC");
        expect(resp.text).toContain("BNBUSDT");
        expect(fetchBookTicker).not.toHaveBeenCalled();
        expect(fetch24hStats).not.toHaveBeenCalled();
    });

    it("allows the override `yes, BNBUSDT` to bypass the guard", async () => {
        // The override regex runs BEFORE extractAssetMentions so the
        // guard never fires.
        fetchBookTicker.mockResolvedValueOnce({
            bid: "300",
            bidQty: "1",
            ask: "301",
            askQty: "1",
            spread_bps: 33.2,
        });
        fetch24hStats.mockResolvedValueOnce({
            priceChangePercent: "1.0",
            weightedAvgPrice: "0",
            highPrice: "1",
            lowPrice: "1",
            volume: "0",
            quoteVolume: "0",
            openTime: 0,
            closeTime: 0,
        });

        const cb = vi.fn();
        await getTickerAction.handler!(
            makeRuntime(),
            makeMemory("yes, BNBUSDT"),
            undefined,
            { product_ids: ["BNBUSDT"] },
            cb,
        );
        const resp = cb.mock.calls[0][0];
        expect(resp.type).toBe("get_ticker");
        expect(resp.content.rows[0].symbol).toBe("BNBUSDT");
    });
});

describe("Fix 15 — renderTickerTable", () => {
    it("includes the source line with ISO timestamp", () => {
        const out = renderTickerTable({
            rows: [
                {
                    symbol: "BTCUSDT",
                    last_mid: 60000,
                    bid: "59999",
                    ask: "60001",
                    spread_bps: 0.33,
                    change_pct_24h: 1.5,
                    high_24h: "61000",
                    low_24h: "59000",
                    volume_quote_24h: 1_500_000,
                },
            ],
            asOf: "2026-05-22T12:34:56.789Z",
            defaultSource: "static",
        });
        expect(out).toContain("BTCUSDT");
        expect(out).toContain("Last (mid)");
        expect(out).toContain("Spread bps");
        expect(out).toContain("_Source: Binance ticker @ 2026-05-22T12:34:56.789Z, freshness: <5s_");
    });

    it("renders an empty-rows table with just the source footer", () => {
        const out = renderTickerTable({
            rows: [],
            asOf: "2026-05-22T00:00:00.000Z",
            defaultSource: "static",
        });
        expect(out).toContain("_No tickers to display._");
        expect(out).toContain("_Source: Binance ticker @ 2026-05-22T00:00:00.000Z, freshness: <5s_");
    });
});

describe("CEX post-PR237 Commit 3 — completeProductId", () => {
    it("appends USDT to bare base assets for Binance", () => {
        expect(completeProductId("BTC", { venue: "binance" })).toBe("BTCUSDT");
        expect(completeProductId("ETH", { venue: "binance" })).toBe("ETHUSDT");
        expect(completeProductId("sol", { venue: "binance" })).toBe("SOLUSDT");
    });

    it("appends -USDT for Coinbase venue", () => {
        expect(completeProductId("BTC", { venue: "coinbase" })).toBe("BTC-USDT");
        expect(completeProductId("ETH", { venue: "coinbase" })).toBe("ETH-USDT");
    });

    it("passes through already-complete pairs unchanged (Binance concat form)", () => {
        expect(completeProductId("BTCUSDT", { venue: "binance" })).toBe("BTCUSDT");
        expect(completeProductId("ETHUSDC", { venue: "binance" })).toBe("ETHUSDC");
    });

    it("converts between venue forms when the input is already a complete pair", () => {
        expect(completeProductId("BTC-USDT", { venue: "binance" })).toBe("BTCUSDT");
        expect(completeProductId("BTCUSDT", { venue: "coinbase" })).toBe("BTC-USDT");
        expect(completeProductId("BTC/USDT", { venue: "binance" })).toBe("BTCUSDT");
    });

    it("respects an explicit non-USDT quote in the input", () => {
        expect(completeProductId("BTC-USDC", { venue: "binance" })).toBe("BTCUSDC");
        expect(completeProductId("ETHUSDC", { venue: "coinbase" })).toBe("ETH-USDC");
    });

    it("uses the defaultQuote override when present", () => {
        expect(
            completeProductId("BTC", { venue: "binance", defaultQuote: "USDC" }),
        ).toBe("BTCUSDC");
    });

    it("returns null for garbage input", () => {
        expect(completeProductId("", { venue: "binance" })).toBeNull();
        expect(completeProductId("!!!", { venue: "binance" })).toBeNull();
    });
});

describe("Fix 15 — userId required", () => {
    it("errors when userId is absent from both params and memory", async () => {
        const cb = vi.fn();
        const out = await getTickerAction.handler!(
            makeRuntime(),
            { content: { text: "" }, roomId: "r" } as never,
            undefined,
            {},
            cb,
        );
        expect(out).toBe(false);
        expect(cb.mock.calls[0][0].text).toMatch(/userId.*required/i);
    });
});
