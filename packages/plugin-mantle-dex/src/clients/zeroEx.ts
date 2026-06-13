import { httpClient } from "@elizaos/core";
import type { MantleSwapParams, MantleSwapQuote } from "../types.ts";
import { getDefaultChainId } from "./mantleChain.ts";

const ZERO_EX_BASE = "https://api.0x.org";

export interface ZeroExQuoteResponse {
    buyAmount: string;
    sellAmount: string;
    estimatedGas?: string;
    allowanceTarget?: string;
    priceImpactPercentage?: string;
    sources?: Array<{ name: string; proportion: string }>;
    // 0x v2 returns the executed route under `route.fills[].source`
    // (e.g. MerchantMoe_V2.2, Agni) — the legacy `sources` array is absent.
    route?: {
        fills?: Array<{ source?: string; proportionBps?: string }>;
    };
    transaction?: {
        to: string;
        data: string;
        value: string;
        gas?: string;
    };
    // 0x v2 permit2 flow: present when the sell is an ERC-20 that requires a
    // signed PermitTransferFrom appended to the calldata + a Permit2 allowance.
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

export function parseZeroExQuote(
    chainId: number,
    sellToken: string,
    buyToken: string,
    sellAmount: string,
    slippageBps: number,
    raw: ZeroExQuoteResponse,
): MantleSwapQuote {
    const fills = raw.route?.fills ?? [];
    const sources = raw.sources ?? [];
    let routeSummary: string;
    if (fills.length > 0) {
        const seen = new Set<string>();
        const names: string[] = [];
        for (const f of fills) {
            const name = (f.source ?? "").replace(/_/g, " ").trim();
            if (name && !seen.has(name)) {
                seen.add(name);
                names.push(name);
            }
        }
        routeSummary = names.length > 0 ? names.join(" + ") : "0x aggregated route";
    } else if (sources.length > 0) {
        routeSummary = sources
            .map((s) => `${s.name} (${s.proportion})`)
            .join(" → ");
    } else {
        routeSummary = "0x aggregated route";
    }

    const tx = raw.transaction;
    return {
        chainId,
        sellToken,
        buyToken,
        sellAmount: raw.sellAmount ?? sellAmount,
        buyAmount: raw.buyAmount,
        estimatedGas: raw.estimatedGas ?? "0",
        slippageBps,
        routeSummary,
        priceImpactPct: raw.priceImpactPercentage
            ? Number.parseFloat(raw.priceImpactPercentage) * 100
            : undefined,
        allowanceTarget: raw.allowanceTarget,
        transaction: tx
            ? {
                  to: tx.to as `0x${string}`,
                  data: tx.data as `0x${string}`,
                  value: tx.value ?? "0",
                  gas: tx.gas,
              }
            : undefined,
        permit2: raw.permit2,
        issues: raw.issues,
    };
}

export async function fetchZeroExQuote(
    params: MantleSwapParams & { taker: `0x${string}` },
): Promise<MantleSwapQuote> {
    const apiKey = process.env.ZERO_EX_API_KEY;
    if (!apiKey) {
        throw new Error("ZERO_EX_API_KEY is required for Mantle swap quotes");
    }

    const chainId = params.chainId ?? getDefaultChainId();
    const slippageBps = params.maxSlippageBps ?? 100;
    const slippageFraction = (slippageBps / 10_000).toString();

    const query = new URLSearchParams({
        chainId: String(chainId),
        sellToken: params.tokenIn,
        buyToken: params.tokenOut,
        sellAmount: params.amountIn,
        taker: params.taker,
        slippagePercentage: slippageFraction,
    });

    const response = await httpClient.get(
        `${ZERO_EX_BASE}/swap/permit2/quote?${query.toString()}`,
        {
            headers: {
                "0x-api-key": apiKey,
                "0x-version": "v2",
                Accept: "application/json",
            },
        },
    );

    if (response.status < 200 || response.status >= 300) {
        const body =
            typeof response.data === "object"
                ? JSON.stringify(response.data)
                : String(response.data);
        throw new Error(`0x quote failed (${response.status}): ${body}`);
    }

    return parseZeroExQuote(
        chainId,
        params.tokenIn,
        params.tokenOut,
        params.amountIn,
        slippageBps,
        response.data as ZeroExQuoteResponse,
    );
}
