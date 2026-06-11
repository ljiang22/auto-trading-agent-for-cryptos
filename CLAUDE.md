# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Senti-Agent** is a comprehensive AI agent framework for cryptocurrency market analysis and autonomous task execution. It's a monorepo built on the Eliza framework, featuring:
- Multiple AI model provider integrations (OpenAI, Anthropic, Google, Groq, etc.)
- Specialized crypto/trading analysis plugins
- Database adapters (SQLite, MongoDB/DocumentDB)
- Client implementations (Direct, Twitter)
- Task chain execution with LangGraph
- Real-time streaming capabilities

**Tech Stack:** Node.js 23+, TypeScript, pnpm (monorepo), Turbo (build orchestration), Vite (frontend)

## Building & Development Commands

### Installation & Setup
```bash
pnpm install                # Install all workspace dependencies (required - enforces pnpm via preinstall hook)
pnpm build                  # Build all packages with Turbo pipeline (excludes docs)
pnpm build-docker          # Build all packages for Docker (includes docs)
pnpm clean                 # Remove node_modules, dist, .turbo, and build caches
```

### Running the Agent
```bash
pnpm start                  # Start agent with workspace context (@sentiedge/agent package)
pnpm start:client          # Start Vite client dashboard (separate terminal, then visit http://localhost:5173)
pnpm start:debug           # Start agent with debug logging (DEBUG=eliza:*, DEFAULT_LOG_LEVEL=debug)
pnpm cleanstart            # Remove SQLite database and start fresh
pnpm cleanstart:debug      # Remove database and start with debug logging
pnpm dev                   # Combined workflow: builds, watches, hot-reloads (for active development)
```

### Code Quality
```bash
pnpm lint                  # Lint code using Biome
pnpm format                # Format code using Biome
pnpm check                 # Run lint and format with auto-fix
```

### Testing
```bash
pnpm test                  # Run all unit tests across all packages
pnpm test -- core         # Run tests for a specific package (e.g., core)
pnpm test -- packages/core/src/__tests__/runtime.test.ts  # Run a single test file
pnpm test:coverage        # Run tests with coverage report
pnpm smokeTests           # Run smoke tests (basic functionality checks)
pnpm integrationTests     # Run integration tests
pnpm test:streaming       # Run streaming-specific tests
pnpm test:rag             # Test RAG (Retrieval Augmented Generation) implementation
```

### Docker
```bash
pnpm docker:build         # Build production Docker image (linux/amd64)
pnpm docker:run           # Run Docker image locally on port 3000 with .env
pnpm docker               # Build and run in one command
```

### Process Management (PM2)
```bash
pnpm pm2:start            # Start agent with PM2 process manager
pnpm pm2:restart          # Restart PM2 process
pnpm pm2:logs             # View PM2 logs
pnpm pm2:status           # Check process status
```

### Database Migration
```bash
pnpm migrate:sqlite-to-mongodb  # Migrate from SQLite to MongoDB (data preservation)
```

## Architecture & Code Organization

### Directory Structure
```
senti-agent/
├── agent/                          # Main agent entry point (@sentiedge/agent)
│   └── src/
│       ├── index.ts               # Starts agent, loads characters, initializes clients
│       ├── defaultCharacter.ts    # Default AI character configuration
│       └── databaseAdapterSelection.ts  # Logic for choosing SQLite vs MongoDB
│
├── packages/                       # Monorepo packages (managed by pnpm workspaces)
│   ├── core/                      # Core agent framework (@elizaos/core)
│   │   └── src/
│   │       ├── core/              # Core abstractions (runtime, actions, context, goals, messages)
│   │       ├── ai/                # AI providers & embedding (models.ts, generation.ts, embedding.ts)
│   │       ├── data/              # Data layer (database, memory, posts, relationships, RAG)
│   │       ├── handlers/          # Message processing workflows (LangGraph-based)
│   │       ├── templates/         # Prompt templates (message classification, task chains, etc.)
│   │       ├── utils/             # Utilities (logger, uuid, pricing, subscriptions)
│   │       ├── validation/        # Input parsing & validation
│   │       ├── config/            # Configuration & environment
│   │       ├── tasks/             # Task chain planning & execution
│   │       └── database/          # Database abstraction (CircuitBreaker)
│   │
│   ├── client-direct/             # Direct HTTP client for agent interaction
│   ├── client-twitter/            # Twitter/X client integration
│   ├── agent-twitter-client/      # Twitter API client wrapper
│   │
│   ├── adapter-sqlite/            # SQLite database adapter (with vector support)
│   ├── adapter-mongodb/           # MongoDB/DocumentDB adapter
│   │
│   ├── plugin-*/                  # Analysis, data, and trading plugins
│   │   ├── plugin-news/                    # Financial news aggregation (S3 dual format)
│   │   ├── plugin-sentiscore/              # Sentiment scoring + chart generation
│   │   ├── plugin-technic_analysis/        # Technical analysis (TA indicators)
│   │   ├── plugin-on_chain_data/           # Blockchain data (CoinMetrics, Solana, etc.)
│   │   ├── plugin-coinmarketcap/           # Market data integration
│   │   ├── plugin-web-search/              # Web search via Tavily (with key manager)
│   │   ├── plugin-charts/                  # Chart generation (canvas → PNG, async toBuffer)
│   │   ├── plugin-prediction/              # Price prediction models
│   │   ├── plugin-fearandindex_analysis/   # Fear & Greed Index analysis
│   │   ├── plugin-institutional_adoption/  # Institutional adoption signals
│   │   ├── plugin-launchpad/               # Token launch data
│   │   ├── plugin-content-analysis/        # Content/topic analysis
│   │   ├── plugin-crypto_research_search/  # Crypto research search
│   │   └── plugin-cex/                     # Centralized exchange trading (Coinbase, Binance)
│   │
│   ├── cli/                       # Command-line interface
│   ├── dynamic-imports/           # Dynamic module loading utilities
│   └── outputs/                   # Output formatting utilities
│
├── client/                         # Vite React frontend (port 5173)
│   └── src/
│       ├── pages/                 # Page components (Chat, Admin, etc.)
│       ├── components/            # UI components (Radix UI + Tailwind)
│       └── hooks/                 # React hooks & API integration
│
├── characters/                     # Character definition JSON files (AI personalities)
│
├── scripts/                        # Build & test scripts
│   ├── dev.sh                     # Development workflow script
│   ├── test.sh                    # Test runner script
│   ├── clean.sh                   # Cleanup script
│   ├── test-rag.mjs              # RAG testing
│   └── migrate-sqlite-to-mongodb.mjs
│
├── docs/                          # Documentation (Docusaurus)
├── .github/                       # PR templates, issue templates
├── turbo.json                    # Turbo build pipeline configuration
├── pnpm-workspace.yaml           # Monorepo workspace definition
├── biome.json                    # Linter/formatter configuration
└── Dockerfile                    # Multi-stage production build (Node 23.3.0)
```

### Core Architecture Patterns

#### 1. **AgentRuntime** (packages/core/src/core/runtime.ts)
Central orchestration class managing:
- AI model initialization and token management
- Database & cache layer setup
- Client/plugin initialization
- Message processing workflows (delegates to handlers)
- Memory & knowledge management

Key methods: `initialize()`, `processActions()`, `getMemoryManager()`, `databaseAdapter`

#### 2. **Message Handling Workflows** (packages/core/src/handlers/)
Specialized handlers process messages based on classification:
- **regularMessageHandler.ts** - Standard conversations; forwards `onToken` for live LLM streaming
- **taskChainHandler.ts** - Multi-step task execution via LangGraph supervisor; honors `runtime.getAbortSignal()` for Stop button; exports `TASK_CHAIN_APPROVAL_CANCELLED_BY_DISCONNECT` sentinel so SSE close during a paused approval becomes a clean cancel, not a "💥 Task Chain Error"
- **comprehensiveAnalysisWorkflowGraph.ts** - Multi-action LangGraph for the 13-step "Comprehensive Analysis" pipeline (web_search → CRYPTO_RESEARCH → getnews → Sentiment_Analysis → Technical → Fear-Greed → On-Chain Inflow/Outflow → PREDICTION → final summary → Report Generation, etc.). Owns the global concurrency gates and the per-action `[Memory]` probes
- **cexWorkflowMessageHandler.ts** - CEX (Coinbase / Binance) order-review flow with TTL-based approval context (15 min)
- **actionprocess.ts** - Action execution & processing
- **langGraphPrecheck.ts** - Lightweight gate before invoking LangGraph workflows

Each handler uses prompt templates to structure LLM interactions and emits SSE events through `runtime` callbacks (`onToken`, `onProcessingStep`, etc.).

#### 3. **Database Layer** (packages/core/src/data/)
Abstracts two database options:
- **SQLite** (default, via @elizaos-plugins/adapter-sqlite): Single-file, embedded, with vector support
- **MongoDB/DocumentDB** (via @elizaos-plugins/adapter-mongodb): Cloud-compatible, scalable

Classes: `Memory`, `RAGKnowledgeManager`, `Relationships`, `Posts`, `ChatMessage`

Selection logic in `agent/src/databaseAdapterSelection.ts` - prioritizes MongoDB if connection string provided, falls back to SQLite.

#### 4. **Plugin System**
Plugins are objects with:
- `name` & `npmName` properties
- `clients` array (optional) - for client implementations (Twitter, Discord, etc.)
- `actions` array (optional) - custom actions available to agent
- `providers` array (optional) - data sources the agent can query
- `evaluators` array (optional) - decision-making evaluators
- `services` array (optional) - background services/schedulers

Dynamically imported at startup in `agent/src/index.ts` via `handlePluginImporting()`.

#### 5. **Character System**
JSON configuration files (in `characters/` directory) define agent personalities with:
- `name`, `description`, `modelProvider` (OpenAI, Anthropic, etc.)
- `settings.secrets` - API keys per character (can override .env)
- `plugins` - array of plugin names to load
- `knowledge` - background knowledge/context
- `post_examples` - training data for style
- `clients` - which clients this character uses (Twitter, Discord, etc.)
- `extends` - can inherit from other character files

Auto-loads all `.json` files from `characters/` directory at startup.

#### 6. **Task Chain Execution** (packages/core/src/tasks/)
LangGraph-based workflow orchestration:
- `taskChainPlanner.ts` - Breaks goals into subtasks
- `taskChainHandler.ts` - Executes task chains with supervision
- Prompt templates structure the planning & execution via LLM

Used for complex multi-step goals requiring verification between steps.

### Configuration & Environment

**.env.example** defines all available settings:
- `SERVER_PORT`, `SERVER_URL` - HTTP server config
- `MONGODB_CONNECTION_STRING` - Optional MongoDB (if not set, uses SQLite)
- `CACHE_STORE` - database, filesystem, or redis
- Database adapter selection via `DATABASE_ADAPTER` env var (sqlite | mongodb | documentdb)
- API keys for models: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, etc.
- Client credentials: `DISCORD_API_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TWITTER_API_KEY`, etc.

**packages/core/src/config/settings.ts** - Parsed environment singleton

**packages/core/src/config/environment.ts** - Zod schema validation (partial)

### Testing Strategy

- **Unit tests** - Use Vitest (packages/core/__tests__/, plugins have tests)
- **Test setup** - packages/core/src/test_resources/testSetup.ts
- **Test timeout** - 120000ms (2 minutes) configured in vitest.config.ts
- **Coverage** - Run with `pnpm test:coverage` in specific packages

Key test patterns:
- Mock characters & runtime in `mockCharacter.ts`
- Test database operations, memory, parsing, evaluators, etc.
- Example: `packages/core/__tests__/runtime.test.ts`

### Build System (Turbo Pipeline)

**turbo.json** defines:
- Task dependencies (@elizaos/core must build before agent/plugins)
- Cached outputs in `.turbo/`
- Agent build depends on all plugins and adapters

