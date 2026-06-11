import { randomUUID } from "node:crypto";

import {
    type CanonicalAction,
    type CanonicalIntent,
    type CanonicalOrderType,
    type IntentMode,
    type Locale,
    type OrderSide,
    parseCanonicalIntent,
    projectHashableSubset,
} from "./canonicalIntent";
import {
    computeIntentHash,
    deriveClientOrderId,
} from "../idempotency/intentHash";
import type { ExchangeName, OrderConfiguration } from "../types";

/**
 * The shape `cexWorkflowMessageHandler.applyServerOwnedParams` produces
 * today (post normalization). Used as the lossy input to the canonical
 * intent builder.
 */
export interface ApprovalPayloadShape {
    userId: string;
    exchange?: ExchangeName;
    product_id?: string;
    symbol?: string;
    side?: OrderSide | string;
    order_configuration?: OrderConfiguration;
    client_order_id?: string;
    [k: string]: unknown;
}

export interface BuildCanonicalIntentInput {
    action: CanonicalAction;
    venue: ExchangeName;
    userId: string;
    locale: Locale;
    mode?: IntentMode;
    params: ApprovalPayloadShape;
    requestId?: string;
    policyContext?: CanonicalIntent["policy_context"];
    explanationSummary?: string;
    submittedAt?: string;
    /** Included in the idempotency hash when the user overrides dedup. */
    resubmitNonce?: string;
}

const SIZE_PRECEDENCE = [
    "market_market_ioc",
    "market_market_fok",
    "limit_limit_gtc",
    "limit_limit_gtd",
    "sor_limit_ioc",
    "stop_limit_stop_limit_gtc",
    "stop_limit_stop_limit_gtd",
    "limit_limit_fok",
    "trailing_stop_limit_gtc",
    "oco_gtc",
    "trigger_bracket_gtc",
    "trigger_bracket_gtd",
] as const;

const MARKET_TYPES = new Set(["market_market_ioc", "market_market_fok"]);
const LIMIT_TYPES = new Set([
    "limit_limit_gtc",
    "limit_limit_gtd",
    "sor_limit_ioc",
    "limit_limit_fok",
]);
const STOP_LIMIT_TYPES = new Set([
    "stop_limit_stop_limit_gtc",
    "stop_limit_stop_limit_gtd",
]);
const TRAILING_TYPES = new Set(["trailing_stop_limit_gtc"]);
const OCO_TYPES = new Set(["oco_gtc"]);
const TRIGGER_BRACKET_TYPES = new Set([
    "trigger_bracket_gtc",
    "trigger_bracket_gtd",
]);

function pickOrderConfigKey(
    config: OrderConfiguration | undefined,
): (typeof SIZE_PRECEDENCE)[number] | undefined {
    if (!config) return undefined;
    for (const key of SIZE_PRECEDENCE) {
        if ((config as Record<string, unknown>)[key] !== undefined) return key;
    }
    return undefined;
}

function inferOrderType(
    config: OrderConfiguration | undefined,
): CanonicalOrderType | undefined {
    const key = pickOrderConfigKey(config);
    if (!key) return undefined;
    if (MARKET_TYPES.has(key)) return "market";
    if (LIMIT_TYPES.has(key)) return "limit";
    if (STOP_LIMIT_TYPES.has(key)) return "stop_limit";
    if (TRAILING_TYPES.has(key)) return "trailing_stop_limit";
    if (OCO_TYPES.has(key)) return "oco";
    if (TRIGGER_BRACKET_TYPES.has(key)) return "trigger_bracket";
    return undefined;
}

function extractSize(config: OrderConfiguration | undefined):
    | { base_size?: string; quote_size?: string }
    | undefined {
    const key = pickOrderConfigKey(config);
    if (!key) return undefined;
    const inner = (config as Record<string, Record<string, unknown> | undefined>)[
        key
    ];
    if (!inner) return undefined;
    const out: { base_size?: string; quote_size?: string } = {};
    if (typeof inner.base_size === "string") out.base_size = inner.base_size;
    if (typeof inner.quote_size === "string") out.quote_size = inner.quote_size;
    return out.base_size || out.quote_size ? out : undefined;
}

function extractPriceParams(
    config: OrderConfiguration | undefined,
): CanonicalIntent["price_params"] {
    const key = pickOrderConfigKey(config);
    if (!key) return undefined;
    const inner = (config as Record<string, Record<string, unknown> | undefined>)[
        key
    ];
    if (!inner) return undefined;
    const out: NonNullable<CanonicalIntent["price_params"]> = {};
    if (typeof inner.limit_price === "string") out.limit_price = inner.limit_price;
    if (typeof inner.stop_price === "string") out.stop_price = inner.stop_price;
    if (typeof inner.stop_trigger_price === "string")
        out.stop_trigger_price = inner.stop_trigger_price;
    if (
        inner.stop_direction === "STOP_DIRECTION_STOP_UP" ||
        inner.stop_direction === "STOP_DIRECTION_STOP_DOWN"
    ) {
        out.stop_direction = inner.stop_direction;
    }
    return Object.keys(out).length === 0 ? undefined : out;
}

