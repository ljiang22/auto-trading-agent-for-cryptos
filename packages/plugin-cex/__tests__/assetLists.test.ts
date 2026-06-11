import { describe, expect, it, vi } from "vitest";

import {
    addAllowedAssetAction,
    addBlockedAssetAction,
    listAssetListsAction,
    normalizeAsset,
    readPrefs,
    removeAllowedAssetAction,
    removeBlockedAssetAction,
    writePrefs,
} from "../src/actions/assetLists";
import { buildCanonicalIntent } from "../src/intent/intentBuilder";
import { evaluate as evaluateRisk } from "../src/risk/riskEngine";
import {
    DEFAULT_USER_TRADING_PREFERENCES,
    type UserTradingPreferences,
} from "../src/risk/types";

const USER = "00000000-0000-0000-0000-000000000001";

function makeMemory(text = "block DOGE") {
    return {
        userId: USER,
        content: { text },
    } as never;
}

interface MockAdapter {
    getUserTradingPreferences: ReturnType<typeof vi.fn>;
    setUserTradingPreferences: ReturnType<typeof vi.fn>;
    store: Map<string, Record<string, unknown>>;
}

function makeRuntime(opts: {
    initial?: Record<string, unknown>;
    adapterHasMethod?: boolean;
    cache?: Map<string, unknown>;
} = {}): { runtime: never; adapter: MockAdapter; cache: Map<string, unknown> } {
    const store = new Map<string, Record<string, unknown>>();
    if (opts.initial) store.set(USER, opts.initial);
    const cache = opts.cache ?? new Map<string, unknown>();

    const adapter: MockAdapter = {
        store,
        getUserTradingPreferences: vi.fn(async (uid: string) => store.get(uid) ?? null),
        setUserTradingPreferences: vi.fn(async (uid: string, prefs: Record<string, unknown>) => {
            store.set(uid, { ...prefs });
        }),
    };

    const runtime = {
        cacheManager: {
            get: vi.fn(async (key: string) => cache.get(key)),
            set: vi.fn(async (key: string, value: unknown) => {
                cache.set(key, value);
            }),
        },
        databaseAdapter:
            opts.adapterHasMethod === false ? {} : adapter,
    } as never;

    return { runtime, adapter, cache };
}

describe("normalizeAsset", () => {
    it("uppercases valid tickers", () => {
        expect(normalizeAsset("doge")).toBe("DOGE");
        expect(normalizeAsset(" DOGE ")).toBe("DOGE");
        expect(normalizeAsset("1000PEPE")).toBe("1000PEPE");
    });

    it("rejects empty / whitespace input", () => {
        expect(normalizeAsset("")).toBeNull();
        expect(normalizeAsset("   ")).toBeNull();
        expect(normalizeAsset(null)).toBeNull();
        expect(normalizeAsset(undefined)).toBeNull();
    });

    it("rejects non-alphanumeric (emoji, symbols)", () => {
        expect(normalizeAsset("DOGE!")).toBeNull();
        expect(normalizeAsset("🐕")).toBeNull();
        expect(normalizeAsset("DOG-E")).toBeNull();
        expect(normalizeAsset("DOG E")).toBeNull();
    });

    it("rejects overly long tickers", () => {
        expect(normalizeAsset("A".repeat(13))).toBeNull();
    });
});

describe("readPrefs / writePrefs helpers", () => {
    it("readPrefs returns {} when no adapter method present", async () => {
        const { runtime } = makeRuntime({ adapterHasMethod: false });
        const prefs = await readPrefs(runtime, USER);
        expect(prefs).toEqual({});
    });

    it("readPrefs returns stored prefs from adapter", async () => {
        const { runtime } = makeRuntime({
            initial: { asset_blocklist: ["DOGE"] },
        });
        const prefs = await readPrefs(runtime, USER);
        expect(prefs.asset_blocklist).toEqual(["DOGE"]);
    });

    it("writePrefs mirrors to cache and adapter", async () => {
        const { runtime, adapter, cache } = makeRuntime();
        await writePrefs(runtime, USER, { asset_blocklist: ["DOGE"] });
        expect(adapter.setUserTradingPreferences).toHaveBeenCalledTimes(1);
        expect(cache.get(`user_trading_preferences:${USER}`)).toEqual({
            asset_blocklist: ["DOGE"],
        });
    });
});

