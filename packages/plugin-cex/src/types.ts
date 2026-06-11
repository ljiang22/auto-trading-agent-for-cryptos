import type { ExchangeAuthType, ExchangeId, UUID } from "@elizaos/core";

export type ExchangeName = ExchangeId;

export interface ExchangeRegistryEntry {
    id: ExchangeName;
    name: string;
    /**
     * Curated short-form / alternate names users might type. Matched
     * case-insensitively. Adding an alias requires a PR + dashboard
     * review per the autotrading-uplift plan §Risks #6.
     */
    aliases?: string[];
}

export type ResolvedExchangeCredentials = {
    exchange: ExchangeName;
    authType: ExchangeAuthType;
    auth: Record<string, string>;
};

export interface TradeActionBaseParams {
    userId: UUID;
    /** Injected by plugin-cex after resolving creds; not user-provided. */
    exchange?: ExchangeName;
    /**
     * Workflow-scoped request identifier — propagated to venue_calls,
     * risk_decisions, and reconciliation events for replay (plan §6.7).
     */
    request_id?: string;
    /** Canonical intent hash. Used to join venue_calls back to risk_decisions. */
    intent_hash?: string;
}

/**
 * Wallet scope filter for get_balance. When omitted (or `"all"`), the
 * Binance venue fans out spot + funding + margin_cross + margin_isolated
 * in parallel. When set to a single value, only that wallet is fetched —
 * saves API quota AND suppresses irrelevant permission-denied noise for
 * "show my spot balance" / "show my margin balance" style queries
 * (Issue 4).
 *
 * Coinbase only has spot today; the venue layer ignores this filter for
 * non-Binance venues and always returns the single wallet snapshot.
 */
export type WalletTypeFilter =
    | "spot"
    | "funding"
    | "margin_cross"
    | "margin_isolated"
    | "all";

export interface GetBalanceParams extends TradeActionBaseParams {
    limit?: number;
    cursor?: string;
    retail_portfolio_id?: string;
    wallet_type?: WalletTypeFilter;
}

export interface GetOrdersParams extends TradeActionBaseParams {
    order_ids?: string[];
    product_ids?: string[];
    order_status?: string[];
    limit?: number;
    cursor?: string;
    start_date?: string;
    end_date?: string;
    order_side?: "BUY" | "SELL";
    order_types?: string[];
    product_type?: string;
    /**
     * B4 — when set, route the lookup to the venue's MARGIN open-orders
     * endpoint (Binance: `/sapi/v1/margin/openOrders`, optionally
     * `isIsolated=TRUE`). Without this, get_orders queried only the
     * spot endpoint and margin orders were invisible to "what margin
     * orders do I have" prompts.
     */
    margin_type?: "CROSS" | "ISOLATED";
    /**
     * Fix 4 — quote currency for the fan-out path. When `product_ids`
     * is missing AND a date window is set, the venue layer enumerates
     * the user's held base assets and constructs candidate pairs as
     * `<asset>{quote_currency}`. Default `USDT`.
     */
    quote_currency?: string;
    /**
     * CEX post-PR237 Commit 6 — Explicit "history" intent flag. When
     * the user asks for order history without specifying a date
     * window (e.g. "show me my recent orders", "what orders have I
     * placed"), the decomposer emits `history: true` and the venue
     * layer fans out across held base assets exactly as it does
     * today for the date-window case. Distinguishes the two semantic
     * intents that were previously conflated:
     *   - `history: false` (or omitted) + no date window
     *       → open orders only (`spot.getOpenOrders`).
     *   - `history: true` OR date window present
     *       → fan out across held assets (`spot.allOrders`).
     */
    history?: boolean;
}

type OrderSizeFields = {
    base_size?: string;
    quote_size?: string;
};

type OrderLimitFields = {
    base_size?: string;
    limit_price: string;
    post_only?: boolean;
    end_time?: string;
    /**
     * Iceberg quantity (visible portion of a hidden limit order).
     * Binance Spot only honours this on `LIMIT` GTC orders.
     */
    iceberg_qty?: string;
};

type OrderStopLimitFields = {
    base_size?: string;
    stop_price: string;
    limit_price: string;
    stop_direction?: "STOP_DIRECTION_STOP_UP" | "STOP_DIRECTION_STOP_DOWN";
    end_time?: string;
    iceberg_qty?: string;
};

type OrderTriggerBracketFields = {
    limit_price: string;
    stop_trigger_price: string;
    end_time?: string;
};

/**
 * Trailing stop fields. `trailing_delta_bps` is expressed in basis points
 * (1 bp = 0.01%). Binance accepts an integer 1..2000 (= 0.01% .. 20%).
 * `activation_price` is optional; when omitted, Binance activates the
 * trailing rule immediately on placement.
 */
