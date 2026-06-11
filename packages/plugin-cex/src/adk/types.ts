import type {
    CanonicalAction,
    CanonicalIntent,
    IntentMode,
    Locale,
    OrderSide,
} from "../intent/canonicalIntent";
import type { ExchangeName } from "../types";

export type AdkStake = "read_only" | "write";

export interface AdkRuntimeContext {
    userId: string;
    locale: Locale;
    stake: AdkStake;
    venue: ExchangeName;
    mode: IntentMode;
    killSwitchActive: boolean;
    /** Defaults applied when the user does not specify them in NL. */
    defaults?: {
        symbol?: string;
        side?: OrderSide;
    };
    /**
     * F7-r3 — optional IAgentRuntime handle. When present AND the
     * tool is `create_order` AND the regex extractor's confidence is
     * low, `runTradingSubAgentSafe` runs the LLM extractor and merges
     * the result. Typed as `unknown` here to avoid a dependency cycle
     * from plugin-cex/adk → @elizaos/core; the bridge narrows.
     */
    runtime?: unknown;
}

export interface AdkToolInputBase {
    /** Symbol in venue-canonical form (e.g., BTC-USD). May be filled by the resolver. */
    symbol?: string;
}

export interface AdkGetBalanceInput extends AdkToolInputBase {
    asset?: string;
    /**
     * Issue 4 (post-PR237 hotfix) — wallet scope filter for the
     * read-only fast path. The decomposer LLM emits this for multi-step
     * plans; the synchronous fast path now extracts it deterministically
     * from prompts like "show my spot balance" so single-action queries
     * also honor the scope.
     *
     * Canonical values: `"spot"` | `"funding"` | `"margin_cross"` |
     * `"margin_isolated"` | `"all"`. `"all"` (or `undefined`) keeps the
     * historical four-wallet fan-out.
     */
    wallet_type?: "spot" | "funding" | "margin_cross" | "margin_isolated" | "all";
}

export interface AdkGetOrdersInput extends AdkToolInputBase {
    status?: "open" | "filled" | "cancelled";
    limit?: number;
}

export interface AdkGetFillsInput extends AdkToolInputBase {
    order_id?: string;
    limit?: number;
}

export interface AdkCreateOrderInput extends AdkToolInputBase {
    side: OrderSide;
    order_type: "market" | "limit" | "stop_limit" | "trigger_bracket";
    base_size?: string;
    quote_size?: string;
    limit_price?: string;
    stop_price?: string;
    stop_trigger_price?: string;
    stop_direction?: "STOP_DIRECTION_STOP_UP" | "STOP_DIRECTION_STOP_DOWN";
    time_in_force?: "GTC" | "GTD" | "IOC" | "FOK";
    end_time?: string;
    post_only?: boolean;
    slippage_bps_max?: number;
}

export interface AdkCancelOrderInput extends AdkToolInputBase {
    /**
     * Full list of venue order ids the user named in the message.
     * The regex extractor scans the message for every long-numeric id
     * and bn-…/cb-… prefixed token so "cancel order N1, N2" populates
     * both, not just the first. Always length ≥ 1 when the extractor
     * succeeds; an empty/missing array surfaces as a clarification
     * ("which order(s)?").
     */
    order_ids: string[];
}

export interface AdkAmendOrderInput extends AdkToolInputBase {
    order_id: string;
    new_limit_price?: string;
    new_base_size?: string;
}

export interface AdkPreviewOrderInput extends AdkCreateOrderInput {}

export type AdkToolName =
    | "get_balance"
    | "get_orders"
    | "get_fills"
    | "create_order"
    | "cancel_order"
    | "amend_order"
    | "preview_order";

/** Tool definition that the ADK harness exposes for one canonical action. */
export interface AdkTool<TInput = unknown> {
    name: AdkToolName;
    canonicalAction: CanonicalAction;
    stake: AdkStake;
    description: string;
    /** Pure function — converts NL-extracted parameters to a canonical intent. */
    buildIntent(args: {
        input: TInput;
        context: AdkRuntimeContext;
    }): CanonicalIntent;
}

export interface AdkClassifiedOutput {
    kind: "canonical_intent";
    tool: AdkToolName;
    intent: CanonicalIntent;
    /**
     * The raw, deterministically-extracted tool input. Carried alongside
     * the canonical intent so consumers can recover action-specific fields
     * (e.g., `order_ids` for `cancel_order`) that don't fit the canonical
     * trade-shape schema. Source of truth for the "no LLM, no hallucination"
     * fast path on write actions.
     */
    extractedInput: Record<string, unknown>;
}

export interface AdkClarificationOutput {
    kind: "clarification_question";
    text: string;
    locale: Locale;
    /** Tool which surfaced the ambiguity (when applicable). */
    tool?: AdkToolName;
}

export type AdkAgentResult = AdkClassifiedOutput | AdkClarificationOutput;

export interface AdkAgentInput {
    /** Raw user message (post-preprocess, post-exchange-resolution). */
    message: string;
    context: AdkRuntimeContext;
    /** Optional override — when null, agent picks the matching tool itself. */
    forcedTool?: AdkToolName;
    /**
     * Pre-extracted parameter hints. The bridge in cexWorkflowMessageHandler
     * may pass parsed args from the existing LLM template so the sub-agent
     * doesn't need a second model call. When omitted, the agent runs its own
     * NL extraction.
     */
    parameterHints?: Record<string, unknown>;
    /**
     * §6.8 — when present, the canonical intent built by the ADK reuses
     * this id instead of generating a fresh one. Lets all downstream
     * artifacts (risk_decisions, venue_calls, ledger, replay) join on the
     * same request_id.
     */
    requestId?: string;
}
