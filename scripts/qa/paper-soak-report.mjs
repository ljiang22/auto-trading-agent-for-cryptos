#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * §8.10 — Aggregate the per-day output of `paper-soak-runner.mjs` into a
 * Markdown report (Sharpe, max DD, divergence vs shadow). Reads from
 * `./paper-soak-results/` by default.
 *
 * Usage:
 *   node scripts/qa/paper-soak-report.mjs --in=./paper-soak-results --out=./report.md
 */

import fs from "node:fs/promises";
import path from "node:path";

function parseArgs() {
    const out = { in: "./paper-soak-results", out: "./paper-soak-report.md" };
    for (let i = 2; i < process.argv.length; i++) {
        const a = process.argv[i];
        if (a.startsWith("--in=")) out.in = a.slice(5);
        else if (a.startsWith("--out=")) out.out = a.slice(6);
    }
    return out;
}

async function readDays(dir) {
    const files = await fs.readdir(dir).catch(() => []);
    const dayFiles = files.filter((f) => /^day-\d+\.json$/.test(f)).sort();
    const days = [];
    for (const f of dayFiles) {
        const raw = await fs.readFile(path.join(dir, f), "utf8");
        days.push(JSON.parse(raw));
    }
    return days;
}

function mean(arr) {
    return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function stdev(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    const v = arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
    return Math.sqrt(v);
}

function maxDrawdown(cumulative) {
    let peak = -Infinity;
    let maxDd = 0;
    for (const v of cumulative) {
        peak = Math.max(peak, v);
        const dd = peak - v;
        if (dd > maxDd) maxDd = dd;
    }
    return maxDd;
}

async function main() {
    const args = parseArgs();
    const days = await readDays(args.in);
    if (days.length === 0) {
        console.error(`No day-NN.json files found in ${args.in}`);
        process.exit(1);
    }
    const pnls = days.map((d) => Number(d.pnl_usd ?? 0));
    const cumulative = pnls.reduce((acc, v) => {
        acc.push((acc[acc.length - 1] ?? 0) + v);
        return acc;
    }, []);
    const totalPnl = cumulative.length ? cumulative[cumulative.length - 1] : 0;
    const dailyMean = mean(pnls);
    const dailyStdev = stdev(pnls);
    const sharpe = dailyStdev > 0 ? (dailyMean / dailyStdev) * Math.sqrt(252) : 0;
    const maxDd = maxDrawdown(cumulative);

    const ordersPlaced = days.reduce((a, d) => a + Number(d.orders_placed ?? 0), 0);
    const unknownStates = days.reduce(
        (a, d) => a + Number(d.terminal_states?.unknown ?? 0),
        0,
    );

    const lines = [
        `# Paper-soak report`,
        ``,
        `Days run: **${days.length}**`,
        ``,
        `| Metric | Value |`,
        `|---|---|`,
        `| Total PnL (USD) | $${totalPnl.toFixed(2)} |`,
        `| Daily mean PnL (USD) | $${dailyMean.toFixed(2)} |`,
        `| Daily stdev PnL (USD) | $${dailyStdev.toFixed(2)} |`,
        `| Sharpe (annualized) | ${sharpe.toFixed(2)} |`,
        `| Max drawdown (USD) | $${maxDd.toFixed(2)} |`,
        `| Orders placed | ${ordersPlaced} |`,
        `| Unknown-state outcomes | ${unknownStates} |`,
        ``,
        `## Per-day breakdown`,
        ``,
        `| Day | Ticks | Signals | Orders | PnL |`,
        `|----:|------:|--------:|-------:|----:|`,
        ...days.map(
            (d) =>
                `| ${d.day} | ${d.ticks_run} | ${d.signals_processed} | ${d.orders_placed} | $${Number(d.pnl_usd ?? 0).toFixed(2)} |`,
        ),
    ];

    await fs.writeFile(args.out, lines.join("\n"));
    console.log(`Report written to ${args.out}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(2);
});
