import { describe, expect, it } from "vitest";
import { resolveAnonymousHistoryTtlMs } from "../src/historyCleanup.ts";

const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;

describe("resolveAnonymousHistoryTtlMs", () => {
    it("defaults to 24h when nothing is set", () => {
        expect(resolveAnonymousHistoryTtlMs({})).toBe(ONE_DAY_IN_MS);
    });

    it("disables cleanup (Infinity) in public-access mode", () => {
        expect(resolveAnonymousHistoryTtlMs({ PUBLIC_ACCESS_MODE: "1" })).toBe(
            Number.POSITIVE_INFINITY,
        );
    });

    it("honors an explicit positive TTL override", () => {
        const thirtyDays = String(30 * 24 * 60 * 60 * 1000);
        expect(
            resolveAnonymousHistoryTtlMs({ ANONYMOUS_HISTORY_TTL_MS: thirtyDays }),
        ).toBe(30 * 24 * 60 * 60 * 1000);
    });

    it("treats off/never/0 as disabled", () => {
        for (const v of ["0", "off", "never", "infinity", "disabled"]) {
            expect(
                resolveAnonymousHistoryTtlMs({ ANONYMOUS_HISTORY_TTL_MS: v }),
            ).toBe(Number.POSITIVE_INFINITY);
        }
    });

    it("explicit override wins over public-access default", () => {
        expect(
            resolveAnonymousHistoryTtlMs({
                PUBLIC_ACCESS_MODE: "1",
                ANONYMOUS_HISTORY_TTL_MS: "3600000",
            }),
        ).toBe(3600000);
    });

    it("falls through to the public/default rules on a malformed value", () => {
        expect(
            resolveAnonymousHistoryTtlMs({ ANONYMOUS_HISTORY_TTL_MS: "abc" }),
        ).toBe(ONE_DAY_IN_MS);
        expect(
            resolveAnonymousHistoryTtlMs({
                ANONYMOUS_HISTORY_TTL_MS: "-5",
                PUBLIC_ACCESS_MODE: "1",
            }),
        ).toBe(Number.POSITIVE_INFINITY);
    });
});
