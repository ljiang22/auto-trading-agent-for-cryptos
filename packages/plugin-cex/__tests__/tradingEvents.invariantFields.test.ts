import { describe, it, expect } from "vitest";
import { canonicalIntentSchema, type CanonicalIntent } from "../src/intent/canonicalIntent";
import {
    emitOrderAck,
    emitOrderSubmit,
    emitRiskCheck,
    onTradingEvent,
} from "../src/observability/tradingEvents";

// F4 — every `[Trading]` event that has access to a CanonicalIntent must
// carry the full invariant field set from CLAUDE.md autotrading uplift:
//   {request_id, intent_hash, userId, venue, symbol, side, notional_usd,
//    locale, stake, decision (where applicable), rules_fired (where
//    applicable), latency_ms (where applicable)}
//
// Without these CloudWatch metric filters can't tell paper from live and
// can't sum exposure. QA H3 reproduction.

function buildIntent(mode: "live" | "paper" | "shadow" = "live"): CanonicalIntent {
    const draft = {
        intent_version: 1 as const,
        request_id: "req-test-1",
        user_id: "user-test",
        action: "create_order" as const,
        mode,
        venue: "binance",
        symbol: "BTC-USDT",
        side: "BUY" as const,
        order_type: "limit" as const,
        size: { base_size: "0.001" },
        price_params: { limit_price: "60000" },
        execution_constraints: { time_in_force: "GTC" as const },
        margin_context: {},
        idempotency: {
            client_order_id: "bn-test",
            intent_hash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        },
        policy_context: { kill_switch_active: false },
        locale: "en" as const,
        notional_usd_estimated: 60,
    };
    return canonicalIntentSchema.parse(draft);
}

describe("F4 — invariant field set on every emit", () => {
    it("emitOrderSubmit carries stake + notional_usd + the rest of the 9 intent fields", async () => {
        const captured: unknown[] = [];
        const off = onTradingEvent((e) => captured.push(e));
        try {
            emitOrderSubmit(buildIntent("live"));
            const ev = captured[0] as Record<string, unknown>;
            expect(ev.stage).toBe("order_submit");
            expect(ev.request_id).toBe("req-test-1");
            expect(ev.intent_hash).toMatch(/^deadbeef/);
            expect(ev.userId).toBe("user-test");
            expect(ev.venue).toBe("binance");
            expect(ev.symbol).toBe("BTC-USDT");
            expect(ev.side).toBe("BUY");
            expect(ev.locale).toBe("en");
            expect(ev.stake).toBe("live");
            expect(ev.notional_usd).toBe(60);
        } finally {
            off();
        }
    });

    it("paper-mode intent emits stake=\"paper\" — distinguishable from live", async () => {
        const captured: unknown[] = [];
        const off = onTradingEvent((e) => captured.push(e));
        try {
            emitOrderSubmit(buildIntent("paper"));
            const ev = captured[0] as Record<string, unknown>;
            expect(ev.stake).toBe("paper");
        } finally {
            off();
        }
    });

    it("emitRiskCheck carries decision + rules_fired + latency_ms", async () => {
        const captured: unknown[] = [];
        const off = onTradingEvent((e) => captured.push(e));
        try {
            emitRiskCheck(
                buildIntent("live"),
                { verdict: "allow", rules_fired: [], explanations: [] } as never,
                123,
            );
            const ev = captured[0] as Record<string, unknown>;
            expect(ev.decision).toBe("allow");
            expect(ev.rules_fired).toEqual([]);
            expect(ev.latency_ms).toBe(123);
            expect(ev.stake).toBe("live");
            expect(ev.notional_usd).toBe(60);
        } finally {
            off();
        }
    });

    it("emitOrderAck carries latency_ms + venue_order_id alongside the invariants", async () => {
        const captured: unknown[] = [];
        const off = onTradingEvent((e) => captured.push(e));
        try {
            emitOrderAck(buildIntent("paper"), 42, "venue-abc");
            const ev = captured[0] as Record<string, unknown>;
            expect(ev.latency_ms).toBe(42);
            expect(ev.venue_order_id).toBe("venue-abc");
            expect(ev.stake).toBe("paper");
        } finally {
            off();
        }
    });
});
