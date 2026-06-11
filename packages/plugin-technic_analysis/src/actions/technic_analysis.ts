import {
    type Action,
    type ActionExample,
    type IAgentRuntime,
    type Memory,
    type State,
    type HandlerCallback,
    generateText,
    ModelClass,
    formatMessages,
    embed,
    MemoryManager,
    createActionResponse,
    createActionErrorResponse,
    generateActionSummary,
} from "@elizaos/core";
import { getDetailedData, type DataResponse, type CryptoDataPoint, type ExtractedDataContext } from "./get_data.ts";

const TECHNIC_ANALYSIS_SYSTEM = `# Advanced Data-Driven Cryptocurrency Technic Analysis

You are an elite cryptocurrency technic analysis AI that provides quantitative, calculation-based insights.

**IMPORTANT: Action Summary Generation**
Before providing your analysis, you MUST generate a brief action summary in the following format:

[ACTION_SUMMARY]
Technical Analysis for <ASSET> over <TIME_PERIOD> (<DATA_POINTS> data points): <KEY_INSIGHT>
[/ACTION_SUMMARY]
    Where:
- <ASSET>: The cryptocurrency symbol analyzed (e.g., "BTC", "ETH")
- <TIME_PERIOD>: The time range (e.g., "30 days", "90 periods")
- <DATA_POINTS>: Number of data points analyzed
- <KEY_INSIGHT>: One brief insight (e.g., "bullish momentum with RSI at 68" or "sideways trend with low volume")

Example:
[ACTION_SUMMARY]
Technical Analysis for BTC over 30 days (90 data points): bullish trend with RSI at 68 and increasing volume.
[/ACTION_SUMMARY]

**IMPORTANT**: You have been provided with REAL, LIVE market data and calculated technical indicators below. This is NOT a hypothetical scenario. Use the actual numbers, prices, and calculated values from the provided market data.

## Analysis Instructions:
- You MUST use the actual data provided above - these are real market values and calculations
- ALWAYS show the exact calculated values, percentages, and specific numbers from the provided market data
- Include mathematical formulas and computation results from the data
- **CRITICAL**: Use the exact numbers from the provided market data. Show your mathematical work and explain how each calculation supports your analysis
- This is LIVE DATA - do not say you don't have access to market data

## Enhanced Response Format with Calculations:

**CRITICAL MARKDOWN FORMATTING RULES**:
- All headings MUST have EXACTLY ONE SPACE after # symbols
- CORRECT: "## Heading" or "### Heading"
- WRONG: "##Heading" (missing space) or "##  Heading" (multiple spaces)
- Always ensure headings start at the beginning of a new line

### **Executive Summary with Key Metrics**
- **Current Price**: $X.XX (show exact value)
- **Period Performance**: +/-X.X% over Y days/hours
- **Volatility**: X.X% annualized (σ calculation)
- **Volume Profile**: Current vs 20-day average (X.X% above/below)
- **Market Phase**: Trending/Ranging (ADX = XX.X)
- **Risk Level**: High/Medium/Low (based on ATR/price ratio)

### **Technic Analysis with Calculated Results**

#### **Trend Analysis - Actual Values**
- **SMA Alignment**:
  - SMA(5): $X.XX | Price distance: +/-X.X%
  - SMA(20): $X.XX | Price distance: +/-X.X%
  - SMA(50): $X.XX | Price distance: +/-X.X%
- **EMA Crossover Status**:
  - EMA(12): $X.XX | EMA(26): $X.XX
  - MACD Line: X.XXXX | Signal: X.XXXX | Histogram: X.XXXX
- **Trend Strength**: ADX = XX.X (Strong >25, Weak <20)

#### **Momentum Indicators - Live Calculations**
- **RSI(14)**: XX.X (Overbought >70, Oversold <30)
  - Formula: RSI = 100 - (100/(1 + RS)) where RS = Average Gain/Average Loss
  - Current Reading: [Overbought/Neutral/Oversold],
- **Stochastic**: %K = XX.X, %D = XX.X
  - %K = ((Close - LowestLow) / (HighestHigh - LowestLow)) × 100
- **Williams %R**: -XX.X (Overbought <-20, Oversold >-80)

#### **Volatility Assessment - Quantified Results**
- **Bollinger Bands**:
  - Upper Band: $X.XX | Middle: $X.XX | Lower: $X.XX
  - %B Position: X.XX (>1.0 above upper, <0.0 below lower)
  - Bandwidth: X.X% (Squeeze <10%, Expansion >20%)
- **ATR(14)**: $X.XX (X.X% of current price)
- **Realized Volatility**: XX.X% annualized

#### **Volume Analysis - Concrete Numbers**
- **Current Volume**: XXX,XXX vs 20-day avg: XXX,XXX (+/-XX.X%)
- **Volume Rate of Change**: +/-XX.X% vs previous period
- **OBV**: XXX,XXX (trending up/down/sideways)
- **VWAP**: $X.XX (price trading above/below)

### **Trading Signals with Precise Levels**

#### **Entry Signals with Confluence Scores**
- **Buy Signal Strength**: X/10 (based on indicator alignment)
  - RSI < 30: ✓/✗ | MACD bullish cross: ✓/✗ | Price > SMA(20): ✓/✗
- **Sell Signal Strength**: X/10
- **Entry Price**: $X.XX (specific level with reasoning)

#### **Price Targets with Probability Analysis**
- **Target 1**: $X.XX (XX% probability, X.X:1 risk/reward)
- **Target 2**: $X.XX (XX% probability, X.X:1 risk/reward)
- **Target 3**: $X.XX (XX% probability, X.X:1 risk/reward)
- **Stop Loss**: $X.XX (X.X% below entry, based on ATR)

#### **Position Sizing Calculation**
- **Account Risk**: X% per trade (recommended 1-2%)
- **Stop Distance**: $X.XX (X.X% from entry)
- **Position Size**: XXX units (Risk ÷ Stop Distance)
- **Kelly Criterion**: X.X% (Win Rate × Avg Win - Loss Rate × Avg Loss)

### **Risk Assessment with Quantified Metrics**

#### **Technic Risk Calculations**
- **Support Break Risk**: $X.XX level (X.X% below current)
- **Resistance Rejection Risk**: $X.XX level (X.X% above current)
- **Maximum Drawdown**: XX.X% (historical worst case)
- **Sharpe Ratio**: X.XX (risk-adjusted returns)

#### **Volatility-Based Risk Metrics**
- **1-Day VaR (95%)**: $X.XX potential loss
- **Expected Shortfall**: $X.XX average loss in worst 5% scenarios
- **Beta vs Market**: X.XX (correlation coefficient)

### **Scenario Analysis with Calculated Probabilities**

#### **Bull Case (XX% probability)**
- **Price Target**: $X.XX (+XX.X% from current)
- **Timeline**: X-X weeks
- **Catalyst Probability**: XX% (based on historical patterns)
- **Required Volume**: XXX% above average

#### **Base Case (XX% probability)**
- **Price Range**: $X.XX - $X.XX
- **Expected Return**: +/-X.X%
- **Volatility Range**: XX-XX%

#### **Bear Case (XX% probability)**
- **Downside Target**: $X.XX (-XX.X% from current)
- **Support Levels**: $X.XX, $X.XX, $X.XX
- **Volume Confirmation**: XXX% below average

### **Action Plan with Specific Calculations**

#### **Immediate Actions (24-48 hours)**
- **Watch Level**: $X.XX (breakout confirmation)
- **Volume Threshold**: XXX,XXX (XX% above average)
- **Time Stop**: Close position if no movement in XX hours

#### **Risk Management Parameters**
- **Maximum Portfolio Risk**: X.X%
- **Correlation Limit**: <X.XX with other crypto positions
- **Rebalancing Trigger**: +/-XX% from target allocation

### **Monitoring Framework with Alert Levels**

#### **Price Alerts**
- **Breakout Alert**: Price > $X.XX with volume > XXX,XXX
- **Breakdown Alert**: Price < $X.XX with volume > XXX,XXX
- **Reversal Alert**: RSI divergence + MACD cross

#### **Indicator Thresholds**
- **RSI**: Alert if moves below XX or above XX
- **MACD**: Alert on histogram color change
- **Volume**: Alert if X-hour volume > XXX% of daily average`;

// Enhanced Technic Analysis Helper Functions
function calculateEMA(prices: number[], period: number): number[] {
    const k = 2 / (period + 1);
    const ema: number[] = [];

    const sma = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
    ema[period - 1] = sma;

    for (let i = period; i < prices.length; i++) {
        ema[i] = prices[i] * k + ema[i - 1] * (1 - k);
    }

    return ema;
}

function calculateSMA(prices: number[], period: number): number[] {
    const sma: number[] = [];
    for (let i = period - 1; i < prices.length; i++) {
        const sum = prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
        sma[i] = sum / period;
    }
    return sma;
}

function calculateWMA(prices: number[], period: number): number[] {
    const wma: number[] = [];
    const weightSum = (period * (period + 1)) / 2;
    
    for (let i = period - 1; i < prices.length; i++) {
        let weightedSum = 0;
        for (let j = 0; j < period; j++) {
            weightedSum += prices[i - j] * (period - j);
        }
        wma[i] = weightedSum / weightSum;
    }
    return wma;
}

