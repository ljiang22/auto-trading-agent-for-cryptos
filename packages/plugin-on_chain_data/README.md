# Data Analysis Plugin

This plugin provides cryptocurrency data analysis capabilities using a function-based approach for data retrieval and AI-powered analysis.

## Architecture

### Data Retrieval Function
The `getDetailedData` function retrieves cryptocurrency data from:
- Past conversation messages (context extraction)
- CoinGlass API (market data, requires `COINGLASS_API_KEY`)

### Analysis Action
The `cryptoAnalysisAction` uses the data function to:
1. Get structured market data
2. Apply technical analysis calculations
3. Send formatted data to AI with specialized templates
4. Generate comprehensive analysis reports

## Usage

### Using the Data Function Directly

```typescript
import { getDetailedData, type DataResponse } from "./actions/get_data.ts";

// Get data without triggering an action
const dataResponse: DataResponse = await getDetailedData(runtime, message, state);

if (dataResponse.success) {
    const { pastMessageData, yahooFinanceData } = dataResponse.data;
    
    // Use the structured data for custom analysis
    console.log(`Retrieved ${yahooFinanceData.length} data points for ${pastMessageData.symbols[0]}`);
}
```

### Using the Analysis Action

```typescript
import { cryptoAnalysisAction } from "./actions/data_analysis.ts";

// The action automatically:
// 1. Calls getDetailedData() function
// 2. Formats data for AI template
// 3. Generates comprehensive analysis
// 4. Returns structured response
```

## Data Flow

```
User Request → Analysis Action → Data Function → CoinGlass API
                     ↓              ↓              ↓
              AI Template ← Formatted Data ← Raw Market Data
                     ↓
              Generated Analysis → User Response
```

## Key Features

### Technical Indicators Calculated
- Moving Averages (SMA 5, 10, 20, 50)
- Volatility (Annualized)
- Price Range Analysis
- Volume Analysis
- Recent Price Action

### AI Template Integration
The data is structured and sent to the AI with:
- **Data Context**: Retrieval status and summary
- **Market Data**: Technical indicators and price action
- **Historical Context**: Past conversation analysis
- **Analysis Request**: User's specific request

### Error Handling
- Graceful fallback when data retrieval fails
- Detailed error messages
- Partial data handling

## Example Template Usage

The AI receives structured data like:

```
## BTC Market Data Analysis (30 days)

### Current Price Action:
- Current Price: $43,250.00
- Period Change: +12.5% (2024-01-01 to 2024-01-30)
- Period High: $45,200.00
- Period Low: $38,100.00

### Technical Indicators:
- 5-day SMA: $42,800.00 (+1.05% from current)
- 10-day SMA: $41,900.00 (+3.22% from current)
- 20-day SMA: $40,500.00 (+6.79% from current)
- Annualized Volatility: 65.2%

### Volume Analysis:
- Average Volume: 25,430,000,000
- Latest Volume: 28,900,000,000
- Volume vs Average: +13.6%
```

This structured approach ensures the AI has precise, calculated data to work with rather than raw numbers, leading to more accurate and actionable analysis.

## Installation

```bash
pnpm install @elizaos-plugins/plugin-crypto_data_analysis
```

## Configuration

### Environment Variables

The plugin requires the following environment variables:

