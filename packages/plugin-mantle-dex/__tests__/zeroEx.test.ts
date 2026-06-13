import { describe, expect, it } from "vitest";
import { parseZeroExQuote } from "../src/clients/zeroEx.ts";

describe("parseZeroExQuote", () => {
    it("parses 0x quote response into MantleSwapQuote", () => {
        const quote = parseZeroExQuote(
            5000,
            "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
            "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
            "1000000",
            100,
            {
                buyAmount: "500000000000000000",
                sellAmount: "1000000",
                estimatedGas: "150000",
                priceImpactPercentage: "0.0012",
                sources: [
                    { name: "Agni", proportion: "0.6" },
                    { name: "Merchant Moe", proportion: "0.4" },
                ],
                transaction: {
                    to: "0x1234567890123456789012345678901234567890",
                    data: "0xabcdef",
                    value: "0",
                    gas: "200000",
                },
            },
        );

        expect(quote.chainId).toBe(5000);
        expect(quote.buyAmount).toBe("500000000000000000");
        expect(quote.routeSummary).toContain("Agni");
        expect(quote.transaction?.to).toMatch(/^0x/);
    });
});
