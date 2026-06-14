import type {
    Action,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    Validator,
} from "@elizaos/core";
import {
    createActionErrorResponse,
    createActionResponse,
    elizaLogger,
    stringToUuid,
} from "@elizaos/core";
import { createExchangeService } from "../exchanges/registry";
import {
    normalizeCEXErrorEnvelope,
    normalizeCEXResultEnvelope,
    preflightValidateForExchange,
} from "../spec/canonical";
import type {
    CancelOrderParams,
    OrderConfiguration,
    CreateOrderParams,
    ExchangeService,
    GetBalanceParams,
    GetFillsParams,
    GetOrdersParams,
    TradeActionBaseParams,
} from "../types";
import type {
    AuthsForExchange,
    DefaultExchangeAuth,
    ExchangeAuthFieldValues,
    ExchangeAuths,
    ExchangeAuthType,
    ExchangeId,
    ExchangeRegistryEntry,
    UUID,
    EncryptedSecret,
} from "@elizaos/core";
import { decrypt, isEncrypted } from "@elizaos/core";
import { createPaperVenue } from "../exchanges/services/paperVenue";
import {
    type PaperOrdersAdapter,
    createAdapterBackedPaperOrderStore,
    createInMemoryPaperOrderStore,
} from "../exchanges/services/paperOrderStore";
import {
    fetchBinanceUsdtPrices,
    isStablecoin,
} from "../exchanges/services/binancePricing";

/**
 * Internal-only action option: resolve credentials from `account.details.exchangeAuths[exchangeId]`
 * (picking a stored auth type under that exchange) instead of `defaultExchangeAuth`.
 * Used by integration tests when one user has multiple exchanges configured.
 */
export const PLUGIN_CEX_INTERNAL_PREFER_EXCHANGE_ID = "__plugin_cex_prefer_exchange_id";

// Shared action wrapper for plugin-cex.
// Depends on the exchange registry for service selection and ElizaOS action response helpers.
type TradeActionType =
    | "get_balance"
    | "get_orders"
    | "create_order"
    | "cancel_order"
    | "get_fills";

/**
 * Resolved execution mode of an action call. Set fail-closed to "live"
 * unless the per-message `mode` override or persisted user pref says
 * otherwise. Threaded into templates (F1) and the action-response
 * envelope so downstream renderers can show the paper/shadow badge
 * without re-resolving.
 */
export type ResolvedActionMode = "live" | "paper" | "shadow";

type TradeActionConfig<T extends TradeActionBaseParams, TResult = unknown> = {
    name: TradeActionType;
    description: string;
    examples: Action["examples"];
    validateParams: (params: Record<string, unknown>) => T;
    handler: (service: ExchangeService, params: T) => Promise<TResult>;
    outputTemplate: (params: T, result: TResult, mode?: ResolvedActionMode) => string;
    errorTemplate: (params: Partial<T>, error: unknown, mode?: ResolvedActionMode) => string;
};

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function getString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }

    return undefined;
}

function getStringArray(value: unknown): string[] | undefined {
    if (Array.isArray(value)) {
        const items = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
        return items.length > 0 ? items : undefined;
    }

    const single = getString(value);
    return single ? [single] : undefined;
}

function requireString(params: Record<string, unknown>, fieldName: string): string {
    const value = getString(params[fieldName]);
    if (!value) {
        throw new Error(`"${fieldName}" is required`);
    }

    return value;
}

function requireStringArray(params: Record<string, unknown>, fieldName: string): string[] {
    const value = getStringArray(params[fieldName]);
    if (!value || value.length === 0) {
        throw new Error(`"${fieldName}" is required`);
    }

    return value;
}

function requireEnum<T extends string>(params: Record<string, unknown>, fieldName: string, allowed: T[]): T {
    const value = requireString(params, fieldName).toUpperCase();
    if (!allowed.includes(value as T)) {
        throw new Error(`"${fieldName}" must be one of: ${allowed.join(", ")}`);
    }

    return value as T;
}

function requireObject(params: Record<string, unknown>, fieldName: string): Record<string, unknown> {
    const raw = params[fieldName];
    const value =
        typeof raw === "string"
            ? (() => {
                  const trimmed = raw.trim();
                  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
                      return raw;
                  }
                  try {
                      return JSON.parse(trimmed);
                  } catch {
                      return raw;
                  }
              })()
            : raw;

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`"${fieldName}" must be an object`);
    }

    return value as Record<string, unknown>;
}

const ORDER_CONFIGURATION_SPECS: Partial<
    Record<
        keyof OrderConfiguration,
        {
            requiredAnyOf?: string[];
            requiredAll?: string[];
            uiLabel: string;
            uiDescription: string;
        }
    >
> = {
    market_market_ioc: {
        requiredAnyOf: ["base_size", "quote_size"],
        uiLabel: "Market (IOC)",
        uiDescription:
            "Market order that executes immediately at the best available price. Any unfilled portion is cancelled.",
    },
    market_market_fok: {
        requiredAnyOf: ["base_size", "quote_size"],
        uiLabel: "Market (FOK)",
        uiDescription:
            "Market order that must be filled completely immediately. If it cannot fully fill right away, it is cancelled.",
    },
    limit_limit_gtc: {
        requiredAll: ["limit_price"],
        requiredAnyOf: ["base_size", "quote_size"],
        uiLabel: "Limit (GTC)",
        uiDescription:
            "Limit order at a specified price (or better). Remains active until it fills or you cancel it.",
    },
    limit_limit_gtd: {
        requiredAll: ["limit_price", "end_time"],
        requiredAnyOf: ["base_size", "quote_size"],
        uiLabel: "Limit (GTD)",
        uiDescription:
            "Limit order that expires at a specified date/time. Any remaining unfilled portion is cancelled at expiry.",
    },
    sor_limit_ioc: {
        requiredAll: ["limit_price"],
        requiredAnyOf: ["base_size", "quote_size"],
        uiLabel: "Limit (IOC, routed)",
        uiDescription:
            "Immediate-or-cancel limit order. Attempts to fill immediately at the limit price (or better); any remainder is cancelled. May route to seek best execution.",
    },
    stop_limit_stop_limit_gtc: {
        requiredAll: ["stop_price", "limit_price"],
        requiredAnyOf: ["base_size", "quote_size"],
        uiLabel: "Stop-Limit (GTC)",
        uiDescription:
            "When the stop price is reached, a limit order is placed at the specified limit price. Remains active until it fills or you cancel it.",
    },
    stop_limit_stop_limit_gtd: {
        requiredAll: ["stop_price", "limit_price", "end_time"],
        requiredAnyOf: ["base_size", "quote_size"],
        uiLabel: "Stop-Limit (GTD)",
        uiDescription:
            "Stop-limit order with an expiration time. If it has not triggered and filled by expiry, it is cancelled.",
    },
    limit_limit_fok: {
        requiredAll: ["limit_price"],
        requiredAnyOf: ["base_size", "quote_size"],
        uiLabel: "Limit (FOK)",
        uiDescription:
            "Limit order that must be filled completely immediately at the limit price (or better). If it cannot fully fill right away, it is cancelled.",
    },
    trigger_bracket_gtc: {
        requiredAll: ["limit_price", "stop_trigger_price"],
        uiLabel: "Bracket (GTC)",
        uiDescription:
            "Exit order that sets both a take-profit limit price and a stop-trigger price. If one side triggers/fills, the other is automatically disabled. Remains active until it fills or you cancel it.",
    },
    trigger_bracket_gtd: {
        requiredAll: ["limit_price", "stop_trigger_price", "end_time"],
        uiLabel: "Bracket (GTD)",
        uiDescription:
            "Bracket order with an expiration time. If it has not triggered and filled by expiry, it is cancelled.",
    },
};

