#!/usr/bin/env node
/**
 * Binance integration suite — runs via agent harness with JWT auth.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_AGENT_BASE_URL } from "../agent-harness/lib/constants.mjs";

const userEmail = process.env.PLUGIN_CEX_TEST_USER_EMAIL || process.env.AGENT_TEST_EMAIL;
const password = process.env.PLUGIN_CEX_TEST_PASSWORD || process.env.AGENT_TEST_PASSWORD;

if (!userEmail || password == null) {
    console.error(
        "Skipping Binance integration suite: set PLUGIN_CEX_TEST_EMAIL (or AGENT_TEST_EMAIL) and PLUGIN_CEX_TEST_PASSWORD (or AGENT_TEST_PASSWORD).",
    );
    process.exit(0);
}

const agentUrl =
    process.env.QUESTION_RUNNER_BASE_URL ||
    process.env.AGENT_TEST_AGENT_URL ||
    DEFAULT_AGENT_BASE_URL;
const authUrl =
    process.env.QUESTION_RUNNER_AUTH_BASE_URL ||
    process.env.AGENT_TEST_AUTH_URL ||
    "https://api.sentiedge.ai/api";
const questionFile =
    process.env.PLUGIN_CEX_BINANCE_QUESTIONS ||
    "tests/questions/binance_action_execution_questions.json";
const approvalFile =
    process.env.PLUGIN_CEX_BINANCE_APPROVALS ||
    "tests/questions/binance_endpoint_approval_templates.json";

const cliPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../agent-harness/cli/run-suite.mjs",
);

const args = [
    cliPath,
    "--suite",
    questionFile,
    "--approval-json",
    approvalFile,
    "--email",
    userEmail,
    "--password",
    password,
    "--auth-url",
    authUrl,
    "--agent-url",
    agentUrl,
];

if (process.env.AGENT_TEST_AGENT_NAME) {
    args.push("--agent-name", process.env.AGENT_TEST_AGENT_NAME);
}
if (process.env.AGENT_TEST_AGENT_ID) {
    args.push("--agent-id", process.env.AGENT_TEST_AGENT_ID);
}

const child = spawn("node", args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
});

child.on("exit", (code) => {
    process.exit(code ?? 1);
});