function extractExecutionConstraints(
    config: OrderConfiguration | undefined,
): CanonicalIntent["execution_constraints"] {
    const key = pickOrderConfigKey(config);
    if (!key) return undefined;
    const inner = (config as Record<string, Record<string, unknown> | undefined>)[
        key
    ];
    if (!inner) return undefined;
    const out: NonNullable<CanonicalIntent["execution_constraints"]> = {};
    if (key.endsWith("gtc")) out.time_in_force = "GTC";
    else if (key.endsWith("gtd")) out.time_in_force = "GTD";
    else if (key.endsWith("ioc")) out.time_in_force = "IOC";
    else if (key.endsWith("fok")) out.time_in_force = "FOK";

    if (typeof inner.end_time === "string") out.end_time = inner.end_time;
    if (typeof inner.post_only === "boolean") out.post_only = inner.post_only;

    const trailingBps = inner.trailing_delta_bps;
    if (typeof trailingBps === "number" && Number.isFinite(trailingBps)) {
        out.trailing_delta_bps = trailingBps;
    } else if (typeof trailingBps === "string" && trailingBps.trim() !== "") {
        const n = Number.parseInt(trailingBps, 10);
        if (Number.isFinite(n)) out.trailing_delta_bps = n;
    }
    if (typeof inner.activation_price === "string" && inner.activation_price.trim()) {
        out.trailing_activation_price = inner.activation_price;
    }

    return Object.keys(out).length === 0 ? undefined : out;
}

function asSide(value: unknown): OrderSide | undefined {
    if (value === "BUY" || value === "SELL") return value;
    if (typeof value === "string") {
        const upper = value.toUpperCase();
        if (upper === "BUY" || upper === "SELL") return upper as OrderSide;
    }
    return undefined;
}

/**
 * 2026-05-26 — extract margin context from the legacy action-param shape.
 * The legacy `cexWorkflowMessageHandler` calls `buildCanonicalIntent`
 * directly (not via the ADK bridge) and prior to this fix dropped
 * `margin_type` / `leverage` / `margin_action` on the floor — so the
 * `leverageCap` risk rule saw `intent.margin_context === undefined` and
 * silently allowed 20x cross-margin orders through. Mirrors the bridge's
 * shape and tolerates numeric leverage (the LLM frequently emits
 * `"leverage": 20`).
 */
function extractMarginContext(
    params: Record<string, unknown>,
): { margin_type?: "CROSS" | "ISOLATED"; leverage?: string; margin_action?: "NORMAL" | "AUTO_BORROW" | "AUTO_REPAY" } | undefined {
    const out: { margin_type?: "CROSS" | "ISOLATED"; leverage?: string; margin_action?: "NORMAL" | "AUTO_BORROW" | "AUTO_REPAY" } = {};
    const mt = params.margin_type;
    if (mt === "CROSS" || mt === "ISOLATED") out.margin_type = mt;
    else if (typeof mt === "string") {
        const upper = mt.toUpperCase();
        if (upper === "CROSS" || upper === "ISOLATED") out.margin_type = upper as "CROSS" | "ISOLATED";
    }
    const ma = params.margin_action;
    if (ma === "NORMAL" || ma === "AUTO_BORROW" || ma === "AUTO_REPAY") out.margin_action = ma;
    else if (typeof ma === "string") {
        const upper = ma.toUpperCase();
        if (upper === "NORMAL" || upper === "AUTO_BORROW" || upper === "AUTO_REPAY") {
            out.margin_action = upper as "NORMAL" | "AUTO_BORROW" | "AUTO_REPAY";
        }
    }
    const lev = params.leverage;
    if (typeof lev === "string" && lev.trim().length > 0) out.leverage = lev;
    else if (typeof lev === "number" && Number.isFinite(lev)) out.leverage = String(lev);
    return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Builds a canonical intent from the existing approval-payload shape.
 *
 * For non-write intents, only the identity fields are populated; size /
 * price / execution-constraints are omitted entirely so the resulting
 * intent hash is stable across "give me my balance" phrasings.
 */
export function buildCanonicalIntent(
    input: BuildCanonicalIntentInput,
): CanonicalIntent {
    const requestId = input.requestId ?? randomUUID();
    const mode: IntentMode = input.mode ?? "live";
    const isWrite =
        input.action === "create_order" ||
        input.action === "cancel_order" ||
        input.action === "amend_order" ||
        input.action === "preview_order";

    const orderConfig = input.params.order_configuration;
    const symbol =
        input.params.product_id ??
        (typeof input.params.symbol === "string" ? input.params.symbol : undefined);

    const side = isWrite ? asSide(input.params.side) : undefined;
    const order_type = isWrite ? inferOrderType(orderConfig) : undefined;
    const size = isWrite ? extractSize(orderConfig) : undefined;
    const price_params = isWrite ? extractPriceParams(orderConfig) : undefined;
    const execution_constraints = isWrite
        ? extractExecutionConstraints(orderConfig)
        : undefined;
    const margin_context = isWrite
        ? extractMarginContext(input.params as Record<string, unknown>)
        : undefined;

    const draft: Omit<CanonicalIntent, "idempotency"> = {
        intent_version: 1,
        request_id: requestId,
        user_id: input.userId,
        action: input.action,
        mode,
        venue: input.venue,
        symbol,
        side,
        order_type,
        size,
        price_params,
        execution_constraints,
        margin_context,
        raw_order_configuration: orderConfig,
        policy_context: input.policyContext ?? {},
        locale: input.locale,
        explanation: input.explanationSummary
            ? { user_visible_summary: input.explanationSummary }
            : undefined,
        submitted_at: input.submittedAt,
    };

    const hashable = projectHashableSubset(draft as CanonicalIntent);
    if (input.resubmitNonce) {
        hashable.resubmit_nonce = input.resubmitNonce;
    }
    const intent_hash = computeIntentHash(hashable);
    const client_order_id = deriveClientOrderId(
        intent_hash,
        venueAlias(input.venue),
    );

    return parseCanonicalIntent({
        ...draft,
        idempotency: { client_order_id, intent_hash },
    });
}

function venueAlias(venue: ExchangeName): "binance" | "coinbase" | "paper" {
    if (venue === "binance" || venue === "coinbase") return venue;
    return "paper";
}
