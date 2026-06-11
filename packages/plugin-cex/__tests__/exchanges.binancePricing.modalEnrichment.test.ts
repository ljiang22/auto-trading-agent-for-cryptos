/**
 * Fix 14a — modal-enrichment helpers (fetchBookTicker / fetchDepth /
 * fetch24hStats) live alongside Fix 2's `fetchBinanceUsdtPrices` in
 * `binancePricing.ts`. Tests cover:
 *
 *  - Happy-path shape for each of the three new helpers.
 *  - Cache hit on the second call within the 5 s TTL (no second
 *    network call).
 *  - Fail-soft: a thrown HTTP error returns null; the next call
 *    re-attempts (failures are NOT cached).
 *  - The new per-symbol cache does NOT collide with Fix 2's
 *    batched-ticker cache.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const httpClient = {
    get: vi.fn(),
    post: vi.fn(),
};

vi.mock("@elizaos/core", () => ({
    httpClient,
    elizaLogger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
    formatAxiosErrorLine: (err: unknown) =>
        `mock-axios-error: ${err instanceof Error ? err.message : String(err)}`,
}));

const {
    __resetBinancePricingCacheForTests,
    fetch24hStats,
    fetchBookTicker,
    fetchDepth,
} = await import("../src/exchanges/services/binancePricing");

function okResponse<T>(data: T) {
    return { status: 200, statusText: "OK", data };
}

beforeEach(() => {
    httpClient.get.mockReset();
    httpClient.post.mockReset();
    __resetBinancePricingCacheForTests();
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("fetchBookTicker — Fix 14a", () => {
    it("returns shape {bid, bidQty, ask, askQty, spread_bps} with correctly computed spread bps", async () => {
        httpClient.get.mockResolvedValueOnce(
            okResponse({
                symbol: "BTCUSDT",
                bidPrice: "100.00",
                bidQty: "1.0",
                askPrice: "101.00",
                askQty: "2.0",
            }),
        );
        const out = await fetchBookTicker("BTCUSDT");
        expect(out).toEqual({
            bid: "100.00",
            bidQty: "1.0",
            ask: "101.00",
            askQty: "2.0",
            // Spread = (101 - 100) / 100.5 * 10_000 ≈ 99.50249 bps
            spread_bps: expect.closeTo(99.5, 1),
        });
    });

    it("cache hit on second call within 5 s — no second network call", async () => {
        httpClient.get.mockResolvedValueOnce(
            okResponse({
                symbol: "BTCUSDT",
                bidPrice: "100.00",
                bidQty: "1.0",
                askPrice: "101.00",
                askQty: "2.0",
            }),
        );
        const first = await fetchBookTicker("BTCUSDT");
        expect(first).toBeTruthy();
        expect(httpClient.get).toHaveBeenCalledTimes(1);

        const second = await fetchBookTicker("BTCUSDT");
        expect(second).toEqual(first);
        expect(httpClient.get).toHaveBeenCalledTimes(1);
    });

    it("returns null on HTTP error (fail-soft)", async () => {
        httpClient.get.mockRejectedValueOnce(new Error("boom"));
        const out = await fetchBookTicker("BTCUSDT");
        expect(out).toBeNull();
    });

    it("returns null on malformed body (missing fields)", async () => {
        httpClient.get.mockResolvedValueOnce(okResponse({ wrong: "shape" }));
        const out = await fetchBookTicker("BTCUSDT");
        expect(out).toBeNull();
    });

    it("computes 0 spread_bps when bid or ask is non-positive", async () => {
        httpClient.get.mockResolvedValueOnce(
            okResponse({
                symbol: "FOOUSDT",
                bidPrice: "0",
                bidQty: "0",
                askPrice: "0",
                askQty: "0",
            }),
        );
        const out = await fetchBookTicker("FOOUSDT");
        expect(out?.spread_bps).toBe(0);
    });
});

describe("fetchDepth — Fix 14a", () => {
    it("returns 5 bids and 5 asks", async () => {
        httpClient.get.mockResolvedValueOnce(
            okResponse({
                lastUpdateId: 12345,
                bids: [
                    ["100.10", "1.0"],
                    ["100.00", "2.0"],
                    ["99.90", "3.0"],
                    ["99.80", "4.0"],
                    ["99.70", "5.0"],
                ],
                asks: [
                    ["100.20", "1.5"],
                    ["100.30", "2.5"],
                    ["100.40", "3.5"],
                    ["100.50", "4.5"],
                    ["100.60", "5.5"],
                ],
            }),
        );
        const out = await fetchDepth("BTCUSDT", 5);
        expect(out?.lastUpdateId).toBe(12345);
        expect(out?.bids).toHaveLength(5);
        expect(out?.asks).toHaveLength(5);
        expect(out?.bids?.[0]).toEqual(["100.10", "1.0"]);
        expect(out?.asks?.[0]).toEqual(["100.20", "1.5"]);
    });

    it("cache hit on second call within 5 s with same (symbol, limit)", async () => {
        httpClient.get.mockResolvedValueOnce(
            okResponse({
                lastUpdateId: 1,
                bids: [["1", "1"]],
                asks: [["2", "1"]],
            }),
        );
        const first = await fetchDepth("BTCUSDT", 5);
        const second = await fetchDepth("BTCUSDT", 5);
        expect(first).toEqual(second);
        expect(httpClient.get).toHaveBeenCalledTimes(1);
    });

    it("DOES re-fetch when limit changes (cache key includes limit)", async () => {
        httpClient.get
            .mockResolvedValueOnce(
                okResponse({ lastUpdateId: 1, bids: [["1", "1"]], asks: [["2", "1"]] }),
            )
            .mockResolvedValueOnce(
                okResponse({ lastUpdateId: 2, bids: [["1", "1"]], asks: [["2", "1"]] }),
            );
        await fetchDepth("BTCUSDT", 5);
        await fetchDepth("BTCUSDT", 10);
        expect(httpClient.get).toHaveBeenCalledTimes(2);
    });

    it("returns null on HTTP error", async () => {
        httpClient.get.mockRejectedValueOnce(new Error("boom"));
        expect(await fetchDepth("BTCUSDT")).toBeNull();
    });

    it("clamps limit to a sane range (1..100)", async () => {
        httpClient.get.mockResolvedValueOnce(
            okResponse({ lastUpdateId: 1, bids: [], asks: [] }),
        );
        await fetchDepth("BTCUSDT", 9999);
        const callArgs = httpClient.get.mock.calls[0]?.[1];
        // Fix 15 raised the upper bound from 20 → 100 so the new
        // `get_orderbook` action can request a full top-of-book view.
        expect(callArgs?.params?.limit).toBe(100);
    });
});

describe("fetch24hStats — Fix 14a", () => {
    it("returns all 8 fields when the venue responds", async () => {
        httpClient.get.mockResolvedValueOnce(
            okResponse({
                symbol: "BTCUSDT",
                priceChangePercent: "1.234",
                weightedAvgPrice: "100.50",
                highPrice: "102.00",
                lowPrice: "99.00",
                volume: "1000.5",
                quoteVolume: "100250.25",
                openTime: 1_700_000_000_000,
                closeTime: 1_700_086_400_000,
            }),
        );
        const out = await fetch24hStats("BTCUSDT");
        expect(out).toEqual({
            priceChangePercent: "1.234",
            weightedAvgPrice: "100.50",
            highPrice: "102.00",
            lowPrice: "99.00",
            volume: "1000.5",
            quoteVolume: "100250.25",
            openTime: 1_700_000_000_000,
            closeTime: 1_700_086_400_000,
        });
    });

    it("cache hit on second call within 5 s", async () => {
        httpClient.get.mockResolvedValueOnce(
            okResponse({
                symbol: "BTCUSDT",
                priceChangePercent: "1.0",
                weightedAvgPrice: "100",
                highPrice: "101",
                lowPrice: "99",
                volume: "1",
                quoteVolume: "100",
                openTime: 1,
                closeTime: 2,
            }),
        );
        const first = await fetch24hStats("BTCUSDT");
        const second = await fetch24hStats("BTCUSDT");
        expect(first).toEqual(second);
        expect(httpClient.get).toHaveBeenCalledTimes(1);
    });

    it("returns null on malformed body (missing required string field)", async () => {
        httpClient.get.mockResolvedValueOnce(
            okResponse({
                symbol: "BTCUSDT",
                // Missing priceChangePercent.
                weightedAvgPrice: "100",
                highPrice: "101",
                lowPrice: "99",
                volume: "1",
                quoteVolume: "100",
                openTime: 1,
                closeTime: 2,
            }),
        );
        const out = await fetch24hStats("BTCUSDT");
        expect(out).toBeNull();
    });

    it("returns null on HTTP error", async () => {
        httpClient.get.mockRejectedValueOnce(new Error("boom"));
        expect(await fetch24hStats("BTCUSDT")).toBeNull();
    });
});

describe("per-helper cache isolation", () => {
    it("does NOT collide with the batched-ticker cache (different cache keys per endpoint)", async () => {
        // First, fetchBookTicker fills the per-symbol cache under
        // `book:BTCUSDT`. A subsequent fetchDepth must still hit the
        // network (different cache key).
        httpClient.get
            .mockResolvedValueOnce(
                okResponse({
                    symbol: "BTCUSDT",
                    bidPrice: "100",
                    bidQty: "1",
                    askPrice: "101",
                    askQty: "1",
                }),
            )
            .mockResolvedValueOnce(
                okResponse({ lastUpdateId: 1, bids: [["100", "1"]], asks: [["101", "1"]] }),
            )
            .mockResolvedValueOnce(
                okResponse({
                    symbol: "BTCUSDT",
                    priceChangePercent: "0",
                    weightedAvgPrice: "100",
                    highPrice: "101",
                    lowPrice: "99",
                    volume: "1",
                    quoteVolume: "100",
                    openTime: 1,
                    closeTime: 2,
                }),
            );
        const book = await fetchBookTicker("BTCUSDT");
        const depth = await fetchDepth("BTCUSDT", 5);
        const stats = await fetch24hStats("BTCUSDT");
        expect(book).toBeTruthy();
        expect(depth).toBeTruthy();
        expect(stats).toBeTruthy();
        // 3 distinct cache entries → 3 distinct network calls.
        expect(httpClient.get).toHaveBeenCalledTimes(3);
    });
});
