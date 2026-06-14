/**
 * CEX Plan Runner — top-level orchestrator.
 *
 * This module sits in front of the legacy CEX workflow. It:
 *
 *   1. Looks up any active plan for the (user, room).
 *      - If found, parses the user's reply via the continuation parser
 *        and dispatches APPROVE_NEXT / APPROVE_BATCH / CANCEL / SKIP.
 *      - If not, calls the decomposer LLM to produce a plan from the
 *        current message.
 *   2. Executes read-only steps in parallel (action.handler directly).
 *   3. For each WRITE step, hands control back to the user (chat-based
 *      step-by-step approval). The user replies "yes" to confirm, at
 *      which point the runner is re-entered on the next turn.
 *
 * Why chat-based approval instead of the existing modal:
 *   - The CEXApprovalDialog modal handles ONE order at a time. For
 *     multi-step plans, surfacing a single chat-based prompt with the
 *     full plan context is clearer and matches the design discussion
 *     ("step-by-step default with yes-all opt-in").
 *   - The existing risk engine + idempotency layers still apply because
 *     the runner invokes each action through `action.handler`, which
 *     goes through the same plugin-cex code paths as the legacy modal
 *     flow.
 *
 * Failure mode:
 *   - First step failure → bail. Subsequent steps marked `skipped`.
 *     Plan transitions to `failed`. The user-facing message includes
 *     the error and which step bailed.
 *
 * Return contract:
 *   - `null` means "I did not handle this message — fall through to
 *     the legacy CEX workflow." Used when the feature flag is off,
 *     the decomposer returns a 1-step plan (legacy is better at
 *     single orders), or the continuation parser returns UNKNOWN
 *     (the user changed topic).
 *   - `Memory[]` means "I handled it; here's the final response."
 *     The caller persists these and short-circuits the legacy
 *     workflow.
 */

import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

import { elizaLogger } from "../utils/logger.ts";
import { generateText } from "../ai/generation.ts";
import { composeContextSplit } from "../core/context.ts";
import { getCexDecomposeTemplate } from "../templates/cexDecomposeTemplate.ts";
import { getCEXActions } from "../utils/pluginFilter.ts";
import { ModelClass } from "../core/types.ts";
import type {
    Action,
    CEXSpecProvider,
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    Plugin,
    State,
    StreamingCallback,
    UUID,
} from "../core/types.ts";

import {
    CexPlanDecomposedSchema,
    CLARIFY_ACTION,
    type CexPlan,
    type CexPlanStep,
    type CexPlanStepDecomposed,
} from "./cexPlanSchema.ts";
import {
    cancelPlan,
    getActivePlan,
    savePlan,
    updatePlan,
} from "./cexPlanState.ts";
import {
    advanceCursor,
    decideStatus,
    detectCycle,
    inflateStep,
    markStepFailedAndBail,
    markStepOk,
    nextWriteStep,
    planShape,
    readableSteps,
    renderPlanCard,
    renderStepResultBlock,
} from "./cexPlanExecutor.ts";
import { parseContinuation, type CexContinuationResult } from "./cexContinuationParser.ts";
import {
    classifyContinuationWithLLM,
    type ContinuationClassifierContext,
} from "./cexContinuationLLM.ts";
import {
    isExecutionStatusQuery,
    isStrategyAdviceQuery,
    isStrategyRefinementQuery,
} from "./cexExecutionIntent.ts";
import {
    getSessionExecutionMode,
    setSessionExecutionMode,
    type CexExecutionMode,
} from "./cexExecutionModeSession.ts";
import { buildMarketSnapshot, resolveBinanceSymbol } from "./cexMarketSnapshot.ts";
import {
    isPlanTimeValidatorsEnabled,
    runPlanTimeValidators,
} from "./cexPlanTimeValidators.ts";

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

const FEATURE_FLAG_SETTING = "CEX_PLAN_EXECUTION_ENABLED";

function isPlanExecutionEnabled(runtime: IAgentRuntime): boolean {
    const raw = runtime.getSetting?.(FEATURE_FLAG_SETTING);
    return String(raw ?? "").toLowerCase() === "true";
}

// ---------------------------------------------------------------------------
// TTL
// ---------------------------------------------------------------------------

/**
 * Plan TTL — matches the existing CEX approval-context TTL so user
 * expectations stay consistent. 15 minutes from creation.
 */
const PLAN_TTL_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface RunPlanModeContext {
    runtime: IAgentRuntime;
    message: Memory;
    callback?: HandlerCallback;
    streamingCallback?: StreamingCallback;
    intermediateResponseCallback?: (response: Memory) => void;
    onToken?: (delta: string) => Promise<void> | void;
}

/**
 * The CEX handler's first action. Returns `null` to fall through to
 * the legacy workflow; returns a Memory[] when the plan runner has
 * fully handled the turn.
 */
