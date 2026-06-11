import { buildQueryString, getSignature } from "@binance/common";
import { Spot, SpotRestAPI } from "@binance/spot";
import { Wallet } from "@binance/wallet";
import { elizaLogger, formatAxiosErrorLine, httpClient } from "@elizaos/core";
import { sanitizeForLog, summarizeResponseForLog } from "../safeHttpLog";
import { productIdToBinanceSymbol } from "./binanceSymbol";
import {
    extractBinanceSymbolFiltersFromResponse,
    quantizeBinanceOrderBody,
    type BinanceSymbolFilters,
} from "./binanceQuantization";
import {
    marginActionToSideEffect,
    precheckIsolatedAccountOpened,
    signedIsolatedMarginGet,
    signedMarginAllOrders,
    signedMarginGet,
    signedMarginOpenOrders,
    signedMarginOrderPost,
} from "./binanceMargin";
import {
    getFuturesAccount,
    getIncomeHistory,
    getPositionRisk,
} from "./binanceFutures";
import { fetchBinanceUsdtPrices, isStablecoin } from "./binancePricing";
import { callVenueWithRetry } from "./retry";
import type {
    CancelOrderParams,
    ClosePositionParams,
    CreateOrderParams,
    EditOrderParams,
    ExchangeAccountsService,
    ExchangeOrdersService,
    ExchangeService,
    GetBalanceParams,
    GetFillsParams,
    GetOrdersParams,
    OrderConfiguration,
    ResolvedExchangeCredentials,
} from "../../types";

const BINANCE_BASE_URL = process.env.BINANCE_BASE_URL?.trim() || "https://api.binance.com";
const DEFAULT_RECV_WINDOW_MS = 10_000;
/** Long timeout so slow networks / manual Postman comparison are easier while debugging. */
const REST_TIMEOUT_MS = 300_000;

/** Binance API code -2015 and similar 401s (see [Binance errors](https://developers.binance.com/docs/binance-spot-api-docs/errors)). */
const BINANCE_AUTH_TROUBLESHOOTING =
    "Typical causes: API key or secret wrong; apiKeyName/apiKeySecret swapped in exchange settings; " +
    "IP restriction enabled but this host not allowlisted; key missing 'Enable Reading' or Spot/Margin permissions; " +
    "using production keys against testnet (or vice versa).";

type BinanceRequestDebug = {
    label: string;
    requestPayload: unknown;
};

function binanceDebugMeta(
    label: string,
    requestPayload: unknown
): BinanceRequestDebug {
    return { label, requestPayload };
}

/** Drop empty strings so signing matches prior plugin behavior (Binance common skips only null/undefined). */
function stripEmptyQueryValues(params: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")
    );
}

function payloadToRecord(payload: unknown): Record<string, unknown> {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
        if (v === undefined) continue;
        out[k] = typeof v === "bigint" ? v.toString() : v;
    }
    return out;
}

/** OpenAPI generator field order for `newOrder` (see @binance/spot). */
const SPOT_NEW_ORDER_KEY_ORDER = [
    "symbol",
    "side",
    "type",
    "timeInForce",
    "quantity",
    "quoteOrderQty",
    "price",
    "newClientOrderId",
    "strategyId",
    "strategyType",
    "stopPrice",
    "trailingDelta",
    "icebergQty",
    "newOrderRespType",
    "selfTradePreventionMode",
    "pegPriceType",
    "pegOffsetValue",
    "pegOffsetType",
    "recvWindow",
] as const;

/** OpenAPI generator field order for `orderCancelReplace`. */
const SPOT_ORDER_CANCEL_REPLACE_KEY_ORDER = [
    "symbol",
    "side",
    "type",
    "cancelReplaceMode",
    "timeInForce",
    "quantity",
    "quoteOrderQty",
    "price",
    "cancelNewClientOrderId",
    "cancelOrigClientOrderId",
    "cancelOrderId",
    "newClientOrderId",
    "strategyId",
    "strategyType",
    "stopPrice",
    "trailingDelta",
    "icebergQty",
    "newOrderRespType",
    "selfTradePreventionMode",
    "cancelRestrictions",
    "orderRateLimitExceededMode",
    "pegPriceType",
    "pegOffsetValue",
    "pegOffsetType",
    "recvWindow",
] as const;

function pickQueryInKeyOrder(keys: readonly string[], raw: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of keys) {
        const v = raw[k];
        if (v !== undefined && v !== null && v !== "") out[k] = v;
    }
    return out;
}

function queryForConnectorSignOrder(label: string, raw: Record<string, unknown>): Record<string, unknown> {
    if (label === "spot.newOrder" || label === "spot.newOrder.closePosition") {
        return pickQueryInKeyOrder(SPOT_NEW_ORDER_KEY_ORDER, raw);
    }
    if (label === "spot.orderCancelReplace") {
        return pickQueryInKeyOrder(SPOT_ORDER_CANCEL_REPLACE_KEY_ORDER, raw);
    }
    return { ...raw };
}

const BINANCE_DEBUG_ENDPOINTS: Record<string, { method: string; path: string }> = {
    "spot.getAccount": { method: "GET", path: "/api/v3/account" },
    "wallet.fundingWallet": { method: "POST", path: "/sapi/v1/asset/get-funding-asset" },
    "spot.getOpenOrders": { method: "GET", path: "/api/v3/openOrders" },
    "spot.getOrder": { method: "GET", path: "/api/v3/order" },
    "spot.allOrders": { method: "GET", path: "/api/v3/allOrders" },
    "spot.myTrades": { method: "GET", path: "/api/v3/myTrades" },
    "spot.newOrder": { method: "POST", path: "/api/v3/order" },
    "spot.newOrder.closePosition": { method: "POST", path: "/api/v3/order" },
    "spot.deleteOrder": { method: "DELETE", path: "/api/v3/order" },
    "spot.orderCancelReplace": { method: "POST", path: "/api/v3/order/cancelReplace" },
    "spot.exchangeInfo": { method: "GET", path: "/api/v3/exchangeInfo" },
};

/** Emits sanitized debug metadata without credentials, signatures, or full URLs. */
function logBinanceDebugCurl(ctx: BinanceRequestDebug): void {
    const payload = sanitizeForLog(
        payloadToRecord(ctx.requestPayload),
        { maxDepth: 8 }
    );
    const payloadJson = JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    const ep = BINANCE_DEBUG_ENDPOINTS[ctx.label];
    if (!ep) {
        elizaLogger.debug(`[plugin-cex Binance] ${ctx.label} request payload=${payloadJson}`);
        return;
    }

    elizaLogger.debug(
        `[plugin-cex Binance] ${ctx.label} request ${ep.method} ${ep.path} payload=${payloadJson}`
    );
}

async function unwrapRestData<T>(
    ctx: BinanceRequestDebug,
    promiseFactory: () => Promise<{ data(): Promise<T> }>,
    writeOpts?: { clientOrderId?: string; symbol?: string },
): Promise<T> {
    logBinanceDebugCurl(ctx);
    const ep = BINANCE_DEBUG_ENDPOINTS[ctx.label];
    const route = ep ? `${ep.method} ${ep.path}` : ctx.label;
    const endpoint = ep?.path ?? `binance.${ctx.label}`;
    const method = (ep?.method as "GET" | "POST" | "PUT" | "DELETE" | undefined) ?? "POST";
    const requestBody = payloadToRecord(ctx.requestPayload);

    let captured: T | undefined;
    try {
        await callVenueWithRetry<T>({
            venue: "binance",
            endpoint,
            method,
            request_body: requestBody,
            is_write: Boolean(writeOpts),
            client_order_id: writeOpts?.clientOrderId,
            symbol: writeOpts?.symbol,
            invoke: async () => {
                // Per attempt, build a FRESH in-flight request via the factory.
                // The previous shape captured an already-resolved promise, so retries
                // re-awaited the cached rejection and never issued a new HTTP call.
                const start = Date.now();
                const res = await promiseFactory();
                const data = await res.data();
                const durationMs = Date.now() - start;
                if (isBinanceErrorPayload(data)) {
                    // HTTP 200 + `{code:-X, msg:...}` means the request landed at
                    // Binance and was rejected. Surface as a `venue_4xx`-shaped
                    // failure so retry/UNKNOWN promotion treats it as known-rejected
                    // (not a network error). See plan §6.0.3.
                    elizaLogger.debug(
                        `[plugin-cex Binance] ${ctx.label} ${route} durationMs=${durationMs} response=${JSON.stringify(summarizeResponseForLog(data))} (binance error payload)`
                    );
                    throw makeBinanceRejectionError(data, durationMs);
                }
                captured = data;
                elizaLogger.debug(
                    `[plugin-cex Binance] ${ctx.label} ${route} durationMs=${durationMs} response=${JSON.stringify(summarizeResponseForLog(data))}`
                );
                return { http_status: 200, body: data, latency_ms: durationMs };
            },
        });
        return captured as T;
    } catch (err) {
        if (typeof err === "object" && err !== null && (err as Error).name === "UnauthorizedError") {
            const code = (err as { code?: number }).code;
            elizaLogger.debug(
                `[plugin-cex Binance] ${ctx.label} ${route} UnauthorizedError binanceCode=${String(code)} message=${(err as Error).message}. ${BINANCE_AUTH_TROUBLESHOOTING}`
            );
        } else {
            elizaLogger.debug(
                `[plugin-cex Binance] ${ctx.label} ${route} (error) ${formatAxiosErrorLine(err)}`,
            );
        }
        throw err;
    }
}

function requireAuthString(credentials: ResolvedExchangeCredentials, key: string): string {
    const value = credentials.auth?.[key];
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`Missing required auth field "${key}" for ${credentials.exchange}`);
    }
    return value.trim();
}

export { productIdToBinanceSymbol } from "./binanceSymbol";

function parseTimestampToMs(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (/^\d+$/.test(trimmed)) {
        const num = Number(trimmed);
        if (!Number.isFinite(num)) return undefined;
        return num < 1e12 ? num * 1000 : num;
    }
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) return undefined;
    return d.getTime();
}

function isBinanceErrorPayload(data: unknown): data is { code: number; msg: string } {
    if (typeof data !== "object" || data === null) return false;
    const rec = data as Record<string, unknown>;
    return typeof rec.code === "number" && rec.code < 0 && typeof rec.msg === "string";
}

interface BinanceRejectionError extends Error {
    response: { status: number; data: { code: number; msg: string } };
    binance_rejected: true;
    binance_code: number;
}

/**
 * Build a structured Error for an HTTP 200 Binance error payload (e.g. -1013
 * insufficient balance). Carrying `response.status = 400` makes
 * `classifyRetryError` return `outcome: "venue_4xx"` — definitely not retryable,
 * NOT UNKNOWN-promoting. Without this, a plain Error has no `response.status`,
 * `classifyRetryError` falls through to `venue_network_error`, and writes get
 * marked UNKNOWN even though the venue explicitly rejected.
 */
