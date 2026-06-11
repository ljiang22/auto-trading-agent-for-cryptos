import { describe, expect, it } from "vitest";

import {
    buildDedupContext,
    buildDedupExistingOrderSummary,
    dedupActionGuidanceForKind,
    dedupApprovalDescription,
    dedupApprovalTitleForKind,
    dedupSubmitButtonLabel,
    dedupWarningForKind,
} from "../src/handlers/cexDedupApproval";

describe("cexDedupApproval", () => {
    const row = {
        client_order_id: "bn-abc123",
        venue: "binance",
        symbol: "BTC-USDT",
        state: "filled" as const,
        submittedAt: "2026-06-05T10:00:00.000Z",
        lastSeenAt: "2026-06-05T10:00:05.000Z",
        latest_payload: { orderId: "61908270229" },
    };

    it("buildDedupExistingOrderSummary extracts venue order id from payload", () => {
        const summary = buildDedupExistingOrderSummary(row);
        expect(summary.venue_order_id).toBe("61908270229");
        expect(summary.client_order_id).toBe("bn-abc123");
        expect(summary.state).toBe("filled");
    });

    it("dedupApprovalDescription includes previous order fields", () => {
        const summary = buildDedupExistingOrderSummary(row);
        const md = dedupApprovalDescription(summary, "terminal", "en");
        expect(md).toContain("filled");
        expect(md).toContain("bn-abc123");
        expect(md).toContain("61908270229");
    });

    it("dedupWarningForKind varies by kind", () => {
        expect(dedupWarningForKind("in_flight", "en")).toMatch(/in flight/i);
        expect(dedupWarningForKind("unknown_state", "en")).toMatch(/reconciliation/i);
        expect(dedupWarningForKind("terminal", "zh-CN")).toMatch(/账本/);
    });

    it("unknown_state title differs from terminal", () => {
        expect(dedupApprovalTitleForKind("unknown_state", "en")).toBe(
            "Previous order status unknown",
        );
        expect(dedupApprovalTitleForKind("terminal", "en")).toBe(
            "Duplicate order detected",
        );
        expect(dedupApprovalTitleForKind("unknown_state", "zh-CN")).toMatch(/未知/);
    });

    it("unknown_state action guidance mentions reconciliation and /orders", () => {
        const guidance = dedupActionGuidanceForKind("unknown_state", "en");
        expect(guidance).toMatch(/reconciliation|\/orders/i);
        expect(guidance).toMatch(/risk gates|Cancel/i);
    });

    it("buildDedupContext includes title and action_guidance for client payload", () => {
        const summary = buildDedupExistingOrderSummary({
            ...row,
            state: "unknown",
        });
        const ctx = buildDedupContext("unknown_state", summary, "en");
        expect(ctx.kind).toBe("unknown_state");
        expect(ctx.title).toBe("Previous order status unknown");
        expect(ctx.action_guidance).toMatch(/\/orders/);
        expect(ctx.warning).toMatch(/reconciliation/i);
        expect(ctx.existing_order.last_seen_at).toBe("2026-06-05T10:00:05.000Z");
    });

    it("dedupSubmitButtonLabel is kind-specific for unknown_state", () => {
        expect(dedupSubmitButtonLabel("unknown_state", "en")).toMatch(/new order/i);
        expect(dedupSubmitButtonLabel("terminal", "en")).toMatch(/another order/i);
    });
});
