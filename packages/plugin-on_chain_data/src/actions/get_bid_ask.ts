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
 * Enhanced Bid/Ask Volume & Amount Analysis
 * 
 * This module analyzes orderbook bid/ask volumes and USD amounts with advanced market depth analytics:
 * 
 * ORDERBOOK BID/ASK API (/api/futures/orderbook/aggregated-ask-bids-history) 
 * - Primary data source for bid/ask volume and amount analysis
 * - Bid volume/amount represents buying interest and support levels
 * - Ask volume/amount represents selling interest and resistance levels
 * - Data structure: [{ aggregated_bids_usd, aggregated_bids_quantity, aggregated_asks_usd, aggregated_asks_quantity, time }],
 * - Used for: Volume analysis, spread analysis, market depth assessment, liquidity distribution
 * 
 * Enhanced Analysis Features:
 * - Volume-weighted price analysis
 * - Bid/ask spread calculations
 * - Market depth profiling
 * - Volume distribution analysis
 * - Interactive Chart.js visualizations
 * - Mermaid market depth diagrams
 * 
 * Volume & Amount Interpretation:
 * - High bid volume = Strong buying interest (support)
 * - High ask volume = Strong selling interest (resistance)
 * - Volume vs USD amount ratio indicates average order sizes
 * - Spread analysis reveals market efficiency and liquidity
 * - Volume distribution shows institutional vs retail presence
 * 
 * Supports timestamp filtering:
 * - start_time: int64 - Start timestamp in milliseconds
 * - end_time: int64 - End timestamp in milliseconds
 */

// Types for bid/ask volume and amount data
export interface BidAskVolumePoint {
    aggregated_bids_usd: number;      // Aggregated long amount (USD)
    aggregated_bids_quantity: number; // Aggregated long quantity
    aggregated_asks_usd: number;      // Aggregated short amount (USD)
    aggregated_asks_quantity: number; // Aggregated short quantity
    time: number;                     // Timestamp (milliseconds)
    // Derived volume metrics
    bid_avg_price: number;            // Average bid price (USD/quantity)
    ask_avg_price: number;            // Average ask price (USD/quantity)
    spread_absolute: number;          // Absolute spread (USD)
    spread_percentage: number;        // Percentage spread
    total_volume: number;             // Total volume (quantity)
    total_usd: number;                // Total USD amount
    bid_volume_dominance: number;     // Bid volume percentage
    ask_volume_dominance: number;     // Ask volume percentage
    bid_usd_dominance: number;        // Bid USD percentage
    ask_usd_dominance: number;        // Ask USD percentage
    // Enhanced analytics
    volume_efficiency?: number;       // Volume efficiency ratio
    market_depth_score?: number;      // Market depth score (0-100)
    liquidity_quality?: number;       // Liquidity quality indicator
    order_size_ratio?: number;        // Average order size difference
}

export interface BidAskVolumeResponse {
    code: string;
    msg: string;
    data: BidAskVolumePoint[];
}

// Enhanced analysis interface with volume metrics
export interface BidAskVolumeAnalysis {
    symbol: string;
    exchange: string;
    latestData: BidAskVolumePoint;
    historicalData: BidAskVolumePoint[];
    analysis: {
        marketSentiment: string;
        volumeTrend: string;
        bidVolume: number;               // Total bid volume
        askVolume: number;               // Total ask volume
        bidUsdAmount: number;            // Total bid USD amount
        askUsdAmount: number;            // Total ask USD amount
        avgBidPrice: number;             // Average bid price
        avgAskPrice: number;             // Average ask price
        spreadAbsolute: number;          // Absolute spread
        spreadPercentage: number;        // Percentage spread
        volumeDominance: string;         // Which side dominates by volume
        usdDominance: string;            // Which side dominates by USD
        totalVolume: number;             // Total market volume
        totalUsd: number;                // Total market USD
        avgOrderSizeBid: number;         // Average bid order size
        avgOrderSizeAsk: number;         // Average ask order size
        marketDepthScore: number;        // Market depth score (0-100)
        liquidityQuality: number;        // Liquidity quality (0-100) 
        volumeEfficiency: number;        // Volume efficiency ratio
        marketStructure: string;         // Market structure assessment
        institutionalPresence: string;   // Institutional presence indicator
        retailActivity: string;          // Retail activity level
        priceDiscovery: string;          // Price discovery efficiency
        cryptoInfo: {
            name: string;
            category: string;
            tier: string;
        };
        exchangeInfo: {
            name: string;
            region: string;
            tier: string;
            type: string;
        };
    };
    // Visualization data
    chartData?: {
        labels: string[];
        bidVolumeData: number[];
        askVolumeData: number[];
        bidUsdData: number[];
        askUsdData: number[];
        spreadData: number[];
        depthScoreData: number[];
    };
}

export interface BidAskVolumeResult {
    success: boolean;
    data?: BidAskVolumeAnalysis;
    error?: string;
}

// Utility function to format large numbers
function formatLargeNumber(num: number): string {
    if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
    return num.toFixed(2);
}

// Function to parse exchange from user query
function parseExchange(messageText: string): string {
    const text = messageText.toLowerCase();
    
    // Look for explicit exchange mentions
    const exchangeKeywords = [
        'binance', 'coinbase', 'kraken', 'bybit', 'okx', 'kucoin', 'huobi', 'bitget',
        'gemini', 'bitfinex', 'bitstamp', 'crypto.com', 'gate.io', 'mexc', 'bitmex', 'deribit'
    ];
    
    for (const exchange of exchangeKeywords) {
        if (text.includes(exchange)) {
            return exchange;
        }
    }
    
    // Default to Binance if no specific exchange mentioned
    return DEFAULT_EXCHANGE;
}

// Function to parse cryptocurrency symbol from user query
function parseCryptoSymbol(messageText: string): string {
    const text = messageText.toUpperCase();
    
    // Get all crypto symbols from the categories database
    const cryptoSymbols = Object.keys(cryptoCategories);
    
    // First, look for exact word boundary matches for symbols
    for (const symbol of cryptoSymbols) {
        const regex = new RegExp(`\\b${symbol}\\b`, 'g');
        if (regex.test(text)) {
            return symbol;
        }
    }
    
    // Create name-to-symbol mapping from the categories database
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
    
    // Default to BTC if no specific crypto mentioned
    return 'BTC';
}