- `COINGLASS_API_KEY`: Your CoinGlass API key for whale alert data (required)
  - Get your API key from [CoinGlass API](https://open-api-v4.coinglass.com/api/hyperliquid/whale-alert)
  - Add it to your `.env` file: `COINGLASS_API_KEY=your_api_key_here`

```bash
# .env file
COINGLASS_API_KEY=your_coinglass_api_key_here
```

## Usage

Import and add the plugin to your Eliza agent:

```typescript
import { cryptoDataAnalysisPlugin } from "@elizaos-plugins/plugin-crypto_data_analysis";

const agent = new AgentRuntime({
    // ... other configuration
    plugins: [
        cryptoDataAnalysisPlugin,
        // ... other plugins
    ],
});
```

## Action Triggers

The cryptocurrency analysis action can be triggered with various keywords and phrases:

### Analysis Types
- `"Analyze Bitcoin's trend using moving averages"`
- `"Detect volume anomalies in Ethereum trading"`
- `"Build an LSTM model to predict DeFi token prices"`
- `"Backtest a Bollinger Bands strategy on Solana"`
- `"Identify current market regime for altcoin season"`
- `"Analyze Cardano's volatility patterns"`
- `"Compare correlation between BNB and Bitcoin"`

### Supported Cryptocurrencies
- **Major Coins**: Bitcoin (BTC), Ethereum (ETH), Binance Coin (BNB), Cardano (ADA), Solana (SOL), XRP, Dogecoin (DOGE)
- **DeFi Tokens**: Uniswap (UNI), Chainlink (LINK), Polygon (MATIC), Avalanche (AVAX)
- **Layer 1s**: Polkadot (DOT), Cosmos (ATOM), Near (NEAR), Algorand (ALGO), Fantom (FTM)
- **Meme Coins**: Shiba Inu (SHIB), Pepe, Floki
- **Gaming/NFT**: ApeCoin (APE), Sandbox (SAND), Decentraland (MANA), Axie Infinity (AXS)
- **Categories**: DeFi, NFT, Meme coins, Layer 1/2, Gaming tokens

### Keywords That Trigger Analysis
- **Cryptocurrencies**: All major crypto symbols and names (see supported list above)
- **Technical Analysis**: `analysis`, `technical`, `chart`, `pattern`
- **Indicators**: `macd`, `rsi`, `bollinger`, `moving average`
- **Market Structure**: `support`, `resistance`, `breakout`, `trend`
- **Volume**: `volume`, `obv`, `vwap`, `accumulation`
- **Machine Learning**: `ml`, `machine learning`, `predict`, `forecast`
- **Strategy**: `backtest`, `strategy`, `trading signals`
- **Whale Alerts**: `whale`, `whales`, `whale alert`, `large transaction`, `big money`, `institutional`, `whale movement`

### Intent Keywords
- `analyze`, `calculate`, `measure`, `detect`, `identify`
- `forecast`, `predict`, `backtest`, `evaluate`, `assess`

## Whale Alert Features

The plugin includes real-time whale alert monitoring powered by the CoinGlass API:

### Whale Alert Capabilities
- **Real-time Transaction Monitoring**: Track large cryptocurrency transactions as they happen
- **Position Analysis**: Monitor long/short positions from major wallets
- **Sentiment Analysis**: Analyze market sentiment based on whale activity
- **Multi-Asset Support**: Cover Bitcoin, Ethereum, and other major cryptocurrencies
- **Statistical Summary**: Get aggregated data on whale movements

### Whale Alert Triggers
- `"Show me the latest whale alerts"`
- `"What are the whales doing with Bitcoin?"`
- `"Any large transactions detected?"`
- `"Whale activity on Ethereum"`
- `"Big money moves today"`
- `"Institutional trading activity"`

### Example Whale Alert Response
```
🐋 Whale Alert Analysis

📊 Summary Statistics:
- Total Transactions: 23
- Total Value: $89.4M
- Average Position Size: $3.89M
- Long/Short Ratio: 1.67
- Top Symbols: BTC, ETH, SOL

🔥 Recent Large Transactions:
1. BTC 🟢 LONG
   - Address: 0x1234...5678
   - Position Size: 156.7 BTC
   - Value: $6.78M
   - Entry Price: $43,250
   - Liquidation Price: $38,120

📈 Market Sentiment: 🟢 BULLISH - Whales are heavily long
```

## Response Format

Each analysis provides a structured response including:

- **Analysis Type**: Category from the eight main types
- **Methodology**: Step-by-step approach and calculations
- **Data Requirements**: Timeframes, data sources, and indicators needed
- **Implementation**: Specific instructions for execution
- **Interpretation**: How to read and understand results
- **Trading Signals**: Actionable buy/sell signals when applicable
- **Risk Factors**: Limitations, considerations, and potential pitfalls

## Examples

### Bitcoin Trend Analysis
```
User: "Analyze Bitcoin's recent trend using moving averages"

Response: 
**₿ BTC Cryptocurrency Data Analysis**

**Analysis Type**: Trend & Momentum Analysis
**Methodology**: Moving Average Analysis
- Simple Moving Average (SMA): 20, 50, 200 periods
- Exponential Moving Average (EMA): 12, 26 periods for MACD
- Golden Cross/Death Cross signals

**Data Requirements**:
- OHLCV data for desired timeframe (1 hour, 4 hours, 1 day)
- Minimum 200 periods for statistical significance

**Current Signals**:
- SMA(20) > SMA(50) > SMA(200): Strong uptrend
- Price above all MAs: Bullish momentum
- Recent golden cross at $43,200 level

**Risk Factors**: False signals in sideways markets, lagging nature of MAs
```

### Ethereum Volatility Analysis
```
User: "Analyze Ethereum's volatility using Bollinger Bands"

Response:
**Ξ ETH Cryptocurrency Data Analysis**

**Analysis Type**: Volatility Analysis
**Current Analysis**:
- ETH trading near upper band at $2,850
- Band width at 8.2% indicating moderate volatility
- Recent squeeze pattern suggests breakout potential

**Trading Signals**:
- Watch for breakout above $2,900 with volume
- Support at middle band around $2,650
```

### DeFi Token ML Analysis
```
User: "Build an LSTM model to predict DeFi token prices"

Response:
**🏦 DeFi Cryptocurrency Data Analysis**

**Analysis Type**: Machine Learning / Predictive Models
**DeFi-Specific Features**:
- Protocol revenue and fees
- Total Value Locked (TVL) data
- Token unlock schedules
- Staking ratios and rewards
- Cross-chain bridge volumes

**Expected Performance**:
- RMSE: ~3-6% for 4-hour predictions
- Better performance during high TVL periods
```

## Integration with Other Plugins

This plugin works well with:
- Market data providers for real-time price/volume feeds
- Portfolio management plugins for position sizing
- Risk management plugins for stop-loss/take-profit levels
- News sentiment plugins for fundamental analysis overlay

## Data Requirements

For optimal performance, ensure access to:
- **OHLCV Data**: Open, High, Low, Close, Volume for multiple timeframes
- **Historical Depth**: Minimum 1 year for most analyses, 2+ years for ML models
- **Data Quality**: Clean, gap-free data from reliable exchanges
- **Real-time Updates**: For live analysis and signal generation

## Development

```bash
# Install dependencies
pnpm install

# Build the plugin
pnpm build

# Run tests
pnpm test

# Development mode with watch
pnpm dev
```

## Contributing

Contributions are welcome! Please feel free to submit issues, feature requests, or pull requests.

## License

MIT License - see LICENSE file for details.
