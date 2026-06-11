/**
 * GEAP evolution — the A/B EVALUATOR (the missing orchestration).
 *
 * optimize.mjs exposes an injectable `opts.evaluateCandidate(candidate)` callback that no CLI run
 * ever provides, so candidates are proposed but never actually tested. This module implements that
 * callback: for one candidate it materializes a SCRATCH character with the candidate applied, boots
 * an ISOLATED paper-mode agent on a free port (tracing → Cloud Trace), re-runs the §3 sim against
 * it, distills the result (+ best-effort Cloud Trace signal) into a metric vector, and tears the
 * scratch agent down — never mutating the working tree.
 *
 * Isolation model (see the plan): the scratch agent is a SEPARATE PROCESS on a SEPARATE PORT with a
 * SEPARATE character `name` (⇒ a distinct agentId ⇒ memory rows namespaced away from the primary
 * agent). It shares the developer's already-seeded MongoDB so the authenticated paper-trading user
 * exists (user prefs are keyed by account, not agent) and orders route to the built-in paper venue.
 * Nothing here touches a real exchange or the production deployment.
 *
 * Tier-1 mutations (top-level `system`, `settings.modelConfig` knobs) are read from the character
 * JSON / at runtime, so the scratch agent needs NO rebuild. Source-level targets (the CEX template)
 * are out of scope for this evaluator (they need a core rebuild — see the plan's Tier-2).
 *
 * Every I/O seam (spawn, run-sim, readiness poll, trace fetch, port pick, clock) is injectable so
 * the orchestration logic is unit-tested without a live agent; the live boot is operator-run.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreVector } from "./metrics.mjs";
import { collectTraceSignals } from "./traceSignals.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const AGENT_PKG = "@sentiedge/agent";

// A metric vector that fails every gate — returned when the scratch agent never becomes usable, so
// a boot/sim failure can NEVER be mistaken for an improvement (fail closed). safetyByScenario is
// intentionally absent ⇒ it also trips the per-scenario monotonic floor.
export const FAIL_CLOSED = Object.freeze({ safetyPassRate: 0, taskScore: null, toolTrajectoryScore: null, classificationOk: false });

/** Sim results a COMPLETE run should produce: one per scenario × environmentContext variant (≥1). */
export function expectedRunCount(scenarios) {
    const n = (scenarios ?? []).reduce(
        (acc, s) => acc + (Array.isArray(s.environmentContext) && s.environmentContext.length ? s.environmentContext.length : 1),
        0,
    );
    return n || 1;
}

// ── Pure: apply a candidate to a character object ─────────────────────────────────────────────

/**
 * Return a NEW character object with the candidate applied, plus a distinct `name` (⇒ distinct
 * agentId for memory isolation). Tier-1 targets only:
 *   - target "system"           → set the LIVE top-level `system` (also mirror to settings.system
 *                                 so the field is consistent for any future settings.system reader)
 *   - target "config"           → shallow-merge candidate.config into settings.modelConfig
 *                                 (temperature / model / thinkingBudget / maxOutputTokens / …)
 * @param {object} charObj parsed CryptoTrader.json
 * @param {{target:string,text?:string,config?:object}} candidate
 * @param {string} runId
 */
export function applyCandidateToCharacter(charObj, candidate, runId) {
    const next = structuredClone(charObj);
    next.name = `${charObj.name ?? "Agent"} [scratch ${runId}]`;
    // Never reuse a fixed id — let the runtime derive a fresh agentId from the distinct name.
    delete next.id;
    if (candidate?.target === "config" && candidate.config && typeof candidate.config === "object") {
        next.settings = next.settings ?? {};
        next.settings.modelConfig = { ...(next.settings.modelConfig ?? {}), ...candidate.config };
    } else if (candidate?.target == null || candidate.target === "system" || candidate.target === "settings.system") {
        // A system-instruction candidate (target "system" / legacy "settings.system").
        const text = String(candidate?.text ?? "");
        next.system = text;
        next.settings = next.settings ?? {};
        next.settings.system = text;
    } else {
        // Tier-1 A/B can only apply runtime-read targets. A source-level target (e.g.
        // cexMessageTemplate) would need a core rebuild and is NOT representable in a scratch
        // character — throw so it fails CLOSED rather than silently corrupting the persona.
        throw new Error(`applyCandidateToCharacter: unsupported A/B target "${candidate.target}" (Tier-1 supports only: system | config)`);
    }
    return next;
}

/** Write the scratch character to disk and return its path + the chosen distinct name. */
export function materializeScratchCharacter({ characterPath, candidate, runId, dir }) {
    const charObj = JSON.parse(readFileSync(characterPath, "utf8"));
    const scratch = applyCandidateToCharacter(charObj, candidate, runId);
    const file = join(dir, "character.scratch.json");
    writeFileSync(file, JSON.stringify(scratch, null, 2));
    return { file, name: scratch.name };
}

