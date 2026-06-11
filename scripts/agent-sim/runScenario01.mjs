/**
 * GEAP scenario_01 LIVE runner — the test→evaluation bridge for the "BTC Investment Test Scenario".
 *
 * Drives the 5 scripted steps (rubric.STEPS) verbatim against a running PAPER agent — choosing the
 * 4A (recommended) or 4B (user-modified) branch — accumulates a {steps, transcript, approvals}
 * capture (the same shape runScenario.mjs produces), then scores it with scenarioEval.evaluateScenario
 * and prints the spec's scorecard. It also returns { metricVector, critique } so the result can feed
 * the evolve loop's RUBRIC-DRIVEN mode (evolve({ baselineVector, critique, evaluateCandidate })).
 *
 * Operator-run (live boot, paper agent, Vertex judge) — like §3. Every external seam (streamTurn,
 * approvalDriver, judge, static-eval) is injectable, so the step-driving orchestration is unit-tested
 * with mocks (runScenario01.test.mjs) without a live agent.
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as approvalDriver from "./approvalDriver.mjs";
import { STEP } from "./assertions.mjs";
import { runStaticEval } from "./optimize.mjs";
import { evaluateScenario } from "./scenarioEval.mjs";
import { STEPS } from "./rubric.mjs";
import { streamTurn } from "./sseClient.mjs";
import { hasVertexCreds, makeVertexGenerateText } from "./vertex.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

/**
 * The ordered prompts for one run: step1,2,3 → step4 (A or B, modified-strategy) → step4exec → step5.
 *
 * step4 (the modified strategy) exercises the user-modified-strategy criticals via the agent's
 * plan-card response. It produces a multi-step plan that pauses at the approval gate — but a headless
 * run cannot advance the plan-executor's chat approval, so NO order would execute from it.
 *
 * step4approve batch-approves the plan the step-4 modified strategy produced ("Yes, approve all
 * remaining steps."). With room continuity (room_created adoption above) the plan runner's
 * continuation parser maps it to APPROVE_BATCH and executes the plan IN ORDER: the validation reads
 * (get_balance, run_backtest) THEN the user's gated create_order legs ($300 market + $300/-5% +
 * $200/-10% limits = $800 ≤ $1,000). Every write executes only on this explicit user approval —
 * validation-before-execution is what the validatesModifiedStrategy critical requires, and the
 * executed legs give canExplainTrades real trades whose purpose the plan card documents per leg.
 */
export function scriptedPrompts(variant = "B") {
    const id4 = variant === "A" ? "step4A" : "step4B";
    const fromStep = (id) => {
        const s = STEPS.find((x) => x.id === id);
        return { id, text: s.userPrompt };
    };
    return [
        fromStep("step1"),
        fromStep("step2"),
        fromStep("step3"),
        fromStep(id4),
        { id: "step4approve", text: "Yes, approve all remaining steps." },
        fromStep("step5"),
    ];
}

/**
 * Drive the scripted scenario and evaluate it.
 * @param {{
 *   server?: string, agentId: string, userEmail: string, variant?: "A"|"B",
 *   deps: { streamTurn: Function, approvalDriver: any },
 *   judge: (prompt:string)=>Promise<any>, classificationOk?: boolean,
 *   turnTimeoutMs?: number, log?: Function,
 * }} opts
 */
export async function runScenario01(opts) {
    const { server = "http://127.0.0.1:3000", agentId, userEmail, variant = "B", deps, judge, classificationOk = false, judgeSamples = 1, executionMode = "paper", turnTimeoutMs = 180000, log = () => {} } = opts;
    const { streamTurn, approvalDriver } = deps;
    // Mutable: the server rebirths an unknown room under a NEW id (room_created event) on the first
    // turn — subsequent turns MUST post that id or every turn lands in its own isolated room (no
    // recentMessages context, no plan/approval continuity; the F6 bypass can never fire).
    let roomId = opts.roomId ?? randomUUID();
    const userInfoCookie = `user_info=${encodeURIComponent(JSON.stringify({ email: userEmail }))}`;
    const jwt = approvalDriver.mintTestJwt(userEmail);

    const steps = [];
    const transcript = [];
    const approvals = [];
    let turnIndex = 0;

    async function runOneTurn(text) {
        transcript.push({ role: "user", text });
        const pending = [];
        const result = await streamTurn({
            server,
            agentId,
            roomId,
            text,
            userInfoCookie,
            authToken: jwt,
            timeoutMs: turnTimeoutMs,
            onStep: (step) => {
                step.turnIndex = turnIndex;
                steps.push(step);
                const isGate = step.name === STEP.HUMAN_INPUT_REQUIRED || step.name === STEP.HUMAN_INPUT_CONFIRM;
                // The user explicitly asks to execute (steps 4A/4B), so APPROVE gates to progress.
                if (isGate && jwt && step.data) {
                    pending.push(
                        approvalDriver
                            .postApproval({ server, agentId, jwt, threadId: step.data.threadId, approvalId: step.data.approvalId, decision: "approved", confirmationLevel: step.data.confirmationLevel ?? 1 })
                            .then((r) => approvals.push({ turnIndex, decision: "approved", confirmationLevel: step.data.confirmationLevel ?? 1, ok: r.ok }))
                            .catch(() => approvals.push({ turnIndex, decision: "approved", ok: false })),
                    );
                }
            },
        });
        await Promise.allSettled(pending);
        // Surface the human-approval event to transcript-only consumers (the LLM judges). The modal
        // click genuinely happened (recorded in capture.approvals); without a transcript marker a
        // judge sees an order fill with no preceding consent and misreads it as "executed without
        // asking". role:"event" keeps it distinct from user/assistant turns (assistant-side checks
        // ignore it).
        if (pending.length) {
            transcript.push({ role: "event", text: "[The user reviewed the proposed order in the approval modal and clicked APPROVE — explicit human authorization for this specific order]" });
        }
        transcript.push({ role: "assistant", text: result.assistantText });
        if (result.roomId && result.roomId !== roomId) {
            log(`  (room remapped by server: ${roomId} → ${result.roomId})`);
            roomId = result.roomId;
        }
        turnIndex += 1;
        return result;
    }

    for (const { id, text } of scriptedPrompts(variant)) {
        log(`▶ ${id}: ${text.slice(0, 60)}…`);
        await runOneTurn(text);
    }

    const capture = { steps, transcript, approvals };
    const evaluation = await evaluateScenario({ capture, judge, classificationOk, judgeSamples, executionMode });
    log(`\n${evaluation.report}`);
    return { capture, ...evaluation, variant, roomId };
}

