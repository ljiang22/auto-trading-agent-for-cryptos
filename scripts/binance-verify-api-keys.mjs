/**
 * One-off Binance key check: GET /api/v3/account using @binance/common signing (getSignature + buildQueryString).
 *
 * 1. Paste API_KEY and API_SECRET below. For spot testnet, set USE_TESTNET to true.
 * 2. From repo root: pnpm install && node scripts/binance-verify-api-keys.mjs
 *
 * Requires: @binance/common (root devDependencies). Do not commit real keys.
 */

import {
    buildQueryString,
    getSignature,
    getTimestamp,
    SPOT_REST_API_PROD_URL,
    SPOT_REST_API_TESTNET_URL,
} from "@binance/common";
import { writeFile } from "node:fs/promises";

// --- paste credentials here ---
const API_KEY = "nkD566k9AQiKfA0dyxFOBLBc0V9bHGBY0VwB0yWci7bySSRQtOq7tjYsxbkugHS1";
const API_SECRET = "hDnJgL0F4pkWhNn9YGX6zUbByZiIEDb22jfk8JuUVwMwXq0tQbuLtPnYnTuzm0Rl";

/** Use testnet URL + testnet API keys when true */
const USE_TESTNET = false;

const BASE_URL = USE_TESTNET ? SPOT_REST_API_TESTNET_URL : SPOT_REST_API_PROD_URL;
const RECV_WINDOW_MS = 10_000;
const OUTPUT_PATH = new URL("./binance-account-response.json", import.meta.url);

async function main() {
    if (
        !API_KEY ||
        API_KEY === "YOUR_BINANCE_API_KEY" ||
        !API_SECRET ||
        API_SECRET === "YOUR_BINANCE_API_SECRET"
    ) {
        console.error("Edit this file and set API_KEY and API_SECRET at the top.");
        process.exit(1);
    }

    const queryParams = {
        recvWindow: RECV_WINDOW_MS,
        timestamp: getTimestamp(),
        omitZeroBalances: true,
    };
    const signConfig = { apiSecret: API_SECRET };
    const signature = getSignature(signConfig, queryParams, {});
    const qs = buildQueryString({ ...queryParams, signature });
    const url = `${BASE_URL}/api/v3/account?${qs}`;

    const res = await fetch(url, {
        method: "GET",
        headers: {
            "X-MBX-APIKEY": API_KEY,
            Accept: "application/json",
        },
    });

    const text = await res.text();
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        body = text;
    }

    if (!res.ok) {
        console.error("HTTP", res.status, res.statusText);
        console.error(typeof body === "string" ? body : JSON.stringify(body, null, 2));
        process.exit(1);
    }

    if (
        typeof body === "object" &&
        body !== null &&
        typeof body.code === "number" &&
        body.code < 0
    ) {
        console.error("Binance error:", body.code, body.msg);
        process.exit(1);
    }

    console.log(
        `OK — keys work with @binance/common signing (${USE_TESTNET ? "testnet" : "production"}).\n`
    );

    const balances = body.balances ?? [];
    const nonzero = balances.filter((b) => {
        const free = Number(b.free ?? 0);
        const locked = Number(b.locked ?? 0);
        return free > 0 || locked > 0;
    });

    if (nonzero.length === 0) {
        console.log("No non-zero spot balances (account is still valid).");
    } else {
        console.log("Non-zero spot balances:");
        for (const b of nonzero) {
            console.log(`  ${b.asset}: free=${b.free} locked=${b.locked}`);
        }
    }

    console.log("\nFull JSON (truncate if you share logs):");
    console.log(JSON.stringify(body, null, 2));
    await writeFile(OUTPUT_PATH, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    console.log(`\nWrote response JSON to ${OUTPUT_PATH.pathname}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
