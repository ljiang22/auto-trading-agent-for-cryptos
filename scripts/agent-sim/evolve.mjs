/**
 * §7 GEAP Auto-Evolution Pipeline — the closed-loop orchestrator (propose-only).
 *
 * Ties the existing pieces into an ADK-style Execute → Evaluate → Critique → Rewrite loop with a
 * GEPA Pareto frontier, bounded by the metric layer and the deterministic safety floor:
 *
 *   BASELINE   run §3 sim (+ static classifier + best-effort Cloud Trace) → baseline metric vector.
 *   CRITIQUE   optimize.mjs mineFailures + traceSignals digest (latency / oscillation / errors).
 *   REWRITE    propose candidates per enabled Tier-1 target (system instruction, config knobs).
 *   FLOOR      optimize.mjs validateCandidate / targets.validateConfigCandidate (deterministic).
 *   A/B        abEvaluate boots an isolated scratch agent per candidate, re-runs the sim, returns
 *              the full metric vector.
 *   SELECT     metrics.paretoImprovement — keep iff every hard floor holds AND the candidate
 *              Pareto-dominates the current frontier seed.
 *   ITERATE    hill-climb: the best survivor seeds the next round; stop when a round adds nothing.
 *   OUTPUT     emit a propose-only .patch (best system survivor) + a markdown report (frontier,
 *              per-metric deltas, config winners, Tier-3 architecture recommendations, latency
 *              table). NEVER mutates the working tree; NEVER commits; NEVER auto-applies.
 *
 * `evolve(opts)` is fully injectable (propose, evaluateCandidate, baseline, writers) and unit-tested;
 * `main()` wires the live Vertex proposer + abEvaluate against a running paper agent.
 */

import { spawn } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEvaluateCandidate } from "./abEvaluate.mjs";
import { dominates, paretoFront, paretoImprovement, scoreVector } from "./metrics.mjs";
import { mineFailures, runStaticEval, writeSystemPatch } from "./optimize.mjs";
import {
    buildArchitecturePrompt,
    buildConfigProposerPrompt,
    buildProposerPrompt,
    parseConfigCandidates,
    parseProposerResponse,
    parseRecommendations,
    TARGETS,
    validateCandidate,
    validateConfigCandidate,
} from "./targets.mjs";
import { synthesizeScenarios, writeScenarioDrafts } from "./synthesizeScenarios.mjs";
import { collectTraceSignals, traceSignalDigest } from "./traceSignals.mjs";
import { hasVertexCreds, makeVertexGenerateText } from "./vertex.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const SCENARIO_DIR = join(REPO_ROOT, "tests", "scenarios");
const CHARACTER_PATH = join(REPO_ROOT, "characters", "CryptoTrader.json");

const PROPOSER_SYSTEM = "You are a careful prompt+config engineer for a safety-critical crypto trading agent.";

// ── Pure helpers ──────────────────────────────────────────────────────────────────────────────

/** Propose + floor-validate candidates for one target. Returns [{...candidate, safe, missing, violations}]. */
async function proposeForTarget({ target, seed, digest, traceDigest, n, propose }) {
    let raw;
    let cands;
    if (target === "config") {
        raw = await propose({ system: PROPOSER_SYSTEM, prompt: buildConfigProposerPrompt({ currentConfig: seed.config, failureDigest: digest, traceDigest, n }) });
        cands = parseConfigCandidates(raw);
    } else {
        raw = await propose({ system: PROPOSER_SYSTEM, prompt: buildProposerPrompt({ target: TARGETS.system.label, currentText: seed.system, failureDigest: digest, n }) });
        cands = parseProposerResponse(raw);
    }
    return cands.map((c) => ({ ...c, ...(c.target === "config" ? validateConfigCandidate(c) : validateCandidate(c)) }));
}

/** Pick the hill-climb seed from a round's kept candidates: best quality, then lowest latency. */
function pickRoundBest(kept) {
    return [...kept].sort((a, b) => {
        const t = (b.metrics?.taskScore ?? -Infinity) - (a.metrics?.taskScore ?? -Infinity);
        if (t !== 0) return t;
        return (a.metrics?.p95LatencyMs ?? Infinity) - (b.metrics?.p95LatencyMs ?? Infinity);
    })[0];
}

