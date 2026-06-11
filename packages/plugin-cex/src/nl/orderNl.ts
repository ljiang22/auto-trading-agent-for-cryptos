/**
 * Canonical order NL formatter — projects approval/compose params
 * (the same shape TradingOrderEditor submits) into human-readable text.
 */

import type { CanonicalAction } from "../intent/canonicalIntent";

export const ORDER_VARIANT_LABELS: Record<string, { type: string; tif: string }> = {
    market_market_ioc: { type: "Market", tif: "IOC" },
    market_market_fok: { type: "Market", tif: "FOK" },
    limit_limit_gtc: { type: "Limit", tif: "GTC" },
    limit_limit_gtd: { type: "Limit", tif: "GTD" },
    sor_limit_ioc: { type: "Limit (SOR)", tif: "IOC" },
    limit_limit_fok: { type: "Limit", tif: "FOK" },
    stop_limit_stop_limit_gtc: { type: "Stop-Limit", tif: "GTC" },
    stop_limit_stop_limit_gtd: { type: "Stop-Limit", tif: "GTD" },
    trigger_bracket_gtc: { type: "Trigger Bracket", tif: "GTC" },
    trigger_bracket_gtd: { type: "Trigger Bracket", tif: "GTD" },
    trailing_stop_limit_gtc: { type: "Trailing Stop", tif: "GTC" },
    oco_gtc: { type: "OCO (TP+SL)", tif: "GTC" },
};

export type OrderNlVenueMode = "explicit" | "implicit";

export interface FormatOrderNlOptions {
    locale?: "en" | "zh-CN" | "mixed-en";
    includeVenuePrefix?: boolean;
    venueMode?: OrderNlVenueMode;
    exchangeLabel?: string;
}

export interface FormatOrderNlInput {
    action: string;
    params: Record<string, unknown>;
    options?: FormatOrderNlOptions;
}

function asString(v: unknown): string {
    if (v === null || v === undefined) return "";
    return typeof v === "string" ? v : String(v);
}

function stripVenuePrefix(text: string): string {
    return text
        .replace(/Using Binance,?\s*/gi, "")
        .replace(/\bon Binance\b/gi, "")
        .replace(/\bBinance\b/gi, "")
        .replace(/\s+/g, " ")
        .trim();
}

function venuePrefix(opts?: FormatOrderNlOptions): string {
    if (opts?.includeVenuePrefix === false) return "";
    if (opts?.venueMode === "implicit") return "";
    const label = opts?.exchangeLabel ?? "Binance";
    return `Using ${label}, `;
}

function sideVerb(side: unknown): string {
    const u = asString(side).trim().toUpperCase();
    return u === "SELL" ? "sell" : "buy";
}

function marginContextPhrase(params: Record<string, unknown>): string {
    const marginType = asString(params.margin_type).toUpperCase();
    const marginAction = asString(params.margin_action).toUpperCase();
    const parts: string[] = [];
    if (marginType === "CROSS") parts.push("on cross margin");
    else if (marginType === "ISOLATED") parts.push("on isolated margin");
    if (marginAction === "AUTO_BORROW") parts.push("with auto-borrow");
    else if (marginAction === "AUTO_REPAY") parts.push("with auto-repay");
    return parts.length > 0 ? `${parts.join(" ")} ` : "";
}

function leveragePhrase(params: Record<string, unknown>): string {
    const lev = asString(params.leverage).trim();
    return lev ? `at ${lev}x leverage ` : "";
}

function productIdFromParams(params: Record<string, unknown>): string {
    return (
        asString(params.product_id).trim() ||
        asString(params.symbol).trim() ||
        "BTC-USDT"
    );
}

