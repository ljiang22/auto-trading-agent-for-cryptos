import type { Plugin } from "@elizaos/core";
import { mantleDexActions } from "./actions/index.ts";

export const mantleDexPlugin: Plugin = {
    name: "mantle-dex",
    npmName: "@elizaos-plugins/plugin-mantle-dex",
    description:
        "Mantle on-chain DEX swaps via 0x aggregation with risk gates and audit logging.",
    actions: mantleDexActions,
};

export default mantleDexPlugin;

export { evaluateMantleRisk } from "./risk/mantleRiskEngine.ts";
export { parseZeroExQuote } from "./clients/zeroEx.ts";
export {
    parseSwapIntentFromText,
    isApprovalMessage,
    isBalanceQuery,
    computeIntentHash,
} from "./utils/parseSwapIntent.ts";
export {
    getDefaultChainId,
    getExplorerTxUrl,
    MANTLE_MAINNET_CHAIN_ID,
    MANTLE_SEPOLIA_CHAIN_ID,
} from "./clients/mantleChain.ts";
export {
    parseAmountToBaseUnits,
    resolveTokenSymbol,
} from "./config/tokens.ts";
export type {
    MantleSwapQuote,
    MantleSwapParams,
    MantleRiskDecision,
    MantleIntentAuditRecord,
} from "./types.ts";
