/**
 * Fix 12 — Kill-switch revokes pending approvals.
 *
 * Covers `revokePendingApprovalsForUser` in
 * packages/core/src/handlers/humanInputState.ts. The full integration
 * with the kill-switch HTTP endpoint is exercised separately in
 * client-direct/__tests__/killSwitchRevoke.test.ts; here we focus on
 * the pure state-machine semantics:
 *
 *   - Only the targeted user's entries are revoked.
 *   - Each entry resolves with `decision: "rejected"` and the reason
 *     carried in `feedback`.
 *   - The TTL timer is cleared (no late timer fire).
 *   - Unknown users return 0.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    getPendingHumanInputs,
    revokePendingApprovalsForUser,
    waitForHumanInputApproval,
    type HumanInputDecision,
} from "../src/handlers/humanInputState";
import type { IAgentRuntime, UUID } from "../src/core/types";

function makeRuntime(agentId: string): IAgentRuntime {
    return { agentId } as unknown as IAgentRuntime;
}

function openApproval(
    runtime: IAgentRuntime,
    threadId: string,
    userId: UUID,
    expectedLevel: 1 | 2 = 1,
): Promise<HumanInputDecision> {
    const { promise } = waitForHumanInputApproval(runtime, threadId, userId, expectedLevel, {
        interruptType: "test",
        title: "Test approval",
        confirmationsRequired: 1,
        parameters: { foo: "bar" },
    });
    // Swallow rejections so a test that doesn't await the promise won't
    // log an unhandled rejection. Each test inspects the promise outcome
    // explicitly where it matters.
    promise.catch(() => undefined);
    return promise;
}

describe("revokePendingApprovalsForUser", () => {
    beforeEach(() => {
        vi.useRealTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("only revokes entries owned by the targeted user", async () => {
        const runtime = makeRuntime("agent-1");
        const userA = "user-A" as UUID;
        const userB = "user-B" as UUID;

        const a1 = openApproval(runtime, "thread-a1", userA);
        const a2 = openApproval(runtime, "thread-a2", userA);
        const b1 = openApproval(runtime, "thread-b1", userB);

        const count = revokePendingApprovalsForUser(runtime, userA, "test_reason");
        expect(count).toBe(2);

        // User A's approvals resolve with rejected outcome.
        await expect(a1).resolves.toMatchObject({
            decision: "rejected",
            feedback: "test_reason",
        });
        await expect(a2).resolves.toMatchObject({
            decision: "rejected",
            feedback: "test_reason",
        });

        // User B's approval is untouched — still pending in the map.
        const pending = getPendingHumanInputs(runtime);
        const remaining = Array.from(pending.values());
        expect(remaining).toHaveLength(1);
        expect(remaining[0].userId).toBe(userB);
        // The B promise is still pending; we can't await it without a timeout
        // hack. Race a microtask sentinel to assert non-fulfillment.
        const sentinel = Symbol("pending");
        const winner = await Promise.race([
            b1,
            Promise.resolve(sentinel),
        ]);
        expect(winner).toBe(sentinel);
    });

    it("returns 0 when no entries exist for the user", () => {
        const runtime = makeRuntime("agent-1");
        const userA = "user-A" as UUID;
        openApproval(runtime, "thread-a1", userA);

        const count = revokePendingApprovalsForUser(runtime, "nonexistent-user", "test_reason");
        expect(count).toBe(0);

        // The unrelated entry is still in the map.
        expect(getPendingHumanInputs(runtime).size).toBe(1);
    });

    it("returns 0 when the pending map is empty", () => {
        const runtime = makeRuntime("agent-1");
        const count = revokePendingApprovalsForUser(runtime, "anyone", "test_reason");
        expect(count).toBe(0);
    });

    it("clears the TTL timer so it does not fire after revoke", async () => {
        vi.useFakeTimers();
        const runtime = makeRuntime("agent-1");
        const userA = "user-A" as UUID;

        const promise = openApproval(runtime, "thread-a1", userA);

        const count = revokePendingApprovalsForUser(runtime, userA, "kill_switch_activated");
        expect(count).toBe(1);

        await expect(promise).resolves.toMatchObject({
            decision: "rejected",
            feedback: "kill_switch_activated",
        });

        // Advance 30 minutes; the TTL would have fired at 15 min if
        // it were not cleared. The map should remain empty (the entry
        // was deleted by revoke) and no late timer can re-resolve the
        // promise (which would emit an unhandled-rejection warning).
        await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
        expect(getPendingHumanInputs(runtime).size).toBe(0);
    });

    it("propagates confirmationLevel from the original entry", async () => {
        const runtime = makeRuntime("agent-1");
        const userA = "user-A" as UUID;
        const promise = openApproval(runtime, "thread-a1", userA, 2);

        const count = revokePendingApprovalsForUser(runtime, userA, "kill_switch_activated");
        expect(count).toBe(1);

        await expect(promise).resolves.toMatchObject({
            decision: "rejected",
            confirmationLevel: 2,
            feedback: "kill_switch_activated",
        });
    });

    it("does not leak entries when called twice in a row", async () => {
        const runtime = makeRuntime("agent-1");
        const userA = "user-A" as UUID;
        openApproval(runtime, "thread-a1", userA);
        openApproval(runtime, "thread-a2", userA);

        expect(revokePendingApprovalsForUser(runtime, userA, "first_call")).toBe(2);
        // Second call is a no-op — entries were deleted by the first.
        expect(revokePendingApprovalsForUser(runtime, userA, "second_call")).toBe(0);
        expect(getPendingHumanInputs(runtime).size).toBe(0);
    });
});
