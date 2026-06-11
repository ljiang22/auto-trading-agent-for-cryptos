/**
 * F5 — `runtime_lock` persistence helper.
 *
 * Wires the reconciliation auto-downgrade callback to the database
 * adapter's `user_trading_preferences` document. Extracted from
 * `agent/src/index.ts` so the persistence contract is unit-testable
 * without booting the whole runtime.
 *
 * Contract: on every unresolved-streak trigger, set
 *   `runtime_lock = "read_only_until={epochMs}"`
 *   `runtime_lock_reason = "reconciliation_unresolved_{venue}_streak{N}"`
 * on the user's preferences doc. The 15-minute window (default; override
 * via `lockDurationMs`) gives the user a graceful path to fix their
 * creds while keeping live writes refused.
 */

export interface UserTradingPreferencesAdapter {
    getUserTradingPreferences?: (userId: string) => Promise<Record<string, unknown> | null>;
    setUserTradingPreferences?: (
        userId: string,
        prefs: Record<string, unknown>,
    ) => Promise<void>;
}

export interface RuntimeLockWriterArgs {
    userId: string;
    venue: string;
    streak: number;
    lockDurationMs?: number;
    /** Injected for deterministic tests; defaults to `Date.now`. */
    nowMs?: number;
}

/**
 * Apply the runtime_lock write. Returns the prefs that were persisted
 * (useful for tests). Silently no-ops when the adapter doesn't implement
 * the required methods — same shape as the agent/src/index.ts
 * structural cast.
 */
export async function writeReconciliationRuntimeLock(
    adapter: UserTradingPreferencesAdapter,
    args: RuntimeLockWriterArgs,
): Promise<Record<string, unknown> | null> {
    if (
        typeof adapter.getUserTradingPreferences !== "function" ||
        typeof adapter.setUserTradingPreferences !== "function"
    ) {
        return null;
    }
    const lockDurationMs = args.lockDurationMs ?? 15 * 60 * 1000;
    const now = args.nowMs ?? Date.now();
    const lockUntil = now + lockDurationMs;
    const current = (await adapter.getUserTradingPreferences(args.userId)) ?? {};
    const next: Record<string, unknown> = {
        ...current,
        runtime_lock: `read_only_until=${lockUntil}`,
        runtime_lock_reason: `reconciliation_unresolved_${args.venue}_streak${args.streak}`,
    };
    await adapter.setUserTradingPreferences(args.userId, next);
    return next;
}
