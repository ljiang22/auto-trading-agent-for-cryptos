import path from "path";
import fs from "fs";
import { randomBytes } from "crypto";

export * from "./sqliteTables.ts";
export * from "./sqlite_vec.ts";

import {
    DatabaseAdapter,
    elizaLogger,
    stringToUuid,
    type ExchangeRegistryEntry,
    type ExchangeAuthType,
    type IDatabaseCacheAdapter,
} from "@elizaos/core";
import type {
    Account,
    Actor,
    GoalStatus,
    Participant,
    Goal,
    Memory,
    FavoriteTaskChainRecord,
    FavoriteTaskChainCreateInput,
    SharedTaskChainRecord,
    SharedTaskChainCreateInput,
    SharedChatRecord,
    SharedChatCreateInput,
    TaskChainData,
    Relationship,
    UUID,
    RAGKnowledgeItem,
    ChunkRow,
    Adapter,
    IAgentRuntime,
    Plugin,
    CachedActionResult,
} from "@elizaos/core";
import { getEmbeddingConfig } from "@elizaos/core";
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import { v4 } from "uuid";
import { load } from "./sqlite_vec.ts";
import { sqliteTables } from "./sqliteTables.ts";

import Database from "better-sqlite3";

// Warning throttling for dimension mismatches
const dimensionWarningTracker = new Map<string, number>();
const WARNING_THROTTLE_MS = 60000; // Show warning only once per minute per type

function logDimensionWarning(type: string, currentDims: number, expectedDims: number, operation: string) {
    const key = `${type}_${operation}`;
    const now = Date.now();
    const lastWarning = dimensionWarningTracker.get(key) || 0;
    
    if (now - lastWarning > WARNING_THROTTLE_MS) {
        elizaLogger.warn(`${operation} embedding ${type} (${currentDims} dimensions), adjusting to ${expectedDims} [throttled - showing once per minute]`);
        dimensionWarningTracker.set(key, now);
    } else {
        elizaLogger.debug(`${operation} embedding ${type} (${currentDims} dimensions), adjusting to ${expectedDims}`);
    }
}

function safeJsonStringify(value: unknown, fallback = "{}"): string {
    try {
        return JSON.stringify(value);
    } catch (_error) {
        try {
            const seen = new WeakSet<object>();
            return JSON.stringify(value, (_key, val) => {
                if (typeof val === "function" || typeof val === "symbol") {
                    return undefined;
                }
                if (typeof val === "object" && val !== null) {
                    if (seen.has(val)) {
                        return undefined;
                    }
                    seen.add(val);
                }
                return val;
            });
        } catch (_error2) {
            return fallback;
        }
    }
}

