import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import {
    GetObjectCommand,
    ListObjectsV2Command,
    S3Client,
    type _Object,
} from "@aws-sdk/client-s3";
import { elizaLogger } from "@elizaos/core";
import pLimit from "p-limit";

export interface ResearchReportRecord {
    fileName: string;
    s3Key: string;
    size?: number;
    lastModified?: string;
    cachedAt: string;
    downloadPath: string;
}

export interface ReportSyncOptions {
    bucket: string;
    prefix: string;
    region?: string;
    pollIntervalMs?: number;
    localCacheDir?: string;
}

const DEFAULT_BUCKET = "sentiedge24-new";
const DEFAULT_PREFIX = "research_report/weekly_reports/";
const DEFAULT_REGION = "us-east-2";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function resolveRepoRoot(startDir = process.cwd()): string {
    let current = startDir;
    const { root } = path.parse(current);

    while (true) {
        const workspaceFile = path.join(current, "pnpm-workspace.yaml");
        if (fs.existsSync(workspaceFile)) {
            return current;
        }
        if (current === root) {
            return startDir;
        }
        current = path.dirname(current);
    }
}

export class ReportSyncService {
    private readonly bucket: string;
    private readonly prefix: string;
    private readonly metadataPath: string;
    private readonly pollIntervalMs: number;
    private readonly s3Client: S3Client;
    private readonly enabled: boolean;
    private syncTimer?: NodeJS.Timeout;
    private syncPromise: Promise<void> | null = null;
    private cachedReports: ResearchReportRecord[] = [];

    constructor(options: ReportSyncOptions = {
        bucket: DEFAULT_BUCKET,
        prefix: DEFAULT_PREFIX,
    }) {
        this.bucket = options.bucket || DEFAULT_BUCKET;
        this.prefix = options.prefix || DEFAULT_PREFIX;

        const repoRoot = resolveRepoRoot();
        const agentCacheDir = path.join(repoRoot, "agent", "cache", "reports");
        const workspaceCacheDir = path.join(repoRoot, "cache", "reports");
        const cacheDir =
            options.localCacheDir ||
            (fs.existsSync(path.join(repoRoot, "agent"))
                ? agentCacheDir
                : workspaceCacheDir);
        this.metadataPath = path.join(cacheDir, "report-index.json");

        const accessKeyId = process.env.AWS_ACCESS_KEY_ID || "";
        const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || "";
        const region =
            options.region ||
            process.env.RESEARCH_REPORT_REGION ||
            process.env.AWS_REGION ||
            DEFAULT_REGION;

        this.pollIntervalMs = Math.max(
            5 * 60 * 1000,
            Number.parseInt(process.env.RESEARCH_REPORT_POLL_INTERVAL_MS || "", 10) ||
                options.pollIntervalMs ||
                ONE_DAY_MS
        );

        this.s3Client = new S3Client({
            region,
            credentials:
                accessKeyId && secretAccessKey
                    ? {
                          accessKeyId,
                          secretAccessKey,
                      }
                    : undefined,
        });

        this.enabled = Boolean(
            this.bucket && this.prefix && accessKeyId && secretAccessKey
        );

        this.ensureCacheDirExists(cacheDir);
        this.cachedReports = this.loadCachedMetadata();
    }

    public isEnabled(): boolean {
        return this.enabled;
    }

    public getCacheDir(): string {
        return path.dirname(this.metadataPath);
    }

    public ensureCacheDirExists(dir = this.getCacheDir()): void {
        fs.mkdirSync(dir, { recursive: true });
    }

    public async start(): Promise<void> {
        if (!this.enabled) {
            elizaLogger.warn(
                "ReportSyncService disabled. Ensure AWS credentials are configured to enable report syncing."
            );
            return;
        }
        await this.syncReports("startup");
        this.syncTimer = setInterval(() => {
            void this.syncReports("interval");
        }, this.pollIntervalMs);
    }

    public stop(): void {
        if (this.syncTimer) {
            clearInterval(this.syncTimer);
            this.syncTimer = undefined;
        }
    }

    public getReports(): ResearchReportRecord[] {
        return this.cachedReports;
    }

