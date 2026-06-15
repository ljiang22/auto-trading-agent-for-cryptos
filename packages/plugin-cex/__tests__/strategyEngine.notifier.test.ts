import { describe, it, expect, vi } from "vitest";
import { buildFillMemory, makeNotifier } from "../src/strategy/engine/notifier";

const inst = { instance_id: "i1", user_id: "u1", dsl: { universe: { symbols: ["BTCUSDT"] } } } as any;
const fill = { client_order_id: "px-a", side: "BUY", qty: 1, price: 100, ts: "2026-06-14T12:00:00Z" } as any;

describe("notifier", () => {
  it("buildFillMemory carries paper-fill metadata", () => {
    const mem = buildFillMemory({ runtimeAgentId: "agent-1" as any, roomId: "room-1" as any, instance: inst, fill });
    expect(mem.content.metadata).toMatchObject({
      type: "strategy_fill",
      instance_id: "i1",
      side: "BUY",
      symbol: "BTCUSDT",
      mode: "paper",
    });
    expect(mem.content.text).toContain("PAPER");
  });

  it("makeNotifier emits an SSE event and persists a memory", async () => {
    const emit = vi.fn();
    const createMemory = vi.fn().mockResolvedValue(undefined);
    const runtime = {
      agentId: "agent-1",
      messageManager: { createMemory },
    } as any;
    const notify = makeNotifier(runtime, () => "room-1" as any, emit);
    await notify("u1", inst, fill);
    expect(emit).toHaveBeenCalledWith(runtime, "u1", expect.objectContaining({ event: "strategy_fill" }));
    expect(createMemory).toHaveBeenCalledTimes(1);
  });
});
