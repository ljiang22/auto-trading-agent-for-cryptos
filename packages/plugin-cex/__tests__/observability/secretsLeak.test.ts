import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    recordVenueCall,
    sanitizeVenueRequest,
    setVenueCallSink,
    type VenueCallRecord,
} from "../../src/observability/venueCallLog";
import { onTradingEvent } from "../../src/observability/tradingEvents";
import { callVenueWithRetry } from "../../src/exchanges/services/retry";

/**
 * §8.4 — Secrets-in-payload regression scan. Asserts the sanitizer
 * strips every known secret-shaped key under realistic payload shapes
 * AND every authenticated endpoint × every `[Trading]` emitter is
 * sanitized end-to-end (no field on a `venue_calls` row or
 * `[Trading] venue_call` log line leaks a known secret).
 */

const KNOWN_SECRETS = [
    "AKIAIOSFODNN7EXAMPLE",
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "0123456789abcdef0123456789abcdef",
    "sk-proj-EXAMPLE0987",
];

describe("§8.4 secrets-in-payload regression scan", () => {
    it("strips every secret in known field names (top-level)", () => {
        const payload = {
            apiKey: KNOWN_SECRETS[0],
            api_secret: KNOWN_SECRETS[1],
            signature: KNOWN_SECRETS[2],
            access_token: KNOWN_SECRETS[3],
            order: { quantity: "0.01", symbol: "BTCUSDT" },
        };
        const out = JSON.stringify(sanitizeVenueRequest(payload));
        for (const s of KNOWN_SECRETS) {
            expect(out, `secret ${s.slice(0, 8)}… leaked`).not.toContain(s);
        }
        expect(out).toContain("BTCUSDT");
        expect(out).toContain("0.01");
    });

    it("strips secrets in nested objects + arrays", () => {
        const payload = {
            credentials: { apiKey: KNOWN_SECRETS[0] },
            history: [{ token: KNOWN_SECRETS[3] }, { token: "another" }],
            deep: { a: { b: { c: { apiSecret: KNOWN_SECRETS[1] } } } },
        };
        const out = JSON.stringify(sanitizeVenueRequest(payload));
        for (const s of KNOWN_SECRETS) {
            expect(out).not.toContain(s);
        }
        expect(out).toContain("<redacted>");
    });

    it("handles case-insensitive header names (X-MBX-APIKEY etc.)", () => {
        const headers = {
            "X-MBX-APIKEY": KNOWN_SECRETS[0],
            "CB-ACCESS-KEY": KNOWN_SECRETS[2],
            "Content-Type": "application/json",
        };
        const out = JSON.stringify(sanitizeVenueRequest({ headers }));
        for (const s of KNOWN_SECRETS) {
            expect(out).not.toContain(s);
        }
        expect(out).toContain("application/json");
    });

    it("never throws on adversarial inputs", () => {
        expect(() => sanitizeVenueRequest(undefined)).not.toThrow();
        expect(() => sanitizeVenueRequest(null)).not.toThrow();
        expect(() =>
            sanitizeVenueRequest("plain string with apiKey=ABC"),
        ).not.toThrow();
        expect(() => sanitizeVenueRequest(42)).not.toThrow();
        // Cyclic objects are not supported, but the helper still returns
        // safely (depth cap fires).
        const cyclic: Record<string, unknown> = { token: KNOWN_SECRETS[0] };
        cyclic.self = cyclic;
        expect(() => sanitizeVenueRequest(cyclic)).not.toThrow();
    });
});

/**
 * End-to-end scan: every authenticated endpoint × every `[Trading]`
 * venue_call emitter must never leak a known secret. We exercise the
 * common Binance + Coinbase shapes through `callVenueWithRetry` (the
 * single chokepoint) and assert:
 *   1. The persisted `venue_calls` row strips every secret.
 *   2. The emitted `[Trading]` event payload strips every secret.
 */
