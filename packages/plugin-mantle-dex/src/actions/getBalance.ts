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
import { formatUnits } from "viem";
import { erc20Abi } from "viem";
import { createMantlePublicClient, getDemoWalletAddress } from "../clients/mantleViem.ts";
import { getDefaultChainId } from "../clients/mantleChain.ts";
import { getTokensForChain } from "../config/tokens.ts";

export const getMantleBalanceAction: Action = {
    name: "get_mantle_balance",
    description:
        "Get native MNT and ERC20 token balances on Mantle for the demo wallet.",
    similes: ["MANTLE_BALANCE", "CHECK_MANTLE_WALLET"],
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state: State,
        _options: Record<string, unknown>,
        callback?: HandlerCallback,
    ) => {
        try {
            const chainId = getDefaultChainId();
            const address = getDemoWalletAddress(chainId);
            if (!address) {
                throw new Error("MANTLE_PRIVATE_KEY not configured");
            }

            const client = createMantlePublicClient(chainId);
            const nativeBalance = await client.getBalance({ address });
            const tokens = getTokensForChain(chainId);
            const tokenBalances = [];

            for (const token of tokens) {
                const raw = await client.readContract({
                    address: token.address,
                    abi: erc20Abi,
                    functionName: "balanceOf",
                    args: [address],
                });
                tokenBalances.push({
                    symbol: token.symbol,
                    address: token.address,
                    balance: formatUnits(raw, token.decimals),
                    decimals: token.decimals,
                });
            }

            const lines = [
                `**Mantle Balance** (chain ${chainId})`,
                `Wallet: \`${address}\``,
                `- MNT: ${formatUnits(nativeBalance, 18)}`,
                ...tokenBalances.map(
                    (t) => `- ${t.symbol}: ${t.balance}`,
                ),
            ];

            const text = lines.join("\n");
            if (callback) {
                await callback(
                    createActionResponse({
                        actionName: "get_mantle_balance",
                        type: "mantle_balance",
                        text,
                        content: { chainId, address, tokens: tokenBalances },
                    }),
                );
                return true;
            }
            return { text };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            elizaLogger.error(`[mantle-dex] get_mantle_balance failed: ${msg}`);
            if (callback) {
                await callback(
                    createActionErrorResponse({
                        actionName: "get_mantle_balance",
                        type: "mantle_balance_error",
                        error: error instanceof Error ? error : new Error(msg),
                        text: `Failed to fetch Mantle balance: ${msg}`,
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
                content: { text: "Show my Mantle wallet balance" },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Fetching Mantle balances.",
                    action: "get_mantle_balance",
                },
            },
        ],
    ],
};
