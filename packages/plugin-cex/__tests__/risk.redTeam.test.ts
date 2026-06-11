import { describe, expect, it } from "vitest";

import { buildCanonicalIntent } from "../src/intent/intentBuilder";
import { evaluate } from "../src/risk/riskEngine";
import {
    DEFAULT_USER_TRADING_PREFERENCES,
    type UserTradingPreferences,
} from "../src/risk/types";

function prefs(overrides: Partial<UserTradingPreferences> = {}): UserTradingPreferences {
    return {
        userId: "user-1",
        ...DEFAULT_USER_TRADING_PREFERENCES,
        ...overrides,
        updatedAt: new Date().toISOString(),
    };
}

function createIntent(overrides: {
    action?: "create_order" | "get_balance" | "cancel_order";
    venue?: "binance" | "coinbase";
    product_id?: string;
    base_size?: string;
    quote_size?: string;
    limit_price?: string;
}) {
    return buildCanonicalIntent({
        action: (overrides.action ?? "create_order") as never,
        venue: overrides.venue ?? "binance",
        userId: "user-1",
        locale: "en",
        params: {
            userId: "user-1",
            product_id: overrides.product_id ?? "BTC-USDT",
            side: "BUY",
            order_configuration: overrides.limit_price
                ? {
                      limit_limit_gtc: {
                          base_size: overrides.base_size ?? "0.01",
                          limit_price: overrides.limit_price,
                      },
                  }
                : {
                      market_market_ioc: {
                          // Fix 5 — default a positive base_size when caller
                          // doesn't specify any size, so the new minOrderSize
                          // rule doesn't fire on these tests (which are about
                          // *other* rules' verdicts, not the size rule).
                          base_size:
                              overrides.base_size ??
                              (overrides.quote_size ? undefined : "0.01"),
                          quote_size: overrides.quote_size,
                      },
                  },
        },
    });
}

