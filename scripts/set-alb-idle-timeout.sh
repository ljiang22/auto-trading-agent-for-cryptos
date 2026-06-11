#!/bin/bash
# Bump the ALB idle timeout for the staging service so SSE streams and slow
# `/memories` responses do not get cut off as 504 Gateway Time-out.
#
# Default: 600 seconds. Override via `IDLE_TIMEOUT=300 ./scripts/set-alb-idle-timeout.sh`.
#
# Why: AWS ALB defaults to 60 s. Comprehensive analysis SSE streams, the CEX
# workflow approval flow (which keeps the SSE stream open while the user
# reviews order parameters), and large `/memories` calls can legitimately
# exceed the default while still progressing. AWS_SSE_DEPLOYMENT.md prescribes
# 600 s for SSE-bearing paths.

set -euo pipefail

REGION=${REGION:-ap-southeast-1}
PROFILE=${PROFILE:-sentiedge-target}
CLUSTER=${CLUSTER:-sentiedge-cluster}
SERVICE=${SERVICE:-sentiedge-agent-staging}
IDLE_TIMEOUT=${IDLE_TIMEOUT:-600}

if ! command -v aws >/dev/null 2>&1; then
    echo "ERROR: aws CLI not found in PATH" >&2
    exit 1
fi

echo "==> Resolving target group from ECS service..."
TG_ARN=$(aws ecs describe-services \
    --cluster "$CLUSTER" \
    --services "$SERVICE" \
    --region "$REGION" --profile "$PROFILE" \
    --query 'services[0].loadBalancers[0].targetGroupArn' \
    --output text)

if [ -z "$TG_ARN" ] || [ "$TG_ARN" = "None" ]; then
    echo "ERROR: could not resolve target group ARN for service $SERVICE in cluster $CLUSTER" >&2
    exit 1
fi
echo "    targetGroup=$TG_ARN"

echo "==> Resolving load balancer from target group..."
LB_ARN=$(aws elbv2 describe-target-groups \
    --target-group-arns "$TG_ARN" \
    --region "$REGION" --profile "$PROFILE" \
    --query 'TargetGroups[0].LoadBalancerArns[0]' \
    --output text)

if [ -z "$LB_ARN" ] || [ "$LB_ARN" = "None" ]; then
    echo "ERROR: target group $TG_ARN is not attached to any load balancer" >&2
    exit 1
fi
echo "    loadBalancer=$LB_ARN"

echo "==> Reading current idle timeout..."
CURRENT=$(aws elbv2 describe-load-balancer-attributes \
    --load-balancer-arn "$LB_ARN" \
    --region "$REGION" --profile "$PROFILE" \
    --query "Attributes[?Key=='idle_timeout.timeout_seconds'].Value | [0]" \
    --output text)
echo "    currentIdleTimeoutSeconds=$CURRENT"

if [ "$CURRENT" = "$IDLE_TIMEOUT" ]; then
    echo "==> Already at $IDLE_TIMEOUT s — nothing to do."
    exit 0
fi

echo "==> Setting idle_timeout.timeout_seconds=$IDLE_TIMEOUT..."
aws elbv2 modify-load-balancer-attributes \
    --load-balancer-arn "$LB_ARN" \
    --attributes "Key=idle_timeout.timeout_seconds,Value=$IDLE_TIMEOUT" \
    --region "$REGION" --profile "$PROFILE" \
    --query "Attributes[?Key=='idle_timeout.timeout_seconds']" \
    --output table

echo "==> Done. New idle timeout: ${IDLE_TIMEOUT}s on $LB_ARN"
