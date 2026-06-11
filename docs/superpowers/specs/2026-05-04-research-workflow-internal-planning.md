# Research Pipeline Refactoring Plan

**Date**: 2026-05-04
**Purpose**: Alignment on direction, foundation for downstream engineering breakdown

## Summary

This document only discusses currently-confirmed problems in the research pipeline, organized into two parallel tracks:

- **Track A: Research Pipeline** (main line, 5 themes)
- **Track B: Trading Workflow Platform Extension** (parallel, 1 theme)

`Biconomy` is treated as an independent trading workflow platform extension and placed in Track B, so that it does not occupy Track A's critical path.

### Track A — 5 themes, in priority order:

1. S3 multi-source research data ingestion, per-source `Top K news` selection, and `sentiment` conventions (`summary` is read directly from S3, no transformation)
2. `Compre` classification error governance, research entry routing, and fallback strategy
3. End-to-end `latency` observability and performance breakdown framework covering **all major workflows** (comprehensive, regular Q&A, task chain, classification routing) — not just comprehensive
4. Memory system optimization for `continuous research` (direction + rules; specific architecture decided during execution)
5. Wrap the entire `comprehensive analysis` workflow as a **task-chain-consumable `skill`** (similar to Claude `skill`), so task chains can compose it; preserve the dual-artifact (`report` + `prediction`) output

Reasoning for this order:

- Build the research input layer first; without it, classification, artifacts, and memory have no foundation
- Stabilize the research entry routing next, so high-value requests reliably enter the research pipeline
- Then make performance structure visible — avoid debates that stay at "it feels slow"
- Once the layers above are clear, define what long-term memory should retain
- Finally, wrap the previous 4 themes into a single task-chain-consumable `comprehensive` skill, so task chains can use it as a standard capability

### Track B:

- `Biconomy` as the trading workflow platform extension — integration boundary and minimum viable scope

### Checkpoints

Within the linear sequence, 2 checkpoints are inserted to force decision windows for "should subsequent Themes be adjusted":

- **Checkpoint 1**: After A1 + A2 completes — verify the research input layer and classification governance are truly stable
- **Checkpoint 2**: After A4 completes — verify latency data and memory boundaries hold up under real research scenarios

Checkpoint outcome: "continue / minor adjustment / re-sequence subsequent Themes".

### Per-Theme hard deliverable: observability (high-level direction)

Each Theme must deliver, in addition to the capability itself, observability features (statistics, logs, dashboards) that make the system "visible". Specific fields, definitions, and implementation are decided during Theme execution.

- A1 → observability of source ingestion
- A2 → observability of classification decisions + automated collection of miss/false/unstable classification samples
- A3 → three-layer end-to-end latency landed (this is the Theme itself)
- A4 → observability of memory read/write activity
- A5 → observability of skill invocation by task chain + dual-artifact completion

### Default principles for this round of planning:

- The current core user is the `research-oriented user`
- `comprehensive analysis` is the primary capability for research users, not the default Q&A capability
- `macro_news / crypto_news / x_influencers / YouTube` are treated as four independent sources
- These four sources **fully replace existing get-news related plugins** — there is no longer a separate news-fetching plugin path
- Each source applies a configurable **Top K selection** (K is configurable per source/scenario) — this replaces the prior `topnews` rule
- `summary` is read directly from each S3 record as-is; no reuse logic, no fallback, no quality transformation in A1 (upstream data team owns summary quality)
- Sentiment numerical values are shown to users as text labels; raw values are retained internally
- `comprehensive analysis` is implemented as an internal capability layer similar to Claude `skill`
- `report` and `prediction` are generated within the same workflow but kept as two independent artifacts
- `Biconomy` is an independent trading workflow platform extension (Track B), not part of the research pipeline

---

## Overall Sequence

The recommended sequence is:

### Track A (Main Line)

| Theme | Outcome |
| --- | --- |
| Theme A1: Research Input Layer | S3 research input layer, per-source `Top K` rules, sentiment text labels, retirement of `get-news` plugins (`summary` read directly from S3) |
| Theme A2: Classification Governance | `Compre` classification error breakdown and first-phase governance strategy |
| **Checkpoint 1** | Decide: continue / minor adjustment / re-sequence |
| Theme A3: Latency Observability | End-to-end `latency` observability across all major workflows (comprehensive, regular Q&A, task chain, classification) — not limited to comprehensive |
| Theme A4: Memory System | Memory system optimization for `continuous research` — direction + rules only; architecture decided during execution |
| **Checkpoint 2** | Decide: continue / minor adjustment / re-sequence |
| Theme A5: Comprehensive as Skill | Wrap entire `comprehensive` workflow as a task-chain-consumable `skill`; dual-artifact (`report` + `prediction`) preserved |

### Track B (Parallel)

| Theme | Outcome |
| --- | --- |
| Theme B1: Biconomy Integration | `Biconomy` integration boundary and minimum viable scope as trading workflow platform |

Track B is parallel to Track A and does not block its critical path.

---

## Theme A1. S3 Multi-Source Research Data Ingestion, `Top K News` Selection, and `Summary / Sentiment` Conventions

### Problem Definition

Comprehensive currently has news and sentiment analysis capabilities, but no unified research input layer to handle the new sources and rules.

This round expands scope to include:

- Fetching `macro_news` from S3
- Fetching `crypto_news` from S3
- Fetching `x_influencers` from S3
- Fetching `YouTube` from S3
- These four S3 sources **fully replace the existing get-news related plugins** — the prior plugin-based news fetching path is retired in this round
- Configurable **Top K** selection applied to each of the four sources (K is configurable per source/scenario) — this replaces the prior `topnews` rule
- `summary` is read directly from each S3 record (no reuse-vs-summarize branching, no fallback)
- Sentiment values shown as text labels externally

### Why this layer comes first

- Without a stable input layer, downstream classification is just guessing what users want
- Without a stable input layer, latency cannot be broken down by source category
- Without a stable input layer, downstream memory will only retain inconsistent, non-reusable fragments
- Without a stable input layer, the final `comprehensive analysis` definition stays purely abstract

### Current project state

A codebase audit found the following:

**Already in place:**

