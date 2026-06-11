import type { RiskAuditSink } from "../risk/auditLog";

/**
 * Module-level cache for the risk-audit sink. The handler injects a sink at
 * agent startup (via `setRiskAuditSink`) and `runRiskPrecheck` reuses it for
 * every evaluation. `null` means "no sink configured" — the dep-health gate
 * then refuses live writes. See plan §6.1 + §6.0.2.
 */
let _riskAuditSink: RiskAuditSink | null = null;

export function setRiskAuditSink(sink: RiskAuditSink | null): void {
    _riskAuditSink = sink;
}

export function getRiskAuditSink(): RiskAuditSink | null {
    return _riskAuditSink;
}
