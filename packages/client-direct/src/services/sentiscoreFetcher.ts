import {
    S3Client,
    ListObjectsV2Command,
    GetObjectCommand,
} from "@aws-sdk/client-s3";
import csvtojson from "csvtojson";
import fs from "fs";
import path from "path";
import { elizaLogger } from "@elizaos/core";

interface SentiScore {
    time: number;
    value: number;
    negative: number;
    neutral: number;
    positive: number;
    total: number;
    expected_negative: number;
}

interface CacheData {
    dates: string[];
    symbol: string;
    fileCount: number;
    sentiScores: SentiScore[];
    lastUpdated: string;
}

interface ScoreRow {
    date: string;
    hour: string;
    expected_positive: string;
    negative: string;
    neutral: string;
    positive: string;
    total: string;
    expected_negative: string;
    [key: string]: string;
}

const BUCKET_NAME =
    process.env.SENTISCORE_S3_BUCKET || "sentiscoredata-new";
const REGION =
    process.env.SENTISCORE_S3_REGION ||
    process.env.AWS_REGION ||
    "us-east-2";
const CACHE_DURATION_MS = 3600 * 1000; // 1 hour

// Convert date and hour to Unix timestamp (UTC)
function getTimestamp(dateStr: string, hourStr: string): number | null {
    try {
        const [year, month, day] = dateStr.split("-").map(Number);
        const [hour, minute] = hourStr.split(":").map(Number);
        // Use Date.UTC to ensure consistent timestamp generation regardless of server timezone
        const timestamp = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
        return Math.floor(timestamp / 1000);
    } catch (error) {
        elizaLogger.error("Error parsing date/time:", error);
        return null;
    }
}

// Validate cache data structure
function validateCacheData(data: any): data is CacheData {
    if (!data || typeof data !== "object") {
        return false;
    }

    // Check required fields exist
    if (!Array.isArray(data.dates) ||
        typeof data.symbol !== "string" ||
        typeof data.fileCount !== "number" ||
        !Array.isArray(data.sentiScores) ||
        typeof data.lastUpdated !== "string") {
        return false;
    }

    // Validate sentiScores structure
    for (const score of data.sentiScores) {
        if (typeof score.time !== "number" ||
            typeof score.value !== "number" ||
            typeof score.negative !== "number" ||
            typeof score.neutral !== "number" ||
            typeof score.positive !== "number" ||
            typeof score.total !== "number" ||
            typeof score.expected_negative !== "number") {
            return false;
        }
    }

    return true;
}

export class SentiscoreFetcher {
    private s3Client: S3Client;
    private cacheDir: string;

