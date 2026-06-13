import { describe, expect, it } from "vitest";
import { mantleSwapParamsSchema } from "../src/types.ts";

describe("mantleSwapParamsSchema", () => {
    const valid = {
        tokenIn: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
        tokenOut: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
        amountIn: "1000000",
        maxSlippageBps: 100,
        chainId: 5000,
    };

    it("accepts valid swap params", () => {
        expect(mantleSwapParamsSchema.parse(valid)).toEqual(valid);
    });

    it("rejects invalid address", () => {
        expect(() =>
            mantleSwapParamsSchema.parse({ ...valid, tokenIn: "not-an-address" }),
        ).toThrow();
    });

    it("rejects slippage above 10000 bps", () => {
        expect(() =>
            mantleSwapParamsSchema.parse({ ...valid, maxSlippageBps: 10001 }),
        ).toThrow();
    });

    it("rejects empty amountIn", () => {
        expect(() =>
            mantleSwapParamsSchema.parse({ ...valid, amountIn: "" }),
        ).toThrow();
    });
});
