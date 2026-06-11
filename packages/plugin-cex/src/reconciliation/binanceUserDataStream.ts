/**
 * BinanceUserDataStream — connects to Binance's user data WebSocket stream,
 * handles listen key rotation, reconnect with exponential backoff, and emits
 * order state transitions via the OnTransitionCallback.
 *
 * Architecture:
 *  - REST: POST /api/v3/userDataStream  → create listen key
 *          PUT  /api/v3/userDataStream  → keep-alive (extend 60 min window)
 *  - WS:   wss://stream.binance.com:9443/ws/<listenKey>
 *
 * Timers:
 *  - Keep-alive: every 25 min (Binance expires the key at 60 min; 25 is safe)
 *  - Hard reconnect: every 23 h (Binance closes the stream at 24 h)
 *  - All timers are unref()'d so they don't block process exit
 */

import https from "node:https";
import WebSocket from "ws";
import { elizaLogger } from "@elizaos/core";
import type {
    VenueUserDataStreamConfig,
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

const LOG_PREFIX = "[BinanceUserDataStream]";

/** Refresh the listen key every 25 minutes (Binance max is 60 min). */
const LISTEN_KEY_REFRESH_MS = 25 * 60 * 1000;

/** Schedule a hard reconnect every 23 hours (Binance closes stream at 24 h). */
const HARD_RECONNECT_MS = 23 * 60 * 60 * 1000;

/** Initial backoff on WS close/error. */
const BACKOFF_BASE_MS = 1_000;

/** Backoff cap — don't wait longer than this between reconnect attempts. */
const BACKOFF_MAX_MS = 60_000;

/** If listen-key creation fails, retry after this delay. */
const LISTEN_KEY_RETRY_MS = 5_000;

/** Default Binance production base URL. */
const DEFAULT_BASE_URL = "https://api.binance.com";

/** Default Binance production WebSocket base. */
const DEFAULT_WS_BASE = "wss://stream.binance.com:9443";

// ---------------------------------------------------------------------------
// Status map: Binance `X` field → PendingOrderState
// ---------------------------------------------------------------------------

const BINANCE_STATUS_MAP: Record<string, PendingOrderState> = {
    NEW: "acked",
    PARTIALLY_FILLED: "partially_filled",
    FILLED: "filled",
    CANCELED: "cancelled",
    EXPIRED: "expired",
    REJECTED: "rejected",
};

// ---------------------------------------------------------------------------
// Low-level REST helpers (plain node:https to avoid extra deps)
// ---------------------------------------------------------------------------

function httpsRequest(
    options: https.RequestOptions,
    body?: string,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
            res.on("error", reject);
        });
        req.on("error", reject);
        if (body) {
            req.write(body);
        }
        req.end();
    });
}

function buildRestOptions(
    method: "POST" | "PUT",
    path: string,
    apiKey: string,
    baseUrl: string,
): https.RequestOptions {
    const url = new URL(path, baseUrl);
    return {
        hostname: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: url.pathname + url.search,
        method,
        headers: {
            "X-MBX-APIKEY": apiKey,
            "Content-Length": 0,
        },
    };
}

async function createListenKey(baseUrl: string, apiKey: string): Promise<string> {
    const options = buildRestOptions(
        "POST",
        "/api/v3/userDataStream",
        apiKey,
        baseUrl,
    );
    const raw = await httpsRequest(options);
    const parsed = JSON.parse(raw) as { listenKey?: string; msg?: string };
    if (!parsed.listenKey) {
        throw new Error(
            `createListenKey: no listenKey in response — ${raw}`,
        );
    }
    return parsed.listenKey;
}

async function extendListenKey(
    baseUrl: string,
    apiKey: string,
    listenKey: string,
): Promise<void> {
    const path = `/api/v3/userDataStream?listenKey=${encodeURIComponent(listenKey)}`;
    const options = buildRestOptions("PUT", path, apiKey, baseUrl);
    await httpsRequest(options);
}

// ---------------------------------------------------------------------------
// BinanceUserDataStream
// ---------------------------------------------------------------------------

export class BinanceUserDataStream {
    private readonly config: VenueUserDataStreamConfig;
    private readonly onTransition: OnTransitionCallback;
    private readonly baseUrl: string;
    private readonly wsBase: string;

    private stopped = false;
    private listenKey: string | null = null;
    private ws: WebSocket | null = null;

    /** Exponential backoff: starts at BACKOFF_BASE_MS, caps at BACKOFF_MAX_MS. */
    private backoffMs = BACKOFF_BASE_MS;

