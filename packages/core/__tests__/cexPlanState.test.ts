import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    __resetPlanStoreForTests,
    cancelPlan,
    getActivePlan,
    savePlan,
    updatePlan,
} from "../src/handlers/cexPlanState";
import type { CexPlan } from "../src/handlers/cexPlanSchema";

function freshPlan(overrides: Partial<CexPlan> = {}): CexPlan {
    const now = Date.now();
    return {
        id: overrides.id ?? "plan-" + Math.random().toString(36).slice(2, 9),
        user_id: overrides.user_id ?? "user-1",
        room_id: overrides.room_id ?? "room-1",
        steps: overrides.steps ?? [
            {
                id: "1",
                action: "create_order",
                venue: "binance",
                parameters: {},
                depends_on: [],
                stake: "write",
                requires_approval: true,
                status: "pending",
            },
        ],
        approval_mode: overrides.approval_mode ?? "step_by_step",
        status: overrides.status ?? "draft",
        cursor: overrides.cursor ?? 0,
        summary: overrides.summary ?? "test plan",
        created_at: overrides.created_at ?? now,
        expires_at: overrides.expires_at ?? now + 60_000,
        source_message: overrides.source_message ?? "test",
    };
}

beforeEach(() => __resetPlanStoreForTests());
afterEach(() => __resetPlanStoreForTests());

describe("savePlan / getActivePlan", () => {
    it("saves a fresh plan and returns it on lookup", () => {
        const plan = freshPlan();
        savePlan(plan);
        const got = getActivePlan(plan.user_id, plan.room_id);
        expect(got).not.toBeNull();
        expect(got?.id).toBe(plan.id);
    });

    it("returns null when no plan exists for (user, room)", () => {
        expect(getActivePlan("nope", "room")).toBeNull();
    });

    it("saving a new plan for the same (user, room) cancels the prior plan", () => {
        const first = freshPlan({ id: "first" });
        savePlan(first);
        const second = freshPlan({ id: "second" });
        const { priorPlanCancelled } = savePlan(second);
        expect(priorPlanCancelled?.id).toBe("first");
        expect(priorPlanCancelled?.status).toBe("cancelled");
        const got = getActivePlan("user-1", "room-1");
        expect(got?.id).toBe("second");
    });

    it("isolates plans by (user, room)", () => {
        const a = freshPlan({ id: "a", user_id: "u1", room_id: "r1" });
        const b = freshPlan({ id: "b", user_id: "u1", room_id: "r2" });
        savePlan(a);
        savePlan(b);
        expect(getActivePlan("u1", "r1")?.id).toBe("a");
        expect(getActivePlan("u1", "r2")?.id).toBe("b");
    });

    it("returns null for an expired plan", () => {
        const plan = freshPlan({ expires_at: Date.now() - 1 });
        savePlan(plan);
        expect(getActivePlan(plan.user_id, plan.room_id)).toBeNull();
    });

    it("returns null when the active plan is in a terminal state", () => {
        const plan = freshPlan();
        savePlan(plan);
        updatePlan(plan.id, (p) => {
            p.status = "completed";
        });
        expect(getActivePlan(plan.user_id, plan.room_id)).toBeNull();
    });
});

describe("updatePlan", () => {
    it("applies the mutator and persists changes", () => {
        const plan = freshPlan();
        savePlan(plan);
        updatePlan(plan.id, (p) => {
            p.cursor = 5;
            p.summary = "updated";
        });
        const got = getActivePlan(plan.user_id, plan.room_id);
        expect(got?.cursor).toBe(5);
        expect(got?.summary).toBe("updated");
    });

    it("throws when the plan id is unknown", () => {
        expect(() => updatePlan("missing", () => {})).toThrow(/unknown plan/);
    });

    it("returns a defensive copy (mutating the return doesn't affect the store)", () => {
        const plan = freshPlan();
        savePlan(plan);
        const ret = updatePlan(plan.id, (p) => {
            p.cursor = 3;
        });
        ret.cursor = 99;
        const got = getActivePlan(plan.user_id, plan.room_id);
        expect(got?.cursor).toBe(3);
    });
});

describe("cancelPlan", () => {
    it("transitions a live plan to cancelled", () => {
        const plan = freshPlan();
        savePlan(plan);
        cancelPlan(plan.id, "user_cancel");
        expect(getActivePlan(plan.user_id, plan.room_id)).toBeNull();
    });

    it("is a no-op on unknown plan ids", () => {
        expect(() => cancelPlan("nope", "x")).not.toThrow();
    });

    it("is a no-op when the plan is already terminal", () => {
        const plan = freshPlan();
        savePlan(plan);
        updatePlan(plan.id, (p) => {
            p.status = "completed";
        });
        expect(() => cancelPlan(plan.id, "again")).not.toThrow();
    });
});
