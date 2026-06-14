/**
 * CEX post-PR237 Commit 11 — Venue-aware dispatcher tests.
 *
 * The contract under test:
 *   - venue=binance → Binance API URL, concat symbol form
 *   - venue=coinbase → Coinbase API URL, dash symbol form
 *   - unknown venue → Binance fallback (with a warn log)
 *
 * We mock `httpClient.get` and assert which URL was called for each
 * dispatch. Anyone touching the dispatcher MUST keep this test green —
 * the user reported they wanted hard guarantees that data for
 * Binance/Coinbase users comes from the matching exchange API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import {
    fetch24hStatsForVenue,
    fetchBookTickerForVenue,
    fetchDepthForVenue,
    toBinanceSymbol,
    toCoinbaseSymbol,
} from "../src/marketdata/venuePricingDispatcher";
import { __resetBinancePricingCacheForTests } from "../src/exchanges/services/binancePricing";
import { __resetCoinbasePricingCacheForTests } from "../src/exchanges/services/coinbasePricing";

const mockedGet = httpClient.get as ReturnType<typeof vi.fn>;

describe("toBinanceSymbol / toCoinbaseSymbol normalization", () => {
    it("Binance form strips separators", () => {
        expect(toBinanceSymbol("BTC-USDT")).toBe("BTCUSDT");
        expect(toBinanceSymbol("BTC/USDT")).toBe("BTCUSDT");
        expect(toBinanceSymbol("btcusdt")).toBe("BTCUSDT");
    });

    it("Coinbase form adds the dash", () => {
        expect(toCoinbaseSymbol("BTCUSDT")).toBe("BTC-USDT");
        expect(toCoinbaseSymbol("BTC/USDT")).toBe("BTC-USDT");
        expect(toCoinbaseSymbol("btc-usdt")).toBe("BTC-USDT");
    });
});

describe("fetchBookTickerForVenue", () => {
    beforeEach(() => {
        __resetBinancePricingCacheForTests();
        __resetCoinbasePricingCacheForTests();
        mockedGet.mockReset();
    });

    afterEach(() => {
        __resetBinancePricingCacheForTests();
        __resetCoinbasePricingCacheForTests();
    });

    it("venue=binance routes to Binance API with concat symbol", async () => {
        mockedGet.mockResolvedValueOnce({
            data: {
                bidPrice: "70999",
                bidQty: "0.5",
                askPrice: "71001",
                askQty: "0.5",
            },
        });
        const out = await fetchBookTickerForVenue({
            venue: "binance",
            symbol: "BTC-USDT",
        });
        expect(out?.bid).toBe("70999");
        const url = mockedGet.mock.calls[0][0] as string;
        expect(url).toContain("api.binance.com");
        expect(url).not.toContain("coinbase");
        const params = mockedGet.mock.calls[0][1] as { params?: { symbol?: string } };
        expect(params?.params?.symbol).toBe("BTCUSDT");
    });

    it("venue=coinbase routes to Coinbase API with dash symbol", async () => {
        mockedGet.mockResolvedValueOnce({
            data: {
                bid: "70999",
                ask: "71001",
                size: "0.5",
            },
        });
        const out = await fetchBookTickerForVenue({
            venue: "coinbase",
            symbol: "BTCUSDT",
        });
        expect(out?.bid).toBe("70999");
        const url = mockedGet.mock.calls[0][0] as string;
        expect(url).toContain("api.exchange.coinbase.com");
        expect(url).toContain("BTC-USDT");
        expect(url).not.toContain("binance");
    });

    it("unknown venue falls back to Binance", async () => {
        mockedGet.mockResolvedValueOnce({
            data: {
                bidPrice: "70999",
                bidQty: "0.5",
                askPrice: "71001",
                askQty: "0.5",
            },
        });
        const out = await fetchBookTickerForVenue({
            venue: "kraken",
            symbol: "BTC-USDT",
        });
        expect(out?.bid).toBe("70999");
        const url = mockedGet.mock.calls[0][0] as string;
        expect(url).toContain("api.binance.com");
    });
});

describe("fetchDepthForVenue", () => {
    beforeEach(() => {
        __resetBinancePricingCacheForTests();
        __resetCoinbasePricingCacheForTests();
        mockedGet.mockReset();
    });

    it("venue=coinbase routes to Coinbase depth endpoint", async () => {
        mockedGet.mockResolvedValueOnce({
            data: {
                sequence: 1,
                bids: [["70999", "0.1", 1]],
                asks: [["71001", "0.1", 1]],
            },
        });
        const out = await fetchDepthForVenue({
            venue: "coinbase",
            symbol: "BTC-USDT",
            limit: 5,
        });
        expect(out?.bids).toHaveLength(1);
        const url = mockedGet.mock.calls[0][0] as string;
        expect(url).toContain("api.exchange.coinbase.com");
        expect(url).toContain("BTC-USDT");
    });

    it("venue=binance routes to Binance depth endpoint", async () => {
        mockedGet.mockResolvedValueOnce({
            data: {
                bids: [["70999", "0.1"]],
                asks: [["71001", "0.1"]],
                lastUpdateId: 1,
            },
        });
        const out = await fetchDepthForVenue({
            venue: "binance",
            symbol: "BTC/USDT",
            limit: 5,
        });
        expect(out?.bids).toHaveLength(1);
        const url = mockedGet.mock.calls[0][0] as string;
        expect(url).toContain("api.binance.com");
    });
});

describe("fetch24hStatsForVenue", () => {
    beforeEach(() => {
        __resetBinancePricingCacheForTests();
        __resetCoinbasePricingCacheForTests();
        mockedGet.mockReset();
    });

    it("venue=coinbase computes priceChangePercent from open/last", async () => {
        mockedGet.mockResolvedValueOnce({
            data: {
                open: "70000",
                high: "72000",
                low: "69000",
                last: "71400",
                volume: "1000",
            },
        });
        const out = await fetch24hStatsForVenue({
            venue: "coinbase",
            symbol: "BTC-USDT",
        });
        expect(Number.parseFloat(out!.priceChangePercent)).toBeCloseTo(2, 4);
        const url = mockedGet.mock.calls[0][0] as string;
        expect(url).toContain("api.exchange.coinbase.com");
    });

    it("venue=binance returns priceChangePercent verbatim", async () => {
        mockedGet.mockResolvedValueOnce({
            data: {
                priceChangePercent: "2.5",
                weightedAvgPrice: "71000",
                highPrice: "72000",
                lowPrice: "69000",
                volume: "1000",
                quoteVolume: "71000000",
                openTime: 1,
                closeTime: 2,
            },
        });
        const out = await fetch24hStatsForVenue({
            venue: "binance",
            symbol: "BTCUSDT",
        });
        expect(out?.priceChangePercent).toBe("2.5");
        const url = mockedGet.mock.calls[0][0] as string;
        expect(url).toContain("api.binance.com");
    });
});

describe("venue failover when the primary venue's public API is unavailable", () => {
    // Repro of the reported bug: on a host where Binance public market-data
    // is geo-blocked (HTTP 451), the approval modal's snapshot came back
    // empty → slider stuck at 0% + no limit-prefill price. The dispatcher
    // must fail over to the OTHER venue so callers still get live data.
    beforeEach(() => {
        __resetBinancePricingCacheForTests();
        __resetCoinbasePricingCacheForTests();
        mockedGet.mockReset();
    });
    afterEach(() => {
        __resetBinancePricingCacheForTests();
        __resetCoinbasePricingCacheForTests();
    });

    it("fails over Binance→Coinbase when Binance book-ticker is blocked (451)", async () => {
        mockedGet
            .mockRejectedValueOnce(
                Object.assign(new Error("Request failed with status code 451"), {
                    response: { status: 451 },
                }),
            )
            .mockResolvedValueOnce({
                data: { bid: "70999", ask: "71001", size: "0.5" },
            });
        const out = await fetchBookTickerForVenue({
            venue: "binance",
            symbol: "BTCUSDT",
        });
        expect(out?.bid).toBe("70999");
        const urls = mockedGet.mock.calls.map((c) => c[0] as string);
        expect(urls[0]).toContain("api.binance.com");
        expect(urls[1]).toContain("api.exchange.coinbase.com");
    });

    it("fails over Binance→Coinbase for 24h stats too", async () => {
        mockedGet
            .mockRejectedValueOnce(
                Object.assign(new Error("status code 451"), {
                    response: { status: 451 },
                }),
            )
            .mockResolvedValueOnce({
                data: {
                    open: "70000",
                    high: "72000",
                    low: "69000",
                    last: "71400",
                    volume: "1000",
                },
            });
        const out = await fetch24hStatsForVenue({
            venue: "binance",
            symbol: "BTCUSDT",
        });
        expect(out).not.toBeNull();
        expect(Number.parseFloat(out!.priceChangePercent)).toBeCloseTo(2, 4);
        const urls = mockedGet.mock.calls.map((c) => c[0] as string);
        expect(urls.some((u) => u.includes("api.exchange.coinbase.com"))).toBe(true);
    });

    it("does NOT fail over when the primary venue succeeds (single call)", async () => {
        mockedGet.mockResolvedValueOnce({
            data: {
                bidPrice: "70999",
                bidQty: "0.5",
                askPrice: "71001",
                askQty: "0.5",
            },
        });
        const out = await fetchBookTickerForVenue({
            venue: "binance",
            symbol: "BTCUSDT",
        });
        expect(out?.bid).toBe("70999");
        expect(mockedGet).toHaveBeenCalledTimes(1);
    });
});
