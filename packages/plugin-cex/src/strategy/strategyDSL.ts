import { z } from "zod";

export type StrategyStatus = "draft" | "paper" | "shadow" | "live" | "retired";
export type StrategyMode = "paper" | "shadow" | "live";

const identitySchema = z.object({
    id: z.string().min(1),
    version: z.number().int().min(1),
    owner: z.string().min(1),
    status: z.enum(["draft", "paper", "shadow", "live", "retired"]),
    mode: z.enum(["paper", "shadow", "live"]).default("paper"),
    name: z.string().optional(),
    description: z.string().optional(),
});

const universeSchema = z.object({
    venue: z.enum(["binance", "coinbase", "paper"]),
    symbols: z.array(z.string().min(1)).min(1),
    /** Whether the symbol list is fixed or expandable (e.g., top-N by volume). */
    expansion: z
        .object({
            kind: z.enum(["fixed", "top_n_volume", "watchlist"]),
            n: z.number().int().min(1).optional(),
        })
        .optional(),
});

const signalSchema = z.object({
    id: z.string().min(1),
    /**
     * Signal kind. Whitelist; never freeform.
     * - price.rsi: RSI(period)
     * - price.sma_cross: SMA(short) crossing SMA(long)
     * - price.ema_cross: EMA(short) crossing EMA(long)
     * - price.atr_band: ATR-based volatility band
     * - volume.zscore: Volume z-score over window
     * - sentiment.score: external sentiment input (Tier-A)
     */
    kind: z.enum([
        "price.rsi",
        "price.sma_cross",
        "price.ema_cross",
        "price.atr_band",
        "volume.zscore",
        "sentiment.score",
    ]),
    params: z.record(z.union([z.number(), z.string(), z.boolean()])).default({}),
});

const ruleSchema = z.object({
    /** Whitelisted ops only. No eval. */
    op: z.enum(["lt", "lte", "gt", "gte", "eq", "and", "or", "not", "between"]),
    /** Either a signal id reference or a numeric/string constant. */
    args: z.array(z.union([z.string(), z.number(), z.boolean(), z.lazy(() => ruleSchema)])),
});

const orderSpecSchema = z.object({
    order_type: z.enum(["market", "limit"]),
    side: z.enum(["BUY", "SELL"]),
    /** % of equity, or quote size, or base size — exactly one. */
    sizing: z.object({
        kind: z.enum(["pct_equity", "quote_size", "base_size"]),
        value: z.number().positive(),
    }),
    /** Limit-only. */
    limit_offset_bps: z.number().optional(),
    time_in_force: z.enum(["GTC", "IOC", "FOK"]).default("GTC"),
});

const entrySchema = z.object({
    id: z.string().min(1),
    when: ruleSchema,
    then: orderSpecSchema,
});

const exitSchema = z.object({
    id: z.string().min(1),
    when: ruleSchema,
    then: orderSpecSchema,
});

const riskSchema = z.object({
    max_position_notional_usd: z.number().positive(),
    max_daily_loss_usd: z.number().positive(),
    max_concurrent_positions: z.number().int().min(1),
    per_trade_stop_loss_bps: z.number().int().min(1).optional(),
    per_trade_take_profit_bps: z.number().int().min(1).optional(),
    slippage_bps_max: z.number().int().min(0).default(50),
});

const operationsSchema = z.object({
    /** Cadence the strategy runtime should poll signals. */
    evaluation_interval_seconds: z.number().int().min(1),
    /** If true, the runtime keeps running across restarts. */
    persistent: z.boolean().default(true),
    /** Whether to halt on first error. */
    halt_on_error: z.boolean().default(true),
});

const resilienceSchema = z.object({
    /** Auto-kill switch if loss exceeds limit. */
    auto_kill_on_loss_limit: z.boolean().default(true),
    /** Pause if reconciliation reports more than N stale orders. */
    pause_on_stale_orders: z.number().int().min(0).default(3),
    /** Pause if market-data freshness lag (s) exceeds N. */
    pause_on_market_data_lag_s: z.number().int().min(0).default(30),
});

export const strategyDSLSchema = z.object({
    identity: identitySchema,
    universe: universeSchema,
    signals: z.array(signalSchema).min(1),
    entries: z.array(entrySchema).min(1),
    exits: z.array(exitSchema).min(1),
    risk: riskSchema,
    operations: operationsSchema,
    resilience: resilienceSchema,
});

export type StrategyDSL = z.infer<typeof strategyDSLSchema>;
export type StrategyRule = z.infer<typeof ruleSchema>;
export type StrategySignal = z.infer<typeof signalSchema>;
export type StrategyEntry = z.infer<typeof entrySchema>;
export type StrategyExit = z.infer<typeof exitSchema>;
export type StrategyOrderSpec = z.infer<typeof orderSpecSchema>;

export function parseStrategyDSL(value: unknown): StrategyDSL {
    return strategyDSLSchema.parse(value);
}

export function tryParseStrategyDSL(value: unknown):
    | { ok: true; value: StrategyDSL }
    | { ok: false; issues: string[] } {
    const result = strategyDSLSchema.safeParse(value);
    if (result.success) return { ok: true, value: result.data };
    const issues = result.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    return { ok: false, issues };
}

/**
 * Returns a one-line human-readable summary used in confirmation UX.
 * Locale-agnostic (caller wraps with i18n).
 */
export function summarizeStrategy(strategy: StrategyDSL): string {
    const e = strategy.entries[0];
    const x = strategy.exits[0];
    return `${strategy.identity.name ?? strategy.identity.id} v${strategy.identity.version} on ${strategy.universe.venue}/${strategy.universe.symbols.join(",")} — ${e.id} → ${x.id} — max notional $${strategy.risk.max_position_notional_usd}, max daily loss $${strategy.risk.max_daily_loss_usd}`;
}
