import { type IAgentRuntime, type Memory, type UUID, emitEventToUser, stringToUuid, elizaLogger } from "@elizaos/core";
import type { StrategyInstance, StrategyFill } from "./strategyInstance";

export function buildFillMemory(args: {
  runtimeAgentId: UUID;
  roomId: UUID;
  instance: StrategyInstance;
  fill: StrategyFill;
}): Memory {
  const { runtimeAgentId, roomId, instance, fill } = args;
  const symbol = instance.dsl.universe.symbols[0];
  const text = `**[PAPER MODE — no real money]** Strategy \`${instance.instance_id}\` ${fill.side} ${fill.qty} ${symbol} @ ${fill.price}.`;
  return {
    id: stringToUuid(`strategy-fill-${fill.client_order_id}`),
    userId: instance.user_id as UUID,
    agentId: runtimeAgentId,
    roomId,
    createdAt: Date.parse(fill.ts),
    content: {
      text,
      metadata: {
        type: "strategy_fill",
        isActionResponse: true,
        instance_id: instance.instance_id,
        client_order_id: fill.client_order_id,
        side: fill.side,
        qty: fill.qty,
        price: fill.price,
        symbol,
        mode: "paper",
      },
    },
  };
}

export type Notifier = (userId: string, instance: StrategyInstance, fill: StrategyFill) => Promise<void>;

/**
 * Build the engine notifier. `roomIdFor` resolves the room to persist into
 * (the strategy's owning room). `emit` defaults to emitEventToUser and is
 * injectable for tests.
 */
export function makeNotifier(
  runtime: IAgentRuntime,
  roomIdFor: (userId: string) => UUID,
  emit: typeof emitEventToUser = emitEventToUser,
): Notifier {
  return async (userId, instance, fill) => {
    const roomId = roomIdFor(userId);
    try {
      emit(runtime, userId, {
        event: "strategy_fill",
        instance_id: instance.instance_id,
        client_order_id: fill.client_order_id,
        side: fill.side,
        qty: fill.qty,
        price: fill.price,
        symbol: instance.dsl.universe.symbols[0],
      });
    } catch (err) {
      elizaLogger.warn(`[strategy-engine] notify emit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Persisting the chat notification is best-effort: a fill is already
    // committed by the time we notify, so a memory-write failure (e.g. FK
    // constraints for a synthetic user/room) must never bubble up and turn a
    // successful fill into a tick error.
    try {
      const mem = buildFillMemory({ runtimeAgentId: runtime.agentId, roomId, instance, fill });
      await runtime.messageManager.createMemory(mem, "messages");
    } catch (err) {
      elizaLogger.warn(`[strategy-engine] notify persist failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
