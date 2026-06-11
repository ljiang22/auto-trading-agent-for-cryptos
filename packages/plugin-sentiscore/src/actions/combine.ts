import fs from "fs";
import path from "path";
import { ChartJSNodeCanvas } from "chartjs-node-canvas";
import type {
    ActionExample,
    IAgentRuntime,
    Memory,
    Action,
    State,
    HandlerCallback,
    Content
} from "@elizaos/core";
import { httpClient, createActionResponse, createActionErrorResponse, clampDateRangeToRetention, buildChartProxyUrl } from "@elizaos/core";
import { identifyAsset } from "../utils/cryptocurrencies.ts";
import { GET_sentiment_score } from "./crypto.ts";
import { generateText, ModelClass, generateActionSummary } from "@elizaos/core";
import { GET_X_sentiment_score } from "./x.ts";
import { GET_X_influencers_sentiment_score } from "./x_influencers.ts";
import { GET_reddit_sentiment_score } from "./reddit.ts";
import { GET_podcast_sentiment_score } from "./podcast.ts";
import { GET_research_sentiment_score } from "./research.ts";
import { GET_crypto_policy_sentiment_score } from "./crypto_policy.ts";
import { GET_youtube_sentiment_score } from "./youtube.ts";
import { GET_macro_sentiment_score } from "./macro_news.ts";

export const SENTIMENT_ANALYSIS_SYSTEM = `You are a quantitative cryptocurrency sentiment analyst. Based on the provided sentiment data metrics, provide statistical analysis and actionable insights.

**IMPORTANT: Action Summary Generation**
Before providing your analysis, you MUST generate a brief action summary in the following format:

[ACTION_SUMMARY]
Sentiment Analysis for <ASSET> over <TIME_PERIOD> (<DATA_POINTS> data points): <KEY_INSIGHT>
[/ACTION_SUMMARY]
    Where:
- <ASSET>: The cryptocurrency symbol (e.g., "BTC", "ETH")
- <TIME_PERIOD>: The date range analyzed
- <DATA_POINTS>: Total number of data points
- <KEY_INSIGHT>: One brief insight about sentiment (e.g., "bullish sentiment at 0.65, high volatility" or "neutral market mood with declining trend")

Example:
[ACTION_SUMMARY]
Sentiment Analysis for BTC over 14 days (250 data points): positive sentiment at 0.58 with moderate volatility.
[/ACTION_SUMMARY]

ANALYSIS FRAMEWORK - DELIVER CONCISE, ACTIONABLE INSIGHTS:

**CRITICAL MARKDOWN FORMATTING RULES**:
- All headings MUST have EXACTLY ONE SPACE after # symbols
- CORRECT: "## Heading" or "### Heading"
- WRONG: "##Heading" (missing space) or "##  Heading" (multiple spaces)
- Always ensure headings start at the beginning of a new line

## 1. MARKET SENTIMENT OVERVIEW (2-3 sentences)
- Current market temperature: Bullish/Bearish/Neutral with confidence level (High/Medium/Low)
- Key sentiment driver: Primary factor influencing current sentiment
- Trend direction: Rising/Falling/Stable with momentum assessment

## 2. CRITICAL INSIGHTS (3-4 bullet points max)
- Sentiment extremes indicating potential reversals or continuations
- Notable divergences from typical patterns
- Volatility assessment and risk implications
- Comparative positioning vs historical ranges

## 3. ACTIONABLE INTELLIGENCE (2-3 specific recommendations)
- Market timing signals based on sentiment data
- Risk management considerations
- Opportunity identification with confidence ratings

OUTPUT REQUIREMENTS:
- Keep total analysis under 300 words
- Use bullet points for clarity
- Include specific numerical references from the metrics above
- Rate confidence levels (Strong/Moderate/Weak)
- Focus on immediately actionable insights
- Avoid repetitive explanations

ANALYTICAL PRINCIPLES:
- Prioritize signal over noise
- Quantify uncertainty and limitations
- Highlight contrarian indicators
- Connect sentiment to potential price action
- Distinguish short-term vs long-term implications

Provide a focused, data-driven analysis that traders and investors can act upon immediately.`;

const COMPARISON_ANALYSIS_SYSTEM = `You are a quantitative sentiment analyst specializing in multi-source data fusion. Provide comprehensive cross-source analysis.

ANALYSIS FRAMEWORK - DELIVER CONCISE, ACTIONABLE CROSS-SOURCE INSIGHTS:

**CRITICAL MARKDOWN FORMATTING RULES**:
- All headings MUST have EXACTLY ONE SPACE after # symbols
- CORRECT: "## Heading" or "### Heading"
- WRONG: "##Heading" (missing space) or "##  Heading" (multiple spaces)
- Always ensure headings start at the beginning of a new line

## 1. UNIFIED MARKET SENTIMENT OVERVIEW (2-3 sentences)
- Composite market temperature with confidence level
- Source alignment assessment between institutional (news) and retail (Twitter) sentiment
- Dominant signal: Which source is driving the overall sentiment and momentum direction

## 2. CROSS-SOURCE CRITICAL INSIGHTS (3-4 bullet points max)
- Divergence Analysis and implications for market direction
- Volatility Assessment and what it indicates
- Source Reliability and data quality assessment
- Weighting Impact on final signal

## 3. FUSION-BASED ACTIONABLE INTELLIGENCE (2-3 specific recommendations)
- Signal Strength with specific entry/exit considerations
- Cross-Validation assessment
- Risk Management recommendations

OUTPUT REQUIREMENTS:
- Keep total analysis under 350 words
- Use bullet points for clarity
- Include specific numerical references from both sources
- Rate confidence levels (Strong/Moderate/Weak) for all recommendations
- Focus on immediately actionable cross-source insights
- Highlight institutional vs retail sentiment divergences

ANALYTICAL PRINCIPLES:
- Prioritize consensus signals over conflicting ones
- Quantify source reliability and data quality impact
- Highlight when one source provides stronger signals than the other
- Connect multi-source sentiment to potential price action catalysts
- Distinguish between short-term noise and meaningful divergences`;

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

interface SentiScore {
    time: number;
    value: number;
    strongly_negative: number;
    moderately_negative: number;
    mildly_negative: number;
    neutral: number;
    mildly_positive: number;
    moderately_positive: number;
    strongly_positive: number;
    negative: number;
    positive: number;
    total: number;
    expected_negative: number;
    importance: number;
}

interface CryptoDataPoint {
    date: string;
    price: number;
    high: number;
    low: number;
    open: number;
    volume: number;
}

interface CoinglassPricePoint {
    time: number;
    open: string;
    high: string;
    low: string;
    close: string;
    volume_usd: string;
}

interface CoinglassPriceHistoryResponse {
    code: string;
    msg?: string;
    data?: CoinglassPricePoint[];
}

const COINGLASS_API_URL = "https://open-api-v4.coinglass.com/api/futures/price/history";
const COINGLASS_EXCHANGE = "Binance";
const COINGLASS_INTERVAL = "1d";

/** Skip rewriting chart HTML if file on disk is newer than this (ms). */
const CHART_FILE_CACHE_MS = 3 * 60 * 60 * 1000;

function sentimentPerfEnabled(): boolean {
    const v = process.env.SENTIMENT_PERF;
    return v === "1" || String(v).toLowerCase() === "true";
}

function logSentimentPerf(
    step: string,
    ms: number,
    detail?: string
): void {
    if (!sentimentPerfEnabled()) return;
    const extra = detail ? ` ${detail}` : "";
    console.log(
        `[Sentiment_Analysis][perf] step=${step} ms=${Math.round(ms)}${extra}`
    );
}

/** Per-source aggregates for templates and LLM prompts. */
type SourceMetricsBlock = {
    total: number;
    avg: number;
    positive: number;
    negative: number;
    neutral: number;
    trend: string;
    change: number;
    volatility: number;
};

export function computeSourceMetrics(scores: SentiScore[]): SourceMetricsBlock | null {
    if (scores.length === 0) {
        return null;
    }
    let posN = 0;
    let negN = 0;
    let neuN = 0;
    let sumPos = 0;
    let sumNeg = 0;
    let sumNeu = 0;
    let sumVal = 0;
    for (const s of scores) {
        sumVal += s.value;
        if (s.value > 0) {
            posN++;
            sumPos += s.value;
        } else if (s.value < 0) {
            negN++;
            sumNeg += s.value;
        } else {
            neuN++;
            sumNeu += s.value;
        }
    }
    const avg = sumVal / scores.length;
    let trend = "stable";
    let change = 0;
    if (scores.length > 1) {
        const sorted = [...scores].sort((a, b) => a.time - b.time);
        change = sorted[sorted.length - 1].value - sorted[0].value;
        if (Math.abs(change) > 0.01) {
            trend = change > 0 ? "increasing" : "decreasing";
        }
    }
    let sq = 0;
    for (const s of scores) {
        const d = s.value - avg;
        sq += d * d;
    }
    const volatility = Math.sqrt(sq / scores.length);
    return {
        total: scores.length,
        avg,
        positive: posN > 0 ? sumPos / posN : 0,
        negative: negN > 0 ? sumNeg / negN : 0,
        neutral: neuN > 0 ? sumNeu / neuN : 0,
        trend,
        change,
        volatility,
    };
}

/**
 * Formats a Date object to YYYY-MM-DD string
 * @param date The Date object to format
 * @returns Formatted date string
 */
function formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

/**
 * Returns the default date range (today to 14 days ago)
 * @returns Object containing startDate and endDate in 'YYYY-MM-DD' format
 */
export function getDefaultDateRange(): { startDate: string, endDate: string } {
    const today = new Date();
    const fourteenDaysAgo = new Date();
    fourteenDaysAgo.setDate(today.getDate() - 14);

    return {
        startDate: formatDate(fourteenDaysAgo),
        endDate: formatDate(today)
    };
}

/**
 * Extracts date range from a user request string
 * @param request The user request text
 * @returns Object containing startDate and endDate in 'YYYY-MM-DD' format
 */
