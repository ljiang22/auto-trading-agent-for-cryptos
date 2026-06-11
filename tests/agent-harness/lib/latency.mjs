/**
 * Per-case latency breakdown from SSE transcripts and harness client calls.
 */

import { isLegacyCexApprovalStep } from "./humanInputInterrupt.mjs";

function pickString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isCEXApprovalStep(step) {
    return isLegacyCexApprovalStep(step);
}

function isApprovalPromptStep(step) {
    if (!step) {
        return false;
    }
    const name = String(step.name || "").toLowerCase();
    const dataType = String(step.data?.type || "").toLowerCase();
    return (
        isCEXApprovalStep(step) ||
        name === "human_input_required" ||
        name === "human_input_confirm_required" ||
        dataType === "human_input_required" ||
        dataType === "human_input_confirm_required" ||
        dataType.includes("cex_workflow_parameter")
    );
}

function isApprovalClientCall(call) {
    return call?.kind === "cex_approval" || call?.kind === "human_input_approval";
}

function isActionExecutionStep(step) {
    if (!step) {
        return false;
    }
    const name = String(step.name || "").toLowerCase();
    const dataType = String(step.data?.type || "").toLowerCase();
    return (
        name.includes("cex_workflow_execute_action") ||
        dataType === "trading_execute_action" ||
        name.includes("trading: order submit") ||
        dataType.includes("order_submit")
    );
}

function isAssistantResponse(event) {
    return event?.type === "intermediate_response" || event?.type === "action_response";
}

/**
 * @param {Array<{ at: number, event: unknown }>} events
 */
export function buildStepTimeline(events) {
    const timeline = [];
    for (const { at, event } of events || []) {
        if (!event || typeof event !== "object" || event.type !== "step") {
            continue;
        }
        const step = event.step;
        timeline.push({
            offsetMs: at,
            name: pickString(step?.name) || "unknown",
            type: pickString(step?.data?.type) || null,
            action: pickString(step?.data?.action) || pickString(step?.data?.actionName) || null,
            status: pickString(step?.status) || null,
        });
    }
    return timeline;
}

/**
 * @param {ReturnType<typeof buildStepTimeline>} timeline
 * @param {number} streamEndAt
 */
export function computeStepDurations(timeline, streamEndAt) {
    return timeline.map((entry, index) => {
        const nextOffset =
            index < timeline.length - 1
                ? timeline[index + 1].offsetMs
                : streamEndAt;
        return {
            ...entry,
            durationMs: Math.max(0, nextOffset - entry.offsetMs),
        };
    });
}

/**
 * @param {import("./transcript.mjs").TranscriptState} transcript
 */
