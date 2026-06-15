import type { StrategyDSL } from "../strategyDSL";
import { newArmedInstance, type StrategyInstance } from "./strategyInstance";
import type { StrategyInstanceStore } from "./strategyInstanceStore";

/** Return a deep copy of the DSL with mode + status forced to paper. */
export function forcePaper(dsl: StrategyDSL): StrategyDSL {
  const copy = JSON.parse(JSON.stringify(dsl)) as StrategyDSL;
  copy.identity.mode = "paper";
  copy.identity.status = "paper";
  return copy;
}

/** Whether the DSL requested live (so the caller can surface a downgrade notice). */
export function wasLiveRequested(dsl: StrategyDSL): boolean {
  return dsl.identity.mode === "live" || dsl.identity.status === "live";
}

export async function armStrategyInstance(
  store: StrategyInstanceStore,
  args: { userId: string; dsl: StrategyDSL; nowMs: number; instanceId: string },
): Promise<StrategyInstance> {
  const inst = newArmedInstance({
    instance_id: args.instanceId,
    user_id: args.userId,
    dsl: forcePaper(args.dsl),
    nowMs: args.nowMs,
  });
  await store.put(inst);
  return inst;
}
