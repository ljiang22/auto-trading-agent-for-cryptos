/**
 * Live trading test fixtures — 6 USDT notional on BTC-USDT (Binance).
 */

import { formatOrderNlFromParams } from "./orderNlBridge.mjs";
import { extractOrderRefsFromTranscript } from "./transcript.mjs";

export const NOTIONAL_USDT = 6;
export const REFERENCE_BTC_PRICE = 100_000;
export const PRODUCT_ID = "BTC-USDT";
export const EXCHANGE = "binance";

/** Limit/trailing/amend prices anchor on fetched mid (no offset). */
export const MARKET_MID_OFFSET_PCT = 0;
/** Minimal spread between multi-leg stop/OCO/bracket prices for exchange ordering. */
export const LEG_SPREAD_PCT = 0.001;

/**
 * @param {number} value
 */
export function formatUsdtPrice(value) {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`invalid price: ${value}`);
    }
    return value.toFixed(2);
}

/**
 * @param {number} mid
 */
export function deriveRestingPriceLadder(mid) {
    const m = Number(mid);
    if (!Number.isFinite(m) || m <= 0) {
        throw new Error(`invalid market mid: ${mid}`);
    }
    const midPrice = formatUsdtPrice(m);
    const buyStopLimit = m * (1 + LEG_SPREAD_PCT);
    const sellStopLimit = m * (1 - LEG_SPREAD_PCT);

    return {
        mid: m,
        buyLimit: midPrice,
        sellLimit: midPrice,
        buyStop: midPrice,
        buyStopLimit: formatUsdtPrice(buyStopLimit),
        sellStop: midPrice,
        sellStopLimit: formatUsdtPrice(sellStopLimit),
        buyActivation: midPrice,
        sellActivation: midPrice,
        amendPrice: midPrice,
    };
}

/** @param {number} mid */
export function buildPriceLadderFromMid(mid) {
    return deriveRestingPriceLadder(mid);
}

function defaultStaticPriceLadder() {
    return deriveRestingPriceLadder(REFERENCE_BTC_PRICE);
}

/**
 * @param {{ marketMid?: number, priceLadder?: ReturnType<typeof deriveRestingPriceLadder>, side?: string }} opts
 */
function resolvePricing(opts = {}) {
    const marketMid =
        opts.marketMid ?? opts.priceLadder?.mid ?? REFERENCE_BTC_PRICE;
    const priceLadder = opts.priceLadder ?? defaultStaticPriceLadder();
    const side = opts.side || "BUY";
    const base = baseSizeFor6Usdt(marketMid);
    const limitPrice = side === "BUY" ? priceLadder.buyLimit : priceLadder.sellLimit;
    const stopPrice = side === "BUY" ? priceLadder.buyStop : priceLadder.sellStop;
    const stopLimitPrice =
        side === "BUY" ? priceLadder.buyStopLimit : priceLadder.sellStopLimit;
    const activation =
        side === "SELL" ? priceLadder.sellActivation : priceLadder.buyActivation;
    return { marketMid, priceLadder, base, limitPrice, stopPrice, stopLimitPrice, activation };
}

export const ROOM_GROUPS = ["read_only", "spot", "margin"];

export const ROOM_GROUP_LABELS = {
    read_only: "Trading QA — Read Only",
    spot: "Trading QA — Spot",
    margin: "Trading QA — Margin",
};

/** Binance-supported create_order variants (mirrors canonical.ts capabilities). */
export const BINANCE_SUPPORTED_VARIANTS = [
    "market_market_ioc",
    "limit_limit_gtc",
    "limit_limit_fok",
    "limit_limit_gtd",
    "stop_limit_stop_limit_gtc",
    "stop_limit_stop_limit_gtd",
    "trailing_stop_limit_gtc",
    "oco_gtc",
];

export const BINANCE_UNSUPPORTED_VARIANTS = [
    "market_market_fok",
    "sor_limit_ioc",
    "trigger_bracket_gtc",
    "trigger_bracket_gtd",
];

