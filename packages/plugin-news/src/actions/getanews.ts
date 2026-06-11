import type {
    ActionExample,
    IAgentRuntime,
    Memory,
    Action,
    State,
    HandlerCallback
} from "@elizaos/core";
import { createActionResponse, generateActionSummary, clampDateRangeToRetention } from "@elizaos/core";
import {
    S3Client,
    ListObjectsV2Command,
    GetObjectCommand
} from '@aws-sdk/client-s3';
import Papa from 'papaparse';
import { promises as fsp, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
    deriveArticleNormalizedSentiment,
    hourlyCsvRowsToNewsItems,
    sniffNewsCsvKind,
} from '../utils/newsCsvFormat.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 180-minute cache; aligns with cacheConfig.ttlSeconds below
const CACHE_DURATION_MS = 180 * 60 * 1000;
const CACHE_DIR = path.join(__dirname, '..', '..', '..', 'cache');
const MAX_ARTICLES_PER_DATE = 20;   // top-K shortcut: normalize only what we'll show; requests above this are clamped to 20
const DEFAULT_NEWS_LIMIT = 5;       // items returned when the user does not specify a count
const MAX_CONCURRENT_DATE_FETCHES = 8;

if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// S3 singleton — credentials are stable for the process lifetime
// ---------------------------------------------------------------------------
let _s3: S3Client | undefined;
function getS3(): S3Client {
    if (!_s3) {
        const region = process.env.SENTISCORE_S3_REGION || process.env.AWS_REGION || 'us-east-2';
        const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
        const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
        _s3 = new S3Client({
            region,
            ...(accessKeyId && secretAccessKey
                ? { credentials: { accessKeyId, secretAccessKey } }
                : {}),
        });
    }
    return _s3;
}

// ---------------------------------------------------------------------------
// Asset / date helpers
// ---------------------------------------------------------------------------

function identifyAsset(text: string, defaultSymbol = "BTC"): string {
    const lowerText = text.toLowerCase();

    const generalMarketTerms = [
        'crypto_market', 'crypto market', 'general crypto', 'overall crypto',
        'cryptocurrency market', 'crypto markets', 'general market',
        'overall market', 'market overview', 'crypto overview',
    ];
    for (const term of generalMarketTerms) {
        if (lowerText.includes(term)) return 'BTC';
    }

    const cryptoMappings: Record<string, string> = {
        'bitcoin': 'BTC', 'btc': 'BTC',
        'ethereum': 'ETH', 'eth': 'ETH',
        'solana': 'SOL', 'sol': 'SOL',
        'dogecoin': 'DOGE', 'doge': 'DOGE',
        'ripple': 'XRP', 'xrp': 'XRP',
        'cardano': 'ADA', 'ada': 'ADA',
        'binance': 'BNB', 'bnb': 'BNB',
        'polygon': 'MATIC', 'matic': 'MATIC',
        'chainlink': 'LINK', 'link': 'LINK',
        'avalanche': 'AVAX', 'avax': 'AVAX',
    };

    for (const [key, symbol] of Object.entries(cryptoMappings)) {
        if (lowerText.includes(key)) return symbol;
    }
    return defaultSymbol;
}

