import { describe, it, expect } from "vitest";
import { haltUserInstances } from "../src/strategy/engine/strategyEngineService";
import { InMemoryStrategyInstanceStore } from "../src/strategy/engine/strategyInstanceStore";
import { newArmedInstance } from "../src/strategy/engine/strategyInstance";

describe("haltUserInstances", () => {
  it("halts armed + paused instances for the user only", async () => {
    const store = new InMemoryStrategyInstanceStore();
    const a = newArmedInstance({ instance_id: "a", user_id: "u1", dsl: { universe: { symbols: ["X"] } } as any, nowMs: 0 });
    const p = newArmedInstance({ instance_id: "p", user_id: "u1", dsl: {} as any, nowMs: 0 }); p.status = "paused";
    const other = newArmedInstance({ instance_id: "o", user_id: "u2", dsl: {} as any, nowMs: 0 });
    await store.put(a); await store.put(p); await store.put(other);

    const count = await haltUserInstances(store, "u1", 1000);
    expect(count).toBe(2);
    expect((await store.get("a"))!.status).toBe("halted");
    expect((await store.get("p"))!.status).toBe("halted");
    expect((await store.get("o"))!.status).toBe("armed");
  });
});
