/**
 * GEAP §8 Auto-Optimizer — the LOOP CONTROLLER (the agent that optimizes the trading agent).
 *
 * Per iteration: evaluate scenario_01 → comprehensive report → optimization plan → approval
 * (human, or auto when authorized) → execute in an isolated worktree → re-evaluate → 4-gate
 * safety/security check → adopt if safe + improved, else discard + notify + halt. Stops when the
 * score reaches the user's target, or halts on a gate failure / protected-file step / no-improvement
 * / max-iters. `runOptimizationLoop` takes every effect as an injected seam (fully unit-tested with
 * mocks); `main()` wires the live seams (runScenario01 + evalReportAgent + planner + executor +
 * gates + notify), which are operator-run like the rest of the harness.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentFileMap } from "./agentSurfaces.mjs";
import { assessCycleResult, cycleArtifactPaths, formatImplementationBrief } from "./implementationBrief.mjs";
import { runGates, scoreOf } from "./gates.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

/**
 * Persist evaluation + plan artifacts for the human-implement cycle (Cursor / Claude Code).
 * @param {{ outDir: string, baseline: object, report: object, plan: object, args: object, iteration?: number, formatScorecard?: Function }} ctx
 */
export async function writeCycleArtifacts(ctx) {
    const { outDir, baseline, report, plan, args, iteration = 1 } = ctx;
    const formatScorecard =
        ctx.formatScorecard ?? (await import("../agent-sim/scenarioEval.mjs")).formatScorecard;
    const paths = cycleArtifactPaths(outDir);
    const traceSection =
        baseline.evaluation?.traceSignals !== undefined
            ? `\n\n${(await import("./evalSuite.mjs")).formatTraceSignalsSection(baseline.evaluation.traceSignals)}\n`
            : "";
    writeFileSync(paths.scorecard, formatScorecard(baseline.evaluation) + traceSection);
    writeFileSync(paths.evalReport, (report.markdown ?? "(no eval report)") + traceSection);
    // Persist the raw capture so a failed category can be root-caused from the EXACT transcript
    // the judges scored (the eval report quotes fragments; this is the full evidence).
    if (baseline.capture) {
        writeFileSync(
            paths.capture,
            JSON.stringify(
                {
                    transcript: baseline.capture.transcript ?? [],
                    steps: (baseline.capture.steps ?? []).map((s) => ({ name: s.name, status: s.status, turnIndex: s.turnIndex, data: s.data })),
                    approvals: baseline.capture.approvals ?? [],
                },
                null,
                2,
            ),
        );
    }
    writeFileSync(
        paths.plan,
        JSON.stringify(
            {
                _note: "Implement via optimizer_implementation_brief.md in Cursor/Claude, then: pnpm optimize:cycle:verify --user-email <paper-user>",
                _workflow: "human-implement-cycle",
                baselineScore: baseline.score,
                targetScore: args.targetScore,
                iteration,
                summary: plan.summary,
                steps: plan.steps,
            },
            null,
            2,
        ),
    );
    writeFileSync(
        paths.brief,
        formatImplementationBrief({
            baselineScore: baseline.score,
            targetScore: args.targetScore,
            evaluation: baseline.evaluation,
            evalReportMarkdown: report.markdown,
            plan,
            iteration,
        }),
    );
    writeFileSync(
        paths.state,
        JSON.stringify(
            {
                lastScore: baseline.score,
                targetScore: args.targetScore,
                iteration,
                updatedAt: new Date().toISOString(),
                criticalPass: baseline.evaluation?.verdict?.criticalPass === true,
            },
            null,
            2,
        ),
    );
    return paths;
}

/** @param {{ evaluateBaseline: Function, generateReport: Function, generatePlan: Function, args: object, outDir: string, iteration?: number, log?: Function }} ctx */
export async function runEvaluateAndPlan(ctx) {
    const { evaluateBaseline, generateReport, generatePlan, args, outDir, iteration = 1, log = () => {} } = ctx;
    const baseline = await evaluateBaseline();
    baseline.score = scoreOf(baseline.metricVector);
    log(`score ${baseline.score}/${args.targetScore}`);
    const report = await generateReport({ evaluation: baseline.evaluation, capture: baseline.capture });
    const plan = await generatePlan({ report });
    const paths = await writeCycleArtifacts({ outDir, baseline, report, plan, args, iteration });
    return { baseline, report, plan, paths, assessment: assessCycleResult(baseline, args.targetScore) };
}

