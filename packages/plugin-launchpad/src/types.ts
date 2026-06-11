export type LaunchpadPhase = "new" | "bonding" | "graduated";

export interface LaunchpadToken {
    tokenAddress?: string;
    symbol?: string;
    name?: string;
    decimals?: number;
    logo?: string;
    totalSupply?: number;
    volume1h?: number;
    buy1h?: number;
    sell1h?: number;
    tx1h?: number;
    totalHolders?: number;
    priceNative?: number;
    priceUsd?: number;
    mktCapUsd?: number;
    createdAt?: number;
    graduationAt?: number;
    bondingCurveProgress?: number;
}

export interface LaunchpadApiEnvelope {
    code?: number;
    message?: string;
    data?: LaunchpadToken[];
}

export interface LaunchpadTokenWithPhase extends LaunchpadToken {
    phase: LaunchpadPhase;
}

export interface LaunchpadQuery {
    phase?: LaunchpadPhase | "all";
    tokenAddress?: string;
    symbol?: string;
    keywords?: string[];
    limit?: number;
}

export interface LaunchpadMetricsQuery extends LaunchpadQuery {
    timeRangeLabel?: string;
    metrics?: string[];
}