function getSelectedOrderConfigurationVariant(
    orderConfiguration: Record<string, unknown>
): keyof OrderConfiguration {
    const variantKeys = Object.keys(ORDER_CONFIGURATION_SPECS) as Array<keyof OrderConfiguration>;
    const providedVariantKeys = variantKeys.filter((key) => key in orderConfiguration);
    if (providedVariantKeys.length !== 1) {
        throw new Error(
            `"order_configuration" must include exactly one order type key: ${variantKeys.join(", ")}`
        );
    }
    return providedVariantKeys[0];
}

function validateOrderConfiguration(orderConfiguration: Record<string, unknown>): OrderConfiguration {
    const selectedVariant = getSelectedOrderConfigurationVariant(orderConfiguration);

    const selectedPayload = orderConfiguration[selectedVariant];
    if (typeof selectedPayload !== "object" || selectedPayload === null || Array.isArray(selectedPayload)) {
        throw new Error(`"order_configuration.${selectedVariant}" must be an object`);
    }

    const payload = selectedPayload as Record<string, unknown>;
    const spec = ORDER_CONFIGURATION_SPECS[selectedVariant];

    for (const fieldName of spec.requiredAll ?? []) {
        const raw = payload[fieldName];
        if (typeof raw !== "string" || raw.trim().length === 0) {
            throw new Error(`"order_configuration.${selectedVariant}.${fieldName}" is required`);
        }
    }

    if ((spec.requiredAnyOf?.length ?? 0) > 0) {
        const hasAny = (spec.requiredAnyOf ?? []).some((fieldName) => {
            const raw = payload[fieldName];
            return typeof raw === "string" && raw.trim().length > 0;
        });
        if (!hasAny) {
            throw new Error(
                `"order_configuration.${selectedVariant}" must include one of: ${(spec.requiredAnyOf ?? []).join(", ")}`
            );
        }
    }

    for (const [fieldName, raw] of Object.entries(payload)) {
        if (raw == null) continue;
        if (fieldName === "post_only") {
            if (typeof raw !== "boolean") {
                throw new Error(`"order_configuration.${selectedVariant}.post_only" must be a boolean`);
            }
            continue;
        }
        if (fieldName === "stop_direction") {
            if (raw !== "STOP_DIRECTION_STOP_UP" && raw !== "STOP_DIRECTION_STOP_DOWN") {
                throw new Error(
                    `"order_configuration.${selectedVariant}.stop_direction" must be STOP_DIRECTION_STOP_UP or STOP_DIRECTION_STOP_DOWN`
                );
            }
            continue;
        }
        if (typeof raw !== "string" || raw.trim().length === 0) {
            throw new Error(`"order_configuration.${selectedVariant}.${fieldName}" must be a non-empty string`);
        }
    }

    return orderConfiguration as OrderConfiguration;
}

function getParams(options?: { [key: string]: unknown }): Record<string, unknown> {
    const data = asRecord(options);
    const nested = asRecord(data.parameters);
    return Object.keys(nested).length > 0 ? { ...data, ...nested } : data;
}

function getMessageParams(message: Memory): Record<string, unknown> {
    const content = asRecord(message.content);
    const parameters = asRecord(content.parameters);
    const action = asRecord(content.action);
    return Object.keys(parameters).length > 0 ? { ...action, ...parameters } : action;
}

function validateBaseParams(params: Record<string, unknown>): TradeActionBaseParams {
    return {
        userId: requireString(params, "userId") as UUID,
    };
}

function pickAuthTypeWithStoredData(
    exchangeEntry: ExchangeRegistryEntry,
    forExchange: AuthsForExchange | Record<string, unknown> | null | undefined
): ExchangeAuthType | null {
    if (!forExchange || typeof forExchange !== "object") return null;
    for (const cfg of exchangeEntry.authTypes ?? []) {
        const blob = forExchange[cfg.type];
        if (blob && typeof blob === "object" && !Array.isArray(blob) && Object.keys(blob as object).length > 0) {
            return cfg.type;
        }
    }
    return null;
}

function buildAuthRecordFromTokens(
    authConfig: NonNullable<ExchangeRegistryEntry["authTypes"]>[number],
    rawTokensForAuthType: ExchangeAuthFieldValues
): Record<string, string> {
    const requiredFields = (authConfig.fields ?? []).filter((field) => field.required === true);
    for (const field of requiredFields) {
        const tokenValue = rawTokensForAuthType[field.id];
        const ok =
            typeof tokenValue === "string"
                ? tokenValue.trim().length > 0
                : field.type === "secret" && isEncrypted(tokenValue);
        if (!ok) {
            throw new Error(`Missing required exchange auth field: ${field.id}`);
        }
    }

    const auth: Record<string, string> = {};
    for (const field of authConfig.fields ?? []) {
        const rawValue = rawTokensForAuthType[field.id];
        if (rawValue == null) continue;

        if (typeof rawValue === "string") {
            const trimmed = rawValue.trim();
            if (trimmed) auth[field.id] = trimmed;
            continue;
        }

        if (field.type === "secret" && isEncrypted(rawValue)) {
            const decrypted = decrypt(rawValue as EncryptedSecret);
            if (decrypted.trim()) auth[field.id] = decrypted.trim();
        }
    }
    return auth;
}

type ResolveExchangeCredentialsOptions = {
    /** Use stored creds for this exchange id from `exchangeAuths` (ignore `defaultExchangeAuth`). */
    preferExchangeId?: ExchangeId;
};