export function baseSizeFor6Usdt(referencePrice = REFERENCE_BTC_PRICE) {
    const size = NOTIONAL_USDT / referencePrice;
    return size.toFixed(8).replace(/\.?0+$/, "") || "0.00006";
}

export function quoteSize6() {
    return NOTIONAL_USDT.toFixed(2);
}

function gtdEndTime() {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString();
}

/**
 * Build order_configuration object for a variant.
 * @param {string} variant
 * @param {{ side?: string, postOnly?: boolean, marketMid?: number, priceLadder?: ReturnType<typeof deriveRestingPriceLadder> }} [opts]
 */
export function buildOrderConfiguration(variant, opts = {}) {
    const side = opts.side || "BUY";
    const { base, limitPrice, stopPrice, stopLimitPrice, activation, priceLadder } =
        resolvePricing(opts);

    switch (variant) {
        case "market_market_ioc":
            return { market_market_ioc: { quote_size: quoteSize6() } };
        case "market_market_fok":
            return { market_market_fok: { quote_size: quoteSize6() } };
        case "limit_limit_gtc":
            return {
                limit_limit_gtc: {
                    base_size: base,
                    limit_price: limitPrice,
                    ...(opts.postOnly ? { post_only: true } : {}),
                },
            };
        case "limit_limit_fok":
            return {
                limit_limit_fok: {
                    base_size: base,
                    limit_price: limitPrice,
                },
            };
        case "limit_limit_gtd":
            return {
                limit_limit_gtd: {
                    base_size: base,
                    limit_price: limitPrice,
                    end_time: gtdEndTime(),
                },
            };
        case "sor_limit_ioc":
            return {
                sor_limit_ioc: {
                    base_size: base,
                    limit_price: limitPrice,
                },
            };
        case "stop_limit_stop_limit_gtc":
            return {
                stop_limit_stop_limit_gtc: {
                    base_size: base,
                    stop_price: stopPrice,
                    limit_price: stopLimitPrice,
                },
            };
        case "stop_limit_stop_limit_gtd":
            return {
                stop_limit_stop_limit_gtd: {
                    base_size: base,
                    stop_price: stopPrice,
                    limit_price: stopLimitPrice,
                    end_time: gtdEndTime(),
                },
            };
        case "trailing_stop_limit_gtc":
            return {
                trailing_stop_limit_gtc: {
                    base_size: base,
                    trailing_delta_bps: 100,
                    activation_price: activation,
                },
            };
        case "oco_gtc":
            return {
                oco_gtc: {
                    base_size: base,
                    above_limit_price: priceLadder.sellLimit,
                    below_stop_price: priceLadder.sellStop,
                    below_limit_price: priceLadder.sellStopLimit,
                },
            };
        case "trigger_bracket_gtc":
            return {
                trigger_bracket_gtc: {
                    limit_price: priceLadder.sellLimit,
                    stop_trigger_price: priceLadder.sellStop,
                },
            };
        case "trigger_bracket_gtd":
            return {
                trigger_bracket_gtd: {
                    limit_price: priceLadder.sellLimit,
                    stop_trigger_price: priceLadder.sellStop,
                    end_time: gtdEndTime(),
                },
            };
        default:
            throw new Error(`unknown order variant: ${variant}`);
    }
}

/** Placeholder venue order id for amend/cancel-by-id NL (ADK requires 6+ digits). */
export const PLACEHOLDER_ORDER_ID_A = "12345678901";
export const PLACEHOLDER_ORDER_ID_B = "12345678902";

function venuePrefix() {
    return "Using Binance, ";
}

function sideVerb(side) {
    return side === "SELL" ? "sell" : "buy";
}

function marginContextPhrase(marginType, marginAction) {
    const parts = [];
    if (marginType === "CROSS") {
        parts.push("on cross margin");
    } else if (marginType === "ISOLATED") {
        parts.push("on isolated margin");
    }
    if (marginAction === "AUTO_BORROW") {
        parts.push("with auto-borrow");
    } else if (marginAction === "AUTO_REPAY") {
        parts.push("with auto-repay");
    }
    return parts.length > 0 ? `${parts.join(" ")} ` : "";
}

