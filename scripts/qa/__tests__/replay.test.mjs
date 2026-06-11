/**
 * §6.7 replay byte-stability — same input → same output bytes.
 *
 * Regression hook against any "shuffle" in the renderer (e.g., a Set,
 * Map, or unsorted reduce being introduced into the join). Also asserts
 * that the redactor strips known secret-named keys before any payload
 * reaches stdout, so operator replays don't leak credentials.
 */

import { describe, expect, it } from "vitest";
import {
    buildTimeline,
    redact,
    renderMarkdown,
} from "../replay-render.mjs";

const fixture = {
    risk: [
        {
            request_id: "req-A",
            client_order_id: "binance-1",
            decision: "allow",
            rules_fired: [],
            createdAt: new Date("2026-05-17T01:00:01.000Z"),
        },
    ],
    approvals: [
        {
            request_id: "req-A",
            level: 1,
            decision: "approved",
            createdAt: new Date("2026-05-17T01:00:02.000Z"),
        },
        {
            request_id: "req-A",
            level: 2,
            decision: "approved",
            createdAt: new Date("2026-05-17T01:00:03.000Z"),
        },
    ],
    ledger: [
        {
            request_id: "req-A",
            client_order_id: "binance-1",
            venue: "binance",
            symbol: "BTC-USDT",
            state: "submitted",
            submittedAt: new Date("2026-05-17T01:00:04.000Z"),
        },
        {
            request_id: "req-A",
            client_order_id: "binance-1",
            venue: "binance",
            symbol: "BTC-USDT",
            state: "filled",
            submittedAt: new Date("2026-05-17T01:00:06.000Z"),
        },
    ],
    venueCalls: [
        {
            request_id: "req-A",
            client_order_id: "binance-1",
            venue: "binance",
            method: "POST",
            endpoint: "/api/v3/order",
            http_status: 200,
            latency_ms: 65,
            outcome: "ok",
            request_body: { apiKey: "AKIA-LEAK", side: "BUY" },
            createdAt: new Date("2026-05-17T01:00:05.000Z"),
        },
    ],
    shadow: [],
};

describe("§6.7 replay byte-stability", () => {
    it("buildTimeline orders by createdAt then by kind for ties", () => {
        const events = buildTimeline(fixture);
        const kinds = events.map((e) => e.kind);
        expect(kinds).toEqual([
            "risk_decision",
            "approval_lvl1",
            "approval_lvl2",
            "ledger_submitted",
            "venue_ok",
            "ledger_filled",
        ]);
    });

    it("renderMarkdown produces identical bytes across runs", () => {
        const events = buildTimeline(fixture);
        const a = renderMarkdown({
            requestId: "req-A",
            clientOrderId: "binance-1",
            events,
            elapsedMs: 7,
        });
        const b = renderMarkdown({
            requestId: "req-A",
            clientOrderId: "binance-1",
            events,
            elapsedMs: 7,
        });
        expect(a).toBe(b);
        // Snapshot a short prefix to catch reordering regressions.
        expect(a.startsWith("# Replay — request_id=req-A\nclient_order_id=binance-1")).toBe(true);
    });

    it("redact strips known secret-named keys at every depth", () => {
        const out = JSON.stringify(
            redact({
                top: "ok",
                apiKey: "AKIA-LEAK",
                nested: {
                    "X-MBX-APIKEY": "should-not-appear",
                    inner: { authorization: "Bearer leak" },
                },
                arr: [{ token: "leak", safe: "kept" }],
            }),
        );
        expect(out).not.toContain("AKIA-LEAK");
        expect(out).not.toContain("Bearer leak");
        expect(out).not.toContain("\"token\":\"leak\"");
        expect(out).toContain("kept");
        expect(out).toContain("<redacted>");
    });

    it("redact in the rendered output suppresses credentials", () => {
        const events = buildTimeline(fixture);
        const md = renderMarkdown({
            requestId: "req-A",
            clientOrderId: "binance-1",
            events,
        });
        expect(md).not.toContain("AKIA-LEAK");
        expect(md).toContain("<redacted>");
    });
});
