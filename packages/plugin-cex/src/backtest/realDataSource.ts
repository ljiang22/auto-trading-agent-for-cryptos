import type { OhlcvBar, OhlcvDataSource } from "./types";

/**
 * Real-data OHLCV source backed by the venue's public klines/candles
 * endpoint. No authentication is required — both Binance and Coinbase
 * expose public historical-bar APIs.
 *
 * Phase 5.1 wiring: previously the run_backtest action fell back to
 * synthetic bars; this lets it evaluate against real historical
 * market data without depending on the user's exchange auth.
 */

const BINANCE_INTERVAL_MAP: Record<number, string> = {
    60000: "1m",
    180000: "3m",
    300000: "5m",
    900000: "15m",
    1800000: "30m",
    3600000: "1h",
    7200000: "2h",
    14400000: "4h",
    21600000: "6h",
    28800000: "8h",
    43200000: "12h",
    86400000: "1d",
    259200000: "3d",
    604800000: "1w",
    2592000000: "1M",
};

const COINBASE_GRANULARITY_MAP: Record<number, number> = {
    60000: 60,
    300000: 300,
    900000: 900,
    3600000: 3_600,
    21600000: 21_600,
    86400000: 86_400,
};

function nearestBinanceInterval(intervalMs: number): string {
    const exact = BINANCE_INTERVAL_MAP[intervalMs];
    if (exact) return exact;
    const intervals = Object.entries(BINANCE_INTERVAL_MAP);
    intervals.sort((a, b) => Math.abs(Number(a[0]) - intervalMs) - Math.abs(Number(b[0]) - intervalMs));
    return intervals[0][1];
}

function nearestCoinbaseGranularity(intervalMs: number): number {
    const exact = COINBASE_GRANULARITY_MAP[intervalMs];
    if (exact) return exact;
    const intervals = Object.entries(COINBASE_GRANULARITY_MAP);
    intervals.sort((a, b) => Math.abs(Number(a[0]) - intervalMs) - Math.abs(Number(b[0]) - intervalMs));
    return Number(intervals[0][1]);
}

function symbolForBinance(symbol: string): string {
    return symbol.replace(/[-_/]/g, "").toUpperCase();
}

function productIdForCoinbase(symbol: string): string {
    if (symbol.includes("-")) return symbol;
    const m = /^([A-Z]+)(USDC|USDT|USD|EUR|GBP|JPY)$/i.exec(symbol);
    return m ? `${m[1].toUpperCase()}-${m[2].toUpperCase()}` : symbol;
}

async function fetchBinanceKlines(args: {
    symbol: string;
    startTs: number;
    endTs: number;
    intervalMs: number;
}): Promise<OhlcvBar[]> {
    const interval = nearestBinanceInterval(args.intervalMs);
    const symbol = symbolForBinance(args.symbol);
    const out: OhlcvBar[] = [];
    let cursor = args.startTs;
    while (cursor < args.endTs) {
        const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(
            symbol,
        )}&interval=${interval}&startTime=${cursor}&endTime=${args.endTs}&limit=1000`;
        const resp = await fetch(url);
        if (!resp.ok) {
            throw new Error(`Binance klines fetch failed: HTTP ${resp.status}`);
        }
        const data = (await resp.json()) as Array<
            [number, string, string, string, string, string, ...unknown[]]
        >;
        if (!Array.isArray(data) || data.length === 0) break;
        for (const row of data) {
            const [ts, open, high, low, close, volume] = row;
            const bar: OhlcvBar = {
                timestamp: Number(ts),
                open: Number.parseFloat(open),
                high: Number.parseFloat(high),
                low: Number.parseFloat(low),
                close: Number.parseFloat(close),
                volume: Number.parseFloat(volume),
            };
            if (Number.isFinite(bar.timestamp) && Number.isFinite(bar.close)) {
                out.push(bar);
            }
        }
        const last = data[data.length - 1];
        const lastTs = Number(last[0]);
        if (!Number.isFinite(lastTs) || lastTs <= cursor) break;
        cursor = lastTs + args.intervalMs;
        if (data.length < 1000) break;
    }
    return out;
}

async function fetchCoinbaseCandles(args: {
    symbol: string;
    startTs: number;
    endTs: number;
    intervalMs: number;
}): Promise<OhlcvBar[]> {
    const granularity = nearestCoinbaseGranularity(args.intervalMs);
    const productId = productIdForCoinbase(args.symbol);
    const out: OhlcvBar[] = [];
    let cursor = Math.floor(args.startTs / 1000);
    const endSec = Math.floor(args.endTs / 1000);
    while (cursor < endSec) {
        const windowEnd = Math.min(cursor + granularity * 300, endSec);
        const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(
            productId,
        )}/candles?start=${new Date(cursor * 1000).toISOString()}&end=${new Date(
            windowEnd * 1000,
        ).toISOString()}&granularity=${granularity}`;
        const resp = await fetch(url);
        if (!resp.ok) {
            throw new Error(`Coinbase candles fetch failed: HTTP ${resp.status}`);
        }
        const data = (await resp.json()) as Array<[number, number, number, number, number, number]>;
        if (!Array.isArray(data) || data.length === 0) break;
        for (const [ts, low, high, open, close, volume] of data) {
            out.push({
                timestamp: ts * 1000,
                open,
                high,
                low,
                close,
                volume,
            });
        }
        if (windowEnd === endSec) break;
        cursor = windowEnd;
    }
    out.sort((a, b) => a.timestamp - b.timestamp);
    return out;
}

export class RealOhlcvDataSource implements OhlcvDataSource {
    constructor(
        private readonly venue: "binance" | "coinbase",
        private readonly intervalMs: number,
    ) {}

    async fetch(args: { symbol: string; startTs: number; endTs: number }): Promise<OhlcvBar[]> {
        if (this.venue === "binance") {
            return fetchBinanceKlines({ ...args, intervalMs: this.intervalMs });
        }
        return fetchCoinbaseCandles({ ...args, intervalMs: this.intervalMs });
    }
}

/**
 * Convenience: fetch bars synchronously-ish for the backtest action.
 * On failure (rate limit, network), returns null so caller can fall
 * back to synthetic bars without crashing the action.
 */
export async function fetchOhlcvBarsSafe(args: {
    venue: "binance" | "coinbase";
    symbol: string;
    intervalMs: number;
    /** Number of bars desired ending at `endTs`. */
    count: number;
    endTs?: number;
}): Promise<OhlcvBar[] | null> {
    try {
        const source = new RealOhlcvDataSource(args.venue, args.intervalMs);
        const endTs = args.endTs ?? Date.now();
        const startTs = endTs - args.count * args.intervalMs;
        const bars = await source.fetch({ symbol: args.symbol, startTs, endTs });
        if (bars.length === 0) return null;
        return bars.slice(-args.count);
    } catch {
        return null;
    }
}
