import { describe, it, expect } from "vitest";
import { validateGetOrdersParams } from "../src/actions/shared";

/**
 * B4 regression: `validateGetOrdersParams` did not read `margin_type`.
 * Even when the LLM extracted "show me my margin orders" → `margin_type:
 * "CROSS"`, the param was dropped at the validator and the venue layer
 * defaulted to the spot endpoint (`/api/v3/openOrders`) — so users
 * never saw their margin orders even when the prompt explicitly asked
 * for them.
 */

describe("validateGetOrdersParams — margin_type passthrough (B4)", () => {
    it("propagates margin_type=CROSS", () => {
        const out = validateGetOrdersParams({
            userId: "u-1",
            exchange: "binance",
            margin_type: "CROSS",
        });
        expect(out.margin_type).toBe("CROSS");
    });

    it("propagates margin_type=ISOLATED", () => {
        const out = validateGetOrdersParams({
            userId: "u-1",
            exchange: "binance",
            margin_type: "ISOLATED",
        });
        expect(out.margin_type).toBe("ISOLATED");
    });

    it("normalizes lower-case input", () => {
        const out = validateGetOrdersParams({
            userId: "u-1",
            exchange: "binance",
            margin_type: "cross",
        });
        expect(out.margin_type).toBe("CROSS");
    });

    it("leaves margin_type undefined when not provided (default = spot)", () => {
        const out = validateGetOrdersParams({
            userId: "u-1",
            exchange: "binance",
        });
        expect(out.margin_type).toBeUndefined();
    });

    it("rejects unknown margin_type enum values", () => {
        expect(() =>
            validateGetOrdersParams({
                userId: "u-1",
                exchange: "binance",
                margin_type: "FUTURES",
            }),
        ).toThrow();
    });
});
