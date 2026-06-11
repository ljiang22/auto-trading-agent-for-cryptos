import fs from "fs";
import path from "path";
import { elizaLogger } from "@elizaos/core";
import { SentiscoreFetcher } from "./sentiscoreFetcher.ts";

interface SentiScore {
    time: number;
    value: number;
    negative: number;
    neutral: number;
    positive: number;
    total: number;
}

interface CacheData {
    dates: string[];
    symbol: string;
    fileCount: number;
    sentiScores: SentiScore[];
    lastUpdated: string;
}

export interface TrendingCoinScore {
    symbol: string;
    weightedScore: number;
    dailyScores: number[];
    rank: number;
}

export interface TrendingSentiscoreResponse {
    success: boolean;
    news: TrendingCoinScore[];
    twitter: TrendingCoinScore[];
    lastUpdated: number;
}

const COINS = ["BTC", "ETH", "XRP", "DOGE", "SOL"];
const NUM_DAYS = 10;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Calculate exponential weights for time-based weighting using base 1.5
 * Most recent day gets highest weight, oldest gets lowest
 * More balanced than softmax - most recent day ~34% vs 62%
 */
function calculateExponentialWeights(numDays: number): number[] {
    const BASE = 1.5;
    // Time values: [1, 2, 3, ..., 10] where 10 is most recent
    const timeValues = Array.from({ length: numDays }, (_, i) => i + 1);

    // Calculate exponential values: 1.5^1, 1.5^2, ..., 1.5^10
    const expValues = timeValues.map(t => Math.pow(BASE, t));

    // Sum of all exponential values
    const sumExp = expValues.reduce((sum, val) => sum + val, 0);

    // Normalize: each weight = exp(t) / sum
    const weights = expValues.map(val => val / sumExp);

    return weights;
}

const WEIGHTS = calculateExponentialWeights(NUM_DAYS);

export class TrendingSentiscoreService {
    private cachedResult: TrendingSentiscoreResponse | null = null;
    private lastCalculation = 0;
    private cacheDir: string;
    private fetcher: SentiscoreFetcher;

    constructor(cacheDir?: string) {
        // Default to project root cache directory
        this.cacheDir = cacheDir || path.join(process.cwd(), "cache");
        this.fetcher = new SentiscoreFetcher(this.cacheDir);
    }

    /**
     * Get trending sentiscores with caching
     */
    public async getTrendingScores(): Promise<TrendingSentiscoreResponse> {
        const now = Date.now();

        // Return cached result if still valid
        if (this.cachedResult && now - this.lastCalculation < CACHE_TTL_MS) {
            return this.cachedResult;
        }

        // Calculate new trending scores
        const result = await this.calculateTrendingScores();
        this.cachedResult = result;
        this.lastCalculation = now;

        return result;
    }

    /**
     * Calculate weighted trending scores for all coins
     */
    private async calculateTrendingScores(): Promise<TrendingSentiscoreResponse> {
        const newsScores: TrendingCoinScore[] = [];
        const twitterScores: TrendingCoinScore[] = [];

        for (const symbol of COINS) {
            // Get News sentiscore
            const newsScore = await this.getWeightedScore(symbol, "news");
            if (newsScore !== null) {
                newsScores.push({
                    symbol,
                    weightedScore: newsScore.weightedScore,
                    dailyScores: newsScore.dailyScores,
                    rank: 0, // Will be set after sorting
                });
            }

            // Get Twitter/X sentiscore
            const twitterScore = await this.getWeightedScore(symbol, "twitter");
            if (twitterScore !== null) {
                twitterScores.push({
                    symbol,
                    weightedScore: twitterScore.weightedScore,
                    dailyScores: twitterScore.dailyScores,
                    rank: 0,
                });
            }
        }

        // Sort by weighted score (highest first) and assign ranks
        newsScores.sort((a, b) => b.weightedScore - a.weightedScore);
        newsScores.forEach((score, index) => {
            score.rank = index + 1;
        });

        twitterScores.sort((a, b) => b.weightedScore - a.weightedScore);
        twitterScores.forEach((score, index) => {
            score.rank = index + 1;
        });

        return {
            success: true,
            news: newsScores,
            twitter: twitterScores,
            lastUpdated: Date.now(),
        };
    }