// ── I/O seams (default implementations) ───────────────────────────────────────────────────────

/** Find a free TCP port by binding to 0. Best-effort (small TOCTOU window before spawn). */
export function pickFreePort() {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

/**
 * Poll `${server}/agents` until the SCRATCH agent is registered (the agent registers only after
 * BGE-M3 warmup + initialize, so /agents-non-empty — not /api/health — is the readiness signal).
 * When `expectedName` is given, returns the id of the agent whose name matches it, so a stale/other
 * agent that happens to occupy the (TOCTOU-reused) port can't be mistaken for ours. Each request is
 * bounded by an AbortSignal so a connect-but-stall response can't block past the deadline. Rejects
 * on timeout.
 */
export async function waitForAgentReady({ server, timeoutMs = 300000, intervalMs = 3000, fetchImpl = fetch, sleep, now = Date.now, expectedName }) {
    const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const deadline = now() + timeoutMs;
    for (;;) {
        try {
            const remaining = Math.max(0, deadline - now());
            const perReqMs = Math.max(1000, Math.min(intervalMs * 2, remaining || intervalMs * 2));
            const res = await fetchImpl(`${String(server).replace(/\/$/, "")}/agents`, { signal: AbortSignal.timeout(perReqMs) });
            if (res.ok) {
                const data = await res.json();
                const list = data.agents ?? data;
                if (Array.isArray(list) && list.length) {
                    const match = expectedName ? list.find((a) => a?.name === expectedName) : list[0];
                    if (match?.id) return match.id;
                }
            }
        } catch {
            /* not up yet / request aborted */
        }
        if (now() >= deadline) throw new Error(`scratch agent not ready within ${timeoutMs}ms at ${server}`);
        await wait(intervalMs);
    }
}

/** Spawn the scratch agent as a child process. Returns the ChildProcess. */
function defaultSpawnAgent({ port, characterPath, env, repoRoot = REPO_ROOT, traceProjectId, runId }) {
    const childEnv = {
        ...process.env,
        ...env,
        SERVER_PORT: String(port),
        OTEL_TRACING_ENABLED: "true",
        // Keep the scratch agent's blast radius to its namespaced memory rows: disable the daily
        // analysis scheduler's background catch-up writes. (The reconciliation poller reads the
        // shared ledger by design, but with the seeded paper creds it takes no harmful action.)
        DAILY_ANALYSIS_ENABLED: "false",
        ...(traceProjectId ? { GOOGLE_CLOUD_PROJECT: traceProjectId } : {}),
        ...(runId ? { SIM_RUN_ID: runId } : {}),
    };
    // detached:true ⇒ the child leads its own process group, so killChild can signal the WHOLE
    // group (the pnpm wrapper AND the real node agent grandchild), not just the pnpm wrapper.
    return spawn("pnpm", ["--filter", AGENT_PKG, "start", "--isRoot", "--character", characterPath], {
        cwd: repoRoot,
        env: childEnv,
        stdio: "ignore",
        detached: true,
    });
}

/** Run the §3 sim against the scratch agent as a subprocess; return the parsed results array. */
function defaultRunSim({ server, userEmail, agentId, outPath, env, repoRoot = REPO_ROOT, simScript }) {
    const script = simScript ?? join(__dirname, "runAll.mjs");
    return new Promise((resolve, reject) => {
        const args = [script, "--server", server, "--user-email", userEmail, "--out", outPath];
        if (agentId) args.push("--agent", agentId);
        const child = spawn("node", args, { cwd: repoRoot, env: { ...process.env, ...env }, stdio: "ignore" });
        // runAll.mjs exits non-zero on a safety FAILURE — that's data, not an orchestrator error;
        // read the results regardless of exit code. Only a missing/unreadable file is fatal.
        child.on("error", reject);
        child.on("exit", () => {
            try {
                resolve(JSON.parse(readFileSync(outPath, "utf8")));
            } catch (err) {
                reject(new Error(`sim produced no readable results at ${outPath}: ${err?.message ?? err}`));
            }
        });
    });
}

/**
 * Tear down the scratch agent and its whole process group, AWAITING actual exit so the next
 * candidate doesn't start while a ~2-4GB BGE-M3 agent is still draining and holding its port + DB
 * connections. SIGTERM the group, wait up to graceMs, then escalate to SIGKILL. Best-effort/never
 * throws. Returns when the process has exited (or after the SIGKILL window).
 */
export async function killChild(child, { graceMs = 8000 } = {}) {
    if (!child) return;
    const pid = child.pid;
    const signalGroup = (sig) => {
        try {
            if (typeof pid === "number") process.kill(-pid, sig); // negative pid ⇒ the process group
            else if (typeof child.kill === "function") child.kill(sig);
        } catch {
            try {
                if (typeof child.kill === "function") child.kill(sig);
            } catch {
                /* already gone */
            }
        }
    };
    const exited =
        typeof child.on === "function" && !child.killed
            ? new Promise((resolve) => child.on("exit", resolve))
            : Promise.resolve();
    signalGroup("SIGTERM");
    let timer;
    const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => resolve("timeout"), graceMs);
    });
    const which = await Promise.race([exited.then(() => "exited"), timedOut]);
    clearTimeout(timer);
    if (which === "timeout") {
        signalGroup("SIGKILL");
        await exited; // resolves on the real 'exit'; immediate for an injected test stub
    }
}