- **`crypto_news` is fully integrated** via `packages/plugin-news/src/actions/getanews.ts` (S3 → `crypto_news/<date>/original_score/<symbol>/`); cached locally in `cache/news_*.json`
- **S3 SDK + credentials infrastructure already exists**: `@aws-sdk/client-s3` is installed; bucket configured via `SENTISCORE_S3_BUCKET` env var; auth via `SENTISCORE_ACCESS_KEY_ID` / `SENTISCORE_SECRET_ACCESS_KEY`; default region `us-east-2`
- **Sentiment ingestion is in production**: `packages/plugin-sentiscore/src/actions/crypto.ts` and `x.ts` pull hourly sentiment scores from S3 (`crypto_news/<date>/hourly_score/<symbol>/`); calculates `value = (positive - negative) / total` in `[-1, +1]`; raw values (`positive`, `negative`, `neutral`, `total`) persisted in cache
- **X-source sentiment is partially in place**: aggregated time-series sentiment from X exists, but **raw influencer feeds** (the `x_influencers` source) do not
- **`summary` is already read directly from S3** in `getanews.ts` (no transformation logic) — A1 keeps this pattern unchanged

**Important correction — `sentiscoredata-new`:** The repo contains `MIGRATION_PLAN.md` describing an in-progress S3 bucket rename from `sentiscoredata` to `sentiscoredata-new` (cross-region copy strategy). So `sentiscoredata-new` is the **target bucket of an ongoing migration**, not a newly introduced source. Theme A1 should consume `sentiscoredata-new` as the canonical bucket once the migration completes (or set the env var override during the transition).

**Real gaps:**

- `macro_news` is **not integrated** (no S3 path, no action, no callsite)
- `YouTube` is **not integrated**
- `x_influencers` raw feed is **missing** (only aggregated sentiment time-series exists today)
- **Top K selection is missing**: current news action hardcodes `slice(0, 5)`; no configurable K, no ranking signal, no per-source/per-scenario overrides
- **Sentiment text labels are missing as structured data**: numeric value persists, but text labels like `Very Bullish` / `Bullish` only appear inside LLM-generated prose (in `combine.ts`), not as a typed enum on the data record
- **Upstream summary quality is poor** (audit-confirmed): cached summaries from S3 frequently contain garbled text (e.g., `"OK school college why warrant…"`). This is a data-pipeline issue **upstream of A1**. A1 reads `summary` as-is — quality remediation is the data team's responsibility and is **explicitly out of scope for A1**

In short: S3 access + `crypto_news` + sentiment numeric + direct `summary` read are all there. A1's real work is **adding macro_news / YouTube / x_influencers raw feed, Top K selection, sentiment text labeling, and migrating callsites off the `get-news` plugin** — not building the S3 ingestion layer from scratch. Summary content quality is upstream's concern, not A1's.

### Four independent source definitions

This round keeps the four sources independent rather than merging them into a single feed:

- `macro_news`
  - For macro risk, policy, liquidity, and global event background
- `crypto_news`
  - For crypto news, project updates, on-chain narratives, and regulatory updates
- `x_influencers`
  - For KOLs, traders, research accounts, community sentiment, and narrative diffusion
- `YouTube`
  - For long-form opinion content, deep dives, show-format narratives, and video research material

### `Top K News` Selection

This round replaces the prior `topnews` rule with a per-source **Top K** selection mechanism:

- Each of the four sources (`macro_news / crypto_news / x_influencers / YouTube`) applies its own Top K selection
- **K is configurable** per source and per scenario — different research scenarios (e.g., breaking-news vs. weekly review) and different sources (e.g., long-form `YouTube` vs. high-volume `crypto_news`) may use different K values
- The `summary` field is read directly from each S3 record as-is (no reuse-vs-summarize branching, no secondary summarization)
- Top K is **not** a brute mix across all sources — each source's Top K stays independent and is consumed independently by downstream research workflow
- The role of Top K is to help downstream research workflow quickly access the most-worth-reading content per source, not to replace full source data
- These four sources' Top K outputs **fully replace** the prior `get-news` plugin path; downstream workflows must consume Top K results from this layer, not from the retired plugins

### Sub-problems for Top K

- `K configuration`
  - Where K values live (config file, runtime parameter, scenario template)
  - Defaults per source vs. overrides per scenario
- `ranking signal`
  - What signal drives the Top K ranking per source (sentiment score, recency, source authority, engagement, etc.)
  - Whether each source uses the same signal or source-specific signals
- `cross-source consumption`
  - How downstream workflow combines per-source Top K outputs without losing source attribution

### Sentiment text-labeling rules

For user display, instead of exposing raw numeric scores, use text labels such as:

- `Very Bullish`
- `Bullish`
- `Neutral`
- `Bearish`
- `Very Bearish`

The internal raw sentiment value is retained for:

- Ranking
- Weighting
- Prompt input
- Subsequent quality assessment

### Proposed input layer structure

- `source ingestion`
  - Define the four S3 paths and pulling mechanism
  - Define freshness, fallback, and missing-data handling
  - Define the migration/retirement plan for the existing `get-news` plugins
- `top K selection`
  - Define K per source/scenario (configurable)
  - Define per-source ranking signal, deduplication, and filtering rules
- `research-ready normalization`
  - Unify the structure across the four sources
  - Unify time, source, summary, sentiment, link, and tag fields
  - Output research-ready data structures for downstream workflow

### Sub-problems to break down

- `source contract`
  - What fields each source provides; which are required
- `freshness`
  - When data is considered stale; how to fall back when stale
- `top K ranking`
  - How candidate content per source is selected, deduplicated, and ranked
  - K configuration model (defaults vs scenario overrides)
- `plugin migration`
  - How existing `get-news` plugin call sites are migrated to consume Top K outputs from this layer; retirement timing for the old plugins
- `sentiment presentation`
  - How internal numeric values map to user-facing text labels
- `source attribution`
  - How final report and prediction retain source attribution, so research conclusions don't lose provenance

### Observability deliverable (high-level direction)

- Observability of source ingestion: per-source success rate, freshness, Top K selection result logs
- Specific fields, definitions, and implementation are decided during execution

### What this phase does not do

- Don't brute-merge four sources into a single feed that looks unified but is uncontrollable
- Don't extend to new external scraping pipelines; this round is locked to S3 ingestion
- Don't add a secondary summarization layer or `summary` quality validation in this Theme — `summary` is read directly from S3; quality is upstream's concern
- Don't implement sentiment text-labeling as a UI-only one-way change that drops the raw value

### Target state

- Comprehensive has an explicit research input layer rather than relying on scattered actions for data
- The four sources can be independently extended, rolled back, and weighted
- Per-source `Top K` selection and priority rules are clear
- Sentiment text-labeling becomes a stable standard

### Phase deliverables

(Marked as **reuse / extend / build new** based on the codebase audit.)

