import { describe, expect, it } from "vitest";

import {
    isExplicitExecuteCommand,
    isStrategyAdviceQuery,
    isStrategyRefinementQuery,
} from "../src/handlers/cexExecutionIntent";

describe("isStrategyRefinementQuery — refine-without-execute gate (#4)", () => {
    it("treats a strategy modification WITHOUT an execute word as a refinement", () => {
        expect(
            isStrategyRefinementQuery(
                "I like the Hybrid DCA strategy, but please modify it. Buy $300 now, buy another $300 if BTC drops 5%, keep $200 as reserve.",
            ),
        ).toBe(true);
    });

    it("does NOT fire when the user explicitly says execute (execute wins)", () => {
        expect(
            isStrategyRefinementQuery(
                "I like the Hybrid DCA strategy, but modify it: buy $300 now. Please execute this modified strategy.",
            ),
        ).toBe(false);
        // sanity: that same message IS an explicit execute command
        expect(
            isExplicitExecuteCommand(
                "Please execute this modified strategy.",
            ),
        ).toBe(true);
    });

    it("does NOT fire for a fresh direct order (not a refinement)", () => {
        expect(isStrategyRefinementQuery("buy 0.1 BTC at 60000")).toBe(false);
        expect(
            isStrategyRefinementQuery("place a $100 market buy for BTC"),
        ).toBe(false);
    });

    it("fires for instead / make-it / what-if refinements", () => {
        expect(isStrategyRefinementQuery("make it $400 now instead")).toBe(true);
        expect(
            isStrategyRefinementQuery("what if we buy $500 now and $300 at -8%?"),
        ).toBe(true);
        expect(
            isStrategyRefinementQuery("change the strategy to weekly $50 buys"),
        ).toBe(true);
    });

    it("does NOT fire for amend/cancel of a specific order", () => {
        expect(isStrategyRefinementQuery("cancel order 123")).toBe(false);
        expect(
            isStrategyRefinementQuery("modify order 123 to 0.2 BTC"),
        ).toBe(false);
    });

    it("does NOT misclassify pure strategy ADVICE as a refinement", () => {
        // advice is a separate bucket; refinement requires edit framing
        expect(
            isStrategyRefinementQuery(
                "suggest an auto-trading strategy to buy BTC with my $1000",
            ),
        ).toBe(false);
        expect(
            isStrategyAdviceQuery(
                "suggest an auto-trading strategy to buy BTC with my $1000",
            ),
        ).toBe(true);
    });
});
