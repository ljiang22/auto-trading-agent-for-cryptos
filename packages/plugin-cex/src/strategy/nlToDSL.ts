import {
    type StrategyDSL,
    tryParseStrategyDSL,
} from "./strategyDSL";

export interface NlToDslSuccess {
    ok: true;
    strategy: StrategyDSL;
    /** True iff the compiler had to rely on heuristics over LLM output. */
    derived_by_heuristic: boolean;
}

export interface NlToDslClarification {
    ok: false;
    needsClarification: true;
    locale: "en" | "zh-CN";
    text: string;
    /** Compiler issues encountered, surfaced for UI logs. */
    issues: string[];
}

export type NlToDslResult = NlToDslSuccess | NlToDslClarification;

export interface NlToDslOptions {
    locale: "en" | "zh-CN";
    owner: string;
    venue: "binance" | "coinbase" | "paper";
}

/**
 * Heuristic NL → DSL compiler. Targets the canonical DCA + RSI mean-revert
 * templates. For anything outside these templates, returns a clarification.
 * In production this would be a wrapping layer around an LLM call; the
 * heuristic path remains as the safety net.
 */
export function compileNlToDsl(
    naturalLanguage: string,
    options: NlToDslOptions,
): NlToDslResult {
    const lower = naturalLanguage.toLowerCase();

    // Symbol detection
    const symMatch =
        /\b(btc|eth|sol|xrp|ada|doge|matic|link|dot|avax|bnb|ltc)\b/i.exec(
            naturalLanguage,
        );
    const baseSymbol = symMatch ? symMatch[1].toUpperCase() : "BTC";
    const quote = options.venue === "binance" ? "USDT" : "USD";
    // Canonical pair form is always BASE-QUOTE (e.g. "BTC-USDT"). Venue
    // adapters convert to the venue's wire form (e.g. Binance "BTCUSDT")
    // at the edge. Strategy DSL must stay canonical so reports and tests
    // remain venue-agnostic.
    const symbol = `${baseSymbol}-${quote}`;

    // Hybrid DCA + risk-control template (DCA cadence + dip-buy + TP/SL).
    // Must run BEFORE the plain DCA template. Requires a DCA keyword AND a
    // risk/dip/TP/SL keyword so a plain "DCA $50 weekly" stays on the DCA path.
    const hasDca = /\bdca\b|dollar[- ]?cost|定投/.test(lower);
    const hasRiskControl = /\bdip\b|risk|stop[- ]?loss|take[- ]?profit|\btp\b|\bsl\b|hybrid|risk[- ]?control/i.test(naturalLanguage);
    if (hasDca && hasRiskControl) {
        const amountM = /\$\s*([0-9]+(?:\.[0-9]+)?)/.exec(naturalLanguage);
        const amount = amountM ? Number.parseFloat(amountM[1]) : 50;
        const dipM = /-\s*([0-9]+(?:\.[0-9]+)?)\s*%/.exec(naturalLanguage); // leading '-' avoids matching "take profit 3%"
        const dipPct = dipM ? Number.parseFloat(dipM[1]) : 5;
        const tpM = /take[- ]?profit\s*([0-9]+(?:\.[0-9]+)?)\s*%/i.exec(naturalLanguage);
        const tpPct = tpM ? Number.parseFloat(tpM[1]) : 3;
        const slM = /stop[- ]?loss\s*([0-9]+(?:\.[0-9]+)?)\s*%/i.exec(naturalLanguage);
        const slPct = slM ? Number.parseFloat(slM[1]) : 2;
        const winM = /([0-9]+)[- ]?day/i.exec(naturalLanguage);
        const window = winM ? Number.parseInt(winM[1], 10) : 20;
        const cadence = /\bdaily\b|每日/.test(lower)
            ? 86400
            : /\bweekly\b|每周/.test(lower)
              ? 7 * 86400
              : /\bhourly\b|每小时/.test(lower)
                ? 3600
                : 86400;

        const draft: StrategyDSL = {
            identity: {
                id: `hybrid-dca-${baseSymbol.toLowerCase()}-${cadence}`,
                version: 1,
                owner: options.owner,
                status: "paper",
                mode: "paper",
                name: `Hybrid DCA + Risk-Control ${baseSymbol}`,
            },
            universe: { venue: options.venue, symbols: [symbol] },
            signals: [{ id: "dip", kind: "price.pct_from_high", params: { window } }],
            entries: [
                // Dip buy first: a larger tranche when price is >= dipPct below the rolling high.
                {
                    id: "dip_buy",
                    when: { op: "lt", args: ["dip", -Math.abs(dipPct)] },
                    then: { order_type: "market", side: "BUY", sizing: { kind: "quote_size", value: amount * 2 }, time_in_force: "IOC" },
                },
                // DCA floor: always-true sentinel so each cadence tick buys the base tranche.
                {
                    id: "dca",
                    when: { op: "gte", args: [1, 1] },
                    then: { order_type: "market", side: "BUY", sizing: { kind: "quote_size", value: amount }, time_in_force: "IOC" },
                },
            ],
            // Schema requires >=1 exit; TP/SL is enforced engine-side. Never-true sentinel.
            exits: [
                {
                    id: "noop_exit",
                    when: { op: "eq", args: [0, 1] },
                    then: { order_type: "market", side: "SELL", sizing: { kind: "pct_equity", value: 100 }, time_in_force: "IOC" },
                },
            ],
            risk: {
                max_position_notional_usd: amount * 100,
                max_daily_loss_usd: amount * 10,
                max_concurrent_positions: 1,
                per_trade_take_profit_bps: Math.round(tpPct * 100),
                per_trade_stop_loss_bps: Math.round(slPct * 100),
                slippage_bps_max: 50,
            },
            operations: { evaluation_interval_seconds: cadence, persistent: true, halt_on_error: true },
            resilience: { auto_kill_on_loss_limit: true, pause_on_stale_orders: 3, pause_on_market_data_lag_s: 600 },
        };
        const parsed = tryParseStrategyDSL(draft);
        if (parsed.ok === true) {
            return { ok: true, strategy: parsed.value, derived_by_heuristic: true };
        }
        // Fall through to other templates if the hybrid draft somehow fails to parse.
    }

    // DCA template
    if (/\bdca\b|dollar[- ]?cost|定投/.test(lower)) {
        const dollarAmountMatch = /\$\s*([0-9]+(?:\.[0-9]+)?)/.exec(naturalLanguage);
        const amount = dollarAmountMatch ? Number.parseFloat(dollarAmountMatch[1]) : 50;
        const cadence = /\bdaily\b|每日/.test(lower)
            ? 86400
            : /\bweekly\b|每周/.test(lower)
              ? 7 * 86400
              : /\bhourly\b|每小时/.test(lower)
                ? 3600
                : 7 * 86400;

        const draft: StrategyDSL = {
            identity: {
                id: `dca-${baseSymbol.toLowerCase()}-${cadence}`,
                version: 1,
                owner: options.owner,
                status: "draft",
                mode: "paper",
                name: `DCA $${amount} ${baseSymbol} every ${cadence}s`,
            },
            universe: { venue: options.venue, symbols: [symbol] },
            signals: [
                { id: "tick", kind: "price.rsi", params: { period: 14 } },
            ],
            entries: [
                {
                    id: "dca_buy",
                    when: { op: "gte", args: [1, 1] }, // always-true sentinel
                    then: {
                        order_type: "market",
                        side: "BUY",
                        sizing: { kind: "quote_size", value: amount },
                        time_in_force: "IOC",
                    },
                },
            ],
            exits: [
                {
                    id: "manual_exit",
                    when: { op: "eq", args: [0, 1] }, // never-true sentinel; DCA has no auto-exit
                    then: {
                        order_type: "market",
                        side: "SELL",
                        sizing: { kind: "pct_equity", value: 100 },
                        time_in_force: "IOC",
                    },
                },
            ],
            risk: {
                max_position_notional_usd: amount * 100,
                max_daily_loss_usd: amount * 10,
                max_concurrent_positions: 1,
                slippage_bps_max: 50,
            },
            operations: {
                evaluation_interval_seconds: cadence,
                persistent: true,
                halt_on_error: true,
            },
            resilience: {
                auto_kill_on_loss_limit: true,
                pause_on_stale_orders: 3,
                pause_on_market_data_lag_s: 30,
            },
        };
        const parsed = tryParseStrategyDSL(draft);
        if (parsed.ok === true) {
            return { ok: true, strategy: parsed.value, derived_by_heuristic: true };
        }
        const failedIssues: string[] =
            "issues" in parsed ? (parsed as { issues: string[] }).issues : [];
        return {
            ok: false,
            needsClarification: true,
            locale: options.locale,
            text:
                options.locale === "zh-CN"
                    ? "无法解析 DCA 策略，请说明金额和周期。"
                    : "Could not compile DCA strategy — please specify amount and cadence.",
            issues: failedIssues,
        };
    }

    // RSI mean-revert template
    if (/\brsi\b/i.test(naturalLanguage)) {
        const lowMatch = /\b(?:rsi\s*<\s*|below\s*)([0-9]+(?:\.[0-9]+)?)/i.exec(
            naturalLanguage,
        );
        const highMatch = /\b(?:rsi\s*>\s*|above\s*)([0-9]+(?:\.[0-9]+)?)/i.exec(
            naturalLanguage,
        );
        const low = lowMatch ? Number.parseFloat(lowMatch[1]) : 30;
        const high = highMatch ? Number.parseFloat(highMatch[1]) : 70;
        const intervalMatch = /\b([0-9]+)\s*(min|minute|minutes|hour|hours|h|m)\b/i.exec(
            naturalLanguage,
        );
        let interval = 3600;
        if (intervalMatch) {
            const n = Number.parseInt(intervalMatch[1], 10);
            const unit = intervalMatch[2].toLowerCase();
            if (unit.startsWith("m")) interval = n * 60;
            else interval = n * 3600;
        }

        const draft: StrategyDSL = {
            identity: {
                id: `rsi-meanrevert-${baseSymbol.toLowerCase()}`,
                version: 1,
                owner: options.owner,
                status: "draft",
                mode: "paper",
                name: `RSI ${low}/${high} mean-revert on ${baseSymbol}`,
            },
            universe: { venue: options.venue, symbols: [symbol] },
            signals: [
                { id: "rsi14", kind: "price.rsi", params: { period: 14 } },
            ],
            entries: [
                {
                    id: "rsi_long_entry",
                    when: { op: "lt", args: ["rsi14", low] },
                    then: {
                        order_type: "limit",
                        side: "BUY",
                        sizing: { kind: "pct_equity", value: 10 },
                        limit_offset_bps: 5,
                        time_in_force: "GTC",
                    },
                },
            ],
            exits: [
                {
                    id: "rsi_long_exit",
                    when: { op: "gt", args: ["rsi14", high] },
                    then: {
                        order_type: "limit",
                        side: "SELL",
                        sizing: { kind: "pct_equity", value: 100 },
                        limit_offset_bps: 5,
                        time_in_force: "GTC",
                    },
                },
            ],
            risk: {
                max_position_notional_usd: 1000,
                max_daily_loss_usd: 100,
                max_concurrent_positions: 1,
                per_trade_stop_loss_bps: 200,
                per_trade_take_profit_bps: 400,
                slippage_bps_max: 50,
            },
            operations: {
                evaluation_interval_seconds: interval,
                persistent: true,
                halt_on_error: true,
            },
            resilience: {
                auto_kill_on_loss_limit: true,
                pause_on_stale_orders: 3,
                pause_on_market_data_lag_s: 30,
            },
        };
        const parsed = tryParseStrategyDSL(draft);
        if (parsed.ok === true) {
            return { ok: true, strategy: parsed.value, derived_by_heuristic: true };
        }
        const failedIssues: string[] =
            "issues" in parsed ? (parsed as { issues: string[] }).issues : [];
        return {
            ok: false,
            needsClarification: true,
            locale: options.locale,
            text:
                options.locale === "zh-CN"
                    ? "RSI 策略编译失败 — 请检查输入。"
                    : "RSI strategy compilation failed — please check inputs.",
            issues: failedIssues,
        };
    }

    return {
        ok: false,
        needsClarification: true,
        locale: options.locale,
        text:
            options.locale === "zh-CN"
                ? "无法识别策略类型。请明确：是 DCA、RSI 均值回归还是其他？"
                : "Couldn't classify strategy. Please clarify: is this DCA, RSI mean-revert, or another type?",
        issues: ["unknown_strategy_template"],
    };
}
