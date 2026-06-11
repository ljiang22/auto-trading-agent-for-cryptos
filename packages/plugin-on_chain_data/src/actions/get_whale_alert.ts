import {
    type Action,
    type ActionExample,
    type IAgentRuntime,
    type Memory,
    type State,
    type HandlerCallback,
    formatMessages,
    elizaLogger,
    createActionResponse,
    createActionErrorResponse,
    generateActionSummary,
    formatLargeNumber as formatLargeNumberUtil,
} from "@elizaos/core";
import fs from 'fs';
import path from 'path';
import { getCryptoInfo, categorizeTransactionsByType, cryptoCategories } from '../utils/crypto-categories';
import { httpClient, formatAxiosErrorLine } from "@elizaos/core";

// Types for whale alert data
export interface WhaleTransaction {
    user: string;               // Wallet address
    symbol: string;             // Token symbol (ETH, BTC, etc.)
    position_size: number;      // Position size (positive: long, negative: short)
    entry_price: number;        // Entry price
    mark_price: number;         // Current mark price
    liq_price: number;          // Liquidation price
    leverage: number;           // Leverage multiplier
    margin_balance: number;     // Margin balance in USD
    position_value_usd: number; // Position value in USD
    unrealized_pnl: number;     // Unrealized PnL in USD
    funding_fee: number;        // Funding fee in USD
    margin_mode: string;        // Margin mode (cross/isolated)
    create_time: number;        // Entry timestamp in milliseconds
    update_time: number;        // Last updated timestamp in milliseconds
}

export interface WhaleAlertResponse {
    code: string;
    msg: string;
    data: WhaleTransaction[];
}

export interface WhaleAlertData {
    transactions: WhaleTransaction[];
    summary: {
        totalTransactions: number;
        totalValueUSD: number;
        topSymbols: string[];
        longShortRatio: number;
        averagePositionSize: number;
        allTransactionsCount: number;
        allTransactionsValue: number;
        top10Percentage: number;
        timeRangeDays: number;
        recentTransactionsCount: number;
        requestedCryptos?: string[];
    };
    categoryBreakdown: Record<string, {
        transactions: WhaleTransaction[];
        totalValue: number;
        count: number;
    }>;
}

export interface WhaleDataResponse {
    success: boolean;
    data?: WhaleAlertData;
    error?: string;
    /** True when date range was clamped due to subscription data retention */
    dataRetentionApplied?: boolean;
}

// Utility function to format large numbers
function formatLargeNumber(num: number): string {
    if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
    return num.toFixed(2);
}

// Utility function to format timestamp
function formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toLocaleString();
}

// Function to save whale data to file
async function saveWhaleDataToFile(whaleData: WhaleAlertData): Promise<void> {
    try {
        const CACHE_DIR = path.join(process.cwd(), 'cache');
        const saveDirectory = path.join(CACHE_DIR, 'whale_data');
        
        // Create cache and whale_data directories if they don't exist
        if (!fs.existsSync(CACHE_DIR)) {
            fs.mkdirSync(CACHE_DIR, { recursive: true });
            elizaLogger.info(`📁 Created directory: ${CACHE_DIR}`);
        }
        
        if (!fs.existsSync(saveDirectory)) {
            fs.mkdirSync(saveDirectory, { recursive: true });
            elizaLogger.info(`📁 Created directory: ${saveDirectory}`);
        }
        
        // Generate filename with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `whale_alert_${timestamp}.json`;
        const filepath = path.join(saveDirectory, filename);
        
        // Prepare data to save
        const dataToSave = {
            timestamp: new Date().toISOString(),
            fetchTime: Date.now(),
            data: whaleData
        };
        
        // Write data to file
        fs.writeFileSync(filepath, JSON.stringify(dataToSave, null, 2));
        
        elizaLogger.info(`💾 Whale data saved to: ${filepath}`);
        elizaLogger.info(`📊 Saved ${whaleData.transactions.length} transactions totaling $${formatLargeNumber(whaleData.summary.totalValueUSD)}`);
        
    } catch (error) {
        elizaLogger.error("❌ Error saving whale data to file:", error);
        throw error;
    }
}

// Utility function to format date as YYYY-MM-DD
function formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
}

