// Exchange categorization utilities
export interface Exchange {
    code: string;
    name: string;
    region: string;
    tier: string;
    type: string;
}

export const exchangeCategories: Record<string, Exchange> = {
    // Tier 1 Exchanges (Major Global)
    'binance': { code: 'binance', name: 'Binance', region: 'Global', tier: 'Tier 1', type: 'Centralized' },
    'coinbase': { code: 'coinbase', name: 'Coinbase', region: 'US', tier: 'Tier 1', type: 'Centralized' },
    'kraken': { code: 'kraken', name: 'Kraken', region: 'US/EU', tier: 'Tier 1', type: 'Centralized' },
    'bybit': { code: 'bybit', name: 'Bybit', region: 'Global', tier: 'Tier 1', type: 'Centralized' },
    'okx': { code: 'okx', name: 'OKX', region: 'Global', tier: 'Tier 1', type: 'Centralized' },
    'kucoin': { code: 'kucoin', name: 'KuCoin', region: 'Global', tier: 'Tier 1', type: 'Centralized' },
    'huobi': { code: 'huobi', name: 'Huobi', region: 'Global', tier: 'Tier 1', type: 'Centralized' },
    'bitget': { code: 'bitget', name: 'Bitget', region: 'Global', tier: 'Tier 1', type: 'Centralized' },
    
    // Tier 2 Exchanges (Regional Leaders)
    'gemini': { code: 'gemini', name: 'Gemini', region: 'US', tier: 'Tier 2', type: 'Centralized' },
    'bitfinex': { code: 'bitfinex', name: 'Bitfinex', region: 'Global', tier: 'Tier 2', type: 'Centralized' },
    'bitstamp': { code: 'bitstamp', name: 'Bitstamp', region: 'EU', tier: 'Tier 2', type: 'Centralized' },
    'crypto.com': { code: 'crypto.com', name: 'Crypto.com', region: 'Global', tier: 'Tier 2', type: 'Centralized' },
    'gate.io': { code: 'gate.io', name: 'Gate.io', region: 'Global', tier: 'Tier 2', type: 'Centralized' },
    'mexc': { code: 'mexc', name: 'MEXC', region: 'Global', tier: 'Tier 2', type: 'Centralized' },
    'bitmex': { code: 'bitmex', name: 'BitMEX', region: 'Global', tier: 'Tier 2', type: 'Centralized' },
    'deribit': { code: 'deribit', name: 'Deribit', region: 'Global', tier: 'Tier 2', type: 'Centralized' },
    
    // Tier 3 Exchanges (Smaller/Regional)
    'bitmart': { code: 'bitmart', name: 'BitMart', region: 'Global', tier: 'Tier 3', type: 'Centralized' },
    'xt.com': { code: 'xt.com', name: 'XT.COM', region: 'Global', tier: 'Tier 3', type: 'Centralized' },
    'lbank': { code: 'lbank', name: 'LBank', region: 'Global', tier: 'Tier 3', type: 'Centralized' },
    'bitrue': { code: 'bitrue', name: 'Bitrue', region: 'Global', tier: 'Tier 3', type: 'Centralized' },
    'hotcoin': { code: 'hotcoin', name: 'Hotcoin', region: 'Global', tier: 'Tier 3', type: 'Centralized' },
    
    // DEX/DeFi Exchanges
    'uniswap': { code: 'uniswap', name: 'Uniswap', region: 'Global', tier: 'Tier 1', type: 'Decentralized' },
    'pancakeswap': { code: 'pancakeswap', name: 'PancakeSwap', region: 'Global', tier: 'Tier 1', type: 'Decentralized' },
    'sushiswap': { code: 'sushiswap', name: 'SushiSwap', region: 'Global', tier: 'Tier 2', type: 'Decentralized' },
    'curve': { code: 'curve', name: 'Curve', region: 'Global', tier: 'Tier 1', type: 'Decentralized' },
    'balancer': { code: 'balancer', name: 'Balancer', region: 'Global', tier: 'Tier 2', type: 'Decentralized' },
    '1inch': { code: '1inch', name: '1inch', region: 'Global', tier: 'Tier 2', type: 'Aggregator' },
    
    // Regional Exchanges
    'coincheck': { code: 'coincheck', name: 'Coincheck', region: 'Japan', tier: 'Tier 2', type: 'Centralized' },
    'bitflyer': { code: 'bitflyer', name: 'bitFlyer', region: 'Japan', tier: 'Tier 2', type: 'Centralized' },
    'upbit': { code: 'upbit', name: 'Upbit', region: 'South Korea', tier: 'Tier 2', type: 'Centralized' },
    'bithumb': { code: 'bithumb', name: 'Bithumb', region: 'South Korea', tier: 'Tier 2', type: 'Centralized' },
    'wazirx': { code: 'wazirx', name: 'WazirX', region: 'India', tier: 'Tier 3', type: 'Centralized' },
    'coindcx': { code: 'coindcx', name: 'CoinDCX', region: 'India', tier: 'Tier 3', type: 'Centralized' },
    
    // Legacy/Inactive (for historical data)
    'ftx': { code: 'ftx', name: 'FTX', region: 'Global', tier: 'Tier 1 (Inactive)', type: 'Centralized' },
    'terra_station': { code: 'terra_station', name: 'Terra Station', region: 'Global', tier: 'Tier 2 (Inactive)', type: 'Decentralized' }
};

