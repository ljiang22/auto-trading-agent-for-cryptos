#!/bin/bash
set -e

AWS_ACCOUNT=257455992712
REGION=ap-southeast-1
PROFILE=sentiedge-target
ECR_URI="${AWS_ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/sentiedge-agent"
CLUSTER=sentiedge-cluster
SERVICE=sentiedge-agent-staging
TASK_FAMILY=sentiedge-agent-staging

# Secrets Manager keys that must be sourced via secrets rather than plaintext env.
# Format: <ENV_VAR_NAME>=<secret name in Secrets Manager>
SECRET_BACKED_KEYS=(
  "EXCHANGE_TOKEN_ENCRYPTION_KEY=sentiedge/staging/EXCHANGE_TOKEN_ENCRYPTION_KEY"
)

# Plain-text env vars that must be present on the task definition. Idempotent:
# the registration step below upserts each — values are overwritten on every
# deploy so an operator-edited task def doesn't quietly drift from this file.
# Wave 1+2 autotrading safety vars. Defaults are also wired in code, but
# spelling them out here makes deploy-vs-prod diff trivially auditable.
PLAINTEXT_ENV_VARS=(
  "PAPER_ORDER_TTL_SECONDS=86400"
  "RECONCILIATION_UNRESOLVED_DOWNGRADE_AFTER=60"
  "CEX_DETERMINISTIC_BYPASS=true"
  # PR #236 feature flags. Default OFF in code; ON in staging so the
  # new safety / enrichment gates are exercised before they ship to
  # prod. Keep these ON until one full deploy cycle is green; then
  # flip prod via production-deploy.yml.
  "CEX_PLAN_TIME_VALIDATORS_ENABLED=true"
  "CEX_INTENT_CROSSCHECK_ENABLED=true"
  "CEX_CONFIRM_QUOTE_RECHECK_ENABLED=true"
  "CEX_APPROVAL_MODAL_ENRICHMENT_ENABLED=true"
)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"
git checkout staging && git pull origin staging
SHORT_SHA=$(git rev-parse --short HEAD)
echo "==> Deploying commit: $SHORT_SHA"

