# StrategyEngineService — paper-only auto-execution

**Date:** 2026-06-14
**Branch:** `feature/strategy-engine-paper` (based on `master`)
**Scope:** clone `auto-trading-agent-for-cryptos` only. Paper-only. Live refused. Feature flag off by default.

## 1. Goal

Add a registered background service that runs armed trading strategies on a coordinated loop,
executing them against the **paper venue only**, with the full DSL signal set and every existing
risk control enforced on each order. A single human approval ("arm this strategy") is the only
gate; nothing auto-runs until armed. The service is feature-flagged off by default
(`STRATEGY_ENGINE_ENABLED`).

The core entrypoint `runTick(deps)` takes injected dependencies (store, market-data fns, risk fn,
paper-venue factory, notifier, clock) so it is fully unit-testable without a live agent, and so an
external scheduler can call it unchanged later.

## 2. Architecture

```
StrategyEngineService.start()
  → guard on STRATEGY_ENGINE_ENABLED
  → store.listActive() (startup resume)
  → setInterval(tick, STRATEGY_ENGINE_TICK_MS)

tick():
  → re-entrancy guard (skip if a tick is already running)
  → runTick(deps)

runTick(deps):
  for each DUE instance (next_eval_at <= now, status === "armed"):
    → signalCompute (klines → indicators + mid + equity + sentiment + pct_from_high + position PnL)
    → market-data freshness check → stale ⇒ skip tick
    → TP/SL check (direct, from tracked entry price + DSL risk bps)
    → runStrategyOnce (rule engine, modeOverride="paper", runtimeStatus=instance.status)
    → entry/exit intent → force intent.mode="paper"
    → salted idempotent client_order_id (instance_id:tick_count nonce)
    → acquireTradingLock(userId, venue, symbol)
    → runRiskPrecheck (envelope = strategy.risk.*) → block ⇒ skip + log; repeated ⇒ pause
    → paperVenue.createOrder
    → positionTracker.update (position + realized/unrealized PnL)
    → notifier (chat notification + persisted Memory)
    → store.put (persist instance)
    → schedule next_eval_at
    → daily-loss check: day_realized_pnl >= risk.max_daily_loss_usd && auto_kill ⇒ halted

StrategyEngineService.stop()
  → clear interval → persist all instances
```

Only core touch: add `STRATEGY_ENGINE = "strategy_engine"` to the `ServiceType` enum in
`packages/core/src/core/types.ts`. Everything else lives in
`packages/plugin-cex/src/strategy/engine/` (plus indicator/DSL/compiler extensions, the SQLite
table, and a sentiment helper export from `plugin-sentiscore`).

## 3. Components

All new files under `packages/plugin-cex/src/strategy/engine/` unless noted.

