import { describe, it, expect } from "vitest";
import { StrategyEngineService } from "../src/strategy/engine/strategyEngineService";

describe("StrategyEngineService", () => {
  it("exposes the STRATEGY_ENGINE serviceType", () => {
    expect(StrategyEngineService.serviceType).toBe("strategy_engine");
  });

  it("re-entrancy guard prevents overlapping ticks", async () => {
    const svc = new StrategyEngineService();
    let running = 0;
    let maxConcurrent = 0;
    (svc as any).deps = {}; // non-null so tick() runs runTickFn
    (svc as any).runTickFn = async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return { processed: 0, fills: 0, skipped: 0, halted: 0 };
    };
    await Promise.all([(svc as any).tick(), (svc as any).tick(), (svc as any).tick()]);
    expect(maxConcurrent).toBe(1);
  });

  it("stop() clears the interval and is idempotent", async () => {
    const svc = new StrategyEngineService();
    (svc as any).intervalHandle = setInterval(() => {}, 1000);
    await svc.stop();
    await svc.stop();
    expect((svc as any).intervalHandle).toBeNull();
  });
});
