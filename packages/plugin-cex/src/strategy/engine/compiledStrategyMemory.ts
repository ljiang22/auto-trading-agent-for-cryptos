import { type Memory, type UUID, stringToUuid } from "@elizaos/core";
import type { StrategyDSL } from "../strategyDSL";

export function buildCompiledStrategyMemory(args: {
  agentId: UUID;
  roomId: UUID;
  userId: UUID;
  strategy: StrategyDSL;
}): Memory {
  return {
    id: stringToUuid(`compiled-strategy-${args.strategy.identity.id}-${args.userId}`),
    userId: args.userId,
    agentId: args.agentId,
    roomId: args.roomId,
    content: {
      text: `Compiled strategy ${args.strategy.identity.id} (mode=${args.strategy.identity.mode}).`,
      metadata: { type: "compiled_strategy", compiledStrategy: args.strategy },
    },
  };
}

/** Most-recent compiled strategy from a memory list, or null. */
export function recoverCompiledStrategy(memories: Memory[]): StrategyDSL | null {
  let best: { ts: number; dsl: StrategyDSL } | null = null;
  for (const m of memories) {
    const dsl = (m.content?.metadata as { compiledStrategy?: StrategyDSL } | undefined)?.compiledStrategy;
    if (dsl) {
      const ts = m.createdAt ?? 0;
      if (!best || ts > best.ts) best = { ts, dsl };
    }
  }
  return best ? best.dsl : null;
}
