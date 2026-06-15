import type { OhlcvBar } from "../../backtest/types";
import { sma, ema, rsi, atr, volumeZScore, pctFromHigh } from "../../backtest/indicators";
import type { StrategyDSL } from "../strategyDSL";

/** The exact context shape runStrategyOnce consumes (strategyRuntime.ts). */
export interface StrategyEvaluationContext {
  signals: { [signalId: string]: number };
  equityUsd: number;
  midPrice: number;
}

export interface SignalComputeDeps {
  fetchKlines: (args: {
    venue: string;
    symbol: string;
    intervalMs: number;
    count: number;
    endTs: number;
  }) => Promise<OhlcvBar[] | null>;
  fetchMid: (venue: string, symbol: string) => Promise<number | null>;
  getEquityUsd: (userId: string, venue: string) => Promise<number>;
  getSentiment: (symbol: string, asOfMs: number) => Promise<{ value: number; ts: number } | null>;
}

export interface SignalComputeResult {
  context: StrategyEvaluationContext | null;
  fresh: boolean;
  ageMs: number;
  missing: string[];
}

const DEFAULT_BAR_INTERVAL_MS = Number(process.env.STRATEGY_ENGINE_BAR_INTERVAL_MS ?? 3_600_000);

/** Bars needed to satisfy the longest-window signal in the DSL (+ buffer). */
function requiredBarCount(dsl: StrategyDSL): number {
  let maxWin = 50;
  for (const s of dsl.signals) {
    const p = s.params as Record<string, number>;
    maxWin = Math.max(
      maxWin,
      Number(p.period ?? 0),
      Number(p.window ?? 0),
      Number(p.fast ?? 0),
      Number(p.slow ?? 0),
    );
  }
  return Math.min(1000, maxWin + 5);
}

export async function computeSignals(args: {
  dsl: StrategyDSL;
  symbol: string;
  nowMs: number;
  userId?: string;
  deps: SignalComputeDeps;
}): Promise<SignalComputeResult> {
  const { dsl, symbol, nowMs, deps } = args;
  const venue = dsl.universe.venue;
  const needsBars = dsl.signals.some((s) => s.kind !== "sentiment.score");

  let bars: OhlcvBar[] | null = null;
  if (needsBars) {
    bars = await deps.fetchKlines({
      venue,
      symbol,
      intervalMs: DEFAULT_BAR_INTERVAL_MS,
      count: requiredBarCount(dsl),
      endTs: nowMs,
    });
    if (!bars || bars.length === 0) {
      return { context: null, fresh: false, ageMs: Number.POSITIVE_INFINITY, missing: [] };
    }
  }

  const last = bars ? bars.length - 1 : -1;
  const signals: { [id: string]: number } = {};
  const missing: string[] = [];

  for (const sig of dsl.signals) {
    const p = sig.params as Record<string, number>;
    let value: number = Number.NaN;
    switch (sig.kind) {
      case "price.rsi":
        value = rsi(bars!, last, Number(p.period ?? 14));
        break;
      case "price.sma_cross":
        value = sma(bars!, last, Number(p.fast ?? 20)) - sma(bars!, last, Number(p.slow ?? 50));
        break;
      case "price.ema_cross":
        value = ema(bars!, last, Number(p.fast ?? 12)) - ema(bars!, last, Number(p.slow ?? 26));
        break;
      case "price.atr_band": {
        const period = Number(p.period ?? 14);
        const a = atr(bars!, last, period);
        const m = sma(bars!, last, period);
        value = a === 0 ? Number.NaN : (bars![last].close - m) / a;
        break;
      }
      case "volume.zscore":
        value = volumeZScore(bars!, last, Number(p.window ?? 20));
        break;
      case "price.pct_from_high":
        value = pctFromHigh(bars!, last, Number(p.window ?? 20));
        break;
      case "sentiment.score": {
        const s = await deps.getSentiment(symbol, nowMs);
        value = s ? s.value : Number.NaN;
        break;
      }
      default:
        value = Number.NaN;
    }
    if (Number.isNaN(value)) {
      missing.push(sig.id);
    } else {
      signals[sig.id] = value;
    }
  }

  // midPrice + equity (always needed for sizing / risk).
  const midRaw = await deps.fetchMid(venue, symbol);
  const midPrice = midRaw ?? (bars ? bars[last].close : 0);
  const equityUsd = await deps.getEquityUsd(args.userId ?? "", venue);

  // Freshness from the last bar. A kline bar is inherently up to one interval
  // old (the current bar is still forming), so the budget is ONE bar interval
  // PLUS the configured real-time lag tolerance. Using only pause_on_market_data_lag_s
  // (default 30s) would mark every hourly-bar strategy permanently stale and it
  // would never trade. Sentiment-only strategies have no bars and are "fresh".
  const lagBudgetMs = Number(dsl.resilience?.pause_on_market_data_lag_s ?? 30) * 1000;
  const ageMs = bars ? nowMs - bars[last].timestamp : 0;
  const fresh = !bars || ageMs <= DEFAULT_BAR_INTERVAL_MS + lagBudgetMs;

  return {
    context: { signals, equityUsd, midPrice },
    fresh,
    ageMs,
    missing,
  };
}
