import { describe, it, expect } from "vitest";
import { InMemoryStrategyInstanceStore } from "../src/strategy/engine/strategyInstanceStore";
import { newArmedInstance } from "../src/strategy/engine/strategyInstance";

const dsl = { identity: { id: "s1" } } as any;
const mk = (id: string, user: string, status: any = "armed") => {
  const i = newArmedInstance({ instance_id: id, user_id: user, dsl, nowMs: 0 });
  i.status = status;
  return i;
};

describe("InMemoryStrategyInstanceStore", () => {
  it("put/get round-trips a deep copy (no aliasing)", async () => {
    const store = new InMemoryStrategyInstanceStore();
    const inst = mk("i1", "u1");
    await store.put(inst);
    const got = await store.get("i1");
    expect(got).toEqual(inst);
    got!.tick_count = 99;
    const again = await store.get("i1");
    expect(again!.tick_count).toBe(0); // mutation of returned copy must not leak
  });

  it("get returns null for missing id", async () => {
    const store = new InMemoryStrategyInstanceStore();
    expect(await store.get("nope")).toBeNull();
  });

  it("list returns only a user's instances", async () => {
    const store = new InMemoryStrategyInstanceStore();
    await store.put(mk("i1", "u1"));
    await store.put(mk("i2", "u1"));
    await store.put(mk("i3", "u2"));
    const u1 = await store.list("u1");
    expect(u1.map((i) => i.instance_id).sort()).toEqual(["i1", "i2"]);
  });

  it("listActive returns armed + paused, not stopped/halted", async () => {
    const store = new InMemoryStrategyInstanceStore();
    await store.put(mk("a", "u1", "armed"));
    await store.put(mk("p", "u1", "paused"));
    await store.put(mk("s", "u1", "stopped"));
    await store.put(mk("h", "u1", "halted"));
    const active = await store.listActive();
    expect(active.map((i) => i.instance_id).sort()).toEqual(["a", "p"]);
  });

  it("delete removes an instance", async () => {
    const store = new InMemoryStrategyInstanceStore();
    await store.put(mk("i1", "u1"));
    await store.delete("i1");
    expect(await store.get("i1")).toBeNull();
  });
});