describe("§8.4 end-to-end secrets scan across authenticated endpoints", () => {
    let sinkRows: VenueCallRecord[];
    let events: Array<Record<string, unknown>>;
    let unsubscribe: () => void;

    beforeEach(() => {
        sinkRows = [];
        events = [];
        setVenueCallSink({
            async writeVenueCall(row) {
                sinkRows.push(row);
            },
        });
        unsubscribe = onTradingEvent((e) => events.push(e));
    });

    afterEach(() => {
        setVenueCallSink(null);
        unsubscribe();
    });

    // Authenticated venue endpoints we observe in production. Each entry
    // mirrors the request_body shape the corresponding orders-service
    // method would emit, so the test reflects the actual integration.
    const AUTHENTICATED_ENDPOINTS: Array<{
        venue: "binance" | "coinbase";
        endpoint: string;
        method: "GET" | "POST" | "DELETE";
        body: Record<string, unknown>;
    }> = [
        {
            venue: "binance",
            endpoint: "/api/v3/order",
            method: "POST",
            body: {
                symbol: "BTCUSDT",
                side: "BUY",
                type: "MARKET",
                quantity: "0.01",
                apiKey: KNOWN_SECRETS[0],
                signature: KNOWN_SECRETS[2],
                headers: { "X-MBX-APIKEY": KNOWN_SECRETS[0] },
            },
        },
        {
            venue: "binance",
            endpoint: "/api/v3/openOrders",
            method: "GET",
            body: {
                query: { symbol: "BTCUSDT" },
                headers: { "X-MBX-APIKEY": KNOWN_SECRETS[0] },
            },
        },
        {
            venue: "binance",
            endpoint: "/api/v3/order",
            method: "DELETE",
            body: {
                symbol: "BTCUSDT",
                orderId: "12345",
                api_secret: KNOWN_SECRETS[1],
            },
        },
        {
            venue: "binance",
            endpoint: "/sapi/v1/asset/get-funding-asset",
            method: "POST",
            body: { headers: { "X-MBX-APIKEY": KNOWN_SECRETS[0] } },
        },
        {
            venue: "coinbase",
            endpoint: "/api/v3/brokerage/orders",
            method: "POST",
            body: {
                client_order_id: "cb-1",
                side: "BUY",
                product_id: "BTC-USD",
                authorization: `Bearer ${KNOWN_SECRETS[3]}`,
                "CB-ACCESS-KEY": KNOWN_SECRETS[0],
                "CB-ACCESS-PASSPHRASE": "supersecret",
                "CB-ACCESS-SIGN": KNOWN_SECRETS[2],
            },
        },
        {
            venue: "coinbase",
            endpoint: "/api/v3/brokerage/orders/batch_cancel",
            method: "POST",
            body: {
                order_ids: ["a", "b"],
                "CB-ACCESS-KEY": KNOWN_SECRETS[0],
            },
        },
        {
            venue: "coinbase",
            endpoint: "/api/v3/brokerage/accounts",
            method: "GET",
            body: { headers: { authorization: `Bearer ${KNOWN_SECRETS[3]}` } },
        },
        {
            venue: "coinbase",
            endpoint: "/api/v3/brokerage/orders/edit",
            method: "POST",
            body: {
                order_id: "x",
                price: "100",
                "CB-ACCESS-SIGN": KNOWN_SECRETS[2],
            },
        },
    ];

    for (const ep of AUTHENTICATED_ENDPOINTS) {
        it(`strips every secret from ${ep.venue} ${ep.method} ${ep.endpoint}`, async () => {
            await callVenueWithRetry({
                venue: ep.venue,
                endpoint: ep.endpoint,
                method: ep.method,
                request_body: ep.body,
                userId: "user-1",
                request_id: "req-secret-scan",
                is_write: ep.method !== "GET",
                client_order_id: `coid-${ep.endpoint.replace(/[^a-z0-9]/gi, "")}`,
                invoke: async () => ({
                    http_status: 200,
                    body: { ok: true, echoBack: ep.body },
                    latency_ms: 5,
                }),
            });

            // Allow the fire-and-forget sink to flush.
            await new Promise((r) => setImmediate(r));

            // 1. The persisted row must not contain any known secret.
            expect(sinkRows.length).toBeGreaterThan(0);
            for (const row of sinkRows) {
                const serialized = JSON.stringify(row);
                for (const s of KNOWN_SECRETS) {
                    expect(
                        serialized.includes(s),
                        `${ep.venue} ${ep.method} ${ep.endpoint}: row leaked ${s.slice(0, 8)}`,
                    ).toBe(false);
                }
                expect(serialized).toContain("<redacted>");
            }

            // 2. The emitted [Trading] event must not contain any known secret.
            const venueCalls = events.filter((e) => e.stage === "venue_call");
            for (const evt of venueCalls) {
                const serialized = JSON.stringify(evt);
                for (const s of KNOWN_SECRETS) {
                    expect(
                        serialized.includes(s),
                        `${ep.venue} ${ep.method} ${ep.endpoint}: event leaked ${s.slice(0, 8)}`,
                    ).toBe(false);
                }
            }
        });
    }

    it("recordVenueCall directly never lets a secret through to the sink", async () => {
        await recordVenueCall({
            request_id: "req-direct",
            userId: "user-1",
            venue: "binance",
            endpoint: "/api/v3/order",
            method: "POST",
            http_status: 200,
            latency_ms: 1,
            outcome: "ok",
            request_body: {
                apiKey: KNOWN_SECRETS[0],
                signature: KNOWN_SECRETS[2],
                nested: { token: KNOWN_SECRETS[3] },
            },
            response_body: { api_secret: KNOWN_SECRETS[1] },
        });
        await new Promise((r) => setImmediate(r));
        expect(sinkRows.length).toBe(1);
        const out = JSON.stringify(sinkRows[0]);
        for (const s of KNOWN_SECRETS) {
            expect(out).not.toContain(s);
        }
    });
});
