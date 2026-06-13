/**
 * ReconciliationFallback — periodic REST poller that detects orders stuck in
 * "submitted" state longer than the stale threshold and reconciles them via
 * the venue REST API.
 *
 * Flow:
 *  1. Every `pollIntervalMs` (default 30 s), query the ledger for all orders
 *     in "submitted" state older than `staleThresholdMs` (default 60 s).
 *  2. For each stale order, look up credentials for its venue.
 *  3. Call the venue REST API to fetch the current order status.
 *  4. If the REST response maps to a known state, call `onTransition` with
 *     `source: "rest_fallback"`.
 *  5. Errors per order are caught and logged; they never crash the poller.
 */

import https from "node:https";
import { elizaLogger } from "@elizaos/core";
import { buildQueryString } from "@binance/common";
import { signJwt, signHmacSha256Hex } from "../exchanges/auth";
import { toVenueSymbol } from "../exchanges/symbolFormatAdapter";
import { signedMarginQueryOrder } from "../exchanges/services/binanceMargin";
import type { ResolvedExchangeCredentials } from "../types";
import type {
    LedgerOperations,
    PendingOrderLedgerRow,
    PendingOrderState,
    PendingOrderStateTransition,
} from "./types";
import type { OnTransitionCallback, StopFn } from "./binanceUserDataStream";

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

/**
 * F5 — per-user credential resolver. The poller no longer holds a flat
 * `credentials[]` array — that array was empty at service-construction
 * time and never refreshed when users saved CEX keys, which is why the
 * production log spammed `No credentials found for venue=binance` every
 * 5 s. Now the poller calls `resolveCredentials(userId, venue)` for each
 * stale row at poll time and uses the latest persisted creds.
 *
 * Return `null` when no creds are available; the poller will increment
 * a per-user `unresolvedStreak` counter and trigger an auto-downgrade
 * after `unresolvedStreakDowngradeAfter` consecutive misses.
 */
export type ResolveCredentialsFn = (
    userId: string,
    venue: string,
) => Promise<ResolvedExchangeCredentials | null>;

export interface FallbackPollerConfig {
    ledger: LedgerOperations;
    /**
     * F5 — preferred path: per-(userId, venue) resolver invoked at poll
     * time. Mutually exclusive with the legacy `credentials` array; if
     * both are provided, `resolveCredentials` wins.
     */
    resolveCredentials?: ResolveCredentialsFn;
    /**
     * Legacy: one entry per exchange. Kept for backward compatibility
     * with existing tests; prefer `resolveCredentials` in production.
     */
    credentials?: ResolvedExchangeCredentials[];
    onTransition: OnTransitionCallback;
    /**
     * F5 — auto-downgrade hook. Invoked when a (userId, venue) has had
     * `unresolvedStreakDowngradeAfter` consecutive unresolved poll
     * attempts. Implementations should set a read-only lock on the
     * user's trading preferences so subsequent live writes are blocked
     * until the user fixes their creds.
     */
    onUnresolvedDowngrade?: (args: {
        userId: string;
        venue: string;
        streak: number;
    }) => void | Promise<void>;
    /** How often to poll for stale orders. Default: 5_000 ms. */
    pollIntervalMs?: number;
    /** How long an order must be in "submitted" state before it is considered stale. Default: 5_000 ms. */
    staleThresholdMs?: number;
    /**
     * F5 — number of consecutive unresolved cred fetches before the
     * downgrade fires. Default 60 (≈ 5 min at 5 s tick). Configurable
     * via env `RECONCILIATION_UNRESOLVED_DOWNGRADE_AFTER` (poll attempts,
     * not seconds).
     */
    unresolvedStreakDowngradeAfter?: number;
}

export type { OnTransitionCallback, StopFn };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_PREFIX = "[ReconciliationFallback]";

// Tick frequency for the poller. With the adaptive ladder, the first REST
// probe fires at ~5 s of order age, so a 5 s tick is the floor that lets
// the schedule run on time. Healthy orders (acked promptly) don't generate
// any REST traffic from the poller — only ones still in `submitted`.
const DEFAULT_POLL_INTERVAL_MS = 5_000;
// Floor age before any per-order REST query is considered. The adaptive
// ladder picks the actual threshold per order from this minimum upward.
const DEFAULT_STALE_THRESHOLD_MS = 5_000;

