/**
 * §6.1 — risk audit persistence + fail-closed propagation.
 *
 * Asserts:
 *  - When a risk-audit sink is wired and writes succeed, `audit_wrote_ok=true`.
 *  - When the sink THROWS, `audit_wrote_ok=false` AND the verdict is still
 *    returned (the dep-health gate is responsible for refusing the live
 *    write, not the audit sink itself).
 *  - When NO sink is wired, `audit_wrote_ok=null` (paper / test path).
 *  - The persisted record carries the canonical (request_id, intent_hash,
 *    client_order_id, userId, venue, symbol, side, mode, decision) fields
 *    needed for the §6.7 replay timeline.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCanonicalIntent } from "../../src/intent/intentBuilder";
import { buildRiskDecisionRecord } from "../../src/risk/auditLog";
import { evaluate } from "../../src/risk/riskEngine";
import { setRiskAuditSink } from "../../src/safety/auditSinkRegistry";
import { DEFAULT_USER_TRADING_PREFERENCES } from "../../src/risk/types";
import { cexPlugin } from "../../src/index";

function makeRiskInput() {
    return {
        action: "create_order",
        venue: "binance",
        userId: "user-1",
        locale: "en" as const,
        mode: "live" as const,
        params: {
            userId: "user-1",
            product_id: "BTC-USDT",
            symbol: "BTC-USDT",
            side: "BUY",
            order_configuration: { market_market_ioc: { base_size: "0.01" } },
        },
    };
}

describe("§6.1 risk_decisions persistence + fail-closed propagation", () => {
    afterEach(() => {
        setRiskAuditSink(null);
    });

    it("returns audit_wrote_ok=null when no sink is wired", async () => {
        setRiskAuditSink(null);
        const provider = (cexPlugin as unknown as {
            cexSpecProvider: {
                runRiskPrecheck: (i: ReturnType<typeof makeRiskInput>) => Promise<{
                    verdict: string;
                    audit_wrote_ok?: boolean | null;
                } | null>;
            };
        }).cexSpecProvider;
        const out = await provider.runRiskPrecheck(makeRiskInput());
        expect(out?.audit_wrote_ok).toBeNull();
    });

    it("returns audit_wrote_ok=true when the sink succeeds", async () => {
        const written: Record<string, unknown>[] = [];
        setRiskAuditSink({
            async writeDecision(rec) {
                written.push(rec as unknown as Record<string, unknown>);
            },
        });
        const provider = (cexPlugin as unknown as {
            cexSpecProvider: {
                runRiskPrecheck: (i: ReturnType<typeof makeRiskInput>) => Promise<{
                    verdict: string;
                    audit_wrote_ok?: boolean | null;
                } | null>;
            };
        }).cexSpecProvider;
        const out = await provider.runRiskPrecheck(makeRiskInput());
        expect(out?.audit_wrote_ok).toBe(true);
        expect(written.length).toBe(1);
    });

    it("returns audit_wrote_ok=false when the sink throws", async () => {
        setRiskAuditSink({
            async writeDecision() {
                throw new Error("mongo down");
            },
        });
        const provider = (cexPlugin as unknown as {
            cexSpecProvider: {
                runRiskPrecheck: (i: ReturnType<typeof makeRiskInput>) => Promise<{
                    verdict: string;
                    audit_wrote_ok?: boolean | null;
                } | null>;
            };
        }).cexSpecProvider;
        const out = await provider.runRiskPrecheck(makeRiskInput());
        expect(out?.audit_wrote_ok).toBe(false);
        // The verdict still propagates (the dep-health gate is the
        // explicit fail-closed surface, not the audit sink).
        expect(out?.verdict).toBeDefined();
    });

    it("persists every canonical join field for replay", () => {
        const intent = buildCanonicalIntent(makeRiskInput() as never);
        const preferences = {
            userId: "user-1",
            ...DEFAULT_USER_TRADING_PREFERENCES,
            updatedAt: new Date().toISOString(),
        } as never;
        const decision = evaluate(intent, { preferences });
        const record = buildRiskDecisionRecord(intent, decision);

        // §6.7 replay timeline requires every join field on every row.
        expect(record.request_id).toBeDefined();
        expect(record.intent_hash).toBeDefined();
        expect(record.client_order_id).toBeDefined();
        expect(record.userId).toBe("user-1");
        expect(record.venue).toBe("binance");
        expect(record.symbol).toBe("BTC-USDT");
        expect(record.side).toBe("BUY");
        expect(record.mode).toBe("live");
        expect(record.decision).toBe(decision.verdict);
    });
});
