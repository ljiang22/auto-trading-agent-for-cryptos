import { describe, expect, it } from "vitest";

import { createPaperVenue } from "../src/exchanges/services/paperVenue";

describe("PaperVenueExchangeService", () => {
    function makeVenue() {
        return createPaperVenue({
            getMidPrice: async () => 70_000,
            slippage: { kind: "linear_bps", bps: 5 },
            initialUsd: 10_000,
        });
    }

    it("fills market orders immediately", async () => {
        const venue = makeVenue();
        const result = await venue.orders.createOrder({
            userId: "00000000-0000-0000-0000-000000000001" as never,
            client_order_id: "test-co-1",
            product_id: "BTCUSDT",
            side: "BUY",
            order_configuration: { market_market_ioc: { base_size: "0.01" } },
        });
        expect(result).toMatchObject({ success: true });
        const orders = (await venue.orders.getOrders({ userId: "00000000-0000-0000-0000-000000000001" as never })) as { orders: unknown[] };
        expect(orders.orders.length).toBe(1);
    });

    it("applies linear bps slippage on market buy", async () => {
        const venue = makeVenue();
        await venue.orders.createOrder({
            userId: "00000000-0000-0000-0000-000000000001" as never,
            client_order_id: "co-2",
            product_id: "BTCUSDT",
            side: "BUY",
            order_configuration: { market_market_ioc: { base_size: "0.01" } },
        });
        const fills = (await venue.orders.getFills({ userId: "00000000-0000-0000-0000-000000000001" as never })) as { fills: { fill_price: string }[] };
        const fp = Number.parseFloat(fills.fills[0].fill_price);
        expect(fp).toBeGreaterThan(70_000);
        expect(fp).toBeCloseTo(70_000 * (1 + 5 / 10_000), 2);
    });

    it("leaves limit orders open", async () => {
        const venue = makeVenue();
        await venue.orders.createOrder({
            userId: "00000000-0000-0000-0000-000000000001" as never,
            client_order_id: "co-3",
            product_id: "BTCUSDT",
            side: "BUY",
            order_configuration: {
                limit_limit_gtc: { base_size: "0.01", limit_price: "69000" },
            },
        });
        const orders = (await venue.orders.getOrders({
            userId: "00000000-0000-0000-0000-000000000001" as never,
        })) as { orders: { status: string }[] };
        expect(orders.orders[0].status).toBe("open");
    });

    it("cancels open order", async () => {
        const venue = makeVenue();
        const created = (await venue.orders.createOrder({
            userId: "00000000-0000-0000-0000-000000000001" as never,
            client_order_id: "co-4",
            product_id: "BTCUSDT",
            side: "BUY",
            order_configuration: {
                limit_limit_gtc: { base_size: "0.01", limit_price: "1" },
            },
        })) as { order_id: string };
        const out = (await venue.orders.cancelOrder({
            userId: "00000000-0000-0000-0000-000000000001" as never,
            order_ids: [created.order_id],
        })) as { cancelled: string[] };
        expect(out.cancelled).toContain(created.order_id);
    });

    it("reports balance", async () => {
        const venue = makeVenue();
        const bal = (await venue.accounts.getBalance({
            userId: "00000000-0000-0000-0000-000000000001" as never,
        })) as { balances: Array<{ asset: string }> };
        expect(bal.balances.some((b) => b.asset === "USD")).toBe(true);
    });
});
