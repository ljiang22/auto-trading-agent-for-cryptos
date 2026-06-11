import {
    type Action,
    type ActionExample,
    type IAgentRuntime,
    type Memory,
    type State,
    type HandlerCallback,
    formatMessages,
    elizaLogger,
    createActionResponse,
    generateActionSummary,
    formatLargeNumber as formatLargeNumberUtil,
    createActionErrorResponse,
    buildChartProxyUrl,
} from "@elizaos/core";
import fs from 'fs';
import path from 'path';
import { getCryptoInfo, cryptoCategories, getExchangeInfo, DEFAULT_EXCHANGE, isValidExchange } from '../utils';
import { httpClient, formatAxiosErrorLine } from "@elizaos/core";

/**
 * Helper function to get full cryptocurrency name from code
 */
function getCryptoFullName(cryptoCode: string): string {
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
    
    return cryptoNames[cryptoCode.toUpperCase()] || cryptoCode.toUpperCase();
}

/**
 * Aggregated Transaction Volume Analysis (Taker Buy/Sell Volume)
 * 
 * This module uses aggregated taker buy/sell volume data to analyze market trading patterns:
 * 
 * COINGLASS API (/api/futures/aggregated-taker-buy-sell-volume/history)
 * - Primary data source for transaction volume analysis
 * - Buy volume represents aggressive buying (taker buys)
 * - Sell volume represents aggressive selling (taker sells)
 * - Data structure: [{ aggregated_buy_volume_usd, aggregated_sell_volume_usd, time }],
 * - Used for: Trading direction analysis, market momentum, buyer/seller aggression
 * 
 * Enhanced Analysis Features:
 * - Buy/sell volume ratio calculations
 * - Trading momentum analysis
 * - Volume trend analysis
 * - Market aggression indicators
 * - Interactive Chart.js visualizations
 * - Mermaid flow diagrams
 * 
 * Supported Parameters:
 * - symbol: string (required) - Trading pair (e.g., BTC)
 * - exchange_list: string - List of exchange names (e.g., 'Binance, OKX, Bybit') 
 * - interval: string - Time interval (1m, 3m, 5m, 15m, 30m, 1h, 4h, 6h, 8h, 12h, 1d, 1w) - defaults to 1d
 * - limit: int32 - Number of results per request (default: 1000, max: 4500)
 * - start_time: int64 - Start timestamp in milliseconds (defaults to 100 days ago in comprehensive analysis)
 * - end_time: int64 - End timestamp in milliseconds (defaults to current time in comprehensive analysis)
 * - unit: string - Unit for returned data ('usd' or 'coin')
 */

// Types for taker buy/sell volume data
export interface TakerVolumePoint {
    aggregated_buy_volume_usd: number;    // Aggregated buy volume (USD)
    aggregated_sell_volume_usd: number;   // Aggregated sell volume (USD)
    time: number;                         // Timestamp (milliseconds)
    // Basic derived metrics
    total_volume: number;        // Total trading volume
    buy_sell_ratio: number;      // Buy to sell ratio
    buy_dominance: number;       // Buy volume percentage
    sell_dominance: number;      // Sell volume percentage
}

export interface TakerVolumeResponse {
    code: string;
    msg: string;
    data: TakerVolumePoint[];
}

// Simplified analysis interface for chart focus
export interface TakerVolumeAnalysis {
    symbol: string;
    exchange: string; // Legacy single exchange (for backward compatibility)
    exchanges: string[]; // New: array of exchanges for multi-exchange analysis
    isMultiExchange: boolean; // Flag to indicate if this is aggregated data
    latestData: TakerVolumePoint;
    historicalData: TakerVolumePoint[];
    analysis: {
        marketSentiment: string;
        dominantTrading: string;
        buyVolume: number;           // Total buy volume (aggregated across exchanges)
        sellVolume: number;          // Total sell volume (aggregated across exchanges)
        totalVolume: number;         // Total trading volume (aggregated across exchanges)
        buyDominance: number;        // Buy dominance percentage
        sellDominance: number;       // Sell dominance percentage
        buySellRatio: number;        // Buy to sell ratio
        avgVolume: number;           // Average volume
        cryptoInfo: {
            name: string;
            category: string;
            tier: string;
        };
        exchangeInfo: {
            name: string;            // Primary exchange name or "Multi-Exchange"
            region: string;          // Primary exchange region or "Global"
            tier: string;            // Primary exchange tier or "Mixed"
            type: string;            // Primary exchange type or "Aggregated"
            count?: number;          // Number of exchanges (for multi-exchange)
            list?: string[];         // List of exchange names (for multi-exchange)
        };
    };
    // Chart visualization data
    chartData?: {
        labels: string[];
        buyVolumeData: number[];
        sellVolumeData: number[];
        ratioData: number[];
    };
}

export interface TakerVolumeResult {
    success: boolean;
    data?: TakerVolumeAnalysis;
    error?: string;
}

// Utility function to format large numbers
function formatLargeNumber(num: number): string {
    if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
    return num.toFixed(2);
}

// Function to parse exchange from user query (legacy - for single exchange)
function parseExchange(messageText: string): string {
    const exchanges = parseExchanges(messageText);
    return exchanges.length > 0 ? exchanges[0] : DEFAULT_EXCHANGE;
}

// Enhanced function to parse multiple exchanges from user query
function parseExchanges(messageText: string): string[] {
    const text = messageText.toLowerCase();
    
    const exchangeKeywords = [
        'binance', 'coinbase', 'kraken', 'bybit', 'okx', 'kucoin', 'huobi', 'bitget',
        'gemini', 'bitfinex', 'bitstamp', 'crypto.com', 'gate.io', 'mexc', 'bitmex', 'deribit'
    ];
    
    const foundExchanges: string[] = [];
    
    // Look for explicit multiple exchanges patterns
    const multiExchangePatterns = [
        // "binance and okx"
        /(?:^|\s)((?:binance|coinbase|kraken|bybit|okx|kucoin|huobi|bitget|gemini|bitfinex|bitstamp|crypto\.com|gate\.io|mexc|bitmex|deribit)(?:\s*(?:and|,|\+)\s*(?:binance|coinbase|kraken|bybit|okx|kucoin|huobi|bitget|gemini|bitfinex|bitstamp|crypto\.com|gate\.io|mexc|bitmex|deribit))*)/gi,
        // "on binance, okx, and bybit"
        /(?:on|from|across)\s+((?:binance|coinbase|kraken|bybit|okx|kucoin|huobi|bitget|gemini|bitfinex|bitstamp|crypto\.com|gate\.io|mexc|bitmex|deribit)(?:\s*(?:,|and|\+)\s*(?:binance|coinbase|kraken|bybit|okx|kucoin|huobi|bitget|gemini|bitfinex|bitstamp|crypto\.com|gate\.io|mexc|bitmex|deribit))*)/gi
    ];
    
    // Try multi-exchange patterns first
    for (const pattern of multiExchangePatterns) {
        const matches = text.match(pattern);
        if (matches) {
            for (const match of matches) {
                // Extract individual exchanges from the matched string
                for (const exchange of exchangeKeywords) {
                    if (match.includes(exchange) && !foundExchanges.includes(exchange)) {
                        foundExchanges.push(exchange);
                    }
                }
            }
        }
    }
    
    // If no multi-exchange pattern found, look for individual exchanges
    if (foundExchanges.length === 0) {
        // Check for keywords like "all exchanges", "multiple exchanges", "aggregate"
        if (text.includes('all exchanges') || text.includes('multiple exchanges') || 
            text.includes('aggregate') || text.includes('combined') || text.includes('across exchanges')) {
            // Return top exchanges for aggregation
            return ['Binance', 'OKX', 'Bybit', 'Coinbase'];
        }
        
        // Look for single exchange
        for (const exchange of exchangeKeywords) {
            if (text.includes(exchange)) {
                foundExchanges.push(exchange);
                break; // Only add first found for single exchange mode
            }
        }
    }
    
    // If still no exchanges found, use default
    if (foundExchanges.length === 0) {
        foundExchanges.push(DEFAULT_EXCHANGE);
    }
    
    // Capitalize exchange names properly
    return foundExchanges.map(exchange => {
        switch (exchange.toLowerCase()) {
            case 'binance': return 'Binance';
            case 'okx': return 'OKX';
            case 'bybit': return 'Bybit';
            case 'coinbase': return 'Coinbase';
            case 'kraken': return 'Kraken';
            case 'kucoin': return 'KuCoin';
            case 'huobi': return 'Huobi';
            case 'bitget': return 'Bitget';
            case 'gemini': return 'Gemini';
            case 'bitfinex': return 'Bitfinex';
            case 'bitstamp': return 'Bitstamp';
            case 'crypto.com': return 'Crypto.com';
            case 'gate.io': return 'Gate.io';
            case 'mexc': return 'MEXC';
            case 'bitmex': return 'BitMEX';
            case 'deribit': return 'Deribit';
            default: return exchange;
        }
    });
}

