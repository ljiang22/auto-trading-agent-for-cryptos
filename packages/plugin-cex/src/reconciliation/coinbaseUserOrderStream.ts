/**
 * CoinbaseUserOrderStream — connects to Coinbase Advanced Trade's authenticated
 * WebSocket `user` channel, handles reconnect with exponential backoff, and
 * emits order state transitions via the OnTransitionCallback.
 *
 * Architecture:
 *  - WS: wss://advanced-trade-ws-user.coinbase.com
 *  - Auth: JWT signed with ES256 using the Coinbase API private key.
 *    A fresh JWT is generated per subscribe message (120-second exp).
 *  - No listen-key rotation needed (unlike Binance); a proactive hard
 *    reconnect every 23 hours keeps the session fresh.
 *
 * Timers:
 *  - Hard reconnect: every 23 h (proactive cycle, no Coinbase-mandated hard limit)
 *  - Exponential backoff on close/error: 1s → 2s → 4s → … → 60s cap
 *  - All timers are unref()'d so they don't block process exit
 */

import WebSocket from "ws";
import { elizaLogger } from "@elizaos/core";
import { signJwt } from "../exchanges/auth";
import type {
    CoinbaseUserDataStreamConfig,
    PendingOrderState,
    PendingOrderStateTransition,
} from "./types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type OnTransitionCallback = (
    transition: PendingOrderStateTransition,
) => void | Promise<void>;

export type StopFn = () => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_PREFIX = "[CoinbaseUserOrderStream]";

/** Schedule a hard reconnect every 23 hours (proactive refresh). */
const HARD_RECONNECT_MS = 23 * 60 * 60 * 1000;

/** Initial backoff on WS close/error. */
const BACKOFF_BASE_MS = 1_000;

/** Backoff cap — don't wait longer than this between reconnect attempts. */
const BACKOFF_MAX_MS = 60_000;

/** Default Coinbase Advanced Trade user-channel WebSocket URL. */
const DEFAULT_WS_URL = "wss://advanced-trade-ws-user.coinbase.com";

// ---------------------------------------------------------------------------
// Status map: Coinbase `status` field → PendingOrderState
// ---------------------------------------------------------------------------

const COINBASE_STATUS_MAP: Record<string, PendingOrderState> = {
    OPEN: "acked",
    PENDING: "acked",
    FILLED: "filled",
    CANCELLED: "cancelled",
    EXPIRED: "expired",
    FAILED: "rejected",
};

// ---------------------------------------------------------------------------
// JWT helper for WS subscribe
// ---------------------------------------------------------------------------

/**
 * Build a signed JWT for the Coinbase Advanced Trade WebSocket `user` channel.
 * The `uri` claim is omitted because WS subscribe messages don't correspond to
 * a REST path; the payload otherwise mirrors the REST JWT structure.
 */
function buildSubscribeJwt(apiKeyName: string, privateKey: string): string {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
        iss: "cdp",
        sub: apiKeyName,
        nbf: nowSeconds,
        exp: nowSeconds + 120,
    };
    return signJwt({
        privateKey,
        keyId: apiKeyName,
        algorithm: "ES256",
        payload,
    });
}

// ---------------------------------------------------------------------------
// Coinbase WS message types (narrow shapes we care about)
// ---------------------------------------------------------------------------

interface CoinbaseWsOrder {
    order_id?: string;
    client_order_id?: string;
    status?: string;
}

interface CoinbaseWsEvent {
    type?: string;
    orders?: CoinbaseWsOrder[];
}

interface CoinbaseWsMessage {
    channel?: string;
    events?: CoinbaseWsEvent[];
}

// ---------------------------------------------------------------------------
// CoinbaseUserOrderStream
// ---------------------------------------------------------------------------

export class CoinbaseUserOrderStream {
    private readonly config: CoinbaseUserDataStreamConfig;
    private readonly onTransition: OnTransitionCallback;
    private readonly wsUrl: string;

    private stopped = false;
    private ws: WebSocket | null = null;

