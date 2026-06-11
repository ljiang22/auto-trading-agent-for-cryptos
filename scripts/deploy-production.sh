#!/bin/bash
set -e

AWS_ACCOUNT=257455992712
REGION=ap-southeast-1
PROFILE=sentiedge-target
ECR_URI="${AWS_ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/sentiedge-agent"
CLUSTER=sentiedge-cluster
SERVICE=sentiedge-agent
TASK_FAMILY=sentiedge-agent

# Secrets Manager keys that must be sourced via secrets rather than plaintext env.
# Format: <ENV_VAR_NAME>=<secret name in Secrets Manager>
SECRET_BACKED_KEYS=(
  "EXCHANGE_TOKEN_ENCRYPTION_KEY=sentiedge/production/EXCHANGE_TOKEN_ENCRYPTION_KEY"
)

# Plain-text env vars upserted into the task definition every deploy.
# Defaults are also wired in code; declaring them here keeps the deploy
# state auditable and prevents drift from hand edits in the AWS console.
PLAINTEXT_ENV_VARS=(
  "PAPER_ORDER_TTL_SECONDS=86400"
  "RECONCILIATION_UNRESOLVED_DOWNGRADE_AFTER=60"
  "CEX_DETERMINISTIC_BYPASS=true"
)

cd ~/senti-agent-0428
git checkout main && git pull origin main
SHORT_SHA=$(git rev-parse --short HEAD)
echo "==> Deploying commit: $SHORT_SHA"

echo "==> Logging into ECR..."
aws ecr get-login-password --region $REGION --profile $PROFILE | \
  docker login --username AWS --password-stdin ${AWS_ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com

echo "==> Building & pushing linux/arm64 image via buildx (QEMU on x86_64 hosts)..."
docker buildx build \
  --platform linux/arm64 \
  --cache-from ${ECR_URI}:latest \
  --cache-from ${ECR_URI}:staging \
  --build-arg VITE_ADMIN_EMAILS=jiang2015leon@gmail.com \
  --build-arg VITE_APP_HOST_DOMAIN=https://agent.sentiedge.ai \
  --build-arg VITE_COOKIE_DOMAIN=agent.sentiedge.ai \
  -t "${ECR_URI}:latest" \
  -t "${ECR_URI}:main-${SHORT_SHA}" \
  --push \
  .

echo "==> Fetching current task definition..."
aws ecs describe-task-definition \
  --task-definition $TASK_FAMILY \
  --region $REGION --profile $PROFILE \
  --query taskDefinition --output json > /tmp/td-prod.json

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
td = json.load(open('/tmp/td-prod.json'))
for k in ['taskDefinitionArn','revision','status','requiresAttributes',
          'compatibilities','registeredAt','registeredBy','deregisteredAt']:
    td.pop(k, None)
td['containerDefinitions'][0]['image'] = '${ECR_URI}:main-${SHORT_SHA}'
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

# Upsert plaintext env vars from PLAINTEXT_ENV_VARS. Overwrites on every
# deploy so a hand-edited task def can't silently drift away from this
# config-as-code source of truth.
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

json.dump(td, open('/tmp/td-prod-new.json','w'))
PYEOF

NEW_ARN=$(aws ecs register-task-definition \
  --cli-input-json file:///tmp/td-prod-new.json \
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

echo "==> Deploy complete! Image: ${ECR_URI}:main-${SHORT_SHA}"
