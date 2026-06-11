import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    INTERRUPT_APPROVAL_DEBOUNCE_MS,
    buildApprovalBody,
    getPendingPlanInterrupt,
    interruptDedupeKey,
    interruptLevelKey,
    isHumanInputInterruptStep,
    isLegacyCexApprovalStep,
    parseInterruptStep,
    planContinuationText,
    recordLatestInterrupt,
    resolveInterrupt,
    shouldApproveInterrupt,
    shouldSendPlanContinuation,
    waitForWorkflowIdle,
} from "../lib/humanInputInterrupt.mjs";
import { createTranscriptState } from "../lib/transcript.mjs";
import { createCombinedHookHandler } from "../lib/hooks.mjs";

const SAMPLE_CREATE_ORDER_STEP = {
    name: "human_input_required",
    status: "pending",
    data: {
        type: "human_input_required",
        threadId: "00d7d102-e6ae-4fd0-964e-ae89f5ebed8f",
        approvalId: "bae71595-deb7-4c59-8d7e-2d2bcf3b29e3",
        interruptType: "cex_workflow_parameter_review_required",
        confirmationLevel: 1,
        actionName: "create_order",
        fields: {
            product_id: "BTC-USDT",
            side: "BUY",
            order_configuration: { market_market_ioc: { quote_size: "6.00" } },
        },
    },
};

const SAMPLE_PLAN_STEP = {
    name: "human_input_required",
    status: "pending",
    data: {
        type: "human_input_required",
        threadId: "room-1",
        approvalId: "plan-1:step-1",
        interruptType: "plan_step_review",
        confirmationLevel: 1,
        actionName: "set_trading_mode",
        plan_context: {
            plan_id: "plan-1",
            step_index: 0,
            total_steps: 2,
        },
    },
};

