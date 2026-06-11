#!/usr/bin/env node
/**
 * Smoke-test S3 sentiment fetch via the same handlers as the agent plugin.
 *
 * Usage (from repo root `senti-agent-0428/`):
 *   pnpm smoke:sentiscore-s3
 *   pnpm smoke:sentiscore-s3 ETH
 *
 * Requires in .env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (optional on AWS with IAM role),
 * optional SENTISCORE_S3_BUCKET (default sentiscoredata-new), SENTISCORE_S3_REGION (default us-east-2).
 */
import { actions } from "../packages/plugin-sentiscore/dist/index.js";

const symbol = (process.argv[2] || "BTC").toUpperCase();
const req = new Request("http://localhost/smoke");

async function printBlock(label, res) {
    const status = res.status;
    let body;
    try {
        body = await res.json();
    } catch (e) {
        console.error(`${label}: failed to parse JSON`, e);
        return;
    }
    console.log(`\n--- ${label} (HTTP ${status}) ---`);
    if (body.error) {
        console.error("Error:", typeof body.error === "string" ? body.error : body.error);
        return;
    }
    const scores = body.sentiScores;
    if (!Array.isArray(scores)) {
        console.log("Unexpected body:", Object.keys(body));
        return;
    }
    console.log("Symbol:", body.symbol, "| Points:", scores.length, "| Dates cached:", body.dates?.length);
    if (scores.length === 0) {
        return;
    }
    const sample = scores[scores.length - 1];
    console.log("Latest sample:", {
        time: sample.time,
        value: sample.value,
        negative: sample.negative,
        neutral: sample.neutral,
        positive: sample.positive,
        total: sample.total,
    });
    const oldest = scores[0];
    console.log("Oldest sample:", {
        time: oldest.time,
        value: oldest.value,
    });
}

console.log("Using bucket:", process.env.SENTISCORE_S3_BUCKET || "sentiscoredata-new");
console.log("Using region:", process.env.SENTISCORE_S3_REGION || "us-east-2");
console.log("CWD (cache dir):", process.cwd());

try {
    const [newsRes, xRes] = await Promise.all([
        actions.GET_sentiment_score(req, { params: { symbol } }),
        actions.GET_X_sentiment_score(req, { params: { symbol } }),
    ]);
    await printBlock("Crypto news (GET_sentiment_score)", newsRes);
    await printBlock("X / Twitter (GET_X_sentiment_score)", xRes);
    console.log("\nDone.");
} catch (e) {
    console.error("Smoke test failed:", e);
    process.exit(1);
}
