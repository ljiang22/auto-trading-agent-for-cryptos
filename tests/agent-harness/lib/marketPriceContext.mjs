/**
 * Live market mid + resting price ladder for trading-prod write cases.
 */

import { formatOrderNlFromParams } from "./orderNlBridge.mjs";
import {
    PRODUCT_ID,
    LEG_SPREAD_PCT,
    MARKET_MID_OFFSET_PCT,
    REFERENCE_BTC_PRICE,
    buildAmendOrderCompose,
    buildCreateOrderCompose,
    buildPreviewOrderCompose,
    buildPriceLadderFromMid,
    formatUsdtPrice,
    toImplicitPrompt,
} from "./tradingFixtures.mjs";

export {
    LEG_SPREAD_PCT,
    MARKET_MID_OFFSET_PCT,
    formatUsdtPrice,
    buildPriceLadderFromMid,
    deriveRestingPriceLadder,
} from "./tradingFixtures.mjs";

/** Ordered Binance public market-data hosts (api.binance.com often returns HTTP 451). */
export const BINANCE_TICKER_BASES = [
    { base: "https://api.binance.com", label: "binance:com" },
    { base: "https://data-api.binance.vision", label: "binance:vision" },
    { base: "https://api.binance.us", label: "binance:us" },
];

const TICKER_PRICE_PATH = "/api/v3/ticker/price";
const BOOK_TICKER_PATH = "/api/v3/ticker/bookTicker";

/**
 * @param {string} productId - e.g. BTC-USDT
 */
export function productIdToBinanceSymbol(productId) {
    return String(productId || PRODUCT_ID).replace(/-/g, "").toUpperCase();
}

/**
 * @param {string} base
 * @param {string} symbol
 * @param {typeof fetch} fetchFn
 */
async function fetchTickerPriceFromBase(base, symbol, fetchFn) {
    const url = `${base}${TICKER_PRICE_PATH}?symbol=${encodeURIComponent(symbol)}`;
    const response = await fetchFn(url);
    if (!response.ok) {
        throw new Error(`${base} ticker HTTP ${response.status}`);
    }
    const data = await response.json();
    const price = Number.parseFloat(String(data?.price ?? ""));
    if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`invalid ticker price from ${base} for ${symbol}`);
    }
    return price;
}

/**
 * @param {string} base
 * @param {string} symbol
 * @param {typeof fetch} fetchFn
 */
async function fetchBookTickerMidFromBase(base, symbol, fetchFn) {
    const url = `${base}${BOOK_TICKER_PATH}?symbol=${encodeURIComponent(symbol)}`;
    const response = await fetchFn(url);
    if (!response.ok) {
        throw new Error(`${base} bookTicker HTTP ${response.status}`);
    }
    const data = await response.json();
    const bid = Number.parseFloat(String(data?.bidPrice ?? ""));
    const ask = Number.parseFloat(String(data?.askPrice ?? ""));
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
        throw new Error(`invalid bookTicker from ${base} for ${symbol}`);
    }
    return (bid + ask) / 2;
}

/**
 * @param {string} [productId]
 * @param {{ fetchFn?: typeof fetch }} [opts]
 * @returns {Promise<{ mid: number, source: string }>}
 */
export async function fetchBinanceMidPrice(productId = PRODUCT_ID, opts = {}) {
    const fetchFn = opts.fetchFn ?? globalThis.fetch;
    if (typeof fetchFn !== "function") {
        throw new Error("fetch is not available");
    }
    const symbol = productIdToBinanceSymbol(productId);
    const errors = [];

    for (const { base, label } of BINANCE_TICKER_BASES) {
        try {
            const mid = await fetchTickerPriceFromBase(base, symbol, fetchFn);
            return { mid, source: label };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`[market] ${base} failed (${message})`);
            errors.push(message);
        }
    }

    for (const { base, label } of BINANCE_TICKER_BASES) {
        try {
            const mid = await fetchBookTickerMidFromBase(base, symbol, fetchFn);
            return { mid, source: `${label}:bookTicker` };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`[market] ${base} bookTicker failed (${message})`);
            errors.push(message);
        }
    }

    throw new Error(errors.join("; ") || "all Binance market-data hosts failed");
}

/**
 * @param {{ productId?: string, skipFetch?: boolean, midOverride?: number, fetchFn?: typeof fetch }} [opts]
 */
export async function loadMarketPriceContext(opts = {}) {
    const productId = opts.productId ?? PRODUCT_ID;
    let mid = REFERENCE_BTC_PRICE;
    let source = "fallback";

    const override =
        opts.midOverride != null ? Number.parseFloat(String(opts.midOverride)) : Number.NaN;
    if (!opts.skipFetch && Number.isFinite(override) && override > 0) {
        mid = override;
        source = "override";
    } else if (!opts.skipFetch) {
        try {
            const fetched = await fetchBinanceMidPrice(productId, { fetchFn: opts.fetchFn });
            mid = fetched.mid;
            source = fetched.source;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(
                `[market] fetch failed (${message}); using REFERENCE_BTC_PRICE=${REFERENCE_BTC_PRICE}`,
            );
        }
    }

    const priceLadder = buildPriceLadderFromMid(mid);
    return {
        productId,
        mid,
        source,
        priceLadder,
    };
}

/**
 * @param {Record<string, unknown>} orderConfiguration
 * @returns {string | null}
 */
export function detectVariantFromOrderConfiguration(orderConfiguration) {
    if (!orderConfiguration || typeof orderConfiguration !== "object") {
        return null;
    }
    const keys = Object.keys(orderConfiguration);
    return keys.length === 1 ? keys[0] : null;
}

const MARKET_VARIANT_PREFIX = "market_";

/**
 * @param {Record<string, unknown>} caseDef
 */