function makeBinanceRejectionError(
    data: { code: number; msg: string },
    _durationMs: number,
): BinanceRejectionError {
    const err = new Error(`Binance API error ${data.code}: ${data.msg}`) as BinanceRejectionError;
    err.response = { status: 400, data };
    err.binance_rejected = true;
    err.binance_code = data.code;
    return err;
}

function toConnectorError(e: unknown): Error {
    if (e instanceof Error) return e;
    return new Error(String(e));
}

function parseNum(v: string | number | boolean | undefined): number | undefined {
    if (v === undefined || typeof v === "boolean") return undefined;
    if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
}

function toOrderId(id: string): number | bigint {
    try {
        return BigInt(id);
    } catch {
        return Number.parseInt(id, 10);
    }
}

/** Spot `newOrder` OpenAPI client omits `goodTillDate`; use signed POST for GTD orders only. */
async function signedSpotOrderPost(
    apiKey: string,
    apiSecret: string,
    params: Record<string, string | number | boolean | undefined>
): Promise<unknown> {
    const timestamp = Date.now();
    const queryParams = stripEmptyQueryValues({
        ...params,
        timestamp,
        recvWindow: DEFAULT_RECV_WINDOW_MS,
    } as Record<string, unknown>);
    const signConfig = { apiSecret };
    const signature = getSignature(signConfig, queryParams, {});
    const query = buildQueryString({ ...queryParams, signature });
    const url = `${BINANCE_BASE_URL}/api/v3/order?${query}`;
    const clientOrderId =
        typeof params.newClientOrderId === "string" ? params.newClientOrderId : undefined;
    const symbol = typeof params.symbol === "string" ? params.symbol : undefined;

    elizaLogger.debug(
        `[plugin-cex Binance] signedSpotOrderPost POST /api/v3/order params=${JSON.stringify(sanitizeForLog(queryParams, { maxDepth: 8 }), (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`
    );

    const out = await callVenueWithRetry({
        venue: "binance",
        endpoint: "/api/v3/order",
        method: "POST",
        request_body: queryParams,
        is_write: true,
        client_order_id: clientOrderId,
        symbol,
        invoke: async () => {
            const start = Date.now();
            let response: { status: number; statusText: string; data: unknown };
            try {
                response = await httpClient.post<unknown>(url, null, {
                    headers: {
                        "X-MBX-APIKEY": apiKey,
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    timeout: REST_TIMEOUT_MS,
                });
            } catch (err) {
                const durationMs = Date.now() - start;
                const errPayload =
                    typeof err === "object" && err !== null && "response" in err
                        ? (err as { response?: { status?: number; data?: unknown } }).response
                        : undefined;
                if (errPayload?.status !== undefined) {
                    elizaLogger.debug(
                        `[plugin-cex Binance] signedSpotOrderPost POST /api/v3/order status=${errPayload.status} durationMs=${durationMs} response=${JSON.stringify(summarizeResponseForLog(errPayload.data))} (error)`
                    );
                } else {
                    elizaLogger.debug(
                        `[plugin-cex Binance] signedSpotOrderPost POST /api/v3/order durationMs=${durationMs} (error) ${formatAxiosErrorLine(err)}`,
                    );
                }
                throw err;
            }
            const durationMs = Date.now() - start;
            if (response.status < 200 || response.status >= 300) {
                elizaLogger.debug(
                    `[plugin-cex Binance] signedSpotOrderPost POST /api/v3/order status=${response.status} durationMs=${durationMs} response=${JSON.stringify(summarizeResponseForLog(response.data))} (non-success)`
                );
                const wrappedErr: { response: { status: number; statusText: string; data: unknown } } = {
                    response: { status: response.status, statusText: response.statusText, data: response.data },
                };
                throw wrappedErr;
            }
            const data = response.data;
            if (isBinanceErrorPayload(data)) {
                elizaLogger.debug(
                    `[plugin-cex Binance] signedSpotOrderPost POST /api/v3/order status=${response.status} durationMs=${durationMs} response=${JSON.stringify(summarizeResponseForLog(data))} (binance error payload)`
                );
                throw makeBinanceRejectionError(data, durationMs);
            }
            elizaLogger.debug(
                `[plugin-cex Binance] signedSpotOrderPost POST /api/v3/order status=${response.status} durationMs=${durationMs} response=${JSON.stringify(summarizeResponseForLog(data))}`
            );
            return { http_status: response.status, body: data, latency_ms: durationMs };
        },
    });
    return out.body;
}

type BinanceClients = {
    spot: Spot;
    wallet: Wallet;
    apiKey: string;
    apiSecret: string;
};

function createBinanceClients(credentials: ResolvedExchangeCredentials): BinanceClients {
    if (credentials.authType !== "api_key_name_secret") {
        throw new Error(`Unsupported authType "${credentials.authType}" for ${credentials.exchange}`);
    }

    const apiKey = requireAuthString(credentials, "apiKeyName");
    const apiSecret = requireAuthString(credentials, "apiKeySecret");

    const configurationRestAPI = {
        apiKey,
        apiSecret,
        timeout: REST_TIMEOUT_MS,
        basePath: BINANCE_BASE_URL,
    };

    return {
        spot: new Spot({ configurationRestAPI }),
        wallet: new Wallet({ configurationRestAPI }),
        apiKey,
        apiSecret,
    };
}

export function mapOrderConfigurationToBinanceParams(
    symbol: string,
    side: "BUY" | "SELL",
    clientOrderId: string,
    oc: OrderConfiguration
): Record<string, string | number | boolean | undefined> {
    const newClientOrderId = clientOrderId.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 36);
    if (!newClientOrderId) {
        throw new Error("client_order_id must yield a non-empty Binance newClientOrderId (max 36 alnum._-)");
    }

    const base: Record<string, string | number | boolean | undefined> = {
        symbol,
        side,
        newClientOrderId,
    };

    if (oc.market_market_ioc) {
        const m = oc.market_market_ioc;
        if (m.quote_size) {
            base.type = "MARKET";
            base.quoteOrderQty = m.quote_size;
            return base;
        }
        if (m.base_size) {
            base.type = "MARKET";
            base.quantity = m.base_size;
            return base;
        }
        throw new Error("market order_configuration requires base_size or quote_size");
    }

    if (oc.market_market_fok) {
        throw new Error("market_market_fok is not supported for Binance Spot create_order");
    }

    if (oc.limit_limit_gtc) {
        const L = oc.limit_limit_gtc;
        if (!L.limit_price) throw new Error("limit_limit_gtc requires limit_price");
        if (L.post_only) {
            base.type = "LIMIT_MAKER";
            base.price = L.limit_price;
            if (!L.base_size) throw new Error("limit_limit_gtc (post_only) requires base_size");
            base.quantity = L.base_size;
            return base;
        }
        base.type = "LIMIT";
        base.timeInForce = "GTC";
        base.price = L.limit_price;
        if (L.base_size) base.quantity = L.base_size;
        else throw new Error("limit_limit_gtc requires base_size for Binance Spot");
        if (L.iceberg_qty) base.icebergQty = L.iceberg_qty;
        return base;
    }

    if (oc.limit_limit_gtd) {
        const L = oc.limit_limit_gtd;
        if (!L.limit_price || !L.end_time) throw new Error("limit_limit_gtd requires limit_price and end_time");
        const gtdMs = parseTimestampToMs(L.end_time);
        if (gtdMs === undefined) throw new Error("limit_limit_gtd.end_time must be a valid time");
        base.type = "LIMIT";
        base.timeInForce = "GTD";
        base.price = L.limit_price;
        base.goodTillDate = gtdMs;
        if (L.base_size) base.quantity = L.base_size;
        else throw new Error("limit_limit_gtd requires base_size for Binance Spot");
        if (L.iceberg_qty) base.icebergQty = L.iceberg_qty;
        return base;
    }

    if (oc.limit_limit_fok) {
        const L = oc.limit_limit_fok;
        if (!L.limit_price) throw new Error("limit_limit_fok requires limit_price");
        base.type = "LIMIT";
        base.timeInForce = "FOK";
        base.price = L.limit_price;
        if (L.base_size) base.quantity = L.base_size;
        else throw new Error("limit_limit_fok requires base_size for Binance Spot");
        return base;
    }

    if (oc.sor_limit_ioc) {
        throw new Error("sor_limit_ioc is not supported for Binance Spot create_order");
    }

    if (oc.stop_limit_stop_limit_gtc || oc.stop_limit_stop_limit_gtd) {
        const L = { ...oc.stop_limit_stop_limit_gtd, ...oc.stop_limit_stop_limit_gtc };
        if (!L.stop_price || !L.limit_price) {
            throw new Error("stop_limit order_configuration requires stop_price and limit_price");
        }
        if (!L.base_size) throw new Error("stop_limit order_configuration requires base_size");
        base.type = "STOP_LOSS_LIMIT";
        base.price = L.limit_price;
        base.stopPrice = L.stop_price;
        base.quantity = L.base_size;
        base.timeInForce = oc.stop_limit_stop_limit_gtd ? "GTD" : "GTC";
        if (oc.stop_limit_stop_limit_gtd?.end_time) {
            const gtdMs = parseTimestampToMs(oc.stop_limit_stop_limit_gtd.end_time);
            if (gtdMs !== undefined) base.goodTillDate = gtdMs;
        }
        return base;
    }

    if (oc.trigger_bracket_gtc || oc.trigger_bracket_gtd) {
        throw new Error(
            "trigger_bracket_gtc/gtd is not supported for Binance: shared schema has no base quantity for bracket orders"
        );
    }

    if (oc.trailing_stop_limit_gtc) {
        const T = oc.trailing_stop_limit_gtc;
        if (!T.base_size) {
            throw new Error("trailing_stop_limit_gtc requires base_size");
        }
        if (
            typeof T.trailing_delta_bps !== "number" ||
            !Number.isFinite(T.trailing_delta_bps) ||
            T.trailing_delta_bps < 1 ||
            T.trailing_delta_bps > 2000
        ) {
            throw new Error("trailing_stop_limit_gtc.trailing_delta_bps must be an integer between 1 and 2000");
        }
        if (T.limit_price) {
            base.type = "STOP_LOSS_LIMIT";
            base.price = T.limit_price;
            base.timeInForce = "GTC";
        } else {
            base.type = "STOP_LOSS";
        }
        base.quantity = T.base_size;
        base.trailingDelta = Math.round(T.trailing_delta_bps);
        if (T.activation_price) base.stopPrice = T.activation_price;
        return base;
    }

    if (oc.oco_gtc) {
        // OCO is submitted via a different endpoint (orderListOco). Mark this
        // body so the caller dispatches via the OCO path. The non-OCO mapper
        // intentionally does not return order placement params for OCO.
        return {
            __binance_oco: "1",
            symbol,
            side,
            newClientOrderId,
            quantity: oc.oco_gtc.base_size,
            abovePrice: oc.oco_gtc.above_limit_price,
            belowStopPrice: oc.oco_gtc.below_stop_price,
            belowPrice: oc.oco_gtc.below_limit_price,
            belowTimeInForce: oc.oco_gtc.below_time_in_force ?? "GTC",
        };
    }

    throw new Error("No supported order_configuration variant found for Binance mapping");
}

