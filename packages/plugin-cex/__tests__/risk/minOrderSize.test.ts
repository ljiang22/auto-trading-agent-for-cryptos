/**
 * Fix 5 — risk-engine defense-in-depth for non-positive / missing sizes.
 *
 * The schema layer's `positiveDecimalString` catches these at parse
 * time, but the risk engine also runs on intents constructed bypassing
 * that schema. These tests assert the `minOrderSize` rule fires BLOCK
 * for missing-size and non-positive-size cases and falls through with
 * `allow` for any strictly-positive size.
 */

import { describe, expect, it } from "vitest";
import { minOrderSize } from "../../src/risk/rules/minOrderSize";
import type { CanonicalIntent } from "../../src/intent/canonicalIntent";
import type {
    RiskEvaluationContext,
    UserTradingPreferences,
} from "../../src/risk/types";
import { DEFAULT_USER_TRADING_PREFERENCES } from "../../src/risk/types";

const prefs: UserTradingPreferences = {
    ...DEFAULT_USER_TRADING_PREFERENCES,
    userId: "u1",
    updatedAt: new Date().toISOString(),
};

const ctx: RiskEvaluationContext = { preferences: prefs };

function buildIntent(overrides: Partial<CanonicalIntent> = {}): CanonicalIntent {
    return {
        intent_version: 1,
        request_id: "req-1",
        user_id: "u1",
        action: "create_order",
        mode: "live",
        venue: "binance",
        symbol: "BTC-USDT",
        side: "BUY",
        order_type: "limit",
        size: { base_size: "0.001" },
        idempotency: {
            client_order_id: "test",
            intent_hash: "f".repeat(64),
        },
        policy_context: {},
        locale: "en",
        ...overrides,
    } as CanonicalIntent;
}

describe("minOrderSize risk rule (Fix 5)", () => {
    it("allows a positive base_size", () => {
        const intent = buildIntent({ size: { base_size: "0.001" } });
        const r = minOrderSize(intent, ctx);
        expect(r.verdict).toBe("allow");
    });

    it("allows a positive quote_size", () => {
        const intent = buildIntent({ size: { quote_size: "100" } });
        const r = minOrderSize(intent, ctx);
        expect(r.verdict).toBe("allow");
    });

    it("blocks when size is undefined entirely", () => {
        const intent = buildIntent({ size: undefined });
        const r = minOrderSize(intent, ctx);
        expect(r.verdict).toBe("block");
        expect(r.id).toBe("minOrderSize");
        expect(r.explanation).toMatch(/missing|absent/i);
    });

    it("blocks when both base_size and quote_size are undefined", () => {
        const intent = buildIntent({
            size: { base_size: undefined, quote_size: undefined },
        });
        const r = minOrderSize(intent, ctx);
        expect(r.verdict).toBe("block");
        expect(r.id).toBe("minOrderSize");
    });

    it("blocks when base_size = \"0\"", () => {
        const intent = buildIntent({ size: { base_size: "0" } });
        const r = minOrderSize(intent, ctx);
        expect(r.verdict).toBe("block");
        expect(r.explanation).toMatch(/positive/i);
    });

    it("blocks when base_size = \"-1\"", () => {
        const intent = buildIntent({ size: { base_size: "-1" } });
        const r = minOrderSize(intent, ctx);
        expect(r.verdict).toBe("block");
    });

    it("blocks when quote_size = \"0\"", () => {
        const intent = buildIntent({ size: { quote_size: "0" } });
        const r = minOrderSize(intent, ctx);
        expect(r.verdict).toBe("block");
    });

    it("blocks when both base_size = \"0\" and quote_size = \"0\"", () => {
        const intent = buildIntent({
            size: { base_size: "0", quote_size: "0" },
        });
        const r = minOrderSize(intent, ctx);
        expect(r.verdict).toBe("block");
    });

    it("allows when one of (base_size, quote_size) is non-positive but the other is positive", () => {
        // base_size = "0" but quote_size = "100" → still BUY for 100 USDT,
        // the positive quote_size satisfies the rule.
        const intent = buildIntent({
            size: { base_size: "0", quote_size: "100" },
        });
        const r = minOrderSize(intent, ctx);
        expect(r.verdict).toBe("allow");
    });

    it("skips for read-only actions (get_balance, get_orders, get_fills)", () => {
        for (const action of [
            "get_balance",
            "get_orders",
            "get_fills",
        ] as const) {
            const intent = buildIntent({ action, size: undefined });
            const r = minOrderSize(intent, ctx);
            expect(r.verdict).toBe("allow");
        }
    });

    it("skips for cancel_order and amend_order", () => {
        for (const action of ["cancel_order", "amend_order"] as const) {
            const intent = buildIntent({ action, size: undefined });
            const r = minOrderSize(intent, ctx);
            expect(r.verdict).toBe("allow");
        }
    });

    it("fires for preview_order with non-positive size (same gate as create_order)", () => {
        const intent = buildIntent({ action: "preview_order", size: { base_size: "0" } });
        const r = minOrderSize(intent, ctx);
        expect(r.verdict).toBe("block");
    });
});