export async function resolveExchangeCredentials(
    runtime: IAgentRuntime,
    userId: UUID,
    options?: ResolveExchangeCredentialsOptions
): Promise<{ exchange: ExchangeId; authType: ExchangeAuthType; auth: Record<string, string> }> {
    const account = await runtime.databaseAdapter.getAccountById(userId);
    const details =
        account?.details && typeof account.details === "object"
            ? (account.details as Record<string, unknown> & {
                  exchangeAuths?: ExchangeAuths;
                  defaultExchangeAuth?: DefaultExchangeAuth;
              })
            : {};

    const exchangeAuths: ExchangeAuths =
        details.exchangeAuths && typeof details.exchangeAuths === "object"
            ? (details.exchangeAuths as ExchangeAuths)
            : ({} as ExchangeAuths);

    const registry = await runtime.databaseAdapter.getExchangeRegistry();
    if (!Array.isArray(registry)) {
        throw new Error("Exchange registry is not available");
    }

    let exchangeId: ExchangeId;
    let authType: ExchangeAuthType;

    if (options?.preferExchangeId) {
        exchangeId = options.preferExchangeId;
        const exchangeEntry = registry.find((entry) => entry.id === exchangeId);
        if (!exchangeEntry) {
            throw new Error(`Exchange not found in registry: ${exchangeId}`);
        }

        const forExchange =
            exchangeAuths[exchangeId] && typeof exchangeAuths[exchangeId] === "object"
                ? (exchangeAuths[exchangeId] as AuthsForExchange)
                : undefined;

        const picked = pickAuthTypeWithStoredData(exchangeEntry, forExchange);
        if (!picked) {
            throw new Error(`No stored exchange credentials under exchangeAuths[${exchangeId}]`);
        }
        authType = picked;
    } else {
        const defaultExchangeAuth =
            details.defaultExchangeAuth && typeof details.defaultExchangeAuth === "object"
                ? (details.defaultExchangeAuth as DefaultExchangeAuth)
                : null;

        if (!defaultExchangeAuth?.exchangeId || !defaultExchangeAuth?.authType) {
            throw new Error("Missing defaultExchangeAuth for user");
        }
        exchangeId = defaultExchangeAuth.exchangeId;
        authType = defaultExchangeAuth.authType;
    }

    const exchangeEntry = registry.find((entry) => entry.id === exchangeId);
    if (!exchangeEntry) {
        throw new Error(`Exchange not found in registry: ${exchangeId}`);
    }

    const authConfig = exchangeEntry.authTypes?.find((config) => config.type === authType);
    if (!authConfig) {
        throw new Error(`Auth type not supported for exchange: ${exchangeId} (${authType})`);
    }

    const forExchange =
        exchangeAuths[exchangeId] && typeof exchangeAuths[exchangeId] === "object"
            ? (exchangeAuths[exchangeId] as Record<string, unknown>)
            : null;

    const rawTokensForAuthType =
        forExchange &&
        forExchange[authType] &&
        typeof forExchange[authType] === "object"
            ? (forExchange[authType] as ExchangeAuthFieldValues)
            : null;

    if (!rawTokensForAuthType) {
        throw new Error(
            options?.preferExchangeId
                ? `No exchange auth tokens found for exchangeAuths[${exchangeId}] (${authType})`
                : "No exchange auth tokens found for defaultExchangeAuth"
        );
    }

    const auth = buildAuthRecordFromTokens(authConfig, rawTokensForAuthType);

    elizaLogger.debug(
        `[plugin-cex] resolveExchangeCredentials exchange=${exchangeId} authType=${authType} fields=${Object.keys(auth).join(",")}${options?.preferExchangeId ? " preferExchangeId" : ""}`
    );
    return {
        exchange: exchangeId,
        authType,
        auth,
    };
}

const VALID_WALLET_TYPE_FILTERS = new Set([
    "spot",
    "funding",
    "margin_cross",
    "margin_isolated",
    "all",
] as const);

/**
 * Issue 4 — accept `wallet_type` so the Binance venue can scope the
 * balance fetch to a single wallet (spot / funding / margin_cross /
 * margin_isolated) instead of fanning out all four. Any other value
 * (including legacy LLM outputs like "margin" or "futures") is silently
 * normalized to `"all"` so prior behavior is preserved as the default.
 *
 * The LLM template hint instructs the model to emit "spot" / "margin_cross"
 * etc. when the user says "spot balance" / "cross margin balance". When
 * the user just says "balance" the LLM omits this field and we fall
 * through to the historical multi-wallet fan-out.
 */
function normalizeWalletTypeFilter(raw: unknown): GetBalanceParams["wallet_type"] {
    if (typeof raw !== "string") return undefined;
    const lower = raw.trim().toLowerCase();
    if (!lower) return undefined;
    // Common LLM aliases the template doesn't fully constrain. Map them
    // to the canonical filter values; everything else drops to "all".
    const ALIASES: Record<string, GetBalanceParams["wallet_type"]> = {
        spot: "spot",
        funding: "funding",
        cross: "margin_cross",
        cross_margin: "margin_cross",
        "cross-margin": "margin_cross",
        margin_cross: "margin_cross",
        isolated: "margin_isolated",
        isolated_margin: "margin_isolated",
        "isolated-margin": "margin_isolated",
        margin_isolated: "margin_isolated",
        all: "all",
        // The bare "margin" alias is ambiguous (cross vs isolated). Fan
        // out by returning undefined so the venue defaults to "all" —
        // safer than guessing wrong.
    };
    return ALIASES[lower];
}

export function validateGetBalanceParams(params: Record<string, unknown>): GetBalanceParams {
    return {
        ...validateBaseParams(params),
        limit: getNumber(params.limit),
        cursor: getString(params.cursor),
        retail_portfolio_id: getString(params.retail_portfolio_id),
        wallet_type: normalizeWalletTypeFilter(params.wallet_type),
    };
}

/**
 * Public re-export so the venue layer can use the same validation list
 * (e.g. defensive checks on direct service calls).
 */
export function isValidWalletTypeFilter(value: unknown): boolean {
    return typeof value === "string" && VALID_WALLET_TYPE_FILTERS.has(value as never);
}

