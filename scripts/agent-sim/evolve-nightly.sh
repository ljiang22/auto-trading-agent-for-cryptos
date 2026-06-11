#!/usr/bin/env bash
# GEAP §7 Auto-Evolution — optional nightly wrapper (OFF BY DEFAULT).
#
# This is NOT wired into any AWS CI workflow (preserving the guide's AWS-isolation contract). Enable
# it yourself via a local cron or the Claude Code `/schedule` routine, e.g.:
#   0 3 * * *  cd /path/to/senti-agent-0428 && scripts/agent-sim/evolve-nightly.sh >> /tmp/evolve.log 2>&1
#
# Prerequisites (operator-run, local-dev only):
#   1. A paper-mode agent is running on $EVOLVE_SERVER (see scripts/dev-auth.mjs: init/token/seed-trading)
#      with OTEL_TRACING_ENABLED=true and GOOGLE_CLOUD_PROJECT set so traces reach Cloud Trace.
#   2. .env carries: GOOGLE_VERTEX_PROJECT, GOOGLE_APPLICATION_CREDENTIALS_JSON (proposer),
#      MONGODB_CONNECTION_STRING + MONGODB_DATABASE (scratch agent shares the seeded paper user),
#      JWT_PUBLIC_KEY_B64 + SIM_JWT_PRIVATE_KEY_B64 (dev-auth keypair), GOOGLE_CLOUD_PROJECT (Cloud Trace).
#   3. ADC is configured for Cloud Trace reads (roles/cloudtrace.user).
#
# The loop is PROPOSE-ONLY: it writes tests/scenarios/evolve_<ts>.{patch,md} and never applies anything.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

EVOLVE_USER_EMAIL="${EVOLVE_USER_EMAIL:-${VITE_TEST_USER_EMAIL:-}}"
EVOLVE_SERVER="${EVOLVE_SERVER:-http://127.0.0.1:3000}"
EVOLVE_ROUNDS="${EVOLVE_ROUNDS:-2}"
EVOLVE_TARGETS="${EVOLVE_TARGETS:-system,config}"

if [ -z "$EVOLVE_USER_EMAIL" ]; then
  echo "[evolve-nightly] set EVOLVE_USER_EMAIL (the seeded paper-trading user)." >&2
  exit 2
fi

echo "[evolve-nightly] $(date -u +%FT%TZ) — server=$EVOLVE_SERVER targets=$EVOLVE_TARGETS rounds=$EVOLVE_ROUNDS"

pnpm evolve -- \
  --user-email "$EVOLVE_USER_EMAIL" \
  --server "$EVOLVE_SERVER" \
  --targets "$EVOLVE_TARGETS" \
  --rounds "$EVOLVE_ROUNDS"

LATEST_REPORT="$(ls -t tests/scenarios/evolve_*.md 2>/dev/null | head -1 || true)"
if [ -n "$LATEST_REPORT" ]; then
  echo "[evolve-nightly] report: $LATEST_REPORT"
fi
