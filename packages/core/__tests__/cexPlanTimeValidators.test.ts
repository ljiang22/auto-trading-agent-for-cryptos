/**
 * Fix 7 — plan-time validator chain tests.
 *
 * Coverage:
 *   - H-6: zero base_size → refused with schema error (mentions "positive").
 *   - M-8: quote_size over the user's `max_order_notional_usd` → refused
 *           with the maxOrderSize rule's explanation.
 *   - M-7: delisted symbol (status="BREAK") → refused with "no longer
 *           actively traded".
 *   - M-6: sub-min-notional order → refused with the exact
 *           `$X is below $Y` message.
 *   - Pure-read plan: no validator runs.
 *   - Clarify step: validator skips it.
 *   - Feature flag off: plans pass through unchanged.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    isPlanTimeValidatorsEnabled,
    PLAN_TIME_VALIDATORS_FLAG,
    planStepToCanonicalIntent,
    runPlanTimeValidators,
} from "../src/handlers/cexPlanTimeValidators";
import type {
    CexPlan,
    CexPlanStep,
} from "../src/handlers/cexPlanSchema";
import type {
    CEXSpecProvider,
    CEXSymbolFilters,
    IAgentRuntime,
} from "../src/core/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<CexPlanStep>): CexPlanStep {
    return {
        id: overrides.id ?? "1",
        action: overrides.action ?? "create_order",
        venue: overrides.venue ?? "binance",
        parameters: overrides.parameters ?? {},
        depends_on: overrides.depends_on ?? [],
        stake: overrides.stake ?? "write",
        requires_approval: overrides.requires_approval ?? overrides.stake !== "read",
        status: overrides.status ?? "pending",
        description: overrides.description,
        result: overrides.result,
    };
}

function makePlan(steps: CexPlanStep[]): CexPlan {
    const now = Date.now();
    return {
        id: "plan-test",
        user_id: "u1",
        room_id: "r1",
        steps,
        approval_mode: "step_by_step",
        status: "draft",
        cursor: 0,
        summary: "test plan",
        created_at: now,
        expires_at: now + 60_000,
        source_message: "test",
    };
}

interface ProviderStubOptions {
    validateCanonicalIntent?: CEXSpecProvider["validateCanonicalIntent"];
    runRiskPrecheck?: CEXSpecProvider["runRiskPrecheck"];
    fetchSymbolFilters?: CEXSpecProvider["fetchSymbolFilters"];
    fetchMarketMidUsd?: CEXSpecProvider["fetchMarketMidUsd"];
}

function makeRuntime(provider: ProviderStubOptions, settings: Record<string, string> = {}): IAgentRuntime {
    const stub: Partial<CEXSpecProvider> = {
        validateCanonicalIntent: provider.validateCanonicalIntent,
        runRiskPrecheck: provider.runRiskPrecheck,
        fetchSymbolFilters: provider.fetchSymbolFilters,
        fetchMarketMidUsd: provider.fetchMarketMidUsd,
    };
    const plugins = [
        {
            name: "cex",
            cexSpecProvider: stub as CEXSpecProvider,
        },
    ];
    return {
        agentId: "agent-1",
        plugins,
        getSetting: (key: string) => settings[key],
        databaseAdapter: {},
    } as unknown as IAgentRuntime;
}

// ---------------------------------------------------------------------------
// planStepToCanonicalIntent unit tests
// ---------------------------------------------------------------------------

describe("planStepToCanonicalIntent", () => {
    it("returns null for clarify steps", () => {
        const step = makeStep({
            action: "clarify",
            stake: "read",
            parameters: { question: "?" },
        });
        const out = planStepToCanonicalIntent(step, "u1", "en", "binance");
        expect(out).toBeNull();
    });

    it("returns null for read steps", () => {
        const step = makeStep({ action: "get_balance", stake: "read" });
        const out = planStepToCanonicalIntent(step, "u1", "en", "binance");
        expect(out).toBeNull();
    });

    it("projects a write step into a canonical-intent input shape", () => {
        const step = makeStep({
            id: "1",
            action: "create_order",
            venue: "binance",
            stake: "write",
            parameters: {
                product_id: "BTC-USDT",
                side: "BUY",
                order_configuration: {
                    limit_limit_gtc: { base_size: "0.001", limit_price: "62000" },
                },
            },
        });
        const out = planStepToCanonicalIntent(step, "u1", "en", "binance");
        expect(out).toEqual({
            action: "create_order",
            venue: "binance",
            userId: "u1",
            locale: "en",
            params: {
                product_id: "BTC-USDT",
                side: "BUY",
                order_configuration: {
                    limit_limit_gtc: { base_size: "0.001", limit_price: "62000" },
                },
                userId: "u1",
            },
        });
    });

    it("falls back to the default venue when step.venue is null", () => {
        const step = makeStep({ venue: null });
        const out = planStepToCanonicalIntent(step, "u1", "en", "binance");
        expect(out?.venue).toBe("binance");
    });
});

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

describe("isPlanTimeValidatorsEnabled", () => {
    it("returns true only when the setting is exactly 'true'", () => {
        const onRt = makeRuntime({}, { [PLAN_TIME_VALIDATORS_FLAG]: "true" });
        expect(isPlanTimeValidatorsEnabled(onRt)).toBe(true);
        const offRt = makeRuntime({}, { [PLAN_TIME_VALIDATORS_FLAG]: "false" });
        expect(isPlanTimeValidatorsEnabled(offRt)).toBe(false);
        const unsetRt = makeRuntime({}, {});
        expect(isPlanTimeValidatorsEnabled(unsetRt)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// runPlanTimeValidators — integration tests
// ---------------------------------------------------------------------------

describe("runPlanTimeValidators — H-6 (zero quantity)", () => {
    it("refuses a create_order with base_size=0 via schema validation", async () => {
        // Stub validator returns the same zod error path the real plugin
        // does for `positiveDecimalString` rejecting "0".
        const validate: CEXSpecProvider["validateCanonicalIntent"] = vi.fn(() => ({
            ok: false,
            error: "size.base_size: must be a positive decimal",
        }));
        const runtime = makeRuntime({ validateCanonicalIntent: validate });
        const plan = makePlan([
            makeStep({
                id: "1",
                action: "create_order",
                stake: "write",
                parameters: {
                    product_id: "BTC-USDT",
                    side: "BUY",
                    order_configuration: {
                        limit_limit_gtc: { base_size: "0", limit_price: "62000" },
                    },
                },
            }),
        ]);
        const outcome = await runPlanTimeValidators(plan, {
            runtime,
            userId: "u1",
            locale: "en",
            defaultVenue: "binance",
        });
        expect(outcome.ok).toBe(false);
        expect(outcome.failingStepId).toBe("1");
        expect(outcome.failingMessage).toContain("positive decimal");
        expect(plan.status).toBe("failed");
        expect(plan.steps[0].status).toBe("failed");
        expect(plan.steps[0].result?.error).toContain("positive decimal");
        expect(validate).toHaveBeenCalledTimes(1);
    });
});

describe("runPlanTimeValidators — M-8 (over notional cap)", () => {
    it("refuses with the maxOrderSize rule's explanation", async () => {
        const validate: CEXSpecProvider["validateCanonicalIntent"] = vi.fn(() => ({
            ok: true,
        }));
        // The risk engine returns block with the maxOrderSize explanation.
        const risk: CEXSpecProvider["runRiskPrecheck"] = vi.fn(async () => ({
            verdict: "block",
            rules_fired: ["maxOrderSize"],
            explanations: [
                "Order notional $10000.00 exceeds your maxOrderSize cap of $1000.00",
            ],
        }));
        const runtime = makeRuntime({
            validateCanonicalIntent: validate,
            runRiskPrecheck: risk,
        });
        const plan = makePlan([
            makeStep({
                id: "1",
                action: "create_order",
                stake: "write",
                parameters: {
                    product_id: "BTC-USDT",
                    side: "BUY",
                    order_configuration: {
                        market_market_ioc: { quote_size: "10000" },
                    },
                },
            }),
        ]);
        const outcome = await runPlanTimeValidators(plan, {
            runtime,
            userId: "u1",
            locale: "en",
            defaultVenue: "binance",
        });
        expect(outcome.ok).toBe(false);
        expect(outcome.failingStepId).toBe("1");
        expect(outcome.failingMessage).toContain("maxOrderSize cap");
        expect(plan.steps[0].result?.error).toContain("maxOrderSize cap");
        expect(plan.status).toBe("failed");
    });
});

describe("runPlanTimeValidators — M-7 (delisted symbol)", () => {
    it("refuses with 'no longer actively traded' when status != TRADING", async () => {
        const validate: CEXSpecProvider["validateCanonicalIntent"] = vi.fn(() => ({
            ok: true,
        }));
        const risk: CEXSpecProvider["runRiskPrecheck"] = vi.fn(async () => null);
        const fetchFilters: CEXSpecProvider["fetchSymbolFilters"] = vi.fn(
            async (): Promise<CEXSymbolFilters | null> => ({
                status: "BREAK",
                minNotional: "5",
                minQty: "0.00001",
                stepSize: "0.00001",
                tickSize: "0.01",
            }),
        );
        const runtime = makeRuntime({
            validateCanonicalIntent: validate,
            runRiskPrecheck: risk,
            fetchSymbolFilters: fetchFilters,
        });
        const plan = makePlan([
            makeStep({
                id: "1",
                action: "create_order",
                venue: "binance",
                stake: "write",
                parameters: {
                    product_id: "XYZ-USDT",
                    side: "BUY",
                    order_configuration: {
                        market_market_ioc: { base_size: "1" },
                    },
                },
            }),
        ]);
        const outcome = await runPlanTimeValidators(plan, {
            runtime,
            userId: "u1",
            locale: "en",
            defaultVenue: "binance",
        });
        expect(outcome.ok).toBe(false);
        expect(outcome.failingMessage).toMatch(/XYZUSDT.*no longer actively traded/);
        expect(outcome.failingMessage).toContain("binance");
        expect(plan.steps[0].result?.error).toContain("no longer actively traded");
        expect(fetchFilters).toHaveBeenCalledWith({ venue: "binance", symbol: "XYZUSDT" });
    });
});

describe("runPlanTimeValidators — M-6 (sub-min-notional)", () => {
    it("refuses with the exact $X is below $Y message", async () => {
        const validate: CEXSpecProvider["validateCanonicalIntent"] = vi.fn(() => ({
            ok: true,
        }));
        const risk: CEXSpecProvider["runRiskPrecheck"] = vi.fn(async () => null);
        const fetchFilters: CEXSpecProvider["fetchSymbolFilters"] = vi.fn(
            async (): Promise<CEXSymbolFilters | null> => ({
                status: "TRADING",
                minNotional: "5",
                minQty: "0.00001",
                stepSize: "0.00001",
                tickSize: "0.01",
            }),
        );
        // Market order with base_size 0.000001 → need a mid price.
        const fetchMid: CEXSpecProvider["fetchMarketMidUsd"] = vi.fn(async () => 77000);
        const runtime = makeRuntime({
            validateCanonicalIntent: validate,
            runRiskPrecheck: risk,
            fetchSymbolFilters: fetchFilters,
            fetchMarketMidUsd: fetchMid,
        });
        const plan = makePlan([
            makeStep({
                id: "1",
                action: "create_order",
                venue: "binance",
                stake: "write",
                parameters: {
                    product_id: "BTC-USDT",
                    side: "BUY",
                    order_configuration: {
                        market_market_ioc: { base_size: "0.000001" },
                    },
                },
            }),
        ]);
        const outcome = await runPlanTimeValidators(plan, {
            runtime,
            userId: "u1",
            locale: "en",
            defaultVenue: "binance",
        });
        // est_notional = 0.000001 * 77000 = 0.077 USDT, below 5.
        expect(outcome.ok).toBe(false);
        expect(outcome.failingMessage).toContain("order notional $0.077");
        expect(outcome.failingMessage).toContain("Binance minimum $5.00");
        expect(outcome.failingMessage).toContain("BTCUSDT");
        expect(fetchMid).toHaveBeenCalled();
    });

    it("does NOT refuse a limit order whose base_size * limit_price clears the minimum", async () => {
        const validate: CEXSpecProvider["validateCanonicalIntent"] = vi.fn(() => ({
            ok: true,
        }));
        const risk: CEXSpecProvider["runRiskPrecheck"] = vi.fn(async () => null);
        const fetchFilters: CEXSpecProvider["fetchSymbolFilters"] = vi.fn(
            async (): Promise<CEXSymbolFilters | null> => ({
                status: "TRADING",
                minNotional: "5",
            }),
        );
        const fetchMid: CEXSpecProvider["fetchMarketMidUsd"] = vi.fn(async () => 1);
        const runtime = makeRuntime({
            validateCanonicalIntent: validate,
            runRiskPrecheck: risk,
            fetchSymbolFilters: fetchFilters,
            fetchMarketMidUsd: fetchMid,
        });
        const plan = makePlan([
            makeStep({
                id: "1",
                action: "create_order",
                venue: "binance",
                stake: "write",
                parameters: {
                    product_id: "BTC-USDT",
                    side: "BUY",
                    order_configuration: {
                        limit_limit_gtc: { base_size: "0.001", limit_price: "62000" },
                    },
                },
            }),
        ]);
        const outcome = await runPlanTimeValidators(plan, {
            runtime,
            userId: "u1",
            locale: "en",
            defaultVenue: "binance",
        });
        // est_notional = 0.001 * 62000 = 62 USDT, well above 5.
        expect(outcome.ok).toBe(true);
        // The limit-price path means fetchMarketMidUsd should NOT be hit.
        expect(fetchMid).not.toHaveBeenCalled();
    });
});

describe("runPlanTimeValidators — pure-read plan", () => {
    it("skips the validator chain entirely when no write steps exist", async () => {
        const validate: CEXSpecProvider["validateCanonicalIntent"] = vi.fn(() => ({
            ok: true,
        }));
        const risk: CEXSpecProvider["runRiskPrecheck"] = vi.fn(async () => null);
        const fetchFilters: CEXSpecProvider["fetchSymbolFilters"] = vi.fn(
            async () => null,
        );
        const runtime = makeRuntime({
            validateCanonicalIntent: validate,
            runRiskPrecheck: risk,
            fetchSymbolFilters: fetchFilters,
        });
        const plan = makePlan([
            makeStep({ id: "1", action: "get_orders", stake: "read" }),
            makeStep({ id: "2", action: "get_balance", stake: "read" }),
        ]);
        const outcome = await runPlanTimeValidators(plan, {
            runtime,
            userId: "u1",
            locale: "en",
            defaultVenue: "binance",
        });
        expect(outcome.ok).toBe(true);
        expect(validate).not.toHaveBeenCalled();
        expect(risk).not.toHaveBeenCalled();
        expect(fetchFilters).not.toHaveBeenCalled();
        expect(plan.status).toBe("draft");
    });
});

describe("runPlanTimeValidators — clarify step", () => {
    it("skips the validator chain for a clarify step", async () => {
        const validate: CEXSpecProvider["validateCanonicalIntent"] = vi.fn(() => ({
            ok: true,
        }));
        const runtime = makeRuntime({ validateCanonicalIntent: validate });
        const plan = makePlan([
            makeStep({
                id: "1",
                action: "clarify",
                stake: "read",
                parameters: { question: "What amount?" },
            }),
        ]);
        const outcome = await runPlanTimeValidators(plan, {
            runtime,
            userId: "u1",
            locale: "en",
            defaultVenue: "binance",
        });
        expect(outcome.ok).toBe(true);
        expect(validate).not.toHaveBeenCalled();
    });
});

describe("runPlanTimeValidators — provider missing", () => {
    it("treats a missing CEXSpecProvider as pass-through", async () => {
        const runtime = {
            agentId: "agent-1",
            plugins: [],
            getSetting: () => undefined,
        } as unknown as IAgentRuntime;
        const plan = makePlan([
            makeStep({ id: "1", action: "create_order", stake: "write" }),
        ]);
        const outcome = await runPlanTimeValidators(plan, {
            runtime,
            userId: "u1",
            locale: "en",
            defaultVenue: "binance",
        });
        expect(outcome.ok).toBe(true);
    });
});

describe("runPlanTimeValidators — bails on first failing step", () => {
    it("first step failed → subsequent writes marked skipped", async () => {
        const validate: CEXSpecProvider["validateCanonicalIntent"] = vi
            .fn()
            // step 1 fails schema
            .mockReturnValueOnce({
                ok: false,
                error: "size.base_size: must be a positive decimal",
            });
        const runtime = makeRuntime({ validateCanonicalIntent: validate });
        const plan = makePlan([
            makeStep({
                id: "1",
                action: "create_order",
                stake: "write",
                parameters: {
                    product_id: "BTC-USDT",
                    side: "BUY",
                    order_configuration: {
                        limit_limit_gtc: { base_size: "0", limit_price: "62000" },
                    },
                },
            }),
            makeStep({
                id: "2",
                action: "create_order",
                stake: "write",
                parameters: {
                    product_id: "ETH-USDT",
                    side: "BUY",
                    order_configuration: {
                        limit_limit_gtc: { base_size: "1", limit_price: "2100" },
                    },
                },
            }),
        ]);
        const outcome = await runPlanTimeValidators(plan, {
            runtime,
            userId: "u1",
            locale: "en",
            defaultVenue: "binance",
        });
        expect(outcome.ok).toBe(false);
        expect(plan.steps[0].status).toBe("failed");
        expect(plan.steps[1].status).toBe("skipped");
        expect(plan.status).toBe("failed");
        // Validator must not have advanced to step 2.
        expect(validate).toHaveBeenCalledTimes(1);
    });
});

describe("runPlanTimeValidators — caches fetchSymbolFilters per venue+symbol", () => {
    it("only fetches once across two writes on the same symbol", async () => {
        const validate: CEXSpecProvider["validateCanonicalIntent"] = vi.fn(() => ({
            ok: true,
        }));
        const risk: CEXSpecProvider["runRiskPrecheck"] = vi.fn(async () => null);
        const fetchFilters: CEXSpecProvider["fetchSymbolFilters"] = vi.fn(
            async (): Promise<CEXSymbolFilters | null> => ({
                status: "TRADING",
                minNotional: "5",
            }),
        );
        const runtime = makeRuntime({
            validateCanonicalIntent: validate,
            runRiskPrecheck: risk,
            fetchSymbolFilters: fetchFilters,
        });
        const plan = makePlan([
            makeStep({
                id: "1",
                action: "create_order",
                venue: "binance",
                stake: "write",
                parameters: {
                    product_id: "BTC-USDT",
                    side: "BUY",
                    order_configuration: {
                        limit_limit_gtc: { base_size: "0.001", limit_price: "62000" },
                    },
                },
            }),
            makeStep({
                id: "2",
                action: "create_order",
                venue: "binance",
                stake: "write",
                parameters: {
                    product_id: "BTC-USDT",
                    side: "SELL",
                    order_configuration: {
                        limit_limit_gtc: { base_size: "0.001", limit_price: "70000" },
                    },
                },
            }),
        ]);
        const outcome = await runPlanTimeValidators(plan, {
            runtime,
            userId: "u1",
            locale: "en",
            defaultVenue: "binance",
        });
        expect(outcome.ok).toBe(true);
        expect(fetchFilters).toHaveBeenCalledTimes(1);
    });
});

describe("runPlanTimeValidators — skips non-create write actions for symbol/notional gates", () => {
    it("runs schema + risk for cancel_order but not symbol/min-notional", async () => {
        const validate: CEXSpecProvider["validateCanonicalIntent"] = vi.fn(() => ({
            ok: true,
        }));
        const risk: CEXSpecProvider["runRiskPrecheck"] = vi.fn(async () => null);
        const fetchFilters: CEXSpecProvider["fetchSymbolFilters"] = vi.fn(
            async () => null,
        );
        const runtime = makeRuntime({
            validateCanonicalIntent: validate,
            runRiskPrecheck: risk,
            fetchSymbolFilters: fetchFilters,
        });
        const plan = makePlan([
            makeStep({
                id: "1",
                action: "cancel_order",
                venue: "binance",
                stake: "write",
                parameters: { order_id: "12345" },
            }),
        ]);
        const outcome = await runPlanTimeValidators(plan, {
            runtime,
            userId: "u1",
            locale: "en",
            defaultVenue: "binance",
        });
        expect(outcome.ok).toBe(true);
        expect(validate).toHaveBeenCalled();
        expect(risk).toHaveBeenCalled();
        expect(fetchFilters).not.toHaveBeenCalled();
    });
});
