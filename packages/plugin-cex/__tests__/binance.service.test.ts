import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    BinanceAccountsService,
    BinanceOrdersService,
    mapOrderConfigurationToBinanceParams,
    __resetBinanceSymbolFiltersCacheForTests,
} from "../src/exchanges/services/binance";

const realFetch = globalThis.fetch;

function dataResponse<T>(value: T) {
    return Promise.resolve({
        data: async () => value,
    });
}

function btcUsdtExchangeInfo() {
    return {
        symbols: [
            {
                symbol: "BTCUSDT",
                filters: [
                    {
                        filterType: "LOT_SIZE",
                        minQty: "0.00001",
                        maxQty: "9000",
                        stepSize: "0.00001",
                    },
                    {
                        filterType: "MARKET_LOT_SIZE",
                        minQty: "0.00001",
                        maxQty: "100",
                        stepSize: "0.00001",
                    },
                    {
                        filterType: "PRICE_FILTER",
                        minPrice: "0.01",
                        maxPrice: "1000000",
                        tickSize: "0.01",
                    },
                ],
            },
        ],
    };
}

function createCtx(overrides: Record<string, unknown> = {}) {
    const spot = {
        restAPI: {
            getAccount: vi.fn(() =>
                dataResponse({
                    balances: [{ asset: "BTC", free: "1.0", locked: "0.1" }],
                })
            ),
            getOpenOrders: vi.fn(() => dataResponse([])),
            getOrder: vi.fn(() => dataResponse({ orderId: 10, symbol: "BTCUSDT" })),
            allOrders: vi.fn(() => dataResponse([{ orderId: 11, symbol: "BTCUSDT" }])),
            myTrades: vi.fn(() => dataResponse([{ id: 1, orderId: 10 }])),
            newOrder: vi.fn(() => dataResponse({ orderId: 12 })),
            deleteOrder: vi.fn(() => dataResponse({ status: "CANCELED" })),
            exchangeInfo: vi.fn(() => dataResponse(btcUsdtExchangeInfo())),
        },
    };
    const wallet = {
        restAPI: {
            fundingWallet: vi.fn(() =>
                dataResponse([{ asset: "USDT", free: "25.0", locked: "0" }])
            ),
        },
    };
    return {
        spot,
        wallet,
        apiKey: "k",
        apiSecret: "s",
        ...overrides,
    };
}

