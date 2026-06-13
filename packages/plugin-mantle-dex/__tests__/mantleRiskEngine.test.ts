import { describe, expect, it } from "vitest";
import { evaluateMantleRisk } from "../src/risk/mantleRiskEngine.ts";

describe("evaluateMantleRisk", () => {
    const baseInput = {
        chainId: 5000,
        tokenIn: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
        tokenOut: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
        amountInHuman: "5",
    };

    it("allows small allowlisted swap", () => {
        const decision = evaluateMantleRisk(baseInput);
        expect(decision.verdict).toBe("allow");
        expect(decision.rulesFired).toHaveLength(0);
    });

    it("refuses oversized trade", () => {
        const decision = evaluateMantleRisk({
            ...baseInput,
            amountInHuman: "1000",
            amountInUsdEstimate: 1000,
        });
        expect(decision.verdict).toBe("refuse");
        expect(decision.rulesFired).toContain("max_trade_usd");
    });

    it("refuses yolo phrasing", () => {
        const decision = evaluateMantleRisk({
            ...baseInput,
            amountInHuman: "all my balance YOLO",
        });
        expect(decision.verdict).toBe("refuse");
        expect(decision.rulesFired).toContain("yolo_size");
    });

    it("refuses excessive slippage", () => {
        const decision = evaluateMantleRisk({
            ...baseInput,
            requestedSlippageBps: 5000,
        });
        expect(decision.verdict).toBe("refuse");
        expect(decision.rulesFired).toContain("max_slippage");
    });
});
