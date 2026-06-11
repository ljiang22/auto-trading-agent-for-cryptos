import type { Plugin } from "@elizaos/core";
import { whaleAlertAction } from "./actions/get_whale_alert.ts";
import { inflowOutflowAction } from "./actions/get_inflow_outflow.ts";
import { transactionVolumeAction } from "./actions/get_transaction_volume.ts";
import { bidAskVolumeAction } from "./actions/get_bid_ask.ts";
import { AddressAndTransactionDataAction } from "./actions/get_addressandtransaction.ts";

export * as actions from "./actions/index.ts";
export const crypto_on_chain_dataPlugin: Plugin = {
    name: "crypto_on_chain_data",
    description: "Multiple on-chain data sources for crypto analysis including whale movements, market flow analysis, transaction volume analysis, bid/ask volume analysis, and basic on-chain metrics",
    actions: [
        whaleAlertAction,
        inflowOutflowAction,
        transactionVolumeAction,
        bidAskVolumeAction,
        AddressAndTransactionDataAction,
    ],
};

export default crypto_on_chain_dataPlugin;