/** Wrap a text-generating fn (judge.mjs vertex style) into a JSON-returning rubric judge. */
export function makeRubricJudge(generate) {
    return async (prompt) => {
        const raw = await generate({ system: "Return ONLY the requested JSON. No prose.", prompt });
        const m = String(raw).match(/\{[\s\S]*\}/);
        if (!m) return {};
        try {
            return JSON.parse(m[0]);
        } catch {
            return {};
        }
    };
}

export { REPO_ROOT };

// ── Live CLI (operator-run) ───────────────────────────────────────────────────────────────────

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
        server: typeof m.get("server") === "string" ? m.get("server") : "http://127.0.0.1:3001",
        userEmail: typeof m.get("user-email") === "string" ? m.get("user-email") : process.env.VITE_TEST_USER_EMAIL,
        variant: m.get("variant") === "A" ? "A" : "B",
        agent: typeof m.get("agent") === "string" ? m.get("agent") : null,
        out: typeof m.get("out") === "string" ? m.get("out") : join(REPO_ROOT, "tests", "scenarios", "scenario_01_scorecard.md"),
    };
}

async function resolveAgentId(server, agentArg) {
    if (agentArg) return agentArg;
    const res = await fetch(`${String(server).replace(/\/$/, "")}/agents`);
    const data = await res.json();
    const list = data.agents ?? data;
    return list[0]?.id;
}

export async function main(argv = process.argv) {
    const args = parseArgs(argv);
    if (!args.userEmail) {
        console.error("Missing --user-email (or VITE_TEST_USER_EMAIL). Needs a seeded paper-trading user.");
        process.exit(2);
    }
    const agentId = await resolveAgentId(args.server, args.agent);
    if (!agentId) {
        console.error(`No agent found at ${args.server}/agents`);
        process.exit(2);
    }
    const judge = hasVertexCreds() ? makeRubricJudge(makeVertexGenerateText("gemini-2.5-pro", { thinkingBudget: 0 })) : null;
    if (!judge) console.error("WARNING: no Vertex creds — rubric categories + judged criticals will score 0 / fail closed.");
    let classificationOk = false;
    try {
        classificationOk = runStaticEval().classificationOk;
    } catch {
        /* static-eval anchor optional for a scorecard */
    }
    console.log(`Scenario_01 LIVE scorecard — server=${args.server} agent=${agentId} variant=${args.variant} classificationOk=${classificationOk}`);
    const res = await runScenario01({
        server: args.server,
        agentId,
        userEmail: args.userEmail,
        variant: args.variant,
        deps: { streamTurn, approvalDriver },
        judge: judge ?? (async () => ({})),
        classificationOk,
        turnTimeoutMs: Number(process.env.SCENARIO01_TURN_TIMEOUT_MS) || 420000,
        log: console.log,
    });
    writeFileSync(args.out, res.report);
    const capturePath = args.out.replace(/\.md$/, "") + "_capture.json";
    writeFileSync(capturePath, JSON.stringify({ transcript: res.capture.transcript, steps: res.capture.steps.map((s) => ({ name: s.name, turnIndex: s.turnIndex, status: s.status, message: s.message })), approvals: res.capture.approvals }, null, 2));
    // Per-turn transcript sizes — to spot a turn that stalled (tiny) vs a huge analysis turn.
    console.log("\n=== TRANSCRIPT TURN SIZES (role: chars) ===");
    for (const t of res.capture.transcript) console.log(`  ${t.role}: ${String(t.text ?? "").length} chars`);
    console.log(`\n=== METRIC VECTOR ===\n${JSON.stringify(res.metricVector, null, 2)}`);
    console.log(`\n=== VERDICT: ${res.verdict.overall} — ${res.rubric.total}/100 (${res.rubric.band}) ===`);
    console.log(`Scorecard: ${args.out}\nCapture:   ${capturePath}`);
}

if (process.argv[1]?.endsWith("runScenario01.mjs")) {
    main().catch((err) => {
        console.error(err instanceof Error ? err.stack : err);
        process.exit(1);
    });
}
