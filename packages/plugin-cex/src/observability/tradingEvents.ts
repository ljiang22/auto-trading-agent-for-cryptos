import { EventEmitter } from "node:events";
import { elizaLogger } from "@elizaos/core";

import type { CanonicalIntent, IntentMode, Locale, Stake } from "../intent/canonicalIntent";
import type { RiskDecision } from "../risk/types";
import type { ExchangeName } from "../types";

export type TradingEventStage =
    | "preprocess"
    | "intent_classified"
    | "clarification_request"
    | "stake_check"
    | "risk_check"
    | "idempotency"
    | "idempotency_hit"
    | "lock_acquire"
    | "lock_release"
    | "approval_request"
    | "approval_decision"
    | "order_dispatch_attempt"
    | "order_submit"
    | "order_ack"
    | "order_error"
    | "reconciliation_event"
    | "reconciliation_health"
    | "venue_call"
    | "fail_closed"
    | "kill_switch_activation"
    | "prompt_injection_detected"
    | "timeout"
    | "unknown_state"
    | "strategy_status_change";

/**
 * Whitelisted field set every `[Trading]` line carries. New fields
 * require a coordinated dashboard / metric-filter update.
 *
 * F4 — `stake` carries the **execution stake** (live / paper / shadow),
 * matching the CLAUDE.md autotrading spec's invariant field set. The
 * separate `tool_capability` field carries the per-tool read_only/write
 * classification surfaced by `emitPreprocess` / `emitStakeCheck` /
 * `emitIntentClassified` — those wire-rename the historical `stake`
 * argument so the CLAUDE.md `stake` slot is reserved for execution mode.
 */
export interface TradingEventEnvelope {
    stage: TradingEventStage;
    request_id?: string;
    intent_hash?: string;
    userId?: string;
    venue?: ExchangeName;
    symbol?: string;
    side?: "BUY" | "SELL";
    notional_usd?: number;
    locale?: Locale;
    stake?: IntentMode;
    tool_capability?: Stake;
    decision?: string;
    rules_fired?: string[];
    latency_ms?: number;
    [k: string]: unknown;
}

export interface TradingEvent extends TradingEventEnvelope {
    timestamp: string;
}

const LEVEL_FOR_STAGE: Record<TradingEventStage, "info" | "warn" | "error"> = {
    preprocess: "info",
    intent_classified: "info",
    clarification_request: "info",
    stake_check: "info",
    risk_check: "info",
    idempotency: "info",
    idempotency_hit: "warn",
    lock_acquire: "info",
    lock_release: "info",
    approval_request: "info",
    approval_decision: "info",
    order_dispatch_attempt: "info",
    order_submit: "info",
    order_ack: "info",
    order_error: "error",
    reconciliation_event: "info",
    reconciliation_health: "warn",
    venue_call: "info",
    fail_closed: "error",
    kill_switch_activation: "warn",
    prompt_injection_detected: "warn",
    timeout: "warn",
    unknown_state: "warn",
    strategy_status_change: "info",
};

/**
 * In-process bus so multiple consumers can attach (log emitter, notification
 * dispatcher, future subscribers). Subscribers MUST NOT throw — `emit` wraps
 * each listener invocation in try/catch and never propagates listener errors.
 * See plan §7.9.
 */
class TradingEventsBus extends EventEmitter {}
const bus = new TradingEventsBus();
bus.setMaxListeners(50);

/**
 * Subscribe to every emitted trading event. Returns an unsubscribe function.
 * Listeners are dispatched best-effort; throws are swallowed and logged at
 * `warn` so a broken subscriber cannot brick the trading path.
 */