export function getDateRangeFromRequest(request: string): { startDate: string, endDate: string } {
    // Default to current date for endDate
    const today = new Date();
    const endDate = today;
    const startDate = new Date();
    
    // Convert to lowercase for easier matching
    let text = request.toLowerCase();
    const relativeText = text
        .replace(/[^a-z0-9\s-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    
    // First, convert written numbers to digits for time period processing
    const numberWords = {
        'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4', 'five': '5',
        'six': '6', 'seven': '7', 'eight': '8', 'nine': '9', 'ten': '10',
        'eleven': '11', 'twelve': '12', 'thirteen': '13', 'fourteen': '14', 'fifteen': '15',
        'sixteen': '16', 'seventeen': '17', 'eighteen': '18', 'nineteen': '19', 'twenty': '20',
        'thirty': '30', 'forty': '40', 'fifty': '50', 'sixty': '60', 'seventy': '70',
        'eighty': '80', 'ninety': '90', 'hundred': '100', 'thousand': '1000'
    };
    
    // Replace written numbers with digits in time period contexts
    for (const [word, digit] of Object.entries(numberWords)) {
        // Only replace if the word is followed by a time period word
        const timePeriodReplacementRegex = new RegExp(`\\b${word}\\b(?=\\s+(?:day|days|week|weeks|month|months|year|years))`, "gi");
        text = text.replace(timePeriodReplacementRegex, digit);
    }
    
    // Handle compound numbers like "twenty-five" -> "25" in time period contexts
    text = text.replace(/\b(20|30|40|50|60|70|80|90)[-\s]+(1|2|3|4|5|6|7|8|9)(?=\s+(?:day|days|week|weeks|month|months|year|years))\b/g, (match, tens, ones) => {
        return (Number.parseInt(tens) + Number.parseInt(ones)).toString();
    });
    
    // Check for common time period patterns
    if (relativeText.includes("last") || relativeText.includes("past")) {
        // Extract numbers and time units
        const match = relativeText.match(/(?:last|past)\s+(\d+)\s*(day|week|month|year)s?/i);
        if (match) {
            const amount = Number.parseInt(match[1]);
            const unit = match[2];
            
            if (unit.includes("day")) {
                startDate.setDate(today.getDate() - amount);
            } else if (unit.includes("week")) {
                startDate.setDate(today.getDate() - (amount * 7));
            } else if (unit.includes("month")) {
                startDate.setMonth(today.getMonth() - amount);
            } else if (unit.includes("year")) {
                startDate.setFullYear(today.getFullYear() - amount);
            }
        } else {
            // Default to last 14 days if no specific period mentioned
            startDate.setDate(today.getDate() - 14);
        }
    } else if (text.includes("from") && text.includes("to")) {
        // Look for explicit date ranges like "from 2025-04-01 to 2025-04-10"
        const datePattern = /\d{4}-\d{2}-\d{2}/g;
        const dates = text.match(datePattern);
        
        if (dates && dates.length >= 2) {
            return {
                startDate: dates[0],
                endDate: dates[1],
            };
        }
    } else if (text.includes("this week")) {
        // Set to beginning of current week (Sunday)
        const dayOfWeek = today.getDay();
        startDate.setDate(today.getDate() - dayOfWeek);
    } else if (text.includes("this month")) {
        // Set to beginning of current month
        startDate.setDate(1);
    } else if (text.includes("this year")) {
        // Set to beginning of current year
        startDate.setMonth(0);
        startDate.setDate(1);
    } else {
        // Default to last 14 days
        startDate.setDate(today.getDate() - 14);
    }
    
    return {
        startDate: formatDate(startDate),
        endDate: formatDate(endDate)
    };
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

    // If symbol doesn't already have a quote currency, append USDT for CoinGlass API
    // Check if it already ends with common quote currencies (USDT, USDC, BUSD, etc.)
    // Note: BTC and ETH are base currencies, not quote currencies, so they're not included
    const hasQuoteCurrency = /(USDT|USDC|BUSD|USD|EUR|GBP)$/.test(normalized);
    if (!hasQuoteCurrency) {
        return `${normalized}USDT`;
    }

    return normalized;
}

/**
 * Gets crypto data from CoinGlass
 * @param symbol Cryptocurrency symbol (e.g., BTC, ETH)
 * @param startDate Start date in YYYY-MM-DD format
 * @param endDate End date in YYYY-MM-DD format
 * @returns Promise containing an array of CryptoDataPoint objects
 */
export async function getCryptoData(symbol: string, startDate: string, endDate: string): Promise<CryptoDataPoint[]> {
    try {
        const apiKey = process.env.COINGLASS_API_KEY;
        if (!apiKey) {
            console.error("COINGLASS_API_KEY is not set");
            return [];
        }

        const startTime = new Date(`${startDate}T00:00:00Z`).getTime();
        const endTime = new Date(`${endDate}T23:59:59Z`).getTime();
        const totalDays = Math.max(1, Math.ceil((endTime - startTime) / (24 * 60 * 60 * 1000)));
        const limit = Math.min(1000, totalDays + 1);

        const response = await httpClient.get(COINGLASS_API_URL, {
            headers: {
                accept: "application/json",
                "CG-API-KEY": apiKey
            },
            params: {
                exchange: COINGLASS_EXCHANGE,
                symbol: toCoinglassSymbol(symbol),
                interval: COINGLASS_INTERVAL,
                limit,
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
                date: new Date(item.time).toISOString().split("T")[0],
                price: Number(item.close),
                high: Number(item.high),
                low: Number(item.low),
                open: Number(item.open),
                volume: Number(item.volume_usd)
            }))
            .filter(item => Number.isFinite(item.price));
    } catch (error) {
        console.error(`Error fetching data from CoinGlass for ${symbol}:`, error);
        return [];
    }
}

/**
/**
 * Render a sentiment time series to a PNG buffer using chartjs-node-canvas.
 * Plots hourly data points directly — no day-bucketing.
 * @param scores  Hourly { time (unix sec), value } records, pre-sorted ascending
 * @param label   Chart dataset label (e.g. "BTC — X/Twitter")
 * @param color   CSS rgb() string for the line color
 */
export async function generateSentimentPNG(
    scores: { time: number; value: number }[],
    label: string,
    color = "rgb(99, 102, 241)"
): Promise<Buffer> {
    const canvas = new ChartJSNodeCanvas({ width: 900, height: 360, backgroundColour: "#ffffff" });

    const labels = scores.map(s => {
        const d = new Date(s.time * 1000);
        return `${d.toISOString().slice(0, 10)} ${String(d.getUTCHours()).padStart(2, "0")}:00`;
    });
    const values = scores.map(s => s.value);

    const bg = color.replace("rgb(", "rgba(").replace(")", ", 0.10)");

    const config = {
        type: "line" as const,
        data: {
            labels,
            datasets: [
                {
                    label,
                    data: values,
                    borderColor: color,
                    backgroundColor: bg,
                    borderWidth: 1.5,
                    pointRadius: scores.length > 100 ? 0 : 2,
                    fill: true,
                    tension: 0.2,
                },
            ],
        },
        options: {
            animation: false as const,
            responsive: false,
            plugins: {
                legend: { display: true },
                title: {
                    display: true,
                    text: label,
                    font: { size: 13 },
                },
            },
            scales: {
                y: {
                    min: -1,
                    max: 1,
                    title: { display: true, text: "Sentiment (-1 to +1)" },
                    grid: { color: "rgba(0,0,0,0.06)" },
                },
                x: {
                    ticks: { maxTicksLimit: 14, maxRotation: 45 },
                    grid: { color: "rgba(0,0,0,0.06)" },
                },
            },
        },
    };

    return canvas.renderToBuffer(config as Parameters<typeof canvas.renderToBuffer>[0]);
}

/**
 * Generates an HTML chart with cryptocurrency price and sentiment data
 * @param cryptoData Array of CryptoDataPoint objects
 * @param combinedSentiScores Time-aligned combined sentiment scores (averaged across all sources)
 * @param symbol Cryptocurrency symbol (e.g., BTC, ETH)
 * @returns HTML string containing the chart
 */
export function generateChartHTML(cryptoData: CryptoDataPoint[], combinedSentiScores: { time: number; value: number }[], symbol: string): string {
    // Ensure we have data
    if (cryptoData.length === 0) {
        return `<html><body><h1>Error: No price data available for ${symbol}</h1></body></html>`;
    }

    let priceMax = cryptoData[0].price;
    let priceMin = cryptoData[0].price;
    for (let i = 1; i < cryptoData.length; i++) {
        const p = cryptoData[i].price;
        if (p > priceMax) priceMax = p;
        if (p < priceMin) priceMin = p;
    }

    // Prepare data for Chart.js
    const dates = cryptoData.map(point => `"${point.date}"`).join(',');
    const prices = cryptoData.map(point => point.price).join(',');
    const volumes = cryptoData.map(point => point.volume / 1000000).join(','); // Convert to millions for readability

    // Aggregate hourly aligned scores into daily averages (simple mean per day).
    const combinedSentiScoreDates = new Map<string, number>();
    {
        const daySums = new Map<string, number>();
        const dayCounts = new Map<string, number>();
        for (const score of combinedSentiScores) {
            const dateStr = new Date(score.time * 1000).toISOString().split('T')[0];
            daySums.set(dateStr, (daySums.get(dateStr) ?? 0) + score.value);
            dayCounts.set(dateStr, (dayCounts.get(dateStr) ?? 0) + 1);
        }
        for (const [d, sum] of daySums) {
            combinedSentiScoreDates.set(d, sum / dayCounts.get(d)!);
        }
    }

    // Create the sentiment score array aligned with the crypto dates
    const combinedSentimentValues = cryptoData.map(point => {
        return combinedSentiScoreDates.has(point.date) ? combinedSentiScoreDates.get(point.date) : null;
    }).join(',');

    // Get current date in YYYY-MM-DD format for the title
    const currentDate = new Date().toISOString().split('T')[0];

    // Determine which datasets to include
    const hasSentiData = combinedSentiScores.length > 0;

    // Build datasets array
    const sentimentDatasets = hasSentiData ? `
          {
            label: 'Combined SentiScore',
            data: [${combinedSentimentValues}],
            borderColor: 'rgb(99, 102, 241)',
            backgroundColor: 'rgba(99, 102, 241, 0.1)',
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 0,
            yAxisID: 'y2'
          }` : '';

    // Chart.js v4: two axes at position:'right' are automatically laid out side by
    // side (each in its own gutter). Per Chart.js docs, higher `weight` is placed
    // FURTHER from the chart area. Volume (weight:1) = inner-right axis (closer
    // to the bars), SentiScore (weight:3) = far-right axis (its -1.2..1.2 scale
    // sits outside the volume gutter). Do NOT use `stack`/`stackWeight` — those
    // divide the chart *area* vertically, which clips the bar heights.
    const hasSentimentAxis = hasSentiData;
    const rightChartPad = hasSentimentAxis ? 16 : 16;
    const y1ScaleSnippet = hasSentimentAxis
        ? `
          y1: {
            type: 'linear',
            display: true,
            position: 'right',
            weight: 1,
            grid: {
              drawOnChartArea: false,
            },
            title: {
              display: true,
              text: 'Volume (Millions USD)',
            },
            ticks: {
              maxTicksLimit: 8,
            },
          }`
        : `
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
          }`;
    const y2ScaleSnippet = hasSentimentAxis
        ? `,
          y2: {
            type: 'linear',
            display: true,
            position: 'right',
            weight: 3,
            grid: {
              drawOnChartArea: false,
            },
            title: {
              display: true,
              text: 'SentiScore',
            },
            min: -1.2,
            max: 1.2,
            ticks: {
              maxTicksLimit: 7,
            },
          }`
        : "";

    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${symbol} Price and Sentiment Chart ${currentDate}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js" crossorigin="anonymous" onerror="document.body.innerHTML='<p style=\\'font-family:sans-serif;padding:1rem\\'>Chart library failed to load. Check network or try opening this page in a new tab.</p>'"></script>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; padding: 20px; min-height: 100%; }
    .chart-container { position: relative; height: 80vh; width: 90vw; max-width: 1200px; margin: 0 auto; }
    h1 { text-align: center; color: #333; }
    .summary { margin: 20px 0; padding: 15px; background-color: #f5f5f5; border-radius: 5px; }
    .summary p { margin: 5px 0; }
    /* Embed / compact: explicit height — avoid height:100% (no definite parent) and
       sendHeightToParent must not use html.clientHeight (iframe viewport feedback loop). */
    body.compact-view { margin: 0; padding: 0; background: transparent; min-height: 0; }
    body.compact-view .chart-container {
      position: relative;
      width: 100%;
      min-width: 580px;
      height: clamp(200px, 40vw, 520px);
      min-height: 200px;
      max-height: 540px;
      margin: 0;
      padding: 0 0 12px 0;
    }
    body.compact-view {
      overflow-x: auto;
    }
    body.compact-view h1,
    body.compact-view .summary { display: none; }
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
  <h1>${symbol} Price and SentiScore Chart ${currentDate}</h1>
  
  <div class="summary">
    <p><strong>Start Date:</strong> ${cryptoData[0]?.date || 'N/A'}</p>
    <p><strong>End Date:</strong> ${cryptoData[cryptoData.length - 1]?.date || 'N/A'}</p>
    <p><strong>Starting Price:</strong> $${cryptoData[0]?.price.toLocaleString() || 'N/A'}</p>
    <p><strong>Ending Price:</strong> $${cryptoData[cryptoData.length - 1]?.price.toLocaleString() || 'N/A'}</p>
    <p><strong>Highest Price:</strong> $${priceMax.toLocaleString()}</p>
    <p><strong>Lowest Price:</strong> $${priceMin.toLocaleString()}</p>
    ${hasSentiData ? `<p><strong>Combined SentiScore Data Points:</strong> ${combinedSentiScores.length}</p>` : ''}
  </div>
  
  <div class="chart-container">
    <canvas id="cryptoChart"></canvas>
  </div>

  <script>
    const canvas = document.getElementById('cryptoChart');
    if (!canvas || !canvas.getContext) {
      const box = document.querySelector('.chart-container');
      if (box) box.innerHTML = '<p style="font-family:sans-serif;padding:1rem">Chart canvas missing.</p>';
    } else {
    const ctx = canvas.getContext('2d');
    const dates = [${dates}];
    const prices = [${prices}];
    const volumes = [${volumes}];
    try {
    new Chart(ctx, {
      type: 'line',
      data: {
        labels: dates,
        datasets: [
          {
            label: '${symbol} Price (USD)',
            data: prices,
            borderColor: 'rgb(75, 192, 192)',
            backgroundColor: 'rgba(75, 192, 192, 0.1)',
            borderWidth: 2,
            tension: 0.1,
            pointRadius: 0,
            pointHoverRadius: 0,
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
          }${sentimentDatasets ? ',' + sentimentDatasets : ''}
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: {
          padding: {
            left: 8,
            right: ${rightChartPad},
            top: 6,
            bottom: 4,
          },
        },
        interaction: {
          mode: 'index',
          intersect: false,
        },
        elements: {
          point: {
            radius: 0,
            hoverRadius: 0
          }
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
          },${y1ScaleSnippet}${y2ScaleSnippet}
        }
      }
    });
    } catch (err) {
      console.error(err);
      const msg = err?.message != null ? String(err.message) : String(err);
      document.querySelector('.chart-container').innerHTML =
        '<p style="font-family:sans-serif;color:#b91c1c;padding:1rem">Could not render chart: ' + msg.replace(/</g, '&lt;') + '</p>';
    }

    // Send height to parent window for iframe auto-sizing.
    // In compact view, html.* sizes mirror the iframe viewport and inflate the embed (gap below plot).
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
    }
  </script>
</body>
</html>
  `;
}

// Utility function to determine date range based on date range
function determineDateRange(startDate: string, endDate: string): string {
    // If same date, return single date, otherwise return range with ~ separator
    return startDate === endDate ? startDate : `${startDate}~${endDate}`;
}

/**
 * Deletes previous chart files for the same cryptocurrency
 * @param symbol Cryptocurrency symbol to match in filenames
 * @returns Number of files deleted
 */
function deletePreviousCharts(symbol: string): number {
    try {
        const chartDir = path.join(process.cwd(), 'saved_data', 'Charts');
        if (!fs.existsSync(chartDir)) {
            return 0; // No directory, so no files to delete
        }
        
        // Get all files in the charts directory
        const files = fs.readdirSync(chartDir);
        
        // Filter for files that match the pattern for this symbol with date range format
        // Matches patterns like: Sentiment Chart BTC 2025-01-01~2025-01-31.html or Sentiment Chart BTC 2025-01-01.html
        const pattern = new RegExp(`^Sentiment Chart ${symbol} \\d{4}-\\d{2}-\\d{2}(~\\d{4}-\\d{2}-\\d{2})?\\.html$`);
        const matchingFiles = files.filter(file => pattern.test(file));

        // Note: Chart deletion disabled to preserve historical data
        // Old charts are kept for reference in chat history
        if (matchingFiles.length > 0) {
            console.log(`Found ${matchingFiles.length} existing ${symbol} sentiment chart(s) (keeping for history)`);
        }

        // Delete each matching file
        // let deletedCount = 0;
        // for (const file of matchingFiles) {
        //     const filePath = path.join(chartDir, file);
        //     fs.unlinkSync(filePath);
        //     console.log(`Deleted previous chart file: ${filePath}`);
        //     deletedCount++;
        // }

        return 0; // No files deleted
    } catch (error) {
        console.error(`Error deleting previous chart files: ${error}`);
        return 0;
    }
}

/**
 * Saves the HTML chart to a file and returns the file path.
 *
 * The path returned to the client uses `buildChartProxyUrl()` so the iframe
 * resolves through `/s3-files/...` — same as every other working chart plugin.
 * That URL is auth-enforced by `s3FilesHandler` and survives container restart
 * (the underlying S3 object outlives the local fs). Local fs only acts as a
 * latency cache via the `s3FilesHandler` cache-first lookup; never as the
 * canonical URL.
 *
 * @param html HTML content to save
 * @param symbol Cryptocurrency symbol
 * @param startDate Start date in YYYY-MM-DD format
 * @param endDate End date in YYYY-MM-DD format
 * @returns Path to the saved chart file
 */
export async function saveChartToFile(
    html: string,
    symbol: string,
    startDate: string,
    endDate: string
): Promise<string> {
    const savedDataDir = path.join(process.cwd(), "saved_data");
    const chartDir = path.join(savedDataDir, "Charts");

    if (!fs.existsSync(savedDataDir)) {
        fs.mkdirSync(savedDataDir, { recursive: true });
        console.log(`Created directory: ${savedDataDir}`);
    }

    if (!fs.existsSync(chartDir)) {
        fs.mkdirSync(chartDir, { recursive: true });
        console.log(`Created directory: ${chartDir}`);
    }

    const deletedCount = deletePreviousCharts(symbol);
    if (deletedCount > 0) {
        console.log(`Deleted ${deletedCount} previous chart file(s) for ${symbol}`);
    }

    const dateRangeKey = determineDateRange(startDate, endDate);
    const filename = `Sentiment Chart ${symbol} ${dateRangeKey}.html`;
    const filepath = path.join(chartDir, filename);

    await fs.promises.writeFile(filepath, html, "utf-8");
    console.log(`Chart saved to ${filepath}`);

    return filepath;
}

/**
 * Determines if the query is about X/Twitter sentiment
 * @param text The user request text
 * @returns Boolean indicating if the request is about X/Twitter
 */
function isXTwitterRequest(text: string): boolean {
    const lowerText = text.toLowerCase();
    // Use regex with word boundaries to match "x" as a standalone word
    const xPattern = /\bx\b/i;
    return xPattern.test(lowerText) || 
           lowerText.includes("twitter") || 
           lowerText.includes("tweet") ||
           lowerText.includes("media");
}

/**
 * Determines if the query specifically mentions news sentiment
 * @param text The user request text
 * @returns Boolean indicating if the request is specifically about news sentiment
 */
function isNewsRequest(text: string): boolean {
    const lowerText = text.toLowerCase();
    return lowerText.includes("news") || 
           lowerText.includes("crypto news") ||
           lowerText.includes("news sentiment");
}

/**
 * Determines if both sentiment sources should be used (when neither is specifically mentioned)
 * @param text The user request text
 * @returns Boolean indicating if both sources should be used
 */
function shouldUseBothSources(text: string): boolean {
    return !isXTwitterRequest(text) && !isNewsRequest(text);
}

/**
 * Converts written numbers to numeric values
 * @param text The text containing written numbers
 * @returns The numeric value or null if not a recognized number
 */
function convertWrittenNumberToDigit(text: string): number | null {
    const numberMap: { [key: string]: number } = {
        'zero': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
        'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
        'eleven': 11, 'twelve': 12, 'thirteen': 13, 'fourteen': 14, 'fifteen': 15,
        'sixteen': 16, 'seventeen': 17, 'eighteen': 18, 'nineteen': 19, 'twenty': 20,
        'thirty': 30, 'forty': 40, 'fifty': 50, 'sixty': 60, 'seventy': 70,
        'eighty': 80, 'ninety': 90, 'hundred': 100, 'thousand': 1000
    };
    
    const lowerText = text.toLowerCase().trim();
    
    // Handle simple cases first
    if (numberMap[lowerText] !== undefined) {
        return numberMap[lowerText];
    }
    
    // Handle compound numbers like "twenty-five", "thirty-two", etc.
    const compoundMatch = lowerText.match(/^(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[-\s]?(one|two|three|four|five|six|seven|eight|nine)$/);
    if (compoundMatch) {
        const tens = numberMap[compoundMatch[1]];
        const ones = numberMap[compoundMatch[2]];
        return tens + ones;
    }
    
    // Handle "X hundred" patterns
    const hundredMatch = lowerText.match(/^(one|two|three|four|five|six|seven|eight|nine)\s+hundred$/);
    if (hundredMatch) {
        return numberMap[hundredMatch[1]] * 100;
    }
    
    return null;
}

/**
 * Checks if a text contains time period indicators (days, weeks, months, etc.)
 * @param text The text to check
 * @returns Boolean indicating if time periods are mentioned
 */
function containsTimePeriod(text: string): boolean {
    const lowerText = text.toLowerCase();
    const timePeriodPattern = /\b(?:day|days|week|weeks|month|months|year|years|hour|hours|minute|minutes)\b/i;
    return timePeriodPattern.test(lowerText);
}

/**
 * Extracts the number of tweets to analyze from a user request
 * @param text The user request text
 * @returns Number of tweets to analyze or null if not specified
 */
function getTweetCountFromRequest(text: string): number | null {
    const lowerText = text.toLowerCase();
    
    // First check if this is clearly about time periods, not tweet counts
    if (containsTimePeriod(text)) {
        // If it contains time periods, only match if tweets are explicitly mentioned
        const explicitTweetPatterns = [
            /(\d+)\s+(?:tweet|tweets)/i,
            /latest\s+(\d+)\s+(?:tweet|tweets)/i,
            /last\s+(\d+)\s+(?:tweet|tweets)/i,
            /recent\s+(\d+)\s+(?:tweet|tweets)/i,
            /(?:from|analyze)\s+(?:the\s+)?(?:latest|last|recent)\s+(\d+)\s+(?:tweet|tweets)/i,
        ];
        
        for (const pattern of explicitTweetPatterns) {
            const match = lowerText.match(pattern);
            if (match && match[1]) {
                const count = Number.parseInt(match[1]);
                if (!isNaN(count) && count > 0) {
                    return count;
                }
            }
        }
        
        // Also check for written numbers in explicit tweet contexts
        const writtenNumberMatch = lowerText.match(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\s+(?:tweet|tweets)/i);
        if (writtenNumberMatch) {
            const convertedCount = convertWrittenNumberToDigit(writtenNumberMatch[1]);
            if (convertedCount !== null && convertedCount > 0) {
                return convertedCount;
            }
        }
        
        return null; // Don't match time periods as tweet counts
    }
    
    // Check for time period patterns with written numbers BEFORE doing text replacement
    // This prevents "two weeks" from becoming "2 weeks" and then being misinterpreted
    const timePeriodWithWrittenNumbers = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\s+(?:day|days|week|weeks|month|months|year|years|hour|hours|minute|minutes)\b/i;
    if (timePeriodWithWrittenNumbers.test(lowerText)) {
        // This is clearly a time period like "two weeks", "three months", etc.
        // Only proceed if tweets are explicitly mentioned
        const explicitTweetInTimePeriodContext = /\b(?:tweet|tweets)\b/i;
        if (!explicitTweetInTimePeriodContext.test(lowerText)) {
            return null;
        }
        
        // If tweets are mentioned, look for explicit tweet count patterns
        const writtenNumberTweetMatch = lowerText.match(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\s+(?:tweet|tweets)/i);
        if (writtenNumberTweetMatch) {
            const convertedCount = convertWrittenNumberToDigit(writtenNumberTweetMatch[1]);
            if (convertedCount !== null && convertedCount > 0) {
                return convertedCount;
            }
        }
        
        return null;
    }
    
    // Step 1: Replace all written numbers with their digit equivalents
    // Only do this if we're confident it's not a time period context
    let processedText = lowerText;
    const numberWords = {
        'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4', 'five': '5',
        'six': '6', 'seven': '7', 'eight': '8', 'nine': '9', 'ten': '10',
        'eleven': '11', 'twelve': '12', 'thirteen': '13', 'fourteen': '14', 'fifteen': '15',
        'sixteen': '16', 'seventeen': '17', 'eighteen': '18', 'nineteen': '19', 'twenty': '20',
        'thirty': '30', 'forty': '40', 'fifty': '50', 'sixty': '60', 'seventy': '70',
        'eighty': '80', 'ninety': '90', 'hundred': '100', 'thousand': '1000'
    };
    
    // Replace written numbers with digits, but be careful about context
    for (const [word, digit] of Object.entries(numberWords)) {
        // Only replace if the word is not followed by a time period word
        const safeReplacementRegex = new RegExp(`\\b${word}\\b(?!\\s+(?:day|days|week|weeks|month|months|year|years|hour|hours|minute|minutes))`, 'gi');
        processedText = processedText.replace(safeReplacementRegex, digit);
    }
    
    // Handle compound numbers like "twenty-five" -> "25", but again avoid time periods
    processedText = processedText.replace(/\b(20|30|40|50|60|70|80|90)[-\s]+(1|2|3|4|5|6|7|8|9)(?!\s+(?:day|days|week|weeks|month|months|year|years|hour|hours|minute|minutes))\b/g, (match, tens, ones) => {
        return (Number.parseInt(tens) + Number.parseInt(ones)).toString();
    });
    
    // Step 2: Use simple patterns to find numbers followed by tweet-related words
    const simplePatterns = [
        /(\d+)\s+(?:tweet|tweets)/i,                    // "30 tweets", "5 tweets"
        /latest\s+(\d+)\s+(?:tweet|tweets)?/i,          // "latest 50 tweets" or "latest 50"
        /last\s+(\d+)\s+(?:tweet|tweets)?/i,            // "last 100 tweets" or "last 100"
        /recent\s+(\d+)\s+(?:tweet|tweets)?/i,          // "recent 30 tweets" or "recent 30"
        /(?:from|analyze)\s+(?:the\s+)?(?:latest|last|recent)\s+(\d+)/i, // "analyze the latest 50"
    ];
    
    for (const pattern of simplePatterns) {
        const match = processedText.match(pattern);
        if (match && match[1]) {
            const count = Number.parseInt(match[1]);
            if (!isNaN(count) && count > 0) {
                // Additional check: if it's a generic pattern, make sure it's in a Twitter/X context
                if (pattern === simplePatterns[simplePatterns.length - 1] || 
                    pattern === simplePatterns[1] || 
                    pattern === simplePatterns[2] || 
                    pattern === simplePatterns[3]) {
                    if (isXTwitterRequest(text)) {
                        return count;
                    }
                } else {
                    return count;
                }
            }
        }
    }
    
    return null;
}

/**
 * Determines if visualization is requested
 * @param text The user request text
 * @returns Boolean indicating if visualization is requested
 */
function isVisualizationRequested(text: string): boolean {
    const lowerText = text.toLowerCase();
    return (
        lowerText.includes("chart") || 
        lowerText.includes("plot") || 
        lowerText.includes("graph") || 
        lowerText.includes("visualize") || 
        lowerText.includes("visualization") ||
        lowerText.includes("show me")
    );
}

/**
 * Determines if user is asking for just the sentiment score or full analysis
 * @param text The user request text
 * @returns 'score' if only score requested, 'analysis' if full analysis requested
 */
function getRequestType(text: string): 'score' | 'analysis' {
    const lowerText = text.toLowerCase();
    
    // Keywords that indicate user wants only the score/number
    const scoreOnlyKeywords = [
        "what is the sentiment score",
        "what's the sentiment score", 
        "give me the sentiment score",
        "show me the sentiment score",
        "sentiment score for",
        "current sentiment score",
        "latest sentiment score",
        "sentiscore for",
        "what is the sentiscore",
        "what's the sentiscore",
        "give me the sentiscore",
        "show me the sentiscore",
        "current sentiscore",
        "latest sentiscore",
        "just the score",
        "only the score",
        "score only",
        "quick score"
    ];
    
    // Keywords that indicate user wants full analysis
    const analysisKeywords = [
        "sentiment analysis",
        "analyze sentiment",
        "analyze the sentiment", 
        "sentiment report",
        "detailed sentiment",
        "sentiment insights",
        "sentiment breakdown",
        "market sentiment analysis",
        "comprehensive sentiment",
        "sentiment overview",
        "sentiment assessment",
        "sentiment evaluation"
    ];
    
    // Check for score-only requests first (more specific)
    const isScoreOnly = scoreOnlyKeywords.some(keyword => lowerText.includes(keyword));
    if (isScoreOnly) {
        return 'score';
    }
    
    // Check for analysis requests
    const isAnalysis = analysisKeywords.some(keyword => lowerText.includes(keyword));
    if (isAnalysis) {
        return 'analysis';
    }
    
    // If visualization is requested, assume full analysis
    if (isVisualizationRequested(text)) {
        return 'analysis';
    }
    
    // Default to analysis for ambiguous cases
    return 'analysis';
}

// Utility function to determine period based on date range

export const CryptoSentimentAnalysisAndVisualization: Action = {
    name: "Sentiment_Analysis",
    description: "Default comprehensive sentiment analysis. Aggregates all 9 data sources (Crypto News, X/Twitter, X Influencers, Reddit, Podcast, Research, Crypto Policy, YouTube, Macro News) into a unified multi-source sentiment report with cross-source comparison and interactive visualization. Use this for a full picture; use the individual source actions for single-source deep dives.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ): Promise<boolean> => {
        const signal = options?.signal as AbortSignal | undefined;
        // Per-token streaming callback forwarded by the runtime (via
        // actionprocess / comprehensive workflow). When present, each LLM
        // delta is mirrored to the SSE stream so the user sees text grow
        // in real time during the multi-minute analysis run. When absent
        // (older callers, tests), generateText runs in non-streaming mode.
        const onToken = options?.onToken as ((delta: string) => void | Promise<void>) | undefined;
        // Strip the [ACTION_SUMMARY] envelope from the LLM's streamed deltas
        // before they reach the user. Token mode emits the envelope tokens
        // before the closing tag is seen; we suppress them inside the open
        // block so the chat-visible body never shows them. The non-stream
        // post-processing below still runs as a safety net.
        const buildEnvelopeFilter = () => {
            let inEnvelope = false;
            let pending = "";
            return (delta: string) => {
                if (!onToken || !delta) return;
                pending += delta;
                let out = "";
                while (pending.length > 0) {
                    if (inEnvelope) {
                        const close = pending.indexOf("[/ACTION_SUMMARY]");
                        if (close === -1) {
                            // Hold; closing tag may arrive in next chunk.
                            // Keep last 16 chars in case the tag is split.
                            if (pending.length > 16) pending = pending.slice(-16);
                            break;
                        }
                        pending = pending.slice(close + "[/ACTION_SUMMARY]".length).replace(/^[,\s]+/, "");
                        inEnvelope = false;
                    } else {
                        const open = pending.indexOf("[ACTION_SUMMARY]");
                        if (open === -1) {
                            // No tag — emit, but keep tail in case the
                            // opening tag is split across chunks.
                            const safe = pending.length > 16 ? pending.length - 16 : 0;
                            if (safe > 0) {
                                out += pending.slice(0, safe);
                                pending = pending.slice(safe);
                            }
                            break;
                        }
                        out += pending.slice(0, open);
                        pending = pending.slice(open + "[ACTION_SUMMARY]".length);
                        inEnvelope = true;
                    }
                }
                if (out) onToken(out);
            };
        };
        // Check stop condition at the beginning
        if (runtime.shouldStop && runtime.shouldStop()) {
            console.log('🛑 [SentimentAnalysis] Processing stopped before analysis start');
            return false;
        }

        // Default to BTC if no cryptocurrency is specified
        let assetToAnalyze = 'BTC';
        
        // First check if target is specified in options (from action context)
        if (options && options.target) {
            assetToAnalyze = options.target.toUpperCase();
        }
        // Also check if symbol is specified in parameters
        else if (options && options.symbol) {
            assetToAnalyze = options.symbol.toUpperCase();
        } else if (options?.parameters?.target) {
            assetToAnalyze = String(options.parameters.target).toUpperCase();
        } else if (options?.parameters?.symbol) {
            assetToAnalyze = String(options.parameters.symbol).toUpperCase();
        }
        // Fallback to extracting from message text
        else if (message && message.content && message.content.text) {
            // Use the identifyAsset utility to detect the asset
            assetToAnalyze = identifyAsset(message.content.text, "BTC");
        }
        
        // Get date range from options (from/to only), message, or use default (last 14 days)
        let dateRange;
        const fromParam = options?.from ?? options?.parameters?.from;
        const toParam = options?.to ?? options?.parameters?.to;

        if (fromParam && toParam) {
            // Use date part (YYYY-MM-DD) for range; from/to may include hour (YYYY-MM-DDTHH:mm)
            const fromStr = String(fromParam).trim();
            const toStr = String(toParam).trim();
            dateRange = {
                startDate: fromStr.length >= 10 ? fromStr.slice(0, 10) : fromStr,
                endDate: toStr.length >= 10 ? toStr.slice(0, 10) : toStr
            };
        } else if (message?.content?.text) {
            dateRange = getDateRangeFromRequest(message.content.text);
        } else {
            dateRange = getDefaultDateRange();
        }

        // Clamp date range to user's data retention (subscription tier)
        let dataRetentionApplied = false;
        const dataRetentionDays = typeof options?.dataRetentionDays === "number" ? options.dataRetentionDays : undefined;
        const dataRetentionMinDaysAgo = typeof options?.dataRetentionMinDaysAgo === "number" ? options.dataRetentionMinDaysAgo : undefined;
        const dataRetentionMaxDaysAgo = typeof options?.dataRetentionMaxDaysAgo === "number" ? options.dataRetentionMaxDaysAgo : undefined;
        if (
            (typeof dataRetentionDays === "number" && dataRetentionDays >= 0) ||
            (typeof dataRetentionMinDaysAgo === "number" && typeof dataRetentionMaxDaysAgo === "number")
        ) {
            const originalStart = dateRange.startDate;
            const originalEnd = dateRange.endDate;
            const start = new Date(dateRange.startDate);
            const end = new Date(dateRange.endDate);
            const totalDays = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));
            dateRange = clampDateRangeToRetention(
                { ...dateRange, totalDays },
                { dataRetentionDays, dataRetentionMinDaysAgo, dataRetentionMaxDaysAgo }
            );
            dataRetentionApplied = dateRange.startDate !== originalStart || dateRange.endDate !== originalEnd;
        }

        console.log(
            `[Sentiment_Analysis] Parsed request: asset=${assetToAnalyze}, startDate=${dateRange.startDate}, endDate=${dateRange.endDate}`
        );
        
        // Determine request type (score only or full analysis)
        const requestType = message?.content?.text ? getRequestType(message.content.text) : 'analysis';
        
        // Generate visualization only for full analysis requests
        const shouldVisualize = requestType === 'analysis';
        
        // Determine which sentiment sources to use - default to both sources
        const isXRequest = message?.content?.text ? isXTwitterRequest(message.content.text) : false;
        const isNewsOnlyRequest = message?.content?.text ? isNewsRequest(message.content.text) : false;
        // Always default to using both sources unless specifically requested otherwise
        const useBothSources = true;
        
        // Check if a specific tweet count is requested
        const tweetCount = message?.content?.text ? getTweetCountFromRequest(message.content.text) : null;
        
        try {
            // Note: Removed loading message to eliminate intermediate responses

            const request = {} as Request;
            const params = { params: { symbol: assetToAnalyze } };

            let newsData: any = null;
            let xData: any = null;
            let newsScores: SentiScore[] = [];
            let xScores: SentiScore[] = [];
            let xInfluencersScores: SentiScore[] = [];
            let redditScores: SentiScore[] = [];
            let podcastScores: SentiScore[] = [];
            let researchScores: SentiScore[] = [];
            let cryptoPolicyScores: SentiScore[] = [];
            let youtubeScores: SentiScore[] = [];
            let macroNewsScores: SentiScore[] = [];

            const tAcqStart = Date.now();
            const [newsSettled, xSettled, xInfluencersSettled, redditSettled, podcastSettled, researchSettled, cryptoPolicySettled, youtubeSettled, macroNewsSettled] = await Promise.allSettled([
                GET_sentiment_score(request, params),
                GET_X_sentiment_score(request, params),
                GET_X_influencers_sentiment_score(request, params),
                GET_reddit_sentiment_score(request, params),
                GET_podcast_sentiment_score(request, params),
                GET_research_sentiment_score(request, params),
                GET_crypto_policy_sentiment_score(request, { params: { symbol: 'ALL' } }),
                GET_youtube_sentiment_score(request, { params: { symbol: 'ALL' } }),
                GET_macro_sentiment_score(request, { params: { symbol: 'ALL' } }),
            ]);
            const dataAcquisitionMs = Date.now() - tAcqStart;
            logSentimentPerf(
                "data_acquisition",
                dataAcquisitionMs,
                "S3/news+X HTTP fetch+parse"
            );

            if (newsSettled.status === "fulfilled") {
                try {
                    newsData = await newsSettled.value.json();
                    if (!newsData.error && newsData.sentiScores) {
                        newsScores = newsData.sentiScores;
                    }
                } catch (error) {
                    console.error(`Error parsing crypto news sentiment JSON: ${error}`);
                }
            } else {
                console.error(
                    `Error fetching crypto news sentiment data: ${newsSettled.reason}`
                );
            }

            if (xSettled.status === "fulfilled") {
                try {
                    xData = await xSettled.value.json();
                    if (!xData.error && xData.sentiScores) {
                        xScores = xData.sentiScores;
                    }
                } catch (error) {
                    console.error(`Error parsing X/Twitter sentiment JSON: ${error}`);
                }
            } else {
                console.error(
                    `Error fetching X/Twitter sentiment data: ${xSettled.reason}`
                );
            }

            if (xInfluencersSettled.status === "fulfilled") {
                try {
                    const xInfluencersData = await xInfluencersSettled.value.json();
                    if (!xInfluencersData.error && xInfluencersData.sentiScores) {
                        xInfluencersScores = xInfluencersData.sentiScores;
                    }
                } catch (error) {
                    console.error(`Error parsing X Influencers sentiment JSON: ${error}`);
                }
            } else {
                console.error(
                    `Error fetching X Influencers sentiment data: ${xInfluencersSettled.reason}`
                );
            }

            if (redditSettled.status === "fulfilled") {
                try {
                    const redditData = await redditSettled.value.json();
                    if (!redditData.error && redditData.sentiScores) {
                        redditScores = redditData.sentiScores;
                    }
                } catch (error) {
                    console.error(`Error parsing Reddit sentiment JSON: ${error}`);
                }
            } else {
                console.error(
                    `Error fetching Reddit sentiment data: ${redditSettled.reason}`
                );
            }

            if (podcastSettled.status === "fulfilled") {
                try {
                    const podcastData = await podcastSettled.value.json();
                    if (!podcastData.error && podcastData.sentiScores) {
                        podcastScores = podcastData.sentiScores;
                    }
                } catch (error) {
                    console.error(`Error parsing Podcast sentiment JSON: ${error}`);
                }
            } else {
                console.error(
                    `Error fetching Podcast sentiment data: ${podcastSettled.reason}`
                );
            }

            if (researchSettled.status === "fulfilled") {
                try {
                    const researchData = await researchSettled.value.json();
                    if (!researchData.error && researchData.sentiScores) {
                        researchScores = researchData.sentiScores;
                    }
                } catch (error) {
                    console.error(`Error parsing Research sentiment JSON: ${error}`);
                }
            } else {
                console.error(
                    `Error fetching Research sentiment data: ${researchSettled.reason}`
                );
            }

            if (cryptoPolicySettled.status === "fulfilled") {
                try {
                    const cryptoPolicyData = await cryptoPolicySettled.value.json();
                    if (!cryptoPolicyData.error && cryptoPolicyData.sentiScores) {
                        cryptoPolicyScores = cryptoPolicyData.sentiScores;
                    }
                } catch (error) {
                    console.error(`Error parsing Crypto Policy sentiment JSON: ${error}`);
                }
            } else {
                console.error(
                    `Error fetching Crypto Policy sentiment data: ${cryptoPolicySettled.reason}`
                );
            }

            if (youtubeSettled.status === "fulfilled") {
                try {
                    const youtubeData = await youtubeSettled.value.json();
                    if (!youtubeData.error && youtubeData.sentiScores) {
                        youtubeScores = youtubeData.sentiScores;
                    }
                } catch (error) {
                    console.error(`Error parsing YouTube sentiment JSON: ${error}`);
                }
            } else {
                console.error(
                    `Error fetching YouTube sentiment data: ${youtubeSettled.reason}`
                );
            }

            if (macroNewsSettled.status === "fulfilled") {
                try {
                    const macroNewsData = await macroNewsSettled.value.json();
                    if (!macroNewsData.error && macroNewsData.sentiScores) {
                        macroNewsScores = macroNewsData.sentiScores;
                    }
                } catch (error) {
                    console.error(`Error parsing Macro News sentiment JSON: ${error}`);
                }
            } else {
                console.error(
                    `Error fetching Macro News sentiment data: ${macroNewsSettled.reason}`
                );
            }

            // Check stop condition after data fetching
            if (runtime.shouldStop && runtime.shouldStop()) {
                console.log('🛑 [SentimentAnalysis] Processing stopped after data fetching');
                return false;
            }

            // Check if we have any data
            if (newsScores.length === 0 && xScores.length === 0 && xInfluencersScores.length === 0 && redditScores.length === 0 && podcastScores.length === 0 && researchScores.length === 0 && cryptoPolicyScores.length === 0 && youtubeScores.length === 0 && macroNewsScores.length === 0) {
                await callback(createActionErrorResponse({
                    actionName: "Sentiment_Analysis",
                    type: "sentiment_analysis_error",
                    error: new Error("No sentiment data available"),
                    text: `Sorry, there is no sentiment data available for ${assetToAnalyze} from any source.`,
                }));
                return true;
            }
            
            // Filter scores by date range
            const startTimestamp = new Date(dateRange.startDate).getTime() / 1000;
            const endTimestamp = new Date(dateRange.endDate).getTime() / 1000 + 86400; // Include the full end day
            
            const filteredNewsScores = newsScores.filter(score => 
                score.time >= startTimestamp && score.time <= endTimestamp
            );
            
            let filteredXScores = xScores.filter(score =>
                score.time >= startTimestamp && score.time <= endTimestamp
            );

            const filteredXInfluencersScores = xInfluencersScores.filter(score =>
                score.time >= startTimestamp && score.time <= endTimestamp
            );

            const filteredRedditScores = redditScores.filter(score =>
                score.time >= startTimestamp && score.time <= endTimestamp
            );

            const filteredPodcastScores = podcastScores.filter(score =>
                score.time >= startTimestamp && score.time <= endTimestamp
            );

            const filteredResearchScores = researchScores.filter(score =>
                score.time >= startTimestamp && score.time <= endTimestamp
            );

            const filteredCryptoPolicyScores = cryptoPolicyScores.filter(score =>
                score.time >= startTimestamp && score.time <= endTimestamp
            );

            const filteredYoutubeScores = youtubeScores.filter(score =>
                score.time >= startTimestamp && score.time <= endTimestamp
            );

            const filteredMacroNewsScores = macroNewsScores.filter(score =>
                score.time >= startTimestamp && score.time <= endTimestamp
            );

            // Handle tweet count filtering for X data
            if (tweetCount && filteredXScores.length > 0) {
                filteredXScores = [...filteredXScores].sort((a, b) => b.time - a.time).slice(0, tweetCount);
            }
            
            // Check if we have filtered data
            if (filteredNewsScores.length === 0 && filteredXScores.length === 0 && filteredXInfluencersScores.length === 0 && filteredRedditScores.length === 0 && filteredPodcastScores.length === 0 && filteredResearchScores.length === 0 && filteredCryptoPolicyScores.length === 0 && filteredYoutubeScores.length === 0) {
                const errorMessage = tweetCount 
                    ? `No sentiment data found for ${assetToAnalyze} from ${tweetCount} latest tweets or crypto news articles between ${dateRange.startDate} and ${dateRange.endDate}.`
                    : `No sentiment data found for ${assetToAnalyze} between ${dateRange.startDate} and ${dateRange.endDate}.`;
                
                await callback(createActionErrorResponse({
                    actionName: "Sentiment_Analysis",
                    type: "sentiment_analysis_error",
                    error: new Error("No sentiment data found"),
                    text: errorMessage,
                }));
                return true;
            }
            
            // If user only wants the score, provide a simple response
            if (requestType === 'score') {
                let scoreText = `**${assetToAnalyze} Sentiment Scores**\n\n`;
                
                if (filteredNewsScores.length > 0) {
                    const newsAvg = filteredNewsScores.reduce((sum, score) => sum + score.value, 0) / filteredNewsScores.length;
                    const latestNewsScore = [...filteredNewsScores].sort((a, b) => b.time - a.time)[0];
                    const latestNewsDate = new Date(latestNewsScore.time * 1000).toLocaleDateString();
                    
                    scoreText += `📰 **Crypto News Sentiment**\n`;
                    scoreText += `📊 **Current Score:** ${latestNewsScore.value.toFixed(3)}\n`;
                    scoreText += `📅 **Date:** ${latestNewsDate}\n`;
                    scoreText += `📈 **Average Score:** ${newsAvg.toFixed(3)}\n`;
                    scoreText += `📋 **Data Points:** ${filteredNewsScores.length}\n\n`;
                }
                
                if (filteredXScores.length > 0) {
                    const xAvg = filteredXScores.reduce((sum, score) => sum + score.value, 0) / filteredXScores.length;
                    const latestXScore = [...filteredXScores].sort((a, b) => b.time - a.time)[0];
                    const latestXDate = new Date(latestXScore.time * 1000).toLocaleDateString();
                    
                    scoreText += `🐦 **X/Twitter Sentiment**\n`;
                    scoreText += `📊 **Current Score:** ${latestXScore.value.toFixed(3)}\n`;
                    scoreText += `📅 **Date:** ${latestXDate}\n`;
                    scoreText += `📈 **Average Score:** ${xAvg.toFixed(3)}\n`;
                    scoreText += `📋 **Data Points:** ${filteredXScores.length}${tweetCount ? ` (${tweetCount} most recent tweets)` : ''}\n\n`;
                }
                
                scoreText += `*Score Range: -1.0 (Very Negative) to +1.0 (Very Positive)*`;
                
                await callback(createActionResponse({
                    actionName: "Sentiment_Analysis",
                    type: "sentiment_analysis",
                    text: scoreText,
                    additionalMetadata: dataRetentionApplied ? { dataRetentionApplied: true } : undefined,
                }));
                return true;
            }

            const tProcStart = Date.now();
            // Raw flat array kept for chart rendering only
            const allFilteredScores = [
                ...filteredNewsScores,
                ...filteredXScores,
                ...filteredXInfluencersScores,
                ...filteredRedditScores,
                ...filteredPodcastScores,
                ...filteredResearchScores,
                ...filteredCryptoPolicyScores,
                ...filteredYoutubeScores,
                ...filteredMacroNewsScores,
            ];

            // Time-aligned series: for each hour, average across all sources that
            // have data at that time point, then average those hourly values.
            const timeValueMap = new Map<number, number[]>();
            for (const s of allFilteredScores) {
                const bucket = timeValueMap.get(s.time) ?? [];
                bucket.push(s.value);
                timeValueMap.set(s.time, bucket);
            }
            const alignedScores = Array.from(timeValueMap.entries())
                .sort(([a], [b]) => a - b)
                .map(([time, vals]) => ({
                    time,
                    value: vals.reduce((s, v) => s + v, 0) / vals.length,
                }));

            const totalScores = alignedScores.length;
            const avgSentiment =
                totalScores > 0
                    ? alignedScores.reduce((sum, s) => sum + s.value, 0) / totalScores
                    : 0;

            let posCount = 0;
            let negCount = 0;
            let zeroCount = 0;
            let sumPosVals = 0;
            let sumNegVals = 0;
            let sumZeroVals = 0;
            for (const s of alignedScores) {
                if (s.value > 0) {
                    posCount++;
                    sumPosVals += s.value;
                } else if (s.value < 0) {
                    negCount++;
                    sumNegVals += s.value;
                } else {
                    zeroCount++;
                    sumZeroVals += s.value;
                }
            }

            const avgPositive =
                posCount > 0 ? sumPosVals / posCount : 0;
            const avgNegative =
                negCount > 0 ? sumNegVals / negCount : 0;
            const avgNeutral =
                zeroCount > 0 ? sumZeroVals / zeroCount : 0;

            let sentimentChange = 0;
            let sentimentTrend = "stable";

            if (alignedScores.length > 1) {
                const firstScore = alignedScores[0].value;
                const lastScore = alignedScores[alignedScores.length - 1].value;
                sentimentChange = lastScore - firstScore;

                const changeThreshold = 0.01;

                if (Math.abs(sentimentChange) < changeThreshold) {
                    sentimentTrend = "stable";
                } else if (sentimentChange > 0) {
                    sentimentTrend = "increasing";
                } else {
                    sentimentTrend = "decreasing";
                }

                if (alignedScores.length >= 5) {
                    const n = alignedScores.length;
                    let sumX = 0;
                    let sumY = 0;
                    let sumXY = 0;
                    let sumX2 = 0;

                    alignedScores.forEach((score, index) => {
                        const x = index;
                        const y = score.value;
                        sumX += x;
                        sumY += y;
                        sumXY += x * y;
                        sumX2 += x * x;
                    });

                    const slope =
                        (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

                    if (Math.abs(slope) > 0.005) {
                        sentimentTrend = slope > 0 ? "increasing" : "decreasing";
                        sentimentChange = slope * (n - 1);
                    }
                }
            }

            const mean = avgSentiment;
            const squaredDiffs = alignedScores.map((score) =>
                Math.pow(score.value - mean, 2)
            );
            const avgSquaredDiff =
                squaredDiffs.reduce((sum, diff) => sum + diff, 0) /
                (totalScores || 1);
            const volatility = Math.sqrt(avgSquaredDiff);

            let chartPath = "";
            let visualizationMessage = "";

            // Create comprehensive sentiment analysis template
            const dataSources = [];
            if (filteredNewsScores.length > 0) dataSources.push('Crypto News');
            if (filteredXScores.length > 0) dataSources.push('X/Twitter');
            if (filteredXInfluencersScores.length > 0) dataSources.push('X Influencers');
            if (filteredRedditScores.length > 0) dataSources.push('Reddit');
            if (filteredPodcastScores.length > 0) dataSources.push('Podcast');
            if (filteredResearchScores.length > 0) dataSources.push('Research');
            if (filteredCryptoPolicyScores.length > 0) dataSources.push('Crypto Policy');
            if (filteredYoutubeScores.length > 0) dataSources.push('YouTube');
            if (filteredMacroNewsScores.length > 0) dataSources.push('Macro News');
            const dataSourceText = dataSources.join(' and ');
            
            // Single template that can handle both individual and combined analysis
            const createSentimentAnalysisTemplate = (
                sourceType: string,
                sourceScores: SentiScore[],
                sourceMetrics: {
                    total: number;
                    avg: number;
                    positive: number;
                    negative: number;
                    neutral: number;
                    trend: string;
                    change: number;
                    volatility: number;
                },
                startDate: string,
                endDate: string
            ) => {
                // Calculate additional statistical metrics
                const values = sourceScores.map(s => s.value);
                const sortedValues = [...values].sort((a, b) => a - b);
                const median = sortedValues.length % 2 === 0 
                    ? (sortedValues[sortedValues.length / 2 - 1] + sortedValues[sortedValues.length / 2]) / 2
                    : sortedValues[Math.floor(sortedValues.length / 2)];
                
                const q1Index = Math.floor(sortedValues.length * 0.25);
                const q3Index = Math.floor(sortedValues.length * 0.75);
                const q1 = sortedValues[q1Index];
                const q3 = sortedValues[q3Index];
                const iqr = q3 - q1;

                const min = sortedValues[0];
                const max = sortedValues[sortedValues.length - 1];
                const range = max - min;
                
                // Calculate sentiment distribution percentages
                const positiveCount = sourceScores.filter(s => s.value > 0.1).length;
                const negativeCount = sourceScores.filter(s => s.value < -0.1).length;
                const neutralCount = sourceScores.filter(s => s.value >= -0.1 && s.value <= 0.1).length;
                
                const positivePercentage = (positiveCount / sourceScores.length) * 100;
                const negativePercentage = (negativeCount / sourceScores.length) * 100;
                const neutralPercentage = (neutralCount / sourceScores.length) * 100;
                
                // Calculate recent vs historical comparison (if enough data)
                let recentTrend = "insufficient data";
                let momentumScore = 0;
                if (sourceScores.length >= 10) {
                    const recentPortion = Math.floor(sourceScores.length * 0.3);
                    const recent = values.slice(-recentPortion);
                    const historical = values.slice(0, -recentPortion);
                    
                    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
                    const historicalAvg = historical.reduce((a, b) => a + b, 0) / historical.length;
                    
                    momentumScore = ((recentAvg - historicalAvg) / Math.abs(historicalAvg)) * 100;
                    recentTrend = momentumScore > 5 ? "accelerating positive" :
                                 momentumScore > 1 ? "trending positive" :
                                 momentumScore < -5 ? "accelerating negative" :
                                 momentumScore < -1 ? "trending negative" : "stable";
                }
                
                // Volatility classification
                const volatilityLevel = sourceMetrics.volatility > 0.15 ? "High" :
                                      sourceMetrics.volatility > 0.08 ? "Moderate" :
                                      sourceMetrics.volatility > 0.03 ? "Low" : "Minimal";
                
                // Confidence score based on data quality
                const dataQualityScore = Math.min(100, (sourceScores.length / 50) * 100);
                const volatilityPenalty = Math.max(0, (sourceMetrics.volatility - 0.05) * 200);
                const confidenceScore = Math.max(0, dataQualityScore - volatilityPenalty);
                
                // Create the data metrics display first
                const dataMetricsDisplay = `📊 **SENTIMENT DATA METRICS:**
- **Total data points:** ${sourceMetrics.total}
- **Average sentiment score:** ${sourceMetrics.avg.toFixed(4)}
- **Average positive sentiment:** ${sourceMetrics.positive.toFixed(4)}
- **Average negative sentiment:** ${sourceMetrics.negative.toFixed(4)}
- **Sentiment trend:** ${sourceMetrics.trend} (${sourceMetrics.change > 0 ? "+" : ""}${sourceMetrics.change.toFixed(4)})
- **Sentiment volatility:** ${sourceMetrics.volatility.toFixed(4)}

`;

                return `${dataMetricsDisplay}
Analyzing ${sourceType} sentiment data for ${assetToAnalyze} from ${startDate} to ${endDate} (${sourceMetrics.total} data points).

Statistical details:
- Median: ${median.toFixed(4)}, Q1: ${q1.toFixed(4)}, Q3: ${q3.toFixed(4)}, IQR: ${iqr.toFixed(4)}
- Range: ${min.toFixed(4)} to ${max.toFixed(4)} (${range.toFixed(4)})
- Distribution: ${positivePercentage.toFixed(1)}% positive, ${neutralPercentage.toFixed(1)}% neutral, ${negativePercentage.toFixed(1)}% negative
- Recent trend: ${recentTrend} (momentum score: ${momentumScore.toFixed(2)}%)
- Volatility level: ${volatilityLevel} (${sourceMetrics.volatility.toFixed(4)})
- Data quality confidence: ${confidenceScore.toFixed(0)}%`;
                       };

            // Format current date in a readable format
            const currentDate = new Date();
            const formattedDate = currentDate.toLocaleDateString('en-US', { 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric' 
            });

            // Create the output message
            const sourceDescription = tweetCount 
                ? `${dataSourceText} (${tweetCount} most recent tweets from X/Twitter)`
                : `${dataSourceText} (${dateRange.startDate} to ${dateRange.endDate})`;
            
            const reportHeader = `CRYPTOCURRENCY SENTIMENT ANALYSIS: ${assetToAnalyze}\nDate: ${formattedDate}\nSources: ${sourceDescription}\n\n`;

            // Note: Removed separate header message to eliminate intermediate responses

            // ── SOURCES_CONFIG ────────────────────────────────────────────────────
            // Single source-of-truth for the 9 sentiment sources. Everything below
            // (metrics, display strings, LLM templates, result parsing, section
            // assembly, structuredResult scores, summary) is driven by this array.
            type SourceMetrics = NonNullable<ReturnType<typeof computeSourceMetrics>>;

            const SOURCES_CONFIG = [
                { key: 'xTwitter',     label: 'X/Twitter',     emoji: '🐦', pngKey: 'x',           scores: filteredXScores,            sectionTitle: 'X/TWITTER SENTIMENT ANALYSIS',     analysisDataKey: 'xTwitter',     countLabel: 'tweets',               extraDisplay: tweetCount ? ` (${tweetCount} most recent tweets)` : '' },
                { key: 'cryptoNews',   label: 'Crypto News',   emoji: '📰', pngKey: 'news',         scores: filteredNewsScores,          sectionTitle: 'CRYPTO NEWS SENTIMENT ANALYSIS',   analysisDataKey: 'cryptoNews',   countLabel: 'news articles',         extraDisplay: '' },
                { key: 'xInfluencers', label: 'X Influencers', emoji: '🌟', pngKey: 'xInfluencers', scores: filteredXInfluencersScores,  sectionTitle: 'X INFLUENCERS SENTIMENT ANALYSIS', analysisDataKey: 'xInfluencers', countLabel: 'X influencer posts',    extraDisplay: '' },
                { key: 'reddit',       label: 'Reddit',        emoji: '💬', pngKey: 'reddit',       scores: filteredRedditScores,        sectionTitle: 'REDDIT SENTIMENT ANALYSIS',        analysisDataKey: 'reddit',       countLabel: 'Reddit posts',          extraDisplay: '' },
                { key: 'podcast',      label: 'Podcast',       emoji: '🎙️', pngKey: 'podcast',      scores: filteredPodcastScores,       sectionTitle: 'PODCAST SENTIMENT ANALYSIS',       analysisDataKey: 'podcast',      countLabel: 'podcast entries',       extraDisplay: '' },
                { key: 'research',     label: 'Research',      emoji: '📑', pngKey: 'research',     scores: filteredResearchScores,      sectionTitle: 'RESEARCH SENTIMENT ANALYSIS',      analysisDataKey: 'research',     countLabel: 'research entries',      extraDisplay: '' },
                { key: 'cryptoPolicy', label: 'Crypto Policy', emoji: '⚖️', pngKey: 'cryptoPolicy', scores: filteredCryptoPolicyScores,  sectionTitle: 'CRYPTO POLICY SENTIMENT ANALYSIS', analysisDataKey: 'cryptoPolicy', countLabel: 'crypto policy entries', extraDisplay: '' },
                { key: 'youtube',      label: 'YouTube',       emoji: '📺', pngKey: 'youtube',      scores: filteredYoutubeScores,       sectionTitle: 'YOUTUBE SENTIMENT ANALYSIS',       analysisDataKey: 'youtube',      countLabel: 'YouTube entries',       extraDisplay: '' },
                { key: 'macroNews',    label: 'Macro News',    emoji: '🌐', pngKey: 'macroNews',    scores: filteredMacroNewsScores,     sectionTitle: 'MACRO NEWS SENTIMENT ANALYSIS',    analysisDataKey: 'macroNews',    countLabel: 'macro news entries',    extraDisplay: '' },
            ] as const;
            type SourceKey = typeof SOURCES_CONFIG[number]['key'];

            // 1. Compute metrics for all sources in one pass
            const sourceMetricsMap = Object.fromEntries(
                SOURCES_CONFIG.map(s => [s.key, computeSourceMetrics(s.scores)])
            ) as Record<SourceKey, ReturnType<typeof computeSourceMetrics>>;
            // Aliases needed by the comparison analysis section below (uses these by name)
            const newsMetrics = sourceMetricsMap.cryptoNews;
            const xMetrics = sourceMetricsMap.xTwitter;
            const xInfluencersMetrics = sourceMetricsMap.xInfluencers;
            const redditMetrics = sourceMetricsMap.reddit;
            const podcastMetrics = sourceMetricsMap.podcast;
            const researchMetrics = sourceMetricsMap.research;
            const cryptoPolicyMetrics = sourceMetricsMap.cryptoPolicy;
            const youtubeMetrics = sourceMetricsMap.youtube;
            const macroNewsMetrics = sourceMetricsMap.macroNews;

            // 2. Build metrics display strings for all sources in one pass
            const sourceMetricsDisplayMap = Object.fromEntries(
                SOURCES_CONFIG.map(s => {
                    const m = sourceMetricsMap[s.key];
                    if (!s.scores.length || !m) return [s.key, ""];
                    return [s.key, `📊 **SENTIMENT DATA METRICS:**\n- **Total data points:** ${m.total}${s.extraDisplay}\n- **Average sentiment score:** ${m.avg.toFixed(4)}\n- **Average positive sentiment:** ${m.positive.toFixed(4)}\n- **Average negative sentiment:** ${m.negative.toFixed(4)}\n- **Sentiment trend:** ${m.trend} (${m.change > 0 ? "+" : ""}${m.change.toFixed(4)})\n- **Sentiment volatility:** ${m.volatility.toFixed(4)}\n\n`];
                })
            ) as Record<SourceKey, string>;
            // Individual aliases for any downstream code referencing them by name
            const xMetricsDisplay = sourceMetricsDisplayMap.xTwitter;
            const newsMetricsDisplay = sourceMetricsDisplayMap.cryptoNews;
            const xInfluencersMetricsDisplay = sourceMetricsDisplayMap.xInfluencers;
            const redditMetricsDisplay = sourceMetricsDisplayMap.reddit;
            const podcastMetricsDisplay = sourceMetricsDisplayMap.podcast;
            const researchMetricsDisplay = sourceMetricsDisplayMap.research;
            const cryptoPolicyMetricsDisplay = sourceMetricsDisplayMap.cryptoPolicy;
            const youtubeMetricsDisplay = sourceMetricsDisplayMap.youtube;
            const macroNewsMetricsDisplay = sourceMetricsDisplayMap.macroNews;

            const comparisonTokenFilter = buildEnvelopeFilter();

            const runChart = async (): Promise<{
                chartPath: string;
                visualizationMessage: string;
            }> => {
                if (!shouldVisualize) {
                    return { chartPath: "", visualizationMessage: "" };
                }
                const savedDataDir = path.join(process.cwd(), "saved_data");
                const chartDir = path.join(savedDataDir, "Charts");
                const dateRangeKey = determineDateRange(
                    dateRange.startDate,
                    dateRange.endDate
                );
                const filename = `Sentiment Chart ${assetToAnalyze} ${dateRangeKey}.html`;
                const filepath = path.join(chartDir, filename);

                try {
                    if (fs.existsSync(filepath)) {
                        const st = await fs.promises.stat(filepath);
                        // Treat 0-byte files as missing — a previous run can leave an
                        // empty file on disk (e.g. a crash mid-write or a watcher race),
                        // and serving its URL gives the user a blank iframe.
                        if (
                            st.size > 0 &&
                            Date.now() - st.mtimeMs < CHART_FILE_CACHE_MS
                        ) {
                            return {
                                chartPath: buildChartProxyUrl(
                                    filepath,
                                    runtime.agentId
                                ),
                                visualizationMessage: `\n\nI've also created an interactive chart combining ${assetToAnalyze} price data with SentiScore data. Click the chart button below to view the visualization.`,
                            };
                        }
                    }
                } catch {
                    // ignore stat errors; fall through to regenerate
                }

                try {
                    const cryptoData = await getCryptoData(
                        assetToAnalyze,
                        dateRange.startDate,
                        dateRange.endDate
                    );
                    if (cryptoData.length > 0) {
                        const chartHTML = generateChartHTML(
                            cryptoData,
                            alignedScores,
                            assetToAnalyze
                        );
                        const savedPath = await saveChartToFile(
                            chartHTML,
                            assetToAnalyze,
                            dateRange.startDate,
                            dateRange.endDate
                        );
                        return {
                            chartPath: buildChartProxyUrl(
                                savedPath,
                                runtime.agentId
                            ),
                            visualizationMessage: `\n\nI've also created an interactive chart combining ${assetToAnalyze} price data with SentiScore data. Click the chart button below to view the visualization.`,
                        };
                    }
                    return {
                        chartPath: "",
                        visualizationMessage: `\n\nI attempted to create a visualization but couldn't retrieve price data for ${assetToAnalyze} from CoinGlass.`,
                    };
                } catch (error) {
                    console.error(`Error generating visualization: ${error}`);
                    return {
                        chartPath: "",
                        visualizationMessage: `\n\nI attempted to create a visualization but encountered an error: ${error}`,
                    };
                }
            };

            const runLlm = async (pngs: Record<string, Buffer | null> = {}): Promise<{
                xAnalysis: string;
                newsAnalysis: string;
                xInfluencersAnalysis: string;
                redditAnalysis: string;
                podcastAnalysis: string;
                researchAnalysis: string;
                cryptoPolicyAnalysis: string;
                youtubeAnalysis: string;
                macroNewsAnalysis: string;
                comparisonAnalysis: string;
                analysisMap: Record<SourceKey, string>;
            }> => {
                const toAttachment = (buf: Buffer | null | undefined) =>
                    buf ? [{ type: "image", data: buf.toString("base64"), mimeType: "image/png" }] : undefined;

                // 3. Build LLM prompt templates for all sources in one pass
                const templateMap = Object.fromEntries(
                    SOURCES_CONFIG.map(s => {
                        const m = sourceMetricsMap[s.key];
                        return [s.key, s.scores.length > 0 && m
                            ? createSentimentAnalysisTemplate(s.label, s.scores, m, dateRange.startDate, dateRange.endDate)
                            : ""];
                    })
                ) as Record<SourceKey, string>;

                // 4. Fire all source LLM calls in parallel and parse results
                const errMsg = "Error: Unable to generate sentiment analysis due to API limitations. Please try again later.";
                const llmResults = await Promise.allSettled(
                    SOURCES_CONFIG.map(s =>
                        templateMap[s.key]
                            ? generateText({ runtime, system: SENTIMENT_ANALYSIS_SYSTEM, prompt: templateMap[s.key], modelClass: ModelClass.MEDIUM, signal, imageAttachments: toAttachment(pngs[s.pngKey]) })
                            : Promise.resolve("")
                    )
                );
                const analysisMap = Object.fromEntries(
                    SOURCES_CONFIG.map((s, i) => {
                        const result = llmResults[i];
                        if (result.status === "fulfilled") {
                            return [s.key, result.value.replace(/\[ACTION_SUMMARY\][\s\S]*?\[\/ACTION_SUMMARY\][,\s]*/g, "").trim()];
                        }
                        console.error(`${s.label} sentiment narrative failed:`, result.reason);
                        return [s.key, templateMap[s.key] ? errMsg : ""];
                    })
                ) as Record<SourceKey, string>;

                // Aliases for the comparison analysis section which references these by name
                const xAnalysis = analysisMap.xTwitter;
                const newsAnalysis = analysisMap.cryptoNews;
                const xInfluencersAnalysis = analysisMap.xInfluencers;
                const redditAnalysis = analysisMap.reddit;
                const podcastAnalysis = analysisMap.podcast;
                const researchAnalysis = analysisMap.research;
                const cryptoPolicyAnalysis = analysisMap.cryptoPolicy;
                const youtubeAnalysis = analysisMap.youtube;
                const macroNewsAnalysis = analysisMap.macroNews;

                onToken?.("\n\n## 🌟 X Influencers Sentiment\n\n");
                onToken?.("\n\n## 💬 Reddit Sentiment\n\n");
                onToken?.("\n\n## 🎙️ Podcast Sentiment\n\n");
                onToken?.("\n\n## 📑 Research Sentiment\n\n");
                onToken?.("\n\n## ⚖️ Crypto Policy Sentiment\n\n");
                onToken?.("\n\n## 📺 YouTube Sentiment\n\n");
                onToken?.("\n\n## 🌐 Macro News Sentiment\n\n");

                let comparisonAnalysis = "";
                const availableSourceMetrics = [
                    newsMetrics ? { label: "Crypto News", metrics: newsMetrics, count: filteredNewsScores.length } : null,
                    xMetrics ? { label: "X/Twitter", metrics: xMetrics, count: filteredXScores.length } : null,
                    xInfluencersMetrics ? { label: "X Influencers", metrics: xInfluencersMetrics, count: filteredXInfluencersScores.length } : null,
                    redditMetrics ? { label: "Reddit", metrics: redditMetrics, count: filteredRedditScores.length } : null,
                    podcastMetrics ? { label: "Podcast", metrics: podcastMetrics, count: filteredPodcastScores.length } : null,
                    researchMetrics ? { label: "Research", metrics: researchMetrics, count: filteredResearchScores.length } : null,
                    cryptoPolicyMetrics ? { label: "Crypto Policy", metrics: cryptoPolicyMetrics, count: filteredCryptoPolicyScores.length } : null,
                    youtubeMetrics ? { label: "YouTube", metrics: youtubeMetrics, count: filteredYoutubeScores.length } : null,
                    macroNewsMetrics ? { label: "Macro News", metrics: macroNewsMetrics, count: filteredMacroNewsScores.length } : null,
                ].filter(Boolean) as Array<{ label: string; metrics: NonNullable<ReturnType<typeof computeSourceMetrics>>; count: number }>;

                if (availableSourceMetrics.length >= 2) {
                    const newsWeight = 0.6;
                    const xWeight = 0.4;
                    const newsM = newsMetrics;
                    const xM = xMetrics;
                    const sentimentDivergence = newsM && xM ? Math.abs(newsM.avg - xM.avg) : 0;

                    const weightedAvg = newsM && xM
                        ? newsM.avg * newsWeight + xM.avg * xWeight
                        : availableSourceMetrics.reduce((sum, s) => sum + s.metrics.avg, 0) / availableSourceMetrics.length;
                    const totalDataPoints = availableSourceMetrics.reduce((sum, s) => sum + s.count, 0);
                    const equalWeightedAvg = availableSourceMetrics.reduce((sum, s) => sum + s.metrics.avg, 0) / availableSourceMetrics.length;
                    const weightingImpact = Math.abs(weightedAvg - equalWeightedAvg);

                    const correlationStrength = newsM && xM
                        ? 1 - sentimentDivergence / Math.max(Math.abs(newsM.avg), Math.abs(xM.avg), 0.1)
                        : 0.5;
                    const volatilityDiff = newsM && xM ? Math.abs(newsM.volatility - xM.volatility) : 0;
                    const dataBalanceRatio = newsM && xM
                        ? Math.min(filteredNewsScores.length, filteredXScores.length) /
                          Math.max(filteredNewsScores.length, filteredXScores.length)
                        : 1;

                    const sourcesAlignment =
                        correlationStrength > 0.7
                            ? "Strong"
                            : correlationStrength > 0.4
                              ? "Moderate"
                              : "Weak";
                    const combinedConfidence = Math.min(
                        100,
                        (dataBalanceRatio * 0.4 + correlationStrength * 0.6) * 100
                    );

                    const sourceLines = availableSourceMetrics
                        .map(s => `• **${s.label}:** ${s.metrics.avg.toFixed(4)} | ${s.count} data points | Volatility: ${s.metrics.volatility.toFixed(4)}`)
                        .join("\n");

                    const crossSourceMetricsDisplay = `📊 **MULTI-SOURCE SENTIMENT DATA OVERVIEW:**
- **Total Dataset:** ${totalDataPoints} data points
- **Combined Confidence:** ${combinedConfidence.toFixed(0)}% (${combinedConfidence > 75 ? "High" : combinedConfidence > 50 ? "Moderate" : "Low"})
- **Data Balance Ratio:** ${dataBalanceRatio.toFixed(2)}
- **Source Correlation:** ${correlationStrength.toFixed(3)} (${sourcesAlignment} alignment)

🔗 **WEIGHTED SENTIMENT METRICS (News 60% + Twitter 40% where available):**
• **Weighted Composite Score:** ${weightedAvg.toFixed(4)} [Impact: ${weightingImpact.toFixed(4)} vs equal weighting],
${sourceLines}
• **Cross-Source Divergence:** ${sentimentDivergence.toFixed(4)} | Volatility Differential: ${volatilityDiff.toFixed(4)}

`;

                    const comparisonPrompt = `${crossSourceMetricsDisplay}Based on the above cross-source data metrics for ${assetToAnalyze} ${tweetCount ? `from the ${tweetCount} most recent tweets` : `from ${dateRange.startDate} to ${dateRange.endDate}`}:

- Composite confidence: ${combinedConfidence.toFixed(0)}% (${combinedConfidence > 75 ? "High" : combinedConfidence > 50 ? "Moderate" : "Low"})
- Source alignment: ${sourcesAlignment} agreement
- Divergence: ${sentimentDivergence > 0.1 ? "SIGNIFICANT divergence detected" : "Sources showing alignment"}
- Volatility differential: ${volatilityDiff > 0.05 ? "High" : "Consistent"}
- Data balance: ${dataBalanceRatio > 0.7 ? "BALANCED" : dataBalanceRatio > 0.4 ? "MODERATELY BIASED" : "IMBALANCED"}
- Weighting impact: ${weightingImpact > 0.02 ? "SIGNIFICANT" : "MINIMAL"}
- Signal strength: ${Math.abs(weightedAvg) > 0.1 ? "STRONG directional bias" : Math.abs(weightedAvg) > 0.03 ? "MODERATE signal" : "NEUTRAL/MIXED signals"}
- Cross-validation: ${sourcesAlignment === "Strong" && Math.abs(sentimentDivergence) < 0.1 ? "CONFIRMED trend" : "CONFLICTING signals"}
- Risk level: ${combinedConfidence > 75 && sourcesAlignment === "Strong" ? "LOW uncertainty" : "ELEVATED uncertainty"}
- Available sources: ${availableSourceMetrics.map(s => s.label).join(", ")}

QUANTITATIVE CONCLUSION: Provide a clear ${weightedAvg > 0.05 ? "BULLISH CONSENSUS" : weightedAvg < -0.05 ? "BEARISH CONSENSUS" : "NEUTRAL EQUILIBRIUM"} assessment with ${combinedConfidence.toFixed(0)}% statistical confidence across all available sources.`;

                    onToken?.(
                        "\n\n## 🔄 Cross-Source Sentiment Comparison\n\n"
                    );
                    try {
                        comparisonAnalysis = await generateText({
                            runtime,
                            system: COMPARISON_ANALYSIS_SYSTEM,
                            prompt: comparisonPrompt,
                            modelClass: ModelClass.LARGE,
                            signal,
                            onToken: onToken
                                ? comparisonTokenFilter
                                : undefined,
                            imageAttachments: toAttachment(pngs.combined),
                        });
                        comparisonAnalysis = comparisonAnalysis
                            .replace(
                                /\[ACTION_SUMMARY\][\s\S]*?\[\/ACTION_SUMMARY\]/g,
                                ""
                            )
                            .trim();
                    } catch (error) {
                        console.error(
                            "Error generating cross-source sentiment comparison:",
                            error
                        );
                        throw error;
                    }
                }

                return { xAnalysis, newsAnalysis, xInfluencersAnalysis, redditAnalysis, podcastAnalysis, researchAnalysis, cryptoPolicyAnalysis, youtubeAnalysis, macroNewsAnalysis, comparisonAnalysis, analysisMap };
            };

            const dataProcessingMs = Date.now() - tProcStart;
            logSentimentPerf(
                "data_processing",
                dataProcessingMs,
                "filter+stats+metric strings+templates (pre-parallel)"
            );

            // Generate per-source PNGs (hourly) from in-memory filtered scores so
            // they are ready to attach to each source's LLM call during the parallel phase.
            const pngChartDir = path.join(process.cwd(), "saved_data", "Charts");
            if (!fs.existsSync(pngChartDir)) fs.mkdirSync(pngChartDir, { recursive: true });

            const SOURCE_PNG_SPECS = [
                { key: "news",         scores: filteredNewsScores,         label: `${assetToAnalyze} — Crypto News`,     color: "rgb(239, 68, 68)"   },
                { key: "x",            scores: filteredXScores,            label: `${assetToAnalyze} — X/Twitter`,       color: "rgb(59, 130, 246)"  },
                { key: "xInfluencers", scores: filteredXInfluencersScores, label: `${assetToAnalyze} — X Influencers`,   color: "rgb(168, 85, 247)"  },
                { key: "reddit",       scores: filteredRedditScores,       label: `${assetToAnalyze} — Reddit`,          color: "rgb(249, 115, 22)"  },
                { key: "podcast",      scores: filteredPodcastScores,      label: `${assetToAnalyze} — Podcast`,         color: "rgb(20, 184, 166)"  },
                { key: "research",     scores: filteredResearchScores,     label: `${assetToAnalyze} — Research`,        color: "rgb(234, 179, 8)"   },
                { key: "cryptoPolicy", scores: filteredCryptoPolicyScores, label: `${assetToAnalyze} — Crypto Policy`,   color: "rgb(107, 114, 128)" },
                { key: "youtube",      scores: filteredYoutubeScores,      label: `${assetToAnalyze} — YouTube`,         color: "rgb(220, 38, 38)"   },
                { key: "macroNews",    scores: filteredMacroNewsScores,    label: `${assetToAnalyze} — Macro News`,      color: "rgb(16, 185, 129)"  },
                { key: "combined",     scores: alignedScores,              label: `${assetToAnalyze} — Combined (all sources)`, color: "rgb(99, 102, 241)" },
            ] as const;

            type PngKey = typeof SOURCE_PNG_SPECS[number]["key"];
            const sentimentPngs: Record<string, Buffer | null> = {};

            await Promise.all(
                SOURCE_PNG_SPECS.map(async spec => {
                    if (spec.scores.length === 0) {
                        sentimentPngs[spec.key] = null;
                        return;
                    }
                    try {
                        const buf = await generateSentimentPNG(
                            [...spec.scores].sort((a, b) => a.time - b.time),
                            spec.label,
                            spec.color
                        );
                        sentimentPngs[spec.key] = buf;
                        const filename = `Sentiment Chart ${spec.label.replace(/[^a-zA-Z0-9 ]/g, "")} ${dateRange.startDate}_${dateRange.endDate}.png`;
                        await fs.promises.writeFile(path.join(pngChartDir, filename), buf);
                    } catch (err) {
                        console.warn(`[sentiscore] PNG generation failed for ${spec.key} (non-fatal):`, err);
                        sentimentPngs[spec.key] = null;
                    }
                })
            );

            let chartPipelineMs = 0;
            let llmCallsMs = 0;
            const parallelPhaseStart = Date.now();
            const [chartOut, narratives] = await Promise.all([
                (async () => {
                    const t0 = Date.now();
                    const out = await runChart();
                    chartPipelineMs = Date.now() - t0;
                    logSentimentPerf(
                        "chart_and_price",
                        chartPipelineMs,
                        "CoinGlass+HTML+disk (parallel with LLM)"
                    );
                    return out;
                })(),
                (async () => {
                    const t0 = Date.now();
                    const out = await runLlm(sentimentPngs);
                    llmCallsMs = Date.now() - t0;
                    logSentimentPerf(
                        "llm_calls",
                        llmCallsMs,
                        "MEDIUMx2+LARGE narratives"
                    );
                    return out;
                })(),
            ]);
            const parallelWallMs = Date.now() - parallelPhaseStart;
            logSentimentPerf(
                "parallel_phase_wall",
                parallelWallMs,
                "max(chart,llm)≤wall≤sum"
            );
            chartPath = chartOut.chartPath;
            visualizationMessage = chartOut.visualizationMessage;
            const { xAnalysis, newsAnalysis, xInfluencersAnalysis, redditAnalysis, podcastAnalysis, researchAnalysis, cryptoPolicyAnalysis, youtubeAnalysis, macroNewsAnalysis, comparisonAnalysis, analysisMap } = narratives;

            // Combine all analyses into a single comprehensive response
            let fullAnalysisText = reportHeader;

            // Store individual analyses for frontend access
            const analysisData = {
                header: reportHeader,
                xTwitter: null as any,
                cryptoNews: null as any,
                xInfluencers: null as any,
                reddit: null as any,
                podcast: null as any,
                research: null as any,
                cryptoPolicy: null as any,
                youtube: null as any,
                macroNews: null as any,
                comparison: null as any
            };

            // 5. Build fullAnalysisText and analysisData for all sources in one loop
            for (const s of SOURCES_CONFIG) {
                const analysis = analysisMap[s.key];
                const display = sourceMetricsDisplayMap[s.key];
                if (s.scores.length > 0 && analysis) {
                    const section = `## ${s.emoji} ${s.sectionTitle}\n\n${display}\n\n${analysis}`;
                    fullAnalysisText += section + "\n\n";
                    (analysisData as any)[s.analysisDataKey] = { title: `${s.label} Sentiment Analysis`, metrics: display, analysis, fullText: section };
                }
            }

            // Add comparison analysis if multiple sources available
            if (comparisonAnalysis) {
                const comparisonSection = `## 🔄 CROSS-SOURCE SENTIMENT COMPARISON\n\n${comparisonAnalysis}`;
                fullAnalysisText += comparisonSection + "\n\n";
                analysisData.comparison = {
                    title: "Cross-Source Sentiment Comparison",
                    analysis: comparisonAnalysis,
                    fullText: comparisonSection
                };
            }

            // Add visualization message
            fullAnalysisText += visualizationMessage;

            // Store structured data in the final callback for task chain usage
            // 6. Build per-source scores arrays in one pass
            const scoresForResult = Object.fromEntries(
                SOURCES_CONFIG.map(s => [`${s.key}Scores`, s.scores.map(score => ({
                    time: score.time, value: score.value,
                    positive: score.positive, negative: score.negative,
                    neutral: score.neutral, total: score.total,
                }))])
            );
            const structuredResult = {
                    asset: assetToAnalyze,
                    dateRange: {
                        start: dateRange.startDate,
                        end: dateRange.endDate
                    },
                    sentimentData: {
                        // legacy key aliases so downstream consumers see the same property names
                        newsScores: scoresForResult.cryptoNewsScores,
                        xScores: scoresForResult.xTwitterScores,
                        xInfluencersScores: scoresForResult.xInfluencersScores,
                        redditScores: scoresForResult.redditScores,
                        podcastScores: scoresForResult.podcastScores,
                        researchScores: scoresForResult.researchScores,
                        cryptoPolicyScores: scoresForResult.cryptoPolicyScores,
                        youtubeScores: scoresForResult.youtubeScores,
                        macroNewsScores: scoresForResult.macroNewsScores,
                        combined: {
                            totalDataPoints: allFilteredScores.length,
                            averageSentiment: avgSentiment,
                            positiveDays: posCount,
                            negativeDays: negCount,
                            neutralDays: zeroCount,
                            avgPositive: avgPositive,
                            avgNegative: avgNegative,
                            avgNeutral: avgNeutral,
                            sentimentTrend: sentimentTrend,
                            sentimentChange: sentimentChange,
                            volatility: volatility
                        }
                    },
                    analysis: {
                        requestType: requestType,
                        tweetCount: tweetCount,
                        sourcesUsed: dataSources,
                        hasVisualization: shouldVisualize,
                        chartPath: chartPath
                    }
                };

            // Generate action summary
            // 7. Compute totalDataPoints and sources list via SOURCES_CONFIG
            const totalDataPoints = SOURCES_CONFIG.reduce((sum, s) => sum + (s.scores?.length || 0), 0);
            const dataPeriod = `${dateRange.startDate} to ${dateRange.endDate}`;
            const sources: string[] = [];
            for (const s of SOURCES_CONFIG) {
                if (s.scores.length > 0) sources.push(`${s.scores.length} ${s.countLabel}`);
            }

            const sentimentLevel = avgSentiment > 0.2 ? 'positive' : avgSentiment < -0.2 ? 'negative' : 'neutral';
            const sentimentValue = Math.round(avgSentiment * 100);

            const actionSummary = generateActionSummary({
                actionName: 'Sentiment Analysis',
                assets: [assetToAnalyze],
                timePeriod: dataPeriod,
                dataPoints: totalDataPoints,
                additionalInfo: `${sources.join(', ')}, overall sentiment ${sentimentValue}/100 (${sentimentLevel})`
            });

            if (sentimentPerfEnabled()) {
                fullAnalysisText += `\n\n---\n\n### Pipeline latency (Sentiment_Analysis)\n\n| Step | Duration |\n|------|----------|\n| **1. Data acquisition** (S3: news + X) | ${Math.round(dataAcquisitionMs)} ms |\n| **2. Data processing** (filters, stats, templates) | ${Math.round(dataProcessingMs)} ms |\n| **3. Chart branch** (parallel) | ${Math.round(chartPipelineMs)} ms |\n| **4. LLM calls** (parallel) | ${Math.round(llmCallsMs)} ms |\n| **5. Parallel wall** | ${Math.round(parallelWallMs)} ms |\n\n*See server log* \`[Sentiment_Analysis][perf] step=final_response\` *for build+callback time.*\n`;
            }

            const tFinalStart = Date.now();
            // Send final comprehensive response with all analyses and structured data
            await callback(createActionResponse({
                actionName: "Sentiment_Analysis",
                type: "sentiment_analysis",
                text: fullAnalysisText,
                actionData: {
                    ...structuredResult,
                    summary: actionSummary,
                },
                chartPath: chartPath,
                additionalMetadata: {
                    // Store individual analyses for frontend access
                    analysisBreakdown: analysisData,
                    ...(dataRetentionApplied && { dataRetentionApplied: true }),
                },
            }));

            logSentimentPerf("final_response", Date.now() - tFinalStart);

            return true;
            
        } catch (error) {
            console.error(`Error in CryptoSentimentAnalysisAndVisualization:`, error);
            
            await callback(createActionErrorResponse({
                actionName: "Sentiment_Analysis",
                type: "sentiment_analysis_error",
                error: error instanceof Error ? error : new Error(String(error)),
                text: `Sorry, I encountered an error while analyzing ${assetToAnalyze}. Please try again later. Error details: ${error}`,
            }));
            return false;
        }
    },
    examples: [
        [
            {
                user: "user1",
                content: {
                    text: "What's the sentiment analysis for Bitcoin over the last week?",
                    action: "cryptoSentimentAnalysisAndVisualization"
                }
            }
        ],
        [
            {
                user: "user2",
                content: {
                    text: "Can you provide the sentiment analysis for Ethereum this month?",
                    action: "cryptoSentimentAnalysisAndVisualization"
                }
            }
        ],
        [
            {
                user: "user3",
                content: {
                    text: "Give me the SentiScore analysis for BTC from 2023-01-01 to 2023-01-15",
                    action: "cryptoSentimentAnalysisAndVisualization"
                }
            }
        ],
        [
            {
                user: "user4",
                content: {
                    text: "What's the X sentiment analysis for Bitcoin this week?",
                    action: "cryptoSentimentAnalysisAndVisualization"
                }
            }
        ],
        [
            {
                user: "user5",
                content: {
                    text: "Show me the Twitter sentiment for ETH over the last month",
                    action: "cryptoSentimentAnalysisAndVisualization"
                }
            }
        ],
        [
            {
                user: "user6",
                content: {
                    text: "Analyze the sentiment from the latest 30 tweets about Bitcoin on X",
                    action: "cryptoSentimentAnalysisAndVisualization"
                }
            }
        ],
        [
            {
                user: "user7",
                content: {
                    text: "What's the sentiment for the last 100 tweets about ETH on Twitter?",
                    action: "cryptoSentimentAnalysisAndVisualization"
                }
            }
        ],
        [
            {
                user: "user8",
                content: {
                    text: "Can you plot a chart with Bitcoin price and sentiment data?",
                    action: "cryptoSentimentAnalysisAndVisualization"
                }
            }
        ],
        [
            {
                user: "user9",
                content: {
                    text: "Show me a visualization of Ethereum price and sentiment data for the last month",
                    action: "cryptoSentimentAnalysisAndVisualization"
                }
            }
        ],
        [
            {
                user: "user10",
                content: {
                    text: "Generate a chart showing BTC price with sentiment overlay",
                    action: "cryptoSentimentAnalysisAndVisualization"
                }
            }
        ],
        [
            {
                user: "user11",
                content: {
                    text: "Create a crypto sentiment chart for Solana this week",
                    action: "cryptoSentimentAnalysisAndVisualization"
                }
            }
        ],
        [
            {
                user: "user12",
                content: {
                    text: "What is the sentiment score for Bitcoin?",
                    action: "cryptoSentimentAnalysisAndVisualization"
                }
            }
        ],
        [
            {
                user: "user13",
                content: {
                    text: "Give me the current sentiscore for ETH",
                    action: "cryptoSentimentAnalysisAndVisualization"
                }
            }
        ],
        [
            {
                user: "user14",
                content: {
                    text: "Show me the sentiment score for Solana, just the score",
                    action: "cryptoSentimentAnalysisAndVisualization"
                }
            }
        ],
        [
            {
                user: "user15",
                content: {
                    text: "What's the latest sentiment score for BTC on X?",
                    action: "cryptoSentimentAnalysisAndVisualization"
                }
            }
        ],
        [
            {
                user: "user16",
                content: {
                    text: "Give me both news and Twitter sentiment for Bitcoin",
                    action: "cryptoSentimentAnalysisAndVisualization"
                }
            }
        ],
        [
            {
                user: "user17",
                content: {
                    text: "Show me comprehensive sentiment analysis for Ethereum",
                    action: "cryptoSentimentAnalysisAndVisualization"
                }
            }
        ],
        [
            {
                user: "user18",
                content: {
                    text: "What's the multi-source sentiment for Solana this week?",
                    action: "cryptoSentimentAnalysisAndVisualization"
                }
            }
        ],
        [
            {
                user: "user19",
                content: {
                    text: "Compare news sentiment vs X sentiment for BTC",
                    action: "cryptoSentimentAnalysisAndVisualization"
                }
            }
        ],
        [
            {
                user: "user20",
                content: {
                    text: "Create a chart with both news and Twitter sentiment for Bitcoin",
                    action: "cryptoSentimentAnalysisAndVisualization"
                }
            }
        ],
        [
            {
                user: "user21",
                content: {
                    text: "What's the news sentiment for Ethereum only?",
                    action: "cryptoSentimentAnalysisAndVisualization"
                }
            }
        ],
        [
            {
                user: "user22",
                content: {
                    text: "Show me the sentiment scores from all sources for BTC",
                    action: "cryptoSentimentAnalysisAndVisualization"
                }
            }
        ],
    ] as ActionExample[][],
} as Action;