/**
 * Adaptive backoff schedule for per-order REST retries (milliseconds since
 * the order was submitted). The poll cycle ticks every `pollIntervalMs`, but
 * each individual order is only re-queried when its age has crossed one of
 * these thresholds — so the first REST probe fires within ~5 s of submit,
 * and the cadence decays smoothly to the legacy 60 s ceiling.
 *
 * Rationale: a dropped WS message leaves the system blind for whatever
 * window the poller imposes. With the old 60 s static threshold, a missed
 * fill stayed unobserved for ~90 s on average (60 s stale gate + 30 s tick
 * jitter). With this ramp, p50 detection drops to ~7 s while keeping the
 * REST call rate bounded for healthy orders (one probe at 5 s, then nothing
 * for another 10 s, etc.).
 *
 * Sequence: 5 s → 15 s → 30 s → 60 s (then steady at 60 s).
 */
const ADAPTIVE_AGE_LADDER_MS: readonly number[] = [
    5_000,
    15_000,
    30_000,
    60_000,
] as const;

const BINANCE_BASE_URL = process.env.BINANCE_BASE_URL?.trim() || "https://api.binance.com";
const COINBASE_BASE_URL =
    process.env.COINBASE_BASE_URL?.trim() || "https://api.coinbase.com";

const DEFAULT_RECV_WINDOW_MS = 10_000;

// ---------------------------------------------------------------------------
// Status maps
// ---------------------------------------------------------------------------

/** Binance REST status field → PendingOrderState */
const BINANCE_STATUS_MAP: Record<string, PendingOrderState> = {
    NEW: "acked",
    PARTIALLY_FILLED: "partially_filled",
    FILLED: "filled",
    CANCELED: "cancelled",
    EXPIRED: "expired",
    REJECTED: "rejected",
};

/** Coinbase REST status field → PendingOrderState */
const COINBASE_STATUS_MAP: Record<string, PendingOrderState> = {
    OPEN: "acked",
    PENDING: "acked",
    FILLED: "filled",
    CANCELLED: "cancelled",
    EXPIRED: "expired",
    FAILED: "rejected",
};

// ---------------------------------------------------------------------------
// Low-level HTTPS helper (plain node:https — no extra deps)
// ---------------------------------------------------------------------------

interface HttpsResponse {
    statusCode: number;
    body: string;
}

function httpsGet(url: string, headers: Record<string, string>): Promise<HttpsResponse> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const options: https.RequestOptions = {
            hostname: parsed.hostname,
            port: parsed.port ? Number(parsed.port) : 443,
            path: parsed.pathname + parsed.search,
            method: "GET",
            headers,
        };
        const req = https.request(options, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () =>
                resolve({
                    statusCode: res.statusCode ?? 0,
                    body: Buffer.concat(chunks).toString("utf8"),
                }),
            );
            res.on("error", reject);
        });
        req.on("error", reject);
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Credential helpers
// ---------------------------------------------------------------------------

function requireAuth(cred: ResolvedExchangeCredentials, key: string): string {
    const value = cred.auth?.[key];
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(
            `${LOG_PREFIX} Missing required auth field "${key}" for exchange=${cred.exchange}`,
        );
    }
    return value.trim();
}

function findCredentials(
    credentials: ResolvedExchangeCredentials[],
    venue: string,
): ResolvedExchangeCredentials | undefined {
    return credentials.find(
        (c) => c.exchange.toLowerCase() === venue.toLowerCase(),
    );
}

// ---------------------------------------------------------------------------
// Binance REST order query
// ---------------------------------------------------------------------------

/**
 * Query Binance for a stale order. Dispatches between spot
 * (`/api/v3/order`) and margin (`/sapi/v1/margin/order`) based on the
 * ledger row's `margin_type` (set by the handler at submit time per
 * B2). Returns null if the order is unknown to the venue or its status
 * doesn't map to a state we track.
 */
