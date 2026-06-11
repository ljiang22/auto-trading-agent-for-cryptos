import { elizaLogger, httpClient } from "@elizaos/core";

// Simple in-memory caches for CoinGlass price data
interface HighLowCacheEntry {
    data: { high52w: number | null; low52w: number | null };
    timestamp: number;
}

interface HistoricalCacheEntry {
    data: HistoricalPriceResult;
    timestamp: number;
}

const highLowCache = new Map<string, HighLowCacheEntry>();
const pendingHighLowRequests = new Map<string, Promise<{ high52w: number | null; low52w: number | null }>>();
const historicalCache = new Map<string, HistoricalCacheEntry>();
const pendingHistoricalRequests = new Map<string, Promise<HistoricalPriceResult>>();

const CACHE_TTL = 300000; // 5 minutes cache TTL for price data
const COINGLASS_API_URL = "https://open-api-v4.coinglass.com/api/futures/price/history";
const COINGLASS_EXCHANGE = "Binance";
const COINGLASS_INTERVAL = "1d";

interface CoinglassPricePoint {
    time: number;
    open: string;
    high: string;
    low: string;
    close: string;
    volume_usd: string;
}

interface CoinglassPriceHistoryResponse {
    code: string;
    msg?: string;
    data?: CoinglassPricePoint[];
}

const toCoinglassSymbol = (symbol: string, currency = "USD"): string => {
    const normalizedBase = symbol.trim().toUpperCase();
    const normalizedQuote = currency.trim().toUpperCase();
    if (normalizedQuote === "USD") {
        return `${normalizedBase}USDT`;
    }
    return `${normalizedBase}${normalizedQuote}`;
};

/**
 * Rounds a number to the specified number of decimal places
 */
const roundToDecimals = (num: number, decimals = 4): number => {
    return Number(num.toFixed(decimals));
};

/**
 * Get cached 52-week high/low data if available and not expired
 */
const getCachedHighLow = (key: string): { high52w: number | null; low52w: number | null } | null => {
    const entry = highLowCache.get(key);
    if (entry && (Date.now() - entry.timestamp) < CACHE_TTL) {
        elizaLogger.log(`Using cached 52w high/low data for key: ${key}`);
        return entry.data;
    }
    return null;
};

/**
 * Set 52-week high/low data in cache
 */
const setCachedHighLow = (key: string, data: { high52w: number | null; low52w: number | null }): void => {
    highLowCache.set(key, {
        data,
        timestamp: Date.now()
    });
};

/**
 * Calculates 52-week high and low from CoinGlass historical data
 */
export async function calculate52WeekHighLow(symbol: string): Promise<{ high52w: number | null; low52w: number | null }> {
    const cacheKey = `52w_${symbol.toUpperCase()}`;
    
    // Check if we have cached data
    const cachedData = getCachedHighLow(cacheKey);
    if (cachedData) {
        return cachedData;
    }
    
    // Check if there's already a pending request
    const pendingRequest = pendingHighLowRequests.get(cacheKey);
    if (pendingRequest) {
        elizaLogger.log(`Waiting for pending 52w high/low request for: ${symbol}`);
        return await pendingRequest;
    }
    
    // Create a new request promise
    const requestPromise = (async (): Promise<{ high52w: number | null; low52w: number | null }> => {
        try {
            const apiKey = process.env.COINGLASS_API_KEY;
            if (!apiKey) {
                elizaLogger.error("COINGLASS_API_KEY environment variable is required");
                return { high52w: null, low52w: null };
            }

            const coinglassSymbol = toCoinglassSymbol(symbol);

            const now = Date.now();
            const oneYearAgo = now - 365 * 24 * 60 * 60 * 1000;
            const limit = Math.min(1000, 365 + 5);

            elizaLogger.log(`Fetching 52w data for ${coinglassSymbol}`);

            const response = await httpClient.get(COINGLASS_API_URL, {
                headers: {
                    accept: "application/json",
                    "CG-API-KEY": apiKey,
                },
                params: {
                    exchange: COINGLASS_EXCHANGE,
                    symbol: coinglassSymbol,
                    interval: COINGLASS_INTERVAL,
                    limit,
                    start_time: oneYearAgo,
                    end_time: now,
                },
            });

            const apiResponse: CoinglassPriceHistoryResponse = response.data;
            if (!apiResponse || apiResponse.code !== "0") {
                elizaLogger.warn(`CoinGlass API error for ${coinglassSymbol}: ${apiResponse?.msg || "Unknown error"}`);
                return { high52w: null, low52w: null };
            }

            const data = apiResponse.data ?? [];
            if (data.length === 0) {
                elizaLogger.warn(`No 52w data available for ${coinglassSymbol}`);
                return { high52w: null, low52w: null };
            }

            const highValues = data.map(item => Number(item.high)).filter(val => Number.isFinite(val));
            const lowValues = data.map(item => Number(item.low)).filter(val => Number.isFinite(val));
            
            if (highValues.length === 0 || lowValues.length === 0) {
                elizaLogger.warn(`No valid high/low values found for ${coinglassSymbol}`);
                return { high52w: null, low52w: null };
            }
            
            const high52w = Math.max(...highValues);
            const low52w = Math.min(...lowValues);
            
            const resultData = {
                high52w: isFinite(high52w) ? roundToDecimals(high52w) : null,
                low52w: isFinite(low52w) ? roundToDecimals(low52w) : null
            };
            
            elizaLogger.log(`52w high/low for ${symbol}: High=${resultData.high52w}, Low=${resultData.low52w}`);
            
            // Cache the result
            setCachedHighLow(cacheKey, resultData);
            
            return resultData;
        } catch (error) {
            elizaLogger.error(`Error calculating 52-week high/low for ${symbol}:`, error);
            return { high52w: null, low52w: null };
        } finally {
            // Remove the pending request when done
            pendingHighLowRequests.delete(cacheKey);
        }
    })();

    // Store the pending request
    pendingHighLowRequests.set(cacheKey, requestPromise);

    // Return the result
    return await requestPromise;
}

