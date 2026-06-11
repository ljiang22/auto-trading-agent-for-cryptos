import { describe, expect, it } from "vitest";
import {
    inferSentiScoreRowFormat,
    normalizeSentiScoreCsvRow,
    normalizeSentiScoreCsvRows,
    parseDateHourUtc,
} from "../src/utils/normalizeSentiScoreRow.ts";

describe("parseDateHourUtc", () => {
    it("matches UTC epoch for a sample row", () => {
        const ts = parseDateHourUtc("2025-01-15", "14:30");
        expect(ts).toBe(
            Math.floor(Date.UTC(2025, 0, 15, 14, 30, 0, 0) / 1000)
        );
    });
});

describe("inferSentiScoreRowFormat", () => {
    it("detects seven_category hourly schema from AWS (legacy_output HOURLY_COLUMNS)", () => {
        expect(
            inferSentiScoreRowFormat({
                date: "2026-04-25",
                hour: "14:00:00",
                strongly_negative: "1",
                moderately_negative: "0",
                mildly_negative: "0",
                neutral: "2",
                mildly_positive: "1",
                moderately_positive: "0",
                strongly_positive: "0",
                total: "4",
                expected_positive: "0.25",
            })
        ).toBe("seven_category");
    });

    it("detects precomputed when a score column exists", () => {
        expect(
            inferSentiScoreRowFormat({
                date: "x",
                hour: "y",
                sentiment: "0.5",
            })
        ).toBe("precomputed");
    });

    it("defaults to count-based", () => {
        expect(
            inferSentiScoreRowFormat({
                date: "x",
                hour: "y",
                positive: "1",
                negative: "0",
                total: "1",
            })
        ).toBe("count");
    });
});

describe("normalizeSentiScoreCsvRow", () => {
    it("seven_category: uses expected_positive as value (matches pipeline aggregate)", () => {
        const row = {
            date: "2026-04-25",
            hour: "14:00:00",
            strongly_negative: "0",
            moderately_negative: "2",
            mildly_negative: "0",
            neutral: "0",
            mildly_positive: "0",
            moderately_positive: "0",
            strongly_positive: "0",
            total: "2",
            expected_positive: "-0.666667",
        };
        const n = normalizeSentiScoreCsvRow(row, "seven_category", "test");
        expect(n).not.toBeNull();
        expect(n!.value).toBeCloseTo(-2 / 3, 3);
        expect(n!.negative).toBe(2);
        expect(n!.positive).toBe(0);
    });

    it("seven_category: recomputes value when expected_positive missing", () => {
        const row = {
            date: "2026-04-25",
            hour: "10:00:00",
            strongly_negative: "0",
            moderately_negative: "0",
            mildly_negative: "0",
            neutral: "0",
            mildly_positive: "0",
            moderately_positive: "0",
            strongly_positive: "3",
            total: "3",
        };
        const n = normalizeSentiScoreCsvRow(row, "seven_category", "test");
        expect(n!.value).toBeCloseTo(1.0, 5);
    });

    it("Format A: derives value from counts", () => {
        const row = {
            date: "2025-01-15",
            hour: "10:00",
            positive: "30",
            negative: "10",
            neutral: "10",
            total: "50",
            expected_negative: "0",
        };
        const n = normalizeSentiScoreCsvRow(row, "count", "test");
        expect(n).not.toBeNull();
        expect(n!.value).toBeCloseTo(0.4);
        expect(n!.time).toBe(parseDateHourUtc("2025-01-15", "10:00"));
    });

    it("Format B: uses precomputed score and fills total", () => {
        const row = {
            date: "2025-01-15",
            hour: "10:00",
            sentiment: "0.25",
        };
        const n = normalizeSentiScoreCsvRow(row, "precomputed", "test");
        expect(n!.value).toBeCloseTo(0.25);
        expect(n!.total).toBe(1);
    });

    it("supports unix time column in seconds", () => {
        const ts = 1700000000;
        const row = {
            time: String(ts),
            positive: "10",
            negative: "10",
            neutral: "0",
            total: "20",
        };
        const n = normalizeSentiScoreCsvRow(row, "count", "test");
        expect(n!.time).toBe(ts);
        expect(n!.value).toBe(0);
    });

    it("supports unix time column in milliseconds", () => {
        const sec = 1700000000;
        const row = {
            timestamp: String(sec * 1000),
            value: "0.5",
        };
        const n = normalizeSentiScoreCsvRow(row, "precomputed", "test");
        expect(n!.time).toBe(sec);
        expect(n!.value).toBeCloseTo(0.5);
    });
});

