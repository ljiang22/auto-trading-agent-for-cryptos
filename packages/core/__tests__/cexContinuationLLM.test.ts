import { describe, expect, it } from "vitest";
import {
    parseLLMContinuationDecision,
    buildContinuationClassifierPrompt,
    type LLMContinuationIntent,
} from "../src/handlers/cexContinuationLLM";

describe("parseLLMContinuationDecision", () => {
    const expectIntent = (raw: string, intent: LLMContinuationIntent) =>
        expect(parseLLMContinuationDecision(raw).intent).toBe(intent);

    it("parses a clean JSON object", () =>
        expectIntent('{"intent":"APPROVE_NEXT","reason":"user said yes continue"}', "APPROVE_NEXT"));

    it("parses a fenced ```json block", () =>
        expectIntent('```json\n{"intent":"CANCEL_PLAN","reason":"user wants to stop"}\n```', "CANCEL_PLAN"));

    it("extracts the JSON object when wrapped in prose", () =>
        expectIntent('Sure, here is my classification: {"intent":"APPROVE_BATCH"} done.', "APPROVE_BATCH"));

    it("maps every valid intent", () => {
        for (const i of [
            "APPROVE_NEXT",
            "APPROVE_BATCH",
            "CANCEL_PLAN",
            "SKIP_STEP",
            "DELEGATE",
            "MODIFY",
            "NON_TRADING",
            "UNCLEAR",
        ] as LLMContinuationIntent[]) {
            expectIntent(`{"intent":"${i}"}`, i);
        }
    });

    it("is case-insensitive on the intent value", () =>
        expectIntent('{"intent":"approve_next"}', "APPROVE_NEXT"));

    it("defaults to UNCLEAR on an unknown intent value", () =>
        expectIntent('{"intent":"FROBNICATE"}', "UNCLEAR"));

    it("defaults to UNCLEAR on non-JSON garbage", () =>
        expectIntent("I think the user probably wants to proceed maybe", "UNCLEAR"));

    it("defaults to UNCLEAR on empty input", () => expectIntent("", "UNCLEAR"));

    it("surfaces the reason when present", () =>
        expect(
            parseLLMContinuationDecision('{"intent":"DELEGATE","reason":"deferred to agent"}').reason,
        ).toBe("deferred to agent"));
});

describe("buildContinuationClassifierPrompt", () => {
    const ctx = {
        userMessage: "yes, continue with the plan",
        nextStepAction: "create_order",
        nextStepDescription: "Immediate leg: market buy $300 BTC now",
        planStatus: "awaiting_approval",
        planSummary: "Modified Enhanced DCA: $300 now + $300 @ -2% + $200 @ -5%",
        remainingWrites: 2,
        recentMessages: "user: ...\nassistant: plan card ...",
    };

    it("includes the user's message verbatim", () =>
        expect(buildContinuationClassifierPrompt(ctx).prompt).toContain("yes, continue with the plan"));

    it("includes the next pending step so the model has plan context", () => {
        const p = buildContinuationClassifierPrompt(ctx).prompt;
        expect(p).toContain("create_order");
        expect(p).toContain("Immediate leg: market buy $300 BTC now");
    });

    it("system prompt enumerates all candidate intents", () => {
        const sys = buildContinuationClassifierPrompt(ctx).system;
        for (const i of ["APPROVE_NEXT", "CANCEL_PLAN", "DELEGATE", "MODIFY", "NON_TRADING", "UNCLEAR"]) {
            expect(sys).toContain(i);
        }
    });
});
