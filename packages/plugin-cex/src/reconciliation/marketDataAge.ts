/**
 * §6.0.2 — market-data freshness tracker.
 *
 * The reconciliation WS consumers (binanceUserDataStream, coinbaseUserOrderStream)
 * record a sample every time a `reconciliation_event` lands. The dep-health
 * gate reads the age of the most recent sample for `(venue, symbol)` and
 * refuses live writes when it exceeds `liveFreshnessCapMs`.
 *
 * The tracker is module-level and process-scoped — a fresh ECS task starts
 * with an empty map. Until at least one event has landed the gate treats
 * the age as null (allowed). The first failed write after a WS disconnect
 * is the explicit signal we want to surface: between disconnect and the
 * next ack, the market data is genuinely stale.
 */

interface Sample {
    timestamp: number;
}

const samples: Map<string, Sample> = new Map();

function key(venue: string, symbol: string): string {
    return `${venue.toLowerCase()}:${symbol.toUpperCase()}`;
}

export function recordMarketDataSample(venue: string, symbol: string): void {
    if (!venue || !symbol) return;
    samples.set(key(venue, symbol), { timestamp: Date.now() });
}

export function getMarketDataAgeMs(venue: string, symbol: string): number | null {
    if (!venue || !symbol) return null;
    const s = samples.get(key(venue, symbol));
    if (!s) return null;
    return Date.now() - s.timestamp;
}

/** Test-only: reset the module-level sample map. */
export function __resetMarketDataAgeForTests(): void {
    samples.clear();
}
