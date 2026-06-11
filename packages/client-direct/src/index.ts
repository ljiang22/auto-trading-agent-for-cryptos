import {
    composeContext,
    elizaLogger,
    generateCaption,
    generateImage,
    generateMessageResponse,
    generateObject,
    generateText,
    getEmbeddingZeroVector,
    enterUsageTrackingContext,
    messageCompletionFooter,
    ModelClass,
    markStreamClosed,
    markStreamOpen,
    settings,
    startMemSampler,
    stringToUuid,
    TASK_CHAIN_APPROVAL_CANCELLED_BY_DISCONNECT,
    validateUuid,
    type Client,
    type Content,
    type HandlerCallback,
    type IAgentRuntime,
    type Media,
    type Memory,
    type Plugin,
    type AgentRuntime,
    type ProcessingStep,
    type UUID,
} from "@elizaos/core";
import bodyParser from "body-parser";
import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Request as ExpressRequest } from "express";
import * as fs from "fs";
import multer from "multer";
import OpenAI from "openai";
import * as path from "path";
import { z } from "zod";
import { createApiRouter, checkAuthenticated, requireAuth } from "./api.ts";
import { createVerifiableLogApiRouter } from "./verifiable-log-api.ts";
import { FileProcessor } from "./fileProcessor.ts";
import { ImageProcessor } from "@elizaos/core";
import { emailToUserId, getUserIdFromIP, getIPInfo, getUserId, getUserInfo } from "./ipUtils.ts";
import { chatLimiter, ttsLimiter, whisperLimiter, imageLimiter } from "./rateLimiters.ts";
import { cleanupAnonymousHistoryIfExpired } from "./historyCleanup.ts";
import { ReportSyncService } from "./services/reportSyncService.ts";
import { TrendingSentiscoreService } from "./services/trendingSentiscoreService.ts";
import { DailyAnalysisSchedulerService } from "./services/dailyAnalysisSchedulerService.ts";
import { AnalyticsSnapshotService } from "./services/analyticsSnapshotService.ts";
import { validateQuotaBeforeMessage } from "./services/quotaService.ts";
import { fileStorageService } from "./services/fileStorageService.ts";
import { FileWatcherService } from "./services/fileWatcherService.ts";
import { loadJwtPublicKey } from "./auth/verifyJwt";

const ANONYMOUS_DAILY_MESSAGE_LIMIT = 3;
const ANONYMOUS_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const ANONYMOUS_LIMIT_ERROR_CODE = "ANON_DAILY_MESSAGE_LIMIT";

/** Same opt-in as `@elizaos/core` `getLocalDevDataRetentionOverride` — never set in production.
 * Read at call time: core loads `.env` after some imports, so module-scope would be false. */
function isLocalDevModeActive(): boolean {
    return process.env.LOCAL_DEV_MODE?.trim() === "1";
}

// frame-ancestors 'self' replaces X-Frame-Options: DENY — DENY blocks
// same-origin iframes too, which breaks ChartEmbed (<iframe src="/charts/...">).
// In dev the Vite server (5173) and Express (3000) are different origins,
// so 'self' alone blocks the chart iframe; allow the common dev ports.
export const securityHeadersMiddleware: express.RequestHandler = (_req, res, next) => {
    const isProd = process.env.NODE_ENV === 'production';
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
        'Content-Security-Policy',
        isProd
            ? "frame-ancestors 'self'"
            : "frame-ancestors 'self' http://localhost:3000 http://localhost:3001 http://localhost:5173 http://127.0.0.1:3000 http://127.0.0.1:3001 http://127.0.0.1:5173"
    );
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (isProd) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
};

/**
 * Serve Vite's pre-compressed `.br` (preferred) and `.gz` siblings of static
 * assets when the client advertises support. Vite's vite-plugin-compression
 * emits these alongside the original files at Brotli level 11, which is
 * smaller and faster than compression@1.x's runtime gzip.
 *
 * Only intercepts compressible asset types in /assets/ that have a
 * pre-compressed sibling on disk; everything else (HTML, images, etc.)
 * falls through to express.static.
 */
const COMPRESSIBLE_ASSET_RE = /^\/assets\/.+\.(js|css|svg)$/i;
const ASSET_CONTENT_TYPES: Record<string, string> = {
    js: 'application/javascript; charset=UTF-8',
    css: 'text/css; charset=UTF-8',
    svg: 'image/svg+xml',
};
function preCompressedAssetsMiddleware(distPath: string): express.RequestHandler {
    return (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const url = req.url.split('?')[0];
        if (!COMPRESSIBLE_ASSET_RE.test(url)) return next();

        const acceptEnc = String(req.headers['accept-encoding'] || '');
        const ext = url.slice(url.lastIndexOf('.') + 1).toLowerCase();
        const contentType = ASSET_CONTENT_TYPES[ext] ?? 'application/octet-stream';
        const targetPath = path.join(distPath, url);

        const tryServe = (suffix: string, encoding: string): boolean => {
            const filePath = targetPath + suffix;
            let stat: fs.Stats;
            try {
                stat = fs.statSync(filePath);
            } catch {
                return false;
            }
            if (!stat.isFile()) return false;
            // Vary must include Accept-Encoding so caches keyed by URL alone
            // don't serve a brotli body to a gzip-only client.
            res.setHeader('Vary', 'Accept-Encoding');
            res.setHeader('Content-Type', contentType);
            res.setHeader('Content-Encoding', encoding);
            res.setHeader('Content-Length', String(stat.size));
            // Vite-emitted assets carry a content hash in the filename, so
            // we can ship them with an immutable cache header.
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            if (req.method === 'HEAD') {
                res.end();
                return true;
            }
            fs.createReadStream(filePath).pipe(res);
            return true;
        };

        if (acceptEnc.includes('br') && tryServe('.br', 'br')) return;
        if (acceptEnc.includes('gzip') && tryServe('.gz', 'gzip')) return;
        return next();
    };
}

const DEFAULT_ROOM_NAME_REGEX = /^Chat \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const GENERATED_ROOM_TITLE_MAX_LENGTH = 60;

const formatDefaultRoomName = (): string => {
    const now = new Date();
    const pad = (value: number) => value.toString().padStart(2, "0");
    const datePart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const timePart = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    return `Chat ${datePart} ${timePart}`;
};

const isDefaultRoomName = (name: string | null | undefined): boolean => {
    if (!name) {
        return false;
    }
    return DEFAULT_ROOM_NAME_REGEX.test(name.trim());
};

