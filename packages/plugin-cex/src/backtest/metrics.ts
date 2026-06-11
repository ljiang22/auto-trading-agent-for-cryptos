import type { BacktestFill, BacktestMetrics } from "./types";

function returnsFromEquity(equityCurve: number[]): number[] {
    const out: number[] = [];
    for (let i = 1; i < equityCurve.length; i++) {
        const prev = equityCurve[i - 1];
        if (prev <= 0) continue;
        out.push((equityCurve[i] - prev) / prev);
    }
    return out;
}

function stddev(values: number[]): number {
    if (values.length < 2) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const v =
        values.reduce((a, b) => a + (b - mean) * (b - mean), 0) /
        (values.length - 1);
    return Math.sqrt(v);
}

function downsideStddev(values: number[]): number {
    const negs = values.filter((v) => v < 0);
    return stddev(negs);
}

export interface ComputeMetricsArgs {
    fills: BacktestFill[];
    equityCurve: number[];
    initialEquity: number;
    feesPaid: number;
    slippageCost: number;
    annualizationFactor?: number;
}

export function computeMetrics(args: ComputeMetricsArgs): BacktestMetrics {
    const final = args.equityCurve[args.equityCurve.length - 1] ?? args.initialEquity;
    const totalReturn = (final - args.initialEquity) / args.initialEquity;
    const rets = returnsFromEquity(args.equityCurve);
    const factor = args.annualizationFactor ?? Math.sqrt(365);
    const sd = stddev(rets);
    const sharpe = sd === 0 ? 0 : ((rets.reduce((a, b) => a + b, 0) / rets.length) * factor) / sd;
    const ds = downsideStddev(rets);
    const sortino =
        ds === 0 ? 0 : ((rets.reduce((a, b) => a + b, 0) / rets.length) * factor) / ds;

    let peak = args.initialEquity;
    let maxDd = 0;
    for (const v of args.equityCurve) {
        if (v > peak) peak = v;
        const dd = peak > 0 ? (peak - v) / peak : 0;
        if (dd > maxDd) maxDd = dd;
    }

    const winFills = args.fills.filter((f) => f.side === "SELL");
    let wins = 0;
    let losses = 0;
    let profit = 0;
    let loss = 0;
    for (let i = 0; i < winFills.length; i++) {
        const ret = i === 0 ? 0 : winFills[i].price - winFills[i - 1].price;
        if (ret > 0) {
            wins += 1;
            profit += ret;
        } else if (ret < 0) {
            losses += 1;
            loss += -ret;
        }
    }
    const winRate = wins + losses === 0 ? 0 : wins / (wins + losses);
    const profitFactor = loss === 0 ? (profit > 0 ? Number.POSITIVE_INFINITY : 0) : profit / loss;

    const feeAdjustedReturn =
        args.initialEquity > 0
            ? totalReturn - args.feesPaid / args.initialEquity
            : 0;
    const slippageAdjustedReturn =
        args.initialEquity > 0
            ? totalReturn - args.slippageCost / args.initialEquity
            : 0;

    const turnover = args.fills.reduce((a, f) => a + f.price * f.quantity, 0);

    return {
        totalReturn,
        sharpe,
        sortino,
        maxDrawdown: maxDd,
        winRate,
        profitFactor: Number.isFinite(profitFactor) ? profitFactor : 0,
        feeAdjustedReturn,
        slippageAdjustedReturn,
        turnover,
        nTrades: args.fills.length,
    };
}