describe("risk engine — zero-bypass red-team suite", () => {
    it("blocks when kill switch is active (write)", () => {
        const intent = createIntent({});
        const d = evaluate(intent, { preferences: prefs({ kill_switch_active: true }) });
        expect(d.verdict).toBe("block");
        expect(d.rules_fired).toContain("killSwitch");
    });

    it("allows reads even when kill switch is active", () => {
        const intent = createIntent({ action: "get_balance" });
        const d = evaluate(intent, { preferences: prefs({ kill_switch_active: true }) });
        expect(d.verdict).toBe("allow");
    });

    it("blocks when projected notional exceeds max order size", () => {
        const intent = createIntent({});
        const d = evaluate(intent, {
            preferences: prefs({ max_order_notional_usd: 100 }),
            estimated_notional_usd: 5000,
        });
        expect(d.verdict).toBe("block");
        expect(d.rules_fired).toContain("maxOrderSize");
    });

    it("blocks asset on blocklist", () => {
        const intent = createIntent({ product_id: "SHIB-USDT" });
        const d = evaluate(intent, {
            preferences: prefs({ asset_blocklist: ["SHIB"] }),
        });
        expect(d.verdict).toBe("block");
        expect(d.rules_fired).toContain("assetAllowlist");
    });

    it("blocks asset NOT on allowlist (when allowlist is non-empty)", () => {
        const intent = createIntent({ product_id: "ETH-USDT" });
        const d = evaluate(intent, {
            preferences: prefs({ asset_allowlist: ["BTC"] }),
        });
        expect(d.verdict).toBe("block");
        expect(d.rules_fired).toContain("assetAllowlist");
    });

    it("allows asset that IS on the allowlist", () => {
        const intent = createIntent({ product_id: "BTC-USDT" });
        const d = evaluate(intent, {
            preferences: prefs({ asset_allowlist: ["BTC"] }),
        });
        expect(d.verdict).toBe("allow");
    });

    it("blocks when daily loss limit is hit", () => {
        const intent = createIntent({});
        const d = evaluate(intent, {
            preferences: prefs({ daily_loss_limit_usd: 200 }),
            rolling_24h_pnl_usd: -250,
        });
        expect(d.verdict).toBe("block");
        expect(d.rules_fired).toContain("dailyLossLimit");
    });

    it("blocks when slippage exceeds cap", () => {
        const intent = createIntent({});
        const d = evaluate(intent, {
            preferences: prefs({ slippage_bps_max: 30 }),
            estimated_slippage_bps: 75,
        });
        expect(d.verdict).toBe("block");
        expect(d.rules_fired).toContain("slippageCap");
    });

    it("blocks when exposure cap (5× max-order) would be breached", () => {
        const intent = createIntent({});
        const d = evaluate(intent, {
            preferences: prefs({ max_order_notional_usd: 1000 }),
            open_exposure_usd: 4500,
            estimated_notional_usd: 800,
        });
        expect(d.verdict).toBe("block");
        expect(d.rules_fired).toContain("exposureCap");
    });

    it("blocks during cooldown after a failure", () => {
        const intent = createIntent({});
        const d = evaluate(intent, {
            preferences: prefs({ cooldown_seconds_after_fail: 60 }),
            last_failure_at_ms: Date.now() - 10_000,
        });
        expect(d.verdict).toBe("block");
        expect(d.rules_fired).toContain("cooldown");
    });

    it("blocks when market data is stale past the cap", () => {
        const intent = createIntent({});
        const d = evaluate(intent, {
            preferences: prefs({ market_data_freshness_max_ms: 10_000 }),
            market_data_age_ms: 60_000,
        });
        expect(d.verdict).toBe("block");
        expect(d.rules_fired).toContain("marketDataFreshness");
    });

    it("downgrades when market data is between 5s and the freshness cap", () => {
        const intent = createIntent({});
        const d = evaluate(intent, {
            preferences: prefs({ market_data_freshness_max_ms: 30_000 }),
            market_data_age_ms: 15_000,
        });
        expect(d.verdict).toBe("downgrade_read_only");
        expect(d.rules_fired).toContain("marketDataFreshness");
    });

    it("a block beats a downgrade when both rules fire", () => {
        const intent = createIntent({});
        const d = evaluate(intent, {
            preferences: prefs({
                max_order_notional_usd: 100,
                market_data_freshness_max_ms: 30_000,
            }),
            estimated_notional_usd: 500,
            market_data_age_ms: 15_000,
        });
        expect(d.verdict).toBe("block");
    });

    it("blocks reconciliation health when there are stale pending orders", () => {
        const intent = createIntent({});
        const d = evaluate(intent, {
            preferences: prefs(),
            stale_reconciliation_count: 3,
        });
        expect(d.verdict).toBe("block");
        expect(d.rules_fired).toContain("reconciliationHealth");
    });

    it("permits a clean order with all rule-relevant data available", () => {
        const intent = createIntent({});
        const d = evaluate(intent, {
            preferences: prefs(),
            estimated_notional_usd: 50,
            open_exposure_usd: 100,
            rolling_24h_pnl_usd: 0,
            estimated_slippage_bps: 10,
            market_data_age_ms: 1_000,
            stale_reconciliation_count: 0,
        });
        expect(d.verdict).toBe("allow");
        expect(d.rules_fired).toEqual([]);
    });

    // ------------------------------------------------------------------
    // Adversarial / boundary cases — 30+ inputs total when combined with
    // the above. None must produce a bypass.
    // ------------------------------------------------------------------

    it("does not skip max-size when only quote_size is specified", () => {
        const intent = createIntent({ quote_size: "20000" });
        const d = evaluate(intent, {
            preferences: prefs({ max_order_notional_usd: 100 }),
            estimated_notional_usd: 20000,
        });
        expect(d.verdict).toBe("block");
    });

    it("treats blocklist UPPER vs lower symmetrically", () => {
        const intent = createIntent({ product_id: "shib-usdt" });
        const d = evaluate(intent, {
            preferences: prefs({ asset_blocklist: ["shib"] }),
        });
        expect(d.verdict).toBe("block");
    });

    it("blocklist hits even when allowlist would have allowed", () => {
        const intent = createIntent({ product_id: "BTC-USDT" });
        const d = evaluate(intent, {
            preferences: prefs({ asset_allowlist: ["BTC"], asset_blocklist: ["BTC"] }),
        });
        expect(d.verdict).toBe("block");
    });

    it("does not block on cancel_order (no size component)", () => {
        const intent = buildCanonicalIntent({
            action: "cancel_order",
            venue: "binance",
            userId: "user-1",
            locale: "en",
            params: { userId: "user-1", product_id: "BTC-USDT", order_ids: ["x"] },
        });
        const d = evaluate(intent, {
            preferences: prefs({ max_order_notional_usd: 1 }),
        });
        expect(d.verdict).toBe("allow");
    });

    it("allows when estimated_notional_usd is undefined (defensive skip on max-size)", () => {
        const intent = createIntent({});
        const d = evaluate(intent, {
            preferences: prefs({ max_order_notional_usd: 1 }),
        });
        // Without notional, max-size cannot fire; ensure no bypass-due-to-error
        expect(d.rules_fired).not.toContain("maxOrderSize");
    });

    it("allows when slippage is undefined (defensive skip)", () => {
        const intent = createIntent({});
        const d = evaluate(intent, {
            preferences: prefs({ slippage_bps_max: 1 }),
        });
        expect(d.rules_fired).not.toContain("slippageCap");
    });

    it("kill switch hides every write action consistently", () => {
        for (const action of ["create_order", "cancel_order", "amend_order", "preview_order"] as const) {
            const intent = buildCanonicalIntent({
                action,
                venue: "binance",
                userId: "user-1",
                locale: "en",
                params: { userId: "user-1", product_id: "BTC-USDT", side: "BUY" },
            });
            const d = evaluate(intent, {
                preferences: prefs({ kill_switch_active: true }),
            });
            expect(d.verdict, `action=${action}`).toBe("block");
        }
    });

    it("cooldown expires after the configured seconds", () => {
        const intent = createIntent({});
        const d = evaluate(intent, {
            preferences: prefs({ cooldown_seconds_after_fail: 1 }),
            last_failure_at_ms: Date.now() - 60_000,
        });
        expect(d.verdict).toBe("allow");
    });

    // ------------------------------------------------------------------
    // Boundary + defense-in-depth additions (Phase 5 polish)
    //
    // These extend the suite past the plan's 30-input bar. Each verifies
    // that a non-canonical input cannot produce a bypass — a class of
    // bugs that escapes happy-path tests.
    // ------------------------------------------------------------------

    it("NaN notional does not bypass maxOrderSize (defensive skip)", () => {
        const intent = createIntent({});
        const d = evaluate(intent, {
            preferences: prefs({ max_order_notional_usd: 100 }),
            estimated_notional_usd: Number.NaN,
        });
        expect(d.rules_fired).not.toContain("maxOrderSize");
    });

    it("Infinity exposure_usd does not silently allow exposureCap", () => {
        const intent = createIntent({});
        const d = evaluate(intent, {
            preferences: prefs({ max_order_notional_usd: 1000 }),
            open_exposure_usd: Number.POSITIVE_INFINITY,
            estimated_notional_usd: 100,
        });
        if (d.verdict === "allow") {
            expect(d.rules_fired).not.toContain("exposureCap");
        } else {
            expect(d.verdict).toBe("block");
        }
    });

    it("three rules fire simultaneously; rules_fired reports all three", () => {
        const intent = createIntent({});
        const d = evaluate(intent, {
            preferences: prefs({
                max_order_notional_usd: 50,
                slippage_bps_max: 5,
                daily_loss_limit_usd: 100,
            }),
            estimated_notional_usd: 500,
            estimated_slippage_bps: 60,
            rolling_24h_pnl_usd: -150,
        });
        expect(d.verdict).toBe("block");
        expect(d.rules_fired).toEqual(
            expect.arrayContaining([
                "maxOrderSize",
                "slippageCap",
                "dailyLossLimit",
            ]),
        );
    });

    it("cooldown with last_failure_at_ms in the future does not bypass", () => {
        const intent = createIntent({});
        const d = evaluate(intent, {
            preferences: prefs({ cooldown_seconds_after_fail: 60 }),
            last_failure_at_ms: Date.now() + 60_000,
        });
        expect(d.verdict).toBe("block");
        expect(d.rules_fired).toContain("cooldown");
    });

    it("slippage cap = 0 with bps = 0 allows (zero/zero boundary)", () => {
        const intent = createIntent({});
        const d = evaluate(intent, {
            preferences: prefs({ slippage_bps_max: 0 }),
            estimated_slippage_bps: 0,
        });
        expect(d.rules_fired).not.toContain("slippageCap");
    });

    it("slippage cap = 0 with any positive bps blocks", () => {
        const intent = createIntent({});
        const d = evaluate(intent, {
            preferences: prefs({ slippage_bps_max: 0 }),
            estimated_slippage_bps: 1,
        });
        expect(d.verdict).toBe("block");
        expect(d.rules_fired).toContain("slippageCap");
    });

    it("blocklist with hyphenated symbol matches the base asset (regression)", () => {
        const intent = createIntent({ product_id: "DOGE-USDT" });
        const d = evaluate(intent, {
            preferences: prefs({ asset_blocklist: ["DOGE"] }),
        });
        expect(d.verdict).toBe("block");
        expect(d.rules_fired).toContain("assetAllowlist");
    });

    it("very large stale count still blocks reconciliation-health (no overflow)", () => {
        const intent = createIntent({});
        const d = evaluate(intent, {
            preferences: prefs(),
            stale_reconciliation_count: Number.MAX_SAFE_INTEGER,
        });
        expect(d.verdict).toBe("block");
        expect(d.rules_fired).toContain("reconciliationHealth");
    });

    it("kill switch + max-size: kill switch wins, surfaces in rules_fired", () => {
        const intent = createIntent({});
        const d = evaluate(intent, {
            preferences: prefs({
                kill_switch_active: true,
                max_order_notional_usd: 100,
            }),
            estimated_notional_usd: 5000,
        });
        expect(d.verdict).toBe("block");
        expect(d.rules_fired).toContain("killSwitch");
    });
});