/**
 * Build approval-shaped params for create_order NL from harness inputs.
 * @param {object} input
 */
function createOrderParamsFromHarnessInput(input) {
    const {
        variant,
        side = "BUY",
        marginType,
        marginAction,
        leverage,
        postOnly = false,
        productId = PRODUCT_ID,
        marketMid,
        priceLadder,
    } = input;
    const params = {
        exchange: EXCHANGE,
        product_id: productId,
        side,
        order_configuration: buildOrderConfiguration(variant, {
            side,
            postOnly,
            marketMid,
            priceLadder,
        }),
    };
    if (marginType) {
        params.margin_type = marginType;
        params.margin_action = marginAction ?? "NORMAL";
    } else if (marginAction) {
        params.margin_action = marginAction;
    }
    if (leverage) {
        params.leverage = leverage;
    }
    return params;
}

/**
 * Canonical NL for create_order — derived from compose-shaped params.
 * @param {object} input
 */
export function buildCreateOrderNlText(input) {
    return formatOrderNlFromParams(
        "create_order",
        createOrderParamsFromHarnessInput(input),
    );
}

export function buildCancelOrderNlText(input = {}) {
    const {
        allOpen = true,
        orderIds = [],
        productId = PRODUCT_ID,
        marginType,
    } = input;
    const ids = Array.isArray(orderIds)
        ? orderIds.map((id) => String(id).trim()).filter(Boolean)
        : [];
    const useAllOpen = allOpen !== false && ids.length === 0;
    const params = {
        exchange: EXCHANGE,
        product_id: productId,
        all_open: useAllOpen,
        order_ids: useAllOpen ? [] : ids,
    };
    if (marginType) {
        params.margin_type = marginType;
    }
    return formatOrderNlFromParams("cancel_order", params);
}

export function buildGetOrdersNlText(input = {}) {
    const {
        productId = PRODUCT_ID,
        marginType,
        history = false,
    } = input;
    const params = {
        exchange: EXCHANGE,
        product_id: productId,
    };
    if (marginType) {
        params.margin_type = marginType;
    }
    if (history) {
        params.history = true;
    }
    return formatOrderNlFromParams("get_orders", params);
}

export function buildGetBalanceNlText(input = {}) {
    const { walletType } = input;
    switch (walletType) {
        case "spot":
            return `${venuePrefix()}show my spot wallet balances for ${PRODUCT_ID} and other non-zero assets.`;
        case "margin_cross":
            return `${venuePrefix()}show my cross margin wallet balances.`;
        case "margin_isolated":
            return `${venuePrefix()}show my isolated margin wallet balances.`;
        default:
            return `${venuePrefix()}show my balances across spot, cross margin, and isolated margin wallets for ${PRODUCT_ID} and summarize all non-zero assets.`;
    }
}

export function buildGetFillsNlText(input = {}) {
    const { productId = PRODUCT_ID, orderId } = input;
    if (orderId) {
        return `${venuePrefix()}fetch my trade fills for order ${orderId} on ${productId}.`;
    }
    return `${venuePrefix()}fetch my recent ${productId} trade fills.`;
}

export function buildGetPositionsNlText(input = {}) {
    const { walletType, productId = PRODUCT_ID } = input;
    if (walletType === "margin_cross") {
        return `${venuePrefix()}show my cross margin positions for ${productId}.`;
    }
    if (walletType === "margin_isolated") {
        return `${venuePrefix()}show my isolated margin positions for ${productId}.`;
    }
    return `${venuePrefix()}show my margin positions for ${productId} if any.`;
}

export function buildGetPnlNlText(input = {}) {
    const { scope } = input;
    if (scope === "realized") {
        return `${venuePrefix()}summarize my recent realized PnL on ${PRODUCT_ID}.`;
    }
    return `${venuePrefix()}summarize my recent realized PnL.`;
}

export function buildGetTickerNlText(input = {}) {
    const { productId = PRODUCT_ID } = input;
    return `${venuePrefix()}get the current ${productId} ticker price.`;
}

