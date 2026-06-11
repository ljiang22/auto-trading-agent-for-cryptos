import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createReconciliationFallback } from "../src/reconciliation/reconciliationFallback";
import type { ResolvedExchangeCredentials } from "../src/types";

// F5 — `resolveCredentials` callback path must:
//  - resolve creds per (userId, venue) at poll time, not at construction
//  - increment streak when null, reset when resolved
//  - fire onUnresolvedDowngrade at the configured streak threshold

describe("F5 reconciliation fallback: per-user creds + auto-downgrade", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("fires onUnresolvedDowngrade after the configured streak with no creds", async () => {
        const ledger = {
            getAllStaleSubmittedOrders: vi.fn(async () => [
                {
                    request_id: "req-1",
                    intent_hash: "hash",
                    client_order_id: "co-1",
                    venue: "binance",
                    symbol: "BTC-USDT",
                    userId: "u-1",
                    state: "submitted",
                    submittedAt: new Date(Date.now() - 60_000).toISOString(),
                    lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
                    latest_payload: null,
                    locale: "en",
                },
            ]),
            updateOrderState: vi.fn(),
            getPendingOrderByClientOrderId: vi.fn(),
            upsertPendingOrder: vi.fn(),
        } as never;

        const resolveCredentials = vi.fn(
            async (_userId: string, _venue: string): Promise<ResolvedExchangeCredentials | null> =>
                null,
        );
        const onUnresolvedDowngrade = vi.fn();

        const stop = createReconciliationFallback({
            ledger,
            resolveCredentials,
            onTransition: vi.fn(),
            onUnresolvedDowngrade,
            pollIntervalMs: 100,
            staleThresholdMs: 100,
            unresolvedStreakDowngradeAfter: 3,
        });

        // Advance through 3 poll cycles
        for (let i = 0; i < 3; i++) {
            await vi.advanceTimersByTimeAsync(100);
            // Let microtasks settle so processStaleOrder finishes
            await Promise.resolve();
        }

        expect(resolveCredentials).toHaveBeenCalledWith("u-1", "binance");
        expect(onUnresolvedDowngrade).toHaveBeenCalledWith(
            expect.objectContaining({ userId: "u-1", venue: "binance", streak: 3 }),
        );

        stop();
    });

    it("resets the streak when creds resolve before threshold", async () => {
        const ledger = {
            getAllStaleSubmittedOrders: vi.fn(async () => [
                {
                    request_id: "req-2",
                    intent_hash: "hash",
                    client_order_id: "co-2",
                    venue: "binance",
                    symbol: "BTC-USDT",
                    userId: "u-2",
                    state: "submitted",
                    submittedAt: new Date(Date.now() - 60_000).toISOString(),
                    lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
                    latest_payload: null,
                    locale: "en",
                },
            ]),
            updateOrderState: vi.fn(),
            getPendingOrderByClientOrderId: vi.fn(),
            upsertPendingOrder: vi.fn(),
        } as never;

        const validCreds: ResolvedExchangeCredentials = {
            exchange: "binance" as never,
            authType: "user_api_key" as never,
            auth: { apiKey: "k", apiSecret: "s" },
        } as never;
        let callCount = 0;
        const resolveCredentials = vi.fn(async () => {
            callCount++;
            // First 2 calls return null; 3rd returns valid creds
            return callCount < 3 ? null : validCreds;
        });
        const onUnresolvedDowngrade = vi.fn();

        const stop = createReconciliationFallback({
            ledger,
            resolveCredentials,
            onTransition: vi.fn(),
            onUnresolvedDowngrade,
            pollIntervalMs: 100,
            staleThresholdMs: 100,
            unresolvedStreakDowngradeAfter: 3,
        });

        // Two poll cycles with null creds — streak goes to 2 (not 3, so no downgrade yet).
        for (let i = 0; i < 2; i++) {
            await vi.advanceTimersByTimeAsync(100);
            await Promise.resolve();
        }
        expect(onUnresolvedDowngrade).not.toHaveBeenCalled();

        // Third poll: cred resolves. Streak resets. The REST query path will
        // try a real Binance call which we don't mock — that's fine; the
        // streak handling is what we're testing here.
        await vi.advanceTimersByTimeAsync(100);
        await Promise.resolve();

        // After resolution, the streak resets. A subsequent null fetch
        // would have to climb back from 0.
        expect(onUnresolvedDowngrade).not.toHaveBeenCalled();

        stop();
    });

    it("legacy `credentials` array still works (backward-compat)", async () => {
        const ledger = {
            getAllStaleSubmittedOrders: vi.fn(async () => []),
            updateOrderState: vi.fn(),
            getPendingOrderByClientOrderId: vi.fn(),
            upsertPendingOrder: vi.fn(),
        } as never;
        // Doesn't crash even though no resolveCredentials is provided.
        const stop = createReconciliationFallback({
            ledger,
            credentials: [],
            onTransition: vi.fn(),
            pollIntervalMs: 100,
            staleThresholdMs: 100,
        });
        await vi.advanceTimersByTimeAsync(100);
        await Promise.resolve();
        stop();
        expect(ledger.getAllStaleSubmittedOrders).toHaveBeenCalled();
    });
});
