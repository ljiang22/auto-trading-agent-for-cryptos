import fs from "node:fs";
import path from "node:path";

const CHART_SYMBOL_PATTERN = /\b(BTC|ETH|SOL|BNB|XRP|USDT|USDC|ADA|DOGE|DOT)\b/i;

/**
 * Builds the S3 proxy URL for a chart file.
 * Mirrors the key construction logic in FileWatcherService so that the URL stored
 * in memory records matches the key the watcher uploads to.
 *
 * The date segment must match the upload path. FileWatcherService uses the chart
 * file's mtime (not "now") when syncing; using `new Date()` here caused 404s in
 * the chat iframe when a cached chart from the previous UTC day was reused
 * within the 3h window — the client requested `/.../2026-05-02/...` while the
 * object lived under `/.../2026-05-01/...`.
 */
export function buildChartProxyUrl(localPath: string, agentId: string): string {
    const filename = path.basename(localPath);
    const safeName = filename.replace(/\s+/g, "-").toLowerCase();
    const symbolMatch = filename.match(CHART_SYMBOL_PATTERN);
    const symbol = symbolMatch ? symbolMatch[1].toUpperCase() : undefined;
    let dateStr: string;
    try {
        const st = fs.statSync(localPath);
        dateStr = new Date(st.mtimeMs).toISOString().split("T")[0];
    } catch {
        dateStr = new Date().toISOString().split("T")[0];
    }
    const prefix = process.env.FILE_STORAGE_PREFIX ?? "generated";
    return `/s3-files/${prefix}/charts/${agentId}/system/${dateStr}/${symbol ?? "misc"}/${safeName}`;
}