async function queryBinanceOrder(
    order: PendingOrderLedgerRow,
    cred: ResolvedExchangeCredentials,
): Promise<PendingOrderState | null> {
    // H4 — exchange registry seeds Binance auth fields as `apiKeyName` /
    // `apiKeySecret` (see `adapter-sqlite/src/index.ts` seedExchangeRegistry).
    // The venue order POST path (`exchanges/services/binance.ts`) reads
    // those same names; this resolver had drifted to `apiKey` / `apiSecret`
    // and was throwing `Missing required auth field "apiKey"` on every
    // signed REST poll → the fallback poller stayed in fail-closed,
    // downgrade fired after 60 misses, and reconciliation was effectively
    // dark. Mirror the venue-POST names.
    const apiKey = requireAuth(cred, "apiKeyName");
    const apiSecret = requireAuth(cred, "apiKeySecret");

    // H4 — Binance REST takes the symbol WITHOUT the dash ("BTCUSDT").
    const binanceSymbol = toVenueSymbol(order.symbol, "binance");

    // B2 — margin dispatch. When the ledger row carries `margin_type`,
    // the order lives at `/sapi/v1/margin/order`; querying the spot
    // endpoint returns `-2013 "Order does not exist"` and the row stays
    // stuck in its initial state forever. Single-line dispatch via the
    // dedicated helper.
    let parsed: { status?: string; orderId?: number; origClientOrderId?: string } | null;
    if (order.margin_type === "CROSS" || order.margin_type === "ISOLATED") {
        elizaLogger.info(
            `${LOG_PREFIX} Querying Binance MARGIN REST for stale order client_order_id=${order.client_order_id} symbol=${order.symbol} margin_type=${order.margin_type}`,
        );
        const raw = await signedMarginQueryOrder(apiKey, apiSecret, {
            symbol: binanceSymbol,
            origClientOrderId: order.client_order_id,
            isIsolated: order.margin_type === "ISOLATED" ? "TRUE" : "FALSE",
        });
        if (raw === null) {
            elizaLogger.warn(
                `${LOG_PREFIX} Binance margin order not found client_order_id=${order.client_order_id}`,
            );
            return null;
        }
        parsed = raw as typeof parsed;
    } else {
        const timestamp = Date.now();
        const rawParams: Record<string, unknown> = {
            symbol: binanceSymbol,
            origClientOrderId: order.client_order_id,
            timestamp,
            recvWindow: DEFAULT_RECV_WINDOW_MS,
        };

        const queryString = buildQueryString(rawParams);
        const signature = signHmacSha256Hex(apiSecret, queryString);
        const signedQueryString = `${queryString}&signature=${signature}`;

        const url = `${BINANCE_BASE_URL}/api/v3/order?${signedQueryString}`;

        elizaLogger.info(
            `${LOG_PREFIX} Querying Binance SPOT REST for stale order client_order_id=${order.client_order_id} symbol=${order.symbol}`,
        );

        const res = await httpsGet(url, {
            "X-MBX-APIKEY": apiKey,
            "Content-Type": "application/json",
        });

        if (res.statusCode === 404) {
            elizaLogger.warn(
                `${LOG_PREFIX} Binance 404 for client_order_id=${order.client_order_id}; order not found on exchange`,
            );
            return null;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
            throw new Error(
                `Binance REST returned HTTP ${res.statusCode}: ${res.body}`,
            );
        }

        parsed = JSON.parse(res.body) as typeof parsed;
    }

    const rawStatus = parsed?.status;
    if (!rawStatus) {
        throw new Error(
            `Binance REST response missing 'status' field for ${order.client_order_id}`,
        );
    }

    const mapped = BINANCE_STATUS_MAP[rawStatus];
    if (!mapped) {
        elizaLogger.info(
            `${LOG_PREFIX} Binance status=${rawStatus} for client_order_id=${order.client_order_id} has no mapping; skipping`,
        );
        return null;
    }

    return mapped;
}

// ---------------------------------------------------------------------------
// Coinbase REST order query
// ---------------------------------------------------------------------------

/**
 * Build a JWT suitable for Coinbase Advanced Trade REST requests.
 */
function buildCoinbaseRestJwt(
    apiKeyName: string,
    privateKey: string,
    method: string,
    path: string,
): string {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
        iss: "cdp",
        sub: apiKeyName,
        nbf: nowSeconds,
        exp: nowSeconds + 120,
        uri: `${method} api.coinbase.com${path}`,
    };
    return signJwt({
        privateKey,
        keyId: apiKeyName,
        algorithm: "ES256",
        payload,
    });
}

/**
 * Query Coinbase GET /api/v3/brokerage/orders/historical/<venue_order_id>
 * or GET /api/v3/brokerage/orders/historical/batch?client_order_ids=<id>
 * Returns null if the order is not found or status is unmapped.
 */
