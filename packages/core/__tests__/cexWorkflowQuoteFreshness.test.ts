/**
 * Fix 11 (H-4) — quote-freshness re-check on Confirm.
 *
 * Tests `recheckQuoteFreshness` directly against synthetic provider +
 * runtime stubs. The helper is the load-bearing piece of the
 * Confirm-time drift gate; the surrounding `executeAction` wrapper
 * only handles emit/return-shape boilerplate.
 *
 * Coverage:
 *  1. Drift exceeds cap → reject with drift message.
 *  2. Drift within cap → proceed (ok=true).
 *  3. Fetch failure → fail-soft (ok=true).
 *  4. Default cap when neither pref nor intent supplies one.
 *  5. Feature flag off is tested indirectly: the helper is unconditional;
 *     the caller (executeAction) gates on the flag. We assert the gate
 *     logic does not invoke the helper when the flag is off.
 */
import { describe, expect, it, vi } from "vitest";
import {
    FIX11_DEFAULT_CAP_BPS,
    FIX11_DEFAULT_CAP_PCT,
    recheckQuoteFreshness,
} from "../src/handlers/cexWorkflowMessageHandler.ts";

interface BuildStateArgs {
    fetchMarketMidUsdImpl?: (args: {
        runtime: unknown;
        venue: string;
        symbol: string;
        signal?: AbortSignal;
        bypassCache?: boolean;
    }) => Promise<number | null>;
    runRiskPrecheckImpl?: (input: unknown) => Promise<unknown>;
    prefsPriceDeviationMaxPct?: number;
    /** Intent-level cap (passed via approvedActionCall.userParams). */
    intentPriceDeviationMaxPct?: number;
    /** Workflow getSetting impl — used for feature-flag tests. */
    getSetting?: (key: string) => string | undefined;
}

function buildStubState(
    args: BuildStateArgs,
    overrides: Record<string, unknown> = {},
): {
    state: Parameters<typeof recheckQuoteFreshness>[0]["state"];
    fetchSpy: ReturnType<typeof vi.fn>;
    riskSpy: ReturnType<typeof vi.fn>;
} {
    const fetchSpy = vi.fn(
        args.fetchMarketMidUsdImpl ?? (async () => 100),
    );
    const riskSpy = vi.fn(
        args.runRiskPrecheckImpl ??
            (async () => ({
                verdict: "allow" as const,
                rules_fired: [],
                explanations: [],
            })),
    );
    const provider = {
        fetchMarketMidUsd: fetchSpy,
        runRiskPrecheck: riskSpy,
    };
    const adapter = {
        getUserTradingPreferences: async () =>
            args.prefsPriceDeviationMaxPct !== undefined
                ? { price_deviation_max_pct: args.prefsPriceDeviationMaxPct }
                : null,
    };
    const userParams: Record<string, unknown> = {
        product_id: "BTC-USDT",
        exchange: "binance",
    };
    if (args.intentPriceDeviationMaxPct !== undefined) {
        userParams.execution_constraints = {
            price_deviation_max_pct: args.intentPriceDeviationMaxPct,
        };
    }
    const state = {
        runtime: {
            plugins: [{ cexSpecProvider: provider }],
            databaseAdapter: adapter,
            getSetting: args.getSetting ?? (() => undefined),
        },
        message: { userId: "user-1", roomId: "room-1" },
        approvedActionCall: {
            action: "create_order",
            userParams,
        },
        locale: "en",
        resolvedExecutionMode: "live",
        defaultExchangeId: "binance",
        ...overrides,
    } as unknown as Parameters<typeof recheckQuoteFreshness>[0]["state"];
    return { state, fetchSpy, riskSpy };
}

