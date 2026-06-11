#!/usr/bin/env bash
#
# GEAP side-environment GCP setup (§2): enable APIs, create the dedicated Artifact Registry repo,
# configure docker auth, and grant the runtime service account trace-write + Vertex access.
# Idempotent. NOT the AWS path. Run `gcloud auth login` + `gcloud auth application-default login`
# yourself first (interactive). See scripts/geap/README.md.
#
# Usage:
#   PROJECT_ID=my-proj RUNTIME_SA=sa@my-proj.iam.gserviceaccount.com \
#     scripts/geap/setup-gcp.sh [--region us-central1] [--dry-run]
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-us-central1}"
RUNTIME_SA="${RUNTIME_SA:-}"
REPO="${REPO:-senti-agent-geap}"
DRY_RUN=0

usage() { sed -n '2,14p' "$0"; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT_ID="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --sa) RUNTIME_SA="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown arg: $1" >&2; usage 2 ;;
  esac
done

[ -n "$PROJECT_ID" ] || { echo "ABORT: PROJECT_ID is required (env or --project)." >&2; exit 2; }
[ -n "$RUNTIME_SA" ] || { echo "ABORT: RUNTIME_SA is required (env or --sa)." >&2; exit 2; }

run() { echo "+ $*"; [ "$DRY_RUN" = 1 ] || "$@"; }

echo "=== GEAP GCP setup (project=${PROJECT_ID} region=${REGION}) ==="

run gcloud config set project "$PROJECT_ID"

run gcloud services enable \
  aiplatform.googleapis.com \
  cloudtrace.googleapis.com \
  artifactregistry.googleapis.com \
  run.googleapis.com \
  storage.googleapis.com

# Artifact Registry repo — create only if absent (idempotent).
if [ "$DRY_RUN" = 1 ] || ! gcloud artifacts repositories describe "$REPO" --location "$REGION" >/dev/null 2>&1; then
  run gcloud artifacts repositories create "$REPO" \
    --repository-format=docker --location="$REGION" \
    --description="SentiEdge GEAP side-environment images (NOT the AWS/ECR path)"
else
  echo "  (Artifact Registry repo '${REPO}' in ${REGION} already exists — skipping create)"
fi

run gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

# Runtime SA: write traces + call Vertex (the CryptoTrader character uses modelProvider "google").
run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" --role="roles/cloudtrace.agent"
run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" --role="roles/aiplatform.user"

echo ""
echo "Done. Next: scripts/geap/deploy-cloud-run.sh (or test locally first — see README.md Phase 2)."
echo "Reminder: the OTel deps (§2) are already committed to packages/core/package.json on this branch."