// Function to get date range from user query (adapted from sentiscore plugin)
function getDateRangeFromRequest(request: string): { startDate: string, endDate: string } {
    // Default to current date for endDate
    const today = new Date();
    const endDate = today;
    const startDate = new Date();
    
    // Convert to lowercase for easier matching
    let text = request.toLowerCase();
    
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
        const timePeriodReplacementRegex = new RegExp(`\\b${word}\\b(?=\\s+(?:day|days|week|weeks|month|months|year|years))`, 'gi');
        text = text.replace(timePeriodReplacementRegex, digit);
    }
    
    // Handle compound numbers like "twenty-five" -> "25" in time period contexts
    text = text.replace(/\b(20|30|40|50|60|70|80|90)[-\s]+(1|2|3|4|5|6|7|8|9)(?=\s+(?:day|days|week|weeks|month|months|year|years))\b/g, (match, tens, ones) => {
        return (Number.parseInt(tens) + Number.parseInt(ones)).toString();
    });
    
    // Check for common time period patterns
    if (text.includes("last") || text.includes("past")) {
        // Extract numbers and time units
        const match = text.match(/(?:last|past)\s+(\d+)\s+(day|days|week|weeks|month|months|year|years)/i);
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
            // Default to last 7 days if no specific period mentioned
            startDate.setDate(today.getDate() - 7);
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
    } else if (text.includes("today") || text.includes("24 hour")) {
        // Set to start of today
        startDate.setHours(0, 0, 0, 0);
    } else if (text.includes("yesterday")) {
        // Set to yesterday
        startDate.setDate(today.getDate() - 1);
        endDate.setDate(today.getDate() - 1);
    } else {
        // Default to last 7 days
        startDate.setDate(today.getDate() - 7);
    }
    
    return {
        startDate: formatDate(startDate),
        endDate: formatDate(endDate)
    };
}

// Function to extract crypto symbols from user query using crypto categories
function extractCryptoSymbolsFromRequest(request: string): string[] {
    const text = request.toLowerCase();
    const detectedSymbols: string[] = [];
    
    // Create a comprehensive mapping from crypto categories
    const cryptoMappings: Record<string, string> = {};
    
    // Build mappings from the crypto categories
    Object.values(cryptoCategories).forEach(crypto => {
        // Add symbol mappings (both cases)
        cryptoMappings[crypto.symbol.toLowerCase()] = crypto.symbol;
        
        // Add name mappings (handle multi-word names)
        const nameLower = crypto.name.toLowerCase();
        cryptoMappings[nameLower] = crypto.symbol;
        
        // Handle special cases and common abbreviations
        if (crypto.symbol === 'BTC') {
            cryptoMappings['bitcoin'] = crypto.symbol;
        } else if (crypto.symbol === 'ETH') {
            cryptoMappings['ethereum'] = crypto.symbol;
        } else if (crypto.symbol === 'XRP') {
            cryptoMappings['ripple'] = crypto.symbol;
        } else if (crypto.symbol === 'ADA') {
            cryptoMappings['cardano'] = crypto.symbol;
        } else if (crypto.symbol === 'SOL') {
            cryptoMappings['solana'] = crypto.symbol;
        } else if (crypto.symbol === 'MATIC') {
            cryptoMappings['polygon'] = crypto.symbol;
        } else if (crypto.symbol === 'AVAX') {
            cryptoMappings['avalanche'] = crypto.symbol;
        } else if (crypto.symbol === 'DOT') {
            cryptoMappings['polkadot'] = crypto.symbol;
        } else if (crypto.symbol === 'ATOM') {
            cryptoMappings['cosmos'] = crypto.symbol;
        } else if (crypto.symbol === 'LINK') {
            cryptoMappings['chainlink'] = crypto.symbol;
        } else if (crypto.symbol === 'UNI') {
            cryptoMappings['uniswap'] = crypto.symbol;
        } else if (crypto.symbol === 'DOGE') {
            cryptoMappings['dogecoin'] = crypto.symbol;
        } else if (crypto.symbol === 'SHIB') {
            cryptoMappings['shiba'] = crypto.symbol;
            cryptoMappings['shiba inu'] = crypto.symbol;
        } else if (crypto.symbol === 'LTC') {
            cryptoMappings['litecoin'] = crypto.symbol;
        } else if (crypto.symbol === 'BCH') {
            cryptoMappings['bitcoin cash'] = crypto.symbol;
        } else if (crypto.symbol === 'BNB') {
            cryptoMappings['binance coin'] = crypto.symbol;
            cryptoMappings['binance'] = crypto.symbol;
        } else if (crypto.symbol === 'TRX') {
            cryptoMappings['tron'] = crypto.symbol;
        } else if (crypto.symbol === 'APT') {
            cryptoMappings['aptos'] = crypto.symbol;
        } else if (crypto.symbol === 'SUI') {
            cryptoMappings['sui'] = crypto.symbol;
        } else if (crypto.symbol === 'ARB') {
            cryptoMappings['arbitrum'] = crypto.symbol;
        } else if (crypto.symbol === 'OP') {
            cryptoMappings['optimism'] = crypto.symbol;
        }
    });
    
    // Check for exact matches in the mapping
    for (const [key, symbol] of Object.entries(cryptoMappings)) {
        // Use word boundaries to avoid partial matches
        const regex = new RegExp(`\\b${key}\\b`, 'i');
        if (regex.test(text)) {
            if (!detectedSymbols.includes(symbol)) {
                detectedSymbols.push(symbol);
            }
        }
    }
    
    // Also look for uppercase crypto symbols directly (e.g., "BTC", "ETH")
    const upperCaseSymbols = text.match(/\b[A-Z]{2,6}\b/g);
    if (upperCaseSymbols) {
        for (const symbol of upperCaseSymbols) {
            if (cryptoCategories[symbol] && !detectedSymbols.includes(symbol)) {
                detectedSymbols.push(symbol);
            }
        }
    }
    
    return detectedSymbols;
}

