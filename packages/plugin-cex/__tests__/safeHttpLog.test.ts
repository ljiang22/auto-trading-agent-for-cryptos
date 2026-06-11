import { describe, expect, it } from "vitest";
import { sanitizeForLog, summarizeResponseForLog } from "../src/exchanges/safeHttpLog";

describe("sanitizeForLog", () => {
    it("redacts signature and nested secrets", () => {
        const input = {
            symbol: "BTCUSDT",
            signature: "abc123",
            nested: { apiSecret: "shh", ok: 1 },
        };
        const out = sanitizeForLog(input) as Record<string, unknown>;
        expect(out.symbol).toBe("BTCUSDT");
        expect(out.signature).toBe("[REDACTED]");
        expect((out.nested as Record<string, unknown>).apiSecret).toBe("[REDACTED]");
        expect((out.nested as Record<string, unknown>).ok).toBe(1);
    });

    it("does not redact apiKeyName", () => {
        const out = sanitizeForLog({ apiKeyName: "public-id" }) as Record<string, unknown>;
        expect(out.apiKeyName).toBe("public-id");
    });

    it("redacts apiKey and api_key but not apiKeyName", () => {
        const out = sanitizeForLog({
            apiKey: "secret-value",
            api_key: "also-secret",
            apiKeyName: "public",
        }) as Record<string, unknown>;
        expect(out.apiKey).toBe("[REDACTED]");
        expect(out.api_key).toBe("[REDACTED]");
        expect(out.apiKeyName).toBe("public");
    });

    it("redacts accessToken and refresh_token", () => {
        expect((sanitizeForLog({ accessToken: "x" }) as Record<string, unknown>).accessToken).toBe("[REDACTED]");
        expect((sanitizeForLog({ refresh_token: "y" }) as Record<string, unknown>).refresh_token).toBe(
            "[REDACTED]"
        );
    });

    it("redacts bearer, credentials, and jwt-like key names", () => {
        const out = sanitizeForLog({
            bearerToken: "t",
            credentials: { x: 1 },
            sessionJwt: "j",
        }) as Record<string, unknown>;
        expect(out.bearerToken).toBe("[REDACTED]");
        expect(out.credentials).toBe("[REDACTED]");
        expect(out.sessionJwt).toBe("[REDACTED]");
    });

    it("respects maxDepth", () => {
        const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
        const out = sanitizeForLog(deep, { maxDepth: 2 }) as Record<string, unknown>;
        expect(out.a).toEqual({ b: { c: "[TRUNCATED_DEPTH]" } });
    });

    it("stringifies bigint values", () => {
        const out = sanitizeForLog({ t: 1n }) as Record<string, unknown>;
        expect(out.t).toBe("1");
    });
});

describe("summarizeResponseForLog", () => {
    it("summarizes arrays as length only", () => {
        expect(summarizeResponseForLog([{ a: 1 }, { b: 2 }])).toEqual({ kind: "array", length: 2 });
    });

    it("summarizes objects as keys without values", () => {
        const s = summarizeResponseForLog({ accounts: [], secret: "x" });
        expect(s).toMatchObject({ kind: "object", totalKeys: 2 });
        if (s.kind === "object") {
            expect(s.keys).toContain("accounts");
            expect(s.keys).toContain("secret");
        }
    });

    it("summarizes strings as length only (no value preview)", () => {
        expect(summarizeResponseForLog("ok")).toEqual({ kind: "string", length: 2 });
        const long = "x".repeat(100);
        expect(summarizeResponseForLog(long)).toEqual({ kind: "string", length: 100 });
    });

    it("handles null and primitives", () => {
        expect(summarizeResponseForLog(null)).toEqual({ kind: "null" });
        expect(summarizeResponseForLog(undefined)).toEqual({ kind: "undefined" });
        expect(summarizeResponseForLog(42)).toEqual({ kind: "number" });
        expect(summarizeResponseForLog(true)).toEqual({ kind: "boolean" });
        expect(summarizeResponseForLog(1n)).toEqual({ kind: "bigint" });
    });

    it("caps listed keys on large objects", () => {
        const keys = Array.from({ length: 30 }, (_, i) => `k${i}`);
        const obj = Object.fromEntries(keys.map((k) => [k, 1]));
        const s = summarizeResponseForLog(obj);
        expect(s.kind).toBe("object");
        if (s.kind === "object") {
            expect(s.totalKeys).toBe(30);
            expect(s.keys.length).toBeLessThanOrEqual(24);
        }
    });
});