type OrderTrailingStopFields = {
    base_size: string;
    trailing_delta_bps: number;
    activation_price?: string;
    limit_price?: string;
    stop_direction?: "STOP_DIRECTION_STOP_UP" | "STOP_DIRECTION_STOP_DOWN";
};

/**
 * OCO (One-Cancels-the-Other) pairs a take-profit limit (`above_*`) with a
 * stop-loss order (`below_*`). Binance routes both legs as a list and
 * cancels the second when one fills. We expose only the most common
 * variant (`LIMIT_MAKER` above + `STOP_LOSS_LIMIT` below) since covering
 * every combination would balloon the schema; the underlying executor
 * leaves room to extend this later.
 */
type OrderOcoFields = {
    base_size: string;
    above_limit_price: string;
    below_stop_price: string;
    below_limit_price: string;
    /** GTC/IOC/FOK for the `STOP_LOSS_LIMIT` leg. Defaults to GTC. */
    below_time_in_force?: "GTC" | "IOC" | "FOK";
};

export type OrderConfiguration = {
    market_market_ioc?: OrderSizeFields;
    market_market_fok?: OrderSizeFields;
    limit_limit_gtc?: OrderLimitFields;
    limit_limit_gtd?: OrderLimitFields;
    sor_limit_ioc?: OrderLimitFields;
    stop_limit_stop_limit_gtc?: OrderStopLimitFields;
    stop_limit_stop_limit_gtd?: OrderStopLimitFields;
    limit_limit_fok?: OrderLimitFields;
    trigger_bracket_gtc?: OrderTriggerBracketFields;
    trigger_bracket_gtd?: OrderTriggerBracketFields;
    /** Trailing stop limit (basis-point trail). */
    trailing_stop_limit_gtc?: OrderTrailingStopFields;
    /** OCO pair (take-profit limit + stop-loss limit). */
    oco_gtc?: OrderOcoFields;
};

export type MarginAction = "NORMAL" | "AUTO_BORROW" | "AUTO_REPAY";

export interface CreateOrderParams extends TradeActionBaseParams {
    client_order_id: string;
    product_id: string;
    side: "BUY" | "SELL";
    order_configuration: OrderConfiguration;
    leverage?: string;
    margin_type?: "CROSS" | "ISOLATED";
    /**
     * Margin trade mode; mirrors the Binance UI "Normal / Borrow / Repay"
     * toggle. `AUTO_BORROW` lets the venue auto-borrow up to `leverage`,
     * `AUTO_REPAY` repays an open margin loan with the proceeds. Ignored
     * for spot orders.
     */
    margin_action?: MarginAction;
    preview_id?: string;
    retail_portfolio_id?: string;
}

export interface CancelOrderParams extends TradeActionBaseParams {
    order_ids: string[];
    /** Required for Binance if order symbol cannot be inferred from open orders. */
    product_id?: string;
}

export interface GetFillsParams extends TradeActionBaseParams {
    order_ids?: string[];
    trade_ids?: string[];
    product_ids?: string[];
    limit?: number;
    cursor?: string;
    start_sequence_timestamp?: string;
    end_sequence_timestamp?: string;
    retail_portfolio_id?: string;
    /**
     * Fix 4b — quote currency for the fan-out path. When `product_ids`
     * is missing/empty, the venue layer enumerates the user's held base
     * assets and constructs candidate pairs as `<asset>{quote_currency}`.
     * Default `USDT`.
     */
    quote_currency?: string;
}

export interface EditOrderParams extends TradeActionBaseParams {
    orderId: string;
    price?: string;
    size?: string;
    attachedOrderConfiguration?: Record<string, unknown>;
    stopPrice?: string;
}

export interface ClosePositionParams extends TradeActionBaseParams {
    client_order_id: string;
    product_id: string;
    size: number;
}

export interface ExchangeAccountsService {
    getBalance(params: GetBalanceParams): Promise<unknown>;
}

export interface ExchangeOrdersService {
    getOrders(params: GetOrdersParams): Promise<unknown>;
    createOrder(params: CreateOrderParams): Promise<unknown>;
    cancelOrder(params: CancelOrderParams): Promise<unknown>;
    getFills(params: GetFillsParams): Promise<unknown>;
    editOrder(params: EditOrderParams): Promise<unknown>;
    closePosition(params: ClosePositionParams): Promise<unknown>;
}

export interface ExchangeService {
    exchange: ExchangeName;
    accounts: ExchangeAccountsService;
    orders: ExchangeOrdersService;
}
