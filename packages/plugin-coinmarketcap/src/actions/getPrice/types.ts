import type { Content } from "@elizaos/core";

export interface GetPriceContent extends Content {
    symbol: string;
    currency: string;
    date?: string | null;
}

export interface PriceData {
    price: number;
    marketCap: number | null;
    volume24h: number | null;
    percentChange24h: number | null;
    percentChange1h: number | null;
    percentChange7d: number | null;
    percentChange30d: number | null;
    fullyDilutedMarketCap: number | null;
    circulatingSupply: number | null;
    totalSupply: number | null;
    maxSupply: number | null;
    lastUpdated: string;
    high52w: number | null;
    low52w: number | null;
    fearIndex: number | null;
    fearIndexClassification: string | null;
    fearIndexUpdateTime: string | null;
    requestedDate?: string | null;
    openPrice?: number | null;
    highPrice?: number | null;
    lowPrice?: number | null;
    closePrice?: number | null;
}

export interface ApiResponse {
    data: {
        [symbol: string]: {
            quote: {
                [currency: string]: {
                    price: number;
                    market_cap: number;
                    volume_24h: number;
                    percent_change_24h: number;
                    percent_change_1h: number;
                    percent_change_7d: number;
                    percent_change_30d: number;
                    fully_diluted_market_cap: number;
                    last_updated: string;
                };
            };
            circulating_supply: number;
            total_supply: number;
            max_supply: number | null;
        };
    };
}
