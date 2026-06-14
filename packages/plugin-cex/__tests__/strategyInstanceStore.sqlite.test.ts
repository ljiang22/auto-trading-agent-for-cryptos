import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  SqliteStrategyInstanceStore,
  STRATEGY_INSTANCES_DDL,
} from "../src/strategy/engine/sqliteStrategyInstanceStore";
import { newArmedInstance } from "../src/strategy/engine/strategyInstance";

const dsl = { identity: { id: "s1" } } as any;
const mk = (id: string, user: string, status: any = "armed") => {
  const i = newArmedInstance({ instance_id: id, user_id: user, dsl, nowMs: 0 });
  i.status = status;
  return i;
};

describe("SqliteStrategyInstanceStore", () => {
  let db: Database.Database;
  let store: SqliteStrategyInstanceStore;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(STRATEGY_INSTANCES_DDL);
    store = new SqliteStrategyInstanceStore(db);
  });

  it("put then get round-trips the full instance", async () => {
    const inst = mk("i1", "u1");
    inst.fills.push({ client_order_id: "px-abc", side: "BUY", qty: 1, price: 100, ts: "t" });
    await store.put(inst);
    expect(await store.get("i1")).toEqual(inst);
  });

  it("put is an upsert (second put overwrites)", async () => {
    const inst = mk("i1", "u1");
    await store.put(inst);
    inst.tick_count = 5;
    await store.put(inst);
    expect((await store.get("i1"))!.tick_count).toBe(5);
  });

  it("listActive returns armed+paused only", async () => {
    await store.put(mk("a", "u1", "armed"));
    await store.put(mk("p", "u1", "paused"));
    await store.put(mk("s", "u1", "stopped"));
    const active = await store.listActive();
    expect(active.map((i) => i.instance_id).sort()).toEqual(["a", "p"]);
  });

  it("list filters by user, delete removes", async () => {
    await store.put(mk("i1", "u1"));
    await store.put(mk("i2", "u2"));
    expect((await store.list("u1")).map((i) => i.instance_id)).toEqual(["i1"]);
    await store.delete("i1");
    expect(await store.get("i1")).toBeNull();
  });
});
