#!/usr/bin/env node
/**
 * Harvest [Trading] CloudWatch log lines for a harness run directory.
 */

import { setTimeout as wait } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import {
    parseTradingLogLine,
    matchesRequestFilter,
    assignOrphanEventsByTimestamp,
} from "./lib/cw-trading-parser.mjs";

const DEFAULT_LOG_GROUP = "/ecs/sentiedge-agent";
const DEFAULT_REGION = "ap-southeast-1";
const DEFAULT_STREAM_PREFIX = "ecs";

function assertAwsCredentials(region) {
    const env = { ...process.env, AWS_REGION: region };
    const awsArgs = ["sts", "get-caller-identity", "--output", "json"];
    if (process.env.AWS_PROFILE) {
        awsArgs.unshift("--profile", process.env.AWS_PROFILE);
    }
    const result = spawnSync("aws", awsArgs, { env, encoding: "utf8" });
    if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || "").trim();
        const profileHint = process.env.AWS_PROFILE
            ? `Verify AWS_PROFILE=${process.env.AWS_PROFILE} (aws sts get-caller-identity --profile ${process.env.AWS_PROFILE})`
            : "Set AWS_PROFILE in .env or pass credentials via standard AWS env vars.";
        throw new Error(
            `AWS credentials are invalid or missing. ${profileHint}${detail ? `\n${detail}` : ""}`,
        );
    }
}

function parseArgs(argv) {
    const out = {
        runDir: null,
        logGroup: process.env.CW_LOG_GROUP || DEFAULT_LOG_GROUP,
        streamPrefix: process.env.CW_LOG_STREAM_PREFIX || DEFAULT_STREAM_PREFIX,
        region: process.env.AWS_REGION || DEFAULT_REGION,
        bufferBeforeMs: 120_000,
        bufferAfterMs: 300_000,
        skipHarvest: false,
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--run-dir") out.runDir = argv[++i];
        else if (a === "--log-group") out.logGroup = argv[++i];
        else if (a === "--stream-prefix") out.streamPrefix = argv[++i];
        else if (a === "--region") out.region = argv[++i];
        else if (a === "--skip-harvest") out.skipHarvest = true;
    }
    if (!out.runDir) {
        console.error("usage: harvest-cw-trading-audit.mjs --run-dir <path>");
        process.exit(2);
    }
    return out;
}

async function loadCaseSummaries(runDir) {
    const casesDir = path.join(runDir, "cases");
    let files;
    try {
        files = await fs.readdir(casesDir);
    } catch {
        return [];
    }
    const summaries = [];
    for (const f of files) {
        if (!f.endsWith(".summary.json")) {
            continue;
        }
        const raw = await fs.readFile(path.join(casesDir, f), "utf8");
        summaries.push(JSON.parse(raw));
    }
    return summaries;
}

async function filterTradingEvents(args, startMs, endMs, requestIds) {
    const client = new CloudWatchLogsClient({ region: args.region });
    const events = [];
    let nextToken;
    let scanned = 0;

    do {
        const cmd = new FilterLogEventsCommand({
            logGroupName: args.logGroup,
            logStreamNamePrefix: args.streamPrefix || undefined,
            startTime: startMs,
            endTime: endMs,
            filterPattern: '"[Trading]"',
            nextToken,
            limit: 10_000,
        });
        const res = await client.send(cmd);
        for (const ev of res.events ?? []) {
            scanned += 1;
            const parsed = parseTradingLogLine(ev.message ?? "");
            if (!parsed) {
                continue;
            }
            if (!matchesRequestFilter(parsed, requestIds)) {
                continue;
            }
            events.push({
                ...parsed,
                _cwTimestamp: ev.timestamp,
                _cwStream: ev.logStreamName,
                _cwIngestion: new Date(ev.timestamp ?? 0).toISOString(),
            });
        }
        nextToken = res.nextToken;
        if (nextToken) {
            await wait(50);
        }
    } while (nextToken);

    return { events, scanned };
}

