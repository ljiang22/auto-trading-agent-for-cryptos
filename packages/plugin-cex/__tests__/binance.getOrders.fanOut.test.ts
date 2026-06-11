import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the pricing helper module so the >8-holdings ranking path is
// deterministic without making real network calls to api.binance.com.
// Per-test overrides via `vi.mocked(...).mockResolvedValueOnce(...)`.
vi.mock("../src/exchanges/services/binancePricing", async () => {
    const actual = await vi.importActual<
        typeof import("../src/exchanges/services/binancePricing")
    >("../src/exchanges/services/binancePricing");
    return {
        ...actual,
        fetchBinanceUsdtPrices: vi.fn(async () => ({})),
    };
});

import {
    BinanceOrdersService,
    enumerateHoldingsForFanOut,
    __resetBinanceSymbolFiltersCacheForTests,
} from "../src/exchanges/services/binance";
import {
    __resetBinancePricingCacheForTests,
    fetchBinanceUsdtPrices,
} from "../src/exchanges/services/binancePricing";

/**
 * Fix 4 + 4b — `BinanceOrdersService.getOrders` and `.getFills` now fan
 * out across the user's currently-held base assets when:
 *  - `getOrders`: no symbol AND a date window is set
 *  - `getFills`:  no `product_ids` is passed
 *
 * These tests pin the contract:
 *  - cap at 8 candidates (largest USD value wins when more)
 *  - stablecoins skipped from the base side
 *  - `quote_currency` override honored (defaults to USDT)
 *  - returned envelope shape: `{ orders|fills, scanned_symbols, note }`
 *  - `time` desc + slice to `limit ?? 50`
 *  - all-symbol failures throw so the action's catch path can render
 *    an actionable error
 */

const realFetch = globalThis.fetch;

function dataResponse<T>(value: T) {
    return Promise.resolve({ data: async () => value });
}

function mockOk(body: unknown) {
    return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify(body),
        json: async () => body,
    };
}

function mockStatus(status: number, statusText: string, body: unknown) {
    return {
        ok: false,
        status,
        statusText,
        text: async () => JSON.stringify(body),
        json: async () => body,
    };
}

/**
 * Build a ctx whose spot.getAccount returns the supplied balances. The
 * suite-level `beforeEach` stubs raw fetch (margin SAPI + ticker) with
 * sensible defaults so each test gets a clean BTC-only enumeration
 * unless overridden.
 */
function createCtx(opts: {
    spotBalances?: Array<{ asset: string; free: string; locked?: string }>;
    fundingBalances?: Array<{ asset: string; free: string; locked?: string }>;
    allOrders?: ReturnType<typeof vi.fn>;
    myTrades?: ReturnType<typeof vi.fn>;
}) {
    const spotBalances = opts.spotBalances ?? [
        { asset: "BTC", free: "0.5", locked: "0" },
        { asset: "ETH", free: "2.0", locked: "0" },
    ];
    const fundingBalances = opts.fundingBalances ?? [];
    const spot = {
        restAPI: {
            getAccount: vi.fn(() =>
                dataResponse({
                    balances: spotBalances.map((b) => ({
                        asset: b.asset,
                        free: b.free,
                        locked: b.locked ?? "0",
                    })),
                }),
            ),
            getOpenOrders: vi.fn(() => dataResponse([])),
            getOrder: vi.fn(() => dataResponse({})),
            allOrders: opts.allOrders ?? vi.fn(() => dataResponse([])),
            myTrades: opts.myTrades ?? vi.fn(() => dataResponse([])),
            newOrder: vi.fn(),
            deleteOrder: vi.fn(),
            exchangeInfo: vi.fn(),
        },
    };
    const wallet = {
        restAPI: {
            fundingWallet: vi.fn(() =>
                dataResponse(
                    fundingBalances.map((b) => ({
                        asset: b.asset,
                        free: b.free,
                        locked: b.locked ?? "0",
                    })),
                ),
            ),
        },
    };
    return { spot, wallet, apiKey: "k", apiSecret: "s" };
}

