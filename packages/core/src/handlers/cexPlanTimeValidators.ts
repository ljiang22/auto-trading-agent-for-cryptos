/**
 * Fix 7 — Plan-time refusal of invalid / risky write steps.
 *
 * The legacy cexPlanRunner's `decomposeMessage` only validates the JSON
 * schema and unknown-action names emitted by the decomposer LLM. Anything
 * the venue's risk engine, schema layer, or per-symbol metadata would
 * reject at execute-time still survives into the plan card and only
 * fails when the user replies "yes". That UX is jarring (the user
 * approved an order they shouldn't have been shown) AND it consumes an
 * idempotency key for no work.
 *
 * This module sits between `decomposeMessage` and `savePlan`, running
 * four validators per write step:
 *
 *   1. Schema validation — `canonicalIntentSchema.safeParse`. Catches
 *      `base_size: "0"`, malformed `time_in_force=GTD` without `end_time`,
 *      `post_only` on a market order, etc. (Fix 5's schema layer.)
 *   2. Risk engine — `runRiskPrecheck`. Block verdicts surface their
 *      explanation verbatim (kill-switch, max-order-size, asset-blocklist,
 *      cooldown, etc.).
 *   3. Symbol-status — `fetchSymbolFilters({ venue, symbol })`. If
 *      `status !== "TRADING"`, the symbol is delisted / halted and writes
 *      will bounce at the venue.
 *   4. Min-notional — `est_notional = base_size * (limit_price || mid)`.
 *      If under `filters.minNotional`, refuse with the venue's exact
 *      value (so the user can adjust their amount, not guess).
 *
 * On any failure the entire plan is marked `failed` with the offending
 * step's status flipped to `failed` and a one-line `error` attached.
 * `renderPlanCard` already paints failed steps with a red row + Notes
 * column carrying the error.
 *
 * Plan-time validators are PURELY ADDITIVE — the legacy execute-time
 * gates in `requestParameterReview` remain untouched. A future user
 * who downgrades plan-time validators (CEX_PLAN_TIME_VALIDATORS_ENABLED=false)
 * gets the pre-Fix-7 behavior unchanged.
 */

import { elizaLogger } from "../utils/logger.ts";
import type {
    CEXSpecProvider,
    CEXSymbolFilters,
    IAgentRuntime,
    Plugin,
} from "../core/types.ts";

import { CLARIFY_ACTION, type CexPlan, type CexPlanStep } from "./cexPlanSchema.ts";

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

export const PLAN_TIME_VALIDATORS_FLAG = "CEX_PLAN_TIME_VALIDATORS_ENABLED";

export function isPlanTimeValidatorsEnabled(runtime: IAgentRuntime): boolean {
    const raw = runtime.getSetting?.(PLAN_TIME_VALIDATORS_FLAG);
    return String(raw ?? "").toLowerCase() === "true";
}

// ---------------------------------------------------------------------------
// CEXSpecProvider lookup helper
// ---------------------------------------------------------------------------

/**
 * Pull the registered `CEXSpecProvider` off the runtime's plugin chain.
 * Mirrors the helper in `cexPlanRunner.ts` so this file stays decoupled
 * from the orchestrator.
 */
