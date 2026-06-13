import type { MantleRiskDecision, MantleSwapQuote } from "../types.ts";
import {
    getDefaultMaxSlippageBps,
    getDefaultMaxTradeUsd,
    getTokenAllowlist,
} from "../config/tokens.ts";

export interface MantleRiskInput {
    chainId: number;
    tokenIn: string;
    tokenOut: string;
    amountInHuman: string;
    /** Human-readable sell symbol (e.g. USDC) for stablecoin USD sizing. */
    tokenInSymbol?: string;
    amountInUsdEstimate?: number;
    quote?: MantleSwapQuote;
    requestedSlippageBps?: number;
}

export function evaluateMantleRisk(input: MantleRiskInput): MantleRiskDecision {
    const rulesFired: string[] = [];
    const explanations: string[] = [];
    let riskScore = 0;

    const allowlist = getTokenAllowlist(input.chainId);
    const tokenInLower = input.tokenIn.toLowerCase();
    const tokenOutLower = input.tokenOut.toLowerCase();

    if (!allowlist.has(tokenInLower) || !allowlist.has(tokenOutLower)) {
        rulesFired.push("token_allowlist");
        explanations.push(
            "One or both tokens are not on the Mantle demo allowlist. " +
                `Allowed: ${[...allowlist].join(", ")}`,
        );
        riskScore += 50;
    }

    const maxTradeUsd = getDefaultMaxTradeUsd();
    const usdEstimate = input.amountInUsdEstimate ?? estimateUsdFromAmount(input);
    if (usdEstimate > maxTradeUsd) {
        rulesFired.push("max_trade_usd");
        explanations.push(
            `Trade size ~$${usdEstimate.toFixed(2)} exceeds demo cap of $${maxTradeUsd}.`,
        );
        riskScore += 40;
    }

    const maxSlippageBps = getDefaultMaxSlippageBps();
    const requestedSlippage = input.requestedSlippageBps ?? input.quote?.slippageBps ?? 100;
    if (requestedSlippage > maxSlippageBps) {
        rulesFired.push("max_slippage");
        explanations.push(
            `Requested slippage ${requestedSlippage} bps exceeds cap of ${maxSlippageBps} bps.`,
        );
        riskScore += 30;
    }

    if (input.quote?.priceImpactPct !== undefined && input.quote.priceImpactPct > 5) {
        rulesFired.push("price_impact");
        explanations.push(
            `Quote price impact ${input.quote.priceImpactPct.toFixed(2)}% is too high for demo.`,
        );
        riskScore += 25;
    }

    const yoloRe = /\b(?:all|everything|max|yolo|100%)\b/i;
    if (yoloRe.test(input.amountInHuman)) {
        rulesFired.push("yolo_size");
        explanations.push("Oversized or 'all balance' swaps are blocked in the demo risk gate.");
        riskScore += 60;
    }

    const verdict = rulesFired.length > 0 ? "refuse" : "allow";
    return {
        verdict,
        rulesFired,
        explanations,
        riskScore: Math.min(100, riskScore),
    };
}

function estimateUsdFromAmount(input: MantleRiskInput): number {
    const amount = Number.parseFloat(input.amountInHuman);
    if (!Number.isFinite(amount) || amount <= 0) {
        return 0;
    }
    const stableSymbols = ["USDC", "USDT", "USD"];
    const inSymbol = input.tokenInSymbol ?? input.tokenIn;
    if (stableSymbols.some((s) => inSymbol.toUpperCase().includes(s))) {
        return amount;
    }
    return amount * 0.5;
}