function mapStringToNewOrderType(t: string): SpotRestAPI.NewOrderTypeEnum {
    const u = t.toUpperCase();
    if (u === "MARKET") return SpotRestAPI.NewOrderTypeEnum.MARKET;
    if (u === "LIMIT") return SpotRestAPI.NewOrderTypeEnum.LIMIT;
    if (u === "LIMIT_MAKER") return SpotRestAPI.NewOrderTypeEnum.LIMIT_MAKER;
    if (u === "STOP_LOSS_LIMIT") return SpotRestAPI.NewOrderTypeEnum.STOP_LOSS_LIMIT;
    if (u === "STOP_LOSS") return SpotRestAPI.NewOrderTypeEnum.STOP_LOSS;
    if (u === "TAKE_PROFIT") return SpotRestAPI.NewOrderTypeEnum.TAKE_PROFIT;
    if (u === "TAKE_PROFIT_LIMIT") return SpotRestAPI.NewOrderTypeEnum.TAKE_PROFIT_LIMIT;
    return SpotRestAPI.NewOrderTypeEnum.LIMIT;
}

function mapStringToCancelReplaceType(t: string): SpotRestAPI.OrderCancelReplaceTypeEnum {
    const u = t.toUpperCase();
    if (u === "MARKET") return SpotRestAPI.OrderCancelReplaceTypeEnum.MARKET;
    if (u === "LIMIT") return SpotRestAPI.OrderCancelReplaceTypeEnum.LIMIT;
    if (u === "LIMIT_MAKER") return SpotRestAPI.OrderCancelReplaceTypeEnum.LIMIT_MAKER;
    if (u === "STOP_LOSS_LIMIT") return SpotRestAPI.OrderCancelReplaceTypeEnum.STOP_LOSS_LIMIT;
    if (u === "STOP_LOSS") return SpotRestAPI.OrderCancelReplaceTypeEnum.STOP_LOSS;
    if (u === "TAKE_PROFIT") return SpotRestAPI.OrderCancelReplaceTypeEnum.TAKE_PROFIT;
    if (u === "TAKE_PROFIT_LIMIT") return SpotRestAPI.OrderCancelReplaceTypeEnum.TAKE_PROFIT_LIMIT;
    return SpotRestAPI.OrderCancelReplaceTypeEnum.LIMIT;
}

function mapBodyToNewOrderRequest(body: Record<string, string | number | boolean | undefined>): SpotRestAPI.NewOrderRequest {
    const symbol = String(body.symbol ?? "");
    const side =
        body.side === "SELL" ? SpotRestAPI.NewOrderSideEnum.SELL : SpotRestAPI.NewOrderSideEnum.BUY;
    const type = mapStringToNewOrderType(String(body.type ?? "LIMIT"));

    let timeInForce: SpotRestAPI.NewOrderTimeInForceEnum | undefined;
    if (body.timeInForce !== undefined) {
        const tif = String(body.timeInForce).toUpperCase();
        if (tif === "GTC") timeInForce = SpotRestAPI.NewOrderTimeInForceEnum.GTC;
        else if (tif === "IOC") timeInForce = SpotRestAPI.NewOrderTimeInForceEnum.IOC;
        else if (tif === "FOK") timeInForce = SpotRestAPI.NewOrderTimeInForceEnum.FOK;
    }
    const q = parseNum(body.quantity);
    const qq = parseNum(body.quoteOrderQty);
    const p = parseNum(body.price);
    const sp = parseNum(body.stopPrice);
    const td = parseNum(body.trailingDelta);
    const ice = parseNum(body.icebergQty);
    const newClientOrderId =
        body.newClientOrderId !== undefined ? String(body.newClientOrderId) : undefined;

    return {
        symbol,
        side,
        type,
        recvWindow: DEFAULT_RECV_WINDOW_MS,
        ...(timeInForce !== undefined ? { timeInForce } : {}),
        ...(q !== undefined ? { quantity: q } : {}),
        ...(qq !== undefined ? { quoteOrderQty: qq } : {}),
        ...(p !== undefined ? { price: p } : {}),
        ...(sp !== undefined ? { stopPrice: sp } : {}),
        ...(td !== undefined ? { trailingDelta: td } : {}),
        ...(ice !== undefined ? { icebergQty: ice } : {}),
        ...(newClientOrderId !== undefined ? { newClientOrderId } : {}),
    };
}

/**
 * Fix 1 — uniform balance row shape rendered to the user-facing
 * `accounts[]` array. The legacy fields (`id`, `currency`,
 * `available_balance.value`, `hold.value`, `wallet_type`) are
 * preserved alongside the new normalized fields so existing
 * downstream consumers (notably `fetchAccountSnapshot` in
 * `packages/plugin-cex/src/index.ts` which keys off `currency` +
 * `available_balance.value`) keep working without per-call-site
 * changes. New consumers (formatters, USD enrichment) should prefer
 * `asset` + `free` + `locked` + `total`.
 */
type BinanceBalanceRow = {
    // Legacy fields (kept for backward compat with index.ts and the
    // existing Coinbase-shaped formatter path).
    id: string;
    currency: string;
    available_balance: { value: string };
    hold: { value: string };
    wallet_type: "spot" | "funding" | "margin_cross" | "margin_isolated";
    // Uniform fields (Fix 1 spec).
    asset: string;
    free: string;
    locked: string;
    borrowed?: string;
    interest?: string;
    net?: string;
    total: string;
    symbol_pair?: string;
};

/**
 * Sum `free + locked` (and optionally subtract `borrowed + interest`
 * for the `net` field). Returns a fixed-precision string to keep
 * arithmetic stable when the upstream values are decimal strings.
 */
function sumBalanceFields(free: string, locked: string): string {
    const f = Number.parseFloat(free ?? "0");
    const l = Number.parseFloat(locked ?? "0");
    const t = (Number.isFinite(f) ? f : 0) + (Number.isFinite(l) ? l : 0);
    // 8 dp matches Binance's precision for BTC + dust assets.
    return Number(t.toFixed(8)).toString();
}

function computeNet(
    free: string,
    locked: string,
    borrowed: string,
    interest: string,
): string {
    const f = Number.parseFloat(free ?? "0");
    const l = Number.parseFloat(locked ?? "0");
    const b = Number.parseFloat(borrowed ?? "0");
    const i = Number.parseFloat(interest ?? "0");
    const safe = (x: number) => (Number.isFinite(x) ? x : 0);
    const t = safe(f) + safe(l) - safe(b) - safe(i);
    return Number(t.toFixed(8)).toString();
}

function buildSpotRow(asset: string, free: string, locked: string): BinanceBalanceRow {
    return {
        id: `spot-${asset}`,
        currency: asset,
        available_balance: { value: free },
        hold: { value: locked },
        wallet_type: "spot",
        asset,
        free,
        locked,
        total: sumBalanceFields(free, locked),
    };
}

function buildFundingRow(asset: string, free: string, locked: string): BinanceBalanceRow {
    return {
        id: `funding-${asset}`,
        currency: asset,
        available_balance: { value: free },
        hold: { value: locked },
        wallet_type: "funding",
        asset,
        free,
        locked,
        total: sumBalanceFields(free, locked),
    };
}

function buildCrossMarginRow(
    asset: string,
    free: string,
    locked: string,
    borrowed: string,
    interest: string,
): BinanceBalanceRow {
    return {
        id: `margin-cross-${asset}`,
        currency: asset,
        available_balance: { value: free },
        hold: { value: locked },
        wallet_type: "margin_cross",
        asset,
        free,
        locked,
        borrowed,
        interest,
        net: computeNet(free, locked, borrowed, interest),
        total: sumBalanceFields(free, locked),
    };
}

function buildIsolatedMarginRow(
    symbolPair: string,
    asset: string,
    free: string,
    locked: string,
    borrowed: string,
    interest: string,
): BinanceBalanceRow {
    return {
        id: `margin-isolated-${symbolPair}-${asset}`,
        currency: asset,
        available_balance: { value: free },
        hold: { value: locked },
        wallet_type: "margin_isolated",
        asset,
        free,
        locked,
        borrowed,
        interest,
        net: computeNet(free, locked, borrowed, interest),
        total: sumBalanceFields(free, locked),
        symbol_pair: symbolPair,
    };
}

/** Normalize raw spot.balances[] into BinanceBalanceRow[]. Drops dust-zero rows. */
function normalizeSpotBalances(raw: unknown): BinanceBalanceRow[] {
    if (!raw || typeof raw !== "object") return [];
    const balances = (raw as { balances?: unknown }).balances;
    if (!Array.isArray(balances)) return [];
    const rows: BinanceBalanceRow[] = [];
    for (const b of balances) {
        if (!b || typeof b !== "object") continue;
        const rec = b as Record<string, unknown>;
        const asset = typeof rec.asset === "string" ? rec.asset : "";
        if (!asset) continue;
        const free = String(rec.free ?? "0");
        const locked = String(rec.locked ?? "0");
        const freeN = Number.parseFloat(free);
        const lockedN = Number.parseFloat(locked);
        if (!(freeN > 0) && !(lockedN > 0)) continue;
        rows.push(buildSpotRow(asset, free, locked));
    }
    return rows;
}

/** Normalize raw wallet.fundingWallet payload into BinanceBalanceRow[]. */
function normalizeFundingBalances(raw: unknown): BinanceBalanceRow[] {
    if (!Array.isArray(raw)) return [];
    const rows: BinanceBalanceRow[] = [];
    for (const r of raw) {
        if (!r || typeof r !== "object") continue;
        const rec = r as Record<string, unknown>;
        const asset = typeof rec.asset === "string" ? rec.asset : "";
        if (!asset) continue;
        const free = String(rec.free ?? "0");
        const locked = String(rec.locked ?? rec.freeze ?? "0");
        rows.push(buildFundingRow(asset, free, locked));
    }
    return rows;
}

interface CrossMarginNormalized {
    rows: BinanceBalanceRow[];
    summary: {
        marginRatio: string;
        totalAssetOfBtc: string;
        totalLiabilityOfBtc: string;
        totalNetAssetOfBtc: string;
    };
}

