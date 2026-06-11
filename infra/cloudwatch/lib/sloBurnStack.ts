import * as cdk from "aws-cdk-lib";
import * as cw from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";

export interface SloBurnStackProps extends cdk.StackProps {
    readonly metricNamespace: string;
    readonly alarmTopicArn: string;
    readonly envLabel: string;
}

/**
 * §6.6 — SLO burn-rate alarms.
 *
 * SLOs:
 *  - risk_decision_persistence: 99.9% within 500ms.
 *      Surrogate: `FailClosed` count vs `RiskBlocks + RiskDowngrades + ApprovalApproved`
 *      (the FailClosed branch is the only path where audit-persistence missed).
 *  - reconciliation_convergence: 99.9% terminal ≤ 60s.
 *      Surrogate: ReconciliationLatencyMs p99 > 60000ms.
 *  - venue_call_success: 99.5% non-5xx (OrderErrors / SubmitRate).
 *  - no_duplicate_submits: 100% (IdempotencyHits ≥ 1 → page).
 *
 * Burn-rate buckets:
 *  - 2% of 30-day budget consumed in 1 hour → page.
 *  - 10% of 30-day budget consumed in 6 hours → ticket.
 */
export class SloBurnStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: SloBurnStackProps) {
        super(scope, id, props);

        const ns = props.metricNamespace;
        const topic = sns.Topic.fromTopicArn(this, "AlarmTopic", props.alarmTopicArn);
        const action = new cwActions.SnsAction(topic);

        const m = (name: string, stat: string, period: cdk.Duration): cw.Metric =>
            new cw.Metric({
                namespace: ns,
                metricName: name,
                statistic: stat,
                period,
            });

        // ---- venue_call_success burn ----------------------------------
        //   error_ratio = OrderErrors / SubmitRate
        const orderErrors1h = m("OrderErrors", "Sum", cdk.Duration.hours(1));
        const submits1h = m("SubmitRate", "Sum", cdk.Duration.hours(1));
        const errorRatio1h = new cw.MathExpression({
            expression: "IF(submits > 0, errors / submits, 0)",
            usingMetrics: { errors: orderErrors1h, submits: submits1h },
            period: cdk.Duration.hours(1),
            label: "VenueErrorRatio1h",
        });
        // SLO 99.5% → budget = 0.5%; 2%-of-budget-per-hour ≈ 0.01% error rate
        new cw.Alarm(this, "VenueSuccessBurnFast", {
            alarmName: `Trading/SloBurn/VenueSuccess-Fast`,
            alarmDescription:
                "venue_call_success burning >2% of 30d budget in 1h → page.",
            metric: errorRatio1h,
            threshold: 0.0001,
            evaluationPeriods: 1,
            comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        }).addAlarmAction(action);

        const orderErrors6h = m("OrderErrors", "Sum", cdk.Duration.hours(6));
        const submits6h = m("SubmitRate", "Sum", cdk.Duration.hours(6));
        const errorRatio6h = new cw.MathExpression({
            expression: "IF(submits > 0, errors / submits, 0)",
            usingMetrics: { errors: orderErrors6h, submits: submits6h },
            period: cdk.Duration.hours(6),
            label: "VenueErrorRatio6h",
        });
        new cw.Alarm(this, "VenueSuccessBurnSlow", {
            alarmName: `Trading/SloBurn/VenueSuccess-Slow`,
            alarmDescription:
                "venue_call_success burning >10% of 30d budget in 6h → ticket.",
            metric: errorRatio6h,
            threshold: 0.0001,
            evaluationPeriods: 1,
            comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        }).addAlarmAction(action);

        // ---- reconciliation_convergence burn --------------------------
        new cw.Alarm(this, "ReconciliationP99TooSlow", {
            alarmName: `Trading/SloBurn/ReconciliationP99`,
            alarmDescription:
                "Reconciliation p99 > 60s; convergence SLO at risk.",
            metric: new cw.Metric({
                namespace: ns,
                metricName: "ReconciliationLatencyMs",
                statistic: "p99",
                period: cdk.Duration.minutes(5),
            }),
            threshold: 60_000,
            evaluationPeriods: 3,
            comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        }).addAlarmAction(action);

        // ---- no_duplicate_submits — strict 100% SLO -------------------
        new cw.Alarm(this, "NoDuplicateSubmits", {
            alarmName: `Trading/SloBurn/NoDuplicateSubmits`,
            alarmDescription:
                "Any duplicate-submit gate fire is an SLO breach. Page.",
            metric: m("IdempotencyHits", "Sum", cdk.Duration.minutes(5)),
            threshold: 0,
            evaluationPeriods: 1,
            comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        }).addAlarmAction(action);

        new cdk.CfnOutput(this, "EnvLabel", { value: props.envLabel });
    }
}
