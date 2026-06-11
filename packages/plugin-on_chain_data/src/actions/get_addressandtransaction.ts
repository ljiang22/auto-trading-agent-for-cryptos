/**
 * Enhanced Address and Transaction Data Analysis with Sophisticated Parameter Parsing
 * 
 * This module provides comprehensive on-chain data analysis with advanced parameter parsing:
 * 
 * COINMETRICS API (/v4/timeseries/asset-metrics)
 * - Primary data source for transaction count and active address count
 * - Supports multiple cryptocurrencies (BTC, ETH, ADA, SOL, etc.)
 * - Metrics: TxCnt (Transaction Count), AdrActCnt (Active Address Count)
 * - Enhanced time parsing with natural language support
 * 
 * Enhanced Parameter Parsing Features:
 * - Context-aware time period parsing ("for the past week", "last 30 days")
 * - Relative time expressions with multiple time units
 * - Flexible frequency/interval selection
 * - Comprehensive cryptocurrency symbol detection
 * - Automatic metric detection based on user intent
 * - Interactive Chart.js visualizations
 * 
 * Supported Time Expressions:
 * - Relative: "past week", "last 30 days", "for the past month"
 * - Explicit dates: "2024-01-01 to 2024-01-31"
 * - Natural language: "yesterday", "last week", "past month"
 * 
 * Supported Parameters:
 * - assets: string (btc, eth, ada, sol, etc.)
 * - metrics: string (TxCnt, AdrActCnt)
 * - startDate/endDate: string (YYYY-MM-DD format)
 * - frequency: string (1m, 5m, 15m, 30m, 1h, 4h, 6h, 12h, 1d, 1w)
 * - start_time/end_time: number (timestamps in milliseconds)
 */

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
import { httpClient, withMemProbe, logMemProbe, formatAxiosErrorLine } from "@elizaos/core";

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
 * Interface for CoinMetrics API response
 */
export interface CoinMetricsDataPoint {
    time: string;
    asset: string;
    TxCnt?: string; // Transaction count (API returns as string)
    AdrActCnt?: string; // Active address count (API returns as string)
}

export interface CoinMetricsResponse {
    data: CoinMetricsDataPoint[];
}

export interface OnChainDataResult {
    success: boolean;
    data?: CoinMetricsDataPoint[];
    error?: string;
    savedPath?: string;
    metric?: string;
}

export interface OnChainDataAnalysis {
    symbol: string;
    asset: string;
    metric: string;
    metricName: string;
    latestData: CoinMetricsDataPoint;
    historicalData: CoinMetricsDataPoint[];
    analysis: {
        dataPoints: number;
        startDate: string;
        endDate: string;
        averageValue: number;
        firstValue: number;
        lastValue: number;
        trend: string;
        changePercent: number;
        source: string;
    };
    chartData?: {
        labels: string[];
        values: number[];
        metricValues: number[];
    };
}

/**
 * Fetch Bitcoin on-chain data from CoinMetrics API (Transaction Count and Active Addresses)
 */
export async function getBitcoinOnChainData(
    runtime: IAgentRuntime,
    assets = 'btc',
    metrics = 'TxCnt',
    startDate?: string,
    endDate?: string,
    frequency = '1d'
): Promise<OnChainDataResult> {
    try {
        // Provide default date range if not specified (last 30 days)
        const finalEndDate = endDate || new Date().toISOString().split('T')[0];
        const finalStartDate = startDate || new Date(new Date(finalEndDate).getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        
        const metricName = metrics === 'AdrActCnt' ? 'active address' : 'transaction';
        elizaLogger.info(`🔗 Fetching ${metricName} data for ${assets.toUpperCase()} from CoinMetrics API...`);
        elizaLogger.info(`📅 Date range: ${finalStartDate} to ${finalEndDate} (frequency: ${frequency})`);
        
        const url = `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=${assets}&metrics=${metrics}&start_time=${finalStartDate}&end_time=${finalEndDate}&frequency=${frequency}`;
        
        elizaLogger.info(`📡 API URL: ${url}`);
        
        const response = await httpClient.get(url, {
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (compatible; Bot/1.0)',
            },
        });

        if (response.status < 200 || response.status >= 300) {
            throw new Error(`API request failed: ${response.status} ${response.statusText}`);
        }

        const responseData: CoinMetricsResponse = response.data;
        
        if (!responseData.data || responseData.data.length === 0) {
            throw new Error('No data received from CoinMetrics API');
        }

        elizaLogger.info(`✅ Successfully fetched ${responseData.data.length} data points`);

        // Save data to specified directory
        const savedPath = await saveTransactionDataToFile(responseData.data, assets, finalStartDate, finalEndDate);
        
        return {
            success: true,
            data: responseData.data,
            savedPath: savedPath,
            metric: metrics
        };

    } catch (error) {
        // Use the sanitizer instead of dumping the raw AxiosError — a single
        // CoinMetrics 403 used to produce ~6,500 lines of TLS socket internals.
        elizaLogger.error(
            `❌ Error fetching Bitcoin transaction data: ${formatAxiosErrorLine(error)}`
        );
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error occurred'
        };
    }
}

/**
 * Save transaction data to file
 */
