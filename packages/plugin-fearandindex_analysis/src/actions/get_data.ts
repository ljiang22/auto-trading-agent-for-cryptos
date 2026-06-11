import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import type {
    Action,
    IAgentRuntime,
    Memory,
    ActionExample,
    State,
    HandlerCallback
} from "@elizaos/core";

import { getProductionEnvVariable, clampDateRangeToRetention } from "@elizaos/core";
import { httpClient } from "@elizaos/core";

const API_KEY = getProductionEnvVariable("COINMARKETCAP_API_KEY");
const API_URL = "https://pro-api.coinmarketcap.com/v3/fear-and-greed/historical";
const COINGLASS_API_URL = "https://open-api-v4.coinglass.com/api/futures/price/history";
const COINGLASS_EXCHANGE = "Binance";
const COINGLASS_INTERVAL = "1d";

// Convert exec to Promise-based
const execPromise = promisify(exec);

if (!API_KEY) {
    throw new Error("COINMARKETCAP_API_KEY is not set");
}

// example return data
// {
//     "data": [
// {
// "timestamp": "1726617600",
// "value": 38,
// "value_classification": "Fear"
// },
// {
// "timestamp": "1726531200",
// "value": 34,
// "value_classification": "Fear"
// },
// }

interface FearIndexDataPoint {
    timestamp: string;
    value: number;
    value_classification: string;
}

interface PriceDataPoint {
    date: string; // YYYY-MM-DD format
    price: number;
}

interface CoinglassPricePoint {
    time: number;
    close: string;
}

interface CoinglassPriceHistoryResponse {
    code: string;
    msg?: string;
    data?: CoinglassPricePoint[];
}

/**
 * Date range interface for period-based queries
 */
interface DateRange {
    startDate: string; // YYYY-MM-DD format
    endDate: string;   // YYYY-MM-DD format
    totalDays: number;
}

/**
 * Parse period parameters to determine date range
 * Supports both relative periods (30 days) and absolute date ranges (from/to)
 */
function parsePeriodParams(options: { [key: string]: unknown }): DateRange {
    const today = new Date().toISOString().split('T')[0];

    // Check for explicit from/to parameters (accept YYYY-MM-DD or YYYY-MM-DDTHH:mm; use date part)
    if (options.from && options.to) {
        const fromStr = options.from.toString().trim().slice(0, 10);
        const toStr = options.to.toString().trim().slice(0, 10);

        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (fromStr.length !== 10 || toStr.length !== 10 || !dateRegex.test(fromStr) || !dateRegex.test(toStr)) {
            throw new Error('Invalid date format. Please use YYYY-MM-DD or YYYY-MM-DDTHH:mm.');
        }

        const startDate = new Date(fromStr);
        const endDate = new Date(toStr);

        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            throw new Error('Invalid date values provided.');
        }

        if (startDate > endDate) {
            throw new Error('Start date must be before end date.');
        }

        const totalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;

        return {
            startDate: fromStr,
            endDate: toStr,
            totalDays
        };
    }

    // No from/to: use default 30 days
    const days = 30;

    // Calculate date range from days
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - (days - 1) * 24 * 60 * 60 * 1000);

    return {
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0],
        totalDays: days
    };
}

/**
 * Convert date range to Unix timestamps for API calls
 */
function dateRangeToTimestamps(dateRange: DateRange): { startTimestamp: number; endTimestamp: number } {
    const startTimestamp = Math.floor(new Date(dateRange.startDate).getTime() / 1000);
    const endTimestamp = Math.floor(new Date(dateRange.endDate + 'T23:59:59Z').getTime() / 1000);

    return { startTimestamp, endTimestamp };
}

/**
 * Filter data points to ensure they fall within the specified date range
 */
function filterDataByDateRange(data: FearIndexDataPoint[], dateRange: DateRange): FearIndexDataPoint[] {
    const { startTimestamp, endTimestamp } = dateRangeToTimestamps(dateRange);

    return data.filter(point => {
        const pointTimestamp = Number.parseInt(point.timestamp);
        return pointTimestamp >= startTimestamp && pointTimestamp <= endTimestamp;
    });
}

/**
 * Fetches fear and greed index data from CoinMarketCap API
 * @param daysOrOptions Number of days OR options object with period parameters
 * @returns Array of fear index data points
 */
