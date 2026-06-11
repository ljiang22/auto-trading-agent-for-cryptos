/**
 * Helpers for crypto_news CSVs on S3 (sentiscore bucket, default sentiscoredata-new):
 * - Article-level: original_score/.../scored_*.csv (title, canonical_link, score, ...)
 * - Hourly aggregates: hourly_score/.../processed_scored_*.csv
 *
 * Seven-category pooled sentiment → [-1, 1] follows the same weighted mean as
 * `plugin-sentiscore` normalizeSentiScoreRow.ts (aggregate_hourly / LABEL_TO_NORMALIZED).
 */

export type NewsItemShape = {
    [key: string]: string | number;
};

const CLAMP_NEG1_POS1 = (v: number) => Math.max(-1, Math.min(1, v));

function keySet(row: Record<string, unknown>): Set<string> {
    return new Set(
        Object.keys(row || {}).map((k) => k.trim().toLowerCase())
    );
}

function lowerStringMap(row: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) {
        out[k.trim().toLowerCase()] = String(v ?? '').trim();
    }
    return out;
}

function parseFloatSafe(raw: string | undefined, fallback = 0): number {
    if (raw === undefined || raw === '') {
        return fallback;
    }
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * Maps per-article counts in 7 buckets to a single value in [-1, 1].
 * Keep in sync with `sentimentValueFromSevenCategoryCounts` in normalizeSentiScoreRow.ts.
 */
export function sentimentValueFromSevenCategoryCounts(
    stronglyNegative: number,
    moderatelyNegative: number,
    mildlyNegative: number,
    neutral: number,
    mildlyPositive: number,
    moderatelyPositive: number,
    stronglyPositive: number,
    total: number
): number {
    if (total <= 0) {
        return 0;
    }
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

function hasSevenCategoryColumns(keys: Set<string>): boolean {
    return (
        keys.has('strongly_negative') &&
        keys.has('moderately_negative') &&
        keys.has('mildly_negative') &&
        keys.has('neutral') &&
        keys.has('mildly_positive') &&
        keys.has('moderately_positive') &&
        keys.has('strongly_positive')
    );
}

/**
 * Normalize one 7-label hourly (or pooled) CSV row to [-1, 1].
 * Mirrors `normalizeSentiScoreCsvRow` seven_category branch: valid `expected_positive`
 * overrides; otherwise derive from weighted category counts.
 */
export function normalizedSentimentFromSevenCategoryRow(
    low: Record<string, string>
): number {
    const stronglyNegative = parseFloatSafe(low.strongly_negative);
    const moderatelyNegative = parseFloatSafe(low.moderately_negative);
    const mildlyNegative = parseFloatSafe(low.mildly_negative);
    const neutralCat = parseFloatSafe(low.neutral);
    const mildlyPositive = parseFloatSafe(low.mildly_positive);
    const moderatelyPositive = parseFloatSafe(low.moderately_positive);
    const stronglyPositive = parseFloatSafe(low.strongly_positive);

    let total = parseFloatSafe(low.total);
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

    const denom = total > 0 ? total : sumParts > 0 ? sumParts : 0;
    const fromCounts =
        denom > 0
            ? sentimentValueFromSevenCategoryCounts(
                  stronglyNegative,
                  moderatelyNegative,
                  mildlyNegative,
                  neutralCat,
                  mildlyPositive,
                  moderatelyPositive,
                  stronglyPositive,
                  denom
              )
            : 0;

    const expRaw = low.expected_positive;
    if (expRaw !== undefined && expRaw !== '') {
        const parsed = Number.parseFloat(expRaw);
        if (Number.isFinite(parsed)) {
            return CLAMP_NEG1_POS1(parsed);
        }
    }
    return CLAMP_NEG1_POS1(fromCounts);
}

/**
 * Legacy hourly rows with negative / neutral / positive counts.
 * Prefer `expected_positive` when valid (matches pipeline output); else (pos − neg) / total.
 */
export function normalizedSentimentFromLegacyPolarityRow(
    low: Record<string, string>
): number {
    const negative = parseFloatSafe(low.negative);
    const neutral = parseFloatSafe(low.neutral);
    const positive = parseFloatSafe(low.positive);
    let total = parseFloatSafe(low.total);
    if (total <= 0) {
        const sum = negative + neutral + positive;
        if (sum > 0) {
            total = sum;
        }
    }
    const fromCounts = total > 0 ? (positive - negative) / total : 0;

    const expRaw = low.expected_positive;
    if (expRaw !== undefined && expRaw !== '') {
        const parsed = Number.parseFloat(expRaw);
        if (Number.isFinite(parsed)) {
            return CLAMP_NEG1_POS1(parsed);
        }
    }
    return CLAMP_NEG1_POS1(fromCounts);
}

/** Match parsePrecomputedScore in normalizeSentiScoreRow.ts for scalar score fields. */
function parseFlexibleScore(raw: string): number {
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) {
        return 0;
    }
    if (Math.abs(n) <= 1) {
        return CLAMP_NEG1_POS1(n);
    }
    if (Math.abs(n) <= 100) {
        return CLAMP_NEG1_POS1(n / 100);
    }
    return CLAMP_NEG1_POS1(n);
}

const ARTICLE_SCORE_KEYS = [
    'score',
    'sentiment',
    'sentiscore',
    'value',
    'expected_positive',
] as const;

/**
 * Single news article row: use 7-bucket counts when all present; else first usable score column.
 */
export function deriveArticleNormalizedSentiment(
    row: Record<string, unknown>
): number | undefined {
    const keys = keySet(row);
    const low = lowerStringMap(row);

    if (hasSevenCategoryColumns(keys)) {
        return normalizedSentimentFromSevenCategoryRow(low);
    }

    for (const k of ARTICLE_SCORE_KEYS) {
        const raw = low[k];
        if (raw === undefined || raw === '') {
            continue;
        }
        return parseFlexibleScore(raw);
    }
    return undefined;
}

/**
 * Tell article-level news CSVs apart from hourly rollup CSVs.
 */
export function sniffNewsCsvKind(
    firstRow: Record<string, unknown>
): 'article' | 'hourly' | 'unknown' {
    const keys = keySet(firstRow);
    if (keys.has('date') && keys.has('hour')) {
        if (
            keys.has('total') ||
            keys.has('strongly_negative') ||
            (keys.has('negative') &&
                keys.has('neutral') &&
                keys.has('positive'))
        ) {
            return 'hourly';
        }
    }
    if (keys.has('title') && keys.has('canonical_link')) {
        return 'article';
    }
    if (
        keys.has('title') &&
        (keys.has('summary') ||
            keys.has('published') ||
            keys.has('date_publish'))
    ) {
        return 'article';
    }
    return 'unknown';
}

/**
 * Map hourly aggregate CSV rows into pseudo news items for the same formatter as article rows.
 */
export function hourlyCsvRowsToNewsItems(
    rows: Record<string, unknown>[],
    symbol: string,
    sourceCalendarDate: string
): NewsItemShape[] {
    const upper = symbol.toUpperCase();
    const out: NewsItemShape[] = [];
    for (const raw of rows) {
        const low = lowerStringMap(raw);
        const date = low.date || sourceCalendarDate;
        const hourRaw = low.hour || '';
        const total = parseFloatSafe(low.total);
        const keys = keySet(raw);

        const normalized = hasSevenCategoryColumns(keys)
            ? normalizedSentimentFromSevenCategoryRow(low)
            : normalizedSentimentFromLegacyPolarityRow(low);

        let countsPart: string;
        if (keys.has('strongly_negative')) {
            countsPart = [
                `SN=${low.strongly_negative}`,
                `MN=${low.moderately_negative}`,
                `mN=${low.mildly_negative}`,
                `Neu=${low.neutral}`,
                `mP=${low.mildly_positive}`,
                `MP=${low.moderately_positive}`,
                `SP=${low.strongly_positive}`,
            ].join(', ');
        } else {
            countsPart = `neg=${low.negative}, neu=${low.neutral}, pos=${low.positive}`;
            if (
                low.expected_negative !== undefined &&
                low.expected_negative !== ''
            ) {
                countsPart += `, exp_neg=${low.expected_negative}`;
            }
        }

        out.push({
            title: `${upper} hourly news sentiment (${date} ${hourRaw})`,
            summary: `Aggregated ${total} articles; normalized sentiment (–1…1): ${normalized.toFixed(
                4
            )} (seven-category weighted mean where applicable). Counts: ${countsPart}.`,
            canonical_link: '',
            published: `${date} ${hourRaw}`.trim(),
            date_publish: date,
            source_date: sourceCalendarDate,
            sentiment_normalized: normalized,
        });
    }
    return out;
}
