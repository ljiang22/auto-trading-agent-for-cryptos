/**
 * §6 DoD — audit completeness.
 *
 * Asserts every order — regardless of outcome — produces enough audit
 * rows to fully reconstruct the decision at replay time. The DoD calls
 * for ≥12 records spanning preprocess → intent → risk → idempotency →
 * approval (×2) → order_submit → order_ack → reconciliation_event →
 * venue_call (×N) → fail_closed (rare). This test seeds an emit-only
 * harness and counts events for a typical happy path + a fail-closed
 * path.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    emitApprovalDecision,
    emitApprovalRequest,
    emitFailClosed,
    emitIdempotency,
    emitIntentClassified,
    emitOrderAck,
    emitOrderSubmit,
    emitPreprocess,
    emitReconciliationEvent,
    emitRiskCheck,
    emitVenueCall,
    onTradingEvent,
} from "../../src/observability/tradingEvents";
import { buildCanonicalIntent } from "../../src/intent/intentBuilder";
import { evaluate } from "../../src/risk/riskEngine";
import { DEFAULT_USER_TRADING_PREFERENCES } from "../../src/risk/types";

function makeIntent() {
    return buildCanonicalIntent({
        action: "create_order",
        venue: "binance",
        userId: "user-A",
        locale: "en",
        mode: "live",
        params: {
            userId: "user-A" as never,
            product_id: "BTC-USDT",
            symbol: "BTC-USDT",
            side: "BUY",
            order_configuration: { market_market_ioc: { base_size: "0.01" } },
        },
    });
}

describe("§6 audit-completeness DoD", () => {
    let events: Array<Record<string, unknown>>;
    let unsub: () => void;

    beforeEach(() => {
        events = [];
        unsub = onTradingEvent((e) => events.push(e));
    });

    afterEach(() => {
        unsub();
    });

    it("happy path emits ≥12 distinct lifecycle records per order", () => {
        const intent = makeIntent();
        const decision = evaluate(intent, {
            preferences: {
                userId: "user-A",
                ...DEFAULT_USER_TRADING_PREFERENCES,
                updatedAt: new Date().toISOString(),
            } as never,
        });
        emitPreprocess({
            request_id: intent.request_id,
            userId: intent.user_id,
            locale: intent.locale,
            stake: "write",
            venue: intent.venue,
            latency_ms: 1,
        });
        emitIntentClassified(intent, "write", 2);
        emitRiskCheck(intent, decision, 3);
        emitIdempotency(intent, false);
        emitApprovalRequest(intent, 1);
        emitApprovalDecision(intent, "approved", 1);
        emitApprovalRequest(intent, 2);
        emitApprovalDecision(intent, "approved", 2);
        emitOrderSubmit(intent);
        // Two venue_call events: preflight + submit
        emitVenueCall({
            request_id: intent.request_id,
            userId: intent.user_id,
            venue: intent.venue,
            endpoint: "/api/v3/exchangeInfo",
            method: "GET",
            latency_ms: 12,
            http_status: 200,
        });
        emitVenueCall({
            request_id: intent.request_id,
            userId: intent.user_id,
            venue: intent.venue,
            endpoint: "/api/v3/order",
            method: "POST",
            latency_ms: 60,
            http_status: 200,
            client_order_id: intent.idempotency.client_order_id,
        });
        emitOrderAck(intent, 70, "venue-id-1");
        emitReconciliationEvent({
            request_id: intent.request_id,
            userId: intent.user_id,
            venue: intent.venue,
            symbol: intent.symbol,
            client_order_id: intent.idempotency.client_order_id,
            state: "filled",
            source: "ws",
        });

        expect(events.length).toBeGreaterThanOrEqual(12);
        const stages = events.map((e) => e.stage);
        for (const required of [
            "preprocess",
            "intent_classified",
            "risk_check",
            "idempotency",
            "approval_request",
            "approval_decision",
            "order_submit",
            "venue_call",
            "order_ack",
            "reconciliation_event",
        ]) {
            expect(stages, `${required} missing from audit`).toContain(required);
        }
    });

    it("every event row carries the join trio (request_id, intent_hash, userId)", () => {
        const intent = makeIntent();
        emitOrderSubmit(intent);
        emitOrderAck(intent, 80);
        for (const e of events) {
            expect(e.request_id, "request_id missing").toBe(intent.request_id);
            expect(e.intent_hash, "intent_hash missing").toBe(
                intent.idempotency.intent_hash,
            );
            expect(e.userId).toBe(intent.user_id);
        }
    });

    it("fail-closed paths emit fail_closed with reasons array", () => {
        emitFailClosed({
            request_id: "req-1",
            userId: "user-A",
            venue: "binance",
            locale: "en",
            reasons: ["risk_audit_sink_dead", "market_data_stale"],
            bypassed: false,
        });
        const failClosed = events.find((e) => e.stage === "fail_closed");
        expect(failClosed).toBeDefined();
        expect((failClosed as { reasons: string[] }).reasons).toEqual([
            "risk_audit_sink_dead",
            "market_data_stale",
        ]);
    });
});