export interface HistoricalPriceResult {
    open: number | null;
    high: number | null;
    low: number | null;
    close: number | null;
    volume: number | null;
    marketCap: number | null;
    fullyDilutedMarketCap: number | null;
    timestamp: string;
}

const getCachedHistorical = (key: string): HistoricalPriceResult | null => {
    const entry = historicalCache.get(key);
    if (entry && (Date.now() - entry.timestamp) < CACHE_TTL) {
        elizaLogger.log(`Using cached historical price for key: ${key}`);
        return entry.data;
    }
    return null;
};

const setCachedHistorical = (key: string, data: HistoricalPriceResult): void => {
    historicalCache.set(key, {
        data,
        timestamp: Date.now(),
    });
};

export async function getHistoricalPrice(
    symbol: string,
    currency: string,
    date: string,
): Promise<HistoricalPriceResult> {
    const upperSymbol = symbol.toUpperCase();
    const upperCurrency = currency.toUpperCase();
    const cacheKey = `historical_${upperSymbol}_${upperCurrency}_${date}`;

    const cached = getCachedHistorical(cacheKey);
    if (cached) {
        return cached;
    }

    const pending = pendingHistoricalRequests.get(cacheKey);
    if (pending) {
        elizaLogger.log(`Waiting for pending historical price request for: ${cacheKey}`);
        return await pending;
    }

    const requestPromise = (async (): Promise<HistoricalPriceResult> => {
        try {
            const apiKey = process.env.COINGLASS_API_KEY;
            if (!apiKey) {
                throw new Error("COINGLASS_API_KEY environment variable is required");
            }

            const coinglassSymbol = toCoinglassSymbol(upperSymbol, upperCurrency);

            const startDate = new Date(`${date}T00:00:00Z`);
            if (Number.isNaN(startDate.getTime())) {
                throw new Error(`Invalid date provided: ${date}`);
            }

            const startTime = startDate.getTime();
            const endTime = startTime + 24 * 60 * 60 * 1000 - 1;

            elizaLogger.log(`Fetching historical price for ${coinglassSymbol} on ${date}`);

            const response = await httpClient.get(COINGLASS_API_URL, {
                headers: {
                    accept: "application/json",
                    "CG-API-KEY": apiKey,
                },
                params: {
                    exchange: COINGLASS_EXCHANGE,
                    symbol: coinglassSymbol,
                    interval: COINGLASS_INTERVAL,
                    limit: 2,
                    start_time: startTime,
                    end_time: endTime,
                },
            });

            const apiResponse: CoinglassPriceHistoryResponse = response.data;
            if (!apiResponse || apiResponse.code !== "0") {
                throw new Error(`CoinGlass API Error: ${apiResponse?.msg || "Unknown error"}`);
            }

            const data = apiResponse.data ?? [];
            if (data.length === 0) {
                throw new Error(`No historical data returned for ${coinglassSymbol} on ${date}`);
            }

            const entry = data.find(item => {
                const normalized = new Date(item.time).toISOString().split("T")[0];
                return normalized === date;
            }) ?? data[0];

            const normalizeNumber = (value: string): number | null => {
                const parsed = Number(value);
                if (!Number.isFinite(parsed)) {
                    return null;
                }
                return roundToDecimals(parsed);
            };

            const normalizedEntry: HistoricalPriceResult = {
                open: normalizeNumber(entry.open),
                high: normalizeNumber(entry.high),
                low: normalizeNumber(entry.low),
                close: normalizeNumber(entry.close),
                volume: normalizeNumber(entry.volume_usd),
                marketCap: null,
                fullyDilutedMarketCap: null,
                timestamp: new Date(entry.time).toISOString(),
            };

            setCachedHistorical(cacheKey, normalizedEntry);

            return normalizedEntry;
        } catch (error) {
            elizaLogger.error(`Error fetching historical price for ${symbol}-${currency} on ${date}:`, error);
            throw error;
        } finally {
            pendingHistoricalRequests.delete(cacheKey);
        }
    })();

    pendingHistoricalRequests.set(cacheKey, requestPromise);

    return await requestPromise;
}