const sanitizeGeneratedRoomTitle = (rawTitle: string | null | undefined): string | null => {
    if (!rawTitle) {
        return null;
    }

    const normalized = rawTitle
        .replace(/["'`“”]+/g, "")
        .replace(/\s+/g, " ")
        .trim();

    if (!normalized) {
        return null;
    }

    if (normalized.length <= GENERATED_ROOM_TITLE_MAX_LENGTH) {
        return normalized;
    }

    return normalized.slice(0, GENERATED_ROOM_TITLE_MAX_LENGTH).trim();
};

export type Middleware = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => void;


async function resolveAuthenticatedUserId(
    runtime: IAgentRuntime,
    userInfo: ReturnType<typeof getUserInfo>,
    fallbackUserId: UUID
): Promise<UUID> {
    if (!userInfo || userInfo.type !== "authenticated" || !userInfo.email) {
        return fallbackUserId;
    }

    try {
        const normalizedEmail = userInfo.email.toLowerCase().trim();
        const adapter = runtime.databaseAdapter as any;
        if (typeof adapter.mergeDuplicateAccountsByEmail === "function") {
            await adapter.mergeDuplicateAccountsByEmail(
                normalizedEmail,
                emailToUserId(normalizedEmail)
            );
        }
        const account = await runtime.databaseAdapter.getAccountByEmail(
            normalizedEmail
        );
        if (account?.id) {
            // Re-assign rooms started anonymously from this IP to the authenticated account.
            // Only fires when the user is on the same IP as their anonymous session.
            const ipUserId = (userInfo as any).fallbackUserId as UUID | undefined;
            if (ipUserId && ipUserId !== (account.id as string)) {
                try {
                    const anonRooms = await runtime.databaseAdapter.getRoomsForParticipant(
                        ipUserId,
                        runtime.agentId
                    );
                    for (const roomId of anonRooms) {
                        await runtime.databaseAdapter.addParticipant(account.id as UUID, roomId, runtime.agentId);
                        await runtime.databaseAdapter.removeParticipant(ipUserId, roomId);
                    }
                    if (anonRooms.length > 0) {
                        elizaLogger.info(`[auth] Re-assigned ${anonRooms.length} anonymous room(s) from ${ipUserId} to ${account.id}`);
                    }
                } catch (err) {
                    elizaLogger.warn(`[auth] Failed to re-assign anonymous rooms: ${err}`);
                }
            }
            return account.id as UUID;
        }
    } catch (error) {
        elizaLogger.error("Failed to resolve user ID by email:", error);
    }

    return fallbackUserId;
}


const FORCE_MEDIUM_FOR_LARGE_SETTING = "FORCE_MEDIUM_FOR_LARGE";

function applyAuthenticatedModelPreference(
    runtime: IAgentRuntime,
    userInfo: ReturnType<typeof getUserInfo>
): () => void {
    if (!userInfo || userInfo.type !== "authenticated") {
        return () => {};
    }

    const character = runtime.character;
    if (!character.settings) {
        character.settings = {};
    }

    if (!character.settings.secrets) {
        character.settings.secrets = {};
    }

    const secrets = character.settings.secrets;
    const hadKey = Object.prototype.hasOwnProperty.call(
        secrets,
        FORCE_MEDIUM_FOR_LARGE_SETTING
    );
    const previousValue = secrets[FORCE_MEDIUM_FOR_LARGE_SETTING];

    secrets[FORCE_MEDIUM_FOR_LARGE_SETTING] = "false";

    return () => {
        if (!character.settings?.secrets) {
            return;
        }

        if (hadKey) {
            secrets[FORCE_MEDIUM_FOR_LARGE_SETTING] = previousValue;
        } else {
            delete secrets[FORCE_MEDIUM_FOR_LARGE_SETTING];
        }
    };
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(process.cwd(), "data", "uploaded");
        // Create the directory if it doesn't exist
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 10);
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext ? '.' + ext.replace(/^\.+/, '') : ''}`);
    },
});

// some people have more memory than disk.io
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024, files: 5 } }); // 10 MB cap, max 5 files

export const messageHandlerTemplate =
    // {{goals}}
    `# Knowledge
{{knowledge}}

# Task: Generate dialog and actions for the character {{agentName}}.

{{providers}}

{{attachments}}

# Capabilities
Note that {{agentName}} is capable of reading/seeing/hearing various forms of media, including images, videos, audio, plaintext and PDFs. Recent attachments have been included above under the "Attachments" section.

{{messageDirections}}

{{recentMessages}}

{{actions}}

# Important Instructions for Multiple Actions
If the user request involves multiple tasks (like "show me the price of BTC and the latest news about it"), use multiple actions by returning an array in the "action" field (e.g., ["getPrice", "getNews"]). This allows {{agentName}} to address all parts of a complex request.

# Instructions: Write the next message for {{agentName}}.
` + messageCompletionFooter;

export class DirectClient {
    public app: express.Application;
    /** In-flight POST /:agentId/message/stream sessions (for scheduler catch-up guard). */
    public activeRequests = 0;
    private agents: Map<string, AgentRuntime>; // container management
    private server: any; // Store server instance
    public startAgent: Function; // Store startAgent functor
    public loadCharacterTryPath: Function; // Store loadCharacterTryPath functor
    public jsonToCharacter: Function; // Store jsonToCharacter functor
    private reportSyncService: ReportSyncService;
    private trendingSentiscoreService: TrendingSentiscoreService;
    private dailyAnalysisScheduler: DailyAnalysisSchedulerService;
    private analyticsSnapshotService: AnalyticsSnapshotService;
    private fileWatcher: FileWatcherService | null = null;

    constructor() {
        elizaLogger.log("DirectClient constructor");

        // [debug-leak] Continuous idle baseline sampler. The existing
        // workflow sampler in comprehensiveAnalysisWorkflowGraph only fires
        // *during* a workflow, so the silent gaps between runs (e.g. the
        // 67-min idle window between 04:53 and the 06:00 scheduler trigger)
        // are invisible. This 60s sampler runs from process start until
        // exit and gives us RSS resolution across those gaps. `unref` keeps
        // it from blocking shutdown.
        const baselineSamplerEnabled =
            process.env.MEMORY_BASELINE_SAMPLER !== "0";
        if (baselineSamplerEnabled) {
            startMemSampler("idle.baseline", 60_000);
        }

        this.app = express();
        // Trust ALB/proxy X-Forwarded-For so rate-limiters and IP detection work correctly.
        this.app.set('trust proxy', 1);
        const ALLOWED_ORIGINS = new Set(
            (process.env.ALLOWED_ORIGINS || 'https://sentiedge.com,https://app.sentiedge.com,http://localhost:3000,http://localhost:3001')
                .split(',').map((s: string) => s.trim())
        );
        const isLocalhostOrigin = (o: string) =>
            o.startsWith('http://localhost:') || o.startsWith('http://127.0.0.1:');
        const corsOptions = {
            origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
                if (!origin || ALLOWED_ORIGINS.has(origin)) { cb(null, true); return; }
                if (process.env.NODE_ENV !== 'production' && isLocalhostOrigin(origin)) { cb(null, true); return; }
                // Disallowed origins must not throw — throwing turns every
                // request with a non-whitelisted Origin into a 500, including
                // same-origin GETs (browsers send Origin on module/script
                // requests). Let the response go through without the CORS
                // header and let the browser enforce policy.
                cb(null, false);
            },
            credentials: true
        };
        this.app.use(cors(corsOptions));

        // Compress JSON responses. Static assets are handled separately via
        // pre-built .br files emitted by Vite (see preCompressedAssetsMiddleware
        // below) — that path is robust to whatever interaction with serve-static
        // was preventing on-the-fly compression on staging.
        //
        // threshold: 0 disables the default 1 KB skip. With our SSE streaming
        // endpoint, we deliberately want even small JSON responses compressed
        // (e.g. /quota/status, /rooms which can be sub-1 KB) since the user
        // experience tax on mobile is real and the CPU cost is negligible.
        // SSE (text/event-stream) is excluded by compression's default filter.
        this.app.use(compression({ threshold: 0 }));

        this.app.use(securityHeadersMiddleware);

        this.agents = new Map();

        loadJwtPublicKey();
        // cookieParser is kept as middleware in case other routes parse cookies,
        // but the server no longer derives identity from the `user_info` cookie —
        // identity comes from the verified Bearer JWT (see auth/verifyJwt.ts).
        // COOKIE_SECRET plumbing is retained until follow-up cleanup (spec §10).
        this.app.use(cookieParser(process.env.COOKIE_SECRET));

        const jsonParser = bodyParser.json({ limit: "2mb" });
        const urlencodedParser = bodyParser.urlencoded({ extended: true, limit: "2mb" });

        this.app.use((req, res, next) => {
            if (req.originalUrl?.startsWith("/stripe/webhook")) {
                next();
                return;
            }

            jsonParser(req, res, (jsonError) => {
                if (jsonError) {
                    next(jsonError);
                    return;
                }
                urlencodedParser(req, res, next);
            });
        });

        // Serve both uploads and generated images
        this.app.use(
            "/media/uploads",
            express.static(path.join(process.cwd(), "data", "uploaded"))
        );
        this.app.use(
            "/media/generated",
            express.static(path.join(process.cwd(), "/generatedImages"))
        );

        // Serve chart files directly from Charts directory
        const chartsDirs = [
            path.join(process.cwd(), "saved_data", "Charts"),
            path.join(process.cwd(), "agent", "saved_data", "Charts"),
        ];

        chartsDirs.forEach((dirPath) => {
            this.app.use(
                "/charts",
                express.static(dirPath, { fallthrough: true })
            );
        });

        this.reportSyncService = new ReportSyncService({
            bucket: process.env.RESEARCH_REPORT_BUCKET || "sentiedge24-new",
            prefix:
                process.env.RESEARCH_REPORT_PREFIX ||
                "research_report/weekly_reports/",
            region:
                process.env.RESEARCH_REPORT_REGION || process.env.AWS_REGION,
        });
        this.reportSyncService.ensureCacheDirExists();

        // Initialize trending sentiscore service
        const cacheDir = path.join(process.cwd(), "cache");
        this.trendingSentiscoreService = new TrendingSentiscoreService(cacheDir);

        // Initialize daily analysis scheduler.
        //
        // Symbols to generate a daily report for, resolved in this order:
        //   1. DAILY_ANALYSIS_TARGETS  — comma-separated list (preferred).
        //   2. DAILY_ANALYSIS_TARGET   — legacy single-symbol var (back-compat).
        //   3. Default: ["BTC", "ETH", "SOL"].
        // The scheduler runs them sequentially in one daily tick because the
        // comprehensive workflow holds a per-user mutex and ~6 GB resident.
        const targetsRaw = process.env.DAILY_ANALYSIS_TARGETS;
        const legacyTarget = process.env.DAILY_ANALYSIS_TARGET;
        const targetSymbols = targetsRaw
            ? targetsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
            : legacyTarget
                ? [legacyTarget]
                : ["BTC", "ETH", "SOL"];

        this.dailyAnalysisScheduler = new DailyAnalysisSchedulerService(this.agents, {
            enabled: process.env.DAILY_ANALYSIS_ENABLED !== "false",
            hourUTC: Number.parseInt(process.env.DAILY_ANALYSIS_HOUR_UTC || "6", 10),
            targetSymbols,
            getActiveRequests: () => this.activeRequests,
        });

        this.analyticsSnapshotService = new AnalyticsSnapshotService(this.agents);
        this.analyticsSnapshotService.start();

        const reportStaticDirs = [
            path.join(process.cwd(), "saved_data"),
            path.join(process.cwd(), "agent", "saved_data"),
            this.reportSyncService.getCacheDir(),
        ];

        // Scheduler daily comprehensive HTML lives under DailyReports/. Do not serve via
        // anonymous static — landing exposes filenames via /daily-analysis/recent.
        const dailyReportsRoots = [
            path.join(process.cwd(), "saved_data", "DailyReports"),
            path.join(process.cwd(), "agent", "saved_data", "DailyReports"),
        ];

        // Map a canonical local filename (`comprehensive analysis BTC 2026-05-03.html`
        // or `....meta.json`) back to the S3 key used by the comprehensive workflow
        // when it uploaded under `auto-daily-reports-agent/`.
        // Returns null if the name doesn't match the canonical pattern.
        const dailyReportLocalNameToS3Key = (
            decoded: string,
        ): { s3Key: string; contentType: string } | null => {
            const m = decoded.match(
                /^comprehensive analysis ([A-Za-z0-9]+) (\d{4}-\d{2}-\d{2})\.(html|meta\.json)$/,
            );
            if (!m) return null;
            const [, symbolUpper, date, ext] = m;
            const symbolLower = symbolUpper.toLowerCase();
            const remoteName =
                ext === "html"
                    ? `comprehensive-analysis-${symbolLower}-${date}.html`
                    : `comprehensive-analysis-${symbolLower}-${date}.meta.json`;
            const contentType =
                ext === "html"
                    ? "text/html; charset=utf-8"
                    : "application/json; charset=utf-8";
            return {
                s3Key: `auto-daily-reports-agent/${date}/${symbolUpper.toUpperCase()}/${remoteName}`,
                contentType,
            };
        };

        this.app.get(
            "/reports/DailyReports/:fileName",
            requireAuth,
            async (req, res) => {
                const raw = req.params.fileName;
                if (!raw || raw.includes("..")) {
                    return res.status(400).json({ error: "Invalid path" });
                }
                let decoded: string;
                try {
                    decoded = decodeURIComponent(raw);
                } catch {
                    return res.status(400).json({ error: "Invalid path" });
                }
                if (decoded.includes("..") || path.posix.normalize(decoded).includes("..")) {
                    return res.status(400).json({ error: "Invalid path" });
                }

                // 1) Local cache (fast path; survives within a container's lifetime).
                for (const root of dailyReportsRoots) {
                    const full = path.join(root, decoded);
                    const resolvedFile = path.resolve(full);
                    const resolvedRoot = path.resolve(root);
                    if (
                        !resolvedFile.startsWith(resolvedRoot + path.sep) &&
                        resolvedFile !== resolvedRoot
                    ) {
                        continue;
                    }
                    if (fs.existsSync(resolvedFile) && fs.statSync(resolvedFile).isFile()) {
                        const isMeta = decoded.endsWith(".meta.json");
                        res.setHeader(
                            "Content-Type",
                            isMeta
                                ? "application/json; charset=utf-8"
                                : "text/html; charset=utf-8",
                        );
                        res.setHeader("Cache-Control", "private, max-age=300");
                        return res.sendFile(resolvedFile);
                    }
                }

                // 2) S3 fallback — fresh container after redeploy. Maps the
                // canonical local name back to the upload key used by the
                // comprehensive workflow's scheduler branch.
                const mapped = dailyReportLocalNameToS3Key(decoded);
                if (mapped) {
                    try {
                        const { body, contentType } = await fileStorageService.getFileStream(
                            mapped.s3Key,
                        );
                        res.setHeader(
                            "Content-Type",
                            contentType || mapped.contentType,
                        );
                        res.setHeader("Cache-Control", "private, max-age=300");
                        return (body as any).pipe(res);
                    } catch (err: any) {
                        if (
                            err?.name === "NoSuchKey" ||
                            err?.name === "NotFound" ||
                            err?.$metadata?.httpStatusCode === 404
                        ) {
                            return res
                                .status(404)
                                .json({ error: "Report not found" });
                        }
                        elizaLogger.warn(
                            `[reports/DailyReports] S3 fallback failed for ${decoded}: ${err}`,
                        );
                        return res
                            .status(502)
                            .json({ error: "Report fetch failed" });
                    }
                }
                return res.status(404).json({ error: "Report not found" });
            },
        );

        // Daily charts: HTML iframes referenced from the daily report viewer.
        // Local-first (saved_data/DailyCharts/ + saved_data/Charts/), then S3
        // via FileStorageService's chart index. Without this fallback, a fresh
        // container would render the report shell but every embedded chart
        // would 404 because saved_data/DailyCharts/ is empty after redeploy.
        const dailyChartLocalDirs = [
            path.join(process.cwd(), "saved_data", "DailyCharts"),
            path.join(process.cwd(), "agent", "saved_data", "DailyCharts"),
            path.join(process.cwd(), "saved_data", "Charts"),
            path.join(process.cwd(), "agent", "saved_data", "Charts"),
        ];
        this.app.get(
            "/reports/DailyCharts/:fileName",
            requireAuth,
            async (req, res) => {
                const raw = req.params.fileName;
                if (!raw || raw.includes("..")) {
                    return res.status(400).json({ error: "Invalid path" });
                }
                let decoded: string;
                try {
                    decoded = decodeURIComponent(raw);
                } catch {
                    return res.status(400).json({ error: "Invalid path" });
                }
                if (decoded.includes("..") || decoded.includes("/")) {
                    return res.status(400).json({ error: "Invalid path" });
                }

                const ext = path.extname(decoded).toLowerCase();
                const localCT: Record<string, string> = {
                    ".html": "text/html; charset=utf-8",
                    ".png": "image/png",
                    ".svg": "image/svg+xml",
                };
                const contentType =
                    localCT[ext] ?? "application/octet-stream";

                // 1) Local cache (case/space tolerant — chart filenames stored
                // in metadata may differ from on-disk normalization).
                const normalize = (s: string) =>
                    s.replace(/\s+/g, "-").toLowerCase();
                const target = normalize(decoded);
                for (const dir of dailyChartLocalDirs) {
                    if (!fs.existsSync(dir)) continue;
                    let entries: string[];
                    try {
                        entries = fs.readdirSync(dir);
                    } catch {
                        continue;
                    }
                    const match = entries.find(
                        (f) => normalize(f) === target || f === decoded,
                    );
                    if (!match) continue;
                    const full = path.join(dir, match);
                    try {
                        const st = fs.statSync(full);
                        if (st.isFile() && st.size > 0) {
                            res.setHeader("Content-Type", contentType);
                            res.setHeader(
                                "Cache-Control",
                                "private, max-age=3600",
                            );
                            return fs.createReadStream(full).pipe(res);
                        }
                    } catch {
                        // try next dir
                    }
                }

                // 2) S3 fallback — resolve chartFilename → S3 key via the
                // per-agent chart index. Chart upload paths are
                // `{prefix}/charts/{agentId}/system/{date}/{symbol}/{kebab}`,
                // so we search the index by basename.
                const firstAgent = this.agents.values().next();
                const agentId =
                    !firstAgent.done && firstAgent.value
                        ? firstAgent.value.agentId
                        : null;
                if (!agentId) {
                    return res
                        .status(404)
                        .json({ error: "Chart not found (no agent)" });
                }
                try {
                    const proxyUrl = await fileStorageService.findChartByFilename(
                        agentId,
                        decoded,
                    );
                    if (!proxyUrl) {
                        return res
                            .status(404)
                            .json({ error: "Chart not found" });
                    }
                    // proxyUrl is `/s3-files/{fullKey}`; extract the S3 key.
                    const s3Key = proxyUrl.replace(/^\/s3-files\//, "");
                    const { body, contentType: ct } =
                        await fileStorageService.getFileStream(s3Key);
                    res.setHeader("Content-Type", ct || contentType);
                    res.setHeader("Cache-Control", "private, max-age=3600");
                    return (body as any).pipe(res);
                } catch (err: any) {
                    if (
                        err?.name === "NoSuchKey" ||
                        err?.name === "NotFound" ||
                        err?.$metadata?.httpStatusCode === 404
                    ) {
                        return res
                            .status(404)
                            .json({ error: "Chart not found" });
                    }
                    elizaLogger.warn(
                        `[reports/DailyCharts] S3 fallback failed for ${decoded}: ${err}`,
                    );
                    return res
                        .status(502)
                        .json({ error: "Chart fetch failed" });
                }
            },
        );

        Array.from(new Set(reportStaticDirs)).forEach((dirPath) => {
            this.app.use(
                "/reports",
                express.static(dirPath, { fallthrough: true })
            );
        });
        // 404 fallback for /reports — prevents missing report files from falling through
        // to the SPA catchall (which returns index.html with status 200, confusing the client)
        this.app.use('/reports', (_req, res) => {
            res.status(404).json({ error: 'Report not found. It may have been lost when the server restarted.' });
        });


        this.app.use(
            "/research-reports/files",
            express.static(this.reportSyncService.getCacheDir(), {
                fallthrough: true,
            })
        );

        // Local cache lookup for chart S3 keys. The fileWatcher writes both
        // disk and S3, so when a key resolves to a chart file we can serve
        // straight off disk — same auth gate already passed, no S3 round-trip,
        // and it heals broken/0-byte S3 objects from older watcher generations.
        // In production after a container restart the disk is empty, so this
        // misses cleanly and falls through to the S3 path.
        const CHART_LOCAL_DIRS = [
            path.join(process.cwd(), "saved_data", "Charts"),
            path.join(process.cwd(), "agent", "saved_data", "Charts"),
        ];
        const LOCAL_CHART_CT: Record<string, string> = {
            ".html": "text/html; charset=UTF-8",
            ".png": "image/png",
            ".svg": "image/svg+xml",
            ".csv": "text/csv",
        };
        const findLocalChartFile = (
            s3Key: string,
        ): { fullPath: string; size: number; contentType: string } | null => {
            if (!s3Key.toLowerCase().includes("/charts/")) return null;
            const basename = s3Key.split("/").pop();
            if (!basename) return null;
            const normalize = (s: string) => s.replace(/\s+/g, "-").toLowerCase();
            const target = normalize(basename);
            const ext = path.extname(basename).toLowerCase();
            const contentType = LOCAL_CHART_CT[ext] ?? "application/octet-stream";
            for (const dir of CHART_LOCAL_DIRS) {
                if (!fs.existsSync(dir)) continue;
                let files: string[];
                try {
                    files = fs.readdirSync(dir);
                } catch {
                    continue;
                }
                const match = files.find((f) => normalize(f) === target);
                if (!match) continue;
                const fullPath = path.join(dir, match);
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.isFile() && stat.size > 0) {
                        return { fullPath, size: stat.size, contentType };
                    }
                } catch {
                    // fall through and try the next directory
                }
            }
            return null;
        };

        // S3 file proxy — streams private S3 objects through the server.
        // Order: auth → local cache (fast path / repair) → S3.
        const s3FilesHandler: express.RequestHandler = async (req, res) => {
            try {
                const s3Key = (req.params as any)[0] as string;
                const userInfo = getUserInfo(req);
                const owner = fileStorageService.extractOwner(s3Key);
                if (owner === null) {
                    elizaLogger.warn(
                        `[s3-proxy] 400 invalid path method=${req.method} path=${req.path}`
                    );
                    return res.status(400).json({ error: "Invalid file path" });
                }

                if (userInfo.type === "anonymous") {
                    const allowLocalAnonSystemChart =
                        isLocalDevModeActive() &&
                        owner === "system" &&
                        s3Key.toLowerCase().includes("/charts/") &&
                        s3Key.toLowerCase().endsWith(".html");
                    if (!allowLocalAnonSystemChart) {
                        elizaLogger.warn(
                            `[s3-proxy] 401 anonymous chart/resource request method=${req.method} path=${req.path}`
                        );
                        return res.status(401).json({ error: "Authentication required" });
                    }
                } else if (owner !== "system" && owner !== userInfo.userId) {
                    elizaLogger.warn(
                        `[s3-proxy] Forbidden: user ${userInfo.userId} tried to access key owned by ${owner}`
                    );
                    return res.status(403).json({ error: "Forbidden" });
                }

                const localHit = findLocalChartFile(s3Key);
                if (localHit) {
                    res.setHeader("Content-Type", localHit.contentType);
                    res.setHeader("Content-Length", String(localHit.size));
                    res.setHeader("Cache-Control", "private, max-age=3600");
                    if (req.method === "HEAD") return res.end();
                    return fs.createReadStream(localHit.fullPath).pipe(res);
                }

                if (req.method === "HEAD") {
                    const meta = await fileStorageService.headObject(s3Key);
                    res.status(200);
                    res.setHeader("Content-Type", meta.contentType);
                    if (meta.contentDisposition) {
                        res.setHeader("Content-Disposition", meta.contentDisposition);
                    }
                    if (meta.contentLength != null) {
                        res.setHeader("Content-Length", String(meta.contentLength));
                    }
                    res.setHeader("Cache-Control", "private, max-age=3600");
                    return res.end();
                }

                const { body, contentType, contentDisposition } = await fileStorageService.getFileStream(s3Key);
                res.setHeader("Content-Type", contentType);
                if (contentDisposition) res.setHeader("Content-Disposition", contentDisposition);
                res.setHeader("Cache-Control", "private, max-age=3600");
                (body as any).pipe(res);
            } catch (err: any) {
                if (
                    err?.name === "NoSuchKey" ||
                    err?.name === "NotFound" ||
                    err?.$metadata?.httpStatusCode === 404
                ) {
                    elizaLogger.warn(`[s3-proxy] 404 NoSuchKey path=${req.path}`);
                    return res.status(404).json({ error: "File not found" });
                }
                elizaLogger.error(`[s3-proxy] Error: ${err}`);
                res.status(500).json({ error: "Failed to retrieve file" });
            }
        };
        this.app.get("/s3-files/*", s3FilesHandler);
        this.app.head("/s3-files/*", s3FilesHandler);

        this.reportSyncService
            .start()
            .catch((error) =>
                elizaLogger.error("Failed to start report sync service", error)
            );

        const apiRouter = createApiRouter(this.agents, this);
        this.app.use(apiRouter);

        const apiLogRouter = createVerifiableLogApiRouter(this.agents, ALLOWED_ORIGINS);
        this.app.use(apiLogRouter);

        // Define an interface that extends the Express Request interface
        interface CustomRequest extends ExpressRequest {
            file?: Express.Multer.File;
        }

        // Update the route handler to use CustomRequest instead of express.Request
        this.app.post(
            "/:agentId/whisper",
            whisperLimiter,
            upload.single("file"),
            async (req: CustomRequest, res: express.Response) => {
                const audioFile = req.file; // Access the uploaded file using req.file
                const agentId = req.params.agentId;

                if (!audioFile) {
                    res.status(400).send("No audio file provided");
                    return;
                }

                let runtime = this.agents.get(agentId);
                const apiKey = runtime.getSetting("OPENAI_API_KEY");

                // if runtime is null, look for runtime with the same name
                if (!runtime) {
                    runtime = Array.from(this.agents.values()).find(
                        (a) =>
                            a.character.name.toLowerCase() ===
                            agentId.toLowerCase()
                    );
                }

                if (!runtime) {
                    res.status(404).send("Agent not found");
                    return;
                }

                const openai = new OpenAI({
                    apiKey,
                });

                const transcription = await openai.audio.transcriptions.create({
                    file: fs.createReadStream(audioFile.path),
                    model: "whisper-1",
                });

                res.json(transcription);
            }
        );


        this.app.post(
            "/:agentId/message/stream",
            chatLimiter,
            upload.array("files", 10), // Allow up to 10 files
            async (req: express.Request, res: express.Response) => {
                
                // DEBUG: Log streaming setup
                elizaLogger.info(`🔍 DEBUG: Starting streaming endpoint for agent ${req.params.agentIdOrName}`);
                
                const requestOrigin = Array.isArray(req.headers.origin)
                    ? req.headers.origin[0]
                    : req.headers.origin;

                const sseHeaders: Record<string, string> = {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Access-Control-Allow-Headers": "Cache-Control",
                    "X-Accel-Buffering": "no", // Prevent Nginx buffering
                };

                if (req.httpVersionMajor < 2) {
                    sseHeaders.Connection = "keep-alive";
                    sseHeaders["Transfer-Encoding"] = "chunked"; // Enable chunked transfer for HTTP/1.1
                }

                if (requestOrigin && ALLOWED_ORIGINS.has(requestOrigin)) {
                    sseHeaders["Access-Control-Allow-Origin"] = requestOrigin;
                    sseHeaders["Access-Control-Allow-Credentials"] = "true";
                    sseHeaders["Vary"] = "Origin";
                }

                res.writeHead(200, sseHeaders);
                
                // DEBUG: Log response headers set
                elizaLogger.info(`🔍 DEBUG: Streaming headers set, response writable: ${res.writable}`);

                let activeThreadId: UUID | undefined;
                const connectionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

                // Set up connection keepalive to prevent timeouts
                const keepAliveInterval = setInterval(() => {
                    if (res.writable && !res.destroyed) {
                        res.write(': keepalive\n\n');
                        elizaLogger.debug('📡 Sent SSE keepalive');
                    } else {
                        clearInterval(keepAliveInterval);
                        elizaLogger.debug('🔌 Cleared keepalive - connection not writable');
                    }
                }, 15000); // Send keepalive every 15 seconds

                // Clean up keepalive when connection closes
                res.on('close', () => {
                    clearInterval(keepAliveInterval);
                    elizaLogger.info('🔌 SSE connection closed, cleared keepalive');
                    if (!runtime) {
                        return;
                    }

                    // Drop this connection from the active-streams registry so
                    // any in-flight workflow's success path (in runtime.ts) can
                    // detect that the SSE pipe is gone and tag the persisted
                    // memory with `deliveryStatus: 'persisted-only'`. activeThreadId
                    // holds the resolved roomId once req.body has been parsed.
                    if (activeThreadId) {
                        markStreamClosed(runtime, activeThreadId, connectionId);
                    }

                    const runtimeWithApprovals = runtime as AgentRuntime & {
                        __pendingApprovals?: Map<string, { connectionId?: string; reject?: (error: Error) => void }>;
                    };
                    if (runtimeWithApprovals?.__pendingApprovals && activeThreadId) {
                        const pendingApproval = runtimeWithApprovals.__pendingApprovals.get(activeThreadId);
                        if (pendingApproval?.connectionId === connectionId && pendingApproval?.reject) {
                            try {
                                // Use the shared sentinel so the task-chain
                                // handler recognizes this as a clean cancel
                                // (client walked away) and skips the error
                                // memory + ERROR-level log.
                                pendingApproval.reject(new Error(TASK_CHAIN_APPROVAL_CANCELLED_BY_DISCONNECT));
                            } catch (error) {
                                elizaLogger.warn(`Failed to reject pending approval for thread ${activeThreadId}: ${String(error)}`);
                            }
                            runtimeWithApprovals.__pendingApprovals.delete(activeThreadId);
                        }
                    }
                    // CEX workflow approvals deliberately survive SSE close — they expire by TTL
                    // (PENDING_CEX_APPROVAL_TTL_MS in cexWorkflowMessageHandler) so transient
                    // disconnects don't invalidate the user's order while they review.
                });

                res.on('error', (error) => {
                    clearInterval(keepAliveInterval);
                    elizaLogger.error('🔌 SSE connection error:', error);
                });

                const agentId = req.params.agentId;
                let runtime = this.agents.get(agentId);
                
                if (!runtime) {
                    runtime = Array.from(this.agents.values()).find(
                        (a) => a.character.name.toLowerCase() === agentId.toLowerCase()
                    );
                }

                if (!runtime) {
                    res.write(`data: ${JSON.stringify({ type: 'error', error: "Agent not found" })}\n\n`);
                    res.end();
                    return;
                }

                let restoreModelPreference: () => void = () => {};

                try {
                    this.activeRequests++;
                    // Get user ID from authentication (email primary, IP fallback)
                    const userInfo = getUserInfo(req);
                    const fallbackUserId = getUserId(req);
                    const userId = await resolveAuthenticatedUserId(
                        runtime,
                        userInfo,
                        fallbackUserId
                    );
                    restoreModelPreference = applyAuthenticatedModelPreference(runtime, userInfo);
                    if (userInfo.type === 'authenticated') {
                        elizaLogger.info(`🔐 Authenticated request from ${userInfo.email} -> userId: ${userId} (fallback IP: ${userInfo.fallbackIP})`);
                    } else {
                        elizaLogger.info(`🌐 Anonymous request from IP: ${userInfo.ip} -> userId: ${userId}`);

                        if (!isLocalDevModeActive()) {
                            const since = Date.now() - ANONYMOUS_LIMIT_WINDOW_MS;
                            const recentMessageCount =
                                await runtime.databaseAdapter.countUserMessages({
                                    userId: userId as UUID,
                                    since,
                                });

                            elizaLogger.debug(
                                `📊 Anonymous usage -> userId: ${userId}, last24hMessages: ${recentMessageCount}`
                            );

                            if (recentMessageCount >= ANONYMOUS_DAILY_MESSAGE_LIMIT) {
                                elizaLogger.info(
                                    `🚫 Anonymous user ${userId} hit daily message limit (${recentMessageCount}/${ANONYMOUS_DAILY_MESSAGE_LIMIT})`
                                );

                                const limitPayload = {
                                    type: "error",
                                    error: {
                                        code: ANONYMOUS_LIMIT_ERROR_CODE,
                                        message:
                                            "You've reached the daily limit of 3 questions. Create a free account to keep chatting with the agent.",
                                    },
                                } as const;

                                res.write(`data: ${JSON.stringify(limitPayload)}\n\n`);
                                clearInterval(keepAliveInterval);
                                res.end();
                                return;
                            }
                        } else {
                            elizaLogger.debug(
                                `LOCAL_DEV_MODE=1: skipping anonymous daily message cap check for ${userId}`
                            );
                        }

                        const cleanupResult = await cleanupAnonymousHistoryIfExpired({
                            runtime,
                            userId,
                        });
                        if (cleanupResult.cleaned) {
                            const lastActivityIso = cleanupResult.lastActivity
                                ? new Date(cleanupResult.lastActivity).toISOString()
                                : "unknown";
                            elizaLogger.info(
                                `🧹 Cleared stale history for anonymous user ${userId} (last activity: ${lastActivityIso}, rooms: ${cleanupResult.cleanedRoomIds.join(
                                    ", ",
                                ) || "none"})`,
                            );
                        }
                    }

                    // Validate quota for free users
                    const quotaValidation = await validateQuotaBeforeMessage(runtime, userId);

                    if (!quotaValidation.allowed) {
                        const quotaExceededPayload = {
                            type: "error",
                            error: {
                                code: "QUOTA_EXCEEDED",
                                message: quotaValidation.error,
                                quotaStatus: quotaValidation.quotaStatus
                            }
                        } as const;

                        res.write(`data: ${JSON.stringify(quotaExceededPayload)}\n\n`);
                        clearInterval(keepAliveInterval);
                        res.end();
                        return;
                    }

                    // DEBUG: Log what roomId we received from frontend
                    elizaLogger.info(`🔍 DEBUG: Received roomId from frontend: ${req.body.roomId}`);
                    elizaLogger.info(`🔍 DEBUG: AgentId: ${agentId}`);
                    
                    // Fix: Use roomId directly if it's already a valid UUID, otherwise generate one
                    let roomId: UUID;
                    if (req.body.roomId && validateUuid(req.body.roomId)) {
                        // If we receive a valid UUID, use it directly
                        roomId = req.body.roomId as UUID;
                        activeThreadId = roomId;
                        elizaLogger.info(`🔍 DEBUG: Using provided UUID roomId: ${roomId}`);
                    } else {
                        // Otherwise, generate a UUID from the provided string or use default
                        const timestamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '-');
                        const roomIdString = req.body.roomId ?? `default-room-${agentId}-${timestamp}`;
                        roomId = stringToUuid(roomIdString);
                        activeThreadId = roomId;
                        elizaLogger.info(`🔍 DEBUG: Generated roomId from string '${roomIdString}': ${roomId}`);
                    }

                    // Register this SSE stream so the runtime can detect, at
                    // workflow-completion time, whether the result can still
                    // reach the user via SSE. Cleared in the res.on('close')
                    // handler above. Multi-tab safe (Set-of-connectionIds).
                    //
                    // Fix 12 — also publish `userId` + a `send` callback so
                    // the kill-switch endpoint (and any future out-of-band
                    // emitter) can push events to live tabs owned by this
                    // user without going through a workflow handler.
                    markStreamOpen(runtime, roomId, connectionId, String(userId), (payload) => {
                        if (!res.writable) return;
                        res.write(`data: ${JSON.stringify(payload)}\n\n`);
                    });
                    
                    let text = typeof req.body.text === "string" ? req.body.text : "";
                    const requestedMessageClassificationRaw = (req.body as Record<string, unknown>)
                        .messageClassification;
                    const requestedMessageClassification =
                        requestedMessageClassificationRaw === "TASK_CHAIN_MESSAGE"
                            ? "TASK_CHAIN_MESSAGE"
                            : undefined;
                    const favoriteTaskChainRaw = (req.body as Record<string, unknown>).favoriteTaskChain;
                    let favoriteTaskChain: Record<string, unknown> | undefined;
                    const uploadedFiles = (req.files as Express.Multer.File[] | undefined) || [];

                    if (typeof favoriteTaskChainRaw === "string") {
                        try {
                            favoriteTaskChain = JSON.parse(favoriteTaskChainRaw) as Record<string, unknown>;
                        } catch (error) {
                            elizaLogger.warn(
                                `⚠️ Failed to parse favorite task chain payload from request: ${String(error)}`
                            );
                        }
                    } else if (favoriteTaskChainRaw && typeof favoriteTaskChainRaw === "object") {
                        favoriteTaskChain = favoriteTaskChainRaw as Record<string, unknown>;
                    }

                    const language = typeof (req.body as Record<string, unknown>).language === "string"
                        ? (req.body as Record<string, unknown>).language as string
                        : undefined;

                    // F10 — manual-compose payload. When the trade-compose
                    // modal submits, the parameters are POSTed alongside a
                    // human-readable preview prompt; the CEX workflow
                    // handler short-circuits the LLM and uses the
                    // structured params verbatim (still gated by risk +
                    // double-confirm approval downstream).
                    const composedActionRaw = (req.body as Record<string, unknown>).composedAction;
                    const composedAction = typeof composedActionRaw === "string" && composedActionRaw.length > 0
                        ? composedActionRaw
                        : undefined;
                    const composedParamsRaw = (req.body as Record<string, unknown>).composedParams;
                    let composedParams: Record<string, unknown> | undefined;
                    if (composedAction) {
                        if (typeof composedParamsRaw === "string") {
                            try {
                                composedParams = JSON.parse(composedParamsRaw) as Record<string, unknown>;
                            } catch (error) {
                                elizaLogger.warn(
                                    `[F10 compose] failed to parse composedParams JSON: ${String(error)}`,
                                );
                            }
                        } else if (composedParamsRaw && typeof composedParamsRaw === "object") {
                            composedParams = composedParamsRaw as Record<string, unknown>;
                        }
                    }

                    // F10.2 — one-click compose dialog opts the payload into
                    // skipping the redundant approval modal. The dialog
                    // collected the "I confirm…" gate locally; the server
                    // still runs risk + idempotency + lock + quote-freshness.
                    // FormData carries the flag as the string "true"; JSON
                    // carries it as a real boolean.
                    const composedPreApprovedRaw = (req.body as Record<string, unknown>).composedPreApproved;
                    const composedPreApproved =
                        composedPreApprovedRaw === true || composedPreApprovedRaw === "true";

                    const trimmedText = text.trim();
                    const hasAttachments = uploadedFiles.length > 0;

                    if (!trimmedText && !favoriteTaskChain && !hasAttachments) {
                        res.write(`data: ${JSON.stringify({ type: 'error', error: "No input provided" })}\n\n`);
                        res.end();
                        return;
                    }

                    if (!trimmedText) {
                        if (favoriteTaskChain) {
                            text = "";
                        } else if (hasAttachments) {
                            text = `User provided ${uploadedFiles.length} attachment${uploadedFiles.length === 1 ? '' : 's'}`;
                        }
                    }

                    // If the requested room was deleted, create a new room and notify the client so URL can update
                    const existingRoom = await runtime.databaseAdapter.getRoom(roomId);
                    if (!existingRoom) {
                        const roomName = formatDefaultRoomName();
                        const newRoomId = await runtime.databaseAdapter.createRoom(
                            undefined,
                            roomName,
                            runtime.agentId
                        );
                        await runtime.databaseAdapter.addParticipant(
                            userId,
                            newRoomId,
                            runtime.agentId
                        );
                        await runtime.databaseAdapter.addParticipant(
                            runtime.agentId,
                            newRoomId,
                            runtime.agentId
                        );
                        elizaLogger.info(
                            `Room ${roomId} no longer existed; created new room ${newRoomId} for message.`
                        );
                        res.write(
                            `data: ${JSON.stringify({
                                type: "room_created",
                                roomId: newRoomId,
                                roomName,
                            })}\n\n`
                        );
                        // Move the active-stream registration from the old
                        // roomId to the new one so liveness checks on the
                        // reborn room see this connection. Preserves the
                        // Fix 12 userId + send callback so kill-switch
                        // notifications still reach this tab.
                        markStreamClosed(runtime, roomId, connectionId);
                        markStreamOpen(runtime, newRoomId, connectionId, String(userId), (payload) => {
                            if (!res.writable) return;
                            res.write(`data: ${JSON.stringify(payload)}\n\n`);
                        });
                        roomId = newRoomId;
                        activeThreadId = newRoomId;
                    }

                    await runtime.ensureConnection(
                        userId,
                        roomId,
                        req.body.userName,
                        req.body.name,
                        "direct"
                    );

                    enterUsageTrackingContext({
                        userId: String(userId),
                        roomId: String(roomId),
                    });

                    const messageId = stringToUuid(Date.now().toString());
                    
                    const attachments: Media[] = [];
                    console.log("Streaming endpoint - File upload debug - req.files:", uploadedFiles);
                    
                    // Process all uploaded files
                    for (const file of uploadedFiles) {
                        const filePath = path.join(
                            process.cwd(),
                            "data",
                            "uploaded",
                            file.filename
                        );
                        const date = new Date().toISOString().split("T")[0];
                        const safeFilename = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
                        const s3Key = fileStorageService.buildKey({
                            type: "upload",
                            agentId,
                            userId: userId.toString(),
                            roomId: roomId?.toString(),
                            date,
                            filename: safeFilename,
                        });
                        let fileUrl: string;
                        try {
                            fileUrl = await fileStorageService.saveFile({
                                content: fs.readFileSync(filePath),
                                s3Key,
                                contentType: file.mimetype,
                                contentDisposition: `attachment; filename="${file.originalname}"`,
                                metadata: {
                                    "agent-id": agentId,
                                    "user-id": userId.toString(),
                                    "room-id": roomId?.toString() ?? "",
                                    "original-name": file.originalname,
                                    "file-type": "upload",
                                },
                                localCachePath: filePath,
                            });
                        } catch (err) {
                            elizaLogger.warn(`[upload] S3 upload failed, using local path: ${err}`);
                            fileUrl = filePath;
                        }
                        attachments.push({
                            id: `${Date.now()}-${Math.random()}`,
                            url: fileUrl,
                            title: file.originalname,
                            source: undefined,
                            description: `Uploaded file: ${file.originalname}`,
                            text: "",
                            contentType: file.mimetype,
                        });
                    }
                    
                    if (uploadedFiles.length === 0) {
                        console.log("Streaming endpoint - No files uploaded");
                    }

                    // Process images with Gemini analysis
                    let processedAttachments = attachments;
                    if (attachments.length > 0) {
                        const imageProcessor = new ImageProcessor(runtime as AgentRuntime);
                        
                        // Send image processing notification
                        const imageProcessingStep: ProcessingStep = {
                            id: 'image_processing',
                            name: 'Image Processing',
                            status: 'in_progress',
                            message: '🖼️ Processing uploaded images...',
                            timestamp: Date.now()
                        };
                        res.write(`data: ${JSON.stringify({ type: 'step', step: imageProcessingStep })}\n\n`);
                        
                        try {
                            processedAttachments = await imageProcessor.processImages(attachments, roomId, userId);

                            // Send completion notification
                            const imageCompletionStep: ProcessingStep = {
                                id: 'image_processing',
                                name: 'Image Processing',
                                status: 'completed',
                                message: '✅ Images processed and analyzed',
                                timestamp: Date.now()
                            };
                            res.write(`data: ${JSON.stringify({ type: 'step', step: imageCompletionStep })}\n\n`);
                        } catch (error) {
                            elizaLogger.error("❌ Error processing images:", error);
                            const imageErrorStep: ProcessingStep = {
                                id: 'image_processing',
                                name: 'Image Processing',
                                status: 'error',
                                message: `❌ Image processing failed: ${error.message}`,
                                timestamp: Date.now()
                            };
                            res.write(`data: ${JSON.stringify({ type: 'step', step: imageErrorStep })}\n\n`);
                        }
                    }

                    const content: Content = {
                        text,
                        attachments: processedAttachments,
                        source: undefined,
                        inReplyTo: undefined,
                        language,
                    };

                    if (requestedMessageClassification) {
                        const existingMetadata = (content as Record<string, unknown>).metadata;
                        const normalizedMetadata =
                            existingMetadata && typeof existingMetadata === "object"
                                ? (existingMetadata as Record<string, unknown>)
                                : {};

                        (content as Record<string, unknown>).metadata = {
                            ...normalizedMetadata,
                            messageClassificationOverride: requestedMessageClassification,
                        };
                    }

                    if (favoriteTaskChain) {
                        (content as Record<string, unknown>).favoriteTaskChain = favoriteTaskChain;

                        const existingMetadata = (content as Record<string, unknown>).metadata;
                        const normalizedMetadata =
                            existingMetadata && typeof existingMetadata === "object"
                                ? existingMetadata as Record<string, unknown>
                                : {};

                        (content as Record<string, unknown>).metadata = {
                            ...normalizedMetadata,
                            favoriteTaskChain,
                        };
                    }

                    if (composedAction && composedParams) {
                        (content as Record<string, unknown>).composedAction = composedAction;
                        (content as Record<string, unknown>).composedParams = composedParams;
                        // Only honor the pre-approval flag when a composed
                        // action is present; otherwise it's spoofable noise
                        // on a free-text payload.
                        if (composedPreApproved) {
                            (content as Record<string, unknown>).composedPreApproved = true;
                        }
                    }
                    
                    // Create user message (store clientIP for anonymous users identified by IP)
                    const userMessage: Memory = {
                        id: stringToUuid(messageId + "-" + userId),
                        userId,
                        agentId: runtime.agentId,
                        roomId,
                        content,
                        createdAt: Date.now(),
                        ...(userInfo.type === "anonymous" && userInfo.ip
                            ? { clientIP: userInfo.ip }
                            : {}),
                    };

                    // Store the original user message first
                    if (text.trim().length > 0) {
                        await runtime.messageManager.addEmbeddingToMemory(userMessage);
                    }
                    await runtime.messageManager.createMemory(userMessage);

                    const attemptRoomTitleUpdate = async () => {
                        try {
                            const roomRecord = await runtime.databaseAdapter.getRoomById(roomId);
                            if (!roomRecord || !isDefaultRoomName(roomRecord.name)) {
                                return;
                            }

                            const memoryCount = await runtime.messageManager.countMemories(roomId);
                            if (memoryCount > 1) {
                                return;
                            }

                            const firstQuestion = trimmedText;
                            if (!firstQuestion) {
                                return;
                            }

                            const snippet = firstQuestion.length > 280
                                ? `${firstQuestion.slice(0, 277)}...`
                                : firstQuestion;

                            const context = [
                                "You generate concise, descriptive chat room titles.",
                                "Requirements:",
                                "- Capture the primary goal of the user's first question.",
                                "- Stay within 60 characters and omit trailing punctuation.",
                                "- Do not add quotes or markdown.",
                                `First question: """${snippet}"""`,
                                "Return only the title text.",
                            ].join("\n");

                            const generatedTitle = await generateText({
                                runtime,
                                prompt: context,
                                modelClass: ModelClass.SMALL,
                            });

                            const sanitizedTitle = sanitizeGeneratedRoomTitle(generatedTitle);
                            if (!sanitizedTitle) {
                                return;
                            }

                            await runtime.databaseAdapter.updateRoomName(roomId, sanitizedTitle);

                            if (!res.writableEnded && !res.destroyed) {
                                const roomUpdatePayload = {
                                    type: "room_update" as const,
                                    room: {
                                        id: roomId,
                                        name: sanitizedTitle,
                                    },
                                };
                                res.write(`data: ${JSON.stringify(roomUpdatePayload)}\n\n`);
                            }
                        } catch (error) {
                            elizaLogger.error("Failed to auto-generate room title:", error);
                        }
                    };

                    attemptRoomTitleUpdate().catch((error) => {
                        elizaLogger.error("Unhandled error during room title generation:", error);
                    });

                    // Process uploaded files for RAG if present
                    // Define document files outside the conditional for later use
                    const documentFiles = uploadedFiles.filter(file => {
                        const supportedDocumentTypes = [
                            'application/pdf',
                            'text/plain',
                            'text/markdown',
                            'application/msword',
                            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                            'application/vnd.ms-excel',
                            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                            'application/vnd.ms-powerpoint',
                            'application/vnd.openxmlformats-officedocument.presentationml.presentation'
                        ];
                        return supportedDocumentTypes.includes(file.mimetype);
                    });

                    if (uploadedFiles.length > 0) {

                        if (documentFiles.length > 0) {
                            // Send batch processing start notification
                            const batchStartStep: ProcessingStep = {
                                id: 'batch_file_processing',
                                name: 'Batch File Processing',
                                status: 'in_progress',
                                message: `📄 Processing ${documentFiles.length} file${documentFiles.length > 1 ? 's' : ''} sequentially...`,
                                timestamp: Date.now()
                            };
                            res.write(`data: ${JSON.stringify({ type: 'step', step: batchStartStep })}\n\n`);

                            const fileProcessor = new FileProcessor(runtime as AgentRuntime);
                            
                            // Process each file sequentially
                            for (let i = 0; i < documentFiles.length; i++) {
                                const file = documentFiles[i];
                                try {
                                    // Send individual file processing notification
                                    const fileProcessingStep: ProcessingStep = {
                                        id: `file_processing_${i}`,
                                        name: `File ${i + 1}/${documentFiles.length}`,
                                        status: 'in_progress',
                                        message: `📄 Processing: ${file.originalname}`,
                                        timestamp: Date.now()
                                    };
                                    res.write(`data: ${JSON.stringify({ type: 'step', step: fileProcessingStep })}\n\n`);

                                    await fileProcessor.processFile(
                                        path.join(process.cwd(), "data", "uploaded", file.filename),
                                        file.originalname,
                                        file.mimetype,
                                        roomId
                                    );

                                    // Send individual file completion notification
                                    const fileCompletionStep: ProcessingStep = {
                                        id: `file_processing_${i}`,
                                        name: `File ${i + 1}/${documentFiles.length}`,
                                        status: 'completed',
                                        message: `✅ Completed: ${file.originalname}`,
                                        timestamp: Date.now()
                                    };
                                    res.write(`data: ${JSON.stringify({ type: 'step', step: fileCompletionStep })}\n\n`);
                                    
                                } catch (error) {
                                    elizaLogger.error(`❌ Error processing file ${file.originalname}:`, error);
                                    const fileErrorStep: ProcessingStep = {
                                        id: `file_processing_${i}`,
                                        name: `File ${i + 1}/${documentFiles.length}`,
                                        status: 'error',
                                        message: `❌ Error processing ${file.originalname}: ${error.message}`,
                                        timestamp: Date.now()
                                    };
                                    res.write(`data: ${JSON.stringify({ type: 'step', step: fileErrorStep })}\n\n`);
                                }
                            }

                            // Send batch completion notification
                            const batchCompletionStep: ProcessingStep = {
                                id: 'batch_file_processing',
                                name: 'Batch File Processing',
                                status: 'completed',
                                message: `✅ All files processed successfully (${documentFiles.length} files)`,
                                timestamp: Date.now()
                            };
                            res.write(`data: ${JSON.stringify({ type: 'step', step: batchCompletionStep })}\n\n`);
                        }
                    }

                    // SSE write helper — every event must flush so tokens
                    // reach the client immediately (Express compression and
                    // ALB will otherwise hold writes until the response ends).
                    const sseWrite = (payload: unknown) => {
                        if (!res.writable || res.destroyed) return;
                        try {
                            res.write(`data: ${JSON.stringify(payload)}\n\n`);
                            (res as unknown as { flush?: () => void }).flush?.();
                        } catch (err) {
                            elizaLogger.debug("SSE write failed", err);
                        }
                    };

                    // Set up streaming callback
                    const streamingCallback = (step: ProcessingStep) => {
                        sseWrite({ type: 'step', step });
                    };

                    // Raw token callback — forwards each Gemini delta as a
                    // `token` event so the UI can render text as it streams
                    // instead of seeing one big bundle at end-of-stream.
                    const onToken = (delta: string) => {
                        if (!delta) return;
                        sseWrite({ type: 'token', text: delta });
                    };

                    // The comprehensive-analysis path keeps doing background
                    // work (HTML render, S3 upload, report metadata) for ~5 min
                    // after the user-visible answer is ready. This callback
                    // fires the moment the prose is generated; we emit [DONE]
                    // and end the response so the client unblocks immediately.
                    // Subsequent SSE writes are no-ops because sseWrite checks
                    // res.writable; the workflow's tail keeps running on the
                    // server but no longer holds the connection open.
                    let analysisCompleteFired = false;
                    const onAnalysisComplete = (_analysisContent: string) => {
                        if (analysisCompleteFired) return;
                        analysisCompleteFired = true;
                        try {
                            if (res.writable && !res.destroyed) {
                                res.write(`data: [DONE]\n\n`);
                                (res as unknown as { flush?: () => void }).flush?.();
                                res.end();
                            }
                        } catch (err) {
                            elizaLogger.debug("Failed to close SSE stream after onAnalysisComplete", err);
                        }
                    };

                    // NEW: Set up intermediate response callback to stream results as they're created
                    const intermediateResponseCallback = (response: Memory) => {
                        try {
                            const formattedResponse = {
                                id: response.id,
                                userId: response.userId,
                                agentId: response.agentId,
                                roomId: response.roomId,
                                createdAt: response.createdAt,
                                content: response.content,
                                // Include any metadata that might contain file paths or type information
                                metadata: (response.content as any).metadata,
                                // Keep backward compatibility by setting user and text fields
                                user: response.userId === response.agentId ? 'assistant' : 'user',
                                text: response.content.text
                            };

                            sseWrite({ type: 'intermediate_response', response: formattedResponse });
                            elizaLogger.info(`[STREAMING] Sent intermediate response: ${response.content.text?.substring(0, 100)}...`);
                        } catch (error: any) {
                            elizaLogger.error(`Failed to stream intermediate response:`, error);
                        }
                    };

                    // Handle document content: full content for first request, RAG for subsequent requests
                    let enhancedUserMessage = userMessage;
                    try {
                        const fileProcessor = new FileProcessor(runtime as AgentRuntime);
                        const imageProcessor = new ImageProcessor(runtime as AgentRuntime);
                        
                        // Check if we just uploaded document files in this request
                        const hasNewDocuments = documentFiles.length > 0;
                        
                        if (hasNewDocuments) {
                            // FIRST REQUEST: Include full document content
                            elizaLogger.info(`📄 First request with ${documentFiles.length} new document(s). Including full content.`);
                            
                            let fullDocumentContent = '';
                            for (const file of documentFiles) {
                                try {
                                    const filePath = path.join(process.cwd(), "data", "uploaded", file.filename);
                                    const documentText = await fileProcessor.parseFile(filePath, file.mimetype);
                                    
                                    if (documentText && documentText.trim()) {
                                        fullDocumentContent += `\n\n## Document: ${file.originalname}\n\n${documentText}`;
                                    }
                                } catch (error) {
                                    elizaLogger.error(`Error reading document ${file.originalname}:`, error);
                                }
                            }
                            
                            // Get image analysis context from current uploads
                            const currentImageContext = ImageProcessor.formatImageAnalysisForContext(processedAttachments);
                            
                            if (fullDocumentContent || currentImageContext) {
                                const contextText = [fullDocumentContent, currentImageContext]
                                    .filter(ctx => ctx.length > 0)
                                    .join('');
                                
                                enhancedUserMessage = {
                                    ...userMessage,
                                    content: {
                                        ...userMessage.content,
                                        text: `${text}

DOCUMENT CONTENT: The user has uploaded the following document(s). Analyze the content and respond to their request:

${contextText}

Please analyze the document(s) and respond to the user's request above.`,
                                        attachments: processedAttachments
                                    }
                                };
                            }
                        } else {
                            // SUBSEQUENT REQUESTS: Use RAG to find relevant chunks
                            const relevantChunks = await fileProcessor.searchChunks(
                                text,
                                roomId,
                                5 // Get top 5 relevant chunks
                            );
                            
                            const relevantImages = await imageProcessor.searchImages(
                                text,
                                roomId,
                                3 // Get top 3 relevant images
                            );

                            if (relevantChunks.length > 0 || relevantImages.length > 0) {
                                if (relevantChunks.length > 0) {
                                    elizaLogger.info(`📚 Found ${relevantChunks.length} relevant document chunks. Integrating into analysis context.`);
                                }
                                if (relevantImages.length > 0) {
                                    elizaLogger.info(`🖼️ Found ${relevantImages.length} relevant images. Including base64 data in request.`);
                                }
                                
                                // Extract key information from documents
                                const documentInsights = relevantChunks.length > 0 
                                    ? relevantChunks.map((chunk) => chunk.content.text).join(' ')
                                    : '';
                                
                                // Get image analysis context from current uploads
                                const currentImageContext = ImageProcessor.formatImageAnalysisForContext(processedAttachments);
                                
                                // Format relevant images context
                                const relevantImageContext = relevantImages.length > 0
                                    ? `\n\n## Related Images from Previous Uploads\n\n${relevantImages.map((img, index) => 
                                        `### Image ${index + 1}: ${img.fileName}\n${img.analysis}`
                                      ).join('\n\n')}`
                                    : '';
                                
                                // Add relevant images to attachments for base64 inclusion
                                const enhancedAttachments = [
                                    ...processedAttachments,
                                    ...relevantImages.map(img => ({
                                        id: `relevant-${Date.now()}-${Math.random()}`,
                                        url: img.fileName,
                                        title: img.fileName,
                                        source: "rag_retrieved",
                                        description: `Related image: ${img.fileName}`,
                                        text: img.analysis,
                                        contentType: img.mimeType,
                                        base64Data: img.base64Data,
                                        geminiAnalysis: img.analysis
                                    }))
                                ];
                                
                                // Enhance user message with all context
                                const contextText = [documentInsights, currentImageContext, relevantImageContext]
                                    .filter(ctx => ctx.length > 0)
                                    .join('');
                                
                                enhancedUserMessage = {
                                    ...userMessage,
                                    content: {
                                        ...userMessage.content,
                                        text: `${text}