/** Normalize raw cross-margin response into rows + top-level summary. */
function normalizeCrossMargin(raw: unknown): CrossMarginNormalized | null {
    if (!raw || typeof raw !== "object") return null;
    const rec = raw as Record<string, unknown>;
    const userAssets = rec.userAssets;
    const rows: BinanceBalanceRow[] = [];
    if (Array.isArray(userAssets)) {
        for (const a of userAssets) {
            if (!a || typeof a !== "object") continue;
            const ar = a as Record<string, unknown>;
            const asset = typeof ar.asset === "string" ? ar.asset : "";
            if (!asset) continue;
            const free = String(ar.free ?? "0");
            const locked = String(ar.locked ?? "0");
            const borrowed = String(ar.borrowed ?? "0");
            const interest = String(ar.interest ?? "0");
            const f = Number.parseFloat(free);
            const l = Number.parseFloat(locked);
            const b = Number.parseFloat(borrowed);
            const i = Number.parseFloat(interest);
            // Drop truly empty rows (no balance AND no debt).
            const hasBalance = (Number.isFinite(f) && f > 0) || (Number.isFinite(l) && l > 0);
            const hasDebt = (Number.isFinite(b) && b > 0) || (Number.isFinite(i) && i > 0);
            if (!hasBalance && !hasDebt) continue;
            rows.push(buildCrossMarginRow(asset, free, locked, borrowed, interest));
        }
    }
    const summary = {
        marginRatio: String(rec.marginLevel ?? rec.marginRatio ?? "0"),
        totalAssetOfBtc: String(rec.totalAssetOfBtc ?? "0"),
        totalLiabilityOfBtc: String(rec.totalLiabilityOfBtc ?? "0"),
        totalNetAssetOfBtc: String(rec.totalNetAssetOfBtc ?? "0"),
    };
    return { rows, summary };
}

interface IsolatedMarginNormalized {
    rows: BinanceBalanceRow[];
    summary: Array<{
        symbol: string;
        marginRatio: string;
        baseAsset: { asset: string; free: string; locked: string; borrowed: string; interest: string; net: string; total: string };
        quoteAsset: { asset: string; free: string; locked: string; borrowed: string; interest: string; net: string; total: string };
    }>;
}

function normalizeIsolatedAssetForSummary(
    raw: Record<string, unknown>,
): { asset: string; free: string; locked: string; borrowed: string; interest: string; net: string; total: string } {
    const asset = typeof raw.asset === "string" ? raw.asset : "";
    const free = String(raw.free ?? "0");
    const locked = String(raw.locked ?? "0");
    const borrowed = String(raw.borrowed ?? "0");
    const interest = String(raw.interest ?? "0");
    return {
        asset,
        free,
        locked,
        borrowed,
        interest,
        net: computeNet(free, locked, borrowed, interest),
        total: sumBalanceFields(free, locked),
    };
}

/** Normalize raw isolated-margin response into rows + per-pair summary. */
function normalizeIsolatedMargin(raw: unknown): IsolatedMarginNormalized | null {
    if (!raw || typeof raw !== "object") return null;
    const rec = raw as Record<string, unknown>;
    const assets = rec.assets;
    if (!Array.isArray(assets)) return { rows: [], summary: [] };
    const rows: BinanceBalanceRow[] = [];
    const summary: IsolatedMarginNormalized["summary"] = [];
    for (const a of assets) {
        if (!a || typeof a !== "object") continue;
        const ar = a as Record<string, unknown>;
        const symbolPair = typeof ar.symbol === "string" ? ar.symbol : "";
        if (!symbolPair) continue;
        const base = (ar.baseAsset && typeof ar.baseAsset === "object")
            ? (ar.baseAsset as Record<string, unknown>)
            : null;
        const quote = (ar.quoteAsset && typeof ar.quoteAsset === "object")
            ? (ar.quoteAsset as Record<string, unknown>)
            : null;
        const marginRatio = String(ar.marginRatio ?? ar.marginLevel ?? "0");
        const baseNorm = base ? normalizeIsolatedAssetForSummary(base) : null;
        const quoteNorm = quote ? normalizeIsolatedAssetForSummary(quote) : null;
        // Emit a row for each side that has any balance or debt.
        const isNonEmpty = (n: ReturnType<typeof normalizeIsolatedAssetForSummary>) => {
            const numNonZero = (s: string) => {
                const v = Number.parseFloat(s);
                return Number.isFinite(v) && v > 0;
            };
            return numNonZero(n.free) || numNonZero(n.locked) || numNonZero(n.borrowed) || numNonZero(n.interest);
        };
        if (baseNorm && baseNorm.asset && isNonEmpty(baseNorm)) {
            rows.push(
                buildIsolatedMarginRow(
                    symbolPair,
                    baseNorm.asset,
                    baseNorm.free,
                    baseNorm.locked,
                    baseNorm.borrowed,
                    baseNorm.interest,
                ),
            );
        }
        if (quoteNorm && quoteNorm.asset && isNonEmpty(quoteNorm)) {
            rows.push(
                buildIsolatedMarginRow(
                    symbolPair,
                    quoteNorm.asset,
                    quoteNorm.free,
                    quoteNorm.locked,
                    quoteNorm.borrowed,
                    quoteNorm.interest,
                ),
            );
        }
        if (baseNorm && quoteNorm) {
            summary.push({
                symbol: symbolPair,
                marginRatio,
                baseAsset: baseNorm,
                quoteAsset: quoteNorm,
            });
        }
    }
    return { rows, summary };
}

/**
 * Best-effort permission-denied detector. Binance's SAPI returns 401
 * (`-2015`) or 403 when the API key lacks the margin scope. We classify
 * via the message text so any HTTP wrapper around `fetch` still matches.
 */
function isPermissionDenied(err: unknown): boolean {
    if (!err) return false;
    const msg = err instanceof Error ? err.message : String(err);
    return /\b401\b|\b403\b|-2015|forbidden|unauthorized|permission/i.test(msg);
}

/**
 * Per-scope skip-reason classifier for the multi-wallet getBalance log
 * line. The summary line previously hardcoded `reason=PERMISSION_DENIED`
 * for every skipped wallet which was misleading when the real cause was
 * a 5xx / timeout / DNS failure. Schema:
 *
 *   - PERMISSION_DENIED — 401 / 403 / -2015 / "unauthorized" / "forbidden"
 *   - SERVER_ERROR     — 5xx (Binance upstream / proxy failures)
 *   - TIMEOUT          — AbortError, ETIMEDOUT, or "aborted" / "timed out"
 *                        (NOT a bare "timeout" substring, which can appear
 *                        inside an arbitrary upstream `api="..."` message)
 *   - NETWORK_ERROR    — everything else (DNS/connect/refused/reset)
 *
 * Order matters: SERVER_ERROR is checked BEFORE TIMEOUT so an upstream
 * 502 whose body coincidentally says "timeout" still classifies as
 * SERVER_ERROR.
 */
function classifySkipReason(err: unknown): string {
    if (isPermissionDenied(err)) return "PERMISSION_DENIED";
    if (!err) return "NETWORK_ERROR";
    const name = err instanceof Error ? err.name : "";
    const msg = err instanceof Error ? err.message : String(err);
    if (/\b5\d\d\b/.test(msg)) return "SERVER_ERROR";
    if (
        /AbortError|TimeoutError/i.test(name) ||
        /\bETIMEDOUT\b|\baborted?\b|timed out/i.test(msg)
    ) {
        return "TIMEOUT";
    }
    return "NETWORK_ERROR";
}

export class BinanceAccountsService implements ExchangeAccountsService {
    private readonly spot: Spot;
    private readonly wallet: Wallet;
    private readonly apiKey: string;
    private readonly apiSecret: string;

    public constructor(private readonly ctx: BinanceClients) {
        this.spot = ctx.spot;
        this.wallet = ctx.wallet;
        this.apiKey = ctx.apiKey;
        this.apiSecret = ctx.apiSecret;
    }