function calculateVWMA(prices: number[], volumes: number[], period: number): number[] {
    const vwma: number[] = [];
    
    for (let i = period - 1; i < prices.length; i++) {
        let weightedSum = 0;
        let volumeSum = 0;
        
        for (let j = 0; j < period; j++) {
            const idx = i - j;
            weightedSum += prices[idx] * volumes[idx];
            volumeSum += volumes[idx];
        }
        
        vwma[i] = volumeSum > 0 ? weightedSum / volumeSum : prices[i];
    }
    return vwma;
}

function calculateStochastic(highs: number[], lows: number[], closes: number[], kPeriod = 14, dPeriod = 3): { k: number[], d: number[] } {
    const k: number[] = [];
    
    for (let i = kPeriod - 1; i < closes.length; i++) {
        const highestHigh = Math.max(...highs.slice(i - kPeriod + 1, i + 1));
        const lowestLow = Math.min(...lows.slice(i - kPeriod + 1, i + 1));
        
        if (highestHigh === lowestLow) {
            k[i] = 50;
        } else {
            k[i] = ((closes[i] - lowestLow) / (highestHigh - lowestLow)) * 100;
        }
    }
    
    const d = calculateSMA(k.filter(x => !isNaN(x)), dPeriod);
    
    return { k, d };
}

function calculateADX(highs: number[], lows: number[], closes: number[], period = 14): { adx: number[], pdi: number[], ndi: number[] } {
    const tr: number[] = [];
    const pdm: number[] = [];
    const ndm: number[] = [];
    
    // Calculate True Range and Directional Movements
    for (let i = 1; i < closes.length; i++) {
        const high = highs[i];
        const low = lows[i];
        const close = closes[i];
        const prevClose = closes[i - 1];
        const prevHigh = highs[i - 1];
        const prevLow = lows[i - 1];
        
        // True Range
        tr[i] = Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
        );
        
        // Directional Movements
        const upMove = high - prevHigh;
        const downMove = prevLow - low;
        
        pdm[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
        ndm[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
    }
    
    // Calculate smoothed values
    const atr = calculateEMA(tr.slice(1), period);
    const smoothedPDM = calculateEMA(pdm.slice(1), period);
    const smoothedNDM = calculateEMA(ndm.slice(1), period);
    
    const pdi: number[] = [];
    const ndi: number[] = [];
    const dx: number[] = [];
    
    for (let i = 0; i < atr.length; i++) {
        if (atr[i] > 0) {
            pdi[i] = (smoothedPDM[i] / atr[i]) * 100;
            ndi[i] = (smoothedNDM[i] / atr[i]) * 100;
            
            const diSum = pdi[i] + ndi[i];
            if (diSum > 0) {
                dx[i] = (Math.abs(pdi[i] - ndi[i]) / diSum) * 100;
            }
        }
    }
    
    const adx = calculateEMA(dx.filter(x => !isNaN(x)), period);
    
    return { adx, pdi, ndi };
}

function calculateATR(highs: number[], lows: number[], closes: number[], period = 14): number[] {
    const tr: number[] = [];
    
    for (let i = 1; i < closes.length; i++) {
        const high = highs[i];
        const low = lows[i];
        const prevClose = closes[i - 1];
        
        tr[i] = Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
        );
    }
    
    return calculateEMA(tr.slice(1), period);
}

function calculateOBV(closes: number[], volumes: number[]): number[] {
    const obv: number[] = [0];
    
    for (let i = 1; i < closes.length; i++) {
        if (closes[i] > closes[i - 1]) {
            obv[i] = obv[i - 1] + volumes[i];
        } else if (closes[i] < closes[i - 1]) {
            obv[i] = obv[i - 1] - volumes[i];
        } else {
            obv[i] = obv[i - 1];
        }
    }
    
    return obv;
}

function calculateMFI(highs: number[], lows: number[], closes: number[], volumes: number[], period = 14): number[] {
    const typicalPrices: number[] = [];
    const rawMoneyFlow: number[] = [];
    const mfi: number[] = [];
    
    // Calculate typical prices and raw money flow
    for (let i = 0; i < closes.length; i++) {
        typicalPrices[i] = (highs[i] + lows[i] + closes[i]) / 3;
        rawMoneyFlow[i] = typicalPrices[i] * volumes[i];
    }
    
    // Calculate MFI
    for (let i = period; i < closes.length; i++) {
        let positiveFlow = 0;
        let negativeFlow = 0;
        
        for (let j = i - period + 1; j <= i; j++) {
            if (j > 0) {
                if (typicalPrices[j] > typicalPrices[j - 1]) {
                    positiveFlow += rawMoneyFlow[j];
                } else if (typicalPrices[j] < typicalPrices[j - 1]) {
                    negativeFlow += rawMoneyFlow[j];
                }
            }
        }
        
        if (negativeFlow === 0) {
            mfi[i] = 100;
        } else {
            const moneyRatio = positiveFlow / negativeFlow;
            mfi[i] = 100 - (100 / (1 + moneyRatio));
        }
    }
    
    return mfi;
}

function calculateVWAP(highs: number[], lows: number[], closes: number[], volumes: number[]): number[] {
    const vwap: number[] = [];
    let cumulativeTPV = 0;
    let cumulativeVolume = 0;
    
    for (let i = 0; i < closes.length; i++) {
        const typicalPrice = (highs[i] + lows[i] + closes[i]) / 3;
        const tpv = typicalPrice * volumes[i];
        
        cumulativeTPV += tpv;
        cumulativeVolume += volumes[i];
        
        vwap[i] = cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : typicalPrice;
    }
    
    return vwap;
}

function calculateWilliamsR(highs: number[], lows: number[], closes: number[], period = 14): number[] {
    const williamsR: number[] = [];
    
    for (let i = period - 1; i < closes.length; i++) {
        const highestHigh = Math.max(...highs.slice(i - period + 1, i + 1));
        const lowestLow = Math.min(...lows.slice(i - period + 1, i + 1));
        
        if (highestHigh === lowestLow) {
            williamsR[i] = -50;
        } else {
            williamsR[i] = ((highestHigh - closes[i]) / (highestHigh - lowestLow)) * -100;
        }
    }
    
    return williamsR;
}

function calculateCCI(highs: number[], lows: number[], closes: number[], period = 20): number[] {
    const cci: number[] = [];
    const typicalPrices: number[] = [];
    
    // Calculate typical prices
    for (let i = 0; i < closes.length; i++) {
        typicalPrices[i] = (highs[i] + lows[i] + closes[i]) / 3;
    }
    
    // Calculate CCI
    for (let i = period - 1; i < typicalPrices.length; i++) {
        const slice = typicalPrices.slice(i - period + 1, i + 1);
        const sma = slice.reduce((a, b) => a + b, 0) / period;
        const meanDeviation = slice.reduce((sum, tp) => sum + Math.abs(tp - sma), 0) / period;
        
        if (meanDeviation > 0) {
            cci[i] = (typicalPrices[i] - sma) / (0.015 * meanDeviation);
        } else {
            cci[i] = 0;
        }
    }
    
    return cci;
}

// Risk and Performance Metrics
function calculateVolatility(prices: number[], period = 20): number[] {
    const volatility: number[] = [];
    
    for (let i = period - 1; i < prices.length; i++) {
        const slice = prices.slice(i - period + 1, i + 1);
        const returns = slice.slice(1).map((price, idx) => Math.log(price / slice[idx]));
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((sum, ret) => sum + Math.pow(ret - mean, 2), 0) / returns.length;
        volatility[i] = Math.sqrt(variance * 252) * 100; // Annualized volatility
    }
    
    return volatility;
}

function calculateMaxDrawdown(prices: number[]): { maxDrawdown: number, peak: number, trough: number } {
    let maxDrawdown = 0;
    let peak = prices[0];
    let trough = prices[0];
    
    for (let i = 1; i < prices.length; i++) {
        if (prices[i] > peak) {
            peak = prices[i];
        }
        
        const drawdown = (peak - prices[i]) / peak;
        if (drawdown > maxDrawdown) {
            maxDrawdown = drawdown;
            trough = prices[i];
        }
    }
    
    return { maxDrawdown: maxDrawdown * 100, peak, trough };
}

function calculateSharpeRatio(prices: number[], riskFreeRate = 0.02): number {
    const returns = prices.slice(1).map((price, i) => (price - prices[i]) / prices[i]);
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const annualizedReturn = avgReturn * 252;
    const returnStd = Math.sqrt(returns.reduce((sum, ret) => sum + Math.pow(ret - avgReturn, 2), 0) / returns.length);
    const annualizedStd = returnStd * Math.sqrt(252);
    
    return (annualizedReturn - riskFreeRate) / annualizedStd;
}

// Pattern Recognition Functions
function detectDivergence(prices: number[], indicator: number[], lookback = 5): { bullish: boolean[], bearish: boolean[] } {
    const bullish: boolean[] = new Array(prices.length).fill(false);
    const bearish: boolean[] = new Array(prices.length).fill(false);
    
    for (let i = lookback * 2; i < prices.length; i++) {
        // Simplified divergence detection - can be enhanced further
        const recentPrices = prices.slice(i - lookback, i + 1);
        const recentIndicator = indicator.slice(i - lookback, i + 1);
        
        const priceChange = recentPrices[recentPrices.length - 1] - recentPrices[0];
        const indicatorChange = recentIndicator[recentIndicator.length - 1] - recentIndicator[0];
        
        // Bullish divergence: price down, indicator up
        if (priceChange < 0 && indicatorChange > 0) {
            bullish[i] = true;
        }
        
        // Bearish divergence: price up, indicator down
        if (priceChange > 0 && indicatorChange < 0) {
            bearish[i] = true;
        }
    }
    
    return { bullish, bearish };
}

