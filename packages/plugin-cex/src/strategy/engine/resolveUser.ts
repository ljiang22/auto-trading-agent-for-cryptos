import type { IAgentRuntime, Memory } from "@elizaos/core";

/**
 * Resolve the effective end-user id for strategy actions.
 *
 * In the chat session the inbound `memory.userId` is frequently the AGENT's id
 * (the room's session identity), not the human's. The CEX plan runner already
 * resolves the real user by reading the room's non-agent participant; single-
 * action handlers (arm/pause/resume/stop/list) and the compile cache must do the
 * same, or they key strategy state under the agent id and never find the user's
 * strategies (the plan-path arm persists under the human id).
 */
export async function resolveStrategyUserId(runtime: IAgentRuntime, memory: Memory): Promise<string> {
  const uid = String(memory.userId);
  if (uid !== String(runtime.agentId)) return uid;
  try {
    const adapter = runtime.databaseAdapter as unknown as {
      getParticipantsForRoom?: (roomId: string) => Promise<string[]>;
    };
    const parts = (await adapter.getParticipantsForRoom?.(String(memory.roomId))) ?? [];
    const nonAgent = parts.map(String).find((p) => p && p !== String(runtime.agentId));
    if (nonAgent) return nonAgent;
  } catch {
    /* fall back to memory.userId */
  }
  return uid;
}
