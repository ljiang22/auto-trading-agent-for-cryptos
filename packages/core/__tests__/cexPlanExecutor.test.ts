import { describe, expect, it } from "vitest";
import {
    advanceCursor,
    decideStatus,
    detectCycle,
    inflateStep,
    markStepFailedAndBail,
    markStepOk,
    nextWriteStep,
    planShape,
    readableSteps,
    renderPlanCard,
    renderStepResultBlock,
} from "../src/handlers/cexPlanExecutor";
import type { CexPlan, CexPlanStep, CexPlanStepDecomposed } from "../src/handlers/cexPlanSchema";

function makeStep(overrides: Partial<CexPlanStep>): CexPlanStep {
    return {
        id: overrides.id ?? "x",
        action: overrides.action ?? "create_order",
        venue: overrides.venue ?? "binance",
        parameters: overrides.parameters ?? {},
        depends_on: overrides.depends_on ?? [],
        stake: overrides.stake ?? "write",
        requires_approval: overrides.requires_approval ?? overrides.stake !== "read",
        status: overrides.status ?? "pending",
        description: overrides.description,
    };
}

function makePlan(steps: CexPlanStep[], overrides: Partial<CexPlan> = {}): CexPlan {
    const now = Date.now();
    return {
        id: overrides.id ?? "plan-test",
        user_id: overrides.user_id ?? "u1",
        room_id: overrides.room_id ?? "r1",
        steps,
        approval_mode: overrides.approval_mode ?? "step_by_step",
        status: overrides.status ?? "draft",
        cursor: overrides.cursor ?? 0,
        summary: overrides.summary ?? "test",
        created_at: overrides.created_at ?? now,
        expires_at: overrides.expires_at ?? now + 60_000,
        source_message: overrides.source_message ?? "test",
    };
}

describe("inflateStep", () => {
    it("derives stake=read for known read actions", () => {
        const dec: CexPlanStepDecomposed = {
            id: "1",
            action: "get_balance",
            parameters: {},
            depends_on: [],
        };
        const step = inflateStep(dec);
        expect(step.stake).toBe("read");
        expect(step.requires_approval).toBe(false);
        expect(step.status).toBe("pending");
    });

    it("derives stake=write for create_order", () => {
        const step = inflateStep({
            id: "1",
            action: "create_order",
            parameters: {},
            depends_on: [],
        });
        expect(step.stake).toBe("write");
        expect(step.requires_approval).toBe(true);
    });

    it("normalizes missing venue to null", () => {
        const step = inflateStep({
            id: "1",
            action: "get_balance",
            parameters: {},
            depends_on: [],
        });
        expect(step.venue).toBeNull();
    });
});

describe("readableSteps", () => {
    it("returns all leading reads with no deps", () => {
        const plan = makePlan([
            makeStep({ id: "1", action: "get_balance", stake: "read", requires_approval: false }),
            makeStep({ id: "2", action: "get_orders", stake: "read", requires_approval: false }),
            makeStep({ id: "3", action: "create_order", stake: "write" }),
        ]);
        expect(readableSteps(plan)).toEqual([0, 1]);
    });

    it("stops at the first write", () => {
        const plan = makePlan([
            makeStep({ id: "1", action: "get_balance", stake: "read", requires_approval: false }),
            makeStep({ id: "2", action: "create_order", stake: "write" }),
            makeStep({ id: "3", action: "get_orders", stake: "read", requires_approval: false }),
        ]);
        expect(readableSteps(plan)).toEqual([0]);
    });

    it("skips reads with unfulfilled deps", () => {
        const plan = makePlan([
            makeStep({ id: "1", action: "get_balance", stake: "read", requires_approval: false }),
            makeStep({ id: "2", action: "get_orders", stake: "read", requires_approval: false, depends_on: ["1"] }),
        ]);
        // both are reads, but step 2 depends on step 1 — only step 1 returns initially
        expect(readableSteps(plan)).toEqual([0]);
    });

    it("considers deps fulfilled when prereq is ok", () => {
        const plan = makePlan([
            makeStep({ id: "1", action: "get_balance", stake: "read", requires_approval: false, status: "ok" }),
            makeStep({ id: "2", action: "get_orders", stake: "read", requires_approval: false, depends_on: ["1"] }),
        ]);
        expect(readableSteps(plan)).toEqual([1]);
    });

    it("returns empty when there are no pending leading reads", () => {
        const plan = makePlan([
            makeStep({ id: "1", action: "create_order", stake: "write" }),
        ]);
        expect(readableSteps(plan)).toEqual([]);
    });
});

