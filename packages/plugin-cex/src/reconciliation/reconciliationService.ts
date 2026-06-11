/**
 * ReconciliationService — long-lived coordinator that manages one WebSocket
 * stream per active exchange credential and wraps the REST fallback poller.
 *
 * Responsibilities:
 *  - Starts/stops BinanceUserDataStream and CoinbaseUserOrderStream instances.
 *  - Starts/stops the ReconciliationFallback REST poller.
 *  - Handles every state transition: updates the ledger, builds a
 *    ReconciliationEvent, emits it via emitReconciliationEvent, and forwards
 *    it to the optional onTransitionSettled callback.
 *  - Exposes getOrderState / trackOrder so callers (e.g. cexWorkflowMessageHandler)
 *    can query and insert ledger rows without touching the DB directly.
 */

import { elizaLogger, Service, ServiceType } from "@elizaos/core";
import type { IAgentRuntime, ITradingReconciliationService } from "@elizaos/core";
import { acquireTradingLock } from "../concurrency/tradingLock";
import { BinanceUserDataStream } from "./binanceUserDataStream";
import { CoinbaseUserOrderStream } from "./coinbaseUserOrderStream";
import { createReconciliationFallback, type ResolveCredentialsFn } from "./reconciliationFallback";
import {
    emitReconciliationEvent,
    emitReconciliationHealth,
} from "../observability/tradingEvents";
import { recordMarketDataSample } from "./marketDataAge";
import type { StopFn } from "./binanceUserDataStream";
import type {
    LedgerOperations,
    PendingOrderLedgerRow,
    PendingOrderStateTransition,
    ReconciliationEvent,
} from "./types";
import type { ResolvedExchangeCredentials } from "../types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_PREFIX = "[ReconciliationService]";

const BINANCE_BASE_URL =
    process.env.BINANCE_BASE_URL?.trim() || "https://api.binance.com";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReconciliationServiceConfig {
    ledger: LedgerOperations;
    /**
     * F5 — startup credentials list. Used to pre-warm WebSocket streams
     * for users who already had keys saved at service-start time. After
     * boot, the per-(userId,venue) `resolveCredentials` resolver below
     * is the canonical lookup for the REST fallback poller. Either may
     * be empty.
     */
    credentials?: ResolvedExchangeCredentials[];
    /**
     * F5 — per-(userId,venue) credential resolver. Wraps
     * `resolveExchangeCredentials` from `actions/shared.ts` so the REST
     * fallback poller always reads the latest persisted CEX keys, not
     * the empty array baked in at startup.
     */
    resolveCredentials?: ResolveCredentialsFn;
    /**
     * F5 — auto-downgrade hook. Fires when a (userId, venue) has had
     * N consecutive cred-unresolved poll cycles. Implementations should
     * set a read-only lock on `user_trading_preferences.runtime_lock`.
     */
    onUnresolvedDowngrade?: (args: { userId: string; venue: string; streak: number }) => void | Promise<void>;
    /** Called on every state transition (from both WS and REST fallback). */
    onTransitionSettled?: (event: ReconciliationEvent) => void;
}

// ---------------------------------------------------------------------------
// ReconciliationService
// ---------------------------------------------------------------------------

export class ReconciliationService extends Service implements ITradingReconciliationService {
    static get serviceType(): ServiceType {
        return ServiceType.TRADING_RECONCILIATION;
    }

    private readonly config: ReconciliationServiceConfig;
    private stopFns: StopFn[] = [];

    constructor(config: ReconciliationServiceConfig) {
        super();
        this.config = config;
    }

    /**
     * Satisfy the Service abstract contract.
     * Initialization is performed externally via start() — no-op here.
     */
    async initialize(_runtime: IAgentRuntime): Promise<void> {
        // Initialized externally via start() — no-op here.
    }

    /**
     * Acquire a per-symbol trading lock. Delegates to acquireTradingLock.
     */
    async acquireOrderLock(userId: string, venue: string, symbol: string): Promise<() => void> {
        return acquireTradingLock(userId, venue, symbol);
    }