async function queryCoinbaseOrder(
    order: PendingOrderLedgerRow,
    cred: ResolvedExchangeCredentials,
): Promise<{ state: PendingOrderState; venueOrderId?: string } | null> {
    const apiKeyName = requireAuth(cred, "apiKeyName");
    const privateKey = requireAuth(cred, "privateKey");

    // Prefer the venue_order_id path if we already have it on the row
    // (the row may have a venue_order_id field stored from a prior partial update).
    const venueOrderId = (order as PendingOrderLedgerRow & { venue_order_id?: string })
        .venue_order_id;

    let path: string;
    let usesBatch: boolean;

    if (venueOrderId) {
        path = `/api/v3/brokerage/orders/historical/${encodeURIComponent(venueOrderId)}`;
        usesBatch = false;
    } else {
        path = `/api/v3/brokerage/orders/historical/batch?client_order_ids=${encodeURIComponent(order.client_order_id)}`;
        usesBatch = true;
    }

    elizaLogger.info(
        `${LOG_PREFIX} Querying Coinbase REST for stale order client_order_id=${order.client_order_id} path=${path}`,
    );

    const jwt = buildCoinbaseRestJwt(apiKeyName, privateKey, "GET", path);
    const url = `${COINBASE_BASE_URL}${path}`;

    const res = await httpsGet(url, {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
    });

    if (res.statusCode === 404) {
        elizaLogger.warn(
            `${LOG_PREFIX} Coinbase 404 for client_order_id=${order.client_order_id}; order not found on exchange`,
        );
        return null;
    }

    if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new Error(
            `Coinbase REST returned HTTP ${res.statusCode}: ${res.body}`,
        );
    }

    const parsed = JSON.parse(res.body) as Record<string, unknown>;

    // Single order response: { order: { ... } }
    // Batch response:        { orders: [...] }
    let rawOrder: Record<string, unknown> | undefined;

    if (!usesBatch) {
        rawOrder = parsed.order as Record<string, unknown> | undefined;
    } else {
        const orders = parsed.orders as Array<Record<string, unknown>> | undefined;
        rawOrder = Array.isArray(orders) ? orders[0] : undefined;
    }

    if (!rawOrder) {
        elizaLogger.info(
            `${LOG_PREFIX} Coinbase returned no order data for client_order_id=${order.client_order_id}`,
        );
        return null;
    }

    const rawStatus = rawOrder.status as string | undefined;
    if (!rawStatus) {
        throw new Error(
            `Coinbase REST response missing 'status' field: ${res.body}`,
        );
    }

    const mapped = COINBASE_STATUS_MAP[rawStatus];
    if (!mapped) {
        elizaLogger.info(
            `${LOG_PREFIX} Coinbase status=${rawStatus} for client_order_id=${order.client_order_id} has no mapping; skipping`,
        );
        return null;
    }

    const discoveredVenueOrderId = (rawOrder.order_id as string | undefined) ?? venueOrderId;

    return { state: mapped, venueOrderId: discoveredVenueOrderId };
}

// ---------------------------------------------------------------------------
// Per-order fallback logic
// ---------------------------------------------------------------------------

