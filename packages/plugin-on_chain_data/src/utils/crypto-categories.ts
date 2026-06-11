// Cryptocurrency categorization utilities
export interface CryptoCurrency {
    symbol: string;
    name: string;
    category: string;
    tier: string;
}

export const cryptoCategories: Record<string, CryptoCurrency> = {
    // Major Cryptocurrencies
    'BTC': { symbol: 'BTC', name: 'Bitcoin', category: 'Store of Value', tier: 'Tier 1' },
    'ETH': { symbol: 'ETH', name: 'Ethereum', category: 'Smart Contract Platform', tier: 'Tier 1' },
    
    // Layer 1 Blockchains
    'SOL': { symbol: 'SOL', name: 'Solana', category: 'Layer 1', tier: 'Tier 1' },
    'ADA': { symbol: 'ADA', name: 'Cardano', category: 'Layer 1', tier: 'Tier 1' },
    'AVAX': { symbol: 'AVAX', name: 'Avalanche', category: 'Layer 1', tier: 'Tier 1' },
    'DOT': { symbol: 'DOT', name: 'Polkadot', category: 'Layer 0', tier: 'Tier 1' },
    'ATOM': { symbol: 'ATOM', name: 'Cosmos', category: 'Layer 0', tier: 'Tier 1' },
    'NEAR': { symbol: 'NEAR', name: 'Near Protocol', category: 'Layer 1', tier: 'Tier 2' },
    'FTM': { symbol: 'FTM', name: 'Fantom', category: 'Layer 1', tier: 'Tier 2' },
    'ALGO': { symbol: 'ALGO', name: 'Algorand', category: 'Layer 1', tier: 'Tier 2' },
    
    // Layer 2 Solutions
    'MATIC': { symbol: 'MATIC', name: 'Polygon', category: 'Layer 2', tier: 'Tier 1' },
    'ARB': { symbol: 'ARB', name: 'Arbitrum', category: 'Layer 2', tier: 'Tier 2' },
    'OP': { symbol: 'OP', name: 'Optimism', category: 'Layer 2', tier: 'Tier 2' },
    
    // DeFi Tokens
    'UNI': { symbol: 'UNI', name: 'Uniswap', category: 'DeFi', tier: 'Tier 1' },
    'AAVE': { symbol: 'AAVE', name: 'Aave', category: 'DeFi', tier: 'Tier 1' },
    'COMP': { symbol: 'COMP', name: 'Compound', category: 'DeFi', tier: 'Tier 2' },
    'MKR': { symbol: 'MKR', name: 'Maker', category: 'DeFi', tier: 'Tier 1' },
    'CRV': { symbol: 'CRV', name: 'Curve', category: 'DeFi', tier: 'Tier 2' },
    'SUSHI': { symbol: 'SUSHI', name: 'SushiSwap', category: 'DeFi', tier: 'Tier 2' },
    'YFI': { symbol: 'YFI', name: 'Yearn Finance', category: 'DeFi', tier: 'Tier 2' },
    'SNX': { symbol: 'SNX', name: 'Synthetix', category: 'DeFi', tier: 'Tier 2' },
    
    // Stablecoins
    'USDT': { symbol: 'USDT', name: 'Tether', category: 'Stablecoin', tier: 'Tier 1' },
    'USDC': { symbol: 'USDC', name: 'USD Coin', category: 'Stablecoin', tier: 'Tier 1' },
    'DAI': { symbol: 'DAI', name: 'Dai', category: 'Stablecoin', tier: 'Tier 1' },
    'BUSD': { symbol: 'BUSD', name: 'Binance USD', category: 'Stablecoin', tier: 'Tier 1' },
    'FRAX': { symbol: 'FRAX', name: 'Frax', category: 'Stablecoin', tier: 'Tier 2' },
    
    // Memecoins
    'DOGE': { symbol: 'DOGE', name: 'Dogecoin', category: 'Memecoin', tier: 'Tier 1' },
    'SHIB': { symbol: 'SHIB', name: 'Shiba Inu', category: 'Memecoin', tier: 'Tier 2' },
    'PEPE': { symbol: 'PEPE', name: 'Pepe', category: 'Memecoin', tier: 'Tier 2' },
    'FLOKI': { symbol: 'FLOKI', name: 'Floki', category: 'Memecoin', tier: 'Tier 3' },
    
    // Gaming & NFT
    'AXS': { symbol: 'AXS', name: 'Axie Infinity', category: 'Gaming', tier: 'Tier 2' },
    'SAND': { symbol: 'SAND', name: 'The Sandbox', category: 'Gaming', tier: 'Tier 2' },
    'MANA': { symbol: 'MANA', name: 'Decentraland', category: 'Gaming', tier: 'Tier 2' },
    'ENJ': { symbol: 'ENJ', name: 'Enjin', category: 'Gaming', tier: 'Tier 2' },
    
    // AI & Data
    'FET': { symbol: 'FET', name: 'Fetch.ai', category: 'AI', tier: 'Tier 2' },
    'OCEAN': { symbol: 'OCEAN', name: 'Ocean Protocol', category: 'AI', tier: 'Tier 2' },
    'GRT': { symbol: 'GRT', name: 'The Graph', category: 'Data', tier: 'Tier 2' },
    
    // Infrastructure
    'LINK': { symbol: 'LINK', name: 'Chainlink', category: 'Oracle', tier: 'Tier 1' },
    'VET': { symbol: 'VET', name: 'VeChain', category: 'Supply Chain', tier: 'Tier 2' },
    'THETA': { symbol: 'THETA', name: 'Theta', category: 'Video Streaming', tier: 'Tier 2' },
    
    // Privacy Coins
    'XMR': { symbol: 'XMR', name: 'Monero', category: 'Privacy', tier: 'Tier 1' },
    'ZEC': { symbol: 'ZEC', name: 'Zcash', category: 'Privacy', tier: 'Tier 2' },
    
    // Exchange Tokens
    'BNB': { symbol: 'BNB', name: 'BNB', category: 'Exchange Token', tier: 'Tier 1' },
    'CRO': { symbol: 'CRO', name: 'Cronos', category: 'Exchange Token', tier: 'Tier 2' },
    'FTT': { symbol: 'FTT', name: 'FTX Token', category: 'Exchange Token', tier: 'Tier 3' },
    
    // Others
    'XRP': { symbol: 'XRP', name: 'XRP', category: 'Payment', tier: 'Tier 1' },
    'LTC': { symbol: 'LTC', name: 'Litecoin', category: 'Payment', tier: 'Tier 1' },
    'BCH': { symbol: 'BCH', name: 'Bitcoin Cash', category: 'Payment', tier: 'Tier 2' },
    'TRX': { symbol: 'TRX', name: 'Tron', category: 'Entertainment', tier: 'Tier 2' },
    'EOS': { symbol: 'EOS', name: 'EOS', category: 'Layer 1', tier: 'Tier 2' },
    'XLM': { symbol: 'XLM', name: 'Stellar', category: 'Payment', tier: 'Tier 2' },
    'HBAR': { symbol: 'HBAR', name: 'Hedera', category: 'Enterprise', tier: 'Tier 2' },
    'ICP': { symbol: 'ICP', name: 'Internet Computer', category: 'Computing', tier: 'Tier 2' },
    'FLOW': { symbol: 'FLOW', name: 'Flow', category: 'NFT Platform', tier: 'Tier 2' },
    'APT': { symbol: 'APT', name: 'Aptos', category: 'Layer 1', tier: 'Tier 2' },
    'SUI': { symbol: 'SUI', name: 'Sui', category: 'Layer 1', tier: 'Tier 2' }
};

