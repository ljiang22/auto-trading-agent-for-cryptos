import { elizaLogger, formatAxiosErrorLine, httpClient } from "@elizaos/core";
import { signJwt } from "../auth";
import { sanitizeForLog, summarizeResponseForLog } from "../safeHttpLog";
import { summarizeCoinbaseErrorBody } from "../summarizeCoinbaseErrorBody";
import { mapProductIdsForCoinbaseApi, productIdToCoinbaseProductId } from "./coinbaseProductId";
import {
    quantizeCoinbaseOrderConfiguration,
    type CoinbaseProductMeta,
} from "./coinbaseQuantization";
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

const COINBASE_BASE_URL = process.env.COINBASE_BASE_URL?.trim() || "https://api.coinbase.com";

const COINBASE_PRODUCT_META_TTL_MS = 60 * 60 * 1000;

interface CachedProductMeta {
    meta: CoinbaseProductMeta;
    expiresAt: number;
}

// Module-level cache so increments for popular pairs (e.g. BTC-USDC) are fetched
// at most once per hour per process. Increments are stable; product retirement is
// rare and the worst-case staleness is one rejected order.
const productMetaCache = new Map<string, CachedProductMeta>();

function extractProductMeta(raw: unknown): CoinbaseProductMeta {
    if (raw === null || typeof raw !== "object") return {};
    const obj = raw as Record<string, unknown>;
    const out: CoinbaseProductMeta = {};
    if (typeof obj.base_increment === "string") out.base_increment = obj.base_increment;
    if (typeof obj.quote_increment === "string") out.quote_increment = obj.quote_increment;
    if (typeof obj.price_increment === "string") out.price_increment = obj.price_increment;
    return out;
}

// Coinbase REST implementation for the trade plugin.
// Depends on @elizaos/core httpClient and the plugin-cex exchange service contracts.
function compact(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null)
    );
}

function requireAuthString(credentials: ResolvedExchangeCredentials, key: string): string {
    const value = credentials.auth?.[key];
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`Missing required auth field "${key}" for ${credentials.exchange}`);
    }
    return value.trim();
}

function isHttpErrorPayload(err: unknown): err is { response?: { status?: number; statusText?: string; data?: unknown } } {
    return typeof err === "object" && err !== null && "response" in err;
}

function toCoinbaseUserFacingError(err: unknown, pathname: string): Error {
    if (!isHttpErrorPayload(err) || err.response?.status === undefined) {
        return err instanceof Error ? err : new Error(String(err));
    }
    const summary = summarizeCoinbaseErrorBody(err.response.data);
    const base = err instanceof Error ? err.message : "Coinbase request failed";
    if (!summary) return err instanceof Error ? err : new Error(String(err));
    const wrapped = new Error(`${base} (${pathname}): ${summary}`);
    if (err instanceof Error) {
        wrapped.cause = err;
    }
    return wrapped;
}

function toRfc3339Timestamp(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;

    // Support callers passing epoch seconds/milliseconds as strings.
    if (/^\d+$/.test(trimmed)) {
        const num = Number(trimmed);
        if (Number.isFinite(num)) {
            // Assume seconds if it's not already in milliseconds.
            const ms = num < 1e12 ? num * 1000 : num;
            const d = new Date(ms);
            if (!Number.isNaN(d.getTime())) {
                return d.toISOString();
            }
        }
    }

    const d = new Date(trimmed);
    if (!Number.isNaN(d.getTime())) {
        return d.toISOString();
    }

    // If it can't be parsed, return the original value and let Coinbase reject it.
    return trimmed;
}

interface GenerateCoinbaseAdvancedTradeJWTParams {
    keyName: string;
    privateKey: string;
    method: string;
    host: string;
    path: string;
}

function generateCoinbaseAdvancedTradeJWT(params: GenerateCoinbaseAdvancedTradeJWTParams): string {
    const { keyName, privateKey, method, host, path } = params;

    const nowSeconds = Math.floor(Date.now() / 1000);
    const uri = `${method.toUpperCase()} ${host}${path}`;

    const payload: Record<string, unknown> = {
        iss: "cdp",
        sub: keyName,
        nbf: nowSeconds,
        exp: nowSeconds + 120,
        uri,
    };
    
    return signJwt({
        privateKey,
        keyId: keyName,
        algorithm: "ES256",
        payload,
    });    
}

function buildCoinbaseAuthHeader(
    credentials: ResolvedExchangeCredentials,
    options: { method: string; host: string; pathWithQuery: string }
): string {
    if (credentials.authType === "oauth_access_refresh_token") {
        const accessToken = requireAuthString(credentials, "accessToken");
        return `Bearer ${accessToken}`;
    }

    if (credentials.authType === "api_key_name_secret") {
        const keyName = requireAuthString(credentials, "apiKeyName");
        const privateKey = requireAuthString(credentials, "apiKeySecret");
        const jwt = generateCoinbaseAdvancedTradeJWT({
            keyName,
            privateKey,
            method: options.method,
            host: options.host,
            path: options.pathWithQuery,
        });
        return `Bearer ${jwt}`;
    }

    throw new Error(`Unsupported authType "${credentials.authType}" for ${credentials.exchange}`);
}

