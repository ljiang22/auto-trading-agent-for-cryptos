import { describe, it, expect } from "vitest";
import { hasModeBadge, renderModeBadge } from "../src/handlers/cexWorkflowMessageHandler";
import { getCEXResultFormattingTemplate } from "../src/templates/cexMessageTemplate";

// F1 — formatter template carries the badge contract; the mechanical
// post-check in `generateFormattedResult` enforces it when the SLM forgets.

describe("renderModeBadge", () => {
    it("emits the canonical English paper badge", () => {
        expect(renderModeBadge("paper", "en")).toBe("**[PAPER MODE — no real money]**");
    });
    it("emits the canonical Chinese paper badge", () => {
        expect(renderModeBadge("paper", "zh-CN")).toBe("**[模拟交易 — 无真实资金]**");
    });
    it("emits the canonical English shadow badge", () => {
        expect(renderModeBadge("shadow", "en")).toBe(
            "**[SHADOW MODE — hypothetical, not executed]**",
        );
    });
    it("emits empty string for live mode", () => {
        expect(renderModeBadge("live", "en")).toBe("");
    });
});

describe("hasModeBadge", () => {
    it("detects canonical paper badge", () => {
        expect(hasModeBadge("**[PAPER MODE — no real money]**\n\nbody", "paper")).toBe(true);
    });
    it("detects paraphrased paper badge ('paper order recorded')", () => {
        expect(hasModeBadge("Your paper order has been recorded.", "paper")).toBe(true);
    });
    it("detects Chinese paper badge", () => {
        expect(hasModeBadge("**[模拟交易 — 无真实资金]**", "paper")).toBe(true);
    });
    it("returns false on a hallucinated 'placed on Binance' paper response", () => {
        expect(
            hasModeBadge(
                "Your order was successfully placed on Binance for 0.0001 BTC.",
                "paper",
            ),
        ).toBe(false);
    });
    it("detects shadow badge", () => {
        expect(hasModeBadge("**[SHADOW MODE — hypothetical, not executed]**", "shadow")).toBe(
            true,
        );
    });
    it("returns true for live mode regardless of text (no badge needed)", () => {
        expect(hasModeBadge("Your live order was placed on Binance.", "live")).toBe(true);
    });
});

describe("F1 formatter template", () => {
    it("includes the executionMode placeholder and badge contract", () => {
        const tpl = getCEXResultFormattingTemplate();
        expect(tpl.system).toMatch(/\{\{executionMode\}\}/);
        expect(tpl.system).toMatch(/PAPER MODE — no real money/);
        expect(tpl.system).toMatch(/SHADOW MODE/);
        expect(tpl.prompt).toMatch(/\{\{executionMode\}\}/);
    });
});
