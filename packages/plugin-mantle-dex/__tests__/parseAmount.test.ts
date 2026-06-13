import { describe, expect, it } from "vitest";
import { parseAmountToBaseUnits } from "../src/config/tokens.ts";

describe("parseAmountToBaseUnits (human → base units)", () => {
    it("scales an integer human amount by decimals (the dust-swap regression)", () => {
        // "swap 5 USDC" must be 5_000_000 base units, NOT 5.
        expect(parseAmountToBaseUnits("5", 6)).toBe("5000000");
        expect(parseAmountToBaseUnits("5", 18)).toBe("5000000000000000000");
        expect(parseAmountToBaseUnits("10", 6)).toBe("10000000");
    });

    it("scales fractional amounts", () => {
        expect(parseAmountToBaseUnits("0.5", 6)).toBe("500000");
        expect(parseAmountToBaseUnits("1.5", 6)).toBe("1500000");
        expect(parseAmountToBaseUnits("0.001", 6)).toBe("1000");
    });

    it("truncates fractional precision beyond decimals", () => {
        expect(parseAmountToBaseUnits("1.2345678", 6)).toBe("1234567");
    });

    it("normalizes zero and leading zeros", () => {
        expect(parseAmountToBaseUnits("0", 6)).toBe("0");
        expect(parseAmountToBaseUnits("05", 6)).toBe("5000000");
    });
});
