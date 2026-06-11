import * as cdk from "aws-cdk-lib";
import * as cb from "aws-cdk-lib/aws-codebuild";
import * as cw from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";

export interface ScheduledQaJobsStackProps extends cdk.StackProps {
    readonly envLabel: string;
    readonly alarmTopicArn: string;
    /**
     * S3 bucket that receives chaos / paper-soak / secrets-scan reports.
     * Pre-existing bucket (we don't manage its lifecycle here — the trading
     * data bucket already exists and has its own retention policy).
     */
    readonly reportBucketName: string;
    /**
     * GitHub source repo for the CodeBuild project. CodeBuild clones it on
     * each run so the scripts under `scripts/qa/` and `scripts/chaos/` are
     * always fresh from `origin/staging`.
     */
    readonly githubOwner: string;
    readonly githubRepo: string;
    readonly githubBranch: string;
    /**
     * Shared CloudWatch log group for both staging and prod agent
     * containers (`/ecs/sentiedge-agent`). The secrets-scan job filters by
     * stream prefix below to keep envs isolated.
     */
    readonly logGroupName: string;
    /**
     * CloudWatch log stream prefix that scopes the secrets-scan job to this
     * env's logs only (`"ecs"` for prod, `"staging"` for staging).
     */
    readonly logStreamPrefix: string;
}

/**
 * §8.4 + §8.8 + §8.10 — scheduled QA / chaos / paper-soak runners.
 *
 * One stack, three EventBridge schedules, one CodeBuild project:
 *
 *  - **Weekly chaos drills** (Sunday 12:00 UTC): runs the four
 *    chaos scripts in `scripts/chaos/` and uploads each JSON result to
 *    `s3://<bucket>/autotrading/chaos/`.
 *  - **3-day paper-soak** (every 3rd day at 14:00 UTC): runs
 *    `scripts/qa/paper-soak-runner.mjs` then `paper-soak-report.mjs` and
 *    uploads to `s3://<bucket>/autotrading/paper-soak/`.
 *  - **Hourly secrets scan** (top of each hour): runs
 *    `scripts/qa/scan-secrets-in-cw.mjs` with a 70-min lookback window
 *    (10 min slack so a missed minute doesn't slip through), uploads
 *    to `s3://<bucket>/autotrading/secrets-scan/`, and pages on any hit
 *    via CloudWatch alarm on the project's failure count.
 *
 * Alarms:
 *  - `PaperSoakStale-<env>`: no new key under `autotrading/paper-soak/`
 *    in > 96h (paper-soak job has missed at least one window).
 *  - `SecretsScanFailures-<env>`: any failed build of the secrets-scan
 *    rule pages immediately (exit 1 = leak detected).
 *
 * Why CodeBuild and not Lambda / ECS RunTask:
 *  - Lambda 15-min cap rules out the multi-day paper-soak runner.
 *  - ECS RunTask works but requires a tailored container image; CodeBuild
 *    on a managed image installs node + pnpm + the repo on every run, which
 *    keeps "what code did the cron actually run" answerable from
 *    CommitSHA in the build log.
 */
export class ScheduledQaJobsStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: ScheduledQaJobsStackProps) {
        super(scope, id, props);

        const bucket = s3.Bucket.fromBucketName(this, "ReportBucket", props.reportBucketName);
        const topic = sns.Topic.fromTopicArn(this, "AlarmTopic", props.alarmTopicArn);
        const action = new cwActions.SnsAction(topic);

        const project = new cb.Project(this, "QaJobsProject", {
            projectName: `senti-qa-jobs-${props.envLabel}`,
            source: cb.Source.gitHub({
                owner: props.githubOwner,
                repo: props.githubRepo,
                branchOrRef: props.githubBranch,
                cloneDepth: 1,
            }),
            environment: {
                buildImage: cb.LinuxBuildImage.STANDARD_7_0,
                computeType: cb.ComputeType.SMALL,
                privileged: false,
                environmentVariables: {
                    REPORT_BUCKET: { value: props.reportBucketName },
                    AWS_REGION: { value: this.region },
                    NODE_OPTIONS: { value: "--max-old-space-size=4096" },
                },
            },
            timeout: cdk.Duration.hours(36),
            queuedTimeout: cdk.Duration.hours(1),
            buildSpec: cb.BuildSpec.fromObject({
                version: "0.2",
                env: {
                    "git-credential-helper": "yes",
                },
                phases: {
                    install: {
                        "runtime-versions": { nodejs: "20" },
                        commands: [
                            "npm install -g pnpm@9.15.7",
                            "pnpm install --frozen-lockfile --filter '!docs'",
                        ],
                    },
                    build: {
                        commands: [
                            'echo "Running QA job: ${QA_JOB:-unknown}"',
                            "case \"$QA_JOB\" in chaos) bash -lc 'for f in scripts/chaos/*.mjs; do node \"$f\" > /tmp/$(basename $f .mjs).json; aws s3 cp /tmp/$(basename $f .mjs).json s3://$REPORT_BUCKET/autotrading/chaos/$(basename $f .mjs)-$(date -u +%Y-%m-%dT%H-%M-%SZ).json; done' ;; paper-soak) node scripts/qa/paper-soak-runner.mjs && node scripts/qa/paper-soak-report.mjs --report-s3 s3://$REPORT_BUCKET/autotrading/paper-soak/ ;; secrets-scan) node scripts/qa/scan-secrets-in-cw.mjs --log-group \"$CW_LOG_GROUP\" ${CW_LOG_STREAM_PREFIX:+--stream-prefix \"$CW_LOG_STREAM_PREFIX\"} --minutes 70 --region $AWS_REGION --report-s3 s3://$REPORT_BUCKET/autotrading/secrets-scan/ ;; *) echo \"Unknown QA_JOB: $QA_JOB\"; exit 2 ;; esac",
                        ],
                    },
                },
            }),
        });

