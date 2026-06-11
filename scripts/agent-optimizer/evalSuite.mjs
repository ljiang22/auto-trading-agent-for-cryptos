/**
 * GEAP §8 Auto-Optimizer — evaluation suite aggregator.
 *
 * Runs scenario_01 (primary rubric fitness) plus lightweight adversarial probe scenarios, then
 * merges their metric vectors into one gate-ready vector. Probes exercise safety controls the benign
 * scenario never triggers (bypass framing, leverage, off-allowlist asset, skip-approval).
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario01 } from "../agent-sim/runScenario01.mjs";
import { runProbe } from "../agent-sim/runProbe.mjs";
import { collectTraceSignals } from "../agent-sim/traceSignals.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const SCENARIO_DIR = join(REPO_ROOT, "tests", "scenarios");

/** Load probe_*.json adversarial scenarios (sorted). */
export function loadProbeScenarios(dir = SCENARIO_DIR) {
    return readdirSync(dir)
        .filter((f) => /^probe_.*\.json$/.test(f))
        .sort()
        .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

/**
 * Merge scenario_01's metric vector with probe safety results. rubricTotal stays scenario_01-only;
 * safetyPassRate and safetyByScenario aggregate across all parts (critical/* + probe/* keys).
 * @param {{ metricVector: object }} scenario01Result
 * @param {{ scenarioId: string, safetyPass: boolean }[]} probeResults
 */
export function aggregateMetricVectors(scenario01Result, probeResults = []) {
    const base = scenario01Result?.metricVector ?? {};
    const safetyByScenario = { ...(base.safetyByScenario ?? {}) };
    let passed = 0;
    let total = 0;
    for (const v of Object.values(safetyByScenario)) {
        total += 1;
        if (v === true) passed += 1;
    }
    for (const p of probeResults) {
        const key = `probe/${p.scenarioId}`;
        safetyByScenario[key] = p.safetyPass === true;
        total += 1;
        if (p.safetyPass) passed += 1;
    }
    return {
        ...base,
        safetyPassRate: total ? passed / total : 1,
        safetyByScenario,
    };
}

/**
 * Render the eval-report/scorecard "Trace signals" section from a summarizeTraceSignals() vector.
 * Advisory evidence for the planner (latency, errors, decision oscillation) — NEVER gates a score.
 * A null signal renders an honest "unavailable" note (read blocked / no creds) instead of nothing,
 * so the brief always shows whether trace evidence was consulted.
 */
export function formatTraceSignalsSection(sig) {
    const L = ["## Trace signals (Cloud Trace)", ""];
    if (!sig) {
        L.push(
            "_Trace data unavailable for this run — the Cloud Trace read failed (most likely the ADC identity lacks `roles/cloudtrace.user` on the trace project, or `gcloud auth login` is needed). The agent still EXPORTS traces; only the read-back is blocked. Scores above are unaffected (trace evidence is advisory)._",
        );
        return L.join("\n");
    }
    L.push(`- Traces in window: **${sig.traceCount ?? 0}**`);
    if (Number.isFinite(sig.p50LatencyMs)) L.push(`- End-to-end latency: p50 **${Math.round(sig.p50LatencyMs)}ms**, p95 **${Math.round(sig.p95LatencyMs)}ms**, max ${Math.round(sig.maxLatencyMs ?? 0)}ms`);
    L.push(`- Error spans: **${sig.errorSpans ?? 0}**`);
    L.push(`- Decision-outcome oscillations (stalled reasoning): **${sig.oscillations ?? 0}**`);
    const nodes = Object.entries(sig.perNode ?? {})
        .filter(([, v]) => Number.isFinite(v?.p95))
        .sort((a, b) => b[1].p95 - a[1].p95)
        .slice(0, 5);
    if (nodes.length) {
        L.push("", "| Node | p50 (ms) | p95 (ms) | spans |", "|---|---|---|---|");
        for (const [name, v] of nodes) L.push(`| ${name} | ${Math.round(v.p50 ?? 0)} | ${Math.round(v.p95)} | ${v.count ?? "—"} |`);
    }
    return L.join("\n");
}

/**
 * Run the full optimizer evaluation suite against one agent.
 * @param {{
 *   server: string, agentId: string, userEmail: string, variant?: "A"|"B",
 *   deps: object, judge: Function, classificationOk?: boolean,
 *   judgeSamples?: number, skipProbes?: boolean, log?: Function,
 *   collectTraces?: Function|null,
 * }} opts
 * `collectTraces` (injectable; defaults to the Cloud Trace reader when GOOGLE_CLOUD_PROJECT is set)
 * receives the eval's `{ startedAt, endedAt }` window and returns a summarizeTraceSignals() vector.
 * Best-effort: a throw or null leaves `traceSignals: null` and never affects the score.
 */
export async function runEvalSuite(opts) {
    const {
        server,
        agentId,
        userEmail,
        variant = "B",
        deps,
        judge,
        classificationOk = false,
        judgeSamples = 1,
        skipProbes = false,
        log = () => {},
        collectTraces = defaultCollectTraces,
    } = opts;

    const startedAt = Date.now();
    const scenario01 = await runScenario01({
        server,
        agentId,
        userEmail,
        variant,
        deps,
        judge,
        classificationOk,
        judgeSamples,
        log,
    });

    const probeResults = [];
    if (!skipProbes) {
        const probes = loadProbeScenarios();
        for (const probe of probes) {
            log(`▶ probe ${probe.id}`);
            const pr = await runProbe(probe, { server, agentId, userEmail, deps, log });
            probeResults.push({ scenarioId: probe.id, safetyPass: pr.safety.pass, result: pr });
        }
    }
    const endedAt = Date.now();

    // Cloud Trace read-back over the eval's own time window (judging above gave ingest time to
    // settle). Advisory only — never gates.
    let traceSignals = null;
    if (typeof collectTraces === "function") {
        try {
            traceSignals = (await collectTraces({ startedAt, endedAt })) ?? null;
            if (traceSignals) log(`Cloud Trace: ${traceSignals.traceCount} trace(s), p95=${Math.round(traceSignals.p95LatencyMs ?? 0)}ms, errors=${traceSignals.errorSpans}, oscillations=${traceSignals.oscillations}`);
            else log("Cloud Trace: read unavailable (no creds/role) — continuing without trace evidence");
        } catch (err) {
            log(`Cloud Trace: read failed (${err?.message ?? err}) — continuing without trace evidence`);
            traceSignals = null;
        }
    }

    const metricVector = aggregateMetricVectors(scenario01, probeResults);
    if (traceSignals) {
        metricVector.traceCount = traceSignals.traceCount;
        metricVector.traceP50LatencyMs = traceSignals.p50LatencyMs;
        metricVector.traceP95LatencyMs = traceSignals.p95LatencyMs;
        metricVector.traceErrorSpans = traceSignals.errorSpans;
        metricVector.traceOscillations = traceSignals.oscillations;
    }
    return {
        score: scenario01.rubric?.total ?? metricVector.rubricTotal ?? 0,
        evaluation: {
            rubric: scenario01.rubric,
            criticalResults: scenario01.criticalResults,
            verdict: scenario01.verdict,
            probes: probeResults,
            traceSignals,
        },
        capture: scenario01.capture,
        metricVector,
        scenario01,
        probeResults,
        traceSignals,
    };
}

/**
 * Access token for the Cloud Trace READ: prefer the operator's authed `gcloud` identity, then fall
 * back to library ADC. The default ADC here is the Vertex service account, which holds the WRITE
 * role (`cloudtrace.agent`) but not the read role — its token mints fine and then 403s at the API,
 * so the reader's built-in "library first" order never reaches the gcloud fallback. This is
 * operator-run local tooling; the operator's own read access is the right identity to use.
 */
async function preferGcloudAccessToken() {
    try {
        const { execSync } = await import("node:child_process");
        const tok = execSync("gcloud auth print-access-token 2>/dev/null", { encoding: "utf8" }).trim();
        if (tok) return tok;
    } catch {
        /* gcloud unavailable / unauthenticated — fall through to ADC */
    }
    try {
        const { GoogleAuth } = await import("google-auth-library");
        const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform.read-only"] });
        const client = await auth.getClient();
        const { token } = await client.getAccessToken();
        if (token) return token;
    } catch {
        /* no ADC either */
    }
    return null;
}

/** Default Cloud Trace collector — active only when GOOGLE_CLOUD_PROJECT is configured. */
async function defaultCollectTraces({ startedAt, endedAt }) {
    const projectId = process.env.GOOGLE_CLOUD_PROJECT;
    if (!projectId) return null;
    // 60s lead margin: the agent may have begun the first turn's span just before our clock; trail
    // margin is "now" because we collect after judging (minutes of ingest settling).
    return collectTraceSignals({
        projectId,
        runId: process.env.SIM_RUN_ID || undefined,
        startedAt: startedAt - 60_000,
        endedAt,
        getAccessToken: preferGcloudAccessToken,
    });
}

export { REPO_ROOT, SCENARIO_DIR };
