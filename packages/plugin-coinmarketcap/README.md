# @elizaos/plugin-coinmarketcap

A plugin for Eliza that enables cryptocurrency price checking and Fear & Greed Index retrieval using the CoinMarketCap API.

## Features

- Real-time cryptocurrency price checking
- Fear & Greed Index data
- Support for multiple cryptocurrencies (BTC, ETH, SOL, etc.)
- Currency conversion (USD, EUR, etc.)
- Detailed price and market data
- Natural language processing for price queries
- Built-in caching to prevent API rate limit issues
- Direct API integration (no external service dependencies)

## Installation

```bash
npm install @elizaos/plugin-coinmarketcap
```

## Configuration

1. Get your API key from [CoinMarketCap](https://pro.coinmarketcap.com)

2. Set up your environment variables:

```bash
COINMARKETCAP_API_KEY=your_api_key
```

3. Register the plugin in your Eliza configuration:

```typescript
import { coinmarketcapPlugin } from "@elizaos/plugin-coinmarketcap";

// In your Eliza configuration
plugins: [
    coinmarketcapPlugin,
    // ... other plugins
];
```

## Usage

The plugin responds to natural language queries about cryptocurrency prices. Here are some examples:

```plaintext
"What's the current price of Bitcoin?"
"Show me ETH price in USD"
"Get the price of SOL"
"What's the fear index?"
```

### Supported Cryptocurrencies

The plugin supports major cryptocurrencies including:

- Bitcoin (BTC)
- Ethereum (ETH)
- Solana (SOL)
- USD Coin (USDC)
- Tether (USDT)
- Cardano (ADA)
- Ripple (XRP)
- Dogecoin (DOGE)
- Polkadot (DOT)
- And many more...

### Available Actions

#### GET_PRICE_AND_FEAR_INDEX

Fetches the current price of a cryptocurrency along with the Fear & Greed Index.

**Features:**
- Current price and market data
- 24h, 7d, and 30d price changes
- Market cap and volume information
- Circulating and total supply
- Fear & Greed Index with classification
- Built-in caching (30-second TTL)

## API Reference

### Environment Variables

| Variable              | Description                | Required |
| --------------------- | -------------------------- | -------- |
| COINMARKETCAP_API_KEY | Your CoinMarketCap API key | Yes      |

### Types

```typescript
interface PriceData {
    price: number;
    marketCap: number;
    volume24h: number;
    percentChange24h: number;
    percentChange1h: number;
    percentChange7d: number;
    percentChange30d: number;
    fullyDilutedMarketCap: number;
    circulatingSupply: number;
    totalSupply: number;
    maxSupply: number | null;
    lastUpdated: string;
    high52w: number | null;
    low52w: number | null;
    fearIndex: number | null;
    fearIndexClassification: string | null;
    fearIndexUpdateTime: string | null;
}

interface GetPriceContent {
    symbol: string;
    currency: string;
}
```

## Error Handling

The plugin includes comprehensive error handling for:

- Invalid API keys
- Rate limiting
- Network timeouts
- Invalid cryptocurrency symbols
- Unsupported currencies
- Fear & Greed Index API failures

## Caching

The plugin implements intelligent caching to prevent API rate limit issues:
- Price data: 30-second cache TTL
- Fear & Greed Index: 30-second cache TTL
- Request deduplication to prevent simultaneous duplicate requests

## Rate Limits

CoinMarketCap API has different rate limits based on your subscription plan. Please refer to [CoinMarketCap's pricing page](https://coinmarketcap.com/api/pricing/) for detailed information.

## Support

For support, please open an issue in the repository or reach out to the maintainers:

- Discord: 0xspit

## Links

- [CoinMarketCap API Documentation](https://coinmarketcap.com/api/documentation/v1/)

- [GitHub Repository](https://github.com/elizaos/eliza/tree/main/packages/plugin-coinmarketcap)

## Example
```json
{    
    "conversations": [
      {
        "user": "{{user1}}",
        "content": {
          "text": "What's the price and fear index of BTC?"
        }
      },
      {
        "user": "Crypto Trader",
        "content": {
          "text": "BTC/USD trading at $94,196.76 with 24h volume of $23.5B showing +0.06% change. Price action remains range-bound between $94.2K support and $95.6K resistance. RSI cooling off slightly at 69.5 but still elevated. Funding rates neutral at 0.01% suggesting balanced positioning. Key levels: Support cluster at $94.2K-$93.8K, resistance at $95.6K with low volume node at $95.2K. Watching for potential breakout setup above $95.6K targeting $97.2K (R:R 2.1) with invalidation below $93.8K."
        }
      },
      {
        "user": "Crypto Trader",
        "content": {
          "text": "Current price data for BTC:
                - Price: 94196.7581 USD
                - 52w High: 109114.8828 USD
                - 52w Low: 49121.2383 USD
                - Market Cap: 1870820241139.4177 USD
                - Volume (24h): 23585168843.7713 USD
                - Change (1h): -0.6515%
                - Change (24h): 0.0571%
                - Change (7d): -0.6462%
                - Change (30d): 12.9957%
                - Fully Diluted Market Cap: 1978131919648.43 USD
                - Circulating Supply: 19860771
                - Total Supply: 19860771
                - Max Supply: 21000000
                - Last Updated: 2025-05-06T02:17:00.000Z
                - Fear & Greed Index: 53 (Neutral)"
        }
      },
    ]
}
```

