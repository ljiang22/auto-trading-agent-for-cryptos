/**
 * §6.3 + §8.5 — venue REST call dispatcher.
 *
 * Two responsibilities:
 *  1. Retry policy. Retries ONLY:
 *      - 429 rate-limit (honoring `Retry-After` if present).
 *      - Pre-flight DNS / connect errors (the request never reached the venue).
 *     Does NOT retry:
 *      - 5xx after the request was sent. Those upgrade the ledger row to
 *        `unknown` so the pre-submit dedup gate refuses retries until
 *        reconciliation resolves the state.
 *      - Timeouts after the request was sent (same reasoning).
 *  2. Audit. Every attempt (success or failure) emits a `venue_call` trading
 *     event AND writes a sanitized row to the `venue_calls` collection via
 *     `recordVenueCall`. The pre-submit dedup gate joins on `client_order_id`
 *     for the §6.7 replay timeline.
 *
 * Capped at 4 attempts total. Exponential backoff with full jitter.
 */

import {
    emitVenueCall,
    emitUnknownState,
} from "../../observability/tradingEvents";
import {
    recordVenueCall,
    type VenueCallOutcome,
} from "../../observability/venueCallLog";
import { getVenueCallContext } from "../../observability/venueCallContext";
import type { ExchangeName } from "../../types";

export interface RetryableCall<T> {
    venue: ExchangeName | "paper";
    endpoint: string;
    method: "GET" | "POST" | "PUT" | "DELETE";
    /** request_id for trading-event correlation. */
    request_id?: string;
    /** userId for trading-event correlation. */
    userId?: string;
    /** intent_hash for joining venue_calls to risk_decisions. */
    intent_hash?: string;
    /** client_order_id for join into pending_orders_ledger. */
    client_order_id?: string;
    /** Sanitized request body — recorded into venue_calls. */
    request_body?: unknown;
    /** Whether the request is a write that should mark UNKNOWN on post-send failure. */
    is_write?: boolean;
    /** Optional venue/symbol pair for emitUnknownState. */
    symbol?: string;
    /** The actual call. Throws on error. */
    invoke: () => Promise<{ http_status: number; body: unknown; latency_ms: number }>;
}

const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5_000;

function jitter(ms: number): number {
    return Math.floor(Math.random() * ms);
}

export interface RetryError {
    isRetryable: boolean;
    /** Optional Retry-After header value in seconds. */
    retryAfterSeconds?: number;
    /** Whether this looks like a pre-flight (request never sent). */
    preFlight: boolean;
    httpStatus?: number;
    /** Outcome category for venue_calls / ledger UNKNOWN promotion. */
    outcome: VenueCallOutcome;
}

export function classifyRetryError(err: unknown): RetryError {
    if (!err || typeof err !== "object") {
        return { isRetryable: false, preFlight: false, outcome: "venue_network_error" };
    }
    const e = err as {
        response?: { status?: number; headers?: Record<string, string | string[]> };
        code?: string;
    };
    const status = e.response?.status;
    if (status === 429) {
        const headers = e.response?.headers ?? {};
        const retryAfterRaw =
            (headers as Record<string, string | string[]>)["retry-after"] ??
            (headers as Record<string, string | string[]>)["Retry-After"];
        const seconds = Array.isArray(retryAfterRaw) ? retryAfterRaw[0] : retryAfterRaw;
        const parsed = seconds ? Number(seconds) : Number.NaN;
        return {
            isRetryable: true,
            retryAfterSeconds: Number.isFinite(parsed) ? parsed : undefined,
            preFlight: false,
            httpStatus: 429,
            outcome: "venue_4xx",
        };
    }
    if (e.code === "ENOTFOUND" || e.code === "EAI_AGAIN") {
        return { isRetryable: true, preFlight: true, outcome: "venue_network_error" };
    }
    if (e.code === "ECONNREFUSED") {
        return { isRetryable: true, preFlight: true, outcome: "venue_network_error" };
    }
    if (e.code === "ETIMEDOUT" || e.code === "ECONNRESET") {
        return { isRetryable: false, preFlight: false, outcome: "venue_timeout" };
    }
    if (typeof status === "number") {
        if (status >= 500) {
            return { isRetryable: false, preFlight: false, httpStatus: status, outcome: "venue_5xx" };
        }
        if (status >= 400) {
            return { isRetryable: false, preFlight: false, httpStatus: status, outcome: "venue_4xx" };
        }
    }
    return { isRetryable: false, preFlight: false, outcome: "venue_network_error" };
}

