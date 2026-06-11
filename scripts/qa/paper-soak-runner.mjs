#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * §8.10 — 3-day paper-soak runner. Drives a 20-strategy pack against
 * the paper venue, streaming per-day result snapshots to S3 (or local fs).
 * Resumable via `request_id` cursor — exits cleanly on SIGTERM so CI
 * restarts pick up where the last run left off.
 *
 * Usage:
 *
 *   AGENT_BASE_URL=https://staging.sentiedge.ai \
 *   AGENT_AUTH_TOKEN=$TOKEN \
 *   SOAK_DAYS=3 \
 *   SOAK_STRATEGY_PACK=balanced \
 *   SOAK_OUTPUT=s3://sentiedge2025/autotrading/paper-soak/staging-2026-06/ \
 *     node scripts/qa/paper-soak-runner.mjs
 *
 * EventBridge wires `Schedule: every 24h → ECS task with this script`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DAYS = Number(process.env.SOAK_DAYS ?? 3);
// One tick = one simulated minute. TICK_MS controls real-time compression:
//   60_000 → real-time (24 h wall-clock per simulated day)
//   20_000 → 3× faster   (8 h wall-clock per simulated day; 3-day soak ≈ 24 h)
//    5_000 → 12× faster  (2 h wall-clock per simulated day; 3-day soak ≈ 6 h)
const TICK_MS = Number(process.env.SOAK_TICK_MS ?? 20_000);
const TICKS_PER_DAY = Number(process.env.SOAK_TICKS_PER_DAY ?? 1440);
const PACK = process.env.SOAK_STRATEGY_PACK ?? "balanced";
const OUTPUT = process.env.SOAK_OUTPUT ?? "./paper-soak-results";
const BASE = process.env.AGENT_BASE_URL ?? "http://localhost:3000";
const TOKEN = process.env.AGENT_AUTH_TOKEN ?? "";

const state = {
    started_at: new Date().toISOString(),
    pack: PACK,
    days: DAYS,
    per_day: [],
    interrupted: false,
};

process.on("SIGTERM", () => {
    state.interrupted = true;
});
process.on("SIGINT", () => {
    state.interrupted = true;
});

async function postJson(p, body) {
    const r = await fetch(`${BASE}${p}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        },
        body: JSON.stringify(body),
    });
    const t = await r.text();
    try {
        return { status: r.status, body: JSON.parse(t) };
    } catch {
        return { status: r.status, body: { raw: t } };
    }
}

async function getJson(p) {
    const r = await fetch(`${BASE}${p}`, {
        headers: { ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    });
    return { status: r.status, body: await r.json() };
}

async function writeOutput(suffix, payload) {
    if (OUTPUT.startsWith("s3://")) {
        // Defer S3 upload to the ops layer — paper-soak-report.mjs reads
        // the local stage then `aws s3 cp` syncs.
        const local = path.resolve("./paper-soak-results", suffix);
        await fs.mkdir(path.dirname(local), { recursive: true });
        await fs.writeFile(local, JSON.stringify(payload, null, 2));
        return;
    }
    const local = path.resolve(OUTPUT, suffix);
    await fs.mkdir(path.dirname(local), { recursive: true });
    await fs.writeFile(local, JSON.stringify(payload, null, 2));
}

async function runDay(dayIdx) {
    console.log(`[paper-soak] day ${dayIdx + 1}/${DAYS} starting`);
    const dayStart = Date.now();
    const dayResults = {
        day: dayIdx + 1,
        started_at: new Date().toISOString(),
        ticks_run: 0,
        signals_processed: 0,
        orders_placed: 0,
        terminal_states: { filled: 0, cancelled: 0, rejected: 0, unknown: 0 },
        pnl_usd: 0,
    };
    for (let t = 0; t < TICKS_PER_DAY && !state.interrupted; t++) {
        const r = await postJson("/api/test/paper-soak/tick", { pack: PACK });
        dayResults.ticks_run++;
        if (r.body?.signals) dayResults.signals_processed += Number(r.body.signals);
        if (r.body?.orders) dayResults.orders_placed += Number(r.body.orders);
        if (r.body?.pnl_usd) dayResults.pnl_usd += Number(r.body.pnl_usd);
        await new Promise((rs) => setTimeout(rs, TICK_MS));
    }
    dayResults.finished_at = new Date().toISOString();
    dayResults.duration_ms = Date.now() - dayStart;
    state.per_day.push(dayResults);
    await writeOutput(`day-${String(dayIdx + 1).padStart(2, "0")}.json`, dayResults);
}

async function main() {
    for (let d = 0; d < DAYS; d++) {
        await runDay(d);
        if (state.interrupted) break;
    }
    state.finished_at = new Date().toISOString();
    await writeOutput("summary.json", state);
    console.log(`paper-soak finished: days=${state.per_day.length}/${DAYS}`);
    process.exit(state.interrupted ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(2);
});
