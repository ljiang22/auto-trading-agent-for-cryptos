import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const httpClient = {
    get: vi.fn(),
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

// Import AFTER mocking so the helper binds to the mocked httpClient.
const {
    __resetBinancePricingCacheForTests,
    fetchBinanceUsdtPrices,
    isStablecoin,
} = await import("../src/exchanges/services/binancePricing");

function okResponse<T>(data: T) {
    return { status: 200, statusText: "OK", data };
}

describe("fetchBinanceUsdtPrices", () => {
    beforeEach(() => {
        __resetBinancePricingCacheForTests();
        httpClient.get.mockReset();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it("returns base-asset keyed USDT prices for the requested symbols", async () => {
        httpClient.get.mockResolvedValueOnce(
            okResponse([
                { symbol: "BTCUSDT", price: "76955.00" },
                { symbol: "ETHUSDT", price: "3500.50" },
            ]),
        );

        const prices = await fetchBinanceUsdtPrices(["BTC", "ETH"]);

        expect(prices).toEqual({ BTC: 76955, ETH: 3500.5 });
        expect(httpClient.get).toHaveBeenCalledTimes(1);
        const [url, opts] = httpClient.get.mock.calls[0] as [
            string,
            { params: { symbols: string } },
        ];
        expect(url).toBe("https://api.binance.com/api/v3/ticker/price");
        // Batched form: URL-encoded JSON array of trading pairs.
        expect(opts.params.symbols).toBe(JSON.stringify(["BTCUSDT", "ETHUSDT"]));
    });

    it("caches results for 5 s — a second call with the same set does not hit the network", async () => {
        httpClient.get.mockResolvedValueOnce(
            okResponse([{ symbol: "BTCUSDT", price: "76955.00" }]),
        );

        const first = await fetchBinanceUsdtPrices(["BTC"]);
        const second = await fetchBinanceUsdtPrices(["BTC"]);

        expect(first).toEqual({ BTC: 76955 });
        expect(second).toEqual({ BTC: 76955 });
        expect(httpClient.get).toHaveBeenCalledTimes(1);
    });

    it("normalizes order and case in the cache key", async () => {
        httpClient.get.mockResolvedValueOnce(
            okResponse([
                { symbol: "BTCUSDT", price: "1" },
                { symbol: "ETHUSDT", price: "2" },
            ]),
        );

        await fetchBinanceUsdtPrices(["btc", "eth"]);
        // Different order, different case — same cache slot.
        await fetchBinanceUsdtPrices(["ETH", "BTC"]);

        expect(httpClient.get).toHaveBeenCalledTimes(1);
    });

    it("returns {} on empty input without making a network call", async () => {
        const prices = await fetchBinanceUsdtPrices([]);
        expect(prices).toEqual({});
        expect(httpClient.get).not.toHaveBeenCalled();
    });

    it("returns {} on network failure (does not throw)", async () => {
        httpClient.get.mockRejectedValueOnce(new Error("network down"));

        const prices = await fetchBinanceUsdtPrices(["BTC"]);

        expect(prices).toEqual({});
    });

    it("returns {} on non-array body shape", async () => {
        httpClient.get.mockResolvedValueOnce(okResponse({ error: "bad request" }));

        const prices = await fetchBinanceUsdtPrices(["BTC"]);

        expect(prices).toEqual({});
    });

    it("skips rows with non-USDT pairs or malformed price strings", async () => {
        httpClient.get.mockResolvedValueOnce(
            okResponse([
                { symbol: "BTCUSDT", price: "76955.00" },
                { symbol: "ETHBTC", price: "0.05" }, // non-USDT pair: ignored
                { symbol: "SOLUSDT", price: "not-a-number" }, // bad parse: ignored
                { symbol: "ADAUSDT", price: "0" }, // zero: ignored
            ]),
        );

        const prices = await fetchBinanceUsdtPrices(["BTC", "ETH", "SOL", "ADA"]);

        expect(prices).toEqual({ BTC: 76955 });
    });

    it("conversion math: 0.001 BTC at 76955 ~= 76.955 USDT (rounds to 76.96)", async () => {
        httpClient.get.mockResolvedValueOnce(
            okResponse([{ symbol: "BTCUSDT", price: "76955.00" }]),
        );

        const prices = await fetchBinanceUsdtPrices(["BTC"]);
        const quantity = 0.001;
        const usdt = quantity * (prices.BTC ?? 0);

        expect(usdt).toBeCloseTo(76.955, 3);
        // The formatter directive's contract is "round to 2 decimals" — the
        // exact rounding rule is the renderer's; this test pins the math
        // input. Using `Math.round(x * 100) / 100` (half-away-from-zero on
        // positive numbers) gives 76.96, matching the plan example.
        expect(Math.round(usdt * 100) / 100).toBe(76.96);
    });

    it("single-flights concurrent cold callers — two parallel calls fire only one network request", async () => {
        // Resolve the mock asynchronously so both callers can land in the
        // inflight branch before the network promise settles. `setImmediate`
        // hands control back to the microtask queue without resorting to a
        // real-clock timer.
        httpClient.get.mockImplementationOnce(async () => {
            await new Promise((r) => setImmediate(r));
            return okResponse([
                { symbol: "BTCUSDT", price: "76955.00" },
                { symbol: "ETHUSDT", price: "3500.50" },
            ]);
        });

        const [first, second] = await Promise.all([
            fetchBinanceUsdtPrices(["BTC", "ETH"]),
            fetchBinanceUsdtPrices(["BTC", "ETH"]),
        ]);

        expect(httpClient.get).toHaveBeenCalledTimes(1);
        expect(first).toEqual({ BTC: 76955, ETH: 3500.5 });
        expect(second).toEqual({ BTC: 76955, ETH: 3500.5 });
    });

    it("totals across mixed assets sum correctly", async () => {
        httpClient.get.mockResolvedValueOnce(
            okResponse([
                { symbol: "BTCUSDT", price: "76955.00" },
                { symbol: "ETHUSDT", price: "3500.00" },
            ]),
        );

        const prices = await fetchBinanceUsdtPrices(["BTC", "ETH"]);

        // Simulate the get_balance enrichment math the way shared.ts does it.
        const rows = [
            { asset: "BTC", total: 0.001 }, // 76.955
            { asset: "ETH", total: 0.5 }, // 1750
            { asset: "USDT", total: 250 }, // stablecoin: 250
            { asset: "XYZ", total: 42 }, // no quote: skipped
        ];
        let totalUsdt = 0;
        for (const row of rows) {
            let price: number | null;
            if (isStablecoin(row.asset)) price = 1.0;
            else if (typeof prices[row.asset] === "number") price = prices[row.asset];
            else price = null;
            if (price !== null) totalUsdt += row.total * price;
        }

        // 76.955 + 1750 + 250 = 2076.955
        expect(totalUsdt).toBeCloseTo(2076.955, 3);
    });
});
