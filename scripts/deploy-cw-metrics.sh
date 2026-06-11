#!/usr/bin/env bash
# §6.5 — deploy the CloudWatch trading-metrics CDK app.
#
# Usage:
#   scripts/deploy-cw-metrics.sh staging
#   scripts/deploy-cw-metrics.sh prod
#
# Requires:
#   - AWS credentials with permission to create log-group metric filters,
#     CloudWatch alarms / dashboards, and read the SNS topic.
#   - Env vars: CW_LOG_GROUP_NAME, CW_ALARM_TOPIC_ARN.

set -euo pipefail

ENV_LABEL="${1:-staging}"
if [[ "$ENV_LABEL" != "staging" && "$ENV_LABEL" != "prod" ]]; then
    echo "usage: $0 [staging|prod]" >&2
    exit 2
fi

if [[ -z "${CW_LOG_GROUP_NAME:-}" ]]; then
    echo "CW_LOG_GROUP_NAME must be set" >&2
    exit 2
fi
if [[ -z "${CW_ALARM_TOPIC_ARN:-}" ]]; then
    echo "CW_ALARM_TOPIC_ARN must be set" >&2
    exit 2
fi

cd "$(dirname "$0")/../infra/cloudwatch"

if [[ ! -d node_modules ]]; then
    pnpm install
fi

npx cdk synth >/dev/null
npx cdk deploy --all --context "env=${ENV_LABEL}" --require-approval never
