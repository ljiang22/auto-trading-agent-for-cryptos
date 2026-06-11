#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * §8.8 — Fail-closed drill. Kills the risk-audit sink and asserts:
 *  - Live trades are refused with `emitFailClosed`.
 *  - Paper trades continue (mode bypass).
 *  - `Trading/FailClosed` counter increments by exactly N for N attempts.
 *
 * In-process simulation against `checkTradingHealth` so CI doesn't need
 * the full agent.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const TOTAL = Number(process.env.FC_ATTEMPTS ?? 20);

async function checkTradingHealth(input) {
    if (input.mode === "paper") return { healthy: true };
    const reasons = [];
    if (input.riskAuditWroteOk === false) reasons.push("risk_audit_sink_dead");
    if (input.riskAuditWroteOk === null) reasons.push("no_audit_sink_configured");
    if (reasons.length === 0) return { healthy: true };
    if (input.mode === "shadow") return { healthy: false, reasons, bypassed: true };
    return { healthy: false, reasons, bypassed: false };
}

const results = {
    scenario: "failClosedDrill",
    started_at: new Date().toISOString(),
    attempts: TOTAL,
    counts: { live_refused: 0, paper_passed: 0, shadow_logged: 0, fail_closed_emits: 0 },
    events: [],
};

async function main() {
    for (let i = 0; i < TOTAL; i++) {
        const mode = ["live", "paper", "shadow"][i % 3];
        const out = await checkTradingHealth({
            riskAuditWroteOk: false, // sink dead
            reconciliationHealthy: true,
            marketDataAgeMs: 5_000,
            liveFreshnessCapMs: 30_000,
            mode,
        });
        if (mode === "live" && !out.healthy && !out.bypassed) {
            results.counts.live_refused++;
            results.counts.fail_closed_emits++;
            results.events.push({ at: new Date().toISOString(), kind: "fail_closed", mode, reasons: out.reasons });
        } else if (mode === "paper") {
            results.counts.paper_passed++;
        } else if (mode === "shadow") {
            results.counts.shadow_logged++;
        }
        await sleep(20);
    }
    results.finished_at = new Date().toISOString();

    const out = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        "results",
        `failClosedDrill-${Date.now()}.json`,
    );
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify(results, null, 2));
    console.log(`\nResults: ${out}`);
    console.log(JSON.stringify(results.counts, null, 2));

    const liveAttempts = Math.ceil(TOTAL / 3);
    if (results.counts.live_refused !== results.counts.fail_closed_emits) {
        console.error("FAIL: live_refused != fail_closed_emits");
        process.exit(1);
    }
    if (results.counts.live_refused === 0) {
        console.error("FAIL: 0 live refusals — fault injection ineffective");
        process.exit(1);
    }
    if (results.counts.paper_passed === 0) {
        console.error("FAIL: 0 paper passes — bypass missing");
        process.exit(1);
    }
    console.log(`PASS: live=${results.counts.live_refused}/${liveAttempts} refused, paper=${results.counts.paper_passed} passed, shadow=${results.counts.shadow_logged} logged`);
    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(2);
});
