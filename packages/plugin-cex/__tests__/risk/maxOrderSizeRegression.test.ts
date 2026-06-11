/**
 * §6.0 — `maxOrderSize` regression coverage.
 *
 * Background: a $60k order against a $1k cap was observed to PASS the gate in
 * staging because `runRiskPrecheck` was never populating
 * `estimated_notional_usd`, and the rule silently skipped with
 * "estimated notional unavailable". These tests assert that the plugin's
 * spec-provider entry point derives the notional from the canonical intent
 * (quote_size, OR base_size * limit_price) and routes the verdict to BLOCK
 * with `maxOrderSize` in `rules_fired`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cexPlugin } from "../../src/index";
import { setRiskAuditSink } from "../../src/safety/auditSinkRegistry";

type Provider = {
    runRiskPrecheck: (i: unknown) => Promise<{
        verdict: string;
        rules_fired?: string[];
        explanations?: string[];
    } | null>;
};

const provider = (
    cexPlugin as unknown as { cexSpecProvider: Provider }
).cexSpecProvider;

function quoteSizeOrder(quoteUsd: string) {
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
            order_configuration: { market_market_ioc: { quote_size: quoteUsd } },
        },
        preferences: { max_order_notional_usd: 1_000 },
    };
}

function limitOrder(baseSize: string, limitPrice: string, capUsd: number) {
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
                limit_limit_gtc: { base_size: baseSize, limit_price: limitPrice },
            },
        },
        preferences: { max_order_notional_usd: capUsd },
    };
}

describe("§6.0 maxOrderSize regression — notional must be derived, not skipped", () => {
    afterEach(() => setRiskAuditSink(null));

    it("BLOCKS a $60k quote_size order against a $1k cap", async () => {
        const out = await provider.runRiskPrecheck(quoteSizeOrder("60000"));
        expect(out).not.toBeNull();
        expect(out?.verdict).toBe("block");
        expect(out?.rules_fired ?? []).toContain("maxOrderSize");
    });

    it("BLOCKS a 1 BTC limit @ $60,000 (= $60k notional) against a $1k cap", async () => {
        const out = await provider.runRiskPrecheck(limitOrder("1", "60000", 1_000));
        expect(out).not.toBeNull();
        expect(out?.verdict).toBe("block");
        expect(out?.rules_fired ?? []).toContain("maxOrderSize");
    });

    it("ALLOWS a $500 quote_size order against a $1k cap", async () => {
        const out = await provider.runRiskPrecheck(quoteSizeOrder("500"));
        expect(out).not.toBeNull();
        expect(out?.verdict).toBe("allow");
        expect(out?.rules_fired ?? []).not.toContain("maxOrderSize");
    });

    it("ALLOWS a 0.001 BTC limit @ $60,000 (= $60 notional) against a $1k cap", async () => {
        const out = await provider.runRiskPrecheck(limitOrder("0.001", "60000", 1_000));
        expect(out).not.toBeNull();
        expect(out?.verdict).toBe("allow");
        expect(out?.rules_fired ?? []).not.toContain("maxOrderSize");
    });

    it("respects caller-supplied estimated_notional_usd over intent-derived (market orders)", async () => {
        const base = {
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
                // Market: no quote_size, no limit_price; intent path can't derive.
                order_configuration: { market_market_ioc: { base_size: "1" } },
            },
            preferences: { max_order_notional_usd: 1_000 },
            estimated_notional_usd: 60_000,
        };
        const out = await provider.runRiskPrecheck(base);
        expect(out?.verdict).toBe("block");
        expect(out?.rules_fired ?? []).toContain("maxOrderSize");
    });
});
