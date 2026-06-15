import { describe, it, expect } from "vitest";
import { strategyDSLSchema } from "../src/strategy/strategyDSL";

const base = {
  identity: { id: "s1", version: 1, owner: "u1", status: "paper", mode: "paper" },
  universe: { venue: "paper", symbols: ["BTCUSDT"] },
  signals: [{ id: "dip", kind: "price.pct_from_high", params: { window: 20 } }],
  entries: [{ id: "e1", when: { op: "lt", args: ["dip", -5] }, then: { order_type: "market", side: "BUY", sizing: { kind: "pct_equity", value: 10 } } }],
  exits: [{ id: "x1", when: { op: "gt", args: ["dip", 0] }, then: { order_type: "market", side: "SELL", sizing: { kind: "pct_equity", value: 100 } } }],
  risk: { max_position_notional_usd: 1000, max_daily_loss_usd: 200, max_concurrent_positions: 1 },
  operations: { evaluation_interval_seconds: 30 },
  resilience: {},
};

describe("strategyDSL price.pct_from_high", () => {
  it("accepts the new signal kind", () => {
    const parsed = strategyDSLSchema.parse(base);
    expect(parsed.signals[0].kind).toBe("price.pct_from_high");
  });
});
