import { describe, it, expect } from "vitest";
import { canonicalIntentSchema } from "../src/intent/canonicalIntent";
import { buildCanonicalIntent } from "../src/intent/intentBuilder";

// F7 — canonical-intent validator hardening. These prevent malformed
// orders from reaching the venue REST call (the venue would reject
// with a cryptic 4xx; better to fail-fast in the client).

const baseIntent = {
    intent_version: 1 as const,
    request_id: "req-test",
    user_id: "user-test",
    action: "create_order" as const,
    mode: "live" as const,
    venue: "binance",
    symbol: "BTC-USDT",
    side: "BUY" as const,
    size: { base_size: "0.01" },
    idempotency: {
        client_order_id: "bn-test",
        intent_hash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    },
    policy_context: {},
    locale: "en" as const,
};

describe("F7 canonical-intent validator hardening", () => {
    it("rejects stop_limit without stop_price", () => {
        const res = canonicalIntentSchema.safeParse({
            ...baseIntent,
            order_type: "stop_limit",
            price_params: { limit_price: "60000" },
        });
        expect(res.success).toBe(false);
        if (!res.success) {
            expect(res.error.issues.map((i) => i.message).join(" ")).toMatch(/stop_limit requires both/i);
        }
    });

    it("rejects stop_limit without limit_price", () => {
        const res = canonicalIntentSchema.safeParse({
            ...baseIntent,
            order_type: "stop_limit",
            price_params: { stop_price: "65000" },
        });
        expect(res.success).toBe(false);
    });

    it("accepts stop_limit when both prices are present", () => {
        const res = canonicalIntentSchema.safeParse({
            ...baseIntent,
            order_type: "stop_limit",
            price_params: { stop_price: "65000", limit_price: "64500" },
        });
        expect(res.success).toBe(true);
    });

    it("rejects time_in_force=GTD without end_time", () => {
        const res = canonicalIntentSchema.safeParse({
            ...baseIntent,
            order_type: "limit",
            price_params: { limit_price: "60000" },
            execution_constraints: { time_in_force: "GTD" },
        });
        expect(res.success).toBe(false);
        if (!res.success) {
            expect(res.error.issues.map((i) => i.message).join(" ")).toMatch(/GTD requires end_time/i);
        }
    });

    it("accepts GTD with end_time", () => {
        const res = canonicalIntentSchema.safeParse({
            ...baseIntent,
            order_type: "limit",
            price_params: { limit_price: "60000" },
            execution_constraints: { time_in_force: "GTD", end_time: "2026-05-20T00:00:00Z" },
        });
        expect(res.success).toBe(true);
    });

    it("rejects post_only with order_type=market", () => {
        const res = canonicalIntentSchema.safeParse({
            ...baseIntent,
            order_type: "market",
            execution_constraints: { post_only: true },
        });
        expect(res.success).toBe(false);
        if (!res.success) {
            expect(res.error.issues.map((i) => i.message).join(" ")).toMatch(/post_only is only valid with order_type=limit/i);
        }
    });

    it("accepts post_only with order_type=limit", () => {
        const res = canonicalIntentSchema.safeParse({
            ...baseIntent,
            order_type: "limit",
            price_params: { limit_price: "60000" },
            execution_constraints: { post_only: true, time_in_force: "GTC" },
        });
        expect(res.success).toBe(true);
    });

    it("rejects margin_type without margin_action", () => {
        const res = canonicalIntentSchema.safeParse({
            ...baseIntent,
            order_type: "limit",
            price_params: { limit_price: "60000" },
            margin_context: { margin_type: "CROSS" },
        });
        expect(res.success).toBe(false);
        if (!res.success) {
            expect(res.error.issues.map((i) => i.message).join(" ")).toMatch(/margin_type set without margin_action/i);
        }
    });

    it("accepts margin_type + margin_action together", () => {
        const res = canonicalIntentSchema.safeParse({
            ...baseIntent,
            order_type: "limit",
            price_params: { limit_price: "60000" },
            margin_context: { margin_type: "CROSS", margin_action: "AUTO_BORROW", leverage: "2" },
        });
        expect(res.success).toBe(true);
    });

    it("rejects TIF values outside the GTC/GTD/IOC/FOK enum", () => {
        const res = canonicalIntentSchema.safeParse({
            ...baseIntent,
            order_type: "limit",
            price_params: { limit_price: "60000" },
            execution_constraints: { time_in_force: "GoodTilCancel" as never },
        });
        expect(res.success).toBe(false);
    });

    it("accepts trailing_stop_limit from dialog order_configuration", () => {
        const intent = buildCanonicalIntent({
            action: "create_order",
            venue: "binance",
            userId: "user-test",
            locale: "en",
            params: {
                userId: "user-test",
                product_id: "BTC-USDT",
                side: "SELL",
                order_configuration: {
                    trailing_stop_limit_gtc: {
                        base_size: "0.00006",
                        trailing_delta_bps: 100,
                        activation_price: "72000.00",
                    },
                },
            },
        });
        expect(intent.order_type).toBe("trailing_stop_limit");
        expect(intent.execution_constraints?.trailing_delta_bps).toBe(100);
        expect(intent.execution_constraints?.trailing_activation_price).toBe(
            "72000.00",
        );
    });

    it("accepts oco from dialog order_configuration", () => {
        const intent = buildCanonicalIntent({
            action: "create_order",
            venue: "binance",
            userId: "user-test",
            locale: "en",
            params: {
                userId: "user-test",
                product_id: "BTC-USDT",
                side: "SELL",
                order_configuration: {
                    oco_gtc: {
                        base_size: "0.00006",
                        above_limit_price: "72000.00",
                        below_stop_price: "48000.00",
                        below_limit_price: "47800.00",
                    },
                },
            },
        });
        expect(intent.order_type).toBe("oco");
        expect(intent.size?.base_size).toBe("0.00006");
    });
});

