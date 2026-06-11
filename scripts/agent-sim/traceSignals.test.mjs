import test from "node:test";
import assert from "node:assert/strict";
import {
    collectTraceSignals,
    countErrorSpans,
    decisionOutcomeSequence,
    hasOscillation,
    latencyStats,
    oscillationCount,
    percentile,
    perNodeLatency,
    rootSpans,
    spanDurationMs,
    summarizeTraceSignals,
    traceSignalDigest,
} from "./traceSignals.mjs";

// GEAP Cloud Trace reader — pure distillation of Cloud Trace v1 traces into optimization signal.
// Network fetch is best-effort and proven null-on-failure; the percentile/oscillation/error logic
// is exercised against synthetic fixtures shaped like the v1 traces.list (view=COMPLETE) response.

const span = (name, startMs, endMs, { parent, labels } = {}) => ({
    spanId: `${name}-${startMs}`,
    name,
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(endMs).toISOString(),
    ...(parent ? { parentSpanId: parent } : {}),
    ...(labels ? { labels } : {}),
});

test("spanDurationMs / percentile compute as expected", () => {
    assert.equal(spanDurationMs(span("x", 1000, 1800)), 800);
    assert.ok(Number.isNaN(spanDurationMs({ startTime: "bad", endTime: "bad" })));
    assert.equal(percentile([10, 20, 30, 40], 50), 25); // linear interp midpoint
    assert.equal(percentile([5], 95), 5);
    assert.equal(percentile([], 50), null);
});

test("rootSpans identifies spans with no in-trace parent", () => {
    const root = span("handler:routeMessage", 0, 1000);
    const child = span("node:riskCheck", 100, 400, { parent: root.spanId });
    const orphan = span("node:detached", 100, 200, { parent: "missing-parent" });
    const trace = { spans: [root, child, orphan] };
    const names = rootSpans(trace).map((s) => s.name).sort();
    assert.deepEqual(names, ["handler:routeMessage", "node:detached"]); // orphan's parent not in trace
});

test("latencyStats summarizes root-span durations; perNodeLatency groups by instrumented name", () => {
    const traces = [
        { spans: [span("handler:routeMessage", 0, 1000), span("node:riskCheck", 100, 500, { parent: "handler:routeMessage-0" })] },
        { spans: [span("handler:routeMessage", 0, 3000), span("node:riskCheck", 100, 2600, { parent: "handler:routeMessage-0" })] },
    ];
    const lat = latencyStats(traces);
    assert.equal(lat.count, 2);
    assert.equal(lat.max, 3000);
    const per = perNodeLatency(traces);
    assert.equal(per["node:riskCheck"].count, 2);
    assert.ok(per["node:riskCheck"].p95 >= per["node:riskCheck"].p50);
});

test("decisionOutcomeSequence orders by startTime; hasOscillation detects A→B→A", () => {
    const trace = {
        spans: [
            span("handler:routeMessage", 300, 400, { labels: { "decision.outcome": "awaiting_approval" } }),
            span("handler:routeMessage", 100, 200, { labels: { "decision.outcome": "awaiting_approval" } }),
            span("handler:routeMessage", 200, 300, { labels: { "decision.outcome": "risk_block" } }),
        ],
    };
    assert.deepEqual(decisionOutcomeSequence(trace), ["awaiting_approval", "risk_block", "awaiting_approval"]);
    assert.equal(hasOscillation(["awaiting_approval", "risk_block", "awaiting_approval"]), true);
    // consecutive duplicates are NOT oscillation
    assert.equal(hasOscillation(["risk_block", "risk_block", "executed"]), false);
    assert.equal(hasOscillation(["allow"]), false);
    assert.equal(oscillationCount([trace]), 1);
});

test("countErrorSpans is tolerant of how the exporter surfaces an ERROR status", () => {
    const traces = [
        { spans: [span("a", 0, 1, { labels: { "/error": "true" } }), span("b", 0, 1, { labels: { "otel.status_code": "ERROR" } })] },
        { spans: [span("c", 0, 1, { labels: { "status.code": "2" } }), span("d", 0, 1)] },
    ];
    assert.equal(countErrorSpans(traces), 3);
});

test("summarizeTraceSignals + digest produce the optimization signal", () => {
    const traces = [
        {
            spans: [
                span("handler:routeMessage", 0, 2500, { labels: { "decision.outcome": "awaiting_approval" } }),
                span("node:riskCheck", 100, 2400, { parent: "handler:routeMessage-0", labels: { "decision.outcome": "risk_block" } }),
                span("handler:routeMessage", 2600, 2700, { labels: { "decision.outcome": "awaiting_approval" } }),
            ],
        },
    ];
    const s = summarizeTraceSignals(traces);
    assert.equal(s.traceCount, 1);
    assert.ok(Number.isFinite(s.p95LatencyMs));
    assert.equal(s.oscillations, 1);
    const digest = traceSignalDigest(s);
    assert.match(digest, /oscillation/);
    assert.match(digest, /latency/);
    assert.equal(traceSignalDigest(null), null);
});

test("collectTraceSignals is best-effort: returns null on fetch failure and on missing project", async () => {
    assert.equal(await collectTraceSignals({ projectId: null }), null);
    const throwingFetch = async () => {
        throw new Error("network down");
    };
    const signals = await collectTraceSignals({
        projectId: "senti-agent-060626",
        runId: "abc",
        getAccessToken: async () => "fake-token",
        fetchImpl: throwingFetch,
    });
    assert.equal(signals, null);
});

test("collectTraceSignals summarizes when fetch + token succeed", async () => {
    const fakeFetch = async () => ({
        ok: true,
        json: async () => ({ traces: [{ spans: [span("handler:routeMessage", 0, 1200)] }] }),
    });
    const signals = await collectTraceSignals({
        projectId: "senti-agent-060626",
        runId: "abc",
        getAccessToken: async () => "fake-token",
        fetchImpl: fakeFetch,
    });
    assert.equal(signals.traceCount, 1);
    assert.equal(signals.p50LatencyMs, 1200);
});
