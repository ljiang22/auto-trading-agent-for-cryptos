import axios from "axios";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { createCanvas } from 'canvas';
import type {
    Action,
    IAgentRuntime,
    Memory,
    ActionExample,
    State,
    HandlerCallback
} from "@elizaos/core";
import { createActionResponse, createActionErrorResponse, generateActionSummary } from "@elizaos/core";

import { getFearAndGreedIndex } from "./get_fear_index";

// Helper function to format dates in UTC without showing UTC suffix
function formatDateUTC(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Helper function to format date for display in UTC
function formatDateDisplayUTC(date: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[date.getUTCMonth()];
  const day = date.getUTCDate();
  return `${month} ${day}`;
}

// Helper function to format date with time in UTC
function formatDateTimeUTC(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

// Interface definitions
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

const COINGLASS_API_URL = "https://open-api-v4.coinglass.com/api/futures/price/history";
const COINGLASS_EXCHANGE = "Binance";
const COINGLASS_INTERVAL = "1d";

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
 * Fetches cryptocurrency price data from CoinGlass
 */
async function getCryptoPriceData(symbol = "BTC-USD", days = 30, signal?: AbortSignal): Promise<PriceDataPoint[]> {
    try {
        const apiKey = process.env.COINGLASS_API_KEY;
        if (!apiKey) {
            console.error("COINGLASS_API_KEY is not set");
            return [];
        }

        const endTime = Date.now();
        const startTime = endTime - (days + 5) * 24 * 60 * 60 * 1000;
        const limit = Math.min(1000, days + 5);

        const response = await axios.get(COINGLASS_API_URL, {
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
            },
            signal,
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
 * Helper function to get full cryptocurrency name from code
 */
function getCryptoName(cryptoCode: string): string {
    const cryptoNames: { [key: string]: string } = {
        "BTC": "Bitcoin",
        "ETH": "Ethereum",
        "USDT": "Tether",
        "USDC": "USD Coin",
        "SOL": "Solana",
        "XRP": "XRP",
        "BNB": "BNB",
        "DOGE": "Dogecoin",
        "ADA": "Cardano",
        "TRX": "TRON",
        "AVAX": "Avalanche",
        "SHIB": "Shiba Inu",
        "MATIC": "Polygon",
        "LTC": "Litecoin",
        "UNI": "Uniswap",
        "LINK": "Chainlink",
        "BCH": "Bitcoin Cash",
        "XLM": "Stellar",
        "ATOM": "Cosmos",
        "DOT": "Polkadot"
    };
    
    return cryptoNames[cryptoCode] || cryptoCode;
}

/**
 * Create fear index chart as an image and return the image path
 */
async function generateFearIndexImage(fearData: FearIndexDataPoint[], priceData: PriceDataPoint[], cryptoSymbol = "BTC"): Promise<string> {
    try {
        const width = 2400;
        const height = 1600;
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        
        // Background fill
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        
        // Get crypto name for display
        const cryptoName = getCryptoName(cryptoSymbol);
        
        // Sort fear data chronologically
        const sortedFearData = [...fearData].sort((a, b) => 
            Number.parseInt(a.timestamp) - Number.parseInt(b.timestamp)
        );
        
        // Filter price data to match the date range of fear data
        const formattedFearData = sortedFearData.map(point => {
            const date = new Date(Number.parseInt(point.timestamp) * 1000);
            return {
                date: formatDateUTC(date),
                value: point.value,
                classification: point.value_classification
            };
        });
        
        // Create map for price data lookup
        const priceMap = new Map<string, number>();
        priceData.forEach(point => {
            priceMap.set(point.date, point.price);
        });
        
        // Draw title
        ctx.font = 'bold 48px Arial';
        ctx.fillStyle = '#333333';
        ctx.fillText(`Crypto Fear & Greed Index with ${cryptoName} Price`, 100, 80);
        
        // Draw legend
        const legendItems = [
            { color: '#E74C3C', text: 'Extreme Fear (0-25)' },
            { color: '#F39C12', text: 'Fear (26-45)' },
            { color: '#F1C40F', text: 'Neutral (46-55)' },
            { color: '#2ECC71', text: 'Greed (56-75)' },
            { color: '#27AE60', text: 'Extreme Greed (76-100)' }
        ];
        
        let legendX = 100;
        const legendY = 160;
        
        legendItems.forEach(item => {
            // Draw color box
            ctx.fillStyle = item.color;
            ctx.fillRect(legendX, legendY - 30, 40, 40);
            
            // Draw text
            ctx.fillStyle = '#333333';
            ctx.font = '28px Arial';
            ctx.fillText(item.text, legendX + 50, legendY);
            
            legendX += ctx.measureText(item.text).width + 100;
        });
        
        // Define chart area
        const chartMargin = { top: 200, right: 100, bottom: 160, left: 100 };
        const chartWidth = width - chartMargin.left - chartMargin.right;
        const chartHeight = height - chartMargin.top - chartMargin.bottom;
        
        // Get data for chart
        const dataPoints = sortedFearData.length;
        const barWidth = chartWidth / dataPoints - 2;
        
        // Define scale for fear index (0-100)
        const fearScaleY = (value: number) => {
            return chartHeight - (value / 100 * chartHeight) + chartMargin.top;
        };
        
        // Find min and max price for price scale
        let minPrice = Number.POSITIVE_INFINITY;
        let maxPrice = Number.NEGATIVE_INFINITY;
        
        formattedFearData.forEach(fearPoint => {
            const price = priceMap.get(fearPoint.date);
            if (price !== undefined) {
                minPrice = Math.min(minPrice, price);
                maxPrice = Math.max(maxPrice, price);
            }
        });
        
        // Add 5% padding to price scale
        const pricePadding = (maxPrice - minPrice) * 0.05;
        minPrice = Math.max(0, minPrice - pricePadding);
        maxPrice = maxPrice + pricePadding;
        
        // Define scale for price
        const priceScaleY = (price: number) => {
            return chartHeight - ((price - minPrice) / (maxPrice - minPrice) * chartHeight) + chartMargin.top;
        };
        
        // Function to determine color based on value
        function getColorForValue(value: number): string {
            if (value <= 25) return '#E74C3C'; // Extreme Fear - Red
            if (value <= 45) return '#F39C12'; // Fear - Orange
            if (value <= 55) return '#F1C40F'; // Neutral - Yellow
            if (value <= 75) return '#2ECC71'; // Greed - Light Green
            return '#27AE60'; // Extreme Greed - Dark Green
        }
        
        // Draw Y-axis for fear index
        ctx.beginPath();
        ctx.moveTo(chartMargin.left, chartMargin.top);
        ctx.lineTo(chartMargin.left, chartMargin.top + chartHeight);
        ctx.strokeStyle = '#333333';
        ctx.stroke();
        
        // Draw Y-axis for price
        ctx.beginPath();
        ctx.moveTo(chartMargin.left + chartWidth, chartMargin.top);
        ctx.lineTo(chartMargin.left + chartWidth, chartMargin.top + chartHeight);
        ctx.strokeStyle = '#3498DB';
        ctx.stroke();
        
        // Draw X-axis
        ctx.beginPath();
        ctx.moveTo(chartMargin.left, chartMargin.top + chartHeight);
        ctx.lineTo(chartMargin.left + chartWidth, chartMargin.top + chartHeight);
        ctx.strokeStyle = '#333333';
        ctx.stroke();
        
        // Draw fear index scale labels
        ctx.font = '24px Arial';
        ctx.fillStyle = '#333333';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        
        [0, 25, 50, 75, 100].forEach(value => {
            const y = fearScaleY(value);
            ctx.fillText(value.toString(), chartMargin.left - 20, y);
            
            // Draw horizontal guide line
            ctx.beginPath();
            ctx.moveTo(chartMargin.left, y);
            ctx.lineTo(chartMargin.left + chartWidth, y);
            ctx.strokeStyle = '#dddddd';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        });
        
        // Draw price scale labels
        ctx.fillStyle = '#3498DB';
        ctx.textAlign = 'left';
        
        const priceSteps = 5;
        for (let i = 0; i <= priceSteps; i++) {
            const price = minPrice + (maxPrice - minPrice) * (i / priceSteps);
            const y = priceScaleY(price);
            ctx.fillText(`$${price.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}`, chartMargin.left + chartWidth + 20, y);
        }
        
        // Draw bars for fear index
        formattedFearData.forEach((fearPoint, index) => {
            const x = chartMargin.left + (index * (chartWidth / dataPoints));
            const y = fearScaleY(fearPoint.value);
            const height = chartMargin.top + chartHeight - y;
            
            ctx.fillStyle = getColorForValue(fearPoint.value);
            ctx.fillRect(x, y, barWidth, height);
            
            // Add outline to bars
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.1)';
            ctx.lineWidth = 2;
            ctx.strokeRect(x, y, barWidth, height);
            
            // Draw date labels for every nth point to avoid crowding
            if (index % Math.ceil(dataPoints / 10) === 0) {
                const date = new Date(fearPoint.date);
                const dateStr = formatDateDisplayUTC(date);
                
                ctx.save();
                ctx.translate(x + barWidth / 2, chartMargin.top + chartHeight + 20);
                ctx.rotate(Math.PI / 4);
                ctx.fillStyle = '#333333';
                ctx.font = '24px Arial';
                ctx.textAlign = 'left';
                ctx.fillText(dateStr, 0, 0);
                ctx.restore();
            }
        });
        
        // Draw price line
        ctx.beginPath();
        let firstPoint = true;
        
        formattedFearData.forEach((fearPoint, index) => {
            const price = priceMap.get(fearPoint.date);
            if (price !== undefined) {
                const x = chartMargin.left + (index * (chartWidth / dataPoints)) + barWidth / 2;
                const y = priceScaleY(price);
                
                if (firstPoint) {
                    ctx.moveTo(x, y);
                    firstPoint = false;
                } else {
                    ctx.lineTo(x, y);
                }
            }
        });
        
        ctx.strokeStyle = '#3498DB';
        ctx.lineWidth = 4;
        ctx.stroke();
        
        // Draw axis labels
        ctx.font = '28px Arial';
        ctx.fillStyle = '#333333';
        ctx.textAlign = 'center';
        ctx.fillText('Fear & Greed Index Value', chartMargin.left / 2, chartMargin.top + chartHeight / 2);
        
        ctx.fillStyle = '#3498DB';
        ctx.fillText(`${cryptoName} Price (USD)`, chartMargin.left + chartWidth + chartMargin.right / 2, chartMargin.top + chartHeight / 2);
        
        ctx.fillStyle = '#333333';
        ctx.fillText('Date', chartMargin.left + chartWidth / 2, chartMargin.top + chartHeight + 120);
        
        // Draw summary information
        const latestFear = sortedFearData[sortedFearData.length-1];
        const latestValue = latestFear.value;
        const latestClassification = latestFear.value_classification;
        
        ctx.fillStyle = '#333333';
        ctx.textAlign = 'left';
        ctx.font = 'bold 28px Arial';
        ctx.fillText(`Latest Fear & Greed Index: ${latestValue} (${latestClassification})`, 100, height - 40);
        
        if (priceData.length > 0) {
            const latestPrice = priceData[priceData.length - 1].price;
            ctx.fillText(`Current ${cryptoName} Price: $${latestPrice.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`, 1000, height - 40);
        }
        
        // Add generation date
        ctx.font = '24px Arial';
        ctx.fillStyle = '#777777';
        ctx.textAlign = 'right';
        ctx.fillText(`Generated on ${formatDateTimeUTC(new Date())}`, width - 100, height - 40);
        
        // Create saved_data and Charts directories if they don't exist
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
        
        const today = formatDateUTC(new Date());
        // Use standardized naming format: [Chart Title] [Ticker] [DateRange],
        const cryptoTicker = cryptoSymbol.toUpperCase();
        // Default to 30 days back for fear index - create date range
        const end = new Date();
        const start = new Date(end.getTime() - (30 * 24 * 60 * 60 * 1000));
        const startDate = start.toISOString().split('T')[0];
        const endDate = end.toISOString().split('T')[0];
        const dateRange = startDate === endDate ? startDate : `${startDate}~${endDate}`;
        const fileName = `Fear Index Chart ${cryptoTicker} ${dateRange}.png`;
        const filePath = path.join(outputDir, fileName);
        
        // Convert canvas to PNG and save (async to avoid blocking event loop)
        const buffer: Buffer = await new Promise((resolve, reject) => {
            canvas.toBuffer((err, buf) => err ? reject(err) : resolve(buf), 'image/png');
        });
        await fs.promises.writeFile(filePath, buffer);
        
        return filePath;
    } catch (error) {
        console.error('Error generating fear index image:', error);
        throw error;
    }
}

export const FearIndexImageAction: Action = {
    name: 'get_crypto_fear_index_image',
    description: 'Generate an image of the cryptocurrency fear and greed index chart'

    ,
    handler: async (
        _runtime: IAgentRuntime,
        message: Memory,
        _state: State,
        _options: { [key: string]: unknown },
        callback: HandlerCallback
    ): Promise<boolean> => {
        const signal = _options?.signal as AbortSignal | undefined;
        try {
            // Parse days from user message (default to 30 if not specified)
            let days = 30;
            const daysMatch = message.content?.text?.match(/(\d+)\s*days?/i);
            if (daysMatch && daysMatch[1]) {
                days = Number.parseInt(daysMatch[1]);
                // Cap at 400 days to prevent excessive API usage
                days = Math.min(days, 400);
            }
            
            // Parse cryptocurrency from user message (default to BTC)
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
                actionName: "get_crypto_fear_index_image",
                type: "get_crypto_fear_index_image",
                text: `Fetching the crypto fear and greed index and ${cryptoName} price data for the past ${days} days...`,
            }));
            
            // Fetch fear index data and price data in parallel
            const [fearData, priceData] = await Promise.all([
                getFearAndGreedIndex(days),
                getCryptoPriceData(cryptoSymbol, days, signal)
            ]);
            
            if (!fearData || fearData.length === 0) {
                await callback(createActionErrorResponse({
                    actionName: "get_crypto_fear_index_image",
                    type: "get_crypto_fear_index_image_error",
                    error: new Error("No fear index data available"),
                    text: "Sorry, I couldn't retrieve the fear and greed index data at this time.",
                }));
                return false;
            }
            
            if (priceData.length === 0) {
                await callback(createActionResponse({
                    actionName: "get_crypto_fear_index_image",
                    type: "get_crypto_fear_index_image",
                    text: `I was able to fetch the fear index data, but couldn't retrieve ${cryptoName} price data. Continuing with fear index only.`,
                }));
                // Continue with fear index only in this case
            }
            
            // Generate the image
            const imagePath = await generateFearIndexImage(fearData, priceData, cryptoCode);
            
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
            
            // Read the image file and convert to base64 data URI for proper client rendering
            const imageBuffer = fs.readFileSync(imagePath);
            const base64Image = imageBuffer.toString('base64');
            const dataURI = `data:image/png;base64,${base64Image}`;

            // Generate action summary
            const actionSummary = generateActionSummary({
                actionName: 'Image Generation',
                assets: ['Visual'],
                timePeriod: 'on-demand',
                dataPoints: 1,
                additionalInfo: 'fear index chart image created'
            });

            // Return the image file as a data URI
            await callback(createActionResponse({
                actionName: "get_crypto_fear_index_image",
                type: "get_crypto_fear_index_image",
                text: `The latest Crypto Fear & Greed Index is **${latestData.value}** (${latestData.value_classification}) as of ${latestDate}.${priceInfo}`,
                actionData: {
                    summary: actionSummary,
                },
                additionalContent: {
                    attachments: [{
                        id: Date.now().toString(),
                        url: dataURI,
                        title: `Fear Index for ${cryptoName}`,
                        source: "fear-index-chart",
                        description: `Crypto Fear & Greed Index with ${cryptoName} price chart`,
                        text: "",
                        contentType: "image/png"
                    }],
                },
            }));
            
            return true;
        } catch (error) {
            console.error('Error in fear index image action:', error);
            await callback(createActionErrorResponse({
                actionName: "get_crypto_fear_index_image",
                type: "get_crypto_fear_index_image_error",
                error: error instanceof Error ? error : new Error(String(error)),
                text: `Sorry, I encountered an error while generating the fear index chart: ${error.message}`,
            }));
            return false;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show me the crypto fear index image",
                    action: "get_crypto_fear_index_image"
                }
            },
            {
                user: "{{user2}}",
                content: {
                    text: "The latest Crypto Fear & Greed Index is 38 (Fear) as of Mon May 12 2023. The current Bitcoin price is $27,340.25.",
                    action: "get_crypto_fear_index_image"
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Generate a fear index chart for Ethereum for the last 60 days",
                    action: "get_crypto_fear_index_image"
                }
            },
            {
                user: "{{user2}}",
                content: {
                    text: "The latest Crypto Fear & Greed Index is 34 (Fear) as of Mon May 12 2023. The current Ethereum price is $1,865.78.",
                    action: "get_crypto_fear_index_image"
                }
            }
        ],
    ] as ActionExample[][],
};
