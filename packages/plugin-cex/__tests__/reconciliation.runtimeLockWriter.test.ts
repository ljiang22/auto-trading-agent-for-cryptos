import { describe, it, expect, vi } from "vitest";
import { writeReconciliationRuntimeLock } from "../src/reconciliation/runtimeLockWriter";

// F5 — reviewer noted: the per-(userId, venue) auto-downgrade is tested
// at the callback-firing level (reconciliation.perUserCreds.test.ts) but
// not at the persistence layer. This test pins the contract:
//
//   - `runtime_lock` = `read_only_until={epochMs}` (15-min default window)
//   - `runtime_lock_reason` = `reconciliation_unresolved_{venue}_streak{N}`
//   - prior prefs are preserved (merge, not overwrite)
//   - missing adapter methods → no-op (the prod path should never throw
//     just because a non-Mongo adapter is wired)

const NOW = 1_700_000_000_000;

describe("F5 runtime_lock writer", () => {
    it("sets runtime_lock + runtime_lock_reason and preserves existing prefs", async () => {
        const stored: Record<string, Record<string, unknown>> = {
            "u-1": { default_mode: "live", max_order_notional_usd: 1_000 },
        };
        const adapter = {
            getUserTradingPreferences: vi.fn(async (uid: string) => stored[uid] ?? null),
            setUserTradingPreferences: vi.fn(
                async (uid: string, prefs: Record<string, unknown>) => {
                    stored[uid] = prefs;
                },
            ),
        };
        const result = await writeReconciliationRuntimeLock(adapter, {
            userId: "u-1",
            venue: "binance",
            streak: 60,
            nowMs: NOW,
        });
        expect(adapter.setUserTradingPreferences).toHaveBeenCalledTimes(1);
        const persisted = stored["u-1"];
        expect(persisted.runtime_lock).toBe(`read_only_until=${NOW + 15 * 60 * 1000}`);
        expect(persisted.runtime_lock_reason).toBe(
            "reconciliation_unresolved_binance_streak60",
        );
        // prior fields preserved
        expect(persisted.default_mode).toBe("live");
        expect(persisted.max_order_notional_usd).toBe(1_000);
        // returned shape matches what was written
        expect(result).toEqual(persisted);
    });

    it("creates the prefs doc on first write when none exists", async () => {
        const stored: Record<string, Record<string, unknown>> = {};
        const adapter = {
            getUserTradingPreferences: async (uid: string) => stored[uid] ?? null,
            setUserTradingPreferences: async (
                uid: string,
                prefs: Record<string, unknown>,
            ) => {
                stored[uid] = prefs;
            },
        };
        await writeReconciliationRuntimeLock(adapter, {
            userId: "u-new",
            venue: "coinbase",
            streak: 60,
            nowMs: NOW,
        });
        expect(stored["u-new"].runtime_lock).toBe(`read_only_until=${NOW + 15 * 60 * 1000}`);
        expect(stored["u-new"].runtime_lock_reason).toBe(
            "reconciliation_unresolved_coinbase_streak60",
        );
    });

    it("honors the lockDurationMs override", async () => {
        const stored: Record<string, Record<string, unknown>> = {};
        const adapter = {
            getUserTradingPreferences: async () => null,
            setUserTradingPreferences: async (
                uid: string,
                prefs: Record<string, unknown>,
            ) => {
                stored[uid] = prefs;
            },
        };
        await writeReconciliationRuntimeLock(adapter, {
            userId: "u-2",
            venue: "binance",
            streak: 60,
            nowMs: NOW,
            lockDurationMs: 30 * 60 * 1000, // 30 min override
        });
        expect(stored["u-2"].runtime_lock).toBe(`read_only_until=${NOW + 30 * 60 * 1000}`);
    });

    it("returns null when the adapter doesn't expose getUserTradingPreferences (e.g., SQLite fallback)", async () => {
        const adapter = {
            // intentionally missing methods
        };
        const result = await writeReconciliationRuntimeLock(adapter, {
            userId: "u-3",
            venue: "binance",
            streak: 60,
            nowMs: NOW,
        });
        expect(result).toBeNull();
    });

    it("propagates a setUserTradingPreferences failure (caller catches at the agent layer)", async () => {
        const adapter = {
            getUserTradingPreferences: async () => ({}),
            setUserTradingPreferences: async () => {
                throw new Error("mongo write failed");
            },
        };
        await expect(
            writeReconciliationRuntimeLock(adapter, {
                userId: "u-4",
                venue: "binance",
                streak: 60,
                nowMs: NOW,
            }),
        ).rejects.toThrow("mongo write failed");
    });
});
