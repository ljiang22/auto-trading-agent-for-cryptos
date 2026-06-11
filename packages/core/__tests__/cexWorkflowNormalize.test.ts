import { describe, expect, it } from "vitest";
import { normalizeTradingApprovalParams } from "../src/handlers/cexWorkflowMessageHandler.ts";

describe("normalizeTradingApprovalParams", () => {
    it("maps symbol to product_id for create_order when product_id missing", () => {
        const out = normalizeTradingApprovalParams("create_order", {
            symbol: "BTC-USD",
            side: "BUY",
        });
        expect(out.product_id).toBe("BTC-USD");
        expect(out.symbol).toBe("BTC-USD");
    });

    it("does not overwrite existing product_id for create_order", () => {
        const out = normalizeTradingApprovalParams("create_order", {
            product_id: "ETH-USD",
            symbol: "BTC-USD",
        });
        expect(out.product_id).toBe("ETH-USD");
    });

    it("maps symbol to product_ids for get_orders", () => {
        const out = normalizeTradingApprovalParams("get_orders", {
            symbol: "BTC-USD",
        });
        expect(out.product_ids).toEqual(["BTC-USD"]);
    });
});