// Function to convert date range to days for backward compatibility
function calculateDaysFromDateRange(startDate: string, endDate: string): number {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const diffTime = Math.abs(end.getTime() - start.getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return Math.max(1, diffDays); // At least 1 day
}

/** Clamp date range (YYYY-MM-DD) to retention config. Returns same shape for use with cutoffTime. */
function clampDateRangeToRetention(
    startDate: string,
    endDate: string,
    config: { dataRetentionDays?: number; dataRetentionMinDaysAgo?: number; dataRetentionMaxDaysAgo?: number }
): { startDate: string; endDate: string } {
    const maxDays = config.dataRetentionDays;
    const minDaysAgo = config.dataRetentionMinDaysAgo;
    const maxDaysAgo = config.dataRetentionMaxDaysAgo;
    if (typeof maxDays === "number" && maxDays === 0) {
        return { startDate, endDate };
    }
    const today = new Date();
    const todayStr = formatDate(today);
    if (
        typeof minDaysAgo === "number" &&
        typeof maxDaysAgo === "number" &&
        maxDaysAgo > minDaysAgo
    ) {
        const end = new Date(today);
        end.setUTCDate(end.getUTCDate() - minDaysAgo);
        const start = new Date(today);
        start.setUTCDate(start.getUTCDate() - maxDaysAgo);
        return { startDate: formatDate(start), endDate: formatDate(end) };
    }
    if (typeof maxDays !== "number" || maxDays < 1) {
        return { startDate, endDate };
    }
    const end = new Date(endDate + "T23:59:59Z");
    const start = new Date(end.getTime());
    start.setUTCDate(start.getUTCDate() - (maxDays - 1));
    const totalDays = calculateDaysFromDateRange(startDate, endDate);
    if (totalDays <= maxDays) {
        return { startDate, endDate };
    }
    return { startDate: formatDate(start), endDate: endDate };
}

// Main function to get whale alert data
export async function getWhaleAlertData(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { from?: string; to?: string; dataRetentionDays?: number; dataRetentionMinDaysAgo?: number; dataRetentionMaxDaysAgo?: number }
): Promise<WhaleDataResponse> {
    try {
        elizaLogger.info("🐋 Fetching whale alert data...");

        // Check if API key is available
        const apiKey = process.env.COINGLASS_API_KEY;
        if (!apiKey) {
            throw new Error("COINGLASS_API_KEY environment variable is required");
        }

        elizaLogger.info("🔑 API key found, making request to CoinGlass API...");

        // Use global HTTP client with keep-alive Agent
        const response = await httpClient.get('https://open-api-v4.coinglass.com/api/hyperliquid/whale-position', {
            headers: {
                'accept': 'application/json',
                'CG-API-KEY': apiKey
            }
        });
        
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`HTTP error! status: ${response.status} - ${response.statusText}`);
        }

        const whaleResponse: WhaleAlertResponse = response.data;
        
        //elizaLogger.info(`📊 API Response - Code: ${whaleResponse.code}, Message: ${whaleResponse.msg}`);
        //elizaLogger.info(`📊 Raw API Response:`, JSON.stringify(whaleResponse, null, 2));

        // Only check code "0" for success, as msg might be undefined
        if (whaleResponse.code !== "0") {
            throw new Error(`API Error: ${whaleResponse.msg || 'Unknown error'} (Code: ${whaleResponse.code})`);
        }

        // Parse date range from options (from/to) or user query (default: last 7 days)
        let originalRange: { startDate: string; endDate: string };
        if (options?.from && options?.to && typeof options.from === "string" && typeof options.to === "string") {
            // Use date part (YYYY-MM-DD) for API; from/to may include hour (YYYY-MM-DDTHH:mm)
            const fromPart = options.from.trim().slice(0, 10);
            const toPart = options.to.trim().slice(0, 10);
            originalRange = { startDate: fromPart, endDate: toPart };
        } else {
            originalRange = getDateRangeFromRequest(message.content.text || "");
        }
        let dateRange = originalRange;
        let dataRetentionApplied = false;
        if (
            options &&
            ((typeof options.dataRetentionDays === "number" && options.dataRetentionDays >= 0) ||
                (typeof options.dataRetentionMinDaysAgo === "number" && typeof options.dataRetentionMaxDaysAgo === "number"))
        ) {
            const clamped = clampDateRangeToRetention(dateRange.startDate, dateRange.endDate, options);
            dataRetentionApplied =
                clamped.startDate !== originalRange.startDate || clamped.endDate !== originalRange.endDate;
            dateRange = clamped;
        }
        const daysToAnalyze = calculateDaysFromDateRange(dateRange.startDate, dateRange.endDate);
        const cutoffTime = new Date(dateRange.startDate).getTime();
        
        // Extract specific crypto symbols from user query
        const requestedCryptos = extractCryptoSymbolsFromRequest(message.content.text || "");
        const cryptoFilterText = requestedCryptos.length > 0 ? ` for ${requestedCryptos.join(', ')}` : '';
        
        elizaLogger.info(`🕒 Analyzing whale movements from ${dateRange.startDate} to ${dateRange.endDate} (${daysToAnalyze} days)${cryptoFilterText}`);

        // Process and analyze the whale data
        const allTransactions = whaleResponse.data || [];
        
        elizaLogger.info(`🐋 Retrieved ${allTransactions.length} total whale transactions`);
        
        // Filter transactions by time range (based on create_time or update_time)
        let recentTransactions = allTransactions.filter(tx => {
            // Use the more recent of create_time or update_time
            const relevantTime = Math.max(tx.create_time || 0, tx.update_time || 0);
            return relevantTime >= cutoffTime;
        });
        
        elizaLogger.info(`📅 Found ${recentTransactions.length} transactions in the last ${daysToAnalyze} days`);
        
        // Filter by specific crypto symbols if requested
        if (requestedCryptos.length > 0) {
            recentTransactions = recentTransactions.filter(tx => 
                requestedCryptos.includes(tx.symbol.toUpperCase())
            );
            elizaLogger.info(`🎯 Filtered to ${recentTransactions.length} transactions for ${requestedCryptos.join(', ')}`);
        }
        
        // Check if we have any transactions after filtering
        if (recentTransactions.length === 0) {
            let noDataMessage = `No whale transactions found for the specified criteria.`;
            if (requestedCryptos.length > 0) {
                noDataMessage = `No whale transactions found for ${requestedCryptos.join(', ')} in the last ${daysToAnalyze} day(s).`;
            } else {
                noDataMessage = `No whale transactions found in the last ${daysToAnalyze} day(s).`;
            }
            
            return {
                success: false,
                error: noDataMessage
            };
        }
        
        // Focus on top 10 largest movements by position value from recent transactions
        const top10Transactions = recentTransactions
            .sort((a, b) => b.position_value_usd - a.position_value_usd)
            .slice(0, 10);
        
        elizaLogger.info(`🎯 Focusing on top ${top10Transactions.length} largest whale movements`);
        
        // Use top 10 for primary analysis
        const transactions = top10Transactions;
        
        // Calculate summary statistics based on top 10
        const totalTransactions = transactions.length;
        const totalValueUSD = transactions.reduce((sum, tx) => sum + tx.position_value_usd, 0);
        const allTransactionsValue = allTransactions.reduce((sum, tx) => sum + tx.position_value_usd, 0);
        
        // Get unique symbols and their counts from top 10
        const symbolCounts = transactions.reduce((acc, tx) => {
            acc[tx.symbol] = (acc[tx.symbol] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);
        
        const topSymbols = Object.entries(symbolCounts)
            .sort(([,a], [,b]) => b - a)
            .slice(0, 5)
            .map(([symbol]) => symbol);

        // Calculate long/short ratio from top 10
        const longPositions = transactions.filter(tx => tx.position_size > 0).length;
        const shortPositions = transactions.filter(tx => tx.position_size < 0).length;
        const longShortRatio = shortPositions > 0 ? longPositions / shortPositions : longPositions;

        // Calculate average position size from top 10
        const averagePositionSize = totalTransactions > 0 ? totalValueUSD / totalTransactions : 0;

        // Calculate top 10 percentage of total value
        const top10Percentage = allTransactionsValue > 0 ? (totalValueUSD / allTransactionsValue) * 100 : 0;

        // Categorize transactions by crypto types
        const categoryBreakdown = categorizeTransactionsByType(transactions);

        const whaleData: WhaleAlertData = {
            transactions,
            summary: {
                totalTransactions,
                totalValueUSD,
                topSymbols,
                longShortRatio,
                averagePositionSize,
                allTransactionsCount: allTransactions.length,
                allTransactionsValue,
                top10Percentage,
                timeRangeDays: daysToAnalyze,
                recentTransactionsCount: recentTransactions.length,
                requestedCryptos: requestedCryptos.length > 0 ? requestedCryptos : undefined
            },
            categoryBreakdown
        };

        elizaLogger.info(`✅ Successfully processed top ${totalTransactions} largest whale movements from last ${daysToAnalyze} days`);
        elizaLogger.info(`💰 Top 10 value: $${formatLargeNumber(totalValueUSD)} (${top10Percentage.toFixed(1)}% of recent activity)`);

        return {
            success: true,
            data: whaleData,
            dataRetentionApplied,
        };

    } catch (error) {
        elizaLogger.error(
            `❌ Error fetching whale alert data: ${formatAxiosErrorLine(error)}`
        );

        // Stack only — formatAxiosErrorLine already pulls the request/response fields.
        if (error instanceof Error) {
            if (error.stack) {
                elizaLogger.error(`❌ Stack trace: ${error.stack}`);
            }
        }
        
        return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error occurred"
        };
    }
}

