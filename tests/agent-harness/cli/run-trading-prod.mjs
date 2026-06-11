#!/usr/bin/env node
/**
 * Production trading matrix runner: suite → CloudWatch harvest → analysis.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_AGENT_BASE_URL } from "../lib/constants.mjs";
import { runSuite, loadSuite } from "../lib/runner.mjs";

const DEFAULT_AUTH_URL = "https://api.sentiedge.ai/api";
const DEFAULT_SUITE =
    "tests/agent-harness/suites/trading-prod/trading-prod.full.json";
const SCRIPTS = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../scripts/qa",
);

function parseArgs(argv) {
    const args = {
        suitePath: DEFAULT_SUITE,
        authUrl: process.env.AGENT_TEST_AUTH_URL || DEFAULT_AUTH_URL,
        // Production suite: do not fall back to QUESTION_RUNNER_BASE_URL (local dev only).
        agentUrl:
            process.env.AGENT_TEST_AGENT_URL || DEFAULT_AGENT_BASE_URL,
        email: process.env.AGENT_TEST_EMAIL || null,
        password: process.env.AGENT_TEST_PASSWORD || null,
        agentId: process.env.AGENT_TEST_AGENT_ID || null,
        agentName: process.env.AGENT_TEST_AGENT_NAME || "CryptoTrader",
        outDir: null,
        filterTags: null,
        filterIds: null,
        concurrency: 1,
        dryRun: false,
        skipHarvest: false,
        skipAnalyze: false,
        confirmLive: false,
        approvalTemplatesPath: null,
        skipMarketFetch: false,
        marketMidOverride: null,
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case "--suite":
                args.suitePath = argv[++i];
                break;
            case "--auth-url":
                args.authUrl = argv[++i];
                break;
            case "--agent-url":
                args.agentUrl = argv[++i];
                break;
            case "--email":
                args.email = argv[++i];
                break;
            case "--password":
                args.password = argv[++i];
                break;
            case "--agent-id":
                args.agentId = argv[++i];
                break;
            case "--agent-name":
                args.agentName = argv[++i];
                break;
            case "--out-dir":
                args.outDir = argv[++i];
                break;
            case "--filter-tags":
                args.filterTags = argv[++i];
                break;
            case "--filter-ids":
                args.filterIds = argv[++i];
                break;
            case "--concurrency":
                args.concurrency = Number.parseInt(argv[++i], 10) || 1;
                break;
            case "--approval-json":
                args.approvalTemplatesPath = argv[++i];
                break;
            case "--confirm-live":
                args.confirmLive = true;
                break;
            case "--dry-run":
                args.dryRun = true;
                break;
            case "--skip-harvest":
                args.skipHarvest = true;
                break;
            case "--skip-analyze":
                args.skipAnalyze = true;
                break;
            case "--skip-market-fetch":
                args.skipMarketFetch = true;
                break;
            case "--market-mid":
                args.marketMidOverride = Number.parseFloat(argv[++i]);
                break;
            case "-h":
            case "--help":
                printHelp();
                process.exit(0);
                break;
            default:
                break;
        }
    }
    return args;
}

function printHelp() {
    console.log(`Production trading matrix (LIVE ~6 USDT — real funds).

Usage:
  node tests/agent-harness/cli/run-trading-prod.mjs [options]

Options:
  --suite PATH          Default: ${DEFAULT_SUITE}
  --email / --password  Or AGENT_TEST_EMAIL / AGENT_TEST_PASSWORD
  --agent-url           Default: ${DEFAULT_AGENT_BASE_URL}
  --filter-tags         e.g. read_only,spot,margin,risk_deny
  --confirm-live        Required unless AGENT_TEST_LIVE_OK=1 (live funds)
  --approval-json PATH  CEX approval templates override
  --skip-harvest        Skip CloudWatch audit pull
  --skip-analyze        Skip post-run analysis
  --skip-market-fetch   Use static REFERENCE_BTC_PRICE for limit/stop fixtures
  --market-mid N        Override BTC-USDT mid (skips fetch; ignored with --skip-market-fetch)
  --dry-run             Validate suite only
`);
}

function runNodeScript(script, scriptArgs) {
    const envFile = path.resolve(process.cwd(), ".env");
    return new Promise((resolve, reject) => {
        const child = spawn("node", ["--env-file", envFile, script, ...scriptArgs], {
            stdio: "inherit",
            cwd: process.cwd(),
        });
        child.on("error", (err) => {
            reject(err);
        });
        child.on("exit", (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${path.basename(script)} exited ${code}`));
            }
        });
    });
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const password = args.password?.trim();

    if (!args.dryRun && (!args.email?.trim() || !password)) {
        console.error(
            "Missing credentials. Set AGENT_TEST_EMAIL / AGENT_TEST_PASSWORD or --email/--password.",
        );
        process.exit(1);
    }

    const outDir =
        args.outDir ||
        path.join(
            path.dirname(fileURLToPath(import.meta.url)),
            "..",
            "runs",
            `trading-prod-${new Date().toISOString().replace(/[:.]/g, "-")}`,
        );

    if (args.dryRun) {
        const suite = await loadSuite(args.suitePath);
        console.log(
            `[dry-run] suite=${suite.name} cases=${suite.cases.length} roomStrategy=${suite.defaults?.roomStrategy}`,
        );
        process.exit(0);
    }

    const liveOk =
        args.confirmLive || process.env.AGENT_TEST_LIVE_OK === "1";
    if (!liveOk) {
        console.error(
            "Refusing live trading run without --confirm-live or AGENT_TEST_LIVE_OK=1.",
        );
        process.exit(1);
    }

    console.warn(
        "\n⚠️  LIVE trading suite — writes use real funds (~6 USDT per order case).\n",
    );

    const concurrency = Math.min(1, Math.max(1, args.concurrency));

    const result = await runSuite({
        suitePath: args.suitePath,
        authBaseUrl: args.authUrl,
        agentBaseUrl: args.agentUrl,
        email: args.email.trim(),
        password,
        agentId: args.agentId,
        agentName: args.agentName,
        outDir,
        filterTags: args.filterTags,
        filterIds: args.filterIds,
        concurrency,
        runTeardown: true,
        failFastAuthProbe: true,
        approvalTemplatesPath: args.approvalTemplatesPath,
        skipMarketFetch: args.skipMarketFetch,
        marketMidOverride: args.marketMidOverride,
    });

    const runDir = result.outDir || outDir;
    let postRunFailed = false;

    if (!args.skipHarvest) {
        try {
            await runNodeScript(path.join(SCRIPTS, "harvest-cw-trading-audit.mjs"), [
                "--run-dir",
                runDir,
            ]);
        } catch (err) {
            postRunFailed = true;
            console.warn(`[run-trading-prod] harvest skipped/failed: ${err.message}`);
        }
    }

    if (!args.skipAnalyze) {
        try {
            await runNodeScript(path.join(SCRIPTS, "analyze-trading-suite.mjs"), [
                "--run-dir",
                runDir,
            ]);
        } catch (err) {
            postRunFailed = true;
            console.warn(`[run-trading-prod] analyze failed: ${err.message}`);
        }
    }

    console.log(`\n[run-trading-prod] artifacts: ${runDir}`);

    if (postRunFailed) {
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error(`Trading prod run failed: ${err.message}`);
    process.exit(1);
});
