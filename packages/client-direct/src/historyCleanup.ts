import { elizaLogger, type AgentRuntime, type UUID } from "@elizaos/core";

const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the anonymous-history inactivity TTL (ms) from the environment.
 *
 * Precedence:
 *   1. `ANONYMOUS_HISTORY_TTL_MS` — explicit override. A positive integer is
 *      used verbatim; `0` / `off` / `never` / `infinity` / `disabled`
 *      disables cleanup (returns `Infinity`).
 *   2. `PUBLIC_ACCESS_MODE=1` with no explicit override — disables cleanup
 *      (`Infinity`) so the public demo persists anonymous chat by IP
 *      indefinitely.
 *   3. Otherwise — the historical 24h default (unchanged for prod/staging).
 */
export function resolveAnonymousHistoryTtlMs(
    env: NodeJS.ProcessEnv = process.env,
): number {
    const raw = env.ANONYMOUS_HISTORY_TTL_MS?.trim();
    if (raw) {
        const lowered = raw.toLowerCase();
        if (["0", "off", "never", "infinity", "disabled"].includes(lowered)) {
            return Number.POSITIVE_INFINITY;
        }
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
        // Fall through on malformed values rather than silently disabling.
    }

    if (env.PUBLIC_ACCESS_MODE?.trim() === "1") {
        return Number.POSITIVE_INFINITY;
    }

    return ONE_DAY_IN_MS;
}

type CleanupOptions = {
    runtime: AgentRuntime;
    userId: UUID;
    now?: number;
    timeoutMs?: number;
    roomIds?: UUID[];
    force?: boolean;
};

type CleanupResult = {
    roomIds: UUID[];
    cleaned: boolean;
    cleanedRoomIds: UUID[];
    lastActivity?: number;
};

type UsageRollupRow = {
    day: string;
    messageCount: number;
};

type SqliteDbHandle = {
    prepare: (sql: string) => {
        all: (...args: unknown[]) => UsageRollupRow[];
        run: (...args: unknown[]) => unknown;
    };
    transaction: <TArgs extends unknown[]>(fn: (...args: TArgs) => unknown) => (...args: TArgs) => unknown;
};

type MongoDbHandle = {
    collection: (name: string) => {
        find: (...args: unknown[]) => { toArray: () => Promise<any[]> };
        updateOne: (...args: unknown[]) => Promise<unknown>;
        countDocuments: (...args: unknown[]) => Promise<number>;
    };
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

function normalizeTimestamp(value: unknown): number | undefined {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined;
    }

    if (typeof value === "string") {
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? undefined : parsed;
    }

    return undefined;
}

async function removeRoomData(runtime: AgentRuntime, roomId: UUID) {
    try {
        await runtime.messageManager.removeAllMemories(roomId);
    } catch (error) {
        elizaLogger.error(
            `Failed to prune memories for room ${roomId}: ${(error as Error).message}`,
        );
    }

    try {
        await runtime.databaseAdapter.removeAllGoals(roomId);
    } catch (error) {
        elizaLogger.error(
            `Failed to prune goals for room ${roomId}: ${(error as Error).message}`,
        );
    }

    try {
        await runtime.databaseAdapter.removeParticipantsByRoom(roomId);
    } catch (error) {
        elizaLogger.error(
            `Failed to prune participants for room ${roomId}: ${(error as Error).message}`,
        );
    }

    try {
        await runtime.databaseAdapter.removeRoom(roomId);
    } catch (error) {
        elizaLogger.error(
            `Failed to remove room record ${roomId}: ${(error as Error).message}`,
        );
    }
}

