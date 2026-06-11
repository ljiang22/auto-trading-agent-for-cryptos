import { describe, expect, it } from "vitest";
import { evaluateExpectations } from "../lib/assertions.mjs";
import { createTranscriptState } from "../lib/transcript.mjs";

describe("teardown assertions", () => {
    it("passes noOpenOrders when assistant says no open orders", () => {
        const transcript = createTranscriptState();
        transcript.lastAssistantText = "You have no open BTC-USDT orders.";
        const failures = evaluateExpectations({
            transcript,
            expect: { noOpenOrders: true },
            caseDef: {},
        });
        expect(failures).toEqual([]);
    });

    it("passes noOpenPositions when assistant says no positions", () => {
        const transcript = createTranscriptState();
        transcript.lastAssistantText = "You have no margin positions for BTC-USDT.";
        const failures = evaluateExpectations({
            transcript,
            expect: { noOpenPositions: true },
            caseDef: {},
        });
        expect(failures).toEqual([]);
    });

    it("passes noHarnessOpenOrders when harness ids are absent", () => {
        const transcript = createTranscriptState();
        transcript.lastAssistantText =
            "You have 2 other open BTC-USDT orders, but none match the harness list.";
        const failures = evaluateExpectations({
            transcript,
            expect: {
                noHarnessOpenOrders: true,
                harnessClientOrderIds: ["harness-spot-limit-1"],
            },
            caseDef: {},
        });
        expect(failures).toEqual([]);
    });

    it("fails noHarnessOpenOrders when harness id still open", () => {
        const transcript = createTranscriptState();
        transcript.lastAssistantText =
            "harness-spot-limit-1 is still open on BTC-USDT.";
        const failures = evaluateExpectations({
            transcript,
            expect: {
                noHarnessOpenOrders: true,
                harnessClientOrderIds: ["harness-spot-limit-1"],
            },
            caseDef: {},
        });
        expect(failures.length).toBeGreaterThan(0);
        expect(failures[0]).toContain("harness-spot-limit-1");
    });

    it("passes noHarnessOpenOrders when agent echoes harness ids with negation", () => {
        const transcript = createTranscriptState();
        transcript.lastAssistantText =
            "### Open Orders for BTC-USDT\n\nConfirmed none of harness-spot-limit-1 are still open. Other orders show status NEW.";
        const failures = evaluateExpectations({
            transcript,
            expect: {
                noHarnessOpenOrders: true,
                harnessClientOrderIds: ["harness-spot-limit-1"],
            },
            caseDef: {},
        });
        expect(failures).toEqual([]);
    });

    it("passes noHarnessOpenPositions when harness margin ids are absent", () => {
        const transcript = createTranscriptState();
        transcript.lastAssistantText = "No margin positions tied to harness tests.";
        const failures = evaluateExpectations({
            transcript,
            expect: {
                noHarnessOpenPositions: true,
                harnessClientOrderIds: ["harness-margin-cross-limit-1"],
            },
            caseDef: {},
        });
        expect(failures).toEqual([]);
    });
});
