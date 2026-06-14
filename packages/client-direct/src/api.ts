import express from "express";
import type { Router, RequestHandler } from 'express';
import bodyParser from "body-parser";
import cors from "cors";
import path from "path";
import fs from "fs";
import { randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
import { v4 as uuidv4 } from "uuid";
import {
    constructStripeEvent,
    getSubscriptionStatusByEmail,
    getStripeWebhookSecret,
    isStripeConfigured,
    type ResolvedSubscriptionTier,
    type SubscriptionLookupResult,
} from "./stripeService.ts";

import {
    type AgentRuntime,
    elizaLogger,
    generateText,
    getEnvVariable,
    getLatestTierFromHistory,
    httpClient,
    resolveEffectiveSubscriptionTierFromAdapter,
    ModelClass,
    ModelProviderName,
    type UUID,
    validateCharacterConfig,
    isPublicAccessModeActive,
    ServiceType,
    type Character,
    type TaskChain,
    type TaskChainData,
    type FavoriteTaskChainRecord,
    type SharedTaskChainRecord,
    type SharedChatRecord,
    type SharedChatCreateInput,
    type ExchangeAuths,
    type DefaultExchangeAuth,
    type ExchangeAuthType,
    type ExchangeId,
    isComprehensiveAnalysisInProgress,
    getPendingApprovalForRoom,
    applyPlanStepEdit,
    revokePendingApprovalsForUser,
    emitEventToUser,
    buildMarketSnapshot,
} from "@elizaos/core";

import type { CEXSpecProvider } from "@elizaos/core";

/**
 * Minimal inline lookup of the CEX provider — duplicates the one in
 * `cexWorkflowMessageHandler.ts` rather than re-exporting it from
 * `@elizaos/core`, because exporting the handler module's helpers
 * from the barrel pulls the whole file into the dts compile graph
 * and surfaces pre-existing strictness errors on unrelated code.
 */
function getCEXSpecProvider(runtime: AgentRuntime): CEXSpecProvider | undefined {
    for (const plugin of (runtime as { plugins?: Array<{ cexSpecProvider?: CEXSpecProvider }> }).plugins ?? []) {
        if (plugin?.cexSpecProvider) return plugin.cexSpecProvider;
    }
    return undefined;
}

// import type { TeeLogQuery, TeeLogService } from "@elizaos/plugin-tee-log";
// import { REST, Routes } from "discord.js";
import type { DirectClient } from ".";
import { validateUuid } from "@elizaos/core";
import { emailToUserId, getUserIdFromIP, getIPInfo, getUserId, getUserInfo } from "./ipUtils.ts";
import { cleanupAnonymousHistoryIfExpired } from "./historyCleanup.ts";
import { fileStorageService } from "./services/fileStorageService.ts";
import { requireRole } from "./auth/rbac.ts";
import {
    getUserQuotaStatus,
    getUserQuotaTier,
    WEEKLY_TOKEN_LIMITS_BY_TIER,
} from "./services/quotaService.ts";
import {
    getPendingApprovalContext,
    type PendingApprovalContext,
    type RuntimeWithPendingApprovalMaps,
    validatePendingApprovalDecision,
} from "./approvalLookup.ts";
import {
    decrypt,
    encrypt,
    getSecretPreview,
    isEncrypted,
} from "@elizaos/core";

type CoinMarketCapPriceCacheEntry = {
    payload: { success: true; symbol: string; convert: string; price: number | null; lastUpdatedMs: number };
    timestampMs: number;
};

const coinMarketCapPriceCache = new Map<string, CoinMarketCapPriceCacheEntry>();
const coinMarketCapPending = new Map<string, Promise<CoinMarketCapPriceCacheEntry["payload"]>>();
const COINMARKETCAP_PRICE_CACHE_MS = (() => {
    const raw = Number(process.env.COINMARKETCAP_PRICE_CACHE_MS);
    if (Number.isFinite(raw) && raw > 0) return raw;
    return 10_000;
})();

interface UUIDParams {
    agentId: UUID;
    roomId?: UUID;
}

const getRequestOrigin = (req: express.Request): string => {
    const forwardedProto = req.headers["x-forwarded-proto"];
    const forwardedHost = req.headers["x-forwarded-host"];
    const proto = (typeof forwardedProto === "string" ? forwardedProto : undefined)?.split(",")[0]?.trim()
        || req.protocol;
    const host = (typeof forwardedHost === "string" ? forwardedHost : undefined)?.split(",")[0]?.trim()
        || req.get("host")
        || "localhost";
    return `${proto}://${host}`;
};

const toPublicMediaUrl = (req: express.Request, rawUrl: unknown): unknown => {
    if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
        return rawUrl;
    }

    const url = rawUrl.trim();
    const origin = getRequestOrigin(req);

    if (url.startsWith("data:") || url.startsWith("blob:")) {
        return url;
    }

    // Dev / tunnel URLs stored in memories — anonymous shared-chat viewers need the API host.
    if (url.startsWith("http://") || url.startsWith("https://")) {
        try {
            const parsed = new URL(url);
            if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
                const pathAndQuery = `${parsed.pathname}${parsed.search}${parsed.hash}`;
                return `${origin}${pathAndQuery}`;
            }
        } catch {
            /* keep raw */
        }
        return url;
    }

    const normalized = url.replace(/\\/g, "/");

    const uploadsMarker = "/data/uploaded/";
    const uploadsIndex = normalized.lastIndexOf(uploadsMarker);
    if (uploadsIndex !== -1) {
        const fileName = path.posix.basename(normalized.substring(uploadsIndex + uploadsMarker.length));
        return `${origin}/media/uploads/${encodeURIComponent(fileName)}`;
    }

    const generatedMarker = "/generatedImages/";
    const generatedIndex = normalized.lastIndexOf(generatedMarker);
    if (generatedIndex !== -1) {
        const fileName = path.posix.basename(normalized.substring(generatedIndex + generatedMarker.length));
        return `${origin}/media/generated/${encodeURIComponent(fileName)}`;
    }

    // If the URL is already a server-relative static path, make it absolute for cross-origin clients.
    if (normalized.startsWith("/media/uploads/") || normalized.startsWith("/media/generated/")) {
        return `${origin}${normalized}`;
    }

    // S3 proxy paths from FileStorageService (same-origin for SPA + anonymous viewers).
    if (normalized.startsWith("/s3-files/")) {
        return `${origin}${normalized}`;
    }

    if (normalized.startsWith("/charts/") || normalized.startsWith("/reports/")) {
        return `${origin}${normalized}`;
    }

    return url;
};

const toPublicMediaUrlString = (req: express.Request, rawUrl: unknown): string => {
    const out = toPublicMediaUrl(req, rawUrl);
    return typeof out === "string" ? out : String(rawUrl ?? "");
};

/**
 * Shared-chat viewers load the SPA from the same host as the API, but message text often contains
 * relative paths, internal saved_data paths, or dev-time http://localhost URLs. Rewrite so markdown
 * images and <img> tags resolve for anonymous viewers.
 */
const rewriteSharedChatMessageTextForViewer = (req: express.Request, rawText: string): string => {
    if (typeof rawText !== "string" || rawText.length === 0) {
        return rawText;
    }
    let text = rawText;
    const origin = getRequestOrigin(req);

    text = text.replace(
        /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(\/(?:media\/|charts\/|reports\/)[^\s\)]*)/gi,
        (_full, path: string) => `${origin}${path}`,
    );

    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, urlRaw: string) => {
        const trimmed = urlRaw.trim();
        const url = trimmed.replace(/^<|>$/g, "").split(/\s+/)[0] ?? trimmed;
        const next = toPublicMediaUrlString(req, url);
        return `![${alt}](${next})`;
    });

    text = text.replace(
        /<img\b([^>]*?)\bsrc\s*=\s*(["'])(.*?)\2([^>]*)>/gi,
        (_m, before: string, q: string, url: string, after: string) => {
            const next = toPublicMediaUrlString(req, url.trim());
            return `<img${before}src=${q}${next}${q}${after}>`;
        },
    );

    return text;
};

/** Same normalization as authenticated message serializer — unwrap stringified content / nested JSON text. */
const normalizeRawMemoryContent = (rawInput: unknown): Record<string, any> => {
    let raw: Record<string, any> =
        rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
            ? (rawInput as Record<string, any>)
            : {};
    if (typeof rawInput === "string") {
        try {
            const parsed = JSON.parse(rawInput);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                raw = parsed as Record<string, any>;
            } else {
                raw = { text: rawInput };
            }
        } catch {
            raw = { text: rawInput };
        }
    }
    if (raw && typeof raw.text === "string") {
        try {
            const parsed = JSON.parse(raw.text);
            if (parsed && typeof parsed === "object" && typeof parsed.text === "string") {
                raw = { ...parsed, ...raw, text: parsed.text };
            }
        } catch {
            /* keep */
        }
    }
    return raw;
};

const DEEP_MEDIA_REWRITE_MAX_DEPTH = 14;

const URL_BEARING_SHARED_KEYS = new Set([
    "url",
    "uri",
    "src",
    "href",
    "image",
    "imageurl",
    "videourl",
    "audiourl",
    "thumbnailurl",
    "charturl",
    "chartpath",
    "chartpaths",
    "reporturl",
    "reportpath",
    "reportpaths",
    "filepath",
]);

const isUrlBearingKey = (key?: string): boolean => {
    if (!key) return false;
    const normalized = key.toLowerCase();
    if (URL_BEARING_SHARED_KEYS.has(normalized)) return true;
    return (
        normalized.endsWith("url") ||
        normalized.endsWith("uri") ||
        normalized.endsWith("path") ||
        normalized.endsWith("paths") ||
        normalized.endsWith("src") ||
        normalized.endsWith("href")
    );
};

/** Rewrite only known URL-bearing fields for shared-chat viewers. */
const deepRewriteMediaUrlsInJson = (
    req: express.Request,
    value: unknown,
    depth = 0,
    currentKey?: string,
): unknown => {
    if (depth > DEEP_MEDIA_REWRITE_MAX_DEPTH) return value;
    if (value === null || value === undefined) return value;
    if (typeof value === "string") {
        if (!isUrlBearingKey(currentKey)) return value;
        return toPublicMediaUrl(req, value);
    }
    if (Array.isArray(value)) {
        return value.map((item) => deepRewriteMediaUrlsInJson(req, item, depth + 1, currentKey));
    }
    if (typeof value === "object") {
        const obj = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(obj)) {
            out[key] = deepRewriteMediaUrlsInJson(req, obj[key], depth + 1, key);
        }
        return out;
    }
    return value;
};

const buildPublicSharedMemoryPayload = (req: express.Request, memory: any) => {
    const raw = normalizeRawMemoryContent(memory?.content);
    const text =
        typeof raw.text === "string" ? rewriteSharedChatMessageTextForViewer(req, raw.text as string) : "";

    const contentCore: Record<string, unknown> = {
        text,
        ...(raw.action !== undefined ? { action: raw.action } : {}),
        ...(raw.source !== undefined ? { source: raw.source } : {}),
        ...(raw.url !== undefined ? { url: toPublicMediaUrl(req, raw.url) } : {}),
        ...(raw.inReplyTo !== undefined ? { inReplyTo: raw.inReplyTo } : {}),
        ...(raw.metadata !== undefined ? { metadata: raw.metadata } : {}),
        ...(raw.actionData !== undefined ? { actionData: raw.actionData } : {}),
        ...(raw.actionResults !== undefined ? { actionResults: raw.actionResults } : {}),
        ...(Array.isArray(raw.attachments)
            ? {
                  attachments: raw.attachments.map((attachment: any) => ({
                      id: attachment.id,
                      url: toPublicMediaUrl(req, attachment.url),
                      title: attachment.title,
                      source: attachment.source,
                      description: attachment.description,
                      text: attachment.text,
                      contentType: attachment.contentType,
                  })),
              }
            : {}),
    };

    const content = deepRewriteMediaUrlsInJson(req, contentCore) as Record<string, unknown>;

    return {
        id: memory.id,
        userId: memory.userId,
        agentId: memory.agentId,
        createdAt: memory.createdAt,
        content,
        roomId: memory.roomId,
    };
};

const formatDefaultRoomName = (): string => {
    const now = new Date();
    const pad = (value: number) => value.toString().padStart(2, "0");
    const datePart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const timePart = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    return `Chat ${datePart} ${timePart}`;
};

const DEFAULT_ROOM_NAME_REGEX = /^Chat \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

const PRUNE_EMPTY_ROOM_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const parseRoomCreatedAtMs = (value: unknown): number => {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : Number.NaN;
    }
    if (typeof value === "string") {
        if (/^\d+$/.test(value)) {
            const n = Number(value);
            return Number.isFinite(n) ? n : Number.NaN;
        }
        return new Date(value).getTime();
    }
    return Number.NaN;
};

async function pruneEmptyRooms(
    runtime: AgentRuntime,
    agentId: UUID,
    userId: UUID,
    olderThanMs: number = PRUNE_EMPTY_ROOM_MAX_AGE_MS,
): Promise<void> {
    try {
        const cutoff = Date.now() - olderThanMs;
        const roomIds = await runtime.databaseAdapter.getRoomsForParticipant(
            userId,
            agentId,
        );
        for (const roomId of roomIds) {
            try {
                const roomData = await runtime.databaseAdapter.getRoomById(roomId);
                if (!roomData?.name) continue;
                if (!DEFAULT_ROOM_NAME_REGEX.test(roomData.name.trim())) continue;

                const createdAtMs = parseRoomCreatedAtMs(roomData.createdAt);
                if (!Number.isFinite(createdAtMs) || createdAtMs >= cutoff) continue;

                const messageCount = await runtime.messageManager.countMemories(roomId);
                if (messageCount > 0) continue;

                await runtime.databaseAdapter.removeRoom(roomId);
                await runtime.databaseAdapter.removeParticipantsByRoom(roomId);
                elizaLogger.info(
                    `🧹 Pruned empty auto-named room ${roomId} (>24h old) for user ${userId}`,
                );
            } catch (innerError) {
                elizaLogger.warn(
                    `pruneEmptyRooms: failed to evaluate room ${roomId} for ${userId}: ${(innerError as Error).message}`,
                );
            }
        }
    } catch (error) {
        elizaLogger.error(
            `pruneEmptyRooms failed for user ${userId}: ${(error as Error).message}`,
        );
    }
}

function validateUUIDParams(
    params: { agentId?: string; roomId?: string },
    res: express.Response
): UUIDParams | null {
    const agentIdParam = params.agentId;
    if (!agentIdParam) {
        res.status(400).json({
            error: "Missing required agentId parameter.",
        });
        return null;
    }

    const agentId = validateUuid(agentIdParam);
    if (!agentId) {
        res.status(400).json({
            error: "Invalid AgentId format. Expected to be a UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        });
        return null;
    }

    if (params.roomId) {
        const roomId = validateUuid(params.roomId);
        if (!roomId) {
            res.status(400).json({
                error: "Invalid RoomId format. Expected to be a UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
            });
            return null;
        }
        return { agentId, roomId };
    }

    return { agentId };
}

const SHARE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SHARE_CODE_LENGTH = 10;

function generateShareCode(length = SHARE_CODE_LENGTH): string {
    // Use the top-level ESM import. The previous `require("crypto")` form
    // was an unconditional 500 in production: tsup bundles this package as
    // ESM, and esbuild's runtime stub for dynamic require throws
    // `Dynamic require of "crypto" is not supported`, which surfaced as
    // every `POST /shared-chat` returning the generic "Failed to create
    // shared chat" error.
    const buf = randomBytes(length);
    let result = "";
    for (let i = 0; i < length; i++) {
        result += SHARE_CODE_ALPHABET[buf[i] % SHARE_CODE_ALPHABET.length];
    }
    return result;
}

function serializeFavoriteTaskChainRecord(
    favorite: FavoriteTaskChainRecord
) {
    const serialized: {
        favoriteId: UUID;
        id: string;
        name: string;
        originalName: string;
        description: string;
        taskChain: TaskChainData;
        createdAt: number;
        lastUsedAt?: number;
        isPublic: boolean;
    } = {
        favoriteId: favorite.id,
        id: favorite.chainId,
        name: favorite.name,
        originalName: favorite.originalName,
        description: favorite.description ?? "",
        taskChain: favorite.taskChain,
        createdAt: favorite.createdAt,
        isPublic: favorite.isPublic,
    };

    if (typeof favorite.lastUsedAt === "number") {
        serialized.lastUsedAt = favorite.lastUsedAt;
    }

    return serialized;
}

function stripTaskChainExecution(taskChain: TaskChainData): TaskChainData {
    return {
        ...taskChain,
        tasks: Array.isArray(taskChain.tasks)
            ? taskChain.tasks.map(task => ({
                  ...task,
                  status: "pending",
                  hasResult: false,
                  isSuccess: false,
                  executionResult: undefined,
                  startTime: undefined,
                  endTime: undefined,
                  error: undefined,
              }))
            : taskChain.tasks,
    };
}

function serializeSharedTaskChainRecord(
    share: SharedTaskChainRecord
) {
    return {
        shareId: share.id,
        shareCode: share.shareCode,
        agentId: share.agentId,
        favoriteId: share.favoriteId ?? null,
        chainId: share.chainId,
        name: share.name,
        originalName: share.originalName,
        description: share.description ?? "",
        taskChain: share.taskChain,
        createdAt: share.createdAt,
    };
}

function serializeSharedChatRecord(share: SharedChatRecord) {
    return {
        shareId: share.id,
        shareCode: share.shareCode,
        agentId: share.agentId,
        roomId: share.roomId,
        createdAt: share.createdAt,
    };
}

function mapSharedChatRow(row: any): SharedChatRecord | null {
    if (!row) return null;
    const createdAt =
        typeof row.createdAt === "number"
            ? row.createdAt
            : new Date(row.createdAt).getTime();
    return {
        id: String(row.id) as UUID,
        shareCode: String(row.shareCode),
        userId: String(row.userId) as UUID,
        agentId: String(row.agentId) as UUID,
        roomId: String(row.roomId) as UUID,
        createdAt,
    } satisfies SharedChatRecord;
}


async function getSharedChatByRoomCompat(
    databaseAdapter: any,
    params: { agentId: UUID; roomId: UUID }
): Promise<SharedChatRecord | null> {
    if (typeof databaseAdapter?.getSharedChatByRoom === "function") {
        return await databaseAdapter.getSharedChatByRoom(params);
    }

    const db = databaseAdapter?.db;
    if (db?.prepare) {
        try {
            const row = db
                .prepare(`SELECT * FROM shared_chats WHERE agentId = ? AND roomId = ?`)
                .get(params.agentId, params.roomId);
            return mapSharedChatRow(row);
        } catch (error) {
            elizaLogger.warn("Compat getSharedChatByRoom failed:", error);
        }
    }

    return null;
}

async function getSharedChatByCodeCompat(
    databaseAdapter: any,
    shareCode: string
): Promise<SharedChatRecord | null> {
    if (typeof databaseAdapter?.getSharedChatByCode === "function") {
        return await databaseAdapter.getSharedChatByCode(shareCode);
    }

    const db = databaseAdapter?.db;
    if (db?.prepare) {
        try {
            const row = db.prepare(`SELECT * FROM shared_chats WHERE shareCode = ?`).get(shareCode);
            return mapSharedChatRow(row);
        } catch (error) {
            elizaLogger.warn("Compat getSharedChatByCode failed:", error);
        }
    }

    return null;
}

async function createSharedChatCompat(
    databaseAdapter: any,
    params: SharedChatCreateInput
): Promise<SharedChatRecord> {
    if (typeof databaseAdapter?.createSharedChat === "function") {
        return await databaseAdapter.createSharedChat(params);
    }

    const db = databaseAdapter?.db;
    if (!db?.prepare) {
        throw new Error("Database adapter does not support shared chats");
    }

    const sharedId = uuidv4() as UUID;
    const createdAt = params.createdAt ?? Date.now();

    db.prepare(
        `INSERT INTO shared_chats (id, shareCode, userId, agentId, roomId, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sharedId, params.shareCode, params.userId, params.agentId, params.roomId, createdAt);

    const row = db.prepare(`SELECT * FROM shared_chats WHERE id = ?`).get(sharedId);
    const record = mapSharedChatRow(row);
    if (!record) {
        throw new Error("Failed to create shared chat");
    }
    return record;
}

/**
 * One-per-container set of userIds whose referral code has already been
 * pre-warmed by authMiddleware. Bounds Mongo traffic to a single lookup
 * per user per container lifetime — far cheaper than running
 * `getOrCreateReferralCode` on every request. Re-populated on container
 * restart, which is fine: the underlying call is idempotent.
 */
const referralCodeWarmedUsers = new Set<string>();

/**
 * Simple authentication middleware - sets user context but doesn't block requests
 * This allows for hybrid authenticated/anonymous access
 */
const authMiddleware = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) => {
    try {
        // Extract user information and attach to request
        const userInfo = getUserInfo(req);
        (req as any).userInfo = userInfo;
        (req as any).userId = getUserId(req);

        // Log authentication status
        if (userInfo.type === 'authenticated') {
            elizaLogger.debug(`🔐 Authenticated request: ${userInfo.email}`);
        } else {
            elizaLogger.debug(`🌐 Anonymous request: ${userInfo.ip}`);
        }

        if (userInfo.type === "authenticated" && userInfo.email) {
            try {
                const normalizedEmail = normalizeEmail(userInfo.email);
                const db =
                    (res.locals as { databaseAdapter?: any }).databaseAdapter ??
                    (req.app as any)?.locals?.databaseAdapter;
                if (db?.mergeDuplicateAccountsByEmail) {
                    await db.mergeDuplicateAccountsByEmail(
                        normalizedEmail,
                        emailToUserId(normalizedEmail)
                    );
                }

                // Ensure every authenticated user has a referral code in the
                // DB from the moment they first sign in — the row is keyed
                // by userId and `getOrCreateReferralCode` returns the
                // existing code on every subsequent call, so the value is
                // stable for the lifetime of the account. Fire-and-forget
                // so request latency isn't tied to a Mongo write on the
                // very first request after deploy. The in-process Set
                // bounds Mongo traffic to one indexed lookup per user per
                // container lifetime.
                if (
                    db?.getOrCreateReferralCode &&
                    !referralCodeWarmedUsers.has(userInfo.userId)
                ) {
                    referralCodeWarmedUsers.add(userInfo.userId);
                    db.getOrCreateReferralCode(userInfo.userId).catch(
                        (err: unknown) => {
                            // Don't block auth on a pre-warm miss; the
                            // synchronous /authentication/referral-code/
                            // path will retry on demand.
                            referralCodeWarmedUsers.delete(userInfo.userId);
                            elizaLogger.warn(
                                "Failed to pre-create referral code in auth middleware:",
                                err
                            );
                        }
                    );
                }
            } catch (lookupError) {
                elizaLogger.error(
                    "Failed to merge duplicate accounts by email in auth middleware:",
                    lookupError
                );
            }
        }

        next();
    } catch (error) {
        elizaLogger.error('Auth middleware error:', error);
        // Don't block the request, just proceed without user info and log the error
        elizaLogger.info('Falling back to IP-based identification');
        try {
            // Fallback to basic IP identification
            const userId = getUserIdFromIP(req);
            const ipInfo = getIPInfo(req);
            (req as any).userInfo = { type: 'anonymous', ip: ipInfo.normalizedIP };
            (req as any).userId = userId;
        } catch (fallbackError) {
            elizaLogger.error('Fallback auth also failed:', fallbackError);
            (req as any).userInfo = null;
            (req as any).userId = null;
        }
        next();
    }
};

/** Cookie/session auth then 401 unless authenticated — safe to mount on `DirectClient` routes outside `createApiRouter`. */
export const requireAuth: RequestHandler = (req, res, next) => {
    authMiddleware(req, res, () => checkAuthenticated(req, res, next));
};

/**
 * Public-demo-aware auth selector for shared/system resources (daily reports,
 * report charts). On an isolated public side-environment (`PUBLIC_ACCESS_MODE=1`)
 * anonymous visitors may read these, so we attach user context without blocking;
 * on production AWS (flag unset) this is identical to `requireAuth` — anonymous
 * requests get 401. Evaluated per-request so the flag is honored regardless of
 * router build order. Mirrors the s3-files proxy's public-access allowance
 * (`DirectClient` `s3FilesHandler`) and the task-chain approval route.
 */
export const publicOrRequireAuth: RequestHandler = (req, res, next) => {
    if (isPublicAccessModeActive()) {
        return authMiddleware(req, res, next);
    }
    return requireAuth(req, res, next);
};

const ADMIN_EMAILS = (getEnvVariable("ADMIN_EMAILS") || getEnvVariable("ADMIN_EMAIL") || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

function isAdminRequest(req: express.Request): boolean {
    const userInfo = (req as any).userInfo;
    if (!userInfo || userInfo.type !== "authenticated" || !userInfo.email) {
        return false;
    }
    if (ADMIN_EMAILS.length === 0) {
        return false;
    }
    return ADMIN_EMAILS.includes(String(userInfo.email).toLowerCase());
}

const ANALYTICS_PAST_DAYS = 30;
const ANALYTICS_HOURLY_POINTS = 48;
const MAIN_PAGE_PATH = "/";
const SIGNUP_PAGE_PATH = "/signup";
const SIGNUP_PAGE_PREFIX = "/signup/";
const REGISTER_PAGE_PATH = "/register";
const REGISTER_PAGE_PREFIX = "/register/";
const SYSTEM_ACCOUNTS_SQL = `userId NOT IN (SELECT id FROM accounts WHERE name = 'Crypto Trader' OR email = id)`;
const ANONYMOUS_ACCOUNT_IDS_SQL = `SELECT id FROM accounts WHERE json_extract(details, '$.source') = 'ip' OR email LIKE '%@anonymous.local'`;
const ANONYMOUS_WEB_SESSION_FILTER = `(isAuthenticated = 0)`;
const INACTIVE_DURATION_THRESHOLD_MS = 5 * 60 * 1000;
const COUNTED_DURATION_SQL = `CASE
    WHEN clickCount = 0 AND durationMs > ${INACTIVE_DURATION_THRESHOLD_MS} THEN NULL
    ELSE durationMs
END`;

function getPastDayLabels(days: number) {
    const labels = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
        const day = new Date(today);
        day.setDate(day.getDate() - i);
        const y = day.getFullYear();
        const m = String(day.getMonth() + 1).padStart(2, "0");
        const d = String(day.getDate()).padStart(2, "0");
        labels.push(`${y}-${m}-${d}`);
    }
    return labels;
}

function getPastHourLabels(hours: number) {
    const labels = [];
    const now = new Date();
    now.setMinutes(0, 0, 0);
    for (let i = hours - 1; i >= 0; i--) {
        const hour = new Date(now);
        hour.setHours(hour.getHours() - i);
        const y = hour.getFullYear();
        const m = String(hour.getMonth() + 1).padStart(2, "0");
        const d = String(hour.getDate()).padStart(2, "0");
        const h = String(hour.getHours()).padStart(2, "0");
        labels.push(`${y}-${m}-${d} ${h}:00`);
    }
    return labels;
}

function safeAnalyticsAll(db: any, sql: string, params: Array<string | number>) {
    if (!isSqliteDbHandle(db)) {
        return [];
    }

    try {
        return db.prepare(sql).all(...params);
    } catch (error: any) {
        const message = String(error?.message || "");
        if (
            error?.code === "SQLITE_ERROR" &&
            (message.includes("web_page_sessions") ||
                message.includes("analytics_usage_rollup") ||
                message.includes("signup_link_sends"))
        ) {
            return [];
        }
        throw error;
    }
}

function isMongoDbHandle(db: any): boolean {
    return !!db && typeof db.collection === "function" && !isSqliteDbHandle(db);
}

function isSqliteDbHandle(db: any): boolean {
    return !!db && typeof db.prepare === "function";
}

function mergeDailyRows(rawRows: Array<any>, labels: string[]) {
    const byDay = new Map(rawRows.map((row) => [row.day, row]));
    return labels.map((day) => {
        const row = byDay.get(day);
        return {
            day,
            sessions: row ? row.sessions : 0,
            visitors: row ? row.visitors : 0,
            avgDurationMs: row && row.avgDurationMs ? row.avgDurationMs : 0,
        };
    });
}

function mergeVisitorRows(rawRows: Array<any>, labels: string[]) {
    const byDay = new Map(rawRows.map((row) => [row.day, row]));
    return labels.map((day) => {
        const row = byDay.get(day);
        return {
            day,
            visitors: row ? row.visitors : 0,
        };
    });
}

function mergeRegistrationRows(rawRows: Array<any>, labels: string[]) {
    const byDay = new Map(rawRows.map((row) => [row.day, row]));
    return labels.map((day) => {
        const row = byDay.get(day);
        return {
            day,
            registrations: row ? row.registrations : 0,
        };
    });
}

function mergeSignupLinkSendRows(rawRows: Array<any>, labels: string[]) {
    const byDay = new Map(rawRows.map((row) => [row.day, row]));
    return labels.map((day) => {
        const row = byDay.get(day);
        return {
            day,
            linkSends: row ? row.linkSends : 0,
        };
    });
}

function mergeAuthRows(rawRows: Array<any>, labels: string[]) {
    const byKey = new Map(rawRows.map((row) => [`${row.day}-${row.isAuthenticated}`, row]));
    return labels.map((day) => {
        const loggedIn = byKey.get(`${day}-1`);
        const anonymous = byKey.get(`${day}-0`);
        return {
            day,
            loggedInVisitors: loggedIn ? loggedIn.visitors : 0,
            loggedInAvgDurationMs: loggedIn && loggedIn.avgDurationMs ? loggedIn.avgDurationMs : 0,
            anonymousVisitors: anonymous ? anonymous.visitors : 0,
            anonymousAvgDurationMs: anonymous && anonymous.avgDurationMs ? anonymous.avgDurationMs : 0,
        };
    });
}

function mergeHourlyRows(rawRows: Array<any>, labels: string[]) {
    const byHour = new Map(rawRows.map((row) => [row.hour, row]));
    return labels.map((hour) => {
        const row = byHour.get(hour);
        return {
            hour,
            sessions: row ? row.sessions : 0,
            visitors: row ? row.visitors : 0,
            avgDurationMs: row && row.avgDurationMs ? row.avgDurationMs : 0,
        };
    });
}

function sumUsageRows(rawRows: Array<any>) {
    return rawRows.reduce(
        (acc, row) => ({
            activeUsers: acc.activeUsers + (Number(row.activeUsers) || 0),
            messageCount: acc.messageCount + (Number(row.messageCount) || 0),
        }),
        { activeUsers: 0, messageCount: 0 }
    );
}

function runUsageDaily(db: any, sinceMs: number) {
    const base = `
        SELECT date(createdAt / 1000, 'unixepoch', 'localtime') AS day,
               COUNT(DISTINCT userId) AS activeUsers, COUNT(*) AS messageCount
        FROM memories
        WHERE type = ? AND userId IS NOT NULL AND userId != '' AND createdAt >= ?
          AND ${SYSTEM_ACCOUNTS_SQL}
        GROUP BY day ORDER BY day
    `;
    const baseRows = safeAnalyticsAll(db, base, ["messages", sinceMs]);
    const rollupRows = runUsageRollup(db, sinceMs, "anonymous");
    return mergeUsageRollupRows(baseRows, rollupRows);
}

function runUsageTotals(db: any) {
    const rows = runUsageDaily(db, 0);
    return sumUsageRows(rows);
}

function runUsageSegmentTotals(db: any) {
    const segments = runUsageSegments(db, 0);
    return {
        anonymous: sumUsageRows(segments.anonymous || []),
        free: sumUsageRows(segments.free || []),
        plus: sumUsageRows(segments.plus || []),
        pro: sumUsageRows(segments.pro || []),
    };
}

function runPageTotals(
    db: any,
    whereSql: string,
    params: Array<string | number>
) {
    const sql = `
        SELECT COUNT(*) AS sessions,
               COUNT(DISTINCT userId) AS visitors,
               AVG(${COUNTED_DURATION_SQL}) AS avgDurationMs
        FROM web_page_sessions
        WHERE ${whereSql}
    `;
    const row = safeAnalyticsAll(db, sql, params)[0];
    return {
        sessions: Number(row?.sessions) || 0,
        visitors: Number(row?.visitors) || 0,
        avgDurationMs: Number(row?.avgDurationMs) || 0,
    };
}

function runAnonymousVisitorsTotal(
    db: any,
    whereSql: string,
    params: Array<string | number>
) {
    const sql = `
        SELECT COUNT(DISTINCT userId) AS visitors
        FROM web_page_sessions
        WHERE ${whereSql}
    `;
    const row = safeAnalyticsAll(db, sql, params)[0];
    return { visitors: Number(row?.visitors) || 0 };
}

function runAuthTotals(db: any, path: string) {
    type AuthTotalsRow = {
        isAuthenticated: number | string;
        visitors: number;
        avgDurationMs: number | null;
    };
    const sql = `
        SELECT CASE
                   WHEN ${ANONYMOUS_WEB_SESSION_FILTER} THEN 0
                   ELSE 1
               END AS isAuthenticated,
               COUNT(DISTINCT userId) AS visitors,
               AVG(${COUNTED_DURATION_SQL}) AS avgDurationMs
        FROM web_page_sessions
        WHERE path = ?
        GROUP BY isAuthenticated
    `;
    const rows = safeAnalyticsAll(db, sql, [path]) as AuthTotalsRow[];
    const byKey = new Map<string, AuthTotalsRow>(
        rows.map((row) => [String(row.isAuthenticated), row])
    );
    const loggedIn = byKey.get("1");
    const anonymous = byKey.get("0");
    return {
        loggedInVisitors: Number(loggedIn?.visitors) || 0,
        loggedInAvgDurationMs: Number(loggedIn?.avgDurationMs) || 0,
        anonymousVisitors: Number(anonymous?.visitors) || 0,
        anonymousAvgDurationMs: Number(anonymous?.avgDurationMs) || 0,
    };
}

function runRegistrationTotal(db: any) {
    const sql = `
        SELECT COUNT(*) AS registrations
        FROM accounts
        WHERE json_extract(details, '$.source') = 'auth'
          AND LOWER(email) NOT LIKE '%@anonymous.local'
    `;
    const row = safeAnalyticsAll(db, sql, [])[0];
    return { registrations: Number(row?.registrations) || 0 };
}

function runSignupLinkSendTotal(db: any) {
    const sql = `
        SELECT COUNT(*) AS linkSends
        FROM signup_link_sends
    `;
    const row = safeAnalyticsAll(db, sql, [])[0];
    return { linkSends: Number(row?.linkSends) || 0 };
}

function runUsageSegments(db: any, sinceMs: number) {
    const base = `
        SELECT date(createdAt / 1000, 'unixepoch', 'localtime') AS day,
               COUNT(DISTINCT userId) AS activeUsers, COUNT(*) AS messageCount
        FROM memories
        WHERE type = ? AND userId IS NOT NULL AND userId != '' AND createdAt >= ?
          AND ${SYSTEM_ACCOUNTS_SQL}
          AND (
    `;
    const anonymousSql = `
        SELECT date(createdAt / 1000, 'unixepoch', 'localtime') AS day,
               COUNT(DISTINCT userId) AS activeUsers,
               COUNT(*) AS messageCount
        FROM memories
        WHERE type = ? AND userId IS NOT NULL AND userId != '' AND createdAt >= ?
          AND ${SYSTEM_ACCOUNTS_SQL}
          AND (
              userId NOT IN (SELECT id FROM accounts)
              OR userId IN (${ANONYMOUS_ACCOUNT_IDS_SQL})
          )
        GROUP BY day ORDER BY day
    `;
    // Segment logic:
    // 1) Logged-in users use latest user_subscription_tier_history tier.
    // 2) Logged-in users without history default to free.
    // 3) Anonymous users are counted only in anonymous segment.
    //
    // Use an inline subquery (no top-level CTE) to avoid edge-case differences
    // in how SQLite parses CTEs that appear inside an IN (...) expression.
    const buildTierInSubquery = (tierCondition: string) => `
        SELECT a.id
        FROM accounts a
        LEFT JOIN (
            SELECT userId, tier
            FROM (
                SELECT userId, tier,
                       ROW_NUMBER() OVER (
                           PARTITION BY userId
                           ORDER BY observedAt DESC, createdAt DESC, id DESC
                       ) AS rn
                FROM user_subscription_tier_history
            ) ranked
            WHERE rn = 1
        ) ht ON ht.userId = a.id
        WHERE (json_extract(a.details, '$.source') IS NULL OR json_extract(a.details, '$.source') != 'ip')
          AND a.email NOT LIKE '%@anonymous.local'
          AND COALESCE(ht.tier, 'free') ${tierCondition}
    `;

    const segmentSql = {
        pro: `${base} userId IN (${buildTierInSubquery("IN ('pro','enterprise')")}) ) GROUP BY day ORDER BY day`,
        plus: `${base} userId IN (${buildTierInSubquery("= 'plus'")}) ) GROUP BY day ORDER BY day`,
        free: `${base} userId IN (${buildTierInSubquery("= 'free'")}) ) GROUP BY day ORDER BY day`,
    } as const;

    const out: Record<string, Array<any>> = {};
    const anonymousRows = safeAnalyticsAll(db, anonymousSql, ["messages", sinceMs]);
    const anonymousRollup = runUsageRollup(db, sinceMs, "anonymous");
    out.anonymous = mergeUsageRollupRows(anonymousRows, anonymousRollup);

    for (const [key, sql] of Object.entries(segmentSql)) {
        out[key] = safeAnalyticsAll(db, sql, ["messages", sinceMs]);
    }

    return out;
}

function runUsageRollup(db: any, sinceMs: number, segment: string) {
    const sql = `
        SELECT day,
               SUM(activeUsers) AS activeUsers,
               SUM(messageCount) AS messageCount
        FROM analytics_usage_rollup
        WHERE segment = ?
          AND day >= date(? / 1000, 'unixepoch', 'localtime')
        GROUP BY day ORDER BY day
    `;
    return safeAnalyticsAll(db, sql, [segment, sinceMs]);
}

function mergeUsageRollupRows(baseRows: Array<any>, rollupRows: Array<any>) {
    const byDay = new Map<string, { day: string; activeUsers: number; messageCount: number }>();
    for (const row of baseRows || []) {
        byDay.set(row.day, {
            day: row.day,
            activeUsers: Number(row.activeUsers) || 0,
            messageCount: Number(row.messageCount) || 0,
        });
    }
    for (const row of rollupRows || []) {
        const existing = byDay.get(row.day);
        if (existing) {
            existing.activeUsers += Number(row.activeUsers) || 0;
            existing.messageCount += Number(row.messageCount) || 0;
        } else {
            byDay.set(row.day, {
                day: row.day,
                activeUsers: Number(row.activeUsers) || 0,
                messageCount: Number(row.messageCount) || 0,
            });
        }
    }
    return Array.from(byDay.values());
}

function mergeUsageRows(rawRows: Array<any>, labels: string[]) {
    const byDay = new Map(rawRows.map((row) => [row.day, row]));
    return labels.map((day) => {
        const row = byDay.get(day);
        return {
            day,
            activeUsers: row ? row.activeUsers : 0,
            messageCount: row ? row.messageCount : 0,
        };
    });
}

function isWithinLocalDayRange(timestamp: number, startMs: number, endMs: number): boolean {
    return timestamp >= startMs && timestamp <= endMs;
}

function getLocalDayRange(baseDate = new Date()): { startMs: number; endMs: number } {
    const start = new Date(baseDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(baseDate);
    end.setHours(23, 59, 59, 999);
    return { startMs: start.getTime(), endMs: end.getTime() };
}

async function getMongoReferralCodeStatsToday(mongoDb: any): Promise<
    Array<{ referralCode: string; pendingCount: number; completedCount: number }>
> {
    const { startMs, endMs } = getLocalDayRange(new Date());

    const [signupLinks, accountsRaw, referralCodeRows, userReferralRows] = await Promise.all([
        mongoDb
            .collection("signup_link_sends")
            .find(
                { referralCode: { $ne: null } },
                { projection: { referralCode: 1, email: 1, createdAt: 1 } }
            )
            .toArray(),
        mongoDb
            .collection("accounts")
            .find({}, { projection: { id: 1, email: 1, createdAt: 1 } })
            .toArray(),
        mongoDb
            .collection("referral_codes")
            .find({}, { projection: { referralCode: 1 } })
            .toArray(),
        mongoDb
            .collection("user_referral_codes")
            .find({}, { projection: { userId: 1, referralCodeUsed: 1 } })
            .toArray(),
    ]);

    const accounts = accountsRaw
        .map((row: any) => ({
            id: row.id as string | undefined,
            email: typeof row.email === "string" ? normalizeEmail(row.email) : null,
            createdAt: typeof row.createdAt === "number" ? row.createdAt : Date.parse(String(row.createdAt ?? "")),
        }))
        .filter((row: any) => row.id && row.email && Number.isFinite(row.createdAt));

    const todayRegisteredEmailSet = new Set<string>();
    const todayRegisteredUserIds = new Set<string>();
    for (const account of accounts) {
        if (isWithinLocalDayRange(account.createdAt, startMs, endMs)) {
            todayRegisteredEmailSet.add(account.email);
            todayRegisteredUserIds.add(account.id);
        }
    }

    const pendingByCode = new Map<string, Set<string>>();
    for (const row of signupLinks) {
        const createdAt =
            typeof row.createdAt === "number"
                ? row.createdAt
                : Date.parse(String(row.createdAt ?? ""));
        if (!Number.isFinite(createdAt) || !isWithinLocalDayRange(createdAt, startMs, endMs)) {
            continue;
        }
        const code = typeof row.referralCode === "string" ? row.referralCode : null;
        const email = typeof row.email === "string" ? normalizeEmail(row.email) : null;
        if (!code || !email) {
            continue;
        }
        if (todayRegisteredEmailSet.has(email)) {
            continue;
        }
        const set = pendingByCode.get(code) ?? new Set<string>();
        set.add(email);
        pendingByCode.set(code, set);
    }

    const referralCodeByUserId = new Map<string, string>();
    for (const row of userReferralRows) {
        if (typeof row.userId === "string" && typeof row.referralCodeUsed === "string") {
            referralCodeByUserId.set(row.userId, row.referralCodeUsed);
        }
    }

    const completedByCode = new Map<string, Set<string>>();
    for (const account of accounts) {
        if (!todayRegisteredUserIds.has(account.id)) continue;
        const code = referralCodeByUserId.get(account.id);
        if (!code) continue;
        const set = completedByCode.get(code) ?? new Set<string>();
        set.add(account.email);
        completedByCode.set(code, set);
    }

    const allCodes = new Set<string>();
    for (const row of referralCodeRows) {
        if (typeof row.referralCode === "string") {
            allCodes.add(row.referralCode);
        }
    }
    for (const code of pendingByCode.keys()) allCodes.add(code);
    for (const code of completedByCode.keys()) allCodes.add(code);

    return Array.from(allCodes)
        .map((referralCode) => ({
            referralCode,
            pendingCount: pendingByCode.get(referralCode)?.size ?? 0,
            completedCount: completedByCode.get(referralCode)?.size ?? 0,
        }))
        .sort((a, b) => {
            const aTotal = a.pendingCount + a.completedCount;
            const bTotal = b.pendingCount + b.completedCount;
            if (bTotal !== aTotal) return bTotal - aTotal;
            if (b.completedCount !== a.completedCount) return b.completedCount - a.completedCount;
            return a.referralCode.localeCompare(b.referralCode);
        });
}

export async function getMongoReferralCodeStatsLast30Days(mongoDb: any): Promise<
    Array<{ referralCode: string; pendingCount: number; completedCount: number }>
> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const since = new Date(today);
    since.setDate(since.getDate() - 29);
    const sinceMs = since.getTime();

    const [signupLinks, accountsRaw, referralCodeRows] = await Promise.all([
        mongoDb
            .collection("signup_link_sends")
            .find(
                { referralCode: { $ne: null } },
                { projection: { referralCode: 1, email: 1, createdAt: 1 } }
            )
            .toArray(),
        mongoDb
            .collection("accounts")
            .find({}, { projection: { email: 1 } })
            .toArray(),
        mongoDb
            .collection("referral_codes")
            .find({}, { projection: { referralCode: 1 } })
            .toArray(),
    ]);

    const registeredEmails = new Set<string>();
    for (const row of accountsRaw) {
        if (typeof row.email === "string") {
            registeredEmails.add(normalizeEmail(row.email));
        }
    }

    const pendingByCode = new Map<string, Set<string>>();
    const completedByCode = new Map<string, Set<string>>();

    for (const row of signupLinks) {
        const createdAt =
            typeof row.createdAt === "number"
                ? row.createdAt
                : Date.parse(String(row.createdAt ?? ""));
        if (!Number.isFinite(createdAt) || createdAt < sinceMs) {
            continue;
        }

        const code = typeof row.referralCode === "string" ? row.referralCode : null;
        const email = typeof row.email === "string" ? normalizeEmail(row.email) : null;
        if (!code || !email) continue;

        if (registeredEmails.has(email)) {
            const set = completedByCode.get(code) ?? new Set<string>();
            set.add(email);
            completedByCode.set(code, set);
        } else {
            const set = pendingByCode.get(code) ?? new Set<string>();
            set.add(email);
            pendingByCode.set(code, set);
        }
    }

    const allCodes = new Set<string>();
    for (const row of referralCodeRows) {
        if (typeof row.referralCode === "string") {
            allCodes.add(row.referralCode);
        }
    }
    for (const code of pendingByCode.keys()) allCodes.add(code);
    for (const code of completedByCode.keys()) allCodes.add(code);

    return Array.from(allCodes)
        .map((referralCode) => ({
            referralCode,
            pendingCount: pendingByCode.get(referralCode)?.size ?? 0,
            completedCount: completedByCode.get(referralCode)?.size ?? 0,
        }))
        .sort((a, b) => {
            const aTotal = a.pendingCount + a.completedCount;
            const bTotal = b.pendingCount + b.completedCount;
            if (bTotal !== aTotal) return bTotal - aTotal;
            if (b.completedCount !== a.completedCount) return b.completedCount - a.completedCount;
            return a.referralCode.localeCompare(b.referralCode);
        });
}

type SessionAccumulator = {
    sessions: number;
    visitors: Set<string>;
    durationSum: number;
    durationCount: number;
};

type UsageAccumulator = {
    activeUsers: Set<string>;
    messageCount: number;
};

function getLocalDayLabelFromTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleDateString("en-CA");
}

function getLocalHourLabelFromTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    const h = String(date.getHours()).padStart(2, "0");
    return `${y}-${m}-${d} ${h}:00`;
}

function addSessionToAccumulator(
    map: Map<string, SessionAccumulator>,
    key: string,
    userId: string | null | undefined,
    durationMs: number,
    clickCount: number
) {
    const current = map.get(key) ?? {
        sessions: 0,
        visitors: new Set<string>(),
        durationSum: 0,
        durationCount: 0,
    };

    current.sessions += 1;
    if (userId) {
        current.visitors.add(userId);
    }

    const countedDuration =
        clickCount === 0 && durationMs > INACTIVE_DURATION_THRESHOLD_MS
            ? null
            : durationMs;
    if (typeof countedDuration === "number" && Number.isFinite(countedDuration)) {
        current.durationSum += countedDuration;
        current.durationCount += 1;
    }

    map.set(key, current);
}

function addUsageToAccumulator(
    map: Map<string, UsageAccumulator>,
    key: string,
    userId: string
) {
    const current = map.get(key) ?? {
        activeUsers: new Set<string>(),
        messageCount: 0,
    };
    current.activeUsers.add(userId);
    current.messageCount += 1;
    map.set(key, current);
}

function sessionMapToRows(map: Map<string, SessionAccumulator>) {
    return Array.from(map.entries())
        .map(([day, value]) => ({
            day,
            sessions: value.sessions,
            visitors: value.visitors.size,
            avgDurationMs: value.durationCount > 0 ? value.durationSum / value.durationCount : 0,
        }))
        .sort((a, b) => a.day.localeCompare(b.day));
}

function visitorSetMapToRows(map: Map<string, Set<string>>) {
    return Array.from(map.entries())
        .map(([day, visitors]) => ({
            day,
            visitors: visitors.size,
        }))
        .sort((a, b) => a.day.localeCompare(b.day));
}

function usageMapToRows(map: Map<string, UsageAccumulator>) {
    return Array.from(map.entries())
        .map(([day, value]) => ({
            day,
            activeUsers: value.activeUsers.size,
            messageCount: value.messageCount,
        }))
        .sort((a, b) => a.day.localeCompare(b.day));
}

export async function getMongoAnalyticsSummaryData(mongoDb: any) {
    const labels = getPastDayLabels(ANALYTICS_PAST_DAYS);
    const hourlyLabels = getPastHourLabels(ANALYTICS_HOURLY_POINTS);

    const start = new Date();
    start.setDate(start.getDate() - (ANALYTICS_PAST_DAYS - 1));
    start.setHours(0, 0, 0, 0);
    const sinceMs = start.getTime();
    const hourlySince = Date.now() - ANALYTICS_HOURLY_POINTS * 60 * 60 * 1000;

    const [accountsRaw, sessionsAll, signupLinkSends, messagesAll, tierHistoryRows, anonymousRollupRows] =
        await Promise.all([
            mongoDb
                .collection("accounts")
                .find({}, { projection: { id: 1, name: 1, email: 1, details: 1, createdAt: 1 } })
                .toArray(),
            mongoDb
                .collection("web_page_sessions")
                .find(
                    {},
                    {
                        projection: {
                            createdAt: 1,
                            userId: 1,
                            path: 1,
                            durationMs: 1,
                            clickCount: 1,
                            isAuthenticated: 1,
                        },
                    }
                )
                .toArray(),
            mongoDb
                .collection("signup_link_sends")
                .find({}, { projection: { createdAt: 1 } })
                .toArray(),
            mongoDb
                .collection("memories")
                .find(
                    { type: "messages" },
                    { projection: { userId: 1, createdAt: 1 } }
                )
                .toArray(),
            mongoDb
                .collection("user_subscription_tier_history")
                .find({}, { projection: { userId: 1, tier: 1, observedAt: 1, createdAt: 1, id: 1 } })
                .sort({ observedAt: -1, createdAt: -1, id: -1 })
                .toArray(),
            mongoDb
                .collection("analytics_usage_rollup")
                .find({ segment: "anonymous" }, { projection: { day: 1, activeUsers: 1, messageCount: 1 } })
                .toArray(),
        ]);

    const accounts = accountsRaw.map((row: any) => {
        const email = typeof row.email === "string" ? normalizeEmail(row.email) : "";
        let details: Record<string, unknown> = {};
        if (row.details && typeof row.details === "object") {
            details = row.details as Record<string, unknown>;
        } else if (typeof row.details === "string") {
            try {
                details = JSON.parse(row.details || "{}") as Record<string, unknown>;
            } catch {
                details = {};
            }
        }
        return {
            id: typeof row.id === "string" ? row.id : "",
            name: typeof row.name === "string" ? row.name : "",
            email,
            details,
            createdAt:
                typeof row.createdAt === "number"
                    ? row.createdAt
                    : Date.parse(String(row.createdAt ?? "")),
        };
    });

    const accountIds = new Set(accounts.filter((a) => a.id).map((a) => a.id));
    const systemAccountIds = new Set(
        accounts
            .filter((a) => a.id && (a.name === "Crypto Trader" || a.email === a.id))
            .map((a) => a.id)
    );
    const anonymousAccountIds = new Set(
        accounts
            .filter((a) => {
                const source =
                    a.details && typeof a.details === "object"
                        ? (a.details as Record<string, unknown>).source
                        : undefined;
                return source === "ip" || a.email.endsWith("@anonymous.local");
            })
            .map((a) => a.id)
    );

    const tierByUser = new Map<string, string>();
    for (const row of tierHistoryRows) {
        if (typeof row.userId === "string" && typeof row.tier === "string" && !tierByUser.has(row.userId)) {
            tierByUser.set(row.userId, row.tier);
        }
    }

    const mainDailyMap = new Map<string, SessionAccumulator>();
    const signupDailyMap = new Map<string, SessionAccumulator>();
    const registerDailyMap = new Map<string, SessionAccumulator>();
    const mainAnonymousVisitorsMap = new Map<string, Set<string>>();
    const registerAnonymousVisitorsMap = new Map<string, Set<string>>();
    const authDailyMap = new Map<string, SessionAccumulator>();
    const loggedInVisitorsDailyMap = new Map<string, Set<string>>();
    const hourlyMainMap = new Map<string, SessionAccumulator>();

    const mainTotal = { sessions: 0, visitors: new Set<string>(), durationSum: 0, durationCount: 0 };
    const signupTotal = { sessions: 0, visitors: new Set<string>(), durationSum: 0, durationCount: 0 };
    const registerTotal = { sessions: 0, visitors: new Set<string>(), durationSum: 0, durationCount: 0 };
    const mainAnonymousTotalVisitors = new Set<string>();
    const registerAnonymousTotalVisitors = new Set<string>();
    const mainAuthTotals = {
        loggedIn: { visitors: new Set<string>(), durationSum: 0, durationCount: 0 },
        anonymous: { visitors: new Set<string>(), durationSum: 0, durationCount: 0 },
    };

    for (const session of sessionsAll) {
        const createdAt =
            typeof session.createdAt === "number"
                ? session.createdAt
                : Date.parse(String(session.createdAt ?? ""));
        if (!Number.isFinite(createdAt)) continue;

        const day = getLocalDayLabelFromTimestamp(createdAt);
        const userId = typeof session.userId === "string" ? session.userId : null;
        const path = typeof session.path === "string" ? session.path : "";
        const durationMs = Number(session.durationMs ?? 0) || 0;
        const clickCount = Number(session.clickCount ?? 0) || 0;
        const isAuthenticated = session.isAuthenticated === 1 || session.isAuthenticated === true;
        const isAnonymous = !isAuthenticated;

        const countedDuration =
            clickCount === 0 && durationMs > INACTIVE_DURATION_THRESHOLD_MS
                ? null
                : durationMs;

        const addTotal = (target: typeof mainTotal) => {
            target.sessions += 1;
            if (userId) target.visitors.add(userId);
            if (typeof countedDuration === "number") {
                target.durationSum += countedDuration;
                target.durationCount += 1;
            }
        };

        if (path === MAIN_PAGE_PATH) {
            addTotal(mainTotal);
            if (isAuthenticated) {
                if (userId) mainAuthTotals.loggedIn.visitors.add(userId);
                if (typeof countedDuration === "number") {
                    mainAuthTotals.loggedIn.durationSum += countedDuration;
                    mainAuthTotals.loggedIn.durationCount += 1;
                }
            } else {
                if (userId) mainAuthTotals.anonymous.visitors.add(userId);
                if (typeof countedDuration === "number") {
                    mainAuthTotals.anonymous.durationSum += countedDuration;
                    mainAuthTotals.anonymous.durationCount += 1;
                }
            }
        }
        if (path === SIGNUP_PAGE_PATH || path.startsWith(SIGNUP_PAGE_PREFIX)) {
            addTotal(signupTotal);
        }
        if (path === REGISTER_PAGE_PATH || path.startsWith(REGISTER_PAGE_PREFIX)) {
            addTotal(registerTotal);
        }
        if (isAnonymous && userId) {
            if (path === MAIN_PAGE_PATH) {
                mainAnonymousTotalVisitors.add(userId);
            }
            if (path === REGISTER_PAGE_PATH || path.startsWith(REGISTER_PAGE_PREFIX)) {
                registerAnonymousTotalVisitors.add(userId);
            }
        }

        if (createdAt < sinceMs) continue;

        if (path === MAIN_PAGE_PATH) {
            addSessionToAccumulator(mainDailyMap, day, userId, durationMs, clickCount);
            if (isAnonymous && userId) {
                const set = mainAnonymousVisitorsMap.get(day) ?? new Set<string>();
                set.add(userId);
                mainAnonymousVisitorsMap.set(day, set);
            }

            const authKey = `${day}::${isAuthenticated ? "1" : "0"}`;
            addSessionToAccumulator(authDailyMap, authKey, userId, durationMs, clickCount);
        }

        if (path === SIGNUP_PAGE_PATH || path.startsWith(SIGNUP_PAGE_PREFIX)) {
            addSessionToAccumulator(signupDailyMap, day, userId, durationMs, clickCount);
        }

        if (path === REGISTER_PAGE_PATH || path.startsWith(REGISTER_PAGE_PREFIX)) {
            addSessionToAccumulator(registerDailyMap, day, userId, durationMs, clickCount);
            if (isAnonymous && userId) {
                const set = registerAnonymousVisitorsMap.get(day) ?? new Set<string>();
                set.add(userId);
                registerAnonymousVisitorsMap.set(day, set);
            }
        }

        if (isAuthenticated && userId) {
            const set = loggedInVisitorsDailyMap.get(day) ?? new Set<string>();
            set.add(userId);
            loggedInVisitorsDailyMap.set(day, set);
        }

        if (createdAt >= hourlySince && path === MAIN_PAGE_PATH) {
            const hourLabel = getLocalHourLabelFromTimestamp(createdAt);
            addSessionToAccumulator(hourlyMainMap, hourLabel, userId, durationMs, clickCount);
        }
    }

    const mainRows = sessionMapToRows(mainDailyMap);
    const signupRows = sessionMapToRows(signupDailyMap);
    const registerRows = sessionMapToRows(registerDailyMap);
    const mainAnonymousRows = visitorSetMapToRows(mainAnonymousVisitorsMap);
    const registerAnonymousRows = visitorSetMapToRows(registerAnonymousVisitorsMap);
    const loggedInVisitorsRows = visitorSetMapToRows(loggedInVisitorsDailyMap);
    const hourlyRows = Array.from(hourlyMainMap.entries())
        .map(([hour, value]) => ({
            hour,
            sessions: value.sessions,
            visitors: value.visitors.size,
            avgDurationMs: value.durationCount > 0 ? value.durationSum / value.durationCount : 0,
        }))
        .sort((a, b) => a.hour.localeCompare(b.hour));

    const authRows = Array.from(authDailyMap.entries())
        .map(([key, value]) => {
            const [day, isAuthenticated] = key.split("::");
            return {
                day,
                isAuthenticated: Number(isAuthenticated),
                visitors: value.visitors.size,
                avgDurationMs: value.durationCount > 0 ? value.durationSum / value.durationCount : 0,
            };
        })
        .sort((a, b) => a.day.localeCompare(b.day));

    const registrationsRowsMap = new Map<string, number>();
    let registrationsTotal = 0;
    for (const account of accounts) {
        if (!Number.isFinite(account.createdAt)) continue;
        const source =
            account.details && typeof account.details === "object"
                ? (account.details as Record<string, unknown>).source
                : undefined;
        if (source !== "auth") continue;
        if (account.email.endsWith("@anonymous.local")) continue;
        registrationsTotal += 1;
        if (account.createdAt >= sinceMs) {
            const day = getLocalDayLabelFromTimestamp(account.createdAt);
            registrationsRowsMap.set(day, (registrationsRowsMap.get(day) ?? 0) + 1);
        }
    }
    const registrationsRows = Array.from(registrationsRowsMap.entries())
        .map(([day, registrations]) => ({ day, registrations }))
        .sort((a, b) => a.day.localeCompare(b.day));

    const signupLinkSendsRowsMap = new Map<string, number>();
    for (const row of signupLinkSends) {
        const createdAt =
            typeof row.createdAt === "number"
                ? row.createdAt
                : Date.parse(String(row.createdAt ?? ""));
        if (!Number.isFinite(createdAt) || createdAt < sinceMs) continue;
        const day = getLocalDayLabelFromTimestamp(createdAt);
        signupLinkSendsRowsMap.set(day, (signupLinkSendsRowsMap.get(day) ?? 0) + 1);
    }
    const signupLinkSendRows = Array.from(signupLinkSendsRowsMap.entries())
        .map(([day, linkSends]) => ({ day, linkSends }))
        .sort((a, b) => a.day.localeCompare(b.day));

    const usageDailyMap = new Map<string, UsageAccumulator>();
    const usageAnonymousDailyMap = new Map<string, UsageAccumulator>();
    const usageFreeDailyMap = new Map<string, UsageAccumulator>();
    const usagePlusDailyMap = new Map<string, UsageAccumulator>();
    const usageProDailyMap = new Map<string, UsageAccumulator>();

    const usageTotalMap = new Map<string, UsageAccumulator>();
    const usageAnonymousTotalMap = new Map<string, UsageAccumulator>();
    const usageFreeTotalMap = new Map<string, UsageAccumulator>();
    const usagePlusTotalMap = new Map<string, UsageAccumulator>();
    const usageProTotalMap = new Map<string, UsageAccumulator>();

    const classifyTier = (tierValue: string | undefined): "anonymous" | "free" | "plus" | "pro" => {
        if (tierValue === "plus") return "plus";
        if (tierValue === "pro" || tierValue === "enterprise") return "pro";
        return "free";
    };

    for (const message of messagesAll) {
        const userId = typeof message.userId === "string" ? message.userId : null;
        if (!userId) continue;
        if (systemAccountIds.has(userId)) continue;

        const createdAt =
            typeof message.createdAt === "number"
                ? message.createdAt
                : Date.parse(String(message.createdAt ?? ""));
        if (!Number.isFinite(createdAt)) continue;
        const day = getLocalDayLabelFromTimestamp(createdAt);

        const isAnonymousUser = !accountIds.has(userId) || anonymousAccountIds.has(userId);
        if (createdAt >= sinceMs) {
            addUsageToAccumulator(usageDailyMap, day, userId);
            if (isAnonymousUser) {
                addUsageToAccumulator(usageAnonymousDailyMap, day, userId);
            } else {
                const segment = classifyTier(tierByUser.get(userId));
                if (segment === "free") addUsageToAccumulator(usageFreeDailyMap, day, userId);
                if (segment === "plus") addUsageToAccumulator(usagePlusDailyMap, day, userId);
                if (segment === "pro") addUsageToAccumulator(usageProDailyMap, day, userId);
            }
        }

        addUsageToAccumulator(usageTotalMap, day, userId);
        if (isAnonymousUser) {
            addUsageToAccumulator(usageAnonymousTotalMap, day, userId);
        } else {
            const segment = classifyTier(tierByUser.get(userId));
            if (segment === "free") addUsageToAccumulator(usageFreeTotalMap, day, userId);
            if (segment === "plus") addUsageToAccumulator(usagePlusTotalMap, day, userId);
            if (segment === "pro") addUsageToAccumulator(usageProTotalMap, day, userId);
        }
    }

    const anonymousRollupDailyRows = anonymousRollupRows.filter((row: any) =>
        typeof row.day === "string" ? row.day >= labels[0] : false
    );

    const mergeUsage = (baseRows: Array<any>, rollupRows: Array<any>) => mergeUsageRollupRows(baseRows, rollupRows);

    const usageRows = mergeUsage(usageMapToRows(usageDailyMap), []);
    const anonymousUsageRows = mergeUsage(
        usageMapToRows(usageAnonymousDailyMap),
        anonymousRollupDailyRows.map((row: any) => ({
            day: row.day,
            activeUsers: Number(row.activeUsers) || 0,
            messageCount: Number(row.messageCount) || 0,
        }))
    );
    const freeUsageRows = usageMapToRows(usageFreeDailyMap);
    const plusUsageRows = usageMapToRows(usagePlusDailyMap);
    const proUsageRows = usageMapToRows(usageProDailyMap);

    const anonymousRollupAllRows = anonymousRollupRows.map((row: any) => ({
        day: row.day,
        activeUsers: Number(row.activeUsers) || 0,
        messageCount: Number(row.messageCount) || 0,
    }));

    const usageTotals = sumUsageRows(mergeUsage(usageMapToRows(usageTotalMap), []));
    const usageSegmentTotals = {
        anonymous: sumUsageRows(
            mergeUsage(usageMapToRows(usageAnonymousTotalMap), anonymousRollupAllRows)
        ),
        free: sumUsageRows(usageMapToRows(usageFreeTotalMap)),
        plus: sumUsageRows(usageMapToRows(usagePlusTotalMap)),
        pro: sumUsageRows(usageMapToRows(usageProTotalMap)),
    };

    const toTotals = (acc: typeof mainTotal) => ({
        sessions: acc.sessions,
        visitors: acc.visitors.size,
        avgDurationMs: acc.durationCount > 0 ? acc.durationSum / acc.durationCount : 0,
    });

    const mainAuth = {
        loggedInVisitors: mainAuthTotals.loggedIn.visitors.size,
        loggedInAvgDurationMs:
            mainAuthTotals.loggedIn.durationCount > 0
                ? mainAuthTotals.loggedIn.durationSum / mainAuthTotals.loggedIn.durationCount
                : 0,
        anonymousVisitors: mainAuthTotals.anonymous.visitors.size,
        anonymousAvgDurationMs:
            mainAuthTotals.anonymous.durationCount > 0
                ? mainAuthTotals.anonymous.durationSum / mainAuthTotals.anonymous.durationCount
                : 0,
    };

    return {
        dailyLabels: labels,
        hourlyLabels,
        totals: {
            usage: usageTotals,
            usageSegments: usageSegmentTotals,
            main: toTotals(mainTotal),
            signup: toTotals(signupTotal),
            register: toTotals(registerTotal),
            mainAnonymousVisitors: { visitors: mainAnonymousTotalVisitors.size },
            registerAnonymousVisitors: { visitors: registerAnonymousTotalVisitors.size },
            registrations: { registrations: registrationsTotal },
            signupLinkSends: { linkSends: signupLinkSends.length },
            mainAuth,
        },
        usage: mergeUsageRows(usageRows, labels),
        usageSegments: {
            anonymous: mergeUsageRows(anonymousUsageRows, labels),
            free: mergeUsageRows(freeUsageRows, labels),
            plus: mergeUsageRows(plusUsageRows, labels),
            pro: mergeUsageRows(proUsageRows, labels),
        },
        main: mergeDailyRows(mainRows, labels),
        signup: mergeDailyRows(signupRows, labels),
        register: mergeDailyRows(registerRows, labels),
        mainAnonymousVisitors: mergeVisitorRows(mainAnonymousRows, labels),
        registerAnonymousVisitors: mergeVisitorRows(registerAnonymousRows, labels),
        registrations: mergeRegistrationRows(registrationsRows, labels),
        signupLinkSends: mergeSignupLinkSendRows(signupLinkSendRows, labels),
        loggedInVisitors: mergeVisitorRows(loggedInVisitorsRows, labels),
        mainAuth: mergeAuthRows(authRows, labels),
        hourlyMain: mergeHourlyRows(hourlyRows, hourlyLabels),
    };
}

// ========================================
// Referral System Helper Functions
// ========================================

/**
 * Normalize email address (lowercase and trim)
 */
function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

async function resolveAuthenticatedUserId(
    runtime: AgentRuntime,
    userInfo: ReturnType<typeof getUserInfo>,
    fallbackUserId: UUID
): Promise<UUID> {
    if (!userInfo || userInfo.type !== "authenticated" || !userInfo.email) {
        return fallbackUserId;
    }

    try {
        const normalizedEmail = normalizeEmail(userInfo.email);
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
            return account.id as UUID;
        }
    } catch (error) {
        elizaLogger.error("Failed to resolve authenticated user ID:", error);
    }

    return fallbackUserId;
}

/**
 * Record a pending referral captured during enrollment.
 */
async function recordPendingReferral(db: any, email: string, referralCode: string): Promise<boolean> {
    try {
        if (!db?.db) {
            elizaLogger.error("Database adapter not available for pending referral insert");
            return false;
        }

        const normalizedEmail = normalizeEmail(email);
        if (isSqliteDbHandle(db.db)) {
            db.db
                .prepare("DELETE FROM pending_referrals WHERE email = ?")
                .run(normalizedEmail);

            const id = uuidv4();
            db.db
                .prepare(`
                    INSERT INTO pending_referrals (id, email, referralCode, createdAt)
                    VALUES (?, ?, ?, ?)
                `)
                .run(id, normalizedEmail, referralCode, Date.now());
        } else if (isMongoDbHandle(db.db)) {
            await db.db.collection("pending_referrals").deleteMany({ email: normalizedEmail });
            await db.db.collection("pending_referrals").insertOne({
                id: uuidv4(),
                email: normalizedEmail,
                referralCode,
                createdAt: Date.now(),
            });
        } else {
            elizaLogger.warn("Unsupported database implementation for pending referral insert");
            return false;
        }

        return true;
    } catch (error) {
        elizaLogger.error("Error recording pending referral:", error);
        return false;
    }
}

/**
 * Record a signup link send event.
 */
async function recordSignupLinkSend(db: any, email: string, referralCode?: string | null): Promise<boolean> {
    try {
        if (!db?.db) {
            elizaLogger.error("Database adapter not available for signup link send insert");
            return false;
        }

        const normalizedEmail = normalizeEmail(email);
        if (isSqliteDbHandle(db.db)) {
            db.db
                .prepare(`
                    INSERT INTO signup_link_sends (id, email, referralCode, createdAt)
                    VALUES (?, ?, ?, ?)
                `)
                .run(uuidv4(), normalizedEmail, referralCode ?? null, Date.now());
        } else if (isMongoDbHandle(db.db)) {
            await db.db.collection("signup_link_sends").insertOne({
                id: uuidv4(),
                email: normalizedEmail,
                referralCode: referralCode ?? null,
                createdAt: Date.now(),
            });
        } else {
            elizaLogger.warn("Unsupported database implementation for signup link send insert");
            return false;
        }

        return true;
    } catch (error) {
        elizaLogger.error("Error recording signup link send:", error);
        return false;
    }
}

/**
 * Look up a referral code from pending enrollment records.
 * Uses the most recent matching email entry.
 */
async function getPendingReferralCode(db: any, email: string): Promise<string | null> {
    try {
        if (!db?.db) {
            elizaLogger.error("Database adapter not available for pending referral lookup");
            return null;
        }

        const normalizedEmail = normalizeEmail(email);
        if (isSqliteDbHandle(db.db)) {
            const result = db.db
                .prepare(`
                    SELECT referralCode
                    FROM pending_referrals
                    WHERE email = ?
                    ORDER BY createdAt DESC
                    LIMIT 1
                `)
                .get(normalizedEmail) as { referralCode: string } | undefined;

            return result?.referralCode ?? null;
        }

        if (isMongoDbHandle(db.db)) {
            const pending = await db.db
                .collection("pending_referrals")
                .find({ email: normalizedEmail })
                .sort({ createdAt: -1 })
                .limit(1)
                .toArray();
            return pending[0]?.referralCode ?? null;
        }

        elizaLogger.warn("Unsupported database implementation for pending referral lookup");
        return null;
    } catch (error) {
        elizaLogger.error("Error looking up pending referral code:", error);
        return null;
    }
}

/**
 * Clear pending referrals for a given email.
 */
async function clearPendingReferrals(db: any, email: string): Promise<void> {
    try {
        if (!db?.db) {
            elizaLogger.error("Database adapter not available for pending referral cleanup");
            return;
        }

        const normalizedEmail = normalizeEmail(email);
        if (isSqliteDbHandle(db.db)) {
            db.db
                .prepare("DELETE FROM pending_referrals WHERE email = ?")
                .run(normalizedEmail);
            return;
        }

        if (isMongoDbHandle(db.db)) {
            await db.db.collection("pending_referrals").deleteMany({ email: normalizedEmail });
            return;
        }

        elizaLogger.warn("Unsupported database implementation for pending referral cleanup");
    } catch (error) {
        elizaLogger.error("Error clearing pending referrals:", error);
    }
}

/**
 * Migrate existing JSON referral data to database
 * This should be run once on startup after the database tables are created
 */
async function migrateReferralData(db: any): Promise<void> {
    try {
        const dataDir = path.join(process.cwd(), "referrals");

        // Check if migration already done by checking for .migrated files
        const userCodesFile = path.join(dataDir, "user_codes.json");
        const migratedMarker = userCodesFile + '.migrated';

        if (fs.existsSync(migratedMarker)) {
            elizaLogger.info("Referral data already migrated, skipping...");
            return;
        }

        if (!fs.existsSync(dataDir)) {
            elizaLogger.info("No referral data directory found, skipping migration");
            return;
        }

        let migratedCodes = 0;
        let migratedReferrals = 0;
        let migratedPending = 0;

        // Migrate user codes (email -> referral code mapping)
        if (fs.existsSync(userCodesFile)) {
            try {
                const userCodes = JSON.parse(fs.readFileSync(userCodesFile, 'utf-8')) as Record<string, string>;

                for (const [email, code] of Object.entries(userCodes)) {
                    const normalizedEmail = normalizeEmail(email);
                    const account = await db.getAccountByEmail(normalizedEmail);

                    if (account) {
                        // Check if code already exists
                        const existing = await db.getUserIdByReferralCode(code);
                        if (!existing) {
                            // Insert code directly into database
                            const { v4: uuidv4 } = await import('uuid');
                            const id = uuidv4();
                            if (typeof db.db?.prepare === "function") {
                                db.db
                                    .prepare(`
                                        INSERT INTO referral_codes (id, userId, referralCode, createdAt)
                                        VALUES (?, ?, ?, ?)
                                    `)
                                    .run(id, account.id, code, Date.now());
                            } else if (isMongoDbHandle(db.db)) {
                                await db.db.collection("referral_codes").updateOne(
                                    { referralCode: code },
                                    {
                                        $setOnInsert: {
                                            id,
                                            userId: account.id,
                                            referralCode: code,
                                            createdAt: Date.now(),
                                        },
                                    },
                                    { upsert: true }
                                );
                            }
                            migratedCodes++;
                            elizaLogger.debug(`Migrated referral code ${code} for ${email}`);
                        }
                    } else {
                        elizaLogger.warn(`Account not found for email ${email}, skipping code migration`);
                    }
                }

                // Archive original file
                fs.renameSync(userCodesFile, migratedMarker);
                elizaLogger.info(`✅ Migrated ${migratedCodes} referral codes`);
            } catch (error) {
                elizaLogger.error("Error migrating user codes:", error);
            }
        }

        // Migrate referral relationships
        const referralsFile = path.join(dataDir, "referrals.json");
        const referralsMigratedMarker = referralsFile + '.migrated';

        if (fs.existsSync(referralsFile)) {
            try {
                const referrals = JSON.parse(fs.readFileSync(referralsFile, 'utf-8')) as Array<{
                    email: string;
                    referral_code?: string;
                    timestamp: string;
                }>;

                for (const record of referrals) {
                    if (!record.referral_code) continue;

                    const normalizedEmail = normalizeEmail(record.email);
                    const referredUser = await db.getAccountByEmail(normalizedEmail);

                    if (!referredUser) {
                        const pendingStored = await recordPendingReferral(db, normalizedEmail, record.referral_code);
                        if (pendingStored) {
                            migratedPending++;
                            elizaLogger.debug(`Stored pending referral for ${record.email} with code ${record.referral_code}`);
                        } else {
                            elizaLogger.debug(`Account not found for ${record.email}, may not be registered yet`);
                        }
                        continue;
                    }

                    // Check if referral already exists
                    const existingReferrer = await db.getReferrerByUserId(referredUser.id);
                    if (existingReferrer) {
                        elizaLogger.debug(`User ${record.email} already has a referrer, skipping`);
                        continue;
                    }

                    // Create referral relationship
                    const success = await db.createReferral({
                        referredUserId: referredUser.id,
                        referralCode: record.referral_code
                    });

                    if (success) {
                        migratedReferrals++;
                        elizaLogger.debug(`Migrated referral for ${record.email} with code ${record.referral_code}`);
                    }
                }

                // Archive original file
                fs.renameSync(referralsFile, referralsMigratedMarker);
                elizaLogger.info(`✅ Migrated ${migratedReferrals} referral relationships`);
            } catch (error) {
                elizaLogger.error("Error migrating referral relationships:", error);
            }
        }

        if (migratedCodes > 0 || migratedReferrals > 0 || migratedPending > 0) {
            elizaLogger.success(
                `🎉 Referral data migration completed: ${migratedCodes} codes, ${migratedReferrals} relationships, ${migratedPending} pending`
            );
        }
    } catch (error) {
        elizaLogger.error("Error in referral data migration:", error);
    }
}

/**
 * Get user from Stripe customer ID or email
 */
async function getUserFromStripeCustomer(
    customerIdOrEmail: string,
    db: any
): Promise<UUID | null> {
    try {
        // Try by customer ID first (from existing subscriptions)
        const subscription = await db.getUserByStripeCustomerId(customerIdOrEmail);
        if (subscription) {
            return subscription.userId;
        }

        // Fall back to email lookup
        const account = await db.getAccountByEmail(normalizeEmail(customerIdOrEmail));
        return account?.id ?? null;
    } catch (error) {
        elizaLogger.error("Error getting user from Stripe customer:", error);
        return null;
    }
}

/**
 * Derive plan name from Stripe subscription
 */
function derivePlanFromSubscription(subscription: any): string | null {
    try {
        if (!Array.isArray(subscription?.items?.data)) {
            return null;
        }

        const nickname =
            subscription.items.data[0]?.price?.nickname?.toLowerCase() || "";

        if (nickname === "enterprise") return "Enterprise";
        if (nickname === "pro") return "Pro";
        if (nickname === "plus") return "Plus";

        return null;
    } catch (error) {
        elizaLogger.error("Error deriving plan from subscription:", error);
        return null;
    }
}

function resolveTierFromSubscriptionState(params: {
    subscriptionStatus?: string | null;
    planName?: string | null;
}): ResolvedSubscriptionTier {
    const status = String(params.subscriptionStatus ?? "").toLowerCase();
    if (!["active", "trialing", "past_due"].includes(status)) {
        return "free";
    }

    const plan = String(params.planName ?? "").toLowerCase();
    if (plan === "enterprise") {
        return "enterprise";
    }
    if (plan === "pro") {
        return "pro";
    }
    return "plus";
}

async function recordResolvedTierSnapshot(
    db: {
        recordSubscriptionTierChange?: (params: {
            userId: UUID;
            tier: ResolvedSubscriptionTier;
            source?: string;
            observedAt?: number;
        }) => Promise<boolean>;
    } | null | undefined,
    userId: UUID | null | undefined,
    tier: ResolvedSubscriptionTier
): Promise<void> {
    if (!db || !userId || typeof db.recordSubscriptionTierChange !== "function") {
        return;
    }

    try {
        await db.recordSubscriptionTierChange({
            userId,
            tier,
            source: "stripe_api",
        });
    } catch (error) {
        elizaLogger.warn("Failed to persist resolved subscription tier snapshot", {
            userId,
            tier,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

// ========================================
// Stripe Webhook Event Handlers
// ========================================

/**
 * Handle checkout session completed event
 */
async function handleCheckoutCompleted(event: any, db: any): Promise<void> {
    try {
        const session = event.data.object;
        const customerEmail = session.customer_email;
        const customerId = session.customer as string;

        if (!customerEmail) {
            elizaLogger.warn(`Checkout completed without email: ${event.id}`);
            return;
        }

        const userId = await getUserFromStripeCustomer(customerEmail, db);
        if (!userId) {
            elizaLogger.warn(`User not found for email: ${customerEmail}`);
            return;
        }

        // Record event
        await db.recordSubscriptionEvent({
            userId,
            eventType: event.type,
            stripeEventId: event.id,
            stripeCustomerId: customerId,
            eventData: event.data.object
        });

        elizaLogger.info(`✅ Checkout completed for ${customerEmail}`);
    } catch (error) {
        elizaLogger.error("Error handling checkout completed:", error);
    }
}

/**
 * Handle subscription created/updated event
 */
async function handleSubscriptionChange(event: any, db: any): Promise<void> {
    try {
        const subscription = event.data.object;
        const customerId = subscription.customer as string;
        const customerEmail = subscription.customer_email;

        // Look up user
        const userId = await getUserFromStripeCustomer(
            customerEmail || customerId,
            db
        );

        if (!userId) {
            elizaLogger.warn(`User not found for subscription: ${subscription.id}`);
            return;
        }

        // Determine plan name from subscription items
        const planName = derivePlanFromSubscription(subscription);

        // Record event
        await db.recordSubscriptionEvent({
            userId,
            eventType: event.type,
            stripeEventId: event.id,
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscription.id,
            subscriptionStatus: subscription.status,
            planName,
            eventData: event.data.object
        });

        // Update current subscription status
        await db.updateUserSubscription({
            userId,
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscription.id,
            subscriptionStatus: subscription.status,
            planName,
            currentPeriodStart: subscription.current_period_start ? subscription.current_period_start * 1000 : undefined,
            currentPeriodEnd: subscription.current_period_end ? subscription.current_period_end * 1000 : undefined,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
            lastEventId: event.id
        });
        await recordResolvedTierSnapshot(
            db,
            userId,
            resolveTierFromSubscriptionState({
                subscriptionStatus: subscription.status,
                planName,
            })
        );

        elizaLogger.info(`✅ Subscription ${subscription.status} for user ${userId}`);
    } catch (error) {
        elizaLogger.error("Error handling subscription change:", error);
    }
}

/**
 * Handle subscription deleted event
 */
async function handleSubscriptionDeleted(event: any, db: any): Promise<void> {
    try {
        const subscription = event.data.object;
        const customerId = subscription.customer as string;

        const userId = await getUserFromStripeCustomer(customerId, db);
        if (!userId) {
            elizaLogger.warn(`User not found for canceled subscription: ${subscription.id}`);
            return;
        }

        // Record event
        await db.recordSubscriptionEvent({
            userId,
            eventType: event.type,
            stripeEventId: event.id,
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscription.id,
            subscriptionStatus: 'canceled',
            eventData: event.data.object
        });

        // Update subscription status
        await db.updateUserSubscription({
            userId,
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscription.id,
            subscriptionStatus: 'canceled',
            lastEventId: event.id
        });
        await recordResolvedTierSnapshot(db, userId, "free");

        elizaLogger.info(`❌ Subscription canceled for user ${userId}`);
    } catch (error) {
        elizaLogger.error("Error handling subscription deletion:", error);
    }
}

/**
 * Handle payment succeeded event
 */
async function handlePaymentSucceeded(event: any, db: any): Promise<void> {
    try {
        const invoice = event.data.object;
        const customerId = invoice.customer as string;
        const subscriptionId = invoice.subscription as string;
        const customerEmail = invoice.customer_email;

        const userId = await getUserFromStripeCustomer(
            customerEmail || customerId,
            db
        );

        if (!userId) {
            elizaLogger.warn(`User not found for payment: ${invoice.id}`);
            return;
        }

        // Record payment event with revenue amount
        await db.recordSubscriptionEvent({
            userId,
            eventType: event.type,
            stripeEventId: event.id,
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscriptionId,
            amountCents: invoice.amount_paid,
            currency: invoice.currency,
            eventData: event.data.object
        });

        elizaLogger.info(
            `💰 Payment succeeded: ${invoice.amount_paid} ${invoice.currency} for user ${userId}`
        );
    } catch (error) {
        elizaLogger.error("Error handling payment succeeded:", error);
    }
}

/**
 * Handle payment failed event
 */
async function handlePaymentFailed(event: any, db: any): Promise<void> {
    try {
        const invoice = event.data.object;
        const customerId = invoice.customer as string;
        const customerEmail = invoice.customer_email;

        const userId = await getUserFromStripeCustomer(
            customerEmail || customerId,
            db
        );

        if (!userId) {
            elizaLogger.warn(`User not found for failed payment: ${invoice.id}`);
            return;
        }

        // Record failed payment
        await db.recordSubscriptionEvent({
            userId,
            eventType: event.type,
            stripeEventId: event.id,
            stripeCustomerId: customerId,
            amountCents: invoice.amount_due,
            currency: invoice.currency,
            eventData: event.data.object
        });

        elizaLogger.warn(`❌ Payment failed for user ${userId}`);
    } catch (error) {
        elizaLogger.error("Error handling payment failed:", error);
    }
}


// Exported for use in DirectClient routes and tests — checks req.userInfo without re-running authMiddleware
export const checkAuthenticated: express.RequestHandler = (req, res, next) => {
    const user = (req as any).userInfo;
    if (!user || user.type !== 'authenticated') {
        return res.status(401).json({ error: 'Authentication required' });
    }
    next();
};

export function createApiRouter(
    agents: Map<string, AgentRuntime>,
    directClient: DirectClient
):Router {
    const router = express.Router();

    // ALB + ECS health checks (must stay cheap — no DB); path matches task-def-agent.json
    router.get("/api/health", (_req, res) => {
        res.status(200).json({ status: "ok" });
    });

    const getFirstAgent = () => Array.from(agents.values())[0];
    let referralMigrationAttempted = false;

    const ensureReferralMigration = () => {
        if (referralMigrationAttempted) {
            return;
        }
        const firstAgent = getFirstAgent();
        if (firstAgent?.databaseAdapter) {
            referralMigrationAttempted = true;
            migrateReferralData(firstAgent.databaseAdapter).catch(error => {
                elizaLogger.error("Failed to migrate referral data:", error);
            });
        }
    };

    router.use((req, res, next) => {
        ensureReferralMigration();
        res.locals.databaseAdapter = getFirstAgent()?.databaseAdapter;
        next();
    });

    const ALLOWED_ORIGINS = new Set(
        (process.env.ALLOWED_ORIGINS || 'https://sentiedge.com,https://app.sentiedge.com,http://localhost:3000,http://localhost:3001')
            .split(',').map((s: string) => s.trim())
    );
    const corsOptions = {
        origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
            if (!origin || ALLOWED_ORIGINS.has(origin)) cb(null, true);
            // See note in index.ts — do not throw; let the browser enforce.
            else cb(null, false);
        },
        credentials: true
    };
    router.use(cors(corsOptions));

    router.get("/research-reports", (_req, res) => {
        const reportService = directClient.getReportSyncService();
        const reports = reportService ? reportService.getReports() : [];
        res.json({
            success: true,
            reports,
        });
    });

    router.get("/trending-sentiscores", async (_req, res) => {
        try {
            const trendingService = directClient.getTrendingSentiscoreService();
            const result = await trendingService.getTrendingScores();
            res.json(result);
        } catch (error) {
            elizaLogger.error("Error fetching trending sentiscores:", error);
            res.status(500).json({
                success: false,
                error: "Failed to fetch trending sentiscores",
            });
        }
    });

    router.get("/market/coinmarketcap/price", async (req, res) => {
        try {
            const symbolRaw = typeof req.query.symbol === "string" ? req.query.symbol : "";
            const convertRaw = typeof req.query.convert === "string" ? req.query.convert : "USD";
            const symbol = symbolRaw.trim().toUpperCase();
            const convert = convertRaw.trim().toUpperCase() || "USD";

            if (!symbol) {
                res.status(400).json({ error: "symbol is required" });
                return;
            }

            const apiKey = process.env.COINMARKETCAP_API_KEY;
            if (!apiKey) {
                res.status(503).json({ error: "COINMARKETCAP_API_KEY is not configured" });
                return;
            }

            const cacheKey = `${symbol}:${convert}`;
            const cached = coinMarketCapPriceCache.get(cacheKey);
            const now = Date.now();
            if (cached && now - cached.timestampMs < COINMARKETCAP_PRICE_CACHE_MS) {
                res.json(cached.payload);
                return;
            }

            const pending = coinMarketCapPending.get(cacheKey);
            if (pending) {
                res.json(await pending);
                return;
            }

            const requestPromise = (async () => {
                const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${encodeURIComponent(symbol)}&convert=${encodeURIComponent(convert)}`;
                const response = await httpClient.get(url, {
                    headers: {
                        Accept: "application/json",
                        "X-CMC_PRO_API_KEY": apiKey,
                    },
                });

                const quote = response.data?.data?.[symbol]?.quote?.[convert];
                const price = typeof quote?.price === "number" ? quote.price : null;

                const payload = {
                    success: true as const,
                    symbol,
                    convert,
                    price,
                    lastUpdatedMs: Date.now(),
                };

                coinMarketCapPriceCache.set(cacheKey, { payload, timestampMs: Date.now() });
                return payload;
            })().finally(() => {
                coinMarketCapPending.delete(cacheKey);
            });

            coinMarketCapPending.set(cacheKey, requestPromise);
            res.json(await requestPromise);
        } catch (error: any) {
            elizaLogger.error("Error fetching CoinMarketCap price:", error);
            const status = typeof error?.status === "number" ? error.status : undefined;
            const statusCode =
                typeof error?.response?.status === "number" ? error.response.status : status;

            if (statusCode === 429) {
                const symbolRaw = typeof req.query.symbol === "string" ? req.query.symbol : "";
                const convertRaw = typeof req.query.convert === "string" ? req.query.convert : "USD";
                const symbol = symbolRaw.trim().toUpperCase();
                const convert = convertRaw.trim().toUpperCase() || "USD";
                const cacheKey = `${symbol}:${convert}`;
                const cached = coinMarketCapPriceCache.get(cacheKey);
                if (cached) {
                    res.json(cached.payload);
                    return;
                }
            }
            res.status(500).json({
                error: "Failed to fetch CoinMarketCap price",
                details: error?.message,
            });
        }
    });

    router.post(
        "/stripe/webhook",
        express.raw({ type: "application/json" }),
        async (req, res) => {
            if (!isStripeConfigured()) {
                elizaLogger.warn(
                    "Stripe webhook invoked but STRIPE_SECRET_KEY is not configured"
                );
                res.status(503).json({
                    success: false,
                    message: "Stripe integration not configured",
                });
                return;
            }

            const webhookSecret = getStripeWebhookSecret();
            if (!webhookSecret) {
                elizaLogger.warn(
                    "Stripe webhook invoked but STRIPE_WEBHOOK_SECRET is missing"
                );
                res.status(503).json({
                    success: false,
                    message: "Stripe webhook secret not configured",
                });
                return;
            }

            const signature = req.headers["stripe-signature"]; // Stripe sends signature header
            if (!signature || typeof signature !== "string") {
                res.status(400).json({
                    success: false,
                    message: "Stripe signature header missing",
                });
                return;
            }

            try {
                const event = constructStripeEvent(
                    req.body as Buffer,
                    signature,
                    webhookSecret
                );

                // Get database adapter from first available agent
                const firstAgent = Array.from(agents.values())[0];
                const db = firstAgent?.databaseAdapter;

                if (db) {
                    // Process event based on type
                    switch (event.type) {
                        case "checkout.session.completed":
                            await handleCheckoutCompleted(event, db);
                            break;
                        case "customer.subscription.created":
                        case "customer.subscription.updated":
                            await handleSubscriptionChange(event, db);
                            break;
                        case "customer.subscription.deleted":
                            await handleSubscriptionDeleted(event, db);
                            break;
                        case "invoice.payment_succeeded":
                            await handlePaymentSucceeded(event, db);
                            break;
                        case "invoice.payment_failed":
                            await handlePaymentFailed(event, db);
                            break;
                        default:
                            elizaLogger.debug(
                                `Stripe webhook received unhandled event: ${event.type}`
                            );
                    }
                } else {
                    elizaLogger.warn("Database adapter not available, webhook not processed");
                }

                res.json({ success: true, received: true });
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : "Unknown Stripe error";
                elizaLogger.error("Stripe webhook signature verification failed", {
                    message,
                });
                res.status(400).json({ success: false, message });
            }
        }
    );

    router.use(bodyParser.json());
    router.use(bodyParser.urlencoded({ extended: true }));
    router.use(
        express.json({
            limit: getEnvVariable("EXPRESS_MAX_PAYLOAD") || "100kb",
        })
    );

    router.post("/analytics/page-session", authMiddleware, async (req, res) => {
        try {
            const db =
                (res.locals as { databaseAdapter?: any }).databaseAdapter ??
                (req.app as any)?.locals?.databaseAdapter;

            if (!db?.db) {
                res.status(503).json({ success: false, message: "Database not available" });
                return;
            }

            const {
                path: pagePath,
                referrer,
                durationMs,
                clickCount,
                startedAt,
                userEmail: reportedUserEmail,
                userName: reportedUserName
            } = req.body ?? {};

            if (typeof pagePath !== "string" || pagePath.length === 0) {
                res.status(400).json({ success: false, message: "path is required" });
                return;
            }

            const safeDurationMs =
                typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
                    ? Math.round(durationMs)
                    : 0;
            const safeClickCount =
                typeof clickCount === "number" && Number.isFinite(clickCount) && clickCount >= 0
                    ? Math.round(clickCount)
                    : 0;
            const createdAt =
                typeof startedAt === "number" && Number.isFinite(startedAt) && startedAt > 0
                    ? Math.round(startedAt)
                    : Date.now();
            const ipUserId = getUserIdFromIP(req);
            const resolvedEmail =
                typeof reportedUserEmail === "string" && reportedUserEmail.trim().length > 0
                    ? normalizeEmail(reportedUserEmail)
                    : null;

            // Analytics login status is derived only from current state payload:
            // has authenticated email => logged in, otherwise anonymous.
            const resolvedIsAuthenticated = resolvedEmail !== null;

            const ensureAccountExists = async (userId: string, email: string, name: string, source: "ip" | "auth") => {
                try {
                    const existing =
                        typeof db.getAccountById === "function"
                            ? await db.getAccountById(userId)
                            : db.db?.prepare?.("SELECT id FROM accounts WHERE id = ?").get(userId);
                    if (existing?.id || existing) {
                        return;
                    }
                    if (typeof db.createAccount === "function") {
                        await db.createAccount({
                            id: userId,
                            name,
                            username: name,
                            email,
                            avatarUrl: null,
                            details: { source, summary: "" },
                        });
                    }
                } catch (error) {
                    elizaLogger.error("Failed to ensure page session account:", error);
                }
            };

            let resolvedUserId: string | null = null;
            if (resolvedIsAuthenticated) {
                const candidate = emailToUserId(resolvedEmail);
                const name =
                    typeof reportedUserName === "string" && reportedUserName.length > 0
                        ? reportedUserName
                        : resolvedEmail;
                await ensureAccountExists(candidate, resolvedEmail, name, "auth");
                resolvedUserId = candidate;
            } else {
                const ipInfo = getIPInfo(req);
                const fallbackIdentifier =
                    typeof ipInfo?.normalizedIP === "string"
                        ? ipInfo.normalizedIP.replace(/[^a-zA-Z0-9._-]/g, "-")
                        : ipUserId.slice(0, 8);
                const email = `${ipUserId}@anonymous.local`;
                const name = `anon-${fallbackIdentifier}`;
                await ensureAccountExists(ipUserId, email, name, "ip");
                resolvedUserId = ipUserId;
            }
            const userAgent = req.headers["user-agent"] ?? null;

            if (isSqliteDbHandle(db.db)) {
                db.db.prepare(`
                    INSERT INTO web_page_sessions
                        (id, createdAt, userId, path, referrer, durationMs, clickCount, isAuthenticated, userAgent)
                    VALUES
                        (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    uuidv4(),
                    createdAt,
                    resolvedUserId,
                    pagePath,
                    typeof referrer === "string" ? referrer : null,
                    safeDurationMs,
                    safeClickCount,
                    resolvedIsAuthenticated ? 1 : 0,
                    typeof userAgent === "string" ? userAgent : null
                );
            } else if (isMongoDbHandle(db.db)) {
                await db.db.collection("web_page_sessions").insertOne({
                    id: uuidv4(),
                    createdAt,
                    userId: resolvedUserId,
                    path: pagePath,
                    referrer: typeof referrer === "string" ? referrer : null,
                    durationMs: safeDurationMs,
                    clickCount: safeClickCount,
                    isAuthenticated: resolvedIsAuthenticated ? 1 : 0,
                    userAgent: typeof userAgent === "string" ? userAgent : null,
                });
            } else {
                throw new Error("Unsupported database implementation for web_page_sessions insert");
            }

            // If this request is authenticated, suppress same-day anonymous Main Page
            // sessions from the same IP-derived user so the same person is not counted
            // in both anonymous and logged-in buckets.
            if (resolvedIsAuthenticated && resolvedUserId) {
                if (isSqliteDbHandle(db.db)) {
                    db.db.prepare(`
                        DELETE FROM web_page_sessions
                        WHERE path = ?
                          AND isAuthenticated = 0
                          AND userId = ?
                          AND date(createdAt / 1000, 'unixepoch', 'localtime') = date(? / 1000, 'unixepoch', 'localtime')
                    `).run(
                        MAIN_PAGE_PATH,
                        ipUserId,
                        createdAt
                    );
                } else if (isMongoDbHandle(db.db)) {
                    const dayStart = new Date(createdAt);
                    dayStart.setHours(0, 0, 0, 0);
                    const dayEnd = new Date(createdAt);
                    dayEnd.setHours(23, 59, 59, 999);

                    await db.db.collection("web_page_sessions").deleteMany({
                        path: MAIN_PAGE_PATH,
                        isAuthenticated: 0,
                        userId: ipUserId,
                        createdAt: {
                            $gte: dayStart.getTime(),
                            $lte: dayEnd.getTime(),
                        },
                    });
                }
            }

            res.json({ success: true });
        } catch (error) {
            elizaLogger.error("Failed to record page session:", error);
            res.status(500).json({ success: false, message: "Failed to record page session" });
        }
    });

    router.get("/analytics/summary", authMiddleware, requireRole("admin", "support"), async (req, res) => {
        try {
            if (!isAdminRequest(req)) {
                res.status(403).json({ success: false, message: "Forbidden" });
                return;
            }

            const db =
                (res.locals as { databaseAdapter?: any }).databaseAdapter ??
                (req.app as any)?.locals?.databaseAdapter;

            if (!db?.db) {
                res.status(503).json({ success: false, message: "Database not available" });
                return;
            }

            // Clear duration data for February 4th, 2026
            try {
                const feb4Start = new Date('2026-02-04T00:00:00').getTime();
                const feb4End = new Date('2026-02-04T23:59:59.999').getTime();

                const updateSql = `
                    UPDATE web_page_sessions
                    SET durationMs = 0
                    WHERE createdAt >= ? AND createdAt <= ?
                `;

                if (isSqliteDbHandle(db.db)) {
                    db.db.prepare(updateSql).run(feb4Start, feb4End);
                } else if (isMongoDbHandle(db.db)) {
                    await db.db.collection("web_page_sessions").updateMany(
                        {
                            createdAt: { $gte: feb4Start, $lte: feb4End },
                        },
                        { $set: { durationMs: 0 } }
                    );
                }
            } catch (clearError) {
                console.error('Failed to clear Feb 4th duration data:', clearError);
                // Continue with analytics even if clearing fails
            }

            if (isMongoDbHandle(db.db)) {
                // Mongo analytics are served exclusively from the hourly S3
                // snapshot. loadOrBuild() inline-builds one on first deploy /
                // disaster recovery so we never silently fall back to a slow
                // live aggregation that would return data with a different
                // freshness contract than the cached path.
                const snapshot = await directClient
                    .getAnalyticsSnapshotService()
                    .loadOrBuild();
                if (!snapshot) {
                    res.status(503).json({
                        success: false,
                        message:
                            "Analytics snapshot unavailable. Check AnalyticsSnapshot logs.",
                    });
                    return;
                }
                const { summary } = snapshot;
                res.json({
                    success: true,
                    generatedAt: snapshot.generatedAt,
                    snapshotHourUTC: snapshot.snapshotHourUTC,
                    dailyLabels: summary.dailyLabels,
                    totals: summary.totals,
                    usage: summary.usage,
                    usageSegments: summary.usageSegments,
                    main: summary.main,
                    signup: summary.signup,
                    register: summary.register,
                    mainAnonymousVisitors: summary.mainAnonymousVisitors,
                    registerAnonymousVisitors: summary.registerAnonymousVisitors,
                    registrations: summary.registrations,
                    signupLinkSends: summary.signupLinkSends,
                    loggedInVisitors: summary.loggedInVisitors,
                    mainAuth: summary.mainAuth,
                    hourlyMain: summary.hourlyMain,
                });
                return;
            }

            const labels = getPastDayLabels(ANALYTICS_PAST_DAYS);
            const start = new Date();
            start.setDate(start.getDate() - (ANALYTICS_PAST_DAYS - 1));
            start.setHours(0, 0, 0, 0);
            const sinceMs = start.getTime();

            const baseDaily = `
                SELECT date(createdAt / 1000, 'unixepoch', 'localtime') AS day,
                       COUNT(*) AS sessions,
                       COUNT(DISTINCT userId) AS visitors,
                       AVG(${COUNTED_DURATION_SQL}) AS avgDurationMs
                FROM web_page_sessions
                WHERE createdAt >= ? AND path = ?
                GROUP BY day ORDER BY day
            `;

            const signupDaily = `
                SELECT date(createdAt / 1000, 'unixepoch', 'localtime') AS day,
                       COUNT(*) AS sessions,
                       COUNT(DISTINCT userId) AS visitors,
                       AVG(${COUNTED_DURATION_SQL}) AS avgDurationMs
                FROM web_page_sessions
                WHERE createdAt >= ?
                  AND (
                      path = ?
                      OR path LIKE ?
                  )
                GROUP BY day ORDER BY day
            `;

            const registerDaily = `
                SELECT date(createdAt / 1000, 'unixepoch', 'localtime') AS day,
                       COUNT(*) AS sessions,
                       COUNT(DISTINCT userId) AS visitors,
                       AVG(${COUNTED_DURATION_SQL}) AS avgDurationMs
                FROM web_page_sessions
                WHERE createdAt >= ?
                  AND (
                      path = ?
                      OR path LIKE ?
                  )
                GROUP BY day ORDER BY day
            `;

            const anonymousVisitorsByPathDaily = `
                SELECT date(createdAt / 1000, 'unixepoch', 'localtime') AS day,
                       COUNT(DISTINCT userId) AS visitors
                FROM web_page_sessions
                WHERE createdAt >= ? AND path = ? AND ${ANONYMOUS_WEB_SESSION_FILTER}
                GROUP BY day ORDER BY day
            `;

            const anonymousRegisterVisitorsDaily = `
                SELECT date(createdAt / 1000, 'unixepoch', 'localtime') AS day,
                       COUNT(DISTINCT userId) AS visitors
                FROM web_page_sessions
                WHERE createdAt >= ?
                  AND ${ANONYMOUS_WEB_SESSION_FILTER}
                  AND (
                      path = ?
                      OR path LIKE ?
                  )
                GROUP BY day ORDER BY day
            `;

            const registrationsDaily = `
                SELECT date(createdAt, 'localtime') AS day,
                       COUNT(*) AS registrations
                FROM accounts
                WHERE date(createdAt, 'localtime') >= ?
                  AND json_extract(details, '$.source') = 'auth'
                  AND LOWER(email) NOT LIKE '%@anonymous.local'
                GROUP BY day ORDER BY day
            `;

            const signupLinkSendsDaily = `
                SELECT date(createdAt / 1000, 'unixepoch', 'localtime') AS day,
                       COUNT(*) AS linkSends
                FROM signup_link_sends
                WHERE createdAt >= ?
                GROUP BY day ORDER BY day
            `;

            const authDaily = `
                SELECT date(createdAt / 1000, 'unixepoch', 'localtime') AS day,
                       CASE
                           WHEN ${ANONYMOUS_WEB_SESSION_FILTER} THEN 0
                           ELSE 1
                       END AS isAuthenticated,
                       COUNT(DISTINCT userId) AS visitors,
                       AVG(${COUNTED_DURATION_SQL}) AS avgDurationMs
                FROM web_page_sessions
                WHERE createdAt >= ? AND path = ?
                GROUP BY day, isAuthenticated ORDER BY day
            `;

            const loggedInVisitorsDaily = `
                SELECT date(createdAt / 1000, 'unixepoch', 'localtime') AS day,
                       COUNT(DISTINCT userId) AS visitors
                FROM web_page_sessions
                WHERE createdAt >= ? AND isAuthenticated = 1
                GROUP BY day ORDER BY day
            `;

            const hourly = `
                SELECT strftime('%Y-%m-%d %H:00', createdAt / 1000, 'unixepoch', 'localtime') AS hour,
                       COUNT(*) AS sessions,
                       COUNT(DISTINCT userId) AS visitors,
                       AVG(${COUNTED_DURATION_SQL}) AS avgDurationMs
                FROM web_page_sessions
                WHERE createdAt >= ? AND path = ?
                GROUP BY hour ORDER BY hour
            `;

            const hourlySince = Date.now() - ANALYTICS_HOURLY_POINTS * 60 * 60 * 1000;

            const mainRows = safeAnalyticsAll(db.db, baseDaily, [sinceMs, MAIN_PAGE_PATH]);
            const signupRows = safeAnalyticsAll(db.db, signupDaily, [
                sinceMs,
                SIGNUP_PAGE_PATH,
                `${SIGNUP_PAGE_PREFIX}%`,
            ]);
            const registerRows = safeAnalyticsAll(db.db, registerDaily, [
                sinceMs,
                REGISTER_PAGE_PATH,
                `${REGISTER_PAGE_PREFIX}%`,
            ]);
            const mainAnonymousRows = safeAnalyticsAll(db.db, anonymousVisitorsByPathDaily, [
                sinceMs,
                MAIN_PAGE_PATH,
            ]);
            const registerAnonymousRows = safeAnalyticsAll(
                db.db,
                anonymousRegisterVisitorsDaily,
                [
                    sinceMs,
                    REGISTER_PAGE_PATH,
                    `${REGISTER_PAGE_PREFIX}%`,
                ]
            );
            const registrationsRows = safeAnalyticsAll(db.db, registrationsDaily, [
                labels[0],
            ]);
            const signupLinkSendRows = safeAnalyticsAll(db.db, signupLinkSendsDaily, [
                sinceMs,
            ]);
            const authRows = safeAnalyticsAll(db.db, authDaily, [sinceMs, MAIN_PAGE_PATH]);
            const loggedInVisitorsRows = safeAnalyticsAll(db.db, loggedInVisitorsDaily, [
                sinceMs,
            ]);
            const hourlyRows = safeAnalyticsAll(db.db, hourly, [hourlySince, MAIN_PAGE_PATH]);
            const usageRows = runUsageDaily(db.db, sinceMs);
            const usageSegments = runUsageSegments(db.db, sinceMs);
            const usageTotals = runUsageTotals(db.db);
            const usageSegmentTotals = runUsageSegmentTotals(db.db);

            const hourlyLabels = getPastHourLabels(ANALYTICS_HOURLY_POINTS);

            const totals = {
                usage: usageTotals,
                usageSegments: usageSegmentTotals,
                main: runPageTotals(
                    db.db,
                    `path = ?`,
                    [MAIN_PAGE_PATH]
                ),
                signup: runPageTotals(
                    db.db,
                    `(path = ? OR path LIKE ?)`,
                    [SIGNUP_PAGE_PATH, `${SIGNUP_PAGE_PREFIX}%`]
                ),
                register: runPageTotals(
                    db.db,
                    `(path = ? OR path LIKE ?)`,
                    [REGISTER_PAGE_PATH, `${REGISTER_PAGE_PREFIX}%`]
                ),
                mainAnonymousVisitors: runAnonymousVisitorsTotal(
                    db.db,
                    `path = ? AND ${ANONYMOUS_WEB_SESSION_FILTER}`,
                    [MAIN_PAGE_PATH]
                ),
                registerAnonymousVisitors: runAnonymousVisitorsTotal(
                    db.db,
                    `${ANONYMOUS_WEB_SESSION_FILTER} AND (path = ? OR path LIKE ?)`,
                    [REGISTER_PAGE_PATH, `${REGISTER_PAGE_PREFIX}%`]
                ),
                registrations: runRegistrationTotal(db.db),
                signupLinkSends: runSignupLinkSendTotal(db.db),
                mainAuth: runAuthTotals(db.db, MAIN_PAGE_PATH),
            };

            res.json({
                success: true,
                generatedAt: Date.now(),
                dailyLabels: labels,
                totals,
                usage: mergeUsageRows(usageRows, labels),
                usageSegments: {
                    anonymous: mergeUsageRows(usageSegments.anonymous || [], labels),
                    free: mergeUsageRows(usageSegments.free || [], labels),
                    plus: mergeUsageRows(usageSegments.plus || [], labels),
                    pro: mergeUsageRows(usageSegments.pro || [], labels),
                },
                main: mergeDailyRows(mainRows, labels),
                signup: mergeDailyRows(signupRows, labels),
                register: mergeDailyRows(registerRows, labels),
                mainAnonymousVisitors: mergeVisitorRows(mainAnonymousRows, labels),
                registerAnonymousVisitors: mergeVisitorRows(registerAnonymousRows, labels),
                registrations: mergeRegistrationRows(registrationsRows, labels),
                signupLinkSends: mergeSignupLinkSendRows(signupLinkSendRows, labels),
                loggedInVisitors: mergeVisitorRows(loggedInVisitorsRows, labels),
                mainAuth: mergeAuthRows(authRows, labels),
                hourlyMain: mergeHourlyRows(hourlyRows, hourlyLabels),
            });
        } catch (error) {
            elizaLogger.error("Failed to generate analytics summary:", error);
            res.status(500).json({ success: false, message: "Failed to generate analytics summary" });
        }
    });

    router.post("/analytics/snapshot/rebuild", authMiddleware, requireRole("admin"), async (req, res) => {
        try {
            if (!isAdminRequest(req)) {
                res.status(403).json({ success: false, message: "Forbidden" });
                return;
            }

            const snapshot = await directClient
                .getAnalyticsSnapshotService()
                .runSnapshot("manual-rebuild");
            if (!snapshot) {
                res.status(503).json({
                    success: false,
                    message:
                        "Snapshot service unavailable (no Mongo adapter or no S3 client). Check logs.",
                });
                return;
            }
            res.json({
                success: true,
                generatedAt: snapshot.generatedAt,
                snapshotHourUTC: snapshot.snapshotHourUTC,
            });
        } catch (error) {
            elizaLogger.error("Failed to rebuild analytics snapshot:", error);
            res.status(500).json({
                success: false,
                message: "Failed to rebuild analytics snapshot",
            });
        }
    });

    router.get("/analytics/referral-codes-today", authMiddleware, requireRole("admin", "support"), async (req, res) => {
        try {
            if (!isAdminRequest(req)) {
                res.status(403).json({ success: false, message: "Forbidden" });
                return;
            }

            const db =
                (res.locals as { databaseAdapter?: any }).databaseAdapter ??
                (req.app as any)?.locals?.databaseAdapter;

            if (!db?.db) {
                res.status(503).json({ success: false, message: "Database not available" });
                return;
            }

            // Query to get referral code stats for today
            // Two dimensions:
            // 1. Sent but not registered (today sent, not registered today)
            // 2. Sent and registered (today completed registration with referral code, regardless of send date)
            const query = `
                WITH today_signup_links AS (
                    -- All signup links sent today
                    SELECT
                        sls.referralCode,
                        sls.email,
                        sls.createdAt
                    FROM signup_link_sends sls
                    WHERE sls.referralCode IS NOT NULL
                      AND date(
                          CASE
                              WHEN typeof(sls.createdAt) IN ('integer', 'real') THEN sls.createdAt / 1000
                              ELSE strftime('%s', sls.createdAt)
                          END,
                          'unixepoch',
                          'localtime'
                      ) = date('now', 'localtime')
                ),
                today_registrations AS (
                    -- All users who registered today (for pending classification)
                    SELECT
                        a.email,
                        a.createdAt
                    FROM accounts a
                    WHERE date(
                        CASE
                            WHEN typeof(a.createdAt) IN ('integer', 'real') THEN a.createdAt / 1000
                            ELSE strftime('%s', a.createdAt)
                        END,
                        'unixepoch',
                        'localtime'
                    ) = date('now', 'localtime')
                ),
                pending_stats AS (
                    -- Pending: links sent today where the email did not register today
                    SELECT
                        tsl.referralCode,
                        COUNT(DISTINCT tsl.email) as pendingCount
                    FROM today_signup_links tsl
                    LEFT JOIN today_registrations tr ON tr.email = tsl.email
                    WHERE tr.email IS NULL
                    GROUP BY tsl.referralCode
                ),
                today_completed_registrations AS (
                    -- Completed: users who registered today and have a recorded referral code usage
                    SELECT
                        urc.referralCodeUsed AS referralCode,
                        a.email
                    FROM accounts a
                    INNER JOIN user_referral_codes urc ON urc.userId = a.id
                    WHERE date(
                        CASE
                            WHEN typeof(a.createdAt) IN ('integer', 'real') THEN a.createdAt / 1000
                            ELSE strftime('%s', a.createdAt)
                        END,
                        'unixepoch',
                        'localtime'
                    ) = date('now', 'localtime')
                      AND urc.referralCodeUsed IS NOT NULL
                ),
                completed_stats AS (
                    SELECT
                        tcr.referralCode,
                        COUNT(DISTINCT tcr.email) as completedCount
                    FROM today_completed_registrations tcr
                    GROUP BY tcr.referralCode
                ),
                all_referral_codes AS (
                    SELECT
                        referralCode
                    FROM pending_stats
                    UNION
                    SELECT
                        referralCode
                    FROM completed_stats
                ),
                aggregated_stats AS (
                    SELECT
                        arc.referralCode,
                        COALESCE(ps.pendingCount, 0) as pendingCount,
                        COALESCE(cs.completedCount, 0) as completedCount
                    FROM all_referral_codes arc
                    LEFT JOIN pending_stats ps ON ps.referralCode = arc.referralCode
                    LEFT JOIN completed_stats cs ON cs.referralCode = arc.referralCode
                )
                -- Return all referral codes with their stats (including unused ones)
                SELECT
                    COALESCE(ast.referralCode, rc.referralCode) as referralCode,
                    COALESCE(ast.pendingCount, 0) as pendingCount,
                    COALESCE(ast.completedCount, 0) as completedCount
                FROM referral_codes rc
                LEFT JOIN aggregated_stats ast ON ast.referralCode = rc.referralCode
                ORDER BY (COALESCE(ast.pendingCount, 0) + COALESCE(ast.completedCount, 0)) DESC,
                         completedCount DESC,
                         referralCode
            `;

            const rows =
                isSqliteDbHandle(db.db)
                    ? (db.db.prepare(query).all() as Array<{
                          referralCode: string;
                          pendingCount: number;
                          completedCount: number;
                      }>)
                    : isMongoDbHandle(db.db)
                      ? await getMongoReferralCodeStatsToday(db.db)
                      : [];

            // Format data as table structure
            const tableData = rows.map(row => ({
                referralCode: row.referralCode,
                pendingCount: row.pendingCount,
                completedCount: row.completedCount
            }));

            // Calculate totals
            const totalPending = rows.reduce((sum, row) => sum + row.pendingCount, 0);
            const totalCompleted = rows.reduce((sum, row) => sum + row.completedCount, 0);
            const totalCodes = rows.length;

            res.json({
                success: true,
                generatedAt: Date.now(),
                date: new Date().toLocaleDateString("en-CA"),
                summary: {
                    totalCodes,
                    totalPending,
                    totalCompleted
                },
                data: tableData
            });
        } catch (error) {
            elizaLogger.error("Failed to get today's referral code stats:", error);
            res.status(500).json({ success: false, message: "Failed to get referral code statistics" });
        }
    });

    router.get("/analytics/referral-codes-last-30-days", authMiddleware, requireRole("admin", "support"), async (req, res) => {
        try {
            if (!isAdminRequest(req)) {
                res.status(403).json({ success: false, message: "Forbidden" });
                return;
            }

            const db =
                (res.locals as { databaseAdapter?: any }).databaseAdapter ??
                (req.app as any)?.locals?.databaseAdapter;

            if (!db?.db) {
                res.status(503).json({ success: false, message: "Database not available" });
                return;
            }

            // Query to get referral code stats for last 30 days
            // Two dimensions:
            // 1. Sent but not registered (sent in last 30 days, not registered yet)
            // 2. Sent and registered (sent in last 30 days, registered anytime)
            const query = `
                WITH last_30_days_signup_links AS (
                    -- All signup links sent in last 30 days
                    SELECT
                        sls.referralCode,
                        sls.email,
                        sls.createdAt
                    FROM signup_link_sends sls
                    WHERE sls.referralCode IS NOT NULL
                      AND date(
                          CASE
                              WHEN typeof(sls.createdAt) IN ('integer', 'real') THEN sls.createdAt / 1000
                              ELSE strftime('%s', sls.createdAt)
                          END,
                          'unixepoch',
                          'localtime'
                      ) >= date('now', 'localtime', '-29 days')
                ),
                all_registrations AS (
                    -- All users who have registered (anytime)
                    SELECT
                        a.email,
                        a.createdAt
                    FROM accounts a
                ),
                link_status AS (
                    -- Classify each signup link as pending or completed
                    SELECT
                        lsl.referralCode,
                        lsl.email,
                        CASE
                            WHEN ar.email IS NOT NULL THEN 'completed'
                            ELSE 'pending'
                        END as status
                    FROM last_30_days_signup_links lsl
                    LEFT JOIN all_registrations ar ON ar.email = lsl.email
                ),
                aggregated_stats AS (
                    -- Count pending and completed for each referral code
                    SELECT
                        referralCode,
                        COUNT(DISTINCT CASE WHEN status = 'pending' THEN email END) as pendingCount,
                        COUNT(DISTINCT CASE WHEN status = 'completed' THEN email END) as completedCount
                    FROM link_status
                    GROUP BY referralCode
                )
                -- Return all referral codes with their stats (including unused ones)
                SELECT
                    COALESCE(ast.referralCode, rc.referralCode) as referralCode,
                    COALESCE(ast.pendingCount, 0) as pendingCount,
                    COALESCE(ast.completedCount, 0) as completedCount
                FROM referral_codes rc
                LEFT JOIN aggregated_stats ast ON ast.referralCode = rc.referralCode
                ORDER BY (COALESCE(ast.pendingCount, 0) + COALESCE(ast.completedCount, 0)) DESC,
                         completedCount DESC,
                         referralCode
            `;

            // Mongo: served exclusively from the hourly S3 snapshot (matches
            // /analytics/summary contract — see AnalyticsSnapshotService).
            if (isMongoDbHandle(db.db)) {
                const snapshot = await directClient
                    .getAnalyticsSnapshotService()
                    .loadOrBuild();
                if (!snapshot) {
                    res.status(503).json({
                        success: false,
                        message:
                            "Analytics snapshot unavailable. Check AnalyticsSnapshot logs.",
                    });
                    return;
                }
                res.json({
                    success: true,
                    generatedAt: snapshot.generatedAt,
                    snapshotHourUTC: snapshot.snapshotHourUTC,
                    range: snapshot.referralLast30Days.range,
                    summary: snapshot.referralLast30Days.summary,
                    data: snapshot.referralLast30Days.data,
                });
                return;
            }

            const rows =
                isSqliteDbHandle(db.db)
                    ? (db.db.prepare(query).all() as Array<{
                          referralCode: string;
                          pendingCount: number;
                          completedCount: number;
                      }>)
                    : [];

            const totalPending = rows.reduce((sum, row) => sum + row.pendingCount, 0);
            const totalCompleted = rows.reduce((sum, row) => sum + row.completedCount, 0);
            const totalCodes = rows.length;
            const fromDate = new Date(
                Date.now() - 29 * 24 * 60 * 60 * 1000
            ).toLocaleDateString("en-CA");
            const toDate = new Date().toLocaleDateString("en-CA");

            res.json({
                success: true,
                generatedAt: Date.now(),
                range: {
                    from: fromDate,
                    to: toDate,
                },
                summary: {
                    totalCodes,
                    totalPending,
                    totalCompleted,
                },
                data: rows,
            });
        } catch (error) {
            elizaLogger.error("Failed to get last 30 days referral code stats:", error);
            res.status(500).json({
                success: false,
                message: "Failed to get last 30 days referral code statistics",
            });
        }
    });

    // Note: Authentication middleware is applied to specific routes that need it
    // Not applied globally to avoid breaking basic endpoints

    router.get("/hello", (req, res) => {
        res.json({ message: "Hello World!" });
    });

    router.get("/agents", (req, res) => {
        const agentsList = Array.from(agents.values()).map((agent) => ({
            id: agent.agentId,
            name: agent.character.name,
            clients: Object.keys(agent.clients),
        }));
        res.json({ agents: agentsList });
    });

    // Trending research endpoint for landing page
    router.get("/trending-research", (req, res) => {
        // Return trending crypto research questions
        // In the future, this could pull from a database or analytics
        const trendingQuestions = [
            {
                id: '1',
                category: 'Project Research',
                icon: '🤔',
                question: 'How can Bitcoin maintain its market dominance with increasing competition from Ethereum and other Layer 1 blockchains?',
                tokenSymbol: 'BTC',
                tokenIcon: '₿',
            },
            {
                id: '2',
                category: 'Hottest Question',
                icon: '🔥',
                question: 'Will the upcoming Ethereum Dencun upgrade significantly reduce Layer 2 transaction costs?',
                tokenSymbol: 'ETH',
                tokenIcon: '◈',
            },
            {
                id: '3',
                category: 'Project Research',
                icon: '🤔',
                question: 'Solana faces network congestion again — can the blockchain scale effectively for mass adoption?',
                tokenSymbol: 'SOL',
                tokenIcon: '◎',
            },
            {
                id: '4',
                category: 'Airdrop Hunt',
                icon: '🪂',
                question: 'Which upcoming protocol airdrops are worth farming based on historical airdrop patterns?',
                tokenSymbol: 'Various',
            },
            {
                id: '5',
                category: 'Market Analysis',
                icon: '📊',
                question: 'What impact will Bitcoin spot ETF flows have on the next bull market cycle?',
                tokenSymbol: 'BTC',
                tokenIcon: '₿',
            },
            {
                id: '6',
                category: 'Hottest Question',
                icon: '🔥',
                question: 'Are we entering a new altcoin season based on Bitcoin dominance trends?',
                tokenSymbol: 'ALTS',
            },
        ];

        res.json(trendingQuestions);
    });

    // Agent tools endpoint for landing page showcase
    router.get("/agent-tools", (req, res) => {
        // Return available agent tools/capabilities
        const agentTools = [
            {
                id: 'sentiment',
                name: 'Social Sentiment Analysis',
                description: 'Real-time tracking of 100,000+ curated crypto KOLs, analyzing sentiment and key opinions.',
                icon: 'sentiment',
                metric: '100,000+ KOLs tracked',
                preview: '📊',
            },
            {
                id: 'technical',
                name: 'Technical Analysis',
                description: 'Leverage 40+ technical indicators and derivatives market data to deliver precise trends and signals for real-time analysis.',
                icon: 'technical',
                metric: '40+ indicators',
                preview: '📈',
            },
            {
                id: 'onchain',
                name: 'On-Chain Data Analysis',
                description: 'Track whale movements, exchange flows, and blockchain metrics to identify smart money behavior and market trends.',
                icon: 'onchain',
                metric: 'Live blockchain data',
                preview: '⛓️',
            },
            {
                id: 'news',
                name: 'News Aggregation & Sentiment',
                description: 'Aggregate crypto news from multiple sources with AI-powered sentiment analysis to capture market-moving events.',
                icon: 'news',
                metric: 'Multi-source aggregation',
                preview: '📰',
            },
            {
                id: 'prediction',
                name: 'Market Prediction',
                description: 'Advanced AI models combining multiple data sources to forecast price movements and market trends.',
                icon: 'prediction',
                metric: 'ML-powered forecasts',
                preview: '🔮',
            },
            {
                id: 'charts',
                name: 'Interactive Charts',
                description: 'Generate comprehensive visual reports with candlestick charts, indicators, and custom analysis visualizations.',
                icon: 'market',
                metric: 'Professional charts',
                preview: '📊',
            },
        ];

        res.json(agentTools);
    });

    router.get('/storage', async (req, res) => {
        try {
            const uploadDir = path.join(process.cwd(), "data", "characters");
            const files = await fs.promises.readdir(uploadDir);
            res.json({ files });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    router.get(
        "/billing/subscription",
        authMiddleware,
        async (req, res) => {
            if (!isStripeConfigured()) {
                res.status(503).json({
                    success: false,
                    message: "Stripe integration not configured",
                });
                return;
            }

            const userInfo = (req as any).userInfo;
            if (!userInfo || userInfo.type !== "authenticated") {
                res.status(401).json({
                    success: false,
                    message: "Authentication required to check subscription status",
                });
                return;
            }

            const requestedEmailRaw = req.query.email;
            const normalizedUserEmail = userInfo.email?.toLowerCase();
            const normalizedRequestedEmail =
                typeof requestedEmailRaw === "string"
                    ? requestedEmailRaw.trim().toLowerCase()
                    : normalizedUserEmail;

            if (!normalizedRequestedEmail) {
                res.status(400).json({
                    success: false,
                    message: "Email is required to look up subscription status",
                });
                return;
            }

            if (
                normalizedUserEmail &&
                normalizedRequestedEmail !== normalizedUserEmail
            ) {
                res.status(403).json({
                    success: false,
                    message: "You are not authorized to query other users' subscriptions",
                });
                return;
            }

            try {
                const { lookupResult, summary } =
                    await getSubscriptionStatusByEmail(normalizedRequestedEmail);
                const dbAdapter =
                    (res.locals as { databaseAdapter?: any }).databaseAdapter ??
                    (req.app as any)?.locals?.databaseAdapter;
                await recordResolvedTierSnapshot(
                    dbAdapter,
                    userInfo.userId as UUID,
                    summary.resolvedTier
                );
                const resolvedTierFromHistory =
                    await resolveEffectiveSubscriptionTierFromAdapter(
                        dbAdapter,
                        userInfo.userId as UUID
                    );

                res.json({
                    success: true,
                    email: lookupResult.email,
                    planName: summary.planName,
                    resolvedTier: resolvedTierFromHistory,
                    primarySubscriptionId:
                        summary.primarySubscription?.id ?? null,
                    primarySubscriptionNickname:
                        summary.primarySubscription?.items[0]?.nickname ?? null,
                    primarySubscription:
                        summary.primarySubscription ?? null,
                    customers: lookupResult.customers,
                });
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : "Failed to query Stripe";
                res.status(502).json({ success: false, message });
            }
        }
    );

    // Authentication endpoints
    router.get("/authentication/me/", authMiddleware, async (req, res) => {
        try {
            const userInfo = (req as any).userInfo;

            if (userInfo?.type === 'authenticated') {
                elizaLogger.debug(`🔐 Auth check for: ${userInfo.email}`);
                const dbAdapter =
                    (res.locals as { databaseAdapter?: any }).databaseAdapter ??
                    (req.app as any)?.locals?.databaseAdapter;
                let resolvedTierFromHistory =
                    await resolveEffectiveSubscriptionTierFromAdapter(
                        dbAdapter,
                        userInfo.userId as UUID
                    );

                let subscriptionSummary: {
                    success: boolean;
                    email?: string;
                    planName?: string | null;
                    resolvedTier?: "free" | "plus" | "pro" | "enterprise";
                    primarySubscriptionId?: string | null;
                    primarySubscriptionNickname?: string | null;
                    primarySubscription?: unknown;
                    customers?: SubscriptionLookupResult["customers"];
                } | null = null;

                const email =
                    typeof userInfo.email === "string"
                        ? userInfo.email.trim().toLowerCase()
                        : "";

                if (email && isStripeConfigured()) {
                    try {
                        const { lookupResult, summary } =
                            await getSubscriptionStatusByEmail(email);
                        await recordResolvedTierSnapshot(
                            dbAdapter,
                            userInfo.userId as UUID,
                            summary.resolvedTier
                        );
                        resolvedTierFromHistory =
                            await resolveEffectiveSubscriptionTierFromAdapter(
                                dbAdapter,
                                userInfo.userId as UUID
                            );

                        subscriptionSummary = {
                            success: true,
                            email: lookupResult.email,
                            planName: summary.planName,
                            resolvedTier: resolvedTierFromHistory,
                            primarySubscriptionId:
                                summary.primarySubscription?.id ?? null,
                            primarySubscriptionNickname:
                                summary.primarySubscription?.items[0]?.nickname ?? null,
                            primarySubscription:
                                summary.primarySubscription ?? null,
                            customers: lookupResult.customers,
                        };
                    } catch (subscriptionError) {
                        const message =
                            subscriptionError instanceof Error
                                ? subscriptionError.message
                                : "Unknown Stripe error";
                        elizaLogger.error(
                            "Auth check subscription lookup failed",
                            {
                                email,
                                message,
                            }
                        );
                        subscriptionSummary = {
                            success: false,
                            email,
                        };
                    }
                }

                res.json({
                    user: {
                        email: userInfo.email,
                        id: (req as any).userId,
                        type: 'authenticated',
                        resolvedTier: resolvedTierFromHistory,
                    },
                    subscription: subscriptionSummary,
                });
            } else {
                elizaLogger.debug(`🌐 Auth check for anonymous: ${userInfo?.ip || 'unknown'}`);
                res.status(401).json({
                    error: "Not authenticated"
                });
            }
        } catch (error) {
            elizaLogger.error("Auth check error:", error);
            res.status(500).json({
                error: "Failed to check authentication status"
            });
        }
    });

    router.post("/authentication/logout/", authMiddleware, async (req, res) => {
        try {
            const userInfo = (req as any).userInfo;

            // Log logout activity
            if (userInfo?.type === 'authenticated') {
                elizaLogger.info(`🔓 User logged out: ${userInfo.email}`);
            } else {
                elizaLogger.info(`🔓 Anonymous user logged out: ${userInfo?.ip || 'unknown'}`);
            }

            // Per the Cookie RFC, `Set-Cookie` deletion only takes effect when
            // Name + Domain + Path match the *original* cookie. Django sets
            // access_token / refresh_token / user_email with Domain=.sentiedge.ai
            // (parent-domain scope, so all subdomains receive them — see
            // production_settings.py AUTH_COOKIE_DOMAIN). If we omit Domain
            // here, the browser only clears a phantom host-only cookie and
            // keeps the real parent-domain one, leaving the user effectively
            // logged in. Source for this is the runtime env var so local dev
            // (where cookies are host-only on localhost) still works.
            //
            // The `cookie` package that Express's `res.clearCookie` uses
            // validates the Domain attribute against
            //   /^[a-zA-Z0-9][a-zA-Z0-9\-]*(\.[a-zA-Z0-9][a-zA-Z0-9\-]*)*$/
            // which rejects leading-dot forms like ".sentiedge.ai". RFC 6265
            // §5.2.3 specifies that browsers strip the leading dot anyway and
            // store the cookie as if it were set without one, so dropping the
            // dot here produces an identical-scope cookie match. Without this
            // normalization, the handler throws `TypeError: option domain is
            // invalid` and returns 500 — leaving the user effectively logged
            // in for the same reason as the original bug.
            const isProd = process.env.NODE_ENV === 'production';
            const rawAuthCookieDomain = process.env.AUTH_COOKIE_DOMAIN || '';
            const authCookieDomain = rawAuthCookieDomain.replace(/^\./, '') || undefined;
            const httpOnlyOptions: any = {
                httpOnly: true,
                secure: isProd,
                sameSite: 'lax',
                path: '/',
                ...(authCookieDomain ? { domain: authCookieDomain } : {}),
            };
            const jsReadableOptions: any = {
                httpOnly: false,
                secure: isProd,
                sameSite: 'lax',
                path: '/',
                ...(authCookieDomain ? { domain: authCookieDomain } : {}),
            };

            res.clearCookie('access_token', httpOnlyOptions);
            res.clearCookie('refresh_token', httpOnlyOptions);
            res.clearCookie('user_email', jsReadableOptions);

            // Legacy host-only cookie left by older clients. Clear with no
            // domain so it matches the original scope (which had none).
            res.clearCookie('user_info', {
                httpOnly: false,
                secure: isProd,
                sameSite: 'lax',
                path: '/',
            });

            res.json({
                success: true,
                message: "Logged out successfully"
            });
        } catch (error) {
            elizaLogger.error("Logout error:", error);
            res.status(500).json({
                success: false,
                error: "Failed to logout"
            });
        }
    });

    // Get or generate referral code for authenticated user
    router.get("/authentication/referral-code/", authMiddleware, async (req, res) => {
        try {
            const userInfo = (req as any).userInfo;

            if (userInfo?.type !== 'authenticated') {
                return res.status(401).json({
                    error: "Authentication required"
                });
            }

            const email = normalizeEmail(userInfo.email);

            // Get database adapter from first available agent
            const firstAgent = Array.from(agents.values())[0];
            const db = firstAgent?.databaseAdapter;

            if (!db) {
                elizaLogger.error("Database adapter not available");
                return res.status(500).json({ error: "Database not available" });
            }

            // Get user account from database
            const account = await db.getAccountByEmail(email);
            if (!account) {
                return res.status(404).json({
                    error: "Account not found"
                });
            }

            // Get or create referral code for user
            const referralCode = await db.getOrCreateReferralCode(account.id);

            // Get referral statistics
            const stats = await db.getReferralStats(account.id);

            // Get the base URL from environment or construct it
            const baseUrl = "https://www.agent.sentiedge.ai";
            const referralLink = `${baseUrl}/signup?ref=${referralCode}`;

            res.json({
                referralCode,
                referralLink,
                totalInvites: stats.totalReferrals,
                activeSubscriptions: stats.activeSubscriptions,
                totalRevenue: stats.totalRevenue,
                currency: stats.currency
            });
        } catch (error) {
            elizaLogger.error("Referral code generation error:", error);
            res.status(500).json({
                error: "Failed to generate referral code"
            });
        }
    });

    // Enrollment token - record email and referral code in database
    router.post("/authentication/enrollment/token/", async (req, res) => {
        try {
            const { email, referral_code } = req.body;

            if (!email) {
                return res.status(400).json({ message: "Email is required" });
            }

            // Get database adapter from first available agent
            const firstAgent = Array.from(agents.values())[0];
            const db = firstAgent?.databaseAdapter;

            if (!db) {
                elizaLogger.error("Database adapter not available");
                return res.status(500).json({ message: "Database not available" });
            }

            const linkSendRecorded = await recordSignupLinkSend(db, email, referral_code ?? null);
            if (!linkSendRecorded) {
                elizaLogger.error(`❌ Failed to record signup link send for ${email}`);
                return res.status(500).json({ message: "Failed to send sign up link" });
            }

            if (referral_code) {
                const stored = await recordPendingReferral(db, email, referral_code);
                if (stored) {
                    elizaLogger.info(`📧 Recorded: ${email} (ref: ${referral_code})`);
                } else {
                    elizaLogger.warn(`⚠️ Failed to record pending referral for ${email}`);
                }
            } else {
                elizaLogger.info(`📧 Recorded: ${email} (no referral code)`);
            }

            res.status(201).json({ message: "Sign up link sent successfully!" });
        } catch (error) {
            elizaLogger.error("Enrollment error:", error);
            res.status(500).json({ message: "Failed to send sign up link" });
        }
    });

    // Referral lookup by email (uses pending enrollment records)
    router.get("/authentication/referral-lookup/", async (req, res) => {
        try {
            const email = typeof req.query.email === "string" ? req.query.email : "";
            if (!email) {
                return res.status(400).json({ error: "Email is required" });
            }

            const db =
                (res.locals as { databaseAdapter?: any }).databaseAdapter ??
                (req.app as any)?.locals?.databaseAdapter;

            if (!db) {
                elizaLogger.error("Database adapter not available");
                return res.status(500).json({ error: "Database not available" });
            }

            const referral_code = await getPendingReferralCode(db, email);
            res.json({ referral_code });
        } catch (error) {
            elizaLogger.error("Referral lookup error:", error);
            res.status(500).json({ error: "Failed to look up referral code" });
        }
    });

    // Registration completed callback - called by main auth server after successful registration
    router.post("/authentication/registration-completed/", requireAuth, async (req, res) => {
        try {
            const { email, referral_code, user_id } = req.body;

            // Validate required fields
            if (!email) {
                return res.status(400).json({
                    error: "Missing required field: email"
                });
            }

            // Get database adapter from first available agent
            const firstAgent = Array.from(agents.values())[0];
            const db = firstAgent?.databaseAdapter;

            if (!db) {
                elizaLogger.error("Database adapter not available");
                return res.status(500).json({ error: "Database not available" });
            }

            const normalizedEmail = normalizeEmail(email);
            const resolvedUserId =
                typeof user_id === "string" && user_id.trim().length > 0
                    ? (user_id.trim() as UUID)
                    : emailToUserId(normalizedEmail);
            if (!user_id) {
                elizaLogger.info(
                    `ℹ️ registration-completed missing user_id for ${normalizedEmail}, using email-derived id ${resolvedUserId}`
                );
            }
            let effectiveReferralCode = referral_code;
            if (!effectiveReferralCode) {
                effectiveReferralCode = await getPendingReferralCode(db, normalizedEmail);
                if (effectiveReferralCode) {
                    elizaLogger.info(`🔁 Using stored referral code for ${normalizedEmail}: ${effectiveReferralCode}`);
                }
            }

            // Ensure a local account exists so referral code can be generated immediately.
            if (db.mergeDuplicateAccountsByEmail) {
                await db.mergeDuplicateAccountsByEmail(
                    normalizedEmail,
                    emailToUserId(normalizedEmail)
                );
            }
            let account = await db.getAccountByEmail(normalizedEmail);
            if (!account) {
                await db.createAccount({
                    id: resolvedUserId,
                    name: normalizedEmail,
                    username: normalizedEmail,
                    email: normalizedEmail,
                    avatarUrl: null,
                    details: { source: "auth", summary: "" },
                });
                account = await db.getAccountByEmail(normalizedEmail);
            }

            const canonicalUserId = account?.id ?? resolvedUserId;

            // If referral code provided, try to match and create relationship
            if (effectiveReferralCode) {
                // Check if referral code exists in database
                const referrerId = await db.getUserIdByReferralCode(effectiveReferralCode);

                if (referrerId) {
                    // Code found in database - create referral relationship
                    const success = await db.createReferral({
                        referredUserId: canonicalUserId,
                        referralCode: effectiveReferralCode
                    });

                    if (success) {
                        elizaLogger.info(`✅ Referral matched: ${normalizedEmail} referred by code ${effectiveReferralCode}`);
                    } else {
                        elizaLogger.warn(`⚠️ Referral match failed: ${normalizedEmail} with code ${effectiveReferralCode} (may already have a referrer)`);
                    }

                    // Record that this user used a matched referral code
                    await db.recordUserReferralCode({
                        userId: canonicalUserId,
                        referralCodeUsed: effectiveReferralCode,
                        isMatched: success
                    });
                } else {
                    // Code not found - this is a custom referral code
                    elizaLogger.info(`📝 Custom referral code: ${normalizedEmail} registered with code ${effectiveReferralCode} (no match in database)`);

                    // Record the custom referral code
                    await db.recordUserReferralCode({
                        userId: canonicalUserId,
                        referralCodeUsed: effectiveReferralCode,
                        isMatched: false
                    });
                }
            } else {
                elizaLogger.info(`📝 Registration completed: ${normalizedEmail} without referral code`);
            }

            await clearPendingReferrals(db, normalizedEmail);
            res.json({ success: true });
        } catch (error) {
            elizaLogger.error("Registration callback error:", error);
            res.status(500).json({
                error: "Failed to process registration callback"
            });
        }
    });

    // Verify registration token and return email with referral code
    router.get("/authentication/creation/:regToken/", async (req, res) => {
        try {
            const { regToken } = req.params;

            // Forward to main server to get email
            const mainServerUrl = `https://api.sentiedge.ai/api/authentication/creation/${regToken}/`;
            const response = await fetch(mainServerUrl, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                }
            });

            if (!response.ok) {
                return res.status(response.status).json({ error: "Invalid registration link" });
            }

            const data = await response.json();
            const email = data.email;

            const db =
                (res.locals as { databaseAdapter?: any }).databaseAdapter ??
                (req.app as any)?.locals?.databaseAdapter;
            const referral_code = db ? await getPendingReferralCode(db, email) : null;
            if (!db) {
                elizaLogger.error("Database adapter not available for referral lookup");
            }

            elizaLogger.info(`✅ Registration verified: ${email}${referral_code ? ` (ref: ${referral_code})` : ''}`);

            res.json({
                email,
                referral_code
            });
        } catch (error) {
            elizaLogger.error("Registration verification error:", error);
            res.status(500).json({ error: "Failed to verify registration link" });
        }
    });

    router.get("/agents/:agentId", requireAuth, (req, res) => {
        const { agentId } = validateUUIDParams(req.params, res) ?? {
            agentId: null,
        };
        if (!agentId) return;

        const agent = agents.get(agentId);

        if (!agent) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        // Deep-copy so we never mutate the live runtime character object
        const character = JSON.parse(JSON.stringify(agent.character));
        if (character?.settings?.secrets) {
            delete character.settings.secrets;
        }

        res.json({
            id: agent.agentId,
            character,
        });
    });

    router.delete("/agents/:agentId", requireAuth, requireRole("admin"), async (req, res) => {
        if (!isAdminRequest(req)) {
            return res.status(403).json({ error: "Forbidden: admin access required" });
        }
        const { agentId } = validateUUIDParams(req.params, res) ?? {
            agentId: null,
        };
        if (!agentId) return;

        const agent: AgentRuntime = agents.get(agentId);

        if (agent) {
            agent.stop();
            directClient.unregisterAgent(agent);
            res.status(204).json({ success: true });
        } else {
            res.status(404).json({ error: "Agent not found" });
        }
    });

    router.post("/agents/:agentId/set", requireAuth, requireRole("admin"), async (req, res) => {
        if (!isAdminRequest(req)) {
            return res.status(403).json({ error: "Forbidden: admin access required" });
        }
        const { agentId } = validateUUIDParams(req.params, res) ?? {
            agentId: null,
        };
        if (!agentId) return;

        let agent: AgentRuntime = agents.get(agentId);

        // update character
        if (agent) {
            // stop agent
            agent.stop();
            directClient.unregisterAgent(agent);
            // if it has a different name, the agentId will change
        }

        // stores the json data before it is modified with added data
        const characterJson = { ...req.body };

        // load character from body
        const character = req.body;
        try {
            validateCharacterConfig(character);
        } catch (e) {
            elizaLogger.error(`Error parsing character: ${e}`);
            res.status(400).json({
                success: false,
                message: e.message,
            });
            return;
        }

        // start it up (and register it)
        try {
            agent = await directClient.startAgent(character);
            elizaLogger.log(`${character.name} started`);
        } catch (e) {
            elizaLogger.error(`Error starting agent: ${e}`);
            res.status(500).json({
                success: false,
                message: e.message,
            });
            return;
        }

        if (process.env.USE_CHARACTER_STORAGE === "true") {
            try {
                const filename = `${agent.agentId}.json`;
                const uploadDir = path.join(
                    process.cwd(),
                    "data",
                    "characters"
                );
                const filepath = path.join(uploadDir, filename);
                await fs.promises.mkdir(uploadDir, { recursive: true });
                await fs.promises.writeFile(
                    filepath,
                    JSON.stringify(
                        { ...characterJson, id: agent.agentId },
                        null,
                        2
                    )
                );
                elizaLogger.info(
                    `Character stored successfully at ${filepath}`
                );
            } catch (error) {
                elizaLogger.error(
                    `Failed to store character: ${error.message}`
                );
            }
        }

        res.json({
            id: character.id,
            character: character,
        });
    });

    // router.get("/agents/:agentId/channels", async (req, res) => {
    //     const { agentId } = validateUUIDParams(req.params, res) ?? {
    //         agentId: null,
    //     };
    //     if (!agentId) return;

    //     const runtime = agents.get(agentId);

    //     if (!runtime) {
    //         res.status(404).json({ error: "Runtime not found" });
    //         return;
    //     }

    //     const API_TOKEN = runtime.getSetting("DISCORD_API_TOKEN") as string;
    //     const rest = new REST({ version: "10" }).setToken(API_TOKEN);

    //     try {
    //         const guilds = (await rest.get(Routes.userGuilds())) as Array<any>;

    //         res.json({
    //             id: runtime.agentId,
    //             guilds: guilds,
    //             serverCount: guilds.length,
    //         });
    //     } catch (error) {
    //         console.error("Error fetching guilds:", error);
    //         res.status(500).json({ error: "Failed to fetch guilds" });
    //     }
    // });

    router.get("/agents/:agentId/:roomId/memories", authMiddleware, async (req, res) => {
        const { agentId, roomId } = validateUUIDParams(req.params, res) ?? {
            agentId: null,
            roomId: null,
        };
        if (!agentId || !roomId) return;

        let runtime = agents.get(agentId);

        // if runtime is null, look for runtime with the same name
        if (!runtime) {
            runtime = Array.from(agents.values()).find(
                (a) => a.character.name.toLowerCase() === agentId.toLowerCase()
            );
        }

        if (!runtime) {
            res.status(404).send("Agent not found");
            return;
        }

        try {
            const requestUserInfo = (req as any).userInfo ?? getUserInfo(req);
            let requestUserId: UUID = (req as any).userId ?? getUserId(req);

            if (!requestUserInfo || !requestUserId) {
                res.status(401).json({ error: "Authentication required" });
                return;
            }

            // Rooms are created using the DB account UUID (resolveAuthenticatedUserId in index.ts).
            // getUserId() derives a UUID from email/IP and does NOT match the DB UUID.
            // Look up the real account ID so the participant check passes for authenticated users.
            if (requestUserInfo.type === 'authenticated' && requestUserInfo.email) {
                try {
                    const account = await runtime.databaseAdapter.getAccountByEmail(
                        requestUserInfo.email.toLowerCase().trim()
                    );
                    if (account?.id) {
                        requestUserId = account.id as UUID;
                    }
                } catch {
                    // fall back to derived UUID
                }
            }

            if (requestUserInfo.type === 'anonymous') {
                await cleanupAnonymousHistoryIfExpired({ runtime, userId: requestUserId });
            }

            const participantRoomIds = await runtime.databaseAdapter.getRoomsForParticipant(
                requestUserId,
                runtime.agentId,
            );

            if (!participantRoomIds.includes(roomId)) {
                res.status(403).json({ error: "Access to this room is not permitted" });
                return;
            }
            // FIXED: Include both unique and non-unique messages for complete conversation history
            // Issue: User messages were being filtered out due to embedding similarity detection
            // User messages with similar content were marked as non-unique (unique=0) but the default
            // query only returned unique messages (unique=1), causing incomplete user message history
            const limitParam = req.query.limit !== undefined ? Number.parseInt(req.query.limit as string, 10) : null;
            const isPaginated = limitParam !== null && !isNaN(limitParam) && limitParam > 0;
            const pageSize = isPaginated ? Math.min(limitParam, 200) : null;
            const beforeTs = req.query.before ? Number(req.query.before as string) : undefined;

            // Kick off the agent's S3 chart-index lookup in parallel with the
            // DB fetch so the index is hot by the time per-memory chart-path
            // resolution starts. Without this prefetch a fresh ECS task with
            // no local chart cache fired one ListObjectsV2 per chart per
            // memory inside `serializeMemoryForClient`, blowing past the 60 s
            // ALB idle timeout (504) on big rooms. See FileStorageService.getChartIndex.
            const chartIndexWarm = fileStorageService.getChartIndex(agentId).catch(() => undefined);

            const memories = await runtime.messageManager.getMemories({
                roomId,
                unique: false,
                count: isPaginated ? pageSize! + 1 : 200,
                ...(beforeTs ? { end: beforeTs - 1 } : {}),
            });
            // Block on the warm-up before serialization so concurrent memory
            // serialization all read from a hydrated cache.
            await chartIndexWarm;
            // Whitelist serializer — only send fields the frontend actually reads.
            // Whitelist approach prevents large server-side debug fields (originalResultData,
            // executionResults, per-task Memory objects, etc.) from reaching the client
            // regardless of what future code stores in the DB.
            const PER_MESSAGE_BYTE_CAP = 50_000;  // 50 KB per message
            const TOTAL_RESPONSE_BYTE_CAP = 2_000_000; // 2 MB total

            // Per-task action memories are NOT persisted as their own DB rows
            // (taskChainHandler.ts only persists the summary memory). The client
            // recovers per-task messages on page refresh by reading
            // taskChainSnapshot.executionResults — see
            // client/src/components/chat/conversation-utils.ts:getTaskChainActionMessagesFromSnapshot.
            // Keep this whitelist aligned with the fields that helper actually reads.
            const PER_RESULT_TEXT_CAP = 50_000; // 50 KB per task's text

            // Strip stray [ACTION_SUMMARY]…[/ACTION_SUMMARY] envelopes from
            // memory text on the read path. Newer actions strip these at write
            // time, but historical rows saved before that fix still have the
            // envelope embedded — this keeps old messages clean on display.
            const stripActionSummary = (s: string): string =>
                s.replace(/\[ACTION_SUMMARY\][\s\S]*?\[\/ACTION_SUMMARY\][,\s]*/g, '');

            // Translate a local chartPath to an S3 proxy URL when the container's
            // ephemeral filesystem no longer has the file (e.g. after ECS restart).
            const resolveChartPath = async (chartPath: string, memAgentId: string): Promise<string> => {
                if (!chartPath) return chartPath;
                if (chartPath.startsWith('/s3-files/') || chartPath.startsWith('http')) return chartPath;
                const localPath = chartPath.replace(/\\/g, '/');
                const absPath = path.isAbsolute(localPath) ? localPath : path.join(process.cwd(), localPath);
                if (fs.existsSync(absPath)) return chartPath;
                const filename = path.basename(localPath);
                return await fileStorageService.findChartByFilename(memAgentId, filename) ?? chartPath;
            };
            const resolveChartPaths = (paths: string[], memAgentId: string): Promise<string[]> =>
                Promise.all(paths.map(p => resolveChartPath(p, memAgentId)));

            const serializeTaskResultMemory = async (mem: any) => {
                if (!mem || typeof mem !== 'object') return undefined;
                const content = mem.content ?? {};
                const rawText = typeof content.text === 'string'
                    ? stripActionSummary(content.text)
                    : '';
                const text = rawText.length > PER_RESULT_TEXT_CAP
                    ? rawText.slice(0, PER_RESULT_TEXT_CAP) + '\n…[truncated]'
                    : rawText;
                const meta = content.metadata ?? {};
                return {
                    id: mem.id,
                    userId: mem.userId,
                    agentId: mem.agentId,
                    roomId: mem.roomId,
                    createdAt: mem.createdAt,
                    content: {
                        text,
                        source: content.source,
                        action: content.action,
                        ...(content.actionData !== undefined ? { actionData: { images: content.actionData?.images } } : {}),
                        metadata: {
                            ...(meta.taskId !== undefined ? { taskId: meta.taskId } : {}),
                            ...(meta.taskName !== undefined ? { taskName: meta.taskName } : {}),
                            ...(meta.actionName !== undefined ? { actionName: meta.actionName } : {}),
                            ...(meta.success !== undefined ? { success: meta.success } : {}),
                            ...(meta.isActionResponse !== undefined ? { isActionResponse: meta.isActionResponse } : {}),
                            ...(meta.chartPath !== undefined ? { chartPath: await resolveChartPath(meta.chartPath, mem.agentId ?? agentId) } : {}),
                            ...(meta.chartPaths !== undefined ? { chartPaths: await resolveChartPaths(meta.chartPaths, mem.agentId ?? agentId) } : {}),
                            ...(meta.actionData !== undefined ? { actionData: meta.actionData } : {}),
                        },
                    },
                };
            };

            const serializeTaskChainSnapshot = async (snapshot: any) => {
                if (!snapshot) return undefined;
                const tasks = Array.isArray(snapshot.taskChainData?.tasks)
                    ? snapshot.taskChainData.tasks.map((t: any) => ({
                        id: t.id,
                        name: t.name,
                        description: t.description,
                        type: t.type,
                        status: t.status,
                        dependencies: t.dependencies,
                        hasResult: t.hasResult,
                        isSuccess: t.isSuccess,
                        startTime: t.startTime,
                        endTime: t.endTime,
                        error: t.error,
                        parameters: t.parameters,
                    }))
                    : undefined;

                /** Slim per-task output for exports + post-refresh UI (full Memory objects stay server-side). */
                const MAX_EXEC_SUMMARIES = 36;
                const MAX_TEXT_PER_TASK = 30_000;
                const executionResultSummaries = Array.isArray(snapshot.executionResults)
                    ? (await Promise.all(
                          snapshot.executionResults
                              .slice(0, MAX_EXEC_SUMMARIES)
                              .map(async (r: any) => {
                                  const mem = r?.result;
                                  let resultText = "";
                                  if (mem && typeof mem === "object") {
                                      const raw = mem.content ?? {};
                                      const t = raw.text;
                                      if (typeof t === "string") {
                                          resultText = t;
                                      } else if (t && typeof t === "object" && typeof (t as { text?: string }).text === "string") {
                                          resultText = (t as { text: string }).text;
                                      }
                                  }
                                  resultText = stripActionSummary(resultText);
                                  if (resultText.length > MAX_TEXT_PER_TASK) {
                                      resultText = `${resultText.slice(0, MAX_TEXT_PER_TASK)}\n…[truncated]`;
                                  }
                                  const taskId = r?.taskId !== undefined && r?.taskId !== null ? String(r.taskId) : "";
                                  // Per-task chart references — without these the
                                  // post-refresh synthetic message has no chartPath
                                  // and <ChartEmbed> never mounts. Client picks
                                  // these up in messagesFromTaskChainSnapshot.
                                  const resultMeta = (mem && typeof mem === "object" ? mem.content?.metadata : undefined) ?? {};
                                  const memAgentId = mem?.agentId ?? agentId;
                                  const chartPath = typeof resultMeta.chartPath === "string"
                                      ? await resolveChartPath(resultMeta.chartPath, memAgentId)
                                      : undefined;
                                  const chartPaths = Array.isArray(resultMeta.chartPaths) && resultMeta.chartPaths.length > 0
                                      ? await resolveChartPaths(resultMeta.chartPaths, memAgentId)
                                      : undefined;
                                  return {
                                      taskId,
                                      taskName: typeof r?.taskName === "string" ? r.taskName : "",
                                      status: typeof r?.status === "string" ? r.status : "",
                                      resultId: typeof mem?.id === "string" ? mem.id : undefined,
                                      createdAt: typeof mem?.createdAt === "number" ? mem.createdAt : undefined,
                                      resultText,
                                      ...(chartPath ? { chartPath } : {}),
                                      ...(chartPaths && chartPaths.length > 0 ? { chartPaths } : {}),
                                  };
                              })
                      )).filter((x: { taskId: string; resultText: string }) => x.taskId.length > 0 && x.resultText.trim().length > 0)
                    : undefined;

                return {
                    ...(snapshot.taskChainData ? {
                        taskChainData: {
                            id: snapshot.taskChainData.id,
                            name: snapshot.taskChainData.name,
                            description: snapshot.taskChainData.description,
                            originalRequest: snapshot.taskChainData.originalRequest,
                            ...(tasks ? { tasks } : {}),
                        }
                    } : {}),
                    completionInfo: snapshot.completionInfo,
                    title: snapshot.title,
                    createdAt: snapshot.createdAt,
                    ...(executionResultSummaries && executionResultSummaries.length > 0 ? { executionResultSummaries } : {}),
                    // executionResults (full Memory objects) intentionally omitted — see executionResultSummaries
                };
            };

            /** Slim comprehensive action rows for exports + UI (full actionResults omitted from API). */
            const serializeComprehensiveSnapshot = async (snap: any, memAgentId: string) => {
                if (!snap || typeof snap !== "object") return undefined;
                const raw = Array.isArray(snap.actionResults) ? snap.actionResults : [];
                const MAX_ITEMS = 40;
                const MAX_TEXT = 30_000;
                const clip = (t: string) => {
                    const stripped = stripActionSummary(t);
                    return stripped.length > MAX_TEXT ? `${stripped.slice(0, MAX_TEXT)}\n…[truncated]` : stripped;
                };
                // Preserve every snapshot row even when content is empty:
                // ComprehensiveActionTab counts `actionResults.length` for its
                // "X actions • X completed" subtitle and "X/Y" badge. Dropping
                // empty rows here previously made a successful 13-step run
                // appear as "12 actions • 12 completed" if any tool returned
                // an empty body. Use a placeholder so the row count is honest
                // about what ran.
                const actionResultSummaries = await Promise.all(
                    raw
                        .slice(0, MAX_ITEMS)
                        .map(async (item: any) => {
                            const content = typeof item.content === "string" ? item.content : "";
                            const summary = typeof item.summary === "string" ? item.summary : "";
                            const primary = content.trim().length > 0 ? content : summary;
                            const secondary =
                                summary.trim().length > 0 && summary.trim() !== primary.trim() ? summary : "";
                            // Per-action chart references — without these, after refresh
                            // getComprehensiveAnalysisData prefers the slim snapshot over
                            // the per-action memories, the synthetic message has no
                            // chartPath, <ChartEmbed> never mounts, and no /s3-files/
                            // request fires for that action's chart. Sibling pattern of
                            // executionResultSummaries fix in serializeTaskChainSnapshot.
                            const itemMeta = (item.message?.metadata ?? {}) as Record<string, unknown>;
                            const chartPath = typeof itemMeta.chartPath === "string"
                                ? await resolveChartPath(itemMeta.chartPath, memAgentId)
                                : undefined;
                            const chartPaths = Array.isArray(itemMeta.chartPaths) && (itemMeta.chartPaths as unknown[]).length > 0
                                ? await resolveChartPaths(itemMeta.chartPaths as string[], memAgentId)
                                : undefined;
                            // Report open button (writing_report row) reads relativePath /
                            // reportPath / reportUrl from action.message.metadata. Without
                            // these fields the slim snapshot synthesizes rows with charts
                            // but no PDF/HTML link after refresh — attachComprehensiveReportRowIfNeeded
                            // also skips because a writing_report row already exists from summaries.
                            const relativePath =
                                typeof itemMeta.relativePath === "string" &&
                                itemMeta.relativePath.trim().length > 0
                                    ? itemMeta.relativePath
                                    : undefined;
                            const reportPath =
                                typeof itemMeta.reportPath === "string" &&
                                itemMeta.reportPath.trim().length > 0
                                    ? itemMeta.reportPath
                                    : undefined;
                            const reportUrl =
                                typeof itemMeta.reportUrl === "string" &&
                                itemMeta.reportUrl.trim().length > 0
                                    ? itemMeta.reportUrl
                                    : undefined;
                            const executiveSummary =
                                typeof itemMeta.executiveSummary === "string" &&
                                itemMeta.executiveSummary.trim().length > 0
                                    ? itemMeta.executiveSummary.trim().length > MAX_TEXT
                                        ? `${itemMeta.executiveSummary.trim().slice(0, MAX_TEXT)}\n…[truncated]`
                                        : itemMeta.executiveSummary.trim()
                                    : undefined;
                            const action = typeof item.action === "string" ? item.action : "";
                            const fallbackText = action ? `${action} completed` : "Action completed";
                            const contentText = primary.trim().length > 0 ? clip(primary) : fallbackText;
                            return {
                                phase: typeof item.phase === "string" ? item.phase : "",
                                action,
                                status: item.status,
                                contentText,
                                summary: secondary.trim().length > 0 ? clip(secondary) : "",
                                messageId:
                                    item.message?.id !== undefined && item.message?.id !== null
                                        ? String(item.message.id)
                                        : undefined,
                                createdAt: typeof item.message?.createdAt === "number" ? item.message.createdAt : undefined,
                                ...(chartPath ? { chartPath } : {}),
                                ...(chartPaths && chartPaths.length > 0 ? { chartPaths } : {}),
                                ...(relativePath ? { relativePath } : {}),
                                ...(reportPath ? { reportPath } : {}),
                                ...(reportUrl ? { reportUrl } : {}),
                                ...(executiveSummary ? { executiveSummary } : {}),
                            };
                        })
                );

                return {
                    ...(typeof snap.title === "string" ? { title: snap.title } : {}),
                    ...(typeof snap.createdAt === "number" ? { createdAt: snap.createdAt } : {}),
                    ...(snap.progressInfo ? { progressInfo: snap.progressInfo } : {}),
                    ...(actionResultSummaries.length > 0 ? { actionResultSummaries } : {}),
                };
            };

            const serializeMetadata = async (meta: any, memAgentId: string) => {
                if (!meta) return undefined;
                return {
                    // Chart / report paths — used for chart panel display
                    ...(meta.chartPath !== undefined ? { chartPath: await resolveChartPath(meta.chartPath, memAgentId) } : {}),
                    ...(meta.chartPaths !== undefined ? { chartPaths: await resolveChartPaths(meta.chartPaths, memAgentId) } : {}),
                    ...(meta.reportUrl !== undefined ? { reportUrl: meta.reportUrl } : {}),
                    ...(meta.relativePath !== undefined ? { relativePath: meta.relativePath } : {}),
                    ...(meta.reportPath !== undefined ? { reportPath: meta.reportPath } : {}),
                    ...(meta.reportPaths !== undefined ? { reportPaths: meta.reportPaths } : {}),
                    // Task chain action fields
                    ...(meta.actionName !== undefined ? { actionName: meta.actionName } : {}),
                    ...(meta.taskId !== undefined ? { taskId: meta.taskId } : {}),
                    ...(meta.taskName !== undefined ? { taskName: meta.taskName } : {}),
                    ...(meta.success !== undefined ? { success: meta.success } : {}),
                    ...(meta.isActionResponse !== undefined ? { isActionResponse: meta.isActionResponse } : {}),
                    ...(meta.phase !== undefined ? { phase: meta.phase } : {}),
                    ...(meta.summary !== undefined ? { summary: meta.summary } : {}),
                    ...(meta.executiveSummary !== undefined &&
                    typeof meta.executiveSummary === "string" &&
                    meta.executiveSummary.trim().length > 0
                        ? { executiveSummary: meta.executiveSummary.trim() }
                        : {}),
                    ...(meta.duplicateOptimization !== undefined ? { duplicateOptimization: meta.duplicateOptimization } : {}),
                    ...(meta.duplicatesRemoved !== undefined ? { duplicatesRemoved: meta.duplicatesRemoved } : {}),
                    // Favorites
                    ...(meta.favoriteTaskChain !== undefined ? { favoriteTaskChain: meta.favoriteTaskChain } : {}),
                    // Task chain graph data (summary messages)
                    ...(meta.taskChainSnapshot !== undefined ? { taskChainSnapshot: await serializeTaskChainSnapshot(meta.taskChainSnapshot) } : {}),
                    // taskChain field (for hasTaskChainData check in conversation-utils)
                    ...(meta.taskChain !== undefined ? { taskChain: meta.taskChain } : {}),
                    // Comprehensive analysis (slim summaries — full actionResults stay server-side)
                    ...(meta.comprehensiveSnapshot !== undefined
                        ? { comprehensiveSnapshot: await serializeComprehensiveSnapshot(meta.comprehensiveSnapshot, memAgentId) }
                        : {}),
                    // actionData in metadata (used for image display in action results)
                    ...(meta.actionData !== undefined ? { actionData: meta.actionData } : {}),
                    // Mantle on-chain execution (MantleExecutionLinks in chat UI)
                    ...(meta.classification !== undefined
                        ? { classification: meta.classification }
                        : {}),
                    ...(typeof meta.chainId === "number" ? { chainId: meta.chainId } : {}),
                    ...(typeof meta.txHash === "string" ? { txHash: meta.txHash } : {}),
                    ...(typeof meta.explorerUrl === "string"
                        ? { explorerUrl: meta.explorerUrl }
                        : {}),
                    ...(typeof meta.auditTxHash === "string"
                        ? { auditTxHash: meta.auditTxHash }
                        : {}),
                    ...(typeof meta.intentHash === "string"
                        ? { intentHash: meta.intentHash }
                        : {}),
                    ...(meta.mantleExecution === true
                        ? { mantleExecution: true }
                        : {}),
                    ...(meta.pending === true ? { pending: true } : {}),
                    ...(meta.cancelled === true ? { cancelled: true } : {}),
                    ...(meta.noPending === true ? { noPending: true } : {}),
                    ...(meta.risk && typeof meta.risk === "object"
                        ? {
                              risk: {
                                  verdict: (meta.risk as { verdict?: unknown }).verdict,
                                  rulesFired: (meta.risk as { rulesFired?: unknown })
                                      .rulesFired,
                              },
                          }
                        : {}),
                };
            };

            const serializeMemoryForClient = async (memory: any) => {
                // Normalize: old DB rows store content as a JSON string
                let raw: any = memory.content ?? {};
                if (typeof raw === 'string') {
                    try { raw = JSON.parse(raw); } catch {}
                }
                // Normalize: old DB rows store content.text as a JSON string {text, source, metadata, ...}
                if (raw && typeof raw.text === 'string') {
                    try {
                        const parsed = JSON.parse(raw.text);
                        if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') {
                            raw = { ...parsed, ...raw, text: parsed.text };
                        }
                    } catch {}
                }
                const text = (() => {
                    const t = raw.text;
                    let extracted: string;
                    if (t === null || t === undefined) extracted = '';
                    else if (typeof t === 'object') extracted = typeof t.text === 'string' ? t.text : JSON.stringify(t);
                    else extracted = String(t);
                    return stripActionSummary(extracted);
                })();

                const serialized = {
                    id: memory.id,
                    userId: memory.userId,
                    agentId: memory.agentId,
                    roomId: memory.roomId,
                    createdAt: memory.createdAt,
                    unique: memory.unique,
                    content: {
                        text,
                        source: raw.source,
                        action: raw.action,
                        url: raw.url,
                        inReplyTo: raw.inReplyTo,
                        // Content-level chart/visualization fields
                        ...(raw.chartPath !== undefined ? { chartPath: await resolveChartPath(raw.chartPath, memory.agentId ?? agentId) } : {}),
                        ...(raw.visualizations !== undefined ? { visualizations: raw.visualizations } : {}),
                        // Favorites attachment
                        ...(raw.favoriteTaskChain !== undefined ? { favoriteTaskChain: raw.favoriteTaskChain } : {}),
                        // Action data images (for action result image panels)
                        ...(raw.actionData !== undefined ? { actionData: { images: raw.actionData?.images } } : {}),
                        // actionResults array (comprehensive analysis)
                        ...(raw.actionResults !== undefined ? { actionResults: raw.actionResults } : {}),
                        // Attachments (user file uploads, images)
                        ...(raw.attachments ? {
                            attachments: raw.attachments.map((a: any) => ({
                                id: a.id,
                                url: a.url,
                                title: a.title,
                                source: a.source,
                                description: a.description,
                                text: a.text,
                                contentType: a.contentType,
                            }))
                        } : {}),
                        metadata: await serializeMetadata(raw.metadata, memory.agentId ?? agentId),
                    },
                };

                // Per-message size cap: when over the envelope, drop large
                // auxiliary fields first (actionResults / actionData /
                // attachments) before falling back to truncating the
                // user-visible text. The chat-visible body is the most
                // important thing to preserve; everything else can be
                // re-fetched via dedicated endpoints if the UI needs it.
                let bytes = JSON.stringify(serialized).length;
                if (bytes > PER_MESSAGE_BYTE_CAP) {
                    const contentRef = serialized.content as Record<string, unknown>;
                    if (contentRef.actionResults !== undefined) {
                        delete contentRef.actionResults;
                        bytes = JSON.stringify(serialized).length;
                    }
                    if (bytes > PER_MESSAGE_BYTE_CAP && contentRef.actionData !== undefined) {
                        delete contentRef.actionData;
                        bytes = JSON.stringify(serialized).length;
                    }
                    if (bytes > PER_MESSAGE_BYTE_CAP && contentRef.attachments !== undefined) {
                        delete contentRef.attachments;
                        bytes = JSON.stringify(serialized).length;
                    }
                    if (bytes > PER_MESSAGE_BYTE_CAP && serialized.content.text.length > 500) {
                        const overhead = bytes - serialized.content.text.length;
                        const allowedText = Math.max(500, PER_MESSAGE_BYTE_CAP - overhead);
                        serialized.content.text = serialized.content.text.slice(0, allowedText) + '\n…[truncated]';
                    }
                }

                return serialized;
            };

            const serializedMemories = await Promise.all(memories.map(serializeMemoryForClient));

            if (isPaginated) {
                // Adapter returns desc (newest first). Check hasMore then reverse to oldest-first.
                const hasMore = serializedMemories.length > pageSize!;
                if (hasMore) serializedMemories.pop(); // drop extra oldest item
                serializedMemories.reverse();
                const oldestId = serializedMemories.length > 0 ? String(serializedMemories[0].createdAt) : undefined;
                elizaLogger.info(`[memories API] roomId=${roomId} messages=${serializedMemories.length} paginated hasMore=${hasMore}`);
                res.json({ messages: serializedMemories, hasMore, oldestId });
            } else {
                // Total response size cap: drop oldest messages if over 2 MB
                let totalBytes = JSON.stringify(serializedMemories).length;
                while (totalBytes > TOTAL_RESPONSE_BYTE_CAP && serializedMemories.length > 1) {
                    serializedMemories.shift();
                    totalBytes = JSON.stringify(serializedMemories).length;
                }
                elizaLogger.info(`[memories API] roomId=${roomId} messages=${serializedMemories.length} totalBytes=${totalBytes}`);
                res.json({ agentId, roomId, memories: serializedMemories });
            }
        } catch (error) {
            console.error("Error fetching memories:", error);
            res.status(500).json({ error: "Failed to fetch memories" });
        }
    });

    /**
     * Per-room "is anything still running?" probe used by the chat client at
     * mount time to rehydrate the Stop button across page refresh.
     *
     * Response:
     *   { active: false }                                          — nothing in flight
     *   { active: true, kind: "comprehensive" | "task_chain" | "cex", startedAt: number }
     *
     * Notes:
     *   - Uses `authMiddleware` (matches the memories route style and works
     *     for both authenticated and anonymous users).
     *   - The comprehensive analysis check is per-user (one slot per user),
     *     not per-room — that matches the in-flight tracking inside the
     *     workflow graph. The approval check is per-room.
     */
    router.get("/agents/:agentId/:roomId/active-workflow", authMiddleware, async (req, res) => {
        const { agentId, roomId } = validateUUIDParams(req.params, res) ?? {
            agentId: null,
            roomId: null,
        };
        if (!agentId || !roomId) return;

        const runtime = agents.get(agentId);
        if (!runtime) {
            return res.status(404).json({ active: false, error: "agent_not_found" });
        }

        const requestUserInfo = (req as any).userInfo ?? getUserInfo(req);
        let requestUserId: UUID | null = ((req as any).userId ?? getUserId(req)) ?? null;

        // Match the participant-aware userId derivation that the memories
        // route uses, so the comprehensive check finds the user's actual
        // in-flight slot (which is keyed by the DB account UUID).
        if (requestUserInfo?.type === "authenticated" && requestUserInfo.email) {
            try {
                const account = await runtime.databaseAdapter.getAccountByEmail(
                    requestUserInfo.email.toLowerCase().trim()
                );
                if (account?.id) {
                    requestUserId = account.id as UUID;
                }
            } catch {
                // Fall back to derived UUID — non-fatal for this probe.
            }
        }

        if (requestUserId) {
            const comp = isComprehensiveAnalysisInProgress(requestUserId);
            if (comp.active) {
                return res.json({
                    active: true,
                    kind: "comprehensive",
                    startedAt: comp.startedAt,
                });
            }
        }

        const approval = getPendingApprovalForRoom(runtime, roomId);
        if (approval) {
            return res.json({
                active: true,
                kind: approval.kind,
                startedAt: approval.startedAt,
            });
        }

        return res.json({ active: false });
    });

    /**
     * Order-editor refresh route: returns the user's Avbl/Max/feeBps for
     * the chosen pair. Called from `TradingOrderEditor` whenever the user
     * changes Pair in-modal so the displayed asset/balances stay in sync
     * with `product_id`. Authoritatively re-derives `baseAsset` /
     * `quoteAsset` from the query so the client cannot show a stale
     * snapshot tied to the LLM's original pair.
     */
    router.get("/agents/:agentId/cex/account-snapshot", authMiddleware, async (req, res) => {
        const { agentId } = validateUUIDParams(req.params, res) ?? { agentId: null };
        if (!agentId) return;

        const runtime = agents.get(agentId);
        if (!runtime) {
            return res.status(404).json({ error: "agent_not_found" });
        }

        const venueRaw = typeof req.query.venue === "string" ? req.query.venue : "";
        const baseRaw = typeof req.query.base === "string" ? req.query.base : "";
        const quoteRaw = typeof req.query.quote === "string" ? req.query.quote : "";
        const venue = venueRaw.trim().toLowerCase();
        const base = baseRaw.trim().toUpperCase();
        const quote = quoteRaw.trim().toUpperCase();
        if (!venue || !base || !quote) {
            return res.status(400).json({ error: "venue, base, quote are required" });
        }

        const provider = getCEXSpecProvider(runtime);
        if (typeof provider?.fetchAccountSnapshot !== "function") {
            return res.status(503).json({ error: "snapshot_unavailable" });
        }

        // Resolve userId the same way the memories / active-workflow routes
        // do — participants-table lookup for authenticated users so the
        // venue credentials match the user's account, not a derived UUID.
        const requestUserInfo = (req as any).userInfo ?? getUserInfo(req);
        let requestUserId: UUID | null = ((req as any).userId ?? getUserId(req)) ?? null;
        if (requestUserInfo?.type === "authenticated" && requestUserInfo.email) {
            try {
                const account = await runtime.databaseAdapter.getAccountByEmail(
                    requestUserInfo.email.toLowerCase().trim()
                );
                if (account?.id) requestUserId = account.id as UUID;
            } catch {
                // Non-fatal — fall back to derived UUID.
            }
        }
        if (!requestUserId) {
            return res.status(401).json({ error: "unauthorized" });
        }

        try {
            const snapshot = await provider.fetchAccountSnapshot({
                runtime,
                userId: requestUserId,
                venue,
                baseAsset: base,
                quoteAsset: quote,
            });
            if (!snapshot) {
                return res.status(503).json({ error: "snapshot_unavailable" });
            }
            return res.json({ snapshot });
        } catch (err) {
            elizaLogger.warn(
                `[api] /cex/account-snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            return res.status(500).json({ error: "snapshot_failed" });
        }
    });

    /**
     * F10.3 — live market-snapshot refresh route. Wraps
     * `buildMarketSnapshot()` from `@elizaos/core` and returns the same
     * `{ market_snapshot?, symbol_verification }` shape the approval
     * modal SSE already carries. The compose dialog + the approval
     * modal poll this every 5 s via `useMarketSnapshot` so bid / ask /
     * spread / 24 h stats / depth / est-fill / slippage stay live while
     * the user is reviewing the order.
     *
     * Auth is the same JWT pattern as `/cex/account-snapshot`; the
     * userId is resolved authoritatively from the participants table.
     * Public Binance/Coinbase endpoints don't need user credentials,
     * but auth-gating prevents the route from being a DDoS amplifier.
     */
    /**
     * #6d — Persist a user's in-modal order edits to a pending plan step
     * BEFORE they approve it, so the order that executes (and the result /
     * plan card) reflects exactly what they reviewed. The plan runner's
     * approval continuation ("yes") then runs the EDITED step. Ownership is
     * enforced inside `applyPlanStepEdit` (plan.user_id must match the
     * resolved requester). Non-fatal by design: the client proceeds with
     * the un-edited step if this fails.
     */
    router.post("/agents/:agentId/cex/plan/edit-step", authMiddleware, (req, res) => {
        const { agentId } = validateUUIDParams(req.params, res) ?? { agentId: null };
        if (!agentId) return;
        const userId = (req as any).userId ?? getUserId(req);
        if (!userId) return res.status(401).json({ error: "Authentication required" });
        const body = (req.body ?? {}) as {
            planId?: unknown;
            stepIndex?: unknown;
            parameters?: unknown;
        };
        const planId = typeof body.planId === "string" ? body.planId : "";
        const stepIndex =
            typeof body.stepIndex === "number"
                ? body.stepIndex
                : Number.parseInt(String(body.stepIndex), 10);
        const parameters =
            body.parameters && typeof body.parameters === "object"
                ? (body.parameters as Record<string, unknown>)
                : null;
        if (!planId || !Number.isInteger(stepIndex) || stepIndex < 0 || !parameters) {
            return res
                .status(400)
                .json({ error: "planId, stepIndex (>=0), and parameters are required" });
        }
        const result = applyPlanStepEdit({
            planId,
            ownerUserId: String(userId),
            stepIndex,
            params: parameters,
        });
        if (!result.ok) {
            const code = result.reason === "forbidden" ? 403 : 409;
            return res.status(code).json({ ok: false, reason: result.reason });
        }
        return res.json({ ok: true, applied: result.applied ?? [] });
    });

    router.get("/agents/:agentId/cex/market-snapshot", authMiddleware, async (req, res) => {
        const { agentId } = validateUUIDParams(req.params, res) ?? { agentId: null };
        if (!agentId) return;

        const runtime = agents.get(agentId);
        if (!runtime) {
            return res.status(404).json({ error: "agent_not_found" });
        }

        const symbolRaw = typeof req.query.symbol === "string" ? req.query.symbol : "";
        const symbol = symbolRaw.trim();
        if (!symbol) {
            return res.status(400).json({ error: "symbol is required" });
        }
        const venueRaw = typeof req.query.venue === "string" ? req.query.venue : "";
        const venue = (venueRaw.trim() || "binance").toLowerCase();
        const sideRaw = typeof req.query.side === "string" ? req.query.side : "";
        const side = sideRaw.trim().toUpperCase();
        const limitPriceRaw = typeof req.query.limit_price === "string" ? req.query.limit_price : "";
        const limitPrice = limitPriceRaw.trim();
        const actionNameRaw = typeof req.query.action_name === "string" ? req.query.action_name : "";
        const actionName = actionNameRaw.trim() || "create_order";

        const provider = getCEXSpecProvider(runtime);
        if (!provider?.fetchBookTicker && !provider?.fetchDepth && !provider?.fetch24hStats) {
            return res.status(503).json({ error: "snapshot_unavailable" });
        }

        // Build the actionParams shape `buildMarketSnapshot` expects so
        // est_fill_price + slippage_vs_limit_bps fields get populated
        // for limit-variant orders. Keep it minimal — only the two
        // fields the snapshot builder actually reads (side, limit_price
        // inside an order_configuration variant).
        const actionParams: Record<string, unknown> = {};
        if (side === "BUY" || side === "SELL") actionParams.side = side;
        if (limitPrice) {
            actionParams.order_configuration = {
                limit_limit_gtc: { limit_price: limitPrice },
            };
        }

        try {
            let result = await buildMarketSnapshot({
                provider,
                symbol,
                promptText: "",
                actionParams,
                actionName,
                venue,
            });

            // F10.9 — quote-currency fallback for venues that don't
            // list every stablecoin variant of a pair. Coinbase Spot,
            // for example, lists BTC-USD universally but only BTC-USDC
            // / BTC-USDT for some markets. When the user toggles
            // venue=coinbase but their pair is BTC-USDC (which
            // Coinbase doesn't publish on Spot), we'd otherwise show
            // an empty panel even though Coinbase has the equivalent
            // BTC-USD ticker. Try the obvious stablecoin substitute
            // when the first attempt produced no `market_snapshot`.
            // USDC ↔ USD only; USDT is not a 1:1 substitute and is
            // intentionally not auto-mapped.
            if (!result.market_snapshot) {
                const tryFallback = async (newQuote: string): Promise<typeof result | null> => {
                    const m = symbol.match(/^([A-Z0-9]+)[-/]([A-Z0-9]+)$/i);
                    if (!m) return null;
                    const fallbackSymbol = `${m[1].toUpperCase()}-${newQuote}`;
                    if (fallbackSymbol.toUpperCase() === symbol.toUpperCase()) return null;
                    elizaLogger.info(
                        `[api] /cex/market-snapshot: ${venue} has no data for ${symbol}; retrying with ${fallbackSymbol}`,
                    );
                    const fb = await buildMarketSnapshot({
                        provider,
                        symbol: fallbackSymbol,
                        promptText: "",
                        actionParams,
                        actionName,
                        venue,
                    });
                    if (fb.market_snapshot) {
                        // Preserve the originally-requested symbol in the
                        // user-visible label so the panel doesn't appear
                        // to swap pairs under the user. The bid/ask come
                        // from the fallback pair (which the comment in
                        // the code path documents).
                        fb.market_snapshot = {
                            ...fb.market_snapshot,
                            symbol,
                        };
                        return fb;
                    }
                    return null;
                };
                // USDC → USD (most common Coinbase substitution)
                if (/^[A-Z0-9]+-USDC$/i.test(symbol)) {
                    const fb = await tryFallback("USD");
                    if (fb) result = fb;
                }
                // USD → USDC (rarer, but symmetric)
                else if (/^[A-Z0-9]+-USD$/i.test(symbol)) {
                    const fb = await tryFallback("USDC");
                    if (fb) result = fb;
                }
            }

            // Short HTTP cache hint so React-Query polling stays smooth
            // without piling up duplicate requests when multiple
            // dialogs are open in different tabs.
            res.set("Cache-Control", "private, max-age=2");
            return res.json(result);
        } catch (err) {
            elizaLogger.warn(
                `[api] /cex/market-snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            return res.status(500).json({ error: "snapshot_failed" });
        }
    });

    /**
     * Order-editor Pair combobox: returns a venue's tradable spot
     * products (USDT/USDC/USD-quoted). Public endpoint upstream — no
     * user credentials needed — but the route is still auth-gated to
     * avoid being a free DDoS amplifier.
     */
    router.get("/agents/:agentId/cex/products", authMiddleware, async (req, res) => {
        const { agentId } = validateUUIDParams(req.params, res) ?? { agentId: null };
        if (!agentId) return;

        const runtime = agents.get(agentId);
        if (!runtime) {
            return res.status(404).json({ error: "agent_not_found" });
        }

        const venueRaw = typeof req.query.venue === "string" ? req.query.venue : "";
        const venue = venueRaw.trim().toLowerCase();
        if (!venue) {
            return res.status(400).json({ error: "venue is required" });
        }

        const marginTypeRaw = typeof req.query.marginType === "string" ? req.query.marginType : "";
        const marginType = marginTypeRaw.trim().toLowerCase();
        const marginTypeArg: "cross" | "isolated" | undefined =
            marginType === "cross" || marginType === "isolated" ? marginType : undefined;

        const provider = getCEXSpecProvider(runtime);
        if (typeof provider?.fetchTradableProducts !== "function") {
            return res.status(503).json({ error: "products_unavailable" });
        }

        try {
            const out = await provider.fetchTradableProducts({
                runtime,
                venue,
                marginType: marginTypeArg,
            });
            if (!out) {
                return res.status(503).json({ error: "products_unavailable" });
            }
            // 5-min HTTP cache hint — the plugin already caches 15 min in-process.
            res.set("Cache-Control", "private, max-age=300");
            return res.json(out);
        } catch (err) {
            elizaLogger.warn(
                `[api] /cex/products failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            return res.status(500).json({ error: "products_failed" });
        }
    });

    // router.get("/tee/agents", async (req, res) => {
    //     try {
    //         const allAgents = [];

    //         for (const agentRuntime of agents.values()) {
    //             const teeLogService = agentRuntime
    //                 .getService<TeeLogService>(ServiceType.TEE_LOG)
    //                 .getInstance();

    //             const agents = await teeLogService.getAllAgents();
    //             allAgents.push(...agents);
    //         }

    //         const runtime: AgentRuntime = agents.values().next().value;
    //         const teeLogService = runtime
    //             .getService<TeeLogService>(ServiceType.TEE_LOG)
    //             .getInstance();
    //         const attestation = await teeLogService.generateAttestation(
    //             JSON.stringify(allAgents)
    //         );
    //         res.json({ agents: allAgents, attestation: attestation });
    //     } catch (error) {
    //         elizaLogger.error("Failed to get TEE agents:", error);
    //         res.status(500).json({
    //             error: "Failed to get TEE agents",
    //         });
    //     }
    // });

    // router.get("/tee/agents/:agentId", async (req, res) => {
    //     try {
    //         const agentId = req.params.agentId;
    //         const agentRuntime = agents.get(agentId);
    //         if (!agentRuntime) {
    //             res.status(404).json({ error: "Agent not found" });
    //             return;
    //         }

    //         const teeLogService = agentRuntime
    //             .getService<TeeLogService>(ServiceType.TEE_LOG)
    //             .getInstance();

    //         const teeAgent = await teeLogService.getAgent(agentId);
    //         const attestation = await teeLogService.generateAttestation(
    //             JSON.stringify(teeAgent)
    //         );
    //         res.json({ agent: teeAgent, attestation: attestation });
    //     } catch (error) {
    //         elizaLogger.error("Failed to get TEE agent:", error);
    //         res.status(500).json({
    //             error: "Failed to get TEE agent",
    //         });
    //     }
    // });

    // router.post(
    //     "/tee/logs",
    //     async (req: express.Request, res: express.Response) => {
    //         try {
    //             const query = req.body.query || {};
    //             const page = Number.parseInt(req.body.page) || 1;
    //             const pageSize = Number.parseInt(req.body.pageSize) || 10;

    //             const teeLogQuery: TeeLogQuery = {
    //                 agentId: query.agentId || "",
    //                 roomId: query.roomId || "",
    //                 userId: query.userId || "",
    //                 type: query.type || "",
    //                 containsContent: query.containsContent || "",
    //                 startTimestamp: query.startTimestamp || undefined,
    //                 endTimestamp: query.endTimestamp || undefined,
    //             };
    //             const agentRuntime: AgentRuntime = agents.values().next().value;
    //             const teeLogService = agentRuntime
    //                 .getService<TeeLogService>(ServiceType.TEE_LOG)
    //                 .getInstance();
    //             const pageQuery = await teeLogService.getLogs(
    //                 teeLogQuery,
    //                 page,
    //                 pageSize
    //             );
    //             const attestation = await teeLogService.generateAttestation(
    //                 JSON.stringify(pageQuery)
    //             );
    //             res.json({
    //                 logs: pageQuery,
    //                 attestation: attestation,
    //             });
    //         } catch (error) {
    //             elizaLogger.error("Failed to get TEE logs:", error);
    //             res.status(500).json({
    //                 error: "Failed to get TEE logs",
    //             });
    //         }
    //     }
    // );

    router.post("/agent/start", requireAuth, async (req, res) => {
        const { characterPath, characterJson } = req.body;
        try {
            let character: Character;
            if (characterJson) {
                character = await directClient.jsonToCharacter(
                    characterPath,
                    characterJson
                );
            } else if (characterPath) {
                // H1: Restrict characterPath to prevent arbitrary file read
                const safeCharDir = path.resolve(process.cwd(), "characters");
                const resolvedChar = path.resolve(safeCharDir, path.basename(String(characterPath)));
                if (!resolvedChar.startsWith(safeCharDir + path.sep) && resolvedChar !== safeCharDir) {
                    return res.status(400).json({ error: "Invalid character path" });
                }
                character =
                    await directClient.loadCharacterTryPath(resolvedChar);
            } else {
                throw new Error("No character path or JSON provided");
            }
            await directClient.startAgent(character);
            elizaLogger.log(`${character.name} started`);

            // Never expose settings.secrets to the client
            const safeCharacter = JSON.parse(JSON.stringify(character));
            if (safeCharacter?.settings?.secrets) { delete safeCharacter.settings.secrets; }
            res.json({
                id: character.id,
                character: safeCharacter,
            });
        } catch (e) {
            elizaLogger.error(`Error parsing character: ${e}`);
            res.status(400).json({
                error: e.message,
            });
            return;
        }
    });

    router.post("/agents/:agentId/stop", requireAuth, async (req, res) => {
        const agentId = req.params.agentId;
        
        try {
            const agent: AgentRuntime = agents.get(agentId);

            if (agent) {
                // Stop current processing instead of the entire agent
                agent.stopProcessing();
                elizaLogger.info(`🛑 Processing stopped for agent ${agentId} (${agent.character.name})`);
                
                res.json({ 
                    success: true, 
                    message: "Processing stopped successfully" 
                });
            } else {
                elizaLogger.warn(`🛑 Stop requested for unknown agent: ${agentId}`);
                res.status(404).json({ 
                    success: false,
                    error: "Agent not found" 
                });
            }
        } catch (error) {
            elizaLogger.error("🛑 Error stopping processing:", error);
            res.status(500).json({ 
                success: false,
                error: "Failed to stop processing",
                message: error instanceof Error ? error.message : "Unknown error"
            });
        }
    });

    // Task chain approval endpoint for human-in-the-loop
    router.post(
        "/agents/:agentId/task-chain/approval",
        isPublicAccessModeActive() ? authMiddleware : requireAuth,
        async (req, res) => {
        const { agentId } = validateUUIDParams(req.params, res) ?? {
            agentId: null,
        };
        if (!agentId) return;

        const agent = agents.get(agentId);
        if (!agent) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        try {
            const { threadId, decision, feedback, taskChain, message, state } = req.body;

            // Validate required parameters
            if (!threadId || typeof threadId !== "string") {
                res.status(400).json({ error: "threadId is required and must be a string" });
                return;
            }

            if (!decision || (decision !== "approved" && decision !== "rejected")) {
                res.status(400).json({ error: "decision is required and must be 'approved' or 'rejected'" });
                return;
            }

            if (!taskChain || typeof taskChain !== "object") {
                res.status(400).json({ error: "taskChain is required" });
                return;
            }

            // Get the task chain planner from the agent
            const planner = agent.taskChainPlanner;
            if (!planner || typeof planner.resumeWithApproval !== "function") {
                elizaLogger.error("Task chain planner not available or doesn't support resumeWithApproval");
                res.status(500).json({
                    error: "Task chain approval not supported for this agent",
                    details: "Agent does not have a compatible task chain planner"
                });
                return;
            }

            elizaLogger.info(`Processing task chain approval: threadId=${threadId}, decision=${decision}`);

            const agentWithApprovals = agent as AgentRuntime & {
                __pendingApprovals?: Map<string, {
                    agentId: UUID;
                    resolve?: (payload: { decision: 'approved' | 'rejected'; feedback?: string; taskChain: TaskChain }) => void;
                }>;
            };

            const pendingApprovalContext = agentWithApprovals.__pendingApprovals?.get(threadId);
            const approvalDecision: { decision: 'approved' | 'rejected'; feedback?: string } = {
                decision: decision as 'approved' | 'rejected',
                feedback: feedback || ''
            };
            const approvedChain = taskChain as TaskChain;

            if (pendingApprovalContext && pendingApprovalContext.agentId === agentId && typeof pendingApprovalContext.resolve === 'function') {
                elizaLogger.info(`Resolving pending approval for thread ${threadId}`);
                pendingApprovalContext.resolve({
                    decision: approvalDecision.decision,
                    feedback: approvalDecision.feedback,
                    taskChain: approvedChain
                });

                const responseMessage = approvalDecision.decision === 'approved'
                    ? "Task chain approved. Execution will resume on the existing stream."
                    : "Task chain feedback received. Regenerating proposal.";

                res.json({
                    success: true,
                    message: responseMessage,
                    chainId: approvedChain.id,
                    chainName: approvedChain.name,
                    executing: approvalDecision.decision === 'approved'
                });
                return;
            }

            elizaLogger.warn(`Pending approval context not found for thread ${threadId}. Falling back to direct resume.`);

            const updatedChain = await planner.resumeWithApproval(threadId, approvalDecision, approvedChain);

            elizaLogger.info(`Task chain approval processed successfully via fallback: ${updatedChain.name}`);

            if (decision === 'approved') {
                res.json({
                    success: true,
                    message: "Task chain approved (execution context not available)",
                    chainId: updatedChain.id,
                    chainName: updatedChain.name
                });
            } else {
                res.json({
                    success: true,
                    message: `Task chain ${decision}`,
                    chainId: updatedChain.id,
                    chainName: updatedChain.name
                });
            }

        } catch (error: any) {
            // Check if this is another interrupt (for regeneration)
            if (error.message === 'WORKFLOW_INTERRUPTED_FOR_APPROVAL') {
                elizaLogger.info('Task chain regenerated, awaiting new approval');
                res.json({
                    success: true,
                    message: "Task chain regenerated, awaiting new approval",
                    regenerated: true
                });
                return;
            }

            elizaLogger.error("Error processing task chain approval:", error);
            res.status(500).json({
                error: "Failed to process task chain approval",
                details: error.message
            });
        }
    });
    
    router.get("/agents/:agentId/favorite-taskchains", authMiddleware, async (req, res) => {
        const { agentId } = validateUUIDParams(req.params, res) ?? {
            agentId: null,
        };
        if (!agentId) return;

        const runtime = agents.get(agentId);
        if (!runtime) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        const userId = (req as any).userId;
        if (!userId) {
            res.status(401).json({ error: "User context is required" });
            return;
        }

        try {
            const favorites = await runtime.databaseAdapter.getFavoriteTaskChains({
                userId,
                agentId: runtime.agentId,
            });

            res.json({
                success: true,
                favorites: favorites.map(serializeFavoriteTaskChainRecord),
            });
        } catch (error) {
            elizaLogger.error("Error fetching favorite task chains:", error);
            res.status(500).json({ error: "Failed to fetch favorite task chains" });
        }
    });

    router.post("/agents/:agentId/favorite-taskchains", authMiddleware, async (req, res) => {
        const { agentId } = validateUUIDParams(req.params, res) ?? {
            agentId: null,
        };
        if (!agentId) return;

        const runtime = agents.get(agentId);
        if (!runtime) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        const userId = (req as any).userId;
        if (!userId) {
            res.status(401).json({ error: "User context is required" });
            return;
        }

        const {
            chainId,
            name,
            originalName,
            description,
            taskChain,
            isPublic,
        } = req.body ?? {};

        if (!chainId || typeof chainId !== "string") {
            res.status(400).json({ error: "chainId is required" });
            return;
        }

        if (!name || typeof name !== "string") {
            res.status(400).json({ error: "name is required" });
            return;
        }

        if (!taskChain || typeof taskChain !== "object") {
            res.status(400).json({ error: "taskChain payload is required" });
            return;
        }

        if (
            typeof isPublic !== "undefined" &&
            typeof isPublic !== "boolean"
        ) {
            res.status(400).json({ error: "isPublic must be a boolean" });
            return;
        }

        try {
            const sanitizedTaskChain = stripTaskChainExecution(taskChain as TaskChainData);
            const favorite = await runtime.databaseAdapter.createFavoriteTaskChain({
                userId,
                agentId: runtime.agentId,
                chainId,
                name,
                originalName: originalName ?? name,
                description,
                taskChain: sanitizedTaskChain,
                createdAt: Date.now(),
                isPublic: Boolean(isPublic),
            });

            res.status(201).json({
                success: true,
                favorite: serializeFavoriteTaskChainRecord(favorite),
            });
        } catch (error: any) {
            const sqliteErrorCode = error?.code as string | undefined;
            if (sqliteErrorCode === "SQLITE_CONSTRAINT_UNIQUE") {
                try {
                    const existing = await runtime.databaseAdapter.getFavoriteTaskChainByChain({
                        chainId,
                        userId,
                        agentId: runtime.agentId,
                    });

                    if (existing) {
                        res.status(200).json({
                            success: true,
                            favorite: serializeFavoriteTaskChainRecord(existing),
                            alreadyExists: true,
                        });
                        return;
                    }
                } catch (lookupError) {
                    elizaLogger.error(
                        "Failed to look up existing favorite after unique constraint:",
                        lookupError
                    );
                }

                res.status(409).json({
                    error: "Task chain already favorited",
                });
                return;
            }

            elizaLogger.error("Error creating favorite task chain:", error);
            res.status(500).json({ error: "Failed to create favorite task chain" });
        }
    });

    router.delete("/agents/:agentId/favorite-taskchains/:favoriteId", authMiddleware, async (req, res) => {
        const { agentId } = validateUUIDParams(req.params, res) ?? {
            agentId: null,
        };
        if (!agentId) return;

        const runtime = agents.get(agentId);
        if (!runtime) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        const favoriteIdParam = req.params.favoriteId;
        const favoriteId = validateUuid(favoriteIdParam);
        if (!favoriteId) {
            res.status(400).json({
                error: "Invalid favoriteId format. Expected UUID.",
            });
            return;
        }

        const userId = (req as any).userId;
        if (!userId) {
            res.status(401).json({ error: "User context is required" });
            return;
        }

        try {
            await runtime.databaseAdapter.removeFavoriteTaskChain({
                favoriteId,
                userId,
                agentId: runtime.agentId,
            });

            res.json({ success: true });
        } catch (error: any) {
            if (error instanceof Error && error.message.includes("not found")) {
                res.status(404).json({ error: "Favorite task chain not found" });
                return;
            }

            elizaLogger.error("Error deleting favorite task chain:", error);
            res.status(500).json({ error: "Failed to delete favorite task chain" });
        }
    });

    router.patch("/agents/:agentId/favorite-taskchains/:favoriteId", authMiddleware, async (req, res) => {
        const { agentId } = validateUUIDParams(req.params, res) ?? {
            agentId: null,
        };
        if (!agentId) return;

        const runtime = agents.get(agentId);
        if (!runtime) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        const favoriteIdParam = req.params.favoriteId;
        const favoriteId = validateUuid(favoriteIdParam);
        if (!favoriteId) {
            res.status(400).json({
                error: "Invalid favoriteId format. Expected UUID.",
            });
            return;
        }

        const userId = (req as any).userId;
        if (!userId) {
            res.status(401).json({ error: "User context is required" });
            return;
        }

        const { name } = req.body ?? {};
        if (!name || typeof name !== "string") {
            res.status(400).json({ error: "name is required" });
            return;
        }

        try {
            await runtime.databaseAdapter.updateFavoriteTaskChainName({
                favoriteId,
                userId,
                agentId: runtime.agentId,
                name,
            });

            res.json({ success: true, favoriteId, name });
        } catch (error: any) {
            if (error instanceof Error && error.message.includes("not found")) {
                res.status(404).json({ error: "Favorite task chain not found" });
                return;
            }

            elizaLogger.error("Error updating favorite task chain name:", error);
            res.status(500).json({ error: "Failed to update favorite task chain" });
        }
    });

    router.patch(
        "/agents/:agentId/favorite-taskchains/:favoriteId/visibility",
        authMiddleware,
        async (req, res) => {
            const { agentId } = validateUUIDParams(req.params, res) ?? {
                agentId: null,
            };
            if (!agentId) return;

            const runtime = agents.get(agentId);
            if (!runtime) {
                res.status(404).json({ error: "Agent not found" });
                return;
            }

            const favoriteIdParam = req.params.favoriteId;
            const favoriteId = validateUuid(favoriteIdParam);
            if (!favoriteId) {
                res.status(400).json({
                    error: "Invalid favoriteId format. Expected UUID.",
                });
                return;
            }

            const userId = (req as any).userId;
            if (!userId) {
                res.status(401).json({ error: "User context is required" });
                return;
            }

            const { isPublic } = req.body ?? {};
            if (typeof isPublic !== "boolean") {
                res.status(400).json({
                    error: "isPublic is required and must be a boolean",
                });
                return;
            }

            try {
                const favorite =
                    await runtime.databaseAdapter.updateFavoriteTaskChainVisibility({
                        favoriteId,
                        userId,
                        agentId: runtime.agentId,
                        isPublic,
                    });
                res.json({
                    success: true,
                    favorite: serializeFavoriteTaskChainRecord(favorite),
                });
            } catch (error: any) {
                if (error instanceof Error && error.message.includes("not found")) {
                    res.status(404).json({ error: "Favorite task chain not found" });
                    return;
                }

                elizaLogger.error("Error updating favorite visibility:", error);
                res.status(500).json({
                    error: "Failed to update favorite visibility",
                });
            }
        }
    );

    router.post("/agents/:agentId/favorite-taskchains/:favoriteId/use", authMiddleware, async (req, res) => {
        const { agentId } = validateUUIDParams(req.params, res) ?? {
            agentId: null,
        };
        if (!agentId) return;

        const runtime = agents.get(agentId);
        if (!runtime) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        const favoriteIdParam = req.params.favoriteId;
        const favoriteId = validateUuid(favoriteIdParam);
        if (!favoriteId) {
            res.status(400).json({
                error: "Invalid favoriteId format. Expected UUID.",
            });
            return;
        }

        const userId = (req as any).userId;
        if (!userId) {
            res.status(401).json({ error: "User context is required" });
            return;
        }

        const timestamp = typeof req.body?.timestamp === "number"
            ? req.body.timestamp
            : Date.now();

        try {
            await runtime.databaseAdapter.markFavoriteTaskChainUsed({
                favoriteId,
                userId,
                agentId: runtime.agentId,
                timestamp,
            });

            res.json({ success: true, favoriteId, lastUsedAt: timestamp });
        } catch (error: any) {
            if (error instanceof Error && error.message.includes("not found")) {
                res.status(404).json({ error: "Favorite task chain not found" });
                return;
            }

            elizaLogger.error("Error updating favorite task chain usage:", error);
            res.status(500).json({ error: "Failed to update favorite task chain" });
        }
    });

    router.post("/agents/:agentId/favorite-taskchains/:favoriteId/share", authMiddleware, async (req, res) => {
        const { agentId } = validateUUIDParams(req.params, res) ?? {
            agentId: null,
        };
        if (!agentId) return;

        const runtime = agents.get(agentId);
        if (!runtime) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        const favoriteIdParam = req.params.favoriteId;
        const favoriteId = validateUuid(favoriteIdParam);
        if (!favoriteId) {
            res.status(400).json({
                error: "Invalid favoriteId format. Expected UUID.",
            });
            return;
        }

        const userId = (req as any).userId;
        if (!userId) {
            res.status(401).json({ error: "User context is required" });
            return;
        }

        try {
            const favorite = await runtime.databaseAdapter.getFavoriteTaskChain({
                favoriteId,
                userId,
                agentId: runtime.agentId,
            });

            if (!favorite) {
                res.status(404).json({ error: "Favorite task chain not found" });
                return;
            }

            const existingShare = await runtime.databaseAdapter.getSharedTaskChainByFavorite({
                favoriteId,
                userId,
                agentId: runtime.agentId,
            });

            if (existingShare) {
                res.json({
                    success: true,
                    share: serializeSharedTaskChainRecord(existingShare),
                });
                return;
            }

            const sanitizedTaskChain = stripTaskChainExecution(favorite.taskChain);
            const maxAttempts = 5;
            let attempts = 0;
            let sharedRecord: SharedTaskChainRecord | null = null;

            while (attempts < maxAttempts && !sharedRecord) {
                const shareCode = generateShareCode();
                try {
                    sharedRecord = await runtime.databaseAdapter.createSharedTaskChain({
                        userId,
                        agentId: runtime.agentId,
                        favoriteId,
                        chainId: favorite.chainId,
                        name: favorite.name,
                        originalName: favorite.originalName,
                        description: favorite.description,
                        taskChain: sanitizedTaskChain,
                        shareCode,
                        createdAt: Date.now(),
                    });
                } catch (error: any) {
                    const sqliteErrorCode = error?.code as string | undefined;
                    if (sqliteErrorCode === "SQLITE_CONSTRAINT" || sqliteErrorCode === "SQLITE_CONSTRAINT_UNIQUE") {
                        attempts += 1;
                        continue;
                    }

                    throw error;
                }
            }

            if (!sharedRecord) {
                res.status(500).json({ error: "Failed to generate share code" });
                return;
            }

            res.status(201).json({
                success: true,
                share: serializeSharedTaskChainRecord(sharedRecord),
            });
        } catch (error) {
            elizaLogger.error("Error creating shared task chain:", error);
            res.status(500).json({ error: "Failed to create shared task chain" });
        }
    });

    router.get("/trending-taskchains", async (req, res) => {
        try {
            const limit = req.query.limit ? Number.parseInt(req.query.limit as string, 10) : 3;

            if (isNaN(limit) || limit < 1 || limit > 10) {
                res.status(400).json({ error: "Invalid limit parameter (must be 1-10)" });
                return;
            }

            const ensureShareCodeForFavorite = async (
                runtime: AgentRuntime,
                favoriteId: UUID,
                userId: UUID
            ): Promise<string | null> => {
                try {
                    const existingShare =
                        await runtime.databaseAdapter.getSharedTaskChainByFavorite({
                            favoriteId,
                            userId,
                            agentId: runtime.agentId,
                        });
                    if (existingShare?.shareCode) {
                        return existingShare.shareCode;
                    }
                } catch (error) {
                    elizaLogger.warn(
                        `Error checking existing share for favorite ${favoriteId}:`,
                        error
                    );
                }

                const favorite = await runtime.databaseAdapter.getFavoriteTaskChain({
                    favoriteId,
                    userId,
                    agentId: runtime.agentId,
                });

                if (!favorite) {
                    return null;
                }

                const sanitizedTaskChain = stripTaskChainExecution(favorite.taskChain);
                const maxAttempts = 5;
                let attempts = 0;

                while (attempts < maxAttempts) {
                    const shareCode = generateShareCode();
                    try {
                        const sharedRecord =
                            await runtime.databaseAdapter.createSharedTaskChain({
                                favoriteId: favorite.id,
                                userId: favorite.userId,
                                agentId: runtime.agentId,
                                chainId: favorite.chainId,
                                name: favorite.name,
                                originalName: favorite.originalName,
                                description: favorite.description ?? null,
                                taskChain: sanitizedTaskChain,
                                shareCode,
                                createdAt: Date.now(),
                            });
                        return sharedRecord.shareCode;
                    } catch (error: any) {
                        const sqliteErrorCode = error?.code as string | undefined;
                        if (
                            sqliteErrorCode === "SQLITE_CONSTRAINT" ||
                            sqliteErrorCode === "SQLITE_CONSTRAINT_UNIQUE"
                        ) {
                            attempts += 1;
                            continue;
                        }

                        elizaLogger.warn(
                            `Error creating share for favorite ${favoriteId}:`,
                            error
                        );
                        break;
                    }
                }

                return null;
            };

            // Get trending task chains from all agents
            const allTrending: Array<{
                chainId: string;
                name: string;
                description: string | null;
                totalExecutions: number;
                lastUsedAt: number | null;
                shareCode: string | null;
            }> = [];

            for (const runtime of agents.values()) {
                try {
                    const trending = await runtime.databaseAdapter.getTrendingTaskChains({
                        agentId: runtime.agentId,
                        limit,
                    });

                    for (const item of trending) {
                        let shareCode: string | null = null;

                        if (item.sampleFavoriteId && item.sampleUserId) {
                            try {
                                shareCode = await ensureShareCodeForFavorite(
                                    runtime,
                                    item.sampleFavoriteId,
                                    item.sampleUserId
                                );
                            } catch (error) {
                                elizaLogger.warn(
                                    `Error ensuring share code for favorite ${item.sampleFavoriteId}:`,
                                    error
                                );
                            }
                        }

                        allTrending.push({
                            chainId: item.chainId,
                            name: item.name,
                            description: item.description,
                            totalExecutions: item.totalExecutions,
                            lastUsedAt: item.lastUsedAt,
                            shareCode,
                        });
                    }
                } catch (error) {
                    elizaLogger.warn(
                        `Error querying trending task chains for agent ${runtime.agentId}:`,
                        error
                    );
                }
            }

            // Aggregate and sort by total executions across all agents
            type AggregatedTrending = {
                chainId: string;
                name: string;
                description: string | null;
                totalExecutions: number;
                lastUsedAt: number | null;
                shareCode: string | null;
            };

            const aggregatedMap = new Map<string, AggregatedTrending>();

            for (const item of allTrending) {
                const existing = aggregatedMap.get(item.chainId);
                if (existing) {
                    existing.totalExecutions += item.totalExecutions;
                    if (item.lastUsedAt && (!existing.lastUsedAt || item.lastUsedAt > existing.lastUsedAt)) {
                        existing.lastUsedAt = item.lastUsedAt;
                    }
                    if (!existing.shareCode && item.shareCode) {
                        existing.shareCode = item.shareCode;
                    }
                } else {
                    aggregatedMap.set(item.chainId, { ...item });
                }
            }

            const trending = Array.from(aggregatedMap.values())
                .sort((a, b) => {
                    if (b.totalExecutions !== a.totalExecutions) {
                        return b.totalExecutions - a.totalExecutions;
                    }
                    return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0);
                })
                .slice(0, limit);

            res.json({ success: true, trending });
        } catch (error) {
            elizaLogger.error("Error fetching trending task chains:", error);
            res.status(500).json({ error: "Failed to fetch trending task chains" });
        }
    });

    router.get("/shared-taskchains/:shareCode", async (req, res) => {
        const rawCode = (req.params.shareCode ?? "").trim();
        if (!rawCode) {
            res.status(400).json({ error: "shareCode is required" });
            return;
        }

        const normalizedCode = rawCode.toUpperCase();
        if (!/^[A-Z0-9]{10}$/.test(normalizedCode)) {
            res.status(400).json({ error: "Invalid share code format" });
            return;
        }

        let sharedRecord: SharedTaskChainRecord | null = null;

        for (const runtime of agents.values()) {
            try {
                const candidate = await runtime.databaseAdapter.getSharedTaskChainByCode(normalizedCode);
                if (candidate) {
                    sharedRecord = candidate;
                    break;
                }
            } catch (error) {
                elizaLogger.warn(
                    `Error querying shared task chain for agent ${runtime.agentId}:`,
                    error
                );
            }
        }

        if (!sharedRecord) {
            res.status(404).json({ error: "Shared task chain not found" });
            return;
        }

        res.json({
            success: true,
            share: serializeSharedTaskChainRecord(sharedRecord),
        });
    });

    router.post("/agents/:agentId/rooms/:roomId/shared-chat", authMiddleware, async (req, res) => {
        const { agentId, roomId } = validateUUIDParams(req.params, res) ?? {
            agentId: null,
            roomId: null,
        };
        if (!agentId || !roomId) return;

        const runtime = agents.get(agentId);
        if (!runtime) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        try {
            const requestUserInfo = (req as any).userInfo ?? getUserInfo(req);
            const requestUserId = (req as any).userId ?? getUserId(req);

            if (!requestUserInfo || !requestUserId) {
                res.status(401).json({ error: "Authentication required" });
                return;
            }

            // Ensure the requesting account exists before writing rows that reference accounts.id.
            // This prevents foreign-key failures when a user can interact with the app before an
            // account row has been created.
            const isAuthenticated =
                requestUserInfo.type === "authenticated" &&
                typeof requestUserInfo.email === "string" &&
                requestUserInfo.email.trim().length > 0;
            const normalizedEmail = isAuthenticated ? normalizeEmail(requestUserInfo.email) : null;
            const fallbackIdentifier =
                requestUserInfo.type === "anonymous" && typeof requestUserInfo.ip === "string"
                    ? requestUserInfo.ip.replace(/[^a-zA-Z0-9._-]/g, "-")
                    : requestUserId.slice(0, 8);

            await runtime.ensureUserExists(
                requestUserId,
                isAuthenticated ? (normalizedEmail as string) : `anon-${fallbackIdentifier}`,
                isAuthenticated ? (normalizedEmail as string) : "Anonymous User",
                isAuthenticated
                    ? (normalizedEmail as string)
                    : `${requestUserId}@anonymous.local`,
                isAuthenticated ? "auth" : "ip"
            );

            if (requestUserInfo.type === "anonymous") {
                await cleanupAnonymousHistoryIfExpired({ runtime, userId: requestUserId });
            }

            const roomExists = await runtime.databaseAdapter.getRoom(roomId);
            if (!roomExists) {
                res.status(404).json({ error: "Room not found" });
                return;
            }

            // Ensure the agent account exists (shared_chats.agentId is a foreign key to accounts.id).
            try {
                await runtime.ensureUserExists(
                    runtime.agentId,
                    runtime.character.username ?? runtime.character.name ?? "Agent",
                    runtime.character.name ?? "Agent",
                    runtime.character.email ?? runtime.agentId,
                    "agent"
                );
            } catch (error) {
                elizaLogger.warn("Failed to ensure agent account exists for shared chat:", error);
            }

            const participantRoomIds = await runtime.databaseAdapter.getRoomsForParticipant(
                requestUserId,
                runtime.agentId,
            );

            if (!participantRoomIds.includes(roomId)) {
                res.status(403).json({ error: "Access to this room is not permitted" });
                return;
            }

            const existing = await getSharedChatByRoomCompat(runtime.databaseAdapter, {
                agentId: runtime.agentId,
                roomId,
            });

            if (existing) {
                res.json({
                    success: true,
                    share: serializeSharedChatRecord(existing),
                });
                return;
            }

            const maxAttempts = 5;
            let attempts = 0;
            let sharedRecord: SharedChatRecord | null = null;

            while (attempts < maxAttempts && !sharedRecord) {
                const shareCode = generateShareCode();
                try {
                    sharedRecord = await createSharedChatCompat(runtime.databaseAdapter, {
                        userId: requestUserId,
                        agentId: runtime.agentId,
                        roomId,
                        shareCode,
                        createdAt: Date.now(),
                    });
                } catch (error: any) {
                    const sqliteErrorCode = error?.code as string | undefined;
                    if (
                        sqliteErrorCode === "SQLITE_CONSTRAINT" ||
                        sqliteErrorCode === "SQLITE_CONSTRAINT_UNIQUE"
                    ) {
                        const concurrentExisting = await runtime.databaseAdapter.getSharedChatByRoom({
                            agentId: runtime.agentId,
                            roomId,
                        });
                        if (concurrentExisting) {
                            sharedRecord = concurrentExisting;
                            break;
                        }

                        attempts += 1;
                        continue;
                    }

                    throw error;
                }
            }

            if (!sharedRecord) {
                res.status(500).json({ error: "Failed to generate share code" });
                return;
            }

            res.status(201).json({
                success: true,
                share: serializeSharedChatRecord(sharedRecord),
            });
        } catch (error) {
            const code = (error as any)?.code as string | undefined;
            const message =
                error instanceof Error
                    ? error.message
                    : typeof error === "string"
                      ? error
                      : "Unknown error";
            const stack = error instanceof Error ? error.stack : undefined;

            elizaLogger.error("Error creating shared chat:", { code, message, stack });

            const payload: Record<string, unknown> = {
                error: "Failed to create shared chat",
            };

            // In development, surface a human-readable message back to the client so the UI
            // doesn't just show a generic 500.
            if (process.env.NODE_ENV !== "production") {
                payload.message = message;
                if (code) payload.code = code;
            }

            // Always include a scrubbed `reason` even in production. This is just an
            // error code (e.g. "11000", "ECONNRESET", "SQLITE_CONSTRAINT") or
            // "unknown" — no message, no stack — so it's safe to expose to the
            // client. Lets on-call identify the failure mode from the toast
            // string without needing CloudWatch access.
            payload.reason =
                (error as any)?.code ??
                (error as any)?.errorCode ??
                code ??
                "unknown";

            res.status(500).json(payload);
        }
    });

    router.post("/agents/:agentId/rooms/:roomId/share-summary", authMiddleware, async (req, res) => {
        const { agentId, roomId } = validateUUIDParams(req.params, res) ?? {
            agentId: null,
            roomId: null,
        };
        if (!agentId || !roomId) return;

        const runtime = agents.get(agentId);
        if (!runtime) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        try {
            const requestUserInfo = (req as any).userInfo ?? getUserInfo(req);
            const requestUserId = (req as any).userId ?? getUserId(req);

            if (!requestUserInfo || !requestUserId) {
                res.status(401).json({ error: "Authentication required" });
                return;
            }

            if (requestUserInfo.type === "anonymous") {
                await cleanupAnonymousHistoryIfExpired({ runtime, userId: requestUserId });
            }

            const roomExists = await runtime.databaseAdapter.getRoom(roomId);
            if (!roomExists) {
                res.status(404).json({ error: "Room not found" });
                return;
            }

            const participantRoomIds = await runtime.databaseAdapter.getRoomsForParticipant(
                requestUserId,
                runtime.agentId,
            );

            if (!participantRoomIds.includes(roomId)) {
                res.status(403).json({ error: "Access to this room is not permitted" });
                return;
            }

            const memories = await runtime.messageManager.getMemories({
                roomId,
                unique: false,
                count: 250,
            });

            const sorted = [...memories].sort((a: any, b: any) => {
                const aTime = typeof a?.createdAt === "number" ? a.createdAt : 0;
                const bTime = typeof b?.createdAt === "number" ? b.createdAt : 0;
                return aTime - bTime;
            });

	            const recent = sorted.slice(-80);

	            const MAX_SUMMARY_WORDS = 60;
	            const REQUIRED_SENTENCES = 1;

	            const collapseWhitespace = (value: string): string => String(value).replace(/\s+/g, " ").trim();
            const capitalizeFirstLetter = (value: string): string => {
                const normalized = collapseWhitespace(value);
                if (!normalized) return "";
                return normalized.charAt(0).toUpperCase() + normalized.slice(1);
            };
            const ensureSentiEdgeLead = (value: string): string => {
                const normalized = collapseWhitespace(value).replace(/[.!?]+$/g, "").trim();
                if (!normalized) return "";
                const withoutLead = normalized
                    .replace(/^sentiedge\s*ai\s+helped\s+with\s+/i, "")
                    .replace(/^an\s+overview\s+of\s+/i, "an overview of ");
                return capitalizeFirstLetter(ensureSentenceEnding(`SentiEdge AI helped with ${withoutLead}`));
            };

	            const stripMarkdownForSummary = (value: string): string => {
	                const raw = String(value ?? "");
	                const withoutCodeBlocks = raw.replace(/```[\s\S]*?```/g, " ");
	                const withoutInlineCode = withoutCodeBlocks.replace(/`[^`]*`/g, " ");
	                const withoutLinks = withoutInlineCode.replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1");
	                const withoutHeadings = withoutLinks.replace(/^\s{0,3}#{1,6}\s+/gm, "");
	                const withoutBullets = withoutHeadings.replace(/^\s*[-*+]\s+/gm, "");
	                const withoutNumbered = withoutBullets.replace(/^\s*\d+\.\s+/gm, "");
	                const withoutEmphasis = withoutNumbered
	                    .replace(/\*\*(.*?)\*\*/g, "$1")
	                    .replace(/__(.*?)__/g, "$1")
	                    .replace(/\*(.*?)\*/g, "$1")
	                    .replace(/_(.*?)_/g, "$1");
	                const normalized = collapseWhitespace(withoutEmphasis);
	                return normalized;
	            };

	            const enforceMaxWords = (input: string, maxWords: number): string => {
	                const normalized = collapseWhitespace(input);
	                if (!normalized) return "";
                const words = normalized.split(" ");
	                if (words.length <= maxWords) return normalized;
	                return `${words.slice(0, maxWords).join(" ")}`;
	            };

	            const splitSentences = (input: string): string[] => {
	                const cleaned = collapseWhitespace(input);
	                if (!cleaned) return [];
	                return cleaned.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
	            };

	            const ensureSentenceEnding = (input: string): string => {
	                const trimmed = collapseWhitespace(input);
	                if (!trimmed) return "";
	                if (/[.!?…]$/.test(trimmed)) return trimmed;
	                return `${trimmed}.`;
	            };

	            const removeTitleLikePrefix = (input: string): string => {
	                let cleaned = collapseWhitespace(input);
	                cleaned = cleaned.replace(
	                    /^\s*what\s+is\s+[^?]{2,80}\?\s*(a|an|the)\s+[^.]{2,80}\bguide\b\s*/i,
	                    ""
	                );
	                cleaned = cleaned.replace(/^\s*what\s+is\s+[^?]{2,80}\?\s*/i, "");
	                cleaned = cleaned.replace(/^\s*[a-z0-9][^.!?]{0,80}\bguide\b:\s*/i, "");
	                return cleaned.trim();
	            };

	            const countWords = (input: string): number => {
	                const normalized = collapseWhitespace(input);
	                if (!normalized) return 0;
	                return normalized.split(" ").filter(Boolean).length;
	            };

	            const toTwoSentences = (input: string): string => {
	                const cleaned = removeTitleLikePrefix(input);
	                const sentences = splitSentences(cleaned).filter((sentence) => {
                    if (countWords(sentence) < 4) return false;
                    if (isShareProcessOrCompletionBoilerplate(sentence)) return false;
                    return true;
                });

	                const picked = sentences.slice(0, REQUIRED_SENTENCES);
	                if (picked.length === 0) return "";
	                return enforceMaxWords(ensureSentenceEnding(picked[0]), MAX_SUMMARY_WORDS);
	            };

	            const generateSummaryViaModel = async (
	                modelRuntime: AgentRuntime,
	                answer: string
	            ): Promise<string> => {
	                const normalizeForMatch = (value: string): string =>
	                    collapseWhitespace(value).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "");

	                const isTooExtractive = (candidateSummary: string): boolean => {
	                    const summaryNormalized = normalizeForMatch(candidateSummary);
	                    const answerNormalized = normalizeForMatch(answer);
	                    if (!summaryNormalized || !answerNormalized) return false;

	                    if (/key characteristics|beginner.?s guide/i.test(candidateSummary)) return true;
	                    if (/\b\d+\.\s/.test(candidateSummary)) return true;

	                    const summaryWords = summaryNormalized.split(" ").filter(Boolean);
	                    if (summaryWords.length < 12) return false;

	                    // If any 8-word span appears verbatim in the answer, it's likely an excerpt.
	                    const spanSize = 8;
	                    for (let i = 0; i + spanSize <= summaryWords.length; i += 1) {
	                        const span = summaryWords.slice(i, i + spanSize).join(" ");
	                        if (span.length < 20) continue;
	                        if (answerNormalized.includes(span)) {
	                            return true;
	                        }
	                    }

	                    return false;
	                };

	                const baseSystemPrompt = [
	                    "You are a summarizer for social sharing.",
	                    "Return exactly one complete sentence in plain text.",
	                    `Keep it under ${MAX_SUMMARY_WORDS} words total.`,
	                    "Write like a human teaser: what asset or topic (e.g. Bitcoin, Ethereum) and what kind of help (prices, sentiment, report)—not a feature list.",
	                    "Describe what the conversation is about and what the assistant helped with, at a high level.",
	                    "Never mention workflow phases, emoji section headers, action counts, 'comprehensive analysis complete', 'mandatory actions', or report file paths.",
	                    "Do not paste lists, tables, article bodies, or long quotes from the input.",
	                    "Omit specific numbers, prices, percentages, tickers, dates, URLs, and news headlines unless one short phrase is essential for context.",
	                    "If the input is mostly raw market data or scraped news, say only the general topic (e.g. crypto prices and headlines) and that details are in the linked chat.",
	                    "Do not include the user's question as a quoted question.",
	                    "Do not use headings, bullets, numbering, markdown, or quotes.",
	                    "Do not start with \"What is\" or a title like \"Beginner's Guide\".",
	                    "Paraphrase; do not copy phrases longer than six words from the input.",
	                ].join(" ");

	                const strictSystemPrompt = [
	                    baseSystemPrompt,
	                    "Avoid copying any phrase longer than 6 words from the input.",
	                    "If the input contains lists, compress them into narrative prose.",
	                ].join(" ");

	                const userPrompt = [
	                    "Summarize this assistant answer into one meaningful sentence:",
	                    "",
	                    answer,
	                    "",
	                    "Summary (exactly one sentence):",
	                ].join("\n");

	                const attempt = async (customSystemPrompt: string): Promise<string> =>
	                    await generateText({
	                        runtime: modelRuntime,
	                        prompt: userPrompt,
	                        modelClass: ModelClass.SMALL,
	                        customSystemPrompt,
	                    });

	                const first = await attempt(baseSystemPrompt);
	                if (!isTooExtractive(first)) return first;
	                return await attempt(strictSystemPrompt);
	            };

	            const normalizeSummary = (raw: string): string => {
	                const cleaned = stripMarkdownForSummary(raw)
	                    .replace(/^\s*summary:\s*/i, "")
	                    .replace(/\b(user|assistant)\s*:\s*/gi, "")
                    .replace(/^\s*the assistant provided\s+/i, "")
                    .replace(/^\s*the assistant\s+/i, "")
                    .replace(/^\s*assistant provided\s+/i, "")
                    .replace(/\bthe assistant provided\b/gi, "")
                    .replace(/\bassistant provided\b/gi, "")
                    .replace(/\bthe assistant\b/gi, "")
	                    .replace(/\b(this\s+chat\s+is\s+about|it\s+covers)\b/gi, "")
                    .replace(/^\s*web\s+search\s+results\s+for:\s*/i, "")
                    .replace(/\bsearch\s+answer:\s*/gi, "")
                    .replace(/\bfound\s+\d+\s+results?\b/gi, "")
                    .replace(/\bacross\s+\d+\s+search\s+iterations?\b/gi, "")
                    .replace(/\bfound\s+comprehensive information from\s+\d+\s+sources?\b/gi, "")
                    .replace(/\(\s*\d+\s*\/\s*\d+\s*tasks?\s*\)/gi, "")
                    .replace(/\b\d+\s*\/\s*\d+\s*tasks?\b/gi, "")
                    .replace(/\bcompleted\s+\d+\s+of\s+\d+\s+tasks?\b/gi, "")
                    .replace(/\b\d+\s+of\s+\d+\s+tasks?\s+completed\b/gi, "")
	                    .replace(/^[\s"'“”]+/, "")
	                    .replace(/[\s"'“”]+$/, "");
                const oneLine = toTwoSentences(cleaned);
                if (!oneLine) return "";
                if (/^an overview of /i.test(oneLine)) return ensureSentiEdgeLead(oneLine);
                return ensureSentiEdgeLead(`an overview of ${oneLine.replace(/[.!?]+$/g, "").trim()}`);
	            };

            const isInterruptionOrStatusText = (value: string): boolean => {
                const normalized = collapseWhitespace(value).toLowerCase();
                if (!normalized) return true;
                return (
                    normalized.includes("could not complete") ||
                    normalized.includes("analysis failed") ||
                    normalized.includes("comprehensive analysis failed") ||
                    normalized.includes("failed due to") ||
                    normalized.includes("due to user interruption") ||
                    normalized.includes("due to user interruptions") ||
                    normalized.includes("user interruption") ||
                    normalized.includes("user interruptions") ||
                    normalized.includes("please try rephrasing") ||
                    normalized.includes("rephrase your request") ||
                    normalized.includes("processing stopped") ||
                    normalized.includes("task chain stopped") ||
                    normalized.includes("comprehensive analysis stopped") ||
                    normalized.includes("stopped successfully")
                );
            };

            const hasTaskCountPattern = (value: string): boolean => {
                const text = String(value ?? "");
                return (
                    /\(\s*\d+\s*\/\s*\d+\s*tasks?\s*\)/i.test(text) ||
                    /\b\d+\s*\/\s*\d+\s*tasks?\b/i.test(text) ||
                    /\bcompleted\s+\d+\s+of\s+\d+\s+tasks?\b/i.test(text) ||
                    /\b\d+\s+of\s+\d+\s+tasks?\s+completed\b/i.test(text)
                );
            };

            const isSearchResultMetaText = (value: string): boolean => {
                const text = String(value ?? "");
                const normalized = collapseWhitespace(text).toLowerCase();
                if (!normalized) return false;
                return (
                    normalized.startsWith("web search results for:") ||
                    normalized.includes("search answer:") ||
                    /\bfound\s+\d+\s+results?\b/i.test(text) ||
                    /\bacross\s+\d+\s+search\s+iterations?\b/i.test(text) ||
                    /\bfound\s+comprehensive information from\s+\d+\s+sources?\b/i.test(text) ||
                    /^\s*\d+\.\s*$/.test(normalized)
                );
            };

            /** Completion / process narratives (not shareable substance) — e.g. "Comprehensive Analysis Complete!" phase lists. */
            const isShareProcessOrCompletionBoilerplate = (text: string): boolean => {
                const n = collapseWhitespace(text).toLowerCase();
                if (!n) return false;
                if (hasTaskCountPattern(text)) return true;
                if (isSearchResultMetaText(text)) return true;
                if (/\bcomprehensive analysis complete\b/i.test(text)) return true;
                if (/\bcomprehensive\b.*\b(finished|accomplished|completed)\b/i.test(text)) return true;
                if (/\btask\s*chain\b.*\b(finished|accomplished|completed)\b/i.test(text)) return true;
                if (/\btaskchain\b.*\b(finished|accomplished|completed)\b/i.test(text)) return true;
                if (n.includes("successfully conducted a comprehensive analysis")) return true;
                if (n.includes("mandatory actions covering") || /\b\d+\s+mandatory actions\b/i.test(text)) {
                    return true;
                }
                if (n.includes("professional html report generated")) return true;
                if (
                    n.includes("data collection phase") &&
                    n.includes("analysis phase") &&
                    (n.includes("prediction phase") || n.includes("🔮"))
                ) {
                    return true;
                }
                if (/\btask chain\b/i.test(text) && /\b(complete|finished)\b/i.test(n) && n.includes("task")) {
                    return true;
                }
                return false;
            };

            const transcriptLines: string[] = [];
            for (const memory of recent) {
                const rawContent = (memory as any)?.content;
                const rawText =
                    typeof rawContent === "string"
                        ? rawContent
                        : typeof rawContent?.text === "string"
                          ? rawContent.text
                          : typeof (rawContent as any)?.message === "string"
                            ? (rawContent as any).message
                            : "";
                const trimmed = String(rawText).trim();
                if (!trimmed) continue;
                if (isInterruptionOrStatusText(trimmed)) continue;
                if (isShareProcessOrCompletionBoilerplate(trimmed)) continue;
                const role = memory.userId === runtime.agentId ? "Assistant" : "User";
                const clipped = trimmed.length > 900 ? `${trimmed.slice(0, 897)}...` : trimmed;
                transcriptLines.push(`${role}: ${clipped}`);
            }

            const transcript = transcriptLines.join("\n");

            const getRecentUserTopic = (): string => {
                const reversed = [...recent].reverse();
                for (const memory of reversed) {
                    if (memory.userId === runtime.agentId) continue;
                    const rawContent = (memory as any)?.content;
                    const rawText =
                        typeof rawContent === "string"
                            ? rawContent
                            : typeof rawContent?.text === "string"
                              ? rawContent.text
                              : typeof rawContent?.message === "string"
                                ? rawContent.message
                                : "";
                    const cleaned = stripMarkdownForSummary(String(rawText ?? "")).trim();
                    if (cleaned.length >= 12) return cleaned.slice(0, 420);
                }
                const lastUserLine =
                    [...transcriptLines].reverse().find((line) => line.startsWith("User: ")) ?? "";
                return stripMarkdownForSummary(lastUserLine.replace(/^User:\s*/, "")).trim().slice(0, 420);
            };

            const normalizeTitle = (raw: string): string => {
                const cleaned = stripMarkdownForSummary(raw)
                    .replace(/^(what\s+is|can\s+you|please|help\s+me|tell\s+me|analyze|analyse)\s+/i, "")
                    .replace(/\?+$/, "")
                    .replace(/^(the|a|an)\s+/i, "")
                    .trim();
                const compact = collapseWhitespace(cleaned);
                if (!compact) return "";
                const maxLen = 80;
                if (compact.length <= maxLen) return compact;
                const cut = compact.slice(0, maxLen);
                const idx = cut.lastIndexOf(" ");
                return (idx > 40 ? cut.slice(0, idx) : cut).trim();
            };

            const toDeclarativeTitle = (raw: string, assetHint?: string): string => {
                const source = String(raw ?? "");
                let title = normalizeTitle(source);
                const asset = normalizeTitle(assetHint ?? "");
                const questionLike =
                    /[?]/.test(source) ||
                    /^\s*(what|why|how|when|where|who|can|could|should|would|is|are|do|does|did)\b/i.test(source);
                if (!title && asset) return `Overview of ${asset}`;
                if (!title) return "";
                if (questionLike) {
                    if (asset && !title.toLowerCase().includes(asset.toLowerCase())) {
                        title = `${asset} ${title}`;
                    }
                }
                title = title.replace(/\?+$/g, "").replace(/[.!]+$/g, "").trim();
                title = normalizeTitle(title);
                if (!title) return "";
                if (/^overview of /i.test(title)) return capitalizeFirstLetter(title);
                return capitalizeFirstLetter(`Overview of ${title}`);
            };

            const findAssetLabel = (): string => {
                const reversed = [...recent].reverse();
                for (const memory of reversed) {
                    const rawContent = (memory as any)?.content;
                    const meta = (rawContent?.metadata as any) || {};
                    const labelRaw =
                        (typeof meta.cryptoName === "string" && meta.cryptoName.trim()) ||
                        (typeof meta.target === "string" && meta.target.trim()) ||
                        "";
                    if (labelRaw) return stripMarkdownForSummary(labelRaw).trim();
                }
                return "";
            };

            const toIntentSentence = (rawTopic: string, assetHint?: string): string => {
                const topic = normalizeTitle(rawTopic)
                    .replace(/^web\s+search\s+results?\s+for:\s*/i, "")
                    .replace(/\bsearch\s+answer:\s*/gi, "")
                    .replace(/\bfound\s+\d+\s+results?\b/gi, "")
                    .replace(/\bacross\s+\d+\s+search\s+iterations?\b/gi, "")
                    .replace(/\bfound\s+comprehensive information from\s+\d+\s+sources?\b/gi, "")
                    .trim();
                const asset = normalizeTitle(assetHint ?? "");
                if (asset && topic) {
                    const topicLower = topic.toLowerCase();
                    if (topicLower.includes(asset.toLowerCase())) {
                        return ensureSentiEdgeLead(`an overview of ${topic} with key context and analysis`);
                    }
                    return ensureSentiEdgeLead(`an overview of ${asset} focused on ${topic}`);
                }
                if (topic) {
                    return ensureSentiEdgeLead(`an overview of ${topic} with key context and analysis`);
                }
                if (asset) {
                    return ensureSentiEdgeLead(`an overview of ${asset} with key context and analysis`);
                }
                return "";
            };

            const buildIntentSummaryFromUser = (): string => {
                const userTopic = getRecentUserTopic();
                const asset = findAssetLabel();
                const sentence = toIntentSentence(userTopic, asset);
                if (sentence && !isShareProcessOrCompletionBoilerplate(sentence) && !isSearchResultMetaText(sentence)) {
                    return enforceMaxWords(sentence, MAX_SUMMARY_WORDS);
                }
                return "";
            };

            const getRecentMeaningfulAssistantTopic = (): string => {
                const reversed = [...recent].reverse();
                for (const memory of reversed) {
                    if (memory.userId !== runtime.agentId) continue;
                    const text = stripMarkdownForSummary(getMemoryText(memory)).trim();
                    if (!text) continue;
                    if (isInterruptionOrStatusText(text)) continue;
                    if (isShareProcessOrCompletionBoilerplate(text)) continue;
                    if (isSearchResultMetaText(text)) continue;
                    if (hasTaskCountPattern(text)) continue;
                    return text.slice(0, 420);
                }
                return "";
            };

            const deriveShareTitle = (): string => {
                const rawUserTopic = getRecentUserTopic();
                const asset = normalizeTitle(findAssetLabel());
                const userTopic = toDeclarativeTitle(rawUserTopic, asset);

                if (asset && userTopic) {
                    const lowerTopic = userTopic.toLowerCase();
                    if (lowerTopic.includes(asset.toLowerCase())) {
                        return userTopic;
                    }
                    return toDeclarativeTitle(`${asset} ${userTopic}`, asset) || `Overview of ${asset}`;
                }
                if (userTopic) return userTopic;
                if (asset) return `Overview of ${asset}`;

                const lastAssistant =
                    [...transcriptLines].reverse().find((line) => line.startsWith("Assistant: ")) ?? "";
                const assistantTopic = toDeclarativeTitle(lastAssistant.replace(/^Assistant:\s*/, ""), asset);
                if (assistantTopic) return assistantTopic;
                return "";
            };

	            const fallbackSummary = (): string => {
	                if (!transcriptLines.length) return "";
                const lastUserLine = [...transcriptLines]
                    .reverse()
                    .find((line) => line.startsWith("User: ")) ?? "";
                const lastAssistantLine = [...transcriptLines]
                    .reverse()
                    .find((line) => line.startsWith("Assistant: ")) ?? "";

	                const answer = stripMarkdownForSummary(lastAssistantLine.replace(/^Assistant:\s*/, ""));
                    if (isInterruptionOrStatusText(answer)) return "";
                    if (isShareProcessOrCompletionBoilerplate(answer)) return "";
	                return toTwoSentences(answer);
	            };

            if (!transcript) {
                const fallbackIntent = buildIntentSummaryFromUser();
                const assistantFallback = toIntentSentence(getRecentMeaningfulAssistantTopic(), findAssetLabel());
                const finalFallback = collapseWhitespace(fallbackIntent || assistantFallback);
                res.json({ success: true, title: deriveShareTitle(), summary: finalFallback });
                return;
            }

            // NOTE: variable name kept for blame-stability; provider is Google now that
            // all Anthropic keys have been retired in prod (April 2026).
            const claudeRuntime = Object.create(runtime) as AgentRuntime;
            claudeRuntime.modelProvider = ModelProviderName.GOOGLE;
            claudeRuntime.character = {
                ...runtime.character,
                settings: {
                    ...(runtime.character.settings ?? {}),
                    modelFallback: {
                        ...(runtime.character.settings?.modelFallback ?? {}),
                        enabled: false,
                    },
                },
            };

            const getMemoryText = (memory: any): string => {
                const rawContent = memory?.content;
                const rawText =
                    typeof rawContent === "string"
                        ? rawContent
                        : typeof rawContent?.text === "string"
                          ? rawContent.text
                          : typeof rawContent?.message === "string"
                            ? rawContent.message
                            : "";
                return String(rawText ?? "");
            };

            const getMemorySource = (memory: any): string => {
                const rawContent = memory?.content;
                const source = typeof rawContent?.source === "string" ? rawContent.source : "";
                return source;
            };

            /** Skip raw market/news scrapes when choosing text to summarize — we want a high-level share blurb. */
            const isLikelyStructuredMarketOrNewsBlob = (text: string): boolean => {
                const sample = text.slice(0, 4500);
                const lower = sample.toLowerCase();
                const usdHits = (lower.match(/\busd\b/g) ?? []).length;
                const priceLabels =
                    (lower.match(
                        /\b(close|open|high|low)\s+price|volume\s*\(|volume\s*\(24h\)|last\s+updated|52w\s+(high|low)\b/g,
                    ) ?? []).length;
                if (usdHits >= 3 && priceLabels >= 1) return true;
                if (/\bprice:\s*\$?\d/i.test(sample) && /\bvolume\b/i.test(sample) && /\b(high|low)\s+price\b/i.test(sample)) {
                    return true;
                }
                const titleMarkers = (sample.match(/\b(title|📰|date:|summary:|🔗\s*url:)\b/gi) ?? []).length;
                if (titleMarkers >= 4) return true;
                return false;
            };

            const pickBestAssistantAnswer = (): string => {
                const reversed = [...recent].reverse();

                const lastUserQuestion = (() => {
                    for (const memory of reversed) {
                        if (memory.userId === runtime.agentId) continue;
                        const cleaned = stripMarkdownForSummary(getMemoryText(memory)).trim();
                        if (cleaned.length >= 12) return cleaned.slice(0, 400);
                    }
                    const lastUserLine =
                        [...transcriptLines].reverse().find((line) => line.startsWith("User: ")) ?? "";
                    return stripMarkdownForSummary(lastUserLine.replace(/^User:\s*/, "")).trim().slice(0, 400);
                })();

                const detectWorkflowMode = (): "task_chain" | "comprehensive" | "unknown" => {
                    for (const memory of reversed) {
                        if (memory.userId !== runtime.agentId) continue;
                        const source = getMemorySource(memory);
                        if (source === "task_chain_summary" || source === "task_chain_action" || source === "task_chain_planning") {
                            return "task_chain";
                        }
                        if (source === "comprehensive_analysis") {
                            return "comprehensive";
                        }
                    }
                    return "unknown";
                };

                const workflowMode = detectWorkflowMode();

                // Prefer "normal" assistant responses over workflow/status memories.
                for (const memory of reversed) {
                    if (memory.userId !== runtime.agentId) continue;
                    const source = getMemorySource(memory);
                    if (source === "task_chain_action" || source === "task_chain_planning") continue;
                    const cleaned = stripMarkdownForSummary(getMemoryText(memory)).trim();
                    if (isInterruptionOrStatusText(cleaned)) continue;
                    if (isLikelyStructuredMarketOrNewsBlob(cleaned)) continue;
                    if (isShareProcessOrCompletionBoilerplate(cleaned)) continue;
                    if (cleaned.length >= 40) {
                        return cleaned;
                    }
                }

                // If this was a task-chain run, try to synthesize an "answer" from the snapshot.
                for (const memory of reversed) {
                    if (memory.userId !== runtime.agentId) continue;
                    const source = getMemorySource(memory);
                    if (source !== "task_chain_summary") continue;
                    const meta = (memory.content?.metadata as any) || {};
                    const snapshot = meta.taskChainSnapshot as any;
                    if (!snapshot || typeof snapshot !== "object") continue;

                    const title = typeof snapshot.title === "string" ? snapshot.title : "Task Chain";
                    const completion = snapshot.completionInfo || {};
                    const completedTasks = Number(completion.completedTasks ?? 0);
                    const totalTasks = Number(completion.totalTasks ?? 0);
                    const overallStatus = String(completion.overallStatus ?? "completed");
                    const originalRequest =
                        typeof snapshot.taskChainData?.originalRequest === "string"
                            ? snapshot.taskChainData.originalRequest
                            : typeof snapshot.taskChainData?.description === "string"
                              ? snapshot.taskChainData.description
                              : "";

                    const executionResults = Array.isArray(snapshot.executionResults)
                        ? snapshot.executionResults
                        : [];
                    const successful = executionResults
                        .filter((r: any) => r?.status === "completed")
                        .slice(0, 3)
                        .map((r: any) => {
                            const name = String(r?.taskName ?? "Task").trim();
                            const resultText = stripMarkdownForSummary(getMemoryText(r?.result ?? {})).trim();
                            const snippet = resultText ? resultText.slice(0, 280) : "";
                            if (snippet && isLikelyStructuredMarketOrNewsBlob(snippet)) {
                                return name;
                            }
                            if (snippet && isShareProcessOrCompletionBoilerplate(snippet)) {
                                return name;
                            }
                            return snippet ? `${name}: ${snippet}` : name;
                        })
                        .filter(Boolean);

                    const synthesized = [
                        originalRequest ? `Goal: ${stripMarkdownForSummary(originalRequest).slice(0, 240)}` : "",
                        `${title} finished (${overallStatus}).`,
                        totalTasks > 0 ? `Completed ${completedTasks} of ${totalTasks} tasks.` : "",
                        successful.length > 0 ? successful.join(" ") : "",
                    ]
                        .filter(Boolean)
                        .join(" ");

                    const cleaned = stripMarkdownForSummary(synthesized).trim();
                    if (cleaned.length >= 40) return cleaned;
                }

                // Comprehensive analysis: try to pick the writing-report phase first.
                for (const memory of reversed) {
                    if (memory.userId !== runtime.agentId) continue;
                    const source = getMemorySource(memory);
                    if (source !== "comprehensive_analysis") continue;
                    const meta = (memory.content?.metadata as any) || {};
                    const snapshot = meta.comprehensiveSnapshot as any;
                    if (!snapshot || typeof snapshot !== "object") continue;
                    const rawActionResults = Array.isArray(snapshot.actionResults) ? snapshot.actionResults : [];
                    const slimSummaries = Array.isArray(snapshot.actionResultSummaries)
                        ? snapshot.actionResultSummaries
                        : [];
                    const actionResults =
                        rawActionResults.length > 0
                            ? rawActionResults
                            : slimSummaries.map((s: any) => ({
                                  phase: typeof s?.phase === "string" ? s.phase : "",
                                  status: s?.status,
                                  summary: typeof s?.summary === "string" ? s.summary : "",
                                  content: typeof s?.contentText === "string" ? s.contentText : "",
                              }));
                    if (actionResults.length === 0) continue;

                    const scored: Array<{ text: string; score: number }> = [];
                    for (const item of actionResults) {
                        const phase = typeof item?.phase === "string" ? item.phase : "";
                        const status = typeof item?.status === "string" ? item.status : "";
                        if (status && status !== "success") continue;
                        const summary = typeof item?.summary === "string" ? item.summary : "";
                        const content = typeof item?.content === "string" ? item.content : "";
                        const candidate = stripMarkdownForSummary(summary || content).trim();
                        if (!candidate) continue;
                        if (isInterruptionOrStatusText(candidate)) continue;
                        if (isLikelyStructuredMarketOrNewsBlob(candidate)) continue;
                        if (isShareProcessOrCompletionBoilerplate(candidate)) continue;
                        let score = 0;
                        if (phase === "writing_report") score += 6;
                        if (phase === "prediction") score += 3;
                        if (phase === "analysis") score += 2;
                        score += Math.min(2, Math.floor(candidate.length / 400));
                        scored.push({ text: candidate, score });
                    }
                    scored.sort((a, b) => b.score - a.score);

                    const top = scored.slice(0, 4).map((x) => x.text.slice(0, 320));
                    const synthesized = [
                        lastUserQuestion ? `User asked: ${lastUserQuestion}` : "",
                        top.length > 0 ? `Key findings: ${top.join(" ")}` : "",
                    ]
                        .filter(Boolean)
                        .join("\n");

                    const cleaned = stripMarkdownForSummary(synthesized).trim();
                    if (cleaned.length >= 60) return cleaned;
                }

                const comprehensiveCandidates: Array<{ text: string; score: number }> = [];
                for (const memory of reversed) {
                    if (memory.userId !== runtime.agentId) continue;
                    const source = getMemorySource(memory);
                    if (source !== "comprehensive_analysis") continue;
                    const meta = (memory.content?.metadata as any) || {};
                    const phase = typeof meta.phase === "string" ? meta.phase : "";
                    const actionName = typeof meta.actionName === "string" ? meta.actionName : "";
                    const raw = stripMarkdownForSummary(getMemoryText(memory)).trim();
                    if (!raw) continue;
                    if (isInterruptionOrStatusText(raw)) continue;
                    if (isShareProcessOrCompletionBoilerplate(raw)) continue;
                    let score = 0;
                    if (phase === "writing_report") score += 5;
                    if (/report|summary|conclusion/i.test(actionName)) score += 3;
                    if (/report|summary|conclusion/i.test(raw)) score += 2;
                    score += Math.min(3, Math.floor(raw.length / 500));
                    comprehensiveCandidates.push({ text: raw, score });
                }
                comprehensiveCandidates.sort((a, b) => b.score - a.score);
                const bestComprehensive = comprehensiveCandidates[0]?.text ?? "";
                if (
                    bestComprehensive.length >= 40 &&
                    !isLikelyStructuredMarketOrNewsBlob(bestComprehensive) &&
                    !isShareProcessOrCompletionBoilerplate(bestComprehensive)
                ) {
                    // Anchor the summary to the original question so the share text stays meaningful.
                    // The system prompt still forbids including the question verbatim in the output.
                    return lastUserQuestion
                        ? `User asked: ${lastUserQuestion}\n\nAssistant response:\n${bestComprehensive}`
                        : bestComprehensive;
                }

                // If we're in a workflow mode and we still don't have a good answer body,
                // synthesize from the question + the most informative workflow lines.
                if (workflowMode !== "unknown") {
                    const highlights: string[] = [];
                    for (const memory of reversed) {
                        if (memory.userId !== runtime.agentId) continue;
                        const source = getMemorySource(memory);
                        if (workflowMode === "comprehensive" && source !== "comprehensive_analysis") continue;
                        if (workflowMode === "task_chain" && source !== "task_chain_summary" && source !== "task_chain_action") continue;
                        const meta = (memory.content?.metadata as any) || {};
                        const actionName = typeof meta.actionName === "string" ? meta.actionName.trim() : "";
                        const text = stripMarkdownForSummary(getMemoryText(memory)).trim();
                        if (!text) continue;
                        if (isInterruptionOrStatusText(text)) continue;
                        const snippet = text.slice(0, 240);
                        if (isLikelyStructuredMarketOrNewsBlob(snippet)) continue;
                        if (isShareProcessOrCompletionBoilerplate(snippet)) continue;
                        const line = actionName ? `${actionName}: ${snippet}` : snippet;
                        highlights.push(line);
                        if (highlights.length >= 4) break;
                    }

                    const synthesized = [
                        lastUserQuestion ? `User asked: ${lastUserQuestion}` : "",
                        highlights.length > 0 ? `Key results: ${highlights.join(" ")}` : "",
                    ]
                        .filter(Boolean)
                        .join("\n");

                    const cleaned = stripMarkdownForSummary(synthesized).trim();
                    if (cleaned.length >= 40) return cleaned;
                }

                // Final fallback: last assistant line from the transcript we already built.
                const lastAssistantLine =
                    [...transcriptLines].reverse().find((line) => line.startsWith("Assistant: ")) ?? "";
                const finalCleaned = stripMarkdownForSummary(lastAssistantLine.replace(/^Assistant:\s*/, "")).trim();
                if (isInterruptionOrStatusText(finalCleaned)) return "";
                if (isLikelyStructuredMarketOrNewsBlob(finalCleaned)) return "";
                if (isShareProcessOrCompletionBoilerplate(finalCleaned)) return "";
                if (finalCleaned) return finalCleaned;

                for (const memory of reversed) {
                    if (memory.userId !== runtime.agentId) continue;
                    if (getMemorySource(memory) !== "comprehensive_analysis") continue;
                    const meta = (memory.content?.metadata as any) || {};
                    const labelRaw =
                        (typeof meta.cryptoName === "string" && meta.cryptoName.trim()) ||
                        (typeof meta.target === "string" && meta.target.trim()) ||
                        "";
                    if (!labelRaw) continue;
                    if (lastUserQuestion.length >= 10) {
                        return `User asked: ${lastUserQuestion}\n\nAssistant: Produced a full analysis and report for ${labelRaw} (market data, sentiment, and outlook—details in the linked chat).`;
                    }
                    return `Assistant: Produced a full analysis and report for ${labelRaw} (market data, sentiment, and outlook—details in the linked chat).`;
                }

                return "";
            };

            const answerForPrompt = pickBestAssistantAnswer().slice(0, 2500);
            const promptBodyLength = collapseWhitespace(answerForPrompt).length;

            // If we don't have enough meaningful content to summarize, skip the model and use heuristics.
            // This avoids generic model outputs like "completed the taskchain" with no substance.
            const shouldSkipModel = promptBodyLength < 120;

            if (promptBodyLength === 0) {
                elizaLogger.debug("share-summary: no assistant body to summarize; using fallbacks");
            }

	            let summary = "";
                if (!shouldSkipModel) {
	                try {
	                    summary = await generateSummaryViaModel(claudeRuntime, answerForPrompt);
	                } catch (error) {
	                    elizaLogger.warn("Claude share-summary generation failed; using fallback summary.", error);
	                    summary = "";
	                }
                }

            summary = normalizeSummary(summary);

                const isGenericSummary = (value: string): boolean => {
                    const normalized = collapseWhitespace(value).toLowerCase();
                    if (!normalized) return true;
                    return (
                        normalized.includes("completed the taskchain") ||
                        normalized.includes("completed the task chain") ||
                        normalized.includes("could not complete") ||
                        normalized.includes("user interruptions") ||
                        normalized.includes("summary is to be provided") ||
                        normalized.includes("exactly two sentences") ||
                        normalized.includes("taskchain accomplished") ||
                        normalized.includes("task chain accomplished") ||
                        normalized.includes("comprehensive finished") ||
                        isSearchResultMetaText(value) ||
                        hasTaskCountPattern(value) ||
                        normalized.includes("comprehensive analysis complete") ||
                        normalized.includes("mandatory actions") ||
                        normalized.includes("data collection phase") ||
                        isShareProcessOrCompletionBoilerplate(value)
                    );
                };

                if (summary && isGenericSummary(summary)) {
                    summary = "";
                }

	            if (!summary) {
	                try {
                        if (!shouldSkipModel) {
	                        summary = await generateSummaryViaModel(runtime, answerForPrompt);
                        } else {
                            summary = "";
                        }
	                } catch (error) {
	                    elizaLogger.warn("Fallback share-summary generation failed; using heuristic fallback.", error);
	                    summary = "";
	                }
	                summary = normalizeSummary(summary);
	            }

	            // Final guardrails: one concise sentence, <= MAX_SUMMARY_WORDS.
	            summary = normalizeSummary(summary);
	            if (countWords(summary) > MAX_SUMMARY_WORDS) {
	                summary = enforceMaxWords(summary, MAX_SUMMARY_WORDS);
	            }

	            if (!summary) {
                    const lastUserLine =
                        [...transcriptLines].reverse().find((line) => line.startsWith("User: ")) ?? "";
                    const uq = stripMarkdownForSummary(lastUserLine.replace(/^User:\s*/, "")).trim();
                    if (uq.length >= 15) {
                        summary = normalizeSummary(
                            [
                                `The discussion focuses on: ${uq.slice(0, 320)}.`,
                                "An overview of this topic is available in the linked conversation.",
                            ].join(" "),
                        );
                    }
                }
                if (!summary) {
                    // Heuristic fallback from the best available content (often the task-chain snapshot synthesis).
                    summary = toTwoSentences(answerForPrompt) || fallbackSummary();
                }

                const intentSummary = buildIntentSummaryFromUser();
                const assistantIntentSummary = toIntentSentence(getRecentMeaningfulAssistantTopic(), findAssetLabel());
                if (intentSummary) {
                    if (!summary || isGenericSummary(summary) || isShareProcessOrCompletionBoilerplate(summary)) {
                        summary = intentSummary;
                    }
                }
                if (
                    (!summary || isGenericSummary(summary) || isShareProcessOrCompletionBoilerplate(summary)) &&
                    assistantIntentSummary
                ) {
                    summary = enforceMaxWords(assistantIntentSummary, MAX_SUMMARY_WORDS);
                }

            res.json({
                success: true,
                title: deriveShareTitle(),
                summary,
            });
        } catch (error) {
            elizaLogger.error("Error generating share summary:", error);
            res.status(500).json({ error: "Failed to generate share summary" });
        }
    });

    router.get("/shared-chats/:shareCode", async (req, res) => {
        const rawCode = (req.params.shareCode ?? "").trim();
        if (!rawCode) {
            res.status(400).json({ error: "shareCode is required" });
            return;
        }

        const normalizedCode = rawCode.toUpperCase();
        if (!/^[A-Z0-9]{10}$/.test(normalizedCode)) {
            res.status(400).json({ error: "Invalid share code format" });
            return;
        }

        let sharedRecord: SharedChatRecord | null = null;
        let sharedRuntime: AgentRuntime | null = null;

        for (const runtime of agents.values()) {
            try {
                    const candidate = await getSharedChatByCodeCompat(
                        runtime.databaseAdapter,
                        normalizedCode
                    );
                    if (candidate) {
                        sharedRecord = candidate;
                        sharedRuntime = runtime;
                        break;
                    }
            } catch (error) {
                elizaLogger.warn(
                    `Error querying shared chat for agent ${runtime.agentId}:`,
                    error
                );
            }
        }

        if (!sharedRecord || !sharedRuntime) {
            res.status(404).json({ error: "Shared chat not found" });
            return;
        }

        try {
            const roomExists = await sharedRuntime.databaseAdapter.getRoom(sharedRecord.roomId);
            if (!roomExists) {
                res.status(404).json({ error: "Shared chat room not found" });
                return;
            }

            const memories = await sharedRuntime.messageManager.getMemories({
                roomId: sharedRecord.roomId,
                unique: false,
                count: 200,
            });

	            res.json({
	                success: true,
	                share: serializeSharedChatRecord(sharedRecord),
	                memories: memories.map((memory) => buildPublicSharedMemoryPayload(req, memory)),
	            });
        } catch (error) {
            elizaLogger.error("Error loading shared chat:", error);
            res.status(500).json({ error: "Failed to load shared chat" });
        }
    });

    router.get("/shared-rooms/:agentId/:roomId", authMiddleware, async (req, res) => {
        const { agentId, roomId } = validateUUIDParams(req.params, res) ?? {
            agentId: null,
            roomId: null,
        };
        if (!agentId || !roomId) return;

        const runtime = agents.get(agentId);
        if (!runtime) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        try {
            const requestUserInfo = (req as any).userInfo ?? getUserInfo(req);
            const requestUserId = (req as any).userId ?? getUserId(req);

            if (!requestUserInfo || !requestUserId) {
                res.status(401).json({ error: "Authentication required" });
                return;
            }

            const participantRoomIds = await runtime.databaseAdapter.getRoomsForParticipant(
                requestUserId,
                runtime.agentId,
            );

            if (!participantRoomIds.includes(roomId)) {
                res.status(403).json({ error: "Access to this room is not permitted" });
                return;
            }

            const roomExists = await runtime.databaseAdapter.getRoom(roomId);
            if (!roomExists) {
                res.status(404).json({ error: "Room not found" });
                return;
            }

            const memories = await runtime.messageManager.getMemories({
                roomId,
                unique: false,
                count: 250,
            });

            const room =
                typeof (runtime.databaseAdapter as any).getRoomById === "function"
                    ? await (runtime.databaseAdapter as any).getRoomById(roomId)
                    : null;

	            res.json({
	                success: true,
	                agentId: runtime.agentId,
	                roomId,
	                room,
	                shareAgentId: runtime.agentId,
	                memories: memories.map((memory) => buildPublicSharedMemoryPayload(req, memory)),
	            });
        } catch (error) {
            elizaLogger.error("Error loading shared room:", error);
            res.status(500).json({ error: "Failed to load shared room" });
        }
    });

    // Delete a file from allowed storage directories
    router.delete("/files", requireAuth, async (req, res) => {
        try {
            elizaLogger.info("DELETE /files endpoint called");
            elizaLogger.info("Request body:", req.body);

            const { filePath, agentId, roomId } = req.body;

            if (!filePath) {
                elizaLogger.error("No filePath provided in request");
                res.status(400).json({ error: "filePath is required" });
                return;
            }

            elizaLogger.info(`Attempting to delete file: ${filePath}`);

            // Ensure the file path is within the saved_data directory for security (path traversal prevention)
            const safeBase = path.resolve(process.cwd(), 'saved_data');
            const fullPath = path.resolve(safeBase, filePath.replace(/^saved_data[\\/]/, ''));
            if (!fullPath.startsWith(safeBase + path.sep)) {
                elizaLogger.error(`Invalid file path (traversal attempt): ${filePath}`);
                res.status(400).json({ error: 'Invalid file path' });
                return;
            }
            elizaLogger.info(`Full path: ${fullPath}`);

            // Check if file exists
            if (!fs.existsSync(fullPath)) {
                elizaLogger.error(`File not found: ${fullPath}`);
                res.status(404).json({ error: "File not found" });
                return;
            }

            // Delete the file
            fs.unlinkSync(fullPath);
            elizaLogger.info(`Successfully deleted file: ${fullPath}`);

            res.json({ success: true, message: "File deleted successfully" });
        } catch (error) {
            elizaLogger.error("Error deleting file:", error);
            res.status(500).json({ error: "Failed to delete file", details: error.message });
        }
    });

    // Room management endpoints
    router.post("/agents/:agentId/rooms", authMiddleware, async (req, res) => {
        const { agentId } = validateUUIDParams(req.params, res) ?? {
            agentId: null,
        };
        if (!agentId) return;

        const runtime = agents.get(agentId);
        if (!runtime) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        try {
            const userInfo = (req as any).userInfo;
            const userId = (req as any).userId;
            if (!userId) {
                res.status(400).json({ error: "Unable to resolve user identity" });
                return;
            }

            const authenticatedEmail =
                typeof userInfo?.email === "string" && userInfo.email.trim().length > 0
                    ? normalizeEmail(userInfo.email)
                    : null;
            const isAuthenticated = authenticatedEmail !== null;
            const fallbackIdentifier =
                typeof userInfo?.ip === "string"
                    ? userInfo.ip.replace(/[^a-zA-Z0-9._-]/g, "-")
                    : userId.slice(0, 8);
            const accountUsername = isAuthenticated
                ? authenticatedEmail
                : `anon-${fallbackIdentifier}`;
            const accountName = isAuthenticated
                ? authenticatedEmail
                : "Anonymous User";
            const accountEmail = isAuthenticated
                ? authenticatedEmail
                : `${userId}@anonymous.local`;

            await runtime.ensureUserExists(
                userId,
                accountUsername,
                accountName,
                accountEmail,
                isAuthenticated ? "auth" : "ip"
            );

            const { name } = req.body;
            const roomName = name || formatDefaultRoomName();
            // Create agent-specific room by passing agentId
            const roomId = await runtime.databaseAdapter.createRoom(undefined, roomName, runtime.agentId);

            // Add the user as a participant to the new room - use email-based ID (or IP fallback) and agentId for isolation
            if (isAuthenticated) {
                elizaLogger.info(`🔐 Creating agent-specific room for ${authenticatedEmail} -> userId: ${userId}, agentId: ${runtime.agentId}`);
            } else {
                elizaLogger.info(`🌐 Creating agent-specific room for anonymous user -> userId: ${userId}, agentId: ${runtime.agentId}`);
            }
            const participantAdded = await runtime.databaseAdapter.addParticipant(
                userId,
                roomId,
                runtime.agentId
            );
            if (!participantAdded) {
                throw new Error("Failed to add participant to new room");
            }

            res.json({
                success: true,
                room: {
                    id: roomId,
                    name: roomName,
                    createdAt: Date.now()
                }
            });

            // Fire-and-forget: prune this user's auto-named rooms with 0 messages and >24h old.
            // User-renamed rooms (anything not matching the "Chat YYYY-MM-DD HH:MM" pattern) are preserved.
            pruneEmptyRooms(runtime, runtime.agentId, userId).catch(() => {});
        } catch (error) {
            elizaLogger.error("Error creating room:", error);
            res.status(500).json({ error: "Failed to create room" });
        }
    });

    router.get("/agents/:agentId/rooms", authMiddleware, async (req, res) => {
        const { agentId } = validateUUIDParams(req.params, res) ?? {
            agentId: null,
        };
        if (!agentId) return;

        const runtime = agents.get(agentId);
        if (!runtime) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        try {
            const userId = (req as any).userId;
            const userInfo = (req as any).userInfo;
            let roomIds: UUID[];
            if (userInfo.type === 'authenticated') {
                elizaLogger.info(`🔐 Getting agent-specific rooms for ${userInfo.email} -> userId: ${userId}, agentId: ${runtime.agentId}`);
                roomIds = await runtime.databaseAdapter.getRoomsForParticipant(userId, runtime.agentId);
            } else {
                elizaLogger.info(`🌐 Getting agent-specific rooms for IP: ${userInfo.ip} -> userId: ${userId}, agentId: ${runtime.agentId}`);
                const cleanupResult = await cleanupAnonymousHistoryIfExpired({ runtime, userId });
                roomIds = cleanupResult.cleaned ? [] : cleanupResult.roomIds;
                // [persist] Diagnostic: confirms the IP-derived userId is stable
                // across refreshes and that the user's rooms are found. Compare
                // userId between two refreshes — a shift means the IP key moved.
                elizaLogger.info(
                    `🌐 [persist] anon rooms resolved: userId=${userId} ip=${userInfo.ip} count=${roomIds.length} cleaned=${cleanupResult.cleaned}`,
                );
                if (cleanupResult.cleaned) {
                    const lastActivityIso = cleanupResult.lastActivity
                        ? new Date(cleanupResult.lastActivity).toISOString()
                        : "unknown";
                    elizaLogger.info(
                        `🧹 Cleared stale history for anonymous user ${userId} before listing rooms (last activity: ${lastActivityIso}, rooms: ${cleanupResult.cleanedRoomIds.join(
                            ", ",
                        ) || "none"})`,
                    );
                }
            }
            
            // Get room details and recent messages for each room
            // Process in chunks to avoid overwhelming MongoDB with concurrent sorts
            const parseCreatedAt = (raw: unknown): number => {
                if (typeof raw === "number") {
                    return Number.isFinite(raw) ? raw : Number.NaN;
                }
                if (typeof raw === "string") {
                    if (/^\d+$/.test(raw)) {
                        const n = Number(raw);
                        return Number.isFinite(n) ? n : Number.NaN;
                    }
                    return new Date(raw).getTime();
                }
                return Number.NaN;
            };

            const rooms = [];
            const chunkSize = 5;
            for (let i = 0; i < roomIds.length; i += chunkSize) {
                const chunk = roomIds.slice(i, i + chunkSize);
                const chunkResults = await Promise.all(chunk.map(async (roomId) => {
                    let roomData;
                    try {
                        roomData = await runtime.databaseAdapter.getRoomById(roomId);
                    } catch (error) {
                        elizaLogger.error(`Error getting room metadata for ${roomId}:`, error);
                        return null;
                    }

                    try {
                        const memories = await runtime.messageManager.getMemories({
                            roomId,
                            count: 1,
                            unique: false,
                        });
                        
                        const lastMessage = memories[0];
                        const createdAtMs = parseCreatedAt(roomData?.createdAt);
                        // Happy path: fall back to Date.now() so the room always appears in the list
                        return {
                            id: roomId,
                            name: roomData?.name || `Chat ${roomId.slice(-8)}`,
                            createdAt: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
                            lastMessage: lastMessage ? {
                                text: (() => {
                                    const raw = lastMessage.content.text;
                                    if (raw === null || raw === undefined) return '';
                                    let str: string;
                                    if (typeof raw === 'object') {
                                        str = typeof (raw as any).text === 'string' ? (raw as any).text : JSON.stringify(raw);
                                    } else {
                                        str = String(raw);
                                        try {
                                            const parsed = JSON.parse(str);
                                            if (typeof parsed?.text === 'string') str = parsed.text;
                                        } catch { /* keep str */ }
                                    }
                                    // Strip the executive-summary marker block — it lives in the
                                    // analysis markdown for the extractor but should never appear
                                    // in sidebar previews or any other plain-text rendering.
                                    return str.replace(
                                        /<!--\s*EXEC_SUMMARY_START\s*-->[\s\S]*?<!--\s*EXEC_SUMMARY_END\s*-->\s*/i,
                                        '',
                                    );
                                })(),
                                createdAt: lastMessage.createdAt
                            } : null,
                            messageCount: await runtime.messageManager.countMemories(roomId)
                        };
                    } catch (error) {
                        elizaLogger.error(`Error getting room details for ${roomId}:`, error);
                        
                        const createdAtMs = parseCreatedAt(roomData?.createdAt);
                        // Error path: only keep the room if we have a real historic timestamp;
                        // without one we'd fabricate a misleading entry — prefer dropping it.
                        if (!Number.isFinite(createdAtMs)) {
                            return null;
                        }

                        return {
                            id: roomId,
                            name: roomData?.name || `Chat ${roomId.slice(-8)}`,
                            createdAt: createdAtMs,
                            lastMessage: null,
                            messageCount: 0
                        };
                    }
                }));
                rooms.push(...chunkResults.filter(r => r !== null));
            }

            res.json({ success: true, rooms });
        } catch (error) {
            elizaLogger.error("Error fetching rooms:", error);
            res.status(500).json({ error: "Failed to fetch rooms" });
        }
    });

    router.delete("/agents/:agentId/rooms/:roomId", requireAuth, async (req, res) => {
        const { agentId, roomId } = validateUUIDParams(req.params, res) ?? {
            agentId: null,
            roomId: null,
        };
        if (!agentId || !roomId) return;

        const runtime = agents.get(agentId);
        if (!runtime) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        // H5: Verify caller is a participant of this room
        const callerId = (req as any).userId ?? getUserId(req);
        const participantRooms = await runtime.databaseAdapter.getRoomsForParticipant(callerId, runtime.agentId);
        if (!participantRooms.includes(roomId as any)) {
            res.status(403).json({ error: "Forbidden: you are not a participant of this room" });
            return;
        }

        try {
            elizaLogger.info(`🗑️ Starting comprehensive room deletion for room: ${roomId}`);

            // Remove all memories in the room (all types to satisfy FK constraints)
            await runtime.databaseAdapter.removeAllMemoriesByRoom(roomId);
            elizaLogger.info(`✅ Removed all memories for room: ${roomId}`);

            // Remove all goals in the room
            await runtime.databaseAdapter.removeAllGoals(roomId);
            elizaLogger.info(`✅ Removed all goals for room: ${roomId}`);

            // Remove all logs in the room
            await runtime.databaseAdapter.removeLogsByRoom(roomId);
            elizaLogger.info(`✅ Removed all logs for room: ${roomId}`);

            // Remove all participants from the room
            await runtime.databaseAdapter.removeParticipantsByRoom(roomId);
            elizaLogger.info(`✅ Removed all participants for room: ${roomId}`);

            // Remove the room itself
            await runtime.databaseAdapter.removeRoom(roomId);
            elizaLogger.info(`✅ Removed room record: ${roomId}`);
            elizaLogger.info(`🎉 Successfully deleted room ${roomId} and all related data`);
            res.json({ success: true, message: "Room and all related data deleted successfully" });
        } catch (error) {
            elizaLogger.error("Error deleting room:", error);
            res.status(500).json({ error: "Failed to delete room" });
        }
    });

    router.post("/agents/:agentId/rooms/batch-delete", authMiddleware, async (req, res) => {
        const { agentId } = validateUUIDParams(req.params, res) ?? {
            agentId: null,
        };
        if (!agentId) return;

        const { roomIds } = req.body;
        if (!Array.isArray(roomIds) || roomIds.length === 0) {
            res.status(400).json({ error: "roomIds must be a non-empty array" });
            return;
        }

        const runtime = agents.get(agentId);
        if (!runtime) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        const requestUserInfo = (req as any).userInfo ?? getUserInfo(req);
        const requestUserId = (req as any).userId ?? getUserId(req);

        if (!requestUserInfo || !requestUserId) {
            res.status(401).json({ error: "Authentication required" });
            return;
        }

        const participantRoomIds = await runtime.databaseAdapter.getRoomsForParticipant(
            requestUserId,
            runtime.agentId,
        );
        const participantRoomSet = new Set(participantRoomIds);
        const unauthorizedRoomIds = roomIds.filter((roomId) => !participantRoomSet.has(roomId));

        if (unauthorizedRoomIds.length > 0) {
            res.status(403).json({
                error: "Access denied for one or more rooms",
                unauthorizedRoomIds,
            });
            return;
        }

        const results: Array<{ roomId: string; success: boolean; error?: string }> = [];
        let successCount = 0;

        elizaLogger.info(`🗑️ Starting batch room deletion for ${roomIds.length} rooms`);

        for (const roomId of roomIds) {
            try {
                elizaLogger.info(`🗑️ Deleting room: ${roomId}`);

                // Remove all memories in the room (all types to satisfy FK constraints)
                await runtime.databaseAdapter.removeAllMemoriesByRoom(roomId);

                // Remove all goals in the room
                await runtime.databaseAdapter.removeAllGoals(roomId);

                // Remove all logs in the room
                await runtime.databaseAdapter.removeLogsByRoom(roomId);

                // Remove all participants from the room
                await runtime.databaseAdapter.removeParticipantsByRoom(roomId);

                // Remove the room itself
                await runtime.databaseAdapter.removeRoom(roomId);

                elizaLogger.info(`✅ Successfully deleted room: ${roomId}`);
                results.push({ roomId, success: true });
                successCount++;
            } catch (error) {
                elizaLogger.error(`❌ Error deleting room ${roomId}:`, error);
                results.push({
                    roomId,
                    success: false,
                    error: error instanceof Error ? error.message : "Failed to delete room"
                });
            }
        }

        const message = successCount === roomIds.length
            ? `Successfully deleted all ${successCount} rooms`
            : `Deleted ${successCount} of ${roomIds.length} rooms`;

        elizaLogger.info(`🎉 Batch deletion complete: ${message}`);

        res.json({
            success: successCount === roomIds.length,
            message,
            results
        });
    });

    router.put("/agents/:agentId/rooms/:roomId", requireAuth, async (req, res) => {
        const { agentId, roomId } = validateUUIDParams(req.params, res) ?? {
            agentId: null,
            roomId: null,
        };
        if (!agentId || !roomId) return;

        const runtime = agents.get(agentId);
        if (!runtime) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        // H6: Verify caller is a participant of this room
        const callerId = (req as any).userId ?? getUserId(req);
        const participantRooms = await runtime.databaseAdapter.getRoomsForParticipant(callerId, runtime.agentId);
        if (!participantRooms.includes(roomId as any)) {
            res.status(403).json({ error: "Forbidden: you are not a participant of this room" });
            return;
        }

        try {
            const { name } = req.body;

            if (!name || typeof name !== 'string' || !name.trim()) {
                res.status(400).json({ error: "Room name is required and must be a non-empty string" });
                return;
            }

            elizaLogger.info(`✏️ Renaming room ${roomId} to: ${name}`);

            // Update the room name
            await runtime.databaseAdapter.updateRoomName(roomId, name.trim());
            elizaLogger.info(`✅ Successfully renamed room ${roomId} to: ${name}`);

            res.json({
                success: true,
                message: "Room renamed successfully",
                room: {
                    id: roomId,
                    name: name.trim()
                }
            });
        } catch (error) {
            elizaLogger.error("Error renaming room:", error);
            res.status(500).json({ error: "Failed to rename room" });
        }
    });

    router.post("/anonymous/cleanup", requireAuth, async (req, res) => {
        try {
            const { force } = req.body ?? {};
            const userId = getUserIdFromIP(req);
            const results: Array<{ agentId: UUID; cleanedRooms: UUID[] }> = [];

            for (const runtime of agents.values()) {
                const cleanupResult = await cleanupAnonymousHistoryIfExpired({
                    runtime,
                    userId,
                    force: Boolean(force),
                });

                if (cleanupResult.cleaned) {
                    results.push({
                        agentId: runtime.agentId,
                        cleanedRooms: cleanupResult.cleanedRoomIds,
                    });
                }
            }

            res.json({
                success: true,
                cleaned: results.length > 0,
                results,
            });
        } catch (error) {
            elizaLogger.error("Error force-clearing anonymous history:", error);
            res.status(500).json({ success: false, error: "Failed to clear anonymous history" });
        }
    });

    router.post("/enterprise-inquiry", async (req, res) => {
        try {
            const { email, description } = req.body;

            if (!email || typeof email !== 'string' || !email.trim()) {
                return res.status(400).json({
                    success: false,
                    error: "Email is required"
                });
            }

            const timestamp = new Date().toISOString();

            // Get SMTP configuration from environment variables
            const smtpHost = getEnvVariable("SMTP_HOST");
            const smtpPort = getEnvVariable("SMTP_PORT");
            const smtpUser = getEnvVariable("SMTP_USER");
            const smtpPassword = getEnvVariable("SMTP_PASSWORD");

            // Check if SMTP is configured
            if (!smtpHost || !smtpPort || !smtpUser || !smtpPassword) {
                elizaLogger.warn("SMTP not configured, logging enterprise inquiry instead");
                elizaLogger.info(`Enterprise inquiry from ${email}:\n${description || 'No description provided'}`);

                return res.json({
                    success: true,
                    message: "Enterprise inquiry received and logged",
                });
            }

            // Create nodemailer transporter
            const transporter = nodemailer.createTransport({
                host: smtpHost,
                port: Number.parseInt(smtpPort, 10),
                secure: Number.parseInt(smtpPort, 10) === 465,
                auth: {
                    user: smtpUser,
                    pass: smtpPassword,
                },
            });

            // Prepare email content
            const emailHtml = `
                <h2>Enterprise Plan Inquiry</h2>
                <p><strong>Email:</strong> ${email}</p>
                <p><strong>Timestamp:</strong> ${timestamp}</p>
                <hr>
                <h3>Description:</h3>
                <p>${description ? description.replace(/\n/g, '<br>') : 'No description provided'}</p>
            `;

            const emailText = `
Enterprise Plan Inquiry

Email: ${email}
Timestamp: ${timestamp}

Description:
${description || 'No description provided'}
            `;

            // Send email
            await transporter.sendMail({
                from: smtpUser,
                to: "support@sentiedge.ai",
                subject: `Enterprise Plan Inquiry from ${email}`,
                text: emailText,
                html: emailHtml,
            });

            elizaLogger.info(`Enterprise inquiry email sent successfully from ${email}`);

            res.json({
                success: true,
                message: "Enterprise inquiry sent successfully",
            });
        } catch (error) {
            elizaLogger.error("Error sending enterprise inquiry:", error);
            res.status(500).json({
                success: false,
                error: "Failed to send enterprise inquiry"
            });
        }
    });

    router.post("/feedback", async (req, res) => {
        try {
            const { feedback } = req.body;

            if (!feedback || typeof feedback !== 'string' || !feedback.trim()) {
                return res.status(400).json({
                    success: false,
                    error: "Feedback text is required"
                });
            }

            if (feedback.length > 5000) {
                return res.status(400).json({
                    success: false,
                    error: "Feedback too long (max 5000 characters)"
                });
            }

            const userInfo = getUserInfo(req);
            const userId = getUserId(req);
            const timestamp = new Date().toISOString();

            // Get SMTP configuration from environment variables
            const smtpHost = getEnvVariable("SMTP_HOST");
            const smtpPort = getEnvVariable("SMTP_PORT");
            const smtpUser = getEnvVariable("SMTP_USER");
            const smtpPassword = getEnvVariable("SMTP_PASSWORD");

            // Check if SMTP is configured
            if (!smtpHost || !smtpPort || !smtpUser || !smtpPassword) {
                elizaLogger.warn("SMTP not configured, logging feedback instead");
                elizaLogger.info(`Feedback from ${userInfo.type === 'authenticated' ? userInfo.email : userInfo.ip}:\n${feedback}`);

                return res.json({
                    success: true,
                    message: "Feedback received and logged",
                });
            }

            // Create nodemailer transporter
            const transporter = nodemailer.createTransport({
                host: smtpHost,
                port: Number.parseInt(smtpPort, 10),
                secure: Number.parseInt(smtpPort, 10) === 465,
                auth: {
                    user: smtpUser,
                    pass: smtpPassword,
                },
            });

            // Prepare email content
            const userIdentifier = userInfo.type === 'authenticated'
                ? `Email: ${userInfo.email}`
                : `Anonymous IP: ${userInfo.ip}`;

            const emailHtml = `
                <h2>New Feedback from SentiEdge</h2>
                <p><strong>From:</strong> ${userIdentifier}</p>
                <p><strong>User ID:</strong> ${userId}</p>
                <p><strong>Timestamp:</strong> ${timestamp}</p>
                <hr>
                <h3>Feedback:</h3>
                <p>${feedback.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>
            `;

            const emailText = `
New Feedback from SentiEdge

From: ${userIdentifier}
User ID: ${userId}
Timestamp: ${timestamp}

Feedback:
${feedback}
            `;

            // Send email
            await transporter.sendMail({
                from: smtpUser,
                to: "support@sentiedge.ai",
                subject: `Feedback from ${userInfo.type === 'authenticated' ? userInfo.email : 'Anonymous User'}`,
                text: emailText,
                html: emailHtml,
            });

            elizaLogger.info(`Feedback email sent successfully from ${userIdentifier}`);

            res.json({
                success: true,
                message: "Feedback sent successfully",
            });
        } catch (error) {
            elizaLogger.error("Error sending feedback:", error);
            res.status(500).json({
                success: false,
                error: "Failed to send feedback"
            });
        }
    });

    /**
     * Get quota status for the current user
     * Returns quota usage and limits for limited tiers (free/plus)
     */
    router.get("/:agentId/quota/status", requireAuth, async (req, res) => {
        try {
            const { agentId } = req.params;
            const runtime = agents.get(agentId);

            if (!runtime) {
                return res.status(404).json({
                    success: false,
                    error: "Agent not found"
                });
            }

            const userInfo = getUserInfo(req);
            const fallbackUserId = getUserId(req);
            const userId = await resolveAuthenticatedUserId(
                runtime,
                userInfo,
                fallbackUserId
            );

            const quotaTier = await getUserQuotaTier(runtime, userId);

            if (quotaTier.tier === "unlimited") {
                // Paid users have unlimited quota
                return res.json({
                    success: true,
                    isUnlimited: true,
                    isFreeUser: quotaTier.isFreeUser,
                    isLimitedUser: false,
                    quotaTier: quotaTier.tier,
                });
            }

            const limits = WEEKLY_TOKEN_LIMITS_BY_TIER[quotaTier.tier];
            const quotaStatus = await getUserQuotaStatus(runtime, userId, limits);

            return res.json({
                success: true,
                isUnlimited: false,
                isFreeUser: quotaTier.isFreeUser,
                isLimitedUser: true,
                quotaTier: quotaTier.tier,
                quotaStatus
            });
        } catch (error) {
            elizaLogger.error("Error fetching quota status:", error);
            return res.status(500).json({
                success: false,
                error: "Failed to fetch quota status"
            });
        }
    });

    // ── Daily Analysis Endpoints ──────────────────────────────────

    router.get("/daily-analysis", publicOrRequireAuth, (req, res) => {
        try {
            const scheduler = directClient.getDailyAnalysisScheduler();
            const fileName =
                typeof req.query.fileName === "string" ? req.query.fileName : undefined;
            const report = fileName
                ? scheduler.getReportByFileName(fileName)
                : scheduler.getLatestReport();

            if (!report.exists) {
                return res.json({
                    success: true,
                    hasReport: false,
                });
            }

            return res.json({
                success: true,
                hasReport: true,
                fileName: report.fileName,
                date: report.date,
                summary: report.summary,
                metadata: report.metadata ?? null,
            });
        } catch (error) {
            elizaLogger.error("Error fetching daily analysis:", error);
            return res.status(500).json({
                success: false,
                error: "Failed to fetch daily analysis",
            });
        }
    });

    router.get("/daily-analysis/recent", (req, res) => {
        try {
            const scheduler = directClient.getDailyAnalysisScheduler();
            const rawLimit =
                typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : 3;
            const limit = Number.isFinite(rawLimit)
                ? Math.min(Math.max(rawLimit, 1), 15)
                : 3;
            const reports = scheduler.getRecentReports(limit);

            return res.json({
                success: true,
                reports,
            });
        } catch (error) {
            elizaLogger.error("Error fetching recent daily analyses:", error);
            return res.status(500).json({
                success: false,
                error: "Failed to fetch recent daily analyses",
            });
        }
    });

    router.get("/daily-analysis/scheduler/status", authMiddleware, requireRole("admin", "support"), (req, res) => {
        if (!isAdminRequest(req)) {
            return res.status(403).json({ error: "Admin access required" });
        }

        try {
            const scheduler = directClient.getDailyAnalysisScheduler();
            return res.json({ success: true, ...scheduler.getStatus() });
        } catch (error) {
            elizaLogger.error("Error fetching scheduler status:", error);
            return res.status(500).json({
                success: false,
                error: "Failed to fetch scheduler status",
            });
        }
    });

    router.post("/daily-analysis/scheduler/trigger", authMiddleware, requireRole("admin"), async (req, res) => {
        if (!isAdminRequest(req)) {
            return res.status(403).json({ error: "Admin access required" });
        }

        try {
            const scheduler = directClient.getDailyAnalysisScheduler();
            const result = await scheduler.triggerNow();
            return res.json({ success: true, ...result });
        } catch (error) {
            elizaLogger.error("Error triggering daily analysis:", error);
            return res.status(500).json({
                success: false,
                error: "Failed to trigger daily analysis",
            });
        }
    });

    router.post("/daily-analysis/scheduler/toggle", authMiddleware, requireRole("admin"), (req, res) => {
        if (!isAdminRequest(req)) {
            return res.status(403).json({ error: "Admin access required" });
        }

        try {
            const { enabled } = req.body ?? {};
            if (typeof enabled !== "boolean") {
                return res.status(400).json({
                    success: false,
                    error: "Request body must include { enabled: boolean }",
                });
            }

            const scheduler = directClient.getDailyAnalysisScheduler();
            scheduler.setEnabled(enabled);
            return res.json({ success: true, ...scheduler.getStatus() });
        } catch (error) {
            elizaLogger.error("Error toggling scheduler:", error);
            return res.status(500).json({
                success: false,
                error: "Failed to toggle scheduler",
            });
        }
    });

    // Trading & exchange registry and auth endpoints
    router.get("/trading/exchanges", async (req, res) => {
        try {
            const db =
                (res.locals as { databaseAdapter?: any }).databaseAdapter ??
                (req.app as any)?.locals?.databaseAdapter;

            if (!db || typeof db.getExchangeRegistry !== "function") {
                elizaLogger.error("Database adapter is missing getExchangeRegistry");
                res.status(500).json({ success: false, message: "Exchange registry not available" });
                return;
            }

            const exchanges = await db.getExchangeRegistry();

            res.json({
                success: true,
                exchanges: (exchanges ?? []).map((exchange: any) => ({
                    id: exchange.id,
                    name: exchange.name,
                    defaultAuthType: exchange.defaultAuthType ?? null,
                    authTypes: Array.isArray(exchange.authTypes)
                        ? exchange.authTypes.map((option: any) => ({
                              type: option.type,
                              fields: Array.isArray(option.fields)
                                  ? option.fields.map((field: any) => ({
                                        id: field.id,
                                        label: field.label,
                                        type: field.type,
                                        required: Boolean(field.required),
                                        description: field.description,
                                        placeholder: field.placeholder,
                                    }))
                                  : [],
                          }))
                        : [],
                })),
            });
        } catch (error: any) {
            elizaLogger.error("Failed to fetch exchange registry:", error);
            res.status(500).json({ success: false, message: "Failed to fetch exchange registry" });
        }
    });

    const hasDefaultExchangeConfigured = async (
        db: any,
        userId: UUID
    ): Promise<{ ok: boolean; details: Record<string, unknown> }> => {
        const account = await db.getAccountById(userId as UUID);
        const details =
            account?.details && typeof account.details === "object" && !Array.isArray(account.details)
                ? ({ ...(account.details as Record<string, unknown>) } as Record<string, unknown>)
                : {};

        const defaultExchangeAuth =
            details.defaultExchangeAuth && typeof details.defaultExchangeAuth === "object"
                ? (details.defaultExchangeAuth as DefaultExchangeAuth)
                : null;
        if (!defaultExchangeAuth?.exchangeId) return { ok: false, details };

        const exchangeEntry =
            typeof db.getExchangeRegistryEntry === "function"
                ? await db.getExchangeRegistryEntry(String(defaultExchangeAuth.exchangeId))
                : null;
        if (!exchangeEntry) return { ok: false, details };

        const exchangeAuths =
            details.exchangeAuths && typeof details.exchangeAuths === "object"
                ? (details.exchangeAuths as ExchangeAuths)
                : ({} as ExchangeAuths);

        const storedByExchange = exchangeAuths[defaultExchangeAuth.exchangeId] as unknown;
        if (!storedByExchange || typeof storedByExchange !== "object" || Array.isArray(storedByExchange)) {
            return { ok: false, details };
        }

        const storedByType = (storedByExchange as Record<string, unknown>)[defaultExchangeAuth.authType] as unknown;
        if (!storedByType || typeof storedByType !== "object" || Array.isArray(storedByType)) {
            return { ok: false, details };
        }

        // Minimal check: at least one field stored for the default auth type.
        const hasAnyToken = Object.entries(storedByType as Record<string, unknown>).some(([k, v]) => {
            if (k === "updatedAt") return false;
            if (typeof v === "string") return v.trim().length > 0;
            if (v && typeof v === "object" && !Array.isArray(v)) return true; // encrypted secret payload
            return false;
        });

        return { ok: hasAnyToken, details };
    };

    router.get("/user/trading/enabled", authMiddleware, async (req, res) => {
        try {
            const userInfo = (req as any).userInfo;
            if (!userInfo || userInfo.type !== "authenticated" || !userInfo.userId) {
                res.status(401).json({ success: false, message: "Authentication required" });
                return;
            }

            const db =
                (res.locals as { databaseAdapter?: any }).databaseAdapter ??
                (req.app as any)?.locals?.databaseAdapter;
            if (!db || typeof db.getAccountById !== "function") {
                res.status(500).json({ success: false, message: "Database not available" });
                return;
            }

            const { ok: hasDefault, details } = await hasDefaultExchangeConfigured(db, userInfo.userId as UUID);
            const enabled = details.enableTrading === true;

            if (enabled && !hasDefault) {
                (details as any).enableTrading = false;
                await db.updateAccountDetails({
                    userId: userInfo.userId as UUID,
                    details,
                });
                res.json({ success: true, enabled: false });
                return;
            }

            res.json({ success: true, enabled: enabled && hasDefault });
        } catch (error: any) {
            elizaLogger.error("Failed to fetch trading enabled state:", error);
            res.status(500).json({ success: false, message: "Failed to fetch trading enabled state" });
        }
    });

    router.put("/user/trading/enabled", authMiddleware, async (req, res) => {
        try {
            const userInfo = (req as any).userInfo;
            if (!userInfo || userInfo.type !== "authenticated" || !userInfo.userId) {
                res.status(401).json({ success: false, message: "Authentication required" });
                return;
            }

            const body = req.body ?? {};
            const requested = (body as any).enableTrading;
            const enableTrading = requested === true;

            const db =
                (res.locals as { databaseAdapter?: any }).databaseAdapter ??
                (req.app as any)?.locals?.databaseAdapter;
            if (!db || typeof db.getAccountById !== "function" || typeof db.updateAccountDetails !== "function") {
                res.status(500).json({ success: false, message: "Database not available" });
                return;
            }

            const { ok: hasDefault, details } = await hasDefaultExchangeConfigured(db, userInfo.userId as UUID);
            if (enableTrading && !hasDefault) {
                res.status(400).json({
                    success: false,
                    message: "atleast configure one exchange to enable trading",
                });
                return;
            }

            (details as any).enableTrading = enableTrading;
            await db.updateAccountDetails({
                userId: userInfo.userId as UUID,
                details,
            });

            res.json({ success: true, enabled: enableTrading });
        } catch (error: any) {
            elizaLogger.error("Failed to update trading enabled state:", error);
            res.status(500).json({ success: false, message: "Failed to update trading enabled state" });
        }
    });

    // ========================================================================
    // F2 — Inferred-traits transparency API.
    // Lets the user see, approve / reject, and delete the user-feature
    // aspects derived from their messages. Hardens against the
    // "Willing to bypass risk engine" durable-trait poisoning QA defect.
    // ========================================================================
    router.get("/user/inferred-traits", authMiddleware, async (req, res) => {
        try {
            const userInfo = (req as any).userInfo;
            if (!userInfo || userInfo.type !== "authenticated" || !userInfo.userId) {
                res.status(401).json({ success: false, message: "Authentication required" });
                return;
            }
            const runtime = Array.from(agents.values())[0];
            const mgr = runtime?.userFeatureManager;
            if (!mgr || typeof mgr.listUserAspectsWithMemoryIds !== "function") {
                res.status(503).json({ success: false, message: "Feature manager unavailable" });
                return;
            }
            const rows = await mgr.listUserAspectsWithMemoryIds(userInfo.userId as UUID);
            res.json({ success: true, traits: rows });
        } catch (error: any) {
            elizaLogger.error("[user/inferred-traits] list failed", error);
            res.status(500).json({
                success: false,
                message: error?.message ?? "Failed to list inferred traits",
            });
        }
    });

    router.put("/user/inferred-traits/:memoryId/consent", authMiddleware, async (req, res) => {
        try {
            const userInfo = (req as any).userInfo;
            if (!userInfo || userInfo.type !== "authenticated" || !userInfo.userId) {
                res.status(401).json({ success: false, message: "Authentication required" });
                return;
            }
            const memoryId = String(req.params.memoryId ?? "").trim();
            const consent = String((req.body as any)?.consent ?? "").toLowerCase();
            if (consent !== "approved" && consent !== "rejected" && consent !== "pending") {
                res.status(400).json({
                    success: false,
                    message: "consent must be one of: approved, rejected, pending",
                });
                return;
            }
            const runtime = Array.from(agents.values())[0];
            const mgr = runtime?.userFeatureManager;
            if (!mgr || typeof mgr.setAspectConsent !== "function") {
                res.status(503).json({ success: false, message: "Feature manager unavailable" });
                return;
            }
            const ok = await mgr.setAspectConsent(
                userInfo.userId as UUID,
                memoryId as UUID,
                consent as "approved" | "rejected" | "pending",
            );
            res.json({ success: ok });
        } catch (error: any) {
            elizaLogger.error("[user/inferred-traits] consent update failed", error);
            res.status(500).json({
                success: false,
                message: error?.message ?? "Failed to update inferred trait consent",
            });
        }
    });

    router.delete("/user/inferred-traits/:memoryId", authMiddleware, async (req, res) => {
        try {
            const userInfo = (req as any).userInfo;
            if (!userInfo || userInfo.type !== "authenticated" || !userInfo.userId) {
                res.status(401).json({ success: false, message: "Authentication required" });
                return;
            }
            const memoryId = String(req.params.memoryId ?? "").trim();
            const runtime = Array.from(agents.values())[0];
            const mgr = runtime?.userFeatureManager;
            if (!mgr || typeof mgr.deleteAspect !== "function") {
                res.status(503).json({ success: false, message: "Feature manager unavailable" });
                return;
            }
            const ok = await mgr.deleteAspect(userInfo.userId as UUID, memoryId as UUID);
            res.json({ success: ok });
        } catch (error: any) {
            elizaLogger.error("[user/inferred-traits] delete failed", error);
            res.status(500).json({
                success: false,
                message: error?.message ?? "Failed to delete inferred trait",
            });
        }
    });

    router.delete("/user/inferred-traits", authMiddleware, async (req, res) => {
        try {
            const userInfo = (req as any).userInfo;
            if (!userInfo || userInfo.type !== "authenticated" || !userInfo.userId) {
                res.status(401).json({ success: false, message: "Authentication required" });
                return;
            }
            const runtime = Array.from(agents.values())[0];
            const mgr = runtime?.userFeatureManager;
            if (!mgr || typeof mgr.deleteAllUserAspects !== "function") {
                res.status(503).json({ success: false, message: "Feature manager unavailable" });
                return;
            }
            const removed = await mgr.deleteAllUserAspects(userInfo.userId as UUID);
            res.json({ success: true, removed });
        } catch (error: any) {
            elizaLogger.error("[user/inferred-traits] delete-all failed", error);
            res.status(500).json({
                success: false,
                message: error?.message ?? "Failed to delete all inferred traits",
            });
        }
    });

    router.get("/user/trading/preferences", authMiddleware, async (req, res) => {
        try {
            const userInfo = (req as any).userInfo;
            if (!userInfo || userInfo.type !== "authenticated" || !userInfo.userId) {
                res.status(401).json({ success: false, message: "Authentication required" });
                return;
            }
            const db =
                (res.locals as { databaseAdapter?: any }).databaseAdapter ??
                (req.app as any)?.locals?.databaseAdapter;
            if (!db) {
                res.status(500).json({ success: false, message: "Database not available" });
                return;
            }
            let preferences = null;
            if (typeof db.getUserTradingPreferences === "function") {
                preferences = await db.getUserTradingPreferences(userInfo.userId as UUID);
            }
            res.json({ success: true, preferences });
        } catch (error: any) {
            elizaLogger.error("Failed to fetch trading preferences:", error);
            res.status(500).json({ success: false, message: "Failed to fetch trading preferences" });
        }
    });

    router.put("/user/trading/preferences", authMiddleware, async (req, res) => {
        try {
            const userInfo = (req as any).userInfo;
            if (!userInfo || userInfo.type !== "authenticated" || !userInfo.userId) {
                res.status(401).json({ success: false, message: "Authentication required" });
                return;
            }
            const db =
                (res.locals as { databaseAdapter?: any }).databaseAdapter ??
                (req.app as any)?.locals?.databaseAdapter;
            if (!db || typeof db.setUserTradingPreferences !== "function") {
                res.status(500).json({ success: false, message: "Database not available or preferences not supported" });
                return;
            }
            const body = req.body ?? {};
            if (typeof body !== "object" || Array.isArray(body)) {
                res.status(400).json({ success: false, message: "Request body must be an object" });
                return;
            }
            const ALLOWED_FIELDS = new Set([
                "kill_switch_active",
                "max_order_notional_usd",
                "daily_loss_limit_usd",
                "slippage_bps_max",
                "cooldown_seconds",
                "cooldown_seconds_after_fail",
                "market_data_freshness_max_ms",
                "asset_allowlist",
                "asset_blocklist",
                "preferred_exchange",
                "preferred_language",
                "default_mode",
                "max_leverage",
            ]);
            const patch: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
                if (ALLOWED_FIELDS.has(k)) patch[k] = v;
            }

            // §7.8 — live mode requires consent. §7.10 — live mode requires
            // non-restricted geo. Check both before persisting.
            if (patch.default_mode === "live") {
                if (typeof db.getConsent === "function") {
                    const consent = await db.getConsent(
                        userInfo.userId,
                        "live_trading_tos",
                        "v1",
                    );
                    if (!consent) {
                        res.status(412).json({
                            success: false,
                            code: "consent_required",
                            message:
                                "Live mode requires acceptance of the live-trading TOS. Open Settings → Trading.",
                        });
                        return;
                    }
                }
                try {
                    const { isGeoRestrictedForLive } = await import("@elizaos/core");
                    const clientIp =
                        (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0] ??
                        req.socket.remoteAddress ??
                        "";
                    const restricted = isGeoRestrictedForLive(clientIp);
                    if (restricted) {
                        res.status(451).json({
                            success: false,
                            code: "geo_restricted",
                            message: `Live mode unavailable in ${restricted}.`,
                            region: restricted,
                        });
                        return;
                    }
                } catch {
                    // geoRestriction module may not be loaded in tests; pass through.
                }
            }

            // §7.3 server-side hard cap (kept defensive — UI also caps).
            if (
                typeof patch.max_order_notional_usd === "number" &&
                patch.max_order_notional_usd > 10_000_000
            ) {
                res.status(400).json({
                    success: false,
                    code: "limit_too_high",
                    message: "max_order_notional_usd exceeds the platform hard cap.",
                });
                return;
            }
            // 2026-05-25 hardening (QA H-1) — platform leverage hard cap.
            if (
                typeof patch.max_leverage === "number" &&
                (patch.max_leverage < 1 || patch.max_leverage > 10)
            ) {
                res.status(400).json({
                    success: false,
                    code: "leverage_out_of_range",
                    message: "max_leverage must be between 1 and 10.",
                });
                return;
            }

            await db.setUserTradingPreferences(userInfo.userId as UUID, patch);

            // CEX post-PR237 hotfix — invalidate the runtime cache for
            // `default_mode` after the DB write so subsequent reads via
            // `getTradingMode.ts` / `shared.ts:getUserTradingMode` pick up
            // the new value instead of returning stale cached state. The
            // cache key shape mirrors what plugin-cex writes after every
            // set_trading_mode action; if the key is absent the delete is
            // a no-op. Best-effort: a cache failure here does not roll
            // back the DB write — durable state is authoritative.
            if (
                Object.prototype.hasOwnProperty.call(patch, "default_mode") &&
                typeof patch.default_mode === "string"
            ) {
                try {
                    const cacheManager = getFirstAgent()?.cacheManager;
                    const cacheKey = `user_trading_preferences:${userInfo.userId}:default_mode`;
                    if (typeof cacheManager?.delete === "function") {
                        await cacheManager.delete(cacheKey);
                        elizaLogger.info(
                            `[api] trading-mode cache invalidated user=${userInfo.userId} new_mode=${patch.default_mode}`,
                        );
                    }
                } catch (cacheErr) {
                    elizaLogger.warn(
                        `[api] trading-mode cache invalidation failed (DB write succeeded): ${
                            cacheErr instanceof Error ? cacheErr.message : String(cacheErr)
                        }`,
                    );
                }
            }

            // §7.3 — preferences_audit. Best-effort.
            if (typeof db.writePreferencesAudit === "function") {
                try {
                    await db.writePreferencesAudit({
                        userId: userInfo.userId,
                        actor: "user",
                        patch,
                        clientIp:
                            (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0] ??
                            req.socket.remoteAddress ??
                            null,
                        userAgent: req.headers["user-agent"] ?? null,
                    });
                } catch (auditErr) {
                    elizaLogger.warn(
                        `[api] preferences_audit write failed: ${
                            auditErr instanceof Error ? auditErr.message : String(auditErr)
                        }`,
                    );
                }
            }

            res.json({ success: true });
        } catch (error: any) {
            elizaLogger.error("Failed to update trading preferences:", error);
            res.status(500).json({ success: false, message: "Failed to update trading preferences" });
        }
    });

    // §7.2 — dedicated kill-switch endpoint. Atomic flip + kill_switch_events row.
    router.put("/user/trading/kill-switch", authMiddleware, async (req, res) => {
        try {
            const userInfo = (req as any).userInfo;
            if (!userInfo?.userId) {
                res.status(401).json({ success: false, message: "Authentication required" });
                return;
            }
            const db =
                (res.locals as { databaseAdapter?: any }).databaseAdapter ??
                (req.app as any)?.locals?.databaseAdapter;
            if (!db || typeof db.setUserTradingPreferences !== "function") {
                res.status(500).json({ success: false, message: "Database not available" });
                return;
            }
            const active = Boolean((req.body as { active?: unknown } | undefined)?.active);
            const reason =
                typeof (req.body as { reason?: unknown } | undefined)?.reason === "string"
                    ? String((req.body as { reason?: unknown }).reason)
                    : undefined;
            await db.setUserTradingPreferences(userInfo.userId as UUID, {
                kill_switch_active: active,
            });
            if (typeof db.writeKillSwitchEvent === "function") {
                await db.writeKillSwitchEvent({
                    userId: userInfo.userId,
                    active,
                    reason,
                    actor: "user",
                    clientIp:
                        (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0] ??
                        req.socket.remoteAddress ??
                        null,
                    userAgent: req.headers["user-agent"] ?? null,
                });
            }
            // Emit `kill_switch_activation` so the CloudWatch alarm fires.
            try {
                const provider = (await import("@elizaos-plugins/plugin-cex")) as unknown as {
                    emitKillSwitchActivation?: (a: { userId: string; active: boolean; reason?: string; actor?: string }) => void;
                };
                provider.emitKillSwitchActivation?.({
                    userId: String(userInfo.userId),
                    active,
                    reason,
                    actor: "user",
                });
            } catch {
                /* plugin-cex barrel optional in tests */
            }

            // Fix 12 — when activating the kill switch, immediately revoke
            // every pending human-input approval owned by this user so the
            // approval modal disappears instead of sitting open until the
            // 15-minute TTL fires.
            let revokedCount = 0;
            if (active) {
                const runtime = getFirstAgent();
                if (runtime) {
                    try {
                        revokedCount = revokePendingApprovalsForUser(
                            runtime,
                            String(userInfo.userId),
                            "kill_switch_activated",
                        );
                    } catch (revokeErr) {
                        elizaLogger.warn(
                            `[Trading] kill-switch approval revoke failed: ${
                                revokeErr instanceof Error ? revokeErr.message : String(revokeErr)
                            }`,
                        );
                    }

                    // Structured `[Trading]` event for CloudWatch metric filters.
                    // Stage outside the typed union — `as never` mirrors the
                    // existing `kill_switch_activation` emission in
                    // cexWorkflowMessageHandler.ts (CEXTradingEventInput
                    // carries an `[k: string]: unknown` escape hatch).
                    try {
                        getCEXSpecProvider(runtime)?.emitTradingEvent?.({
                            stage: "kill_switch" as never,
                            userId: String(userInfo.userId),
                            revoked_approvals: revokedCount,
                            reason: reason ?? "kill_switch_activated",
                            actor: "user",
                        });
                    } catch {
                        // Observability hook — must never throw.
                    }

                    // Push an SSE notification to every live tab owned by
                    // this user so the client can dismiss the approval
                    // modal without waiting for a poll. No-op when no
                    // streams are open or none have registered a writer
                    // (e.g. liveness-only callers).
                    if (revokedCount > 0) {
                        try {
                            emitEventToUser(runtime, String(userInfo.userId), {
                                event: "kill_switch_revoked",
                                revoked_count: revokedCount,
                                reason: "kill_switch_activated",
                            });
                        } catch (sseErr) {
                            elizaLogger.warn(
                                `[Trading] kill-switch SSE push failed: ${
                                    sseErr instanceof Error ? sseErr.message : String(sseErr)
                                }`,
                            );
                        }
                    }

                    // Halt the user's armed strategy instances on kill-switch activation.
                    try {
                        const strategyEngine = runtime.getService(ServiceType.STRATEGY_ENGINE) as
                            | { haltUser?: (userId: string) => Promise<number> }
                            | null;
                        const haltedStrategies =
                            (await strategyEngine?.haltUser?.(String(userInfo.userId))) ?? 0;
                        if (haltedStrategies > 0) {
                            elizaLogger.info(
                                `[Trading] kill-switch halted ${haltedStrategies} strategy instance(s) for user=${userInfo.userId}`,
                            );
                        }
                    } catch (err) {
                        elizaLogger.warn(
                            `[Trading] kill-switch strategy halt failed: ${err instanceof Error ? err.message : String(err)}`,
                        );
                    }
                }
            }
            res.json({
                success: true,
                kill_switch_active: active,
                revoked_count: revokedCount,
            });
        } catch (error: any) {
            elizaLogger.error("kill-switch toggle failed:", error);
            res.status(500).json({ success: false, message: "Failed to toggle kill switch" });
        }
    });

    // §7.6 — list a user's pending-orders ledger rows.
    router.get("/user/orders", authMiddleware, async (req, res) => {
        try {
            const userInfo = (req as any).userInfo;
            if (!userInfo?.userId) {
                res.status(401).json({ success: false, message: "Authentication required" });
                return;
            }
            const db =
                (res.locals as { databaseAdapter?: any }).databaseAdapter ??
                (req.app as any)?.locals?.databaseAdapter;
            if (!db || typeof db.listUserOrders !== "function") {
                res.status(500).json({ success: false, message: "Database not available" });
                return;
            }
            const limit = Math.max(1, Math.min(Number.parseInt(String(req.query.limit ?? "100"), 10) || 100, 500));
            const venue = typeof req.query.venue === "string" ? req.query.venue : undefined;
            const state = typeof req.query.state === "string" ? req.query.state : undefined;
            const orders = await db.listUserOrders(userInfo.userId, { limit, venue, state });
            res.json({ success: true, orders });
        } catch (error: any) {
            elizaLogger.error("list orders failed:", error);
            res.status(500).json({ success: false, message: "Failed to list orders" });
        }
    });

    // §7.7 — list a user's strategy instances.
    router.get("/user/strategies", authMiddleware, async (req, res) => {
        try {
            const userInfo = (req as any).userInfo;
            if (!userInfo?.userId) {
                res.status(401).json({ success: false, message: "Authentication required" });
                return;
            }
            const db =
                (res.locals as { databaseAdapter?: any }).databaseAdapter ??
                (req.app as any)?.locals?.databaseAdapter;
            if (!db || typeof db.listStrategyInstances !== "function") {
                res.status(500).json({ success: false, message: "Database not available" });
                return;
            }
            const strategies = await db.listStrategyInstances(userInfo.userId);
            res.json({ success: true, strategies });
        } catch (error: any) {
            elizaLogger.error("list strategies failed:", error);
            res.status(500).json({ success: false, message: "Failed to list strategies" });
        }
    });

    // §7.7 — pause / resume / stop a strategy instance.
    router.put("/user/strategies/:id/status", authMiddleware, async (req, res) => {
        try {
            const userInfo = (req as any).userInfo;
            if (!userInfo?.userId) {
                res.status(401).json({ success: false, message: "Authentication required" });
                return;
            }
            const db =
                (res.locals as { databaseAdapter?: any }).databaseAdapter ??
                (req.app as any)?.locals?.databaseAdapter;
            if (!db || typeof db.upsertStrategyInstance !== "function") {
                res.status(500).json({ success: false, message: "Database not available" });
                return;
            }
            const id = String(req.params.id ?? "");
            const status = String((req.body as { status?: unknown } | undefined)?.status ?? "");
            if (!id || !["active", "paused", "stopped"].includes(status)) {
                res.status(400).json({
                    success: false,
                    message: "id and status (active|paused|stopped) are required",
                });
                return;
            }
            await db.upsertStrategyInstance({
                id,
                userId: userInfo.userId,
                status,
                paused_at: status === "paused" ? new Date() : undefined,
            });
            res.json({ success: true, status });
        } catch (error: any) {
            elizaLogger.error("strategy status update failed:", error);
            res.status(500).json({ success: false, message: "Failed to update strategy status" });
        }
    });

    // §7.8 — consent endpoints.
    router.get("/user/consent/:type", authMiddleware, async (req, res) => {
        try {
            const userInfo = (req as any).userInfo;
            if (!userInfo?.userId) {
                res.status(401).json({ success: false, message: "Authentication required" });
                return;
            }
            const db =
                (res.locals as { databaseAdapter?: any }).databaseAdapter ??
                (req.app as any)?.locals?.databaseAdapter;
            if (!db || typeof db.getConsent !== "function") {
                res.status(500).json({ success: false, message: "Database not available" });
                return;
            }
            const consentType = String(req.params.type ?? "");
            const version = String(req.query.version ?? "v1");
            const consent = await db.getConsent(userInfo.userId, consentType, version);
            res.json({ success: true, consent });
        } catch (error: any) {
            elizaLogger.error("get consent failed:", error);
            res.status(500).json({ success: false, message: "Failed to fetch consent" });
        }
    });

    router.post("/user/consent", authMiddleware, async (req, res) => {
        try {
            const userInfo = (req as any).userInfo;
            if (!userInfo?.userId) {
                res.status(401).json({ success: false, message: "Authentication required" });
                return;
            }
            const db =
                (res.locals as { databaseAdapter?: any }).databaseAdapter ??
                (req.app as any)?.locals?.databaseAdapter;
            if (!db || typeof db.writeConsent !== "function") {
                res.status(500).json({ success: false, message: "Database not available" });
                return;
            }
            const body = (req.body ?? {}) as {
                consent_type?: unknown;
                version?: unknown;
                accepted?: unknown;
            };
            const consentType = String(body.consent_type ?? "");
            const version = String(body.version ?? "v1");
            const accepted = Boolean(body.accepted);
            if (!consentType || !accepted) {
                res.status(400).json({
                    success: false,
                    message: "consent_type and accepted=true are required",
                });
                return;
            }
            await db.writeConsent({
                userId: userInfo.userId,
                consent_type: consentType,
                version,
                accepted: true,
                clientIp:
                    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0] ??
                    req.socket.remoteAddress ??
                    null,
                userAgent: req.headers["user-agent"] ?? null,
            });
            res.json({ success: true });
        } catch (error: any) {
            elizaLogger.error("write consent failed:", error);
            res.status(500).json({ success: false, message: "Failed to record consent" });
        }
    });

    // §7.9 — notifications.
    router.get("/user/notifications", authMiddleware, async (req, res) => {
        try {
            const userInfo = (req as any).userInfo;
            if (!userInfo?.userId) {
                res.status(401).json({ success: false, message: "Authentication required" });
                return;
            }
            const db =
                (res.locals as { databaseAdapter?: any }).databaseAdapter ??
                (req.app as any)?.locals?.databaseAdapter;
            if (!db || typeof db.listNotifications !== "function") {
                res.status(500).json({ success: false, message: "Database not available" });
                return;
            }
            const limit = Math.max(1, Math.min(Number.parseInt(String(req.query.limit ?? "50"), 10) || 50, 200));
            const unreadOnly = String(req.query.unreadOnly ?? "") === "true";
            const notifications = await db.listNotifications(userInfo.userId, {
                limit,
                unreadOnly,
            });
            res.json({ success: true, notifications });
        } catch (error: any) {
            elizaLogger.error("list notifications failed:", error);
            res.status(500).json({ success: false, message: "Failed to list notifications" });
        }
    });

    router.post("/user/notifications/:id/read", authMiddleware, async (req, res) => {
        try {
            const userInfo = (req as any).userInfo;
            if (!userInfo?.userId) {
                res.status(401).json({ success: false, message: "Authentication required" });
                return;
            }
            const db =
                (res.locals as { databaseAdapter?: any }).databaseAdapter ??
                (req.app as any)?.locals?.databaseAdapter;
            if (!db || typeof db.markNotificationRead !== "function") {
                res.status(500).json({ success: false, message: "Database not available" });
                return;
            }
            await db.markNotificationRead(userInfo.userId, String(req.params.id ?? ""));
            res.json({ success: true });
        } catch (error: any) {
            elizaLogger.error("mark notification read failed:", error);
            res.status(500).json({ success: false, message: "Failed to update notification" });
        }
    });

    router.get("/user/exchange-auths/:exchangeId", authMiddleware, async (req, res) => {
        try {
            const exchangeId = String(req.params.exchangeId || "").trim();
            if (!exchangeId) {
                res.status(400).json({ success: false, message: "exchangeId is required" });
                return;
            }

            const db =
                (res.locals as { databaseAdapter?: any }).databaseAdapter ??
                (req.app as any)?.locals?.databaseAdapter;

            if (!db || typeof db.getExchangeRegistryEntry !== "function") {
                elizaLogger.error("Database adapter is missing getExchangeRegistryEntry");
                res.status(500).json({ success: false, message: "Exchange registry not available" });
                return;
            }

            const exchange = await db.getExchangeRegistryEntry(exchangeId);
            if (!exchange) {
                res.status(400).json({ success: false, message: "Unsupported exchange" });
                return;
            }

            const userInfo = (req as any).userInfo;
            if (!userInfo || userInfo.type !== "authenticated" || !userInfo.userId) {
                res.status(401).json({ success: false, message: "Authentication required" });
                return;
            }

            const account = await db.getAccountById(userInfo.userId as UUID);
            const details = account?.details && typeof account.details === "object"
                ? (account.details as Record<string, unknown> & {
                      exchangeAuths?: ExchangeAuths;
                      defaultExchangeAuth?: DefaultExchangeAuth;
                  })
                : {};

            const exchangeAuths: ExchangeAuths =
                details.exchangeAuths && typeof details.exchangeAuths === "object"
                    ? (details.exchangeAuths as ExchangeAuths)
                    : ({} as ExchangeAuths);

            const defaultExchangeAuth: DefaultExchangeAuth | null =
                details.defaultExchangeAuth && typeof details.defaultExchangeAuth === "object"
                    ? (details.defaultExchangeAuth as DefaultExchangeAuth)
                    : null;

            const authTypes = Array.isArray(exchange.authTypes) ? exchange.authTypes : [];
            const queryAuthType = typeof req.query?.authType === "string" ? req.query.authType.trim() : null;
            const isDefault =
                !!defaultExchangeAuth && defaultExchangeAuth.exchangeId === exchange.id;

            const storedByExchange = exchangeAuths[exchange.id] ?? {};
            const storedByType = storedByExchange && typeof storedByExchange === "object"
                ? (storedByExchange as Record<string, Record<string, unknown>>)
                : {};

            if (queryAuthType && authTypes.some((o: any) => o.type === queryAuthType)) {
                const activeAuthType = queryAuthType as ExchangeAuthType;
                const stored = (storedByType[activeAuthType] ?? {}) as Record<string, unknown>;
                const option = authTypes.find((o: any) => o.type === activeAuthType);
                const fieldPresent: Record<string, boolean> = {};
                const fieldPreview: Record<string, string | null> = {};
                const fields = option ? (Array.isArray(option.fields) ? option.fields : []) : [];
                for (const field of fields) {
                    const fieldId = field.id as string;
                    if (!fieldId) continue;
                    const storedValue = stored[fieldId];
                    const raw =
                        typeof storedValue === "string"
                            ? storedValue.trim()
                            : isEncrypted(storedValue)
                                ? decrypt(storedValue).trim()
                                : "";
                    const isPresent = raw.length > 0;
                    fieldPresent[fieldId] = isPresent;
                    fieldPreview[fieldId] = isPresent ? getSecretPreview(raw) : null;
                }
                const updatedAt = typeof (stored as any).updatedAt === "number" ? (stored as any).updatedAt : null;
                return res.json({
                    success: true,
                    exchangeId,
                    fieldPresent,
                    fieldPreview,
                    updatedAt,
                    isDefault,
                });
            }

            const exchangeAuthsPayload: Record<string, { fieldPresent: Record<string, boolean>; fieldPreview: Record<string, string | null>; updatedAt: number | null }> = {};
            for (const option of authTypes) {
                const authType = option.type as string;
                const stored = (storedByType[authType] ?? {}) as Record<string, unknown>;
                const fieldPresent: Record<string, boolean> = {};
                const fieldPreview: Record<string, string | null> = {};
                const fields = Array.isArray(option.fields) ? option.fields : [];
                for (const field of fields) {
                    const fieldId = field.id as string;
                    if (!fieldId) continue;
                    const storedValue = stored[fieldId];
                    const raw =
                        typeof storedValue === "string"
                            ? storedValue.trim()
                            : isEncrypted(storedValue)
                                ? decrypt(storedValue).trim()
                                : "";
                    const isPresent = raw.length > 0;
                    fieldPresent[fieldId] = isPresent;
                    fieldPreview[fieldId] = isPresent ? getSecretPreview(raw) : null;
                }
                const updatedAt = typeof (stored as any).updatedAt === "number" ? (stored as any).updatedAt : null;
                exchangeAuthsPayload[authType] = { fieldPresent, fieldPreview, updatedAt };
            }

            res.json({
                success: true,
                exchangeId,
                isDefault,
                exchangeAuths: exchangeAuthsPayload,
            });
        } catch (error: any) {
            elizaLogger.error("Failed to fetch exchange auth status:", error);
            res.status(500).json({ success: false, message: "Failed to fetch exchange auth status" });
        }
    });

    router.put("/user/exchange-auths/:exchangeId", authMiddleware, async (req, res) => {
        // Hoisted so the catch block can include them in structured logs.
        const exchangeId = String(req.params.exchangeId || "").trim();
        const userInfo = (req as any).userInfo;
        const userIdForLog = userInfo?.userId ?? null;

        try {
            if (!exchangeId) {
                res.status(400).json({ success: false, message: "exchangeId is required" });
                return;
            }

            const db =
                (res.locals as { databaseAdapter?: any }).databaseAdapter ??
                (req.app as any)?.locals?.databaseAdapter;

            if (!db || typeof db.getExchangeRegistryEntry !== "function") {
                elizaLogger.error("Database adapter is missing getExchangeRegistryEntry");
                res.status(500).json({ success: false, message: "Exchange registry not available" });
                return;
            }

            const exchange = await db.getExchangeRegistryEntry(exchangeId);
            if (!exchange) {
                res.status(400).json({ success: false, message: "Unsupported exchange" });
                return;
            }

            if (!userInfo || userInfo.type !== "authenticated" || !userInfo.userId) {
                res.status(401).json({ success: false, message: "Authentication required" });
                return;
            }

            const body = req.body ?? {};
            if (typeof body !== "object" || Array.isArray(body)) {
                res.status(400).json({ success: false, message: "Request body must be an object" });
                return;
            }

            const rawList = (body as Record<string, unknown>).exchangeAuths;
            if (!Array.isArray(rawList) || rawList.length === 0) {
                res.status(400).json({ success: false, message: "exchangeAuths must be a non-empty array" });
                return;
            }

            const authTypesForValidation = Array.isArray(exchange.authTypes) ? exchange.authTypes : [];
            const allowedFieldsByAuthType = new Map<string, Set<string>>();
            const requiredFieldsByAuthType = new Map<string, Set<string>>();
            const secretFieldsByAuthType = new Map<string, Set<string>>();
            for (const option of authTypesForValidation) {
                const authType = option.type as string;
                const allowed = new Set<string>();
                const required = new Set<string>();
                const secret = new Set<string>();
                const fields = Array.isArray(option.fields) ? option.fields : [];
                for (const field of fields) {
                    if (!field?.id) continue;
                    allowed.add(field.id);
                    if (field.required) required.add(field.id);
                    if (field.type === "secret") secret.add(field.id);
                }
                allowedFieldsByAuthType.set(authType, allowed);
                requiredFieldsByAuthType.set(authType, required);
                secretFieldsByAuthType.set(authType, secret);
            }

            const account = await db.getAccountById(userInfo.userId as UUID);
            const details = account?.details && typeof account.details === "object"
                ? { ...(account.details as Record<string, unknown> & { exchangeAuths?: ExchangeAuths; defaultExchangeAuth?: DefaultExchangeAuth }) }
                : {};

            const currentExchangeAuths: ExchangeAuths =
                details.exchangeAuths && typeof details.exchangeAuths === "object"
                    ? { ...(details.exchangeAuths as ExchangeAuths) }
                    : ({} as ExchangeAuths);

            const existingForExchange =
                currentExchangeAuths[exchange.id] && typeof currentExchangeAuths[exchange.id] === "object"
                    ? { ...(currentExchangeAuths[exchange.id] as Record<string, Record<string, unknown>>) }
                    : {};

            const updatedForExchange: Record<string, Record<string, unknown>> = { ...existingForExchange };
            const now = Date.now();

            for (const item of rawList as Record<string, unknown>[]) {
                const itemAuthType = typeof item.authType === "string" ? item.authType.trim() : "";
                if (!itemAuthType) {
                    res.status(400).json({ success: false, message: "Each exchangeAuths entry must have authType" });
                    return;
                }
                if (!allowedFieldsByAuthType.has(itemAuthType)) {
                    res.status(400).json({ success: false, message: `Unsupported authType: ${itemAuthType}` });
                    return;
                }
                const allowed = allowedFieldsByAuthType.get(itemAuthType)!;
                const required = requiredFieldsByAuthType.get(itemAuthType)!;
                const secretFields = secretFieldsByAuthType.get(itemAuthType)!;
                const updates: Record<string, string> = {};
                for (const [key, value] of Object.entries(item)) {
                    if (key === "authType") continue;
                    if (!allowed.has(key)) continue;
                    if (typeof value !== "string") continue;
                    // Preserve user input at API layer; encryption layer handles normalization.
                    if (required.has(key) && value.length === 0) {
                        res.status(400).json({ success: false, message: `Field ${key} is required for authType ${itemAuthType}` });
                        return;
                    }
                    if (value.length === 0) continue;
                    updates[key] = value;
                }
                const existingStored = (existingForExchange[itemAuthType] ?? {}) as Record<string, unknown>;
                const updatedStored: Record<string, unknown> = {
                    ...existingStored,
                };

                for (const [fieldId, value] of Object.entries(updates)) {
                    if (secretFields.has(fieldId)) {
                        try {
                            updatedStored[fieldId] = encrypt(value);
                        } catch (encryptError: any) {
                            // Most likely cause: EXCHANGE_TOKEN_ENCRYPTION_KEY is unset
                            // or not base64-encoded 32 bytes in the deployed env.
                            // Surface as a distinct config-error response so operators
                            // chase the env var, not phantom DB issues.
                            elizaLogger.error("Exchange credential encryption failed", {
                                userId: userInfo.userId,
                                exchangeId,
                                authType: itemAuthType,
                                fieldId,
                                errorName: encryptError?.name,
                                errorMessage: encryptError?.message,
                            });
                            res.status(500).json({
                                success: false,
                                code: "encryption_unavailable",
                                message: "Exchange credential encryption is not configured. Contact support.",
                            });
                            return;
                        }
                    } else {
                        updatedStored[fieldId] = value;
                    }
                }

                updatedStored.updatedAt = now;
                updatedForExchange[itemAuthType] = updatedStored;
            }

            const exchangeAuthsResult: ExchangeAuths = {
                ...currentExchangeAuths,
                [exchange.id]: updatedForExchange as any,
            };

            details.exchangeAuths = exchangeAuthsResult;

            const existingDefault: DefaultExchangeAuth | null =
                details.defaultExchangeAuth && typeof details.defaultExchangeAuth === "object"
                    ? (details.defaultExchangeAuth as DefaultExchangeAuth)
                    : null;

            if (!existingDefault && Object.keys(exchangeAuthsResult).length === 1) {
                const storedByExchange = exchangeAuthsResult[exchange.id];
                const storedAuthTypes = storedByExchange && typeof storedByExchange === "object"
                    ? Object.keys(storedByExchange)
                    : [];
                const chosenAuthType: ExchangeAuthType | undefined =
                    (exchange.defaultAuthType as ExchangeAuthType | undefined) ??
                    (storedAuthTypes[0] as ExchangeAuthType | undefined);

                if (chosenAuthType) {
                    details.defaultExchangeAuth = {
                        exchangeId: exchange.id as ExchangeId,
                        authType: chosenAuthType,
                    };
                }
            }

            try {
                await db.updateAccountDetails({
                    userId: userInfo.userId as UUID,
                    details,
                });
            } catch (dbError: any) {
                elizaLogger.error("Failed to persist exchange auth to DB", {
                    userId: userInfo.userId,
                    exchangeId,
                    errorName: dbError?.name,
                    errorMessage: dbError?.message,
                });
                res.status(500).json({
                    success: false,
                    code: "persistence_failed",
                    message: "Could not save exchange credentials. Please retry; if this persists, contact support.",
                });
                return;
            }

            // §8.3 — credentials_audit. Best-effort.
            try {
                const db = (res.locals as { databaseAdapter?: { writeCredentialsAudit?: (r: Record<string, unknown>) => Promise<void> } }).databaseAdapter
                    ?? (req.app as any)?.locals?.databaseAdapter;
                if (db && typeof db.writeCredentialsAudit === "function") {
                    await db.writeCredentialsAudit({
                        userId: userInfo.userId,
                        exchange_id: exchangeId,
                        action: "save",
                        actor: "user",
                        clientIp:
                            (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0] ??
                            req.socket.remoteAddress ??
                            null,
                        userAgent: req.headers["user-agent"] ?? null,
                    });
                }
            } catch (auditErr) {
                elizaLogger.warn(
                    `[api] credentials_audit (save) failed: ${
                        auditErr instanceof Error ? auditErr.message : String(auditErr)
                    }`,
                );
            }

            res.json({ success: true });
        } catch (error: any) {
            elizaLogger.error("Failed to save exchange auth", {
                userId: userIdForLog,
                exchangeId,
                errorName: error?.name,
                errorMessage: error?.message,
                stack: error?.stack,
            });
            res.status(500).json({
                success: false,
                code: "internal_error",
                message: "Failed to save exchange auth",
            });
        }
    });

    router.delete("/user/exchange-auths/:exchangeId", authMiddleware, async (req, res) => {
        try {
            const exchangeId = String(req.params.exchangeId || "").trim();
            if (!exchangeId) {
                res.status(400).json({ success: false, message: "exchangeId is required" });
                return;
            }

            const db =
                (res.locals as { databaseAdapter?: any }).databaseAdapter ??
                (req.app as any)?.locals?.databaseAdapter;

            if (!db || typeof db.getExchangeRegistryEntry !== "function") {
                elizaLogger.error("Database adapter is missing getExchangeRegistryEntry");
                res.status(500).json({ success: false, message: "Exchange registry not available" });
                return;
            }

            const exchange = await db.getExchangeRegistryEntry(exchangeId);
            if (!exchange) {
                res.status(400).json({ success: false, message: "Unsupported exchange" });
                return;
            }

            const userInfo = (req as any).userInfo;
            if (!userInfo || userInfo.type !== "authenticated" || !userInfo.userId) {
                res.status(401).json({ success: false, message: "Authentication required" });
                return;
            }

            const account = await db.getAccountById(userInfo.userId as UUID);
            const details = account?.details && typeof account.details === "object"
                ? { ...(account.details as Record<string, unknown> & { exchangeAuths?: ExchangeAuths; defaultExchangeAuth?: DefaultExchangeAuth }) }
                : {};

            const exchangeAuths: ExchangeAuths =
                details.exchangeAuths && typeof details.exchangeAuths === "object"
                    ? { ...(details.exchangeAuths as ExchangeAuths) }
                    : ({} as ExchangeAuths);

            const defaultExchangeAuth: DefaultExchangeAuth | null =
                details.defaultExchangeAuth && typeof details.defaultExchangeAuth === "object"
                    ? (details.defaultExchangeAuth as DefaultExchangeAuth)
                    : null;

            const authTypes = Array.isArray(exchange.authTypes) ? exchange.authTypes : [];
            const queryAuthType = typeof req.query?.authType === "string" ? req.query.authType.trim() : null;
            const deleteSingleAuthType = queryAuthType && authTypes.some((o: any) => o.type === queryAuthType);

            if (deleteSingleAuthType && queryAuthType) {
                const forExchange = exchangeAuths[exchange.id] && typeof exchangeAuths[exchange.id] === "object"
                    ? { ...(exchangeAuths[exchange.id] as Record<string, unknown>) }
                    : {};
                delete (forExchange as Record<string, unknown>)[queryAuthType];
                const remainingAuthTypes = Object.keys(forExchange).filter((k) => forExchange[k] != null);
                if (remainingAuthTypes.length === 0) {
                    delete (exchangeAuths as Record<string, unknown>)[exchange.id];
                } else {
                    (exchangeAuths as Record<string, unknown>)[exchange.id] = forExchange;
                }
            } else {
                const hadAuthForExchange =
                    exchangeAuths[exchange.id] && typeof exchangeAuths[exchange.id] === "object";
                if (hadAuthForExchange) {
                    delete (exchangeAuths as Record<string, unknown>)[exchange.id];
                }
            }

            details.exchangeAuths = exchangeAuths;

            const deletedWasDefault =
                !!defaultExchangeAuth && defaultExchangeAuth.exchangeId === exchange.id;

            const remainingExchanges = Object.keys(exchangeAuths);

            if (deletedWasDefault) {
                if (remainingExchanges.length > 0) {
                    const nextExchangeId = remainingExchanges[0] as ExchangeId;
                    const nextStored =
                        exchangeAuths[nextExchangeId] && typeof exchangeAuths[nextExchangeId] === "object"
                            ? { ...(exchangeAuths[nextExchangeId] as Record<string, unknown>) }
                            : {};
                    const nextAuthTypes = Object.keys(nextStored);
                    const nextAuthType = (nextAuthTypes[0] ?? null) as ExchangeAuthType | null;

                    if (nextAuthType) {
                        details.defaultExchangeAuth = {
                            exchangeId: nextExchangeId,
                            authType: nextAuthType,
                        };
                    } else {
                        delete (details as Record<string, unknown>).defaultExchangeAuth;
                    }
                } else {
                    delete (details as Record<string, unknown>).defaultExchangeAuth;
                }
            }

            // If the default exchange was removed (or no default remains), disable trading.
            if (!(details as any).defaultExchangeAuth) {
                (details as any).enableTrading = false;
            }

            await db.updateAccountDetails({
                userId: userInfo.userId as UUID,
                details,
            });

            // §8.3 — credentials_audit on revoke.
            try {
                const adapterWithAudit = db as unknown as {
                    writeCredentialsAudit?: (r: Record<string, unknown>) => Promise<void>;
                };
                if (typeof adapterWithAudit.writeCredentialsAudit === "function") {
                    await adapterWithAudit.writeCredentialsAudit({
                        userId: userInfo.userId,
                        exchange_id: exchangeId,
                        action: "revoke",
                        actor: "user",
                        clientIp:
                            (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0] ??
                            req.socket.remoteAddress ??
                            null,
                        userAgent: req.headers["user-agent"] ?? null,
                    });
                }
            } catch (auditErr) {
                elizaLogger.warn(
                    `[api] credentials_audit (revoke) failed: ${
                        auditErr instanceof Error ? auditErr.message : String(auditErr)
                    }`,
                );
            }

            res.json({ success: true });
        } catch (error: any) {
            elizaLogger.error("Failed to delete exchange auth:", error);
            res.status(500).json({ success: false, message: "Failed to delete exchange auth" });
        }
    });

    router.put("/user/exchange-auths/:exchangeId/default", authMiddleware, async (req, res) => {
        try {
            const exchangeId = String(req.params.exchangeId || "").trim();
            if (!exchangeId) {
                res.status(400).json({ success: false, message: "exchangeId is required" });
                return;
            }

            const db =
                (res.locals as { databaseAdapter?: any }).databaseAdapter ??
                (req.app as any)?.locals?.databaseAdapter;

            if (!db || typeof db.getExchangeRegistryEntry !== "function") {
                elizaLogger.error("Database adapter is missing getExchangeRegistryEntry");
                res.status(500).json({ success: false, message: "Exchange registry not available" });
                return;
            }

            const exchange = await db.getExchangeRegistryEntry(exchangeId);
            if (!exchange) {
                res.status(400).json({ success: false, message: "Unsupported exchange" });
                return;
            }

            const userInfo = (req as any).userInfo;
            if (!userInfo || userInfo.type !== "authenticated" || !userInfo.userId) {
                res.status(401).json({ success: false, message: "Authentication required" });
                return;
            }

            const account = await db.getAccountById(userInfo.userId as UUID);
            const details = account?.details && typeof account.details === "object"
                ? { ...(account.details as Record<string, unknown> & { exchangeAuths?: ExchangeAuths; defaultExchangeAuth?: DefaultExchangeAuth }) }
                : {};

            const exchangeAuths: ExchangeAuths =
                details.exchangeAuths && typeof details.exchangeAuths === "object"
                    ? { ...(details.exchangeAuths as ExchangeAuths) }
                    : ({} as ExchangeAuths);

            const storedByExchange =
                exchangeAuths[exchange.id] && typeof exchangeAuths[exchange.id] === "object"
                    ? { ...(exchangeAuths[exchange.id] as Record<string, unknown>) }
                    : null;

            if (!storedByExchange || Object.keys(storedByExchange).length === 0) {
                res.status(400).json({
                    success: false,
                    message: "Cannot set default exchange without saved credentials",
                });
                return;
            }

            const authTypesForExchange = Object.keys(storedByExchange);
            const chosenAuthType: ExchangeAuthType | undefined =
                (exchange.defaultAuthType as ExchangeAuthType | undefined) ??
                (authTypesForExchange[0] as ExchangeAuthType | undefined);

            if (!chosenAuthType) {
                res.status(400).json({
                    success: false,
                    message: "Cannot set default exchange without a valid auth type",
                });
                return;
            }

            details.defaultExchangeAuth = {
                exchangeId: exchange.id as ExchangeId,
                authType: chosenAuthType,
            };

            await db.updateAccountDetails({
                userId: userInfo.userId as UUID,
                details,
            });

            res.json({
                success: true,
                defaultExchangeAuth: details.defaultExchangeAuth,
            });
        } catch (error: any) {
            elizaLogger.error("Failed to set default exchange auth:", error);
            res.status(500).json({ success: false, message: "Failed to set default exchange auth" });
        }
    });

    // Generic human-input approval endpoint for human-in-the-loop interrupts
    router.post("/agents/:agentId/human-input/approval", authMiddleware, async (req, res) => {
        try {
            const { agentId } = validateUUIDParams(req.params, res) ?? { agentId: null };
            if (!agentId) return;

            const runtime = agents.get(agentId);
            if (!runtime) {
                res.status(404).json({ error: "Agent not found" });
                return;
            }

            const threadId = typeof req.body?.threadId === "string" ? req.body.threadId : undefined;
            const approvalId = typeof req.body?.approvalId === "string" ? req.body.approvalId : undefined;
            const decision = req.body?.decision;
            const confirmationLevel = req.body?.confirmationLevel;
            const parameters = req.body?.parameters;
            const feedback = typeof req.body?.feedback === "string" ? req.body.feedback : "";
            const userId = (req as any).userId as UUID | undefined;

            if (!threadId || threadId.trim().length === 0) {
                res.status(400).json({ error: "threadId is required" });
                return;
            }
            if (!decision || (decision !== "approved" && decision !== "rejected")) {
                res.status(400).json({ error: "decision is required and must be 'approved' or 'rejected'" });
                return;
            }
            if (confirmationLevel !== 1 && confirmationLevel !== 2) {
                res.status(400).json({ error: "confirmationLevel is required and must be 1 or 2" });
                return;
            }
            if (!userId) {
                res.status(401).json({ error: "User context is required" });
                return;
            }

            const agentWithApprovals = runtime as AgentRuntime & RuntimeWithPendingApprovalMaps;
            const { pendingContext } = getPendingApprovalContext(
                agentWithApprovals,
                threadId,
                approvalId,
                ["__pendingHumanInputApprovals"]
            );

            const validationError = validatePendingApprovalDecision(
                pendingContext,
                agentId,
                userId,
                confirmationLevel,
                "Pending human input approval context not found",
                "No pending human input approval for this threadId",
                "Human input approval does not belong to the current user"
            );
            if (validationError) {
                res.status(validationError.status).json(validationError.body);
                return;
            }

            pendingContext!.resolve!({
                decision,
                confirmationLevel,
                parameters: typeof parameters === "object" && parameters !== null ? parameters : undefined,
                feedback,
            });

            res.json({
                success: true,
                message:
                    decision === "approved"
                        ? `Human input approved (level ${confirmationLevel}).`
                        : `Human input rejected (level ${confirmationLevel}).`,
            });
        } catch (error: any) {
            elizaLogger.error("Error processing human input approval:", error);
            res.status(500).json({
                error: "Failed to process human input approval",
                details: error.message,
            });
        }
    });

    // CEX workflow parameter approval endpoint for human-in-the-loop (double confirmation)
    router.post("/agents/:agentId/cex-workflow/approval", authMiddleware, async (req, res) => {
        try {
            const { agentId } = validateUUIDParams(req.params, res) ?? {
                agentId: null,
            };
            if (!agentId) return;

            const runtime = agents.get(agentId);
            if (!runtime) {
                res.status(404).json({ error: "Agent not found" });
                return;
            }

            const threadId = typeof req.body?.threadId === "string" ? req.body.threadId : undefined;
            const approvalId = typeof req.body?.approvalId === "string" ? req.body.approvalId : undefined;
            const decision = req.body?.decision;
            const confirmationLevel = req.body?.confirmationLevel;
            const parameters = req.body?.parameters;
            const feedback = typeof req.body?.feedback === "string" ? req.body.feedback : "";
            const userId = (req as any).userId as UUID | undefined;

            if (!threadId || threadId.trim().length === 0) {
                res.status(400).json({ error: "threadId is required" });
                return;
            }

            if (!decision || (decision !== "approved" && decision !== "rejected")) {
                res.status(400).json({ error: "decision is required and must be 'approved' or 'rejected'" });
                return;
            }

            if (confirmationLevel !== 1 && confirmationLevel !== 2) {
                res.status(400).json({ error: "confirmationLevel is required and must be 1 or 2" });
                return;
            }

            if (!userId) {
                res.status(401).json({ error: "User context is required" });
                return;
            }

            const agentWithApprovals = runtime as AgentRuntime & RuntimeWithPendingApprovalMaps;
            const { pendingContext, mapKey } = getPendingApprovalContext(
                agentWithApprovals,
                threadId,
                approvalId,
                ["__pendingHumanInputApprovals", "__pendingCEXWorkflowApprovals"]
            );
            const validationError = validatePendingApprovalDecision(
                pendingContext,
                agentId,
                userId,
                confirmationLevel,
                "Pending CEX workflow approval context not found",
                "No pending CEX workflow approval for this threadId",
                "CEX workflow approval does not belong to the current user"
            );
            if (validationError) {
                const knownPendingForThread = Array.from(agentWithApprovals.__pendingHumanInputApprovals?.values() ?? [])
                    .concat(Array.from(agentWithApprovals.__pendingCEXWorkflowApprovals?.values() ?? []))
                    .filter((entry: PendingApprovalContext) => entry.threadId === threadId)
                    .map((entry) => ({
                        approvalId: entry.approvalId,
                        expectedLevel: entry.expectedLevel,
                        userId: entry.userId,
                    }));
                elizaLogger.warn("[CEXWorkflow] Pending approval context not found", {
                    agentId,
                    threadId,
                    approvalId: approvalId ?? null,
                    confirmationLevel,
                    sourceMap: mapKey,
                    knownPendingForThread,
                });
                if (validationError.status === 400) {
                    elizaLogger.warn("[CEXWorkflow] Unexpected confirmation level", {
                        agentId,
                        threadId,
                        approvalId: pendingContext?.approvalId ?? approvalId ?? null,
                        expected: (validationError.body.expected as number | undefined) ?? null,
                        received: confirmationLevel,
                    });
                }
                res.status(validationError.status).json(validationError.body);
                return;
            }

            pendingContext!.resolve!({
                decision,
                confirmationLevel,
                parameters: typeof parameters === "object" && parameters !== null ? parameters : undefined,
                feedback,
            });

            res.json({
                success: true,
                message: decision === "approved"
                    ? `CEX workflow parameters approved (level ${confirmationLevel}).`
                    : `CEX workflow parameters rejected (level ${confirmationLevel}).`,
            });
        } catch (error: any) {
            elizaLogger.error("Error processing CEX workflow approval:", error);
            res.status(500).json({
                error: "Failed to process CEX workflow approval",
                details: error.message,
            });
        }
    });

    return router;
}
