# syntax=docker/dockerfile:1.4

# == Stage 1: Builder ================================================================
# Full toolchain: compiles TypeScript (tsup/tsc), builds native modules
# (canvas, better-sqlite3), and assembles the Vite client SPA.
FROM node:23.3.0-slim AS builder

RUN npm install -g pnpm@9.15.7 && \
    apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git \
      python3 make g++ build-essential \
      libcairo2-dev libjpeg-dev libpango1.0-dev libgif-dev \
      openssl libssl-dev libsecret-1-dev libopus-dev && \
    ln -sf /usr/bin/python3 /usr/bin/python && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---- Dependency layer (only busts when lockfile or package.json manifests change) ----
# Copy workspace config and lockfile first
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./

# Copy each workspace package.json individually so pnpm can resolve the graph.
# Source code is NOT copied here -- this layer is cached until deps change.
COPY packages/adapter-mongodb/package.json      packages/adapter-mongodb/package.json
COPY packages/adapter-sqlite/package.json       packages/adapter-sqlite/package.json
# agent-twitter-client has a prepare script (rollup -c) that runs during pnpm install
# and requires source files -- copy the full package so install does not fail.
COPY packages/agent-twitter-client/ packages/agent-twitter-client/
COPY packages/cli/package.json                  packages/cli/package.json
COPY packages/client-direct/package.json        packages/client-direct/package.json
COPY packages/client-twitter/package.json       packages/client-twitter/package.json
COPY packages/core/package.json                 packages/core/package.json
COPY packages/dynamic-imports/package.json      packages/dynamic-imports/package.json
COPY packages/plugin-charts/package.json        packages/plugin-charts/package.json
COPY packages/plugin-coinmarketcap/package.json packages/plugin-coinmarketcap/package.json
COPY packages/plugin-content-analysis/package.json packages/plugin-content-analysis/package.json
COPY packages/plugin-crypto_research_search/package.json packages/plugin-crypto_research_search/package.json
COPY packages/plugin-fearandindex_analysis/package.json packages/plugin-fearandindex_analysis/package.json
COPY packages/plugin-institutional_adoption/package.json packages/plugin-institutional_adoption/package.json
COPY packages/plugin-launchpad/package.json     packages/plugin-launchpad/package.json
COPY packages/plugin-news/package.json          packages/plugin-news/package.json
COPY packages/plugin-on_chain_data/package.json packages/plugin-on_chain_data/package.json
COPY packages/plugin-prediction/package.json    packages/plugin-prediction/package.json
COPY packages/plugin-sentiscore/package.json    packages/plugin-sentiscore/package.json
COPY packages/plugin-technic_analysis/package.json packages/plugin-technic_analysis/package.json
COPY packages/plugin-web-search/package.json    packages/plugin-web-search/package.json
COPY packages/plugin-cex/package.json           packages/plugin-cex/package.json
COPY agent/package.json                         agent/package.json
COPY client/package.json                        client/package.json
COPY docs/package.json                          docs/package.json

# Install all deps (including devDeps needed for tsup/turbo/tsc)
# onnxruntime-node postinstall downloads the GPU variant by default;
# the GPU-specific .so files are removed in the cleanup step below.
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile

# Pre-create turbo cache dirs (avoids turbo ENOENT race on first run)
RUN find packages -mindepth 1 -maxdepth 1 -type d -exec mkdir -p {}/.turbo \; && \
    mkdir -p agent/.turbo client/.turbo docs/.turbo

# ---- Source layer (only busts on source-code changes) ----
# VITE_* variables must be baked in at build time -- Vite embeds them in the JS bundle
ARG SERVER_BASE_URL=
ARG VITE_APP_HOST_DOMAIN=http://localhost:3000
ARG VITE_COOKIE_DOMAIN=localhost
ARG VITE_ANALYTICS_BASE_URL=
ARG VITE_ADMIN_EMAILS=
ARG VITE_TEST_USER_EMAIL=
ARG VITE_TEST_USER_TIER=

ENV SERVER_BASE_URL=${SERVER_BASE_URL} \
    VITE_APP_HOST_DOMAIN=${VITE_APP_HOST_DOMAIN} \
    VITE_COOKIE_DOMAIN=${VITE_COOKIE_DOMAIN} \
    VITE_ANALYTICS_BASE_URL=${VITE_ANALYTICS_BASE_URL} \
    VITE_ADMIN_EMAILS=${VITE_ADMIN_EMAILS} \
    VITE_TEST_USER_EMAIL=${VITE_TEST_USER_EMAIL} \
    VITE_TEST_USER_TIER=${VITE_TEST_USER_TIER}

# Copy entire source tree (docs/ must be present so turbo --filter=!eliza-docs works)
COPY . /app

# Build all TypeScript packages + Vite SPA (excludes eliza-docs)
RUN pnpm run build-docker

# Prune to production dependencies only (removes devDeps: tsup, tsc, turbo, jest...)
RUN pnpm prune --prod

