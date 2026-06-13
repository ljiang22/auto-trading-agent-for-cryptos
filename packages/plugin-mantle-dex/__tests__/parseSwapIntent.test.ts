import { describe, expect, it } from "vitest";
import {
    isApprovalMessage,
    parseSwapIntentFromText,
} from "../src/utils/parseSwapIntent.ts";

describe("parseSwapIntentFromText", () => {
    it("parses Mantle swap phrasing", () => {
        const intent = parseSwapIntentFromText(
            "swap 5 USDC to WMNT on Mantle",
        );
        expect(intent).toEqual({
            amountIn: "5",
            tokenInSymbol: "USDC",
            tokenOutSymbol: "WMNT",
            maxSlippageBps: undefined,
        });
    });

    it("returns null for unrelated text", () => {
        expect(parseSwapIntentFromText("what is bitcoin")).toBeNull();
    });
});

describe("isApprovalMessage", () => {
    it("detects approve and cancel", () => {
        expect(isApprovalMessage("approve")).toBe("approve");
        expect(isApprovalMessage("cancel")).toBe("cancel");
        expect(isApprovalMessage("maybe later")).toBeNull();
    });
});
