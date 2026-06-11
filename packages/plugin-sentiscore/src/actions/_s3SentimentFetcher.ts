import { NextResponse } from 'next/server';
import {
    S3Client,
    ListObjectsV2Command,
    GetObjectCommand
} from '@aws-sdk/client-s3';
import csv from 'csvtojson';
import fs from 'fs';
import path from 'path';
import { mapWithConcurrency } from '../utils/mapWithConcurrency.ts';
import {
    normalizeSentiScoreCsvRows,
    type SentiScoreNormalized
} from '../utils/normalizeSentiScoreRow.ts';
import type { FetchFn } from './_sourceActionFactory.ts';

// One shared S3 client across all source fetchers
let _sharedS3: S3Client | null = null;

function getS3Client(): S3Client {
    if (!_sharedS3) {
        const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
        const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
        _sharedS3 = new S3Client({
            region: process.env.SENTISCORE_S3_REGION || 'us-east-2',
            ...(accessKeyId && secretAccessKey
                ? { credentials: { accessKeyId, secretAccessKey } }
                : {}),
        });
    }
    return _sharedS3;
}

const CACHE_DIR = path.join(process.cwd(), 'cache');
const LIST_CACHE_TTL_MS = 5 * 60 * 1000;
const DATE_FETCH_CONCURRENCY = 8;

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR);
}

async function streamToString(stream: ReadableStream): Promise<string> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream as any) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf-8');
}

