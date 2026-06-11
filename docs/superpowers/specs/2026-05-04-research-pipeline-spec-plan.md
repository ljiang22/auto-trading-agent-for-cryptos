# Research Pipeline Spec Plan

**Date**: 2026-05-04
**Companion to**: `2026-05-04-research-workflow-internal-planning.md`
**Purpose**: Design-level spec for each Theme. Defines components, interfaces, dependencies, test approach, risks, and done criteria — without file-path-level detail. Used as the engineering hand-off baseline before each Theme is broken into an executable implementation plan.

## How to read this document

- One section per Theme (A1–A5 + B1), structured identically
- Cross-cutting concerns (observability, checkpoints, schedule) live in the planning doc, not here
- Per-theme **Done criteria** are the contract — Theme is "done" only when all listed items hold
- Each Theme's executable implementation plan (file paths, code, commands, TDD steps) is written separately, after the prior Theme + checkpoint completes

---

## Track A — Research Pipeline

### Theme A1. Research Input Layer

#### Goal

Establish a unified research input layer that ingests four S3 sources (`macro_news / crypto_news / x_influencers / YouTube`), applies per-source Top K selection (K configurable), reads `summary` directly from each S3 record (no transformation, no fallback), externalizes sentiment as text labels, and **fully retires existing `get-news` plugins**. Build on top of the existing S3 + sentiment infrastructure rather than from scratch. Summary content quality is upstream's responsibility, not A1's.

#### Existing baseline (do not rebuild)

- AWS S3 SDK + credentials infrastructure (`@aws-sdk/client-s3`, `SENTISCORE_*` env vars, default region `us-east-2`)
- `crypto_news` end-to-end ingestion: `packages/plugin-news/src/actions/getanews.ts` (S3 fetch + local cache)
- Sentiment ingestion: `packages/plugin-sentiscore/src/actions/crypto.ts` and `x.ts` (raw values `positive / negative / neutral / total` retained in cache)
- `summary` is already read directly from S3 in `getanews.ts` (`item.summary`); A1 keeps this pattern unchanged
- Sentiment scoring math (`value = (positive - negative) / total` in `[-1, +1]`)
- The bucket-rename effort `sentiscoredata` → `sentiscoredata-new` is **already in flight** (`MIGRATION_PLAN.md`); A1 should consume `sentiscoredata-new` once the migration completes — the bucket itself is not new

#### Components to build or change

1. **Source ingestion modules** — *mixed*
   - `crypto_news` — **reuse** existing `getanews.ts` ingestion (refactor into the new shared `SourceIngestor` interface)
   - `x_influencers` — **build new raw-feed ingestion** (existing `plugin-sentiscore/x.ts` only gives aggregated sentiment, not raw influencer feed)
   - `macro_news` — **build new** (no S3 path, no action today)
   - `YouTube` — **build new** (no integration today)
2. **Top K selection module** — *build new*
   - K config loader (per-source, per-scenario overrides) — current code hardcodes `slice(0, 5)`
   - Per-source ranking signal
   - Deduplication and filtering
3. **Summary read-through** — *reuse as-is*
   - `summary` is read directly from each S3 record, unchanged from `getanews.ts`'s current pattern
   - No reuse-vs-summarize branching, no secondary summarization, no quality validation
   - Quality is upstream's responsibility (audit found garbled summaries like `"OK school college why warrant…"` — that issue stays out of A1's scope)
4. **Sentiment text-labeling module** — *build new typed layer*
   - Numeric → label mapping (`Very Bullish` … `Very Bearish`) as a typed enum
   - Dual-channel output: text label as a structured field, raw value retained (raw retention already exists in cache)
   - Today text labels exist only inside LLM prose (`combine.ts`), not as typed structured data
5. **Research-ready normalizer** — *build new*
   - Unified schema across the four sources (time, source, summary, sentiment, link, tag)
   - Source attribution preservation
6. **Plugin migration shim** — *build new*
   - Enumerate all callsites of `getNewsAction` (REST: `/api/news/<symbol>`, action: `getnews` in comprehensive workflow at priority 8) and `Sentiment_Analysis`
   - Migrate to new input layer; deprecate and remove old plugins
