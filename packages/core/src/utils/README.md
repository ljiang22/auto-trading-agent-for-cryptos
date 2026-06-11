# Cryptocurrency Detection Utility

This utility provides comprehensive cryptocurrency detection and identification capabilities for the SentiEdge AI system.

## Overview

The `cryptoDetection.ts` utility can identify over 100+ cryptocurrencies from user messages, supporting:

- **Top Market Cap Cryptocurrencies**: Bitcoin, Ethereum, BNB, Solana, XRP, DOGE, etc.
- **Major Altcoins**: TRON, Avalanche, Shiba Inu, Chainlink, Polkadot, etc.
- **DeFi Tokens**: Uniswap, Aave, Compound, Curve, etc.
- **Layer 2 Solutions**: Polygon, Arbitrum, Optimism, etc.
- **Meme Coins**: PEPE, BONK, FLOKI, etc.
- **Stablecoins**: USDT, USDC, DAI, BUSD, etc.
- **AI & Computing Tokens**: Render Token, Fetch.ai, SingularityNET, etc.
- **Gaming & NFT Tokens**: ApeCoin, The Sandbox, Decentraland, etc.
- **Privacy Coins**: Monero, Zcash, Dash, etc.
- **Enterprise Tokens**: VeChain, Hedera, Algorand, etc.

## Functions

### `detectCryptocurrency(text: string)`
Detects a single cryptocurrency from text.

```typescript
const detected = detectCryptocurrency("Give me an analysis on Bitcoin");
// Returns: { name: "Bitcoin", symbol: "BTC" }

const detected2 = detectCryptocurrency("What is the DOGE price?");
// Returns: { name: "Dogecoin", symbol: "DOGE" }
```

### `detectMultipleCryptocurrencies(text: string)`
Detects multiple cryptocurrencies from text.

```typescript
const detected = detectMultipleCryptocurrencies("Compare BTC vs ETH vs DOGE");
// Returns: [
//   { name: "Bitcoin", symbol: "BTC" },
//   { name: "Ethereum", symbol: "ETH" },
//   { name: "Dogecoin", symbol: "DOGE" }
// ]
```

### `searchCryptocurrencies(query: string)`
Search for cryptocurrencies by name or symbol.

```typescript
const results = searchCryptocurrencies("chain");
// Returns all cryptocurrencies containing "chain" in name/symbol/aliases
```

### `getCryptocurrencyBySymbol(symbol: string)`
Get cryptocurrency info by exact symbol match.

```typescript
const crypto = getCryptocurrencyBySymbol("BTC");
// Returns: { name: "Bitcoin", symbol: "BTC", aliases: ["bitcoin", "btc"] }
```

### `getAllCryptocurrencySymbols()`
Get all supported cryptocurrency symbols.

```typescript
const symbols = getAllCryptocurrencySymbols();
// Returns: ["BTC", "ETH", "DOGE", "SOL", ...]
```

### `getCryptocurrencyDisplayName(crypto)`
Get formatted display name for a cryptocurrency.

```typescript
const displayName = getCryptocurrencyDisplayName({ name: "Bitcoin", symbol: "BTC" });
// Returns: "Bitcoin (BTC)"
```

## Supported Detection Patterns

The system detects cryptocurrencies through:

1. **Direct Symbol Matches**: BTC, ETH, DOGE, etc.
2. **Full Name Matches**: Bitcoin, Ethereum, Dogecoin, etc.
3. **Common Aliases**: crypto.com coin -> CRO, stellar lumens -> XLM
4. **Word Boundary Detection**: Prevents partial matches

## Usage in Comprehensive Analysis

The system is integrated into the comprehensive analysis feature:

```typescript
import { detectCryptocurrency } from "./utils/cryptoDetection.ts";

// In generateComprehensiveAnalysis():
const detectedCrypto = detectCryptocurrency(messageText);
if (detectedCrypto) {
    cryptoName = detectedCrypto.name;
    cryptoSymbol = detectedCrypto.symbol;
}
```

## Adding New Cryptocurrencies

To add new cryptocurrencies, simply update the `CRYPTOCURRENCY_LIST` array in `cryptoDetection.ts`:

```typescript
{ 
    name: 'New Coin', 
    symbol: 'NEW', 
    aliases: ['new coin', 'newcoin', 'new'] 
}
```

## Testing

Run the test suite to verify detection capabilities:

```bash
npx tsx packages/core/src/utils/cryptoDetection.test.ts
```

This will test:
- Single cryptocurrency detection
- Multiple cryptocurrency detection  
- Search functionality
- Symbol lookup
- System statistics

## Categories Covered

- ✅ **Top 10 Market Cap** (Bitcoin, Ethereum, etc.)
- ✅ **Major Altcoins** (50+ tokens)
- ✅ **DeFi Ecosystem** (Uniswap, Aave, etc.)
- ✅ **Layer 2 Solutions** (Polygon, Arbitrum, etc.)
- ✅ **Meme Coins** (DOGE, SHIB, PEPE, etc.)
- ✅ **Stablecoins** (USDT, USDC, DAI, etc.)
- ✅ **AI & Computing** (RNDR, FET, AGIX, etc.)
- ✅ **Gaming & NFT** (APE, SAND, MANA, etc.)
- ✅ **Privacy Coins** (XMR, ZEC, DASH, etc.)
- ✅ **Enterprise & Institutional** (VET, HBAR, ALGO, etc.)

The system is designed to be easily extensible and maintainable, providing robust cryptocurrency detection for the SentiEdge AI platform. 