// Format whale data for AI analysis
export function formatWhaleDataForAnalysis(whaleData: WhaleAlertData, requestedCryptos?: string[]): string {
    const { transactions, summary, categoryBreakdown } = whaleData;
    
    const timeRangeText = summary.timeRangeDays === 1 ? "24 Hours" : `${summary.timeRangeDays} Days`;
    const cryptoSpecificText = requestedCryptos && requestedCryptos.length > 0 ? ` - ${requestedCryptos.join(', ')} Focus` : '';
    
    let output = `## 🐋 Whale Alert Analysis - Top 10 Largest Movements (Last ${timeRangeText})${cryptoSpecificText}\n\n`;
    
    // Summary section
    output += `### 📊 Top 10 Movement Statistics (Last ${timeRangeText}):\n`;
    output += `- **Time Range**: Last ${timeRangeText}\n`;
    if (requestedCryptos && requestedCryptos.length > 0) {
        output += `- **Focus**: ${requestedCryptos.join(', ')} specific analysis\n`;
    }
    output += `- **Recent Activity**: ${summary.recentTransactionsCount} whale transactions detected\n`;
    output += `- **Largest Movements**: ${summary.totalTransactions} positions analyzed\n`;
    output += `- **Combined Value**: $${formatLargeNumber(summary.totalValueUSD)}\n`;
    output += `- **Market Impact**: ${summary.top10Percentage.toFixed(1)}% of recent whale activity\n`;
    output += `- **Average Position Size**: $${formatLargeNumber(summary.averagePositionSize)}\n`;
    output += `- **Long/Short Ratio**: ${summary.longShortRatio.toFixed(2)}\n`;
    output += `- **Primary Symbols**: ${summary.topSymbols.join(', ')}\n\n`;

    // Crypto category breakdown
    output += `### 🏷️ Cryptocurrency Category Breakdown:\n`;
    const sortedCategories = Object.entries(categoryBreakdown)
        .sort(([,a], [,b]) => b.totalValue - a.totalValue);
    
    sortedCategories.forEach(([category, data]) => {
        const percentage = summary.totalValueUSD > 0 ? (data.totalValue / summary.totalValueUSD * 100).toFixed(1) : '0';
        output += `- **${category}**: ${data.count} positions, $${formatLargeNumber(data.totalValue)} (${percentage}%)\n`;
    });
    output += `\n`;

    // Top whale movements (already sorted by value)
    output += `### 🔥 Top 10 Largest Whale Movements:\n`;
    const sortedTransactions = transactions; // Already sorted and limited to top 10

    sortedTransactions.forEach((tx, index) => {
        const action = tx.position_size > 0 ? "🟢 LONG" : "🔴 SHORT";
        const address = `${tx.user.slice(0, 6)}...${tx.user.slice(-4)}`;
        const pnlColor = tx.unrealized_pnl >= 0 ? "🟢" : "🔴";
        const cryptoInfo = getCryptoInfo(tx.symbol);
        
        output += `${index + 1}. **${cryptoInfo.name} (${tx.symbol})** ${action} - ${cryptoInfo.category}\n`;
        output += `   - Address: \`${address}\`\n`;
        output += `   - Asset Tier: ${cryptoInfo.tier}\n`;
        output += `   - Position Size: ${formatLargeNumber(Math.abs(tx.position_size))} ${tx.symbol}\n`;
        output += `   - Value: $${formatLargeNumber(tx.position_value_usd)}\n`;
        output += `   - Entry Price: $${tx.entry_price.toFixed(2)}\n`;
        output += `   - Mark Price: $${tx.mark_price.toFixed(2)}\n`;
        output += `   - Liquidation Price: $${tx.liq_price.toFixed(2)}\n`;
        output += `   - Leverage: ${tx.leverage}x\n`;
        output += `   - Unrealized PnL: ${pnlColor} $${formatLargeNumber(tx.unrealized_pnl)}\n`;
        output += `   - Margin Mode: ${tx.margin_mode}\n`;
        output += `   - Entry Time: ${formatTimestamp(tx.create_time)}\n`;
        output += `   - Last Update: ${formatTimestamp(tx.update_time)}\n\n`;
    });

    // Market sentiment analysis
    const longValue = transactions
        .filter(tx => tx.position_size > 0)
        .reduce((sum, tx) => sum + tx.position_value_usd, 0);
    const shortValue = transactions
        .filter(tx => tx.position_size < 0)
        .reduce((sum, tx) => sum + tx.position_value_usd, 0);
    
    // PnL analysis
    const totalPnL = transactions.reduce((sum, tx) => sum + tx.unrealized_pnl, 0);
    const profitablePositions = transactions.filter(tx => tx.unrealized_pnl > 0).length;
    const losingPositions = transactions.filter(tx => tx.unrealized_pnl < 0).length;
    
    // Leverage analysis
    const averageLeverage = transactions.reduce((sum, tx) => sum + tx.leverage, 0) / transactions.length;
    const highLeveragePositions = transactions.filter(tx => tx.leverage >= 20).length;

    output += `### 📈 Market Sentiment Analysis:\n`;
    output += `- **Long Positions Value**: $${formatLargeNumber(longValue)} (${((longValue / summary.totalValueUSD) * 100).toFixed(1)}%)\n`;
    output += `- **Short Positions Value**: $${formatLargeNumber(shortValue)} (${((shortValue / summary.totalValueUSD) * 100).toFixed(1)}%)\n`;
    
    output += `\n### 💰 Profitability Analysis:\n`;
    output += `- **Total Unrealized PnL**: ${totalPnL >= 0 ? '🟢' : '🔴'} $${formatLargeNumber(totalPnL)}\n`;
    output += `- **Profitable Positions**: ${profitablePositions}/${summary.totalTransactions} (${((profitablePositions / summary.totalTransactions) * 100).toFixed(1)}%)\n`;
    output += `- **Losing Positions**: ${losingPositions}/${summary.totalTransactions} (${((losingPositions / summary.totalTransactions) * 100).toFixed(1)}%)\n`;
    
    output += `\n### ⚡ Risk Analysis:\n`;
    output += `- **Average Leverage**: ${averageLeverage.toFixed(1)}x\n`;
    output += `- **High Leverage (≥20x)**: ${highLeveragePositions}/${summary.totalTransactions} positions\n`;
    
    if (summary.longShortRatio > 1.5) {
        output += `- **Sentiment**: 🟢 **BULLISH** - Whales are heavily long\n`;
    } else if (summary.longShortRatio < 0.67) {
        output += `- **Sentiment**: 🔴 **BEARISH** - Whales are heavily short\n`;
    } else {
        output += `- **Sentiment**: 🟡 **NEUTRAL** - Balanced long/short positions\n`;
    }

    return output;
}

