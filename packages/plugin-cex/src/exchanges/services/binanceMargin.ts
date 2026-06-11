/**
 * Binance Margin (Cross / Isolated) order routing — F9.
 *
 * The Binance Margin API lives on `/sapi/v1/margin/order` and is a
 * separate endpoint family from spot (`/api/v3/order`). The official
 * `@binance/spot` SDK does not expose typed margin endpoints; we ship
 * a thin signed-POST helper analogous to `signedSpotOrderPost` that
 * targets the margin endpoint.
 *
 * For CROSS margin: `isIsolated="FALSE"` (default).
 * For ISOLATED margin: `isIsolated="TRUE"`, and the user must already
 * have an isolated margin account opened for the symbol — we precheck
 * via `GET /sapi/v1/margin/isolated/account?symbols=…` before submit.
 *
 * Paper/shadow modes still route through the PaperVenueExchangeService
 * (F3); margin metadata is preserved on the paper-order record via
 * `buildSimulatedMarginOrderResponse`.
 */

import { buildQueryString } from "@binance/common";
import { elizaLogger, formatAxiosErrorLine } from "@elizaos/core";
import { signHmacSha256Hex } from "../auth";
import type { CreateOrderParams, MarginAction } from "../../types";

const BINANCE_BASE_URL =
    process.env.BINANCE_BASE_URL?.trim() || "https://api.binance.com";

const DEFAULT_RECV_WINDOW_MS = 10_000;
const REST_TIMEOUT_MS = 15_000;

export type BinanceMarginSideEffect =
    | "NO_SIDE_EFFECT"
    | "MARGIN_BUY"
    | "AUTO_REPAY";

/**
 * Maps the canonical `margin_action` enum to Binance's
 * `sideEffectType` parameter on `/sapi/v1/margin/order`.
 *
 * - `NORMAL`       -> `NO_SIDE_EFFECT`
 * - `AUTO_BORROW`  -> `MARGIN_BUY`     (auto-borrow up to leverage)
 * - `AUTO_REPAY`   -> `AUTO_REPAY`     (repay outstanding margin loan with proceeds)
 */
export function marginActionToSideEffect(
    action: MarginAction | undefined,
): BinanceMarginSideEffect {
    switch (action) {
        case "AUTO_BORROW":
            return "MARGIN_BUY";
        case "AUTO_REPAY":
            return "AUTO_REPAY";
        case "NORMAL":
        case undefined:
            return "NO_SIDE_EFFECT";
        default:
            return "NO_SIDE_EFFECT";
    }
}

/**
 * Throws a single, well-formatted error explaining that live margin
 * trading is not wired yet. Callers should invoke this from the
 * `BinanceOrdersService.createOrder` early-return path so the error
 * message is consistent across spot vs. margin invocations.
 */
export function throwMarginNotImplemented(params: CreateOrderParams): never {
    const sideEffect = marginActionToSideEffect(params.margin_action);
    throw new Error(
        `Binance ${params.margin_type ?? ""} margin trading is not yet wired in this build. ` +
            `Requested margin_action=${params.margin_action ?? "NORMAL"} ` +
            `(maps to Binance sideEffectType=${sideEffect}). ` +
            "The canonical schema accepts margin_type/leverage/margin_action so paper and shadow " +
            "modes can exercise the path; live execution requires the /sapi/v1/margin/order " +
            "endpoint to be integrated. Please use Spot for now (omit margin_type).",
    );
}

/**
 * Stubbed simulated response shape for paper/shadow modes. The
 * canonical executor consumes the same envelope the live spot path
 * returns, so margin paper-trades stay observable in the order ledger.
 */
export interface SimulatedMarginOrderResponse {
    symbol: string;
    side: "BUY" | "SELL";
    margin_type: "CROSS" | "ISOLATED";
    margin_action: MarginAction;
    side_effect_type: BinanceMarginSideEffect;
    /** Echoed for downstream reconciliation. */
    client_order_id: string;
    /** Marker so paper-mode reconcilers can filter cleanly. */
    simulated: true;
}

