/**
 * Accumulate SSE events and derived fields for assertions and reporting.
 */

import { computePhaseLatenciesFromBreakdown } from "./latency.mjs";
import { isHumanInputInterruptStep, isLegacyCexApprovalStep } from "./humanInputInterrupt.mjs";

const CLASSIFICATION_TYPES = new Set([
    "REGULAR_MESSAGE",
    "CEX_WORKFLOW_MESSAGE",
    "TASK_CHAIN_MESSAGE",
    "COMPREHENSIVE_ANALYSIS_MESSAGE",
]);

function pickString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function tryParseJsonObject(value) {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed;
        }
    } catch {
        return null;
    }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
        try {
            const parsed = JSON.parse(trimmed.slice(start, end + 1));
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed;
            }
        } catch {
            return null;
        }
    }
    return null;
}

export function extractClassificationFromText(text) {
    if (!text) {
        return null;
    }
    const parsed = tryParseJsonObject(text);
    const candidate =
        pickString(parsed?.classification) ||
        pickString(parsed?.type) ||
        pickString(parsed?.messageType);
    if (!candidate) {
        return null;
    }
    const normalized = candidate.toUpperCase();
    return CLASSIFICATION_TYPES.has(normalized) ? normalized : null;
}

export function extractIsCryptoRelatedFromText(text) {
    const parsed = tryParseJsonObject(text);
    if (!parsed) {
        return null;
    }
    if (typeof parsed.isCryptoRelated === "boolean") {
        return parsed.isCryptoRelated;
    }
    return null;
}

/** Matches plan-card step table rows: | 1 | ok | get_balance | binance | */
const PLAN_TABLE_ACTION_RE = /\|\s*\d+\s*\|\s*[^|]*\|\s*([a-z][a-z0-9_]*)\s*\|/gi;

export function collectActionNamesFromPlanCardText(text) {
    const names = new Set();
    if (!text) {
        return names;
    }
    for (const match of text.matchAll(PLAN_TABLE_ACTION_RE)) {
        names.add(match[1].toLowerCase());
    }
    return names;
}

export function collectActionNamesFromActionResults(response) {
    const names = new Set();
    const results = response?.actionResults ?? response?.content?.actionResults;
    if (!Array.isArray(results)) {
        return names;
    }
    for (const entry of results) {
        const action =
            pickString(entry?.action) ||
            pickString(entry?.actionName) ||
            pickString(entry?.name);
        if (action) {
            names.add(action.toLowerCase());
        }
    }
    return names;
}

export function collectActionNamesFromStep(step) {
    const names = new Set();
    const directName = pickString(step?.name);
    if (directName && directName !== "chain_approval_required") {
        names.add(directName.toLowerCase());
    }
    const data = step?.data;
    if (data && typeof data === "object") {
        const candidates = [
            data.actionName,
            data.action,
            data.name,
            data.toolName,
            data.action_type,
        ];
        for (const candidate of candidates) {
            const normalized = pickString(candidate);
            if (normalized) {
                names.add(normalized.toLowerCase());
            }
        }
        if (Array.isArray(data.actions)) {
            for (const entry of data.actions) {
                if (typeof entry === "string") {
                    names.add(entry.trim().toLowerCase());
                    continue;
                }
                const nested =
                    pickString(entry?.name) ||
                    pickString(entry?.actionName) ||
                    pickString(entry?.action);
                if (nested) {
                    names.add(nested.toLowerCase());
                }
            }
        }
    }
    return names;
}

function isApprovalPromptStep(step) {
    if (!step) {
        return false;
    }
    return isLegacyCexApprovalStep(step) || isHumanInputInterruptStep(step);
}

