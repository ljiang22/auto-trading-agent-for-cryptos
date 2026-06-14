import type { StrategyInstance } from "./strategyInstance";
import type { StrategyInstanceStore } from "./strategyInstanceStore";

/**
 * Minimal better-sqlite3 surface we depend on. The adapter-sqlite package
 * exposes the real Database on its public `.db` property; we accept that handle
 * directly so this store works both in production (adapter.db) and in tests
 * (a fresh better-sqlite3 :memory: database).
 */
export interface SqliteHandle {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): unknown;
}

/** Standalone DDL so tests can create the table without booting the adapter. */
export const STRATEGY_INSTANCES_DDL = `
CREATE TABLE IF NOT EXISTS "strategy_instances" (
    "instance_id" TEXT PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "next_eval_at" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "idx_strategy_instances_user" ON "strategy_instances" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_strategy_instances_status" ON "strategy_instances" ("status");
`;

const ACTIVE_STATUSES = ["armed", "paused"];

export class SqliteStrategyInstanceStore implements StrategyInstanceStore {
  constructor(private db: SqliteHandle) {
    // Ensure the table exists even if the adapter-sqlite schema wasn't rebuilt
    // with the strategy_instances DDL. Idempotent (CREATE TABLE IF NOT EXISTS).
    this.db.exec(STRATEGY_INSTANCES_DDL);
  }

  async get(id: string): Promise<StrategyInstance | null> {
    const row = this.db
      .prepare(`SELECT data FROM strategy_instances WHERE instance_id = ?`)
      .get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as StrategyInstance) : null;
  }

  async put(instance: StrategyInstance): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO strategy_instances (instance_id, user_id, status, next_eval_at, data, updatedAt)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(instance_id) DO UPDATE SET
           user_id = excluded.user_id,
           status = excluded.status,
           next_eval_at = excluded.next_eval_at,
           data = excluded.data,
           updatedAt = CURRENT_TIMESTAMP`,
      )
      .run(
        instance.instance_id,
        instance.user_id,
        instance.status,
        instance.next_eval_at,
        JSON.stringify(instance),
      );
  }

  async delete(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM strategy_instances WHERE instance_id = ?`).run(id);
  }

  async list(user_id: string): Promise<StrategyInstance[]> {
    const rows = this.db
      .prepare(`SELECT data FROM strategy_instances WHERE user_id = ?`)
      .all(user_id) as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as StrategyInstance);
  }

  async listActive(): Promise<StrategyInstance[]> {
    const placeholders = ACTIVE_STATUSES.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT data FROM strategy_instances WHERE status IN (${placeholders})`)
      .all(...ACTIVE_STATUSES) as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as StrategyInstance);
  }
}
