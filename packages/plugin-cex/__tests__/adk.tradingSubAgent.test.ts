import { describe, expect, it } from "vitest";

import {
    createTradingSubAgent,
    visibleTools,
} from "../src/adk/tradingSubAgent";
import type { AdkRuntimeContext } from "../src/adk/types";

function baseContext(
    overrides: Partial<AdkRuntimeContext> = {},
): AdkRuntimeContext {
    return {
        userId: "00000000-0000-0000-0000-000000000001",
        locale: "en",
        stake: "write",
        venue: "binance",
        mode: "live",
        killSwitchActive: false,
        ...overrides,
    };
}

describe("ADK trading sub-agent", () => {
    const agent = createTradingSubAgent();

    describe("happy paths emit canonical_intent", () => {
        it("balance query", () => {
            const r = agent.run({
                message: "What's my BTC balance?",
                context: baseContext({ stake: "read_only" }),
            });
            expect(r.kind).toBe("canonical_intent");
            if (r.kind === "canonical_intent") {
                expect(r.tool).toBe("get_balance");
                expect(r.intent.action).toBe("get_balance");
                expect(r.intent.venue).toBe("binance");
            }
        });

        it("spot balance query → extractedInput carries wallet_type=spot (Issue 4 post-PR237 hotfix)", () => {
            const r = agent.run({
                message: "show my spot balance",
                context: baseContext({ stake: "read_only" }),
            });
            expect(r.kind).toBe("canonical_intent");
            if (r.kind === "canonical_intent") {
                expect(r.tool).toBe("get_balance");
                // The extractor must surface wallet_type so the
                // projector → venue layer can scope the fan-out. Without
                // this, "show my spot balance" silently returns spot +
                // funding + margin (the bug the staging UI test caught).
                expect(r.extractedInput).toMatchObject({ wallet_type: "spot" });
            }
        });

        it("isolated margin balance query → wallet_type=margin_isolated", () => {
            const r = agent.run({
                message: "show my isolated margin balance",
                context: baseContext({ stake: "read_only" }),
            });
            expect(r.kind).toBe("canonical_intent");
            if (r.kind === "canonical_intent") {
                expect(r.extractedInput).toMatchObject({
                    wallet_type: "margin_isolated",
                });
            }
        });

        it("funding balance query → wallet_type=funding", () => {
            const r = agent.run({
                message: "show my funding balance",
                context: baseContext({ stake: "read_only" }),
            });
            expect(r.kind).toBe("canonical_intent");
            if (r.kind === "canonical_intent") {
                expect(r.extractedInput).toMatchObject({ wallet_type: "funding" });
            }
        });

        it("buy market order", () => {
            const r = agent.run({
                message: "buy 0.001 BTC at market on Binance",
                context: baseContext(),
            });
            expect(r.kind).toBe("canonical_intent");
            if (r.kind === "canonical_intent") {
                expect(r.tool).toBe("create_order");
                expect(r.intent.side).toBe("BUY");
                expect(r.intent.size?.base_size).toBe("0.001");
            }
        });

        it("cancel order with id", () => {
            const r = agent.run({
                message: "cancel my order abc12345",
                context: baseContext(),
            });
            expect(r.kind).toBe("canonical_intent");
            if (r.kind === "canonical_intent") {
                expect(r.tool).toBe("cancel_order");
                // Regression: extracted input MUST flow back so the
                // approval form / fast-path can populate `order_ids`
                // without re-asking the LLM. Without this, the form
                // ships empty and the user has to type the id again.
                expect(r.extractedInput).toMatchObject({
                    order_ids: ["abc12345"],
                });
            }
        });

        it("cancel order with long Binance numeric id", () => {
            const r = agent.run({
                message: "cancel order 61914026151",
                context: baseContext(),
            });
            expect(r.kind).toBe("canonical_intent");
            if (r.kind === "canonical_intent") {
                expect(r.tool).toBe("cancel_order");
                expect(r.extractedInput).toMatchObject({
                    order_ids: ["61914026151"],
                });
            }
        });
    });

    describe("clarification paths", () => {
        it("missing order_id for cancel", () => {
            const r = agent.run({
                message: "please cancel my order",
                context: baseContext(),
            });
            expect(r.kind).toBe("clarification_question");
            if (r.kind === "clarification_question") {
                expect(r.text).toMatch(/order id/i);
            }
        });

        it("missing side for create", () => {
            const r = agent.run({
                message: "0.001 BTC at market",
                context: baseContext(),
            });
            expect(r.kind).toBe("clarification_question");
        });

        it("unknown intent", () => {
            const r = agent.run({
                message: "what's the weather today?",
                context: baseContext(),
            });
            expect(r.kind).toBe("clarification_question");
            if (r.kind === "clarification_question") {
                expect(r.text).toMatch(/classify|trading request/i);
            }
        });
    });

    describe("tool exposure gating", () => {
        it("hides ALL tools when kill_switch active (plan §8.7)", () => {
            // Plan §8.7: read-only tools must also fall through to the
            // clarification path when the kill switch is on. Prevents the
            // prior ADK fast-path gap where a balance check could fire
            // while trading was paused.
            const tools = visibleTools(
                baseContext({ killSwitchActive: true }),
            );
            const names = tools.map((t) => t.name);
            expect(names).not.toContain("get_balance");
            expect(names).not.toContain("create_order");
            expect(names).not.toContain("cancel_order");
            expect(names).not.toContain("amend_order");
            expect(names).not.toContain("preview_order");
        });

        it("hides write tools when stake=read_only", () => {
            const tools = visibleTools(baseContext({ stake: "read_only" }));
            const names = tools.map((t) => t.name);
            expect(names).toContain("get_balance");
            expect(names).not.toContain("create_order");
        });

        it("paper mode keeps full toolset", () => {
            const tools = visibleTools(baseContext({ mode: "paper" }));
            expect(tools.length).toBe(7);
        });

        it("kill_switch redirects create_order to clarification", () => {
            const r = agent.run({
                message: "buy 0.001 BTC at market",
                context: baseContext({ killSwitchActive: true }),
            });
            expect(r.kind).toBe("clarification_question");
            if (r.kind === "clarification_question") {
                expect(r.text.toLowerCase()).toMatch(/kill switch|disabled/);
            }
        });

        it("read_only stake redirects write to clarification", () => {
            const r = agent.run({
                message: "buy 0.001 BTC at market",
                context: baseContext({ stake: "read_only" }),
            });
            expect(r.kind).toBe("clarification_question");
        });
    });

    describe("locale-aware clarifications", () => {
        it("emits zh-CN copy", () => {
            const r = agent.run({
                message: "buy 0.001 at market",
                context: baseContext({ locale: "zh-CN" }),
            });
            if (r.kind === "clarification_question") {
                expect(r.text).toMatch(/[㐀-鿿]/);
            }
        });
    });

    describe("forcedTool override", () => {
        it("honors forcedTool with parameterHints", () => {
            const r = agent.run({
                message: "irrelevant text",
                context: baseContext(),
                forcedTool: "get_balance",
                parameterHints: { symbol: "ETH" },
            });
            expect(r.kind).toBe("canonical_intent");
            if (r.kind === "canonical_intent") {
                expect(r.tool).toBe("get_balance");
                expect(r.intent.action).toBe("get_balance");
            }
        });
    });

    describe("venue locking via context", () => {
        it("uses context.venue for intent", () => {
            const r = agent.run({
                message: "balance check",
                context: baseContext({ venue: "coinbase", stake: "read_only" }),
            });
            if (r.kind === "canonical_intent") {
                expect(r.intent.venue).toBe("coinbase");
            }
        });
    });
});