/**
 * Default fetch router used by the suite. Stubs the two margin SAPI
 * endpoints with 401 (the common "no margin scope" production case so
 * holdings enumeration ignores margin) and the public ticker endpoint
 * with an empty array (forces fan-out to use insertion order for
 * ranking when >8 holdings appear).
 */
function buildDefaultFetch() {
    return vi.fn().mockImplementation(async (url: string | URL) => {
        const s = String(url);
        if (s.includes("/sapi/v1/margin/")) {
            return mockStatus(401, "Unauthorized", {
                code: -2015,
                msg: "Invalid API-key, IP, or permissions",
            });
        }
        if (s.includes("/api/v3/ticker/price")) {
            return mockOk([]);
        }
        return mockStatus(404, "Not Found", { msg: "unexpected url" });
    });
}

describe("BinanceOrdersService.getOrders — fan-out across holdings (Fix 4)", () => {
    beforeEach(() => {
        __resetBinanceSymbolFiltersCacheForTests();
        __resetBinancePricingCacheForTests();
        vi.mocked(fetchBinanceUsdtPrices).mockReset();
        vi.mocked(fetchBinanceUsdtPrices).mockResolvedValue({});
        globalThis.fetch = buildDefaultFetch() as unknown as typeof fetch;
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
        vi.restoreAllMocks();
    });

    it("scans BTC + ETH and coalesces orders sorted desc when symbol is missing AND date window is set", async () => {
        const allOrdersSpy = vi.fn(({ symbol }: { symbol: string }) => {
            if (symbol === "BTCUSDT") {
                return dataResponse([
                    { orderId: 1, symbol: "BTCUSDT", time: 1_700_000_000_000 },
                    { orderId: 2, symbol: "BTCUSDT", time: 1_700_500_000_000 },
                ]);
            }
            if (symbol === "ETHUSDT") {
                return dataResponse([{ orderId: 3, symbol: "ETHUSDT", time: 1_700_200_000_000 }]);
            }
            return dataResponse([]);
        });
        const ctx = createCtx({ allOrders: allOrdersSpy });
        const svc = new BinanceOrdersService(ctx as never);

        const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const result = (await svc.getOrders({
            userId: "u" as never,
            start_date: start,
        })) as {
            orders: Array<Record<string, unknown>>;
            scanned_symbols: string[];
            note: string;
        };

        expect(result.scanned_symbols).toEqual(["BTCUSDT", "ETHUSDT"]);
        expect(result.note).toContain("scanned 2 symbols based on current holdings");
        expect(result.orders).toHaveLength(3);
        // Sorted by `time` desc.
        const times = result.orders.map((o) => o.time);
        expect(times[0]).toBe(1_700_500_000_000);
        expect(times[1]).toBe(1_700_200_000_000);
        expect(times[2]).toBe(1_700_000_000_000);
        // Both symbols were called.
        const calledSymbols = allOrdersSpy.mock.calls.map(
            (c) => (c[0] as { symbol: string }).symbol,
        );
        expect(calledSymbols).toContain("BTCUSDT");
        expect(calledSymbols).toContain("ETHUSDT");
    });

    it("caps fan-out at 8 symbols when the user holds more than 8 non-stablecoin assets", async () => {
        // 12 assets — ranking falls back to insertion order because the
        // ticker stub returns []. Expect the first 8 to be hit.
        const assets = [
            "BTC", "ETH", "SOL", "ADA", "DOT", "MATIC", "AVAX",
            "LINK", "ATOM", "ALGO", "FIL", "LTC",
        ];
        const spotBalances = assets.map((a) => ({ asset: a, free: "1.0", locked: "0" }));
        const allOrdersSpy = vi.fn(() => dataResponse([]));
        const ctx = createCtx({ spotBalances, allOrders: allOrdersSpy });
        const svc = new BinanceOrdersService(ctx as never);

        const result = (await svc.getOrders({
            userId: "u" as never,
            start_date: new Date(Date.now() - 86_400_000).toISOString(),
        })) as { scanned_symbols: string[] };

        expect(result.scanned_symbols).toHaveLength(8);
        expect(allOrdersSpy).toHaveBeenCalledTimes(8);
        // First 8 in insertion order.
        const expected = assets.slice(0, 8).map((a) => `${a}USDT`);
        expect(result.scanned_symbols).toEqual(expected);
    });

    it("skips stablecoin base assets so USDT/BUSD/etc. do not form a fan-out symbol", async () => {
        const spotBalances = [
            { asset: "USDT", free: "100", locked: "0" },
            { asset: "BUSD", free: "50", locked: "0" },
            { asset: "BTC", free: "0.5", locked: "0" },
        ];
        const allOrdersSpy = vi.fn(() => dataResponse([]));
        const ctx = createCtx({ spotBalances, allOrders: allOrdersSpy });
        const svc = new BinanceOrdersService(ctx as never);

        const result = (await svc.getOrders({
            userId: "u" as never,
            start_date: new Date(Date.now() - 86_400_000).toISOString(),
        })) as { scanned_symbols: string[] };

        expect(result.scanned_symbols).toEqual(["BTCUSDT"]);
        expect(allOrdersSpy).toHaveBeenCalledTimes(1);
        const calledSymbol = (allOrdersSpy.mock.calls[0][0] as { symbol: string }).symbol;
        expect(calledSymbol).toBe("BTCUSDT");
    });

    it("honors `quote_currency: USDC` and builds BTCUSDC / ETHUSDC pairs", async () => {
        const allOrdersSpy = vi.fn(() => dataResponse([]));
        const ctx = createCtx({ allOrders: allOrdersSpy });
        const svc = new BinanceOrdersService(ctx as never);

        const result = (await svc.getOrders({
            userId: "u" as never,
            start_date: new Date(Date.now() - 86_400_000).toISOString(),
            quote_currency: "USDC",
        })) as { scanned_symbols: string[] };

        expect(result.scanned_symbols).toEqual(["BTCUSDC", "ETHUSDC"]);
    });

    it("falls back to the legacy open-orders path when no date window is set (regression guard)", async () => {
        const ctx = createCtx({});
        const openSpy = vi.fn(() =>
            dataResponse([{ orderId: 99, symbol: "BTCUSDT", side: "BUY" }]),
        );
        (ctx.spot.restAPI as Record<string, unknown>).getOpenOrders = openSpy;
        const svc = new BinanceOrdersService(ctx as never);

        const result = (await svc.getOrders({ userId: "u" as never })) as {
            orders: unknown[];
            scanned_symbols?: string[];
        };

        expect(openSpy).toHaveBeenCalledOnce();
        expect(result.orders).toHaveLength(1);
        // The legacy path does NOT carry scanned_symbols.
        expect((result as Record<string, unknown>).scanned_symbols).toBeUndefined();
    });

    it("triggers fan-out when `history: true` is set even without a date window (Commit 6)", async () => {
        const allOrdersSpy = vi.fn(({ symbol }: { symbol: string }) =>
            dataResponse([{ orderId: 42, symbol, time: 1_700_000_000_000 }]),
        );
        const openSpy = vi.fn(() => dataResponse([]));
        const ctx = createCtx({ allOrders: allOrdersSpy });
        (ctx.spot.restAPI as Record<string, unknown>).getOpenOrders = openSpy;
        const svc = new BinanceOrdersService(ctx as never);

        const result = (await svc.getOrders({
            userId: "u" as never,
            history: true,
        })) as { orders: unknown[]; scanned_symbols: string[] };

        // History flag should bypass the legacy open-orders endpoint
        // and fan out across the user's holdings (BTC + ETH from
        // the default ctx).
        expect(openSpy).not.toHaveBeenCalled();
        expect(allOrdersSpy).toHaveBeenCalled();
        expect(result.scanned_symbols.length).toBeGreaterThan(0);
    });

    it("throws when every per-symbol call rejects so the action error path can render an actionable message", async () => {
        const allOrdersSpy = vi.fn(() => Promise.reject(new Error("upstream 502")));
        const ctx = createCtx({ allOrders: allOrdersSpy });
        const svc = new BinanceOrdersService(ctx as never);

        await expect(
            svc.getOrders({
                userId: "u" as never,
                start_date: new Date(Date.now() - 86_400_000).toISOString(),
            }),
        ).rejects.toThrow();
    });
});