# ---- Combined cleanup (single RUN layer, replaces 4 separate find passes) ----
# 1. TypeScript declaration files and source maps (compile-time only)
# 2. Changelog files, CUDA source (.cu/.cuh) -- docs/compile artifacts
# 3. Test directories and turbo local caches
# 4. onnxruntime GPU providers (CUDA/TensorRT) -- ~600 MB, won't run on CPU-only ECS
RUN find /app -path "*/core/cache" -prune -o \
      \( -name "*.d.ts" -o -name "*.js.map" -o -name "CHANGELOG*" \
         -o -name "*.cu" -o -name "*.cuh" \) -delete 2>/dev/null; \
    find /app/node_modules -type d \( -name "__tests__" -o -name ".cache" \) \
         -exec rm -rf {} + 2>/dev/null; \
    find /app/node_modules -path "*/onnxruntime-node/bin/*" \
         \( -name "libonnxruntime_providers_cuda.so" \
            -o -name "libonnxruntime_providers_tensorrt.so" \) \
         -delete 2>/dev/null; \
    true

# == Stage 2: Runtime =================================================================
# Lean image: only runtime system libs, no build toolchain.
FROM node:23.3.0-slim AS runtime

# Runtime system dependencies:
#   ffmpeg           -- audio/media processing used by agent plugins
#   libcairo2        -- canvas (chart rendering in plugin-charts)
#   libpango*        -- text layout for canvas
#   libjpeg62-turbo  -- JPEG decoding for canvas/sharp
#   libgif7          -- GIF support for canvas
#   libssl3          -- TLS for MongoDB / HTTPS connections
#   libsecret-1-0    -- secret storage (OS keychain integration)
#   libopus0         -- Opus audio codec
#   libgomp1         -- OpenMP threading required by onnxruntime-node CPU runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl ffmpeg \
      libcairo2 libjpeg62-turbo libpango-1.0-0 libpangocairo-1.0-0 libgif7 \
      openssl libssl3 libsecret-1-0 libopus0 \
      libgomp1 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install pnpm for the CMD (pnpm --filter @sentiedge/agent start)
RUN npm install -g pnpm@9.15.7

WORKDIR /app

# Copy pruned + trimmed artifacts from builder
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/turbo.json ./turbo.json
COPY --from=builder /app/node_modules ./node_modules

# Download BGE-M3 model BEFORE source files so this layer is cache-stable across
# normal code pushes. Only re-runs when node_modules or dl-model.mjs itself changes.
# packages/core/node_modules is needed so ESM can resolve @huggingface/transformers
# (pnpm does not hoist it to root node_modules; it lives in the per-package store).
COPY packages/core/dl-model.mjs packages/core/dl-model.mjs
COPY --from=builder /app/packages/core/node_modules packages/core/node_modules
RUN cd /app/packages/core && node dl-model.mjs && rm dl-model.mjs

COPY --from=builder /app/packages ./packages
COPY --from=builder /app/agent ./agent
COPY --from=builder /app/characters ./characters
COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/global-bundle.pem ./global-bundle.pem
# Round-6 — migration / one-shot operational scripts must be in the
# runtime image so they can run via `aws ecs run-task` overrides
# (DocumentDB is only reachable from inside the VPC, so the script
# needs to ship in the same image the agent runs from). Adds ~20 KB
# to the runtime layer.
COPY --from=builder /app/scripts ./scripts

ENV NODE_ENV=production
ENV SERVER_PORT=3000
# V8 heap budget. On a 16 GB ECS task we need to leave room for native
# memory (BGE-M3 ~2 GB, LLM stream Buffers, MongoDB driver, canvas/sharp).
# 12 GB heap leaves ~4 GB for native — comfortably above the BGE-M3 footprint
# but tight against multiple concurrent comprehensive runs (each adds ~1-2 GB
# of native pressure). Pair with the global single-flight gate in
# packages/core/src/handlers/comprehensiveAnalysisWorkflowGraph.ts so we can't
# run two simultaneously.
#
# `--expose-gc` lets the workflow call global.gc() between heavy actions to
# return V8 garbage to the OS quickly; without it, V8 holds onto big strings
# (formatted action results, LLM responses) until the next major GC tick.
ENV NODE_OPTIONS="--max-old-space-size=12288 --expose-gc"

EXPOSE 3000

ENV TRANSFORMERS_CACHE=/app/packages/core/cache
ENV HF_HOME=/app/packages/core/cache

# Cap CPU threads used by BGE-M3 inference so cold-start + per-call inference
# can't pin both vCPUs and starve concurrent request handling. session_options
# in localembeddingManager already sets ORT intra/inter-op threads; OMP/MKL
# vars cover any indirect threadpool inside onnxruntime-node bindings.
# Override via task-def env if you bump task CPU and want more parallelism.
ENV EMBEDDING_ORT_THREADS=1
ENV OMP_NUM_THREADS=1
ENV MKL_NUM_THREADS=1

CMD ["pnpm", "--filter", "@sentiedge/agent", "start", "--isRoot"]
