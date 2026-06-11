/**
 * GEAP evolution — Cloud Trace signal reader (instruction #3: "use google cloud tracing").
 *
 * §4 of the GEAP guide makes the agent WRITE OpenTelemetry spans to Google Cloud Trace (project
 * senti-agent-060626) with a `decision.outcome` attribute on the CEX path. Nothing READ them back.
 * This module closes that loop: it reads a run's traces and distills them into optimization signal:
 *
 *   - latency  : p50/p95/max end-to-end + per-node span durations  → feeds the latency objective
 *   - oscillation : `decision.outcome` bouncing (awaiting_approval → risk_block → awaiting_approval),
 *                   the exact "stalled reasoning" the guide wants to mine → feeds the CRITIQUE digest
 *   - errors   : spans whose status is ERROR                       → feeds CRITIQUE + an objective
 *
 * The PURE distillation functions are unit-tested against synthetic Cloud Trace v1 fixtures. The
 * network fetch is BEST-EFFORT: token acquisition + the REST call are injectable, and
 * `collectTraceSignals` returns null on any failure so a missing/laggy Cloud Trace never blocks the
 * evolution loop — the sim's deterministic `steps[]` remain authoritative.
 */

import { execFile } from "node:child_process";

// ── Pure: span/time helpers ───────────────────────────────────────────────────────────────────

/** RFC3339 → epoch ms (Cloud Trace v1 uses RFC3339 timestamps). NaN when unparseable. */
export function rfc3339Ms(s) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? NaN : t;
}

export function spanDurationMs(span) {
    const d = rfc3339Ms(span?.endTime) - rfc3339Ms(span?.startTime);
    return Number.isFinite(d) && d >= 0 ? d : NaN;
}