export function validateGetOrdersParams(params: Record<string, unknown>): GetOrdersParams {
    // Binance + Coinbase + LLM-stripped-underscore variants → canonical
    // (Coinbase-shaped) values. Robust to "PARTIALLY_FILLED" /
    // "PARTIALLYFILLED" / "NEW" / "CANCELED" etc. so the LLM and ADK
    // can emit either venue's terminology without rejection.
    const ORDER_STATUS_ALIAS: Record<string, string> = {
        NEW: "OPEN",
        PARTIALLYFILLED: "OPEN",
        PARTIALLY_FILLED: "OPEN",
        FILLED: "FILLED",
        CANCELED: "CANCELLED",
        CANCELLED: "CANCELLED",
        EXPIRED: "EXPIRED",
        REJECTED: "FAILED",
        FAILED: "FAILED",
        PENDING_CANCEL: "CANCEL_QUEUED",
        PENDINGCANCEL: "CANCEL_QUEUED",
        OPEN: "OPEN",
        PENDING: "PENDING",
        QUEUED: "QUEUED",
        CANCEL_QUEUED: "CANCEL_QUEUED",
        CANCELQUEUED: "CANCEL_QUEUED",
        EDIT_QUEUED: "EDIT_QUEUED",
        EDITQUEUED: "EDIT_QUEUED",
        UNKNOWN_ORDER_STATUS: "UNKNOWN_ORDER_STATUS",
        UNKNOWNORDERSTATUS: "UNKNOWN_ORDER_STATUS",
    };

    const normalizeAndValidateEnumArray = (
        values: string[] | undefined,
        allowed: string[],
        label: string,
        aliasMap?: Record<string, string>
    ): string[] | undefined => {
        if (!values) return values;
        const normalized = values.map((v) => {
            const key = v.trim().toUpperCase();
            return aliasMap?.[key] ?? key;
        });
        const invalid = normalized.filter((v) => !allowed.includes(v));
        if (invalid.length > 0) {
            throw new Error(
                `Invalid ${label} value(s): ${invalid.join(", ")}. Allowed values: ${allowed.join(", ")}`
            );
        }
        return normalized;
    };

    const allowedOrderStatus = [
        "PENDING",
        "OPEN",
        "FILLED",
        "CANCELLED",
        "EXPIRED",
        "FAILED",
        "UNKNOWN_ORDER_STATUS",
        "QUEUED",
        "CANCEL_QUEUED",
        "EDIT_QUEUED",
    ];

    const allowedOrderTypes = [
        "UNKNOWN_ORDER_TYPE",
        "MARKET",
        "LIMIT",
        "STOP",
        "STOP_LIMIT",
        "BRACKET",
        "TWAP",
        "ROLL_OPEN",
        "ROLL_CLOSE",
        "LIQUIDATION",
        "SCALED",
    ];

    const allowedProductTypes = ["UNKNOWN_PRODUCT_TYPE", "SPOT", "FUTURE"];

    const normalizedOrderStatus = normalizeAndValidateEnumArray(
        getStringArray(params.order_status),
        allowedOrderStatus,
        "order_status",
        ORDER_STATUS_ALIAS
    );

    // B4 — `margin_type` was silently dropped here, so the LLM-extracted
    // "margin orders" prompts (CROSS / ISOLATED) flowed to the venue
    // layer with no margin signal and defaulted to the SPOT
    // openOrders endpoint. Validate the enum like `validateCreateOrderParams`.
    const marginTypeRaw = getString(params.margin_type)?.toUpperCase();
    if (marginTypeRaw !== undefined && marginTypeRaw !== "CROSS" && marginTypeRaw !== "ISOLATED") {
        throw new Error(
            `"margin_type" must be one of: CROSS, ISOLATED (got "${marginTypeRaw}")`,
        );
    }

    const out = {
        ...validateBaseParams(params),
        order_ids: getStringArray(params.order_ids),
        product_ids: getStringArray(params.product_ids),
        order_status: normalizedOrderStatus,
        limit: getNumber(params.limit),
        cursor: getString(params.cursor),
        start_date: getString(params.start_date),
        end_date: getString(params.end_date),
        order_side: getString(params.order_side)?.toUpperCase() as GetOrdersParams["order_side"] | undefined,
        order_types: normalizeAndValidateEnumArray(
            getStringArray(params.order_types),
            allowedOrderTypes,
            "order_types"
        ),
        product_type: (() => {
            const v = getString(params.product_type);
            if (!v) return undefined;
            const normalized = v.toUpperCase();
            if (!allowedProductTypes.includes(normalized)) {
                throw new Error(
                    `Invalid product_type value: ${normalized}. Allowed values: ${allowedProductTypes.join(", ")}`
                );
            }
            return normalized;
        })(),
        margin_type: marginTypeRaw as GetOrdersParams["margin_type"] | undefined,
        // Fix 4 — optional quote currency for the venue fan-out path
        // (default USDT applied venue-side). Upper-cased so `usdt` from
        // the LLM matches `USDT` in the holdings enumeration.
        quote_currency: getString(params.quote_currency)?.toUpperCase(),
        // CEX post-PR237 Commit 6 — explicit "history" intent. The
        // decomposer emits `true` when the user asks for past orders
        // rather than the live open ones. The venue layer triggers
        // the fan-out path on this flag alone (in addition to the
        // legacy date-window trigger).
        history:
            typeof params.history === "boolean"
                ? (params.history as boolean)
                : undefined,
    };

    return out;
}

export function validateCreateOrderParams(params: Record<string, unknown>): CreateOrderParams {
    const orderConfiguration = requireObject(params, "order_configuration");
    // B5 — `margin_action` was silently dropped here; downstream
    // `marginActionToSideEffect(undefined)` returned `NO_SIDE_EFFECT`,
    // so every margin order shipped to Binance with auto-borrow OFF
    // regardless of what the user/LLM intended. Normalize to upper-case
    // (mirrors `margin_type`) and validate against the enum so a typo
    // ("BORROW_MORE") fails fast instead of silently degrading to
    // NO_SIDE_EFFECT.
    const marginActionRaw = getString(params.margin_action)?.toUpperCase();
    if (
        marginActionRaw !== undefined &&
        marginActionRaw !== "NORMAL" &&
        marginActionRaw !== "AUTO_BORROW" &&
        marginActionRaw !== "AUTO_REPAY"
    ) {
        throw new Error(
            `"margin_action" must be one of: NORMAL, AUTO_BORROW, AUTO_REPAY (got "${marginActionRaw}")`,
        );
    }
    return {
        ...validateBaseParams(params),
        client_order_id: requireString(params, "client_order_id"),
        product_id: requireString(params, "product_id"),
        side: requireEnum(params, "side", ["BUY", "SELL"]),
        order_configuration: validateOrderConfiguration(orderConfiguration),
        leverage: getString(params.leverage),
        margin_type: getString(params.margin_type)?.toUpperCase() as CreateOrderParams["margin_type"] | undefined,
        margin_action: marginActionRaw as CreateOrderParams["margin_action"] | undefined,
        preview_id: getString(params.preview_id),
        retail_portfolio_id: getString(params.retail_portfolio_id),
    };
}

export function validateCancelOrderParams(params: Record<string, unknown>): CancelOrderParams & { all_open?: boolean } {
    // M3 iter6 (post-PR246): order_ids is OPTIONAL when all_open=true.
    // The Binance cancelOrder fan-out populates the id list from the
    // open-orders snapshot at execute time. Either order_ids or
    // all_open must be set — otherwise reject with a useful error.
    const all_open = params.all_open === true || params.all_open === "true";
    const orderIds = all_open
        ? getStringArray(params.order_ids) ?? []
        : requireStringArray(params, "order_ids");
    return {
        ...validateBaseParams(params),
        order_ids: orderIds,
        product_id: getString(params.product_id),
        ...(all_open ? { all_open: true } : {}),
    };
}

