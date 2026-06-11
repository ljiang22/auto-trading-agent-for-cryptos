export interface CryptoCurrency {
    name: string;
    symbol: string;
    aliases?: string[];
}

export const CRYPTOCURRENCY_LIST: CryptoCurrency[] = [
    // Top Market Cap Cryptocurrencies
    { name: 'Bitcoin', symbol: 'BTC', aliases: ['bitcoin', 'btc'] },
    { name: 'Ethereum', symbol: 'ETH', aliases: ['ethereum', 'eth', 'ether'] },
    { name: 'Tether', symbol: 'USDT', aliases: ['tether', 'usdt'] },
    { name: 'BNB', symbol: 'BNB', aliases: ['bnb', 'binance coin', 'binance'] },
    { name: 'Solana', symbol: 'SOL', aliases: ['solana', 'sol'] },
    { name: 'USDC', symbol: 'USDC', aliases: ['usdc', 'usd coin'] },
    { name: 'XRP', symbol: 'XRP', aliases: ['xrp', 'ripple'] },
    { name: 'Dogecoin', symbol: 'DOGE', aliases: ['dogecoin', 'doge'] },
    { name: 'Toncoin', symbol: 'TON', aliases: ['toncoin', 'ton', 'the open network'] },
    { name: 'Cardano', symbol: 'ADA', aliases: ['cardano', 'ada'] },
    
    // Major Altcoins
    { name: 'TRON', symbol: 'TRX', aliases: ['tron', 'trx'] },
    { name: 'Avalanche', symbol: 'AVAX', aliases: ['avalanche', 'avax'] },
    { name: 'Shiba Inu', symbol: 'SHIB', aliases: ['shiba inu', 'shib', 'shiba'] },
    { name: 'Chainlink', symbol: 'LINK', aliases: ['chainlink', 'link'] },
    { name: 'Polkadot', symbol: 'DOT', aliases: ['polkadot', 'dot'] },
    { name: 'Bitcoin Cash', symbol: 'BCH', aliases: ['bitcoin cash', 'bch'] },
    { name: 'NEAR Protocol', symbol: 'NEAR', aliases: ['near protocol', 'near'] },
    { name: 'Uniswap', symbol: 'UNI', aliases: ['uniswap', 'uni'] },
    { name: 'Litecoin', symbol: 'LTC', aliases: ['litecoin', 'ltc'] },
    { name: 'Pepe', symbol: 'PEPE', aliases: ['pepe', 'pepe coin'] },
    
    // Popular DeFi Tokens
    { name: 'Dai', symbol: 'DAI', aliases: ['dai', 'makerdao'] },
    { name: 'Internet Computer', symbol: 'ICP', aliases: ['internet computer', 'icp'] },
    { name: 'Kaspa', symbol: 'KAS', aliases: ['kaspa', 'kas'] },
    { name: 'Ethereum Classic', symbol: 'ETC', aliases: ['ethereum classic', 'etc'] },
    { name: 'Monero', symbol: 'XMR', aliases: ['monero', 'xmr'] },
    { name: 'Stellar', symbol: 'XLM', aliases: ['stellar', 'xlm', 'stellar lumens'] },
    { name: 'OKB', symbol: 'OKB', aliases: ['okb', 'okex token'] },
    { name: 'Filecoin', symbol: 'FIL', aliases: ['filecoin', 'fil'] },
    { name: 'Cosmos', symbol: 'ATOM', aliases: ['cosmos', 'atom'] },
    { name: 'Cronos', symbol: 'CRO', aliases: ['cronos', 'cro', 'crypto.com coin'] },
    
    // Layer 2 and Scaling Solutions
    { name: 'Polygon', symbol: 'MATIC', aliases: ['polygon', 'matic'] },
    { name: 'Arbitrum', symbol: 'ARB', aliases: ['arbitrum', 'arb'] },
    { name: 'Optimism', symbol: 'OP', aliases: ['optimism', 'op'] },
    { name: 'Immutable X', symbol: 'IMX', aliases: ['immutable x', 'imx', 'immutable'] },
    
    // Meme Coins
    { name: 'Bonk', symbol: 'BONK', aliases: ['bonk'] },
    { name: 'dogwifhat', symbol: 'WIF', aliases: ['dogwifhat', 'wif', 'dog wif hat'] },
    { name: 'Floki', symbol: 'FLOKI', aliases: ['floki', 'floki inu'] },
    { name: 'SafeMoon', symbol: 'SAFEMOON', aliases: ['safemoon'] },
    
    // Enterprise and Institutional
    { name: 'VeChain', symbol: 'VET', aliases: ['vechain', 'vet'] },
    { name: 'Hedera', symbol: 'HBAR', aliases: ['hedera', 'hbar', 'hedera hashgraph'] },
    { name: 'Algorand', symbol: 'ALGO', aliases: ['algorand', 'algo'] },
    { name: 'IOTA', symbol: 'IOTA', aliases: ['iota', 'miota'] },
    { name: 'Fantom', symbol: 'FTM', aliases: ['fantom', 'ftm'] },
    
    // Privacy Coins
    { name: 'Zcash', symbol: 'ZEC', aliases: ['zcash', 'zec'] },
    { name: 'Dash', symbol: 'DASH', aliases: ['dash'] },
    { name: 'Monero', symbol: 'XMR', aliases: ['monero', 'xmr'] },
    
    // Exchange Tokens
    { name: 'FTX Token', symbol: 'FTT', aliases: ['ftx token', 'ftt'] },
    { name: 'KuCoin Token', symbol: 'KCS', aliases: ['kucoin token', 'kcs'] },
    { name: 'Huobi Token', symbol: 'HT', aliases: ['huobi token', 'ht'] },
    
    // Gaming and NFT
    { name: 'ApeCoin', symbol: 'APE', aliases: ['apecoin', 'ape'] },
    { name: 'The Sandbox', symbol: 'SAND', aliases: ['the sandbox', 'sand', 'sandbox'] },
    { name: 'Decentraland', symbol: 'MANA', aliases: ['decentraland', 'mana'] },
    { name: 'Axie Infinity', symbol: 'AXS', aliases: ['axie infinity', 'axs'] },
    { name: 'Enjin Coin', symbol: 'ENJ', aliases: ['enjin coin', 'enj', 'enjin'] },
    
    // Oracles and Data
    { name: 'Chainlink', symbol: 'LINK', aliases: ['chainlink', 'link'] },
    { name: 'Band Protocol', symbol: 'BAND', aliases: ['band protocol', 'band'] },
    
    // Cross-chain and Interoperability
    { name: 'Polkadot', symbol: 'DOT', aliases: ['polkadot', 'dot'] },
    { name: 'Cosmos', symbol: 'ATOM', aliases: ['cosmos', 'atom'] },
    { name: 'Thorchain', symbol: 'RUNE', aliases: ['thorchain', 'rune'] },
    
    // AI and Computing
    { name: 'Render Token', symbol: 'RNDR', aliases: ['render token', 'rndr', 'render'] },
    { name: 'Fetch.ai', symbol: 'FET', aliases: ['fetch.ai', 'fet', 'fetch'] },
    { name: 'SingularityNET', symbol: 'AGIX', aliases: ['singularitynet', 'agix'] },
    { name: 'Ocean Protocol', symbol: 'OCEAN', aliases: ['ocean protocol', 'ocean'] },
    
    // Stablecoins
    { name: 'Tether', symbol: 'USDT', aliases: ['tether', 'usdt'] },
    { name: 'USD Coin', symbol: 'USDC', aliases: ['usd coin', 'usdc'] },
    { name: 'Binance USD', symbol: 'BUSD', aliases: ['binance usd', 'busd'] },
    { name: 'Dai', symbol: 'DAI', aliases: ['dai', 'makerdao'] },
    { name: 'TrueUSD', symbol: 'TUSD', aliases: ['trueusd', 'tusd'] },
    { name: 'Pax Dollar', symbol: 'USDP', aliases: ['pax dollar', 'usdp', 'paxos'] },
    
    // Newer/Trending Projects
    { name: 'Sui', symbol: 'SUI', aliases: ['sui'] },
    { name: 'Aptos', symbol: 'APT', aliases: ['aptos', 'apt'] },
    { name: 'Quant', symbol: 'QNT', aliases: ['quant', 'qnt'] },
    { name: 'Lido DAO', symbol: 'LDO', aliases: ['lido dao', 'ldo', 'lido'] },
    { name: 'Maker', symbol: 'MKR', aliases: ['maker', 'mkr', 'makerdao'] },
    { name: 'Compound', symbol: 'COMP', aliases: ['compound', 'comp'] },
    { name: 'Aave', symbol: 'AAVE', aliases: ['aave'] },
    
    // Regional/Specific Markets
    { name: 'PancakeSwap', symbol: 'CAKE', aliases: ['pancakeswap', 'cake'] },
    { name: 'Terra Classic', symbol: 'LUNC', aliases: ['terra classic', 'lunc', 'luna classic'] },
    { name: 'Terra', symbol: 'LUNA', aliases: ['terra', 'luna'] },
    
    // Additional Popular Tokens
    { name: 'Chiliz', symbol: 'CHZ', aliases: ['chiliz', 'chz'] },
    { name: 'Flow', symbol: 'FLOW', aliases: ['flow'] },
    { name: 'Tezos', symbol: 'XTZ', aliases: ['tezos', 'xtz'] },
    { name: 'EOS', symbol: 'EOS', aliases: ['eos'] },
    { name: 'Neo', symbol: 'NEO', aliases: ['neo'] },
    { name: 'IOST', symbol: 'IOST', aliases: ['iost'] },
    { name: 'Zilliqa', symbol: 'ZIL', aliases: ['zilliqa', 'zil'] },
    { name: 'Basic Attention Token', symbol: 'BAT', aliases: ['basic attention token', 'bat', 'brave'] },
    { name: '0x', symbol: 'ZRX', aliases: ['0x', 'zrx'] },
    { name: 'OMG Network', symbol: 'OMG', aliases: ['omg network', 'omg', 'omisego'] },
    
    // Yield Farming and Governance
    { name: 'Curve DAO Token', symbol: 'CRV', aliases: ['curve dao token', 'crv', 'curve'] },
    { name: 'Yearn.finance', symbol: 'YFI', aliases: ['yearn.finance', 'yfi', 'yearn'] },
    { name: 'SushiSwap', symbol: 'SUSHI', aliases: ['sushiswap', 'sushi'] },
    { name: '1inch', symbol: '1INCH', aliases: ['1inch'] },
    
    // Web3 and Infrastructure
    { name: 'Arweave', symbol: 'AR', aliases: ['arweave', 'ar'] },
    { name: 'Theta Network', symbol: 'THETA', aliases: ['theta network', 'theta'] },
    { name: 'Helium', symbol: 'HNT', aliases: ['helium', 'hnt'] },
];

