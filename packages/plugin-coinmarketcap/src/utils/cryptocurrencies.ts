/**
 * Comprehensive list of cryptocurrencies for identification
 * Maps common names and mentions to their standard symbols
 */

export interface Asset {
  symbol: string;
  names: string[];
  isStablecoin?: boolean;
  assetType: "crypto";
}

/**
 * Comprehensive list of cryptocurrencies with their common names and mentions
 */
export const ASSETS: Asset[] = [
  {
    symbol: "BTC",
    names: ["bitcoin", "btc", "xbt", "satoshi"],
    assetType: "crypto"
  },
  {
    symbol: "ETH",
    names: ["ethereum", "eth", "ether"],
    assetType: "crypto"
  },
  {
    symbol: "SOL",
    names: ["solana", "sol"],
    assetType: "crypto"
  },
  {
    symbol: "DOGE",
    names: ["dogecoin", "doge"],
    assetType: "crypto"
  },
  {
    symbol: "ADA",
    names: ["cardano", "ada"],
    assetType: "crypto"
  },
  {
    symbol: "XRP",
    names: ["xrp", "ripple"],
    assetType: "crypto"
  },
  {
    symbol: "DOT",
    names: ["polkadot", "dot"],
    assetType: "crypto"
  },
  {
    symbol: "AVAX",
    names: ["avalanche", "avax"],
    assetType: "crypto"
  },
  {
    symbol: "MATIC",
    names: ["polygon", "matic"],
    assetType: "crypto"
  },
  {
    symbol: "LTC",
    names: ["litecoin", "ltc"],
    assetType: "crypto"
  },
  {
    symbol: "LINK",
    names: ["chainlink", "link"],
    assetType: "crypto"
  },
  {
    symbol: "UNI",
    names: ["uniswap", "uni"],
    assetType: "crypto"
  },
  {
    symbol: "SHIB",
    names: ["shiba", "shib", "shiba inu"],
    assetType: "crypto"
  },
  {
    symbol: "TRX",
    names: ["tron", "trx"],
    assetType: "crypto"
  },
  {
    symbol: "XMR",
    names: ["monero", "xmr"],
    assetType: "crypto"
  },
  {
    symbol: "ETC",
    names: ["ethereum classic", "etc"],
    assetType: "crypto"
  },
  {
    symbol: "BCH",
    names: ["bitcoin cash", "bch"],
    assetType: "crypto"
  },
  {
    symbol: "ATOM",
    names: ["cosmos", "atom"],
    assetType: "crypto"
  },
  {
    symbol: "XTZ",
    names: ["tezos", "xtz"],
    assetType: "crypto"
  },
  {
    symbol: "ALGO",
    names: ["algorand", "algo"],
    assetType: "crypto"
  },
  {
    symbol: "VET",
    names: ["vechain", "vet"],
    assetType: "crypto"
  },
  {
    symbol: "FIL",
    names: ["filecoin", "fil"],
    assetType: "crypto"
  },
  {
    symbol: "THETA",
    names: ["theta", "theta network"],
    assetType: "crypto"
  },
  {
    symbol: "ICP",
    names: ["internet computer", "icp"],
    assetType: "crypto"
  },
  {
    symbol: "AAVE",
    names: ["aave"],
    assetType: "crypto"
  },
  {
    symbol: "MKR",
    names: ["maker", "mkr"],
    assetType: "crypto"
  },
  {
    symbol: "COMP",
    names: ["compound", "comp"],
    assetType: "crypto"
  },
  {
    symbol: "SUSHI",
    names: ["sushiswap", "sushi"],
    assetType: "crypto"
  },
  {
    symbol: "CRV",
    names: ["curve", "crv"],
    assetType: "crypto"
  },
  {
    symbol: "YFI",
    names: ["yearn finance", "yfi"],
    assetType: "crypto"
  },
  {
    symbol: "SNX",
    names: ["synthetix", "snx"],
    assetType: "crypto"
  },
  {
    symbol: "1INCH",
    names: ["1inch", "1inch network"],
    assetType: "crypto"
  },
  {
    symbol: "BAL",
    names: ["balancer", "bal"],
    assetType: "crypto"
  },
  {
    symbol: "REN",
    names: ["ren", "republic protocol"],
    assetType: "crypto"
  },
  {
    symbol: "ZRX",
    names: ["0x", "zrx"],
    assetType: "crypto"
  },
  {
    symbol: "KNC",
    names: ["kyber network", "knc"],
    assetType: "crypto"
  },
  {
    symbol: "LRC",
    names: ["loopring", "lrc"],
    assetType: "crypto"
  },
  {
    symbol: "BNB",
    names: ["binance coin", "bnb", "binance"],
    assetType: "crypto"
  },
  {
    symbol: "USDT",
    names: ["tether", "usdt"],
    isStablecoin: true,
    assetType: "crypto"
  },
  {
    symbol: "USDC",
    names: ["usd coin", "usdc"],
    isStablecoin: true,
    assetType: "crypto"
  },
  {
    symbol: "BUSD",
    names: ["binance usd", "busd"],
    isStablecoin: true,
    assetType: "crypto"
  },
  {
    symbol: "DAI",
    names: ["dai", "makerdao"],
    isStablecoin: true,
    assetType: "crypto"
  },
  {
    symbol: "TUSD",
    names: ["trueusd", "tusd"],
    isStablecoin: true,
    assetType: "crypto"
  },
  {
    symbol: "PAX",
    names: ["paxos standard", "pax"],
    isStablecoin: true,
    assetType: "crypto"
  },
  {
    symbol: "GUSD",
    names: ["gemini dollar", "gusd"],
    isStablecoin: true,
    assetType: "crypto"
  }
];

