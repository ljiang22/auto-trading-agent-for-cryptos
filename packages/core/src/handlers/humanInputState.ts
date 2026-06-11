import { Annotation } from "@langchain/langgraph";
import { v4 as uuidv4 } from "uuid";

import type { IAgentRuntime, UUID, CEXActionSchema } from "../core/types.ts";
import { elizaLogger } from "../utils/logger.ts";

export type HumanInputFieldSchema = Record<string, CEXActionSchema["parameters"][string]>;

export type HumanInputRequestPayload = {
    threadId: string;
    approvalId: string;
    interruptType: string;
    title: string;
    description?: string;
    confirmationsRequired: number;
    confirmationLevel: 1 | 2;
    parameters: Record<string, unknown>;
    parameterSchema?: HumanInputFieldSchema | null;
    summary?: Record<string, unknown>;
};

export type HumanInputDecision = {
    decision: "approved" | "rejected";
    confirmationLevel: 1 | 2;
    parameters?: Record<string, unknown>;
    feedback?: string;
};

export type PendingHumanInputEntry = {
    approvalId: string;
    threadId: string;
    agentId: string;
    userId: UUID;
    expectedLevel: 1 | 2;
    request: HumanInputRequestPayload;
    resolve: (decision: HumanInputDecision) => void;
    reject: (error: Error) => void;
    createdAt: number;
    /**
     * Fix 12 — handle to the entry's TTL timer so the centralized revoker
     * (revokePendingApprovalsForUser) can clear it BEFORE deleting the
     * entry. The waitForHumanInputApproval `resolve` / `reject` wrappers
     * already clear this timer; storing it on the entry lets the kill-
     * switch path do the same without going through the wrappers.
     */
    expirationTimer?: ReturnType<typeof setTimeout>;
};

const PENDING_HUMAN_INPUTS_KEY = "__pendingHumanInputApprovals";
const PENDING_HUMAN_INPUT_TTL_MS = 15 * 60 * 1000;

export const HumanInputState = Annotation.Root({
    runtime: Annotation<IAgentRuntime>(),
    threadId: Annotation<string>(),
    userId: Annotation<UUID>(),
    request: Annotation<HumanInputRequestPayload>(),
    decision: Annotation<HumanInputDecision>(),
    hasError: Annotation<boolean>(),
    errorMessage: Annotation<string>(),
    phase: Annotation<string>(),
    startTime: Annotation<number>(),
});

export type HumanInputStateType = typeof HumanInputState.State;

export function makePendingHumanInputKey(threadId: string, approvalId: string): string {
    return `${threadId}:${approvalId}`;
}

export function getPendingHumanInputs(runtime: IAgentRuntime): Map<string, PendingHumanInputEntry> {
    const runtimeWithPending = runtime as IAgentRuntime & {
        [PENDING_HUMAN_INPUTS_KEY]?: Map<string, PendingHumanInputEntry>;
    };
    const existing = runtimeWithPending[PENDING_HUMAN_INPUTS_KEY];
    if (existing) return existing;
    const created = new Map<string, PendingHumanInputEntry>();
    runtimeWithPending[PENDING_HUMAN_INPUTS_KEY] = created;
    return created;
}

export function resolvePendingHumanInputApproval(
    runtime: IAgentRuntime,
    threadId: string,
    decision: HumanInputDecision,
    approvalId?: string
): boolean {
    const pendingApprovals = getPendingHumanInputs(runtime);
    const existing = approvalId
        ? pendingApprovals.get(makePendingHumanInputKey(threadId, approvalId))
        : Array.from(pendingApprovals.values())
              .filter((entry) => entry.threadId === threadId)
              .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!existing) return false;
    if (existing.agentId !== runtime.agentId) return false;

    if (existing.expectedLevel !== decision.confirmationLevel) {
        existing.reject(
            new Error(
                `Unexpected confirmation level: expected ${existing.expectedLevel}, got ${decision.confirmationLevel}`
            )
        );
        return true;
    }

    existing.resolve(decision);
    return true;
}

/**
 * Fix 12 — Centralized revoker for all pending human-input approvals
 * owned by a given user. Used by the kill-switch endpoint so that
 * activating the kill switch resolves every dangling approval modal
 * immediately instead of leaving them open until the 15-minute TTL.
 *
 * For each entry owned by `userId`:
 *   1. Clear its TTL timer BEFORE removing it from the map (prevents
 *      a stale timer fire from re-resolving a missing key).
 *   2. Remove it from the map (the entry's own resolve/reject wrapper
 *      also tries to delete; doing it first makes the wrapper a no-op).
 *   3. Resolve the awaiting workflow with a `rejected` decision carrying
 *      the supplied reason in `feedback`. We resolve rather than reject
 *      so the caller's surface stays a single-shape `HumanInputDecision`
 *      and doesn't have to re-classify a thrown error as "user denied".
 *
 * Returns the number of entries revoked. O(n) over the pending map,
 * which is bounded by concurrent user approvals (TTL = 15 min).
 */
