import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { elizaLogger, type AgentRuntime } from "@elizaos/core";
import type { Readable } from "stream";
import {
    getMongoAnalyticsSummaryData,
    getMongoReferralCodeStatsLast30Days,
} from "../api.ts";

const LOG_PREFIX = "[AnalyticsSnapshot]";
const SNAPSHOT_PREFIX = "analytics-snapshots";
const LATEST_KEY = `${SNAPSHOT_PREFIX}/latest.json`;
const HOUR_MS = 60 * 60 * 1000;
// Soft TTL — endpoints will still serve a stale snapshot if the next run is
// late (better stale than 503), but log loudly so we notice.
const STALE_LOG_THRESHOLD_MS = 2 * HOUR_MS;

type ReferralRow = { referralCode: string; pendingCount: number; completedCount: number };

export interface AnalyticsSnapshot {
    /** Wall-clock timestamp when the snapshot finished (ms epoch). */
    generatedAt: number;
    /** Hour bucket the snapshot was written for, ISO format. */
    snapshotHourUTC: string;
    /** Full `/analytics/summary` response payload (minus generatedAt). */
    summary: Awaited<ReturnType<typeof getMongoAnalyticsSummaryData>>;
    /** Full `/analytics/referral-codes-last-30-days` response payload. */
    referralLast30Days: {
        range: { from: string; to: string };
        summary: { totalCodes: number; totalPending: number; totalCompleted: number };
        data: ReferralRow[];
    };
}

function isMongoDbHandle(db: any): boolean {
    return !!db && typeof db.collection === "function";
}

async function streamToString(stream: Readable): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString("utf-8");
}

function isoHourBucket(now: Date = new Date()): string {
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const d = String(now.getUTCDate()).padStart(2, "0");
    const h = String(now.getUTCHours()).padStart(2, "0");
    return `${y}-${m}-${d}-${h}`;
}

function msUntilNextHour(): number {
    const now = new Date();
    const next = new Date(
        Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate(),
            now.getUTCHours() + 1,
            0,
            5, // tiny offset so we run at HH:00:05 to clear the boundary
            0
        )
    );
    return next.getTime() - now.getTime();
}

export class AnalyticsSnapshotService {
    private agents: Map<string, AgentRuntime>;
    private s3Client: S3Client | null;
    private s3Bucket: string;
    private hourlyTimer?: NodeJS.Timeout;
    private startupTimer?: NodeJS.Timeout;
    private isRunning = false;
    /** Process-local cache of the most recent snapshot. Refreshed on every
     *  successful run; used by endpoints when a S3 GET round-trip would be
     *  wasteful on the hot path. */
    private cached: AnalyticsSnapshot | null = null;

    constructor(agents: Map<string, AgentRuntime>) {
        this.agents = agents;
        this.s3Bucket = process.env.FILE_STORAGE_BUCKET ?? "sentiedge2025";
        const region = process.env.FILE_STORAGE_REGION ?? "us-east-2";
        const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
        const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
        try {
            this.s3Client = new S3Client({
                region,
                ...(accessKeyId && secretAccessKey
                    ? { credentials: { accessKeyId, secretAccessKey } }
                    : {}),
            });
        } catch (err) {
            elizaLogger.warn(
                `${LOG_PREFIX} S3 client init failed; snapshots disabled: ${err instanceof Error ? err.message : String(err)}`
            );
            this.s3Client = null;
        }
    }

    public start(): void {
        if (!this.s3Client) {
            elizaLogger.warn(`${LOG_PREFIX} Disabled (no S3 client).`);
            return;
        }

        const delayUntilNext = msUntilNextHour();
        elizaLogger.info(
            `${LOG_PREFIX} Scheduler started. nextRun=${new Date(Date.now() + delayUntilNext).toISOString()} ` +
            `bucket=${this.s3Bucket} key=${LATEST_KEY}`
        );

        // Warm the in-memory cache from S3 so the first /analytics/summary
        // request after a container restart doesn't have to hit Mongo.
        void this.loadLatest().catch((err) => {
            elizaLogger.warn(
                `${LOG_PREFIX} Initial S3 load failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`
            );
        });

        // First snapshot 60 s after boot — gives BGE-M3 warmup and Mongo
        // connection pool a chance to settle before we hit DocumentDB with
        // a 6-collection scan.
        this.startupTimer = setTimeout(() => {
            this.startupTimer = undefined;
            void this.runSnapshot("startup");
        }, 60_000);

        this.hourlyTimer = setTimeout(() => {
            void this.runSnapshot("hourly-first");
            this.hourlyTimer = setInterval(() => {
                void this.runSnapshot("hourly");
            }, HOUR_MS);
        }, delayUntilNext);
    }

    public stop(): void {
        if (this.startupTimer) {
            clearTimeout(this.startupTimer);
            this.startupTimer = undefined;
        }
        if (this.hourlyTimer) {
            clearTimeout(this.hourlyTimer);
            clearInterval(this.hourlyTimer);
            this.hourlyTimer = undefined;
        }
        elizaLogger.info(`${LOG_PREFIX} Scheduler stopped.`);
    }