function baseAssetFromProductId(productId: string): string {
    const normalized = productId.replace(/\//g, "-").replace(/_/g, "-").toUpperCase();
    const idx = normalized.indexOf("-");
    if (idx > 0) return normalized.slice(0, idx);
    const quotes = ["USDC", "USDT", "FDUSD", "BUSD", "USD"];
    for (const q of quotes) {
        if (normalized.endsWith(q) && normalized.length > q.length) {
            return normalized.slice(0, -q.length);
        }
    }
    return "BTC";
}

export function detectOrderVariant(
    orderConfiguration: unknown,
): string | null {
    if (!orderConfiguration || typeof orderConfiguration !== "object") {
        return null;
    }
    const keys = Object.keys(orderConfiguration as Record<string, unknown>);
    return keys.length === 1 ? keys[0] : null;
}

function innerFromOrderConfiguration(
    orderConfiguration: unknown,
): { variant: string | null; inner: Record<string, unknown> } {
    const variant = detectOrderVariant(orderConfiguration);
    if (!variant) return { variant: null, inner: {} };
    const raw = (orderConfiguration as Record<string, unknown>)[variant];
    const inner =
        raw && typeof raw === "object" && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : {};
    return { variant, inner };
}

function variantTif(variant: string): string {
    return ORDER_VARIANT_LABELS[variant]?.tif ?? "GTC";
}

function formatCreateOrPreviewBody(
    params: Record<string, unknown>,
    variant: string | null,
    inner: Record<string, unknown>,
    isPreview: boolean,
): string {
    const side = sideVerb(params.side);
    const productId = productIdFromParams(params);
    const baseAsset = baseAssetFromProductId(productId);
    const baseSize = asString(inner.base_size);
    const quoteSize = asString(inner.quote_size);
    const limitPrice = asString(inner.limit_price);
    const stopPrice = asString(inner.stop_price);
    const stopLimitPrice = asString(inner.below_limit_price) || limitPrice;
    const postOnly =
        inner.post_only === true || inner.post_only === "true";
    const activation = asString(inner.activation_price);
    const trailingBps = asString(inner.trailing_delta_bps) || "100";
    const ocoTp = asString(inner.above_limit_price);
    const ocoSlStop = asString(inner.below_stop_price);
    const ocoSlLimit = asString(inner.below_limit_price);
    const bracketTp = asString(inner.limit_price);
    const bracketSl = asString(inner.stop_trigger_price);
    const tif = variant ? variantTif(variant) : "GTC";

    let body: string;
    switch (variant) {
        case "market_market_ioc":
        case "market_market_fok":
            body = quoteSize
                ? `${side} $${quoteSize} of ${productId} at market`
                : `${side} ${baseSize} ${baseAsset} of ${productId} at market`;
            break;
        case "limit_limit_gtc":
            body = `${side} ${baseSize} ${baseAsset} at ${limitPrice} limit GTC on ${productId}${postOnly ? " post-only" : ""}`;
            break;
        case "limit_limit_fok":
            body = `${side} ${baseSize} ${baseAsset} at ${limitPrice} limit FOK on ${productId}`;
            break;
        case "limit_limit_gtd":
            body = `${side} ${baseSize} ${baseAsset} at ${limitPrice} limit GTD on ${productId}`;
            break;
        case "sor_limit_ioc":
            body = `${side} ${baseSize} ${baseAsset} at ${limitPrice} limit IOC on ${productId}`;
            break;
        case "stop_limit_stop_limit_gtc":
            body = `${side} ${baseSize} ${baseAsset} stop-limit on ${productId} stop ${stopPrice} limit ${stopLimitPrice} GTC`;
            break;
        case "stop_limit_stop_limit_gtd":
            body = `${side} ${baseSize} ${baseAsset} stop-limit on ${productId} stop ${stopPrice} limit ${stopLimitPrice} GTD`;
            break;
        case "trailing_stop_limit_gtc":
            body = `${side} ${baseSize} ${baseAsset} trailing stop-limit on ${productId} activation ${activation} ${trailingBps}bps`;
            break;
        case "oco_gtc":
            body = `${side} ${baseSize} ${baseAsset} OCO on ${productId} take-profit ${ocoTp} stop-loss ${ocoSlStop}/${ocoSlLimit}`;
            break;
        case "trigger_bracket_gtc":
            body = `${side} ${productId} bracket take-profit ${bracketTp} stop trigger ${bracketSl} GTC`;
            break;
        case "trigger_bracket_gtd":
            body = `${side} ${productId} bracket take-profit ${bracketTp} stop trigger ${bracketSl} GTD`;
            break;
        default:
            body = `${side} ${productId}`;
            if (quoteSize) body += ` ($${quoteSize})`;
            else if (baseSize) body += ` (${baseSize} ${baseAsset})`;
            if (limitPrice) body += ` at ${limitPrice} limit ${tif}`;
            break;
    }

    if (isPreview) {
        return `preview ${body} and estimate fees`;
    }
    return body;
}

function formatCancelBody(params: Record<string, unknown>): string {
    const productId = productIdFromParams(params);
    const marginType = asString(params.margin_type).toUpperCase();
    const margin =
        marginType === "CROSS"
            ? "cross margin "
            : marginType === "ISOLATED"
              ? "isolated margin "
              : "";
    const allOpen = params.all_open === true || params.all_open === "true";
    const orderIds = Array.isArray(params.order_ids)
        ? params.order_ids.map((id) => asString(id).trim()).filter(Boolean)
        : [];
    const useAllOpen = allOpen && orderIds.length === 0;
    if (useAllOpen) {
        return `cancel all open ${margin}${productId} orders`;
    }
    return `cancel ${productId} orders ${orderIds.join(", ")}`;
}

function formatAmendBody(params: Record<string, unknown>): string {
    const productId = productIdFromParams(params);
    const orderId =
        asString(params.orderId).trim() ||
        asString(params.order_id).trim();
    const limit =
        asString(params.price).trim() ||
        asString(params.limit_price).trim();
    return `amend order ${orderId} on ${productId} to limit ${limit}`;
}

function formatGetOrdersBody(params: Record<string, unknown>): string {
    const productId = productIdFromParams(params);
    const marginType = asString(params.margin_type).toUpperCase();
    const history = params.history === true || params.history === "true";
    if (history) {
        return `show my recent ${productId} order history`;
    }
    if (marginType === "CROSS") {
        return `list my open cross margin ${productId} orders`;
    }
    if (marginType === "ISOLATED") {
        return `list my open isolated margin ${productId} orders`;
    }
    return `list my open ${productId} orders`;
}

/**
 * Full harness-style NL sentence from approval/compose params.
 */
export function formatOrderNlFromParams(input: FormatOrderNlInput): string {
    const { action, params, options } = input;
    const prefix = venuePrefix(options);
    const margin = marginContextPhrase(params);
    const lev = leveragePhrase(params);

    const { variant, inner } = innerFromOrderConfiguration(
        params.order_configuration,
    );

    let body: string;
    switch (action) {
        case "create_order":
            body = formatCreateOrPreviewBody(params, variant, inner, false);
            break;
        case "preview_order":
            body = formatCreateOrPreviewBody(params, variant, inner, true);
            break;
        case "cancel_order":
            body = formatCancelBody(params);
            break;
        case "amend_order":
            body = formatAmendBody(params);
            break;
        case "get_orders":
            body = formatGetOrdersBody(params);
            break;
        default:
            return "";
    }

    const raw = `${prefix}${lev}${margin}${body}.`.replace(/\s+/g, " ");
    if (options?.venueMode === "implicit") {
        return `${stripVenuePrefix(raw)}.`.replace(/\s+/g, " ").replace(/\.\.$/, ".");
    }
    return raw;
}

/**
 * Compact chip-style summary for stream/UI interrupts.
 */
export function formatOrderSummaryShort(
    params: Record<string, unknown>,
    action: string,
): string {
    const side = asString(params.side).trim().toUpperCase();
    const productId = productIdFromParams(params);
    const baseAsset = baseAssetFromProductId(productId);

    switch (action) {
        case "create_order":
        case "preview_order": {
            const { variant, inner } = innerFromOrderConfiguration(
                params.order_configuration,
            );
            const labels = variant ? ORDER_VARIANT_LABELS[variant] : null;
            const typeLabel = labels
                ? `${labels.type} ${labels.tif}`
                : "Order";
            const size =
                asString(inner.quote_size) && variant?.startsWith("market")
                    ? `$${asString(inner.quote_size)}`
                    : asString(inner.base_size)
                      ? `${asString(inner.base_size)} ${baseAsset}`
                      : "";
            const price = asString(inner.limit_price);
            const parts = [typeLabel];
            if (side) parts.push(side);
            if (size) parts.push(size);
            if (price) parts.push(`@ ${price}`);
            parts.push(`on ${productId}`);
            const summary = parts.join(" ");
            return action === "preview_order" ? `Preview ${summary}` : summary;
        }
        case "cancel_order": {
            const allOpen =
                params.all_open === true || params.all_open === "true";
            const ids = Array.isArray(params.order_ids)
                ? params.order_ids.length
                : 0;
            if (allOpen && ids === 0) {
                return `Cancel all open ${productId} orders`;
            }
            return `Cancel ${ids || 1} ${productId} order(s)`;
        }
        case "amend_order": {
            const orderId =
                asString(params.orderId) || asString(params.order_id);
            const price =
                asString(params.price) || asString(params.limit_price);
            return `Amend ${orderId} to ${price} on ${productId}`;
        }
        case "get_orders":
            return formatGetOrdersBody(params);
        default:
            return action.replace(/_/g, " ");
    }
}

export function formatApprovalInterruptTitle(
    params: Record<string, unknown>,
    action: string,
): string {
    const summary = formatOrderSummaryShort(params, action);
    if (!summary || summary === action.replace(/_/g, " ")) {
        return "Review & Authorize Order";
    }
    const side = asString(params.side).trim().toUpperCase();
    const sideWord =
        side === "BUY" ? "Buy" : side === "SELL" ? "Sell" : "";
    if (sideWord && !summary.includes(side)) {
        return `Review & Authorize ${summary} ${sideWord}`.replace(/\s+/g, " ");
    }
    return `Review & Authorize ${summary}`.replace(/\s+/g, " ");
}

export const ORDER_WRITE_ACTIONS: ReadonlySet<CanonicalAction> = new Set([
    "create_order",
    "preview_order",
    "amend_order",
    "cancel_order",
]);
