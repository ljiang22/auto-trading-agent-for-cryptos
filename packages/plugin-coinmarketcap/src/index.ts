import type { Plugin } from "@elizaos/core";
import { getPrice } from "./actions/getPrice";
import { priceProvider } from "./providers";

export const coinmarketcapPlugin: Plugin = {
    name: "coinmarketcap",
    description: "CoinMarketCap Plugin for Eliza - Get cryptocurrency prices and fear index",
    actions: [getPrice],
    evaluators: [],
    providers: [priceProvider],
};

export default coinmarketcapPlugin;