// Function to parse timestamp parameters from user query
function parseTimestampParams(messageText: string): { start_time?: number; end_time?: number } {
    const text = messageText.toLowerCase();
    let start_time: number | undefined;
    let end_time: number | undefined;
    
    // Look for timestamp patterns (milliseconds)
    const timestampRegex = /(\d{13})/g;
    const timestamps = text.match(timestampRegex);
    
    if (timestamps) {
        // If two timestamps found, assume first is start, second is end
        if (timestamps.length >= 2) {
            start_time = Number.parseInt(timestamps[0]);
            end_time = Number.parseInt(timestamps[1]);
        } else if (timestamps.length === 1) {
            // If only one timestamp, use it as end_time (up to this point)
            end_time = Number.parseInt(timestamps[0]);
        }
    }
    
    // Look for relative time expressions and convert to timestamps
    const now = Date.now();
    
    if (text.includes('last hour') || text.includes('past hour')) {
        start_time = now - (60 * 60 * 1000);
        end_time = now;
    } else if (text.includes('last 24 hours') || text.includes('past day')) {
        start_time = now - (24 * 60 * 60 * 1000);
        end_time = now;
    } else if (text.includes('last week') || text.includes('past week')) {
        start_time = now - (7 * 24 * 60 * 60 * 1000);
        end_time = now;
    } else if (text.includes('yesterday')) {
        const yesterdayStart = new Date();
        yesterdayStart.setDate(yesterdayStart.getDate() - 1);
        yesterdayStart.setHours(0, 0, 0, 0);
        const yesterdayEnd = new Date(yesterdayStart);
        yesterdayEnd.setHours(23, 59, 59, 999);
        start_time = yesterdayStart.getTime();
        end_time = yesterdayEnd.getTime();
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
    const start = start_time ?? end - 30 * MS_PER_DAY;
    const spanDays = (end - start) / MS_PER_DAY;
    if (spanDays <= maxDays) {
        return { start_time: start, end_time: end };
    }
    return {
        start_time: end - maxDays * MS_PER_DAY,
        end_time: end,
    };
}

// Function to get bid/ask volume and amount data
export async function getBidAskVolumeData(
    runtime: IAgentRuntime,
    symbol: string,
    start_time?: number,
    end_time?: number,
    exchange?: string
): Promise<{ success: boolean; data?: BidAskVolumePoint[]; error?: string }> {
    try {
        const timeRangeInfo = start_time || end_time 
            ? ` (${start_time ? new Date(start_time).toISOString() : 'earliest'} to ${end_time ? new Date(end_time).toISOString() : 'latest'})`
            : '';
        elizaLogger.info(`📊 Fetching bid/ask volume data for ${symbol}${timeRangeInfo}...`);

        const apiKey = process.env.COINGLASS_API_KEY;
        if (!apiKey) {
            throw new Error("COINGLASS_API_KEY environment variable is required");
        }

        // Use provided exchange or default to Binance
        const selectedExchange = exchange || DEFAULT_EXCHANGE;
        
        // Validate exchange
        if (!isValidExchange(selectedExchange)) {
            elizaLogger.warn(`⚠️ Invalid exchange '${selectedExchange}', falling back to ${DEFAULT_EXCHANGE}`);
        }
        
        const finalExchange = isValidExchange(selectedExchange) ? selectedExchange : DEFAULT_EXCHANGE;
        const exchangeInfo = getExchangeInfo(finalExchange);
        
        elizaLogger.info(`🏢 Using exchange: ${exchangeInfo.name} (${finalExchange}) - ${exchangeInfo.tier}, ${exchangeInfo.region}`);
        
        // Build URL with optional timestamp parameters
        let url = `https://open-api-v4.coinglass.com/api/futures/orderbook/aggregated-ask-bids-history?exchange_list=${finalExchange}&symbol=${symbol}&interval=h1`;
        
        if (start_time) {
            url += `&start_time=${start_time}`;
        }
        if (end_time) {
            url += `&end_time=${end_time}`;
        }
        
        const response = await httpClient.get(url, {
            headers: {
                'accept': 'application/json',
                'CG-API-KEY': apiKey
            }
        });
        
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`HTTP error! status: ${response.status} - ${response.statusText}`);
        }

        const bidAskResponse: BidAskVolumeResponse = response.data;
        
        elizaLogger.info(`📊 Bid/Ask Volume API Response - Code: ${bidAskResponse.code}, Message: ${bidAskResponse.msg}`);

        if (bidAskResponse.code !== "0") {
            throw new Error(`API Error: ${bidAskResponse.msg || 'Unknown error'} (Code: ${bidAskResponse.code})`);
        }

        if (!bidAskResponse.data || bidAskResponse.data.length === 0) {
            elizaLogger.error(`📊 API returned no data. Response structure:`, {
                hasData: !!bidAskResponse.data,
                dataLength: bidAskResponse.data?.length || 0,
                dataType: typeof bidAskResponse.data,
                symbol: symbol,
                url: url
            });
            
            // Try without time parameters if they were provided
            if (start_time || end_time) {
                elizaLogger.info(`📊 Retrying without time parameters...`);
                return getBidAskVolumeData(runtime, symbol, undefined, undefined, exchange);
            }
            
            throw new Error(`No bid/ask volume data available for ${symbol}. The API might not support this symbol or the data might be temporarily unavailable.`);
        }

        // Process data to add enhanced volume metrics
        const processedData: BidAskVolumePoint[] = bidAskResponse.data.map((point, index) => {
            // Calculate average prices
            const bidAvgPrice = point.aggregated_bids_quantity > 0 ? point.aggregated_bids_usd / point.aggregated_bids_quantity : 0;
            const askAvgPrice = point.aggregated_asks_quantity > 0 ? point.aggregated_asks_usd / point.aggregated_asks_quantity : 0;
            
            // Calculate spreads
            const spreadAbsolute = Math.abs(askAvgPrice - bidAvgPrice);
            const spreadPercentage = bidAvgPrice > 0 ? (spreadAbsolute / bidAvgPrice) * 100 : 0;
            
            // Calculate totals
            const totalVolume = point.aggregated_bids_quantity + point.aggregated_asks_quantity;
            const totalUsd = point.aggregated_bids_usd + point.aggregated_asks_usd;
            
            // Calculate dominance
            const bidVolumeDominance = totalVolume > 0 ? (point.aggregated_bids_quantity / totalVolume) * 100 : 50;
            const askVolumeDominance = 100 - bidVolumeDominance;
            const bidUsdDominance = totalUsd > 0 ? (point.aggregated_bids_usd / totalUsd) * 100 : 50;
            const askUsdDominance = 100 - bidUsdDominance;

            // Calculate enhanced metrics
            let volumeEfficiency = 0;
            let marketDepthScore = 0;
            let liquidityQuality = 0;
            let orderSizeRatio = 0;

            // Volume efficiency: how well volume translates to USD value
            if (totalVolume > 0 && totalUsd > 0) {
                const avgPriceWeighted = totalUsd / totalVolume;
                const midPoint = (bidAvgPrice + askAvgPrice) / 2;
                volumeEfficiency = midPoint > 0 ? (avgPriceWeighted / midPoint) * 100 : 100;
            }

            // Market depth score: based on total volume and spread
            if (totalVolume > 0) {
                const volumeScore = Math.min(100, (totalVolume / 1000) * 10); // Scale based on typical volumes
                const spreadScore = spreadPercentage < 0.1 ? 100 : Math.max(0, 100 - (spreadPercentage * 20));
                marketDepthScore = (volumeScore + spreadScore) / 2;
            }

            // Liquidity quality: combination of volume balance and tight spreads
            const balanceScore = 100 - Math.abs(bidVolumeDominance - 50) * 2; // Penalty for imbalance
            const tightnessScore = spreadPercentage < 0.05 ? 100 : Math.max(0, 100 - (spreadPercentage * 50));
            liquidityQuality = (balanceScore + tightnessScore) / 2;

            // Order size ratio: difference in average order sizes
            if (bidAvgPrice > 0 && askAvgPrice > 0) {
                orderSizeRatio = bidAvgPrice / askAvgPrice;
            } else {
                orderSizeRatio = 1;
            }

            return {
                ...point,
                bid_avg_price: bidAvgPrice,
                ask_avg_price: askAvgPrice,
                spread_absolute: spreadAbsolute,
                spread_percentage: spreadPercentage,
                total_volume: totalVolume,
                total_usd: totalUsd,
                bid_volume_dominance: bidVolumeDominance,
                ask_volume_dominance: askVolumeDominance,
                bid_usd_dominance: bidUsdDominance,
                ask_usd_dominance: askUsdDominance,
                volume_efficiency: volumeEfficiency,
                market_depth_score: marketDepthScore,
                liquidity_quality: liquidityQuality,
                order_size_ratio: orderSizeRatio
            };
        });

        elizaLogger.info(`✅ Successfully processed ${symbol} bid/ask volume data`);
        elizaLogger.info(`📊 ${processedData.length} data points processed`);

        return {
            success: true,
            data: processedData
        };

    } catch (error) {
        elizaLogger.error(
            `❌ Error fetching bid/ask volume data: ${formatAxiosErrorLine(error)}`
        );

        return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error occurred"
        };
    }
}