export async function getFearAndGreedIndex(daysOrOptions: number | { [key: string]: unknown } = 30): Promise<FearIndexDataPoint[]> {
    let dateRange: DateRange;

    // Handle backward compatibility: if number is passed, use as days
    if (typeof daysOrOptions === 'number') {
        const days = Math.min(Math.max(daysOrOptions, 7), 365); // Limit to reasonable range
        const endDate = new Date();
        const startDate = new Date(endDate.getTime() - (days - 1) * 24 * 60 * 60 * 1000);

        dateRange = {
            startDate: startDate.toISOString().split('T')[0],
            endDate: endDate.toISOString().split('T')[0],
            totalDays: days
        };
    } else {
        // Parse period parameters from options and clamp by subscription/anonymous retention
        dateRange = parsePeriodParams(daysOrOptions);
        const retention = {
            dataRetentionDays: daysOrOptions.dataRetentionDays as number | undefined,
            dataRetentionMinDaysAgo: daysOrOptions.dataRetentionMinDaysAgo as number | undefined,
            dataRetentionMaxDaysAgo: daysOrOptions.dataRetentionMaxDaysAgo as number | undefined,
        };
        if (
            (typeof retention.dataRetentionDays === "number" && retention.dataRetentionDays >= 0) ||
            (typeof retention.dataRetentionMinDaysAgo === "number" && typeof retention.dataRetentionMaxDaysAgo === "number")
        ) {
            dateRange = clampDateRangeToRetention(dateRange, retention);
        }
    }
    try {
        console.log(`Fetching Fear & Greed Index data from ${dateRange.startDate} to ${dateRange.endDate} (${dateRange.totalDays} days)`);

        // For larger time periods, we need to use pagination
        const results: FearIndexDataPoint[] = [];
        const maxPerPage = 500; // API limit per page (max 500 as per documentation)

        // Calculate how many requests we need based on total days
        const totalRequests = Math.ceil(dateRange.totalDays / maxPerPage);
        
        for (let i = 0; i < totalRequests; i++) {
            // Calculate the limit for this request (max 500 per request)
            const limit = Math.min(maxPerPage, dateRange.totalDays - (i * maxPerPage));
            
            // Calculate the start parameter (1-based index for pagination)
            const start = i * maxPerPage + 1;
            
            const response = await httpClient.get(API_URL, {
                headers: {
                    'X-CMC_PRO_API_KEY': API_KEY
                },
                params: {
                    start: start,
                    limit: limit,
                    format: 'json'
                }
            });

            if (response.data && response.data.data) {
                // Add new results to our collection
                results.push(...response.data.data);
                
                // If we didn't get as many results as expected, break out of the loop
                if (response.data.data.length < limit) {
                    console.log(`Retrieved only ${response.data.data.length} records, possibly reached the earliest available data`);
                    break;
                }
            } else {
                throw new Error('Invalid response format from CoinMarketCap API');
            }
            
            // Add a small delay between requests to avoid rate limiting
            if (i < totalRequests - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        // Filter results to ensure they match the exact date range requested
        const filteredResults = filterDataByDateRange(results, dateRange);

        console.log(`Retrieved ${results.length} total records, ${filteredResults.length} within specified date range`);

        return filteredResults;
    } catch (error) {
        console.error('Error fetching fear and greed index:', error);
        throw error;
    }
}

function toCoinglassSymbol(symbol: string): string {
    const normalized = symbol.trim().toUpperCase();
    if (normalized.includes("-")) {
        const [base, quote] = normalized.split("-");
        if (quote === "USD") {
            return `${base}USDT`;
        }
        if (quote) {
            return `${base}${quote}`;
        }
    }

    if (normalized.endsWith("USD") && !normalized.endsWith("USDT")) {
        return `${normalized.slice(0, -3)}USDT`;
    }

    return normalized;
}

/**
 * Fetches cryptocurrency price data from CoinGlass
 */
async function getCryptoPriceData(symbol = "BTC-USD", days = 30): Promise<PriceDataPoint[]> {
    try {
        const apiKey = process.env.COINGLASS_API_KEY;
        if (!apiKey) {
            console.error("COINGLASS_API_KEY is not set");
            return [];
        }

        const endTime = Date.now();
        const startTime = endTime - (days + 5) * 24 * 60 * 60 * 1000;
        const limit = Math.min(1000, days + 5);

        const response = await httpClient.get(COINGLASS_API_URL, {
            headers: {
                accept: "application/json",
                "CG-API-KEY": apiKey
            },
            params: {
                exchange: COINGLASS_EXCHANGE,
                symbol: toCoinglassSymbol(symbol),
                interval: COINGLASS_INTERVAL,
                limit: limit,
                start_time: startTime,
                end_time: endTime
            }
        });

        const apiResponse: CoinglassPriceHistoryResponse = response.data;
        if (!apiResponse || apiResponse.code !== "0") {
            throw new Error(`CoinGlass API Error: ${apiResponse?.msg || "Unknown error"}`);
        }

        if (!apiResponse.data || apiResponse.data.length === 0) {
            return [];
        }

        return apiResponse.data
            .map(item => ({
                date: new Date(item.time).toISOString().split("T")[0],
                price: Number(item.close)
            }))
            .filter(item => Number.isFinite(item.price));
    } catch (error) {
        console.error(`Error fetching ${symbol} price data:`, error);
        return []; // Return empty array on error
    }
}

/**
 * Helper function to get full cryptocurrency name from code
 */
function getCryptoName(cryptoCode: string): string {
    const cryptoNames: { [key: string]: string } = {
        'BTC': 'Bitcoin',
        'ETH': 'Ethereum',
        'USDT': 'Tether',
        'USDC': 'USD Coin',
        'SOL': 'Solana',
        'XRP': 'XRP',
        'BNB': 'BNB',
        'DOGE': 'Dogecoin',
        'ADA': 'Cardano',
        'TRX': 'TRON',
        'AVAX': 'Avalanche',
        'SHIB': 'Shiba Inu',
        'MATIC': 'Polygon',
        'LTC': 'Litecoin',
        'UNI': 'Uniswap',
        'LINK': 'Chainlink',
        'BCH': 'Bitcoin Cash',
        'XLM': 'Stellar',
        'ATOM': 'Cosmos',
        'DOT': 'Polkadot'
    };
    
    return cryptoNames[cryptoCode] || cryptoCode;
}