// Fix 5 — schema-layer rejection of non-positive sizes/prices. These cover
// every field touched by the `positiveDecimalString` refinement so a
// regression on any one of them surfaces directly.
describe("Fix 5 positiveDecimalString — sizes and prices must be strictly positive", () => {
    it("accepts a positive base_size", () => {
        const res = canonicalIntentSchema.safeParse({
            ...baseIntent,
            size: { base_size: "0.001" },
        });
        expect(res.success).toBe(true);
    });

    it("rejects base_size = \"0\"", () => {
        const res = canonicalIntentSchema.safeParse({
            ...baseIntent,
            size: { base_size: "0" },
        });
        expect(res.success).toBe(false);
        if (!res.success) {
            expect(res.error.issues.map((i) => i.message).join(" ")).toMatch(
                /positive decimal/i,
            );
        }
    });

    it("rejects base_size = \"-1\"", () => {
        const res = canonicalIntentSchema.safeParse({
            ...baseIntent,
            size: { base_size: "-1" },
        });
        expect(res.success).toBe(false);
    });

    it("rejects base_size = \"-0.5\"", () => {
        const res = canonicalIntentSchema.safeParse({
            ...baseIntent,
            size: { base_size: "-0.5" },
        });
        expect(res.success).toBe(false);
    });

    it("rejects quote_size = \"0\"", () => {
        const res = canonicalIntentSchema.safeParse({
            ...baseIntent,
            size: { quote_size: "0" },
        });
        expect(res.success).toBe(false);
    });

    it("accepts a positive quote_size when base_size is omitted", () => {
        const res = canonicalIntentSchema.safeParse({
            ...baseIntent,
            size: { quote_size: "100" },
        });
        expect(res.success).toBe(true);
    });

    it("rejects size = {} (both base_size and quote_size missing)", () => {
        const res = canonicalIntentSchema.safeParse({
            ...baseIntent,
            size: {},
        });
        expect(res.success).toBe(false);
        if (!res.success) {
            expect(res.error.issues.map((i) => i.message).join(" ")).toMatch(
                /size must contain base_size or quote_size/i,
            );
        }
    });

    it("rejects iceberg_qty = \"0\"", () => {
        const res = canonicalIntentSchema.safeParse({
            ...baseIntent,
            order_type: "limit",
            price_params: { limit_price: "60000" },
            execution_constraints: { iceberg_qty: "0", time_in_force: "GTC" },
        });
        expect(res.success).toBe(false);
    });

    it("rejects iceberg_qty = \"-0.001\"", () => {
        const res = canonicalIntentSchema.safeParse({
            ...baseIntent,
            order_type: "limit",
            price_params: { limit_price: "60000" },
            execution_constraints: { iceberg_qty: "-0.001", time_in_force: "GTC" },
        });
        expect(res.success).toBe(false);
    });

    it("accepts a positive iceberg_qty", () => {
        const res = canonicalIntentSchema.safeParse({
            ...baseIntent,
            order_type: "limit",
            price_params: { limit_price: "60000" },
            execution_constraints: { iceberg_qty: "0.001", time_in_force: "GTC" },
        });
        expect(res.success).toBe(true);
    });

    it("rejects limit_price = \"-100\"", () => {
        const res = canonicalIntentSchema.safeParse({
            ...baseIntent,
            order_type: "limit",
            price_params: { limit_price: "-100" },
        });
        expect(res.success).toBe(false);
    });

    it("rejects limit_price = \"0\"", () => {
        const res = canonicalIntentSchema.safeParse({
            ...baseIntent,
            order_type: "limit",
            price_params: { limit_price: "0" },
        });
        expect(res.success).toBe(false);
    });

    it("rejects stop_price = \"-1\"", () => {
        const res = canonicalIntentSchema.safeParse({
            ...baseIntent,
            order_type: "stop_limit",
            price_params: { stop_price: "-1", limit_price: "60000" },
        });
        expect(res.success).toBe(false);
    });

    it("rejects stop_trigger_price = \"0\"", () => {
        const res = canonicalIntentSchema.safeParse({
            ...baseIntent,
            order_type: "trigger_bracket",
            price_params: { stop_trigger_price: "0", limit_price: "60000" },
        });
        expect(res.success).toBe(false);
    });

    it("rejects a non-numeric base_size (e.g. \"abc\")", () => {
        const res = canonicalIntentSchema.safeParse({
            ...baseIntent,
            size: { base_size: "abc" },
        });
        expect(res.success).toBe(false);
    });
});
