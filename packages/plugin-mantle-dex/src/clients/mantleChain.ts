import type { Chain } from "viem";

/** Gate A decision: 0x serves Mantle mainnet (5000); Sepolia (5003) is fallback-only. */
export const MANTLE_MAINNET_CHAIN_ID = 5000;
export const MANTLE_SEPOLIA_CHAIN_ID = 5003;

export const mantleMainnet: Chain = {
    id: MANTLE_MAINNET_CHAIN_ID,
    name: "Mantle",
    nativeCurrency: { name: "Mantle", symbol: "MNT", decimals: 18 },
    rpcUrls: {
        default: { http: ["https://rpc.mantle.xyz"] },
    },
    blockExplorers: {
        default: {
            name: "Mantle Explorer",
            url: "https://explorer.mantle.xyz",
        },
    },
};

export const mantleSepolia: Chain = {
    id: MANTLE_SEPOLIA_CHAIN_ID,
    name: "Mantle Sepolia",
    nativeCurrency: { name: "Mantle", symbol: "MNT", decimals: 18 },
    rpcUrls: {
        default: { http: ["https://rpc.sepolia.mantle.xyz"] },
    },
    blockExplorers: {
        default: {
            name: "Mantle Sepolia Explorer",
            url: "https://explorer.sepolia.mantle.xyz",
        },
    },
    testnet: true,
};

export function resolveMantleChain(chainId: number): Chain {
    if (chainId === MANTLE_SEPOLIA_CHAIN_ID) {
        return mantleSepolia;
    }
    return mantleMainnet;
}

export function getExplorerTxUrl(chainId: number, txHash: string): string {
    const chain = resolveMantleChain(chainId);
    const base = chain.blockExplorers?.default?.url ?? "https://explorer.mantle.xyz";
    return `${base}/tx/${txHash}`;
}

export function getDefaultChainId(): number {
    const raw = process.env.MANTLE_CHAIN_ID;
    if (raw) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return MANTLE_MAINNET_CHAIN_ID;
}

export function getDefaultRpcUrl(chainId: number): string {
    if (process.env.MANTLE_RPC_URL) {
        return process.env.MANTLE_RPC_URL;
    }
    return resolveMantleChain(chainId).rpcUrls.default.http[0]!;
}
