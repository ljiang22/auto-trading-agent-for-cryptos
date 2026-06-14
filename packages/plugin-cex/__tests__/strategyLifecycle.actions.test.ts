import { describe, it, expect, vi } from "vitest";
import { armStrategyAction, renderStrategyTable } from "../src/actions/strategyLifecycle";

const dsl = {
  identity: { id: "s1", version: 1, owner: "u1", status: "paper", mode: "paper" },
  universe: { venue: "paper", symbols: ["BTCUSDT"] },
  signals: [], entries: [], exits: [],
  risk: { max_position_notional_usd: 1000, max_daily_loss_usd: 200, max_concurrent_positions: 1 },
  operations: { evaluation_interval_seconds: 30 }, resilience: {},
} as any;

function runtimeWith(service: any, memories: any[] = []) {
  return {
    agentId: "a",
    getService: () => service,
    messageManager: { getMemories: vi.fn().mockResolvedValue(memories) },
  } as any;
}

describe("arm_strategy action", () => {
  it("arms a recovered/forced-paper strategy and reports it", async () => {
    const armStrategy = vi.fn().mockResolvedValue({ instance_id: "i1", status: "armed", dsl });
    const service = { armStrategy };
    const cb = vi.fn();
    const memory = { roomId: "r", userId: "u1", content: { text: "arm it" } } as any;
    await armStrategyAction.handler(
      runtimeWith(service, [{ createdAt: 1, content: { metadata: { compiledStrategy: dsl } } }]),
      memory, undefined, {}, cb,
    );
    expect(armStrategy).toHaveBeenCalledWith("u1", dsl);
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ action: "arm_strategy" }));
  });

  it("asks for a strategy when none can be recovered", async () => {
    const service = { armStrategy: vi.fn() };
    const cb = vi.fn();
    const memory = { roomId: "r", userId: "u1", content: { text: "arm it" } } as any;
    await armStrategyAction.handler(runtimeWith(service, []), memory, undefined, {}, cb);
    expect(service.armStrategy).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/compile/i) }));
  });
});

describe("renderStrategyTable", () => {
  it("renders a status row per instance", () => {
    const table = renderStrategyTable([
      { instance_id: "i1", status: "armed", position: { base_qty: 1, avg_entry_price: 100, realized_pnl_usd: 5 }, last_fill_at: "t", next_eval_at: "n", dsl: { universe: { symbols: ["BTCUSDT"] } } } as any,
    ]);
    expect(table).toContain("i1");
    expect(table).toContain("armed");
    expect(table).toContain("BTCUSDT");
  });
});