function classifyOk(httpStatus: number): VenueCallOutcome {
    if (httpStatus >= 500) return "venue_5xx";
    if (httpStatus >= 400) return "venue_4xx";
    return "ok";
}

/**
 * Execute `call.invoke()` with retries. Emits `emitVenueCall` for every
 * attempt (success or failed retry) so CloudWatch sees the retry_count
 * dimension, AND writes a row to `venue_calls` for the replay timeline.
 *
 * Post-send failures on a write (5xx, timeout after send, network error
 * after send) ALSO emit `emitUnknownState` so the workflow handler can
 * promote the ledger row to `unknown` and the pre-submit dedup gate can
 * refuse the next attempt.
 */
export async function callVenueWithRetry<T>(
    call: RetryableCall<T>,
): Promise<{ http_status: number; body: unknown; latency_ms: number; retry_count: number }> {
    const ctx = getVenueCallContext();
    const request_id = call.request_id ?? ctx?.request_id;
    const userId = call.userId ?? ctx?.userId;
    const intent_hash = call.intent_hash ?? ctx?.intent_hash;
    const client_order_id = call.client_order_id ?? ctx?.client_order_id;

    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
            const out = await call.invoke();
            const outcome = classifyOk(out.http_status);
            emitVenueCall({
                request_id,
                userId,
                venue: call.venue as ExchangeName,
                endpoint: call.endpoint,
                method: call.method,
                latency_ms: out.latency_ms,
                http_status: out.http_status,
                retry_count: attempt,
                client_order_id,
            });
            // Fire-and-forget durable audit. Failures inside the sink are
            // swallowed at WARN inside recordVenueCall — they must never
            // abort the trading path.
            void recordVenueCall({
                request_id,
                intent_hash,
                userId,
                venue: call.venue,
                endpoint: call.endpoint,
                method: call.method,
                request_body: call.request_body,
                response_body: out.body,
                latency_ms: out.latency_ms,
                http_status: out.http_status,
                outcome,
                retry_count: attempt,
                client_order_id,
            });
            return { ...out, retry_count: attempt };
        } catch (err) {
            lastErr = err;
            const cls = classifyRetryError(err);
            const status = cls.httpStatus ?? -1;
            emitVenueCall({
                request_id,
                userId,
                venue: call.venue as ExchangeName,
                endpoint: call.endpoint,
                method: call.method,
                latency_ms: 0,
                http_status: status,
                retry_count: attempt,
                client_order_id,
            });
            void recordVenueCall({
                request_id,
                intent_hash,
                userId,
                venue: call.venue,
                endpoint: call.endpoint,
                method: call.method,
                request_body: call.request_body,
                response_body: extractBody(err),
                latency_ms: 0,
                http_status: status,
                outcome: cls.outcome,
                retry_count: attempt,
                client_order_id,
            });
            const isLastAttempt = attempt === MAX_ATTEMPTS - 1;
            if (!cls.isRetryable || isLastAttempt) {
                // Promote ledger row to UNKNOWN on post-send write failures.
                if (
                    call.is_write &&
                    !cls.preFlight &&
                    (cls.outcome === "venue_5xx" ||
                        cls.outcome === "venue_timeout" ||
                        cls.outcome === "venue_network_error")
                ) {
                    if (client_order_id) {
                        emitUnknownState({
                            request_id,
                            intent_hash,
                            userId,
                            venue:
                                call.venue === "paper"
                                    ? undefined
                                    : (call.venue as ExchangeName),
                            symbol: call.symbol,
                            client_order_id,
                            cause: cls.outcome as
                                | "venue_5xx"
                                | "venue_timeout"
                                | "venue_network_error",
                            http_status: cls.httpStatus,
                        });
                    }
                }
                throw err;
            }
            const backoff = cls.retryAfterSeconds
                ? cls.retryAfterSeconds * 1000
                : Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
            await new Promise((r) => setTimeout(r, jitter(backoff) + 50));
        }
    }
    throw lastErr;
}

function extractBody(err: unknown): unknown {
    if (!err || typeof err !== "object") return undefined;
    const e = err as { response?: { data?: unknown }; message?: string };
    if (e.response?.data !== undefined) return e.response.data;
    return e.message;
}