    /** Active timer handles — stored so we can clearTimeout on cleanup. */
    private keepAliveTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private backoffTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        config: VenueUserDataStreamConfig,
        onTransition: OnTransitionCallback,
    ) {
        this.config = config;
        this.onTransition = onTransition;
        // Strip trailing slash once so all path joins are clean.
        this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
        // Derive WS base from REST base when a custom baseUrl is provided.
        // Heuristic: if it looks like testnet REST, swap to testnet WS.
        this.wsBase = this.deriveWsBase(this.baseUrl);
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
            `${LOG_PREFIX} Starting user data stream for userId=${this.config.userId}`,
        );
        // Kick off the first connection attempt (async, errors handled inside).
        this.connect();
        return () => this.cleanup();
    }

    // -----------------------------------------------------------------------
    // Internal — connection lifecycle
    // -----------------------------------------------------------------------

    private connect(): void {
        if (this.stopped) return;

        // If there's an existing WS still open from a previous cycle, close it
        // before opening a new one.
        this.closeWs();

        const attempt = async () => {
            if (this.stopped) return;
            try {
                elizaLogger.info(
                    `${LOG_PREFIX} Obtaining listen key from ${this.baseUrl}`,
                );
                this.listenKey = await createListenKey(
                    this.baseUrl,
                    this.config.apiKey,
                );
                elizaLogger.info(
                    `${LOG_PREFIX} Listen key obtained; opening WebSocket`,
                );
                this.openWebSocket(this.listenKey);
            } catch (err) {
                elizaLogger.error(
                    `${LOG_PREFIX} Failed to create listen key: ${String(err)}; retrying in ${LISTEN_KEY_RETRY_MS}ms`,
                );
                if (!this.stopped) {
                    this.backoffTimer = setTimeout(() => this.connect(), LISTEN_KEY_RETRY_MS);
                    this.backoffTimer.unref();
                }
            }
        };

        attempt();
    }

    private openWebSocket(listenKey: string): void {
        if (this.stopped) return;

        const wsUrl = `${this.wsBase}/ws/${listenKey}`;
        elizaLogger.info(`${LOG_PREFIX} Connecting to ${wsUrl}`);

        const ws = new WebSocket(wsUrl);
        this.ws = ws;

        ws.on("open", () => {
            if (this.stopped) {
                ws.close();
                return;
            }
            elizaLogger.info(`${LOG_PREFIX} WebSocket connected`);
            // Connection is healthy — reset exponential backoff.
            this.backoffMs = BACKOFF_BASE_MS;
            // Schedule periodic keep-alive and hard reconnect.
            this.scheduleKeepAlive();
            this.scheduleHardReconnect();
        });

        ws.on("message", (data: WebSocket.RawData) => {
            try {
                const payload = JSON.parse(data.toString()) as Record<string, unknown>;
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
            this.cancelKeepAliveAndReconnect();
            this.scheduleBackoffReconnect();
        });

        ws.on("error", (err: Error) => {
            if (this.stopped) return;
            elizaLogger.error(
                `${LOG_PREFIX} WebSocket error: ${String(err)}; scheduling reconnect`,
            );
            // The `close` event will fire after `error`, but we cancel timers
            // here as well to be safe.
            this.cancelKeepAliveAndReconnect();
            this.scheduleBackoffReconnect();
        });
    }

    // -----------------------------------------------------------------------
    // Internal — listen key keep-alive
    // -----------------------------------------------------------------------

    private scheduleKeepAlive(): void {
        this.clearTimer("keepAliveTimer");
        this.keepAliveTimer = setTimeout(
            () => this.keepAliveListenKey(),
            LISTEN_KEY_REFRESH_MS,
        );
        this.keepAliveTimer.unref();
    }

    private async keepAliveListenKey(): Promise<void> {
        if (this.stopped || !this.listenKey) return;
        try {
            await extendListenKey(
                this.baseUrl,
                this.config.apiKey,
                this.listenKey,
            );
            elizaLogger.debug(`${LOG_PREFIX} Listen key extended`);
        } catch (err) {
            elizaLogger.error(
                `${LOG_PREFIX} Failed to extend listen key: ${String(err)}`,
            );
        }
        // Reschedule regardless of success — worst case the key expires and the
        // hard-reconnect timer will start fresh.
        if (!this.stopped) {
            this.scheduleKeepAlive();
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
            this.cancelKeepAliveAndReconnect();
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

    private handleMessage(payload: Record<string, unknown>): void {
        if (payload.e !== "executionReport") return;

        const binanceStatus = payload.X as string | undefined;
        if (!binanceStatus) return;

        const newState = BINANCE_STATUS_MAP[binanceStatus];
        if (!newState) {
            // Status we don't care about (e.g. "PENDING_CANCEL") — ignore.
            return;
        }

        const clientOrderId = payload.c as string | undefined;
        const venueOrderId = payload.i !== undefined ? String(payload.i) : undefined;

        if (!clientOrderId) {
            elizaLogger.warn(
                `${LOG_PREFIX} executionReport missing clientOrderId; skipping`,
            );
            return;
        }

        const transition: PendingOrderStateTransition = {
            client_order_id: clientOrderId,
            new_state: newState,
            venue_order_id: venueOrderId,
            payload,
            source: "ws",
        };

        elizaLogger.debug(
            `${LOG_PREFIX} Order transition: ${clientOrderId} → ${newState} (venue_order_id=${venueOrderId})`,
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

    /**
     * Cancel keep-alive and hard-reconnect timers (used on WS close/error and
     * before scheduling a new WS or hard reconnect).
     */
    private cancelKeepAliveAndReconnect(): void {
        this.clearTimer("keepAliveTimer");
        this.clearTimer("reconnectTimer");
    }

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
    private clearTimer(name: "keepAliveTimer" | "reconnectTimer" | "backoffTimer"): void {
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
            `${LOG_PREFIX} Stopping user data stream for userId=${this.config.userId}`,
        );
        this.clearTimer("keepAliveTimer");
        this.clearTimer("reconnectTimer");
        this.clearTimer("backoffTimer");
        this.closeWs();
        this.listenKey = null;
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /**
     * Derive a WebSocket base URL from the REST base URL.
     * - Production REST  https://api.binance.com        → wss://stream.binance.com:9443
     * - Testnet REST     https://testnet.binance.vision → wss://testnet.binance.vision:9443
     * - Custom URL       https://custom.example.com      → wss://custom.example.com (no port)
     */
    private deriveWsBase(restBaseUrl: string): string {
        if (restBaseUrl.includes("api.binance.com")) {
            return DEFAULT_WS_BASE;
        }
        if (restBaseUrl.includes("testnet.binance.vision")) {
            return "wss://testnet.binance.vision:9443";
        }
        // Generic fallback: swap https → wss (no port appended for unknown hosts).
        return restBaseUrl.replace(/^https?:\/\//, "wss://");
    }
}
