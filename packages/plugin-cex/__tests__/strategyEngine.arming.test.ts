import { describe, it, expect } from "vitest";
import { forcePaper, armStrategyInstance } from "../src/strategy/engine/arming";
import { InMemoryStrategyInstanceStore } from "../src/strategy/engine/strategyInstanceStore";

const liveDsl = () => ({
  identity: { id: "s1", version: 1, owner: "u1", status: "live", mode: "live" },
  universe: { venue: "binance", symbols: ["BTCUSDT"] },
  signals: [], entries: [], exits: [],
  risk: { max_position_notional_usd: 1000, max_daily_loss_usd: 200, max_concurrent_positions: 1 },
  operations: { evaluation_interval_seconds: 30 }, resilience: {},
}) as any;

describe("arming", () => {
  it("forcePaper downgrades mode + status to paper without mutating the input", () => {
    const dsl = liveDsl();
    const paper = forcePaper(dsl);
    expect(paper.identity.mode).toBe("paper");
    expect(paper.identity.status).toBe("paper");
    expect(dsl.identity.mode).toBe("live"); // original untouched
  });

  it("armStrategyInstance forces paper, persists armed, due now", async () => {
    const store = new InMemoryStrategyInstanceStore();
    const inst = await armStrategyInstance(store, { userId: "u1", dsl: liveDsl(), nowMs: 1000, instanceId: "i1" });
    expect(inst.status).toBe("armed");
    expect(inst.dsl.identity.mode).toBe("paper");
    expect((await store.get("i1"))!.status).toBe("armed");
  });
});
