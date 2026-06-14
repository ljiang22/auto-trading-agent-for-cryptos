import { elizaLogger } from "@elizaos/core";
import type { CanonicalIntent } from "../../intent/canonicalIntent";
import { buildCanonicalIntent } from "../../intent/intentBuilder";
import type { ExchangeName } from "../../types";
import type { RiskDecision, RiskEvaluationContext } from "../../risk/types";
import { DEFAULT_USER_TRADING_PREFERENCES } from "../../risk/types";
import { runStrategyOnce } from "../strategyRuntime";
import type { StrategyDSL } from "../strategyDSL";
import type { StrategyInstance, StrategyFill } from "./strategyInstance";
import { dayAnchor } from "./strategyInstance";
import type { StrategyInstanceStore } from "./strategyInstanceStore";
import type { SignalComputeResult } from "./signalCompute";
import { applyFill, unrealizedBps } from "./positionTracker";
import { deriveTrancheClientOrderId } from "./idempotency";

export interface FillResult {
  ok: boolean;
  client_order_id: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  error?: string;
}

export interface EngineDeps {
  store: StrategyInstanceStore;
  now: () => number;
  /** Wraps computeSignals() with the live market-data deps; mockable in tests. */
  computeSignals: (args: { dsl: StrategyDSL; symbol: string; nowMs: number; userId: string }) => Promise<SignalComputeResult>;
  runRisk: (intent: CanonicalIntent, ctx: RiskEvaluationContext) => RiskDecision;
  createOrder: (intent: CanonicalIntent) => Promise<FillResult>;
  notify: (userId: string, instance: StrategyInstance, fill: StrategyFill) => Promise<void>;
}

const RISK_BLOCK_PAUSE_THRESHOLD = Number(process.env.STRATEGY_ENGINE_RISK_BLOCK_PAUSE ?? 3);

export interface RunTickSummary {
  processed: number;
  fills: number;
  skipped: number;
  halted: number;
}

/** One idempotent pass over all armed, due instances. */
export async function runTick(deps: EngineDeps): Promise<RunTickSummary> {
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  const active = await deps.store.listActive();
  const summary: RunTickSummary = { processed: 0, fills: 0, skipped: 0, halted: 0 };

  for (const inst of active) {
    if (inst.status !== "armed") continue; // paused not traded
    if (Date.parse(inst.next_eval_at) > nowMs) continue; // not due
    summary.processed++;
    try {
      const outcome = await processInstance(inst, deps, nowMs, nowIso);
      summary.fills += outcome.filled ? 1 : 0;
      summary.skipped += outcome.skipped ? 1 : 0;
      summary.halted += outcome.halted ? 1 : 0;
    } catch (err) {
      inst.last_error = err instanceof Error ? err.message : String(err);
      inst.last_tick_at = nowIso;
      inst.next_eval_at = scheduleNext(inst.dsl, nowMs);
      await deps.store.put(inst);
      elizaLogger.error(`[strategy-engine] tick error instance=${inst.instance_id}: ${inst.last_error}`);
    }
  }
  return summary;
}

interface InstanceOutcome { filled: boolean; skipped: boolean; halted: boolean; }

