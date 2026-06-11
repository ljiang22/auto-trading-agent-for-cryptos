export type SearchResult = {
    title: string;
    url: string;
    content: string;
    rawContent?: string;
    score: number;
    publishedDate?: string;
};

export type SearchImage = {
    url: string;
    description?: string;
};


export type SearchResponse = {
    answer?: string;
    query: string;
    responseTime: number;
    images: SearchImage[];
    results: SearchResult[];
};

export interface SearchOptions {
    max_results?: number;
    include_answer?: string;
    search_depth?: "basic" | "advanced";
    topic?: "news" | "general";
    days?: number;
    include_raw_content?: string;
}

// Crypto-specific types for institutional adoption
export interface CryptoInstitutionalData {
    companyName?: string;
    cryptoAsset?: string;
    investmentAmount?: string;
    investmentDate?: string;
    adoptionType?: "treasury" | "etf" | "investment_fund" | "payment" | "mining" | "trading";
    regulatoryStatus?: string;
    marketImpact?: string;
}

export interface InstitutionalAdoptionEvent {
    institution: string;
    cryptoAssets: string[];
    announcementDate: string;
    adoptionDetails: CryptoInstitutionalData;
    sourceUrl: string;
    verificationStatus: "confirmed" | "rumored" | "pending";
}

export interface CryptoMarketMetrics {
    totalInstitutionalHoldings?: string;
    percentageOfSupply?: number;
    marketCapImpact?: string;
    priceMovement?: string;
    institutionalDomination?: number;
}