// Function to parse cryptocurrency symbol from user query
function parseCryptoSymbol(messageText: string): string {
    const text = messageText.toUpperCase();
    
    const cryptoSymbols = Object.keys(cryptoCategories);
    
    // First, look for exact word boundary matches for symbols
    for (const symbol of cryptoSymbols) {
        const regex = new RegExp(`\\b${symbol}\\b`, 'g');
        if (regex.test(text)) {
            return symbol;
        }
    }
    
    const nameToSymbol: Record<string, string> = {};
    Object.values(cryptoCategories).forEach(crypto => {
        nameToSymbol[crypto.name.toUpperCase()] = crypto.symbol;
    });
    
    // Look for exact word boundary matches for crypto names
    for (const [name, symbol] of Object.entries(nameToSymbol)) {
        const regex = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
        if (regex.test(text)) {
            return symbol;
        }
    }
    
    // Fallback: look for symbols as substrings (less precise, but covers edge cases)
    for (const symbol of cryptoSymbols) {
        if (text.includes(symbol)) {
            return symbol;
        }
    }
    
    return 'BTC';
}

// Function to parse timestamp parameters from user query
function parseTimestampParams(messageText: string): { start_time?: number; end_time?: number } {
    const text = messageText.toLowerCase();
    let start_time: number | undefined;
    let end_time: number | undefined;
    
    // First check for explicit timestamps (13-digit milliseconds)
    const timestampRegex = /(\d{13})/g;
    const timestamps = text.match(timestampRegex);
    
    if (timestamps) {
        if (timestamps.length >= 2) {
            start_time = Number.parseInt(timestamps[0]);
            end_time = Number.parseInt(timestamps[1]);
        } else {
            end_time = Number.parseInt(timestamps[0]);
            start_time = end_time - (24 * 60 * 60 * 1000); // 24 hours ago
        }
    } else {
        // Parse relative time expressions with context awareness
        const now = Date.now();
        end_time = now;
        
        // Context-aware time period patterns - look for time range indicators, not interval indicators
        const timeRangePatterns = [
            // Patterns with context words that indicate time range (not interval)
            { pattern: /(?:for|during|over|past|last|previous)\s+(?:the\s+)?(?:past|last)?\s*(\d+)\s*(?:minute|min)s?/i, multiplier: 60 * 1000 },
            { pattern: /(?:for|during|over|past|last|previous)\s+(?:the\s+)?(?:past|last)?\s*(\d+)\s*(?:hour|hr)s?/i, multiplier: 60 * 60 * 1000 },
            { pattern: /(?:for|during|over|past|last|previous)\s+(?:the\s+)?(?:past|last)?\s*(\d+)\s*(?:day)s?/i, multiplier: 24 * 60 * 60 * 1000 },
            { pattern: /(?:for|during|over|past|last|previous)\s+(?:the\s+)?(?:past|last)?\s*(\d+)\s*(?:week)s?/i, multiplier: 7 * 24 * 60 * 60 * 1000 },
            { pattern: /(?:for|during|over|past|last|previous)\s+(?:the\s+)?(?:past|last)?\s*(\d+)\s*(?:month)s?/i, multiplier: 30 * 24 * 60 * 60 * 1000 },
            
            // Named periods with context
            { pattern: /(?:for|during|over|past|last|previous)\s+(?:the\s+)?(?:past|last)?\s*(?:one|1|a)\s*(?:minute|min)/i, multiplier: 60 * 1000, value: 1 },
            { pattern: /(?:for|during|over|past|last|previous)\s+(?:the\s+)?(?:past|last)?\s*(?:one|1|a)\s*(?:hour|hr)/i, multiplier: 60 * 60 * 1000, value: 1 },
            { pattern: /(?:for|during|over|past|last|previous)\s+(?:the\s+)?(?:past|last)?\s*(?:one|1|a)\s*(?:day)/i, multiplier: 24 * 60 * 60 * 1000, value: 1 },
            { pattern: /(?:for|during|over|past|last|previous)\s+(?:the\s+)?(?:past|last)?\s*(?:one|1|a)\s*(?:week)/i, multiplier: 7 * 24 * 60 * 60 * 1000, value: 1 },
            { pattern: /(?:for|during|over|past|last|previous)\s+(?:the\s+)?(?:past|last)?\s*(?:one|1|a)\s*(?:month)/i, multiplier: 30 * 24 * 60 * 60 * 1000, value: 1 },
            
            // Fallback patterns without strict context (but avoid interval-like phrases)
            { pattern: /(?:^|[^a-z])(?:one|1)\s*(?:week)(?!\s*(?:interval|period))/i, multiplier: 7 * 24 * 60 * 60 * 1000, value: 1 },
            { pattern: /(?:^|[^a-z])(?:one|1)\s*(?:day)(?!\s*(?:interval|period))/i, multiplier: 24 * 60 * 60 * 1000, value: 1 },
            { pattern: /(?:^|[^a-z])(\d+)\s*(?:week)s?(?!\s*(?:interval|period))/i, multiplier: 7 * 24 * 60 * 60 * 1000 },
            { pattern: /(?:^|[^a-z])(\d+)\s*(?:day)s?(?!\s*(?:interval|period))/i, multiplier: 24 * 60 * 60 * 1000 }
        ];
        
        for (const timePattern of timeRangePatterns) {
            const match = text.match(timePattern.pattern);
            if (match) {
                const value = timePattern.value || Number.parseInt(match[1]);
                const duration = value * timePattern.multiplier;
                start_time = now - duration;
                
                elizaLogger.info(`🕒 Matched time pattern: "${match[0]}" -> ${value} ${timePattern.multiplier === 7 * 24 * 60 * 60 * 1000 ? 'weeks' : timePattern.multiplier === 24 * 60 * 60 * 1000 ? 'days' : timePattern.multiplier === 60 * 60 * 1000 ? 'hours' : 'minutes'}`);
                break;
            }
        }
    }
    
    return { start_time, end_time };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function clampTimestampRangeToRetention(
    start_time: number | undefined,
    end_time: number | undefined,
    config: { dataRetentionDays?: number; dataRetentionMinDaysAgo?: number; dataRetentionMaxDaysAgo?: number }
): { start_time?: number; end_time?: number } {
    const maxDays = config.dataRetentionDays;
    const minDaysAgo = config.dataRetentionMinDaysAgo;
    const maxDaysAgo = config.dataRetentionMaxDaysAgo;
    if (typeof maxDays === "number" && maxDays === 0) {
        return { start_time, end_time };
    }
    if (
        typeof minDaysAgo === "number" &&
        typeof maxDaysAgo === "number" &&
        maxDaysAgo > minDaysAgo
    ) {
        const now = Date.now();
        return {
            start_time: now - maxDaysAgo * MS_PER_DAY,
            end_time: now - minDaysAgo * MS_PER_DAY,
        };
    }
    if (typeof maxDays !== "number" || maxDays < 1) {
        return { start_time, end_time };
    }
    const end = end_time ?? Date.now();
    const start = start_time ?? end - 100 * MS_PER_DAY;
    const spanDays = (end - start) / MS_PER_DAY;
    if (spanDays <= maxDays) {
        return { start_time: start, end_time: end };
    }
    return {
        start_time: end - maxDays * MS_PER_DAY,
        end_time: end,
    };
}

// Function to parse interval from user query
function parseInterval(messageText: string): string {
    const text = messageText.toLowerCase();
    
    // Only allow 1 day or longer intervals
    const allowedIntervals = [
        { pattern: ['1d', '1 day', 'one day', 'daily'], value: '1d' },
        { pattern: ['1w', '1 week', 'one week', 'weekly'], value: '1w' }
    ];
    
    for (const interval of allowedIntervals) {
        if (interval.pattern.some(pattern => text.includes(pattern))) {
            return interval.value;
        }
    }
    
    // Default to 1 day (never shorter than 1 day)
    return '1d';
}

// Function to parse limit from user query
function parseLimit(messageText: string, timeRange?: { start_time?: number; end_time?: number }, interval?: string): number {
    const text = messageText.toLowerCase();
    
    // Look for explicit limit patterns first
    const limitMatch = text.match(/limit[:\s]*(\d+)/);
    if (limitMatch) {
        const limit = Number.parseInt(limitMatch[1]);
        return Math.min(Math.max(limit, 1), 4500); // Clamp between 1 and 4500
    }
    
    // Look for "last X" patterns
    const lastMatch = text.match(/last[:\s]*(\d+)/);
    if (lastMatch) {
        const limit = Number.parseInt(lastMatch[1]);
        return Math.min(Math.max(limit, 1), 4500);
    }
    
    // If we have time range and interval, calculate appropriate limit
    if (timeRange && timeRange.start_time && timeRange.end_time && interval) {
        const durationMs = timeRange.end_time - timeRange.start_time;
        
        // Convert interval to milliseconds
        const intervalMs = getIntervalInMs(interval);
        
        if (intervalMs > 0) {
            // Calculate expected data points and add 10% buffer
            const expectedPoints = Math.ceil(durationMs / intervalMs);
            const limitWithBuffer = Math.ceil(expectedPoints * 1.1);
            
            // Clamp to API limits
            return Math.min(Math.max(limitWithBuffer, 1), 4500);
        }
    }
    
    return 1000; // Default limit
}

// Helper function to convert interval string to milliseconds
function getIntervalInMs(interval: string): number {
    const intervalMap: Record<string, number> = {
        '1m': 60 * 1000,
        '3m': 3 * 60 * 1000,
        '5m': 5 * 60 * 1000,
        '15m': 15 * 60 * 1000,
        '30m': 30 * 60 * 1000,
        '1h': 60 * 60 * 1000,
        '4h': 4 * 60 * 60 * 1000,
        '6h': 6 * 60 * 60 * 1000,
        '8h': 8 * 60 * 60 * 1000,
        '12h': 12 * 60 * 60 * 1000,
        '1d': 24 * 60 * 60 * 1000,
        '1w': 7 * 24 * 60 * 60 * 1000
    };
    
    return intervalMap[interval] || 0;
}

// Function to parse unit from user query
function parseUnit(messageText: string): string {
    const text = messageText.toLowerCase();
    
    if (text.includes('coin') || text.includes('token')) {
        return 'coin';
    }
    
    return 'usd'; // Default to USD
}

// Main function to fetch aggregated taker buy/sell volume data
export async function getTakerVolumeData(
    runtime: IAgentRuntime,
    symbol: string,
    start_time?: number,
    end_time?: number,
    exchange_list?: string,
    interval?: string,
    limit?: number,
    unit?: string
): Promise<{ success: boolean; data?: TakerVolumePoint[]; error?: string }> {
    try {
        const apiKey = process.env.COINGLASS_API_KEY;
        if (!apiKey) {
            throw new Error("COINGLASS_API_KEY environment variable is required");
        }

        const validatedExchange = exchange_list && isValidExchange(exchange_list) ? exchange_list : DEFAULT_EXCHANGE;
        
        const timeRangeInfo = start_time || end_time 
            ? ` (${start_time ? new Date(start_time).toISOString() : 'earliest'} to ${end_time ? new Date(end_time).toISOString() : 'latest'})`
            : '';
        elizaLogger.info(`📊 Fetching taker buy/sell volume data for ${symbol}${timeRangeInfo}...`);

        // Validate exchange
        if (!isValidExchange(validatedExchange)) {
            elizaLogger.warn(`⚠️ Invalid exchange '${validatedExchange}', falling back to ${DEFAULT_EXCHANGE}`);
        }
        
        const finalExchange = isValidExchange(validatedExchange) ? validatedExchange : DEFAULT_EXCHANGE;
        const exchangeInfo = getExchangeInfo(finalExchange);
        
        elizaLogger.info(`🏢 Using exchange: ${exchangeInfo.name} (${finalExchange}) - ${exchangeInfo.tier}, ${exchangeInfo.region}`);
        
        // Build URL with parameters - following the same pattern as inflow/outflow
        let url = `https://open-api-v4.coinglass.com/api/futures/aggregated-taker-buy-sell-volume/history?exchange_list=${finalExchange}&symbol=${symbol}&interval=${interval || '1d'}&limit=${limit || 1000}&unit=${unit || 'usd'}`;
        
        if (start_time) {
            url += `&start_time=${start_time}`;
        }
        if (end_time) {
            url += `&end_time=${end_time}`;
        }
        
        elizaLogger.info(`🔗 API URL: ${url}`);

        const response = await httpClient.get(url, {
            headers: {
                'accept': 'application/json',
                'CG-API-KEY': apiKey
            }
        });

        if (response.status < 200 || response.status >= 300) {
            throw new Error(`HTTP error! status: ${response.status} - ${response.statusText}`);
        }

        const apiResponse: TakerVolumeResponse = response.data;
        
        elizaLogger.info(`📊 Taker Volume API Response - Code: ${apiResponse.code}, Message: ${apiResponse.msg}`);

        if (apiResponse.code !== "0") {
            throw new Error(`API Error: ${apiResponse.msg || 'Unknown error'} (Code: ${apiResponse.code})`);
        }

        if (!apiResponse.data || apiResponse.data.length === 0) {
            elizaLogger.error(`📊 API returned no data. Response structure:`, {
                hasData: !!apiResponse.data,
                dataLength: apiResponse.data?.length || 0,
                dataType: typeof apiResponse.data,
                symbol: symbol,
                url: url
            });
            
            // Try without time parameters if they were provided
            if (start_time || end_time) {
                elizaLogger.info(`📊 Retrying without time parameters...`);
                return getTakerVolumeData(runtime, symbol, undefined, undefined, exchange_list, interval, limit, unit);
            }
            
            throw new Error(`No taker volume data available for ${symbol}. The API might not support this symbol or the data might be temporarily unavailable.`);
        }

        // Process the raw data to add basic derived metrics
        const processedData: TakerVolumePoint[] = apiResponse.data.map((point) => {
            const buyVol = point.aggregated_buy_volume_usd || 0;
            const sellVol = point.aggregated_sell_volume_usd || 0;
            const totalVolume = buyVol + sellVol;
            
            return {
                aggregated_buy_volume_usd: buyVol,
                aggregated_sell_volume_usd: sellVol,
                time: point.time,
                total_volume: totalVolume,
                buy_sell_ratio: sellVol > 0 ? buyVol / sellVol : buyVol > 0 ? Number.POSITIVE_INFINITY : 0,
                buy_dominance: totalVolume > 0 ? (buyVol / totalVolume) * 100 : 0,
                sell_dominance: totalVolume > 0 ? (sellVol / totalVolume) * 100 : 0
            };
        });

        elizaLogger.info(`✅ Successfully processed ${symbol} taker volume data`);
        elizaLogger.info(`📊 ${processedData.length} data points processed`);

        return {
            success: true,
            data: processedData
        };

    } catch (error) {
        elizaLogger.error(
            `❌ Error fetching taker buy/sell volume data: ${formatAxiosErrorLine(error)}`
        );

        return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error occurred"
        };
    }
}