describe("BinanceOrdersService.getFills — fan-out across holdings (Fix 4b)", () => {
    beforeEach(() => {
        __resetBinanceSymbolFiltersCacheForTests();
        __resetBinancePricingCacheForTests();
        vi.mocked(fetchBinanceUsdtPrices).mockReset();
        vi.mocked(fetchBinanceUsdtPrices).mockResolvedValue({});
        globalThis.fetch = buildDefaultFetch() as unknown as typeof fetch;
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
        vi.restoreAllMocks();
    });

    it("scans BTC + ETH and coalesces fills sorted desc when product_ids is missing", async () => {
        const myTradesSpy = vi.fn(({ symbol }: { symbol: string }) => {
            if (symbol === "BTCUSDT") {
                return dataResponse([
                    { id: 1, orderId: 10, symbol: "BTCUSDT", time: 1_700_000_000_000 },
                    { id: 2, orderId: 11, symbol: "BTCUSDT", time: 1_700_500_000_000 },
                ]);
            }
            if (symbol === "ETHUSDT") {
                return dataResponse([
                    { id: 3, orderId: 12, symbol: "ETHUSDT", time: 1_700_200_000_000 },
                ]);
            }
            return dataResponse([]);
        });
        const ctx = createCtx({ myTrades: myTradesSpy });
        const svc = new BinanceOrdersService(ctx as never);

        const result = (await svc.getFills({ userId: "u" as never })) as {
            fills: Array<Record<string, unknown>>;
            scanned_symbols: string[];
            note: string;
        };

        expect(result.scanned_symbols).toEqual(["BTCUSDT", "ETHUSDT"]);
        expect(result.fills).toHaveLength(3);
        // Sorted by time desc.
        const times = result.fills.map((f) => f.time);
        expect(times[0]).toBe(1_700_500_000_000);
        expect(times[1]).toBe(1_700_200_000_000);
        expect(times[2]).toBe(1_700_000_000_000);
        expect(result.note).toContain("scanned 2 symbols");
    });

    it("rewriteable error fires when every fan-out symbol fails", async () => {
        // All myTrades calls reject — venue throws the upstream error
        // so the action's catch path can rewrite it via
        // `rewriteSymbolRequiredErrorMessage` for the user-facing text.
        const myTradesSpy = vi.fn(() =>
            Promise.reject(new Error("Binance internal: requires product_ids symbol")),
        );
        const ctx = createCtx({ myTrades: myTradesSpy });
        const svc = new BinanceOrdersService(ctx as never);

        await expect(svc.getFills({ userId: "u" as never })).rejects.toThrow(
            /product_ids/,
        );
    });

    it("returns an empty envelope when the user has no holdings to scan", async () => {
        const ctx = createCtx({ spotBalances: [], fundingBalances: [] });
        const svc = new BinanceOrdersService(ctx as never);

        const result = (await svc.getFills({ userId: "u" as never })) as {
            fills: unknown[];
            scanned_symbols: string[];
            note: string;
        };
        expect(result.scanned_symbols).toEqual([]);
        expect(result.fills).toEqual([]);
        expect(result.note).toContain("scanned 0 symbols");
    });
});

