#!/usr/bin/env node
/**
 * Pre-agent Mantle swap validation (Step 0 Gate A).
 * Requires: ZERO_EX_API_KEY; MANTLE_PRIVATE_KEY only for live swap (not --quote-only).
 *
 * Usage:
 *   node scripts/mantle/smoke-swap.mjs
 *   node scripts/mantle/smoke-swap.mjs --quote-only
 */
import {
    createPublicClient,
    createWalletClient,
    formatUnits,
    http,
    parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const CHAIN_ID = Number.parseInt(process.env.MANTLE_CHAIN_ID ?? "5000", 10);
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

const TOKENS =
    CHAIN_ID === 5003
        ? {
              sell: "0x19f5557E23e9914A18239990f6C70D68FDF0deD5",
              buy: "0x19f5557E23e9914A18239990f6C70D68FDF0deD5",
              sellDecimals: 18,
              sellAmountHuman: "0.001",
          }
        : {
              sell: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
              buy: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
              sellDecimals: 6,
              sellAmountHuman: "1",
          };

async function fetchQuote(taker, sellAmount) {
    const apiKey = process.env.ZERO_EX_API_KEY;
    if (!apiKey) {
        throw new Error("ZERO_EX_API_KEY is required");
    }
    const params = new URLSearchParams({
        chainId: String(CHAIN_ID),
        sellToken: TOKENS.sell,
        buyToken: TOKENS.buy,
        sellAmount: sellAmount.toString(),
        taker,
        slippagePercentage: "0.01",
    });
    const res = await fetch(
        `https://api.0x.org/swap/permit2/quote?${params}`,
        {
            headers: {
                "0x-api-key": apiKey,
                "0x-version": "v2",
                Accept: "application/json",
            },
        },
    );
    const body = await res.json();
    if (!res.ok) {
        throw new Error(`0x quote ${res.status}: ${JSON.stringify(body)}`);
    }
    return body;
}

async function main() {
    const quoteOnly = process.argv.includes("--quote-only");
    const pk = process.env.MANTLE_PRIVATE_KEY;
    const demoTaker = "0x0000000000000000000000000000000000000001";

    let accountAddress = demoTaker;
    let publicClient;
    let walletClient;

    if (pk?.startsWith("0x")) {
        const account = privateKeyToAccount(pk);
        accountAddress = account.address;
        publicClient = createPublicClient({
            chain: mantleChain,
            transport: http(RPC_URL),
        });
        walletClient = createWalletClient({
            account,
            chain: mantleChain,
            transport: http(RPC_URL),
        });
        const balance = await publicClient.getBalance({
            address: account.address,
        });
        console.log(`Chain ${CHAIN_ID} | wallet ${account.address}`);
        console.log(`MNT balance: ${formatUnits(balance, 18)}`);
    } else if (!quoteOnly) {
        throw new Error("MANTLE_PRIVATE_KEY (0x…) is required for live swap");
    } else {
        console.log(
            `Chain ${CHAIN_ID} | quote-only (no wallet) | taker ${accountAddress}`,
        );
    }

    const sellAmount = parseUnits(
        TOKENS.sellAmountHuman,
        TOKENS.sellDecimals,
    );
    const quote = await fetchQuote(accountAddress, sellAmount);
    console.log("Quote OK:", {
        sellAmount: quote.sellAmount,
        buyAmount: quote.buyAmount,
        route: (quote.sources ?? []).map((s) => s.name).join(" → "),
    });

    if (quoteOnly) {
        console.log("Gate A: quote-only mode — chain path validated.");
        return;
    }

    const tx = quote.transaction;
    if (!tx) {
        throw new Error("Quote missing transaction payload");
    }

    const hash = await walletClient.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: BigInt(tx.value ?? "0"),
        gas: tx.gas ? BigInt(tx.gas) : undefined,
    });
    console.log(`Swap submitted: ${EXPLORER}/tx/${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`Confirmed in block ${receipt.blockNumber}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
