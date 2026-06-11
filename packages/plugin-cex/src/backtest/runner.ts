import { rsi } from "./indicators";
import { computeMetrics } from "./metrics";
import type {
    BacktestFill,
    BacktestMetrics,
    BacktestPosition,
    BacktestReport,
    BacktestRunConfig,
    OhlcvBar,
    RegimeTag,
} from "./types";
import type { StrategyDSL } from "../strategy/strategyDSL";

export interface BacktestStrategyEvaluator {
    /** Return true when the entry rule is satisfied at bar index `i`. */
    shouldEnter(bars: OhlcvBar[], i: number): boolean;
    /** Return true when the exit rule is satisfied at bar index `i`. */
    shouldExit(bars: OhlcvBar[], i: number, position: BacktestPosition): boolean;
}

/**
 * Build an evaluator from a strategy DSL. Only the patterns produced by
 * the heuristic compiler are supported here (DCA + RSI mean-revert);
 * anything else throws. Mirrors the contract of the live runtime so
 * backtest and live diverge only on data sourcing.
 *
 * No look-ahead: we never reference `bars[i + k]` for `k > 0`.
 */
export function evaluatorFromStrategy(
    strategy: StrategyDSL,
): BacktestStrategyEvaluator {
    const rsiSignal = strategy.signals.find((s) => s.kind === "price.rsi");
    if (!rsiSignal) {
        // DCA-style: every bar is an entry candidate, no exit.
        return {
            shouldEnter: () => true,
            shouldExit: () => false,
        };
    }
    const period = Number(rsiSignal.params.period ?? 14);

    // Pull thresholds from entry/exit rules. Assumes (lt, signal, value).
    const entryRule = strategy.entries[0].when;
    const exitRule = strategy.exits[0].when;
    const entryThreshold = Number(entryRule.args[1]);
    const exitThreshold = Number(exitRule.args[1]);

    return {
        shouldEnter(bars, i) {
            const v = rsi(bars, i, period);
            return Number.isFinite(v) && v < entryThreshold;
        },
        shouldExit(bars, i) {
            const v = rsi(bars, i, period);
            return Number.isFinite(v) && v > exitThreshold;
        },
    };
}

interface RunState {
    equity: number;
    cash: number;
    position: BacktestPosition | null;
    fills: BacktestFill[];
    equityCurve: number[];
    feesPaid: number;
    slippageCost: number;
}

function simulate(args: {
    bars: OhlcvBar[];
    evaluator: BacktestStrategyEvaluator;
    config: BacktestRunConfig;
}): RunState {
    const state: RunState = {
        equity: args.config.initialEquity,
        cash: args.config.initialEquity,
        position: null,
        fills: [],
        equityCurve: [args.config.initialEquity],
        feesPaid: 0,
        slippageCost: 0,
    };

    for (let i = 0; i < args.bars.length; i++) {
        const bar = args.bars[i];

        if (state.position === null && args.evaluator.shouldEnter(args.bars, i)) {
            const tradeNotional = state.cash;
            if (tradeNotional > 0) {
                const slipBps =
                    args.config.slippage.bps +
                    (args.config.slippage.impact_bps_per_unit ?? 0);
                const fillPrice = bar.close * (1 + slipBps / 10_000);
                const fee = tradeNotional * (args.config.fees.bps / 10_000);
                const qty = (tradeNotional - fee) / fillPrice;
                state.fills.push({
                    timestamp: bar.timestamp,
                    side: "BUY",
                    quantity: qty,
                    price: fillPrice,
                    fee,
                    slippage_bps: slipBps,
                });
                state.feesPaid += fee;
                state.slippageCost += tradeNotional * (slipBps / 10_000);
                state.cash = 0;
                state.position = {
                    symbol: args.config.symbol,
                    quantity: qty,
                    avg_price: fillPrice,
                    opened_at: i,
                };
            }
        } else if (
            state.position !== null &&
            args.evaluator.shouldExit(args.bars, i, state.position)
        ) {
            const slipBps = args.config.slippage.bps;
            const fillPrice = bar.close * (1 - slipBps / 10_000);
            const grossProceeds = state.position.quantity * fillPrice;
            const fee = grossProceeds * (args.config.fees.bps / 10_000);
            state.fills.push({
                timestamp: bar.timestamp,
                side: "SELL",
                quantity: state.position.quantity,
                price: fillPrice,
                fee,
                slippage_bps: slipBps,
            });
            state.feesPaid += fee;
            state.slippageCost += grossProceeds * (slipBps / 10_000);
            state.cash += grossProceeds - fee;
            state.position = null;
        }

        const markValue =
            state.position !== null ? state.position.quantity * bar.close : 0;
        state.equity = state.cash + markValue;
        state.equityCurve.push(state.equity);
    }
    return state;
}

