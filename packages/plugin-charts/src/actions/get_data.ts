import axios from "axios";
import * as fs from "fs";
import * as path from "path";

// Default to BTC-USD if no specific cryptocurrency is requested
const defaultSymbol = "BTC-USD";
const defaultExchange = "Binance";
const defaultInterval = "1d";
const maxLimit = 1000;
const defaultStartDate = new Date("2025-01-01T00:00:00Z");

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

/**
 * Gets a consistent data directory path regardless of where the agent is run from
 */
function getDataDirectory(): string {
    // Always use saved_data directory in the current working directory
    // This ensures consistency with other chart plugins
    return path.join(process.cwd(), "saved_data");
}

/**
 * Gets the current date in YYYY-MM-DD format
 */
function getLatestDate(): string {
    const currentDate = new Date();
    return currentDate.toISOString().split("T")[0]; // Format as YYYY-MM-DD
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

function intervalToMs(interval: string): number {
    switch (interval) {
        case "1m":
            return 60_000;
        case "3m":
            return 3 * 60_000;
        case "5m":
            return 5 * 60_000;
        case "15m":
            return 15 * 60_000;
        case "30m":
            return 30 * 60_000;
        case "1h":
            return 60 * 60_000;
        case "4h":
            return 4 * 60 * 60_000;
        case "6h":
            return 6 * 60 * 60_000;
        case "8h":
            return 8 * 60 * 60_000;
        case "12h":
            return 12 * 60 * 60_000;
        case "1d":
            return 24 * 60 * 60_000;
        case "1w":
            return 7 * 24 * 60 * 60_000;
        default:
            throw new Error(`Unsupported interval: ${interval}`);
    }
}

/**
 * Deletes data files with older dates for the given cryptocurrency
 * Keeps only the most recent data file for each cryptocurrency
 */
function deleteOlderDataFiles(cryptoCode: string, cryptoDataDir: string): void {
    try {
        if (!fs.existsSync(cryptoDataDir)) {
            return; // No directory, no files to delete
        }

        const files = fs.readdirSync(cryptoDataDir);
        const dataFilePattern = new RegExp(`^${cryptoCode}_data_(\\d{4}-\\d{2}-\\d{2})\\.csv$`);
        
        // Find all matching files with their dates
        const matchingFiles = files
            .map(file => {
                const match = file.match(dataFilePattern);
                if (match) {
                    return {
                        filename: file,
                        date: match[1],
                    };
                }
                return null;
            })
            .filter(file => file !== null)
            .sort((a, b) => b.date.localeCompare(a.date)); // Sort by date descending
        
        // Keep the most recent file, delete all others
        if (matchingFiles.length > 1) {
            // Skip the first item (most recent) and delete the rest
            matchingFiles.slice(1).forEach(file => {
                const filePath = path.join(cryptoDataDir, file.filename);
                try {
                    fs.unlinkSync(filePath);
                    console.log(`Deleted older data file: ${filePath}`);
                } catch (deleteError) {
                    console.warn(`Could not delete file ${filePath}:`, deleteError.message);
                }
            });
        }
    } catch (error) {
        console.error("Error deleting older data files:", error);
    }
}

/**
 * Downloads cryptocurrency data from CoinGlass with improved error handling
 */
async function downloadCryptoData(symbol: string = defaultSymbol, signal?: AbortSignal): Promise<string> {
    const now = getLatestDate();
    
    try {
        // Use the improved directory resolution
        const savedDataDir = getDataDirectory();
        const cryptoDataDir = path.join(savedDataDir, "Crypto_Data");
        
        // Create directories with proper error handling
        try {
            if (!fs.existsSync(savedDataDir)) {
                fs.mkdirSync(savedDataDir, { recursive: true });
                console.log(`Created directory: ${savedDataDir}`);
            }
            
            if (!fs.existsSync(cryptoDataDir)) {
                fs.mkdirSync(cryptoDataDir, { recursive: true });
                console.log(`Created directory: ${cryptoDataDir}`);
            }
        } catch (dirError) {
            console.error(`Error creating directories: ${dirError.message}`);
            throw new Error(`Failed to create data directories: ${dirError.message}`);
        }

        // Delete older data files for this cryptocurrency
        const cryptoCode = symbol.split("-")[0].toLowerCase();
        deleteOlderDataFiles(cryptoCode, cryptoDataDir);
        
        const apiKey = process.env.COINGLASS_API_KEY;
        if (!apiKey) {
            throw new Error("COINGLASS_API_KEY environment variable is required");
        }

        const coinglassSymbol = toCoinglassSymbol(symbol);
        const startTime = defaultStartDate.getTime();
        const endTime = Date.now();
        const interval = defaultInterval;
        const intervalMs = intervalToMs(interval);

        console.log(`Downloading ${coinglassSymbol} data from CoinGlass...`);

        const allPoints: CoinglassPricePoint[] = [];
        let windowStart = startTime;

        while (windowStart <= endTime) {
            const windowEnd = Math.min(endTime, windowStart + intervalMs * (maxLimit - 1));
            const params = new URLSearchParams({
                exchange: defaultExchange,
                symbol: coinglassSymbol,
                interval,
                limit: maxLimit.toString(),
                start_time: windowStart.toString(),
                end_time: windowEnd.toString()
            });
            const url = `https://open-api-v4.coinglass.com/api/futures/price/history?${params.toString()}`;

            let responseData: CoinglassPriceHistoryResponse;
            try {
                const response = await axios.get(url, {
                    headers: {
                        accept: "application/json",
                        "CG-API-KEY": apiKey
                    },
                    signal,
                });
                responseData = response.data;
            } catch (apiError) {
                if (apiError?.response?.status === 429) {
                    console.warn(`Rate limited for ${coinglassSymbol}, waiting 2 seconds and retrying...`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    const retryResponse = await axios.get(url, {
                        headers: {
                            accept: "application/json",
                            "CG-API-KEY": apiKey
                        },
                        signal,
                    });
                    responseData = retryResponse.data;
                } else {
                    throw apiError;
                }
            }

            if (!responseData || responseData.code !== "0") {
                throw new Error(`CoinGlass API Error: ${responseData?.msg || "Unknown error"}`);
            }

            if (!responseData.data || responseData.data.length === 0) {
                break;
            }

            allPoints.push(...responseData.data);
            windowStart = windowEnd + intervalMs;
        }

        if (allPoints.length === 0) {
            throw new Error(`No data received from CoinGlass for ${symbol}`);
        }

        const uniquePoints = new Map<number, CoinglassPricePoint>();
        allPoints.forEach(point => {
            if (Number.isFinite(point.time)) {
                uniquePoints.set(point.time, point);
            }
        });

        const sortedPoints = Array.from(uniquePoints.values()).sort((a, b) => a.time - b.time);

        const result = sortedPoints.map(point => {
            const open = Number(point.open);
            const high = Number(point.high);
            const low = Number(point.low);
            const close = Number(point.close);
            const volume = Number(point.volume_usd);

            return {
                date: new Date(point.time),
                open,
                high,
                low,
                close,
                adjClose: Number.isFinite(close) ? close : 0,
                volume: Number.isFinite(volume) ? volume : 0
            };
        });
        
        // Generate filename from symbol and current date (e.g., btc_data_2023-04-28.csv)
        const filename = `${cryptoCode}_data_${now}.csv`;
        const filepath = path.join(cryptoDataDir, filename);
        
        // Convert to CSV format
        const headers = ["date", "open", "high", "low", "close", "adjClose", "volume"];
        const csvData = [
            headers.join(","),
            ...result.map(row => {
                return [
                    row.date.toISOString().split("T")[0],
                    row.open,
                    row.high,
                    row.low,
                    row.close,
                    row.adjClose,
                    row.volume
                ].join(",");
            })
        ].join("\n");
        
        // Save to CSV with error handling
        try {
            fs.writeFileSync(filepath, csvData);
            console.log(`Data for ${symbol} saved to ${filepath}`);
        } catch (writeError) {
            console.error(`Error writing file ${filepath}:`, writeError.message);
            throw new Error(`Failed to save data file: ${writeError.message}`);
        }
        
        return filepath;
        
    } catch (error) {
        console.error(`Error downloading crypto data for ${symbol}:`, error.message);
        throw new Error(`Failed to download crypto data: ${error.message}. This could be due to network issues, rate limiting, or file permission problems.`);
    }
}

/**
 * Main function to handle cryptocurrency data retrieval
 * This function extracts cryptocurrency from the message, downloads data,
 * and returns the filepath of the saved data
 * 
 * @param message User message to extract cryptocurrency from
 * @returns Promise with the filepath of the saved data
 */

export { downloadCryptoData, getDataDirectory };
