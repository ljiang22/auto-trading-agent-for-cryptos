#!/usr/bin/env bash
#
# Public demo deploy: backend + frontend (Vite SPA baked into Dockerfile.agentruntime)
# on Cloud Run in Singapore (asia-southeast1), no login required.
#
# Usage:
#   SOURCE_ENV=/path/to/.env scripts/geap/deploy-public-sg.sh [--skip-build] [--dry-run]
#
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-senti-agent-060626}"
REGION="${REGION:-asia-southeast1}"
RUNTIME_SA="${RUNTIME_SA:-senti-agent-geap@${PROJECT_ID}.iam.gserviceaccount.com}"
SERVICE="${SERVICE:-auto-trading-agent-cryptos}"
REPO="${REPO:-senti-agent-geap}"
TAG="${TAG:-public-sg}"
SOURCE_ENV="${SOURCE_ENV:-}"
SKIP_BUILD=0
DRY_RUN=0

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ROOT}/.cloud-run-env.yaml"

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$SOURCE_ENV" ] || SOURCE_ENV="$(dirname "$ROOT")/senti-agent-0428/.env"
[ -f "$SOURCE_ENV" ] || { echo "ABORT: SOURCE_ENV not found: $SOURCE_ENV" >&2; exit 2; }

run() { echo "+ $*"; [ "$DRY_RUN" = 1 ] || "$@"; }

echo "=== Public SG deploy (project=${PROJECT_ID} region=${REGION}) ==="

PROJECT_ID="$PROJECT_ID" RUNTIME_SA="$RUNTIME_SA" REGION="$REGION" REPO="$REPO" \
  bash "${ROOT}/scripts/geap/setup-gcp.sh" ${DRY_RUN:+--dry-run}

python3 "${ROOT}/scripts/geap/prepare-cloud-run-env.py" \
  --source-env "$SOURCE_ENV" \
  --output "$ENV_FILE" \
  --project-id "$PROJECT_ID" \
  --service-url "https://auto-trading-agent-cryptos-kcocml4nra-as.a.run.app"

IMG="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/agent:${TAG}"

if [ "$SKIP_BUILD" = 0 ]; then
  run docker build --platform linux/amd64 \
    -f "${ROOT}/Dockerfile.agentruntime" \
    --build-arg SERVER_BASE_URL= \
    --build-arg VITE_PUBLIC_ACCESS_MODE=1 \
    --build-arg VITE_APP_HOST_DOMAIN= \
    --build-arg VITE_COOKIE_DOMAIN= \
    -t "$IMG" \
    "$ROOT"
  run docker push "$IMG"
else
  if ! docker image inspect "$IMG" >/dev/null 2>&1; then
    echo "ABORT: local image ${IMG} not found; run without --skip-build" >&2
    exit 2
  fi
  run docker push "$IMG"
fi

DEPLOY_ARGS=(
  --image "$IMG"
  --region "$REGION"
  --service-account "$RUNTIME_SA"
  --execution-environment gen2
  --memory 16Gi
  --cpu 4
  --no-cpu-throttling
  --timeout 3600
  --allow-unauthenticated
  --env-vars-file "$ENV_FILE"
  --port 8080
)

run gcloud run deploy "$SERVICE" "${DEPLOY_ARGS[@]}"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT_ID" --format='value(status.url)')"
echo ""
echo "Service URL: ${URL}"
echo "Frontend + backend: open ${URL} in a browser (SPA is served from the same container)."
echo ""
echo "No custom domain required. Map one later with: gcloud run domain-mappings create"
