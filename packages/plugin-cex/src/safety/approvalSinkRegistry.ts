export interface ApprovalDecisionRecord {
    request_id: string;
    userId: string;
    intent_hash?: string;
    level: 1 | 2;
    decision: "approved" | "rejected" | "expired";
    presented_summary?: Record<string, unknown>;
    consent_text_version?: string;
    approved_fields?: string[];
    clientIp?: string;
    userAgent?: string;
}

export interface ApprovalDecisionSink {
    writeApprovalDecision(record: ApprovalDecisionRecord): Promise<void>;
}

/**
 * Module-level cache for the approval-decision sink. The agent startup
 * wires this in the same place as the risk-audit sink (plan §6.2).
 */
let _approvalSink: ApprovalDecisionSink | null = null;

export function setApprovalDecisionSink(sink: ApprovalDecisionSink | null): void {
    _approvalSink = sink;
}

export function getApprovalDecisionSink(): ApprovalDecisionSink | null {
    return _approvalSink;
}
