import type { Address } from "viem";

export interface TokenInfo {
    symbol: string;
    address: Address;
    decimals: number;
}

/** Known tokens per chain — override via env for demo flexibility. */
const TOKENS_BY_CHAIN: Record<number, Record<string, TokenInfo>> = {
    5000: {
        WMNT: {
            symbol: "WMNT",
            address: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
            decimals: 18,
        },
        USDC: {
            symbol: "USDC",
            address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
            decimals: 6,
        },
        USDT: {
            symbol: "USDT",
            address: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE",
            decimals: 6,
        },
    },
    5003: {
        WMNT: {
            symbol: "WMNT",
            address: "0x19f5557E23e9914A18239990f6C70D68FDF0deD5",
            decimals: 18,
        },
        USDC: {
            symbol: "USDC",
            address: "0xAcab8129E2cE587fD203FD770ec9ECAFA2C88080",
            decimals: 6,
        },
        MNT: {
            symbol: "MNT",
            address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address,
            decimals: 18,
        },
    },
};

const NATIVE_PLACEHOLDER = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export function getTokenAllowlist(chainId: number): Set<string> {
    const tokens = TOKENS_BY_CHAIN[chainId] ?? {};
    return new Set(
        Object.values(tokens).map((t) => t.address.toLowerCase()),
    );
}

export function resolveTokenSymbol(
    symbol: string,
    chainId: number,
): TokenInfo | null {
    const normalized = symbol.trim().toUpperCase();
    const tokens = TOKENS_BY_CHAIN[chainId] ?? {};
    if (normalized === "MNT" || normalized === "WMNT") {
        return tokens.WMNT ?? null;
    }
    return tokens[normalized] ?? null;
}

/** Reverse lookup so quotes can render human amounts/symbols from an address. */
export function resolveTokenByAddress(
    address: string,
    chainId: number,
): TokenInfo | null {
    const target = address.trim().toLowerCase();
    const tokens = TOKENS_BY_CHAIN[chainId] ?? {};
    for (const token of Object.values(tokens)) {
        if (token.address.toLowerCase() === target) {
            return token;
        }
    }
    return null;
}

/** Format a base-unit string as a trimmed human decimal (e.g. "9132…" → "9.1328"). */
export function formatBaseUnits(
    baseUnits: string,
    decimals: number,
    maxFractionDigits = 6,
): string {
    if (!/^\d+$/.test(baseUnits)) {
        return baseUnits;
    }
    const padded = baseUnits.padStart(decimals + 1, "0");
    const whole = padded.slice(0, padded.length - decimals) || "0";
    let frac = decimals > 0 ? padded.slice(padded.length - decimals) : "";
    frac = frac.slice(0, maxFractionDigits).replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : whole;
}

export function parseAmountToBaseUnits(
    amount: string,
    decimals: number,
): string {
    // Input is always a HUMAN amount (e.g. "5" or "0.5" USDC) and must be
    // scaled by `decimals`. There is deliberately NO integer passthrough: an
    // earlier `/^\d+$/ → return as-is` shortcut made "swap 5 USDC" quote 5 base
    // units (0.000005 USDC) of dust, so 0x returned no liquidity / no tx and
    // the swap failed.
    const trimmed = amount.trim();
    const [whole, frac = ""] = trimmed.split(".");
    const paddedFrac = frac.padEnd(decimals, "0").slice(0, decimals);
    const combined = `${whole}${paddedFrac}`.replace(/^0+/, "") || "0";
    return combined;
}

export function isNativeTokenAddress(address: string): boolean {
    return address.toLowerCase() === NATIVE_PLACEHOLDER.toLowerCase();
}

export function getTokensForChain(chainId: number): TokenInfo[] {
    const tokens = TOKENS_BY_CHAIN[chainId] ?? {};
    return Object.values(tokens).filter(
        (t) => !isNativeTokenAddress(t.address),
    );
}

export function getDefaultMaxTradeUsd(): number {
    const raw = process.env.MANTLE_MAX_TRADE_USD ?? "25";
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 25;
}

export function getDefaultMaxSlippageBps(): number {
    const raw = process.env.MANTLE_MAX_SLIPPAGE_BPS ?? "200";
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 200;
}
