/**
 * §8.6 — Abortable wrapper for ADK LLM calls.
 *
 * The current ADK classifier is rules-only (synchronous, no LLM). When an
 * async LLM extraction path is added, route it through `withAdkTimeout` so
 * a stalled provider can't hang the trading approval flow indefinitely.
 *
 * Default timeout is `ADK_LLM_TIMEOUT_MS` (25_000). On timeout the wrapper
 * aborts the underlying call, emits `emitTimeout`, and returns the caller's
 * fallback value (typically a localized clarification).
 */

import { emitTimeout } from "../observability/tradingEvents";

export interface AdkTimeoutOptions<T> {
    /** Site name used in the timeout event for CloudWatch alarms. */
    site: string;
    /** Caller-provided async work. Receives an AbortSignal it must honor. */
    work: (signal: AbortSignal) => Promise<T>;
    /** Value to return when the watchdog fires. */
    fallback: T;
    /** Override default timeout (ms). */
    timeoutMs?: number;
    /** Optional request_id / userId for observability. */
    request_id?: string;
    userId?: string;
}

const DEFAULT_TIMEOUT_MS = Number(process.env.ADK_LLM_TIMEOUT_MS ?? 25_000);

export async function withAdkTimeout<T>(opts: AdkTimeoutOptions<T>): Promise<T> {
    const ctrl = new AbortController();
    const cap = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => ctrl.abort(), cap);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref?: () => void }).unref!();
    }
    try {
        return await opts.work(ctrl.signal);
    } catch (err) {
        if (ctrl.signal.aborted) {
            emitTimeout({
                request_id: opts.request_id,
                userId: opts.userId,
                site: opts.site,
                timeout_ms: cap,
            });
            return opts.fallback;
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}