export function validateGetFillsParams(params: Record<string, unknown>): GetFillsParams {
    const out = {
        ...validateBaseParams(params),
        order_ids: getStringArray(params.order_ids),
        trade_ids: getStringArray(params.trade_ids),
        product_ids: getStringArray(params.product_ids),
        limit: getNumber(params.limit),
        cursor: getString(params.cursor),
        start_sequence_timestamp: getString(params.start_sequence_timestamp),
        end_sequence_timestamp: getString(params.end_sequence_timestamp),
        retail_portfolio_id: getString(params.retail_portfolio_id),
        // Fix 4b — optional quote currency for the fan-out path.
        quote_currency: getString(params.quote_currency)?.toUpperCase(),
    };
    return out;
}

/**
 * Fix 4b — Detects the legacy "productids/product_ids/symbol is required"
 * error text produced by venue layers (or the LLM rendering with stripped
 * underscores) and rewrites it to an actionable message users can act on.
 *
 * Returns the original message untouched when the pattern doesn't match.
 *
 * After Fix 4b the Binance venue layer fans out across the user's held
 * assets when `product_ids` is missing, so the only path that surfaces
 * this error is a downstream that still requires an explicit symbol
 * (Coinbase doesn't today, but a future venue might). Without this
 * rewrite users see `"productids" is required for binance getfills
 * requests` which is confusing (the parameter name is `product_ids` and
 * the user wasn't told what to fix).
 */
export function rewriteSymbolRequiredErrorMessage(message: string): string {
    if (typeof message !== "string" || message.length === 0) return message;
    // Tightened follow-up to Fix 4b: only rewrite when the message is
    // explicitly about FIELD ABSENCE on `product_ids`/`symbol`, not a
    // field-CONSTRAINT message that happens to mention "required".
    //
    // Anchored on \b word boundaries so we don't match `symbology` /
    // `symbolic` / `product_idsx`. The `is\s+` is required (not
    // optional) so we don't false-fire on the noisy
    // `"symbol order was required by the venue"` shape. Tolerates the
    // surrounding quote stripping the envelope formatter does
    // (`"productids"` from `"product_ids"`).
    //
    // Matches:
    //   - `"productids" is required for binance getfills requests`
    //   - `"product_ids" is required for ...`
    //   - `product_ids is required`
    //   - `symbol is required`
    //   - `symbol required` (bare imperative)
    //   - `Binance requires product_ids[0] as the trading symbol`
    const needle =
        /\b(product[_ ]?ids?|symbol)\b\s*"?\s*(?:is\s+)?(required|missing)\b|\brequires?\b\s+"?(product[_ ]?ids?|symbol)\b/i;
    if (!needle.test(message)) return message;
    // Negative-noise guard: when the message also mentions a
    // FIELD-CONSTRAINT qualifier ("to be uppercase", "format",
    // "unique", etc.), the requirement is about the field's SHAPE,
    // not its ABSENCE. Don't rewrite.
    const fieldConstraint = /\b(uppercase|lowercase|format|unique|valid|invalid|length|pattern|alphanumeric|case-sensitive)\b/i;
    if (fieldConstraint.test(message)) return message;
    return "Please specify a symbol (e.g. BTCUSDT) — I couldn't infer one from your message.";
}

function createValidator<T extends TradeActionBaseParams>(
    validateParams: (params: Record<string, unknown>) => T
): Validator {
    return async (_runtime: IAgentRuntime, message: Memory) => {
        try {
            const params = getMessageParams(message);
            if (Object.keys(params).length === 0) {
                return true;
            }

            validateParams(params);
            return true;
        } catch {
            return false;
        }
    };
}

/** Same validation path as trade action execution, for post-approval workflow steps. */
export function validateApprovedActionParams(actionName: string, params: Record<string, unknown>): void {
    switch (actionName) {
        case "get_balance":
            validateGetBalanceParams(params);
            break;
        case "get_orders":
            validateGetOrdersParams(params);
            break;
        case "create_order":
            validateCreateOrderParams(params);
            break;
        case "cancel_order":
            validateCancelOrderParams(params);
            break;
        case "get_fills":
            validateGetFillsParams(params);
            break;
        // Phase 4-5 meta-actions: no venue-credential params to validate.
        // They run against in-process state (DSL compiler, backtest harness,
        // trading-mode preference) so they skip preflightValidateForExchange.
        case "compile_strategy":
        case "run_backtest":
        case "set_trading_mode":
            return;
        // PR #236 read + write actions: no venue-credential params to
        // validate at this layer. Their param shapes (asset / wallet_type /
        // start_date / end_date / product_id / depth / scope) are handled
        // by the action handlers themselves, and preflightValidateForExchange
        // has no rules for them (it only covers get_orders / get_fills /
        // cancel_order / create_order). Without these case arms the read-
        // only fast-path validator at cexWorkflowMessageHandler.ts:3279
        // threw "Invalid read-only action parameters: Unknown CEX action: X"
        // for every Fix 6 / 8 / 13 / 15 action — N-1 regression caught
        // post-merge on staging.
        case "get_trading_mode":
        case "get_positions":
        case "get_pnl":
        case "get_ticker":
        case "get_orderbook":
        case "list_asset_lists":
        case "add_blocked_asset":
        case "remove_blocked_asset":
        case "add_allowed_asset":
        case "remove_allowed_asset":
            return;
        // StrategyEngineService control surface: lifecycle actions validate
        // their own params downstream (recover/compile DSL, instance_id lookup).
        case "arm_strategy":
        case "pause_strategy":
        case "resume_strategy":
        case "stop_strategy":
        case "list_strategies":
            return;
        default:
            throw new Error(`Unknown CEX action: ${actionName}`);
    }
    preflightValidateForExchange(actionName, params);
}

/**
 * Resolve the user's current trading mode for the paper-venue dispatch
 * path. CEX post-PR237 contract: MongoDB is the durable source of
 * truth, so we read DB first. The runtime cache is a low-latency hint
 * that gets refreshed from the DB on every read, and only falls back
 * as a defense against transient DB outages.
 *
 * Returns "live" if nothing is configured. The previous PR-#237
 * behavior was cache-first, which allowed a stale cache to override a
 * user-set DB preference (Issue 1 — "Mode shows paper but actually
 * live"). The PUT `/user/trading/preferences` endpoint now also
 * invalidates this cache key on every mode change.
 */
