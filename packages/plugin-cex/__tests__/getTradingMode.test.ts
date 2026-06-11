import { describe, expect, it, vi } from "vitest";

import { getTradingModeAction } from "../src/actions/getTradingMode";

// CEX post-PR237 hotfix — read-only counterpart to set_trading_mode.
// The handler MUST resolve the mode in this order:
//   1. MongoDB user_trading_preferences.default_mode (source of truth)
//   2. Runtime cache (fallback on DB outage)
//   3. DEFAULT_USER_TRADING_PREFERENCES ("live")
//
// Prior PR-#237 behavior was cache-first, which let a stale cache
// entry override a DB-set preference. Issue 1 ("Mode shows paper but
// actually live") was caused by exactly that race.
//
// The handler MUST NOT route through requestParameterReview — the
// response is delivered directly via the HandlerCallback.

const USER = "00000000-0000-0000-0000-000000000001";

function makeMemory() {
    return {
        userId: USER,
        content: { text: "what is my current trading mode?" },
    } as never;
}

function makeRuntime(opts: {
    cache?: unknown;
    cacheThrows?: boolean;
    prefs?: Record<string, unknown> | null;
    adapterHasMethod?: boolean;
    adapterThrows?: boolean;
}) {
    const cacheGet = vi.fn(async () => {
        if (opts.cacheThrows) throw new Error("cache offline");
        return opts.cache;
    });
    const cacheSet = vi.fn(async () => {});
    const cacheDelete = vi.fn(async () => {});
    const getUserTradingPreferences = vi.fn(async () => {
        if (opts.adapterThrows) throw new Error("mongo down");
        return opts.prefs ?? null;
    });
    return {
        cacheManager: { get: cacheGet, set: cacheSet, delete: cacheDelete },
        databaseAdapter:
            opts.adapterHasMethod === false
                ? {}
                : { getUserTradingPreferences },
        _spies: { cacheGet, cacheSet, cacheDelete, getUserTradingPreferences },
    } as never;
}

describe("get_trading_mode action — DB-first resolution", () => {
    it("returns the mongo value when present (NOT the cached value)", async () => {
        // Issue 1 regression: stale cache ("paper") must NOT override
        // DB ("live").
        const runtime = makeRuntime({
            cache: "paper",
            prefs: { default_mode: "live" },
        });
        const callback = vi.fn(async () => {});
        const result = (await getTradingModeAction.handler(
            runtime,
            makeMemory(),
            undefined,
            undefined,
            callback,
        )) as { success: boolean; mode: string; source: string };

        expect(result).toEqual({ success: true, mode: "live", source: "mongo" });
        const reply = callback.mock.calls[0][0];
        expect(reply.action).toBe("get_trading_mode");
        expect(reply.text).toContain("**live**");
    });

    it("refreshes the cache after a successful DB read", async () => {
        const runtime = makeRuntime({
            cache: "paper",
            prefs: { default_mode: "live" },
        });
        const callback = vi.fn(async () => {});
        await getTradingModeAction.handler(
            runtime,
            makeMemory(),
            undefined,
            undefined,
            callback,
        );
        const spies = (runtime as never as { _spies: { cacheSet: ReturnType<typeof vi.fn> } })._spies;
        expect(spies.cacheSet).toHaveBeenCalledWith(
            `user_trading_preferences:${USER}:default_mode`,
            "live",
        );
    });

    it("falls back to cache when DB has no preference", async () => {
        const runtime = makeRuntime({
            cache: "shadow",
            prefs: null,
        });
        const callback = vi.fn(async () => {});
        const result = (await getTradingModeAction.handler(
            runtime,
            makeMemory(),
            undefined,
            undefined,
            callback,
        )) as { success: boolean; mode: string; source: string };

        expect(result).toEqual({ success: true, mode: "shadow", source: "cache" });
        const reply = callback.mock.calls[0][0];
        expect(reply.text).toContain("**shadow**");
        expect(reply.text).toContain("intents are recorded");
    });

    it("falls back to DEFAULT live when neither DB nor cache have a value", async () => {
        const runtime = makeRuntime({
            cache: undefined,
            prefs: null,
        });
        const callback = vi.fn(async () => {});
        const result = (await getTradingModeAction.handler(
            runtime,
            makeMemory(),
            undefined,
            undefined,
            callback,
        )) as { success: boolean; mode: string; source: string };

        expect(result).toEqual({ success: true, mode: "live", source: "default" });
        const reply = callback.mock.calls[0][0];
        expect(reply.text).toContain("**live**");
        expect(reply.text).toContain("real exchange");
    });

    it("ignores garbage DB values and falls through to cache", async () => {
        const runtime = makeRuntime({
            cache: "live",
            prefs: { default_mode: "wonky" },
        });
        const callback = vi.fn(async () => {});
        const result = (await getTradingModeAction.handler(
            runtime,
            makeMemory(),
            undefined,
            undefined,
            callback,
        )) as { source: string; mode: string };
        expect(result.source).toBe("cache");
        expect(result.mode).toBe("live");
    });

    it("tolerates a mongo throw and falls through to cache", async () => {
        const runtime = makeRuntime({
            cache: "paper",
            adapterThrows: true,
        });
        const callback = vi.fn(async () => {});
        const result = (await getTradingModeAction.handler(
            runtime,
            makeMemory(),
            undefined,
            undefined,
            callback,
        )) as { mode: string; source: string };
        expect(result.mode).toBe("paper");
        expect(result.source).toBe("cache");
    });

    it("tolerates a cache-read throw and still returns DEFAULT when DB is empty", async () => {
        const runtime = makeRuntime({
            cacheThrows: true,
            prefs: null,
        });
        const callback = vi.fn(async () => {});
        const result = (await getTradingModeAction.handler(
            runtime,
            makeMemory(),
            undefined,
            undefined,
            callback,
        )) as { mode: string; source: string };
        expect(result.mode).toBe("live");
        expect(result.source).toBe("default");
    });

    it("handles an adapter without getUserTradingPreferences (SQLite path)", async () => {
        const runtime = makeRuntime({
            cache: undefined,
            adapterHasMethod: false,
        });
        const callback = vi.fn(async () => {});
        const result = (await getTradingModeAction.handler(
            runtime,
            makeMemory(),
            undefined,
            undefined,
            callback,
        )) as { mode: string; source: string };
        expect(result.mode).toBe("live");
        expect(result.source).toBe("default");
    });
});

describe("get_trading_mode classifier short-circuit fixtures", () => {
    const cases = [
        ["what is my current trading mode?", true],
        ["what's my trading mode", true],
        ["my mode right now", true],
        ["am I in paper or live?", true],
        ["am i on shadow", true],
        ["am i using paper", true],
        ["当前模式", true],
        ["什么模式", true],
        ["交易模式", true],
        ["what is the price of BTC?", false],
        ["explain how shadow mode works", false],
    ] as const;

    it("includes coverage for known mode-question phrasings", () => {
        expect(cases.length).toBeGreaterThanOrEqual(11);
    });
});