export function buildGetOrderbookNlText(input = {}) {
    const { productId = PRODUCT_ID } = input;
    return `${venuePrefix()}show the ${productId} order book top of book.`;
}

export function buildGetTradingModeNlText() {
    return "What is my current Binance trading mode?";
}

export function buildListAssetListsNlText() {
    return "Show my blocked and allowed asset lists for trading.";
}

export function buildAmendOrderNlText(input = {}) {
    const {
        orderId = PLACEHOLDER_ORDER_ID_A,
        newLimitPrice,
        productId = PRODUCT_ID,
        marketMid,
        priceLadder,
    } = input;
    const { priceLadder: ladder } = resolvePricing({ marketMid, priceLadder });
    const limit = newLimitPrice ?? ladder.amendPrice;
    return formatOrderNlFromParams("amend_order", {
        exchange: EXCHANGE,
        product_id: productId,
        orderId,
        price: limit,
    });
}

export function buildPreviewOrderNlText(input = {}) {
    const {
        variant = "market_market_ioc",
        side = "BUY",
        productId = PRODUCT_ID,
        marketMid,
        priceLadder,
    } = input;
    return formatOrderNlFromParams("preview_order", {
        exchange: EXCHANGE,
        product_id: productId,
        side,
        order_configuration: buildOrderConfiguration(variant, {
            side,
            marketMid,
            priceLadder,
        }),
    });
}

export function buildSetTradingModeNlText(input = {}) {
    const { mode = "paper" } = input;
    return `${venuePrefix()}switch my trading mode to ${mode}.`;
}

export function buildTeardownVerifyOrdersNlText(clientOrderIds) {
    const ids = (clientOrderIds || []).join(", ");
    return `List my open BTC-USDT spot orders. Confirm none of these harness client order IDs are still open: ${ids}.`;
}

export function buildTeardownVerifyPositionsNlText(clientOrderIds) {
    const ids = (clientOrderIds || []).join(", ");
    return `Show my margin positions for BTC-USDT. Confirm none of these harness test orders remain open: ${ids}.`;
}

/**
 * @param {object} input
 * @param {string} input.variant
 * @param {string} [input.side]
 * @param {string} [input.marginType] - CROSS | ISOLATED
 * @param {string} [input.marginAction]
 * @param {string} [input.leverage]
 * @param {string} [input.productId]
 * @param {string} [input.mode]
 * @param {string} [input.caseId]
 * @param {boolean} [input.postOnly]
 */
export function buildCreateOrderCompose(input) {
    const {
        variant,
        side = "BUY",
        marginType,
        marginAction,
        leverage,
        productId = PRODUCT_ID,
        mode = "live",
        caseId = "case",
        postOnly = false,
        marketMid,
        priceLadder,
    } = input;

    const params = {
        exchange: EXCHANGE,
        product_id: productId,
        side,
        mode,
        order_configuration: buildOrderConfiguration(variant, {
            side,
            postOnly,
            marketMid,
            priceLadder,
        }),
        client_order_id: `harness-${caseId}-${Date.now()}`,
    };

    if (marginType) {
        params.margin_type = marginType;
        params.margin_action = marginAction ?? "NORMAL";
    } else if (marginAction) {
        params.margin_action = marginAction;
    }
    if (leverage) {
        params.leverage = leverage;
    }

    const previewText = formatOrderNlFromParams("create_order", params);

    return {
        action: "create_order",
        previewText,
        params,
        preApproved: false,
    };
}

export function buildAmendOrderCompose(input = {}) {
    const {
        orderId = PLACEHOLDER_ORDER_ID_A,
        newLimitPrice,
        productId = PRODUCT_ID,
        mode = "live",
        marketMid,
        priceLadder,
    } = input;
    const { priceLadder: ladder } = resolvePricing({ marketMid, priceLadder });
    const limit = newLimitPrice ?? ladder.amendPrice;
    const params = {
        exchange: EXCHANGE,
        product_id: productId,
        mode,
        orderId,
        price: limit,
    };
    const previewText = formatOrderNlFromParams("amend_order", params);
    return {
        action: "amend_order",
        previewText,
        params,
        preApproved: false,
    };
}

