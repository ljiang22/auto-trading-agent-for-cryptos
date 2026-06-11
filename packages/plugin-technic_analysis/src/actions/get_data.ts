import {
    type IAgentRuntime,
    type Memory,
    type State,
    MemoryManager,
    elizaLogger,
    httpClient,
} from "@elizaos/core";

const COINGLASS_API_URL = "https://open-api-v4.coinglass.com/api/futures/price/history";
const COINGLASS_EXCHANGE = "Binance";
const COINGLASS_INTERVAL = "1d";

// Data interfaces
export interface CryptoDataPoint {
    date: string;
    price: number;
    high: number;
    low: number;
    open: number;
    volume: number;
}

export interface ExtractedDataContext {
    symbols: string[];
    timeframes: string[];
    dataTypes: string[];
    specificRequests: string[];
    pastMessages: Memory[];
    relevantFacts: Memory[];
}

export interface DataResponse {
    success: boolean;
    data: {
        pastMessageData: ExtractedDataContext;
        yahooFinanceData: CryptoDataPoint[];
    };
    error?: string;
    /** True when requested days were capped due to subscription data retention */
    dataRetentionApplied?: boolean;
}

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

/**
 * Extracts cryptocurrency symbols from text
 */
function extractCryptoSymbols(text: string): string[] {
    const symbols = new Set<string>();
    const upperText = text.toUpperCase();
    
    // Common crypto symbols
    const cryptoPatterns = [
        /\b(BTC|BITCOIN)\b/g,
        /\b(ETH|ETHEREUM)\b/g,
        /\b(BNB|BINANCE)\b/g,
        /\b(ADA|CARDANO)\b/g,
        /\b(SOL|SOLANA)\b/g,
        /\b(XRP|RIPPLE)\b/g,
        /\b(DOGE|DOGECOIN)\b/g,
        /\b(MATIC|POLYGON)\b/g,
        /\b(AVAX|AVALANCHE)\b/g,
        /\b(LINK|CHAINLINK)\b/g,
        /\b(DOT|POLKADOT)\b/g,
        /\b(LTC|LITECOIN)\b/g,
        /\b(UNI|UNISWAP)\b/g,
        /\b(SHIB|SHIBA)\b/g,
        /\b(TRX|TRON)\b/g,
        /\b(ATOM|COSMOS)\b/g,
        /\b(NEAR)\b/g,
        /\b(ALGO|ALGORAND)\b/g,
        /\b(FTM|FANTOM)\b/g,
        /\b(APE|APECOIN)\b/g,
        /\b(SAND|SANDBOX)\b/g,
        /\b(MANA|DECENTRALAND)\b/g,
        /\b(AXS|AXIE)\b/g,
    ];
    
    cryptoPatterns.forEach(pattern => {
        const matches = upperText.match(pattern);
        if (matches) {
            matches.forEach(match => {
                // Normalize to standard symbols
                const normalized = normalizeSymbol(match);
                if (normalized) symbols.add(normalized);
            });
        }
    });
    
    return Array.from(symbols);
}

/**
 * Normalizes crypto symbols to standard format
 */
function normalizeSymbol(symbol: string): string {
    const symbolMap: { [key: string]: string } = {
        'BITCOIN': 'BTC',
        'ETHEREUM': 'ETH',
        'BINANCE': 'BNB',
        'CARDANO': 'ADA',
        'SOLANA': 'SOL',
        'RIPPLE': 'XRP',
        'DOGECOIN': 'DOGE',
        'POLYGON': 'MATIC',
        'AVALANCHE': 'AVAX',
        'CHAINLINK': 'LINK',
        'POLKADOT': 'DOT',
        'LITECOIN': 'LTC',
        'UNISWAP': 'UNI',
        'SHIBA': 'SHIB',
        'TRON': 'TRX',
        'COSMOS': 'ATOM',
        'ALGORAND': 'ALGO',
        'FANTOM': 'FTM',
        'APECOIN': 'APE',
        'SANDBOX': 'SAND',
        'DECENTRALAND': 'MANA',
        'AXIE': 'AXS',
    };
    
    return symbolMap[symbol.toUpperCase()] || symbol.toUpperCase();
}

/**
 * Extracts timeframes from text
 */
