import * as cdk from "aws-cdk-lib";
import * as cw from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";

export interface TradingAlarmsStackProps extends cdk.StackProps {
    readonly metricNamespace: string;
    readonly alarmTopicArn: string;
    readonly envLabel: string;
}

/**
 * §6.5 — alarms. Each fires off a `[Trading]`-derived metric filter from
 * {@link TradingMetricsStack}. Severity:
 *
 *  - Paging (`P1`): FailClosed (any), IdempotencyCollision (any),
 *    UnknownStateBacklog (>10 OR aged >60s), KillSwitchActivation (any).
 *  - Ticket (`P2`): WSDisconnectRateHigh, ReconciliationFailureRate,
 *    VenueLatencyP99, RiskBlockSpike (anomaly-detected).
 *
 * The CDK code intentionally avoids hardcoding action ARNs; the topic is
 * passed in via `CW_ALARM_TOPIC_ARN`.
 */
export class TradingAlarmsStack extends cdk.Stack {
    private readonly alarmPrefix: string;
    constructor(scope: Construct, id: string, props: TradingAlarmsStackProps) {
        super(scope, id, props);

        const ns = props.metricNamespace;
        // Env-scope every alarm name. AWS alarm names are account+region
        // scoped, not stack-scoped, so a bare `Trading/${name}` from the
        // staging stack would clash with the prod-owned alarm of the same
        // name and `cdk deploy` would fail at CREATE_FAILED. The envLabel
        // suffix keeps staging/prod alarms independent, mirroring the
        // metric-namespace convention (`Trading-${envLabel}`).
        this.alarmPrefix = `Trading-${props.envLabel}/`;
        const topic = sns.Topic.fromTopicArn(this, "AlarmTopic", props.alarmTopicArn);
        const action = new cwActions.SnsAction(topic);

        const sum = (name: string, dims?: Record<string, string>): cw.Metric =>
            new cw.Metric({
                namespace: ns,
                metricName: name,
                statistic: "Sum",
                period: cdk.Duration.minutes(1),
                dimensionsMap: dims,
            });

        const p = (name: string, stat: string, dims?: Record<string, string>): cw.Metric =>
            new cw.Metric({
                namespace: ns,
                metricName: name,
                statistic: stat,
                period: cdk.Duration.minutes(5),
                dimensionsMap: dims,
            });

        // ---- P1 paging alarms ------------------------------------------
        this.alarm("FailClosedActivation", sum("FailClosed"), 1, action, {
            description:
                "Any fail-closed activation. Live trades are being refused; investigate dep health immediately.",
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
        });

        this.alarm("IdempotencyCollision", sum("IdempotencyHits"), 1, action, {
            description:
                "Pre-submit dedup gate fired. Investigate retry storm or duplicate user click.",
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
        });

        this.alarm("UnknownStateBacklog", sum("UnknownStateOrders"), 10, action, {
            description: "More than 10 unknown-state orders in 5 minutes.",
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
            statisticPeriod: cdk.Duration.minutes(5),
            comparison: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        });

        this.alarm("KillSwitchActivation", sum("KillSwitchActivations"), 1, action, {
            description: "Kill-switch flipped ON by a user. Notify on-call.",
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
        });

        // ---- P2 ticket-only alarms -------------------------------------
        const wsDisconnects = new cw.MathExpression({
            expression: "m1 + m2",
            usingMetrics: {
                m1: sum("WSDisconnects"),
                m2: sum("WSDisconnectsCoinbase"),
            },
            period: cdk.Duration.minutes(5),
            label: "WS disconnects (Binance + Coinbase)",
        });
        this.alarm("WSDisconnectRateHigh", wsDisconnects, 5, action, {
            description:
                "WS disconnects > 5 in 5m. Reconciliation drifts to REST fallback — expected lag rises.",
            evaluationPeriods: 2,
            datapointsToAlarm: 2,
        });

        this.alarm("VenueLatencyP99", p("VenueCallLatencyMs", "p99"), 5000, action, {
            description: "Venue call P99 > 5s. Likely venue degradation.",
            evaluationPeriods: 3,
            datapointsToAlarm: 3,
        });

        this.alarm(
            "ReconciliationFailureRate",
            sum("OrderErrors"),
            10,
            action,
            {
                description: "Order errors > 10 in 5m.",
                evaluationPeriods: 2,
                datapointsToAlarm: 2,
            },
        );

        // Risk-block spike. Static threshold for v1; swap for CW anomaly
        // detection (MathExpression with ANOMALY_DETECTION_BAND) once we
        // have a baseline of normal block volume.
        this.alarm("RiskBlockSpike", sum("RiskBlocks"), 10, action, {
            description: "More than 10 risk-engine blocks in 5 minutes.",
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
            statisticPeriod: cdk.Duration.minutes(5),
        });

        this.alarm("PromptInjectionSpike", sum("PromptInjectionDetected"), 3, action, {
            description: "Prompt-injection detector fired 3+ times in 5m.",
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
            statisticPeriod: cdk.Duration.minutes(5),
        });

        this.alarm("TimeoutSpike", sum("Timeouts"), 5, action, {
            description: "5+ timeouts in 5m (likely ADK / venue / mongo issue).",
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
            statisticPeriod: cdk.Duration.minutes(5),
        });

        // ---- F5 — reconciliation auto-downgrade (P1) ------------------
        // The auto-downgrade hook flips a user to runtime_lock=read_only
        // because their CEX creds couldn't be resolved for ~5 min. Every
        // hit means a customer-impacting state — page.
        this.alarm("ReconciliationAutoDowngrade", sum("ReconciliationDowngrades"), 1, action, {
            description:
                "Reconciliation auto-downgrade fired — a user's CEX creds were unresolvable for 60 consecutive poll cycles; they're now in 15-min read-only lock.",
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
        });

        // ---- F1 — paper-badge regression (P2) -------------------------
        // The deterministic post-check prefixes the badge mechanically
        // when the formatter SLM forgets it. Low-volume baseline; a
        // spike means the SLM has regressed on the badge contract.
        this.alarm("MechanicalBadgePrefixSpike", sum("MechanicalBadgeApplied"), 3, action, {
            description:
                "F1 mechanical badge prefix fired 3+ times in 5m — formatter SLM may be regressing on the paper/shadow badge contract.",
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
            statisticPeriod: cdk.Duration.minutes(5),
        });

        // ---- Schema-regression guard (P1) -----------------------------
        // Any order_submit event missing $.stake means a code refactor
        // dropped a load-bearing field. Page so a deploy doesn't soak
        // for hours without anyone noticing the dashboards went blind.
        this.alarm("OrderSubmitMissingStakeRegression", sum("OrderSubmitMissingStake"), 1, action, {
            description:
                "An order_submit event arrived without $.stake set. The audit schema has regressed; CloudWatch dashboards relying on stake will go blind. Investigate the most recent deploy immediately.",
            evaluationPeriods: 1,
            datapointsToAlarm: 1,
        });
    }

    private alarm(
        name: string,
        metric: cw.IMetric,
        threshold: number,
        action: cwActions.SnsAction,
        opts: {
            description: string;
            evaluationPeriods: number;
            datapointsToAlarm: number;
            comparison?: cw.ComparisonOperator;
            statisticPeriod?: cdk.Duration;
        },
    ): cw.Alarm {
        const alarm = new cw.Alarm(this, name, {
            alarmName: `${this.alarmPrefix}${name}`,
            alarmDescription: opts.description,
            metric:
                opts.statisticPeriod && metric instanceof cw.Metric
                    ? metric.with({ period: opts.statisticPeriod })
                    : metric,
            threshold,
            evaluationPeriods: opts.evaluationPeriods,
            datapointsToAlarm: opts.datapointsToAlarm,
            comparisonOperator:
                opts.comparison ?? cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cw.TreatMissingData.NOT_BREACHING,
            actionsEnabled: true,
        });
        alarm.addAlarmAction(action);
        return alarm;
    }
}
