/**
 * Fix 3 — Plan executor inlines read action results.
 *
 * These tests focus on the rendering boundary (renderPlanCard with
 * `include_results`) plus the LLM fallback helper in cexPlanRunner.
 * The full end-to-end runner flow is exercised at integration time;
 * here we validate the deterministic + fallback paths.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock generation BEFORE importing the module under test so the
// formatPlanResultViaLLM helper resolves through the mock.
const generateTextMock = vi.fn(async () => "");
vi.mock("../src/ai/generation", () => ({
    generateText: (...args: unknown[]) => generateTextMock(...args),
}));

import {
    renderPlanCard,
    renderStepResultBlock,
    STEP_RESULT_BLOCK_MAX_LINES,
} from "../src/handlers/cexPlanExecutor";
import { formatPlanResultViaLLM } from "../src/handlers/cexPlanRunner";
import type { CexPlan, CexPlanStep } from "../src/handlers/cexPlanSchema";
import type { IAgentRuntime, UUID } from "../src/core/types";

function makeStep(overrides: Partial<CexPlanStep>): CexPlanStep {
    return {
        id: overrides.id ?? "x",
        action: overrides.action ?? "get_orders",
        venue: overrides.venue ?? "binance",
        parameters: overrides.parameters ?? {},
        depends_on: overrides.depends_on ?? [],
        stake: overrides.stake ?? "read",
        requires_approval: overrides.requires_approval ?? overrides.stake === "write",
        status: overrides.status ?? "ok",
        description: overrides.description,
        result: overrides.result,
    };
}

function makePlan(steps: CexPlanStep[], overrides: Partial<CexPlan> = {}): CexPlan {
    const now = Date.now();
    return {
        id: overrides.id ?? "plan-test",
        user_id: overrides.user_id ?? "u1",
        room_id: overrides.room_id ?? "r1",
        steps,
        approval_mode: overrides.approval_mode ?? "step_by_step",
        status: overrides.status ?? "completed",
        cursor: overrides.cursor ?? steps.length,
        summary: overrides.summary ?? "test summary",
        created_at: overrides.created_at ?? now,
        expires_at: overrides.expires_at ?? now + 60_000,
        source_message: overrides.source_message ?? "test",
    };
}

const ORDERS_SPOT_TABLE = [
    "| Order ID | Symbol | Side | Type | Price | Quantity | Status |",
    "|----------|--------|------|------|-------|----------|--------|",
    "| 111 | BTCUSDT | BUY | LIMIT | 62000 | 0.01 | NEW |",
].join("\n");

const ORDERS_MARGIN_TABLE = [
    "| Order ID | Symbol | Side | Type | Price | Quantity | Status |",
    "|----------|--------|------|------|-------|----------|--------|",
    "| 222 | ETHUSDT | SELL | LIMIT | 2100 | 1 | PARTIALLY_FILLED |",
].join("\n");

describe("Fix 3 — inlined results, terminal state", () => {
    it("renders both step tables in a completed 2-step plan", () => {
        const plan = makePlan(
            [
                makeStep({
                    id: "1",
                    action: "get_orders",
                    venue: "binance",
                    description: "spot open orders",
                    result: {
                        completed_at: Date.now(),
                        payload: {
                            text: ORDERS_SPOT_TABLE,
                            orders: [{ orderId: 111, symbol: "BTCUSDT" }],
                            scanned_symbols: ["BTCUSDT"],
                        },
                    },
                }),
                makeStep({
                    id: "2",
                    action: "get_orders",
                    venue: "binance",
                    description: "margin open orders",
                    result: {
                        completed_at: Date.now(),
                        payload: {
                            text: ORDERS_MARGIN_TABLE,
                            orders: [{ orderId: 222, symbol: "ETHUSDT" }],
                            scanned_symbols: ["ETHUSDT"],
                        },
                    },
                }),
            ],
            { status: "completed" },
        );

        // Default behavior on terminal state — include_results auto-trues.
        const card = renderPlanCard(plan);

        // CEX post-PR237 Commit 5 — structured rows now take
        // precedence over a short `payload.text`. The structured
        // table is rendered from the `orders` array (with `—` for
        // fields the fixture omits) instead of the pre-rendered
        // text payload. Results render inside collapsible <details> blocks.
        expect(card).toContain("| 111 | BTCUSDT |");
        expect(card).toContain("| 222 | ETHUSDT |");
        // CEX post-PR237 Commit 5 — scope-aware <summary> appends
        // the venue + product context so spot vs margin vs different
        // pairs render distinguishable rows.
        expect(card).toContain("<details><summary>get_orders (binance) — BTCUSDT</summary>");
        expect(card).toContain("<details><summary>get_orders (binance) — ETHUSDT</summary>");
        // Status row sanity check — still shows the step rows.
        expect(card).toContain("✅ ok");
    });

    it("respects explicit include_results=true on non-terminal states", () => {
        const plan = makePlan(
            [
                makeStep({
                    id: "1",
                    action: "get_orders",
                    result: {
                        completed_at: Date.now(),
                        payload: { text: ORDERS_SPOT_TABLE },
                    },
                }),
            ],
            { status: "awaiting_approval", cursor: 0 },
        );

        const card = renderPlanCard(plan, { include_results: true });
        expect(card).toContain(ORDERS_SPOT_TABLE);
    });
});

describe("Fix 3 — no inlining in non-terminal", () => {
    it("omits step result blocks when status is in_progress (default opts)", () => {
        const plan = makePlan(
            [
                makeStep({
                    id: "1",
                    action: "get_orders",
                    result: {
                        completed_at: Date.now(),
                        payload: { text: ORDERS_SPOT_TABLE },
                    },
                }),
                makeStep({
                    id: "2",
                    action: "get_orders",
                    status: "pending",
                }),
            ],
            { status: "executing", cursor: 1 },
        );

        const card = renderPlanCard(plan); // default include_results
        expect(card).not.toContain("<details>");
        expect(card).not.toContain(ORDERS_SPOT_TABLE);
        // Status row for step 1 still present.
        expect(card).toContain("✅ ok");
        expect(card).toContain("⏳ pending");
    });

    it("omits step result blocks when status is awaiting_approval (default opts)", () => {
        const plan = makePlan(
            [
                makeStep({
                    id: "1",
                    action: "get_orders",
                    result: {
                        completed_at: Date.now(),
                        payload: { text: ORDERS_SPOT_TABLE },
                    },
                }),
                makeStep({
                    id: "2",
                    action: "create_order",
                    stake: "write",
                    status: "pending",
                }),
            ],
            { status: "awaiting_approval", cursor: 1 },
        );

        const card = renderPlanCard(plan, { include_next_prompt: true });
        expect(card).not.toContain("<details>");
        expect(card).toContain("`yes`");
    });
});

describe("Fix 3 — truncation", () => {
    it("truncates a 200-line payload block to <= STEP_RESULT_BLOCK_MAX_LINES", () => {
        const longText = Array.from({ length: 200 }, (_, i) => `row ${i}`).join("\n");
        const step = makeStep({
            id: "1",
            action: "get_orders",
            result: {
                completed_at: Date.now(),
                payload: { text: longText, scanned_symbols: ["X"] },
            },
        });
        const block = renderStepResultBlock(step);
        expect(block).not.toBeNull();
        const lineCount = block!.split("\n").length;
        expect(lineCount).toBeLessThanOrEqual(STEP_RESULT_BLOCK_MAX_LINES);
        expect(block).toContain("_…truncated; full result persisted in step state_");
        // The closing tag survives truncation.
        expect(block!.endsWith("</details>")).toBe(true);
    });

    it("does not insert a truncation marker for short payloads", () => {
        const shortText = "small table\n| a | b |";
        const step = makeStep({
            id: "1",
            action: "get_orders",
            result: {
                completed_at: Date.now(),
                payload: { text: shortText, scanned_symbols: ["X"] },
            },
        });
        const block = renderStepResultBlock(step);
        expect(block).not.toBeNull();
        expect(block).not.toContain("_…truncated");
        expect(block).toContain(shortText);
    });
});

describe("Fix 3 — LLM fallback (formatPlanResultViaLLM)", () => {
    beforeEach(() => {
        generateTextMock.mockReset();
    });

    it("calls generateText and returns its trimmed output", async () => {
        generateTextMock.mockResolvedValueOnce(
            "| Order ID | Symbol |\n|---|---|\n| 999 | XRPUSDT |",
        );

        const fakeRuntime = { agentId: "agent-1" as UUID } as unknown as IAgentRuntime;
        const fakeUserId = "user-1" as UUID;
        const out = await formatPlanResultViaLLM(
            "get_orders",
            { orders: [{ orderId: 999, symbol: "XRPUSDT" }] },
            fakeRuntime,
            fakeUserId,
        );

        expect(generateTextMock).toHaveBeenCalledTimes(1);
        expect(out).toContain("| 999 | XRPUSDT |");
        // Inspect args — userId and modelClass should be threaded through.
        const callArgs = generateTextMock.mock.calls[0]?.[0] as {
            userId?: UUID;
            temperature?: number;
            modelClass?: string;
        };
        expect(callArgs.userId).toBe(fakeUserId);
        expect(callArgs.temperature).toBe(0);
    });

    it("returns null when generateText resolves to an empty string", async () => {
        generateTextMock.mockResolvedValueOnce("   ");
        const fakeRuntime = { agentId: "agent-1" as UUID } as unknown as IAgentRuntime;
        const out = await formatPlanResultViaLLM(
            "get_orders",
            { orders: [{ orderId: 1 }] },
            fakeRuntime,
            "user-1" as UUID,
        );
        expect(out).toBeNull();
    });
});

describe("Fix 3 — failed step shows error in card", () => {
    it("renders the step's result.error in the Notes column", () => {
        const plan = makePlan(
            [
                makeStep({
                    id: "1",
                    action: "get_orders",
                    status: "ok",
                    result: {
                        completed_at: Date.now(),
                        payload: { text: ORDERS_SPOT_TABLE },
                    },
                }),
                makeStep({
                    id: "2",
                    action: "create_order",
                    stake: "write",
                    status: "failed",
                    result: {
                        completed_at: Date.now(),
                        error: "venue rejected: insufficient balance",
                    },
                }),
            ],
            { status: "failed", cursor: 1 },
        );

        const card = renderPlanCard(plan);
        // Failed-step row shows the error in Notes; no <details> block
        // for the failed step (the spec routes errors through the row).
        expect(card).toContain("venue rejected: insufficient balance");
        expect(card).toContain("❌ failed");
        // The successful step still gets its inlined block on a
        // terminal-status (failed) plan.
        expect(card).toContain(ORDERS_SPOT_TABLE);
    });
});

describe("Fix 3 — deterministic fallback shapes (no text field)", () => {
    it("renders an orders table when payload has orders[] but no text", () => {
        const plan = makePlan(
            [
                makeStep({
                    id: "1",
                    action: "get_orders",
                    result: {
                        completed_at: Date.now(),
                        payload: {
                            orders: [
                                {
                                    order_id: 555,
                                    symbol: "BTCUSDT",
                                    side: "BUY",
                                    type: "LIMIT",
                                    price: 60000,
                                    quantity: 0.02,
                                    status: "NEW",
                                },
                            ],
                            scanned_symbols: ["BTCUSDT"],
                        },
                    },
                }),
            ],
            { status: "completed" },
        );
        const card = renderPlanCard(plan);
        expect(card).toContain("| 555 | BTCUSDT | BUY | LIMIT | 60000 | 0.02 | NEW |");
    });

    it("renders a balance table with Est. Total Value footer", () => {
        const plan = makePlan(
            [
                makeStep({
                    id: "1",
                    action: "get_balance",
                    result: {
                        completed_at: Date.now(),
                        payload: {
                            accounts: [
                                { asset: "BTC", free: "0.5", locked: "0", estimated_usdt: 31000 },
                                { asset: "USDT", free: "100", locked: "0", estimated_usdt: 100 },
                            ],
                            estimated_total_usdt: 31100,
                        },
                    },
                }),
            ],
            { status: "completed" },
        );
        const card = renderPlanCard(plan);
        expect(card).toContain("| BTC | 0.5 | 0 | 31000 |");
        expect(card).toContain("| USDT | 100 | 0 | 100 |");
        expect(card).toContain("**Est. Total Value:** 31100.00 USDT");
    });
});

// ── normalizeLimitOrderParamsAtMid (plan-path order normalization) ──────────────────────────────

import { normalizeLimitOrderParamsAtMid } from "../src/handlers/cexPlanRunner";

describe("normalizeLimitOrderParamsAtMid", () => {
    const leg = (extra: Record<string, unknown> = {}, inner: Record<string, unknown> = { quote_size: "300" }) => ({
        product_id: "BTC-USDT",
        side: "BUY",
        order_configuration: { limit_limit_gtc: { ...inner } },
        ...extra,
    });

    it("computes the limit price from trigger_drop_pct (the USER'S level, math in the note)", () => {
        const { params, note } = normalizeLimitOrderParamsAtMid(leg({ trigger_drop_pct: "5" }), 60000, "binance");
        const inner = (params.order_configuration as Record<string, Record<string, string>>).limit_limit_gtc;
        expect(inner.limit_price).toBe("57000.00"); // 60000 × 0.95
        expect(note).toMatch(/1 − 5%/);
        expect(params.trigger_drop_pct).toBeUndefined(); // consumed, never sent to the venue
    });

    it("two legs with different drop percentages land at DIFFERENT prices (the silent-same-price bug)", () => {
        const a = normalizeLimitOrderParamsAtMid(leg({ trigger_drop_pct: "5" }), 60000, "binance");
        const b = normalizeLimitOrderParamsAtMid(leg({ trigger_drop_pct: "10" }, { quote_size: "200" }), 60000, "binance");
        const pa = (a.params.order_configuration as Record<string, Record<string, string>>).limit_limit_gtc.limit_price;
        const pb = (b.params.order_configuration as Record<string, Record<string, string>>).limit_limit_gtc.limit_price;
        expect(pa).toBe("57000.00");
        expect(pb).toBe("54000.00");
        expect(pa).not.toBe(pb);
    });

    it("falls back to the conservative 80% placeholder when no trigger level is given", () => {
        const { params, note } = normalizeLimitOrderParamsAtMid(leg(), 60000, "binance");
        const inner = (params.order_configuration as Record<string, Record<string, string>>).limit_limit_gtc;
        expect(inner.limit_price).toBe("48000.00");
        expect(note).toMatch(/placeholder/);
    });

    it("converts quote_size → base_size at the computed price for Binance limit legs", () => {
        const { params } = normalizeLimitOrderParamsAtMid(leg({ trigger_drop_pct: "5" }), 60000, "binance");
        const inner = (params.order_configuration as Record<string, Record<string, string>>).limit_limit_gtc;
        expect(inner.quote_size).toBeUndefined();
        expect(inner.base_size).toBe((300 / 57000).toFixed(8));
    });

    it("leaves params untouched without a mid price (fail-soft) and for non-limit variants", () => {
        const noMid = normalizeLimitOrderParamsAtMid(leg({ trigger_drop_pct: "5" }), null, "binance");
        const inner = (noMid.params.order_configuration as Record<string, Record<string, string>>).limit_limit_gtc;
        expect(inner.limit_price).toBeUndefined();
        const market = normalizeLimitOrderParamsAtMid(
            { product_id: "BTC-USDT", order_configuration: { market_market_ioc: { quote_size: "100" } } },
            60000,
            "binance",
        );
        expect((market.params.order_configuration as Record<string, Record<string, string>>).market_market_ioc.quote_size).toBe("100");
    });
});
