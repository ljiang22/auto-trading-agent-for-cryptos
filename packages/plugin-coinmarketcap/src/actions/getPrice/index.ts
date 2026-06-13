import {
    elizaLogger,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
    type Action,
    createActionResponse,
    createActionErrorResponse,
    generateActionSummary,
} from "@elizaos/core";
import { validateCoinMarketCapConfig } from "../../environment";
import { priceExamples } from "./examples";
import type {
    GetPriceContent,
    PriceData,
    ApiResponse,
} from "./types";
import { isGetPriceContent } from "./validation";
import { calculate52WeekHighLow, getHistoricalPrice } from "../../utils/coinglass";
import { identifyAsset } from "../../utils/cryptocurrencies";
import { httpClient } from "@elizaos/core";

// Simple in-memory cache to prevent duplicate API calls
interface CacheEntry {
    data: any;
    timestamp: number;
}

const apiCache = new Map<string, CacheEntry>();
const pendingRequests = new Map<string, Promise<any>>();
const CACHE_TTL = 30000; // 30 seconds cache TTL

// Fear & Greed Index API
interface FearIndexResponse {
    data: {
        value: number;
        value_classification: string;
        update_time: string;
    };
    status: {
        timestamp: string;
        error_code: number;
        error_message: string;
        elapsed: number;
        credit_count: number;
        notice: string;
    };
}

/**
 * Get cached data if available and not expired
 */
const getCachedData = (key: string): any | null => {
    const entry = apiCache.get(key);
    if (entry && (Date.now() - entry.timestamp) < CACHE_TTL) {
        elizaLogger.log(`Using cached data for key: ${key}`);
        return entry.data;
    }
    return null;
};

/**
 * Set data in cache
 */
const setCachedData = (key: string, data: any): void => {
    apiCache.set(key, {
        data,
        timestamp: Date.now()
    });
};

/**
 * Rounds a number to the specified number of decimal places
 */
const roundToDecimals = (num: number, decimals = 4): number => {
    return Number(num.toFixed(decimals));
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === "object" && value !== null;
};

const extractStringField = (
    source: Record<string, unknown> | undefined,
    keys: string[],
): string | undefined => {
    if (!source) {
        return undefined;
    }

    for (const key of keys) {
        const raw = source[key];

        if (typeof raw === "string" && raw.trim().length > 0) {
            return raw;
        }

        if (typeof raw === "number" && Number.isFinite(raw)) {
            return raw.toString();
        }

        if (Array.isArray(raw)) {
            const firstString = raw.find((value) => typeof value === "string" && value.trim().length > 0);
            if (firstString) {
                return firstString;
            }
        }
    }

    return undefined;
};

const DATE_REGEX = /(\d{4})-(\d{2})-(\d{2})/;

const formatRelativeDate = (days: number): string | null => {
    if (!Number.isFinite(days)) {
        return null;
    }

    const normalizedDays = Math.max(1, Math.ceil(days));
    if (normalizedDays <= 0) {
        return null;
    }

    const now = new Date();
    const baseUtc = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
    ));

    baseUtc.setUTCDate(baseUtc.getUTCDate() - normalizedDays);
    return baseUtc.toISOString().split("T")[0] ?? null;
};

const parseTimeframeToDate = (raw: string | undefined): string | null => {
    if (!raw) {
        return null;
    }

    const normalized = raw.trim().toLowerCase();
    if (!normalized || ["latest", "current", "now", "today"].includes(normalized)) {
        return null;
    }

    const relativePatterns: Array<{
        regex: RegExp;
        toDays: (value: number) => number;
    }> = [
        { regex: /(\d+)\s*(?:day|days|d)\b/, toDays: (value) => value },
        { regex: /(\d+)\s*(?:hour|hours|h)\b/, toDays: (value) => Math.max(1, value / 24) },
        { regex: /(\d+)\s*(?:week|weeks|w)\b/, toDays: (value) => value * 7 },
        { regex: /(\d+)\s*(?:month|months|mo)\b/, toDays: (value) => value * 30 },
        { regex: /(\d+)\s*(?:quarter|quarters|q)\b/, toDays: (value) => value * 90 },
        { regex: /(\d+)\s*(?:year|years|yr|y)\b/, toDays: (value) => value * 365 },
    ];

    for (const pattern of relativePatterns) {
        const match = pattern.regex.exec(normalized);
        if (match) {
            const rawValue = Number.parseInt(match[1], 10);
            if (Number.isFinite(rawValue) && rawValue > 0) {
                const days = pattern.toDays(rawValue);
                const formatted = formatRelativeDate(days);
                if (formatted) {
                    return formatted;
                }
            }
        }
    }

    const keywordPatterns: Array<{ regex: RegExp; days: number }> = [
        { regex: /\bday before yesterday\b/, days: 2 },
        { regex: /\byesterday\b/, days: 1 },
        { regex: /\b(last|past)\s+week\b/, days: 7 },
        { regex: /\b(last|past)\s+fortnight\b/, days: 14 },
        { regex: /\b(last|past)\s+month\b/, days: 30 },
        { regex: /\b(last|past)\s+quarter\b/, days: 90 },
        { regex: /\b(last|past)\s+year\b/, days: 365 },
    ];

    for (const keyword of keywordPatterns) {
        if (keyword.regex.test(normalized)) {
            const formatted = formatRelativeDate(keyword.days);
            if (formatted) {
                return formatted;
            }
        }
    }

    return null;
};

