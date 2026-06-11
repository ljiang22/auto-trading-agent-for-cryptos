#!/usr/bin/env node
/**
 * Deterministic-only classifier eval.
 *
 * Exercises the two pieces of the classifier pipeline that DON'T need a
 * running agent + JWT auth:
 *
 *   1. The pre-LLM regex short-circuit in
 *      `packages/core/src/handlers/langGraphPrecheck.ts` (analyzeMessage
 *      node). Same patterns as the source file, kept in sync manually.
 *   2. The CEX bypass intent-shift detector in
 *      `packages/core/src/utils/cexBypassPredicate.ts`. Imported live
 *      from the built dist bundle so the regex is the real one.
 *
 * Goal: produce an objective accuracy report for the deterministic
 * layer on the full 134-question fixture WITHOUT the cost of running
 * the full agent end-to-end. The remaining (non-short-circuit, non-
 * bypass-relevant) questions are reported as "needs_llm" — those still
 * require a real authenticated agent run to verify the LLM classifier.
 *
 * Run with: `node scripts/eval-classifier-static.mjs`
 */

import fs from "node:fs/promises";
import path from "node:path";

const FIXTURES_PATH = "tests/questions/classification_questions.json";

// SHORT_CIRCUIT_PATTERNS + evaluateShortCircuit are now imported from
// the built @elizaos/core barrel — eliminating the prior "mirror that
// drifts" failure mode (PR #224 follow-up). Build with
// `pnpm --filter @elizaos/core build` before running this script.
async function loadCoreExports() {
    const abs = new URL("../packages/core/dist/index.js", import.meta.url);
    try {
        return await import(abs.href);
    } catch (err) {
        throw new Error(
            `Could not load @elizaos/core dist: ${err.message}\n` +
            `Run \`pnpm --filter @elizaos/core build\` first.`,
        );
    }
}

// ----------------------------------------------------------------------

