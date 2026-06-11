import { describe, expect, it, vi } from "vitest";
import { checkExistingOrder } from "../../src/idempotency/preSubmitDedup";
import type { LedgerOperations, PendingOrderLedgerRow } from "../../src/reconciliation/types";

function makeLedger(seed: Record<string, PendingOrderLedgerRow> = {}): Pick<
    LedgerOperations,
    "getPendingOrderByClientOrderId"
> {
    return {
        async getPendingOrderByClientOrderId(client_order_id) {
            return seed[client_order_id] ?? null;
        },
    };
}

function makeRow(state: PendingOrderLedgerRow["state"]): PendingOrderLedgerRow {
    return {
        request_id: "req-1",
        intent_hash: "h-1",
        client_order_id: "bn-abc",
        venue: "binance",
        symbol: "BTC-USDT",
        userId: "user-1",
        state,
        submittedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        latest_payload: null,
        locale: "en",
    };
}

describe("checkExistingOrder", () => {
    it("returns kind=new when ledger has no row", async () => {
        const ledger = makeLedger();
        const out = await checkExistingOrder(ledger, "bn-abc");
        expect(out.kind).toBe("new");
    });

    it("returns kind=new for empty client_order_id without hitting the ledger", async () => {
        const spy = vi.fn().mockResolvedValue(null);
        const ledger = { getPendingOrderByClientOrderId: spy };
        const out = await checkExistingOrder(ledger, "");
        expect(out.kind).toBe("new");
        expect(spy).not.toHaveBeenCalled();
    });

    it("classifies non-terminal states as in_flight", async () => {
        for (const state of ["submitted", "acked", "partially_filled"] as const) {
            const ledger = makeLedger({ "bn-abc": makeRow(state) });
            const out = await checkExistingOrder(ledger, "bn-abc");
            expect(out.kind).toBe("in_flight");
            if (out.kind === "in_flight") expect(out.order.state).toBe(state);
        }
    });

    it("classifies unknown state distinctly", async () => {
        const ledger = makeLedger({ "bn-abc": makeRow("unknown") });
        const out = await checkExistingOrder(ledger, "bn-abc");
        expect(out.kind).toBe("unknown_state");
    });

    it("classifies all terminal states", async () => {
        for (const state of [
            "filled",
            "cancelled",
            "expired",
            "rejected",
            "reconciliation_failed",
        ] as const) {
            const ledger = makeLedger({ "bn-abc": makeRow(state) });
            const out = await checkExistingOrder(ledger, "bn-abc");
            expect(out.kind).toBe("terminal");
        }
    });

    it("simulates the network-retry race: second submit short-circuits", async () => {
        // First call: ledger has no row → kind=new, caller proceeds to venue.
        // Between venue ack and second submit, ledger row is upserted.
        // Second call: ledger now has a row in `submitted`/`acked` → in_flight.
        const seed: Record<string, PendingOrderLedgerRow> = {};
        const ledger = makeLedger(seed);

        const first = await checkExistingOrder(ledger, "bn-abc");
        expect(first.kind).toBe("new");

        // Simulate the ledger upsert that happens post-venue-submit.
        seed["bn-abc"] = makeRow("submitted");

        const second = await checkExistingOrder(ledger, "bn-abc");
        expect(second.kind).toBe("in_flight");
    });
});