async function saveTransactionDataToFile(
    data: CoinMetricsDataPoint[], 
    asset: string, 
    startDate: string, 
    endDate: string
): Promise<string> {
    try {
        // Create the target directory
        const targetDir = path.join(process.cwd(), 'saved_data', 'Onchain_data');
        
        // Ensure directory exists
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
            elizaLogger.info(`📁 Created directory: ${targetDir}`);
        }

        // Generate filename with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const metricType = data[0].TxCnt ? 'txcount' : 'activeaddr';
        const filename = `${asset}_${metricType}_${startDate}_to_${endDate}_${timestamp}.json`;
        const filePath = path.join(targetDir, filename);

        // Determine metric name
        const metricName = data[0].TxCnt ? 'TxCnt' : 'AdrActCnt';

        // Prepare data for saving
        const dataToSave = {
            metadata: {
                asset: asset.toUpperCase(),
                metric: metricName,
                metricDescription: metricName === 'TxCnt' ? 'Transaction Count' : 'Active Address Count',
                startDate: startDate,
                endDate: endDate,
                dataPoints: data.length,
                fetchedAt: new Date().toISOString(),
                source: 'CoinMetrics Community API'
            },
            data: data
        };

        // Save to file
        fs.writeFileSync(filePath, JSON.stringify(dataToSave, null, 2));
        
        elizaLogger.info(`💾 Transaction data saved to: ${filePath}`);
        
        return filePath;
        
    } catch (error) {
        elizaLogger.error('❌ Error saving transaction data to file:', error);
        throw error;
    }
}

/**
 * Parse cryptocurrency symbol from user query
 */
function parseCryptoSymbol(messageText: string): string {
    const text = messageText.toUpperCase();
    
    // Comprehensive cryptocurrency symbols and names mapping
    const cryptoMappings = [
        // Tier 1 cryptocurrencies
        { symbols: ['BTC', 'BITCOIN'], result: 'btc' },
        { symbols: ['ETH', 'ETHEREUM'], result: 'eth' },
        { symbols: ['XRP', 'RIPPLE'], result: 'xrp' },
        { symbols: ['ADA', 'CARDANO'], result: 'ada' },
        { symbols: ['SOL', 'SOLANA'], result: 'sol' },
        { symbols: ['DOT', 'POLKADOT'], result: 'dot' },
        { symbols: ['LINK', 'CHAINLINK'], result: 'link' },
        { symbols: ['LTC', 'LITECOIN'], result: 'ltc' },
        
        // Tier 2 cryptocurrencies  
        { symbols: ['MATIC', 'POLYGON'], result: 'matic' },
        { symbols: ['AVAX', 'AVALANCHE'], result: 'avax' },
        { symbols: ['UNI', 'UNISWAP'], result: 'uni' },
        { symbols: ['ATOM', 'COSMOS'], result: 'atom' },
        { symbols: ['NEAR', 'NEAR PROTOCOL'], result: 'near' },
        { symbols: ['ICP', 'INTERNET COMPUTER'], result: 'icp' },
        { symbols: ['FIL', 'FILECOIN'], result: 'fil' },
        { symbols: ['VET', 'VECHAIN'], result: 'vet' },
        { symbols: ['ALGO', 'ALGORAND'], result: 'algo' },
        { symbols: ['XTZ', 'TEZOS'], result: 'xtz' },
        { symbols: ['EGLD', 'MULTIVERSX'], result: 'egld' },
        { symbols: ['THETA', 'THETA NETWORK'], result: 'theta' },
        { symbols: ['XLM', 'STELLAR'], result: 'xlm' },
        { symbols: ['TRX', 'TRON'], result: 'trx' },
        { symbols: ['BCH', 'BITCOIN CASH'], result: 'bch' },
        { symbols: ['EOS'], result: 'eos' },
        { symbols: ['HBAR', 'HEDERA'], result: 'hbar' }
    ];
    
    for (const mapping of cryptoMappings) {
        if (mapping.symbols.some(symbol => text.includes(symbol))) {
            return mapping.result;
        }
    }
    
    return 'btc'; // Default to Bitcoin
}

/**
 * Parse metrics from user query
 */
function parseMetrics(messageText: string): string {
    const text = messageText.toLowerCase();
    
    // Parse metrics based on user request
    if (text.includes('active address') || text.includes('address count') || 
        text.includes('adrActCnt') || text.includes('active addresses') ||
        text.includes('address activity') || text.includes('wallet activity')) {
        return 'AdrActCnt';
    } else if (text.includes('transaction') || text.includes('tx count') || 
               text.includes('txcnt') || text.includes('transaction count')) {
        return 'TxCnt';
    }
    
    return 'TxCnt'; // Default to transaction count
}

/**
 * Parse timestamp parameters from user query with enhanced context awareness
 */
