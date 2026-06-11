import { describe, it, expect, vi, beforeEach } from "vitest";
import { ServiceType } from "@elizaos/core";

import { ReconciliationService } from "../src/reconciliation/reconciliationService";
import type { LedgerOperations, PendingOrderLedgerRow } from "../src/reconciliation/types";
import type { ReconciliationServiceConfig } from "../src/reconciliation/reconciliationService";

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function makeMockLedger(): LedgerOperations {
    return {
        upsertPendingOrder: vi.fn().mockResolvedValue(undefined),
        updateOrderState: vi.fn().mockResolvedValue(null),
        getPendingOrderByClientOrderId: vi.fn().mockResolvedValue(null),
        getStaleSubmittedOrders: vi.fn().mockResolvedValue([]),
        getAllStaleSubmittedOrders: vi.fn().mockResolvedValue([]),
    };
}

function makeConfig(overrides: Partial<ReconciliationServiceConfig> = {}): ReconciliationServiceConfig {
    return {
        ledger: makeMockLedger(),
        credentials: [],
        ...overrides,
    };
}

function makeRow(overrides: Partial<PendingOrderLedgerRow> = {}): PendingOrderLedgerRow {
    return {
        request_id: "req-001",
        intent_hash: "hash-abc",
        client_order_id: "cb-xyz",
        venue: "binance",
        symbol: "BTCUSDT",
        userId: "user-1",
        state: "submitted",
        submittedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        latest_payload: {},
        locale: "en",
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ReconciliationService — instantiation", () => {
    it("can be instantiated with an empty credentials array", () => {
        expect(() => new ReconciliationService(makeConfig())).not.toThrow();
    });

    it("is an instance of ReconciliationService after construction", () => {
        const service = new ReconciliationService(makeConfig());
        expect(service).toBeInstanceOf(ReconciliationService);
    });
});

describe("ReconciliationService — serviceType", () => {
    it("static serviceType equals ServiceType.TRADING_RECONCILIATION", () => {
        expect(ReconciliationService.serviceType).toBe(ServiceType.TRADING_RECONCILIATION);
    });

    it("ServiceType.TRADING_RECONCILIATION has value 'trading_reconciliation'", () => {
        expect(ServiceType.TRADING_RECONCILIATION).toBe("trading_reconciliation");
    });
});

describe("ReconciliationService — acquireOrderLock", () => {
    it("returns a function (delegates to acquireTradingLock)", async () => {
        const service = new ReconciliationService(makeConfig());
        const release = await service.acquireOrderLock("user-1", "binance", "BTCUSDT-lock-test");
        expect(typeof release).toBe("function");
        // Clean up the lock.
        release();
    });

    it("returns independent release functions for different keys", async () => {
        const service = new ReconciliationService(makeConfig());
        const r1 = await service.acquireOrderLock("user-1", "binance", "KEY-A-rs");
        const r2 = await service.acquireOrderLock("user-1", "binance", "KEY-B-rs");
        expect(r1).not.toBe(r2);
        r1();
        r2();
    });
});

describe("ReconciliationService — trackOrder", () => {
    it("calls ledger.upsertPendingOrder with the provided row", async () => {
        const ledger = makeMockLedger();
        const service = new ReconciliationService(makeConfig({ ledger }));
        const row = makeRow();
        await service.trackOrder(row);
        expect(ledger.upsertPendingOrder).toHaveBeenCalledTimes(1);
        expect(ledger.upsertPendingOrder).toHaveBeenCalledWith(row);
    });

    it("returns a promise that resolves to undefined", async () => {
        const ledger = makeMockLedger();
        const service = new ReconciliationService(makeConfig({ ledger }));
        const result = await service.trackOrder(makeRow());
        expect(result).toBeUndefined();
    });
});

describe("ReconciliationService — getOrderState", () => {
    it("calls ledger.getPendingOrderByClientOrderId with the given id", async () => {
        const ledger = makeMockLedger();
        const service = new ReconciliationService(makeConfig({ ledger }));
        await service.getOrderState("cb-order-123");
        expect(ledger.getPendingOrderByClientOrderId).toHaveBeenCalledWith("cb-order-123");
    });

    it("returns null when ledger returns null", async () => {
        const ledger = makeMockLedger();
        (ledger.getPendingOrderByClientOrderId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
        const service = new ReconciliationService(makeConfig({ ledger }));
        const result = await service.getOrderState("nonexistent");
        expect(result).toBeNull();
    });

    it("returns the ledger row when found", async () => {
        const ledger = makeMockLedger();
        const row = makeRow({ client_order_id: "cb-found" });
        (ledger.getPendingOrderByClientOrderId as ReturnType<typeof vi.fn>).mockResolvedValue(row);
        const service = new ReconciliationService(makeConfig({ ledger }));
        const result = await service.getOrderState("cb-found");
        expect(result).toBe(row);
    });
});

describe("ReconciliationService — start and stop lifecycle", () => {
    it("start() with empty credentials does not throw", () => {
        const service = new ReconciliationService(makeConfig());
        expect(() => service.start()).not.toThrow();
        // Clean up the fallback poller interval.
        service.stop();
    });

    it("stop() after start() does not throw", () => {
        const service = new ReconciliationService(makeConfig());
        service.start();
        expect(() => service.stop()).not.toThrow();
    });

    it("stop() can be called multiple times without throwing", () => {
        const service = new ReconciliationService(makeConfig());
        service.start();
        service.stop();
        expect(() => service.stop()).not.toThrow();
    });

    it("start() then stop() leaves no active stop functions", () => {
        const service = new ReconciliationService(makeConfig());
        service.start();
        service.stop();
        // A second stop should be a no-op (empty stopFns array).
        expect(() => service.stop()).not.toThrow();
    });
});