export function buildPreviewOrderCompose(input = {}) {
    const {
        variant = "market_market_ioc",
        side = "BUY",
        caseId = "preview",
        productId = PRODUCT_ID,
        mode = "live",
        marketMid,
        priceLadder,
    } = input;
    const params = {
        exchange: EXCHANGE,
        product_id: productId,
        side,
        mode,
        order_configuration: buildOrderConfiguration(variant, {
            side,
            marketMid,
            priceLadder,
        }),
        client_order_id: `harness-${caseId}-${Date.now()}`,
    };
    const previewText = formatOrderNlFromParams("preview_order", params);
    return {
        action: "preview_order",
        previewText,
        params,
        preApproved: false,
    };
}

export function buildSetTradingModeCompose(input = {}) {
    const { mode = "paper" } = input;
    const previewText = buildSetTradingModeNlText({ mode });
    return {
        action: "set_trading_mode",
        previewText,
        params: { mode },
        preApproved: false,
    };
}

/**
 * Compose block with previewText derived from params (single source of truth).
 * @param {string} action
 * @param {Record<string, unknown>} params
 */
export function buildComposeFromParams(action, params) {
    return {
        action,
        params,
        previewText: formatOrderNlFromParams(action, params),
        preApproved: false,
    };
}

export function approvalTemplateKeyForCase(prefix, variant, side, marginType) {
    const parts = [prefix, marginType?.toLowerCase(), variant, side.toLowerCase()].filter(
        Boolean,
    );
    return parts.join("_");
}

/**
 * Remove explicit venue mentions from NL / preview text.
 * @param {string} text
 */
