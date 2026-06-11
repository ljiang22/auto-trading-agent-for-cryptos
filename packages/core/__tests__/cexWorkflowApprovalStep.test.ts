import { describe, expect, it } from "vitest";
import { getApprovalRequestCopy } from "../src/handlers/cexStreamMessages";
import { resolveApprovalRequestStepOutcome } from "../src/handlers/cexWorkflowMessageHandler";

describe("approval request step lifecycle", () => {
    it("transitions in_progress to completed when user approves", () => {
        const copy = getApprovalRequestCopy({ mode: "live", locale: "en" });
        const step = resolveApprovalRequestStepOutcome("approved", copy);
        expect(step.status).toBe("completed");
        expect(step.message).toBe(copy.completed);
        expect(step.message).toBe("Authorization received");
    });

    it("transitions in_progress to error when user rejects", () => {
        const copy = getApprovalRequestCopy({ mode: "live", locale: "en" });
        const step = resolveApprovalRequestStepOutcome("rejected", copy);
        expect(step.status).toBe("error");
        expect(step.message).toBe("Authorization declined");
    });

    it("uses zh-CN rejection copy when locale is zh-CN", () => {
        const copy = getApprovalRequestCopy({ mode: "live", locale: "zh-CN" });
        const step = resolveApprovalRequestStepOutcome("rejected", copy, {
            locale: "zh-CN",
        });
        expect(step.status).toBe("error");
        expect(step.message).toBe("已拒绝授权");
    });

    it("transitions to error with failure message on interrupt failure", () => {
        const copy = getApprovalRequestCopy({ mode: "live", locale: "en" });
        const step = resolveApprovalRequestStepOutcome("failed", copy, {
            failureMessage: "SSE connection closed",
        });
        expect(step.status).toBe("error");
        expect(step.message).toBe("SSE connection closed");
    });
});
