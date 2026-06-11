import type {
    LedgerOperations,
    PendingOrderLedgerRow,
    PendingOrderState,
} from "../reconciliation/types";

const NON_TERMINAL_STATES: ReadonlySet<PendingOrderState> = new Set([
    "submitted",
    "acked",
    "partially_filled",
]);

const TERMINAL_STATES: ReadonlySet<PendingOrderState> = new Set([
    "filled",
    "cancelled",
    "expired",
    "rejected",
    "reconciliation_failed",
]);

/**
 * Fix-NEW9 iter4 (post-PR244): a pending-orders ledger row may be
 * stuck in a non-terminal state (`submitted` / `acked`) forever if
 * the reconciler missed its terminal transition. Once a row is older
 * than this window, treat it as terminal-by-staleness — the
 * deterministic intent-hash → client_order_id contract reproduces
 * the SAME id for a re-submitted identical order minutes later, and
 * without this heuristic that legitimate re-submit gets blocked with
 * "uncertain outcome" forever.
 */
const STALE_AGE_MS = 5 * 60 * 1000;

function ageMsOf(row: PendingOrderLedgerRow): number | null {
    const candidates: Array<unknown> = [
        (row as { updated_at?: unknown }).updated_at,
        (row as { submitted_at?: unknown }).submitted_at,
        (row as { created_at?: unknown }).created_at,
        (row as { last_seen_ms?: unknown }).last_seen_ms,
    ];
    for (const c of candidates) {
        if (typeof c === "number" && Number.isFinite(c) && c > 0) {
            return Date.now() - c;
        }
        if (c instanceof Date && Number.isFinite(c.getTime())) {
            return Date.now() - c.getTime();
        }
        if (typeof c === "string") {
            const ms = Date.parse(c);
            if (Number.isFinite(ms)) return Date.now() - ms;
        }
    }
    return null;
}

export type PreSubmitDedupResult =
    | { kind: "new" }
    | { kind: "in_flight"; order: PendingOrderLedgerRow }
    | { kind: "unknown_state"; order: PendingOrderLedgerRow }
    | { kind: "terminal"; order: PendingOrderLedgerRow };

export async function checkExistingOrder(
    ledger: Pick<LedgerOperations, "getPendingOrderByClientOrderId">,
    client_order_id: string,
): Promise<PreSubmitDedupResult> {
    if (!client_order_id) return { kind: "new" };
    const existing = await ledger.getPendingOrderByClientOrderId(client_order_id);
    if (!existing) return { kind: "new" };

    // Fix-NEW9 iter4 (post-PR244): apply staleness check FIRST so a
    // legitimate re-submit isn't blocked indefinitely by a row whose
    // reconciler-side terminal transition was missed.
    if (NON_TERMINAL_STATES.has(existing.state) || existing.state === "unknown") {
        const age = ageMsOf(existing);
        if (age !== null && age > STALE_AGE_MS) {
            return { kind: "terminal", order: existing };
        }
    }

    if (existing.state === "unknown") {
        return { kind: "unknown_state", order: existing };
    }
    if (NON_TERMINAL_STATES.has(existing.state)) {
        return { kind: "in_flight", order: existing };
    }
    if (TERMINAL_STATES.has(existing.state)) {
        return { kind: "terminal", order: existing };
    }
    return { kind: "in_flight", order: existing };
}

export function isInFlightState(state: PendingOrderState): boolean {
    return NON_TERMINAL_STATES.has(state) || state === "unknown";
}

export function isTerminalState(state: PendingOrderState): boolean {
    return TERMINAL_STATES.has(state);
}