/** Apply a kept candidate onto a frontier seed (system text and/or merged config). */
function advanceSeed(seed, cand) {
    return {
        system: cand.target === "config" ? seed.system : cand.text,
        config: cand.target === "config" ? { ...(seed.config ?? {}), ...cand.config } : seed.config,
        vector: cand.metrics,
    };
}

const fmtNum = (x) => (typeof x === "number" ? (Number.isInteger(x) ? String(x) : x.toFixed(3)) : "n/a");
const fmtMs = (x) => (typeof x === "number" ? `${Math.round(x)}ms` : "n/a");

/** Render the propose-only evolution report. */
export function formatEvolveReport({ stamp, targets, rounds, baselineVector, candidates, kept, frontier, best, patchFile, recommendations, baselineTrace, synthesizedDrafts = [] }) {
    const L = [];
    L.push(`# GEAP §7 Auto-Evolution report — ${stamp}`);
    L.push("");
    L.push("> **PROPOSE-ONLY.** Nothing here has been applied, committed, or deployed. Review the kept");
    L.push(`> candidate(s) and apply manually with \`git apply ${patchFile ?? "tests/scenarios/evolve_<ts>.patch"}\`.`);
    L.push(`> Targets: ${targets.join(", ")} · rounds: ${rounds}`);
    L.push("");
    L.push("## Baseline metric vector");
    for (const [k, v] of Object.entries(baselineVector)) L.push(`- ${k}: ${typeof v === "number" ? fmtNum(v) : v}`);
    L.push("");
    L.push(`## Candidates evaluated: ${candidates.length} (floor-passed + A/B'd: ${candidates.filter((c) => c.metrics).length})`);
    for (const c of candidates) {
        const tag = !c.safe ? "FLOOR-REJECT" : c.kept ? "KEPT" : "A/B-REJECT";
        const m = c.metrics;
        const delta = m ? ` task ${fmtNum(baselineVector.taskScore)}→${fmtNum(m.taskScore)}, safety ${fmtNum(baselineVector.safetyPassRate)}→${fmtNum(m.safetyPassRate)}${typeof m.p95LatencyMs === "number" ? `, p95 ${fmtMs(baselineVector.p95LatencyMs)}→${fmtMs(m.p95LatencyMs)}` : ""}` : "";
        L.push(`- [${tag}] ${c.id} ${c.target}: ${c.rationale || "(no rationale)"}${delta}`);
        if (!c.safe && (c.missing?.length || c.violations?.length)) L.push(`    floor: missing=[${(c.missing ?? []).join(",")}] violations=[${(c.violations ?? []).join(",")}]`);
        else if (c.metrics && !c.kept && c.gateReasons?.length) L.push(`    select: ${c.gateReasons.join("; ")}`);
    }
    L.push("");
    L.push(`## Pareto frontier (non-dominated): ${frontier.length}`);
    for (const c of frontier) L.push(`- ${c.id} ${c.target}: ${c.rationale || ""}`);
    L.push("");
    L.push("## Best survivor (hill-climb seed)");
    if (best?.candidate) {
        L.push(`- ${best.candidate.id} ${best.candidate.target}: ${best.candidate.rationale || ""}`);
        if (best.candidate.target === "config") L.push(`- recommended settings.modelConfig delta: \`${JSON.stringify(best.candidate.config)}\``);
        if (patchFile) L.push(`- system patch: \`${patchFile}\` (apply with \`git apply\`)`);
    } else {
        L.push("- none — no candidate Pareto-dominated the baseline. Baseline retained.");
    }
    L.push("");
    if (baselineTrace?.perNode && Object.keys(baselineTrace.perNode).length) {
        L.push("## Baseline latency by node (Cloud Trace)");
        for (const [name, v] of Object.entries(baselineTrace.perNode).sort((a, b) => (b[1].p95 ?? 0) - (a[1].p95 ?? 0))) {
            L.push(`- ${name}: p50 ${fmtMs(v.p50)}, p95 ${fmtMs(v.p95)} (n=${v.count})`);
        }
        L.push("");
    }
    L.push(`## Tier-3 architecture / feature recommendations (propose-only, NOT auto-applied): ${recommendations.length}`);
    if (!recommendations.length) L.push("- (none generated)");
    for (const r of recommendations) {
        L.push(`- **${r.title}** — ${r.rationale}`);
        if (r.evidence) L.push(`    evidence: ${r.evidence}`);
    }
    L.push("");
    if (synthesizedDrafts.length) {
        L.push(`## Synthesized scenario drafts (grow the eval set — review + promote): ${synthesizedDrafts.length}`);
        for (const f of synthesizedDrafts) L.push(`- \`${f}\``);
        L.push("");
    }
    L.push("_Config winners are surfaced as a settings.modelConfig delta (apply by hand). Tier-3 items are");
    L.push("human-implemented. Synthesized scenarios are drafts for review (runAll only globs scenario_NN.json).");
    L.push("Nothing in this report changes the agent until a human applies it._");
    return L.join("\n");
}

