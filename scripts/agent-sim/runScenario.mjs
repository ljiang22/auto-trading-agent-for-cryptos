import { randomUUID } from "node:crypto";
import { evaluate, STEP } from "./assertions.mjs";

/** @typedef {import("./types.d.ts").Scenario} Scenario */
/** @typedef {import("./types.d.ts").SimResult} SimResult */

/** Decide how to drive a given approval gate. Red-team turns reject; everything else approves. */
function decideApproval(scenario, turnIndex) {
  const rt = scenario.redTeam ?? [];
  // red-team turns are appended after the simulated turns; reject if this turn is flagged mustRefuse
  const flagged = rt.some((r, i) => r.mustRefuse && turnIndex === scenario.simulatedUser.maxTurns + i);
  return flagged ? "rejected" : "approved";
}

/**
 * Run one scenario under one environment variant against a (real or mock) agent.
 * @param {Scenario} scenario
 * @param {string} variant
 * @returns {Promise<SimResult>}
 */
export async function runScenario(scenario, variant, opts) {
  const { server, agentId, userEmail, deps } = opts;
  const { streamTurn, approvalDriver, applyEnvironment, createSimulatedUser, judgeTranscript } = deps;

  const roomId = opts.roomId ?? randomUUID();
  const userInfoCookie = `user_info=${encodeURIComponent(JSON.stringify({ email: userEmail }))}`;
  const jwt = approvalDriver.mintTestJwt(userEmail);
  const env = applyEnvironment(variant);
  const user = createSimulatedUser({ ...scenario.simulatedUser, generate: opts.userGenerate });

  /** @type {import("./types.d.ts").TurnRecord[]} */
  const transcript = [];
  /** @type {any[]} */
  const steps = [];
  /** @type {any[]} */
  const approvals = [];
  let flipTurnIndex = -1;
  let turnIndex = 0;

  // Drive one user turn: stream it, drive any modal/confirm approval gate mid-stream, and record
  // the transcript + steps. Returns the streamTurn result so the caller can branch on `timedOut`.
  async function runOneTurn(text) {
    transcript.push({ role: "user", text });
    if (variant === "thesisFlip" && env.injectedTurns.includes(text)) flipTurnIndex = turnIndex;
    const pending = [];
    const turnController = new AbortController();
    const result = await streamTurn({
      server,
      agentId,
      roomId,
      text,
      userInfoCookie,
      messageClassification: scenario.messageClassification,
      authToken: jwt,
      timeoutMs: Number(process.env.SIM_TURN_TIMEOUT_MS) || 120000,
      signal: turnController.signal,
      onStep: (step) => {
        step.turnIndex = turnIndex;
        steps.push(step);
        const isGate = step.name === STEP.HUMAN_INPUT_REQUIRED || step.name === STEP.HUMAN_INPUT_CONFIRM;
        if (isGate && jwt && step.data) {
          const decision = decideApproval(scenario, turnIndex);
          pending.push(
            approvalDriver
              .postApproval({
                server,
                agentId,
                jwt,
                threadId: step.data.threadId,
                approvalId: step.data.approvalId,
                decision,
                confirmationLevel: step.data.confirmationLevel ?? (step.name === STEP.HUMAN_INPUT_CONFIRM ? 2 : 1),
              })
              .then((r) => approvals.push({ turnIndex, decision, confirmationLevel: step.data.confirmationLevel ?? 1, ok: r.ok }))
              .catch(() => approvals.push({ turnIndex, decision, confirmationLevel: step.data.confirmationLevel ?? 1, ok: false })),
          );
        } else if (isGate && !jwt) {
          // gate-only run: the gate is the end-state; stop waiting (the stream won't send [DONE]).
          turnController.abort();
        }
      },
    });
    await Promise.allSettled(pending);
    transcript.push({ role: "assistant", text: result.assistantText });
    turnIndex += 1;
    return result;
  }

  // --- Conversation phase: starting prompt + env-injected turns + LLM-played user follow-ups.
  const injected = [...env.injectedTurns];
  let nextUserText = scenario.startingPrompt;
  // hard cap to avoid runaway loops with a misbehaving agent
  const HARD_CAP = scenario.simulatedUser.maxTurns + injected.length + 2;
  while (turnIndex < HARD_CAP) {
    const result = await runOneTurn(nextUserText);
    // A stalled turn (an advisory prompt that kicked off a long comprehensive/task-chain workflow,
    // or a gate-only run that aborted at the gate) ends the CONVERSATION — but not the run: the
    // deterministic trade turn below still fires so we reach the CEX gate.
    if (result.timedOut) break;
    if (injected.length) {
      nextUserText = injected.shift();
      continue;
    }
    const turn = await user.nextTurn(transcript);
    if (turn.done) break;
    nextUserText = turn.text;
  }

  // --- Trade phase: fire the deterministic imperative single-order trade turn LAST, regardless of
  // how the conversation ended (done / stall / cap). The server's cex_trade_intent short-circuit
  // routes imperative buy/sell/place phrasing to the CEX workflow, so this is what reaches the gate.
  // executionRequest must be a SINGLE, fully-specified order — "half my position" / DCA / "X and Y"
  // route to the multi-step plan executor (a chat plan card), which a headless run cannot drive.
  if (scenario.executionRequest) {
    await runOneTurn(scenario.executionRequest);
  }

  const capture = {
    steps,
    assistantText: transcript.filter((t) => t.role === "assistant").map((t) => t.text).join("\n"),
    approvals,
    flipTurnIndex,
    error: null,
  };
  const evald = evaluate(scenario, capture);

  let judgeScore = null;
  const judgeRubrics = scenario.assertions.success.filter((a) => a.kind === "judge").map((a) => a.rubric);
  if (judgeRubrics.length) {
    const jr = await judgeTranscript({ rubric: judgeRubrics.join("\n"), transcript });
    judgeScore = jr.score;
  }

  return {
    scenarioId: scenario.id,
    variant,
    safety: evald.safety,
    success: evald.success,
    judgeScore,
    transcript,
    steps,
  };
}

export { decideApproval };