/**
 * Get cryptocurrency information including category and tier
 * @param symbol - Cryptocurrency symbol (e.g., 'BTC', 'ETH')
 * @returns CryptoCurrency object with name, category, and tier information
 */
export function getCryptoInfo(symbol: string): CryptoCurrency {
    return cryptoCategories[symbol.toUpperCase()] || {
        symbol: symbol.toUpperCase(),
        name: symbol.toUpperCase(),
        category: 'Unknown',
        tier: 'Tier 3'
    };
}

/**
 * Categorize transactions by cryptocurrency types
 * @param transactions - Array of whale transactions
 * @returns Record of categories with their transactions, total value, and count
 */
export function categorizeTransactionsByType<T extends { symbol: string; position_value_usd: number }>(
    transactions: T[]
): Record<string, {
    transactions: T[];
    totalValue: number;
    count: number;
}> {
    const categories: Record<string, {
        transactions: T[];
        totalValue: number;
        count: number;
    }> = {};
    
    transactions.forEach(tx => {
        const cryptoInfo = getCryptoInfo(tx.symbol);
        const category = cryptoInfo.category;
        
        if (!categories[category]) {
            categories[category] = {
                transactions: [],
                totalValue: 0,
                count: 0
            };
        }
        
        categories[category].transactions.push(tx);
        categories[category].totalValue += tx.position_value_usd;
        categories[category].count++;
    });
    
    return categories;
}

/**
 * Get the tier distribution of transactions
 * @param transactions - Array of whale transactions
 * @returns Record of tiers with their count and total value
 */
export function getTierDistribution<T extends { symbol: string; position_value_usd: number }>(
    transactions: T[]
): Record<string, { count: number; totalValue: number }> {
    const tiers: Record<string, { count: number; totalValue: number }> = {};
    
    transactions.forEach(tx => {
        const cryptoInfo = getCryptoInfo(tx.symbol);
        const tier = cryptoInfo.tier;
        
        if (!tiers[tier]) {
            tiers[tier] = { count: 0, totalValue: 0 };
        }
        
        tiers[tier].count++;
        tiers[tier].totalValue += tx.position_value_usd;
    });
    
    return tiers;
}

/**
 * Get top categories by total value
 * @param categoryBreakdown - Category breakdown data
 * @param limit - Number of top categories to return (default: 5)
 * @returns Array of top categories sorted by total value
 */
export function getTopCategories(
    categoryBreakdown: Record<string, { totalValue: number; count: number }>,
    limit = 5
): Array<{ category: string; totalValue: number; count: number }> {
    return Object.entries(categoryBreakdown)
        .map(([category, data]) => ({ category, ...data }))
        .sort((a, b) => b.totalValue - a.totalValue)
        .slice(0, limit);
} 