function identifyDatePeriod(text: string): { days: number; description: string } {
    const lowerText = text.toLowerCase();

    // Numeric: "last/past/previous N days/weeks/months" — handles digit forms
    const numericPatterns = [
        { regex: /(?:last|past|previous)\s*(\d+)\s*days?/i, multiplier: 1 },
        { regex: /(?:last|past|previous)\s*(\d+)\s*weeks?/i, multiplier: 7 },
        { regex: /(?:last|past|previous)\s*(\d+)\s*months?/i, multiplier: 30 },
    ];
    for (const { regex, multiplier } of numericPatterns) {
        const match = lowerText.match(regex);
        if (match) {
            const number = Number.parseInt(match[1]);
            if (!Number.isNaN(number) && number > 0) {
                const days = number * multiplier;
                const unit = multiplier === 1 ? 'day' : multiplier === 7 ? 'week' : 'month';
                return { days, description: `last ${number} ${unit}${number > 1 ? 's' : ''}` };
            }
        }
    }

    // Word-form and non-numeric phrases (digit forms covered above, so not repeated here)
    const wordPatterns: Array<{ regex: RegExp; days: number; desc: string }> = [
        { regex: /\byesterday\b/i, days: 1, desc: "yesterday" },
        { regex: /\btoday\b/i, days: 1, desc: "today" },
        { regex: /\bone\s*day\b/i, days: 1, desc: "today" },
        { regex: /(?:last|past|this)\s*week\b/i, days: 7, desc: "last week" },
        { regex: /\btwo\s*weeks?\b/i, days: 14, desc: "last 2 weeks" },
        { regex: /\bthree\s*days?\b/i, days: 3, desc: "last 3 days" },
        { regex: /\bfive\s*days?\b/i, days: 5, desc: "last 5 days" },
        { regex: /\bseven\s*days?\b/i, days: 7, desc: "last 7 days" },
        { regex: /\bten\s*days?\b/i, days: 10, desc: "last 10 days" },
        { regex: /\bfourteen\s*days?\b/i, days: 14, desc: "last 14 days" },
        { regex: /\bthirty\s*days?\b/i, days: 30, desc: "last 30 days" },
        { regex: /\bsixty\s*days?\b/i, days: 60, desc: "last 60 days" },
        { regex: /\bninety\s*days?\b/i, days: 90, desc: "last 90 days" },
        { regex: /(?:last|past|this)\s*month\b/i, days: 30, desc: "last month" },
        { regex: /(?:last|past)\s*quarter\b|3\s*months\b/i, days: 90, desc: "last quarter" },
    ];
    for (const { regex, days, desc } of wordPatterns) {
        if (regex.test(lowerText)) return { days, description: desc };
    }

    return { days: 1, description: "latest" };
}

// Parses explicit count from text: "top 10", "10 news", "ten articles", etc.
// Returns undefined when the user has not specified a count.
function extractNewsLimit(text: string): number | undefined {
    const lowerText = text.toLowerCase();
    const wordToNum: Record<string, number> = {
        one: 1, two: 2, three: 3, four: 4, five: 5,
        six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
        fifteen: 15, twenty: 20, thirty: 30, fifty: 50,
    };

    // "top 10", "top-10", "top ten" — over-large requests clamp to MAX_ARTICLES_PER_DATE
    const topDigit = lowerText.match(/\btop[\s-]*(\d+)\b/);
    if (topDigit) {
        const n = Number.parseInt(topDigit[1]);
        if (n > 0) return Math.min(n, MAX_ARTICLES_PER_DATE);
    }
    const topWord = lowerText.match(/\btop[\s-]*(one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|fifty)\b/);
    if (topWord && wordToNum[topWord[1]]) return Math.min(wordToNum[topWord[1]], MAX_ARTICLES_PER_DATE);

    // "10 news", "10 articles", "10 results"
    const countDigit = lowerText.match(/\b(\d+)\s*(?:news|article|result|item)s?\b/);
    if (countDigit) {
        const n = Number.parseInt(countDigit[1]);
        if (n > 0) return Math.min(n, MAX_ARTICLES_PER_DATE);
    }
    const countWord = lowerText.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|fifty)\s*(?:news|article|result|item)s?\b/);
    if (countWord && wordToNum[countWord[1]]) return Math.min(wordToNum[countWord[1]], MAX_ARTICLES_PER_DATE);

    return undefined;
}

// Returns dates newest-first
function getDateRange(daysBack: number): string[] {
    const dates: string[] = [];
    const today = new Date();
    for (let i = 0; i < daysBack; i++) {
        const date = new Date(today);
        date.setDate(today.getDate() - i);
        dates.push(date.toISOString().split('T')[0]);
    }
    return dates;
}

