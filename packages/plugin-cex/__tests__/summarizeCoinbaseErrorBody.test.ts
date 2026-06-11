import { describe, expect, it } from "vitest";
import { summarizeCoinbaseErrorBody } from "../src/exchanges/summarizeCoinbaseErrorBody";

describe("summarizeCoinbaseErrorBody", () => {
    it("joins string fields from known keys", () => {
        expect(
            summarizeCoinbaseErrorBody({
                message: "bad request",
                error: "INVALID",
            })
        ).toBe("bad request — INVALID");
    });

    it("includes nested error_response", () => {
        expect(
            summarizeCoinbaseErrorBody({
                error_response: { message: "inner", error: "E" },
            })
        ).toBe("inner — E");
    });

    it("stringifies object message and error", () => {
        expect(
            summarizeCoinbaseErrorBody({
                message: { detail: "x" },
                error: { code: "y" },
            })
        ).toBe('{"detail":"x"} — {"code":"y"}');
    });

    it("includes numeric error", () => {
        expect(summarizeCoinbaseErrorBody({ error: 401 })).toBe("401");
    });

    it("falls back to capped JSON for unknown shapes", () => {
        expect(summarizeCoinbaseErrorBody({ reason: "unknown", code: 9 })).toBe('{"reason":"unknown","code":9}');
    });

    it("returns empty for null and empty object fallback", () => {
        expect(summarizeCoinbaseErrorBody(null)).toBe("");
        expect(summarizeCoinbaseErrorBody({})).toBe("{}");
    });

    it("handles root string and array", () => {
        expect(summarizeCoinbaseErrorBody("  plain  ")).toBe("plain");
        expect(summarizeCoinbaseErrorBody([{ message: "a" }, { error: "b" }])).toBe("a — b");
    });

    it("flattens preview_failure_reason objects", () => {
        expect(
            summarizeCoinbaseErrorBody({
                preview_failure_reason: { message: "not enough funds" },
            })
        ).toBe("not enough funds");
    });
});