async function processStaleOrder(
    order: PendingOrderLedgerRow,
    resolveCred: (userId: string, venue: string) => Promise<ResolvedExchangeCredentials | null>,
    ledger: LedgerOperations,
    onTransition: OnTransitionCallback,
    unresolvedStreaks: Map<string, number>,
    onUnresolvedDowngrade: ((args: { userId: string; venue: string; streak: number }) => void | Promise<void>) | undefined,
    downgradeAfter: number,
): Promise<void> {
    // F5 — per-(userId, venue) lookup via the resolver. The streak key
    // is the same composite so two users with different cred states are
    // independently tracked.
    const streakKey = `${order.userId}:${order.venue.toLowerCase()}`;
    let cred: ResolvedExchangeCredentials | null = null;
    try {
        cred = await resolveCred(order.userId, order.venue);
    } catch (err) {
        elizaLogger.warn(
            `${LOG_PREFIX} resolveCredentials threw for user=${order.userId} venue=${order.venue}: ${String(err)}`,
        );
    }
    if (!cred) {
        const streak = (unresolvedStreaks.get(streakKey) ?? 0) + 1;
        unresolvedStreaks.set(streakKey, streak);
        if (streak === 1 || streak % 10 === 0) {
            elizaLogger.warn(
                `${LOG_PREFIX} No credentials resolvable for user=${order.userId} venue=${order.venue}; streak=${streak}; client_order_id=${order.client_order_id}`,
            );
        }
        if (streak === downgradeAfter && typeof onUnresolvedDowngrade === "function") {
            try {
                const r = onUnresolvedDowngrade({
                    userId: order.userId,
                    venue: order.venue,
                    streak,
                });
                if (r instanceof Promise) await r;
            } catch (err) {
                elizaLogger.error(
                    `${LOG_PREFIX} onUnresolvedDowngrade threw: ${String(err)}`,
                );
            }
        }
        return;
    }
    // Successful resolve — reset the streak.
    if (unresolvedStreaks.has(streakKey)) {
        unresolvedStreaks.delete(streakKey);
    }

    let newState: PendingOrderState | null = null;
    let venueOrderId: string | undefined;
    let restPayload: unknown;

    try {
        const venue = order.venue.toLowerCase();

        if (venue === "binance") {
            newState = await queryBinanceOrder(order, cred);
            restPayload = { venue: "binance", client_order_id: order.client_order_id, state: newState };
        } else if (venue === "coinbase") {
            const result = await queryCoinbaseOrder(order, cred);
            if (result) {
                newState = result.state;
                venueOrderId = result.venueOrderId;
            }
            restPayload = { venue: "coinbase", client_order_id: order.client_order_id, state: newState };
        } else {
            elizaLogger.warn(
                `${LOG_PREFIX} Unsupported venue="${order.venue}" for REST fallback; skipping client_order_id=${order.client_order_id}`,
            );
            return;
        }
    } catch (err) {
        elizaLogger.error(
            `${LOG_PREFIX} REST query failed for client_order_id=${order.client_order_id} venue=${order.venue}: ${String(err)}`,
        );
        return;
    }

    if (!newState) {
        // Status unknown or unmapped — nothing to transition
        return;
    }

    elizaLogger.info(
        `${LOG_PREFIX} REST fallback firing transition for client_order_id=${order.client_order_id} venue=${order.venue} → ${newState}`,
    );

    const transition: PendingOrderStateTransition = {
        client_order_id: order.client_order_id,
        new_state: newState,
        venue_order_id: venueOrderId,
        payload: restPayload,
        source: "rest_fallback",
    };

    // Attempt to update state in the ledger. If null is returned, the order
    // was already in a terminal state — move on.
    let updatedRow: PendingOrderLedgerRow | null = null;
    try {
        updatedRow = await ledger.updateOrderState(transition);
    } catch (err) {
        elizaLogger.error(
            `${LOG_PREFIX} updateOrderState failed for client_order_id=${order.client_order_id}: ${String(err)}`,
        );
        return;
    }

    if (updatedRow === null) {
        elizaLogger.info(
            `${LOG_PREFIX} client_order_id=${order.client_order_id} was already in a terminal state; skipping onTransition`,
        );
        return;
    }

    // Invoke the transition callback; catch any rejection to avoid crashing the poller.
    try {
        const result = onTransition(transition);
        if (result instanceof Promise) {
            await result;
        }
    } catch (err) {
        elizaLogger.error(
            `${LOG_PREFIX} onTransition callback threw for client_order_id=${order.client_order_id}: ${String(err)}`,
        );
    }
}

// ---------------------------------------------------------------------------
// Poll cycle
// ---------------------------------------------------------------------------

function thresholdForAttempt(attempt: number): number {
    const last = ADAPTIVE_AGE_LADDER_MS.length - 1;
    return ADAPTIVE_AGE_LADDER_MS[Math.min(Math.max(attempt, 0), last)];
}

