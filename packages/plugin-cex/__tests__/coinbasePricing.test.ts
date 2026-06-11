/**
 * CEX post-PR237 Commit 11 — Coinbase pricing helper tests.
 *
 * Validates the public-endpoint counterparts of binancePricing.ts so
 * a Coinbase user gets Coinbase data from the order-editor modal,
 * not Binance data (which was the bug shipped before this commit).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    __resetCoinbasePricingCacheForTests,
    fetch24hStatsCoinbase,
    fetchBookTickerCoinbase,
    fetchDepthCoinbase,
    toCoinbaseProductId,
} from "../src/exchanges/services/coinbasePricing";

vi.mock("@elizaos/core", async () => {
    const actual = await vi.importActual<Record<string, unknown>>("@elizaos/core");
    return {
        ...actual,
        elizaLogger: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        },
        formatAxiosErrorLine: (err: unknown) =>
            err instanceof Error ? err.message : String(err),
        httpClient: {
            get: vi.fn(),
        },
    };
});

import { httpClient } from "@elizaos/core";

const mockedGet = httpClient.get as ReturnType<typeof vi.fn>;

describe("toCoinbaseProductId — symbol normalization", () => {
    it("passes through dash form", () => {
        expect(toCoinbaseProductId("BTC-USDT")).toBe("BTC-USDT");
        expect(toCoinbaseProductId("eth-usd")).toBe("ETH-USD");
    });

    it("converts slash form", () => {
        expect(toCoinbaseProductId("BTC/USDT")).toBe("BTC-USDT");
    });

    it("converts concat form by splitting on trailing quote", () => {
        expect(toCoinbaseProductId("BTCUSDT")).toBe("BTC-USDT");
        expect(toCoinbaseProductId("ETHUSD")).toBe("ETH-USD");
        expect(toCoinbaseProductId("SOLUSDC")).toBe("SOL-USDC");
    });

    it("rejects bare base assets without a quote suffix", () => {
        expect(toCoinbaseProductId("BTC")).toBeNull();
        expect(toCoinbaseProductId("")).toBeNull();
        expect(toCoinbaseProductId("    ")).toBeNull();
    });
});

describe("fetchBookTickerCoinbase", () => {
    beforeEach(() => {
        __resetCoinbasePricingCacheForTests();
        mockedGet.mockReset();
    });

    afterEach(() => {
        __resetCoinbasePricingCacheForTests();
    });

    it("returns BookTickerSnapshot shape on success", async () => {
        mockedGet.mockResolvedValueOnce({
            data: {
                trade_id: 1,
                price: "71000",
                size: "0.5",
                bid: "70999",
                ask: "71001",
                volume: "1000",
            },
        });
        const out = await fetchBookTickerCoinbase("BTC-USDT");
        expect(out).not.toBeNull();
        expect(out?.bid).toBe("70999");
        expect(out?.ask).toBe("71001");
        // spread = (71001 - 70999) / ((71001+70999)/2) * 10000
        // = 2 / 71000 * 10000 ≈ 0.2817 bps
        expect(out?.spread_bps).toBeGreaterThan(0);
        expect(out?.spread_bps).toBeLessThan(1);
        // URL must hit coinbase, not binance.
        expect(mockedGet).toHaveBeenCalledTimes(1);
        const calledUrl = mockedGet.mock.calls[0][0] as string;
        expect(calledUrl).toContain("api.exchange.coinbase.com");
        expect(calledUrl).toContain("BTC-USDT");
    });

    it("returns null when the body is missing bid/ask", async () => {
        mockedGet.mockResolvedValueOnce({ data: { price: "1" } });
        const out = await fetchBookTickerCoinbase("BTC-USDT");
        expect(out).toBeNull();
    });

    it("returns null when the network call rejects", async () => {
        mockedGet.mockRejectedValueOnce(new Error("network error"));
        const out = await fetchBookTickerCoinbase("BTC-USDT");
        expect(out).toBeNull();
    });

    it("returns null for unrecognized symbol forms", async () => {
        const out = await fetchBookTickerCoinbase("UNKNOWN");
        expect(out).toBeNull();
        expect(mockedGet).not.toHaveBeenCalled();
    });
});

describe("fetchDepthCoinbase", () => {
    beforeEach(() => {
        __resetCoinbasePricingCacheForTests();
        mockedGet.mockReset();
    });

    it("returns DepthSnapshot with top-N levels", async () => {
        mockedGet.mockResolvedValueOnce({
            data: {
                sequence: 12345,
                bids: [
                    ["70999", "0.1", 1],
                    ["70998", "0.2", 1],
                    ["70997", "0.3", 1],
                ],
                asks: [
                    ["71001", "0.1", 1],
                    ["71002", "0.2", 1],
                    ["71003", "0.3", 1],
                ],
            },
        });
        const out = await fetchDepthCoinbase("BTC-USDT", 2);
        expect(out).not.toBeNull();
        expect(out?.bids).toEqual([
            ["70999", "0.1"],
            ["70998", "0.2"],
        ]);
        expect(out?.asks).toEqual([
            ["71001", "0.1"],
            ["71002", "0.2"],
        ]);
        expect(out?.lastUpdateId).toBe(12345);
        const calledUrl = mockedGet.mock.calls[0][0] as string;
        expect(calledUrl).toContain("api.exchange.coinbase.com");
        expect(calledUrl).toContain("BTC-USDT");
    });
});

describe("fetch24hStatsCoinbase", () => {
    beforeEach(() => {
        __resetCoinbasePricingCacheForTests();
        mockedGet.mockReset();
    });

    it("computes priceChangePercent from open/last", async () => {
        mockedGet.mockResolvedValueOnce({
            data: {
                open: "70000",
                high: "72000",
                low: "69000",
                last: "71400",
                volume: "1000",
            },
        });
        const out = await fetch24hStatsCoinbase("BTC-USDT");
        expect(out).not.toBeNull();
        // (71400 - 70000) / 70000 * 100 = 2.0
        expect(Number.parseFloat(out!.priceChangePercent)).toBeCloseTo(2, 5);
        expect(out?.highPrice).toBe("72000");
        expect(out?.lowPrice).toBe("69000");
        expect(out?.volume).toBe("1000");
    });

    it("returns null when required fields are missing", async () => {
        mockedGet.mockResolvedValueOnce({ data: { open: "70000" } });
        const out = await fetch24hStatsCoinbase("BTC-USDT");
        expect(out).toBeNull();
    });
});

describe("Coinbase pricing — 5-second per-process cache", () => {
    beforeEach(() => {
        __resetCoinbasePricingCacheForTests();
        mockedGet.mockReset();
    });

    it("two consecutive calls for the same symbol fire ONE network request", async () => {
        mockedGet.mockResolvedValue({
            data: {
                bid: "70999",
                ask: "71001",
                size: "0.5",
                price: "71000",
                volume: "1000",
            },
        });
        const a = await fetchBookTickerCoinbase("BTC-USDT");
        const b = await fetchBookTickerCoinbase("BTC-USDT");
        expect(a?.bid).toBe("70999");
        expect(b?.bid).toBe("70999");
        expect(mockedGet).toHaveBeenCalledTimes(1);
    });
});