interface SentimentScore {
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

interface ResponseData {
    dates: string[];
    symbol: string;
    fileCount: number;
    sentiScores: SentimentScore[];
    lastUpdated: string;
}

function normalizedToSentimentScore(n: SentiScoreNormalized): SentimentScore {
    return {
        time: n.time,
        value: n.value,
        strongly_negative: n.strongly_negative,
        moderately_negative: n.moderately_negative,
        mildly_negative: n.mildly_negative,
        neutral: n.neutral,
        mildly_positive: n.mildly_positive,
        moderately_positive: n.moderately_positive,
        strongly_positive: n.strongly_positive,
        negative: n.negative,
        positive: n.positive,
        total: n.total,
        expected_negative: n.expected_negative,
        importance: n.importance,
    };
}

const dateListCache = new Map<string, { dateStrings: string[]; expiresAt: number }>();

async function listDateStrings(s3: S3Client, bucketName: string, prefix: string): Promise<string[]> {
    const cacheKey = `${prefix}:${bucketName}`;
    const now = Date.now();
    const hit = dateListCache.get(cacheKey);
    if (hit && hit.expiresAt > now) return hit.dateStrings;

    const res = await s3.send(new ListObjectsV2Command({ Bucket: bucketName, Prefix: prefix, Delimiter: '/' }));
    const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d{4}-\\d{2}-\\d{2})\\/`);
    const dateStrings: string[] = [];
    for (const cp of res.CommonPrefixes ?? []) {
        const m = cp.Prefix?.match(re);
        if (m) dateStrings.push(m[1]);
    }
    dateListCache.set(cacheKey, { dateStrings, expiresAt: now + LIST_CACHE_TTL_MS });
    return dateStrings;
}

export interface S3FetcherConfig {
    /** S3 folder prefix including trailing slash, e.g. "X/" or "youtube/" */
    prefix: string;
    /** 'per-symbol' reads the symbol from params; 'all' always uses 'ALL' */
    symbolMode: 'per-symbol' | 'all';
}

export function makeS3SentimentFetcher(config: S3FetcherConfig): FetchFn {
    const { prefix, symbolMode } = config;
    const sourceName = prefix.replace(/\/$/, '');

    return async (_request: Request, { params }: { params: { symbol: string } }): Promise<Response> => {
        const upperSymbol = symbolMode === 'all' ? 'ALL' : params.symbol.toUpperCase();
        const cacheFile = path.join(CACHE_DIR, `sentiscore_${upperSymbol}_${sourceName}.json`);
        const sourceTag = `sentiscore/${sourceName}/${upperSymbol}`;

        try {
            const bucketName = process.env.SENTISCORE_S3_BUCKET || 'sentiscoredata-new';
            const s3 = getS3Client();
            const dateStrings = await listDateStrings(s3, bucketName, prefix);

            if (dateStrings.length === 0) {
                if (fs.existsSync(cacheFile)) {
                    return NextResponse.json(JSON.parse(fs.readFileSync(cacheFile, 'utf-8')));
                }
                return NextResponse.json(
                    { error: `No date subfolders found under ${prefix}` },
                    { status: 404 }
                );
            }

            const s3LatestDate = [...dateStrings].sort().at(-1)!;
            const allSentiScores: SentimentScore[] = [];
            const processedDates = new Set<string>();
            let cachedData: ResponseData | null = null;

            if (fs.existsSync(cacheFile)) {
                cachedData = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as ResponseData;
                if (Array.isArray(cachedData.sentiScores)) allSentiScores.push(...cachedData.sentiScores);
                if (Array.isArray(cachedData.dates)) cachedData.dates.forEach(d => processedDates.add(d));
            }

            const datesToProcess = dateStrings.filter(d => !processedDates.has(d));

            if (datesToProcess.length === 0 && cachedData) {
                return NextResponse.json(cachedData);
            }

            if (cachedData && datesToProcess.length > 0) {
                const cacheLatest = cachedData.dates?.length > 0 ? [...cachedData.dates].sort().at(-1) : '';
                console.log(
                    `[sentiscore ${sourceName}] Cache outdated for ${upperSymbol} (cache: ${cacheLatest}, S3: ${s3LatestDate}), fetching ${datesToProcess.length} missing date(s).`
                );
            }

            console.log(`Processing ${datesToProcess.length} dates for ${upperSymbol} (${sourceName} source)`);

            const results = await mapWithConcurrency(
                datesToProcess,
                DATE_FETCH_CONCURRENCY,
                async (date) => {
                    const hourlyPrefix = `${prefix}${date}/hourly_score/${upperSymbol}/`;
                    const listRes = await s3.send(new ListObjectsV2Command({ Bucket: bucketName, Prefix: hourlyPrefix }));
                    const csvObjects = listRes.Contents ?? [];

                    if (csvObjects.length === 0) {
                        console.log(`No files found for ${upperSymbol} on ${date} (${sourceName} source)`);
                        return { date, scores: [] as SentimentScore[], markDateProcessed: true };
                    }

                    const csvFiles = csvObjects.filter(o => o.Key?.endsWith('.csv'));
                    if (csvFiles.length === 0) {
                        console.log(`No CSV files found for ${upperSymbol} on ${date} (${sourceName} source)`);
                        return { date, scores: [] as SentimentScore[], markDateProcessed: false };
                    }

                    csvFiles.sort((a, b) => {
                        if (!a.LastModified || !b.LastModified) return 0;
                        return new Date(b.LastModified).getTime() - new Date(a.LastModified).getTime();
                    });

                    const fileRes = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: csvFiles[0].Key! }));
                    if (!fileRes.Body) return { date, scores: [] as SentimentScore[], markDateProcessed: false };

                    const csvData = await streamToString(fileRes.Body as ReadableStream);
                    const rows = (await csv().fromString(csvData)) as Record<string, unknown>[];
                    const normalized = normalizeSentiScoreCsvRows(rows, sourceTag);
                    return { date, scores: normalized.map(normalizedToSentimentScore), markDateProcessed: true };
                }
            );

            for (const r of results) {
                allSentiScores.push(...r.scores);
                if (r.markDateProcessed) processedDates.add(r.date);
            }

            if (allSentiScores.length === 0) {
                return NextResponse.json(
                    { error: `No sentiment data found for symbol "${upperSymbol}" across all dates (${sourceName} source).` },
                    { status: 404 }
                );
            }

            allSentiScores.sort((a, b) => a.time - b.time);

            const responseData: ResponseData = {
                dates: Array.from(processedDates).sort(),
                symbol: upperSymbol,
                fileCount: processedDates.size,
                sentiScores: allSentiScores,
                lastUpdated: new Date().toISOString(),
            };

            fs.writeFileSync(cacheFile, JSON.stringify(responseData), 'utf-8');
            return NextResponse.json(responseData);
        } catch (error) {
            console.error(`Error fetching sentiment scores for ${upperSymbol} (${sourceName} source):`, error);
            if (fs.existsSync(cacheFile)) {
                console.log(`Error fetching new data, using cached data for ${upperSymbol} (${sourceName} source)`);
                return NextResponse.json(JSON.parse(fs.readFileSync(cacheFile, 'utf-8')));
            }
            return NextResponse.json(
                { error: `Error fetching sentiment scores for ${upperSymbol} (${sourceName} source): ${error instanceof Error ? error.message : 'Unknown error'}` },
                { status: 500 }
            );
        }
    };
}