    public async getBalance(params: GetBalanceParams): Promise<unknown> {
        // Issue 4 — `wallet_type` filter. When the user says "show my
        // spot balance" the LLM extracts `wallet_type: "spot"` and we
        // fetch ONLY that wallet — saves API quota AND suppresses the
        // misleading "permission denied" log noise from margin scopes
        // that the user explicitly didn't ask for. When omitted or set
        // to `"all"` we keep the historical four-wallet fan-out.
        const walletType: GetBalanceParams["wallet_type"] = params?.wallet_type;
        const wantSpot = !walletType || walletType === "all" || walletType === "spot";
        const wantFunding = !walletType || walletType === "all" || walletType === "funding";
        const wantCross =
            !walletType || walletType === "all" || walletType === "margin_cross";
        const wantIsolated =
            !walletType || walletType === "all" || walletType === "margin_isolated";

        const accountReq = { recvWindow: DEFAULT_RECV_WINDOW_MS };
        const fundingReq = { recvWindow: DEFAULT_RECV_WINDOW_MS };

        // Build the fan-out batch dynamically so we only hit the wallets
        // the caller actually asked for. We still use Promise.allSettled
        // (with a 1-element array when only one wallet is requested) so
        // the downstream classification logic remains identical.
        type SettledResult = PromiseSettledResult<unknown>;
        const SKIPPED: SettledResult = {
            status: "rejected",
            reason: new Error("wallet_type filter excluded this scope"),
        };
        // We mark filter-excluded slots with this sentinel reason so the
        // classifier-and-warn block can skip them silently (not a real
        // permission/network error). Anything else is a true failure.
        const FILTER_SENTINEL = "wallet_type filter excluded this scope";

        const tasks: Array<Promise<unknown> | undefined> = [
            wantSpot
                ? unwrapRestData(
                      binanceDebugMeta("spot.getAccount", accountReq),
                      () => this.spot.restAPI.getAccount(accountReq),
                  )
                : undefined,
            wantFunding
                ? unwrapRestData(
                      binanceDebugMeta("wallet.fundingWallet", fundingReq),
                      () => this.wallet.restAPI.fundingWallet(fundingReq),
                  )
                : undefined,
            wantCross ? signedMarginGet(this.apiKey, this.apiSecret) : undefined,
            wantIsolated ? signedIsolatedMarginGet(this.apiKey, this.apiSecret) : undefined,
        ];

        const settled = await Promise.allSettled(
            tasks.map((t) => (t === undefined ? Promise.resolve(undefined) : t)),
        );

        const [spotResult, fundingResult, crossResult, isolatedResult] = tasks.map(
            (t, i): SettledResult => (t === undefined ? SKIPPED : settled[i]),
        ) as [SettledResult, SettledResult, SettledResult, SettledResult];

        const accounts: BinanceBalanceRow[] = [];
        const scopeIncluded: string[] = [];
        const scopeSkipped: Array<{ scope: string; reason: string }> = [];
        let marginSummary:
            | {
                  cross?: CrossMarginNormalized["summary"];
                  isolated?: IsolatedMarginNormalized["summary"];
              }
            | undefined;

        const isFilterExcluded = (reason: unknown): boolean =>
            reason instanceof Error && reason.message === FILTER_SENTINEL;

        // Spot — failure here is unusual (it's the most basic scope) so
        // we log but still return the empty shell so the formatter can
        // present a clean "no spot balance" message.
        if (wantSpot) {
            if (spotResult.status === "fulfilled") {
                accounts.push(...normalizeSpotBalances(spotResult.value));
                scopeIncluded.push("spot");
            } else {
                scopeSkipped.push({
                    scope: "spot",
                    reason: classifySkipReason(spotResult.reason),
                });
                elizaLogger.warn(
                    `[plugin-cex Binance] getBalance spot fetch failed: ${formatAxiosErrorLine(spotResult.reason)}`,
                );
            }
        }

        if (wantFunding) {
            if (fundingResult.status === "fulfilled") {
                accounts.push(...normalizeFundingBalances(fundingResult.value));
                scopeIncluded.push("funding");
            } else if (!isFilterExcluded(fundingResult.reason)) {
                scopeSkipped.push({
                    scope: "funding",
                    reason: classifySkipReason(fundingResult.reason),
                });
            }
        }

        if (wantCross) {
            if (crossResult.status === "fulfilled") {
                const norm = normalizeCrossMargin(crossResult.value);
                if (norm) {
                    accounts.push(...norm.rows);
                    marginSummary = { ...(marginSummary ?? {}), cross: norm.summary };
                    scopeIncluded.push("margin_cross");
                }
            } else if (!isFilterExcluded(crossResult.reason)) {
                scopeSkipped.push({
                    scope: "margin_cross",
                    reason: classifySkipReason(crossResult.reason),
                });
                if (!isPermissionDenied(crossResult.reason)) {
                    elizaLogger.debug(
                        `[plugin-cex Binance] getBalance margin_cross fetch failed: ${formatAxiosErrorLine(crossResult.reason)}`,
                    );
                }
            }
        }

        if (wantIsolated) {
            if (isolatedResult.status === "fulfilled") {
                const norm = normalizeIsolatedMargin(isolatedResult.value);
                if (norm) {
                    accounts.push(...norm.rows);
                    marginSummary = { ...(marginSummary ?? {}), isolated: norm.summary };
                    scopeIncluded.push("margin_isolated");
                }
            } else if (!isFilterExcluded(isolatedResult.reason)) {
                scopeSkipped.push({
                    scope: "margin_isolated",
                    reason: classifySkipReason(isolatedResult.reason),
                });
                if (!isPermissionDenied(isolatedResult.reason)) {
                    elizaLogger.debug(
                        `[plugin-cex Binance] getBalance margin_isolated fetch failed: ${formatAxiosErrorLine(isolatedResult.reason)}`,
                    );
                }
            }
        }

        // Single summary log line — easy to grep in CloudWatch.
        // Schema: `wallets_skipped=<scope>:<REASON>[,<scope>:<REASON>...]`.
        const skippedReason =
            scopeSkipped.length === 0
                ? ""
                : ` wallets_skipped=${scopeSkipped
                      .map((s) => `${s.scope}:${s.reason}`)
                      .join(",")}`;
        const filterTag = walletType ? ` wallet_type=${walletType}` : "";
        elizaLogger.info(
            `[plugin-cex Binance] getBalance${filterTag} scope=${scopeIncluded.join(",") || "none"}${skippedReason}`,
        );

        const result: {
            accounts: BinanceBalanceRow[];
            margin_summary?: typeof marginSummary;
            wallet_type_filter?: GetBalanceParams["wallet_type"];
            walletsReturned?: string[];
            walletsSkipped?: Array<{ scope: string; reason: string }>;
        } = { accounts };
        if (marginSummary) result.margin_summary = marginSummary;
        if (walletType && walletType !== "all") result.wallet_type_filter = walletType;
        // Fix-T1 (post-PR238 UI iter) — surface walletsReturned + walletsSkipped
        // so the renderer can disclose which wallets were checked vs skipped
        // (the same transparency Commit 9 added for get_positions). Without
        // this, a 4-wallet account with isolated-margin permission denied
        // looks identical to a 3-wallet account that doesn't have isolated.
        result.walletsReturned = scopeIncluded;
        if (scopeSkipped.length > 0) result.walletsSkipped = scopeSkipped;
        return result;
    }

    /**
     * Fix 13 — expose the raw cross-margin account snapshot
     * (`GET /sapi/v1/margin/account`) as a service method so the
     * positions / PnL actions can read `marginRatio`, `totalAssetOfBtc`,
     * `totalLiabilityOfBtc`, and per-asset `borrowed` / `interest`
     * fields without re-deriving them from the normalized balance rows
     * (which collapse the wallet metadata). Throws on non-2xx.
     */
    public async getMarginAccount(): Promise<unknown> {
        return signedMarginGet(this.apiKey, this.apiSecret);
    }

    /**
     * Fix 13 — expose the raw isolated-margin account list
     * (`GET /sapi/v1/margin/isolated/account`) as a service method.
     * Per-pair fields include `liquidatePrice`, `marginRatio`,
     * `marginLevel`, `baseAsset.*`, `quoteAsset.*`. Used by
     * `get_positions` (per-pair LIQ price) and `get_pnl` (per-pair
     * unrealized PnL via netAsset summing). Throws on non-2xx.
     */
    public async getIsolatedMarginAccounts(): Promise<unknown> {
        return signedIsolatedMarginGet(this.apiKey, this.apiSecret);
    }

    /**
     * Fix 13 — futures position risk snapshot
     * (`GET /fapi/v2/positionRisk`). Returns one row per symbol the
     * account is configured for, including symbols with
     * `positionAmt=0`. Callers must filter `|positionAmt| < 1e-9` to
     * isolate open positions. Throws on non-2xx — `get_positions`
     * treats permission-denied (futures not enabled on the API key)
     * as a soft skip via `Promise.allSettled`.
     */
    public async getPositionRisk(): Promise<unknown> {
        return getPositionRisk(this.apiKey, this.apiSecret);
    }

    /**
     * Fix 13 — futures account snapshot (`GET /fapi/v2/account`).
     * Currently unused by `get_positions` (which only needs
     * `positionRisk` + margin metadata) but kept on the service so
     * future "futures account dashboard" needs can land in one place.
     */
    public async getFuturesAccount(): Promise<unknown> {
        return getFuturesAccount(this.apiKey, this.apiSecret);
    }

    /**
     * Fix 13 — futures income history (`GET /fapi/v1/income`). Used by
     * `get_pnl` to compute realized PnL for the user's window. The
     * Binance API caps each call to a 7-day window; the caller is
     * responsible for chunking longer windows.
     */
    public async getIncomeHistory(opts: {
        symbol?: string;
        incomeType?: string;
        startTime?: number;
        endTime?: number;
        limit?: number;
    } = {}): Promise<unknown[]> {
        return getIncomeHistory(this.apiKey, this.apiSecret, opts);
    }
}

const BINANCE_SYMBOL_FILTER_TTL_MS = 60 * 60 * 1000;

interface CachedSymbolFilters {
    filters: BinanceSymbolFilters;
    expiresAt: number;
}

// Module-level cache so per-symbol filters (e.g. BTCUSDT) are fetched at most
// once per hour per process. Filter values are stable; the worst-case staleness
// is one rejected order, which is no worse than the pre-fix behavior.
const symbolFiltersCache = new Map<string, CachedSymbolFilters>();

/** Test-only: clear the module-level filters cache so tests can exercise the
 * cold-fetch path without depending on prior test order. */
export function __resetBinanceSymbolFiltersCacheForTests(): void {
    symbolFiltersCache.clear();
}

/**
 * Fix 4 / 4b — Fan-out helper: enumerate the user's currently-held base
 * assets via the shared `BinanceAccountsService` and build candidate
 * trading symbols `<asset>{quote}`. Used by:
 *   - `BinanceOrdersService.getOrders` (no symbol + date window set)
 *   - `BinanceOrdersService.getFills` (no `product_ids` passed)
 *
 * Behavior:
 *   - "Currently-held" = `total > 0` across any wallet (spot / funding /
 *     cross / isolated). The accounts service already coalesces all four.
 *   - Stablecoins (USDT/USDC/BUSD/FDUSD/TUSD) never form the base side of
 *     a candidate pair — `<STABLE>USDT` has no meaningful order history.
 *   - The base asset must NOT equal the quote currency itself.
 *   - Cap is exactly `opts.cap` (default 8). When more than `cap` non-
 *     stablecoin holdings exist we sort by best-effort USD value using
 *     `fetchBinanceUsdtPrices`; on pricing failure we fall back to the
 *     order returned by `getBalance` and take the first `cap`.
 *
 * Returns the candidate trading pairs (e.g. `["BTCUSDT", "ETHUSDT"]`),
 * never throws — a getBalance failure resolves to `[]` so callers can
 * surface a clean "no holdings" error.
 */
export async function enumerateHoldingsForFanOut(
    ctx: BinanceClients,
    opts: { quote?: string; cap?: number; userId?: string } = {},
): Promise<string[]> {
    const quote = (opts.quote ?? "USDT").toUpperCase();
    const cap = Math.max(1, opts.cap ?? 8);
    const userId = (opts.userId ?? "fan-out") as string;

    let balance: unknown;
    try {
        const accountsSvc = new BinanceAccountsService(ctx);
        balance = await accountsSvc.getBalance({ userId } as never);
    } catch (err) {
        elizaLogger.debug(
            `[plugin-cex Binance] enumerateHoldingsForFanOut getBalance failed: ${formatAxiosErrorLine(err)}`,
        );
        return [];
    }

    if (!balance || typeof balance !== "object") return [];
    const accounts = (balance as { accounts?: unknown }).accounts;
    if (!Array.isArray(accounts)) return [];

    // Aggregate per-asset total across all wallets so a user with
    // BTC split across spot+isolated still surfaces once.
    const perAssetTotal = new Map<string, number>();
    for (const row of accounts) {
        if (!row || typeof row !== "object") continue;
        const rec = row as Record<string, unknown>;
        const asset =
            typeof rec.asset === "string"
                ? rec.asset
                : typeof rec.currency === "string"
                  ? (rec.currency as string)
                  : "";
        if (!asset) continue;
        const upper = asset.toUpperCase();
        if (isStablecoin(upper)) continue;
        if (upper === quote) continue;
        const totalRaw = typeof rec.total === "string" ? rec.total : "0";
        const total = Number.parseFloat(totalRaw);
        if (!Number.isFinite(total) || total <= 0) continue;
        const prev = perAssetTotal.get(upper) ?? 0;
        perAssetTotal.set(upper, prev + total);
    }

    if (perAssetTotal.size === 0) return [];

    // Stable insertion order = order returned by getBalance. Used as
    // the fallback when pricing fails.
    const insertionOrder = Array.from(perAssetTotal.keys());

    if (insertionOrder.length <= cap) {
        return insertionOrder.map((a) => `${a}${quote}`);
    }

    // More than cap holdings — best-effort USD ranking. On pricing
    // failure (or partial misses for a subset) we keep the per-asset
    // total alone so deterministic insertion order is the tiebreaker.
    let prices: Record<string, number> = {};
    try {
        prices = await fetchBinanceUsdtPrices(insertionOrder);
    } catch (err) {
        elizaLogger.debug(
            `[plugin-cex Binance] enumerateHoldingsForFanOut pricing failed: ${formatAxiosErrorLine(err)}`,
        );
        prices = {};
    }

    if (Object.keys(prices).length === 0) {
        // Pricing unavailable — preserve insertion order, take the first
        // `cap` assets (per spec).
        return insertionOrder.slice(0, cap).map((a) => `${a}${quote}`);
    }

    const ranked = insertionOrder
        .map((asset, idx) => {
            const total = perAssetTotal.get(asset) ?? 0;
            const px = typeof prices[asset] === "number" ? prices[asset] : 0;
            const usd = total * px;
            return { asset, usd, idx };
        })
        // Sort by USD desc; tiebreak by original insertion order so the
        // ranking is deterministic when several assets share `usd=0`
        // (no quote available).
        .sort((a, b) => b.usd - a.usd || a.idx - b.idx);

    return ranked.slice(0, cap).map((r) => `${r.asset}${quote}`);
}

