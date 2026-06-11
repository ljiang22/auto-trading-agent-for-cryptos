#!/usr/bin/env bash
#
# GEAP side-environment deploy: build Dockerfile.agentruntime -> push to Artifact Registry ->
# deploy to Cloud Run with tracing ON, paper-mode, and a throwaway datastore.
#
# This is the §6 GCP side-environment path. It is NOT the AWS/ECR production path and touches
# NOTHING in AWS. Cloud Run is the deterministic target for the SSE/HTTP agent server and the
# guide's documented fallback (the Agent Runtime custom-container request interface is not fully
# documented — see scripts/geap/README.md §6.1). Cloud Trace ingests the same OTel either way.
#
# Usage:
#   PROJECT_ID=my-proj RUNTIME_SA=sa@my-proj.iam.gserviceaccount.com \
#     scripts/geap/deploy-cloud-run.sh [--region us-central1] [--tag obs] [--skip-build] [--dry-run]
#
# Required: PROJECT_ID, RUNTIME_SA (env or --project/--sa).
# On Cloud Run the service runs AS RUNTIME_SA, so ADC covers both Vertex (the agent's Gemini
# calls) and the Cloud Trace exporter — no service-account JSON is passed in.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-us-central1}"
RUNTIME_SA="${RUNTIME_SA:-}"
SERVICE="${SERVICE:-senti-agent-geap}"
REPO="${REPO:-senti-agent-geap}"
TAG="${TAG:-obs}"
DATABASE_ADAPTER="${DATABASE_ADAPTER:-sqlite}"
GOOGLE_VERTEX_LOCATION="${GOOGLE_VERTEX_LOCATION:-global}"
EXTRA_ENV="${EXTRA_ENV:-}"   # optional extra "K=V,K=V" appended to --set-env-vars
DRY_RUN=0
SKIP_BUILD=0

usage() { sed -n '2,28p' "$0"; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT_ID="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --sa) RUNTIME_SA="$2"; shift 2 ;;
    --service) SERVICE="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown arg: $1" >&2; usage 2 ;;
  esac
done

[ -n "$PROJECT_ID" ] || { echo "ABORT: PROJECT_ID is required (env or --project)." >&2; exit 2; }
[ -n "$RUNTIME_SA" ] || { echo "ABORT: RUNTIME_SA is required (env or --sa)." >&2; exit 2; }

# --- AWS-isolation guard: refuse any production datastore coordinates ---------------------------
FORBIDDEN='sentiedge-docdb|senti-agent-prod|senti-agent-staging'
for v in DOCUMENTDB_CONNECTION_STRING MONGODB_CONNECTION_STRING DOCUMENTDB_DATABASE \
         MONGODB_DATABASE DATABASE_URL EXTRA_ENV; do
  val="${!v:-}"
  if [ -n "$val" ] && printf '%s' "$val" | grep -Eq "$FORBIDDEN"; then
    echo "ABORT: \$$v references a PRODUCTION datastore ($FORBIDDEN)." >&2
    echo "       This side-environment must use a throwaway datastore (DATABASE_ADAPTER=sqlite or a disposable Mongo)." >&2
    exit 2
  fi
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMG="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/agent:${TAG}"
ENV_VARS="OTEL_TRACING_ENABLED=true,DATABASE_ADAPTER=${DATABASE_ADAPTER},PAPER_TRADING_ENABLED=true,GOOGLE_VERTEX_PROJECT=${PROJECT_ID},GOOGLE_VERTEX_LOCATION=${GOOGLE_VERTEX_LOCATION}"
[ -n "$EXTRA_ENV" ] && ENV_VARS="${ENV_VARS},${EXTRA_ENV}"

run() { echo "+ $*"; [ "$DRY_RUN" = 1 ] || "$@"; }

echo "=== GEAP Cloud Run deploy (side-environment, AWS-isolated) ==="
echo "  project=${PROJECT_ID} region=${REGION} service=${SERVICE}"
echo "  image=${IMG}"
echo "  env=${ENV_VARS}"
echo "  dry-run=${DRY_RUN} skip-build=${SKIP_BUILD}"
echo ""

if [ "$SKIP_BUILD" = 0 ]; then
  # linux/amd64: Cloud Run/Agent Runtime are amd64 (the prod ECS image is arm64). Heavy: prebakes BGE-M3.
  run docker build --platform linux/amd64 -f "${ROOT}/Dockerfile.agentruntime" -t "$IMG" "$ROOT"
  run docker push "$IMG"
fi

# Do NOT set PORT (Cloud Run injects it; the image CMD maps $PORT -> SERVER_PORT).
# 16Gi/gen2 matches the 12 GB-heap tuning + ~4 GB native; --timeout 3600 + the 15 s SSE keepalive
# keep long streams alive; --no-cpu-throttling keeps the scheduler + BGE-M3 warm.
run gcloud run deploy "$SERVICE" \
  --image "$IMG" \
  --region "$REGION" \
  --service-account "$RUNTIME_SA" \
  --execution-environment gen2 \
  --memory 16Gi --cpu 4 --no-cpu-throttling \
  --timeout 3600 \
  --no-allow-unauthenticated \
  --set-env-vars "$ENV_VARS"

echo ""
echo "Next:"
echo "  - Cloud Trace (project ${PROJECT_ID}): filter decision.outcome=\"risk_block\" / \"awaiting_approval\""
echo "    and confirm handler:routeMessage roots + node:* children + 'Trading: …' events."
echo "  - Drive the §3 sim against the service URL (auth'd) — see scripts/agent-sim/README.md."
echo "  - PROD untouched: this deploys only to Cloud Run in ${PROJECT_ID}; no AWS artifact is modified."
