import { describe, expect, it } from "vitest";
import {
    computeLatencyBreakdown,
    buildStepTimeline,
    computeStepDurations,
    extractVenueCallsFromAudit,
    summarizeVenueCalls,
} from "../lib/latency.mjs";
import { createTranscriptState, ingestEvent, recordClientCall } from "../lib/transcript.mjs";

function buildTranscript(events, extras = {}) {
    const state = createTranscriptState();
    state.startedAt = 1_000;
    for (const event of events) {
        state.events.push(event);
    }
    Object.assign(state, extras);
    return state;
}

describe("computeLatencyBreakdown", () => {
    it("computes approval flow phase durations", () => {
        const transcript = buildTranscript(
            [
                { at: 100, event: { type: "step", step: { name: "Trading: preprocess", data: { type: "trading_preprocess" } } } },
                {
                    at: 500,
                    event: {
                        type: "step",
                        step: {
                            name: "human_input_required",
                            data: { type: "cex_workflow_parameter_review_required", action: "create_order" },
                        },
                    },
                },
                {
                    at: 900,
                    event: {
                        type: "step",
                        step: {
                            name: "cex_workflow_execute_action",
                            data: { type: "trading_execute_action", action: "create_order" },
                        },
                    },
                },
                {
                    at: 1200,
                    event: {
                        type: "intermediate_response",
                        response: { user: "assistant", text: "Order placed" },
                    },
                },
            ],
            {
                markers: { approvalPromptAt: 500 },
                clientCalls: [
                    { kind: "cex_approval", confirmationLevel: 1, offsetMs: 650, durationMs: 80, ok: true },
                ],
            },
        );

        const breakdown = computeLatencyBreakdown(transcript);
        expect(breakdown.phases.messageToApprovalPromptMs).toBe(500);
        expect(breakdown.phases.approvalPromptToSubmitMs).toBe(150);
        expect(breakdown.phases.approvalSubmitApiMs).toBe(80);
        expect(breakdown.phases.approvalSubmitToFirstEventMs).toBe(170);
        expect(breakdown.phases.approvalSubmitToFinalResponseMs).toBe(470);
        expect(breakdown.phases.actionExecutionMs).toBe(300);
        expect(breakdown.steps.length).toBe(3);
    });

    it("computes read-only action execution without approval phases", () => {
        const transcript = buildTranscript([
            { at: 50, event: { type: "step", step: { name: "Trading: preprocess", data: { type: "trading_preprocess" } } } },
            {
                at: 200,
                event: {
                    type: "step",
                    step: {
                        name: "cex_workflow_execute_action",
                        data: { type: "trading_execute_action", action: "get_orders" },
                    },
                },
            },
            {
                at: 800,
                event: {
                    type: "intermediate_response",
                    response: { user: "assistant", text: "No open orders" },
                },
            },
        ]);

        const breakdown = computeLatencyBreakdown(transcript);
        expect(breakdown.phases.messageToApprovalPromptMs).toBeNull();
        expect(breakdown.phases.approvalSubmitApiMs).toBeNull();
        expect(breakdown.phases.messageToFirstStepMs).toBe(50);
        expect(breakdown.phases.messageToFinalResponseMs).toBe(800);
        expect(breakdown.phases.actionExecutionMs).toBe(600);
    });

    it("computes plan-card latency without steps", () => {
        const state = createTranscriptState();
        state.startedAt = 1_000;
        ingestEvent(
            {
                type: "intermediate_response",
                response: {
                    user: "assistant",
                    text: "**Status**: completed\n| 1 | ok | get_balance | binance |",
                    metadata: { cexPlanRunner: { kind: "plan_card" } },
                },
            },
            state,
        );

        const breakdown = computeLatencyBreakdown(state);
        expect(breakdown.phases.messageToPlanCardMs).toBeGreaterThanOrEqual(0);
        expect(breakdown.steps).toHaveLength(0);
    });
});

describe("step timeline helpers", () => {
    it("builds step durations from event gaps", () => {
        const timeline = buildStepTimeline([
            { at: 0, event: { type: "step", step: { name: "a", data: { type: "t1" } } } },
            { at: 100, event: { type: "step", step: { name: "b", data: { type: "t2", action: "get_balance" } } } },
            { at: 250, event: { type: "intermediate_response", response: { user: "assistant", text: "ok" } } },
        ]);
        const withDurations = computeStepDurations(timeline, 250);
        expect(withDurations[0].durationMs).toBe(100);
        expect(withDurations[1].durationMs).toBe(150);
        expect(withDurations[1].action).toBe("get_balance");
    });
});

describe("venue call audit helpers", () => {
    it("extracts and summarizes venue_call latencies", () => {
        const calls = extractVenueCallsFromAudit([
            { stage: "risk_check", decision: "allow" },
            { stage: "venue_call", endpoint: "/api/v3/order", method: "POST", latency_ms: 120 },
            { stage: "venue_call", endpoint: "/api/v3/openOrders", method: "GET", latency_ms: 45 },
        ]);
        expect(calls).toHaveLength(2);
        const summary = summarizeVenueCalls(calls);
        expect(summary.totalMs).toBe(165);
        expect(summary.maxMs).toBe(120);
        expect(summary.count).toBe(2);
    });
});

describe("recordClientCall", () => {
    it("stores timed client calls on transcript", () => {
        const state = createTranscriptState();
        recordClientCall(state, {
            kind: "cex_approval",
            offsetMs: 10,
            durationMs: 25,
            ok: true,
        });
        expect(state.clientCalls).toHaveLength(1);
        expect(state.clientCalls[0].durationMs).toBe(25);
    });
});
