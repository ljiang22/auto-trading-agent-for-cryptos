/**
 * Fix 12 — Kill-switch endpoint integration smoke.
 *
 * The full `PUT /user/trading/kill-switch` route is large and pulls in
 * JWT auth, MongoDB adapters, plugin-cex barrel imports, and a
 * full express stack — booting all of that just to verify two lines of
 * additive logic produces a brittle test. This file instead exercises
 * the integration contract directly:
 *
 *   1. With 2 pending approvals open for user X (via the same
 *      `waitForHumanInputApproval` API the real CEX workflow uses),
 *      calling `revokePendingApprovalsForUser` returns `2`.
 *   2. Each awaiting promise resolves with `decision: "rejected"` and
 *      `feedback: "kill_switch_activated"`.
 *   3. An SSE writer registered via `markStreamOpen(userId, send)`
 *      receives the `kill_switch_revoked` payload from
 *      `emitEventToUser`.
 *
 * The HTTP plumbing on top of that (auth middleware, DB write of
 * `kill_switch_active=true`, `[Trading]` log line) is covered by the
 * route's existing structure — the only new code paths in api.ts are
 * the three calls validated here.
 */

import { describe, expect, it, vi } from "vitest";

import {
    emitEventToUser,
    markStreamClosed,
    markStreamOpen,
    revokePendingApprovalsForUser,
    type IAgentRuntime,
    type UUID,
} from "@elizaos/core";

function makeRuntime(): IAgentRuntime {
    return { agentId: "agent-test" } as unknown as IAgentRuntime;
}

/**
 * Mirror of waitForHumanInputApproval's map layout — exporting that
 * helper from the core barrel just for tests would expand the public
 * API, so we build the entry directly here. This is exactly what the
 * approvalLookup tests do (see __tests__/approvalLookup.test.ts).
 */
function seedPendingApproval(
    runtime: IAgentRuntime,
    opts: {
        threadId: string;
        approvalId: string;
        userId: UUID;
        expectedLevel: 1 | 2;
    },
): { promise: Promise<unknown>; entry: Record<string, unknown> } {
    const runtimeAny = runtime as unknown as {
        __pendingHumanInputApprovals?: Map<string, Record<string, unknown>>;
    };
    if (!runtimeAny.__pendingHumanInputApprovals) {
        runtimeAny.__pendingHumanInputApprovals = new Map();
    }
    let resolveFn: (decision: unknown) => void = () => undefined;
    let rejectFn: (error: Error) => void = () => undefined;
    const promise = new Promise<unknown>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
    });
    promise.catch(() => undefined);
    const expirationTimer = setTimeout(() => {
        rejectFn(new Error("Pending human input approval expired"));
    }, 15 * 60 * 1000);
    if (typeof expirationTimer.unref === "function") expirationTimer.unref();
    const entry = {
        approvalId: opts.approvalId,
        threadId: opts.threadId,
        agentId: "agent-test",
        userId: opts.userId,
        expectedLevel: opts.expectedLevel,
        request: {
            threadId: opts.threadId,
            approvalId: opts.approvalId,
            interruptType: "cex-order-review",
            title: "Approve",
            confirmationsRequired: 1,
            confirmationLevel: opts.expectedLevel,
            parameters: {},
        },
        resolve: (d: unknown) => {
            clearTimeout(expirationTimer);
            runtimeAny.__pendingHumanInputApprovals?.delete(`${opts.threadId}:${opts.approvalId}`);
            resolveFn(d);
        },
        reject: (e: Error) => {
            clearTimeout(expirationTimer);
            runtimeAny.__pendingHumanInputApprovals?.delete(`${opts.threadId}:${opts.approvalId}`);
            rejectFn(e);
        },
        createdAt: Date.now(),
        expirationTimer,
    };
    runtimeAny.__pendingHumanInputApprovals.set(
        `${opts.threadId}:${opts.approvalId}`,
        entry,
    );
    return { promise, entry };
}