function groupEventsByRequestId(allEvents, summaries, options = {}) {
    const byRequest = new Map();
    const orphans = [];
    for (const ev of allEvents) {
        const rid = ev.request_id || ev.requestId;
        if (!rid) {
            orphans.push(ev);
            continue;
        }
        const key = String(rid);
        if (!byRequest.has(key)) {
            byRequest.set(key, []);
        }
        byRequest.get(key).push(ev);
    }

    const perCase = new Map();
    for (const summary of summaries) {
        const rid = summary.requestId || summary.cexRequestId;
        perCase.set(summary.id, rid ? byRequest.get(String(rid)) ?? [] : []);
    }

    assignOrphanEventsByTimestamp(orphans, perCase, summaries, {
        bufferBeforeMs: options.orphanBufferBeforeMs ?? 30_000,
        bufferAfterMs: options.orphanBufferAfterMs ?? 60_000,
    });

    return { byRequest, perCase, orphans };
}

async function main() {
    const args = parseArgs(process.argv);
    const runDir = path.resolve(args.runDir);
    const reportPath = path.join(runDir, "report.json");
    const report = JSON.parse(await fs.readFile(reportPath, "utf8"));

    if (args.skipHarvest) {
        console.log("[harvest-cw] skipped (--skip-harvest)");
        return;
    }

    const summaries = await loadCaseSummaries(runDir);
    const requestIds = new Set(
        summaries
            .map((s) => s.requestId || s.cexRequestId)
            .filter(Boolean)
            .map(String),
    );

    const startMs =
        (report.runStartedAtMs ?? Date.parse(report.runStartedAt)) - args.bufferBeforeMs;
    const endMs =
        (report.runEndedAtMs ?? Date.parse(report.runEndedAt)) + args.bufferAfterMs;

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        throw new Error(
            "[harvest-cw] invalid run time window in report.json (missing runStartedAtMs/runEndedAtMs)",
        );
    }

    console.log(
        `[harvest-cw] log_group=${args.logGroup} prefix=${args.streamPrefix} window=${new Date(startMs).toISOString()}..${new Date(endMs).toISOString()} request_ids=${requestIds.size}`,
    );

    let allEvents;
    let scanned;
    try {
        assertAwsCredentials(args.region);
        ({ events: allEvents, scanned } = await filterTradingEvents(
            args,
            startMs,
            endMs,
            requestIds.size > 0 ? requestIds : null,
        ));
    } catch (err) {
        console.warn(
            `[harvest-cw] CloudWatch fetch failed (continuing without audit): ${err instanceof Error ? err.message : String(err)}`,
        );
        await fs.mkdir(path.join(runDir, "audit"), { recursive: true });
        await fs.writeFile(
            path.join(runDir, "audit", "harvest-error.json"),
            JSON.stringify(
                {
                    error: err instanceof Error ? err.message : String(err),
                    at: new Date().toISOString(),
                },
                null,
                2,
            ),
            "utf8",
        );
        return;
    }

    const { perCase, orphans } = groupEventsByRequestId(allEvents, summaries);
    const auditDir = path.join(runDir, "audit");
    await fs.mkdir(auditDir, { recursive: true });

    const timeline = [];
    for (const [caseId, events] of perCase.entries()) {
        events.sort((a, b) => (a._cwTimestamp ?? 0) - (b._cwTimestamp ?? 0));
        await fs.writeFile(
            path.join(auditDir, `${caseId.replace(/[^a-zA-Z0-9._-]+/g, "_")}.json`),
            JSON.stringify({ caseId, events, count: events.length }, null, 2),
            "utf8",
        );
        for (const ev of events) {
            timeline.push({ caseId, ...ev });
        }
    }

    timeline.sort((a, b) => (a._cwTimestamp ?? 0) - (b._cwTimestamp ?? 0));
    await fs.writeFile(
        path.join(auditDir, "timeline.jsonl"),
        timeline.map((l) => JSON.stringify(l)).join("\n") + "\n",
        "utf8",
    );

    await fs.writeFile(
        path.join(auditDir, "harvest-meta.json"),
        JSON.stringify(
            {
                scanned,
                matchedEvents: allEvents.length,
                orphanEvents: orphans.length,
                casesWithAudit: [...perCase.values()].filter((e) => e.length > 0).length,
                totalCases: perCase.size,
                harvestedAt: new Date().toISOString(),
            },
            null,
            2,
        ),
        "utf8",
    );

    console.log(
        `[harvest-cw] scanned=${scanned} matched=${allEvents.length} cases_with_audit=${[...perCase.values()].filter((e) => e.length > 0).length}/${perCase.size}`,
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
