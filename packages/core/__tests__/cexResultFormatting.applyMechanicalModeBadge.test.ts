import { describe, it, expect } from "vitest";
import { applyMechanicalModeBadge } from "../src/handlers/cexWorkflowMessageHandler";

// F1 — reviewer asked for an e2e test proving `generateFormattedResult`
// prepends the badge when the SLM omits it. The full handler can't be
// unit-tested without a live LLM provider, so the mechanical post-check
// is extracted into `applyMechanicalModeBadge(displayText, mode, locale)`
// and used by `generateFormattedResult` verbatim. Testing the helper
// proves the formatter behavior — there is no other code path between
// "SLM returned displayText" and "displayText leaves generateFormattedResult".

describe("F1 applyMechanicalModeBadge — SLM omission scenarios", () => {
    it("prepends the canonical English paper badge to an SLM 'placed on Binance' hallucination", () => {
        // QA C1 reproduction: the SLM produced a hallucinated live-style
        // confirmation while the order was actually paper. The mechanical
        // post-check must prefix the warning.
        const slmOmittedBadge =
            "Your order was successfully placed on Binance for 0.0001 BTC at $60,000.";
        const out = applyMechanicalModeBadge(slmOmittedBadge, "paper", "en");
        expect(out.startsWith("**[PAPER MODE — no real money]**")).toBe(true);
        expect(out).toContain(slmOmittedBadge);
    });

    it("prepends the zh-CN paper badge for Chinese locale", () => {
        const out = applyMechanicalModeBadge("订单已成功提交到币安。", "paper", "zh-CN");
        expect(out.startsWith("**[模拟交易 — 无真实资金]**")).toBe(true);
    });

    it("does NOT prefix when the SLM already emitted the canonical badge", () => {
        const slmAlreadyBadged = "**[PAPER MODE — no real money]**\n\nPaper order paper-ord-abc submitted.";
        const out = applyMechanicalModeBadge(slmAlreadyBadged, "paper", "en");
        // No double-prefix
        expect(out).toBe(slmAlreadyBadged);
    });

    it("does NOT prefix when the SLM paraphrased the badge ('Your paper order has been recorded')", () => {
        const paraphrased = "Your paper order has been recorded with id paper-ord-xyz.";
        const out = applyMechanicalModeBadge(paraphrased, "paper", "en");
        // hasModeBadge accepts the paraphrase, so the post-check is a no-op
        expect(out).toBe(paraphrased);
    });

    it("prepends the SHADOW badge for shadow mode and is distinguishable from paper", () => {
        // "Hypothetical" / "影子" are already accepted as shadow paraphrases
        // by hasModeBadge — keep this input free of those so we test the
        // prefix path, not the no-op path.
        const slmOmitted = "Order recorded with id shadow-ord-xyz.";
        const out = applyMechanicalModeBadge(slmOmitted, "shadow", "en");
        expect(out.startsWith("**[SHADOW MODE — hypothetical, not executed]**")).toBe(true);
        // Distinct from paper — no paper badge text
        expect(out).not.toMatch(/\bPAPER\s*MODE\b/);
        expect(out).not.toMatch(/no real money/);
    });

    it("live mode is a no-op — never prefixes (even if the SLM said something weird)", () => {
        const live = "Order placed on Binance.";
        const out = applyMechanicalModeBadge(live, "live", "en");
        expect(out).toBe(live);
    });
});
