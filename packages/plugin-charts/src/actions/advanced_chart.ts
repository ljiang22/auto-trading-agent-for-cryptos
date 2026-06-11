import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type {
    ActionExample,
    IAgentRuntime,
    Memory,
    Action,
    State,
    HandlerCallback
} from "@elizaos/core";
import { elizaLogger, createActionResponse, createActionErrorResponse, generateActionSummary, clampDateRangeToRetention, buildChartProxyUrl } from "@elizaos/core";
import { extractCryptocurrencyTypes, getCryptoFullName } from './request';
import { downloadCryptoData } from './get_data'; 

// Convert exec to Promise-based
const execPromise = promisify(exec);

// Helper function to format dates in UTC without showing UTC suffix
function formatDateUTC(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Date validation utilities
function isValidDateString(dateString: string): boolean {
  if (!dateString || typeof dateString !== 'string') {
    return false;
  }

  // Check format YYYY-MM-DD
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateString)) {
    return false;
  }

  // Check if it's a valid date
  const date = new Date(dateString + 'T00:00:00.000Z');
  return date.toISOString().substr(0, 10) === dateString;
}

function parseDate(dateString: string): Date | null {
  if (!isValidDateString(dateString)) {
    return null;
  }
  return new Date(dateString + 'T00:00:00.000Z');
}

