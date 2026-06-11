import { describe, it, expect } from "vitest";
import { priceDeviation } from "../src/risk/rules/priceDeviation";
import type { CanonicalIntent } from "../src/intent/canonicalIntent";
import type { RiskEvaluationContext, UserTradingPreferences } from "../src/risk/types";
import { DEFAULT_USER_TRADING_PREFERENCES } from "../src/risk/types";

const prefs: UserTradingPreferences = {
    ...DEFAULT_USER_TRADING_PREFERENCES,
    userId: "u1",
    updatedAt: new Date().toISOString(),
};

const baseIntent: CanonicalIntent = {
    intent_version: 1,
    request_id: "req-1",
    user_id: "u1",
    action: "create_order",
    mode: "live",
    venue: "binance",
    symbol: "ETH-USDT",
    side: "BUY",
    order_type: "limit",
    size: { base_size: "0.5" },
    idempotency: {
        client_order_id: "test",
        intent_hash: "f".repeat(64),
    },
    policy_context: {},
    locale: "en",
} as CanonicalIntent;

function ctxWith(overrides: Partial<RiskEvaluationContext> = {}): RiskEvaluationContext {
    return { preferences: prefs, ...overrides };
}

describe("priceDeviation risk rule", () => {
    it("allows when limit price is within deviation cap", () => {
        const intent: CanonicalIntent = {
            ...baseIntent,
            price_params: { limit_price: "2100" },
        };
        const result = priceDeviation(intent, ctxWith({ market_mid_usd: 2000 }));
        expect(result.verdict).toBe("allow");
    });

    it("blocks BUY limit price wildly above market (BTC price on ETH pair)", () => {
        const intent: CanonicalIntent = {
            ...baseIntent,
            price_params: { limit_price: "62000" },
        };
        const result = priceDeviation(intent, ctxWith({ market_mid_usd: 2100 }));
        expect(result.verdict).toBe("block");
        expect(result.explanation).toMatch(/price.*deviation|too.*market/i);
        expect(result.metadata?.limit_price).toBe(62000);
        expect(result.metadata?.market_mid_usd).toBe(2100);
    });

    it("blocks SELL limit price wildly below market", () => {
        const intent: CanonicalIntent = {
            ...baseIntent,
            side: "SELL",
            price_params: { limit_price: "100" },
        };
        const result = priceDeviation(intent, ctxWith({ market_mid_usd: 2100 }));
        expect(result.verdict).toBe("block");
    });

    it("allows when market mid is unavailable (fail-open like slippageCap)", () => {
        const intent: CanonicalIntent = {
            ...baseIntent,
            price_params: { limit_price: "62000" },
        };
        const result = priceDeviation(intent, ctxWith({ market_mid_usd: undefined }));
        expect(result.verdict).toBe("allow");
    });

    it("skips market orders (no limit_price to compare)", () => {
        const intent: CanonicalIntent = {
            ...baseIntent,
            order_type: "market",
            price_params: undefined,
        };
        const result = priceDeviation(intent, ctxWith({ market_mid_usd: 2100 }));
        expect(result.verdict).toBe("allow");
    });

    it("skips non-create_order actions", () => {
        const intent: CanonicalIntent = {
            ...baseIntent,
            action: "cancel_order",
            price_params: { limit_price: "62000" },
        };
        const result = priceDeviation(intent, ctxWith({ market_mid_usd: 2100 }));
        expect(result.verdict).toBe("allow");
    });

    it("honours per-user preference override when present", () => {
        const intent: CanonicalIntent = {
            ...baseIntent,
            price_params: { limit_price: "2500" },
        };
        // 2500 vs mid 2000 = 25% deviation. Default cap is 20%, custom 30%.
        const looserPrefs: UserTradingPreferences = { ...prefs, price_deviation_max_pct: 0.3 };
        const result = priceDeviation(intent, {
            preferences: looserPrefs,
            market_mid_usd: 2000,
        });
        expect(result.verdict).toBe("allow");
    });

    it("respects intent execution_constraints.price_deviation_max_pct (must be <= profile cap)", () => {
        const intent: CanonicalIntent = {
            ...baseIntent,
            price_params: { limit_price: "2300" },
            execution_constraints: { price_deviation_max_pct: 0.05 },
        };
        // 2300 vs mid 2000 = 15% deviation. User said 5% — block.
        const result = priceDeviation(intent, ctxWith({ market_mid_usd: 2000 }));
        expect(result.verdict).toBe("block");
    });

    it("checks stop_limit limit_price too", () => {
        const intent: CanonicalIntent = {
            ...baseIntent,
            order_type: "stop_limit",
            price_params: { limit_price: "62000", stop_price: "61000" },
        };
        const result = priceDeviation(intent, ctxWith({ market_mid_usd: 2100 }));
        expect(result.verdict).toBe("block");
    });

    it("rejects non-positive market mid (treat as missing)", () => {
        const intent: CanonicalIntent = {
            ...baseIntent,
            price_params: { limit_price: "62000" },
        };
        const result = priceDeviation(intent, ctxWith({ market_mid_usd: 0 }));
        expect(result.verdict).toBe("allow");
    });
});
