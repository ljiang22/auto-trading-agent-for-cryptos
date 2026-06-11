# @elizaos-plugins/plugin-crypto_sentiscore

A plugin providing sentiment scoring and analysis for cryptocurrency markets for ElizaOS agents.

## Description

The Crypto SentiScore plugin enables agents to analyze, interpret, and respond to market sentiment in cryptocurrency assets. It provides essential actions and evaluators to process and deliver sentiment insights to users about digital assets.

### Features

1. **Cryptocurrency Sentiment Analysis**
   - Process and analyze market sentiment in real-time
   - Categorize sentiment indicators (bullish, bearish, neutral)
   - Identify sentiment intensity levels
   - Track sentiment trends over time

2. **SentiScore Provider**
   - Automated sentiment indexing
   - Contextual market intelligence
   - Asset sentiment tracking
   - Sentiment summarization

3. **Market Data Integration**
   - Multi-exchange data support
   - Social media sentiment correlation
   - Indicator-based sentiment profiles
   - Cross-asset sentiment comparison

## Installation

```bash
pnpm install
pnpm build
```

## Usage

```typescript
import { CryptoSentiScorePlugin } from "@elizaos-plugins/plugin-crypto_sentiscore";
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

## API Configuration

This plugin requires cryptocurrency market API keys to function properly. Set your API keys as environment variables:

```
# Crypto Market Configuration
CRYPTO_API_KEY= # Primary API key
CRYPTO_API_SECRET= # API secret
CRYPTO_ENDPOINT= # API endpoint URL
```

## Dependencies

- @elizaos/core: workspace:*
- crypto-market-client: "workspace:*",
- data-stream: "^1.0.0"

## Example
```json
{
  [
    {
      "user": "{{user1}}",
      "content": {
        "text": "sentiment analysis of btc for the last 10 days"
      }
    },
    {
      "user": "crypto_analyst",
      "content": {
        "text": "Analyzing BTC sentiment metrics over the past 10 days. Looking at social volume, weighted sentiment, and market structure indicators across multiple timeframes to identify key shifts in market psychology and institutional positioning... Let me pull that data for you."
      }
    },
    {
      "user": "crypto_analyst",
      "content": {
        "text": "Sentiment Analysis for BTC from 2025-04-25 to 2025-05-05:

                CRYPTOCURRENCY SENTIMENT ANALYSIS REPORT
                BTC: 2025-04-25 to 2025-05-05

                EXECUTIVE SUMMARY
                Confidence Level: Moderate

                Market Temperature: Moderately Bullish
                - Overall sentiment score of 0.4846 indicates positive but cautious market sentiment
                - Positive/Negative ratio of 9.84 (1.7826/0.1812) suggests strong bullish bias
                - Relatively low volatility (0.4921) indicates stable market consensus

                DETAILED ANALYSIS

                1. SENTIMENT METRICS INTERPRETATION

                Sentiment Distribution:
                - Positive: 1.7826 (Strong)
                - Neutral: 0.9493 (Moderate)
                - Negative: 0.1812 (Very Low)
                - Stability: Trend coefficient of 0.0000 indicates highly stable sentiment

                Fear & Greed Index Score: 65/100 (Greed)
                Calculation based on:
                - High positive/negative ratio
                - Moderate volatility
                - Stable trend

                2. PATTERN ANALYSIS

                Key Observations:
                - Sentiment stability suggests mature market phase
                - Low negative sentiment indicates reduced FUD (Fear, Uncertainty, Doubt)
                - Balanced neutral sentiment suggests rational market behavior

                Market Intelligence Signals:
                Strong:
                - Sustained positive sentiment without excessive euphoria
                - Low negative sentiment without complete absence (healthy skepticism)

                Moderate:
                - Stable trend suggesting consistent market narrative
                - Balanced neutral sentiment indicating analytical approach

                3. RISK ASSESSMENT

                Market Risks:
                - Potential complacency due to low negative sentiment
                - Risk of sudden sentiment shift due to external factors

                Opportunity Signals:
                - Strong positive/negative ratio suggests continued upward pressure
                - Low volatility indicates reduced short-term risk

                4. ACTIONABLE RECOMMENDATIONS

                Short-term (1-3 days):
                - Maintain bullish bias with proper risk management
                - Monitor for sudden increases in negative sentiment
                - Set alerts for volatility spikes above 0.60

                Medium-term (1-2 weeks):
                - Build positions during neutral sentiment periods
                - Use sentiment stability for swing trading opportunities
                - Watch for sentiment divergence from price action

                LIMITATIONS AND CONSIDERATIONS

                Data Constraints:
                - Limited historical context for seasonal comparison
                - Sample size (138 data points) provides moderate statistical confidence
                - Potential geographical and time zone bias in data collection

                CONCLUSION

                Market Positioning: Moderately Bullish
                Confidence Level: Moderate
                Risk Level: Low to Moderate

                The analysis suggests a healthy market environment with rational optimism. The combination of strong positive sentiment, low negative sentiment, and stable trends indicates a mature market phase with potential for continued upward movement. However, traders should maintain vigilance for sudden sentiment shifts and implement appropriate risk management strategies."
      }
    }
  ],
  [
    {
      "user": "{{user1}}",
      "content": {
        "text": "sentiment analysis of apple for the last 10 days"
      }
    },
    {
      "user": "crypto_analyst",
      "content": {
        "text": "Analyzing Apple ($AAPL) sentiment metrics and market psychology indicators. Let me examine institutional flows, options market positioning, and social sentiment data to provide a comprehensive view of current market sentiment..."
      }
    },
    {
      "user": "crypto_analyst",
      "content": {
        "text": "Sorry, I couldn't analyze the sentiment for AAPL. Error: No sentiment data found for symbol "AAPL" across all dates."
      }
    }
  ],
  [
    {
      "user": "{{user1}}",
      "content": {
        "text": "sentiment analysis of btc based on the top 100 tweets"
      }
    },
    {
      "user": "crypto_analyst",
      "content": {
        "text": "Analyzing latest 100 BTC-related X posts sentiment metrics:\n\nBullish signals (75%):\n- SoftBank $900M position driving institutional narrative\n- BlackRock ETF inflows +12,450 BTC weekly\n- Exchange outflows accelerating (-2,450 BTC 8h)\n- BTC holding above $98.7K support\n\nNeutral (15%):\n- RSI overbought at 75.2\n- Funding rates elevated 0.018%\n- Some profit taking near $99.5K\n\nBearish (10%):\n- Fear & Greed Index at 75 (Greed)\n- Early signs of retail FOMO\n- Thin liquidity above $99.5K\n\nOverall sentiment strongly bullish with institutional flows dominating price action. BTC/USD maintaining uptrend with key support at $97.8K. Watch $99.5K resistance for potential short-term consolidation if euphoria peaks."
      }
    },
    {
      "user": "crypto_analyst",
      "content": {
        "text": "CRYPTOCURRENCY SENTIMENT ANALYSIS REPORT: BTC
Date: May 7, 2025
Source: X/Twitter (100 most recent tweets)


EXECUTIVE SUMMARY
Based on the provided sentiment metrics from 100 recent tweets, BTC is currently experiencing a NEUTRAL-BEARISH market sentiment with moderate confidence level (70%).

1. SENTIMENT SCORE BREAKDOWN

Key Metrics Analysis:
- Overall Sentiment: Slightly positive (0.2496)
- Sentiment Distribution:
  * Neutral: 83.9% (dominant)
  * Positive: 33%
  * Negative: 3.5%
- Trend: Bearish (declining -0.0682)
- Volatility: Moderate (0.1890)

2. TEMPORAL PATTERN ANALYSIS

Current Sentiment State:
- The negative trend (-0.0682) coupled with moderate volatility suggests a gradual shift toward bearish sentiment
- High neutral percentage indicates market uncertainty and potential consolidation phase
- Low negative sentiment (3.5%) suggests limited extreme bearish positions

3. MARKET INTELLIGENCE

Fear & Greed Index Score: 45/100 (Slight Fear)
Calculation based on:
- Declining sentiment trend
- High neutral ratio
- Moderate volatility
- Low negative sentiment floor

Signal Strength Assessment:
- STRONG: Market uncertainty (83.9% neutral)
- MODERATE: Bearish trend
- WEAK: Extreme negative sentiment

4. ACTIONABLE INSIGHTS

Short-term Outlook:
- Market appears to be in a cautious phase
- High neutral sentiment suggests possible accumulation period
- Declining trend indicates potential continued downward pressure

Risk Assessment:
- Moderate volatility suggests manageable risk environment
- High neutral sentiment provides some downside protection
- Trend deterioration requires careful position monitoring

5. LIMITATIONS AND CONSIDERATIONS

Data Constraints:
- Limited sample size (100 tweets)
- Short temporal window
- Potential platform-specific bias

Confidence Matrix:
- Sentiment Direction: 70% confidence
- Trend Analysis: 65% confidence
- Market Signals: 60% confidence

RECOMMENDATIONS

1. Trading Stance:
- Maintain cautious positioning
- Consider reduced position sizes
- Watch for sentiment extreme reversals

2. Risk Management:
- Set tight stop losses due to declining trend
- Monitor for sudden sentiment shifts
- Consider hedging strategies

3. Opportunity Watch:
- Look for positive sentiment divergence
- Monitor for decrease in neutral sentiment
- Watch for trend reversal signals

CONCLUSION
The current sentiment landscape for BTC suggests a cautiously bearish outlook with significant market uncertainty. The high neutral sentiment provides some stability, but the declining trend warrants defensive positioning. Traders should maintain vigilance for sentiment shifts while managing risk exposure appropriately.

This analysis is based on current data and should be combined with technical and fundamental analysis for comprehensive trading decisions."
      }
    }
  ]
}
```
