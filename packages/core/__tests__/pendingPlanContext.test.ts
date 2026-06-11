import { describe, expect, it, beforeEach } from "vitest";
import { formatPendingTradingPlansContext } from "../src/handlers/pendingPlanContext.ts";
import { savePlan, __resetPlanStoreForTests } from "../src/handlers/cexPlanState.ts";
import type { CexPlan } from "../src/handlers/cexPlanSchema.ts";

function makePlan(overrides: Partial<CexPlan> = {}): CexPlan {
    const now = Date.now();
    return {
        id: "plan-test-1",
        user_id: "user-a",
        room_id: "room-a",
        steps: [
            {
                id: 1,
                action: "create_order",
                status: "pending",
                description: "Market buy $300 BTC",
                requires_approval: true,
            },
        ],
        approval_mode: "step_by_step",
        status: "awaiting_approval",
        cursor: 0,
        summary: "Hybrid DCA BTC plan",
        created_at: now,
        expires_at: now + 900_000,
        source_message: "execute plan",
        ...overrides,
    };
}

describe("formatPendingTradingPlansContext", () => {
    beforeEach(() => {
        __resetPlanStoreForTests();
    });

    it("returns empty string when no active plan", () => {
        expect(formatPendingTradingPlansContext("user-a", "room-a")).toBe("");
    });

    it("includes plan card and status guidance when plan is awaiting approval", () => {
        savePlan(makePlan());
        const ctx = formatPendingTradingPlansContext("user-a", "room-a");
        expect(ctx).toContain("[PENDING/ACTIVE TRADING PLANS]");
        expect(ctx).toContain("awaiting_approval");
        expect(ctx).toContain("Hybrid DCA BTC plan");
        expect(ctx).toContain("MUST NOT claim");
    });
});