function extractTimeframes(text: string): string[] {
    const timeframes = new Set<string>();
    const lowerText = text.toLowerCase();
    
    const timeframePatterns = [
        { pattern: /\b(\d+)\s*(day|days|d)\b/g, format: (match: string, num: string) => `${num}d` },
        { pattern: /\b(\d+)\s*(week|weeks|w)\b/g, format: (match: string, num: string) => `${num}w` },
        // "|m" / "|1m" shortcuts were removed: they matched financial notation
        // like "$92m" (92 million) in chat history and leaked into CoinGlass as
        // bogus month-timeframe queries. Users can still say "3 months" / "monthly".
        { pattern: /\b(\d+)\s*(month|months)\b/g, format: (match: string, num: string) => `${num}m` },
        { pattern: /\b(\d+)\s*(year|years|y)\b/g, format: (match: string, num: string) => `${num}y` },
        { pattern: /\b(1h|1hr|hourly)\b/g, format: () => '1h' },
        { pattern: /\b(4h|4hr)\b/g, format: () => '4h' },
        { pattern: /\b(daily|1d)\b/g, format: () => '1d' },
        { pattern: /\b(weekly|1w)\b/g, format: () => '1w' },
        { pattern: /\b(monthly)\b/g, format: () => '1m' },
    ];
    
    timeframePatterns.forEach(({ pattern, format }) => {
        let match;
        while ((match = pattern.exec(lowerText)) !== null) {
            const formatted = format(match[0], match[1]);
            timeframes.add(formatted);
        }
    });
    
    // Default timeframes if none specified
    if (timeframes.size === 0) {
        timeframes.add('100d');
        timeframes.add('30d');
    }
    
    return Array.from(timeframes);
}

/**
 * Extracts data types requested from text
 */
function extractDataTypes(text: string): string[] {
    const dataTypes = new Set<string>();
    const lowerText = text.toLowerCase();
    
    const dataTypePatterns = [
        { keywords: ['price', 'prices', 'pricing'], type: 'price' },
        { keywords: ['volume', 'trading volume'], type: 'volume' },
        { keywords: ['volatility', 'vol'], type: 'volatility' },
        { keywords: ['trend', 'trends', 'trending'], type: 'trend' },
        { keywords: ['support', 'resistance', 'levels'], type: 'support_resistance' },
        { keywords: ['rsi', 'relative strength'], type: 'rsi' },
        { keywords: ['macd', 'moving average convergence'], type: 'macd' },
        { keywords: ['bollinger', 'bands'], type: 'bollinger_bands' },
        { keywords: ['moving average', 'ma', 'sma', 'ema'], type: 'moving_averages' },
        { keywords: ['market cap', 'marketcap', 'mcap'], type: 'market_cap' },
        { keywords: ['correlation', 'correlations'], type: 'correlation' },
        { keywords: ['sentiment', 'fear', 'greed'], type: 'sentiment' },
    ];
    
    dataTypePatterns.forEach(({ keywords, type }) => {
        if (keywords.some(keyword => lowerText.includes(keyword))) {
            dataTypes.add(type);
        }
    });
    
    // Default data types if none specified
    if (dataTypes.size === 0) {
        dataTypes.add('price');
        dataTypes.add('volume');
    }
    
    return Array.from(dataTypes);
}

// List of supported cryptocurrencies with their CoinGlass symbols
const SUPPORTED_CRYPTO_SYMBOLS: { [key: string]: string } = {
    "BTC": "BTCUSDT",
    "ETH": "ETHUSDT",
    "XRP": "XRPUSDT",
    "LTC": "LTCUSDT",
    "ADA": "ADAUSDT",
    "SOL": "SOLUSDT",
    "DOT": "DOTUSDT",
    "DOGE": "DOGEUSDT",
    "LINK": "LINKUSDT",
    "AVAX": "AVAXUSDT",
    "MATIC": "MATICUSDT",
    "UNI": "UNIUSDT",
    "SHIB": "SHIBUSDT",
    "TRX": "TRXUSDT",
    "ATOM": "ATOMUSDT",
    "NEAR": "NEARUSDT",
    "ALGO": "ALGOUSDT",
    "FTM": "FTMUSDT",
    "APE": "APEUSDT",
    "SAND": "SANDUSDT",
    "MANA": "MANAUSDT",
    "AXS": "AXSUSDT",
    "BNB": "BNBUSDT"
};

/**
 * Gets crypto data from CoinGlass with improved error handling and retry logic
 */