function getCEXSpecProviderFromRuntime(
    runtime: IAgentRuntime,
): CEXSpecProvider | undefined {
    const plugins = (runtime as IAgentRuntime & { plugins?: Plugin[] }).plugins ?? [];
    for (const plugin of plugins) {
        const candidate = (plugin as Plugin & { cexSpecProvider?: CEXSpecProvider })
            .cexSpecProvider;
        if (candidate) return candidate;
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// 7a — planStepToCanonicalIntent
// ---------------------------------------------------------------------------

/**
 * Synthesize the canonical-intent-shaped input that `runRiskPrecheck`
 * and `validateCanonicalIntent` consume. For pure reads and `clarify`
 * steps, returns null so the caller can skip the validator chain
 * cheaply.
 *
 * NOTE: This intentionally does NOT call the plugin's
 * `buildCanonicalIntent` directly — we keep core decoupled from the
 * plugin's intent module. Instead we project a `CEXRiskPrecheckInput`
 * shape, and the plugin's adapters (provider.runRiskPrecheck +
 * provider.validateCanonicalIntent) build the real CanonicalIntent
 * internally.
 */
export interface PlanStepCanonicalIntentInput {
    action: string;
    venue: string;
    userId: string;
    locale: "en" | "zh-CN" | "mixed-en";
    params: Record<string, unknown>;
}

/**
 * The plugin's canonical-intent schema only enumerates the seven
 * order-shape actions (`get_balance`, `get_orders`, `get_fills`,
 * `create_order`, `cancel_order`, `amend_order`, `preview_order`). Plan
 * steps for other write actions like `set_trading_mode`,
 * `add_blocked_asset`, etc. have their own action-spec parameter schemas
 * but DO NOT pass the canonical-intent schema's `action` enum gate. If
 * we feed those through `validateCanonicalIntent` the planner gets
 * `schema: action: Invalid input` and the entire plan is marked
 * `failed` even though the legacy action handler would have accepted
 * the step. Skip plan-time canonical-intent validation for those.
 */
const CANONICAL_INTENT_VALIDATED_ACTIONS = new Set<string>([
    "create_order",
    "cancel_order",
    "amend_order",
    "preview_order",
]);

export function planStepToCanonicalIntent(
    step: CexPlanStep,
    userId: string,
    locale: "en" | "zh-CN" | "mixed-en",
    venue: string,
): PlanStepCanonicalIntentInput | null {
    if (step.action === CLARIFY_ACTION) return null;
    if (step.stake !== "write") return null;
    // 2026-05-26 — staging multi-step plan for "paper mode: limit sell ..."
    // failed on step 1 (`set_trading_mode`) with "schema: action: Invalid
    // input" because the canonical-intent schema's action enum is
    // restricted to order-shape actions only. Other write actions (mode
    // changes, allowlist mutations) have their own per-action schemas
    // enforced by `validateApprovedActionParams` at execute time. Return
    // null here so the plan-time validator chain skips them cleanly.
    if (!CANONICAL_INTENT_VALIDATED_ACTIONS.has(step.action)) return null;
    const stepVenue =
        typeof step.venue === "string" && step.venue.length > 0
            ? step.venue
            : venue;
    return {
        action: step.action,
        venue: stepVenue,
        userId,
        locale,
        params: { ...step.parameters, userId },
    };
}

// ---------------------------------------------------------------------------
// 7b — runPlanTimeValidators
// ---------------------------------------------------------------------------

export interface ValidatorContext {
    runtime: IAgentRuntime;
    userId: string;
    locale: "en" | "zh-CN" | "mixed-en";
    defaultVenue: string;
}

export interface ValidatorOutcome {
    /** True when EVERY write step passed all four validators. */
    ok: boolean;
    /**
     * When `ok === false`, mutations have already been applied to the
     * plan object: `plan.status = "failed"`, `step.status = "failed"`,
     * `step.result = { error: <message>, completed_at }`. Caller should
     * skip `savePlan` and surface the plan card with the red row.
     */
    failingStepId?: string;
    failingMessage?: string;
}

/**
 * Mark one step `failed` with a one-line error AND mark the entire plan
 * `failed`. Mirrors `markStepFailedAndBail` in the executor but doesn't
 * touch downstream steps — they're still `pending` since the plan was
 * never persisted. We do flip them to `skipped` so the rendered card
 * communicates "this step bailed; the rest never ran" cleanly.
 */
function markPlanFailedFromValidator(
    plan: CexPlan,
    stepId: string,
    error: string,
): void {
    const idx = plan.steps.findIndex((s) => s.id === stepId);
    if (idx < 0) return;
    const now = Date.now();
    plan.steps[idx].status = "failed";
    plan.steps[idx].result = { error, completed_at: now };
    for (let i = idx + 1; i < plan.steps.length; i++) {
        if (plan.steps[i].status === "pending") {
            plan.steps[i].status = "skipped";
        }
    }
    plan.cursor = idx;
    plan.status = "failed";
}

/**
 * Compute the USD-equivalent notional for a `create_order` step.
 * Mirrors the legacy `deriveEstimatedNotionalUsd` in the plugin:
 *   - quote_size directly → notional in quote units.
 *   - base_size * limit_price (limit orders) → notional.
 *   - base_size * market_mid (market orders) → notional.
 *
 * Returns null when neither path yields a finite positive number so the
 * caller can skip the min-notional check (the execute-time path still
 * runs).
 */
function deriveEstimatedNotional(
    params: Record<string, unknown>,
    marketMidUsd: number | null,
): number | null {
    const orderConfig = params.order_configuration as
        | Record<string, Record<string, unknown> | undefined>
        | undefined;
    if (!orderConfig) return null;

    let baseSize: string | undefined;
    let quoteSize: string | undefined;
    let limitPrice: string | undefined;

    for (const inner of Object.values(orderConfig)) {
        if (!inner) continue;
        if (typeof inner.base_size === "string") baseSize = inner.base_size;
        if (typeof inner.quote_size === "string") quoteSize = inner.quote_size;
        if (typeof inner.limit_price === "string") limitPrice = inner.limit_price;
    }

    if (typeof quoteSize === "string") {
        const q = Number.parseFloat(quoteSize);
        if (Number.isFinite(q) && q > 0) return q;
    }
    if (typeof baseSize === "string") {
        const b = Number.parseFloat(baseSize);
        if (!Number.isFinite(b) || b <= 0) return null;
        if (typeof limitPrice === "string") {
            const p = Number.parseFloat(limitPrice);
            if (Number.isFinite(p) && p > 0) return b * p;
        }
        if (typeof marketMidUsd === "number" && Number.isFinite(marketMidUsd) && marketMidUsd > 0) {
            return b * marketMidUsd;
        }
    }
    return null;
}

/**
 * Extract the trading-pair symbol from a step's parameters.
 *
 * Accepts both `product_id` (canonical "BTC-USDT") and `symbol`
 * (legacy "BTCUSDT"). Returns the venue-wire form (no separator) for
 * `fetchSymbolFilters` consumption.
 */
function extractSymbol(params: Record<string, unknown>): string | null {
    const productId = params.product_id;
    if (typeof productId === "string" && productId.trim().length > 0) {
        return productId.replace(/-/g, "").toUpperCase();
    }
    const symbol = params.symbol;
    if (typeof symbol === "string" && symbol.trim().length > 0) {
        return symbol.replace(/-/g, "").toUpperCase();
    }
    return null;
}

/**
 * Walk every WRITE step of the plan, running the four validators in
 * order. Stops at the first failing step (consistent with the executor's
 * "bail on first failure" policy) and mutates the plan to terminal-failed.
 *
 * Returns `{ ok: true }` when the plan passed; `{ ok: false, … }` when
 * it didn't. In both cases the validator chain produced no side effects
 * outside the plan object — no venue calls were placed.
 */
export async function runPlanTimeValidators(
    plan: CexPlan,
    ctx: ValidatorContext,
): Promise<ValidatorOutcome> {
    const provider = getCEXSpecProviderFromRuntime(ctx.runtime);
    if (!provider) {
        // No CEX plugin registered → no validators to run. Treat as
        // pass-through; pre-Fix-7 behavior.
        return { ok: true };
    }

    // Per-symbol cache so a "buy BTC then sell BTC" plan only hits
    // exchangeInfo once across both writes. The provider's underlying
    // helper also caches 1 h, but local memoization saves the function
    // call overhead and makes the unit-test mock counts deterministic.
    const symbolFiltersCache = new Map<string, CEXSymbolFilters | null>();
    const fetchFilters = async (
        venue: string,
        symbol: string,
    ): Promise<CEXSymbolFilters | null> => {
        const key = `${venue}|${symbol}`;
        if (symbolFiltersCache.has(key)) return symbolFiltersCache.get(key) ?? null;
        if (!provider.fetchSymbolFilters) {
            symbolFiltersCache.set(key, null);
            return null;
        }
        try {
            const filters = await provider.fetchSymbolFilters({ venue, symbol });
            symbolFiltersCache.set(key, filters ?? null);
            return filters ?? null;
        } catch (err) {
            elizaLogger.debug(
                `[CexPlanTimeValidators] fetchSymbolFilters(${venue}, ${symbol}) threw: ${err instanceof Error ? err.message : String(err)}`,
            );
            symbolFiltersCache.set(key, null);
            return null;
        }
    };

    for (const step of plan.steps) {
        const intent = planStepToCanonicalIntent(
            step,
            ctx.userId,
            ctx.locale,
            ctx.defaultVenue,
        );
        if (!intent) continue; // reads + clarify skip the validator chain

        // -------------------------------------------------------------
        // 1. Schema validation (canonicalIntentSchema)
        // -------------------------------------------------------------
        if (provider.validateCanonicalIntent) {
            const result = provider.validateCanonicalIntent({
                action: intent.action,
                venue: intent.venue,
                userId: intent.userId,
                locale: intent.locale,
                params: intent.params,
            });
            if (!result.ok) {
                const msg = `schema: ${result.error}`;
                elizaLogger.info(
                    `[CexPlanTimeValidators] step ${step.id} schema-rejected: ${msg}`,
                );
                markPlanFailedFromValidator(plan, step.id, msg);
                return { ok: false, failingStepId: step.id, failingMessage: msg };
            }
        }

        // -------------------------------------------------------------
        // 2. Risk engine (runRiskPrecheck)
        // -------------------------------------------------------------
        if (provider.runRiskPrecheck) {
            let preferences: Record<string, unknown> | undefined;
            try {
                const adapter = ctx.runtime.databaseAdapter as unknown as {
                    getUserTradingPreferences?: (id: string) => Promise<unknown>;
                };
                if (typeof adapter?.getUserTradingPreferences === "function") {
                    const fetched = await adapter.getUserTradingPreferences(ctx.userId);
                    if (fetched && typeof fetched === "object") {
                        preferences = fetched as Record<string, unknown>;
                    }
                }
            } catch {
                /* preferences are optional at plan-time */
            }

            let decision: Awaited<ReturnType<NonNullable<CEXSpecProvider["runRiskPrecheck"]>>> =
                null;
            try {
                decision = await provider.runRiskPrecheck({
                    action: intent.action,
                    venue: intent.venue,
                    userId: intent.userId,
                    locale: intent.locale,
                    params: intent.params,
                    preferences,
                });
            } catch (err) {
                elizaLogger.warn(
                    `[CexPlanTimeValidators] runRiskPrecheck threw for step ${step.id}: ${err instanceof Error ? err.message : String(err)}`,
                );
            }

            if (decision && decision.verdict === "block") {
                const reason =
                    decision.explanations[0] ??
                    `Refused by risk gate (${decision.rules_fired.join(", ") || "unspecified rule"})`;
                elizaLogger.info(
                    `[CexPlanTimeValidators] step ${step.id} risk-blocked: ${reason}`,
                );
                markPlanFailedFromValidator(plan, step.id, reason);
                return { ok: false, failingStepId: step.id, failingMessage: reason };
            }
        }

        // The remaining checks only apply to `create_order` (the only
        // write action whose canonical intent carries a tradable symbol
        // + size). cancel_order / amend_order operate on existing
        // orders and skip these gates.
        if (step.action !== "create_order") continue;

        const symbol = extractSymbol(intent.params);
        if (!symbol) continue; // unresolved symbol — fall through to execute-time

        const filters = await fetchFilters(intent.venue, symbol);

        // -------------------------------------------------------------
        // 3. Symbol-status check
        // -------------------------------------------------------------
        if (filters?.status && filters.status !== "TRADING") {
            const msg = `${symbol} is no longer actively traded on ${intent.venue}`;
            elizaLogger.info(
                `[CexPlanTimeValidators] step ${step.id} symbol-status rejected: ${msg} (status=${filters.status})`,
            );
            markPlanFailedFromValidator(plan, step.id, msg);
            return { ok: false, failingStepId: step.id, failingMessage: msg };
        }

        // -------------------------------------------------------------
        // 4. Min-notional check
        // -------------------------------------------------------------
        if (filters?.minNotional) {
            const minNotionalNum = Number.parseFloat(filters.minNotional);
            if (Number.isFinite(minNotionalNum) && minNotionalNum > 0) {
                // For market orders without a limit_price, fetch the mid
                // so we can estimate notional. 1 s budget — the rule
                // skips if the mid is unavailable.
                let marketMidUsd: number | null = null;
                const orderConfig = intent.params.order_configuration as
                    | Record<string, Record<string, unknown> | undefined>
                    | undefined;
                let hasLimitPrice = false;
                if (orderConfig) {
                    for (const inner of Object.values(orderConfig)) {
                        if (inner && typeof inner.limit_price === "string") {
                            hasLimitPrice = true;
                            break;
                        }
                    }
                }
                if (!hasLimitPrice && provider.fetchMarketMidUsd) {
                    try {
                        const ctl = new AbortController();
                        const timer = setTimeout(() => ctl.abort(), 1_500);
                        try {
                            marketMidUsd = await provider.fetchMarketMidUsd({
                                runtime: ctx.runtime,
                                venue: intent.venue,
                                symbol,
                                signal: ctl.signal,
                            });
                        } finally {
                            clearTimeout(timer);
                        }
                    } catch (err) {
                        elizaLogger.debug(
                            `[CexPlanTimeValidators] fetchMarketMidUsd best-effort failed: ${err instanceof Error ? err.message : String(err)}`,
                        );
                    }
                }

                const notional = deriveEstimatedNotional(intent.params, marketMidUsd);
                if (
                    typeof notional === "number" &&
                    Number.isFinite(notional) &&
                    notional > 0 &&
                    notional < minNotionalNum
                ) {
                    const formatted = formatNotionalForMessage(notional);
                    const minFormatted = formatNotionalForMessage(minNotionalNum);
                    const msg = `order notional $${formatted} is below ${intent.venue.charAt(0).toUpperCase()}${intent.venue.slice(1)} minimum $${minFormatted} for ${symbol}`;
                    elizaLogger.info(
                        `[CexPlanTimeValidators] step ${step.id} min-notional rejected: ${msg}`,
                    );
                    markPlanFailedFromValidator(plan, step.id, msg);
                    return { ok: false, failingStepId: step.id, failingMessage: msg };
                }
            }
        }
    }

    return { ok: true };
}

/**
 * Format a USD notional for the user-visible error message.
 *
 *   - ≥ $100   → two decimals ($10000.00)
 *   - ≥ $1     → two decimals ($5.00)
 *   - ≥ $0.01  → three decimals so sub-cent rounding stays honest
 *                (e.g. $0.077 — toFixed(2) would round 0.077 → 0.08 and
 *                mislead the user about how far below the floor they are).
 *   - else     → six decimals trimmed
 */
function formatNotionalForMessage(value: number): string {
    if (!Number.isFinite(value)) return String(value);
    if (value >= 1) return value.toFixed(2);
    if (value >= 0.01) {
        // Keep up to three decimals; trim trailing zeros to avoid "0.080".
        return trimTrailingZeros(value.toFixed(3));
    }
    return trimTrailingZeros(value.toFixed(6));
}

function trimTrailingZeros(s: string): string {
    if (!s.includes(".")) return s;
    return s.replace(/0+$/, "").replace(/\.$/, "");
}