async function recordAnonymousUsageRollup(
    runtime: AgentRuntime,
    userId: UUID,
    roomIds: UUID[]
): Promise<void> {
    if (roomIds.length === 0) {
        return;
    }

    const db = (runtime.databaseAdapter as any)?.db;
    if (!db) {
        return;
    }

    try {
        if (isMongoDbHandle(db)) {
            const memories = await db
                .collection("memories")
                .find(
                    {
                        type: "messages",
                        userId,
                        roomId: { $in: roomIds },
                    },
                    { projection: { createdAt: 1 } }
                )
                .toArray();

            if (!memories || memories.length === 0) {
                return;
            }

            const byDay = new Map<string, number>();
            for (const memory of memories) {
                const ts = normalizeTimestamp(memory.createdAt);
                if (!ts) continue;
                const day = new Date(ts).toLocaleDateString("en-CA");
                byDay.set(day, (byDay.get(day) ?? 0) + 1);
            }

            for (const [day, messageCount] of byDay.entries()) {
                if (messageCount <= 0) continue;

                await db.collection("analytics_usage_rollup_users").updateOne(
                    { day, segment: "anonymous", userId },
                    { $set: { day, segment: "anonymous", userId, updatedAt: Date.now() } },
                    { upsert: true }
                );

                const activeUsers = await db
                    .collection("analytics_usage_rollup_users")
                    .countDocuments({ day, segment: "anonymous" });

                await db.collection("analytics_usage_rollup").updateOne(
                    { day, segment: "anonymous" },
                    {
                        $set: { day, segment: "anonymous", activeUsers, updatedAt: Date.now() },
                        $inc: { messageCount },
                    },
                    { upsert: true }
                );
            }

            return;
        }

        if (!isSqliteDbHandle(db)) {
            elizaLogger.warn(
                "Anonymous history cleanup skipped usage rollup: unsupported database handle shape",
                { userId, roomCount: roomIds.length }
            );
            return;
        }

        const placeholders = roomIds.map(() => "?").join(", ");
        const query = `
            SELECT date(createdAt / 1000, 'unixepoch', 'localtime') AS day,
                   COUNT(*) AS messageCount
            FROM memories
            WHERE type = ? AND userId = ? AND roomId IN (${placeholders})
            GROUP BY day ORDER BY day
        `;

        const rows = db.prepare(query).all(
            "messages",
            userId,
            ...roomIds
        ) as UsageRollupRow[];

        if (!rows || rows.length === 0) {
            return;
        }

        const upsertUniqueUser = db.prepare(`
            INSERT INTO analytics_usage_rollup_users (day, segment, userId, updatedAt)
            VALUES (?, 'anonymous', ?, CURRENT_TIMESTAMP)
            ON CONFLICT(day, segment, userId) DO UPDATE SET
                updatedAt = CURRENT_TIMESTAMP
        `);

        const upsertDailyRollup = db.prepare(`
            INSERT INTO analytics_usage_rollup (day, segment, activeUsers, messageCount, updatedAt)
            VALUES (
                ?,
                'anonymous',
                (
                    SELECT COUNT(*)
                    FROM analytics_usage_rollup_users
                    WHERE day = ? AND segment = 'anonymous'
                ),
                ?,
                CURRENT_TIMESTAMP
            )
            ON CONFLICT(day, segment) DO UPDATE SET
                activeUsers = (
                    SELECT COUNT(*)
                    FROM analytics_usage_rollup_users
                    WHERE day = excluded.day AND segment = excluded.segment
                ),
                messageCount = messageCount + excluded.messageCount,
                updatedAt = CURRENT_TIMESTAMP
        `);

        const tx = db.transaction((entries: UsageRollupRow[]) => {
            for (const row of entries) {
                if (!row?.day) continue;
                const messageCount = Number(row.messageCount) || 0;
                if (messageCount <= 0) continue;
                upsertUniqueUser.run(row.day, userId);
                upsertDailyRollup.run(row.day, row.day, messageCount);
            }
        });

        tx(rows);
    } catch (error) {
        elizaLogger.error("Failed to roll up anonymous usage before cleanup:", error);
    }
}

export async function cleanupAnonymousHistoryIfExpired({
    runtime,
    userId,
    now = Date.now(),
    timeoutMs = resolveAnonymousHistoryTtlMs(),
    roomIds,
    force = false,
}: CleanupOptions): Promise<CleanupResult> {
    const resolvedRoomIds =
        roomIds ??
        (await runtime.databaseAdapter.getRoomsForParticipant(
            userId,
            runtime.agentId,
        ));

    if (resolvedRoomIds.length === 0) {
        return { roomIds: resolvedRoomIds, cleaned: false, cleanedRoomIds: [] };
    }

    try {
        const latestMemories = await runtime.messageManager.getMemoriesByRoomIds({
            roomIds: resolvedRoomIds,
            limit: 1,
        });

        const lastActivity = latestMemories[0]
            ? normalizeTimestamp(latestMemories[0].createdAt)
            : undefined;

        const expireThresholdReached =
            force || (lastActivity !== undefined && now - lastActivity >= timeoutMs);

        if (!expireThresholdReached) {
            return {
                roomIds: resolvedRoomIds,
                cleaned: false,
                cleanedRoomIds: [],
                lastActivity,
            };
        }

        await recordAnonymousUsageRollup(runtime, userId, resolvedRoomIds);

        const cleanedRoomIds: UUID[] = [];
        for (const roomId of resolvedRoomIds) {
            await removeRoomData(runtime, roomId);
            cleanedRoomIds.push(roomId);
        }

        if (force) {
            elizaLogger.info(
                `Force-cleared anonymous history for user ${userId} across ${cleanedRoomIds.length} room(s)`,
            );
        } else {
            elizaLogger.info(
                `Cleared anonymous history for user ${userId} after ${(timeoutMs / 60000).toFixed(
                    0,
                )} minutes of inactivity`,
            );
        }

        return {
            roomIds: resolvedRoomIds,
            cleaned: cleanedRoomIds.length > 0,
            cleanedRoomIds,
            lastActivity,
        };
    } catch (error) {
        elizaLogger.error(
            `Failed to evaluate anonymous history for user ${userId}: ${(error as Error).message}`,
        );
        return { roomIds: resolvedRoomIds, cleaned: false, cleanedRoomIds: [] };
    }
}
