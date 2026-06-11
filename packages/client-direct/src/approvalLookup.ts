import type { UUID } from "@elizaos/core";

export type PendingApprovalDecisionPayload = {
    decision: "approved" | "rejected";
    confirmationLevel: 1 | 2;
    parameters?: Record<string, any>;
    feedback?: string;
};

export type PendingApprovalContext = {
    approvalId: string;
    threadId: string;
    agentId: UUID;
    userId: UUID;
    expectedLevel: 1 | 2;
    resolve?: (payload: PendingApprovalDecisionPayload) => void;
    createdAt: number;
};

export type PendingApprovalValidationError = {
    status: 400 | 403 | 404;
    body: Record<string, unknown>;
};

export type RuntimeWithPendingApprovalMaps = {
    __pendingHumanInputApprovals?: Map<string, PendingApprovalContext>;
    __pendingCEXWorkflowApprovals?: Map<string, PendingApprovalContext>;
};

function findByThreadId(
    pendingApprovals: Map<string, PendingApprovalContext> | undefined,
    threadId: string
): PendingApprovalContext | undefined {
    return Array.from(pendingApprovals?.values() ?? [])
        .filter((entry) => entry.threadId === threadId)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
}

export function getPendingApprovalContext(
    runtime: RuntimeWithPendingApprovalMaps,
    threadId: string,
    approvalId: string | undefined,
    mapPriority: Array<keyof RuntimeWithPendingApprovalMaps>
): { pendingContext: PendingApprovalContext | undefined; mapKey: keyof RuntimeWithPendingApprovalMaps | null } {
    for (const mapKey of mapPriority) {
        const pendingApprovals = runtime[mapKey];
        const pendingContext = approvalId
            ? pendingApprovals?.get(`${threadId}:${approvalId}`)
            : findByThreadId(pendingApprovals, threadId);
        if (pendingContext) {
            return { pendingContext, mapKey };
        }
    }
    return { pendingContext: undefined, mapKey: null };
}

export function validatePendingApprovalDecision(
    pendingContext: PendingApprovalContext | undefined,
    expectedAgentId: UUID,
    expectedUserId: UUID,
    confirmationLevel: 1 | 2,
    notFoundError: string,
    notFoundDetails: string,
    ownershipError: string
): PendingApprovalValidationError | null {
    if (!pendingContext || pendingContext.agentId !== expectedAgentId || typeof pendingContext.resolve !== "function") {
        return {
            status: 404,
            body: {
                error: notFoundError,
                details: notFoundDetails,
            },
        };
    }
    if (pendingContext.userId !== expectedUserId) {
        return {
            status: 403,
            body: {
                error: ownershipError,
            },
        };
    }
    if (pendingContext.expectedLevel !== confirmationLevel) {
        return {
            status: 400,
            body: {
                error: "Unexpected confirmation level",
                expected: pendingContext.expectedLevel,
                received: confirmationLevel,
            },
        };
    }
    return null;
}