// Whale Alert Action
export const whaleAlertAction: Action = {
    name: "WHALE_ALERT",
    description: "Get real-time whale alert data showing large cryptocurrency transactions and positions from major wallets",
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show me the latest whale alerts",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll fetch the latest whale alert data showing large cryptocurrency transactions and positions.\n\n🐋 **Whale Alert Analysis**\n\n**Summary Statistics:**\n- Total Transactions: 45\n- Total Value: $127.8M\n- Average Position Size: $2.84M\n- Long/Short Ratio: 1.45\n- Top Symbols: BTC, ETH, SOL, MATIC, ADA\n\n**Recent Large Transactions:**\n1. **BTC** 🟢 LONG\n   - Position Size: 156.7 BTC\n   - Value: $6.78M\n   - Entry Price: $43,250\n   - Mark Price: $44,120\n   - Leverage: 10x\n   - Unrealized PnL: 🟢 $136.2K\n\n**Market Sentiment:** 🟢 BULLISH - Whales are accumulating long positions",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "What are the whales doing with Ethereum right now?",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Let me check the latest whale activity for Ethereum specifically.\n\n🐋 **Ethereum Whale Activity**\n\n**ETH Positions:**\n- Large ETH accumulation detected\n- 3 major long positions opened in last 6 hours\n- Combined value: $24.5M ETH\n- Average entry: $2,458\n\n**Analysis:** Institutional whales are showing strong confidence in ETH, with significant long positions being established above key support levels.",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show me XRP whale movements in the last 24 hours",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll fetch the latest XRP whale movement data for the last 24 hours.\n\n🐋 **XRP Whale Alert Analysis - XRP Focus**\n\n**Summary Statistics:**\n- XRP Transactions: 8\n- Total Value: $12.4M\n- Average Position Size: $1.55M\n- Long/Short Ratio: 2.0\n\n**Top XRP Whale Movements:**\n1. **Ripple (XRP)** 🟢 LONG\n   - Position Size: 2.1M XRP\n   - Value: $2.8M\n   - Entry Price: $1.34\n   - Leverage: 5x\n\n**Analysis:** Strong bullish sentiment on XRP with whales accumulating long positions.",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Bitcoin whale activity this week",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Here's the Bitcoin whale activity analysis for this week.\n\n🐋 **Bitcoin Whale Alert Analysis - BTC Focus**\n\n**BTC Summary (7 Days):**\n- Bitcoin Transactions: 12\n- Total Value: $45.2M\n- Average Position Size: $3.77M\n- Long/Short Ratio: 1.5\n\n**Major BTC Movements:**\n- Large accumulation phase detected\n- Institutional buying pressure increasing\n- Average entry around $42,500\n\n**Sentiment:** 🟢 BULLISH - Whales are positioning for upward movement",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show me whale activity for Cardano and Solana",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll fetch whale activity data for Cardano (ADA) and Solana (SOL).\n\n🐋 **Multi-Crypto Whale Analysis - ADA, SOL Focus**\n\n**Summary Statistics:**\n- ADA & SOL Transactions: 15\n- Combined Value: $18.7M\n- Average Position Size: $1.25M\n- Long/Short Ratio: 1.8\n\n**Key Movements:**\n- Cardano showing increased accumulation\n- Solana positions averaging higher leverage\n- Both cryptos seeing bullish whale sentiment\n\n**Analysis:** Strong institutional interest in Layer 1 alternatives with whales positioning for ecosystem growth.",
                },
            },
        ],
    ] as ActionExample[][],
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        try {
            elizaLogger.info("🐋 Processing whale alert request...");

            const optionsForWhale = {
                from: typeof _options?.from === "string" ? _options.from : undefined,
                to: typeof _options?.to === "string" ? _options.to : undefined,
                dataRetentionDays: typeof _options?.dataRetentionDays === "number" ? _options.dataRetentionDays : undefined,
                dataRetentionMinDaysAgo: typeof _options?.dataRetentionMinDaysAgo === "number" ? _options.dataRetentionMinDaysAgo : undefined,
                dataRetentionMaxDaysAgo: typeof _options?.dataRetentionMaxDaysAgo === "number" ? _options.dataRetentionMaxDaysAgo : undefined,
            };
            const whaleDataResponse = await getWhaleAlertData(runtime, message, state, optionsForWhale);

            if (!whaleDataResponse.success || !whaleDataResponse.data) {
                const errorMessage = `❌ Failed to fetch whale alert data: ${whaleDataResponse.error || "Unknown error"}`;
                
                if (callback) {
                    await callback(createActionErrorResponse({
                        actionName: "WHALE_ALERT",
                        type: "whale_alert_analysis_error",
                        error: new Error(whaleDataResponse.error || "Unknown error"),
                        text: errorMessage,
                    }));
                }
                return false;
            }

            // Save whale data to file
            try {
                await saveWhaleDataToFile(whaleDataResponse.data);
            } catch (saveError) {
                elizaLogger.warn("⚠️ Failed to save whale data to file, but continuing with response:", saveError);
            }

            // Format the data for analysis
            const formattedAnalysis = formatWhaleDataForAnalysis(whaleDataResponse.data, whaleDataResponse.data.summary.requestedCryptos);

            // Create response
            const responseText = `${formattedAnalysis}\n\n*Data sourced from CoinGlass whale monitoring system. Large position alerts updated in real-time.*`;

            const actionData = {
                summary: formattedAnalysis,
                summaryStats: whaleDataResponse.data.summary
            };

            // Generate action summary
            const summary = whaleDataResponse.data.summary;
            const actionSummary = generateActionSummary({
                actionName: 'Whale Alert',
                assets: summary.requestedCryptos && summary.requestedCryptos.length > 0
                    ? summary.requestedCryptos
                    : summary.topSymbols.slice(0, 3),
                timePeriod: summary.timeRangeDays === 1 ? '24 hours' : `${summary.timeRangeDays} days`,
                dataPoints: summary.totalTransactions,
                additionalInfo: `$${formatLargeNumberUtil(summary.totalValueUSD, 2)} total value, ${summary.longShortRatio.toFixed(2)} long/short ratio`
            });

            if (callback) {
                await callback(createActionResponse({
                    actionName: "WHALE_ALERT",
                    type: "whale_alert_analysis",
                    text: responseText,
                    content: {
                        whaleData: whaleDataResponse.data,
                        analysis: formattedAnalysis,
                        visualizations: {}
                    },
                    actionData: {
                        ...actionData,
                        summary: actionSummary,
                    },
                    additionalMetadata: {
                        whaleData: whaleDataResponse.data,
                        requestedCryptos: whaleDataResponse.data.summary.requestedCryptos ?? [],
                        ...(whaleDataResponse.dataRetentionApplied && { dataRetentionApplied: true }),
                    },
                }));
            }

            elizaLogger.info("✅ Whale alert analysis completed successfully");
            return true;

        } catch (error) {
            elizaLogger.error("❌ Error in whale alert handler:", error);
            
            const errorMessage = "I encountered an error while fetching whale alert data. Please try again later.";
            
            if (callback) {
                await callback(createActionErrorResponse({
                    actionName: "WHALE_ALERT",
                    type: "whale_alert_analysis_error",
                    error: error instanceof Error ? error : new Error(String(error)),
                    text: errorMessage,
                }));
            }
            
            return false;
        }
    }
,
    cacheConfig: {
        enabled: true,
        ttlSeconds: 86400, // 1 day for whale alert data
        similarityThreshold: 0.7,
        maxChunkSize: 200,
    },
};
