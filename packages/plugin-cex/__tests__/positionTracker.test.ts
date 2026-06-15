import { describe, it, expect } from "vitest";
import { applyFill, unrealizedBps } from "../src/strategy/engine/positionTracker";

const flat = { base_qty: 0, avg_entry_price: 0, realized_pnl_usd: 0 };

describe("applyFill", () => {
  it("a BUY opens a position at the fill price", () => {
    const { position, realizedDelta } = applyFill(flat, { side: "BUY", qty: 2, price: 100 });
    expect(position).toEqual({ base_qty: 2, avg_entry_price: 100, realized_pnl_usd: 0 });
    expect(realizedDelta).toBe(0);
  });

  it("a second BUY blends the average entry", () => {
    const after1 = applyFill(flat, { side: "BUY", qty: 2, price: 100 }).position;
    const { position } = applyFill(after1, { side: "BUY", qty: 2, price: 200 });
    expect(position.base_qty).toBe(4);
    expect(position.avg_entry_price).toBeCloseTo(150, 6);
  });

  it("a SELL realizes PnL against the average entry", () => {
    const open = applyFill(flat, { side: "BUY", qty: 2, price: 100 }).position;
    const { position, realizedDelta } = applyFill(open, { side: "SELL", qty: 2, price: 120 });
    expect(realizedDelta).toBeCloseTo(40, 6); // (120-100)*2
    expect(position.base_qty).toBe(0);
    expect(position.realized_pnl_usd).toBeCloseTo(40, 6);
  });

  it("a partial SELL realizes proportional PnL and keeps the average entry", () => {
    const open = applyFill(flat, { side: "BUY", qty: 4, price: 100 }).position;
    const { position, realizedDelta } = applyFill(open, { side: "SELL", qty: 1, price: 110 });
    expect(realizedDelta).toBeCloseTo(10, 6);
    expect(position.base_qty).toBe(3);
    expect(position.avg_entry_price).toBe(100);
  });
});

describe("unrealizedBps", () => {
  it("is positive when mid is above entry", () => {
    expect(unrealizedBps({ base_qty: 1, avg_entry_price: 100, realized_pnl_usd: 0 }, 105)).toBeCloseTo(500, 6);
  });
  it("is 0 for a flat position", () => {
    expect(unrealizedBps(flat, 105)).toBe(0);
  });
});
