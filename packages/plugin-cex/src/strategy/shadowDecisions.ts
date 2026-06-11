import type { CanonicalIntent } from "../intent/canonicalIntent";
import type { ExchangeName } from "../types";

export interface ShadowDecisionRecord {
    request_id: string;
    userId: string;
    strategy_id?: string;
    intent_hash: string;
    client_order_id: string;
    venue: ExchangeName;
    symbol?: string;
    side?: "BUY" | "SELL";
    /** What ADK + risk + idempotency decided. */
    decision: "allow" | "block" | "downgrade_read_only";
    rules_fired: string[];
    /** Hypothetical execution outcome computed against live market data. */
    hypothetical_fill_price?: string;
    hypothetical_fill_quantity?: string;
    hypothetical_filled_at?: string;
    /** Recorded mid price at decision-time. */
    market_mid_price?: string;
    /** What the live system would have done — for divergence aggregation. */
    paper_decision?: "allow" | "block" | "downgrade_read_only";
    /** Whether shadow and paper decisions agreed. */
    paper_divergence?: boolean;
    locale: string;
    createdAt: string;
}

export interface ShadowDecisionWriter {
    record(record: ShadowDecisionRecord): Promise<void>;
}

export interface BuildShadowDecisionInput {
    intent: CanonicalIntent;
    decision: "allow" | "block" | "downgrade_read_only";
    rules_fired: string[];
    strategy_id?: string;
    hypothetical_fill_price?: string;
    hypothetical_fill_quantity?: string;
    hypothetical_filled_at?: string;
    market_mid_price?: string;
    paper_decision?: "allow" | "block" | "downgrade_read_only";
}

export function buildShadowDecisionRecord(
    input: BuildShadowDecisionInput,
): ShadowDecisionRecord {
    const paperDecision = input.paper_decision;
    const divergence =
        paperDecision !== undefined ? paperDecision !== input.decision : undefined;
    return {
        request_id: input.intent.request_id,
        userId: input.intent.user_id,
        strategy_id: input.strategy_id,
        intent_hash: input.intent.idempotency.intent_hash,
        client_order_id: input.intent.idempotency.client_order_id,
        venue: input.intent.venue,
        symbol: input.intent.symbol,
        side: input.intent.side,
        decision: input.decision,
        rules_fired: input.rules_fired,
        hypothetical_fill_price: input.hypothetical_fill_price,
        hypothetical_fill_quantity: input.hypothetical_fill_quantity,
        hypothetical_filled_at: input.hypothetical_filled_at,
        market_mid_price: input.market_mid_price,
        paper_decision: paperDecision,
        paper_divergence: divergence,
        locale: input.intent.locale,
        createdAt: new Date().toISOString(),
    };
}

/** Stub writer used in tests / before MongoDB wiring lands. */
export function createInMemoryShadowDecisionWriter(): ShadowDecisionWriter & {
    records: ShadowDecisionRecord[];
} {
    const records: ShadowDecisionRecord[] = [];
    return {
        records,
        async record(rec: ShadowDecisionRecord): Promise<void> {
            records.push(rec);
        },
    };
}

/**
 * Structural type for the MongoDB adapter's shadow-decision writer hook.
 * Decoupled from the adapter package so plugin-cex doesn't need to import
 * `@elizaos-plugins/adapter-mongodb` (avoids a circular dep). The
 * adapter's `writeShadowDecision(record)` method satisfies this shape.
 */
export interface ShadowDecisionPersistenceAdapter {
    writeShadowDecision: (record: Record<string, unknown>) => Promise<void>;
}

/**
 * MongoDB-backed writer that persists shadow decisions through the
 * runtime's database adapter. Survives container restart, supports
 * divergence aggregation queries via the indexed
 * `(userId, createdAt)` / `strategy_id` keys.
 *
 * Falls back to a console warning (no throw) when the runtime adapter
 * lacks the hook — keeps the strategy runtime ergonomic during cold
 * boots where the adapter hasn't initialised the trading collections.
 */
export function createMongoShadowDecisionWriter(
    adapter: ShadowDecisionPersistenceAdapter,
): ShadowDecisionWriter {
    return {
        async record(rec: ShadowDecisionRecord): Promise<void> {
            try {
                await adapter.writeShadowDecision(rec as unknown as Record<string, unknown>);
            } catch (err) {
                // Never let a shadow-write failure bubble into the live
                // path. Shadow mode is observational; losing one row is
                // safer than throwing.
                // eslint-disable-next-line no-console
                console.warn(
                    `[shadowDecisions] writeShadowDecision failed for request_id=${rec.request_id}: ${String(err)}`,
                );
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Module-level registry — `agent/src/index.ts` wires the MongoDB-backed
// writer at startup; tests + offline tooling fall back to the in-memory
// writer. The strategy runtime reads the active writer via
// `getShadowDecisionWriter()` so callers don't thread it through.
// ---------------------------------------------------------------------------

let _writer: ShadowDecisionWriter | null = null;

export function setShadowDecisionWriter(writer: ShadowDecisionWriter | null): void {
    _writer = writer;
}

export function getShadowDecisionWriter(): ShadowDecisionWriter | null {
    return _writer;
}

/**
 * Aggregation helper: divergence ratio (shadow vs paper) for a window.
 * Phase 4 DoD requires < 5% across the 100-prompt synthetic suite.
 */
export function computeDivergenceRatio(records: ShadowDecisionRecord[]): number {
    const withPair = records.filter((r) => r.paper_decision !== undefined);
    if (withPair.length === 0) return 0;
    const diverged = withPair.filter((r) => r.paper_divergence === true).length;
    return diverged / withPair.length;
}