7. **Observability layer** (high-level direction) — *build new*
   - Per-source success rate, freshness
   - Top K selection result logs

#### Key interfaces / contracts

- `ResearchInputRecord` — unified record schema (time, source_type, source_id, title, summary, sentiment_raw, sentiment_label, link, tags, attribution)
- `SourceIngestor` — common interface across the four sources (fetch / freshness check / fallback)
- `TopKSelector` — per-source signature `(records[], k, scenario) → records[]`
- `SentimentLabel` — enum + mapping function `(raw_value) → label` (raw value already exists; this adds the typed enum)
- `KConfig` — schema for per-source/per-scenario K values

#### External dependencies

- Existing AWS S3 SDK setup (`@aws-sdk/client-s3`)
- Existing `SENTISCORE_*` env credentials
- The `sentiscoredata-new` bucket (migration in flight per `MIGRATION_PLAN.md`)
- S3 paths: existing `crypto_news/*` is in production; `macro_news`, `x_influencers/raw`, `YouTube` paths must be confirmed with the data team
- Old plugins: `plugin-news`, `plugin-sentiscore` (combine action) — to be partially or fully retired

#### Test approach

- **Unit**: per-module (each ingestor, Top K selector, sentiment mapper, normalizer)
- **Integration**: each source can independently fetch → Top K → normalize → produce `ResearchInputRecord` consumable by downstream
- **Contract**: `ResearchInputRecord` schema validation — required fields, source attribution preserved; `summary` is propagated through unchanged
- **Regression**: zero remaining call sites to the old `get-news` plugins; old `Sentiment_Analysis` action either retired or wrapping the new layer
- **Fallback**: each source can degrade independently (one missing source does not break the pipeline)
- **Migration verification**: bucket migration to `sentiscoredata-new` confirmed end-to-end

#### Risks

- S3 paths for new sources (`macro_news`, `x_influencers/raw`, `YouTube`) not yet defined / unstable
- **Upstream summary quality is poor** (audit-confirmed) — A1 reads `summary` as-is, so garbage-in propagates downstream; remediation is **out of A1's scope** but consumers should be aware
- Bucket migration to `sentiscoredata-new` slips and Theme A1 races against it — env-var override should be available throughout
- Top K ranking signal poorly chosen → research quality drops silently
- Plugin migration misses some call sites → old plugins still alive in production
- Source schema drift over time (S3 producer changes structure without notice)

#### Done criteria

- Four sources each fetch independently, with independent failure modes
- Top K runs per source; K is configurable per source/scenario
- `summary` is propagated unchanged from each S3 record (no transformation, no fallback)
- Sentiment shown as typed text label to users; raw value retained internally (raw retention already in place)
- Zero call sites to old `get-news` plugins (greppable)
- Bucket migration to `sentiscoredata-new` confirmed; env override documented
- Observability layer surfaces per-source ingestion health and Top K selection logs

---

### Theme A2. Classification Governance

#### Goal

Ensure research-oriented requests reliably enter the research pipeline. **Build on top of the existing classification system** (LLM classifier, 4-class routing, metadata persistence, basic fallback, 126-question library) — close the real gaps: structured failure collection, field extraction fallback, queryable observability, and regression validation loop.

#### Existing baseline (do not rebuild)

- LLM-based classifier in `packages/core/src/handlers/langGraphPrecheck.ts` — produces `REGULAR_MESSAGE / TRADING_INFO_MESSAGE / TASK_CHAIN_MESSAGE / COMPREHENSIVE_ANALYSIS_MESSAGE`
- Classification prompt: `packages/core/src/templates/messageClassificationTemplate.ts`
- Metadata persistence on `message.content.metadata` (`runtime.ts:2345-2379`)
- Execution log: `logs/execution-log.jsonl` (classification + confidence + reasoning + isCryptoRelated)
- Basic fallback: classification failure → defaults to `TASK_CHAIN_MESSAGE`
- Test question library: `tests/questions/test_questions.json` — 126 questions, 5 levels
- Optional LangSmith tracing

#### Components to build or change

1. **Refined classification rules** — *extend existing*
   - Adjust prompt in `messageClassificationTemplate.ts` for known miss patterns
   - Do not rewrite the classifier