export async function runPlanModeIfApplicable(
    ctx: RunPlanModeContext,
): Promise<Memory[] | null> {
    if (!isPlanExecutionEnabled(ctx.runtime)) {
        return null;
    }

    const messageText = ctx.message.content?.text?.trim() ?? "";
    if (!messageText) return null;

    // 1. Continuation path — there's an active plan in this room.
    const active = getActivePlan(
        String(ctx.message.userId),
        String(ctx.message.roomId),
    );
    if (active) {
        const parsed = parseContinuation(messageText);
        elizaLogger.info(
            `[CexPlanRunner] continuation parse: command=${parsed.command} plan=${active.id} match=${parsed.match ?? "(none)"}`,
        );
        if (parsed.command === "UNKNOWN") {
            // The regex fast-path couldn't classify this reply. Rather than
            // immediately re-prompt/cancel, ask the LLM to decide WITH the
            // plan + recent-conversation context — the contextual decider the
            // standalone regex lacks. The LLM runs ONLY on UNKNOWN, so clean
            // yes / no / cancel / delegate stay on the cheap regex path.
            const llm = await classifyContinuationWithLLM({
                runtime: ctx.runtime,
                userId: String(ctx.message.userId),
                ctx: await buildContinuationContext(ctx, active),
            });
            elizaLogger.info(
                `[CexPlanRunner] LLM continuation decider: intent=${llm.intent} plan=${active.id} reason=${llm.reason ?? "(none)"}`,
            );

            if (llm.intent === "NON_TRADING") {
                // A genuine non-trading question reached the plan runner.
                // PRESERVE the plan (do NOT cancel) and fall through so the
                // regular/legacy layer answers it; the user can resume with
                // "yes" afterwards.
                if ((active.clarify_nudges ?? 0) !== 0) {
                    updatePlan(active.id, (p) => {
                        p.clarify_nudges = 0;
                    });
                }
                return null;
            }

            if (llm.intent === "MODIFY") {
                // Keep the plan and ask for the concrete change. (Live
                // re-decomposition is a future enhancement; for v1 we surface
                // the plan and invite a specific edit or an approval.)
                const refreshed =
                    updatePlan(active.id, (p) => {
                        p.status = "awaiting_approval";
                        p.clarify_nudges = 0;
                    }) ?? active;
                const note =
                    'Sure — tell me exactly what to change (amounts, prices, or add a stop-loss) and I\'ll update the plan, or reply **"yes"** to proceed as shown.';
                const card = await renderPlanCardWithResults(
                    refreshed,
                    { include_next_prompt: true },
                    ctx,
                );
                return [
                    await persistFinalMemory(ctx, `${note}\n\n${card}`, {
                        kind: "plan_card",
                        planId: active.id,
                        awaitingApproval: true,
                    }),
                ];
            }

            if (llm.intent !== "UNCLEAR") {
                // APPROVE_NEXT / APPROVE_BATCH / CANCEL_PLAN / SKIP_STEP /
                // DELEGATE — dispatch through the SAME approval-gated handlers
                // as the regex path.
                if ((active.clarify_nudges ?? 0) !== 0) {
                    updatePlan(active.id, (p) => {
                        p.clarify_nudges = 0;
                    });
                }
                return await applyContinuation(ctx, active, {
                    command: llm.intent as CexContinuationResult["command"],
                    match: `llm:${llm.reason ?? ""}`,
                });
            }

            // UNCLEAR — non-destructive soft re-prompt: preserve the plan on
            // the first unrecognized reply, cancel on the second consecutive.
            const nudges = active.clarify_nudges ?? 0;
            if (nudges < 1) {
                const refreshed =
                    updatePlan(active.id, (p) => {
                        p.clarify_nudges = nudges + 1;
                    }) ?? active;
                const idx = nextWriteStep(refreshed);
                const prompt =
                    idx !== null
                        ? 'I didn\'t quite catch that. Reply **"yes"** to proceed with the next step, **"no"** to cancel, or tell me what to change.'
                        : 'I didn\'t quite catch that. Reply **"no"** to cancel, or ask me for a status update.';
                const card = await renderPlanCardWithResults(
                    refreshed,
                    { include_next_prompt: true },
                    ctx,
                );
                return [
                    await persistFinalMemory(ctx, `${prompt}\n\n${card}`, {
                        kind: "plan_card",
                        planId: active.id,
                        awaitingApproval: true,
                    }),
                ];
            }
            cancelPlan(active.id, "user_topic_shift");
            return null;
        }

        // Recognized command — reset the consecutive-unknown counter.
        if ((active.clarify_nudges ?? 0) !== 0) {
            updatePlan(active.id, (p) => {
                p.clarify_nudges = 0;
            });
        }

        if (parsed.command === "EXECUTION_STATUS") {
            return await renderExecutionStatusReport(ctx, active);
        }
        return await applyContinuation(ctx, active, parsed);
    }

    // 2. Fresh decomposition.
    // Strategy-ADVICE requests ("suggest/recommend a strategy") are consultations, not executable
    // order sequences — decomposing them into compile/backtest plans hijacks the conversation with
    // an approval card the user never asked for (and a lingering active plan that swallows their
    // next message as a continuation). Let the legacy conversational layer answer; an explicit
    // "execute this strategy" commitment still decomposes normally.
    if (isStrategyAdviceQuery(messageText)) {
        elizaLogger.info("[CexPlanRunner] strategy-advice query — skipping plan mode (conversational layer answers)");
        return null;
    }
    // #4 — Strategy REFINEMENT without an explicit execution instruction
    // ("modify it: buy $300 now…", "make it $400 instead") is the user
    // iterating on the strategy, not committing to it. Skip plan mode so the
    // conversational layer re-presents the updated strategy for review; only
    // an explicit "execute / place / proceed" (isExplicitExecuteCommand,
    // which this guard already excludes) decomposes into an order plan card.
    // Prevents the agent from jumping straight to an execution plan on every
    // tweak.
    if (isStrategyRefinementQuery(messageText)) {
        elizaLogger.info("[CexPlanRunner] strategy refinement without execute instruction — skipping plan mode (re-present for review/iteration)");
        return null;
    }
    const plan = await decomposeMessage(ctx);
    if (!plan) return null; // decomposer failed → let legacy handle.

    // Cycle check — a malformed plan from the LLM gets rejected here.
    const cycle = detectCycle(plan);
    if (cycle) {
        elizaLogger.warn(
            `[CexPlanRunner] decomposer produced cyclic plan: ${cycle.join(" → ")}; falling through to legacy`,
        );
        return null;
    }

    // Clarification path — the decomposer is telling us it can't
    // build a real plan without more info from the user.
    if (
        plan.steps.length === 1 &&
        plan.steps[0].action === CLARIFY_ACTION
    ) {
        const question =
            typeof plan.steps[0].parameters.question === "string"
                ? (plan.steps[0].parameters.question as string)
                : "Could you clarify what you'd like me to do?";
        return [await persistFinalMemory(ctx, question, { kind: "clarification" })];
    }

    // Single-step plans go through the legacy path. The legacy modal
    // is better-tuned for one-shot orders (richer parameter review,
    // venue resolution, risk gates already wired). Don't disturb it.
    if (plan.steps.length === 1) {
        elizaLogger.info(
            `[CexPlanRunner] single-step plan; falling through to legacy single-action flow`,
        );
        return null;
    }

    // 3. Plan-time validator chain (Fix 7). Gated by
    // `CEX_PLAN_TIME_VALIDATORS_ENABLED` so a fresh deploy can ship
    // with the validators dormant and flip them on after staging
    // soak. Runs BEFORE `savePlan` so a refused plan is never
    // persisted (no idempotency key burned, no continuation memo
    // tagged on the user reply).
    if (isPlanTimeValidatorsEnabled(ctx.runtime)) {
        const venue = inferDefaultVenue(plan);
        const outcome = await runPlanTimeValidators(plan, {
            runtime: ctx.runtime,
            userId: String(ctx.message.userId),
            locale: "en",
            defaultVenue: venue,
        });
        if (!outcome.ok) {
            // The validator chain has already mutated the plan to
            // terminal-failed. Render the red plan card and persist
            // the memory; do NOT persist the plan in the active-plan
            // store (a failed plan must not block fresh decompositions
            // on the next turn).
            elizaLogger.info(
                `[CexPlanRunner] plan ${plan.id} refused at plan-time: step=${outcome.failingStepId} message=${outcome.failingMessage}`,
            );
            const card = await renderPlanCardWithResults(plan, {}, ctx);
            return [
                await persistFinalMemory(ctx, card, {
                    kind: "plan_card",
                    planId: plan.id,
                }),
            ];
        }
    }

    // 4. Multi-step plan — persist and execute.
    const planToSave = injectStatusReadsIfNeeded(injectValidationStepsIfNeeded(plan, messageText), messageText);
    const { priorPlanCancelled } = savePlan(planToSave);
    if (priorPlanCancelled) {
        elizaLogger.info(
            `[CexPlanRunner] prior plan ${priorPlanCancelled.id} superseded for room ${plan.room_id}`,
        );
    }

    // Execute read-only prefix in parallel. Reads have no approval
    // gate and can land before we even draw the plan card, so the
    // user sees both the data and the "next step" prompt in a single
    // memory.
    await executeReadyReads(ctx, planToSave.id);

    // Refresh the plan from store post-reads. Use the by-id accessor
    // (`getActivePlanById`) instead of `getActivePlan(user, room)` —
    // when the plan was reads-only and all reads succeeded,
    // `executeReadyReads` transitions the plan to `completed`. The
    // (user, room) lookup skips terminal plans by design, which would
    // cause the runner to bail with "vanished" right after a clean
    // success. The by-id lookup still returns the plan for a brief
    // grace window so we can render the final card. Staging repro
    // 2026-05-21: a "show my orders and balance" mixed request
    // executed both reads, then the runner returned null and the
    // legacy CEX workflow ran instead.
    const refreshed = getActivePlanById(planToSave.id);
    if (!refreshed) {
        elizaLogger.warn(
            `[CexPlanRunner] plan ${plan.id} vanished mid-read; aborting`,
        );
        return null;
    }

    // If the next step is a write, render the card + step-by-step
    // prompt and stop. The user's next "yes" will resume via the
    // continuation path above.
    const writeIdx = nextWriteStep(refreshed);
    if (writeIdx !== null) {
        // Re-fetch AFTER status update so the rendered card reflects
        // `awaiting_approval` (not the stale `draft`) and so
        // `renderPlanCard`'s `include_next_prompt` branch fires.
        const ready = updatePlan(refreshed.id, (p) => {
            p.status = "awaiting_approval";
        });
        setSessionExecutionMode(
            String(ctx.message.userId),
            String(ctx.message.roomId),
            await resolveExecutionMode(ctx),
        );
        // SAFETY (reverted 2026-06-11): there is intentionally NO auto-execute here. Even on an
        // explicit "execute" command in paper mode, the first write MUST pass through the human
        // approval gate — the plan card + approval modal below, then a user "yes" continuation
        // (advanceAndRespond is reachable ONLY from that approved-continuation path). Auto-approving
        // here skipped the approval gate AND the risk engine (runRiskPrecheck runs on the approved
        // path, not in this initial-turn branch), which weakens the central safety control. Do not
        // re-introduce a no-confirmation execute path, in any mode.
        const card = await renderPlanCardWithResults(ready, { include_next_prompt: true }, ctx);
        // CEX post-PR237 Commit 4 — surface a per-step modal for
        // multi-write plans so the user can review or batch-approve
        // without typing each "yes". Single-write plans skip this
        // (the inline card prompt already covers it).
        await emitPlanApprovalModal(ctx, ready, writeIdx);
        return [await persistFinalMemory(ctx, card, { kind: "plan_card", planId: ready.id, awaitingApproval: true })];
    }

    // No writes ahead — plan is complete after the parallel reads.
    const completed = updatePlan(refreshed.id, (p) => {
        p.status = "completed";
    });
    // Execution-status queries get a synthesized STATUS REPORT instead of the raw plan card:
    // the card's data-dump shape (margin-wallet skip notes, bare order rows, no performance or
    // next-step guidance) reads as "the agent doesn't know its own orders". Read-only
    // presentation change; fails open to the plan card on any LLM error.
    if (isExecutionStatusQuery(String(ctx.message.content?.text ?? ""))) {
        const report = await synthesizeStatusReportViaLLM(completed, ctx);
        if (report) {
            return [await persistFinalMemory(ctx, report, { kind: "status_report", planId: completed.id })];
        }
    }
    const card = await renderPlanCardWithResults(completed, {}, ctx);
    return [await persistFinalMemory(ctx, card, { kind: "plan_card", planId: completed.id })];
}

// ---------------------------------------------------------------------------
// Decomposer LLM call
// ---------------------------------------------------------------------------

