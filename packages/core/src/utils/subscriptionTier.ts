import type { Account, IAgentRuntime, UUID } from "../core/types.ts";
import { elizaLogger } from "./logger.ts";

export type ResolvedSubscriptionTier = "free" | "plus" | "pro" | "enterprise";

const isResolvedTier = (value: unknown): value is ResolvedSubscriptionTier =>
    value === "free" ||
    value === "plus" ||
    value === "pro" ||
    value === "enterprise";

type SqliteStatement = {
    get: (...args: unknown[]) => unknown;
};

type SqliteDbHandle = {
    prepare: (sql: string) => SqliteStatement;
};

type MongoCollectionHandle = {
    findOne: (
        filter: Record<string, unknown>,
        options?: Record<string, unknown>
    ) => Promise<Record<string, unknown> | null>;
};

type MongoDbHandle = {
    collection: (name: string) => MongoCollectionHandle;
};

type SubscriptionTierCapableAdapter = {
    db?: unknown;
    getAccountById?: (userId: UUID) => Promise<Account | null>;
};

function isSqliteDbHandle(db: unknown): db is SqliteDbHandle {
    return !!db && typeof (db as SqliteDbHandle).prepare === "function";
}

function isMongoDbHandle(db: unknown): db is MongoDbHandle {
    return (
        !!db &&
        typeof (db as MongoDbHandle).collection === "function" &&
        !isSqliteDbHandle(db)
    );
}

function isMissingSubscriptionHistoryStore(error: unknown): boolean {
    const message = String((error as Error | undefined)?.message ?? "").toLowerCase();
    return (
        message.includes("no such table") ||
        message.includes("namespace not found") ||
        message.includes("ns not found")
    );
}

export const getLatestTierFromHistory = async (
    adapter: SubscriptionTierCapableAdapter | null | undefined,
    userId: UUID | null | undefined
): Promise<ResolvedSubscriptionTier | null> => {
    if (!adapter?.db || !userId) {
        return null;
    }

    try {
        if (isSqliteDbHandle(adapter.db)) {
            const row = adapter.db
                .prepare(
                    `SELECT tier
                     FROM user_subscription_tier_history
                     WHERE userId = ?
                     ORDER BY observedAt DESC, createdAt DESC, id DESC
                     LIMIT 1`
                )
                .get(userId) as { tier: string } | undefined;

            if (row && isResolvedTier(row.tier)) {
                return row.tier;
            }

            return null;
        }

        if (isMongoDbHandle(adapter.db)) {
            const row = await adapter.db.collection("user_subscription_tier_history").findOne(
                { userId },
                {
                    projection: { tier: 1 },
                    sort: { observedAt: -1, createdAt: -1, id: -1 },
                }
            );

            if (row && isResolvedTier(row.tier)) {
                return row.tier;
            }

            return null;
        }

        elizaLogger.warn(
            "Subscription tier history lookup skipped: unsupported database handle shape",
            { userId }
        );
    } catch (error) {
        if (!isMissingSubscriptionHistoryStore(error)) {
            elizaLogger.warn("Subscription tier history lookup failed", {
                userId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    return null;
};

export function isAnonymousAccount(
    account: Pick<Account, "details" | "email"> | null | undefined
): boolean {
    if (!account) {
        return false;
    }

    const source =
        account.details && typeof account.details === "object"
            ? (account.details as Record<string, unknown>).source
            : undefined;
    if (source === "ip") {
        return true;
    }

    const email = typeof account.email === "string" ? account.email.trim().toLowerCase() : "";
    return email.endsWith("@anonymous.local");
}

function getTierFromAccountDetails(
    account: Pick<Account, "details" | "email"> | null | undefined
): ResolvedSubscriptionTier | null {
    const details =
        account?.details && typeof account.details === "object"
            ? (account.details as Record<string, unknown>)
            : null;
    const tierValue =
        details &&
        details.subscriptionTier &&
        typeof details.subscriptionTier === "object"
            ? (details.subscriptionTier as Record<string, unknown>).currentTier
            : undefined;

    return isResolvedTier(tierValue) ? tierValue : null;
}

export async function resolveEffectiveSubscriptionTierFromAdapter(
    adapter: SubscriptionTierCapableAdapter | null | undefined,
    userId: UUID,
    options: {
        account?: Pick<Account, "details" | "email"> | null;
    } = {}
): Promise<ResolvedSubscriptionTier> {
    const account =
        typeof options.account !== "undefined"
            ? options.account
            : await adapter?.getAccountById?.(userId);

    if (isAnonymousAccount(account)) {
        return "free";
    }

    const detailsTier = getTierFromAccountDetails(account);
    if (detailsTier) {
        return detailsTier;
    }

    const historyTier = await getLatestTierFromHistory(adapter, userId);
    if (historyTier) {
        return historyTier;
    }

    return "free";
}

export async function resolveEffectiveSubscriptionTier(
    runtime: IAgentRuntime,
    userId: UUID,
    options: {
        account?: Pick<Account, "details" | "email"> | null;
    } = {}
): Promise<ResolvedSubscriptionTier> {
    return resolveEffectiveSubscriptionTierFromAdapter(
        runtime.databaseAdapter as SubscriptionTierCapableAdapter,
        userId,
        options
    );
}