// Comprehensive analysis function
export async function getComprehensiveTakerVolumeAnalysis(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    symbol?: string,
    options?: { dataRetentionDays?: number; dataRetentionMinDaysAgo?: number; dataRetentionMaxDaysAgo?: number }
): Promise<TakerVolumeResult> {
    try {
        elizaLogger.info("🔍 Starting comprehensive taker volume analysis...");

        const messageText = message.content.text || "";
        const extractedSymbol = symbol || parseCryptoSymbol(messageText);
        const extractedExchanges = parseExchanges(messageText);
        const extractedExchange = extractedExchanges[0]; // For backward compatibility
        const timestampParams = parseTimestampParams(messageText);
        const extractedInterval = parseInterval(messageText);

        // Ensure we always have start_time and end_time (apply 100-day default if not specified)
        let finalStartTime = timestampParams.start_time;
        let finalEndTime = timestampParams.end_time;
        
        if (!finalStartTime && !finalEndTime) {
            // Apply default 100-day range (or dataRetentionDays cap if set; 0 = no limit)
            const now = Date.now();
            const defaultDays =
                typeof options?.dataRetentionDays === "number" && options.dataRetentionDays > 0
                    ? Math.min(100, options.dataRetentionDays)
                    : 100;
            finalEndTime = now;
            finalStartTime = now - (defaultDays * 24 * 60 * 60 * 1000);
            elizaLogger.info(`📅 No time range specified, applying default ${defaultDays}-day range`);
        } else if (!finalStartTime && finalEndTime) {
            const defaultDays =
                typeof options?.dataRetentionDays === "number" && options.dataRetentionDays > 0
                    ? Math.min(100, options.dataRetentionDays)
                    : 100;
            finalStartTime = finalEndTime - (defaultDays * 24 * 60 * 60 * 1000);
        } else if (finalStartTime && !finalEndTime) {
            finalEndTime = Date.now();
        }

        const retentionConfig = {
            dataRetentionDays: options?.dataRetentionDays,
            dataRetentionMinDaysAgo: options?.dataRetentionMinDaysAgo,
            dataRetentionMaxDaysAgo: options?.dataRetentionMaxDaysAgo,
        };
        if (
            (typeof retentionConfig.dataRetentionDays === "number" && retentionConfig.dataRetentionDays >= 0) ||
            (typeof retentionConfig.dataRetentionMinDaysAgo === "number" && typeof retentionConfig.dataRetentionMaxDaysAgo === "number")
        ) {
            const clamped = clampTimestampRangeToRetention(finalStartTime, finalEndTime, retentionConfig);
            finalStartTime = clamped.start_time ?? finalStartTime;
            finalEndTime = clamped.end_time ?? finalEndTime;
        }

        // Parse other parameters with final timestamp values
        const finalTimestampParams = { start_time: finalStartTime, end_time: finalEndTime };
        const extractedLimit = parseLimit(messageText, finalTimestampParams, extractedInterval);
        const extractedUnit = parseUnit(messageText);

        // Log parsed parameters for debugging
        elizaLogger.info(`📋 Parsed parameters:`);
        elizaLogger.info(`   Symbol: ${extractedSymbol}`);
        elizaLogger.info(`   Exchanges: ${extractedExchanges.join(', ')} (${extractedExchanges.length} exchange${extractedExchanges.length > 1 ? 's' : ''})`);
        elizaLogger.info(`   Interval: ${extractedInterval}`);
        elizaLogger.info(`   Limit: ${extractedLimit}`);
        elizaLogger.info(`   Unit: ${extractedUnit}`);
        
        const startStr = new Date(finalStartTime).toISOString();
        const endStr = new Date(finalEndTime).toISOString();
        elizaLogger.info(`   Time Range: ${startStr} to ${endStr}`);
        
        const durationHours = (finalEndTime - finalStartTime) / (1000 * 60 * 60);
        const durationDays = durationHours / 24;
        elizaLogger.info(`   Duration: ${durationHours.toFixed(1)} hours (${durationDays.toFixed(1)} days)`);

        elizaLogger.info(`🔍 Starting taker volume analysis for ${extractedSymbol}...`);

        // Clean up all previous files for this symbol before fetching new data
        await cleanupAllPreviousTakerVolumeFiles(extractedSymbol);

        // Prepare exchange list for API call (comma-separated)
        const exchangeListParam = extractedExchanges.join(',');
        const isMultiExchange = extractedExchanges.length > 1;

        // Fetch taker volume data
        const volumeResult = await getTakerVolumeData(
            runtime,
            extractedSymbol,
            finalStartTime,
            finalEndTime,
            exchangeListParam,
            extractedInterval,
            extractedLimit,
            extractedUnit
        );

        if (!volumeResult.success || !volumeResult.data || volumeResult.data.length === 0) {
            throw new Error(`Failed to fetch taker volume data: ${volumeResult.error}`);
        }

        const volumeData = volumeResult.data;
        const latestData = volumeData[volumeData.length - 1];

        // Calculate analysis metrics
        const totalBuyVolume = volumeData.reduce((sum, point) => sum + point.aggregated_buy_volume_usd, 0);
        const totalSellVolume = volumeData.reduce((sum, point) => sum + point.aggregated_sell_volume_usd, 0);
        const totalVolume = totalBuyVolume + totalSellVolume;
        const avgVolume = totalVolume / volumeData.length;

        const buyDominance = totalVolume > 0 ? (totalBuyVolume / totalVolume) * 100 : 0;
        const sellDominance = totalVolume > 0 ? (totalSellVolume / totalVolume) * 100 : 0;
        const buySellRatio = totalSellVolume > 0 ? totalBuyVolume / totalSellVolume : totalBuyVolume > 0 ? Number.POSITIVE_INFINITY : 0;

        // Basic market sentiment determination
        let marketSentiment = "NEUTRAL";
        let dominantTrading = "BALANCED";

        if (buyDominance > 60) {
            marketSentiment = "BULLISH";
            dominantTrading = "BUY DOMINATED";
        } else if (sellDominance > 60) {
            marketSentiment = "BEARISH";
            dominantTrading = "SELL DOMINATED";
        }

        // Get crypto and exchange info
        const cryptoInfo = getCryptoInfo(extractedSymbol);
        
        // Create exchange info based on single or multi-exchange
        const exchangeInfo = isMultiExchange ? {
            name: "Multi-Exchange",
            region: "Global",
            tier: "Mixed",
            type: "Aggregated",
            count: extractedExchanges.length,
            list: extractedExchanges
        } : {
            ...getExchangeInfo(extractedExchange),
            count: 1,
            list: [extractedExchange],
        };

        // Create chart data for visualization
        const chartData = {
            labels: volumeData.map(point => {
                const date = new Date(point.time);
                
                // Determine label format based on interval and data count
                const isHourlyOrLess = ['1m', '3m', '5m', '15m', '30m', '1h'].includes(extractedInterval);
                const isDailyOrMore = ['1d', '1w'].includes(extractedInterval);
                
                if (isHourlyOrLess && volumeData.length <= 336) { // Up to 2 weeks of hourly data
                    // For hourly or sub-hourly data, show date and time
                    return date.toLocaleString('en-US', { 
                        month: 'short', 
                        day: 'numeric', 
                        hour: '2-digit', 
                        minute: '2-digit' 
                    });
                } else if (isDailyOrMore || volumeData.length > 100) {
                    // For daily data or large datasets, show date only
                    return date.toLocaleDateString('en-US', { 
                        month: 'short', 
                        day: 'numeric',
                        year: '2-digit'
                    });
                } else {
                    // For other cases, show full date and time
                    return date.toLocaleString('en-US', { 
                        month: 'short', 
                        day: 'numeric', 
                        hour: '2-digit', 
                        minute: '2-digit' 
                    });
                }
            }),
            buyVolumeData: volumeData.map(point => point.aggregated_buy_volume_usd),
            sellVolumeData: volumeData.map(point => point.aggregated_sell_volume_usd),
            ratioData: volumeData.map(point => point.buy_sell_ratio === Number.POSITIVE_INFINITY ? 100 : Math.min(100, point.buy_sell_ratio))
        };

        const analysis: TakerVolumeAnalysis = {
            symbol: extractedSymbol,
            exchange: extractedExchange,
            exchanges: extractedExchanges,
            isMultiExchange,
            latestData,
            historicalData: volumeData,
            analysis: {
                marketSentiment,
                dominantTrading,
                buyVolume: totalBuyVolume,
                sellVolume: totalSellVolume,
                totalVolume,
                buyDominance,
                sellDominance,
                buySellRatio,
                avgVolume,
                cryptoInfo,
                exchangeInfo
            },
            chartData
        };

        elizaLogger.info(`✅ Successfully completed taker volume analysis for ${extractedSymbol}`);
        elizaLogger.info(`💰 Total volume: ${formatLargeNumber(totalVolume)} | Sentiment: ${marketSentiment}`);
        elizaLogger.info(`📊 Buy dominance: ${buyDominance.toFixed(1)}% | Sell dominance: ${sellDominance.toFixed(1)}%`);

        return {
            success: true,
            data: analysis
        };

    } catch (error) {
        elizaLogger.error("❌ Error in comprehensive taker volume analysis:", error);
        
        if (error instanceof Error) {
            elizaLogger.error(`❌ Error details: ${error.message}`);
        }
        
        return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error occurred"
        };
    }
}