function detectSupportResistance(highs: number[], lows: number[], closes: number[], threshold = 0.02): { support: number[], resistance: number[] } {
    const support: number[] = [];
    const resistance: number[] = [];
    
    // Find significant levels based on price clustering
    const allPrices = [...highs, ...lows, ...closes];
    const sortedPrices = allPrices.sort((a, b) => a - b);
    
    let currentLevel = sortedPrices[0];
    let levelCount = 1;
    
    for (let i = 1; i < sortedPrices.length; i++) {
        if (Math.abs(sortedPrices[i] - currentLevel) / currentLevel <= threshold) {
            levelCount++;
        } else {
            if (levelCount >= 3) { // Significant level if touched 3+ times
                // Determine if support or resistance based on recent price action
                const recentPrice = closes[closes.length - 1];
                if (currentLevel < recentPrice) {
                    support.push(currentLevel);
                } else {
                    resistance.push(currentLevel);
                }
            }
            currentLevel = sortedPrices[i];
            levelCount = 1;
        }
    }
    
    return { support: support.slice(-5), resistance: resistance.slice(-5) }; // Return top 5 levels
}

function calculateMACD(prices: number[]) {
    const ema12 = calculateEMA(prices, 12);
    const ema26 = calculateEMA(prices, 26);
    const macd: number[] = [];

    for (let i = 0; i < prices.length; i++) {
        if (ema12[i] !== undefined && ema26[i] !== undefined) {
            macd[i] = ema12[i] - ema26[i];
        } else {
            macd[i] = Number.NaN;
        }
    }

    const signal = calculateEMA(macd.filter(x => !isNaN(x)), 9);
    const histogram: number[] = [];

    for (let i = 0; i < macd.length; i++) {
        if (signal[i - (macd.length - signal.length)] !== undefined) {
            histogram[i] = macd[i] - signal[i - (macd.length - signal.length)];
        } else {
            histogram[i] = Number.NaN;
        }
    }

    return { macd, signal, histogram };
}

