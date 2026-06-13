#!/usr/bin/env node
/**
 * Step 0 go/no-go gate recorder. Run before Mantle plugin work or after env changes.
 *
 * Usage:
 *   ZERO_EX_API_KEY=... node scripts/mantle/gate-check.mjs
 *   node scripts/mantle/gate-check.mjs --write-docs   # append results to gate log file
 */
import { writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(__dirname, "../../docs/mantle-gate-results.md");

const SEPOLIA_WMNT = "0x19f5557E23e9914A18239990f6C70D68FDF0deD5";
const MAINNET_USDC = "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9";
const MAINNET_WMNT = "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8";

async function probe0x(chainId, sellToken, buyToken, sellAmount) {
    const apiKey = process.env.ZERO_EX_API_KEY;
    const params = new URLSearchParams({
        chainId: String(chainId),
        sellToken,
        buyToken,
        sellAmount,
    });
    const headers = {
        Accept: "application/json",
        "0x-version": "v2",
        ...(apiKey ? { "0x-api-key": apiKey } : {}),
    };
    const res = await fetch(
        `https://api.0x.org/swap/permit2/price?${params}`,
        { headers },
    );
    let body = null;
    try {
        body = await res.json();
    } catch {
        body = { parseError: true };
    }
    return { status: res.status, ok: res.ok, body };
}

async function main() {
    const timestamp = new Date().toISOString();
    const results = [];

    const sepolia = await probe0x(5003, SEPOLIA_WMNT, SEPOLIA_WMNT, "1000000000000000");
    results.push({
        gate: "A — 0x Mantle Sepolia (5003)",
        pass: sepolia.ok && sepolia.body?.buyAmount,
        status: sepolia.status,
        note: sepolia.ok
            ? "Quote returned buyAmount"
            : sepolia.status === 401
              ? "Auth required (endpoint reachable)"
              : JSON.stringify(sepolia.body).slice(0, 200),
    });

    const mainnet = await probe0x(5000, MAINNET_USDC, MAINNET_WMNT, "1000000");
    results.push({
        gate: "A — 0x Mantle mainnet (5000)",
        pass: mainnet.ok && mainnet.body?.buyAmount,
        status: mainnet.status,
        note: mainnet.ok
            ? "Quote returned buyAmount"
            : mainnet.status === 401
              ? "Auth required (endpoint reachable)"
              : JSON.stringify(mainnet.body).slice(0, 200),
    });

    const sepoliaPass = results[0].pass;
    const mainnetPass = results[1].pass;
    let decision = "UNDECIDED";
    if (sepoliaPass) {
        decision = "PRIMARY_CHAIN=5003 (Mantle Sepolia)";
    } else if (mainnetPass) {
        decision = "PRIMARY_CHAIN=5000 (Mantle mainnet)";
    } else if (!process.env.ZERO_EX_API_KEY) {
        decision =
            "PRIMARY_CHAIN=5000 (default; re-run with ZERO_EX_API_KEY to confirm quotes)";
    } else {
        decision = "BLOCKED — no working 0x path; consider Gate A fallback 2/3";
    }

    const report = [
        `# Mantle Gate Check — ${timestamp}`,
        "",
        "| Gate | HTTP | Pass | Note |",
        "|------|------|------|------|",
        ...results.map(
            (r) =>
                `| ${r.gate} | ${r.status} | ${r.pass ? "yes" : "no"} | ${r.note} |`,
        ),
        "",
        `**Locked decision:** ${decision}`,
        "",
        "**Gate B (Etherspot):** not probed in CI — client uses injected EOA fallback per `docs/MANTLE_HACKATHON.md`.",
        "",
        "**Gate C tokens:** Sepolia WMNT `0x19f5…deD5`; mainnet USDC/WMNT in `plugin-mantle-dex/src/config/tokens.ts`.",
        "",
        "**Signing MVP:** server `MANTLE_PRIVATE_KEY` (demo funds only).",
        "",
    ].join("\n");

    console.log(report);

    if (process.argv.includes("--write-docs")) {
        appendFileSync(LOG_PATH, `\n${report}\n`);
        console.log(`Appended to ${LOG_PATH}`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
