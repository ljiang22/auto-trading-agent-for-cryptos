# Trading observability CDK app

Plan §6.5 / §6.6 — CloudWatch metric filters, dashboards, alarms, SLO burn-rate alarms keyed off the `[Trading]` JSON log lines.

## Stacks

- `TradingMetrics-<env>` — Metric filters on `[Trading]` lines.
- `TradingDashboard-<env>` — Single dashboard.
- `TradingAlarms-<env>` — P1 / P2 alarms (paging + ticket).
- `SloBurn-<env>` — Burn-rate alarms (1h / 6h windows).
- `ScheduledQaJobs-<env>` — Weekly chaos drills (§8.8), 3-day paper-soak (§8.10),
  hourly secrets scan (§8.4). One CodeBuild project + three EventBridge rules.

## Deploy

```bash
cd infra/cloudwatch
pnpm install
# Both envs share a single CW log group (`/ecs/sentiedge-agent`) and are
# distinguished by `awslogs-stream-prefix` at the ECS task-def level. The
# defaults below match the live task definitions; you only need to set
# these if your env differs.
# export CW_LOG_GROUP_NAME=/ecs/sentiedge-agent
# export CW_LOG_STREAM_PREFIX=staging   # "ecs" for prod
export CW_ALARM_TOPIC_ARN=arn:aws:sns:ap-southeast-1:<acct>:sentiedge-alarms-staging
npx cdk synth                # validate
npx cdk deploy --all --context env=staging
```

Promote to prod after 7 days of clean alarms (plan exit gate):

```bash
export CW_ALARM_TOPIC_ARN=arn:aws:sns:ap-southeast-1:<acct>:sentiedge-alarms-prod
# CW_LOG_STREAM_PREFIX defaults to "ecs" when --context env=prod.
npx cdk deploy --all --context env=prod
```

## Filter pattern conventions

All filters key off `[Trading] {"stage":"...","userId":"...",...}` JSON lines emitted by `packages/plugin-cex/src/observability/tradingEvents.ts`. The stage union must stay in sync with `TradingEventStage` — adding a new stage to the plugin without updating the CDK filters leaves the metric blind.

## Env vars

| Var | Purpose |
|-----|---------|
| `CW_LOG_GROUP_NAME` | The CloudWatch log group the ECS task writes to. Defaults to `/ecs/sentiedge-agent` (shared across envs). |
| `CW_LOG_STREAM_PREFIX` | Stream prefix that scopes the secrets-scan job to this env's logs only. Defaults to `ecs` for prod and `staging` for staging. |
| `CW_ALARM_TOPIC_ARN` | SNS topic that fans alarms to PagerDuty / Slack. |
| `CDK_DEFAULT_REGION` | Defaults to `ap-southeast-1`. |
| `QA_REPORT_BUCKET` | S3 bucket for chaos / paper-soak / secrets-scan reports. Defaults to `sentiedge2025`. |
| `QA_GITHUB_OWNER` | GitHub org / user. Defaults to `senti-edge`. |
| `QA_GITHUB_REPO` | GitHub repo. Defaults to `senti-agent-0428`. |
| `QA_GITHUB_BRANCH` | Branch the CodeBuild project clones each run. Defaults to `staging`. |

## ScheduledQaJobs stack

Three EventBridge rules dispatched to one CodeBuild project:

| Rule | Cron (UTC) | What runs |
|------|-----------|-----------|
| `WeeklyChaosDrills` | Sundays 12:00 | `scripts/chaos/{wsKillSoak,exchange5xxSoak,killSwitchDrill,failClosedDrill}.mjs` → `s3://$bucket/autotrading/chaos/` |
| `ThreeDayPaperSoak` | Every 3rd day 14:00 | `scripts/qa/paper-soak-runner.mjs` then `paper-soak-report.mjs` → `s3://$bucket/autotrading/paper-soak/` |
| `HourlySecretsScan` | Every hour at :00 | `scripts/qa/scan-secrets-in-cw.mjs --minutes 70` → `s3://$bucket/autotrading/secrets-scan/` |

Alarms:

- `PaperSoakStale-<env>` — fires if no QA-jobs build succeeded in the last 96 h (one missed paper-soak window).
- `SecretsScanFailures-<env>` — fires immediately on any QA-jobs failed build (most likely cause: `scan-secrets-in-cw.mjs` detected a leak and exited 1).

One-time setup before first deploy:

1. Authorize CodeBuild to access GitHub: `aws codebuild import-source-credentials --auth-type PERSONAL_ACCESS_TOKEN --server-type GITHUB --token <PAT>`.
2. Bucket `QA_REPORT_BUCKET` must already exist with `s3:PutObject` on `autotrading/*` allowed for the CodeBuild role.
3. SNS topic in `CW_ALARM_TOPIC_ARN` must already exist.

Deploy: same `npx cdk deploy --all --context env=<env>` as the other stacks — the new stack is wired into `bin/app.ts`.
