import { z } from "zod";

export const mantleSwapParamsSchema = z.object({
    tokenIn: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    tokenOut: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    amountIn: z.string().min(1),
    maxSlippageBps: z.number().int().min(1).max(10_000).optional(),
    chainId: z.number().int().positive().optional(),
});

export type MantleSwapParams = z.infer<typeof mantleSwapParamsSchema>;

export interface MantleSwapQuote {
    chainId: number;
    sellToken: string;
    buyToken: string;
    sellAmount: string;
    buyAmount: string;
    estimatedGas: string;
    slippageBps: number;
    routeSummary: string;
    priceImpactPct?: number;
    allowanceTarget?: string;
    transaction?: {
        to: `0x${string}`;
        data: `0x${string}`;
        value: string;
        gas?: string;
    };
    permit2?: {
        type?: string;
        hash?: string;
        eip712?: {
            types: Record<string, unknown>;
            domain: Record<string, unknown>;
            message: Record<string, unknown>;
            primaryType: string;
        };
    };
    issues?: {
        allowance?: { actual: string; spender: string } | null;
        balance?: { token: string; actual: string; expected: string } | null;
    };
}

export interface MantleIntentAuditRecord {
    intentHash: `0x${string}`;
    user: `0x${string}`;
    action: string;
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    amountIn: string;
    maxSlippageBps: number;
    riskScore: number;
    timestamp: number;
}

export type MantleRiskVerdict = "allow" | "refuse";

export interface MantleRiskDecision {
    verdict: MantleRiskVerdict;
    rulesFired: string[];
    explanations: string[];
    riskScore: number;
}

export interface MantleBalanceResult {
    nativeMnt: string;
    tokens: Array<{
        symbol: string;
        address: `0x${string}`;
        balance: string;
        decimals: number;
    }>;
}