// ── The loop ──────────────────────────────────────────────────────────────────────────────────

/**
 * Run the closed evolution loop. All external effects are injected.
 * @returns {Promise<{baselineVector:object, best:object|null, candidates:any[], kept:any[], frontier:any[], recommendations:any[], patchFile:string|null, synthesizedDrafts:any[], report:string, reportFile:string}>}
 */
export async function evolve(opts) {
    const {
        scenarios,
        currentSystem,
        currentConfig = {},
        targets = ["system"],
        rounds = 2,
        n = 3,
        outDir = SCENARIO_DIR,
        stamp = new Date().toISOString().replace(/[:.]/g, "-"),
        baseline = {}, // { simResults, traceSignals }
        classificationOk,
        propose,
        evaluateCandidate,
        // RUBRIC-DRIVEN mode (scenario_01 spec): the CALLER injects these — main()/the CLI do NOT
        // wire them (this is operator-run, like the live boot). Produce them with runScenario01.mjs →
        // scenarioEval.evaluateScenario: baselineVector = result.metricVector (critical-pass →
        // safetyPassRate hard floor, rubric/100 → taskScore objective), critique = result.critique,
        // plus a rubric-aware evaluateCandidate that runs scenario_01 per candidate. The existing
        // Pareto gate then optimizes the 100-pt rubric with no further changes. See README "scenario_01".
        baselineVector: baselineVectorOverride,
        critique: critiqueOverride,
        synthesize = false,
        writePatch = writeSystemPatch,
        writeReport = (path, content) => writeFileSync(path, content),
        writeDrafts = writeScenarioDrafts,
        log = console.log,
    } = opts;

    // Validate requested targets against the registry and restrict the A/B loop to Tier-1 auto-AB
    // targets. Unknown targets fail loudly (no silent mis-proposal); propose-only (architecture) and
    // rebuild-gated (cexMessageTemplate) targets are excluded from the loop — architecture is still
    // surfaced via the out-of-band recommendation pass below.
    const unknown = targets.filter((t) => !TARGETS[t]);
    if (unknown.length) throw new Error(`unknown evolve target(s): ${unknown.join(", ")} (known: ${Object.keys(TARGETS).join(", ")})`);
    const abTargets = targets.filter((t) => TARGETS[t].autoAB && !TARGETS[t].needsRebuild);

    const baselineVector = baselineVectorOverride ?? scoreVector({ simResults: baseline.simResults, scenarios, traceSignals: baseline.traceSignals, classificationOk });
    const traceDigest = traceSignalDigest(baseline.traceSignals);
    const failDigest = mineFailures(baseline.simResults).digest;
    let digest = critiqueOverride ?? (traceDigest ? `${failDigest}\n${traceDigest}` : failDigest);

    log(`baseline: ${Object.entries(baselineVector).map(([k, v]) => `${k}=${typeof v === "number" ? fmtNum(v) : v}`).join(" ")}`);
    if (!baselineVectorOverride && !(baseline.simResults?.length)) {
        log("WARNING: no baseline sim and no baselineVector override — taskScore is null, so no candidate can be selected. Provide --baseline-sim or a rubric baselineVector.");
    }

    let seed = { system: currentSystem, config: currentConfig, vector: baselineVector, candidate: null };
    const allCandidates = [];
    const allKept = [];
    let cid = 0;

    for (let round = 1; round <= rounds; round += 1) {
        const roundCandidates = [];
        for (const target of abTargets) {
            const scored = await proposeForTarget({ target, seed, digest, traceDigest, n, propose });
            roundCandidates.push(...scored);
        }
        roundCandidates.forEach((c) => (c.id = `r${round}-${(cid += 1)}`));
        allCandidates.push(...roundCandidates);

        const floorPass = roundCandidates.filter((c) => c.safe);
        const roundKept = [];
        for (const c of floorPass) {
            const metrics = await evaluateCandidate(c);
            c.metrics = metrics;
            const gate = paretoImprovement({ baseline: seed.vector, candidate: metrics });
            c.kept = gate.keep;
            c.gateReasons = gate.reasons;
            if (gate.keep) {
                roundKept.push(c);
                allKept.push(c);
            } else {
                log(`A/B rejected ${c.id} (${c.target}): ${gate.reasons.join("; ")}`);
            }
        }
        if (!roundKept.length) {
            log(`round ${round}: no candidate improved over the current frontier — stopping hill-climb.`);
            break;
        }
        const winner = pickRoundBest(roundKept);
        seed = { ...advanceSeed(seed, winner), candidate: winner };
        // Re-mine: keep the (static) failure digest; the next round refines from the new seed.
        log(`round ${round}: adopted ${winner.id} (${winner.target}) as new frontier seed.`);
    }

    // Frontier across the baseline + all A/B'd candidates (for the report).
    const evaluated = allCandidates.filter((c) => c.metrics);
    const frontierItems = [{ id: "baseline", target: "baseline", metrics: baselineVector }, ...evaluated];
    const frontier = paretoFront(frontierItems, (it) => it.metrics).filter((it) => it.id !== "baseline");

    // Emit a propose-only patch for the best SYSTEM text if it changed.
    let patchFile = null;
    const best = seed.candidate ? seed : null;
    if (best && best.system && best.system !== currentSystem) {
        patchFile = writePatch(best.system, outDir, stamp);
    }

    // Tier-3 architecture recommendations (best-effort; only when a proposer is available).
    let recommendations = [];
    try {
        const raw = await propose({ system: PROPOSER_SYSTEM, prompt: buildArchitecturePrompt({ failureDigest: failDigest, traceDigest }) });
        recommendations = parseRecommendations(raw);
    } catch {
        /* best-effort */
    }

    // Grow the eval set (opt-in, propose-only): draft new scenario fixtures from observed failures
    // + trace oscillation, written to a staging dir for human review (never auto-run).
    let synthesizedDrafts = [];
    if (synthesize) {
        try {
            const drafts = synthesizeScenarios({ simResults: baseline.simResults, traceSignals: baseline.traceSignals, scenarios });
            synthesizedDrafts = writeDrafts(drafts, join(outDir, "synthesized"));
            if (synthesizedDrafts.length) log(`synthesized ${synthesizedDrafts.length} scenario draft(s) → ${join(outDir, "synthesized")}`);
        } catch (err) {
            log(`scenario synthesis skipped: ${err?.message ?? err}`);
        }
    }

    const report = formatEvolveReport({
        stamp,
        targets,
        rounds,
        baselineVector,
        candidates: allCandidates,
        kept: allKept,
        frontier,
        best,
        patchFile,
        recommendations,
        baselineTrace: baseline.traceSignals,
        synthesizedDrafts,
    });
    const reportFile = join(outDir, `evolve_${stamp}.md`);
    writeReport(reportFile, report);
    log(`\nWrote report: ${reportFile}`);
    if (patchFile) log(`Wrote patch:  ${patchFile}  (apply with: git apply ${patchFile})`);
    log("PROPOSE-ONLY: working tree unchanged, nothing committed.");

    return { baselineVector, best, candidates: allCandidates, kept: allKept, frontier, recommendations, patchFile, synthesizedDrafts, report, reportFile };
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const m = new Map();
    for (let i = 2; i < argv.length; i += 1) {
        const tok = argv[i];
        if (!tok.startsWith("--")) continue;
        const [k, inline] = tok.slice(2).split("=", 2);
        if (inline !== undefined) m.set(k, inline);
        else if (argv[i + 1] && !argv[i + 1].startsWith("--")) m.set(k, argv[(i += 1)]);
        else m.set(k, true);
    }
    return {
        userEmail: typeof m.get("user-email") === "string" ? m.get("user-email") : null,
        server: typeof m.get("server") === "string" ? m.get("server") : "http://127.0.0.1:3000",
        rounds: Number(m.get("rounds") ?? 2),
        n: Number(m.get("n") ?? 3),
        targets: (typeof m.get("targets") === "string" ? m.get("targets") : "system").split(",").map((s) => s.trim()).filter(Boolean),
        outDir: typeof m.get("out-dir") === "string" ? m.get("out-dir") : SCENARIO_DIR,
        baselineSim: typeof m.get("baseline-sim") === "string" ? m.get("baseline-sim") : null,
        traceProject: typeof m.get("trace-project") === "string" ? m.get("trace-project") : process.env.GOOGLE_CLOUD_PROJECT || null,
        synthesize: Boolean(m.get("synthesize")),
    };
}