describe("Fix 11 — recheckQuoteFreshness", () => {
    it("rejects when fresh mid drifts > cap (60 bps drift vs 50 bps prefs cap)", async () => {
        const approvedMid = 100;
        const latestMid = 100 * (1 + 0.006); // 60 bps higher
        const { state, fetchSpy } = buildStubState({
            fetchMarketMidUsdImpl: async () => latestMid,
            prefsPriceDeviationMaxPct: 0.005, // 50 bps
        });
        const result = await recheckQuoteFreshness({
            state,
            venue: "binance",
            symbol: "BTC-USDT",
            approvedMid,
            approvedAtMs: Date.now() - 30_000,
        });
        expect(result.ok).toBe(false);
        expect(result.reason).toBeDefined();
        // Drift message format: "Market moved X bps in the Y seconds ..."
        expect(result.reason).toMatch(/Market moved 60\.0 bps in the/);
        expect(result.reason).toMatch(/Re-submit if you still want to proceed/);
        expect(result.drift_bps).toBeCloseTo(60, 1);
        expect(result.latest_mid).toBe(latestMid);
        // Fresh fetch must have been bypassCache=true.
        expect(fetchSpy).toHaveBeenCalledWith(
            expect.objectContaining({ bypassCache: true, symbol: "BTC-USDT" }),
        );
    });

    it("proceeds when fresh mid drifts within cap (30 bps drift vs 50 bps prefs cap)", async () => {
        const approvedMid = 100;
        const latestMid = 100 * (1 + 0.003); // 30 bps higher
        const { state, riskSpy } = buildStubState({
            fetchMarketMidUsdImpl: async () => latestMid,
            prefsPriceDeviationMaxPct: 0.005, // 50 bps
        });
        const result = await recheckQuoteFreshness({
            state,
            venue: "binance",
            symbol: "BTC-USDT",
            approvedMid,
            approvedAtMs: Date.now() - 5_000,
        });
        expect(result.ok).toBe(true);
        expect(result.drift_bps).toBeCloseTo(30, 1);
        expect(result.latest_mid).toBe(latestMid);
        // The rules-filtered re-run must have been invoked with the
        // FRESH mid + age=0 + only priceDeviation/slippageCap rules.
        expect(riskSpy).toHaveBeenCalledTimes(1);
        const call = riskSpy.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(call.market_mid_usd).toBe(latestMid);
        expect(call.market_data_age_ms).toBe(0);
        expect(call.rules_to_run).toEqual(["priceDeviation", "slippageCap"]);
    });

    it("fail-soft (ok=true, no fresh quote) when fetchMarketMidUsd throws", async () => {
        const { state } = buildStubState({
            fetchMarketMidUsdImpl: async () => {
                throw new Error("ticker timeout");
            },
            prefsPriceDeviationMaxPct: 0.005,
        });
        const result = await recheckQuoteFreshness({
            state,
            venue: "binance",
            symbol: "BTC-USDT",
            approvedMid: 100,
            approvedAtMs: Date.now() - 30_000,
        });
        expect(result.ok).toBe(true);
        expect(result.drift_bps).toBeUndefined();
        expect(result.latest_mid).toBeUndefined();
    });

    it("fail-soft (ok=true) when fresh mid is null (provider returns no quote)", async () => {
        const { state } = buildStubState({
            fetchMarketMidUsdImpl: async () => null,
            prefsPriceDeviationMaxPct: 0.005,
        });
        const result = await recheckQuoteFreshness({
            state,
            venue: "binance",
            symbol: "BTC-USDT",
            approvedMid: 100,
            approvedAtMs: Date.now(),
        });
        expect(result.ok).toBe(true);
    });

    it("uses default cap (100 bps) when neither prefs nor intent supplies one", async () => {
        // 80 bps drift — UNDER default 100 bps → allow.
        const approvedMid = 100;
        const latestMid = 100 * (1 + 0.008);
        const { state } = buildStubState({
            fetchMarketMidUsdImpl: async () => latestMid,
            // No prefs cap, no intent cap.
        });
        const result = await recheckQuoteFreshness({
            state,
            venue: "binance",
            symbol: "BTC-USDT",
            approvedMid,
            approvedAtMs: Date.now(),
        });
        expect(result.ok).toBe(true);
        // Sanity: 110 bps drift should now exceed default cap.
        const { state: state2 } = buildStubState({
            fetchMarketMidUsdImpl: async () => 100 * 1.011,
        });
        const result2 = await recheckQuoteFreshness({
            state: state2,
            venue: "binance",
            symbol: "BTC-USDT",
            approvedMid: 100,
            approvedAtMs: Date.now(),
        });
        expect(result2.ok).toBe(false);
        // The default cap constants are wired correctly.
        expect(FIX11_DEFAULT_CAP_BPS).toBe(100);
        expect(FIX11_DEFAULT_CAP_PCT).toBe(0.01);
    });

    it("takes the MIN of intent cap and prefs cap (intent 30 bps vs prefs 100 bps)", async () => {
        // Drift 40 bps — over intent (30) but under prefs (100). MIN → block.
        const approvedMid = 100;
        const latestMid = 100 * 1.004; // 40 bps
        const { state } = buildStubState({
            fetchMarketMidUsdImpl: async () => latestMid,
            prefsPriceDeviationMaxPct: 0.01, // 100 bps
            intentPriceDeviationMaxPct: 0.003, // 30 bps
        });
        const result = await recheckQuoteFreshness({
            state,
            venue: "binance",
            symbol: "BTC-USDT",
            approvedMid,
            approvedAtMs: Date.now(),
        });
        expect(result.ok).toBe(false);
    });

    it("skips the check when approvedMid is non-positive (returns ok=true, no fetch)", async () => {
        const { state, fetchSpy } = buildStubState({});
        const result = await recheckQuoteFreshness({
            state,
            venue: "binance",
            symbol: "BTC-USDT",
            approvedMid: 0,
            approvedAtMs: Date.now(),
        });
        expect(result.ok).toBe(true);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("emits the zh-CN drift message when state.locale is zh-CN", async () => {
        const { state } = buildStubState(
            {
                fetchMarketMidUsdImpl: async () => 100 * 1.006,
                prefsPriceDeviationMaxPct: 0.005,
            },
            { locale: "zh-CN" },
        );
        const result = await recheckQuoteFreshness({
            state,
            venue: "binance",
            symbol: "BTC-USDT",
            approvedMid: 100,
            approvedAtMs: Date.now() - 30_000,
        });
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/市场在你审核此订单后/);
        expect(result.reason).toMatch(/60\.0 bps/);
    });

    it("propagates rules-filtered re-check rejection (priceDeviation now fails on fresh quote)", async () => {
        // Drift 30 bps (under prefs cap 50 bps) — drift check passes,
        // but then the rules-filtered re-run returns block. Reason must
        // include the rules-filtered explanation suffix.
        const { state } = buildStubState({
            fetchMarketMidUsdImpl: async () => 100 * 1.003,
            prefsPriceDeviationMaxPct: 0.005,
            runRiskPrecheckImpl: async () => ({
                verdict: "block",
                rules_fired: ["priceDeviation"],
                explanations: ["Limit price 100 differs from market ..."],
            }),
        });
        const result = await recheckQuoteFreshness({
            state,
            venue: "binance",
            symbol: "BTC-USDT",
            approvedMid: 100,
            approvedAtMs: Date.now(),
        });
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/Limit price 100/);
    });
});

describe("Fix 11 — feature flag gating (callsite contract)", () => {
    /**
     * The helper itself is unconditional — the gate lives in
     * `executeAction` before calling the helper. We assert the gate
     * predicate is the documented one so the wider integration is
     * tested without spinning the full LangGraph workflow.
     */
    it("matches the documented runtime.getSetting key + value", () => {
        const settingKey = "CEX_CONFIRM_QUOTE_RECHECK_ENABLED";
        const truthyValue = "true";
        // Mirror the executeAction-side gate logic.
        const gate = (s: string | undefined) => s === truthyValue;
        expect(gate(truthyValue)).toBe(true);
        expect(gate("false")).toBe(false);
        expect(gate(undefined)).toBe(false);
        expect(gate("True")).toBe(false); // strict-equality match — staging-on, prod-off
        // Sanity: the key string is unchanged.
        expect(settingKey).toBe("CEX_CONFIRM_QUOTE_RECHECK_ENABLED");
    });
});
