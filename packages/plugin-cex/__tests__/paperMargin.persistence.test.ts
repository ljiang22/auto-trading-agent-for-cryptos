import { describe, it, expect } from "vitest";
import { createPaperVenue } from "../src/exchanges/services/paperVenue";
import {
    createInMemoryPaperOrderStore,
    createAdapterBackedPaperOrderStore,
    type PaperOrderRecord,
} from "../src/exchanges/services/paperOrderStore";

// F9 — paper margin orders must persist `margin_type`, `margin_action`,
// and `leverage` on the order record so the paper ledger faithfully
// reproduces venue semantics. Reviewer flagged that the canonical
// margin params were silently dropped before this commit.

const USER = "00000000-0000-0000-0000-000000000001" as never;

function makeVenue(store = createInMemoryPaperOrderStore()) {
    return createPaperVenue({
        getMidPrice: async () => 70_000,
        slippage: { kind: "linear_bps", bps: 5 },
        initialUsd: 10_000,
        store,
        venue: "binance",
        ttlSeconds: 86_400,
    });
}

describe("F9 paper margin persistence", () => {
    it("persists margin_type=CROSS, margin_action=AUTO_BORROW, leverage=2 on a paper CROSS limit order", async () => {
        const store = createInMemoryPaperOrderStore();
        const venue = makeVenue(store);

        await venue.orders.createOrder({
            userId: USER,
            client_order_id: "co-cross-1",
            product_id: "BTC-USDT",
            side: "BUY",
            order_configuration: {
                limit_limit_gtc: { base_size: "0.001", limit_price: "60000" },
            },
            margin_type: "CROSS",
            margin_action: "AUTO_BORROW",
            leverage: "2",
        } as never);

        const rows = (await venue.orders.getOrders({ userId: USER })) as {
            orders: Array<Record<string, unknown>>;
        };
        expect(rows.orders).toHaveLength(1);
        const order = rows.orders[0];
        expect(order.margin_type).toBe("CROSS");
        expect(order.margin_action).toBe("AUTO_BORROW");
        expect(order.leverage).toBe("2");
        expect(order.client_order_id).toBe("co-cross-1");
        expect(order.status).toBe("open");
    });

    it("persists margin fields on a paper ISOLATED order too", async () => {
        const store = createInMemoryPaperOrderStore();
        const venue = makeVenue(store);
        await venue.orders.createOrder({
            userId: USER,
            client_order_id: "co-iso-1",
            product_id: "ETH-USDT",
            side: "SELL",
            order_configuration: {
                limit_limit_gtc: { base_size: "0.05", limit_price: "3500" },
            },
            margin_type: "ISOLATED",
            margin_action: "NORMAL",
            leverage: "5",
        } as never);
        const rows = (await venue.orders.getOrders({ userId: USER })) as {
            orders: Array<Record<string, unknown>>;
        };
        const order = rows.orders[0];
        expect(order.margin_type).toBe("ISOLATED");
        expect(order.margin_action).toBe("NORMAL");
        expect(order.leverage).toBe("5");
    });

    it("does NOT add margin_* keys to a spot order (no margin_type passed)", async () => {
        const store = createInMemoryPaperOrderStore();
        const venue = makeVenue(store);
        await venue.orders.createOrder({
            userId: USER,
            client_order_id: "co-spot-1",
            product_id: "BTC-USDT",
            side: "BUY",
            order_configuration: { market_market_ioc: { base_size: "0.001" } },
        } as never);
        const rows = (await venue.orders.getOrders({ userId: USER })) as {
            orders: Array<Record<string, unknown>>;
        };
        const order = rows.orders[0];
        expect(order.margin_type).toBeUndefined();
        expect(order.margin_action).toBeUndefined();
        expect(order.leverage).toBeUndefined();
    });

    it("adapter-backed store receives the margin fields verbatim", async () => {
        // Asserts the store boundary — what the SQLite / Mongo adapter
        // actually sees on `paperOrdersAdd`. If the venue silently
        // dropped margin_* fields before write, this test fails.
        const captured: PaperOrderRecord[] = [];
        const adapter = {
            paperOrdersAdd: async (rec: Record<string, unknown>) => {
                captured.push(rec as PaperOrderRecord);
            },
            paperOrdersGetByUser: async () => [],
            paperOrdersGetById: async () => null,
            paperOrdersUpdateStatus: async () => true,
            paperFillsAdd: async () => {},
            paperFillsGetByUser: async () => [],
        };
        const store = createAdapterBackedPaperOrderStore(adapter);
        const venue = makeVenue(store);
        await venue.orders.createOrder({
            userId: USER,
            client_order_id: "co-cross-adapter",
            product_id: "BTC-USDT",
            side: "BUY",
            order_configuration: {
                limit_limit_gtc: { base_size: "0.001", limit_price: "60000" },
            },
            margin_type: "CROSS",
            margin_action: "AUTO_BORROW",
            leverage: "2",
        } as never);
        expect(captured).toHaveLength(1);
        expect(captured[0].margin_type).toBe("CROSS");
        expect(captured[0].margin_action).toBe("AUTO_BORROW");
        expect(captured[0].leverage).toBe("2");
    });
});
