import { z } from "zod";

import type { ExchangeName, OrderConfiguration } from "../types";

export type Locale = "en" | "zh-CN" | "mixed-en";

export const LOCALE_VALUES = ["en", "zh-CN", "mixed-en"] as const;

export type Stake = "read_only" | "write";

export type IntentMode = "live" | "paper" | "shadow";

export type CanonicalAction =
    | "get_balance"
    | "get_orders"
    | "get_fills"
    | "create_order"
    | "cancel_order"
    | "amend_order"
    | "preview_order";

export type OrderSide = "BUY" | "SELL";

export type CanonicalOrderType =
    | "market"
    | "limit"
    | "stop_limit"
    | "trigger_bracket"
    | "trailing_stop_limit"
    | "oco";

export type MarginAction = "NORMAL" | "AUTO_BORROW" | "AUTO_REPAY";

const localeSchema = z.enum(LOCALE_VALUES);

/**
 * Fix 5 — schema-layer rejection of non-positive sizes/prices.
 *
 * The legacy `z.string().optional()` accepted "0", "-1", and "-0.5"
 * silently; the venues then either returned cryptic 4xx (e.g. Binance
 * "-1106 mandatory parameter missing") or, worse on some symbols,
 * processed a zero-quantity order and consumed an idempotency key for
 * no work. This refinement rejects any decimal string that is not
 * strictly positive at the schema layer (H-6 = execute-time), with the
 * risk engine and quantizer layers acting as defense-in-depth below.
 */
const positiveDecimalString = z.string().refine(
    (v) => {
        if (!/^-?\d+(\.\d+)?$/.test(v.trim())) return false;
        const n = Number(v);
        return Number.isFinite(n) && n > 0;
    },
    { message: "must be a positive decimal" },
);

const sizeSchema = z
    .object({
        base_size: positiveDecimalString.optional(),
        quote_size: positiveDecimalString.optional(),
    })
    .refine(
        (value) => value.base_size !== undefined || value.quote_size !== undefined,
        {
            message: "size must contain base_size or quote_size",
        },
    );

const priceParamsSchema = z
    .object({
        limit_price: positiveDecimalString.optional(),
        stop_price: positiveDecimalString.optional(),
        stop_trigger_price: positiveDecimalString.optional(),
        stop_direction: z
            .enum(["STOP_DIRECTION_STOP_UP", "STOP_DIRECTION_STOP_DOWN"])
            .optional(),
    })
    .optional();

const executionConstraintsSchema = z
    .object({
        time_in_force: z.enum(["GTC", "GTD", "IOC", "FOK"]).optional(),
        end_time: z.string().optional(),
        post_only: z.boolean().optional(),
        slippage_bps_max: z.number().nonnegative().optional(),
        /**
         * Per-order override for the price-deviation cap (fraction, e.g.
         * 0.05 = 5%). The risk engine takes `min(override, profile_cap)`
         * so a user can only tighten their own cap, not loosen it.
         */
        price_deviation_max_pct: z.number().nonnegative().optional(),
        /** Visible portion of an iceberg limit order. */
        iceberg_qty: positiveDecimalString.optional(),
        /** Trailing-stop trail expressed in basis points (1..2000). */
        trailing_delta_bps: z.number().int().positive().max(2000).optional(),
        /** Trailing-stop activation price (optional). */
        trailing_activation_price: z.string().optional(),
    })
    .optional();

const marginContextSchema = z
    .object({
        margin_type: z.enum(["CROSS", "ISOLATED"]).optional(),
        leverage: z.string().optional(),
        margin_action: z.enum(["NORMAL", "AUTO_BORROW", "AUTO_REPAY"]).optional(),
    })
    .optional();

const idempotencySchema = z.object({
    client_order_id: z.string().min(1).max(36),
    intent_hash: z.string().min(8),
});

const policyContextSchema = z
    .object({
        risk_profile: z
            .enum(["conservative", "moderate", "aggressive"])
            .optional(),
        kill_switch_active: z.boolean().optional(),
        max_order_notional_usd: z.number().nonnegative().optional(),
        daily_loss_limit_usd: z.number().nonnegative().optional(),
    })
    .partial();

