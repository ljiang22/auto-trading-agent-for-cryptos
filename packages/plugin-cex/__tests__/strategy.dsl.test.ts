import { describe, expect, it } from "vitest";

import {
    parseStrategyDSL,
    summarizeStrategy,
    tryParseStrategyDSL,
    type StrategyDSL,
} from "../src/strategy/strategyDSL";

const VALID_STRATEGY: StrategyDSL = {
    identity: {
        id: "rsi-meanrevert-btc",
        version: 1,
        owner: "user-1",
        status: "draft",
        mode: "paper",
        name: "RSI Mean Revert",
    },
    universe: { venue: "binance", symbols: ["BTCUSDT"] },
    signals: [{ id: "rsi14", kind: "price.rsi", params: { period: 14 } }],
    entries: [
        {
            id: "long_entry",
            when: { op: "lt", args: ["rsi14", 30] },
            then: {
                order_type: "limit",
                side: "BUY",
                sizing: { kind: "pct_equity", value: 10 },
                limit_offset_bps: 5,
                time_in_force: "GTC",
            },
        },
    ],
    exits: [
        {
            id: "long_exit",
            when: { op: "gt", args: ["rsi14", 70] },
            then: {
                order_type: "limit",
                side: "SELL",
                sizing: { kind: "pct_equity", value: 100 },
                time_in_force: "GTC",
            },
        },
    ],
    risk: {
        max_position_notional_usd: 1000,
        max_daily_loss_usd: 100,
        max_concurrent_positions: 1,
        slippage_bps_max: 50,
    },
    operations: {
        evaluation_interval_seconds: 60,
        persistent: true,
        halt_on_error: true,
    },
    resilience: {
        auto_kill_on_loss_limit: true,
        pause_on_stale_orders: 3,
        pause_on_market_data_lag_s: 30,
    },
};

describe("Strategy DSL schema", () => {
    it("accepts a valid strategy", () => {
        const parsed = parseStrategyDSL(VALID_STRATEGY);
        expect(parsed.identity.id).toBe("rsi-meanrevert-btc");
    });

    it("rejects missing required identity", () => {
        const r = tryParseStrategyDSL({ ...VALID_STRATEGY, identity: undefined });
        expect(r.ok).toBe(false);
    });

    it("rejects empty entries array", () => {
        const r = tryParseStrategyDSL({
            ...VALID_STRATEGY,
            entries: [],
        });
        expect(r.ok).toBe(false);
    });

    it("rejects empty symbols array", () => {
        const r = tryParseStrategyDSL({
            ...VALID_STRATEGY,
            universe: { venue: "binance", symbols: [] },
        });
        expect(r.ok).toBe(false);
    });

    it("summarizeStrategy produces a one-line summary", () => {
        const s = summarizeStrategy(VALID_STRATEGY);
        expect(s).toContain("RSI Mean Revert");
        expect(s).toContain("BTCUSDT");
    });
});
