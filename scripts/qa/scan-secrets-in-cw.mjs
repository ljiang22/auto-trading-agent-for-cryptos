#!/usr/bin/env node
/**
 * §8.4 — Secrets-leak regression scanner.
 *
 * Walks a CloudWatch Logs log group over the last N minutes (default 60) and
 * grep-matches against the same patterns the runtime `secretsLeak.test.ts`
 * asserts. Exit 1 if any match found, with the offending log stream + line
 * pinned for triage.
 *
 * Designed to run as a scheduled job (EventBridge → CodeBuild → S3 report),
 * but also runs as a one-shot CLI for ad-hoc audits.
 *
 * Usage:
 *   AWS_PROFILE=sentiedge-target node scripts/qa/scan-secrets-in-cw.mjs \
 *     --log-group /ecs/sentiedge-agent \
 *     --stream-prefix staging \
 *     --minutes 60 \
 *     [--report-s3 s3://sentiedge2025/autotrading/secrets-scan/]
 *
 * Note: prod and staging share `/ecs/sentiedge-agent`; the stream prefix
 * (`ecs` for prod, `staging` for staging) is what isolates env scans.
 *
 * Required IAM (run-side):
 *   logs:FilterLogEvents, logs:DescribeLogGroups
 *   s3:PutObject (only if --report-s3 set)
 */

import { setTimeout as wait } from "node:timers/promises";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

/**
 * Patterns that MUST NEVER appear in production logs. Aligned with
 * packages/plugin-cex/__tests__/observability/secretsLeak.test.ts so a scan
 * hit indicates an actual regression in the sanitization path, not a false
 * positive in the catalog.
 */
const FORBIDDEN_PATTERNS = [
    // Binance-style HMAC signatures (long hex string)
    /\bsignature=[a-f0-9]{40,}\b/i,
    // Authorization headers leaking JWT / Bearer tokens
    /Authorization:\s*Bearer\s+ey[A-Za-z0-9_-]{20,}/,
    // Coinbase API secret prefix
    /-----BEGIN EC PRIVATE KEY-----/,
    // Generic API key shapes (32+ hex / base64 chunk after `apiKey=`)
    /\bapiKey=([A-Za-z0-9+/=]{32,})/,
    /\bapikey=([A-Za-z0-9+/=]{32,})/,
    // X-MBX-APIKEY header value
    /X-MBX-APIKEY:\s*[A-Za-z0-9]{40,}/,
    // SECRET_KEY / SESSION_SECRET in plaintext
    /\b(SECRET_KEY|SESSION_SECRET)=([^\s]{16,})/,
    // AWS-style access keys
    /\bAKIA[0-9A-Z]{16}\b/,
];

function parseArgs(argv) {
    const out = {
        logGroup: null,
        streamPrefix: null,
        minutes: 60,
        reportS3: null,
        region: "ap-southeast-1",
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--log-group") out.logGroup = argv[++i];
        else if (a === "--stream-prefix") out.streamPrefix = argv[++i];
        else if (a === "--minutes") out.minutes = Number.parseInt(argv[++i], 10);
        else if (a === "--report-s3") out.reportS3 = argv[++i];
        else if (a === "--region") out.region = argv[++i];
    }
    if (!out.logGroup) {
        console.error("Missing --log-group");
        process.exit(2);
    }
    return out;
}

function matchSecrets(message) {
    for (const re of FORBIDDEN_PATTERNS) {
        const m = re.exec(message);
        if (m) {
            return {
                pattern: re.source,
                snippet: message.slice(Math.max(0, m.index - 40), Math.min(message.length, m.index + 80)),
            };
        }
    }
    return null;
}

async function scan({ logGroup, streamPrefix, minutes, region }) {
    const client = new CloudWatchLogsClient({ region });
    const startTime = Date.now() - minutes * 60_000;
    const findings = [];
    let scanned = 0;
    let nextToken;
    do {
        const cmd = new FilterLogEventsCommand({
            logGroupName: logGroup,
            // Staging and prod ship into the same log group; the stream
            // prefix is the only thing that distinguishes them.
            logStreamNamePrefix: streamPrefix || undefined,
            startTime,
            endTime: Date.now(),
            nextToken,
            limit: 10_000,
        });
        let res;
        try {
            res = await client.send(cmd);
        } catch (err) {
            console.error(`✗ FilterLogEvents failed: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(3);
        }
        for (const ev of res.events ?? []) {
            scanned += 1;
            const hit = matchSecrets(ev.message ?? "");
            if (hit) {
                findings.push({
                    timestamp: new Date(ev.timestamp ?? 0).toISOString(),
                    log_stream: ev.logStreamName,
                    pattern: hit.pattern,
                    snippet: hit.snippet,
                });
            }
        }
        nextToken = res.nextToken;
        // Gentle throttling for high-volume log groups.
        if (nextToken) await wait(50);
    } while (nextToken);

    return { scanned, findings };
}

async function maybeUpload({ reportS3, region, report }) {
    if (!reportS3) return null;
    const match = /^s3:\/\/([^/]+)\/?(.*)$/.exec(reportS3);
    if (!match) {
        console.error(`✗ Bad --report-s3 URI: ${reportS3}`);
        process.exit(2);
    }
    const [, bucket, prefix] = match;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const key = `${prefix ? prefix.replace(/\/$/, "") + "/" : ""}secrets-scan-${ts}.json`;
    const s3 = new S3Client({ region });
    await s3.send(
        new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: JSON.stringify(report, null, 2),
            ContentType: "application/json",
        }),
    );
    return `s3://${bucket}/${key}`;
}

const args = parseArgs(process.argv);
console.log(
    `[scan-secrets] log_group=${args.logGroup} stream_prefix=${args.streamPrefix ?? "<none>"} window_minutes=${args.minutes} region=${args.region}`,
);
const { scanned, findings } = await scan(args);
const report = {
    log_group: args.logGroup,
    window_minutes: args.minutes,
    scanned_events: scanned,
    findings,
    scanned_at: new Date().toISOString(),
};
const uploaded = await maybeUpload({ reportS3: args.reportS3, region: args.region, report });
if (uploaded) console.log(`[scan-secrets] uploaded ${uploaded}`);
console.log(`[scan-secrets] scanned=${scanned} findings=${findings.length}`);
if (findings.length > 0) {
    console.error("✗ Secrets leaked into CloudWatch:");
    for (const f of findings) {
        console.error(`  [${f.timestamp}] stream=${f.log_stream} pattern=${f.pattern}`);
        console.error(`     ${f.snippet}\n`);
    }
    process.exit(1);
}
console.log("✓ No secrets-leak patterns detected.");