/**
 * Create a mapping for quick lookups
 */
export const ASSET_MENTION_MAP: { [key: string]: string } = {};

// Populate the mention map
ASSETS.forEach(asset => {
  // Add symbol
  ASSET_MENTION_MAP[asset.symbol.toLowerCase()] = asset.symbol;
  
  // Add all names
  asset.names.forEach(name => {
    ASSET_MENTION_MAP[name.toLowerCase()] = asset.symbol;
  });
});

/**
 * Identifies cryptocurrency symbols from text
 * @param text The text to analyze for cryptocurrency mentions
 * @param defaultSymbol The default symbol to return if no match is found
 * @returns The identified cryptocurrency symbol, or default if none found
 */
export function identifyAsset(text: string, defaultSymbol = "BTC"): string {
  if (!text) return defaultSymbol;
  
  const lowerText = text.toLowerCase();
  
  // First, check for direct mentions of symbols or names
  for (const asset of ASSETS) {
    // Check for symbol mentions (case-insensitive but should be separated)
    const symbolPattern = new RegExp(`\\b${asset.symbol.toLowerCase()}\\b`, 'i');
    if (symbolPattern.test(lowerText)) {
      return asset.symbol;
    }
    
    // Check for name mentions
    for (const name of asset.names) {
      if (lowerText.includes(name.toLowerCase())) {
        return asset.symbol;
      }
    }
  }
  
  // If no direct mention found, look for patterns like "price for X" or "price of X"
  const patternPrefixes = [
    "price about",
    "price on",
    "price for",
    "price of",
    "price related to",
    "get price of",
    "get price for",
    "check price of",
    "check price for",
    "what is the price of",
    "what's the price of",
    "how much is",
    "current price of",
    "current price for",
  ];
  
  for (const prefix of patternPrefixes) {
    if (lowerText.includes(prefix)) {
      const afterPrefix = lowerText.split(prefix)[1]?.trim();
      if (afterPrefix) {
        // Extract the first word or potential multi-word asset name
        const words = afterPrefix.split(/\s+/);
        
        // Try multi-word combinations (up to 3 words)
        for (let i = 1; i <= Math.min(3, words.length); i++) {
          const potentialName = words.slice(0, i).join(" ");
          const symbol = ASSET_MENTION_MAP[potentialName];
          if (symbol) {
            return symbol;
          }
        }
      }
    }
  }
  
  return defaultSymbol;
}

// For backward compatibility
export function identifyCryptocurrency(text: string, defaultSymbol = "BTC"): string {
  return identifyAsset(text, defaultSymbol);
} 