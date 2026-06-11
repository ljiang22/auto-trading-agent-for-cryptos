import fs from "fs";
import path from "path";
import { fileStorageService } from "./fileStorageService";
import { elizaLogger } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";

const CONTENT_TYPE_MAP: Record<string, string> = {
    ".html": "text/html",
    ".png":  "image/png",
    ".svg":  "image/svg+xml",
    ".csv":  "text/csv",
};

const SYMBOL_PATTERN = /\b(BTC|ETH|SOL|BNB|XRP|USDT|USDC|ADA|DOGE|DOT)\b/i;

export class FileWatcherService {
    private runtime: IAgentRuntime;
    private watchers: fs.FSWatcher[] = [];
    /** fs.writeFile often emits `change` on Linux, not `rename` — debounce so we sync after the file is fully written. */
    private pendingSyncTimers = new Map<string, NodeJS.Timeout>();
    private static readonly SYNC_DEBOUNCE_MS = 500;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
    }

    start(): void {
        const chartsDir = path.join(process.cwd(), "saved_data", "Charts");
        this.watchDir(chartsDir);
        elizaLogger.info(`[FileWatcher] Watching ${chartsDir}`);
    }

    stop(): void {
        for (const t of this.pendingSyncTimers.values()) {
            clearTimeout(t);
        }
        this.pendingSyncTimers.clear();
        this.watchers.forEach(w => w.close());
        this.watchers = [];
    }

    private watchDir(dir: string): void {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const watcher = fs.watch(dir, { persistent: false }, (eventType, filename) => {
            if (!filename) return;
            if (eventType !== "rename" && eventType !== "change") return;
            const fullPath = path.join(dir, filename);
            const prior = this.pendingSyncTimers.get(fullPath);
            if (prior) clearTimeout(prior);
            this.pendingSyncTimers.set(
                fullPath,
                setTimeout(() => {
                    this.pendingSyncTimers.delete(fullPath);
                    void this.handleNewFileWhenReady(fullPath, filename);
                }, FileWatcherService.SYNC_DEBOUNCE_MS)
            );
        });
        this.watchers.push(watcher);
    }

    private async handleNewFileWhenReady(fullPath: string, filename: string): Promise<void> {
        try {
            await fs.promises.access(fullPath, fs.constants.R_OK);
        } catch {
            return;
        }
        if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return;
        await this.handleNewFile(fullPath, filename);
    }

    private async handleNewFile(fullPath: string, filename: string): Promise<void> {
        try {
            const ext = path.extname(filename).toLowerCase();
            const contentType = CONTENT_TYPE_MAP[ext];
            if (!contentType) return;

            const content = fs.readFileSync(fullPath);
            const st = fs.statSync(fullPath);
            // Same day bucket as buildChartProxyUrl() (mtime), not callback time —
            // avoids S3 key drift across UTC midnight while a chart file is hot-cached.
            const date = new Date(st.mtimeMs).toISOString().split("T")[0];

            const symbolMatch = filename.match(SYMBOL_PATTERN);
            const symbol = symbolMatch ? symbolMatch[1].toUpperCase() : undefined;

            const s3Key = fileStorageService.buildKey({
                type: ext === ".csv" ? "csv" : "chart",
                agentId: this.runtime.agentId,
                userId: "system",
                date,
                symbol,
                filename: filename.replace(/\s+/g, "-").toLowerCase(),
            });

            // Do NOT pass localCachePath here. The source file already lives at
            // `fullPath` — saveFile's writeFileSync(localCachePath, body) would
            // re-emit a `change` event on the same file we just read, creating an
            // infinite watch loop (mtime keeps updating, watcher keeps re-firing,
            // S3 keeps re-uploading). The file is already cached on disk.
            const proxyUrl = await fileStorageService.saveFile({
                content,
                s3Key,
                contentType,
                metadata: {
                    "agent-id": this.runtime.agentId,
                    "source-filename": filename,
                },
            });

            elizaLogger.info(`[FileWatcher] Synced chart to S3: ${proxyUrl}`);
        } catch (err) {
            elizaLogger.warn(`[FileWatcher] Failed to sync ${filename}: ${err}`);
        }
    }
}
