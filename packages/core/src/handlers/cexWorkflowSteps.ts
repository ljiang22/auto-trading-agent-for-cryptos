/**
 * Canonical SSE `ProcessingStep` names emitted from the CEX workflow.
 *
 * Per plan §1.9: stable names, payload-only state, never embed
 * structured data in the `name` field. Adding a new step name
 * requires a coordinated update of the client `useStreamingMessage`
 * dispatcher.
 */
export const CEX_WORKFLOW_STEPS = {
    preprocess: "Trading: preprocess",
    stakeCheck: "Trading: stake check",
    riskCheck: "Trading: risk check",
    idempotency: "Trading: idempotency",
    lockAcquire: "Trading: lock acquire",
    lockRelease: "Trading: lock release",
    orderSubmit: "Trading: order submit",
    reconciliation: "Trading: reconciliation",
    clarification: "Trading: clarification",
    approvalRequest: "Trading: approval request",
    approvalDecision: "Trading: approval decision",
} as const;

export type CexWorkflowStepName =
    (typeof CEX_WORKFLOW_STEPS)[keyof typeof CEX_WORKFLOW_STEPS];