/**
 * Detect cryptocurrency from text using pattern matching
 * @param text The text to analyze
 * @returns Detected cryptocurrency info or null
 */
export function detectCryptocurrency(text: string): { name: string; symbol: string } | null {
    const lowerText = text.toLowerCase();
    
    // Direct symbol matches with word boundaries (highest priority)
    for (const crypto of CRYPTOCURRENCY_LIST) {
        const symbolPattern = new RegExp(`\\b${crypto.symbol.toLowerCase()}\\b`, 'g');
        if (symbolPattern.test(lowerText)) {
            return { name: crypto.name, symbol: crypto.symbol };
        }
    }
    
    // Name and alias matches with word boundaries
    for (const crypto of CRYPTOCURRENCY_LIST) {
        const searchTerms = [crypto.name.toLowerCase(), ...(crypto.aliases || [])];
        
        for (const term of searchTerms) {
            // Use word boundaries to avoid partial matches
            const pattern = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            if (pattern.test(text)) {
                return { name: crypto.name, symbol: crypto.symbol };
            }
        }
    }
    
    return null;
}

/**
 * Get all supported cryptocurrency symbols
 * @returns Array of all supported cryptocurrency symbols
 */
export function getAllCryptocurrencySymbols(): string[] {
    return CRYPTOCURRENCY_LIST.map(crypto => crypto.symbol);
}