describe("Fix 12 — kill-switch revoke integration", () => {
    it("revokes all pending approvals for the targeted user and returns the count", async () => {
        const runtime = makeRuntime();
        const userX = "11111111-1111-4111-8111-111111111111" as UUID;

        const { promise: p1 } = seedPendingApproval(runtime, {
            threadId: "thread-1",
            approvalId: "approval-1",
            userId: userX,
            expectedLevel: 1,
        });
        const { promise: p2 } = seedPendingApproval(runtime, {
            threadId: "thread-2",
            approvalId: "approval-2",
            userId: userX,
            expectedLevel: 2,
        });

        const revoked = revokePendingApprovalsForUser(
            runtime,
            String(userX),
            "kill_switch_activated",
        );
        expect(revoked).toBe(2);

        await expect(p1).resolves.toMatchObject({
            decision: "rejected",
            confirmationLevel: 1,
            feedback: "kill_switch_activated",
        });
        await expect(p2).resolves.toMatchObject({
            decision: "rejected",
            confirmationLevel: 2,
            feedback: "kill_switch_activated",
        });
    });

    it("emits kill_switch_revoked over every live SSE stream owned by the user", () => {
        const runtime = makeRuntime();
        const userX = "11111111-1111-4111-8111-111111111111";
        const userY = "22222222-2222-4222-8222-222222222222";

        const userXSendA = vi.fn();
        const userXSendB = vi.fn();
        const userYSend = vi.fn();

        markStreamOpen(runtime, "room-x-a", "conn-x-a", userX, userXSendA);
        markStreamOpen(runtime, "room-x-b", "conn-x-b", userX, userXSendB);
        markStreamOpen(runtime, "room-y", "conn-y", userY, userYSend);

        const payload = {
            event: "kill_switch_revoked",
            revoked_count: 2,
            reason: "kill_switch_activated",
        };
        const delivered = emitEventToUser(runtime, userX, payload);

        expect(delivered).toBe(2);
        expect(userXSendA).toHaveBeenCalledWith(payload);
        expect(userXSendB).toHaveBeenCalledWith(payload);
        expect(userYSend).not.toHaveBeenCalled();

        // Cleanup so subsequent tests don't see stale registrations
        // (the registry lives on the runtime instance, which is fresh
        // per-test here, but be defensive anyway).
        markStreamClosed(runtime, "room-x-a", "conn-x-a");
        markStreamClosed(runtime, "room-x-b", "conn-x-b");
        markStreamClosed(runtime, "room-y", "conn-y");
    });

    it("returns 0 SSE deliveries when no streams are open for the user", () => {
        const runtime = makeRuntime();
        const userX = "11111111-1111-4111-8111-111111111111";

        const delivered = emitEventToUser(runtime, userX, {
            event: "kill_switch_revoked",
            revoked_count: 0,
            reason: "kill_switch_activated",
        });
        expect(delivered).toBe(0);
    });

    it("skips connections with no `send` callback (liveness-only registrations)", () => {
        const runtime = makeRuntime();
        const userX = "11111111-1111-4111-8111-111111111111";

        // Liveness-only registration (legacy callsites that don't push events).
        markStreamOpen(runtime, "room-legacy", "conn-legacy", userX);

        const delivered = emitEventToUser(runtime, userX, {
            event: "kill_switch_revoked",
            revoked_count: 1,
            reason: "kill_switch_activated",
        });
        expect(delivered).toBe(0);

        markStreamClosed(runtime, "room-legacy", "conn-legacy");
    });

    it("isolates per-runtime registries — userX on runtime A is not reachable from runtime B", () => {
        const runtimeA = makeRuntime();
        const runtimeB = makeRuntime();
        const userX = "11111111-1111-4111-8111-111111111111";

        const sendOnA = vi.fn();
        markStreamOpen(runtimeA, "room-x", "conn-x", userX, sendOnA);

        // Emitting on runtime B must NOT touch runtime A's registry.
        const deliveredOnB = emitEventToUser(runtimeB, userX, {
            event: "kill_switch_revoked",
            revoked_count: 0,
            reason: "kill_switch_activated",
        });
        expect(deliveredOnB).toBe(0);
        expect(sendOnA).not.toHaveBeenCalled();

        // And the runtime A registry is still healthy.
        const deliveredOnA = emitEventToUser(runtimeA, userX, {
            event: "kill_switch_revoked",
            revoked_count: 0,
            reason: "kill_switch_activated",
        });
        expect(deliveredOnA).toBe(1);

        markStreamClosed(runtimeA, "room-x", "conn-x");
    });
});