describe("nextWriteStep", () => {
    it("returns the index of the first pending write", () => {
        const plan = makePlan([
            makeStep({ id: "1", action: "get_balance", stake: "read", requires_approval: false, status: "ok" }),
            makeStep({ id: "2", action: "create_order", stake: "write" }),
            makeStep({ id: "3", action: "create_order", stake: "write" }),
        ], { cursor: 1 });
        expect(nextWriteStep(plan)).toBe(1);
    });

    it("returns null when no writes remain", () => {
        const plan = makePlan([
            makeStep({ id: "1", action: "create_order", stake: "write", status: "ok" }),
            makeStep({ id: "2", action: "create_order", stake: "write", status: "ok" }),
        ], { cursor: 2 });
        expect(nextWriteStep(plan)).toBeNull();
    });

    it("respects deps on writes", () => {
        const plan = makePlan([
            makeStep({ id: "1", action: "get_balance", stake: "read", requires_approval: false }),
            makeStep({ id: "2", action: "create_order", stake: "write", depends_on: ["1"] }),
        ]);
        // step 2 depends on step 1 which is still pending
        expect(nextWriteStep(plan)).toBeNull();
    });
});

describe("markStepOk", () => {
    it("transitions status to ok and stamps a result", () => {
        const plan = makePlan([
            makeStep({ id: "1", action: "create_order", stake: "write" }),
        ]);
        markStepOk(plan, "1", { fill_price: 62000 });
        expect(plan.steps[0].status).toBe("ok");
        expect(plan.steps[0].result?.payload).toEqual({ fill_price: 62000 });
    });
});

describe("markStepFailedAndBail", () => {
    it("marks the failing step + skips all later steps", () => {
        const plan = makePlan([
            makeStep({ id: "1", action: "create_order", stake: "write", status: "ok" }),
            makeStep({ id: "2", action: "create_order", stake: "write" }),
            makeStep({ id: "3", action: "create_order", stake: "write" }),
        ], { cursor: 1 });
        markStepFailedAndBail(plan, "2", "venue rejected order");
        expect(plan.steps[0].status).toBe("ok");
        expect(plan.steps[1].status).toBe("failed");
        expect(plan.steps[1].result?.error).toBe("venue rejected order");
        expect(plan.steps[2].status).toBe("skipped");
        expect(plan.status).toBe("failed");
        expect(plan.cursor).toBe(1);
    });

    it("pins cursor to the failing step's index", () => {
        const plan = makePlan([
            makeStep({ id: "1", action: "create_order", stake: "write" }),
            makeStep({ id: "2", action: "create_order", stake: "write" }),
        ]);
        markStepFailedAndBail(plan, "1", "boom");
        expect(plan.cursor).toBe(0);
    });
});

describe("advanceCursor", () => {
    it("skips over non-pending steps", () => {
        const plan = makePlan([
            makeStep({ id: "1", status: "ok" }),
            makeStep({ id: "2", status: "ok" }),
            makeStep({ id: "3", status: "pending" }),
        ]);
        advanceCursor(plan);
        expect(plan.cursor).toBe(2);
    });

    it("stops at the first pending step", () => {
        const plan = makePlan([
            makeStep({ id: "1", status: "ok" }),
            makeStep({ id: "2", status: "pending" }),
            makeStep({ id: "3", status: "pending" }),
        ]);
        advanceCursor(plan);
        expect(plan.cursor).toBe(1);
    });

    it("advances past skipped steps too", () => {
        const plan = makePlan([
            makeStep({ id: "1", status: "skipped" }),
            makeStep({ id: "2", status: "ok" }),
            makeStep({ id: "3", status: "pending" }),
        ]);
        advanceCursor(plan);
        expect(plan.cursor).toBe(2);
    });
});