    /** Exponential backoff: starts at BACKOFF_BASE_MS, caps at BACKOFF_MAX_MS. */
    private backoffMs = BACKOFF_BASE_MS;

    /** Active timer handles — stored so we can clearTimeout on cleanup. */
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private backoffTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        config: CoinbaseUserDataStreamConfig,
        onTransition: OnTransitionCallback,
    ) {
        this.config = config;
        this.onTransition = onTransition;
        this.wsUrl = (config.baseWsUrl ?? DEFAULT_WS_URL).replace(/\/$/, "");
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * Start the stream. Returns a stop function that tears everything down.
     */
    start(): StopFn {
        this.stopped = false;
        elizaLogger.info(
            `${LOG_PREFIX} Starting user order stream for userId=${this.config.userId}`,
        );
        this.connect();
        return () => this.cleanup();
    }

    // -----------------------------------------------------------------------
    // Internal — connection lifecycle
    // -----------------------------------------------------------------------

    private connect(): void {
        if (this.stopped) return;

        // Close any existing WS before opening a new one.
        this.closeWs();

        elizaLogger.info(`${LOG_PREFIX} Connecting to ${this.wsUrl}`);

        const ws = new WebSocket(this.wsUrl);
        this.ws = ws;

        ws.on("open", () => {
            if (this.stopped) {
                ws.close();
                return;
            }
            elizaLogger.info(`${LOG_PREFIX} WebSocket connected; subscribing to user channel`);
            // Connection is healthy — reset exponential backoff.
            this.backoffMs = BACKOFF_BASE_MS;

            // Send the authenticated subscribe message with a fresh JWT.
            this.sendSubscribe(ws);

            // Schedule proactive hard reconnect every 23 h.
            this.scheduleHardReconnect();
        });

        ws.on("message", (data: WebSocket.RawData) => {
            try {
                const payload = JSON.parse(data.toString()) as CoinbaseWsMessage;
                this.handleMessage(payload);
            } catch (err) {
                elizaLogger.error(`${LOG_PREFIX} Error parsing message: ${String(err)}`);
            }
        });

        ws.on("close", (code: number, reason: Buffer) => {
            if (this.stopped) return;
            elizaLogger.warn(
                `${LOG_PREFIX} WebSocket closed (code=${code}, reason=${reason.toString()}); scheduling reconnect`,
            );
            this.clearTimer("reconnectTimer");
            this.scheduleBackoffReconnect();
        });

        ws.on("error", (err: Error) => {
            if (this.stopped) return;
            elizaLogger.error(
                `${LOG_PREFIX} WebSocket error: ${String(err)}; scheduling reconnect`,
            );
            // `close` will also fire after `error`, but cancel timers here too.
            this.clearTimer("reconnectTimer");
            this.scheduleBackoffReconnect();
        });
    }

    // -----------------------------------------------------------------------
    // Internal — subscribe message
    // -----------------------------------------------------------------------

    private sendSubscribe(ws: WebSocket): void {
        const { apiKeyName, privateKey } = this.config;
        let jwt: string;
        try {
            jwt = buildSubscribeJwt(apiKeyName, privateKey);
        } catch (err) {
            elizaLogger.error(
                `${LOG_PREFIX} Failed to sign subscribe JWT: ${String(err)}`,
            );
            return;
        }

        const subscribeMsg = JSON.stringify({
            type: "subscribe",
            channel: "user",
            api_key: apiKeyName,
            jwt,
        });

        try {
            ws.send(subscribeMsg);
            elizaLogger.debug(`${LOG_PREFIX} Sent subscribe message for channel=user`);
        } catch (err) {
            elizaLogger.error(
                `${LOG_PREFIX} Failed to send subscribe message: ${String(err)}`,
            );
        }
    }

    // -----------------------------------------------------------------------
    // Internal — hard reconnect (23-hour cycle)
    // -----------------------------------------------------------------------

    private scheduleHardReconnect(): void {
        this.clearTimer("reconnectTimer");
        this.reconnectTimer = setTimeout(() => {
            elizaLogger.info(
                `${LOG_PREFIX} 23-hour cycle elapsed; performing hard reconnect`,
            );
            this.connect();
        }, HARD_RECONNECT_MS);
        this.reconnectTimer.unref();
    }

    // -----------------------------------------------------------------------
    // Internal — exponential backoff reconnect
    // -----------------------------------------------------------------------

    private scheduleBackoffReconnect(): void {
        if (this.stopped) return;
        const delay = this.backoffMs;
        // Double next delay, capped at BACKOFF_MAX_MS.
        this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);

        elizaLogger.info(
            `${LOG_PREFIX} Scheduling reconnect in ${delay}ms (next backoff=${this.backoffMs}ms)`,
        );

        this.clearTimer("backoffTimer");
        this.backoffTimer = setTimeout(() => this.connect(), delay);
        this.backoffTimer.unref();
    }

    // -----------------------------------------------------------------------
    // Internal — message handling
    // -----------------------------------------------------------------------

    private handleMessage(msg: CoinbaseWsMessage): void {
        // Only handle `user` channel messages.
        if (msg.channel !== "user") return;

        const events = msg.events;
        if (!Array.isArray(events)) return;

        for (const event of events) {
            if (event.type !== "update") continue;
            const orders = event.orders;
            if (!Array.isArray(orders)) continue;

            for (const order of orders) {
                this.handleOrderUpdate(order);
            }
        }
    }

    private handleOrderUpdate(order: CoinbaseWsOrder): void {
        const { status, client_order_id, order_id } = order;

        if (!status) return;

        const newState = COINBASE_STATUS_MAP[status];
        if (!newState) {
            // Status we don't map (e.g. "QUEUED") — ignore.
            return;
        }

        if (!client_order_id) {
            elizaLogger.warn(
                `${LOG_PREFIX} Order update missing client_order_id; skipping (order_id=${order_id ?? "unknown"})`,
            );
            return;
        }

        const transition: PendingOrderStateTransition = {
            client_order_id,
            new_state: newState,
            venue_order_id: order_id,
            payload: order,
            source: "ws",
        };

        elizaLogger.debug(
            `${LOG_PREFIX} Order transition: ${client_order_id} → ${newState} (venue_order_id=${order_id ?? "unknown"})`,
        );

        // Fire the callback; wrap async to prevent unhandled rejection.
        try {
            const result = this.onTransition(transition);
            if (result instanceof Promise) {
                result.catch((err) => {
                    elizaLogger.error(
                        `${LOG_PREFIX} onTransition callback threw: ${String(err)}`,
                    );
                });
            }
        } catch (err) {
            elizaLogger.error(
                `${LOG_PREFIX} onTransition callback threw synchronously: ${String(err)}`,
            );
        }
    }

    // -----------------------------------------------------------------------
    // Internal — cleanup helpers
    // -----------------------------------------------------------------------

    /** Close the WebSocket without triggering the automatic backoff reconnect. */
    private closeWs(): void {
        if (this.ws) {
            // Remove all listeners first so the `close` event handler (which
            // would schedule a backoff reconnect) doesn't fire.
            this.ws.removeAllListeners();
            try {
                this.ws.close();
            } catch {
                // Ignore errors on close — the socket may already be gone.
            }
            this.ws = null;
        }
    }

    /** Clear a named timer if set. */
    private clearTimer(name: "reconnectTimer" | "backoffTimer"): void {
        if (this[name] !== null) {
            clearTimeout(this[name]!);
            this[name] = null;
        }
    }

    /**
     * Full teardown: clear all timers, close the WebSocket, mark stopped so
     * no new connections or timers are created.
     */
    private cleanup(): void {
        this.stopped = true;
        elizaLogger.info(
            `${LOG_PREFIX} Stopping user order stream for userId=${this.config.userId}`,
        );
        this.clearTimer("reconnectTimer");
        this.clearTimer("backoffTimer");
        this.closeWs();
    }
}
