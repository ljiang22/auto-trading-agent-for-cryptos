import { describe, it, expect, vi, beforeEach } from "vitest";

import { createMongoLedger } from "../src/reconciliation/pendingOrdersLedger";
import type {
    PendingOrderLedgerRow,
    PendingOrderStateTransition,
} from "../src/reconciliation/types";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeMockCollection() {
    const chain = { toArray: vi.fn().mockResolvedValue([]) };
    return {
        updateOne: vi.fn().mockResolvedValue({ acknowledged: true }),
        findOneAndUpdate: vi.fn().mockResolvedValue(null),
        findOne: vi.fn().mockResolvedValue(null),
        find: vi.fn().mockReturnValue(chain),
        _chain: chain,
    };
}

function makeMockDb(coll: ReturnType<typeof makeMockCollection>) {
    return { collection: vi.fn().mockReturnValue(coll) } as any;
}

// ---------------------------------------------------------------------------
// Sample data helpers
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<PendingOrderLedgerRow> = {}): PendingOrderLedgerRow {
    return {
        request_id: "req-001",
        intent_hash: "hash-abc",
        client_order_id: "cb-xyz123",
        venue: "binance",
        symbol: "BTCUSDT",
        userId: "user-1",
        state: "submitted",
        submittedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        latest_payload: { raw: true },
        locale: "en",
        ...overrides,
    };
}

function makeTransition(overrides: Partial<PendingOrderStateTransition> = {}): PendingOrderStateTransition {
    return {
        client_order_id: "cb-xyz123",
        new_state: "filled",
        payload: { filled: true },
        source: "ws",
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMongoLedger — upsertPendingOrder", () => {
    let coll: ReturnType<typeof makeMockCollection>;
    let ledger: ReturnType<typeof createMongoLedger>;

    beforeEach(() => {
        coll = makeMockCollection();
        ledger = createMongoLedger(makeMockDb(coll));
    });

    it("calls updateOne on the pending_orders_ledger collection", async () => {
        const row = makeRow();
        await ledger.upsertPendingOrder(row);
        expect(coll.updateOne).toHaveBeenCalledTimes(1);
    });

    it("filters by client_order_id", async () => {
        const row = makeRow({ client_order_id: "order-999" });
        await ledger.upsertPendingOrder(row);
        const [filter] = coll.updateOne.mock.calls[0];
        expect(filter).toEqual({ client_order_id: "order-999" });
    });

    it("includes upsert: true in the options", async () => {
        const row = makeRow();
        await ledger.upsertPendingOrder(row);
        const [, , options] = coll.updateOne.mock.calls[0];
        expect(options).toEqual({ upsert: true });
    });

    it("sets state, lastSeenAt, and latest_payload in $set", async () => {
        const row = makeRow({ state: "acked" });
        await ledger.upsertPendingOrder(row);
        const [, update] = coll.updateOne.mock.calls[0];
        expect(update.$set.state).toBe("acked");
        expect(update.$set.lastSeenAt).toBe(row.lastSeenAt);
        expect(update.$set.latest_payload).toBe(row.latest_payload);
    });

    it("places immutable fields in $setOnInsert", async () => {
        const row = makeRow();
        await ledger.upsertPendingOrder(row);
        const [, update] = coll.updateOne.mock.calls[0];
        expect(update.$setOnInsert.client_order_id).toBe(row.client_order_id);
        expect(update.$setOnInsert.request_id).toBe(row.request_id);
        expect(update.$setOnInsert.intent_hash).toBe(row.intent_hash);
        expect(update.$setOnInsert.venue).toBe(row.venue);
        expect(update.$setOnInsert.symbol).toBe(row.symbol);
        expect(update.$setOnInsert.userId).toBe(row.userId);
        expect(update.$setOnInsert.submittedAt).toBe(row.submittedAt);
        expect(update.$setOnInsert.locale).toBe(row.locale);
    });
});

describe("createMongoLedger — updateOrderState", () => {
    let coll: ReturnType<typeof makeMockCollection>;
    let ledger: ReturnType<typeof createMongoLedger>;

    beforeEach(() => {
        coll = makeMockCollection();
        ledger = createMongoLedger(makeMockDb(coll));
    });

    it("calls findOneAndUpdate on the collection", async () => {
        const transition = makeTransition();
        await ledger.updateOrderState(transition);
        expect(coll.findOneAndUpdate).toHaveBeenCalledTimes(1);
    });

    it("uses a $nin filter that excludes all terminal states", async () => {
        const transition = makeTransition();
        await ledger.updateOrderState(transition);
        const [filter] = coll.findOneAndUpdate.mock.calls[0];
        expect(filter.client_order_id).toBe(transition.client_order_id);
        const terminalStates = filter.state.$nin;
        expect(Array.isArray(terminalStates)).toBe(true);
        for (const s of ["filled", "cancelled", "expired", "rejected", "reconciliation_failed"]) {
            expect(terminalStates).toContain(s);
        }
    });

    it("sets returnDocument: 'after' in options", async () => {
        await ledger.updateOrderState(makeTransition());
        const [, , options] = coll.findOneAndUpdate.mock.calls[0];
        expect(options.returnDocument).toBe("after");
    });

    it("returns null when findOneAndUpdate returns null (terminal state or not found)", async () => {
        coll.findOneAndUpdate.mockResolvedValue(null);
        const result = await ledger.updateOrderState(makeTransition());
        expect(result).toBeNull();
    });

    it("returns the updated document when findOneAndUpdate succeeds", async () => {
        const row = makeRow({ state: "filled" });
        coll.findOneAndUpdate.mockResolvedValue(row);
        const result = await ledger.updateOrderState(makeTransition());
        expect(result).toBe(row);
    });

    it("includes venue_order_id in $set when provided", async () => {
        const transition = makeTransition({ venue_order_id: "ve-order-456" });
        await ledger.updateOrderState(transition);
        const [, update] = coll.findOneAndUpdate.mock.calls[0];
        expect(update.$set.venue_order_id).toBe("ve-order-456");
    });

    it("does not include venue_order_id in $set when not provided", async () => {
        const transition = makeTransition();
        // No venue_order_id set
        delete (transition as any).venue_order_id;
        await ledger.updateOrderState(transition);
        const [, update] = coll.findOneAndUpdate.mock.calls[0];
        expect(update.$set).not.toHaveProperty("venue_order_id");
    });

    it("sets new_state in the $set update fields", async () => {
        const transition = makeTransition({ new_state: "cancelled" });
        await ledger.updateOrderState(transition);
        const [, update] = coll.findOneAndUpdate.mock.calls[0];
        expect(update.$set.state).toBe("cancelled");
    });
});

