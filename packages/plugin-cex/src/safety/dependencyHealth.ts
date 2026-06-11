/**
 * Fail-closed dep-health gate. Combined into a single decision before any
 * live-mode write. Paper mode bypasses (so testing remains possible); shadow
 * mode logs but does not block. See plan §6.0.2.
 */

import type { IntentMode } from "../intent/canonicalIntent";

export type HealthIssue =
    | "risk_audit_sink_dead"
    | "reconciliation_dead"
    | "no_audit_sink_configured";

export interface DependencyHealthInput {
    /** Result of the just-completed risk-audit write. Null = sink not invoked. */
    riskAuditWroteOk: boolean | null;
    /** Reconciliation service liveness for the resolved venue. */
    reconciliationHealthy: boolean | null;
    /**
     * Round-6b — kept on the input shape for backward compat with the
     * CEXSpecProvider contract but UNUSED by the gate. The original
     * "market_data_stale" reason was sourced from a module-level Map
     * that recorded a sample only when one of the USER'S OWN order
     * states transitioned (see `marketDataAge.ts`). It was named like
     * a price-tick metric but measured user-order activity, so a
     * normal quiet period (no one trading) made it report stale and
     * refused live writes with a misleading "Latest price tick is
     * older than the freshness cap" message. The `reconciliation_dead`
     * reason already covers the actual safety property (WS truly
     * disconnected). When a real price-tick stream lands, restore
     * this with a heartbeat-anchored sample, not a transition-anchored
     * one.
     */
    marketDataAgeMs?: number | null;
    /** Same — retained for shape compat, unused. */
    liveFreshnessCapMs?: number;
    /** Mode of the canonical intent driving this decision. */
    mode: IntentMode;
    /**
     * Canonical action name (`create_order` / `cancel_order` /
     * `amend_order` / read-only). Retained on the input shape now
     * that the freshness check is gone — it documented the
     * action-specific behavior. Currently unused by the gate.
     */
    action?: string;
}

export type DependencyHealthResult =
    | { healthy: true }
    | { healthy: false; reasons: HealthIssue[]; bypassed: boolean };

/**
 * Pure function. Decides whether to allow a write to proceed given the
 * post-risk-audit dep-health state.
 *
 * Policy:
 * - `paper` mode: always healthy (tests must keep running even if Mongo is dead).
 * - `shadow` mode: returns the reasons but flags `bypassed: true` so the caller
 *   can log without blocking.
 * - `live` mode: any reason → block.
 */
export function checkTradingHealth(input: DependencyHealthInput): DependencyHealthResult {
    if (input.mode === "paper") return { healthy: true };

    const reasons: HealthIssue[] = [];

    if (input.riskAuditWroteOk === false) reasons.push("risk_audit_sink_dead");
    if (input.riskAuditWroteOk === null) reasons.push("no_audit_sink_configured");
    if (input.reconciliationHealthy === false) reasons.push("reconciliation_dead");

    // Round-6b — `market_data_stale` reason intentionally removed. See
    // the `marketDataAgeMs` comment on `DependencyHealthInput` for the
    // full rationale. Short version: the sample was anchored on
    // user-order transitions, not a real price feed, so a quiet
    // trading window would mis-report stale and refuse live writes
    // with a misleading "Latest price tick is older than the freshness
    // cap" message. `reconciliation_dead` already covers the safety
    // property (WS truly disconnected). The `marketDataFreshness`
    // risk rule (see `risk/rules/marketDataFreshness.ts`) handles real
    // price-tick freshness IF a future price-tick stream wires
    // `ctx.market_data_age_ms` from an actual ticker subscription —
    // until then it's a no-op (returns "allow" when the field is
    // undefined).

    if (reasons.length === 0) return { healthy: true };

    // Shadow mode logs but does not block (so dry-runs keep producing data).
    if (input.mode === "shadow") {
        return { healthy: false, reasons, bypassed: true };
    }

    return { healthy: false, reasons, bypassed: false };
}

/**
 * Localized user-facing message for a fail-closed decision. The handler now
 * routes directly through `buildUserError` in core; this legacy fallback is
 * retained for the spec-provider entry point that older clients may still call.
 * The catalog-rendered output is the source of truth — this string format is
 * deprecated.
 *
 * lint-error-contracts-allow: legacy renderer retained for backward compat;
 * the canonical surface is buildUserError({ code: "dep_unhealthy" | "fail_closed_*" }).
 */
export function renderFailClosedMessage(
    reasons: HealthIssue[],
    locale: "en" | "zh-CN" | "mixed-en",
): string {
    const reasonLabel = reasons.join(", ");
    if (locale === "zh-CN") {
        return [
            "🛑 交易已暂停 — 系统降级。只读查询仍然可用。",
            `原因: ${reasonLabel}`,
        ].join("\n");
    }
    return [
        // lint-error-contracts-allow: legacy renderer; canonical surface is buildUserError.
        "🛑 Trading paused — system degraded. Read-only queries still available.",
        `Reason: ${reasonLabel}`,
    ].join("\n");
}
