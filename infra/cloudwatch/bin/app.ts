#!/usr/bin/env node
/* eslint-disable no-new */
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { TradingMetricsStack } from "../lib/tradingMetricsStack";
import { TradingDashboardStack } from "../lib/tradingDashboardStack";
import { TradingAlarmsStack } from "../lib/tradingAlarmsStack";
import { SloBurnStack } from "../lib/sloBurnStack";
import { ScheduledQaJobsStack } from "../lib/scheduledQaJobsStack";

const app = new cdk.App();
const env = (app.node.tryGetContext("env") as string | undefined) ?? "staging";

// Both prod and staging containers stream into a SHARED CloudWatch log group
// (`/ecs/sentiedge-agent`) and are disambiguated by `awslogs-stream-prefix`
// at the ECS task-def level ("ecs" for prod, "staging" for staging). The
// earlier `/aws/ecs/sentiedge-agent[-staging]` defaults pointed at log
// groups that don't exist, so any stack relying on the default (e.g. the
// secrets-scan EventBridge job in ScheduledQaJobs-staging) was scanning
// thin air. See `CW_LOG_STREAM_PREFIX` for env-scoped filtering when
// needed.
const logGroupName = process.env.CW_LOG_GROUP_NAME ?? "/ecs/sentiedge-agent";
const logStreamPrefix =
    process.env.CW_LOG_STREAM_PREFIX ?? (env === "prod" ? "ecs" : "staging");
const alarmTopicArn =
    process.env.CW_ALARM_TOPIC_ARN ??
    `arn:aws:sns:ap-southeast-1:000000000000:sentiedge-alarms-${env}`;

const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION ?? "ap-southeast-1";
const stackEnv: cdk.Environment = { account, region };

const metrics = new TradingMetricsStack(app, `TradingMetrics-${env}`, {
    env: stackEnv,
    logGroupName,
    metricNamespace: "Trading",
    envLabel: env,
});

new TradingDashboardStack(app, `TradingDashboard-${env}`, {
    env: stackEnv,
    metricNamespace: "Trading",
    envLabel: env,
});

new TradingAlarmsStack(app, `TradingAlarms-${env}`, {
    env: stackEnv,
    metricNamespace: "Trading",
    alarmTopicArn,
    envLabel: env,
});

new SloBurnStack(app, `SloBurn-${env}`, {
    env: stackEnv,
    metricNamespace: "Trading",
    alarmTopicArn,
    envLabel: env,
});

new ScheduledQaJobsStack(app, `ScheduledQaJobs-${env}`, {
    env: stackEnv,
    envLabel: env,
    alarmTopicArn,
    logGroupName,
    logStreamPrefix,
    reportBucketName: process.env.QA_REPORT_BUCKET ?? "sentiedge2025",
    githubOwner: process.env.QA_GITHUB_OWNER ?? "senti-edge",
    githubRepo: process.env.QA_GITHUB_REPO ?? "senti-agent-0428",
    githubBranch: process.env.QA_GITHUB_BRANCH ?? "staging",
});

app.synth();
// Reference the metrics stack so cdk synth keeps its order deterministic.
void metrics;