/** Best-effort worktree discard. A throwing discard() must NEVER suppress the subsequent halt
 *  notification — the user is notified on every halt regardless of cleanup outcome. */
async function safeDiscard(applied) {
    try {
        await applied?.discard?.();
    } catch {
        /* cleanup is best-effort; the halt notification still fires */
    }
}

/**
 * Drive the optimization loop. All effects injected.
 * @param {{
 *   targetScore?: number, maxIters?: number, autoApprove?: boolean, agentState?: object, log?: Function,
 *   evaluateBaseline: () => Promise<{score:number, evaluation:any, capture:any, metricVector:any}>,
 *   generateReport: (a:{evaluation:any,capture:any}) => Promise<any>,
 *   generatePlan: (a:{report:any,agentState:any}) => Promise<{steps:any[],summary?:string}>,
 *   applyAndEvaluate: (plan:any) => Promise<{score:number, evaluation:any, capture:any, candidateVector:any, changedFiles:string[], diff:string, build?:any, tests?:any, lint?:any, promote?:Function, discard?:Function}>,
 *   requestHumanApproval: (a:{plan:any,reason:string}) => Promise<boolean>,
 *   notify: (a:object) => Promise<any>,
 * }} opts
 */
export async function runOptimizationLoop(opts) {
    const {
        targetScore = 90,
        maxIters = 6,
        autoApprove = false,
        agentState = {},
        log = () => {},
        evaluateBaseline,
        generateReport,
        generatePlan,
        applyAndEvaluate,
        requestHumanApproval,
        notify,
    } = opts;

    const history = [];
    const deferred = []; // code/protected steps surfaced for out-of-loop human review (deduped by id)
    let baseline = await evaluateBaseline();
    // Single-source the baseline score too (not the operator-supplied `score` field): the target-reached
    // check and done() must use the SAME scalar the gates score, or iter-1 "success" could be declared
    // on an operator number that disagrees with the metric vector.
    baseline.score = scoreOf(baseline.metricVector);
    let completedIters = 0; // iterations that actually ran applyAndEvaluate (spend-correlated; consistent across all stop paths)
    log(`baseline score ${baseline.score}/${targetScore}`);
    const done = (status, extra = {}) => ({ status, score: baseline.score, targetScore, iterations: completedIters, history, deferredSteps: deferred, ...extra });

    for (let iter = 1; iter <= maxIters; iter += 1) {
        if (baseline.score >= targetScore) return done("success");

        const report = await generateReport({ evaluation: baseline.evaluation, capture: baseline.capture });
        const plan = await generatePlan({ report, agentState });
        if (!plan?.steps?.length) {
            await notify({ reason: "planner produced no steps", iteration: iter, score: baseline.score, target: targetScore });
            return done("halted-no-plan");
        }

        // Partition: only prompt/config may auto-apply (legacy path). Architecture/context/routing/tools/code
        // are implemented by Cursor/Claude out-of-loop — use `pnpm optimize:cycle:plan` + `--verify`.
        const autoSteps = plan.steps.filter((s) => !s.requiresHumanApproval && (s.target === "prompt" || s.target === "config"));
        const humanSteps = plan.steps.filter((s) => !autoSteps.includes(s));
        for (const s of humanSteps) if (!deferred.some((d) => d.id === s.id)) deferred.push(s);

        if (!autoSteps.length) {
            // Nothing auto-applicable — defer full plan for Cursor/Claude (human-implement cycle).
            for (const s of plan.steps) if (!deferred.some((d) => d.id === s.id)) deferred.push(s);
            await notify({
                reason: `plan requires human/Cursor implementation (${plan.steps.length} step(s)) — use optimize:cycle:plan + implementation brief`,
                iteration: iter,
                score: baseline.score,
                target: targetScore,
                planStep: plan.steps[0],
            });
            return done("halted-awaiting-implement", { plan, deferredSteps: plan.steps });
        }

        const autoPlan = { ...plan, steps: autoSteps };
        // Auto-approval not authorized → request human approval for the auto-eligible steps before executing.
        if (!autoApprove) {
            const approved = await requestHumanApproval({ plan: autoPlan, reason: "auto-approval not authorized" });
            if (!approved) {
                await notify({ reason: "plan needs human approval — auto-approval not authorized", iteration: iter, score: baseline.score, target: targetScore, planStep: autoSteps[0] });
                return done("halted-awaiting-approval", { plan: autoPlan });
            }
        }
        if (humanSteps.length) log(`iter ${iter}: deferring ${humanSteps.length} code/protected step(s) for human review; auto-applying ${autoSteps.length} prompt/config step(s)`);

        // Execute the auto-eligible steps in isolation + re-evaluate the changed agent.
        const applied = await applyAndEvaluate(autoPlan);
        completedIters += 1;

        // Single-source the score: the behavioral floor and the adoption decision MUST compare the
        // SAME scalar (no silent divergence between applied.score and the gated candidateVector).
        const candScore = scoreOf(applied.candidateVector);
        const baseScore = scoreOf(baseline.metricVector);

        // Consistency guard (fail-closed): a claimed improvement with no diff/changedFiles means the
        // apply silently no-op'd or diff capture failed — never adopt (or hand the gates vacuous input)
        // on unverifiable evidence. Coerce a malformed (non-array) changedFiles to "no evidence".
        const cf = Array.isArray(applied.changedFiles) ? applied.changedFiles : [];
        if (candScore > baseScore && (cf.length === 0 || !String(applied.diff ?? "").trim())) {
            await safeDiscard(applied);
            const escalations = [{ gate: "consistency", reasons: ["score improved but changedFiles/diff is empty/malformed — apply may have silently no-op'd or diff capture failed"] }];
            await notify({ reason: "safety/security gate failed", iteration: iter, score: baseline.score, target: targetScore, escalations, diff: applied.diff });
            return done("halted-gate", { escalations });
        }

        // 4-gate safety/security check on the applied change (keyed off the REAL on-disk delta).
        const gates = runGates({
            baselineVector: baseline.metricVector,
            candidateVector: applied.candidateVector,
            changedFiles: applied.changedFiles,
            diff: applied.diff,
            build: applied.build,
            tests: applied.tests,
            lint: applied.lint,
            targets: autoSteps.map((s) => s.target),
        });
        if (!gates.autoApprovable) {
            await safeDiscard(applied);
            await notify({ reason: "safety/security gate failed", iteration: iter, score: baseline.score, target: targetScore, escalations: gates.escalations, diff: applied.diff });
            return done("halted-gate", { escalations: gates.escalations });
        }

        // Safe — adopt only if it actually improved the (single-sourced) score.
        if (candScore > baseScore) {
            await applied.promote?.();
            log(`iter ${iter}: adopted (${baseScore} → ${candScore})`);
            history.push({ iter, from: baseScore, to: candScore, changedFiles: applied.changedFiles });
            baseline = { score: candScore, evaluation: applied.evaluation, capture: applied.capture, metricVector: applied.candidateVector };
        } else {
            await safeDiscard(applied);
            await notify({ reason: "no score improvement", iteration: iter, score: baseline.score, target: targetScore, diff: applied.diff });
            return done("halted-no-improvement");
        }
    }

    return done(baseline.score >= targetScore ? "success" : "exhausted-max-iters");
}

