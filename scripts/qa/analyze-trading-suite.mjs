#!/usr/bin/env node
/**
 * Analyze harness trading-prod run: correctness + latency.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extractRiskDecision, riskDecisionsMatch } from "./lib/cw-trading-parser.mjs";
import {
    buildCaseTitleMap,
    resolveCaseTitle,
} from "./lib/trading-case-meta.mjs";
import {
    extractVenueCallsFromAudit,
    summarizeVenueCalls,
} from "../../tests/agent-harness/lib/latency.mjs";

function parseArgs(argv) {
    const out = { runDir: null, skipHtml: false, suitePath: null };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === "--run-dir") out.runDir = argv[++i];
        else if (argv[i] === "--skip-html") out.skipHtml = true;
        else if (argv[i] === "--suite") out.suitePath = argv[++i];
    }
    if (!out.runDir) {
        console.error("usage: analyze-trading-suite.mjs --run-dir <path>");
        process.exit(2);
    }
    return out;
}

function percentile(sorted, p) {
    if (sorted.length === 0) {
        return null;
    }
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
}

async function loadAuditForCase(auditDir, caseId) {
    const safe = caseId.replace(/[^a-zA-Z0-9._-]+/g, "_");
    try {
        const raw = await fs.readFile(path.join(auditDir, `${safe}.json`), "utf8");
        const data = JSON.parse(raw);
        return data.events ?? [];
    } catch {
        return [];
    }
}

function analyzeCase({ reportCase, summary, auditEvents, suiteCase, harvestFailed, titleMap }) {
    const issues = [];
    const tags = summary?.tags ?? suiteCase?.tags ?? [];
    const isWrite = tags.includes("write") || tags.includes("risk_deny");
    const isRiskDeny = tags.includes("risk_deny");
    const isUnsupported = tags.includes("unsupported");
    const isRejection = tags.includes("rejection");
    const correlationId = summary?.requestId || summary?.cexRequestId;

    const riskFromCw = extractRiskDecision(auditEvents);
    const riskExpected = suiteCase?.expect?.riskDecision;
    const riskOptional = suiteCase?.expect?.riskDecisionOptional === true;
    if (riskExpected && riskFromCw && !riskOptional) {
        if (!riskDecisionsMatch(riskFromCw, riskExpected)) {
            issues.push(`riskDecision expected ${riskExpected}, CW got ${riskFromCw}`);
        }
    } else if (riskExpected && isRiskDeny && !riskFromCw && !riskOptional && !harvestFailed) {
        const streamRisk = summary?.riskDecisionFromStream;
        if (!streamRisk) {
            issues.push("risk_deny case: no risk_check in CloudWatch audit");
        }
    }

    if (
        isWrite &&
        !isUnsupported &&
        auditEvents.length === 0 &&
        correlationId &&
        !harvestFailed
    ) {
        issues.push("auditIncomplete: no [Trading] events for request_id");
    }

    if (isRejection) {
        const phases = summary?.approvalPhasesSeen ?? [];
        if (phases.length === 0 && !reportCase.passed && auditEvents.length === 0) {
            issues.push("rejection case: no approval phase or audit events captured");
        }
    }

    const venueCalls = extractVenueCallsFromAudit(auditEvents);
    const venueSummary = summarizeVenueCalls(venueCalls);
    const latencyBreakdown =
        summary?.latencyBreakdown ?? reportCase.latencyBreakdown ?? null;
    const phases = latencyBreakdown?.phases ?? {};
    const { title, section } = resolveCaseTitle(reportCase.id, titleMap);

    return {
        id: reportCase.id,
        title,
        section,
        harnessPassed: reportCase.passed,
        roomGroup: reportCase.roomGroup ?? summary?.roomGroup,
        durationMs: reportCase.durationMs,
        requestId: reportCase.requestId ?? summary?.requestId,
        tags,
        riskFromCw,
        riskFromStream: summary?.riskDecisionFromStream,
        auditEventCount: auditEvents.length,
        venueLatencyMs: venueSummary.maxMs,
        venueCallTotalMs: venueSummary.totalMs,
        venueCallMaxMs: venueSummary.maxMs,
        venueCallCount: venueSummary.count,
        venueCalls,
        phaseLatencies: summary?.phaseLatencies ?? reportCase.phaseLatencies,
        latencyBreakdown,
        latencyPhases: phases,
        issues,
        analysisPassed: issues.length === 0 && reportCase.passed !== false,
    };
}

async function loadHarvestError(auditDir) {
    try {
        const raw = await fs.readFile(path.join(auditDir, "harvest-error.json"), "utf8");
        const data = JSON.parse(raw);
        return data.error ?? "unknown harvest error";
    } catch {
        return null;
    }
}

async function loadSuiteCases(report, cliSuitePath) {
    const suitePath =
        cliSuitePath ||
        report.suitePath ||
        path.join(
            path.dirname(fileURLToPath(import.meta.url)),
            "../../tests/agent-harness/suites/trading-prod/trading-prod.full.json",
        );
    const resolved = path.isAbsolute(suitePath)
        ? suitePath
        : path.join(process.cwd(), suitePath);
    try {
        const suite = JSON.parse(await fs.readFile(resolved, "utf8"));
        return new Map(suite.cases.map((c) => [String(c.id), c]));
    } catch {
        return new Map();
    }
}

function venuePassRates(results) {
    const buckets = { explicit_venue: { pass: 0, total: 0 }, implicit_venue: { pass: 0, total: 0 } };
    for (const r of results) {
        const tags = r.tags || [];
        if (tags.includes("explicit_venue")) {
            buckets.explicit_venue.total += 1;
            if (r.harnessPassed) buckets.explicit_venue.pass += 1;
        }
        if (tags.includes("implicit_venue")) {
            buckets.implicit_venue.total += 1;
            if (r.harnessPassed) buckets.implicit_venue.pass += 1;
        }
    }
    return buckets;
}

function summarizePhaseLatencies(results, phaseKey) {
    const values = results
        .map((r) => {
            if (phaseKey === "venueCallMaxMs") {
                return r.venueCallMaxMs;
            }
            return r.latencyPhases?.[phaseKey];
        })
        .filter((n) => typeof n === "number" && Number.isFinite(n));
    if (values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    return {
        count: sorted.length,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        min: sorted[0],
        max: sorted[sorted.length - 1],
    };
}

function buildMarkdown(report, results, latencySummary, venueRates) {
    const teardown = report.teardown;
    const lines = [
        `# Trading prod analysis — ${report.suite}`,
        "",
        `Run: ${report.runStartedAt} → ${report.runEndedAt}`,
        `Harness: ${report.passed}/${report.total} passed`,
        `Teardown: ${teardown ? (teardown.ok ? "PASS" : "FAIL") : "not run"}`,
        "",
        "Case index: [CASE_INDEX.md](../suites/trading-prod/CASE_INDEX.md)",
        "",
        "## Venue prompt pass rates",
        "",
        `- explicit: ${venueRates.explicit_venue.pass}/${venueRates.explicit_venue.total}`,
        `- implicit: ${venueRates.implicit_venue.pass}/${venueRates.implicit_venue.total}`,
        "",
        "## Case summary",
        "",
        "| Case | Title | Room | Harness | Analysis | Duration ms | Risk (CW) | Audit events | Issues |",
        "|------|-------|------|---------|----------|-------------|-----------|--------------|--------|",
    ];
    for (const r of results) {
        const issueText =
            r.issues.length > 0 ? r.issues.join("; ") : "-";
        lines.push(
            `| ${r.id} | ${r.title ?? r.id} | ${r.roomGroup ?? "-"} | ${r.harnessPassed ? "PASS" : "FAIL"} | ${r.analysisPassed ? "PASS" : "FAIL"} | ${r.durationMs} | ${r.riskFromCw ?? "-"} | ${r.auditEventCount} | ${issueText} |`,
        );
    }
    lines.push("", "## Latency by room group", "");
    for (const [group, stats] of Object.entries(latencySummary.byRoomGroup)) {
        lines.push(
            `- **${group}**: p50=${stats.p50}ms p95=${stats.p95}ms n=${stats.count}`,
        );
    }
    if (latencySummary.byPhase) {
        lines.push("", "## Latency phases (p50 ms)", "");
        for (const [phase, stats] of Object.entries(latencySummary.byPhase)) {
            if (stats) {
                lines.push(`- **${phase}**: p50=${stats.p50}ms p95=${stats.p95}ms n=${stats.count}`);
            }
        }
    }
    lines.push("");
    return lines.join("\n");
}

async function main() {
    const args = parseArgs(process.argv);
    const runDir = path.resolve(args.runDir);
    const report = JSON.parse(
        await fs.readFile(path.join(runDir, "report.json"), "utf8"),
    );
    const auditDir = path.join(runDir, "audit");
    const analysisDir = path.join(runDir, "analysis");
    await fs.mkdir(analysisDir, { recursive: true });

    const suiteMap = await loadSuiteCases(report, args.suitePath);
    const titleMap = buildCaseTitleMap();
    const harvestError = await loadHarvestError(auditDir);
    const results = [];

    for (const reportCase of report.cases) {
        let summary = null;
        try {
            const safe = String(reportCase.id).replace(/[^a-zA-Z0-9._-]+/g, "_");
            summary = JSON.parse(
                await fs.readFile(
                    path.join(runDir, "cases", `${safe}.summary.json`),
                    "utf8",
                ),
            );
        } catch {
            // optional
        }
        const auditEvents = await loadAuditForCase(auditDir, reportCase.id);
        results.push(
            analyzeCase({
                reportCase,
                summary,
                auditEvents,
                suiteCase: suiteMap.get(String(reportCase.id)),
                harvestFailed: Boolean(harvestError),
                titleMap,
            }),
        );
    }

    if (harvestError) {
        console.warn(`[analyze] harvest failed: ${harvestError}`);
    }

    const latencyRows = results.map((r) => ({
        caseId: r.id,
        roomGroup: r.roomGroup,
        durationMs: r.durationMs,
        ttfbMs: r.phaseLatencies?.ttfbMs,
        messageToApprovalPromptMs: r.latencyPhases?.messageToApprovalPromptMs,
        approvalSubmitApiMs: r.latencyPhases?.approvalSubmitApiMs,
        approvalSubmitToFinalResponseMs:
            r.latencyPhases?.approvalSubmitToFinalResponseMs,
        actionExecutionMs: r.latencyPhases?.actionExecutionMs,
        venueCallTotalMs: r.venueCallTotalMs,
        venueCallMaxMs: r.venueCallMaxMs,
        auditEventCount: r.auditEventCount,
    }));

    const byRoomGroup = {};
    for (const r of results) {
        const g = r.roomGroup || "unknown";
        if (!byRoomGroup[g]) {
            byRoomGroup[g] = [];
        }
        byRoomGroup[g].push(r.durationMs);
    }
    const latencySummary = { byRoomGroup: {}, byPhase: {} };
    for (const [g, durations] of Object.entries(byRoomGroup)) {
        const sorted = [...durations].sort((a, b) => a - b);
        latencySummary.byRoomGroup[g] = {
            count: sorted.length,
            p50: percentile(sorted, 50),
            p95: percentile(sorted, 95),
            min: sorted[0],
            max: sorted[sorted.length - 1],
        };
    }

    const phaseKeys = [
        "messageToApprovalPromptMs",
        "approvalSubmitApiMs",
        "approvalSubmitToFinalResponseMs",
        "actionExecutionMs",
        "venueCallMaxMs",
        "messageToFinalResponseMs",
        "messageToPlanCardMs",
    ];
    for (const key of phaseKeys) {
        const stats = summarizePhaseLatencies(results, key);
        if (stats) {
            latencySummary.byPhase[key] = stats;
        }
    }

    const latencyBreakdownReport = {
        analyzedAt: new Date().toISOString(),
        cases: results.map((r) => ({
            id: r.id,
            roomGroup: r.roomGroup,
            latencyBreakdown: r.latencyBreakdown,
            venueCalls: r.venueCalls,
        })),
    };

    const venueRates = venuePassRates(results);
    const teardownOk = report.teardown?.ok !== false;

    const correctness = {
        analyzedAt: new Date().toISOString(),
        harvestError,
        harnessPassed: report.passed,
        harnessFailed: report.failed,
        teardown: report.teardown ?? null,
        teardownPassed: teardownOk,
        analysisPassed: results.filter((r) => r.analysisPassed).length,
        analysisFailed: results.filter((r) => !r.analysisPassed).length,
        venuePassRates: venueRates,
        cases: results,
        overallPassed:
            !harvestError &&
            teardownOk &&
            report.failed === 0 &&
            results.every((r) => r.analysisPassed),
    };

    await fs.writeFile(
        path.join(analysisDir, "correctness.json"),
        JSON.stringify(correctness, null, 2),
        "utf8",
    );
    await fs.writeFile(
        path.join(analysisDir, "latency-summary.json"),
        JSON.stringify(latencySummary, null, 2),
        "utf8",
    );
    await fs.writeFile(
        path.join(analysisDir, "latency-breakdown.json"),
        JSON.stringify(latencyBreakdownReport, null, 2),
        "utf8",
    );

    const csvHeader =
        "caseId,roomGroup,durationMs,ttfbMs,messageToApprovalPromptMs,approvalSubmitApiMs,approvalSubmitToFinalResponseMs,actionExecutionMs,venueCallTotalMs,venueCallMaxMs,auditEventCount\n";
    const csvBody = latencyRows
        .map(
            (r) =>
                `${r.caseId},${r.roomGroup ?? ""},${r.durationMs},${r.ttfbMs ?? ""},${r.messageToApprovalPromptMs ?? ""},${r.approvalSubmitApiMs ?? ""},${r.approvalSubmitToFinalResponseMs ?? ""},${r.actionExecutionMs ?? ""},${r.venueCallTotalMs ?? ""},${r.venueCallMaxMs ?? ""},${r.auditEventCount}`,
        )
        .join("\n");
    await fs.writeFile(
        path.join(analysisDir, "latency.csv"),
        csvHeader + csvBody + "\n",
        "utf8",
    );

    await fs.writeFile(
        path.join(analysisDir, "report.md"),
        buildMarkdown(report, results, latencySummary, venueRates),
        "utf8",
    );

    console.log(
        `[analyze] correctness -> ${path.join(analysisDir, "correctness.json")}`,
    );
    console.log(`[analyze] report.md + latency.csv written`);

    if (!args.skipHtml) {
        const renderScript = path.join(
            path.dirname(fileURLToPath(import.meta.url)),
            "render-trading-analysis-html.mjs",
        );
        await new Promise((resolve, reject) => {
            const envFile = path.resolve(process.cwd(), ".env");
            const child = spawn(
                "node",
                ["--env-file", envFile, renderScript, "--run-dir", runDir],
                { stdio: "inherit" },
            );
            child.on("error", reject);
            child.on("exit", (code) =>
                code === 0 ? resolve() : reject(new Error(`render exit ${code}`)),
            );
        });
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
