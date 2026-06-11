import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { exec } from 'child_process';
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

const API_KEY = getProductionEnvVariable('COINMARKETCAP_API_KEY');
const API_URL = 'https://pro-api.coinmarketcap.com/v3/fear-and-greed/historical';

// Convert exec to Promise-based
const execPromise = promisify(exec);

// Helper function to format dates in UTC without showing UTC suffix
function formatDateUTC(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Helper function to format date with hours in UTC
function formatDateTimeUTC(date: Date): string {
  const dateStr = formatDateUTC(date);
  const hours = String(date.getUTCHours()).padStart(2, '0');
  return `${dateStr} ${hours}:00`;
}

if (!API_KEY) {
    console.warn('COINMARKETCAP_API_KEY is not set. Fear index data may not be available.');
}

interface FearIndexDataPoint {
    timestamp: string;
    value: number;
    value_classification: string;
    datetime?: Date; // Added for 4-hour interval calculations
}

/**
 * Fetches detailed fear and greed index data with customizable interval
 * @param hours Number of hours to fetch data for (default: 168 = 7 days)
 * @param intervalHours Size of each interval in hours (default: 4)
 * @returns Array of fear index data points with specified intervals
 */
export async function getDetailedFearIndex(hours = 168, intervalHours = 4): Promise<FearIndexDataPoint[]> {
    try {
        // Calculate days needed based on hours (rounded up)
        const days = Math.ceil(hours / 24);
        
        // Fetch raw data
        const response = await httpClient.get(API_URL, {
            headers: {
                'X-CMC_PRO_API_KEY': API_KEY
            },
            params: {
                limit: Math.max(days + 1, 30), // Ensure we have enough data
                format: 'json'
            }
        });

        // Debug response structure
        console.log('API Response structure:', JSON.stringify({
            hasData: !!response.data,
            dataKeys: response.data ? Object.keys(response.data) : [],
            dataIsArray: response.data && response.data.data ? Array.isArray(response.data.data) : false,
            sampleData: response.data && response.data.data && Array.isArray(response.data.data) && response.data.data.length > 0
                ? response.data.data[0],
                : null
        }, null, 2));

        // Check for valid response format
        if (!response.data || !response.data.data || !Array.isArray(response.data.data)) {
            throw new Error('Invalid response format from CoinMarketCap API');
        }

        // Process data to include datetime objects
        const rawData: FearIndexDataPoint[] = response.data.data;
        const processedData = rawData.map(point => ({
            ...point,
            datetime: new Date(Number.parseInt(point.timestamp) * 1000)
        }));

        // Sort chronologically
        const sortedData = processedData.sort((a, b) => {
            return a.datetime!.getTime() - b.datetime!.getTime();
        });

        // Filter for required timeframe (get data for specified hours)
        const cutoffTime = new Date();
        cutoffTime.setUTCHours(cutoffTime.getUTCHours() - hours);
        
        const filteredData = sortedData.filter(point => 
            point.datetime! >= cutoffTime
        );

        // Group by specified interval
        const intervalData: FearIndexDataPoint[] = [];
        
        // If we have no data, return empty array
        if (filteredData.length === 0) {
            return intervalData;
        }
        
        let currentInterval = new Date(filteredData[0]?.datetime || new Date());
        
        // Round to nearest interval
        currentInterval.setUTCMinutes(0, 0, 0);
        currentInterval.setUTCHours(Math.floor(currentInterval.getUTCHours() / intervalHours) * intervalHours);
        
        const endTime = new Date();
        
        while (currentInterval <= endTime) {
            const nextInterval = new Date(currentInterval);
            nextInterval.setUTCHours(nextInterval.getUTCHours() + intervalHours);
            
            // Find data points in this interval
            const pointsInInterval = filteredData.filter(point => 
                point.datetime! >= currentInterval && point.datetime! < nextInterval
            );
            
            if (pointsInInterval.length > 0) {
                // Use the most recent datapoint in the interval
                const latestPoint = pointsInInterval.reduce((latest, current) => {
                    return latest.datetime!.getTime() > current.datetime!.getTime() ? latest : current;
                });
                
                intervalData.push({
                    ...latestPoint,
                    timestamp: (currentInterval.getTime() / 1000).toString(),
                    datetime: new Date(currentInterval)
                });
            } else {
                // If no data in this interval, interpolate from adjacent intervals
                // This is a simplistic approach - more sophisticated methods could be used
                const latestBeforeInterval = filteredData
                    .filter(p => p.datetime! < currentInterval)
                    .sort((a, b) => b.datetime!.getTime() - a.datetime!.getTime())[0];
                
                if (latestBeforeInterval) {
                    // Just use the previous value if we have one
                    intervalData.push({
                        ...latestBeforeInterval,
                        timestamp: (currentInterval.getTime() / 1000).toString(),
                        datetime: new Date(currentInterval)
                    });
                }
            }
            
            // Move to next interval
            currentInterval = nextInterval;
        }
        
        return intervalData;
    } catch (error) {
        console.error('Error fetching detailed fear index:', error);
        throw error;
    }
}

/**
 * Generate HTML for a detailed fear index chart with custom intervals
 */
function generateDetailedFearIndexHTML(fearData: FearIndexDataPoint[], intervalHours = 4): string {
    // Sort fear data chronologically for proper display
    const sortedFearData = [...fearData].sort((a, b) => 
        Number.parseInt(a.timestamp) - Number.parseInt(b.timestamp)
    );
    
    // Prepare formatted data for chart
    const chartDates = [];
    const fearValues = [];
    const classifications = [];
    
    sortedFearData.forEach(point => {
        const date = new Date(Number.parseInt(point.timestamp) * 1000);
        const formattedDate = formatDateTimeUTC(date);
        chartDates.push(`"${formattedDate}"`);
        fearValues.push(point.value);
        classifications.push(`"${point.value_classification}"`);
    });

    // Calculate stats for summary
    const latestFear = sortedFearData[sortedFearData.length-1];
    const latestValue = latestFear.value;
    const latestClassification = latestFear.value_classification;
    const startDate = formatDateTimeUTC(new Date(Number.parseInt(sortedFearData[0].timestamp) * 1000));
    const endDate = formatDateTimeUTC(new Date(Number.parseInt(sortedFearData[sortedFearData.length-1].timestamp) * 1000));
    const highestValue = Math.max(...sortedFearData.map(d => d.value));
    const lowestValue = Math.min(...sortedFearData.map(d => d.value));
    
    // Format interval for display
    const intervalDisplay = intervalHours === 1 ? 'Hourly' : 
                           intervalHours === 24 ? 'Daily' : 
                           `${intervalHours}-Hour`;
    
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Detailed Crypto Fear & Greed Index (${intervalDisplay} Intervals)</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js" crossorigin="anonymous" onerror="document.body.innerHTML='<p style=\\'font-family:sans-serif;padding:1rem\\'>Chart library failed to load. Check network or try opening this page in a new tab.</p>'"></script>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; padding: 20px; min-height: 100%; }
    .chart-container { position: relative; height: clamp(240px, 40vw, 480px); width: 100%; max-width: 1200px; margin: 0 auto; }
    h1 { text-align: center; color: #333; margin: 10px 0 20px 0; font-size: 1.5rem; }
    .summary { margin: 15px 0; padding: 12px; background-color: #f5f5f5; border-radius: 5px; }
    .legend { display: flex; justify-content: center; gap: 20px; margin-bottom: 15px; flex-wrap: wrap; }
    .legend-item { display: flex; align-items: center; margin: 5px; font-size: 0.9rem; }
    .legend-color { width: 20px; height: 20px; margin-right: 5px; border-radius: 3px; }
    .summary-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
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
  <h1>Detailed Crypto Fear & Greed Index (${intervalDisplay} Intervals)</h1>
  
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
      <div class="legend-color" style="background-color: #27AE60;"></div>
      <span>Greed (56-75)</span>
    </div>
    <div class="legend-item">
      <div class="legend-color" style="background-color: #2ECC71;"></div>
      <span>Extreme Greed (76-100)</span>
    </div>
  </div>
  
  <div class="summary">
    <div class="summary-grid">
      <div>
        <p><strong>Current Fear & Greed Value:</strong> ${latestValue} (${latestClassification})</p>
        <p><strong>Time Range:</strong> ${startDate} to ${endDate}</p>
        <p><strong>Interval:</strong> ${intervalDisplay}</p>
      </div>
      <div>
        <p><strong>Highest Value:</strong> ${highestValue}</p>
        <p><strong>Lowest Value:</strong> ${lowestValue}</p>
        <p><strong>Data Points:</strong> ${sortedFearData.length}</p>
      </div>
    </div>
  </div>
  
  <div class="chart-container">
    <canvas id="fearIndexChart"></canvas>
  </div>

  <div class="generation-info">
    <p>Generated on ${formatDateTimeUTC(new Date())}</p>
  </div>

  <script>
    const ctx = document.getElementById('fearIndexChart').getContext('2d');
    
    const dates = [${chartDates.join(',')}];
    const fearValues = [${fearValues.join(',')}];
    const classifications = [${classifications.join(',')}];
    
    // Function to get background color based on fear value
    function getFearColor(value) {
      if (value <= 25) return 'rgba(231, 76, 60, 0.5)';      // Extreme Fear
      if (value <= 45) return 'rgba(243, 156, 18, 0.5)';     // Fear
      if (value <= 55) return 'rgba(241, 196, 15, 0.5)';     // Neutral
      if (value <= 75) return 'rgba(39, 174, 96, 0.5)';      // Greed
      return 'rgba(46, 204, 113, 0.5)';                     // Extreme Greed
    }
    
    // Create background colors array
    const backgroundColors = fearValues.map(value => getFearColor(value));
    
    new Chart(ctx, {
      type: 'bar',
      data: {
        labels: dates,
        datasets: [
          {
            label: 'Fear & Greed Index',
            data: fearValues,
            backgroundColor: backgroundColors,
            borderColor: backgroundColors.map(color => color.replace('0.5', '1')),
            borderWidth: 1
          }
        ],
      },
      options: {
        responsive: true,
        scales: {
          y: {
            beginAtZero: true,
            max: 100,
            title: {
              display: true,
              text: 'Fear & Greed Value'
            }
          },
          x: {
            ticks: {
              maxRotation: 45,
              minRotation: 45
            }
          }
        },
        plugins: {
          tooltip: {
            callbacks: {
              label: function(context) {
                const value = context.raw;
                const index = context.dataIndex;
                return \`Value: \${value} (\${classifications[index].replace(/"/g, '')})\`;
              }
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

/**
 * Save detailed fear index visualization to a file
 */
async function saveDetailedFearIndexVisualization(fearData: FearIndexDataPoint[], outputDir: string, intervalHours = 4): Promise<string> {
    try {
        // Create output directory if it doesn't exist
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        
        // Format interval for filename
        const intervalText = intervalHours === 1 ? 'Hourly' :
                           intervalHours === 24 ? 'Daily' :
                           `${intervalHours}h`;
        
        // Generate standardized filename format: [Chart Title] [Crypto Name] [Date],
        const currentDate = formatDateUTC(new Date()); // Gets YYYY-MM-DD format
        const fileName = `Fear Index Chart ${intervalText} Bitcoin ${currentDate}.html`;
        const filePath = path.join(outputDir, fileName);
        
        // Generate and save HTML
        const html = generateDetailedFearIndexHTML(fearData, intervalHours);
        fs.writeFileSync(filePath, html);
        
        console.log(`Detailed fear index visualization saved to: ${filePath}`);
        
        // Open the file in default browser
        /*
        try {
            // Different commands based on platform
            if (process.platform === 'win32') {
                await execPromise(`start "" "${filePath}"`);
            } else if (process.platform === 'darwin') {
                await execPromise(`open "${filePath}"`);
            } else {
                await execPromise(`xdg-open "${filePath}"`);
            }
            console.log('Opened visualization in browser');
        } catch (error) {
            console.error('Failed to open visualization in browser:', error);
        }
        */
        
        return filePath;
    } catch (error) {
        console.error('Error saving fear index visualization:', error);
        throw error;
    }
}

/**
 * Top-level function to plot detailed fear index with customizable intervals
 */
export async function plotDetailedFearIndex(hours = 168, intervalHours = 4): Promise<{ success: boolean; message: string; chartPath: string }> {
    try {
        // Validate interval
        if (intervalHours <= 0) {
            throw new Error('Interval must be positive');
        }
        
        // Ensure interval is reasonable (not too small or too large)
        if (intervalHours < 1) intervalHours = 1; // Minimum 1 hour
        if (intervalHours > 24) intervalHours = 24; // Maximum 24 hours (daily)
        
        // Format interval for logging
        const intervalText = intervalHours === 1 ? 'hourly' :
                           intervalHours === 24 ? 'daily' :
                           `${intervalHours}-hour`;
        
        console.log(`Fetching detailed fear index data with ${intervalText} intervals for the last ${hours} hours...`);
        
        const fearData = await getDetailedFearIndex(hours, intervalHours);
        
        if (!fearData || fearData.length === 0) {
            throw new Error('No fear index data available');
        }
        
        console.log(`Got ${fearData.length} data points with ${intervalText} intervals`);
        
        // Define output directory using standard pattern
        const savedDataDir = path.join(process.cwd(), 'saved_data');
        const outputDir = path.join(savedDataDir, 'Charts');
        
        // Create directories if they don't exist
        if (!fs.existsSync(savedDataDir)) {
            fs.mkdirSync(savedDataDir, { recursive: true });
        }
        
        // Save and open the visualization
        const filePath = await saveDetailedFearIndexVisualization(fearData, outputDir, intervalHours);
        
        return {
            success: true,
            message: `Detailed fear index visualization with ${intervalText} intervals created successfully.`,
            chartPath: filePath
        };
    } catch (error) {
        console.error('Error plotting detailed fear index:', error);
        throw error;
    }
}

// Define the action for ElizaOS
export const PlotDetailedFearIndexAction: Action = {
    name: "plot_detailed_fear_index",
    description: "Plot a detailed fear and greed index chart with customizable intervals",
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show me a detailed fear index with 4-hour intervals for the past week",
                    action: "plot_detailed_fear_index"
                }
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Creating detailed fear index visualization with 4-hour intervals for the past 168 hours...",
                    action: "plot_detailed_fear_index"
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Create a fear chart with 6-hour intervals for the past 2 days",
                    action: "plot_detailed_fear_index"
                }
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Creating detailed fear index visualization with 6-hour intervals for the past 48 hours...",
                    action: "plot_detailed_fear_index"
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show me the hourly fear index for yesterday",
                    action: "plot_detailed_fear_index"
                }
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Creating detailed fear index visualization with hourly intervals for the past 24 hours...",
                    action: "plot_detailed_fear_index"
                }
            }
        ],
    ] as ActionExample[][],
,
    ,
    handler: async (
        _runtime: IAgentRuntime,
        message: Memory,
        _state: State,
        _options: { [key: string]: unknown },
        callback: HandlerCallback
    ): Promise<boolean> => {
        try {
            // Parse hours from options (from/to) or user message (default to 168 = 7 days if not specified)
            let hours = 168;
            let hoursFromParams = false;
            if (_options?.from && _options?.to && typeof _options.from === "string" && typeof _options.to === "string") {
                // Support date-only (YYYY-MM-DD) or datetime with hour (YYYY-MM-DDTHH:mm)
                const fromStr = _options.from.trim();
                const toStr = _options.to.trim();
                const fromDate = new Date(fromStr.length === 10 ? fromStr + "T00:00:00.000Z" : fromStr);
                const toDate = new Date(toStr.length === 10 ? toStr + "T23:59:59.999Z" : toStr);
                if (!Number.isNaN(fromDate.getTime()) && !Number.isNaN(toDate.getTime()) && fromDate <= toDate) {
                    const exactHours = (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60);
                    hours = Math.min(Math.max(Math.ceil(exactHours), 1), 720); // 1 hour to 30 days
                    hoursFromParams = true;
                }
            }
            
            // Default interval is 4 hours
            let intervalHours = 4;
            
            const text = message.content?.text?.toLowerCase() || '';
            
            // Parse interval hours from message
            // Look for X-hour/hr interval patterns
            const intervalMatch = text.match(/(\d+)[\s-]*(hour|hr)s?\s*intervals?/i);
            if (intervalMatch && intervalMatch[1]) {
                intervalHours = Number.parseInt(intervalMatch[1]);
                // Ensure interval is reasonable
                if (intervalHours < 1) intervalHours = 1; // Minimum 1 hour
                if (intervalHours > 24) intervalHours = 24; // Maximum 24 hours (daily)
            } 
            // Look for special interval terms
            else if (text.includes('hourly')) {
                intervalHours = 1;
            }
            else if (text.includes('daily') || text.includes('24-hour') || text.includes('24 hour') || text.includes('24hr')) {
                intervalHours = 24;
            }
            else if (text.includes('12-hour') || text.includes('12 hour') || text.includes('12hr')) {
                intervalHours = 12;
            }
            else if (text.includes('6-hour') || text.includes('6 hour') || text.includes('6hr')) {
                intervalHours = 6;
            }
            else if (text.includes('8-hour') || text.includes('8 hour') || text.includes('8hr')) {
                intervalHours = 8;
            }
            else if (text.includes('2-hour') || text.includes('2 hour') || text.includes('2hr')) {
                intervalHours = 2;
            }
            
            // Look for hours pattern (only when not already set from from/to params)
            if (!hoursFromParams) {
                const hoursMatch = text.match(/(\d+)\s*hours?/i);
                if (hoursMatch && hoursMatch[1]) {
                    hours = Number.parseInt(hoursMatch[1]);
                    hours = Math.min(hours, 720);
                } else {
                    const daysMatch = text.match(/(\d+)\s*days?/i);
                    if (daysMatch && daysMatch[1]) {
                        const days = Number.parseInt(daysMatch[1]);
                        hours = Math.min(days * 24, 720);
                    } else if (text.includes('yesterday')) {
                        hours = 24;
                    } else if (text.includes('today')) {
                        const now = new Date();
                        hours = now.getUTCHours() + 1;
                    } else if (text.includes('week')) {
                        hours = 168;
                    } else if (text.includes('month')) {
                        hours = 720;
                    }
                }
            }
            // Cap by data retention (subscription tier); enterprise (0) = no cap
            let dataRetentionApplied = false;
            const dataRetentionDays = typeof _options?.dataRetentionDays === "number" ? _options.dataRetentionDays : undefined;
            if (typeof dataRetentionDays === "number" && dataRetentionDays > 0) {
                const maxHours = dataRetentionDays * 24;
                if (hours > maxHours) {
                    dataRetentionApplied = true;
                    hours = maxHours;
                }
            }
            
            // Format interval for response
            const intervalText = intervalHours === 1 ? 'hourly' :
                               intervalHours === 24 ? 'daily' :
                               `${intervalHours}-hour`;
            
            // Generate and show the visualization
            const result = await plotDetailedFearIndex(hours, intervalHours);

            // Generate action summary
            const dataPoints = Math.floor(hours / intervalHours);
            const timePeriod = hours >= 24 ? `${Math.floor(hours / 24)} days` : `${hours} hours`;
            const actionSummary = generateActionSummary({
                actionName: 'Detailed Fear & Greed Index',
                assets: ['Crypto Market'],
                timePeriod: timePeriod,
                dataPoints: dataPoints,
                additionalInfo: 'trend analysis with chart'
            });

            const detailedChartPath = buildChartProxyUrl(result.chartPath, _runtime.agentId);
            await callback(createActionResponse({
                actionName: "plot_detailed_fear_index",
                type: "plot_detailed_fear_index",
                text: result.message,
                chartPath: detailedChartPath,
                actionData: {
                    summary: actionSummary,
                },
                additionalMetadata: dataRetentionApplied ? { dataRetentionApplied: true } : undefined,
            }));
            
            return true;
        } catch (error) {
            console.error('Error in plot_detailed_fear_index action:', error);
            await callback(createActionErrorResponse({
                actionName: "plot_detailed_fear_index",
                type: "plot_detailed_fear_index_error",
                error: error instanceof Error ? error : new Error(String(error)),
                text: `Failed to create detailed fear index visualization: ${error.message}`,
            }));
            return false;
        }
    },
};
