import { getMantleBalanceAction } from "./getBalance.ts";
import { executeMantleSwapAction } from "./executeSwap.ts";
import { getMantleSwapQuoteAction } from "./getSwapQuote.ts";
import { logMantleIntentAction } from "./logIntent.ts";

export const mantleDexActions = [
    getMantleBalanceAction,
    getMantleSwapQuoteAction,
    executeMantleSwapAction,
    logMantleIntentAction,
];