describe("add_blocked_asset action", () => {
    it("adds an asset to an empty blocklist and replies with the count", async () => {
        const { runtime, adapter } = makeRuntime();
        const callback = vi.fn(async () => {});
        const result = (await addBlockedAssetAction.handler(
            runtime,
            makeMemory("block DOGE"),
            undefined,
            { asset: "DOGE" },
            callback,
        )) as { success: boolean; after: string[]; changed: boolean };

        expect(result.success).toBe(true);
        expect(result.after).toEqual(["DOGE"]);
        expect(result.changed).toBe(true);
        expect(adapter.store.get(USER)).toEqual({ asset_blocklist: ["DOGE"] });
        expect(callback).toHaveBeenCalledTimes(1);
        const reply = callback.mock.calls[0][0];
        expect(reply.text).toContain("Added DOGE");
        expect(reply.text).toContain("block list");
        expect(reply.text).toContain("now 1 entries");
    });

    it("is idempotent on repeat — no second mutation, no count growth", async () => {
        const { runtime, adapter } = makeRuntime({
            initial: { asset_blocklist: ["DOGE"] },
        });
        const callback = vi.fn(async () => {});
        const result = (await addBlockedAssetAction.handler(
            runtime,
            makeMemory("block DOGE"),
            undefined,
            { asset: "DOGE" },
            callback,
        )) as { success: boolean; after: string[]; changed: boolean };

        expect(result.success).toBe(true);
        expect(result.after).toEqual(["DOGE"]);
        expect(result.changed).toBe(false);
        // Adapter's set is NOT called when nothing changed.
        expect(adapter.setUserTradingPreferences).not.toHaveBeenCalled();
    });

    it("preserves other preference fields when writing", async () => {
        const { runtime, adapter } = makeRuntime({
            initial: { default_mode: "paper", asset_allowlist: ["BTC"] },
        });
        await addBlockedAssetAction.handler(
            runtime,
            makeMemory(),
            undefined,
            { asset: "DOGE" },
            vi.fn(),
        );
        const stored = adapter.store.get(USER);
        expect(stored?.default_mode).toBe("paper");
        expect(stored?.asset_allowlist).toEqual(["BTC"]);
        expect(stored?.asset_blocklist).toEqual(["DOGE"]);
    });

    it("returns a clarification when no asset can be parsed", async () => {
        const { runtime } = makeRuntime();
        const callback = vi.fn(async () => {});
        const result = (await addBlockedAssetAction.handler(
            runtime,
            { userId: USER, content: { text: "block" } } as never,
            undefined,
            {},
            callback,
        )) as { success: boolean; clarification: string };

        expect(result.success).toBe(false);
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback.mock.calls[0][0].metadata.clarification).toBe(true);
    });

    it("extracts asset from the message text when options are missing", async () => {
        const { runtime, adapter } = makeRuntime();
        await addBlockedAssetAction.handler(
            runtime,
            makeMemory("Please block SHIB from now on"),
            undefined,
            undefined,
            vi.fn(),
        );
        expect(adapter.store.get(USER)).toEqual({ asset_blocklist: ["SHIB"] });
    });
});

describe("remove_blocked_asset action", () => {
    it("removes an existing asset and returns size 0", async () => {
        const { runtime, adapter } = makeRuntime({
            initial: { asset_blocklist: ["DOGE"] },
        });
        const callback = vi.fn(async () => {});
        const result = (await removeBlockedAssetAction.handler(
            runtime,
            makeMemory("unblock DOGE"),
            undefined,
            { asset: "DOGE" },
            callback,
        )) as { success: boolean; after: string[]; changed: boolean };

        expect(result.success).toBe(true);
        expect(result.after).toEqual([]);
        expect(result.changed).toBe(true);
        expect(adapter.store.get(USER)).toEqual({ asset_blocklist: [] });
        const reply = callback.mock.calls[0][0];
        expect(reply.text).toContain("Removed DOGE");
        expect(reply.text).toContain("now 0 entries");
    });

    it("is idempotent when removing a non-present asset", async () => {
        const { runtime, adapter } = makeRuntime({
            initial: { asset_blocklist: ["BTC"] },
        });
        const result = (await removeBlockedAssetAction.handler(
            runtime,
            makeMemory(),
            undefined,
            { asset: "DOGE" },
            vi.fn(),
        )) as { success: boolean; changed: boolean; after: string[] };
        expect(result.changed).toBe(false);
        expect(result.after).toEqual(["BTC"]);
        expect(adapter.setUserTradingPreferences).not.toHaveBeenCalled();
    });
});

describe("add_allowed_asset / remove_allowed_asset (mirror)", () => {
    it("add_allowed_asset appends to asset_allowlist", async () => {
        const { runtime, adapter } = makeRuntime();
        const result = (await addAllowedAssetAction.handler(
            runtime,
            makeMemory("add BTC to my allowlist"),
            undefined,
            { asset: "BTC" },
            vi.fn(),
        )) as { success: boolean; after: string[] };
        expect(result.after).toEqual(["BTC"]);
        expect(adapter.store.get(USER)).toEqual({ asset_allowlist: ["BTC"] });
    });

    it("remove_allowed_asset returns size 0 after add+remove", async () => {
        const { runtime } = makeRuntime();
        await addAllowedAssetAction.handler(
            runtime,
            makeMemory(),
            undefined,
            { asset: "BTC" },
            vi.fn(),
        );
        const result = (await removeAllowedAssetAction.handler(
            runtime,
            makeMemory(),
            undefined,
            { asset: "BTC" },
            vi.fn(),
        )) as { after: string[] };
        expect(result.after).toEqual([]);
    });
});

