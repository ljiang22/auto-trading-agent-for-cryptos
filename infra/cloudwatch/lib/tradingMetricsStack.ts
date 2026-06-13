import * as cdk from "aws-cdk-lib";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

export interface TradingMetricsStackProps extends cdk.StackProps {
    readonly logGroupName: string;
    readonly metricNamespace: string;
    readonly envLabel: string;
}

/**
 * §6.5 — CloudWatch metric filters keyed off the `[Trading]` JSON shape.
 *
 * Each filter pattern uses the JSON-quoted form so it matches our actual
 * log line: `[Trading] {"stage":"X",...}`. The "[Trading]" string prefix is
 * preserved verbatim by Node's logger formatter, and the JSON body follows.
 *
 * Filter rationale (plan §6.5):
 *  - `RiskBlocks` dimensioned by `rules_fired[0]` — primary observable for
 *    the kill-switch / max-size / blocklist branches.
 *  - `FailClosed` — every refused live write (audit-sink down, etc.). One
 *    paging alarm; should be rare.
 *  - `UnknownStateOrders` — counts new UNKNOWN ledger rows (any age).
 *  - `IdempotencyHits` — pre-submit dedup short-circuits.
 *  - `KillSwitchActivations`, `PromptInjectionDetected`, `Timeouts` —
 *    self-explanatory.
 *  - `VenueCallLatency` — emit_value=$.latency_ms scoped to stage=venue_call.
 *  - `SubmitRate`, `AckRate`, `OrderErrors` — order-lifecycle volume.
 */
export class TradingMetricsStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: TradingMetricsStackProps) {
        super(scope, id, props);

        const logGroup = logs.LogGroup.fromLogGroupName(
            this,
            "AgentLogGroup",
            props.logGroupName,
        );

        const ns = props.metricNamespace;

        // ---- counts -----------------------------------------------------
        this.countFilter(logGroup, "RiskBlocks", ns, {
            pattern: '{ $.stage = "risk_check" && $.decision = "block" }',
            dims: { rule: "$.rules_fired[0]" },
        });
        this.countFilter(logGroup, "RiskDowngrades", ns, {
            pattern: '{ $.stage = "risk_check" && $.decision = "downgrade_read_only" }',
        });
        this.countFilter(logGroup, "FailClosed", ns, {
            pattern: '{ $.stage = "fail_closed" }',
        });
        this.countFilter(logGroup, "UnknownStateOrders", ns, {
            pattern: '{ $.stage = "unknown_state" }',
        });
        this.countFilter(logGroup, "IdempotencyHits", ns, {
            pattern: '{ $.stage = "idempotency_hit" }',
        });
        this.countFilter(logGroup, "KillSwitchActivations", ns, {
            pattern: '{ $.stage = "kill_switch_activation" && $.active = true }',
        });
        this.countFilter(logGroup, "PromptInjectionDetected", ns, {
            pattern: '{ $.stage = "prompt_injection_detected" }',
        });
        this.countFilter(logGroup, "Timeouts", ns, {
            pattern: '{ $.stage = "timeout" }',
        });

        // ---- order lifecycle counts ------------------------------------
        this.countFilter(logGroup, "SubmitRate", ns, {
            pattern: '{ $.stage = "order_submit" }',
            dims: { venue: "$.venue" },
        });
        this.countFilter(logGroup, "AckRate", ns, {
            pattern: '{ $.stage = "order_ack" }',
            dims: { venue: "$.venue" },
        });
        this.countFilter(logGroup, "OrderErrors", ns, {
            pattern: '{ $.stage = "order_error" }',
            dims: { venue: "$.venue" },
        });

        // ---- latency / status histograms -------------------------------
        new logs.MetricFilter(this, "VenueCallLatencyMs", {
            logGroup,
            metricNamespace: ns,
            metricName: "VenueCallLatencyMs",
            filterPattern: logs.FilterPattern.literal(
                '{ $.stage = "venue_call" }',
            ),
            metricValue: "$.latency_ms",
            dimensions: { venue: "$.venue", endpoint: "$.endpoint" },
            unit: cdk.aws_cloudwatch.Unit.MILLISECONDS,
        });

        new logs.MetricFilter(this, "OrderAckLatencyMs", {
            logGroup,
            metricNamespace: ns,
            metricName: "OrderAckLatencyMs",
            filterPattern: logs.FilterPattern.literal(
                '{ $.stage = "order_ack" }',
            ),
            metricValue: "$.latency_ms",
            dimensions: { venue: "$.venue" },
            unit: cdk.aws_cloudwatch.Unit.MILLISECONDS,
        });

