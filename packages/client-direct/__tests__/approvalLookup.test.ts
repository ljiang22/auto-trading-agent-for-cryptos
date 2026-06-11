import { describe, expect, it, vi } from "vitest";
import type { UUID } from "@elizaos/core";
import {
    getPendingApprovalContext,
    validatePendingApprovalDecision,
    type PendingApprovalContext,
    type RuntimeWithPendingApprovalMaps,
} from "../src/approvalLookup.ts";

const AGENT_ID = "11111111-1111-4111-8111-111111111111" as UUID;
const USER_ID = "22222222-2222-4222-8222-222222222222" as UUID;
const OTHER_USER_ID = "33333333-3333-4333-8333-333333333333" as UUID;
const THREAD_ID = "thread-1";

function buildContext(overrides: Partial<PendingApprovalContext> = {}): PendingApprovalContext {
    return {
        approvalId: "approval-1",
        threadId: THREAD_ID,
        agentId: AGENT_ID,
        userId: USER_ID,
        expectedLevel: 1,
        resolve: vi.fn(),
        createdAt: Date.now(),
        ...overrides,
    };
}

describe("approval lookup compatibility", () => {
    it("prefers pending human-input map for legacy cex endpoint", () => {
        const context = buildContext();
        const runtime: RuntimeWithPendingApprovalMaps = {
            __pendingHumanInputApprovals: new Map([[`${THREAD_ID}:${context.approvalId}`, context]]),
            __pendingCEXWorkflowApprovals: new Map(),
        };
        const result = getPendingApprovalContext(runtime, THREAD_ID, context.approvalId, [
            "__pendingHumanInputApprovals",
            "__pendingCEXWorkflowApprovals",
        ]);
        expect(result.pendingContext).toBe(context);
        expect(result.mapKey).toBe("__pendingHumanInputApprovals");
    });

    it("returns 404 when pending context is missing", () => {
        const validationError = validatePendingApprovalDecision(
            undefined,
            AGENT_ID,
            USER_ID,
            1,
            "Pending CEX workflow approval context not found",
            "No pending CEX workflow approval for this threadId",
            "CEX workflow approval does not belong to the current user"
        );
        expect(validationError).toEqual({
            status: 404,
            body: {
                error: "Pending CEX workflow approval context not found",
                details: "No pending CEX workflow approval for this threadId",
            },
        });
    });

    it("returns 403 when pending context belongs to another user", () => {
        const context = buildContext({ userId: OTHER_USER_ID });
        const validationError = validatePendingApprovalDecision(
            context,
            AGENT_ID,
            USER_ID,
            1,
            "Pending CEX workflow approval context not found",
            "No pending CEX workflow approval for this threadId",
            "CEX workflow approval does not belong to the current user"
        );
        expect(validationError).toEqual({
            status: 403,
            body: {
                error: "CEX workflow approval does not belong to the current user",
            },
        });
    });

    it("returns 400 when confirmation level mismatches", () => {
        const context = buildContext({ expectedLevel: 2 });
        const validationError = validatePendingApprovalDecision(
            context,
            AGENT_ID,
            USER_ID,
            1,
            "Pending CEX workflow approval context not found",
            "No pending CEX workflow approval for this threadId",
            "CEX workflow approval does not belong to the current user"
        );
        expect(validationError).toEqual({
            status: 400,
            body: {
                error: "Unexpected confirmation level",
                expected: 2,
                received: 1,
            },
        });
    });

    it("falls back to the cex map when only legacy entries exist (rollover path)", () => {
        // Models the deploy window: a request initiated before this PR landed
        // resolves via the still-populated __pendingCEXWorkflowApprovals map.
        const context = buildContext();
        const runtime: RuntimeWithPendingApprovalMaps = {
            __pendingHumanInputApprovals: new Map(),
            __pendingCEXWorkflowApprovals: new Map([
                [`${THREAD_ID}:${context.approvalId}`, context],
            ]),
        };
        const result = getPendingApprovalContext(runtime, THREAD_ID, context.approvalId, [
            "__pendingHumanInputApprovals",
            "__pendingCEXWorkflowApprovals",
        ]);
        expect(result.pendingContext).toBe(context);
        expect(result.mapKey).toBe("__pendingCEXWorkflowApprovals");
    });

    it("returns no context when approvalId is provided but missing from every map", () => {
        const context = buildContext();
        const runtime: RuntimeWithPendingApprovalMaps = {
            __pendingHumanInputApprovals: new Map([
                [`${THREAD_ID}:${context.approvalId}`, context],
            ]),
            __pendingCEXWorkflowApprovals: new Map(),
        };
        const result = getPendingApprovalContext(runtime, THREAD_ID, "not-a-real-id", [
            "__pendingHumanInputApprovals",
            "__pendingCEXWorkflowApprovals",
        ]);
        expect(result.pendingContext).toBeUndefined();
        expect(result.mapKey).toBeNull();
    });

    it("falls back to thread search when approvalId is omitted, picking the newest entry", () => {
        const older = buildContext({ approvalId: "old", createdAt: 1000 });
        const newer = buildContext({ approvalId: "new", createdAt: 5000 });
        const runtime: RuntimeWithPendingApprovalMaps = {
            __pendingHumanInputApprovals: new Map([
                [`${THREAD_ID}:${older.approvalId}`, older],
                [`${THREAD_ID}:${newer.approvalId}`, newer],
            ]),
            __pendingCEXWorkflowApprovals: new Map(),
        };
        const result = getPendingApprovalContext(runtime, THREAD_ID, undefined, [
            "__pendingHumanInputApprovals",
            "__pendingCEXWorkflowApprovals",
        ]);
        expect(result.pendingContext).toBe(newer);
    });

    it("returns 404 when context is for a different agent", () => {
        const context = buildContext({ agentId: "99999999-9999-4999-8999-999999999999" as UUID });
        const validationError = validatePendingApprovalDecision(
            context,
            AGENT_ID,
            USER_ID,
            1,
            "Pending CEX workflow approval context not found",
            "No pending CEX workflow approval for this threadId",
            "CEX workflow approval does not belong to the current user"
        );
        expect(validationError?.status).toBe(404);
    });
});