    private async syncReports(trigger: "startup" | "interval"): Promise<void> {
        if (this.syncPromise) {
            return this.syncPromise;
        }

        this.syncPromise = (async () => {
            try {
                elizaLogger.info(
                    `Starting research report sync (${trigger}) from s3://${this.bucket}/${this.prefix}`
                );
                const objects = await this.listRemoteReports();
                const existingMetadata = await this.readMetadata();
                const limit = pLimit(4);

                const pathExists = async (p: string): Promise<boolean> => {
                    try {
                        await fs.promises.access(p);
                        return true;
                    } catch {
                        return false;
                    }
                };

                const results = await Promise.all(
                    objects.map((object) =>
                        limit(async (): Promise<ResearchReportRecord | null> => {
                            if (!object.Key) return null;
                            const originalFileName = path.basename(object.Key);
                            if (!originalFileName.toLowerCase().endsWith(".pdf")) {
                                return null;
                            }

                            // Normalize to "Weekly Research Report", preserving MMDDYY date prefix
                            const dateMatch = originalFileName.match(/^(\d{6})/);
                            const fileName = dateMatch
                                ? `${dateMatch[1]} - Weekly Research Report.pdf`
                                : originalFileName;

                            const lastModifiedIso = object.LastModified
                                ? object.LastModified.toISOString()
                                : undefined;
                            const previous = existingMetadata.get(fileName);
                            const expectedSize = object.Size ?? previous?.size ?? 0;
                            const destination = path.join(this.getCacheDir(), fileName);
                            const exists = await pathExists(destination);
                            const needsDownload =
                                !exists ||
                                !previous ||
                                previous.lastModified !== lastModifiedIso ||
                                (object.Size && previous.size !== object.Size);

                            if (needsDownload) {
                                await this.downloadObject(object.Key, destination);
                                elizaLogger.info(`Downloaded report ${fileName}`);
                            }

                            return {
                                fileName,
                                s3Key: object.Key,
                                size: expectedSize,
                                lastModified: lastModifiedIso,
                                cachedAt: new Date().toISOString(),
                                downloadPath: `/research-reports/files/${encodeURIComponent(
                                    fileName
                                )}`,
                            };
                        })
                    )
                );

                const nextMetadata: ResearchReportRecord[] = results.filter(
                    (r): r is ResearchReportRecord => r !== null
                );

                nextMetadata.sort((a, b) => {
                    const timeA = a.lastModified ?? a.cachedAt;
                    const timeB = b.lastModified ?? b.cachedAt;
                    return timeA > timeB ? -1 : 1;
                });

                this.cachedReports = nextMetadata;
                await this.writeMetadata(nextMetadata);

                // Remove stale PDFs no longer in metadata (e.g. old names before rename)
                const validFileNames = new Set(nextMetadata.map(r => r.fileName));
                const existingFiles = await fs.promises.readdir(this.getCacheDir());
                await Promise.all(
                    existingFiles.map(async (file) => {
                        if (file.toLowerCase().endsWith(".pdf") && !validFileNames.has(file)) {
                            await fs.promises.unlink(path.join(this.getCacheDir(), file));
                            elizaLogger.info(`Removed stale report file: ${file}`);
                        }
                    })
                );
            } catch (error) {
                elizaLogger.error("Failed to sync weekly reports", error);
            } finally {
                this.syncPromise = null;
            }
        })();

        return this.syncPromise;
    }

    private async listRemoteReports(): Promise<_Object[]> {
        const objects: _Object[] = [];
        let continuationToken: string | undefined;

        do {
            const command = new ListObjectsV2Command({
                Bucket: this.bucket,
                Prefix: this.prefix,
                ContinuationToken: continuationToken,
            });
            const response = await this.s3Client.send(command);
            if (response.Contents) {
                objects.push(...response.Contents);
            }
            continuationToken = response.IsTruncated
                ? response.NextContinuationToken
                : undefined;
        } while (continuationToken);

        return objects;
    }

    private async downloadObject(key: string, destination: string): Promise<void> {
        const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: key,
        });
        const response = await this.s3Client.send(command);
        const body = response.Body;
        if (!body) {
            throw new Error(`Empty body received for ${key}`);
        }

        if (typeof (body as any).transformToByteArray === "function") {
            const bytes = await (body as any).transformToByteArray();
            await fs.promises.writeFile(destination, Buffer.from(bytes));
        } else if (body instanceof Readable) {
            await pipeline(body, fs.createWriteStream(destination));
        } else {
            throw new Error(`Unsupported body stream for ${key}`);
        }
    }

    private async readMetadata(): Promise<Map<string, ResearchReportRecord>> {
        try {
            const raw = await fs.promises.readFile(this.metadataPath, "utf-8");
            const parsed = JSON.parse(raw) as ResearchReportRecord[];
            return new Map(parsed.map((entry) => [entry.fileName, entry]));
        } catch {
            return new Map();
        }
    }

    private async writeMetadata(
        records: ResearchReportRecord[]
    ): Promise<void> {
        await fs.promises.writeFile(
            this.metadataPath,
            JSON.stringify(records, null, 2),
            "utf-8"
        );
    }

    private loadCachedMetadata(): ResearchReportRecord[] {
        try {
            const raw = fs.readFileSync(this.metadataPath, "utf-8");
            const data = JSON.parse(raw);
            if (Array.isArray(data)) {
                return data as ResearchReportRecord[];
            }
            return [];
        } catch {
            return [];
        }
    }
}