describe("decideStatus", () => {
    it("returns failed when any step has failed", () => {
        const plan = makePlan([
            makeStep({ id: "1", status: "ok" }),
            makeStep({ id: "2", status: "failed" }),
        ]);
        expect(decideStatus(plan)).toBe("failed");
    });

    it("returns completed when every step is ok or skipped", () => {
        const plan = makePlan([
            makeStep({ id: "1", status: "ok" }),
            makeStep({ id: "2", status: "skipped" }),
        ], { cursor: 2 });
        expect(decideStatus(plan)).toBe("completed");
    });

    it("returns awaiting_approval when cursor points at a write in step_by_step mode", () => {
        const plan = makePlan([
            makeStep({ id: "1", action: "create_order", stake: "write" }),
        ], { approval_mode: "step_by_step", cursor: 0 });
        expect(decideStatus(plan)).toBe("awaiting_approval");
    });

    it("returns executing when cursor points at a write in batch mode", () => {
        const plan = makePlan([
            makeStep({ id: "1", action: "create_order", stake: "write" }),
        ], { approval_mode: "batch", cursor: 0 });
        expect(decideStatus(plan)).toBe("executing");
    });
});

describe("planShape", () => {
    it("counts reads and writes correctly", () => {
        const plan = makePlan([
            makeStep({ id: "1", action: "get_balance", stake: "read", requires_approval: false }),
            makeStep({ id: "2", action: "create_order", stake: "write" }),
            makeStep({ id: "3", action: "create_order", stake: "write" }),
        ]);
        const shape = planShape(plan);
        expect(shape).toEqual({ total: 3, reads: 1, writes: 2, hasMixedKinds: true });
    });

    it("flags hasMixedKinds=false for pure-write plans", () => {
        const plan = makePlan([
            makeStep({ id: "1", action: "create_order", stake: "write" }),
            makeStep({ id: "2", action: "create_order", stake: "write" }),
        ]);
        expect(planShape(plan).hasMixedKinds).toBe(false);
    });
});

describe("detectCycle", () => {
    it("returns null on an acyclic plan", () => {
        const plan = makePlan([
            makeStep({ id: "1" }),
            makeStep({ id: "2", depends_on: ["1"] }),
            makeStep({ id: "3", depends_on: ["2"] }),
        ]);
        expect(detectCycle(plan)).toBeNull();
    });

    it("detects a direct cycle", () => {
        const plan = makePlan([
            makeStep({ id: "1", depends_on: ["2"] }),
            makeStep({ id: "2", depends_on: ["1"] }),
        ]);
        expect(detectCycle(plan)).not.toBeNull();
    });

    it("detects an indirect cycle", () => {
        const plan = makePlan([
            makeStep({ id: "1", depends_on: ["3"] }),
            makeStep({ id: "2", depends_on: ["1"] }),
            makeStep({ id: "3", depends_on: ["2"] }),
        ]);
        expect(detectCycle(plan)).not.toBeNull();
    });
});

describe("renderPlanCard", () => {
    it("renders a 3-step plan with multi-remaining prompt", () => {
        const plan = makePlan([
            makeStep({ id: "1", action: "create_order", venue: "binance", description: "buy BTC", status: "ok" }),
            makeStep({ id: "2", action: "create_order", venue: "binance", description: "buy ETH", status: "pending" }),
            makeStep({ id: "3", action: "create_order", venue: "binance", description: "buy SOL", status: "pending" }),
        ], { summary: "3-asset plan", status: "awaiting_approval" });
        const card = renderPlanCard(plan, { include_next_prompt: true });
        expect(card).toContain("**Plan**: 3-asset plan");
        expect(card).toContain("step_by_step");
        expect(card).toContain("✅ ok");
        expect(card).toContain("⏳ pending");
        expect(card).toContain("buy BTC");
        expect(card).toContain("buy ETH");
        // Multi-remaining prompt shows yes / yes, all / cancel.
        expect(card).toContain("`yes`");
        expect(card).toContain("`yes, all`");
        expect(card).toContain("`cancel`");
    });

    it("final-step prompt omits the batch hint (only 1 pending)", () => {
        const plan = makePlan([
            makeStep({ id: "1", action: "create_order", status: "ok" }),
            makeStep({ id: "2", action: "create_order", status: "pending" }),
        ], { status: "awaiting_approval" });
        const card = renderPlanCard(plan, { include_next_prompt: true });
        expect(card).toContain("`yes`");
        expect(card).not.toContain("`yes, all`");
    });

    it("omits the next-step prompt when not requested", () => {
        const plan = makePlan([
            makeStep({ id: "1", status: "ok" }),
        ], { status: "completed" });
        const card = renderPlanCard(plan);
        expect(card).not.toContain("Reply ");
    });
});