// ── The evaluator factory ─────────────────────────────────────────────────────────────────────

/**
 * Build the `evaluateCandidate(candidate)` function injected into the optimizer / evolve loop.
 * Returns a metric vector (scoreVector shape) augmented with { runId, traceSignals } for the
 * report. NEVER throws: any boot/sim/teardown failure resolves to FAIL_CLOSED.
 *
 * @param {{
 *   characterPath: string, userEmail: string, scenarios?: any[], classificationOk?: boolean,
 *   traceProjectId?: string, repoRoot?: string, readyTimeoutMs?: number, baseEnv?: object,
 *   spawnAgent?: Function, runSim?: Function, waitReady?: Function, collectTrace?: Function,
 *   pickPort?: Function, now?: () => number, mkdtemp?: Function, rmdir?: Function,
 * }} config
 */
export function makeEvaluateCandidate(config) {
    const {
        characterPath,
        userEmail,
        scenarios,
        classificationOk = false, // fail closed: caller must pass the real static-eval result
        traceProjectId,
        repoRoot = REPO_ROOT,
        readyTimeoutMs = 300000,
        baseEnv = {},
        spawnAgent = defaultSpawnAgent,
        runSim = defaultRunSim,
        waitReady = waitForAgentReady,
        collectTrace = collectTraceSignals,
        pickPort = pickFreePort,
        now = Date.now,
        mkdtemp = () => mkdtempSync(join(tmpdir(), "geap-ab-")),
        rmdir = (d) => rmSync(d, { recursive: true, force: true }),
    } = config;

    let seq = 0;
    return async function evaluateCandidate(candidate) {
        const runId = `${candidate?.id ?? "cand"}-${(seq += 1)}-${now()}`;
        const dir = mkdtemp();
        let child;
        try {
            const { file: scratchChar, name: scratchName } = materializeScratchCharacter({ characterPath, candidate, runId, dir });
            const port = await pickPort();
            const server = `http://127.0.0.1:${port}`;
            const startedAt = now();
            child = spawnAgent({ port, characterPath: scratchChar, env: baseEnv, repoRoot, traceProjectId, runId });
            // A spawn failure (e.g. pnpm not on PATH) emits an async 'error' event; with no listener
            // it becomes an uncaughtException that BYPASSES fail-closed. Capture + race it to map it
            // to FAIL_CLOSED instead of crashing the orchestrator. (Guarded for injected test stubs.)
            const spawnFailed = new Promise((_, reject) => {
                if (child && typeof child.on === "function") child.on("error", (e) => reject(e instanceof Error ? e : new Error(String(e))));
            });

            let agentId;
            try {
                agentId = await Promise.race([waitReady({ server, timeoutMs: readyTimeoutMs, expectedName: scratchName }), spawnFailed]);
            } catch (err) {
                return { ...FAIL_CLOSED, runId, error: `not-ready: ${err?.message ?? err}` };
            }

            let simResults;
            try {
                simResults = await runSim({ server, userEmail, agentId, outPath: join(dir, "sim_scratch.json"), env: baseEnv, repoRoot });
            } catch (err) {
                return { ...FAIL_CLOSED, runId, error: `sim-failed: ${err?.message ?? err}` };
            }
            // Fail CLOSED on a short/empty sim: a candidate that booted but ran/answered nothing must
            // NOT score safetyPassRate:1 ("nothing failed") and Pareto-dominate a sub-1.0 baseline.
            const expected = expectedRunCount(scenarios);
            if (!Array.isArray(simResults) || simResults.length < expected) {
                return { ...FAIL_CLOSED, runId, error: `sim-incomplete: got ${Array.isArray(simResults) ? simResults.length : "non-array"}, expected >= ${expected}` };
            }

            const endedAt = now();
            const traceSignals = traceProjectId
                ? await collectTrace({ projectId: traceProjectId, runId, startedAt, endedAt })
                : null;

            const vector = scoreVector({ simResults, scenarios, traceSignals, classificationOk });
            return { ...vector, runId, traceSignals };
        } catch (err) {
            return { ...FAIL_CLOSED, runId, error: `ab-error: ${err?.message ?? err}` };
        } finally {
            // AWAIT teardown so the next candidate doesn't boot while this ~GB agent is still draining.
            await killChild(child);
            try {
                rmdir(dir);
            } catch {
                /* best-effort cleanup */
            }
        }
    };
}