export class SqliteDatabaseAdapter
    extends DatabaseAdapter<BetterSqlite3Database>
    implements IDatabaseCacheAdapter
{
    async getRoom(roomId: UUID): Promise<UUID | null> {
        const sql = "SELECT id FROM rooms WHERE id = ?";
        const room = this.db.prepare(sql).get(roomId) as
            | { id: string }
            | undefined;
        return room ? (room.id as UUID) : null;
    }

    async getParticipantsForAccount(userId: UUID): Promise<Participant[]> {
        const sql = `
      SELECT p.id, p.userId, p.roomId, p.last_message_read
      FROM participants p
      WHERE p.userId = ?
    `;
        const rows = this.db.prepare(sql).all(userId) as Participant[];
        return rows;
    }

    async getParticipantsForRoom(roomId: UUID): Promise<UUID[]> {
        const sql = "SELECT userId FROM participants WHERE roomId = ?";
        const rows = this.db.prepare(sql).all(roomId) as { userId: string }[];
        return rows.map((row) => row.userId as UUID);
    }

    async getParticipantUserState(
        roomId: UUID,
        userId: UUID
    ): Promise<"FOLLOWED" | "MUTED" | null> {
        const stmt = this.db.prepare(
            "SELECT userState FROM participants WHERE roomId = ? AND userId = ?"
        );
        const res = stmt.get(roomId, userId) as
            | { userState: "FOLLOWED" | "MUTED" | null }
            | undefined;
        return res?.userState ?? null;
    }

    async setParticipantUserState(
        roomId: UUID,
        userId: UUID,
        state: "FOLLOWED" | "MUTED" | null
    ): Promise<void> {
        const stmt = this.db.prepare(
            "UPDATE participants SET userState = ? WHERE roomId = ? AND userId = ?"
        );
        stmt.run(state, roomId, userId);
    }

    constructor(db: BetterSqlite3Database) {
        super();
        this.db = db;
        load(db);
    }

    async init() {
        this.db.exec(sqliteTables);
        try {
            const columns = this.db
                .prepare(`PRAGMA table_info('favorite_taskchains')`)
                .all() as Array<{ name: string }>;
            const hasIsPublicColumn = columns.some(
                (column) => column.name === "isPublic"
            );
            if (!hasIsPublicColumn) {
                this.db.exec(
                    `ALTER TABLE favorite_taskchains ADD COLUMN isPublic INTEGER DEFAULT 0 NOT NULL`
                );
            }
        } catch (error) {
            elizaLogger.warn(
                "Failed to verify favorite_taskchains.isPublic column",
                error
            );
        }
        try {
            const memCols = this.db
                .prepare(`PRAGMA table_info('memories')`)
                .all() as Array<{ name: string }>;
            const hasClientIP = memCols.some((c) => c.name === "clientIP");
            if (!hasClientIP) {
                this.db.exec(
                    `ALTER TABLE memories ADD COLUMN clientIP TEXT`
                );
            }
        } catch (error) {
            elizaLogger.warn(
                "Failed to add memories clientIP column",
                error
            );
        }
        try {
            const sessionCols = this.db
                .prepare(`PRAGMA table_info('web_page_sessions')`)
                .all() as Array<{ name: string }>;
            const hasAnonymousId = sessionCols.some(
                (column) => column.name === "anonymousId"
            );
            if (hasAnonymousId) {
                this.db.exec(`
                    BEGIN;
                    CREATE TABLE IF NOT EXISTS "web_page_sessions_new" (
                        "id" TEXT PRIMARY KEY,
                        "createdAt" INTEGER NOT NULL,
                        "userId" TEXT,
                        "path" TEXT NOT NULL,
                        "referrer" TEXT,
                        "durationMs" INTEGER NOT NULL,
                        "clickCount" INTEGER NOT NULL DEFAULT 0,
                        "isAuthenticated" INTEGER NOT NULL DEFAULT 0,
                        "userAgent" TEXT,
                        FOREIGN KEY ("userId") REFERENCES "accounts"("id")
                    );
                    INSERT INTO "web_page_sessions_new" (
                        id,
                        createdAt,
                        userId,
                        path,
                        referrer,
                        durationMs,
                        clickCount,
                        isAuthenticated,
                        userAgent
                    )
                    SELECT
                        id,
                        createdAt,
                        CASE
                            WHEN userId IN (SELECT id FROM accounts) THEN userId
                            ELSE NULL
                        END,
                        path,
                        referrer,
                        durationMs,
                        clickCount,
                        isAuthenticated,
                        userAgent
                    FROM "web_page_sessions";
                    DROP TABLE "web_page_sessions";
                    ALTER TABLE "web_page_sessions_new" RENAME TO "web_page_sessions";
                    CREATE INDEX IF NOT EXISTS "web_page_sessions_createdAt_idx"
                        ON "web_page_sessions" ("createdAt" DESC);
                    CREATE INDEX IF NOT EXISTS "web_page_sessions_path_idx"
                        ON "web_page_sessions" ("path");
                    CREATE INDEX IF NOT EXISTS "web_page_sessions_path_auth_idx"
                        ON "web_page_sessions" ("path", "isAuthenticated", "createdAt" DESC);
                    COMMIT;
                `);
                elizaLogger.info("Removed web_page_sessions.anonymousId column");
            }
        } catch (error) {
            elizaLogger.warn(
                "Failed to remove web_page_sessions.anonymousId column",
                error
            );
        }
        try {
            await this.migrateAuthAccountsToCanonicalIds();
        } catch (error) {
            elizaLogger.warn(
                "Failed to migrate auth accounts to canonical email IDs",
                error
            );
        }

        try {
            const stmt = this.db.prepare(`
                INSERT OR IGNORE INTO exchange_registry (
                    id,
                    name,
                    defaultAuthType,
                    authTypes
                ) VALUES (?, ?, ?, ?)
            `);

            const coinbaseAuthTypes = JSON.stringify([
                {
                    type: "api_key_name_secret",
                    fields: [
                        {
                            id: "apiKeyName",
                            label: "API key name",
                            type: "secret",
                            required: true,
                            description:
                                "Coinbase Advanced Trade API key name (used for JWT auth).",
                            placeholder: "API key name",
                        },
                        {
                            id: "apiKeySecret",
                            label: "API key secret",
                            type: "secret",
                            required: true,
                            description:
                                "Coinbase Advanced Trade API key secret (used for JWT auth).",
                            placeholder: "API key secret",
                        },
                    ],
                },
            ]);

            const binanceAuthTypes = JSON.stringify([
                {
                    type: "api_key_name_secret",
                    fields: [
                        {
                            id: "apiKeyName",
                            label: "API key",
                            type: "secret",
                            required: true,
                            description:
                                "Binance API key (HMAC). Set X-MBX-APIKEY permissions for Spot / Wallet as needed.",
                            placeholder: "Binance API key",
                        },
                        {
                            id: "apiKeySecret",
                            label: "Secret key",
                            type: "secret",
                            required: true,
                            description: "Binance secret key (HMAC signing).",
                            placeholder: "Binance secret key",
                        },
                    ],
                },
            ]);

            stmt.run("coinbase", "Coinbase", "api_key_name_secret", coinbaseAuthTypes);
            stmt.run("binance", "Binance", "api_key_name_secret", binanceAuthTypes);
            elizaLogger.info("Ensured exchange_registry has Coinbase and Binance definitions");
        } catch (error) {
            elizaLogger.warn("Failed to seed exchange_registry table", error);
        }
    }

    async close() {
        this.db.close();
    }

    private getCanonicalEmailUserId(email: string): UUID {
        const normalizedEmail = email.trim().toLowerCase();
        return stringToUuid(`email-user-${normalizedEmail}`);
    }

    private async migrateAuthAccountsToCanonicalIds(): Promise<void> {
        const rows = this.db
            .prepare(
                `
                SELECT DISTINCT lower(trim(email)) AS email
                FROM accounts
                WHERE trim(email) != ''
                  AND instr(email, '@') > 0
                  AND lower(email) NOT LIKE '%@anonymous.local'
                  AND COALESCE(json_extract(details, '$.source'), '') = 'auth'
                `
            )
            .all() as Array<{ email: string | null }>;

        if (rows.length === 0) {
            return;
        }

        let migratedCount = 0;
        for (const row of rows) {
            if (!row.email) {
                continue;
            }
            const normalizedEmail = row.email.trim().toLowerCase();
            if (!normalizedEmail) {
                continue;
            }
            const preferredPrimaryId = this.getCanonicalEmailUserId(
                normalizedEmail
            );
            const result = await this.mergeDuplicateAccountsByEmail(
                normalizedEmail,
                preferredPrimaryId
            );
            if (result.primaryId === preferredPrimaryId) {
                migratedCount += result.mergedIds.length;
            }
        }

        if (migratedCount > 0) {
            elizaLogger.info(
                `Migrated ${migratedCount} account record(s) to canonical email IDs`
            );
        }
    }

    private mapFavoriteTaskChainRow(row: any): FavoriteTaskChainRecord {
        if (!row) {
            throw new Error("Favorite task chain record not found");
        }

        let parsedTaskChain: TaskChainData;
        try {
            parsedTaskChain =
                typeof row.taskChain === "string"
                    ? (JSON.parse(row.taskChain) as TaskChainData)
                    : (row.taskChain as TaskChainData);
        } catch (error) {
            elizaLogger.error(
                "Failed to parse favorite task chain payload, falling back to minimal structure",
                error
            );
            parsedTaskChain = {
                id: row.chainId,
                name: row.name,
                description: row.description ?? "",
                tasks: [],
            };
        }

        const createdAt =
            typeof row.createdAt === "number"
                ? row.createdAt
                : new Date(row.createdAt).getTime();

        const lastUsedAtValue = row.lastUsedAt;
        const lastUsedAt =
            lastUsedAtValue === null || lastUsedAtValue === undefined
                ? undefined
                : typeof lastUsedAtValue === "number"
                  ? lastUsedAtValue
                  : new Date(lastUsedAtValue).getTime();

        return {
            id: row.id,
            userId: row.userId,
            agentId: row.agentId,
            chainId: row.chainId,
            name: row.name,
            originalName: row.originalName,
            description: row.description ?? undefined,
            taskChain: parsedTaskChain,
            createdAt,
            lastUsedAt,
            isPublic:
                row.isPublic === 1 ||
                row.isPublic === true ||
                row.isPublic === "1",
        } satisfies FavoriteTaskChainRecord;
    }

    private mapSharedTaskChainRow(row: any): SharedTaskChainRecord {
        if (!row) {
            throw new Error("Shared task chain record not found");
        }

        let parsedTaskChain: TaskChainData;
        try {
            parsedTaskChain =
                typeof row.taskChain === "string"
                    ? (JSON.parse(row.taskChain) as TaskChainData)
                    : (row.taskChain as TaskChainData);
        } catch (error) {
            elizaLogger.error(
                "Failed to parse shared task chain payload, falling back to minimal structure",
                error
            );
            parsedTaskChain = {
                id: row.chainId,
                name: row.name,
                description: row.description ?? "",
                tasks: [],
            };
        }

        const createdAt =
            typeof row.createdAt === "number"
                ? row.createdAt
                : new Date(row.createdAt).getTime();

        const favoriteIdValue = row.favoriteId;
        const favoriteId =
            typeof favoriteIdValue === "string" && favoriteIdValue.length > 0
                ? (favoriteIdValue as UUID)
                : null;

        return {
            id: row.id,
            shareCode: row.shareCode,
            userId: row.userId,
            agentId: row.agentId,
            favoriteId,
            chainId: row.chainId,
            name: row.name,
            originalName: row.originalName,
            description: row.description ?? undefined,
            taskChain: parsedTaskChain,
            createdAt,
        } satisfies SharedTaskChainRecord;
    }

    private mapSharedChatRow(row: any): SharedChatRecord {
        if (!row) {
            throw new Error("Shared chat record not found");
        }

        const createdAt =
            typeof row.createdAt === "number"
                ? row.createdAt
                : new Date(row.createdAt).getTime();

        return {
            id: row.id,
            shareCode: row.shareCode,
            userId: row.userId,
            agentId: row.agentId,
            roomId: row.roomId,
            createdAt,
        } satisfies SharedChatRecord;
    }


    async getAccountById(userId: UUID): Promise<Account | null> {
        const sql = "SELECT * FROM accounts WHERE id = ?";
        const account = this.db.prepare(sql).get(userId) as Account;
        if (!account) return null;
        if (account) {
            if (typeof account.details === "string") {
                account.details = JSON.parse(
                    account.details as unknown as string
                );
            }
        }
        return account;
    }

    async getAccountByEmail(email: string): Promise<Account | null> {
        const normalizedEmail = email.trim().toLowerCase();
        const sql = "SELECT * FROM accounts WHERE lower(email) = ? ORDER BY createdAt ASC LIMIT 1";
        const account = this.db.prepare(sql).get(normalizedEmail) as Account;
        if (!account) return null;
        if (account) {
            if (typeof account.details === "string") {
                account.details = JSON.parse(
                    account.details as unknown as string
                );
            }
        }
        return account;
    }

    async createAccount(account: Account): Promise<boolean> {
        try {
            const desiredId = account.id?.trim() ? (account.id.trim() as UUID) : null;
            if (desiredId) {
                const existingById = this.db
                    .prepare("SELECT id FROM accounts WHERE id = ?")
                    .get(desiredId) as { id: string } | undefined;
                if (existingById) {
                    return true;
                }
            }

            const normalizedEmail = account.email?.trim().toLowerCase();
            if (normalizedEmail) {
                const existing = this.db
                    .prepare(
                        "SELECT id FROM accounts WHERE lower(email) = ? ORDER BY createdAt ASC LIMIT 1"
                    )
                    .get(normalizedEmail) as { id: string } | undefined;

                if (existing) {
                    if (!desiredId || existing.id === desiredId) {
                        elizaLogger.info(
                            `Account already exists for email ${normalizedEmail}; skipping create`
                        );
                        return true;
                    }
                    // Prevents FK failures when other tables reference the deterministic id
                    // but the accounts table has an older row under a different id.
                }
            }

            const rawDetails =
                account.details && typeof account.details === "object" && !Array.isArray(account.details)
                    ? (account.details as Record<string, unknown>)
                    : {};

            const details: Record<string, unknown> = {
                ...rawDetails,
                enableTrading: rawDetails.enableTrading === true,
            };

            const sql =
                "INSERT INTO accounts (id, name, username, email, avatarUrl, details) VALUES (?, ?, ?, ?, ?, ?)";
            this.db
                .prepare(sql)
                .run(
                    desiredId ?? v4(),
                    account.name,
                    account.username,
                    account.email,
                    account.avatarUrl,
                    safeJsonStringify(details)
                );
            return true;
        } catch (error) {
            console.log("Error creating account", error);
            return false;
        }
    }

    async mergeDuplicateAccountsByEmail(
        email: string,
        preferredPrimaryId?: UUID
    ): Promise<{
        primaryId: UUID | null;
        mergedIds: UUID[];
    }> {
        const normalizedEmail = email.trim().toLowerCase();
        const accounts = this.db
            .prepare(
                "SELECT id, createdAt, name, username, email, avatarUrl, details FROM accounts WHERE lower(email) = ? ORDER BY createdAt ASC"
            )
            .all(normalizedEmail) as Array<{
            id: UUID;
            createdAt: string | number;
            name: string | null;
            username: string | null;
            email: string;
            avatarUrl: string | null;
            details: string | null;
        }>;

        if (accounts.length === 0) {
            return { primaryId: null, mergedIds: [] };
        }

        const normalizedPreferredPrimaryId = preferredPrimaryId?.trim()
            ? (preferredPrimaryId.trim() as UUID)
            : null;
        let primaryId: UUID = accounts[0].id;

        if (normalizedPreferredPrimaryId) {
            const preferredAccountById = this.db
                .prepare("SELECT id, email FROM accounts WHERE id = ?")
                .get(normalizedPreferredPrimaryId) as
                | { id: UUID; email: string }
                | undefined;

            if (
                preferredAccountById &&
                preferredAccountById.email.trim().toLowerCase() !== normalizedEmail
            ) {
                elizaLogger.warn(
                    `Preferred primary account id ${normalizedPreferredPrimaryId} belongs to a different email; skipping preferred id for ${normalizedEmail}`
                );
            } else {
                primaryId = normalizedPreferredPrimaryId;
            }
        }

        const primaryExists = accounts.some((account) => account.id === primaryId);
        if (!primaryExists) {
            const seed = accounts[0];
            this.db
                .prepare(
                    `INSERT INTO accounts (id, createdAt, name, username, email, avatarUrl, details)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`
                )
                .run(
                    primaryId,
                    seed.createdAt,
                    seed.name,
                    seed.username,
                    normalizedEmail,
                    seed.avatarUrl,
                    seed.details ?? "{}"
                );
        }

        const duplicateIds = accounts
            .filter((account) => account.id !== primaryId)
            .map((account) => account.id);

        if (duplicateIds.length === 0) {
            return { primaryId, mergedIds: [] };
        }

        const mergeTransaction = this.db.transaction(() => {
            const placeholders = duplicateIds.map(() => "?").join(", ");

            // Merge token usage, analytics, and other per-user tables.
            this.db
                .prepare(`UPDATE memories SET userId = ? WHERE userId IN (${placeholders})`)
                .run(primaryId, ...duplicateIds);
            this.db
                .prepare(`UPDATE goals SET userId = ? WHERE userId IN (${placeholders})`)
                .run(primaryId, ...duplicateIds);
            this.db
                .prepare(`UPDATE logs SET userId = ? WHERE userId IN (${placeholders})`)
                .run(primaryId, ...duplicateIds);
            this.db
                .prepare(`UPDATE participants SET userId = ? WHERE userId IN (${placeholders})`)
                .run(primaryId, ...duplicateIds);
            this.db
                .prepare(`UPDATE relationships SET userId = ? WHERE userId IN (${placeholders})`)
                .run(primaryId, ...duplicateIds);
            this.db
                .prepare(`UPDATE relationships SET userA = ? WHERE userA IN (${placeholders})`)
                .run(primaryId, ...duplicateIds);
            this.db
                .prepare(`UPDATE relationships SET userB = ? WHERE userB IN (${placeholders})`)
                .run(primaryId, ...duplicateIds);
            this.db
                .prepare(`UPDATE shared_taskchains SET userId = ? WHERE userId IN (${placeholders})`)
                .run(primaryId, ...duplicateIds);
            this.db
                .prepare(`UPDATE token_usage SET userId = ? WHERE userId IN (${placeholders})`)
                .run(primaryId, ...duplicateIds);
            this.db
                .prepare(`UPDATE subscription_events SET userId = ? WHERE userId IN (${placeholders})`)
                .run(primaryId, ...duplicateIds);
            this.db
                .prepare(
                    `UPDATE user_subscription_tier_history SET userId = ? WHERE userId IN (${placeholders})`
                )
                .run(primaryId, ...duplicateIds);
            this.db
                .prepare(`UPDATE web_page_sessions SET userId = ? WHERE userId IN (${placeholders})`)
                .run(primaryId, ...duplicateIds);

            // Resolve favorite_taskchains unique constraint conflicts
            for (const dupId of duplicateIds) {
                this.db
                    .prepare(
                        `
                        DELETE FROM favorite_taskchains
                        WHERE userId = ?
                        AND EXISTS (
                            SELECT 1 FROM favorite_taskchains f2
                            WHERE f2.userId = ?
                            AND f2.agentId = favorite_taskchains.agentId
                            AND f2.chainId = favorite_taskchains.chainId
                        )
                        `
                    )
                    .run(dupId, primaryId);

                this.db
                    .prepare(`UPDATE favorite_taskchains SET userId = ? WHERE userId = ?`)
                    .run(primaryId, dupId);
            }

            // Merge referrals (referrer)
            this.db
                .prepare(`UPDATE referrals SET referrerId = ? WHERE referrerId IN (${placeholders})`)
                .run(primaryId, ...duplicateIds);

            // Merge referrals (referred) with UNIQUE constraint
            const existingPrimaryReferral = this.db
                .prepare("SELECT id FROM referrals WHERE referredUserId = ?")
                .get(primaryId) as { id: string } | undefined;
            const referredRows = this.db
                .prepare(
                    `SELECT id, createdAt FROM referrals WHERE referredUserId IN (${placeholders}) ORDER BY createdAt ASC`
                )
                .all(...duplicateIds) as Array<{ id: string; createdAt: string | number }>;

            if (existingPrimaryReferral) {
                if (referredRows.length > 0) {
                    this.db
                        .prepare(
                            `DELETE FROM referrals WHERE referredUserId IN (${placeholders})`
                        )
                        .run(...duplicateIds);
                }
            } else if (referredRows.length > 0) {
                const [keep, ...drop] = referredRows;
                if (drop.length > 0) {
                    const dropIds = drop.map((row) => row.id);
                    const dropPlaceholders = dropIds.map(() => "?").join(", ");
                    this.db
                        .prepare(
                            `DELETE FROM referrals WHERE id IN (${dropPlaceholders})`
                        )
                        .run(...dropIds);
                }
                this.db
                    .prepare("UPDATE referrals SET referredUserId = ? WHERE id = ?")
                    .run(primaryId, keep.id);
            }

            // Merge user_referral_codes (unique userId)
            const primaryReferralCode = this.db
                .prepare("SELECT id FROM user_referral_codes WHERE userId = ?")
                .get(primaryId) as { id: string } | undefined;
            const duplicateReferralCodes = this.db
                .prepare(
                    `SELECT id FROM user_referral_codes WHERE userId IN (${placeholders})`
                )
                .all(...duplicateIds) as Array<{ id: string }>;

            if (primaryReferralCode) {
                if (duplicateReferralCodes.length > 0) {
                    const dropIds = duplicateReferralCodes.map((row) => row.id);
                    const dropPlaceholders = dropIds.map(() => "?").join(", ");
                    this.db
                        .prepare(
                            `DELETE FROM user_referral_codes WHERE id IN (${dropPlaceholders})`
                        )
                        .run(...dropIds);
                }
            } else if (duplicateReferralCodes.length > 0) {
                const [keep, ...drop] = duplicateReferralCodes;
                if (drop.length > 0) {
                    const dropIds = drop.map((row) => row.id);
                    const dropPlaceholders = dropIds.map(() => "?").join(", ");
                    this.db
                        .prepare(
                            `DELETE FROM user_referral_codes WHERE id IN (${dropPlaceholders})`
                        )
                        .run(...dropIds);
                }
                this.db
                    .prepare("UPDATE user_referral_codes SET userId = ? WHERE id = ?")
                    .run(primaryId, keep.id);
            }

            // Merge user_subscriptions (unique userId)
            const primarySubscription = this.db
                .prepare("SELECT id FROM user_subscriptions WHERE userId = ?")
                .get(primaryId) as { id: string } | undefined;
            const duplicateSubscriptions = this.db
                .prepare(
                    `SELECT id FROM user_subscriptions WHERE userId IN (${placeholders})`
                )
                .all(...duplicateIds) as Array<{ id: string }>;

            if (primarySubscription) {
                if (duplicateSubscriptions.length > 0) {
                    const dropIds = duplicateSubscriptions.map((row) => row.id);
                    const dropPlaceholders = dropIds.map(() => "?").join(", ");
                    this.db
                        .prepare(
                            `DELETE FROM user_subscriptions WHERE id IN (${dropPlaceholders})`
                        )
                        .run(...dropIds);
                }
            } else if (duplicateSubscriptions.length > 0) {
                const [keep, ...drop] = duplicateSubscriptions;
                if (drop.length > 0) {
                    const dropIds = drop.map((row) => row.id);
                    const dropPlaceholders = dropIds.map(() => "?").join(", ");
                    this.db
                        .prepare(
                            `DELETE FROM user_subscriptions WHERE id IN (${dropPlaceholders})`
                        )
                        .run(...dropIds);
                }
                this.db
                    .prepare("UPDATE user_subscriptions SET userId = ? WHERE id = ?")
                    .run(primaryId, keep.id);
            }

            // Merge referral_codes to keep a single code
            // Keep all existing referral codes, but point them to the primary account.
            if (duplicateIds.length > 0) {
                this.db
                    .prepare(
                        `UPDATE referral_codes SET userId = ? WHERE userId IN (${placeholders})`
                    )
                    .run(primaryId, ...duplicateIds);
            }

            // Remove duplicate accounts
            this.db
                .prepare(`DELETE FROM accounts WHERE id IN (${placeholders})`)
                .run(...duplicateIds);
        });

        mergeTransaction();

        elizaLogger.info(
            `Merged ${duplicateIds.length} duplicate account(s) into ${primaryId} for ${normalizedEmail}`
        );

        return { primaryId, mergedIds: duplicateIds };
    }

    async updateAccountDetails(params: {
        userId: UUID;
        details: Record<string, any>;
    }): Promise<void> {
        const sql = `UPDATE accounts SET details = ? WHERE id = ?`;
        this.db
            .prepare(sql)
            .run(JSON.stringify(params.details ?? {}), params.userId);
    }

    async getActorDetails(params: { roomId: UUID }): Promise<Actor[]> {
        const sql = `
      SELECT a.id, a.name, a.username, a.details
      FROM participants p
      LEFT JOIN accounts a ON p.userId = a.id
      WHERE p.roomId = ?
    `;
        const rows = this.db
            .prepare(sql)
            .all(params.roomId) as (Actor | null)[];

        return rows
            .map((row) => {
                if (row === null) {
                    return null;
                }
                return {
                    ...row,
                    details:
                        typeof row.details === "string"
                            ? JSON.parse(row.details)
                            : row.details,
                };
            })
            .filter((row): row is Actor => row !== null);
    }

    async getMemoriesByRoomIds(params: {
        agentId: UUID;
        roomIds: UUID[];
        tableName: string;
        limit?: number;
    }): Promise<Memory[]> {
        if (!params.tableName) {
            // default to messages
            params.tableName = "messages";
        }

        const placeholders = params.roomIds.map(() => "?").join(", ");
        let sql = `SELECT * FROM memories WHERE type = ? AND agentId = ? AND roomId IN (${placeholders})`;

        const queryParams = [
            params.tableName,
            params.agentId,
            ...params.roomIds,
        ];

        // Add ordering and limit
        sql += ` ORDER BY createdAt DESC`;
        if (params.limit) {
            sql += ` LIMIT ?`;
            queryParams.push(params.limit.toString());
        }

        const stmt = this.db.prepare(sql);
        const rows = stmt.all(...queryParams) as (Memory & {
            content: string;
        })[];

        return rows.map((row) => ({
            ...row,
            content: JSON.parse(row.content),
        }));
    }

    async getMemoryById(memoryId: UUID): Promise<Memory | null> {
        const sql = "SELECT * FROM memories WHERE id = ?";
        const stmt = this.db.prepare(sql);
        stmt.bind([memoryId]);
        const memory = stmt.get() as Memory | undefined;

        if (memory) {
            return {
                ...memory,
                content: JSON.parse(memory.content as unknown as string),
            };
        }

        return null;
    }

    async getMemoriesByIds(
        memoryIds: UUID[],
        tableName?: string
    ): Promise<Memory[]> {
        if (memoryIds.length === 0) return [];
        const queryParams: any[] = [];
        const placeholders = memoryIds.map(() => "?").join(",");
        let sql = `SELECT * FROM memories WHERE id IN (${placeholders})`;
        queryParams.push(...memoryIds);

        if (tableName) {
            sql += ` AND type = ?`;
            queryParams.push(tableName);
        }

        const memories = this.db.prepare(sql).all(...queryParams) as Memory[];

        return memories.map((memory) => ({
            ...memory,
            createdAt:
                typeof memory.createdAt === "string"
                    ? Date.parse(memory.createdAt as string)
                    : memory.createdAt,
            content: JSON.parse(memory.content as unknown as string),
        }));
    }

    async getRecentUserMessages(params: {
        userId: UUID;
        agentId: UUID;
        limit: number;
        tableName?: string;
    }): Promise<Memory[]> {
        const tableName = params.tableName ?? "messages";
        const limit = params.limit > 0 ? params.limit : 5;
        const sql = `
            SELECT *
            FROM memories
            WHERE type = ?
              AND userId = ?
              AND agentId = ?
            ORDER BY createdAt DESC
            LIMIT ?
        `;

        const rows = this.db
            .prepare(sql)
            .all(tableName, params.userId, params.agentId, limit) as Memory[];

        return rows.map((memory) => ({
            ...memory,
            createdAt:
                typeof memory.createdAt === "string"
                    ? Date.parse(memory.createdAt as string)
                    : memory.createdAt,
            content: JSON.parse(memory.content as unknown as string),
        }));
    }

    async createMemory(memory: Memory, tableName: string): Promise<void> {
        // Delete any existing memory with the same ID first
        // const deleteSql = `DELETE FROM memories WHERE id = ? AND type = ?`;
        // this.db.prepare(deleteSql).run(memory.id, tableName);

        let isUnique = true;

        // Get the expected embedding dimensions from configuration
        const embeddingConfig = getEmbeddingConfig();
        const maxDimensions = embeddingConfig.dimensions;
        let embeddingValue: Float32Array = new Float32Array(maxDimensions);

        if (memory.embedding && memory.embedding.length > 0) {
            // Validate and normalize embedding size to prevent SQLite errors
            if (memory.embedding.length > maxDimensions) {
                logDimensionWarning(tableName, memory.embedding.length, maxDimensions, "embedding");
                embeddingValue = new Float32Array(memory.embedding.slice(0, maxDimensions));
            } else if (memory.embedding.length < maxDimensions) {
                logDimensionWarning(tableName, memory.embedding.length, maxDimensions, "embedding");
                // Create new array with correct dimensions and copy the embedding data
                embeddingValue.set(memory.embedding);
                // The rest remains zeros (default Float32Array initialization)
            } else {
                // Perfect match - use the embedding as-is
                embeddingValue = new Float32Array(memory.embedding);
            }
            
            // Check if a similar memory already exists using the normalized embedding
            const similarMemories = await this.searchMemoriesByEmbedding(
                Array.from(embeddingValue), // Convert Float32Array back to regular array for search
                {
                    tableName,
                    agentId: memory.agentId,
                    roomId: memory.roomId,
                    match_threshold: 0.95, // 5% similarity threshold
                    count: 1,
                }
            );

            isUnique = similarMemories.length === 0;
        }

        const content = JSON.stringify(memory.content);
        const createdAt = memory.createdAt ?? Date.now();
        const clientIP =
            memory.clientIP !== undefined && memory.clientIP !== null
                ? String(memory.clientIP)
                : null;

        // Insert the memory with the appropriate 'unique' value
        const sql = `INSERT OR REPLACE INTO memories (id, type, content, embedding, userId, roomId, agentId, \`unique\`, createdAt, clientIP) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        try {
            // Log memory usage for debugging
            const embeddingSize = embeddingValue.length * 4; // 4 bytes per float32
            const contentSize = content.length;
            if (embeddingSize > 10000 || contentSize > 50000) {
                elizaLogger.debug(
                    `Large memory being stored: embedding=${embeddingSize} bytes, content=${contentSize} bytes`
                );
            }

            this.db
                .prepare(sql)
                .run(
                    memory.id ?? v4(),
                    tableName,
                    content,
                    embeddingValue,
                    memory.userId,
                    memory.roomId,
                    memory.agentId,
                    isUnique ? 1 : 0,
                    createdAt,
                    clientIP
                );
        } catch (error) {
            elizaLogger.error(`SQLite error storing memory: ${(error as Error).message}`, {
                embeddingLength: embeddingValue.length,
                contentLength: content.length,
                tableName,
                memoryId: memory.id
            });
            throw error;
        }
    }

    async updateMemoryContent(params: {
        id: UUID;
        tableName: string;
        content: Memory["content"];
    }): Promise<void> {
        const sql = "UPDATE memories SET content = ? WHERE id = ? AND type = ?";
        const content = JSON.stringify(params.content);
        this.db.prepare(sql).run(content, params.id, params.tableName);
    }

    async searchMemories(params: {
        tableName: string;
        roomId: UUID;
        agentId?: UUID;
        embedding: number[];
        match_threshold: number;
        match_count: number;
        unique: boolean;
    }): Promise<Memory[]> {
        // Normalize embedding dimensions to prevent SQLite vector dimension mismatch
        const embeddingConfig = getEmbeddingConfig();
        const expectedDimensions = embeddingConfig.dimensions;
        let normalizedEmbedding: Float32Array;

        if (params.embedding.length > expectedDimensions) {
            logDimensionWarning(params.tableName, params.embedding.length, expectedDimensions, "search");
            normalizedEmbedding = new Float32Array(params.embedding.slice(0, expectedDimensions));
        } else if (params.embedding.length < expectedDimensions) {
            logDimensionWarning(params.tableName, params.embedding.length, expectedDimensions, "search");
            normalizedEmbedding = new Float32Array(expectedDimensions);
            normalizedEmbedding.set(params.embedding);
        } else {
            normalizedEmbedding = new Float32Array(params.embedding);
        }

        // Build the query and parameters carefully
        const queryParams = [
            normalizedEmbedding, // Use normalized embedding
            params.tableName,
            params.roomId,
        ];

        let sql = `
            SELECT *, vec_distance_L2(embedding, ?) AS similarity
            FROM memories
            WHERE type = ?
            AND roomId = ?`;

        if (params.unique) {
            sql += " AND `unique` = 1";
        }

        if (params.agentId) {
            sql += " AND agentId = ?";
            queryParams.push(params.agentId);
        }
        sql += ` ORDER BY similarity ASC LIMIT ?`; // ASC for lower distance
        queryParams.push(params.match_count.toString()); // Convert number to string

        // Execute the prepared statement with the correct number of parameters
        const memories = this.db.prepare(sql).all(...queryParams) as (Memory & {
            similarity: number;
        })[];

        return memories.map((memory) => ({
            ...memory,
            createdAt:
                typeof memory.createdAt === "string"
                    ? Date.parse(memory.createdAt as string)
                    : memory.createdAt,
            content: JSON.parse(memory.content as unknown as string),
        }));
    }

    async searchMemoriesByEmbedding(
        embedding: number[],
        params: {
            match_threshold?: number;
            count?: number;
            roomId?: UUID;
            agentId: UUID;
            unique?: boolean;
            tableName: string;
        }
    ): Promise<Memory[]> {
        // Normalize embedding dimensions to prevent SQLite vector dimension mismatch
        const embeddingConfig = getEmbeddingConfig();
        const expectedDimensions = embeddingConfig.dimensions;
        let normalizedEmbedding: Float32Array;

        if (embedding.length > expectedDimensions) {
            logDimensionWarning(params.tableName, embedding.length, expectedDimensions, "search");
            normalizedEmbedding = new Float32Array(embedding.slice(0, expectedDimensions));
        } else if (embedding.length < expectedDimensions) {
            logDimensionWarning(params.tableName, embedding.length, expectedDimensions, "search");
            normalizedEmbedding = new Float32Array(expectedDimensions);
            normalizedEmbedding.set(embedding);
        } else {
            normalizedEmbedding = new Float32Array(embedding);
        }

        const queryParams = [
            normalizedEmbedding, // Use normalized embedding
            params.tableName,
            params.agentId,
        ];

        let sql = `
      SELECT *, vec_distance_L2(embedding, ?) AS similarity
      FROM memories
      WHERE embedding IS NOT NULL AND type = ? AND agentId = ?`;

        if (params.unique) {
            sql += " AND `unique` = 1";
        }

        if (params.roomId) {
            sql += " AND roomId = ?";
            queryParams.push(params.roomId);
        }
        sql += ` ORDER BY similarity DESC`;

        if (params.count) {
            sql += " LIMIT ?";
            queryParams.push(params.count.toString());
        }

        const memories = this.db.prepare(sql).all(...queryParams) as (Memory & {
            similarity: number;
        })[];
        return memories.map((memory) => ({
            ...memory,
            createdAt:
                typeof memory.createdAt === "string"
                    ? Date.parse(memory.createdAt as string)
                    : memory.createdAt,
            content: JSON.parse(memory.content as unknown as string),
        }));
    }

    // getCachedEmbeddings removed — see packages/core/src/data/database.ts.

    async updateGoalStatus(params: {
        goalId: UUID;
        status: GoalStatus;
    }): Promise<void> {
        const sql = "UPDATE goals SET status = ? WHERE id = ?";
        this.db.prepare(sql).run(params.status, params.goalId);
    }

    async log(params: {
        body: { [key: string]: unknown };
        userId: UUID;
        roomId: UUID;
        type: string;
    }): Promise<void> {
        const sql =
            "INSERT INTO logs (body, userId, roomId, type) VALUES (?, ?, ?, ?)";
        this.db
            .prepare(sql)
            .run(
                JSON.stringify(params.body),
                params.userId,
                params.roomId,
                params.type
            );
    }

    async getMemories(params: {
        roomId: UUID;
        count?: number;
        unique?: boolean;
        tableName: string;
        agentId: UUID;
        start?: number;
        end?: number;
    }): Promise<Memory[]> {
        if (!params.tableName) {
            throw new Error("tableName is required");
        }
        if (!params.roomId) {
            throw new Error("roomId is required");
        }
        let sql = `SELECT * FROM memories WHERE type = ? AND agentId = ? AND roomId = ?`;

        const queryParams = [
            params.tableName,
            params.agentId,
            params.roomId,
        ] as any[];

        if (params.unique) {
            sql += " AND `unique` = 1";
        }

        if (params.start) {
            sql += ` AND createdAt >= ?`;
            queryParams.push(params.start);
        }

        if (params.end) {
            sql += ` AND createdAt <= ?`;
            queryParams.push(params.end);
        }

        sql += " ORDER BY createdAt DESC";

        if (params.count) {
            sql += " LIMIT ?";
            queryParams.push(params.count);
        }

        const memories = this.db.prepare(sql).all(...queryParams) as Memory[];

        return memories.map((memory) => ({
            ...memory,
            createdAt:
                typeof memory.createdAt === "string"
                    ? Date.parse(memory.createdAt as string)
                    : memory.createdAt,
            content: JSON.parse(memory.content as unknown as string),
        }));
    }

    async removeMemory(memoryId: UUID, tableName: string): Promise<void> {
        const sql = `DELETE FROM memories WHERE type = ? AND id = ?`;
        this.db.prepare(sql).run(tableName, memoryId);
    }

    async removeAllMemories(roomId: UUID, tableName: string): Promise<void> {
        const sql = `DELETE FROM memories WHERE type = ? AND roomId = ?`;
        this.db.prepare(sql).run(tableName, roomId);
    }

    async removeAllMemoriesByRoom(roomId: UUID): Promise<void> {
        const sql = `DELETE FROM memories WHERE roomId = ?`;
        this.db.prepare(sql).run(roomId);
    }

    async removeLogsByRoom(roomId: UUID): Promise<void> {
        const sql = `DELETE FROM logs WHERE roomId = ?`;
        this.db.prepare(sql).run(roomId);
    }

    async countMemories(
        roomId: UUID,
        unique = true,
        tableName = ""
    ): Promise<number> {
        if (!tableName) {
            throw new Error("tableName is required");
        }

        let sql = `SELECT COUNT(*) as count FROM memories WHERE type = ? AND roomId = ?`;
        const queryParams = [tableName, roomId] as string[];

        if (unique) {
            sql += " AND `unique` = 1";
        }

        return (this.db.prepare(sql).get(...queryParams) as { count: number })
            .count;
    }

    async countUserMessages(params: {
        userId: UUID;
        tableName?: string;
        agentId?: UUID;
        since?: number;
    }): Promise<number> {
        const tableName = params.tableName ?? "messages";

        if (!params.userId) {
            throw new Error("userId is required to count user messages");
        }

        let sql = `SELECT COUNT(*) as count FROM memories WHERE type = ? AND userId = ?`;
        const queryParams: Array<string | number> = [tableName, params.userId];

        if (params.agentId) {
            sql += " AND agentId = ?";
            queryParams.push(params.agentId);
        }

        if (typeof params.since === "number") {
            sql += " AND createdAt >= ?";
            queryParams.push(params.since);
        }

        const result = this.db.prepare(sql).get(...queryParams) as
            | { count: number }
            | undefined;

        return result?.count ?? 0;
    }

    async getFavoriteTaskChains(params: {
        userId: UUID;
        agentId: UUID;
    }): Promise<FavoriteTaskChainRecord[]> {
        const sql = `
            SELECT *
            FROM favorite_taskchains
            WHERE userId = ? AND agentId = ?
            ORDER BY createdAt DESC
        `;

        const rows = this.db.prepare(sql).all(params.userId, params.agentId);
        return rows.map((row: any) => this.mapFavoriteTaskChainRow(row));
    }

    async getFavoriteTaskChain(params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
    }): Promise<FavoriteTaskChainRecord | null> {
        const stmt = this.db.prepare(
            `SELECT * FROM favorite_taskchains WHERE id = ? AND userId = ? AND agentId = ?`
        );
        const row = stmt.get(params.favoriteId, params.userId, params.agentId);
        return row ? this.mapFavoriteTaskChainRow(row) : null;
    }

    async getFavoriteTaskChainByChain(params: {
        chainId: string;
        userId: UUID;
        agentId: UUID;
    }): Promise<FavoriteTaskChainRecord | null> {
        const stmt = this.db.prepare(
            `SELECT * FROM favorite_taskchains WHERE chainId = ? AND userId = ? AND agentId = ?`
        );
        const row = stmt.get(params.chainId, params.userId, params.agentId);
        return row ? this.mapFavoriteTaskChainRow(row) : null;
    }

    async createFavoriteTaskChain(
        params: FavoriteTaskChainCreateInput
    ): Promise<FavoriteTaskChainRecord> {
        const favoriteId = v4() as UUID;
        const createdAt = params.createdAt ?? Date.now();

        const stmt = this.db.prepare(
            `INSERT INTO favorite_taskchains
                (id, userId, agentId, chainId, name, originalName, description, taskChain, createdAt, isPublic)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );

        stmt.run(
            favoriteId,
            params.userId,
            params.agentId,
            params.chainId,
            params.name,
            params.originalName,
            params.description ?? null,
            JSON.stringify(params.taskChain),
            createdAt,
            params.isPublic ? 1 : 0
        );

        const row = this.db
            .prepare(`SELECT * FROM favorite_taskchains WHERE id = ?`)
            .get(favoriteId);
        return this.mapFavoriteTaskChainRow(row);
    }

    async removeFavoriteTaskChain(params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
    }): Promise<void> {
        const stmt = this.db.prepare(
            `DELETE FROM favorite_taskchains WHERE id = ? AND userId = ? AND agentId = ?`
        );
        const result = stmt.run(
            params.favoriteId,
            params.userId,
            params.agentId
        );

        if (result.changes === 0) {
            throw new Error("Favorite task chain not found");
        }
    }

    async updateFavoriteTaskChainName(params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
        name: string;
    }): Promise<void> {
        const stmt = this.db.prepare(
            `UPDATE favorite_taskchains SET name = ? WHERE id = ? AND userId = ? AND agentId = ?`
        );
        const result = stmt.run(
            params.name,
            params.favoriteId,
            params.userId,
            params.agentId
        );

        if (result.changes === 0) {
            throw new Error("Favorite task chain not found");
        }
    }

    async updateFavoriteTaskChainVisibility(params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
        isPublic: boolean;
    }): Promise<FavoriteTaskChainRecord> {
        const stmt = this.db.prepare(
            `UPDATE favorite_taskchains SET isPublic = ? WHERE id = ? AND userId = ? AND agentId = ?`
        );
        const result = stmt.run(
            params.isPublic ? 1 : 0,
            params.favoriteId,
            params.userId,
            params.agentId
        );

        if (result.changes === 0) {
            throw new Error("Favorite task chain not found");
        }

        const row = this.db
            .prepare(`SELECT * FROM favorite_taskchains WHERE id = ?`)
            .get(params.favoriteId);
        return this.mapFavoriteTaskChainRow(row);
    }

    async markFavoriteTaskChainUsed(params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
        timestamp?: number;
    }): Promise<void> {
        const stmt = this.db.prepare(
            `UPDATE favorite_taskchains SET lastUsedAt = ?, executionCount = executionCount + 1 WHERE id = ? AND userId = ? AND agentId = ?`
        );
        const result = stmt.run(
            params.timestamp ?? Date.now(),
            params.favoriteId,
            params.userId,
            params.agentId
        );

        if (result.changes === 0) {
            throw new Error("Favorite task chain not found");
        }
    }

    async getSharedTaskChainByFavorite(params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
    }): Promise<SharedTaskChainRecord | null> {
        const stmt = this.db.prepare(
            `SELECT * FROM shared_taskchains WHERE favoriteId = ? AND userId = ? AND agentId = ?`
        );
        const row = stmt.get(params.favoriteId, params.userId, params.agentId);
        return row ? this.mapSharedTaskChainRow(row) : null;
    }

    async createSharedTaskChain(
        params: SharedTaskChainCreateInput
    ): Promise<SharedTaskChainRecord> {
        const sharedId = v4() as UUID;
        const createdAt = params.createdAt ?? Date.now();

        const stmt = this.db.prepare(
            `INSERT INTO shared_taskchains
                (id, shareCode, favoriteId, userId, agentId, chainId, name, originalName, description, taskChain, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );

        stmt.run(
            sharedId,
            params.shareCode,
            params.favoriteId ?? null,
            params.userId,
            params.agentId,
            params.chainId,
            params.name,
            params.originalName,
            params.description ?? null,
            JSON.stringify(params.taskChain),
            createdAt
        );

        const row = this.db
            .prepare(`SELECT * FROM shared_taskchains WHERE id = ?`)
            .get(sharedId);
        return this.mapSharedTaskChainRow(row);
    }

    async getSharedTaskChainByCode(
        shareCode: string
    ): Promise<SharedTaskChainRecord | null> {
        const stmt = this.db.prepare(
            `SELECT * FROM shared_taskchains WHERE shareCode = ?`
        );
        const row = stmt.get(shareCode);
        return row ? this.mapSharedTaskChainRow(row) : null;
    }

    async getSharedChatByRoom(params: {
        agentId: UUID;
        roomId: UUID;
    }): Promise<SharedChatRecord | null> {
        const stmt = this.db.prepare(
            `SELECT * FROM shared_chats WHERE agentId = ? AND roomId = ?`
        );
        const row = stmt.get(params.agentId, params.roomId);
        return row ? this.mapSharedChatRow(row) : null;
    }

    async createSharedChat(params: SharedChatCreateInput): Promise<SharedChatRecord> {
        const sharedId = v4() as UUID;
        const createdAt = params.createdAt ?? Date.now();

        const stmt = this.db.prepare(
            `INSERT INTO shared_chats (id, shareCode, userId, agentId, roomId, createdAt)
            VALUES (?, ?, ?, ?, ?, ?)`
        );

        stmt.run(
            sharedId,
            params.shareCode,
            params.userId,
            params.agentId,
            params.roomId,
            createdAt
        );

        const row = this.db
            .prepare(`SELECT * FROM shared_chats WHERE id = ?`)
            .get(sharedId);
        return this.mapSharedChatRow(row);
    }

    async getSharedChatByCode(shareCode: string): Promise<SharedChatRecord | null> {
        const stmt = this.db.prepare(
            `SELECT * FROM shared_chats WHERE shareCode = ?`
        );
        const row = stmt.get(shareCode);
        return row ? this.mapSharedChatRow(row) : null;
    }

    async getTrendingTaskChains(params: {
        agentId: UUID;
        limit?: number;
    }): Promise<Array<{
        chainId: string;
        name: string;
        description: string | null;
        totalExecutions: number;
        lastUsedAt: number | null;
        sampleFavoriteId: UUID | null;
        sampleUserId: UUID | null;
    }>> {
        const limit = params.limit ?? 3;
        const sql = `
            SELECT
                chainId,
                originalName as name,
                description,
                SUM(executionCount) as totalExecutions,
                MAX(lastUsedAt) as lastUsedAt,
                MIN(id) as sampleFavoriteId,
                MIN(userId) as sampleUserId
            FROM favorite_taskchains
            WHERE agentId = ? AND executionCount > 0 AND isPublic = 1
            GROUP BY chainId, originalName, description
            ORDER BY totalExecutions DESC, lastUsedAt DESC
            LIMIT ?
        `;

        const rows = this.db.prepare(sql).all(params.agentId, limit) as Array<{
            chainId: string;
            name: string;
            description: string | null;
            totalExecutions: number;
            lastUsedAt: number | null;
            sampleFavoriteId: string | null;
            sampleUserId: string | null;
        }>;

        return rows.map((row) => ({
            chainId: row.chainId,
            name: row.name,
            description: row.description,
            totalExecutions: row.totalExecutions,
            lastUsedAt: row.lastUsedAt,
            sampleFavoriteId: row.sampleFavoriteId
                ? (row.sampleFavoriteId as UUID)
                : null,
            sampleUserId: row.sampleUserId ? (row.sampleUserId as UUID) : null,
        }));
    }

    async getGoals(params: {
        roomId: UUID;
        userId?: UUID | null;
        onlyInProgress?: boolean;
        count?: number;
    }): Promise<Goal[]> {
        let sql = "SELECT * FROM goals WHERE roomId = ?";
        const queryParams = [params.roomId];

        if (params.userId) {
            sql += " AND userId = ?";
            queryParams.push(params.userId);
        }

        if (params.onlyInProgress) {
            sql += " AND status = 'IN_PROGRESS'";
        }

        if (params.count) {
            sql += " LIMIT ?";
            // @ts-expect-error - queryParams is an array of strings
            queryParams.push(params.count.toString());
        }

        const goals = this.db.prepare(sql).all(...queryParams) as Goal[];
        return goals.map((goal) => ({
            ...goal,
            objectives:
                typeof goal.objectives === "string"
                    ? JSON.parse(goal.objectives)
                    : goal.objectives,
        }));
    }

    async updateGoal(goal: Goal): Promise<void> {
        const sql =
            "UPDATE goals SET name = ?, status = ?, objectives = ? WHERE id = ?";
        this.db
            .prepare(sql)
            .run(
                goal.name,
                goal.status,
                JSON.stringify(goal.objectives),
                goal.id
            );
    }

    async createGoal(goal: Goal): Promise<void> {
        const sql =
            "INSERT INTO goals (id, roomId, userId, name, status, objectives) VALUES (?, ?, ?, ?, ?, ?)";
        this.db
            .prepare(sql)
            .run(
                goal.id ?? v4(),
                goal.roomId,
                goal.userId,
                goal.name,
                goal.status,
                JSON.stringify(goal.objectives)
            );
    }

    async removeGoal(goalId: UUID): Promise<void> {
        const sql = "DELETE FROM goals WHERE id = ?";
        this.db.prepare(sql).run(goalId);
    }

    async removeAllGoals(roomId: UUID): Promise<void> {
        const sql = "DELETE FROM goals WHERE roomId = ?";
        this.db.prepare(sql).run(roomId);
    }

    async createRoom(roomId?: UUID, name?: string, agentId?: UUID): Promise<UUID> {
        roomId = roomId || (v4() as UUID);
        try {
            const sql = "INSERT INTO rooms (id, name, agentId) VALUES (?, ?, ?)";
            this.db.prepare(sql).run(roomId, name || null, agentId || null);
        } catch (error) {
            console.log("Error creating room", error);
        }
        return roomId as UUID;
    }

    async getRoomById(roomId: UUID): Promise<{ id: UUID; name?: string; createdAt: string } | null> {
        try {
            const sql = "SELECT id, name, createdAt FROM rooms WHERE id = ?";
            const room = this.db.prepare(sql).get(roomId) as { id: string; name: string | null; createdAt: string } | undefined;
            if (!room) return null;
            
            return {
                id: room.id as UUID,
                name: room.name || undefined,
                createdAt: room.createdAt
            };
        } catch (error) {
            console.log("Error getting room", error);
            return null;
        }
    }

    async removeRoom(roomId: UUID): Promise<void> {
        const sql = "DELETE FROM rooms WHERE id = ?";
        this.db.prepare(sql).run(roomId);
    }

    async updateRoomName(roomId: UUID, name: string): Promise<void> {
        try {
            const sql = "UPDATE rooms SET name = ? WHERE id = ?";
            this.db.prepare(sql).run(name, roomId);
        } catch (error) {
            console.log("Error updating room name", error);
            throw error;
        }
    }

    async removeParticipantsByRoom(roomId: UUID): Promise<void> {
        const sql = "DELETE FROM participants WHERE roomId = ?";
        this.db.prepare(sql).run(roomId);
    }

    async getRoomsForParticipant(userId: UUID, agentId?: UUID): Promise<UUID[]> {
        let sql: string;
        let params: any[];

        if (agentId) {
            // Filter by specific agent
            sql = "SELECT roomId FROM participants WHERE userId = ? AND agentId = ?";
            params = [userId, agentId];
        } else {
            // Legacy behavior - get all rooms for user
            sql = "SELECT roomId FROM participants WHERE userId = ?";
            params = [userId];
        }

        const rows = this.db.prepare(sql).all(...params) as { roomId: string }[];
        return rows.map((row) => row.roomId as UUID);
    }

    async getRoomsForParticipants(userIds: UUID[]): Promise<UUID[]> {
        // Assuming userIds is an array of UUID strings, prepare a list of placeholders
        const placeholders = userIds.map(() => "?").join(", ");
        // Construct the SQL query with the correct number of placeholders
        const sql = `SELECT DISTINCT roomId FROM participants WHERE userId IN (${placeholders})`;
        // Execute the query with the userIds array spread into arguments
        const rows = this.db.prepare(sql).all(...userIds) as {
            roomId: string;
        }[];
        // Map and return the roomId values as UUIDs
        return rows.map((row) => row.roomId as UUID);
    }

    async addParticipant(userId: UUID, roomId: UUID, agentId?: UUID): Promise<boolean> {
        try {
            const sql =
                "INSERT INTO participants (id, userId, roomId, agentId) VALUES (?, ?, ?, ?)";
            this.db.prepare(sql).run(v4(), userId, roomId, agentId || null);
            return true;
        } catch (error) {
            console.log("Error adding participant", error);
            return false;
        }
    }

    async removeParticipant(userId: UUID, roomId: UUID): Promise<boolean> {
        try {
            const sql =
                "DELETE FROM participants WHERE userId = ? AND roomId = ?";
            this.db.prepare(sql).run(userId, roomId);
            return true;
        } catch (error) {
            console.log("Error removing participant", error);
            return false;
        }
    }

    async createRelationship(params: {
        userA: UUID;
        userB: UUID;
    }): Promise<boolean> {
        if (!params.userA || !params.userB) {
            throw new Error("userA and userB are required");
        }
        const sql =
            "INSERT INTO relationships (id, userA, userB, userId) VALUES (?, ?, ?, ?)";
        this.db
            .prepare(sql)
            .run(v4(), params.userA, params.userB, params.userA);
        return true;
    }

    async getRelationship(params: {
        userA: UUID;
        userB: UUID;
    }): Promise<Relationship | null> {
        const sql =
            "SELECT * FROM relationships WHERE (userA = ? AND userB = ?) OR (userA = ? AND userB = ?)";
        return (
            (this.db
                .prepare(sql)
                .get(
                    params.userA,
                    params.userB,
                    params.userB,
                    params.userA
                ) as Relationship) || null
        );
    }

    async getRelationships(params: { userId: UUID }): Promise<Relationship[]> {
        const sql =
            "SELECT * FROM relationships WHERE (userA = ? OR userB = ?)";
        return this.db
            .prepare(sql)
            .all(params.userId, params.userId) as Relationship[];
    }

    async getCache(params: {
        key: string;
        agentId: UUID;
    }): Promise<string | undefined> {
        const sql = "SELECT value FROM cache WHERE (key = ? AND agentId = ?)";
        const cached = this.db
            .prepare<[string, UUID], { value: string }>(sql)
            .get(params.key, params.agentId);

        return cached?.value ?? undefined;
    }

    async setCache(params: {
        key: string;
        agentId: UUID;
        value: string;
    }): Promise<boolean> {
        const sql =
            "INSERT OR REPLACE INTO cache (key, agentId, value, createdAt) VALUES (?, ?, ?, CURRENT_TIMESTAMP)";
        this.db.prepare(sql).run(params.key, params.agentId, params.value);
        return true;
    }

    async deleteCache(params: {
        key: string;
        agentId: UUID;
    }): Promise<boolean> {
        try {
            const sql = "DELETE FROM cache WHERE key = ? AND agentId = ?";
            this.db.prepare(sql).run(params.key, params.agentId);
            return true;
        } catch (error) {
            console.log("Error removing cache", error);
            return false;
        }
    }

    async getKnowledge(params: {
        id?: UUID;
        agentId: UUID;
        limit?: number;
        query?: string;
    }): Promise<RAGKnowledgeItem[]> {
        let sql = `SELECT * FROM knowledge WHERE (agentId = ? OR isShared = 1)`;
        const queryParams: any[] = [params.agentId];

        if (params.id) {
            sql += ` AND id = ?`;
            queryParams.push(params.id);
        }

        if (params.limit) {
            sql += ` LIMIT ?`;
            queryParams.push(params.limit);
        }

        interface KnowledgeRow {
            id: UUID;
            agentId: UUID;
            content: string;
            embedding: Buffer | null;
            createdAt: string | number;
        }

        const rows = this.db.prepare(sql).all(...queryParams) as KnowledgeRow[];

        return rows.map((row) => ({
            id: row.id,
            agentId: row.agentId,
            content: JSON.parse(row.content),
            embedding: row.embedding
                ? new Float32Array(row.embedding)
                : undefined,
            createdAt:
                typeof row.createdAt === "string"
                    ? Date.parse(row.createdAt)
                    : row.createdAt,
        }));
    }

    async searchKnowledge(params: {
        agentId: UUID;
        embedding: Float32Array;
        match_threshold: number;
        match_count: number;
        searchText?: string;
    }): Promise<RAGKnowledgeItem[]> {
        const cacheKey = `embedding_${params.agentId}_${params.searchText}`;
        const cachedResult = await this.getCache({
            key: cacheKey,
            agentId: params.agentId,
        });

        if (cachedResult) {
            return JSON.parse(cachedResult);
        }

        // Normalize embedding dimensions to prevent SQLite vector dimension mismatch
        const embeddingConfig = getEmbeddingConfig();
        const expectedDimensions = embeddingConfig.dimensions;
        let normalizedEmbedding: Float32Array;

        if (params.embedding.length > expectedDimensions) {
            logDimensionWarning("knowledge", params.embedding.length, expectedDimensions, "search");
            normalizedEmbedding = new Float32Array(params.embedding.slice(0, expectedDimensions));
        } else if (params.embedding.length < expectedDimensions) {
            logDimensionWarning("knowledge", params.embedding.length, expectedDimensions, "search");
            normalizedEmbedding = new Float32Array(expectedDimensions);
            normalizedEmbedding.set(params.embedding);
        } else {
            normalizedEmbedding = params.embedding;
        }

        interface KnowledgeSearchRow {
            id: UUID;
            agentId: UUID;
            content: string;
            embedding: Buffer | null;
            createdAt: string | number;
            vector_score: number;
        }

        const sql = `
            WITH vector_scores AS (
                SELECT id,
                    1 / (1 + vec_distance_L2(embedding, ?)) as vector_score
                FROM knowledge
                WHERE ((agentId IS NULL AND isShared = 1) OR agentId = ?)
                    AND embedding IS NOT NULL
            )
            SELECT k.*,
                v.vector_score
            FROM knowledge k
            JOIN vector_scores v ON k.id = v.id
            WHERE ((k.agentId IS NULL AND k.isShared = 1) OR k.agentId = ?)
                AND v.vector_score >= ?
            ORDER BY v.vector_score DESC
            LIMIT ?
        `;

        const searchParams = [
            normalizedEmbedding,
            params.agentId,
            params.agentId,
            params.match_threshold,
            params.match_count,
        ];

        try {
            const rows = this.db
                .prepare(sql)
                .all(...searchParams) as KnowledgeSearchRow[];
            const results = rows.map((row) => ({
                id: row.id,
                agentId: row.agentId,
                content: JSON.parse(row.content),
                embedding: row.embedding
                    ? new Float32Array(row.embedding)
                    : undefined,
                createdAt:
                    typeof row.createdAt === "string"
                        ? Date.parse(row.createdAt)
                        : row.createdAt,
                similarity: row.vector_score,
            }));

            await this.setCache({
                key: cacheKey,
                agentId: params.agentId,
                value: JSON.stringify(results),
            });

            return results;
        } catch (error) {
            elizaLogger.error("Error in searchKnowledge:", error);
            throw error;
        }
    }

    async createKnowledge(knowledge: RAGKnowledgeItem): Promise<void> {
        try {
            this.db.transaction(() => {
                const sql = `
                    INSERT INTO knowledge (
                    id, agentId, content, embedding, createdAt,
                    isMain, originalId, chunkIndex, isShared
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `;

                // Normalize embedding dimensions to prevent SQLite vector dimension mismatch
                let embeddingArray: Float32Array | null = null;
                if (knowledge.embedding && knowledge.embedding.length > 0) {
                    const embeddingConfig = getEmbeddingConfig();
                    const expectedDimensions = embeddingConfig.dimensions;
                    
                    if (knowledge.embedding.length > expectedDimensions) {
                        logDimensionWarning(knowledge.content.metadata?.isShared ? "knowledge" : "embedding", knowledge.embedding.length, expectedDimensions, "knowledge");
                        embeddingArray = new Float32Array(knowledge.embedding.slice(0, expectedDimensions));
                    } else if (knowledge.embedding.length < expectedDimensions) {
                        logDimensionWarning(knowledge.content.metadata?.isShared ? "knowledge" : "embedding", knowledge.embedding.length, expectedDimensions, "knowledge");
                        embeddingArray = new Float32Array(expectedDimensions);
                        embeddingArray.set(knowledge.embedding);
                    } else {
                        embeddingArray = knowledge.embedding;
                    }
                }

                const metadata = knowledge.content.metadata || {};
                const isShared = metadata.isShared ? 1 : 0;

                this.db
                    .prepare(sql)
                    .run(
                        knowledge.id,
                        metadata.isShared ? null : knowledge.agentId,
                        JSON.stringify(knowledge.content),
                        embeddingArray,
                        knowledge.createdAt || Date.now(),
                        metadata.isMain ? 1 : 0,
                        metadata.originalId || null,
                        metadata.chunkIndex || null,
                        isShared
                    );
            })();
        } catch (error: any) {
            const isShared = knowledge.content.metadata?.isShared;
            const isPrimaryKeyError =
                error?.code === "SQLITE_CONSTRAINT_PRIMARYKEY";

            if (isShared && isPrimaryKeyError) {
                elizaLogger.info(
                    `Shared knowledge ${knowledge.id} already exists, skipping`
                );
                return;
            } else if (
                !isShared &&
                !error.message?.includes("SQLITE_CONSTRAINT_PRIMARYKEY")
            ) {
                elizaLogger.error(`Error creating knowledge ${knowledge.id}:`, {
                    error,
                    embeddingLength: knowledge.embedding?.length,
                    content: knowledge.content,
                });
                throw error;
            }

            elizaLogger.debug(
                `Knowledge ${knowledge.id} already exists, skipping`
            );
        }
    }

    async removeKnowledge(id: UUID): Promise<void> {
        if (typeof id !== "string") {
            throw new Error("Knowledge ID must be a string");
        }

        try {
            // Execute the transaction and ensure it's called with ()
            await this.db.transaction(() => {
                if (id.includes("*")) {
                    const pattern = id.replace("*", "%");
                    const sql = "DELETE FROM knowledge WHERE id LIKE ?";
                    elizaLogger.debug(
                        `[Knowledge Remove] Executing SQL: ${sql} with pattern: ${pattern}`
                    );
                    const stmt = this.db.prepare(sql);
                    const result = stmt.run(pattern);
                    elizaLogger.debug(
                        `[Knowledge Remove] Pattern deletion affected ${result.changes} rows`
                    );
                    return result.changes; // Return changes for logging
                } else {
                    // Log queries before execution
                    const selectSql = "SELECT id FROM knowledge WHERE id = ?";
                    const chunkSql =
                        "SELECT id FROM knowledge WHERE json_extract(content, '$.metadata.originalId') = ?";
                    elizaLogger.debug(`[Knowledge Remove] Checking existence with:
                        Main: ${selectSql} [${id}]
                        Chunks: ${chunkSql} [${id}]`);

                    const mainEntry = this.db.prepare(selectSql).get(id) as
                        | ChunkRow
                        | undefined;
                    const chunks = this.db
                        .prepare(chunkSql)
                        .all(id) as ChunkRow[];

                    elizaLogger.debug(`[Knowledge Remove] Found:`, {
                        mainEntryExists: !!mainEntry?.id,
                        chunkCount: chunks.length,
                        chunkIds: chunks.map((c) => c.id),
                    });

                    // Execute and log chunk deletion
                    const chunkDeleteSql =
                        "DELETE FROM knowledge WHERE json_extract(content, '$.metadata.originalId') = ?";
                    elizaLogger.debug(
                        `[Knowledge Remove] Executing chunk deletion: ${chunkDeleteSql} [${id}]`
                    );
                    const chunkResult = this.db.prepare(chunkDeleteSql).run(id);
                    elizaLogger.debug(
                        `[Knowledge Remove] Chunk deletion affected ${chunkResult.changes} rows`
                    );

                    // Execute and log main entry deletion
                    const mainDeleteSql = "DELETE FROM knowledge WHERE id = ?";
                    elizaLogger.debug(
                        `[Knowledge Remove] Executing main deletion: ${mainDeleteSql} [${id}]`
                    );
                    const mainResult = this.db.prepare(mainDeleteSql).run(id);
                    elizaLogger.debug(
                        `[Knowledge Remove] Main deletion affected ${mainResult.changes} rows`
                    );

                    const totalChanges =
                        chunkResult.changes + mainResult.changes;
                    elizaLogger.debug(
                        `[Knowledge Remove] Total rows affected: ${totalChanges}`
                    );

                    // Verify deletion
                    const verifyMain = this.db.prepare(selectSql).get(id);
                    const verifyChunks = this.db.prepare(chunkSql).all(id);
                    elizaLogger.debug(
                        `[Knowledge Remove] Post-deletion check:`,
                        {
                            mainStillExists: !!verifyMain,
                            remainingChunks: verifyChunks.length,
                        }
                    );

                    return totalChanges; // Return changes for logging
                }
            })(); // Important: Call the transaction function

            elizaLogger.debug(
                `[Knowledge Remove] Transaction completed for id: ${id}`
            );
        } catch (error) {
            elizaLogger.error("[Knowledge Remove] Error:", {
                id,
                error:
                    error instanceof Error
                        ? {
                              message: error.message,
                              stack: error.stack,
                              name: error.name,
                          }
                        : error,
            });
            throw error;
        }
    }

    async clearKnowledge(agentId: UUID, shared?: boolean): Promise<void> {
        const sql = shared
            ? `DELETE FROM knowledge WHERE (agentId = ? OR isShared = 1)`
            : `DELETE FROM knowledge WHERE agentId = ?`;
        try {
            this.db.prepare(sql).run(agentId);
        } catch (error) {
            elizaLogger.error(
                `Error clearing knowledge for agent ${agentId}:`,
                error
            );
            throw error;
        }
    }

    // Action cache methods for public memory

    async searchActionCache(params: {
        queryEmbedding: number[];
        actionName?: string;
        similarityThreshold: number;
        querySimilarityThreshold: number;
        limit: number;
    }): Promise<CachedActionResult[]> {
        const {
            queryEmbedding,
            actionName,
            similarityThreshold,
            querySimilarityThreshold,
            limit,
        } = params;

        try {
            // Normalize embedding dimensions
            const config = getEmbeddingConfig();
            const expectedDims = config.dimensions;
            let normalizedEmbedding = queryEmbedding;

            if (queryEmbedding.length !== expectedDims) {
                if (queryEmbedding.length < expectedDims) {
                    normalizedEmbedding = [
                        ...queryEmbedding,
                        ...new Array(expectedDims - queryEmbedding.length).fill(0),
                    ];
                } else {
                    normalizedEmbedding = queryEmbedding.slice(0, expectedDims);
                }
            }

            const float32Embedding = new Float32Array(normalizedEmbedding);
            const now = Date.now();

            // Configuration for the new search strategy
            const queryBasedCount = 3;    // Number of chunks from best matching query
            const chunkBasedCount = 4;    // Number of chunks from global search
            const topChunksForRandom = 7; // Sample from top N chunks
            const percentile = 0.4;       // Top 40% percentile for diversity
            const candidatePoolSize = 50; // Size of candidate pool for percentile calculation
            const targetTotal = 7;        // Total chunks to return

            // Phase 1: Find the best matching query
            const bestQuerySql = actionName
                ? `
                    SELECT query,
                           MIN(vec_distance_L2(queryEmbedding, ?)) as minQueryDistance,
                           COUNT(*) as chunkCount
                    FROM action_cache
                    WHERE actionName = ? AND expiresAt > ?
                    GROUP BY query
                    ORDER BY minQueryDistance ASC
                    LIMIT 1
                `
                : `
                    SELECT query,
                           MIN(vec_distance_L2(queryEmbedding, ?)) as minQueryDistance,
                           COUNT(*) as chunkCount
                    FROM action_cache
                    WHERE expiresAt > ?
                    GROUP BY query
                    ORDER BY minQueryDistance ASC
                    LIMIT 1
                `;

            const bestQueryParams = actionName
                ? [float32Embedding, actionName, now]
                : [float32Embedding, now];

            const bestQueryRows = this.db.prepare(bestQuerySql).all(...bestQueryParams) as any[];

            if (bestQueryRows.length === 0) {
                elizaLogger.debug("No matching queries found in action cache");
                return [];
            }

            const bestQuery = bestQueryRows[0].query;
            elizaLogger.debug(`Best matching query: "${bestQuery}" (distance: ${bestQueryRows[0].minQueryDistance}, chunks: ${bestQueryRows[0].chunkCount})`);

            // Phase 2: Get chunks from best matching query
            const queryBasedSql = actionName
                ? `
                    SELECT id, actionName, query, result, chunkIndex, totalChunks,
                           createdAt, expiresAt, hitCount,
                           vec_distance_L2(embedding, ?) AS resultDistance,
                           vec_distance_L2(queryEmbedding, ?) AS queryDistance
                    FROM action_cache
                    WHERE query = ? AND actionName = ? AND expiresAt > ?
                    ORDER BY resultDistance ASC
                `
                : `
                    SELECT id, actionName, query, result, chunkIndex, totalChunks,
                           createdAt, expiresAt, hitCount,
                           vec_distance_L2(embedding, ?) AS resultDistance,
                           vec_distance_L2(queryEmbedding, ?) AS queryDistance
                    FROM action_cache
                    WHERE query = ? AND expiresAt > ?
                    ORDER BY resultDistance ASC
                `;

            const queryBasedParams = actionName
                ? [float32Embedding, float32Embedding, bestQuery, actionName, now]
                : [float32Embedding, float32Embedding, bestQuery, now];

            const queryBasedRows = this.db.prepare(queryBasedSql).all(...queryBasedParams) as any[];

            // Phase 3: Get global chunk candidates
            const chunkBasedSql = actionName
                ? `
                    SELECT id, actionName, query, result, chunkIndex, totalChunks,
                           createdAt, expiresAt, hitCount,
                           vec_distance_L2(embedding, ?) AS resultDistance,
                           vec_distance_L2(queryEmbedding, ?) AS queryDistance
                    FROM action_cache
                    WHERE actionName = ? AND expiresAt > ?
                    ORDER BY resultDistance ASC
                    LIMIT ?
                `
                : `
                    SELECT id, actionName, query, result, chunkIndex, totalChunks,
                           createdAt, expiresAt, hitCount,
                           vec_distance_L2(embedding, ?) AS resultDistance,
                           vec_distance_L2(queryEmbedding, ?) AS queryDistance
                    FROM action_cache
                    WHERE expiresAt > ?
                    ORDER BY resultDistance ASC
                    LIMIT ?
                `;

            const chunkBasedParams = actionName
                ? [float32Embedding, float32Embedding, actionName, now, candidatePoolSize]
                : [float32Embedding, float32Embedding, now, candidatePoolSize];

            const chunkBasedRows = this.db.prepare(chunkBasedSql).all(...chunkBasedParams) as any[];

            // Helper function to convert row to CachedActionResult
            const convertRow = (row: any): CachedActionResult => {
                const resultSimilarity = 1 / (1 + row.resultDistance);
                const querySimilarity = 1 / (1 + row.queryDistance);
                return {
                    id: row.id as UUID,
                    actionName: row.actionName,
                    query: row.query,
                    result: row.result,
                    chunkIndex: row.chunkIndex,
                    totalChunks: row.totalChunks,
                    createdAt: row.createdAt,
                    expiresAt: row.expiresAt,
                    hitCount: row.hitCount,
                    similarity: resultSimilarity,
                    querySimilarity,
                };
            };

            // Helper function: random sample
            const randomSample = <T>(array: T[], count: number): T[] => {
                if (array.length <= count) return array;
                const shuffled = [...array].sort(() => Math.random() - 0.5);
                return shuffled.slice(0, count);
            };

            // Step 1: Select top 3 from best matching query
            const selectedQueryBased = queryBasedRows
                .slice(0, queryBasedCount)
                .map(convertRow);

            elizaLogger.debug(`Selected ${selectedQueryBased.length} query-based chunks from "${bestQuery}"`);

            // Step 2: Select 4 chunks from global search
            const top7Chunks = chunkBasedRows.slice(0, topChunksForRandom);
            const random2FromTop7 = randomSample(top7Chunks, 2);

            // Calculate top 40% percentile range
            const percentileIndex = Math.floor(chunkBasedRows.length * percentile);
            const top40PercentChunks = chunkBasedRows.slice(0, Math.max(percentileIndex, topChunksForRandom));
            const random2FromTop40 = randomSample(top40PercentChunks, 2);

            const selectedChunkBased = [
                ...random2FromTop7,
                ...random2FromTop40
            ].map(convertRow);

            elizaLogger.debug(`Selected ${selectedChunkBased.length} chunk-based results (2 from top 7, 2 from top 40%)`);

            // Step 3: Combine and deduplicate
            const allSelected = [...selectedQueryBased, ...selectedChunkBased];
            const seenIds = new Set<string>();
            const deduplicated: CachedActionResult[] = [];

            for (const chunk of allSelected) {
                if (!seenIds.has(chunk.id)) {
                    seenIds.add(chunk.id);
                    deduplicated.push(chunk);
                }
            }

            elizaLogger.debug(`After deduplication: ${deduplicated.length} unique chunks`);

            // Step 4: If we have fewer than target, fill from remaining candidates
            if (deduplicated.length < targetTotal) {
                const needed = targetTotal - deduplicated.length;
                const remaining = chunkBasedRows
                    .map(convertRow)
                    .filter(chunk => !seenIds.has(chunk.id));

                const additional = remaining.slice(0, needed);
                deduplicated.push(...additional);

                if (additional.length > 0) {
                    elizaLogger.debug(`Added ${additional.length} additional chunks to reach target of ${targetTotal}`);
                }
            }

            // Step 5: Limit to target total and filter by similarity thresholds
            const finalResults = deduplicated
                .slice(0, targetTotal)
                .filter(chunk => {
                    const passesQueryThreshold = (chunk.querySimilarity ?? 0) >= querySimilarityThreshold;
                    const averageSimilarity = ((chunk.similarity ?? 0) + (chunk.querySimilarity ?? 0)) / 2;
                    const passesAverageThreshold = (chunk.querySimilarity ?? 0) < querySimilarityThreshold
                        ? averageSimilarity >= similarityThreshold
                        : false;

                    return passesQueryThreshold || passesAverageThreshold;
                });

            elizaLogger.debug(`Final results: ${finalResults.length} chunks after similarity filtering`);

            return finalResults;
        } catch (error) {
            elizaLogger.error("Error searching action cache:", error);
            return [];
        }
    }

    async createActionCache(params: {
        id: UUID;
        actionName: string;
        query: string;
        queryEmbedding: number[];
        result: string;
        chunkIndex: number;
        totalChunks: number;
        embedding: number[];
        createdAt: number;
        expiresAt: number;
        hitCount: number;
    }): Promise<void> {
        try {
            const config = getEmbeddingConfig();
            const expectedDims = config.dimensions;

            // Normalize embeddings
            const normalizeEmbedding = (emb: number[]): Float32Array => {
                let normalized = emb;
                if (emb.length < expectedDims) {
                    normalized = [...emb, ...new Array(expectedDims - emb.length).fill(0)];
                } else if (emb.length > expectedDims) {
                    normalized = emb.slice(0, expectedDims);
                }
                return new Float32Array(normalized);
            };

            const queryEmbFloat32 = normalizeEmbedding(params.queryEmbedding);
            const embFloat32 = normalizeEmbedding(params.embedding);

            const sql = `
                INSERT INTO action_cache (
                    id, actionName, query, queryEmbedding, result,
                    chunkIndex, totalChunks, embedding,
                    createdAt, expiresAt, hitCount
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;

            this.db.prepare(sql).run(
                params.id,
                params.actionName,
                params.query,
                queryEmbFloat32,
                params.result,
                params.chunkIndex,
                params.totalChunks,
                embFloat32,
                params.createdAt,
                params.expiresAt,
                params.hitCount
            );
        } catch (error) {
            elizaLogger.error("Error creating action cache:", error);
            throw error;
        }
    }

    async incrementActionCacheHitCount(ids: UUID[]): Promise<void> {
        if (ids.length === 0) return;

        try {
            const placeholders = ids.map(() => "?").join(", ");
            const sql = `UPDATE action_cache SET hitCount = hitCount + 1 WHERE id IN (${placeholders})`;
            this.db.prepare(sql).run(...ids);
        } catch (error) {
            elizaLogger.error("Error incrementing action cache hit count:", error);
        }
    }

    async cleanupExpiredActionCache(): Promise<number> {
        try {
            const now = Date.now();
            const sql = `DELETE FROM action_cache WHERE expiresAt <= ?`;
            const result = this.db.prepare(sql).run(now);
            return result.changes;
        } catch (error) {
            elizaLogger.error("Error cleaning up expired action cache:", error);
            return 0;
        }
    }

    async getActionCacheStats(): Promise<{
        totalEntries: number;
        totalHits: number;
        actionBreakdown: Record<string, number>;
    }> {
        try {
            // Get total entries and hits
            const totals = this.db
                .prepare(`SELECT COUNT(*) as total, SUM(hitCount) as hits FROM action_cache`)
                .get() as { total: number; hits: number };

            // Get breakdown by action
            const breakdown = this.db
                .prepare(`SELECT actionName, COUNT(*) as count FROM action_cache GROUP BY actionName`)
                .all() as { actionName: string; count: number }[];

            const actionBreakdown: Record<string, number> = {};
            for (const row of breakdown) {
                actionBreakdown[row.actionName] = row.count;
            }

            return {
                totalEntries: totals.total || 0,
                totalHits: totals.hits || 0,
                actionBreakdown,
            };
        } catch (error) {
            elizaLogger.error("Error getting action cache stats:", error);
            return {
                totalEntries: 0,
                totalHits: 0,
                actionBreakdown: {},
            };
        }
    }

    // ========================================
    // Referral Code Management Methods
    // ========================================

    /**
     * Get or create a referral code for a user
     * @param userId - The user's UUID
     * @returns The 5-character referral code
     */
    async getOrCreateReferralCode(userId: UUID): Promise<string> {
        try {
            // Check if code already exists
            const existing = this.db
                .prepare(
                    "SELECT referralCode FROM referral_codes WHERE userId = ? ORDER BY createdAt ASC LIMIT 1"
                )
                .get(userId) as { referralCode: string } | undefined;

            if (existing) {
                return existing.referralCode;
            }

            // Generate new 5-character code
            const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
            let code: string;
            let attempts = 0;
            const maxAttempts = 100;

            do {
                // M10: Use crypto.randomBytes for unpredictable referral codes.
                // Top-level ESM import — `require("crypto")` is fatal here
                // because tsup builds this package as ESM and esbuild's
                // runtime stub for dynamic require throws.
                const buf = randomBytes(5);
                code = "";
                for (let i = 0; i < 5; i++) {
                    code += characters.charAt(buf[i] % characters.length);
                }
                attempts++;

                // Check if code already exists
                const duplicate = this.db
                    .prepare("SELECT id FROM referral_codes WHERE referralCode = ?")
                    .get(code);

                if (!duplicate) {
                    break;
                }
            } while (attempts < maxAttempts);

            if (attempts >= maxAttempts) {
                throw new Error("Failed to generate unique referral code");
            }

            // Insert new code
            const id = v4();
            this.db
                .prepare(`
                    INSERT INTO referral_codes (id, userId, referralCode, createdAt)
                    VALUES (?, ?, ?, ?)
                `)
                .run(id, userId, code, Date.now());

            elizaLogger.info(`Generated referral code ${code} for user ${userId}`);
            return code;
        } catch (error) {
            elizaLogger.error("Error getting/creating referral code:", error);
            throw error;
        }
    }

    /**
     * Get user ID by referral code
     * @param code - The 5-character referral code
     * @returns The user UUID or null if not found
     */
    async getUserIdByReferralCode(code: string): Promise<UUID | null> {
        try {
            const result = this.db
                .prepare("SELECT userId FROM referral_codes WHERE referralCode = ?")
                .get(code) as { userId: string } | undefined;

            return result ? (result.userId as UUID) : null;
        } catch (error) {
            elizaLogger.error("Error looking up referral code:", error);
            return null;
        }
    }

    /**
     * Validate that a referral code exists
     * @param code - The 5-character referral code
     * @returns True if code exists, false otherwise
     */
    async validateReferralCode(code: string): Promise<boolean> {
        try {
            const result = this.db
                .prepare("SELECT 1 FROM referral_codes WHERE referralCode = ?")
                .get(code);

            return result !== undefined;
        } catch (error) {
            elizaLogger.error("Error validating referral code:", error);
            return false;
        }
    }

    // ========================================
    // Referral Relationship Methods
    // ========================================

    /**
     * Create a referral relationship
     * @param params - Referral creation parameters
     * @returns True if successful, false otherwise
     */
    async createReferral(params: {
        referredUserId: UUID;
        referralCode: string;
    }): Promise<boolean> {
        try {
            // Look up referrer by code
            const referrerId = await this.getUserIdByReferralCode(params.referralCode);
            if (!referrerId) {
                elizaLogger.warn(`Invalid referral code: ${params.referralCode}`);
                return false;
            }

            // Check if user is already referred
            const existing = this.db
                .prepare("SELECT id FROM referrals WHERE referredUserId = ?")
                .get(params.referredUserId);

            if (existing) {
                elizaLogger.warn(`User ${params.referredUserId} already has a referrer`);
                return false;
            }

            // Check for self-referral
            if (referrerId === params.referredUserId) {
                elizaLogger.warn(`User ${params.referredUserId} attempted self-referral`);
                return false;
            }

            // Create referral relationship
            const id = v4();
            this.db
                .prepare(`
                    INSERT INTO referrals (id, referrerId, referredUserId, referralCode, createdAt)
                    VALUES (?, ?, ?, ?, ?)
                `)
                .run(id, referrerId, params.referredUserId, params.referralCode, Date.now());

            elizaLogger.info(`Created referral: ${params.referredUserId} referred by ${referrerId}`);
            return true;
        } catch (error) {
            elizaLogger.error("Error creating referral:", error);
            return false;
        }
    }

    /**
     * Get the referrer for a user
     * @param userId - The referred user's UUID
     * @returns The referrer's UUID or null if not referred
     */
    async getReferrerByUserId(userId: UUID): Promise<UUID | null> {
        try {
            const result = this.db
                .prepare("SELECT referrerId FROM referrals WHERE referredUserId = ?")
                .get(userId) as { referrerId: string } | undefined;

            return result ? (result.referrerId as UUID) : null;
        } catch (error) {
            elizaLogger.error("Error getting referrer:", error);
            return null;
        }
    }

    /**
     * Get all users referred by a referrer
     * @param referrerId - The referrer's UUID
     * @returns Array of referred users with their details
     */
    async getReferredUsers(referrerId: UUID): Promise<Array<{
        userId: UUID;
        email: string;
        createdAt: number;
    }>> {
        try {
            const sql = `
                SELECT r.referredUserId as userId, a.email, r.createdAt
                FROM referrals r
                JOIN accounts a ON r.referredUserId = a.id
                WHERE r.referrerId = ?
                ORDER BY r.createdAt DESC
            `;

            const rows = this.db.prepare(sql).all(referrerId) as Array<{
                userId: string;
                email: string;
                createdAt: number;
            }>;

            return rows.map(row => ({
                userId: row.userId as UUID,
                email: row.email,
                createdAt: row.createdAt,
            }));
        } catch (error) {
            elizaLogger.error("Error getting referred users:", error);
            return [];
        }
    }

    /**
     * Record the referral code used by a user during registration
     * @param params - User ID, referral code, and whether it matched
     * @returns True if successful, false otherwise
     */
    async recordUserReferralCode(params: {
        userId: UUID;
        referralCodeUsed: string;
        isMatched: boolean;
    }): Promise<boolean> {
        try {
            // Check if already recorded
            const existing = this.db
                .prepare("SELECT id FROM user_referral_codes WHERE userId = ?")
                .get(params.userId);

            if (existing) {
                elizaLogger.debug(`User ${params.userId} referral code already recorded`);
                return true;
            }

            const id = v4();
            this.db
                .prepare(`
                    INSERT INTO user_referral_codes (id, userId, referralCodeUsed, isMatched, createdAt)
                    VALUES (?, ?, ?, ?, ?)
                `)
                .run(
                    id,
                    params.userId,
                    params.referralCodeUsed,
                    params.isMatched ? 1 : 0,
                    Date.now()
                );

            elizaLogger.info(`Recorded referral code for user ${params.userId}: ${params.referralCodeUsed} (matched: ${params.isMatched})`);
            return true;
        } catch (error) {
            elizaLogger.error("Error recording user referral code:", error);
            return false;
        }
    }

    /**
     * Get the referral code used by a user during registration
     * @param userId - The user's UUID
     * @returns Referral code info or null if not found
     */
    async getUserReferralCode(userId: UUID): Promise<{
        referralCodeUsed: string;
        isMatched: boolean;
        createdAt: number;
    } | null> {
        try {
            const result = this.db
                .prepare(`
                    SELECT referralCodeUsed, isMatched, createdAt
                    FROM user_referral_codes
                    WHERE userId = ?
                `)
                .get(userId) as {
                    referralCodeUsed: string;
                    isMatched: number;
                    createdAt: number;
                } | undefined;

            if (!result) {
                return null;
            }

            return {
                referralCodeUsed: result.referralCodeUsed,
                isMatched: result.isMatched === 1,
                createdAt: result.createdAt,
            };
        } catch (error) {
            elizaLogger.error("Error getting user referral code:", error);
            return null;
        }
    }

    // ========================================
    // Subscription Tracking Methods
    // ========================================

    /**
     * Persist resolved tier snapshots only when tier changes.
     * Also mirrors latest resolved tier into accounts.details.subscriptionTier.
     */
    async recordSubscriptionTierChange(params: {
        userId: UUID;
        tier: "free" | "plus" | "pro" | "enterprise";
        source?: string;
        observedAt?: number;
    }): Promise<boolean> {
        const observedAt =
            typeof params.observedAt === "number" && Number.isFinite(params.observedAt)
                ? Math.floor(params.observedAt)
                : Date.now();
        const source =
            typeof params.source === "string" && params.source.trim().length > 0
                ? params.source.trim()
                : "stripe_api";

        try {
            // All reads and the conditional write run inside a single transaction so
            // that concurrent callers cannot both pass the "tier unchanged" check and
            // insert duplicate rows (eliminates the TOCTOU window).
            const tx = this.db.transaction((): boolean | null => {
                const accountRow = this.db
                    .prepare("SELECT details FROM accounts WHERE id = ?")
                    .get(params.userId) as { details: string | null } | undefined;

                if (!accountRow) {
                    return null; // signal: account not found
                }

                const latestRow = this.db
                    .prepare(
                        `SELECT tier, observedAt
                         FROM user_subscription_tier_history
                         WHERE userId = ?
                         ORDER BY observedAt DESC, createdAt DESC, id DESC
                         LIMIT 1`
                    )
                    .get(params.userId) as
                    | {
                          tier: "free" | "plus" | "pro" | "enterprise";
                          observedAt: number;
                      }
                    | undefined;

                if (latestRow?.tier === params.tier) {
                    return false; // signal: tier unchanged, skip write
                }

                let details: Record<string, any> = {};
                if (accountRow.details) {
                    try {
                        const parsed = JSON.parse(accountRow.details) as unknown;
                        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                            details = parsed as Record<string, any>;
                        }
                    } catch {
                        details = {};
                    }
                }

                const updatedDetails = {
                    ...details,
                    subscriptionTier: {
                        currentTier: params.tier,
                        previousTier: latestRow?.tier ?? null,
                        changedAt: observedAt,
                        source,
                    },
                };

                this.db
                    .prepare(
                        `INSERT INTO user_subscription_tier_history (
                            id, userId, tier, source, observedAt, createdAt
                        ) VALUES (?, ?, ?, ?, ?, ?)`
                    )
                    .run(
                        v4(),
                        params.userId,
                        params.tier,
                        source,
                        observedAt,
                        Date.now()
                    );

                this.db
                    .prepare("UPDATE accounts SET details = ? WHERE id = ?")
                    .run(JSON.stringify(updatedDetails), params.userId);

                return true;
            });

            const result = tx();
            if (result === null) {
                elizaLogger.warn(
                    `recordSubscriptionTierChange skipped: account not found for ${params.userId}`
                );
                return false;
            }
            return result;
        } catch (error) {
            elizaLogger.error("Error recording subscription tier change:", error);
            return false;
        }
    }

    /**
     * Record a subscription event from Stripe webhook
     * @param params - Event parameters
     * @returns True if successful, false otherwise
     */
    async recordSubscriptionEvent(params: {
        userId: UUID;
        eventType: string;
        stripeEventId: string;
        stripeCustomerId?: string;
        stripeSubscriptionId?: string;
        subscriptionStatus?: string;
        planName?: string;
        amountCents?: number;
        currency?: string;
        eventData: object;
    }): Promise<boolean> {
        try {
            const id = v4();
            this.db
                .prepare(`
                    INSERT INTO subscription_events (
                        id, userId, eventType, stripeEventId, stripeCustomerId,
                        stripeSubscriptionId, subscriptionStatus, planName,
                        amountCents, currency, eventData, createdAt
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `)
                .run(
                    id,
                    params.userId,
                    params.eventType,
                    params.stripeEventId,
                    params.stripeCustomerId || null,
                    params.stripeSubscriptionId || null,
                    params.subscriptionStatus || null,
                    params.planName || null,
                    params.amountCents || null,
                    params.currency || null,
                    JSON.stringify(params.eventData),
                    Date.now()
                );

            return true;
        } catch (error: any) {
            // Check if this is a duplicate event (UNIQUE constraint violation)
            if (error.message?.includes("UNIQUE constraint")) {
                elizaLogger.debug(`Duplicate Stripe event ignored: ${params.stripeEventId}`);
                return false;
            }
            elizaLogger.error("Error recording subscription event:", error);
            return false;
        }
    }

    /**
     * Update user's current subscription status
     * @param params - Subscription update parameters
     * @returns True if successful, false otherwise
     */
    async updateUserSubscription(params: {
        userId: UUID;
        stripeCustomerId?: string;
        stripeSubscriptionId?: string;
        subscriptionStatus: string;
        planName?: string;
        currentPeriodStart?: number;
        currentPeriodEnd?: number;
        cancelAtPeriodEnd?: boolean;
        lastEventId: string;
    }): Promise<boolean> {
        try {
            // Check if subscription record exists
            const existing = this.db
                .prepare("SELECT id FROM user_subscriptions WHERE userId = ?")
                .get(params.userId) as { id: string } | undefined;

            if (existing) {
                // Update existing record
                this.db
                    .prepare(`
                        UPDATE user_subscriptions
                        SET stripeCustomerId = ?,
                            stripeSubscriptionId = ?,
                            subscriptionStatus = ?,
                            planName = ?,
                            currentPeriodStart = ?,
                            currentPeriodEnd = ?,
                            cancelAtPeriodEnd = ?,
                            lastEventId = ?,
                            updatedAt = ?
                        WHERE userId = ?
                    `)
                    .run(
                        params.stripeCustomerId || null,
                        params.stripeSubscriptionId || null,
                        params.subscriptionStatus,
                        params.planName || null,
                        params.currentPeriodStart || null,
                        params.currentPeriodEnd || null,
                        params.cancelAtPeriodEnd ? 1 : 0,
                        params.lastEventId,
                        Date.now(),
                        params.userId
                    );
            } else {
                // Insert new record
                const id = v4();
                this.db
                    .prepare(`
                        INSERT INTO user_subscriptions (
                            id, userId, stripeCustomerId, stripeSubscriptionId,
                            subscriptionStatus, planName, currentPeriodStart,
                            currentPeriodEnd, cancelAtPeriodEnd, lastEventId,
                            updatedAt, createdAt
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `)
                    .run(
                        id,
                        params.userId,
                        params.stripeCustomerId || null,
                        params.stripeSubscriptionId || null,
                        params.subscriptionStatus,
                        params.planName || null,
                        params.currentPeriodStart || null,
                        params.currentPeriodEnd || null,
                        params.cancelAtPeriodEnd ? 1 : 0,
                        params.lastEventId,
                        Date.now(),
                        Date.now()
                    );
            }

            return true;
        } catch (error) {
            elizaLogger.error("Error updating user subscription:", error);
            return false;
        }
    }

    /**
     * Get user's current subscription
     * @param userId - The user's UUID
     * @returns Subscription data or null if not found
     */
    async getUserSubscription(userId: UUID): Promise<{
        subscriptionStatus: string;
        planName: string | null;
        currentPeriodEnd: number | null;
    } | null> {
        try {
            const result = this.db
                .prepare(`
                    SELECT subscriptionStatus, planName, currentPeriodEnd
                    FROM user_subscriptions
                    WHERE userId = ?
                `)
                .get(userId) as {
                    subscriptionStatus: string;
                    planName: string | null;
                    currentPeriodEnd: number | null;
                } | undefined;

            return result || null;
        } catch (error) {
            elizaLogger.error("Error getting user subscription:", error);
            return null;
        }
    }

    /**
     * Get subscription events for a user
     * @param userId - The user's UUID
     * @param options - Query options
     * @returns Array of subscription events
     */
    async getSubscriptionEvents(userId: UUID, options?: {
        limit?: number;
        offset?: number;
        eventType?: string;
    }): Promise<Array<{
        eventType: string;
        amountCents: number | null;
        currency: string | null;
        createdAt: number;
    }>> {
        try {
            let sql = `
                SELECT eventType, amountCents, currency, createdAt
                FROM subscription_events
                WHERE userId = ?
            `;

            const params: any[] = [userId];

            if (options?.eventType) {
                sql += " AND eventType = ?";
                params.push(options.eventType);
            }

            sql += " ORDER BY createdAt DESC";

            if (options?.limit) {
                sql += " LIMIT ?";
                params.push(options.limit);
            }

            if (options?.offset) {
                sql += " OFFSET ?";
                params.push(options.offset);
            }

            const rows = this.db.prepare(sql).all(...params) as Array<{
                eventType: string;
                amountCents: number | null;
                currency: string | null;
                createdAt: number;
            }>;

            return rows;
        } catch (error) {
            elizaLogger.error("Error getting subscription events:", error);
            return [];
        }
    }

    /**
     * Get user by Stripe customer ID
     * @param stripeCustomerId - The Stripe customer ID
     * @returns User subscription data or null if not found
     */
    async getUserByStripeCustomerId(stripeCustomerId: string): Promise<{
        userId: UUID;
    } | null> {
        try {
            const result = this.db
                .prepare(`
                    SELECT userId
                    FROM user_subscriptions
                    WHERE stripeCustomerId = ?
                `)
                .get(stripeCustomerId) as { userId: string } | undefined;

            return result ? { userId: result.userId as UUID } : null;
        } catch (error) {
            elizaLogger.error("Error getting user by Stripe customer ID:", error);
            return null;
        }
    }

    async getExchangeRegistry(): Promise<ExchangeRegistryEntry[]> {
        const rows = this.db
            .prepare(
                `
                SELECT id, name, defaultAuthType, authTypes
                FROM exchange_registry
            `
            )
            .all() as Array<{
            id: string;
            name: string;
            defaultAuthType: ExchangeAuthType | null;
            authTypes: string;
        }>;

        return rows.map((row) => {
            let authTypes: ExchangeRegistryEntry["authTypes"] = [];
            try {
                const parsed = JSON.parse(row.authTypes) as any[];
                authTypes = parsed.map((option) => ({
                    type: option.type,
                    fields: Array.isArray(option.fields)
                        ? option.fields.map((f: any) => ({
                              id: f.id ?? f.key,
                              label: f.label,
                              type: f.type,
                              required: f.required,
                              description: f.description,
                              placeholder: f.placeholder,
                          }))
                        : [],
                }));
            } catch (error) {
                elizaLogger.error(
                    "Failed to parse exchange_registry.authTypes JSON",
                    error,
                    { id: row.id }
                );
            }

            return {
                id: row.id as ExchangeRegistryEntry["id"],
                name: row.name,
                authTypes,
                defaultAuthType: row.defaultAuthType ?? undefined,
            };
        });
    }

    async getExchangeRegistryEntry(id: string): Promise<ExchangeRegistryEntry | null> {
        const row = this.db
            .prepare(
                `
                SELECT id, name, defaultAuthType, authTypes
                FROM exchange_registry
                WHERE id = ?
            `
            )
            .get(id) as
            | {
                  id: string;
                  name: string;
                  defaultAuthType: ExchangeAuthType | null;
                  authTypes: string;
              }
            | undefined;

        if (!row) return null;

        let authTypes: ExchangeRegistryEntry["authTypes"] = [];
        try {
            const parsed = JSON.parse(row.authTypes) as any[];
            authTypes = parsed.map((option) => ({
                type: option.type,
                fields: Array.isArray(option.fields)
                    ? option.fields.map((f: any) => ({
                          id: f.id ?? f.key,
                          label: f.label,
                          type: f.type,
                          required: f.required,
                          description: f.description,
                          placeholder: f.placeholder,
                      }))
                    : [],
            }));
        } catch (error) {
            elizaLogger.error(
                "Failed to parse exchange_registry.authTypes JSON for entry",
                error,
                { id: row.id }
            );
        }

        return {
            id: row.id as ExchangeRegistryEntry["id"],
            name: row.name,
            authTypes,
            defaultAuthType: row.defaultAuthType ?? undefined,
        };
    }

    // ========================================
    // Referral Analytics Methods
    // ========================================

    /**
     * Get referral statistics for a referrer
     * @param referrerId - The referrer's UUID
     * @returns Referral stats including total referrals, active subscriptions, and revenue
     */
    async getReferralStats(referrerId: UUID): Promise<{
        totalReferrals: number;
        activeSubscriptions: number;
        totalRevenue: number;
        currency: string;
    }> {
        try {
            // Get all referral codes for this user
            const codes = this.db
                .prepare("SELECT referralCode FROM referral_codes WHERE userId = ?")
                .all(referrerId) as Array<{ referralCode: string }>;

            let totalReferrals = 0;

            if (codes.length > 0) {
                const codeValues = codes.map((row) => row.referralCode);
                const placeholders = codeValues.map(() => "?").join(", ");
                // Count only matched users (isMatched=1), exclude custom referral codes
                const totalResult = this.db
                    .prepare(`
                        SELECT COUNT(*) as count
                        FROM user_referral_codes
                        WHERE referralCodeUsed IN (${placeholders})
                        AND isMatched = 1
                    `)
                    .get(...codeValues) as { count: number };

                totalReferrals = totalResult.count;
            }

            // Get active subscriptions count (only matched referrals have subscription tracking)
            const activeResult = this.db
                .prepare(`
                    SELECT COUNT(*) as count
                    FROM referrals r
                    JOIN user_subscriptions us ON r.referredUserId = us.userId
                    WHERE r.referrerId = ?
                    AND us.subscriptionStatus IN ('active', 'trialing', 'past_due')
                `)
                .get(referrerId) as { count: number };

            // Get total revenue from referred users (only matched referrals)
            const revenueResult = this.db
                .prepare(`
                    SELECT
                        SUM(se.amountCents) as totalCents,
                        se.currency
                    FROM referrals r
                    JOIN subscription_events se ON r.referredUserId = se.userId
                    WHERE r.referrerId = ?
                    AND se.eventType = 'invoice.payment_succeeded'
                    AND se.amountCents IS NOT NULL
                    GROUP BY se.currency
                    ORDER BY SUM(se.amountCents) DESC
                    LIMIT 1
                `)
                .get(referrerId) as { totalCents: number; currency: string } | undefined;

            return {
                totalReferrals,
                activeSubscriptions: activeResult.count,
                totalRevenue: revenueResult?.totalCents || 0,
                currency: revenueResult?.currency || "usd",
            };
        } catch (error) {
            elizaLogger.error("Error getting referral stats:", error);
            return {
                totalReferrals: 0,
                activeSubscriptions: 0,
                totalRevenue: 0,
                currency: "usd",
            };
        }
    }

    /**
     * Get payment history for all referred users
     * @param referrerId - The referrer's UUID
     * @returns Array of referred users with their payment details
     */
    async getReferredUsersPaymentHistory(referrerId: UUID): Promise<Array<{
        referredUserEmail: string;
        subscriptionStatus: string;
        planName: string | null;
        totalPaid: number;
        lastPaymentDate: number | null;
    }>> {
        try {
            const sql = `
                SELECT
                    a.email as referredUserEmail,
                    COALESCE(us.subscriptionStatus, 'none') as subscriptionStatus,
                    us.planName,
                    COALESCE(SUM(se.amountCents), 0) as totalPaid,
                    MAX(se.createdAt) as lastPaymentDate
                FROM referrals r
                JOIN accounts a ON r.referredUserId = a.id
                LEFT JOIN user_subscriptions us ON r.referredUserId = us.userId
                LEFT JOIN subscription_events se ON r.referredUserId = se.userId
                    AND se.eventType = 'invoice.payment_succeeded'
                WHERE r.referrerId = ?
                GROUP BY r.referredUserId, a.email, us.subscriptionStatus, us.planName
                ORDER BY lastPaymentDate DESC NULLS LAST
            `;

            const rows = this.db.prepare(sql).all(referrerId) as Array<{
                referredUserEmail: string;
                subscriptionStatus: string;
                planName: string | null;
                totalPaid: number;
                lastPaymentDate: number | null;
            }>;

            return rows;
        } catch (error) {
            elizaLogger.error("Error getting referred users payment history:", error);
            return [];
        }
    }

    /**
     * Saves token usage data to the database for quota tracking.
     * Only saves for authenticated users (skip anonymous users to avoid FK constraint errors)
     */
    async saveTokenUsage(params: {
        id: string;
        userId: string;
        agentId: string;
        roomId?: string;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        modelProvider?: string;
        modelName?: string;
        modelClass?: string;
        timestamp: number;
    }): Promise<void> {
        return this.withCircuitBreaker(async () => {
            try {
                // Check if user exists in accounts table (skip anonymous users)
                const userExists = this.db
                    .prepare(`SELECT 1 FROM accounts WHERE id = ? LIMIT 1`)
                    .get(params.userId);

                if (!userExists) {
                    // Skip saving for anonymous users (no account record)
                    elizaLogger.debug(`Skipping token usage save for anonymous user: ${params.userId}`);
                    return;
                }

                this.db
                    .prepare(
                        `INSERT INTO token_usage (
                            id, userId, agentId, roomId,
                            inputTokens, outputTokens, totalTokens,
                            modelProvider, modelName, modelClass,
                            timestamp, createdAt
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
                    )
                    .run(
                        params.id,
                        params.userId,
                        params.agentId,
                        params.roomId || null,
                        params.inputTokens,
                        params.outputTokens,
                        params.totalTokens,
                        params.modelProvider || null,
                        params.modelName || null,
                        params.modelClass || null,
                        params.timestamp
                    );
            } catch (error) {
                elizaLogger.error("Error saving token usage:", error);
                throw error;
            }
        }, "saveTokenUsage");
    }

    /**
     * Retrieves aggregated token usage for a user within a time window.
     */
    async getUserTokenUsage(params: {
        userId: string;
        since: number;
        until?: number;
    }): Promise<{
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
    }> {
        return this.withCircuitBreaker(async () => {
            try {
                const query = params.until
                    ? `SELECT
                        COALESCE(SUM(inputTokens), 0) as inputTokens,
                        COALESCE(SUM(outputTokens), 0) as outputTokens,
                        COALESCE(SUM(totalTokens), 0) as totalTokens
                       FROM token_usage
                       WHERE userId = ? AND timestamp >= ? AND timestamp < ?`
                    : `SELECT
                        COALESCE(SUM(inputTokens), 0) as inputTokens,
                        COALESCE(SUM(outputTokens), 0) as outputTokens,
                        COALESCE(SUM(totalTokens), 0) as totalTokens
                       FROM token_usage
                       WHERE userId = ? AND timestamp >= ?`;

                const row = params.until
                    ? this.db.prepare(query).get(params.userId, params.since, params.until)
                    : this.db.prepare(query).get(params.userId, params.since);

                if (!row) {
                    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
                }

                return {
                    inputTokens: (row as any).inputTokens || 0,
                    outputTokens: (row as any).outputTokens || 0,
                    totalTokens: (row as any).totalTokens || 0,
                };
            } catch (error) {
                elizaLogger.error("Error getting user token usage:", error);
                throw error;
            }
        }, "getUserTokenUsage");
    }

    /**
     * Gets the timestamp of the user's first token usage.
     */
    async getUserFirstTokenUsageTimestamp(params: {
        userId: string;
    }): Promise<number | null> {
        return this.withCircuitBreaker(async () => {
            try {
                const row = this.db
                    .prepare(
                        `SELECT MIN(timestamp) as firstTimestamp
                         FROM token_usage
                         WHERE userId = ?`
                    )
                    .get(params.userId) as { firstTimestamp: number | null };

                return row?.firstTimestamp || null;
            } catch (error) {
                elizaLogger.error("Error getting user first token usage timestamp:", error);
                throw error;
            }
        }, "getUserFirstTokenUsageTimestamp");
    }

    /**
     * Cleans up old token usage records older than the specified timestamp.
     */
    async cleanupOldTokenUsage(olderThan: number): Promise<number> {
        return this.withCircuitBreaker(async () => {
            try {
                const result = this.db
                    .prepare(`DELETE FROM token_usage WHERE timestamp < ?`)
                    .run(olderThan);

                elizaLogger.info(`Cleaned up ${result.changes} old token usage records`);
                return result.changes;
            } catch (error) {
                elizaLogger.error("Error cleaning up old token usage:", error);
                throw error;
            }
        }, "cleanupOldTokenUsage");
    }

    // ========================================================================
    // F3 — paper_orders ledger (SQLite parity with MongoDB adapter)
    //
    // SQLite is the secondary adapter for senti-agent-0428 — local dev and
    // prod both prefer MongoDB. These methods exist to satisfy IDatabaseAdapter
    // parity so unit tests that exercise the SQLite path don't crash. Schema
    // is created lazily on first write.
    // ========================================================================
    private ensurePaperOrdersTables(): void {
        if ((this as { __paperOrdersReady?: boolean }).__paperOrdersReady) return;
        this.db.exec(
            `CREATE TABLE IF NOT EXISTS paper_orders (
                userId TEXT NOT NULL,
                order_id TEXT NOT NULL,
                venue TEXT,
                client_order_id TEXT,
                product_id TEXT,
                side TEXT,
                status TEXT,
                quantity TEXT,
                price TEXT,
                created_at TEXT,
                filled_at TEXT,
                updated_at TEXT,
                ttl_at INTEGER,
                margin_type TEXT,
                margin_action TEXT,
                leverage TEXT,
                PRIMARY KEY (userId, order_id)
            );
            CREATE INDEX IF NOT EXISTS idx_paper_orders_user_status ON paper_orders(userId, status);
            CREATE INDEX IF NOT EXISTS idx_paper_orders_ttl ON paper_orders(ttl_at);

            CREATE TABLE IF NOT EXISTS paper_fills (
                userId TEXT NOT NULL,
                order_id TEXT NOT NULL,
                venue TEXT,
                client_order_id TEXT,
                product_id TEXT,
                side TEXT,
                fill_price TEXT,
                fill_quantity TEXT,
                filled_at TEXT,
                ttl_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_paper_fills_user_order ON paper_fills(userId, order_id);`,
        );
        // Defensive ALTER for SQLite databases created before the
        // F9 margin columns were added. SQLite tolerates ADD COLUMN
        // even for tables that already have the column? No — it throws.
        // We swallow the duplicate-column error per column so re-runs are
        // idempotent across schemas.
        for (const col of ["margin_type", "margin_action", "leverage"]) {
            try {
                this.db.exec(`ALTER TABLE paper_orders ADD COLUMN ${col} TEXT`);
            } catch {
                /* column already present — OK */
            }
        }
        (this as { __paperOrdersReady?: boolean }).__paperOrdersReady = true;
    }

    async paperOrdersAdd(record: Record<string, unknown>): Promise<void> {
        this.ensurePaperOrdersTables();
        this.db
            .prepare(
                `INSERT INTO paper_orders (userId, order_id, venue, client_order_id, product_id, side, status, quantity, price, created_at, filled_at, updated_at, ttl_at, margin_type, margin_action, leverage)
                 VALUES (@userId, @order_id, @venue, @client_order_id, @product_id, @side, @status, @quantity, @price, @created_at, @filled_at, @updated_at, @ttl_at, @margin_type, @margin_action, @leverage)
                 ON CONFLICT(userId, order_id) DO UPDATE SET
                    status = excluded.status,
                    quantity = excluded.quantity,
                    price = excluded.price,
                    updated_at = excluded.updated_at,
                    ttl_at = excluded.ttl_at,
                    margin_type = COALESCE(excluded.margin_type, paper_orders.margin_type),
                    margin_action = COALESCE(excluded.margin_action, paper_orders.margin_action),
                    leverage = COALESCE(excluded.leverage, paper_orders.leverage)`,
            )
            .run({
                userId: String(record.userId ?? ""),
                order_id: String(record.order_id ?? ""),
                venue: String(record.venue ?? ""),
                client_order_id: String(record.client_order_id ?? ""),
                product_id: String(record.product_id ?? ""),
                side: String(record.side ?? ""),
                status: String(record.status ?? ""),
                quantity: String(record.quantity ?? ""),
                price: record.price != null ? String(record.price) : null,
                created_at: String(record.created_at ?? ""),
                filled_at: record.filled_at != null ? String(record.filled_at) : null,
                updated_at: String(record.updated_at ?? new Date().toISOString()),
                ttl_at: Number(record.ttl_at ?? Date.now() + 86_400 * 1000),
                // F9 — preserve margin fields on the persisted row so the
                // paper ledger faithfully reproduces venue semantics.
                margin_type: record.margin_type != null ? String(record.margin_type) : null,
                margin_action: record.margin_action != null ? String(record.margin_action) : null,
                leverage: record.leverage != null ? String(record.leverage) : null,
            });
    }

    async paperOrdersGetByUser(
        userId: string,
        opts?: { statuses?: string[] },
    ): Promise<Record<string, unknown>[]> {
        this.ensurePaperOrdersTables();
        let rows: unknown[];
        if (opts?.statuses?.length) {
            const placeholders = opts.statuses.map(() => "?").join(",");
            rows = this.db
                .prepare(
                    `SELECT * FROM paper_orders WHERE userId = ? AND status IN (${placeholders}) ORDER BY created_at DESC`,
                )
                .all(userId, ...opts.statuses);
        } else {
            rows = this.db
                .prepare(`SELECT * FROM paper_orders WHERE userId = ? ORDER BY created_at DESC`)
                .all(userId);
        }
        return rows as Record<string, unknown>[];
    }

    async paperOrdersGetById(
        userId: string,
        orderId: string,
    ): Promise<Record<string, unknown> | null> {
        this.ensurePaperOrdersTables();
        const row = this.db
            .prepare(`SELECT * FROM paper_orders WHERE userId = ? AND order_id = ?`)
            .get(userId, orderId);
        return (row as Record<string, unknown> | undefined) ?? null;
    }

    async paperOrdersUpdateStatus(
        userId: string,
        orderId: string,
        status: string,
    ): Promise<boolean> {
        this.ensurePaperOrdersTables();
        const res = this.db
            .prepare(
                `UPDATE paper_orders SET status = ?, updated_at = ? WHERE userId = ? AND order_id = ?`,
            )
            .run(status, new Date().toISOString(), userId, orderId);
        return (res.changes ?? 0) > 0;
    }

    async paperFillsAdd(record: Record<string, unknown>): Promise<void> {
        this.ensurePaperOrdersTables();
        this.db
            .prepare(
                `INSERT INTO paper_fills (userId, order_id, venue, client_order_id, product_id, side, fill_price, fill_quantity, filled_at, ttl_at)
                 VALUES (@userId, @order_id, @venue, @client_order_id, @product_id, @side, @fill_price, @fill_quantity, @filled_at, @ttl_at)`,
            )
            .run({
                userId: String(record.userId ?? ""),
                order_id: String(record.order_id ?? ""),
                venue: String(record.venue ?? ""),
                client_order_id: String(record.client_order_id ?? ""),
                product_id: String(record.product_id ?? ""),
                side: String(record.side ?? ""),
                fill_price: String(record.fill_price ?? ""),
                fill_quantity: String(record.fill_quantity ?? ""),
                filled_at: String(record.filled_at ?? ""),
                ttl_at: Number(record.ttl_at ?? Date.now() + 86_400 * 1000),
            });
    }

    async paperFillsGetByUser(userId: string): Promise<Record<string, unknown>[]> {
        this.ensurePaperOrdersTables();
        const rows = this.db
            .prepare(`SELECT * FROM paper_fills WHERE userId = ? ORDER BY filled_at DESC`)
            .all(userId);
        return rows as Record<string, unknown>[];
    }
}

const sqliteDatabaseAdapter: Adapter = {
    init: (runtime: IAgentRuntime) => {
        const dataDir = path.join(process.cwd(), "data");

        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        const filePath = runtime.getSetting("SQLITE_FILE") ?? path.resolve(dataDir, "db.sqlite");
        elizaLogger.info(`Initializing SQLite database at ${filePath}...`);
        const db = new SqliteDatabaseAdapter(new Database(filePath));

        // Test the connection
        db.init()
            .then(() => {
                elizaLogger.success(
                    "Successfully connected to SQLite database"
                );
            })
            .catch((error) => {
                elizaLogger.error("Failed to connect to SQLite:", error);
            });

        return db;
    },
};

const sqlitePlugin: Plugin = {
    name: "sqlite",
    description: "SQLite database adapter plugin",
    adapters: [sqliteDatabaseAdapter],
};
export default sqlitePlugin;
