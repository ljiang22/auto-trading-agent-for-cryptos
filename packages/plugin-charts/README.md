# @elizaos-plugins/plugin-charts

A plugin providing Crypto Currency price and trading volume visualization capabilities for ElizaOS agents.

## Description

The Charts plugin enables agents to visualize and analyze Crypto Currency price and trading volume data through interactive charts. It processes data from the `{Crypto Currency}_data.csv` file and CoinGlass to generate comprehensive visualizations that help users understand market trends and patterns.

### Features

1. **Crypto Currency Price Visualization**
   - Generate interactive price history charts
   - Display trading volume alongside price data
   - Support for multiple time ranges (30, 90, 180 days)
   - Key price statistics integrated in visualizations

2. **Chart Generation**
   - Interactive HTML-based charts using Chart.js
   - Browser-friendly visualization format
   - Responsive design for various display sizes
   - Clear data presentation with minimal complexity

3. **Data Processing**
   - Automatic CSV data parsing and extraction
   - Time-based data filtering
   - Statistical calculations on price data
   - Seamless integration with existing data sources

4. **CoinGlass Integration**
   - Market data from CoinGlass API (requires `COINGLASS_API_KEY`)
   - Extended historical data availability
   - Additional market metrics (market cap, 24h change)
   - Comparative analysis with traditional markets
   - Technical indicators calculation from live data

## Installation

This plugin is included in the Eliza package. No additional installation steps are required.

## Usage

```typescript
import { ChartsPlugin } from "@elizaos-plugins/plugin-charts";
```

## Development

1. Clone the repository
2. Install dependencies:

```bash
pnpm install
```

3. Build the plugin:

```bash
pnpm run build
```

## Technical Details

The plugin processes data through the following workflow:
1. Reads data from `packages/Crypto_Data/{Crypto Currency}_data.csv` and/or fetches from CoinGlass API
2. Parses the CSV data or API response to extract price and volume information
3. Filters the data based on the specified time range
4. Generates an HTML file with an interactive chart using Chart.js
5. Saves the chart to the `outputs` directory

## Dependencies

- @elizaos/core: "workspace:*",
- CoinGlass API (`COINGLASS_API_KEY` required)

## API Configuration

This plugin requires a Coinmarketcap API key to function properly. Set your API key as an environment variable:

```
COINMARKETCAP_API_KEY=your_api_key_here
```
## Example
```json
{    
    "conversations": [
      {
        "user": "{{user1}}",
        "content": {
          "text": "Plot a Chart of BTC for the last 90 days"
        }
      },
      {
        "user": "Crypto Trader",
        "content": {
          "text": "GENERATING 90-DAY BTC/USD TECHNICAL CHART

                    Displaying:
                    - 90-day price action (Daily candles)
                    - Volume profile distribution
                    - Key resistance: $94,000, $95,500
                    - Support zones: $88,000, $82,500

                    Technical Indicators:
                    - RSI (14): 74 (overbought)
                    - MACD: Strong bullish momentum
                    - BBands: Upper $94,200, Lower $88,400

                    Key Levels:
                    - Current: $94,197
                    - YTD High: $94,500
                    - Critical support: $88,000

                    Chart Analysis: BTC in strong uptrend testing key resistance at $94K. Volume profile shows major institutional accumulation $88-92K providing strong support. Watch for clean break above $94,500 to confirm continuation to $100K. Risk management crucial at these levels - recommend tight stops below $88K support."
        }
      },
      {
        "user": "Crypto Trader",
        "content": {
          "text": "I've generated a Bitcoin price chart for the last 90 days. The chart includes price history and volume data.(open btc_chart_2025-04-29.html)"
        }
      },
    ],
    [
      {
        "user": "{{user1}}",
        "content": {
          "text": "plot fear of index for the last 200 days"
        }
      },
      {
        "user": "Crypto Trader",
        "content": {
          "text": "Generating 200-day Fear & Greed Index analysis:

Current metrics:
- Index: 71 (Greed)
- BTC: $103,514 (+0.31% 24h)
- 200-day range: $52.1K - $109.1K
- RSI: 75.2 (Overbought)

Key sentiment cycles:
- Q2 2025: Index 45-75, BTC $76K-$109K
- Q1 2025: Index 35-71, BTC $52K-$89K

Creating comprehensive visualization with:
- Daily Fear & Greed values
- BTC price correlation
- Volume profile
- Major sentiment shifts
- Technical overlays

Watch elevated sentiment with BTC testing $104.5K resistance. 200-day analysis shows longest sustained period >70 since Q4 2024. While institutional flows provide support at $95.6K, multiple indicators suggest increased correction risk near term."
        }
      },
      {
        "user": "Crypto Trader",
        "content": {
          "text": "The latest Crypto Fear & Greed Index is **70** (Greed) as of Thu May 08 2025. The current Bitcoin price is $103,514.54.

I've created a visualization showing both the fear index and Bitcoin price for the past 200 days and opened it in your browser. You can find it at:..."
        }
      },
    ]
}
```
