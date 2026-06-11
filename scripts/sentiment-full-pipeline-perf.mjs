/**
 * Full Sentiment_Analysis: S3/cache + CoinGlass chart + LLM narratives (MEDIUM x2 + LARGE).
 * Prints [Sentiment_Analysis][perf] lines when SENTIMENT_PERF is set (forced to 1 if unset).
 *
 * From repo root (requires built packages: core, adapter-sqlite, plugin-sentiscore):
 *   node --env-file=.env scripts/sentiment-full-pipeline-perf.mjs
 *
 * Optional:
 *   --from 2025-12-01 --to 2026-02-01
 *   --days 45          (default 90 if --from/--to omitted and no --months)
 *   --months 6         (same rolling window as sentiment-pipeline-perf.mjs)
 *   --message "..."    (user message text; default is a natural-language BTC request)
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

if (!process.env.SENTIMENT_PERF?.trim()) {
    process.env.SENTIMENT_PERF = "1";
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

const require = createRequire(import.meta.url);
const Database = require(
    path.join(
        repoRoot,
        "packages/adapter-sqlite/node_modules/better-sqlite3/lib/index.js"
    )
);

const { AgentRuntime, ModelProviderName, stringToUuid } = await import(
    path.join(repoRoot, "packages/core/dist/index.js")
);
const { SqliteDatabaseAdapter } = await import(
    path.join(repoRoot, "packages/adapter-sqlite/dist/index.js")
);
const { actions } = await import(
    path.join(repoRoot, "packages/plugin-sentiscore/dist/index.js")
);

function parseArgs() {
    let from = null;
    let to = null;
    let days = 90;
    let months = null;
    let userMessage = null;
    const a = process.argv;
    for (let i = 2; i < a.length; i++) {
        if (a[i] === "--from" && a[i + 1]) {
            from = a[++i];
        } else if (a[i] === "--to" && a[i + 1]) {
            to = a[++i];
        } else if (a[i] === "--days" && a[i + 1]) {
            days = Number(a[++i]);
        } else if (a[i] === "--months" && a[i + 1]) {
            months = Number(a[++i]);
        } else if (a[i] === "--message" && a[i + 1]) {
            userMessage = a[++i];
        }
    }
    return { from, to, days, months, userMessage };
}

function pad2(n) {
    return String(n).padStart(2, "0");
}

function formatYmd(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function rangeFromDays(days) {
    const end = new Date();
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - days);
    return { start: formatYmd(start), end: formatYmd(end) };
}

/** Match plugin simulation: calendar months back from local "today". */
function rollingRangeMonths(monthsBack) {
    const end = new Date();
    const start = new Date();
    start.setMonth(start.getMonth() - monthsBack);
    return { start: formatYmd(start), end: formatYmd(end) };
}

const cli = parseArgs();
let range;
if (cli.from && cli.to) {
    range = { start: cli.from.slice(0, 10), end: cli.to.slice(0, 10) };
} else if (
    Number.isFinite(cli.months) &&
    cli.months > 0
) {
    range = rollingRangeMonths(cli.months);
} else {
    range = rangeFromDays(
        Number.isFinite(cli.days) && cli.days > 0 ? cli.days : 90,
    );
}

const defaultUserMessage =
    "Perform the sentiment analysis on BTC in the past six months.";
let messageText =
    cli.userMessage?.trim() ||
    process.env.PERF_SENTIMENT_MESSAGE?.trim() ||
    "";
if (!messageText) {
    if (cli.from && cli.to) {
        messageText = `Please give a detailed sentiment analysis for BTC from ${range.start} to ${range.end}.`;
    } else if (Number.isFinite(cli.months) && cli.months > 0) {
        messageText = defaultUserMessage;
    } else {
        messageText = `Please give a detailed sentiment analysis for BTC from ${range.start} to ${range.end}.`;
    }
}

const charPath = path.join(repoRoot, "characters", "CryptoTrader.json");
const rawChar = JSON.parse(fs.readFileSync(charPath, "utf8"));

const provider = rawChar.modelProvider;
if (!Object.values(ModelProviderName).includes(provider)) {
    console.error("Invalid modelProvider in CryptoTrader.json:", provider);
    process.exit(1);
}

const PERF_USER_ID = stringToUuid("perf-user-account");

const character = {
    ...rawChar,
    id: rawChar.id ?? stringToUuid("crypto-trader-perf"),
    plugins: [],
    knowledge: [],
    settings: {
        ...rawChar.settings,
        ragKnowledge: false,
    },
};

const tmpDb = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "sentiment-perf-")),
    "agent.sqlite"
);
const sqlite = new Database(tmpDb);
const adapter = new SqliteDatabaseAdapter(sqlite);

await adapter.init();

await adapter.createAccount({
    id: PERF_USER_ID,
    name: "Perf User",
    username: "perfuser",
    email: "perf@example.com",
    details: { source: "sentiment-full-pipeline-perf" },
});

const runtime = new AgentRuntime({
    token: process.env.PERF_AGENT_TOKEN || "sentiment-perf-token",
    character,
    databaseAdapter: adapter,
    modelProvider: provider,
    actions: [actions.CryptoSentimentAnalysisAndVisualization],
});

await runtime.initialize();

const message = {
    id: stringToUuid("perf-message"),
    userId: PERF_USER_ID,
    agentId: runtime.agentId,
    roomId: stringToUuid("perf-room"),
    content: {
        text: messageText,
    },
    createdAt: Date.now(),
};

const callback = async (content) => {
    const t = content?.text;
    const preview =
        typeof t === "string"
            ? t.replace(/\s+/g, " ").slice(0, 220)
            : String(t);
    console.log("\n[callback] Response preview:", preview, "…");
    return [];
};

console.log("\n=== Full Sentiment_Analysis (data + chart + LLM) ===");
console.log("Date range:", `${range.start} .. ${range.end}`);
console.log("User message:", messageText);
console.log("Model provider:", runtime.modelProvider);
console.log("SENTIMENT_PERF:", process.env.SENTIMENT_PERF);
console.log("");

const wall0 = Date.now();
const ok = await actions.CryptoSentimentAnalysisAndVisualization.handler(
    runtime,
    message,
    undefined,
    {
        from: range.start,
        to: range.end,
        dataRetentionDays: 730,
    },
    callback
);

console.log(
    "\n=== Handler finished ===",
    "success=",
    ok,
    "total_wall_ms=",
    Date.now() - wall0
);

if (typeof adapter.close === "function") {
    await adapter.close();
}