/**
 * Fix 15 — credential-bound wrapper around `enumerateHoldingsForFanOut`
 * for callers that already have a `ResolvedExchangeCredentials` blob and
 * need the user's candidate symbols. Builds the `BinanceClients` ctx
 * internally; never throws (a failed getBalance returns `[]`).
 */
export async function getCandidateHoldingsSymbols(
    credentials: ResolvedExchangeCredentials,
    opts: { quote?: string; cap?: number; userId?: string } = {},
): Promise<string[]> {
    try {
        const ctx = createBinanceClients(credentials);
        return await enumerateHoldingsForFanOut(ctx, opts);
    } catch (err) {
        elizaLogger.debug(
            `[plugin-cex Binance] getCandidateHoldingsSymbols failed: ${formatAxiosErrorLine(err)}`,
        );
        return [];
    }
}

export class BinanceOrdersService implements ExchangeOrdersService {
    private readonly spot: Spot;
    private readonly apiKey: string;
    private readonly apiSecret: string;

    public constructor(private readonly ctx: BinanceClients) {
        this.spot = ctx.spot;
        this.apiKey = ctx.apiKey;
        this.apiSecret = ctx.apiSecret;
    }

    private async fetchSymbolFilters(symbol: string): Promise<BinanceSymbolFilters> {
        const cacheKey = symbol.toUpperCase();
        const cached = symbolFiltersCache.get(cacheKey);
        const now = Date.now();
        if (cached && cached.expiresAt > now) return cached.filters;

        const req = { symbol: cacheKey };
        const response = await unwrapRestData(
            binanceDebugMeta("spot.exchangeInfo", req),
            () => this.spot.restAPI.exchangeInfo(req),
        );
        const filters = extractBinanceSymbolFiltersFromResponse(response, cacheKey);
        symbolFiltersCache.set(cacheKey, {
            filters,
            expiresAt: now + BINANCE_SYMBOL_FILTER_TTL_MS,
        });
        return filters;
    }

    /**
     * Apply LOT_SIZE / MARKET_LOT_SIZE / PRICE_FILTER to the mapped order body.
     * Best-effort: a failed exchangeInfo fetch must not block an order. The
     * worst case is that Binance rejects an over-precise order — same as before
     * this fix. The minQty pre-check inside `quantizeBinanceOrderBody` is the
     * one exception: it surfaces a clean client-side error instead of relying
     * on Binance's opaque `Filter failure: LOT_SIZE` message.
     */
    private async quantizeOrderBody(
        symbol: string,
        body: Record<string, string | number | boolean | undefined>,
    ): Promise<Record<string, string | number | boolean | undefined>> {
        let filters: BinanceSymbolFilters;
        try {
            filters = await this.fetchSymbolFilters(symbol);
        } catch (err) {
            elizaLogger.warn(
                `[plugin-cex Binance] exchangeInfo fetch failed for ${symbol}; submitting order without quantization. ${formatAxiosErrorLine(err)}`,
            );
            return body;
        }
        return quantizeBinanceOrderBody(body, filters);
    }

    private async resolveSymbolForOpenOrder(orderId: string): Promise<string | undefined> {
        const openReq = { recvWindow: DEFAULT_RECV_WINDOW_MS };
        const open = await unwrapRestData(
            binanceDebugMeta("spot.getOpenOrders", openReq),
            () => this.spot.restAPI.getOpenOrders(openReq),
        );
        if (!Array.isArray(open)) return undefined;
        const hit = open.find(
            (x) =>
                String(x.orderId) === String(orderId) || String(x.clientOrderId) === String(orderId)
        );
        return hit?.symbol;
    }

    public async getOrders(params: GetOrdersParams): Promise<unknown> {
        const symbol =
            params.product_ids?.length && params.product_ids[0]
                ? productIdToBinanceSymbol(params.product_ids[0])
                : undefined;

        const startTime = parseTimestampToMs(params.start_date);
        const endTime = parseTimestampToMs(params.end_date);
        const hasDateWindow = startTime !== undefined || endTime !== undefined;

        // B4 — margin dispatch. When the caller asks for margin orders
        // (the LLM extracts `margin_type` from "my margin orders" / "我的
        // 杠杆订单"), hit `/sapi/v1/margin/openOrders` instead of the spot
        // endpoint. Without this the spot endpoint returns an empty list
        // and the chat replies "you have no orders" — even though the
        // user clearly has open margin orders on Binance.
        if (params.margin_type) {
            const isIsolated = params.margin_type === "ISOLATED" ? "TRUE" : "FALSE";
            // Fix 4 — margin fan-out: when no symbol is given AND a date
            // window is set, enumerate held base assets and fan out
            // `/sapi/v1/margin/allOrders` per candidate pair. Without
            // this the user query "show my margin order history over
            // the past 30 days" was indistinguishable from "show my
            // open margin orders" and silently returned only open
            // positions.
            // CEX post-PR237 Commit 6 — margin fan-out also honors
            // the explicit `history: true` flag so "show my margin
            // order history" works without forcing the user to type
            // a date window.
            // Fix T12 (post-PR238 UI iter) — Binance `/sapi/v1/margin/*`
            // endpoints return `-11019 'Symbol' is mandatory for isolated`
            // when isolated-margin is queried without a symbol. Trigger
            // the holdings fan-out unconditionally for isolated to avoid
            // the upstream rejection, in addition to the existing history
            // and date-window triggers for cross-margin.
            if (
                !symbol &&
                (hasDateWindow ||
                    params.history === true ||
                    isIsolated === "TRUE")
            ) {
                return this.fanOutOrders(params, "margin", isIsolated);
            }
            const raw = await signedMarginOpenOrders(this.apiKey, this.apiSecret, {
                symbol,
                isIsolated,
            });
            let orders = Array.isArray(raw) ? raw : [];
            if (params.order_side) {
                orders = orders.filter((o) => String(o.side).toUpperCase() === params.order_side);
            }
            return { orders };
        }

        if (params.order_ids?.length) {
            const orders: unknown[] = [];
            const openReq = { recvWindow: DEFAULT_RECV_WINDOW_MS };
            const open = await unwrapRestData(
                binanceDebugMeta("spot.getOpenOrders", openReq),
                () => this.spot.restAPI.getOpenOrders(openReq),
            );
            const openById = new Map<string, { symbol?: string }>();
            for (const o of open) {
                if (o.orderId != null) openById.set(String(o.orderId), { symbol: o.symbol });
            }

            for (const oid of params.order_ids) {
                const fromOpen = openById.get(String(oid));
                const sym = fromOpen?.symbol ?? symbol;
                if (!sym) continue;
                try {
                    const getOrderReq = {
                        symbol: sym,
                        orderId: toOrderId(String(oid)),
                        recvWindow: DEFAULT_RECV_WINDOW_MS,
                    };
                    const one = await unwrapRestData(
                        binanceDebugMeta("spot.getOrder", getOrderReq),
                        () => this.spot.restAPI.getOrder(getOrderReq),
                    );
                    orders.push(one);
                } catch {
                    // Order may be historical / wrong symbol; skip missing.
                }
            }

            return { orders };
        }

        const limit = params.limit ?? 500;

        if (symbol) {
            const allOrdersReq = {
                symbol,
                startTime: startTime !== undefined ? BigInt(startTime) : undefined,
                endTime: endTime !== undefined ? BigInt(endTime) : undefined,
                limit: Math.min(limit, 1000),
                recvWindow: DEFAULT_RECV_WINDOW_MS,
            };
            const raw = await unwrapRestData(
                binanceDebugMeta("spot.allOrders", allOrdersReq),
                () => this.spot.restAPI.allOrders(allOrdersReq),
            );
            const orders = Array.isArray(raw) ? raw : [];
            return { orders };
        }

        // Fix 4 — spot fan-out: no symbol AND a date window means the
        // user wants order history, not open orders. Fall back to the
        // open-orders endpoint only when no date window is set (legacy
        // behavior).
        //
        // CEX post-PR237 Commit 6 — Also trigger fan-out when the
        // decomposer set `history: true` even without a date window
        // ("show my recent orders", "what orders have I placed").
        // Without the flag, that prompt collapsed to "open orders"
        // and silently dropped historical fills the user was clearly
        // asking about.
        if (hasDateWindow || params.history === true) {
            return this.fanOutOrders(params, "spot");
        }

        const openListReq = { recvWindow: DEFAULT_RECV_WINDOW_MS };
        const raw = await unwrapRestData(
            binanceDebugMeta("spot.getOpenOrders", openListReq),
            () => this.spot.restAPI.getOpenOrders(openListReq),
        );
        let orders = Array.isArray(raw) ? raw : [];
        if (params.order_side) {
            orders = orders.filter((o) => String(o.side).toUpperCase() === params.order_side);
        }
        return { orders };
    }

