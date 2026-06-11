/**
 * Normalize hourly senti-score CSV rows to a single in-memory shape used by
 * combine.ts and S3 cache files.
 */

export interface SentiScoreNormalized {
    time: number;
    value: number;
    strongly_negative: number;
    moderately_negative: number;
    mildly_negative: number;
    neutral: number;
    mildly_positive: number;
    moderately_positive: number;
    strongly_positive: number;
    negative: number;
    positive: number;
    total: number;
    expected_negative: number;
    importance: number;
}

export type SentiScoreRowFormat = "count" | "precomputed" | "seven_category";

/** Distinct columns from the 2026-04+ 7-label hourly aggregate (see sentiment-score/legacy_output.py). */
const SEVEN_CATEGORY_MARKERS = [
    "strongly_negative",
    "moderately_negative",
    "mildly_negative",
    "mildly_positive",
    "moderately_positive",
    "strongly_positive",
] as const;

const PRECOMPUTED_KEY_CANDIDATES = [
    "value",
    "sentiment",
    "sentiscore",
    "score",
] as const;

function lowerKeyMap(row: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) {
        out[String(k).trim().toLowerCase()] = String(v ?? "").trim();
    }
    return out;
}

/**
 * Infer CSV row family from the first data row's column names.
 */
export function inferSentiScoreRowFormat(firstRow: Record<string, unknown>): SentiScoreRowFormat {
    const keys = Object.keys(firstRow).map((k) => k.trim().toLowerCase());
    const keySet = new Set(keys);
    if (SEVEN_CATEGORY_MARKERS.some((m) => keySet.has(m))) {
        return "seven_category";
    }
    if (PRECOMPUTED_KEY_CANDIDATES.some((pk) => keys.includes(pk))) {
        return "precomputed";
    }
    return "count";
}

/** Fallback formula when expected_positive is absent. Matches LABEL_TO_NORMALIZED in legacy_output.py. */
function sentimentValueFromSevenCategoryCounts(
    stronglyNegative: number,
    moderatelyNegative: number,
    mildlyNegative: number,
    neutral: number,
    mildlyPositive: number,
    moderatelyPositive: number,
    stronglyPositive: number,
    total: number
): number {
    if (total <= 0) return 0;
    const weighted =
        -1 * stronglyNegative +
        (-2 / 3) * moderatelyNegative +
        (-1 / 3) * mildlyNegative +
        0 * neutral +
        (1 / 3) * mildlyPositive +
        (2 / 3) * moderatelyPositive +
        1 * stronglyPositive;
    return weighted / total;
}

function parseUnixSeconds(low: Record<string, string>): number | null {
    for (const col of ["time", "ts", "timestamp"]) {
        const raw = low[col];
        if (raw === undefined || raw === "") continue;
        const n = Number(raw);
        if (!Number.isFinite(n)) continue;
        if (n > 1e12) return Math.floor(n / 1000);
        return Math.floor(n);
    }
    return null;
}

/** Match sentiscoreFetcher.ts — UTC calendar date + clock time. */
export function parseDateHourUtc(dateStr: string, hourStr: string): number | null {
    try {
        const [year, month, day] = dateStr.split("-").map(Number);
        const [hour, minute] = hourStr.split(":").map(Number);
        if (
            !Number.isFinite(year) ||
            !Number.isFinite(month) ||
            !Number.isFinite(day)
        ) {
            return null;
        }
        const ts = Date.UTC(
            year,
            month - 1,
            day,
            Number.isFinite(hour) ? hour : 0,
            Number.isFinite(minute) ? minute : 0,
            0,
            0
        );
        return Math.floor(ts / 1000);
    } catch {
        return null;
    }
}

function parsePrecomputedScore(raw: string): number {
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) return 0;
    if (Math.abs(n) <= 1) return n;
    if (Math.abs(n) <= 100) return Math.max(-1, Math.min(1, n / 100));
    return Math.max(-1, Math.min(1, n));
}

function pickPrecomputedRaw(low: Record<string, string>): string {
    for (const k of PRECOMPUTED_KEY_CANDIDATES) {
        const v = low[k];
        if (v !== undefined && v !== "") return v;
    }
    return "";
}

/**
 * Convert one CSV row object to a normalized score, or null if the row is unusable.
 */
