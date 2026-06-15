import { describe, it, expect } from "vitest";
import { dayAnchor, newArmedInstance } from "../src/strategy/engine/strategyInstance";

const FAKE_DSL = { identity: { id: "s1" } } as any;

describe("strategyInstance", () => {
  it("dayAnchor returns the UTC date", () => {
    expect(dayAnchor(Date.parse("2026-06-14T23:30:00Z"))).toBe("2026-06-14");
  });

  it("newArmedInstance is armed, zeroed, and due immediately", () => {
    const now = Date.parse("2026-06-14T10:00:00Z");
    const inst = newArmedInstance({ instance_id: "i1", user_id: "u1", dsl: FAKE_DSL, nowMs: now });
    expect(inst.status).toBe("armed");
    expect(inst.position).toEqual({ base_qty: 0, avg_entry_price: 0, realized_pnl_usd: 0 });
    expect(inst.next_eval_at).toBe(new Date(now).toISOString());
    expect(inst.tick_count).toBe(0);
    expect(inst.fills).toEqual([]);
  });
});
