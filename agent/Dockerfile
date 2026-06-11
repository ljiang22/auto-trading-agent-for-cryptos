# syntax=docker/dockerfile:1.4

# == Stage 1: Builder ================================================================
# Full toolchain: compiles TypeScript (tsup/tsc), builds native modules
# (canvas, better-sqlite3), and assembles the Vite client SPA.
FROM node:23.3.0-slim AS builder

# System build deps — BuildKit cache mounts prevent re-downloading on every build
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked     --mount=type=cache,target=/var/lib/apt,sharing=locked     apt-get update && apt-get install -y --no-install-recommends       ca-certificates curl git       python3 make g++ build-essential       libcairo2-dev libjpeg-dev libpango1.0-dev libgif-dev       openssl libssl-dev libsecret-1-dev libopus-dev &&     ln -sf /usr/bin/python3 /usr/bin/python

RUN npm install -g pnpm@9.15.7

WORKDIR /app

# --- Dependency install layer -------------------------------------------------------
# Copy ONLY lockfile + workspace manifests (NOT source).
# pnpm install is only re-run when these files change, not on every source edit.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json biome.json ./
COPY patches/ patches/
COPY agent/package.json     agent/
COPY client/package.json    client/
COPY docs/package.json      docs/
COPY packages/adapter-mongodb/package.json               packages/adapter-mongodb/
COPY packages/adapter-sqlite/package.json                packages/adapter-sqlite/
COPY packages/agent-twitter-client/package.json          packages/agent-twitter-client/
COPY packages/cli/package.json                           packages/cli/
COPY packages/client-direct/package.json                 packages/client-direct/
COPY packages/client-twitter/package.json                packages/client-twitter/
COPY packages/core/package.json                          packages/core/
COPY packages/dynamic-imports/package.json               packages/dynamic-imports/
COPY packages/outputs/package.json                       packages/outputs/
COPY packages/plugin-charts/package.json                 packages/plugin-charts/
COPY packages/plugin-coinmarketcap/package.json          packages/plugin-coinmarketcap/
COPY packages/plugin-content-analysis/package.json       packages/plugin-content-analysis/
COPY packages/plugin-crypto_research_search/package.json packages/plugin-crypto_research_search/
COPY packages/plugin-fearandindex_analysis/package.json  packages/plugin-fearandindex_analysis/
COPY packages/plugin-institutional_adoption/package.json packages/plugin-institutional_adoption/
COPY packages/plugin-launchpad/package.json              packages/plugin-launchpad/
COPY packages/plugin-news/package.json                   packages/plugin-news/
COPY packages/plugin-on_chain_data/package.json          packages/plugin-on_chain_data/
COPY packages/plugin-prediction/package.json             packages/plugin-prediction/
COPY packages/plugin-sentiscore/package.json             packages/plugin-sentiscore/
COPY packages/plugin-technic_analysis/package.json       packages/plugin-technic_analysis/
COPY packages/plugin-web-search/package.json             packages/plugin-web-search/

# pnpm store is cached by BuildKit — skips re-downloading unchanged packages
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked     pnpm install --frozen-lockfile

# --- Source layer -------------------------------------------------------------------
# Everything above is cache-stable; only layers from here down re-run on source edits.
# (docs/ must be present so turbo --filter=!eliza-docs works)
COPY . /app

# Pre-create turbo cache dirs (avoids turbo ENOENT race on first run)
RUN find packages -mindepth 1 -maxdepth 1 -type d -exec mkdir -p {}/.turbo \; &&     mkdir -p agent/.turbo client/.turbo docs/.turbo

# VITE_* variables must be baked in at build time — Vite embeds them in the JS bundle
ARG SERVER_BASE_URL=
ARG VITE_APP_HOST_DOMAIN=http://localhost:3000
ARG VITE_COOKIE_DOMAIN=localhost
ARG VITE_ANALYTICS_BASE_URL=
ARG VITE_ADMIN_EMAILS=
ARG VITE_TEST_USER_EMAIL=
ARG VITE_TEST_USER_TIER=

ENV SERVER_BASE_URL=     VITE_APP_HOST_DOMAIN=     VITE_COOKIE_DOMAIN=     VITE_ANALYTICS_BASE_URL=     VITE_ADMIN_EMAILS=     VITE_TEST_USER_EMAIL=     VITE_TEST_USER_TIER=

# Build all TypeScript packages + Vite SPA (excludes eliza-docs)
RUN pnpm run build-docker

# Prune to production dependencies only (removes devDeps: tsup, tsc, turbo, jest...)
RUN pnpm prune --prod

# Single combined cleanup pass — one filesystem traversal instead of six:
#   • .d.ts, .js.map      — compile-time only
#   • CHANGELOG*, README* — docs only
#   • *.cu, *.cuh         — CUDA source (onnxruntime)
#   Prunes /app/packages/core/cache to avoid deleting the BGE-M3 model if present
RUN find /app -path /app/packages/core/cache -prune -o     \( -name *.d.ts -o -name *.js.map -o -name CHANGELOG*        -o -name *.cu -o -name *.cuh -o -name README* \)     -delete 2>/dev/null;     find /app/node_modules -type d \( -name __tests__ -o -name .cache \)         -exec rm -rf {} + 2>/dev/null;     find /app/node_modules -path */onnxruntime-node/bin/*         \( -name libonnxruntime_providers_cuda.so            -o -name libonnxruntime_providers_tensorrt.so \)         -delete 2>/dev/null; true

# == Stage 2: Runtime =================================================================
# Lean image: only runtime system libs, no build toolchain.
FROM node:23.3.0-slim AS runtime

# Runtime system deps — BuildKit cache mount prevents re-downloading
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked     --mount=type=cache,target=/var/lib/apt,sharing=locked     apt-get update && apt-get install -y --no-install-recommends       ca-certificates curl ffmpeg       libcairo2 libjpeg62-turbo libpango-1.0-0 libpangocairo-1.0-0 libgif7       openssl libssl3 libsecret-1-0 libopus0       libgomp1

# Install pnpm for the CMD (pnpm --filter @sentiedge/agent start)
RUN npm install -g pnpm@9.15.7

WORKDIR /app

# Copy pruned + trimmed artifacts from builder
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/turbo.json ./turbo.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/agent ./agent
COPY --from=builder /app/characters ./characters
COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/global-bundle.pem ./global-bundle.pem

ENV NODE_ENV=production
ENV SERVER_PORT=3000
# Limit V8 heap to 3 GB
ENV NODE_OPTIONS=--max-old-space-size=3072

EXPOSE 3000

ENV TRANSFORMERS_CACHE=/app/packages/core/cache
ENV HF_HOME=/app/packages/core/cache

# Cap CPU threads used by BGE-M3 inference so cold-start + per-call inference
# can't pin both vCPUs and starve concurrent request handling. session_options
# in localembeddingManager already sets ORT intra/inter-op threads; OMP/MKL
# vars cover any indirect threadpool inside onnxruntime-node bindings.
ENV EMBEDDING_ORT_THREADS=1
ENV OMP_NUM_THREADS=1
ENV MKL_NUM_THREADS=1

# Pre-bake BGE-M3 ONNX model (~2.5 GB) into the image so ECS tasks never
# download at runtime (fixes NAT-gateway egress cost + cold-start latency).
RUN cd /app/packages/core && node dl-model.mjs && rm dl-model.mjs

CMD [pnpm, --filter, @sentiedge/agent, start, --isRoot]