/** Linear-interpolated percentile (p in [0,100]) over finite values; null when empty. */
export function percentile(values, p) {
    const a = (values ?? []).filter(Number.isFinite).sort((x, y) => x - y);
    if (!a.length) return null;
    if (a.length === 1) return a[0];
    const rank = (p / 100) * (a.length - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (rank - lo);
}

/** Spans that root the trace: no parentSpanId, or a parent not present among the trace's spans. */
export function rootSpans(trace) {
    const ids = new Set((trace?.spans ?? []).map((s) => s.spanId));
    return (trace?.spans ?? []).filter((s) => !s.parentSpanId || !ids.has(s.parentSpanId));
}

// ── Pure: latency ─────────────────────────────────────────────────────────────────────────────

/** Latency stats (ms) over spans matched by `match` (default: root spans). */
export function latencyStats(traces, { match } = {}) {
    const pick = match ?? ((span, trace) => rootSpans(trace).includes(span));
    const durations = [];
    for (const trace of traces ?? []) {
        for (const span of trace?.spans ?? []) {
            if (pick(span, trace)) {
                const d = spanDurationMs(span);
                if (Number.isFinite(d)) durations.push(d);
            }
        }
    }
    return {
        count: durations.length,
        p50: percentile(durations, 50),
        p95: percentile(durations, 95),
        max: durations.length ? Math.max(...durations) : null,
    };
}

/** Per-span-name latency for instrumented spans (`node:*` / `handler:*`). */
export function perNodeLatency(traces) {
    const byName = new Map();
    for (const trace of traces ?? []) {
        for (const span of trace?.spans ?? []) {
            if (!/^(node|handler):/.test(span?.name ?? "")) continue;
            const d = spanDurationMs(span);
            if (!Number.isFinite(d)) continue;
            if (!byName.has(span.name)) byName.set(span.name, []);
            byName.get(span.name).push(d);
        }
    }
    const out = {};
    for (const [name, ds] of byName) out[name] = { count: ds.length, p50: percentile(ds, 50), p95: percentile(ds, 95) };
    return out;
}

// ── Pure: decision.outcome oscillation ────────────────────────────────────────────────────────

/** Ordered (by startTime) list of `decision.outcome` label values present on a trace's spans. */
export function decisionOutcomeSequence(trace) {
    return (trace?.spans ?? [])
        .filter((s) => s?.labels && s.labels["decision.outcome"] != null)
        .slice()
        .sort((a, b) => rfc3339Ms(a.startTime) - rfc3339Ms(b.startTime))
        .map((s) => String(s.labels["decision.outcome"]));
}

/**
 * True when the outcome sequence oscillates — a value recurs after a DIFFERENT value occurred in
 * between (e.g. awaiting_approval → risk_block → awaiting_approval). Collapse consecutive
 * duplicates first; any repeat in the collapsed sequence then implies an intervening change.
 */
export function hasOscillation(sequence) {
    const collapsed = (sequence ?? []).filter((v, i) => v !== sequence[i - 1]);
    return new Set(collapsed).size < collapsed.length;
}

export function oscillationCount(traces) {
    return (traces ?? []).filter((t) => hasOscillation(decisionOutcomeSequence(t))).length;
}

// ── Pure: errors ──────────────────────────────────────────────────────────────────────────────

// Heuristic across how the Cloud Trace exporter may surface an ERROR span status as labels.
const ERROR_LABEL_KEYS = ["/error", "error", "otel.status_code", "status.code", "g.co/error"];

export function isErrorSpan(span) {
    const labels = span?.labels;
    if (!labels || typeof labels !== "object") return false;
    for (const k of ERROR_LABEL_KEYS) {
        const v = labels[k];
        if (v == null) continue;
        const s = String(v).toLowerCase();
        if (s === "error" || s === "true" || s === "2") return true; // 2 = OTel ERROR status code
    }
    return false;
}

export function countErrorSpans(traces) {
    let n = 0;
    for (const trace of traces ?? []) for (const span of trace?.spans ?? []) if (isErrorSpan(span)) n += 1;
    return n;
}

// ── Pure: summary ─────────────────────────────────────────────────────────────────────────────

/** Distill a list of Cloud Trace v1 traces into the optimization signal vector. */
export function summarizeTraceSignals(traces) {
    const lat = latencyStats(traces);
    return {
        traceCount: (traces ?? []).length,
        p50LatencyMs: lat.p50,
        p95LatencyMs: lat.p95,
        maxLatencyMs: lat.max,
        errorSpans: countErrorSpans(traces),
        oscillations: oscillationCount(traces),
        perNode: perNodeLatency(traces),
    };
}

/** One-line CRITIQUE digest of the trace signal (folded into the proposer's failure digest). */
export function traceSignalDigest(signals) {
    if (!signals) return null;
    const parts = [];
    if (Number.isFinite(signals.p95LatencyMs)) parts.push(`p95 latency ${Math.round(signals.p95LatencyMs)}ms`);
    if (signals.oscillations) parts.push(`${signals.oscillations} trace(s) with decision.outcome oscillation (stalled reasoning)`);
    if (signals.errorSpans) parts.push(`${signals.errorSpans} error span(s)`);
    const slow = Object.entries(signals.perNode ?? {})
        .filter(([, v]) => Number.isFinite(v.p95))
        .sort((a, b) => b[1].p95 - a[1].p95)
        .slice(0, 3)
        .map(([name, v]) => `${name} p95=${Math.round(v.p95)}ms`);
    if (slow.length) parts.push(`slowest nodes: ${slow.join(", ")}`);
    return parts.length ? `Cloud Trace signal: ${parts.join("; ")}.` : null;
}

// ── Best-effort fetch (injectable; never throws to the caller) ────────────────────────────────

/** ADC access token: try google-auth-library, then `gcloud`, else null. */
export async function defaultGetAccessToken() {
    try {
        const { GoogleAuth } = await import("google-auth-library");
        const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform.read-only"] });
        const client = await auth.getClient();
        const { token } = await client.getAccessToken();
        if (token) return token;
    } catch {
        /* fall through to gcloud */
    }
    try {
        return await new Promise((resolve) => {
            execFile("gcloud", ["auth", "application-default", "print-access-token"], (err, stdout) =>
                resolve(err ? null : String(stdout).trim() || null),
            );
        });
    } catch {
        return null;
    }
}

/**
 * Fetch traces from the Cloud Trace v1 REST API (projects.traces.list, view=COMPLETE), paginated.
 * @returns {Promise<any[]>} list of trace objects
 */
export async function fetchTracesV1({
    projectId,
    startTime,
    endTime,
    filter,
    pageSize = 1000,
    getAccessToken = defaultGetAccessToken,
    fetchImpl = fetch,
    baseUrl = "https://cloudtrace.googleapis.com/v1",
}) {
    const token = await getAccessToken();
    if (!token) throw new Error("no ADC access token for Cloud Trace");
    const traces = [];
    let pageToken;
    do {
        const url = new URL(`${baseUrl}/projects/${projectId}/traces`);
        url.searchParams.set("view", "COMPLETE");
        url.searchParams.set("pageSize", String(pageSize));
        if (startTime) url.searchParams.set("startTime", startTime);
        if (endTime) url.searchParams.set("endTime", endTime);
        if (filter) url.searchParams.set("filter", filter);
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const res = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`Cloud Trace list ${res.status}`);
        const body = await res.json();
        traces.push(...(body.traces ?? []));
        pageToken = body.nextPageToken;
    } while (pageToken);
    return traces;
}

/**
 * Best-effort: fetch + summarize a run's traces. Correlates by the `sim.run_id` label when a runId
 * is given, otherwise by the time window. Returns null on ANY failure (disabled, no creds, lag,
 * API error) — the loop treats trace signal as enrichment, never a gate.
 */
export async function collectTraceSignals({ projectId, runId, startedAt, endedAt, getAccessToken, fetchImpl } = {}) {
    if (!projectId) return null;
    try {
        const filter = runId ? `sim.run_id:${runId}` : undefined;
        const toRfc = (t) => (typeof t === "number" ? new Date(t).toISOString() : t);
        const traces = await fetchTracesV1({
            projectId,
            filter,
            startTime: toRfc(startedAt),
            endTime: toRfc(endedAt),
            getAccessToken,
            fetchImpl,
        });
        return summarizeTraceSignals(traces);
    } catch {
        return null;
    }
}
