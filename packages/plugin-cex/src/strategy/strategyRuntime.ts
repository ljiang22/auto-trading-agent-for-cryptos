import { buildCanonicalIntent } from "../intent/intentBuilder";
import type { CanonicalIntent, IntentMode, Locale } from "../intent/canonicalIntent";
import type { ExchangeName, OrderConfiguration } from "../types";
import type {
    StrategyDSL,
    StrategyOrderSpec,
    StrategyRule,
    StrategySignal,
} from "./strategyDSL";

export interface SignalSnapshot {
    [signalId: string]: number;
}

export interface StrategyEvaluationContext {
    /** Current signal values, keyed by signal id. */
    signals: SignalSnapshot;
    /** Current portfolio equity in USD (for pct_equity sizing). */
    equityUsd: number;
    /** Latest mid price for the symbol — used for sizing/limit calc. */
    midPrice: number;
}

export type StrategyTrigger =
    | { kind: "entry"; entryId: string; intent: CanonicalIntent }
    | { kind: "exit"; exitId: string; intent: CanonicalIntent }
    | { kind: "noop" };

function ruleEval(rule: StrategyRule, signals: SignalSnapshot): boolean {
    const resolveArg = (arg: unknown): number | boolean | string => {
        if (typeof arg === "number" || typeof arg === "boolean" || typeof arg === "string") {
            if (typeof arg === "string" && Object.prototype.hasOwnProperty.call(signals, arg)) {
                return signals[arg];
            }
            return arg;
        }
        if (typeof arg === "object" && arg !== null && "op" in arg) {
            return ruleEval(arg as StrategyRule, signals);
        }
        return Number.NaN;
    };

    const args = rule.args.map(resolveArg);
    switch (rule.op) {
        case "lt":
            return Number(args[0]) < Number(args[1]);
        case "lte":
            return Number(args[0]) <= Number(args[1]);
        case "gt":
            return Number(args[0]) > Number(args[1]);
        case "gte":
            return Number(args[0]) >= Number(args[1]);
        case "eq":
            return args[0] === args[1];
        case "and":
            return args.every((a) => Boolean(a));
        case "or":
            return args.some((a) => Boolean(a));
        case "not":
            return !Boolean(args[0]);
        case "between": {
            const v = Number(args[0]);
            return v >= Number(args[1]) && v <= Number(args[2]);
        }
    }
}

function spec2config(
    spec: StrategyOrderSpec,
    ctx: StrategyEvaluationContext,
): { config: OrderConfiguration; base_size: string } {
    let baseSize = 0;
    switch (spec.sizing.kind) {
        case "base_size":
            baseSize = spec.sizing.value;
            break;
        case "quote_size":
            baseSize = ctx.midPrice > 0 ? spec.sizing.value / ctx.midPrice : 0;
            break;
        case "pct_equity":
            baseSize =
                ctx.midPrice > 0
                    ? (ctx.equityUsd * (spec.sizing.value / 100)) / ctx.midPrice
                    : 0;
            break;
    }
    const baseStr = baseSize.toFixed(8);

    if (spec.order_type === "market") {
        return {
            config: { market_market_ioc: { base_size: baseStr } },
            base_size: baseStr,
        };
    }
    const limitPrice =
        spec.limit_offset_bps !== undefined
            ? (
                  ctx.midPrice *
                  (1 + (spec.side === "BUY" ? -1 : 1) * (spec.limit_offset_bps / 10_000))
              ).toFixed(8)
            : ctx.midPrice.toFixed(8);
    const limitInner = { base_size: baseStr, limit_price: limitPrice };
    if (spec.time_in_force === "IOC") {
        return { config: { sor_limit_ioc: limitInner }, base_size: baseStr };
    }
    if (spec.time_in_force === "FOK") {
        return { config: { limit_limit_fok: limitInner }, base_size: baseStr };
    }
    return { config: { limit_limit_gtc: limitInner }, base_size: baseStr };
}

export type StrategyRuntimeStatus = "running" | "paused" | "stopped";

export interface RunStrategyArgs {
    strategy: StrategyDSL;
    context: StrategyEvaluationContext;
    userId: string;
    locale: Locale;
    /** When set, overrides the strategy's mode; used by paper/backtest harnesses. */
    modeOverride?: IntentMode;
    /**
     * Runtime state of this strategy instance. Read from
     * `strategy_instances.runtime_status` before each tick. When
     * `paused` or `stopped`, the runtime short-circuits and returns
     * `{ kind: "noop" }` without evaluating any rules. Default
     * `"running"` preserves the pre-§7.7 behavior.
     */
    runtimeStatus?: StrategyRuntimeStatus;
}

/**
 * Evaluates strategy entry/exit rules against the snapshot and emits
 * canonical intents for whichever trigger fires. Single-pass: first
 * matching trigger wins (entries take precedence over exits in the same
 * cycle to match the standard convention of "enter before exit").
 */
export function runStrategyOnce(args: RunStrategyArgs): StrategyTrigger {
    const { strategy, context } = args;
    // §7.7 — runtime status gate. Without this the UI pause/stop buttons
    // are cosmetic: they update the DB row but the next tick still
    // generates a signal.
    const runtimeStatus: StrategyRuntimeStatus = args.runtimeStatus ?? "running";
    if (runtimeStatus !== "running") {
        return { kind: "noop" };
    }
    const mode: IntentMode = args.modeOverride ?? strategy.identity.mode;
    const venue = strategy.universe.venue as unknown as ExchangeName;
    const symbol = strategy.universe.symbols[0];

    for (const entry of strategy.entries) {
        if (ruleEval(entry.when, context.signals)) {
            const { config, base_size } = spec2config(entry.then, context);
            void base_size; // referenced for clarity
            const intent = buildCanonicalIntent({
                action: "create_order",
                venue,
                userId: args.userId,
                locale: args.locale,
                mode,
                params: {
                    userId: args.userId as never,
                    product_id: symbol,
                    symbol,
                    side: entry.then.side,
                    order_configuration: config,
                },
                policyContext: {
                    max_order_notional_usd: strategy.risk.max_position_notional_usd,
                    daily_loss_limit_usd: strategy.risk.max_daily_loss_usd,
                },
            });
            return { kind: "entry", entryId: entry.id, intent };
        }
    }
    for (const exit of strategy.exits) {
        if (ruleEval(exit.when, context.signals)) {
            const { config } = spec2config(exit.then, context);
            const intent = buildCanonicalIntent({
                action: "create_order",
                venue,
                userId: args.userId,
                locale: args.locale,
                mode,
                params: {
                    userId: args.userId as never,
                    product_id: symbol,
                    symbol,
                    side: exit.then.side,
                    order_configuration: config,
                },
                policyContext: {
                    max_order_notional_usd: strategy.risk.max_position_notional_usd,
                    daily_loss_limit_usd: strategy.risk.max_daily_loss_usd,
                },
            });
            return { kind: "exit", exitId: exit.id, intent };
        }
    }
    return { kind: "noop" };
}

/** Reference signal id list for downstream display. */
export function listSignalIds(strategy: StrategyDSL): string[] {
    return strategy.signals.map((s: StrategySignal) => s.id);
}
