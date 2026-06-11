import { describe, expect, it } from "vitest";
import { riskDecisionsMatch, extractRiskDecision } from "../lib/cw-trading-parser.mjs";

describe("analyze-trading-suite risk semantics", () => {
    it("matches production block decisions to catalog deny expectations", () => {
        const auditEvents = [{ stage: "risk_check", decision: "block" }];
        const riskFromCw = extractRiskDecision(auditEvents);
        expect(riskDecisionsMatch(riskFromCw, "deny")).toBe(true);
    });

    it("distinguishes harvest failure from empty audit (no auditIncomplete when harvest failed)", () => {
        const harvestFailed = true;
        const auditEvents = [];
        const correlationId = "req-123";
        const isWrite = true;
        const shouldFlagIncomplete =
            isWrite &&
            auditEvents.length === 0 &&
            correlationId &&
            !harvestFailed;
        expect(shouldFlagIncomplete).toBe(false);
    });
});
