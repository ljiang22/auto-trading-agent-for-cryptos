import type { StrategyDSL } from "../strategyDSL";

export type StrategyInstanceStatus = "armed" | "paused" | "stopped" | "halted";

export interface StrategyPosition {
  base_qty: number;
  avg_entry_price: number;
  realized_pnl_usd: number;
}

export interface StrategyFill {
  client_order_id: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  ts: string; // ISO
}

export interface StrategyInstance {
  instance_id: string;
  user_id: string;
  dsl: StrategyDSL;
  status: StrategyInstanceStatus;
  position: StrategyPosition;
  day_realized_pnl_usd: number;
  day_anchor: string; // YYYY-MM-DD
  last_tick_at: string | null;
  next_eval_at: string; // ISO
  last_fill_at: string | null;
  fills: StrategyFill[];
  tick_count: number;
  consecutive_risk_blocks: number;
  last_error: string | null;
}

/** UTC YYYY-MM-DD for a millisecond timestamp. Used for the daily-loss window anchor. */
export function dayAnchor(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** A freshly-armed instance with a zeroed position, due immediately. */
export function newArmedInstance(args: {
  instance_id: string;
  user_id: string;
  dsl: StrategyDSL;
  nowMs: number;
}): StrategyInstance {
  return {
    instance_id: args.instance_id,
    user_id: args.user_id,
    dsl: args.dsl,
    status: "armed",
    position: { base_qty: 0, avg_entry_price: 0, realized_pnl_usd: 0 },
    day_realized_pnl_usd: 0,
    day_anchor: dayAnchor(args.nowMs),
    last_tick_at: null,
    next_eval_at: new Date(args.nowMs).toISOString(),
    last_fill_at: null,
    fills: [],
    tick_count: 0,
    consecutive_risk_blocks: 0,
    last_error: null,
  };
}