describe("binance service", () => {
    beforeEach(() => {
        __resetBinanceSymbolFiltersCacheForTests();
        // Fix 1 — getBalance now also fetches /sapi/v1/margin/account +
        // /sapi/v1/margin/isolated/account via raw fetch. Stub fetch with
        // a 401 so the wallet fan-out skips margin scopes cleanly (matches
        // the common "API key without margin scope" production path).
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
            statusText: "Unauthorized",
            text: async () => JSON.stringify({ code: -2015, msg: "Invalid API-key, IP, or permissions" }),
        }) as unknown as typeof fetch;
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    it("maps market and limit payloads", () => {
        const mapped = mapOrderConfigurationToBinanceParams(
            "BTCUSDT",
            "BUY",
            "cid-1",
            { market_market_ioc: { quote_size: "10" } }
        );
        expect(mapped.symbol).toBe("BTCUSDT");
        expect(mapped.type).toBe("MARKET");
        expect(mapped.quoteOrderQty).toBe("10");
    });

    it("rejects unsupported market FOK payload", () => {
        expect(() =>
            mapOrderConfigurationToBinanceParams("BTCUSDT", "BUY", "cid-1b", {
                market_market_fok: { base_size: "0.1" },
            })
        ).toThrow("not supported");
    });

    it("rejects unsupported SOR limit IOC payload", () => {
        expect(() =>
            mapOrderConfigurationToBinanceParams("BTCUSDT", "BUY", "cid-1c", {
                sor_limit_ioc: { base_size: "0.1", limit_price: "61000" },
            })
        ).toThrow("not supported");
    });

    it("rejects unsupported bracket payloads", () => {
        expect(() =>
            mapOrderConfigurationToBinanceParams("BTCUSDT", "SELL", "cid-2", {
                trigger_bracket_gtc: { limit_price: "100000", stop_trigger_price: "90000" },
            })
        ).toThrow("not supported");
    });

    it("rejects quote_size for limit orders on Binance", () => {
        expect(() =>
            mapOrderConfigurationToBinanceParams("BTCUSDT", "BUY", "cid-2b", {
                limit_limit_gtc: { limit_price: "65000", quote_size: "25" },
            })
        ).toThrow("base_size");
    });

    it("gets spot and funding balances", async () => {
        const svc = new BinanceAccountsService(createCtx() as never);
        const result = (await svc.getBalance({ userId: "u" as never })) as Record<string, unknown>;
        const accounts = result.accounts as Array<Record<string, unknown>>;
        expect(accounts.length).toBeGreaterThan(0);
    });

    it("gets orders by order id using resolved symbol", async () => {
        const ctx = createCtx();
        (ctx.spot as never).restAPI.getOpenOrders = vi.fn(() =>
            dataResponse([{ orderId: 100, symbol: "BTCUSDT" }])
        );
        const svc = new BinanceOrdersService(ctx as never);
        const result = (await svc.getOrders({
            userId: "u" as never,
            order_ids: ["100"],
        })) as Record<string, unknown>;
        expect(Array.isArray(result.orders)).toBe(true);
    });

    it("creates order via spot.newOrder for non-GTD payloads", async () => {
        const ctx = createCtx();
        const svc = new BinanceOrdersService(ctx as never);
        await svc.createOrder({
            userId: "u" as never,
            client_order_id: "cid-test",
            product_id: "BTC-USDT",
            side: "BUY",
            order_configuration: {
                market_market_ioc: { quote_size: "2.00" },
            },
        });
        expect((ctx.spot as never).restAPI.newOrder).toHaveBeenCalled();
    });

    it("cancelOrder uses product_id symbol fallback", async () => {
        const ctx = createCtx();
        (ctx.spot as never).restAPI.getOpenOrders = vi.fn(() => dataResponse([]));
        const svc = new BinanceOrdersService(ctx as never);
        const result = (await svc.cancelOrder({
            userId: "u" as never,
            order_ids: ["123"],
            product_id: "BTC-USDT",
        })) as Record<string, unknown>;
        const entries = result.results as Array<Record<string, unknown>>;
        expect(entries[0].success).toBe(true);
    });

    it("getFills fans out across held assets when no product_ids is passed (Fix 4b)", async () => {
        // The default ctx fixture exposes a spot account with BTC
        // free=1.0 / locked=0.1 and no funding USDT visible to
        // fan-out (it's a stablecoin and skipped). Margin fetch is
        // stubbed 401 by the suite's `beforeEach` so the holdings
        // enumeration sees BTC only.
        const svc = new BinanceOrdersService(createCtx() as never);
        const result = (await svc.getFills({
            userId: "u" as never,
        })) as { fills: unknown[]; scanned_symbols: string[]; note: string };
        expect(result.scanned_symbols).toEqual(["BTCUSDT"]);
        expect(result.fills.length).toBeGreaterThan(0);
        expect(result.note).toContain("scanned 1 symbols based on current holdings");
    });

    it("createOrder fetches exchangeInfo and quantizes quantity + price before newOrder", async () => {
        const ctx = createCtx();
        const svc = new BinanceOrdersService(ctx as never);
        await svc.createOrder({
            userId: "u" as never,
            client_order_id: "cid-quantize",
            product_id: "BTC-USDT",
            side: "BUY",
            order_configuration: {
                limit_limit_gtc: {
                    base_size: "0.0001234567",
                    limit_price: "65432.567",
                },
            },
        });
        const spotRest = (ctx.spot as never).restAPI as {
            exchangeInfo: ReturnType<typeof vi.fn>;
            newOrder: ReturnType<typeof vi.fn>;
        };
        expect(spotRest.exchangeInfo).toHaveBeenCalledWith({ symbol: "BTCUSDT" });
        const newOrderArgs = spotRest.newOrder.mock.calls[0]?.[0] as Record<string, unknown>;
        // LOT_SIZE.stepSize=0.00001 -> floor 0.0001234567 -> 0.00012
        expect(newOrderArgs.quantity).toBe(0.00012);
        // PRICE_FILTER.tickSize=0.01 -> round half-up 65432.567 -> 65432.57
        expect(newOrderArgs.price).toBe(65432.57);
    });

    it("createOrder surfaces a clean error when post-floor quantity is below minQty", async () => {
        const ctx = createCtx();
        const svc = new BinanceOrdersService(ctx as never);
        await expect(
            svc.createOrder({
                userId: "u" as never,
                client_order_id: "cid-min",
                product_id: "BTC-USDT",
                side: "BUY",
                order_configuration: {
                    // 0.000005 floors to 0.0 (< minQty 0.00001)
                    limit_limit_gtc: { base_size: "0.000005", limit_price: "65000" },
                },
            })
        ).rejects.toThrow(/below the minimum/);
    });

    it("createOrder falls back gracefully when exchangeInfo fails (best-effort)", async () => {
        const ctx = createCtx();
        // Use a symbol the module-level cache cannot have seen in earlier tests
        // so we exercise the cold-fetch path and force the rejection.
        (ctx.spot as never).restAPI.exchangeInfo = vi.fn(() =>
            Promise.reject(new Error("exchangeInfo down"))
        );
        const svc = new BinanceOrdersService(ctx as never);
        await svc.createOrder({
            userId: "u" as never,
            client_order_id: "cid-fallback",
            product_id: "WIF-USDT",
            side: "BUY",
            order_configuration: {
                limit_limit_gtc: { base_size: "0.001", limit_price: "65000" },
            },
        });
        // Still placed the order despite metadata failure.
        expect((ctx.spot as never).restAPI.exchangeInfo).toHaveBeenCalled();
        expect((ctx.spot as never).restAPI.newOrder).toHaveBeenCalled();
    });
});