export const canonicalIntentSchema = z.object({
    intent_version: z.literal(1),
    request_id: z.string().min(1),
    user_id: z.string().min(1),
    action: z.custom<CanonicalAction>((value) =>
        [
            "get_balance",
            "get_orders",
            "get_fills",
            "create_order",
            "cancel_order",
            "amend_order",
            "preview_order",
        ].includes(value as CanonicalAction),
    ),
    mode: z.enum(["live", "paper", "shadow"]).default("live"),
    venue: z.custom<ExchangeName>((value) => typeof value === "string" && value.length > 0),
    symbol: z.string().optional(),
    side: z.enum(["BUY", "SELL"]).optional(),
    order_type: z
        .enum([
            "market",
            "limit",
            "stop_limit",
            "trigger_bracket",
            "trailing_stop_limit",
            "oco",
        ])
        .optional(),
    size: sizeSchema.optional(),
    price_params: priceParamsSchema,
    execution_constraints: executionConstraintsSchema,
    margin_context: marginContextSchema,
    raw_order_configuration: z.unknown().optional(),
    idempotency: idempotencySchema,
    policy_context: policyContextSchema,
    locale: localeSchema,
    explanation: z
        .object({
            user_visible_summary: z.string().optional(),
        })
        .optional(),
    /**
     * F4 — pre-execution USD notional estimate. Set from
     * `deriveEstimatedNotionalUsd(intent)` at risk-precheck entry, then
     * threaded onto every `[Trading]` event so CloudWatch dashboards can
     * sum exposure by stake (paper vs live) without joining to fills.
     */
    notional_usd_estimated: z.number().nonnegative().optional(),
    submitted_at: z.string().optional(),
}).superRefine((intent, ctx) => {
    // F7 — order-type / TIF / post_only consistency checks. These run AFTER
    // the basic shape validation so the user (or the LLM extractor) gets a
    // single, structured error per violation. Keep these strict: they're
    // the last guard before a venue REST call.

    // stop_limit requires BOTH stop_price AND limit_price.
    if (intent.order_type === "stop_limit") {
        const sp = intent.price_params?.stop_price;
        const lp = intent.price_params?.limit_price;
        if (!sp || !lp) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["price_params"],
                message:
                    "stop_limit requires both stop_price and limit_price (the trigger and the resting price).",
            });
        }
    }

    // GTD requires good_till_date / end_time.
    const tif = intent.execution_constraints?.time_in_force;
    if (tif === "GTD" && !intent.execution_constraints?.end_time) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["execution_constraints", "end_time"],
            message: "time_in_force=GTD requires end_time (the GTD expiry).",
        });
    }

    // post_only is meaningful only for limit orders. The venue rejects it
    // on market with a 4xx; better to short-circuit here.
    if (
        intent.execution_constraints?.post_only === true &&
        intent.order_type !== "limit" &&
        intent.order_type !== "stop_limit"
    ) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["execution_constraints", "post_only"],
            message: "post_only is only valid with order_type=limit or stop_limit.",
        });
    }

    // Margin: margin_type alone implies a margin trade; require margin_action
    // so the venue knows whether to AUTO_BORROW / AUTO_REPAY / NO_SIDE_EFFECT.
    if (intent.margin_context?.margin_type && !intent.margin_context?.margin_action) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["margin_context", "margin_action"],
            message:
                "margin_type set without margin_action — pick NORMAL, AUTO_BORROW, or AUTO_REPAY.",
        });
    }
});

export type CanonicalIntent = z.infer<typeof canonicalIntentSchema>;

export type CanonicalIntentDraft = Omit<
    CanonicalIntent,
    "idempotency" | "intent_version" | "mode"
> & {
    intent_version?: 1;
    mode?: IntentMode;
    raw_order_configuration?: OrderConfiguration;
};

/**
 * Subset of the canonical intent that participates in the deterministic
 * idempotency hash. Locale, request_id, timestamps, and explanation are
 * intentionally excluded (see plan §1.4).
 */
export interface HashableIntentSubset {
    user_id: string;
    action: CanonicalAction;
    mode: IntentMode;
    venue: ExchangeName;
    symbol?: string;
    side?: OrderSide;
    order_type?: CanonicalOrderType;
    size?: { base_size?: string; quote_size?: string };
    price_params?: {
        limit_price?: string;
        stop_price?: string;
        stop_trigger_price?: string;
        stop_direction?: string;
    };
    execution_constraints?: {
        time_in_force?: string;
        end_time?: string;
        post_only?: boolean;
        slippage_bps_max?: number;
        iceberg_qty?: string;
        trailing_delta_bps?: number;
        trailing_activation_price?: string;
    };
    margin_context?: {
        margin_type?: string;
        leverage?: string;
        margin_action?: string;
    };
    /** Set only when the user explicitly approves a dedup override. */
    resubmit_nonce?: string;
}

export function projectHashableSubset(intent: CanonicalIntent): HashableIntentSubset {
    return {
        user_id: intent.user_id,
        action: intent.action,
        mode: intent.mode,
        venue: intent.venue,
        symbol: intent.symbol,
        side: intent.side,
        order_type: intent.order_type,
        size: intent.size
            ? {
                  base_size: intent.size.base_size,
                  quote_size: intent.size.quote_size,
              }
            : undefined,
        price_params: intent.price_params
            ? {
                  limit_price: intent.price_params.limit_price,
                  stop_price: intent.price_params.stop_price,
                  stop_trigger_price: intent.price_params.stop_trigger_price,
                  stop_direction: intent.price_params.stop_direction,
              }
            : undefined,
        execution_constraints: intent.execution_constraints
            ? {
                  time_in_force: intent.execution_constraints.time_in_force,
                  end_time: intent.execution_constraints.end_time,
                  post_only: intent.execution_constraints.post_only,
                  slippage_bps_max: intent.execution_constraints.slippage_bps_max,
                  iceberg_qty: intent.execution_constraints.iceberg_qty,
                  trailing_delta_bps: intent.execution_constraints.trailing_delta_bps,
                  trailing_activation_price:
                      intent.execution_constraints.trailing_activation_price,
              }
            : undefined,
        margin_context: intent.margin_context
            ? {
                  margin_type: intent.margin_context.margin_type,
                  leverage: intent.margin_context.leverage,
                  margin_action: intent.margin_context.margin_action,
              }
            : undefined,
    };
}

export function parseCanonicalIntent(value: unknown): CanonicalIntent {
    return canonicalIntentSchema.parse(value);
}
