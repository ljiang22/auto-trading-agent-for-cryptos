/**
 * Comprehensive list of cryptocurrencies and stocks for identification
 * Maps common names and mentions to their standard symbols
 */

export interface Asset {
  symbol: string;
  names: string[];
  isStablecoin?: boolean;
  assetType: "crypto" | "stock";
}

/**
 * Comprehensive list of cryptocurrencies and stocks with their common names and mentions
 */
export const ASSETS: Asset[] = [
  // Cryptocurrencies
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
    symbol: "XLM",
    names: ["stellar", "xlm", "stellar lumens"],
    assetType: "crypto"
  },
  {
    symbol: "AAVE",
    names: ["aave"],
    assetType: "crypto"
  },
  {
    symbol: "ICP",
    names: ["internet computer", "icp"],
    assetType: "crypto"
  },
  {
    symbol: "EOS",
    names: ["eos"],
    assetType: "crypto"
  },
  {
    symbol: "EGLD",
    names: ["elrond", "egld", "multiversx"],
    assetType: "crypto"
  },
  {
    symbol: "THETA",
    names: ["theta", "theta network"],
    assetType: "crypto"
  },
  {
    symbol: "AXS",
    names: ["axie infinity", "axs"],
    assetType: "crypto"
  },
  {
    symbol: "NEO",
    names: ["neo"],
    assetType: "crypto"
  },
  {
    symbol: "MIOTA",
    names: ["iota", "miota"],
    assetType: "crypto"
  },
  {
    symbol: "CAKE",
    names: ["pancakeswap", "cake"],
    assetType: "crypto"
  },
  {
    symbol: "GRT",
    names: ["the graph", "grt"],
    assetType: "crypto"
  },
  {
    symbol: "SAND",
    names: ["the sandbox", "sand"],
    assetType: "crypto"
  },
  {
    symbol: "MANA",
    names: ["decentraland", "mana"],
    assetType: "crypto"
  },
  {
    symbol: "FTM",
    names: ["fantom", "ftm"],
    assetType: "crypto"
  },
  {
    symbol: "NEAR",
    names: ["near protocol", "near"],
    assetType: "crypto"
  },
  {
    symbol: "CRO",
    names: ["cronos", "cro", "crypto.com", "crypto com"],
    assetType: "crypto"
  },
  {
    symbol: "APE",
    names: ["apecoin", "ape"],
    assetType: "crypto"
  },
  {
    symbol: "HBAR",
    names: ["hedera", "hbar", "hedera hashgraph"],
    assetType: "crypto"
  },
  {
    symbol: "QNT",
    names: ["quant", "qnt"],
    assetType: "crypto"
  },
  // Stablecoins
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
    names: ["dai"],
    isStablecoin: true,
    assetType: "crypto"
  },
  // Exchange tokens
  {
    symbol: "BNB",
    names: ["binance coin", "bnb", "binance"],
    assetType: "crypto"
  },
  {
    symbol: "LEO",
    names: ["unus sed leo", "leo"],
    assetType: "crypto"
  },
  {
    symbol: "OKB",
    names: ["okb", "okx"],
    assetType: "crypto"
  },
  {
    symbol: "KCS",
    names: ["kucoin token", "kcs"],
    assetType: "crypto"
  },

  // Stock Symbols - Major Tech
  {
    symbol: "TSLA",
    names: ["tesla", "tsla"],
    assetType: "stock"
  },
  {
    symbol: "NVDA",
    names: ["nvidia", "nvda"],
    assetType: "stock"
  },
  {
    symbol: "AAPL",
    names: ["apple", "aapl"],
    assetType: "stock"
  },
  {
    symbol: "MSFT",
    names: ["microsoft", "msft"],
    assetType: "stock"
  },
  {
    symbol: "GOOGL",
    names: ["google", "alphabet", "googl"],
    assetType: "stock"
  },
  {
    symbol: "AMZN",
    names: ["amazon", "amzn"],
    assetType: "stock"
  },
  {
    symbol: "META",
    names: ["meta", "facebook", "fb"],
    assetType: "stock"
  },
  {
    symbol: "NFLX",
    names: ["netflix", "nflx"],
    assetType: "stock"
  },
  // Semiconductor Stocks
  {
    symbol: "AMD",
    names: ["amd", "advanced micro devices"],
    assetType: "stock"
  },
  {
    symbol: "INTC",
    names: ["intel", "intc"],
    assetType: "stock"
  },
  {
    symbol: "TSM",
    names: ["tsmc", "taiwan semiconductor", "tsm"],
    assetType: "stock"
  },
  // Other Major Stocks
  {
    symbol: "JPM",
    names: ["jpmorgan", "jp morgan", "jpm"],
    assetType: "stock"
  },
  {
    symbol: "V",
    names: ["visa", "v"],
    assetType: "stock"
  },
  {
    symbol: "MA",
    names: ["mastercard", "ma"],
    assetType: "stock"
  },
  {
    symbol: "DIS",
    names: ["disney", "dis"],
    assetType: "stock"
  },
  {
    symbol: "PFE",
    names: ["pfizer", "pfe"],
    assetType: "stock"
  },
  {
    symbol: "JNJ",
    names: ["johnson & johnson", "jnj"],
    assetType: "stock"
  },
  {
    symbol: "WMT",
    names: ["walmart", "wmt"],
    assetType: "stock"
  },
  {
    symbol: "KO",
    names: ["coca cola", "coke", "ko"],
    assetType: "stock"
  },
  {
    symbol: "PEP",
    names: ["pepsi", "pepsico", "pep"],
    assetType: "stock"
  },
  {
    symbol: "BAC",
    names: ["bank of america", "bac"],
    assetType: "stock"
  },
  {
    symbol: "NKE",
    names: ["nike", "nke"],
    assetType: "stock"
  }
];

// For backward compatibility
export const CRYPTOCURRENCIES = ASSETS.filter(asset => asset.assetType === "crypto");

/**
 * Map to efficiently look up assets by name mention
 */
export const ASSET_MENTION_MAP: Record<string, string> = {};

// Initialize the mention map
ASSETS.forEach(asset => {
  asset.names.forEach(name => {
    ASSET_MENTION_MAP[name.toLowerCase()] = asset.symbol;
  });
});

/**
 * Identifies asset symbols from text
 * @param text The text to analyze for asset mentions
 * @param defaultSymbol The default symbol to return if no match is found
 * @returns The identified asset symbol, or default if none found
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
    
    // Check for name mentions (word-boundary safe to avoid matching substrings)
    for (const name of asset.names) {
      const namePattern = new RegExp(`\\b${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (namePattern.test(lowerText)) {
        return asset.symbol;
      }
    }
  }
  
  // If no direct mention found, look for patterns like "sentiment for X" or "analysis of X"
  const patternPrefixes = [
    "sentiment about",
    "sentiment on",
    "sentiment for",
    "sentiment of",
    "sentiment related to",
    "analyze sentiment of",
    "sentiscore for",
    "sentiscore of",
    "analysis of",
    "analysis for",
  ];
  
  for (const prefix of patternPrefixes) {
    if (lowerText.includes(prefix)) {
      const afterPrefix = lowerText.split(prefix)[1]?.trim();
      if (afterPrefix) {
        // Extract the first word or potential multi-word asset name
        const words = afterPrefix.split(/\s+/);
        
        // Try multi-word combinations (up to 3 words) - for names like "bank of america" or "johnson & johnson"
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