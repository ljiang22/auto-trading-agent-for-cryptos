import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type {
    Action,
    IAgentRuntime,
    Memory,
    ActionExample,
    State,
    HandlerCallback
} from "@elizaos/core";
import { createActionResponse, createActionErrorResponse, generateActionSummary, buildChartProxyUrl } from "@elizaos/core";
import { getFearAndGreedIndex } from "./get_data.js";
import { httpClient } from "@elizaos/core";

// Convert exec to Promise-based
const execPromise = promisify(exec);

/**
 * Helper function to get full cryptocurrency name from code
 */
function getCryptoFullName(cryptoCode: string): string {
    const cryptoNames: { [key: string]: string } = {
        'BTC': 'Bitcoin',
        'ETH': 'Ethereum',
        'USDT': 'Tether',
        'USDC': 'USD Coin',
        'SOL': 'Solana',
        'XRP': 'XRP',
        'BNB': 'BNB',
        'DOGE': 'Dogecoin',
        'ADA': 'Cardano',
        'TRX': 'TRON',
        'AVAX': 'Avalanche',
        'SHIB': 'Shiba Inu',
        'MATIC': 'Polygon',
        'LTC': 'Litecoin',
        'UNI': 'Uniswap',
        'LINK': 'Chainlink',
        'BCH': 'Bitcoin Cash',
        'XLM': 'Stellar',
        'ATOM': 'Cosmos',
        'DOT': 'Polkadot'
    };
    
    return cryptoNames[cryptoCode.toUpperCase()] || cryptoCode.toUpperCase();
}

const API_KEY = process.env.COINMARKETCAP_API_KEY;

if (!API_KEY) {
    console.warn('COINMARKETCAP_API_KEY is not set. Fear and greed index analysis may not be available.');
}

interface FearIndexDataPoint {
    timestamp: string;
    value: number;
    value_classification: string;
}

interface FearIndexAnalysis {
    currentSentiment: {
        value: number;
        classification: string;
        interpretation: string;
        marketImplication: string;
    };
    trend: {
        direction: string;
        strength: string;
        duration: number;
        volatility: number;
    };
    historicalContext: {
        averageValue: number;
        extremeReadings: {
            fearCount: number;
            greedCount: number;
        };
        marketCycles: string[];
    };
    tradingSignals: {
        buySignal: boolean;
        sellSignal: boolean;
        neutralSignal: boolean;
        confidence: number;
        reasoning: string;
    };
    recommendations: {
        shortTerm: string;
        mediumTerm: string;
        longTerm: string;
        riskLevel: string;
    };
}

// Chart generation functions

/**
 * Generate HTML for Fear & Greed Index chart visualization
 */