// Format analysis for chart display
export function formatTakerVolumeForAnalysis(analysis: TakerVolumeAnalysis): string {
    const { symbol, exchange, exchanges, isMultiExchange, latestData, analysis: analyticsData } = analysis;
    
    // Format the response focused on chart data
    let response = `## 📊 ${analyticsData.cryptoInfo.name} (${symbol}) - Transaction Volume Chart\n\n`;
    
    // Asset and Exchange Info
    response += `**Asset**: ${analyticsData.cryptoInfo.name} (${symbol}) | **Category**: ${analyticsData.cryptoInfo.category} | **Tier**: ${analyticsData.cryptoInfo.tier}\n`;
    
    if (isMultiExchange) {
        response += `**Exchanges**: ${analyticsData.exchangeInfo.name} (${analyticsData.exchangeInfo.count} exchanges)\n`;
        response += `**Exchange List**: ${exchanges.join(', ')}\n`;
        response += `**Data Type**: Aggregated cross-exchange volume\n`;
    } else {
        response += `**Exchange**: ${analyticsData.exchangeInfo.name} (${exchange}) | **Region**: ${analyticsData.exchangeInfo.region} | **Type**: ${analyticsData.exchangeInfo.type}\n`;
    }
    
    response += `**Data Points**: ${analysis.historicalData.length} | **Latest Update**: ${new Date(latestData.time).toLocaleString()}\n\n`;
    
    // Current Volume Data
    response += `**🔥 Latest Volume Data${isMultiExchange ? ' (Aggregated)' : ''}:**\n`;
    response += `- Buy Volume: ${formatLargeNumber(latestData.aggregated_buy_volume_usd)}\n`;
    response += `- Sell Volume: ${formatLargeNumber(latestData.aggregated_sell_volume_usd)}\n`;
    response += `- Total Volume: ${formatLargeNumber(latestData.total_volume)}\n`;
    response += `- Buy/Sell Ratio: ${latestData.buy_sell_ratio === Number.POSITIVE_INFINITY ? '∞' : latestData.buy_sell_ratio.toFixed(2)}\n\n`;
    
    // Basic Market Analysis
    response += `**📈 Market Overview${isMultiExchange ? ' (Cross-Exchange)' : ''}:**\n`;
    response += `- Market Sentiment: ${analyticsData.marketSentiment === 'BULLISH' ? '🟢' : analyticsData.marketSentiment === 'BEARISH' ? '🔴' : '🟡'} ${analyticsData.marketSentiment}\n`;
    response += `- Dominant Trading: ${analyticsData.dominantTrading}\n`;
    
    if (isMultiExchange) {
        response += `- Analysis Scope: Global aggregated data from ${analyticsData.exchangeInfo.count} major exchanges\n`;
        response += `- Market Coverage: Enhanced liquidity and volume representation\n`;
    }
    response += `\n`;
    
    // Volume Summary
    response += `**💰 Volume Summary${isMultiExchange ? ' (Total Aggregated)' : ''}:**\n`;
    response += `- Total Buy Volume: ${formatLargeNumber(analyticsData.buyVolume)} (${analyticsData.buyDominance.toFixed(1)}%)\n`;
    response += `- Total Sell Volume: ${formatLargeNumber(analyticsData.sellVolume)} (${analyticsData.sellDominance.toFixed(1)}%)\n`;
    response += `- Average Volume: ${formatLargeNumber(analyticsData.avgVolume)}\n\n`;
    
    // Chart Information
    response += `**📈 Chart Data Available:**\n`;
    response += `- Buy/Sell Volume Time Series${isMultiExchange ? ' (Aggregated)' : ''}\n`;
    response += `- Volume Ratio Analysis\n`;
    response += `- Market Dominance Visualization\n`;
    
    if (isMultiExchange) {
        response += `- Cross-Exchange Volume Patterns\n`;
        response += `- Global Market Sentiment Analysis\n`;
    }
    response += `\n`;
    
    // Add data source attribution
    response += `*Data Source: Coinglass API - ${isMultiExchange ? 'Aggregated Multi-Exchange' : 'Single Exchange'} Transaction Volume | Chart Ready*`;
    
    return response;
}