export function caseNeedsMarketPrices(caseDef) {
    const compose = caseDef?.compose;
    if (!compose || typeof compose !== "object") {
        return false;
    }
    const action = String(compose.action || "");
    if (action === "amend_order") {
        return true;
    }
    if (action === "preview_order") {
        const variant = detectVariantFromOrderConfiguration(
            compose.params?.order_configuration,
        );
        return variant != null && !variant.startsWith(MARKET_VARIANT_PREFIX);
    }
    if (action !== "create_order") {
        return false;
    }
    const variant = detectVariantFromOrderConfiguration(
        compose.params?.order_configuration,
    );
    if (!variant) {
        return false;
    }
    if (variant.startsWith(MARKET_VARIANT_PREFIX)) {
        return false;
    }
    return true;
}

/**
 * @param {Record<string, unknown>} cases
 */
export function suiteNeedsMarketPrices(cases) {
    return (cases || []).some((c) => caseNeedsMarketPrices(c));
}

const GTD_VARIANTS = new Set([
    "limit_limit_gtd",
    "stop_limit_stop_limit_gtd",
    "trigger_bracket_gtd",
]);

/**
 * @param {Record<string, unknown>} originalOc
 * @param {Record<string, unknown>} rebuiltOc
 * @param {string} variant
 */
function preserveGtdEndTime(originalOc, rebuiltOc, variant) {
    if (!GTD_VARIANTS.has(variant)) {
        return;
    }
    const origEnd = originalOc?.[variant]?.end_time;
    if (typeof origEnd === "string" && rebuiltOc?.[variant]) {
        rebuiltOc[variant].end_time = origEnd;
    }
}

/**
 * @param {Record<string, unknown>} caseDef
 * @param {{ mid: number, priceLadder: ReturnType<typeof deriveRestingPriceLadder>, productId?: string }} ctx
 */
export function applyMarketContextToCase(caseDef, ctx) {
    if (!caseDef || !ctx?.priceLadder || !caseNeedsMarketPrices(caseDef)) {
        return caseDef;
    }

    const cloned = structuredClone(caseDef);
    const compose = cloned.compose;
    const params = compose?.params || {};
    const priceLadder = ctx.priceLadder;
    const marketMid = ctx.mid;
    const tags = (cloned.tags || []).map((t) => String(t).toLowerCase());
    const implicitVenue = tags.includes("implicit_venue");

    const preserveClientOrderId =
        typeof params.client_order_id === "string" ? params.client_order_id : undefined;

    if (compose.action === "amend_order") {
        const rebuilt = buildAmendOrderCompose({
            orderId: params.orderId ?? params.order_id,
            newLimitPrice: priceLadder.amendPrice,
            productId: params.product_id,
            mode: params.mode,
            marketMid,
            priceLadder,
        });
        cloned.compose = {
            ...compose,
            ...rebuilt,
            params: { ...rebuilt.params, orderId: params.orderId ?? params.order_id },
        };
        const nl = rebuilt.previewText;
        cloned.message = { ...(cloned.message || {}), text: implicitVenue ? toImplicitPrompt(nl) : nl };
        return cloned;
    }

    if (compose.action === "preview_order") {
        const variant =
            detectVariantFromOrderConfiguration(params.order_configuration) ||
            "limit_limit_gtc";
        const rebuilt = buildPreviewOrderCompose({
            variant,
            side: params.side,
            caseId: String(cloned.id ?? "preview"),
            productId: params.product_id,
            mode: params.mode,
            marketMid,
            priceLadder,
        });
        if (preserveClientOrderId) {
            rebuilt.params.client_order_id = preserveClientOrderId;
        }
        cloned.compose = { ...compose, ...rebuilt };
        const nl = rebuilt.previewText;
        cloned.message = { ...(cloned.message || {}), text: implicitVenue ? toImplicitPrompt(nl) : nl };
        return cloned;
    }

    const variant = detectVariantFromOrderConfiguration(params.order_configuration);
    if (!variant) {
        return cloned;
    }

    if (cloned.id === "risk-min-order-size") {
        const buyLimit = priceLadder.buyLimit;
        const oc = { ...(params.order_configuration || {}) };
        if (oc.limit_limit_gtc) {
            oc.limit_limit_gtc = {
                ...oc.limit_limit_gtc,
                limit_price: buyLimit,
            };
        }
        const nextParams = { ...params, order_configuration: oc };
        const previewText = formatOrderNlFromParams("create_order", nextParams);
        cloned.compose = {
            ...compose,
            previewText,
            params: nextParams,
        };
        cloned.message = {
            ...(cloned.message || {}),
            text: implicitVenue ? toImplicitPrompt(previewText) : previewText,
        };
        return cloned;
    }

    const rebuilt = buildCreateOrderCompose({
        variant,
        side: params.side,
        marginType: params.margin_type,
        marginAction: params.margin_action,
        leverage: params.leverage,
        productId: params.product_id,
        mode: params.mode,
        caseId: String(cloned.id ?? "case"),
        postOnly: Boolean(
            params.order_configuration?.[variant]?.post_only ??
                params.order_configuration?.limit_limit_gtc?.post_only,
        ),
        marketMid,
        priceLadder,
    });
    if (preserveClientOrderId) {
        rebuilt.params.client_order_id = preserveClientOrderId;
    }
    preserveGtdEndTime(
        params.order_configuration,
        rebuilt.params.order_configuration,
        variant,
    );
    cloned.compose = { ...compose, ...rebuilt };

    const nl = rebuilt.previewText;
    cloned.message = {
        ...(cloned.message || {}),
        text: implicitVenue ? toImplicitPrompt(nl) : nl,
    };
    cloned.compose.previewText = nl;
    return cloned;
}