const normalizeDateString = (raw?: string | null): string | null => {
    if (!raw) {
        return null;
    }

    const trimmed = raw.trim();
    if (trimmed.length === 0) {
        return null;
    }

    const regexMatch = trimmed.match(DATE_REGEX);
    if (regexMatch) {
        const [, year, month, day] = regexMatch;
        return `${year}-${month}-${day}`;
    }

    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
        return null;
    }

    return parsed.toISOString().split("T")[0] ?? null;
};

const extractDateFromText = (text: string): string | null => {
    if (!text) {
        return null;
    }

    const match = text.match(DATE_REGEX);
    if (!match) {
        return null;
    }

    const [, year, month, day] = match;
    return `${year}-${month}-${day}`;
};

const toRoundedOrNull = (value: unknown): number | null => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return null;
    }

    return roundToDecimals(value);
};

const ensureRoundedNumber = (value: unknown, errorMessage: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(errorMessage);
    }

    return roundToDecimals(value);
};

/**
 * Fetch Fear & Greed Index from CoinMarketCap API
 */
async function getFearIndex(apiKey: string): Promise<FearIndexResponse> {
    const cacheKey = 'fear_index_latest';
    
    // Check if we have cached data
    const cachedEntry = getCachedData(cacheKey);
    if (cachedEntry) {
        elizaLogger.log('Using cached fear index data');
        return cachedEntry;
    }
    
    // Check if there's already a pending request
    const pendingRequest = pendingRequests.get(cacheKey);
    if (pendingRequest) {
        elizaLogger.log('Waiting for pending fear index request');
        return await pendingRequest;
    }
    
    // Create a new request promise
    const requestPromise = (async (): Promise<FearIndexResponse> => {
        try {
            const response = await httpClient.get("https://pro-api.coinmarketcap.com/v3/fear-and-greed/latest", {
                headers: {
                    'X-CMC_PRO_API_KEY': apiKey,
                    'Accept': 'application/json'
                }
            });
            
            if (response.status < 200 || response.status >= 300) {
                throw new Error(`Failed to fetch fear index: ${response.status} ${response.statusText}`);
            }
            
            const data: FearIndexResponse = response.data;
            
            // Cache the result
            setCachedData(cacheKey, data);
            
            return data;
        } catch (error) {
            elizaLogger.error('Error fetching fear index:', error);
            throw error;
        } finally {
            // Remove the pending request when done
            pendingRequests.delete(cacheKey);
        }
    })();
    
    // Store the pending request
    pendingRequests.set(cacheKey, requestPromise);
    
    // Return the result
    return await requestPromise;
}

/**
 * Fetch cryptocurrency price data from CoinMarketCap API
 */
