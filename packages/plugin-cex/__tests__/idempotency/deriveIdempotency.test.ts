/**
 * §6.8 — paired identity helper.
 *
 * The LLM-driven order path used to ship ledger rows with `intent_hash=""`
 * and `request_id=""` because the handler only called `deriveClientOrderId`
 * (single value) and never re-built the canonical intent for the
 * `intent_hash`. The §6.7 replay tool joins on `intent_hash` and was therefore
 * unable to thread together venue_call / risk_decision / pending_order events
 * for new rows. The new `deriveIdempotency` hook returns both ids, so the
 * handler can stamp `intent_hash` and `request_id` alongside the existing
 * `client_order_id` stamp.
 */

import { describe, expect, it } from "vitest";
import { cexPlugin } from "../../src/index";

type Provider = {
    deriveIdempotency: (i: unknown) => { client_order_id: string; intent_hash: string } | null;
};

const provider = (
    cexPlugin as unknown as { cexSpecProvider: Provider }
).cexSpecProvider;

function buyOrder(extra: Record<string, unknown> = {}) {
    return {
        action: "create_order",
        venue: "binance",
        userId: "user-1",
        locale: "en" as const,
        mode: "live" as const,
        params: {
            userId: "user-1",
            product_id: "BTC-USDT",
            symbol: "BTC-USDT",
            side: "BUY",
            order_configuration: {
                limit_limit_gtc: { base_size: "0.001", limit_price: "60000" },
            },
            ...extra,
        },
    };
}

describe("§6.8 deriveIdempotency", () => {
    it("returns NON-empty client_order_id AND intent_hash", () => {
        const out = provider.deriveIdempotency(buyOrder());
        expect(out).not.toBeNull();
        expect(out?.client_order_id.length).toBeGreaterThan(0);
        expect(out?.intent_hash.length).toBeGreaterThan(0);
    });

    it("is deterministic — same canonical input produces the same pair", () => {
        const a = provider.deriveIdempotency(buyOrder());
        const b = provider.deriveIdempotency(buyOrder());
        expect(a).toEqual(b);
    });

    it("different size produces different intent_hash AND client_order_id", () => {
        const a = provider.deriveIdempotency(buyOrder());
        const b = provider.deriveIdempotency(
            buyOrder({
                order_configuration: {
                    limit_limit_gtc: { base_size: "0.002", limit_price: "60000" },
                },
            }),
        );
        expect(a?.intent_hash).not.toEqual(b?.intent_hash);
        expect(a?.client_order_id).not.toEqual(b?.client_order_id);
    });

    it("locale changes do NOT change intent_hash (hashable subset excludes locale)", () => {
        const en = provider.deriveIdempotency({ ...buyOrder(), locale: "en" as const });
        const zh = provider.deriveIdempotency({ ...buyOrder(), locale: "zh-CN" as const });
        expect(en?.intent_hash).toEqual(zh?.intent_hash);
    });
});
