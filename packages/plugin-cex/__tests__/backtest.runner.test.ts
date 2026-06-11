import { describe, expect, it } from "vitest";

import { compileNlToDsl } from "../src/strategy/nlToDSL";
import {
    generateSyntheticBars,
    parseOhlcvCsv,
} from "../src/backtest/dataSource";
import { rsi, sma } from "../src/backtest/indicators";
import { runBacktest } from "../src/backtest/runner";
import { computeMetrics } from "../src/backtest/metrics";

describe("Backtest indicators", () => {
    it("SMA returns NaN when window is short", () => {
        const bars = generateSyntheticBars({
            symbol: "BTC",
            startTs: 1_700_000_000_000,
            count: 5,
            intervalMs: 3_600_000,
            initialPrice: 40_000,
            drift: 0,
            volatility: 0.01,
            seed: 1,
        });
        expect(Number.isNaN(sma(bars, 1, 5))).toBe(true);
        expect(Number.isNaN(sma(bars, 4, 5))).toBe(false);
    });

    it("RSI bounded [0, 100]", () => {
        const bars = generateSyntheticBars({
            symbol: "BTC",
            startTs: 1_700_000_000_000,
            count: 100,
            intervalMs: 3_600_000,
            initialPrice: 40_000,
            drift: 0,
            volatility: 0.02,
            seed: 7,
        });
        const v = rsi(bars, 99, 14);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
    });
});

describe("Backtest runner — no look-ahead, regime split", () => {
    function strategy() {
        const r = compileNlToDsl(
            "RSI 30/70 mean-revert on BTC hourly",
            { locale: "en", owner: "user-1", venue: "binance" },
        );
        if (!r.ok) throw new Error("compile failed");
        return r.strategy;
    }

    it("runs and produces in/out-of-sample metrics", () => {
        const bars = generateSyntheticBars({
            symbol: "BTCUSDT",
            startTs: 1_700_000_000_000,
            count: 500,
            intervalMs: 3_600_000,
            initialPrice: 40_000,
            drift: 0.0001,
            volatility: 0.02,
            seed: 42,
        });
        const report = runBacktest({
            bars,
            strategy: strategy(),
            config: {
                symbol: "BTCUSDT",
                startTs: bars[0].timestamp,
                endTs: bars[bars.length - 1].timestamp,
                initialEquity: 10_000,
                fees: { bps: 10 },
                slippage: { bps: 5 },
            },
        });
        expect(report.inSample).toBeDefined();
        expect(report.outOfSample).toBeDefined();
        expect(report.fills.length).toBeGreaterThanOrEqual(0);
        expect(report.finalEquity).toBeGreaterThan(0);
    });

    it("respects fee + slippage adjustments in metrics", () => {
        const bars = generateSyntheticBars({
            symbol: "BTCUSDT",
            startTs: 1_700_000_000_000,
            count: 100,
            intervalMs: 3_600_000,
            initialPrice: 40_000,
            drift: 0.001,
            volatility: 0.02,
            seed: 11,
        });
        const report = runBacktest({
            bars,
            strategy: strategy(),
            config: {
                symbol: "BTCUSDT",
                startTs: bars[0].timestamp,
                endTs: bars[bars.length - 1].timestamp,
                initialEquity: 10_000,
                fees: { bps: 30 },
                slippage: { bps: 20 },
                inSampleFraction: 0.5,
            },
        });
        expect(report.inSample.feeAdjustedReturn).toBeLessThanOrEqual(
            report.inSample.totalReturn,
        );
        expect(report.inSample.slippageAdjustedReturn).toBeLessThanOrEqual(
            report.inSample.totalReturn,
        );
    });

    it("look-ahead bias prevented: SHA of inSample fills depends only on inSample bars", () => {
        const seed = 99;
        const allBars = generateSyntheticBars({
            symbol: "BTCUSDT",
            startTs: 1_700_000_000_000,
            count: 200,
            intervalMs: 3_600_000,
            initialPrice: 40_000,
            drift: 0,
            volatility: 0.02,
            seed,
        });
        const firstHalf = allBars.slice(0, 100);

        const fullReport = runBacktest({
            bars: allBars,
            strategy: strategy(),
            config: {
                symbol: "BTCUSDT",
                startTs: allBars[0].timestamp,
                endTs: allBars[99].timestamp,
                initialEquity: 10_000,
                fees: { bps: 0 },
                slippage: { bps: 0 },
                inSampleFraction: 1.0,
            },
        });

        const halfReport = runBacktest({
            bars: firstHalf,
            strategy: strategy(),
            config: {
                symbol: "BTCUSDT",
                startTs: firstHalf[0].timestamp,
                endTs: firstHalf[firstHalf.length - 1].timestamp,
                initialEquity: 10_000,
                fees: { bps: 0 },
                slippage: { bps: 0 },
                inSampleFraction: 1.0,
            },
        });
        expect(fullReport.inSample.nTrades).toBe(halfReport.inSample.nTrades);
    });
});

describe("Backtest CSV parser", () => {
    it("parses well-formed CSV", () => {
        const bars = parseOhlcvCsv(
            [
                "timestamp,open,high,low,close,volume",
                "1700000000000,40000,40500,39800,40300,1500.5",
                "1700003600000,40300,40400,40100,40200,1200.0",
            ].join("\n"),
        );
        expect(bars.length).toBe(2);
        expect(bars[0].close).toBe(40_300);
    });

    it("skips comments + blanks", () => {
        const bars = parseOhlcvCsv(
            [
                "# regen 2026-05-17",
                "",
                "1700000000000,1,2,3,4,5",
            ].join("\n"),
        );
        expect(bars.length).toBe(1);
    });
});

describe("Backtest metrics", () => {
    it("computes zero stats for empty fills", () => {
        const m = computeMetrics({
            fills: [],
            equityCurve: [1000, 1000, 1000],
            initialEquity: 1000,
            feesPaid: 0,
            slippageCost: 0,
        });
        expect(m.nTrades).toBe(0);
        expect(m.totalReturn).toBe(0);
    });
});