function calculateDaysDifference(startDate: string, endDate: string): number {
  const start = parseDate(startDate);
  const end = parseDate(endDate);

  if (!start || !end) {
    return 0;
  }

  const diffTime = end.getTime() - start.getTime();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

interface BTCDataPoint {
  Date: string;
  Price: number;
  High: number;
  Low: number;
  Open: number;
  Volume: number;
}

interface PeriodParams {
  from?: string;
  to?: string;
}

interface DateRange {
  startDate: string;
  endDate: string;
  isCustomRange: boolean;
  totalDays: number;
}

function safeParseNumber(value: string | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }

  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

// Parse CSV data
function parseCSV(csvData: string): BTCDataPoint[] {
  const lines = csvData.trim().split('\n');

  if (lines.length <= 1) {
    return [];
  }

  const dataLines = lines.slice(1);
  const data: BTCDataPoint[] = [];

  for (const rawLine of dataLines) {
    if (!rawLine.trim()) {
      continue;
    }

    const values = rawLine.split(',');

    if (values.length < 7) {
      continue;
    }

    const date = values[0]?.trim();
    const price = safeParseNumber(values[4]);

    if (!date || price === null) {
      continue;
    }

    const open = safeParseNumber(values[1]) ?? price;
    const high = safeParseNumber(values[2]) ?? price;
    const low = safeParseNumber(values[3]) ?? price;
    const volume = safeParseNumber(values[6]) ?? 0;

    data.push({
      Date: date,
      Open: open,
      High: high,
      Low: low,
      Price: price,
      Volume: volume
    });
  }

  return data;
}

// Get date range for filtering (legacy function for backward compatibility)
function getDateRange(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return formatDateUTC(date);
}

// Enhanced date range functions for period parameters
function parsePeriodParams(options: { [key: string]: unknown }): DateRange {
  const today = formatDateUTC(new Date());

  // Check for custom from/to parameters (accept YYYY-MM-DD or YYYY-MM-DDTHH:mm; use date part for range)
  if (options.from && options.to) {
    const fromStr = String(options.from).trim().slice(0, 10);
    const toStr = String(options.to).trim().slice(0, 10);

    if (fromStr.length === 10 && toStr.length === 10 && isValidDateString(fromStr) && isValidDateString(toStr)) {
      const fromDate = parseDate(fromStr);
      const toDate = parseDate(toStr);

      if (fromDate && toDate && fromDate <= toDate) {
        return {
          startDate: fromStr,
          endDate: toStr,
          isCustomRange: true,
          totalDays: calculateDaysDifference(fromStr, toStr)
        };
      }
    }
  }

  // No from/to: use default 30 days
  const days = 30;
  const startDate = getDateRange(days);
  return {
    startDate,
    endDate: today,
    isCustomRange: false,
    totalDays: days
  };
}

function filterDataByDateRange(data: BTCDataPoint[], dateRange: DateRange): BTCDataPoint[] {
  return data.filter(point =>
    point.Date >= dateRange.startDate && point.Date <= dateRange.endDate
  );
}

function buildPriceChartData(data: BTCDataPoint[], dateRange: DateRange) {
  const filteredData = filterDataByDateRange(data, dateRange);

  return {
    labels: filteredData.map((point) => point.Date),
    priceData: filteredData.map((point) => point.Price),
    volumeData: filteredData.map((point) => point.Volume / 1000000),
  };
}

// Generate HTML for chart visualization
function generateChartHTML(data: BTCDataPoint[], dateRange: DateRange, cryptoSymbol = 'BTC-USD', cryptoName = 'Bitcoin'): string {
  const filteredData = filterDataByDateRange(data, dateRange);
  const chartData = buildPriceChartData(data, dateRange);
  const dates = chartData.labels.map(point => `"${point}"`).join(',');
  const prices = chartData.priceData.join(',');
  const volumes = chartData.volumeData.join(',');
  
  const periodTitle = dateRange.isCustomRange
    ? `${dateRange.startDate} to ${dateRange.endDate}`
    : `${dateRange.totalDays} Days`;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${cryptoName} Price Chart</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js" crossorigin="anonymous" onerror="document.body.innerHTML='<p style=\\'font-family:sans-serif;padding:1rem\\'>Chart library failed to load. Check network or try opening this page in a new tab.</p>'"></script>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; padding: 20px; min-height: 100%; }
    .chart-container { position: relative; height: clamp(240px, 40vw, 480px); width: 100%; max-width: 1200px; margin: 0 auto; }
    h1 { text-align: center; color: #333; margin: 10px 0 20px 0; font-size: 1.5rem; }
    .summary { margin: 15px 0; padding: 12px; background-color: #f5f5f5; border-radius: 5px; }
    .summary p { margin: 5px 0; font-size: 0.9rem; }
    .period-info { margin: 10px 0; text-align: center; color: #666; font-style: italic; font-size: 0.9rem; }
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
    body.compact-view .period-info { display: none; }
    body.compact-view canvas { max-height: none !important; }
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
  <h1>${cryptoName} Price Chart</h1>
  <div class="period-info">Period: ${periodTitle} (${dateRange.totalDays} days)</div>
  
  <div class="summary">
    <p><strong>Start Date:</strong> ${filteredData[0]?.Date || 'N/A'}</p>
    <p><strong>End Date:</strong> ${filteredData[filteredData.length - 1]?.Date || 'N/A'}</p>
    <p><strong>Starting Price:</strong> $${filteredData[0]?.Price.toLocaleString() || 'N/A'}</p>
    <p><strong>Ending Price:</strong> $${filteredData[filteredData.length - 1]?.Price.toLocaleString() || 'N/A'}</p>
    <p><strong>Highest Price:</strong> $${Math.max(...filteredData.map(d => d.Price)).toLocaleString()}</p>
    <p><strong>Lowest Price:</strong> $${Math.min(...filteredData.map(d => d.Price)).toLocaleString()}</p>
  </div>
  
  <div class="chart-container">
    <canvas id="btcChart"></canvas>
  </div>

  <script>
    const ctx = document.getElementById('btcChart').getContext('2d');
    
    const dates = [${dates}];
    const prices = [${prices}];
    const volumes = [${volumes}];
    
    new Chart(ctx, {
      type: 'line',
      data: {
        labels: dates,
        datasets: [
          {
            label: '${cryptoSymbol} Price (USD)',
            data: prices,
            borderColor: 'rgb(75, 192, 192)',
            backgroundColor: 'rgba(75, 192, 192, 0.1)',
            borderWidth: 2,
            tension: 0.1,
            yAxisID: 'y'
          },
          {
            label: 'Volume (Millions USD)',
            data: volumes,
            borderColor: 'rgb(153, 102, 255)',
            backgroundColor: 'rgba(153, 102, 255, 0.2)',
            borderWidth: 1,
            type: 'bar',
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
        scales: {
          x: {
            ticks: {
              maxRotation: 45,
              minRotation: 45
            }
          },
          y: {
            type: 'linear',
            display: true,
            position: 'left',
            title: {
              display: true,
              text: 'Price (USD)'
            }
          },
          y1: {
            type: 'linear',
            display: true,
            position: 'right',
            grid: {
              drawOnChartArea: false,
            },
            title: {
              display: true,
              text: 'Volume (Millions USD)'
            }
          }
        }
      }
    });

    // Send height to parent window for iframe auto-sizing.
    // In compact view, body has min-height: 0 and only .chart-container is
    // visible, so body.scrollHeight is exactly the content height. The
    // html.* measurements reflect the iframe's current viewport (i.e. the
    // height the parent set on us), so including them creates a self-
    // perpetuating gap below the plot when the plot is shorter than the
    // iframe.
    function sendHeightToParent() {
      const body = document.body;
      const html = document.documentElement;
      const isCompact = body.classList.contains('compact-view');
      const height = isCompact
        ? Math.ceil(body.scrollHeight)
        : Math.max(
            body.scrollHeight,
            body.offsetHeight,
            html.clientHeight,
            html.scrollHeight,
            html.offsetHeight
          );
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
</body>
</html>
  `;
}

// Check if data is from today or needs to be updated
function isDataFresh(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) {
      return false;
    }

    // Extract date from filename (assuming format like 'btc_data_2023-04-28.csv')
    const fileName = path.basename(filePath);
    const dateMatch = fileName.match(/\d{4}-\d{2}-\d{2}/);
    
    if (!dateMatch) {
      return false;
    }
    
    const fileDate = dateMatch[0];
    const today = formatDateUTC(new Date());
    
    return fileDate === today;
  } catch (error) {
    console.error('Error checking data freshness:', error);
    return false;
  }
}

// Utility function to determine date range string for filename
function determineDateRangeString(dateRange: DateRange): string {
    // If same date, return single date, otherwise return range with ~ separator
    return dateRange.startDate === dateRange.endDate
        ? dateRange.startDate
        : `${dateRange.startDate}~${dateRange.endDate}`;
}

// Delete previous charts for the specified crypto with the same date range
function deletePreviousCharts(cryptoSymbol: string, dateRangeString: string, outputDir: string): void {
    try {
        if (!fs.existsSync(outputDir)) {
            return; // No directory, no files to delete
        }

        const files = fs.readdirSync(outputDir);

        // Updated pattern to match EXACT date range: Price Chart [TICKER] [EXACT_DATE_RANGE].html
        const cryptoTicker = cryptoSymbol.split('-')[0]; // Extract ticker like BTC from BTC-USD
        // Escape special characters in date range string for regex
        const escapedDateRange = dateRangeString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const chartFilePattern = new RegExp(`^Price Chart ${cryptoTicker} ${escapedDateRange}\\.html$`);

        // Find matching files with the exact same date range
        const matchingFiles = files.filter(file => chartFilePattern.test(file));

        // Note: Chart deletion disabled to preserve historical data
        // Old charts are now kept for reference in chat history
        if (matchingFiles.length > 0) {
            console.log(`Found ${matchingFiles.length} existing chart(s) with same date range (keeping for history)`);
        }

        // Delete only files with the exact same date range
        // matchingFiles.forEach(file => {
        //     const filePath = path.join(outputDir, file);
        //     fs.unlinkSync(filePath);
        //     console.log(`Deleted chart with same date range: ${filePath}`);
        // });

    } catch (error) {
        console.error('Error deleting charts with same date range:', error);
    }
}

// Calculate important market analytics
function calculateMarketAnalytics(data: BTCDataPoint[], dateRange: DateRange): {
  priceAnalytics: {
    currentPrice: number;
    startPrice: number;
    highestPrice: number;
    lowestPrice: number;
    priceChange: number;
    priceChangePercent: number;
    volatility: number;
    averagePrice: number;
  };
  volumeAnalytics: {
    averageVolume: number;
    totalVolume: number;
    highestVolumeDay: { date: string; volume: number };
    lowestVolumeDay: { date: string; volume: number };
  };
  trendAnalytics: {
    trend: 'bullish' | 'bearish' | 'sideways';
    consecutiveGreenDays: number;
    consecutiveRedDays: number;
    supportLevel: number;
    resistanceLevel: number;
  };
  riskMetrics: {
    maxDrawdown: number;
    sharpeRatio: number;
    dailyReturns: number[];
  };
} {
  // Filter data based on date range
  const filteredData = filterDataByDateRange(data, dateRange);
  
  if (filteredData.length === 0) {
    throw new Error('No data available for the specified time range');
  }

  // Price Analytics
  const prices = filteredData.map(d => d.Price);
  const currentPrice = prices[prices.length - 1];
  const startPrice = prices[0];
  const highestPrice = Math.max(...prices);
  const lowestPrice = Math.min(...prices);
  const priceChange = currentPrice - startPrice;
  const priceChangePercent = (priceChange / startPrice) * 100;
  const averagePrice = prices.reduce((sum, price) => sum + price, 0) / prices.length;
  
  // Calculate volatility (standard deviation of daily returns)
  const dailyReturns = [];
  for (let i = 1; i < prices.length; i++) {
    const dailyReturn = (prices[i] - prices[i - 1]) / prices[i - 1];
    dailyReturns.push(dailyReturn);
  }
  const avgReturn = dailyReturns.length > 0
    ? dailyReturns.reduce((sum, ret) => sum + ret, 0) / dailyReturns.length
    : 0;
  const variance = dailyReturns.length > 0
    ? dailyReturns.reduce((sum, ret) => sum + Math.pow(ret - avgReturn, 2), 0) / dailyReturns.length
    : 0;
  const volatility = Math.sqrt(variance) * 100; // Convert to percentage

  // Volume Analytics
  const volumes = filteredData.map(d => Number.isFinite(d.Volume) ? d.Volume : 0);
  const averageVolume = volumes.reduce((sum, vol) => sum + vol, 0) / volumes.length;
  const totalVolume = volumes.reduce((sum, vol) => sum + vol, 0);
  const maxVolumeValue = Math.max(...volumes);
  const minVolumeValue = Math.min(...volumes);
  const maxVolumeIndex = volumes.indexOf(maxVolumeValue);
  const minVolumeIndex = volumes.indexOf(minVolumeValue);
  const resolveVolumeIndex = (index: number): number => {
    if (index >= 0 && index < filteredData.length) {
      return index;
    }
    return filteredData.length - 1;
  };
  const highestVolumeIndex = resolveVolumeIndex(maxVolumeIndex);
  const lowestVolumeIndex = resolveVolumeIndex(minVolumeIndex);
  const highestVolumeDay = {
    date: filteredData[highestVolumeIndex].Date,
    volume: volumes[highestVolumeIndex],
  };
  const lowestVolumeDay = {
    date: filteredData[lowestVolumeIndex].Date,
    volume: volumes[lowestVolumeIndex],
  };

  // Trend Analytics
  let consecutiveGreenDays = 0;
  let consecutiveRedDays = 0;
  let currentStreak = 0;
  let isGreenStreak = false;
  
  for (let i = 1; i < filteredData.length; i++) {
    const isGreen = filteredData[i].Price > filteredData[i - 1].Price;
    
    if (i === 1) {
      isGreenStreak = isGreen;
      currentStreak = 1;
    } else if (isGreen === isGreenStreak) {
      currentStreak++;
    } else {
      if (isGreenStreak) {
        consecutiveGreenDays = Math.max(consecutiveGreenDays, currentStreak);
      } else {
        consecutiveRedDays = Math.max(consecutiveRedDays, currentStreak);
      }
      isGreenStreak = isGreen;
      currentStreak = 1;
    }
  }
  
  // Final streak check
  if (isGreenStreak) {
    consecutiveGreenDays = Math.max(consecutiveGreenDays, currentStreak);
  } else {
    consecutiveRedDays = Math.max(consecutiveRedDays, currentStreak);
  }

  // Determine overall trend
  const trend = priceChangePercent > 5 ? 'bullish' : 
                priceChangePercent < -5 ? 'bearish' : 'sideways';

  // Support and resistance levels (simplified)
  const sortedPrices = [...prices].sort((a, b) => a - b);
  const supportLevel = sortedPrices[Math.floor(sortedPrices.length * 0.2)]; // 20th percentile
  const resistanceLevel = sortedPrices[Math.floor(sortedPrices.length * 0.8)]; // 80th percentile

  // Risk Metrics
  // Max Drawdown
  let maxDrawdown = 0;
  let peak = prices[0];
  for (const price of prices) {
    if (price > peak) {
      peak = price;
    }
    const drawdown = (peak - price) / peak;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  // Sharpe Ratio (simplified, assuming risk-free rate of 0)
  const avgDailyReturn = avgReturn;
  const dailyReturnStd = Math.sqrt(variance);
  const sharpeRatio = dailyReturnStd !== 0 ? avgDailyReturn / dailyReturnStd : 0;

  return {
    priceAnalytics: {
      currentPrice,
      startPrice,
      highestPrice,
      lowestPrice,
      priceChange,
      priceChangePercent,
      volatility,
      averagePrice
    },
    volumeAnalytics: {
      averageVolume,
      totalVolume,
      highestVolumeDay,
      lowestVolumeDay
    },
    trendAnalytics: {
      trend,
      consecutiveGreenDays,
      consecutiveRedDays,
      supportLevel,
      resistanceLevel
    },
    riskMetrics: {
      maxDrawdown: maxDrawdown * 100, // Convert to percentage
      sharpeRatio,
      dailyReturns
    }
  };
}

export const PlotChartAction: Action = {
  name: 'plot_price_charts',
  description: 'Can get cryptocurreny price data and generate cryptocurrency price chart visualization for a date range. Use "from" and "to" parameters (YYYY-MM-DD).'

    ,
    handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
    options: { [key: string]: unknown },
    _callback: HandlerCallback
  ): Promise<boolean> => {
      const signal = options?.signal as AbortSignal | undefined;
      try {
        // Parse date range from options parameters or message
        let dateRange: DateRange;

        // Parse date range from options (from/to only)
        if (options) {
          dateRange = parsePeriodParams(options);
          const retention = {
            dataRetentionDays: options.dataRetentionDays as number | undefined,
            dataRetentionMinDaysAgo: options.dataRetentionMinDaysAgo as number | undefined,
            dataRetentionMaxDaysAgo: options.dataRetentionMaxDaysAgo as number | undefined,
          };
          if (
            (typeof retention.dataRetentionDays === "number" && retention.dataRetentionDays >= 0) ||
            (typeof retention.dataRetentionMinDaysAgo === "number" && typeof retention.dataRetentionMaxDaysAgo === "number")
          ) {
            dateRange = { ...dateRange, ...clampDateRangeToRetention(dateRange, retention) };
          }
        } else {
          // Fallback to parsing from message content for backward compatibility
          let timeRange = 30; // Default 30 days
          if (_message?.content?.text) {
            const text = _message.content.text.toLowerCase();
            const timeRangeMatch = text.match(/(\d+)\s*days?/);
            if (timeRangeMatch && timeRangeMatch[1]) {
              timeRange = Number.parseInt(timeRangeMatch[1], 10);
            }
          }

          // Create DateRange object for backward compatibility
          const today = formatDateUTC(new Date());
          const startDate = getDateRange(timeRange);
          dateRange = {
            startDate,
            endDate: today,
            isCustomRange: false,
            totalDays: timeRange
          };
        }
        
        // Detect cryptocurrency from options or message
        let cryptoSymbol: string;
        if (options && options.target) {
          cryptoSymbol = `${options.target.toString().toUpperCase()}-USD`;
        } else if (options && options.symbol && (typeof options.symbol === 'string' || typeof options.symbol === 'number')) {
          cryptoSymbol = `${options.symbol.toString().toUpperCase()}-USD`;
        } else {
          // Fallback to detecting from message
          const cryptoSymbols = extractCryptocurrencyTypes(_message);
          cryptoSymbol = cryptoSymbols[0]; // Use the first detected cryptocurrency
        }
        const cryptoName = getCryptoFullName(cryptoSymbol);
        
        // Get crypto code (e.g., BTC from BTC-USD)
        const cryptoCode = cryptoSymbol.split('-')[0].toLowerCase();
        
        // Path to crypto data CSV file - use consistent path resolution
        const dataDir = path.join(process.cwd(), 'saved_data');
        const cryptoDataDir = path.join(dataDir, 'Crypto_Data');
        
        // Create crypto data directory if it doesn't exist
        if (!fs.existsSync(cryptoDataDir)) {
            fs.mkdirSync(cryptoDataDir, { recursive: true });
            console.log(`Created directory: ${cryptoDataDir}`);
        }
        
        // Get today's date in YYYY-MM-DD format
        const today = formatDateUTC(new Date());
        
        // Check if today's data file exists
        const todaysCsvPath = path.join(cryptoDataDir, `${cryptoCode}_data_${today}.csv`);
        let csvPath = '';
        
        // Initialize data status message
        let dataStatus = '';
        
        // Check if we have fresh data
        if (isDataFresh(todaysCsvPath)) {
          csvPath = todaysCsvPath;
          dataStatus = 'Using existing fresh data.';
        } else {
          // Try to find the most recent data file (only if directory exists and has files)
          let files: string[] = [];
          try {
            files = fs.readdirSync(cryptoDataDir);
          } catch (error) {
            // Directory doesn't exist or can't be read, will download fresh data
            files = [];
          }
          const dataFilePattern = new RegExp(`^${cryptoCode}_data_\\d{4}-\\d{2}-\\d{2}\\.csv$`);
          const matchingFiles = files.filter(file => dataFilePattern.test(file))
            .sort((a, b) => b.localeCompare(a)); // Sort descending to get the most recent file first
          if (matchingFiles.length > 0) {
            const mostRecentPath = path.join(cryptoDataDir, matchingFiles[0]);
            
            // Check if most recent data is fresh enough
            if (isDataFresh(mostRecentPath)) {
              csvPath = mostRecentPath;
              dataStatus = 'Using existing fresh data.';
            } else {
              // Data not fresh, download new data
              dataStatus = `Getting fresh data.`;
              csvPath = await downloadCryptoData(cryptoSymbol, signal);
            }
          } else {
            // No existing data file found, download fresh data
            dataStatus = `No existing ${cryptoName} data found. Downloaded fresh data.`;
            csvPath = await downloadCryptoData(cryptoSymbol, signal);
          }
        }
        
        // Read CSV file
        let csvData;
        try {
          csvData = fs.readFileSync(csvPath, 'utf8');
        } catch (error) {
          // If reading failed, download fresh data and update status
          dataStatus = `Error reading ${cryptoName} data. Downloaded fresh data and removed old files.`;
          csvPath = await downloadCryptoData(cryptoSymbol, signal);
          csvData = fs.readFileSync(csvPath, 'utf8');
        }
        
        // Parse CSV data
        const parsedData = parseCSV(csvData);
        
        // Check if we have data for the selected time range
        if (parsedData.length === 0) {
          await _callback(createActionErrorResponse({
            actionName: "plot_price_charts",
            type: "plot_price_charts_error",
            error: new Error("No data available"),
            text: `No data available for ${cryptoName}. Please try another cryptocurrency.`,
          }));
          return false;
        }
        
        // Calculate market analytics
        const marketAnalytics = calculateMarketAnalytics(parsedData, dateRange);

        // Generate HTML chart with cryptocurrency information
        const htmlContent = generateChartHTML(parsedData, dateRange, cryptoSymbol, cryptoName);
        
        // Create outputs directory using consistent path resolution
        const outputDir = path.join(dataDir, 'Charts');
        
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
            console.log(`Created directory: ${dataDir}`);
        }
        
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
            console.log(`Created directory: ${outputDir}`);
        }

        // Get crypto ticker for filename
        const cryptoTicker = cryptoSymbol.split('-')[0]; // Extract ticker like BTC from BTC-USD

        // Generate standardized filename format: [Chart Title] [Ticker] [Period],
        const dateRangeString = determineDateRangeString(dateRange);

        // Delete previous chart files for this cryptocurrency with the same date range
        deletePreviousCharts(cryptoSymbol, dateRangeString, outputDir);

        const outputPath = path.join(outputDir, `Price Chart ${cryptoTicker} ${dateRangeString}.html`);
        
        fs.writeFileSync(outputPath, htmlContent);
        
        // Save market analytics to AI state for internal use
        const relativePath = path.relative(process.cwd(), outputPath);
        const chartS3Url = buildChartProxyUrl(outputPath, _runtime.agentId);
        const marketData = {
          chartPath: chartS3Url,
          chartData: buildPriceChartData(parsedData, dateRange),
          cryptoSymbol,
          cryptoName,
          dateRange,
          timeRange: dateRange.totalDays, // For backward compatibility
          marketAnalytics,
          dataPoints: parsedData.length,
          analysisDate: today,
          // Key insights for AI decision making
          keyInsights: {
            isPerformingWell: marketAnalytics.priceAnalytics.priceChangePercent > 0,
            volatilityLevel: marketAnalytics.priceAnalytics.volatility > 5 ? 'high' : marketAnalytics.priceAnalytics.volatility > 2 ? 'medium' : 'low',
            trendStrength: Math.abs(marketAnalytics.priceAnalytics.priceChangePercent),
            riskLevel: marketAnalytics.riskMetrics.maxDrawdown > 20 ? 'high' : marketAnalytics.riskMetrics.maxDrawdown > 10 ? 'medium' : 'low',
            volumeTrend: marketAnalytics.volumeAnalytics.averageVolume > 1000000000 ? 'high' : 'normal',
            recommendation: marketAnalytics.trendAnalytics.trend === 'bullish' && marketAnalytics.riskMetrics.maxDrawdown < 15 ? 'positive' : 
                           marketAnalytics.trendAnalytics.trend === 'bearish' || marketAnalytics.riskMetrics.maxDrawdown > 20 ? 'negative' : 'neutral'
          }
        };

        // Store analytics in AI state for internal access
        if (_state) {
            _state.marketAnalytics = marketData;
        }
        
        // Simple user-facing message
        elizaLogger.info(`[AdvancedChart] Generated chart for ${cryptoName}, calling callback with chartPath: ${marketData.chartPath}`);
        elizaLogger.debug(`[AdvancedChart] Full callback metadata:`, marketData);
        
        const periodDescription = dateRange.isCustomRange
          ? `from ${dateRange.startDate} to ${dateRange.endDate}`
          : `for the last ${dateRange.totalDays} days`;

        // Generate action summary
        const timePeriod = dateRange.isCustomRange
          ? `${dateRange.startDate} to ${dateRange.endDate}`
          : `${dateRange.totalDays} days`;
        const trendInfo = marketAnalytics.trendAnalytics.trend;
        const priceChangePercent = marketAnalytics.priceAnalytics.priceChangePercent;
        const changeSign = priceChangePercent > 0 ? '+' : '';

        const actionSummary = generateActionSummary({
          actionName: 'Price Chart',
          assets: [cryptoTicker],
          timePeriod: timePeriod,
          dataPoints: parsedData.length,
          additionalInfo: `${trendInfo} trend, ${changeSign}${priceChangePercent.toFixed(1)}% change`
        });

        await _callback(createActionResponse({
          actionName: "plot_price_charts",
          type: "plot_price_charts",
          text: `${dataStatus} I've generated a ${cryptoName} price chart ${periodDescription} and analyzed the market data. The chart has been saved successfully.`,
          chartPath: marketData.chartPath,
          actionData: {
            ...marketData,
            summary: actionSummary,
          },
          additionalMetadata: {
            cryptoSymbol: marketData.cryptoSymbol,
            cryptoName: marketData.cryptoName,
            dateRange: marketData.dateRange,
            timeRange: marketData.timeRange,
            dataPoints: marketData.dataPoints,
            analysisDate: marketData.analysisDate,
            keyInsights: marketData.keyInsights,
          },
        }));
        return true;
      } catch (error) {
        console.error('Error in chart generation:', error);
        await _callback(createActionErrorResponse({
          actionName: "plot_price_charts",
          type: "plot_price_charts_error",
          error: error instanceof Error ? error : new Error(String(error)),
          text: `Sorry, I encountered an error while generating the chart: ${error.message}`,
        }));
        return false;
      }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "Can you show me a Bitcoin price chart?",
          action: "plot_btc_chart"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "I've created a Bitcoin price chart for the last 30 days showing both price and trading volume. The chart has been saved and you can view it to see price trends and market activity during this period.",
          action: "plot_btc_chart"
        }
      }
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Show me Ethereum's performance for the last 60 days",
          action: "plot_btc_chart"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "I've generated an Ethereum price chart covering the last 60 days. The visualization includes daily price movements and corresponding trading volumes. The chart has been saved and you can open it to analyze the Ethereum market trends.",
          action: "plot_btc_chart"
        }
      }
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Generate a Bitcoin chart from 2025-08-10 to 2025-09-15",
          action: "plot_btc_chart"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "I've generated a Bitcoin price chart from 2025-08-10 to 2025-09-15 and analyzed the market data. The chart shows price movements and trading volume for this specific 36-day period. The chart has been saved successfully.",
          action: "plot_btc_chart"
        }
      }
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Show me Solana performance between 2025-07-01 and 2025-08-01",
          action: "plot_btc_chart"
        }
      },
      {
        user: "{{user2}}",
        content: {
          text: "I've created a Solana price chart from 2025-07-01 to 2025-08-01 and performed market analysis. The visualization covers this specific 31-day period showing detailed price trends and volume data. The chart has been saved successfully.",
          action: "plot_btc_chart"
        }
      }
    ],
  ] as ActionExample[][],
} as Action;
