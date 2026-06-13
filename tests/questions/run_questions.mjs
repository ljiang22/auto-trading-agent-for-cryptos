#!/usr/bin/env node
/**
 * Legacy question runner — delegates to tests/agent-harness with JWT auth.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_AGENT_BASE_URL } from "../agent-harness/lib/constants.mjs";
import { legacyQuestionsToSuite, runSuite } from "../agent-harness/lib/runner.mjs";

const DEFAULT_AGENT_URL =
    process.env.QUESTION_RUNNER_BASE_URL ||
    process.env.AGENT_TEST_AGENT_URL ||
    DEFAULT_AGENT_BASE_URL;
const DEFAULT_AUTH_URL =
    process.env.QUESTION_RUNNER_AUTH_BASE_URL ||
    process.env.AGENT_TEST_AUTH_URL ||
    "https://api.sentiedge.ai/api";
const DEFAULT_QUESTIONS_PATH = "tests/questions/test_questions.json";

function parseArgs(argv) {
    const args = {
        agentUrl: DEFAULT_AGENT_URL,
        authUrl: DEFAULT_AUTH_URL,
        questionsPath: DEFAULT_QUESTIONS_PATH,
        agentId: null,
        agentName: null,
        email: process.env.AGENT_TEST_EMAIL || null,
        password: process.env.AGENT_TEST_PASSWORD || null,
        levels: null,
        approvalJsonPath: null,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--base-url") {
            args.agentUrl = argv[++i];
        } else if (arg === "--questions") {
            args.questionsPath = argv[++i];
        } else if (arg === "--agent-id") {
            args.agentId = argv[++i];
        } else if (arg === "--agent-name") {
            args.agentName = argv[++i];
        } else if (arg === "--email") {
            args.email = argv[++i];
        } else if (arg === "--password") {
            args.password = argv[++i];
        } else if (arg === "--auth-base-url") {
            args.authUrl = argv[++i];
        } else if (arg === "--user-email") {
            console.warn(
                "[run_questions] --user-email is deprecated and ignored. Use --email with Django login for production.",
            );
            argv[++i];
        } else if (arg === "--levels") {
            args.levels = argv[++i];
        } else if (arg === "--approval-json") {
            args.approvalJsonPath = argv[++i];
        } else if (arg === "--help" || arg === "-h") {
            printHelp();
            process.exit(0);
        }
    }
    return args;
}

function printHelp() {
    console.log(`Usage:
  node tests/questions/run_questions.mjs [options]

Uses the agent test harness (JWT auth). See tests/agent-harness/README.md.

Options:
  --base-url       Agent URL (QUESTION_RUNNER_BASE_URL, default ${DEFAULT_AGENT_URL})
  --auth-base-url  Django auth URL (default ${DEFAULT_AUTH_URL})
  --questions      Questions JSON path
  --agent-id       Agent UUID
  --agent-name     Agent character name
  --email          Login email (AGENT_TEST_EMAIL)
  --password       Login password (AGENT_TEST_PASSWORD)
  --levels         Comma-separated levels (e.g. 1,2,3)
  --approval-json  CEX approval templates JSON
`);
}

async function loadQuestionsFile(filePath) {
    const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.join(process.cwd(), filePath);
    const raw = await fs.readFile(absolutePath, "utf8");
    return JSON.parse(raw);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (!args.email || args.password == null) {
        console.error(
            "Missing credentials. Set --email/--password or AGENT_TEST_EMAIL / AGENT_TEST_PASSWORD.",
        );
        process.exit(1);
    }

    const questionsFile = await loadQuestionsFile(args.questionsPath);
    const suite = legacyQuestionsToSuite(questionsFile);

    suite.defaults = {
        ...suite.defaults,
        roomStrategy: "perLevel",
        hooks: ["cexAutoApprove", "taskChainAutoApprove"],
        approvalTemplates: args.approvalJsonPath || undefined,
        agentName: args.agentName || suite.defaults?.agentName,
        agentId: args.agentId || suite.defaults?.agentId,
    };

    if (args.levels) {
        const requestedLevels = new Set(
            args.levels
                .split(",")
                .map((level) => Number.parseInt(level.trim(), 10))
                .filter((level) => Number.isFinite(level)),
        );
        suite.cases = suite.cases.filter((c) => requestedLevels.has(c.level));
        if (suite.cases.length === 0) {
            throw new Error(`No questions matched levels: ${args.levels}`);
        }
    }

    await runSuite({
        suite,
        authBaseUrl: args.authUrl,
        agentBaseUrl: args.agentUrl,
        email: args.email,
        password: args.password,
        agentId: args.agentId,
        agentName: args.agentName,
        approvalTemplatesPath: args.approvalJsonPath,
        concurrency: 1,
    });
}

main().catch((error) => {
    console.error(`Failed to run questions: ${error.message}`);
    process.exit(1);
});
