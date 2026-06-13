import {
    createActionErrorResponse,
    createActionResponse,
    elizaLogger,
    type Action,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
} from "@elizaos/core";
import { getSwapQuoteSource } from "../clients/swapQuoteSource.ts";
import { getDefaultChainId } from "../clients/mantleChain.ts";
import { getDemoWalletAddress } from "../clients/mantleViem.ts";
import {
    formatBaseUnits,
    resolveTokenByAddress,
} from "../config/tokens.ts";
import { mantleSwapParamsSchema } from "../types.ts";

export const getMantleSwapQuoteAction: Action = {
    name: "get_mantle_swap_quote",
    description:
        "Get a 0x swap quote on Mantle (amount out, slippage, route summary).",
    similes: ["MANTLE_QUOTE", "MANTLE_SWAP_QUOTE"],
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state: State,
        options: Record<string, unknown>,
        callback?: HandlerCallback,
    ) => {
        try {
            const chainId =
                typeof options.chainId === "number"
                    ? options.chainId
                    : getDefaultChainId();
            const taker =
                (options.taker as `0x${string}` | undefined) ??
                getDemoWalletAddress(chainId);
            if (!taker) {
                throw new Error("No taker address for Mantle quote");
            }

            const parsed = mantleSwapParamsSchema.parse({
                tokenIn: options.tokenIn,
                tokenOut: options.tokenOut,
                amountIn: options.amountIn,
                maxSlippageBps: options.maxSlippageBps,
                chainId,
            });

            const quote = await getSwapQuoteSource().getQuote({
                ...parsed,
                taker,
            });

            const sellTok = resolveTokenByAddress(quote.sellToken, chainId);
            const buyTok = resolveTokenByAddress(quote.buyToken, chainId);
            const sellHuman = sellTok
                ? `${formatBaseUnits(quote.sellAmount, sellTok.decimals)} ${sellTok.symbol}`
                : `${quote.sellAmount} (${quote.sellToken})`;
            const buyHuman = buyTok
                ? `${formatBaseUnits(quote.buyAmount, buyTok.decimals)} ${buyTok.symbol}`
                : `${quote.buyAmount} (${quote.buyToken})`;

            const text = [
                `**Mantle Swap Quote** (chain ${chainId})`,
                `- Sell: ${sellHuman}`,
                `- Buy:  ~${buyHuman}`,
                `- Slippage: ${quote.slippageBps} bps`,
                `- Route: ${quote.routeSummary}`,
                quote.priceImpactPct !== undefined
                    ? `- Price impact: ${quote.priceImpactPct.toFixed(3)}%`
                    : null,
            ]
                .filter(Boolean)
                .join("\n");

            if (callback) {
                await callback(
                    createActionResponse({
                        actionName: "get_mantle_swap_quote",
                        type: "mantle_swap_quote",
                        text,
                        content: quote,
                        actionData: quote,
                    }),
                );
                return true;
            }
            return { text, content: quote };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            elizaLogger.error(`[mantle-dex] get_mantle_swap_quote failed: ${msg}`);
            if (callback) {
                await callback(
                    createActionErrorResponse({
                        actionName: "get_mantle_swap_quote",
                        type: "mantle_swap_quote_error",
                        error: error instanceof Error ? error : new Error(msg),
                        text: `Quote failed: ${msg}`,
                    }),
                );
                return false;
            }
            return { text: msg };
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Quote swapping 5 USDC to WMNT on Mantle" },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Fetching Mantle swap quote.",
                    action: "get_mantle_swap_quote",
                },
            },
        ],
    ],
};
