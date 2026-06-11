export interface OhlcvBar {
    /** Bar open timestamp in milliseconds since epoch. */
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export type RegimeTag = "bull" | "bear" | "sideways" | "high_vol";

export interface RegimeWindow {
    start: number;
    end: number;
    tag: RegimeTag;
}

export interface BacktestPosition {
    symbol: string;
    quantity: number;
    avg_price: number;
    /** Opened at bar index. */
    opened_at: number;
}

export interface BacktestFill {
    timestamp: number;
    side: "BUY" | "SELL";
    quantity: number;
    price: number;
    fee: number;
    /** Slippage realized on this fill, in bps. */
    slippage_bps: number;
}

export interface BacktestSlippageModel {
    bps: number;
    /** Optional impact-per-unit-quantity in bps. */
    impact_bps_per_unit?: number;
}

export interface BacktestFeeModel {
    /** Per-trade fee in bps. */
    bps: number;
}

export interface BacktestRunConfig {
    symbol: string;
    /** Inclusive start ts (ms). */
    startTs: number;
    /** Inclusive end ts (ms). */
    endTs: number;
    initialEquity: number;
    fees: BacktestFeeModel;
    slippage: BacktestSlippageModel;
    /** Regime tags for the same symbol, optional. */
    regimes?: RegimeWindow[];
    /** In-sample fraction; default 0.7 (70%). */
    inSampleFraction?: number;
}

export interface BacktestMetrics {
    totalReturn: number;
    sharpe: number;
    sortino: number;
    maxDrawdown: number;
    winRate: number;
    profitFactor: number;
    feeAdjustedReturn: number;
    slippageAdjustedReturn: number;
    turnover: number;
    nTrades: number;
}

export interface BacktestReport {
    inSample: BacktestMetrics;
    outOfSample: BacktestMetrics;
    perRegime: Partial<Record<RegimeTag, BacktestMetrics>>;
    fills: BacktestFill[];
    finalEquity: number;
}
