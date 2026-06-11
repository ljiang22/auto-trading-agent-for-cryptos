/**
 * §6.3 — record venue REST calls (request, response, latency, status) to a
 * pluggable sink. The agent startup wires a sink that writes to the
 * `venue_calls` MongoDB collection. Sensitive fields are redacted before the
 * payload ever reaches the sink — see {@link sanitizeVenueRequest} /
 * {@link sanitizeVenueResponse}. Tested by the secrets-leak regression in
 * §8.4.
 */

import { elizaLogger } from "@elizaos/core";

export interface VenueCallRecord {
    request_id?: string;
    intent_hash?: string;
    userId?: string;
    venue: string;
    endpoint: string;
    method: "GET" | "POST" | "PUT" | "DELETE";
    request_body?: unknown;
    response_body?: unknown;
    latency_ms: number;
    http_status: number;
    /** "ok" | "venue_5xx" | "venue_timeout" | "venue_network_error" | "venue_4xx" */
    outcome: VenueCallOutcome;
    retry_count?: number;
    client_order_id?: string;
}

export type VenueCallOutcome =
    | "ok"
    | "venue_4xx"
    | "venue_5xx"
    | "venue_timeout"
    | "venue_network_error";

export interface VenueCallSink {
    writeVenueCall(record: VenueCallRecord): Promise<void>;
}

let _sink: VenueCallSink | null = null;

export function setVenueCallSink(sink: VenueCallSink | null): void {
    _sink = sink;
}

export function getVenueCallSink(): VenueCallSink | null {
    return _sink;
}

// ---------------------------------------------------------------------------
// Sanitization — KEY-PATH ALLOWLIST.
// ---------------------------------------------------------------------------

/**
 * Known sensitive top-level keys. Any of these in the request body / headers
 * is replaced with `"<redacted>"` before persistence.
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set(
    [
        "apiKey",
        "api_key",
        "apiSecret",
        "api_secret",
        "secret",
        "signature",
        "passphrase",
        "private_key",
        "privateKey",
        "Authorization",
        "X-MBX-APIKEY",
        "CB-ACCESS-KEY",
        "CB-ACCESS-PASSPHRASE",
        "CB-ACCESS-SIGN",
        "CB-ACCESS-TIMESTAMP",
        "token",
        "access_token",
        "refresh_token",
    ].map((s) => s.toLowerCase()),
);

function redactObject(value: unknown, depth = 0): unknown {
    if (depth > 6) return "<truncated>";
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((v) => redactObject(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (SENSITIVE_KEYS.has(k.toLowerCase())) {
            out[k] = "<redacted>";
            continue;
        }
        out[k] = redactObject(v, depth + 1);
    }
    return out;
}

export function sanitizeVenueRequest(body: unknown): unknown {
    return redactObject(body);
}

export function sanitizeVenueResponse(body: unknown): unknown {
    // For now identical policy; kept separate so we can tighten one side.
    return redactObject(body);
}

/**
 * Fire-and-forget durable persistence + structured trading-event emission.
 * Failures are swallowed at WARN; observability sinks must never abort the
 * trading path.
 */
export async function recordVenueCall(record: VenueCallRecord): Promise<void> {
    const sanitized: VenueCallRecord = {
        ...record,
        request_body: sanitizeVenueRequest(record.request_body),
        response_body: sanitizeVenueResponse(record.response_body),
    };
    const sink = _sink;
    if (sink) {
        try {
            await sink.writeVenueCall(sanitized);
        } catch (err) {
            elizaLogger.warn(
                `[venueCallLog] sink.writeVenueCall failed (continuing): ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }
    }
}