export function computeLatencyBreakdown(transcript) {
    const events = transcript?.events || [];
    const streamEndAt = events[events.length - 1]?.at ?? 0;

    const stepTimeline = computeStepDurations(
        buildStepTimeline(events),
        streamEndAt,
    );

    let firstStepAt = null;
    let firstAssistantAt = null;
    let approvalPromptAt = transcript.markers?.approvalPromptAt ?? null;
    let actionExecutionAt = null;
    let finalResponseAt = null;
    let firstEventAfterApprovalSubmit = null;

    for (const { at, event } of events) {
        if (!event || typeof event !== "object") {
            continue;
        }
        if (event.type === "step" && firstStepAt == null) {
            firstStepAt = at;
        }
        if (isAssistantResponse(event)) {
            if (firstAssistantAt == null) {
                firstAssistantAt = at;
            }
            finalResponseAt = at;
        }
        if (event.type === "step") {
            if (isApprovalPromptStep(event.step) && approvalPromptAt == null) {
                approvalPromptAt = at;
            }
            if (isActionExecutionStep(event.step)) {
                actionExecutionAt = actionExecutionAt ?? at;
            }
        }
    }

    const clientCalls = transcript.clientCalls || [];
    const firstApprovalCall = clientCalls.find((c) => isApprovalClientCall(c));
    const approvalSubmitStartedAt = firstApprovalCall?.offsetMs ?? null;
    const approvalSubmitEndedAt =
        firstApprovalCall != null
            ? firstApprovalCall.offsetMs + (firstApprovalCall.durationMs ?? 0)
            : null;

    if (approvalSubmitEndedAt != null) {
        for (const { at, event } of events) {
            if (at > approvalSubmitEndedAt) {
                firstEventAfterApprovalSubmit = at;
                break;
            }
        }
    }

    const actionExecutionEndAt =
        actionExecutionAt != null
            ? (() => {
                  for (const { at, event } of events) {
                      if (at > actionExecutionAt) {
                          return at;
                      }
                  }
                  return streamEndAt;
              })()
            : null;

    const phases = {
        messageToFirstStepMs: firstStepAt,
        messageToFirstResponseMs: firstAssistantAt,
        messageToFinalResponseMs: finalResponseAt,
        messageToPlanCardMs:
            firstAssistantAt != null && stepTimeline.length === 0
                ? firstAssistantAt
                : null,
        messageToApprovalPromptMs: approvalPromptAt,
        approvalPromptToSubmitMs:
            approvalPromptAt != null && approvalSubmitStartedAt != null
                ? approvalSubmitStartedAt - approvalPromptAt
                : null,
        approvalSubmitApiMs: firstApprovalCall?.durationMs ?? null,
        approvalSubmitToFirstEventMs:
            approvalSubmitEndedAt != null && firstEventAfterApprovalSubmit != null
                ? firstEventAfterApprovalSubmit - approvalSubmitEndedAt
                : null,
        approvalSubmitToFinalResponseMs:
            approvalSubmitEndedAt != null && finalResponseAt != null
                ? finalResponseAt - approvalSubmitEndedAt
                : null,
        actionExecutionMs:
            actionExecutionAt != null && actionExecutionEndAt != null
                ? actionExecutionEndAt - actionExecutionAt
                : null,
        totalStreamMs: streamEndAt,
    };

    return {
        wallClockMs: streamEndAt,
        phases,
        steps: stepTimeline,
        clientCalls,
        eventCount: events.length,
    };
}

/**
 * Backward-compatible summary derived from the detailed breakdown.
 * @param {import("./transcript.mjs").TranscriptState} state
 */
export function computePhaseLatenciesFromBreakdown(state) {
    const breakdown = computeLatencyBreakdown(state);
    const { phases, eventCount } = breakdown;

    let riskCheckAtMs = null;
    let approvalAtMs = null;
    for (const step of breakdown.steps) {
        const name = step.name.toLowerCase();
        const type = String(step.type || "").toLowerCase();
        if (riskCheckAtMs == null && (name.includes("risk") || type.includes("risk"))) {
            riskCheckAtMs = step.offsetMs;
        }
        if (
            approvalAtMs == null &&
            (type.includes("cex_workflow_parameter") ||
                type === "human_input_required" ||
                name.includes("human_input"))
        ) {
            approvalAtMs = step.offsetMs;
        }
    }

    return {
        ttfbMs: phases.messageToFirstResponseMs ?? phases.messageToFirstStepMs,
        totalStreamMs: phases.totalStreamMs,
        riskCheckAtMs,
        approvalAtMs,
        eventCount,
        phases,
    };
}

/**
 * @param {object[]} auditEvents CloudWatch [Trading] events for a case
 */
export function extractVenueCallsFromAudit(auditEvents) {
    const calls = [];
    for (const ev of auditEvents || []) {
        if (ev.stage !== "venue_call") {
            continue;
        }
        calls.push({
            endpoint: ev.endpoint ?? ev.path ?? null,
            method: ev.method ?? null,
            latency_ms:
                typeof ev.latency_ms === "number" ? ev.latency_ms : null,
            http_status: ev.http_status ?? null,
        });
    }
    return calls;
}

/**
 * @param {object[]} venueCalls
 */
export function summarizeVenueCalls(venueCalls) {
    const latencies = venueCalls
        .map((c) => c.latency_ms)
        .filter((n) => typeof n === "number" && Number.isFinite(n));
    if (latencies.length === 0) {
        return { totalMs: null, maxMs: null, count: 0 };
    }
    return {
        totalMs: latencies.reduce((a, b) => a + b, 0),
        maxMs: Math.max(...latencies),
        count: latencies.length,
    };
}