        // ---- reconciliation lag ----------------------------------------
        new logs.MetricFilter(this, "ReconciliationLatencyMs", {
            logGroup,
            metricNamespace: ns,
            metricName: "ReconciliationLatencyMs",
            filterPattern: logs.FilterPattern.literal(
                '{ $.stage = "reconciliation_event" }',
            ),
            metricValue: "$.latency_ms",
            dimensions: { venue: "$.venue", source: "$.source" },
            unit: cdk.aws_cloudwatch.Unit.MILLISECONDS,
        });

        // ---- WS-disconnect signal (counted, then rated by alarm) -------
        this.countFilter(logGroup, "WSDisconnects", ns, {
            pattern: '"BinanceUserDataStream" "disconnected"',
            // The Binance/Coinbase WS clients log on `close`; this string
            // pattern matches the existing INFO line. Coinbase uses a
            // parallel pattern caught by the second filter below.
        });
        this.countFilter(logGroup, "WSDisconnectsCoinbase", ns, {
            pattern: '"CoinbaseUserOrderStream" "close"',
        });

        // ---- approval flow ---------------------------------------------
        this.countFilter(logGroup, "ApprovalApproved", ns, {
            pattern: '{ $.stage = "approval_decision" && $.decision = "approved" }',
            dims: { level: "$.approval_level" },
        });
        this.countFilter(logGroup, "ApprovalRejected", ns, {
            pattern: '{ $.stage = "approval_decision" && $.decision = "rejected" }',
            dims: { level: "$.approval_level" },
        });

        // ---- F4 — execution-stake filters ------------------------------
        // The Wave 1+2 schema change populates the spec-mandated `$.stake`
        // field with the resolved execution mode (live / paper / shadow).
        // These filters exploit the new slot so dashboards can finally
        // distinguish real-money order volume from paper-mode noise.
        this.countFilter(logGroup, "LiveOrderSubmits", ns, {
            pattern: '{ $.stage = "order_submit" && $.stake = "live" }',
            dims: { venue: "$.venue" },
        });
        this.countFilter(logGroup, "PaperOrderSubmits", ns, {
            pattern: '{ $.stage = "order_submit" && $.stake = "paper" }',
            dims: { venue: "$.venue" },
        });
        this.countFilter(logGroup, "LiveRiskAllows", ns, {
            pattern:
                '{ $.stage = "risk_check" && $.stake = "live" && $.decision = "allow" }',
        });

        // F4 — pre-execution USD notional by stake. emitValue picks
        // `notional_usd` off the event so CloudWatch sums real-money
        // exposure across a period (Sum stat, not Count).
        new logs.MetricFilter(this, "LiveNotionalUsd", {
            logGroup,
            metricNamespace: ns,
            metricName: "LiveNotionalUsd",
            filterPattern: logs.FilterPattern.literal(
                '{ $.stage = "order_submit" && $.stake = "live" }',
            ),
            metricValue: "$.notional_usd",
            dimensions: { venue: "$.venue" },
        });

        // ---- F5 — reconciliation auto-downgrade ------------------------
        // Should be very rare; every occurrence implies a user's CEX
        // credentials are unresolvable to the reconciliation poller.
        this.countFilter(logGroup, "ReconciliationDowngrades", ns, {
            pattern:
                '{ $.stage = "reconciliation_health" && $.decision = "downgrade" }',
            dims: { venue: "$.venue" },
        });

        // ---- F1 — drift detector ---------------------------------------
        // The deterministic post-check in cexWorkflowMessageHandler
        // prefixes the paper/shadow badge mechanically when the SLM
        // forgot. A spike means the formatter prompt is regressing — page.
        this.countFilter(logGroup, "MechanicalBadgeApplied", ns, {
            pattern: '"F1 mechanical badge applied"',
        });

        // ---- Schema-regression guard -----------------------------------
        // If a future refactor drops $.stake from order_submit events,
        // this fires and alarms before reaching prod. AWS metric-filter
        // grammar uses `NOT EXISTS` for absence checks.
        this.countFilter(logGroup, "OrderSubmitMissingStake", ns, {
            pattern: '{ $.stage = "order_submit" && $.stake NOT EXISTS }',
        });

        new cdk.CfnOutput(this, "MetricNamespace", { value: ns });
        new cdk.CfnOutput(this, "LogGroup", { value: props.logGroupName });
    }

    private countFilter(
        logGroup: logs.ILogGroup,
        metricName: string,
        ns: string,
        opts: { pattern: string; dims?: Record<string, string> },
    ): logs.MetricFilter {
        // AWS rejects `defaultValue` + `dimensions` together — they're
        // mutually exclusive. Omit defaultValue whenever dimensions exist.
        return new logs.MetricFilter(this, `${metricName}Filter`, {
            logGroup,
            metricNamespace: ns,
            metricName,
            filterPattern: logs.FilterPattern.literal(opts.pattern),
            metricValue: "1",
            ...(opts.dims
                ? { dimensions: opts.dims }
                : { defaultValue: 0 }),
        });
    }
}
