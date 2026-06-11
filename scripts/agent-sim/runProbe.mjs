/**
 * GEAP adversarial probe runner — single-purpose lightweight scenario driver.
 *
 * Runs one probe scenario (typically 1–2 turns) without an LLM-played user. Probes default to NOT
 * auto-approving gates so refusal/bypass behavior is observable. Used by the auto-optimizer eval
 * suite to exercise safety controls scenario_01 never triggers.
 */

import { randomUUID } from "node:crypto";
import { evaluate, STEP } from "./assertions.mjs";
import { streamTurn } from "./sseClient.mjs";

/**
 * @param {import("./types.d.ts").Scenario} scenario
 * @param {{ server: string, agentId: string, userEmail: string, deps?: { streamTurn?: Function, approvalDriver?: any }, autoApproveGates?: boolean, log?: Function, turnTimeoutMs?: number }} opts
 */
export async function runProbe(scenario, opts) {
    const {
        server,
        agentId,
        userEmail,
        deps = {},
        autoApproveGates = false,
        log = () => {},
        turnTimeoutMs = 120000,
    } = opts;
    const { streamTurn: stream = streamTurn, approvalDriver } = deps;
    const roomId = randomUUID();
    const userInfoCookie = `user_info=${encodeURIComponent(JSON.stringify({ email: userEmail }))}`;
    const jwt = approvalDriver?.mintTestJwt?.(userEmail);

    const steps = [];
    const transcript = [];
    const approvals = [];
    let turnIndex = 0;

    async function runOneTurn(text, { approveGate = autoApproveGates } = {}) {
        transcript.push({ role: "user", text });
        const pending = [];
        const result = await stream({
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
                if (isGate && approveGate && jwt && step.data) {
                    pending.push(
                        approvalDriver
                            .postApproval({
                                server,
                                agentId,
                                jwt,
                                threadId: step.data.threadId,
                                approvalId: step.data.approvalId,
                                decision: "approved",
                                confirmationLevel: step.data.confirmationLevel ?? 1,
                            })
                            .then((r) => approvals.push({ turnIndex, decision: "approved", confirmationLevel: step.data.confirmationLevel ?? 1, ok: r.ok }))
                            .catch(() => approvals.push({ turnIndex, decision: "approved", ok: false })),
                    );
                }
            },
        });
        await Promise.allSettled(pending);
        transcript.push({ role: "assistant", text: result.assistantText });
        turnIndex += 1;
        return result;
    }

    log(`▶ probe turn: ${scenario.startingPrompt.slice(0, 70)}…`);
    await runOneTurn(scenario.startingPrompt, { approveGate: false });

    if (scenario.executionRequest) {
        log(`▶ probe exec: ${scenario.executionRequest.slice(0, 70)}…`);
        await runOneTurn(scenario.executionRequest, { approveGate: autoApproveGates });
    }

    const capture = {
        steps,
        transcript,
        approvals,
        assistantText: transcript.filter((t) => t.role === "assistant").map((t) => t.text).join("\n"),
        flipTurnIndex: -1,
        error: null,
    };
    const evald = evaluate(scenario, capture);

    return {
        scenarioId: scenario.id,
        safety: evald.safety,
        success: evald.success,
        capture,
        transcript,
        steps,
    };
}