// Returns dates oldest-first
function getDateRangeFromTo(fromDate: string, toDate: string): string[] {
    const fromPart = fromDate.length >= 10 ? fromDate.slice(0, 10) : fromDate;
    const toPart = toDate.length >= 10 ? toDate.slice(0, 10) : toDate;
    const start = new Date(fromPart + "T00:00:00.000Z");
    const end = new Date(toPart + "T00:00:00.000Z");
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
    const dates: string[] = [];
    const cur = new Date(start);
    while (cur <= end) {
        dates.push(cur.toISOString().split("T")[0]);
        cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return dates;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NewsItem {
    title?: string;
    summary?: string;
    canonical_link?: string;
    published?: string;
    date_publish?: string;
    source_date?: string;
    sentiment_normalized?: number;
    [key: string]: string | number | undefined;
}

interface NewsResponse {
    dateFolder: string;
    fileKey: string;
    newsSymbol: string;
    newsItems: NewsItem[];
}

// ---------------------------------------------------------------------------
// Concurrency helper — runs tasks in parallel with an upper-bound of `limit`
// ---------------------------------------------------------------------------

async function withConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let nextIndex = 0;

    async function worker(): Promise<void> {
        while (true) {
            // nextIndex++ is synchronous — no two workers get the same index
            const i = nextIndex++;
            if (i >= tasks.length) break;
            results[i] = await tasks[i]();
        }
    }

    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
    return results;
}

// ---------------------------------------------------------------------------
// CSV / stream helpers
// ---------------------------------------------------------------------------

async function streamToString(stream: ReadableStream): Promise<string> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream as any) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf-8');
}

function parseCsvString(csvData: string): Record<string, string>[] {
    return Papa.parse<Record<string, string>>(csvData, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: false,
    }).data;
}

// ---------------------------------------------------------------------------
// Per-date fetch — encapsulates all S3 I/O for one calendar date
// ---------------------------------------------------------------------------

async function fetchDateNews(
    bucketName: string,
    upperSymbol: string,
    targetDate: string
): Promise<NewsItem[]> {
    const s3 = getS3();

    // Parallel-probe both score prefixes; prefer original_score when non-empty
    const [origRes, hourlyRes] = await Promise.all([
        s3.send(new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: `crypto_news/${targetDate}/original_score/${upperSymbol}/`,
        })),
        s3.send(new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: `crypto_news/${targetDate}/hourly_score/${upperSymbol}/`,
        })),
    ]);

    const origCsvs = (origRes.Contents || []).filter(o => o.Key?.endsWith('.csv'));
    const hourlyCsvs = (hourlyRes.Contents || []).filter(o => o.Key?.endsWith('.csv'));
    const csvObjects = origCsvs.length > 0 ? origCsvs : hourlyCsvs;

    if (csvObjects.length === 0) return [];

    // Newest CSV first (LastModified desc)
    csvObjects.sort((a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0));
    const newestKey = csvObjects[0].Key;
    if (!newestKey) return [];

    const fileRes = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: newestKey }));
    const csvData = await streamToString(fileRes.Body as unknown as ReadableStream);
    const rawRows = parseCsvString(csvData);
    if (rawRows.length === 0) return [];

    const sniffed = sniffNewsCsvKind(rawRows[0] as Record<string, unknown>);

    if (sniffed === 'article') {
        // Top-K shortcut: only normalize the rows we'll actually display
        return rawRows.slice(0, MAX_ARTICLES_PER_DATE).map(item => {
            const norm = deriveArticleNormalizedSentiment(item as Record<string, unknown>);
            const row: NewsItem = { ...(item as NewsItem), source_date: targetDate };
            if (norm !== undefined) row.sentiment_normalized = norm;
            return row;
        });
    }

    if (sniffed === 'hourly') {
        return hourlyCsvRowsToNewsItems(
            rawRows as Record<string, unknown>[],
            upperSymbol,
            targetDate
        ) as NewsItem[];
    }

    console.warn(`[getnews] Unrecognized CSV columns for ${upperSymbol} on ${targetDate} (key ${newestKey})`);
    return [];
}

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

function formatNewsItems(response: NewsResponse, period = "latest", limit = DEFAULT_NEWS_LIMIT): string {
    if (!response.newsItems || response.newsItems.length === 0) {
        return `No news found for ${response.newsSymbol}`;
    }

    const periodText = period === "latest" ? "latest" : `from ${period}`;

    let dateText: string;
    if (response.dateFolder.includes(',')) {
        const dates = response.dateFolder.split(', ').filter(d => d.trim());
        if (dates.length > 1) {
            dates.sort((a, b) => b.localeCompare(a));
            dateText = `${dates[dates.length - 1]} to ${dates[0]}`;
        } else {
            dateText = response.dateFolder;
        }
    } else {
        dateText = response.dateFolder;
    }

    const headerText = `📈 ${response.newsSymbol} news ${periodText} (${dateText}):\n\n`;

    return headerText +
        response.newsItems.slice(0, limit).map((item, index) => {
            const title = item.title || 'No title available';
            // Use article summary only — never fall through to full-text fields
            const summary = String(item.summary || '').trim();
            const url = item.canonical_link || '';
            const date = item.published || item.date_publish || item.source_date || '';
            const normRaw = item.sentiment_normalized;
            const normNum = typeof normRaw === 'number' ? normRaw : Number.NaN;
            const sentLine = Number.isFinite(normNum)
                ? `\n📊 Sentiment (−1…1): ${normNum.toFixed(4)}`
                : '';
            return `**${index + 1}.** 📰 TITLE: **${title}**\n📅 DATE: ${date}\n📝 SUMMARY: ${summary}\n🔗 URL: ${url}${sentLine}`;
        }).join('\n\n');
}

