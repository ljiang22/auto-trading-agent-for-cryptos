import { describe, expect, it } from "vitest";
import {
    evaluateExpectations,
    registerAssertion,
} from "../lib/assertions.mjs";
import { createTranscriptState, ingestEvent } from "../lib/transcript.mjs";

function transcriptFromEvents(events) {
    const state = createTranscriptState();
    for (const event of events) {
        ingestEvent(event, state);
    }
    return state;
}

describe("evaluateExpectations", () => {
    it("passes when finalTextContains matches", () => {
        const transcript = transcriptFromEvents([
            {
                type: "intermediate_response",
                response: { user: "assistant", text: "Your balance is 1.5 BTC" },
            },
        ]);
        const failures = evaluateExpectations({
            transcript,
            expect: { finalTextContains: ["balance", "BTC"] },
            caseDef: {},
        });
        expect(failures).toEqual([]);
    });

    it("fails when expectedActions missing", () => {
        const transcript = transcriptFromEvents([
            {
                type: "step",
                step: { name: "fetch_balances", data: { type: "action" } },
            },
        ]);
        const failures = evaluateExpectations({
            transcript,
            expect: { expectedActions: ["create_order"] },
            caseDef: {},
        });
        expect(failures.some((f) => f.includes("create_order"))).toBe(true);
    });

    it("checks stepsInclude against step names", () => {
        const transcript = transcriptFromEvents([
            { type: "step", step: { name: "Trading: risk check" } },
        ]);
        const failures = evaluateExpectations({
            transcript,
            expect: { stepsInclude: ["risk check"] },
            caseDef: {},
        });
        expect(failures).toEqual([]);
    });

    it("runs registered custom assertions", () => {
        registerAssertion("alwaysFail", () => "boom");
        const transcript = createTranscriptState();
        const failures = evaluateExpectations({
            transcript,
            expect: { custom: { alwaysFail: true } },
            caseDef: {},
        });
        expect(failures.some((f) => f.includes("custom.alwaysFail"))).toBe(true);
    });
});