// ── Live CLI wiring (operator-run) ────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const m = new Map();
    for (let i = 2; i < argv.length; i += 1) {
        const t = argv[i];
        if (!t.startsWith("--")) continue;
        const [k, inline] = t.slice(2).split("=", 2);
        if (inline !== undefined) m.set(k, inline);
        else if (argv[i + 1] && !argv[i + 1].startsWith("--")) m.set(k, argv[(i += 1)]);
        else m.set(k, true);
    }
    return {
        targetScore: Number(m.get("target-score") ?? 90),
        maxIters: Number(m.get("max-iters") ?? 6),
        autoApprove: Boolean(m.get("auto-approve")),
        planOnly: Boolean(m.get("plan-only")), // evaluate + diagnose + plan, then STOP (review-first)
        verify: Boolean(m.get("verify")), // re-eval after Cursor implementation; plan again if below target
        planFile: typeof m.get("plan") === "string" ? m.get("plan") : undefined, // legacy: seed auto-apply loop
        variant: m.get("variant") === "A" ? "A" : "B",
        server: typeof m.get("server") === "string" ? m.get("server") : "http://127.0.0.1:3001",
        agent: typeof m.get("agent") === "string" ? m.get("agent") : undefined,
        readyTimeoutMs: Number(m.get("ready-timeout-ms") ?? 300000),
        userEmail: typeof m.get("user-email") === "string" ? m.get("user-email") : process.env.VITE_TEST_USER_EMAIL,
        notifyEmail: typeof m.get("notify-email") === "string" ? m.get("notify-email") : process.env.VITE_ADMIN_EMAILS?.replace(/"/g, ""),
        judgeSamples: Number(m.get("judge-samples") ?? 3),
        skipProbes: Boolean(m.get("skip-probes")),
    };
}

