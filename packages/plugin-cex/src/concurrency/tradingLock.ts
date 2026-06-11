import { elizaLogger } from "@elizaos/core";

/**
 * Per-symbol trading lock: serializes concurrent `create_order` submits for
 * the same (userId, venue, symbol) triple.
 *
 * Design mirrors the `inFlightSlots` / `acquireLock` pattern from
 * `packages/core/src/handlers/comprehensiveAnalysisWorkflowGraph.ts` but is
 * simplified for the single-holder-per-key use case and returns an ergonomic
 * release function instead of a slot ID.
 */

/** How long a held lock may be kept without release before it is force-freed. */
const STALE_LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface LockEntry {
    /** Whether the lock is currently held by the front-of-queue caller. */
    held: boolean;
    /** FIFO queue of resolve callbacks waiting to acquire this lock. */
    queue: Array<() => void>;
    /** Timer that force-releases the lock after TTL. */
    staleTimer: ReturnType<typeof setTimeout>;
}

/** key → LockEntry, where key = `${userId}:${venue}:${symbol}`. */
const locks = new Map<string, LockEntry>();

// ---------------------------------------------------------------------------
// Observability helpers
// ---------------------------------------------------------------------------

/**
 * Returns count of currently held locks (for observability).
 */
export function activeLockCount(): number {
    return locks.size;
}

/**
 * Returns count of requests waiting in queue across all locks (for
 * observability).
 */
export function waitingRequestCount(): number {
    let total = 0;
    for (const entry of locks.values()) {
        total += entry.queue.length;
    }
    return total;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Create a stale-release timer for the given key.  The timer calls
 * `forceRelease` if the lock has not been released within `STALE_LOCK_TTL_MS`.
 * `unref()` ensures the timer does not prevent process exit.
 */
function makeStaleTimer(key: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
        const entry = locks.get(key);
        if (!entry) return;
        elizaLogger.warn(
            `[TradingLock] Stale lock detected for key="${key}" (held >${STALE_LOCK_TTL_MS / 1000}s). Force-releasing.`
        );
        forceRelease(key);
    }, STALE_LOCK_TTL_MS);
    // Allow the process to exit cleanly even if the timer is still pending.
    timer.unref();
    return timer;
}

/**
 * Force-release the lock for `key`: wake the next waiter or delete the entry.
 * Used by the stale-timer path.
 */
function forceRelease(key: string): void {
    const entry = locks.get(key);
    if (!entry) return;
    clearTimeout(entry.staleTimer);
    wakeNextOrDelete(key, entry);
}

/**
 * If there are waiters in the queue, hand the lock to the next one immediately
 * (don't transition through `held=false` to avoid a race window).
 * If the queue is empty, delete the map entry entirely.
 */
function wakeNextOrDelete(key: string, entry: LockEntry): void {
    if (entry.queue.length > 0) {
        // Hand ownership to the next waiter.
        const next = entry.queue.shift()!;
        // Refresh the stale timer for the new holder.
        entry.staleTimer = makeStaleTimer(key);
        // `held` stays true; we just changed who holds it.
        next();
    } else {
        locks.delete(key);
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Acquire the per-symbol trading lock. Serializes concurrent submits
 * for the same (userId, venue, symbol) triple.
 *
 * Returns a release function. Caller MUST call it in a finally block.
 *
 * The release function is idempotent — calling it more than once is a no-op.
 */
export async function acquireTradingLock(
    userId: string,
    venue: string,
    symbol: string,
): Promise<() => void> {
    const key = `${userId}:${venue}:${symbol}`;

    const existing = locks.get(key);

    if (!existing) {
        // Fast path: no entry at all — create one and immediately hold it.
        const entry: LockEntry = {
            held: true,
            queue: [],
            staleTimer: makeStaleTimer(key),
        };
        locks.set(key, entry);
        elizaLogger.debug(`[TradingLock] Acquired lock key="${key}"`);
        return makeReleaseFn(key);
    }

    // Slow path: lock is already held — join the FIFO queue.
    elizaLogger.debug(
        `[TradingLock] Waiting for lock key="${key}" (queue length: ${existing.queue.length + 1})`
    );
    await new Promise<void>((resolve) => {
        existing.queue.push(resolve);
    });
    elizaLogger.debug(`[TradingLock] Acquired lock (from queue) key="${key}"`);
    return makeReleaseFn(key);
}

/**
 * Build an idempotent release function for the given key.
 */
function makeReleaseFn(key: string): () => void {
    let released = false;
    return function releaseLock(): void {
        if (released) return; // idempotent
        released = true;

        const entry = locks.get(key);
        if (!entry) return; // already cleaned up (e.g. by stale timer)

        clearTimeout(entry.staleTimer);
        elizaLogger.debug(`[TradingLock] Released lock key="${key}"`);
        wakeNextOrDelete(key, entry);
    };
}