async function processInstance(
  inst: StrategyInstance,
  deps: EngineDeps,
  nowMs: number,
  nowIso: string,
): Promise<InstanceOutcome> {
  // Daily-loss window rollover.
  const anchor = dayAnchor(nowMs);
  if (anchor !== inst.day_anchor) {
    inst.day_anchor = anchor;
    inst.day_realized_pnl_usd = 0;
  }

  const symbol = inst.dsl.universe.symbols[0];
  const sc = await deps.computeSignals({ dsl: inst.dsl, symbol, nowMs, userId: inst.user_id });

  // Freshness / missing gate — never fabricate a signal.
  if (!sc.context || !sc.fresh || sc.missing.length > 0) {
    inst.last_tick_at = nowIso;
    inst.tick_count += 1;
    inst.next_eval_at = scheduleNext(inst.dsl, nowMs);
    inst.last_error = !sc.context ? "no_market_data" : sc.missing.length ? `missing:${sc.missing.join(",")}` : "stale";
    await deps.store.put(inst);
    return { filled: false, skipped: true, halted: false };
  }
  inst.last_error = null;
  const mid = sc.context.midPrice;

  // 1) Engine-direct TP/SL (independent of the rule engine).
  let intent: CanonicalIntent | null = null;
  const tpSl = checkTpSl(inst, mid);
  if (tpSl) {
    intent = buildSellIntent(inst.dsl, inst.user_id, inst.position.base_qty);
  } else {
    // 2) Rule engine (paper-forced, runtime "running").
    const trigger = runStrategyOnce({
      strategy: inst.dsl,
      context: sc.context,
      userId: inst.user_id,
      locale: "en",
      modeOverride: "paper",
      runtimeStatus: "running",
    });
    if (trigger.kind !== "noop") intent = trigger.intent;
  }

  if (!intent) {
    inst.last_tick_at = nowIso;
    inst.tick_count += 1;
    inst.next_eval_at = scheduleNext(inst.dsl, nowMs);
    await deps.store.put(inst);
    return { filled: false, skipped: false, halted: false };
  }

  // Force paper (belt-and-suspenders) + salted idempotent id.
  intent.mode = "paper";
  intent.idempotency = {
    ...intent.idempotency,
    client_order_id: deriveTrancheClientOrderId(intent, `${inst.instance_id}:${inst.tick_count}`),
  };

  // Risk precheck with the strategy's risk.* as the envelope.
  const ctx = buildRiskContext(inst, mid, sc, nowMs);
  const decision = deps.runRisk(intent, ctx);
  if (decision.verdict !== "allow") {
    inst.consecutive_risk_blocks += 1;
    if (inst.consecutive_risk_blocks >= RISK_BLOCK_PAUSE_THRESHOLD) inst.status = "paused";
    inst.last_error = `risk_${decision.verdict}:${decision.rules_fired.join(",")}`;
    inst.last_tick_at = nowIso;
    inst.tick_count += 1;
    inst.next_eval_at = scheduleNext(inst.dsl, nowMs);
    await deps.store.put(inst);
    elizaLogger.info(`[strategy-engine] risk ${decision.verdict} instance=${inst.instance_id} rules=${decision.rules_fired.join(",")}`);
    return { filled: false, skipped: true, halted: false };
  }
  inst.consecutive_risk_blocks = 0;

  // Execute against the paper venue.
  const fill = await deps.createOrder(intent);
  if (!fill.ok) {
    inst.last_error = `order_failed:${fill.error ?? "unknown"}`;
    inst.last_tick_at = nowIso;
    inst.tick_count += 1;
    inst.next_eval_at = scheduleNext(inst.dsl, nowMs);
    await deps.store.put(inst);
    return { filled: false, skipped: true, halted: false };
  }

  // Update position + realized PnL.
  const { position, realizedDelta } = applyFill(inst.position, { side: fill.side, qty: fill.qty, price: fill.price });
  inst.position = position;
  inst.day_realized_pnl_usd += realizedDelta;
  const fillRow: StrategyFill = {
    client_order_id: fill.client_order_id, side: fill.side, qty: fill.qty, price: fill.price, ts: nowIso,
  };
  inst.fills.push(fillRow);
  inst.last_fill_at = nowIso;
  inst.tick_count += 1;
  inst.last_tick_at = nowIso;

  // Daily-loss auto-kill.
  let halted = false;
  const autoKill = inst.dsl.resilience?.auto_kill_on_loss_limit !== false;
  if (autoKill && inst.day_realized_pnl_usd <= -inst.dsl.risk.max_daily_loss_usd) {
    inst.status = "halted";
    inst.last_error = "daily_loss_limit";
    halted = true;
  }

  inst.next_eval_at = scheduleNext(inst.dsl, nowMs);
  await deps.store.put(inst);
  await deps.notify(inst.user_id, inst, fillRow);
  return { filled: true, skipped: false, halted };
}

/** Returns "tp" | "sl" if an open position has crossed its TP/SL threshold. */
function checkTpSl(inst: StrategyInstance, mid: number): "tp" | "sl" | null {
  if (inst.position.base_qty <= 0) return null;
  const bps = unrealizedBps(inst.position, mid);
  const tp = inst.dsl.risk.per_trade_take_profit_bps;
  const sl = inst.dsl.risk.per_trade_stop_loss_bps;
  if (tp !== undefined && bps >= tp) return "tp";
  if (sl !== undefined && bps <= -sl) return "sl";
  return null;
}

/** Build a market SELL of the full base position, mirroring strategyRuntime.ts:154-171. */
function buildSellIntent(dsl: StrategyDSL, userId: string, baseQty: number): CanonicalIntent {
  const venue = dsl.universe.venue as unknown as ExchangeName;
  const symbol = dsl.universe.symbols[0];
  return buildCanonicalIntent({
    action: "create_order",
    venue,
    userId,
    locale: "en",
    mode: "paper",
    params: {
      userId: userId as never,
      product_id: symbol,
      symbol,
      side: "SELL",
      order_configuration: { market_market_ioc: { base_size: baseQty.toFixed(8) } },
    },
    policyContext: {
      max_order_notional_usd: dsl.risk.max_position_notional_usd,
      daily_loss_limit_usd: dsl.risk.max_daily_loss_usd,
    },
  });
}

/** Risk envelope = the strategy's risk.* (NOT the user's global prefs). */
function buildRiskContext(
  inst: StrategyInstance,
  mid: number,
  sc: SignalComputeResult,
  nowMs: number,
): RiskEvaluationContext {
  const risk = inst.dsl.risk;
  return {
    preferences: {
      ...DEFAULT_USER_TRADING_PREFERENCES,
      userId: inst.user_id,
      max_order_notional_usd: risk.max_position_notional_usd,
      daily_loss_limit_usd: risk.max_daily_loss_usd,
      slippage_bps_max: risk.slippage_bps_max ?? DEFAULT_USER_TRADING_PREFERENCES.slippage_bps_max,
      default_mode: "paper",
      kill_switch_active: false,
      updatedAt: new Date(nowMs).toISOString(),
    },
    estimated_notional_usd: mid * inst.position.base_qty,
    market_mid_usd: mid,
    // The order price is the live mid (fetched fresh each tick); kline bar-age
    // staleness is gated separately in signalCompute via pause_on_market_data_lag_s.
    // Do NOT pass bar age here or the risk freshness rule blocks every hourly-bar order.
    market_data_age_ms: 0,
    rolling_24h_pnl_usd: inst.day_realized_pnl_usd,
    now_ms: nowMs,
  };
}

function scheduleNext(dsl: StrategyDSL, nowMs: number): string {
  const sec = Math.max(1, Number(dsl.operations.evaluation_interval_seconds ?? 30));
  return new Date(nowMs + sec * 1000).toISOString();
}