2. **Structured failure-sample collection** — *build new*
   - Move from JSONL-on-disk to a queryable store with error-pattern tags (miss / false-positive / unstable)
   - Define what triggers a "failure sample" (low confidence, fallback fired, post-hoc user correction)
3. **Field extraction fallback layer** — *build new*
   - Currently missing entirely
   - Extract structured fields (asset, time window, intent) when classification succeeds but downstream needs more
   - Define fallback when extraction fails (clarification prompt vs degradation)
4. **Question-set regression validation loop** — *extend existing*
   - The 126-question library exists; wire it into a CI or scheduled regression run
   - Score classification accuracy; flag drops
5. **Observability backend + dashboard** — *build new*
   - JSONL → queryable backend (database / analytics sink)
   - Dashboard: per-class distribution, fallback frequency, confidence distribution, isCryptoRelated breakdown
6. **Threshold-based signal rules** — *build new*
   - Define thresholds (e.g., low confidence rate > X%, fallback spike, miss-pattern recurrence) → review signal
7. **Override mechanism** — *build new*
   - Explicit user request bypasses default classification, with audit trail

#### Key interfaces / contracts

- Reuse: existing `precheck` metadata schema on `message.content.metadata`
- New: `FailureSampleRecord` — structured (input, classified_route, expected_route, error_type tag, captured_via, timestamp)
- New: `FieldExtractionResult` — (extracted fields, confidence per field, fallback_reason if any)
- New: `RegressionRunResult` — (question_id, expected, actual, pass/fail, confidence)
- New: `ClassificationSignal` — (signal_type, threshold, value, triggered_at)
- New: `OverrideAuditRecord` — (user, original_classification, overridden_to, justification)

#### External dependencies

- The existing precheck service (`langGraphPrecheck.ts`) — unchanged contract
- The existing classification template — extended with refined rules
- The existing 126-question library — re-used as regression input
- A queryable observability backend (database / analytics sink — TBD during execution)
- Theme A1's research input availability (referenced when extraction fallback decides whether to ask for clarification or degrade)

#### Test approach

- **Unit**: refined prompt, extraction layer, fallback logic, override path, threshold rules
- **Integration**: end-to-end classification on the full 126-question set; regression delta vs prior run
- **Regression**: 126-question library scored; no silent accuracy drop on existing categories
- **Live**: structured failure collection actually captures real-traffic miss/false/unstable samples
- **Stability**: same question repeated N times produces consistent routing
- **Observability**: dashboard reflects real classification activity within X minutes of events

#### Risks

- **Reinventing the wheel** — work duplicates what `langGraphPrecheck.ts` already does (mitigated by the "existing baseline" callout above)
- Prompt over-fits the 126-question library and doesn't generalize to real traffic
- LLM non-determinism causes `unstable` even with stable inputs
- Override is abused (everything becomes "user requested full analysis")
- Classification latency itself becomes a bottleneck (must integrate with Theme A3)
- Failure-sample collection grows but is never reviewed
- Field extraction layer becomes a second classifier with its own error modes

#### Done criteria

- The existing classifier is extended (not rewritten); diff against the existing prompt is reviewable
- Structured failure-sample collection is live; samples are queryable, tagged by error type
- Field extraction fallback layer exists; extraction failure paths are explicit
- The 126-question library is wired into a regression validation run (CI or scheduled)
- Observability dashboard exists; per-class distribution, fallback frequency, confidence are queryable
- Threshold-based signal rules are documented and live
- Override path exists with audit trail
- `Miss` is the top fix priority; `false positive` is explicitly deprioritized for this round

---

### Checkpoint 1 (after A2)

Decision window. Verify:

- Does the input layer reliably produce research-ready data?
- Does classification governance reliably route research requests?

Outcome: **continue / minor adjustment / re-sequence subsequent Themes**. Owned by the Track A lead.

---

### Theme A3. End-to-End Latency Observability

#### Goal

Make latency visible at three layers (`workflow / plugin / end-to-end`) **across all major system workflows** (comprehensive, regular Q&A, task chain, classification routing) — not limited to the comprehensive path. So subsequent performance optimization is fact-based, system-wide. Build on top of the existing scaffolding (which is mostly stubbed-out, not fully wired).

