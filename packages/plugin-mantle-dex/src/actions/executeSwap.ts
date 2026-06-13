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
import { maxUint256 } from "viem";
import { getSwapQuoteSource } from "../clients/swapQuoteSource.ts";
import {
    getDefaultChainId,
    getExplorerTxUrl,
} from "../clients/mantleChain.ts";
import {
    createMantlePublicClient,
    createMantleWalletClient,
    getDemoWalletAddress,
} from "../clients/mantleViem.ts";
import {
    appendPermit2Signature,
    eip712ForViem,
    PERMIT2_ADDRESS,
} from "../clients/permit2.ts";
import { isNativeTokenAddress } from "../config/tokens.ts";
import { mantleSwapParamsSchema } from "../types.ts";

const ERC20_ALLOWANCE_ABI = [
    {
        name: "allowance",
        type: "function",
        stateMutability: "view",
        inputs: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
        ],
        outputs: [{ type: "uint256" }],
    },
] as const;

const ERC20_APPROVE_ABI = [
    {
        name: "approve",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" },
        ],
        outputs: [{ type: "bool" }],
    },
] as const;

export const executeMantleSwapAction: Action = {
    name: "execute_mantle_swap",
    description:
        "Execute a Mantle swap via 0x using the server demo wallet (MVP signing path).",
    similes: ["MANTLE_SWAP", "SUBMIT_MANTLE_SWAP"],
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
            const taker = getDemoWalletAddress(chainId);
            if (!taker) {
                throw new Error("MANTLE_PRIVATE_KEY not configured");
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

            if (!quote.transaction) {
                throw new Error("0x quote did not include executable transaction data");
            }

            const walletClient = createMantleWalletClient(chainId);
            const publicClient = createMantlePublicClient(chainId);
            const account = walletClient.account!;

            // ERC-20 sells via 0x v2 need a Permit2 allowance on the sell token.
            // Native (MNT) sells carry value in the tx and need no approval.
            if (!isNativeTokenAddress(parsed.tokenIn) && quote.permit2) {
                const spender = (quote.issues?.allowance?.spender ??
                    PERMIT2_ADDRESS) as `0x${string}`;
                const required = BigInt(parsed.amountIn);
                const current = (await publicClient.readContract({
                    address: parsed.tokenIn as `0x${string}`,
                    abi: ERC20_ALLOWANCE_ABI,
                    functionName: "allowance",
                    args: [account.address, spender],
                })) as bigint;
                if (current < required) {
                    elizaLogger.info(
                        `[mantle-dex] approving ${parsed.tokenIn} → Permit2 (${spender})`,
                    );
                    const approveHash = await walletClient.writeContract({
                        address: parsed.tokenIn as `0x${string}`,
                        abi: ERC20_APPROVE_ABI,
                        functionName: "approve",
                        args: [spender, maxUint256],
                        account,
                        chain: walletClient.chain,
                    });
                    const approveReceipt =
                        await publicClient.waitForTransactionReceipt({
                            hash: approveHash,
                        });
                    if (approveReceipt.status === "reverted") {
                        throw new Error(
                            `Permit2 approval reverted on-chain (tx ${approveHash})`,
                        );
                    }
                }
            }

            // Append the signed PermitTransferFrom to the calldata (0x v2 flow).
            let txData = quote.transaction.data;
            if (quote.permit2?.eip712) {
                const signature = await walletClient.signTypedData({
                    account,
                    ...(eip712ForViem(quote.permit2.eip712) as never),
                });
                txData = appendPermit2Signature(quote.transaction.data, signature);
            }

            const hash = await walletClient.sendTransaction({
                account,
                chain: walletClient.chain,
                to: quote.transaction.to,
                data: txData,
                value: BigInt(quote.transaction.value),
                gas: quote.transaction.gas
                    ? BigInt(quote.transaction.gas)
                    : undefined,
            });

            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            if (receipt.status === "reverted") {
                // Surface as a failure so the workflow renders it honestly (R2).
                throw new Error(`Swap transaction reverted on-chain (tx ${hash})`);
            }
            const explorerUrl = getExplorerTxUrl(chainId, hash);

            const text = [
                `**Mantle Swap Executed**`,
                `- Tx: \`${hash}\``,
                `- Explorer: ${explorerUrl}`,
                `- Sold: ${quote.sellAmount} → Bought: ${quote.buyAmount}`,
                `- Route: ${quote.routeSummary}`,
                options.intentHash
                    ? `- Intent hash: \`${options.intentHash}\``
                    : null,
            ]
                .filter(Boolean)
                .join("\n");

            const payload = {
                txHash: hash,
                explorerUrl,
                chainId,
                intentHash: options.intentHash,
                quote,
            };

            if (callback) {
                await callback(
                    createActionResponse({
                        actionName: "execute_mantle_swap",
                        type: "mantle_swap_executed",
                        text,
                        content: payload,
                        actionData: payload,
                    }),
                );
                return true;
            }
            return { text, content: payload };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            elizaLogger.error(`[mantle-dex] execute_mantle_swap failed: ${msg}`);
            if (callback) {
                await callback(
                    createActionErrorResponse({
                        actionName: "execute_mantle_swap",
                        type: "mantle_swap_error",
                        error: error instanceof Error ? error : new Error(msg),
                        text: `Swap execution failed: ${msg}`,
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
                content: { text: "Execute the approved Mantle swap" },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Submitting Mantle swap transaction.",
                    action: "execute_mantle_swap",
                },
            },
        ],
    ],
};
