import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
    GetObjectCommand,
    ListObjectsV2Command,
    S3Client,
} from "@aws-sdk/client-s3";
import {
    elizaLogger,
    logMemProbe,
    SCHEDULER_CANONICAL_SYMBOL_KEY,
    stringToUuid,
    withMemProbe,
    type AgentRuntime,
    type Memory,
    type UUID,
} from "@elizaos/core";

interface DailyAnalysisSchedulerOptions {
    enabled: boolean;
    hourUTC: number;
    /** When set, catch-up waits until this returns 0 (polling up to 30 min). */
    getActiveRequests?: () => number;
    /**
     * Target symbols to generate a daily report for, in run order. The scheduler
     * runs them sequentially (the comprehensive workflow holds a per-user mutex
     * and ~6 GB resident, so parallel runs are rejected and would OOM the ECS
     * task anyway).
     */
    targetSymbols: string[];
    retryDelayMs?: number;
    maxRetries?: number;
}

interface SchedulerStatus {
    enabled: boolean;
    isRunning: boolean;
    /** Primary symbol — first entry of `targetSymbols`, kept for back-compat. */
    targetSymbol: string;
    targetSymbols: string[];
    hourUTC: number;
    lastRunDate: string | null;
    lastRunStatus: "success" | "failure" | "skipped" | null;
    lastError: string | null;
    /** True iff every symbol in `targetSymbols` has a report for today. */
    todayReportExists: boolean;
    /** Per-symbol map of whether today's report already exists on disk. */
    todayReports: Record<string, boolean>;
    nextScheduledRun: string | null;
}

// Symbol → human-readable name for the scheduler message `text` field only.
// Target resolution for scheduled runs comes from `SCHEDULER_CANONICAL_SYMBOL_KEY`
// (see comprehensive workflow); unmapped symbols use the ticker as the display name.
const SYMBOL_FRIENDLY_NAMES: Record<string, string> = {
    BTC: "Bitcoin",
    ETH: "Ethereum",
    SOL: "Solana",
    XRP: "Ripple",
    DOGE: "Dogecoin",
    ADA: "Cardano",
    AVAX: "Avalanche",
    BNB: "BNB",
};

