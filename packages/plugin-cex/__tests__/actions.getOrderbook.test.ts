/**
 * Fix 15 — `get_orderbook` action tests.
 *
 * Covers:
 *  - product_id required (errors when absent).
 *  - depth parsing + clamping to [1, 100].
 *  - Side-by-side render with top-N bids + asks.
 *  - Symbol-correctness guard refuses on extractor mismatch.
 *  - Override path (`yes, BNBUSDT`) bypasses the guard.
 *  - Render shape includes the source-line footer with ISO timestamp.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const fetchDepth = vi.fn();
vi.mock("../src/exchanges/services/binancePricing", () => ({
    fetchDepth: (...args: unknown[]) => fetchDepth(...args),
}));

const extractAssetMentions = vi.fn();
vi.mock("../src/intent/promptNumericExtractor", () => ({
    extractAssetMentions: (text: string) => extractAssetMentions(text),
}));

const {
    getOrderbookAction,
    parseProductId,
    parseDepth,
    renderOrderbookTable,
} = await import("../src/actions/getOrderbook");

function makeMemory(text: string) {
    return {
        userId: "user-uuid-1234",
        content: { text },
        roomId: "room-1",
    } as never;
}

function makeRuntime() {
    return { databaseAdapter: {} } as never;
}

beforeEach(() => {
    fetchDepth.mockReset();
    extractAssetMentions.mockReset();
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("Fix 15 — parseProductId", () => {
    it("returns the string for a string input", () => {
        expect(parseProductId("BTCUSDT")).toBe("BTCUSDT");
    });
    it("returns the first element for a single-element array", () => {
        expect(parseProductId(["BTCUSDT"])).toBe("BTCUSDT");
    });
    it("returns null for null / empty", () => {
        expect(parseProductId(null)).toBeNull();
        expect(parseProductId("")).toBeNull();
        expect(parseProductId([])).toBeNull();
    });
});

describe("Fix 15 — parseDepth", () => {
    it("defaults to 10 when undefined", () => {
        expect(parseDepth(undefined)).toBe(10);
    });
    it("clamps to 100 when given a larger value", () => {
        expect(parseDepth(200)).toBe(100);
        expect(parseDepth(9999)).toBe(100);
    });
    it("accepts a string value", () => {
        expect(parseDepth("20")).toBe(20);
    });
    it("falls back to 10 on non-finite", () => {
        expect(parseDepth("not-a-number")).toBe(10);
        expect(parseDepth(Number.NaN)).toBe(10);
        expect(parseDepth(Number.POSITIVE_INFINITY)).toBe(10);
    });
    it("clamps to minimum 1", () => {
        expect(parseDepth(0)).toBe(10);
        expect(parseDepth(-5)).toBe(10);
    });
});

describe("Fix 15 — get_orderbook handler", () => {
    it("errors when product_id is missing", async () => {
        const cb = vi.fn();
        const out = await getOrderbookAction.handler!(
            makeRuntime(),
            makeMemory("show me the order book"),
            undefined,
            {},
            cb,
        );
        expect(out).toBe(false);
        expect(cb.mock.calls[0][0].text).toMatch(/product_id.*required/i);
    });

    it("returns top-N bids + asks for BTCUSDT with depth 5", async () => {
        extractAssetMentions.mockReturnValue(["BTC"]);
        fetchDepth.mockResolvedValueOnce({
            lastUpdateId: 12345,
            bids: [
                ["60000", "1"],
                ["59999", "2"],
                ["59998", "3"],
                ["59997", "4"],
                ["59996", "5"],
            ],
            asks: [
                ["60001", "1"],
                ["60002", "2"],
                ["60003", "3"],
                ["60004", "4"],
                ["60005", "5"],
            ],
        });

        const cb = vi.fn();
        await getOrderbookAction.handler!(
            makeRuntime(),
            makeMemory("BTC order book"),
            undefined,
            { product_id: "BTCUSDT", depth: 5 },
            cb,
        );
        const resp = cb.mock.calls[0][0];
        expect(resp.type).toBe("get_orderbook");
        expect(resp.content.bids).toHaveLength(5);
        expect(resp.content.asks).toHaveLength(5);
        expect(resp.content.depth).toBe(5);
        expect(fetchDepth).toHaveBeenCalledWith("BTCUSDT", 5);
        expect(resp.text).toContain("Order book — BTCUSDT");
        expect(resp.text).toMatch(/_Source: Binance order book @ \d{4}/);
    });

    it("clamps depth=200 to 100 before calling the venue", async () => {
        extractAssetMentions.mockReturnValue(["BTC"]);
        fetchDepth.mockResolvedValueOnce({
            lastUpdateId: 1,
            bids: Array.from({ length: 100 }, (_, i) => [
                String(60000 - i),
                "1",
            ]) as Array<[string, string]>,
            asks: Array.from({ length: 100 }, (_, i) => [
                String(60001 + i),
                "1",
            ]) as Array<[string, string]>,
        });

        const cb = vi.fn();
        await getOrderbookAction.handler!(
            makeRuntime(),
            makeMemory("BTC depth"),
            undefined,
            { product_id: "BTCUSDT", depth: 200 },
            cb,
        );
        expect(fetchDepth).toHaveBeenCalledWith("BTCUSDT", 100);
        const resp = cb.mock.calls[0][0];
        expect(resp.content.depth).toBe(100);
        expect(resp.content.bids).toHaveLength(100);
    });

    it("REFUSES when the symbol guard finds an extractor mismatch", async () => {
        extractAssetMentions.mockReturnValueOnce(["BTC"]);
        const cb = vi.fn();
        await getOrderbookAction.handler!(
            makeRuntime(),
            makeMemory("BTC order book"),
            undefined,
            { product_id: "BNBUSDT" },
            cb,
        );
        const resp = cb.mock.calls[0][0];
        expect(resp.type).toBe("get_orderbook_clarification");
        expect(resp.text).toContain("You asked about BTC");
        expect(resp.text).toContain("BNBUSDT");
        expect(fetchDepth).not.toHaveBeenCalled();
    });

    it("allows `yes, BNBUSDT` override to bypass the guard", async () => {
        fetchDepth.mockResolvedValueOnce({
            lastUpdateId: 99,
            bids: [["300", "1"]],
            asks: [["301", "1"]],
        });
        const cb = vi.fn();
        await getOrderbookAction.handler!(
            makeRuntime(),
            makeMemory("yes, BNBUSDT"),
            undefined,
            { product_id: "BNBUSDT" },
            cb,
        );
        const resp = cb.mock.calls[0][0];
        expect(resp.type).toBe("get_orderbook");
        expect(resp.content.symbol).toBe("BNBUSDT");
    });

    it("renders a friendly note when fetchDepth returns null", async () => {
        extractAssetMentions.mockReturnValue(["BTC"]);
        fetchDepth.mockResolvedValueOnce(null);
        const cb = vi.fn();
        await getOrderbookAction.handler!(
            makeRuntime(),
            makeMemory("BTC orderbook"),
            undefined,
            { product_id: "BTCUSDT" },
            cb,
        );
        const resp = cb.mock.calls[0][0];
        expect(resp.text).toContain("Couldn't fetch the order book for BTCUSDT");
        expect(resp.content.error).toBe("venue returned no data");
    });
});

describe("Fix 15 — renderOrderbookTable", () => {
    it("includes the source line and pads to `depth` rows on partial books", () => {
        const out = renderOrderbookTable({
            symbol: "BTCUSDT",
            depth: 3,
            bids: [["60000", "1"]],
            asks: [["60001", "1"], ["60002", "1"]],
            asOf: "2026-05-22T01:23:45.678Z",
            lastUpdateId: 1,
        });
        // 3 row lines requested → 3 rows in body (with em-dash padding).
        const rows = out.split("\n").filter((l) => /^\| \d+ \|/.test(l));
        expect(rows).toHaveLength(3);
        expect(out).toContain("_Source: Binance order book @ 2026-05-22T01:23:45.678Z, freshness: <5s_");
    });
});
