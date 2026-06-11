/**
 * Reconciliation types for pending orders ledger and WebSocket stream reconciliation.
 * Shared across the reconciliation module and ledger storage implementations.
 */

/**
 * States that a pending order transitions through during its lifecycle.
 * Used to track order progress from submission through final fill or cancellation.
 */
export type PendingOrderState =
    | "submitted"
    | "acked"
    | "partially_filled"
    | "filled"
    | "cancelled"
    | "expired"
    | "rejected"
    | "reconciliation_failed"
    /**
     * The venue REST `createOrder`/`cancelOrder` call returned 5xx, timed out,
     * or otherwise failed *after* the request was sent. We don't know if the
     * order landed at the venue. Pre-submit dedup MUST refuse new submits for
     * the same client_order_id until reconciliation resolves this row to a
     * terminal state. (See plan §6.0.3.)
     */
    | "unknown";

/**
 * A row in the pending orders ledger. Persisted in the database to track
 * orders from submission until final settlement. Reconciliation services
 * use this as the source of truth for order state.
 */
export interface PendingOrderLedgerRow {
    /** Request tracing ID from CanonicalIntent. */
    request_id: string;

    /** Deterministic hash from idempotency layer. */
    intent_hash: string;

    /** Venue-safe client order ID, unique per user+venue. */
    client_order_id: string;

    /** Exchange name: "binance" | "coinbase" | "paper". */
    venue: string;

    /** Trading pair symbol (e.g. "BTCUSD", "ETHUSDT"). */
    symbol: string;

    /** User identifier. */
    userId: string;

    /** Current state of the order in its lifecycle. */
    state: PendingOrderState;

    /** ISO 8601 timestamp when the order was first submitted. */
    submittedAt: string;

    /** ISO 8601 timestamp of the most recent state transition or event. */
    lastSeenAt: string;

    /** Latest WS or REST payload for debugging order state. */
    latest_payload: unknown;

    /** Locale for localized messaging: "en" | "zh-CN" | "mixed-en". */
    locale: string;

    /**
     * B2 — when set, the reconciliation poller dispatches to the venue's
     * MARGIN order-status endpoint (Binance: `/sapi/v1/margin/order`)
     * instead of the spot endpoint (`/api/v3/order`). Without this,
     * Binance returns `-2013 "Order does not exist"` on every poll for
     * margin orders → the ledger row stays in its initial state forever.
     */
    margin_type?: "CROSS" | "ISOLATED";
}

/**
 * Represents a state transition event for a pending order.
 * Passed to ledger update operations to atomically transition an order state.
 */
export interface PendingOrderStateTransition {
    /** The client order ID being transitioned. */
    client_order_id: string;

    /** The new state to transition to. */
    new_state: PendingOrderState;

    /** Optional venue-assigned order ID when discovered (e.g. from WS ack). */
    venue_order_id?: string;

    /** Raw event payload that triggered the transition (for audit trail). */
    payload: unknown;

    /** Source of this transition detection. */
    source: "ws" | "rest_fallback";
}

/**
 * Event emitted by the reconciliation module when a pending order state changes.
 * Used by TradingEvents emitter and other observability systems.
 */
export interface ReconciliationEvent {
    /** The client order ID that changed state. */
    client_order_id: string;

    /** Intent hash from the original request. */
    intent_hash: string;

    /** User identifier. */
    userId: string;

    /** Exchange name. */
    venue: string;

    /** Trading pair symbol. */
    symbol: string;

    /** Previous order state. */
    from_state: PendingOrderState;

    /** New order state after this event. */
    to_state: PendingOrderState;

    /** How this transition was detected: WebSocket or REST fallback. */
    source: "ws" | "rest_fallback";

    /** Time in milliseconds from initial submission to this event. */
    latency_ms: number;
}

/**
 * Configuration for venue user data streams (WebSocket subscriptions).
 * Base interface for exchange-specific auth credentials.
 */
export interface VenueUserDataStreamConfig {
    /** User identifier for multi-user deployments. */
    userId: string;

    /** API key for the exchange. */
    apiKey: string;

    /** API secret for the exchange. */
    apiSecret: string;

    /** Optional override for test/staging WebSocket URL. */
    baseUrl?: string;
}

/**
 * Configuration for Coinbase Advanced Trade user data stream.
 * Extends the base config with Coinbase-specific auth scheme.
 */
export interface CoinbaseUserDataStreamConfig {
    /** User identifier for multi-user deployments. */
    userId: string;

    /** Coinbase Advanced Trade API key name. */
    apiKeyName: string;

    /** Coinbase private key in PEM format. */
    privateKey: string;

    /** Optional override for test/staging WebSocket URL. */
    baseWsUrl?: string;
}

/**
 * Contract that the reconciliation module requires from the database layer.
 * Implementations must provide these operations on the pending orders ledger.
 */
export interface LedgerOperations {
    /**
     * Insert or update a pending order row in the ledger.
     * Used to create new order entries or update existing ones.
     */
    upsertPendingOrder(row: PendingOrderLedgerRow): Promise<void>;

    /**
     * Atomically transition an order to a new state.
     * Returns the updated row if successful, null if the order not found.
     */
    updateOrderState(
        transition: PendingOrderStateTransition,
    ): Promise<PendingOrderLedgerRow | null>;

    /**
     * Fetch a pending order by its client order ID.
     * Returns the row if found, null otherwise.
     */
    getPendingOrderByClientOrderId(
        client_order_id: string,
    ): Promise<PendingOrderLedgerRow | null>;

    /**
     * Find all orders for a user that are still in "submitted" state
     * and older than a specified threshold. Used to detect stale orders
     * that may have been lost to the network.
     *
     * @param userId - The user to query
     * @param staleAfterMs - Orders not seen in this many milliseconds are considered stale
     * @returns Array of stale pending orders
     */
    getStaleSubmittedOrders(
        userId: string,
        staleAfterMs: number,
    ): Promise<PendingOrderLedgerRow[]>;

    /**
     * Find ALL orders across all users that are still in "submitted" state
     * and older than a specified threshold. Used by the reconciliation fallback
     * poller to detect stale orders that missed WebSocket delivery.
     *
     * @param staleAfterMs - Orders not seen in this many milliseconds are considered stale
     * @returns Array of stale pending orders across all users
     */
    getAllStaleSubmittedOrders(
        staleAfterMs: number,
    ): Promise<PendingOrderLedgerRow[]>;
}