async function main() {
    const fixturesAbs = path.isAbsolute(FIXTURES_PATH)
        ? FIXTURES_PATH
        : path.join(process.cwd(), FIXTURES_PATH);
    const raw = await fs.readFile(fixturesAbs, "utf8");
    const data = JSON.parse(raw);
    const questions = Array.isArray(data.questions) ? data.questions : [];
    if (!questions.length) throw new Error("No questions in fixture");

    const {
        detectIntentShift,
        isShortFollowUpText,
        evaluateShortCircuit,
    } = await loadCoreExports();

    const results = [];
    let shortCircuitHits = 0;
    let shortCircuitConsistent = 0;
    let bypassDeclines = 0;
    let bypassWouldFire = 0;
    let needsLlm = 0;

    for (const q of questions) {
        const expected = String(q.expectedClassification ?? "").toUpperCase();
        const text = String(q.question ?? "");

        const sc = evaluateShortCircuit(text); // { name, classification } | null
        const shift = detectIntentShift(text);
        const short = isShortFollowUpText(text);

        // Per-pattern classification: cex_account_intent emits
        // CEX_WORKFLOW_MESSAGE, the rest emit REGULAR_MESSAGE. The hit
        // is "consistent" when the verdict matches the expected label
        // verbatim.
        const scHit = sc !== null;
        const shortCircuitVerdict = sc ? sc.classification : null;
        const shortCircuitMatchesExpected = scHit && shortCircuitVerdict === expected;

        // Would the CEX bypass fire? Only short + no shift → yes.
        const bypassWouldFireForThis = short && shift === null;

        if (scHit) {
            shortCircuitHits += 1;
            if (shortCircuitMatchesExpected) shortCircuitConsistent += 1;
        }
        if (shift !== null) bypassDeclines += 1;
        if (bypassWouldFireForThis) bypassWouldFire += 1;
        if (!scHit) needsLlm += 1;

        results.push({
            id: q.id,
            category: q.category,
            question: text,
            expected,
            short_circuit: sc?.name ?? null,
            short_circuit_verdict: shortCircuitVerdict,
            short_circuit_matches_expected: scHit ? shortCircuitMatchesExpected : null,
            cex_bypass_short: short,
            cex_bypass_intent_shift: shift,
            cex_bypass_would_fire: bypassWouldFireForThis,
            needs_llm: !scHit,
        });
    }

    // --- Per-category breakdowns ----------------------------------------
    const byCategory = new Map();
    for (const r of results) {
        const cat = r.category || "uncategorized";
        const b = byCategory.get(cat) || {
            total: 0,
            short_circuit_hits: 0,
            short_circuit_consistent: 0,
            bypass_declines: 0,
            bypass_would_fire: 0,
            needs_llm: 0,
        };
        b.total += 1;
        if (r.short_circuit) b.short_circuit_hits += 1;
        if (r.short_circuit && r.short_circuit_matches_expected) b.short_circuit_consistent += 1;
        if (r.cex_bypass_intent_shift !== null) b.bypass_declines += 1;
        if (r.cex_bypass_would_fire) b.bypass_would_fire += 1;
        if (r.needs_llm) b.needs_llm += 1;
        byCategory.set(cat, b);
    }

    // --- Findings -------------------------------------------------------
    // 1. Short-circuit false positives: any case where the regex fires
    //    but its target classification does not match the fixture's
    //    expected label. With per-pattern routing, `cex_account_intent`
    //    expects CEX_WORKFLOW_MESSAGE and the rest expect REGULAR_MESSAGE
    //    — both checked via short_circuit_matches_expected above.
    const shortCircuitFalsePositives = results.filter(
        (r) => r.short_circuit && !r.short_circuit_matches_expected,
    );

    // 2. Non-CEX expected categories that would still be bypassed to
    //    CEX (i.e., a topic-shift miss). These are the risky ones for
    //    the "trading context shift" feedback.
    const trappedByBypass = results.filter(
        (r) =>
            r.cex_bypass_would_fire &&
            r.expected !== "CEX_WORKFLOW_MESSAGE",
    );

    // --- Print report ---------------------------------------------------
    console.log("=== Deterministic-layer eval (no agent, no LLM) ===");
    console.log(`Fixture: ${FIXTURES_PATH}`);
    console.log(`Total questions: ${results.length}`);
    console.log("");
    console.log("Short-circuit summary:");
    console.log(`  hits: ${shortCircuitHits}/${results.length}`);
    console.log(`  matches expected classification: ${shortCircuitConsistent}/${shortCircuitHits}`);
    console.log(`  false positives (would mis-route): ${shortCircuitFalsePositives.length}`);
    // Per-rule breakdown so a new positive-routing rule (e.g.
    // cex_account_intent) is observable separately from REGULAR rules.
    const byRule = new Map();
    for (const r of results) {
        if (!r.short_circuit) continue;
        const key = `${r.short_circuit} → ${r.short_circuit_verdict}`;
        byRule.set(key, (byRule.get(key) || 0) + 1);
    }
    if (byRule.size > 0) {
        console.log("  by rule:");
        for (const [k, v] of Array.from(byRule.entries()).sort()) {
            console.log(`    ${k.padEnd(60)} ${v}`);
        }
    }
    console.log("");
    console.log("CEX bypass predicate summary:");
    console.log(`  intent-shift declines: ${bypassDeclines}/${results.length}`);
    console.log(`  bypass would fire (short + no shift): ${bypassWouldFire}`);
    console.log(`    of those, trapped non-CEX expected: ${trappedByBypass.length}`);
    console.log("");
    console.log(`Questions still needing LLM (no short-circuit hit): ${needsLlm}/${results.length}`);
    console.log("");
    console.log("Per-category breakdown:");
    for (const [cat, b] of Array.from(byCategory.entries()).sort()) {
        console.log(
            `  ${cat.padEnd(45)} total=${String(b.total).padStart(3)} ` +
            `sc=${String(b.short_circuit_hits).padStart(3)} ` +
            `sc_ok=${String(b.short_circuit_consistent).padStart(3)} ` +
            `bypass_decl=${String(b.bypass_declines).padStart(3)} ` +
            `needs_llm=${String(b.needs_llm).padStart(3)}`,
        );
    }

    if (shortCircuitFalsePositives.length) {
        console.log("");
        console.log("=== Short-circuit FALSE POSITIVES ===");
        for (const r of shortCircuitFalsePositives) {
            console.log(
                `  Q${r.id} [${r.category}] expected=${r.expected} pattern=${r.short_circuit} :: ${r.question}`,
            );
        }
    }

    if (trappedByBypass.length) {
        console.log("");
        console.log("=== CEX bypass TRAPS for non-CEX expected ===");
        console.log("(Only relevant when a stale CEX clarification memo sits in the same room.)");
        for (const r of trappedByBypass) {
            console.log(
                `  Q${r.id} [${r.category}] expected=${r.expected} short=${r.cex_bypass_short} shift=${r.cex_bypass_intent_shift} :: ${r.question}`,
            );
        }
    }

    // --- Write JSON sidecar --------------------------------------------
    const outPath = "tests/questions/classification_eval_static_results.json";
    const summary = {
        fixture: FIXTURES_PATH,
        total: results.length,
        short_circuit: {
            hits: shortCircuitHits,
            matches_expected: shortCircuitConsistent,
            false_positives: shortCircuitFalsePositives.length,
        },
        cex_bypass: {
            intent_shift_declines: bypassDeclines,
            would_fire: bypassWouldFire,
            traps_non_cex_expected: trappedByBypass.length,
        },
        needs_llm: needsLlm,
        by_category: Object.fromEntries(byCategory.entries()),
        short_circuit_false_positives: shortCircuitFalsePositives,
        cex_bypass_traps: trappedByBypass,
        records: results,
    };
    await fs.writeFile(
        path.join(process.cwd(), outPath),
        JSON.stringify(summary, null, 2),
    );
    console.log("");
    console.log(`Wrote: ${outPath}`);

    // Exit non-zero on any deterministic-layer false positive — these
    // are the only failures the static check can catch confidently.
    if (shortCircuitFalsePositives.length || trappedByBypass.length) {
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(`static eval failed: ${err.stack ?? err.message ?? err}`);
    process.exit(1);
});
