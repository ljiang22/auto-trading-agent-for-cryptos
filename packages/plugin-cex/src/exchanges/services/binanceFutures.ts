/**
 * Binance USDT-M Futures (`/fapi/v*`) signed helpers — Fix 13.
 *
 * Mirrors the shape of `binanceMargin.ts` (signed helper + thin
 * read-only accessors). The futures endpoint family lives on
 * `https://fapi.binance.com` (not `api.binance.com`) so we build a
 * separate `signedFapiGet` rather than reusing `signedSapiGet`.
 *
 * Error contract mirrors `binanceMargin.signedSapiGet`:
 *  - 2xx → parsed JSON (or raw text fallback for non-JSON responses).
 *  - non-2xx → throws Error whose message is built by
 *    `formatAxiosErrorLine` against a minimal axios-shaped object so
 *    the thrown message NEVER includes the request `signature`.
 *  - The Binance error envelope is projected to `{code, message}` only;
 *    the raw body is restricted to ≤200 chars.
 *
 * Why it's a separate file:
 *  - The futures account permission is independent of margin/spot. A
 *    user with margin-enabled keys frequently does NOT have futures
 *    enabled, in which case `/fapi/v2/positionRisk` returns
 *    401/403 / -2015. Callers (`get_positions`, `get_pnl`) treat that
 *    as a soft skip — same pattern as `getBalance` does for margin.
 */

import { buildQueryString } from "@binance/common";
import { elizaLogger, formatAxiosErrorLine } from "@elizaos/core";
import { signHmacSha256Hex } from "../auth";

const BINANCE_FUTURES_BASE_URL =
    process.env.BINANCE_FUTURES_BASE_URL?.trim() || "https://fapi.binance.com";

const DEFAULT_RECV_WINDOW_MS = 10_000;
const REST_TIMEOUT_MS = 15_000;

/**
 * Signed GET helper for the Binance USDT-M Futures endpoint family
 * (`/fapi/v1/*`, `/fapi/v2/*`). Identical signing semantics to
 * `signedSapiGet` — HMAC-SHA256 of `<queryString>&timestamp=<ms>`,
 * appended as `&signature=...` — but targets `fapi.binance.com`.
 */
async function signedFapiGet(
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
    const url = `${BINANCE_FUTURES_BASE_URL}${path}?${query}`;

    elizaLogger.debug(`[plugin-cex Binance] signedFapiGet GET ${path}`);

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
            // Project ONLY {code, msg} → {code, message} so the thrown
            // message can't echo a `signature=...` query param even if
            // Binance ever included one in the response body.
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
                projected = { message: text.slice(0, 200) };
            }
            const minimalAxiosErr = {
                message: `[binance-futures] ${resp.status} ${resp.statusText}`,
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
 * Fix 13 — `GET /fapi/v2/positionRisk`. Returns one row per symbol
 * configured on the account (including symbols with `positionAmt=0`).
 * Callers must filter `|positionAmt| < 1e-9` to get only OPEN
 * positions — Binance returns the full universe.
 *
 * Row shape (relevant fields):
 *   {
 *     symbol: "BTCUSDT",
 *     positionAmt: "-0.001",        // signed; <0 = SHORT, >0 = LONG
 *     entryPrice: "77234.40000000",
 *     markPrice: "77834.45000000",
 *     unRealizedProfit: "0.10026475",
 *     liquidationPrice: "230411.56000000",
 *     leverage: "10",
 *     marginType: "cross" | "isolated",
 *     isolatedMargin: "0.000",
 *     positionSide: "BOTH" | "LONG" | "SHORT",
 *     ...
 *   }
 *
 * Throws on permission denied / non-2xx — caller `Promise.allSettled`
 * records the wallet as skipped + logs the reason.
 */
export async function getPositionRisk(
    apiKey: string,
    apiSecret: string,
): Promise<unknown> {
    return signedFapiGet(apiKey, apiSecret, "/fapi/v2/positionRisk");
}

/**
 * Fix 13 — `GET /fapi/v2/account`. Returns the full futures account
 * envelope (per-asset wallet rows + per-position summary). Not used
 * by the v1 of `get_positions` (which only needs `positionRisk` +
 * margin/isolated metadata) but exposed here so `get_pnl` and any
 * future "futures account snapshot" needs land in one place.
 *
 * Throws on permission denied / non-2xx (same pattern as
 * `getPositionRisk`).
 */
export async function getFuturesAccount(
    apiKey: string,
    apiSecret: string,
): Promise<unknown> {
    return signedFapiGet(apiKey, apiSecret, "/fapi/v2/account");
}

/**
 * Fix 13 — `GET /fapi/v1/income`. Returns the futures income history
 * (REALIZED_PNL, FUNDING_FEE, COMMISSION, TRANSFER, …). Used by
 * `get_pnl` to compute realized PnL for the user-specified window
 * (default last 30 days).
 *
 * The Binance API caps the window to 7 days when both `startTime` /
 * `endTime` are provided, so callers that want a longer window must
 * chunk and concatenate. The 30-day default for `get_pnl` is fanned
 * out across five 6-day chunks by the caller.
 *
 * Returns an empty array on a non-array response so the caller can
 * always `[].push(...result)`.
 */
export async function getIncomeHistory(
    apiKey: string,
    apiSecret: string,
    opts: {
        symbol?: string;
        incomeType?: string;
        startTime?: number;
        endTime?: number;
        limit?: number;
    } = {},
): Promise<unknown[]> {
    const params: Record<string, unknown> = {
        ...(opts.symbol ? { symbol: opts.symbol } : {}),
        ...(opts.incomeType ? { incomeType: opts.incomeType } : {}),
        ...(opts.startTime !== undefined ? { startTime: opts.startTime } : {}),
        ...(opts.endTime !== undefined ? { endTime: opts.endTime } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    };
    const result = await signedFapiGet(apiKey, apiSecret, "/fapi/v1/income", params);
    return Array.isArray(result) ? result : [];
}

/**
 * Exposed for direct callers that want to issue arbitrary `/fapi/*`
 * GETs without a typed wrapper. Mirrors `signedMarginGet` /
 * `signedIsolatedMarginGet` in `binanceMargin.ts`.
 */
export { signedFapiGet };
