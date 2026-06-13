import { describe, expect, it, afterEach } from "vitest";
import {
    matchesMultiStepPattern,
    resolvePlanExecutionMode,
} from "../src/handlers/cexWorkflowMessageHandler.ts";

describe("matchesMultiStepPattern — conditional buy-ladders route to plan executor", () => {
    it("matches the production repro (conditional dip-ladder)", () => {
        expect(
            matchesMultiStepPattern(
                "Buy $300 now, buy another $300 if BTC drops 5%, buy another $200 if BTC drops 10%, and keep $200 as reserve.",
            ),
        ).toBe(true);
    });

    it("matches 'buy more if it dips'", () => {
        expect(matchesMultiStepPattern("buy $100 of ETH and buy more if it dips 8%")).toBe(true);
    });

    it("matches a bare conditional buy on a price drop", () => {
        expect(matchesMultiStepPattern("add to my BTC position if it falls 10%")).toBe(true);
    });

    it("still matches existing DCA/ladder keywords", () => {
        expect(matchesMultiStepPattern("set up a DCA into BTC")).toBe(true);
        expect(matchesMultiStepPattern("build a 5-level buy ladder for BTC")).toBe(true);
    });

    it("does NOT match a single market order", () => {
        expect(matchesMultiStepPattern("buy 0.01 BTC at market")).toBe(false);
    });

    it("does NOT match a single dollar-sized buy with a limit price", () => {
        expect(matchesMultiStepPattern("buy $300 of BTC at 60000 limit")).toBe(false);
    });
});

describe("resolvePlanExecutionMode — paper default in public mode", () => {
    afterEach(() => {
        delete process.env.PUBLIC_ACCESS_MODE;
    });

    it("honors an explicit override", () => {
        process.env.PUBLIC_ACCESS_MODE = "1";
        expect(resolvePlanExecutionMode("live")).toBe("live");
        expect(resolvePlanExecutionMode("shadow")).toBe("shadow");
    });

    it("defaults to paper in public-access mode when no override", () => {
        process.env.PUBLIC_ACCESS_MODE = "1";
        expect(resolvePlanExecutionMode(undefined)).toBe("paper");
        expect(resolvePlanExecutionMode(null)).toBe("paper");
    });

    it("defaults to live when not in public-access mode", () => {
        delete process.env.PUBLIC_ACCESS_MODE;
        expect(resolvePlanExecutionMode(undefined)).toBe("live");
    });
});
