import {
    elizaLogger,
    type IAgentRuntime,
    type Memory,
    type Provider,
    type State,
} from "@elizaos/core";
import { validateCoinMarketCapConfig } from "../environment";
import type { PriceData, ApiResponse } from "../actions/getPrice/types";
import { calculate52WeekHighLow } from "../utils/coinglass";
import { httpClient } from "@elizaos/core";

// Simple in-memory cache to prevent duplicate API calls
interface CacheEntry {
    data: any;
    timestamp: number;
}

const priceCache = new Map<string, CacheEntry>();
const pendingPriceRequests = new Map<string, Promise<any>>();
const CACHE_TTL = 30000; // 30 seconds cache TTL

/**
 * Get cached data if available and not expired
 */
const getCachedData = (key: string): any | null => {
    const entry = priceCache.get(key);
    if (entry && (Date.now() - entry.timestamp) < CACHE_TTL) {
        elizaLogger.log(`Using cached price data for key: ${key}`);
        return entry.data;
    }
    return null;
};

/**
 * Set data in cache
 */
const setCachedData = (key: string, data: any): void => {
    priceCache.set(key, {
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

/**
 * Fetch cryptocurrency price data from CoinMarketCap API
 */
async function fetchPriceData(
    symbol: string,
    currency: string,
    apiKey: string
): Promise<PriceData> {
    const normalizedSymbol = symbol.toUpperCase().trim();
    const normalizedCurrency = currency.toUpperCase().trim();
    
    // Create cache key for this specific request
    const cacheKey = `price_${normalizedSymbol}_${normalizedCurrency}`;
    
    // Check if we have cached data
    const cachedData = getCachedData(cacheKey);
    if (cachedData) {
        return cachedData;
    }
    
    // Check if there's already a pending request for this data
    const pendingRequest = pendingPriceRequests.get(cacheKey);
    if (pendingRequest) {
        elizaLogger.log(`Waiting for pending price request for key: ${cacheKey}`);
        return await pendingRequest;
    }

    // Create a promise for this request and store it to prevent duplicates
    const requestPromise = (async () => {
        try {
            // Get current price data from CoinMarketCap
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

            const symbolData = apiResponse.data[normalizedSymbol];
            if (!symbolData) {
                throw new Error(`No data found for symbol: ${normalizedSymbol}`);
            }

            const quoteData = symbolData.quote[normalizedCurrency];
            if (!quoteData) {
                throw new Error(`No quote data found for currency: ${normalizedCurrency}`);
            }

            // Get 52-week high/low data from CoinGlass
            const highLow52w = await calculate52WeekHighLow(normalizedSymbol);

            const result: PriceData = {
                // Round all numeric values to 4 decimal places
                price: roundToDecimals(quoteData.price),
                marketCap: roundToDecimals(quoteData.market_cap),
                volume24h: roundToDecimals(quoteData.volume_24h),
                percentChange24h: roundToDecimals(quoteData.percent_change_24h),
                percentChange1h: roundToDecimals(quoteData.percent_change_1h),
                percentChange7d: roundToDecimals(quoteData.percent_change_7d),
                percentChange30d: roundToDecimals(quoteData.percent_change_30d),
                fullyDilutedMarketCap: roundToDecimals(quoteData.fully_diluted_market_cap),
                circulatingSupply: roundToDecimals(symbolData.circulating_supply),
                totalSupply: roundToDecimals(symbolData.total_supply),
                maxSupply: symbolData.max_supply !== null ? roundToDecimals(symbolData.max_supply) : null,
                lastUpdated: quoteData.last_updated,
                // Include 52-week high/low from CoinGlass
                high52w: highLow52w.high52w,
                low52w: highLow52w.low52w,
                // Fear index data will be null in price provider
                fearIndex: null,
                fearIndexClassification: null,
                fearIndexUpdateTime: null
            };
            
            // Cache the result
            setCachedData(cacheKey, result);
            
            return result;
        } catch (error) {
            elizaLogger.error("Price API Error:", error);
            throw new Error(`Price API Error: ${error.message}`);
        } finally {
            // Remove the pending request when done
            pendingPriceRequests.delete(cacheKey);
        }
    })();

    // Store the pending request
    pendingPriceRequests.set(cacheKey, requestPromise);

    // Return the result
    return await requestPromise;
}

export const priceProvider: Provider = {
    get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        try {
            // Validate configuration
            const config = await validateCoinMarketCapConfig(runtime);
            
            // Extract symbol and currency from recent messages or state
            const recentMessages = state?.recentMessagesData || [];
            const lastMessage = recentMessages[recentMessages.length - 1]?.content?.text || message.content?.text || "";
            
            // Simple symbol extraction (you might want to make this more sophisticated)
            const symbolMatch = lastMessage.match(/\b(BTC|ETH|SOL|ADA|XRP|DOGE|DOT|USDC|USDT|AVAX|MATIC|LINK|UNI|LTC|BCH|XLM|ALGO|ATOM|ICP|VET|FIL|TRX|ETC|THETA|XMR|EOS|AAVE|MKR|COMP|SNX|YFI|CRV|UMA|BAL|SUSHI|1INCH)\b/i);
            const currencyMatch = lastMessage.match(/\b(USD|EUR|GBP|JPY|CAD|AUD|CHF|CNY|KRW|INR)\b/i);
            
            const symbol = symbolMatch ? symbolMatch[1].toUpperCase() : "BTC";
            const currency = currencyMatch ? currencyMatch[1].toUpperCase() : "USD";
            
            elizaLogger.log(`Price provider fetching data for ${symbol}/${currency}`);
            
            const priceData = await fetchPriceData(symbol, currency, config.COINMARKETCAP_API_KEY);
            
            return `Current ${symbol} price: $${priceData.price} ${currency}
52w High: ${priceData.high52w !== null ? `$${priceData.high52w}` : 'N/A'}
52w Low: ${priceData.low52w !== null ? `$${priceData.low52w}` : 'N/A'}
24h Volume: $${priceData.volume24h}
24h Change: ${priceData.percentChange24h}%
1h Change: ${priceData.percentChange1h}%
7d Change: ${priceData.percentChange7d}%
30d Change: ${priceData.percentChange30d}%
Last Updated: ${priceData.lastUpdated}`;
            
        } catch (error) {
            elizaLogger.error("Error in price provider:", error);
            return `Error fetching price data: ${error.message}`;
        }
    },
}; 