// Main function to get comprehensive bid/ask volume analysis
export async function getComprehensiveBidAskVolumeAnalysis(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    symbol?: string,
    options?: { dataRetentionDays?: number; dataRetentionMinDaysAgo?: number; dataRetentionMaxDaysAgo?: number }
): Promise<BidAskVolumeResult> {
    try {
        // Parse symbol from message or use provided symbol
        const cryptoSymbol = symbol || parseCryptoSymbol(message.content.text || "");
        
        // Parse exchange from message
        const exchange = parseExchange(message.content.text || "");
        
        // Parse timestamp parameters and clamp by subscription data retention if set
        let { start_time, end_time } = parseTimestampParams(message.content.text || "");
        const retentionConfig = {
            dataRetentionDays: options?.dataRetentionDays,
            dataRetentionMinDaysAgo: options?.dataRetentionMinDaysAgo,
            dataRetentionMaxDaysAgo: options?.dataRetentionMaxDaysAgo,
        };
        if (
            (typeof retentionConfig.dataRetentionDays === "number" && retentionConfig.dataRetentionDays >= 0) ||
            (typeof retentionConfig.dataRetentionMinDaysAgo === "number" && typeof retentionConfig.dataRetentionMaxDaysAgo === "number")
        ) {
            const clamped = clampTimestampRangeToRetention(start_time, end_time, retentionConfig);
            start_time = clamped.start_time;
            end_time = clamped.end_time;
        }
        
        elizaLogger.info(`🔍 Starting bid/ask volume analysis for ${cryptoSymbol}...`);

        // Clean up all previous files for this symbol before fetching new data
        await cleanupAllPreviousBidAskFiles(cryptoSymbol);

        // Fetch bid/ask volume data
        const bidAskResult = await getBidAskVolumeData(runtime, cryptoSymbol, start_time, end_time, exchange);
        
        if (!bidAskResult.success || !bidAskResult.data || bidAskResult.data.length === 0) {
            throw new Error(`Failed to fetch bid/ask volume data: ${bidAskResult.error}`);
        }

        // Get latest and historical data
        const latestData = bidAskResult.data[bidAskResult.data.length - 1];
        const historicalData = bidAskResult.data;

        // Calculate analysis metrics
        const bidVolume = latestData.aggregated_bids_quantity;
        const askVolume = latestData.aggregated_asks_quantity;
        const bidUsdAmount = latestData.aggregated_bids_usd;
        const askUsdAmount = latestData.aggregated_asks_usd;
        const avgBidPrice = latestData.bid_avg_price;
        const avgAskPrice = latestData.ask_avg_price;
        const spreadAbsolute = latestData.spread_absolute;
        const spreadPercentage = latestData.spread_percentage;
        const totalVolume = latestData.total_volume;
        const totalUsd = latestData.total_usd;

        // Calculate average order sizes
        const avgOrderSizeBid = bidVolume > 0 ? bidUsdAmount / bidVolume : 0;
        const avgOrderSizeAsk = askVolume > 0 ? askUsdAmount / askVolume : 0;

        // Calculate average metrics from historical data
        const avgMarketDepthScore = historicalData.reduce((sum, point) => sum + (point.market_depth_score || 0), 0) / historicalData.length;
        const avgLiquidityQuality = historicalData.reduce((sum, point) => sum + (point.liquidity_quality || 0), 0) / historicalData.length;
        const avgVolumeEfficiency = historicalData.reduce((sum, point) => sum + (point.volume_efficiency || 0), 0) / historicalData.length;

        // Determine volume trend
        let volumeTrend: string;
        if (historicalData.length > 1) {
            const firstHalf = historicalData.slice(0, Math.floor(historicalData.length / 2));
            const secondHalf = historicalData.slice(Math.floor(historicalData.length / 2));
            
            const firstHalfAvg = firstHalf.reduce((sum, point) => sum + point.total_volume, 0) / firstHalf.length;
            const secondHalfAvg = secondHalf.reduce((sum, point) => sum + point.total_volume, 0) / secondHalf.length;
            
            const trendPercentage = ((secondHalfAvg - firstHalfAvg) / firstHalfAvg) * 100;
            
            if (trendPercentage > 10) {
                volumeTrend = "📈 INCREASING VOLUME";
            } else if (trendPercentage < -10) {
                volumeTrend = "📉 DECREASING VOLUME";
            } else {
                volumeTrend = "➡️ STABLE VOLUME";
            }
        } else {
            volumeTrend = "➡️ STABLE VOLUME";
        }

        // Determine market sentiment, dominance, and other analysis
        let marketSentiment: string;
        let volumeDominance: string;
        let usdDominance: string;
        let marketStructure: string;
        let institutionalPresence: string;
        let retailActivity: string;
        let priceDiscovery: string;

        // Market sentiment based on volume and spread analysis
        if (latestData.bid_volume_dominance > 60 && spreadPercentage < 0.1) {
            marketSentiment = "🟢 STRONGLY BULLISH";
        } else if (latestData.bid_volume_dominance > 55) {
            marketSentiment = "🟢 BULLISH";
        } else if (latestData.ask_volume_dominance > 60 && spreadPercentage < 0.1) {
            marketSentiment = "🔴 STRONGLY BEARISH";
        } else if (latestData.ask_volume_dominance > 55) {
            marketSentiment = "🔴 BEARISH";
        } else {
            marketSentiment = "🟡 NEUTRAL";
        }

        // Volume dominance
        if (latestData.bid_volume_dominance > 60) {
            volumeDominance = "🟢 BID VOLUME DOMINANCE";
        } else if (latestData.ask_volume_dominance > 60) {
            volumeDominance = "🔴 ASK VOLUME DOMINANCE";
        } else {
            volumeDominance = "⚖️ BALANCED VOLUME";
        }

        // USD dominance
        if (latestData.bid_usd_dominance > 60) {
            usdDominance = "🟢 BID USD DOMINANCE";
        } else if (latestData.ask_usd_dominance > 60) {
            usdDominance = "🔴 ASK USD DOMINANCE";
        } else {
            usdDominance = "⚖️ BALANCED USD";
        }

        // Market structure assessment
        if (avgMarketDepthScore > 80) {
            marketStructure = "🏗️ EXCELLENT STRUCTURE";
        } else if (avgMarketDepthScore > 60) {
            marketStructure = "🏗️ GOOD STRUCTURE";
        } else if (avgMarketDepthScore > 40) {
            marketStructure = "🏗️ MODERATE STRUCTURE";
        } else {
            marketStructure = "🏗️ WEAK STRUCTURE";
        }

        // Institutional presence based on average order sizes
        const avgOrderSize = (avgOrderSizeBid + avgOrderSizeAsk) / 2;
        if (avgOrderSize > 500000) {
            institutionalPresence = "🏛️ VERY HIGH INSTITUTIONAL";
        } else if (avgOrderSize > 200000) {
            institutionalPresence = "🏛️ HIGH INSTITUTIONAL";
        } else if (avgOrderSize > 50000) {
            institutionalPresence = "🏛️ MODERATE INSTITUTIONAL";
        } else {
            institutionalPresence = "🏛️ LOW INSTITUTIONAL";
        }

        // Retail activity (inverse of institutional)
        if (avgOrderSize < 10000) {
            retailActivity = "👥 VERY HIGH RETAIL";
        } else if (avgOrderSize < 50000) {
            retailActivity = "👥 HIGH RETAIL";
        } else if (avgOrderSize < 200000) {
            retailActivity = "👥 MODERATE RETAIL";
        } else {
            retailActivity = "👥 LOW RETAIL";
        }

        // Price discovery efficiency based on spread
        if (spreadPercentage < 0.05) {
            priceDiscovery = "⚡ EXCELLENT DISCOVERY";
        } else if (spreadPercentage < 0.1) {
            priceDiscovery = "⚡ GOOD DISCOVERY";
        } else if (spreadPercentage < 0.5) {
            priceDiscovery = "⚡ MODERATE DISCOVERY";
        } else {
            priceDiscovery = "⚡ POOR DISCOVERY";
        }

        // Get crypto and exchange information
        const cryptoInfo = getCryptoInfo(cryptoSymbol);
        const exchangeInfo = getExchangeInfo(exchange);

        // Prepare chart data for visualization
        const timeSpan = historicalData.length > 1 ? 
            historicalData[historicalData.length - 1].time - historicalData[0].time : 0;
        const isShortTerm = timeSpan <= (7 * 24 * 60 * 60 * 1000);
        
        const chartData = {
            labels: historicalData.map(point => {
                const date = new Date(point.time);
                if (isShortTerm) {
                    return date.toLocaleString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                    });
                } else {
                    return date.toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric'
                    });
                }
            }),
            bidVolumeData: historicalData.map(point => point.aggregated_bids_quantity),
            askVolumeData: historicalData.map(point => point.aggregated_asks_quantity),
            bidUsdData: historicalData.map(point => point.aggregated_bids_usd / 1000000), // Convert to millions
            askUsdData: historicalData.map(point => point.aggregated_asks_usd / 1000000), // Convert to millions
            spreadData: historicalData.map(point => point.spread_percentage),
            depthScoreData: historicalData.map(point => point.market_depth_score || 0)
        };

        const analysis: BidAskVolumeAnalysis = {
            symbol: cryptoSymbol,
            exchange: exchange,
            latestData,
            historicalData,
            analysis: {
                marketSentiment,
                volumeTrend,
                bidVolume,
                askVolume,
                bidUsdAmount,
                askUsdAmount,
                avgBidPrice,
                avgAskPrice,
                spreadAbsolute,
                spreadPercentage,
                volumeDominance,
                usdDominance,
                totalVolume,
                totalUsd,
                avgOrderSizeBid,
                avgOrderSizeAsk,
                marketDepthScore: avgMarketDepthScore,
                liquidityQuality: avgLiquidityQuality,
                volumeEfficiency: avgVolumeEfficiency,
                marketStructure,
                institutionalPresence,
                retailActivity,
                priceDiscovery,
                cryptoInfo: {
                    name: cryptoInfo.name,
                    category: cryptoInfo.category,
                    tier: cryptoInfo.tier
                },
                exchangeInfo: {
                    name: exchangeInfo.name,
                    region: exchangeInfo.region,
                    tier: exchangeInfo.tier,
                    type: exchangeInfo.type
                }
            },
            chartData
        };

        elizaLogger.info(`✅ Successfully completed bid/ask volume analysis for ${cryptoSymbol}`);
        elizaLogger.info(`📊 Total volume: ${formatLargeNumber(totalVolume)} | Total USD: $${formatLargeNumber(totalUsd)}`);
        elizaLogger.info(`📊 Spread: ${spreadPercentage.toFixed(3)}% | Depth score: ${avgMarketDepthScore.toFixed(1)}`);

        return {
            success: true,
            data: analysis
        };

    } catch (error) {
        elizaLogger.error("❌ Error in bid/ask volume analysis:", error);
        
        if (error instanceof Error) {
            elizaLogger.error(`❌ Error details: ${error.message}`);
        }
        
        return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error occurred"
        };
    }
}