async function getCryptoData(symbol: string, days = 100): Promise<CryptoDataPoint[]> {
    try {
        const apiKey = process.env.COINGLASS_API_KEY;
        if (!apiKey) {
            elizaLogger.error("COINGLASS_API_KEY environment variable is required");
            return [];
        }

        // Convert symbol to CoinGlass format using supported symbols map
        const normalizedSymbol = symbol.toUpperCase();
        const coinglassSymbol = SUPPORTED_CRYPTO_SYMBOLS[normalizedSymbol] || `${normalizedSymbol}USDT`;
        
        const endTime = Date.now();
        const startTime = endTime - days * 24 * 60 * 60 * 1000;
        const limit = Math.min(1000, days + 5);
        
        elizaLogger.log(`Fetching ${coinglassSymbol} data for ${days} days (normalized from ${symbol})`);
        
        let responseData: CoinglassPriceHistoryResponse;
        try {
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
                    start_time: startTime,
                    end_time: endTime,
                },
            });
            responseData = response.data;
        } catch (apiError) {
            if (apiError.message?.includes('429') || apiError.message?.includes('Too Many Requests')) {
                elizaLogger.log(`Rate limited for ${coinglassSymbol}, waiting 2 seconds and retrying...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                const retryResponse = await httpClient.get(COINGLASS_API_URL, {
                    headers: {
                        accept: "application/json",
                        "CG-API-KEY": apiKey,
                    },
                    params: {
                        exchange: COINGLASS_EXCHANGE,
                        symbol: coinglassSymbol,
                        interval: COINGLASS_INTERVAL,
                        limit,
                        start_time: startTime,
                        end_time: endTime,
                    },
                });
                responseData = retryResponse.data;
            } else {
                throw apiError;
            }
        }
        
        if (!responseData || responseData.code !== "0") {
            elizaLogger.error(`CoinGlass API error for ${coinglassSymbol}: ${responseData?.msg || "Unknown error"}`);
            return [];
        }

        const result = responseData.data;
        if (!result || result.length === 0) {
            elizaLogger.error(`No data received from CoinGlass for ${coinglassSymbol}`);
            return [];
        }
        
        elizaLogger.log(`Successfully fetched ${result.length} data points for ${coinglassSymbol}`);
        
        return result
            .map(item => ({
                date: new Date(Number(item.time)).toISOString().split("T")[0],
                price: Number(item.close),
                high: Number(item.high),
                low: Number(item.low),
                open: Number(item.open),
                volume: Number(item.volume_usd)
            }))
            .filter(item => Number.isFinite(item.price));
    } catch (error) {
        const normalizedSymbol = symbol.toUpperCase();
        const coinglassSymbol = SUPPORTED_CRYPTO_SYMBOLS[normalizedSymbol] || `${normalizedSymbol}USDT`;
        elizaLogger.error(`Error fetching data from CoinGlass for ${symbol} (${coinglassSymbol}):`, error);
        elizaLogger.error(`Error details: ${error.message}`);
        return [];
    }
}

/**
 * Retrieves and analyzes past messages for data context
 */
async function getPastMessageContext(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
): Promise<ExtractedDataContext> {
    try {
        // Get recent messages from state
        const recentMessagesData = state?.recentMessagesData?.slice(-20) || [];
        
        // Get additional messages from memory manager
        const messageManager = new MemoryManager({
            runtime,
            tableName: "messages",
        });
        
        const additionalMessages = await messageManager.getMemories({
            roomId: message.roomId,
            count: 30,
            start: Date.now() - (7 * 24 * 60 * 60 * 1000), // Last 7 days
            end: Date.now(),
        });
        
        // Combine and deduplicate messages
        const allMessages = [...recentMessagesData, ...additionalMessages].filter(
            (msg, index, self) => index === self.findIndex((t) => t.id === msg.id)
        );

        // Symbol/timeframe/dataType detection only needs regex over message text.
        // Previously this ran BGE-M3 embed + facts vector search, which on CPU
        // stalls the comprehensive workflow for tens of seconds per action.
        const relevantFacts: Memory[] = [];

        const allText = allMessages
            .map(msg => (msg.content as any)?.text || '')
            .join(' ');

        const symbols = extractCryptoSymbols(allText);
        const timeframes = extractTimeframes(allText);
        const dataTypes = extractDataTypes(allText);
        
        // Extract specific requests
        const specificRequests = allMessages
            .filter(msg => {
                const text = ((msg.content as any)?.text || '').toLowerCase();
                return text.includes('data') || text.includes('analysis') || 
                       text.includes('price') || text.includes('chart');
            })
            .map(msg => (msg.content as any)?.text || '');
        
        return {
            symbols,
            timeframes,
            dataTypes,
            specificRequests,
            pastMessages: allMessages,
            relevantFacts,
        };
    } catch (error) {
        elizaLogger.error('Error retrieving past message context:', error);
        return {
            symbols: ['BTC'],
            timeframes: ['100d'],
            dataTypes: ['price'],
            specificRequests: [],
            pastMessages: [],
            relevantFacts: [],
        };
    }
}



/**
 * Main function to get detailed data from past messages and CoinGlass
 */
export async function getDetailedData(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    dataOptions?: { [key: string]: unknown },
    retentionOptions?: { dataRetentionDays?: number; dataRetentionMinDaysAgo?: number; dataRetentionMaxDaysAgo?: number }
): Promise<DataResponse> {
    try {
        elizaLogger.log('Starting detailed data retrieval process');
        
        // Get current message text
        const currentMessageText = (message.content as any)?.text || '';
        
        // Step 1: Extract symbols and timeframes from current message first
        const currentSymbols = extractCryptoSymbols(currentMessageText);
        const currentTimeframes = extractTimeframes(currentMessageText);
        
        // Step 2: Analyze past messages for context
        const pastContext = await getPastMessageContext(runtime, message, state);
        
        // Step 3: Determine primary symbol and timeframe (prioritize current message)
        const primarySymbol = currentSymbols[0] || pastContext.symbols[0] || 'BTC';
        const primaryTimeframe = currentTimeframes[0] || pastContext.timeframes[0] || '100d';
        
        // Step 4: Calculate days - prioritize from/to parameters if provided
        let days: number;
        let dataRetentionApplied = false;
        
        if (dataOptions?.from && dataOptions?.to) {
            // Calculate days from from/to parameters
            const fromStr = String(dataOptions.from).trim().slice(0, 10);
            const toStr = String(dataOptions.to).trim().slice(0, 10);
            const fromDate = new Date(fromStr + 'T00:00:00.000Z');
            const toDate = new Date(toStr + 'T23:59:59.999Z');
            
            if (!isNaN(fromDate.getTime()) && !isNaN(toDate.getTime()) && fromDate <= toDate) {
                days = Math.ceil((toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24));
                if (days < 1) days = 1;
                elizaLogger.log(`📅 Using from/to parameters: ${fromStr} to ${toStr} (${days} days)`);
            } else {
                // Fallback to timeframe parsing
                days = parseTimeframeToDays(primaryTimeframe);
                elizaLogger.log(`⚠️ Invalid from/to dates, falling back to timeframe: ${primaryTimeframe} (${days} days)`);
            }
        } else {
            // Convert timeframe to days
            days = parseTimeframeToDays(primaryTimeframe);
        }
        
        // Cap days by data retention (subscription tier); enterprise (0) = no cap
        const dataRetentionDays = typeof retentionOptions?.dataRetentionDays === "number" ? retentionOptions.dataRetentionDays : undefined;
        if (typeof dataRetentionDays === "number" && dataRetentionDays > 0 && days > dataRetentionDays) {
            dataRetentionApplied = true;
            days = dataRetentionDays;
        }
        
        elizaLogger.log(`Extracted from current message - Symbols: [${currentSymbols.join(', ')}], Timeframes: [${currentTimeframes.join(', ')}]`);
        elizaLogger.log(`Using primary symbol: ${primarySymbol}, timeframe: ${primaryTimeframe} (${days} days)`);
        
        // Step 5: Fetch CoinGlass data
        const yahooData = await getCryptoData(primarySymbol, days);
        
        // Step 6: Prepare response
        const response: DataResponse = {
            success: true,
            data: {
                pastMessageData: pastContext,
                yahooFinanceData: yahooData,
            },
            dataRetentionApplied,
        };
        
        elizaLogger.log(`Successfully retrieved data for ${primarySymbol} over ${days} days`);
        
        return response;
        
    } catch (error) {
        elizaLogger.error('Error in getDetailedData:', error);
        
        const errorResponse: DataResponse = {
            success: false,
            data: {
                pastMessageData: {
                    symbols: [],
                    timeframes: [],
                    dataTypes: [],
                    specificRequests: [],
                    pastMessages: [],
                    relevantFacts: [],
                },
                yahooFinanceData: [],
            },
            error: error instanceof Error ? error.message : 'Unknown error',
        };
        
        // Note: callback parameter is no longer used in the updated signature
        
        return errorResponse;
    }
}

/**
 * Converts timeframe string to number of days
 */
function parseTimeframeToDays(timeframe: string): number {
    const match = timeframe.match(/(\d+)([dwmy])/);
    if (!match) return 100; // Default to 100 days
    
    const [, num, unit] = match;
    const number = Number.parseInt(num);
    
    switch (unit) {
        case 'd': return number;
        case 'w': return number * 7;
        case 'm': return number * 30;
        case 'y': return number * 365;
        default: return 100;
    }
}
