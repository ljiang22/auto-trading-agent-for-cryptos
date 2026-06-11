import type { OhlcvBar } from "./types";

export interface OhlcvDataSource {
    /**
     * Return all bars for `symbol` between `[startTs, endTs]` inclusive.
     * Must be sorted ascending by timestamp.
     */
    fetch(args: {
        symbol: string;
        startTs: number;
        endTs: number;
    }): Promise<OhlcvBar[]>;
}

/** Synthetic in-memory source used by tests and the CLI demo. */
export class InMemoryOhlcvSource implements OhlcvDataSource {
    constructor(private readonly bars: OhlcvBar[]) {}

    async fetch(args: {
        symbol: string;
        startTs: number;
        endTs: number;
    }): Promise<OhlcvBar[]> {
        return this.bars
            .filter((b) => b.timestamp >= args.startTs && b.timestamp <= args.endTs)
            .sort((a, b) => a.timestamp - b.timestamp);
    }
}

/**
 * Parses an OHLCV CSV (timestamp, open, high, low, close, volume) into
 * bars. Each line: `1700000000000,40000,40500,39800,40300,1500.5`.
 * Lines starting with `#` or `timestamp` are skipped.
 */
export function parseOhlcvCsv(text: string): OhlcvBar[] {
    const out: OhlcvBar[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#") || line.startsWith("timestamp")) continue;
        const parts = line.split(",");
        if (parts.length < 6) continue;
        const ts = Number.parseInt(parts[0], 10);
        if (!Number.isFinite(ts)) continue;
        out.push({
            timestamp: ts,
            open: Number.parseFloat(parts[1]),
            high: Number.parseFloat(parts[2]),
            low: Number.parseFloat(parts[3]),
            close: Number.parseFloat(parts[4]),
            volume: Number.parseFloat(parts[5]),
        });
    }
    out.sort((a, b) => a.timestamp - b.timestamp);
    return out;
}

/** Stable synthetic bar generator for deterministic tests. */
export function generateSyntheticBars(args: {
    symbol: string;
    startTs: number;
    /** Number of bars to emit. */
    count: number;
    /** Bar interval in ms (e.g., 3_600_000 for hourly). */
    intervalMs: number;
    /** Initial close price. */
    initialPrice: number;
    /** Per-bar drift (return). */
    drift: number;
    /** Per-bar volatility (stddev of log returns). */
    volatility: number;
    /** Optional seed for the PRNG. */
    seed?: number;
}): OhlcvBar[] {
    let seed = args.seed ?? 12345;
    const rand = () => {
        seed = (seed * 9301 + 49297) % 233280;
        return seed / 233280;
    };
    const gauss = () => {
        const u1 = Math.max(rand(), 1e-9);
        const u2 = rand();
        return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };
    const bars: OhlcvBar[] = [];
    let price = args.initialPrice;
    for (let i = 0; i < args.count; i++) {
        const ret = args.drift + args.volatility * gauss();
        const nextPrice = price * Math.exp(ret);
        const open = price;
        const close = nextPrice;
        const high = Math.max(open, close) * (1 + Math.abs(args.volatility) * rand());
        const low = Math.min(open, close) * (1 - Math.abs(args.volatility) * rand());
        const volume = 100 + rand() * 1000;
        bars.push({
            timestamp: args.startTs + i * args.intervalMs,
            open,
            high,
            low,
            close,
            volume,
        });
        price = nextPrice;
    }
    return bars;
}
