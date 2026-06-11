import { describe, expect, it } from "vitest";

import { coerceStrategy } from "../src/actions/runBacktest";

describe("run_backtest coerceStrategy — NL source selection", () => {
    it("prefers the decomposer's `description` parameter over the message text (plan-executor path)", () => {
        // In the plan path the synthetic memory carries the user's CURRENT message — for a batch
        // approval that's "Yes, approve all remaining steps.", which describes no strategy. The
        // decomposer's parameters.description holds the actual strategy NL.
        const r = coerceStrategy(
            { description: "Hybrid DCA modified: buy $300 now, $300 if BTC -5%, $200 if BTC -10%, hold $200 reserve" },
            "Yes, approve all remaining steps.",
            "user-1",
        );
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.strategy.identity.id).toContain("dca");
            // The heuristic compiler approximates (a time-based DCA template for a price-drop
            // ladder) — the caller MUST know so the report can disclose the substitution instead
            // of silently presenting a different strategy than the user described.
            expect(r.derivedByHeuristic).toBe(true);
        }
    });

    it("does not flag heuristic derivation for an explicit DSL strategy object", () => {
        const dsl = {
            identity: { id: "x", version: 1, owner: "u", status: "draft", mode: "paper", name: "X" },
            universe: { venue: "binance", symbols: ["BTC-USDT"] },
            signals: [{ id: "rsi14", kind: "price.rsi", params: { period: 14 } }],
            entries: [{ id: "e", when: { op: "lt", args: ["rsi14", 30] }, then: { order_type: "limit", side: "BUY", sizing: { kind: "pct_equity", value: 10 }, time_in_force: "GTC" } }],
            exits: [{ id: "x1", when: { op: "gt", args: ["rsi14", 70] }, then: { order_type: "limit", side: "SELL", sizing: { kind: "pct_equity", value: 100 }, time_in_force: "GTC" } }],
            risk: { max_position_notional_usd: 1000, max_daily_loss_usd: 100, max_concurrent_positions: 1, slippage_bps_max: 50 },
            operations: { evaluation_interval_seconds: 3600, persistent: true, halt_on_error: true },
            resilience: { auto_kill_on_loss_limit: true, pause_on_stale_orders: 3, pause_on_market_data_lag_s: 30 },
        };
        const r = coerceStrategy({ strategy: dsl }, "irrelevant", "user-1");
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.derivedByHeuristic).toBe(false);
    });

    it("falls back to the message text when no description param is present", () => {
        const r = coerceStrategy({}, "backtest DCA $50 BTC weekly", "user-1");
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.strategy.identity.id).toContain("dca");
    });

    it("still fails with the clarification when neither source describes a strategy", () => {
        const r = coerceStrategy({}, "Yes, approve all remaining steps.", "user-1");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/classify/i);
    });
});
