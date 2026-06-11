import {
    type Action,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
    elizaLogger,
} from "@elizaos/core";

import { compileNlToDsl } from "../strategy/nlToDSL";
import { parseStrategyDSL, type StrategyDSL } from "../strategy/strategyDSL";
import { runBacktest } from "../backtest/runner";
import { generateSyntheticBars } from "../backtest/dataSource";
import { fetchOhlcvBarsSafe } from "../backtest/realDataSource";

export function coerceStrategy(opts: Record<string, unknown>, userText: string, memoryUserId: string):
    | { ok: true; strategy: StrategyDSL; derivedByHeuristic: boolean }
    | { ok: false; reason: string } {
    if (opts.strategy && typeof opts.strategy === "object") {
        try {
            return { ok: true, strategy: parseStrategyDSL(opts.strategy), derivedByHeuristic: false };
        } catch (err) {
            return { ok: false, reason: `Invalid strategy DSL: ${err instanceof Error ? err.message : String(err)}` };
        }
    }
    const venue =
        opts.venue === "coinbase" || opts.venue === "paper"
            ? (opts.venue as "coinbase" | "paper")
            : "binance";
    const locale = (opts.locale === "zh-CN" ? "zh-CN" : "en") as "en" | "zh-CN";
    const owner = memoryUserId || "anonymous";
    // Prefer the explicit `description` parameter (the plan decomposer's NL strategy description)
    // over the raw message text: in the plan-executor path the synthetic memory carries the user's
    // CURRENT message (e.g. the "yes, approve all" continuation), which describes no strategy at
    // all — compiling that always fails with "couldn't classify".
    const nlSource =
        typeof opts.description === "string" && opts.description.trim().length > 0
            ? opts.description
            : userText;
    const compiled = compileNlToDsl(nlSource, { locale, owner, venue });
    if (compiled.ok) return { ok: true, strategy: compiled.strategy, derivedByHeuristic: compiled.derived_by_heuristic === true };
    return { ok: false, reason: compiled.text };
}

