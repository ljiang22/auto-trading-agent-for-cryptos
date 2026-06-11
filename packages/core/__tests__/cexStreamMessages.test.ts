import { describe, it, expect } from "vitest";
import {
    getApprovalRequestCopy,
    getOrderSubmitCopy,
    getRiskCheckCopy,
} from "../src/handlers/cexStreamMessages";

// F8 — paper mode must NOT say "exchange" anywhere user-facing during
// the order_submit stage. The orderSubmit row is the loudest place we
// could implicitly tell the user their paper order hit a real venue.

describe("F8 mode-aware stream copy", () => {
    it("paper-mode order submit copy never says 'exchange'", () => {
        const en = getOrderSubmitCopy({ mode: "paper", locale: "en" });
        expect(en.inProgress).not.toMatch(/exchange/i);
        expect(en.completed).not.toMatch(/exchange/i);
        expect(en.inProgress).toMatch(/paper/i);
        expect(en.completed).toMatch(/paper/i);
    });

    it("live-mode order submit copy does say 'exchange' (the legit path)", () => {
        const en = getOrderSubmitCopy({ mode: "live", locale: "en" });
        expect(en.inProgress).toMatch(/exchange/i);
    });

    it("zh-CN paper copy uses 模拟 / 纸面 wording, not 交易所", () => {
        const zh = getOrderSubmitCopy({ mode: "paper", locale: "zh-CN" });
        expect(zh.inProgress).not.toMatch(/交易所/);
        expect(zh.inProgress).toMatch(/(模拟|纸面)/);
    });

    it("shadow-mode copy says 'hypothetical' or 影子", () => {
        expect(getOrderSubmitCopy({ mode: "shadow", locale: "en" }).inProgress).toMatch(/hypothetical|shadow/i);
        expect(getOrderSubmitCopy({ mode: "shadow", locale: "zh-CN" }).inProgress).toMatch(/影子/);
    });

    it("risk-check + approval-request stages also fork by mode", () => {
        expect(getRiskCheckCopy({ mode: "paper", locale: "en" }).inProgress).toMatch(/paper/i);
        expect(getApprovalRequestCopy({ mode: "paper", locale: "en" }).inProgress).toMatch(/paper/i);
        expect(getApprovalRequestCopy({ mode: "live", locale: "en" }).inProgress).not.toMatch(/paper|shadow/i);
    });

    it("defaults to live + en when options are missing", () => {
        const c = getOrderSubmitCopy();
        expect(c.inProgress).toMatch(/exchange/i);
    });

    it("interpolates orderSummary into risk-check copy", () => {
        const c = getRiskCheckCopy({
            mode: "live",
            locale: "en",
            orderSummary: "Limit GTC BUY 0.00006 BTC @ 100000 on BTC-USDT",
        });
        expect(c.inProgress).toContain("Limit GTC BUY");
        expect(c.inProgress).not.toMatch(/limit_limit_gtc/i);
    });

    it("interpolates orderSummary into submit copy without exchange word in paper mode", () => {
        const c = getOrderSubmitCopy({
            mode: "paper",
            locale: "en",
            orderSummary: "Limit GTC BUY on BTC-USDT",
        });
        expect(c.inProgress).toContain("Limit GTC BUY");
        expect(c.inProgress).not.toMatch(/exchange/i);
    });

    it("interpolates orderSummary into approval-request copy", () => {
        const c = getApprovalRequestCopy({
            mode: "live",
            locale: "en",
            orderSummary: "Market IOC BUY $6 on BTC-USDT",
        });
        expect(c.inProgress).toContain("Market IOC BUY");
    });
});
