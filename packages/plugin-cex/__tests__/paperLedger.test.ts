import { describe, it, expect } from "vitest";
import { createPaperVenue } from "../src/exchanges/services/paperVenue";
import {
    createAdapterBackedPaperOrderStore,
    createInMemoryPaperOrderStore,
} from "../src/exchanges/services/paperOrderStore";

// F3 — paper venue must persist orders across action calls.
// Previously the InternalState Map was instantiated fresh per call site,
// so an order placed in `create_order` was unreachable from a subsequent
// `cancel_order` or `get_orders` (QA H1+H2 reproduction). With the
// store-backed venue, two separate venue instances sharing the same
// store now see the same orders.

const USER_A = "00000000-0000-0000-0000-000000000001" as never;
const USER_B = "00000000-0000-0000-0000-000000000002" as never;

const makeVenueWithStore = (store = createInMemoryPaperOrderStore()) => {
    return createPaperVenue({
        getMidPrice: async () => 70_000,
        slippage: { kind: "linear_bps", bps: 5 },
        initialUsd: 10_000,
        store,
        venue: "binance",
        ttlSeconds: 86_400,
    });
};

describe("F3 paper venue persistence", () => {
    it("orders placed in one venue instance are visible from a second instance sharing the store", async () => {
        const store = createInMemoryPaperOrderStore();
        const v1 = makeVenueWithStore(store);
        const r1 = (await v1.orders.createOrder({
            userId: USER_A,
            client_order_id: "co-1",
            product_id: "BTC-USDT",
            side: "BUY",
            order_configuration: { limit_limit_gtc: { base_size: "0.01", limit_price: "65000" } },
        })) as { order_id: string };

        // New venue instance — same store
        const v2 = makeVenueWithStore(store);
        const list = (await v2.orders.getOrders({ userId: USER_A })) as {
            orders: Array<{ order_id: string; status: string }>;
        };
        expect(list.orders.find((o) => o.order_id === r1.order_id)).toBeTruthy();
    });

    it("paper orders are isolated by userId", async () => {
        const store = createInMemoryPaperOrderStore();
        const v1 = makeVenueWithStore(store);
        await v1.orders.createOrder({
            userId: USER_A,
            client_order_id: "co-2",
            product_id: "BTC-USDT",
            side: "BUY",
            order_configuration: { limit_limit_gtc: { base_size: "0.01", limit_price: "60000" } },
        });
        const v2 = makeVenueWithStore(store);
        const listB = (await v2.orders.getOrders({ userId: USER_B })) as {
            orders: unknown[];
        };
        expect(listB.orders).toHaveLength(0);
    });

    it("paper cancel on a known id returns cancelled[]; on unknown id returns not_found[]", async () => {
        const store = createInMemoryPaperOrderStore();
        const v = makeVenueWithStore(store);
        const r = (await v.orders.createOrder({
            userId: USER_A,
            client_order_id: "co-3",
            product_id: "BTC-USDT",
            side: "BUY",
            order_configuration: { limit_limit_gtc: { base_size: "0.01", limit_price: "60000" } },
        })) as { order_id: string };

        const cancelKnown = (await v.orders.cancelOrder({
            userId: USER_A,
            order_ids: [r.order_id],
        } as never)) as { cancelled: string[]; not_found: string[]; results: unknown[] };
        expect(cancelKnown.cancelled).toContain(r.order_id);
        expect(cancelKnown.not_found).toHaveLength(0);

        const cancelUnknown = (await v.orders.cancelOrder({
            userId: USER_A,
            order_ids: ["paper-ord-does-not-exist"],
        } as never)) as { cancelled: string[]; not_found: string[]; results: unknown[] };
        expect(cancelUnknown.cancelled).toHaveLength(0);
        expect(cancelUnknown.not_found).toContain("paper-ord-does-not-exist");
        expect(cancelUnknown.results).toHaveLength(0);
    });

    it("adapter-backed store routes addOrder/getOrders through the adapter", async () => {
        const adapterCalls: string[] = [];
        const adapterRows: Record<string, unknown>[] = [];
        const adapter = {
            paperOrdersAdd: async (rec: Record<string, unknown>) => {
                adapterCalls.push("add");
                adapterRows.push(rec);
            },
            paperOrdersGetByUser: async (userId: string) => {
                adapterCalls.push("get");
                return adapterRows.filter((r) => r.userId === userId);
            },
            paperOrdersGetById: async (userId: string, orderId: string) =>
                adapterRows.find((r) => r.userId === userId && r.order_id === orderId) ?? null,
            paperOrdersUpdateStatus: async (userId: string, orderId: string, status: string) => {
                const row = adapterRows.find((r) => r.userId === userId && r.order_id === orderId);
                if (!row) return false;
                row.status = status;
                return true;
            },
            paperFillsAdd: async () => {
                /* noop */
            },
            paperFillsGetByUser: async () => [],
        };
        const store = createAdapterBackedPaperOrderStore(adapter);
        const v = makeVenueWithStore(store);
        await v.orders.createOrder({
            userId: USER_A,
            client_order_id: "co-4",
            product_id: "BTC-USDT",
            side: "BUY",
            order_configuration: { limit_limit_gtc: { base_size: "0.01", limit_price: "60000" } },
        });
        expect(adapterCalls).toContain("add");
        const list = (await v.orders.getOrders({ userId: USER_A })) as { orders: unknown[] };
        expect(list.orders).toHaveLength(1);
        expect(adapterCalls).toContain("get");
    });
});
