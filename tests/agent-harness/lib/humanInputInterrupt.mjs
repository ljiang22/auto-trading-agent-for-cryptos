/**
 * Human-input interrupt resolution for write-stake harness cases.
 * Mirrors UI: poll active-workflow, submit human-input/approval, or plan chat continuation.
 */

import { buildDialogApprovalParameters } from "./dialogApprovalSubmit.mjs";

function pickString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {unknown} step
 */
export function isHumanInputInterruptStep(step) {
    if (!step) {
        return false;
    }
    const name = String(step.name || "").toLowerCase();
    const dataType = String(step.data?.type || "").toLowerCase();
    return (
        name === "human_input_required" ||
        name === "human_input_confirm_required" ||
        dataType === "human_input_required" ||
        dataType === "human_input_confirm_required"
    );
}

/**
 * @param {unknown} step
 * @returns {import("./humanInputInterrupt.mjs").ParsedInterrupt | null}
 */
export function parseInterruptStep(step) {
    if (!isHumanInputInterruptStep(step) || !step?.data) {
        return null;
    }
    const data = step.data;
    const threadId = pickString(data.threadId);
    if (!threadId) {
        return null;
    }
    const confirmationLevel = Number(data.confirmationLevel ?? 1);
    return {
        threadId,
        approvalId: pickString(data.approvalId) ?? undefined,
        confirmationLevel: confirmationLevel === 2 ? 2 : 1,
        interruptType: pickString(data.interruptType) ?? undefined,
        actionName: pickString(data.actionName) ?? undefined,
        fields:
            data.fields && typeof data.fields === "object" ? data.fields : undefined,
        fieldSchema:
            data.fieldSchema && typeof data.fieldSchema === "object"
                ? data.fieldSchema
                : undefined,
        plan_context:
            data.plan_context && typeof data.plan_context === "object"
                ? data.plan_context
                : undefined,
        dedup_context:
            data.dedup_context && typeof data.dedup_context === "object"
                ? data.dedup_context
                : undefined,
        stepStatus: pickString(step.status) ?? undefined,
    };
}

/**
 * @typedef {Object} ParsedInterrupt
 * @property {string} threadId
 * @property {string} [approvalId]
 * @property {1 | 2} confirmationLevel
 * @property {string} [interruptType]
 * @property {string} [actionName]
 * @property {Record<string, unknown>} [fields]
 * @property {Record<string, { type?: string, required?: boolean, injected?: boolean }>} [fieldSchema]
 * @property {Record<string, unknown>} [plan_context]
 * @property {Record<string, unknown>} [dedup_context]
 * @property {string} [stepStatus]
 */

/**
 * @param {string} approvalId
 * @param {number} confirmationLevel
 */
export function interruptDedupeKey(approvalId, confirmationLevel) {
    return `${approvalId || "no-id"}:L${confirmationLevel}`;
}

/**
 * @param {string} threadId
 * @param {number} confirmationLevel
 */
export function interruptLevelKey(threadId, confirmationLevel) {
    return `${threadId}:L${confirmationLevel}`;
}

/** Debounce window so rapid superseding SSE interrupts collapse to the latest id. */
export const INTERRUPT_APPROVAL_DEBOUNCE_MS = 75;

/** Wait for debounced human-input approval timers to fire after the SSE stream ends. */
export async function awaitInterruptApprovalDebounce() {
    await sleep(INTERRUPT_APPROVAL_DEBOUNCE_MS + 25);
}

/**
 * Legacy CEX modal steps (not human_input_*). Excludes telemetry like intent_cross_check.
 * @param {unknown} step
 */
export function isLegacyCexApprovalStep(step) {
    if (!step?.data) {
        return false;
    }
    const name = String(step.name || "").toLowerCase();
    if (name === "intent_cross_check") {
        return false;
    }
    const approvalId = pickString(step.data?.approvalId);
    const dataType = String(step.data?.type || "").toLowerCase();
    const nameMatch =
        name.includes("cex_workflow_param_review") ||
        name.includes("cex_workflow_param_confirm");
    const typeMatch =
        dataType.includes("cex_workflow_parameter_review_required") ||
        dataType.includes("cex_workflow_parameter_final_confirm_required");
    if (nameMatch || typeMatch) {
        return Boolean(approvalId);
    }
    return false;
}