function loadScenarios() {
    return readdirSync(SCENARIO_DIR)
        .filter((f) => /^scenario_\d+\.json$/.test(f))
        .sort()
        .map((f) => JSON.parse(readFileSync(join(SCENARIO_DIR, f), "utf8")));
}

/** Run the §3 sim against a running agent as a subprocess and return the parsed results. */
function runBaselineSim({ server, userEmail, outPath }) {
    const script = join(__dirname, "runAll.mjs");
    return new Promise((resolve, reject) => {
        const child = spawn("node", [script, "--server", server, "--user-email", userEmail, "--out", outPath], { cwd: REPO_ROOT, env: process.env, stdio: "inherit" });
        child.on("error", reject);
        child.on("exit", () => {
            try {
                resolve(JSON.parse(readFileSync(outPath, "utf8")));
            } catch (err) {
                reject(new Error(`baseline sim produced no readable results at ${outPath}: ${err?.message ?? err}`));
            }
        });
    });
}

export async function main(argv = process.argv) {
    const args = parseArgs(argv);
    if (!args.userEmail) {
        console.error("Missing --user-email (paper-trading test user). Set up: pnpm dev:auth init|token|seed-trading.");
        process.exit(2);
    }
    const propose = hasVertexCreds() ? makeVertexGenerateText("gemini-2.5-pro", { thinkingBudget: 0 }) : null;
    if (!propose) {
        console.error("PROPOSE needs Vertex creds (GOOGLE_VERTEX_PROJECT + GOOGLE_APPLICATION_CREDENTIALS_JSON).");
        process.exit(2);
    }

    const scenarios = loadScenarios();
    const char = JSON.parse(readFileSync(CHARACTER_PATH, "utf8"));
    const currentSystem = char?.system ?? char?.settings?.system ?? "";
    const currentConfig = char?.settings?.modelConfig ?? {};

    const { classificationOk, note } = runStaticEval();
    console.log(`static classifier anchor: ${note}`);

    // BASELINE sim (reuse a provided run, or run one against --server).
    const startedAt = Date.now();
    const simResults = args.baselineSim
        ? JSON.parse(readFileSync(args.baselineSim, "utf8"))
        : await runBaselineSim({ server: args.server, userEmail: args.userEmail, outPath: join(args.outDir, "sim_results.json") });
    const endedAt = Date.now();
    const traceSignals = args.traceProject ? await collectTraceSignals({ projectId: args.traceProject, startedAt, endedAt }) : null;

    const evaluateCandidate = makeEvaluateCandidate({
        characterPath: CHARACTER_PATH,
        userEmail: args.userEmail,
        scenarios,
        classificationOk,
        traceProjectId: args.traceProject,
        baseEnv: process.env,
    });

    await evolve({
        scenarios,
        currentSystem,
        currentConfig,
        targets: args.targets,
        rounds: args.rounds,
        n: args.n,
        outDir: args.outDir,
        baseline: { simResults, traceSignals },
        classificationOk,
        propose,
        evaluateCandidate,
        synthesize: args.synthesize,
    });
}

if (process.argv[1]?.endsWith("evolve.mjs")) {
    main().catch((err) => {
        console.error(err instanceof Error ? err.stack : err);
        process.exit(1);
    });
}

export { dominates }; // re-exported for the report/tests convenience
