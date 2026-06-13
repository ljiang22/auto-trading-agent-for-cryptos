import type { MantleSwapParams, MantleSwapQuote } from "../types.ts";
import { fetchZeroExQuote } from "./zeroEx.ts";

/** Unified swap quote source — 0x aggregation on the configured Mantle chain. */
export interface SwapQuoteSource {
    getQuote(params: MantleSwapParams & { taker: `0x${string}` }): Promise<MantleSwapQuote>;
}

export const zeroExQuoteSource: SwapQuoteSource = {
    async getQuote(params) {
        return fetchZeroExQuote(params);
    },
};

export function getSwapQuoteSource(): SwapQuoteSource {
    return zeroExQuoteSource;
}