#### Existing baseline (do not rebuild)

- `packages/core/src/utils/usage.ts` — already records `responseTimeMs` per LLM call and persists to DB via `saveTokenUsage()`; this is the **only operational latency instrumentation in the system today**
- `startTime` annotations already exist in all four major workflow handlers (comprehensive, regular, classification precheck, task chain) — but values are **rarely read or logged**
- `packages/core/src/utils/executionLogger.ts` writes JSONL with action and outcome fields, but **no timing fields**
- LangSmith tracing integrated optionally (`LANGCHAIN_API_KEY` gate) — third-party only, no local metrics backend
- `TaskChainSnapshot` defines `startedAt / finishedAt`; `TaskExecutor` captures per-task `executionTime` in result — but **not propagated to logs**
- Comprehensive workflow logs end-to-end duration once at finish; no per-action / per-phase timing

#### Components to build or change

1. **Latency event collector** — *extend existing*
   - Wire up the existing `startTime` annotations in all four workflow handlers
   - Plugin/action-level events (per stage) — build new
   - Granular events: model calls (reuse `usage.ts`), S3 calls (build new), artifact writes (build new)
2. **Metric aggregator** — *build new*
   - Average, P95, P99 — bucketable by workflow type
   - Failure-and-retry scenarios tracked separately from success path
3. **Per-workflow per-stage breakdown reporter** — *build new* — covers all major workflows:
   - **Comprehensive path**: S3 fetch (per source) / Top K / report generation / prediction generation / memory write-back
   - **Regular message path**: precheck / classification / response generation
   - **Task chain path**: orchestration / dependency resolution / per-task execution (executionTime exists in TaskExecutor result, propagate to logs)
   - **Classification routing**: rule-engine / LLM call / fallback
   - **Cross-cutting**: per-plugin invocation, per-LLM-call (reuse `usage.ts`), memory read/write across all callers
4. **Queryable metrics backend** — *build new*
   - JSONL-on-disk → database / analytics sink (replaces `execution-log.jsonl` for metrics use)
5. **Bottleneck visualizer / dashboard** — *build new*
   - Dashboard view that maps each stage to its time share
   - Filter / drill-down by workflow type
6. **Latency event tagging convention** — *build new*
   - Naming, granularity, and parent-child relationship between events
   - Workflow-type tag is mandatory on every event
7. **Coverage check** — *build new*
   - Lint or audit step that verifies every major workflow emits the required event types at close of A3
8. **LangSmith integration as optional tracing backend** — *reuse* (already exists)

#### Key interfaces / contracts

- `LatencyEvent` — record (event_id, parent_id, workflow_type, stage, start_ts, end_ts, success, retry_count, tags)
- `LatencyAggregator` — interface for rolling up events into aggregate metrics, supports filtering by workflow type
- Tagging convention — documented (consistent stage names + mandatory workflow_type across the codebase)

#### External dependencies

- Existing `usage.ts` instrumentation (already records per-LLM-call latency)
- Existing `executionLogger.ts` JSONL writer (extend to include timing fields, or layer a new event sink alongside it)
- Existing `startTime` annotations in workflow handlers (currently dormant; wire them up)
- Existing LangSmith integration (optional tracing backend, gated by `LANGCHAIN_API_KEY`)
- Dashboarding tool (Grafana, internal dashboard, or whatever the team standardizes on — TBD during execution)
- All major workflow stages (Theme A1 + the existing regular Q&A / task chain / classification paths) must emit latency events using the agreed tagging

#### Test approach

- **Unit**: aggregator math (averages, percentiles, retry separation, workflow-type bucketing)
- **Integration**: run one full request per workflow type → verify all three layers and all stages have events
- **Coverage**: every major workflow has events for all three layers; no workflow is silently uncovered
- **Load**: under concurrent requests across workflow types, event collection itself does not skew latency
- **Visualization**: dashboard correctly shows per-stage breakdown for any recorded workflow

#### Risks