describe("enumerateHoldingsForFanOut — ranking + caps (helper contract)", () => {
    beforeEach(() => {
        __resetBinancePricingCacheForTests();
        globalThis.fetch = buildDefaultFetch() as unknown as typeof fetch;
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
        vi.restoreAllMocks();
    });

    it("returns an empty array when getBalance returns no held assets", async () => {
        const ctx = createCtx({ spotBalances: [], fundingBalances: [] });
        const result = await enumerateHoldingsForFanOut(ctx as never);
        expect(result).toEqual([]);
    });

    it("dedupes the same base asset across spot + funding wallets so it appears once", async () => {
        const ctx = createCtx({
            spotBalances: [{ asset: "BTC", free: "0.1", locked: "0" }],
            fundingBalances: [{ asset: "BTC", free: "0.2", locked: "0" }],
        });
        const result = await enumerateHoldingsForFanOut(ctx as never);
        expect(result).toEqual(["BTCUSDT"]);
    });

    it("uses USD ranking to pick the 8 most-valuable holdings when pricing succeeds", async () => {
        // Build 10 holdings; rig the mocked pricing helper so XYZ has
        // the highest USD value (forced into the top-8) and A has the
        // lowest (kicked out). Without USD pricing, insertion order
        // would be used.
        const assets = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "XYZ"];
        const spotBalances = assets.map((a) => ({ asset: a, free: "1.0", locked: "0" }));
        const prices: Record<string, number> = {};
        for (const a of assets) {
            prices[a] = a === "XYZ" ? 1_000_000 : a === "A" ? 0.0001 : 10;
        }
        vi.mocked(fetchBinanceUsdtPrices).mockResolvedValueOnce(prices);

        const ctx = createCtx({ spotBalances });
        const result = await enumerateHoldingsForFanOut(ctx as never, { cap: 8 });
        expect(result).toHaveLength(8);
        // XYZ must be present (highest USD); A must be absent (lowest).
        expect(result).toContain("XYZUSDT");
        expect(result).not.toContain("AUSDT");
        // First element should be XYZ (highest USD).
        expect(result[0]).toBe("XYZUSDT");
    });
});

