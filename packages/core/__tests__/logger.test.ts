import { describe, it, expect, beforeEach } from "vitest";
import {
    errorToLoggable,
    logMethodHook,
    normalizeForLogging,
} from "../src/utils/logger.ts";

// Captures whatever the hook would have handed to pino's underlying log
// method. We assert on (mergeObject, msg) — the two-arg form pino uses
// after the hook normalizes inputs.
type Captured = { merge: Record<string, unknown>; msg: string };

function makeCapture(): {
    captured: Captured[];
    fakeMethod: (...args: unknown[]) => void;
} {
    const captured: Captured[] = [];
    const fakeMethod = (...args: unknown[]) => {
        captured.push({
            merge: args[0] as Record<string, unknown>,
            msg: args[1] as string,
        });
    };
    return { captured, fakeMethod };
}

describe("errorToLoggable", () => {
    it("captures name, message, and stack from a basic Error", () => {
        const err = new Error("boom");
        const out = errorToLoggable(err);
        expect(out.name).toBe("Error");
        expect(out.message).toBe("boom");
        expect(typeof out.stack).toBe("string");
        expect((out.stack as string).length).toBeGreaterThan(0);
    });

    it("preserves enumerable own properties from custom Error subclasses", () => {
        class HttpError extends Error {
            constructor(public statusCode: number, msg: string) {
                super(msg);
                this.name = "HttpError";
            }
        }
        const out = errorToLoggable(new HttpError(503, "down"));
        expect(out).toMatchObject({
            name: "HttpError",
            message: "down",
            statusCode: 503,
        });
    });

    it("recursively serializes Error.cause", () => {
        const inner = new Error("root");
        const outer = new Error("wrap", { cause: inner });
        const out = errorToLoggable(outer);
        expect(out.message).toBe("wrap");
        expect(out.cause).toMatchObject({ name: "Error", message: "root" });
    });

    it("preserves non-Error causes as-is", () => {
        const outer = new Error("wrap", { cause: { code: "ECONNREFUSED" } });
        const out = errorToLoggable(outer);
        expect(out.cause).toEqual({ code: "ECONNREFUSED" });
    });
});

describe("normalizeForLogging", () => {
    it("returns Errors as their loggable form", () => {
        const out = normalizeForLogging(new Error("x")) as Record<string, unknown>;
        expect(out.name).toBe("Error");
        expect(out.message).toBe("x");
    });

    it("recurses through arrays", () => {
        const out = normalizeForLogging([
            "leave-alone",
            new Error("nested"),
        ]) as unknown[];
        expect(out[0]).toBe("leave-alone");
        expect(out[1]).toMatchObject({ name: "Error", message: "nested" });
    });

    it("passes primitives through unchanged", () => {
        expect(normalizeForLogging("s")).toBe("s");
        expect(normalizeForLogging(42)).toBe(42);
        expect(normalizeForLogging(null)).toBe(null);
    });
});