function generateFearGreedChartHTML(data: FearIndexDataPoint[], timeRange: number): string {
    // Sort data chronologically and limit to timeRange
    const sortedData = data
        .sort((a, b) => Number.parseInt(a.timestamp) - Number.parseInt(b.timestamp))
        .slice(-timeRange);
    
    const dates = sortedData.map(point => {
        const date = new Date(Number.parseInt(point.timestamp) * 1000);
        return `"${date.toISOString().split('T')[0]}"`;
    }).join(',');
    
    const values = sortedData.map(point => point.value).join(',');
    const classifications = sortedData.map(point => `"${point.value_classification}"`).join(',');
    
    // Calculate statistics
    const currentValue = sortedData[sortedData.length - 1]?.value || 0;
    const startValue = sortedData[0]?.value || 0;
    const maxValue = Math.max(...sortedData.map(d => d.value));
    const minValue = Math.min(...sortedData.map(d => d.value));
    const avgValue = sortedData.reduce((sum, d) => sum + d.value, 0) / sortedData.length;
    
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fear & Greed Index Chart</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js" crossorigin="anonymous" onerror="document.body.innerHTML='<p style=\\'font-family:sans-serif;padding:1rem\\'>Chart library failed to load. Check network or try opening this page in a new tab.</p>'"></script>
  <style>
    body { 
      font-family: Arial, sans-serif; 
      margin: 20px; 
      background-color: #f8f9fa;
    }
    .chart-container { 
      position: relative; 
      height: 70vh; 
      width: 90vw; 
      margin: auto; 
      background-color: white;
      border-radius: 10px;
      padding: 20px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }
    h1 { 
      text-align: center; 
      color: #333; 
      margin-bottom: 10px;
    }
    .subtitle {
      text-align: center;
      color: #666;
      margin-bottom: 30px;
      font-size: 14px;
    }
    .summary { 
      margin: 20px 0; 
      padding: 20px; 
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      border-radius: 10px; 
      color: white;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 15px;
    }
    .summary p { 
      margin: 8px 0; 
      font-weight: 500;
    }
    .summary strong {
      font-weight: 700;
    }
    .fear-levels {
      display: flex;
      justify-content: space-between;
      margin: 20px 0;
      padding: 15px;
      background-color: #fff;
      border-radius: 8px;
      border: 1px solid #e0e0e0;
    }
    .fear-level {
      text-align: center;
      padding: 10px;
      border-radius: 5px;
      color: white;
      font-weight: bold;
      flex: 1;
      margin: 0 2px;
    }
    .extreme-fear { background-color: #d32f2f; }
    .fear { background-color: #f57c00; }
    .neutral { background-color: #fbc02d; color: #333; }
    .greed { background-color: #689f38; }
    .extreme-greed { background-color: #388e3c; }
    body.compact-view {
      margin: 0;
      padding: 0;
      background: transparent;
    }
    body.compact-view .chart-container {
      width: 100%;
      height: clamp(200px, 40vw, 520px);
      min-height: 200px;
      max-height: 540px;
      margin: 0;
      padding: 0;
      background: transparent;
      box-shadow: none;
      border-radius: 0;
    }
    body.compact-view h1,
    body.compact-view .subtitle,
    body.compact-view .fear-levels,
    body.compact-view .summary {
      display: none;
    }
    body.compact-view canvas {
      height: 100% !important;
      min-height: 200px;
      max-height: none !important;
    }
  </style>
</head>
<body>
  <script>
    (function () {
      const params = new URLSearchParams(window.location.search);
      const viewMode = params.get('view');
      const isCompact = viewMode === 'compact';
      const body = document.body;
      const root = document.documentElement;
      if (isCompact) {
        body.classList.add('compact-view');
        root.classList.add('compact-view');
      } else {
        body.classList.add('full-view');
        root.classList.add('full-view');
      }
    })();
  </script>
  <h1>Cryptocurrency Fear & Greed Index</h1>
  <div class="subtitle">Market Sentiment Analysis (${timeRange} Days)</div>
  
  <div class="fear-levels">
    <div class="fear-level extreme-fear">Extreme Fear<br>0-25</div>
    <div class="fear-level fear">Fear<br>26-45</div>
    <div class="fear-level neutral">Neutral<br>46-55</div>
    <div class="fear-level greed">Greed<br>56-75</div>
    <div class="fear-level extreme-greed">Extreme Greed<br>76-100</div>
  </div>
  
  <div class="summary">
    <div>
      <p><strong>Current Value:</strong> ${currentValue} (${sortedData[sortedData.length - 1]?.value_classification || 'N/A'})</p>
      <p><strong>Period Start:</strong> ${startValue} (${sortedData[0]?.value_classification || 'N/A'})</p>
    </div>
    <div>
      <p><strong>Highest Value:</strong> ${maxValue}</p>
      <p><strong>Lowest Value:</strong> ${minValue}</p>
    </div>
    <div>
      <p><strong>Average Value:</strong> ${avgValue.toFixed(1)}</p>
      <p><strong>Data Points:</strong> ${sortedData.length} days</p>
    </div>
  </div>
  
  <div class="chart-container">
    <canvas id="fearGreedChart"></canvas>
  </div>

  <script>
    const canvasElement = document.getElementById('fearGreedChart');
    const chartContainer = document.querySelector('.chart-container');
    const isCompactView = document.body.classList.contains('compact-view');

    function computeDesiredChartHeight() {
      let parentHeight = 0;
      try {
        parentHeight = window.parent?.innerHeight || 0;
      } catch (_error) {
        parentHeight = 0;
      }
      const baseMultiplier = isCompactView ? 0.35 : 0.7;
      const baseHeight = parentHeight > 0 ? parentHeight * baseMultiplier : 0;
      const fallbackHeight = isCompactView ? 300 : 600;
      const minHeight = isCompactView ? 150 : 300;
      return Math.max(minHeight, Math.round(baseHeight || fallbackHeight));
    }

    function applyChartHeight(height) {
      if (chartContainer) {
        chartContainer.style.height = \`\${height}px\`;
        chartContainer.style.minHeight = \`\${height}px\`;
      }
      if (canvasElement) {
        canvasElement.style.height = '100%';
        canvasElement.style.minHeight = \`\${height}px\`;
        canvasElement.height = height;
      }
    }

    function notifyParentHeight(height) {
      try {
        const doc = document.documentElement;
        const body = document.body;
        const computedHeight = Math.max(height, doc.scrollHeight, body.scrollHeight);
        window.parent?.postMessage({ type: 'chartHeight', height: computedHeight }, '*');
      } catch (_error) {
        // Ignore cross-origin issues
      }
    }

    function refreshChartHeight() {
      const targetHeight = computeDesiredChartHeight();
      applyChartHeight(targetHeight);
      return targetHeight;
    }

    let desiredChartHeight = refreshChartHeight();
    notifyParentHeight(desiredChartHeight);

    const ctx = canvasElement.getContext('2d');
    
    const dates = [${dates}];
    const values = [${values}];
    const classifications = [${classifications}];
    
    // Create background color array based on values
    const backgroundColors = values.map(value => {
      if (value <= 25) return 'rgba(211, 47, 47, 0.1)';
      if (value <= 45) return 'rgba(245, 124, 0, 0.1)';
      if (value <= 55) return 'rgba(251, 192, 45, 0.1)';
      if (value <= 75) return 'rgba(104, 159, 56, 0.1)';
      return 'rgba(56, 142, 60, 0.1)';
    });
    
    const borderColors = values.map(value => {
      if (value <= 25) return '#d32f2f';
      if (value <= 45) return '#f57c00';
      if (value <= 55) return '#fbc02d';
      if (value <= 75) return '#689f38';
      return '#388e3c';
    });
    
    const fearGreedChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: dates,
        datasets: [
          {
            label: 'Fear & Greed Index',
            data: values,
            borderColor: '#6366f1',
            backgroundColor: 'rgba(99, 102, 241, 0.1)',
            borderWidth: 3,
            tension: 0.3,
            fill: true,
            pointBackgroundColor: borderColors,
            pointBorderColor: borderColors,
            pointRadius: 5,
            pointHoverRadius: 8
          }
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: {
              font: {
                size: 14,
                weight: 'bold'
              }
            }
          },
          tooltip: {
            callbacks: {
              afterLabel: function(context) {
                const classification = classifications[context.dataIndex];
                return 'Sentiment: ' + classification;
              }
            }
          }
        },
        scales: {
          x: {
            title: {
              display: true,
              text: 'Date',
              font: {
                size: 14,
                weight: 'bold'
              }
            },
            ticks: {
              maxRotation: 45,
              minRotation: 45,
              font: {
                size: 12
              }
            }
          },
          y: {
            min: 0,
            max: 100,
            title: {
              display: true,
              text: 'Fear & Greed Index Value',
              font: {
                size: 14,
                weight: 'bold'
              }
            },
            ticks: {
              font: {
                size: 12
              }
            },
            grid: {
              color: function(context) {
                const value = context.tick.value;
                if (value === 25 || value === 45 || value === 55 || value === 75) {
                  return '#ff6b6b';
                }
                return 'rgba(0,0,0,0.1)';
              },
              lineWidth: function(context) {
                const value = context.tick.value;
                if (value === 25 || value === 45 || value === 55 || value === 75) {
                  return 2;
                }
                return 1;
              }
            }
          }
        },
        elements: {
          point: {
            hoverBackgroundColor: '#6366f1',
            hoverBorderColor: '#4f46e5',
            hoverBorderWidth: 3
          }
        }
      }
    });

    function scheduleChartHeightUpdate() {
      desiredChartHeight = refreshChartHeight();
      notifyParentHeight(desiredChartHeight);
      fearGreedChart.resize();
    }

    scheduleChartHeightUpdate();
    setTimeout(scheduleChartHeightUpdate, 300);
    window.addEventListener('resize', scheduleChartHeightUpdate);
  </script>
</body>
</html>
    `;
}

/**
 * Deletes previous Fear & Greed Index chart files for a specific symbol (if provided)
 */
function deletePreviousFearGreedCharts(outputDir: string, cryptoSymbol?: string): void {
    try {
        if (!fs.existsSync(outputDir)) {
            return;
        }

        const files = fs.readdirSync(outputDir);
        
        let chartFilePattern: RegExp;
        
        if (cryptoSymbol) {
            // Symbol-specific pattern: Fear&Greed Index Chart [SYMBOL] [DATE_RANGE].html
            // Matches patterns like: Fear&Greed Index Chart BTC 2025-01-01~2025-01-31.html
            chartFilePattern = new RegExp(`^Fear&Greed Index Chart ${cryptoSymbol.toUpperCase()} \\d{4}-\\d{2}-\\d{2}(~\\d{4}-\\d{2}-\\d{2})?\.html$`);
        } else {
            // Legacy pattern for backward compatibility: Fear&Greed Index Chart [DATE_RANGE].html
            // Matches patterns like: Fear&Greed Index Chart 2025-01-01~2025-01-31.html
            chartFilePattern = /^Fear&Greed Index Chart \d{4}-\d{2}-\d{2}(~\d{4}-\d{2}-\d{2})?\.html$/;
        }
        
        const matchingFiles = files.filter(file => chartFilePattern.test(file));

        // Note: Chart deletion disabled to preserve historical data
        // Old charts are kept for reference in chat history
        if (matchingFiles.length > 0) {
            console.log(`Found ${matchingFiles.length} existing Fear&Greed chart(s) (keeping for history)`);
        }

        // Delete all matching files
        // matchingFiles.forEach(file => {
        //     const filePath = path.join(outputDir, file);
        //     fs.unlinkSync(filePath);
        //     console.log(`Deleted previous Fear&Greed chart: ${filePath}`);
        // });
        
    } catch (error) {
        console.error('Error deleting previous Fear & Greed charts:', error);
    }
}

/**
 * Analyzes fear and greed index data to provide market insights
 */
async function analyzeFearAndGreedIndex(fearData: FearIndexDataPoint[]): Promise<FearIndexAnalysis> {
    try {
        if (!fearData || fearData.length === 0) {
            throw new Error('No fear and greed index data available');
        }

        // Sort data chronologically
        const sortedData = fearData.sort((a, b) => Number.parseInt(a.timestamp) - Number.parseInt(b.timestamp));
        const currentReading = sortedData[sortedData.length - 1];
        const previousReading = sortedData[sortedData.length - 2];

        // Calculate trend metrics
        const values = sortedData.map(d => d.value);
        const average = values.reduce((sum, val) => sum + val, 0) / values.length;
        
        // Determine trend direction and strength
        const recentValues = values.slice(-7); // Last 7 days
        const trendSlope = calculateTrendSlope(recentValues);
        const volatility = calculateVolatility(values);
        
        // Count extreme readings
        const extremeFear = sortedData.filter(d => d.value <= 25).length;
        const extremeGreed = sortedData.filter(d => d.value >= 75).length;
        
        // Generate trading signals
        const tradingSignals = generateTradingSignals(currentReading, previousReading, average, extremeFear, extremeGreed, sortedData.length);
        
        // Generate recommendations
        const recommendations = generateRecommendations(currentReading.value, trendSlope, volatility);

        return {
            currentSentiment: {
                value: currentReading.value,
                classification: currentReading.value_classification,
                interpretation: interpretSentiment(currentReading.value),
                marketImplication: getMarketImplication(currentReading.value)
            },
            trend: {
                direction: trendSlope > 1 ? 'Increasing' : trendSlope < -1 ? 'Decreasing' : 'Stable',
                strength: Math.abs(trendSlope) > 2 ? 'Strong' : Math.abs(trendSlope) > 0.5 ? 'Moderate' : 'Weak',
                duration: calculateTrendDuration(sortedData),
                volatility: volatility
            },
            historicalContext: {
                averageValue: Math.round(average * 100) / 100,
                extremeReadings: {
                    fearCount: extremeFear,
                    greedCount: extremeGreed
                },
                marketCycles: identifyMarketCycles(sortedData)
            },
            tradingSignals,
            recommendations
        };
    } catch (error) {
        console.error('Error analyzing fear and greed index:', error);
        throw error;
    }
}

/**
 * Interprets the fear and greed sentiment value
 */
function interpretSentiment(value: number): string {
    if (value <= 25) {
        return "Extreme Fear - Market participants are highly risk-averse, potentially creating oversold conditions";
    } else if (value <= 45) {
        return "Fear - Investors are cautious and risk-averse, but not in panic mode";
    } else if (value <= 55) {
        return "Neutral - Market sentiment is balanced between fear and greed";
    } else if (value <= 75) {
        return "Greed - Investors are optimistic and risk-seeking, potentially overvaluing assets";
    } else {
        return "Extreme Greed - Market participants are highly speculative, potentially creating overbought conditions";
    }
}

/**
 * Determines market implications based on sentiment
 */
function getMarketImplication(value: number): string {
    if (value <= 25) {
        return "Potential buying opportunity as assets may be undervalued due to excessive selling pressure";
    } else if (value <= 45) {
        return "Cautious market conditions with limited upside momentum in the short term";
    } else if (value <= 55) {
        return "Balanced market conditions with normal trading patterns expected";
    } else if (value <= 75) {
        return "Bullish market sentiment with potential for continued upward momentum";
    } else {
        return "High risk of market correction as valuations may be stretched due to excessive speculation";
    }
}

/**
 * Calculates trend slope using linear regression
 */
function calculateTrendSlope(values: number[]): number {
    const n = values.length;
    const x = Array.from({length: n}, (_, i) => i);
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = values.reduce((a, b) => a + b, 0);
    const sumXY = x.map((xi, i) => xi * values[i]).reduce((a, b) => a + b, 0);
    const sumXX = x.map(xi => xi * xi).reduce((a, b) => a + b, 0);
    
    return (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
}

/**
 * Calculates volatility (standard deviation)
 */
function calculateVolatility(values: number[]): number {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    return Math.sqrt(variance);
}

/**
 * Calculates how long the current trend has been in place
 */
function calculateTrendDuration(data: FearIndexDataPoint[]): number {
    if (data.length < 2) return 0;
    
    const currentValue = data[data.length - 1].value;
    let duration = 1;
    
    for (let i = data.length - 2; i >= 0; i--) {
        const prevValue = data[i].value;
        const currentCategory = getCategoryFromValue(currentValue);
        const prevCategory = getCategoryFromValue(prevValue);
        
        if (currentCategory === prevCategory) {
            duration++;
        } else {
            break;
        }
    }
    
    return duration;
}

/**
 * Gets category from fear/greed value
 */
function getCategoryFromValue(value: number): string {
    if (value <= 25) return 'extreme_fear';
    if (value <= 45) return 'fear';
    if (value <= 55) return 'neutral';
    if (value <= 75) return 'greed';
    return 'extreme_greed';
}

/**
 * Identifies market cycles in the data
 */
function identifyMarketCycles(data: FearIndexDataPoint[]): string[] {
    const cycles: string[] = [];
    let currentCycle = '';
    let cycleStart = 0;
    
    for (let i = 0; i < data.length; i++) {
        const category = getCategoryFromValue(data[i].value);
        
        if (category !== currentCycle) {
            if (currentCycle && i - cycleStart >= 3) { // Only count cycles lasting 3+ days
                cycles.push(`${currentCycle} (${i - cycleStart} days)`);
            }
            currentCycle = category;
            cycleStart = i;
        }
    }
    
    // Add the final cycle
    if (currentCycle && data.length - cycleStart >= 3) {
        cycles.push(`${currentCycle} (${data.length - cycleStart} days)`);
    }
    
    return cycles.slice(-5); // Return last 5 cycles
}

/**
 * Generates trading signals based on analysis
 */
function generateTradingSignals(
    current: FearIndexDataPoint,
    previous: FearIndexDataPoint | undefined,
    average: number,
    extremeFear: number,
    extremeGreed: number,
    totalDays: number
): any {
    const currentValue = current.value;
    const isExtremelyOversold = currentValue <= 20;
    const isExtremelyOverbought = currentValue >= 80;
    const isFearTerritory = currentValue <= 35;
    const isGreedTerritory = currentValue >= 65;
    
    // Calculate momentum
    const momentum = previous ? currentValue - previous.value : 0;
    
    // Contrarian signals (primary approach)
    const buySignal = isExtremelyOversold || (isFearTerritory && momentum > 0);
    const sellSignal = isExtremelyOverbought || (isGreedTerritory && momentum < 0);
    const neutralSignal = !buySignal && !sellSignal;
    
    // Calculate confidence based on extremeness and historical context
    const extremeScore = Math.max(
        Math.abs(currentValue - 50) / 50, // Distance from neutral
        (extremeFear + extremeGreed) / totalDays // Historical extreme frequency
    );
    const confidence = Math.min(extremeScore * 100, 95);
    
    let reasoning = '';
    if (buySignal) {
        reasoning = isExtremelyOversold ? 
            'Extreme fear levels suggest oversold conditions, creating potential buying opportunity' :
            'Fear territory with improving momentum indicates potential trend reversal';
    } else if (sellSignal) {
        reasoning = isExtremelyOverbought ?
            'Extreme greed levels suggest overbought conditions, high risk of correction' :
            'Greed territory with declining momentum indicates potential trend reversal';
    } else {
        reasoning = 'Neutral sentiment provides no strong directional signals';
    }
    
    return {
        buySignal,
        sellSignal,
        neutralSignal,
        confidence: Math.round(confidence),
        reasoning
    };
}

/**
 * Generates trading recommendations
 */
function generateRecommendations(value: number, trendSlope: number, volatility: number): any {
    const isVolatile = volatility > 15;
    const strongTrend = Math.abs(trendSlope) > 1;
    
    let shortTerm = '';
    let mediumTerm = '';
    let longTerm = '';
    let riskLevel = '';
    
    if (value <= 25) {
        shortTerm = 'Consider accumulating on dips, but use dollar-cost averaging';
        mediumTerm = 'Excellent opportunity for building positions in quality assets';
        longTerm = 'Historic lows often mark excellent long-term entry points';
        riskLevel = 'Medium - volatility expected but good risk/reward ratio';
    } else if (value <= 45) {
        shortTerm = 'Cautious buying on weakness, avoid FOMO';
        mediumTerm = 'Gradual position building as sentiment improves';
        longTerm = 'Good accumulation phase for patient investors';
        riskLevel = 'Low-Medium - relatively safe accumulation phase';
    } else if (value <= 55) {
        shortTerm = 'Maintain current positions, selective trading';
        mediumTerm = 'Normal market conditions, follow technical analysis';
        longTerm = 'Continue regular investment strategy';
        riskLevel = 'Low - balanced market conditions';
    } else if (value <= 75) {
        shortTerm = 'Consider taking some profits on strong performers';
        mediumTerm = 'Monitor for signs of overheating, maintain discipline';
        longTerm = 'Good time to rebalance portfolios';
        riskLevel = 'Medium - increased vigilance required';
    } else {
        shortTerm = 'Consider reducing exposure, book profits';
        mediumTerm = 'High probability of correction, preserve capital';
        longTerm = 'Prepare for buying opportunities after correction';
        riskLevel = 'High - correction risk elevated';
    }
    
    // Adjust for trend and volatility
    if (isVolatile) {
        riskLevel = 'High volatility - ' + riskLevel;
    }
    
    if (strongTrend && trendSlope > 0) {
        shortTerm += ' (Strong uptrend in progress)';
    } else if (strongTrend && trendSlope < 0) {
        shortTerm += ' (Strong downtrend in progress)';
    }
    
    return {
        shortTerm,
        mediumTerm,
        longTerm,
        riskLevel
    };
}

/**
 * Formats the analysis results into a readable report
 */
function formatAnalysisReport(analysis: FearIndexAnalysis, chartGenerated = false, cryptoSymbol?: string): string {
    const cryptoContext = cryptoSymbol ? ` (${cryptoSymbol} Analysis)` : '';
    const chartStatusMessage = chartGenerated ? 'Fear & Greed Index chart has been generated successfully! ' : '';
    const chartInfo = chartGenerated ? '\n\n📊 **Interactive Chart Generated:** An HTML chart visualization has been created showing the Fear & Greed Index trends with color-coded sentiment levels.\n' : '';
    
    const report = `${chartStatusMessage}
# Fear & Greed Index Analysis Report${cryptoContext}${chartInfo}

## Current Market Sentiment
**Value:** ${analysis.currentSentiment.value}/100 (${analysis.currentSentiment.classification})
**Interpretation:** ${analysis.currentSentiment.interpretation}
**Market Implication:** ${analysis.currentSentiment.marketImplication}

## Trend Analysis
**Direction:** ${analysis.trend.direction} (${analysis.trend.strength})
**Duration:** ${analysis.trend.duration} days
**Volatility:** ${analysis.trend.volatility.toFixed(2)}

## Historical Context
**Average Value:** ${analysis.historicalContext.averageValue}
**Extreme Fear Readings:** ${analysis.historicalContext.extremeReadings.fearCount} days
**Extreme Greed Readings:** ${analysis.historicalContext.extremeReadings.greedCount} days
**Recent Market Cycles:** ${analysis.historicalContext.marketCycles.join(', ')}

## Trading Signals
**Signal Type:** ${analysis.tradingSignals.buySignal ? 'BUY' : analysis.tradingSignals.sellSignal ? 'SELL' : 'NEUTRAL'}
**Confidence:** ${analysis.tradingSignals.confidence}%
**Reasoning:** ${analysis.tradingSignals.reasoning}

## Recommendations
**Short-term (1-7 days):** ${analysis.recommendations.shortTerm}
**Medium-term (1-4 weeks):** ${analysis.recommendations.mediumTerm}
**Long-term (1-6 months):** ${analysis.recommendations.longTerm}
**Risk Level:** ${analysis.recommendations.riskLevel}

---
*Analysis based on Fear & Greed Index data. Always conduct additional research and consider risk tolerance before making investment decisions.*
    `;
    
    return report.trim();
}

export const fearAndGreedIndexAnalysisAction: Action = {
    name: "FEAR_GREED_INDEX_ANALYSIS",
    description: "Performs Fear & Greed Index analysis for cryptocurrency markets, and provides interactive chart visualization",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        _options?: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        try {
            const text = message.content.text.toLowerCase();
            
            // Extract cryptocurrency symbol from options or message
            let cryptoSymbol: string | undefined;
            if (_options && _options.target) {
                cryptoSymbol = _options.target.toString().toUpperCase();
            } else if (_options && _options.symbol) {
                cryptoSymbol = _options.symbol.toString().toUpperCase();
            } else {
                // Try to detect from message text
                const cryptoMatch = text.match(/\b(btc|bitcoin|eth|ethereum|sol|solana|ada|cardano|dot|polkadot|xrp|ripple|bnb|doge|dogecoin|matic|polygon|ltc|litecoin|link|chainlink|uni|uniswap|avax|avalanche|atom|cosmos|xlm|stellar|trx|tron|bch|bitcoin cash)\b/i);
                if (cryptoMatch) {
                    const detected = cryptoMatch[1].toLowerCase();
                    // Map common names to symbols
                    const symbolMap: { [key: string]: string } = {
                        'bitcoin': 'BTC', 'eth': 'ETH', 'ethereum': 'ETH', 'sol': 'SOL', 'solana': 'SOL',
                        'ada': 'ADA', 'cardano': 'ADA', 'dot': 'DOT', 'polkadot': 'DOT', 'xrp': 'XRP', 'ripple': 'XRP',
                        'bnb': 'BNB', 'doge': 'DOGE', 'dogecoin': 'DOGE', 'matic': 'MATIC', 'polygon': 'MATIC',
                        'ltc': 'LTC', 'litecoin': 'LTC', 'link': 'LINK', 'chainlink': 'LINK', 'uni': 'UNI', 'uniswap': 'UNI',
                        'avax': 'AVAX', 'avalanche': 'AVAX', 'atom': 'ATOM', 'cosmos': 'ATOM', 'xlm': 'XLM', 'stellar': 'XLM',
                        'trx': 'TRX', 'tron': 'TRX', 'bch': 'BCH', 'bitcoin cash': 'BCH'
                    };
                    cryptoSymbol = symbolMap[detected] || detected.toUpperCase();
                }
            }
            
            // Prepare parameters for data fetching (from/to only)
            let dataParams: number | { [key: string]: unknown };

            if (_options?.from && _options?.to) {
                dataParams = { from: _options.from, to: _options.to };
                console.log('Using period-based parameters:', dataParams);
            } else {
                // No from/to: parse days from message or use default 100
                let days = 100;
                const daysMatch = text.match(/(\d+)\s*(day|week|month)/i);
                if (daysMatch) {
                    const value = Number.parseInt(daysMatch[1]);
                    const unit = (daysMatch[2] || '').toLowerCase();
                    if (unit.startsWith('week')) days = value * 7;
                    else if (unit.startsWith('month')) days = value * 30;
                    else days = value;
                }
                days = Math.min(Math.max(days, 7), 365);
                dataParams = days;
                console.log('Using default/day-from-message parameters:', dataParams);
            }

            // Fetch the fear and greed data once
            const fearData = await getFearAndGreedIndex(dataParams);
            
            if (!fearData || fearData.length === 0) {
                throw new Error('No fear and greed index data available');
            }

            const analysis = await analyzeFearAndGreedIndex(fearData);

            // Generate chart visualization
            let chartPath = '';
            let chartGenerated = false;
            try {
                // Determine chart period for display
                const chartPeriod = typeof dataParams === 'number' ? dataParams : fearData.length;

                // Generate HTML chart (data is already validated)
                const htmlContent = generateFearGreedChartHTML(fearData, chartPeriod);
                
                // Create Charts directory using standard pattern (matches all other plugins)
                const savedDataDir = path.join(process.cwd(), 'saved_data');
                const outputDir = path.join(savedDataDir, 'Charts');
                
                if (!fs.existsSync(savedDataDir)) {
                    fs.mkdirSync(savedDataDir, { recursive: true });
                    console.log(`Created directory: ${savedDataDir}`);
                }
                
                if (!fs.existsSync(outputDir)) {
                    fs.mkdirSync(outputDir, { recursive: true });
                    console.log(`Created directory: ${outputDir}`);
                }
                
                // Delete previous chart files for this specific symbol (if available) or all (backward compatibility)
                deletePreviousFearGreedCharts(outputDir, cryptoSymbol);
                
                // Generate standardized filename format: Fear&Greed Index Chart [SYMBOL] {date range}
                let startDate: string, endDate: string;

                if (typeof dataParams === 'object' && dataParams.from && dataParams.to) {
                    // Use explicit date range from period parameters
                    startDate = dataParams.from.toString();
                    endDate = dataParams.to.toString();
                } else {
                    // Calculate date range from data points (actual data range)
                    if (fearData.length > 0) {
                        const sortedData = fearData.sort((a, b) => Number.parseInt(a.timestamp) - Number.parseInt(b.timestamp));
                        startDate = new Date(Number.parseInt(sortedData[0].timestamp) * 1000).toISOString().split('T')[0];
                        endDate = new Date(Number.parseInt(sortedData[sortedData.length - 1].timestamp) * 1000).toISOString().split('T')[0];
                    } else {
                        // Fallback to current date
                        const today = new Date();
                        startDate = endDate = today.toISOString().split('T')[0];
                    }
                }

                const dateRange = startDate === endDate ? startDate : `${startDate}~${endDate}`;
                
                // Include cryptocurrency symbol in filename if available, otherwise use legacy format
                const fileName = cryptoSymbol 
                    ? `Fear&Greed Index Chart ${cryptoSymbol} ${dateRange}.html`
                    : `Fear&Greed Index Chart ${dateRange}.html`;
                chartPath = path.join(outputDir, fileName);
                
                fs.writeFileSync(chartPath, htmlContent);
                chartGenerated = true;
            } catch (chartError) {
                console.error('Error generating chart:', chartError);
                // Continue with analysis even if chart generation fails
            }

            // Generate the final report with chart information, include crypto context if available
            const report = formatAnalysisReport(analysis, chartGenerated, cryptoSymbol);

            if (callback) {
                // Use S3 proxy URL so the path survives ECS container redeployments
                const relativePath = chartPath ? buildChartProxyUrl(chartPath, runtime.agentId) : '';
                
                // Include period information in callback (from/to only)
                const periodDays = typeof dataParams === 'number' ? dataParams : fearData.length;
                const endDate = new Date();
                const startDate = new Date(endDate.getTime() - (periodDays - 1) * 24 * 60 * 60 * 1000);
                const formatYmd = (d: Date) => d.toISOString().split('T')[0];
                const periodInfo = typeof dataParams === 'object' && dataParams.from && dataParams.to
                    ? { from: dataParams.from, to: dataParams.to }
                    : { from: formatYmd(startDate), to: formatYmd(endDate) };

                // Generate action summary
                const timePeriod = typeof dataParams === 'object' && dataParams.from && dataParams.to
                    ? `${dataParams.from} to ${dataParams.to}`
                    : `${fearData.length} days`;
                const currentSentiment = analysis.currentSentiment?.value || 'N/A';
                const classification = analysis.currentSentiment?.classification || 'Unknown';

                const actionSummary = generateActionSummary({
                    actionName: 'Fear & Greed Index Analysis',
                    assets: ['Crypto Market'],
                    timePeriod: timePeriod,
                    dataPoints: fearData.length,
                    additionalInfo: `current sentiment ${currentSentiment} (${classification})`
                });

                const actionData = {
                    analysis,
                    chartData: {
                        labels: fearData.map((point) =>
                            new Date(Number.parseInt(point.timestamp) * 1000)
                                .toISOString()
                                .split("T")[0]
                        ),
                        valueData: fearData.map((point) => point.value),
                    },
                    chartPath: relativePath,
                    cryptoSymbol,
                    ...periodInfo,
                    dataPoints: fearData.length,
                    summary: actionSummary,
                };

                await callback(createActionResponse({
                    actionName: "FEAR_GREED_INDEX_ANALYSIS",
                    type: "fear_greed_index_analysis",
                    text: report,
                    content: {
                        analysis: report, // Use report string instead of analysis object
                        ...periodInfo,
                        action: "FEAR_GREED_INDEX_ANALYSIS",
                        // Store the full analysis object under a different key
                        analysisData: analysis,
                    },
                    actionData,
                    chartPath: relativePath,
                    additionalMetadata: {
                        cryptoSymbol,
                        ...periodInfo,
                        dataPoints: fearData.length
                    },
                }));
            }

            return true;
        } catch (error) {
            console.error('Error in fear and greed index analysis:', error);
            
            if (callback) {
                await callback(createActionErrorResponse({
                    actionName: "FEAR_GREED_INDEX_ANALYSIS",
                    type: "fear_greed_index_analysis_error",
                    error: error instanceof Error ? error : new Error(String(error)),
                    text: `I encountered an error while analyzing the Fear & Greed Index: ${error instanceof Error ? error.message : 'Unknown error'}. Please ensure the COINMARKETCAP_API_KEY is properly configured.`,
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
                    text: "Can you analyze the current fear and greed index?"
                }
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll analyze the current Fear & Greed Index to provide insights into market sentiment and trading opportunities.",
                    action: "FEAR_GREED_INDEX_ANALYSIS"
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show me the fear and greed index analysis with trading signals"
                }
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Analyzing Fear & Greed Index data to identify market psychology trends and generate trading signals...",
                    action: "FEAR_GREED_INDEX_ANALYSIS"
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Give me a fear index analysis for the past 2 weeks"
                }
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Performing Fear & Greed Index analysis for the past 14 days to assess market psychology and provide trading recommendations...",
                    action: "FEAR_GREED_INDEX_ANALYSIS"
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "What's the current fear and greed index reading? Any buying opportunities?"
                }
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Analyzing the current Fear & Greed Index reading to assess market psychology and identify potential investment opportunities...",
                    action: "FEAR_GREED_INDEX_ANALYSIS"
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show me a fear and greed index chart with analysis for the last month"
                }
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll generate a comprehensive Fear & Greed Index analysis with an interactive chart showing sentiment trends over the past 30 days, including trading signals and market recommendations.",
                    action: "FEAR_GREED_INDEX_ANALYSIS"
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Analyze fear and greed index from 2025-08-01 to 2025-09-15"
                }
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll analyze the Fear & Greed Index for the specific period from August 1st to September 15th, 2025, providing detailed sentiment analysis and market psychology insights for this timeframe.",
                    action: "FEAR_GREED_INDEX_ANALYSIS"
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Give me fear index data between 2025-07-10 and 2025-08-10 with trading signals"
                }
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Analyzing Fear & Greed Index data from July 10th to August 10th, 2025, to generate comprehensive trading signals and market sentiment recommendations for this specific period.",
                    action: "FEAR_GREED_INDEX_ANALYSIS"
                }
            }
        ],
    ] as ActionExample[][],
    cacheConfig: {
        enabled: true,
        ttlSeconds: 86400, // 1 day for fear & greed index data
        similarityThreshold: 0.7,
        maxChunkSize: 200,
    },
};

export default fearAndGreedIndexAnalysisAction;