/**
 * @param {Map<string, string>} tracker
 * @param {ParsedInterrupt} interrupt
 */
export function recordLatestInterrupt(tracker, interrupt) {
    const key = interruptLevelKey(interrupt.threadId, interrupt.confirmationLevel);
    tracker.set(key, interrupt.approvalId ?? "");
}

/**
 * @param {Map<string, string>} tracker
 * @param {ParsedInterrupt} interrupt
 */
export function shouldApproveInterrupt(tracker, interrupt) {
    const key = interruptLevelKey(interrupt.threadId, interrupt.confirmationLevel);
    const latest = tracker.get(key);
    if (latest === undefined) {
        return true;
    }
    if (!interrupt.approvalId) {
        return false;
    }
    return latest === interrupt.approvalId;
}

/**
 * @param {{ approvalTemplates?: Record<string, unknown> | null, caseDef?: Record<string, unknown> }} ctx
 * @param {ParsedInterrupt} interrupt
 * @param {"approved" | "rejected"} defaultDecision
 */
export function buildApprovalBody(ctx, interrupt, defaultDecision) {
    const templates = ctx.approvalTemplates || {};
    const confirmationLevel = interrupt.confirmationLevel;
    const caseDecision = pickString(ctx.caseDef?.approvalDecision);
    const wantReject =
        defaultDecision === "rejected" || caseDecision === "rejected";

    const rejectionTemplate = templates.rejectionTemplate || {
        decision: "rejected",
        feedback: "Rejected by test operator.",
    };

    const fallbackKey =
        confirmationLevel === 2 ? "confirmationLevel2" : "confirmationLevel1";

    let template;
    if (wantReject) {
        template = rejectionTemplate;
    } else {
        const caseTemplateKey = pickString(ctx.caseDef?.approvalTemplateKey);
        template =
            (caseTemplateKey && templates[caseTemplateKey]) ||
            templates[fallbackKey] ||
            {};
    }

    const useDialogFormat = pickString(ctx.caseDef?.approvalFormat) === "dialog";
    /** @type {Record<string, unknown>} */
    let mergedParams = {};
    if (!wantReject) {
        if (useDialogFormat) {
            try {
                mergedParams = buildDialogApprovalParameters({
                    fields: interrupt.fields ?? {},
                    fieldSchema: interrupt.fieldSchema ?? {},
                    actionName: interrupt.actionName,
                    skipPreflight: false,
                });
            } catch (err) {
                console.warn(
                    `[humanInput] dialog approval build failed, falling back to interrupt fields: ${err instanceof Error ? err.message : String(err)}`,
                );
                mergedParams = { ...(interrupt.fields || {}) };
            }
        } else {
            mergedParams = { ...(template.parameters || {}) };
            const caseTemplateKey = pickString(ctx.caseDef?.approvalTemplateKey);
            const caseTemplate =
                caseTemplateKey && templates[caseTemplateKey]
                    ? templates[caseTemplateKey]
                    : null;
            Object.assign(mergedParams, caseTemplate?.parameters || {});
            const composeParams = ctx.caseDef?.compose?.params;
            if (composeParams && typeof composeParams === "object") {
                Object.assign(mergedParams, composeParams);
            }
            if (interrupt.fields && typeof interrupt.fields === "object") {
                Object.assign(mergedParams, interrupt.fields);
            }
        }
    }

    const decision =
        template.decision ||
        (wantReject ? "rejected" : templates.defaults?.decision || "approved");

    return {
        decision,
        confirmationLevel,
        approvalId: interrupt.approvalId,
        feedback:
            template.feedback ||
            templates.defaults?.feedback ||
            (wantReject
                ? "Rejected by agent test harness"
                : "Approved by agent test harness"),
        ...(Object.keys(mergedParams).length > 0 ? { parameters: mergedParams } : {}),
    };
}

