import { createHash } from "node:crypto";
import type { MantleSwapParams } from "../types.ts";

export function computeIntentHash(params: MantleSwapParams & { userId: string }): `0x${string}` {
    const payload = JSON.stringify({
        tokenIn: params.tokenIn.toLowerCase(),
        tokenOut: params.tokenOut.toLowerCase(),
        amountIn: params.amountIn,
        maxSlippageBps: params.maxSlippageBps ?? 100,
        chainId: params.chainId ?? 5000,
        userId: params.userId,
    });
    const hash = createHash("sha256").update(payload).digest("hex");
    return `0x${hash}` as `0x${string}`;
}

export interface ParsedSwapIntent {
    amountIn: string;
    tokenInSymbol: string;
    tokenOutSymbol: string;
    maxSlippageBps?: number;
}

const SWAP_INTENT_RE =
    /(?:swap|exchange|convert)\s+(\d+(?:\.\d+)?)\s*([A-Za-z]+)\s+(?:to|for|into)\s+([A-Za-z]+)/i;

const YOLO_SWAP_RE =
    /(?:swap|exchange|convert)\s+(?:all(?:\s+my)?(?:\s+balance)?|everything|max|yolo|100%)(?:\s+(?:to|for|into)\s+([A-Za-z]+))?/i;

const MANTLE_CONTEXT_RE = /\b(?:on\s+)?mantle\b|WMNT|Merchant\s+Moe/i;

export function parseSwapIntentFromText(text: string): ParsedSwapIntent | null {
    const trimmed = (text ?? "").trim();
    if (!trimmed) {
        return null;
    }

    const yoloMatch = YOLO_SWAP_RE.exec(trimmed);
    if (yoloMatch && MANTLE_CONTEXT_RE.test(trimmed)) {
        const tokenOut = yoloMatch[1]?.toUpperCase() ?? "WMNT";
        return {
            amountIn: "all",
            tokenInSymbol: "USDC",
            tokenOutSymbol: tokenOut,
        };
    }

    if (!MANTLE_CONTEXT_RE.test(trimmed) && !SWAP_INTENT_RE.test(trimmed)) {
        return null;
    }

    const match = SWAP_INTENT_RE.exec(trimmed);
    if (!match) {
        return null;
    }

    const [, amount, tokenIn, tokenOut] = match;
    let maxSlippageBps: number | undefined;
    const slippageMatch = /(\d+(?:\.\d+)?)\s*%?\s*slippage/i.exec(trimmed);
    if (slippageMatch) {
        maxSlippageBps = Math.round(Number.parseFloat(slippageMatch[1]!) * 100);
    }

    return {
        amountIn: amount!,
        tokenInSymbol: tokenIn!.toUpperCase(),
        tokenOutSymbol: tokenOut!.toUpperCase(),
        maxSlippageBps,
    };
}

export function isApprovalMessage(text: string): "approve" | "cancel" | null {
    const normalized = text.trim().toLowerCase();
    if (/^(approve|confirm|yes|execute|proceed)$/.test(normalized)) {
        return "approve";
    }
    if (/^(cancel|no|abort|stop|decline)$/.test(normalized)) {
        return "cancel";
    }
    return null;
}

export function isBalanceQuery(text: string): boolean {
    if (/\b(?:swap|exchange|convert)\b/i.test(text)) {
        return false;
    }
    return (
        /\b(?:balance|holdings|wallet)\b.*\bmantle\b|\bmantle\b.*\b(?:balance|holdings|wallet)\b/i.test(
            text,
        ) ||
        /\b(?:what are|show)\b.*\bholdings\b.*\bmantle\b/i.test(text)
    );
}