describe("list_asset_lists action (read-only)", () => {
    it("returns both arrays from stored prefs", async () => {
        const { runtime } = makeRuntime({
            initial: {
                asset_allowlist: ["BTC", "ETH"],
                asset_blocklist: ["DOGE"],
            },
        });
        const callback = vi.fn(async () => {});
        const result = (await listAssetListsAction.handler(
            runtime,
            makeMemory("show my asset lists"),
            undefined,
            undefined,
            callback,
        )) as { asset_allowlist: string[]; asset_blocklist: string[] };
        expect(result.asset_allowlist).toEqual(["BTC", "ETH"]);
        expect(result.asset_blocklist).toEqual(["DOGE"]);
        expect(callback).toHaveBeenCalledTimes(1);
        const reply = callback.mock.calls[0][0];
        expect(reply.text).toContain("BTC, ETH");
        expect(reply.text).toContain("DOGE");
    });

    it("returns empty arrays when nothing is stored", async () => {
        const { runtime } = makeRuntime();
        const callback = vi.fn(async () => {});
        const result = (await listAssetListsAction.handler(
            runtime,
            makeMemory("show my asset lists"),
            undefined,
            undefined,
            callback,
        )) as { asset_allowlist: string[]; asset_blocklist: string[] };
        expect(result.asset_allowlist).toEqual([]);
        expect(result.asset_blocklist).toEqual([]);
        const reply = callback.mock.calls[0][0];
        expect(reply.text).toContain("(0)");
    });
});

describe("Fix 8 end-to-end — add_blocked_asset blocks a follow-up DOGE buy", () => {
    it("after add_blocked_asset({DOGE}), the risk engine returns block for a DOGE buy", async () => {
        const { runtime, adapter } = makeRuntime();
        // 1. Block DOGE.
        await addBlockedAssetAction.handler(
            runtime,
            makeMemory("block DOGE"),
            undefined,
            { asset: "DOGE" },
            vi.fn(),
        );
        // 2. Build a DOGE buy intent. The assetAllowlist rule extracts
        // the base asset via dash split — use the canonical BASE-QUOTE
        // form (every rule that depends on a base asset assumes this).
        const intent = buildCanonicalIntent({
            action: "create_order",
            venue: "binance",
            userId: USER,
            locale: "en",
            params: {
                userId: USER,
                product_id: "DOGE-USDT",
                side: "BUY",
                order_configuration: {
                    market_market_ioc: { base_size: "10" },
                },
            },
        });
        // 3. Build the risk preferences from the stored prefs row.
        const stored = adapter.store.get(USER) ?? {};
        const prefs: UserTradingPreferences = {
            userId: USER,
            ...DEFAULT_USER_TRADING_PREFERENCES,
            ...(stored as Partial<UserTradingPreferences>),
            updatedAt: new Date().toISOString(),
        };
        expect(prefs.asset_blocklist).toEqual(["DOGE"]);
        // 4. Evaluate.
        const decision = evaluateRisk(intent, { preferences: prefs });
        expect(decision.verdict).toBe("block");
        expect(decision.rules_fired).toContain("assetAllowlist");
    });

    it("clearing the blocklist via remove_blocked_asset allows the buy again", async () => {
        // 2026-05-25 hardening — DEFAULT_USER_TRADING_PREFERENCES.asset_allowlist
        // is now non-empty (BTC/ETH/SOL/USDT/USDC). For this test to isolate
        // blocklist-clearing behaviour we explicitly opt DOGE into the
        // allowlist; otherwise the new default allowlist also blocks DOGE
        // and the rule still fires.
        const { runtime, adapter } = makeRuntime({
            initial: { asset_blocklist: ["DOGE"], asset_allowlist: ["DOGE"] },
        });
        await removeBlockedAssetAction.handler(
            runtime,
            makeMemory(),
            undefined,
            { asset: "DOGE" },
            vi.fn(),
        );
        const intent = buildCanonicalIntent({
            action: "create_order",
            venue: "binance",
            userId: USER,
            locale: "en",
            params: {
                userId: USER,
                product_id: "DOGE-USDT",
                side: "BUY",
                order_configuration: {
                    market_market_ioc: { base_size: "10" },
                },
            },
        });
        const stored = adapter.store.get(USER) ?? {};
        const prefs: UserTradingPreferences = {
            userId: USER,
            ...DEFAULT_USER_TRADING_PREFERENCES,
            ...(stored as Partial<UserTradingPreferences>),
            updatedAt: new Date().toISOString(),
        };
        const decision = evaluateRisk(intent, { preferences: prefs });
        // assetAllowlist no longer fires; if downstream rules block
        // (e.g. notional cap), the verdict may still be "block" but
        // assetAllowlist should NOT be among rules_fired.
        expect(decision.rules_fired).not.toContain("assetAllowlist");
    });
});