/**
 * @param {import("./client.mjs").AgentClient} client
 * @param {string} roomId
 * @param {{ timeoutMs?: number, intervalMs?: number }} [opts]
 */
export async function pollUntilInterruptActive(client, roomId, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 5000;
    const intervalMs = opts.intervalMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const status = await client.getActiveWorkflow(roomId);
        if (status?.active === true && status?.kind === "cex") {
            return status;
        }
        await sleep(intervalMs);
    }
    return null;
}

/**
 * Poll until no active workflow (CEX/comprehensive) is registered for the room.
 * @param {import("./client.mjs").AgentClient} client
 * @param {string} roomId
 * @param {{ timeoutMs?: number, intervalMs?: number }} [opts]
 * @returns {Promise<boolean>} true when idle, false on timeout
 */
export async function waitForWorkflowIdle(client, roomId, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const intervalMs = opts.intervalMs ?? 200;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const status = await client.getActiveWorkflow(roomId);
        if (!status?.active) {
            return true;
        }
        await sleep(intervalMs);
    }
    return false;
}

/**
 * @param {import("./client.mjs").AgentClient} client
 * @param {string} roomId
 * @param {Record<string, unknown>} body
 * @param {ParsedInterrupt} interrupt
 * @param {{ maxAttempts?: number, retryDelayMs?: number }} [opts]
 */
export async function submitHumanInputWithRetry(
    client,
    roomId,
    body,
    interrupt,
    opts = {},
) {
    const maxAttempts = opts.maxAttempts ?? 5;
    const retryDelayMs = opts.retryDelayMs ?? 150;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await pollUntilInterruptActive(client, roomId, {
                timeoutMs: attempt === 1 ? 2000 : 1000,
            });
            return await client.postHumanInputApproval(roomId, {
                threadId: interrupt.threadId,
                approvalId: body.approvalId ?? interrupt.approvalId,
                ...body,
            });
        } catch (err) {
            lastError = err;
            const message = err instanceof Error ? err.message : String(err);
            const retryable = message.includes("404") || message.includes("not found");
            if (!retryable || attempt === maxAttempts) {
                throw err;
            }
            await sleep(retryDelayMs * attempt);
        }
    }
    throw lastError;
}

/**
 * @param {Record<string, unknown>} caseDef
 */
export function planContinuationText(caseDef) {
    const planApproval = pickString(caseDef?.planApproval);
    const tags = (caseDef?.tags || []).map((t) => String(t).toLowerCase());
    if (planApproval === "batch" || tags.includes("plan_batch")) {
        return "approve all remaining steps";
    }
    return "yes";
}

/**
 * @param {{ approvalTemplates?: Record<string, unknown> | null, caseDef?: Record<string, unknown>, client: import("./client.mjs").AgentClient, roomId: string }} ctx
 * @param {ParsedInterrupt} interrupt
 * @param {"approved" | "rejected"} defaultDecision
 */
export async function resolveInterrupt(ctx, interrupt, defaultDecision) {
    if (interrupt.dedup_context || interrupt.interruptType === "cex_dedup_override_required") {
        if (defaultDecision === "rejected") {
            const body = buildApprovalBody(ctx, interrupt, "rejected");
            await submitHumanInputWithRetry(ctx.client, ctx.roomId, body, interrupt);
            return { kind: "human_input_approval", body };
        }
        const body = buildApprovalBody(ctx, interrupt, "approved");
        await submitHumanInputWithRetry(ctx.client, ctx.roomId, body, interrupt);
        return { kind: "human_input_approval", body };
    }

    if (interrupt.plan_context) {
        if (defaultDecision === "rejected") {
            return {
                kind: "plan_continuation",
                text: "no",
            };
        }
        return {
            kind: "plan_continuation",
            text: planContinuationText(ctx.caseDef || {}),
        };
    }

    const body = buildApprovalBody(ctx, interrupt, defaultDecision);
    console.log(
        `[humanInput] ${body.decision} L${body.confirmationLevel} action=${interrupt.actionName || "?"} approvalId=${interrupt.approvalId || "(thread)"}`,
    );
    await submitHumanInputWithRetry(ctx.client, ctx.roomId, body, interrupt);
    return { kind: "human_input_approval", body };
}

