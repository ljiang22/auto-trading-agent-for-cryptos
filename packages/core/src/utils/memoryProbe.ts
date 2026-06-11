import { elizaLogger } from "../utils/logger.ts";

/**
 * Process memory snapshot in MB. Use to diagnose where the 6.5 GB native
 * allocation during comprehensive analysis is coming from.
 *
 *  - heapUsed:        V8 JS heap (capped by --max-old-space-size).
 *  - external:        native Buffers held via V8 (mongo pages, LLM chunks).
 *  - arrayBuffers:    portion of `external` from ArrayBuffer/SharedArrayBuffer.
 *  - rss:             resident set size — what the kernel sees, triggers OOM.
 *
 * If `rss - heapUsed - external` grows during a step, the leak is in native
 * code that V8 can't account for (libraries with their own malloc).
 */
export function memSnapshotMB(): {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
} {
    const m = process.memoryUsage();
    const toMB = (b: number) => Math.round(b / 1_048_576);
    return {
        rss: toMB(m.rss),
        heapUsed: toMB(m.heapUsed),
        heapTotal: toMB(m.heapTotal),
        external: toMB(m.external),
        arrayBuffers: toMB(m.arrayBuffers),
    };
}

/**
 * Emit a single CloudWatch line tagged `[MemoryProbe]` that we can grep for.
 * Use this at action sub-step boundaries (before/after Tavily, before/after
 * chart render, before/after composeState, etc.) — the workflow graph already
 * has its own `[Memory]` lines at action boundaries; these complement them
 * with finer granularity inside individual actions.
 */
export function logMemProbe(
    label: string,
    extra: Record<string, string | number | undefined> = {}
): void {
    const m = memSnapshotMB();
    const native = m.rss - m.heapUsed - m.external;
    const extraStr = Object.entries(extra)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
    elizaLogger.info(
        `[MemoryProbe] ${label} rss=${m.rss}MB heap=${m.heapUsed}/${m.heapTotal}MB external=${m.external}MB nativeUntracked=${native}MB arrayBuffers=${m.arrayBuffers}MB${extraStr ? " " + extraStr : ""}`
    );
}

/**
 * Wraps a Promise-returning step with before/after memory probes and an
 * elapsed-ms tally. Returns the inner step's value unchanged.
 *
 * Use sparingly — only on steps you suspect of moving native memory. Adding
 * this around every awaited call would balloon the log volume.
 */
export async function withMemProbe<T>(
    label: string,
    fn: () => Promise<T>,
    extra: Record<string, string | number | undefined> = {}
): Promise<T> {
    const before = memSnapshotMB();
    const t0 = Date.now();
    try {
        const result = await fn();
        const after = memSnapshotMB();
        const native = (after.rss - after.heapUsed - after.external)
            - (before.rss - before.heapUsed - before.external);
        const extraStr = Object.entries(extra)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ");
        elizaLogger.info(
            `[MemoryProbe] ${label} elapsed=${Date.now() - t0}ms rss=${before.rss}->${after.rss}MB (Δ${after.rss - before.rss >= 0 ? "+" : ""}${after.rss - before.rss}MB) heap=${before.heapUsed}->${after.heapUsed}MB native=${native >= 0 ? "+" : ""}${native}MB${extraStr ? " " + extraStr : ""}`
        );
        return result;
    } catch (err) {
        const after = memSnapshotMB();
        elizaLogger.warn(
            `[MemoryProbe] ${label} FAILED elapsed=${Date.now() - t0}ms rss=${before.rss}->${after.rss}MB`
        );
        throw err;
    }
}

/**
 * Periodic memory sampler. Returns a stop function. Call `start()` at the
 * beginning of a workflow you want to profile, `stop()` when it's done.
 *
 * The sampler runs on `setInterval` so it doesn't itself consume meaningful
 * memory or CPU. Each tick emits one `[MemoryProbe] sampler` line.
 */
export function startMemSampler(label: string, intervalMs = 10_000): () => void {
    const t0 = Date.now();
    const handle = setInterval(() => {
        const m = memSnapshotMB();
        const native = m.rss - m.heapUsed - m.external;
        elizaLogger.info(
            `[MemoryProbe] sampler.${label} t+${Math.round((Date.now() - t0) / 1000)}s rss=${m.rss}MB heap=${m.heapUsed}MB external=${m.external}MB native=${native}MB`
        );
    }, intervalMs);
    handle.unref?.(); // never block process exit
    return () => clearInterval(handle);
}
