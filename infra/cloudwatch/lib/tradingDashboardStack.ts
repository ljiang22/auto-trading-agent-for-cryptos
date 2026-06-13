import * as cdk from "aws-cdk-lib";
import * as cw from "aws-cdk-lib/aws-cloudwatch";
import type { Construct } from "constructs";

export interface TradingDashboardStackProps extends cdk.StackProps {
    readonly metricNamespace: string;
    readonly envLabel: string;
}

/**
 * §6.5 — single dashboard for the trading subsystem. Designed so an on-call
 * engineer can answer "is something broken right now?" in <30 s.
 */
export class TradingDashboardStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: TradingDashboardStackProps) {
        super(scope, id, props);

        const ns = props.metricNamespace;
        const dashboard = new cw.Dashboard(this, "TradingDashboard", {
            dashboardName: `Trading-${props.envLabel}`,
        });

        const sum = (name: string, dims?: Record<string, string>): cw.Metric =>
            new cw.Metric({
                namespace: ns,
                metricName: name,
                statistic: "Sum",
                period: cdk.Duration.minutes(5),
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

        dashboard.addWidgets(
            new cw.SingleValueWidget({
                title: "Fail-closed (last 5m)",
                metrics: [sum("FailClosed")],
                width: 6,
            }),
            new cw.SingleValueWidget({
                title: "Kill-switch activations",
                metrics: [sum("KillSwitchActivations")],
                width: 6,
            }),
            new cw.SingleValueWidget({
                title: "Idempotency hits",
                metrics: [sum("IdempotencyHits")],
                width: 6,
            }),
            new cw.SingleValueWidget({
                title: "UNKNOWN-state orders",
                metrics: [sum("UnknownStateOrders")],
                width: 6,
            }),
        );

        dashboard.addWidgets(
            new cw.GraphWidget({
                title: "Risk decisions / 5m (block + downgrade)",
                left: [sum("RiskBlocks"), sum("RiskDowngrades")],
                width: 12,
                height: 6,
            }),
            new cw.GraphWidget({
                title: "Submit vs ack rate",
                left: [sum("SubmitRate"), sum("AckRate"), sum("OrderErrors")],
                width: 12,
                height: 6,
            }),
        );

        dashboard.addWidgets(
            new cw.GraphWidget({
                title: "Venue call P50 / P95 / P99 (ms)",
                left: [
                    p("VenueCallLatencyMs", "p50"),
                    p("VenueCallLatencyMs", "p95"),
                    p("VenueCallLatencyMs", "p99"),
                ],
                width: 12,
                height: 6,
            }),
            new cw.GraphWidget({
                title: "Reconciliation lag P50 / P95 (ms)",
                left: [
                    p("ReconciliationLatencyMs", "p50"),
                    p("ReconciliationLatencyMs", "p95"),
                ],
                width: 12,
                height: 6,
            }),
        );

        dashboard.addWidgets(
            new cw.GraphWidget({
                title: "Approval decisions",
                left: [sum("ApprovalApproved"), sum("ApprovalRejected")],
                width: 12,
                height: 6,
            }),
            new cw.GraphWidget({
                title: "Prompt injection / Timeouts / WS disconnects",
                left: [
                    sum("PromptInjectionDetected"),
                    sum("Timeouts"),
                    sum("WSDisconnects"),
                    sum("WSDisconnectsCoinbase"),
                ],
                width: 12,
                height: 6,
            }),
        );
    }
}