// Function to clean up previous data files for a symbol
async function cleanupPreviousBidAskData(symbol: string): Promise<void> {
    try {
        const CACHE_DIR = path.join(process.cwd(), 'cache');
        const saveDirectory = path.join(CACHE_DIR, 'bid_ask_data');
        
        if (!fs.existsSync(saveDirectory)) {
            return; // No directory to clean
        }
        
        // Read all files in the directory
        const files = fs.readdirSync(saveDirectory);
        
        // Filter files that match the symbol pattern
        const symbolFiles = files.filter(file => 
            file.startsWith(`bid_ask_${symbol}_`) && file.endsWith('.json')
        );
        
        // Delete matching files
        for (const file of symbolFiles) {
            const filepath = path.join(saveDirectory, file);
            fs.unlinkSync(filepath);
            elizaLogger.info(`🗑️ Deleted previous bid/ask data: ${file}`);
        }
        
        if (symbolFiles.length > 0) {
            elizaLogger.info(`✨ Cleaned up ${symbolFiles.length} previous ${symbol} bid/ask data files`);
        }
        
    } catch (error) {
        elizaLogger.warn("⚠️ Error cleaning up previous bid/ask data files:", error);
        // Don't throw - this is cleanup, not critical
    }
}

// Function to clean up previous chart files for a symbol
async function cleanupPreviousBidAskCharts(symbol: string): Promise<void> {
    try {
        const savedDataDir = path.join(process.cwd(), 'saved_data');
        const chartsDirectory = path.join(savedDataDir, 'Charts');
        
        if (!fs.existsSync(chartsDirectory)) {
            return; // No directory to clean
        }
        
        // Read all files in the directory
        const files = fs.readdirSync(chartsDirectory);
        
        // Filter files that match the pattern with ticker and date range
        // Matches patterns like: Bid Ask Volume Chart BTC 2025-01-01~2025-01-31.html or Bid Ask Volume Chart BTC 2025-01-01.html
        const pattern = new RegExp(`^Bid Ask Volume Chart ${symbol} \\d{4}-\\d{2}-\\d{2}(~\\d{4}-\\d{2}-\\d{2})?\\.html$`);
        const symbolFiles = files.filter(file => pattern.test(file));

        // Note: Chart deletion disabled to preserve historical data
        // Old charts are kept for reference in chat history
        if (symbolFiles.length > 0) {
            elizaLogger.info(`📊 Found ${symbolFiles.length} existing ${symbol} bid/ask chart(s) (keeping for history)`);
        }

        // Delete matching files
        // for (const file of symbolFiles) {
        //     const filepath = path.join(chartsDirectory, file);
        //     fs.unlinkSync(filepath);
        //     elizaLogger.info(`🗑️ Deleted previous bid/ask chart: ${file}`);
        // }
        
    } catch (error) {
        elizaLogger.warn("⚠️ Error cleaning up previous chart files:", error);
        // Don't throw - this is cleanup, not critical
    }
}

// Function to perform comprehensive cleanup for a symbol (both data and charts)
async function cleanupAllPreviousBidAskFiles(symbol: string): Promise<void> {
    try {
        elizaLogger.info(`🧹 Starting cleanup of all previous ${symbol} bid/ask files...`);
        
        // Clean up data files and chart files in parallel
        await Promise.all([
            cleanupPreviousBidAskData(symbol),
            cleanupPreviousBidAskCharts(symbol)
        ]);
        
        elizaLogger.info(`✅ Completed cleanup for ${symbol} bid/ask files`);
        
    } catch (error) {
        elizaLogger.warn(`⚠️ Error during comprehensive cleanup for ${symbol}:`, error);
        // Don't throw - this is cleanup, not critical
    }
}

// Function to save bid/ask analysis data to file
async function saveBidAskAnalysisToFile(analysis: BidAskVolumeAnalysis): Promise<void> {
    try {
        const CACHE_DIR = path.join(process.cwd(), 'cache');
        const saveDirectory = path.join(CACHE_DIR, 'bid_ask_data');
        
        // Clean up previous data files for this symbol first
        await cleanupPreviousBidAskData(analysis.symbol);
        
        // Create cache and bid_ask_data directories if they don't exist
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
        const filename = `bid_ask_${analysis.symbol}_${timestamp}.json`;
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
        
        elizaLogger.info(`💾 Bid/Ask analysis data saved to: ${filepath}`);
        elizaLogger.info(`📊 Saved ${analysis.symbol} data with ${formatLargeNumber(analysis.latestData.total_volume)} total volume`);
        
    } catch (error) {
        elizaLogger.error("❌ Error saving bid/ask analysis data to file:", error);
        throw error;
    }
}