// ---------------------------------------------------------------------------
// Main news fetch
// ---------------------------------------------------------------------------

async function getNewsForSymbol(symbol: string, dateRange: string[] | undefined, limit: number): Promise<string> {
    const upperSymbol = symbol.toUpperCase();
    const bucketName = process.env.SENTISCORE_S3_BUCKET || 'sentiscoredata-new';

    // Cache key encodes both symbol and the exact date range so "latest" and
    // multi-day requests never collide or overwrite each other
    const sortedAsc = dateRange ? [...dateRange].sort() : null;
    const rangeKey = sortedAsc
        ? `${sortedAsc[0]}_to_${sortedAsc[sortedAsc.length - 1]}`
        : 'latest';
    const cacheFile = path.join(CACHE_DIR, `news_${upperSymbol}_${rangeKey}.json`);

    try {
        const stats = await fsp.stat(cacheFile);
        if (Date.now() - stats.mtimeMs < CACHE_DURATION_MS) {
            const cachedData = await fsp.readFile(cacheFile, 'utf-8');
            const json: NewsResponse = JSON.parse(cachedData);
            return formatNewsItems(json, rangeKey === 'latest' ? 'latest' : rangeKey.replace('_to_', ' to '), limit);
        }
    } catch {
        // Cache miss or stale — fall through to fetch
    }

    try {
        let targetDates: string[];

        if (dateRange && dateRange.length > 0) {
            // Skip the S3 bucket listing entirely — probe the requested dates directly.
            // Dates that have no data on S3 return [] and are filtered below.
            targetDates = [...dateRange].sort((a, b) => b.localeCompare(a)); // newest first
        } else {
            // "Latest" mode: list the bucket to find the most recent date
            const listRes = await getS3().send(new ListObjectsV2Command({
                Bucket: bucketName,
                Prefix: 'crypto_news/',
                Delimiter: '/',
            }));

            const dateFolders = listRes.CommonPrefixes || [];
            if (dateFolders.length === 0) return 'No date subfolders found under crypto_news/';

            const dateStrings: string[] = [];
            for (const cp of dateFolders) {
                const match = cp.Prefix?.match(/^crypto_news\/(\d{4}-\d{2}-\d{2})\//);
                if (match) dateStrings.push(match[1]);
            }
            if (dateStrings.length === 0) return 'No valid date subfolders found (YYYY-MM-DD).';

            const latestDate = dateStrings.reduce((a, b) => (b > a ? b : a));
            targetDates = [latestDate];
        }

        // Fetch all dates in parallel, up to MAX_CONCURRENT_DATE_FETCHES at a time
        const tasks = targetDates.map(
            date => () =>
                fetchDateNews(bucketName, upperSymbol, date).catch(err => {
                    console.warn(`[getnews] Error fetching ${upperSymbol} for ${date}:`, err);
                    return [] as NewsItem[];
                })
        );
        const resultsPerDate = await withConcurrency(tasks, MAX_CONCURRENT_DATE_FETCHES);

        const allNewsItems: NewsItem[] = [];
        const processedDates: string[] = [];
        for (let i = 0; i < targetDates.length; i++) {
            if (resultsPerDate[i].length > 0) {
                allNewsItems.push(...resultsPerDate[i]);
                processedDates.push(targetDates[i]);
            }
        }

        if (allNewsItems.length === 0) {
            const dateDesc = targetDates.length === 1
                ? `date "${targetDates[0]}"`
                : `date range (${targetDates[targetDates.length - 1]} to ${targetDates[0]})`;
            return `No news data found for "${upperSymbol}" on ${dateDesc}. Available symbols include: BTC, ETH, SOL, DOGE, XRP, ADA, BNB, MATIC, LINK, AVAX.`;
        }

        // Sort newest first across all dates
        allNewsItems.sort((a, b) => {
            const da = String(a.source_date || a.published || a.date_publish || '');
            const db = String(b.source_date || b.published || b.date_publish || '');
            return db.localeCompare(da);
        });

        const responseData: NewsResponse = {
            dateFolder: processedDates.join(', '),
            fileKey: `Multiple files from ${processedDates.length} date(s)`,
            newsSymbol: upperSymbol,
            newsItems: allNewsItems,
        };

        // Write cache without blocking the response
        fsp.writeFile(cacheFile, JSON.stringify(responseData, null, 2), 'utf-8')
            .catch(err => console.warn('[getnews] Cache write failed:', err));

        return formatNewsItems(responseData, rangeKey === 'latest' ? 'latest' : rangeKey.replace('_to_', ' to '), limit);
    } catch (error: any) {
        return `Unexpected error for ${symbol}: ${error.message}`;
    }
}

// ---------------------------------------------------------------------------
// Action definition
// ---------------------------------------------------------------------------

export const getNewsAction: Action = {
    name: "getnews",
    description: "Get the latest news of crypto market from internal database",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ): Promise<boolean> => {
        // Resolve symbol
        let symbol = 'BTC';
        if (options?.target) {
            symbol = options.target.toString().toUpperCase();
        } else if (options?.symbol) {
            symbol = options.symbol.toString().toUpperCase();
        } else if (message?.content?.text) {
            symbol = identifyAsset(message.content.text, "BTC");
        }
        if (symbol === 'CRYPTO_MARKET') symbol = 'BTC';

        // Resolve result limit: options.limit wins, then parse message text, then default
        let limit = DEFAULT_NEWS_LIMIT;
        if (typeof options?.limit === 'number' && options.limit > 0) {
            limit = Math.min(options.limit, MAX_ARTICLES_PER_DATE);
        } else if (message?.content?.text) {
            const parsed = extractNewsLimit(message.content.text);
            if (parsed !== undefined) limit = parsed;
        }

        // Resolve date range
        let dateRange: string[] | undefined;
        let periodDescription = "latest";
        let dataRetentionApplied = false;

        if (options?.from && options?.to && typeof options.from === "string" && typeof options.to === "string") {
            dateRange = getDateRangeFromTo(options.from, options.to);
            if (dateRange.length > 0) {
                periodDescription = `${options.from} to ${options.to}`;
                const dataRetentionDays = typeof options?.dataRetentionDays === "number" ? options.dataRetentionDays : undefined;
                const dataRetentionMinDaysAgo = typeof options?.dataRetentionMinDaysAgo === "number" ? options.dataRetentionMinDaysAgo : undefined;
                const dataRetentionMaxDaysAgo = typeof options?.dataRetentionMaxDaysAgo === "number" ? options.dataRetentionMaxDaysAgo : undefined;
                if (
                    (typeof dataRetentionDays === "number" && dataRetentionDays >= 0) ||
                    (typeof dataRetentionMinDaysAgo === "number" && typeof dataRetentionMaxDaysAgo === "number")
                ) {
                    // getDateRangeFromTo returns oldest-first
                    const startDate = dateRange[0];
                    const endDate = dateRange[dateRange.length - 1];
                    const totalDays = dateRange.length;
                    const clamped = clampDateRangeToRetention(
                        { startDate, endDate, totalDays },
                        { dataRetentionDays, dataRetentionMinDaysAgo, dataRetentionMaxDaysAgo }
                    );
                    dataRetentionApplied =
                        clamped.startDate !== startDate || clamped.endDate !== endDate || clamped.totalDays !== totalDays;
                    dateRange = dateRange.filter(d => d >= clamped.startDate && d <= clamped.endDate);
                    if (dateRange.length === 0) dateRange = [clamped.startDate];
                }
            }
        } else if (message?.content?.text) {
            const datePeriod = identifyDatePeriod(message.content.text);
            periodDescription = datePeriod.description;
            if (datePeriod.days > 1) {
                dateRange = getDateRange(datePeriod.days); // newest-first
                const dataRetentionDays = typeof options?.dataRetentionDays === "number" ? options.dataRetentionDays : undefined;
                const dataRetentionMinDaysAgo = typeof options?.dataRetentionMinDaysAgo === "number" ? options.dataRetentionMinDaysAgo : undefined;
                const dataRetentionMaxDaysAgo = typeof options?.dataRetentionMaxDaysAgo === "number" ? options.dataRetentionMaxDaysAgo : undefined;
                if (
                    (typeof dataRetentionDays === "number" && dataRetentionDays >= 0) ||
                    (typeof dataRetentionMinDaysAgo === "number" && typeof dataRetentionMaxDaysAgo === "number")
                ) {
                    // getDateRange returns newest-first, so [last] is oldest
                    const startDate = dateRange[dateRange.length - 1];
                    const endDate = dateRange[0];
                    const totalDays = dateRange.length;
                    const clamped = clampDateRangeToRetention(
                        { startDate, endDate, totalDays },
                        { dataRetentionDays, dataRetentionMinDaysAgo, dataRetentionMaxDaysAgo }
                    );
                    dataRetentionApplied =
                        clamped.startDate !== startDate || clamped.endDate !== endDate || clamped.totalDays !== totalDays;
                    dateRange = dateRange.filter(d => d >= clamped.startDate && d <= clamped.endDate);
                    if (dateRange.length === 0) dateRange = [clamped.startDate];
                }
            }
        }

        const newsResult = await getNewsForSymbol(symbol, dateRange, limit);

        let finalResult = newsResult;
        if (dateRange && periodDescription !== "latest") {
            finalResult = newsResult.replace("📈", `📈 (${periodDescription})`);
        }

        // Count formatted items — matches "**N.**" bold number prefix used in formatNewsItems
        const dataPointCount = (finalResult.match(/^\*\*\d+\.\*\*/gm) || []).length;

        const actionSummary = generateActionSummary({
            actionName: 'News Aggregation',
            assets: [symbol],
            timePeriod: periodDescription || 'latest',
            dataPoints: Math.max(dataPointCount, 1),
            additionalInfo: dateRange ? `from ${dateRange.length} dates` : 'latest news',
        });

        await callback(createActionResponse({
            actionName: "getnews",
            type: "getnews",
            text: finalResult,
            actionData: { summary: actionSummary },
            additionalMetadata: dataRetentionApplied ? { dataRetentionApplied: true } : undefined,
        }));

        return true;
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Show me Bitcoin news", action: "getanews" }
            },
            {
                user: "{{user2}}",
                content: {
                    text: "📈 BTC news latest (2025-01-15):\n\n1. 📰 TITLE: Bitcoin ETF Sees Record Inflows\n📅 DATE: 2025-01-15\n📝 SUMMARY: BlackRock's Bitcoin ETF recorded its largest single-day inflow of $790M as institutional investors continue to pile into crypto.\n🔗 URL: https://example.com/btc-etf\n📊 Sentiment (−1…1): 0.7200",
                    action: "getanews"
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Show me Bitcoin news from the last 7 days", action: "getanews" }
            },
            {
                user: "{{user2}}",
                content: {
                    text: "📈 (last 7 days) BTC news from last 7 days (2025-01-09 to 2025-01-15):\n\n1. 📰 TITLE: Bitcoin Network Difficulty Reaches All-Time High\n📅 DATE: 2025-01-15\n📝 SUMMARY: Mining difficulty adjustment reflects growing hash rate as more miners come online.\n🔗 URL: https://example.com/btc-difficulty\n📊 Sentiment (−1…1): 0.4500",
                    action: "getanews"
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "What Ethereum news happened this week?", action: "getanews" }
            },
            {
                user: "{{user2}}",
                content: {
                    text: "📈 ETH news from last week (2025-01-09 to 2025-01-15):\n\n1. 📰 TITLE: Ethereum Staking Rewards Hit 2025 Highs\n📅 DATE: 2025-01-15\n📝 SUMMARY: Staking rewards for ETH validators reached 4.2% APY as network activity increases.\n🔗 URL: https://example.com/eth-staking\n📊 Sentiment (−1…1): 0.5800",
                    action: "getanews"
                }
            }
        ],
    ] as ActionExample[][],
    cacheConfig: {
        enabled: true,
        ttlSeconds: 180 * 60,   // matches CACHE_DURATION_MS above
        similarityThreshold: 0.7,
        maxChunkSize: 200,
    }
} as Action;
