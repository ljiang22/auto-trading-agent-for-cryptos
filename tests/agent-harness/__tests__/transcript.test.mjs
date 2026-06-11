import { describe, expect, it } from "vitest";
import {
    createTranscriptState,
    ingestEvent,
    computePhaseLatencies,
    collectActionNamesFromPlanCardText,
} from "../lib/transcript.mjs";
import { evaluateExpectations } from "../lib/assertions.mjs";

describe("transcript requestId", () => {
    it("captures cexRequestId from response metadata", () => {
        const state = createTranscriptState();
        ingestEvent(
            {
                type: "intermediate_response",
                response: {
                    user: "assistant",
                    text: "ok",
                    content: { metadata: { cexRequestId: "req-abc-123" } },
                },
            },
            state,
        );
        expect(state.cexRequestId).toBe("req-abc-123");
        expect(state.requestId).toBe("req-abc-123");
    });

    it("computes phase latencies from events", () => {
        const state = createTranscriptState();
        state.startedAt = 1000;
        state.events = [
            { at: 0, event: { type: "step", step: { name: "start" } } },
            {
                at: 500,
                event: {
                    type: "intermediate_response",
                    response: { user: "assistant", text: "hi" },
                },
            },
            { at: 2000, event: { type: "step", step: { name: "done" } } },
        ];
        const lat = computePhaseLatencies(state);
        expect(lat.ttfbMs).toBe(500);
        expect(lat.totalStreamMs).toBe(2000);
    });
});

describe("plan-runner action detection", () => {
    const planCardText =
        "**Plan**: Fetch balances\n**Mode**: step_by_step\n**Status**: completed\n\n| # | Status | Action | Venue | Notes |\n|---|--------|--------|-------|-------|\n| 1 | ok | get_balance | binance | spot |\n| 2 | ok | get_balance | binance | cross |\n";

    it("extracts actions from plan-card markdown table", () => {
        const names = collectActionNamesFromPlanCardText(planCardText);
        expect([...names]).toEqual(["get_balance"]);
    });

    it("detects get_balance from cexPlanRunner response without step events", () => {
        const state = createTranscriptState();
        ingestEvent(
            {
                type: "intermediate_response",
                response: {
                    user: "assistant",
                    text: planCardText,
                    metadata: {
                        classification: "CEX_WORKFLOW_MESSAGE",
                        cexPlanRunner: { kind: "plan_card", planId: "plan-1" },
                    },
                },
            },
            state,
        );
        ingestEvent(
            {
                type: "action_response",
                response: {
                    user: "assistant",
                    text: planCardText,
                    metadata: {
                        cexPlanRunner: { kind: "plan_card", planId: "plan-1" },
                    },
                },
            },
            state,
        );
        expect([...state.actionNamesSeen]).toContain("get_balance");
        expect(state.sawActionExecutionSignal).toBe(true);
        expect(state.events.filter((e) => e.event.type === "step")).toHaveLength(0);
    });

    it("passes expectedActions for plan-card balance transcript", () => {
        const state = createTranscriptState();
        ingestEvent(
            {
                type: "intermediate_response",
                response: {
                    user: "assistant",
                    text: planCardText,
                    metadata: {
                        cexPlanRunner: { kind: "plan_card", planId: "plan-1" },
                    },
                },
            },
            state,
        );
        const failures = evaluateExpectations({
            transcript: state,
            expect: {
                expectedActions: ["get_balance"],
                expectActionExecution: true,
            },
            caseDef: {},
        });
        expect(failures).toEqual([]);
    });

    it("collects actions from actionResults on response", () => {
        const state = createTranscriptState();
        ingestEvent(
            {
                type: "intermediate_response",
                response: {
                    user: "assistant",
                    text: "done",
                    actionResults: [{ action: "get_orders" }],
                },
            },
            state,
        );
        expect([...state.actionNamesSeen]).toContain("get_orders");
    });
});