echo "==> Logging into ECR..."
aws ecr get-login-password --region $REGION --profile $PROFILE | \
  docker login --username AWS --password-stdin ${AWS_ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com

echo "==> Building & pushing linux/arm64 image via buildx (QEMU on x86_64 hosts)..."
# Cache strategy: `type=inline` embeds buildkit cache metadata into the
# pushed runtime image manifest itself. Subsequent builds pull
# `--cache-from ${ECR_URI}:staging` and get final-stage layer cache for
# free, with zero extra export step. We tried `type=registry,mode=max`
# (~4 GB separate buildcache tag) — it did populate, but the cache
# *export* step itself took ~8 min, exactly cancelling the ~8 min saved
# on pnpm install. Inline avoids that bottleneck. Caveat: inline does
# NOT cache intermediate builder-stage layers, so the very first build
# after a pnpm-lock change re-runs `pnpm install`; subsequent builds
# on unchanged lock should hit cache via the image manifest.
docker buildx build \
  --platform linux/arm64 \
  --cache-from "${ECR_URI}:staging" \
  --cache-from "${ECR_URI}:latest" \
  --cache-to type=inline \
  --build-arg VITE_ADMIN_EMAILS=jiang2015leon@gmail.com \
  -t "${ECR_URI}:staging" \
  -t "${ECR_URI}:staging-${SHORT_SHA}" \
  --push \
  .

echo "==> Fetching current task definition..."
aws ecs describe-task-definition \
  --task-definition $TASK_FAMILY \
  --region $REGION --profile $PROFILE \
  --query taskDefinition --output json > /tmp/td.json

echo "==> Resolving Secrets Manager ARNs for secret-backed env vars..."
SECRET_ARN_PAIRS=""
for entry in "${SECRET_BACKED_KEYS[@]}"; do
  env_name="${entry%%=*}"
  secret_name="${entry#*=}"
  arn=$(aws secretsmanager describe-secret \
    --secret-id "$secret_name" \
    --region $REGION --profile $PROFILE \
    --query 'ARN' --output text)
  if [ -z "$arn" ] || [ "$arn" = "None" ]; then
    echo "ERROR: could not resolve ARN for secret '$secret_name' (env var $env_name)" >&2
    exit 1
  fi
  echo "    $env_name -> $arn"
  SECRET_ARN_PAIRS="${SECRET_ARN_PAIRS}${env_name}=${arn}"$'\n'
done
export SECRET_ARN_PAIRS

PLAINTEXT_ENV_PAIRS=""
for entry in "${PLAINTEXT_ENV_VARS[@]}"; do
  PLAINTEXT_ENV_PAIRS="${PLAINTEXT_ENV_PAIRS}${entry}"$'\n'
done
export PLAINTEXT_ENV_PAIRS

echo "==> Registering new task definition revision..."
python3 - <<PYEOF
import json, os
td = json.load(open('/tmp/td.json'))
for k in ['taskDefinitionArn','revision','status','requiresAttributes',
          'compatibilities','registeredAt','registeredBy','deregisteredAt']:
    td.pop(k, None)
td['containerDefinitions'][0]['image'] = '${ECR_URI}:staging-${SHORT_SHA}'
td['runtimePlatform'] = {'cpuArchitecture': 'ARM64', 'operatingSystemFamily': 'LINUX'}

# Migrate any secret-backed env vars from containerDefinitions[0].environment
# to containerDefinitions[0].secrets, keyed by ARN resolved from Secrets Manager.
secret_pairs = {}
for line in os.environ.get('SECRET_ARN_PAIRS', '').splitlines():
    if '=' in line:
        name, arn = line.split('=', 1)
        secret_pairs[name.strip()] = arn.strip()

c = td['containerDefinitions'][0]
env = c.get('environment', []) or []
secrets = c.get('secrets', []) or []
existing_secret_names = {s['name'] for s in secrets}

c['environment'] = [e for e in env if e.get('name') not in secret_pairs]
for name, arn in secret_pairs.items():
    if name in existing_secret_names:
        for s in secrets:
            if s['name'] == name:
                s['valueFrom'] = arn
    else:
        secrets.append({'name': name, 'valueFrom': arn})
c['secrets'] = secrets

# Upsert plaintext env vars declared in PLAINTEXT_ENV_VARS. Overwrites
# the value on every deploy so a hand-edited task def can't drift.
plain_pairs = {}
for line in os.environ.get('PLAINTEXT_ENV_PAIRS', '').splitlines():
    if '=' in line:
        name, value = line.split('=', 1)
        plain_pairs[name.strip()] = value.strip()
existing_env_names = {e.get('name') for e in c['environment']}
for name, value in plain_pairs.items():
    if name in existing_env_names:
        for e in c['environment']:
            if e.get('name') == name:
                e['value'] = value
    else:
        c['environment'].append({'name': name, 'value': value})

json.dump(td, open('/tmp/td-new.json','w'))
PYEOF

NEW_ARN=$(aws ecs register-task-definition \
  --cli-input-json file:///tmp/td-new.json \
  --region $REGION --profile $PROFILE \
  --query 'taskDefinition.taskDefinitionArn' --output text)
echo "==> New task def: $NEW_ARN"

echo "==> Updating ECS service (desired-count 1, force new deployment)..."
aws ecs update-service \
  --cluster $CLUSTER \
  --service $SERVICE \
  --task-definition "$NEW_ARN" \
  --desired-count 1 \
  --force-new-deployment \
  --region $REGION --profile $PROFILE \
  --query 'service.{status:status,desired:desiredCount,taskDef:taskDefinition}' \
  --output json

echo "==> Waiting for rollout to reach steady state (this can take 5-10 min)..."
attempt=0
while true; do
  attempt=$((attempt + 1))
  INFO=$(aws ecs describe-services \
    --cluster $CLUSTER --services $SERVICE \
    --region $REGION --profile $PROFILE \
    --query 'services[0].{rollout:deployments[0].rolloutState,running:runningCount,desired:desiredCount}' \
    --output json 2>/dev/null)
  ROLLOUT=$(echo "$INFO" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('rollout','?'))")
  RUNNING=$(echo "$INFO" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('running','?'))")
  DESIRED=$(echo "$INFO" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('desired','?'))")
  TS=$(date '+%H:%M:%S')
  echo "[$TS] attempt=$attempt rolloutState=$ROLLOUT running=$RUNNING desired=$DESIRED"
  if [ "$ROLLOUT" = "COMPLETED" ] && [ "$RUNNING" = "$DESIRED" ]; then
    echo "==> DEPLOY_STABLE — service healthy at ${RUNNING}/${DESIRED} tasks"
    break
  fi
  if [ "$ROLLOUT" = "FAILED" ]; then
    echo "==> DEPLOY_FAILED — rollout state is FAILED"
    exit 1
  fi
  sleep 30
done

echo "==> Deploy complete! Image: ${ECR_URI}:staging-${SHORT_SHA}"
