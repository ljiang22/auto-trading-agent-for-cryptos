# StrategyEngineService (paper-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a feature-flagged background `StrategyEngineService` that runs armed trading strategies on a coordinated loop, executing them against the paper venue only, with the full DSL signal set and every existing risk control enforced per order.

**Architecture:** A single `setInterval` loop (re-entrancy guarded) calls one idempotent `runTick(deps)` orchestrator that takes injected dependencies (store, market-data fns, sentiment fn, risk fn, paper-createOrder fn, notifier, clock) so it is fully unit-testable without a live agent. Strategy instances persist in a SQLite-backed store (mirroring the ledger pattern). The engine reuses the existing `runStrategyOnce` rule engine (which already emits a full `CanonicalIntent` and accepts a paper `modeOverride`), the `evaluate()` risk engine, and the runtime-bound paper venue.

**Tech Stack:** TypeScript 5.6, pnpm monorepo, Vitest, better-sqlite3 (adapter-sqlite), Zod (DSL), Node 23.

**Spec:** `docs/superpowers/specs/2026-06-14-strategy-engine-paper-design.md`

**Branch:** `feature/strategy-engine-paper` (already created off `master`).

---

## Conventions used in every task

- **Test location:** `packages/plugin-cex/__tests__/<name>.test.ts` (the `test:unit` script globs `__tests__/*.test.ts` — flat, not recursive).
- **Run a single test file:**
  ```bash
  cd packages/plugin-cex && npx vitest run __tests__/<name>.test.ts
  ```
- **Run all plugin-cex unit tests:**
  ```bash
  pnpm --filter @elizaos-plugins/plugin-cex test:unit
  ```
- **Imports:** core types come from `@elizaos/core`; intra-plugin imports use relative paths.
- **Logging:** use `elizaLogger` from `@elizaos/core` (never `console.log`).
- **Commit after every task** (frequent commits). Co-author trailer:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```

## Shared types (created in Phase 1, referenced everywhere)

These exact shapes are defined in Task 1.2 and Task 3.3. Later tasks import them.

```ts
// strategyInstance.ts
export type StrategyInstanceStatus = "armed" | "paused" | "stopped" | "halted";

export interface StrategyPosition {
  base_qty: number;
  avg_entry_price: number;
  realized_pnl_usd: number;
}

export interface StrategyFill {
  client_order_id: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  ts: string; // ISO
}

