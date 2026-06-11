import { describe, expect, it } from 'vitest';

import {
    deriveArticleNormalizedSentiment,
    hourlyCsvRowsToNewsItems,
    normalizedSentimentFromSevenCategoryRow,
    sentimentValueFromSevenCategoryCounts,
    sniffNewsCsvKind,
} from '../../src/utils/newsCsvFormat.ts';

describe('sniffNewsCsvKind', () => {
    it('detects article-level scored CSV rows', () => {
        expect(
            sniffNewsCsvKind({
                title: 'Bitcoin rises',
                canonical_link: 'https://example.com/a',
                summary: 'x',
            })
        ).toBe('article');
    });

    it('detects 7-category hourly aggregate rows', () => {
        expect(
            sniffNewsCsvKind({
                date: '2026-03-01',
                hour: '00:00:00',
                strongly_negative: '1',
                moderately_negative: '0',
                mildly_negative: '3',
                neutral: '3',
                mildly_positive: '1',
                moderately_positive: '1',
                strongly_positive: '0',
                total: '9',
                expected_positive: '-0.1',
            })
        ).toBe('hourly');
    });

    it('detects legacy 3-bin hourly aggregate rows', () => {
        expect(
            sniffNewsCsvKind({
                date: '2026-02-25',
                hour: '00:00:00',
                negative: '2',
                neutral: '1',
                positive: '8',
                total: '11',
                expected_positive: '0.5',
                expected_negative: '-0.5',
            })
        ).toBe('hourly');
    });

    it('returns unknown for empty-looking rows', () => {
        expect(sniffNewsCsvKind({ foo: 'bar' })).toBe('unknown');
    });
});

describe('sentimentValueFromSevenCategoryCounts', () => {
    it('matches pipeline weighting (one mild neg, one mod pos, rest neutral)', () => {
        const v = sentimentValueFromSevenCategoryCounts(0, 0, 1, 1, 0, 1, 0, 3);
        expect(v).toBeCloseTo((-1 / 3 + 2 / 3) / 3, 6);
    });
});

describe('normalizedSentimentFromSevenCategoryRow', () => {
    it('uses expected_positive when present (finishes pipeline contract)', () => {
        const v = normalizedSentimentFromSevenCategoryRow({
            strongly_negative: '0',
            moderately_negative: '0',
            mildly_negative: '0',
            neutral: '1',
            mildly_positive: '0',
            moderately_positive: '1',
            strongly_positive: '0',
            total: '2',
            expected_positive: '0.25',
        });
        expect(v).toBe(0.25);
    });

    it('derives from counts when expected_positive is absent', () => {
        const v = normalizedSentimentFromSevenCategoryRow({
            strongly_negative: '1',
            moderately_negative: '0',
            mildly_negative: '3',
            neutral: '3',
            mildly_positive: '1',
            moderately_positive: '1',
            strongly_positive: '0',
            total: '9',
        });
        expect(v).toBeCloseTo(-1 / 9, 6);
    });
});

describe('deriveArticleNormalizedSentiment', () => {
    it('reads article score column already in [-1,1]', () => {
        expect(
            deriveArticleNormalizedSentiment({ title: 'x', score: '-0.333333' })
        ).toBeCloseTo(-0.333333, 4);
    });
});

describe('hourlyCsvRowsToNewsItems', () => {
    it('maps legacy hourly rows into synthetic article-shaped items', () => {
        const rows = [
            {
                date: '2026-02-25',
                hour: '10:00:00',
                negative: '0',
                neutral: '0',
                positive: '1',
                total: '1',
                expected_positive: '1.0',
                expected_negative: '-1.0',
            },
        ];
        const out = hourlyCsvRowsToNewsItems(rows, 'BTC', '2026-02-25');
        expect(out).toHaveLength(1);
        expect(out[0].title).toContain('BTC');
        expect(out[0].summary).toContain('Aggregated');
        expect(out[0].published).toContain('2026-02-25');
        expect(out[0].sentiment_normalized).toBe(1);
    });

    it('maps 7-category hourly rows', () => {
        const rows = [
            {
                date: '2026-03-01',
                hour: '07:00:00',
                strongly_negative: '0',
                moderately_negative: '0',
                mildly_negative: '0',
                neutral: '1',
                mildly_positive: '0',
                moderately_positive: '1',
                strongly_positive: '0',
                total: '2',
                expected_positive: '0.3333333333333333',
            },
        ];
        const out = hourlyCsvRowsToNewsItems(rows, 'ETH', '2026-03-01');
        expect(out[0].title).toContain('ETH');
        expect(String(out[0].summary)).toMatch(/SN=/);
        expect(out[0].sentiment_normalized).toBeCloseTo(0.3333333333333333, 6);
    });
});