describe("logMethodHook — the real call sites this had to fix", () => {
    let captured: Captured[];
    let fakeMethod: (...args: unknown[]) => void;

    beforeEach(() => {
        ({ captured, fakeMethod } = makeCapture());
    });

    it("(prefix, err) — the pattern that silently dropped every error", () => {
        // Pre-fix: this call would produce { merge: {}, msg: "Referral code generation error:" }
        // and the Error contents would be gone. That's the bug we're closing.
        const err = new Error("boom");
        logMethodHook(
            ["Referral code generation error:", err] as unknown as [
                unknown,
                string,
                ...unknown[]
            ],
            fakeMethod
        );
        expect(captured).toHaveLength(1);
        const { merge, msg } = captured[0];
        expect(msg).toContain("Referral code generation error:");
        expect(msg).toContain("Error: boom");
        expect(merge.err).toMatchObject({ name: "Error", message: "boom" });
        expect(typeof (merge.err as Record<string, unknown>).stack).toBe(
            "string"
        );
    });

    it("(err) — pino's err-first convention", () => {
        const err = new Error("primary");
        logMethodHook([err] as unknown as [unknown, string, ...unknown[]], fakeMethod);
        const { merge, msg } = captured[0];
        expect(merge.err).toMatchObject({ name: "Error", message: "primary" });
        expect(msg).toBe("primary");
    });

    it("({ err, userId }, 'msg') — explicit pino merge-context with Error inside", () => {
        const err = new Error("nested");
        logMethodHook(
            [{ err, userId: "abc" }, "task failed"] as unknown as [
                unknown,
                string,
                ...unknown[]
            ],
            fakeMethod
        );
        const { merge, msg } = captured[0];
        expect(merge.err).toMatchObject({ name: "Error", message: "nested" });
        expect(merge.userId).toBe("abc");
        expect(msg).toBe("task failed");
    });

    it("(prefix, err1, err2) — multiple errors are NOT overwritten", () => {
        const a = new Error("first");
        const b = new Error("second");
        logMethodHook(
            ["two failures:", a, b] as unknown as [unknown, string, ...unknown[]],
            fakeMethod
        );
        const { merge, msg } = captured[0];
        expect(merge.err).toMatchObject({ message: "first" });
        expect(merge.err1).toMatchObject({ message: "second" });
        expect(msg).toContain("Error: first");
        expect(msg).toContain("Error: second");
    });

    it("captures Error.cause through the hook", () => {
        const inner = new Error("inner");
        const outer = new Error("outer", { cause: inner });
        logMethodHook(
            ["wrapper:", outer] as unknown as [unknown, string, ...unknown[]],
            fakeMethod
        );
        const errObj = captured[0].merge.err as Record<string, unknown>;
        expect(errObj.message).toBe("outer");
        expect(errObj.cause).toMatchObject({
            name: "Error",
            message: "inner",
        });
    });

    it("preserves plain-object merge-context behavior (regression for non-Error callers)", () => {
        logMethodHook(
            ["Loading settings:", { foo: 1, bar: "x" }] as unknown as [
                unknown,
                string,
                ...unknown[]
            ],
            fakeMethod
        );
        const { merge, msg } = captured[0];
        expect(merge.foo).toBe(1);
        expect(merge.bar).toBe("x");
        expect(msg).toBe("Loading settings:");
    });

    it("joins multiple string args into the message (regression)", () => {
        logMethodHook(
            ["Heads up:", "something happened"] as unknown as [
                unknown,
                string,
                ...unknown[]
            ],
            fakeMethod
        );
        expect(captured[0].msg).toBe("Heads up: something happened");
    });

    it("coerces number/boolean args into the message (previously silently dropped)", () => {
        logMethodHook(
            ["Counts:", 42, true] as unknown as [unknown, string, ...unknown[]],
            fakeMethod
        );
        expect(captured[0].msg).toBe("Counts: 42 true");
    });

    it("({ jobId, failure: err }, 'msg') — Errors nested in merge-context are serialized", () => {
        const err = new Error("deep");
        logMethodHook(
            [{ jobId: "j-7", failure: err }, "job crashed"] as unknown as [
                unknown,
                string,
                ...unknown[]
            ],
            fakeMethod
        );
        const { merge, msg } = captured[0];
        expect(merge.jobId).toBe("j-7");
        expect(merge.failure).toMatchObject({
            name: "Error",
            message: "deep",
        });
        expect(msg).toBe("job crashed");
    });

    it("(plainObject, 'msg', err) — Error in rest after object-as-first-arg gets JSON-stringified with content", () => {
        const err = new Error("rest-error");
        logMethodHook(
            [{ requestId: "r-1" }, "failed", err] as unknown as [
                unknown,
                string,
                ...unknown[]
            ],
            fakeMethod
        );
        const { merge, msg } = captured[0];
        expect(merge.requestId).toBe("r-1");
        // The Error in rest is JSON-stringified into the message — at minimum
        // the message text survives, which is what prod logs need.
        expect(msg).toContain("failed");
        expect(msg).toContain("rest-error");
    });

    it("drops null/undefined from message but doesn't crash", () => {
        logMethodHook(
            ["prefix:", null, undefined, "suffix"] as unknown as [
                unknown,
                string,
                ...unknown[]
            ],
            fakeMethod
        );
        expect(captured[0].msg).toBe("prefix: suffix");
    });

    it("handles an empty arg list gracefully", () => {
        logMethodHook(
            ["only message"] as unknown as [unknown, string, ...unknown[]],
            fakeMethod
        );
        expect(captured[0].msg).toBe("only message");
        expect(captured[0].merge).toEqual({});
    });
});
