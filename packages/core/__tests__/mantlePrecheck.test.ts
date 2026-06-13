import { describe, expect, it } from "vitest";
import { evaluateShortCircuit } from "../src/handlers/langGraphPrecheck.ts";

describe("mantle short-circuit routing", () => {
    it("routes swap on Mantle to MANTLE_WORKFLOW_MESSAGE", () => {
        const result = evaluateShortCircuit("swap 5 USDC to WMNT on Mantle");
        expect(result?.classification).toBe("MANTLE_WORKFLOW_MESSAGE");
        expect(result?.name).toBe("mantle_swap_intent");
    });

    it("routes Mantle balance query", () => {
        const result = evaluateShortCircuit("show my Mantle wallet balance");
        expect(result?.classification).toBe("MANTLE_WORKFLOW_MESSAGE");
        expect(result?.name).toBe("mantle_balance_intent");
    });

    it("Mantle routes before CEX trade intent", () => {
        const result = evaluateShortCircuit(
            "swap 10 USDC to WMNT on Mantle please",
        );
        expect(result?.classification).toBe("MANTLE_WORKFLOW_MESSAGE");
    });
});
