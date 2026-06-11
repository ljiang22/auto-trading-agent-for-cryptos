import { describe, expect, it } from "vitest";
import {
    CexPlanDecomposedSchema,
    CexPlanStepDecomposedSchema,
    CLARIFY_ACTION,
    READ_ONLY_ACTIONS,
    deriveStake,
} from "../src/handlers/cexPlanSchema";

describe("CexPlanStepDecomposedSchema", () => {
    it("accepts a minimal valid step", () => {
        const parsed = CexPlanStepDecomposedSchema.safeParse({
            id: "1",
            action: "create_order",
            venue: "binance",
            parameters: { product_id: "BTC-USDT" },
        });
        expect(parsed.success).toBe(true);
    });

    it("defaults depends_on to []", () => {
        const parsed = CexPlanStepDecomposedSchema.safeParse({
            id: "1",
            action: "get_balance",
            parameters: {},
        });
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(parsed.data.depends_on).toEqual([]);
    });

    it("accepts null venue", () => {
        const parsed = CexPlanStepDecomposedSchema.safeParse({
            id: "1",
            action: "get_balance",
            venue: null,
            parameters: {},
        });
        expect(parsed.success).toBe(true);
    });

    it("rejects empty id", () => {
        const parsed = CexPlanStepDecomposedSchema.safeParse({
            id: "",
            action: "create_order",
            parameters: {},
        });
        expect(parsed.success).toBe(false);
    });

    it("rejects missing action", () => {
        const parsed = CexPlanStepDecomposedSchema.safeParse({
            id: "1",
            parameters: {},
        });
        expect(parsed.success).toBe(false);
    });
});

describe("CexPlanDecomposedSchema", () => {
    const single = {
        summary: "single buy",
        steps: [{ id: "1", action: "create_order", parameters: {}, depends_on: [] }],
    };

    it("accepts a 1-step plan", () => {
        expect(CexPlanDecomposedSchema.safeParse(single).success).toBe(true);
    });

    it("accepts a 12-step plan (boundary)", () => {
        const steps = Array.from({ length: 12 }, (_, i) => ({
            id: String(i + 1),
            action: "create_order",
            parameters: {},
            depends_on: [],
        }));
        const parsed = CexPlanDecomposedSchema.safeParse({ summary: "12 steps", steps });
        expect(parsed.success).toBe(true);
    });

    it("rejects a 13-step plan (over the max)", () => {
        const steps = Array.from({ length: 13 }, (_, i) => ({
            id: String(i + 1),
            action: "create_order",
            parameters: {},
            depends_on: [],
        }));
        const parsed = CexPlanDecomposedSchema.safeParse({ summary: "13 steps", steps });
        expect(parsed.success).toBe(false);
    });

    it("rejects an empty steps array", () => {
        const parsed = CexPlanDecomposedSchema.safeParse({ summary: "empty", steps: [] });
        expect(parsed.success).toBe(false);
    });

    it("rejects missing summary", () => {
        const parsed = CexPlanDecomposedSchema.safeParse({
            steps: single.steps,
        });
        expect(parsed.success).toBe(false);
    });

    it("accepts clarification_question: null (Gemini 2.5 Flash emits explicit null)", () => {
        // Production bug 2026-05-21 — the decomposer LLM returns
        // `"clarification_question": null` rather than omitting the
        // field when no clarification is needed. Earlier schema used
        // `z.string().optional()` which rejected null; tightened to
        // `.nullable().optional()`.
        const parsed = CexPlanDecomposedSchema.safeParse({
            ...single,
            requires_clarification: false,
            clarification_question: null,
        });
        expect(parsed.success).toBe(true);
    });

    it("accepts clarification_question omitted entirely", () => {
        const parsed = CexPlanDecomposedSchema.safeParse(single);
        expect(parsed.success).toBe(true);
    });

    it("accepts clarification_question as a string", () => {
        const parsed = CexPlanDecomposedSchema.safeParse({
            ...single,
            requires_clarification: true,
            clarification_question: "Which exchange?",
        });
        expect(parsed.success).toBe(true);
    });
});

describe("deriveStake", () => {
    it("classifies get_balance as read", () => {
        expect(deriveStake("get_balance")).toBe("read");
    });

    it("classifies create_order as write", () => {
        expect(deriveStake("create_order")).toBe("write");
    });

    it("classifies cancel_order as write", () => {
        expect(deriveStake("cancel_order")).toBe("write");
    });

    it("classifies unknown actions as write (safe default)", () => {
        expect(deriveStake("some_new_action")).toBe("write");
    });

    it("READ_ONLY_ACTIONS contains the expected core set", () => {
        expect(READ_ONLY_ACTIONS.has("get_balance")).toBe(true);
        expect(READ_ONLY_ACTIONS.has("get_orders")).toBe(true);
        expect(READ_ONLY_ACTIONS.has("get_fills")).toBe(true);
        expect(READ_ONLY_ACTIONS.has("create_order")).toBe(false);
        expect(READ_ONLY_ACTIONS.has("cancel_order")).toBe(false);
    });
});

describe("CLARIFY_ACTION", () => {
    it("is the reserved action name", () => {
        expect(CLARIFY_ACTION).toBe("clarify");
    });
});
