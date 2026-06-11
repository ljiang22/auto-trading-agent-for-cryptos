import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { mkdirSync, existsSync, writeFileSync } from "fs";
import path from "path";
import { elizaLogger } from "@elizaos/core";
import { Readable } from "stream";

export interface SaveFileOptions {
    content: Buffer | string;
    s3Key: string;
    contentType: string;
    contentDisposition?: string;
    metadata?: Record<string, string>;
    localCachePath?: string;
}

/**
 * Per-agent S3 chart index entry. The index maps the basename of every chart
 * key under `{prefix}/charts/{agentId}/` to its proxy URL. Built lazily by
 * `getChartIndex()` and cached process-wide for `CHART_INDEX_TTL_MS` so that
 * a single `/memories` request which previously fired N `ListObjectsV2`
 * calls (one per chart) now pays at most one S3 round-trip per agent.
 */
interface ChartIndexEntry {
    index: Map<string, string>;
    expiresAt: number;
}

const CHART_INDEX_TTL_MS = 5 * 60 * 1000;

/** Keys under this prefix are stored at bucket root (no FILE_STORAGE_PREFIX). */
const AUTO_DAILY_REPORTS_PREFIX = "auto-daily-reports-agent/";

function isAutoDailyReportsKey(s3Key: string): boolean {
    return s3Key.startsWith(AUTO_DAILY_REPORTS_PREFIX);
}

export class FileStorageService {
    private s3Client: S3Client;
    private bucket: string;
    private prefix: string;
    private region: string;
    private proxyBase: string;
    /** Process-wide cache of chart-basename -> proxy URL, keyed by agentId. */
    private chartIndexCache = new Map<string, ChartIndexEntry>();
    /** Dedups concurrent cache misses for the same agent so simultaneous
     *  `/memories` requests share one S3 list call instead of stampeding. */
    private chartIndexInflight = new Map<string, Promise<Map<string, string>>>();

    constructor() {
        this.bucket = process.env.FILE_STORAGE_BUCKET ?? "sentiedge2025";
        this.prefix = process.env.FILE_STORAGE_PREFIX ?? "generated";
        this.region = process.env.FILE_STORAGE_REGION ?? "us-east-2";
        this.proxyBase = "/s3-files";

        // Only pass explicit credentials when both are provided.
        // If empty, omit them so the SDK uses the default credential chain
        // (ECS task IAM role via instance metadata).
        const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
        const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
        this.s3Client = new S3Client({
            region: this.region,
            ...(accessKeyId && secretAccessKey ? {
                credentials: { accessKeyId, secretAccessKey },
            } : {}),
        });
    }

    async saveFile(options: SaveFileOptions): Promise<string> {
        const { content, s3Key, contentType, contentDisposition, metadata, localCachePath } = options;
        const fullKey = isAutoDailyReportsKey(s3Key) ? s3Key : `${this.prefix}/${s3Key}`;
        const body = typeof content === "string" ? Buffer.from(content, "utf-8") : content;

        if (localCachePath) {
            try {
                const dir = path.dirname(localCachePath);
                if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
                writeFileSync(localCachePath, body);
            } catch (err) {
                elizaLogger.warn(`[FileStorage] Local cache write failed (non-fatal): ${err}`);
            }
        }

        try {
            await this.s3Client.send(new PutObjectCommand({
                Bucket: this.bucket,
                Key: fullKey,
                Body: body,
                ContentType: contentType,
                ...(contentDisposition ? { ContentDisposition: contentDisposition } : {}),
                Metadata: {
                    "created-at": new Date().toISOString(),
                    ...metadata,
                },
            }));
            elizaLogger.info(`[FileStorage] Uploaded s3://${this.bucket}/${fullKey}`);
        } catch (err) {
            elizaLogger.error(`[FileStorage] S3 upload failed: ${err}`);
            if (localCachePath) {
                elizaLogger.warn(`[FileStorage] Falling back to local path for ${s3Key}`);
                return localCachePath;
            }
            throw err;
        }

        return `${this.proxyBase}/${fullKey}`;
    }

    async getFileStream(s3Key: string): Promise<{ body: Readable; contentType: string; contentDisposition?: string }> {
        const fullKey = isAutoDailyReportsKey(s3Key)
            ? s3Key
            : s3Key.startsWith(this.prefix)
                ? s3Key
                : `${this.prefix}/${s3Key}`;
        const response = await this.s3Client.send(new GetObjectCommand({
            Bucket: this.bucket,
            Key: fullKey,
        }));
        return {
            body: response.Body as Readable,
            contentType: response.ContentType ?? "application/octet-stream",
            contentDisposition: response.ContentDisposition,
        };
    }

    /**
     * Metadata-only lookup for efficient HTTP HEAD on the /s3-files proxy
     * (ChartEmbed preflight without streaming the object body).
     */
    async headObject(s3Key: string): Promise<{
        contentType: string;
        contentDisposition?: string;
        contentLength?: number;
    }> {
        const fullKey = isAutoDailyReportsKey(s3Key)
            ? s3Key
            : s3Key.startsWith(this.prefix)
                ? s3Key
                : `${this.prefix}/${s3Key}`;
        const response = await this.s3Client.send(
            new HeadObjectCommand({
                Bucket: this.bucket,
                Key: fullKey,
            })
        );
        return {
            contentType: response.ContentType ?? "application/octet-stream",
            contentDisposition: response.ContentDisposition,
            contentLength: response.ContentLength,
        };
    }