// Generate interactive Chart.js visualization for bid/ask volume data
function generateBidAskVolumeChart(analysis: BidAskVolumeAnalysis): string {
    const { chartData } = analysis;
    if (!chartData) {
        return '<p>No chart data available</p>';
    }

    const labels = chartData.labels.map(label => `"${label}"`).join(',');
    const bidVolumeData = chartData.bidVolumeData.join(',');
    const askVolumeData = chartData.askVolumeData.join(',');
    const bidUsdData = chartData.bidUsdData.join(',');
    const askUsdData = chartData.askUsdData.join(',');
    const spreadData = chartData.spreadData.join(',');
    const depthScoreData = chartData.depthScoreData.join(',');

    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${analysis.symbol} Bid/Ask Volume Analysis Chart</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js" crossorigin="anonymous" onerror="document.body.innerHTML='<p style=\\'font-family:sans-serif;padding:1rem\\'>Chart library failed to load. Check network or try opening this page in a new tab.</p>'"></script>
  <style>
    body { 
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
      margin: 0; 
      padding: 20px; 
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #333;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
      background: white;
      border-radius: 15px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.1);
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #2c3e50 0%, #3498db 100%);
      color: white;
      padding: 30px;
      text-align: center;
    }
    .header h1 {
      margin: 0;
      font-size: 2.5em;
      font-weight: 300;
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 20px;
      padding: 30px;
      background: #f8f9fa;
    }
    .metric-card {
      background: white;
      padding: 20px;
      border-radius: 10px;
      box-shadow: 0 5px 15px rgba(0,0,0,0.1);
      border-left: 4px solid #3498db;
    }
    .metric-card h3 {
      margin: 0 0 10px 0;
      color: #2c3e50;
      font-size: 1.1em;
    }
    .metric-value {
      font-size: 1.5em;
      font-weight: bold;
      color: #3498db;
    }
    .chart-container {
      position: relative;
      height: clamp(240px, 40vw, 480px);
      margin: 30px;
    }
    .chart-section {
      margin: 30px;
      background: white;
      border-radius: 10px;
      padding: 20px;
      box-shadow: 0 5px 15px rgba(0,0,0,0.1);
    }
    .chart-title {
      font-size: 1.3em;
      font-weight: bold;
      margin-bottom: 20px;
      color: #2c3e50;
      text-align: center;
    }
    .status-indicators {
      display: flex;
      justify-content: space-around;
      padding: 20px;
      background: #f8f9fa;
      border-radius: 10px;
      margin: 20px;
    }
    .status-item {
      text-align: center;
      padding: 15px;
      background: white;
      border-radius: 8px;
      box-shadow: 0 3px 10px rgba(0,0,0,0.1);
      min-width: 120px;
    }
    .status-emoji {
      font-size: 2em;
      margin-bottom: 10px;
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
    body.compact-view .status-indicators,
    body.compact-view .metrics-grid,
    body.compact-view .chart-title {
      display: none;
    }
    body.compact-view .chart-section {
      margin: 0;
      background: transparent;
      box-shadow: none;
      padding: 0;
    }
    body.compact-view .chart-container {
      margin: 0;
      height: clamp(200px, 40vw, 520px);
      min-height: 200px;
      max-height: 540px;
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
      <h1>${analysis.symbol} Bid/Ask Volume Analysis</h1>
      <p>Exchange: ${analysis.analysis.exchangeInfo.name} | Market Structure: ${analysis.analysis.marketStructure}</p>
    </div>

    <div class="status-indicators">
      <div class="status-item">
        <div class="status-emoji">💰</div>
        <strong>Market Sentiment</strong><br>
        ${analysis.analysis.marketSentiment}
      </div>
      <div class="status-item">
        <div class="status-emoji">📊</div>
        <strong>Volume Dominance</strong><br>
        ${analysis.analysis.volumeDominance}
      </div>
      <div class="status-item">
        <div class="status-emoji">💎</div>
        <strong>USD Dominance</strong><br>
        ${analysis.analysis.usdDominance}
      </div>
      <div class="status-item">
        <div class="status-emoji">🏛️</div>
        <strong>Institutional Presence</strong><br>
        ${analysis.analysis.institutionalPresence}
      </div>
    </div>

    <div class="metrics-grid">
      <div class="metric-card">
        <h3>🟢 Bid Volume</h3>
        <div class="metric-value">${formatLargeNumber(analysis.analysis.bidVolume)}</div>
        <p>Avg Price: $${analysis.analysis.avgBidPrice.toFixed(2)}</p>
      </div>
      <div class="metric-card">
        <h3>🔴 Ask Volume</h3>
        <div class="metric-value">${formatLargeNumber(analysis.analysis.askVolume)}</div>
        <p>Avg Price: $${analysis.analysis.avgAskPrice.toFixed(2)}</p>
      </div>
      <div class="metric-card">
        <h3>💰 Bid USD Amount</h3>
        <div class="metric-value">$${formatLargeNumber(analysis.analysis.bidUsdAmount)}</div>
        <p>Avg Order: $${formatLargeNumber(analysis.analysis.avgOrderSizeBid)}</p>
      </div>
      <div class="metric-card">
        <h3>💰 Ask USD Amount</h3>
        <div class="metric-value">$${formatLargeNumber(analysis.analysis.askUsdAmount)}</div>
        <p>Avg Order: $${formatLargeNumber(analysis.analysis.avgOrderSizeAsk)}</p>
      </div>
      <div class="metric-card">
        <h3>📏 Spread Analysis</h3>
        <div class="metric-value">${analysis.analysis.spreadPercentage.toFixed(3)}%</div>
        <p>Absolute: $${analysis.analysis.spreadAbsolute.toFixed(2)}</p>
      </div>
      <div class="metric-card">
        <h3>🏗️ Market Depth Score</h3>
        <div class="metric-value">${analysis.analysis.marketDepthScore.toFixed(1)}/100</div>
        <p>Quality: ${analysis.analysis.liquidityQuality.toFixed(1)}/100</p>
      </div>
    </div>

    <div class="chart-section">
      <div class="chart-title">📊 Volume Analysis: Bid vs Ask</div>
      <div class="chart-container">
        <canvas id="volumeChart"></canvas>
      </div>
    </div>

    <div class="chart-section">
      <div class="chart-title">💰 USD Amount Analysis: Bid vs Ask (Millions)</div>
      <div class="chart-container">
        <canvas id="usdChart"></canvas>
      </div>
    </div>

    <div class="chart-section">
      <div class="chart-title">📏 Spread & Market Depth Analysis</div>
      <div class="chart-container">
        <canvas id="spreadDepthChart"></canvas>
      </div>
    </div>
  </div>

  <script>
    const dates = [${labels}];
    const bidVolumeData = [${bidVolumeData}];
    const askVolumeData = [${askVolumeData}];
    const bidUsdData = [${bidUsdData}];
    const askUsdData = [${askUsdData}];
    const spreadData = [${spreadData}];
    const depthScoreData = [${depthScoreData}];

    // Volume Chart
    new Chart(document.getElementById('volumeChart'), {
      type: 'line',
      data: {
        labels: dates,
        datasets: [
          {
            label: 'Bid Volume',
            data: bidVolumeData,
            borderColor: '#27ae60',
            backgroundColor: 'rgba(39, 174, 96, 0.1)',
            borderWidth: 2,
            fill: true,
            tension: 0.4,
            pointRadius: 3,
            pointHoverRadius: 6,
            pointBackgroundColor: '#27ae60',
            pointBorderColor: '#ffffff',
            pointBorderWidth: 1
          },
          {
            label: 'Ask Volume',
            data: askVolumeData,
            borderColor: '#e74c3c',
            backgroundColor: 'rgba(231, 76, 60, 0.1)',
            borderWidth: 2,
            fill: true,
            tension: 0.4,
            pointRadius: 3,
            pointHoverRadius: 6,
            pointBackgroundColor: '#e74c3c',
            pointBorderColor: '#ffffff',
            pointBorderWidth: 1
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
            labels: {
              usePointStyle: true,
              padding: 20
            }
          }
        },
        scales: {
          x: {
            grid: {
              display: true,
              color: 'rgba(0,0,0,0.1)'
            },
            ticks: {
              maxRotation: 45,
              minRotation: 45,
              autoSkip: true,
              maxTicksLimit: 20
            }
          },
          y: {
            grid: {
              display: true,
              color: 'rgba(0,0,0,0.1)'
            }
          }
        }
      }
    });

    // USD Chart
    new Chart(document.getElementById('usdChart'), {
      type: 'bar',
      data: {
        labels: dates,
        datasets: [
          {
            label: 'Bid USD (M)',
            data: bidUsdData,
            backgroundColor: 'rgba(39, 174, 96, 0.8)',
            borderColor: '#27ae60',
            borderWidth: 1,
            borderRadius: 4
          },
          {
            label: 'Ask USD (M)',
            data: askUsdData,
            backgroundColor: 'rgba(231, 76, 60, 0.8)',
            borderColor: '#e74c3c',
            borderWidth: 1,
            borderRadius: 4
          }
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'top',
            labels: {
              usePointStyle: true,
              padding: 20
            }
          }
        },
        scales: {
          x: {
            grid: {
              display: false
            },
            ticks: {
              maxRotation: 45,
              minRotation: 45,
              autoSkip: true,
              maxTicksLimit: 20
            }
          },
          y: {
            grid: {
              display: true,
              color: 'rgba(0,0,0,0.1)'
            },
            ticks: {
              callback: function(value) {
                return '$' + value + 'M';
              }
            }
          }
        }
      }
    });

    // Spread & Depth Chart
    new Chart(document.getElementById('spreadDepthChart'), {
      type: 'line',
      data: {
        labels: dates,
        datasets: [
          {
            label: 'Spread (%)',
            data: spreadData,
            borderColor: '#f39c12',
            backgroundColor: 'rgba(243, 156, 18, 0.1)',
            borderWidth: 2,
            yAxisID: 'y',
            pointRadius: 2,
            pointHoverRadius: 5,
            fill: false,
            tension: 0.3
          },
          {
            label: 'Market Depth Score',
            data: depthScoreData,
            borderColor: '#9b59b6',
            backgroundColor: 'rgba(155, 89, 182, 0.1)',
            borderWidth: 2,
            yAxisID: 'y1',
            pointRadius: 2,
            pointHoverRadius: 5,
            fill: false,
            tension: 0.3
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
            labels: {
              usePointStyle: true,
              padding: 20
            }
          }
        },
        scales: {
          x: {
            grid: {
              display: true,
              color: 'rgba(0,0,0,0.1)'
            },
            ticks: {
              maxRotation: 45,
              minRotation: 45,
              autoSkip: true,
              maxTicksLimit: 20
            }
          },
          y: {
            type: 'linear',
            display: true,
            position: 'left',
            title: {
              display: true,
              text: 'Spread (%)'
            },
            grid: {
              display: true,
              color: 'rgba(0,0,0,0.1)'
            }
          },
          y1: {
            type: 'linear',
            display: true,
            position: 'right',
            title: {
              display: true,
              text: 'Depth Score'
            },
            grid: {
              drawOnChartArea: false,
            }
          }
        }
      }
    });

    // Send height to parent window for iframe auto-sizing (compact: avoid html viewport loop).
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
}