function friendlyAssetName(symbol: string): string {
    return SYMBOL_FRIENDLY_NAMES[symbol.toUpperCase()] ?? symbol;
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const LOG_PREFIX = "[DailyAnalysisScheduler]";
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAILY_REPORTS_DIR_NAME = "DailyReports";
const DAILY_CHARTS_DIR_NAME = "DailyCharts";
const SHARED_CHARTS_DIR_NAME = "Charts";

// S3 layout for scheduler-generated reports (must mirror the upload path in
// comprehensiveAnalysisWorkflowGraph.saveReport when isSchedulerDailyReport=true).
//   auto-daily-reports-agent/{YYYY-MM-DD}/{SYMBOL_UPPER}/comprehensive-analysis-{symbol-lower}-{YYYY-MM-DD}.html
//   auto-daily-reports-agent/{YYYY-MM-DD}/{SYMBOL_UPPER}/comprehensive-analysis-{symbol-lower}-{YYYY-MM-DD}.meta.json
const AUTO_DAILY_REPORTS_S3_PREFIX = "auto-daily-reports-agent/";
const DEFAULT_S3_SYNC_DAYS_BACK = 7;

// Catch-up guard: protects against a crash loop where a failing catch-up run
// is immediately retriggered by ECS restart / runtime-available events.
const CATCHUP_GRACE_MS = 90_000;
const MAX_CATCHUP_ATTEMPTS_PER_DAY = 3;
const CATCHUP_STATE_FILE_NAME = "scheduler_catchup_state.json";
const CATCHUP_TRAFFIC_POLL_MS = 60_000;
const CATCHUP_TRAFFIC_MAX_WAIT_MS = 30 * 60_000;

// Startup delay before the scheduler's first catch-up run.
//
// Comprehensive analysis is the heaviest workload the agent runs (BGE-M3 +
// 12 actions + LARGE-class generation, ~5 min wall-clock, ~6 GB resident).
// Firing it immediately on task boot competed with user traffic during the
// warm-up window and triggered ALB health-check failures on staging on
// 2026-04-26 (ECS event log: "Amazon ECS replaced 1 tasks due to an
// unhealthy status").
//
// Was 1 h originally for warmup safety, but that interacted badly with
// container churn: any restart inside the 1-h window dropped the catch-up
// timer entirely, and reports for the day never got generated. 10 min is
// long enough for BGE-M3 to load and DocumentDB index probes to finish
// (both well under 5 min on the prod task), short enough to actually fire
// before the average ECS task replacement cycle.
//
// Override with DAILY_ANALYSIS_FIRST_RUN_DELAY_MS (0 = run immediately).
// For one-shot debugging, set DAILY_ANALYSIS_RUN_ON_STARTUP=true to bypass.
const DEFAULT_STARTUP_DELAY_MS = 10 * 60 * 1000;
function getStartupDelayMs(): number {
    const raw = Number(process.env.DAILY_ANALYSIS_FIRST_RUN_DELAY_MS);
    if (!Number.isFinite(raw) || raw < 0) return DEFAULT_STARTUP_DELAY_MS;
    return raw;
}

// Recovery poll: defends against missed scheduled ticks across container
// restarts. setTimeout/setInterval are in-memory only; if the container
// dies between hourUTC and the next tick, no native timer survives. This
// poll checks every 30 min: if past hourUTC AND today's reports are still
// missing, it triggers a catch-up (which itself is rate-limited by the
// 3-attempt/day guard in runCatchupWithGuard).
const RECOVERY_POLL_INTERVAL_MS = 30 * 60 * 1000;

interface CatchupState {
    date: string;
    attempts: number;
    lastAttemptAt: string;
}

interface StoredReportEntry {
    fileName: string;
    date: string;
    filePath: string;
    symbol: string;
}

interface LoadedReport {
    exists: boolean;
    fileName?: string;
    date?: string;
    symbol?: string;
    summary?: string;
    htmlContent?: string;
    metadata?: unknown;
    relativePath?: string;
}

interface DailyReportChartEntry {
    chartFilename?: string;
}

interface DailyReportMetadata {
    charts?: DailyReportChartEntry[];
}

export class DailyAnalysisSchedulerService {
    private agents: Map<string, AgentRuntime>;
    private enabled: boolean;
    private hourUTC: number;
    private targetSymbols: string[];
    private retryDelayMs: number;
    private maxRetries: number;
    private getActiveRequests?: () => number;

    private isRunning = false;
    private lastRunDate: string | null = null;
    private lastRunStatus: "success" | "failure" | "skipped" | null = null;
    private lastError: string | null = null;

    private initialTimeout?: NodeJS.Timeout;
    private intervalTimer?: NodeJS.Timeout;
    private startupCatchupTimer?: NodeJS.Timeout;
    private recoveryTimer?: NodeJS.Timeout;

    private s3Client: S3Client | null = null;
    private s3Bucket: string;
    /** In-flight S3 sync promise — dedups concurrent calls so multiple lifecycle
     *  hooks (start, notifyRuntimeAvailable, runCatchupWithGuard) share one
     *  download pass instead of stampeding S3. */
    private s3SyncInflight: Promise<void> | null = null;

    constructor(
        agents: Map<string, AgentRuntime>,
        options: DailyAnalysisSchedulerOptions
    ) {
        this.agents = agents;
        this.enabled = options.enabled;
        this.hourUTC = options.hourUTC;

        const normalized = (options.targetSymbols ?? [])
            .map((s) => s.trim().toUpperCase())
            .filter((s) => s.length > 0);
        const deduped = Array.from(new Set(normalized));
        if (deduped.length === 0) {
            throw new Error(
                "DailyAnalysisSchedulerService: targetSymbols must contain at least one symbol"
            );
        }
        this.targetSymbols = deduped;

        this.retryDelayMs = options.retryDelayMs ?? 30_000;
        this.maxRetries = options.maxRetries ?? 3;
        this.getActiveRequests = options.getActiveRequests;

        // Mirror fileStorageService config so the sync pulls from the same bucket
        // the workflow uploads to. ECS task IAM role is used when explicit
        // credentials are absent (default credential chain).
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
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            elizaLogger.warn(
                `${LOG_PREFIX} Could not init S3 client; cross-container sync disabled: ${msg}`
            );
            this.s3Client = null;
        }
    }

    /**
     * Wait until HTTP message traffic subsides so catch-up does not compete
     * with active SSE sessions (best-effort; proceeds after max wait).
     */
    private async waitForLowTraffic(reason: string): Promise<void> {
        const getActive = this.getActiveRequests;
        if (!getActive) {
            return;
        }

        const deadline = Date.now() + CATCHUP_TRAFFIC_MAX_WAIT_MS;
        while (getActive() > 0) {
            if (Date.now() >= deadline) {
                elizaLogger.warn(
                    `${LOG_PREFIX} Catch-up (${reason}): traffic still active after ${CATCHUP_TRAFFIC_MAX_WAIT_MS / 60_000} min; proceeding anyway.`
                );
                return;
            }
            elizaLogger.info(
                `${LOG_PREFIX} Catch-up (${reason}) deferred: ${getActive()} active request(s); waiting ${CATCHUP_TRAFFIC_POLL_MS / 1000}s...`
            );
            await new Promise<void>((r) => setTimeout(r, CATCHUP_TRAFFIC_POLL_MS));
        }
    }

    /** Primary symbol (first configured) — kept for back-compat in logs. */
    private get primarySymbol(): string {
        return this.targetSymbols[0];
    }

    public start(): void {
        // Gate: DAILY_ANALYSIS_ENABLED defaults to true; only "false" disables.
        // (Constructor reads `process.env.DAILY_ANALYSIS_ENABLED !== "false"`.)
        if (!this.enabled) {
            elizaLogger.info(
                `${LOG_PREFIX} Scheduler is disabled (DAILY_ANALYSIS_ENABLED == "false")`
            );
            return;
        }

        // Arm the recurring tick first so the next-run timer is always set,
        // independent of how long the S3 sync takes (or whether it fails).
        const msUntilNext = this.msUntilNextRun();
        const minutesUntilNext = Math.round(msUntilNext / 60_000);
        const startupDelayMs = getStartupDelayMs();
        const runOnStartup = process.env.DAILY_ANALYSIS_RUN_ON_STARTUP === "true";

        // Single startup line that fully describes scheduler config so anyone
        // grepping CloudWatch can confirm enablement without reading code.
        elizaLogger.info(
            `${LOG_PREFIX} Scheduler started. ` +
            `targets=[${this.targetSymbols.join(", ")}] hourUTC=${this.hourUTC} ` +
            `nextRun=${new Date(Date.now() + msUntilNext).toISOString()} (in ${minutesUntilNext}m) ` +
            `startupDelay=${Math.round(startupDelayMs / 60_000)}m runOnStartup=${runOnStartup} ` +
            `recoveryPoll=${Math.round(RECOVERY_POLL_INTERVAL_MS / 60_000)}m ` +
            `s3Bucket=${this.s3Bucket} s3Sync=${this.s3Client ? "enabled" : "disabled"}`
        );

        this.initialTimeout = setTimeout(() => {
            void this.executeDailyAnalysis();

            this.intervalTimer = setInterval(() => {
                void this.executeDailyAnalysis();
            }, MS_PER_DAY);
        }, msUntilNext);

        // Recovery poll: setTimeout/setInterval lose state across container
        // replacements, so a task that crashes between hourUTC and the next
        // tick would silently skip today's run. The poll re-checks every
        // RECOVERY_POLL_INTERVAL_MS and triggers catchup if today is past
        // hourUTC and reports are still missing — capped by the 3-attempt/day
        // guard in runCatchupWithGuard so a persistently-failing workflow
        // cannot thrash.
        this.recoveryTimer = setInterval(() => {
            void this.maybeRecoverMissedRun().catch((err) => {
                elizaLogger.warn(
                    `${LOG_PREFIX} Recovery poll failed: ${err instanceof Error ? err.message : String(err)}`
                );
            });
        }, RECOVERY_POLL_INTERVAL_MS);

        // Sync prior containers' work from S3 into the local cache, then
        // decide whether today's run was missed. Run in the background so
        // a slow S3 list does not block agent startup.
        void this.bootstrapFromS3AndScheduleCatchup().catch((err) => {
            elizaLogger.error(
                `${LOG_PREFIX} S3 bootstrap failed: ${err instanceof Error ? err.message : String(err)}`
            );
        });
    }

    /**
     * Pull recent days from S3 into the local cache, then schedule a startup
     * catch-up if today's reports are still missing after the sync. Called
     * from start() in the background.
     */
    private async bootstrapFromS3AndScheduleCatchup(): Promise<void> {
        await this.syncFromS3();

        // If today's scheduled hour has already passed and no report exists,
        // run a catch-up. Default delay is 10 min for warmup; the recovery
        // poll keeps trying every 30 min after that if the catch-up itself
        // misses. Set DAILY_ANALYSIS_RUN_ON_STARTUP=true to bypass the delay
        // entirely (useful for one-shot debugging in production).
        const now = new Date();
        const missedToday =
            now.getUTCHours() >= this.hourUTC && !this.hasReportForToday();

        if (!missedToday) {
            return;
        }

        const runOnStartup = process.env.DAILY_ANALYSIS_RUN_ON_STARTUP === "true";
        const startupDelayMs = runOnStartup ? 0 : getStartupDelayMs();
        const delayMin = Math.round(startupDelayMs / 60_000);
        elizaLogger.info(
            `${LOG_PREFIX} Missed today's scheduled run; deferring catch-up by ${delayMin} min (runOnStartup=${runOnStartup}, override via DAILY_ANALYSIS_FIRST_RUN_DELAY_MS).`
        );
        this.startupCatchupTimer = setTimeout(() => {
            this.startupCatchupTimer = undefined;
            void this.runCatchupWithGuard("startup").catch((err) => {
                elizaLogger.error(
                    `${LOG_PREFIX} Catch-up guard failed: ${err instanceof Error ? err.message : String(err)}`
                );
            });
        }, startupDelayMs);
    }

    /**
     * Periodic safety check, fired by `recoveryTimer`. The native one-shot
     * timers in start() do not survive container restarts; without this
     * poll a task that crashes between hourUTC and the next 24-h tick
     * would silently skip today entirely.
     *
     * Cheap (one S3 list + filesystem stat per call), and rate-limited by
     * the per-day attempt cap inside runCatchupWithGuard, so it cannot
     * thrash the heavy workflow.
     */
    private async maybeRecoverMissedRun(): Promise<void> {
        if (!this.enabled || this.isRunning) return;

        const now = new Date();
        if (now.getUTCHours() < this.hourUTC) return;

        await this.syncFromS3().catch((err) => {
            elizaLogger.warn(
                `${LOG_PREFIX} S3 sync (recovery) warned: ${err instanceof Error ? err.message : String(err)}`
            );
        });

        if (this.hasReportForToday()) return;

        elizaLogger.info(
            `${LOG_PREFIX} Recovery poll: ${this.todayDateString()} reports still missing past ${this.hourUTC}:00 UTC. Triggering catch-up.`
        );
        await this.runCatchupWithGuard("recovery-poll");
    }

    public stop(): void {
        if (this.startupCatchupTimer) {
            clearTimeout(this.startupCatchupTimer);
            this.startupCatchupTimer = undefined;
        }
        if (this.initialTimeout) {
            clearTimeout(this.initialTimeout);
            this.initialTimeout = undefined;
        }
        if (this.intervalTimer) {
            clearInterval(this.intervalTimer);
            this.intervalTimer = undefined;
        }
        if (this.recoveryTimer) {
            clearInterval(this.recoveryTimer);
            this.recoveryTimer = undefined;
        }
        elizaLogger.info(`${LOG_PREFIX} Scheduler stopped.`);
    }

    public async triggerNow(): Promise<{
        success: boolean;
        reportPath?: string;
        reportPaths?: string[];
        bySymbol?: Record<string, { success: boolean; reportPath?: string; error?: string }>;
        error?: string;
    }> {
        elizaLogger.info(`${LOG_PREFIX} Manual trigger requested.`);
        return this.executeDailyAnalysis();
    }

    public getStatus(): SchedulerStatus {
        const todayReports: Record<string, boolean> = {};
        for (const symbol of this.targetSymbols) {
            todayReports[symbol] = this.hasReportForSymbolToday(symbol);
        }

        return {
            enabled: this.enabled,
            isRunning: this.isRunning,
            targetSymbol: this.primarySymbol,
            targetSymbols: [...this.targetSymbols],
            hourUTC: this.hourUTC,
            lastRunDate: this.lastRunDate,
            lastRunStatus: this.lastRunStatus,
            lastError: this.lastError,
            todayReportExists: this.hasReportForToday(),
            todayReports,
            nextScheduledRun: this.enabled
                ? new Date(Date.now() + this.msUntilNextRun()).toISOString()
                : null,
        };
    }

    public setEnabled(enabled: boolean): void {
        if (this.enabled === enabled) return;

        this.enabled = enabled;
        if (enabled) {
            this.start();
        } else {
            this.stop();
        }
        elizaLogger.info(
            `${LOG_PREFIX} Scheduler ${enabled ? "enabled" : "disabled"} at runtime.`
        );
    }

    // ── Internal ────────────────────────────────────────────────

    private async executeDailyAnalysis(): Promise<{
        success: boolean;
        reportPath?: string;
        reportPaths?: string[];
        bySymbol?: Record<string, { success: boolean; reportPath?: string; error?: string }>;
        error?: string;
    }> {
        if (this.isRunning) {
            elizaLogger.warn(
                `${LOG_PREFIX} Analysis already in progress, skipping.`
            );
            return { success: false, error: "Already running" };
        }

        const today = this.todayDateString();

        if (this.hasReportForToday()) {
            elizaLogger.info(
                `${LOG_PREFIX} Reports for [${this.targetSymbols.join(", ")}] on ${today} already exist, skipping.`
            );
            this.lastRunDate = today;
            this.lastRunStatus = "skipped";
            return { success: true, reportPath: undefined, reportPaths: [] };
        }

        this.isRunning = true;

        const reportPaths: string[] = [];
        const bySymbol: Record<string, { success: boolean; reportPath?: string; error?: string }> = {};
        const failures: string[] = [];

        try {
            const runtime = await this.getRuntime();
            if (!runtime) {
                const err = "No AgentRuntime available after retries";
                elizaLogger.error(`${LOG_PREFIX} ${err}`);
                this.lastRunDate = today;
                this.lastRunStatus = "failure";
                this.lastError = err;
                return { success: false, error: err };
            }

            const userId = stringToUuid(
                "daily-analysis-scheduler"
            ) as UUID;

            // Run each symbol sequentially. The comprehensive workflow holds a
            // process-wide single-flight gate; any concurrent caller is rejected
            // with an "agent busy" error. Even without the gate, parallel runs
            // would OOM the task (each peaks at ~13 GB resident on a 16 GB ECS
            // container — observed in CloudWatch on 2026-05-04).
            for (const symbol of this.targetSymbols) {
                if (this.hasReportForSymbolToday(symbol)) {
                    elizaLogger.info(
                        `${LOG_PREFIX} ${symbol} report for ${today} already exists, skipping.`
                    );
                    bySymbol[symbol] = { success: true };
                    continue;
                }

                const symbolResult = await this.runForSymbol(runtime, userId, symbol, today);
                bySymbol[symbol] = symbolResult;

                if (symbolResult.success && symbolResult.reportPath) {
                    reportPaths.push(symbolResult.reportPath);
                } else if (!symbolResult.success) {
                    failures.push(`${symbol}: ${symbolResult.error ?? "unknown error"}`);
                }
            }

            if (failures.length > 0) {
                const errMsg = `Analysis failed for: ${failures.join("; ")}`;
                elizaLogger.warn(`${LOG_PREFIX} ${errMsg}`);
                // Some symbols may have succeeded; record the failure but keep
                // any successful paths in the response so the API still reports
                // partial progress. lastRunDate is left unchanged so the next
                // cron tick retries the failed symbols (per-symbol skip means
                // already-successful ones won't redo work).
                this.lastRunStatus = "failure";
                this.lastError = errMsg;
                return {
                    success: false,
                    reportPath: reportPaths[0],
                    reportPaths,
                    bySymbol,
                    error: errMsg,
                };
            }

            elizaLogger.info(
                `${LOG_PREFIX} Analysis completed successfully for [${this.targetSymbols.join(", ")}]. Daily reports: ${reportPaths.join(", ") || "(all already existed)"}`
            );
            this.lastRunDate = today;
            this.lastRunStatus = "success";
            this.lastError = null;
            return {
                success: true,
                reportPath: reportPaths[0],
                reportPaths,
                bySymbol,
            };
        } catch (error: unknown) {
            const errMsg =
                error instanceof Error ? error.message : String(error);
            elizaLogger.error(
                `${LOG_PREFIX} Analysis failed: ${errMsg}`
            );
            this.lastRunDate = today;
            this.lastRunStatus = "failure";
            this.lastError = errMsg;
            return { success: false, error: errMsg, bySymbol };
        } finally {
            this.isRunning = false;
        }
    }

    /**
     * Run the comprehensive analysis workflow for a single symbol and archive
     * the produced report into `saved_data/DailyReports/`. Returns the archived
     * path on success.
     */
    private async runForSymbol(
        runtime: AgentRuntime,
        userId: UUID,
        symbol: string,
        today: string
    ): Promise<{ success: boolean; reportPath?: string; error?: string }> {
        // [debug-leak] Probe at the very top of runForSymbol — captures RSS the
        // instant the scheduler invokes the per-symbol path. Pairs with
        // `runtime.composeState` and `workflow:start` probes downstream so we
        // can localize where the silent +3 GB jump happens during the 57-second
        // window between the scheduler trigger and workflow:start.
        logMemProbe("scheduler.runForSymbol:enter", { symbol });

        const roomId = stringToUuid(
            `daily-analysis-room-${symbol}`
        ) as UUID;

        try {
            await withMemProbe(
                "scheduler.ensureConnection",
                () =>
                    runtime.ensureConnection(
                        userId,
                        roomId,
                        "DailyAnalysisScheduler",
                        "DailyAnalysisScheduler",
                        "scheduler"
                    ),
                { symbol }
            );

            const message: Memory = {
                id: stringToUuid(
                    `daily-analysis-${symbol}-${today}`
                ) as UUID,
                userId,
                agentId: runtime.agentId,
                roomId,
                content: {
                    text: `Run comprehensive analysis for ${friendlyAssetName(symbol)} (${symbol})`,
                    source: "scheduler",
                    [SCHEDULER_CANONICAL_SYMBOL_KEY]: symbol,
                },
                createdAt: Date.now(),
            };

            elizaLogger.info(
                `${LOG_PREFIX} Starting comprehensive analysis for ${symbol}...`
            );

            const result = await withMemProbe(
                "scheduler.handleComprehensiveAnalysis",
                () => runtime.handleComprehensiveAnalysis(message),
                { symbol }
            );

            const reportMeta = result?.find(
                (memory) =>
                    this.getReportPathFromMemory(memory) !== undefined ||
                    memory.content?.source === "comprehensive_analysis"
            );
            const generatedReportPath = reportMeta
                ? this.getReportPathFromMemory(reportMeta)
                : undefined;

            if (!generatedReportPath) {
                // Runtime returned an errorMemory (workflow failure). Extract
                // the inner error so production logs surface the actual root
                // cause instead of a generic "no report produced". Log as
                // ERROR (was WARN) so CloudWatch metric filters can alert on
                // scheduler failures.
                const failureMemory = result?.find(
                    (memory) => memory.content?.error
                );
                const innerError = failureMemory
                    ? (failureMemory.content?.error as { message?: string } | undefined)?.message
                    : undefined;
                const errMsg = innerError
                    ? `Analysis for ${symbol} failed: ${innerError}`
                    : `Analysis for ${symbol} completed but no report was produced`;
                elizaLogger.error(`${LOG_PREFIX} ${errMsg}`);
                return { success: false, error: errMsg };
            }

            const archivedReportPath = this.archiveDailyReport(generatedReportPath);

            elizaLogger.info(
                `${LOG_PREFIX} ${symbol} report archived: ${archivedReportPath ?? generatedReportPath}`
            );

            return {
                success: true,
                reportPath: archivedReportPath ?? generatedReportPath,
            };
        } catch (error: unknown) {
            const errMsg = error instanceof Error ? error.message : String(error);
            elizaLogger.error(`${LOG_PREFIX} ${symbol} analysis failed: ${errMsg}`);
            return { success: false, error: errMsg };
        }
    }

    private getCatchupStatePath(): string {
        return path.join(
            process.cwd(),
            "saved_data",
            CATCHUP_STATE_FILE_NAME
        );
    }

    private readCatchupState(): CatchupState | null {
        try {
            const p = this.getCatchupStatePath();
            if (!fs.existsSync(p)) return null;
            const raw = fs.readFileSync(p, "utf-8");
            const parsed = JSON.parse(raw) as Partial<CatchupState>;
            if (
                typeof parsed.date !== "string" ||
                typeof parsed.attempts !== "number" ||
                typeof parsed.lastAttemptAt !== "string"
            ) {
                return null;
            }
            return parsed as CatchupState;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            elizaLogger.warn(
                `${LOG_PREFIX} Failed to read catch-up state: ${msg}`
            );
            return null;
        }
    }

    private writeCatchupState(state: CatchupState): void {
        try {
            const p = this.getCatchupStatePath();
            const dir = path.dirname(p);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const tmp = `${p}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
            fs.renameSync(tmp, p);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            elizaLogger.warn(
                `${LOG_PREFIX} Failed to write catch-up state: ${msg}`
            );
        }
    }

    private resetCatchupState(): void {
        try {
            const p = this.getCatchupStatePath();
            if (fs.existsSync(p)) {
                fs.unlinkSync(p);
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            elizaLogger.warn(
                `${LOG_PREFIX} Failed to reset catch-up state: ${msg}`
            );
        }
    }

    /**
     * Guarded catch-up: enforces a startup grace period and per-day retry cap
     * so a crashing task cannot thrash ECS by re-triggering catch-up on each
     * restart.
     */
    private async runCatchupWithGuard(reason: string): Promise<void> {
        const today = this.todayDateString();
        const existing = this.readCatchupState();

        let attempts = 0;
        if (existing && existing.date === today) {
            attempts = existing.attempts;
        }

        if (attempts >= MAX_CATCHUP_ATTEMPTS_PER_DAY) {
            elizaLogger.warn(
                `${LOG_PREFIX} Catch-up aborted (${reason}): ${attempts} attempts already today (max ${MAX_CATCHUP_ATTEMPTS_PER_DAY}). Waiting for the next scheduled run.`
            );
            return;
        }

        const nextAttempts = attempts + 1;
        this.writeCatchupState({
            date: today,
            attempts: nextAttempts,
            lastAttemptAt: new Date().toISOString(),
        });

        elizaLogger.info(
            `${LOG_PREFIX} Missed today's analysis (${reason}). Catch-up attempt ${nextAttempts}/${MAX_CATCHUP_ATTEMPTS_PER_DAY}. Waiting ${CATCHUP_GRACE_MS / 1000}s grace period before running.`
        );

        await new Promise<void>((r) => setTimeout(r, CATCHUP_GRACE_MS));

        // Re-pull from S3 before deciding to spend ~15 min regenerating.
        // Another container may have produced the report after this guard armed.
        await this.syncFromS3().catch((err) => {
            elizaLogger.warn(
                `${LOG_PREFIX} S3 sync (catchup) warned: ${err instanceof Error ? err.message : String(err)}`
            );
        });

        // Re-check after grace: another process or prior run may have produced
        // the report during the wait, or S3 sync just pulled it down.
        if (this.hasReportForToday()) {
            elizaLogger.info(
                `${LOG_PREFIX} Report for ${today} appeared during grace period; catch-up skipped.`
            );
            this.resetCatchupState();
            return;
        }

        await this.waitForLowTraffic(reason);

        const result = await this.executeDailyAnalysis();
        if (result.success) {
            this.resetCatchupState();
        }
    }

    private async getRuntime(): Promise<AgentRuntime | null> {
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            const first = this.agents.values().next();
            if (!first.done && first.value) {
                return first.value;
            }
            if (attempt < this.maxRetries) {
                elizaLogger.warn(
                    `${LOG_PREFIX} No agents available (attempt ${attempt + 1}/${this.maxRetries}), retrying in ${this.retryDelayMs}ms...`
                );
                await new Promise((r) => setTimeout(r, this.retryDelayMs));
            }
        }
        return null;
    }

    /**
     * True iff *every* configured target symbol has a report on disk for today.
     * The scheduler uses this as the top-level skip check so partial coverage
     * (e.g. BTC done but ETH still missing) still triggers a run that picks up
     * the missing symbol.
     */
    private hasReportForToday(): boolean {
        return this.targetSymbols.every((symbol) =>
            this.hasReportForSymbolToday(symbol)
        );
    }

    private hasReportForSymbolToday(symbol: string): boolean {
        const today = this.todayDateString();
        const fileName = `comprehensive analysis ${symbol} ${today}.html`;

        const searchDirs = this.getDailyReportSearchDirs();

        return searchDirs.some((dir) => {
            const filePath = path.join(dir, fileName);
            return fs.existsSync(filePath);
        });
    }

    private todayDateString(): string {
        return new Date().toISOString().split("T")[0];
    }

    private msUntilNextRun(): number {
        const now = new Date();
        const next = new Date(now);
        next.setUTCHours(this.hourUTC, 0, 0, 0);

        if (next.getTime() <= now.getTime()) {
            next.setUTCDate(next.getUTCDate() + 1);
        }

        return next.getTime() - now.getTime();
    }

    private getDailyReportSearchDirs(): string[] {
        return [
            path.join(process.cwd(), "saved_data", DAILY_REPORTS_DIR_NAME),
            path.join(process.cwd(), "agent", "saved_data", DAILY_REPORTS_DIR_NAME),
        ];
    }

    private getSharedChartSearchDirs(): string[] {
        return [
            path.join(process.cwd(), "saved_data", SHARED_CHARTS_DIR_NAME),
            path.join(process.cwd(), "agent", "saved_data", SHARED_CHARTS_DIR_NAME),
        ];
    }

    private listReports(): StoredReportEntry[] {
        const symbolsAlt = this.targetSymbols.map(escapeRegex).join("|");
        const pattern = new RegExp(
            `^comprehensive analysis (${symbolsAlt}) (\\d{4}-\\d{2}-\\d{2})\\.html$`
        );

        const reports = new Map<string, StoredReportEntry>();

        const collectReports = (dirs: string[]) => {
            for (const dir of dirs) {
                if (!fs.existsSync(dir)) continue;
                const files = fs.readdirSync(dir);
                for (const file of files) {
                    if (reports.has(file)) continue;
                    const match = file.match(pattern);
                    if (!match) continue;
                    reports.set(file, {
                        fileName: file,
                        symbol: match[1],
                        date: match[2],
                        filePath: path.join(dir, file),
                    });
                }
            }
        };

        collectReports(this.getDailyReportSearchDirs());

        // Sort newest-first; on equal dates, fall back to the configured order
        // of `targetSymbols` so the primary symbol (typically BTC) wins ties.
        const symbolOrder = new Map(
            this.targetSymbols.map((s, i) => [s, i] as const)
        );
        return Array.from(reports.values()).sort((a, b) => {
            const dateCmp = b.date.localeCompare(a.date);
            if (dateCmp !== 0) return dateCmp;
            const aOrder = symbolOrder.get(a.symbol) ?? Number.MAX_SAFE_INTEGER;
            const bOrder = symbolOrder.get(b.symbol) ?? Number.MAX_SAFE_INTEGER;
            return aOrder - bOrder;
        });
    }

    /**
     * Mirror recent days of the `auto-daily-reports-agent/` S3 prefix into the
     * local `saved_data/DailyReports/` cache.
     *
     * Why this exists: the read path (listReports / hasReportForToday /
     * getRecentReports) only inspects local disk. ECS tasks have ephemeral
     * disk that is wiped on every redeploy, so without this sync a fresh
     * container shows an empty Daily Analysis section even when prior
     * containers already uploaded today's reports to S3 — and would
     * needlessly re-run the heavy 15-minute analysis.
     *
     * Best-effort: any failure (creds, network, NoSuchBucket) downgrades to a
     * warning. The scheduler still arms its next-run timer in start().
     *
     * Idempotent: skips files already present locally with non-zero size.
     */
    public async syncFromS3(daysBack = DEFAULT_S3_SYNC_DAYS_BACK): Promise<void> {
        if (this.s3SyncInflight) {
            return this.s3SyncInflight;
        }
        const client = this.s3Client;
        if (!client) {
            return;
        }

        this.s3SyncInflight = (async () => {
            const localDir = path.join(
                process.cwd(),
                "saved_data",
                DAILY_REPORTS_DIR_NAME
            );
            try {
                if (!fs.existsSync(localDir)) {
                    fs.mkdirSync(localDir, { recursive: true });
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                elizaLogger.warn(
                    `${LOG_PREFIX} S3 sync: failed to create ${localDir}: ${msg}`
                );
                return;
            }

            const dates = this.recentUTCDates(daysBack);
            let downloaded = 0;
            let skipped = 0;

            for (const date of dates) {
                for (const symbol of this.targetSymbols) {
                    const prefix = `${AUTO_DAILY_REPORTS_S3_PREFIX}${date}/${symbol}/`;
                    let keys: string[];
                    try {
                        keys = await this.listS3Keys(client, prefix);
                    } catch (err: unknown) {
                        const msg = err instanceof Error ? err.message : String(err);
                        elizaLogger.warn(
                            `${LOG_PREFIX} S3 sync: list ${prefix} failed: ${msg}`
                        );
                        continue;
                    }

                    for (const key of keys) {
                        const localName = this.canonicalLocalNameFromS3Key(
                            key,
                            symbol,
                            date
                        );
                        if (!localName) continue;

                        const localPath = path.join(localDir, localName);
                        if (this.localFileExistsAndNonEmpty(localPath)) {
                            skipped++;
                            continue;
                        }

                        try {
                            await this.downloadS3ObjectToFile(
                                client,
                                key,
                                localPath
                            );
                            downloaded++;
                        } catch (err: unknown) {
                            const msg = err instanceof Error ? err.message : String(err);
                            elizaLogger.warn(
                                `${LOG_PREFIX} S3 sync: download ${key} failed: ${msg}`
                            );
                        }
                    }
                }
            }

            elizaLogger.info(
                `${LOG_PREFIX} S3 sync complete (window=${daysBack}d, downloaded=${downloaded}, already-local=${skipped}).`
            );
        })();

        try {
            await this.s3SyncInflight;
        } finally {
            this.s3SyncInflight = null;
        }
    }

    private async listS3Keys(client: S3Client, prefix: string): Promise<string[]> {
        const out: string[] = [];
        let continuationToken: string | undefined;
        do {
            const resp = await client.send(
                new ListObjectsV2Command({
                    Bucket: this.s3Bucket,
                    Prefix: prefix,
                    ContinuationToken: continuationToken,
                })
            );
            for (const obj of resp.Contents ?? []) {
                if (obj.Key) out.push(obj.Key);
            }
            continuationToken = resp.IsTruncated
                ? resp.NextContinuationToken
                : undefined;
        } while (continuationToken);
        return out;
    }

    private async downloadS3ObjectToFile(
        client: S3Client,
        s3Key: string,
        destPath: string
    ): Promise<void> {
        const resp = await client.send(
            new GetObjectCommand({ Bucket: this.s3Bucket, Key: s3Key })
        );
        const body = resp.Body;
        if (!body) {
            throw new Error(`Empty body for ${s3Key}`);
        }
        const tmp = `${destPath}.tmp`;
        if (typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === "function") {
            const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
            await fs.promises.writeFile(tmp, Buffer.from(bytes));
        } else if (body instanceof Readable) {
            await pipeline(body, fs.createWriteStream(tmp));
        } else {
            throw new Error(`Unsupported S3 body stream for ${s3Key}`);
        }
        await fs.promises.rename(tmp, destPath);
    }

    /**
     * Map an S3 key under `auto-daily-reports-agent/` to the canonical local
     * filename used by `archiveDailyReport()` and read by `listReports()`.
     *
     * S3 names use kebab-case lowercase symbol; local names use spaced
     * uppercase symbol — keep both in sync with comprehensiveAnalysisWorkflowGraph.
     */
    private canonicalLocalNameFromS3Key(
        s3Key: string,
        symbol: string,
        date: string
    ): string | null {
        const basename = s3Key.split("/").pop() ?? "";
        if (basename.endsWith(".meta.json")) {
            return `comprehensive analysis ${symbol} ${date}.meta.json`;
        }
        if (basename.endsWith(".html")) {
            return `comprehensive analysis ${symbol} ${date}.html`;
        }
        return null;
    }

    private localFileExistsAndNonEmpty(p: string): boolean {
        try {
            const st = fs.statSync(p);
            return st.isFile() && st.size > 0;
        } catch {
            return false;
        }
    }

    private recentUTCDates(daysBack: number): string[] {
        const out: string[] = [];
        const now = new Date();
        for (let i = 0; i < daysBack; i++) {
            const d = new Date(
                Date.UTC(
                    now.getUTCFullYear(),
                    now.getUTCMonth(),
                    now.getUTCDate() - i
                )
            );
            out.push(d.toISOString().split("T")[0]);
        }
        return out;
    }

    private archiveDailyReport(reportPath: string): string {
        if (!fs.existsSync(reportPath)) {
            throw new Error(`Generated report not found: ${reportPath}`);
        }

        const reportsDir = path.dirname(reportPath);
        const savedDataDir = path.dirname(reportsDir);
        const dailyReportsDir = path.join(savedDataDir, DAILY_REPORTS_DIR_NAME);

        if (!fs.existsSync(dailyReportsDir)) {
            fs.mkdirSync(dailyReportsDir, { recursive: true });
        }

        const fileName = path.basename(reportPath);
        const archivedPath = path.join(dailyReportsDir, fileName);
        if (reportPath === archivedPath) {
            return archivedPath;
        }
        fs.copyFileSync(reportPath, archivedPath);

        const metaSourcePath = reportPath.replace(".html", ".meta.json");
        const metaArchivedPath = archivedPath.replace(".html", ".meta.json");
        let metadata: unknown = null;
        if (fs.existsSync(metaSourcePath)) {
            fs.copyFileSync(metaSourcePath, metaArchivedPath);
            metadata = this.readMetadataFile(metaSourcePath);
        }

        if (metadata) {
            this.archiveDailyCharts(savedDataDir, metadata);
        }

        return archivedPath;
    }

    private toRelativeReportPath(filePath: string): string {
        const normalized = filePath.replace(/\\/g, "/");
        const savedDataMarker = "/saved_data/";
        const savedDataIndex = normalized.lastIndexOf(savedDataMarker);

        if (savedDataIndex >= 0) {
            return normalized.slice(savedDataIndex + savedDataMarker.length);
        }

        return path.basename(filePath);
    }

    private getReportPathFromMemory(memory: Memory): string | undefined {
        const metadata = memory.content?.metadata;
        if (!metadata || typeof metadata !== "object") {
            return undefined;
        }

        const reportPath = (metadata as Record<string, unknown>).reportPath;
        return typeof reportPath === "string" ? reportPath : undefined;
    }

    private readMetadataFile(metaPath: string): unknown {
        try {
            return JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        } catch {
            return null;
        }
    }

    private getChartFilenames(metadata: unknown): string[] {
        if (!metadata || typeof metadata !== "object") {
            return [];
        }

        const charts = (metadata as DailyReportMetadata).charts;
        if (!Array.isArray(charts)) {
            return [];
        }

        const chartFilenames = new Set<string>();
        for (const chart of charts) {
            if (
                chart &&
                typeof chart === "object" &&
                typeof chart.chartFilename === "string" &&
                chart.chartFilename.length > 0 &&
                !chart.chartFilename.endsWith(".chart")
            ) {
                chartFilenames.add(chart.chartFilename);
            }
        }

        return Array.from(chartFilenames);
    }

    private findSharedChartPath(chartFilename: string): string | null {
        for (const dir of this.getSharedChartSearchDirs()) {
            const filePath = path.join(dir, chartFilename);
            if (fs.existsSync(filePath)) {
                return filePath;
            }
        }

        return null;
    }

    private archiveDailyCharts(savedDataDir: string, metadata: unknown): void {
        const chartFilenames = this.getChartFilenames(metadata);
        if (chartFilenames.length === 0) {
            return;
        }

        const dailyChartsDir = path.join(savedDataDir, DAILY_CHARTS_DIR_NAME);
        if (!fs.existsSync(dailyChartsDir)) {
            fs.mkdirSync(dailyChartsDir, { recursive: true });
        }

        for (const chartFilename of chartFilenames) {
            const archivedChartPath = path.join(dailyChartsDir, chartFilename);
            if (fs.existsSync(archivedChartPath)) {
                continue;
            }

            const sharedChartPath = this.findSharedChartPath(chartFilename);
            if (!sharedChartPath) {
                elizaLogger.warn(
                    `${LOG_PREFIX} Daily chart archive skipped, source not found: ${chartFilename}`
                );
                continue;
            }

            fs.copyFileSync(sharedChartPath, archivedChartPath);
        }
    }

    private readReport(report: StoredReportEntry): LoadedReport {
        try {
            const htmlContent = fs.readFileSync(report.filePath, "utf-8");
            const summary = this.extractSummary(htmlContent);

            const metaPath = report.filePath.replace(".html", ".meta.json");
            let metadata = null;
            if (fs.existsSync(metaPath)) {
                try {
                    metadata = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
                } catch {
                    metadata = null;
                }
            }

            if (metadata) {
                const savedDataDir = path.dirname(path.dirname(report.filePath));
                this.archiveDailyCharts(savedDataDir, metadata);
            }

            return {
                exists: true,
                fileName: report.fileName,
                date: report.date,
                symbol: report.symbol,
                summary,
                htmlContent,
                metadata,
                relativePath: this.toRelativeReportPath(report.filePath),
            };
        } catch {
            return {
                exists: true,
                fileName: report.fileName,
                date: report.date,
                symbol: report.symbol,
                relativePath: this.toRelativeReportPath(report.filePath),
            };
        }
    }

    /**
     * Find the latest daily analysis report and return its metadata.
     */
    public getLatestReport(): LoadedReport {
        const latestReport = this.listReports()[0];
        if (!latestReport) {
            return { exists: false };
        }

        return this.readReport(latestReport);
    }

    public getReportByFileName(fileName: string): LoadedReport {
        const report = this.listReports().find((entry) => entry.fileName === fileName);
        if (!report) {
            return { exists: false };
        }

        return this.readReport(report);
    }

    public getRecentReports(limit = 3): Array<{
        fileName: string;
        date: string;
        symbol: string;
        summary?: string;
        metadata?: unknown;
        relativePath?: string;
    }> {
        return this.listReports()
            .slice(0, limit)
            .map((report) => {
                const loaded = this.readReport(report);
                return {
                    fileName: loaded.fileName || report.fileName,
                    date: loaded.date || report.date,
                    symbol: loaded.symbol || report.symbol,
                    summary: loaded.summary,
                    metadata: loaded.metadata,
                    relativePath: loaded.relativePath,
                };
            });
    }

    private extractSummary(html: string): string {
        // Try to extract the executive summary section from the HTML report
        const summaryPatterns = [
            /<h[123][^>]*>.*?Executive Summary.*?<\/h[123]>([\s\S]*?)(?=<h[123])/i,
            /<h[123][^>]*>.*?Summary.*?<\/h[123]>([\s\S]*?)(?=<h[123])/i,
            /<div[^>]*class="[^"]*summary[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
        ];

        for (const pattern of summaryPatterns) {
            const match = html.match(pattern);
            if (match?.[1]) {
                // Strip HTML tags and trim
                const text = match[1]
                    .replace(/<[^>]+>/g, " ")
                    .replace(/\s+/g, " ")
                    .trim();
                // Return first ~500 chars
                return text.length > 500
                    ? `${text.substring(0, 497)}...`
                    : text;
            }
        }

        return "";
    }
}
