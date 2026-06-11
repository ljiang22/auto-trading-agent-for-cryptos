# Fear & Greed Index Analysis Plugin

This plugin provides comprehensive Fear & Greed Index analysis for cryptocurrency markets, with support for custom date ranges and interactive chart visualization.

## Features

### 🕰️ Period-Based Analysis
- **Flexible Date Ranges**: Support for both relative periods ("30 days") and absolute date ranges ("from 2025-08-01 to 2025-09-15")
- **Custom Timeframes**: Weeks, months, or specific date periods
- **Historical Analysis**: Access to historical Fear & Greed Index data

### 📊 Interactive Visualization
- **HTML Chart Generation**: Color-coded sentiment levels with interactive features
- **Market Psychology Mapping**: Visual representation of fear/greed transitions
- **Trend Analysis**: Historical context and pattern recognition

### 🎯 Trading Intelligence
- **Sentiment Analysis**: Current market psychology assessment
- **Trading Signals**: Buy/sell/neutral recommendations with confidence scores
- **Risk Assessment**: Volatility and market cycle analysis
- **Strategic Recommendations**: Short, medium, and long-term guidance

## Usage

### Basic Fear & Greed Analysis

```javascript
// Simple timeframe-based analysis
"Analyze the fear and greed index for the last 30 days"
"Show me fear index data for the past 2 weeks"
"What's the current fear and greed reading?"
```

### Period-Based Analysis (New Feature)

```javascript
// Absolute date range analysis
"Analyze fear and greed index from 2025-08-01 to 2025-09-15"
"Give me fear index data between 2025-07-10 and 2025-08-10"
"Show fear and greed trends from 2025-06-01 to 2025-07-01"
```

### Advanced API Usage

```typescript
import { getFearAndGreedIndex } from "./actions/get_data.ts";

// Period-based data retrieval
const periodData = await getFearAndGreedIndex({
    from: "2025-08-01",
    to: "2025-09-15"
});

// Traditional timeframe approach (backward compatible)
const timeframeData = await getFearAndGreedIndex(30); // 30 days

// Using timeframe string
const weeklyData = await getFearAndGreedIndex({
    timeframe: "2 weeks"
});
```

## Parameter Support

### Period Parameters

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `from` | string | Start date (YYYY-MM-DD) | `"2025-08-01"` |
| `to` | string | End date (YYYY-MM-DD) | `"2025-09-15"` |
| `timeframe` | string | Relative period | `"30 days"`, `"2 weeks"`, `"1 month"` |
| `symbol` | string | Cryptocurrency symbol | `"BTC"`, `"ETH"` |

### Period Examples

```json
// Absolute date range
{
  "action": "FEAR_GREED_INDEX_ANALYSIS",
  "parameters": {
    "from": "2025-08-10",
    "to": "2025-09-15",
    "symbol": "BTC"
  }
}

// Relative timeframe
{
  "action": "FEAR_GREED_INDEX_ANALYSIS",
  "parameters": {
    "timeframe": "45 days",
    "symbol": "ETH"
  }
}
```

## Data Flow

1. **Parameter Processing**: Parse period parameters (from/to dates or timeframe)
2. **Data Retrieval**: Fetch Fear & Greed Index data from CoinMarketCap API
3. **Date Filtering**: Filter results to match exact requested date range
4. **Analysis Generation**: Apply sentiment analysis and trading signal algorithms
5. **Chart Creation**: Generate interactive HTML visualization
6. **Report Formatting**: Compile comprehensive analysis report

## Output Format

The plugin returns structured data including:

```typescript
interface AnalysisResult {
  analysis: FearIndexAnalysis;
  chartPath: string;
  timeframe?: number;
  from?: string;
  to?: string;
  totalDays?: number;
  dataPoints: number;
}
```

## Configuration

### Environment Variables

```bash
# Required for Fear & Greed Index data
COINMARKETCAP_API_KEY=your_api_key_here
```

### API Limits

- **CoinMarketCap API**: 500 data points per request
- **Date Range**: Maximum 365 days per analysis
- **Rate Limiting**: Automatic delays between paginated requests

## Analysis Components

### Current Sentiment
- Fear & Greed Index value (0-100)
- Classification (Extreme Fear, Fear, Neutral, Greed, Extreme Greed)
- Market psychology interpretation
- Investment implications

### Trend Analysis
- Direction and strength assessment
- Trend duration calculation
- Volatility measurements
- Historical context comparison

### Trading Signals
- Buy/Sell/Neutral recommendations
- Confidence scoring (0-95%)
- Contrarian analysis approach
- Risk-adjusted guidance

### Recommendations
- **Short-term**: 1-7 day strategies
- **Medium-term**: 1-4 week outlook
- **Long-term**: 1-6 month perspective
- **Risk Assessment**: Volatility and correction probability

## Chart Features

### Interactive Elements
- Hover tooltips with sentiment classification
- Color-coded data points by fear/greed levels
- Responsive design for all screen sizes
- Statistical summary overlay

### Visual Indicators
- **Red Zone**: Extreme Fear (0-25)
- **Orange Zone**: Fear (26-45)
- **Yellow Zone**: Neutral (46-55)
- **Light Green**: Greed (56-75)
- **Dark Green**: Extreme Greed (76-100)

## Examples

### Template Integration

The plugin integrates with task chain systems and supports period parameters in templates:

```typescript
// Task chain example
{
  "task_type": "action",
  "selected_actions": [
    {
      "action": "FEAR_GREED_INDEX_ANALYSIS",
      "parameters": {
        "from": "2025-08-10",
        "to": "2025-09-15",
        "symbol": "BTC"
      }
    }
  ],
  "description": "Analyze Bitcoin sentiment from Aug 10 to Sep 15, 2025"
}
```

### Comprehensive Analysis Example

```typescript
// Example analysis output
{
  "currentSentiment": {
    "value": 23,
    "classification": "Extreme Fear",
    "interpretation": "Market participants are highly risk-averse...",
    "marketImplication": "Potential buying opportunity..."
  },
  "tradingSignals": {
    "buySignal": true,
    "confidence": 87,
    "reasoning": "Extreme fear levels suggest oversold conditions..."
  },
  "chartPath": "saved_data/Charts/Fear&Greed Index Chart BTC 2025-08-10~2025-09-15.html"
}
```

## Dependencies

- `@elizaos/core`: Core framework functionality
- CoinGlass API (`COINGLASS_API_KEY` required): Cryptocurrency price data
- Built-in HTTP client for CoinMarketCap API

## Backward Compatibility

The plugin maintains full backward compatibility with existing timeframe-based queries while adding support for explicit date ranges. All existing integrations continue to work without modification.

---

*For technical support or feature requests, please refer to the main SentiEdge documentation.*
