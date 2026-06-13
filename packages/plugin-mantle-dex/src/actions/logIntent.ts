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
import { encodeFunctionData } from "viem";
import { getDefaultChainId } from "../clients/mantleChain.ts";
import {
    createMantlePublicClient,
    createMantleWalletClient,
    getDemoWalletAddress,
} from "../clients/mantleViem.ts";

const STRATEGY_AUDIT_LOG_ABI = [
    {
        type: "function",
        name: "logIntent",
        inputs: [
            { name: "intentHash", type: "bytes32" },
            { name: "user", type: "address" },
            { name: "action", type: "string" },
            { name: "tokenIn", type: "address" },
            { name: "tokenOut", type: "address" },
            { name: "amountIn", type: "uint256" },
            { name: "maxSlippageBps", type: "uint16" },
            { name: "riskScore", type: "uint8" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
] as const;

export const logMantleIntentAction: Action = {
    name: "log_mantle_intent",
    description:
        "Emit an on-chain intent audit event via StrategyAuditLog on Mantle.",
    similes: ["MANTLE_AUDIT", "LOG_MANTLE_INTENT"],
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state: State,
        options: Record<string, unknown>,
        callback?: HandlerCallback,
    ) => {
        try {
            const auditAddress = process.env.MANTLE_AUDIT_LOG_ADDRESS as
                | `0x${string}`
                | undefined;
            if (!auditAddress) {
                const text =
                    "MANTLE_AUDIT_LOG_ADDRESS not set — intent logged off-chain only.";
                if (callback) {
                    await callback(
                        createActionResponse({
                            actionName: "log_mantle_intent",
                            type: "mantle_intent_offchain",
                            text,
                            content: options,
                        }),
                    );
                    return true;
                }
                return { text };
            }

            const chainId = getDefaultChainId();
            const walletClient = createMantleWalletClient(chainId);
            const publicClient = createMantlePublicClient(chainId);
            const user =
                (options.user as `0x${string}` | undefined) ??
                getDemoWalletAddress(chainId);
            if (!user) {
                throw new Error("No user address for audit log");
            }

            const data = encodeFunctionData({
                abi: STRATEGY_AUDIT_LOG_ABI,
                functionName: "logIntent",
                args: [
                    options.intentHash as `0x${string}`,
                    user,
                    String(options.action ?? "swap"),
                    options.tokenIn as `0x${string}`,
                    options.tokenOut as `0x${string}`,
                    BigInt(String(options.amountIn)),
                    Number(options.maxSlippageBps ?? 100),
                    Number(options.riskScore ?? 0),
                ],
            });

            const hash = await walletClient.sendTransaction({
                account: walletClient.account!,
                chain: walletClient.chain,
                to: auditAddress,
                data,
            });
            await publicClient.waitForTransactionReceipt({ hash });

            const text = `Intent logged on-chain. Audit tx: \`${hash}\``;
            if (callback) {
                await callback(
                    createActionResponse({
                        actionName: "log_mantle_intent",
                        type: "mantle_intent_logged",
                        text,
                        content: { auditTxHash: hash, intentHash: options.intentHash },
                    }),
                );
                return true;
            }
            return { text };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            elizaLogger.error(`[mantle-dex] log_mantle_intent failed: ${msg}`);
            if (callback) {
                await callback(
                    createActionErrorResponse({
                        actionName: "log_mantle_intent",
                        type: "mantle_intent_error",
                        error: error instanceof Error ? error : new Error(msg),
                        text: `Audit log failed: ${msg}`,
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
                content: { text: "Log this Mantle swap intent on-chain" },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Writing intent to StrategyAuditLog.",
                    action: "log_mantle_intent",
                },
            },
        ],
    ],
};
