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
 * Enhanced Inflow/Outflow Analysis Based on Orderbook Data
 * 
 * This module uses orderbook depth data to analyze inflow/outflow patterns with advanced analytics and visualizations:
 * 
 * ORDERBOOK DEPTH API (/api/futures/orderbook/aggregated-ask-bids-history) 
 * - Primary data source for inflow/outflow analysis
 * - Bid depth represents potential inflow support
 * - Ask depth represents potential outflow resistance
 * - Data structure: [{ aggregated_bids_usd, aggregated_bids_quantity, aggregated_asks_usd, aggregated_asks_quantity, time }],
 * - Used for: Flow direction analysis, liquidity-based sentiment, support/resistance levels, trend analysis
 * 
 * Enhanced Analysis Features:
 * - Flow momentum calculations
 * - Support/resistance trend analysis
 * - Liquidity concentration analysis
 * - Flow prediction indicators
 * - Interactive Chart.js visualizations
 * - Mermaid flow diagrams
 * 
 * Inflow/Outflow Interpretation:
 * - High bid dominance = Strong inflow potential (buying support)
 * - High ask dominance = Strong outflow potential (selling pressure)
 * - Bid/ask balance changes over time indicate flow direction shifts
 * - Volume-weighted analysis provides flow magnitude insights
 * - Momentum indicators predict flow continuity
 * 
 * Supports timestamp filtering:
 * - start_time: int64 - Start timestamp in milliseconds
 * - end_time: int64 - End timestamp in milliseconds
 */

// Types for orderbook-based inflow/outflow data
export interface OrderbookInflowOutflowPoint {
    aggregated_bids_usd: number;      // Inflow support (USD)
    aggregated_bids_quantity: number; // Inflow support quantity
    aggregated_asks_usd: number;      // Outflow resistance (USD)
    aggregated_asks_quantity: number; // Outflow resistance quantity
    time: number;                     // Timestamp (milliseconds)
    // Derived inflow/outflow metrics
    inflow_dominance: number;         // Bid dominance percentage
    outflow_dominance: number;        // Ask dominance percentage
    flow_imbalance: number;           // Absolute difference in USD
    total_liquidity: number;          // Total available liquidity
    // Enhanced analytics
    flow_momentum?: number;           // Flow momentum indicator
    liquidity_concentration?: number; // Concentration of liquidity
    support_strength?: number;        // Support level strength
    resistance_strength?: number;     // Resistance level strength
}

export interface OrderbookInflowOutflowResponse {
    code: string;
    msg: string;
    data: OrderbookInflowOutflowPoint[];
}

// Enhanced analysis interface with advanced metrics
export interface InflowOutflowAnalysis {
    symbol: string;
    exchange: string;
    latestData: OrderbookInflowOutflowPoint;
    historicalData: OrderbookInflowOutflowPoint[];
    analysis: {
        marketSentiment: string;
        dominantFlow: string;
        inflowSupport: number;           // Total inflow support (USD)
        outflowResistance: number;       // Total outflow resistance (USD)
        flowImbalance: number;           // Flow imbalance (USD)
        inflowDominance: number;         // Inflow dominance percentage
        outflowDominance: number;        // Outflow dominance percentage
        liquidityTrend: string;          // Trend over time
        avgLiquidity: number;            // Average liquidity
        flowDirection: string;           // Primary flow direction
        flowStrength: string;            // Strength of flow signals
        // Enhanced metrics
        flowMomentum: number;            // Flow momentum score (-100 to 100)
        liquidityConcentration: number;  // Liquidity concentration index
        supportStrength: number;         // Support strength score (0-100)
        resistanceStrength: number;      // Resistance strength score (0-100)
        flowPrediction: string;          // Predicted flow direction
        marketDepth: string;             // Market depth assessment
        volatilityIndicator: number;     // Volatility based on flow changes
        flowStability: string;           // Flow stability assessment
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
        inflowData: number[];
        outflowData: number[];
        liquidityData: number[];
        dominanceData: number[];
        momentumData: number[];
    };
}

export interface InflowOutflowResult {
    success: boolean;
    data?: InflowOutflowAnalysis;
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

// Function to get orderbook-based inflow/outflow data
export async function getOrderbookInflowOutflowData(
    runtime: IAgentRuntime,
    symbol: string,
    start_time?: number,
    end_time?: number,
    exchange?: string
): Promise<{ success: boolean; data?: OrderbookInflowOutflowPoint[]; error?: string }> {
    try {
        const timeRangeInfo = start_time || end_time 
            ? ` (${start_time ? new Date(start_time).toISOString() : 'earliest'} to ${end_time ? new Date(end_time).toISOString() : 'latest'})`
            : '';
        elizaLogger.info(`📊 Fetching orderbook inflow/outflow data for ${symbol}${timeRangeInfo}...`);

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

        const orderbookResponse: OrderbookInflowOutflowResponse = response.data;
        
        //elizaLogger.info(`📊 Orderbook Inflow/Outflow API Response - Code: ${orderbookResponse.code}, Message: ${orderbookResponse.msg}`);

        if (orderbookResponse.code !== "0") {
            throw new Error(`API Error: ${orderbookResponse.msg || 'Unknown error'} (Code: ${orderbookResponse.code})`);
        }

        if (!orderbookResponse.data || orderbookResponse.data.length === 0) {
            elizaLogger.error(`📊 API returned no data. Response structure:`, {
                hasData: !!orderbookResponse.data,
                dataLength: orderbookResponse.data?.length || 0,
                dataType: typeof orderbookResponse.data,
                symbol: symbol,
                url: url
            });
            
            // Try without time parameters if they were provided
            if (start_time || end_time) {
                elizaLogger.info(`📊 Retrying without time parameters...`);
                return getOrderbookInflowOutflowData(runtime, symbol, undefined, undefined, exchange);
            }
            
            throw new Error(`No orderbook inflow/outflow data available for ${symbol}. The API might not support this symbol or the data might be temporarily unavailable.`);
        }

        // Process data to add enhanced inflow/outflow metrics
        const processedData: OrderbookInflowOutflowPoint[] = orderbookResponse.data.map((point, index) => {
            const totalLiquidity = point.aggregated_bids_usd + point.aggregated_asks_usd;
            const inflowDominance = (point.aggregated_bids_usd / totalLiquidity) * 100;
            const outflowDominance = (point.aggregated_asks_usd / totalLiquidity) * 100;
            const flowImbalance = Math.abs(point.aggregated_bids_usd - point.aggregated_asks_usd);

            // Calculate enhanced metrics
            let flowMomentum = 0;
            let liquidityConcentration = 0;
            let supportStrength = 0;
            let resistanceStrength = 0;

            if (index > 0) {
                const prevPoint = orderbookResponse.data[index - 1];
                const prevTotalLiquidity = prevPoint.aggregated_bids_usd + prevPoint.aggregated_asks_usd;
                const prevInflowDominance = (prevPoint.aggregated_bids_usd / prevTotalLiquidity) * 100;
                
                // Flow momentum: change in inflow dominance over time
                flowMomentum = inflowDominance - prevInflowDominance;
                
                // For better trend detection, use rolling momentum for data points with enough history
                if (index >= 3) {
                    // Calculate 3-period rolling momentum for smoother trends
                    const point2 = orderbookResponse.data[index - 2];
                    const point3 = orderbookResponse.data[index - 3];
                    
                    const liquidity2 = point2.aggregated_bids_usd + point2.aggregated_asks_usd;
                    const liquidity3 = point3.aggregated_bids_usd + point3.aggregated_asks_usd;
                    
                    const dominance2 = (point2.aggregated_bids_usd / liquidity2) * 100;
                    const dominance3 = (point3.aggregated_bids_usd / liquidity3) * 100;
                    
                    // Use 3-period slope for more stable momentum
                    const rolling_momentum = (inflowDominance - dominance3) / 3;
                    flowMomentum = rolling_momentum;
                }
                
                // Liquidity concentration: ratio of current to previous liquidity
                liquidityConcentration = (totalLiquidity / prevTotalLiquidity) * 100 - 100;
            } else {
                // For the first data point, use a neutral momentum value instead of 0
                // This helps avoid skewing the average momentum calculation
                flowMomentum = 0;
            }

            // Support strength: based on bid depth relative to total
            supportStrength = Math.min(100, (point.aggregated_bids_usd / totalLiquidity) * 200);
            
            // Resistance strength: based on ask depth relative to total
            resistanceStrength = Math.min(100, (point.aggregated_asks_usd / totalLiquidity) * 200);

            return {
                ...point,
                inflow_dominance: inflowDominance,
                outflow_dominance: outflowDominance,
                flow_imbalance: flowImbalance,
                total_liquidity: totalLiquidity,
                flow_momentum: flowMomentum,
                liquidity_concentration: liquidityConcentration,
                support_strength: supportStrength,
                resistance_strength: resistanceStrength
            };
        });

        elizaLogger.info(`✅ Successfully processed ${symbol} orderbook inflow/outflow data`);
        elizaLogger.info(`📊 ${processedData.length} data points processed`);

        return {
            success: true,
            data: processedData
        };

    } catch (error) {
        elizaLogger.error(
            `❌ Error fetching orderbook inflow/outflow data: ${formatAxiosErrorLine(error)}`
        );

        return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error occurred"
        };
    }
}

