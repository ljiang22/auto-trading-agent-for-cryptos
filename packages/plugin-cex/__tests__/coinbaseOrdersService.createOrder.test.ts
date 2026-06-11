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

// Import AFTER mocking so the service binds to the mocked httpClient.
const { CoinbaseOrdersService } = await import("../src/exchanges/services/coinbase");
import type { CreateOrderParams, ResolvedExchangeCredentials } from "../src/types";

const OAUTH_CREDS: ResolvedExchangeCredentials = {
    exchange: "coinbase",
    authType: "oauth_access_refresh_token",
    auth: { accessToken: "test-token" },
};

function okResponse<T>(data: T) {
    return { status: 200, statusText: "OK", data };
}

beforeEach(() => {
    httpClient.get.mockReset();
    httpClient.post.mockReset();
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("CoinbaseOrdersService.createOrder quantization wiring", () => {
    it("fetches product metadata and floors quote_size before POSTing the order", async () => {
        httpClient.get.mockImplementation(async (url: string) => {
            if (url.includes("/api/v3/brokerage/products/")) {
                return okResponse({
                    product_id: "BTC-USDC",
                    base_increment: "0.00000001",
                    quote_increment: "0.01",
                });
            }
            throw new Error(`Unexpected GET ${url}`);
        });
        httpClient.post.mockResolvedValue(okResponse({ success: true, order_id: "x" }));

        // Use a unique product to avoid cache pollution from other tests in the file.
        const productId = `BTC-USDC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
        const service = new CoinbaseOrdersService(OAUTH_CREDS);
        const params: CreateOrderParams = {
            userId: "u" as CreateOrderParams["userId"],
            client_order_id: "co-1",
            product_id: productId,
            side: "BUY",
            order_configuration: { market_market_ioc: { quote_size: "100.123456" } },
        };
        await service.createOrder(params);

        const productGet = httpClient.get.mock.calls.find(([url]) => url.includes("/products/"));
        expect(productGet).toBeDefined();
        expect(productGet![0]).toContain(`/api/v3/brokerage/products/${productId}`);

        expect(httpClient.post).toHaveBeenCalledTimes(1);
        const [postUrl, postBody] = httpClient.post.mock.calls[0];
        expect(postUrl).toContain("/api/v3/brokerage/orders");
        expect(postBody).toEqual(
            expect.objectContaining({
                client_order_id: "co-1",
                product_id: productId,
                side: "BUY",
                order_configuration: { market_market_ioc: { quote_size: "100.12" } },
            }),
        );
    });

    it("caches product metadata across orders for the same product (one GET, two POSTs)", async () => {
        httpClient.get.mockImplementation(async (url: string) => {
            if (url.includes("/api/v3/brokerage/products/")) {
                return okResponse({ base_increment: "0.00000001", quote_increment: "0.01" });
            }
            throw new Error(`Unexpected GET ${url}`);
        });
        httpClient.post.mockResolvedValue(okResponse({ success: true }));

        const productId = `ETH-USDC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
        const service = new CoinbaseOrdersService(OAUTH_CREDS);
        const base: Omit<CreateOrderParams, "client_order_id" | "order_configuration"> = {
            userId: "u" as CreateOrderParams["userId"],
            product_id: productId,
            side: "BUY",
        };

        await service.createOrder({
            ...base,
            client_order_id: "co-1",
            order_configuration: { market_market_ioc: { quote_size: "10.999999" } },
        });
        await service.createOrder({
            ...base,
            client_order_id: "co-2",
            order_configuration: { market_market_ioc: { quote_size: "20.001234" } },
        });

        const productGets = httpClient.get.mock.calls.filter(([url]) =>
            String(url).includes(`/products/${productId}`),
        );
        expect(productGets).toHaveLength(1);
        expect(httpClient.post).toHaveBeenCalledTimes(2);
        expect(httpClient.post.mock.calls[0][1].order_configuration).toEqual({
            market_market_ioc: { quote_size: "10.99" },
        });
        expect(httpClient.post.mock.calls[1][1].order_configuration).toEqual({
            market_market_ioc: { quote_size: "20" },
        });
    });

    it("submits the order unchanged if the products endpoint fails", async () => {
        httpClient.get.mockImplementation(async (url: string) => {
            if (url.includes("/api/v3/brokerage/products/")) {
                throw new Error("503 Service Unavailable");
            }
            throw new Error(`Unexpected GET ${url}`);
        });
        httpClient.post.mockResolvedValue(okResponse({ success: true }));

        const productId = `SOL-USDC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
        const service = new CoinbaseOrdersService(OAUTH_CREDS);
        await service.createOrder({
            userId: "u" as CreateOrderParams["userId"],
            client_order_id: "co-fallback",
            product_id: productId,
            side: "BUY",
            order_configuration: { market_market_ioc: { quote_size: "100.123456" } },
        });

        // Order still submitted, with the original (over-precise) quote_size.
        // Coinbase will reject — same as before this fix — but we did not block on
        // a metadata outage.
        expect(httpClient.post).toHaveBeenCalledTimes(1);
        expect(httpClient.post.mock.calls[0][1].order_configuration).toEqual({
            market_market_ioc: { quote_size: "100.123456" },
        });
    });
});