async function runPollCycle(
    ledger: LedgerOperations,
    resolveCred: (userId: string, venue: string) => Promise<ResolvedExchangeCredentials | null>,
    staleThresholdMs: number,
    onTransition: OnTransitionCallback,
    attempts: Map<string, number>,
    unresolvedStreaks: Map<string, number>,
    onUnresolvedDowngrade: ((args: { userId: string; venue: string; streak: number }) => void | Promise<void>) | undefined,
    downgradeAfter: number,
): Promise<void> {
    let staleOrders: PendingOrderLedgerRow[];
    try {
        staleOrders = await ledger.getAllStaleSubmittedOrders(staleThresholdMs);
    } catch (err) {
        elizaLogger.error(
            `${LOG_PREFIX} Failed to query stale submitted orders: ${String(err)}`,
        );
        return;
    }

    if (staleOrders.length === 0) {
        return;
    }

    const now = Date.now();
    const due: PendingOrderLedgerRow[] = [];
    const seen = new Set<string>();

    for (const order of staleOrders) {
        seen.add(order.client_order_id);
        const attempt = attempts.get(order.client_order_id) ?? 0;
        const gate = thresholdForAttempt(attempt);
        const age = now - new Date(order.submittedAt).getTime();
        if (age >= gate) {
            due.push(order);
            attempts.set(order.client_order_id, attempt + 1);
        }
    }

    // Drop attempt counters for orders that are no longer in the stale set
    // (terminal state reached, or expired off the ledger). Prevents unbounded
    // growth of the in-memory map for long-running services.
    for (const key of Array.from(attempts.keys())) {
        if (!seen.has(key)) attempts.delete(key);
    }

    if (due.length === 0) {
        return;
    }

    elizaLogger.info(
        `${LOG_PREFIX} Poll found ${staleOrders.length} stale, ${due.length} due for REST probe (adaptive ladder)`,
    );

    // Process each due order independently — one failure must not abort others.
    for (const order of due) {
        await processStaleOrder(
            order,
            resolveCred,
            ledger,
            onTransition,
            unresolvedStreaks,
            onUnresolvedDowngrade,
            downgradeAfter,
        );
    }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Start the reconciliation fallback poller.
 *
 * Returns a `StopFn` that cancels the interval and stops all future polls.
 */
export function createReconciliationFallback(config: FallbackPollerConfig): StopFn {
    const {
        ledger,
        credentials,
        resolveCredentials,
        onTransition,
        onUnresolvedDowngrade,
        pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
        staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS,
        unresolvedStreakDowngradeAfter = Number.parseInt(
            process.env.RECONCILIATION_UNRESOLVED_DOWNGRADE_AFTER ?? "",
            10,
        ) || 60,
    } = config;

    // F5 — build a unified resolver. Prefer the explicit per-(userId,venue)
    // callback; fall back to the legacy array lookup for backward-compat
    // with existing tests.
    const resolveCred = async (
        userId: string,
        venue: string,
    ): Promise<ResolvedExchangeCredentials | null> => {
        if (typeof resolveCredentials === "function") {
            return resolveCredentials(userId, venue);
        }
        if (Array.isArray(credentials) && credentials.length > 0) {
            return findCredentials(credentials, venue) ?? null;
        }
        return null;
    };

    elizaLogger.info(
        `${LOG_PREFIX} Starting fallback poller pollIntervalMs=${pollIntervalMs} staleThresholdMs=${staleThresholdMs} adaptiveLadderMs=${ADAPTIVE_AGE_LADDER_MS.join(",")} resolverMode=${typeof resolveCredentials === "function" ? "per_user" : "static_array"} downgradeAfter=${unresolvedStreakDowngradeAfter}`,
    );

    // Per-order attempt counter drives the adaptive ladder. Lives in this
    // closure (not module-global) so each ReconciliationService instance
    // tracks its own orders.
    const attempts = new Map<string, number>();
    // F5 — per-(userId, venue) consecutive-unresolved counter. Triggers
    // the auto-downgrade at `unresolvedStreakDowngradeAfter` poll cycles.
    const unresolvedStreaks = new Map<string, number>();

    const timer = setInterval(() => {
        runPollCycle(
            ledger,
            resolveCred,
            staleThresholdMs,
            onTransition,
            attempts,
            unresolvedStreaks,
            onUnresolvedDowngrade,
            unresolvedStreakDowngradeAfter,
        ).catch((err) => {
            elizaLogger.error(
                `${LOG_PREFIX} Unexpected error in poll cycle: ${String(err)}`,
            );
        });
    }, pollIntervalMs);

    // Don't block process exit.
    timer.unref();

    return () => {
        elizaLogger.info(`${LOG_PREFIX} Stopping fallback poller`);
        clearInterval(timer);
    };
}