describe("rewriteSymbolRequiredErrorMessage — actionable text (Fix 4b)", () => {
    it("rewrites the legacy 'productids is required' shape to a user-actionable message", async () => {
        const { rewriteSymbolRequiredErrorMessage } = await import(
            "../src/actions/shared"
        );
        const cases = [
            '"productids" is required for binance getfills requests',
            "product_ids is required",
            "Binance requires product_ids[0] as the trading symbol (e.g. BTCUSDT)",
            "symbol is required",
        ];
        for (const c of cases) {
            const out = rewriteSymbolRequiredErrorMessage(c);
            expect(out).toBe(
                "Please specify a symbol (e.g. BTCUSDT) — I couldn't infer one from your message.",
            );
        }
    });

    it("leaves unrelated error messages untouched", async () => {
        const { rewriteSymbolRequiredErrorMessage } = await import(
            "../src/actions/shared"
        );
        const passthrough = "binance 502 Bad Gateway: upstream timeout";
        expect(rewriteSymbolRequiredErrorMessage(passthrough)).toBe(passthrough);
    });

    it("does NOT rewrite when the requirement is about a field CONSTRAINT, not field absence", async () => {
        const { rewriteSymbolRequiredErrorMessage } = await import(
            "../src/actions/shared"
        );
        // These messages mention "required" but they describe a SHAPE
        // requirement on a present value, not a missing value. The
        // rewriter must be a no-op here so the upstream error survives.
        const constraintCases = [
            "symbol BTCUSDT is required to be uppercase",
            "product_ids format is required",
            "symbol value must be unique and is required to follow the venue pattern",
        ];
        for (const c of constraintCases) {
            expect(rewriteSymbolRequiredErrorMessage(c)).toBe(c);
        }
    });

    it("does NOT rewrite noisy strings that merely contain the words but not the absence shape", async () => {
        const { rewriteSymbolRequiredErrorMessage } = await import(
            "../src/actions/shared"
        );
        // No `<noun> is required`, no `requires <noun>` — just both
        // words floating in the sentence. Must pass through unchanged.
        const noise = "the symbol order was required by the venue";
        expect(rewriteSymbolRequiredErrorMessage(noise)).toBe(noise);
    });

    it("rewrites the bare imperative shape `symbol required`", async () => {
        const { rewriteSymbolRequiredErrorMessage } = await import(
            "../src/actions/shared"
        );
        expect(rewriteSymbolRequiredErrorMessage("symbol required")).toBe(
            "Please specify a symbol (e.g. BTCUSDT) — I couldn't infer one from your message.",
        );
    });
});