// Utility function to determine date range based on timeframe
function determineDateRange(historicalData?: TakerVolumePoint[], start_time?: number, end_time?: number): string {
    let startDate: string;
    let endDate: string;
    
    // If we have start and end times, use them
    if (start_time && end_time) {
        startDate = new Date(start_time).toISOString().split('T')[0];
        endDate = new Date(end_time).toISOString().split('T')[0];
    }
    // If we have historical data, use the data range
    else if (historicalData && historicalData.length > 1) {
        const firstTime = historicalData[0].time;
        const lastTime = historicalData[historicalData.length - 1].time;
        startDate = new Date(firstTime).toISOString().split('T')[0];
        endDate = new Date(lastTime).toISOString().split('T')[0];
    }
    // Default to last 100 days (based on default range)
    else {
        const end = new Date();
        const start = new Date(end.getTime() - (100 * 24 * 60 * 60 * 1000));
        startDate = start.toISOString().split('T')[0];
        endDate = end.toISOString().split('T')[0];
    }
    
    // If same date, return single date, otherwise return range with ~ separator
    return startDate === endDate ? startDate : `${startDate}~${endDate}`;
}

// Function to clean up previous chart files for a symbol
async function cleanupPreviousTakerVolumeCharts(symbol: string): Promise<void> {
    try {
        const savedDataDir = path.join(process.cwd(), 'saved_data');
        const chartsDirectory = path.join(savedDataDir, 'Charts');
        
        if (!fs.existsSync(chartsDirectory)) {
            return; // No directory to clean
        }
        
        // Read all files in the directory
        const files = fs.readdirSync(chartsDirectory);
        
        // Filter files that match the pattern with ticker and date range
        // Matches patterns like: Transaction Volume Chart BTC 2025-01-01~2025-01-31.html or Transaction Volume Chart BTC 2025-01-01.html
        const pattern = new RegExp(`^Transaction Volume Chart ${symbol} \\d{4}-\\d{2}-\\d{2}(~\\d{4}-\\d{2}-\\d{2})?\\.html$`);
        const symbolFiles = files.filter(file => pattern.test(file));

        // Note: Chart deletion disabled to preserve historical data
        // Old charts are kept for reference in chat history
        if (symbolFiles.length > 0) {
            elizaLogger.info(`📊 Found ${symbolFiles.length} existing ${symbol} transaction volume chart(s) (keeping for history)`);
        }

        // Delete matching files
        // for (const file of symbolFiles) {
        //     const filepath = path.join(chartsDirectory, file);
        //     fs.unlinkSync(filepath);
        //     elizaLogger.info(`🗑️ Deleted previous transaction volume chart: ${file}`);
        // }
        
    } catch (error) {
        elizaLogger.warn("⚠️ Error cleaning up previous chart files:", error);
        // Don't throw - this is cleanup, not critical
    }
}

// Function to perform comprehensive cleanup for a symbol (both data and charts)
async function cleanupAllPreviousTakerVolumeFiles(symbol: string): Promise<void> {
    try {
        elizaLogger.info(`🧹 Starting cleanup of all previous ${symbol} taker volume files...`);
        
        // Clean up data files and chart files in parallel
        await Promise.all([
            cleanupPreviousTakerVolumeCharts(symbol)
        ]);
        
        elizaLogger.info(`✅ Completed cleanup for ${symbol} taker volume files`);
        
    } catch (error) {
        elizaLogger.warn(`⚠️ Error during comprehensive cleanup for ${symbol}:`, error);
        // Don't throw - this is cleanup, not critical
    }
}