export interface StrategyInstance {
  instance_id: string;
  user_id: string;
  dsl: unknown;            // StrategyDSL (forced paper at arm time); typed as StrategyDSL where imported
  status: StrategyInstanceStatus;
  position: StrategyPosition;
  day_realized_pnl_usd: number;
  day_anchor: string;      // ISO date (YYYY-MM-DD) for the daily-loss window
  last_tick_at: string | null;
  next_eval_at: string;    // ISO
  last_fill_at: string | null;
  fills: StrategyFill[];
  tick_count: number;
  consecutive_risk_blocks: number;
  last_error: string | null;
}
```

---

# Phase 1 — Foundation (ServiceType, instance types, store)

Produces: a persisted `StrategyInstanceStore` with SQLite + in-memory impls, fully unit-tested. No runtime wiring yet.

### Task 1.1: Add `STRATEGY_ENGINE` to the core ServiceType enum

**Files:**
- Modify: `packages/core/src/core/types.ts` (the `ServiceType` enum, near `TRADING_RECONCILIATION`)

- [ ] **Step 1: Locate the enum**

Run:
```bash
grep -n "TRADING_RECONCILIATION" packages/core/src/core/types.ts
```
Expected: a line like `TRADING_RECONCILIATION = "trading_reconciliation",` inside `export enum ServiceType {`.

- [ ] **Step 2: Add the new member**

In the `ServiceType` enum, immediately after the `TRADING_RECONCILIATION = "trading_reconciliation",` line, add:

```ts
    STRATEGY_ENGINE = "strategy_engine",
```

- [ ] **Step 3: Build core to verify the enum compiles**

Run:
```bash
pnpm --filter @elizaos/core build
```
Expected: build succeeds (no TS errors).

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/core/types.ts
git commit -m "feat(core): add ServiceType.STRATEGY_ENGINE

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.2: Strategy instance types

**Files:**
- Create: `packages/plugin-cex/src/strategy/engine/strategyInstance.ts`

- [ ] **Step 1: Write the file (pure types + one helper — no test needed for types alone, but a helper is tested)**

`packages/plugin-cex/src/strategy/engine/strategyInstance.ts`:

```ts
import type { StrategyDSL } from "../strategyDSL";

export type StrategyInstanceStatus = "armed" | "paused" | "stopped" | "halted";

export interface StrategyPosition {
  base_qty: number;
  avg_entry_price: number;
  realized_pnl_usd: number;
}

export interface StrategyFill {
  client_order_id: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  ts: string; // ISO
}

export interface StrategyInstance {
  instance_id: string;
  user_id: string;
  dsl: StrategyDSL;
  status: StrategyInstanceStatus;
  position: StrategyPosition;
  day_realized_pnl_usd: number;
  day_anchor: string; // YYYY-MM-DD
  last_tick_at: string | null;
  next_eval_at: string; // ISO
  last_fill_at: string | null;
  fills: StrategyFill[];
  tick_count: number;
  consecutive_risk_blocks: number;
  last_error: string | null;
}

/** UTC YYYY-MM-DD for a millisecond timestamp. Used for the daily-loss window anchor. */
export function dayAnchor(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** A freshly-armed instance with a zeroed position, due immediately. */
export function newArmedInstance(args: {
  instance_id: string;
  user_id: string;
  dsl: StrategyDSL;
  nowMs: number;
}): StrategyInstance {
  return {
    instance_id: args.instance_id,
    user_id: args.user_id,
    dsl: args.dsl,
    status: "armed",
    position: { base_qty: 0, avg_entry_price: 0, realized_pnl_usd: 0 },
    day_realized_pnl_usd: 0,
    day_anchor: dayAnchor(args.nowMs),
    last_tick_at: null,
    next_eval_at: new Date(args.nowMs).toISOString(),
    last_fill_at: null,
    fills: [],
    tick_count: 0,
    consecutive_risk_blocks: 0,
    last_error: null,
  };
}
```

- [ ] **Step 2: Write the failing test**

`packages/plugin-cex/__tests__/strategyInstance.test.ts`:

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/plugin-cex && npx vitest run __tests__/strategyInstance.test.ts`
Expected: FAIL — "Cannot find module ... strategyInstance" (file may not be picked up until built? No — vitest resolves TS source directly). If the file from Step 1 exists, this passes; to see a real red first, run Step 2 BEFORE creating Step 1's file.

> Note for the worker: do Step 2 first, run it (FAIL: module not found), then do Step 1, then Step 4.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/plugin-cex && npx vitest run __tests__/strategyInstance.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-cex/src/strategy/engine/strategyInstance.ts packages/plugin-cex/__tests__/strategyInstance.test.ts
git commit -m "feat(cex): StrategyInstance types + newArmedInstance/dayAnchor helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.3: Store interface + in-memory implementation

**Files:**
- Create: `packages/plugin-cex/src/strategy/engine/strategyInstanceStore.ts`
- Test: `packages/plugin-cex/__tests__/strategyInstanceStore.memory.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/plugin-cex/__tests__/strategyInstanceStore.memory.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { InMemoryStrategyInstanceStore } from "../src/strategy/engine/strategyInstanceStore";
import { newArmedInstance } from "../src/strategy/engine/strategyInstance";

const dsl = { identity: { id: "s1" } } as any;
const mk = (id: string, user: string, status: any = "armed") => {
  const i = newArmedInstance({ instance_id: id, user_id: user, dsl, nowMs: 0 });
  i.status = status;
  return i;
};

describe("InMemoryStrategyInstanceStore", () => {
  it("put/get round-trips a deep copy (no aliasing)", async () => {
    const store = new InMemoryStrategyInstanceStore();
    const inst = mk("i1", "u1");
    await store.put(inst);
    const got = await store.get("i1");
    expect(got).toEqual(inst);
    got!.tick_count = 99;
    const again = await store.get("i1");
    expect(again!.tick_count).toBe(0); // mutation of returned copy must not leak
  });

  it("get returns null for missing id", async () => {
    const store = new InMemoryStrategyInstanceStore();
    expect(await store.get("nope")).toBeNull();
  });

  it("list returns only a user's instances", async () => {
    const store = new InMemoryStrategyInstanceStore();
    await store.put(mk("i1", "u1"));
    await store.put(mk("i2", "u1"));
    await store.put(mk("i3", "u2"));
    const u1 = await store.list("u1");
    expect(u1.map((i) => i.instance_id).sort()).toEqual(["i1", "i2"]);
  });

  it("listActive returns armed + paused, not stopped/halted", async () => {
    const store = new InMemoryStrategyInstanceStore();
    await store.put(mk("a", "u1", "armed"));
    await store.put(mk("p", "u1", "paused"));
    await store.put(mk("s", "u1", "stopped"));
    await store.put(mk("h", "u1", "halted"));
    const active = await store.listActive();
    expect(active.map((i) => i.instance_id).sort()).toEqual(["a", "p"]);
  });

  it("delete removes an instance", async () => {
    const store = new InMemoryStrategyInstanceStore();
    await store.put(mk("i1", "u1"));
    await store.delete("i1");
    expect(await store.get("i1")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/plugin-cex && npx vitest run __tests__/strategyInstanceStore.memory.test.ts`
Expected: FAIL — cannot find `InMemoryStrategyInstanceStore`.

- [ ] **Step 3: Write the implementation**

`packages/plugin-cex/src/strategy/engine/strategyInstanceStore.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/plugin-cex && npx vitest run __tests__/strategyInstanceStore.memory.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-cex/src/strategy/engine/strategyInstanceStore.ts packages/plugin-cex/__tests__/strategyInstanceStore.memory.test.ts
git commit -m "feat(cex): StrategyInstanceStore interface + in-memory impl

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.4: SQLite-backed store + table DDL

The SQLite adapter exposes the raw better-sqlite3 handle on its public `.db` property (`packages/adapter-sqlite/src/index.ts`). New tables are added by appending a `CREATE TABLE IF NOT EXISTS` block to the exported `sqliteTables` SQL string (`packages/adapter-sqlite/src/sqliteTables.ts`), executed by `adapter.init()`.

**Files:**
- Modify: `packages/adapter-sqlite/src/sqliteTables.ts` (append a table)
- Create: `packages/plugin-cex/src/strategy/engine/sqliteStrategyInstanceStore.ts`
- Test: `packages/plugin-cex/__tests__/strategyInstanceStore.sqlite.test.ts`

- [ ] **Step 1: Add the table DDL**

Open `packages/adapter-sqlite/src/sqliteTables.ts`. Find the trailing `COMMIT;` at the end of the `sqliteTables` template string. Immediately BEFORE that final `COMMIT;`, insert:

```sql
-- Table: strategy_instances (StrategyEngineService, paper-only auto-execution)
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
```

The full `StrategyInstance` is JSON-serialized into the `data` column; `status` and `next_eval_at` are denormalized for indexed queries.

- [ ] **Step 2: Write the failing test**

`packages/plugin-cex/__tests__/strategyInstanceStore.sqlite.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  SqliteStrategyInstanceStore,
  STRATEGY_INSTANCES_DDL,
} from "../src/strategy/engine/sqliteStrategyInstanceStore";
import { newArmedInstance } from "../src/strategy/engine/strategyInstance";

const dsl = { identity: { id: "s1" } } as any;
const mk = (id: string, user: string, status: any = "armed") => {
  const i = newArmedInstance({ instance_id: id, user_id: user, dsl, nowMs: 0 });
  i.status = status;
  return i;
};

describe("SqliteStrategyInstanceStore", () => {
  let db: Database.Database;
  let store: SqliteStrategyInstanceStore;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(STRATEGY_INSTANCES_DDL);
    store = new SqliteStrategyInstanceStore(db);
  });

  it("put then get round-trips the full instance", async () => {
    const inst = mk("i1", "u1");
    inst.fills.push({ client_order_id: "px-abc", side: "BUY", qty: 1, price: 100, ts: "t" });
    await store.put(inst);
    expect(await store.get("i1")).toEqual(inst);
  });

  it("put is an upsert (second put overwrites)", async () => {
    const inst = mk("i1", "u1");
    await store.put(inst);
    inst.tick_count = 5;
    await store.put(inst);
    expect((await store.get("i1"))!.tick_count).toBe(5);
  });

  it("listActive returns armed+paused only", async () => {
    await store.put(mk("a", "u1", "armed"));
    await store.put(mk("p", "u1", "paused"));
    await store.put(mk("s", "u1", "stopped"));
    const active = await store.listActive();
    expect(active.map((i) => i.instance_id).sort()).toEqual(["a", "p"]);
  });

  it("list filters by user, delete removes", async () => {
    await store.put(mk("i1", "u1"));
    await store.put(mk("i2", "u2"));
    expect((await store.list("u1")).map((i) => i.instance_id)).toEqual(["i1"]);
    await store.delete("i1");
    expect(await store.get("i1")).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/plugin-cex && npx vitest run __tests__/strategyInstanceStore.sqlite.test.ts`
Expected: FAIL — cannot find `SqliteStrategyInstanceStore`.

- [ ] **Step 4: Write the implementation**

`packages/plugin-cex/src/strategy/engine/sqliteStrategyInstanceStore.ts`:

```ts
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
  constructor(private db: SqliteHandle) {}

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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/plugin-cex && npx vitest run __tests__/strategyInstanceStore.sqlite.test.ts`
Expected: PASS (4 tests). (`better-sqlite3` is already a dependency of `adapter-sqlite`; if vitest cannot resolve it from plugin-cex, add it as a devDependency: `pnpm --filter @elizaos-plugins/plugin-cex add -D better-sqlite3` and re-run.)

- [ ] **Step 6: Commit**

```bash
git add packages/adapter-sqlite/src/sqliteTables.ts packages/plugin-cex/src/strategy/engine/sqliteStrategyInstanceStore.ts packages/plugin-cex/__tests__/strategyInstanceStore.sqlite.test.ts
git commit -m "feat(cex): SQLite-backed StrategyInstanceStore + strategy_instances table

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

# Phase 2 — Signals (indicators, DSL extension, sentiment, signalCompute)

Produces: a `computeSignals()` function that builds a `StrategyEvaluationContext` (the exact shape `runStrategyOnce` consumes) for any DSL signal set, fully unit-tested from fixture klines. All signal-value conventions are defined here — the backtest runner only computes RSI today, so this is the canonical mapping.

### Task 2.1: New indicators — `volumeZScore` and `pctFromHigh`

**Files:**
- Modify: `packages/plugin-cex/src/backtest/indicators.ts` (append two functions)
- Test: `packages/plugin-cex/__tests__/indicators.strategyEngine.test.ts`

The existing exports are `sma(bars,i,period)`, `ema(bars,i,period,cache?)`, `rsi(bars,i,period=14)`, `atr(bars,i,period=14)`, all over `OhlcvBar[]` (`{timestamp,open,high,low,close,volume}`), returning `NaN` until enough bars elapse, referencing only `bars[0..i]` (no look-ahead).

- [ ] **Step 1: Write the failing test**

`packages/plugin-cex/__tests__/indicators.strategyEngine.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { volumeZScore, pctFromHigh } from "../src/backtest/indicators";

const bar = (close: number, high: number, volume: number) => ({
  timestamp: 0, open: close, high, low: close, close, volume,
});

describe("volumeZScore", () => {
  it("is 0 when the last volume equals the window mean", () => {
    const bars = [bar(1, 1, 10), bar(1, 1, 10), bar(1, 1, 10)];
    expect(volumeZScore(bars, 2, 3)).toBeCloseTo(0, 6);
  });
  it("is positive on a volume spike", () => {
    const bars = [bar(1, 1, 10), bar(1, 1, 10), bar(1, 1, 100)];
    expect(volumeZScore(bars, 2, 3)).toBeGreaterThan(1);
  });
  it("returns NaN before the window fills", () => {
    const bars = [bar(1, 1, 10)];
    expect(Number.isNaN(volumeZScore(bars, 0, 3))).toBe(true);
  });
  it("returns NaN when the window has zero variance only if all equal -> 0 not NaN", () => {
    const bars = [bar(1, 1, 5), bar(1, 1, 5)];
    expect(volumeZScore(bars, 1, 2)).toBe(0);
  });
});

describe("pctFromHigh", () => {
  it("is 0 at a fresh high", () => {
    const bars = [bar(10, 10, 1), bar(12, 12, 1)];
    expect(pctFromHigh(bars, 1, 2)).toBeCloseTo(0, 6);
  });
  it("is -5 when 5% below the rolling high", () => {
    const bars = [bar(100, 100, 1), bar(95, 95, 1)];
    expect(pctFromHigh(bars, 1, 2)).toBeCloseTo(-5, 6);
  });
  it("returns NaN before the window fills", () => {
    const bars = [bar(10, 10, 1)];
    expect(Number.isNaN(pctFromHigh(bars, 0, 5))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/plugin-cex && npx vitest run __tests__/indicators.strategyEngine.test.ts`
Expected: FAIL — `volumeZScore`/`pctFromHigh` not exported.

- [ ] **Step 3: Append the implementation**

At the END of `packages/plugin-cex/src/backtest/indicators.ts`, append:

```ts
/**
 * Z-score of the volume at index `i` over the trailing `window` bars
 * (population std). Returns NaN until `window` bars have elapsed. When the
 * window has zero variance, returns 0 (no anomaly) rather than NaN.
 */
export function volumeZScore(bars: OhlcvBar[], i: number, window: number): number {
  if (i + 1 < window) return Number.NaN;
  let sum = 0;
  for (let k = i - window + 1; k <= i; k++) sum += bars[k].volume;
  const mean = sum / window;
  let varSum = 0;
  for (let k = i - window + 1; k <= i; k++) {
    const d = bars[k].volume - mean;
    varSum += d * d;
  }
  const std = Math.sqrt(varSum / window);
  if (std === 0) return 0;
  return (bars[i].close === undefined ? 0 : (bars[i].volume - mean) / std);
}

/**
 * Percent of the close at index `i` relative to the highest high over the
 * trailing `window` bars (inclusive). 0 at a fresh high; negative below it
 * (e.g. -5 means 5% below the rolling high — a "dip"). NaN until `window`
 * bars have elapsed.
 */
export function pctFromHigh(bars: OhlcvBar[], i: number, window: number): number {
  if (i + 1 < window) return Number.NaN;
  let hi = -Infinity;
  for (let k = i - window + 1; k <= i; k++) hi = Math.max(hi, bars[k].high);
  if (hi <= 0) return Number.NaN;
  return ((bars[i].close - hi) / hi) * 100;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/plugin-cex && npx vitest run __tests__/indicators.strategyEngine.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-cex/src/backtest/indicators.ts packages/plugin-cex/__tests__/indicators.strategyEngine.test.ts
git commit -m "feat(cex): add volumeZScore + pctFromHigh indicators

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2.2: Add `price.pct_from_high` signal kind to the DSL

**Files:**
- Modify: `packages/plugin-cex/src/strategy/strategyDSL.ts` (the `signalSchema` `kind` enum + its doc comment)
- Test: `packages/plugin-cex/__tests__/strategyDSL.pctFromHigh.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/plugin-cex/__tests__/strategyDSL.pctFromHigh.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { strategyDSLSchema } from "../src/strategy/strategyDSL";

const base = {
  identity: { id: "s1", version: 1, owner: "u1", status: "paper", mode: "paper" },
  universe: { venue: "paper", symbols: ["BTCUSDT"] },
  signals: [{ id: "dip", kind: "price.pct_from_high", params: { window: 20 } }],
  entries: [{ id: "e1", when: { op: "lt", args: ["dip", -5] }, then: { order_type: "market", side: "BUY", equity_pct: 10 } }],
  exits: [{ id: "x1", when: { op: "gt", args: ["dip", 0] }, then: { order_type: "market", side: "SELL", equity_pct: 100 } }],
  risk: { max_position_notional_usd: 1000, max_daily_loss_usd: 200, max_concurrent_positions: 1 },
  operations: { evaluation_interval_seconds: 30 },
  resilience: {},
};

describe("strategyDSL price.pct_from_high", () => {
  it("accepts the new signal kind", () => {
    const parsed = strategyDSLSchema.parse(base);
    expect(parsed.signals[0].kind).toBe("price.pct_from_high");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/plugin-cex && npx vitest run __tests__/strategyDSL.pctFromHigh.test.ts`
Expected: FAIL — zod rejects `"price.pct_from_high"` (invalid enum value). (Adjust the `then`/`risk` field names in the fixture if your `orderSpecSchema`/`riskSchema` differ — read `strategyDSL.ts` lines 57-98; the point of the test is the enum acceptance.)

- [ ] **Step 3: Edit the enum + doc comment**

In `packages/plugin-cex/src/strategy/strategyDSL.ts`, update the `signalSchema` doc comment (lines ~30-38) by adding one bullet after the `volume.zscore` line:

```ts
     * - volume.zscore: Volume z-score over window
     * - price.pct_from_high: percent of close vs rolling N-bar high (param: window); 0 at high, negative below
     * - sentiment.score: external sentiment input (Tier-A)
```

Then change the `kind` enum (lines ~39-46) to include the new kind:

```ts
    kind: z.enum([
        "price.rsi",
        "price.sma_cross",
        "price.ema_cross",
        "price.atr_band",
        "volume.zscore",
        "price.pct_from_high",
        "sentiment.score",
    ]),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/plugin-cex && npx vitest run __tests__/strategyDSL.pctFromHigh.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-cex/src/strategy/strategyDSL.ts packages/plugin-cex/__tests__/strategyDSL.pctFromHigh.test.ts
git commit -m "feat(cex): add price.pct_from_high signal kind to strategy DSL

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2.3: `getLatestSentiment` export in plugin-sentiscore

`plugin-sentiscore` exposes `makeS3SentimentFetcher({prefix, symbolMode}): FetchFn` (`packages/plugin-sentiscore/src/actions/_s3SentimentFetcher.ts:120`). `FetchFn = (req: Request, ctx: { params: { symbol } }) => Promise<Response>` and the crypto-news source is `makeS3SentimentFetcher({prefix:'crypto_news/', symbolMode:'per-symbol'})` (`actions/crypto.ts:4`). The Response body is JSON of `ResponseData = { dates, symbol, fileCount, sentiScores: SentimentScore[], lastUpdated }` where each `SentimentScore` has `{ time, value, total, ... }` (`_s3SentimentFetcher.ts:50-73`, built at ~line 218).

**Files:**
- Create: `packages/plugin-sentiscore/src/latestSentiment.ts`
- Modify: `packages/plugin-sentiscore/src/index.ts` (re-export)
- Test: `packages/plugin-sentiscore/__tests__/latestSentiment.test.ts` (verify the package's test dir/glob; if absent, place under `packages/plugin-sentiscore/src/__tests__/` and run via `npx vitest run`)

- [ ] **Step 1: Confirm the Response body shape**

Run:
```bash
sed -n '210,245p' packages/plugin-sentiscore/src/actions/_s3SentimentFetcher.ts
```
Expected: a `const responseData: ResponseData = {...}` followed by a `Response` constructed from `JSON.stringify(responseData)` (or `Response.json(responseData)`). Confirm the body is the `ResponseData` object. If it is wrapped (e.g. `{ data: responseData }`), adjust the parse in Step 3 accordingly.

- [ ] **Step 2: Write the failing test (deps injected — no real S3)**

`packages/plugin-sentiscore/__tests__/latestSentiment.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { extractLatestSentiment } from "../src/latestSentiment";

describe("extractLatestSentiment", () => {
  it("returns the score with the max time", () => {
    const body = {
      symbol: "BTC",
      sentiScores: [
        { time: 100, value: 0.1, total: 5 },
        { time: 300, value: -0.4, total: 20 },
        { time: 200, value: 0.9, total: 1 },
      ],
    };
    expect(extractLatestSentiment(body as any)).toEqual({ value: -0.4, ts: 300_000 });
  });

  it("returns null on empty/absent scores", () => {
    expect(extractLatestSentiment({ sentiScores: [] } as any)).toBeNull();
    expect(extractLatestSentiment({} as any)).toBeNull();
  });
});
```

- [ ] **Step 3: Write the implementation**

`packages/plugin-sentiscore/src/latestSentiment.ts`:

```ts
import { makeS3SentimentFetcher } from "./actions/_s3SentimentFetcher.ts";

export interface LatestSentiment {
  value: number; // composite sentiment, typically [-1, 1]
  ts: number;    // ms epoch of the latest scored bucket
}

interface SentiBody {
  sentiScores?: Array<{ time: number; value: number; total?: number }>;
}

/**
 * Pure reducer: pick the score with the greatest `time` (seconds epoch) and
 * return it in ms. Exported for unit testing without S3.
 */
export function extractLatestSentiment(body: SentiBody): LatestSentiment | null {
  const scores = body?.sentiScores;
  if (!Array.isArray(scores) || scores.length === 0) return null;
  let best = scores[0];
  for (const s of scores) if (s.time > best.time) best = s;
  return { value: best.value, ts: best.time * 1000 };
}

const cryptoNewsFetcher = makeS3SentimentFetcher({
  prefix: "crypto_news/",
  symbolMode: "per-symbol",
});

/**
 * Fetch the latest crypto-news sentiment for a base asset (e.g. "BTC").
 * Reuses the existing S3 fetcher. Returns null on any error or no data — the
 * caller (strategy engine) treats null as a missing/stale signal and skips.
 */
export async function getLatestSentiment(symbol: string): Promise<LatestSentiment | null> {
  try {
    const req = new Request("https://internal/sentiment");
    const res = await cryptoNewsFetcher(req, { params: { symbol } });
    if (!res.ok) return null;
    const body = (await res.json()) as SentiBody;
    return extractLatestSentiment(body);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Re-export from the package index**

In `packages/plugin-sentiscore/src/index.ts`, add near the top-level exports:

```ts
export { getLatestSentiment, extractLatestSentiment } from "./latestSentiment";
export type { LatestSentiment } from "./latestSentiment";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/plugin-sentiscore && npx vitest run __tests__/latestSentiment.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-sentiscore/src/latestSentiment.ts packages/plugin-sentiscore/src/index.ts packages/plugin-sentiscore/__tests__/latestSentiment.test.ts
git commit -m "feat(sentiscore): export getLatestSentiment for the strategy engine

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2.4: `computeSignals` — the signal compute unit

This is the heart of Phase 2. It builds the exact `StrategyEvaluationContext` shape `runStrategyOnce` consumes (`strategyRuntime.ts:11-22`):

```ts
export interface StrategyEvaluationContext {
  signals: { [signalId: string]: number };
  equityUsd: number;
  midPrice: number;
}
```

Signal values are keyed by `signal.id` (not kind) — `ruleEval` resolves rule args via `signals[arg]`. Conventions (canonical, defined here):
- `price.rsi` → `rsi(bars, last, params.period ?? 14)`
- `price.sma_cross` → `sma(fast) - sma(slow)` (params `fast`??20, `slow`??50); >0 = fast above slow
- `price.ema_cross` → `ema(fast) - ema(slow)` (params `fast`??12, `slow`??26)
- `price.atr_band` → `(close - sma(period)) / atr(period)` (params `period`??14); price distance from mean in ATR units
- `volume.zscore` → `volumeZScore(bars, last, params.window ?? 20)`
- `price.pct_from_high` → `pctFromHigh(bars, last, params.window ?? 20)`
- `sentiment.score` → latest sentiment value from `getSentiment(symbol, nowMs)`

Any signal that computes to `NaN` (not enough bars) or `null` (sentiment unavailable) is recorded in `missing[]`; the engine skips the tick when `missing` is non-empty. Freshness: `ageMs = nowMs - lastBar.timestamp`; `fresh = ageMs <= maxLagMs`.

**Files:**
- Create: `packages/plugin-cex/src/strategy/engine/signalCompute.ts`
- Test: `packages/plugin-cex/__tests__/signalCompute.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/plugin-cex/__tests__/signalCompute.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeSignals, type SignalComputeDeps } from "../src/strategy/engine/signalCompute";

const bar = (ts: number, close: number, high: number, volume: number) => ({
  timestamp: ts, open: close, high, low: close, close, volume,
});

// 25 ascending bars then one dip; enough for window=20 signals.
function fixtureBars(nowMs: number) {
  const bars = [];
  for (let k = 0; k < 25; k++) bars.push(bar(nowMs - (25 - k) * 60_000, 100 + k, 100 + k, 10));
  bars.push(bar(nowMs - 60_000, 95, 95, 100)); // last bar: dip + volume spike
  return bars;
}

function deps(over: Partial<SignalComputeDeps> = {}): SignalComputeDeps {
  return {
    fetchKlines: async () => fixtureBars(Date.parse("2026-06-14T12:00:00Z")),
    fetchMid: async () => 95,
    getEquityUsd: async () => 10_000,
    getSentiment: async () => ({ value: 0.5, ts: Date.parse("2026-06-14T11:59:00Z") }),
    ...over,
  };
}

const dsl = (signals: any[]) => ({
  universe: { venue: "paper", symbols: ["BTCUSDT"] },
  signals,
  resilience: { pause_on_market_data_lag_s: 600 },
}) as any;

const now = Date.parse("2026-06-14T12:00:00Z");

describe("computeSignals", () => {
  it("computes pct_from_high and volume.zscore keyed by signal id", async () => {
    const res = await computeSignals({
      dsl: dsl([
        { id: "dip", kind: "price.pct_from_high", params: { window: 20 } },
        { id: "volz", kind: "volume.zscore", params: { window: 20 } },
      ]),
      symbol: "BTCUSDT",
      nowMs: now,
      deps: deps(),
    });
    expect(res.context).not.toBeNull();
    expect(res.context!.signals.dip).toBeLessThan(0);   // last bar is below the rolling high
    expect(res.context!.signals.volz).toBeGreaterThan(1); // volume spike
    expect(res.context!.equityUsd).toBe(10_000);
    expect(res.context!.midPrice).toBe(95);
    expect(res.missing).toEqual([]);
  });

  it("computes sentiment.score from getSentiment", async () => {
    const res = await computeSignals({
      dsl: dsl([{ id: "sent", kind: "sentiment.score", params: {} }]),
      symbol: "BTCUSDT", nowMs: now, deps: deps(),
    });
    expect(res.context!.signals.sent).toBe(0.5);
  });

  it("marks sentiment missing when unavailable (no context fabrication)", async () => {
    const res = await computeSignals({
      dsl: dsl([{ id: "sent", kind: "sentiment.score", params: {} }]),
      symbol: "BTCUSDT", nowMs: now, deps: deps({ getSentiment: async () => null }),
    });
    expect(res.missing).toContain("sent");
  });

  it("marks fresh=false when the last bar is older than the lag budget", async () => {
    const stale = fixtureBars(now - 3_600_000); // last bar ~1h old
    const res = await computeSignals({
      dsl: { ...dsl([{ id: "r", kind: "price.rsi", params: { period: 14 } }]), resilience: { pause_on_market_data_lag_s: 60 } },
      symbol: "BTCUSDT", nowMs: now, deps: deps({ fetchKlines: async () => stale }),
    });
    expect(res.fresh).toBe(false);
  });

  it("returns null context when klines are unavailable", async () => {
    const res = await computeSignals({
      dsl: dsl([{ id: "r", kind: "price.rsi", params: {} }]),
      symbol: "BTCUSDT", nowMs: now, deps: deps({ fetchKlines: async () => null }),
    });
    expect(res.context).toBeNull();
    expect(res.fresh).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/plugin-cex && npx vitest run __tests__/signalCompute.test.ts`
Expected: FAIL — cannot find `computeSignals`.

- [ ] **Step 3: Write the implementation**

`packages/plugin-cex/src/strategy/engine/signalCompute.ts`:

```ts
import type { OhlcvBar } from "../../backtest/types";
import { sma, ema, rsi, atr, volumeZScore, pctFromHigh } from "../../backtest/indicators";
import type { StrategyDSL } from "../strategyDSL";

/** The exact context shape runStrategyOnce consumes (strategyRuntime.ts). */
export interface StrategyEvaluationContext {
  signals: { [signalId: string]: number };
  equityUsd: number;
  midPrice: number;
}

export interface SignalComputeDeps {
  fetchKlines: (args: {
    venue: string;
    symbol: string;
    intervalMs: number;
    count: number;
    endTs: number;
  }) => Promise<OhlcvBar[] | null>;
  fetchMid: (venue: string, symbol: string) => Promise<number | null>;
  getEquityUsd: (userId: string, venue: string) => Promise<number>;
  getSentiment: (symbol: string, asOfMs: number) => Promise<{ value: number; ts: number } | null>;
}

export interface SignalComputeResult {
  context: StrategyEvaluationContext | null;
  fresh: boolean;
  ageMs: number;
  missing: string[];
}

const DEFAULT_BAR_INTERVAL_MS = Number(process.env.STRATEGY_ENGINE_BAR_INTERVAL_MS ?? 3_600_000);

/** Bars needed to satisfy the longest-window signal in the DSL (+ buffer). */
function requiredBarCount(dsl: StrategyDSL): number {
  let maxWin = 50;
  for (const s of dsl.signals) {
    const p = s.params as Record<string, number>;
    maxWin = Math.max(
      maxWin,
      Number(p.period ?? 0),
      Number(p.window ?? 0),
      Number(p.fast ?? 0),
      Number(p.slow ?? 0),
    );
  }
  return Math.min(1000, maxWin + 5);
}

export async function computeSignals(args: {
  dsl: StrategyDSL;
  symbol: string;
  nowMs: number;
  userId?: string;
  deps: SignalComputeDeps;
}): Promise<SignalComputeResult> {
  const { dsl, symbol, nowMs, deps } = args;
  const venue = dsl.universe.venue;
  const needsBars = dsl.signals.some((s) => s.kind !== "sentiment.score");

  let bars: OhlcvBar[] | null = null;
  if (needsBars) {
    bars = await deps.fetchKlines({
      venue,
      symbol,
      intervalMs: DEFAULT_BAR_INTERVAL_MS,
      count: requiredBarCount(dsl),
      endTs: nowMs,
    });
    if (!bars || bars.length === 0) {
      return { context: null, fresh: false, ageMs: Number.POSITIVE_INFINITY, missing: [] };
    }
  }

  const last = bars ? bars.length - 1 : -1;
  const signals: { [id: string]: number } = {};
  const missing: string[] = [];

  for (const sig of dsl.signals) {
    const p = sig.params as Record<string, number>;
    let value: number = Number.NaN;
    switch (sig.kind) {
      case "price.rsi":
        value = rsi(bars!, last, Number(p.period ?? 14));
        break;
      case "price.sma_cross":
        value = sma(bars!, last, Number(p.fast ?? 20)) - sma(bars!, last, Number(p.slow ?? 50));
        break;
      case "price.ema_cross":
        value = ema(bars!, last, Number(p.fast ?? 12)) - ema(bars!, last, Number(p.slow ?? 26));
        break;
      case "price.atr_band": {
        const period = Number(p.period ?? 14);
        const a = atr(bars!, last, period);
        const m = sma(bars!, last, period);
        value = a === 0 ? Number.NaN : (bars![last].close - m) / a;
        break;
      }
      case "volume.zscore":
        value = volumeZScore(bars!, last, Number(p.window ?? 20));
        break;
      case "price.pct_from_high":
        value = pctFromHigh(bars!, last, Number(p.window ?? 20));
        break;
      case "sentiment.score": {
        const s = await deps.getSentiment(symbol, nowMs);
        value = s ? s.value : Number.NaN;
        break;
      }
      default:
        value = Number.NaN;
    }
    if (Number.isNaN(value)) {
      missing.push(sig.id);
    } else {
      signals[sig.id] = value;
    }
  }

  // midPrice + equity (always needed for sizing / risk).
  const midRaw = await deps.fetchMid(venue, symbol);
  const midPrice = midRaw ?? (bars ? bars[last].close : 0);
  const equityUsd = await deps.getEquityUsd(args.userId ?? "", venue);

  // Freshness from the last bar (sentiment-only strategies are always "fresh"
  // for bar purposes; sentiment staleness is handled by getSentiment returning null).
  const lagBudgetMs = Number(dsl.resilience?.pause_on_market_data_lag_s ?? 30) * 1000;
  const ageMs = bars ? nowMs - bars[last].timestamp : 0;
  const fresh = ageMs <= lagBudgetMs;

  return {
    context: { signals, equityUsd, midPrice },
    fresh,
    ageMs,
    missing,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/plugin-cex && npx vitest run __tests__/signalCompute.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-cex/src/strategy/engine/signalCompute.ts packages/plugin-cex/__tests__/signalCompute.test.ts
git commit -m "feat(cex): computeSignals — full DSL signal set -> StrategyEvaluationContext

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

# Phase 3 — Engine (idempotency salt, position tracker, runTick, service, registration)

Produces: a fully unit-tested `runTick(deps)` orchestrator, a registered `StrategyEngineService` behind `STRATEGY_ENGINE_ENABLED`, and kill-switch integration. The engine reuses `runStrategyOnce` (which emits a full `CanonicalIntent` and accepts `modeOverride="paper"`) for rule-driven entries/exits, and builds a `CanonicalIntent` directly for TP/SL (mirroring `strategyRuntime.ts:154-171`).

### Task 3.1: Idempotency salt helper

`deriveClientOrderId(hash, venue)` is purely deterministic from the intent hash, so two identical DCA tranches collide (only the first fires — the documented bug). We salt the hash with `instance_id:tick_count` so retries of the *same* tick dedupe but distinct tranches differ. This is additive — `canonicalIntent.ts` is untouched.

**Files:**
- Create: `packages/plugin-cex/src/strategy/engine/idempotency.ts`
- Test: `packages/plugin-cex/__tests__/strategyEngine.idempotency.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/plugin-cex/__tests__/strategyEngine.idempotency.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveTrancheClientOrderId } from "../src/strategy/engine/idempotency";

const intent = {
  intent_version: 1, request_id: "r", user_id: "u1", action: "create_order",
  mode: "paper", venue: "paper", symbol: "BTCUSDT", side: "BUY",
  order_type: "market", size: { base_size: "0.001" },
  price_params: {}, execution_constraints: {}, margin_context: {},
  idempotency: { client_order_id: "px-x", intent_hash: "h" },
  policy_context: {}, locale: "en",
} as any;

describe("deriveTrancheClientOrderId", () => {
  it("is deterministic for the same intent + salt (retry-safe)", () => {
    expect(deriveTrancheClientOrderId(intent, "i1:3")).toBe(deriveTrancheClientOrderId(intent, "i1:3"));
  });
  it("differs across tick_count (distinct tranches do not collide)", () => {
    expect(deriveTrancheClientOrderId(intent, "i1:3")).not.toBe(deriveTrancheClientOrderId(intent, "i1:4"));
  });
  it("produces a paper-prefixed id within venue length limits", () => {
    const id = deriveTrancheClientOrderId(intent, "i1:0");
    expect(id.startsWith("px-")).toBe(true);
    expect(id.length).toBeLessThanOrEqual(36);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/plugin-cex && npx vitest run __tests__/strategyEngine.idempotency.test.ts`
Expected: FAIL — cannot find `deriveTrancheClientOrderId`.

- [ ] **Step 3: Write the implementation**

`packages/plugin-cex/src/strategy/engine/idempotency.ts`:

```ts
import { createHash } from "node:crypto";
import type { CanonicalIntent } from "../../intent/canonicalIntent";
import { computeIntentHash, deriveClientOrderId } from "../../idempotency/intentHash";

/**
 * Derive a per-tranche paper client_order_id. We salt the deterministic intent
 * hash with `salt` (use `${instance_id}:${tick_count}`): identical retries of
 * the SAME tick produce the SAME id (dedupe), while distinct DCA tranches
 * (different tick_count) produce DIFFERENT ids and so all fire.
 */
export function deriveTrancheClientOrderId(intent: CanonicalIntent, salt: string): string {
  const base = computeIntentHash(intent);
  const salted = createHash("sha256").update(`${base}:${salt}`).digest("hex");
  return deriveClientOrderId(salted, "paper");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/plugin-cex && npx vitest run __tests__/strategyEngine.idempotency.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-cex/src/strategy/engine/idempotency.ts packages/plugin-cex/__tests__/strategyEngine.idempotency.test.ts
git commit -m "feat(cex): salted per-tranche client_order_id (DCA dedupe fix)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3.2: Position tracker

Pure functions that update a `StrategyPosition` from a fill and compute realized PnL. SELL realizes `(price - avg_entry) * qty_closed`; BUY blends the average entry. No I/O.

**Files:**
- Create: `packages/plugin-cex/src/strategy/engine/positionTracker.ts`
- Test: `packages/plugin-cex/__tests__/positionTracker.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/plugin-cex/__tests__/positionTracker.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { applyFill, unrealizedBps } from "../src/strategy/engine/positionTracker";

const flat = { base_qty: 0, avg_entry_price: 0, realized_pnl_usd: 0 };

describe("applyFill", () => {
  it("a BUY opens a position at the fill price", () => {
    const { position, realizedDelta } = applyFill(flat, { side: "BUY", qty: 2, price: 100 });
    expect(position).toEqual({ base_qty: 2, avg_entry_price: 100, realized_pnl_usd: 0 });
    expect(realizedDelta).toBe(0);
  });

  it("a second BUY blends the average entry", () => {
    const after1 = applyFill(flat, { side: "BUY", qty: 2, price: 100 }).position;
    const { position } = applyFill(after1, { side: "BUY", qty: 2, price: 200 });
    expect(position.base_qty).toBe(4);
    expect(position.avg_entry_price).toBeCloseTo(150, 6);
  });

  it("a SELL realizes PnL against the average entry", () => {
    const open = applyFill(flat, { side: "BUY", qty: 2, price: 100 }).position;
    const { position, realizedDelta } = applyFill(open, { side: "SELL", qty: 2, price: 120 });
    expect(realizedDelta).toBeCloseTo(40, 6); // (120-100)*2
    expect(position.base_qty).toBe(0);
    expect(position.realized_pnl_usd).toBeCloseTo(40, 6);
  });

  it("a partial SELL realizes proportional PnL and keeps the average entry", () => {
    const open = applyFill(flat, { side: "BUY", qty: 4, price: 100 }).position;
    const { position, realizedDelta } = applyFill(open, { side: "SELL", qty: 1, price: 110 });
    expect(realizedDelta).toBeCloseTo(10, 6);
    expect(position.base_qty).toBe(3);
    expect(position.avg_entry_price).toBe(100);
  });
});

describe("unrealizedBps", () => {
  it("is positive when mid is above entry", () => {
    expect(unrealizedBps({ base_qty: 1, avg_entry_price: 100, realized_pnl_usd: 0 }, 105)).toBeCloseTo(500, 6);
  });
  it("is 0 for a flat position", () => {
    expect(unrealizedBps(flat, 105)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/plugin-cex && npx vitest run __tests__/positionTracker.test.ts`
Expected: FAIL — cannot find `applyFill`.

- [ ] **Step 3: Write the implementation**

`packages/plugin-cex/src/strategy/engine/positionTracker.ts`:

```ts
import type { StrategyPosition } from "./strategyInstance";

export interface FillInput {
  side: "BUY" | "SELL";
  qty: number;
  price: number;
}

export interface ApplyFillResult {
  position: StrategyPosition;
  realizedDelta: number; // USD realized by this fill (SELL only; 0 for BUY)
}

/** Long-only position math (paper). SELL realizes PnL; BUY blends avg entry. */
export function applyFill(prev: StrategyPosition, fill: FillInput): ApplyFillResult {
  if (fill.side === "BUY") {
    const newQty = prev.base_qty + fill.qty;
    const avg =
      newQty > 0
        ? (prev.base_qty * prev.avg_entry_price + fill.qty * fill.price) / newQty
        : 0;
    return {
      position: { base_qty: newQty, avg_entry_price: avg, realized_pnl_usd: prev.realized_pnl_usd },
      realizedDelta: 0,
    };
  }
  // SELL
  const closed = Math.min(fill.qty, prev.base_qty);
  const realizedDelta = (fill.price - prev.avg_entry_price) * closed;
  const newQty = Math.max(0, prev.base_qty - fill.qty);
  return {
    position: {
      base_qty: newQty,
      avg_entry_price: newQty > 0 ? prev.avg_entry_price : 0,
      realized_pnl_usd: prev.realized_pnl_usd + realizedDelta,
    },
    realizedDelta,
  };
}

/** Unrealized PnL in bps vs the average entry, given the current mid. 0 if flat. */
export function unrealizedBps(pos: StrategyPosition, mid: number): number {
  if (pos.base_qty <= 0 || pos.avg_entry_price <= 0) return 0;
  return ((mid - pos.avg_entry_price) / pos.avg_entry_price) * 10_000;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/plugin-cex && npx vitest run __tests__/positionTracker.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-cex/src/strategy/engine/positionTracker.ts packages/plugin-cex/__tests__/positionTracker.test.ts
git commit -m "feat(cex): positionTracker — fill-driven position + realized/unrealized PnL

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3.3: `runTick` orchestrator

The idempotent core. `runTick(deps)` lists active instances and processes each **armed, due** instance: compute signals → freshness/missing gate → TP/SL → `runStrategyOnce` → force paper → salted id → risk precheck → paper createOrder → position/PnL update → notify → daily-loss halt → schedule next eval → persist. Injected deps make it agent-free testable.

**Files:**
- Create: `packages/plugin-cex/src/strategy/engine/engineTick.ts`
- Test: `packages/plugin-cex/__tests__/engineTick.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/plugin-cex/__tests__/engineTick.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { runTick, type EngineDeps } from "../src/strategy/engine/engineTick";
import { InMemoryStrategyInstanceStore } from "../src/strategy/engine/strategyInstanceStore";
import { newArmedInstance } from "../src/strategy/engine/strategyInstance";

const NOW = Date.parse("2026-06-14T12:00:00Z");

// Minimal valid DSL: one pct_from_high dip entry, one exit, TP/SL set.
function makeDsl(over: any = {}) {
  return {
    identity: { id: "s1", version: 1, owner: "u1", status: "paper", mode: "paper" },
    universe: { venue: "paper", symbols: ["BTCUSDT"] },
    signals: [{ id: "dip", kind: "price.pct_from_high", params: { window: 20 } }],
    entries: [{ id: "e1", when: { op: "lt", args: ["dip", -5] }, then: { order_type: "market", side: "BUY", sizing: { kind: "quote_size", value: 100 } } }],
    exits: [{ id: "x1", when: { op: "gt", args: ["dip", 100] }, then: { order_type: "market", side: "SELL", sizing: { kind: "pct_equity", value: 100 } } }],
    risk: { max_position_notional_usd: 10_000, max_daily_loss_usd: 50, max_concurrent_positions: 1, per_trade_take_profit_bps: 300, per_trade_stop_loss_bps: 200, slippage_bps_max: 50 },
    operations: { evaluation_interval_seconds: 30, persistent: true, halt_on_error: true },
    resilience: { auto_kill_on_loss_limit: true, pause_on_market_data_lag_s: 600 },
    ...over,
  } as any;
}

// Controllable harness. signalValue drives the "dip" signal; createOrder fills deterministically.
function harness(opts: {
  signalValue: number;        // value of signals.dip
  mid?: number;
  fresh?: boolean;
  missing?: string[];
  riskVerdict?: "allow" | "block";
  fill?: { qty: number; price: number };
}) {
  const store = new InMemoryStrategyInstanceStore();
  const calls: any = { created: [], notified: [], risk: 0 };
  const deps: EngineDeps = {
    store,
    now: () => NOW,
    computeSignals: async () => ({
      context: opts.missing && opts.missing.length
        ? null
        : { signals: { dip: opts.signalValue }, equityUsd: 10_000, midPrice: opts.mid ?? 100 },
      fresh: opts.fresh ?? true,
      ageMs: 0,
      missing: opts.missing ?? [],
    }),
    runRisk: () => {
      calls.risk++;
      return { verdict: opts.riskVerdict ?? "allow", rules_fired: [], explanations: [], rule_results: [] } as any;
    },
    createOrder: async (intent: any) => {
      calls.created.push(intent.idempotency.client_order_id);
      const f = opts.fill ?? { qty: 1, price: opts.mid ?? 100 };
      return { ok: true, client_order_id: intent.idempotency.client_order_id, side: intent.side, qty: f.qty, price: f.price };
    },
    notify: async (_u, _i, fill) => { calls.notified.push(fill); },
  };
  return { store, deps, calls };
}

async function seed(store: InMemoryStrategyInstanceStore, dsl: any, over: any = {}) {
  const inst = newArmedInstance({ instance_id: "i1", user_id: "u1", dsl, nowMs: NOW - 1000 });
  Object.assign(inst, over);
  await store.put(inst);
  return inst;
}

describe("runTick", () => {
  it("no-op when no rule fires and no position (no order)", async () => {
    const { store, deps, calls } = harness({ signalValue: 0 }); // dip=0, entry needs <-5
    await seed(store, makeDsl());
    await runTick(deps);
    expect(calls.created).toEqual([]);
    expect((await store.get("i1"))!.tick_count).toBe(1); // tick still counted + rescheduled
  });

  it("entry fires when the dip rule matches", async () => {
    const { store, deps, calls } = harness({ signalValue: -6, mid: 100, fill: { qty: 1, price: 100 } });
    await seed(store, makeDsl());
    await runTick(deps);
    expect(calls.created.length).toBe(1);
    const inst = await store.get("i1");
    expect(inst!.position.base_qty).toBe(1);
    expect(inst!.fills.length).toBe(1);
  });

  it("skips the tick when a required signal is missing (no fabrication)", async () => {
    const { store, deps, calls } = harness({ signalValue: -6, missing: ["dip"] });
    await seed(store, makeDsl());
    await runTick(deps);
    expect(calls.created).toEqual([]);
    expect(calls.risk).toBe(0);
  });

  it("skips the tick when market data is stale", async () => {
    const { store, deps, calls } = harness({ signalValue: -6, fresh: false });
    await seed(store, makeDsl());
    await runTick(deps);
    expect(calls.created).toEqual([]);
  });

  it("paused instances are not processed", async () => {
    const { store, deps, calls } = harness({ signalValue: -6 });
    await seed(store, makeDsl(), { status: "paused" });
    await runTick(deps);
    expect(calls.created).toEqual([]);
  });

  it("risk block skips the order and increments the block counter; threshold pauses", async () => {
    const { store, deps, calls } = harness({ signalValue: -6, riskVerdict: "block" });
    await seed(store, makeDsl(), { consecutive_risk_blocks: 2 }); // threshold 3
    await runTick(deps);
    expect(calls.created).toEqual([]);
    expect((await store.get("i1"))!.status).toBe("paused");
  });

  it("TP hit exits an open position", async () => {
    // open position at 100, mid 105 → +500bps >= TP 300bps → SELL
    const { store, deps, calls } = harness({ signalValue: 0, mid: 105, fill: { qty: 1, price: 105 } });
    await seed(store, makeDsl(), { position: { base_qty: 1, avg_entry_price: 100, realized_pnl_usd: 0 } });
    await runTick(deps);
    expect(calls.created.length).toBe(1);
    expect((await store.get("i1"))!.position.base_qty).toBe(0);
  });

  it("SL hit exits an open position", async () => {
    // open at 100, mid 97 → -300bps <= -SL 200bps → SELL
    const { store, deps, calls } = harness({ signalValue: 0, mid: 97, fill: { qty: 1, price: 97 } });
    await seed(store, makeDsl(), { position: { base_qty: 1, avg_entry_price: 100, realized_pnl_usd: 0 } });
    await runTick(deps);
    expect(calls.created.length).toBe(1);
    expect((await store.get("i1"))!.position.base_qty).toBe(0);
  });

  it("daily loss limit halts the instance after a realized loss", async () => {
    // open at 100, SL exit at 97 realizes -3 *... ensure loss exceeds max_daily_loss_usd=50
    const { store, deps, calls } = harness({ signalValue: 0, mid: 50, fill: { qty: 1, price: 50 } });
    await seed(store, makeDsl(), { position: { base_qty: 1, avg_entry_price: 100, realized_pnl_usd: 0 } });
    await runTick(deps);
    const inst = await store.get("i1");
    expect(inst!.position.realized_pnl_usd).toBeLessThanOrEqual(-50);
    expect(inst!.status).toBe("halted");
  });

  it("reschedules next_eval_at by evaluation_interval_seconds", async () => {
    const { store, deps } = harness({ signalValue: 0 });
    await seed(store, makeDsl());
    await runTick(deps);
    expect((await store.get("i1"))!.next_eval_at).toBe(new Date(NOW + 30_000).toISOString());
  });

  it("not-due instances are skipped", async () => {
    const { store, deps, calls } = harness({ signalValue: -6 });
    await seed(store, makeDsl(), { next_eval_at: new Date(NOW + 60_000).toISOString() });
    await runTick(deps);
    expect(calls.created).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/plugin-cex && npx vitest run __tests__/engineTick.test.ts`
Expected: FAIL — cannot find `runTick`.

- [ ] **Step 3: Write the implementation**

`packages/plugin-cex/src/strategy/engine/engineTick.ts`:

```ts
import { elizaLogger } from "@elizaos/core";
import type { CanonicalIntent } from "../../intent/canonicalIntent";
import { buildCanonicalIntent } from "../../intent/intentBuilder";
import type { RiskDecision, RiskEvaluationContext } from "../../risk/types";
import { DEFAULT_USER_TRADING_PREFERENCES } from "../../risk/types";
import { runStrategyOnce } from "../strategyRuntime";
import type { StrategyDSL } from "../strategyDSL";
import type { StrategyInstance, StrategyFill } from "./strategyInstance";
import { dayAnchor } from "./strategyInstance";
import type { StrategyInstanceStore } from "./strategyInstanceStore";
import type { SignalComputeResult } from "./signalCompute";
import { applyFill, unrealizedBps } from "./positionTracker";
import { deriveTrancheClientOrderId } from "./idempotency";

export interface FillResult {
  ok: boolean;
  client_order_id: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  error?: string;
}

export interface EngineDeps {
  store: StrategyInstanceStore;
  now: () => number;
  /** Wraps computeSignals() with the live market-data deps; mockable in tests. */
  computeSignals: (args: { dsl: StrategyDSL; symbol: string; nowMs: number; userId: string }) => Promise<SignalComputeResult>;
  runRisk: (intent: CanonicalIntent, ctx: RiskEvaluationContext) => RiskDecision;
  createOrder: (intent: CanonicalIntent) => Promise<FillResult>;
  notify: (userId: string, instance: StrategyInstance, fill: StrategyFill) => Promise<void>;
}

const RISK_BLOCK_PAUSE_THRESHOLD = Number(process.env.STRATEGY_ENGINE_RISK_BLOCK_PAUSE ?? 3);

export interface RunTickSummary {
  processed: number;
  fills: number;
  skipped: number;
  halted: number;
}

/** One idempotent pass over all armed, due instances. */
export async function runTick(deps: EngineDeps): Promise<RunTickSummary> {
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  const active = await deps.store.listActive();
  const summary: RunTickSummary = { processed: 0, fills: 0, skipped: 0, halted: 0 };

  for (const inst of active) {
    if (inst.status !== "armed") continue;            // paused not traded
    if (Date.parse(inst.next_eval_at) > nowMs) continue; // not due
    summary.processed++;
    try {
      const outcome = await processInstance(inst, deps, nowMs, nowIso);
      summary.fills += outcome.filled ? 1 : 0;
      summary.skipped += outcome.skipped ? 1 : 0;
      summary.halted += outcome.halted ? 1 : 0;
    } catch (err) {
      inst.last_error = err instanceof Error ? err.message : String(err);
      inst.last_tick_at = nowIso;
      inst.next_eval_at = scheduleNext(inst.dsl, nowMs);
      await deps.store.put(inst);
      elizaLogger.error(`[strategy-engine] tick error instance=${inst.instance_id}: ${inst.last_error}`);
    }
  }
  return summary;
}

interface InstanceOutcome { filled: boolean; skipped: boolean; halted: boolean; }

async function processInstance(
  inst: StrategyInstance,
  deps: EngineDeps,
  nowMs: number,
  nowIso: string,
): Promise<InstanceOutcome> {
  // Daily-loss window rollover.
  const anchor = dayAnchor(nowMs);
  if (anchor !== inst.day_anchor) {
    inst.day_anchor = anchor;
    inst.day_realized_pnl_usd = 0;
  }

  const symbol = inst.dsl.universe.symbols[0];
  const sc = await deps.computeSignals({ dsl: inst.dsl, symbol, nowMs, userId: inst.user_id });

  // Freshness / missing gate — never fabricate a signal.
  if (!sc.context || !sc.fresh || sc.missing.length > 0) {
    inst.last_tick_at = nowIso;
    inst.tick_count += 1;
    inst.next_eval_at = scheduleNext(inst.dsl, nowMs);
    inst.last_error = !sc.context ? "no_market_data" : sc.missing.length ? `missing:${sc.missing.join(",")}` : "stale";
    await deps.store.put(inst);
    return { filled: false, skipped: true, halted: false };
  }
  inst.last_error = null;
  const mid = sc.context.midPrice;

  // 1) Engine-direct TP/SL (independent of the rule engine).
  let intent: CanonicalIntent | null = null;
  const tpSl = checkTpSl(inst, mid);
  if (tpSl) {
    intent = buildSellIntent(inst.dsl, inst.user_id, inst.position.base_qty, mid);
  } else {
    // 2) Rule engine (paper-forced, runtime "running").
    const trigger = runStrategyOnce({
      strategy: inst.dsl,
      context: sc.context,
      userId: inst.user_id,
      locale: "en" as never,
      modeOverride: "paper" as never,
      runtimeStatus: "running",
    });
    if (trigger.kind !== "noop") intent = trigger.intent;
  }

  if (!intent) {
    inst.last_tick_at = nowIso;
    inst.tick_count += 1;
    inst.next_eval_at = scheduleNext(inst.dsl, nowMs);
    await deps.store.put(inst);
    return { filled: false, skipped: false, halted: false };
  }

  // Force paper (belt-and-suspenders) + salted idempotent id.
  intent.mode = "paper" as never;
  intent.idempotency = {
    ...intent.idempotency,
    client_order_id: deriveTrancheClientOrderId(intent, `${inst.instance_id}:${inst.tick_count}`),
  };

  // Risk precheck with the strategy's risk.* as the envelope.
  const ctx = buildRiskContext(inst, mid, sc, nowMs);
  const decision = deps.runRisk(intent, ctx);
  if (decision.verdict !== "allow") {
    inst.consecutive_risk_blocks += 1;
    if (inst.consecutive_risk_blocks >= RISK_BLOCK_PAUSE_THRESHOLD) inst.status = "paused";
    inst.last_error = `risk_${decision.verdict}:${decision.rules_fired.join(",")}`;
    inst.last_tick_at = nowIso;
    inst.tick_count += 1;
    inst.next_eval_at = scheduleNext(inst.dsl, nowMs);
    await deps.store.put(inst);
    elizaLogger.info(`[strategy-engine] risk ${decision.verdict} instance=${inst.instance_id} rules=${decision.rules_fired.join(",")}`);
    return { filled: false, skipped: true, halted: false };
  }
  inst.consecutive_risk_blocks = 0;

  // Execute against the paper venue.
  const fill = await deps.createOrder(intent);
  if (!fill.ok) {
    inst.last_error = `order_failed:${fill.error ?? "unknown"}`;
    inst.last_tick_at = nowIso;
    inst.tick_count += 1;
    inst.next_eval_at = scheduleNext(inst.dsl, nowMs);
    await deps.store.put(inst);
    return { filled: false, skipped: true, halted: false };
  }

  // Update position + realized PnL.
  const { position, realizedDelta } = applyFill(inst.position, { side: fill.side, qty: fill.qty, price: fill.price });
  inst.position = position;
  inst.day_realized_pnl_usd += realizedDelta;
  const fillRow: StrategyFill = {
    client_order_id: fill.client_order_id, side: fill.side, qty: fill.qty, price: fill.price, ts: nowIso,
  };
  inst.fills.push(fillRow);
  inst.last_fill_at = nowIso;
  inst.tick_count += 1;
  inst.last_tick_at = nowIso;

  // Daily-loss auto-kill.
  let halted = false;
  const autoKill = inst.dsl.resilience?.auto_kill_on_loss_limit !== false;
  if (autoKill && inst.day_realized_pnl_usd <= -inst.dsl.risk.max_daily_loss_usd) {
    inst.status = "halted";
    inst.last_error = "daily_loss_limit";
    halted = true;
  }

  inst.next_eval_at = scheduleNext(inst.dsl, nowMs);
  await deps.store.put(inst);
  await deps.notify(inst.user_id, inst, fillRow);
  return { filled: true, skipped: false, halted };
}

/** Returns "tp" | "sl" if an open position has crossed its TP/SL threshold. */
function checkTpSl(inst: StrategyInstance, mid: number): "tp" | "sl" | null {
  if (inst.position.base_qty <= 0) return null;
  const bps = unrealizedBps(inst.position, mid);
  const tp = inst.dsl.risk.per_trade_take_profit_bps;
  const sl = inst.dsl.risk.per_trade_stop_loss_bps;
  if (tp !== undefined && bps >= tp) return "tp";
  if (sl !== undefined && bps <= -sl) return "sl";
  return null;
}

/** Build a market SELL of the full base position, mirroring strategyRuntime.ts:154-171. */
function buildSellIntent(dsl: StrategyDSL, userId: string, baseQty: number, mid: number): CanonicalIntent {
  const venue = dsl.universe.venue as never;
  const symbol = dsl.universe.symbols[0];
  return buildCanonicalIntent({
    action: "create_order",
    venue,
    userId: userId as never,
    locale: "en" as never,
    mode: "paper" as never,
    params: {
      userId: userId as never,
      product_id: symbol,
      symbol,
      side: "SELL",
      order_configuration: { market_market_ioc: { base_size: baseQty.toFixed(8) } },
    } as never,
    policyContext: {
      max_order_notional_usd: dsl.risk.max_position_notional_usd,
      daily_loss_limit_usd: dsl.risk.max_daily_loss_usd,
    } as never,
  } as never) as CanonicalIntent;
}

/** Risk envelope = the strategy's risk.* (NOT the user's global prefs). */
function buildRiskContext(
  inst: StrategyInstance,
  mid: number,
  sc: SignalComputeResult,
  nowMs: number,
): RiskEvaluationContext {
  const risk = inst.dsl.risk;
  return {
    preferences: {
      ...DEFAULT_USER_TRADING_PREFERENCES,
      userId: inst.user_id,
      max_order_notional_usd: risk.max_position_notional_usd,
      daily_loss_limit_usd: risk.max_daily_loss_usd,
      slippage_bps_max: risk.slippage_bps_max ?? DEFAULT_USER_TRADING_PREFERENCES.slippage_bps_max,
      default_mode: "paper",
      kill_switch_active: false,
      updatedAt: new Date(nowMs).toISOString(),
    },
    estimated_notional_usd: mid * inst.position.base_qty,
    market_mid_usd: mid,
    market_data_age_ms: sc.ageMs,
    rolling_24h_pnl_usd: inst.day_realized_pnl_usd,
    now_ms: nowMs,
  };
}

function scheduleNext(dsl: StrategyDSL, nowMs: number): string {
  const sec = Math.max(1, Number(dsl.operations.evaluation_interval_seconds ?? 30));
  return new Date(nowMs + sec * 1000).toISOString();
}
```

> **Implementation note for the worker:** confirm the import path for `buildCanonicalIntent` matches `strategyRuntime.ts`'s import (it is `../intent/intentBuilder` from `strategy/`, hence `../../intent/intentBuilder` from `strategy/engine/`). If the `as never` casts on `buildCanonicalIntent`/`runStrategyOnce` args cause friction, copy the exact arg types those functions export instead — the call shapes here mirror `strategyRuntime.ts:154-179` verbatim.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/plugin-cex && npx vitest run __tests__/engineTick.test.ts`
Expected: PASS (12 tests). If the daily-loss test's realized loss math needs tuning, the seeded `mid`/`fill.price` controls it: SELL 1 unit bought at 100 and sold at 50 realizes -50, which is `<= -max_daily_loss_usd(50)`.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-cex/src/strategy/engine/engineTick.ts packages/plugin-cex/__tests__/engineTick.test.ts
git commit -m "feat(cex): runTick orchestrator (signals->TP/SL->rules->risk->paper fill->PnL)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3.4: Notifier (chat event + persisted Memory)

On each fill, push an SSE event to the user's live tabs via `emitEventToUser` (`@elizaos/core`) and persist a `Memory` (so a fill that lands after the stream closed is still visible on refresh — the PR #153 `persisted-only` pattern). The Memory carries `metadata` so the chat UI renders it.

**Files:**
- Create: `packages/plugin-cex/src/strategy/engine/notifier.ts`
- Test: `packages/plugin-cex/__tests__/strategyEngine.notifier.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/plugin-cex/__tests__/strategyEngine.notifier.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/plugin-cex && npx vitest run __tests__/strategyEngine.notifier.test.ts`
Expected: FAIL — cannot find `buildFillMemory`.

- [ ] **Step 3: Write the implementation**

`packages/plugin-cex/src/strategy/engine/notifier.ts`:

```ts
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
    const mem = buildFillMemory({ runtimeAgentId: runtime.agentId, roomId, instance, fill });
    await runtime.messageManager.createMemory(mem, "messages");
  };
}
```

> **Worker note:** confirm `stringToUuid` is exported from `@elizaos/core` (it is — used widely, e.g. `cexWorkflowMessageHandler.ts`). `roomIdFor` in production maps the user to their strategy room; for the first cut, persist into a deterministic per-user room `stringToUuid(\`strategy-room-${userId}\`)` (defined in Task 3.5 wiring).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/plugin-cex && npx vitest run __tests__/strategyEngine.notifier.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-cex/src/strategy/engine/notifier.ts packages/plugin-cex/__tests__/strategyEngine.notifier.test.ts
git commit -m "feat(cex): strategy fill notifier (SSE event + persisted memory)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3.5: `StrategyEngineService` (loop, re-entrancy guard, wiring, resume)

The registered `Service`. Builds the live `EngineDeps` (SQLite store from `runtime.databaseAdapter.db`, klines via `fetchOhlcvBarsSafe`, mid via `fetchBinanceUsdtPrices`, equity via the paper venue, sentiment via `getLatestSentiment`, risk via `evaluate`, createOrder via the runtime-bound paper venue, notifier from Task 3.4) and runs a re-entrancy-guarded `setInterval` loop.

**Files:**
- Create: `packages/plugin-cex/src/strategy/engine/strategyEngineService.ts`
- Modify: `packages/plugin-cex/package.json` (add `@elizaos-plugins/plugin-sentiscore` workspace dep for `getLatestSentiment`)
- Test: `packages/plugin-cex/__tests__/strategyEngineService.test.ts`

- [ ] **Step 1: Write the failing test (guard + lifecycle only — wiring is integration-tested live)**

`packages/plugin-cex/__tests__/strategyEngineService.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { StrategyEngineService } from "../src/strategy/engine/strategyEngineService";

describe("StrategyEngineService", () => {
  it("exposes the STRATEGY_ENGINE serviceType", () => {
    expect(StrategyEngineService.serviceType).toBe("strategy_engine");
  });

  it("re-entrancy guard prevents overlapping ticks", async () => {
    const svc = new StrategyEngineService();
    let running = 0;
    let maxConcurrent = 0;
    // Inject a slow runTick via the test seam.
    (svc as any).runTickFn = async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return { processed: 0, fills: 0, skipped: 0, halted: 0 };
    };
    await Promise.all([(svc as any).tick(), (svc as any).tick(), (svc as any).tick()]);
    expect(maxConcurrent).toBe(1); // overlapping calls were skipped
  });

  it("stop() clears the interval and is idempotent", async () => {
    const svc = new StrategyEngineService();
    (svc as any).intervalHandle = setInterval(() => {}, 1000);
    await svc.stop();
    await svc.stop();
    expect((svc as any).intervalHandle).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/plugin-cex && npx vitest run __tests__/strategyEngineService.test.ts`
Expected: FAIL — cannot find `StrategyEngineService`.

- [ ] **Step 3: Add the workspace dependency**

In `packages/plugin-cex/package.json`, add to `dependencies` (match the version style of the other `@elizaos-plugins/*` entries, typically `"workspace:*"`):

```json
    "@elizaos-plugins/plugin-sentiscore": "workspace:*"
```

Then run `pnpm install` from the repo root to link it.

- [ ] **Step 4: Write the implementation**

`packages/plugin-cex/src/strategy/engine/strategyEngineService.ts`:

```ts
import { Service, ServiceType, type IAgentRuntime, type UUID, stringToUuid, elizaLogger } from "@elizaos/core";
import { getLatestSentiment } from "@elizaos-plugins/plugin-sentiscore";
import { fetchOhlcvBarsSafe } from "../../backtest/realDataSource";
import { fetchBinanceUsdtPrices } from "../../exchanges/services/binancePricing";
import { createPaperVenueForRuntime } from "../../actions/shared";
import { evaluate } from "../../risk/riskEngine";
import { computeSignals, type SignalComputeDeps } from "./signalCompute";
import { SqliteStrategyInstanceStore, type SqliteHandle } from "./sqliteStrategyInstanceStore";
import { type StrategyInstanceStore } from "./strategyInstanceStore";
import { runTick, type EngineDeps, type FillResult } from "./engineTick";
import { makeNotifier } from "./notifier";
import type { CanonicalIntent } from "../../intent/canonicalIntent";

const TICK_MS = Number(process.env.STRATEGY_ENGINE_TICK_MS ?? 15_000);

/** "paper" venue strategies fetch klines/mid from Binance public endpoints. */
function dataVenue(venue: string): "binance" | "coinbase" {
  return venue === "coinbase" ? "coinbase" : "binance";
}
function baseAsset(symbol: string): string {
  return symbol.replace(/USDT$|USDC$|USD$|-.*$/i, "") || symbol;
}

export class StrategyEngineService extends Service {
  static get serviceType(): ServiceType {
    return ServiceType.STRATEGY_ENGINE;
  }

  private runtime: IAgentRuntime | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private deps: EngineDeps | null = null;
  // Test seam: overridable runTick.
  private runTickFn: (deps: EngineDeps) => Promise<unknown> = runTick as never;

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
  }

  /** Called from agent startup AFTER registration when the flag is on. */
  async start(): Promise<void> {
    if (!this.runtime) throw new Error("StrategyEngineService.start() before initialize()");
    const adapter = this.runtime.databaseAdapter as unknown as { db?: SqliteHandle };
    if (!adapter?.db) {
      elizaLogger.warn("[strategy-engine] no SQLite handle on databaseAdapter; engine disabled (Mongo store parity is a follow-up). Not starting.");
      return;
    }
    const store: StrategyInstanceStore = new SqliteStrategyInstanceStore(adapter.db);
    this.deps = this.buildDeps(this.runtime, store);

    const active = await store.listActive();
    elizaLogger.info(`[strategy-engine] starting: tick_ms=${TICK_MS} resumed_active=${active.length}`);
    this.intervalHandle = setInterval(() => void this.tick(), TICK_MS);
    if (this.intervalHandle.unref) this.intervalHandle.unref();
  }

  async stop(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Re-entrancy-guarded single pass. */
  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this.deps) await this.runTickFn(this.deps);
    } catch (err) {
      elizaLogger.error(`[strategy-engine] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  private buildDeps(runtime: IAgentRuntime, store: StrategyInstanceStore): EngineDeps {
    const signalDeps: SignalComputeDeps = {
      fetchKlines: ({ venue, symbol, intervalMs, count, endTs }) =>
        fetchOhlcvBarsSafe({ venue: dataVenue(venue), symbol, intervalMs, count, endTs }),
      fetchMid: async (_venue, symbol) => {
        const prices = await fetchBinanceUsdtPrices([symbol]);
        return prices?.[0]?.price ?? null;
      },
      getEquityUsd: async (userId, venue) => {
        const paper = await createPaperVenueForRuntime(runtime, dataVenue(venue));
        const bal = (await (paper as any).accounts.getBalance({ userId })) as {
          accounts?: Array<{ asset: string; available: string }>;
        };
        // USD/USDT/USDC are quote; everything else valued at its mid.
        let usd = 0;
        for (const a of bal.accounts ?? []) {
          const q = Number(a.available) || 0;
          if (/^USD[TC]?$/i.test(a.asset)) usd += q;
        }
        return usd > 0 ? usd : 10_000; // paper default starting equity
      },
      getSentiment: async (symbol) => getLatestSentiment(baseAsset(symbol)),
    };

    const createOrder = async (intent: CanonicalIntent): Promise<FillResult> => {
      const paper = await createPaperVenueForRuntime(runtime, dataVenue(intent.venue as string));
      const params = intentToCreateParams(intent);
      const res = (await (paper as any).orders.createOrder(params)) as {
        success?: boolean;
        order?: { side: string; quantity?: string | number; price?: string | number };
        error?: string;
      };
      const order = res?.order;
      if (!res?.success || !order) {
        return { ok: false, client_order_id: intent.idempotency.client_order_id, side: intent.side as never, qty: 0, price: 0, error: res?.error ?? "no_fill" };
      }
      return {
        ok: true,
        client_order_id: intent.idempotency.client_order_id,
        side: order.side as "BUY" | "SELL",
        qty: Number(order.quantity ?? 0),
        price: Number(order.price ?? 0),
      };
    };

    const notify = makeNotifier(runtime, (userId) => stringToUuid(`strategy-room-${userId}`) as UUID);

    return {
      store,
      now: () => Date.now(),
      computeSignals: ({ dsl, symbol, nowMs, userId }) => computeSignals({ dsl, symbol, nowMs, userId, deps: signalDeps }),
      runRisk: (intent, ctx) => evaluate(intent, ctx),
      createOrder,
      notify,
    };
  }
}

/**
 * Project a CanonicalIntent to the paper venue's createOrder params.
 * VERIFY against paperVenue.ts:164-246 (CreateOrderParams + response shape).
 */
function intentToCreateParams(intent: CanonicalIntent): Record<string, unknown> {
  const size = intent.size ?? {};
  const order_configuration =
    intent.order_type === "limit"
      ? { limit_limit_gtc: { base_size: (size as any).base_size, limit_price: intent.price_params?.limit_price } }
      : { market_market_ioc: { base_size: (size as any).base_size, quote_size: (size as any).quote_size } };
  return {
    userId: intent.user_id,
    product_id: intent.symbol,
    side: intent.side,
    order_configuration,
    client_order_id: intent.idempotency.client_order_id,
  };
}
```

> **Worker note (live verification):** the wiring functions (`createPaperVenueForRuntime`, `fetchBinanceUsdtPrices`, `fetchOhlcvBarsSafe`, the paper `createOrder`/`getBalance` response field names) are exercised by the Phase 3 live test (Task 7 of §Testing), not unit tests. Before that run, confirm: (a) `intent.raw_order_configuration` is not needed because we rebuild `order_configuration` from `order_type`/`size`/`price_params`; (b) the paper `createOrder` response exposes `order.quantity` and `order.price` (paperVenue.ts:164-246) — adjust `Number(order.quantity)`/`Number(order.price)` to the actual field names if they differ (e.g. `filled_size`/`average_filled_price`).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/plugin-cex && npx vitest run __tests__/strategyEngineService.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-cex/src/strategy/engine/strategyEngineService.ts packages/plugin-cex/package.json pnpm-lock.yaml
git commit -m "feat(cex): StrategyEngineService — guarded loop, live deps wiring, resume

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3.6: Register the service at agent startup behind `STRATEGY_ENGINE_ENABLED`

Mirror the `ReconciliationService` registration in `agent/src/index.ts` (after the DB adapter is set up, before `runtime.initialize()`), but gate purely on the env flag (default off). After registration, call `initialize()` + `start()`.

**Files:**
- Modify: `agent/src/index.ts` (near the `ReconciliationService` registration)

- [ ] **Step 1: Locate the registration site**

Run:
```bash
grep -n "ReconciliationService\|registerService\|STRATEGY_ENGINE" agent/src/index.ts
```
Expected: the block where `ReconciliationService` is constructed and `runtime.registerService(...)` is called.

- [ ] **Step 2: Add the import**

At the top of `agent/src/index.ts`, alongside the other plugin-cex imports, add:

```ts
import { StrategyEngineService } from "@elizaos-plugins/plugin-cex/src/strategy/engine/strategyEngineService";
```

(Match the import style already used for plugin-cex internals in this file; if the file imports from the package root barrel, export `StrategyEngineService` from `packages/plugin-cex/src/index.ts` and import it from `@elizaos-plugins/plugin-cex` instead.)

- [ ] **Step 3: Register + start after the ReconciliationService block**

Immediately AFTER the existing `runtime.registerService(reconciliationService)` line (or the end of that block), add:

```ts
    // StrategyEngineService — paper-only auto-execution. Off by default; gated
    // purely on STRATEGY_ENGINE_ENABLED. Requires a SQLite-backed adapter
    // (Mongo store parity is a follow-up); start() no-ops without one.
    if ((runtime.getSetting("STRATEGY_ENGINE_ENABLED") ?? process.env.STRATEGY_ENGINE_ENABLED) === "true") {
      const strategyEngine = new StrategyEngineService();
      runtime.registerService(strategyEngine);
      await strategyEngine.initialize(runtime);
      await strategyEngine.start();
      elizaLogger.info("[strategy-engine] registered + started (STRATEGY_ENGINE_ENABLED=true)");
    } else {
      elizaLogger.info("[strategy-engine] disabled (STRATEGY_ENGINE_ENABLED not 'true')");
    }
```

- [ ] **Step 4: Export the service from the plugin barrel (so the import resolves cleanly)**

In `packages/plugin-cex/src/index.ts`, add:

```ts
export { StrategyEngineService } from "./strategy/engine/strategyEngineService";
```

- [ ] **Step 5: Build the agent to verify wiring compiles**

Run:
```bash
pnpm --filter @elizaos/core build && pnpm --filter @elizaos-plugins/plugin-cex build && pnpm --filter @elizaos-plugins/plugin-sentiscore build
```
Expected: all three build clean. (If `agent` has a typecheck/build step, run it too: `pnpm --filter @sentiedge/agent build`.)

- [ ] **Step 6: Commit**

```bash
git add agent/src/index.ts packages/plugin-cex/src/index.ts
git commit -m "feat(agent): register StrategyEngineService behind STRATEGY_ENGINE_ENABLED

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3.7: Kill-switch halts a user's armed instances

The existing `PUT /user/trading/kill-switch` handler (`packages/client-direct/src/api.ts`) already calls `revokePendingApprovalsForUser` + `emitEventToUser`. Add a hook that also halts the user's armed/paused strategy instances via the registered service.

**Files:**
- Modify: `packages/plugin-cex/src/strategy/engine/strategyEngineService.ts` (add `haltUser`)
- Modify: `packages/client-direct/src/api.ts` (call it from the kill-switch handler)
- Test: `packages/plugin-cex/__tests__/strategyEngine.haltUser.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/plugin-cex/__tests__/strategyEngine.haltUser.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { haltUserInstances } from "../src/strategy/engine/strategyEngineService";
import { InMemoryStrategyInstanceStore } from "../src/strategy/engine/strategyInstanceStore";
import { newArmedInstance } from "../src/strategy/engine/strategyInstance";

describe("haltUserInstances", () => {
  it("halts armed + paused instances for the user only", async () => {
    const store = new InMemoryStrategyInstanceStore();
    const a = newArmedInstance({ instance_id: "a", user_id: "u1", dsl: { universe: { symbols: ["X"] } } as any, nowMs: 0 });
    const p = newArmedInstance({ instance_id: "p", user_id: "u1", dsl: {} as any, nowMs: 0 }); p.status = "paused";
    const other = newArmedInstance({ instance_id: "o", user_id: "u2", dsl: {} as any, nowMs: 0 });
    await store.put(a); await store.put(p); await store.put(other);

    const count = await haltUserInstances(store, "u1", 1000);
    expect(count).toBe(2);
    expect((await store.get("a"))!.status).toBe("halted");
    expect((await store.get("p"))!.status).toBe("halted");
    expect((await store.get("o"))!.status).toBe("armed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/plugin-cex && npx vitest run __tests__/strategyEngine.haltUser.test.ts`
Expected: FAIL — cannot find `haltUserInstances`.

- [ ] **Step 3: Add `haltUserInstances` + a service method**

In `packages/plugin-cex/src/strategy/engine/strategyEngineService.ts`, add the exported helper (top-level) and a thin method on the class:

```ts
import type { StrategyInstanceStore } from "./strategyInstanceStore";

/** Halt all of a user's armed/paused instances (kill-switch). Returns the count halted. */
export async function haltUserInstances(
  store: StrategyInstanceStore,
  userId: string,
  nowMs: number,
): Promise<number> {
  const list = await store.list(userId);
  let n = 0;
  for (const inst of list) {
    if (inst.status === "armed" || inst.status === "paused") {
      inst.status = "halted";
      inst.last_error = "kill_switch";
      inst.last_tick_at = new Date(nowMs).toISOString();
      await store.put(inst);
      n++;
    }
  }
  return n;
}
```

And inside the `StrategyEngineService` class:

```ts
  async haltUser(userId: string): Promise<number> {
    if (!this.deps) return 0;
    return haltUserInstances(this.deps.store, userId, Date.now());
  }
```

- [ ] **Step 4: Call it from the kill-switch handler**

In `packages/client-direct/src/api.ts`, inside the `PUT /user/trading/kill-switch` handler, after the existing `revokePendingApprovalsForUser(...)` / `emitEventToUser(...)` calls, add:

```ts
      try {
        const strategyEngine = runtime.getService(ServiceType.STRATEGY_ENGINE) as
          | { haltUser?: (userId: string) => Promise<number> }
          | undefined;
        const haltedStrategies = (await strategyEngine?.haltUser?.(String(userInfo.userId))) ?? 0;
        if (haltedStrategies > 0) {
          elizaLogger.info(`[Trading] kill-switch halted ${haltedStrategies} strategy instance(s) for user=${userInfo.userId}`);
        }
      } catch (err) {
        elizaLogger.warn(`[Trading] kill-switch strategy halt failed: ${err instanceof Error ? err.message : String(err)}`);
      }
```

Ensure `ServiceType` is imported from `@elizaos/core` in `api.ts` (it is used elsewhere; if not, add it to the existing core import).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/plugin-cex && npx vitest run __tests__/strategyEngine.haltUser.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Build client-direct to verify the handler compiles**

Run: `pnpm --filter @elizaos/client-direct build` (or the package's actual name — check `packages/client-direct/package.json`).
Expected: builds clean.

- [ ] **Step 7: Commit**

```bash
git add packages/plugin-cex/src/strategy/engine/strategyEngineService.ts packages/client-direct/src/api.ts packages/plugin-cex/__tests__/strategyEngine.haltUser.test.ts
git commit -m "feat(cex): kill-switch halts a user's armed strategy instances

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

# Phase 4 — Control surface (compiler template + actions + routing)

Produces: a hybrid DCA + risk-control NL→DSL template, `compile_strategy` persistence of the DSL, and chat actions `arm_strategy` / `pause_strategy` / `resume_strategy` / `stop_strategy` / `list_strategies` with classifier routing. Arming reuses the existing `human_input_required` approval (arm_strategy is a WRITE action → `requestParameterReview` fires the modal).

### Task 4.1: Hybrid DCA + risk-control compiler template

`compileNlToDsl(text, {locale, owner, venue})` (`nlToDSL.ts`) supports DCA and RSI templates. Add a `compileHybridDcaRiskControl` that produces a runnable DSL: a dip-buy entry (`price.pct_from_high < -X`), a DCA floor entry (constant-true, fires each cadence tick), a benign never-true exit (schema requires ≥1 exit; TP/SL handles real exits), and `risk.per_trade_take_profit_bps`/`per_trade_stop_loss_bps`. Dispatch to it FIRST when the text mentions DCA **and** a risk/dip/TP/SL keyword.

**Files:**
- Modify: `packages/plugin-cex/src/strategy/nlToDSL.ts` (add the builder + dispatch)
- Test: `packages/plugin-cex/__tests__/nlToDSL.hybrid.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/plugin-cex/__tests__/nlToDSL.hybrid.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { compileNlToDsl } from "../src/strategy/nlToDSL";
import { strategyDSLSchema } from "../src/strategy/strategyDSL";

describe("hybrid DCA + risk-control compiler", () => {
  it("compiles a DCA + dip-buy + TP/SL request into a valid DSL", () => {
    const res = compileNlToDsl(
      "DCA $50 of BTC weekly, also buy the dip at -5% from the 20-day high, take profit 3% stop loss 2%",
      { locale: "en", owner: "u1", venue: "paper" },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // validates against the schema
    expect(() => strategyDSLSchema.parse(res.strategy)).not.toThrow();
    const s = res.strategy as any;
    // dip entry uses pct_from_high; DCA floor entry is constant-true
    const kinds = s.signals.map((x: any) => x.kind);
    expect(kinds).toContain("price.pct_from_high");
    expect(s.entries.length).toBeGreaterThanOrEqual(2);
    expect(s.risk.per_trade_take_profit_bps).toBe(300);
    expect(s.risk.per_trade_stop_loss_bps).toBe(200);
    expect(s.identity.mode).toBe("paper");
  });

  it("does not hijack a plain DCA request (no risk keyword)", () => {
    const res = compileNlToDsl("DCA $50 of BTC weekly", { locale: "en", owner: "u1", venue: "paper" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // plain DCA template: single market-buy entry, no pct_from_high
    const kinds = (res.strategy as any).signals.map((x: any) => x.kind);
    expect(kinds).not.toContain("price.pct_from_high");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/plugin-cex && npx vitest run __tests__/nlToDSL.hybrid.test.ts`
Expected: FAIL — the hybrid request currently routes to the plain DCA template (no `price.pct_from_high`).

- [ ] **Step 3: Add the builder + dispatch**

In `packages/plugin-cex/src/strategy/nlToDSL.ts`, add this builder near the other template functions:

```ts
const HYBRID_RE = /\bdca\b|dollar[- ]?cost|定投/i;
const HYBRID_RISK_RE = /\bdip\b|risk|stop[- ]?loss|take[- ]?profit|\bTP\b|\bSL\b|hybrid|risk[- ]?control/i;

function num(re: RegExp, text: string, dflt: number): number {
  const m = text.match(re);
  return m ? Number(m[1]) : dflt;
}

/** Returns a hybrid DSL when the text is DCA + a risk/dip/TP/SL keyword; else null. */
export function compileHybridDcaRiskControl(
  text: string,
  options: { locale: "en" | "zh-CN"; owner: string; venue: "binance" | "coinbase" | "paper" },
): NlToDslResult | null {
  if (!HYBRID_RE.test(text) || !HYBRID_RISK_RE.test(text)) return null;

  const amount = num(/\$\s*(\d+(?:\.\d+)?)/, text, 50);
  const dipPct = num(/-?\s*(\d+(?:\.\d+)?)\s*%\s*(?:from|below|off|drop|dip)?/i, text, 5);
  const tpPct = num(/take[- ]?profit\s*(\d+(?:\.\d+)?)\s*%/i, text, 3);
  const slPct = num(/stop[- ]?loss\s*(\d+(?:\.\d+)?)\s*%/i, text, 2);
  const window = num(/(\d+)[- ]?day/i, text, 20);
  const symMatch = text.match(/\b([A-Z]{2,6})(?:USDT|-USDT|\/USDT)?\b/);
  const base = symMatch ? symMatch[1].toUpperCase() : "BTC";
  const symbol = options.venue === "coinbase" ? `${base}-USDT` : `${base}USDT`;
  const cadenceSec = /weekly|每周/i.test(text) ? 604800 : /daily|每日/i.test(text) ? 86400 : /hourly|每小时/i.test(text) ? 3600 : 86400;

  const strategy = {
    identity: { id: `hybrid-${base.toLowerCase()}-${options.owner}`, version: 1, owner: options.owner, status: "paper", mode: "paper", name: `Hybrid DCA + Risk-Control ${base}` },
    universe: { venue: options.venue, symbols: [symbol] },
    signals: [{ id: "dip", kind: "price.pct_from_high", params: { window } }],
    entries: [
      // Dip buy FIRST: a larger tranche when price is >= dipPct below the rolling high.
      { id: "dip_buy", when: { op: "lt", args: ["dip", -Math.abs(dipPct)] }, then: { order_type: "market", side: "BUY", sizing: { kind: "quote_size", value: amount * 2 } } },
      // DCA floor: constant-true so every cadence tick buys the base tranche.
      { id: "dca", when: { op: "gt", args: [1, 0] }, then: { order_type: "market", side: "BUY", sizing: { kind: "quote_size", value: amount } } },
    ],
    // Schema requires >=1 exit; TP/SL is enforced engine-side. Never-true placeholder.
    exits: [{ id: "noop_exit", when: { op: "lt", args: [1, 0] }, then: { order_type: "market", side: "SELL", sizing: { kind: "pct_equity", value: 100 } } }],
    risk: {
      max_position_notional_usd: amount * 100,
      max_daily_loss_usd: amount * 10,
      max_concurrent_positions: 1,
      per_trade_take_profit_bps: Math.round(tpPct * 100),
      per_trade_stop_loss_bps: Math.round(slPct * 100),
      slippage_bps_max: 50,
    },
    operations: { evaluation_interval_seconds: cadenceSec, persistent: true, halt_on_error: true },
    resilience: { auto_kill_on_loss_limit: true, pause_on_stale_orders: 3, pause_on_market_data_lag_s: 600 },
  };

  const parsed = strategyDSLSchema.safeParse(strategy);
  if (!parsed.success) return null; // fall through to other templates
  return { ok: true, strategy: parsed.data, derived_by_heuristic: true };
}
```

Add the import for `strategyDSLSchema` at the top of `nlToDSL.ts` if not present:
```ts
import { strategyDSLSchema } from "./strategyDSL";
```

Then in `compileNlToDsl(...)`, BEFORE the DCA/RSI dispatch, add:
```ts
  const hybrid = compileHybridDcaRiskControl(naturalLanguage, options);
  if (hybrid) return hybrid;
```

> Match the exact parameter names `compileNlToDsl` uses (the explorer noted `compileNlToDsl(naturalLanguage, options)`); confirm `NlToDslResult`/`NlToDslSuccess` field names (`ok`, `strategy`, `derived_by_heuristic`) against `nlToDSL.ts:6-22` and adjust the return literal if they differ.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/plugin-cex && npx vitest run __tests__/nlToDSL.hybrid.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-cex/src/strategy/nlToDSL.ts packages/plugin-cex/__tests__/nlToDSL.hybrid.test.ts
git commit -m "feat(cex): hybrid DCA + risk-control NL->DSL template

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4.2: Persist the compiled DSL so `arm_strategy` can recover it

`compile_strategy` returns the DSL only in the callback `metadata.strategy` (`compileStrategy.ts:89-99`); it is not persisted. Persist a Memory carrying `metadata.compiledStrategy` so `arm_strategy` ("arm it") can recover the last compiled strategy.

**Files:**
- Create: `packages/plugin-cex/src/strategy/engine/compiledStrategyMemory.ts` (pure builder + recover helper)
- Modify: `packages/plugin-cex/src/actions/compileStrategy.ts` (persist after success)
- Test: `packages/plugin-cex/__tests__/compiledStrategyMemory.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/plugin-cex/__tests__/compiledStrategyMemory.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/plugin-cex && npx vitest run __tests__/compiledStrategyMemory.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`packages/plugin-cex/src/strategy/engine/compiledStrategyMemory.ts`:

```ts
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
```

- [ ] **Step 4: Persist in `compileStrategy.ts`**

In `packages/plugin-cex/src/actions/compileStrategy.ts`, after the success branch builds `responseText` and before/after the `callback(...)` call, add a best-effort persist:

```ts
        try {
          const { buildCompiledStrategyMemory } = await import("../strategy/engine/compiledStrategyMemory");
          const mem = buildCompiledStrategyMemory({
            agentId: runtime.agentId,
            roomId: memory.roomId,
            userId: memory.userId,
            strategy: result.strategy,
          });
          await runtime.messageManager.createMemory(mem, "messages");
        } catch (e) {
          elizaLogger.warn(`[plugin-cex] compile_strategy persist failed: ${e instanceof Error ? e.message : String(e)}`);
        }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/plugin-cex && npx vitest run __tests__/compiledStrategyMemory.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-cex/src/strategy/engine/compiledStrategyMemory.ts packages/plugin-cex/src/actions/compileStrategy.ts packages/plugin-cex/__tests__/compiledStrategyMemory.test.ts
git commit -m "feat(cex): persist compiled strategy DSL for arm_strategy recovery

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4.3: Service control methods + pure arming logic

Add pure `forcePaper(dsl)` + `armStrategyInstance(store, args)` and expose control methods on the service. `forcePaper` mutates a copy so a live DSL is downgraded to paper before arming (the paper-only hard gate).

**Files:**
- Create: `packages/plugin-cex/src/strategy/engine/arming.ts` (pure helpers)
- Modify: `packages/plugin-cex/src/strategy/engine/strategyEngineService.ts` (control methods)
- Test: `packages/plugin-cex/__tests__/strategyEngine.arming.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/plugin-cex/__tests__/strategyEngine.arming.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { forcePaper, armStrategyInstance } from "../src/strategy/engine/arming";
import { InMemoryStrategyInstanceStore } from "../src/strategy/engine/strategyInstanceStore";

const liveDsl = () => ({
  identity: { id: "s1", version: 1, owner: "u1", status: "live", mode: "live" },
  universe: { venue: "binance", symbols: ["BTCUSDT"] },
  signals: [], entries: [], exits: [],
  risk: { max_position_notional_usd: 1000, max_daily_loss_usd: 200, max_concurrent_positions: 1 },
  operations: { evaluation_interval_seconds: 30 }, resilience: {},
}) as any;

describe("arming", () => {
  it("forcePaper downgrades mode + status to paper without mutating the input", () => {
    const dsl = liveDsl();
    const paper = forcePaper(dsl);
    expect(paper.identity.mode).toBe("paper");
    expect(paper.identity.status).toBe("paper");
    expect(dsl.identity.mode).toBe("live"); // original untouched
  });

  it("armStrategyInstance forces paper, persists armed, due now", async () => {
    const store = new InMemoryStrategyInstanceStore();
    const inst = await armStrategyInstance(store, { userId: "u1", dsl: liveDsl(), nowMs: 1000, instanceId: "i1" });
    expect(inst.status).toBe("armed");
    expect(inst.dsl.identity.mode).toBe("paper");
    expect((await store.get("i1"))!.status).toBe("armed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/plugin-cex && npx vitest run __tests__/strategyEngine.arming.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`packages/plugin-cex/src/strategy/engine/arming.ts`:

```ts
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
```

- [ ] **Step 4: Add control methods to the service**

In `packages/plugin-cex/src/strategy/engine/strategyEngineService.ts`, import the helpers and add public methods that the actions call. Add to the class:

```ts
  getStore(): StrategyInstanceStore | null {
    return this.deps?.store ?? null;
  }

  async armStrategy(userId: string, dsl: StrategyDSL): Promise<StrategyInstance> {
    if (!this.deps) throw new Error("strategy engine not started");
    const { armStrategyInstance } = await import("./arming");
    const instanceId = stringToUuid(`strategy-${userId}-${dsl.identity.id}`) as string;
    return armStrategyInstance(this.deps.store, { userId, dsl, nowMs: Date.now(), instanceId });
  }

  async setStatus(userId: string, instanceId: string, status: "paused" | "armed" | "stopped"): Promise<StrategyInstance | null> {
    if (!this.deps) return null;
    const inst = await this.deps.store.get(instanceId);
    if (!inst || inst.user_id !== userId) return null;
    inst.status = status;
    await this.deps.store.put(inst);
    return inst;
  }

  async listForUser(userId: string): Promise<StrategyInstance[]> {
    if (!this.deps) return [];
    return this.deps.store.list(userId);
  }
```

Add the imports at the top: `import type { StrategyDSL } from "../strategyDSL";` and `import type { StrategyInstance } from "./strategyInstance";` (and ensure `stringToUuid` is imported from `@elizaos/core`).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/plugin-cex && npx vitest run __tests__/strategyEngine.arming.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-cex/src/strategy/engine/arming.ts packages/plugin-cex/src/strategy/engine/strategyEngineService.ts packages/plugin-cex/__tests__/strategyEngine.arming.test.ts
git commit -m "feat(cex): arming helpers + StrategyEngineService control methods

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4.4: The five chat actions

Plain `Action` objects (like `compileStrategyAction`). Handlers resolve the service via `runtime.getService(ServiceType.STRATEGY_ENGINE)`. `arm_strategy` recovers the DSL (from `options.compiledStrategy`, else the most recent room memory via `recoverCompiledStrategy`, else compiles fresh), then calls `service.armStrategy` (which forces paper). `list_strategies` is read-only.

**Files:**
- Create: `packages/plugin-cex/src/actions/strategyLifecycle.ts` (all five actions)
- Test: `packages/plugin-cex/__tests__/strategyLifecycle.actions.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/plugin-cex/__tests__/strategyLifecycle.actions.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { armStrategyAction, listStrategiesAction, renderStrategyTable } from "../src/actions/strategyLifecycle";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/plugin-cex && npx vitest run __tests__/strategyLifecycle.actions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`packages/plugin-cex/src/actions/strategyLifecycle.ts`:

```ts
import {
  type Action, type HandlerCallback, type IAgentRuntime, type Memory, type State,
  ServiceType, elizaLogger,
} from "@elizaos/core";
import { recoverCompiledStrategy } from "../strategy/engine/compiledStrategyMemory";
import { compileNlToDsl } from "../strategy/nlToDSL";
import type { StrategyDSL } from "../strategy/strategyDSL";
import type { StrategyInstance } from "../strategy/engine/strategyInstance";

interface EngineLike {
  armStrategy(userId: string, dsl: StrategyDSL): Promise<StrategyInstance>;
  setStatus(userId: string, instanceId: string, status: "paused" | "armed" | "stopped"): Promise<StrategyInstance | null>;
  listForUser(userId: string): Promise<StrategyInstance[]>;
}

function getEngine(runtime: IAgentRuntime): EngineLike | undefined {
  return runtime.getService(ServiceType.STRATEGY_ENGINE) as unknown as EngineLike | undefined;
}

export function renderStrategyTable(instances: StrategyInstance[]): string {
  if (instances.length === 0) return "_No strategies. Compile one with `compile_strategy`, then `arm_strategy`._";
  const rows = instances.map((i) => {
    const sym = i.dsl?.universe?.symbols?.[0] ?? "?";
    const pos = `${i.position.base_qty}@${i.position.avg_entry_price}`;
    return `| \`${i.instance_id}\` | ${i.status} | ${sym} | ${pos} | ${i.position.realized_pnl_usd.toFixed(2)} | ${i.last_fill_at ?? "—"} | ${i.next_eval_at} |`;
  });
  return [
    "**[PAPER MODE — no real money]** Your strategies:",
    "| ID | Status | Symbol | Position | Realized PnL | Last Fill | Next Eval |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

export const armStrategyAction: Action = {
  name: "arm_strategy",
  description:
    "**ARM A STRATEGY (paper auto-execution)** — Use when the user wants to start/arm/run a compiled trading strategy for automatic paper execution. Trigger: 'arm this strategy', 'start the strategy', 'arm it', 'run my DCA'. Recovers the last compiled strategy. Paper-only; live is downgraded. Requires the one-time approval.",
  examples: [
    [{ user: "{{user1}}", content: { text: "arm this strategy" } }, { user: "{{user2}}", content: { text: "Arming for paper auto-execution", action: "arm_strategy" } }],
    [{ user: "{{user1}}", content: { text: "start my DCA strategy" } }, { user: "{{user2}}", content: { text: "Arming", action: "arm_strategy" } }],
  ],
  handler: async (runtime, memory, _state, options, callback?: HandlerCallback) => {
    const engine = getEngine(runtime);
    if (!engine) {
      await callback?.({ text: "The strategy engine is not enabled on this agent.", action: "arm_strategy" });
      return { success: false };
    }
    const opts = (options ?? {}) as Record<string, unknown>;
    let dsl = (opts.compiledStrategy as StrategyDSL | undefined) ?? null;
    if (!dsl) {
      const mems = await runtime.messageManager.getMemories({ roomId: memory.roomId, count: 50, tableName: "messages", agentId: runtime.agentId });
      dsl = recoverCompiledStrategy(mems);
    }
    if (!dsl && typeof memory.content?.text === "string" && /dca|rsi|strategy|buy the dip/i.test(memory.content.text)) {
      const compiled = compileNlToDsl(memory.content.text, { locale: "en", owner: String(memory.userId), venue: "paper" });
      if (compiled.ok) dsl = compiled.strategy;
    }
    if (!dsl) {
      await callback?.({ text: "I couldn't find a compiled strategy. Please `compile_strategy` first, then arm it.", action: "arm_strategy" });
      return { success: false };
    }
    const wasLive = dsl.identity.mode === "live" || dsl.identity.status === "live";
    const inst = await engine.armStrategy(String(memory.userId), dsl);
    const note = wasLive ? " (downgraded from live to **paper** — live auto-execution is not permitted)" : "";
    await callback?.({
      text: `**[PAPER MODE — no real money]** Armed strategy \`${inst.instance_id}\`${note}. It will evaluate every ${dsl.operations.evaluation_interval_seconds}s.`,
      action: "arm_strategy",
      metadata: { success: true, instance_id: inst.instance_id, mode: "paper" },
    });
    return { success: true, instance_id: inst.instance_id };
  },
};

function lifecycleAction(name: "pause_strategy" | "resume_strategy" | "stop_strategy", status: "paused" | "armed" | "stopped", verb: string): Action {
  return {
    name,
    description: `**${verb.toUpperCase()} A STRATEGY** — Use when the user wants to ${verb} a running strategy ('${verb} my strategy', '${verb} it'). Affects paper auto-execution only.`,
    examples: [[{ user: "{{user1}}", content: { text: `${verb} my strategy` } }, { user: "{{user2}}", content: { text: `${verb}ing`, action: name } }]],
    handler: async (runtime, memory, _state, options, callback?: HandlerCallback) => {
      const engine = getEngine(runtime);
      if (!engine) { await callback?.({ text: "The strategy engine is not enabled.", action: name }); return { success: false }; }
      const userId = String(memory.userId);
      const opts = (options ?? {}) as Record<string, unknown>;
      let instanceId = typeof opts.instance_id === "string" ? opts.instance_id : null;
      if (!instanceId) {
        const list = await engine.listForUser(userId);
        const candidates = list.filter((i) => i.status === "armed" || i.status === "paused");
        if (candidates.length === 1) instanceId = candidates[0].instance_id;
        else if (candidates.length === 0) { await callback?.({ text: "You have no active strategies.", action: name }); return { success: false }; }
        else { await callback?.({ text: `You have ${candidates.length} active strategies; specify which by ID. Use \`list_strategies\`.`, action: name }); return { success: false }; }
      }
      const updated = await engine.setStatus(userId, instanceId, status);
      if (!updated) { await callback?.({ text: `No strategy \`${instanceId}\` found for you.`, action: name }); return { success: false }; }
      await callback?.({ text: `**[PAPER MODE — no real money]** Strategy \`${updated.instance_id}\` is now **${updated.status}**.`, action: name, metadata: { success: true, status: updated.status } });
      return { success: true, status: updated.status };
    },
  };
}

export const pauseStrategyAction = lifecycleAction("pause_strategy", "paused", "pause");
export const resumeStrategyAction = lifecycleAction("resume_strategy", "armed", "resume");
export const stopStrategyAction = lifecycleAction("stop_strategy", "stopped", "stop");

export const listStrategiesAction: Action = {
  name: "list_strategies",
  description: "**LIST STRATEGIES (read)** — Use when the user wants to see their running/armed strategies and status ('show my strategies', 'list strategies', 'what's running'). Read-only.",
  examples: [[{ user: "{{user1}}", content: { text: "show my running strategies" } }, { user: "{{user2}}", content: { text: "Listing", action: "list_strategies" } }]],
  handler: async (runtime, memory, _state, _options, callback?: HandlerCallback) => {
    const engine = getEngine(runtime);
    if (!engine) { await callback?.({ text: "The strategy engine is not enabled.", action: "list_strategies" }); return { success: false }; }
    const list = await engine.listForUser(String(memory.userId));
    await callback?.({ text: renderStrategyTable(list), action: "list_strategies", metadata: { success: true, count: list.length } });
    return { success: true, count: list.length };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/plugin-cex && npx vitest run __tests__/strategyLifecycle.actions.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-cex/src/actions/strategyLifecycle.ts packages/plugin-cex/__tests__/strategyLifecycle.actions.test.ts
git commit -m "feat(cex): arm/pause/resume/stop/list_strategies chat actions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4.5: Register actions + schemas + routing + approval/validator arms

Wire the five actions into the plugin, declare canonical schemas, route them through the classifier, and — critically — extend `validateApprovedActionParams` (the N-1 regression class from CLAUDE.md: a registered write action missing a case arm throws "Unknown CEX action"). `arm_strategy`/`pause`/`resume`/`stop` are WRITE actions (so `arm_strategy` gets the approval modal); `list_strategies` is read-only.

**Files:**
- Modify: `packages/plugin-cex/src/actions/index.ts` (add to the `tradeActions` array)
- Modify: `packages/plugin-cex/src/spec/canonical.ts` (declare schemas)
- Modify: `packages/plugin-cex/src/actions/shared.ts` (`validateApprovedActionParams` case arms)
- Modify: `packages/core/src/handlers/cexWorkflowStakeClassifier.ts` (WRITE_ACTIONS / READ classification)
- Modify: `packages/core/src/handlers/langGraphPrecheck.ts` (short-circuit route)
- Test: `packages/plugin-cex/__tests__/strategyLifecycle.registration.test.ts`

- [ ] **Step 1: Write the failing test (registration + validator-arm guard)**

`packages/plugin-cex/__tests__/strategyLifecycle.registration.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { tradeActions } from "../src/actions/index";
import { validateApprovedActionParams } from "../src/actions/shared";

const NAMES = ["arm_strategy", "pause_strategy", "resume_strategy", "stop_strategy", "list_strategies"];

describe("strategy lifecycle registration", () => {
  it("all five actions are registered in tradeActions", () => {
    const registered = new Set(tradeActions.map((a: any) => a.name));
    for (const n of NAMES) expect(registered.has(n)).toBe(true);
  });

  it("validateApprovedActionParams does not throw 'Unknown CEX action' for the new actions", () => {
    for (const n of NAMES) {
      expect(() => validateApprovedActionParams(n as any, {})).not.toThrow(/Unknown CEX action/);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/plugin-cex && npx vitest run __tests__/strategyLifecycle.registration.test.ts`
Expected: FAIL — actions not in `tradeActions`; validator throws for unknown names.

- [ ] **Step 3: Register in the actions barrel**

In `packages/plugin-cex/src/actions/index.ts`, import and append to the exported `tradeActions` array:

```ts
import {
  armStrategyAction, pauseStrategyAction, resumeStrategyAction, stopStrategyAction, listStrategiesAction,
} from "./strategyLifecycle";
```
and add `armStrategyAction, pauseStrategyAction, resumeStrategyAction, stopStrategyAction, listStrategiesAction` to the `tradeActions` array literal.

- [ ] **Step 4: Add validator case arms**

In `packages/plugin-cex/src/actions/shared.ts`, find the `switch` in `validateApprovedActionParams` (the N-1 regression site). Add arms that `return` (skip `preflightValidateForExchange`, mirroring the PR #236 hotfix for `get_trading_mode` etc.):

```ts
    case "arm_strategy":
    case "pause_strategy":
    case "resume_strategy":
    case "stop_strategy":
    case "list_strategies":
      return params; // strategy lifecycle actions validate their own params downstream
```

- [ ] **Step 5: Declare canonical schemas**

In `packages/plugin-cex/src/spec/canonical.ts`, add to `CEX_ACTION_SCHEMAS`:

```ts
  arm_strategy: { description: "Arm a compiled strategy for paper auto-execution.", parameters: { instance_id: { type: "string", required: false, description: "Strategy instance id (optional; recovers last compiled)" } } },
  pause_strategy: { description: "Pause a running strategy.", parameters: { instance_id: { type: "string", required: false, description: "Strategy instance id" } } },
  resume_strategy: { description: "Resume a paused strategy.", parameters: { instance_id: { type: "string", required: false, description: "Strategy instance id" } } },
  stop_strategy: { description: "Stop a strategy.", parameters: { instance_id: { type: "string", required: false, description: "Strategy instance id" } } },
  list_strategies: { description: "List the user's strategies and status.", parameters: {} },
```

- [ ] **Step 6: Classify write vs read in the stake classifier**

In `packages/core/src/handlers/cexWorkflowStakeClassifier.ts`, add `arm_strategy`, `pause_strategy`, `resume_strategy`, `stop_strategy` to the `WRITE_ACTIONS` set (so `arm_strategy` triggers `requestParameterReview` → the human-input approval modal). Leave `list_strategies` as read (default/read set).

- [ ] **Step 7: Add a short-circuit route**

In `packages/core/src/handlers/langGraphPrecheck.ts`, add a `SHORT_CIRCUIT_PATTERNS` entry `cex_strategy_intent` that emits `CEX_WORKFLOW_MESSAGE` for strategy-control phrasings (place AFTER `cex_trade_intent`, BEFORE `price_or_direction_lookup`):

```ts
  {
    name: "cex_strategy_intent",
    classification: "CEX_WORKFLOW_MESSAGE",
    pattern: /\b(arm|pause|resume|stop|list|show)\b.*\b(strateg(y|ies)|dca|auto[- ]?trade)\b|\b(arm|start|run)\s+it\b|\bmy\s+(running\s+)?strateg(y|ies)\b/i,
    excludeIf: [ANALYSIS_INTENT_RE, NON_CRYPTO_INSTRUMENT_GUARD_RE],
  },
```
(Reuse the existing `ANALYSIS_INTENT_RE` / `NON_CRYPTO_INSTRUMENT_GUARD_RE` constants in that file. Confirm the entry object shape matches the existing `SHORT_CIRCUIT_PATTERNS` entries — `name`/`classification`/`pattern`/`excludeIf`.)

- [ ] **Step 8: Run test to verify it passes**

Run: `cd packages/plugin-cex && npx vitest run __tests__/strategyLifecycle.registration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 9: Build affected packages**

Run:
```bash
pnpm --filter @elizaos/core build && pnpm --filter @elizaos-plugins/plugin-cex build
```
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add packages/plugin-cex/src/actions/index.ts packages/plugin-cex/src/spec/canonical.ts packages/plugin-cex/src/actions/shared.ts packages/core/src/handlers/cexWorkflowStakeClassifier.ts packages/core/src/handlers/langGraphPrecheck.ts packages/plugin-cex/__tests__/strategyLifecycle.registration.test.ts
git commit -m "feat(cex): register strategy lifecycle actions + schemas + routing + approval/validator arms

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

# Phase 5 — Full-suite gate + live verification (local, paper only)

> **Standing constraint (do not violate):** QA the engine against a LOCAL agent in PAPER mode only — never production (`agent.sentiedge.ai`), never real-money live orders. This is the clone `auto-trading-agent-for-cryptos`, never `senti-agent-0428`. Keep `STRATEGY_ENGINE_ENABLED` OFF by default; only set it `true` for the local run.

### Task 5.1: Full unit-suite green

- [ ] **Step 1: Run the whole plugin-cex unit suite**

Run:
```bash
pnpm --filter @elizaos-plugins/plugin-cex test:unit
```
Expected: all new tests pass and no pre-existing test regresses. (If `test:unit`'s flat `__tests__/*.test.ts` glob misses anything, run `cd packages/plugin-cex && npx vitest run` once.)

- [ ] **Step 2: Run the sentiscore test added in Phase 2**

Run: `cd packages/plugin-sentiscore && npx vitest run __tests__/latestSentiment.test.ts`
Expected: PASS.

- [ ] **Step 3: Build the full graph**

Run:
```bash
pnpm --filter @elizaos/core build && pnpm --filter @elizaos-plugins/plugin-sentiscore build && pnpm --filter @elizaos-plugins/plugin-cex build
```
Expected: clean builds. Fix any type errors before proceeding.

### Task 5.2: Live local run — DCA at 30s, paper only

This exercises the wired deps (Tasks 3.5/3.6) that unit tests stub. Use the clone's local dev-auth + paper setup (see the project's local-dev memory; orders must route to the built-in paper venue — `default_mode="paper"`).

- [ ] **Step 1: Configure env for the local run**

In the clone's local env (`.env` / `.env.local`), set:
```
STRATEGY_ENGINE_ENABLED=true
STRATEGY_ENGINE_TICK_MS=10000
DATABASE_ADAPTER=sqlite
```
Ensure `SENTISCORE_S3_REGION` + `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` are set (sentiment fetch); if S3 creds are absent, sentiment-using strategies will skip ticks (expected). Use a DCA-only strategy (no sentiment signal) for the core liveness test so S3 is not on the path.

- [ ] **Step 2: Build core, then launch the agent detached (paper)**

Per the clone's launch convention, rebuild core to `dist` and start the agent + client detached (NOT via a turn-scoped background runner). Confirm `:3000`/`:5173` are free first (`ss -ltnp`).

- [ ] **Step 3: Drive the flow in the UI (Playwright or manual), paper only**

1. `compile a DCA strategy for $20 BTC every 30 seconds on paper` → expect the compiled DSL (set `operations.evaluation_interval_seconds: 30`; hand-edit if needed and re-send, or use the hybrid template).
2. `arm this strategy` → expect the **human_input_required** approval modal ("Arm this strategy for paper auto-execution?"). Approve.
3. Watch for **≥2 fills** over ~60–90s (chat `strategy_fill` notifications + the persisted memories). Confirm each fill is **[PAPER MODE]** and has a **distinct** `client_order_id` (idempotency salt — the original bug was only the first tranche firing).
4. `pause my strategy` → confirm no new fills.
5. `resume my strategy` → confirm fills resume.
6. `show my running strategies` → confirm `list_strategies` renders the status table (position, realized PnL, last fill, next eval).
7. `stop my strategy` → confirm status stopped.
8. Trigger the global kill-switch (`PUT /user/trading/kill-switch active=true`) while a fresh strategy is armed → confirm the instance is **halted**.

- [ ] **Step 4: Restart-resume check**

Re-arm a DCA strategy, confirm ≥1 fill, then restart the agent. Confirm `store.listActive()` resumes it and ticking continues (new fills after restart).

- [ ] **Step 5: Record results**

Capture the observed fills (client_order_ids, prices), the modal screenshot/transcript, and the resume evidence. **Do not fabricate** — if a Playwright/browser tool is not available, state that and report only what was actually observed via logs/API. (Per standing guidance, never invent UI test runs.)

- [ ] **Step 6: Final commit (any fixes from live verification)**

```bash
git add -A
git commit -m "test(cex): live paper verification fixes for strategy engine

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Plan self-review checklist (run by the worker before declaring done)

- [ ] Every spec section maps to a task: ServiceType (1.1), instance+store (1.2–1.4), signals/indicators/DSL (2.1–2.4), sentiment (2.3), idempotency salt (3.1), positionTracker (3.2), runTick incl. paper-force/TP-SL/risk/daily-loss/freshness/cadence (3.3), notifier (3.4), service+resume (3.5), env-flag registration (3.6), kill-switch (3.7), compiler hybrid (4.1), compile persistence (4.2), arming+control (4.3–4.4), registration/routing/approval (4.5), live paper test (5.2).
- [ ] No real-money path: `forcePaper` + `intent.mode="paper"` in runTick + paper venue dep; live refused with a downgrade notice.
- [ ] Flag off by default; SQLite-only start (Mongo parity deferred and logged).
- [ ] Idempotency salt verified by a uniqueness test across tick_count.
- [ ] `validateApprovedActionParams` arms added (CLAUDE.md N-1 regression class).

## Known integration points to verify against live code (flagged, not placeholders)

1. `buildCanonicalIntent` import path + arg types (Task 3.3) — mirror `strategyRuntime.ts:154-179`.
2. Paper `createOrder` response field names `order.quantity`/`order.price` (Task 3.5) — confirm vs `paperVenue.ts:164-246`.
3. `NlToDslResult` field names (Task 4.1) — confirm vs `nlToDSL.ts:6-22`.
4. `WRITE_ACTIONS` set + `SHORT_CIRCUIT_PATTERNS` entry shape (Task 4.5) — confirm vs the live files.
5. Sentiment `Response` body shape (Task 2.3 Step 1) — confirm vs `_s3SentimentFetcher.ts:~218`.