// Generate Mermaid diagram for bid/ask volume analysis
function generateBidAskVolumeMermaidDiagram(analysis: BidAskVolumeAnalysis): string {
    const { analysis: volumeAnalysis } = analysis;
    
    // Determine colors based on dominance
    const bidColor = volumeAnalysis.bidVolume > volumeAnalysis.askVolume ? "fill:#2ecc71" : "fill:#95a5a6";
    const askColor = volumeAnalysis.askVolume > volumeAnalysis.bidVolume ? "fill:#e74c3c" : "fill:#95a5a6";
    
    return `graph TD
    A["📊 ${analysis.symbol} Market"] --> B["📈 Orderbook Volume Analysis"],
    
    B --> C["🟢 Bid Volume<br/>${formatLargeNumber(volumeAnalysis.bidVolume)}<br/>$${formatLargeNumber(volumeAnalysis.bidUsdAmount)}"],
    B --> D["🔴 Ask Volume<br/>${formatLargeNumber(volumeAnalysis.askVolume)}<br/>$${formatLargeNumber(volumeAnalysis.askUsdAmount)}"],
    
    C --> E["💰 Avg Bid Price<br/>$${volumeAnalysis.avgBidPrice.toFixed(2)}"],
    D --> F["💰 Avg Ask Price<br/>$${volumeAnalysis.avgAskPrice.toFixed(2)}"],
    
    E --> G["📏 Spread Analysis<br/>${volumeAnalysis.spreadPercentage.toFixed(3)}%<br/>$${volumeAnalysis.spreadAbsolute.toFixed(2)}"],
    F --> G
    
    G --> H["🏗️ Market Structure<br/>${volumeAnalysis.marketStructure}<br/>Depth: ${volumeAnalysis.marketDepthScore.toFixed(1)}/100"],
    
    H --> I["🏛️ Order Analysis<br/>${volumeAnalysis.institutionalPresence}<br/>${volumeAnalysis.retailActivity}"],
    
    I --> J["⚡ Price Discovery<br/>${volumeAnalysis.priceDiscovery}<br/>Efficiency: ${volumeAnalysis.volumeEfficiency.toFixed(1)}%"],
    
    J --> K["🎯 Market Sentiment<br/>${volumeAnalysis.marketSentiment}"],
    
    style A fill:#3498db,stroke:#2980b9,stroke-width:3px,color:#fff
    style B fill:#34495e,stroke:#2c3e50,stroke-width:2px,color:#fff
    style C ${bidColor},stroke:#27ae60,stroke-width:2px,color:#fff
    style D ${askColor},stroke:#c0392b,stroke-width:2px,color:#fff
    style E fill:#f39c12,stroke:#e67e22,stroke-width:2px,color:#fff
    style F fill:#f39c12,stroke:#e67e22,stroke-width:2px,color:#fff
    style G fill:#9b59b6,stroke:#8e44ad,stroke-width:2px,color:#fff
    style H fill:#00bcd4,stroke:#0097a7,stroke-width:2px,color:#fff
    style I fill:#ff9800,stroke:#f57c00,stroke-width:2px,color:#fff
    style J fill:#e91e63,stroke:#c2185b,stroke-width:2px,color:#fff
    style K fill:#4caf50,stroke:#388e3c,stroke-width:2px,color:#fff`;
}

// Save chart HTML to file
async function saveBidAskVolumeChartToFile(analysis: BidAskVolumeAnalysis, start_time?: number, end_time?: number): Promise<string> {
    try {
        const savedDataDir = path.join(process.cwd(), 'saved_data');
        const chartsDirectory = path.join(savedDataDir, 'Charts');
        
        // Clean up previous chart files for this symbol first
        await cleanupPreviousBidAskCharts(analysis.symbol);
        
        // Create directories if they don't exist
        if (!fs.existsSync(savedDataDir)) {
            fs.mkdirSync(savedDataDir, { recursive: true });
            elizaLogger.info(`📁 Created directory: ${savedDataDir}`);
        }
        
        if (!fs.existsSync(chartsDirectory)) {
            fs.mkdirSync(chartsDirectory, { recursive: true });
            elizaLogger.info(`📁 Created charts directory: ${chartsDirectory}`);
        }
        
        // Generate chart HTML
        const chartHTML = generateBidAskVolumeChart(analysis);
        
        // Determine date range from timeframe and data
        const dateRange = determineDateRange(analysis.historicalData, start_time, end_time);
        
        // Generate standardized filename format: [Chart Title] [Ticker] [DateRange],
        const filename = `Bid Ask Volume Chart ${analysis.symbol} ${dateRange}.html`;
        const filepath = path.join(chartsDirectory, filename);
        
        // Write chart to file
        fs.writeFileSync(filepath, chartHTML);
        
        elizaLogger.info(`📊 Bid/Ask volume chart saved to: ${filepath}`);
        
        return filepath;
        
    } catch (error) {
        elizaLogger.error("❌ Error saving bid/ask volume chart to file:", error);
        throw error;
    }
}