// Function to save taker volume analysis data to file
async function saveTakerVolumeAnalysisToFile(analysis: TakerVolumeAnalysis): Promise<void> {
    try {
        const CACHE_DIR = path.join(process.cwd(), 'cache');
        const saveDirectory = path.join(CACHE_DIR, 'taker_volume_data');
        
        // Create cache and taker_volume_data directories if they don't exist
        if (!fs.existsSync(CACHE_DIR)) {
            fs.mkdirSync(CACHE_DIR, { recursive: true });
            elizaLogger.info(`📁 Created directory: ${CACHE_DIR}`);
        }
        
        if (!fs.existsSync(saveDirectory)) {
            fs.mkdirSync(saveDirectory, { recursive: true });
            elizaLogger.info(`📁 Created directory: ${saveDirectory}`);
        }
        
        // Generate filename with timestamp and symbol
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `taker_volume_${analysis.symbol}_${timestamp}.json`;
        const filepath = path.join(saveDirectory, filename);
        
        // Prepare data to save
        const dataToSave = {
            timestamp: new Date().toISOString(),
            fetchTime: Date.now(),
            symbol: analysis.symbol,
            data: analysis
        };
        
        // Write data to file
        fs.writeFileSync(filepath, JSON.stringify(dataToSave, null, 2));
        
        elizaLogger.info(`💾 Taker volume analysis data saved to: ${filepath}`);
        elizaLogger.info(`📊 Saved ${analysis.symbol} data with $${formatLargeNumber(analysis.analysis.totalVolume)} total volume`);
        
    } catch (error) {
        elizaLogger.error("❌ Error saving taker volume analysis data to file:", error);
        throw error;
    }
}

// Function to create HTML chart for transaction volume
async function createTransactionVolumeChart(analysis: TakerVolumeAnalysis, start_time?: number, end_time?: number): Promise<string> {
    try {
        const SAVED_DATA_DIR = path.join(process.cwd(), 'saved_data');
        const chartsDirectory = path.join(SAVED_DATA_DIR, 'Charts');
        
        // Clean up previous chart files for this symbol first
        await cleanupPreviousTakerVolumeCharts(analysis.symbol);
        
        // Create directories if they don't exist
        if (!fs.existsSync(SAVED_DATA_DIR)) {
            fs.mkdirSync(SAVED_DATA_DIR, { recursive: true });
            elizaLogger.info(`📁 Created directory: ${SAVED_DATA_DIR}`);
        }
        
        if (!fs.existsSync(chartsDirectory)) {
            fs.mkdirSync(chartsDirectory, { recursive: true });
            elizaLogger.info(`📁 Created directory: ${chartsDirectory}`);
        }
        
        // Determine date range from timeframe and data
        const dateRange = determineDateRange(analysis.historicalData, start_time, end_time);
        
        // Generate standardized filename format: [Chart Title] [Ticker] [DateRange],
        const filename = `Transaction Volume Chart ${analysis.symbol} ${dateRange}.html`;
        const filepath = path.join(chartsDirectory, filename);
        
        const { chartData } = analysis;
        if (!chartData) {
            throw new Error("No chart data available");
        }
        
        // Prepare exchange display information
        const exchangeDisplayName = analysis.isMultiExchange 
            ? `Multi-Exchange (${analysis.exchanges.join(', ')})`
            : `${analysis.analysis.exchangeInfo.name}`;
            
        const exchangeDescription = analysis.isMultiExchange
            ? `Aggregated data from ${analysis.analysis.exchangeInfo.count} exchanges`
            : `Single exchange data from ${analysis.analysis.exchangeInfo.name}`;
        
        // Create HTML chart content
        const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${analysis.analysis.cryptoInfo.name} (${analysis.symbol}) - Transaction Volume Chart${analysis.isMultiExchange ? ' (Multi-Exchange)' : ''}</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js" crossorigin="anonymous" onerror="document.body.innerHTML='<p style=\\'font-family:sans-serif;padding:1rem\\'>Chart library failed to load. Check network or try opening this page in a new tab.</p>'"></script>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0;
            padding: 20px;
            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
            min-height: 100vh;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
            overflow: hidden;
        }
        .header {
            background: linear-gradient(135deg, ${analysis.isMultiExchange ? '#4F46E5 0%, #9333EA 100%' : '#667eea 0%, #764ba2 100%'});
            color: white;
            padding: 30px;
            text-align: center;
        }
        .header h1 {
            margin: 0;
            font-size: 28px;
            font-weight: 600;
        }
        .header p {
            margin: 8px 0 0;
            opacity: 0.9;
            font-size: 16px;
        }
        .exchange-info {
            background: ${analysis.isMultiExchange ? '#F3F4F6' : '#F8FAFC'};
            padding: 20px 30px;
            border-bottom: 1px solid #E5E7EB;
        }
        .exchange-badge {
            display: inline-block;
            background: ${analysis.isMultiExchange ? '#4F46E5' : '#6366F1'};
            color: white;
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
            margin-right: 8px;
        }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            padding: 30px;
            background: #f8fafc;
            border-bottom: 1px solid #e2e8f0;
        }
        .stat-card {
            background: white;
            padding: 20px;
            border-radius: 12px;
            text-align: center;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
        }
        .stat-value {
            font-size: 24px;
            font-weight: 700;
            color: #1e293b;
            margin-bottom: 4px;
        }
        .stat-label {
            color: #64748b;
            font-size: 14px;
            font-weight: 500;
        }
        .bullish { color: #10b981; }
        .bearish { color: #ef4444; }
        .neutral { color: #6b7280; }
        .chart-container {
            padding: 30px;
            background: white;
        }
        .chart-wrapper {
            position: relative;
            height: clamp(240px, 40vw, 480px);
            margin-bottom: 30px;
        }
        .chart-title {
            text-align: center;
            font-size: 18px;
            font-weight: 600;
            color: #1e293b;
            margin-bottom: 20px;
        }
        .info-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            padding: 30px;
            background: #f8fafc;
        }
        .info-card {
            background: white;
            padding: 20px;
            border-radius: 12px;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
        }
        .info-card h3 {
            margin: 0 0 12px;
            color: #1e293b;
            font-size: 16px;
            font-weight: 600;
        }
        .info-card p {
            margin: 0;
            color: #64748b;
            font-size: 14px;
            line-height: 1.5;
        }
        .exchange-list {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 8px;
        }
        .exchange-tag {
            background: #E5E7EB;
            color: #374151;
            padding: 4px 8px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 500;
        }
        body.compact-view {
            padding: 0;
            background: transparent;
            min-height: 0;
        }
        body.compact-view .container {
            max-width: none;
            margin: 0;
            background: transparent;
            box-shadow: none;
            border-radius: 0;
        }
        body.compact-view .header,
        body.compact-view .exchange-info,
        body.compact-view .stats,
        body.compact-view .info-grid,
        body.compact-view .chart-title {
            display: none;
        }
        body.compact-view .chart-container {
            padding: 0;
            background: transparent;
        }
        body.compact-view .chart-wrapper {
            height: clamp(200px, 40vw, 520px);
            min-height: 200px;
            max-height: 540px;
            margin-bottom: 0;
        }
        body.compact-view canvas {
            max-height: none !important;
        }
    </style>
</head>
<body>
    <script>
        (function () {
            const params = new URLSearchParams(window.location.search);
            const viewMode = params.get('view');
            const isCompact = viewMode === 'compact';
            const body = document.body;
            const root = document.documentElement;
            if (isCompact) {
                body.classList.add('compact-view');
                root.classList.add('compact-view');
            } else {
                body.classList.add('full-view');
                root.classList.add('full-view');
            }
        })();
    </script>
    <div class="container">
        <div class="header">
            <h1>${analysis.analysis.cryptoInfo.name} (${analysis.symbol})</h1>
            <p>Transaction Volume Analysis${analysis.isMultiExchange ? ' • Multi-Exchange Aggregated Data' : ` • ${exchangeDisplayName}`}</p>
        </div>
        
        <div class="exchange-info">
            <span class="exchange-badge">${analysis.isMultiExchange ? 'MULTI-EXCHANGE' : 'SINGLE EXCHANGE'}</span>
            <span style="color: #4B5563; font-weight: 500;">${exchangeDescription}</span>
            ${analysis.isMultiExchange ? `
            <div class="exchange-list">
                ${analysis.exchanges.map(ex => `<span class="exchange-tag">${ex}</span>`).join('')}
            </div>
            ` : ''}
        </div>
        
        <div class="stats">
            <div class="stat-card">
                <div class="stat-value ${analysis.analysis.marketSentiment.toLowerCase()}">${formatLargeNumber(analysis.latestData.total_volume)}</div>
                <div class="stat-label">Total Volume${analysis.isMultiExchange ? ' (Aggregated)' : ''}</div>
            </div>
            <div class="stat-card">
                <div class="stat-value bullish">${formatLargeNumber(analysis.latestData.aggregated_buy_volume_usd)}</div>
                <div class="stat-label">Buy Volume</div>
            </div>
            <div class="stat-card">
                <div class="stat-value bearish">${formatLargeNumber(analysis.latestData.aggregated_sell_volume_usd)}</div>
                <div class="stat-label">Sell Volume</div>
            </div>
            <div class="stat-card">
                <div class="stat-value ${analysis.analysis.marketSentiment.toLowerCase()}">${analysis.analysis.buyDominance.toFixed(1)}%</div>
                <div class="stat-label">Buy Dominance</div>
            </div>
        </div>
        
        <div class="chart-container">
            <div class="chart-title">Buy vs Sell Volume Over Time${analysis.isMultiExchange ? ' (Aggregated)' : ''}</div>
            <div class="chart-wrapper">
                <canvas id="volumeChart"></canvas>
            </div>
            
            <div class="chart-title">Buy/Sell Ratio${analysis.isMultiExchange ? ' (Cross-Exchange)' : ''}</div>
            <div class="chart-wrapper">
                <canvas id="ratioChart"></canvas>
            </div>
        </div>
        
        <div class="info-grid">
            <div class="info-card">
                <h3>Market Sentiment</h3>
                <p class="${analysis.analysis.marketSentiment.toLowerCase()}">${analysis.analysis.marketSentiment}</p>
                <p>${analysis.analysis.dominantTrading}</p>
            </div>
            <div class="info-card">
                <h3>Volume Breakdown</h3>
                <p>Buy: ${formatLargeNumber(analysis.analysis.buyVolume)} (${analysis.analysis.buyDominance.toFixed(1)}%)</p>
                <p>Sell: ${formatLargeNumber(analysis.analysis.sellVolume)} (${analysis.analysis.sellDominance.toFixed(1)}%)</p>
            </div>
            <div class="info-card">
                <h3>Asset Information</h3>
                <p>${analysis.analysis.cryptoInfo.name} • ${analysis.analysis.cryptoInfo.category}</p>
                <p>Tier: ${analysis.analysis.cryptoInfo.tier}</p>
            </div>
            <div class="info-card">
                <h3>${analysis.isMultiExchange ? 'Exchange Coverage' : 'Exchange'}</h3>
                <p>${analysis.isMultiExchange ? `${analysis.analysis.exchangeInfo.count} Exchanges` : analysis.analysis.exchangeInfo.name}</p>
                <p>${analysis.isMultiExchange ? 'Global • Aggregated' : `${analysis.analysis.exchangeInfo.region} • ${analysis.analysis.exchangeInfo.type}`}</p>
            </div>
        </div>
    </div>
    
    <script>
        // Volume Chart
        const volumeCtx = document.getElementById('volumeChart').getContext('2d');
        new Chart(volumeCtx, {
            type: 'line',
            data: {
                labels: ${JSON.stringify(chartData.labels)},
                datasets: [
                    {
                        label: 'Buy Volume${analysis.isMultiExchange ? ' (Aggregated)' : ''}',
                        data: ${JSON.stringify(chartData.buyVolumeData)},
                        borderColor: '#10b981',
                        backgroundColor: 'rgba(16, 185, 129, 0.1)',
                        fill: true,
                        tension: 0.4
                    },
                    {
                        label: 'Sell Volume${analysis.isMultiExchange ? ' (Aggregated)' : ''}',
                        data: ${JSON.stringify(chartData.sellVolumeData)},
                        borderColor: '#ef4444',
                        backgroundColor: 'rgba(239, 68, 68, 0.1)',
                        fill: true,
                        tension: 0.4
                    }
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    intersect: false,
                    mode: 'index'
                },
                plugins: {
                    legend: {
                        position: 'top',
                    }
                },
                scales: {
                    x: {
                        grid: {
                            display: false
                        }
                    },
                    y: {
                        beginAtZero: true,
                        grid: {
                            color: 'rgba(0, 0, 0, 0.1)'
                        }
                    }
                }
            }
        });
        
        // Ratio Chart
        const ratioCtx = document.getElementById('ratioChart').getContext('2d');
        new Chart(ratioCtx, {
            type: 'line',
            data: {
                labels: ${JSON.stringify(chartData.labels)},
                datasets: [
                    {
                        label: 'Buy/Sell Ratio${analysis.isMultiExchange ? ' (Cross-Exchange)' : ''}',
                        data: ${JSON.stringify(chartData.ratioData)},
                        borderColor: '#8b5cf6',
                        backgroundColor: 'rgba(139, 92, 246, 0.1)',
                        fill: true,
                        tension: 0.4
                    }
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    intersect: false,
                    mode: 'index'
                },
                plugins: {
                    legend: {
                        position: 'top',
                    }
                },
                scales: {
                    x: {
                        grid: {
                            display: false
                        }
                    },
                    y: {
                        beginAtZero: true,
                        grid: {
                            color: 'rgba(0, 0, 0, 0.1)'
                        }
                    }
                }
            }
        });

        // Send height to parent window for iframe auto-sizing
        function sendHeightToParent() {
            const body = document.body;
            const html = document.documentElement;
            const isCompact = body.classList.contains('compact-view');
            const height = isCompact
                ? Math.ceil(body.scrollHeight)
                : Math.max(
                      body.scrollHeight,
                      body.offsetHeight,
                      html.clientHeight,
                      html.scrollHeight,
                      html.offsetHeight
                  );
            window.parent.postMessage({
                type: 'chartHeight',
                height: height
            }, '*');
        }

        // Send height after chart renders
        window.addEventListener('load', () => {
            setTimeout(sendHeightToParent, 500);
            setTimeout(sendHeightToParent, 1000);
        });

        // Resend on window resize
        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(sendHeightToParent, 300);
        });
    </script>