export async function getUserTradingMode(
    runtime: IAgentRuntime,
    userId: string,
): Promise<"live" | "paper" | "shadow"> {
    // Fix-T3 iter2 (post-PR242): the API writes user_trading_preferences
    // keyed by emailToUserId(email) (JWT-derived UUID), but action
    // handlers see memory.userId which is often a different UUID space
    // (room/character scoped). Try both: the passed userId first, then
    // the email-derived counterpart if we can resolve an email from the
    // account row. This makes the action and the API agree regardless
    // of which UUID space the message came in with.
    // M6 iter7 (post-PR247): use authoritative account.id via
    // getAccountByEmail BEFORE the legacy emailToUserId formula. See
    // getTradingMode.ts for the longer rationale.
    const candidateIds: string[] = [];
    try {
        const adapter = runtime.databaseAdapter as unknown as {
            getAccountById?: (uid: string) => Promise<{ email?: string | null } | null>;
            getAccountByEmail?: (email: string) => Promise<{ id?: string | null } | null>;
        };
        if (typeof adapter?.getAccountById === "function") {
            const acct = await adapter.getAccountById(userId);
            const email = acct?.email;
            if (typeof email === "string" && email.length > 0) {
                if (typeof adapter.getAccountByEmail === "function") {
                    try {
                        const byEmail = await adapter.getAccountByEmail(email);
                        const authoritativeId = byEmail?.id ? String(byEmail.id) : null;
                        if (authoritativeId && authoritativeId !== userId) {
                            candidateIds.push(authoritativeId);
                        }
                    } catch {
                        /* fall through to formula fallback */
                    }
                }
                const normalizedEmail = email.toLowerCase().trim();
                const emailUid = stringToUuid(`email-user-${normalizedEmail}`);
                if (emailUid && emailUid !== userId && !candidateIds.includes(emailUid)) {
                    candidateIds.push(emailUid);
                }
            }
        }
    } catch {
        /* best-effort */
    }
    candidateIds.push(userId);

    for (const candidateId of candidateIds) {
        const cacheKey = `user_trading_preferences:${candidateId}:default_mode`;
        try {
            const adapter = runtime.databaseAdapter as unknown as {
                getUserTradingPreferences?: (uid: string) => Promise<Record<string, unknown> | null>;
            };
            if (typeof adapter?.getUserTradingPreferences === "function") {
                const prefs = await adapter.getUserTradingPreferences(candidateId);
                const mode = prefs?.default_mode;
                if (mode === "paper" || mode === "shadow" || mode === "live") {
                    try {
                        await runtime.cacheManager?.set?.(cacheKey, mode);
                    } catch {
                        /* cache write-back is best-effort */
                    }
                    return mode;
                }
            }
        } catch (err) {
            elizaLogger.warn(`[plugin-cex] getUserTradingMode mongo read failed for ${candidateId}: ${err}`);
        }
    }

    for (const candidateId of candidateIds) {
        const cacheKey = `user_trading_preferences:${candidateId}:default_mode`;
        try {
            const cached = await runtime.cacheManager?.get?.(cacheKey);
            if (cached === "paper" || cached === "shadow" || cached === "live") return cached;
        } catch {
            // ignore
        }
    }

    // Public-demo default: paper. The deployment has only dummy exchange
    // creds (can't move real money), and the seeded paper cache key is
    // per-instance/in-memory — fragile on Cloud Run. Defaulting to paper
    // here is the instance-independent safety net so a missed cache never
    // resolves a public-demo order to LIVE. (Raw env check, not the core
    // isPublicAccessModeActive helper, to avoid coupling plugin-cex to it.)
    return process.env.PUBLIC_ACCESS_MODE?.trim() === "1" ? "paper" : "live";
}

/**
 * F3 — singleton paper-venue cache keyed by `realVenue`. Without this,
 * `shared.ts` was calling `createPaperVenue(...)` per action — the
 * `state.orders` Map was fresh each time, so a paper order placed in
 * one action was invisible to the next (QA H1+H2 reproduction). Now
 * orders persist via the adapter-backed `PaperOrderStore`, and the
 * venue instance itself is also cached so the per-symbol price cache
 * survives across calls.
 */
const paperVenueCache = new Map<string, ExchangeService>();

/**
 * Build a PaperVenue service that pulls mid-prices from the real venue's
 * public ticker endpoint. Uses a small per-symbol cache to avoid spamming
 * the venue. When unable to fetch (network error or missing endpoint
 * mapping), falls back to a sane stub price.
 *
 * F3 — `runtime` is now required. We resolve the database adapter from
 * it and construct an adapter-backed `PaperOrderStore`. The first call
 * for a given `realVenue` caches the instance; subsequent calls reuse
 * it. TTL for paper orders is read from `PAPER_ORDER_TTL_SECONDS`
 * (default 86400 = 24h).
 */
export async function createPaperVenueForRuntime(
    runtime: IAgentRuntime,
    realVenue: string,
): Promise<ExchangeService> {
    const cacheKey = realVenue;
    const cached = paperVenueCache.get(cacheKey);
    if (cached) return cached;

    const priceCache = new Map<string, { price: number; fetchedAt: number }>();
    const TTL_MS = 5_000;

    const getMidPrice = async (productId: string): Promise<number> => {
        const c = priceCache.get(productId);
        if (c && Date.now() - c.fetchedAt < TTL_MS) return c.price;
        let price = 0;
        try {
            if (realVenue === "binance") {
                const symbolNoSep = productId.replace(/[-_/]/g, "");
                const resp = await fetch(
                    `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbolNoSep)}`,
                );
                if (resp.ok) {
                    const data = (await resp.json()) as { price?: string };
                    const p = Number.parseFloat(data?.price ?? "");
                    if (Number.isFinite(p) && p > 0) price = p;
                }
            } else if (realVenue === "coinbase") {
                const symbolDash = productId.includes("-")
                    ? productId
                    : productId.replace(/(USDT|USDC|USD|EUR|BTC|ETH)$/i, "-$1");
                const resp = await fetch(
                    `https://api.exchange.coinbase.com/products/${encodeURIComponent(symbolDash)}/ticker`,
                );
                if (resp.ok) {
                    const data = (await resp.json()) as { price?: string };
                    const p = Number.parseFloat(data?.price ?? "");
                    if (Number.isFinite(p) && p > 0) price = p;
                }
            }
        } catch (err) {
            elizaLogger.warn(`[plugin-cex] paper-mode price fetch failed: ${err}`);
        }
        if (price === 0) {
            // Fallback heuristic so the paper venue keeps working offline.
            price = /^BTC/i.test(productId) ? 78_000 : /^ETH/i.test(productId) ? 3_500 : 100;
        }
        priceCache.set(productId, { price, fetchedAt: Date.now() });
        return price;
    };

    const adapter = runtime?.databaseAdapter as unknown as PaperOrdersAdapter | undefined;
    const store = adapter
        ? createAdapterBackedPaperOrderStore(adapter)
        : createInMemoryPaperOrderStore();
    const ttlSecondsEnv =
        Number.parseInt(process.env.PAPER_ORDER_TTL_SECONDS ?? "", 10) || 86_400;

    const venue = createPaperVenue({
        getMidPrice,
        slippage: { kind: "linear_bps", bps: 5 },
        initialUsd: 10_000,
        store,
        venue: realVenue,
        ttlSeconds: ttlSecondsEnv,
    });
    paperVenueCache.set(cacheKey, venue);
    return venue;
}