// Format bid/ask volume analysis data for AI response
export function formatBidAskVolumeForAnalysis(analysis: BidAskVolumeAnalysis): string {
    const { latestData, analysis: volumeAnalysis } = analysis;
    
    let output = `## 📊 ${volumeAnalysis.cryptoInfo.name} (${analysis.symbol}) - Bid/Ask Volume & Amount Analysis\n\n`;
    
    // Header with crypto and exchange info
    output += `**Asset**: ${volumeAnalysis.cryptoInfo.name} | **Category**: ${volumeAnalysis.cryptoInfo.category} | **Tier**: ${volumeAnalysis.cryptoInfo.tier}\n`;
    output += `**Exchange**: ${volumeAnalysis.exchangeInfo.name} (${analysis.exchange}) | **Region**: ${volumeAnalysis.exchangeInfo.region} | **Type**: ${volumeAnalysis.exchangeInfo.type}\n\n`;
    
    // Core Volume & Amount Analysis
    output += `### 📊 Core Volume & Amount Analysis:\n`;
    output += `- **Market Sentiment**: ${volumeAnalysis.marketSentiment}\n`;
    output += `- **Volume Trend**: ${volumeAnalysis.volumeTrend}\n`;
    output += `- **Volume Dominance**: ${volumeAnalysis.volumeDominance}\n`;
    output += `- **USD Dominance**: ${volumeAnalysis.usdDominance}\n`;
    output += `- **Total Volume**: ${formatLargeNumber(volumeAnalysis.totalVolume)} units\n`;
    output += `- **Total USD Amount**: $${formatLargeNumber(volumeAnalysis.totalUsd)}\n\n`;

    // Detailed Bid/Ask Breakdown
    output += `### 🔍 Detailed Bid/Ask Breakdown:\n`;
    output += `- **Bid Volume**: ${formatLargeNumber(volumeAnalysis.bidVolume)} units (${latestData.bid_volume_dominance.toFixed(1)}%)\n`;
    output += `- **Ask Volume**: ${formatLargeNumber(volumeAnalysis.askVolume)} units (${latestData.ask_volume_dominance.toFixed(1)}%)\n`;
    output += `- **Bid USD Amount**: $${formatLargeNumber(volumeAnalysis.bidUsdAmount)} (${latestData.bid_usd_dominance.toFixed(1)}%)\n`;
    output += `- **Ask USD Amount**: $${formatLargeNumber(volumeAnalysis.askUsdAmount)} (${latestData.ask_usd_dominance.toFixed(1)}%)\n`;
    output += `- **Average Bid Price**: $${volumeAnalysis.avgBidPrice.toFixed(2)}\n`;
    output += `- **Average Ask Price**: $${volumeAnalysis.avgAskPrice.toFixed(2)}\n`;
    output += `- **Spread (Absolute)**: $${volumeAnalysis.spreadAbsolute.toFixed(2)}\n`;
    output += `- **Spread (Percentage)**: ${volumeAnalysis.spreadPercentage.toFixed(3)}%\n\n`;

    // Order Size Analysis
    output += `### 💰 Order Size Analysis:\n`;
    output += `- **Average Bid Order Size**: $${formatLargeNumber(volumeAnalysis.avgOrderSizeBid)}\n`;
    output += `- **Average Ask Order Size**: $${formatLargeNumber(volumeAnalysis.avgOrderSizeAsk)}\n`;
    output += `- **Order Size Ratio**: ${latestData.order_size_ratio?.toFixed(3) || 'N/A'}\n`;
    output += `- **Institutional Presence**: ${volumeAnalysis.institutionalPresence}\n`;
    output += `- **Retail Activity**: ${volumeAnalysis.retailActivity}\n\n`;

    // Market Quality Metrics
    output += `### 🏗️ Market Quality Metrics:\n`;
    output += `- **Market Structure**: ${volumeAnalysis.marketStructure}\n`;
    output += `- **Market Depth Score**: ${volumeAnalysis.marketDepthScore.toFixed(1)}/100\n`;
    output += `- **Liquidity Quality**: ${volumeAnalysis.liquidityQuality.toFixed(1)}/100\n`;
    output += `- **Volume Efficiency**: ${volumeAnalysis.volumeEfficiency.toFixed(1)}%\n`;
    output += `- **Price Discovery**: ${volumeAnalysis.priceDiscovery}\n`;
    output += `- **Last Updated**: ${new Date(latestData.time).toLocaleString()}\n\n`;

    // Advanced Analysis Insights
    output += `### 🔬 Advanced Analysis Insights:\n`;
    
    // Volume dominance insights
    if (latestData.bid_volume_dominance > 65) {
        output += `- **Strong Buying Interest**: Overwhelming bid volume dominance (${latestData.bid_volume_dominance.toFixed(1)}%) indicates strong buying pressure\n`;
    } else if (latestData.ask_volume_dominance > 65) {
        output += `- **Strong Selling Interest**: Overwhelming ask volume dominance (${latestData.ask_volume_dominance.toFixed(1)}%) indicates strong selling pressure\n`;
    } else {
        output += `- **Balanced Volume Distribution**: Relatively balanced bid/ask volume suggests market equilibrium\n`;
    }

    // USD amount vs volume analysis
    const usdVolumeRatio = volumeAnalysis.totalUsd / volumeAnalysis.totalVolume;
    if (usdVolumeRatio > 100000) {
        output += `- **High-Value Market**: Very high USD-to-volume ratio ($${formatLargeNumber(usdVolumeRatio)} per unit) indicates institutional-grade trading\n`;
    } else if (usdVolumeRatio > 50000) {
        output += `- **Premium Market**: High USD-to-volume ratio ($${formatLargeNumber(usdVolumeRatio)} per unit) suggests quality institutional presence\n`;
    } else {
        output += `- **Accessible Market**: Moderate USD-to-volume ratio ($${formatLargeNumber(usdVolumeRatio)} per unit) indicates retail-friendly pricing\n`;
    }

    // Spread analysis insights
    if (volumeAnalysis.spreadPercentage < 0.05) {
        output += `- **Excellent Liquidity**: Very tight spread (${volumeAnalysis.spreadPercentage.toFixed(3)}%) indicates exceptional market efficiency\n`;
    } else if (volumeAnalysis.spreadPercentage < 0.1) {
        output += `- **Good Liquidity**: Tight spread (${volumeAnalysis.spreadPercentage.toFixed(3)}%) supports efficient price discovery\n`;
    } else if (volumeAnalysis.spreadPercentage < 0.5) {
        output += `- **Moderate Liquidity**: Reasonable spread (${volumeAnalysis.spreadPercentage.toFixed(3)}%) for normal trading conditions\n`;
    } else {
        output += `- **Wide Spread**: Large spread (${volumeAnalysis.spreadPercentage.toFixed(3)}%) may indicate low liquidity or volatile conditions\n`;
    }

    // Market depth insights
    if (volumeAnalysis.marketDepthScore > 80) {
        output += `- **Exceptional Market Depth**: Outstanding depth score (${volumeAnalysis.marketDepthScore.toFixed(1)}/100) supports large-scale trading\n`;
    } else if (volumeAnalysis.marketDepthScore > 60) {
        output += `- **Good Market Depth**: Solid depth score (${volumeAnalysis.marketDepthScore.toFixed(1)}/100) enables efficient order execution\n`;
    } else if (volumeAnalysis.marketDepthScore > 40) {
        output += `- **Moderate Market Depth**: Adequate depth score (${volumeAnalysis.marketDepthScore.toFixed(1)}/100) for standard trading\n`;
    } else {
        output += `- **Limited Market Depth**: Low depth score (${volumeAnalysis.marketDepthScore.toFixed(1)}/100) suggests caution for large orders\n`;
    }

    // Volume efficiency insights
    if (volumeAnalysis.volumeEfficiency > 110) {
        output += `- **Superior Volume Efficiency**: High efficiency (${volumeAnalysis.volumeEfficiency.toFixed(1)}%) indicates optimal price-volume relationship\n`;
    } else if (volumeAnalysis.volumeEfficiency > 90) {
        output += `- **Good Volume Efficiency**: Efficient volume utilization (${volumeAnalysis.volumeEfficiency.toFixed(1)}%) supports healthy market dynamics\n`;
    } else {
        output += `- **Volume Efficiency Concerns**: Lower efficiency (${volumeAnalysis.volumeEfficiency.toFixed(1)}%) may indicate market inefficiencies\n`;
    }

    // Trading implications
    output += `\n### 💡 Trading Implications:\n`;
    if (volumeAnalysis.marketSentiment.includes('BULLISH')) {
        output += `- **Bullish Environment**: Strong bid volume support suggests favorable conditions for long positions\n`;
    } else if (volumeAnalysis.marketSentiment.includes('BEARISH')) {
        output += `- **Bearish Environment**: Strong ask volume resistance suggests caution for long positions\n`;
    } else {
        output += `- **Neutral Environment**: Balanced volume suggests range-bound trading opportunities\n`;
    }

    // Institutional vs retail insights
    const avgOrderSize = (volumeAnalysis.avgOrderSizeBid + volumeAnalysis.avgOrderSizeAsk) / 2;
    if (avgOrderSize > 200000) {
        output += `- **Institutional Market**: Large average order sizes indicate institutional-dominated trading environment\n`;
    } else if (avgOrderSize > 50000) {
        output += `- **Mixed Market**: Moderate order sizes suggest both institutional and retail participation\n`;
    } else {
        output += `- **Retail Market**: Smaller order sizes indicate retail-dominated trading environment\n`;
    }

    return output;
}