- Source-by-source integration status spec for the four sources — **mixed**: `crypto_news` reuse; `x_influencers` extend (raw feed); `macro_news` and `YouTube` build new
- A per-source **Top K selection rule** with K configuration model — **build new** (current code hardcodes `slice(0, 5)`)
- A spec for sentiment text-labeling externally and numeric retention internally — **build new structured layer** (raw values reuse; text labels are currently only in LLM prose, not typed)
- An input structure spec for downstream research workflow — **build new** (research-ready normalization across all four sources)
- A source fallback and missing-data handling table — **build new**
- A migration/retirement plan for existing `get-news` plugins replaced by the four sources (start by enumerating all callsites of `getNewsAction` and `Sentiment_Analysis`) — **build new**
- Source ingestion observability features (high-level direction; details decided during execution) — **build new**

### Dependencies

- None

### Success criteria

- The team can clearly distinguish the four sources' roles instead of pushing all research content into a single news entry
- Per-source `Top K` has clear invocation and ranking rules
- Downstream workflow consumes standardized research input rather than ad-hoc formats

### Phase conclusion

Theme A1 is not about adding more sources — it is about formally establishing the research input layer.

---

## Theme A2. `Compre` Classification Error Governance, Research Entry Routing, and `Fallback` Strategy

### Problem Definition

After the research input layer is prioritized, address the `Compre` classification error problem separately, so that "research input issues" and "routing accuracy issues" are not mixed into the same chapter.

### Why this is a problem

- If classification is unstable, research-oriented users get an unstable experience
- Mixing classification and data issues leads teams to adjust routing while integrating sources, causing priority confusion
- Classification error is itself a standalone governance problem and should have its own error model and fix order

### Current project state

The classification system is **substantially more mature than the original draft assumed**. A codebase audit found the following already in production:

**Already in place:**

- LLM-based 4-class classifier in `packages/core/src/handlers/langGraphPrecheck.ts` — categories: `REGULAR_MESSAGE` / `TRADING_INFO_MESSAGE` / `TASK_CHAIN_MESSAGE` / `COMPREHENSIVE_ANALYSIS_MESSAGE`
- Classification prompt template in `packages/core/src/templates/messageClassificationTemplate.ts` (includes crypto-relevance check + trading-continuation rule)
- Classification metadata persistence on `message.content.metadata`, consumed by all downstream handlers (`runtime.ts:2345-2379`)
- Execution log written to `logs/execution-log.jsonl` with classification, confidence, reasoning, and `isCryptoRelated` fields
- Basic fallback path: classification failure → defaults to `TASK_CHAIN_MESSAGE`
- Optional LangSmith tracing integration
- **Test question library `tests/questions/test_questions.json` with 126 questions across 5 levels** — exists but is not yet wired into a production validation loop

