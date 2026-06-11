import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
    elizaLogger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

// Import AFTER mocking @elizaos/core so logger references resolve.
const { PaperVenueExchangeService } = await import("../src/exchanges/services/paperVenue");
const { createInMemoryPaperOrderStore } = await import(
    "../src/exchanges/services/paperOrderStore"
);
import type { CreateOrderParams } from "../src/types";

// F11 round-2 — paper-venue Coinbase parity check.
//
// The original F11 audit asserted "zero code gap": Coinbase's REST API
// accepts the canonical `order_configuration` shape verbatim, so all
// parity variants (stop_limit_gtc, stop_limit_gtd, TIF GTC/GTD/IOC/FOK,
// post_only) work without translation. `coinbase.f11Parity.test.ts`
// covered the live-REST POST shape — this file independently verifies
// the same variants survive the **paper venue** path with
// `venue=coinbase`, so a user running paper-mode against a Coinbase
// agent profile gets the same behavior as a live submission would.
//
// Paper venue is venue-agnostic — it processes the canonical params
// and stores a paper order. The test asserts: (a) every parity variant
// passes through without throwing, (b) the order_id/client_order_id
// are persisted, (c) the price extracted from `limit_price` matches
// what the variant carries (i.e., no silent default-to-mid override
// for limit variants).

const MID = 60000;

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    vi.clearAllMocks();
});

function makePaperVenue() {
    return new PaperVenueExchangeService({
        venue: "coinbase",
        getMidPrice: async () => MID,
        ttlSeconds: 3600,
        store: createInMemoryPaperOrderStore(),
    });
}

function baseParams(extra: Partial<CreateOrderParams> = {}): CreateOrderParams {
    return {
        userId: "u" as CreateOrderParams["userId"],
        client_order_id: `co-${Math.random().toString(36).slice(2, 8)}`,
        product_id: "BTC-USDC",
        side: "BUY",
        order_configuration: { limit_limit_gtc: { base_size: "0.01", limit_price: "59000" } },
        ...extra,
    } as CreateOrderParams;
}

describe("F11 Coinbase parity — paper venue accepts every variant", () => {
    it("stop_limit_stop_limit_gtc round-trips through paper venue", async () => {
        const venue = makePaperVenue();
        const params = baseParams({
            order_configuration: {
                stop_limit_stop_limit_gtc: {
                    base_size: "0.01",
                    limit_price: "59000",
                    stop_price: "60000",
                    stop_direction: "STOP_DIRECTION_STOP_DOWN",
                },
            },
        });
        const result = (await venue.orders.createOrder(params)) as {
            success: boolean;
            order_id: string;
            client_order_id: string;
        };
        expect(result.success).toBe(true);
        expect(result.order_id).toMatch(/^paper-ord-/);
        expect(result.client_order_id).toBe(params.client_order_id);
    });

    it("stop_limit_stop_limit_gtd accepts end_time", async () => {
        const venue = makePaperVenue();
        const params = baseParams({
            order_configuration: {
                stop_limit_stop_limit_gtd: {
                    base_size: "0.01",
                    limit_price: "59000",
                    stop_price: "60000",
                    stop_direction: "STOP_DIRECTION_STOP_DOWN",
                    end_time: "2026-12-31T23:59:59Z",
                },
            } as never,
        });
        const result = (await venue.orders.createOrder(params)) as { success: boolean };
        expect(result.success).toBe(true);
    });

    it.each([
        ["limit_limit_gtc", { base_size: "0.01", limit_price: "59000" }],
        ["limit_limit_gtd", { base_size: "0.01", limit_price: "59000", end_time: "2026-12-31T23:59:59Z" }],
        ["limit_limit_fok", { base_size: "0.01", limit_price: "59000" }],
        ["sor_limit_ioc", { base_size: "0.01", limit_price: "59000" }],
    ])("%s round-trips and preserves limit_price=59000 (not silent-default to mid)", async (variantKey, fields) => {
        const venue = makePaperVenue();
        const params = baseParams({
            order_configuration: { [variantKey]: fields } as never,
        });
        const result = (await venue.orders.createOrder(params)) as {
            success: boolean;
            order: { price: string };
        };
        expect(result.success).toBe(true);
        // limit_price=59000 should be preserved as the recorded price,
        // NOT silently overridden to the mock mid (60000).
        expect(Number.parseFloat(result.order.price)).toBe(59000);
    });

    it("limit_limit_gtc with post_only=true round-trips through paper venue", async () => {
        const venue = makePaperVenue();
        const params = baseParams({
            order_configuration: {
                limit_limit_gtc: {
                    base_size: "0.01",
                    limit_price: "59000",
                    post_only: true,
                },
            },
        });
        const result = (await venue.orders.createOrder(params)) as { success: boolean };
        expect(result.success).toBe(true);
        // The paper venue stores price/quantity but not post_only on the
        // record itself; the assertion is that the variant did not
        // throw or take a fallback codepath.
        const listed = (await venue.orders.getOrders({
            userId: "u" as CreateOrderParams["userId"],
        })) as { orders: Array<{ client_order_id: string }> };
        expect(listed.orders.some((o) => o.client_order_id === params.client_order_id)).toBe(true);
    });
});
