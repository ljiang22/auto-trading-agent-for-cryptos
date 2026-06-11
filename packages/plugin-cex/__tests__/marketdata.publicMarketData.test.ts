import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
    fetchPublicTradableProducts,
    fetchPublicMidPrice,
    __resetPublicMarketDataCaches,
} from "../src/marketdata/publicMarketData";

const realFetch = globalThis.fetch;

function mockExchangeInfoResponse(extra: Partial<{
    btcUsdt: { permissions: string[]; status: string; isSpotTradingAllowed: boolean };
    ethUsdt: { permissions: string[]; status: string };
    altPair: { permissions: string[] };
}> = {}): { ok: boolean; json: () => Promise<unknown> } {
    return {
        ok: true,
        json: async () => ({
            symbols: [
                {
                    symbol: "BTCUSDT",
                    baseAsset: "BTC",
                    quoteAsset: "USDT",
                    status: extra.btcUsdt?.status ?? "TRADING",
                    isSpotTradingAllowed: extra.btcUsdt?.isSpotTradingAllowed ?? true,
                    permissions: extra.btcUsdt?.permissions ?? ["SPOT", "MARGIN"],
                },
                {
                    symbol: "ETHUSDT",
                    baseAsset: "ETH",
                    quoteAsset: "USDT",
                    status: extra.ethUsdt?.status ?? "TRADING",
                    isSpotTradingAllowed: true,
                    permissions: extra.ethUsdt?.permissions ?? ["SPOT", "MARGIN"],
                },
                {
                    symbol: "AKROUSDT",
                    baseAsset: "AKRO",
                    quoteAsset: "USDT",
                    status: "TRADING",
                    isSpotTradingAllowed: true,
                    permissions: extra.altPair?.permissions ?? ["SPOT"],
                },
                {
                    symbol: "FUTUREONLY",
                    baseAsset: "FUTUREONLY",
                    quoteAsset: "BNB", // Filtered: BNB isn't in SUPPORTED_QUOTE_ASSETS
                    status: "TRADING",
                    isSpotTradingAllowed: true,
                    permissions: ["SPOT"],
                },
            ],
        }),
    };
}

beforeEach(() => {
    __resetPublicMarketDataCaches();
});

afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
});

describe("fetchPublicTradableProducts", () => {
    it("returns all USDT-quoted spot pairs when no marginType is set", async () => {
        globalThis.fetch = vi.fn().mockResolvedValueOnce(
            mockExchangeInfoResponse(),
        ) as unknown as typeof fetch;

        const out = await fetchPublicTradableProducts({ venue: "binance" });
        expect(out).not.toBeNull();
        const ids = out!.products.map((p) => p.product_id).sort();
        // AKRO is SPOT-only, included; FUTUREONLY's quote BNB isn't supported.
        expect(ids).toEqual(["AKRO-USDT", "BTC-USDT", "ETH-USDT"]);
        expect(out!.marginType).toBeUndefined();
    });

    it("filters to MARGIN-eligible pairs when marginType=cross", async () => {
        globalThis.fetch = vi.fn().mockResolvedValueOnce(
            mockExchangeInfoResponse(),
        ) as unknown as typeof fetch;

        const out = await fetchPublicTradableProducts({
            venue: "binance",
            marginType: "cross",
        });
        expect(out).not.toBeNull();
        const ids = out!.products.map((p) => p.product_id).sort();
        // AKRO has only SPOT permission, so it MUST be filtered out.
        expect(ids).toEqual(["BTC-USDT", "ETH-USDT"]);
        expect(out!.marginType).toBe("cross");
    });

    it("isolated filter behaves the same as cross on the public endpoint", async () => {
        globalThis.fetch = vi.fn().mockResolvedValueOnce(
            mockExchangeInfoResponse(),
        ) as unknown as typeof fetch;
        const out = await fetchPublicTradableProducts({
            venue: "binance",
            marginType: "isolated",
        });
        expect(out!.products.map((p) => p.product_id).sort()).toEqual(["BTC-USDT", "ETH-USDT"]);
    });

    it("returns null when Coinbase is asked for a margin pair list", async () => {
        // Should NOT call fetch — Coinbase has no margin trading per CLAUDE.md.
        const fetchSpy = vi.fn();
        globalThis.fetch = fetchSpy as unknown as typeof fetch;
        const out = await fetchPublicTradableProducts({
            venue: "coinbase",
            marginType: "cross",
        });
        expect(out).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("reuses cached symbol info across marginType variants", async () => {
        const fetchSpy = vi
            .fn()
            .mockResolvedValueOnce(mockExchangeInfoResponse());
        globalThis.fetch = fetchSpy as unknown as typeof fetch;

        const spotOut = await fetchPublicTradableProducts({ venue: "binance" });
        const marginOut = await fetchPublicTradableProducts({
            venue: "binance",
            marginType: "cross",
        });

        // Second call hit the cache — the upstream `exchangeInfo` is heavy.
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(spotOut!.products.map((p) => p.product_id)).toContain("AKRO-USDT");
        expect(marginOut!.products.map((p) => p.product_id)).not.toContain("AKRO-USDT");
    });

    it("strips non-TRADING and spot-disabled symbols", async () => {
        globalThis.fetch = vi.fn().mockResolvedValueOnce(
            mockExchangeInfoResponse({
                btcUsdt: { permissions: ["SPOT", "MARGIN"], status: "HALT", isSpotTradingAllowed: true },
                ethUsdt: { permissions: ["SPOT", "MARGIN"], status: "TRADING" },
            }),
        ) as unknown as typeof fetch;

        const out = await fetchPublicTradableProducts({ venue: "binance" });
        const ids = out!.products.map((p) => p.product_id);
        expect(ids).not.toContain("BTC-USDT");
        expect(ids).toContain("ETH-USDT");
    });

    it("returns null on upstream failure", async () => {
        globalThis.fetch = vi.fn().mockResolvedValueOnce({
            ok: false,
            json: async () => ({}),
        }) as unknown as typeof fetch;
        const out = await fetchPublicTradableProducts({ venue: "binance" });
        expect(out).toBeNull();
    });
});

describe("fetchPublicMidPrice", () => {
    it("returns the public ticker price for Binance", async () => {
        globalThis.fetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({ price: "2105.23" }),
        }) as unknown as typeof fetch;
        const p = await fetchPublicMidPrice({ venue: "binance", symbol: "ETH-USDT" });
        expect(p).toBe(2105.23);
    });

    it("returns null on non-OK responses", async () => {
        globalThis.fetch = vi.fn().mockResolvedValueOnce({
            ok: false,
            json: async () => ({}),
        }) as unknown as typeof fetch;
        const p = await fetchPublicMidPrice({ venue: "binance", symbol: "ETH-USDT" });
        expect(p).toBeNull();
    });

    it("ignores zero/negative prices", async () => {
        globalThis.fetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({ price: "0" }),
        }) as unknown as typeof fetch;
        const p = await fetchPublicMidPrice({ venue: "binance", symbol: "ETH-USDT" });
        expect(p).toBeNull();
    });
});