/**
 * Fix 2 — Extract a row's base asset and total quantity (available + held)
 * across the venue-specific row shapes the balance handlers emit.
 *
 * Known shapes:
 *  - Binance / Coinbase: `{ currency, available_balance: { value }, hold: { value } }`
 *  - Paper venue:        `{ asset, available, locked }`
 *  - Fix 1 uniform:      `{ asset, free, locked, total, wallet_type, ... }`
 *
 * Returns `null` when the row can't be parsed (e.g. an envelope row, dust
 * filtered upstream); the caller skips USD enrichment for those rows.
 */
function extractBalanceRowAssetAndTotal(
    row: unknown,
): { asset: string; total: number } | null {
    if (!row || typeof row !== "object") return null;
    const r = row as Record<string, unknown>;
    const asset =
        (typeof r.currency === "string" && r.currency) ||
        (typeof r.asset === "string" && r.asset) ||
        null;
    if (!asset) return null;
    // Fix 1 uniform shape: prefer `total` when present (already pre-summed).
    if (typeof r.total === "string") {
        const t = Number.parseFloat(r.total);
        if (Number.isFinite(t)) {
            return { asset: asset.toUpperCase(), total: t };
        }
    }
    let availStr: string | undefined;
    let holdStr: string | undefined;
    const ab = r.available_balance;
    if (ab && typeof ab === "object" && typeof (ab as { value?: unknown }).value === "string") {
        availStr = (ab as { value: string }).value;
    } else if (typeof r.free === "string") {
        availStr = r.free;
    } else if (typeof r.available === "string") {
        availStr = r.available;
    }
    const hold = r.hold;
    if (hold && typeof hold === "object" && typeof (hold as { value?: unknown }).value === "string") {
        holdStr = (hold as { value: string }).value;
    } else if (typeof r.locked === "string") {
        holdStr = r.locked;
    }
    const avail = Number.parseFloat(availStr ?? "0");
    const held = Number.parseFloat(holdStr ?? "0");
    const total =
        (Number.isFinite(avail) ? avail : 0) + (Number.isFinite(held) ? held : 0);
    return { asset: asset.toUpperCase(), total };
}

/**
 * Fix 2 — Enrich a `get_balance` result with per-row `estimated_usdt` and a
 * top-level `estimated_total_usdt` footer. Mutates a shallow clone of the
 * result so the caller's `result` reference isn't aliased.
 *
 * Behavior:
 *  - Stablecoins (USDT/USDC/BUSD/FDUSD/TUSD) get `price = 1.0`.
 *  - Non-stablecoin base assets are priced via `fetchBinanceUsdtPrices` in
 *    one batched ticker call (5 s per-process cache).
 *  - Rows with no available quote get `estimated_usdt = null` and are
 *    excluded from the total.
 *  - Full pricing failure (`{}`) → only stablecoin rows priced; the total
 *    still sums whatever was priced (may be 0 — caller can skip the row).
 */
async function enrichBalanceWithUsdEstimates(
    rawResult: unknown,
): Promise<unknown> {
    if (!rawResult || typeof rawResult !== "object") return rawResult;
    const accounts = (rawResult as { accounts?: unknown }).accounts;
    if (!Array.isArray(accounts) || accounts.length === 0) return rawResult;

    const parsed = accounts.map(extractBalanceRowAssetAndTotal);
    const nonStableAssets = new Set<string>();
    for (const row of parsed) {
        if (!row) continue;
        if (row.total <= 0) continue;
        if (isStablecoin(row.asset)) continue;
        nonStableAssets.add(row.asset);
    }
    const prices =
        nonStableAssets.size > 0
            ? await fetchBinanceUsdtPrices(Array.from(nonStableAssets))
            : {};

    let total = 0;
    const enrichedAccounts = accounts.map((row, idx) => {
        const meta = parsed[idx];
        if (!meta) return row;
        let price: number | null;
        if (isStablecoin(meta.asset)) {
            price = 1.0;
        } else if (typeof prices[meta.asset] === "number") {
            price = prices[meta.asset];
        } else {
            price = null;
        }
        const estimated = price === null ? null : meta.total * price;
        if (estimated !== null) total += estimated;
        return {
            ...(row as Record<string, unknown>),
            estimated_usdt: estimated,
        };
    });

    return {
        ...(rawResult as Record<string, unknown>),
        accounts: enrichedAccounts,
        estimated_total_usdt: total,
    };
}