Run with: `pnpm build` (uses Turbo's parallelization)

For incremental builds during development: `pnpm dev` (watches core package, auto-restarts agent)

### Code Quality

**Linter: Biome** (biome.json)
- Configured rules for TypeScript/JavaScript
- Suspicious patterns flagged as warnings
- Style guide: double quotes, always semicolons
- Ignores: dist/, node_modules/, coverage/, *.json files

### Deployment

**Docker** (Dockerfile)
- Multi-stage build: builder → runtime
- Installs native module dependencies (ffmpeg, libcairo2, etc.)
- Pre-bakes BGE-M3 embedding model at build time
- Environment: NODE_ENV=production, 3GB heap limit
- Entrypoint: `pnpm --filter @sentiedge/agent start`
- Runs on port 3000

**AWS/DocumentDB** - Supports TLS via global-bundle.pem (baked into image)

### Production DocumentDB cluster (`sentiedge-docdb`)

Migrated 2026-05-11 from the legacy `sentiedge-docdb-staging` cluster.

| Property | Value |
|---|---|
| Cluster ID | `sentiedge-docdb` |
| Region | `ap-southeast-1` |
| Endpoint | `sentiedge-docdb.cluster-c70au6iei11v.ap-southeast-1.docdb.amazonaws.com:27017` |
| Reader endpoint | `sentiedge-docdb.cluster-ro-c70au6iei11v.ap-southeast-1.docdb.amazonaws.com:27017` |
| Engine | DocumentDB 5.0.0 |
| Encryption at rest | **AWS-managed KMS key** (`alias/aws/rds`) |
| Backup retention | 7 days |
| Deletion protection | enabled |
| Instances | 1 × `db.t3.medium` in `ap-southeast-1a` (`sentiedge-docdb-instance-1`) |
| Master username | `senti_doc_041226` |
| Subnet group | `sentiedge-docdb-subnets` (3 AZs in `vpc-08f0aa49d03cf2683`) |
| Security group | `sg-084676b3315e35c16` |
| TLS CA bundle | `/app/global-bundle.pem` (image-baked); `global-bundle.pem` at repo root for local |

**Database naming convention** — one cluster, two databases, namespace isolation:

- Production: `senti-agent-prod` (task def `sentiedge-agent:*` env `DOCUMENTDB_DATABASE=senti-agent-prod`)
- Staging: `senti-agent-staging` (task def `sentiedge-agent-staging:*` env `DOCUMENTDB_DATABASE=senti-agent-staging`)

**Do NOT use `elizaAgent`** — it was the pre-2026-05-11 database name on the legacy `sentiedge-docdb-staging` cluster and is retired. The MongoDB adapter (`packages/adapter-mongodb/src/index.ts`) throws if `DOCUMENTDB_DATABASE`/`MONGODB_DATABASE` is unset — there is no longer a silent fallback.

**Connection env vars** (consumed by `packages/adapter-mongodb`):

- `DATABASE_ADAPTER=documentdb`
- `DOCUMENTDB_CONNECTION_STRING` — full mongodb URI with master credentials, `tls=true`, `tlsCAFile=/app/global-bundle.pem`, `replicaSet=rs0`
- `DOCUMENTDB_DATABASE` — `senti-agent-prod` or `senti-agent-staging`
- `DOCUMENTDB_CA_FILE=/app/global-bundle.pem`
- `MONGODB_DATABASE` mirrors `DOCUMENTDB_DATABASE` (legacy alias still read)

## Common Development Patterns

### Adding a New Plugin

1. Create `packages/plugin-<name>/` directory with structure:
   ```
   src/
   ├── index.ts              # Default export: plugin object
   ├── actions/              # Custom action files
   ├── providers/            # Data provider files
   └── types.ts              # TypeScript interfaces
   package.json              # With @elizaos-plugins/ scope
   tsconfig.json
   ```

2. Export plugin object with `name`, `npmName`, `actions`, `providers` properties

3. Add to `agent/package.json` dependencies and `agent/src/index.ts` plugins array

4. Import plugin package in core or agent to make available

### Working with the Core Package

The core package is fundamental and heavily imported. When modifying:
1. Run `pnpm --filter @elizaos/core build` to compile changes
2. Other packages will see compiled JS via `../core/dist`
3. Use `pnpm --filter @elizaos/core test` to validate changes
4. In development, use `pnpm dev` to watch for changes

### Running a Single Test

```bash
# Run vitest directly for core package
pnpm --filter @elizaos/core test -- runtime.test.ts

# Or use root test script with package name
pnpm test -- core
```

### Database Selection at Startup

Check `agent/src/databaseAdapterSelection.ts`:
- Reads `DATABASE_ADAPTER` env var (or .env file)
- Falls back to SQLite if not specified
- Actual adapter loaded dynamically in `startAgent()` from agent/src/index.ts
- To use MongoDB: set `MONGODB_CONNECTION_STRING` and optionally `DATABASE_ADAPTER=mongodb`

### Adding Environment Variables

1. Add to `.env.example` with clear description
2. Add Zod schema in `packages/core/src/config/environment.ts` (partial validation in place)
3. Access via `settings.<VAR_NAME>` or `process.env.<VAR_NAME>`
4. For character-specific secrets: `character.settings?.secrets?.<VAR_NAME>`

### Debugging

```bash
# Start agent with full debugging
pnpm start:debug

# In code, use:
import { elizaLogger } from "@elizaos/core";
elizaLogger.info("message");
elizaLogger.debug("debug info");
elizaLogger.warn("warning");
elizaLogger.error("error");
```

Logger respects `DEFAULT_LOG_LEVEL` env var (info, debug, warn, error)

### Working with Streaming

The framework supports streaming responses. Key files:
- `packages/client-direct/` - HTTP client for streaming
- Tests in `tests/streaming-*.js`
- Streaming configured via `SSE_KEEPALIVE_INTERVAL`, `STREAM_TIMEOUT` env vars

### Memory & Knowledge Management

- **Memory** (packages/core/src/data/memory.ts) - Conversation history per user/room
- **RAGKnowledgeManager** (packages/core/src/data/ragknowledge.ts) - Vector embeddings + retrieval
- **Knowledge** (packages/core/src/data/knowledge.ts) - Static knowledge base
- **LocalEmbeddingModelManager** (packages/core/src/ai/localembeddingManager.ts) - BGE-M3 embeddings (cached, preloaded at startup)

### AI Model Provider Management

See `agent/src/index.ts` `getTokenForProvider()` - Maps 40+ model providers to their API keys:
- OpenAI, Anthropic, Google, Groq, Mistral, etc.
- Supports character-level secrets override
- Falls back to settings/env if not in character config

## Key Files & Entry Points

| File | Purpose |
|------|---------|
| `agent/src/index.ts` | Agent startup, character loading, client initialization |
| `packages/core/src/core/runtime.ts` | AgentRuntime orchestration class |
| `packages/core/src/core/types.ts` | Core TypeScript interfaces (Content, Actor, etc.) |
| `packages/core/src/handlers/regularMessageHandler.ts` | Main message processing pipeline |
| `packages/core/src/handlers/taskChainHandler.ts` | Multi-step task execution |
| `packages/core/src/ai/models.ts` | LLM provider configuration |
| `packages/core/src/data/database.ts` | Database interfaces |
| `packages/adapter-sqlite/src/index.ts` | SQLite adapter implementation |
| `packages/adapter-mongodb/src/index.ts` | MongoDB adapter implementation |
| `packages/client-direct/src/api.ts` | HTTP API endpoints |

## Version Information

- **Node.js:** 23.3.0 (required)
- **pnpm:** 9.15.7
- **TypeScript:** 5.6.3
- **Turbo:** 2.4.4
- **Vitest:** 3.0.5

## Major Subsystems (recent work, April–May 2026)

The sections below capture architectural context that is not derivable from a quick read of the code: load-bearing invariants, production-tuned constants, and the *why* behind non-obvious choices. Treat these as required reading before touching the named files.

### Comprehensive Analysis Workflow

The flagship feature: a 13-step multi-action LangGraph orchestration that generates a long-form daily/on-demand crypto report (Executive Summary → Technical → Fear & Greed → On-Chain → Sentiment → News → Prediction → … → Report Generation).

**Key files**
- `packages/core/src/handlers/comprehensiveAnalysisWorkflowGraph.ts` - Graph definition, concurrency gates, per-action memory probes, snapshot building
- `packages/core/src/utils/comprehensiveAnalysisSnapshot.ts` - Slim snapshot for client persistence
- `packages/core/src/utils/executiveSummaryFromMarkdown.ts` - Extracts the visible `### N. Executive Summary` heading body verbatim from the rendered report (English + Simplified Chinese synonyms). Replaces an older LLM-generated parallel summary
- `packages/core/src/utils/reportMetadataExtractor.ts` - Builds chart specs from action results; sentiment series is **day-bucketed and weighted by sample count** (not a simple `sum/count` mean) so single-article hours can't produce ±1.0 spikes
- `client/src/components/ComprehensiveActionTab.tsx` - Per-action panel UI; renders Executive Summary through `MarkdownRenderer`; "Analysis Report" button navigates to `/report/daily?source=ondemand&fileName=...`
- `client/src/routes/daily-report.tsx` - Single component renders both daily-scheduled and on-demand reports; `source=ondemand` switches read paths to `/reports/Reports/` + `Charts/`

**Concurrency model (PR #150)**
Two gates in series, replacing the older single-flight rejection:

1. **Per-user max 1** — a user's second submission queues until their first finishes (avoids self-DoS from misclicked double-runs).
2. **Global max 3** across all users — `(N+1)`th caller queues instead of receiving a "busy" error. Configurable via `GLOBAL_CONCURRENCY` constant; `COMPREHENSIVE_ANALYSIS_CONCURRENCY` defaults to 3 (was 2 on the older 8 GB Fargate).

State lives in `inFlightSlots: Map<slotId, InFlightSlot>` + `userInFlight: Map<userId, slotId>` + a FIFO `waitQueue`. `acquireLock` is async and always resolves with a `slotId`. `reapStaleSlots` enforces a **25-minute stale-lock takeover** so an exception that bypasses `finally` cannot brick the agent until restart.

**Queue-position events (PR #153)** — `acquireLock` accepts an `onQueued` callback. While a request waits, the workflow handler emits a `Queue Wait` `ProcessingStep` carrying `data.queue.{position, inFlight, capacity}` and a `completed` step when the slot frees. Skipped for scheduler-driven runs. Without this, users perceived a 3–6 minute frozen UI when stacked behind their own first run.

**Memory budget (PRs #146, #148, #150)** — Production runs on **16 GB ECS Fargate tasks**.
- V8 heap: `--max-old-space-size=12288` (12 GB) plus `--expose-gc` so we can call `global.gc()` deterministically. Leaves ~4 GB for native (BGE-M3 ~2 GB, LLM stream `Buffer`s, canvas).
- Per-run peak rss was ~8.5 GB pre-fix → ~2.1 GB post-PR #148 (drop the 3.2 GB `composeState` leak in `web_search`; serialize Phase 1).
- Three concurrent runs sit at roughly idle (~1.9 GB) + 3 × ~0.2 GB ≈ ~2.5 GB above baseline.

**Per-action memory logging** — `[Memory]` log lines emit at workflow start/end, pre/post each action, and around the final-summary `generateText`. Each line carries `rss / heapUsed / heapTotal / external / arrayBuffers` in MB. CloudWatch alerting can distinguish **V8 heap pressure** (JS state) from **native pressure** (`Buffer`s, BGE-M3, canvas). For deeper localization, `withMemProbe` wrappers (see `packages/core/src/utils/memoryProbe.ts`) emit `MemoryProbe <site>` lines around `composeState`, `workflowHandler`, `scheduler.ensureConnection`, `scheduler.handleComprehensiveAnalysis`, and `acquireLock`. A continuous `sampler.idle.baseline` (60 s tick, started in the `DirectClient` constructor) makes the *idle* gaps observable, not just the active workflows.

**Snapshot serialization (PRs #125, #127, #130, #132)** — `serializeMemoryForClient` and `serializeComprehensiveSnapshot` ship a *slim* `actionResultSummaries` (and `executionResultSummaries` for task chains) instead of full per-action `Memory` objects. Critical fields that **must** be projected into the slim form:
- `chartPath` / `chartPaths` — without these, `ChartEmbed` re-mounts on refresh return `[]` and the chart silently disappears (PR #125).
- Failed actions (`metadata.success = false`) — synthesized via `buildFailedActionMemory()` from all three failure branches in `executeActions`. Without them the UI shows "12/13 completed" with no failure visibility (PR #132). The synthesized Memory is **not** written to the message store — the chat transcript stays clean; it lives only in workflow state for snapshot construction.
- `completedActions` is now counted directly from the snapshot (no `+1` for the report row); the older formula double-counted on success and inflated counts on failure.

**Delivery-status hints (PR #153)** — When a comprehensive analysis finishes after the originating SSE has closed (e.g. user navigated away during the 3-minute run), the result lands silently in DB. A per-room SSE liveness registry (`__activeStreams`, populated by `client-direct` on stream open/close) is checked at workflow completion; the response Memory is tagged with `metadata.deliveryStatus` (`'sse-streamed'` vs `'persisted-only'`) plus a `completedAt` timestamp. A `[Recovery]` log line is emitted for persisted-only results so support can correlate.

### Streaming Architecture

End-to-end SSE token streaming (PR #117 release notes):
- Bearer JWT auth on the SSE endpoint; replaced legacy header schemes
- Action plugins receive `onToken` and stream LLM deltas live; `REGULAR_MESSAGE` classified dispatch forwards `onToken` end-to-end
- Comprehensive workflow streams tokens, **closes the stream early** before `[DONE]` once the final narrative is painted, then `onComplete` cleans up ghost bubbles client-side

**Stop button reliability (PRs #119, #128)** — The classic bug pattern in this codebase:

1. `runtime.AbortController` field; `stopProcessing()` aborts mid-stream LLM calls; `resetStopFlag()` creates a fresh controller. Inter-level `generateText()` in `taskChainSupervisor.ts` receives `signal: runtime.getAbortSignal()`.
2. `StreamingApiClient` (client) is stabilized with `useMemo` so `cancelStreamForAgent` targets the instance that holds the live `AbortController`s. **Re-instantiating it on every render was the original bug** — Stop aborted an empty controller while the live fetch kept running.
3. `userStoppedAgentIds` intent flag classifies post-Stop teardown errors (`AbortError`, HTTP/2 reset, "network error", "Load failed") as intentional completion, not error toasts. Set only when a stream is live; cleared on `[DONE]`, after user-stop handling, and at every fresh stream start.
4. `handleStopProcessing`: **register intent → fire `/stop` → abort client stream → clear local state → await `/stop` result**. This ordering is load-bearing — the server must see the stop signal even when the browser teardown races.

**Refresh-safe Stop button (PR #222)** — `isProcessing` is React state, so a browser refresh during a long workflow used to drop the Stop button even though the workflow kept running server-side. A mount-time `useEffect` in `chat.tsx` now queries `GET /agents/:agentId/:roomId/active-workflow` and rehydrates `isProcessing` + shows a locale-aware "Workflow still running" toast when the server reports an active comprehensive analysis, task-chain approval, or CEX human-input approval. See the "Message Classifier + Refresh-safe Stop + CEX Plan-as-Text" section below for the full endpoint contract.

**Soft-toast classification (PR #130)** — HTTP/2 mid-stream reset (`net::ERR_HTTP2_PROTOCOL_ERROR`, `code: STREAM_ENDED`) is non-fatal: the server keeps running, refresh reveals the completed result. The chat error handler routes these to a **non-destructive** "Connection interrupted" toast (EN + zh-CN) instead of the red "Analysis Error" toast.

**SSE close ≠ cancel for paused approvals (PR #153)** — When a user closes the SSE stream while a task chain is paused at "Waiting for human approval", the planner used to throw `Task chain processing failed: SSE connection closed before approval decision` and persist a misleading "💥 Task Chain Error" memory. Now treated as a clean cancellation: INFO-level log, "🚪 Approval cancelled — client disconnected" processing step, **no error memory persisted**. Sentinel `TASK_CHAIN_APPROVAL_CANCELLED_BY_DISCONNECT` is exported from `taskChainHandler.ts` and re-exported via the `@elizaos/core` barrel so the `client-direct` SSE close handler stays in sync with the catch site.

**SSE keep-alive vs ALB idle** — Node `server.keepAliveTimeout` **must exceed** the ALB idle timeout, or ALB will reuse a socket Node has just closed → `ECONNRESET` → `HTTPCode_ELB_502_Count` spikes. Current values: ALB `idle_timeout=600 s`; `server.keepAliveTimeout=620000`; `server.headersTimeout=625000`. Both server values are overridable via `SERVER_KEEP_ALIVE_TIMEOUT_MS` / `SERVER_HEADERS_TIMEOUT_MS`. ALB script: `scripts/set-alb-idle-timeout.sh`. (PRs #131, #141.)

### Chart Serving Pipeline

Charts live in two places: ephemeral local cache (`agent/saved_data/Charts/`) and durable S3 (`s3://sentiedge2025/charts/{agentId}/`). The contract:

**Plugins must always return a proxy URL via `buildChartProxyUrl(...)`** (`packages/core/src/utils/chartProxy.ts`) → `/s3-files/charts/{agentId}/{filename}`. Bypassing to a local `/charts/` static path works locally but **404s after every ECS container restart** (cold container's local dir is empty). The sentiment plugin specifically reverted to `buildChartProxyUrl` after a regression in this exact shape (PR #138).

**`s3FilesHandler` is local-first, S3-fallback** (`packages/client-direct/src/index.ts`): auth runs first, then a key matching a chart file in `saved_data/Charts/` is streamed off disk; on miss the request falls through to S3. This heals 0-byte S3 objects left over from earlier watcher generations and gives same-container reads an effective latency cache. **On a cold container the local dir is empty and the lookup misses cleanly** — production behavior is unchanged.

**Per-agent chart index cache (PR #131)** — `FileStorageService.getChartIndex(agentId)` lists `charts/{agentId}/` once, builds a `Map<basename, proxyUrl>`, caches it for **5 minutes**. Concurrent cache misses share a single in-flight promise (no thundering herd against S3). Paginates with `ContinuationToken` for agents with >1000 keys. `findChartByFilename` reads from this index instead of issuing one `ListObjectsV2` per chart filename — a `/memories?limit=50` for a chat with several comprehensive analyses had been firing **hundreds of `ListObjectsV2` round-trips** and crossing the 60 s ALB idle → 504 Gateway Timeout. Staleness is safe: freshly-generated charts resolve via `fs.existsSync(absPath)` *before* the S3 fallback runs, and chart filenames are immutable post-creation.

**`/memories` prefetches the chart index** in parallel with the DB fetch so per-memory chart-path resolution always sees a hot cache.

**Chart aspect ratio (PR #142)** — Compact view (in-chat embed): `clamp(200px, 40vw, 520px)` for a ~0.4 height/width with a 200 px mobile floor for legend readability. Full view (standalone): `clamp(240px, 40vw, 480px)`. There was an **iframe `vh` feedback loop** that pinned charts to the clamp floor regardless of viewport — fixed by syncing `ChartEmbed` `LOADING_HEIGHT` placeholder and tightening `NativeReportChart` heights.

### CEX Plugin (Trading)

Coinbase + Binance endpoint integration with a human-in-the-loop approval flow.

**Files** — `packages/plugin-cex/`, `packages/core/src/handlers/cexWorkflowMessageHandler.ts`, `client/src/components/CEXApprovalDialog.tsx`, `client/src/components/SettingsDialog.tsx` (API key entry).

**Approval context TTL (PR #141)** — Pending order-review entries used to be deleted when the SSE stream closed; ALB's 180 s idle timeout fired before the user clicked Confirm → 404 *"Pending CEX workflow approval context not found"*. Entries now expire via a 15-minute `setTimeout` (independent of stream close). The timer is `unref()`-ed and cleared on resolve/reject. Transient SSE disconnects no longer cancel the in-progress review; users hitting Confirm > 15 min later get a graceful "approval expired" error (not a silent 404).

**Exchange auth encryption** — User exchange API keys are encrypted at rest with AES-256-GCM via `packages/core/src/security/tokensCrypto.ts`. The key comes from `EXCHANGE_TOKEN_ENCRYPTION_KEY` (**required**, base64-encoded 32-byte key). The `PUT /user/exchange-auths/:exchangeId` handler classifies failures with structured error codes so operators can distinguish config from infra (PR #122):
- `code: "encryption_unavailable"` — key missing or malformed (env config bug)
- `code: "persistence_failed"` — Mongo write failure (infra)
- `code: "internal_error"` — generic outer catch
All 500s now log `userId` + `exchangeId` alongside `errorName` / `errorMessage` / `stack` so CloudWatch grep/filter is useful.

**Allowlist** — `plugin-cex` must be allowlisted in the agent plugin filter (`agent/src/index.ts` via `pluginFilter.ts`) for trading actions to register (PR #123).

### Autotrading safety + features — Wave 1 + Wave 2 (2026-05-19)

Five launch-blocking safety defects (F1–F5) and six feature additions (F6–F11 + selected polish) shipped together. See `docs/AUTOTRADING_SAFETY.md` for the operator-facing contract and `CHANGELOG.md` for the per-feature diff.

**Wave 1 highlights**
- Paper / live response disclosure: every paper/shadow chat reply begins with `**[PAPER MODE — no real money]**` (locale-aware Chinese variant for zh-CN) — enforced by both the formatter prompt AND a deterministic post-check that prefixes the badge mechanically if the SLM forgets. `state.resolvedExecutionMode` is now first-class on `CEXWorkflowState`.
- User-feature poisoning fixed: prompt-injection-flagged messages excluded from aspect derivation; safety-bypass blocklist on derived aspects; trading-keyword batches tagged `consentRequired` and excluded from prompt injection until the user opts in via Settings → Inferred Traits.
- Paper-order persistence: new `paper_orders` / `paper_fills` MongoDB collections with TTL indexes (`PAPER_ORDER_TTL_SECONDS`, default 24h); singleton `PaperVenueExchangeService` per real venue; read actions (`get_orders` / `get_balance` / `get_fills`) now route to the paper ledger when `mode=paper`.
- `[Trading]` event schema completion: every event carrying a `CanonicalIntent` now emits the full CLAUDE.md invariant field set including `stake: live|paper|shadow` and `notional_usd`. **Breaking change for CloudWatch dashboards**: the historical `stake: read_only|write` wire field is renamed to `tool_capability`; the CLAUDE.md-spec `stake` slot is now reserved for execution mode.
- Reconciliation per-user creds: `ReconciliationFallback` switched from a static `credentials[]` array to a per-(userId, venue) `resolveCredentials` callback; auto-downgrade fires after `RECONCILIATION_UNRESOLVED_DOWNGRADE_AFTER` (default 60) consecutive misses, writing a 15-min `runtime_lock` on `user_trading_preferences` and emitting `stage="reconciliation_health"`.

**Wave 2 highlights**
- `runtime.ts` precheck has a third bypass (after anonymous + comprehensive) for short follow-ups inside an active CEX workflow, gated by `CEX_DETERMINISTIC_BYPASS=true`.
- Canonical-intent zod validators reject malformed combos (`stop_limit` without both prices, `GTD` without end_time, `post_only` outside limit, `margin_type` without `margin_action`).
- Mode-aware stream copy table (`cexStreamMessages.ts`) — paper-mode order-submit copy never says "exchange".
- Binance margin (CROSS + ISOLATED) shipped via `signedMarginOrderPost` + an ISOLATED account precheck. Paper/shadow margin orders route through the existing paper venue and preserve `margin_type` / `margin_action` / `leverage` on the order record.
- Coinbase parity audit: zero code gap — Coinbase already accepts the canonical `order_configuration` verbatim; F7 validators apply uniformly. Margin remains Binance-only.

**Deferred to a follow-up PR**: F7 LLM extractor (validators shipped; NL→canonical LLM stage deferred), F10 rich TradingOrderEditor compose modal (minimal Trade button scaffold shipped), M2/M4/M5 polish.

### Autotrading subsystem uplift (Phase 2-5 + integration, 2026-05-17)

The autotrading flow (post Phase 2-5 + integration uplift) adds a deterministic layer between the LLM and venue adapters, plus reconciliation, idempotency, risk gating, and an ADK sub-agent.

**Architecture**:

```
User message
  ↓
langGraphPrecheck (existing) — classifies CEX_WORKFLOW
  ↓
cexRequestPreprocess (Phase 1, deployed) — locale / stake hint / exchange resolver
  ↓
generateLLMResponse
  ├─ ADK sub-agent fast-path (NEW, this round) — read-only actions skip LLM
  │    └─ falls through to LLM for write or unclassified
  └─ Legacy generateText (existing) — write actions and clarifications
  ↓
parseResponse
  └─ Anaphoric order-ID resolver (NEW) — "cancel this order" → injects order_id from previous turn
  ↓
requestParameterReview (if write)
  ├─ Risk engine (Phase 1, deployed via cexSpecProvider.runRiskPrecheck)
  ├─ Idempotency — deterministic client_order_id (Phase 1, deployed)
  └─ Human approval modal (2 levels)
  ↓
executeAction
  ├─ Per-symbol trading lock (Phase 2)
  ├─ Venue adapter (Binance / Coinbase)
  └─ pending_orders_ledger.upsert (Phase 2)
  ↓
Reconciliation (Phase 2) — WS user-data + REST fallback poller
```

**Key files**:
- `packages/plugin-cex/src/intent/canonicalIntent.ts` — zod canonical intent schema
- `packages/plugin-cex/src/idempotency/intentHash.ts` — sha256 of hashable subset (locale excluded → "Buy 0.01 BTC" EN and "买 0.01 BTC" ZH produce same client_order_id)
- `packages/plugin-cex/src/risk/riskEngine.ts` — pure-function risk gates: maxOrderSize, dailyLossLimit, exposureCap, slippageCap, assetAllowlist, cooldown, killSwitch, marketDataFreshness, reconciliationHealth
- `packages/plugin-cex/src/reconciliation/` — pending_orders_ledger MongoDB ops, ReconciliationService (registered at agent startup), Binance + Coinbase user-data WS consumers (auto-reconnect, listenKey refresh at 25 min, 23h re-auth), REST fallback poller (30s tick, 60s stale threshold)
- `packages/plugin-cex/src/concurrency/tradingLock.ts` — per-symbol FIFO lock keyed `${userId}:${venue}:${symbol}`, 5-min stale TTL via `.unref()` timer
- `packages/plugin-cex/src/adk/tradingSubAgent.ts` — bounded toolset (7 tools), deterministic intent classifier + parameter extractor; macro-F1 ≥ 0.92 on the eval suite
- `packages/plugin-cex/src/orderContext/anaphoricResolver.ts` — multi-turn order-ID resolver
- `packages/plugin-cex/src/strategy/` — DSL + NL→DSL compiler + runtime + paperVenue + shadowDecisions
- `packages/plugin-cex/src/backtest/` — synthetic + CSV data sources, indicators, metrics, runner with in-sample/OOS split; **look-ahead bias structurally prevented** — only references `bars[0..i]`
- `packages/plugin-cex/src/memory/memoryRouter.ts` — preference + recent-trade injection into prompt context
- `packages/plugin-cex/src/ranking/hybridRetriever.ts` — BM25 + dense cosine + RRF + MMR + final rerank by trust × freshness × portfolio relevance

**`CEXSpecProvider` API** (`packages/core/src/core/types.ts`) — core never imports plugin-cex; the plugin registers structural functions on the provider:
- `runRiskPrecheck(input)` — risk engine entry; null = allow
- `deriveClientOrderId(input)` — deterministic client_order_id
- `emitTradingEvent(event)` — writes `[Trading] {…}` JSON log lines for CloudWatch metric filters; invariant field set `{request_id, intent_hash, userId, venue, symbol, side, notional_usd, locale, stake, decision, rules_fired, latency_ms}`
- `runTradingSubAgent(input)` — ADK fast-path; returns canonical_intent or clarification_question
- `resolveAnaphoricOrderId(input)` — order-ID resolver for "cancel this", "撤销那个订单"
- `routeMemory(input)` — locale-aware memory snippet builder

**ADK fast-path scope (defensive)** — Only read-only actions (`get_balance`, `get_orders`, `get_fills`) bypass the LLM via the ADK classifier. Write actions still route through `generateText` so the existing chat preamble + approval UX is unchanged.

**Cancel-order context loss fix** — When the user types "cancel this order" or "撤销那个" without an ID, `parseResponse` invokes `resolveAnaphoricOrderId`, which scans recent assistant memories for displayed order IDs (UUID or long numeric) and auto-fills `order_ids` when exactly one is visible.

**Inline order-table UX** (`client/src/components/MarkdownRenderer.tsx`):
- `BUY` / `SELL` cells render as green / red chips
- Status cells (`NEW`, `PARTIALLY_FILLED`, `FILLED`, `CANCELLED`, etc.) render as colored badges
- Order IDs (UUIDs or ≥16-char alphanumeric) render as `…last4` with click-to-copy (paper- IDs shown in full)
- Open-order rows (containing an order ID AND a status in the OPEN family) get an inline **Cancel** chip that dispatches `sentiedge:chat-send` with a pre-filled message — chat.tsx listens and submits without disturbing the user's typed-but-unsent input.

**MongoDB collections introduced**:
- `pending_orders_ledger` — keyed on `client_order_id` (unique), indexed on `(userId, venue, state)`
- `user_trading_preferences` — keyed on `userId` (Phase 1 schema; populated lazily)
- `risk_decisions` — append-only audit log of risk verdicts (Phase 1)
- `shadow_decisions` — Phase 4 shadow-mode hypothetical executions; currently in-memory writer in plugin-cex; persistent writer pending

**Service registration** — `ReconciliationService` extends core `Service`; `static get serviceType() { return ServiceType.TRADING_RECONCILIATION; }`. Registered in `agent/src/index.ts` after the DB adapter is set up and before `runtime.initialize()`. Starts with `credentials: []` (per-user creds aren't globally available at startup); WS streams remain dormant until a credentialed user submits.

**Coinbase WS re-auth tuning (operational follow-up)** — Binance has a strict 24-hour user-data WS disconnect rule, which is handled by a scheduled 23h re-auth + 25min `listenKey` `keepAlive`. Coinbase Advanced Trade WS does **not** publish a fixed disconnect interval. Current behavior: reconnect-on-error with exponential backoff (1s → 60s cap). Operational task pending: add a CloudWatch metric filter on `[Trading] {"stage":"reconciliation_event","source":"ws"}` log lines, alarm when the rate drops to zero for > 5 min while users have open Coinbase orders. Use that signal to tune an explicit reauth cadence (proposed: every 23h matching Binance, revisit if drops persist).

**Persistent trading-mode storage** — `set_trading_mode` writes to `user_trading_preferences.default_mode` in MongoDB AND mirrors to the runtime cache for fast read-back. The paper-venue dispatch path reads the cache first, MongoDB second. On container restart the cache is empty; the persistent doc is the source of truth.

**Paper venue dispatch** — When the user's `default_mode` (or per-message `mode`) is `paper`, write actions (`create_order`, `cancel_order`) are routed to `PaperVenueExchangeService` instead of the real venue. Mid-prices come from the venue's PUBLIC ticker endpoint (`api.binance.com/api/v3/ticker/price`, `api.exchange.coinbase.com/products/.../ticker`) — no user auth required. 5-second per-symbol price cache to avoid spam. Falls back to a static heuristic price (BTC=78k, ETH=3.5k, other=100) on network failure so the paper venue keeps working offline.

**Real OHLCV backtest data** — `packages/plugin-cex/src/backtest/realDataSource.ts` fetches historical bars from `api.binance.com/api/v3/klines` (preferred) or `api.exchange.coinbase.com/products/.../candles` (fallback for Coinbase strategies). Both are public, unauthenticated. `run_backtest` action prefers real OHLCV; falls back to synthetic bars (with a clear "Data: synthetic" footer in the report) when the public endpoint errors or returns < 50 bars. Binance interval map covers 1m–1M; Coinbase granularity map covers 60s–1d.

### Message Classifier + Refresh-safe Stop + CEX Plan-as-Text (PR #222, 2026-05-21)

Three coordinated changes shipped together. See [PR #222](https://github.com/senti-edge/senti-agent-0428/pull/222).

**Key files**
- `packages/core/src/templates/messageClassificationTemplate.ts` — classifier prompt
- `packages/core/src/handlers/langGraphPrecheck.ts` — pre-LLM short-circuit + LLM classify node
- `packages/core/src/ai/generation.ts` — added top-level `temperature` and `maxTokens` override params (used by the classifier; undefined preserves the old `modelConfig` resolution)
- `packages/core/src/utils/cexBypassPredicate.ts` — deterministic CEX-continuation bypass + intent-shift detector
- `packages/core/src/handlers/comprehensiveAnalysisWorkflowGraph.ts` — exports `isComprehensiveAnalysisInProgress(userId)`
- `packages/core/src/handlers/taskChainHandler.ts` — exports `getPendingApprovalForRoom(runtime, roomId)`
- `packages/core/src/handlers/cexWorkflowMessageHandler.ts` — new `detectPlanIntent` + `generatePlanAsText` nodes; `onToken` threaded into `CEXWorkflowState`
- `packages/core/src/templates/cexPlanAsTextTemplate.ts` — markdown plan template
- `packages/client-direct/src/api.ts` — `GET /agents/:agentId/:roomId/active-workflow`
- `client/src/lib/api.ts` — `apiClient.getActiveWorkflow`
- `client/src/components/chat.tsx` — mount-time rehydration `useEffect` for Stop button
- `scripts/eval-classifier.mjs` — live agent eval harness
- `scripts/eval-classifier-static.mjs` — deterministic-layer static check (no agent / no LLM)
- `tests/questions/classification_questions.json` — 134 fixtures (6 categories incl. a `classification_trading_context_shift` level-5 set for multi-turn behavior)
- `tests/questions/cex_plan_questions.json` — 10 plan-shape fixtures

**Classifier — REGULAR-bias + determinism**

- Prompt rewritten with a REGULAR-bias preamble: single-asset + single-domain queries across any timeframe (sentiment, TA, news, on-chain, price) stay REGULAR. TASK_CHAIN requires multi-asset OR multi-step + non-trading. COMPREHENSIVE requires the word `comprehensive` anywhere, OR `full` + `analysis` without a single-domain qualifier, OR an explicit report keyword (`full report` / `complete memo` / `due diligence` / `research note` / `risk committee` / `quarterly` / `institutional-grade` / `cross-market`) or the zh-CN equivalents (`综合` / `完整分析` / `机构级` / `季度策略简报`). The CEX rule explicitly captures multi-step crypto-trading plans (DCA, ladder, scale-in/out, screen-and-trade, rotation, take-profit ladder, position exit) — multi-asset doesn't downgrade them to TASK_CHAIN.
- **Topic Shift in Trading Context (CRITICAL)** rule added to the prompt: when prior turns show trading but the CURRENT message is clearly non-trading (analysis, sentiment, news, definitional, greeting), classify by current content alone. Pairs with the runtime bypass guards below.
- `generateText` gained `temperature?` and `maxTokens?` per-call overrides (`??` not `||` so a valid `0` isn't erased). The classifier pins `temperature=0, maxTokens=256` so the same prompt yields the same bucket.
- Recent-message context filtered to **last 3 user turns only** (agent turns dropped — they biased the LLM toward the previous classification).
- Fallback in both `classifyWithLLM` and `LangGraphPrecheckService.classifyMessage` switched to `REGULAR_MESSAGE` (was `TASK_CHAIN_MESSAGE` — the heavier path).
- **Pre-LLM short-circuit** (`analyzeMessage` node) deterministically routes trivial-shape messages to REGULAR without an LLM call. After the static-eval round the patterns are: `price_or_direction_lookup` (EN + zh-CN), `definitional` (`define / explain / what is / who founded`), and `trivial_greeting_or_affirmation` (`hi / hello / thanks / yes / no / ok / sure / hola / gm / 嗨 / 你好 / 谢谢`). The bare `length ≤ 15` rule was removed because CJK queries pack semantics into very few characters (`BTC综合分析` is 7 chars). `now` was removed from the price-lookup terminal alternation — it was matching "What are my spot balances and open orders right now?".
- See the prompt itself for the full REGULAR / TASK_CHAIN / COMPREHENSIVE / CEX rule lists; that file is the source of truth for routing semantics.

**CEX deterministic bypass — extended decline guards**

`packages/core/src/utils/cexBypassPredicate.ts`. The bypass at [runtime.ts:2363](packages/core/src/core/runtime.ts#L2363) (gated by `CEX_DETERMINISTIC_BYPASS=true`) routes short follow-up messages straight to the CEX handler when a recent CEX clarification memo exists in the room. `detectIntentShift` now declines for:

- `fresh_trading_verb` — `buy / sell / place / cancel / amend / close / liquidate / swap / trade` (EN + 买 / 卖 / 下单 / 撤销 / 取消).
- `topic_shift_question` — `what / how / why / show me / explain / price / 什么 / 怎么 / 价格`.
- `non_cex_intent` — `analyze / analysis / comprehensive / research / sentiment / news / technical / fear / greed / on-chain / prediction / backtest / report / summary / signal / trend / outlook / fundamentals / chart / indicator / volatility / funding / momentum / memo / brief / update / define / definition / screen / compare / rank / track / evaluate / assess / watchlist / headline / rsi / macd / moving_average / bollinger / ema / sma / divergence / portfolio / risk_review / stress_tests / holdings / due_diligence / cross-market / quarterly / institutional-grade` plus the zh-CN set (`分析 / 研究 / 新闻 / 情绪 / 预测 / 信号 / 趋势 / 图表 / 指标 / 基本面 / 链上 / 波动 / 资金费率 / 综合 / 对比 / 比较 / 排名 / 追踪 / 评估 / 筛选 / 观察 / 策略简报 / 机构级 / 季度 / 备忘录 / 跨市场 / 压力测试 / 完整分析`).
- `non_crypto_instrument` — `tesla / tsla / apple / aapl / msft / nvda / spy / s&p / nasdaq / forex / fx / EUR/USD / gold / silver / oil / etf / robinhood / stocks / equities`. Catches "Plan how to scale into Tesla shares" — non-crypto trading plans route through REGULAR via the LLM's non-crypto guard.
- `non_trading_chitchat` — greetings and thank-yous (`hi / hello / hey / good morning / gm / gn / hola / 嗨 / 你好 / 您好 / 早上好`; `thanks / thank you / thx / ty / cheers / 多谢 / 谢谢 / 感谢`). EN and CJK use SEPARATE regexes because `\b` doesn't apply at CJK ↔ EOF boundaries — the same trap that hit `FRESH_TRADING_VERB_CJK_RE` earlier.

Ordering matters: `FRESH_TRADING_VERB_*` runs BEFORE the greeting / non-crypto / non-CEX branches, so `"hey can you cancel my order"` still classifies as `fresh_trading_verb`.

`detectIntentShift`, `isShortFollowUpText`, `shouldBypassToCexWorkflow`, `classifyCexIntentClassFromText`, `intentClassForAction`, `isCexContinuationMemory` are all exported from the `@elizaos/core` barrel so external tooling (e.g. `scripts/eval-classifier-static.mjs`) can validate behavior without booting the agent.

**Refresh-safe Stop button**

Server: `isComprehensiveAnalysisInProgress(userId)` reads the workflow-graph's `inFlightSlots` + `userInFlight` maps directly (matches the same userId scope the slot was acquired with). `getPendingApprovalForRoom(runtime, roomId)` walks both `__pendingApprovals` (task-chain) and `__pendingHumanInputApprovals` (CEX human-input) and returns `{ kind, threadId, startedAt }`. New route `GET /agents/:agentId/:roomId/active-workflow` is `authMiddleware`-gated (matches the memories route) and uses the same participant-aware userId resolution as `/memories` so the comprehensive lookup keys to the right slot for authenticated users.

Client: `apiClient.getActiveWorkflow(agentId, roomId)` + a mount-time `useEffect` in [chat.tsx](client/src/components/chat.tsx) that runs after the room-reset block. On `result.active=true` it sets `isProcessing` and shows a locale-aware "Workflow still running" toast. The `/stop` click path is unchanged — `/stop` is agent-wide, so clicking Stop terminates the active job regardless of which client originally launched it. Live SSE token replay is intentionally not attempted; the final result still lands via the `persisted-only` delivery path from PR #153.

**CEX plan-as-text (D path)**

Two new LangGraph nodes in `cexWorkflowMessageHandler.ts`:

1. `detectPlanIntent` — regex prefilter (DCA / dollar-cost-average / scale-in / scale-out / ladder / sequence / weekly / `over the next` / spread out / `screen .* (top|best|strongest) .* (buy|sell|place)` / `rotate .* (into|to|from) .* over` / take-profit ladder / position exit + zh-CN `定投 / 分批 / 轮换`), then a `temperature=0` SLM JSON confirm (`{"multiStep": true|false}`). Fail-open on any error — single-order pipeline runs as before.
2. `generatePlanAsText` — `ModelClass.MEDIUM`, `temperature=0.1`, `maxTokens=1024`, streams plan markdown via `onToken`. Persists the response memory with `metadata.cexPlan = { kind: "plan_as_text", steps: <number>, mode: <paper|live|shadow> }`. Routes directly to `showResultModal` (skips `createFinalResponse` which would build its own memory). No execution — users opt in step-by-step via follow-up replies; grouped approval is deferred.

**CEX main-loop model upgrade (response-summaries PR, 2026-05-21)**

The CEX main-loop `generateLLMResponse` LLM call is now `ModelClass.MEDIUM` (was `SMALL`) with `bypassModelClassDowngrades: true`. Action selection + parameter extraction + clarification all run on the bigger model, matching the plan-as-text node which already used MEDIUM. The bypass is safe because the CEX workflow is paid-tier-gated upstream: it only runs for users with exchange API keys saved + trading enabled, and anonymous users are force-routed to REGULAR by [`runtime.ts:2271`](packages/core/src/core/runtime.ts#L2271). The plan-as-text node also gains `bypassModelClassDowngrades: true` for consistency — previously the free-tier resolveModelClass downgrade was silently demoting it to SMALL. Result formatter (~line 3469) and `detectPlanIntent` SLM (~line 3748) stay on SMALL.

**Response-summary mechanism (same PR)**

Every agent-response Memory now carries an extracted `## Key Findings` block on `content.metadata.summary` (or its equivalent for the comprehensive route, which keeps `metadata.executiveSummary` as the alias). On follow-up turns the per-route `recentMessages` builders substitute that 200-token summary in place of the full body for agent turns — user turns are unchanged. The extractor lives in `packages/core/src/utils/executiveSummaryFromMarkdown.ts` (synonyms: Key Findings / Summary / TL;DR / Executive Summary + 关键发现 / 总结 / 摘要 / 执行摘要); the per-route decorator is `attachResponseSummary` in `packages/core/src/utils/persistResponseSummary.ts`, which also emits `[ResponseSummary] route=<regular|task_chain|comprehensive|cex|cex_plan> bytes_full=N bytes_summary=M ratio=...` for CloudWatch tracking. Alarm if any route's ratio drops to 0 — that means the model stopped emitting the section.

**Pre-LLM short-circuit — positive CEX routing + `excludeIf` decline-list (PR after #224, 2026-05-21)**

Production bug repro: `"what is the my account balance"` (note the typo "the my") routed to REGULAR and the regular handler declined with "I don't have access to your accounts". Root cause: the `definitional` rule's negative lookahead used `\s+` (immediately after "what is") instead of `.*\b` like its sibling `price_or_direction_lookup`, so the extra "the" defeated the personal-account exclusion.

Fix has three parts:
1. **Positive CEX routing** — `cex_account_intent` is now the FIRST short-circuit pattern and emits `CEX_WORKFLOW_MESSAGE` directly for any message with personal-account intent: `(the\s+)?(my|our|your) <account|balance|wallet|holdings?|portfolio|orders?|fills?|positions?|trades?|history|funds?>`, `do/does <i|we|you> have`, `mine in/on`, bare `open orders` / `pending fills`, `check|show|get|... <noun>`, plus the zh-CN forms `我的(账户|余额|订单|...)` and bare `挂单|未成交|开仓`. Anonymous users are still force-rerouted to REGULAR by [`runtime.ts:2271`](packages/core/src/core/runtime.ts#L2271), so the positive rule has no anonymous-user blast radius.
2. **`excludeIf` decline-list** — each `SHORT_CIRCUIT_PATTERNS` entry can carry an `excludeIf?: RegExp[]`. The `cex_account_intent` pattern declines via `ANALYSIS_INTENT_RE` (review / report / summary / risk review / stress tests / due diligence) and `NON_CRYPTO_INSTRUMENT_GUARD_RE` (Apple / TSLA / S&P / forex / gold etc.), so "Write a portfolio risk review for my crypto holdings" lands in COMPREHENSIVE via the LLM classifier, and "Sell my Apple stock position" lands in REGULAR.
3. **Definitional rule** — negative lookahead now uses `.*\b` parity with `price_or_direction_lookup` (plus the `do/does + i/we/you + have` and `mine in/on` variants). Defense-in-depth: even if `cex_account_intent` is ever disabled, the definitional rule will no longer swallow `"what is the my X"` typo forms.

`SHORT_CIRCUIT_PATTERNS` and `evaluateShortCircuit` are now exported from the `@elizaos/core` barrel, replacing the previously-mirrored copy in `scripts/eval-classifier-static.mjs` (the mirror had drifted from source). Static-eval baseline against the 137-question fixture: **0 short-circuit false positives, 20/20 hits match expected classification**.

**Classifier resilience — Gemini thinking-budget + retry + cex_trade_intent + raw-response logging (PR #226, 2026-05-21)**

Follow-up incident: `"help me place a 10 usdt buy order for btc/usdt with 62000 and 10 usdt buy order for eth/usdt with 2100"` misrouted to REGULAR_MESSAGE. Root cause was NOT the routing rules — it was the LLM classifier itself returning non-JSON. CloudWatch evidence: classifier latency 3464 ms (vs. typical 200–800 ms for SMALL); parser threw "No JSON format response found"; the catch-block fallback hard-coded REGULAR_MESSAGE.

The mechanism: staging's SMALL model is `gemini-2.5-flash`, a *thinking* model. Internal reasoning tokens count against `maxTokens`. With the 134-line classifier prompt + recent conversation + non-CEX action list, the thinking phase consumed the entire 256-token budget and the visible response was empty.

Four-part fix in this PR:
1. **(A) Disable thinking on the classifier** — `generateText()` gains a `thinkingBudget?: number` parameter that maps to `providerOptions.google.thinkingConfig.thinkingBudget` on the Vertex provider. The classifier passes `thinkingBudget: 0`. Latency drops by ~2–3 s; cost neutral; no behavior change for any other caller (parameter is `undefined` everywhere else).
2. **(C) Retry on parse failure with larger budget** — `classifyWithLLM` now retries ONCE with `maxTokens: 1024` (still `thinkingBudget: 0`) when the first call's response fails `parseClassificationResponse`. The retry path doesn't fire on healthy responses so cost stays flat; on the failure path it adds at most one extra LLM call before the REGULAR fallback. Second parse failure still falls back.
3. **(E) `cex_trade_intent` positive short-circuit** — new SHORT_CIRCUIT_PATTERNS entry (between `cex_account_intent` and `price_or_direction_lookup`) that emits `CEX_WORKFLOW_MESSAGE` for imperative fresh-trading-verb messages: `^(help me|please|can you|i want to|let me|i'd like to)? <verb> ...` where verb ∈ {`buy, sell, place, cancel, amend, modify, liquidate`} plus zh-CN {`买, 卖, 下单, 撤销, 取消, 平仓, 开仓, 对冲`}. The verbs `trade` / `swap` / `exit` were intentionally excluded — Q385 ("Help me trade smarter") and similar over-fired. Same `excludeIf` guards as `cex_account_intent` (analysis verbs, non-crypto instruments).
4. **(F) Raw-response debug logging** — `classifyWithLLM` now logs `[LangGraphPrecheck] classifier raw response (len=N): <first 600 chars>` at debug level both on the initial call and on the retry. Production already runs `DEFAULT_LOG_LEVEL=debug` so future "why did this misroute?" investigations can read the actual model output instead of hypothesizing.

Static-eval baseline against 137-question fixture after this PR: **0 false positives, 27/27 hits match expected** (was 20/20 with PR #225). The classifier-LLM call rate drops too because more fresh-trading-verb messages short-circuit before reaching it.

### CEX Plan Executor — multi-step orchestrator (PR #227, 2026-05-21)

Bug repro: `"help me place a 10 usdt buy order for btc/usdt with 62000 and 10 usdt buy order for eth/usdt with 2100"` → agent asked for clarification, did the conversion math, then on the user's "yes, please" confirmation ran `get_balance` AGAIN instead of placing the two orders. Root cause: the CEX workflow had NO multi-action execution path. Single-action LLM output + free-form prose "would you like me to place these?" + no state machine to confirm against. The legacy `detectPlanIntent` regex only matched DCA/ladder/scale templated language, not arbitrary "do X and Y" requests.

**Solution architecture: a decomposer + plan executor wedged in front of the legacy workflow, gated by the `CEX_PLAN_EXECUTION_ENABLED=true` setting.**

```
handleCEXWorkflowMessage
    │
    ▼
runPlanModeIfApplicable  ◄── feature-flagged; null = let legacy run
    │
    ├─ has active plan in (user,room)? ──── continuation path
    │       │
    │       └─ parseContinuation(text)
    │              ├─ APPROVE_NEXT  → execute next pending write
    │              ├─ APPROVE_BATCH → flip to batch mode, drain writes
    │              ├─ CANCEL_PLAN   → cancelled + plan-card memory
    │              ├─ SKIP_STEP     → skip cursor, decide next
    │              └─ UNKNOWN       → cancel plan + null (topic shift)
    │
    └─ no active plan ──── fresh decomposition
            │
            └─ decomposeMessage (LLM call, thinkingBudget=0)
                   │
                   ├─ schema parse fail / cyclic deps → null (legacy)
                   ├─ clarify-only step → clarification memory + done
                   ├─ 1-step plan → null (legacy handles single orders)
                   └─ multi-step plan:
                         ├─ savePlan (in-memory store with 15-min TTL)
                         ├─ executeReadyReads (Promise.all reads w/ no deps)
                         ├─ nextWriteStep ready? → plan card + step-by-step prompt
                         └─ else (reads-only) → final plan card
```

**Key modules** (all in `packages/core/src/handlers/` unless noted):

- `cexPlanSchema.ts` — `CexPlan` + `CexPlanStep` runtime types + zod schemas for decomposer LLM output (`CexPlanDecomposedSchema`). Defines the read-only action set (`READ_ONLY_ACTIONS`) and the reserved `clarify` action.
- `cexPlanState.ts` — in-memory plan store with 15-min TTL (`PLAN_TTL_MS`). One active plan per `(user_id, room_id)` — `savePlan` cancels the prior active plan and returns it. `getActivePlan` lazily expires plans past their TTL. `updatePlan(planId, mutator)` for atomic-ish edits; clears the sweep timer on terminal transitions.
- `cexPlanExecutor.ts` — pure-function helpers: `readableSteps` (leading reads with deps fulfilled), `nextWriteStep` (next pending write), `markStepOk` / `markStepFailedAndBail` (status transitions), `advanceCursor` (move past terminal steps), `decideStatus` (state-machine resolver), `detectCycle` (DFS), `renderPlanCard` (markdown table).
- `cexContinuationParser.ts` — deterministic mapper from user replies to plan commands. **Bare "yes" never batch-approves** — the user must explicitly include `all` / `batch` / `全部` to opt into batch mode. Cancel patterns checked first so "no, never mind" can't be misread as a partial approval.
- `templates/cexDecomposeTemplate.ts` — system prompt for the decomposer. Strict JSON contract, max 12 steps, falls back to a single `clarify` action when the request can't be mapped.
- `cexPlanRunner.ts` — the orchestrator. Called from `handleCEXWorkflowMessage` BEFORE the legacy `CEXWorkflowService` runs. Returns `null` to fall through to legacy.

**Approval contract:**
- **`step_by_step` (DEFAULT, safer)** — exactly one write per user turn. After each write, plan transitions to `awaiting_approval` and the runner returns. User must reply `yes` / `approve` / `confirm` / `继续` to proceed.
- **`batch`** — explicit opt-in via `yes, all` / `approve all` / `batch` / `全部确认`. Remaining writes execute back-to-back without further prompts.

**Failure mode: BAIL.** First step failure → `markStepFailedAndBail` flips that step to `failed`, marks every subsequent step `skipped`, and transitions plan to `failed`. The plan card carries the error in the Notes column. Reads also bail on first failure (consistent with writes); the parallel-read batch waits for all to settle but any single failure transitions the plan to `failed`.

**What this PR does NOT do (deliberately):**
- The frontend `CEXApprovalDialog` modal is untouched. Plan-mode confirmations are chat-based ("Reply `yes` to approve the next step"). Mixing a modal with chat prompts felt error-prone for v1.
- Single-step plans intentionally fall through to the legacy single-action workflow — the legacy modal/risk/idempotency layers are well-tuned for one-shot orders and we don't want to regress them.
- The plan store is in-memory (not Mongo). Container restart loses active plans; user re-sends. Trade-off favors simplicity; the TTL is already short.

**Feature flag rollout:**
- `CEX_PLAN_EXECUTION_ENABLED` setting; **default off** for safety. The legacy workflow runs unchanged when off.
- Phase 1 (this PR): backend orchestrator + chat-based step-by-step approval, behind the flag.
- Phase 2 (planned): UI changes — multi-order modal, in-chat plan card with live status updates. Out of scope here.

**Testing:** 121 new unit tests in `cexPlanSchema.test.ts` / `cexPlanState.test.ts` / `cexPlanExecutor.test.ts` / `cexContinuationParser.test.ts`. Regression suite for the broader CEX classifier + envelope + stake + summary still passes (331 tests across 17 suites).

`handleCEXWorkflowMessage` now accepts `onToken`; both runtime dispatch sites in `runtime.ts` (anonymous fast-path bypass and the LLM-classified route) forward it.

**Eval harness (live + static)**

Two scripts:

- `scripts/eval-classifier.mjs` (live, `pnpm eval:classifier`) — sends each fixture to a running agent, reads `response.metadata.classification` from the SSE `intermediate_response` / `action_response` events (the older `text`-JSON path is kept as a fallback). Optional `--stop-after-classification` hits `/stop` once the classification is captured so a long run doesn't burn $10–30 in downstream handler cost. Only safe with `--concurrency 1` (since `/stop` is agent-wide). **Requires a JWT** — anonymous users get force-routed to REGULAR by [runtime.ts:2271](packages/core/src/core/runtime.ts#L2271).
- `scripts/eval-classifier-static.mjs` (deterministic-only) — exercises the regex short-circuit + bypass intent-shift detector against the full fixture in <1 s with no agent. Reports short-circuit hits, false positives, bypass declines, bypass traps for non-CEX expected, per-category breakdown, JSON sidecar (`tests/questions/classification_eval_static_results.json`). Exit code non-zero on any short-circuit false positive or bypass trap.

Static-check baseline against the 134-question fixture (final state on this PR):

| Metric | Value |
|---|---|
| Short-circuit hits | 8/134 (all 8 match expected REGULAR) |
| Short-circuit false positives | 0 |
| CEX bypass intent-shift declines | 120/134 |
| Bypass would fire (short + no shift) | 14 |
| Bypass traps on non-CEX expected | 1 (Q210 "I need help planning my workout routine" — generic off-topic; acceptable risk) |
| Questions needing LLM verification | 126/134 |

The remaining 126 LLM classifications need a deployed-agent run (staging) with a real JWT to verify the prompt rules end-to-end. The deterministic layer is regression-safe and runs locally.

### CEX Comprehensive Workflow Fix (PR #236, 2026-05-22)

15 fixes across 6 themes, all on the CEX surface (`packages/plugin-cex/` + `packages/core/src/handlers/cexWorkflowMessageHandler.ts` + `cexPlanRunner.ts` + a thin `client/` enrichment). Each fix shipped as an independent commit + tests; the PR is feature-flag-gated for the load-bearing safety changes.

**Theme 1 — Read-action correctness**

- **Multi-wallet `getBalance` (Fix 1):** `BinanceAccountsService.getBalance` now fans out spot + funding + cross-margin + isolated-margin via `Promise.allSettled`. Margin-permission denial does NOT block spot return; skipped wallets are logged as `[plugin-cex Binance] getBalance scope=... wallets_skipped=<scope>:<REASON>` with per-scope classification (`PERMISSION_DENIED|SERVER_ERROR|TIMEOUT|NETWORK_ERROR`). Every row carries BOTH legacy fields (`id / currency / available_balance.value / hold.value`) AND uniform fields (`asset / free / locked / borrowed? / interest? / net? / total / symbol_pair?`) so `fetchAccountSnapshot` in `plugin-cex/src/index.ts` continues working unchanged. Margin SAPI helpers (`signedMarginGet`, `signedIsolatedMarginGet`, `signedMarginAllOrders`) delegate to a shared private `signedSapiGet` in `binanceMargin.ts` that sanitizes 4xx/5xx bodies via `formatAxiosErrorLine`, caps the projection at ≤200 chars, and crucially excludes the request URL (which carries `signature=`) from the thrown message.
- **Binance pricing helper (Fix 2):** `packages/plugin-cex/src/exchanges/services/binancePricing.ts` exposes `fetchBinanceUsdtPrices(symbols)` via a single batched `GET /api/v3/ticker/price?symbols=[...]` (public, no signing). 5-second per-process cache keyed on sorted+uppercased+deduped symbol list, single-flight `Map<key, Promise>` de-dup (mirrors `FileStorageService.getChartIndex` from PR #131 to prevent thundering-herd). The same module later gained `fetchBookTicker / fetchDepth / fetch24hStats` (Fix 14a) with separate per-endpoint cache keys (`book:{SYM} / depth:{SYM}:{N} / 24h:{SYM}`).
- **Order/trade history fan-out (Fix 4 + 4b):** When `symbol` is missing AND a date window is set, `getOrders` enumerates the user's currently-held assets (top-8 by USD via `fetchBinanceUsdtPrices` + Set-dedup across wallets), fans out `Promise.allSettled` across `[<asset>USDT]` pairs, coalesces + sorts `time` desc + slices to `limit ?? 50`, and emits `{ orders, scanned_symbols, note: "scanned N symbols based on current holdings" }`. Margin mirror via `signedMarginAllOrders`. `getFills` does the same when `product_ids` is missing. The Coinbase-style `productids is required` error gets rewritten at the `createTradeAction` catch path via `rewriteSymbolRequiredErrorMessage` (anchored `\b` regex, decline list for `uppercase / format / unique / pattern` constraint phrasings).

**Theme 2 — Plan executor + plan-time validators**

- **Plan inlining (Fix 3):** `renderPlanCard(plan, { include_results })` in `cexPlanExecutor.ts` defaults `include_results=true` on terminal states (`completed`/`failed`), `false` on `in_progress`/`awaiting_approval`. Each `ok` step appends a `<details>` block AFTER the status table (NOT interleaved — many markdown renderers reject inline HTML inside tables) carrying `payload.text` OR a deterministic fallback for `accounts | orders | fills | positions`. Truncation cap = 80 lines per block; the truncator reserves the last 3 lines for the marker + closing `</details>` tag so the block always closes cleanly. `formatPlanResultViaLLM` in `cexPlanRunner.ts` is the rare LLM fallback (`temperature=0`, `maxTokens=768`, `thinkingBudget=0`, payload capped at 4 KB) — common path has zero extra LLM calls.
- **Plan-time validators (Fix 7, gated by `CEX_PLAN_TIME_VALIDATORS_ENABLED`):** `packages/core/src/handlers/cexPlanTimeValidators.ts` runs (schema, risk engine, symbol-status, min-notional) per write step BEFORE `savePlan`. `planStepToCanonicalIntent` projects to the same canonical-intent shape `requestParameterReview` uses at execute time, so the same `runRiskPrecheck` produces the same `block` messages. Schema failure or risk-engine `block` → plan card returned with `step.result.error` set, `plan.status = "failed"`, `savePlan` SKIPPED (no idempotency-token burn, no continuation memo). Symbol-status uses `fetchBinanceSymbolFilters(symbol)` in `binanceSymbolInfo.ts` — public `exchangeInfo` endpoint, 1-hour module-level cache + per-invocation Map cache + single-flight. Coinbase: `validateCanonicalIntent` is venue-agnostic (schema + risk still run); only `fetchSymbolFiltersFromCore` returns null for non-Binance (status + min-notional gates skip).

**Theme 3 — Action coverage**

- **`get_trading_mode` (Fix 6):** New read action in `packages/plugin-cex/src/actions/getTradingMode.ts`. Resolution path: runtime cache (`user_trading_preferences:{userId}` + per-field cache key matching `setTradingMode`) → MongoDB via `databaseAdapter.getUserTradingPreferences` → `DEFAULT_USER_TRADING_PREFERENCES.default_mode = "live"`. `langGraphPrecheck.SHORT_CIRCUIT_PATTERNS.cex_account_intent` extended with mode-question patterns (EN + zh-CN `什么模式|当前模式|交易模式`). Bonus: while there, `set_trading_mode` was finally added to `WRITE_ACTIONS` in `cexWorkflowStakeClassifier.ts` (had been falling through the default-write branch by accident).
- **Asset allowlist/blocklist (Fix 8):** Five actions in `packages/plugin-cex/src/actions/assetLists.ts`: `add_blocked_asset / remove_blocked_asset / add_allowed_asset / remove_allowed_asset` (writes, gated by `requestParameterReview` approval) + `list_asset_lists` (read). `normalizeAsset` enforces `/^[A-Z0-9]{1,12}$/` (length cap accommodates `1000PEPE`-style tickers) and rejects empty/whitespace/emoji. Idempotency derived via `CEXSpecProvider.deriveIdempotency` but mutation is also Set-dedup-gated, so `add_blocked_asset({DOGE})` twice doesn't grow the list. New `cex_asset_list_intent` short-circuit pattern routes `block <asset>` / `add ... to (block|allow)list` (plus zh-CN) deterministically.
- **Positions + PnL (Fix 13):** `get_positions` and `get_pnl` actions; new `binanceFutures.ts` with `signedFapiGet` (targets `fapi.binance.com`, mirrors the margin SAPI helper's sanitization) + `getPositionRisk / getFuturesAccount / getIncomeHistory`. `BinanceAccountsService` gained `getMarginAccount / getIsolatedMarginAccounts / getPositionRisk / getFuturesAccount / getIncomeHistory` so cross-cutting actions can call them without re-instantiating services. `get_positions` Promise.allSettled across futures/cross/isolated, skips `|size| < 1e-9`, derives `LONG/SHORT` from sign of `positionAmt`/`netAsset`, tolerates permission-denied venues silently. Cross-margin per-row `unrealized_pnl` is null (Binance cross account exposes margin ratio but no per-asset entry price); isolated rows have it via the isolated-margin response. `get_pnl` realized = futures `/fapi/v1/income` chunked to ≤6-day windows (the endpoint's 7-day cap); unrealized = `positionRisk` + isolated margin. New `cex_account_intent` matches `positions / pnl / unrealized / liquidation / leverage` (EN + zh-CN `仓位|持仓|盈亏|未实现盈亏|强平价|杠杆`).

**Theme 4 — Safety / validation hardening**

- **Non-positive quantity rejection (Fix 5, H-6 execute-time, defense-in-depth):** Schema (`positiveDecimalString` refinement on `base_size / quote_size / iceberg_qty / limit_price / stop_price / stop_trigger_price`); risk-rule (`packages/plugin-cex/src/risk/rules/minOrderSize.ts`, registered BEFORE `maxOrderSize` so the missing-size message lands cleanly before maxOrderSize's "estimated notional unavailable" skip path); LLM prompt rule #8 in `cexMessageTemplate.ts` ("do NOT strip the sign / normalize to zero / default to `\"1\"`"); quantizer throws (`binanceQuantization.ts` + `coinbaseQuantization.ts`) when `valInt <= 0n` so a non-positive value reaching the quantizer is loud, not silent.
- **Intent cross-check (Fix 10, gated by `CEX_INTENT_CROSSCHECK_ENABLED`):** `packages/plugin-cex/src/intent/promptNumericExtractor.ts` regex-extracts `{value, unit: "base"|"quote"|"unknown", asset?}` tuples from the user's prompt (EN base/quote, zh-CN base aliases, `美元/刀`, `$3000` USD prefix, thousands separators, bare numbers). `crossCheckUserIntent` compares the user's biggest detected value to LLM-extracted `base_size`/`quote_size` (after unit normalization via ticker price); divergence > 5% surfaces a clarification BEFORE the approval modal renders, with a `clarification_request` trading event and a locale-aware (EN + zh-CN) chat reply. `MAX_VALUE_DIVERGENCE_PCT = 0.05`. Fix 14c extends the file with `extractAssetMentions` for the modal's symbol-verification block.
- **Quote-freshness re-check (Fix 11, gated by `CEX_CONFIRM_QUOTE_RECHECK_ENABLED`):** Top of `executeAction` (the actual final-execution node, NOT `executeFinalApprovedAction` as the original plan named it) re-fetches the latest ticker via `fetchBinanceUsdtPrices([symbol], { bypassCache: true })` — Fix 2's helper gained a `bypassCache` flag for this. `approvedMarketMid` + `approvedAtMs` are persisted onto `CEXWorkflowState` at parameter-review time. Cap = `min(intent.execution_constraints.price_deviation_max_pct, preferences.price_deviation_max_pct)` with `FIX11_DEFAULT_CAP_BPS = 100` (0.01 fraction) when both absent. Drift > cap → abort with "Market moved X bps in the Y seconds since you reviewed this order. Re-submit if you still want to proceed." (locale-aware). Within cap → re-run ONLY the `priceDeviation + slippageCap` rules via a new `rules_to_run?: string[]` filter on `runRiskPrecheck` + a `RULES_BY_ID` lookup in `riskEngine.ts`. Fetch failure → fail-soft (log, proceed with original mid); the drift gate is the load-bearing safety net.
- **Kill-switch revocation (Fix 12):** `humanInputState.revokePendingApprovalsForUser(runtime, userId, reason)` walks `__pendingHumanInputApprovals`, resolves each owned entry with `rejected` outcome + reason, clears the TTL `setTimeout`, deletes the entry, returns the count. `PUT /user/trading/kill-switch` now calls revoke after persisting the preference, includes `revoked_count` in the response, emits a structured `[Trading] {"stage":"kill_switch","userId":"...","revoked_approvals":N}` log line, and pushes a `kill_switch_revoked` SSE event to the user's live tabs. The `__activeStreams` registry value type was upgraded from `Set<connectionId>` to `Map<connectionId, {userId, send}>` to support per-user filtered emission; `emitEventToUser(runtime, userId, payload)` is the new core helper. `isStreamAliveForRoom` still uses `size > 0` so PR #153's liveness contract is unchanged.

**Theme 5 — Honest UX**

- **Anonymous CEX route (Fix 9):** At the top of `routeMessage` in `runtime.ts`, when the message is anonymous AND `evaluateShortCircuit(rawText)` returns `CEX_WORKFLOW_MESSAGE` (matches `cex_account_intent` or `cex_trade_intent`), a synthetic Memory with `getCEXAuthRequiredErrorTemplate(locale)` is persisted instead of force-rerouting to `handleRegularMessage`. The template now takes an optional `locale` param — EN unchanged, new zh-CN variant (`要执行交易…请登录后再试`), `mixed-en`/unknown falls back to EN. Non-CEX anonymous queries keep current REGULAR path.

**Theme 6 — Live market data + order-editor enrichment**

- **Modal enrichment (Fix 14, gated by `CEX_APPROVAL_MODAL_ENRICHMENT_ENABLED`):** `packages/core/src/handlers/cexMarketSnapshot.ts` (NEW) calls `fetchBookTicker + fetchDepth(5) + fetch24hStats` via `Promise.allSettled` with a 600ms latency budget enforced by `withTimeout`. Never throws — failure → modal payload omits `market_snapshot`. Computes `est_fill_price = side === "BUY" ? ask : bid` and `slippage_vs_limit_bps`. `symbol_verification` checks the LLM-extracted symbol against `extractAssetMentions(message.text)`; mismatch → `matches: false` and the React `MarketSnapshotPanel` HARD-DISABLES the Confirm button with a red banner. Soft warning for pair-quote mismatch (user typed `BTC-USDC`, extractor sent `BTCUSDT`) — Confirm stays enabled but with an amber banner. Single log line per modal open: `[Trading] {"stage":"approval_modal_enriched","symbol":"BTCUSDT","spread_bps":12,"est_fill_price":76955,"verification_matches":true}`.
- **Instant ticker + orderbook (Fix 15):** Two new read actions in `packages/plugin-cex/src/actions/{getTicker.ts, getOrderbook.ts}`. `get_ticker` default `product_ids` = user's holdings (via `getCandidateHoldingsSymbols`), falls back to `["BTCUSDT","ETHUSDT","SOLUSDT"]`. `get_orderbook` requires a single `product_id`; `depth` clamped to `[1, 100]`. Both actions ALSO run the symbol-correctness guard from Fix 14c BEFORE the network call — if the LLM-extracted symbol's base asset isn't in the user's prompt, the action refuses with "You asked about X but I extracted Y. Did you mean XUSDT?" Override is a deterministic regex match on `yes, {extracted_symbol}`. New `cex_market_data_intent` SHORT_CIRCUIT_PATTERN routes `price of / current price / how much is / order book / bid ask / spread / depth / 24h volume` (EN + zh-CN `现价|当前价格|多少钱|订单簿|买一卖一|深度|24小时成交量`) deterministically to CEX. The classifier prompt was also clarified: live-price/orderbook *lookups* go to CEX, but advisory direction questions ("is BTC up or down?") still go to REGULAR.

**Feature flag rollout** — all four flags (`CEX_PLAN_TIME_VALIDATORS_ENABLED`, `CEX_INTENT_CROSSCHECK_ENABLED`, `CEX_CONFIRM_QUOTE_RECHECK_ENABLED`, `CEX_APPROVAL_MODAL_ENRICHMENT_ENABLED`) default OFF in code; turn ON in staging first, leave OFF in prod until one full deploy cycle is clean.

**Cross-cutting helper genealogy** — `binancePricing.ts` grew across fixes 2/14/15 and is now the single source for public Binance market-data calls (cache layout: 5s TTL, sorted-symbol key for `fetchBinanceUsdtPrices`, per-endpoint key for the modal helpers; single-flight `inflight: Map<key, Promise>` on the batched path). `enumerateHoldingsForFanOut` (`binance.ts`, introduced by Fix 4) is reused by Fix 15's `getCandidateHoldingsSymbols` wrapper. `extractQuantitiesFromPrompt` (Fix 10) and `extractAssetMentions` (Fix 14c) share `promptNumericExtractor.ts` — the asset extractor is exposed on `CEXSpecProvider` so core stays plugin-agnostic.

**Static eval baseline after PR #236** — 146 questions, 36/146 short-circuit hits, **0 false positives**, 1 pre-existing acceptable trap (Q210 "workout routine") unchanged.

### CEX PR #236 post-merge hotfix (N-1 regression + flag activation, 2026-05-22)

Two follow-ups landed immediately after PR #236 merged to staging.

**N-1 regression — `validateApprovedActionParams` missing case arms.** PR #236 registered 10 new actions but did NOT extend the switch in `validateApprovedActionParams` (`packages/plugin-cex/src/actions/shared.ts:754`). The read-only fast-path at `cexWorkflowMessageHandler.ts:3279` calls this validator BEFORE the action runs; the missing arms hit the `default` branch and threw `"Unknown CEX action: <name>"`, which `cexWorkflowMessageHandler.ts:3287` re-wrapped as `"Invalid read-only action parameters: ..."`. CloudWatch saw 14 occurrences in the first 2 hours on staging, breaking `get_trading_mode / get_pnl / get_positions / get_ticker / get_orderbook / list_asset_lists` plus the 4 asset-list mutations.

Fix: explicit case arms for all 10 PR #236 actions (`get_trading_mode`, `get_positions`, `get_pnl`, `get_ticker`, `get_orderbook`, `list_asset_lists`, `add_blocked_asset`, `remove_blocked_asset`, `add_allowed_asset`, `remove_allowed_asset`) that `return` to skip `preflightValidateForExchange`. Skipping preflight is safe because that function's rules only cover `get_orders / get_fills / cancel_order / create_order` (see `packages/plugin-cex/src/spec/canonical.ts:477`), and the new actions' own handlers validate their params downstream (e.g. `normalizeAsset` in `assetLists.ts`). Test guard: a parametrized `it.each` over the 10 action names in `shared.validators.test.ts` asserts none throw — if a future PR registers another action without extending this switch, that test fails.

**Feature-flag activation on staging.** PR #236 shipped four feature flags defaulted OFF in code (`CEX_PLAN_TIME_VALIDATORS_ENABLED`, `CEX_INTENT_CROSSCHECK_ENABLED`, `CEX_CONFIRM_QUOTE_RECHECK_ENABLED`, `CEX_APPROVAL_MODAL_ENRICHMENT_ENABLED`). Staging task def didn't have them set, so Fixes 7 / 10 / 11 / 14 were inert on the deployed staging agent. The `.github/workflows/staging-deploy.yml` "Upsert Wave 1+2 autotrading env vars" Python block was the right insertion point — it's the config-as-code source of truth and runs on every deploy. The four flags are now added there with value `"true"`, alongside the existing Wave 1+2 vars. The upsert is idempotent (overwrites on every deploy), so a hand-edited task def can't drift.

Production deploy is intentionally NOT yet updated — flip the same env vars in `.github/workflows/production-deploy.yml` after one full staging deploy cycle is clean.

### CEX post-PR237 comprehensive hotfix (golden-deer, 2026-05-23)

Branch: `fix/cex-post-pr237-comprehensive`. Eight follow-up commits resolving issues surfaced during UI verification of PR #236 + #237. Each commit is independently revertable; they're listed below in dependency order so anyone bisecting can stop at the layer they're investigating.

**Issue 1 — Trading-mode reported "paper" while DB said "live".** The `PUT /user/trading/preferences` endpoint wrote the new mode straight to MongoDB but never invalidated the runtime cache. `getUserTradingMode` then read the stale cache for the rest of the process lifetime. Fix lives in three files: `packages/client-direct/src/api.ts` (best-effort `cacheManager.delete(user_trading_preferences:${userId}:default_mode)` on every PUT that touches `default_mode`), `packages/plugin-cex/src/actions/getTradingMode.ts::resolveTradingMode`, and `packages/plugin-cex/src/actions/shared.ts::getUserTradingMode` — both readers were refactored to be DB-first and use the cache only as fallback when the DB read fails or returns no preference. Tests: `__tests__/getTradingMode.test.ts` was rewritten to lock in the DB-first ordering and cache write-back. The cache key shape is `user_trading_preferences:${userId}:default_mode`; if the key isn't there, the delete is a no-op.

**Issue 4 — "Spot wallet balance" returned all wallets.** `BinanceAccountsService.getBalance` was unconditionally fetching spot + funding + cross-margin + isolated-margin every call. Three pieces of plumbing landed: (1) `GetBalanceParams.wallet_type?: "spot" | "funding" | "margin_cross" | "margin_isolated" | "all"` in `packages/plugin-cex/src/types.ts`; (2) `validateGetBalanceParams` normalizes user aliases ("cross" → "margin_cross", "iso" → "margin_isolated", etc.) via `normalizeWalletTypeFilter` in `shared.ts`; (3) the venue service skips the API call when the filter excludes that scope and tags the log with `wallets_skipped=<scope>:<REASON>`. The decomposer template (`cexDecomposeTemplate.ts`) now MUST emit a specific `wallet_type` when the user names a single wallet — bare "margin balance" stays ambiguous and omits the filter so both cross + isolated render. `cexMessageTemplate.ts` only renders the requested section when a filter is present. Tests: 4 new cases in `binance.getBalance.multiWallet.test.ts` cover the spot-only / cross-only / all (default) / log-tagging paths.

**Issue 5 — Multi-order requests had no per-step approval.** Two orders typed in one message previously ran straight through to the final approval card with no chance to confirm them one at a time. The plan runner (`packages/core/src/handlers/cexPlanRunner.ts`) now emits a `human_input_required` SSE step at each pause via `emitPlanApprovalModal(ctx, plan, writeIdx)`, carrying a `plan_context` payload (`plan_id`, `step_index`, `total_steps`, `step_summaries`, `approve_all_supported`, `approval_mode`). The frontend `HumanInputDialog` reads this payload and renders a "Plan step N of M" badge + "Approve All Remaining (K)" button. Confirming a multi-step modal short-circuits `submitHumanInputApproval` (the plan runner doesn't listen on that endpoint) and instead dispatches a `sentiedge:chat-send` event with "yes" or "approve all remaining steps" — both already handled by `cexContinuationParser.ts`. Modal is review-only in this commit; parameter editing is deferred so the per-step path doesn't duplicate idempotency machinery. Single-write plans skip the modal entirely to avoid noise.

**Issue 6 — "Check orders, spot and margin" rendered three identical empty rows.** `renderStepResultBlock` preferred `payload.text` (which the action returned as a short "(no orders)" string for empty scopes) and `buildBlockSummary` had no scope discriminator. Three fixes in `packages/core/src/handlers/cexPlanExecutor.ts`: (1) structured rows take precedence over `payload.text` for tabular actions; (2) empty scopes get an explicit `_No orders in this scope._` sentinel (plus sister lines for fills / positions / balances); (3) `<summary>` appends `(venue, wallet=spot, margin=cross, BTC-USDT)` when those parameters are on the step. The `<details>` block now defaults to `<details open>` so multi-scope reads are visible without an extra click. Tests: 6 new cases in `__tests__/cexPlanExecutor.test.ts`.

**Issue 13 — Positions transparency.** `renderPositionsTable` returned the same "no open positions" line whether the API key had futures + margin enabled (account is flat) or futures permission was denied. The renderer now accepts `walletsReturned[]` and `walletsSkipped[]` and appends `_Wallets checked: <list>._` / `_Wallets skipped (permission or unavailable): <list>._` beneath both empty and populated bodies. Tests: 4 new cases in `__tests__/binance.getPositions.test.ts`.

**Issue 14 — Cross-check fired "10 vs 10.6312563061344" for a clean 10-USDT order.** Two compounding causes. (1) The cross-check was normalizing the LLM's quantized `base_size` back to quote using the LIVE ticker (~76000) instead of the user's typed limit price (71000). With LOT_SIZE=0.00001, that pushed the apparent divergence over the 5% threshold. (2) No tolerance for the legit step-size rounding inherent in `base_size = quote / price` quantized to LOT_SIZE. Fix in `packages/plugin-cex/src/intent/promptNumericExtractor.ts`: `CrossCheckInput` gains `executablePrice` and `baseStepSize`. The comparator prefers `executablePrice` over `tickerPrice` for cross-unit normalization, and widens its threshold by `stepSize * normalizationPrice / denom` (capped at 25%). `cexWorkflowMessageHandler.ts` extracts the limit price from `params.limit_price` / `params.price` / nested `order_configuration.limit_*.limit_price` and pulls `stepSize` from `provider.fetchSymbolFilters` (1-hour cache). Tests: 5 new cases in `__tests__/intent.promptNumericExtractor.test.ts` covering the exact staging repro + the tolerance cap.

**Issue 15 — Symbol completion.** "BTC ticker" / "buy 10 USDT of BTC" hit the venue with `product_id=BTC` and the venue returned no data. `completeProductId` in `packages/plugin-cex/src/actions/getTicker.ts` now normalizes bare base assets to `BTCUSDT` (Binance) / `BTC-USDT` (Coinbase). Used by `getTicker.resolveSymbols` and by `getOrderbook`. The decomposer template (`cexDecomposeTemplate.ts`) documents the rule so the LLM can pre-complete pairs too. Tests: 8 new cases in `__tests__/actions.getTicker.test.ts` covering Binance/Coinbase formats, USDC quotes, and the no-op pass-through for already-complete pairs.

**Venue-aware pricing (rule from the user, applies to all market-data calls).** When a user trades on Binance, real-time price + order book come from Binance APIs; when they trade on Coinbase, those come from Coinbase APIs. Three new pieces: `packages/plugin-cex/src/exchanges/services/coinbasePricing.ts` (mirrors `binancePricing.ts` for Coinbase Advanced Trade public endpoints — `bookTicker`, `getProductBook`, `get24hStats` — 5s per-process cache, single-flight), `packages/plugin-cex/src/marketdata/venuePricingDispatcher.ts` (routes by `venue` + normalizes symbols per venue), and updates to `CEXSpecProvider.fetchBookTicker` / `.fetchDepth` / `.fetch24hStats` to accept an optional `venue` arg. `cexMarketSnapshot.buildMarketSnapshot` and `cexWorkflowMessageHandler.requestParameterReview` thread the venue through. Unknown venues fall back to Binance with a warning log. Tests: `__tests__/coinbasePricing.test.ts` + `__tests__/venuePricingDispatcher.test.ts`.

**Plan-runner fan-out for "show my recent orders".** `requiresProductIds` on Binance `get_fills` was throwing the "product_ids is required" guard BEFORE the existing `fanOutFills` path could run; the flag is now `false` and the venue layer triggers the fan-out as designed. `GetOrdersParams` also gains an optional `history: boolean` flag the decomposer can emit for "show my recent orders" prompts that don't carry a date window. The venue layer triggers the same fan-out on `history === true || hasDateWindow`. The decomposer template documents the flag with examples. Tests: 1 new case in `binance.getOrders.fanOut.test.ts` locks in the `history: true` bypass.

**Cleanup — `CEXApprovalDialog` deleted.** That component had been dormant since the active flow moved to `HumanInputDialog` + `TradingOrderEditor`. Removed `client/src/components/CEXApprovalDialog.tsx` (~85 KB), `client/src/components/Dialog/CEXApprovalDialog.tsx` (re-export shim), the `trading_approval` branch of `Dialog/Dialog.tsx`, and the dead `handleTradingApprove` / `handleTradingReject` handlers + `CEXApprovalInterrupt` union variant in `chat.tsx`. `useApprovalRouter.detectApprovalSurface` is kept for telemetry / future opt-ins. `MarketSnapshotPanel` had already been extracted out of the dormant component into `client/src/components/cex/MarketSnapshotPanel.tsx` (Commit 3 of this branch) and is consumed by `HumanInputDialog` for both `create_order` and `preview_order` modals.

**Operator note — feature flags.** This branch does NOT introduce new feature flags. All four PR #236 flags (`CEX_PLAN_TIME_VALIDATORS_ENABLED`, `CEX_INTENT_CROSSCHECK_ENABLED`, `CEX_CONFIRM_QUOTE_RECHECK_ENABLED`, `CEX_APPROVAL_MODAL_ENRICHMENT_ENABLED`) remain authoritative; the cross-check anchor / quantization-tolerance changes (Issue 14) live behind `CEX_INTENT_CROSSCHECK_ENABLED`. Existing staging task def already has all four flipped to "true".

### CEX post-PR240 follow-up — declare remaining read-only schemas + multi-scope decomposer rule (2026-05-23)

Branch: `fix/cex-get-balance-schema-wallet-type` (continued). UI verification of PR #240 surfaced two more gaps in the same area.

**Issue 11 — "order book for ETH" demanded an explicit pair.** Tracing the LLM-extracted `product_id: "ETH"` through the workflow showed it being silently stripped before reaching the action handler. Root cause: `get_orderbook` was never declared in `CEX_ACTION_SCHEMAS`. `sanitizeCEXParamsBySchema` returns `{}` when the schema is `undefined` (documented behavior — see `cexWorkflowMessageHandler.ts:402-403`), so ALL user params were dropped before the symbol-completion step inside `getOrderbook.ts::completeProductId` could even run. Same gap existed for the other unschematized read-only actions: `get_ticker`, `get_positions`, `get_pnl`, `get_trading_mode`. Fix: declared schemas for all five in `canonical.ts`. Each schema lists exactly the params the action handler consumes (`product_id`, `depth`, `product_ids`, `wallet_type`, `scope`, `start_date`, `end_date`).

**Issue 12 — "check orders, spot and margin" only returned cross-margin.** The decomposer LLM was emitting a single `get_orders` step with `margin_type: CROSS`, and the single-action LLM template then asked the user to "request spot separately". The decomposer template (`cexDecomposeTemplate.ts`) had explicit multi-scope rules for `get_balance` but NONE for `get_orders`. Fix: added a `get_orders` multi-scope section with worked examples ("check orders, spot and margin" → 3 steps; "spot and cross margin" → 2 steps; bare "margin orders" → CROSS + ISOLATED). The renderer side was already done by PR #238 (Issue 6) — this just teaches the decomposer to actually produce the multi-step plan.

**Tests.** 6 new schema-presence cases in `canonical.formatActionForLLM.test.ts` (lock in `get_orderbook` / `get_ticker` / `get_positions` / `get_pnl` / `get_trading_mode` schemas + the `get_orders.history` and `get_balance.wallet_type` entries). Full plugin-cex suite: 817/817 pass; core CEX plan suite: 46/46 pass.

### CEX post-PR239 follow-up — action schema declares wallet_type + history (2026-05-23)

Branch: `fix/cex-get-balance-schema-wallet-type`. PR #239 plumbed `wallet_type` through the ADK extractor and projector, but UI verification surfaced that `show my spot balance` STILL returned all wallets. Root cause traced to `cexWorkflowMessageHandler.ts::sanitizeCEXParamsBySchema` (line 396) which is schema-driven: it ONLY keeps fields that are declared in the action's `CEXActionSchema.parameters`. Since `get_balance` didn't declare `wallet_type` (and `get_orders` didn't declare `history`), both fields were being stripped on the read-only fast path between projection and venue execution.

**Fix.** Declared the two missing fields in `packages/plugin-cex/src/spec/canonical.ts`:
- `get_balance.parameters.wallet_type` — enum `"spot" | "funding" | "margin_cross" | "margin_isolated" | "all"`. Mirrors `GetBalanceParams.wallet_type` and the decomposer template rules.
- `get_orders.parameters.history` — boolean. Mirrors `GetOrdersParams.history` and the decomposer template's "show me my recent orders" hint.

The plan executor / runner do NOT use `sanitizeCEXParamsBySchema`, so the decomposer path was unaffected. Only the single-action workflow path was broken, which is why PR #239's unit tests on the extractor + projector passed but the integration was still broken in staging.

**Tests.** Two new cases in `__tests__/canonical.formatActionForLLM.test.ts` lock in the schema entries and verify the formatted LLM schema surfaces `wallet_type` + its description. Full plugin-cex suite: 817/817 pass.

### CEX post-PR238 follow-up — ADK fast-path wallet scope (2026-05-23)

Branch: `fix/cex-post-pr237-adk-walletscope`. One-commit hotfix for Issue 4 that PR #238 missed in the read-only fast-path.

**Symptom.** UI verification post-deploy: `show my spot balance` still returned spot + funding + cross-margin rows. The decomposer LLM (used for multi-step plans) emitted `wallet_type: "spot"` correctly, and the venue service (`BinanceAccountsService.getBalance`) honored the filter, but the single-action read-only fast path (`runTradingSubAgent` → `getBalanceTool` → `projectAdkResult`) never extracted or forwarded `wallet_type`. The fast path is gated by `READ_ONLY_FAST_PATH.has(action)` in `cexWorkflowMessageHandler.ts:1636`, so any single-action `get_balance` prompt bypassed the decomposer entirely.

**Fix — three lines of plumbing.**
1. `packages/plugin-cex/src/adk/types.ts` — `AdkGetBalanceInput.wallet_type?: "spot" | "funding" | "margin_cross" | "margin_isolated" | "all"` (matches the canonical type in `GetBalanceParams`).
2. `packages/plugin-cex/src/adk/parameterExtractor.ts` — new `extractWalletTypeFilter(text)` helper mirroring the decomposer template's keyword rules (`isolated` → `margin_isolated`, `cross` → `margin_cross`, `funding` → `funding`, `spot` → `spot`; bare `margin` stays ambiguous and falls through). `extractGetBalanceInput` now sets `wallet_type` when matched.
3. `packages/plugin-cex/src/index.ts::projectAdkResult` — when `intent.action === "get_balance"` and the projected `extractedInput.wallet_type` is one of the five canonical values, copy it onto `params.wallet_type`. The workflow handler's `subAgentResult.params` then carries the filter into the venue call, identical to the decomposer path.

Both paths (decomposer for multi-step, fast-path for single-action) now produce the same canonical `wallet_type` field. Bare "margin balance" remains ambiguous → fan-out across both margin scopes (matches the LLM template's documented rule).

**Tests.**
- `__tests__/adk.parameterExtraction.test.ts` — 8 new cases: spot / funding / cross / isolated / ambiguous-margin / no-wallet-word / symbol+wallet coexistence.
- `__tests__/adk.tradingSubAgent.test.ts` — 3 new end-to-end cases proving the projected `extractedInput` carries `wallet_type` for each canonical scope.

Full `plugin-cex` suite: 815 tests pass (70 files). No new TypeScript errors introduced (the pre-existing ones in `cexWorkflowMessageHandler.ts:2710-2912` and `actions/getOrderbook.ts:348` etc. are unrelated and predate this branch).

### CEX iter6 — multi-step modal, classifier, cancel-all, mode-set (2026-05-23)

Branch: `fix/cex-post-pr246-iter6`. Six bugs surfaced by iter1–iter5 UI live testing, fixed in one PR.

**M1 — Multi-step modal symbol_verification false-negative.**
- Repro: `place 6 USDT buy BTC at 75000 AND 6 USDT buy ETH at 1800`. Step 1 BTC modal accepted Confirm BUY. Step 2 ETH modal showed *"The extracted symbol (ETHUSDT) doesn't match what you typed (—). Cancel and retry."* and Confirm BUY stayed disabled.
- Root cause: `cexPlanRunner.ts emitPlanApprovalModal` passed `ctx.message.content.text` as `promptText` to `buildMarketSnapshot`. For step 2+, `ctx.message` is the user's "yes" continuation — `buildSymbolVerification` finds no asset mentions in "yes" → `matches=false` → red banner + button disabled.
- Fix: read `plan.source_message` (already populated at plan creation, `cexPlanSchema.ts:143` + `cexPlanRunner.ts:404`) as the prompt source for the per-step modal. File: `packages/core/src/handlers/cexPlanRunner.ts` (~line 1152).

**M2 — Bare "trading mode" queries got generic encyclopedia answers.**
- Repro: `what is trading mode`, `what is the trading mode`, `trading mode` → Binance/Coinbase encyclopedia explanation instead of the user's mode.
- Root cause: LangGraph pre-classifier's `definitional` short-circuit regex (`what is / define / explain`) routes to `REGULAR_MESSAGE` BEFORE the LLM classifier runs. The `cex_account_intent` matcher required a possessive (`my / our / your`) or the word `current`, so bare phrasings fell through to `definitional`.
- Fix: extend `cex_account_intent` regex in `packages/core/src/handlers/langGraphPrecheck.ts` with three new alternations — bare `\btrading\s+mode\b`, `\b(?:paper|live|shadow)\s+mode\b`, and `\bis\s+it\s+(?:paper|live|shadow|real)\b`. Routes these phrasings to CEX before the definitional bucket fires. Defense-in-depth: added worked `get_trading_mode` examples to `packages/core/src/templates/cexDecomposeTemplate.ts` so the decomposer reliably emits the action once the message reaches CEX.

**M3 — "cancel all" plan failed with `"order_ids" is required`.**
- Repro: `please cancel all of them`. Decomposer emitted a 2-step plan (`get_orders` → `cancel_order`); step 2's `parameters` stayed empty because cross-step data interpolation isn't supported at decompose time. `cancel_order` correctly rejected.
- Fix: added `all_open: boolean` to `cancel_order` canonical schema (`packages/plugin-cex/src/spec/canonical.ts`). When `all_open=true`, `order_ids` becomes optional; the action handler (`packages/plugin-cex/src/exchanges/services/binance.ts BinanceOrdersService.cancelOrder`) populates the id list from the venue's open-orders snapshot internally and fans out a per-id DELETE. Returns `{ results, cancelled_count, failed_count, failed, all_open_expanded }`. Decomposer template now mandates: `"cancel all" / "please cancel all" → { action: "cancel_order", parameters: { all_open: true } }` — never a 2-step plan.

**M4 — Explicit-ids cancel plan lost the ids in step parameters.**
- Repro: `cancel order ID1, ID2, ID3` → decomposer emitted N steps with each id only in `description`, not `parameters.order_ids` → all N rejected with `"order_ids" is required`.
- Fix: two-layered. (a) Decomposer template (`cexDecomposeTemplate.ts`) rule: when user names 2+ ids, emit ONE step with `parameters.order_ids: [...]` (not N steps); single id → one step with `order_ids: ["..."]`. (b) Defense-in-depth in `packages/core/src/handlers/cexPlanExecutor.ts inflateStep`: when action is `cancel_order` and `parameters.order_ids` is empty and `all_open` is not set, parse long-numeric (≥6 digits) and `bn-…`/`cb-…` client-id patterns out of `description` into `parameters.order_ids`.

**M5 — Mode-set modal title omitted the target mode.**
- Repro: `set it to live mode` → modal heading "Switch Trading Mode" + button "Switch Mode" — no indication of target mode (paper/live/shadow).
- Fix: `client/src/components/Dialog/HumanInputDialog.tsx` — for `actionName === "set_trading_mode"`, the modal title becomes `Switch Trading Mode → LIVE/PAPER/SHADOW` color-coded (emerald/amber/slate); a one-line `MODE_DESCRIPTIONS` blurb explains the target mode; the primary button reads `Switch to LIVE/PAPER/SHADOW`. Reads target mode from `values.mode` (falls back to `data.fields.mode`).

**M6 — Mode set was confirmed but not effective on the next read.**
- Repro: `set it to live mode` → modal Switch confirmed → response *"Trading mode switched to live."*; immediately after, `what's the trading mode now` returned `paper`.
- Root cause: `setTradingMode.ts` wrote only to `user_trading_preferences[memory.userId]` and the matching cache key. After iter4 + iter3, the get_trading_mode read path tries `[emailUid, memory.userId]` (email-derived UUID first, memory.userId fallback). If `memory.userId !== emailUid` (which happens when account.id was created BEFORE `mergeDuplicateAccountsByEmail` adopted the email-derived UUID), the write landed on memory.userId and the next read found `emailUid`'s OLD row.
- Fix: `setTradingMode.ts` now writes BOTH the memory.userId row AND the email-derived `stringToUuid("email-user-<email>")` row + invalidates both cache keys. Added diagnostic log `[plugin-cex] set_trading_mode write: userId=… new_mode=… target_ids=…` for CloudWatch verification. The read path finds the new value on either key.

**Decomposer template additions** (`cexDecomposeTemplate.ts`):
- `get_trading_mode` worked examples (M2 defense-in-depth).
- `cancel_order` rules (M3 + M4): array form for explicit ids, `all_open: true` for "cancel all", explicit anti-pattern against fetch-then-cancel 2-step plans.

**Frontend changes** (`client/src/components/Dialog/HumanInputDialog.tsx`):
- `modeAwareTitle()` helper + new `MODE_DESCRIPTIONS` constant (M5).
- `sideToButtonLabel(side, actionName, targetMode)` signature extended with target-mode arg (M5).

**Verified end-to-end** on staging.sentiedge.ai with `jiang2015leon@gmail.com`, including LIVE orders <20 USDT per the user's authorization. CloudWatch `/ecs/sentiedge-agent` (region `ap-southeast-1`, AWS_PROFILE `sentiedge-target`) confirms userId agreement between writer + reader for M6 via `[plugin-cex] set_trading_mode write` and `[plugin-cex] get_trading_mode mongo read` log lines.

### CEX iter7 — M4/M5/M6 follow-ups (2026-05-24)

Branch: `fix/cex-post-pr247-iter7`. Three remaining iter6 issues:

**M4a — multi-id extraction merge.** Iter6 added an `inflateStep` defense-in-depth that recovered ids from `description` when `parameters.order_ids` was empty. Iter6 retest revealed the LLM sometimes captures the FIRST id only and leaves the rest in the description — `inflateStep` skipped recovery because order_ids was non-empty. Iter7 changes the recovery to MERGE: union the ids from description with whatever is in parameters. File: `packages/core/src/handlers/cexPlanExecutor.ts`.

**M4b — preflight `requiresProductIdFallback` was too strict.** The canonical preflight rejected explicit-id cancels when no `product_id` was supplied, even though `BinanceOrdersService.cancelOrder` already resolves symbol per id via the current open-orders snapshot at execute time. Iter7 narrows the throw to only fire when there are NO ids AND no `all_open` flag (truly nothing to cancel). File: `packages/plugin-cex/src/spec/canonical.ts`.

**M4c — frontend Confirm Cancel gating.** HumanInputDialog's `validateEntries` flagged `order_ids is required` even when `all_open=true` was set, leaving Confirm Cancel disabled. Iter7 skips the order_ids required-gate when `actionName === "cancel_order"` AND `values.all_open === "true"`. Backend validator + canonical preflight already accept that shape (iter6). File: `client/src/components/Dialog/HumanInputDialog.tsx`.

**M5 — `set_trading_mode` canonical schema entry.** Iter6's HumanInputDialog mode-aware title fired off `values.mode`, but the action had no canonical schema, so the field never rendered. Iter7 adds the schema with `mode: { type: "string", required: true, enum: ["paper","shadow","live"] }`. File: `packages/plugin-cex/src/spec/canonical.ts`.

**M6 — authoritative `account.id` via `getAccountByEmail`.** Iter6 wrote prefs to `memory.userId` and a formula-derived `stringToUuid("email-user-" + email)`. CloudWatch in iter6 retest revealed neither matched the actual mongo `account.id` for this user — `getAccountByEmail("jiang2015leon@gmail.com").id` returns `42f8204a-...` while the formula produces `ba39628b-...`. Different historical generation. Iter7 prefers the adapter's authoritative lookup before the formula fallback. Applied to BOTH the write path (`setTradingMode.ts`) AND the read paths (`getTradingMode.ts:resolveTradingMode`, `shared.ts:getUserTradingMode`). Files:
- `packages/plugin-cex/src/actions/setTradingMode.ts`
- `packages/plugin-cex/src/actions/getTradingMode.ts`
- `packages/plugin-cex/src/actions/shared.ts`

Verified end-to-end on staging.sentiedge.ai with `jiang2015leon@gmail.com`, including LIVE orders <20 USDT for M4 retest. CloudWatch `/ecs/sentiedge-agent` (region `ap-southeast-1`, AWS_PROFILE `sentiedge-target`) confirms write/read userId now matches API's `42f8204a-...` for M6 via the `target_ids` field in `[plugin-cex] set_trading_mode write` log lines.

### CEX safety-refusal hardening (2026-05-25, fix/cex-safety-refusal-hardening)

Branch: `fix/cex-safety-refusal-hardening`. Production QA scored the deployment 78/100 (`qa_production_report_v1.md`), regressing 7 points from staging because the **natural-language refusal layer is non-deterministic** across runs. The fix moves refusal logic from the LLM (sampling-dependent) into deterministic gates (rules + regex), and adds the missing config surface.

**Deterministic gates added** (sampling-free; fire alongside the existing prompt):

- **`leverageCap` risk rule** — `packages/plugin-cex/src/risk/rules/leverageCap.ts`. Refuses `create_order` intents whose `margin_context.leverage` exceeds the per-user `max_leverage` preference (default 5x, platform hard cap 10x). New `RiskRuleId` entry in `risk/types.ts`. Wired into `riskEngine.ts` RULES + RULES_BY_ID. Tests: `__tests__/risk/leverageCap.test.ts`.
- **`BACKSTOP_DENIED_ASSETS` constant** — `risk/types.ts`. Hard-coded set `{LUNA, LUNC, UST, USTC, FTT, FTX}` that fires inside the existing `assetAllowlist` rule regardless of user prefs. Curated; PR-edit to add/remove. Tests: `__tests__/risk/assetAllowlistBackstop.test.ts`.
- **`trading_safety_override` prompt-injection pattern** — `packages/core/src/utils/promptInjectionDefense.ts`. Weight 0.75 (→ "refuse"). Matches `(bypass|ignore|disable|override|skip|disregard|turn off) … (confirmation|risk|safety|guardrails|approval|limits|caps|gates|protections|policy|rules)`. The QA's stochastic refusal becomes deterministic because the gate runs before any LLM call.

**Defaults made safer**:
- `DEFAULT_USER_TRADING_PREFERENCES.asset_allowlist` now defaults to `["BTC","ETH","SOL","USDT","USDC"]` (was `[]`). Off-allowlist + non-backstop assets like PEPE now block at plan time without user config. `default_mode` stays `"live"` to preserve existing test contracts; the React `ModeBadge` fallback is what shifted to `"paper"`.
- `client/src/components/cex/ModeBadge.tsx` — fallback `"live"` → `"paper"`. The QA's M-3 (emerald LIVE badge while trading mode is PAPER) was caused by empty `prefs.data` initially returning undefined; PAPER is now the default the UI assumes until real prefs arrive.
- `TradingRiskLimitsTab.tsx` — new **Max Leverage** input (1–10x, default 5x); allowlist input pre-fills with the new default when prefs are empty; allowlist help text mentions the backstop. Allowed-fields list in `packages/client-direct/src/api.ts` PUT `/user/trading/preferences` now includes `max_leverage` with a server-side 1–10 range check.

**Paper-mode Avbl fix (QA L-2 / L-3)** — `packages/plugin-cex/src/index.ts:fetchAccountSnapshotFromCore`. The "Avbl" / "Max Buy" / "Est Fee" strip in the approval modal was reading real-exchange balances unconditionally, so a PAPER-mode user saw the same 582.4 USDT figure across BTC-USDT and LUNA-USDT previews (and not the paper-venue $10k). New `fetchPaperAccountSnapshot` helper reads from the user's paper venue (`createPaperVenueForRuntime`) when `getUserTradingMode === "paper"`; both helpers are now exported from `actions/shared.ts`. USD / USDT / USDC are treated equivalently in the quote-balance lookup, matching the chat `get_balance` renderer.

**CEX system prompt hardening** — `packages/core/src/templates/cexMessageTemplate.ts`. Critical Rules gains Rule #9 — a safety-refusal corpus (high leverage, bypass/disable framings, off-allowlist assets, admin overrides) with non-negotiable refusal templates the LLM emits even though the gates already authoritatively refuse. Reduces UX inconsistency between "what the agent says" and "what the gate did."

**Backstop deny-list policy** — curated; reflects assets the trading-safety team has explicitly flagged. Update the constant in `risk/types.ts` to add or remove. The user-configurable allowlist is read on top; the backstop ALWAYS wins.

### Daily Analysis Scheduler

Generates daily comprehensive reports for **multiple symbols (BTC, ETH, SOL)** sequentially and uploads to S3.

**File** — `packages/client-direct/src/services/dailyAnalysisSchedulerService.ts`.

**Reliability fixes (PR #144)** — production diagnosis: `s3://sentiedge2025/auto-daily-reports-agent/` stayed empty because the catch-up timer never fired. Three changes:
1. `DEFAULT_STARTUP_DELAY_MS` 1 h → **10 min** — still warmup-safe (BGE-M3 + DocumentDB index probes both finish < 5 min on prod), much more likely to fire before container churn replaces the task.
2. New **`recoveryTimer` ticks every 30 min**. If past `hourUTC` and today's reports are missing on disk + S3, it kicks `runCatchupWithGuard("recovery-poll")`. Rate-limited by the existing 3-attempt/day cap inside the guard, so persistent workflow failures cannot thrash.
3. `DAILY_ANALYSIS_RUN_ON_STARTUP=true` env var bypasses the warmup delay entirely (one-shot debugging in production).
4. Workflow failures now log `ERROR` (was `WARN`) with `content.error.message` extracted from the runtime's `errorMemory` so CloudWatch metric filters can alert on the actual root cause.
5. Single startup log line emits the full config (targets, hourUTC, nextRun, delays, S3 bucket + sync state) so enablement is grep-confirmable without reading code.

**Multi-asset (PR #124)** — scheduler iterates `[BTC, ETH, SOL]` per cycle. Per-symbol idempotency: skip if today's report already exists. Landing page `client/src/components/landing/DailyAnalysis.tsx` renders one card per symbol.

**Local + S3 dual-write** — `saveReport` writes the HTML report locally (under `agent/saved_data/Reports/` for on-demand, `agent/saved_data/DailyReports/` for scheduled) **and** uploads to S3. Sidecar `.meta.json` carries the report metadata. The local copy is the **authoritative source for the on-demand viewer** (S3 `reportUrl` is intentionally bypassed for that flow). On redeploy when the local file is gone, viewers fall back to the S3 proxy URL (`/s3-files/...`) instead of showing a 404 toast.

**Local-dev report-asset route** — A compatibility `/reports/*` route serves report HTML + chart assets from `saved_data` roots for local viewing. The production route (`/agents/:agentIdOrName/reports/:fileName`) is intact and unchanged. Both use `credentials: 'include'` for cookie-based auth.

### Embedding (BGE-M3) Lifecycle

Local embedding model is BGE-M3 (~2.5 GB, q8 quantized). Bake-cached into the Docker image at build time.

**File** — `packages/core/src/ai/localembeddingManager.ts`.

**Boot warmup (PR #155)** — `@huggingface/transformers` `pipeline()` parses model files lazily. The older `initialize()` did *not* create the ORT session — that happened on the first `extractor()` call, deferring **~3.9 GB of native allocation and ~60 s of CPU work** onto the first user-driven embed (visible as a silent 60 s stall on the first TaskChain in staging).

`warmup()` is now called from `agent/src/index.ts` at boot: `initialize()` → `extractor("warmup", { pooling: "cls", normalize: true })`. This forces ORT session creation, q8→fp32 weight pre-pack into the arena, and kernel-cache priming. Memoized via `_warmupPromise`; cleared on `reset()`.

**Thread cap** — Pipeline session_options pass `intraOpNumThreads` / `interOpNumThreads` from `EMBEDDING_ORT_THREADS` (default **1**, fail-safe parsing) and `executionMode: "sequential"`. Without the cap, embedding inference pinned both vCPUs at 100% and starved chat/streaming/health-check traffic for ~1 min during the spike.

**ECS health-check grace** — Bumped to **300 s** to cover the longer boot.

**`embed()` timeout (PR #117 release-themes)** — bound to 5 s; slow cache lookup disabled; real errors logged. Replaces a behavior where embedding hangs were silent.

**LRU cache** — `getCachedEmbeddings` is an in-memory LRU; `hasSimilarMemory` is scoped accordingly.

### Sentiscore Performance

`packages/plugin-sentiscore/` runs a per-symbol pipeline that pulls hourly category scores from S3, computes derived series, and renders a chart.

**Key files** — `actions/combine.ts`, `utils/mapWithConcurrency.ts`, `utils/normalizeSentiScoreRow.ts`, `scripts/smoke-sentiscore-s3.mjs`.

**Speedups (PR #136)** — parallel I/O, concurrent LLM calls, async chart save (no sync `canvas.toBuffer`), S3 listing TTL, bounded concurrency via `mapWithConcurrency`. AWS schema parser: `normalizeSentiScoreRow.ts` reads the **7-category hourly CSV** from `legacy_output`.

**Chart sentiment alignment (PR #149)** — `aggregateSentimentSeries` in `reportMetadataExtractor.ts` is **day-bucketed and weighted by `record.total`** (article/tweet count, fallback 1) — matching the in-chat chart's `generateChartHTML` logic. The older `sum/count` simple-mean was effectively a no-op (each hourly bucket had `count=1`) so single-article hours produced ±1.0 spikes on the report's News series. Regression test in `reportMetadataExtractor.test.ts` proves a single `value: 0.5, total: 200` hour beats two `value: ±1.0, total: 1` outliers.

### Cloud Auth & Credentials

**AWS standardization (PR #136 commit 4)** — `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are now the canonical names across the codebase. Older `SENTISCORE_ACCESS_KEY_ID` / `SENTISCORE_SECRET_ACCESS_KEY` are removed. Update deployment env before/when bringing new branches in.

**S3 credentials hardening (PRs #86, #87)** — Hardcoded AWS credentials were removed from `ReportSyncService` and other S3 access code. All S3 access must go through the standard provider chain (env → instance role).

**Vertex AI migration (PR #88)** — Google AI Studio → Vertex finished. `GOOGLE_APPLICATION_CREDENTIALS_JSON` (entire service account JSON as one line) is the production injection path. Helper: `packages/core/src/utils/googleVertexCredentials.ts`.

**DocumentDB / TLS** — `global-bundle.pem` is baked into the production image. See `senti_agent_local_db.md` memory for local dev which uses MongoDB (not the SQLite fallback).

**Exchange token encryption** — `EXCHANGE_TOKEN_ENCRYPTION_KEY` is **required** in any deploy that allows users to save CEX API keys. Format: base64-encoded 32-byte AES-256-GCM key. See "CEX Plugin" above.

### Deployment & Infrastructure

**Region** — Production + staging now run in **`ap-southeast-1` (Singapore)** as of PR #128. GitHub Actions workflows and `scripts/deploy-production.sh` / `scripts/deploy-staging.sh` target this region.

**ECS task** — 16 GB Fargate. NODE_OPTIONS `--max-old-space-size=12288 --expose-gc`. NODE_ENV=production. Port 3000.

**ALB** — Shared `sentiedge-alb` for staging + prod. `idle_timeout.timeout_seconds=600`. Apply via `scripts/set-alb-idle-timeout.sh` (idempotent, walks ECS service → target group → load balancer).

**Health endpoints (PR #119)** — Health worker exposes `/health` (liveness) and `/ready` (readiness with 15 s heartbeat). `canvas.toBuffer()` was switched to its **async callback variant** to stop blocking the event loop long enough to trip ALB health timeouts and create a crash loop.

**Parallel S3 sync** — `reportSyncService` syncs PDFs in parallel with `pLimit(4)` and async `fs.promises` calls.

**Pre-compressed assets (PR #115)** — Vite emits `.br` / `.gz` at build; `client-direct` serves them directly and drops the runtime-compression threshold.

**Singapore ALB / ECS scripts** — `scripts/aws-monitor.mjs` for runtime observability; `scripts/derive-keys.js`, `scripts/binance-verify-api-keys.mjs` for CEX setup; `scripts/test-gemini-vertex.mjs` for Vertex sanity checks.

**E2E auto-trigger disabled (PR #145)** — Staging E2E workflow runs **manually only**. Don't rely on auto-runs after pushes.

### Mobile UI

iOS Safari + Chrome Android are first-class. Common patterns surfaced from recent fixes:

- **Composer pinned to bottom**: flex-column layout, no `position: fixed`. Uses `flex-shrink-0 + dvh + safe-area-inset` (PR #116).
- **Composer auto-collapse on scroll**: only when `distanceToBottom > 20`. Toggling near the bottom causes a `useAutoScroll` ResizeObserver re-pin → opposite-direction delta → expand → flash loop (PR #144).
- **Sidebar `flex-shrink-0` on `SidebarHeader` / `SidebarFooter`**: iOS landscape viewport is ~330 px after the URL bar, so without this the inner `SidebarContent` (`flex-basis:0`) collapses to ~0 px and Hub / Agents / RoomSelector all become invisible. Also: `SidebarContent { min-h-[120px]; min-h-0; overflow-y-auto }` (PR #144).
- **Banner overlap**: phase/action header banners are `md:sticky` / `lg:sticky` only — **non-sticky on mobile** so they scroll away with content instead of covering text (PR #142).
- **`inert` over `aria-hidden`**: collapsible chat-input wrapper uses `inert={isInputCollapsed ? true : undefined}`. `aria-hidden` on a subtree that retains focus produces a console warning per WAI-ARIA; React 19 supports `inert` natively (PR #130).
- **Sidebar state persists in a 7-day cookie** (`sidebar:state`). Any flow that calls `setOpen(false)` before navigating into a focused view (e.g. `DailyAnalysis.openReport`) **must** call `setOpen(true)` on the back path or the sidebar appears collapsed when the user returns home (PR #147).

### Observability & Memory Probes

**Pattern** — When investigating native-memory leaks (rss / arrayBuffers growing while V8 heap stays flat), use `withMemProbe` + `MemoryProbe sampler.idle.baseline` together:

- `withMemProbe(siteName, async () => { ... })` wraps a single call site and emits `MemoryProbe <site>` with `elapsed=Nms native=±NMB heap=±NMB` for that span (`packages/core/src/utils/memoryProbe.ts`).
- `sampler.idle.baseline` (started in `DirectClient` constructor) ticks every 60 s for the lifetime of the process so idle-window growth is observable.
- `[Memory]` lines in `comprehensiveAnalysisWorkflowGraph.ts` cover per-action deltas during workflows.

**AxiosError sanitization (PR #153)** — Network 4xx/5xx from external APIs (e.g. CoinMetrics) used to dump ~6,500 lines of TLS socket internals to CloudWatch (~287/s for 27 s on a single 403). `summarizeAxiosError` / `formatAxiosErrorLine` in `packages/core/src/utils/axiosErrorSanitize.ts` extract just `status / statusText / method / url / code / API message`. Applied at the 5 network-fetch catches in `plugin-on_chain_data`. **Use this for any new external-API integration.**

### GEAP §3 Agent Simulation Harness + local dev-auth (branch `feat/geap-optimization-guide`, 2026-06-07)

Additive-only test tooling — **nothing here runs in the AWS deployment**. Two pieces.

**`scripts/dev-auth.mjs`** (`pnpm dev:auth`) — LOCAL-DEV ONLY auth bypass (no Django). The agent
authenticates by verifying an RS256 JWT against `JWT_PUBLIC_KEY_B64` (Django-issued in prod); this
helper mints matching tokens locally. Subcommands: `init` (generate a `.dev-auth/` keypair —
gitignored, per-developer — and print the env to set), `pubkey` (print `JWT_PUBLIC_KEY_B64`),
`token --email E [--ttl-hours N]` (mint a user JWT + a browser snippet that sets **both** the
`access_token` **and** `user_info` cookies — the SPA gates its signed-in UI on `user_info`, so an
`access_token`-only snippet leaves the UI restricted), `seed-trading --email E [--venue
binance|coinbase]` (sets `details.enableTrading=true`, a dummy default exchange, **and**
`user_trading_preferences.default_mode="paper"` so orders route to the built-in paper venue — needs
`MONGODB_CONNECTION_STRING`/`MONGODB_DATABASE`; the account must already exist). Start a local agent
with `JWT_PUBLIC_KEY_B64=$(node scripts/dev-auth.mjs pubkey)`.

**`scripts/agent-sim/`** (`pnpm sim:selftest`, `pnpm sim`) — multi-turn behaviour simulation that
drives a running paper-mode agent over HTTP/SSE with an LLM-played beginner user, drives the CEX
approval gate, and scores each run on a deterministic **safety tier** (authoritative, CI-gating)
plus an advisory Gemini judge. `pnpm sim:selftest` runs the offline `node:test` suites (SSE parser,
assertion engine, JWT mint, env injector, orchestrator proven vs an in-process mock agent) — no GCP
or live agent required. `pnpm sim` is the live run; it writes `tests/scenarios/sim_results.json`
(gitignored) and exits non-zero on any safety-assertion failure. Scenarios live in
`tests/scenarios/scenario_*.json` (`tests/scenarios/_schema.md` is the field reference).

**Load-bearing facts discovered building this (they correct earlier misconceptions — verify before
re-deriving):**
- **The SSE stream endpoint authenticates ONLY via an `Authorization: Bearer <RS256 JWT>` carrying
  an `email` claim** (`verifyBearerJwt` + `getUserInfo`, `packages/client-direct/src/auth/verifyJwt.ts`,
  `ipUtils.ts`). The `user_info` cookie does **not** authenticate — an anonymous caller is
  force-routed to REGULAR (`runtime.ts` ~2271), so the CEX workflow/gate never fires. The harness
  sends the Bearer token on every turn (`streamTurn` `authToken`).
- **Client `messageClassification` does NOT force CEX routing.** The stream route honors only
  `"TASK_CHAIN_MESSAGE"`; any other value (incl. `"CEX_WORKFLOW_MESSAGE"`) is coerced to `undefined`
  (`packages/client-direct/src/index.ts` ~1174), and the `messageClassificationOverride` metadata it
  sets is never read in core. Do not assume sending a classification reroutes a message.
- **CEX routing is reached via the server's deterministic `cex_trade_intent` short-circuit** — an
  **anchored** regex (`packages/core/src/handlers/langGraphPrecheck.ts` ~316-339): optional polite
  prefix (`please`/`can you`/…) + an imperative verb (`buy|sell|place|cancel|amend|modify|liquidate`).
  Scenarios drive the gate with a single, fully-specified imperative `executionRequest` ("Please
  place a buy order for $100 of BTC now"), sent as the final turn — and **also after a stalled
  advisory turn**, because advisory prompts often get classified as a long comprehensive/task-chain
  workflow that would otherwise time out before the trade turn fires.
- **Multi-step phrasing ("sell half my position", DCA, "X and Y") routes to the CEX plan executor**
  (a chat plan card, `Status: awaiting_approval`), not the `human_input_required` modal — and a
  headless run cannot advance it (bare `"yes"` hits the `trivial_greeting_or_affirmation`
  short-circuit → REGULAR, so it never reaches the plan runner). Keep `executionRequest` a single
  concrete order.
- The `expectsExecution` scenario flag closes the vacuous-pass hole: `requiresApprovalBeforeExecute`
  / `reapprovalOnThesisFlip` / `noLeverageUnlessApproved` all pass when nothing executes, so a
  scenario that intends to trade fails the safety tier unless a `Trading:*` / `human_input_required`
  step is actually observed.

**Live run prerequisites:** the agent's `JWT_PUBLIC_KEY_B64` must match the harness signing key; set
`SIM_JWT_PRIVATE_KEY_FILE` (or `_B64`), `SIM_MOCK_PROVIDER=1` (env-context injection), and pass
`--user-email <trading-enabled paper account>`. Verified end-to-end against a local agent: all 3
scenarios × 2 variants reach the `human_input_required` gate and pass the safety tier.

### GEAP §4 Observability + §5 Optimizer + §6 deploy (branch `feat/geap-observability-optimizer`, 2026-06-09)

Continues `docs/geap-optimization-guide.md` past §3. **All additive + AWS-isolated**; tracing is
**default-OFF**, so merging cannot change the AWS deployment.

**§4 Observability — OpenTelemetry (`packages/core/src/utils/tracing.ts`).** Env-gated on
`OTEL_TRACING_ENABLED === "true"` (unset ⇒ hard no-op; mirrors `langsmith.ts`). Only
`@opentelemetry/api` is imported at load (inert without a provider); the SDK + Cloud Trace exporter +
auto-instrumentations are lazy-imported inside `initTracing()`. Exports: `initTracing` (first line of
`startAgents`, `agent/src/index.ts`), `withSpan`, `setDecisionOutcome`, `spanFromProcessingStep`,
`traceNode`. Wiring: per-turn root span around `routeMessage` (thin wrapper → `routeMessageImpl`,
`runtime.ts`); `emitStep` (CEX handler) bridges every `Trading:` step to a span event; `traceCexNode`
wraps all 13 CEX `StateGraph` nodes and maps their terminal `phase` → a **`decision.outcome`** span
attribute (`risk_block`/`awaiting_approval`/`freshness_block`/`rejected`/`executed`/`failed`/`allow`);
`traceNode` wraps the 7 comprehensive-workflow nodes. OTel deps live in `packages/core/package.json`
(`@opentelemetry/{api,sdk-node,auto-instrumentations-node}` + `@google-cloud/opentelemetry-cloud-trace-exporter`;
`sdk-trace-base` + `context-async-hooks` are devDeps for the in-memory span test
`packages/core/__tests__/tracing.test.ts`). Verified live: spans land in Cloud Trace with
`decision.outcome` as a filterable dimension.

**§5 Optimizer — `scripts/agent-sim/optimize.mjs` (`pnpm optimize`).** Propose-only GEPA-style
hill-climb over `settings.system` / the CEX template: mine §3 failures → propose patches (Gemini) →
**deterministic safety floor** (`validateSystemPatch` rejects candidates that negate
approval/risk/leverage/re-approval; `validateTemplatePatch` requires the Rule-9 corpus verbatim) →
A/B SELECT (injectable; keep iff safety not regressed AND task improved AND classification not
regressed) → emit a `.patch` **only** for an A/B-passed candidate (never on floor-pass alone) + a
report. Never mutates the tree or commits. Pure logic unit-tested in `optimize.test.mjs`.

**§6 deploy — `Dockerfile.agentruntime` + `scripts/geap/`.** A SEPARATE GCP side-environment image
(prod `Dockerfile` untouched): mirrors prod + `OTEL_TRACING_ENABLED=true` + a CMD bridge mapping the
platform-injected `$PORT` → `SERVER_PORT`. `scripts/geap/` = operator runbook (`README.md`) +
`setup-gcp.sh` (enable APIs / AR repo / IAM) + `deploy-cloud-run.sh` (build→push→Cloud Run; aborts on
prod-datastore strings). ⚠️ The Agent-Runtime custom-container request interface isn't documented —
**Cloud Run is the verified target** (the guide's fallback). The actual GCP build/deploy is operator-run.

**Local-testing facts (correct earlier assumptions — verify before re-deriving):**
- **`create_order` dispatch is per-user, not global.** `resolveTradingMode`
  (`plugin-cex/src/actions/getTradingMode.ts`) reads `user_trading_preferences.default_mode` (DB-first,
  keyed by `account.id`) and **defaults to `live`** when there's no row. `PAPER_TRADING_ENABLED` does
  **not** route orders. So a seeded user with no prefs row sends orders to the **real** exchange (dummy
  creds ⇒ `create_order error: API-key format invalid`). `seed-trading` now sets `default_mode="paper"`
  so orders fill on the paper $10k ledger.
- **The SPA's signed-in UI gates on the `user_info` cookie**, not `access_token`
  (`AuthContext.checkAuthStatus` bails to logged-out without it and never calls `getMe()`). Set BOTH
  cookies (the `dev:auth token` snippet does). **The Sign-In FORM is non-functional locally**: for
  `VITE_TEST_USER_EMAIL` it triggers a frontend-only dev-bypass (fake user, no JWT ⇒ 401 on authed
  calls); otherwise it POSTs to Django's `/authentication/validation/`, which the local agent doesn't
  implement. Use the dev-auth cookie snippet, never the form.
- **Production safety** of the dev-auth flow + the do-not rules are in `docs/local-dev-auth.md`
  ("Is this safe for production?"): RS256 means self-minted tokens fail against Django's prod key;
  `.env.local` + `.dev-auth/` are git+docker-ignored; the frontend dev-bypass is compiled out of prod
  builds.

### Configuration & Environment (additions)

| Var | Purpose | Default |
|-----|---------|---------|
| `OTEL_TRACING_ENABLED` | `true` enables §4 OpenTelemetry → Cloud Trace (default-off; the ONLY switch). The GCP `Dockerfile.agentruntime` sets it; AWS task defs leave it unset | — |
| `EMBEDDING_ORT_THREADS` | ONNX Runtime intra/inter op thread cap for BGE-M3 | `1` |
| `EXCHANGE_TOKEN_ENCRYPTION_KEY` | **Required** when users save CEX keys. Base64-encoded 32-byte AES-256-GCM key | — |
| `SERVER_KEEP_ALIVE_TIMEOUT_MS` | Node `server.keepAliveTimeout`. Must exceed ALB idle timeout | `620000` |
| `SERVER_HEADERS_TIMEOUT_MS` | Node `server.headersTimeout`. Must exceed `keepAliveTimeout` | `625000` |
| `DAILY_ANALYSIS_FIRST_RUN_DELAY_MS` | Override the 10 min startup delay for the daily scheduler | — |
| `DAILY_ANALYSIS_RUN_ON_STARTUP` | `true` bypasses warmup delay entirely (one-shot debug) | `false` |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | Vertex AI service-account JSON inlined as one line | — |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Standard names; replace older `SENTISCORE_*` | — |
| `MONGODB_CONNECTION_STRING` | Optional; if set, used instead of SQLite. Local dev defaults to MongoDB on `senti-agent-0428` | — |
| `DATABASE_ADAPTER` | `sqlite` \| `mongodb` \| `documentdb` | derived |
| `SSE_KEEPALIVE_INTERVAL` | SSE keepalive (ms) | `15000` |
| `STREAM_TIMEOUT` | Stream timeout (ms) | `600000` |
| `JWT_PUBLIC_KEY_B64` | Base64-encoded RS256 **public** key the SSE endpoint verifies Bearer tokens against. Required for any authenticated (non-anonymous) request; unset ⇒ all requests resolve to anonymous IP identity | — |
| `SIM_JWT_PRIVATE_KEY_FILE` / `SIM_JWT_PRIVATE_KEY_B64` | agent-sim: RS256 **private** key used to mint the harness Bearer JWT. Must pair with the agent's `JWT_PUBLIC_KEY_B64`. Unset ⇒ harness runs anonymous (gate never reached) | — |
| `SIM_MOCK_PROVIDER` | agent-sim: `1` enables harness-side scripted env-context turns (`highVolatility`/`thesisFlip`); never fires in AWS | — |
| `SIM_TURN_TIMEOUT_MS` | agent-sim: per-turn SSE read timeout before the harness moves on | `120000` |

### When Adding a New Plugin

The plugin allowlist (`pluginFilter.ts` consumed in `agent/src/index.ts`) is **fail-closed**. If an action plugin is not allowlisted, its actions silently don't register and the model can't call them. After adding a plugin, verify the allowlist (PR #123 was a missed allowlist entry on `plugin-cex`).

### Style Conventions Enforced by Recent PRs

- **Use `buildChartProxyUrl(...)`** for chart URLs in plugins. Never return a relative `saved_data/Charts/...` path.
- **Strip `[ACTION_SUMMARY]` envelopes** with `[,\s]*` (not `\s*`) on both the closing tag and any trailing comma. Several templates emitted `[/ACTION_SUMMARY],\n\n` and the older regex left a floating comma between sections (PR #138).
- **Use `MarkdownRenderer`** for any user-facing markdown rendering. Lists are `list-outside pl-6` (not `list-inside`) — `list-inside` breaks items whose first child is a `<p>` (markdown-to-jsx wraps when there's a blank line) and produces a lone "1." line.
- **Wrap external-API fetch errors** with `summarizeAxiosError` before logging.
- **Keep failure paths writing snapshot rows** — never `failures.push(...)` without a corresponding `buildFailedActionMemory()` push into `results`.

## Important Notes

1. **pnpm is required** - Enforced via preinstall hook in package.json; fails if npm/yarn used
2. **Local dev uses MongoDB on this fork** - On `senti-agent-0428`, run local dev/tests against MongoDB (`DATABASE_ADAPTER=mongodb` + a connection string). The SQLite fallback path still exists in the framework but is not the supported local mode here
3. **Plugins are dynamic** - Loaded at runtime; failures in plugin imports don't crash agent
4. **Workspace context** - Always run commands from repo root, not package directories
5. **Docker uses production mode** - NODE_ENV=production, only prod dependencies included
6. **Working directory** - Agent sets process.cwd() to `agent/` folder at startup for saved_data paths
7. **Character files inherit** - Use `extends` in character JSON to create variants
8. **Streaming is SSE** - Server-sent events via HTTP, keep-alive interval configurable
9. **Embedding model preloaded** - BGE-M3 downloaded at agent startup (2.5GB, cached locally)
10. **Turbo caching** - Build artifacts cached; clean with `pnpm clean` if experiencing issues