class CoinbaseRestClient {
    protected readonly baseUrl: string;
    protected readonly credentials: ResolvedExchangeCredentials;

    public constructor(credentials: ResolvedExchangeCredentials) {
        this.baseUrl = COINBASE_BASE_URL;
        this.credentials = credentials;
    }

    protected buildHeaders(options: { method: string; host: string; pathWithQuery: string }): Record<string, string> {
        return {
            Authorization: buildCoinbaseAuthHeader(this.credentials, options),
            "Content-Type": "application/json",
        };
    }

    protected async request(
        method: "GET" | "POST",
        path: string,
        options: {
            params?: Record<string, unknown>;
            data?: Record<string, unknown>;
            isWrite?: boolean;
            clientOrderId?: string;
            symbol?: string;
        } = {}
    ): Promise<unknown> {
        const url = new URL(path, this.baseUrl);

        if (options.params) {
            for (const [key, value] of Object.entries(options.params)) {
                if (value === undefined || value === null) {
                    continue;
                }

                if (Array.isArray(value)) {
                    for (const item of value) {
                        url.searchParams.append(key, String(item));
                    }
                    continue;
                }

                url.searchParams.set(key, String(value));
            }
        }

        const headers = this.buildHeaders({
            method,
            host: url.host,
            // Coinbase JWT "uri" claim should not include query parameters.
            // We still include query params in the actual HTTP request URL below.
            pathWithQuery: url.pathname,
        });

        const pathname = url.pathname;
        const queryForLog = Object.fromEntries(url.searchParams.entries());

        const requestBody =
            method === "POST"
                ? options.data ?? {}
                : { query: queryForLog };

        const out = await callVenueWithRetry({
            venue: "coinbase",
            endpoint: pathname,
            method,
            request_body: requestBody,
            is_write: options.isWrite,
            client_order_id: options.clientOrderId,
            symbol: options.symbol,
            invoke: async () => {
                const start = Date.now();
                let response: { status: number; statusText: string; data: unknown };
                try {
                    response = method === "GET"
                        ? await httpClient.get(url.toString(), {
                            headers,
                            timeout: 15_000,
                        })
                        : await httpClient.post(url.toString(), options.data ?? {}, {
                            headers,
                            timeout: 15_000,
                        });
                } catch (err) {
                    const durationMs = Date.now() - start;
                    if (isHttpErrorPayload(err) && err.response?.status !== undefined) {
                        elizaLogger.debug(
                            `[plugin-cex Coinbase] ${method} ${pathname} status=${err.response.status} durationMs=${durationMs} query=${JSON.stringify(sanitizeForLog(queryForLog))} response=${JSON.stringify(summarizeResponseForLog(err.response.data))} (error)`
                        );
                    } else {
                        elizaLogger.debug(
                            `[plugin-cex Coinbase] ${method} ${pathname} durationMs=${durationMs} query=${JSON.stringify(sanitizeForLog(queryForLog))} (error) ${formatAxiosErrorLine(err)}`
                        );
                    }
                    throw err;
                }
                const durationMs = Date.now() - start;
                if (response.status < 200 || response.status >= 300) {
                    elizaLogger.debug(
                        `[plugin-cex Coinbase] ${method} ${pathname} status=${response.status} durationMs=${durationMs} query=${JSON.stringify(sanitizeForLog(queryForLog))} response=${JSON.stringify(summarizeResponseForLog(response.data))} (non-success)`
                    );
                    const wrappedErr: { response: { status: number; statusText: string; data: unknown } } = {
                        response: { status: response.status, statusText: response.statusText, data: response.data },
                    };
                    throw wrappedErr;
                }
                elizaLogger.debug(
                    `[plugin-cex Coinbase] ${method} ${pathname} status=${response.status} durationMs=${durationMs} query=${JSON.stringify(sanitizeForLog(queryForLog))} response=${JSON.stringify(summarizeResponseForLog(response.data))}`
                );
                elizaLogger.debug(
                    `[plugin-cex Coinbase] ${method} ${pathname} body=${JSON.stringify(sanitizeForLog(options.data ?? {}))}`
                );
                return {
                    http_status: response.status,
                    body: response.data,
                    latency_ms: durationMs,
                };
            },
        }).catch((err) => {
            throw toCoinbaseUserFacingError(err, pathname);
        });

        return out.body;
    }
}

export class CoinbaseAccountsService extends CoinbaseRestClient implements ExchangeAccountsService {
    public async getBalance(params: GetBalanceParams): Promise<unknown> {
        return this.request(
            "GET",
            "/api/v3/brokerage/accounts",
            {
                params: compact({
                    limit: params.limit,
                    cursor: params.cursor,
                    retail_portfolio_id: params.retail_portfolio_id,
                }),
            }
        );
    }
}

