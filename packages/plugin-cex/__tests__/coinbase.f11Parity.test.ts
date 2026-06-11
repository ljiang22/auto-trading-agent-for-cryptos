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

// F11 — Coinbase parity audit was documented as "zero code gap" in PR #212
// (`coinbase-implemented-endpoints.json:f11ParityNotes`). Plan §8 L532 asked
// for **behavioral proof** that Coinbase accepts the parity variants —
// stop_limit (with TIF GTC/GTD), TIF GTC/GTD/IOC/FOK, and post_only —
// without the wire shape getting mangled. This file converts the audit
// claim into a runnable happy-path suite.

const OAUTH_CREDS: ResolvedExchangeCredentials = {
    exchange: "coinbase",
    authType: "oauth_access_refresh_token",
    auth: { accessToken: "test-token" },
};

function okResponse<T>(data: T) {
    return { status: 200, statusText: "OK", data };
}

const PRODUCT_META = {
    product_id: "BTC-USDC",
    base_increment: "0.00000001",
    quote_increment: "0.01",
};

beforeEach(() => {
    httpClient.get.mockReset();
    httpClient.post.mockReset();
    httpClient.get.mockImplementation(async (url: string) => {
        if (url.includes("/api/v3/brokerage/products/")) {
            return okResponse(PRODUCT_META);
        }
        throw new Error(`Unexpected GET ${url}`);
    });
    httpClient.post.mockResolvedValue(okResponse({ success: true, order_id: "venue-id-1" }));
});

afterEach(() => {
    vi.clearAllMocks();
});

function makeService() {
    return new CoinbaseOrdersService(OAUTH_CREDS);
}

function baseParams(extra: Partial<CreateOrderParams> = {}): CreateOrderParams {
    return {
        userId: "u" as CreateOrderParams["userId"],
        client_order_id: `co-${Math.random().toString(36).slice(2, 8)}`,
        product_id: `BTC-USDC-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        side: "BUY",
        order_configuration: { market_market_ioc: { quote_size: "100" } },
        ...extra,
    } as CreateOrderParams;
}

describe("F11 Coinbase parity — stop_limit happy path", () => {
    it("stop_limit_stop_limit_gtc passes through verbatim", async () => {
        const params = baseParams({
            order_configuration: {
                stop_limit_stop_limit_gtc: {
                    base_size: "0.001",
                    limit_price: "59000",
                    stop_price: "60000",
                    stop_direction: "STOP_DIRECTION_STOP_DOWN",
                },
            },
        });
        await makeService().createOrder(params);
        expect(httpClient.post).toHaveBeenCalledTimes(1);
        const [url, body] = httpClient.post.mock.calls[0];
        expect(url).toContain("/api/v3/brokerage/orders");
        expect(body.order_configuration).toHaveProperty("stop_limit_stop_limit_gtc");
        const cfg = body.order_configuration.stop_limit_stop_limit_gtc;
        expect(cfg.limit_price).toBe("59000");
        expect(cfg.stop_price).toBe("60000");
        expect(cfg.stop_direction).toBe("STOP_DIRECTION_STOP_DOWN");
    });

    it("stop_limit_stop_limit_gtd carries end_time verbatim", async () => {
        const endTime = "2026-12-31T23:59:59Z";
        const params = baseParams({
            order_configuration: {
                stop_limit_stop_limit_gtd: {
                    base_size: "0.001",
                    limit_price: "59000",
                    stop_price: "60000",
                    stop_direction: "STOP_DIRECTION_STOP_DOWN",
                    end_time: endTime,
                },
            } as never,
        });
        await makeService().createOrder(params);
        const [, body] = httpClient.post.mock.calls[0];
        expect(body.order_configuration).toHaveProperty("stop_limit_stop_limit_gtd");
        expect(body.order_configuration.stop_limit_stop_limit_gtd.end_time).toBe(endTime);
    });
});

describe("F11 Coinbase parity — time_in_force variants", () => {
    it.each([
        ["limit_limit_gtc", "GTC", { base_size: "0.001", limit_price: "55000" }],
        [
            "limit_limit_gtd",
            "GTD",
            { base_size: "0.001", limit_price: "55000", end_time: "2026-12-31T23:59:59Z" },
        ],
        ["limit_limit_fok", "FOK", { base_size: "0.001", limit_price: "55000" }],
        ["sor_limit_ioc", "IOC", { base_size: "0.001", limit_price: "55000" }],
    ])(
        "%s (%s) passes through with all fields intact",
        async (variantKey, _tif, fields) => {
            const params = baseParams({
                order_configuration: { [variantKey]: fields } as never,
            });
            await makeService().createOrder(params);
            const [, body] = httpClient.post.mock.calls[0];
            expect(body.order_configuration).toHaveProperty(variantKey);
            const cfg = body.order_configuration[variantKey];
            for (const [k, v] of Object.entries(fields)) {
                if (k === "base_size") {
                    // Quantization may shorten the size string. Just verify
                    // the field is present and convertible to the same number.
                    expect(parseFloat(String(cfg[k]))).toBeCloseTo(parseFloat(String(v)));
                } else {
                    expect(cfg[k]).toBe(v);
                }
            }
        },
    );
});

describe("F11 Coinbase parity — post_only", () => {
    it("limit_limit_gtc.post_only=true passes through", async () => {
        const params = baseParams({
            order_configuration: {
                limit_limit_gtc: {
                    base_size: "0.001",
                    limit_price: "55000",
                    post_only: true,
                },
            },
        });
        await makeService().createOrder(params);
        const [, body] = httpClient.post.mock.calls[0];
        expect(body.order_configuration.limit_limit_gtc.post_only).toBe(true);
    });
});