// Main function to get comprehensive inflow/outflow analysis
export async function getComprehensiveInflowOutflowAnalysis(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    symbol?: string,
    options?: { dataRetentionDays?: number; dataRetentionMinDaysAgo?: number; dataRetentionMaxDaysAgo?: number }
): Promise<InflowOutflowResult> {
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
        
        elizaLogger.info(`🔍 Starting orderbook-based inflow/outflow analysis for ${cryptoSymbol}...`);

        // Clean up all previous files for this symbol before fetching new data
        await cleanupAllPreviousInflowOutflowFiles(cryptoSymbol);

        // Fetch orderbook inflow/outflow data
        const orderbookResult = await getOrderbookInflowOutflowData(runtime, cryptoSymbol, start_time, end_time, exchange);
        
        if (!orderbookResult.success || !orderbookResult.data || orderbookResult.data.length === 0) {
            throw new Error(`Failed to fetch orderbook inflow/outflow data: ${orderbookResult.error}`);
        }

        // Get latest and historical data
        const latestData = orderbookResult.data[orderbookResult.data.length - 1];
        const historicalData = orderbookResult.data;

        // Calculate analysis metrics
        const inflowSupport = latestData.aggregated_bids_usd;
        const outflowResistance = latestData.aggregated_asks_usd;
        const flowImbalance = latestData.flow_imbalance;
        const inflowDominance = latestData.inflow_dominance;
        const outflowDominance = latestData.outflow_dominance;

        // Calculate average liquidity from historical data
        const avgLiquidity = historicalData.reduce((sum, point) => sum + point.total_liquidity, 0) / historicalData.length;

        // Calculate enhanced metrics
        const avgFlowMomentum = historicalData.reduce((sum, point) => sum + (point.flow_momentum || 0), 0) / historicalData.length;
        const avgLiquidityConcentration = historicalData.reduce((sum, point) => sum + (point.liquidity_concentration || 0), 0) / historicalData.length;
        const avgSupportStrength = historicalData.reduce((sum, point) => sum + (point.support_strength || 0), 0) / historicalData.length;
        const avgResistanceStrength = historicalData.reduce((sum, point) => sum + (point.resistance_strength || 0), 0) / historicalData.length;

        // Use latest momentum for current flow momentum (more relevant than average)
        const currentFlowMomentum = latestData.flow_momentum || 0;

        // Calculate volatility indicator based on flow momentum variance
        const momentumVariance = historicalData.reduce((sum, point) => {
            const deviation = (point.flow_momentum || 0) - avgFlowMomentum;
            return sum + (deviation * deviation);
        }, 0) / historicalData.length;
        const volatilityIndicator = Math.sqrt(momentumVariance);

        // Determine liquidity trend
        let liquidityTrend: string;
        if (historicalData.length > 1) {
            const firstHalf = historicalData.slice(0, Math.floor(historicalData.length / 2));
            const secondHalf = historicalData.slice(Math.floor(historicalData.length / 2));
            
            const firstHalfAvg = firstHalf.reduce((sum, point) => sum + point.total_liquidity, 0) / firstHalf.length;
            const secondHalfAvg = secondHalf.reduce((sum, point) => sum + point.total_liquidity, 0) / secondHalf.length;
            
            const trendPercentage = ((secondHalfAvg - firstHalfAvg) / firstHalfAvg) * 100;
            
            if (trendPercentage > 5) {
                liquidityTrend = "📈 INCREASING LIQUIDITY";
            } else if (trendPercentage < -5) {
                liquidityTrend = "📉 DECREASING LIQUIDITY";
            } else {
                liquidityTrend = "➡️ STABLE LIQUIDITY";
            }
        } else {
            liquidityTrend = "➡️ STABLE LIQUIDITY";
        }

        // Determine market sentiment and flow direction based on enhanced orderbook analysis
        let marketSentiment: string;
        let dominantFlow: string;
        let flowDirection: string;
        let flowStrength: string;
        let flowPrediction: string;
        let marketDepth: string;
        let flowStability: string;

        // Enhanced sentiment analysis considering current momentum
        const momentumBoost = Math.abs(currentFlowMomentum) > 2 ? (currentFlowMomentum > 0 ? 5 : -5) : 0;
        const adjustedInflowDominance = inflowDominance + momentumBoost;

        if (adjustedInflowDominance > 65) {
            marketSentiment = "🟢 STRONGLY BULLISH";
            dominantFlow = "Strong Inflow Potential with Momentum";
            flowDirection = "STRONG INFLOW FAVORED";
            flowStrength = "VERY STRONG";
        } else if (adjustedInflowDominance > 60) {
            marketSentiment = "🟢 BULLISH";
            dominantFlow = "Strong Inflow Potential";
            flowDirection = "INFLOW FAVORED";
            flowStrength = "STRONG";
        } else if (adjustedInflowDominance > 55) {
            marketSentiment = "🟢 SLIGHTLY BULLISH";
            dominantFlow = "Moderate Inflow Potential";
            flowDirection = "INFLOW FAVORED";
            flowStrength = "MODERATE";
        } else if (outflowDominance > 65) {
            marketSentiment = "🔴 STRONGLY BEARISH";
            dominantFlow = "Strong Outflow Potential with Momentum";
            flowDirection = "STRONG OUTFLOW FAVORED";
            flowStrength = "VERY STRONG";
        } else if (outflowDominance > 60) {
            marketSentiment = "🔴 BEARISH";
            dominantFlow = "Strong Outflow Potential";
            flowDirection = "OUTFLOW FAVORED";
            flowStrength = "STRONG";
        } else if (outflowDominance > 55) {
            marketSentiment = "🔴 SLIGHTLY BEARISH";
            dominantFlow = "Moderate Outflow Potential";
            flowDirection = "OUTFLOW FAVORED";
            flowStrength = "MODERATE";
        } else {
            marketSentiment = "🟡 NEUTRAL";
            dominantFlow = "Balanced Flow Potential";
            flowDirection = "BALANCED";
            flowStrength = "NEUTRAL";
        }

        // Flow prediction based on current momentum and average trends
        if (currentFlowMomentum > 3) {
            flowPrediction = "📈 INCREASING INFLOW EXPECTED";
        } else if (currentFlowMomentum < -3) {
            flowPrediction = "📉 INCREASING OUTFLOW EXPECTED";
        } else if (Math.abs(avgFlowMomentum) < 1) {
            flowPrediction = "➡️ STABLE FLOW EXPECTED";
        } else {
            flowPrediction = "🔄 MIXED SIGNALS";
        }

        // Market depth assessment
        if (latestData.total_liquidity > 100000000) {
            marketDepth = "🌊 VERY DEEP MARKET";
        } else if (latestData.total_liquidity > 50000000) {
            marketDepth = "💧 DEEP MARKET";
        } else if (latestData.total_liquidity > 20000000) {
            marketDepth = "💦 MODERATE DEPTH";
        } else {
            marketDepth = "🏜️ SHALLOW MARKET";
        }

        // Flow stability assessment
        if (volatilityIndicator < 2) {
            flowStability = "🔒 VERY STABLE";
        } else if (volatilityIndicator < 5) {
            flowStability = "🔐 STABLE";
        } else if (volatilityIndicator < 10) {
            flowStability = "⚡ MODERATE VOLATILITY";
        } else {
            flowStability = "🌪️ HIGH VOLATILITY";
        }

        // Get crypto and exchange information
        const cryptoInfo = getCryptoInfo(cryptoSymbol);
        const exchangeInfo = getExchangeInfo(exchange);

        // Prepare chart data for visualization with intelligent time formatting
        const timeSpan = historicalData.length > 1 ? 
            historicalData[historicalData.length - 1].time - historicalData[0].time : 0;
        const isShortTerm = timeSpan <= (7 * 24 * 60 * 60 * 1000); // 7 days or less
        
        const chartData = {
            labels: historicalData.map(point => {
                const date = new Date(point.time);
                if (isShortTerm) {
                    // For short-term data (week or less), show date and time
                    return date.toLocaleString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                    });
                } else {
                    // For longer-term data, show just the date
                    return date.toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric'
                    });
                }
            }),
            inflowData: historicalData.map(point => point.aggregated_bids_usd / 1000000), // Convert to millions
            outflowData: historicalData.map(point => point.aggregated_asks_usd / 1000000), // Convert to millions
            liquidityData: historicalData.map(point => point.total_liquidity / 1000000), // Convert to millions
            dominanceData: historicalData.map(point => point.inflow_dominance),
            momentumData: historicalData.map(point => point.flow_momentum || 0)
        };

        const analysis: InflowOutflowAnalysis = {
            symbol: cryptoSymbol,
            exchange: exchange,
            latestData,
            historicalData,
            analysis: {
                marketSentiment,
                dominantFlow,
                inflowSupport,
                outflowResistance,
                flowImbalance,
                inflowDominance,
                outflowDominance,
                liquidityTrend,
                avgLiquidity,
                flowDirection,
                flowStrength,
                flowMomentum: currentFlowMomentum,
                liquidityConcentration: avgLiquidityConcentration,
                supportStrength: avgSupportStrength,
                resistanceStrength: avgResistanceStrength,
                flowPrediction,
                marketDepth,
                volatilityIndicator,
                flowStability,
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

        elizaLogger.info(`✅ Successfully completed orderbook-based inflow/outflow analysis for ${cryptoSymbol}`);
        elizaLogger.info(`💰 Total liquidity: $${formatLargeNumber(latestData.total_liquidity)} | Flow: ${flowDirection}`);
        elizaLogger.info(`📊 Inflow dominance: ${inflowDominance.toFixed(1)}% | Outflow dominance: ${outflowDominance.toFixed(1)}%`);

        return {
            success: true,
            data: analysis
        };

    } catch (error) {
        elizaLogger.error("❌ Error in orderbook-based inflow/outflow analysis:", error);
        
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
async function cleanupPreviousInflowOutflowData(symbol: string): Promise<void> {
    try {
        const CACHE_DIR = path.join(process.cwd(), 'cache');
        const saveDirectory = path.join(CACHE_DIR, 'inflow_outflow_data');
        
        if (!fs.existsSync(saveDirectory)) {
            return; // No directory to clean
        }
        
        // Read all files in the directory
        const files = fs.readdirSync(saveDirectory);
        
        // Filter files that match the symbol pattern
        const symbolFiles = files.filter(file => 
            file.startsWith(`inflow_outflow_${symbol}_`) && file.endsWith('.json')
        );
        
        // Delete matching files
        for (const file of symbolFiles) {
            const filepath = path.join(saveDirectory, file);
            fs.unlinkSync(filepath);
            elizaLogger.info(`🗑️ Deleted previous inflow/outflow data: ${file}`);
        }
        
        if (symbolFiles.length > 0) {
            elizaLogger.info(`✨ Cleaned up ${symbolFiles.length} previous ${symbol} inflow/outflow data files`);
        }
        
    } catch (error) {
        elizaLogger.warn("⚠️ Error cleaning up previous inflow/outflow data files:", error);
        // Don't throw - this is cleanup, not critical
    }
}

// Function to clean up previous chart files for a symbol
async function cleanupPreviousInflowOutflowCharts(symbol: string): Promise<void> {
    try {
        const savedDataDir = path.join(process.cwd(), 'saved_data');
        const chartsDirectory = path.join(savedDataDir, 'Charts');
        
        if (!fs.existsSync(chartsDirectory)) {
            return; // No directory to clean
        }
        
        // Read all files in the directory
        const files = fs.readdirSync(chartsDirectory);
        
        // Filter files that match the pattern with ticker and date range
        // Matches patterns like: Inflow Outflow Chart BTC 2025-01-01~2025-01-31.html or Inflow Outflow Chart BTC 2025-01-01.html
        const pattern = new RegExp(`^Inflow Outflow Chart ${symbol} \\d{4}-\\d{2}-\\d{2}(~\\d{4}-\\d{2}-\\d{2})?\\.html$`);
        const symbolFiles = files.filter(file => pattern.test(file));

        // Note: Chart deletion disabled to preserve historical data
        // Old charts are kept for reference in chat history
        if (symbolFiles.length > 0) {
            elizaLogger.info(`📊 Found ${symbolFiles.length} existing ${symbol} inflow/outflow chart(s) (keeping for history)`);
        }

        // Delete matching files
        // for (const file of symbolFiles) {
        //     const filepath = path.join(chartsDirectory, file);
        //     fs.unlinkSync(filepath);
        //     elizaLogger.info(`🗑️ Deleted previous inflow/outflow chart: ${file}`);
        // }
        
    } catch (error) {
        elizaLogger.warn("⚠️ Error cleaning up previous chart files:", error);
        // Don't throw - this is cleanup, not critical
    }
}

// Function to perform comprehensive cleanup for a symbol (both data and charts)
async function cleanupAllPreviousInflowOutflowFiles(symbol: string): Promise<void> {
    try {
        elizaLogger.info(`🧹 Starting cleanup of all previous ${symbol} inflow/outflow files...`);
        
        // Clean up data files and chart files in parallel
        await Promise.all([
            cleanupPreviousInflowOutflowData(symbol),
            cleanupPreviousInflowOutflowCharts(symbol)
        ]);
        
        elizaLogger.info(`✅ Completed cleanup for ${symbol} inflow/outflow files`);
        
    } catch (error) {
        elizaLogger.warn(`⚠️ Error during comprehensive cleanup for ${symbol}:`, error);
        // Don't throw - this is cleanup, not critical
    }
}

// Function to save inflow/outflow analysis data to file
async function saveInflowOutflowAnalysisToFile(analysis: InflowOutflowAnalysis): Promise<void> {
    try {
        const CACHE_DIR = path.join(process.cwd(), 'cache');
        const saveDirectory = path.join(CACHE_DIR, 'inflow_outflow_data');
        
        // Clean up previous data files for this symbol first
        await cleanupPreviousInflowOutflowData(analysis.symbol);
        
        // Create cache and inflow_outflow_data directories if they don't exist
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
        const filename = `inflow_outflow_${analysis.symbol}_${timestamp}.json`;
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
        
        elizaLogger.info(`💾 Inflow/Outflow analysis data saved to: ${filepath}`);
        elizaLogger.info(`📊 Saved ${analysis.symbol} data with $${formatLargeNumber(analysis.latestData.total_liquidity)} total liquidity`);
        
    } catch (error) {
        elizaLogger.error("❌ Error saving inflow/outflow analysis data to file:", error);
        throw error;
    }
}

// Generate interactive Chart.js visualization for inflow/outflow data
function generateInflowOutflowChart(analysis: InflowOutflowAnalysis): string {
    const { chartData } = analysis;
    if (!chartData) {
        return '<p>No chart data available</p>';
    }

    const labels = chartData.labels.map(label => `"${label}"`).join(',');
    const inflowData = chartData.inflowData.join(',');
    const outflowData = chartData.outflowData.join(',');
    const liquidityData = chartData.liquidityData.join(',');
    const dominanceData = chartData.dominanceData.join(',');
    const momentumData = chartData.momentumData.join(',');

    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${analysis.symbol} Inflow/Outflow Analysis Chart</title>
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
      <h1>${analysis.symbol} Inflow/Outflow Analysis</h1>
      <p>Exchange: ${analysis.analysis.exchangeInfo.name} | Market Depth: ${analysis.analysis.marketDepth}</p>
    </div>

    <div class="status-indicators">
      <div class="status-item">
        <div class="status-emoji">💰</div>
        <strong>Market Sentiment</strong><br>
        ${analysis.analysis.marketSentiment}
      </div>
      <div class="status-item">
        <div class="status-emoji">📊</div>
        <strong>Flow Direction</strong><br>
        ${analysis.analysis.flowDirection}
      </div>
      <div class="status-item">
        <div class="status-emoji">🔮</div>
        <strong>Flow Prediction</strong><br>
        ${analysis.analysis.flowPrediction}
      </div>
      <div class="status-item">
        <div class="status-emoji">⚡</div>
        <strong>Flow Stability</strong><br>
        ${analysis.analysis.flowStability}
      </div>
    </div>

    <div class="metrics-grid">
      <div class="metric-card">
        <h3>💚 Inflow Support</h3>
        <div class="metric-value">$${formatLargeNumber(analysis.analysis.inflowSupport)}</div>
        <p>Dominance: ${analysis.analysis.inflowDominance.toFixed(1)}%</p>
      </div>
      <div class="metric-card">
        <h3>🔴 Outflow Resistance</h3>
        <div class="metric-value">$${formatLargeNumber(analysis.analysis.outflowResistance)}</div>
        <p>Dominance: ${analysis.analysis.outflowDominance.toFixed(1)}%</p>
      </div>
      <div class="metric-card">
        <h3>💧 Total Liquidity</h3>
        <div class="metric-value">$${formatLargeNumber(analysis.latestData.total_liquidity)}</div>
        <p>Average: $${formatLargeNumber(analysis.analysis.avgLiquidity)}</p>
      </div>
      <div class="metric-card">
        <h3>⚡ Flow Momentum</h3>
        <div class="metric-value">${analysis.analysis.flowMomentum.toFixed(2)}</div>
        <p>Volatility: ${analysis.analysis.volatilityIndicator.toFixed(2)}</p>
      </div>
    </div>

    <div class="chart-section">
      <div class="chart-title">📈 Inflow vs Outflow Liquidity (Millions USD)</div>
      <div class="chart-container">
        <canvas id="inflowOutflowChart"></canvas>
      </div>
    </div>

    <div class="chart-section">
      <div class="chart-title">📊 Flow Dominance & Momentum</div>
      <div class="chart-container">
        <canvas id="dominanceMomentumChart"></canvas>
      </div>
    </div>

    <div class="chart-section">
      <div class="chart-title">💧 Total Liquidity Trend (Millions USD)</div>
      <div class="chart-container">
        <canvas id="liquidityChart"></canvas>
      </div>
    </div>
  </div>

  <script>
    const dates = [${labels}];
    const inflowData = [${inflowData}];
    const outflowData = [${outflowData}];
    const liquidityData = [${liquidityData}];
    const dominanceData = [${dominanceData}];
    const momentumData = [${momentumData}];

    // Inflow vs Outflow Chart
    new Chart(document.getElementById('inflowOutflowChart'), {
      type: 'line',
      data: {
        labels: dates,
        datasets: [
          {
            label: 'Inflow Support (M USD)',
            data: inflowData,
            borderColor: '#27ae60',
            backgroundColor: 'rgba(39, 174, 96, 0.1)',
            borderWidth: 2,
            fill: true,
            tension: 0.4,
            pointRadius: 3,
            pointHoverRadius: 6,
            pointBackgroundColor: '#27ae60',
            pointBorderColor: '#ffffff',
            pointBorderWidth: 1,
            pointHitRadius: 10
          },
          {
            label: 'Outflow Resistance (M USD)',
            data: outflowData,
            borderColor: '#e74c3c',
            backgroundColor: 'rgba(231, 76, 60, 0.1)',
            borderWidth: 2,
            fill: true,
            tension: 0.4,
            pointRadius: 3,
            pointHoverRadius: 6,
            pointBackgroundColor: '#e74c3c',
            pointBorderColor: '#ffffff',
            pointBorderWidth: 1,
            pointHitRadius: 10
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

    // Dominance and Momentum Chart
    new Chart(document.getElementById('dominanceMomentumChart'), {
      type: 'line',
      data: {
        labels: dates,
        datasets: [
          {
            label: 'Inflow Dominance (%)',
            data: dominanceData,
            borderColor: '#3498db',
            backgroundColor: 'rgba(52, 152, 219, 0.1)',
            borderWidth: 2,
            yAxisID: 'y',
            pointRadius: 2,
            pointHoverRadius: 5,
            pointBackgroundColor: '#3498db',
            pointBorderColor: '#ffffff',
            pointBorderWidth: 1,
            fill: false,
            tension: 0.3
          },
          {
            label: 'Flow Momentum',
            data: momentumData,
            borderColor: '#f39c12',
            backgroundColor: 'rgba(243, 156, 18, 0.1)',
            borderWidth: 2,
            yAxisID: 'y1',
            pointRadius: 2,
            pointHoverRadius: 5,
            pointBackgroundColor: '#f39c12',
            pointBorderColor: '#ffffff',
            pointBorderWidth: 1,
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
              text: 'Dominance (%)'
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
              text: 'Momentum'
            },
            grid: {
              drawOnChartArea: false,
            }
          }
        }
      }
    });

    // Total Liquidity Chart
    new Chart(document.getElementById('liquidityChart'), {
      type: 'bar',
      data: {
        labels: dates,
        datasets: [
          {
            label: 'Total Liquidity (M USD)',
            data: liquidityData,
            backgroundColor: 'rgba(155, 89, 182, 0.8)',
            borderColor: '#9b59b6',
            borderWidth: 1,
            borderRadius: 4,
            borderSkipped: false
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

// Generate Mermaid flow diagram for inflow/outflow analysis
function generateInflowOutflowMermaidDiagram(analysis: InflowOutflowAnalysis): string {
    const { analysis: flowAnalysis } = analysis;
    
    // Determine flow direction colors and styles
    const inflowColor = flowAnalysis.inflowDominance > 50 ? "fill:#2ecc71" : "fill:#95a5a6";
    const outflowColor = flowAnalysis.outflowDominance > 50 ? "fill:#e74c3c" : "fill:#95a5a6";
    const neutralColor = "fill:#f39c12";
    
    return `graph TD
    A["💰 ${analysis.symbol} Market"] --> B["📊 Orderbook Analysis"],
    
    B --> C["💚 Inflow Support<br/>$${formatLargeNumber(flowAnalysis.inflowSupport)}<br/>${flowAnalysis.inflowDominance.toFixed(1)}%"],
    B --> D["🔴 Outflow Resistance<br/>$${formatLargeNumber(flowAnalysis.outflowResistance)}<br/>${flowAnalysis.outflowDominance.toFixed(1)}%"],
    
    C --> E["⚡ Flow Momentum<br/>${flowAnalysis.flowMomentum.toFixed(2)}"],
    D --> E
    
    E --> F["📈 Flow Prediction<br/>${flowAnalysis.flowPrediction}"],
    
    F --> G["🎯 Market Sentiment<br/>${flowAnalysis.marketSentiment}"],
    
    G --> H["💧 Liquidity Assessment<br/>${flowAnalysis.marketDepth}<br/>$${formatLargeNumber(flowAnalysis.avgLiquidity)} avg"],
    
    H --> I["🔒 Stability<br/>${flowAnalysis.flowStability}<br/>Volatility: ${flowAnalysis.volatilityIndicator.toFixed(2)}"],
    
    I --> J["🎲 Trading Signal<br/>${flowAnalysis.dominantFlow}"],
    
    style A fill:#3498db,stroke:#2980b9,stroke-width:3px,color:#fff
    style B fill:#34495e,stroke:#2c3e50,stroke-width:2px,color:#fff
    style C ${inflowColor},stroke:#27ae60,stroke-width:2px,color:#fff
    style D ${outflowColor},stroke:#c0392b,stroke-width:2px,color:#fff
    style E ${neutralColor},stroke:#e67e22,stroke-width:2px,color:#fff
    style F fill:#9b59b6,stroke:#8e44ad,stroke-width:2px,color:#fff
    style G fill:#e91e63,stroke:#c2185b,stroke-width:2px,color:#fff
    style H fill:#00bcd4,stroke:#0097a7,stroke-width:2px,color:#fff
    style I fill:#ff9800,stroke:#f57c00,stroke-width:2px,color:#fff
    style J fill:#4caf50,stroke:#388e3c,stroke-width:2px,color:#fff`;
}

// Save chart HTML to file
async function saveInflowOutflowChartToFile(analysis: InflowOutflowAnalysis, start_time?: number, end_time?: number): Promise<string> {
    try {
        // Use the same directory structure as other chart actions that work with the server
        const savedDataDir = path.join(process.cwd(), 'saved_data');
        const chartsDirectory = path.join(savedDataDir, 'Charts');
        
        // Clean up previous chart files for this symbol first
        await cleanupPreviousInflowOutflowCharts(analysis.symbol);
        
        // Create saved_data and Charts directories if they don't exist
        if (!fs.existsSync(savedDataDir)) {
            fs.mkdirSync(savedDataDir, { recursive: true });
            elizaLogger.info(`📁 Created directory: ${savedDataDir}`);
        }
        
        if (!fs.existsSync(chartsDirectory)) {
            fs.mkdirSync(chartsDirectory, { recursive: true });
            elizaLogger.info(`📁 Created charts directory: ${chartsDirectory}`);
        }
        
        // Generate chart HTML
        const chartHTML = generateInflowOutflowChart(analysis);
        
        // Determine date range from timeframe and data
        const dateRange = determineDateRange(analysis.historicalData, start_time, end_time);
        
        // Generate standardized filename format: [Chart Title] [Ticker] [DateRange],
        const filename = `Inflow Outflow Chart ${analysis.symbol} ${dateRange}.html`;
        const filepath = path.join(chartsDirectory, filename);
        
        // Write chart to file
        fs.writeFileSync(filepath, chartHTML);
        
        elizaLogger.info(`📊 Inflow/Outflow chart saved to: ${filepath}`);
        
        return filepath;
        
    } catch (error) {
        elizaLogger.error("❌ Error saving inflow/outflow chart to file:", error);
        throw error;
    }
}

// Format inflow/outflow analysis data for AI response
export function formatInflowOutflowForAnalysis(analysis: InflowOutflowAnalysis): string {
    const { latestData, analysis: flowAnalysis } = analysis;
    
    let output = `## 💰 ${flowAnalysis.cryptoInfo.name} (${analysis.symbol}) - Orderbook Inflow/Outflow Analysis\n\n`;
    
    // Header with crypto and exchange info
    output += `**Asset**: ${flowAnalysis.cryptoInfo.name} | **Category**: ${flowAnalysis.cryptoInfo.category} | **Tier**: ${flowAnalysis.cryptoInfo.tier}\n`;
    output += `**Exchange**: ${flowAnalysis.exchangeInfo.name} (${analysis.exchange}) | **Region**: ${flowAnalysis.exchangeInfo.region} | **Type**: ${flowAnalysis.exchangeInfo.type}\n\n`;
    
    // Enhanced Inflow/Outflow Analysis from Orderbook
    output += `### 💰 Enhanced Inflow/Outflow Analysis (Orderbook-Based):\n`;
    output += `- **Market Sentiment**: ${flowAnalysis.marketSentiment}\n`;
    output += `- **Flow Direction**: ${flowAnalysis.flowDirection}\n`;
    output += `- **Flow Strength**: ${flowAnalysis.flowStrength}\n`;
    output += `- **Dominant Flow**: ${flowAnalysis.dominantFlow}\n`;
    output += `- **Flow Prediction**: ${flowAnalysis.flowPrediction}\n`;
    output += `- **Total Liquidity**: $${formatLargeNumber(latestData.total_liquidity)} (${flowAnalysis.marketDepth})\n`;
    output += `- **Inflow Support**: ${flowAnalysis.inflowDominance.toFixed(2)}% ($${formatLargeNumber(flowAnalysis.inflowSupport)})\n`;
    output += `- **Outflow Resistance**: ${flowAnalysis.outflowDominance.toFixed(2)}% ($${formatLargeNumber(flowAnalysis.outflowResistance)})\n`;
    output += `- **Flow Imbalance**: $${formatLargeNumber(flowAnalysis.flowImbalance)}\n`;
    output += `- **Flow Momentum**: ${flowAnalysis.flowMomentum.toFixed(2)} (${flowAnalysis.flowStability})\n`;
    output += `- **Volatility Index**: ${flowAnalysis.volatilityIndicator.toFixed(2)}\n\n`;

    // Advanced Metrics & Analytics
    output += `### 🔬 Advanced Flow Analytics:\n`;
    output += `- **Support Strength**: ${flowAnalysis.supportStrength.toFixed(1)}/100\n`;
    output += `- **Resistance Strength**: ${flowAnalysis.resistanceStrength.toFixed(1)}/100\n`;
    output += `- **Liquidity Concentration**: ${flowAnalysis.liquidityConcentration.toFixed(2)}%\n`;
    output += `- **Flow Momentum Score**: ${flowAnalysis.flowMomentum.toFixed(2)} (-100 to +100)\n`;
    output += `- **Market Depth Assessment**: ${flowAnalysis.marketDepth}\n`;
    output += `- **Flow Stability Index**: ${flowAnalysis.flowStability}\n\n`;

    // Liquidity and Flow Dynamics
    output += `### 📊 Liquidity & Flow Dynamics:\n`;
    output += `- **Liquidity Trend**: ${flowAnalysis.liquidityTrend}\n`;
    output += `- **Average Liquidity**: $${formatLargeNumber(flowAnalysis.avgLiquidity)}\n`;
    output += `- **Inflow Support Depth**: $${formatLargeNumber(latestData.aggregated_bids_usd)} (${latestData.aggregated_bids_quantity.toFixed(2)} units)\n`;
    output += `- **Outflow Resistance Depth**: $${formatLargeNumber(latestData.aggregated_asks_usd)} (${latestData.aggregated_asks_quantity.toFixed(2)} units)\n`;
    
    // Support/Resistance ratio analysis
    const supportResistanceRatio = latestData.aggregated_bids_usd / latestData.aggregated_asks_usd;
    output += `- **Support/Resistance Ratio**: ${supportResistanceRatio.toFixed(3)} ${supportResistanceRatio > 1.1 ? '(Inflow Favored 🟢)' : supportResistanceRatio < 0.9 ? '(Outflow Favored 🔴)' : '(Balanced 🟡)'}\n`;
    output += `- **Last Updated**: ${new Date(latestData.time).toLocaleString()}\n\n`;

    // Advanced Flow Analysis Insights
    output += `### 🔍 Advanced Flow Analysis Insights:\n`;
    
    // Primary insights from enhanced orderbook positioning
    if (flowAnalysis.inflowDominance > 65) {
        output += `- **Exceptional Inflow Potential**: Overwhelming bid support (${flowAnalysis.inflowDominance.toFixed(1)}%) with strong momentum (${flowAnalysis.flowMomentum.toFixed(2)})\n`;
    } else if (flowAnalysis.inflowDominance > 60) {
        output += `- **Strong Inflow Potential**: Heavy bid support (${flowAnalysis.inflowDominance.toFixed(1)}%) suggests strong buying interest\n`;
    } else if (flowAnalysis.outflowDominance > 65) {
        output += `- **Exceptional Outflow Potential**: Overwhelming ask resistance (${flowAnalysis.outflowDominance.toFixed(1)}%) with negative momentum\n`;
    } else if (flowAnalysis.outflowDominance > 60) {
        output += `- **Strong Outflow Potential**: Heavy ask resistance (${flowAnalysis.outflowDominance.toFixed(1)}%) indicates selling pressure\n`;
    } else {
        output += `- **Balanced Flow Potential**: Equal support/resistance (${flowAnalysis.inflowDominance.toFixed(1)}%/${flowAnalysis.outflowDominance.toFixed(1)}%) suggests equilibrium\n`;
    }
    
    // Enhanced liquidity flow capacity analysis
    if (latestData.total_liquidity > 100000000) {
        output += `- **Exceptional Flow Capacity**: Very deep liquidity ($${formatLargeNumber(latestData.total_liquidity)}) can absorb institutional-scale flows\n`;
    } else if (latestData.total_liquidity > 50000000) {
        output += `- **High Flow Capacity**: Deep liquidity ($${formatLargeNumber(latestData.total_liquidity)}) can absorb large flows\n`;
    } else if (latestData.total_liquidity > 20000000) {
        output += `- **Moderate Flow Capacity**: Adequate liquidity ($${formatLargeNumber(latestData.total_liquidity)}) for normal flows\n`;
    } else {
        output += `- **Limited Flow Capacity**: Shallow liquidity ($${formatLargeNumber(latestData.total_liquidity)}) may impact large flows\n`;
    }

    // Flow momentum and prediction insights
    if (Math.abs(flowAnalysis.flowMomentum) > 5) {
        const direction = flowAnalysis.flowMomentum > 0 ? "inflow" : "outflow";
        output += `- **Strong Flow Momentum**: Significant ${direction} momentum (${flowAnalysis.flowMomentum.toFixed(2)}) suggests trend continuation\n`;
    } else if (Math.abs(flowAnalysis.flowMomentum) > 2) {
        const direction = flowAnalysis.flowMomentum > 0 ? "inflow" : "outflow";
        output += `- **Moderate Flow Momentum**: Building ${direction} momentum (${flowAnalysis.flowMomentum.toFixed(2)}) indicates potential trend development\n`;
    } else {
        output += `- **Stable Flow Momentum**: Low momentum (${flowAnalysis.flowMomentum.toFixed(2)}) suggests range-bound conditions\n`;
    }

    // Volatility and stability insights
    if (flowAnalysis.volatilityIndicator > 10) {
        output += `- **High Flow Volatility**: Volatile flow conditions (${flowAnalysis.volatilityIndicator.toFixed(2)}) suggest rapid market changes\n`;
    } else if (flowAnalysis.volatilityIndicator > 5) {
        output += `- **Moderate Flow Volatility**: Some flow instability (${flowAnalysis.volatilityIndicator.toFixed(2)}) indicates changing conditions\n`;
    } else {
        output += `- **Stable Flow Environment**: Low volatility (${flowAnalysis.volatilityIndicator.toFixed(2)}) supports predictable flow patterns\n`;
    }

    // Flow direction stability
    if (flowAnalysis.liquidityTrend.includes('INCREASING')) {
        output += `- **Growing Flow Infrastructure**: Increasing liquidity suggests strengthening market depth\n`;
    } else if (flowAnalysis.liquidityTrend.includes('DECREASING')) {
        output += `- **Weakening Flow Infrastructure**: Decreasing liquidity may signal reduced market depth\n`;
    } else {
        output += `- **Stable Flow Infrastructure**: Consistent liquidity supports reliable flow execution\n`;
    }

    // Flow execution and institutional presence analysis
    const avgOrderSize = latestData.total_liquidity / (latestData.aggregated_bids_quantity + latestData.aggregated_asks_quantity);
    if (avgOrderSize > 200000) {
        output += `- **Heavy Institutional Presence**: Very large average order size ($${formatLargeNumber(avgOrderSize)}) indicates major institutional activity\n`;
    } else if (avgOrderSize > 100000) {
        output += `- **Institutional Flow Presence**: Large average order size ($${formatLargeNumber(avgOrderSize)}) indicates institutional participation\n`;
    } else {
        output += `- **Retail-Driven Flow Environment**: Smaller order sizes suggest retail-dominated flow patterns\n`;
    }

    // Enhanced flow opportunity assessment
    if (flowAnalysis.flowStrength === 'VERY STRONG') {
        output += `- **Exceptional Flow Opportunity**: Very strong ${flowAnalysis.flowDirection.toLowerCase()} signals with high confidence\n`;
    } else if (flowAnalysis.flowStrength === 'STRONG') {
        output += `- **Clear Flow Opportunity**: Strong ${flowAnalysis.flowDirection.toLowerCase()} signals provide directional guidance\n`;
    } else if (flowAnalysis.flowStrength === 'MODERATE') {
        output += `- **Moderate Flow Opportunity**: ${flowAnalysis.flowDirection.toLowerCase()} bias suggests cautious positioning\n`;
    } else {
        output += `- **Neutral Flow Environment**: Balanced conditions suggest range-bound behavior\n`;
    }

    // Prediction confidence assessment
    if (flowAnalysis.flowPrediction.includes('INCREASING INFLOW')) {
        output += `- **Bullish Flow Outlook**: Momentum and trends suggest strengthening inflow potential\n`;
    } else if (flowAnalysis.flowPrediction.includes('INCREASING OUTFLOW')) {
        output += `- **Bearish Flow Outlook**: Momentum and trends suggest strengthening outflow potential\n`;
    } else if (flowAnalysis.flowPrediction.includes('STABLE')) {
        output += `- **Stable Flow Outlook**: Current conditions expected to persist in near term\n`;
    } else {
        output += `- **Mixed Flow Signals**: Conflicting indicators suggest cautious approach\n`;
    }
    return output;
}

// Orderbook-Based Inflow/Outflow Analysis Action
export const inflowOutflowAction: Action = {
    name: "INFLOW_OUTFLOW_ANALYSIS",
    description: "Get inflow/outflow analysis based on orderbook bid/ask liquidity data",
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show me BTC inflow outflow analysis",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll analyze Bitcoin's inflow/outflow patterns from orderbook liquidity data.\n\n💰 **Bitcoin (BTC) - Orderbook Inflow/Outflow Analysis**\n\n**📊 Inflow/Outflow Analysis:**\n- Market Sentiment: 🟢 BULLISH\n- Flow Direction: INFLOW FAVORED\n- Flow Strength: STRONG\n- Total Liquidity: $45.2M\n- Inflow Support: 62.1% ($28.1M)\n- Outflow Resistance: 37.9% ($17.1M)\n\n**📊 Liquidity & Flow Dynamics:**\n- Liquidity Trend: 📈 INCREASING LIQUIDITY\n- Support/Resistance Ratio: 1.643 (Inflow Favored 🟢)\n\n**Analysis:** Strong bid support dominance indicates significant inflow potential with institutional backing.",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "What's the ETH flow analysis on Bybit?",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll analyze Ethereum's inflow/outflow patterns from Bybit orderbook data.\n\n💰 **Ethereum (ETH) - Orderbook Inflow/Outflow Analysis**\n\n**Asset**: Ethereum | **Category**: Smart Contract Platform | **Tier**: Tier 1\n**Exchange**: Bybit (bybit) | **Region**: Global | **Type**: Centralized\n\n**📊 Inflow/Outflow Analysis:**\n- Market Sentiment: 🟡 NEUTRAL\n- Flow Direction: BALANCED\n- Flow Strength: NEUTRAL\n- Total Liquidity: $28.4M\n- Inflow Support: 51.2% ($14.5M)\n- Outflow Resistance: 48.8% ($13.9M)\n\n**Analysis:** ETH showing balanced orderbook conditions on Bybit with equal inflow/outflow potential.",
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
            elizaLogger.info("💰 Processing orderbook-based inflow/outflow analysis request...");

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

            // Get comprehensive inflow/outflow analysis with the specified symbol (pass data retention for clamping)
            const inflowResult = await getComprehensiveInflowOutflowAnalysis(runtime, message, state, cryptoSymbol, retentionConfig);

            if (!inflowResult.success || !inflowResult.data) {
                const errorMessage = `❌ Failed to fetch inflow/outflow analysis: ${inflowResult.error || "Unknown error"}`;
                
                if (callback) {
                    await callback(createActionErrorResponse({
                        actionName: "INFLOW_OUTFLOW_ANALYSIS",
                        type: "orderbook_inflow_outflow_analysis_error",
                        error: new Error(inflowResult.error || "Unknown error"),
                        text: errorMessage,
                    }));
                }
                return false;
            }

            // Save data to file
            try {
                await saveInflowOutflowAnalysisToFile(inflowResult.data);
            } catch (saveError) {
                elizaLogger.warn("⚠️ Failed to save inflow/outflow analysis data to file, but continuing with response:", saveError);
            }

            // Generate and save interactive chart
            let chartPath: string | undefined;
            try {
                const localChartPath = await saveInflowOutflowChartToFile(inflowResult.data, start_time, end_time);
                elizaLogger.info(`📊 Interactive chart saved: ${localChartPath}`);
                chartPath = buildChartProxyUrl(localChartPath, runtime.agentId);
            } catch (chartError) {
                elizaLogger.warn("⚠️ Failed to save chart to file, but continuing with response:", chartError);
            }

            // Format the data for analysis
            const formattedAnalysis = formatInflowOutflowForAnalysis(inflowResult.data);

            // Generate Mermaid flow diagram
            const mermaidDiagram = generateInflowOutflowMermaidDiagram(inflowResult.data);

            const actionData = {
                summary: formattedAnalysis,
                symbol: inflowResult.data.symbol,
                exchange: inflowResult.data.exchange,
                latestData: inflowResult.data.latestData,
                analysis: inflowResult.data.analysis,
                chartPath,
                mermaidDiagram
            };

            // Create comprehensive response with chart info
            let responseText = formattedAnalysis;
            
            // Add chart information to response text for UI extraction
            if (chartPath) {
                responseText += `\n\n📊 **Interactive Chart Generated**: I've created an interactive inflow/outflow analysis chart with comprehensive visualizations.`;
            }

            if (callback) {
                // Generate action summary
                const symbol = inflowResult.data.symbol;
                const dataPoints = inflowResult.data.historicalData?.length || 0;
                const flowImbalance = inflowResult.data.analysis?.flowImbalance || 0;
                const dominantFlow = inflowResult.data.analysis?.dominantFlow || 'balanced';

                const actionSummary = generateActionSummary({
                    actionName: 'Inflow/Outflow',
                    assets: [symbol],
                    timePeriod: `${dataPoints} data points`,
                    dataPoints: dataPoints,
                    additionalInfo: `${dominantFlow} flow, imbalance ${flowImbalance > 0 ? '+' : ''}${formatLargeNumberUtil(Math.abs(flowImbalance))}`
                });

                await callback(createActionResponse({
                    actionName: "INFLOW_OUTFLOW_ANALYSIS",
                    type: "orderbook_inflow_outflow_analysis",
                    text: responseText,
                    content: {
                        inflowData: inflowResult.data,
                        analysis: formattedAnalysis,
                        mermaidDiagram,
                        chartPath,
                        visualizations: {
                            interactive_chart: chartPath,
                            flow_diagram: mermaidDiagram,
                            chart_data: inflowResult.data.chartData
                        }
                    },
                    actionData: {
                        ...actionData,
                        summary: actionSummary,
                    },
                    chartPath: chartPath,
                    symbol: inflowResult.data.symbol,
                    additionalMetadata: {
                        inflowData: inflowResult.data,
                    },
                }));
            }

            elizaLogger.info("✅ Orderbook-based inflow/outflow analysis completed successfully");
            return true;

        } catch (error) {
            elizaLogger.error("❌ Error in orderbook-based inflow/outflow analysis handler:", error);
            
            const errorMessage = "I encountered an error while fetching orderbook-based inflow/outflow analysis data. Please try again later.";
            
            if (callback) {
                await callback(createActionErrorResponse({
                    actionName: "INFLOW_OUTFLOW_ANALYSIS",
                    type: "orderbook_inflow_outflow_analysis_error",
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

// Utility function to determine period based on timeframe
function determinePeriod(historicalData?: OrderbookInflowOutflowPoint[], start_time?: number, end_time?: number): string {
    // If we have start and end times, calculate the period
    if (start_time && end_time) {
        const diffMs = end_time - start_time;
        const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));
        
        if (diffDays <= 1) return '1D';
        if (diffDays <= 7) return '1W';
        if (diffDays <= 30) return '1M';
        if (diffDays <= 90) return '3M';
        if (diffDays <= 180) return '6M';
        if (diffDays <= 365) return '1Y';
        return `${Math.round(diffDays / 365)}Y`;
    }
    
    // If we have historical data, estimate period from data points
    if (historicalData && historicalData.length > 1) {
        const firstTime = historicalData[0].time;
        const lastTime = historicalData[historicalData.length - 1].time;
        const diffMs = lastTime - firstTime;
        const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));
        
        if (diffDays <= 1) return '1D';
        if (diffDays <= 7) return '1W';
        if (diffDays <= 30) return '1M';
        if (diffDays <= 90) return '3M';
        if (diffDays <= 180) return '6M';
        if (diffDays <= 365) return '1Y';
        return `${Math.round(diffDays / 365)}Y`;
    }
    
    // Default period if no data available
    return '1M';
}

// Utility function to determine date range based on timeframe
function determineDateRange(historicalData?: OrderbookInflowOutflowPoint[], start_time?: number, end_time?: number): string {
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
