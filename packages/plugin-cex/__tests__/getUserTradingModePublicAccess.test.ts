import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { getUserTradingMode } from "../src/actions/shared";

const USER = "00000000-0000-0000-0000-000000000abc";

// Runtime shaped like the public-demo (SQLite) deployment: no
// getUserTradingPreferences method, no email-bearing account, and an empty
// cache — so resolution falls through to the default.
function makeRuntime(cacheValue?: unknown) {
    return {
        databaseAdapter: {
            getAccountById: async () => null,
        },
        cacheManager: {
            get: async () => cacheValue,
            set: async () => {},
        },
    } as never;
}

describe("getUserTradingMode public-access default", () => {
    afterEach(() => {
        delete process.env.PUBLIC_ACCESS_MODE;
    });

    it("defaults to live when nothing resolves and not in public mode", async () => {
        delete process.env.PUBLIC_ACCESS_MODE;
        expect(await getUserTradingMode(makeRuntime(), USER)).toBe("live");
    });

    it("defaults to paper when in public-access mode and nothing resolves", async () => {
        process.env.PUBLIC_ACCESS_MODE = "1";
        expect(await getUserTradingMode(makeRuntime(), USER)).toBe("paper");
    });

    it("still honors an explicit cached preference over the public default", async () => {
        process.env.PUBLIC_ACCESS_MODE = "1";
        // A real cached mode (e.g. a deliberate switch) wins; only the
        // fallback default changed.
        expect(await getUserTradingMode(makeRuntime("shadow"), USER)).toBe(
            "shadow",
        );
    });
});