// Bid/Ask Volume & Amount Analysis Action
export const bidAskVolumeAction: Action = {
    name: "BID_ASK_VOLUME_ANALYSIS",
    description: "Get bid/ask volume and amount analysis from orderbook data",
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show me BTC bid ask volume breakdown",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll analyze Bitcoin's bid/ask volume breakdown and amounts from orderbook data.\n\n📊 **Bitcoin (BTC) - Bid/Ask Volume & Amount Analysis**\n\n**📊 Bid/Ask Volume Breakdown:**\n- Bid Volume: 197.99 units (53.7%)\n- Ask Volume: 170.38 units (46.3%)\n- Bid USD Amount: $12.68M (53.5%)\n- Ask USD Amount: $10.99M (46.5%)\n- Average Bid Price: $64,048.32\n- Average Ask Price: $64,503.28\n- Bid/Ask Spread: 0.71%\n\n**📏 Bid/Ask Spread Analysis:**\n- Absolute Spread: $455.96\n- Percentage Spread: 0.71%\n- Market Depth Score: 82.4/100\n\n**Analysis:** Strong bid volume dominance with tight spreads indicates healthy orderbook structure.",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Get ETH bid ask spreads and amounts",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll analyze Ethereum's bid/ask spreads and order amounts.\n\n📊 **Ethereum (ETH) - Bid/Ask Volume & Amount Analysis**\n\n**Asset**: Ethereum | **Category**: Smart Contract Platform | **Tier**: Tier 1\n**Exchange**: Binance (binance) | **Region**: Global | **Type**: Centralized\n\n**📊 Bid/Ask Amounts:**\n- Bid USD Amount: $17.9M (50.1%)\n- Ask USD Amount: $17.9M (49.9%)\n- Average Bid Order Size: $71,346\n- Average Ask Order Size: $68,892\n\n**📏 Bid/Ask Spread Analysis:**\n- Spread (Percentage): 0.045%\n- Absolute Spread: $1.24\n- Market Depth Score: 78.2/100\n\n**Analysis:** ETH showing balanced bid/ask amounts with excellent spread efficiency.",
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
            elizaLogger.info("📊 Processing bid/ask volume analysis request...");

            // Extract crypto symbol from target parameter (highest priority) or fall back to parsing message
            let cryptoSymbol: string;
            if (_options?.target && typeof _options.target === 'string') {
                cryptoSymbol = _options.target;
                elizaLogger.info(`🎯 Using crypto symbol from target parameter: ${cryptoSymbol}`);
            } else {
                cryptoSymbol = parseCryptoSymbol(message.content.text || "");
                elizaLogger.info(`📝 Parsed crypto symbol from message text: ${cryptoSymbol}`);
            }

            // Extract timestamp parameters from options or parse from message
            let start_time = _options?.start_time as number | undefined;
            let end_time = _options?.end_time as number | undefined;
            
            // Also check parameters object for timestamp values
            if (_options?.parameters && typeof _options.parameters === 'object') {
                const params = _options.parameters as any;
                start_time = start_time || params.start_time;
                end_time = end_time || params.end_time;
            }
            
            // If not provided in options, try to parse from message text
            if (!start_time && !end_time) {
                const parsedTimestamps = parseTimestampParams(message.content.text || "");
                start_time = parsedTimestamps.start_time;
                end_time = parsedTimestamps.end_time;
            }

            const retentionConfig = {
                dataRetentionDays: typeof _options?.dataRetentionDays === "number" ? _options.dataRetentionDays : undefined,
                dataRetentionMinDaysAgo: typeof _options?.dataRetentionMinDaysAgo === "number" ? _options.dataRetentionMinDaysAgo : undefined,
                dataRetentionMaxDaysAgo: typeof _options?.dataRetentionMaxDaysAgo === "number" ? _options.dataRetentionMaxDaysAgo : undefined,
            };
            if (
                (typeof retentionConfig.dataRetentionDays === "number" && retentionConfig.dataRetentionDays >= 0) ||
                (typeof retentionConfig.dataRetentionMinDaysAgo === "number" && typeof retentionConfig.dataRetentionMaxDaysAgo === "number")
            ) {
                const clamped = clampTimestampRangeToRetention(start_time, end_time, retentionConfig);
                start_time = clamped.start_time;
                end_time = clamped.end_time;
            }

            if (start_time || end_time) {
                elizaLogger.info(`📅 Using date range: ${start_time ? new Date(start_time).toISOString() : 'earliest'} to ${end_time ? new Date(end_time).toISOString() : 'latest'}`);
            }

            // Get comprehensive bid/ask volume analysis with the specified symbol (pass data retention for clamping)
            const bidAskResult = await getComprehensiveBidAskVolumeAnalysis(runtime, message, state, cryptoSymbol, retentionConfig);

            if (!bidAskResult.success || !bidAskResult.data) {
                const errorMessage = `❌ Failed to fetch bid/ask volume analysis: ${bidAskResult.error || "Unknown error"}`;
                
                if (callback) {
                    await callback(createActionErrorResponse({
                        actionName: "BID_ASK_VOLUME_ANALYSIS",
                        type: "bid_ask_volume_analysis_error",
                        error: new Error(bidAskResult.error || "Unknown error"),
                        text: errorMessage,
                    }));
                }
                return false;
            }

            // Save data to file
            try {
                await saveBidAskAnalysisToFile(bidAskResult.data);
            } catch (saveError) {
                elizaLogger.warn("⚠️ Failed to save bid/ask analysis data to file, but continuing with response:", saveError);
            }

            // Generate and save interactive chart
            let chartPath: string | undefined;
            try {
                const localChartPath = await saveBidAskVolumeChartToFile(bidAskResult.data, start_time, end_time);
                elizaLogger.info(`📊 Interactive chart saved: ${localChartPath}`);
                chartPath = buildChartProxyUrl(localChartPath, runtime.agentId);
            } catch (chartError) {
                elizaLogger.warn("⚠️ Failed to save chart to file, but continuing with response:", chartError);
            }

            // Format the data for analysis
            const formattedAnalysis = formatBidAskVolumeForAnalysis(bidAskResult.data);

            // Generate Mermaid diagram
            const mermaidDiagram = generateBidAskVolumeMermaidDiagram(bidAskResult.data);

            const actionData = {
                summary: formattedAnalysis,
                symbol: bidAskResult.data.symbol,
                exchange: bidAskResult.data.exchange,
                latestData: bidAskResult.data.latestData,
                analysis: bidAskResult.data.analysis,
                chartPath,
                mermaidDiagram
            };

            // Create comprehensive response with chart info
            let responseText = formattedAnalysis;
            
            // Add chart information to response text for UI extraction
            if (chartPath) {
                responseText += `\n\n📊 **Interactive Chart Generated**: I've created an interactive bid/ask volume analysis chart with comprehensive visualizations.`;
            }

            if (callback) {
                // Generate action summary
                const symbol = bidAskResult.data.symbol;
                const dataPoints = bidAskResult.data.historicalData?.length || 0;
                const bidVolume = bidAskResult.data.analysis?.bidVolume || 0;
                const askVolume = bidAskResult.data.analysis?.askVolume || 0;
                const spreadPct = bidAskResult.data.analysis?.spreadPercentage || 0;

                const actionSummary = generateActionSummary({
                    actionName: 'Bid/Ask Data',
                    assets: [symbol],
                    timePeriod: 'real-time',
                    dataPoints: dataPoints,
                    additionalInfo: `bid: ${formatLargeNumber(bidVolume)}, ask: ${formatLargeNumber(askVolume)}, spread: ${spreadPct.toFixed(2)}%`
                });

                await callback(createActionResponse({
                    actionName: "BID_ASK_VOLUME_ANALYSIS",
                    type: "bid_ask_volume_analysis",
                    text: responseText,
                    content: {
                        bidAskData: bidAskResult.data,
                        analysis: formattedAnalysis,
                        mermaidDiagram,
                        chartPath,
                        visualizations: {
                            interactive_chart: chartPath,
                            volume_diagram: mermaidDiagram,
                            chart_data: bidAskResult.data.chartData
                        }
                    },
                    actionData: {
                        ...actionData,
                        summary: actionSummary,
                    },
                    chartPath: chartPath,
                    symbol: bidAskResult.data.symbol,
                }));
            }

            elizaLogger.info("✅ Bid/Ask volume analysis completed successfully");
            return true;

        } catch (error) {
            elizaLogger.error("❌ Error in bid/ask volume analysis handler:", error);
            
            const errorMessage = "I encountered an error while fetching bid/ask volume analysis data. Please try again later.";
            
            if (callback) {
                await callback(createActionErrorResponse({
                    actionName: "BID_ASK_VOLUME_ANALYSIS",
                    type: "bid_ask_volume_analysis_error",
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
        ttlSeconds: 86400, // 1 day for on-chain data
        similarityThreshold: 0.7,
        maxChunkSize: 200,
    },
};

// Utility function to determine date range based on timeframe
function determineDateRange(historicalData?: BidAskVolumePoint[], start_time?: number, end_time?: number): string {
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
    // Default to last 30 days
    else {
        const end = new Date();
        const start = new Date(end.getTime() - (30 * 24 * 60 * 60 * 1000));
        startDate = start.toISOString().split('T')[0];
        endDate = end.toISOString().split('T')[0];
    }
    
    // If same date, return single date, otherwise return range with ~ separator
    return startDate === endDate ? startDate : `${startDate}~${endDate}`;
}
