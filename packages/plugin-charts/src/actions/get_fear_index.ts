import fs from "fs";
import path from "path";
import type {
    Action,
    IAgentRuntime,
    Memory,
    ActionExample,
    State,
    HandlerCallback
} from "@elizaos/core";

import { getProductionEnvVariable, createActionResponse, createActionErrorResponse, generateActionSummary, buildChartProxyUrl } from "@elizaos/core";
import { httpClient } from "@elizaos/core";

const API_KEY = getProductionEnvVariable("COINMARKETCAP_API_KEY");
const API_URL = "https://pro-api.coinmarketcap.com/v3/fear-and-greed/historical";
const COINGLASS_API_URL = "https://open-api-v4.coinglass.com/api/futures/price/history";
const COINGLASS_EXCHANGE = "Binance";
const COINGLASS_INTERVAL = "1d";

// Helper function to format dates in UTC without showing UTC suffix
function formatDateUTC(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Helper function to format date with hours in UTC
function formatDateTimeUTC(date: Date): string {
  const dateStr = formatDateUTC(date);
  const hours = String(date.getUTCHours()).padStart(2, "0");
  return `${dateStr} ${hours}:00`;
}

if (!API_KEY) {
    throw new Error("COINMARKETCAP_API_KEY is not set");
}

// example return data
// {
//     "data": [
// {
// "timestamp": "1726617600",
// "value": 38,
// "value_classification": "Fear"
// },
// {
// "timestamp": "1726531200",
// "value": 34,
// "value_classification": "Fear"
// },
// }

interface FearIndexDataPoint {
    timestamp: string;
    value: number;
    value_classification: string;
}

interface PriceDataPoint {
    date: string; // YYYY-MM-DD format
    price: number;
}

interface CoinglassPricePoint {
    time: number;
    close: string;
}

interface CoinglassPriceHistoryResponse {
    code: string;
    msg?: string;
    data?: CoinglassPricePoint[];
}

function toCoinglassSymbol(symbol: string): string {
    const normalized = symbol.trim().toUpperCase();
    if (normalized.includes("-")) {
        const [base, quote] = normalized.split("-");
        if (quote === "USD") {
            return `${base}USDT`;
        }
        if (quote) {
            return `${base}${quote}`;
        }
    }

    if (normalized.endsWith("USD") && !normalized.endsWith("USDT")) {
        return `${normalized.slice(0, -3)}USDT`;
    }

    return normalized;
}

/**
 * Fetches fear and greed index data from CoinMarketCap API
 * @param days Number of days to fetch data for (default: 30)
 * @returns Array of fear index data points
 */
export async function getFearAndGreedIndex(days = 30): Promise<FearIndexDataPoint[]> {
    try {
        // For larger time periods, we need to use pagination
        const results: FearIndexDataPoint[] = [];
        const maxPerPage = 500; // API limit per page (max 500 as per documentation)
        
        // Calculate how many requests we need
        const totalRequests = Math.ceil(days / maxPerPage);
        
        for (let i = 0; i < totalRequests; i++) {
            // Calculate the limit for this request (max 500 per request)
            const limit = Math.min(maxPerPage, days - (i * maxPerPage));
            
            // Calculate the start parameter (1-based index for pagination)
            const start = i * maxPerPage + 1;
            
            const response = await httpClient.get(API_URL, {
                headers: {
                    "X-CMC_PRO_API_KEY": API_KEY
                },
                params: {
                    start: start,
                    limit: limit,
                    format: "json"
                }
            });

            if (response.data && response.data.data) {
                // Add new results to our collection
                results.push(...response.data.data);
                
                // If we didn't get as many results as expected, break out of the loop
                if (response.data.data.length < limit) {
                    console.log(`Retrieved only ${response.data.data.length} records, possibly reached the earliest available data`);
                    break;
                }
            } else {
                throw new Error("Invalid response format from CoinMarketCap API");
            }
            
            // Add a small delay between requests to avoid rate limiting
            if (i < totalRequests - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        return results;
    } catch (error) {
        console.error("Error fetching fear and greed index:", error);
        throw error;
    }
}

/**
 * Fetches cryptocurrency price data from CoinGlass
 */
async function getCryptoPriceData(symbol = "BTC-USD", days = 30): Promise<PriceDataPoint[]> {
    try {
        const apiKey = process.env.COINGLASS_API_KEY;
        if (!apiKey) {
            console.error("COINGLASS_API_KEY is not set");
            return [];
        }

        const endTime = Date.now();
        const startTime = endTime - (days + 5) * 24 * 60 * 60 * 1000;
        const limit = Math.min(1000, days + 5);

        const response = await httpClient.get(COINGLASS_API_URL, {
            headers: {
                accept: "application/json",
                "CG-API-KEY": apiKey
            },
            params: {
                exchange: COINGLASS_EXCHANGE,
                symbol: toCoinglassSymbol(symbol),
                interval: COINGLASS_INTERVAL,
                limit: limit,
                start_time: startTime,
                end_time: endTime
            }
        });

        const apiResponse: CoinglassPriceHistoryResponse = response.data;
        if (!apiResponse || apiResponse.code !== "0") {
            throw new Error(`CoinGlass API Error: ${apiResponse?.msg || "Unknown error"}`);
        }

        if (!apiResponse.data || apiResponse.data.length === 0) {
            return [];
        }

        return apiResponse.data
            .map(item => ({
                date: formatDateUTC(new Date(item.time)),
                price: Number(item.close)
            }))
            .filter(item => Number.isFinite(item.price));
    } catch (error) {
        console.error(`Error fetching ${symbol} price data:`, error);
        return []; // Return empty array on error
    }
}

/**
 * Deletes previous fear index charts for a given crypto
 */
function deletePreviousCharts(outputDir: string, cryptoSymbol: string): void {
    try {
        if (!fs.existsSync(outputDir)) {
            return;
        }
        
        const files = fs.readdirSync(outputDir);
        const cryptoTicker = cryptoSymbol.toUpperCase();

        // Match files with pattern: Fear Index Chart [TICKER] [DATE_RANGE].html
        // Matches patterns like: Fear Index Chart BTC 2025-01-01~2025-01-31.html or Fear Index Chart BTC 2025-01-01.html
        const chartFilePattern = new RegExp(`^Fear Index Chart ${cryptoTicker} \\d{4}-\\d{2}-\\d{2}(~\\d{4}-\\d{2}-\\d{2})?\\.html$`);

        const matchingFiles = files.filter(file => chartFilePattern.test(file));

        // Note: Chart deletion disabled to preserve historical data
        // Old charts are kept for reference in chat history
        if (matchingFiles.length > 0) {
            console.log(`Found ${matchingFiles.length} existing fear index chart(s) for ${cryptoTicker} (keeping for history)`);
        }

        // matchingFiles.forEach(file => {
        //     const filePath = path.join(outputDir, file);
        //     fs.unlinkSync(filePath);
        //     console.log(`Deleted previous fear index chart: ${filePath}`);
        // });
        
    } catch (error) {
        console.error("Error deleting previous fear index charts:", error);
    }
}

/**
 * Generates HTML for visualizing the fear and greed index with crypto price
 */
function generateFearIndexHTML(fearData: FearIndexDataPoint[], priceData: PriceDataPoint[], cryptoSymbol = "BTC-USD"): string {
    // Get crypto name for display
    const cryptoCode = cryptoSymbol.split("-")[0];
    const cryptoName = getCryptoName(cryptoCode);
    
    // Sort fear data chronologically for proper display
    const sortedFearData = [...fearData].sort((a, b) => 
        Number.parseInt(a.timestamp) - Number.parseInt(b.timestamp)
    );
    
    // Create a map of dates to price data for easy lookup
    const priceMap = new Map<string, number>();
    priceData.forEach(point => {
        priceMap.set(point.date, point.price);
    });
    
    // Prepare data for chart - align dates
    const formattedFearData = sortedFearData.map(point => {
        const date = new Date(Number.parseInt(point.timestamp) * 1000);
        return {
            date: formatDateUTC(date),
            value: point.value,
            classification: point.value_classification
        };
    });
    
    // Filter price data to match the date range of fear data
    const earliestFearDate = formattedFearData[0]?.date;
    const latestFearDate = formattedFearData[formattedFearData.length - 1]?.date;
    
    const filteredPriceData = priceData.filter(point => 
        point.date >= earliestFearDate && point.date <= latestFearDate
    );
    
    // Align data sets
    const chartDates = [];
    const fearValues = [];
    const classifications = [];
    const prices = [];
    
    formattedFearData.forEach(fearPoint => {
        chartDates.push(`"${fearPoint.date}"`);
        fearValues.push(fearPoint.value);
        classifications.push(`"${fearPoint.classification}"`);
        
        // Find matching price data or use null if not available
        const price = priceMap.get(fearPoint.date);
        prices.push(price !== undefined ? price : null);
    });

    // Calculate stats for summary
    const latestFear = sortedFearData[sortedFearData.length-1];
    const latestValue = latestFear.value;
    const latestClassification = latestFear.value_classification;
    const startDate = formatDateUTC(new Date(Number.parseInt(sortedFearData[0].timestamp) * 1000));
    const endDate = formatDateUTC(new Date(Number.parseInt(sortedFearData[sortedFearData.length-1].timestamp) * 1000));
    const highestValue = Math.max(...sortedFearData.map(d => d.value));
    const lowestValue = Math.min(...sortedFearData.map(d => d.value));
    
    // Get latest price and calculate percent change
    const latestPrice = filteredPriceData[filteredPriceData.length - 1]?.price || 0;
    const firstPrice = filteredPriceData[0]?.price || 0;
    const priceChange = firstPrice > 0 ? ((latestPrice - firstPrice) / firstPrice) * 100 : 0;
    
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Crypto Fear & Greed Index with ${cryptoName} Price</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js" crossorigin="anonymous" onerror="document.body.innerHTML='<p style=\\'font-family:sans-serif;padding:1rem\\'>Chart library failed to load. Check network or try opening this page in a new tab.</p>'"></script>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; padding: 20px; min-height: 100%; }
    .chart-container { position: relative; height: clamp(240px, 40vw, 480px); width: 100%; max-width: 1200px; margin: 0 auto; }
    .chart-container canvas { width: 100% !important; height: 100% !important; }
    h1 { text-align: center; color: #333; margin: 10px 0 20px 0; font-size: 1.5rem; }
    .summary { margin: 15px 0; padding: 12px; background-color: #f5f5f5; border-radius: 5px; }
    .legend { display: flex; justify-content: center; gap: 20px; margin-bottom: 15px; flex-wrap: wrap; }
    .legend-item { display: flex; align-items: center; margin: 5px; font-size: 0.9rem; }
    .legend-color { width: 20px; height: 20px; margin-right: 5px; border-radius: 3px; }
    .summary-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
    .price-up { color: #27AE60; }
    .price-down { color: #E74C3C; }
    .generation-info { text-align: center; font-size: 0.8em; color: #777; margin-top: 15px; }
    body.compact-view { padding: 0; background: transparent; min-height: 0; }
    body.compact-view .chart-container {
      height: clamp(200px, 40vw, 520px);
      min-height: 200px;
      max-height: 540px;
      max-width: none;
      margin: 0;
      padding: 0 0 12px 0;
    }
    body.compact-view h1,
    body.compact-view .summary,
    body.compact-view .legend,
    body.compact-view .generation-info { display: none; }
    body.compact-view .chart-container canvas { max-height: none !important; }
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
  <h1>Crypto Fear & Greed Index with ${cryptoName} Price</h1>
  
  <div class="legend">
    <div class="legend-item">
      <div class="legend-color" style="background-color: #E74C3C;"></div>
      <span>Extreme Fear (0-25)</span>
    </div>
    <div class="legend-item">
      <div class="legend-color" style="background-color: #F39C12;"></div>
      <span>Fear (26-45)</span>
    </div>
    <div class="legend-item">
      <div class="legend-color" style="background-color: #F1C40F;"></div>
      <span>Neutral (46-55)</span>
    </div>
    <div class="legend-item">
      <div class="legend-color" style="background-color: #2ECC71;"></div>
      <span>Greed (56-75)</span>
    </div>
    <div class="legend-item">
      <div class="legend-color" style="background-color: #27AE60;"></div>
      <span>Extreme Greed (76-100)</span>
    </div>
  </div>
  
  <div class="summary">
    <div class="summary-grid">
      <div>
        <h3>Fear & Greed Index</h3>
        <p><strong>Latest Value:</strong> ${latestValue} (${latestClassification})</p>
        <p><strong>Highest:</strong> ${highestValue}</p>
        <p><strong>Lowest:</strong> ${lowestValue}</p>
      </div>
      <div>
        <h3>${cryptoName} Price</h3>
        <p><strong>Current Price:</strong> $${latestPrice.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p>
        <p><strong>Change:</strong> <span class="${priceChange >= 0 ? 'price-up' : 'price-down'}">${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}%</span></p>
      </div>
    </div>
    <p><strong>Date Range:</strong> ${startDate} to ${endDate}</p>
  </div>
  
  <div class="chart-container">
    <canvas id="fearGreedChart"></canvas>
  </div>

  <script>
    const ctx = document.getElementById('fearGreedChart').getContext('2d');
    
    const dates = [${chartDates.join(',')}];
    const fearValues = [${fearValues.join(',')}];
    const classifications = [${classifications.join(',')}];
    const prices = [${prices.join(',')}];
    
    // Function to determine color based on value
    function getColorForValue(value) {
      if (value <= 25) return '#E74C3C'; // Extreme Fear - Red
      if (value <= 45) return '#F39C12'; // Fear - Orange
      if (value <= 55) return '#F1C40F'; // Neutral - Yellow
      if (value <= 75) return '#2ECC71'; // Greed - Light Green
      return '#27AE60'; // Extreme Greed - Dark Green
    }
    
    // Generate background colors based on values
    const backgroundColors = fearValues.map(val => getColorForValue(val));
    
    new Chart(ctx, {
      type: 'bar',
      data: {
        labels: dates,
        datasets: [
          {
            type: 'bar',
            label: 'Fear & Greed Index',
            data: fearValues,
            backgroundColor: backgroundColors,
            borderColor: 'rgba(0, 0, 0, 0.1)',
            borderWidth: 1,
            yAxisID: 'y'
          },
          {
            type: 'line',
            label: '${cryptoName} Price (USD)',
            data: prices,
            borderColor: '#3498DB',
            backgroundColor: 'rgba(52, 152, 219, 0.1)',
            borderWidth: 2,
            pointRadius: 2,
            fill: false,
            yAxisID: 'y1'
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
          tooltip: {
            callbacks: {
              label: function(context) {
                const index = context.dataIndex;
                const datasetIndex = context.datasetIndex;
                
                if (datasetIndex === 0) {
                  return [
                    \`Fear & Greed: \${fearValues[index]}\`,
                    \`Classification: \${classifications[index]}\`
                  ];
                } else {
                  return \`${cryptoName} Price: $\${prices[index]?.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}\`;
                }
              }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            max: 100,
            title: {
              display: true,
              text: 'Fear & Greed Index Value'
            },
            grid: {
              display: true
            }
          },
          y1: {
            position: 'right',
            title: {
              display: true,
              text: '${cryptoName} Price (USD)'
            },
            grid: {
              drawOnChartArea: false
            }
          },
          x: {
            ticks: {
              maxRotation: 45,
              minRotation: 45
            }
          }
        }
      }
    });

    // Send height to parent window for iframe auto-sizing.
    // In compact view, body has min-height: 0 and only .chart-container is
    // visible, so body.scrollHeight is exactly the content height. The
    // html.* measurements reflect the iframe's current viewport (the
    // height the parent set on us), so including them creates a self-
    // perpetuating gap below the plot when the plot is shorter than the
    // iframe.
    function sendHeightToParent() {
      const body = document.body;
      const html = document.documentElement;
      const isCompact = body.classList.contains('compact-view');
      let height;
      if (isCompact) {
        height = Math.ceil(body.scrollHeight);
      } else {
        height = Math.max(
          body.scrollHeight,
          body.offsetHeight,
          html.clientHeight,
          html.scrollHeight,
          html.offsetHeight
        );
        const chartContainer = document.querySelector('.chart-container');
        if (chartContainer) {
          const rect = chartContainer.getBoundingClientRect();
          const styles = window.getComputedStyle(chartContainer);
          const marginTop = parseFloat(styles.marginTop) || 0;
          const marginBottom = parseFloat(styles.marginBottom) || 0;
          const containerHeight = rect.height + marginTop + marginBottom;
          if (!Number.isNaN(containerHeight)) {
            height = Math.max(height, containerHeight);
          }
        }
      }
      window.parent.postMessage({
        type: 'chartHeight',
        height: height
      }, '*');
    }

    // Send height after chart renders
    window.addEventListener('load', () => {
      setTimeout(sendHeightToParent, 500);
      setTimeout(sendHeightToParent, 1000);
    });

    // Resend on window resize
    let resizeTimeout;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(sendHeightToParent, 300);
    });
  </script>

  <div class="generation-info">
    Generated on ${formatDateTimeUTC(new Date())} • Data sources: CoinMarketCap Fear & Greed Index, CoinGlass
  </div>
</body>
</html>
    `;
}

/**
 * Helper function to get full cryptocurrency name from code
 */
function getCryptoName(cryptoCode: string): string {
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
    
    return cryptoNames[cryptoCode] || cryptoCode;
}

/**
 * Saves the fear index visualization to an HTML file and opens it
 */
async function saveFearIndexVisualization(fearData: FearIndexDataPoint[], priceData: PriceDataPoint[], outputDir: string, cryptoSymbol = 'BTC'): Promise<string> {
    try {
        // Create saved_data and Charts directories if they don't exist
        const savedDataDir = path.join(process.cwd(), 'saved_data');
        const customOutputDir = path.join(savedDataDir, 'Charts');
        
        if (!fs.existsSync(savedDataDir)) {
            fs.mkdirSync(savedDataDir, { recursive: true });
            console.log(`Created directory: ${savedDataDir}`);
        }
        
        if (!fs.existsSync(customOutputDir)) {
            fs.mkdirSync(customOutputDir, { recursive: true });
            console.log(`Created directory: ${customOutputDir}`);
        }
        
        // Delete any previous fear index charts
        deletePreviousCharts(customOutputDir, cryptoSymbol);
        
        // Use standardized naming format: [Chart Title] [Ticker] [DateRange],
        const cryptoTicker = cryptoSymbol.toUpperCase();
        // Default to 30 days back for fear index - create date range
        const end = new Date();
        const start = new Date(end.getTime() - (30 * 24 * 60 * 60 * 1000));
        const startDate = start.toISOString().split('T')[0];
        const endDate = end.toISOString().split('T')[0];
        const dateRange = startDate === endDate ? startDate : `${startDate}~${endDate}`;
        const fileName = `Fear Index Chart ${cryptoTicker} ${dateRange}.html`;
        const filePath = path.join(customOutputDir, fileName);
        
        // Generate HTML content with the crypto symbol
        const fullCryptoSymbol = `${cryptoSymbol}-USD`;
        const htmlContent = generateFearIndexHTML(fearData, priceData, fullCryptoSymbol);
        
        // Write to file
        fs.writeFileSync(filePath, htmlContent);
        
        return filePath;
    } catch (error) {
        console.error('Error saving fear index visualization:', error);
        throw error;
    }
}

export const GetFearIndexAction: Action = {
    name: 'get_crypto_fear_index and plot_fear_index_chart',
    description: 'Get and visualize the cryptocurrency fear and greed index'

    ,
    handler: async (
        _runtime: IAgentRuntime,
        message: Memory,
        _state: State,
        _options: { [key: string]: unknown },
        callback: HandlerCallback
    ): Promise<boolean> => {
        try {
            // Parse days from parameters (from/to or days) or user message (default to 30 if not specified)
            let days = 30;

            // Priority 1: Compute days from from/to when both present
            if (_options?.from && _options?.to) {
                const fromStr = String(_options.from).trim();
                const toStr = String(_options.to).trim();
                const fromDate = new Date(fromStr.length === 10 ? fromStr + 'T00:00:00.000Z' : fromStr);
                const toDate = new Date(toStr.length === 10 ? toStr + 'T23:59:59.999Z' : toStr);
                if (!Number.isNaN(fromDate.getTime()) && !Number.isNaN(toDate.getTime()) && fromDate <= toDate) {
                    days = Math.ceil((toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24));
                    if (days < 1) days = 1;
                }
            } else if (_options?.days && typeof _options.days === 'number') {
                days = _options.days;
            }
            // Priority 2: Extract from user message text as fallback
            else {
                const daysMatch = message.content?.text?.match(/(\d+)\s*days?/i);
                if (daysMatch && daysMatch[1]) {
                    days = Number.parseInt(daysMatch[1]);
                }
            }

            // Cap at 400 days to prevent excessive API usage
            days = Math.min(Math.max(1, days), 400);
            let dataRetentionApplied = false;
            // Cap by data retention (subscription tier); enterprise (0) = no cap
            const dataRetentionDays = typeof _options?.dataRetentionDays === "number" ? _options.dataRetentionDays : undefined;
            if (typeof dataRetentionDays === "number" && dataRetentionDays > 0 && days > dataRetentionDays) {
                dataRetentionApplied = true;
                days = dataRetentionDays;
            }
            
            // Parse cryptocurrency from user message (default to BTC-USD)
            let cryptoSymbol = "BTC-USD";
            let cryptoCode = "BTC";
            
            // Comprehensive regex to catch all supported cryptocurrencies
            const cryptoRegexPattern = 
                /bitcoin|btc|ethereum|eth|tether|usdt|usd coin|usdc|solana|sol|xrp|ripple|bnb|dogecoin|doge|cardano|ada|tron|trx|avalanche|avax|shiba inu|shib|polygon|matic|litecoin|ltc|uniswap|uni|chainlink|link|bitcoin cash|bch|stellar|xlm|cosmos|atom|polkadot|dot/i;
            
            const cryptoMatch = message.content?.text?.match(cryptoRegexPattern);
            
            if (cryptoMatch) {
                const crypto = cryptoMatch[0].toLowerCase();
                
                // Map all the cryptocurrencies to their symbols
                if (crypto === 'ethereum' || crypto === 'eth') {
                    cryptoSymbol = 'ETH-USD';
                    cryptoCode = 'ETH';
                } else if (crypto === 'tether' || crypto === 'usdt') {
                    cryptoSymbol = 'USDT-USD';
                    cryptoCode = 'USDT';
                } else if (crypto === 'usd coin' || crypto === 'usdc') {
                    cryptoSymbol = 'USDC-USD';
                    cryptoCode = 'USDC';
                } else if (crypto === 'solana' || crypto === 'sol') {
                    cryptoSymbol = 'SOL-USD';
                    cryptoCode = 'SOL';
                } else if (crypto === 'ripple' || crypto === 'xrp') {
                    cryptoSymbol = 'XRP-USD';
                    cryptoCode = 'XRP';
                } else if (crypto === 'bnb') {
                    cryptoSymbol = 'BNB-USD';
                    cryptoCode = 'BNB';
                } else if (crypto === 'dogecoin' || crypto === 'doge') {
                    cryptoSymbol = 'DOGE-USD';
                    cryptoCode = 'DOGE';
                } else if (crypto === 'cardano' || crypto === 'ada') {
                    cryptoSymbol = 'ADA-USD';
                    cryptoCode = 'ADA';
                } else if (crypto === 'tron' || crypto === 'trx') {
                    cryptoSymbol = 'TRX-USD';
                    cryptoCode = 'TRX';
                } else if (crypto === 'avalanche' || crypto === 'avax') {
                    cryptoSymbol = 'AVAX-USD';
                    cryptoCode = 'AVAX';
                } else if (crypto === 'shiba inu' || crypto === 'shib') {
                    cryptoSymbol = 'SHIB-USD';
                    cryptoCode = 'SHIB';
                } else if (crypto === 'polygon' || crypto === 'matic') {
                    cryptoSymbol = 'MATIC-USD';
                    cryptoCode = 'MATIC';
                } else if (crypto === 'litecoin' || crypto === 'ltc') {
                    cryptoSymbol = 'LTC-USD';
                    cryptoCode = 'LTC';
                } else if (crypto === 'uniswap' || crypto === 'uni') {
                    cryptoSymbol = 'UNI-USD';
                    cryptoCode = 'UNI';
                } else if (crypto === 'chainlink' || crypto === 'link') {
                    cryptoSymbol = 'LINK-USD';
                    cryptoCode = 'LINK';
                } else if (crypto === 'bitcoin cash' || crypto === 'bch') {
                    cryptoSymbol = 'BCH-USD';
                    cryptoCode = 'BCH';
                } else if (crypto === 'stellar' || crypto === 'xlm') {
                    cryptoSymbol = 'XLM-USD';
                    cryptoCode = 'XLM';
                } else if (crypto === 'cosmos' || crypto === 'atom') {
                    cryptoSymbol = 'ATOM-USD';
                    cryptoCode = 'ATOM';
                } else if (crypto === 'polkadot' || crypto === 'dot') {
                    cryptoSymbol = 'DOT-USD';
                    cryptoCode = 'DOT';
                }
                // Bitcoin remains the default
            }
            
            // Get full cryptocurrency name for display
            const cryptoName = getCryptoName(cryptoCode);
            
            await callback(createActionResponse({
                actionName: "get_crypto_fear_index and plot_fear_index_chart",
                type: "get_crypto_fear_index",
                text: `Fetching the crypto fear and greed index and ${cryptoName} price data for the past ${days} days...`,
            }));
            
            // Fetch fear index data and price data in parallel
            const [fearData, priceData] = await Promise.all([
                getFearAndGreedIndex(days),
                getCryptoPriceData(cryptoSymbol, days)
            ]);
            
            if (!fearData || fearData.length === 0) {
                await callback(createActionErrorResponse({
                    actionName: "get_crypto_fear_index and plot_fear_index_chart",
                    type: "get_crypto_fear_index_error",
                    error: new Error("No fear index data available"),
                    text: "Sorry, I couldn't retrieve the fear and greed index data at this time.",
                }));
                return false;
            }
            
            if (priceData.length === 0) {
                await callback(createActionResponse({
                    actionName: "get_crypto_fear_index and plot_fear_index_chart",
                    type: "get_crypto_fear_index",
                    text: `I was able to fetch the fear index data, but couldn't retrieve ${cryptoName} price data. Continuing with fear index only.`,
                }));
                // Continue with fear index only in this case
            }
            
            // Get the output directory for charts - use a relative path from project root
            const outputDir = path.join(process.cwd(), 'saved_data', 'Charts');
            
            // Save visualization and open it
            const chartLocalPath = await saveFearIndexVisualization(fearData, priceData, outputDir, cryptoCode);
            const chartPath = buildChartProxyUrl(chartLocalPath, _runtime.agentId);
            
            // Get the latest fear index value
            // Sort data chronologically
            const sortedData = [...fearData].sort((a, b) => Number.parseInt(b.timestamp) - Number.parseInt(a.timestamp));
            const latestData = sortedData[0];
            const latestDate = formatDateUTC(new Date(Number.parseInt(latestData.timestamp) * 1000));
            
            // Get latest price if available
            let priceInfo = "";
            if (priceData.length > 0) {
                const latestPrice = priceData[priceData.length - 1].price;
                priceInfo = ` The current ${cryptoName} price is $${latestPrice.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}.`;
            }

            // Generate action summary
            const currentValue = latestData.value;
            const sentiment = latestData.value_classification;
            const actionSummary = generateActionSummary({
                actionName: 'Fear & Greed Index',
                assets: ['Crypto Market'],
                timePeriod: 'current',
                dataPoints: 1,
                additionalInfo: `index value ${currentValue}/100 (${sentiment})`
            });

            await callback(createActionResponse({
                actionName: "get_crypto_fear_index and plot_fear_index_chart",
                type: "get_crypto_fear_index",
                text: `The latest Crypto Fear & Greed Index is **${latestData.value}** (${latestData.value_classification}) as of ${latestDate}.${priceInfo}\n\nI've created a visualization showing both the fear index and ${cryptoName} price for the past ${days} days. The chart has been saved successfully.`,
                chartPath: chartPath,
                actionData: {
                    summary: actionSummary,
                },
                additionalMetadata: dataRetentionApplied ? { dataRetentionApplied: true } : undefined,
            }));
            
            return true;
        } catch (error) {
            console.error('Error in fear index action:', error);
            await callback(createActionErrorResponse({
                actionName: "get_crypto_fear_index and plot_fear_index_chart",
                type: "get_crypto_fear_index_error",
                error: error instanceof Error ? error : new Error(String(error)),
                text: `Sorry, I encountered an error while fetching the fear and greed index: ${error.message}`,
            }));
            return false;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show me the crypto fear and greed index",
                    action: "get_crypto_fear_index"
                }
            },
            {
                user: "{{user2}}",
                content: {
                    text: "The latest Crypto Fear & Greed Index is 38 (Fear) as of Mon May 12 2023. The current Bitcoin price is $27,340.25. I've created a visualization showing both the fear index and cryptocurrency price for the past 30 days that you can view.",
                    action: "get_crypto_fear_index"
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Display the ethereum fear index for the last 60 days",
                    action: "get_crypto_fear_index"
                }
            },
            {
                user: "{{user2}}",
                content: {
                    text: "The latest Crypto Fear & Greed Index is 34 (Fear) as of Mon May 12 2023. The current Ethereum price is $1,865.78. I've created a visualization showing both the fear index and cryptocurrency price for the past 60 days that you can view.",
                    action: "get_crypto_fear_index"
                }
            }
        ],
    ] as ActionExample[][],
};

