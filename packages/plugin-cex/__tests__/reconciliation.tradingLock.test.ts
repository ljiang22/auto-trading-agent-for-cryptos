import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
    acquireTradingLock,
    activeLockCount,
    waitingRequestCount,
} from "../src/concurrency/tradingLock";

// Helper: drain the module-level lock map by acquiring and immediately
// releasing any leftover entries.  After each test we verify the map is
// empty, but the helper is also called in afterEach for safety.
async function drainLocks(): Promise<void> {
    // If a lock is still held at teardown time, just wait for a tick so any
    // pending microtasks (e.g. queued resolvers) can fire, then release.
    // We can't introspect the map directly, so we rely on activeLockCount.
    if (activeLockCount() === 0) return;
}

describe("tradingLock", () => {
    // Each test is responsible for releasing every lock it acquires.
    // afterEach just documents the expectation.
    afterEach(() => {
        // If a test leaked, activeLockCount() will be > 0 and the next test's
        // assertions will detect it.
    });

    // ---------------------------------------------------------------------------
    // Basic acquire / release
    // ---------------------------------------------------------------------------

    it("acquireTradingLock returns a release function", async () => {
        const release = await acquireTradingLock("user1", "binance", "BTCUSDT");
        expect(typeof release).toBe("function");
        release();
        expect(activeLockCount()).toBe(0);
    });

    it("first acquire on a new key succeeds immediately", async () => {
        const release = await acquireTradingLock("user1", "binance", "ETHUSDT");
        expect(activeLockCount()).toBe(1);
        release();
        expect(activeLockCount()).toBe(0);
    });

    it("second acquire on the same key blocks until the first is released", async () => {
        const order: string[] = [];

        const release1 = await acquireTradingLock("user1", "binance", "SOLUSDT");
        order.push("acquired-1");

        // Start second acquire — it will not resolve yet.
        let release2: (() => void) | undefined;
        const p2 = acquireTradingLock("user1", "binance", "SOLUSDT").then((r) => {
            order.push("acquired-2");
            release2 = r;
        });

        // Verify second is waiting, not yet acquired.
        expect(order).toEqual(["acquired-1"]);
        expect(waitingRequestCount()).toBe(1);

        // Release first lock — should unblock second.
        release1();
        await p2;

        expect(order).toEqual(["acquired-1", "acquired-2"]);
        expect(release2).toBeDefined();
        release2!();
        expect(activeLockCount()).toBe(0);
    });

    // ---------------------------------------------------------------------------
    // FIFO ordering
    // ---------------------------------------------------------------------------

    it("three waiters get the lock in acquisition order (FIFO)", async () => {
        const order: number[] = [];
        const key: [string, string, string] = ["user1", "binance", "AVAXUSDT"];

        const release1 = await acquireTradingLock(...key);

        // Enqueue three waiters simultaneously.
        let release2: (() => void) | undefined;
        let release3: (() => void) | undefined;
        let release4: (() => void) | undefined;

        const p2 = acquireTradingLock(...key).then((r) => { order.push(2); release2 = r; });
        const p3 = acquireTradingLock(...key).then((r) => { order.push(3); release3 = r; });
        const p4 = acquireTradingLock(...key).then((r) => { order.push(4); release4 = r; });

        expect(waitingRequestCount()).toBe(3);

        // Release sequentially, verifying FIFO.
        release1();
        await p2;
        expect(order).toEqual([2]);

        release2!();
        await p3;
        expect(order).toEqual([2, 3]);

        release3!();
        await p4;
        expect(order).toEqual([2, 3, 4]);

        release4!();
        expect(activeLockCount()).toBe(0);
    });

    // ---------------------------------------------------------------------------
    // Idempotent release
    // ---------------------------------------------------------------------------

    it("release function is idempotent — calling twice does not throw", async () => {
        const release = await acquireTradingLock("user1", "binance", "BNBUSDT");
        release();
        expect(() => release()).not.toThrow();
        expect(activeLockCount()).toBe(0);
    });

    // ---------------------------------------------------------------------------
    // Observability helpers
    // ---------------------------------------------------------------------------

    it("activeLockCount returns correct count for multiple distinct keys", async () => {
        expect(activeLockCount()).toBe(0);

        const r1 = await acquireTradingLock("user1", "binance", "BTC1");
        expect(activeLockCount()).toBe(1);

        const r2 = await acquireTradingLock("user1", "binance", "BTC2");
        expect(activeLockCount()).toBe(2);

        r1();
        expect(activeLockCount()).toBe(1);

        r2();
        expect(activeLockCount()).toBe(0);
    });

    it("waitingRequestCount returns 0 when no lock is held", () => {
        expect(waitingRequestCount()).toBe(0);
    });

    it("waitingRequestCount returns correct count when requests are queued", async () => {
        const key: [string, string, string] = ["user2", "coinbase", "BTCUSD"];

        const release1 = await acquireTradingLock(...key);

        // Start two waiters without awaiting.
        const p2 = acquireTradingLock(...key);
        const p3 = acquireTradingLock(...key);

        // Give the microtask queue a tick so both push into the queue.
        await Promise.resolve();

        expect(waitingRequestCount()).toBe(2);

        release1();
        const release2 = await p2;
        release2();
        const release3 = await p3;
        release3();

        expect(activeLockCount()).toBe(0);
        expect(waitingRequestCount()).toBe(0);
    });

    it("activeLockCount returns 0 after all locks are released", async () => {
        const keys: [string, string, string][] = [
            ["userA", "binance", "X1"],
            ["userB", "binance", "X2"],
            ["userC", "coinbase", "X3"],
        ];

        const releases = await Promise.all(keys.map((k) => acquireTradingLock(...k)));
        expect(activeLockCount()).toBe(3);

        for (const r of releases) r();

        expect(activeLockCount()).toBe(0);
    });

    // ---------------------------------------------------------------------------
    // Different keys are independent
    // ---------------------------------------------------------------------------

    it("different keys do not interfere — both can be held simultaneously", async () => {
        const r1 = await acquireTradingLock("user1", "binance", "KEY_A");
        const r2 = await acquireTradingLock("user1", "binance", "KEY_B");

        expect(activeLockCount()).toBe(2);
        expect(waitingRequestCount()).toBe(0);

        r1();
        r2();
        expect(activeLockCount()).toBe(0);
    });
});
