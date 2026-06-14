/**
 * CEX Plan store — in-memory persistence with TTL.
 *
 * Why in-memory and not Mongo: the active plan is short-lived (15 min
 * TTL, same as existing CEX approval contexts) and only needs to survive
 * across the user's next-turn reply, which goes to the same container
 * thanks to ALB session affinity. A Mongo collection would add a
 * round-trip on every CEX message and a TTL index to maintain — not
 * worth it for state that's discarded inside a half-hour. If we ever
 * need cross-container resilience we can swap this in place behind the
 * same interface.
 *
 * Lifecycle:
 *   - `savePlan(plan)` — replaces any prior plan for the same
 *     (user, room). The prior plan, if any, transitions to "cancelled"
 *     and is returned to the caller so the workflow can emit a
 *     user-visible "switched plans" notice.
 *   - `getActivePlan(userId, roomId)` — returns the plan if alive and
 *     not in a terminal state; null otherwise. Side effect: lazily
 *     expires plans past `expires_at`.
 *   - `updatePlan(planId, mutator)` — atomic-ish update; throws if the
 *     plan is gone.
 *   - `cancelPlan(planId, reason)` — terminal "cancelled" transition.
 *
 * The map key is the plan id (UUID). A secondary index keyed by
 * (user_id, room_id) tracks which plan is "active" for that pair. Only
 * one plan can be active per pair at a time.
 */

import { elizaLogger } from "../utils/logger.ts";
import type { CexPlan, CexPlanStatus } from "./cexPlanSchema.ts";

interface PlanStoreEntry {
    plan: CexPlan;
    /** Created by `setTimeout`; cleared on early termination / replace. */
    sweepTimer: ReturnType<typeof setTimeout> | null;
}

const TERMINAL_STATUSES: ReadonlySet<CexPlanStatus> = new Set<CexPlanStatus>([
    "completed",
    "failed",
    "cancelled",
    "expired",
]);

const plans = new Map<string, PlanStoreEntry>();
const activeByRoom = new Map<string, string>(); // `${userId}::${roomId}` → planId

function roomKey(userId: string, roomId: string): string {
    return `${userId}::${roomId}`;
}

function clearSweep(entry: PlanStoreEntry): void {
    if (entry.sweepTimer) {
        clearTimeout(entry.sweepTimer);
        entry.sweepTimer = null;
    }
}

function scheduleSweep(entry: PlanStoreEntry): void {
    clearSweep(entry);
    const delay = Math.max(0, entry.plan.expires_at - Date.now());
    const timer = setTimeout(() => {
        // Lazy expiration: mark the plan as expired if it's still in
        // a non-terminal state. Listeners checking via getActivePlan
        // would also have observed expiration via the wall-clock guard
        // — this timer just ensures memory frees in the no-traffic case.
        const live = plans.get(entry.plan.id);
        if (!live) return;
        if (!TERMINAL_STATUSES.has(live.plan.status)) {
            live.plan.status = "expired";
            elizaLogger.info(
                `[CexPlan] plan id=${live.plan.id} expired via TTL sweep (status was ${live.plan.status})`,
            );
        }
        plans.delete(entry.plan.id);
        const active = activeByRoom.get(roomKey(live.plan.user_id, live.plan.room_id));
        if (active === entry.plan.id) {
            activeByRoom.delete(roomKey(live.plan.user_id, live.plan.room_id));
        }
    }, delay);
    // `unref()` so the timer never blocks process exit during tests.
    if (typeof timer === "object" && timer && "unref" in timer) {
        try {
            (timer as { unref?: () => void }).unref?.();
        } catch {
            // node:timers in vitest fakes — silent.
        }
    }
    entry.sweepTimer = timer;
}

/**
 * Save a new plan. If an active plan already exists for the same
 * (user, room) and is non-terminal, cancel it and return the prior
 * plan so the caller can surface the switch in chat.
 */
export function savePlan(plan: CexPlan): { priorPlanCancelled: CexPlan | null } {
    const key = roomKey(plan.user_id, plan.room_id);
    const priorId = activeByRoom.get(key);
    let priorPlanCancelled: CexPlan | null = null;

    if (priorId && priorId !== plan.id) {
        const priorEntry = plans.get(priorId);
        if (priorEntry && !TERMINAL_STATUSES.has(priorEntry.plan.status)) {
            priorEntry.plan.status = "cancelled";
            priorPlanCancelled = { ...priorEntry.plan };
            elizaLogger.info(
                `[CexPlan] superseded prior plan id=${priorId} by new id=${plan.id} (user ${plan.user_id} room ${plan.room_id})`,
            );
            clearSweep(priorEntry);
            plans.delete(priorId);
        }
    }

    const entry: PlanStoreEntry = { plan, sweepTimer: null };
    plans.set(plan.id, entry);
    activeByRoom.set(key, plan.id);
    scheduleSweep(entry);

    elizaLogger.info(
        `[CexPlan] saved plan id=${plan.id} steps=${plan.steps.length} approval_mode=${plan.approval_mode} ttl_ms=${Math.max(0, plan.expires_at - Date.now())}`,
    );

    return { priorPlanCancelled };
}

/**
 * Look up the active plan for (user, room). Lazily expires plans past
 * their TTL. Returns null when no plan is active or the active plan
 * has reached a terminal status.
 */