async function decomposeMessage(ctx: RunPlanModeContext): Promise<CexPlan | null> {
    const userMessage = ctx.message.content?.text ?? "";
    const cexActions = getCEXActions(ctx.runtime);
    const availableActions = cexActions
        .map((a) => `**${a.name}**: ${a.description ?? ""}`)
        .join("\n\n");
    const currentDate = new Date().toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
    });

    const { system, prompt } = composeContextSplit({
        state: {
            userMessage,
            currentDate,
            availableActions,
            recentMessages: "",
            bio: "",
            lore: "",
            messageDirections: "",
            postDirections: "",
            actors: "",
            goals: "",
            roomId: ctx.message.roomId,
            recentMessagesData: [],
        } as unknown as State,
        template: getCexDecomposeTemplate(),
    });

    // Decompose with a bounded RETRY. A complex multi-tranche "modify + execute"
    // request (e.g. "$300 now, $300 @ -5%, $200 @ -10%") sometimes makes the SMALL/
    // MEDIUM model emit a non-conforming object (missing `steps`/`summary`), which
    // dropped the whole plan to the legacy single-action path (the per-step eval's
    // step4B/step4approve + both critical failures). On a parse/schema miss we retry
    // ONCE with a corrective instruction + a larger token budget before giving up.
    let parsedZod:
        | z.SafeParseReturnType<unknown, z.infer<typeof CexPlanDecomposedSchema>>
        | null = null;
    for (let attempt = 1; attempt <= 2 && !(parsedZod && parsedZod.success); attempt += 1) {
        const attemptPrompt =
            attempt === 1
                ? prompt
                : `${prompt}\n\nYOUR PREVIOUS RESPONSE WAS INVALID. Return ONLY a single JSON object with a top-level "steps" array (each step: {id, action, parameters, depends_on, description}) and a "summary" string — no prose, no markdown fences, nothing else.`;
        let response: string;
        try {
            response = await generateText({
                runtime: ctx.runtime,
                system,
                prompt: attemptPrompt,
                modelClass: ModelClass.MEDIUM,
                userId: ctx.message.userId,
                temperature: 0,
                maxTokens: attempt === 1 ? 2048 : 4096,
                thinkingBudget: 0,
                bypassModelClassDowngrades: true,
            });
        } catch (error) {
            elizaLogger.warn(
                `[CexPlanRunner] decomposer LLM call failed (attempt ${attempt}): ${error instanceof Error ? error.message : String(error)}`,
            );
            continue;
        }
        elizaLogger.debug(
            `[CexPlanRunner] decomposer raw response (attempt ${attempt}, len=${response.length}): ${response.slice(0, 600)}`,
        );
        const json = extractJsonObject(response);
        if (!json) {
            elizaLogger.warn(
                `[CexPlanRunner] decomposer attempt ${attempt} returned no parseable JSON`,
            );
            continue;
        }
        try {
            parsedZod = CexPlanDecomposedSchema.safeParse(JSON.parse(json));
        } catch (error) {
            elizaLogger.warn(
                `[CexPlanRunner] decomposer attempt ${attempt} JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            continue;
        }
        if (!parsedZod.success) {
            elizaLogger.warn(
                `[CexPlanRunner] decomposer attempt ${attempt} schema validation failed: ${parsedZod.error.message}`,
            );
        }
    }
    if (!parsedZod || !parsedZod.success) {
        elizaLogger.warn(
            `[CexPlanRunner] decomposer failed after retries; falling through to legacy`,
        );
        return null;
    }

    // Reject steps that reference unknown actions (except `clarify`).
    const knownActionNames = new Set(cexActions.map((a) => a.name));
    knownActionNames.add(CLARIFY_ACTION);
    const unknownStep = parsedZod.data.steps.find(
        (s: CexPlanStepDecomposed) => !knownActionNames.has(s.action),
    );
    if (unknownStep) {
        elizaLogger.warn(
            `[CexPlanRunner] decomposer emitted unknown action "${unknownStep.action}"; falling through to legacy`,
        );
        return null;
    }

    const now = Date.now();
    const plan: CexPlan = {
        id: uuidv4() as UUID,
        user_id: String(ctx.message.userId),
        room_id: String(ctx.message.roomId),
        steps: parsedZod.data.steps.map((s) => inflateStep(s)),
        approval_mode: "step_by_step", // safer default per the design discussion
        status: "draft",
        cursor: 0,
        summary: parsedZod.data.summary,
        created_at: now,
        expires_at: now + PLAN_TTL_MS,
        source_message: userMessage,
    };

    const shape = planShape(plan);
    elizaLogger.info(
        `[CexPlanRunner] decomposed plan id=${plan.id} steps=${shape.total} reads=${shape.reads} writes=${shape.writes} mixed=${shape.hasMixedKinds}`,
    );
    return plan;
}

// ---------------------------------------------------------------------------
// Continuation dispatch
// ---------------------------------------------------------------------------

function formatValidationBlockFromPlan(plan: CexPlan): string {
    const lines = [
        "## Strategy validation (completed before execution)",
        "",
    ];
    for (const step of plan.steps) {
        if (step.status !== "ok") {
            continue;
        }
        if (step.action === "run_backtest") {
            const snippet =
                typeof step.result?.payload === "string"
                    ? step.result.payload.slice(0, 400)
                    : JSON.stringify(step.result?.payload ?? step.description ?? "").slice(0, 400);
            lines.push(`- **Backtest**: ${snippet || "completed"}`);
        }
        if (step.action === "compile_strategy") {
            lines.push("- **Strategy compile**: rules validated against DSL");
        }
        if (step.action === "get_balance") {
            lines.push("- **Capital check**: available balance verified against plan allocation");
        }
    }
    if (lines.length <= 2) {
        lines.push(
            "- **Risk review**: modified strategy rules reviewed; allocation within capital limit; drop entries are GTC limit orders (no background monitoring).",
        );
    }
    lines.push("");
    return lines.join("\n");
}

async function resolveExecutionMode(ctx: RunPlanModeContext): Promise<CexExecutionMode> {
    const userId = String(ctx.message.userId);
    const roomId = String(ctx.message.roomId);
    const cached = getSessionExecutionMode(userId, roomId);
    if (cached) {
        return cached;
    }
    const prefix = (ctx.message.content?.text ?? "").toLowerCase();
    if (/\bpaper\b/.test(prefix)) {
        return "paper";
    }
    if (/\bshadow\b/.test(prefix)) {
        return "shadow";
    }
    if (/\blive\b/.test(prefix)) {
        return "live";
    }
    return "paper";
}

/**
 * Deterministically fetch the live reads a status report needs (mark price, remaining balance,
 * filled+open orders) and append them to a WORKING COPY of the plan as `ok` steps. This is the
 * continuation-path equivalent of `injectStatusReadsIfNeeded` + `executeReadyReads` on the
 * fresh-decomposition path: an active-plan status query (`renderExecutionStatusReport`) otherwise
 * renders ONLY the persisted plan steps, so sections C/D/E ("Performance", "Market update", "Risk
 * status") had no live ticker/balance to work from — the per-step eval failed step5 on exactly this
 * ("A live mark was not fetched; unrealized PnL is unavailable. Remaining balance ... not provided").
 *
 * Read-only + fail-soft: any read failure leaves that section honest-empty (the LLM synthesizer
 * states what is missing) instead of blocking the report. The original `plan` is never mutated —
 * the appended steps live only on the returned copy used to synthesize this one report.
 */
async function fetchLiveStatusReads(
    ctx: RunPlanModeContext,
    plan: CexPlan,
): Promise<CexPlan> {
    const have = new Set(plan.steps.map((s) => s.action));
    const wanted: Array<{ id: string; action: string; parameters: Record<string, unknown>; description: string }> = [];
    if (!have.has("get_ticker")) wanted.push({ id: "live-ticker", action: "get_ticker", parameters: { product_ids: ["BTCUSDT"] }, description: "Live mark price for performance/market sections" });
    if (!have.has("get_balance")) wanted.push({ id: "live-balance", action: "get_balance", parameters: {}, description: "Remaining capital for the risk section" });
    if (!have.has("get_orders")) wanted.push({ id: "live-orders", action: "get_orders", parameters: { history: true }, description: "Filled + open orders" });
    if (wanted.length === 0) return plan;

    elizaLogger.info(
        `[CexPlanRunner] fetching ${wanted.length} live status read(s) for active-plan status query ${plan.id}: ${wanted.map((w) => w.action).join(", ")}`,
    );
    const fetched = await Promise.all(
        wanted.map(async (w) => {
            const step = inflateStep({ id: w.id, action: w.action, venue: null, parameters: w.parameters, depends_on: [], description: w.description });
            const completed_at = Date.now();
            try {
                const res = await invokeAction(ctx, step);
                step.status = res.ok ? "ok" : "failed";
                step.result = res.ok
                    ? { payload: res.payload, completed_at }
                    : { error: res.error ?? "read failed", completed_at };
            } catch (err) {
                step.status = "failed";
                step.result = { error: err instanceof Error ? err.message : String(err), completed_at };
            }
            return step;
        }),
    );
    return { ...plan, steps: [...plan.steps.map((s) => ({ ...s })), ...fetched] };
}

async function renderExecutionStatusReport(
    ctx: RunPlanModeContext,
    plan: CexPlan,
): Promise<Memory[]> {
    const mode =
        getSessionExecutionMode(String(ctx.message.userId), String(ctx.message.roomId))
        ?? (await resolveExecutionMode(ctx));
    setSessionExecutionMode(String(ctx.message.userId), String(ctx.message.roomId), mode);

    // Deterministically gather live mark + balance + orders, then synthesize a status report that
    // can fill the Performance (PnL) / Market trend / Risk (remaining balance) sections. The system
    // prompt's "invoke get_price + get_balance before any status report" directive is NOT sufficient
    // on this path: `renderExecutionStatusReport` is pure deterministic markdown construction — it
    // never calls the LLM and never invokes an action, so the prompt directive cannot reach it.
    // Mirror the fresh-decomposition path (injectStatusReadsIfNeeded → synthesizeStatusReportViaLLM).
    try {
        const enriched = await fetchLiveStatusReads(ctx, plan);
        const report = await synthesizeStatusReportViaLLM(enriched, ctx);
        if (report) {
            return [await persistFinalMemory(ctx, report, { kind: "status_report", planId: plan.id })];
        }
    } catch (err) {
        elizaLogger.warn(
            `[CexPlanRunner] live status enrichment failed (falling back to deterministic card): ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    const modeBadge =
        mode === "paper"
            ? "**[PAPER MODE — no real money]**"
            : mode === "shadow"
              ? "**[SHADOW MODE]**"
              : "**[LIVE MODE]**";

    const card = renderPlanCard(plan, {
        include_results: true,
        include_next_prompt: plan.status === "awaiting_approval",
    });
    const executed = plan.steps.filter((s) => s.status === "ok" || s.status === "failed");
    const pending = plan.steps.filter((s) => s.status === "pending");

    const lines: string[] = [
        modeBadge,
        "",
        "## Execution Status Report",
        "",
        "### A) Strategy status",
        `- **Plan**: ${plan.summary}`,
        `- **Status**: ${plan.status}`,
        `- **Mode**: ${mode}`,
        `- **Monitoring**: NO background monitoring — conditional entries are **GTC limit orders** on the exchange.`,
        "",
        "### B) Order status",
        card,
        "",
    ];

    if (executed.length) {
        lines.push("### C) Executed steps (why each ran)");
        for (const step of executed) {
            const why = step.description ?? step.action;
            const err =
                step.status === "failed" && step.result?.error
                    ? ` — error: ${String(step.result.error).slice(0, 120)}`
                    : "";
            lines.push(`- **Step ${step.id}** (${step.status}): ${why}${err}`);
        }
        lines.push("");
    }

    if (pending.length) {
        lines.push("### D) Pending / resting orders");
        for (const step of pending) {
            lines.push(
                `- Step ${step.id}: ${step.description ?? step.action} — staged limit/resting order (not auto-monitored)`,
            );
        }
        lines.push("");
    }

    lines.push("### E) Recommendation");
    if (plan.status === "awaiting_approval" && pending.length) {
        lines.push(
            "- Continue: reply **`yes`** for the next order or **`place all`** to batch remaining steps.",
        );
    } else if (executed.length && !pending.length) {
        lines.push("- All planned steps completed or skipped. Review fills above.");
    } else {
        lines.push("- Review the plan card above for current state.");
    }

    const failed = plan.steps.filter((s) => s.status === "failed");
    lines.push("");
    lines.push("### F) Error handling");
    if (failed.length) {
        for (const step of failed) {
            lines.push(
                `- **Step ${step.id} FAILED**: ${step.result?.error ?? "venue rejected the order"} — plan paused; remaining steps not executed.`,
            );
        }
    } else {
        lines.push(
            "- No failed orders this session. If the venue rejects an order (insufficient funds, min notional, API error), I stop execution, report the exact error, keep remaining steps pending, and suggest remediation.",
        );
    }

    lines.push("");
    lines.push("## Key Findings");
    lines.push(
        `- Status: ${plan.status}; ${executed.length} executed, ${pending.length} pending; mode=${mode}.`,
    );

    return [
        await persistFinalMemory(ctx, lines.join("\n"), {
            kind: "plan_status",
            planId: plan.id,
        }),
    ];
}

/**
 * Build the context the LLM continuation decider needs: the next pending
 * write, plan status/summary, remaining-write count, and a compact recent-
 * conversation transcript. Best-effort — never throws.
 */
async function buildContinuationContext(
    ctx: RunPlanModeContext,
    plan: CexPlan,
): Promise<ContinuationClassifierContext> {
    const idx = nextWriteStep(plan);
    const nextStep = idx !== null ? plan.steps[idx] : null;
    const remainingWrites = plan.steps.filter((s) => s.status === "pending").length;
    let recentMessages = "(none)";
    try {
        const mems = await ctx.runtime.messageManager.getMemories({
            roomId: ctx.message.roomId,
            count: 6,
            unique: false,
        });
        const lines = (mems ?? [])
            .slice()
            .reverse()
            .map((m) => {
                const who = m.userId === ctx.message.agentId ? "assistant" : "user";
                const t = String(m.content?.text ?? "")
                    .replace(/\s+/g, " ")
                    .slice(0, 200);
                return t ? `${who}: ${t}` : "";
            })
            .filter(Boolean);
        if (lines.length) recentMessages = lines.join("\n");
    } catch {
        /* best-effort context only */
    }
    return {
        userMessage: String(ctx.message.content?.text ?? ""),
        nextStepAction: nextStep?.action ?? null,
        nextStepDescription: nextStep?.description ?? null,
        planStatus: plan.status,
        planSummary: plan.summary,
        remainingWrites,
        recentMessages,
    };
}

async function applyContinuation(
    ctx: RunPlanModeContext,
    plan: CexPlan,
    parsed: CexContinuationResult,
): Promise<Memory[] | null> {
    if (parsed.command === "CANCEL_PLAN") {
        cancelPlan(plan.id, "user_cancel");
        const text = `Plan cancelled. ${plan.steps.filter((s) => s.status === "ok").length} of ${plan.steps.length} step(s) had already completed.`;
        return [await persistFinalMemory(ctx, text, { kind: "plan_cancel", planId: plan.id })];
    }

    if (parsed.command === "SKIP_STEP") {
        // Skip the next pending write (or the cursor step). Reads
        // would have already auto-executed, so this is almost always
        // a write the user no longer wants.
        const idx = nextWriteStep(plan);
        if (idx === null) {
            const text = "No pending write to skip — the plan has no more approval-gated steps.";
            return [await persistFinalMemory(ctx, text, { kind: "plan_card", planId: plan.id })];
        }
        updatePlan(plan.id, (p) => {
            p.steps[idx].status = "skipped";
            advanceCursor(p);
            p.status = decideStatus(p);
        });
        return await advanceAndRespond(ctx, plan.id);
    }

    // APPROVE_BATCH flips the mode flag and falls through to the
    // execution path. From here on, writes won't pause for further
    // confirmation until the plan completes / fails / is cancelled.
    if (parsed.command === "APPROVE_BATCH") {
        updatePlan(plan.id, (p) => {
            p.approval_mode = "batch";
        });
        return await advanceAndRespond(ctx, plan.id);
    }

    // APPROVE_NEXT — execute the next write.
    if (parsed.command === "APPROVE_NEXT") {
        return await advanceAndRespond(ctx, plan.id);
    }

    if (parsed.command === "EXECUTION_STATUS") {
        return await renderExecutionStatusReport(ctx, plan);
    }

    // DELEGATE — the user deferred the decision to the agent ("you
    // decide" / "use your best judgement"). Do NOT execute and do NOT
    // cancel: re-render the awaiting-approval card for the next pending
    // write with the planned parameters surfaced, and require ONE
    // explicit confirmation before executing. Any defaults were already
    // chosen by the decomposer; the user sees them and confirms or
    // corrects — a vague deferral never silently executes a live write.
    if (parsed.command === "DELEGATE") {
        const idx = nextWriteStep(plan);
        if (idx === null) {
            // Nothing left to approve — just report current status.
            return await renderExecutionStatusReport(ctx, plan);
        }
        const refreshed =
            updatePlan(plan.id, (p) => {
                p.status = "awaiting_approval";
            }) ?? plan;
        const note =
            'You asked me to use my judgement — I\'ll proceed with the next step using the parameters shown below. **Reply "yes" to execute it**, or tell me what to change.';
        const card = await renderPlanCardWithResults(
            refreshed,
            { include_next_prompt: true },
            ctx,
        );
        await emitPlanApprovalModal(ctx, refreshed, idx);
        return [
            await persistFinalMemory(ctx, `${note}\n\n${card}`, {
                kind: "plan_card",
                planId: plan.id,
                awaitingApproval: true,
            }),
        ];
    }

    return null;
}

/**
 * Execute the next ready write (in step_by_step) or all remaining
 * writes (in batch). After each write, mark the result; on failure,
 * bail. Returns the final plan card memory.
 */
async function advanceAndRespond(
    ctx: RunPlanModeContext,
    planId: string,
): Promise<Memory[]> {
    let plan = getActivePlanById(planId);
    if (!plan) {
        return [await persistFinalMemory(ctx, "Your plan has expired. Please send your request again.", { kind: "plan_expired" })];
    }

    // First, drain any parallel reads that became ready (rare on
    // continuation, but possible when a read depended on a write
    // that just completed).
    await executeReadyReads(ctx, planId);
    plan = getActivePlanById(planId) ?? plan;

    while (true) {
        const writeIdx = nextWriteStep(plan);
        if (writeIdx === null) {
            // No more writes — plan complete.
            updatePlan(plan.id, (p) => {
                p.status = decideStatus(p);
            });
            plan = getActivePlanById(planId) ?? plan;
            const card = await renderPlanCardWithResults(plan, {}, ctx);
            return [await persistFinalMemory(ctx, card, { kind: "plan_card", planId })];
        }

        const step = plan.steps[writeIdx];
        updatePlan(plan.id, (p) => {
            p.steps[writeIdx].status = "in_progress";
            p.status = "executing";
        });

        const result = await invokeAction(ctx, step);

        if (result.ok) {
            updatePlan(plan.id, (p) => {
                markStepOk(p, step.id, result.payload);
                advanceCursor(p);
                p.status = decideStatus(p);
            });
        } else {
            updatePlan(plan.id, (p) => {
                markStepFailedAndBail(p, step.id, result.error ?? "unknown error");
            });
            plan = getActivePlanById(planId) ?? plan;
            const card = await renderPlanCardWithResults(plan, {}, ctx);
            return [await persistFinalMemory(ctx, card, { kind: "plan_card", planId })];
        }

        plan = getActivePlanById(planId) ?? plan;

        if (plan.approval_mode === "step_by_step") {
            // Pause here so the user must reply "yes" again before
            // the next write executes.
            const nextIdx = nextWriteStep(plan);
            if (nextIdx !== null) {
                plan = updatePlan(plan.id, (p) => {
                    p.status = "awaiting_approval";
                });
                const card = await renderPlanCardWithResults(plan, { include_next_prompt: true }, ctx);
                // CEX post-PR237 Commit 4 — emit the per-step modal for
                // the NEXT write in the multi-write plan.
                await emitPlanApprovalModal(ctx, plan, nextIdx);
                return [await persistFinalMemory(ctx, card, { kind: "plan_card", planId, awaitingApproval: true })];
            }
            // All writes done.
            plan = updatePlan(plan.id, (p) => {
                p.status = decideStatus(p);
            });
            const card = await renderPlanCardWithResults(plan, {}, ctx);
            return [await persistFinalMemory(ctx, card, { kind: "plan_card", planId })];
        }
        // Batch mode: loop to next write without prompting.
    }
}

// ---------------------------------------------------------------------------
// Action invocation
// ---------------------------------------------------------------------------

interface InvocationResult {
    ok: boolean;
    payload?: unknown;
    error?: string;
}

/**
 * Run the next set of read-only steps in parallel. Bails on the FIRST
 * read failure (consistent with the write bail policy). The plan's
 * cursor is advanced past completed reads.
 */
async function executeReadyReads(
    ctx: RunPlanModeContext,
    planId: string,
): Promise<void> {
    let plan = getActivePlanById(planId);
    if (!plan) return;

    const idxs = readableSteps(plan);
    if (idxs.length === 0) return;

    elizaLogger.info(
        `[CexPlanRunner] executing ${idxs.length} parallel read(s) for plan ${planId}`,
    );

    const stepsToRun = idxs.map((i) => plan!.steps[i]);
    updatePlan(planId, (p) => {
        for (const i of idxs) p.steps[i].status = "in_progress";
    });

    const results = await Promise.all(
        stepsToRun.map(async (step) => ({ step, res: await invokeAction(ctx, step) })),
    );

    updatePlan(planId, (p) => {
        for (const { step, res } of results) {
            if (res.ok) {
                markStepOk(p, step.id, res.payload);
            } else {
                markStepFailedAndBail(p, step.id, res.error ?? "unknown error");
            }
        }
        advanceCursor(p);
        p.status = decideStatus(p);
    });
}

/**
 * Pull the CEX spec provider off the runtime's plugin chain. Mirrors
 * the helper in cexWorkflowMessageHandler.ts so the runner doesn't
 * have to import that 4000-line module.
 */
function getCEXSpecProviderFromRuntime(runtime: IAgentRuntime): CEXSpecProvider | undefined {
    const plugins = (runtime as IAgentRuntime & { plugins?: Plugin[] }).plugins ?? [];
    for (const plugin of plugins) {
        const candidate = (plugin as Plugin & { cexSpecProvider?: CEXSpecProvider }).cexSpecProvider;
        if (candidate) return candidate;
    }
    return undefined;
}

/**
 * Inspect the action's callback content for failure signals. The
 * plugin-cex action shape (createActionErrorResponse) sets
 * `metadata.success: false` AND `metadata.error: { type, message, ... }`
 * on failure. We honor either signal.
 *
 * Production repro 2026-05-21: a multi-order plan ("BTC + ETH limits")
 * had both writes call back with `metadata.success: false` ("client_order_id
 * is required") but the prior callback handler resolved `{ ok: true }`
 * regardless. The user saw ✅ ok in the plan card despite zero venue
 * orders being placed. Critical safety bug.
 */
function isFailureContent(content: Content | undefined): { failed: boolean; message?: string } {
    if (!content) return { failed: false };
    const meta = (content as { metadata?: Record<string, unknown> }).metadata;
    if (meta && typeof meta === "object") {
        if (meta.success === false) {
            const errorObj = meta.error as { message?: unknown } | undefined;
            const message =
                (typeof errorObj?.message === "string" ? errorObj.message : undefined) ??
                (typeof content.text === "string" ? content.text : undefined) ??
                "action reported success=false";
            return { failed: true, message };
        }
    }
    const contentError = (content as { error?: { message?: unknown } }).error;
    if (contentError?.message && typeof contentError.message === "string") {
        return { failed: true, message: contentError.message };
    }
    return { failed: false };
}

/**
 * Fix-T12 step-inlining (post-PR238 UI iter): the deterministic
 * step-result renderer in cexPlanExecutor.renderStepResultBlock reads
 * `payload.orders / fills / positions / accounts / scanned_symbols` at
 * the top level. plugin-cex actions wrap their venue result through
 * createActionResponse + normalizeCEXResultEnvelope, which buries those
 * fields at `content.content.result.result.*`. Promote them to the
 * top level of the payload object so the renderer finds them and emits
 * a full markdown table instead of the action's terse summary text
 * (which would otherwise render as e.g. "Fetched 7 orders from binance.").
 */
function flattenStructuredFields(content: Content): Content {
    const innerContent = (content as { content?: unknown }).content;
    if (!innerContent || typeof innerContent !== "object") return content;
    const venueEnvelope = (innerContent as { result?: unknown }).result;
    if (!venueEnvelope || typeof venueEnvelope !== "object") return content;
    const venueResult = (venueEnvelope as { result?: unknown }).result;
    if (!venueResult || typeof venueResult !== "object") return content;
    const KEYS = ["orders", "fills", "positions", "accounts", "scanned_symbols", "estimated_total_usdt", "walletsReturned", "walletsSkipped"] as const;
    const promoted: Record<string, unknown> = {};
    for (const k of KEYS) {
        const v = (venueResult as Record<string, unknown>)[k];
        if (v !== undefined) promoted[k] = v;
    }
    if (Object.keys(promoted).length === 0) return content;
    return { ...content, ...promoted } as Content;
}

const PLAN_LIMIT_VARIANT_KEYS: ReadonlySet<string> = new Set([
    "limit_limit_gtc",
    "limit_limit_gtd",
    "limit_limit_ioc",
    "limit_limit_fok",
]);

/**
 * Pure core of the plan-path order normalization (exported for tests). Given the current mid price:
 *   1. Fill a missing limit_price — from the leg's `trigger_drop_pct` when present
 *      (limit = mid × (1 − pct/100): the USER'S stated level, with the math logged), else the
 *      legacy conservative placeholder (80% of mid).
 *   2. Convert quote_size → base_size at the (now-known) limit price for Binance limit variants —
 *      Binance limit orders only accept base_size (base = quote / limit, 8 decimals).
 * `trigger_drop_pct` is consumed here and stripped from the venue payload.
 */
export function normalizeLimitOrderParamsAtMid(
    params: Record<string, unknown>,
    midPrice: number | null,
    venue: string,
): { params: Record<string, unknown>; note: string | null } {
    const oc = params.order_configuration;
    if (!oc || typeof oc !== "object") return { params, note: null };
    const ocRecord = oc as Record<string, Record<string, unknown> | undefined>;
    const variantKey = Object.keys(ocRecord).find((k) => PLAN_LIMIT_VARIANT_KEYS.has(k));
    if (!variantKey) return { params, note: null };
    const inner = ocRecord[variantKey];
    if (!inner || typeof inner !== "object") return { params, note: null };

    const filledInner = { ...inner } as Record<string, unknown>;
    const out = { ...params } as Record<string, unknown>;
    let note: string | null = null;

    const lp = filledInner.limit_price;
    const lpMissing = lp === undefined || lp === null || (typeof lp === "string" && lp.trim().length === 0);
    const dropPct = Number.parseFloat(String(out.trigger_drop_pct ?? ""));
    delete out.trigger_drop_pct; // consumed here — never send to the venue
    if (lpMissing && Number.isFinite(midPrice) && (midPrice as number) > 0) {
        const mid = midPrice as number;
        if (Number.isFinite(dropPct) && dropPct > 0 && dropPct < 100) {
            const price = (mid * (1 - dropPct / 100)).toFixed(2);
            filledInner.limit_price = price;
            note = `limit_price ${price} = mid ${mid.toFixed(2)} × (1 − ${dropPct}%)`;
        } else {
            const placeholder = (mid * 0.8).toFixed(2);
            filledInner.limit_price = placeholder;
            note = `limit_price ${placeholder} = mid ${mid.toFixed(2)} × 0.80 (conservative placeholder — no trigger level given)`;
        }
    }

    // Binance limit variants reject quote_size — convert to base_size at the limit price.
    const isBinanceish = venue !== "coinbase";
    const priceNum = Number.parseFloat(String(filledInner.limit_price ?? ""));
    const quoteNum = Number.parseFloat(String(filledInner.quote_size ?? ""));
    const hasBase = typeof filledInner.base_size === "string" && String(filledInner.base_size).trim().length > 0;
    if (isBinanceish && !hasBase && Number.isFinite(quoteNum) && quoteNum > 0 && Number.isFinite(priceNum) && priceNum > 0) {
        const baseSize = (quoteNum / priceNum).toFixed(8);
        delete filledInner.quote_size;
        filledInner.base_size = baseSize;
        note = `${note ? `${note}; ` : ""}base_size ${baseSize} = ${quoteNum} / ${priceNum}`;
    }

    out.order_configuration = { ...ocRecord, [variantKey]: filledInner };
    return { params: out, note };
}

/**
 * Plan-path order normalization (mirror of the legacy applyComposeDefaults): fetch the live mid,
 * then delegate to normalizeLimitOrderParamsAtMid. Fail-soft on any fetch error: fields stay as-is
 * and schema validation surfaces the clean error.
 */
async function fillMissingLimitPrice(
    ctx: RunPlanModeContext,
    params: Record<string, unknown>,
    venue: string,
): Promise<Record<string, unknown>> {
    let mid: number | null = null;
    try {
        const provider = getCEXSpecProviderFromRuntime(ctx.runtime);
        const productId = typeof params.product_id === "string" ? params.product_id : "BTC-USDT";
        const symbol = productId.replace(/-/g, "").toUpperCase();
        const tick = await provider?.fetchBookTicker?.(symbol, venue);
        const bid = tick ? Number.parseFloat(tick.bid) : NaN;
        const ask = tick ? Number.parseFloat(tick.ask) : NaN;
        if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) mid = (bid + ask) / 2;
    } catch (err) {
        elizaLogger.warn(
            `[CexPlanRunner] fillMissingLimitPrice fetchBookTicker threw (fail-soft): ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    const { params: normalized, note } = normalizeLimitOrderParamsAtMid(params, mid, venue);
    if (note) elizaLogger.info(`[CexPlanRunner] compose_default ${note}`);
    return normalized;
}

async function invokeAction(
    ctx: RunPlanModeContext,
    step: CexPlanStep,
): Promise<InvocationResult> {
    if (step.action === CLARIFY_ACTION) {
        // Should never be reached — `clarify` plans are 1-step and
        // returned early from `runPlanModeIfApplicable`.
        return { ok: true };
    }

    const actions = getCEXActions(ctx.runtime);
    const action: Action | undefined = actions.find(
        (a) => a.name === step.action,
    );
    if (!action) {
        return { ok: false, error: `Unknown CEX action: ${step.action}` };
    }

    // For write actions, derive a deterministic client_order_id and
    // stamp it onto the parameters BEFORE invoking the handler.
    // The plugin-cex venue adapters require `client_order_id` —
    // omitting it surfaces as "client_order_id is required" and the
    // venue call never fires. Mirrors what the legacy
    // requestParameterReview path in cexWorkflowMessageHandler.ts does
    // (~line 2426) via CEXSpecProvider.deriveIdempotency.
    const venue =
        typeof step.venue === "string" && step.venue.length > 0 ? step.venue : "binance";
    let augmentedParams = { ...step.parameters } as Record<string, unknown>;

    // Default-fill a missing limit_price on limit-variant create_order legs — same contract as the
    // legacy path's applyComposeDefaults (80% of current mid as a conservative placeholder): the
    // decomposer intentionally omits prices for staged legs ("set trigger in modal"), and without
    // this fill the schema layer rejects the user's APPROVED leg with "limit_price is required"
    // instead of executing it. Fail-soft: on any fetch error the field stays empty and the existing
    // required-field validation surfaces the clean error.
    if (step.action === "create_order") {
        augmentedParams = await fillMissingLimitPrice(ctx, augmentedParams, venue);
    }

    if (step.stake === "write" && !augmentedParams.client_order_id) {
        const provider = getCEXSpecProviderFromRuntime(ctx.runtime);
        try {
            const derived = provider?.deriveIdempotency?.({
                action: step.action,
                venue,
                userId: String(ctx.message.userId),
                locale: "en",
                params: augmentedParams,
            });
            const derivedId =
                derived?.client_order_id ??
                provider?.deriveClientOrderId?.({
                    action: step.action,
                    venue,
                    userId: String(ctx.message.userId),
                    locale: "en",
                    params: augmentedParams,
                });
            if (typeof derivedId === "string" && derivedId.length > 0) {
                augmentedParams = { ...augmentedParams, client_order_id: derivedId };
                if (derived?.intent_hash) {
                    augmentedParams.intent_hash = derived.intent_hash;
                }
                elizaLogger.info(
                    `[CexPlanRunner] derived client_order_id=${derivedId} for plan step ${step.id} action=${step.action}`,
                );
            } else {
                elizaLogger.warn(
                    `[CexPlanRunner] CEXSpecProvider returned no client_order_id for plan step ${step.id}; action will fail at venue`,
                );
            }
        } catch (err) {
            elizaLogger.warn(
                `[CexPlanRunner] deriveClientOrderId threw for plan step ${step.id}: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    // Fix-T3 iter4 (post-PR244): the action memory MUST carry the
    // ORIGINATING USER's id, not the agent's. Action handlers read
    // memory.userId to resolve per-user state — trading mode (Issue
    // 1, T3), wallet balance, fills, positions — so substituting
    // runtime.agentId here meant every "what's my trading mode?" /
    // "show my balance" / etc. queried prefs under the AGENT's id
    // (often a stranded paper row left over from a misrouted
    // set_trading_mode action), not the human user's. CloudWatch
    // confirmed `memory.userId=d13ee77f...` (the Crypto Trader
    // agent's UUID) was the candidate the action handler read,
    // bypassing the email-derived auth userId entirely.
    // M6 iter9 (post-PR249): resolve the HUMAN user via room
    // participants — the non-agent UUID. iter8 CloudWatch confirmed
    // ctx.message.userId == runtime.agentId (the chat session's
    // message memory is keyed by the agent's UUID, not the auth user).
    // The API stores user_trading_preferences under the auth user's
    // account.id (e.g. 42f8204a-...). Without this fix, writes from
    // the chat go to the agent's id; the API never sees them.
    // The room's participant list contains both the agent and the
    // human; pick the first non-agent UUID as the authoritative user.
    let resolvedUserId: UUID = ctx.message.userId;
    try {
        const participants = await ctx.runtime.databaseAdapter.getParticipantsForRoom(
            ctx.message.roomId,
        );
        const human = participants.find(
            (p) => String(p) !== String(ctx.runtime.agentId),
        );
        if (human) resolvedUserId = human;
    } catch (err) {
        elizaLogger.warn(
            `[CexPlanRunner] getParticipantsForRoom failed: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    elizaLogger.info(
        `[CexPlanRunner] invokeAction step=${step.id} action=${step.action} ctx.message.userId=${ctx.message.userId} resolvedUserId=${resolvedUserId} agentId=${ctx.runtime.agentId}`,
    );
    const actionMemory: Memory = {
        id: uuidv4() as UUID,
        userId: resolvedUserId,
        agentId: ctx.runtime.agentId,
        roomId: ctx.message.roomId,
        createdAt: Date.now(),
        content: {
            text: step.description ?? `Plan step ${step.id}: ${step.action}`,
            action: step.action,
            ...augmentedParams,
        } as Content,
    };

    return await new Promise<InvocationResult>((resolve) => {
        let callbackCaptured = false;
        const cb: HandlerCallback = async (content: Content) => {
            callbackCaptured = true;
            const failure = isFailureContent(content);
            if (failure.failed) {
                resolve({ ok: false, error: failure.message });
            } else {
                // Fix-T12 step-inlining (post-PR238 UI iter): the deterministic
                // step-result renderer in cexPlanExecutor expects the
                // structured rows (`orders`, `fills`, `positions`, `accounts`)
                // at the top level of the step payload, but
                // plugin-cex's createTradeAction wraps the venue result two
                // levels deep at `content.content.result.result.*`. Promote
                // the well-known structured fields to the top level so the
                // <details> block renders a full markdown table instead of
                // falling back to the action's terse `text` summary
                // (e.g. "Fetched 7 orders from binance.").
                const flattenedPayload = flattenStructuredFields(content);
                resolve({ ok: true, payload: flattenedPayload });
            }
            return [];
        };
        const handlerParams = {
            ...augmentedParams,
            userId: ctx.message.userId,
            exchange: venue,
        };

        Promise.resolve(
            action.handler(
                ctx.runtime,
                actionMemory,
                {
                    roomId: ctx.message.roomId,
                    agentId: ctx.runtime.agentId,
                    bio: "",
                    lore: "",
                    messageDirections: "",
                    postDirections: "",
                    actors: "",
                    goals: "",
                    recentMessages: "",
                    recentMessagesData: [],
                },
                handlerParams,
                cb,
            ),
        )
            .then((handlerResult) => {
                if (!callbackCaptured) {
                    // The action returned a boolean (legacy contract).
                    // `false` indicates a soft failure path that didn't
                    // invoke the callback. Plugin-cex actions return
                    // `true` on success and `false` on caught errors.
                    if (handlerResult === false) {
                        resolve({ ok: false, error: `${step.action} returned false (likely a caught error; no callback fired)` });
                    } else {
                        resolve({ ok: true, payload: handlerResult });
                    }
                }
            })
            .catch((error: unknown) => {
                resolve({
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            });

        // Safety net — action handler that never resolves the callback
        // AND never returns within 60 s is treated as a failure.
        setTimeout(() => {
            if (!callbackCaptured) {
                resolve({ ok: false, error: `Action ${step.action} timed out` });
            }
        }, 60_000).unref?.();
    });
}

// ---------------------------------------------------------------------------
// Result rendering — deterministic path + LLM fallback (Fix 3)
// ---------------------------------------------------------------------------

/**
 * Walk the plan's `ok` steps. For any step whose payload is missing a
 * pre-rendered `text` field AND whose structured shape isn't one the
 * deterministic renderer (`renderStepResultBlock`) recognizes, ask the
 * LLM to summarize the payload as a markdown table and stamp that text
 * back onto the payload. After this runs, `renderPlanCard(plan, { include_results: true })`
 * will surface inlined blocks for every ok step that has any
 * renderable data.
 *
 * The common case (every plugin-cex callback already emits `text` per
 * Fix 1 / 2 / 4 / 4b) makes ZERO LLM calls.
 */
async function enrichPlanResultsWithLLMFallback(
    plan: CexPlan,
    runtime: IAgentRuntime,
    userId: UUID,
): Promise<void> {
    for (const step of plan.steps) {
        if (step.status !== "ok") continue;
        const payload = step.result?.payload;
        if (!payload || typeof payload !== "object") continue;
        // Already renderable via the deterministic path → nothing to do.
        if (renderStepResultBlock(step) !== null) continue;
        // Payload has nothing structured → skip; the row's Notes column
        // already carries the description.
        if (!hasAnyStructuredRows(payload as Record<string, unknown>)) continue;

        try {
            const fallbackText = await formatPlanResultViaLLM(
                step.action,
                payload as Record<string, unknown>,
                runtime,
                userId,
            );
            if (fallbackText) {
                (payload as Record<string, unknown>).text = fallbackText;
            }
        } catch (err) {
            elizaLogger.warn(
                `[CexPlanRunner] LLM fallback formatter failed for step ${step.id}: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }
}

function hasAnyStructuredRows(payload: Record<string, unknown>): boolean {
    for (const key of ["accounts", "orders", "fills", "positions"]) {
        const v = payload[key];
        if (Array.isArray(v) && v.length > 0) return true;
    }
    return false;
}

/**
 * Last-resort markdown-table summarizer. Only called when an `ok`
 * step's payload has structured rows but no `text` field AND no
 * recognized deterministic shape. Returns null on any LLM error so
 * the caller can fall back gracefully (the plan card still renders
 * with the row + Notes column; just no inlined block).
 *
 * Exported for visibility but the orchestrator (`enrichPlanResultsWithLLMFallback`)
 * is the only call site.
 */
export async function formatPlanResultViaLLM(
    actionName: string,
    payload: Record<string, unknown>,
    runtime: IAgentRuntime,
    userId: UUID,
): Promise<string | null> {
    let serialized: string;
    try {
        serialized = JSON.stringify(payload, null, 2);
    } catch {
        return null;
    }
    // Cap payload size — pathological cases (e.g. 1000 fills) would
    // blow out the context window. ~4 KB is enough for typical
    // shapes and the truncation marker keeps the LLM honest.
    if (serialized.length > 4000) {
        serialized = `${serialized.slice(0, 4000)}\n…[payload truncated for summarizer]`;
    }

    const system =
        "You are a deterministic markdown formatter. Convert the JSON payload into a single concise markdown table. No prose, no preamble, no closing commentary — table only.";
    const prompt = `Action: ${actionName}\n\nPayload JSON:\n\`\`\`json\n${serialized}\n\`\`\`\n\nReturn ONE markdown table summarizing the rows. Keep at most 25 rows. Omit columns whose values are all null/undefined.`;

    const response = await generateText({
        runtime,
        system,
        prompt,
        modelClass: ModelClass.SMALL,
        userId,
        temperature: 0,
        maxTokens: 768,
        thinkingBudget: 0,
    });
    const trimmed = response.trim();
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * Synthesize a structured execution-status REPORT from a completed reads-only plan's step
 * payloads. Replaces the raw plan card ONLY for execution-status queries (isExecutionStatusQuery):
 * users asking "check the executing status" expect strategy/order/performance/risk status plus a
 * recommendation, not a data dump with margin-wallet skip notes.
 *
 * Honesty constraints enforced in the prompt: only facts present in the payloads (no invented
 * prices/PnL/market data), and NO claim that monitoring is active — status is point-in-time,
 * refreshed only when the user asks. Returns null on any error so the caller falls back to the
 * plan card (fail-open; never blocks the response).
 */
export async function synthesizeStatusReportViaLLM(
    plan: CexPlan,
    ctx: RunPlanModeContext,
): Promise<string | null> {
    try {
        // Serialize PER-STEP with individual caps — a single global truncation let the large
        // orders/fills payloads crowd the small ticker/balance payloads out of the prompt, so the
        // synthesis honestly (but wrongly) reported "live mark was not fetched" while get_ticker
        // had succeeded.
        const perStepCap = 1400;
        const serializeOne = (s: (typeof plan.steps)[number]): string => {
            const entry = {
                action: s.action,
                status: s.status,
                description: s.description,
                payload: s.status === "ok" ? (s.result?.payload ?? null) : (s.result?.error ?? null),
            };
            try {
                const j = JSON.stringify(entry);
                return j.length > perStepCap ? `${j.slice(0, perStepCap)}…[step payload truncated]` : j;
            } catch {
                return JSON.stringify({ action: s.action, status: s.status, payload: "[unserializable]" });
            }
        };
        const serialized = `[${plan.steps.map(serializeOne).join(",\n")}]`;
        const mode = await resolveExecutionMode(ctx);
        // Recover the strategy context (name / user-modified vs recommended / plan status) from the
        // room's most recent plan-card memory, so section A can be factual instead of omitted.
        let strategyContext = "";
        try {
            const recents = await ctx.runtime.messageManager.getMemories({ roomId: ctx.message.roomId, count: 12, unique: false });
            const planCard = (recents ?? []).find((m) => {
                const md = (m.content?.metadata ?? {}) as Record<string, unknown>;
                const pr = md.cexPlanRunner as Record<string, unknown> | undefined;
                return pr?.kind === "plan_card";
            });
            if (planCard) strategyContext = String(planCard.content?.text ?? "").slice(0, 400);
        } catch {
            /* best-effort — section A states honestly when absent */
        }
        const system = [
            "You are a precise trading-status reporter for a crypto agent. Write a CONCISE execution status report in markdown from the JSON step results — every section 1-3 lines, total under ~2,500 characters.",
            "Use EXACTLY these sections (when a section's data is absent, keep the heading and state in ONE honest line what is missing):",
            "**A. Strategy status** — strategy name, agent-recommended vs user-modified, plan state (completed/awaiting/paused), trading mode. Derive from the strategy context below when present.",
            "**B. Order status** — each order: side, symbol, quantity, price, USD value, status (filled/open/cancelled), short order ID. Cross-reference every order against the APPROVED plan in the strategy context: for each approved tranche state which plan step it fulfils, and for any filled order whose ID is NOT part of the approved plan, explicitly flag it as '⚠️ unrecognized — not part of the approved plan' and note it may be stale/leftover — do NOT present it as an approved trade.",
            "**C. Performance** — total deployed USD, average entry, current value + unrealized PnL ONLY if mark/ticker data is present; else say a live mark was not fetched.",
            "**D. Market update** — REQUIRED: state (1) the current mark price and its position vs the user's average entry, (2) the 24h trend direction — bullish if change_pct_24h > 0, bearish if < 0, neutral if ~flat, (3) the 24h high/low as rough resistance/support, and (4) short-term momentum. DERIVE all of these from the ticker's 24h stats in the JSON (change_pct_24h, high_24h, low_24h). Do not invent numbers, but you MUST report the trend whenever those 24h fields are present; only write 'live trend data unavailable' if they are genuinely absent.",
            "**E. Risk status** — capital deployed vs the $-limit and remaining balance (from the balance payload when present); leverage only if shown.",
            "**F. Recommendation** — ONE practical next step phrased as a USER action in second person (e.g. \"You may want to place a stop-loss order\", \"Ask me for a status update anytime\"). NEVER phrase it as something the agent/system will do on its own — no \"Monitor the position\", \"I will watch\", or any phrasing implying background monitoring exists.",
            `Execution mode is ${mode.toUpperCase()}.`,
            "HONESTY RULES (non-negotiable): use ONLY facts in the JSON/context — never invent prices, PnL, market trends, or data not present. NEVER claim monitoring/alerts are active: there is NO background monitoring system; this status is point-in-time and refreshes only when the user asks. No guaranteed-profit language.",
        ].join("\n");
        const prompt = `User asked: ${String(ctx.message.content?.text ?? "").slice(0, 300)}\n${strategyContext ? `\nStrategy context (most recent plan card):\n${strategyContext}\n` : ""}\nStep results JSON:\n\`\`\`json\n${serialized}\n\`\`\`\n\nWrite the status report now.`;
        const response = await generateText({
            runtime: ctx.runtime,
            system,
            prompt,
            modelClass: ModelClass.MEDIUM,
            userId: ctx.message.userId,
            temperature: 0.1,
            // A–F status report (strategy, orders, performance, market, risk,
            // recommendation) was truncating after "B. Order status" at 1024 — the
            // per-step eval scored step5 0/3 for an incomplete report. Give it room.
            maxTokens: 3072,
            thinkingBudget: 0,
            bypassModelClassDowngrades: true,
        });
        const trimmed = response.trim();
        if (!trimmed) return null;
        // Wave-1 contract: paper/shadow replies surface the mode badge deterministically.
        const badge =
            mode === "paper"
                ? "**[PAPER MODE — no real money]**\n\n"
                : mode === "shadow"
                  ? "**[SHADOW MODE — hypothetical execution]**\n\n"
                  : "";
        return badge + trimmed;
    } catch (err) {
        elizaLogger.warn(
            `[CexPlanRunner] status-report synthesis failed (falling back to plan card): ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
    }
}

/**
 * Render the final plan card with deterministic step result blocks,
 * falling back to the LLM summarizer only for `ok` steps whose payload
 * has structured rows but no `text` field or recognized shape. This
 * is the helper to call from any place that previously did
 * `renderPlanCard(plan)` for a terminal/awaiting-approval card and
 * wants inlined results.
 */
async function renderPlanCardWithResults(
    plan: CexPlan,
    opts: { include_next_prompt?: boolean; include_results?: boolean },
    ctx: RunPlanModeContext,
): Promise<string> {
    const includeResults =
        opts.include_results ?? (plan.status === "completed" || plan.status === "failed");
    if (includeResults) {
        await enrichPlanResultsWithLLMFallback(plan, ctx.runtime, ctx.message.userId);
    }
    return renderPlanCard(plan, opts);
}

// ---------------------------------------------------------------------------
// Memory persistence helper
// ---------------------------------------------------------------------------

async function persistFinalMemory(
    ctx: RunPlanModeContext,
    text: string,
    metadata: { kind: string; planId?: string; awaitingApproval?: boolean },
): Promise<Memory> {
    // Wave-1 mode-disclosure contract: every plan card states the trading mode up front (the
    // per-step eval failed the modified-strategy turn solely on the missing paper/live confirmation).
    if (metadata.kind === "plan_card" && !/\*\*\[(PAPER|SHADOW|LIVE)/.test(text)) {
        try {
            const mode = await resolveExecutionMode(ctx);
            const badge =
                mode === "paper"
                    ? "**[PAPER MODE — no real money]**\n\n"
                    : mode === "shadow"
                      ? "**[SHADOW MODE — hypothetical execution]**\n\n"
                      : "**[LIVE MODE]**\n\n";
            text = badge + text;
        } catch {
            /* badge is best-effort — never block the card */
        }
    }
    // When the plan is `awaiting_approval`, set the same metadata
    // markers the legacy CEX clarification flow uses:
    //   - `source: "cex_workflow"` (already set)
    //   - `cexAwaitingClarification: true`
    //   - `cexRequestId: <planId>`
    // The runtime's CEX deterministic bypass predicate
    // (`isCexContinuationMemory` in cexBypassPredicate.ts) requires
    // either flag to recognize the next user reply as a CEX
    // continuation and route it back to the CEX handler — without
    // these the plan runner never sees the "yes" reply.
    const cexContinuationMeta = metadata.awaitingApproval
        ? {
              cexAwaitingClarification: true as const,
              cexRequestId: metadata.planId ?? null,
          }
        : {};

    const memory: Memory = {
        id: uuidv4() as UUID,
        userId: ctx.runtime.agentId,
        agentId: ctx.runtime.agentId,
        roomId: ctx.message.roomId,
        createdAt: Date.now(),
        content: {
            text,
            action: null,
            source: "cex_workflow",
            inReplyTo: ctx.message.id,
            markdown: true,
            metadata: {
                responseFormat: "markdown",
                isMarkdownFormatted: true,
                success: true,
                classification: "CEX_WORKFLOW_MESSAGE",
                cexPlanRunner: metadata,
                ...cexContinuationMeta,
            },
        },
    };

    try {
        await ctx.runtime.messageManager.createMemory(memory);
    } catch (err) {
        elizaLogger.warn(
            `[CexPlanRunner] failed to persist final memory: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    ctx.intermediateResponseCallback?.(memory);
    if (ctx.callback) {
        await ctx.callback({
            text: memory.content.text,
            action: null,
            source: memory.content.source,
            markdown: true,
            metadata: memory.content.metadata,
        });
    }
    return memory;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Pick a sensible default venue for the plan-time validator chain.
 * Walks the steps in order and returns the first non-null `venue`.
 * Falls back to "binance" when no step specifies one — matches the
 * decomposer template's documented fallback ("when venue is null,
 * default to Binance rules"), so the validators evaluate against the
 * same venue the executor would.
 */
function inferDefaultVenue(plan: CexPlan): string {
    for (const step of plan.steps) {
        if (typeof step.venue === "string" && step.venue.length > 0) {
            return step.venue;
        }
    }
    return "binance";
}

function planHasValidationReads(plan: CexPlan): boolean {
    const firstWrite = plan.steps.findIndex((s) => s.action === "create_order");
    if (firstWrite <= 0) {
        return false;
    }
    const prefix = plan.steps.slice(0, firstWrite);
    return prefix.some(
        (s) =>
            s.action === "run_backtest"
            || s.action === "compile_strategy"
            || s.action === "get_balance",
    );
}

function isModifiedStrategyRequest(text: string): boolean {
    return /\b(modify|modified|execute this|hybrid dca|drops?\s+\d+%|buy\s+\$\d+)/i.test(
        text,
    );
}

/**
 * Deterministic guarantee for execution-status queries: the status report NEEDS a live mark
 * (PnL/market section) and the balance (remaining capital) — the LLM decomposer's template
 * mandates these reads but sometimes omits them. Inject any missing read so section C/D/E of the
 * report always have data (the per-step eval failed step5 on exactly this).
 */
function injectStatusReadsIfNeeded(plan: CexPlan, messageText: string): CexPlan {
    if (!isExecutionStatusQuery(messageText)) return plan;
    const actions = new Set(plan.steps.map((s) => s.action));
    const missing: Array<{ id: string; action: string; parameters: Record<string, unknown>; description: string }> = [];
    if (!actions.has("get_ticker")) missing.push({ id: "sr-ticker", action: "get_ticker", parameters: { product_ids: ["BTCUSDT"] }, description: "Live mark price for performance/market sections" });
    if (!actions.has("get_balance")) missing.push({ id: "sr-balance", action: "get_balance", parameters: {}, description: "Remaining capital for the risk section" });
    if (!actions.has("get_orders")) missing.push({ id: "sr-orders", action: "get_orders", parameters: { history: true }, description: "Filled + open orders" });
    if (!missing.length) return plan;
    elizaLogger.info(`[CexPlanRunner] injecting ${missing.length} status read(s) for status query plan ${plan.id}: ${missing.map((m) => m.action).join(", ")}`);
    return {
        ...plan,
        steps: [
            ...plan.steps,
            ...missing.map((m) => inflateStep({ id: m.id, action: m.action, venue: null, parameters: m.parameters, depends_on: [], description: m.description })),
        ],
    };
}

function injectValidationStepsIfNeeded(plan: CexPlan, messageText: string): CexPlan {
    if (planHasValidationReads(plan) || !isModifiedStrategyRequest(messageText)) {
        return plan;
    }
    elizaLogger.info(
        `[CexPlanRunner] injecting validation reads before writes for modified strategy plan ${plan.id}`,
    );
    const balanceStep = inflateStep({
        id: "v1",
        action: "get_balance",
        venue: null,
        parameters: {},
        depends_on: [],
        description: "Verify available capital before executing modified strategy",
    });
    return {
        ...plan,
        steps: [balanceStep, ...plan.steps],
    };
}

function getActivePlanById(planId: string): CexPlan | null {
    try {
        return updatePlan(planId, () => {
            /* no-op read */
        });
    } catch {
        return null;
    }
}

/**
 * CEX post-PR237 Commit 4 — Emit a `human_input_required` SSE step
 * for a multi-step plan that has paused for approval. This step is a
 * UI affordance only: the actual continuation flows through the chat
 * input pipeline (a "yes" / "approve all remaining" message), not the
 * `submitHumanInputApproval` REST endpoint. The frontend dismisses the
 * modal locally on Confirm and dispatches the corresponding chat
 * message.
 *
 * Skipped when:
 *   - No streaming callback is wired (legacy synchronous callers).
 *   - The plan is single-write (the existing card + "yes" prompt
 *     already covers that UX without modal noise).
 */
async function emitPlanApprovalModal(
    ctx: RunPlanModeContext,
    plan: CexPlan,
    writeIdx: number,
): Promise<void> {
    if (!ctx.streamingCallback) return;

    const writeStepIdxs = plan.steps
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => s.stake !== "read")
        .map(({ i }) => i);

    const totalWrites = writeStepIdxs.length;
    if (totalWrites <= 1) return;

    const positionAmongWrites = writeStepIdxs.indexOf(writeIdx);
    if (positionAmongWrites < 0) return;

    const stepSummaries = plan.steps.map((s) => {
        const inflated = inflateStep(s);
        const action = inflated?.action ?? s.action ?? "(unknown)";
        const productId =
            (inflated?.parameters?.product_id as string | undefined) ??
            (s.parameters?.product_id as string | undefined);
        return productId ? `${action} ${productId}` : action;
    });

    const step = plan.steps[writeIdx];
    const inflated = inflateStep(step);
    let params =
        (inflated?.parameters as Record<string, unknown> | undefined) ??
        step.parameters ??
        {};

    // #6b — Pre-compute the concrete limit_price (trigger_drop_pct × live
    // mid) and convert quote_size→base_size BEFORE rendering the approval
    // modal, so each staged limit leg shows the ACTUAL price/size the user
    // is approving (e.g. "-5% of current") instead of a blank "Set a limit
    // price" field. Persist the result back to the plan step so the plan
    // card AND the post-approval execution use exactly the values the user
    // reviewed — no drift between the review-time mid and the execute-time
    // mid (execution's own fillMissingLimitPrice is then a no-op because
    // limit_price is present and trigger_drop_pct has been consumed).
    // Fail-soft: on any fetch error the field stays blank and execution
    // still fills it, matching prior behavior.
    const modalAction = inflated?.action ?? step.action;
    if (modalAction === "create_order") {
        const venueForFill =
            (typeof step.venue === "string" && step.venue.length > 0
                ? step.venue
                : (ctx as { defaultExchangeId?: string }).defaultExchangeId) ??
            "binance";
        try {
            const filled = await fillMissingLimitPrice(
                ctx,
                { ...params },
                venueForFill,
            );
            if (JSON.stringify(filled) !== JSON.stringify(params)) {
                params = filled;
                updatePlan(plan.id, (p) => {
                    p.steps[writeIdx] = {
                        ...p.steps[writeIdx],
                        parameters: filled,
                    };
                });
                elizaLogger.info(
                    `[CexPlanRunner] modal prefill: computed limit_price/base_size for step ${writeIdx + 1} and persisted to plan ${plan.id}`,
                );
            }
        } catch (err) {
            elizaLogger.warn(
                `[CexPlanRunner] modal limit-price prefill failed (fail-soft): ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    // Fix-NEW1 (post-PR242 iter2) — diagnostic: log what we're sending
    // to the frontend modal so the next deploy reveals whether the
    // empty Pair/Price/Amount issue is a backend params problem or a
    // frontend mapping problem.
    elizaLogger.info(
        `[CexPlanRunner] emitPlanApprovalModal step=${writeIdx + 1}/${totalWrites} action=${step.action} param_keys=${Object.keys(params).join(",") || "(none)"} product_id=${typeof params.product_id === "string" ? params.product_id : "(missing)"} has_order_config=${params.order_configuration ? "yes" : "no"}`,
    );

    // Fix-T14 (post-PR238 UI iter) — per-step market snapshot enrichment.
    // Without this the multi-step modal's MarketSnapshotPanel renders
    // empty and the form fields stay unpopulated, because the single-
    // order path (cexWorkflowMessageHandler.requestParameterReview) was
    // the only place buildMarketSnapshot was called. Mirror that path
    // here so each step in a multi-write plan gets its own bid/ask
    // panel + initialPrice flowing to TradingOrderEditor.
    const enrichmentEnabled =
        ctx.runtime.getSetting?.("CEX_APPROVAL_MODAL_ENRICHMENT_ENABLED") === "true";
    const WRITE_ACTIONS = new Set([
        "create_order",
        "amend_order",
        "cancel_order",
        "preview_order",
    ]);
    let marketSnapshot: unknown;
    let symbolVerification: unknown;
    const stepAction = inflated?.action ?? step.action;
    if (enrichmentEnabled && WRITE_ACTIONS.has(stepAction)) {
        const productId =
            typeof params.product_id === "string"
                ? (params.product_id as string)
                : typeof params.symbol === "string"
                  ? (params.symbol as string)
                  : undefined;
        // Fix-M1 iter6 (post-PR246): use plan.source_message (the ORIGINAL
        // multi-order prompt captured at plan creation) instead of
        // ctx.message — on step 2+ ctx.message is the user's "yes"
        // continuation, which lacks the asset mention buildSymbolVerification
        // needs. symbol_verification would otherwise return matches=false
        // and hard-disable Confirm BUY on the second-and-onward step modal.
        const promptText =
            (typeof plan.source_message === "string" && plan.source_message.length > 0
                ? plan.source_message
                : typeof ctx.message?.content?.text === "string"
                  ? ctx.message.content.text
                  : "");
        const binanceSymbol = resolveBinanceSymbol(productId, productId);
        if (binanceSymbol && promptText) {
            try {
                const provider = getCEXSpecProviderFromRuntime(ctx.runtime);
                const venue =
                    (step.venue as string | undefined) ??
                    (ctx as { defaultExchangeId?: string }).defaultExchangeId ??
                    "binance";
                const enrichment = await buildMarketSnapshot({
                    provider,
                    symbol: binanceSymbol,
                    promptText,
                    actionParams: params,
                    actionName: stepAction,
                    venue,
                });
                if (enrichment.market_snapshot) {
                    marketSnapshot = enrichment.market_snapshot;
                }
                if (enrichment.symbol_verification) {
                    symbolVerification = enrichment.symbol_verification;
                }
                elizaLogger.info(
                    `[Trading] ${JSON.stringify({
                        stage: "approval_modal_enriched",
                        venue,
                        symbol: binanceSymbol,
                        plan_step: positionAmongWrites + 1,
                        snapshot_built: Boolean(enrichment.market_snapshot),
                    })}`,
                );
            } catch (err) {
                elizaLogger.warn(
                    `[CexPlanRunner] modal enrichment failed (fail-soft): ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }
    }

    ctx.streamingCallback({
        id: uuidv4(),
        timestamp: Date.now(),
        name: "human_input_required",
        status: "pending",
        message: `Plan step ${positionAmongWrites + 1} of ${totalWrites} — review and approve.`,
        data: {
            type: "human_input_required",
            threadId: plan.id,
            approvalId: `${plan.id}:${step.id}`,
            interruptType: "plan_step_review",
            title: `Approve plan step ${positionAmongWrites + 1} of ${totalWrites}`,
            description:
                "Reply 'yes' to run this step, 'no' to cancel the plan, or use 'Approve All Remaining' to run every remaining write without further prompts.",
            confirmationsRequired: 1,
            confirmationLevel: 1,
            fields: params,
            fieldSchema: {},
            actionName: inflated?.action ?? step.action,
            ...(marketSnapshot ? { market_snapshot: marketSnapshot } : {}),
            ...(symbolVerification ? { symbol_verification: symbolVerification } : {}),
            plan_context: {
                plan_id: plan.id,
                step_index: positionAmongWrites,
                total_steps: totalWrites,
                step_summaries: stepSummaries,
                approve_all_supported: true,
                approval_mode: plan.approval_mode,
            },
        },
    });
}

/**
 * Extract the first balanced JSON object from a string. Mirrors the
 * classifier's extractor — we don't trust the model to omit prose
 * around the JSON.
 */
function extractJsonObject(s: string): string | null {
    const fenced = s.match(/```json\s*([\s\S]*?)\s*```/);
    if (fenced?.[1]?.trim()) return fenced[1].trim();
    const trimmed = s.trim();
    if (trimmed.startsWith("{")) return trimmed;
    for (let start = trimmed.indexOf("{"); start !== -1; start = trimmed.indexOf("{", start + 1)) {
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < trimmed.length; i++) {
            const ch = trimmed[i];
            if (inString) {
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (ch === "\\") {
                    escaped = true;
                    continue;
                }
                if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') {
                inString = true;
                continue;
            }
            if (ch === "{") {
                depth++;
                continue;
            }
            if (ch === "}") {
                depth--;
                if (depth === 0) {
                    const candidate = trimmed.slice(start, i + 1);
                    try {
                        JSON.parse(candidate);
                        return candidate;
                    } catch {
                        break;
                    }
                }
                if (depth < 0) break;
            }
        }
    }
    return null;
}