</body>
</html>`;
        
        // Write HTML file
        fs.writeFileSync(filepath, htmlContent);
        
        elizaLogger.info(`📊 Transaction volume chart created: ${filepath}`);
        
        // Return relative path for frontend
        const relativePath = path.relative(process.cwd(), filepath);
        return relativePath;
        
    } catch (error) {
        elizaLogger.error("❌ Error creating transaction volume chart:", error);
        throw error;
    }
}

// Main action definition
export const transactionVolumeAction: Action = {
    name: "GET_TRANSACTION_VOLUME",
    description: "Get transaction volume analysis from aggregated trading data with support for multiple exchanges, time intervals, and data formats",
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show me BTC transaction volume analysis",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll analyze Bitcoin's transaction volume patterns.\n\n📊 **Bitcoin (BTC) - Transaction Volume Chart**\n\n**Asset**: Bitcoin | **Category**: Digital Currency | **Tier**: Tier 1\n**Exchange**: Binance | **Region**: Global | **Type**: Centralized\n**Data Points**: 24 | **Latest Update**: Dec 29, 2024, 6:18:03 PM\n\n**🔥 Latest Volume Data:**\n- Buy Volume: 1.2B\n- Sell Volume: 850M\n- Total Volume: 2.05B\n- Buy/Sell Ratio: 1.41\n\n**📈 Market Overview:**\n- Market Sentiment: 🟢 BULLISH\n- Dominant Trading: BUY DOMINATED\n\n**💰 Volume Summary:**\n- Total Buy Volume: 1.2B (58.5%)\n- Total Sell Volume: 850M (41.5%)\n- Average Volume: 85.4M\n\n**📈 Chart Data Available:**\n- Buy/Sell Volume Time Series\n- Volume Ratio Analysis\n- Market Dominance Visualization\n\n*Data Source: Coinglass API - Single Exchange Transaction Volume | Chart Ready*",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "What's the ETH transaction volume aggregated across Binance, OKX, and Bybit?",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll analyze Ethereum's aggregated transaction volume across multiple major exchanges.\n\n📊 **Ethereum (ETH) - Transaction Volume Chart**\n\n**Asset**: Ethereum | **Category**: Smart Contract Platform | **Tier**: Tier 1\n**Exchanges**: Multi-Exchange (3 exchanges)\n**Exchange List**: Binance, OKX, Bybit\n**Data Type**: Aggregated cross-exchange volume\n**Data Points**: 24 | **Latest Update**: Dec 29, 2024, 6:18:03 PM\n\n**🔥 Latest Volume Data (Aggregated):**\n- Buy Volume: 2.1B\n- Sell Volume: 1.8B\n- Total Volume: 3.9B\n- Buy/Sell Ratio: 1.17\n\n**📈 Market Overview (Cross-Exchange):**\n- Market Sentiment: 🟢 BULLISH\n- Dominant Trading: BUY DOMINATED\n- Analysis Scope: Global aggregated data from 3 major exchanges\n- Market Coverage: Enhanced liquidity and volume representation\n\n**💰 Volume Summary (Total Aggregated):**\n- Total Buy Volume: 2.1B (53.8%)\n- Total Sell Volume: 1.8B (46.2%)\n- Average Volume: 162.5M\n\n**📈 Chart Data Available:**\n- Buy/Sell Volume Time Series (Aggregated)\n- Volume Ratio Analysis\n- Market Dominance Visualization\n- Cross-Exchange Volume Patterns\n- Global Market Sentiment Analysis\n\n*Data Source: Coinglass API - Aggregated Multi-Exchange Transaction Volume | Chart Ready*",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show me BTC volume across all major exchanges for the past week",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll analyze Bitcoin's aggregated transaction volume across all major exchanges for the past week.\n\n📊 **Bitcoin (BTC) - Transaction Volume Chart**\n\n**Asset**: Bitcoin | **Category**: Digital Currency | **Tier**: Tier 1\n**Exchanges**: Multi-Exchange (4 exchanges)\n**Exchange List**: Binance, OKX, Bybit, Coinbase\n**Data Type**: Aggregated cross-exchange volume\n**Data Points**: 168 | **Latest Update**: Dec 29, 2024, 6:18:03 PM\n\n**🔥 Latest Volume Data (Aggregated):**\n- Buy Volume: 3.5B\n- Sell Volume: 2.9B\n- Total Volume: 6.4B\n- Buy/Sell Ratio: 1.21\n\n**📈 Market Overview (Cross-Exchange):**\n- Market Sentiment: 🟢 BULLISH\n- Dominant Trading: BUY DOMINATED\n- Analysis Scope: Global aggregated data from 4 major exchanges\n- Market Coverage: Enhanced liquidity and volume representation\n\n**💰 Volume Summary (Total Aggregated):**\n- Total Buy Volume: 58.8B (54.7%)\n- Total Sell Volume: 48.7B (45.3%)\n- Average Volume: 639.3M\n\n**📈 Chart Data Available:**\n- Buy/Sell Volume Time Series (Aggregated)\n- Volume Ratio Analysis\n- Market Dominance Visualization\n- Cross-Exchange Volume Patterns\n- Global Market Sentiment Analysis\n\n*Data Source: Coinglass API - Aggregated Multi-Exchange Transaction Volume | Chart Ready*",
                },
            },
        ],
    ] as ActionExample[][],
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        try {
            elizaLogger.info("📊 Processing transaction volume analysis request...");

            // Extract crypto symbol from target parameter (highest priority) or fall back to parsing message
            let cryptoSymbol: string;
            if (_options?.target && typeof _options.target === 'string') {
                cryptoSymbol = _options.target;
                elizaLogger.info(`🎯 Using crypto symbol from target parameter: ${cryptoSymbol}`);
            } else {
                cryptoSymbol = parseCryptoSymbol(message.content.text || "");
                elizaLogger.info(`📝 Parsed crypto symbol from message text: ${cryptoSymbol}`);
            }

            // Get comprehensive transaction volume analysis with the specified symbol (pass data retention for clamping)
            const retentionConfig = {
                dataRetentionDays: typeof _options?.dataRetentionDays === "number" ? _options.dataRetentionDays : undefined,
                dataRetentionMinDaysAgo: typeof _options?.dataRetentionMinDaysAgo === "number" ? _options.dataRetentionMinDaysAgo : undefined,
                dataRetentionMaxDaysAgo: typeof _options?.dataRetentionMaxDaysAgo === "number" ? _options.dataRetentionMaxDaysAgo : undefined,
            };
            const volumeResult = await getComprehensiveTakerVolumeAnalysis(runtime, message, state, cryptoSymbol, retentionConfig);

            if (!volumeResult.success || !volumeResult.data) {
                const errorMessage = `❌ Failed to fetch transaction volume analysis: ${volumeResult.error || "Unknown error"}`;
                
                if (callback) {
                    await callback(createActionErrorResponse({
                        actionName: "GET_TRANSACTION_VOLUME",
                        type: "transaction_volume_analysis_error",
                        error: new Error(volumeResult.error || "Unknown error"),
                        text: errorMessage,
                    }));
                }
                return false;
            }

            // Save data to file
            try {
                await saveTakerVolumeAnalysisToFile(volumeResult.data);
            } catch (saveError) {
                elizaLogger.warn("⚠️ Failed to save taker volume analysis data to file, but continuing with response:", saveError);
            }

            // Create chart
            let chartPath: string | undefined;
            try {
                // Extract timestamp parameters for chart period determination
                const messageText = message.content.text || "";
                const timestampParams = parseTimestampParams(messageText);
                const localChartPath = await createTransactionVolumeChart(volumeResult.data, timestampParams.start_time, timestampParams.end_time);
                elizaLogger.info(`📊 Chart created successfully: ${localChartPath}`);
                chartPath = buildChartProxyUrl(localChartPath, runtime.agentId);
            } catch (chartError) {
                elizaLogger.warn("⚠️ Failed to create transaction volume chart, but continuing with response:", chartError);
            }

            // Format the data for analysis
            const formattedAnalysis = formatTakerVolumeForAnalysis(volumeResult.data);

            // Create comprehensive response with chart information
            let responseText = formattedAnalysis;
            
            if (chartPath) {
                responseText += `\n\n📊 **Interactive Chart Generated**\nYou can view the interactive transaction volume chart using the chart button below.`;
            }

            const actionData = {
                summary: formattedAnalysis,
                symbol: volumeResult.data.symbol,
                exchanges: volumeResult.data.exchanges,
                isMultiExchange: volumeResult.data.isMultiExchange,
                latestData: volumeResult.data.latestData,
                analysis: volumeResult.data.analysis,
                chartPath
            };

            if (callback) {
                // Generate action summary
                const symbol = volumeResult.data.symbol;
                const dataPoints = volumeResult.data.historicalData?.length || 0;
                const totalVolume = volumeResult.data.analysis?.totalVolume || 0;
                const buyDominance = volumeResult.data.analysis?.buyDominance || 0;

                const actionSummary = generateActionSummary({
                    actionName: 'Transaction Volume',
                    assets: [symbol],
                    timePeriod: `${dataPoints} data points`,
                    dataPoints: dataPoints,
                    additionalInfo: `total volume $${formatLargeNumberUtil(totalVolume)}, ${buyDominance.toFixed(1)}% buy dominance`
                });

                await callback(createActionResponse({
                    actionName: "GET_TRANSACTION_VOLUME",
                    type: "transaction_volume_analysis",
                    text: responseText,
                    content: {
                        volumeData: volumeResult.data,
                        analysis: formattedAnalysis,
                        chartPath: chartPath,
                        visualizations: {
                            interactive_chart: chartPath,
                            chart_data: volumeResult.data.chartData
                        }
                    },
                    actionData: {
                        ...actionData,
                        summary: actionSummary,
                    },
                    chartPath: chartPath,
                    symbol: volumeResult.data.symbol,
                }));
            }

            elizaLogger.info("✅ Transaction volume analysis completed successfully");
            return true;

        } catch (error) {
            elizaLogger.error("❌ Error in transaction volume analysis handler:", error);
            
            const errorMessage = "I encountered an error while fetching transaction volume analysis data. Please try again later.";
            
            if (callback) {
                await callback(createActionErrorResponse({
                    actionName: "GET_TRANSACTION_VOLUME",
                    type: "transaction_volume_analysis_error",
                    error: error instanceof Error ? error : new Error(String(error)),
                    text: errorMessage,
                }));
            }
            
            return false;
        }
    }
,
    cacheConfig: {
        enabled: true,
        ttlSeconds: 86400, // 1 day for transaction volume data
        similarityThreshold: 0.7,
        maxChunkSize: 200,
    },
};
