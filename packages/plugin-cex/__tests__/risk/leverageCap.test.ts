/**
 * 2026-05-25 hardening (QA H-1) — leverageCap risk-rule tests.
 *
 * The QA report flagged that "Use 20x leverage on BTC" produced a full
 * order plan with no risk warning. The rule defends in-depth alongside
 * the LLM-prompt update.
 */

import { describe, expect, it } from "vitest";
import { leverageCap } from "../../src/risk/rules/leverageCap";
import type { CanonicalIntent } from "../../src/intent/canonicalIntent";
import type {
    RiskEvaluationContext,
    UserTradingPreferences,
} from "../../src/risk/types";
import { DEFAULT_USER_TRADING_PREFERENCES } from "../../src/risk/types";

const basePrefs: UserTradingPreferences = {
    ...DEFAULT_USER_TRADING_PREFERENCES,
    userId: "u1",
    updatedAt: new Date().toISOString(),
};

function ctxWith(prefs: UserTradingPreferences): RiskEvaluationContext {
    return { preferences: prefs };
}

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

describe("leverageCap risk rule (QA H-1)", () => {
    it("allows a spot order with no margin_context", () => {
        const intent = buildIntent({ margin_context: undefined });
        const r = leverageCap(intent, ctxWith(basePrefs));
        expect(r.verdict).toBe("allow");
    });

    it("allows leverage at the user's configured maximum (5x default)", () => {
        const intent = buildIntent({
            margin_context: { leverage: "5", margin_type: "CROSS" },
        });
        const r = leverageCap(intent, ctxWith(basePrefs));
        expect(r.verdict).toBe("allow");
    });

    it("blocks 20x leverage on BTC (QA S5-3 repro)", () => {
        const intent = buildIntent({
            margin_context: { leverage: "20", margin_type: "CROSS" },
        });
        const r = leverageCap(intent, ctxWith(basePrefs));
        expect(r.verdict).toBe("block");
        expect(r.id).toBe("leverageCap");
        expect(r.explanation).toMatch(/leverage/i);
        expect(r.explanation).toMatch(/Risk Limits/i);
    });

    it("blocks 11x even when the user has bumped their cap to 10x (platform hard cap)", () => {
        const intent = buildIntent({
            margin_context: { leverage: "11", margin_type: "CROSS" },
        });
        const r = leverageCap(intent, ctxWith({ ...basePrefs, max_leverage: 100 }));
        expect(r.verdict).toBe("block");
    });

    it("allows 1x leverage (effectively spot)", () => {
        const intent = buildIntent({
            margin_context: { leverage: "1", margin_type: "CROSS" },
        });
        const r = leverageCap(intent, ctxWith(basePrefs));
        expect(r.verdict).toBe("allow");
    });

    it("allows above-default-but-below-cap when user has raised their max", () => {
        const intent = buildIntent({
            margin_context: { leverage: "8", margin_type: "CROSS" },
        });
        const r = leverageCap(intent, ctxWith({ ...basePrefs, max_leverage: 10 }));
        expect(r.verdict).toBe("allow");
    });

    it("blocks above-user-max even if below platform hard cap", () => {
        const intent = buildIntent({
            margin_context: { leverage: "8", margin_type: "CROSS" },
        });
        // user has chosen a stricter personal cap of 3x.
        const r = leverageCap(intent, ctxWith({ ...basePrefs, max_leverage: 3 }));
        expect(r.verdict).toBe("block");
    });

    it("skips read-only / non-create_order actions", () => {
        for (const action of ["get_balance", "get_orders", "cancel_order"] as const) {
            const intent = buildIntent({
                action,
                margin_context: { leverage: "50" },
            });
            const r = leverageCap(intent, ctxWith(basePrefs));
            expect(r.verdict).toBe("allow");
        }
    });

    it("allows when leverage is unparseable (defensive: don't block on garbage)", () => {
        const intent = buildIntent({
            margin_context: { leverage: "not-a-number" },
        });
        const r = leverageCap(intent, ctxWith(basePrefs));
        expect(r.verdict).toBe("allow");
    });

    it("blocks when LLM emits leverage as a JSON number instead of a string (staging 2026-05-26 repro)", () => {
        // Schema declares leverage as string, but the ADK/LLM extractor
        // sometimes produces a number. Rule must still refuse.
        const intent = buildIntent({
            margin_context: { leverage: 20 as unknown as string, margin_type: "CROSS" },
        });
        const r = leverageCap(intent, ctxWith(basePrefs));
        expect(r.verdict).toBe("block");
        expect(r.id).toBe("leverageCap");
    });
});