function ingestAssistantResponse(response, state) {
    const text = pickString(response?.text) || pickString(response?.content?.text);
    if (response?.user !== "assistant" || !text) {
        return;
    }
    state.lastAssistantText = text;

    const meta = response.metadata || response.content?.metadata;
    const cls =
        pickString(meta?.classification) || extractClassificationFromText(text);
    if (cls) {
        state.detectedClassification = cls;
    }
    if (typeof meta?.isCryptoRelated === "boolean") {
        state.detectedIsCryptoRelated = meta.isCryptoRelated;
    } else {
        const parsed = extractIsCryptoRelatedFromText(text);
        if (typeof parsed === "boolean") {
            state.detectedIsCryptoRelated = parsed;
        }
    }
    const rid =
        pickString(meta?.requestId) ||
        pickString(meta?.request_id) ||
        pickString(meta?.cexRequestId);
    if (rid) {
        state.requestId = rid;
        state.cexRequestId = rid;
    }

    for (const name of collectActionNamesFromActionResults(response)) {
        state.actionNamesSeen.add(name);
    }
    for (const name of collectActionNamesFromPlanCardText(text)) {
        state.actionNamesSeen.add(name);
    }
    if (
        meta?.cexPlanRunner?.kind === "plan_card" &&
        /\bStatus\b[^\n]*\bcompleted\b/i.test(text)
    ) {
        state.sawActionExecutionSignal = true;
    }
}

/**
 * @param {unknown} event
 * @param {import("./transcript.mjs").TranscriptState} state
 */
export function ingestEvent(event, state) {
    state.events.push({
        at: Date.now() - state.startedAt,
        event,
    });

    if (!event || typeof event !== "object") {
        return;
    }

    if (event.type === "intermediate_response") {
        ingestAssistantResponse(event.response, state);
    } else if (event.type === "action_response") {
        ingestAssistantResponse(event.response, state);
    } else if (event.type === "step") {
        const step = event.step;
        const eventAt = Date.now() - state.startedAt;
        if (isApprovalPromptStep(step)) {
            markApprovalPrompt(state, eventAt);
        }
        if (step?.name) {
            state.stepNames.push(String(step.name));
        }
        for (const name of collectActionNamesFromStep(step)) {
            state.actionNamesSeen.add(name);
        }
        const stepName = String(step?.name || "").toLowerCase();
        const dataType = String(step?.data?.type || "").toLowerCase();
        if (
            stepName.includes("action") ||
            dataType.includes("action") ||
            stepName.includes("execute")
        ) {
            state.sawActionExecutionSignal = true;
        }
        const stepData = step?.data;
        if (stepData && typeof stepData === "object") {
            const rid =
                pickString(stepData.requestId) ||
                pickString(stepData.request_id) ||
                pickString(stepData.cexRequestId);
            if (rid) {
                state.requestId = rid;
                state.cexRequestId = rid;
            }
            if (
                stepName.includes("parameter_review_rejected") ||
                stepName.includes("parameter_final_confirm_rejected") ||
                dataType.includes("parameter_review_rejected") ||
                dataType.includes("parameter_final_confirm_rejected") ||
                dataType.includes("human_input_rejected") ||
                stepName.includes("human_input_rejected")
            ) {
                state.approvalPhasesSeen.push(stepName || dataType);
            }
            if (
                (stepName === "human_input_required" ||
                    stepName === "human_input_confirm_required" ||
                    dataType === "human_input_required" ||
                    dataType === "human_input_confirm_required") &&
                stepData.plan_context
            ) {
                state.markers.pendingPlanInterrupt = true;
            }
            if (dataType.includes("risk") || stepName.includes("risk check")) {
                const decision = pickString(stepData.decision) || pickString(stepData.verdict);
                if (decision) {
                    state.riskDecisionFromStream = decision.toLowerCase();
                }
            }
        }
    } else if (event.type === "error") {
        state.errorMessage =
            typeof event.error === "string"
                ? event.error
                : event.error?.message
                  ? String(event.error.message)
                  : JSON.stringify(event.error);
    }
}

/**
 * @returns {TranscriptState}
 */
export function createTranscriptState() {
    return {
        startedAt: Date.now(),
        events: [],
        lastAssistantText: null,
        errorMessage: null,
        detectedClassification: null,
        detectedIsCryptoRelated: null,
        stepNames: [],
        actionNamesSeen: new Set(),
        sawActionExecutionSignal: false,
        requestId: null,
        cexRequestId: null,
        approvalPhasesSeen: [],
        riskDecisionFromStream: null,
        clientCalls: [],
        markers: {},
    };
}