export function buildSimulatedMarginOrderResponse(
    params: CreateOrderParams,
): SimulatedMarginOrderResponse {
    if (!params.margin_type) {
        throw new Error("buildSimulatedMarginOrderResponse called without margin_type");
    }
    return {
        symbol: params.product_id,
        side: params.side,
        margin_type: params.margin_type,
        margin_action: params.margin_action ?? "NORMAL",
        side_effect_type: marginActionToSideEffect(params.margin_action),
        client_order_id: params.client_order_id,
        simulated: true,
    };
}

/**
 * F9 — signed POST to `/sapi/v1/margin/order`. Mirrors `signedSpotOrderPost`
 * shape so call sites are symmetric. Adds the margin-specific wire fields:
 *  - `isIsolated`: "TRUE" / "FALSE"
 *  - `sideEffectType`: NO_SIDE_EFFECT / MARGIN_BUY / AUTO_REPAY
 *
 * The caller is responsible for having already mapped order_configuration
 * to the Binance body shape (`symbol`, `side`, `type`, `quantity`, `price`,
 * `timeInForce`, etc.). This helper signs + sends only.
 */
export async function signedMarginOrderPost(
    apiKey: string,
    apiSecret: string,
    params: Record<string, string | number | boolean | undefined>,
): Promise<unknown> {
    const timestamp = Date.now();
    const queryParams: Record<string, unknown> = {
        ...params,
        timestamp,
        recvWindow: DEFAULT_RECV_WINDOW_MS,
    };
    // Strip undefined keys so the signature is stable.
    for (const k of Object.keys(queryParams)) {
        if (queryParams[k] === undefined) delete queryParams[k];
    }
    const signature = signHmacSha256Hex(
        apiSecret,
        buildQueryString(queryParams as Record<string, string | number | boolean>),
    );
    const query = buildQueryString({ ...queryParams, signature } as Record<
        string,
        string | number | boolean
    >);
    const url = `${BINANCE_BASE_URL}/sapi/v1/margin/order?${query}`;

    elizaLogger.debug(
        `[plugin-cex Binance] signedMarginOrderPost POST /sapi/v1/margin/order symbol=${String(params.symbol ?? "")} isIsolated=${String(params.isIsolated ?? "FALSE")} sideEffectType=${String(params.sideEffectType ?? "NO_SIDE_EFFECT")}`,
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
    try {
        const resp = await fetch(url, {
            method: "POST",
            headers: {
                "X-MBX-APIKEY": apiKey,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            signal: controller.signal,
        });
        const text = await resp.text();
        if (!resp.ok) {
            throw new Error(
                `[binance-margin] ${resp.status} ${resp.statusText}: ${text.slice(0, 400)}`,
            );
        }
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    } finally {
        clearTimeout(timer);
    }
}

/**
 * F9 — precheck for ISOLATED margin: confirm the user has an isolated
 * account opened for the symbol. Without this Binance returns a cryptic
 * 4xx that the chat surfaces unfiltered.
 *
 * Returns true if the symbol has an opened isolated account, false
 * otherwise. Best-effort: network errors fall through as `true` so the
 * actual order submit produces the more meaningful error.
 */
export async function precheckIsolatedAccountOpened(
    apiKey: string,
    apiSecret: string,
    symbol: string,
): Promise<boolean> {
    try {
        const timestamp = Date.now();
        const params: Record<string, unknown> = {
            symbols: symbol,
            timestamp,
            recvWindow: DEFAULT_RECV_WINDOW_MS,
        };
        const signature = signHmacSha256Hex(
            apiSecret,
            buildQueryString(params as Record<string, string | number | boolean>),
        );
        const query = buildQueryString({ ...params, signature } as Record<
            string,
            string | number | boolean
        >);
        const url = `${BINANCE_BASE_URL}/sapi/v1/margin/isolated/account?${query}`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
        try {
            const resp = await fetch(url, {
                method: "GET",
                headers: { "X-MBX-APIKEY": apiKey },
                signal: controller.signal,
            });
            if (!resp.ok) return true; // fall through to the real submit error
            const body = (await resp.json()) as { assets?: Array<{ symbol: string }> };
            if (!Array.isArray(body?.assets)) return true;
            return body.assets.some(
                (a) => String(a.symbol ?? "").toUpperCase() === symbol.toUpperCase(),
            );
        } finally {
            clearTimeout(timer);
        }
    } catch {
        return true;
    }
}

/**
 * Fix 1 f/u — shared signed-GET helper for `/sapi/v1/...` endpoints.
 *
 * Why this exists:
 *  - Both `signedMarginGet` (cross) and `signedIsolatedMarginGet`
 *    (isolated) were ~90% identical and threw raw, unbounded error
 *    bodies that risked echoing the request `signature` if Binance
 *    ever included query state in the response.
 *  - Centralizing the path lets us wrap external-API errors with
 *    `formatAxiosErrorLine` at the FETCH boundary (per CLAUDE.md
 *    style convention), so callers always see a clean, bounded,
 *    sanitized message.
 *
 * Error contract:
 *  - 2xx → parsed JSON (or raw text fallback for non-JSON responses).
 *  - non-2xx → throws Error whose message is built by
 *    `formatAxiosErrorLine` against a minimal axios-shaped object.
 *    The response data is restricted to the parsed `{code, msg}`
 *    Binance envelope if present, never the raw text. Body slice
 *    cap: ≤200 chars.
 *  - The request `signature` is NEVER included in the thrown error
 *    even if Binance echoes it: we feed `formatAxiosErrorLine` only
 *    `{code, msg}`, not the raw body. (Belt-and-suspenders: we also
 *    avoid including the URL because it carries `signature=`.)
 */
async function signedSapiGet(
    apiKey: string,
    apiSecret: string,
    path: string,
    params: Record<string, unknown> = {},
): Promise<unknown> {
    const timestamp = Date.now();
    const queryParams: Record<string, unknown> = {
        ...params,
        timestamp,
        recvWindow: DEFAULT_RECV_WINDOW_MS,
    };
    // Strip undefined keys so the signature is stable.
    for (const k of Object.keys(queryParams)) {
        if (queryParams[k] === undefined) delete queryParams[k];
    }
    const signature = signHmacSha256Hex(
        apiSecret,
        buildQueryString(queryParams as Record<string, string | number | boolean>),
    );
    const query = buildQueryString({ ...queryParams, signature } as Record<
        string,
        string | number | boolean
    >);
    const url = `${BINANCE_BASE_URL}${path}?${query}`;

    elizaLogger.debug(`[plugin-cex Binance] signedSapiGet GET ${path}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
    try {
        const resp = await fetch(url, {
            method: "GET",
            headers: { "X-MBX-APIKEY": apiKey },
            signal: controller.signal,
        });
        const text = await resp.text();
        if (!resp.ok) {
            // Try to parse the Binance error envelope. The standard
            // shape is { code, msg }. We deliberately project ONLY
            // those two fields into the data we pass to the
            // formatter so any echoed `signature` (or other large
            // fields) can't sneak into the thrown message. We also
            // alias `msg` → `message` because `summarizeAxiosError`
            // reads `.message` / `.error` / `.detail` from `data` to
            // populate `apiMessage`.
            let projected: { code?: unknown; message?: string } | undefined;
            try {
                const parsed = JSON.parse(text) as Record<string, unknown>;
                const msgRaw =
                    typeof parsed?.msg === "string"
                        ? parsed.msg
                        : typeof parsed?.message === "string"
                          ? (parsed.message as string)
                          : undefined;
                projected = {
                    code: parsed?.code,
                    message: msgRaw ? msgRaw.slice(0, 200) : undefined,
                };
            } catch {
                // Non-JSON body — surface a short text slice via the
                // standard `message` field so the formatter still has
                // something useful to print.
                projected = { message: text.slice(0, 200) };
            }
            // Build a minimal axios-shaped object so `formatAxiosErrorLine`
            // emits its standard `status=… api="…"` shape. We DO NOT
            // include `config.url` because the URL carries `signature=…`.
            const minimalAxiosErr = {
                message: `[binance-margin] ${resp.status} ${resp.statusText}`,
                response: {
                    status: resp.status,
                    statusText: resp.statusText,
                    data: projected,
                },
            };
            throw new Error(formatAxiosErrorLine(minimalAxiosErr));
        }
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Fix 1 — signed GET against `/sapi/v1/margin/account` (cross-margin
 * account snapshot). Used by `BinanceAccountsService.getBalance` to
 * surface cross-margin borrow/interest/net positions alongside spot
 * and funding. Returns the raw parsed body on 2xx; throws on non-2xx
 * so the caller's `Promise.allSettled` can record the wallet as
 * skipped + log the permission-denied reason.
 */
export async function signedMarginGet(
    apiKey: string,
    apiSecret: string,
): Promise<unknown> {
    return signedSapiGet(apiKey, apiSecret, "/sapi/v1/margin/account");
}

/**
 * Fix 1 — signed GET against `/sapi/v1/margin/isolated/account` (full
 * isolated-margin account list). Differs from `precheckIsolatedAccountOpened`
 * (which queries a single symbol) by enumerating every opened isolated
 * pair. Returns the raw parsed body on 2xx; throws on non-2xx.
 */
export async function signedIsolatedMarginGet(
    apiKey: string,
    apiSecret: string,
): Promise<unknown> {
    return signedSapiGet(apiKey, apiSecret, "/sapi/v1/margin/isolated/account");
}

/**
 * B4 — signed GET against `/sapi/v1/margin/openOrders`. Mirrors the
 * spot openOrders flow used by `BinanceOrdersService.getOrders` so the
 * caller can route based on whether `margin_type` is present in the
 * action params. `isIsolated` is "TRUE" / "FALSE" per Binance docs.
 *
 * Returns the raw orders array (or empty on auth/empty response).
 */
export async function signedMarginOpenOrders(
    apiKey: string,
    apiSecret: string,
    opts: { symbol?: string; isIsolated?: "TRUE" | "FALSE" },
): Promise<unknown[]> {
    const timestamp = Date.now();
    const queryParams: Record<string, unknown> = {
        timestamp,
        recvWindow: DEFAULT_RECV_WINDOW_MS,
        ...(opts.symbol ? { symbol: opts.symbol } : {}),
        ...(opts.isIsolated ? { isIsolated: opts.isIsolated } : {}),
    };
    const signature = signHmacSha256Hex(
        apiSecret,
        buildQueryString(queryParams as Record<string, string | number | boolean>),
    );
    const query = buildQueryString({ ...queryParams, signature } as Record<
        string,
        string | number | boolean
    >);
    const url = `${BINANCE_BASE_URL}/sapi/v1/margin/openOrders?${query}`;

    elizaLogger.debug(
        `[plugin-cex Binance] signedMarginOpenOrders GET /sapi/v1/margin/openOrders symbol=${String(opts.symbol ?? "*")} isIsolated=${String(opts.isIsolated ?? "FALSE")}`,
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
    try {
        const resp = await fetch(url, {
            method: "GET",
            headers: { "X-MBX-APIKEY": apiKey },
            signal: controller.signal,
        });
        const text = await resp.text();
        if (!resp.ok) {
            throw new Error(
                `[binance-margin] ${resp.status} ${resp.statusText}: ${text.slice(0, 400)}`,
            );
        }
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : [];
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Fix 4 — signed GET against `/sapi/v1/margin/allOrders`. Mirrors the
 * spot `/api/v3/allOrders` query path used by `BinanceOrdersService.getOrders`
 * (date window + optional `limit`), so the margin fan-out path can
 * coalesce historical orders across the user's held assets.
 *
 * `startTime` / `endTime` are accepted as millisecond timestamps and
 * forwarded directly. Returns the raw orders array (`[]` for empty / non-
 * array bodies). Throws on non-2xx so the caller's `Promise.allSettled`
 * can record per-symbol failures and skip them.
 */
export async function signedMarginAllOrders(
    apiKey: string,
    apiSecret: string,
    opts: {
        symbol: string;
        startTime?: number;
        endTime?: number;
        limit?: number;
        isIsolated?: "TRUE" | "FALSE";
    },
): Promise<unknown[]> {
    const params: Record<string, unknown> = {
        symbol: opts.symbol,
        ...(opts.startTime !== undefined ? { startTime: opts.startTime } : {}),
        ...(opts.endTime !== undefined ? { endTime: opts.endTime } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.isIsolated ? { isIsolated: opts.isIsolated } : {}),
    };
    const result = await signedSapiGet(apiKey, apiSecret, "/sapi/v1/margin/allOrders", params);
    return Array.isArray(result) ? result : [];
}

/**
 * B2 — signed GET against `/sapi/v1/margin/order` (margin order
 * status). Mirrors the spot `/api/v3/order` query path. Used by the
 * reconciliation poller to resolve margin orders that the spot
 * endpoint returns -2013 for.
 *
 * Returns:
 *  - the parsed body when the order exists
 *  - `null` when Binance returns 404 / -2013 ("Order does not exist.")
 *
 * Throws for other non-2xx responses so the caller can retry.
 */
export async function signedMarginQueryOrder(
    apiKey: string,
    apiSecret: string,
    opts: {
        symbol: string;
        origClientOrderId: string;
        isIsolated?: "TRUE" | "FALSE";
    },
): Promise<unknown | null> {
    const timestamp = Date.now();
    const queryParams: Record<string, unknown> = {
        symbol: opts.symbol,
        origClientOrderId: opts.origClientOrderId,
        ...(opts.isIsolated ? { isIsolated: opts.isIsolated } : {}),
        timestamp,
        recvWindow: DEFAULT_RECV_WINDOW_MS,
    };
    const signature = signHmacSha256Hex(
        apiSecret,
        buildQueryString(queryParams as Record<string, string | number | boolean>),
    );
    const query = buildQueryString({ ...queryParams, signature } as Record<
        string,
        string | number | boolean
    >);
    const url = `${BINANCE_BASE_URL}/sapi/v1/margin/order?${query}`;

    elizaLogger.debug(
        `[plugin-cex Binance] signedMarginQueryOrder GET /sapi/v1/margin/order symbol=${opts.symbol} clientOrderId=${opts.origClientOrderId} isIsolated=${String(opts.isIsolated ?? "FALSE")}`,
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
    try {
        const resp = await fetch(url, {
            method: "GET",
            headers: { "X-MBX-APIKEY": apiKey },
            signal: controller.signal,
        });
        if (resp.status === 404) return null;
        const text = await resp.text();
        if (!resp.ok) {
            // Binance returns -2013 "Order does not exist" for unknown
            // clientOrderId — treat as "not found" so reconciliation can
            // legitimately mark the row as rejected/missing instead of
            // throwing every poll.
            if (resp.status === 400 && /-2013|order does not exist/i.test(text)) {
                return null;
            }
            throw new Error(
                `[binance-margin] ${resp.status} ${resp.statusText}: ${text.slice(0, 400)}`,
            );
        }
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    } finally {
        clearTimeout(timer);
    }
}

/**
 * F9 — kept as a vestigial helper now that margin IS implemented.
 * Live margin orders still need a real Binance margin account; if the
 * `signedMarginOrderPost` returns an authentication failure or
 * "margin trading not enabled" Binance error, the caller surfaces that
 * via the standardized error contract. This stub is no longer reachable
 * from `BinanceOrdersService.createOrder`.
 *
 * @deprecated kept for type-export compat; remove in the cleanup pass
 *   after F9 has soaked.
 */
export function throwMarginNotImplementedLegacy(params: CreateOrderParams): never {
    const sideEffect = marginActionToSideEffect(params.margin_action);
    throw new Error(
        `Binance ${params.margin_type ?? ""} margin trading is not yet wired in this build. ` +
            `Requested margin_action=${params.margin_action ?? "NORMAL"} ` +
            `(maps to Binance sideEffectType=${sideEffect}).`,
    );
}