    buildKey(params: {
        type: "report" | "chart" | "csv" | "upload";
        agentId: string;
        userId: string;
        roomId?: string;
        date: string;
        symbol?: string;
        filename: string;
    }): string {
        const { type, agentId, userId, roomId, date, symbol, filename } = params;
        switch (type) {
            case "report":
                return `reports/${agentId}/${userId}/${date}/${symbol ?? "misc"}/${filename}`;
            case "chart":
                return `charts/${agentId}/${userId}/${date}/${symbol ?? "misc"}/${filename}`;
            case "csv":
                return `charts/${agentId}/${userId}/${date}/${filename}`;
            case "upload":
                return `uploads/${agentId}/${roomId ?? "no-room"}/${userId}/${filename}`;
        }
    }

    /**
     * Build (or reuse) the per-agent chart index mapping basename -> proxy URL.
     *
     * Performance: `/memories` previously fired one `ListObjectsV2` call per
     * chart-path-not-on-disk per memory, which on a fresh ECS task produced
     * hundreds of S3 round-trips per request and tripped the ALB 60 s idle
     * timeout (504). Now we list once per agent, cache for `CHART_INDEX_TTL_MS`,
     * and dedup concurrent misses via `chartIndexInflight`.
     *
     * Staleness: the cache only matters for charts already persisted to S3 in
     * a previous container generation; freshly-generated charts still resolve
     * via the local filesystem in `resolveChartPath`. A 5-minute TTL therefore
     * cannot hide newly-created charts from the user.
     */
    async getChartIndex(agentId: string): Promise<Map<string, string>> {
        if (!agentId) return new Map();
        const now = Date.now();
        const cached = this.chartIndexCache.get(agentId);
        if (cached && cached.expiresAt > now) {
            return cached.index;
        }
        const inflight = this.chartIndexInflight.get(agentId);
        if (inflight) return inflight;

        const prefix = `${this.prefix}/charts/${agentId}/`;
        const promise: Promise<Map<string, string>> = (async () => {
            const index = new Map<string, string>();
            try {
                let continuationToken: string | undefined;
                do {
                    const response = await this.s3Client.send(new ListObjectsV2Command({
                        Bucket: this.bucket,
                        Prefix: prefix,
                        ContinuationToken: continuationToken,
                    }));
                    for (const obj of response.Contents ?? []) {
                        if (!obj.Key) continue;
                        const slashIdx = obj.Key.lastIndexOf("/");
                        const basename = slashIdx >= 0 ? obj.Key.slice(slashIdx + 1) : obj.Key;
                        if (basename) {
                            index.set(basename, `${this.proxyBase}/${obj.Key}`);
                        }
                    }
                    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
                } while (continuationToken);
                this.chartIndexCache.set(agentId, {
                    index,
                    expiresAt: Date.now() + CHART_INDEX_TTL_MS,
                });
            } catch (err) {
                elizaLogger.warn(`[FileStorage] S3 chart index build failed for agent ${agentId}: ${err}`);
            }
            return index;
        })();

        this.chartIndexInflight.set(agentId, promise);
        promise.finally(() => {
            // Clear in-flight only after the cache slot is populated so the
            // next caller sees the cache hit instead of a stale miss.
            this.chartIndexInflight.delete(agentId);
        });
        return promise;
    }

    /**
     * Find a chart in S3 by its original filename. Used to recover S3 URLs for
     * memories that stored a local path which no longer exists after an ECS restart.
     * Returns the proxy URL or null if not found.
     */
    async findChartByFilename(agentId: string, filename: string): Promise<string | null> {
        if (!agentId || !filename) return null;
        const kebab = filename.replace(/\s+/g, "-").toLowerCase();
        const index = await this.getChartIndex(agentId);
        return index.get(kebab) ?? null;
    }

    /**
     * Extract the owning userId from an s3Key so the proxy can enforce
     * per-user access control. Returns null if the key doesn't match any
     * known structure or contains a path-traversal attempt — callers should
     * treat null as "deny".
     *
     * A return value of "system" means the key belongs to shared content
     * (e.g. scheduler-generated charts) and is readable by any authenticated
     * user. Keep in sync with buildKey().
     */
    extractOwner(s3Key: string): string | null {
        if (typeof s3Key !== "string" || s3Key.length === 0) return null;
        if (s3Key.includes("..") || s3Key.includes("\0") || s3Key.startsWith("/")) return null;

        const withoutPrefix = s3Key.startsWith(`${this.prefix}/`)
            ? s3Key.slice(this.prefix.length + 1)
            : s3Key;
        const parts = withoutPrefix.split("/");

        switch (parts[0]) {
            case "auto-daily-reports-agent":
                return "system";
            case "reports":
            case "charts":
                return parts.length >= 3 && parts[2].length > 0 ? parts[2] : null;
            case "uploads":
                return parts.length >= 4 && parts[3].length > 0 ? parts[3] : null;
            default:
                return null;
        }
    }
}

export const fileStorageService = new FileStorageService();