export class CoinbaseOrdersService extends CoinbaseRestClient implements ExchangeOrdersService {
    public async getOrders(params: GetOrdersParams): Promise<unknown> {
        return this.request(
            "GET",
            "/api/v3/brokerage/orders/historical/batch",
            {
                params: compact({
                    order_ids: params.order_ids,
                    product_ids: mapProductIdsForCoinbaseApi(params.product_ids),
                    order_status: params.order_status,
                    limit: params.limit,
                    cursor: params.cursor,
                    start_date: toRfc3339Timestamp(params.start_date),
                    end_date: toRfc3339Timestamp(params.end_date),
                    order_side: params.order_side,
                    order_types: params.order_types,
                    product_type: params.product_type,
                }),
            }
        );
    }

    private async fetchProductMeta(productId: string): Promise<CoinbaseProductMeta> {
        const cached = productMetaCache.get(productId);
        const now = Date.now();
        if (cached && cached.expiresAt > now) return cached.meta;

        const raw = await this.request("GET", `/api/v3/brokerage/products/${encodeURIComponent(productId)}`);
        const meta = extractProductMeta(raw);
        productMetaCache.set(productId, { meta, expiresAt: now + COINBASE_PRODUCT_META_TTL_MS });
        return meta;
    }

    private async quantizeOrderConfiguration(
        productId: string,
        orderConfiguration: OrderConfiguration,
    ): Promise<OrderConfiguration> {
        let meta: CoinbaseProductMeta;
        try {
            meta = await this.fetchProductMeta(productId);
        } catch (err) {
            // Best-effort: a products-endpoint outage must not block an order. The
            // worst case is that Coinbase rejects an over-precise order — same as
            // before this fix.
            elizaLogger.warn(
                `[plugin-cex Coinbase] product metadata fetch failed for ${productId}; submitting order without quantization. ${formatAxiosErrorLine(err)}`
            );
            return orderConfiguration;
        }
        return quantizeCoinbaseOrderConfiguration(orderConfiguration, meta);
    }

    public async createOrder(params: CreateOrderParams): Promise<unknown> {
        const productId = productIdToCoinbaseProductId(params.product_id);
        const quantizedOrderConfiguration = await this.quantizeOrderConfiguration(
            productId,
            params.order_configuration,
        );
        return this.request(
            "POST",
            "/api/v3/brokerage/orders",
            {
                data: compact({
                    client_order_id: params.client_order_id,
                    product_id: productId,
                    side: params.side,
                    order_configuration: quantizedOrderConfiguration,
                    leverage: params.leverage,
                    margin_type: params.margin_type,
                    preview_id: params.preview_id,
                    retail_portfolio_id: params.retail_portfolio_id,
                }),
                isWrite: true,
                clientOrderId: params.client_order_id,
                symbol: productId,
            }
        );
    }

    public async cancelOrder(params: CancelOrderParams): Promise<unknown> {
        return this.request(
            "POST",
            "/api/v3/brokerage/orders/batch_cancel",
            {
                data: {
                    order_ids: params.order_ids,
                },
                isWrite: true,
                symbol: params.product_id
                    ? productIdToCoinbaseProductId(params.product_id)
                    : undefined,
            }
        );
    }

    public async getFills(params: GetFillsParams): Promise<unknown> {
        return this.request(
            "GET",
            "/api/v3/brokerage/orders/historical/fills",
            {
                params: compact({
                    order_ids: params.order_ids,
                    trade_ids: params.trade_ids,
                    product_ids: mapProductIdsForCoinbaseApi(params.product_ids),
                    limit: params.limit,
                    cursor: params.cursor,
                    start_sequence_timestamp: toRfc3339Timestamp(params.start_sequence_timestamp),
                    end_sequence_timestamp: toRfc3339Timestamp(params.end_sequence_timestamp),
                    retail_portfolio_id: params.retail_portfolio_id,
                }),
            }
        );
    }

    public async editOrder(params: EditOrderParams): Promise<unknown> {
        return this.request(
            "POST",
            "/api/v3/brokerage/orders/edit",
            {
                data: compact({
                    order_id: params.orderId,
                    price: params.price,
                    size: params.size,
                    attached_order_configuration: params.attachedOrderConfiguration,
                    stop_price: params.stopPrice,
                }),
                isWrite: true,
            }
        );
    }

    public async closePosition(params: ClosePositionParams): Promise<unknown> {
        const productId = productIdToCoinbaseProductId(params.product_id);
        return this.request(
            "POST",
            "/api/v3/brokerage/orders/close_position",
            {
                data: {
                    client_order_id: params.client_order_id,
                    product_id: productId,
                    size: params.size,
                },
                isWrite: true,
                clientOrderId: params.client_order_id,
                symbol: productId,
            }
        );
    }
}

export class CoinbaseExchangeService implements ExchangeService {
    public readonly exchange = "coinbase" as const;
    public readonly accounts: ExchangeAccountsService;
    public readonly orders: ExchangeOrdersService;

    public constructor(credentials: ResolvedExchangeCredentials) {
        this.accounts = new CoinbaseAccountsService(credentials);
        this.orders = new CoinbaseOrdersService(credentials);
    }
}