    constructor(cacheDir: string) {
        this.cacheDir = cacheDir;
        const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
        const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
        this.s3Client = new S3Client({
            region: REGION,
            ...(accessKeyId && secretAccessKey
                ? { credentials: { accessKeyId, secretAccessKey } }
                : {}),
        });

        // Ensure cache directory exists
        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }
    }

    /**
     * Fetch crypto news sentiment data for a symbol
     */
    async fetchNewsData(symbol: string): Promise<boolean> {
        const upperSymbol = symbol.toUpperCase();
        const cacheFile = path.join(this.cacheDir, `sentiscore_${upperSymbol}.json`);
        const prefix = `crypto_news`;

        elizaLogger.info(`Fetching news sentiment data for ${upperSymbol}...`);

        try {
            const data = await this.fetchFromS3(prefix, upperSymbol, cacheFile);
            return data !== null;
        } catch (error) {
            elizaLogger.error(`Error fetching news data for ${upperSymbol}:`, error);
            return false;
        }
    }

    /**
     * Fetch X/Twitter sentiment data for a symbol
     */
    async fetchTwitterData(symbol: string): Promise<boolean> {
        const upperSymbol = symbol.toUpperCase();
        const cacheFile = path.join(this.cacheDir, `sentiscore_${upperSymbol}_X.json`);
        const prefix = `X`;

        elizaLogger.info(`Fetching Twitter sentiment data for ${upperSymbol}...`);

        try {
            const data = await this.fetchFromS3(prefix, upperSymbol, cacheFile);
            return data !== null;
        } catch (error) {
            elizaLogger.error(`Error fetching Twitter data for ${upperSymbol}:`, error);
            return false;
        }
    }

    /**
     * Generic S3 fetching logic
     */
    private async fetchFromS3(
        prefix: string,
        symbol: string,
        cacheFile: string
    ): Promise<CacheData | null> {
        // Load existing cache if available
        let cachedData: CacheData | null = null;
        const knownDates = new Set<string>();

        if (fs.existsSync(cacheFile)) {
            try {
                const cachedDataString = fs.readFileSync(cacheFile, "utf-8");
                const parsedData = JSON.parse(cachedDataString);

                // Validate cache data structure
                if (validateCacheData(parsedData)) {
                    cachedData = parsedData;
                    cachedData.dates.forEach((date) => knownDates.add(date));
                    elizaLogger.info(`Loaded valid cache for ${symbol} from ${cacheFile}`);
                } else {
                    elizaLogger.warn(`Invalid cache data structure in ${cacheFile}, will fetch fresh data`);
                    cachedData = null;
                }
            } catch (error) {
                elizaLogger.error(`Error reading cache file ${cacheFile}:`, error);
                cachedData = null;
            }
        }

        try {
            // List all objects in S3 with the given prefix
            const listCommand = new ListObjectsV2Command({
                Bucket: BUCKET_NAME,
                Prefix: `${prefix}/`,
            });

            const listResponse = await this.s3Client.send(listCommand);
            const allObjects = listResponse.Contents || [];

        // Filter objects that match the symbol pattern
        const relevantObjects = allObjects.filter((obj) => {
            const key = obj.Key || "";
            return key.includes(`hourly_score/${symbol}/`);
        });

            if (relevantObjects.length === 0) {
                elizaLogger.warn(`No data found for ${symbol} in ${prefix}`);
                // Return cached data if available, otherwise null
                if (cachedData) {
                    elizaLogger.info(`Returning cached data for ${symbol} (no new data in S3)`);
                    return cachedData;
                }
                return null;
            }

        // Extract dates from object keys
        const availableDates = new Set<string>();
        relevantObjects.forEach((obj) => {
            const key = obj.Key || "";
            const match = key.match(/(\d{4}-\d{2}-\d{2})/);
            if (match) {
                availableDates.add(match[1]);
            }
        });

        // Find new dates that aren't in cache
        const newDates = Array.from(availableDates).filter(
            (date) => !knownDates.has(date)
        );

        if (newDates.length === 0 && cachedData) {
            elizaLogger.info(`Cache is up to date for ${symbol} in ${prefix}`);
            return cachedData;
        }

        elizaLogger.info(`Fetching ${newDates.length} new dates for ${symbol}`);

        // Fetch new data
        const newScores: SentiScore[] = [];
        const processedDates = new Set(knownDates);

        for (const dateStr of newDates) {
            const dateObjects = relevantObjects.filter(
                (obj) => obj.Key?.includes(dateStr)
            );

            // Sort by LastModified (newest first) and take only the latest file
            dateObjects.sort((a, b) => {
                if (!a.LastModified || !b.LastModified) return 0;
                return b.LastModified.getTime() - a.LastModified.getTime();
            });

            // Process only the latest file for this date
            const latestFile = dateObjects[0];
            if (!latestFile || !latestFile.Key) {
                elizaLogger.warn(`No valid file found for date ${dateStr}`);
                continue;
            }

            try {
                const getCommand = new GetObjectCommand({
                    Bucket: BUCKET_NAME,
                    Key: latestFile.Key,
                });

                const response = await this.s3Client.send(getCommand);
                const bodyString = await response.Body?.transformToString();

                if (!bodyString) {
                    elizaLogger.warn(`Empty response for ${latestFile.Key}`);
                    continue;
                }

                const rows: ScoreRow[] = await csvtojson().fromString(
                    bodyString
                );

                for (const row of rows) {
                    const timestamp = getTimestamp(row.date, row.hour);
                    if (!timestamp) continue;

                    const negative = Number.parseFloat(row.negative) || 0;
                    const neutral = Number.parseFloat(row.neutral) || 0;
                    const positive = Number.parseFloat(row.positive) || 0;
                    const total = Number.parseFloat(row.total) || 0;
                    const expected_negative =
                        Number.parseFloat(row.expected_negative) || 0;

                    let sentimentValue = 0;
                    if (total > 0) {
                        sentimentValue = (positive - negative) / total;
                    }

                    newScores.push({
                        time: timestamp,
                        value: sentimentValue,
                        negative,
                        neutral,
                        positive,
                        total,
                        expected_negative,
                    });
                }

                processedDates.add(dateStr);
                elizaLogger.info(`Processed ${latestFile.Key}: ${rows.length} hourly scores`);
            } catch (error) {
                elizaLogger.error(`Error processing ${latestFile.Key}:`, error);
            }
        }

        // Merge with existing data
        const allScores = [...(cachedData?.sentiScores || []), ...newScores];

        // Sort by timestamp (oldest first) - matches original plugin behavior
        allScores.sort((a, b) => a.time - b.time);

        // Implement data retention: Keep only last 90 days
        const RETENTION_DAYS = 90;
        const cutoffTime = Math.floor(Date.now() / 1000) - (RETENTION_DAYS * 86400);
        const retainedScores = allScores.filter(score => score.time >= cutoffTime);

        if (retainedScores.length < allScores.length) {
            elizaLogger.info(
                `Data retention: Removed ${allScores.length - retainedScores.length} old scores (keeping ${RETENTION_DAYS} days)`
            );
        }

        // Create updated cache data
        const updatedCache: CacheData = {
            dates: Array.from(processedDates).sort(),
            symbol,
            fileCount: retainedScores.length,
            sentiScores: retainedScores,
            lastUpdated: new Date().toISOString(),
        };

        // Write to cache file
        fs.writeFileSync(cacheFile, JSON.stringify(updatedCache, null, 2));
        elizaLogger.success(
            `Updated cache for ${symbol}: ${retainedScores.length} total scores`
        );

            return updatedCache;
        } catch (error) {
            elizaLogger.error(`Error fetching from S3 for ${symbol} in ${prefix}:`, error);
            // Return cached data as fallback
            if (cachedData) {
                elizaLogger.warn(`Returning cached data for ${symbol} due to S3 error`);
                return cachedData;
            }
            return null;
        }
    }
}