    /**
     * Build a snapshot from MongoDB and write to S3. Returns the snapshot or
     * null if the precondition (Mongo adapter present) was not met. Public so
     * the admin rebuild endpoint can invoke it manually.
     */
    public async runSnapshot(reason: string): Promise<AnalyticsSnapshot | null> {
        if (this.isRunning) {
            elizaLogger.info(`${LOG_PREFIX} Snapshot (${reason}) skipped: already running.`);
            return null;
        }
        if (!this.s3Client) {
            elizaLogger.warn(`${LOG_PREFIX} Snapshot (${reason}) skipped: no S3 client.`);
            return null;
        }

        const firstAgent = Array.from(this.agents.values())[0];
        const db = (firstAgent?.databaseAdapter as any)?.db;
        if (!isMongoDbHandle(db)) {
            // Local SQLite dev: skip silently — the route falls back to live
            // computation, which is fast enough on a small SQLite DB.
            elizaLogger.info(`${LOG_PREFIX} Snapshot (${reason}) skipped: not a Mongo adapter.`);
            return null;
        }

        this.isRunning = true;
        const startedAt = Date.now();
        try {
            const [summary, referralRows] = await Promise.all([
                getMongoAnalyticsSummaryData(db),
                getMongoReferralCodeStatsLast30Days(db),
            ]);

            const fromDate = new Date(
                Date.now() - 29 * 24 * 60 * 60 * 1000
            ).toLocaleDateString("en-CA");
            const toDate = new Date().toLocaleDateString("en-CA");
            const totalPending = referralRows.reduce((s, r) => s + r.pendingCount, 0);
            const totalCompleted = referralRows.reduce((s, r) => s + r.completedCount, 0);

            const snapshot: AnalyticsSnapshot = {
                generatedAt: Date.now(),
                snapshotHourUTC: isoHourBucket(),
                summary,
                referralLast30Days: {
                    range: { from: fromDate, to: toDate },
                    summary: {
                        totalCodes: referralRows.length,
                        totalPending,
                        totalCompleted,
                    },
                    data: referralRows,
                },
            };

            const body = Buffer.from(JSON.stringify(snapshot), "utf-8");
            const archiveKey = `${SNAPSHOT_PREFIX}/archive/${snapshot.snapshotHourUTC}.json`;
            await Promise.all([
                this.s3Client.send(
                    new PutObjectCommand({
                        Bucket: this.s3Bucket,
                        Key: LATEST_KEY,
                        Body: body,
                        ContentType: "application/json",
                        Metadata: { "snapshot-hour": snapshot.snapshotHourUTC },
                    })
                ),
                this.s3Client.send(
                    new PutObjectCommand({
                        Bucket: this.s3Bucket,
                        Key: archiveKey,
                        Body: body,
                        ContentType: "application/json",
                    })
                ),
            ]);

            this.cached = snapshot;
            elizaLogger.info(
                `${LOG_PREFIX} Snapshot (${reason}) wrote s3://${this.s3Bucket}/${LATEST_KEY} ` +
                `hour=${snapshot.snapshotHourUTC} bytes=${body.length} elapsed=${Date.now() - startedAt}ms`
            );
            return snapshot;
        } catch (err) {
            elizaLogger.error(
                `${LOG_PREFIX} Snapshot (${reason}) failed after ${Date.now() - startedAt}ms: ` +
                (err instanceof Error ? `${err.message}\n${err.stack}` : String(err))
            );
            return null;
        } finally {
            this.isRunning = false;
        }
    }

    /**
     * Read-or-build: returns the latest snapshot, building one inline if S3
     * has none yet (first deploy / cold disaster recovery). Endpoints should
     * use this — there is no live-computation fallback by design, so admin
     * analytics always sees a snapshot-tagged view of the data.
     */
    public async loadOrBuild(): Promise<AnalyticsSnapshot | null> {
        const latest = await this.loadLatest();
        if (latest) return latest;
        return this.runSnapshot("on-demand");
    }

    /**
     * Returns the latest snapshot. Hot path: in-memory cache. Cold path (first
     * call after restart): one S3 GET. Returns null if no snapshot exists yet
     * on S3 — callers should prefer `loadOrBuild()` which self-heals.
     */
    public async loadLatest(): Promise<AnalyticsSnapshot | null> {
        if (this.cached) {
            return this.cached;
        }
        if (!this.s3Client) {
            return null;
        }
        try {
            const response = await this.s3Client.send(
                new GetObjectCommand({ Bucket: this.s3Bucket, Key: LATEST_KEY })
            );
            const text = await streamToString(response.Body as Readable);
            const parsed = JSON.parse(text) as AnalyticsSnapshot;
            this.cached = parsed;
            const ageMs = Date.now() - parsed.generatedAt;
            if (ageMs > STALE_LOG_THRESHOLD_MS) {
                elizaLogger.warn(
                    `${LOG_PREFIX} Loaded snapshot is stale (age=${Math.round(ageMs / 60_000)}m).`
                );
            }
            return parsed;
        } catch (err: any) {
            if (err?.name === "NoSuchKey" || err?.Code === "NoSuchKey") {
                return null;
            }
            elizaLogger.warn(
                `${LOG_PREFIX} loadLatest failed: ${err instanceof Error ? err.message : String(err)}`
            );
            return null;
        }
    }
}