describe("renderStepResultBlock — Commit 5 (Issue 6)", () => {
    function makeOkStep(
        action: string,
        params: Record<string, unknown>,
        payload: Record<string, unknown>,
    ): CexPlanStep {
        return makeStep({
            id: "x",
            action,
            stake: "read",
            status: "ok",
            parameters: params,
            requires_approval: false,
            description: `${action} step`,
        });
    }

    function withResult(step: CexPlanStep, payload: Record<string, unknown>): CexPlanStep {
        return {
            ...step,
            result: {
                ok: true,
                payload,
                started_at: Date.now(),
                finished_at: Date.now(),
            },
        };
    }

    it("summary includes wallet_type for get_orders so spot vs margin are distinct", () => {
        const spot = withResult(
            makeOkStep("get_orders", { wallet_type: "spot" }, {}),
            { text: "", orders: [{ order_id: "1", symbol: "BTCUSDT", side: "BUY", price: "60000", quantity: "0.01", status: "NEW" }] },
        );
        const block = renderStepResultBlock(spot);
        expect(block).not.toBeNull();
        expect(block!).toContain("wallet=spot");
        expect(block!).toContain("get_orders");
        // Structured table is preferred over a short text payload.
        expect(block!).toContain("| Order ID");
    });

    it("summary includes margin_mode for cross vs isolated", () => {
        const cross = withResult(
            makeOkStep("get_orders", { margin_mode: "cross" }, {}),
            { orders: [] },
        );
        const block = renderStepResultBlock(cross);
        expect(block).not.toBeNull();
        expect(block!).toContain("margin=cross");
        // Empty scope renders the sentinel, not silent.
        expect(block!).toContain("No orders in this scope");
    });

    it("uses structured rows over a short text payload", () => {
        const step = withResult(
            makeOkStep("get_orders", {}, {}),
            {
                text: "found some orders",
                orders: [{ order_id: "id1", symbol: "ETHUSDT", side: "SELL", price: "3000", quantity: "0.1", status: "NEW" }],
            },
        );
        const block = renderStepResultBlock(step);
        expect(block).not.toBeNull();
        expect(block!).toContain("ETHUSDT");
        expect(block!).toContain("| Order ID");
        // The short text payload should not pre-empt the structured table.
        expect(block!).not.toContain("found some orders");
    });

    it("falls back to payload.text for actions without structured rows", () => {
        const step = withResult(
            makeOkStep("get_ticker", { product_id: "BTCUSDT" }, {}),
            { text: "BTCUSDT: 65000 USDT (+0.5%)" },
        );
        const block = renderStepResultBlock(step);
        expect(block).not.toBeNull();
        expect(block!).toContain("BTCUSDT: 65000 USDT");
    });

    it("emits explicit no-rows sentinel for empty fills", () => {
        const step = withResult(
            makeOkStep("get_fills", {}, {}),
            { fills: [] },
        );
        const block = renderStepResultBlock(step);
        expect(block).not.toBeNull();
        expect(block!).toContain("No fills in this scope");
    });

    it("wraps step results in a collapsible <details> block", () => {
        const step = withResult(
            makeOkStep("get_orders", { wallet_type: "spot" }, {}),
            { orders: [{ order_id: "id1", symbol: "BTCUSDT", side: "BUY", price: "60000", quantity: "0.01", status: "NEW" }] },
        );
        const block = renderStepResultBlock(step);
        expect(block).not.toBeNull();
        expect(block!).toMatch(/^<details>/);
        expect(block!).not.toContain("<details open>");
    });

    it("includes Client Order ID column when rows carry client_order_id", () => {
        const step = withResult(
            makeOkStep("get_orders", {}, {}),
            {
                orders: [
                    {
                        order_id: "61908270229",
                        client_order_id: "bn-jkeqbpmyrwrn2l4y3bgdl24lit",
                        symbol: "BTCUSDT",
                        side: "BUY",
                        type: "LIMIT",
                        price: "60000",
                        quantity: "0.01",
                        status: "NEW",
                    },
                ],
            },
        );
        const block = renderStepResultBlock(step);
        expect(block).toContain("| Client Order ID |");
        expect(block).toContain("bn-jkeqbpmyrwrn2l4y3bgdl24lit");
    });
});