**Real gaps (this Theme's actual scope):**

- Failure samples are logged but **not structurally collected** — JSONL on disk, not queryable, no error-pattern tagging
- **Field extraction fallback is completely missing** — there is no dedicated extraction layer; trading parameter review is UI-modal-based, non-trading routes don't extract structured fields
- Observability is **not queryable** — JSONL files exist but no dashboard, no metrics, no per-class distribution view
- The 126-question library **is not connected to a regression validation loop** — no CI re-scoring, no production validation cadence
- No threshold-based alerting (e.g., low confidence, recurring miss patterns)

In short: classifier + routing + metadata + log + a question library are all there. A2's real work is **structured failure collection, field extraction fallback, queryable observability, and wiring the existing question set into a regression loop** — not rebuilding what already exists.

### Classification problem breakdown

- `Miss`
  - Requests that should enter the research pipeline don't
- `False positive`
  - Ordinary requests are wrongly sent to the research pipeline
- `Unstable`
  - Same kind of question gets inconsistent treatment

### Priority for this round

- 1st priority: `Miss`
- 2nd priority: `Unstable`
- 3rd priority: `False positive`

Reasoning:

- `Miss` directly damages research-oriented user value
- `Unstable` damages user trust in system behavior
- `False positive` mainly affects efficiency and cost, but should not outrank research capability itself in this phase

### Classification strategy

- Adopt `neutral balance`
- Goal is not "send more requests to compre"
- Goal is "what should enter, enters reliably; what shouldn't, doesn't"

### Sub-problems to break down

(Re-scoped after the codebase audit — focused on the real gaps, not on rebuilding what exists.)

- `existing classifier refinement`
  - Tune the existing prompt / rules in `messageClassificationTemplate.ts` for known miss patterns; do not rewrite the classifier
- `structured failure sample collection`
  - Move beyond JSONL-on-disk: structured store (queryable), with error-pattern tags (miss vs false-positive vs unstable) for periodic review
- `field extraction fallback`
  - Build the missing extraction layer: when classification succeeds but downstream needs structured fields (asset, time window, intent), how to extract and how to fall back when extraction fails
- `question set wired into regression loop`
  - Take the existing 126-question library, wire it into a regression validation loop (CI or scheduled run); flag accuracy drops
- `observability backend`
  - JSONL logs → queryable backend + dashboard view (per-class distribution, fallback frequency, confidence distribution)
- `threshold-based signals`
  - When does low confidence / recurring miss / fallback spike trigger a review signal?
- `override strategy`
  - When users explicitly request full analysis, is an explicit override allowed (and how is it audited)?

### Observability deliverable (high-level direction)

- Observability of classification decisions: per-pipeline request distribution, fallback trigger frequency, classification decision audit logs
- Automated collection of miss/false/unstable samples for periodic review
- Specific fields, definitions, and implementation are decided during execution

### What this phase does not do

- **Don't rebuild what already exists** — the LLM classifier, 4-class routing, metadata persistence, basic fallback, and 126-question library are all already in production; A2 builds on top
- Don't aim to eliminate all long-tail false positives upfront
- Don't optimize for "more requests entering research workflow" (coverage-driven)
- Don't hand off classification entirely to the model's self-learning loop without human review rules
- Don't churn on the prompt without first wiring the existing question set into the regression loop

### Target state

- Behavior of research-oriented requests entering the research workflow is stable
- Team has shared consensus on the fix order for `miss / false positive / unstable`
- Routing governance can advance independently without changing definitions of subsequent Themes

### Phase deliverables

(Marked as **reuse / extend / build new** based on the codebase audit.)

- A `miss / false positive / unstable` priority spec — **build new** (the priority itself is a Theme A2 commitment)
- Refined classification rules in the existing prompt template — **extend** (`messageClassificationTemplate.ts` is reused)
- A structured failure-sample collection mechanism with error-pattern tags — **build new** (current JSONL log is not structured)
- A field extraction fallback layer — **build new** (currently missing)
- The existing 126-question library wired into a regression validation loop (CI or scheduled) — **extend** (library already exists, loop is new)
- Classification observability backend + dashboard (per-class distribution, fallback frequency, confidence distribution) — **build new** (JSONL is not queryable)
- Threshold-based signal rules (when low confidence / miss spikes trigger review) — **build new**
- An override strategy spec (when explicit user requests bypass classification, with audit) — **build new**

### Dependencies

- Depends on Theme A1 having confirmed the research input scope and data richness

### Success criteria

- The team can clearly answer "which questions should enter the research pipeline"
- Classification governance priorities are organized around `miss-first`
- Routing problems are no longer mixed with data input problems

### Phase conclusion

Theme A2 is not about rebuilding the classifier — most of it already runs in production. It is about closing the **observability, structured failure collection, field extraction fallback, and regression validation** gaps so that high-value requests reliably and correctly enter the research pipeline.

---

## Checkpoint 1 (after Theme A2)

**Purpose**: Verify whether the foundation for the rest of Track A is stable

Decision questions:

- Does the input layer reliably produce research-ready data?
- Does classification governance reliably route research requests into the research pipeline?
- If either is not achieved, should A3 (Latency) be delayed?

Outcome: continue / minor adjustment / re-sequence subsequent Themes

---

## Theme A3. End-to-End `Latency` Observability and Performance Breakdown Framework

### Problem Definition

After the research input layer and entry rules have an initial stable definition, the next step is not optimization — it is making `latency` visible **across all major system workflows**, not just `comprehensive analysis`.

### Why this is a problem

- Without observability, you only know "the system is slow" but not where
- The system has multiple workflows (`comprehensive analysis`, regular Q&A / message handling, task chain execution, classification routing, etc.) — observing only one of them gives a partial picture; bottlenecks in one workflow can mask or amplify issues in others
- After adding four S3 inputs, per-source `Top K`, and downstream dual-artifact output, performance issues will be amplified — but the **non-comprehensive paths** (regular Q&A, task chain, classification) also lack systematic latency visibility today
- Continuing to add features without latency structure will make any product discussion get blocked by "speed uncertainty"

### Current project state

A codebase audit found that **the latency-tracking scaffolding is partially in place, but instrumentation is largely not wired up**.

**Already in place:**

- `packages/core/src/utils/usage.ts` records `responseTimeMs` per LLM call and persists token usage to DB via `saveTokenUsage()` — **this is the only operational latency instrumentation in the system today**
- All four major workflows (comprehensive / regular / task chain / classification precheck) have `startTime` annotations in their handlers, but the values are **rarely read or logged**
- `packages/core/src/utils/executionLogger.ts` writes to `logs/execution-log.jsonl` with action names, classification, and outcomes — **but no timing fields**
- LangSmith tracing is integrated optionally (gated by `LANGCHAIN_API_KEY`); when enabled, captures run trees with inputs / outputs / errors. It is **third-party only**, not a local metrics backend
- Task chain has progress tracking (`completed / total`); `TaskChainSnapshot` defines `startedAt / finishedAt` but they are **rarely populated consistently**; `TaskExecutor` captures per-task `executionTime` in result but **does not propagate it to logs**
- Comprehensive analysis has end-to-end timing logged at the workflow finish (one line in `comprehensiveAnalysisWorkflowGraph.ts`) — but no per-action / per-phase / per-stage timing

**Real gaps:**

- No metrics backend, no Prometheus / Grafana, no histogram export, no internal dashboard — `execution-log.jsonl` is append-only text on disk
- No S3 latency instrumentation (`http.ts` configures keep-alive but no timing capture)
- No per-plugin latency wrappers around external API calls
- No failure-vs-success latency separation
- No per-action timing in comprehensive analysis (knows 3 phases / 12 actions but only logs whole-workflow duration)
- No timing in regular Q&A workflow (streaming callbacks exist, but no latency capture)
- No timing in classification precheck path
- LangSmith integration exists but **does not surface per-stage breakdown** for the workflows that need it

In short: A3's real work is **wiring up the unused `startTime` annotations, building a metrics aggregator + queryable backend + dashboard, and instrumenting per-stage / per-plugin / per-LLM-call timing across all four major workflows** — not designing observability from scratch.

### Latency planning principles

- Observability before optimization

This round breaks latency into at least three layers:

- `workflow latency`
  - Total time structure of one research request from start to finish
- `plugin / action latency`
  - Which action, data fetch, summary, or generation is the slowest
- `end-to-end latency`
  - Full user-perceived latency from request initiation to receiving the final artifact

### Workflow coverage that must be observed

This Theme covers **all major workflows**, not only the comprehensive path:

- **Comprehensive workflow**
  - S3 four-source fetch latency
  - Per-source `Top K` selection latency
  - Report generation latency
  - Prediction generation latency
  - Memory write-back latency
- **Regular message workflow**
  - Precheck latency
  - Classification routing latency
  - Response generation latency
- **Task chain workflow**
  - Orchestration / dependency resolution latency
  - Per-task execution latency
- **Classification routing**
  - Rule-engine latency
  - LLM-call latency
  - Fallback path latency
- **Cross-cutting**
  - Per-plugin invocation latency
  - Per-LLM-call latency
  - Memory read / write latency across all callers

### Sub-problems to break down

- `coverage`
  - Which workflows must be covered in this round, and which can be deferred? At minimum: comprehensive, regular Q&A, task chain, classification routing
  - How to ensure no major workflow is silently uninstrumented at close
- `event granularity`
  - Time at the workflow, action, model-call, S3-call, or artifact-write level?
- `metric definition`
  - Average, P95, P99, or user-perceived time including failure retries?
- `interpretability`
  - Can the team look at metrics and immediately see the bottleneck across any workflow?
- `optimization priority`
  - Which segment to optimize first must be based on biggest impact and easiest convergence — across the system, not only comprehensive
- `quality protection`
  - Any speed optimization must not silently sacrifice research quality

### Observability deliverable (high-level direction)

- This Theme itself is the observability deliverable: three-layer latency breakdown landed
- Specific fields, definitions, and implementation are decided during execution

### What this phase does not do

- Don't cut models, sources, or summarization steps before observability data exists
- Don't equate "user feels slow" with "the model is too slow"
- Don't do large-scale performance refactor before bottlenecks are clear
- Don't preemptively change the dual-artifact definition for the sake of speed

### Target state

- The team knows where the system is slow, not just "it's slow"
- The team can break down latency for **all major workflows** (comprehensive, regular Q&A, task chain, classification) — not only the research path
- Subsequent performance work can be ranked by facts, not by feel

### Phase deliverables

(Marked as **reuse / extend / build new** based on the codebase audit.)

- A latency observability framework — **build new aggregation layer**, **reuse** `usage.ts` for LLM-call latency
- Wired-up `startTime` instrumentation for all four major workflows — **extend** (annotations exist, must be propagated to logs / store)
- A queryable metrics backend (database / analytics sink) replacing JSONL-on-disk — **build new**
- A dashboard with per-workflow drill-down — **build new**
- Per-plugin / per-S3-call / per-action timing wrappers — **build new**
- Failure-and-retry latency separation — **build new**
- Tagging convention with mandatory `workflow_type` field — **build new**
- A coverage-check audit step (no major workflow uninstrumented at close) — **build new**
- An optimization priority decision principle — **build new**
- LangSmith integration as optional tracing backend — **reuse** (already gated by `LANGCHAIN_API_KEY`)

### Dependencies

- Depends on Theme A1's research input layer being established
- Depends on Theme A2's research entry and fallback boundary being stable

### Success criteria

- The team can view latency at three layers: `workflow / plugin / end-to-end`
- All major workflows (comprehensive, regular Q&A, task chain, classification) have clear latency breakdown — not only the research/comprehensive path
- Coverage check at close: no major workflow is silently uninstrumented

### Phase conclusion

Theme A3's focus is not direct performance optimization, but making the performance structure of **all major system workflows** visible — research pipeline included, but not exclusively.

---

## Theme A4. Memory System Optimization for Continuous Research

### Problem Definition

After the input layer, classification, and latency are clearer, **optimize the memory system so it actually supports continuous research** — across sessions, across rooms, across time. This Theme commits to direction and rules; the specific architecture (number of layers, naming, storage backend, schema) is **explicitly deferred to execution**.

### Why this is a problem

- If memory only serves short-term chat, research users have to re-state context every time
- If only messages are stored, not research artifacts, reports and predictions cannot accumulate as continuous research assets
- If different memory scopes (current conversation context vs long-term user signal vs research artifacts) bleed into each other, transient conclusions will pollute long-term preferences
- Without clear scope rules, research context, execution context, and long-term user preferences can easily mix together

### Current project state

A codebase audit found that **the memory system is substantially more mature than this draft originally assumed**. The previous "prototypes for in-room message memory and user-feature extraction" understated reality.

**Already in place:**

- **SQLite database with 25 tables** at `agent/data/db.sqlite`, including:
  - `memories` — transient conversation memory, with embeddings, room-scoped
  - `user_features` — LLM-extracted user profile aspects (preferences, traits, goals, behavioral patterns), versioned
  - `knowledge` — RAG knowledge base, chunked + embedded, supports sharing
  - `cache` / `action_cache` — TTL-based action result caching
  - `rooms`, `participants`, `accounts`, `goals`, `relationships`, `logs`
- **Three memory categories already separated**:
  - Transient conversation context → `memories` table (`MemoryManager` in `packages/core/src/data/memory.ts`)
  - Long-term user signal → `user_features` table (`UserFeatureManager` in `packages/core/src/data/userFeatureManager.ts`); LLM-driven extraction batches every 5 user messages, generates 1–10 aspects per user
  - Research artifacts → file system (`agent/saved_data/Reports/` HTML, `agent/cache/reports/report-index.json` metadata)
- `MemoryManager`, `UserFeatureManager`, `RAGKnowledgeManager`, `ActionCacheManager` are all implemented
- Subscription-tier-based retention window enforced (`utils/dataRetention.ts`)
- Embedding similarity search and `unique` deduplication available on memories
- User feature semantic search via `formatUserTraitsForContext()`

**Real gaps:**

- **Cross-room recall is not implemented**: messages stay in their origin room; `getMemoriesByRoomIds()` exists but is rarely called; user aspects span rooms but messages don't
- **Research artifacts are not indexed in SQLite**: reports live as HTML files + a single `report-index.json` — not queryable, no full-text search, no per-report tagging
- **No "promote message to long-term" logic**: there is no rule for elevating a high-signal message (e.g., user conclusion, hypothesis) to durable storage beyond its origin room
- **User features are replacement-only, not versioned in history**: `removeAllMemories()` is called before storing new aspects; only the latest `version` number survives — prior versions are lost
- **Read priority framework is implicit, not explicit**: each handler decides what to inject into LLM context; there is no unified rule like "user signal trumps room recency when conflict"
- **No latency SLA for memory writes**: user feature extraction is non-blocking (background), but no measurement or tie-in to Theme A3
- **No per-conversation size cap or auto-drop**: subscription-tier window is the only ceiling; no "keep last N messages per room" rule
- **`user_features` table not pre-created in schema** (audit surprise): code assumes lazy creation on first use

In short: SQLite + memories + user_features + RAG + action cache + retention windows are all there. A4's real work is **closing the gaps** — cross-room recall, artifact indexing in SQLite, message-to-long-term promotion rules, explicit read priority framework, user-feature version history, and per-conversation scope control. Architecture (number of layers / naming / new tables) remains deferred to execution per the original direction.

### Direction (not architecture)

This Theme commits to direction, not implementation. The exact architecture is decided during execution, after the team learns from Theme A1 / A2 / A3 outputs.

What is decided here:

- Memory must serve `continuous research`, not be a chat patch
- Memory must clearly distinguish between content scoped to the current conversation, content reflecting long-term user signal, and content representing research artifacts — at the rule level, regardless of how many layers ultimately implement them
- Memory writes and reads must have explicit rules — what gets written, where, and which scope wins on read
- Memory must avoid degenerating into a "store-everything" warehouse

### Relation to previous themes

- Theme A1 defines the structured research input that memory can read from
- Theme A2 defines which requests reliably enter the research pipeline and are therefore worth persisting
- Theme A3 means memory write-back must also fit within the performance budget

### Sub-problems to break down

(Re-scoped after the codebase audit — focused on the real gaps, not on rebuilding what exists.)

- `cross-room recall`
  - When and how to look up relevant context outside the current room (memories don't span rooms today, only user aspects do)
- `artifact indexing in SQLite`
  - Move report metadata from filesystem JSON into a queryable schema; enable per-report tagging, full-text search, and retrieval by topic / asset / time window
- `message → long-term promotion rules`
  - When does a high-signal message (user conclusion, hypothesis, decision) get elevated beyond its origin room?
- `read priority framework`
  - Explicit rules for what context to inject into LLM, in what order, when scopes conflict — currently each handler decides ad-hoc
- `user-feature revision history`
  - Replace the current "replace-only" pattern with version retention, so prior versions can be inspected or rolled back
- `per-conversation scope control`
  - Rules beyond the global subscription-tier window — e.g., per-room size caps, auto-drop of stale messages
- `memory write latency budget`
  - Tie memory writes to Theme A3's latency SLA; today extraction is non-blocking but unmeasured

### Observability deliverable (high-level direction)

- Memory read/write activity is observable
- Specific fields, definitions, and implementation are decided during execution

### What this phase does not do

- Don't lock in a specific architecture in this planning doc — number of layers, naming, storage backend, and schema are decided during execution
- Don't auto-promote all messages to long-term memory
- Don't dump full long content into long-term storage before extraction rules are clear
- Don't make memory a generalized chat feature, ignoring its goal of supporting research continuity

### Target state

- Users don't repeatedly re-state research preferences
- Research context within a session can be continuously extended
- Research artifacts persist as long-term research assets
- Different memory scopes don't bleed into each other

### Phase deliverables

(Marked as **reuse / extend / build new** based on the codebase audit.)

- A direction-level definition of what the memory system serves — **build new** (the direction itself is the Theme A4 commitment)
- Scope rules across the three categories — **reuse with formalization** (the categories already exist in code; the rule layer is what's new)
- Cross-room recall mechanism — **build new**
- Research artifact indexing in SQLite (move from filesystem JSON to queryable schema) — **build new**
- Message-to-long-term promotion rules — **build new**
- Explicit read priority framework — **build new** (today implicit per handler)
- User-feature revision history (replace replacement-only pattern) — **extend** (`UserFeatureManager` reused, version retention added)
- Per-conversation scope control rules — **build new**
- Memory write latency budget tied to Theme A3 — **build new**
- Memory observability features (high-level direction; details decided during execution) — **build new**

### Dependencies

- Depends on Theme A1's research input layer being stable
- Depends on Theme A2's research entry boundary being stable

### Success criteria

- Users do not repeatedly re-state research preferences
- Research context can be continuously extended within a session
- Research artifacts can be retrieved when relevant
- No silent contamination across memory scopes (transient conclusions don't pollute long-term preferences)

### Phase conclusion

Theme A4's goal is not to define a specific memory architecture — it is to optimize the memory system so the previously defined research pipeline is actually continuous.

---

## Checkpoint 2 (after Theme A4)

**Purpose**: Verify whether latency data and memory boundaries hold up under real research scenarios

Decision questions:

- Does latency data expose any bottleneck that must be optimized before A5 wrap-up?
- Does the memory system (regardless of final architecture) hold up against real research scenarios?
- Is an optimization round needed before entering A5?

Outcome: continue / minor adjustment / re-sequence subsequent Themes

---

## Theme A5. `Comprehensive Analysis` Workflow as a Task-Chain-Consumable `Skill`

### Problem Definition

After the research input, entry rules, latency, and memory all have prerequisite conclusions, **wrap the entire `comprehensive analysis` workflow as a task-chain-consumable `skill`** — similar to Claude `skill`. The goal is to make `comprehensive` a standard capability the task chain system can discover, schedule, and compose into any chain. The `report + prediction` dual artifact is preserved as the skill's standard output.

### Why this matters

- Today, `comprehensive analysis` is a standalone workflow, not a node the task chain system can invoke
- When a task chain needs research analysis as a step, it has to either duplicate `comprehensive`'s logic or skip it entirely
- Without a standard skill interface, `comprehensive` cannot be composed into chains; it stays a "monolithic feature" instead of a reusable capability
- Wrapping it as a skill makes the value of A1–A4 directly accessible to the task chain system

### Why last

- Without converging the previous four themes, the skill contract has no real basis to stand on
- A skill contract must be built on real input, real routing, real performance boundary, and real memory structure — defining it too early means changes in A1–A4 will repeatedly invalidate the contract
- Task chain integration depends on a stable skill interface; building chains before the interface stabilizes is wasted work

### Current project state

A codebase audit found that **the comprehensive workflow and the task chain system both already exist, but the `skill` abstraction layer that bridges them does not**. A5's heaviest single piece of work is building the skill abstraction itself — not packaging an existing one.

**Already in place:**

- **Comprehensive workflow** is fully built: LangGraph-based, entry point `handleComprehensiveAnalysis()` in `packages/core/src/handlers/comprehensiveAnalysisWorkflowGraph.ts`; runs 12 actions across 3 phases (data gathering / analysis / prediction); generates an HTML report and saves it to `agent/saved_data/Reports/` (or S3)
- **Task chain system** is fully built:
  - `packages/core/src/tasks/taskChainPlanner.ts` — LangGraph planner that generates task plans from user requests
  - `packages/core/src/tasks/taskExecutor.ts` — executes individual tasks
  - `packages/core/src/tasks/chainOrchestrator.ts` — orchestrates chains with parallel/sequential execution by level
  - `packages/core/src/tasks/dependencyResolver.ts` — DAG validation
  - `packages/core/src/handlers/taskChainHandler.ts` — LangGraph wrapper
  - Supports human-in-the-loop approval interrupts (relevant prerequisite for B1's confirmation gate)
- **`plugin-prediction`** exists as a standalone Eliza plugin with one action — but in practice it is invoked as the final action inside comprehensive (priority 12 of 12)
- **Eliza plugin pattern** is the closest existing analog to "skill": plugins export `actions` / `evaluators` / `providers`; runtime loads them and merges into a global registry

**Critical missing pieces (these are A5's core work):**

- **No skill abstraction layer exists**. There is no `Skill` interface, no skill registry separate from the action registry, no discovery API, no versioning, no input/output contract beyond ad-hoc per-action shapes.
- **Task chain cannot currently invoke comprehensive as a single unit**. Comprehensive is a separate handler triggered by classification (`COMPREHENSIVE_ANALYSIS_MESSAGE` route); task chain is a different code path that runs its own planner/executor. The two never compose today.
- **`PREDICTION` is not an independent artifact**. It is one of 12 actions inside comprehensive, and its result is **embedded into the synthesized `analysisContent` narrative**, not exposed as a separate typed output. To preserve "dual artifact" (`report` + `prediction`), prediction must be lifted out as its own first-class artifact.
- **No demonstration chain exists** that proves comprehensive is usable as a chain node — naturally, since the abstraction enabling it doesn't exist yet.

**Quick wins to leverage:**

- Comprehensive is already LangGraph-based, so wrapping it as an externally-invocable skill is structural rather than algorithmic
- Task chain planner already supports human approval interrupts (reusable for B1)
- Report content (`htmlReport`) and prediction action result (`actionResults['PREDICTION']`) are already separate values in code — the dual-artifact split exists at the data level, just not at the contract level

In short: A5's core work is **building the missing skill abstraction layer (interface + registry + discovery + versioning), wrapping comprehensive into it, lifting prediction to a first-class artifact, integrating with the task chain system, and producing a demonstration chain**. None of that exists today. This is the largest "build new" Theme in Track A — re-evaluate scope and dependencies at Checkpoint 2.

### Prerequisites

Although "different users different needs" is no longer its own chapter, the document assumes:

- Current priority: `research-oriented users`
- Light users should not be slowed down by comprehensive
- Execution-oriented needs are addressed via `Biconomy` after the research pipeline is stable (Track B)

### Positioning of `comprehensive` as a skill

- The entire `comprehensive analysis` workflow is wrapped as **one** task-chain-consumable `skill`
- The skill is invoked by the task chain system, not by direct user routing
- The skill consumes a standard input contract and produces the dual artifact (`report` + `prediction`) as standard output
- Internal multi-stage logic stays inside the skill; the task chain treats it as a black box

### `Skill`-ification definition

This round's `skill`-ification is **wrapping the entire `comprehensive` workflow as a single, externally-callable skill**, similar to Claude `skill`. From outside, the task chain sees one skill: `comprehensive`. From inside, the existing multi-stage workflow remains.

It is **not** internal sub-skill decomposition — the focus is on the external skill contract, not on slicing comprehensive into smaller skills.

### Skill contract (direction-level, not signature)

- **Input contract** — what the task chain sends (asset / time window / research goal / question type / required vs degradable fields)
- **Output contract** — dual artifact (`report` + `prediction`) — structure, audience, length intent
- **Invocation contract** — how the task chain discovers, schedules, and consumes the skill
- **Failure contract** — which failures stop the chain, which let it skip / degrade / continue
- **Versioning contract** — how the skill evolves without breaking existing chains

### Task chain integration

- The task chain system can discover `comprehensive` in its skill registry
- The task chain can compose any chain that needs research analysis as a step
- The chain treats `comprehensive` as a black box: input goes in, `report + prediction` comes out
- The chain does not need to know `comprehensive`'s internal stages
- At least one demonstration chain that uses `comprehensive` must exist at the close of A5

### `report + prediction` as the skill's standard output

The current comprehensive has a `PREDICTION` step but it looks like an action in the flow rather than an independent artifact. This round changes it to:

- One skill invocation
- Two independent artifacts in the skill's output
- Sharing the same research context

Boundaries between the two artifacts:

- `report`
  - Targets full research delivery
  - Emphasizes evidence, structure, conclusions, risks, citations
- `prediction`
  - Targets future judgment delivery
  - Emphasizes direction, scenario branches, confidence, key triggers

### Sub-problems to break down

- `skill contract definition`
  - Input / output / failure / cancellation / versioning contracts
- `task chain integration`
  - Discovery, scheduling, composition into chains
- `internal-vs-external structure`
  - From outside: one skill. From inside: existing multi-stage workflow
- `dual-artifact in skill output`
  - How `report` and `prediction` co-exist in the skill's output, with independent failure handling
- `failure mode`
  - Which failures stop the chain, which let it skip / degrade
- `versioning`
  - How the skill interface evolves without breaking existing chains
- `user experience boundary`
  - When does the user perceive "the chain ran a comprehensive analysis" vs getting a regular answer

### Observability deliverable (high-level direction)

- Observability of skill invocation: how task chains call `comprehensive`, success / failure / degraded counts
- Observability of dual-artifact completion (`report` and `prediction`)
- Specific fields, definitions, and implementation are decided during execution

### What this phase does not do

- Don't make `comprehensive` a "catch-all heavy mode for any complex question"
- Don't mix trading or execution actions into the `comprehensive` skill at this phase
- Don't do extensive UI redesign for frontend display first
- Don't expand even larger feature scope while the skill contract is unstable
- Don't break the dual-artifact output by collapsing `report` and `prediction` into one product
- Don't slice `comprehensive` internals into many sub-skills at this phase — focus is on the **external** skill contract

### Target state

- The entire `comprehensive` workflow is wrapped as a task-chain-consumable skill
- Task chain can reference `comprehensive` in any chain via the standard skill interface
- `report` and `prediction` remain independent artifacts in the skill's output
- At least one demonstration chain consumes the `comprehensive` skill end-to-end

### Phase deliverables

(Marked as **reuse / extend / build new** based on the codebase audit.)

- A unified product definition of `comprehensive analysis` as a task-chain-consumable skill — **build new**
- The `Skill` interface itself + skill registry + discovery API — **build new** (no skill abstraction exists today)
- The `comprehensive` skill contract (input / output / invocation / failure / versioning) — **build new**
- A task chain integration spec (discovery + composition + failure handling) — **build new**
- Wrap existing comprehensive workflow as a skill entry — **wrap existing** (the LangGraph workflow stays; new layer wraps it)
- Lift `prediction` out of `analysisContent` into a first-class artifact — **extract new** (currently embedded in narrative text, must be exposed as a typed artifact)
- A `report + prediction` dual-artifact spec inside the skill output — **build new**
- At least one demonstration chain that uses the `comprehensive` skill end-to-end — **build new**
- Skill invocation observability (high-level direction; details decided during execution) — **build new**

### Dependencies

- Depends on Theme A1's research input layer being stable
- Depends on Theme A2's research entry boundary being stable
- Depends on Theme A3's latency observability framework being established
- Depends on Theme A4's memory system being stable
- Depends on the task chain system being available and willing to consume external skills

### Success criteria

- Task chain can invoke `comprehensive` as a single skill via the standard interface
- At least one demonstration chain consumes the skill end-to-end
- `report` and `prediction` remain independent artifacts in the skill output
- Failure modes are explicit (chain stops vs skips vs degrades)
- `comprehensive` is no longer a "monolithic feature" — it is a reusable capability

### Phase conclusion

Theme A5's goal is not to redesign `comprehensive`'s internal structure — it is to **wrap the entire `comprehensive` workflow as a task-chain-consumable skill**, so the value built across A1–A4 becomes a reusable capability that any chain can compose.

---

## Track B. `Biconomy` as Trading Workflow Platform Extension — Integration Boundary and Minimum Viable Scope

### Problem Definition

Define when and in what role `Biconomy` connects, as an independent trading workflow platform extension that is parallel to the research pipeline.

### Why this is a problem

- Bringing in trading execution before the research pipeline is stable would complicate problem localization and responsibility boundaries
- `Biconomy` is about execution channels, action safety, and the bridge from research to execution — not the same as performance governance
- Putting it inside the research main flow too early would make the team carry execution complexity prematurely

### Current project state

A codebase audit confirmed Track B is **almost entirely greenfield** — but with one useful pre-existing dependency.

**Already in place:**

- `viem` 2.21.58 is **already installed** in `package.json` — the canonical TypeScript Ethereum client library; can bootstrap wallet, RPC, and tx flows without adding new dependencies
- `bignumber.js` 9.1.2 is also installed (useful for precise numeric handling on amounts)
- The existing **task chain planner already supports human-in-the-loop approval interrupts** — directly reusable for B1's user confirmation gate

**Real state — completely missing:**

- No Biconomy integration (no `@biconomy/*` packages, no AA setup)
- No wallet code (no key management, no account abstraction setup)
- No on-chain execution actions, no transaction building, no gas estimation
- No research-to-execution handoff state machine
- No failure rollback to research context
- No trading plugin

In short: viem + task chain approval interrupt are foundational pieces that exist; everything else (Biconomy SDK, wallet, AA flow, execution actions, handoff state machine) is build-new. This validates the original B1 scope of "boundary definition + minimum viable scope, not deep implementation".

### Positioning of `Biconomy`

This round still defines `Biconomy` as:

- A new trading channel
- An independent platform extension parallel to the research pipeline

It is not the foundation of the research main pipeline, and not the first-phase priority capability.

### Prerequisites for `Biconomy` integration

- Research-oriented request entry boundary is mostly stable (Theme A2 in Track A)
- All major workflows have at least basic latency observability (Theme A3 in Track A) — so research vs execution latency can be cleanly distinguished
- This round only defines boundary and minimum viable scope; deep integration with memory or dual-artifact is not required

### Role of `Biconomy` in the doc

- A post-research extension after research completes
- First define its interface with research conclusions
- Don't mix it into the first-phase research workflow

Expected handoff:

- User completes the research pipeline
- After user confirmation, enter the execution pipeline
- `Biconomy` carries the execution channel — not the research judgment itself

### Sub-problems to break down

- `entry timing`
  - Enter immediately after research completes, or require explicit user confirmation
- `confirmation mechanism`
  - To what level must the user confirm before the system allows research → execution
- `context inheritance`
  - Which research results does the execution pipeline inherit; which should not be inherited
- `responsibility boundary`
  - Research module = recommendations, execution module = actions — how to write this clearly
- `failure strategy`
  - On execution failure, pipeline timeout, or user cancellation, how to return to research context instead of breaking the entire chain

### What this phase does not do

- Don't make `Biconomy` a new product center that retroactively dictates research pipeline design
- Don't allow the model to execute trading actions without user confirmation and boundary constraints
- Don't expand this round into a generic account abstraction platform build
- Don't do deep execution action composition design while the research pipeline is unstable

### Target state

- The boundaries between the research main pipeline and the execution channel are clear
- `Biconomy` integration does not retroactively pollute the research workflow design
- Execution-side extensions follow the order "research first, confirm next, execute last"

### Phase deliverables

- A `Biconomy` post-research positioning spec
- A boundary spec from research pipeline to execution pipeline
- A minimum viable scope spec for the execution pipeline
- A user confirmation and failure rollback spec

### Dependencies

- Depends on Theme A2's classification boundary being stable
- Depends on Theme A3's latency observability framework being in place
- Independent of Theme A4 (Memory) and Theme A5 (Comprehensive wrap-up) — start time is decided separately based on resource availability

### Success criteria

- `Biconomy` is in the right order — does not hijack research pipeline resources
- The team can clearly answer "when do we go from research to execution"
- The introduction of the execution channel does not blur research pipeline responsibility boundaries

### Phase conclusion

Track B's focus is not to immediately wire trading in — it is to clarify the boundary between the research pipeline and the execution pipeline.

---

## Acceptance Scenarios

To prevent the plan from staying purely abstract, the following scenarios are defined as engineering acceptance:

### Data input scenarios

- Pipeline can degrade when any of `macro_news / crypto_news / x_influencers / YouTube` is missing
- Each source produces its own Top K with K configurable per source/scenario
- `summary` is read directly from each S3 record (no transformation, no fallback)
- Existing `get-news` plugins are no longer called by downstream workflows — all news consumption goes through the four-source Top K outputs
- Sentiment is shown as text to users; raw value retained internally

### Classification and research entry scenarios

- Light Q&A requests should take the fast path, not trigger comprehensive
- Research-oriented requests should reliably enter the research pipeline
- Repeated similar research questions should produce stable research workflow entry
- High-value research questions should not frequently miss into regular answers
- Regular short questions should not be widely false-positive into the research pipeline

### Latency scenarios

- Per-source fetch latency, comprehensive latency, and artifact generation latency can be broken out
- Latency for non-comprehensive workflows (regular Q&A, task chain, classification routing) can also be broken out at three layers
- Long-tail latency in the input layer, downstream artifact flow, and any major workflow can be located independently

### `Biconomy` scenarios (Track B)

- `Biconomy` only appears as a post-research action after research completes
- The execution pipeline does not retroactively force the research workflow to make way for trading
- Without user confirmation, the execution channel is not entered

### Memory scenarios

- The system remembers the current research subject and time window across the same conversation
- The system retains long-term user preferences across sessions
- Generated research reports and judgments can be retrieved when relevant
- A new conversation does not wrongly inherit transient research judgments from a prior unrelated one

### Comprehensive skill scenarios

- The `comprehensive` workflow is invocable by task chain as a single skill via the standard skill interface
- Task chain can compose any chain that uses the `comprehensive` skill as a step
- A single skill invocation outputs both `report` and `prediction`
- Both artifacts share the same research context
- `report` leans toward analytical evidence; `prediction` leans toward future judgment
- When either artifact fails, there must be a degradation strategy — not silent failure of the entire skill output
- Failure of the `comprehensive` skill follows the explicit failure contract (chain stops / skips / degrades, never silent)
- At least one demonstration chain that uses the `comprehensive` skill end-to-end exists

---

## Assumptions

- This document replaces the prior "5-theme planning draft" as the new internal planning baseline
- The plan is split into Track A (research main pipeline, main line) and Track B (`Biconomy` trading workflow platform extension, parallel)
- Track B does not occupy Track A's critical path; start time and ownership are decided separately
- Two checkpoints are inserted in Track A (after A2 and after A4) to force decision windows
- Each Theme's hard deliverable includes observability features (high-level direction; details decided during execution)
- `Skill`-ification adopts an internal capability layer definition; not built as standalone plugins first
- The four S3 sources stay independent; no premature merge into a single unified feed
- The four S3 sources fully replace the existing `get-news` related plugins; the prior plugin-based news fetching path is retired in this round
- Each source applies a configurable **Top K** selection (K configurable per source/scenario), replacing the prior `topnews` rule
- Sentiment is shown as text externally; raw values retained internally
- `report + prediction` is one workflow with two artifacts, not a single report chapter
- This round explicitly does not define numeric success metrics, resource assumptions, kill criteria, user dogfood mechanism, or cost budget — these are out of scope