/**
 * @param {TranscriptState} state
 * @param {{ kind: string, confirmationLevel?: number, offsetMs: number, durationMs: number, ok?: boolean }} entry
 */
export function recordClientCall(state, entry) {
    state.clientCalls.push(entry);
}

/**
 * @param {TranscriptState} state
 * @param {number} offsetMs
 */
export function markApprovalPrompt(state, offsetMs) {
    if (state.markers.approvalPromptAt == null) {
        state.markers.approvalPromptAt = offsetMs;
    }
}

/**
 * Derive phase latency gaps from transcript events (ms offsets from stream start).
 * @param {TranscriptState} state
 */
export function computePhaseLatencies(state) {
    return computePhaseLatenciesFromBreakdown(state);
}

function pickClientOrderId(obj) {
    if (!obj || typeof obj !== "object") {
        return null;
    }
    return pickString(obj.clientOrderId) || pickString(obj.client_order_id);
}

function pickVenueOrderId(obj) {
    if (!obj || typeof obj !== "object") {
        return null;
    }
    return pickString(obj.orderId) || pickString(obj.order_id);
}

function walkOrderRefs(node, targetClientId, venueIds, seen) {
    if (!node || typeof node !== "object") {
        return;
    }
    if (Array.isArray(node)) {
        for (const item of node) {
            walkOrderRefs(item, targetClientId, venueIds, seen);
        }
        return;
    }
    const clientId = pickClientOrderId(node);
    const venueId = pickVenueOrderId(node);
    if (clientId === targetClientId && venueId && !seen.has(venueId)) {
        seen.add(venueId);
        venueIds.push(venueId);
    }
    for (const value of Object.values(node)) {
        walkOrderRefs(value, targetClientId, venueIds, seen);
    }
}

/**
 * Find venue order_id values linked to a harness client_order_id in stream events.
 * @param {TranscriptState | { events?: unknown[], lastAssistantText?: string | null }} transcript
 * @param {string} clientOrderId
 * @returns {string[]}
 */
export function extractOrderRefsFromTranscript(transcript, clientOrderId) {
    if (!clientOrderId || !transcript) {
        return [];
    }
    const venueIds = [];
    const seen = new Set();
    for (const wrapped of transcript.events || []) {
        const event = wrapped?.event ?? wrapped;
        walkOrderRefs(event, clientOrderId, venueIds, seen);
    }
    const parsed = tryParseJsonObject(transcript.lastAssistantText);
    if (parsed) {
        walkOrderRefs(parsed, clientOrderId, venueIds, seen);
    }
    return venueIds;
}

/**
 * @param {TranscriptState | { events?: unknown[], lastAssistantText?: string | null }} transcript
 * @param {string[]} clientOrderIds
 * @returns {Record<string, string[]>}
 */
export function extractHarnessOrderRefsFromTranscript(transcript, clientOrderIds) {
    /** @type {Record<string, string[]>} */
    const out = {};
    for (const clientOrderId of clientOrderIds || []) {
        out[clientOrderId] = extractOrderRefsFromTranscript(transcript, clientOrderId);
    }
    return out;
}

/**
 * @typedef {Object} TranscriptState
 * @property {number} startedAt
 * @property {Array<{ at: number, event: unknown }>} events
 * @property {string | null} lastAssistantText
 * @property {string | null} errorMessage
 * @property {string | null} detectedClassification
 * @property {boolean | null} detectedIsCryptoRelated
 * @property {string[]} stepNames
 * @property {Set<string>} actionNamesSeen
 * @property {boolean} sawActionExecutionSignal
 * @property {string | null} requestId
 * @property {string | null} cexRequestId
 * @property {string[]} approvalPhasesSeen
 * @property {string | null} riskDecisionFromStream
 * @property {Array<{ kind: string, confirmationLevel?: number, offsetMs: number, durationMs: number, ok?: boolean }>} clientCalls
 * @property {{ approvalPromptAt?: number, humanInputResolved?: boolean, pendingPlanInterrupt?: boolean | string, planContinuationSentFor?: string }} markers
 */