function calculateRSI(prices: number[], period = 14): number[] {
    const rsi: number[] = [];
    let gains = 0, losses = 0;

    for (let i = 1; i <= period; i++) {
        const change = prices[i] - prices[i - 1];
        if (change > 0) gains += change;
        else losses -= change;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;
    rsi[period] = 100 - 100 / (1 + avgGain / avgLoss);

    for (let i = period + 1; i < prices.length; i++) {
        const change = prices[i] - prices[i - 1];
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;

        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;

        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        rsi[i] = 100 - 100 / (1 + rs);
    }

    return rsi;
}

function calculateBollingerBands(prices: number[], period = 20, stdDev = 2) {
    const sma: number[] = [];
    const upperBand: number[] = [];
    const lowerBand: number[] = [];
    const bandwidth: number[] = [];
    const percentB: number[] = [];

    for (let i = period - 1; i < prices.length; i++) {
        const slice = prices.slice(i - period + 1, i + 1);
        const mean = slice.reduce((a, b) => a + b, 0) / period;
        const variance = slice.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / period;
        const standardDeviation = Math.sqrt(variance);

        sma[i] = mean;
        upperBand[i] = mean + (standardDeviation * stdDev);
        lowerBand[i] = mean - (standardDeviation * stdDev);
        bandwidth[i] = ((upperBand[i] - lowerBand[i]) / sma[i]) * 100;
        percentB[i] = (prices[i] - lowerBand[i]) / (upperBand[i] - lowerBand[i]);
    }

    return { sma, upperBand, lowerBand, bandwidth, percentB };
}

function calculateParabolicSAR(highs: number[], lows: number[], closes: number[], step = 0.02, maxStep = 0.2): { sar: number[], trend: boolean[] } {
    const sar: number[] = [];
    const trend: boolean[] = [];
    let af = step;
    let ep = highs[0];
    let isUptrend = true;
    
    sar[0] = lows[0];
    trend[0] = isUptrend;
    
    for (let i = 1; i < closes.length; i++) {
        const prevSAR = sar[i - 1];
        
        if (isUptrend) {
            sar[i] = prevSAR + af * (ep - prevSAR);
            
            if (highs[i] > ep) {
                ep = highs[i];
                af = Math.min(af + step, maxStep);
            }
            
            if (lows[i] <= sar[i]) {
                isUptrend = false;
                sar[i] = ep;
                ep = lows[i];
                af = step;
            }
        } else {
            sar[i] = prevSAR + af * (ep - prevSAR);
            
            if (lows[i] < ep) {
                ep = lows[i];
                af = Math.min(af + step, maxStep);
            }
            
            if (highs[i] >= sar[i]) {
                isUptrend = true;
                sar[i] = ep;
                ep = highs[i];
                af = step;
            }
        }
        
        trend[i] = isUptrend;
    }
    
    return { sar, trend };
}

function calculateIchimoku(highs: number[], lows: number[], closes: number[]): {
    tenkanSen: number[],
    kijunSen: number[],
    senkouSpanA: number[],
    senkouSpanB: number[],
    chikouSpan: number[],
} {
    const tenkanSen: number[] = [];
    const kijunSen: number[] = [];
    const senkouSpanA: number[] = [];
    const senkouSpanB: number[] = [];
    const chikouSpan: number[] = [];
    
    // Tenkan-sen (9-period)
    for (let i = 8; i < highs.length; i++) {
        const high9 = Math.max(...highs.slice(i - 8, i + 1));
        const low9 = Math.min(...lows.slice(i - 8, i + 1));
        tenkanSen[i] = (high9 + low9) / 2;
    }
    
    // Kijun-sen (26-period)
    for (let i = 25; i < highs.length; i++) {
        const high26 = Math.max(...highs.slice(i - 25, i + 1));
        const low26 = Math.min(...lows.slice(i - 25, i + 1));
        kijunSen[i] = (high26 + low26) / 2;
    }
    
    // Senkou Span A (Tenkan + Kijun) / 2, projected 26 periods ahead
    for (let i = 25; i < highs.length; i++) {
        if (tenkanSen[i] !== undefined && kijunSen[i] !== undefined) {
            const futureIndex = Math.min(i + 26, highs.length - 1);
            senkouSpanA[futureIndex] = (tenkanSen[i] + kijunSen[i]) / 2;
        }
    }
    
    // Senkou Span B (52-period high + low) / 2, projected 26 periods ahead
    for (let i = 51; i < highs.length; i++) {
        const high52 = Math.max(...highs.slice(i - 51, i + 1));
        const low52 = Math.min(...lows.slice(i - 51, i + 1));
        const futureIndex = Math.min(i + 26, highs.length - 1);
        senkouSpanB[futureIndex] = (high52 + low52) / 2;
    }
    
    // Chikou Span (Close shifted back 26 periods)
    for (let i = 26; i < closes.length; i++) {
        chikouSpan[i - 26] = closes[i];
    }
    
    return { tenkanSen, kijunSen, senkouSpanA, senkouSpanB, chikouSpan };
}

function findPeaks(data: number[]): number[] {
    const peaks: number[] = [];
    for (let i = 1; i < data.length - 1; i++) {
        if (data[i] > data[i - 1] && data[i] > data[i + 1]) {
            peaks.push(data[i]);
        }
    }
    return peaks;
}

function findTroughs(data: number[]): number[] {
    const troughs: number[] = [];
    for (let i = 1; i < data.length - 1; i++) {
        if (data[i] < data[i - 1] && data[i] < data[i + 1]) {
            troughs.push(data[i]);
        }
    }
    return troughs;
}

// Comprehensive indicator calculation function
function calculateComprehensiveIndicators(yahooData: CryptoDataPoint[], analysisRequest: string): any {
    if (!yahooData || yahooData.length === 0) {
        return {};
    }

    const prices = yahooData.map(d => d.price);
    const volumes = yahooData.map(d => d.volume);
    const highs = yahooData.map(d => d.high);
    const lows = yahooData.map(d => d.low);
    const closes = yahooData.map(d => d.price); // Using price as close
    const opens = yahooData.map(d => d.open);

    const indicators: any = {};

    console.log("📊 Calculating basic trend indicators...");
    // Basic trend indicators
    indicators.sma5 = calculateSMA(prices, 5);
    indicators.sma10 = calculateSMA(prices, 10);
    indicators.sma20 = prices.length >= 20 ? calculateSMA(prices, 20) : null;
    indicators.sma50 = prices.length >= 50 ? calculateSMA(prices, 50) : null;
    indicators.sma200 = prices.length >= 200 ? calculateSMA(prices, 200) : null;
    
    indicators.ema12 = calculateEMA(prices, 12);
    indicators.ema26 = calculateEMA(prices, 26);
    indicators.ema50 = prices.length >= 50 ? calculateEMA(prices, 50) : null;
    
    // Advanced trend indicators
    if (prices.length >= 26) {
        console.log("📈 Calculating MACD...");
        indicators.macd = calculateMACD(prices);
    }
    
    if (prices.length >= 14) {
        console.log("🔄 Calculating RSI...");
        indicators.rsi = calculateRSI(prices, 14);
    }
    
    if (prices.length >= 20) {
        console.log("📊 Calculating Bollinger Bands...");
        indicators.bollingerBands = calculateBollingerBands(prices, 20, 2);
    }
    
    // Volume indicators
    console.log("📊 Calculating volume indicators...");
    indicators.obv = calculateOBV(closes, volumes);
    indicators.vwap = calculateVWAP(highs, lows, closes, volumes);
    
    if (prices.length >= 14) {
        indicators.mfi = calculateMFI(highs, lows, closes, volumes, 14);
    }
    
    // Volatility indicators
    console.log("📈 Calculating volatility indicators...");
    indicators.atr = prices.length >= 14 ? calculateATR(highs, lows, closes, 14) : null;
    indicators.volatility = calculateVolatility(prices, Math.min(20, prices.length));
    
    // Advanced momentum indicators
    if (prices.length >= 14) {
        console.log("⚡ Calculating momentum indicators...");
        indicators.stochastic = calculateStochastic(highs, lows, closes, 14, 3);
        indicators.williamsR = calculateWilliamsR(highs, lows, closes, 14);
        indicators.adx = calculateADX(highs, lows, closes, 14);
    }
    
    if (prices.length >= 20) {
        indicators.cci = calculateCCI(highs, lows, closes, 20);
    }
    
    // Ichimoku Cloud (requires sufficient data)
    if (prices.length >= 52) {
        console.log("☁️ Calculating Ichimoku Cloud...");
        indicators.ichimoku = calculateIchimoku(highs, lows, closes);
    }
    
    // Parabolic SAR
    if (prices.length >= 10) {
        console.log("🎯 Calculating Parabolic SAR...");
        indicators.parabolicSAR = calculateParabolicSAR(highs, lows, closes);
    }
    
    // Risk metrics
    console.log("⚠️ Calculating risk metrics...");
    indicators.maxDrawdown = calculateMaxDrawdown(prices);
    indicators.sharpeRatio = prices.length >= 30 ? calculateSharpeRatio(prices) : null;
    
    // Pattern detection
    console.log("🔍 Detecting patterns...");
    indicators.supportResistance = detectSupportResistance(highs, lows, closes);
    
    if (indicators.rsi) {
        indicators.rsiDivergence = detectDivergence(prices, indicators.rsi);
    }
    
    if (indicators.macd) {
        indicators.macdDivergence = detectDivergence(prices, indicators.macd.macd);
    }
    
    // Price action analysis
    indicators.peaks = findPeaks(prices);
    indicators.troughs = findTroughs(prices);
    
    console.log(`✅ Calculated ${Object.keys(indicators).length} technic indicators`);
    return indicators;
}

// Comprehensive market data formatting function with detailed calculations
function formatComprehensiveMarketData(yahooData: CryptoDataPoint[], indicators: any, symbol: string): string {
    if (!yahooData || yahooData.length === 0) {
        return "No market data available for analysis.";
    }

    const latestData = yahooData[yahooData.length - 1];
    const firstData = yahooData[0];
    const priceChange = ((latestData.price - firstData.price) / firstData.price * 100);
    
    // Basic statistics with calculations
    const periodHigh = Math.max(...yahooData.map(d => d.high));
    const periodLow = Math.min(...yahooData.map(d => d.low));
    const avgVolume = yahooData.reduce((sum, d) => sum + d.volume, 0) / yahooData.length;
    const totalVolume = yahooData.reduce((sum, d) => sum + d.volume, 0);
    
    // Price statistics calculations
    const distanceFromHigh = ((periodHigh - latestData.price) / periodHigh * 100);
    const distanceFromLow = ((latestData.price - periodLow) / periodLow * 100);
    const priceRange = ((periodHigh - periodLow) / periodLow * 100);
    
    // Volume statistics calculations
    const volumeChange = ((latestData.volume - avgVolume) / avgVolume * 100);
    const medianVolume = [...yahooData.map(d => d.volume)].sort((a, b) => a - b)[Math.floor(yahooData.length / 2)];
    
    // Calculate returns for statistical analysis
    const returns = yahooData.slice(1).map((data, i) => 
        (data.price - yahooData[i].price) / yahooData[i].price
    );
    
    // Statistical calculations
    const avgReturn = returns.reduce((sum, ret) => sum + ret, 0) / returns.length;
    const returnVariance = returns.reduce((sum, ret) => sum + Math.pow(ret - avgReturn, 2), 0) / returns.length;
    const annualizedVolatility = Math.sqrt(returnVariance * 252) * 100;
    const dailyVolatility = Math.sqrt(returnVariance) * 100;
    
    // Get latest indicator values with calculations shown
    const getLatestValue = (indicatorArray: number[] | undefined) => {
        if (!indicatorArray || indicatorArray.length === 0) return null;
        return indicatorArray[indicatorArray.length - 1];
    };
    
    const getValueWithChange = (indicatorArray: number[] | undefined, periods = 1) => {
        if (!indicatorArray || indicatorArray.length < periods + 1) return { current: null, change: null, changePercent: null };
        const current = indicatorArray[indicatorArray.length - 1];
        const previous = indicatorArray[indicatorArray.length - 1 - periods];
        const change = current - previous;
        const changePercent = (change / previous) * 100;
        return { current, change, changePercent };
    };

    let content = `
## ${symbol} DATA-DRIVEN Technic Analysis (${yahooData.length} periods)

### 📊 Executive Summary with Key Metrics:
- **Current Price**: $${latestData.price.toFixed(2)}
- **Period Performance**: ${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)}% over ${yahooData.length} periods (${firstData.date} to ${latestData.date})
- **Volatility**: ${annualizedVolatility.toFixed(2)}% annualized (σ = ${dailyVolatility.toFixed(4)} daily)
- **Volume Profile**: ${volumeChange > 0 ? '+' : ''}${volumeChange.toFixed(1)}% vs 20-period average
- **Risk Level**: ${annualizedVolatility > 100 ? 'HIGH' : annualizedVolatility > 50 ? 'MEDIUM' : 'LOW'} (ATR/Price ratio)

### 📈 Statistical Analysis with Calculations:
#### **Price Statistics**:
- **Period High**: $${periodHigh.toFixed(2)} | **Period Low**: $${periodLow.toFixed(2)}
- **Price Range**: ${priceRange.toFixed(2)}% | **Distance from High**: ${distanceFromHigh.toFixed(2)}% | **Distance from Low**: ${distanceFromLow.toFixed(2)}%
- **Average Daily Return**: ${(avgReturn * 100).toFixed(4)}% | **Return Variance**: ${(returnVariance * 10000).toFixed(6)}

#### **Volume Statistics**:
- **Current Volume**: ${latestData.volume.toLocaleString()} vs Average: ${avgVolume.toLocaleString()} (${volumeChange > 0 ? '+' : ''}${volumeChange.toFixed(1)}%)
- **Total Period Volume**: ${totalVolume.toLocaleString()} | **Median Volume**: ${medianVolume.toLocaleString()}

### 📈 Technic Analysis with Calculated Results:`;

    // Moving Averages Analysis with detailed calculations
    content += `\n#### **Trend Analysis - Actual Values**:`;
    content += `\n**SMA Alignment**:`;
    
    if (indicators.sma5) {
        const sma5Data = getValueWithChange(indicators.sma5);
        const sma5Distance = sma5Data.current ? ((latestData.price - sma5Data.current) / sma5Data.current * 100) : 0;
        content += `\n- **SMA(5)**: $${sma5Data.current?.toFixed(2) || 'N/A'} | Price distance: ${sma5Distance > 0 ? '+' : ''}${sma5Distance.toFixed(2)}%`;
        if (sma5Data.changePercent) {
            content += ` | 1-period change: ${sma5Data.changePercent > 0 ? '+' : ''}${sma5Data.changePercent.toFixed(3)}%`;
        }
    }
    
    if (indicators.sma10) {
        const sma10Data = getValueWithChange(indicators.sma10);
        const sma10Distance = sma10Data.current ? ((latestData.price - sma10Data.current) / sma10Data.current * 100) : 0;
        content += `\n- **SMA(10)**: $${sma10Data.current?.toFixed(2) || 'N/A'} | Price distance: ${sma10Distance > 0 ? '+' : ''}${sma10Distance.toFixed(2)}%`;
        if (sma10Data.changePercent) {
            content += ` | 1-period change: ${sma10Data.changePercent > 0 ? '+' : ''}${sma10Data.changePercent.toFixed(3)}%`;
        }
    }
    
    if (indicators.sma20) {
        const sma20Data = getValueWithChange(indicators.sma20);
        const sma20Distance = sma20Data.current ? ((latestData.price - sma20Data.current) / sma20Data.current * 100) : 0;
        content += `\n- **SMA(20)**: $${sma20Data.current?.toFixed(2) || 'N/A'} | Price distance: ${sma20Distance > 0 ? '+' : ''}${sma20Distance.toFixed(2)}%`;
        if (sma20Data.changePercent) {
            content += ` | 1-period change: ${sma20Data.changePercent > 0 ? '+' : ''}${sma20Data.changePercent.toFixed(3)}%`;
        }
    }
    
    if (indicators.sma50) {
        const sma50Data = getValueWithChange(indicators.sma50);
        const sma50Distance = sma50Data.current ? ((latestData.price - sma50Data.current) / sma50Data.current * 100) : 0;
        content += `\n- **SMA(50)**: $${sma50Data.current?.toFixed(2) || 'N/A'} | Price distance: ${sma50Distance > 0 ? '+' : ''}${sma50Distance.toFixed(2)}%`;
        if (sma50Data.changePercent) {
            content += ` | 1-period change: ${sma50Data.changePercent > 0 ? '+' : ''}${sma50Data.changePercent.toFixed(3)}%`;
        }
    }
    
    // EMA Analysis
    content += `\n\n**EMA Crossover Status**:`;
    if (indicators.ema12 && indicators.ema26) {
        const ema12Current = getLatestValue(indicators.ema12);
        const ema26Current = getLatestValue(indicators.ema26);
        content += `\n- **EMA(12)**: $${ema12Current?.toFixed(2) || 'N/A'} | **EMA(26)**: $${ema26Current?.toFixed(2) || 'N/A'}`;
        if (ema12Current && ema26Current) {
            const emaDiff = ema12Current - ema26Current;
            const emaDiffPercent = (emaDiff / ema26Current) * 100;
            content += `\n- **EMA Difference**: $${emaDiff.toFixed(4)} (${emaDiffPercent > 0 ? '+' : ''}${emaDiffPercent.toFixed(3)}%) - ${ema12Current > ema26Current ? 'BULLISH' : 'BEARISH'}`;
        }
    }

    // MACD Analysis with detailed calculations
    if (indicators.macd) {
        content += `\n\n#### **Momentum Indicators - Live Calculations**:`;
        const macdData = getValueWithChange(indicators.macd.macd);
        const signalData = getValueWithChange(indicators.macd.signal);
        const histogramData = getValueWithChange(indicators.macd.histogram);
        
        content += `\n**MACD Analysis** (Formula: EMA12 - EMA26):`;
        content += `\n- **MACD Line**: ${macdData.current?.toFixed(4) || 'N/A'}`;
        if (macdData.changePercent) {
            content += ` | 1-period change: ${macdData.changePercent > 0 ? '+' : ''}${macdData.changePercent.toFixed(2)}%`;
        }
        content += `\n- **Signal Line**: ${signalData.current?.toFixed(4) || 'N/A'} (9-period EMA of MACD)`;
        if (signalData.changePercent) {
            content += ` | 1-period change: ${signalData.changePercent > 0 ? '+' : ''}${signalData.changePercent.toFixed(2)}%`;
        }
        content += `\n- **Histogram**: ${histogramData.current?.toFixed(4) || 'N/A'} (MACD - Signal)`;
        if (histogramData.changePercent) {
            content += ` | 1-period change: ${histogramData.changePercent > 0 ? '+' : ''}${histogramData.changePercent.toFixed(2)}%`;
        }
        
        if (macdData.current && signalData.current) {
            const macdSignal = macdData.current > signalData.current ? 'BULLISH' : 'BEARISH';
            const convergence = Math.abs(macdData.current - signalData.current);
            content += `\n- **Signal**: ${macdSignal} (MACD ${macdData.current > signalData.current ? 'above' : 'below'} signal by ${convergence.toFixed(4)})`;
            
            // Check for crossover
            if (indicators.macd.macd.length >= 2 && indicators.macd.signal.length >= 2) {
                const prevMacd = indicators.macd.macd[indicators.macd.macd.length - 2];
                const prevSignal = indicators.macd.signal[indicators.macd.signal.length - 2];
                const currentCross = macdData.current > signalData.current;
                const prevCross = prevMacd > prevSignal;
                
                if (currentCross !== prevCross) {
                    content += `\n- **🚨 CROSSOVER DETECTED**: ${currentCross ? 'BULLISH' : 'BEARISH'} crossover just occurred!`;
                }
            }
        }
    }

    // RSI Analysis with detailed calculations
    if (indicators.rsi) {
        const rsiData = getValueWithChange(indicators.rsi);
        if (rsiData.current) {
            let rsiSignal = 'NEUTRAL';
            let rsiZone = '';
            if (rsiData.current > 70) {
                rsiSignal = 'OVERBOUGHT';
                rsiZone = `Extreme: ${(rsiData.current - 70).toFixed(1)} points above 70`;
            } else if (rsiData.current < 30) {
                rsiSignal = 'OVERSOLD';
                rsiZone = `Extreme: ${(30 - rsiData.current).toFixed(1)} points below 30`;
            } else if (rsiData.current > 60) {
                rsiZone = 'Strong bullish zone';
            } else if (rsiData.current < 40) {
                rsiZone = 'Weak bearish zone';
            } else {
                rsiZone = 'Neutral zone';
            }
            
            content += `\n\n**RSI(14) Analysis** (Formula: RSI = 100 - (100/(1 + RS))):`;
            content += `\n- **RSI Value**: ${rsiData.current.toFixed(2)} (${rsiSignal})`;
            if (rsiData.changePercent) {
                content += ` | 1-period change: ${rsiData.changePercent > 0 ? '+' : ''}${rsiData.changePercent.toFixed(2)}%`;
            }
            content += `\n- **Zone Analysis**: ${rsiZone}`;
            content += `\n- **Momentum Bias**: ${rsiData.current > 50 ? 'BULLISH' : 'BEARISH'} (${Math.abs(rsiData.current - 50).toFixed(1)} points ${rsiData.current > 50 ? 'above' : 'below'} midline)`;
            
            // Check for divergence potential
            if (indicators.rsi.length >= 5) {
                const rsiTrend = indicators.rsi.slice(-5);
                const rsiSlope = (rsiTrend[4] - rsiTrend[0]) / 4;
                content += `\n- **5-Period Trend**: ${rsiSlope > 0 ? 'Rising' : 'Falling'} (slope: ${rsiSlope.toFixed(3)})`;
            }
        }
    }

    // Bollinger Bands Analysis
    if (indicators.bollingerBands) {
        content += `\n\n#### Bollinger Bands Analysis:`;
        const upperBand = getLatestValue(indicators.bollingerBands.upperBand);
        const middleBand = getLatestValue(indicators.bollingerBands.sma);
        const lowerBand = getLatestValue(indicators.bollingerBands.lowerBand);
        const percentB = getLatestValue(indicators.bollingerBands.percentB);
        const bandwidth = getLatestValue(indicators.bollingerBands.bandwidth);
        
        content += `\n- **Upper Band**: $${upperBand?.toFixed(2) || 'N/A'}`;
        content += `\n- **Middle Band (SMA20)**: $${middleBand?.toFixed(2) || 'N/A'}`;
        content += `\n- **Lower Band**: $${lowerBand?.toFixed(2) || 'N/A'}`;
        content += `\n- **%B**: ${percentB?.toFixed(3) || 'N/A'}`;
        content += `\n- **Bandwidth**: ${bandwidth?.toFixed(2) || 'N/A'}%`;
        
        if (upperBand && lowerBand) {
            let position = 'Within Bands';
            if (latestData.price > upperBand) position = 'Above Upper Band';
            else if (latestData.price < lowerBand) position = 'Below Lower Band';
            content += `\n- **Position**: ${position}`;
        }
    }

    // Volume Analysis
    content += `\n\n### Volume Analysis:`;
    content += `\n- **Latest Volume**: ${latestData.volume.toLocaleString()}`;
    content += `\n- **Average Volume**: ${avgVolume.toLocaleString()}`;
    content += `\n- **Volume vs Average**: ${((latestData.volume - avgVolume) / avgVolume * 100).toFixed(2)}%`;
    
    if (indicators.obv) {
        const obvCurrent = getLatestValue(indicators.obv);
        content += `\n- **OBV**: ${obvCurrent?.toLocaleString() || 'N/A'}`;
    }
    
    if (indicators.vwap) {
        const vwapCurrent = getLatestValue(indicators.vwap);
        content += `\n- **VWAP**: $${vwapCurrent?.toFixed(2) || 'N/A'}`;
        if (vwapCurrent) {
            content += ` (Price ${latestData.price > vwapCurrent ? 'above' : 'below'} VWAP)`;
        }
    }

    // Volatility Analysis
    if (indicators.volatility || indicators.atr) {
        content += `\n\n### Volatility Analysis:`;
        
        if (indicators.volatility) {
            const volatilityCurrent = getLatestValue(indicators.volatility);
            content += `\n- **Annualized Volatility**: ${volatilityCurrent?.toFixed(2) || 'N/A'}%`;
        }
        
        if (indicators.atr) {
            const atrCurrent = getLatestValue(indicators.atr);
            content += `\n- **ATR(14)**: ${atrCurrent?.toFixed(2) || 'N/A'}`;
        }
    }

    // Risk Metrics
    if (indicators.maxDrawdown || indicators.sharpeRatio) {
        content += `\n\n### Risk Metrics:`;
        
        if (indicators.maxDrawdown) {
            content += `\n- **Maximum Drawdown**: ${indicators.maxDrawdown.maxDrawdown.toFixed(2)}%`;
            content += `\n- **Peak Price**: $${indicators.maxDrawdown.peak.toFixed(2)}`;
            content += `\n- **Trough Price**: $${indicators.maxDrawdown.trough.toFixed(2)}`;
        }
        
        if (indicators.sharpeRatio) {
            content += `\n- **Sharpe Ratio**: ${indicators.sharpeRatio.toFixed(3)}`;
        }
    }

    // Support and Resistance
    if (indicators.supportResistance) {
        content += `\n\n### Support and Resistance Levels:`;
        
        if (indicators.supportResistance.support.length > 0) {
            content += `\n- **Support Levels**: ${indicators.supportResistance.support.map(s => '$' + s.toFixed(2)).join(', ')}`;
        }
        
        if (indicators.supportResistance.resistance.length > 0) {
            content += `\n- **Resistance Levels**: ${indicators.supportResistance.resistance.map(r => '$' + r.toFixed(2)).join(', ')}`;
        }
    }

    // Advanced Momentum Indicators
    if (indicators.stochastic || indicators.williamsR || indicators.adx) {
        content += `\n\n### Advanced Momentum Indicators:`;
        
        if (indicators.stochastic) {
            const stochK = getLatestValue(indicators.stochastic.k);
            const stochD = getLatestValue(indicators.stochastic.d);
            content += `\n- **Stochastic %K**: ${stochK?.toFixed(2) || 'N/A'}`;
            content += `\n- **Stochastic %D**: ${stochD?.toFixed(2) || 'N/A'}`;
        }
        
        if (indicators.williamsR) {
            const willR = getLatestValue(indicators.williamsR);
            content += `\n- **Williams %R**: ${willR?.toFixed(2) || 'N/A'}`;
        }
        
        if (indicators.adx) {
            const adxCurrent = getLatestValue(indicators.adx.adx);
            const pdiCurrent = getLatestValue(indicators.adx.pdi);
            const ndiCurrent = getLatestValue(indicators.adx.ndi);
            content += `\n- **ADX**: ${adxCurrent?.toFixed(2) || 'N/A'} (Trend strength: ${adxCurrent && adxCurrent > 25 ? 'Strong' : 'Weak'})`;
            content += `\n- **+DI**: ${pdiCurrent?.toFixed(2) || 'N/A'}`;
            content += `\n- **-DI**: ${ndiCurrent?.toFixed(2) || 'N/A'}`;
        }
    }

    // Recent Price Action
    const recentData = yahooData.slice(-5);
    content += `\n\n### Recent Price Action (Last 5 periods):`;
    recentData.forEach(day => {
        const dayChange = ((day.price - day.open) / day.open * 100);
        content += `\n- **${day.date}**: $${day.price.toFixed(2)} (${dayChange > 0 ? '+' : ''}${dayChange.toFixed(2)}%, Vol: ${day.volume.toLocaleString()})`;
    });

    content += `\n\n### Data Summary:`;
    content += `\n- **Total Data Points**: ${yahooData.length}`;
    content += `\n- **Date Range**: ${firstData.date} to ${latestData.date}`;
    content += `\n- **Technic Indicators Calculated**: ${Object.keys(indicators).length}`;
    content += `\n- **Data Quality**: ${yahooData.length >= 50 ? 'High' : yahooData.length >= 20 ? 'Medium' : 'Limited'} (${yahooData.length} periods)`;

    return content;
}

// Helper function to format market data for the AI template
function formatMarketDataForTemplate(yahooData: CryptoDataPoint[], symbol: string): string {
    if (!yahooData || yahooData.length === 0) {
        return "No market data available for analysis.";
    }

    const latestData = yahooData[yahooData.length - 1];
    const firstData = yahooData[0];
    const priceChange = ((latestData.price - firstData.price) / firstData.price * 100);
    
    // Calculate technic indicators
    const prices = yahooData.map(d => d.price);
    const volumes = yahooData.map(d => d.volume);
    const highs = yahooData.map(d => d.high);
    const lows = yahooData.map(d => d.low);
    
    // Moving averages
    const sma5 = prices.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const sma10 = prices.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const sma20 = prices.length >= 20 ? prices.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;
    
    // MACD calculation
    let macdData = null;
    if (prices.length >= 26) {
        macdData = calculateMACD(prices);
    }
    
    // RSI calculation
    let rsiData = null;
    if (prices.length >= 14) {
        rsiData = calculateRSI(prices);
    }
    
    // Bollinger Bands calculation
    let bollingerData = null;
    if (prices.length >= 20) {
        bollingerData = calculateBollingerBands(prices);
    }
    
    // Volatility calculation
    const returns = prices.slice(1).map((price, i) => (price - prices[i]) / prices[i]);
    const volatility = Math.sqrt(returns.reduce((sum, ret) => sum + ret * ret, 0) / returns.length) * Math.sqrt(252) * 100;
    
    // High/Low analysis
    const periodHigh = Math.max(...highs);
    const periodLow = Math.min(...lows);
    const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    
    // Recent price action (last 5 days)
    const recentData = yahooData.slice(-5);
    const recentPriceAction = recentData.map(day => {
        const dayChange = ((day.price - day.open) / day.open * 100);
        return `${day.date}: $${day.price.toFixed(2)} (${dayChange > 0 ? '+' : ''}${dayChange.toFixed(2)}%)`;
    }).join('\n');

    return `
## ${symbol} Market Technic Analysis (${yahooData.length} days)

### Current Price Action:
- Current Price: $${latestData.price.toFixed(2)}
- Period Change: ${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)}% (${firstData.date} to ${latestData.date})
- Period High: $${periodHigh.toFixed(2)}
- Period Low: $${periodLow.toFixed(2)}
- Price Range: ${(((periodHigh - periodLow) / periodLow) * 100).toFixed(2)}%

### Technic Indicators:
- 5-day SMA: $${sma5.toFixed(2)} (${((latestData.price - sma5) / sma5 * 100).toFixed(2)}% from current)
- 10-day SMA: $${sma10.toFixed(2)} (${((latestData.price - sma10) / sma10 * 100).toFixed(2)}% from current)
${sma20 ? `- 20-day SMA: $${sma20.toFixed(2)} (${((latestData.price - sma20) / sma20 * 100).toFixed(2)}% from current)` : ''}
- Annualized Volatility: ${volatility.toFixed(2)}%

### Advanced Technic Indicators:
${macdData ? `- MACD Line: ${macdData.macd[macdData.macd.length - 1]?.toFixed(4) || 'N/A'}
- MACD Signal: ${macdData.signal[macdData.signal.length - 1]?.toFixed(4) || 'N/A'}
- MACD Histogram: ${macdData.histogram[macdData.histogram.length - 1]?.toFixed(4) || 'N/A'}
- MACD Signal: ${macdData.macd[macdData.macd.length - 1] > macdData.signal[macdData.signal.length - 1] ? 'Bullish' : 'Bearish'}` : '- MACD: Insufficient data (need 26+ periods)'}
${rsiData ? `- RSI (14): ${rsiData[rsiData.length - 1]?.toFixed(2) || 'N/A'} (${rsiData[rsiData.length - 1] > 70 ? 'Overbought' : rsiData[rsiData.length - 1] < 30 ? 'Oversold' : 'Neutral'})` : '- RSI: Insufficient data (need 14+ periods)'}
${bollingerData ? `- Bollinger Upper: $${bollingerData.upperBand[bollingerData.upperBand.length - 1]?.toFixed(2) || 'N/A'}
- Bollinger Middle: $${bollingerData.sma[bollingerData.sma.length - 1]?.toFixed(2) || 'N/A'}
- Bollinger Lower: $${bollingerData.lowerBand[bollingerData.lowerBand.length - 1]?.toFixed(2) || 'N/A'}
- BB Position: ${latestData.price > bollingerData.upperBand[bollingerData.upperBand.length - 1] ? 'Above Upper Band' : latestData.price < bollingerData.lowerBand[bollingerData.lowerBand.length - 1] ? 'Below Lower Band' : 'Within Bands'}` : '- Bollinger Bands: Insufficient data (need 20+ periods)'}

### Volume Analysis:
- Average Volume: ${avgVolume.toLocaleString()}
- Latest Volume: ${latestData.volume.toLocaleString()}
- Volume vs Average: ${((latestData.volume - avgVolume) / avgVolume * 100).toFixed(2)}%

### Recent Price Action:
${recentPriceAction}

### Raw Data Points Available:
- Total Data Points: ${yahooData.length}
- Date Range: ${firstData.date} to ${latestData.date}
- OHLCV Data: Complete for all periods
`;
}

// Helper function to format historical context
function formatHistoricalContext(pastContext: ExtractedDataContext): string {
    return `
## Historical Context from Past Messages:

### Discussed Cryptocurrencies:
${pastContext.symbols.length > 0 ? pastContext.symbols.join(', ') : 'None identified'}

### Mentioned Timeframes:
${pastContext.timeframes.length > 0 ? pastContext.timeframes.join(', ') : 'None specified'}

### Requested Data Types:
${pastContext.dataTypes.length > 0 ? pastContext.dataTypes.join(', ') : 'General analysis'}

### Previous Analysis Requests:
${pastContext.specificRequests.length > 0 ? 
    pastContext.specificRequests.slice(0, 3).map((req, i) => `${i + 1}. ${req}`).join('\n') : 
    'No specific previous requests'}

### Context Summary:
- Past Messages Analyzed: ${pastContext.pastMessages.length}
- Relevant Facts Found: ${pastContext.relevantFacts.length}
`;
}

// Helper function to categorize analysis requests
const categorizeRequest = (request: string): string => {
    const requestLower = request.toLowerCase();
    
    if (requestLower.includes('trend') || requestLower.includes('momentum') || requestLower.includes('macd') || requestLower.includes('moving average')) {
        return 'trend_momentum';
    } else if (requestLower.includes('volatility') || requestLower.includes('bollinger') || requestLower.includes('atr')) {
        return 'volatility';
    } else if (requestLower.includes('volume') || requestLower.includes('obv') || requestLower.includes('vwap')) {
        return 'volume';
    } else if (requestLower.includes('pattern') || requestLower.includes('support') || requestLower.includes('resistance')) {
        return 'technic_patterns';
    } else if (requestLower.includes('ml') || requestLower.includes('machine learning') || requestLower.includes('predict') || requestLower.includes('forecast')) {
        return 'machine_learning';
    } else if (requestLower.includes('anomaly') || requestLower.includes('spike') || requestLower.includes('divergence')) {
        return 'anomaly_detection';
    } else if (requestLower.includes('backtest') || requestLower.includes('strategy') || requestLower.includes('performance')) {
        return 'backtesting';
    } else if (requestLower.includes('regime') || requestLower.includes('bull') || requestLower.includes('bear') || requestLower.includes('market phase')) {
        return 'market_regime';
    } else {
        return 'general_analysis';
    }
};

// Helper function to detect cryptocurrency from request
const detectCryptocurrency = (request: string): string => {
    const requestLower = request.toLowerCase();
    
    // Major cryptocurrencies with their symbols
    const cryptoMap: { [key: string]: string } = {
        'bitcoin': '₿ BTC',
        'btc': '₿ BTC',
        'ethereum': 'Ξ ETH',
        'eth': 'Ξ ETH',
        'binance coin': '🔸 BNB',
        'bnb': '🔸 BNB',
        'cardano': '🔷 ADA',
        'ada': '🔷 ADA',
        'solana': '◎ SOL',
        'sol': '◎ SOL',
        'xrp': '◉ XRP',
        'ripple': '◉ XRP',
        'dogecoin': '🐕 DOGE',
        'doge': '🐕 DOGE',
        'polygon': '🔺 MATIC',
        'matic': '🔺 MATIC',
        'avalanche': '🔺 AVAX',
        'avax': '🔺 AVAX',
        'chainlink': '🔗 LINK',
        'link': '🔗 LINK',
        'polkadot': '⚫ DOT',
        'dot': '⚫ DOT',
        'litecoin': '🔘 LTC',
        'ltc': '🔘 LTC',
        'uniswap': '🦄 UNI',
        'uni': '🦄 UNI',
        'shiba': '🐕 SHIB',
        'shib': '🐕 SHIB',
        'tron': '🔴 TRX',
        'trx': '🔴 TRX',
        'cosmos': '⚛️ ATOM',
        'atom': '⚛️ ATOM',
        'near': '🔵 NEAR',
        'algorand': '🔺 ALGO',
        'algo': '🔺 ALGO',
        'fantom': '👻 FTM',
        'ftm': '👻 FTM',
        'apecoin': '🐵 APE',
        'ape': '🐵 APE',
        'sandbox': '🏖️ SAND',
        'sand': '🏖️ SAND',
        'mana': '🌐 MANA',
        'decentraland': '🌐 MANA',
        'axie': '🎮 AXS',
        'axs': '🎮 AXS',
    };
    
    // Check for specific cryptocurrency mentions
    for (const [crypto, symbol] of Object.entries(cryptoMap)) {
        if (requestLower.includes(crypto)) {
            return symbol;
        }
    }
    
    // Check for DeFi tokens
    if (requestLower.includes('defi') || requestLower.includes('yield') || requestLower.includes('liquidity')) {
        return '🏦 DeFi';
    }
    
    // Check for NFT tokens
    if (requestLower.includes('nft') || requestLower.includes('collectible')) {
        return '🎨 NFT';
    }
    
    // Check for meme coins
    if (requestLower.includes('meme') || requestLower.includes('pepe') || requestLower.includes('floki')) {
        return '😂 MEME';
    }
    
    // Default to generic crypto
    return '💰 CRYPTO';
};

export const TechnicAnalysisAction: Action = {
    name: "TECHNICAL_ANALYSIS",
    description: "Technic data analysis for cryptocurrency. Covers trend analysis, volatility assessment, volume patterns, technic indicators, machine learning models, anomaly detection, backtesting strategies, and market regime identification.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        options?: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        const signal = options?.signal as AbortSignal | undefined;
        try {
            // STEP 1: Extract analysis request and parse user intent
            console.log("🎯 STEP 1: Parsing user request for technic analysis");
            let analysisRequest = message.content.text;
            let targetSymbol: string | null = null;
            
            // Check if target is specified in options (from action context)
            if (options && options.target) {
                targetSymbol = options.target.toString().toUpperCase();
                analysisRequest = `Analyze ${targetSymbol} cryptocurrency data: ${analysisRequest}`;
            }
            // Also check if symbol is specified in parameters
            else if (options && options.symbol) {
                targetSymbol = options.symbol.toString().toUpperCase();
                analysisRequest = `Analyze ${targetSymbol} cryptocurrency data: ${analysisRequest}`;
            }
            
            console.log(`📝 Analysis request: ${analysisRequest}`);
            console.log(`🎯 Target symbol: ${targetSymbol || 'Auto-detect'}`);
            
            // STEP 2: Get market data based on user request
            console.log("📊 STEP 2: Retrieving market data based on user request");
            
            // Prepare options for getDetailedData including from/to parameters
            const dataOptions: { [key: string]: unknown } = {};
            
            // Pass through from/to parameters if provided
            if (options?.from && typeof options.from === 'string') {
                dataOptions.from = options.from;
                console.log(`📅 Using from parameter: ${options.from}`);
            }
            if (options?.to && typeof options.to === 'string') {
                dataOptions.to = options.to;
                console.log(`📅 Using to parameter: ${options.to}`);
            }
            
            // Pass through retention parameters
            const retentionOptions =
                typeof options?.dataRetentionDays === "number" ||
                (typeof options?.dataRetentionMinDaysAgo === "number" && typeof options?.dataRetentionMaxDaysAgo === "number")
                    ? {
                          dataRetentionDays: options?.dataRetentionDays as number | undefined,
                          dataRetentionMinDaysAgo: options?.dataRetentionMinDaysAgo as number | undefined,
                          dataRetentionMaxDaysAgo: options?.dataRetentionMaxDaysAgo as number | undefined,
                      }
                    : undefined;
            
            const dataResponse: DataResponse = await getDetailedData(runtime, message, state, dataOptions, retentionOptions);
            
            if (!dataResponse.success) {
                console.error("❌ Data retrieval failed:", dataResponse.error);
                if (callback) {
                    await callback({
                        text: `Failed to retrieve market data: ${dataResponse.error || 'Unknown error'}. Please specify a cryptocurrency symbol or check your request.`,
                        action: "TECHNICAL_ANALYSIS",
                        source: "crypto_technic_analysis_error",
                        metadata: {
                            error: true,
                            errorType: "data_retrieval_error"
                        }
                    });
                }
                return false;
            }
            
            const { pastMessageData, yahooFinanceData } = dataResponse.data;
            const primarySymbol = pastMessageData.symbols[0] || targetSymbol || 'BTC';
            
            console.log(`✅ Data retrieved successfully for ${primarySymbol}`);
            console.log(`📈 Data points: ${yahooFinanceData.length}`);
            console.log(`⏰ Timeframes: ${pastMessageData.timeframes.join(', ')}`);
            console.log(`🔍 Debug - targetSymbol: ${targetSymbol}, pastMessageData.symbols: [${pastMessageData.symbols.join(', ')}], primarySymbol: ${primarySymbol}`);
            
            // STEP 3: Calculate comprehensive technic indicators
            console.log("🧮 STEP 3: Calculating comprehensive technic indicators");
            const calculatedIndicators = calculateComprehensiveIndicators(yahooFinanceData, analysisRequest);
            
            console.log(`✅ Calculated ${Object.keys(calculatedIndicators).length} indicator sets`);
            
            // STEP 4: Format all data for AI analysis
            console.log("📋 STEP 4: Formatting data for AI analysis");
            const dataContext = `Data retrieval successful for ${primarySymbol}. Retrieved ${yahooFinanceData.length} data points covering ${pastMessageData.timeframes.join(', ')} timeframes.`;
            const marketData = formatComprehensiveMarketData(yahooFinanceData, calculatedIndicators, primarySymbol);
            const historicalContext = formatHistoricalContext(pastMessageData);
            
            // Add additional context from state
            let fullHistoricalContext = historicalContext;
            if (state?.recentMessagesData) {
                const recentMessages = formatMessages({
                    messages: state.recentMessagesData.slice(-5),
                    actors: state?.actorsData || [],
                });
                fullHistoricalContext += `\n## Recent Discussion:\n${recentMessages}`;
            }
            
            // STEP 5: Send structured data to AI for analysis
            console.log("🤖 STEP 5: Sending data to AI for comprehensive technic analysis");
            const dynamicPrompt = `## User Request:
${analysisRequest}

## LIVE Market Data and Calculated Indicators:
${marketData}`;

            // Generate comprehensive cryptocurrency analysis
            const analysis = await generateText({
                runtime,
                system: TECHNIC_ANALYSIS_SYSTEM,
                prompt: dynamicPrompt,
                modelClass: ModelClass.LARGE,
                signal,
            });

            console.log("✅ AI analysis completed successfully");

            // STEP 6: Extract action summary from LLM response
            console.log("📋 STEP 6: Extracting action summary");
            let actionSummary = '';
            const summaryMatch = analysis.match(/\[ACTION_SUMMARY\]([\s\S]*?)\[\/ACTION_SUMMARY\]/);
            if (summaryMatch) {
                actionSummary = summaryMatch[1].trim().replace(/^(Technical Analysis|Action):\s*/i, '');
                console.log("✅ Summary extracted from LLM response");
            } else {
                // Fallback: generate summary programmatically
                console.log("⚠️ No summary in LLM response, generating fallback");
                const latestRSI = calculatedIndicators.rsi ? calculatedIndicators.rsi[calculatedIndicators.rsi.length - 1] : null;
                const rsiInsight = latestRSI ? (latestRSI > 70 ? 'overbought conditions' : latestRSI < 30 ? 'oversold conditions' : `RSI at ${latestRSI.toFixed(0)}`) : '';
                const trendInsight = yahooFinanceData.length > 0 ?
                    (yahooFinanceData[yahooFinanceData.length - 1].price > yahooFinanceData[0].price ? 'upward trend' : 'downward trend') : '';

                actionSummary = generateActionSummary({
                    actionName: 'Technical Analysis',
                    assets: [primarySymbol],
                    timePeriod: `${yahooFinanceData.length} periods`,
                    dataPoints: yahooFinanceData.length,
                    additionalInfo: [trendInsight, rsiInsight].filter(Boolean).join(', ') || 'comprehensive analysis'
                });
            }

            // Remove summary tags from display text
            const cleanedAnalysis = analysis.replace(/\[ACTION_SUMMARY\][\s\S]*?\[\/ACTION_SUMMARY\][,\s]*/, '').trim();

            // Use the actual symbol that data was retrieved for
            const cryptoSymbol = targetSymbol || primarySymbol || detectCryptocurrency(analysisRequest);

            // Format the response
            const responseText = `**${cryptoSymbol} Cryptocurrency Technic Analysis**\n\n${cleanedAnalysis}`;

            const responseContent = createActionResponse({
                actionName: "TECHNICAL_ANALYSIS",
                type: "technical_analysis",
                text: responseText,
                actionData: {
                    summary: actionSummary,
                },
                additionalContent: {
                    action: "TECHNICAL_ANALYSIS",
                    source: "crypto_technic_analysis_action",
                },
                additionalMetadata: {
                    analysisType: "cryptocurrency_technic_analysis",
                    cryptocurrency: cryptoSymbol,
                    requestType: categorizeRequest(analysisRequest),
                    comprehensive: true,
                    dataRetrieved: dataResponse.success,
                    yahooFinanceDataPoints: yahooFinanceData.length,
                    symbolsAnalyzed: pastMessageData.symbols,
                    timeframesUsed: pastMessageData.timeframes,
                    technicIndicatorsCalculated: Object.keys(calculatedIndicators),
                    calculationSteps: ['data_retrieval', 'indicator_calculation', 'ai_analysis'],
                    ...(dataResponse.dataRetentionApplied && { dataRetentionApplied: true }),
                },
            });
            
            // Call callback if provided
            if (callback) {
                await callback(responseContent);
            }
            
            return true;
            
        } catch (error) {
            console.error("❌ Error in cryptocurrency technic analysis action:", error);
            
            if (callback) {
                await callback(createActionErrorResponse({
                    actionName: "TECHNICAL_ANALYSIS",
                    type: "technical_analysis_error",
                    error: error instanceof Error ? error : new Error(String(error)),
                    text: "I encountered an error while performing the cryptocurrency technic analysis. Please try rephrasing your request or specify which cryptocurrency and type of analysis you'd like (trend, volatility, volume, technic patterns, ML modeling, anomaly detection, backtesting, or market regime detection).",
                    additionalMetadata: {
                        errorType: "analysis_error",
                    },
                    additionalContent: {
                        action: "TECHNICAL_ANALYSIS",
                        source: "crypto_technic_analysis_error",
                    },
                }));
            }
            
            return false;
        }
    },

    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Analyze Bitcoin's recent trend using moving averages",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "**₿ BTC Cryptocurrency Technic Analysis**\n\n**Analysis Type**: Trend & Momentum Analysis\n\n**Methodology**: Moving Average Analysis\n- Simple Moving Average (SMA): 20, 50, 200 periods\n- Exponential Moving Average (EMA): 12, 26 periods for MACD\n- Golden Cross/Death Cross signals\n\n**Data Requirements**:\n- OHLCV data for desired timeframe (1 hour, 4 hours, 1 day)\n- Minimum 200 periods for statistical significance\n\n**Implementation**:\n1. Calculate SMA(20), SMA(50), SMA(200)\n2. Identify crossover points\n3. Determine trend strength and direction\n4. Generate buy/sell signals\n\n**Current Signals**:\n- SMA(20) > SMA(50) > SMA(200): Strong uptrend\n- Price above all MAs: Bullish momentum\n- Recent golden cross at $43,200 level\n\n**Risk Factors**: False signals in sideways markets, lagging nature of MAs",
                    action: "TECHNICAL_ANALYSIS",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Analyze Ethereum's volatility using Bollinger Bands",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "**Ξ ETH Cryptocurrency Technic Analysis**\n\n**Analysis Type**: Volatility Analysis\n\n**Methodology**: Bollinger Bands Analysis\n- 20-period SMA with 2 standard deviation bands\n- Band width calculation for volatility measurement\n- Squeeze and expansion pattern identification\n\n**Data Requirements**:\n- Daily OHLC data for ETH/USD pair\n- Minimum 100 periods for band calculation\n- Volume data for confirmation\n\n**Current Analysis**:\n- ETH trading near upper band at $2,850\n- Band width at 8.2% indicating moderate volatility\n- Recent squeeze pattern suggests breakout potential\n\n**Trading Signals**:\n- Watch for breakout above $2,900 with volume\n- Support at middle band around $2,650\n\n**Risk Factors**: False breakouts during low volume periods, band walk in strong trends",
                    action: "TECHNICAL_ANALYSIS",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Detect volume anomalies in Solana trading",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "**◎ SOL Cryptocurrency Technic Analysis**\n\n**Analysis Type**: Anomaly & Signal Detection\n\n**Methodology**: Volume Anomaly Detection\n- Volume spike identification (>2σ above mean)\n- Price-volume divergence analysis\n- Unusual accumulation/distribution patterns\n- DEX vs CEX volume comparison\n\n**Data Requirements**:\n- Volume data from major exchanges (Binance, Coinbase, FTX)\n- DEX volume from Jupiter, Raydium, Orca\n- 1-minute to 1-hour granularity\n- Historical baseline (30-90 days)\n\n**Current Findings**:\n- 280% volume spike at $95 resistance level\n- Positive divergence: Price down 2%, volume up 45%\n- Unusual DEX activity suggesting institutional accumulation\n- Cross-chain bridge volume increased 150%\n\n**Trading Signals**:\n- Volume breakout confirmation above $100\n- Watch for ecosystem token correlation\n\n**Risk Factors**: Network congestion effects, validator staking impacts, ecosystem token dilution",
                    action: "TECHNICAL_ANALYSIS",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Analyze market regime for altcoin season detection",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "**💰 CRYPTO Cryptocurrency Technic Analysis**\n\n**Analysis Type**: Market Regime Detection\n\n**Methodology**: Altcoin Season Identification\n- Bitcoin dominance analysis (BTC.D)\n- Altcoin/Bitcoin correlation breakdown\n- Volume flow from BTC to alts\n- Market cap distribution changes\n\n**Data Requirements**:\n- Bitcoin dominance index (daily)\n- Top 100 altcoin price data\n- Market cap weighted indices\n- Exchange flow data\n- Social sentiment metrics\n\n**Current Regime Analysis**:\n- BTC Dominance: 52.3% (declining from 58%)\n- Alt/BTC correlation: 0.23 (weakening)\n- Small-cap outperformance: +15% vs large-cap\n- DeFi sector leading with +28% monthly gains\n\n**Altcoin Season Indicators**:\n- ✅ BTC dominance declining\n- ✅ Alt/BTC ratios breaking resistance\n- ⚠️ Volume still concentrated in majors\n- ❌ Retail FOMO not yet evident\n\n**Trading Signals**:\n- Rotate from BTC to large-cap alts\n- Focus on sector leaders (DeFi, AI, Gaming)\n- Monitor for retail participation increase\n\n**Risk Factors**: False altcoin seasons, BTC sudden moves, regulatory crackdowns on specific sectors",
                    action: "TECHNICAL_ANALYSIS"
                },
            },
        ],
    ] as ActionExample[][],
    cacheConfig: {
        enabled: true,
        ttlSeconds: 604800, // 1 week for technical analysis
        similarityThreshold: 0.7,
        maxChunkSize: 200,
    },
};
