import { describe, expect, it } from "vitest";
import {
    parseTradingLogLine,
    extractRiskDecision,
    matchesRequestFilter,
    normalizeRiskDecision,
    riskDecisionsMatch,
    assignOrphanEventsByTimestamp,
    filterEventsByTimeWindow,
} from "../lib/cw-trading-parser.mjs";

describe("cw-trading-parser", () => {
    it("parses [Trading] JSON from log line", () => {
        const line =
            '2026-01-01 info [Trading] {"stage":"risk_check","request_id":"abc","decision":"allow"}';
        const ev = parseTradingLogLine(line);
        expect(ev).toMatchObject({
            stage: "risk_check",
            request_id: "abc",
            decision: "allow",
        });
    });

    it("parses [Trading] JSON from ANSI-colored ECS log lines", () => {
        const line =
            '[2026-06-05 18:37:10] \u001b[32mINFO\u001b[39m: \u001b[36m[Trading] {"stage":"risk_check","request_id":"abc","decision":"allow"}\u001b[39m';
        const ev = parseTradingLogLine(line);
        expect(ev).toMatchObject({
            stage: "risk_check",
            request_id: "abc",
            decision: "allow",
        });
    });

    it("normalizes block to deny for risk comparisons", () => {
        expect(normalizeRiskDecision("block")).toBe("deny");
        expect(riskDecisionsMatch("block", "deny")).toBe(true);
    });

    it("extracts normalized risk decision from events", () => {
        const d = extractRiskDecision([
            { stage: "preprocess" },
            { stage: "risk_check", decision: "block" },
        ]);
        expect(d).toBe("deny");
    });

    it("filters by request_id set and includes orphan events", () => {
        const ids = new Set(["x"]);
        expect(matchesRequestFilter({ request_id: "x" }, ids)).toBe(true);
        expect(matchesRequestFilter({ request_id: "y" }, ids)).toBe(false);
        expect(matchesRequestFilter({}, ids)).toBe(true);
        expect(matchesRequestFilter({ requestId: "y" }, null)).toBe(true);
    });

    it("assigns orphan events to cases by timestamp window", () => {
        const orphans = [
            { stage: "risk_check", decision: "block", _cwTimestamp: 1_050 },
        ];
        const perCase = new Map([["risk-case", []]]);
        const summaries = [
            {
                id: "risk-case",
                startedAtMs: 1_000,
                endedAtMs: 1_100,
            },
        ];
        assignOrphanEventsByTimestamp(orphans, perCase, summaries);
        expect(perCase.get("risk-case")).toHaveLength(1);
    });

    it("filters events by case time window", () => {
        const events = [
            { _cwTimestamp: 900 },
            { _cwTimestamp: 1_050 },
            { _cwTimestamp: 1_500 },
        ];
        const filtered = filterEventsByTimeWindow(events, {
            startedAtMs: 1_000,
            endedAtMs: 1_100,
            bufferBeforeMs: 0,
            bufferAfterMs: 0,
        });
        expect(filtered).toHaveLength(1);
        expect(filtered[0]._cwTimestamp).toBe(1_050);
    });
});