CONTEXT: Use the following background information to enhance your analysis, but integrate it naturally without showing document markers or raw context:

${contextText}

Analyze the request above using this background information and current market data.`,
                                        attachments: enhancedAttachments
                                    }
                                };
                            }
                        }
                    } catch (error) {
                        elizaLogger.error("❌ Error searching document knowledge:", error);
                        // Continue processing without knowledge enhancement
                    }

                    // Anonymous users: route only to regular message handler (no task chain / comprehensive)
                    if (userInfo.type === "anonymous") {
                        const contentRecord = enhancedUserMessage.content as Record<string, unknown>;
                        const existingMeta = contentRecord?.metadata && typeof contentRecord.metadata === "object"
                            ? { ...(contentRecord.metadata as Record<string, unknown>) }
                            : {};
                        existingMeta.isAnonymous = true;
                        contentRecord.metadata = existingMeta;
                    }

                    const shouldForceTaskChain =
                        userInfo.type !== "anonymous" &&
                        requestedMessageClassification === "TASK_CHAIN_MESSAGE";

                    // Process message with intelligent routing based on message classification
                    const responses = shouldForceTaskChain
                        ? await (runtime as AgentRuntime).handleMessageWithTaskChain(
                              enhancedUserMessage,
                              async (actionResponse) => {
                                  if (actionResponse) {
                                      sseWrite({ type: 'action_response', response: actionResponse });
                                  }
                                  return [userMessage];
                              },
                              streamingCallback,
                              intermediateResponseCallback,
                              connectionId,
                              onToken,
                          )
                        : await (runtime as AgentRuntime).routeMessage(
                              enhancedUserMessage,
                              async (actionResponse) => {
                                  if (actionResponse) {
                                      sseWrite({ type: 'action_response', response: actionResponse });
                                  }
                                  return [userMessage];
                              },
                              streamingCallback,
                              intermediateResponseCallback,
                              connectionId,
                              onToken,
                              onAnalysisComplete,
                          );

                    // Send final response - send the complete memory objects instead of just content
                    const allResponses: any[] = [];
                    responses.forEach(response => {
                        if (response.content) {
                            // Include the full memory object with all metadata
                            allResponses.push({
                                id: response.id,
                                userId: response.userId,
                                agentId: response.agentId,
                                roomId: response.roomId,
                                createdAt: response.createdAt,
                                content: response.content,
                                // Include any metadata that might contain file paths or type information
                                metadata: (response.content as any).metadata,
                                // Keep backward compatibility by setting user and text fields
                                user: response.userId === response.agentId ? 'assistant' : 'user',
                                text: response.content.text
                            });
                        }
                    });

                    // Skip sending final consolidated response since all responses were already streamed
                    elizaLogger.info(`Skipping final response transmission - all ${allResponses.length} responses already streamed individually`);
                    
                    // DEBUG: Log all response types we received
                    elizaLogger.info(`🔍 DEBUG: All response types:`, allResponses.map(r => ({
                        id: r.id?.substring(0, 8),
                        contentType: r.content?.type,
                        hasMetadata: !!r.content?.metadata,
                        metadataKeys: r.content?.metadata ? Object.keys(r.content.metadata) : []
                    })));
                    
                    // Send comprehensive analysis report metadata if available
                    elizaLogger.info(`🔍 DEBUG: Looking for comprehensive analysis in ${allResponses.length} responses`);
                    const comprehensiveAnalysis = allResponses.find(r => 
                        r.content?.type === 'comprehensive_analysis_html'
                    );
                    
                    elizaLogger.info(`🔍 DEBUG: Comprehensive analysis found:`, !!comprehensiveAnalysis);
                    if (comprehensiveAnalysis) {
                        elizaLogger.info(`🔍 DEBUG: Comprehensive analysis metadata:`, {
                            hasContent: !!comprehensiveAnalysis.content,
                            hasMetadata: !!comprehensiveAnalysis.content?.metadata,
                            metadataKeys: comprehensiveAnalysis.content?.metadata ? Object.keys(comprehensiveAnalysis.content.metadata) : [],
                            fileName: comprehensiveAnalysis.content?.metadata?.fileName,
                            filePath: comprehensiveAnalysis.content?.metadata?.filePath
                        });
                        const reportMetadata = {
                            type: 'report_ready',
                            reportData: {
                                fileName: comprehensiveAnalysis.content.metadata?.fileName,
                                filePath: comprehensiveAnalysis.content.metadata?.filePath,
                                relativePath: comprehensiveAnalysis.content.metadata?.relativePath,
                                cryptocurrency: comprehensiveAnalysis.content.metadata?.cryptocurrency,
                                cryptoSymbol: comprehensiveAnalysis.content.metadata?.cryptoSymbol,
                                generatedAt: comprehensiveAnalysis.content.metadata?.generatedAt,
                                htmlGenerated: true
                            }
                        };
                        
                        // DEBUG: Log exact timing and content before sending
                        const sendTime = new Date().toISOString();
                        elizaLogger.info(`🔍 DEBUG: About to send report_ready at ${sendTime}`);
                        elizaLogger.info(`🔍 DEBUG: Full report_ready payload:`, JSON.stringify(reportMetadata, null, 2));
                        
                        if (res.writable && !res.destroyed) {
                            res.write(`data: ${JSON.stringify(reportMetadata)}\n\n`);
                        }
                        
                        // DEBUG: Log immediately after writing
                        elizaLogger.info(`🔍 DEBUG: res.write() completed at ${new Date().toISOString()}`);
                        elizaLogger.info(`Sent comprehensive analysis report metadata: ${reportMetadata.reportData.fileName}`);
                        
                        // DEBUG: Add detailed logging after sending report metadata
                        elizaLogger.info(`🔍 DEBUG: Report metadata JSON size: ${JSON.stringify(reportMetadata).length} characters`);
                        elizaLogger.info(`🔍 DEBUG: Report metadata structure:`, {
                            type: reportMetadata.type,
                            hasReportData: !!reportMetadata.reportData,
                            fileName: reportMetadata.reportData?.fileName,
                            filePath: reportMetadata.reportData?.filePath,
                            relativePath: reportMetadata.reportData?.relativePath,
                            cryptocurrency: reportMetadata.reportData?.cryptocurrency,
                            htmlGenerated: reportMetadata.reportData?.htmlGenerated
                        });
                        
                        // DEBUG: Check if response is still writable
                        elizaLogger.info(`🔍 DEBUG: Response writable status:`, {
                            writable: res.writable,
                            destroyed: res.destroyed,
                            finished: res.finished,
                            headersSent: res.headersSent
                        });
                        
                        // DEBUG: Log that we're about to send [DONE] 
                        elizaLogger.info(`🔍 DEBUG: About to send [DONE] message`);
                    }
                    
                    // Clean up keepalive interval before ending
                    clearInterval(keepAliveInterval);

                    // If onAnalysisComplete already fired the stream is closed
                    // (and analysisCompleteFired is true). Skip the duplicate
                    // [DONE]/end so we don't ERR_STREAM_WRITE_AFTER_END.
                    if (!analysisCompleteFired && res.writable && !res.destroyed) {
                        elizaLogger.info(`🔍 DEBUG: Sending [DONE] message to close stream`);
                        res.write(`data: [DONE]\n\n`);
                        res.end();
                    } else {
                        elizaLogger.debug(`🔍 DEBUG: Stream already closed by onAnalysisComplete; skipping trailing [DONE]/end`);
                    }
                    
                    // DEBUG: Log after ending response
                    elizaLogger.info(`🔍 DEBUG: Response stream ended successfully`);

                } catch (error: any) {
                    elizaLogger.error("Error in streaming endpoint:", error);
                    
                    // Clean up keepalive interval on error
                    clearInterval(keepAliveInterval);
                    
                    const errMsg = error instanceof Error ? error.message : (typeof error === 'string' ? error : JSON.stringify(error));
                    res.write(`data: ${JSON.stringify({ type: 'error', error: errMsg })}\n\n`);
                    res.end();
                } finally {
                    this.activeRequests--;
                    restoreModelPreference();
                }
            }
        );

        // Add endpoint to serve comprehensive analysis reports
        this.app.get(
            "/agents/:agentIdOrName/reports/:fileName",
            async (req: express.Request, res: express.Response) => {
                try {
                    const { fileName } = req.params;
                    const agentId = req.params.agentIdOrName;
                    
                    // Validate agent exists
                    let runtime = this.agents.get(agentId);
                    if (!runtime) {
                        runtime = Array.from(this.agents.values()).find(
                            (a) => a.character.name.toLowerCase() === agentId.toLowerCase()
                        );
                    }
                    
                    if (!runtime) {
                        res.status(404).json({ error: "Agent not found" });
                        return;
                    }
                    
                    // Validate filename for security (only allow HTML files with specific pattern)
                    if (!fileName.match(/^comprehensive analysis [A-Z]+ \d{4}-\d{2}-\d{2}\.html$/)) {
                        res.status(400).json({ error: "Invalid report filename" });
                        return;
                    }
                    
                    // Construct safe file path. `path` and `fs` are already
                    // top-level ESM imports — the previous local
                    // `require('path') / require('fs')` calls would throw
                    // `Dynamic require of "..." is not supported` at runtime
                    // under the ESM bundle (same class of bug as
                    // generateShareCode in api.ts).
                    const reportsDir = path.join(process.cwd(), 'saved_data', 'Reports');
                    const filePath = path.join(reportsDir, fileName);
                    
                    // Check if file exists
                    if (!fs.existsSync(filePath)) {
                        res.status(404).json({ error: "Report file not found" });
                        return;
                    }
                    
                    // Read and serve the HTML file
                    const htmlContent = fs.readFileSync(filePath, 'utf8');
                    
                    res.setHeader('Content-Type', 'text/html; charset=utf-8');
                    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
                    res.send(htmlContent);
                    
                    elizaLogger.info(`Served comprehensive analysis report: ${fileName}`);
                    
                } catch (error: any) {
                    elizaLogger.error("Error serving report:", error);
                    res.status(500).json({ error: "Failed to serve report" });
                }
            }
        );

        this.app.post(
            "/:agentId/image",
            imageLimiter,
            async (req: express.Request, res: express.Response) => {
                const agentId = req.params.agentId;
                const agent = this.agents.get(agentId);
                if (!agent) {
                    res.status(404).send("Agent not found");
                    return;
                }

                const images = await generateImage({ ...req.body }, agent);
                const imagesRes: { image: string; caption: string }[] = [];
                if (images.data && images.data.length > 0) {
                    for (let i = 0; i < images.data.length; i++) {
                        const caption = await generateCaption(
                            { imageUrl: images.data[i] },
                            agent
                        );
                        imagesRes.push({
                            image: images.data[i],
                            caption: caption.title,
                        });
                    }
                }
                res.json({ images: imagesRes });
            }
        );

        this.app.post(
            "/fine-tune",
            checkAuthenticated,
            async (req: express.Request, res: express.Response) => {
                try {
                    const response = await fetch(
                        "https://api.bageldb.ai/api/v1/asset",
                        {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                "X-API-KEY": `${process.env.BAGEL_API_KEY}`,
                            },
                            body: JSON.stringify(req.body),
                        }
                    );

                    const data = await response.json();
                    res.json(data);
                } catch (error) {
                    res.status(500).json({
                        error: "Please create an account at bakery.bagel.net and get an API key. Then set the BAGEL_API_KEY environment variable.",
                        details: error.message,
                    });
                }
            }
        );
        this.app.get(
            "/fine-tune/:assetId",
            async (req: express.Request, res: express.Response) => {
                const assetId = req.params.assetId;

                const ROOT_DIR = path.join(process.cwd(), "downloads");
                const downloadDir = path.resolve(ROOT_DIR, assetId);

                if (!downloadDir.startsWith(ROOT_DIR)) {
                    res.status(403).json({
                        error: "Invalid assetId. Access denied.",
                    });
                    return;
                }
                elizaLogger.log("Download directory:", downloadDir);

                try {
                    elizaLogger.log("Creating directory...");
                    await fs.promises.mkdir(downloadDir, { recursive: true });

                    elizaLogger.log("Fetching file...");
                    const fileResponse = await fetch(
                        `https://api.bageldb.ai/api/v1/asset/${assetId}/download`,
                        {
                            headers: {
                                "X-API-KEY": `${process.env.BAGEL_API_KEY}`,
                            },
                        }
                    );

                    if (!fileResponse.ok) {
                        throw new Error(
                            `API responded with status ${
                                fileResponse.status
                            }: ${await fileResponse.text()}`
                        );
                    }

                    elizaLogger.log("Response headers:", fileResponse.headers);

                    const rawFileName =
                        fileResponse.headers
                            .get("content-disposition")
                            ?.split("filename=")[1]
                            ?.replace(/"/g, /* " */ "") || "default_name.txt";
                    // H7: Prevent path traversal via attacker-controlled Content-Disposition
                    const fileName = path.basename(rawFileName) || "default_name.txt";

                    elizaLogger.log("Saving as:", fileName);

                    const arrayBuffer = await fileResponse.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);

                    const filePath = path.join(downloadDir, fileName);
                    elizaLogger.log("Full file path:", filePath);

                    await fs.promises.writeFile(
                        filePath,
                        new Uint8Array(buffer)
                    );

                    // Verify file was written
                    const stats = await fs.promises.stat(filePath);
                    elizaLogger.log(
                        "File written successfully. Size:",
                        stats.size,
                        "bytes"
                    );

                    res.json({
                        success: true,
                        message: "Single file downloaded successfully",
                        downloadPath: downloadDir,
                        fileCount: 1,
                        fileName: fileName,
                        fileSize: stats.size,
                    });
                } catch (error) {
                    elizaLogger.error("Detailed error:", error);
                    res.status(500).json({
                        error: "Failed to download files from BagelDB",
                        details: error.message,
                    });
                }
            }
        );

        this.app.post("/:agentId/speak", ttsLimiter, async (req, res) => {
            const agentId = req.params.agentId;
            const timestamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '-');
            const roomId = stringToUuid(
                req.body.roomId ?? `default-room-${agentId}-${timestamp}`
            );
            const text = req.body.text;

            if (!text) {
                res.status(400).send("No text provided");
                return;
            }

            let runtime = this.agents.get(agentId);

            // if runtime is null, look for runtime with the same name
            if (!runtime) {
                runtime = Array.from(this.agents.values()).find(
                    (a) =>
                        a.character.name.toLowerCase() === agentId.toLowerCase()
                );
            }

            if (!runtime) {
                res.status(404).send("Agent not found");
                return;
            }

            const userInfo = getUserInfo(req);
            const fallbackUserId = getUserId(req);
            const userId = await resolveAuthenticatedUserId(
                runtime,
                userInfo,
                fallbackUserId
            );
            if (userInfo.type === 'authenticated') {
                elizaLogger.info(`🔐 Speak request from ${userInfo.email} -> userId: ${userId}`);
            } else {
                elizaLogger.info(`🌐 Speak request from IP: ${userInfo.ip} -> userId: ${userId}`);
            }

            let restoreModelPreference: () => void = () => {};

            try {
                restoreModelPreference = applyAuthenticatedModelPreference(runtime, userInfo);
                // Process message through agent (same as /message endpoint)
                await runtime.ensureConnection(
                    userId,
                    roomId,
                    req.body.userName,
                    req.body.name,
                    "direct"
                );

                enterUsageTrackingContext({
                    userId: String(userId),
                    roomId: String(roomId),
                });

                const messageId = stringToUuid(Date.now().toString());

                const content: Content = {
                    text,
                    attachments: [],
                    source: "direct",
                    inReplyTo: undefined,
                };

                const userMessage = {
                    content,
                    userId,
                    roomId,
                    agentId: runtime.agentId,
                };

            const memory: Memory = {
                id: messageId,
                agentId: runtime.agentId,
                userId,
                roomId,
                content,
                createdAt: Date.now(),
                ...(userInfo.type === "anonymous" && userInfo.ip
                    ? { clientIP: userInfo.ip }
                    : {}),
            };

                await runtime.messageManager.createMemory(memory);

                const state = await runtime.composeState(userMessage, {
                    agentName: runtime.character.name,
                });

                const context = composeContext({
                    state,
                    template: messageHandlerTemplate,
                });

                const response = await generateMessageResponse({
                    runtime: runtime,
                    context,
                    modelClass: ModelClass.LARGE,
                    userId: userId as string,
                });

                // save response to memory
                const responseMessage = {
                    ...userMessage,
                    userId: runtime.agentId,
                    content: response,
                };

                await runtime.messageManager.createMemory(responseMessage);

                if (!response) {
                    res.status(500).send(
                        "No response from generateMessageResponse"
                    );
                    return;
                }

                await runtime.evaluate(memory, state);

                const _result = await runtime.processActions(
                    memory,
                    [responseMessage],
                    state,
                    async () => {
                        return [memory];
                    }
                );

                // Get the text to convert to speech
                const textToSpeak = response.text;

                // Convert to speech using ElevenLabs
                const elevenLabsApiUrl = `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`;
                const apiKey = process.env.ELEVENLABS_XI_API_KEY;

                if (!apiKey) {
                    throw new Error("ELEVENLABS_XI_API_KEY not configured");
                }

                const speechResponse = await fetch(elevenLabsApiUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "xi-api-key": apiKey,
                    },
                    body: JSON.stringify({
                        text: textToSpeak,
                        model_id:
                            process.env.ELEVENLABS_MODEL_ID ||
                            "eleven_multilingual_v2",
                        voice_settings: {
                            stability: Number.parseFloat(
                                process.env.ELEVENLABS_VOICE_STABILITY || "0.5"
                            ),
                            similarity_boost: Number.parseFloat(
                                process.env.ELEVENLABS_VOICE_SIMILARITY_BOOST ||
                                    "0.9"
                            ),
                            style: Number.parseFloat(
                                process.env.ELEVENLABS_VOICE_STYLE || "0.66"
                            ),
                            use_speaker_boost:
                                process.env
                                    .ELEVENLABS_VOICE_USE_SPEAKER_BOOST ===
                                "true",
                        },
                    }),
                });

                if (!speechResponse.ok) {
                    throw new Error(
                        `ElevenLabs API error: ${speechResponse.statusText}`
                    );
                }

                const audioBuffer = await speechResponse.arrayBuffer();

                // Set appropriate headers for audio streaming
                res.set({
                    "Content-Type": "audio/mpeg",
                    "Transfer-Encoding": "chunked",
                });

                res.send(Buffer.from(audioBuffer));
            } catch (error) {
                elizaLogger.error(
                    "Error processing message or generating speech:",
                    error
                );
                res.status(500).json({
                    error: "Error processing message or generating speech",
                    details: error.message,
                });
            } finally {
                restoreModelPreference();
            }
        });

        this.app.post("/:agentId/tts", ttsLimiter, async (req, res) => {
            const text = req.body.text;

            if (!text) {
                res.status(400).send("No text provided");
                return;
            }

            try {
                // Convert to speech using ElevenLabs
                const elevenLabsApiUrl = `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`;
                const apiKey = process.env.ELEVENLABS_XI_API_KEY;

                if (!apiKey) {
                    throw new Error("ELEVENLABS_XI_API_KEY not configured");
                }

                const speechResponse = await fetch(elevenLabsApiUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "xi-api-key": apiKey,
                    },
                    body: JSON.stringify({
                        text,
                        model_id:
                            process.env.ELEVENLABS_MODEL_ID ||
                            "eleven_multilingual_v2",
                        voice_settings: {
                            stability: Number.parseFloat(
                                process.env.ELEVENLABS_VOICE_STABILITY || "0.5"
                            ),
                            similarity_boost: Number.parseFloat(
                                process.env.ELEVENLABS_VOICE_SIMILARITY_BOOST ||
                                    "0.9"
                            ),
                            style: Number.parseFloat(
                                process.env.ELEVENLABS_VOICE_STYLE || "0.66"
                            ),
                            use_speaker_boost:
                                process.env
                                    .ELEVENLABS_VOICE_USE_SPEAKER_BOOST ===
                                "true",
                        },
                    }),
                });

                if (!speechResponse.ok) {
                    throw new Error(
                        `ElevenLabs API error: ${speechResponse.statusText}`
                    );
                }

                const audioBuffer = await speechResponse.arrayBuffer();

                res.set({
                    "Content-Type": "audio/mpeg",
                    "Transfer-Encoding": "chunked",
                });

                res.send(Buffer.from(audioBuffer));
            } catch (error) {
                elizaLogger.error(
                    "Error processing message or generating speech:",
                    error
                );
                res.status(500).json({
                    error: "Error processing message or generating speech",
                    details: error.message,
                });
            }
        });

        // Serve frontend static files (production)
        const clientDistPath = path.join(process.cwd(), '..', 'client', 'dist');
        if (fs.existsSync(clientDistPath)) {
            // Serve Vite's pre-built .br / .gz variants of the JS/CSS chunks
            // before falling back to express.static. The on-the-fly
            // compression() middleware was registered correctly but never
            // emitted Content-Encoding for these assets on staging — most
            // likely because serve-static set Content-Length from fs.stat
            // before compression's res.write hook had a chance to intervene.
            //
            // Pre-compressed serving sidesteps the issue entirely:
            //   - Vite already runs Brotli at level 11 (vite-plugin-compression
            //     in client/vite.config.ts), which is much smaller than what
            //     compression@1.x's gzip default produces anyway.
            //   - Zero per-request CPU cost — files are read straight off disk.
            //   - Brotli preferred, gzip fallback, raw file last.
            this.app.use(preCompressedAssetsMiddleware(clientDistPath));
            this.app.use(express.static(clientDistPath));

            // SPA fallback — serve index.html for all unmatched GET requests
            this.app.get('*', (_req, res) => {
                res.sendFile(path.join(clientDistPath, 'index.html'));
            });
        }
    }

    // agent/src/index.ts:startAgent calls this
    public registerAgent(runtime: AgentRuntime) {
        // register any plugin endpoints?
        // but once and only once
        this.agents.set(runtime.agentId, runtime);

        // Attach fileStorageService to runtime so core handlers can use it without a direct import
        (runtime as any).fileStorageService = fileStorageService;

        // Start file watcher on first registered runtime
        if (!this.fileWatcher) {
            this.fileWatcher = new FileWatcherService(runtime);
            this.fileWatcher.start();
        }
    }

    public unregisterAgent(runtime: AgentRuntime) {
        this.agents.delete(runtime.agentId);
    }

    public registerMiddleware(middleware: Middleware) {
        this.app.use(middleware);
    }

    public getReportSyncService(): ReportSyncService {
        return this.reportSyncService;
    }

    public getTrendingSentiscoreService(): TrendingSentiscoreService {
        return this.trendingSentiscoreService;
    }

    public getDailyAnalysisScheduler(): DailyAnalysisSchedulerService {
        return this.dailyAnalysisScheduler;
    }

    public getAnalyticsSnapshotService(): AnalyticsSnapshotService {
        return this.analyticsSnapshotService;
    }

    public startDailyAnalysisScheduler(): void {
        this.dailyAnalysisScheduler.start();
    }

    public start(port: number) {
        this.server = this.app.listen(port, () => {
            elizaLogger.success(
                `REST API bound to 0.0.0.0:${port}. If running locally, access it at http://localhost:${port}.`
            );
        });

        // Avoid the Node-behind-ALB keep-alive race: AWS ALB reuses idle HTTP/1.1
        // keep-alive sockets up to its idle_timeout (600s in our infra). Node's
        // default keepAliveTimeout is 5s, so the ALB will routinely try to send
        // a request on a socket Node has just closed — surfaces as ALB-generated
        // 502s (HTTPCode_ELB_502_Count, no target 5xx). Keep the server's keep-alive
        // strictly greater than the ALB's, and headersTimeout strictly greater
        // than keepAliveTimeout (Node enforces this ordering since 18.x).
        const keepAliveTimeoutMs = Number(process.env.SERVER_KEEP_ALIVE_TIMEOUT_MS ?? 620_000);
        const headersTimeoutMs = Number(process.env.SERVER_HEADERS_TIMEOUT_MS ?? keepAliveTimeoutMs + 5_000);
        this.server.keepAliveTimeout = keepAliveTimeoutMs;
        this.server.headersTimeout = headersTimeoutMs;

        // Handle graceful shutdown
        const gracefulShutdown = () => {
            elizaLogger.log("Received shutdown signal, closing server...");
            this.server.close(() => {
                elizaLogger.success("Server closed successfully");
                process.exit(0);
            });

            // Force close after 5 seconds if server hasn't closed
            setTimeout(() => {
                elizaLogger.error(
                    "Could not close connections in time, forcefully shutting down"
                );
                process.exit(1);
            }, 5000);
        };

        // Handle different shutdown signals
        process.on("SIGTERM", gracefulShutdown);
        process.on("SIGINT", gracefulShutdown);
    }

    public async stop() {
        this.reportSyncService.stop();
        this.dailyAnalysisScheduler.stop();
        this.analyticsSnapshotService.stop();
        this.fileWatcher?.stop();
        if (this.server) {
            this.server.close(() => {
                elizaLogger.success("Server stopped");
            });
        }
    }
}

export const DirectClientInterface: Client = {
    name: "direct",
    config: {},
    start: async (_runtime: AgentRuntime) => {
        elizaLogger.log("DirectClientInterface start");
        const client = new DirectClient();
        const serverPort = Number.parseInt(settings.SERVER_PORT || "3000");
        client.start(serverPort);
        return client;
    },
    // stop: async (_runtime: AgentRuntime, client?: Client) => {
    //     if (client instanceof DirectClient) {
    //         client.stop();
    //     }
    // },
};

const directPlugin: Plugin = {
    name: "direct",
    description: "Direct client",
    clients: [DirectClientInterface],
};

export { FileProcessor } from "./fileProcessor.js";
export default directPlugin;
