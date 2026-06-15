import type { StrategyInstance } from "./strategyInstance";

/**
 * Persistence contract for strategy instances. Mirrors the LedgerOperations
 * pattern (interface + per-adapter impls); there is no generic store in this
 * codebase. listActive() returns instances the engine loop must consider on
 * startup resume: armed (eligible to trade) and paused (resumable).
 */
export interface StrategyInstanceStore {
  get(instance_id: string): Promise<StrategyInstance | null>;
  put(instance: StrategyInstance): Promise<void>; // upsert
  delete(instance_id: string): Promise<void>;
  list(user_id: string): Promise<StrategyInstance[]>;
  listActive(): Promise<StrategyInstance[]>;
}

const ACTIVE: ReadonlySet<StrategyInstance["status"]> = new Set(["armed", "paused"]);

function clone(inst: StrategyInstance): StrategyInstance {
  return JSON.parse(JSON.stringify(inst)) as StrategyInstance;
}

/** In-memory store for tests. Deep-copies on the way in and out to prevent aliasing. */
export class InMemoryStrategyInstanceStore implements StrategyInstanceStore {
  private map = new Map<string, StrategyInstance>();

  async get(id: string): Promise<StrategyInstance | null> {
    const v = this.map.get(id);
    return v ? clone(v) : null;
  }
  async put(instance: StrategyInstance): Promise<void> {
    this.map.set(instance.instance_id, clone(instance));
  }
  async delete(id: string): Promise<void> {
    this.map.delete(id);
  }
  async list(user_id: string): Promise<StrategyInstance[]> {
    return [...this.map.values()].filter((i) => i.user_id === user_id).map(clone);
  }
  async listActive(): Promise<StrategyInstance[]> {
    return [...this.map.values()].filter((i) => ACTIVE.has(i.status)).map(clone);
  }
}