describe("humanInputInterrupt", () => {
    it("parseInterruptStep extracts dedup_context when present", () => {
        const parsed = parseInterruptStep({
            name: "human_input_required",
            status: "pending",
            data: {
                type: "human_input_required",
                threadId: "room-1",
                approvalId: "dedup-1",
                interruptType: "cex_dedup_override_required",
                confirmationLevel: 1,
                dedup_context: {
                    kind: "unknown_state",
                    existing_order: {
                        client_order_id: "bn-abc",
                        venue: "binance",
                        symbol: "BTC-USDT",
                        state: "unknown",
                        submitted_at: "2026-06-05T10:00:00.000Z",
                        last_seen_at: "2026-06-05T10:00:05.000Z",
                    },
                    warning: "reconciliation pending",
                    title: "Previous order status unknown",
                    action_guidance: "Check /orders",
                },
            },
        });
        expect(parsed?.interruptType).toBe("cex_dedup_override_required");
        expect(parsed?.dedup_context?.kind).toBe("unknown_state");
        expect(parsed?.dedup_context?.title).toBe("Previous order status unknown");
        expect(parsed?.dedup_context?.action_guidance).toBe("Check /orders");
    });

    it("parseInterruptStep extracts approvalId from human_input_required", () => {
        const parsed = parseInterruptStep(SAMPLE_CREATE_ORDER_STEP);
        expect(parsed?.approvalId).toBe("bae71595-deb7-4c59-8d7e-2d2bcf3b29e3");
        expect(parsed?.threadId).toBe("00d7d102-e6ae-4fd0-964e-ae89f5ebed8f");
        expect(parsed?.actionName).toBe("create_order");
    });

    it("parseInterruptStep includes fieldSchema when present", () => {
        const parsed = parseInterruptStep({
            ...SAMPLE_CREATE_ORDER_STEP,
            data: {
                ...SAMPLE_CREATE_ORDER_STEP.data,
                fieldSchema: {
                    product_id: { type: "string", required: true },
                },
            },
        });
        expect(parsed?.fieldSchema?.product_id?.required).toBe(true);
    });

    it("isHumanInputInterruptStep matches confirm step", () => {
        expect(
            isHumanInputInterruptStep({
                name: "human_input_confirm_required",
                data: { type: "human_input_confirm_required" },
            }),
        ).toBe(true);
    });

    it("buildApprovalBody merges compose params on approve", () => {
        const interrupt = parseInterruptStep(SAMPLE_CREATE_ORDER_STEP);
        const body = buildApprovalBody(
            {
                approvalTemplates: {
                    confirmationLevel1: { decision: "approved", parameters: {} },
                    spot_market_market_ioc_buy: {
                        parameters: { product_id: "BTC-USDT", side: "BUY" },
                    },
                },
                caseDef: {
                    approvalTemplateKey: "spot_market_market_ioc_buy",
                    compose: {
                        params: {
                            exchange: "binance",
                            client_order_id: "harness-test",
                        },
                    },
                },
            },
            interrupt,
            "approved",
        );
        expect(body.decision).toBe("approved");
        expect(body.parameters?.exchange).toBe("binance");
        expect(body.parameters?.client_order_id).toBe("harness-test");
        expect(body.approvalId).toBe(interrupt.approvalId);
    });

    it("buildApprovalBody uses rejectionTemplate when approvalDecision rejected", () => {
        const interrupt = parseInterruptStep(SAMPLE_CREATE_ORDER_STEP);
        const body = buildApprovalBody(
            {
                approvalTemplates: {
                    rejectionTemplate: {
                        decision: "rejected",
                        feedback: "no thanks",
                    },
                },
                caseDef: { approvalDecision: "rejected" },
            },
            interrupt,
            "rejected",
        );
        expect(body.decision).toBe("rejected");
        expect(body.feedback).toBe("no thanks");
    });

    it("resolveInterrupt returns plan continuation for plan_context", async () => {
        const interrupt = parseInterruptStep(SAMPLE_PLAN_STEP);
        const result = await resolveInterrupt(
            { caseDef: {}, client: {}, roomId: "room-1" },
            interrupt,
            "approved",
        );
        expect(result.kind).toBe("plan_continuation");
        expect(result.text).toBe("yes");
    });

    it("planContinuationText uses batch when planApproval batch", () => {
        expect(planContinuationText({ planApproval: "batch" })).toBe(
            "approve all remaining steps",
        );
    });

    it("shouldSendPlanContinuation when awaiting approval plan interrupt", () => {
        const transcript = createTranscriptState();
        transcript.lastAssistantText =
            "**Status**: awaiting_approval\n| 1 | pending | set_trading_mode |";
        transcript.events.push({
            at: 10,
            event: { type: "step", step: SAMPLE_PLAN_STEP },
        });
        expect(
            shouldSendPlanContinuation(transcript, {}, ["cexAutoApprove"]),
        ).toBe(true);
    });

    it("getPendingPlanInterrupt finds last plan step", () => {
        const transcript = createTranscriptState();
        transcript.events.push({
            at: 1,
            event: { type: "step", step: SAMPLE_PLAN_STEP },
        });
        const pending = getPendingPlanInterrupt(transcript);
        expect(pending?.interruptType).toBe("plan_step_review");
    });

    it("interruptDedupeKey is stable", () => {
        expect(interruptDedupeKey("abc", 1)).toBe("abc:L1");
    });

    describe("latest-interrupt tracking", () => {
        it("shouldApproveInterrupt rejects stale approvalId after supersede", () => {
            const tracker = new Map();
            const a = {
                threadId: "room-1",
                approvalId: "approval-a",
                confirmationLevel: 1,
            };
            const b = {
                threadId: "room-1",
                approvalId: "approval-b",
                confirmationLevel: 1,
            };
            recordLatestInterrupt(tracker, a);
            expect(shouldApproveInterrupt(tracker, a)).toBe(true);
            recordLatestInterrupt(tracker, b);
            expect(shouldApproveInterrupt(tracker, a)).toBe(false);
            expect(shouldApproveInterrupt(tracker, b)).toBe(true);
        });

        it("interruptLevelKey is stable per thread and level", () => {
            expect(interruptLevelKey("room-1", 1)).toBe("room-1:L1");
            expect(interruptLevelKey("room-1", 2)).toBe("room-1:L2");
        });
    });

    describe("hook human-input approval", () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it("resolves human_input_required via postHumanInputApproval", async () => {
            const postHumanInputApproval = vi.fn().mockResolvedValue({ success: true });
            const getActiveWorkflow = vi
                .fn()
                .mockResolvedValue({ active: true, kind: "cex" });
            const client = {
                postHumanInputApproval,
                getActiveWorkflow,
                postCexApproval: vi.fn(),
            };
            const handler = createCombinedHookHandler(["cexAutoApprove"], {
                client,
                roomId: "room-1",
                approvalTemplates: {
                    confirmationLevel1: { decision: "approved", parameters: {} },
                },
                caseDef: {},
                transcript: createTranscriptState(),
            });
            const pending = handler({
                type: "step",
                step: SAMPLE_CREATE_ORDER_STEP,
            });
            await vi.advanceTimersByTimeAsync(INTERRUPT_APPROVAL_DEBOUNCE_MS + 10);
            await pending;
            expect(postHumanInputApproval).toHaveBeenCalledTimes(1);
            expect(postHumanInputApproval.mock.calls[0][1].approvalId).toBe(
                "bae71595-deb7-4c59-8d7e-2d2bcf3b29e3",
            );
        });

        it("superseding interrupts POST only the latest approvalId", async () => {
            const postHumanInputApproval = vi.fn().mockResolvedValue({ success: true });
            const getActiveWorkflow = vi
                .fn()
                .mockResolvedValue({ active: true, kind: "cex" });
            const client = {
                postHumanInputApproval,
                getActiveWorkflow,
                postCexApproval: vi.fn(),
            };
            const handler = createCombinedHookHandler(["cexAutoApprove"], {
                client,
                roomId: "room-1",
                approvalTemplates: {
                    confirmationLevel1: { decision: "approved", parameters: {} },
                },
                caseDef: { approvalFormat: "dialog" },
                transcript: createTranscriptState(),
            });
            const stepA = {
                ...SAMPLE_CREATE_ORDER_STEP,
                data: {
                    ...SAMPLE_CREATE_ORDER_STEP.data,
                    approvalId: "approval-a",
                },
            };
            const stepB = {
                ...SAMPLE_CREATE_ORDER_STEP,
                data: {
                    ...SAMPLE_CREATE_ORDER_STEP.data,
                    approvalId: "approval-b",
                },
            };
            const pendingA = handler({ type: "step", step: stepA });
            await vi.advanceTimersByTimeAsync(20);
            const pendingB = handler({ type: "step", step: stepB });
            await vi.advanceTimersByTimeAsync(INTERRUPT_APPROVAL_DEBOUNCE_MS + 10);
            await pendingA;
            await pendingB;
            expect(postHumanInputApproval).toHaveBeenCalledTimes(1);
            expect(postHumanInputApproval.mock.calls[0][1].approvalId).toBe("approval-b");
        });

        it("ignores intent_cross_check telemetry (no approval POST)", async () => {
            const postHumanInputApproval = vi.fn();
            const postCexApproval = vi.fn();
            const handler = createCombinedHookHandler(["cexAutoApprove"], {
                client: {
                    postHumanInputApproval,
                    postCexApproval,
                    getActiveWorkflow: vi.fn(),
                },
                roomId: "room-1",
                approvalTemplates: {
                    confirmationLevel1: { decision: "approved", parameters: {} },
                },
                caseDef: {},
                transcript: createTranscriptState(),
            });
            await handler({
                type: "step",
                step: {
                    name: "intent_cross_check",
                    status: "completed",
                    data: {
                        type: "cex_workflow_parameter_review_required",
                        reason: "intent_value_divergence",
                    },
                },
            });
            await vi.advanceTimersByTimeAsync(INTERRUPT_APPROVAL_DEBOUNCE_MS + 10);
            expect(postHumanInputApproval).not.toHaveBeenCalled();
            expect(postCexApproval).not.toHaveBeenCalled();
        });
    });

    it("waitForWorkflowIdle returns true when room has no active workflow", async () => {
        const client = {
            getActiveWorkflow: vi.fn().mockResolvedValue({ active: false }),
        };
        expect(
            await waitForWorkflowIdle(client, "room-1", { timeoutMs: 500 }),
        ).toBe(true);
    });

    it("isLegacyCexApprovalStep requires approvalId and excludes intent_cross_check", () => {
        expect(
            isLegacyCexApprovalStep({
                name: "intent_cross_check",
                data: { type: "cex_workflow_parameter_review_required" },
            }),
        ).toBe(false);
        expect(
            isLegacyCexApprovalStep({
                name: "cex_workflow_param_review",
                data: {
                    type: "cex_workflow_parameter_review_required",
                    approvalId: "abc",
                },
            }),
        ).toBe(true);
        expect(
            isLegacyCexApprovalStep({
                name: "cex_workflow_param_review",
                data: { type: "cex_workflow_parameter_review_required" },
            }),
        ).toBe(false);
    });
});