    /**
     * Liveness signal for the handler's dep-health gate (plan §6.0.2).
     * Healthy ⇔ the service has been started and at least one stop fn
     * (WS stream or fallback poller) is registered.
     */
    isHealthy(_venue?: string): boolean {
        return this.stopFns.length > 0;
    }

    /**
     * Read-only ledger access for the pre-submit dedup gate (plan §6.0.1).
     */
    getLedger() {
        const l = this.config.ledger;
        return {
            async getPendingOrderByClientOrderId(client_order_id: string) {
                const row = await l.getPendingOrderByClientOrderId(client_order_id);
                if (!row) return null;
                return {
                    request_id: row.request_id,
                    client_order_id: row.client_order_id,
                    state: row.state,
                    venue: row.venue,
                    symbol: row.symbol,
                    userId: row.userId,
                };
            },
        };
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * Start all streams and the fallback poller.
     * Called once at agent startup.
     */
    start(): void {
        const { credentials = [], ledger, resolveCredentials, onUnresolvedDowngrade } = this.config;

        let binanceCount = 0;
        let coinbaseCount = 0;

        for (const credential of credentials) {
            const exchange = credential.exchange.toLowerCase();

            if (exchange === "binance") {
                const apiKey = credential.auth?.apiKey ?? "";
                const apiSecret = credential.auth?.apiSecret ?? "";
                const userId = credential.auth?.userId ?? "";

                const stream = new BinanceUserDataStream(
                    {
                        userId,
                        apiKey,
                        apiSecret,
                        baseUrl: BINANCE_BASE_URL,
                    },
                    (transition) => this.handleTransition(transition),
                );
                this.stopFns.push(stream.start());
                binanceCount++;
            } else if (exchange === "coinbase") {
                const apiKeyName = credential.auth?.apiKeyName ?? "";
                const privateKey = credential.auth?.privateKey ?? "";
                const userId = credential.auth?.userId ?? "";

                const stream = new CoinbaseUserOrderStream(
                    {
                        userId,
                        apiKeyName,
                        privateKey,
                    },
                    (transition) => this.handleTransition(transition),
                );
                this.stopFns.push(stream.start());
                coinbaseCount++;
            }
        }

        // F5 — Start the REST fallback poller with the per-(userId, venue)
        // resolver when available. Falls back to the static array if the
        // caller didn't wire a resolver (test path only — production must
        // supply `resolveCredentials`).
        const stopFallback = createReconciliationFallback({
            ledger,
            resolveCredentials,
            credentials,
            onUnresolvedDowngrade: async ({ userId, venue, streak }) => {
                emitReconciliationHealth({
                    userId,
                    venue: venue as Parameters<typeof emitReconciliationHealth>[0]["venue"],
                    decision: "downgrade",
                    streak,
                    reason: "credentials_unresolvable",
                });
                if (typeof onUnresolvedDowngrade === "function") {
                    try {
                        const r = onUnresolvedDowngrade({ userId, venue, streak });
                        if (r instanceof Promise) await r;
                    } catch (err) {
                        elizaLogger.error(
                            `${LOG_PREFIX} onUnresolvedDowngrade hook threw: ${String(err)}`,
                        );
                    }
                }
            },
            onTransition: (transition) => this.handleTransition(transition),
        });
        this.stopFns.push(stopFallback);

        elizaLogger.info(
            `${LOG_PREFIX} Started: binance_streams=${binanceCount} coinbase_streams=${coinbaseCount} fallback_poller=1`,
        );
    }

    /**
     * Stop all streams, poller, and clean up.
     */
    stop(): void {
        elizaLogger.info(
            `${LOG_PREFIX} Stopping ${this.stopFns.length} stream(s)/poller(s)`,
        );
        for (const stopFn of this.stopFns) {
            try {
                stopFn();
            } catch (err) {
                elizaLogger.error(
                    `${LOG_PREFIX} Error while stopping a stream/poller: ${String(err)}`,
                );
            }
        }
        this.stopFns = [];
    }

    /**
     * Query the current state of an order from the ledger.
     * Returns null if the order is not found (was never submitted, or purged).
     */
    getOrderState(client_order_id: string): Promise<PendingOrderLedgerRow | null> {
        return this.config.ledger.getPendingOrderByClientOrderId(client_order_id);
    }

    /**
     * Insert a new order row into the ledger immediately after REST submit.
     * Called by cexWorkflowMessageHandler before releasing the trading lock.
     * Accepts the broader ITradingReconciliationService shape (state: string)
     * and casts to PendingOrderLedgerRow for the ledger.
     */
    trackOrder(row: {
        request_id: string;
        intent_hash: string;
        client_order_id: string;
        venue: string;
        symbol: string;
        userId: string;
        state: string;
        submittedAt: string;
        lastSeenAt: string;
        latest_payload: unknown;
        locale: string;
        /** B2 — drives margin-vs-spot dispatch in the reconciliation poller. */
        margin_type?: "CROSS" | "ISOLATED";
    }): Promise<void> {
        return this.config.ledger.upsertPendingOrder(row as PendingOrderLedgerRow);
    }

    // -----------------------------------------------------------------------
    // Internal — transition handler
    // -----------------------------------------------------------------------

    private async handleTransition(
        transition: PendingOrderStateTransition,
    ): Promise<void> {
        const { ledger, onTransitionSettled } = this.config;

        // Atomically transition the ledger row.
        let updatedRow: PendingOrderLedgerRow | null;
        try {
            updatedRow = await ledger.updateOrderState(transition);
        } catch (err) {
            elizaLogger.error(
                `${LOG_PREFIX} ledger.updateOrderState failed for client_order_id=${transition.client_order_id}: ${String(err)}`,
            );
            return;
        }

        if (updatedRow === null) {
            // Order already in a terminal state — skip gracefully.
            elizaLogger.debug(
                `${LOG_PREFIX} client_order_id=${transition.client_order_id} already in terminal state; skipping transition to ${transition.new_state}`,
            );
            return;
        }

        // Compute latency from submission to now.
        const submittedAt = updatedRow.submittedAt
            ? new Date(updatedRow.submittedAt).getTime()
            : Date.now();
        const latency_ms = Date.now() - submittedAt;

        // Build the reconciliation event.
        // from_state is inferred as "submitted" since reconciliation flows always
        // start from submitted orders; the updated row carries the new (to) state.
        const event: ReconciliationEvent = {
            client_order_id: updatedRow.client_order_id,
            intent_hash: updatedRow.intent_hash,
            userId: updatedRow.userId,
            venue: updatedRow.venue,
            symbol: updatedRow.symbol,
            from_state: "submitted",
            to_state: transition.new_state,
            source: transition.source,
            latency_ms,
        };

        elizaLogger.info(
            `${LOG_PREFIX} Order ${updatedRow.client_order_id} transitioned from ${event.from_state} to ${event.to_state} via ${event.source} in ${latency_ms}ms`,
        );

        // Emit structured trading event.
        emitReconciliationEvent({
            request_id: updatedRow.request_id,
            intent_hash: updatedRow.intent_hash,
            userId: updatedRow.userId,
            venue: updatedRow.venue as Parameters<typeof emitReconciliationEvent>[0]["venue"],
            symbol: updatedRow.symbol,
            client_order_id: updatedRow.client_order_id,
            state: transition.new_state,
            source: transition.source,
            // F4-r3 — submit→reconciliation latency, the SLO this
            // service actually owns. Already computed above as the
            // age of the matching ledger row.
            latency_ms,
        });

        // §6.0.2 — record a market-data freshness sample so the
        // fail-closed dep-health gate can detect WS silence.
        recordMarketDataSample(updatedRow.venue, updatedRow.symbol);

        // Forward to caller hook if provided.
        try {
            onTransitionSettled?.(event);
        } catch (err) {
            elizaLogger.error(
                `${LOG_PREFIX} onTransitionSettled callback threw for client_order_id=${updatedRow.client_order_id}: ${String(err)}`,
            );
        }
    }
}