export function toImplicitPrompt(text) {
    if (!text || typeof text !== "string") {
        return text;
    }
    return text
        .replace(/Using Binance,?\s*/gi, "")
        .replace(/\bon Binance\b/gi, "")
        .replace(/\bBinance\b/gi, "")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * @param {object} input
 * @param {string} input.caseId
 * @param {boolean} [input.allOpen]
 * @param {string} [input.productId]
 * @param {string} [input.exchange]
 * @param {string} [input.mode]
 * @param {string} [input.marginType]
 */
export function buildCancelOrderCompose(input) {
    const {
        caseId = "cancel",
        allOpen = true,
        orderIds = [],
        productId = PRODUCT_ID,
        exchange = EXCHANGE,
        mode = "live",
        marginType,
    } = input;

    const ids = Array.isArray(orderIds)
        ? orderIds.map((id) => String(id).trim()).filter(Boolean)
        : [];
    const useAllOpen = allOpen !== false && ids.length === 0;

    const params = {
        exchange,
        product_id: productId,
        mode,
        all_open: useAllOpen,
        order_ids: useAllOpen ? [] : ids,
    };
    if (marginType) {
        params.margin_type = marginType;
    }

    const previewText = formatOrderNlFromParams("cancel_order", params);

    return {
        action: "cancel_order",
        previewText,
        params,
        preApproved: false,
    };
}

/**
 * @param {object} input
 * @param {string} [input.productId]
 * @param {string} [input.marginType]
 */
export function buildGetOrdersCompose(input = {}) {
    const { productId = PRODUCT_ID, marginType, mode = "live", history = false } = input;
    const params = {
        exchange: EXCHANGE,
        product_ids: [productId],
        mode,
    };
    if (marginType) {
        params.margin_type = marginType;
    }
    const previewText = formatOrderNlFromParams("get_orders", {
        ...params,
        product_id: productId,
        history: history === true,
    });
    return {
        action: "get_orders",
        previewText,
        params,
        preApproved: false,
    };
}

const HARNESS_CLIENT_ORDER_PREFIX = "harness-";

/**
 * @param {Record<string, unknown>} caseDef
 * @param {import("./transcript.mjs").TranscriptState | null} transcript
 */
export function buildHarnessOrderRecord(caseDef, transcript) {
    const compose = caseDef?.compose;
    if (!compose || compose.action !== "create_order") {
        return null;
    }
    const clientOrderId = compose.params?.client_order_id;
    if (
        typeof clientOrderId !== "string" ||
        !clientOrderId.startsWith(HARNESS_CLIENT_ORDER_PREFIX)
    ) {
        return null;
    }
    const venueOrderIds = transcript
        ? extractOrderRefsFromTranscript(transcript, clientOrderId)
        : [];
    return {
        caseId: String(caseDef.id ?? "case"),
        clientOrderId,
        roomGroup: caseDef.roomGroup ?? null,
        marginType: compose.params?.margin_type ?? null,
        productId: compose.params?.product_id ?? PRODUCT_ID,
        venueOrderIds,
    };
}

/**
 * Turn one harness case into explicit + implicit venue twins.
 * @param {Record<string, unknown>} caseDef
 * @returns {Record<string, unknown>[]}
 */
export function mirrorNlCase(caseDef) {
    const text =
        (caseDef.message && typeof caseDef.message === "object"
            ? caseDef.message.text
            : null) ||
        caseDef.compose?.previewText ||
        "";

    if (!text || caseDef.mirror === false) {
        return [
            {
                ...caseDef,
                tags: [...(caseDef.tags || []), "explicit_venue"],
            },
        ];
    }

    const explicit = {
        ...caseDef,
        tags: [...(caseDef.tags || []), "explicit_venue"],
    };
    if (caseDef.compose) {
        explicit.compose = {
            ...caseDef.compose,
            previewText: caseDef.compose.previewText || text,
        };
        explicit.message = {
            ...(caseDef.message || {}),
            text: caseDef.message?.text || caseDef.compose.previewText || text,
        };
    }

    const implicitText = toImplicitPrompt(
        caseDef.message?.text || caseDef.compose?.previewText || text,
    );
    const implicit = {
        ...caseDef,
        id: `${caseDef.id}-implicit`,
        title: caseDef.title ? `${caseDef.title} (implicit venue)` : undefined,
        tags: [...(caseDef.tags || []), "implicit_venue"],
        message: {
            ...(caseDef.message || {}),
            text: implicitText,
        },
    };
    if (caseDef.compose) {
        implicit.compose = {
            ...caseDef.compose,
            previewText: toImplicitPrompt(
                caseDef.compose.previewText || caseDef.message?.text || text,
            ),
        };
    }

    return [explicit, implicit];
}

/**
 * Pick one venue variant by catalog index (even = explicit, odd = implicit).
 * @param {Record<string, unknown>} caseDef
 * @param {number} catalogIndex
 * @returns {Record<string, unknown>}
 */
export function pickAlternatingVenueCase(caseDef, catalogIndex) {
    const twins = mirrorNlCase(caseDef);
    const pickExplicit = catalogIndex % 2 === 0;
    const chosen = pickExplicit ? twins[0] : (twins[1] ?? twins[0]);
    return {
        ...chosen,
        id: caseDef.id,
        title: caseDef.title,
    };
}

/**
 * Convert a catalog entry to a harness case (before mirroring).
 * @param {Record<string, unknown>} entry
 */
export function catalogEntryToCase(entry) {
    const caseDef = {
        id: entry.id,
        title: entry.title,
        section: entry.section,
        roomGroup: entry.roomGroup,
        tags: entry.tags || [],
        expect: entry.expect || {},
        hooks: entry.hooks,
        approvalTemplateKey: entry.approvalTemplateKey,
        approvalDecision: entry.approvalDecision,
        approvalFormat: entry.approvalFormat,
        mirror: entry.mirror !== false,
    };
    if (entry.nl?.text) {
        caseDef.message = { text: entry.nl.text };
    }
    if (entry.compose) {
        caseDef.compose = entry.compose;
        if (!caseDef.message?.text && entry.compose.previewText) {
            caseDef.message = { text: entry.compose.previewText };
        }
    }
    return caseDef;
}
