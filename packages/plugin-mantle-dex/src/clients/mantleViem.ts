import { createPublicClient, createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
    getDefaultChainId,
    getDefaultRpcUrl,
    resolveMantleChain,
} from "./mantleChain.ts";

export function createMantlePublicClient(chainId = getDefaultChainId()) {
    const chain = resolveMantleChain(chainId);
    return createPublicClient({
        chain,
        transport: http(getDefaultRpcUrl(chainId)),
    });
}

export function createMantleWalletClient(chainId = getDefaultChainId()) {
    const privateKey = process.env.MANTLE_PRIVATE_KEY;
    if (!privateKey?.startsWith("0x")) {
        throw new Error("MANTLE_PRIVATE_KEY is required for swap execution");
    }
    const chain = resolveMantleChain(chainId);
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    return createWalletClient({
        account,
        chain,
        transport: http(getDefaultRpcUrl(chainId)),
    });
}

export function getDemoWalletAddress(chainId = getDefaultChainId()): Address | null {
    const privateKey = process.env.MANTLE_PRIVATE_KEY;
    if (!privateKey?.startsWith("0x")) {
        return null;
    }
    return privateKeyToAccount(privateKey as `0x${string}`).address;
}
