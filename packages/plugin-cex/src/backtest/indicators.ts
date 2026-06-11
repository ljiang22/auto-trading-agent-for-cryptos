import type { OhlcvBar } from "./types";

/**
 * SMA of the close series at index `i` (inclusive), over `period` bars.
 * Returns NaN until `period - 1` bars have elapsed.
 */
export function sma(bars: OhlcvBar[], i: number, period: number): number {
    if (i + 1 < period) return Number.NaN;
    let s = 0;
    for (let k = i - period + 1; k <= i; k++) s += bars[k].close;
    return s / period;
}

/**
 * EMA of close at index `i`. Computes the full prefix recursively (cached
 * in `cache` for incremental updates).
 */
export function ema(
    bars: OhlcvBar[],
    i: number,
    period: number,
    cache?: Map<number, number>,
): number {
    if (i < 0) return Number.NaN;
    if (cache && cache.has(i)) return cache.get(i) as number;
    const alpha = 2 / (period + 1);
    if (i === 0) {
        const v = bars[0].close;
        cache?.set(0, v);
        return v;
    }
    const prev = ema(bars, i - 1, period, cache);
    const v = alpha * bars[i].close + (1 - alpha) * prev;
    cache?.set(i, v);
    return v;
}

/**
 * Wilder RSI, period default 14. Returns NaN until `period` bars.
 *
 * Implementation note: streams over the full bars[0..i] each call —
 * acceptable for the backtest scale (10k bars). For production reuse,
 * consider an incremental gain/loss tracker.
 */
export function rsi(bars: OhlcvBar[], i: number, period = 14): number {
    if (i < period) return Number.NaN;
    let avgGain = 0;
    let avgLoss = 0;
    for (let k = 1; k <= period; k++) {
        const change = bars[k].close - bars[k - 1].close;
        if (change > 0) avgGain += change;
        else avgLoss += -change;
    }
    avgGain /= period;
    avgLoss /= period;
    for (let k = period + 1; k <= i; k++) {
        const change = bars[k].close - bars[k - 1].close;
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
}

/** ATR (Wilder, period default 14). */
export function atr(bars: OhlcvBar[], i: number, period = 14): number {
    if (i < period) return Number.NaN;
    const trs: number[] = [];
    for (let k = 1; k <= i; k++) {
        const prevClose = bars[k - 1].close;
        const tr = Math.max(
            bars[k].high - bars[k].low,
            Math.abs(bars[k].high - prevClose),
            Math.abs(bars[k].low - prevClose),
        );
        trs.push(tr);
    }
    let avg = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let k = period; k < trs.length; k++) {
        avg = (avg * (period - 1) + trs[k]) / period;
    }
    return avg;
}