export function getActivePlan(userId: string, roomId: string): CexPlan | null {
    const id = activeByRoom.get(roomKey(userId, roomId));
    if (!id) return null;
    const entry = plans.get(id);
    if (!entry) {
        activeByRoom.delete(roomKey(userId, roomId));
        return null;
    }
    if (Date.now() >= entry.plan.expires_at) {
        entry.plan.status = "expired";
        clearSweep(entry);
        plans.delete(id);
        activeByRoom.delete(roomKey(userId, roomId));
        elizaLogger.info(
            `[CexPlan] lazy-expired plan id=${id} on getActivePlan`,
        );
        return null;
    }
    if (TERMINAL_STATUSES.has(entry.plan.status)) {
        return null;
    }
    // Return a shallow copy to discourage external mutation; callers
    // must go through updatePlan / cancelPlan to mutate.
    return { ...entry.plan, steps: entry.plan.steps.map((s) => ({ ...s })) };
}

/**
 * Apply a mutator to the plan with the given id. Throws if the plan
 * has been swept. The mutator receives the live plan reference; any
 * mutation is persisted immediately. The mutator MAY transition the
 * plan to a terminal status, in which case the sweep timer is cleared.
 */
export function updatePlan(
    planId: string,
    mutator: (plan: CexPlan) => void,
): CexPlan {
    const entry = plans.get(planId);
    if (!entry) {
        throw new Error(`[CexPlan] cannot update unknown plan id=${planId}`);
    }
    mutator(entry.plan);
    if (TERMINAL_STATUSES.has(entry.plan.status)) {
        clearSweep(entry);
        const key = roomKey(entry.plan.user_id, entry.plan.room_id);
        if (activeByRoom.get(key) === planId) {
            activeByRoom.delete(key);
        }
        // Keep the entry around briefly so a same-turn caller looking up
        // the result still sees it; the next sweep will drop it.
        scheduleSweep({ ...entry, plan: { ...entry.plan, expires_at: Date.now() + 5_000 } });
    }
    return { ...entry.plan, steps: entry.plan.steps.map((s) => ({ ...s })) };
}

/**
 * Transition a plan to "cancelled" with an optional human-readable reason
 * logged for forensic value. Idempotent: a no-op when the plan is already
 * terminal or absent.
 */
export function cancelPlan(planId: string, reason: string): void {
    const entry = plans.get(planId);
    if (!entry) return;
    if (TERMINAL_STATUSES.has(entry.plan.status)) return;
    entry.plan.status = "cancelled";
    elizaLogger.info(
        `[CexPlan] cancelled plan id=${planId} reason=${reason}`,
    );
    clearSweep(entry);
    const key = roomKey(entry.plan.user_id, entry.plan.room_id);
    if (activeByRoom.get(key) === planId) {
        activeByRoom.delete(key);
    }
}

/** Look up a plan by id regardless of room (ownership is verified by the caller). */
export function getPlanById(planId: string): CexPlan | null {
    return plans.get(planId)?.plan ?? null;
}

/** Order-parameter fields a user may edit from the approval modal. Anything
 * else (status, deps, idempotency token, trigger_drop_pct, etc.) is ignored
 * so a modal edit can't corrupt plan bookkeeping. */
const EDITABLE_STEP_PARAM_KEYS = new Set([
    "order_configuration",
    "side",
    "product_id",
    "symbol",
    "leverage",
    "margin_type",
    "quote_size",
    "base_size",
    "limit_price",
]);

/**
 * #6d — Apply a user's in-modal edits to a pending write step BEFORE they
 * approve it, so the order that executes (and the result/plan card) reflects
 * exactly what the user reviewed. Ownership is enforced via `ownerUserId`
 * (must match the plan's `user_id`). Only whitelisted order fields are
 * merged; only `create_order` / `amend_order` steps are editable. No-op +
 * reason on any guard failure (caller treats failure as non-fatal and
 * proceeds with the un-edited step).
 */
export function applyPlanStepEdit(input: {
    planId: string;
    ownerUserId: string;
    stepIndex: number;
    params: Record<string, unknown>;
}): { ok: boolean; reason?: string; applied?: string[] } {
    const entry = plans.get(input.planId);
    if (!entry) return { ok: false, reason: "no_active_plan" };
    if (entry.plan.user_id !== input.ownerUserId) {
        return { ok: false, reason: "forbidden" };
    }
    const step = entry.plan.steps[input.stepIndex];
    if (!step) return { ok: false, reason: "step_not_found" };
    if (step.action !== "create_order" && step.action !== "amend_order") {
        return { ok: false, reason: "step_not_editable" };
    }
    const applied: string[] = [];
    for (const k of Object.keys(input.params ?? {})) {
        if (EDITABLE_STEP_PARAM_KEYS.has(k)) applied.push(k);
    }
    if (applied.length === 0) return { ok: false, reason: "no_editable_fields" };
    updatePlan(input.planId, (p) => {
        const s = p.steps[input.stepIndex];
        if (!s) return;
        const merged = { ...(s.parameters ?? {}) } as Record<string, unknown>;
        for (const k of applied) merged[k] = input.params[k];
        s.parameters = merged;
    });
    elizaLogger.info(
        `[CexPlan] applied user edits to plan ${input.planId} step ${input.stepIndex}: ${applied.join(",")}`,
    );
    return { ok: true, applied };
}

/**
 * Test-only: drop everything. The production store is process-lifetime
 * so resetting between test files is the safest way to keep state
 * isolated.
 */
export function __resetPlanStoreForTests(): void {
    for (const entry of plans.values()) clearSweep(entry);
    plans.clear();
    activeByRoom.clear();
}