export function onTradingEvent(listener: (event: TradingEvent) => void): () => void {
    const wrapped = (event: TradingEvent) => {
        try {
            listener(event);
        } catch (err) {
            elizaLogger.warn(
                `[TradingEvents] subscriber threw — continuing: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }
    };
    bus.on("event", wrapped);
    return () => bus.off("event", wrapped);
}

function emit(envelope: TradingEventEnvelope): void {
    const event: TradingEvent = {
        ...envelope,
        timestamp: new Date().toISOString(),
    };
    const level = LEVEL_FOR_STAGE[envelope.stage];
    const line = `[Trading] ${JSON.stringify(event)}`;
    if (level === "error") elizaLogger.error(line);
    else if (level === "warn") elizaLogger.warn(line);
    else elizaLogger.info(line);
    // Fan out to subscribers AFTER the log line lands so a failing subscriber
    // can't suppress the audit trail.
    try {
        bus.emit("event", event);
    } catch (err) {
        elizaLogger.warn(
            `[TradingEvents] bus.emit threw: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
    }
}

function intentFields(intent: CanonicalIntent): Partial<TradingEventEnvelope> {
    // F4 — invariant field set. Every event that has access to a
    // CanonicalIntent emits all 12 fields from the CLAUDE.md spec so a
    // CloudWatch metric filter on `stake=live decision=allow` is
    // deployable as-is. `notional_usd` is the pre-execution estimate
    // (not post-fill exact); `stake` is the resolved execution mode.
    //
    // H3 — also stamp `action`, `order_type`, TIF, post_only, and
    // margin_type so dashboards can slice order_submit / order_ack /
    // risk_check by trading-action class and order shape without a
    // separate enrichment step. Optional fields are omitted (not set
    // to `undefined`) so JSON output stays compact.
    const base: Partial<TradingEventEnvelope> = {
        request_id: intent.request_id,
        intent_hash: intent.idempotency.intent_hash,
        userId: intent.user_id,
        venue: intent.venue,
        symbol: intent.symbol,
        side: intent.side,
        notional_usd: intent.notional_usd_estimated,
        locale: intent.locale,
        stake: intent.mode,
        action: intent.action,
    };
    if (intent.order_type) base.order_type = intent.order_type;
    const tif = intent.execution_constraints?.time_in_force;
    if (tif) base.time_in_force = tif;
    if (typeof intent.execution_constraints?.post_only === "boolean") {
        base.post_only = intent.execution_constraints.post_only;
    }
    const marginType = intent.margin_context?.margin_type;
    if (marginType) base.margin_type = marginType;
    return base;
}

export function emitPreprocess(args: {
    request_id: string;
    userId: string;
    locale: Locale;
    stake: Stake;
    venue?: ExchangeName;
    latency_ms?: number;
}): void {
    // F4 — the historical `stake` argument carries read_only/write
    // (tool capability), not the spec's execution mode. Re-emit it on
    // the `tool_capability` wire field so the CLAUDE.md `stake` slot
    // stays reserved for paper/shadow/live.
    const { stake, ...rest } = args;
    emit({ stage: "preprocess", ...rest, tool_capability: stake });
}

export function emitIntentClassified(
    intent: CanonicalIntent,
    tool_capability: Stake,
    latency_ms?: number,
): void {
    // F4 — `intentFields()` now stamps `stake: intent.mode` for us;
    // the `tool_capability` arg keeps the read_only/write classification
    // on a separate, unambiguous wire field.
    emit({
        stage: "intent_classified",
        ...intentFields(intent),
        tool_capability,
        latency_ms,
    });
}

export function emitClarificationRequest(args: {
    request_id: string;
    userId: string;
    locale: Locale;
    venue_options: ExchangeName[];
}): void {
    emit({
        stage: "clarification_request",
        request_id: args.request_id,
        userId: args.userId,
        locale: args.locale,
        venue_options: args.venue_options,
    });
}

export function emitStakeCheck(args: {
    request_id: string;
    userId: string;
    locale: Locale;
    stake: Stake;
    action: string;
}): void {
    // F4 — wire-rename: `stake` arg (read_only/write) → `tool_capability`
    // wire field. See `emitPreprocess` for the rationale.
    const { stake, ...rest } = args;
    emit({ stage: "stake_check", ...rest, tool_capability: stake });
}

export function emitRiskCheck(
    intent: CanonicalIntent,
    decision: RiskDecision,
    latency_ms?: number,
): void {
    emit({
        stage: "risk_check",
        ...intentFields(intent),
        decision: decision.verdict,
        rules_fired: decision.rules_fired,
        latency_ms,
    });
}

export function emitIdempotency(
    intent: CanonicalIntent,
    is_duplicate: boolean,
): void {
    emit({
        stage: "idempotency",
        ...intentFields(intent),
        client_order_id: intent.idempotency.client_order_id,
        is_duplicate,
    });
}

export function emitLockAcquire(args: {
    request_id: string;
    userId: string;
    venue: ExchangeName;
    symbol: string;
    waited_ms?: number;
}): void {
    emit({ stage: "lock_acquire", ...args });
}

export function emitLockRelease(args: {
    request_id: string;
    userId: string;
    venue: ExchangeName;
    symbol: string;
    held_ms?: number;
    reason: "ack" | "terminal" | "ttl_expired" | "error";
}): void {
    emit({ stage: "lock_release", ...args });
}

export function emitApprovalRequest(
    intent: CanonicalIntent,
    level: 1 | 2,
): void {
    emit({
        stage: "approval_request",
        ...intentFields(intent),
        approval_level: level,
    });
}

export function emitApprovalDecision(
    intent: CanonicalIntent,
    decision: "approved" | "rejected",
    level: 1 | 2,
): void {
    emit({
        stage: "approval_decision",
        ...intentFields(intent),
        decision,
        approval_level: level,
    });
}

export function emitOrderSubmit(intent: CanonicalIntent): void {
    emit({
        stage: "order_submit",
        ...intentFields(intent),
        client_order_id: intent.idempotency.client_order_id,
    });
}

export function emitOrderAck(
    intent: CanonicalIntent,
    latency_ms: number,
    venue_order_id?: string,
): void {
    emit({
        stage: "order_ack",
        ...intentFields(intent),
        latency_ms,
        venue_order_id,
    });
}

export function emitOrderError(
    intent: CanonicalIntent,
    err: { code?: string; message?: string },
    latency_ms?: number,
): void {
    // F4-r3 — order_error gains optional latency_ms so the
    // submit→error span is observable. Callers pass
    // `Date.now() - state.startedAt` for symmetry with order_ack.
    emit({
        stage: "order_error",
        ...intentFields(intent),
        code: err.code,
        message: err.message,
        latency_ms,
    });
}

/**
 * F5 — reconciliation health emit. Fires when the per-user fallback
 * poller has gone `streak` consecutive cycles unable to resolve creds
 * for `(userId, venue)`. CloudWatch metric filter: alarm when
 * `stage="reconciliation_health" decision="downgrade"` is non-zero
 * for > 5 min while orders are pending on that venue.
 */
export function emitReconciliationHealth(args: {
    userId: string;
    venue: ExchangeName;
    decision: "downgrade" | "recovered";
    streak: number;
    reason?: string;
    latency_ms?: number;
}): void {
    // F4-r3 — latency_ms for reconciliation_health represents the
    // streak duration (poll_interval_ms * streak) so dashboards can
    // graph "how long was this user locked".
    emit({ stage: "reconciliation_health", ...args });
}

export function emitReconciliationEvent(args: {
    request_id?: string;
    intent_hash?: string;
    userId?: string;
    venue?: ExchangeName;
    symbol?: string;
    client_order_id?: string;
    state?: string;
    source: "ws" | "rest_fallback";
    /**
     * F4-r3 — submit → reconciliation latency (Date.now() - submittedAt
     * on the matching ledger row). The reconciliation service already
     * computes this; expose it on the wire so per-source SLOs are
     * directly graphable.
     */
    latency_ms?: number;
}): void {
    emit({ stage: "reconciliation_event", ...args });
}

export function emitVenueCall(args: {
    request_id?: string;
    userId?: string;
    venue: ExchangeName;
    endpoint: string;
    method: "GET" | "POST" | "PUT" | "DELETE";
    latency_ms: number;
    http_status: number;
    retry_count?: number;
    client_order_id?: string;
}): void {
    emit({ stage: "venue_call", ...args });
}

export function emitFailClosed(args: {
    request_id?: string;
    userId?: string;
    venue?: ExchangeName;
    locale?: Locale;
    reasons: string[];
    bypassed?: boolean;
}): void {
    emit({ stage: "fail_closed", ...args });
}

export function emitKillSwitchActivation(args: {
    userId: string;
    active: boolean;
    actor?: string;
    reason?: string;
    /**
     * F4-r3 — when the kill switch is flipping OFF after having been
     * on, callers pass `Date.now() - flipped_on_at_ms` so the
     * dashboard can graph "how long was live trading paused for this
     * user". Omitted on the activation (on→on→off transition).
     */
    latency_ms?: number;
}): void {
    emit({ stage: "kill_switch_activation", ...args });
}

export function emitPromptInjectionDetected(args: {
    request_id?: string;
    userId?: string;
    locale?: Locale;
    score: number;
    verdict: "refuse" | "downgrade";
    matched_patterns?: string[];
}): void {
    emit({ stage: "prompt_injection_detected", ...args });
}

export function emitTimeout(args: {
    request_id?: string;
    userId?: string;
    site: string;
    timeout_ms: number;
}): void {
    emit({ stage: "timeout", ...args });
}

export function emitIdempotencyHit(args: {
    request_id?: string;
    intent_hash?: string;
    userId?: string;
    venue?: ExchangeName;
    symbol?: string;
    client_order_id: string;
    existing_state: string;
}): void {
    emit({ stage: "idempotency_hit", ...args });
}

export function emitStrategyStatusChange(args: {
    userId: string;
    strategy_id: string;
    previous_status: "running" | "paused" | "stopped";
    new_status: "running" | "paused" | "stopped";
    actor?: string;
}): void {
    emit({ stage: "strategy_status_change", ...args });
}

export function emitUnknownState(args: {
    request_id?: string;
    intent_hash?: string;
    userId?: string;
    venue?: ExchangeName;
    symbol?: string;
    client_order_id: string;
    cause: "venue_5xx" | "venue_timeout" | "venue_network_error";
    http_status?: number;
}): void {
    emit({ stage: "unknown_state", ...args });
}
