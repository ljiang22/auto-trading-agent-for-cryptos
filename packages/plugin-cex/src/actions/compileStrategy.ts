import {
    type Action,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
    elizaLogger,
} from "@elizaos/core";

import { compileNlToDsl } from "../strategy/nlToDSL";
import { summarizeStrategy } from "../strategy/strategyDSL";

export const compileStrategyAction: Action = {
    name: "compile_strategy",
    description:
        "**STRATEGY COMPILER (autotrading)** — Use this action whenever the user wants to define, author, or compile a trading strategy from natural language. Trigger keywords: 'compile', 'create strategy', 'make strategy', 'define DCA', 'design RSI', 'set up SMA cross', 'strategy DSL'. Strategies supported: DCA (dollar-cost average), RSI mean-revert, SMA/EMA cross. Returns the compiled JSON DSL + human summary. Does NOT submit orders. **DO NOT pick TASK_CHAIN for strategy compilation; this action exists for that purpose.** Pair with `run_backtest` to evaluate or `set_trading_mode=paper` to dry-run live.",
    examples: [
        [
            { user: "{{user1}}", content: { text: "compile a DCA strategy for $50 BTC weekly on binance" } },
            { user: "{{user2}}", content: { text: "Compiling the DCA strategy", action: "compile_strategy" } },
        ],
        [
            { user: "{{user1}}", content: { text: "make me an RSI 30/70 mean-revert strategy on ETH hourly" } },
            { user: "{{user2}}", content: { text: "Compiling the RSI strategy", action: "compile_strategy" } },
        ],
        [
            { user: "{{user1}}", content: { text: "define a strategy that buys BTC when RSI is below 30" } },
            { user: "{{user2}}", content: { text: "Defining the RSI strategy", action: "compile_strategy" } },
        ],
        [
            { user: "{{user1}}", content: { text: "create a dollar cost averaging strategy" } },
            { user: "{{user2}}", content: { text: "Creating the DCA strategy", action: "compile_strategy" } },
        ],
    ],
    handler: async (
        runtime: IAgentRuntime,
        memory: Memory,
        _state: State | undefined,
        options: Record<string, unknown> | undefined,
        callback?: HandlerCallback,
    ): Promise<unknown> => {
        const opts = (options ?? {}) as Record<string, unknown>;
        const text =
            typeof opts.naturalLanguage === "string"
                ? opts.naturalLanguage
                : typeof opts.description === "string"
                  ? opts.description
                  : memory.content?.text ?? "";
        const locale = (opts.locale === "zh-CN" ? "zh-CN" : "en") as "en" | "zh-CN";
        const venue =
            opts.venue === "coinbase" || opts.venue === "paper"
                ? (opts.venue as "coinbase" | "paper")
                : "binance";
        const owner =
            typeof opts.owner === "string"
                ? opts.owner
                : (memory.userId ? String(memory.userId) : "anonymous");

        elizaLogger.info(`[plugin-cex] compile_strategy invoked: locale=${locale} venue=${venue}`);

        const result = compileNlToDsl(text, { locale, owner, venue });
        if (!result.ok) {
            const responseText = result.text;
            if (callback) {
                await callback({
                    text: responseText,
                    action: "compile_strategy",
                    metadata: {
                        success: false,
                        clarification: true,
                        issues: result.issues,
                    },
                });
            }
            return { success: false, clarification: responseText, issues: result.issues };
        }

        const summary = summarizeStrategy(result.strategy);
        const responseText = [
            `**Strategy compiled** — ${summary}`,
            "",
            "```json",
            JSON.stringify(result.strategy, null, 2),
            "```",
            "",
            "Next steps: `run_backtest` to evaluate against historical data, or set trading mode to `paper` to dry-run live.",
        ].join("\n");

        if (callback) {
            await callback({
                text: responseText,
                action: "compile_strategy",
                metadata: {
                    success: true,
                    strategy: result.strategy,
                    derivedByHeuristic: result.derived_by_heuristic,
                },
            });
        }
        return { success: true, strategy: result.strategy };
    },
};