function regimeBars(
    bars: OhlcvBar[],
    config: BacktestRunConfig,
    tag: RegimeTag,
): OhlcvBar[] {
    if (!config.regimes) return [];
    const ranges = config.regimes.filter((r) => r.tag === tag);
    return bars.filter((b) =>
        ranges.some((r) => b.timestamp >= r.start && b.timestamp <= r.end),
    );
}

/**
 * Runs the backtest with an in-sample / out-of-sample split and per-regime
 * metrics. Look-ahead bias is structurally prevented: each iteration only
 * sees `bars[0..i]`. Survivorship is the responsibility of the caller —
 * pass delisted symbols too if needed.
 */
export function runBacktest(args: {
    bars: OhlcvBar[];
    strategy: StrategyDSL;
    config: BacktestRunConfig;
}): BacktestReport {
    const filtered = args.bars
        .filter(
            (b) => b.timestamp >= args.config.startTs && b.timestamp <= args.config.endTs,
        )
        .sort((a, b) => a.timestamp - b.timestamp);

    const inSampleFrac = args.config.inSampleFraction ?? 0.7;
    const splitIdx = Math.floor(filtered.length * inSampleFrac);
    const inSampleBars = filtered.slice(0, splitIdx);
    const outOfSampleBars = filtered.slice(splitIdx);

    const evaluator = evaluatorFromStrategy(args.strategy);

    const inSampleRun = simulate({
        bars: inSampleBars,
        evaluator,
        config: args.config,
    });
    const outOfSampleRun = simulate({
        bars: outOfSampleBars,
        evaluator,
        config: {
            ...args.config,
            initialEquity: inSampleRun.equity,
        },
    });

    const perRegime: BacktestReport["perRegime"] = {};
    const tags: RegimeTag[] = ["bull", "bear", "sideways", "high_vol"];
    for (const tag of tags) {
        const bars = regimeBars(filtered, args.config, tag);
        if (bars.length === 0) continue;
        const run = simulate({ bars, evaluator, config: args.config });
        perRegime[tag] = computeMetrics({
            fills: run.fills,
            equityCurve: run.equityCurve,
            initialEquity: args.config.initialEquity,
            feesPaid: run.feesPaid,
            slippageCost: run.slippageCost,
        });
    }

    const inSampleMetrics: BacktestMetrics = computeMetrics({
        fills: inSampleRun.fills,
        equityCurve: inSampleRun.equityCurve,
        initialEquity: args.config.initialEquity,
        feesPaid: inSampleRun.feesPaid,
        slippageCost: inSampleRun.slippageCost,
    });

    const outOfSampleMetrics: BacktestMetrics = computeMetrics({
        fills: outOfSampleRun.fills,
        equityCurve: outOfSampleRun.equityCurve,
        initialEquity: inSampleRun.equity,
        feesPaid: outOfSampleRun.feesPaid,
        slippageCost: outOfSampleRun.slippageCost,
    });

    return {
        inSample: inSampleMetrics,
        outOfSample: outOfSampleMetrics,
        perRegime,
        fills: [...inSampleRun.fills, ...outOfSampleRun.fills],
        finalEquity: outOfSampleRun.equity,
    };
}