describe("normalizeSentiScoreCsvRows", () => {
    it("sniffs format from first row", () => {
        const rows = [
            { time: "1700000000", sentiment: "-0.2" },
            { time: "1700003600", sentiment: "0.1" },
        ];
        const out = normalizeSentiScoreCsvRows(rows, "batch");
        expect(out.length).toBe(2);
        expect(out[0].value).toBeCloseTo(-0.2);
    });
});

// ─── Value-range contract ────────────────────────────────────────────────────
// All normalized values must remain in [-1, 1].
// Downstream consumers (chart y-axis, BULLISH/BEARISH thresholds) are tuned for this range.
describe("value-range invariant: output is always in [-1, 1]", () => {
    const baseRow = {
        date: "2026-05-01",
        hour: "12:00:00",
        strongly_negative: "0",
        moderately_negative: "0",
        mildly_negative: "0",
        neutral: "0",
        mildly_positive: "0",
        moderately_positive: "0",
        strongly_positive: "0",
        total: "0",
    };

    it("seven_category: extreme expected_positive > 1 is clamped to 1", () => {
        const row = { ...baseRow, strongly_positive: "100", total: "100", expected_positive: "5.0" };
        const n = normalizeSentiScoreCsvRow(row, "seven_category", "test");
        expect(n!.value).toBeLessThanOrEqual(1);
        expect(n!.value).toBeGreaterThanOrEqual(-1);
    });

    it("seven_category: extreme expected_positive < -1 is clamped to -1", () => {
        const row = { ...baseRow, strongly_negative: "100", total: "100", expected_positive: "-5.0" };
        const n = normalizeSentiScoreCsvRow(row, "seven_category", "test");
        expect(n!.value).toBeLessThanOrEqual(1);
        expect(n!.value).toBeGreaterThanOrEqual(-1);
    });

    it("seven_category: weighted formula stays in [-1,1] when no expected_positive", () => {
        // pure strongly_positive → should be exactly 1
        const row = { ...baseRow, strongly_positive: "10", total: "10" };
        const n = normalizeSentiScoreCsvRow(row, "seven_category", "test");
        expect(n!.value).toBeCloseTo(1.0, 5);
        expect(n!.value).toBeLessThanOrEqual(1);
    });

    it("seven_category: mixed categories produce value in [-1, 1]", () => {
        const row = {
            ...baseRow,
            strongly_negative: "3",
            moderately_negative: "2",
            mildly_negative: "1",
            neutral: "4",
            mildly_positive: "2",
            moderately_positive: "3",
            strongly_positive: "5",
            total: "20",
            expected_positive: "0.3",
        };
        const n = normalizeSentiScoreCsvRow(row, "seven_category", "test");
        expect(n!.value).toBeLessThanOrEqual(1);
        expect(n!.value).toBeGreaterThanOrEqual(-1);
    });

    it("count format: (positive - negative) / total stays in [-1, 1]", () => {
        const row = { date: "2026-05-01", hour: "12:00:00", positive: "50", negative: "50", neutral: "0", total: "100" };
        const n = normalizeSentiScoreCsvRow(row, "count", "test");
        expect(n!.value).toBe(0);
        expect(n!.value).toBeLessThanOrEqual(1);
        expect(n!.value).toBeGreaterThanOrEqual(-1);
    });

    it("precomputed: percentage-scale (0-100) input is normalised to [-1,1]", () => {
        const row = { date: "2026-05-01", hour: "12:00:00", value: "75" };
        const n = normalizeSentiScoreCsvRow(row, "precomputed", "test");
        expect(n!.value).toBeLessThanOrEqual(1);
        expect(n!.value).toBeGreaterThanOrEqual(-1);
    });
});