/**
 * Default exchange for API calls when no specific exchange is requested
 */
export const DEFAULT_EXCHANGE = 'binance';

/**
 * Get exchange information including name, region, tier, and type
 * @param code - Exchange code (e.g., 'binance', 'coinbase')
 * @returns Exchange object with name, region, tier, and type information
 */
export function getExchangeInfo(code: string): Exchange {
    return exchangeCategories[code.toLowerCase()] || {
        code: code.toLowerCase(),
        name: code.toUpperCase(),
        region: 'Unknown',
        tier: 'Tier 3',
        type: 'Unknown'
    };
}

/**
 * Get exchanges by tier
 * @param tier - Tier level ('Tier 1', 'Tier 2', 'Tier 3')
 * @returns Array of exchanges in the specified tier
 */
export function getExchangesByTier(tier: string): Exchange[] {
    return Object.values(exchangeCategories).filter(exchange => exchange.tier === tier);
}

/**
 * Get exchanges by region
 * @param region - Region ('Global', 'US', 'EU', 'Asia', etc.)
 * @returns Array of exchanges in the specified region
 */
export function getExchangesByRegion(region: string): Exchange[] {
    return Object.values(exchangeCategories).filter(exchange => 
        exchange.region.toLowerCase().includes(region.toLowerCase())
    );
}

/**
 * Get exchanges by type
 * @param type - Exchange type ('Centralized', 'Decentralized', 'Aggregator')
 * @returns Array of exchanges of the specified type
 */
export function getExchangesByType(type: string): Exchange[] {
    return Object.values(exchangeCategories).filter(exchange => exchange.type === type);
}

/**
 * Get all available exchange codes
 * @returns Array of all exchange codes
 */
export function getAllExchangeCodes(): string[] {
    return Object.keys(exchangeCategories);
}

/**
 * Get tier 1 exchanges (most reliable/liquid)
 * @returns Array of tier 1 exchanges
 */
export function getTier1Exchanges(): Exchange[] {
    return getExchangesByTier('Tier 1');
}

/**
 * Get centralized exchanges only
 * @returns Array of centralized exchanges
 */
export function getCentralizedExchanges(): Exchange[] {
    return getExchangesByType('Centralized');
}

/**
 * Get decentralized exchanges only
 * @returns Array of decentralized exchanges
 */
export function getDecentralizedExchanges(): Exchange[] {
    return getExchangesByType('Decentralized');
}

/**
 * Format exchange list for API calls (comma-separated)
 * @param exchanges - Array of exchange codes
 * @returns Comma-separated string of exchange codes
 */
export function formatExchangeList(exchanges: string[]): string {
    return exchanges.join(',');
}

/**
 * Get top exchanges by tier and type
 * @param options - Options for filtering (tier, type, region, limit)
 * @returns Array of filtered exchanges
 */
export function getTopExchanges(options: {
    tier?: string;
    type?: string;
    region?: string;
    limit?: number;
} = {}): Exchange[] {
    let exchanges = Object.values(exchangeCategories);
    
    if (options.tier) {
        exchanges = exchanges.filter(ex => ex.tier === options.tier);
    }
    
    if (options.type) {
        exchanges = exchanges.filter(ex => ex.type === options.type);
    }
    
    if (options.region) {
        exchanges = exchanges.filter(ex => 
            ex.region.toLowerCase().includes(options.region!.toLowerCase())
        );
    }
    
    // Sort by tier priority (Tier 1 first, then Tier 2, etc.)
    exchanges.sort((a, b) => {
        const tierOrder = { 'Tier 1': 1, 'Tier 2': 2, 'Tier 3': 3 };
        const aTier = tierOrder[a.tier as keyof typeof tierOrder] || 4;
        const bTier = tierOrder[b.tier as keyof typeof tierOrder] || 4;
        return aTier - bTier;
    });
    
    if (options.limit) {
        exchanges = exchanges.slice(0, options.limit);
    }
    
    return exchanges;
}

/**
 * Validate if an exchange code is supported
 * @param code - Exchange code to validate
 * @returns boolean indicating if the exchange is supported
 */
export function isValidExchange(code: string): boolean {
    return code.toLowerCase() in exchangeCategories;
}

/**
 * Get exchange suggestions based on partial input
 * @param input - Partial exchange name or code
 * @returns Array of matching exchanges
 */
export function getExchangeSuggestions(input: string): Exchange[] {
    const searchTerm = input.toLowerCase();
    return Object.values(exchangeCategories).filter(exchange =>
        exchange.code.toLowerCase().includes(searchTerm) ||
        exchange.name.toLowerCase().includes(searchTerm)
    );
} 