import { describe, expect, it } from "vitest";
import { evaluateExpectations } from "../lib/assertions.mjs";
import { createTranscriptState } from "../lib/transcript.mjs";

describe("trading assertions", () => {
    it("detects approval rejection phases", () => {
        const transcript = createTranscriptState();
        transcript.stepNames.push("parameter_review_rejected");
        const failures = evaluateExpectations({
            transcript,
            expect: { approvalRejected: true },
            caseDef: {},
        });
        expect(failures).toEqual([]);
    });

    it("flags missing unsupported variant signal", () => {
        const transcript = createTranscriptState();
        transcript.lastAssistantText = "Order placed successfully";
        const failures = evaluateExpectations({
            transcript,
            expect: { unsupportedVariant: true },
            caseDef: {},
        });
        expect(failures.length).toBeGreaterThan(0);
    });

    it("skips strict riskDecision when optional", () => {
        const transcript = createTranscriptState();
        const failures = evaluateExpectations({
            transcript,
            expect: { riskDecision: "deny", riskDecisionOptional: true },
            caseDef: {},
        });
        expect(failures).toEqual([]);
    });
});
