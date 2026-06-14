import { describe, it, expect } from "vitest";
import { runTick, type EngineDeps } from "../src/strategy/engine/engineTick";
import { InMemoryStrategyInstanceStore } from "../src/strategy/engine/strategyInstanceStore";
import { newArmedInstance } from "../src/strategy/engine/strategyInstance";

const NOW = Date.parse("2026-06-14T12:00:00Z");

function makeDsl(over: any = {}) {
  return {
    identity: { id: "s1", version: 1, owner: "u1", status: "paper", mode: "paper" },
    universe: { venue: "paper", symbols: ["BTCUSDT"] },
    signals: [{ id: "dip", kind: "price.pct_from_high", params: { window: 20 } }],
    entries: [{ id: "e1", when: { op: "lt", args: ["dip", -5] }, then: { order_type: "market", side: "BUY", sizing: { kind: "quote_size", value: 100 } } }],
    exits: [{ id: "x1", when: { op: "gt", args: ["dip", 100] }, then: { order_type: "market", side: "SELL", sizing: { kind: "pct_equity", value: 100 } } }],
    risk: { max_position_notional_usd: 10_000, max_daily_loss_usd: 50, max_concurrent_positions: 1, per_trade_take_profit_bps: 300, per_trade_stop_loss_bps: 200, slippage_bps_max: 50 },
    operations: { evaluation_interval_seconds: 30, persistent: true, halt_on_error: true },
    resilience: { auto_kill_on_loss_limit: true, pause_on_stale_orders: 3, pause_on_market_data_lag_s: 600 },
    ...over,
  } as any;
}

function harness(opts: {
  signalValue: number;
  mid?: number;
  fresh?: boolean;
  missing?: string[];
  riskVerdict?: "allow" | "block";
  fill?: { qty: number; price: number };
}) {
  const store = new InMemoryStrategyInstanceStore();
  const calls: any = { created: [], notified: [], risk: 0 };
  const deps: EngineDeps = {
    store,
    now: () => NOW,
    computeSignals: async () => ({
      context: opts.missing && opts.missing.length
        ? null
        : { signals: { dip: opts.signalValue }, equityUsd: 10_000, midPrice: opts.mid ?? 100 },
      fresh: opts.fresh ?? true,
      ageMs: 0,
      missing: opts.missing ?? [],
    }),
    runRisk: () => {
      calls.risk++;
      return { verdict: opts.riskVerdict ?? "allow", rules_fired: [], explanations: [], rule_results: [] } as any;
    },
    createOrder: async (intent: any) => {
      calls.created.push(intent.idempotency.client_order_id);
      const f = opts.fill ?? { qty: 1, price: opts.mid ?? 100 };
      return { ok: true, client_order_id: intent.idempotency.client_order_id, side: intent.side, qty: f.qty, price: f.price };
    },
    notify: async (_u, _i, fill) => { calls.notified.push(fill); },
  };
  return { store, deps, calls };
}

async function seed(store: InMemoryStrategyInstanceStore, dsl: any, over: any = {}) {
  const inst = newArmedInstance({ instance_id: "i1", user_id: "u1", dsl, nowMs: NOW - 1000 });
  Object.assign(inst, over);
  await store.put(inst);
  return inst;
}

describe("runTick", () => {
  it("no-op when no rule fires and no position (no order)", async () => {
    const { store, deps, calls } = harness({ signalValue: 0 });
    await seed(store, makeDsl());
    await runTick(deps);
    expect(calls.created).toEqual([]);
    expect((await store.get("i1"))!.tick_count).toBe(1);
  });

  it("entry fires when the dip rule matches", async () => {
    const { store, deps, calls } = harness({ signalValue: -6, mid: 100, fill: { qty: 1, price: 100 } });
    await seed(store, makeDsl());
    await runTick(deps);
    expect(calls.created.length).toBe(1);
    const inst = await store.get("i1");
    expect(inst!.position.base_qty).toBe(1);
    expect(inst!.fills.length).toBe(1);
  });

  it("skips the tick when a required signal is missing (no fabrication)", async () => {
    const { store, deps, calls } = harness({ signalValue: -6, missing: ["dip"] });
    await seed(store, makeDsl());
    await runTick(deps);
    expect(calls.created).toEqual([]);
    expect(calls.risk).toBe(0);
  });

  it("skips the tick when market data is stale", async () => {
    const { store, deps, calls } = harness({ signalValue: -6, fresh: false });
    await seed(store, makeDsl());
    await runTick(deps);
    expect(calls.created).toEqual([]);
  });

  it("paused instances are not processed", async () => {
    const { store, deps, calls } = harness({ signalValue: -6 });
    await seed(store, makeDsl(), { status: "paused" });
    await runTick(deps);
    expect(calls.created).toEqual([]);
  });

  it("risk block skips the order and increments the block counter; threshold pauses", async () => {
    const { store, deps, calls } = harness({ signalValue: -6, riskVerdict: "block" });
    await seed(store, makeDsl(), { consecutive_risk_blocks: 2 });
    await runTick(deps);
    expect(calls.created).toEqual([]);
    expect((await store.get("i1"))!.status).toBe("paused");
  });

  it("TP hit exits an open position", async () => {
    const { store, deps, calls } = harness({ signalValue: 0, mid: 105, fill: { qty: 1, price: 105 } });
    await seed(store, makeDsl(), { position: { base_qty: 1, avg_entry_price: 100, realized_pnl_usd: 0 } });
    await runTick(deps);
    expect(calls.created.length).toBe(1);
    expect((await store.get("i1"))!.position.base_qty).toBe(0);
  });

  it("SL hit exits an open position", async () => {
    const { store, deps, calls } = harness({ signalValue: 0, mid: 97, fill: { qty: 1, price: 97 } });
    await seed(store, makeDsl(), { position: { base_qty: 1, avg_entry_price: 100, realized_pnl_usd: 0 } });
    await runTick(deps);
    expect(calls.created.length).toBe(1);
    expect((await store.get("i1"))!.position.base_qty).toBe(0);
  });

  it("daily loss limit halts the instance after a realized loss", async () => {
    const { store, deps } = harness({ signalValue: 0, mid: 50, fill: { qty: 1, price: 50 } });
    await seed(store, makeDsl(), { position: { base_qty: 1, avg_entry_price: 100, realized_pnl_usd: 0 } });
    await runTick(deps);
    const inst = await store.get("i1");
    expect(inst!.position.realized_pnl_usd).toBeLessThanOrEqual(-50);
    expect(inst!.status).toBe("halted");
  });

  it("reschedules next_eval_at by evaluation_interval_seconds", async () => {
    const { store, deps } = harness({ signalValue: 0 });
    await seed(store, makeDsl());
    await runTick(deps);
    expect((await store.get("i1"))!.next_eval_at).toBe(new Date(NOW + 30_000).toISOString());
  });

  it("not-due instances are skipped", async () => {
    const { store, deps, calls } = harness({ signalValue: -6 });
    await seed(store, makeDsl(), { next_eval_at: new Date(NOW + 60_000).toISOString() });
    await runTick(deps);
    expect(calls.created).toEqual([]);
  });
});
