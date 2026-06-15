import type { StrategyPosition } from "./strategyInstance";

export interface FillInput {
  side: "BUY" | "SELL";
  qty: number;
  price: number;
}

export interface ApplyFillResult {
  position: StrategyPosition;
  realizedDelta: number; // USD realized by this fill (SELL only; 0 for BUY)
}

/** Long-only position math (paper). SELL realizes PnL; BUY blends avg entry. */
export function applyFill(prev: StrategyPosition, fill: FillInput): ApplyFillResult {
  if (fill.side === "BUY") {
    const newQty = prev.base_qty + fill.qty;
    const avg =
      newQty > 0
        ? (prev.base_qty * prev.avg_entry_price + fill.qty * fill.price) / newQty
        : 0;
    return {
      position: { base_qty: newQty, avg_entry_price: avg, realized_pnl_usd: prev.realized_pnl_usd },
      realizedDelta: 0,
    };
  }
  // SELL
  const closed = Math.min(fill.qty, prev.base_qty);
  const realizedDelta = (fill.price - prev.avg_entry_price) * closed;
  const newQty = Math.max(0, prev.base_qty - fill.qty);
  return {
    position: {
      base_qty: newQty,
      avg_entry_price: newQty > 0 ? prev.avg_entry_price : 0,
      realized_pnl_usd: prev.realized_pnl_usd + realizedDelta,
    },
    realizedDelta,
  };
}

/** Unrealized PnL in bps vs the average entry, given the current mid. 0 if flat. */
export function unrealizedBps(pos: StrategyPosition, mid: number): number {
  if (pos.base_qty <= 0 || pos.avg_entry_price <= 0) return 0;
  return ((mid - pos.avg_entry_price) / pos.avg_entry_price) * 10_000;
}