    /**
     * Get weighted score for a single coin and source
     */
    private async getWeightedScore(
        symbol: string,
        source: "news" | "twitter"
    ): Promise<{ weightedScore: number; dailyScores: number[] } | null> {
        try {
            const cacheFileName =
                source === "news"
                    ? `sentiscore_${symbol}.json`
                    : `sentiscore_${symbol}_X.json`;
            const cachePath = path.join(this.cacheDir, cacheFileName);

            // Check if we need to fetch fresh data
            let needsFetch = false;
            let cacheData: CacheData | null = null;

            if (!fs.existsSync(cachePath)) {
                elizaLogger.warn(
                    `Cache file not found for ${symbol} (${source}): ${cachePath}`
                );
                needsFetch = true;
            } else {
                // Read existing cache to check data freshness
                try {
                    cacheData = JSON.parse(fs.readFileSync(cachePath, "utf-8"));

                    // Check if cache has recent data (within last 10 days)
                    if (cacheData && cacheData.sentiScores && cacheData.sentiScores.length > 0) {
                        // Find most recent timestamp in cache
                        const latestTimestamp = Math.max(...cacheData.sentiScores.map(s => s.time));
                        const nowSeconds = Math.floor(Date.now() / 1000);
                        const daysSinceLastData = (nowSeconds - latestTimestamp) / (24 * 60 * 60);

                        if (daysSinceLastData > 3) { // More than 3 days old
                            elizaLogger.warn(
                                `Cache for ${symbol} (${source}) is ${daysSinceLastData.toFixed(1)} days old, fetching fresh data...`
                            );
                            needsFetch = true;
                        }
                    } else {
                        elizaLogger.warn(`Cache for ${symbol} (${source}) is empty`);
                        needsFetch = true;
                    }
                } catch (error) {
                    elizaLogger.error(`Error reading cache for ${symbol} (${source}):`, error);
                    needsFetch = true;
                }
            }

            // Fetch fresh data if needed
            if (needsFetch) {
                elizaLogger.info(`Fetching fresh data from S3 for ${symbol} (${source})...`);

                const success =
                    source === "news"
                        ? await this.fetcher.fetchNewsData(symbol)
                        : await this.fetcher.fetchTwitterData(symbol);

                if (!success) {
                    elizaLogger.error(
                        `Failed to fetch data from S3 for ${symbol} (${source})`
                    );
                    // Return cached data if available, even if stale
                    if (cacheData) {
                        elizaLogger.warn(`Using stale cache data for ${symbol} (${source})`);
                    } else {
                        return null;
                    }
                } else {
                    elizaLogger.success(
                        `Successfully fetched and cached fresh data for ${symbol} (${source})`
                    );
                    // Read the updated cache
                    cacheData = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
                }
            }

            // Ensure we have cache data at this point
            if (!cacheData) {
                cacheData = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
            }

            if (!cacheData.sentiScores || cacheData.sentiScores.length === 0) {
                elizaLogger.warn(`No sentiscores found for ${symbol} (${source})`);
                return null;
            }

            // Get daily average scores for the last 10 days
            const dailyScores = this.getDailyAverages(cacheData.sentiScores, NUM_DAYS);

            if (dailyScores.length < NUM_DAYS) {
                elizaLogger.warn(
                    `Insufficient data for ${symbol} (${source}): only ${dailyScores.length} days available`
                );
                // Pad with zeros if we don't have 10 days
                while (dailyScores.length < NUM_DAYS) {
                    dailyScores.unshift(0);
                }
            }

            // Calculate weighted score
            const weightedScore = this.calculateWeightedScore(dailyScores);

            return { weightedScore, dailyScores };
        } catch (error) {
            elizaLogger.error(
                `Error getting weighted score for ${symbol} (${source}):`,
                error
            );
            return null;
        }
    }

    /**
     * Get daily average scores from sentiscore data
     */
    private getDailyAverages(
        sentiScores: SentiScore[],
        numDays: number
    ): number[] {
        // Sort by time (most recent first)
        const sorted = [...sentiScores].sort((a, b) => b.time - a.time);

        // Group by day and calculate daily averages
        const dailyAverages: number[] = [];
        const nowSeconds = Math.floor(Date.now() / 1000); // Convert to seconds to match score.time
        const secondsPerDay = 24 * 60 * 60;

        for (let dayOffset = 0; dayOffset < numDays; dayOffset++) {
            const dayStart = nowSeconds - (dayOffset + 1) * secondsPerDay;
            const dayEnd = nowSeconds - dayOffset * secondsPerDay;

            // Get all scores for this day (score.time is in seconds)
            const dayScores = sorted.filter(
                (score) => score.time >= dayStart && score.time < dayEnd
            );

            if (dayScores.length > 0) {
                // Calculate average sentiment value for the day
                const avgScore =
                    dayScores.reduce((sum, score) => sum + score.value, 0) /
                    dayScores.length;
                dailyAverages.unshift(avgScore); // Add to beginning (oldest first)
            } else {
                dailyAverages.unshift(0); // No data for this day
            }
        }

        return dailyAverages;
    }

    /**
     * Calculate weighted score using the specified weights
     */
    private calculateWeightedScore(dailyScores: number[]): number {
        if (dailyScores.length !== WEIGHTS.length) {
            elizaLogger.warn(
                `Score length mismatch: expected ${WEIGHTS.length}, got ${dailyScores.length}`
            );
        }

        let weightedSum = 0;
        const numScores = Math.min(dailyScores.length, WEIGHTS.length);

        for (let i = 0; i < numScores; i++) {
            weightedSum += dailyScores[i] * WEIGHTS[i];
        }

        return weightedSum;
    }

    /**
     * Force cache invalidation
     */
    public invalidateCache(): void {
        this.cachedResult = null;
        this.lastCalculation = 0;
    }
}
