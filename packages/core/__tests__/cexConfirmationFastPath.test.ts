import { describe, expect, it } from "vitest";

import {
    AFFIRMATIVE_EN,
    AFFIRMATIVE_ZH,
    CANCEL_PROPOSAL_PATTERNS,
} from "../src/handlers/cexWorkflowMessageHandler.ts";

function matchesProposal(text: string): boolean {
    return CANCEL_PROPOSAL_PATTERNS.some((p) => p.test(text));
}

describe("cexWorkflow confirmation fast-path regex set", () => {
    it("recognizes the canonical EN affirmatives", () => {
        for (const t of [
            "yes",
            "yes please",
            "yes, please",
            "yes please.",
            "YES, PLEASE",
            "yep",
            "yeah",
            "sure",
            "ok",
            "okay",
            "confirm",
            "confirmed",
            "proceed",
            "do it",
            "go ahead",
            "please do",
            "please proceed",
            "please continue",
            "continue",
        ]) {
            expect(AFFIRMATIVE_EN.test(t), `EN affirmative: ${t}`).toBe(true);
        }
    });

    it("rejects non-affirmatives that contain 'yes' or similar tokens", () => {
        for (const t of [
            "yes I want to cancel order 12345",
            "no thanks",
            "yes but only the first one",
            "wait yes",
            "tell me yes or no",
        ]) {
            expect(AFFIRMATIVE_EN.test(t), `should NOT match: ${t}`).toBe(false);
        }
    });

    it("recognizes the canonical ZH affirmatives", () => {
        for (const t of ["好", "好的", "确认", "是", "是的", "可以", "继续", "对", "请继续", "请执行", "没问题", "行"]) {
            expect(AFFIRMATIVE_ZH.test(t), `ZH affirmative: ${t}`).toBe(true);
        }
    });

    it("matches assistant proposals that use 'cancelling' (UK spelling)", () => {
        const memo =
            "I found the following open orders on your Binance account. I am ready to proceed with cancelling them.";
        expect(matchesProposal(memo)).toBe(true);
    });

    it("matches assistant proposals that use 'canceling' (US spelling)", () => {
        const memo =
            "I found 1 open order. Would you like me to proceed with canceling this order?";
        expect(matchesProposal(memo)).toBe(true);
    });

    it("matches 'please confirm if you would like to cancel ...'", () => {
        const memo =
            "Symbol BTC-USDT ... NEW. Please confirm if you would like to cancel this order.";
        expect(matchesProposal(memo)).toBe(true);
    });

    it("matches 'this is the order that would be canceled'", () => {
        const memo =
            "This is the order that would be canceled. Would you like me to proceed?";
        expect(matchesProposal(memo)).toBe(true);
    });

    it("matches ZH cancellation proposals", () => {
        expect(matchesProposal("我准备取消你的订单。请确认。")).toBe(true);
        expect(matchesProposal("请确认是否撤销该订单？")).toBe(true);
    });

    it("does NOT match assistant turns unrelated to cancel proposals", () => {
        for (const t of [
            "Here is your account balance on Binance: BTC 0.001, USDT 100.",
            "Your limit buy order has been successfully placed.",
            "I couldn't find any open orders on your Binance account.",
            "你好，今天市场怎么样？",
        ]) {
            expect(matchesProposal(t), `should NOT match: ${t}`).toBe(false);
        }
    });
});