async function getCryptoPriceData(
    symbol: string,
    currency: string,
    apiKey: string,
    includeFearIndex = false,
    requestedDate: string | null = null
): Promise<PriceData> {
    const normalizedSymbol = symbol.toUpperCase().trim();
    const normalizedCurrency = currency.toUpperCase().trim();
    const normalizedDate = requestedDate ?? null;
    const allowFearIndex = includeFearIndex && !normalizedDate;

    const dateKey = normalizedDate ? normalizedDate : "latest";
    const cacheKey = `price_${normalizedSymbol}_${normalizedCurrency}_${dateKey}_${allowFearIndex}`;

    const cachedData = getCachedData(cacheKey);
    if (cachedData) {
        return cachedData;
    }

    const pendingRequest = pendingRequests.get(cacheKey);
    if (pendingRequest) {
        elizaLogger.log(`Waiting for pending request for key: ${cacheKey}`);
        return await pendingRequest;
    }

    const requestPromise = (async () => {
        try {
            if (!normalizedDate) {
                const response = await httpClient.get(
                    `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${normalizedSymbol}&convert=${normalizedCurrency}`,
                    {
                        headers: {
                            'X-CMC_PRO_API_KEY': apiKey,
                            'Accept': 'application/json'
                        }
                    }
                );

                if (response.status < 200 || response.status >= 300) {
                    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
                }

                const apiResponse: ApiResponse = response.data;

                elizaLogger.log("API Response:", JSON.stringify(apiResponse, null, 2));

                const symbolData = apiResponse.data[normalizedSymbol];
                if (!symbolData) {
                    throw new Error(`No data found for symbol: ${normalizedSymbol}`);
                }

                const quoteData = symbolData.quote[normalizedCurrency];
                if (!quoteData) {
                    throw new Error(`No quote data found for currency: ${normalizedCurrency}`);
                }

                const highLow52w = await calculate52WeekHighLow(normalizedSymbol);

                let fearIndexData = {
                    fearIndex: null as number | null,
                    fearIndexClassification: null as string | null,
                    fearIndexUpdateTime: null as string | null
                };

                if (allowFearIndex) {
                    try {
                        const fearIndexResponse = await getFearIndex(apiKey);
                        fearIndexData = {
                            fearIndex: fearIndexResponse.data.value,
                            fearIndexClassification: fearIndexResponse.data.value_classification,
                            fearIndexUpdateTime: fearIndexResponse.data.update_time
                        };
                        elizaLogger.log("Fear Index Data:", fearIndexData);
                    } catch (fearError) {
                        elizaLogger.error("Error fetching fear index:", fearError);
                    }
                }

                const result: PriceData = {
                    price: ensureRoundedNumber(quoteData.price, `Invalid price returned for ${normalizedSymbol}`),
                    marketCap: toRoundedOrNull(quoteData.market_cap),
                    volume24h: toRoundedOrNull(quoteData.volume_24h),
                    percentChange24h: toRoundedOrNull(quoteData.percent_change_24h),
                    percentChange1h: toRoundedOrNull(quoteData.percent_change_1h),
                    percentChange7d: toRoundedOrNull(quoteData.percent_change_7d),
                    percentChange30d: toRoundedOrNull(quoteData.percent_change_30d),
                    fullyDilutedMarketCap: toRoundedOrNull(quoteData.fully_diluted_market_cap),
                    circulatingSupply: toRoundedOrNull(symbolData.circulating_supply),
                    totalSupply: toRoundedOrNull(symbolData.total_supply),
                    maxSupply: toRoundedOrNull(symbolData.max_supply),
                    lastUpdated: quoteData.last_updated,
                    high52w: highLow52w.high52w,
                    low52w: highLow52w.low52w,
                    fearIndex: fearIndexData.fearIndex,
                    fearIndexClassification: fearIndexData.fearIndexClassification,
                    fearIndexUpdateTime: fearIndexData.fearIndexUpdateTime,
                    requestedDate: null,
                    openPrice: null,
                    highPrice: null,
                    lowPrice: null,
                    closePrice: null,
                };

                setCachedData(cacheKey, result);

                return result;
            }

            const historical = await getHistoricalPrice(normalizedSymbol, normalizedCurrency, normalizedDate);

            const highLow52w = await calculate52WeekHighLow(normalizedSymbol);

            const result: PriceData = {
                price: ensureRoundedNumber(
                    historical.close ?? historical.open,
                    `Invalid historical price for ${normalizedSymbol} on ${normalizedDate}`,
                ),
                marketCap: toRoundedOrNull(historical.marketCap),
                volume24h: toRoundedOrNull(historical.volume),
                percentChange24h: null,
                percentChange1h: null,
                percentChange7d: null,
                percentChange30d: null,
                fullyDilutedMarketCap: toRoundedOrNull(historical.fullyDilutedMarketCap),
                circulatingSupply: null,
                totalSupply: null,
                maxSupply: null,
                lastUpdated: historical.timestamp || `${normalizedDate}T00:00:00Z`,
                high52w: highLow52w.high52w,
                low52w: highLow52w.low52w,
                fearIndex: null,
                fearIndexClassification: null,
                fearIndexUpdateTime: null,
                requestedDate: normalizedDate,
                openPrice: toRoundedOrNull(historical.open),
                highPrice: toRoundedOrNull(historical.high),
                lowPrice: toRoundedOrNull(historical.low),
                closePrice: toRoundedOrNull(historical.close),
            };

            setCachedData(cacheKey, result);

            return result;
        } catch (error) {
            elizaLogger.error("API Error:", error);
            throw new Error(`API Error: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            pendingRequests.delete(cacheKey);
        }
    })();

    pendingRequests.set(cacheKey, requestPromise);

    return await requestPromise;
}

export const getPrice: Action = {
    name: "GET_CRYPTO_PRICE",
    similes: [
        "CHECK_CRYPTO_PRICE",
        "CURRENT_PRICE",
        "LATEST_PRICE",
    ],
    description: "Get the current or a specific date price of a cryptocurrency from CoinMarketCap, with optional fear index when requested",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: { [key: string]: unknown },
        callback?: HandlerCallback
    ) => {
        elizaLogger.log("Starting CoinMarketCap GET_PRICE handler...");

        // Initialize or update state
        let currentState = state;
        if (!currentState) {
            currentState = (await runtime.composeState(message)) as State;
        } else {
            currentState = await runtime.updateRecentMessageState(currentState);
        }

        try {
            const symbolKeys = ["symbol", "asset", "ticker", "target", "coin", "crypto"];
            const currencyKeys = ["currency", "fiat", "convert"];
            const dateKeys = ["date", "priceDate", "requestedDate", "to", "from", "time", "timestamp", "asOf"];

            const optionsRecord = isRecord(options) ? (options as Record<string, unknown>) : undefined;
            const messageRecord = isRecord(message?.content)
                ? (message.content as unknown as Record<string, unknown>)
                : undefined;
            const metadataRecord = isRecord(messageRecord?.metadata)
                ? (messageRecord.metadata as Record<string, unknown>)
                : undefined;
            const actionDataRecord = isRecord(metadataRecord?.actionData)
                ? (metadataRecord.actionData as Record<string, unknown>)
                : undefined;
            const nestedContentRecord = isRecord(messageRecord?.content)
                ? (messageRecord.content as Record<string, unknown>)
                : undefined;
            const nestedDataRecord = isRecord(messageRecord?.data)
                ? (messageRecord.data as Record<string, unknown>)
                : undefined;

            let symbol =
                extractStringField(optionsRecord, ["target", "symbol"]) ??
                extractStringField(messageRecord, symbolKeys) ??
                extractStringField(metadataRecord, symbolKeys) ??
                extractStringField(actionDataRecord, symbolKeys) ??
                extractStringField(nestedContentRecord, symbolKeys) ??
                extractStringField(nestedDataRecord, symbolKeys);

            let currency =
                extractStringField(optionsRecord, ["currency"]) ??
                extractStringField(messageRecord, currencyKeys) ??
                extractStringField(metadataRecord, currencyKeys) ??
                extractStringField(actionDataRecord, currencyKeys) ??
                extractStringField(nestedContentRecord, currencyKeys) ??
                extractStringField(nestedDataRecord, currencyKeys);

            let requestedDate =
                extractStringField(optionsRecord, dateKeys) ??
                extractStringField(messageRecord, dateKeys) ??
                extractStringField(metadataRecord, dateKeys) ??
                extractStringField(actionDataRecord, dateKeys) ??
                extractStringField(nestedContentRecord, dateKeys) ??
                extractStringField(nestedDataRecord, dateKeys);

            // Handle explicit from/to date range parameters - use 'to' as the requested date
            // This ensures consistency with other actions that use from/to for date ranges
            if (!requestedDate && optionsRecord?.from && optionsRecord?.to) {
                const fromStr = String(optionsRecord.from).trim().slice(0, 10);
                const toStr = String(optionsRecord.to).trim().slice(0, 10);
                const fromDate = new Date(fromStr + 'T00:00:00.000Z');
                const toDate = new Date(toStr + 'T23:59:59.999Z');
                
                if (!isNaN(fromDate.getTime()) && !isNaN(toDate.getTime()) && fromDate <= toDate) {
                    // For price queries, use the 'to' date as the target date
                    requestedDate = toStr;
                    elizaLogger.log(`📅 Using from/to parameters: ${fromStr} to ${toStr} -> requesting price for ${toStr}`);
                }
            }

            const rawMessageText = (message?.content?.text ?? "").toString();

            if (!symbol || symbol.trim().length === 0) {
                if (rawMessageText) {
                    symbol = identifyAsset(rawMessageText, "BTC");
                    elizaLogger.log(`Using detected asset from text - Symbol: ${symbol}`);
                } else {
                    symbol = "BTC";
                    elizaLogger.log("No symbol provided; defaulting to BTC");
                }
            }

            if (!currency || currency.trim().length === 0) {
                let detectedCurrency = "USD";
                const normalizedText = rawMessageText.toLowerCase();
                const currencyPatterns = [
                    { pattern: /\b(?:usd|dollar|dollars|\$)\b/i, currency: "USD" },
                    { pattern: /\b(?:eur|euro|euros|€)\b/i, currency: "EUR" },
                    { pattern: /\b(?:gbp|pound|pounds|£)\b/i, currency: "GBP" },
                    { pattern: /\b(?:jpy|yen|¥)\b/i, currency: "JPY" },
                    { pattern: /\b(?:cad|canadian)\b/i, currency: "CAD" },
                    { pattern: /\b(?:aud|australian)\b/i, currency: "AUD" },
                    { pattern: /\b(?:chf|swiss)\b/i, currency: "CHF" },
                    { pattern: /\b(?:cny|yuan|rmb)\b/i, currency: "CNY" }
                ];

                for (const { pattern, currency: detected } of currencyPatterns) {
                    if (pattern.test(normalizedText)) {
                        detectedCurrency = detected;
                        break;
                    }
                }

                currency = detectedCurrency;
            }

            const normalizedSymbol = symbol.toUpperCase().trim();
            const normalizedCurrency = currency.toUpperCase().trim();

            if (!requestedDate || requestedDate.trim().length === 0) {
                if (rawMessageText) {
                    const dateFromText = parseTimeframeToDate(rawMessageText);
                    if (dateFromText) {
                        requestedDate = dateFromText;
                        elizaLogger.log(`Detected date in message text; using historical date ${requestedDate}`);
                    }
                }

                if (!requestedDate || requestedDate.trim().length === 0) {
                    const detectedDate = extractDateFromText(rawMessageText);
                    if (detectedDate) {
                        requestedDate = detectedDate;
                    }
                }
            }

            let normalizedDate = normalizeDateString(requestedDate);

            // Clamp historical date to subscription/anonymous data retention window
            const dataRetentionDays = typeof optionsRecord?.dataRetentionDays === "number" ? optionsRecord.dataRetentionDays : undefined;
            const minDaysAgo = typeof optionsRecord?.dataRetentionMinDaysAgo === "number" ? optionsRecord.dataRetentionMinDaysAgo : undefined;
            const maxDaysAgo = typeof optionsRecord?.dataRetentionMaxDaysAgo === "number" ? optionsRecord.dataRetentionMaxDaysAgo : undefined;
            if (normalizedDate && (typeof dataRetentionDays === "number" || (typeof minDaysAgo === "number" && typeof maxDaysAgo === "number"))) {
                const today = new Date();
                today.setUTCHours(23, 59, 59, 999);
                const requested = new Date(normalizedDate + "T00:00:00Z");
                if (typeof minDaysAgo === "number" && typeof maxDaysAgo === "number" && maxDaysAgo > minDaysAgo) {
                    const windowStart = new Date(today);
                    windowStart.setUTCDate(windowStart.getUTCDate() - maxDaysAgo);
                    const windowEnd = new Date(today);
                    windowEnd.setUTCDate(windowEnd.getUTCDate() - minDaysAgo);
                    if (requested.getTime() < windowStart.getTime()) {
                        normalizedDate = windowStart.toISOString().split("T")[0];
                        elizaLogger.log(`Historical date clamped to anonymous window (earliest): ${normalizedDate}`);
                    } else if (requested.getTime() > windowEnd.getTime()) {
                        normalizedDate = windowEnd.toISOString().split("T")[0];
                        elizaLogger.log(`Historical date clamped to anonymous window (latest): ${normalizedDate}`);
                    }
                } else if (typeof dataRetentionDays === "number" && dataRetentionDays >= 1) {
                    const earliest = new Date(today);
                    earliest.setUTCDate(earliest.getUTCDate() - dataRetentionDays);
                    if (requested.getTime() < earliest.getTime()) {
                        normalizedDate = earliest.toISOString().split("T")[0];
                        elizaLogger.log(`Historical date clamped to data retention window: ${normalizedDate}`);
                    }
                }
            }

            if (normalizedDate) {
                elizaLogger.log(`Historical date requested: ${normalizedDate}`);
            }

            const content: GetPriceContent = {
                text: `Get price for ${normalizedSymbol} in ${normalizedCurrency}`,
                symbol: normalizedSymbol,
                currency: normalizedCurrency,
                date: normalizedDate,
            };

            if (!isGetPriceContent(content)) {
                throw new Error("Invalid price check content");
            }

            elizaLogger.log(`Using structured parameters - Symbol: ${content.symbol}, Currency: ${content.currency}`);

            // Get price from CoinMarketCap
            const config = await validateCoinMarketCapConfig(runtime);

            // Check if fear index is specifically requested
            const messageText = rawMessageText.toLowerCase();
            const fearIndexTerms = [
                "fear index", "fear and greed", "market sentiment", "greed index"
            ];
            const fearIndexPatterns = [
                /fear (?:and )?greed/i,
                /market sentiment/i,
                /fear index/i,
                /greed index/i
            ];
            
            const hasFearIndexTerms = fearIndexTerms.some(term => messageText.includes(term));
            const hasFearIndexPatternMatch = fearIndexPatterns.some(pattern => pattern.test(messageText));
            const includeFearIndex = !normalizedDate && (hasFearIndexTerms || hasFearIndexPatternMatch);
            
            elizaLogger.log(`Fear index requested: ${includeFearIndex}`);

            try {
                const priceData = await getCryptoPriceData(
                    content.symbol,
                    content.currency,
                    config.COINMARKETCAP_API_KEY,
                    includeFearIndex,
                    normalizedDate
                );

                elizaLogger.success(
                    `Price retrieved successfully! ${content.symbol}: ${priceData.price} ${content.currency.toUpperCase()}`
                );

                const formatNumber = (value: number | null): string => {
                    return value !== null ? value.toString() : "N/A";
                };

                const formatPercent = (value: number | null): string => {
                    return value !== null ? `${value}%` : "N/A";
                };

                const currencyCode = content.currency.toUpperCase();
                const formatCurrency = (value: number | null): string => {
                    return value !== null ? `${formatNumber(value)} ${currencyCode}` : "N/A";
                };

                const lines: string[] = [];

                if (priceData.requestedDate) {
                    lines.push(`Historical price data for ${content.symbol} on ${priceData.requestedDate}:`);
                    lines.push(`- Close Price: ${formatCurrency(priceData.price)}`);
                    if (priceData.openPrice !== null) {
                        lines.push(`- Open Price: ${formatCurrency(priceData.openPrice)}`);
                    }
                    if (priceData.highPrice !== null) {
                        lines.push(`- High Price: ${formatCurrency(priceData.highPrice)}`);
                    }
                    if (priceData.lowPrice !== null) {
                        lines.push(`- Low Price: ${formatCurrency(priceData.lowPrice)}`);
                    }
                } else {
                    lines.push(`Current price data for ${content.symbol}:`);
                    lines.push(`- Price: ${formatCurrency(priceData.price)}`);
                }

                lines.push(`- Volume (24h): ${formatCurrency(priceData.volume24h)}`);

                if (!priceData.requestedDate) {
                    lines.push(`- Change (1h): ${formatPercent(priceData.percentChange1h)}`);
                    lines.push(`- Change (24h): ${formatPercent(priceData.percentChange24h)}`);
                    lines.push(`- Change (7d): ${formatPercent(priceData.percentChange7d)}`);
                    lines.push(`- Change (30d): ${formatPercent(priceData.percentChange30d)}`);
                }
                lines.push(`- Last Updated: ${priceData.lastUpdated}`);
                // M4 — surface the data source + freshness flag so users
                // can tell at a glance whether the quote is live or a
                // potentially-stale CMC cache hit. Plan §M4.
                lines.push(`- Source: CoinMarketCap`);
                try {
                    const updatedAtMs = priceData.lastUpdated
                        ? Date.parse(priceData.lastUpdated)
                        : Number.NaN;
                    if (Number.isFinite(updatedAtMs)) {
                        const ageSec = Math.max(0, Math.round((Date.now() - updatedAtMs) / 1000));
                        const freshness =
                            ageSec <= 120 ? "fresh"
                            : ageSec <= 600 ? "recent"
                            : "stale";
                        const ageLabel =
                            ageSec < 60 ? `${ageSec}s`
                            : ageSec < 3600 ? `${Math.round(ageSec / 60)}m`
                            : `${Math.round(ageSec / 3600)}h`;
                        lines.push(`- Freshness: ${freshness} (age ${ageLabel})`);
                    }
                } catch {
                    /* ignore unparseable timestamps */
                }

                if (priceData.high52w !== null || priceData.low52w !== null) {
                    lines.push(`- 52w High: ${priceData.high52w !== null ? formatCurrency(priceData.high52w) : 'N/A'}`);
                    lines.push(`- 52w Low: ${priceData.low52w !== null ? formatCurrency(priceData.low52w) : 'N/A'}`);
                }

                if (!priceData.requestedDate && priceData.fearIndex !== null) {
                    lines.push(`- Fear & Greed Index: ${priceData.fearIndex} (${priceData.fearIndexClassification ?? 'N/A'})`);
                }

                const formattedMessage = lines.join("\n");

                // Generate action summary
                const timePeriod = priceData.requestedDate 
                    ? priceData.requestedDate 
                    : 'current';
                const priceInfo = priceData.requestedDate
                    ? `historical price ${formatCurrency(priceData.price)}`
                    : `current price ${formatCurrency(priceData.price)}`;
                const changeInfo = !priceData.requestedDate && priceData.percentChange24h !== null
                    ? `24h change ${formatPercent(priceData.percentChange24h)}`
                    : '';
                const additionalInfo = [priceInfo, changeInfo].filter(Boolean).join(', ');
                
                const actionSummary = generateActionSummary({
                    actionName: 'Get Crypto Price',
                    assets: [content.symbol],
                    timePeriod: timePeriod,
                    dataPoints: 1,
                    additionalInfo: additionalInfo || undefined
                });

                // Use callback for comprehensive analysis compatibility
                if (callback) {
                    await callback(createActionResponse({
                        actionName: "GET_CRYPTO_PRICE",
                        type: "get_crypto_price",
                        text: formattedMessage,
                        content: {
                            symbol: content.symbol,
                            currency: content.currency,
                            date: content.date ?? null,
                            ...priceData,
                        },
                        actionData: {
                            symbol: content.symbol,
                            currency: content.currency,
                            date: content.date ?? null,
                            summary: actionSummary,
                            ...priceData,
                        },
                        symbol: content.symbol,
                        currency: content.currency,
                    }));
                    return true; // Indicate success
                }
                
                // Fallback to return for non-callback usage
                return {
                    text: formattedMessage,
                    content: {
                        symbol: content.symbol,
                        currency: content.currency,
                        date: content.date ?? null,
                        ...priceData,
                    }
                };
            } catch (error) {
                elizaLogger.error("Error in GET_PRICE handler:", error);
                
                // Use callback for error handling if available
                if (callback) {
                    await callback(createActionErrorResponse({
                        actionName: "GET_CRYPTO_PRICE",
                        type: "get_crypto_price_error",
                        error: error instanceof Error ? error : new Error(String(error)),
                        text: `Error fetching price: ${error.message}`,
                    }));
                    return false; // Indicate failure
                }
                
                // Fallback to return for non-callback usage
                return {
                    text: `Error fetching price: ${error.message}`,
                    content: { error: error.message }
                };
            }
        } catch (error) {
            elizaLogger.error("Error in GET_PRICE handler:", error);
            
            // Use callback for outer error handling if available
            if (callback) {
                await callback(createActionErrorResponse({
                    actionName: "GET_CRYPTO_PRICE",
                    type: "get_crypto_price_error",
                    error: error instanceof Error ? error : new Error(String(error)),
                    text: `Error fetching price: ${error.message}`,
                }));
                return false; // Indicate failure
            }
            
            // Fallback to return for non-callback usage
            return {
                text: `Error fetching price: ${error.message}`,
                content: { error: error.message }
            };
        }
    },
    examples: priceExamples,
    cacheConfig: {
        enabled: true,
        ttlSeconds: 300, // 5 minutes for price data
        similarityThreshold: 0.7,
        maxChunkSize: 200,
    },
} as Action;

export default getPrice;
