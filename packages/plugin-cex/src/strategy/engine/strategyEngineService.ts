import { Service, ServiceType, type IAgentRuntime, type UUID, stringToUuid, elizaLogger } from "@elizaos/core";
import { fetchOhlcvBarsSafe } from "../../backtest/realDataSource";
import { fetchBinanceUsdtPrices } from "../../exchanges/services/binancePricing";
import { createPaperVenueForRuntime } from "../../actions/shared";
import { evaluate } from "../../risk/riskEngine";
import { computeSignals, type SignalComputeDeps } from "./signalCompute";
import { SqliteStrategyInstanceStore, type SqliteHandle } from "./sqliteStrategyInstanceStore";
import type { StrategyInstanceStore } from "./strategyInstanceStore";
import { runTick, type EngineDeps, type FillResult } from "./engineTick";
import { makeNotifier } from "./notifier";
import type { CanonicalIntent } from "../../intent/canonicalIntent";
import type { StrategyDSL } from "../strategyDSL";
import type { StrategyInstance } from "./strategyInstance";

const TICK_MS = Number(process.env.STRATEGY_ENGINE_TICK_MS ?? 15_000);

/** "paper" venue strategies fetch klines/mid from Binance public endpoints. */
function dataVenue(venue: string): "binance" | "coinbase" {
  return venue === "coinbase" ? "coinbase" : "binance";
}
function baseAsset(symbol: string): string {
  return symbol.replace(/USDT$|USDC$|USD$|-.*$/i, "") || symbol;
}

/** Halt all of a user's armed/paused instances (kill-switch). Returns the count halted. */
export async function haltUserInstances(
  store: StrategyInstanceStore,
  userId: string,
  nowMs: number,
): Promise<number> {
  const list = await store.list(userId);
  let n = 0;
  for (const inst of list) {
    if (inst.status === "armed" || inst.status === "paused") {
      inst.status = "halted";
      inst.last_error = "kill_switch";
      inst.last_tick_at = new Date(nowMs).toISOString();
      await store.put(inst);
      n++;
    }
  }
  return n;
}

export class StrategyEngineService extends Service {
  static get serviceType(): ServiceType {
    return ServiceType.STRATEGY_ENGINE;
  }