export const runBacktestAction: Action = {
    name: "run_backtest",
    description:
        "**STRATEGY BACKTEST (autotrading)** — Use this action whenever the user wants to BACKTEST, evaluate, simulate, or stress-test a trading strategy against historical OHLCV bars. Trigger keywords: 'backtest', 'backtesting', 'run backtest', 'historical performance', 'evaluate strategy', 'how would my strategy have done'. Accepts either a compiled DSL object (from `compile_strategy`) OR an NL strategy description (which it compiles inline). Returns total return, Sharpe, Sortino, max drawdown, win rate, profit factor, fee+slippage-adjusted return, in-sample vs out-of-sample. **DO NOT pick TECHNICAL_ANALYSIS for backtests — that action is for present-state TA, this one is for historical strategy evaluation.**",
    examples: [
        [
            { user: "{{user1}}", content: { text: "backtest DCA $50 BTC weekly over 500 hourly bars" } },
            { user: "{{user2}}", content: { text: "Running backtest", action: "run_backtest" } },
        ],
        [
            { user: "{{user1}}", content: { text: "backtest the RSI 30/70 strategy" } },
            { user: "{{user2}}", content: { text: "Running RSI backtest", action: "run_backtest" } },
        ],
        [
            { user: "{{user1}}", content: { text: "how would an RSI mean-revert strategy have performed on BTC last year" } },
            { user: "{{user2}}", content: { text: "Running historical backtest", action: "run_backtest" } },
        ],
        [
            { user: "{{user1}}", content: { text: "run a backtest" } },
            { user: "{{user2}}", content: { text: "Running backtest", action: "run_backtest" } },
        ],
    ],
    handler: async (
        runtime: IAgentRuntime,
        memory: Memory,
        _state: State | undefined,
        options: Record<string, unknown> | undefined,
        callback?: HandlerCallback,
    ): Promise<unknown> => {
        const opts = (options ?? {}) as Record<string, unknown>;
        const userText = memory.content?.text ?? "";
        const coerced = coerceStrategy(opts, userText, memory.userId ? String(memory.userId) : "");
        if (!coerced.ok) {
            if (callback) {
                await callback({
                    text: `Backtest aborted: ${coerced.reason}`,
                    action: "run_backtest",
                    metadata: { success: false },
                });
            }
            return { success: false, reason: coerced.reason };
        }
        const strategy = coerced.strategy;
        elizaLogger.info(`[plugin-cex] run_backtest invoked: strategy=${strategy.identity.id}`);

        const barCount =
            typeof opts.bar_count === "number" && opts.bar_count > 0
                ? Math.min(2000, Math.floor(opts.bar_count))
                : 500;
        const intervalMs =
            typeof opts.interval_ms === "number" && opts.interval_ms > 0
                ? Math.floor(opts.interval_ms)
                : 3_600_000;
        const initialEquity =
            typeof opts.initial_equity === "number" && opts.initial_equity > 0
                ? opts.initial_equity
                : 10_000;
        const seed = typeof opts.seed === "number" ? opts.seed : 42;

        // Prefer real OHLCV from the venue's public klines/candles
        // endpoint (no auth required). Falls back to synthetic bars on
        // network/API errors so the action never crashes.
        const venueForData = strategy.universe.venue === "paper" ? "binance" : strategy.universe.venue;
        let bars = await fetchOhlcvBarsSafe({
            venue: venueForData as "binance" | "coinbase",
            symbol: strategy.universe.symbols[0],
            intervalMs,
            count: barCount,
        });
        let dataSource: "real" | "synthetic" = "real";
        if (!bars || bars.length < 50) {
            elizaLogger.warn(
                `[plugin-cex] run_backtest falling back to synthetic bars for ${strategy.universe.symbols[0]} (real fetch returned ${bars?.length ?? 0} bars)`,
            );
            bars = generateSyntheticBars({
                symbol: strategy.universe.symbols[0],
                startTs: Date.now() - barCount * intervalMs,
                count: barCount,
                intervalMs,
                initialPrice: 40_000,
                drift: 0.0002,
                volatility: 0.015,
                seed,
            });
            dataSource = "synthetic";
        }

        const report = runBacktest({
            bars,
            strategy,
            config: {
                symbol: strategy.universe.symbols[0],
                startTs: bars[0].timestamp,
                endTs: bars[bars.length - 1].timestamp,
                initialEquity,
                fees: { bps: 10 },
                slippage: { bps: 5 },
                inSampleFraction: 0.7,
            },
        });

        const fmtPct = (v: number) => `${(v * 100).toFixed(2)}%`;
        const fmtNum = (v: number) => v.toFixed(3);
        // Heuristic compiles map an NL description onto the nearest canonical TEMPLATE (e.g. a
        // time-based DCA for a staged price-drop ladder). Presenting that template's results
        // without saying so silently substitutes a different strategy than the user described —
        // the disclosure below keeps the validation honest. The user's actual orders are NEVER
        // altered by a backtest.
        const heuristicNote = coerced.derivedByHeuristic
            ? [
                  `> ⚠️ **Backtest approximation:** this models a simplified **${strategy.identity.name ?? strategy.identity.id}** template derived from your description — custom conditions (e.g. price-drop triggered buys) are not directly simulated. It is a rough validation proxy ONLY; your actual orders are unchanged and execute exactly as you approved.`,
                  "",
              ]
            : [];
        const responseText = [
            `**Backtest report — ${strategy.identity.name ?? strategy.identity.id}**`,
            "",
            ...heuristicNote,
            `_Inputs:_ ${barCount} bars (${dataSource} OHLCV from ${venueForData}), interval ${intervalMs}ms, initial equity $${initialEquity.toLocaleString()}, fees 10 bps, slippage 5 bps.${dataSource === "synthetic" ? ` Seed=${seed}.` : ""}_`,
            "",
            "| Metric | In-sample | Out-of-sample |",
            "| --- | --- | --- |",
            `| Total return | ${fmtPct(report.inSample.totalReturn)} | ${fmtPct(report.outOfSample.totalReturn)} |`,
            `| Sharpe | ${fmtNum(report.inSample.sharpe)} | ${fmtNum(report.outOfSample.sharpe)} |`,
            `| Sortino | ${fmtNum(report.inSample.sortino)} | ${fmtNum(report.outOfSample.sortino)} |`,
            `| Max drawdown | ${fmtPct(report.inSample.maxDrawdown)} | ${fmtPct(report.outOfSample.maxDrawdown)} |`,
            `| Win rate | ${fmtPct(report.inSample.winRate)} | ${fmtPct(report.outOfSample.winRate)} |`,
            `| Profit factor | ${fmtNum(report.inSample.profitFactor)} | ${fmtNum(report.outOfSample.profitFactor)} |`,
            `| Fee-adj return | ${fmtPct(report.inSample.feeAdjustedReturn)} | ${fmtPct(report.outOfSample.feeAdjustedReturn)} |`,
            `| Slip-adj return | ${fmtPct(report.inSample.slippageAdjustedReturn)} | ${fmtPct(report.outOfSample.slippageAdjustedReturn)} |`,
            `| Trades | ${report.inSample.nTrades} | ${report.outOfSample.nTrades} |`,
            "",
            `**Final equity:** $${report.finalEquity.toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
            "",
            ...(report.inSample.nTrades === 0 && report.outOfSample.nTrades === 0
                ? [
                      "> ⚠️ **0 trades triggered in the test window** — the strategy (or its proxy template) never fired, so the metrics above carry no validation signal. Judge the plan on its rules and risk limits, not these numbers.",
                      "",
                  ]
                : []),
            dataSource === "real"
                ? `_Data: real OHLCV from ${venueForData}'s public klines/candles endpoint._`
                : "_Data: synthetic bars (real fetch failed). Strategy structurally sound but metrics are not on historical market data._",
        ].join("\n");

        if (callback) {
            await callback({
                text: responseText,
                action: "run_backtest",
                metadata: {
                    success: true,
                    strategy_id: strategy.identity.id,
                    report,
                },
            });
        }
        return { success: true, report };
    },
};
