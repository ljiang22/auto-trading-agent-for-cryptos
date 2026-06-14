import { describe, it, expect } from "vitest";
import { computeSignals, type SignalComputeDeps } from "../src/strategy/engine/signalCompute";

const bar = (ts: number, close: number, high: number, volume: number) => ({
  timestamp: ts, open: close, high, low: close, close, volume,
});

// 25 ascending bars then one dip; enough for window=20 signals.
function fixtureBars(nowMs: number) {
  const bars = [];
  for (let k = 0; k < 25; k++) bars.push(bar(nowMs - (25 - k) * 60_000, 100 + k, 100 + k, 10));
  bars.push(bar(nowMs - 60_000, 95, 95, 100)); // last bar: dip + volume spike
  return bars;
}

function deps(over: Partial<SignalComputeDeps> = {}): SignalComputeDeps {
  return {
    fetchKlines: async () => fixtureBars(Date.parse("2026-06-14T12:00:00Z")),
    fetchMid: async () => 95,
    getEquityUsd: async () => 10_000,
    getSentiment: async () => ({ value: 0.5, ts: Date.parse("2026-06-14T11:59:00Z") }),
    ...over,
  };
}

const dsl = (signals: any[]) => ({
  universe: { venue: "paper", symbols: ["BTCUSDT"] },
  signals,
  resilience: { pause_on_market_data_lag_s: 600 },
}) as any;

const now = Date.parse("2026-06-14T12:00:00Z");

describe("computeSignals", () => {
  it("computes pct_from_high and volume.zscore keyed by signal id", async () => {
    const res = await computeSignals({
      dsl: dsl([
        { id: "dip", kind: "price.pct_from_high", params: { window: 20 } },
        { id: "volz", kind: "volume.zscore", params: { window: 20 } },
      ]),
      symbol: "BTCUSDT",
      nowMs: now,
      deps: deps(),
    });
    expect(res.context).not.toBeNull();
    expect(res.context!.signals.dip).toBeLessThan(0);   // last bar is below the rolling high
    expect(res.context!.signals.volz).toBeGreaterThan(1); // volume spike
    expect(res.context!.equityUsd).toBe(10_000);
    expect(res.context!.midPrice).toBe(95);
    expect(res.missing).toEqual([]);
  });

  it("computes sentiment.score from getSentiment", async () => {
    const res = await computeSignals({
      dsl: dsl([{ id: "sent", kind: "sentiment.score", params: {} }]),
      symbol: "BTCUSDT", nowMs: now, deps: deps(),
    });
    expect(res.context!.signals.sent).toBe(0.5);
  });

  it("marks sentiment missing when unavailable (no context fabrication)", async () => {
    const res = await computeSignals({
      dsl: dsl([{ id: "sent", kind: "sentiment.score", params: {} }]),
      symbol: "BTCUSDT", nowMs: now, deps: deps({ getSentiment: async () => null }),
    });
    expect(res.missing).toContain("sent");
  });

  it("marks fresh=false when the last bar is older than the lag budget", async () => {
    const stale = fixtureBars(now - 3_600_000); // last bar ~1h old
    const res = await computeSignals({
      dsl: { ...dsl([{ id: "r", kind: "price.rsi", params: { period: 14 } }]), resilience: { pause_on_market_data_lag_s: 60 } },
      symbol: "BTCUSDT", nowMs: now, deps: deps({ fetchKlines: async () => stale }),
    });
    expect(res.fresh).toBe(false);
  });

  it("returns null context when klines are unavailable", async () => {
    const res = await computeSignals({
      dsl: dsl([{ id: "r", kind: "price.rsi", params: {} }]),
      symbol: "BTCUSDT", nowMs: now, deps: deps({ fetchKlines: async () => null }),
    });
    expect(res.context).toBeNull();
    expect(res.fresh).toBe(false);
  });
});
