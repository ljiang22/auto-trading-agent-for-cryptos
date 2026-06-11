import { describe, expect, it } from "vitest";
import { injectMarginContextFromMessage } from "../src/handlers/cexWorkflowMessageHandler.ts";

/**
 * Deterministic margin_type safety net. Even after the canonical-spec
 * field was added in PR #234, the LLM in staging still hit the spot
 * endpoint for "help me check what margin orders do I have" — the
 * field description wasn't included in the LLM-facing format. This
 * regex layer catches the obvious prose signals as a fallback.
 */

describe("injectMarginContextFromMessage", () => {
    it("injects margin_type=CROSS on get_orders when user mentions 'margin orders'", () => {
        const out = injectMarginContextFromMessage(
            "get_orders",
            {},
            "help me check what margin orders do I have",
        );
        expect(out.margin_type).toBe("CROSS");
    });

    it("injects margin_type=CROSS on create_order when user mentions 'borrow'", () => {
        const out = injectMarginContextFromMessage(
            "create_order",
            { side: "SELL" },
            "place 10 usdt sell ETH/USDT at 2100 with borrow mode",
        );
        expect(out.margin_type).toBe("CROSS");
        expect(out.side).toBe("SELL"); // existing params preserved
    });

    it("injects margin_type=ISOLATED when user explicitly mentions isolated", () => {
        const out = injectMarginContextFromMessage(
            "get_orders",
            {},
            "show me my isolated margin orders on Binance",
        );
        expect(out.margin_type).toBe("ISOLATED");
    });

    it("injects margin_type=CROSS for Chinese '杠杆订单'", () => {
        const out = injectMarginContextFromMessage(
            "get_orders",
            {},
            "查看我的杠杆订单",
        );
        expect(out.margin_type).toBe("CROSS");
    });

    it("injects margin_type=ISOLATED for Chinese '逐仓'", () => {
        const out = injectMarginContextFromMessage(
            "get_orders",
            {},
            "我的逐仓杠杆订单",
        );
        expect(out.margin_type).toBe("ISOLATED");
    });

    it("does not inject when user asks about spot orders explicitly", () => {
        const out = injectMarginContextFromMessage(
            "get_orders",
            {},
            "show me my spot orders",
        );
        expect(out.margin_type).toBeUndefined();
    });

    it("does not inject when user message has no margin signal", () => {
        const out = injectMarginContextFromMessage(
            "get_orders",
            {},
            "what orders do I have",
        );
        expect(out.margin_type).toBeUndefined();
    });

    it("respects an existing margin_type set by the LLM", () => {
        const out = injectMarginContextFromMessage(
            "get_orders",
            { margin_type: "ISOLATED" },
            "show me my margin orders",
        );
        // LLM picked ISOLATED — regex would have said CROSS; LLM wins.
        expect(out.margin_type).toBe("ISOLATED");
    });

    it("does not inject on non-margin-aware actions", () => {
        const out = injectMarginContextFromMessage(
            "compile_strategy",
            {},
            "compile my margin strategy",
        );
        expect(out.margin_type).toBeUndefined();
    });

    it("does not inject when userMessage is undefined", () => {
        const out = injectMarginContextFromMessage(
            "get_orders",
            {},
            undefined,
        );
        expect(out.margin_type).toBeUndefined();
    });

    it("handles 'leverage' as a margin signal", () => {
        const out = injectMarginContextFromMessage(
            "create_order",
            {},
            "buy 0.01 BTC with 3x leverage on Binance",
        );
        expect(out.margin_type).toBe("CROSS");
    });

    it("handles 'short' / 'short sell' as a margin signal", () => {
        const out = injectMarginContextFromMessage(
            "create_order",
            {},
            "short sell 0.01 BTC at market",
        );
        expect(out.margin_type).toBe("CROSS");
    });

    it("returns the original object unchanged when no injection happens (referential check)", () => {
        const params = { side: "BUY" };
        const out = injectMarginContextFromMessage("get_orders", params, "what orders do I have");
        expect(out).toBe(params);
    });

    it("does not leak margin signal across actions: get_orders prose with cancel_order action", () => {
        const out = injectMarginContextFromMessage(
            "cancel_order",
            { order_ids: ["x"] },
            "cancel my margin order x",
        );
        // cancel_order IS margin-aware, so CROSS is injected.
        expect(out.margin_type).toBe("CROSS");
    });

    it("'spot' alone does NOT opt out if margin is also mentioned (mixed-mode wording)", () => {
        // Edge case: "my spot and margin orders" — defer to margin.
        const out = injectMarginContextFromMessage(
            "get_orders",
            {},
            "show me my spot and margin orders",
        );
        expect(out.margin_type).toBe("CROSS");
    });
});