- Coverage gaps — only the loudest workflow (comprehensive) gets instrumented well; others remain blind
- Event collection overhead becomes a latency source
- Granularity wrong (too fine → noisy; too coarse → can't see bottleneck)
- Failure-and-retry scenarios accidentally inflated into the success-path metrics
- Tagging convention drifts over time as new stages are added without convention enforcement
- workflow_type tag missing on ad-hoc events → can't filter / drill down

#### Done criteria

- All three latency layers (`workflow / plugin / end-to-end`) are collected and queryable
- **All major workflows** (comprehensive, regular Q&A, task chain, classification) emit latency events at all three layers
- All new pipeline stages from Theme A1 emit latency events
- Failure-and-retry latency is separated from success-path latency
- Team can answer "where is the system slow" by looking at one dashboard, and can drill into any workflow
- Tagging convention is documented and enforced (lint or convention doc)
- Coverage check at close: no major workflow is silently uninstrumented

---

### Theme A4. Memory System Optimization

#### Goal

Optimize the memory system so it actually supports continuous research — across sessions, across rooms, across time. The memory infrastructure is **already substantial**; A4 closes specific gaps (cross-room recall, artifact indexing, promotion rules, read priority framework, version history, scope control). Specific architecture (any new tables, schemas, API extensions) decided during execution.

#### Existing baseline (do not rebuild)

- **SQLite database (25 tables)** at `agent/data/db.sqlite`:
  - `memories` (transient conversation, embeddings, room-scoped)
  - `user_features` (LLM-extracted aspects, batched every 5 user messages)
  - `knowledge` (RAG, chunked + embedded, shared/agent-isolated)
  - `cache` / `action_cache` (TTL-based)
  - `rooms`, `participants`, `accounts`, `goals`, `relationships`, `logs`
- **Three memory categories already separated in code**:
  - Transient: `MemoryManager` (`packages/core/src/data/memory.ts`)
  - User signal: `UserFeatureManager` (`packages/core/src/data/userFeatureManager.ts`)
  - Research artifacts: file system (`agent/saved_data/Reports/`, `agent/cache/reports/report-index.json`)
- **Existing managers**: `MemoryManager`, `UserFeatureManager`, `RAGKnowledgeManager`, `ActionCacheManager`
- Subscription-tier retention window (`utils/dataRetention.ts`)
- Embedding similarity search and `unique` deduplication available

#### What this Theme decides (rules + targeted gap-closing)

1. **Cross-room recall** — *build new* — when and how to look up relevant context outside the current room (today: messages don't span rooms)
2. **Research artifact indexing in SQLite** — *build new* — move report metadata from filesystem JSON to a queryable schema; enable per-report tagging, full-text search, retrieval by topic / asset / time
3. **Message → long-term promotion rules** — *build new* — when a high-signal message gets elevated beyond its origin room
4. **Explicit read priority framework** — *build new* — currently each handler decides ad-hoc what context to inject
5. **User-feature revision history** — *extend `UserFeatureManager`* — replace the current "replace-only" pattern with version retention
6. **Per-conversation scope control** — *build new* — beyond the global subscription-tier window
7. **Memory write latency budget** — *build new tie-in to Theme A3* — today extraction is non-blocking but unmeasured
8. **Observability** — *build new* — read/write activity must be observable

#### What this Theme does not decide

- Whether to add new memory tables vs extend existing ones (deferred to execution)
- Storage backend changes (SQLite stays unless audit during execution shows a strong reason otherwise)
- Concrete schema for new gap-closing items (tagging schema for artifacts, shape of promotion-rule store, etc.)

These are **deferred to execution** so decisions are grounded in what A1 / A2 / A3 actually produce.

#### Key interfaces / contracts

Direction-level only at this Theme. Concrete interfaces are designed in the Theme's executable implementation plan, not here.

#### External dependencies

- Existing SQLite / cache infrastructure
- Existing user feature extractor (current prototype)
- Theme A1's research input (memory reads from it)
- Theme A3's latency budget (memory writes are subject to it)

#### Test approach

The detailed test approach is set during the executable implementation plan. High-level expectations:

- **Scope contamination must be testable**: a piece of information scoped as transient must not silently end up in long-term scope
- **Continuity must be testable**: after a research session, the next related conversation should not require the user to re-state preferences
- **Performance**: memory write/read stays inside the latency budget defined in A3

#### Risks

- Pre-locking architecture before A1/A2/A3 outputs are real → wrong design choices baked in
- Wrong scope rules → data pollution across categories
- Greedy persistence → storage bloats with low-value content
- Read priority unclear → inconsistent behavior in production
- Memory write-back becomes a latency hotspot
- "Continuous research" goal eroded by chat-style usage patterns

#### Done criteria

- Users do not repeatedly re-state research preferences
- Research context can be continuously extended within a session
- Research artifacts can be retrieved when relevant
- No silent contamination across memory scopes (transient conclusions don't pollute long-term preferences)
- Memory observability surfaces read/write activity

---

### Checkpoint 2 (after A4)

Decision window. Verify:

- Does latency data expose any bottleneck that must be optimized before A5?
- Does the memory system (regardless of final architecture) hold up against real research scenarios?

Outcome: **continue / minor adjustment / re-sequence subsequent Themes** (especially: insert an optimization round before A5 if needed).

---

### Theme A5. Comprehensive Workflow as a Task-Chain-Consumable Skill

#### Goal

Wrap the entire `comprehensive analysis` workflow as a **single task-chain-consumable `skill`** (similar to Claude `skill`), so the task chain system can discover, schedule, and compose it into any chain. The `report + prediction` dual artifact is preserved as the skill's standard output. Focus is on the **external skill contract**, not on slicing comprehensive into internal sub-skills.

**Critical scope correction (per audit):** The skill abstraction layer **does not exist today**. A5 is mostly *build new* — the `Skill` interface, registry, discovery, versioning are all greenfield. Only the comprehensive workflow itself and the task chain system are reusable as-is.

#### Existing baseline (do not rebuild)

- **Comprehensive workflow** (LangGraph) — entry: `handleComprehensiveAnalysis()` in `packages/core/src/handlers/comprehensiveAnalysisWorkflowGraph.ts`; runs 12 actions across 3 phases (data gathering / analysis / prediction); generates HTML report
- **Task chain system**:
  - `packages/core/src/tasks/taskChainPlanner.ts`
  - `packages/core/src/tasks/taskExecutor.ts`
  - `packages/core/src/tasks/chainOrchestrator.ts`
  - `packages/core/src/tasks/dependencyResolver.ts`
  - `packages/core/src/handlers/taskChainHandler.ts`
- **Eliza plugin pattern** — closest existing analog to "skill"; plugins export `actions / evaluators / providers` and runtime merges them into a global registry
- **`plugin-prediction`** — exists as a standalone plugin with one action; today invoked as the final action (priority 12) inside comprehensive

#### Critical missing pieces (audit)

- **No `Skill` abstraction layer exists** — no interface, no registry separate from action registry, no discovery API, no versioning
- **Task chain cannot invoke comprehensive as a single unit** today — they are two separate code paths
- **`PREDICTION` is not a first-class artifact** — its result is **embedded inside the synthesized `analysisContent` narrative**, not exposed as a separate typed output
- **No demonstration chain exists** that uses comprehensive as a chain node

#### Components to build or change

1. **`Skill` abstraction layer + registry + discovery** — *build new* (foundational; nothing exists today)
   - `Skill` interface (input, run, output, failure, versioning)
   - Skill registry (separate from the existing action registry)
   - Skill discovery API (list available skills, filter by capability)
2. **`comprehensive` skill wrapper** — *wrap existing*
   - Wraps the existing comprehensive LangGraph workflow as a single externally-callable skill
   - Internal multi-stage logic stays inside; the task chain sees one skill
3. **Skill contract layer** — *build new*
   - Input contract (asset / time window / research goal / question type / required vs degradable fields)
   - Output contract (`report` + `prediction` as independent artifacts in skill output)
   - Failure contract (which failures stop the chain, which let it skip / degrade)
   - Versioning contract (how the interface evolves without breaking existing chains)
4. **Lift `prediction` to a first-class artifact** — *extract new*
   - Today PREDICTION result is embedded into `analysisContent`; must be exposed as a typed top-level output
   - Define `Prediction` schema; wire comprehensive workflow's PREDICTION action result into it directly
5. **Task chain integration adapter** — *build new*
   - Skill discovery (registration in the task chain skill registry)
   - Skill scheduling (how task chain picks up and dispatches the skill)
   - Composition support (chain can place `comprehensive` as one node)
4. **Dual-artifact output handler**
   - Independent success/failure handling for `report` and `prediction` inside the skill output
   - Degradation strategy when one artifact fails
5. **Demonstration chain**
   - At least one task chain that uses the `comprehensive` skill end-to-end
   - Proves the skill is actually consumable, not just declared
6. **Observability layer** (high-level direction)
   - Skill invocation counts and success / failure / degraded rates (per task chain caller)
   - Per-artifact completion (`report` and `prediction`)

#### Key interfaces / contracts

- `ComprehensiveSkill` — the externally-callable skill (input, run, output, failure)
- `ComprehensiveSkillInput` — schema (asset, time window, research goal, question type, required vs degradable fields)
- `ComprehensiveSkillOutput` — contains both `Report` and `Prediction` as independent artifacts, with per-artifact status
- `Report` — schema (sections, evidence, citations, conclusions, risks)
- `Prediction` — schema (direction, scenario branches, confidence, key triggers)
- `SkillFailureMode` — enum (stop_chain / skip / degrade)
- `SkillVersion` — versioning convention so chains can pin to a known interface

#### External dependencies

- **Existing task chain system** — `taskChainPlanner.ts`, `taskExecutor.ts`, `chainOrchestrator.ts`, `dependencyResolver.ts`, `taskChainHandler.ts` (must be extended to host a skill registry / dispatch mechanism)
- **Existing comprehensive workflow** — `comprehensiveAnalysisWorkflowGraph.ts` (LangGraph; reused as the wrapped skill body)
- **Existing `plugin-prediction`** — its action result currently embedded in `analysisContent`; A5 lifts it out
- **Eliza plugin pattern** — closest existing analog; A5's new `Skill` interface should not conflict with it
- Theme A1's research input layer (consumed inside the skill)
- Theme A2's classification (note: the task chain's planner decides whether to invoke `comprehensive`; A2's user-facing classification is a separate routing layer)
- Theme A3's latency framework (skill emits latency events at workflow / plugin / end-to-end layers)
- Theme A4's memory system (the skill reads from and writes to it)
- LLM provider

#### Test approach

- **Unit**: skill input/output validation, failure mode mapping, versioning behavior
- **Integration**: task chain invokes the `comprehensive` skill end-to-end, receives `report + prediction`
- **Regression**: independent artifact failure — `report` failure does not silently kill `prediction`, and vice versa
- **Composition**: a demonstration chain that includes `comprehensive` as a step runs successfully
- **Failure mode**: each `SkillFailureMode` (stop_chain / skip / degrade) behaves as declared
- **Comparison**: structural diff between old comprehensive output and new skill output (sanity check, no silent regression)

#### Risks

- **A5 scope is heavier than it looks** — the audit shows the skill abstraction is greenfield, not a rename of an existing concept; flag for re-evaluation at Checkpoint 2
- Skill abstraction conflicts with the existing Eliza plugin pattern (action registry); needs explicit reconciliation
- Lifting `prediction` out of `analysisContent` breaks downstream consumers that read the narrative — must enumerate consumers and migrate
- Skill contract too tight → existing chains break when comprehensive evolves
- Skill contract too loose → task chain can't reason about what `comprehensive` will return
- Internal multi-stage logic leaks through the skill boundary → task chain ends up coupled to internals
- Shared research context inside the skill creates failure contagion between `report` and `prediction`
- Output length explodes (especially `report`)
- Demonstration chain becomes the only chain anyone uses → skill is "callable" only in theory
- Versioning skipped → first contract change breaks every chain

#### Done criteria

- The entire `comprehensive` workflow is exposed as **one** task-chain-consumable skill via the standard skill interface
- Task chain can reference and invoke `comprehensive` in any chain it composes
- At least one demonstration chain consumes `comprehensive` end-to-end and produces `report + prediction`
- `report` and `prediction` remain independent artifacts in the skill output (one's failure doesn't silently kill the other)
- Failure mode is explicit (stop / skip / degrade), declared per call site
- Skill contract is versioned
- Skill invocation observability is surfaced (per caller, per outcome, per artifact)

---

## Track B — Trading Workflow Platform Extension

### Theme B1. Biconomy Integration

#### Goal

Integrate `Biconomy` as an independent trading workflow platform extension. Define the boundary from research → execution and a minimum viable scope. Does not alter the research pipeline.

#### Existing baseline (do not rebuild)

- **`viem` 2.21.58 already installed** — bootstrap wallet / RPC / tx flows without adding deps
- **`bignumber.js` 9.1.2 already installed** — precise numeric handling on amounts
- **Task chain planner already supports human-in-the-loop approval interrupts** — directly reusable for B1's user confirmation gate
- Everything else is greenfield (no Biconomy, no wallet code, no execution actions, no handoff state machine)

#### Components to build or change

1. **Research-to-execution handoff interface**
   - Maps `ResearchConclusion` (subset of `Report`/`Prediction`) into `ExecutionRequest`
2. **User confirmation gate**
   - State machine that requires explicit user confirmation before execution
3. **Biconomy adapter**
   - SDK / API wrapper around Biconomy
4. **Context inheritance filter**
   - Decides which research context flows into execution (and what does not)
5. **Failure rollback handler**
   - On execution failure, timeout, or user cancellation, return to research context without breaking the chain
6. **Observability** (optional, lighter than Track A)
   - Confirmation rate, execution success rate, rollback frequency

#### Key interfaces / contracts

- `ResearchConclusion` → `ExecutionRequest` mapping
- `UserConfirmation` — state machine (pending / confirmed / rejected / expired)
- `ExecutionResult` — schema (success, tx hash, error, rollback context)
- `ContextInheritancePolicy` — explicit allow/deny list of fields that cross the boundary

#### External dependencies

- Biconomy SDK (new dependency to add — `@biconomy/*` not yet installed)
- **`viem` 2.21.58 already installed** — wallet / RPC / tx flows; bootstrap from this
- **`bignumber.js` already installed** — amounts handling
- Wallet setup (private key or AA flow — to be decided during execution)
- On-chain RPC endpoint (configured via env)
- User identity / authorization
- **Existing task chain approval interrupt mechanism** — directly reusable for the user confirmation gate
- Theme A2 (classification boundary stable)
- Theme A3 (basic latency observability available, so research vs execution can be distinguished)
- **Independent of A4 (Memory) and A5 (Comprehensive Skill)** — start time decided by resource availability

#### Test approach

- **Unit**: handoff mapping, confirmation state machine, context inheritance filter
- **Integration**: testnet end-to-end — research → confirmation → execute → handle success and failure
- **Security**: confirmation cannot be bypassed; the model cannot trigger execution without explicit user confirmation
- **Rollback**: simulate execution failure / timeout / cancellation; verify research context is preserved

#### Risks

- User confirmation UX unclear → accidental executions
- Testnet vs mainnet behavior divergence
- Context inheritance leaks too much (or too little) into execution
- Execution failure loses the research context the user wanted to revisit
- Responsibility boundary blurs (research vs execution) once it ships

#### Done criteria

- Research → execution handoff path works end-to-end on testnet
- Execution requires explicit user confirmation (no silent bypass)
- Failure / timeout / cancellation always returns to a usable research context
- Context inheritance is explicit (allow/deny list documented)
- Track B does not alter or block any Track A pipeline

---

## Cross-Theme Invariants

These hold across all Themes and should not be violated by any individual Theme implementation:

- **Observability is a hard deliverable per Theme** — not optional, not deferred
- **Each Theme must be independently testable** — no Theme blocks another's test execution
- **No premature abstraction** — interfaces above are at the boundary level only; internal structure stays flexible until execution
- **Plugin migration is part of Theme A1, not a follow-up** — old `get-news` plugins must be fully retired before A1 closes
- **Track A drives Track B** — Track B never reorders Track A. If they conflict, Track A wins.

---

## What this document is not

- Not an executable implementation plan — file paths, code, commands, TDD steps live in per-Theme implementation plans written **after the prior Theme + checkpoint completes**
- Not a product spec — product positioning lives in the planning doc
- Not a metrics doc — this round explicitly does not define numeric success metrics, cost budgets, or kill criteria (out of scope per planning doc Assumptions)
