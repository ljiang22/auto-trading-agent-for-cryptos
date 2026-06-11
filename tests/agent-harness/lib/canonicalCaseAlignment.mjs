/**
 * Helpers to align harness cases with plugin-cex canonical intent + ADK extractors.
 */

const VARIANT_KEY_PATTERN =
    /\b(market_market_ioc|market_market_fok|limit_limit_gtc|limit_limit_fok|limit_limit_gtd|stop_limit_stop_limit_gtc|stop_limit_stop_limit_gtd|trailing_stop_limit_gtc|oco_gtc|sor_limit_ioc|trigger_bracket_gtc|trigger_bracket_gtd)\b/;

const CANONICAL_WRITE_ACTIONS = new Set([
    "create_order",
    "preview_order",
    "amend_order",
    "cancel_order",
]);

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

/**
 * @param {string} variant
 * @returns {string | undefined}
 */
export function variantToOrderType(variant) {
    if (!variant) return undefined;
    if (variant.startsWith("market_")) return "market";
    if (variant.startsWith("limit_") || variant === "sor_limit_ioc") return "limit";
    if (variant.startsWith("stop_limit_")) return "stop_limit";
    if (variant === "trailing_stop_limit_gtc") return "trailing_stop_limit";
    if (variant === "oco_gtc") return "oco";
    if (variant.startsWith("trigger_bracket_")) return "trigger_bracket";
    return undefined;
}

/**
 * @param {string} variant
 * @returns {string | undefined}
 */
export function variantToTimeInForce(variant) {
    if (!variant) return undefined;
    if (variant.endsWith("_gtc") || variant === "oco_gtc") return "GTC";
    if (variant.endsWith("_gtd")) return "GTD";
    if (variant.endsWith("_ioc")) return "IOC";
    if (variant.endsWith("_fok")) return "FOK";
    return undefined;
}

/**
 * @param {{ compose?: { action?: string, params?: Record<string, unknown> } }} caseDef
 */
export function expectedCanonicalFieldsFromCompose(caseDef) {
    const action = caseDef?.compose?.action;
    const params = caseDef?.compose?.params || {};
    if (!CANONICAL_WRITE_ACTIONS.has(String(action))) {
        return null;
    }
    const variant = detectVariantFromOrderConfiguration(params.order_configuration);
    return {
        action,
        side: params.side,
        symbol: params.product_id,
        order_type: variant ? variantToOrderType(variant) : undefined,
        time_in_force: variant ? variantToTimeInForce(variant) : undefined,
        variant,
    };
}

/**
 * @param {string} text
 */
export function assertNoVariantKeysInNl(text) {
    return !VARIANT_KEY_PATTERN.test(String(text || ""));
}

/**
 * @param {{ nl?: { text?: string }, compose?: { previewText?: string } }} entry
 */
export function catalogEntryNlMatchesComposePreview(entry) {
    const nl = entry?.nl?.text;
    const preview = entry?.compose?.previewText;
    if (!nl || !preview) {
        return true;
    }
    return nl === preview;
}

/**
 * Spot-check that NL text mentions key values from order_configuration inner fields.
 * @param {string} text
 * @param {Record<string, unknown>} params
 * @param {string} action
 * @returns {{ ok: boolean, reason?: string }}
 */
export function assertNlMatchesOrderConfiguration(text, params, action) {
    const nl = String(text || "");
    if (!nl || (action !== "create_order" && action !== "preview_order")) {
        return { ok: true };
    }
    const variant = detectVariantFromOrderConfiguration(params.order_configuration);
    if (!variant) {
        return { ok: true };
    }
    const inner = params.order_configuration?.[variant];
    if (!inner || typeof inner !== "object") {
        return { ok: true };
    }
    const checks = [];
    if (typeof inner.quote_size === "string" && inner.quote_size.trim()) {
        checks.push(inner.quote_size.replace(/\.?0+$/, "") || inner.quote_size);
        checks.push(`$${inner.quote_size}`);
    }
    if (typeof inner.base_size === "string" && inner.base_size.trim()) {
        checks.push(inner.base_size);
    }
    if (typeof inner.limit_price === "string" && inner.limit_price.trim()) {
        checks.push(inner.limit_price);
    }
    if (typeof inner.stop_price === "string" && inner.stop_price.trim()) {
        checks.push(inner.stop_price);
    }
    for (const token of checks) {
        if (token && !nl.includes(String(token))) {
            return {
                ok: false,
                reason: `NL missing token "${token}" from ${variant}`,
            };
        }
    }
    return { ok: true };
}
