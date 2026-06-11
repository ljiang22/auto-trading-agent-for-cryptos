import type { CanonicalIntent } from "../intent/canonicalIntent";
import type { ExchangeName } from "../types";

export type RiskVerdict = "allow" | "block" | "downgrade_read_only";

export type RiskRuleId =
    | "minOrderSize"
    | "maxOrderSize"
    | "dailyLossLimit"
    | "exposureCap"
    | "slippageCap"
    | "priceDeviation"
    | "assetAllowlist"
    | "leverageCap"
    | "cooldown"
    | "killSwitch"
    | "liveTradingGlobalKill"
    | "marketDataFreshness"
    | "reconciliationHealth"
    | "unknownStateBlocker";

export interface RiskRuleResult {
    id: RiskRuleId;
    verdict: RiskVerdict;
    explanation?: string;
    metadata?: Record<string, unknown>;
}

export interface RiskDecision {
    verdict: RiskVerdict;
    rules_fired: RiskRuleId[];
    explanations: string[];
    rule_results: RiskRuleResult[];
}

/**
 * Data the risk engine reads. The handler assembles this from
 * `user_trading_preferences`, the pending-orders ledger, market-data
 * service, and recent fill history. Keep this surface small and
 * explicit — the engine must not reach back into the runtime.
 */
export interface RiskEvaluationContext {
    preferences: UserTradingPreferences;
    /** Realized pnl in the rolling 24h window (USD). Negative = loss. */
    rolling_24h_pnl_usd?: number;
    /** Total notional of currently open orders for this user, in USD. */
    open_exposure_usd?: number;
    /**
     * Estimated notional of the candidate order, in USD. Computed by the
     * caller from market data; passed in to keep the engine pure.
     */
    estimated_notional_usd?: number;
    /**
     * Estimated slippage if the order were submitted now, in basis
     * points. -1 / undefined means market data unavailable.
     */
    estimated_slippage_bps?: number;
    /** Age of the freshest market-data tick for `intent.symbol`, ms. */
    market_data_age_ms?: number;
    /**
     * Current mid-market price for `intent.symbol`, denominated in
     * `quote` units (e.g. USDT for ETH-USDT). Populated by the handler
     * from the public ticker the paper venue already uses; undefined
     * means market data unavailable (priceDeviation fail-opens, like
     * slippageCap).
     */
    market_mid_usd?: number;
    /**
     * Timestamp (epoch ms) of the most-recent failure for this user on
     * this venue+symbol. Used by the cooldown rule. Undefined = no
     * recent failure.
     */
    last_failure_at_ms?: number;
    /**
     * Number of currently submitted orders that have not had a WS ack
     * within 60 s. Used by reconciliationHealth in Phase 2.
     */
    stale_reconciliation_count?: number;
    /**
     * Number of `unknown`-state orders this user has on the resolved
     * `(venue, symbol)` older than 5 s. Used by `unknownStateBlocker` to
     * refuse new writes until reconciliation resolves them. See plan §6.0.3.
     */
    unknown_state_orders_on_pair?: number;
    now_ms?: number;
}

export interface UserTradingPreferences {
    userId: string;
    risk_profile: "conservative" | "moderate" | "aggressive";
    max_order_notional_usd: number;
    daily_loss_limit_usd: number;
    slippage_bps_max: number;
    asset_allowlist: string[];
    asset_blocklist: string[];
    cooldown_seconds_after_fail: number;
    kill_switch_active: boolean;
    /** "en" | "zh-CN" | null — only used as ultimate fallback inside the locale detector. */
    preferred_language: "en" | "zh-CN" | null;
    /** Ultimate fallback for exchange resolution; not authoritative. */
    preferred_exchange: ExchangeName | null;
    /** Default mode applied when intent doesn't specify (Phase 4 surface). */
    default_mode: "live" | "paper" | "shadow";
    /** Maximum allowed market-data freshness lag in milliseconds. */
    market_data_freshness_max_ms: number;
    /**
     * Maximum permitted |limit_price − market_mid| / market_mid, as a
     * fraction (0.20 = 20%). Catches "BTC price on ETH pair" pilot-error
     * marketable-limit submissions. Use `Number.POSITIVE_INFINITY` to
     * disable.
     */
    price_deviation_max_pct: number;
    /**
     * Maximum permitted leverage for margin/futures intents. Hard-capped
     * at 10x at the rule level; user-configurable default is 5x. The
     * rule refuses outright (no acknowledgement path) above this number,
     * which the QA report flagged as the simplest path out of the
     * "20x leverage accepted without warning" failure mode.
     */
    max_leverage: number;
    updatedAt: string;
}

export interface RiskDecisionRecord {
    request_id: string;
    userId: string;
    intent_hash: string;
    /** Join key into pending_orders_ledger + venue_calls for the §6.7 replay. */
    client_order_id: string;
    decision: RiskVerdict;
    rules_fired: RiskRuleId[];
    explanations: string[];
    locale: CanonicalIntent["locale"];
    venue: ExchangeName;
    symbol?: string;
    /** Echoed back so the replay timeline can filter by buy vs sell. */
    side?: "BUY" | "SELL";
    /** live | paper | shadow — read by replay so paper/shadow rows are filtered. */
    mode?: "live" | "paper" | "shadow";
    action: CanonicalIntent["action"];
    createdAt: Date;
}

export const DEFAULT_USER_TRADING_PREFERENCES: Omit<
    UserTradingPreferences,
    "userId" | "updatedAt"
> = {
    risk_profile: "conservative",
    max_order_notional_usd: 1_000,
    daily_loss_limit_usd: 200,
    slippage_bps_max: 50,
    // 2026-05-25 hardening (QA H-3): default to a non-empty allowlist so
    // off-list assets (LUNA, FTT, et al.) are rejected at plan time even
    // when a user never opens Settings → Risk Limits. Power users can
    // widen this via the UI; safer default is the matter at hand here.
    asset_allowlist: ["BTC", "ETH", "SOL", "USDT", "USDC"],
    asset_blocklist: [],
    cooldown_seconds_after_fail: 60,
    kill_switch_active: false,
    preferred_language: null,
    preferred_exchange: null,
    // NOTE: `default_mode` left at "live" to preserve callers that still
    // depend on the historical default (existing user_trading_preferences
    // rows do not have a mode column initially, and getUserTradingMode()
    // returns "live" as its ultimate fallback). The unsafe UX flagged by
    // QA M-3 was the SIDEBAR badge showing emerald LIVE on a fresh UI
    // load — that fix lives in `client/.../ModeBadge.tsx` where the
    // React fallback is now "paper" (no DB write, but the user sees a
    // safer initial state).
    default_mode: "live",
    market_data_freshness_max_ms: 30_000,
    price_deviation_max_pct: 0.2,
    max_leverage: 5,
};

/**
 * 2026-05-25 hardening (QA H-3): a backstop deny-list that fires
 * regardless of `asset_allowlist`. These assets have either been
 * delisted (FTT after the FTX collapse) or are de-pegged / illiquid
 * to the point that the QA flagged them as needing a hard refusal
 * even before the order-preview modal is built. Curated by the
 * trading-safety team; PR-edit to add or remove.
 */
export const BACKSTOP_DENIED_ASSETS: ReadonlySet<string> = new Set([
    "LUNA",
    "LUNC",
    "UST",
    "USTC",
    "FTT",
    "FTX",
]);