/** Resolve a running agent's id from `${server}/agents` (first agent, or one matching `name`). */
async function resolveAgentId(server, name) {
    try {
        const res = await fetch(`${String(server).replace(/\/$/, "")}/agents`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return undefined;
        const data = await res.json();
        const list = data.agents ?? data;
        if (!Array.isArray(list) || !list.length) return undefined;
        return (name ? list.find((a) => a?.name === name || a?.id === name) : list[0])?.id;
    } catch {
        return undefined;
    }
}

const safeStaticEval = (fn) => {
    try {
        return fn().classificationOk;
    } catch {
        return false;
    }
};

/**
 * Assemble the LIVE seams and the operator-run `applyAndEvaluate`. Imported lazily so the unit-tested
 * core never pulls the live stack.
 *
 * applyAndEvaluate is intentionally simple: because the loop HALTS every code step before execution
 * (deny-by-default), the only steps that reach this seam are prompt/config edits to the character —
 * which are READ AT RUNTIME, so NO rebuild is needed. Per iteration it: applies the plan's prompt/
 * config steps to a working copy of the character, materializes a SCRATCH character (distinct name ⇒
 * distinct agentId ⇒ isolated memory rows), boots an isolated PAPER-mode agent on a free port, re-runs
 * scenario_01 against it, and returns the metric vector + a diff + promote/discard. It NEVER mutates
 * the repo's character file (the loop iterates a /tmp working copy; the final optimized character is
 * emitted as a reviewable artifact). Any boot/eval failure resolves FAIL-CLOSED (score 0) so it can
 * never be mistaken for an improvement.
 */
export async function makeLiveSeams(args) {
    const [vertex, evalRep, planner, notif, opt, exec, scen, ab, sse, approvalDriver, mongo, ledger, evalSuiteMod] = await Promise.all([
        import("../agent-sim/vertex.mjs"),
        import("./evalReportAgent.mjs"),
        import("./optimizationPlannerAgent.mjs"),
        import("./notify.mjs"),
        import("../agent-sim/optimize.mjs"),
        import("./executor.mjs"),
        import("../agent-sim/runScenario01.mjs"),
        import("../agent-sim/abEvaluate.mjs"),
        import("../agent-sim/sseClient.mjs"),
        import("../agent-sim/approvalDriver.mjs"),
        import("mongodb"),
        import("./ledgerReset.mjs"),
        import("./evalSuite.mjs"),
    ]);
    const { makeVertexGenerateText } = vertex;
    const { generateEvalReport } = evalRep;
    const { generateOptimizationPlan } = planner;
    const { buildNotification, notifyHalt, makeSmtpSender } = notif;
    const { runStaticEval } = opt;
    const { applyPromptToCharacter, applyConfigToCharacter, configFromStep } = exec;
    const { runScenario01, makeRubricJudge } = scen;
    const { pickFreePort, waitForAgentReady, killChild } = ab;
    const { MongoClient } = mongo;
    const { clearPaperLedger } = ledger;
    const { runEvalSuite } = evalSuiteMod;
    const { spawn, execFile } = await import("node:child_process");
    const { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");

    const proGen = makeVertexGenerateText(process.env.LARGE_GOOGLE_MODEL || "gemini-3.1-pro-preview", { thinkingBudget: 0 });
    const judge = makeRubricJudge(makeVertexGenerateText("gemini-2.5-pro", { thinkingBudget: 0 }));
    const smtp = process.env.SMTP_HOST ? makeSmtpSender({ host: process.env.SMTP_HOST, port: process.env.SMTP_PORT, user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }) : null;
    const classificationOk = safeStaticEval(runStaticEval);

    const CHARACTER_PATH = join(REPO_ROOT, "characters", "CryptoTrader.json");
    // The loop iterates a /tmp WORKING COPY — the repo's character file is never mutated.
    const runDir = mkdtempSync(join(tmpdir(), "geap-opt-run-"));
    const workingChar = join(runDir, "working.character.json");
    copyFileSync(CHARACTER_PATH, workingChar);

    const gitDiffNoIndex = (a, b) =>
        new Promise((resolve) =>
            // `git diff --no-index` exits 1 when files differ — that's expected; take stdout regardless.
            execFile("git", ["--no-pager", "diff", "--no-index", "--no-color", "--", a, b], { maxBuffer: 16 * 1024 * 1024 }, (_e, out) => resolve(String(out || ""))),
        );

    const readWorkingState = () => {
        const obj = JSON.parse(readFileSync(workingChar, "utf8"));
        return { currentSystem: obj.system ?? obj.settings?.system ?? "", currentConfig: obj.settings?.modelConfig ?? {}, fileMap: buildAgentFileMap() };
    };

    // Reset the test user's PAPER ledger before each evaluation so scenario_01's status check reflects
    // ONLY the current run (stale orders from prior runs otherwise fail the status criticals — see
    // ledgerReset.mjs). Hard-scoped to the user's account id + the 3 paper collections; fail-safe
    // (a reset error logs a warning and the eval proceeds; a missing user id SKIPS — never a blanket wipe).
    let cachedUserId;
    const resetLedger = async () => {
        const uri = process.env.MONGODB_CONNECTION_STRING;
        if (!uri) return; // SQLite path / no Mongo ⇒ nothing to reset
        const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
        try {
            await client.connect();
            const db = client.db(process.env.MONGODB_DATABASE || process.env.DOCUMENTDB_DATABASE || undefined);
            if (cachedUserId === undefined) {
                const acct = (await db.collection("accounts").findOne({ email: args.userEmail })) ?? (await db.collection("accounts").findOne({ "details.email": args.userEmail }));
                cachedUserId = acct?.id ?? acct?._id?.toString?.() ?? null;
            }
            if (!cachedUserId) {
                console.error(`[optimizer] WARN: could not resolve account id for ${args.userEmail}; SKIPPING ledger reset (no blanket wipe).`);
                return;
            }
            const counts = await clearPaperLedger(db, cachedUserId);
            const total = Object.values(counts).reduce((a, b) => a + b, 0);
            console.error(`[optimizer] reset paper ledger for ${args.userEmail} (account ${cachedUserId}): ${JSON.stringify(counts)} (${total} docs)`);
        } catch (err) {
            console.error(`[optimizer] WARN: paper-ledger reset failed (continuing with eval): ${err?.message ?? err}`);
        } finally {
            await client.close().catch(() => {});
        }
    };

    const evalOnce = async ({ server, agentId }) => {
        await resetLedger();
        const r = await runEvalSuite({
            server,
            agentId,
            userEmail: args.userEmail,
            variant: args.variant,
            deps: { streamTurn: sse.streamTurn, approvalDriver },
            judge,
            classificationOk,
            judgeSamples: args.judgeSamples,
            skipProbes: args.skipProbes,
            log: (m) => console.error(`[optimizer] ${m}`),
        });
        return {
            score: r.score,
            evaluation: { rubric: r.evaluation.rubric, criticalResults: r.evaluation.criticalResults, verdict: r.evaluation.verdict, probes: r.evaluation.probes, traceSignals: r.evaluation.traceSignals ?? null },
            capture: r.capture,
            metricVector: r.metricVector,
        };
    };

    let seq = 0;
    const applyAndEvaluate = async (plan) => {
        const runId = `opt-${(seq += 1)}-${args._stamp}`;
        const dir = mkdtempSync(join(tmpdir(), "geap-opt-iter-"));
        let child;
        const failClosed = (error) => ({
            score: 0,
            evaluation: {},
            capture: {},
            candidateVector: { safetyPassRate: 0, classificationOk: false, rubricTotal: 0 },
            changedFiles: ["characters/CryptoTrader.json"],
            diff: "",
            tests: { ok: false, summary: error },
            lint: null,
            promote: async () => {},
            discard: async () => {},
            error,
        });
        try {
            // Guard: code/unknown steps must NEVER reach this seam (the loop halts them). Fail closed.
            const bad = plan.steps.find((s) => s.target !== "prompt" && s.target !== "config");
            if (bad) return failClosed(`non-prompt/config step ${bad.id} reached applyAndEvaluate`);

            // Apply all prompt/config steps to the working character (canonical name preserved).
            let appliedRaw = readFileSync(workingChar, "utf8");
            for (const step of plan.steps) {
                if (step.target === "prompt") {
                    const next = applyPromptToCharacter(appliedRaw, step.change);
                    if (!next || next === appliedRaw) return failClosed(`prompt step ${step.id} produced no change`);
                    appliedRaw = next;
                } else {
                    const cfg = configFromStep(step);
                    if (!cfg) return failClosed(`config step ${step.id} had no parseable config`);
                    appliedRaw = applyConfigToCharacter(appliedRaw, cfg);
                }
            }
            // Scratch character = applied change + a distinct name (⇒ distinct agentId, isolated memory).
            const scratchObj = JSON.parse(appliedRaw);
            scratchObj.name = `${scratchObj.name ?? "Agent"} [opt ${runId}]`;
            delete scratchObj.id;
            const scratchChar = join(dir, "character.scratch.json");
            writeFileSync(scratchChar, JSON.stringify(scratchObj, null, 2));
            const diff = await gitDiffNoIndex(workingChar, scratchChar);

            // Boot an isolated PAPER-mode scratch agent on a free port; wait until it registers.
            const port = await pickFreePort();
            const server = `http://127.0.0.1:${port}`;
            child = spawn("pnpm", ["--filter", "@sentiedge/agent", "start", "--isRoot", "--character", scratchChar], {
                cwd: REPO_ROOT,
                env: { ...process.env, SERVER_PORT: String(port), OTEL_TRACING_ENABLED: process.env.OTEL_TRACING_ENABLED ?? "true", DAILY_ANALYSIS_ENABLED: "false", SIM_RUN_ID: runId },
                stdio: "ignore",
                detached: true,
            });
            const spawnFailed = new Promise((_, rej) => child.on("error", (e) => rej(e instanceof Error ? e : new Error(String(e)))));
            let agentId;
            try {
                agentId = await Promise.race([waitForAgentReady({ server, timeoutMs: args.readyTimeoutMs, expectedName: scratchObj.name }), spawnFailed]);
            } catch (err) {
                return failClosed(`scratch agent not ready: ${err?.message ?? err}`);
            }

            let r;
            try {
                r = await evalOnce({ server, agentId });
            } catch (err) {
                return failClosed(`scratch eval failed: ${err?.message ?? err}`);
            }
            const validReEval = Array.isArray(r?.capture?.transcript) && Number.isFinite(r?.metricVector?.rubricTotal);
            return {
                score: r.score,
                evaluation: r.evaluation,
                capture: r.capture,
                candidateVector: r.metricVector,
                changedFiles: ["characters/CryptoTrader.json"],
                diff,
                build: undefined, // prompt/config → no compiled artifact (target-aware gate treats build as N/A)
                tests: { ok: Boolean(validReEval), summary: validReEval ? "scenario_01 re-eval completed" : "re-eval incomplete" },
                lint: null,
                promote: async () => writeFileSync(workingChar, appliedRaw), // advance the working baseline
                discard: async () => {},
            };
        } catch (err) {
            return failClosed(`apply/eval error: ${err?.message ?? err}`);
        } finally {
            await killChild(child);
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch {
                /* best-effort */
            }
        }
    };

    const emitResult = async (result) => {
        const stamp = args._stamp;
        const outChar = join(REPO_ROOT, "tests", "scenarios", `optimizer_result_${stamp}.character.json`);
        const outMd = join(REPO_ROOT, "tests", "scenarios", `optimizer_result_${stamp}.md`);
        writeFileSync(outChar, readFileSync(workingChar, "utf8"));
        const diffVsOriginal = await gitDiffNoIndex(CHARACTER_PATH, workingChar);
        const L = [
            "# GEAP Auto-Optimizer — run result",
            "",
            `- **Status:** ${result.status}`,
            `- **Score:** ${result.score} / target ${result.targetScore}`,
            `- **Iterations (applied):** ${result.iterations}`,
            `- **Adoptions:** ${result.history?.length ?? 0}`,
            "",
            "## Adoption history",
            ...(result.history?.length ? result.history.map((h) => `- iter ${h.iter}: ${h.from} → ${h.to} (${(h.changedFiles ?? []).join(", ")})`) : ["_none_"]),
            "",
            "## Deferred code/protected steps — HUMAN REVIEW REQUIRED (never auto-applied)",
            ...(result.deferredSteps?.length
                ? result.deferredSteps.map((s) => `- **${s.id}** (${s.target}${(s.files ?? []).length ? ` \`${s.files.join(", ")}\`` : ""}): ${s.closesGap || s.change || ""}`.slice(0, 300))
                : ["_none_"]),
            "",
            "## Optimized character diff (vs characters/CryptoTrader.json) — PROPOSE-ONLY, review before applying",
            "```diff",
            diffVsOriginal.slice(0, 20000) || "(no change)",
            "```",
            "",
            `Optimized character written to: ${outChar}`,
        ];
        writeFileSync(outMd, L.join("\n"));
        try {
            rmSync(runDir, { recursive: true, force: true }); // optimized char is now in tests/scenarios; drop the /tmp working dir
        } catch {
            /* best-effort */
        }
        return { outChar, outMd };
    };

    return {
        evaluateBaseline: () => evalOnce({ server: args.server, agentId: args._agentId }),
        generateReport: ({ evaluation, capture }) => generateEvalReport({ evaluation, capture, generate: proGen }),
        generatePlan: ({ report }) => generateOptimizationPlan({ evalReport: report, agentState: readWorkingState(), generate: proGen, targetScore: args.targetScore }),
        requestHumanApproval: async () => false, // CLI model: halt + notify; the human re-runs with --auto-approve to authorize
        notify: async (ctx) => notifyHalt({ notification: buildNotification(ctx), recipients: args.notifyEmail ? [args.notifyEmail] : [], deps: { writeReport: (p, c) => writeFileSync(p, c), send: smtp, reportPath: join(REPO_ROOT, "tests", "scenarios", "optimizer_halt.md") } }),
        applyAndEvaluate,
        emitResult,
        runDir,
        workingChar,
    };
}

export async function main(argv = process.argv) {
    const args = parseArgs(argv);
    args._stamp = String(Date.now());
    if (!args.userEmail) {
        console.error("Missing --user-email / VITE_TEST_USER_EMAIL (seeded paper-trading user).");
        process.exit(2);
    }
    if (!process.env.JWT_PUBLIC_KEY_B64) {
        console.error("Missing JWT_PUBLIC_KEY_B64 — scratch agents must trust the harness JWT. Run `pnpm dev:auth pubkey`.");
        process.exit(2);
    }
    if (!process.env.SIM_JWT_PRIVATE_KEY_B64 && !process.env.SIM_JWT_PRIVATE_KEY_FILE) {
        console.error("Missing SIM_JWT_PRIVATE_KEY_B64 / SIM_JWT_PRIVATE_KEY_FILE — the harness can't mint the Bearer token.");
        process.exit(2);
    }
    args._agentId = args.agent ?? (await resolveAgentId(args.server, args.agent));
    if (!args._agentId) {
        console.error(`No running agent at ${args.server}/agents — start the paper agent first (it provides the baseline).`);
        process.exit(2);
    }

    const seams = await makeLiveSeams(args);
    const outDir = join(REPO_ROOT, "tests", "scenarios");
    const paths = cycleArtifactPaths(outDir);
    let cycleIter = 1;
    try {
        const st = JSON.parse(readFileSync(paths.state, "utf8"));
        if (Number.isFinite(st?.iteration)) cycleIter = st.iteration;
    } catch {
        /* first cycle */
    }

    const log = (m) => console.error(`[optimizer] ${m}`);

    // ── Mode A: --verify — after Cursor/Claude implemented the plan, re-test the RUNNING agent. ───
    if (args.verify) {
        console.error("[optimizer] --verify: re-evaluating the running agent (post-implementation).");
        const result = await runEvaluateAndPlan({
            evaluateBaseline: seams.evaluateBaseline,
            generateReport: seams.generateReport,
            generatePlan: seams.generatePlan,
            args,
            outDir,
            iteration: cycleIter + 1,
            log,
        });
        try {
            rmSync(seams.runDir, { recursive: true, force: true });
        } catch {
            /* best-effort */
        }
        log(result.assessment.message);
        if (result.assessment.success) {
            console.error("[optimizer] CYCLE COMPLETE — no further plan needed.");
            process.exit(0);
        }
        console.error(`[optimizer] IMPLEMENT next cycle:\n  ${result.paths.brief}`);
        console.error("[optimizer] → Cursor/Claude implements brief, then pnpm build, restart agent, --verify again.");
        process.exit(2);
    }

    // ── Mode B: --plan-only — evaluate + diagnose + plan + implementation brief, STOP. ───────────
    if (args.planOnly) {
        console.error("[optimizer] --plan-only: human-implement cycle — evaluate, plan, write brief, STOP.");
        const { plan, paths: written, assessment } = await runEvaluateAndPlan({
            evaluateBaseline: seams.evaluateBaseline,
            generateReport: seams.generateReport,
            generatePlan: seams.generatePlan,
            args,
            outDir,
            iteration: cycleIter,
            log,
        });
        try {
            rmSync(seams.runDir, { recursive: true, force: true });
        } catch {
            /* best-effort */
        }
        console.error(`[optimizer] ${assessment.message}`);
        console.error(`[optimizer] IMPLEMENT (Cursor/Claude):\n  ${written.brief}`);
        console.error(`[optimizer] also wrote: ${written.plan}, ${written.scorecard}, ${written.evalReport}`);
        console.error("[optimizer] then: pnpm build && restart agent && pnpm optimize:cycle:verify --user-email <paper-user>");
        process.exit(0);
    }

    // ── Mode C (legacy): --plan + --auto-approve — auto-apply prompt/config on scratch agents. ───
    let planOverride = null;
    if (args.planFile) {
        const { finalizeStep } = await import("./optimizationPlannerAgent.mjs");
        const raw = JSON.parse(readFileSync(args.planFile, "utf8"));
        // Re-finalize EVERY step (recompute touchesProtected / requiresHumanApproval from the edited
        // target/files/diff). A hand-edited plan can NEVER bypass the safety flags by editing them.
        const steps = (Array.isArray(raw.steps) ? raw.steps : []).map((s, i) => finalizeStep(s, i));
        if (!steps.length) {
            console.error(`[optimizer] --plan ${args.planFile}: no steps found.`);
            process.exit(2);
        }
        planOverride = { summary: String(raw.summary ?? "human-edited plan"), steps, markdown: "" };
        console.error(`[optimizer] --plan ${args.planFile}: seeding iteration 1 with ${steps.length} human-edited step(s) (re-finalized; safety flags recomputed), then continuing the loop.`);
    }

    console.error(
        `[optimizer] baseline agent=${args._agentId} server=${args.server} target=${args.targetScore} maxIters=${args.maxIters} autoApprove=${args.autoApprove} variant=${args.variant} judgeSamples=${args.judgeSamples} skipProbes=${args.skipProbes}`,
    );
    console.error("[optimizer] NOTE: each iteration boots a fresh BGE-M3 paper agent (~1-5 min warmup) + runs scenario_01 — expect several minutes per iteration.");

    // With --plan, iteration 1 uses the human-edited plan; the loop then CONTINUES, auto-generating
    // subsequent plans — i.e. "run my plan, then restart the optimization loop".
    let planSeeded = false;
    const result = await runOptimizationLoop({
        targetScore: args.targetScore,
        maxIters: args.maxIters,
        autoApprove: args.autoApprove,
        log: (m) => console.error(`[optimizer] ${m}`),
        evaluateBaseline: seams.evaluateBaseline,
        generateReport: seams.generateReport,
        generatePlan: planOverride
            ? async (a) => {
                  if (!planSeeded) {
                      planSeeded = true;
                      return planOverride;
                  }
                  return seams.generatePlan(a);
              }
            : seams.generatePlan,
        applyAndEvaluate: seams.applyAndEvaluate,
        requestHumanApproval: seams.requestHumanApproval,
        notify: seams.notify,
    });

    const artifacts = await seams.emitResult(result);
    console.error(`[optimizer] DONE status=${result.status} score=${result.score}/${result.targetScore} iterations=${result.iterations}`);
    console.error(`[optimizer] artifacts: ${artifacts.outChar} + ${artifacts.outMd}`);
    process.exit(result.status === "success" ? 0 : 1);
}

if (process.argv[1]?.endsWith("autoOptimize.mjs")) {
    main().catch((err) => {
        console.error(err instanceof Error ? err.stack : err);
        process.exit(1);
    });
}

export { REPO_ROOT };