| File | Purpose |
|------|---------|
| `strategyInstance.ts` | The `StrategyInstance` record + types (see §4). |
| `strategyInstanceStore.ts` | `StrategyInstanceStore` interface + in-memory impl for tests. |
| `signalCompute.ts` | Builds `StrategyEvaluationContext` from klines/mid/equity/sentiment; computes all DSL signal kinds; freshness stamp; skip on missing/stale required signal. |
| `positionTracker.ts` | Updates position + realized/unrealized PnL from fills; reconciles vs paper balance on resume. |
| `engineTick.ts` | The `runTick(deps)` orchestrator. |
| `strategyEngineService.ts` | Registered `Service` wrapper: loop, re-entrancy guard, start/stop, startup resume. |
| `notifier.ts` | Chat notification + persisted `Memory` on each fill (reuses `emitEventToUser`; persisted-only when the user's stream is closed). |
| `idempotency.ts` (or extend existing) | Salt hook so per-tranche client_order_id is unique. |

External/shared touches:
- `packages/adapter-sqlite/src/sqliteTables.ts` — new `strategy_instances` table DDL.
- `packages/plugin-cex/src/strategy/engine/sqliteStrategyInstanceStore.ts` — SQLite-backed store impl.
- `packages/plugin-cex/src/backtest/indicators.ts` — add `volumeZScore`, `pctFromHigh`.
- `packages/plugin-cex/src/strategy/strategyDSL.ts` — add `price.pct_from_high` signal kind.
- `packages/plugin-cex/src/strategy/nlToDSL.ts` — hybrid DCA + risk-control template.
- `packages/plugin-cex/src/actions/` — `arm_strategy`, `pause_strategy`, `resume_strategy`,
  `stop_strategy`, `list_strategies`; persist `metadata.compiledStrategy` in `compile_strategy`.
- `packages/plugin-sentiscore/src/index.ts` — export `getLatestSentiment(symbol, asOf)` helper.
- `agent/src/index.ts` — register the service behind the env flag.
- `packages/core/src/core/types.ts` — `ServiceType.STRATEGY_ENGINE`.

### 3.1 StrategyInstanceStore interface

Mirrors the `LedgerOperations` style (`packages/plugin-cex/src/reconciliation/types.ts`); no
generic store abstraction exists in the codebase.

```ts
interface StrategyInstanceStore {
  get(instance_id: string): Promise<StrategyInstance | null>;
  put(instance: StrategyInstance): Promise<void>;     // upsert
  delete(instance_id: string): Promise<void>;
  list(user_id: string): Promise<StrategyInstance[]>;
  listActive(): Promise<StrategyInstance[]>;           // status in (armed, paused) for resume
}
```

Implementations this branch: **SQLite** (new `strategy_instances` table) + **in-memory** (tests).

## 4. StrategyInstance record

```ts
interface StrategyInstance {
  instance_id: string;
  user_id: string;
  dsl: StrategyDSL;                 // forced intent.mode="paper" at arm time
  status: "armed" | "paused" | "stopped" | "halted";
  position: { base_qty: number; avg_entry_price: number; realized_pnl_usd: number };
  day_realized_pnl_usd: number;
  day_anchor: string;              // ISO date for daily-loss window reset
  last_tick_at: string | null;
  next_eval_at: string;
  last_fill_at: string | null;
  fills: Array<{ client_order_id: string; side: "BUY"|"SELL"; qty: number; price: number; ts: string }>;
  tick_count: number;             // salts the idempotent client_order_id
  last_error: string | null;
}
```

## 5. Signal set → control mapping

`StrategyEvaluationContext.signals` is `{[signalId: string]: number}`; `ruleEval` resolves rule
args by signal `id` (`packages/plugin-cex/src/strategy/strategyRuntime.ts:11-66`). `signalCompute`
computes each DSL signal by its `kind` and writes the numeric value under that signal's `id`.

| Signal kind | Source | Status |
|-------------|--------|--------|
| `price.rsi` | `indicators.rsi` over klines | exists |
| `price.sma_cross` | `indicators.sma` | exists |
| `price.ema_cross` | `indicators.ema` | exists |
| `price.atr_band` | `indicators.atr` | exists |
| `volume.zscore` | **new** `indicators.volumeZScore` | new |
| `price.pct_from_high` | **new** `indicators.pctFromHigh` (param: window) + DSL kind | new |
| `sentiment.score` | **new** `getLatestSentiment` from `plugin-sentiscore` S3 | new |

Control mapping:
- **DCA cadence** → `operations.evaluation_interval_seconds` + per-entry min-interval gate.
- **All DSL signals** → evaluated by `runStrategyOnce` against the computed snapshot.
- **Dip-buy** ("−5% from rolling N-day high") → `price.pct_from_high` in an entry rule.
- **TP/SL** → enforced directly by `engineTick` from tracked entry price + DSL
  `risk.per_trade_take_profit_bps` / `per_trade_stop_loss_bps` (belt-and-suspenders, independent
  of the rule engine).

Missing or stale **required** signal → **skip the tick**. Never fabricate a value.

### 5.1 Sentiment integration

`plugin-sentiscore` reads S3 via internal helpers (`_s3SentimentFetcher.ts`, region
`SENTISCORE_S3_REGION`, CSV rows → `{time, value, total, ...}`) but exports no callable getter.
We add `getLatestSentiment(symbol, asOf): Promise<{ value: number; ts: number } | null>` to the
plugin's public exports and call it from `signalCompute` via a thin `sentimentSource.ts` adapter.
Freshness governed by `resilience.pause_on_market_data_lag_s`; stale/missing ⇒ skip tick.

## 6. Safety gates

- **Paper-only hard gate** — engine forces `intent.mode="paper"`; refuses to arm a live strategy
  (downgrades to paper with a notice). `runStrategyOnce` already accepts `modeOverride`.
- **Arm-once approval** — the single human gate, reusing the existing `human_input_required` modal
  ("Arm this strategy for paper auto-execution?"). Nothing auto-runs until armed.
- **Risk engine on every order** — `runRiskPrecheck` (`risk/riskEngine.ts evaluate()`) runs each
  order with `strategy.risk.*` as the envelope (maxOrderSize, exposureCap, slippageCap,
  assetAllowlist + backstop deny-list, minOrderSize, leverageCap, marketDataFreshness,
  dailyLossLimit, cooldown). Block → skip + log; repeated blocks → pause.
- **Daily-loss auto-kill** — `day_realized_pnl_usd >= risk.max_daily_loss_usd` with
  `resilience.auto_kill_on_loss_limit` → `halted`.
- **Position caps** — `max_concurrent_positions`, `max_position_notional_usd`.
- **Market-data freshness** — lag > `resilience.pause_on_market_data_lag_s` → skip tick.
- **Global kill-switch** — the existing `PUT /user/trading/kill-switch` also halts all the user's
  armed instances (via `emitEventToUser` + `revokePendingApprovalsForUser`).
- **Idempotency** — unique `client_order_id` per tranche, salted by `instance_id:tick_count`. This
  requires a small nonce hook on `computeIntentHash`/`deriveClientOrderId`
  (`idempotency/intentHash.ts`) — the exact bug class that made only the first tranche fire before.
- **Re-entrancy + per-symbol `acquireTradingLock`**, bounded per-tick concurrency, global caps
  (`STRATEGY_ENGINE_MAX_ACTIVE_PER_USER`), and `STRATEGY_ENGINE_ENABLED` (off by default).

## 7. Control surface (chat)

New CEX actions (registered in `packages/plugin-cex/src/actions/index.ts`):
- `arm_strategy` — recovers the last compiled DSL from room memory (`compile_strategy` will persist
  it under `metadata.compiledStrategy`) or compiles fresh; routes through the one-time approval
  modal; persists instance as `armed`.
- `pause_strategy` / `resume_strategy` / `stop_strategy` — lifecycle transitions.
- `list_strategies` — read-only; renders a status table (status, position, unrealized PnL, last
  fill, next eval).

Classifier/decomposer routes for "start/arm this strategy", "pause my strategy", "show my running
strategies", with anaphora ("arm it"). A client status panel is deferred.

`compile_strategy` change: currently the DSL is only returned in the callback `metadata.strategy`
and is **not** persisted to room memory. We persist a `Memory` carrying
`metadata.compiledStrategy` so `arm_strategy` can recover it.

## 8. NL → DSL compiler

`compileNlToDsl` (`nlToDSL.ts`) currently supports DCA and RSI mean-revert templates. We add a
**hybrid DCA + risk-control** template: cadence DCA entry + dip-buy entry (`price.pct_from_high`) +
TP/SL exits. The compiled DSL is shown for review and is hand-editable. Full arbitrary-NL coverage
is **not** claimed — signal *evaluation* is full-coverage; signal *compilation* covers documented
templates.

## 9. Data flow (one armed hybrid strategy)

arm (approve once) → instance persisted `armed` → loop tick due → `signalCompute`
(klines→RSI/etc + mid + `pct_from_high` + sentiment + position PnL) → TP/SL check →
`runStrategyOnce` → entry/exit intent → force paper → salted idempotent id → `runRiskPrecheck` →
paper venue fill → update position/PnL → notify + persist → schedule `next_eval_at` →
(loss-limit? halt) → repeat. On restart → `store.listActive()` → resume.

## 10. Testing (TDD)

**Unit (no agent), `runTick` with injected deps:** noop / entry fires / exit fires / TP hit / SL
hit / daily-loss→halt / risk-block→skip / stale→skip / paused→no-op / idempotent-id uniqueness
across ticks / cadence respected / PnL math. `signalCompute` per signal kind from fixture klines
(incl. `volume.zscore`, `pct_from_high`, sentiment). Store round-trips (SQLite + in-memory).
Lifecycle action transitions (arm forces paper + refuses live). Kill-switch halts instances.

**Live (local always-on agent, paper only):** arm a DCA strategy at a 30s interval → watch ≥2
tranches fill → pause (no fills) → resume → stop → restart agent → confirm resume. Playwright UI
pass, **local + paper only** per the standing QA constraint.

## 11. Scope / constraints

- Clone `auto-trading-agent-for-cryptos` **only** (never `senti-agent-0428`).
- **Paper only**, live refused; feature flag **off by default**.
- Store: **SQLite-first** + in-memory (tests). **Mongo `StrategyInstanceStore` parity is a
  prerequisite before enabling `STRATEGY_ENGINE_ENABLED` in prod** (Cloud Run runs Mongo). The
  flag is off in prod, so nothing runs there until Mongo lands — this is the one explicit
  follow-up.
- Gating: **env flag only** (`STRATEGY_ENGINE_ENABLED`), no Mongo-adapter gate. The clone defaults
  to SQLite when `DATABASE_ADAPTER` is unset, so the engine runs on SQLite locally.
- `min-instances=1` deployment note for the clone so the loop stays warm.
- Secrets scoped, never committed.

## 12. Resolved open questions

- **Store adapter mechanism:** no reusable generic store; mirror `LedgerOperations`. SQLite-first
  + in-memory this branch; Mongo deferred.
- **client_order_id nonce hook:** confirmed needed — `deriveClientOrderId` is purely deterministic
  from the intent hash, so identical DCA tranches collide. Add an optional salt threaded through
  `computeIntentHash`/`deriveClientOrderId`.
- **Sentiment:** not wired into plugin-cex today (enum-only). Export a getter from
  `plugin-sentiscore` and consume it; skip-tick on missing/stale.
