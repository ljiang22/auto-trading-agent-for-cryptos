#!/usr/bin/env node
/**
 * Deploy StrategyAuditLog to Mantle (mainnet 5000 or Sepolia 5003).
 * Requires: MANTLE_PRIVATE_KEY. Compiles via `forge build` when artifact missing.
 */
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const ARTIFACT_PATH = join(
    ROOT,
    "contracts/out/StrategyAuditLog.sol/StrategyAuditLog.json",
);

const CHAIN_ID = Number.parseInt(process.env.MANTLE_CHAIN_ID ?? "5003", 10);
const RPC_URL =
    process.env.MANTLE_RPC_URL ??
    (CHAIN_ID === 5003
        ? "https://rpc.sepolia.mantle.xyz"
        : "https://rpc.mantle.xyz");

const EXPLORER =
    CHAIN_ID === 5003
        ? "https://explorer.sepolia.mantle.xyz"
        : "https://explorer.mantle.xyz";

const mantleChain = {
    id: CHAIN_ID,
    name: CHAIN_ID === 5003 ? "Mantle Sepolia" : "Mantle",
    nativeCurrency: { name: "MNT", symbol: "MNT", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
};

const STRATEGY_AUDIT_LOG_ABI = [
    {
        type: "function",
        name: "logIntent",
        inputs: [
            { name: "intentHash", type: "bytes32" },
            { name: "user", type: "address" },
            { name: "action", type: "string" },
            { name: "tokenIn", type: "address" },
            { name: "tokenOut", type: "address" },
            { name: "amountIn", type: "uint256" },
            { name: "maxSlippageBps", type: "uint16" },
            { name: "riskScore", type: "uint8" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "event",
        name: "IntentLogged",
        inputs: [
            { name: "intentHash", type: "bytes32", indexed: true },
            { name: "user", type: "address", indexed: true },
            { name: "action", type: "string", indexed: false },
            { name: "tokenIn", type: "address", indexed: false },
            { name: "tokenOut", type: "address", indexed: false },
            { name: "amountIn", type: "uint256", indexed: false },
            { name: "maxSlippageBps", type: "uint16", indexed: false },
            { name: "riskScore", type: "uint8", indexed: false },
            { name: "timestamp", type: "uint256", indexed: false },
        ],
        anonymous: false,
    },
];

function ensureArtifact() {
    if (existsSync(ARTIFACT_PATH)) {
        return;
    }
    console.log("Artifact missing — running `forge build`…");
    execSync("forge build", { cwd: ROOT, stdio: "inherit" });
    if (!existsSync(ARTIFACT_PATH)) {
        throw new Error(`Build did not produce ${ARTIFACT_PATH}`);
    }
}

async function main() {
    const pk = process.env.MANTLE_PRIVATE_KEY;
    if (!pk?.startsWith("0x")) {
        throw new Error("MANTLE_PRIVATE_KEY required (0x-prefixed hex)");
    }

    ensureArtifact();
    const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8"));
    const bytecode = artifact.bytecode?.object;
    if (!bytecode || bytecode === "0x") {
        throw new Error("Empty bytecode in artifact");
    }

    const account = privateKeyToAccount(pk);
    const publicClient = createPublicClient({
        chain: mantleChain,
        transport: http(RPC_URL),
    });
    const walletClient = createWalletClient({
        account,
        chain: mantleChain,
        transport: http(RPC_URL),
    });

    const hash = await walletClient.deployContract({
        abi: STRATEGY_AUDIT_LOG_ABI,
        bytecode,
        account,
        chain: mantleChain,
    });

    console.log(`Deploy tx: ${EXPLORER}/tx/${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const address = receipt.contractAddress;
    if (!address) {
        throw new Error("Deploy receipt missing contractAddress");
    }

    console.log(`StrategyAuditLog deployed: ${address}`);
    console.log(`Verify: ${EXPLORER}/address/${address}`);
    console.log(`\nAdd to .env:\nMANTLE_AUDIT_LOG_ADDRESS=${address}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