/**
 * Get cryptocurrency info by symbol
 * @param symbol The cryptocurrency symbol
 * @returns Cryptocurrency info or null
 */
export function getCryptocurrencyBySymbol(symbol: string): CryptoCurrency | null {
    return CRYPTOCURRENCY_LIST.find(crypto => 
        crypto.symbol.toLowerCase() === symbol.toLowerCase()
    ) || null;
}

/**
 * Search cryptocurrencies by name or alias
 * @param query The search query
 * @returns Array of matching cryptocurrencies
 */
export function searchCryptocurrencies(query: string): CryptoCurrency[] {
    const lowerQuery = query.toLowerCase();
    
    return CRYPTOCURRENCY_LIST.filter(crypto => {
        const searchTerms = [crypto.name.toLowerCase(), crypto.symbol.toLowerCase(), ...(crypto.aliases || [])];
        return searchTerms.some(term => term.includes(lowerQuery));
    });
}

/**
 * Check if a given text mentions multiple cryptocurrencies
 * @param text The text to analyze
 * @returns Array of detected cryptocurrencies
 */
export function detectMultipleCryptocurrencies(text: string): Array<{ name: string; symbol: string }> {
    const detected: Array<{ name: string; symbol: string }> = [];
    const lowerText = text.toLowerCase();
    
    // Track already detected to avoid duplicates
    const detectedSymbols = new Set<string>();
    
    // Check for symbol matches first
    for (const crypto of CRYPTOCURRENCY_LIST) {
        if (lowerText.includes(crypto.symbol.toLowerCase()) && !detectedSymbols.has(crypto.symbol)) {
            detected.push({ name: crypto.name, symbol: crypto.symbol });
            detectedSymbols.add(crypto.symbol);
        }
    }
    
    // Then check for name/alias matches
    for (const crypto of CRYPTOCURRENCY_LIST) {
        if (detectedSymbols.has(crypto.symbol)) continue;
        
        const searchTerms = [crypto.name.toLowerCase(), ...(crypto.aliases || [])];
        
        for (const term of searchTerms) {
            const pattern = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            if (pattern.test(text)) {
                detected.push({ name: crypto.name, symbol: crypto.symbol });
                detectedSymbols.add(crypto.symbol);
                break;
            }
        }
    }
    
    return detected;
}

/**
 * Get cryptocurrency display name (symbol if different from name)
 * @param crypto The cryptocurrency info
 * @returns Display name
 */
export function getCryptocurrencyDisplayName(crypto: { name: string; symbol: string }): string {
    if (crypto.name.toLowerCase() === crypto.symbol.toLowerCase()) {
        return crypto.symbol;
    }
    return `${crypto.name} (${crypto.symbol})`;
} 