export function createTradeAction<T extends TradeActionBaseParams, TResult = unknown>(
    config: TradeActionConfig<T, TResult>
): Action {
    return {
        name: config.name,
        description: config.description,
        examples: config.examples,
        validate: createValidator(config.validateParams),
        handler: async (
            runtime: IAgentRuntime,
            _message: Memory,
            _state?: never,
            options?: { [key: string]: unknown },
            callback?: HandlerCallback
        ): Promise<boolean> => {
            const rawParams = getParams(options);

            elizaLogger.debug(`[plugin-cex] ${config.name} invoked`);

            // F1: resolve mode pre-try so the error path can still surface
            // a Paper/Shadow prefix when validation fails. Best-effort; the
            // userId may not be available before validateParams runs, in
            // which case we fall back to the per-message `mode` override
            // alone.
            let resolvedModeOuter: ResolvedActionMode = "live";
            try {
                const requestedModePre =
                    getString((rawParams as Record<string, unknown>).mode) ?? null;
                if (requestedModePre === "paper" || requestedModePre === "shadow") {
                    resolvedModeOuter = requestedModePre;
                }
            } catch {
                /* ignore */
            }

            try {
                const params = config.validateParams(rawParams);

                const preferExchangeId = (
                    getString(rawParams[PLUGIN_CEX_INTERNAL_PREFER_EXCHANGE_ID]) ||
                    getString(rawParams.exchange)
                ) as ExchangeId | undefined;
                const creds = await resolveExchangeCredentials(runtime, params.userId, {
                    preferExchangeId: preferExchangeId || undefined,
                });
                
                const paramsWithExchange = {
                    ...(params as unknown as Record<string, unknown>),
                    exchange: creds.exchange,
                } as T;
                preflightValidateForExchange(config.name, paramsWithExchange as unknown as Record<string, unknown>);

                // Phase 4 — paper-venue dispatch. If the user's
                // default_mode is "paper" (persisted in
                // user_trading_preferences), OR the message-scoped
                // `mode` param is explicitly "paper", route writes
                // through the PaperVenueExchangeService instead of the
                // real venue. Reads still hit the real venue so users
                // see actual balances and orders.
                //
                // M1b — paper-id cancel-routing override. If the action
                // is `cancel_order` AND any of the resolved order_ids
                // looks like a paper-venue id (`paper-ord-…`), force
                // `mode=paper` regardless of the user's default_mode or
                // any explicit per-message hint. Without this, the
                // anaphoric resolver could pull a paper id out of the
                // chat (after M1 round-5) and we'd then route the
                // cancel to the LIVE Binance/Coinbase venue, which has
                // no such order and errors out. Pure data-driven
                // routing — looks at the id shape only.
                const rawParamsRecord = rawParams as Record<string, unknown>;
                let requestedMode =
                    getString(rawParamsRecord.mode) ?? null;
                if (config.name === "cancel_order") {
                    const orderIds = Array.isArray(rawParamsRecord.order_ids)
                        ? (rawParamsRecord.order_ids as unknown[]).map(String)
                        : [];
                    const hasPaperId = orderIds.some((id) => /^paper-/i.test(id));
                    if (hasPaperId && requestedMode !== "paper") {
                        elizaLogger.info(
                            `[plugin-cex] M1b cancel-routing: detected paper-venue order_id, forcing mode=paper (was ${requestedMode ?? "<inherit>"})`,
                        );
                        requestedMode = "paper";
                    }
                }
                const userMode = await getUserTradingMode(runtime, params.userId);
                // F1: resolve once, fail-closed to "live"; thread into
                // templates + the action-response envelope. This is the
                // single source of truth for the paper/shadow badge.
                const candidateMode = (requestedMode ?? userMode ?? "live").toLowerCase();
                const resolvedMode: ResolvedActionMode =
                    candidateMode === "paper" || candidateMode === "shadow"
                        ? (candidateMode as ResolvedActionMode)
                        : "live";
                resolvedModeOuter = resolvedMode;
                const isPaperMode = resolvedMode === "paper";
                // F3 — route reads + writes through the paper venue when
                // the user is in paper mode. Previously reads (get_orders /
                // get_balance / get_fills) always hit the live exchange,
                // so `Show my open paper orders` returned the user's live
                // exchange state — wrong & confusing. Now paper-mode reads
                // return the paper ledger only; the user explicitly
                // overrides with `mode=both` for cross-mode listing.
                const isWriteAction =
                    config.name === "create_order" || config.name === "cancel_order";
                const isReadAction =
                    config.name === "get_orders" ||
                    config.name === "get_balance" ||
                    config.name === "get_fills";
                const usePaperVenue = isPaperMode && (isWriteAction || isReadAction);

                const service: ExchangeService = usePaperVenue
                    ? await createPaperVenueForRuntime(runtime, creds.exchange)
                    : createExchangeService({
                          exchange: creds.exchange,
                          authType: creds.authType,
                          auth: creds.auth,
                      });
                if (usePaperVenue) {
                    elizaLogger.info(
                        `[plugin-cex] ${config.name} routed to PAPER venue (mode=paper, real venue=${creds.exchange}, kind=${isWriteAction ? "write" : "read"})`,
                    );
                }
                
                let result = await config.handler(service, paramsWithExchange);

                // Fix 2 — enrich get_balance result rows with per-row
                // `estimated_usdt` and a top-level `estimated_total_usdt`
                // footer using the shared Binance pricing helper. Best-
                // effort; full pricing failure returns `{}` from the
                // helper and the total just sums the stablecoin rows
                // (callers can choose to skip the footer row).
                if (config.name === "get_balance") {
                    try {
                        result = (await enrichBalanceWithUsdEstimates(
                            result,
                        )) as Awaited<TResult>;
                    } catch (err) {
                        elizaLogger.warn(
                            `[plugin-cex] get_balance USD enrichment failed: ${err instanceof Error ? err.message : String(err)}`,
                        );
                    }
                }

                const normalizedResult = normalizeCEXResultEnvelope(
                    creds.exchange,
                    config.name,
                    result
                );

                elizaLogger.debug(`[plugin-cex] ${config.name} completed`);

                if (callback) {
                    await callback(
                        createActionResponse({
                            actionName: config.name,
                            type: config.name.toLowerCase(),
                            text: config.outputTemplate(paramsWithExchange, result, resolvedMode),
                            content: {
                                exchange: creds.exchange,
                                params: paramsWithExchange,
                                result: normalizedResult,
                                mode: resolvedMode,
                            },
                            actionData: {
                                exchange: creds.exchange,
                                params: paramsWithExchange,
                                result: normalizedResult,
                                mode: resolvedMode,
                            },
                        })
                    );
                }

                return true;
            } catch (error) {
                // Temporary logging: action error
                elizaLogger.warn(
                    `[plugin-cex] ${config.name} error: ${error instanceof Error ? error.message : String(error)}`
                );
                if (error instanceof Error && error.stack) {
                    elizaLogger.debug(`[plugin-cex] ${config.name} stack: ${error.stack}`);
                }

                if (callback) {
                    const exchange = getString(rawParams.exchange);
                    const normalizedError = normalizeCEXErrorEnvelope(exchange, config.name, error);
                    // Fix 4b — rewrite the legacy "productids is required"
                    // text to an actionable message. After Fix 4 the
                    // Binance `get_orders` path fans out across the
                    // user's holdings (or returns an empty envelope) so
                    // it can no longer surface this error shape — only
                    // `get_fills` still requires an explicit symbol.
                    // `metadata.error.message` is set via the `error`
                    // arg to `createActionErrorResponse` (it reads
                    // `error.message` for the envelope).
                    let effectiveError: Error =
                        error instanceof Error ? error : new Error(String(error));
                    let effectiveMessage = normalizedError.message;
                    if (config.name === "get_fills") {
                        const rewritten = rewriteSymbolRequiredErrorMessage(
                            normalizedError.message,
                        );
                        if (rewritten !== normalizedError.message) {
                            effectiveMessage = rewritten;
                            const wrapped = new Error(rewritten);
                            wrapped.stack = effectiveError.stack;
                            effectiveError = wrapped;
                        }
                    }
                    await callback(
                        createActionErrorResponse({
                            actionName: config.name,
                            type: `${config.name.toLowerCase()}_error`,
                            text: config.errorTemplate(
                                rawParams as Partial<T>,
                                effectiveMessage,
                                resolvedModeOuter,
                            ),
                            error: effectiveError,
                            additionalMetadata: { mode: resolvedModeOuter },
                        })
                    );
                }

                return false;
            }
        },
    } as unknown as Action;
}