/**
 * @param {import("./transcript.mjs").TranscriptState} transcript
 * @returns {ParsedInterrupt | null}
 */
export function getPendingPlanInterrupt(transcript) {
    const events = transcript?.events || [];
    for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]?.event;
        if (!event || event.type !== "step") {
            continue;
        }
        const parsed = parseInterruptStep(event.step);
        if (parsed?.plan_context) {
            return parsed;
        }
    }
    return null;
}

/**
 * @param {import("./transcript.mjs").TranscriptState} transcript
 */
export function isAwaitingPlanApproval(transcript) {
    const text = transcript?.lastAssistantText || "";
    return /\bawaiting_approval\b/i.test(text) || /\bStatus\b[^\n]*\bawaiting\b/i.test(text);
}

const APPROVE_HOOKS = new Set(["cexautoapprove", "humaninputautoapprove"]);

/**
 * @param {string[]} hookNames
 */
function hasApproveHook(hookNames) {
    return (hookNames || []).some((h) => APPROVE_HOOKS.has(String(h).toLowerCase()));
}

/**
 * @param {import("./transcript.mjs").TranscriptState} transcript
 * @param {Record<string, unknown>} caseDef
 * @param {string[]} hookNames
 */
export function shouldSendPlanContinuation(transcript, caseDef, hookNames) {
    if (!hasApproveHook(hookNames)) {
        return false;
    }
    if (transcript?.errorMessage) {
        return false;
    }
    const planInterrupt = getPendingPlanInterrupt(transcript);
    if (!planInterrupt) {
        return false;
    }
    if (!isAwaitingPlanApproval(transcript)) {
        return false;
    }
    const resolved = transcript?.markers?.planContinuationSentFor;
    if (resolved === interruptDedupeKey(planInterrupt.approvalId, planInterrupt.confirmationLevel)) {
        return false;
    }
    return true;
}

/**
 * @param {import("./transcript.mjs").TranscriptState} target
 * @param {import("./transcript.mjs").TranscriptState} source
 */
export function mergeTranscripts(target, source) {
    if (!source) {
        return target;
    }
    const baseOffset = target.events.length > 0
        ? (target.events[target.events.length - 1]?.at ?? 0)
        : 0;
    for (const entry of source.events || []) {
        target.events.push({
            at: baseOffset + entry.at + 1,
            event: entry.event,
        });
    }
    if (source.lastAssistantText) {
        target.lastAssistantText = source.lastAssistantText;
    }
    if (source.errorMessage) {
        target.errorMessage = source.errorMessage;
    }
    if (source.detectedClassification) {
        target.detectedClassification = source.detectedClassification;
    }
    if (typeof source.detectedIsCryptoRelated === "boolean") {
        target.detectedIsCryptoRelated = source.detectedIsCryptoRelated;
    }
    target.stepNames.push(...(source.stepNames || []));
    for (const name of source.actionNamesSeen || []) {
        target.actionNamesSeen.add(name);
    }
    if (source.sawActionExecutionSignal) {
        target.sawActionExecutionSignal = true;
    }
    if (source.requestId) {
        target.requestId = source.requestId;
    }
    if (source.cexRequestId) {
        target.cexRequestId = source.cexRequestId;
    }
    target.approvalPhasesSeen.push(...(source.approvalPhasesSeen || []));
    if (source.riskDecisionFromStream) {
        target.riskDecisionFromStream = source.riskDecisionFromStream;
    }
    target.clientCalls.push(...(source.clientCalls || []));
    if (source.markers?.approvalPromptAt != null && target.markers.approvalPromptAt == null) {
        target.markers.approvalPromptAt = source.markers.approvalPromptAt;
    }
    if (source.markers?.humanInputResolved) {
        target.markers.humanInputResolved = source.markers.humanInputResolved;
    }
    return target;
}
