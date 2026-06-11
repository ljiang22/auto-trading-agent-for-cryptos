import { describe, expect, it } from "vitest";
import { checkTradingHealth } from "../../src/safety/dependencyHealth";

describe("checkTradingHealth", () => {
    const base = {
        riskAuditWroteOk: true,
        reconciliationHealthy: true,
        // Round-6b: marketDataAgeMs is retained on the shape for
        // backward compat but the gate ignores it. The field-shape
        // properties below still assert it doesn't surface a reason.
        marketDataAgeMs: 5_000,
        liveFreshnessCapMs: 30_000,
    } as const;

    it("paper mode always healthy even with dead deps", () => {
        expect(
            checkTradingHealth({
                ...base,
                riskAuditWroteOk: false,
                reconciliationHealthy: false,
                marketDataAgeMs: 999_999,
                mode: "paper",
            }),
        ).toEqual({ healthy: true });
    });

    it("live mode blocks on audit-sink dead", () => {
        const out = checkTradingHealth({ ...base, riskAuditWroteOk: false, mode: "live" });
        expect(out.healthy).toBe(false);
        if (!out.healthy) {
            expect(out.reasons).toContain("risk_audit_sink_dead");
            expect(out.bypassed).toBe(false);
        }
    });

    it("live mode blocks on reconciliation dead", () => {
        const out = checkTradingHealth({
            ...base,
            reconciliationHealthy: false,
            mode: "live",
        });
        expect(out.healthy).toBe(false);
        if (!out.healthy) {
            expect(out.reasons).toContain("reconciliation_dead");
        }
    });

    // Round-6b — the market_data_stale reason is removed. The legacy
    // sample was anchored on user-order transitions, not a real price
    // feed; a normal quiet trading window mis-reported stale and
    // refused live writes. `reconciliation_dead` (already tested
    // above) covers the WS-truly-disconnected safety property.
    it("live mode does NOT block on stale market data anymore (round-6b)", () => {
        const out = checkTradingHealth({
            ...base,
            marketDataAgeMs: 999_999_999,
            liveFreshnessCapMs: 30_000,
            mode: "live",
        });
        expect(out.healthy).toBe(true);
    });

    it("shadow mode reports issues but flags bypassed=true", () => {
        const out = checkTradingHealth({
            ...base,
            riskAuditWroteOk: false,
            mode: "shadow",
        });
        expect(out.healthy).toBe(false);
        if (!out.healthy) {
            expect(out.bypassed).toBe(true);
        }
    });

    it("null risk-audit (no sink configured) blocks live", () => {
        const out = checkTradingHealth({
            ...base,
            riskAuditWroteOk: null,
            mode: "live",
        });
        expect(out.healthy).toBe(false);
        if (!out.healthy) {
            expect(out.reasons).toContain("no_audit_sink_configured");
        }
    });

    it("aggregates multiple reasons (audit + reconciliation)", () => {
        const out = checkTradingHealth({
            riskAuditWroteOk: false,
            reconciliationHealthy: false,
            mode: "live",
        });
        expect(out.healthy).toBe(false);
        if (!out.healthy) {
            expect(out.reasons).toEqual(
                expect.arrayContaining([
                    "risk_audit_sink_dead",
                    "reconciliation_dead",
                ]),
            );
            expect(out.reasons).not.toContain("market_data_stale");
        }
    });

    // Round-6b — the QA report showed a brand-new create_order on a
    // healthy WS being refused with "Market data too stale". Root cause:
    // the freshness sample was anchored on user-order transitions, not
    // on a real price feed, so a quiet trading window was indistinguishable
    // from a WS disconnect. The reason was removed; the WS-actually-dead
    // case is covered by `reconciliation_dead`.
    describe("round-6b: market_data_stale reason is gone", () => {
        it("create_order with VERY stale 'market data' is healthy when other deps are up", () => {
            const out = checkTradingHealth({
                ...base,
                action: "create_order",
                marketDataAgeMs: 999_999_999,
                liveFreshnessCapMs: 30_000,
                mode: "live",
            });
            expect(out.healthy).toBe(true);
        });

        it("amend_order with stale 'market data' is healthy when other deps are up", () => {
            const out = checkTradingHealth({
                ...base,
                action: "amend_order",
                marketDataAgeMs: 999_999_999,
                liveFreshnessCapMs: 30_000,
                mode: "live",
            });
            expect(out.healthy).toBe(true);
        });

        it("cancel_order with stale 'market data' is healthy when other deps are up", () => {
            const out = checkTradingHealth({
                ...base,
                action: "cancel_order",
                marketDataAgeMs: 999_999_999,
                liveFreshnessCapMs: 30_000,
                mode: "live",
            });
            expect(out.healthy).toBe(true);
        });

        it("reconciliation_dead still blocks live writes regardless of action", () => {
            const out = checkTradingHealth({
                ...base,
                action: "create_order",
                reconciliationHealthy: false,
                mode: "live",
            });
            expect(out.healthy).toBe(false);
            if (!out.healthy) {
                expect(out.reasons).toContain("reconciliation_dead");
            }
        });

        it("never returns the market_data_stale reason for any input shape", () => {
            for (const action of ["create_order", "amend_order", "cancel_order", undefined]) {
                const out = checkTradingHealth({
                    riskAuditWroteOk: false,
                    reconciliationHealthy: false,
                    marketDataAgeMs: 999_999_999,
                    liveFreshnessCapMs: 30_000,
                    mode: "live",
                    action,
                });
                if (out.healthy === false) {
                    expect(out.reasons).not.toContain("market_data_stale");
                }
            }
        });
    });
});