describe("createMongoLedger — getPendingOrderByClientOrderId", () => {
    let coll: ReturnType<typeof makeMockCollection>;
    let ledger: ReturnType<typeof createMongoLedger>;

    beforeEach(() => {
        coll = makeMockCollection();
        ledger = createMongoLedger(makeMockDb(coll));
    });

    it("calls findOne with the correct client_order_id filter", async () => {
        await ledger.getPendingOrderByClientOrderId("cb-order-111");
        expect(coll.findOne).toHaveBeenCalledWith({ client_order_id: "cb-order-111" });
    });

    it("returns null when no document is found", async () => {
        coll.findOne.mockResolvedValue(null);
        const result = await ledger.getPendingOrderByClientOrderId("cb-order-111");
        expect(result).toBeNull();
    });

    it("returns the document when found", async () => {
        const row = makeRow({ client_order_id: "cb-order-111" });
        coll.findOne.mockResolvedValue(row);
        const result = await ledger.getPendingOrderByClientOrderId("cb-order-111");
        expect(result).toBe(row);
    });
});

describe("createMongoLedger — getStaleSubmittedOrders", () => {
    let coll: ReturnType<typeof makeMockCollection>;
    let ledger: ReturnType<typeof createMongoLedger>;

    beforeEach(() => {
        coll = makeMockCollection();
        ledger = createMongoLedger(makeMockDb(coll));
    });

    it("calls find with state: { $in: ['submitted','unknown'] } and a submittedAt $lt filter", async () => {
        const staleAfterMs = 60_000;
        const before = Date.now();
        await ledger.getStaleSubmittedOrders("user-1", staleAfterMs);
        const after = Date.now();

        expect(coll.find).toHaveBeenCalledTimes(1);
        const [filter] = coll.find.mock.calls[0];
        expect(filter.userId).toBe("user-1");
        // §6.0.3 — poller now drives both submitted AND unknown rows.
        expect(filter.state).toEqual({ $in: ["submitted", "unknown"] });
        expect(filter.submittedAt).toBeDefined();
        expect(filter.submittedAt.$lt).toBeDefined();

        // The threshold ISO string should correspond to (now - staleAfterMs).
        const threshold = new Date(filter.submittedAt.$lt).getTime();
        expect(threshold).toBeGreaterThanOrEqual(before - staleAfterMs);
        expect(threshold).toBeLessThanOrEqual(after - staleAfterMs + 100);
    });

    it("calls toArray() on the find cursor", async () => {
        await ledger.getStaleSubmittedOrders("user-1", 60_000);
        expect(coll._chain.toArray).toHaveBeenCalledTimes(1);
    });

    it("returns the array from toArray()", async () => {
        const rows = [makeRow()];
        coll._chain.toArray.mockResolvedValue(rows);
        const result = await ledger.getStaleSubmittedOrders("user-1", 60_000);
        expect(result).toBe(rows);
    });
});

describe("createMongoLedger — getAllStaleSubmittedOrders", () => {
    let coll: ReturnType<typeof makeMockCollection>;
    let ledger: ReturnType<typeof createMongoLedger>;

    beforeEach(() => {
        coll = makeMockCollection();
        ledger = createMongoLedger(makeMockDb(coll));
    });

    it("calls find with state: { $in: ['submitted','unknown'] } and a submittedAt $lt filter (no userId)", async () => {
        const staleAfterMs = 30_000;
        const before = Date.now();
        await ledger.getAllStaleSubmittedOrders(staleAfterMs);
        const after = Date.now();

        expect(coll.find).toHaveBeenCalledTimes(1);
        const [filter] = coll.find.mock.calls[0];
        // §6.0.3 — poller now drives both submitted AND unknown rows.
        expect(filter.state).toEqual({ $in: ["submitted", "unknown"] });
        expect(filter.submittedAt.$lt).toBeDefined();
        expect(filter).not.toHaveProperty("userId");

        const threshold = new Date(filter.submittedAt.$lt).getTime();
        expect(threshold).toBeGreaterThanOrEqual(before - staleAfterMs);
        expect(threshold).toBeLessThanOrEqual(after - staleAfterMs + 100);
    });

    it("returns the array from toArray()", async () => {
        const rows = [makeRow(), makeRow({ client_order_id: "cb-order-2" })];
        coll._chain.toArray.mockResolvedValue(rows);
        const result = await ledger.getAllStaleSubmittedOrders(30_000);
        expect(result).toBe(rows);
    });
});
