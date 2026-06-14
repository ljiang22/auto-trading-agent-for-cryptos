import { describe, it, expect } from "vitest";
import { buildCompiledStrategyMemory, recoverCompiledStrategy } from "../src/strategy/engine/compiledStrategyMemory";

const dsl = { identity: { id: "s1", mode: "paper" }, universe: { symbols: ["BTCUSDT"] } } as any;

describe("compiledStrategyMemory", () => {
  it("builds a memory tagged with metadata.compiledStrategy", () => {
    const m = buildCompiledStrategyMemory({ agentId: "a" as any, roomId: "r" as any, userId: "u" as any, strategy: dsl });
    expect((m.content.metadata as any).compiledStrategy).toEqual(dsl);
    expect((m.content.metadata as any).type).toBe("compiled_strategy");
  });

  it("recovers the most recent compiled strategy from a memory list", () => {
    const mems = [
      { createdAt: 1, content: { metadata: { compiledStrategy: { v: 1 } } } },
      { createdAt: 3, content: { metadata: { compiledStrategy: { v: 3 } } } },
      { createdAt: 2, content: { text: "no metadata" } },
    ] as any[];
    expect(recoverCompiledStrategy(mems)).toEqual({ v: 3 });
  });

  it("returns null when no memory carries a compiled strategy", () => {
    expect(recoverCompiledStrategy([{ content: { text: "x" } }] as any)).toBeNull();
  });
});
