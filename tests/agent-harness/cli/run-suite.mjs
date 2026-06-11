#!/usr/bin/env node
/**
 * CLI entry for the production-ready agent test harness.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_AGENT_BASE_URL } from "../lib/constants.mjs";
import { loadSuite, runSuite } from "../lib/runner.mjs";

const LIVE_STAKE_TAGS = new Set(["live", "write_stake"]);

const DEFAULT_AUTH_URL = "https://api.sentiedge.ai/api";
const DEFAULT_AGENT_URL = process.env.AGENT_TEST_AGENT_URL || DEFAULT_AGENT_BASE_URL;

function parseArgs(argv) {
    const args = {
        suitePath: null,
        authUrl: process.env.AGENT_TEST_AUTH_URL || DEFAULT_AUTH_URL,
        agentUrl: process.env.AGENT_TEST_AGENT_URL || DEFAULT_AGENT_URL,
        email: process.env.AGENT_TEST_EMAIL || null,
        password: process.env.AGENT_TEST_PASSWORD || null,
        agentId: process.env.AGENT_TEST_AGENT_ID || null,
        agentName: process.env.AGENT_TEST_AGENT_NAME || null,
        outDir: null,
        filterTags: null,
        filterIds: null,
        concurrency: 1,
        dryRun: false,
        confirmLive: false,
        approvalTemplatesPath: null,
    };

    for (let i = 0; i < argv.length; i += 1) {
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
            case "--dry-run":
                args.dryRun = true;
                break;
            case "--confirm-live":
                args.confirmLive = true;
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
    console.log(`Usage:
  node tests/agent-harness/cli/run-suite.mjs --suite <path> [options]

Required:
  --suite PATH          JSON suite file

Auth (env or flags):
  --email EMAIL         AGENT_TEST_EMAIL
  --password PASS       AGENT_TEST_PASSWORD
  --auth-url URL        Django API base (default: ${DEFAULT_AUTH_URL})
  --agent-url URL       Agent API base (default: AGENT_TEST_AGENT_URL or ${DEFAULT_AGENT_URL})

Target:
  --agent-id UUID       AGENT_TEST_AGENT_ID
  --agent-name NAME     AGENT_TEST_AGENT_NAME (e.g. CryptoTrader)

Run control:
  --filter-tags a,b     Run cases with any listed tag
  --filter-ids 1,2,3    Run specific case ids
  --concurrency N       Parallel cases (default: 1)
  --confirm-live        Required when suite cases include live/write_stake tags
  --approval-json PATH  CEX/task-chain approval templates
  --out-dir PATH        Report directory (default: tests/agent-harness/runs/<timestamp>)
  --dry-run             Validate suite only

Examples:
  AGENT_TEST_EMAIL=u@example.com AGENT_TEST_PASSWORD=secret \\
    AGENT_TEST_AGENT_URL=https://agent.sentiedge.ai \\
    node tests/agent-harness/cli/run-suite.mjs \\
      --suite tests/agent-harness/suites/example.general.json \\
      --agent-name CryptoTrader
`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (!args.suitePath) {
        console.error("Missing --suite");
        printHelp();
        process.exit(1);
    }

    if (!args.dryRun && (!args.email?.trim() || !args.password?.trim())) {
        console.error(
            "Missing credentials. Set --email/--password or AGENT_TEST_EMAIL / AGENT_TEST_PASSWORD.",
        );
        process.exit(1);
    }

    const suite = await loadSuite(args.suitePath);
    const requiresLiveConfirm = suite.cases.some((c) =>
        (c.tags || []).some((tag) => LIVE_STAKE_TAGS.has(String(tag).toLowerCase())),
    );
    if (!args.dryRun && requiresLiveConfirm) {
        const liveOk =
            args.confirmLive || process.env.AGENT_TEST_LIVE_OK === "1";
        if (!liveOk) {
            console.error(
                "Suite includes live/write_stake cases. Refusing run without --confirm-live or AGENT_TEST_LIVE_OK=1.",
            );
            process.exit(1);
        }
        console.warn(
            "\n⚠️  Suite includes live trading cases — real funds may be spent.\n",
        );
    }

    const outDir =
        args.outDir ||
        path.join(
            path.dirname(fileURLToPath(import.meta.url)),
            "..",
            "runs",
            new Date().toISOString().replace(/[:.]/g, "-"),
        );

    await runSuite({
        suitePath: args.suitePath,
        authBaseUrl: args.authUrl,
        agentBaseUrl: args.agentUrl,
        email: args.email?.trim() || "",
        password: args.password?.trim() || "",
        agentId: args.agentId,
        agentName: args.agentName,
        outDir,
        filterTags: args.filterTags,
        filterIds: args.filterIds,
        concurrency: args.concurrency,
        dryRun: args.dryRun,
        approvalTemplatesPath: args.approvalTemplatesPath,
    });
}

main().catch((err) => {
    console.error(`Suite run failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