export function normalizeSentiScoreCsvRow(
    row: Record<string, unknown>,
    format: SentiScoreRowFormat,
    sourceLabel: string
): SentiScoreNormalized | null {
    const low = lowerKeyMap(row);

    let time = parseUnixSeconds(low);
    if (time === null) {
        const d = low.date;
        const h = low.hour;
        if (!d || !h) {
            console.warn(
                `[${sourceLabel}] Skipping row: no unix timestamp and no date/hour`,
                row
            );
            return null;
        }
        time = parseDateHourUtc(d, h);
    }

    if (time === null || !Number.isFinite(time)) {
        console.warn(`[${sourceLabel}] Skipping row: invalid time`, row);
        return null;
    }

    if (format === "seven_category") {
        const stronglyNegative =
            Number.parseFloat(low.strongly_negative || "0") || 0;
        const moderatelyNegative =
            Number.parseFloat(low.moderately_negative || "0") || 0;
        const mildlyNegative =
            Number.parseFloat(low.mildly_negative || "0") || 0;
        const neutralCat = Number.parseFloat(low.neutral || "0") || 0;
        const mildlyPositive =
            Number.parseFloat(low.mildly_positive || "0") || 0;
        const moderatelyPositive =
            Number.parseFloat(low.moderately_positive || "0") || 0;
        const stronglyPositive =
            Number.parseFloat(low.strongly_positive || "0") || 0;

        let total = Number.parseFloat(low.total || "0") || 0;
        const sumParts =
            stronglyNegative +
            moderatelyNegative +
            mildlyNegative +
            neutralCat +
            mildlyPositive +
            moderatelyPositive +
            stronglyPositive;
        if (total <= 0 && sumParts > 0) {
            total = sumParts;
        }

        const coarseNegative =
            stronglyNegative + moderatelyNegative + mildlyNegative;
        const coarsePositive =
            mildlyPositive + moderatelyPositive + stronglyPositive;

        const expRaw = low.expected_positive;
        let value: number;
        if (expRaw !== undefined && expRaw !== "") {
            const parsed = Number.parseFloat(expRaw);
            value = Number.isFinite(parsed)
                ? parsed
                : sentimentValueFromSevenCategoryCounts(
                      stronglyNegative,
                      moderatelyNegative,
                      mildlyNegative,
                      neutralCat,
                      mildlyPositive,
                      moderatelyPositive,
                      stronglyPositive,
                      total > 0 ? total : sumParts
                  );
        } else {
            value = sentimentValueFromSevenCategoryCounts(
                stronglyNegative,
                moderatelyNegative,
                mildlyNegative,
                neutralCat,
                mildlyPositive,
                moderatelyPositive,
                stronglyPositive,
                total > 0 ? total : sumParts
            );
        }
        value = Math.max(-1, Math.min(1, value));

        const totalOut =
            total > 0 ? total : sumParts > 0 ? sumParts : 1;

        const importance = Number.parseFloat(low.importance || "0") || 0;

        return {
            time,
            value,
            strongly_negative: stronglyNegative,
            moderately_negative: moderatelyNegative,
            mildly_negative: mildlyNegative,
            neutral: neutralCat,
            mildly_positive: mildlyPositive,
            moderately_positive: moderatelyPositive,
            strongly_positive: stronglyPositive,
            negative: coarseNegative,
            positive: coarsePositive,
            total: totalOut,
            expected_negative: 0,
            importance,
        };
    }

    const negative = Number.parseFloat(low.negative || "0") || 0;
    const neutral = Number.parseFloat(low.neutral || "0") || 0;
    const positive = Number.parseFloat(low.positive || "0") || 0;
    let total = Number.parseFloat(low.total || "0") || 0;
    const expected_negative =
        Number.parseFloat(low.expected_negative || "0") || 0;

    let value = 0;

    if (format === "precomputed") {
        const rawScore = pickPrecomputedRaw(low);
        value = parsePrecomputedScore(rawScore);
        if (total <= 0) {
            const sum = negative + neutral + positive;
            total = sum > 0 ? sum : 1;
        }
    } else {
        if (total <= 0) {
            const sum = negative + neutral + positive;
            if (sum > 0) total = sum;
        }
        value = total > 0 ? (positive - negative) / total : 0;
    }

    const importance = Number.parseFloat(low.importance || "0") || 0;

    return {
        time,
        value,
        strongly_negative: 0,
        moderately_negative: 0,
        mildly_negative: 0,
        neutral,
        mildly_positive: 0,
        moderately_positive: 0,
        strongly_positive: 0,
        negative,
        positive,
        total,
        expected_negative,
        importance,
    };
}

/**
 * Parse all rows from a CSV using one format sniff on the first row.
 */
export function normalizeSentiScoreCsvRows(
    rows: Record<string, unknown>[],
    sourceLabel: string
): SentiScoreNormalized[] {
    if (rows.length === 0) return [];
    const format = inferSentiScoreRowFormat(rows[0]);
    const out: SentiScoreNormalized[] = [];
    for (const row of rows) {
        const n = normalizeSentiScoreCsvRow(row, format, sourceLabel);
        if (n) out.push(n);
    }
    return out;
}
