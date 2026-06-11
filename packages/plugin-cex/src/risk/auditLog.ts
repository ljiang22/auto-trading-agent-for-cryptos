import type { CanonicalIntent } from "../intent/canonicalIntent";
import type { RiskDecision, RiskDecisionRecord } from "./types";

export function buildRiskDecisionRecord(
    intent: CanonicalIntent,
    decision: RiskDecision,
): RiskDecisionRecord {
    return {
        request_id: intent.request_id,
        userId: intent.user_id,
        intent_hash: intent.idempotency.intent_hash,
        client_order_id: intent.idempotency.client_order_id,
        decision: decision.verdict,
        rules_fired: decision.rules_fired,
        explanations: decision.explanations,
        locale: intent.locale,
        venue: intent.venue,
        symbol: intent.symbol,
        side: intent.side,
        mode: intent.mode,
        action: intent.action,
        createdAt: new Date(),
    };
}

/**
 * Optional persistence interface. The handler will adapt the database
 * adapter to this shape; the risk module itself stays I/O-free.
 */
export interface RiskAuditSink {
    writeDecision(record: RiskDecisionRecord): Promise<void>;
}