        // Allow the CodeBuild role to read CW logs (secrets-scan) and write to S3.
        project.role?.addToPrincipalPolicy(
            new iam.PolicyStatement({
                actions: ["logs:FilterLogEvents", "logs:DescribeLogGroups"],
                resources: ["*"],
            }),
        );
        bucket.grantPut(project.role!, "autotrading/*");

        // ── Schedules ────────────────────────────────────────────────────

        const cwLogGroup = props.logGroupName;
        const cwLogStreamPrefix = props.logStreamPrefix;

        // §8.8 — weekly chaos drills (Sundays 12:00 UTC).
        new events.Rule(this, "WeeklyChaosDrills", {
            schedule: events.Schedule.cron({ minute: "0", hour: "12", weekDay: "SUN" }),
            description: "Weekly chaos drill: wsKillSoak, exchange5xxSoak, killSwitchDrill, failClosedDrill.",
            targets: [
                new targets.CodeBuildProject(project, {
                    event: events.RuleTargetInput.fromObject({
                        environmentVariablesOverride: [
                            { name: "QA_JOB", value: "chaos", type: "PLAINTEXT" },
                        ],
                    }),
                }),
            ],
        });

        // §8.10 — 3-day paper-soak is a launch-readiness gate, not a recurring
        // operational job. Trigger manually before flipping live mode on:
        //   aws codebuild start-build \
        //     --project-name senti-qa-jobs-<env> \
        //     --environment-variables-override \
        //       name=QA_JOB,value=paper-soak,type=PLAINTEXT \
        //       name=SOAK_DAYS,value=3,type=PLAINTEXT \
        //       name=SOAK_TICK_MS,value=20000,type=PLAINTEXT
        // With TICKS_PER_DAY=1440 + SOAK_TICK_MS=20000, the build runs ~24h
        // wall-clock for 3 simulated days, inside CodeBuild's 36h cap.

        // §8.4 — hourly secrets-scan against the agent's CW log group.
        new events.Rule(this, "HourlySecretsScan", {
            schedule: events.Schedule.cron({ minute: "0" }),
            description: "Hourly grep of CloudWatch for forbidden API-key / signature patterns.",
            targets: [
                new targets.CodeBuildProject(project, {
                    event: events.RuleTargetInput.fromObject({
                        environmentVariablesOverride: [
                            { name: "QA_JOB", value: "secrets-scan", type: "PLAINTEXT" },
                            { name: "CW_LOG_GROUP", value: cwLogGroup, type: "PLAINTEXT" },
                            { name: "CW_LOG_STREAM_PREFIX", value: cwLogStreamPrefix, type: "PLAINTEXT" },
                        ],
                    }),
                }),
            ],
        });

        // ── Alarms ───────────────────────────────────────────────────────

        // (Paper-soak staleness alarm removed: the 3-day soak is now a one-shot
        // manual launch-gate build, not a recurring schedule, so SucceededBuilds=0
        // is the steady-state — alarming on it would page constantly.)

        // Secrets-scan: alarm on the FailedBuilds count (exit 1 = leak detected).
        const secretsScanFailed = new cw.Metric({
            namespace: "AWS/CodeBuild",
            metricName: "FailedBuilds",
            statistic: "Sum",
            period: cdk.Duration.minutes(60),
            dimensionsMap: { ProjectName: project.projectName },
        });
        new cw.Alarm(this, "SecretsScanFailures", {
            alarmName: `SecretsScanFailures-${props.envLabel}`,
            metric: secretsScanFailed,
            threshold: 1,
            comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
            treatMissingData: cw.TreatMissingData.NOT_BREACHING,
            alarmDescription:
                "A QA-jobs CodeBuild run failed in the last hour. Most likely cause: scan-secrets-in-cw.mjs detected a leak (exit 1). Inspect the build log immediately.",
        }).addAlarmAction(action);
    }
}