export function revokePendingApprovalsForUser(
    runtime: IAgentRuntime,
    userId: string,
    reason: string
): number {
    const pendingApprovals = getPendingHumanInputs(runtime);
    if (pendingApprovals.size === 0) return 0;

    // Snapshot first — we mutate the map inside the loop and don't want
    // to rely on Map iteration semantics for concurrent deletes.
    const targets: Array<{ key: string; entry: PendingHumanInputEntry }> = [];
    for (const [key, entry] of pendingApprovals) {
        if (String(entry.userId) === String(userId)) {
            targets.push({ key, entry });
        }
    }

    let revoked = 0;
    for (const { key, entry } of targets) {
        try {
            // (1) Clear TTL timer first so it cannot fire after delete.
            if (entry.expirationTimer) {
                clearTimeout(entry.expirationTimer);
                entry.expirationTimer = undefined;
            }
            // (2) Remove from map BEFORE resolve — the resolve wrapper
            // also calls delete, but that becomes a harmless no-op.
            pendingApprovals.delete(key);
            // (3) Resolve with a rejected decision so the awaiting
            // workflow unblocks deterministically.
            entry.resolve({
                decision: "rejected",
                confirmationLevel: entry.expectedLevel,
                feedback: reason,
            });
            revoked += 1;
        } catch (error) {
            elizaLogger.warn(
                `[HumanInput] Failed to revoke approval ${entry.approvalId} for thread ${entry.threadId}: ${String(error)}`
            );
        }
    }

    if (revoked > 0) {
        elizaLogger.info(
            `[HumanInput] Revoked ${revoked} pending approval(s) for user ${userId} (reason: ${reason})`
        );
    }
    return revoked;
}

export function waitForHumanInputApproval(
    runtime: IAgentRuntime,
    threadId: string,
    userId: UUID,
    expectedLevel: 1 | 2,
    requestPayload: Omit<HumanInputRequestPayload, "approvalId" | "threadId" | "confirmationLevel">
): { approvalId: string; request: HumanInputRequestPayload; promise: Promise<HumanInputDecision> } {
    const pendingApprovals = getPendingHumanInputs(runtime);
    const approvalId = uuidv4();
    const approvalKey = makePendingHumanInputKey(threadId, approvalId);
    const request: HumanInputRequestPayload = {
        ...requestPayload,
        threadId,
        approvalId,
        confirmationLevel: expectedLevel,
    };

    const promise = new Promise<HumanInputDecision>((decisionResolve, decisionReject) => {
        const existing = Array.from(pendingApprovals.values()).find(
            (entry) =>
                entry.threadId === threadId &&
                entry.userId === userId &&
                entry.expectedLevel === expectedLevel
        );
        if (existing) {
            try {
                existing.reject(new Error("Pending human input approval replaced by a new request"));
            } catch (error) {
                elizaLogger.warn(
                    `[HumanInput] Failed to reject existing approval for thread ${threadId}: ${String(error)}`
                );
            }
        }

        let expirationTimer: ReturnType<typeof setTimeout> | undefined;

        const entry: PendingHumanInputEntry = {
            approvalId,
            threadId,
            agentId: runtime.agentId,
            userId,
            expectedLevel,
            request,
            resolve: (decision) => {
                if (expirationTimer) clearTimeout(expirationTimer);
                pendingApprovals.delete(approvalKey);
                decisionResolve(decision);
            },
            reject: (error) => {
                if (expirationTimer) clearTimeout(expirationTimer);
                pendingApprovals.delete(approvalKey);
                decisionReject(error);
            },
            createdAt: Date.now(),
        };

        pendingApprovals.set(approvalKey, entry);

        expirationTimer = setTimeout(() => {
            if (pendingApprovals.get(approvalKey) !== entry) return;
            elizaLogger.info(
                `[HumanInput] Pending approval expired by TTL for thread: ${threadId} (level ${expectedLevel}, approvalId ${approvalId})`
            );
            entry.reject(new Error("Pending human input approval expired"));
        }, PENDING_HUMAN_INPUT_TTL_MS);
        if (typeof expirationTimer.unref === "function") expirationTimer.unref();
        // Fix 12 — publish the timer on the entry so the centralized
        // revoker can clear it before deleting the map entry. The
        // resolve/reject wrappers above also reference this same handle
        // via closure, so behavior is unchanged on the normal path.
        entry.expirationTimer = expirationTimer;

        elizaLogger.info(
            `[HumanInput] Stored pending approval context for thread: ${threadId} (level ${expectedLevel}, approvalId ${approvalId})`
        );
    });

    return { approvalId, request, promise };
}