  private runtime: IAgentRuntime | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private deps: EngineDeps | null = null;
  // Test seam: overridable runTick.
  private runTickFn: (deps: EngineDeps) => Promise<unknown> = runTick as never;

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
  }

  /** Called from agent startup AFTER registration when the flag is on. */
  async start(): Promise<void> {
    if (!this.runtime) throw new Error("StrategyEngineService.start() before initialize()");
    const adapter = this.runtime.databaseAdapter as unknown as { db?: SqliteHandle };
    if (!adapter?.db) {
      elizaLogger.warn("[strategy-engine] no SQLite handle on databaseAdapter; engine disabled (Mongo store parity is a follow-up). Not starting.");
      return;
    }
    const store: StrategyInstanceStore = new SqliteStrategyInstanceStore(adapter.db);
    this.deps = this.buildDeps(this.runtime, store);

    const active = await store.listActive();
    elizaLogger.info(`[strategy-engine] starting: tick_ms=${TICK_MS} resumed_active=${active.length}`);
    this.intervalHandle = setInterval(() => void this.tick(), TICK_MS);
    if (this.intervalHandle.unref) this.intervalHandle.unref();
  }

  async stop(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Re-entrancy-guarded single pass. */
  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this.deps) await this.runTickFn(this.deps);
    } catch (err) {
      elizaLogger.error(`[strategy-engine] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  getStore(): StrategyInstanceStore | null {
    return this.deps?.store ?? null;
  }

  async armStrategy(userId: string, dsl: StrategyDSL): Promise<StrategyInstance> {
    if (!this.deps) throw new Error("strategy engine not started");
    const { armStrategyInstance } = await import("./arming");
    const instanceId = stringToUuid(`strategy-${userId}-${dsl.identity.id}`) as string;
    return armStrategyInstance(this.deps.store, { userId, dsl, nowMs: Date.now(), instanceId });
  }

  async setStatus(userId: string, instanceId: string, status: "paused" | "armed" | "stopped"): Promise<StrategyInstance | null> {
    if (!this.deps) return null;
    const inst = await this.deps.store.get(instanceId);
    if (!inst || inst.user_id !== userId) return null;
    inst.status = status;
    await this.deps.store.put(inst);
    return inst;
  }

  async listForUser(userId: string): Promise<StrategyInstance[]> {
    if (!this.deps) return [];
    return this.deps.store.list(userId);
  }

  async haltUser(userId: string): Promise<number> {
    if (!this.deps) return 0;
    return haltUserInstances(this.deps.store, userId, Date.now());
  }

  private buildDeps(runtime: IAgentRuntime, store: StrategyInstanceStore): EngineDeps {
    const signalDeps: SignalComputeDeps = {
      fetchKlines: ({ venue, symbol, intervalMs, count, endTs }) =>
        fetchOhlcvBarsSafe({ venue: dataVenue(venue), symbol, intervalMs, count, endTs }),
      fetchMid: async (_venue, symbol) => {
        const prices = await fetchBinanceUsdtPrices([symbol]);
        const v = prices[symbol.toUpperCase()];
        return typeof v === "number" ? v : null;
      },
      getEquityUsd: async (userId, venue) => {
        const paper = await createPaperVenueForRuntime(runtime, dataVenue(venue));
        const accounts = (paper as unknown as { accounts: { getBalance: (p: { userId: string }) => Promise<unknown> } }).accounts;
        const bal = (await accounts.getBalance({ userId })) as {
          accounts?: Array<{ asset: string; available: string }>;
        };
        let usd = 0;
        for (const a of bal.accounts ?? []) {
          const q = Number(a.available) || 0;
          if (/^USD[TC]?$/i.test(a.asset)) usd += q;
        }
        return usd > 0 ? usd : 10_000; // paper default starting equity
      },
      getSentiment: async (symbol) => {
        try {
          const mod = await import("@elizaos-plugins/plugin-sentiscore-analysis");
          return await mod.getLatestSentiment(baseAsset(symbol));
        } catch (err) {
          elizaLogger.warn(`[strategy-engine] sentiment fetch failed: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      },
    };

    const createOrder = async (intent: CanonicalIntent): Promise<FillResult> => {
      const paper = await createPaperVenueForRuntime(runtime, dataVenue(intent.venue as string));
      const params = intentToCreateParams(intent);
      const orders = (paper as unknown as { orders: { createOrder: (p: Record<string, unknown>) => Promise<unknown> } }).orders;
      const res = (await orders.createOrder(params)) as {
        success?: boolean;
        order?: { side?: string; quantity?: string | number; price?: string | number; filled_size?: string | number; average_filled_price?: string | number };
        error?: string;
      };
      const order = res?.order;
      if (!res?.success || !order) {
        return { ok: false, client_order_id: intent.idempotency.client_order_id, side: (intent.side as "BUY" | "SELL") ?? "BUY", qty: 0, price: 0, error: res?.error ?? "no_fill" };
      }
      const qty = Number(order.quantity ?? order.filled_size ?? 0);
      const price = Number(order.price ?? order.average_filled_price ?? 0);
      return {
        ok: true,
        client_order_id: intent.idempotency.client_order_id,
        side: (order.side as "BUY" | "SELL") ?? (intent.side as "BUY" | "SELL"),
        qty,
        price,
      };
    };

    const notify = makeNotifier(runtime, (userId) => stringToUuid(`strategy-room-${userId}`) as UUID);

    return {
      store,
      now: () => Date.now(),
      computeSignals: ({ dsl, symbol, nowMs, userId }) => computeSignals({ dsl, symbol, nowMs, userId, deps: signalDeps }),
      runRisk: (intent, ctx) => evaluate(intent, ctx),
      createOrder,
      notify,
    };
  }
}

/**
 * Project a CanonicalIntent to the paper venue's createOrder params.
 * Rebuilds order_configuration from order_type/size/price_params (no reliance
 * on raw_order_configuration). Verified against paperVenue.ts createOrder.
 */
function intentToCreateParams(intent: CanonicalIntent): Record<string, unknown> {
  const size = (intent.size ?? {}) as { base_size?: string; quote_size?: string };
  const order_configuration =
    intent.order_type === "limit"
      ? { limit_limit_gtc: { base_size: size.base_size, limit_price: intent.price_params?.limit_price } }
      : { market_market_ioc: { base_size: size.base_size, quote_size: size.quote_size } };
  return {
    userId: intent.user_id,
    product_id: intent.symbol,
    side: intent.side,
    order_configuration,
    client_order_id: intent.idempotency.client_order_id,
  };
}
