import { describe, it, expect } from "vitest";
import { validateCreateOrderParams } from "../src/actions/shared";

/**
 * B5 regression: `margin_action` was silently dropped by
 * `validateCreateOrderParams`. Downstream `marginActionToSideEffect`
 * received `undefined` → returned `NO_SIDE_EFFECT` → every margin
 * order shipped to Binance with auto-borrow OFF, regardless of what
 * the LLM extracted from "place ... with borrow mode".
 */

const baseParams = {
    userId: "u-1",
    exchange: "binance",
    product_id: "ETH-USDT",
    side: "SELL",
    client_order_id: "co-test",
    order_configuration: {
        limit_limit_gtc: {
            base_size: "0.005",
            limit_price: "2100",
        },
    },
};

describe("validateCreateOrderParams — margin_action passthrough (B5)", () => {
    it("propagates margin_action=AUTO_BORROW from user params", () => {
        const out = validateCreateOrderParams({
            ...baseParams,
            margin_type: "CROSS",
            leverage: "2",
            margin_action: "AUTO_BORROW",
        });
        expect(out.margin_type).toBe("CROSS");
        expect(out.leverage).toBe("2");
        expect(out.margin_action).toBe("AUTO_BORROW");
    });

    it("propagates margin_action=AUTO_REPAY", () => {
        const out = validateCreateOrderParams({
            ...baseParams,
            margin_type: "ISOLATED",
            margin_action: "AUTO_REPAY",
        });
        expect(out.margin_action).toBe("AUTO_REPAY");
    });

    it("normalizes lower-case input to upper-case (mirrors margin_type behavior)", () => {
        const out = validateCreateOrderParams({
            ...baseParams,
            margin_type: "CROSS",
            margin_action: "auto_borrow",
        });
        expect(out.margin_action).toBe("AUTO_BORROW");
    });

    it("leaves margin_action undefined when not provided (default NORMAL semantics in adapter)", () => {
        const out = validateCreateOrderParams({
            ...baseParams,
            margin_type: "CROSS",
        });
        expect(out.margin_action).toBeUndefined();
    });

    it("rejects unknown margin_action enum values", () => {
        expect(() =>
            validateCreateOrderParams({
                ...baseParams,
                margin_type: "CROSS",
                margin_action: "BORROW_MORE", // invalid
            }),
        ).toThrow();
    });
});