    /**
     * Fix 4 — fan out `allOrders` across the user's currently-held base
     * assets and coalesce the results. Sorted by `time` desc, sliced to
     * `params.limit ?? 50`. Returns a `{ orders, scanned_symbols, note }`
     * envelope so the formatter can surface what was scanned.
     *
     * `route` selects the venue endpoint:
     *  - `"spot"`   → `spot.allOrders` (signed `/api/v3/allOrders`)
     *  - `"margin"` → `signedMarginAllOrders` (`/sapi/v1/margin/allOrders`)
     */
    private async fanOutOrders(
        params: GetOrdersParams,
        route: "spot" | "margin",
        isIsolated?: "TRUE" | "FALSE",
    ): Promise<{ orders: unknown[]; scanned_symbols: string[]; note: string }> {
        const startTime = parseTimestampToMs(params.start_date);
        const endTime = parseTimestampToMs(params.end_date);
        const perSymbolLimit = 1000;
        const sliceLimit = params.limit ?? 50;

        const symbols = await enumerateHoldingsForFanOut(this.ctx, {
            quote: params.quote_currency,
            cap: 8,
            userId: (params as { userId?: string }).userId,
        });

        if (symbols.length === 0) {
            // Empty holdings — return an empty envelope. The formatter
            // can render "no holdings to scan" without surfacing an
            // error.
            return {
                orders: [],
                scanned_symbols: [],
                note: "scanned 0 symbols based on current holdings",
            };
        }

        const results = await Promise.allSettled(
            symbols.map(async (sym) => {
                if (route === "margin") {
                    return signedMarginAllOrders(this.apiKey, this.apiSecret, {
                        symbol: sym,
                        startTime,
                        endTime,
                        limit: perSymbolLimit,
                        isIsolated,
                    });
                }
                const allOrdersReq = {
                    symbol: sym,
                    startTime: startTime !== undefined ? BigInt(startTime) : undefined,
                    endTime: endTime !== undefined ? BigInt(endTime) : undefined,
                    limit: perSymbolLimit,
                    recvWindow: DEFAULT_RECV_WINDOW_MS,
                };
                return unwrapRestData(
                    binanceDebugMeta("spot.allOrders", allOrdersReq),
                    () => this.spot.restAPI.allOrders(allOrdersReq),
                );
            }),
        );

        const scannedOk: string[] = [];
        const aggregated: Array<Record<string, unknown>> = [];
        let allFailed = true;
        let lastError: unknown;
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const sym = symbols[i];
            if (r.status === "fulfilled") {
                allFailed = false;
                scannedOk.push(sym);
                const raw = r.value;
                if (Array.isArray(raw)) {
                    for (const row of raw) {
                        if (row && typeof row === "object") {
                            aggregated.push(row as Record<string, unknown>);
                        }
                    }
                }
            } else {
                lastError = r.reason;
                elizaLogger.debug(
                    `[plugin-cex Binance] fanOutOrders ${route} ${sym} failed: ${formatAxiosErrorLine(r.reason)}`,
                );
            }
        }

        if (allFailed) {
            // Fix-T12 iter2 (post-PR242): when EVERY per-symbol call
            // failed with "Isolated margin account does not exist", the
            // user simply hasn't enabled isolated-margin on Binance.
            // That's a SKIP, not a FAIL — the plan step should land as
            // ✅ ok with an empty result + a note, not ❌ failed with a
            // raw upstream error. Specific to isolated route; cross /
            // spot fan-outs surface real errors.
            const errMsg = lastError instanceof Error ? lastError.message : String(lastError ?? "");
            const isIsolatedAccountMissing =
                route === "margin" &&
                isIsolated === "TRUE" &&
                /Isolated\s+margin\s+account\s+does\s+not\s+exist/i.test(errMsg);
            if (isIsolatedAccountMissing) {
                return {
                    orders: [],
                    scanned_symbols: [],
                    note: "isolated-margin account not enabled on this Binance API key",
                };
            }
            // Every per-symbol call rejected; surface the upstream
            // error so the action's catch path can rewrite/render it.
            throw lastError instanceof Error
                ? lastError
                : new Error(String(lastError ?? "fan-out failed for all symbols"));
        }

        // Optional side filter — mirror the open-orders branch.
        let filtered = aggregated;
        if (params.order_side) {
            const side = params.order_side;
            filtered = filtered.filter(
                (o) => String((o as { side?: unknown }).side).toUpperCase() === side,
            );
        }

        // Sort by `time` desc — Binance puts the order's `time` field
        // in ms. Fall back to `updateTime` then 0 so missing fields
        // don't crash the sort.
        const tsOf = (row: Record<string, unknown>): number => {
            const t = (row as { time?: unknown }).time;
            const u = (row as { updateTime?: unknown }).updateTime;
            const pick = (typeof t === "number" ? t : typeof t === "string" ? Number(t) : undefined)
                ?? (typeof u === "number" ? u : typeof u === "string" ? Number(u) : undefined);
            return Number.isFinite(pick) ? (pick as number) : 0;
        };
        filtered.sort((a, b) => tsOf(b) - tsOf(a));

