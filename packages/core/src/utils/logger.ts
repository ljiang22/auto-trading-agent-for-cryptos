import pino, { type LogFn } from "pino";
import pretty from "pino-pretty";

import { parseBooleanFromText } from "../validation/parsing.ts";

// Define a flexible logger interface that supports method reassignment
interface FlexibleLogger {
    error: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    info: (...args: any[]) => void;
    log: (...args: any[]) => void;
    progress: (...args: any[]) => void;
    success: (...args: any[]) => void;
    debug: (...args: any[]) => void;
    trace: (...args: any[]) => void;
    fatal: (...args: any[]) => void;
    child: (bindings: any) => FlexibleLogger;
    level: string;
}


const customLevels: Record<string, number> = {
    fatal: 60,
    error: 50,
    warn: 40,
    info: 30,
    log: 29,
    progress: 28,
    success: 27,
    debug: 20,
    trace: 10,
};

const raw = parseBooleanFromText(process?.env?.LOG_JSON_FORMAT) || false;

const createStream = () => {
    if (raw) {
        return undefined;
    }
    return pretty({
        colorize: true,
        translateTime: "yyyy-mm-dd HH:MM:ss",
        ignore: "pid,hostname",
    });
};

const defaultLevel = process?.env?.DEFAULT_LOG_LEVEL || "info";

/**
 * Serialize an Error into a plain object whose properties are enumerable.
 *
 * Why this exists: `Error.name`, `Error.message`, and `Error.stack` are all
 * non-enumerable, so `Object.assign({}, err)` and `JSON.stringify(err)` both
 * silently produce `{}` and drop the useful content. Every `elizaLogger.error
 * ("prefix:", err)` call site in this codebase was hitting that — the prefix
 * showed in logs and the actual error vanished.
 *
 * Exported only for the logger's unit tests. Not intended for external use.
 */
export function errorToLoggable(err: Error): Record<string, unknown> {
    const out: Record<string, unknown> = {
        name: err.name,
        message: err.message,
    };
    if (err.stack) out.stack = err.stack;
    // Preserve any enumerable own properties (custom Error subclass fields,
    // `code` on Node system errors, etc.) without overwriting canonical ones.
    for (const key of Object.keys(err)) {
        if (!(key in out)) {
            out[key] = (err as unknown as Record<string, unknown>)[key];
        }
    }
    // ES2022 `Error.cause` is its own property but not enumerable by default.
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause !== undefined && !("cause" in out)) {
        out.cause = cause instanceof Error ? errorToLoggable(cause) : cause;
    }
    return out;
}

/**
 * Recursively replace any Error instances with their serializable form so
 * downstream JSON.stringify / Object.assign behaves correctly.
 *
 * Exported only for the logger's unit tests.
 */
export function normalizeForLogging(value: unknown): unknown {
    if (value instanceof Error) return errorToLoggable(value);
    if (Array.isArray(value)) return value.map(normalizeForLogging);
    return value;
}

/**
 * The pino `logMethod` hook that fixes Error serialization across all call
 * shapes. Extracted as a named function (rather than an inline closure) so
 * unit tests can drive it directly without spinning up a real pino instance
 * and intercepting stdout — that was unreliable under Vitest.
 *
 * Exported only for tests.
 */
export function logMethodHook(
    inputArgs: [obj: unknown, msg?: string, ...args: unknown[]],
    method: LogFn,
    thisArg: unknown = null
): void {
    const [arg1, ...rest] = inputArgs;

    // Case 1: first arg is an Error — pino's `err` convention.
    if (arg1 instanceof Error) {
        const err = errorToLoggable(arg1);
        const messageParts = rest.map((arg) =>
            typeof arg === "string"
                ? arg
                : JSON.stringify(normalizeForLogging(arg))
        );
        const message =
            messageParts.length > 0
                ? messageParts.join(" ")
                : arg1.message;
        method.apply(thisArg, [{ err }, message]);
        return;
    }

    // Case 2: first arg is an object (plain or array) — pino's standard
    // merge-context convention. Normalize any Error values nested inside it.
    if (typeof arg1 === "object" && arg1 !== null) {
        const normalizedFirstArg: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(
            arg1 as Record<string, unknown>
        )) {
            normalizedFirstArg[k] = normalizeForLogging(v);
        }
        const messageParts = rest.map((arg) =>
            typeof arg === "string"
                ? arg
                : JSON.stringify(normalizeForLogging(arg))
        );
        method.apply(thisArg, [normalizedFirstArg, messageParts.join(" ")]);
        return;
    }

    // Case 3: first arg is a primitive (string/number/etc).
    const context: Record<string, unknown> = {};
    const messageStrings: string[] = [];
    for (const part of [arg1, ...rest]) {
        if (typeof part === "string") {
            messageStrings.push(part);
            continue;
        }
        if (part instanceof Error) {
            messageStrings.push(`${part.name}: ${part.message}`);
            const errObj = errorToLoggable(part);
            if (!("err" in context)) {
                context.err = errObj;
            } else {
                let i = 1;
                while (`err${i}` in context) i += 1;
                context[`err${i}`] = errObj;
            }
            continue;
        }
        if (typeof part === "object" && part !== null) {
            Object.assign(context, part);
            continue;
        }
        // null/undefined are dropped; numbers/booleans coerce to string so
        // they actually reach the log line instead of being filtered out.
        if (part !== null && part !== undefined) {
            messageStrings.push(String(part));
        }
    }
    method.apply(thisArg, [context, messageStrings.join(" ")]);
}

const options = {
    level: defaultLevel,
    customLevels,
    hooks: {
        logMethod(
            this: unknown,
            inputArgs: [obj: unknown, msg?: string, ...args: unknown[]],
            method: LogFn
        ): void {
            logMethodHook(inputArgs, method, this);
        },
    },
};

export const elizaLogger = pino(options, createStream()) as unknown as FlexibleLogger;

export default elizaLogger;