function parseTimestampParams(messageText: string): { 
    startDate?: string; 
    endDate?: string; 
    start_time?: number; 
    end_time?: number 
} {
    const text = messageText.toLowerCase();
    
    // First check for explicit date patterns (YYYY-MM-DD)
    const dateRegex = /(\d{4}-\d{2}-\d{2})/g;
    const dates = text.match(dateRegex);
    
    if (dates && dates.length >= 2) {
        return {
            startDate: dates[0],
            endDate: dates[1],
            start_time: new Date(dates[0]).getTime(),
            end_time: new Date(dates[1]).getTime()
        };
    } else if (dates && dates.length === 1) {
        const endDate = dates[0];
        const startDate = new Date(new Date(endDate).getTime() - 30 * 24 * 60 * 60 * 1000)
            .toISOString().split('T')[0];
        return {
            startDate,
            endDate,
            start_time: new Date(startDate).getTime(),
            end_time: new Date(endDate).getTime()
        };
    }
    
    // Parse relative time expressions with context awareness
    const now = Date.now();
    let start_time: number | undefined;
    let end_time: number = now;
    
    // Context-aware time period patterns - look for time range indicators
    const timeRangePatterns = [
        // Patterns with context words that indicate time range
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
    
    // Convert timestamps to date strings if we have them
    let startDate: string | undefined;
    let endDate: string | undefined;
    
    if (start_time) {
        startDate = new Date(start_time).toISOString().split('T')[0];
    }
    if (end_time) {
        endDate = new Date(end_time).toISOString().split('T')[0];
    }
    
    // Use default date range if no time parameters found
    if (!start_time && !end_time) {
        const defaultEndDate = new Date();
        const defaultStartDate = new Date(defaultEndDate.getTime() - 30 * 24 * 60 * 60 * 1000);
        
        startDate = defaultStartDate.toISOString().split('T')[0];
        endDate = defaultEndDate.toISOString().split('T')[0];
        start_time = defaultStartDate.getTime();
        end_time = defaultEndDate.getTime();
    }
    
    return { startDate, endDate, start_time, end_time };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function clampTimestampRangeToRetention(
    start_time: number | undefined,
    end_time: number | undefined,
    config: { dataRetentionDays?: number; dataRetentionMinDaysAgo?: number; dataRetentionMaxDaysAgo?: number }
): { start_time?: number; end_time?: number; startDate: string; endDate: string } {
    const maxDays = config.dataRetentionDays;
    const minDaysAgo = config.dataRetentionMinDaysAgo;
    const maxDaysAgo = config.dataRetentionMaxDaysAgo;
    const now = Date.now();
    if (typeof maxDays === "number" && maxDays === 0) {
        const end = end_time ?? now;
        const start = start_time ?? end - 30 * MS_PER_DAY;
        return {
            start_time: start,
            end_time: end,
            startDate: new Date(start).toISOString().split("T")[0],
            endDate: new Date(end).toISOString().split("T")[0],
        };
    }
    if (
        typeof minDaysAgo === "number" &&
        typeof maxDaysAgo === "number" &&
        maxDaysAgo > minDaysAgo
    ) {
        const start = now - maxDaysAgo * MS_PER_DAY;
        const end = now - minDaysAgo * MS_PER_DAY;
        return {
            start_time: start,
            end_time: end,
            startDate: new Date(start).toISOString().split("T")[0],
            endDate: new Date(end).toISOString().split("T")[0],
        };
    }
    const end = end_time ?? now;
    const start = start_time ?? end - 30 * MS_PER_DAY;
    if (typeof maxDays !== "number" || maxDays < 1) {
        return {
            start_time: start,
            end_time: end,
            startDate: new Date(start).toISOString().split("T")[0],
            endDate: new Date(end).toISOString().split("T")[0],
        };
    }
    const spanDays = (end - start) / MS_PER_DAY;
    if (spanDays <= maxDays) {
        return {
            start_time: start,
            end_time: end,
            startDate: new Date(start).toISOString().split("T")[0],
            endDate: new Date(end).toISOString().split("T")[0],
        };
    }
    const clampedStart = end - maxDays * MS_PER_DAY;
    return {
        start_time: clampedStart,
        end_time: end,
        startDate: new Date(clampedStart).toISOString().split("T")[0],
        endDate: new Date(end).toISOString().split("T")[0],
    };
}

/**
 * Parse frequency/interval from user query
 */
function parseFrequency(messageText: string): string {
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

/**
 * Enhanced parameter parsing function
 */
function parseOnChainDataParams(messageText: string): {
    assets?: string;
    metrics?: string;
    startDate?: string;
    endDate?: string;
    frequency?: string;
    start_time?: number;
    end_time?: number;
} {
    const assets = parseCryptoSymbol(messageText);
    const metrics = parseMetrics(messageText);
    const timestampParams = parseTimestampParams(messageText);
    const frequency = parseFrequency(messageText);
    
    elizaLogger.info(`📋 Parsed on-chain data parameters:`);
    elizaLogger.info(`   Asset: ${assets}`);
    elizaLogger.info(`   Metrics: ${metrics}`);
    elizaLogger.info(`   Frequency: ${frequency}`);
    
    if (timestampParams.startDate && timestampParams.endDate) {
        elizaLogger.info(`   Date Range: ${timestampParams.startDate} to ${timestampParams.endDate}`);
        
        if (timestampParams.start_time && timestampParams.end_time) {
            const durationHours = (timestampParams.end_time - timestampParams.start_time) / (1000 * 60 * 60);
            const durationDays = durationHours / 24;
            elizaLogger.info(`   Duration: ${durationHours.toFixed(1)} hours (${durationDays.toFixed(1)} days)`);
        }
    }
    
    return {
        assets,
        metrics,
        startDate: timestampParams.startDate,
        endDate: timestampParams.endDate,
        frequency,
        start_time: timestampParams.start_time,
        end_time: timestampParams.end_time
    };
}

// Utility function to format large numbers
function formatLargeNumber(num: number): string {
    if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
    return num.toFixed(0);
}

// Utility function to determine date range based on timeframe
function determineDateRange(start_time?: number, end_time?: number): string {
    let startDate: string;
    let endDate: string;
    
    // If we have start and end times, use them
    if (start_time && end_time) {
        startDate = new Date(start_time).toISOString().split('T')[0];
        endDate = new Date(end_time).toISOString().split('T')[0];
    }
    // Default to last 30 days (based on default range)
    else {
        const end = new Date();
        const start = new Date(end.getTime() - (30 * 24 * 60 * 60 * 1000));
        startDate = start.toISOString().split('T')[0];
        endDate = end.toISOString().split('T')[0];
    }
    
    // If same date, return single date, otherwise return range with ~ separator
    return startDate === endDate ? startDate : `${startDate}~${endDate}`;
}

// Function to clean up previous chart files for a symbol
async function cleanupPreviousOnChainCharts(symbol: string, metric: string): Promise<void> {
    try {
        const savedDataDir = path.join(process.cwd(), 'saved_data');
        const chartsDirectory = path.join(savedDataDir, 'Charts');
        
        if (!fs.existsSync(chartsDirectory)) {
            return; // No directory to clean
        }
        
        // Read all files in the directory
        const files = fs.readdirSync(chartsDirectory);
        
        // Filter files that match the symbol and metric pattern with ticker and date range
        const metricChartName = metric === 'AdrActCnt' ? 'Active Address Chart' : 'Transaction Count Chart';
        // Matches patterns like: Active Address Chart BTC 2025-01-01~2025-01-31.html or Active Address Chart BTC 2025-01-01.html
        const pattern = new RegExp(`^${metricChartName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ${symbol} \\d{4}-\\d{2}-\\d{2}(~\\d{4}-\\d{2}-\\d{2})?\\.html$`);
        const symbolFiles = files.filter(file => pattern.test(file));

        // Note: Chart deletion disabled to preserve historical data
        // Old charts are kept for reference in chat history
        const metricDisplayName = metric === 'AdrActCnt' ? 'active address' : 'transaction count';
        if (symbolFiles.length > 0) {
            elizaLogger.info(`📊 Found ${symbolFiles.length} existing ${symbol} ${metricDisplayName} chart(s) (keeping for history)`);
        }

        // Delete matching files
        // for (const file of symbolFiles) {
        //     const filepath = path.join(chartsDirectory, file);
        //     fs.unlinkSync(filepath);
        //     elizaLogger.info(`🗑️ Deleted previous chart: ${file}`);
        // }
        
    } catch (error) {
        elizaLogger.warn("⚠️ Error cleaning up previous chart files:", error);
        // Don't throw - this is cleanup, not critical
    }
}

// Function to create HTML chart for on-chain data
async function createOnChainDataChart(analysis: OnChainDataAnalysis, start_time?: number, end_time?: number): Promise<string> {
    try {
        const SAVED_DATA_DIR = path.join(process.cwd(), 'saved_data');
        const chartsDirectory = path.join(SAVED_DATA_DIR, 'Charts');
        
        // Clean up previous chart files for this symbol and metric first
        await cleanupPreviousOnChainCharts(analysis.symbol, analysis.metric);
        
        // Create directories if they don't exist
        if (!fs.existsSync(SAVED_DATA_DIR)) {
            fs.mkdirSync(SAVED_DATA_DIR, { recursive: true });
            elizaLogger.info(`📁 Created directory: ${SAVED_DATA_DIR}`);
        }
        
        if (!fs.existsSync(chartsDirectory)) {
            fs.mkdirSync(chartsDirectory, { recursive: true });
            elizaLogger.info(`📁 Created directory: ${chartsDirectory}`);
        }
        
        // Determine date range from timeframe
        const dateRange = determineDateRange(start_time, end_time);
        
        // Generate standardized filename format: [Chart Title] [Ticker] [DateRange],
        const metricDisplayName = analysis.metric === 'AdrActCnt' ? 'Active Address Chart' : 'Transaction Count Chart';
        const filename = `${metricDisplayName} ${analysis.symbol} ${dateRange}.html`;
        const filepath = path.join(chartsDirectory, filename);
        
        const { chartData } = analysis;
        if (!chartData) {
            throw new Error("No chart data available");
        }
        
        // Determine colors and styling based on metric type
        const isTransactionData = analysis.metric === 'TxCnt';
        const primaryColor = isTransactionData ? '#3B82F6' : '#10B981';
        const gradientColors = isTransactionData ? '#3B82F6 0%, #1D4ED8 100%' : '#10B981 0%, #059669 100%';
        const chartColor = isTransactionData ? '#3B82F6' : '#10B981';
        const bgColor = isTransactionData ? 'rgba(59, 130, 246, 0.1)' : 'rgba(16, 185, 129, 0.1)';
        
        // Create HTML chart content
        const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${analysis.asset} - ${analysis.metricName} Chart</title>
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
            background: linear-gradient(135deg, ${gradientColors});
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
        .metric-info {
            background: #F8FAFC;
            padding: 20px 30px;
            border-bottom: 1px solid #E5E7EB;
        }
        .metric-badge {
            display: inline-block;
            background: ${primaryColor};
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
        .increasing { color: #10b981; }
        .decreasing { color: #ef4444; }
        .stable { color: #6b7280; }
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
        body.compact-view .metric-info,
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
            <h1>${analysis.asset} - ${analysis.metricName}</h1>
            <p>On-Chain Data Analysis • ${analysis.analysis.source}</p>
        </div>
        
        <div class="metric-info">
            <span class="metric-badge">${analysis.metric}</span>
            <span style="color: #4B5563; font-weight: 500;">${analysis.metricName} - Network Activity Tracking</span>
        </div>
        
        <div class="stats">
            <div class="stat-card">
                <div class="stat-value">${formatLargeNumber(analysis.analysis.lastValue)}</div>
                <div class="stat-label">Current ${analysis.metricName}</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${formatLargeNumber(analysis.analysis.averageValue)}</div>
                <div class="stat-label">Average ${analysis.metricName}</div>
            </div>
            <div class="stat-card">
                <div class="stat-value ${analysis.analysis.trend.toLowerCase()}">${analysis.analysis.changePercent > 0 ? '+' : ''}${analysis.analysis.changePercent.toFixed(1)}%</div>
                <div class="stat-label">Change</div>
            </div>
            <div class="stat-card">
                <div class="stat-value ${analysis.analysis.trend.toLowerCase()}">${analysis.analysis.trend}</div>
                <div class="stat-label">Trend</div>
            </div>
        </div>
        
        <div class="chart-container">
            <div class="chart-title">${analysis.metricName} Over Time</div>
            <div class="chart-wrapper">
                <canvas id="onchainChart"></canvas>
            </div>
        </div>
        
        <div class="info-grid">
            <div class="info-card">
                <h3>Data Summary</h3>
                <p>Data Points: ${analysis.analysis.dataPoints}</p>
                <p>Date Range: ${analysis.analysis.startDate} to ${analysis.analysis.endDate}</p>
            </div>
            <div class="info-card">
                <h3>Metric Details</h3>
                <p>Metric: ${analysis.metricName}</p>
                <p>Asset: ${analysis.asset}</p>
                <p>Source: ${analysis.analysis.source}</p>
            </div>
            <div class="info-card">
                <h3>Value Range</h3>
                <p>First: ${formatLargeNumber(analysis.analysis.firstValue)}</p>
                <p>Latest: ${formatLargeNumber(analysis.analysis.lastValue)}</p>
                <p>Average: ${formatLargeNumber(analysis.analysis.averageValue)}</p>
            </div>
            <div class="info-card">
                <h3>Network Activity</h3>
                <p class="${analysis.analysis.trend.toLowerCase()}">Trend: ${analysis.analysis.trend}</p>
                <p>Change: ${analysis.analysis.changePercent > 0 ? '+' : ''}${analysis.analysis.changePercent.toFixed(2)}%</p>
            </div>
        </div>
    </div>
    
    <script>
        // On-Chain Data Chart
        const ctx = document.getElementById('onchainChart').getContext('2d');
        new Chart(ctx, {
            type: 'line',
            data: {
                labels: ${JSON.stringify(chartData.labels)},
                datasets: [
                    {
                        label: '${analysis.metricName}',
                        data: ${JSON.stringify(chartData.values)},
                        borderColor: '${chartColor}',
                        backgroundColor: '${bgColor}',
                        fill: true,
                        tension: 0.4,
                        pointBackgroundColor: '${chartColor}',
                        pointBorderColor: 'white',
                        pointBorderWidth: 2,
                        pointRadius: 4,
                        pointHoverRadius: 6
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
                    },
                    tooltip: {
                        backgroundColor: 'rgba(0, 0, 0, 0.8)',
                        titleColor: 'white',
                        bodyColor: 'white',
                        borderColor: '${chartColor}',
                        borderWidth: 1,
                        callbacks: {
                            label: function(context) {
                                return '${analysis.metricName}: ' + context.parsed.y.toLocaleString();
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: {
                            display: false
                        },
                        ticks: {
                            color: '#64748b'
                        }
                    },
                    y: {
                        beginAtZero: false,
                        grid: {
                            color: 'rgba(0, 0, 0, 0.1)'
                        },
                        ticks: {
                            color: '#64748b',
                            callback: function(value) {
                                if (value >= 1e6) return (value / 1e6).toFixed(1) + 'M';
                                if (value >= 1e3) return (value / 1e3).toFixed(1) + 'K';
                                return value;
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
            window.parent.postMessage({ type: 'chartHeight', height: height }, '*');
        }

        window.addEventListener('load', () => {
            setTimeout(sendHeightToParent, 500);
            setTimeout(sendHeightToParent, 1000);
        });

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
        
        elizaLogger.info(`📊 Address and transaction data chart created: ${filepath}`);
        
        // Return relative path for frontend
        const relativePath = path.relative(process.cwd(), filepath);
        return relativePath;
        
    } catch (error) {
        elizaLogger.error("❌ Error creating address and transaction data chart:", error);
        throw error;
    }
}

// Format analysis for display
export function formatOnChainDataForAnalysis(analysis: OnChainDataAnalysis): string {
    const { symbol, asset, metricName, analysis: analyticsData } = analysis;
    
    let response = `## 📊 ${asset} - ${metricName} Chart\n\n`;
    
    // Asset and Metric Info
    response += `**Asset**: ${asset} (${symbol}) | **Metric**: ${metricName}\n`;
    response += `**Data Points**: ${analyticsData.dataPoints} | **Date Range**: ${analyticsData.startDate} to ${analyticsData.endDate}\n\n`;
    
    // Current Data
    response += `**🔥 Latest ${metricName}:**\n`;
    response += `- Current Value: ${formatLargeNumber(analyticsData.lastValue)}\n`;
    response += `- Average Value: ${formatLargeNumber(analyticsData.averageValue)}\n`;
    response += `- Change: ${analyticsData.changePercent > 0 ? '+' : ''}${analyticsData.changePercent.toFixed(1)}%\n\n`;
    
    // Trend Analysis
    response += `**📈 Network Activity Analysis:**\n`;
    response += `- Trend: ${analyticsData.trend === 'INCREASING' ? '🟢' : analyticsData.trend === 'DECREASING' ? '🔴' : '🟡'} ${analyticsData.trend}\n`;
    response += `- First Value: ${formatLargeNumber(analyticsData.firstValue)}\n`;
    response += `- Latest Value: ${formatLargeNumber(analyticsData.lastValue)}\n\n`;
    
    // Chart Information
    response += `**📈 Chart Data Available:**\n`;
    response += `- ${metricName} Time Series\n`;
    response += `- Network Activity Trends\n`;
    response += `- Historical Performance Analysis\n\n`;
    
    // Add data source attribution
    response += `*Data Source: ${analyticsData.source} - On-Chain Network Data | Chart Ready*`;
    
    return response;
}

/**
 * Action handler for fetching address and transaction data with comprehensive analysis and chart visualization
 */
export const AddressAndTransactionDataAction: Action = {
    name: "GET_ADDRESS_AND_TRANSACTION_DATA",
    description: "Fetch cryptocurrency on-chain data of transaction count and active address count from CoinMetrics API with analysis and interactive chart visualization",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        options?: any,
        callback?: HandlerCallback
    ): Promise<boolean> => {
        try {
            elizaLogger.info("🚀 Starting comprehensive address and transaction data analysis...");
            
            // Extract symbol from options if available (passed from comprehensive analysis)
            const targetSymbol = options?.target || options?.symbol || null;
            
            // Get comprehensive on-chain analysis with chart data (pass data retention for clamping)
            const retentionConfig = {
                dataRetentionDays: typeof options?.dataRetentionDays === "number" ? options.dataRetentionDays : undefined,
                dataRetentionMinDaysAgo: typeof options?.dataRetentionMinDaysAgo === "number" ? options.dataRetentionMinDaysAgo : undefined,
                dataRetentionMaxDaysAgo: typeof options?.dataRetentionMaxDaysAgo === "number" ? options.dataRetentionMaxDaysAgo : undefined,
            };
            const analysisResult = await withMemProbe(
                "getAddress:comprehensiveAnalysis",
                () => getComprehensiveOnChainAnalysis(runtime, message, state, targetSymbol ?? undefined, retentionConfig),
                { target: targetSymbol ?? "n/a" }
            );

            if (!analysisResult.success || !analysisResult.data) {
                const errorMessage = `❌ Failed to fetch address and transaction data analysis: ${analysisResult.error || "Unknown error"}`;
                
                if (callback) {
                    callback({
                        text: errorMessage,
                        content: { error: analysisResult.error }
                    });
                }
                return false;
            }

            // Create chart
            let chartPath: string | undefined;
            try {
                const localChartPath = await withMemProbe(
                    "getAddress:createChart",
                    () => createOnChainDataChart(analysisResult.data!, analysisResult.start_time, analysisResult.end_time),
                    { dataPoints: analysisResult.data?.historicalData?.length ?? "n/a" }
                );
                elizaLogger.info(`📊 Chart created successfully: ${localChartPath}`);
                chartPath = buildChartProxyUrl(localChartPath, runtime.agentId);
            } catch (chartError) {
                elizaLogger.warn("⚠️ Failed to create address/transaction data chart, but continuing with response:", chartError);
            }

            // Format the data for analysis
            const formattedAnalysis = formatOnChainDataForAnalysis(analysisResult.data);

            // Create comprehensive response with chart information
            let responseText = formattedAnalysis;
            
            if (chartPath) {
                responseText += `\n\n📊 **Interactive Chart Generated**\nYou can view the interactive address and transaction data chart using the chart button below.`;
            }

            const actionData = {
                summary: formattedAnalysis,
                symbol: analysisResult.data.symbol,
                asset: analysisResult.data.asset,
                metric: analysisResult.data.metric,
                metricName: analysisResult.data.metricName,
                latestData: analysisResult.data.latestData,
                analysis: analysisResult.data.analysis,
                chartPath
            };
            
            if (callback) {
                // Generate action summary
                const symbol = analysisResult.data.symbol;
                const dataPoints = analysisResult.data.analysis?.dataPoints || analysisResult.data.historicalData?.length || 0;
                const metric = analysisResult.data.metricName || analysisResult.data.metric;
                const trend = analysisResult.data.analysis?.trend || 'stable';

                const actionSummary = generateActionSummary({
                    actionName: 'Address & Transaction Data',
                    assets: [symbol],
                    timePeriod: `${dataPoints} data points`,
                    dataPoints: dataPoints,
                    additionalInfo: `${metric}, ${trend} trend`
                });

                await callback(createActionResponse({
                    actionName: "GET_ADDRESS_AND_TRANSACTION_DATA",
                    type: "onchain_data_analysis",
                    text: responseText,
                    content: {
                        onChainData: analysisResult.data,
                        analysis: formattedAnalysis,
                        chartPath: chartPath,
                        visualizations: {
                            interactive_chart: chartPath,
                            chart_data: analysisResult.data.chartData
                        }
                    },
                    actionData: {
                        ...actionData,
                        summary: actionSummary,
                    },
                    chartPath: chartPath,
                    symbol: analysisResult.data.symbol,
                    metric: analysisResult.data.metric,
                }));
            }
            
            return true;
            
        } catch (error) {
            elizaLogger.error("❌ Error in address and transaction data analysis:", error);
            
            const errorMessage = `❌ Error fetching address and transaction data: ${error instanceof Error ? error.message : 'Unknown error'}`;
            if (callback) {
                await callback(createActionErrorResponse({
                    actionName: "GET_ADDRESS_AND_TRANSACTION_DATA",
                    type: "onchain_data_analysis_error",
                    error: error instanceof Error ? error : new Error(String(error)),
                    text: errorMessage,
                }));
            }
            return false;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Get Bitcoin address and transaction data with chart" }
            },
            {
                user: "{{user2}}", 
                content: { 
                    text: "## 📊 BTC - Transaction Count Chart\n\n**Asset**: BTC (BTC) | **Metric**: Transaction Count\n**Data Points**: 8 | **Date Range**: 2025-05-31 to 2025-06-29\n\n**🔥 Latest Transaction Count:**\n- Current Value: 486K\n- Average Value: 485K\n- Change: +2.1%\n\n**📈 Network Activity Analysis:**\n- Trend: 🟡 STABLE\n- First Value: 475K\n- Latest Value: 486K\n\n**📈 Chart Data Available:**\n- Transaction Count Time Series\n- Network Activity Trends\n- Historical Performance Analysis\n\n*Data Source: CoinMetrics Community API - On-Chain Network Data | Chart Ready*\n\n📊 **Interactive Chart Generated**\nYou can view the interactive on-chain data chart using the chart button below."
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Fetch Bitcoin active address count data with visualization" }
            },
            {
                user: "{{user2}}",
                content: { 
                    text: "## 📊 BTC - Active Address Count Chart\n\n**Asset**: BTC (BTC) | **Metric**: Active Address Count\n**Data Points**: 8 | **Date Range**: 2025-05-31 to 2025-06-29\n\n**🔥 Latest Active Address Count:**\n- Current Value: 878K\n- Average Value: 892K\n- Change: -1.8%\n\n**📈 Network Activity Analysis:**\n- Trend: 🟡 STABLE\n- First Value: 945K\n- Latest Value: 878K\n\n**📈 Chart Data Available:**\n- Active Address Count Time Series\n- Network Activity Trends\n- Historical Performance Analysis\n\n*Data Source: CoinMetrics Community API - On-Chain Network Data | Chart Ready*\n\n📊 **Interactive Chart Generated**\nYou can view the interactive on-chain data chart using the chart button below."
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Show Ethereum address and transaction analysis with chart" }
            },
            {
                user: "{{user2}}",
                content: { 
                    text: "## 📊 ETH - Transaction Count Chart\n\n**Asset**: ETH (ETH) | **Metric**: Transaction Count\n**Data Points**: 8 | **Date Range**: 2025-05-31 to 2025-06-29\n\n**🔥 Latest Transaction Count:**\n- Current Value: 1.2M\n- Average Value: 1.18M\n- Change: +3.5%\n\n**📈 Network Activity Analysis:**\n- Trend: 🟢 INCREASING\n- First Value: 1.16M\n- Latest Value: 1.2M\n\n**📈 Chart Data Available:**\n- Transaction Count Time Series\n- Network Activity Trends\n- Historical Performance Analysis\n\n*Data Source: CoinMetrics Community API - On-Chain Network Data | Chart Ready*\n\n📊 **Interactive Chart Generated**\nYou can view the interactive on-chain data chart using the chart button below."
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Show me Bitcoin transaction data for the past 30 days" }
            },
            {
                user: "{{user2}}",
                content: { 
                    text: "I'll analyze Bitcoin's transaction data for the past 30 days with comprehensive analysis and chart visualization.\n\n## 📊 BTC - Transaction Count Chart\n\n**Asset**: Bitcoin (BTC) | **Category**: Digital Currency | **Tier**: Tier 1\n**Data Points**: 30 | **Date Range**: 2025-05-30 to 2025-06-29\n\n**🔥 Latest Transaction Count:**\n- Current Value: 486K\n- Average Value: 485K\n- Change: +2.1%\n\n**📈 Network Activity Analysis:**\n- Trend: 🟡 STABLE\n- First Value: 475K\n- Latest Value: 486K\n\n**📈 Chart Data Available:**\n- Transaction Count Time Series\n- Network Activity Trends\n- Historical Performance Analysis\n\n*Data Source: CoinMetrics Community API - On-Chain Network Data | Chart Ready*\n\n📊 **Interactive Chart Generated**\nYou can view the interactive transaction and address data chart using the chart button below."
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Get ETH active address analysis for the last 30 days" }
            },
            {
                user: "{{user2}}",
                content: { 
                    text: "I'll analyze Ethereum's active address activity for the past 30 days.\n\n## 📊 ETH - Active Address Count Chart\n\n**Asset**: Ethereum (ETH) | **Category**: Smart Contract Platform | **Tier**: Tier 1\n**Data Points**: 30 | **Date Range**: 2025-05-30 to 2025-06-29\n\n**🔥 Latest Active Address Count:**\n- Current Value: 456K\n- Average Value: 462K\n- Change: -1.3%\n\n**📈 Network Activity Analysis:**\n- Trend: 🟡 STABLE\n- First Value: 468K\n- Latest Value: 456K\n\n**📈 Chart Data Available:**\n- Active Address Count Time Series\n- Network Activity Trends\n- Historical Performance Analysis\n\n*Data Source: CoinMetrics Community API - On-Chain Network Data | Chart Ready*\n\n📊 **Interactive Chart Generated**\nYou can view the interactive active address chart using the chart button below."
                }
            }
        ],
    ] as ActionExample[][],
    cacheConfig: {
        enabled: true,
        ttlSeconds: 86400, // 1 day for on-chain data
        similarityThreshold: 0.7,
        maxChunkSize: 200,
    },
};

/**
 * Format the response for display
 */
function formatOnChainDataResponse(result: OnChainDataResult): string {
    if (!result.success || !result.data) {
        return `❌ Failed to fetch on-chain data: ${result.error}`;
    }
    
    const data = result.data;
    const firstPoint = data[0];
    const lastPoint = data[data.length - 1];
    const metric = result.metric || (firstPoint.TxCnt ? 'TxCnt' : 'AdrActCnt');
    
    // Determine if this is transaction count or active address count
    const isTransactionData = metric === 'TxCnt' || firstPoint.TxCnt;
    const metricName = isTransactionData ? 'Transaction Count' : 'Active Address Count';
    const metricSymbol = isTransactionData ? 'TxCnt' : 'AdrActCnt';
    const dataUnit = isTransactionData ? 'transactions' : 'active addresses';
    const averageLabel = isTransactionData ? 'Average Daily Transactions' : 'Average Daily Active Addresses';
    
    // Get the appropriate values
    const getMetricValue = (point: CoinMetricsDataPoint): number => {
        if (isTransactionData && point.TxCnt) {
            return Number.parseInt(point.TxCnt);
        } else if (!isTransactionData && point.AdrActCnt) {
            return Number.parseInt(point.AdrActCnt);
        }
        return 0;
    };
    
    const firstValue = getMetricValue(firstPoint);
    const lastValue = getMetricValue(lastPoint);
    const averageValue = Math.round(data.reduce((sum, point) => sum + getMetricValue(point), 0) / data.length);
    
    return `✅ ${firstPoint.asset.toUpperCase()} ${metricName} Data Successfully Fetched!

📊 **Data Summary:**
• Asset: ${firstPoint.asset.toUpperCase()}
• Metric: ${metricName} (${metricSymbol})
• Date Range: ${new Date(firstPoint.time).toISOString().split('T')[0]} to ${new Date(lastPoint.time).toISOString().split('T')[0]}
• Total Data Points: ${data.length}

📈 **${metricName} Overview:**
• First Day (${new Date(firstPoint.time).toISOString().split('T')[0]}): ${firstValue.toLocaleString()} ${dataUnit}
• Last Day (${new Date(lastPoint.time).toISOString().split('T')[0]}): ${lastValue.toLocaleString()} ${dataUnit}
• ${averageLabel}: ${averageValue.toLocaleString()}

💾 **Data Saved:** ${result.savedPath}

🔗 **Source:** CoinMetrics Community API
⏰ **Fetched At:** ${new Date().toISOString().split('T')[0]}`;
}

// Function to create comprehensive on-chain data analysis
export async function getComprehensiveOnChainAnalysis(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    symbol?: string,
    options?: { dataRetentionDays?: number; dataRetentionMinDaysAgo?: number; dataRetentionMaxDaysAgo?: number }
): Promise<{ success: boolean; data?: OnChainDataAnalysis; error?: string; start_time?: number; end_time?: number }> {
    try {
        elizaLogger.info("🔍 Starting comprehensive address and transaction data analysis...");

        const messageText = message.content.text || "";
        const params = parseOnChainDataParams(messageText);
        
        const extractedSymbol = symbol || params.assets || 'btc';
        const extractedMetrics = params.metrics || 'TxCnt';
        const extractedFrequency = params.frequency || '1d';
        
        // Parse timestamp parameters and clamp by subscription/anonymous data retention if set
        const timestampParams = parseTimestampParams(messageText);
        const retentionConfig = {
            dataRetentionDays: options?.dataRetentionDays,
            dataRetentionMinDaysAgo: options?.dataRetentionMinDaysAgo,
            dataRetentionMaxDaysAgo: options?.dataRetentionMaxDaysAgo,
        };
        if (
            (typeof retentionConfig.dataRetentionDays === "number" && retentionConfig.dataRetentionDays >= 0) ||
            (typeof retentionConfig.dataRetentionMinDaysAgo === "number" && typeof retentionConfig.dataRetentionMaxDaysAgo === "number")
        ) {
            const clamped = clampTimestampRangeToRetention(
                timestampParams.start_time,
                timestampParams.end_time,
                retentionConfig
            );
            params.startDate = clamped.startDate;
            params.endDate = clamped.endDate;
            params.start_time = clamped.start_time;
            params.end_time = clamped.end_time;
        }

        logMemProbe("getAddress:enter", { symbol: extractedSymbol, metric: extractedMetrics });

        // Clean up previous files for this symbol and metric
        await withMemProbe(
            "getAddress:cleanupPrev",
            () => cleanupPreviousOnChainCharts(extractedSymbol, extractedMetrics)
        );

        // Fetch on-chain data
        const result = await withMemProbe(
            "getAddress:fetchCoinMetrics",
            () => getBitcoinOnChainData(
                runtime,
                extractedSymbol,
                extractedMetrics,
                params.startDate,
                params.endDate,
                extractedFrequency
            )
        );

        if (!result.success || !result.data || result.data.length === 0) {
            throw new Error(`Failed to fetch on-chain data: ${result.error}`);
        }

        const data = result.data;
        const firstPoint = data[0];
        const lastPoint = data[data.length - 1];
        const metric = result.metric || extractedMetrics;
        
        // Determine metric details
        const isTransactionData = metric === 'TxCnt' || firstPoint.TxCnt;
        const metricName = isTransactionData ? 'Transaction Count' : 'Active Address Count';
        
        // Get metric values
        const getMetricValue = (point: CoinMetricsDataPoint): number => {
            if (isTransactionData && point.TxCnt) {
                return Number.parseInt(point.TxCnt);
            } else if (!isTransactionData && point.AdrActCnt) {
                return Number.parseInt(point.AdrActCnt);
            }
            return 0;
        };
        
        const firstValue = getMetricValue(firstPoint);
        const lastValue = getMetricValue(lastPoint);
        const averageValue = Math.round(data.reduce((sum, point) => sum + getMetricValue(point), 0) / data.length);
        
        // Calculate trend and change percentage
        const changePercent = firstValue > 0 ? ((lastValue - firstValue) / firstValue) * 100 : 0;
        const trend = changePercent > 5 ? 'INCREASING' : changePercent < -5 ? 'DECREASING' : 'STABLE';
        
        // Create chart data
        const chartData = {
            labels: data.map(point => {
                const date = new Date(point.time);
                return date.toISOString().split('T')[0]; // Format as YYYY-MM-DD
            }),
            values: data.map(point => getMetricValue(point)),
            metricValues: data.map(point => getMetricValue(point))
        };

        const analysis: OnChainDataAnalysis = {
            symbol: extractedSymbol.toUpperCase(),
            asset: firstPoint.asset.toUpperCase(),
            metric: metric,
            metricName: metricName,
            latestData: lastPoint,
            historicalData: data,
            analysis: {
                dataPoints: data.length,
                startDate: new Date(firstPoint.time).toISOString().split('T')[0], // Format as YYYY-MM-DD
                endDate: new Date(lastPoint.time).toISOString().split('T')[0], // Format as YYYY-MM-DD
                averageValue: averageValue,
                firstValue: firstValue,
                lastValue: lastValue,
                trend: trend,
                changePercent: changePercent,
                source: 'CoinMetrics Community API'
            },
            chartData
        };

        elizaLogger.info(`✅ Successfully completed address and transaction analysis for ${extractedSymbol}`);
        elizaLogger.info(`📊 ${metricName}: ${formatLargeNumber(lastValue)} | Trend: ${trend}`);

        return {
            success: true,
            data: analysis,
            start_time: params.start_time ?? timestampParams.start_time,
            end_time: params.end_time ?? timestampParams.end_time
        };

    } catch (error) {
        elizaLogger.error(
            `❌ Error in comprehensive address and transaction analysis: ${formatAxiosErrorLine(error)}`
        );
        return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error occurred"
        };
    }
}