        const sliced = filtered.slice(0, sliceLimit);
        return {
            orders: sliced,
            scanned_symbols: scannedOk,
            note: `scanned ${scannedOk.length} symbols based on current holdings`,
        };
    }

    public async createOrder(params: CreateOrderParams): Promise<unknown> {
        const symbol = productIdToBinanceSymbol(params.product_id);

        // F9 — margin dispatch. CROSS/ISOLATED go through the dedicated
        // /sapi/v1/margin/order endpoint with `sideEffectType` set from
        // the canonical `margin_action`. Paper/shadow mode is handled
        // upstream by the paper venue (the dispatch never reaches here
        // when isPaperMode + isWriteAction in shared.ts).
        if (params.margin_type) {
            return this.createMarginOrder(symbol, params);
        }
        const mapped = mapOrderConfigurationToBinanceParams(
            symbol,
            params.side,
            params.client_order_id,
            params.order_configuration
        );

        if (mapped.__binance_oco === "1") {
            return this.placeOcoOrder(symbol, mapped);
        }

        const body = await this.quantizeOrderBody(symbol, mapped);

        if (body.goodTillDate !== undefined) {
            const stringBody: Record<string, string | number | boolean | undefined> = {};
            for (const [k, v] of Object.entries(body)) {
                stringBody[k] = typeof v === "boolean" ? v : typeof v === "number" ? v : v;
            }
            return signedSpotOrderPost(this.apiKey, this.apiSecret, stringBody);
        }

        try {
            const newOrderReq = mapBodyToNewOrderRequest(body);
            const newClientOrderId =
                typeof body.newClientOrderId === "string"
                    ? body.newClientOrderId
                    : undefined;
            return await unwrapRestData(
                binanceDebugMeta("spot.newOrder", newOrderReq),
                () => this.spot.restAPI.newOrder(newOrderReq),
                { clientOrderId: newClientOrderId ?? params.client_order_id, symbol },
            );
        } catch (e) {
            throw toConnectorError(e);
        }
    }

    /**
     * F9 — CROSS / ISOLATED margin order submission.
     *
     * Maps `params.order_configuration` to the Binance wire body using
     * the same helper as spot, then adds margin-specific fields and
     * routes through `/sapi/v1/margin/order` via `signedMarginOrderPost`.
     */
    private async createMarginOrder(
        symbol: string,
        params: CreateOrderParams,
    ): Promise<unknown> {
        if (!params.margin_type) {
            throw new Error("createMarginOrder requires margin_type");
        }
        const isIsolated = params.margin_type === "ISOLATED";
        const sideEffectType = marginActionToSideEffect(params.margin_action);

        if (isIsolated) {
            // F9 precheck — surface a clear error if the user hasn't
            // opened an isolated margin account for this symbol yet.
            const opened = await precheckIsolatedAccountOpened(
                this.apiKey,
                this.apiSecret,
                symbol,
            );
            if (!opened) {
                throw new Error(
                    `Isolated margin account for ${symbol} is not opened on Binance. ` +
                        "Open it from the Binance UI (Trade → Margin → Isolated → Open) before submitting margin orders for this pair.",
                );
            }
        }

        const mapped = mapOrderConfigurationToBinanceParams(
            symbol,
            params.side,
            params.client_order_id,
            params.order_configuration,
        );
        if (mapped.__binance_oco === "1") {
            throw new Error("OCO is not supported on margin orders in this build.");
        }
        const body = await this.quantizeOrderBody(symbol, mapped);

        const wireBody: Record<string, string | number | boolean | undefined> = {
            ...body,
            isIsolated: isIsolated ? "TRUE" : "FALSE",
            sideEffectType,
        };
        return signedMarginOrderPost(this.apiKey, this.apiSecret, wireBody);
    }

    private async placeOcoOrder(
        symbol: string,
        mapped: Record<string, string | number | boolean | undefined>,
    ): Promise<unknown> {
        const quantity = parseNum(mapped.quantity);
        const abovePrice = parseNum(mapped.abovePrice);
        const belowStopPrice = parseNum(mapped.belowStopPrice);
        const belowPrice = parseNum(mapped.belowPrice);
        if (
            quantity === undefined ||
            abovePrice === undefined ||
            belowStopPrice === undefined ||
            belowPrice === undefined
        ) {
            throw new Error("oco_gtc requires base_size, above_limit_price, below_stop_price, and below_limit_price");
        }
        const sideValue = String(mapped.side ?? "").toUpperCase();
        if (sideValue !== "BUY" && sideValue !== "SELL") {
            throw new Error("oco_gtc requires side BUY or SELL");
        }
        const tifRaw = String(mapped.belowTimeInForce ?? "GTC").toUpperCase();
        const belowTif: SpotRestAPI.OrderListOcoBelowTimeInForceEnum =
            tifRaw === "IOC"
                ? SpotRestAPI.OrderListOcoBelowTimeInForceEnum.IOC
                : tifRaw === "FOK"
                  ? SpotRestAPI.OrderListOcoBelowTimeInForceEnum.FOK
                  : SpotRestAPI.OrderListOcoBelowTimeInForceEnum.GTC;
        const ocoReq: SpotRestAPI.OrderListOcoRequest = {
            symbol,
            side:
                sideValue === "SELL"
                    ? SpotRestAPI.OrderListOcoSideEnum.SELL
                    : SpotRestAPI.OrderListOcoSideEnum.BUY,
            quantity,
            aboveType: SpotRestAPI.OrderListOcoAboveTypeEnum.LIMIT_MAKER,
            belowType: SpotRestAPI.OrderListOcoBelowTypeEnum.STOP_LOSS_LIMIT,
            abovePrice,
            belowStopPrice,
            belowPrice,
            belowTimeInForce: belowTif,
            recvWindow: DEFAULT_RECV_WINDOW_MS,
        };
        try {
            const clientOrderId =
                typeof mapped.newClientOrderId === "string"
                    ? mapped.newClientOrderId
                    : undefined;
            return await unwrapRestData(
                binanceDebugMeta("spot.orderListOco", ocoReq),
                () => this.spot.restAPI.orderListOco(ocoReq),
                { clientOrderId, symbol },
            );
        } catch (e) {
            throw toConnectorError(e);
        }
    }

    public async cancelOrder(params: CancelOrderParams & { all_open?: boolean }): Promise<unknown> {
        const explicitSymbol = params.product_id
            ? productIdToBinanceSymbol(params.product_id)
            : undefined;
        const cancelOpenReq = { recvWindow: DEFAULT_RECV_WINDOW_MS };
        const open = await unwrapRestData(
            binanceDebugMeta("spot.getOpenOrders", cancelOpenReq),
            () => this.spot.restAPI.getOpenOrders(cancelOpenReq),
        );
        const orderIdToSymbol = new Map<string, string>();
        for (const o of open) {
            if (o.orderId != null && o.symbol) orderIdToSymbol.set(String(o.orderId), o.symbol);
        }

        // M3 iter6 (post-PR246): when `all_open: true` and no explicit
        // order_ids were supplied, populate the id list from the venue's
        // open-orders snapshot we just fetched. The user's "cancel all
        // my orders" / "请取消所有" intent fans out atomically here
        // rather than being split into a fetch-then-cancel decomposer
        // plan that would lose the ids at step boundaries.
        const explicitIds = Array.isArray(params.order_ids) ? params.order_ids : [];
        let effectiveIds = explicitIds;
        if (effectiveIds.length === 0 && params.all_open === true) {
            effectiveIds = Array.from(orderIdToSymbol.keys());
            elizaLogger.info(
                `[plugin-cex Binance] cancel_order all_open=true expanded to ${effectiveIds.length} open order(s)`,
            );
        }

        const results: Array<Record<string, unknown>> = [];
        for (const orderId of effectiveIds) {
            const sym = orderIdToSymbol.get(String(orderId)) ?? explicitSymbol;
            if (!sym) {
                results.push({
                    order_id: orderId,
                    success: false,
                    reason: "symbol unknown; provide product_id for Binance cancel when order is not currently open",
                });
                continue;
            }
            try {
                const delReq = {
                    symbol: sym,
                    orderId: toOrderId(String(orderId)),
                    recvWindow: DEFAULT_RECV_WINDOW_MS,
                };
                const data = await unwrapRestData(
                    binanceDebugMeta("spot.deleteOrder", delReq),
                    () => this.spot.restAPI.deleteOrder(delReq),
                    { symbol: sym },
                );
                results.push({ order_id: orderId, success: true, result: data });
            } catch (e) {
                results.push({
                    order_id: orderId,
                    success: false,
                    reason: e instanceof Error ? e.message : String(e),
                });
            }
        }

        // M3 iter6: surface a count + skipped-summary so the renderer
        // can show "cancelled N of M" without re-counting downstream.
        const cancelled_count = results.filter((r) => r.success === true).length;
        const failed = results.filter((r) => r.success === false) as Array<{
            order_id: string;
            reason: string;
        }>;
        return { results, cancelled_count, failed_count: failed.length, failed, all_open_expanded: explicitIds.length === 0 && params.all_open === true };
    }

    public async getFills(params: GetFillsParams): Promise<unknown> {
        const symbol =
            params.product_ids?.length && params.product_ids[0]
                ? productIdToBinanceSymbol(params.product_ids[0])
                : undefined;

        const startTime = parseTimestampToMs(params.start_sequence_timestamp);
        const endTime = parseTimestampToMs(params.end_sequence_timestamp);
        const limit = params.limit ?? 500;

        // Fix 4b — fan-out path: when no `product_ids` is provided,
        // enumerate the user's held base assets and call `spot.myTrades`
        // per candidate pair. Coalesce + sort desc + slice to
        // `params.limit ?? 50`. Without this the action threw the
        // confusing `productids is required` error even when the user
        // clearly asked "what is my trade history".
        if (!symbol) {
            return this.fanOutFills(params);
        }

        const myTradesReq = {
            symbol,
            startTime: startTime !== undefined ? BigInt(startTime) : undefined,
            endTime: endTime !== undefined ? BigInt(endTime) : undefined,
            limit: Math.min(limit, 1000),
            recvWindow: DEFAULT_RECV_WINDOW_MS,
        };
        const raw = await unwrapRestData(
            binanceDebugMeta("spot.myTrades", myTradesReq),
            () => this.spot.restAPI.myTrades(myTradesReq),
        );

        let fills = Array.isArray(raw) ? raw : [];

        if (params.order_ids?.length) {
            const ids = new Set(params.order_ids.map(String));
            fills = fills.filter((t) => ids.has(String(t.orderId)));
        }

        return { fills };
    }

    /**
     * Fix 4b — fan out `spot.myTrades` across the user's currently-held
     * base assets and coalesce the results. Sorted by `time` desc,
     * sliced to `params.limit ?? 50`. Returns a `{ fills, scanned_symbols,
     * note }` envelope mirroring `fanOutOrders`.
     */
    private async fanOutFills(
        params: GetFillsParams,
    ): Promise<{ fills: unknown[]; scanned_symbols: string[]; note: string }> {
        const startTime = parseTimestampToMs(params.start_sequence_timestamp);
        const endTime = parseTimestampToMs(params.end_sequence_timestamp);
        const perSymbolLimit = 1000;
        const sliceLimit = params.limit ?? 50;

        const symbols = await enumerateHoldingsForFanOut(this.ctx, {
            quote: params.quote_currency,
            cap: 8,
            userId: (params as { userId?: string }).userId,
        });

        if (symbols.length === 0) {
            return {
                fills: [],
                scanned_symbols: [],
                note: "scanned 0 symbols based on current holdings",
            };
        }

        const results = await Promise.allSettled(
            symbols.map(async (sym) => {
                const myTradesReq = {
                    symbol: sym,
                    startTime: startTime !== undefined ? BigInt(startTime) : undefined,
                    endTime: endTime !== undefined ? BigInt(endTime) : undefined,
                    limit: perSymbolLimit,
                    recvWindow: DEFAULT_RECV_WINDOW_MS,
                };
                return unwrapRestData(
                    binanceDebugMeta("spot.myTrades", myTradesReq),
                    () => this.spot.restAPI.myTrades(myTradesReq),
                );
            }),
        );

        const scannedOk: string[] = [];
        const aggregated: Array<Record<string, unknown>> = [];
        let allFailed = true;
        let lastError: unknown;
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const sym = symbols[i];
            if (r.status === "fulfilled") {
                allFailed = false;
                scannedOk.push(sym);
                const raw = r.value;
                if (Array.isArray(raw)) {
                    for (const row of raw) {
                        if (row && typeof row === "object") {
                            aggregated.push(row as Record<string, unknown>);
                        }
                    }
                }
            } else {
                lastError = r.reason;
                elizaLogger.debug(
                    `[plugin-cex Binance] fanOutFills ${sym} failed: ${formatAxiosErrorLine(r.reason)}`,
                );
            }
        }

        if (allFailed) {
            throw lastError instanceof Error
                ? lastError
                : new Error(String(lastError ?? "fan-out failed for all symbols"));
        }

        // Optional order-id filter — mirror the symbol-only branch.
        let filtered = aggregated;
        if (params.order_ids?.length) {
            const ids = new Set(params.order_ids.map(String));
            filtered = filtered.filter(
                (t) => ids.has(String((t as { orderId?: unknown }).orderId)),
            );
        }

        const tsOf = (row: Record<string, unknown>): number => {
            const t = (row as { time?: unknown }).time;
            const pick = typeof t === "number" ? t : typeof t === "string" ? Number(t) : 0;
            return Number.isFinite(pick) ? pick : 0;
        };
        filtered.sort((a, b) => tsOf(b) - tsOf(a));

        const sliced = filtered.slice(0, sliceLimit);
        return {
            fills: sliced,
            scanned_symbols: scannedOk,
            note: `scanned ${scannedOk.length} symbols based on current holdings`,
        };
    }

    public async editOrder(params: EditOrderParams): Promise<unknown> {
        const symbol = (await this.resolveSymbolForOpenOrder(params.orderId)) ?? undefined;
        if (!symbol) {
            throw new Error(
                `Cannot resolve symbol for order ${params.orderId}; ensure the order is open on Binance Spot`
            );
        }

        const editGetReq = {
            symbol,
            orderId: toOrderId(params.orderId),
            recvWindow: DEFAULT_RECV_WINDOW_MS,
        };
        const current = (await unwrapRestData(
            binanceDebugMeta("spot.getOrder", editGetReq),
            () => this.spot.restAPI.getOrder(editGetReq),
        )) as Record<string, unknown>;

        const side = String(current.side ?? "");
        const type = String(current.type ?? "LIMIT");
        const quantity =
            params.size ?? String(current.origQty ?? current.executedQty ?? "");

        if (!quantity) {
            throw new Error("editOrder requires size or visible remaining quantity on the Binance order");
        }

        const qtyNum = parseNum(quantity);
        if (qtyNum === undefined) {
            throw new Error("editOrder could not parse quantity for cancel/replace");
        }
        const priceNum = parseNum(params.price ?? String(current.price ?? ""));

        const tif = current.timeInForce;
        let timeInForce: SpotRestAPI.OrderCancelReplaceTimeInForceEnum | undefined;
        if (typeof tif === "string" && tif.length > 0) {
            const u = tif.toUpperCase();
            if (u === "GTC") timeInForce = SpotRestAPI.OrderCancelReplaceTimeInForceEnum.GTC;
            else if (u === "IOC") timeInForce = SpotRestAPI.OrderCancelReplaceTimeInForceEnum.IOC;
            else if (u === "FOK") timeInForce = SpotRestAPI.OrderCancelReplaceTimeInForceEnum.FOK;
        }

        const replaceSide =
            side === "SELL"
                ? SpotRestAPI.OrderCancelReplaceSideEnum.SELL
                : SpotRestAPI.OrderCancelReplaceSideEnum.BUY;

        try {
            const cancelReplaceReq = {
                symbol,
                cancelReplaceMode: SpotRestAPI.OrderCancelReplaceCancelReplaceModeEnum.ALLOW_FAILURE,
                cancelOrderId: toOrderId(params.orderId),
                side: replaceSide,
                type: mapStringToCancelReplaceType(type),
                quantity: qtyNum,
                price: priceNum,
                timeInForce,
                recvWindow: DEFAULT_RECV_WINDOW_MS,
            };
            return await unwrapRestData(
                binanceDebugMeta("spot.orderCancelReplace", cancelReplaceReq),
                () => this.spot.restAPI.orderCancelReplace(cancelReplaceReq),
                { symbol },
            );
        } catch (e) {
            throw toConnectorError(e);
        }
    }

    public async closePosition(params: ClosePositionParams): Promise<unknown> {
        const symbol = productIdToBinanceSymbol(params.product_id);
        const newClientOrderId = params.client_order_id.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 36);
        const qty = parseNum(String(params.size));
        if (qty === undefined) {
            throw new Error("closePosition requires a valid numeric size");
        }
        try {
            const closeReq = {
                symbol,
                side: SpotRestAPI.NewOrderSideEnum.SELL,
                type: SpotRestAPI.NewOrderTypeEnum.MARKET,
                quantity: qty,
                newClientOrderId,
                recvWindow: DEFAULT_RECV_WINDOW_MS,
            };
            return await unwrapRestData(
                binanceDebugMeta("spot.newOrder.closePosition", closeReq),
                () => this.spot.restAPI.newOrder(closeReq),
                { clientOrderId: newClientOrderId, symbol },
            );
        } catch (e) {
            throw toConnectorError(e);
        }
    }
}

export class BinanceExchangeService implements ExchangeService {
    public readonly exchange = "binance" as const;
    public readonly accounts: ExchangeAccountsService;
    public readonly orders: ExchangeOrdersService;

    public constructor(credentials: ResolvedExchangeCredentials) {
        const ctx = createBinanceClients(credentials);
        this.accounts = new BinanceAccountsService(ctx);
        this.orders = new BinanceOrdersService(ctx);
    }
}
