/**
 * Sentiment pipeline timing (no LLM): S3/cache sentiment fetches, date filter,
 * CoinGlass OHLC, chart HTML + disk write.
 *
 * Usage (from repo root, after pnpm build in packages):
 *   node --env-file=.env scripts/sentiment-pipeline-perf.mjs [--symbol BTC] [--months 6]
 *
 * Full workflow including LLM narratives: start the agent with SENTIMENT_PERF=1
 * and watch stdout for [Sentiment_Analysis][perf] lines.
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginDist = path.join(
    __dirname,
    "..",
    "packages",
    "plugin-sentiscore",
    "dist",
    "index.js"
);

function parseArgs(argv) {
    let symbol = "BTC";
    let monthsBack = 6;
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === "--symbol" && argv[i + 1]) {
            symbol = argv[++i];
        } else if (argv[i] === "--months" && argv[i + 1]) {
            monthsBack = Number(argv[++i]);
        }
    }
    return { symbol, monthsBack };
}

const { symbol, monthsBack } = parseArgs(process.argv);

const { runPipelineSimulation } = await import(pathToFileURL(pluginDist).href);

const result = await runPipelineSimulation({
    symbol,
    monthsBack: Number.isFinite(monthsBack) && monthsBack > 0 ? monthsBack : 6,
});

console.log("\n=== Sentiment pipeline simulation (no LLM) ===\n");
console.log(`Symbol: ${result.symbol}`);
console.log(`Range:  ${result.range.startDate} .. ${result.range.endDate}`);
console.log(`Note:   ${result.note}\n`);
console.log("Timings:");
for (const row of result.timings) {
    const extra = row.detail ? `  (${row.detail})` : "";
    console.log(`  ${String(row.ms).padStart(8)} ms  ${row.step}${extra}`);
}
console.log("\nNews:", result.news);
console.log("X:   ", result.x);
console.log("Chart:", result.chart);
