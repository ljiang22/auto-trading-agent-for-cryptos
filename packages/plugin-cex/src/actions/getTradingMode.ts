import {
    type Action,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
    elizaLogger,
    stringToUuid,
} from "@elizaos/core";

import { DEFAULT_USER_TRADING_PREFERENCES } from "../risk/types";

type TradingMode = "paper" | "shadow" | "live";

const VALID_MODES = new Set<TradingMode>(["paper", "shadow", "live"]);

const MODE_DESCRIPTIONS: Record<TradingMode, string> = {
    paper: "all orders are simulated; no real money moves.",
    shadow: "intents are recorded for comparison; no orders are sent to the venue.",
    live: "orders execute on the real exchange with real funds.",
};

/**
 * Read-only counterpart to `set_trading_mode`. Resolves the user's
 * current trading mode in the following order (CEX post-PR237 contract):
 *
 *   1. MongoDB `user_trading_preferences.default_mode` (durable source
 *      of truth). On hit, the runtime cache is refreshed so subsequent
 *      paper-venue dispatches in this process are fast AND consistent.
 *   2. Runtime cache (fallback when the DB is unreachable; preserves
 *      the previous behavior under transient outages).
 *   3. `DEFAULT_USER_TRADING_PREFERENCES.default_mode` (currently `"live"`).
 *
 * Prior PR-#237 behavior was cache-first, which let a stale "paper"
 * cache entry override a DB-set "live" preference after the user
 * toggled via Settings -> Trading -> Mode. The PUT
 * `/user/trading/preferences` endpoint now also invalidates the cache
 * on every mode change, but DB-first read here is the belt-and-braces
 * defense against any other code path that warms the cache directly.
 *
 * Returns directly via the callback — no parameter-review / approval
 * modal is required for a read.
 */
/**
 * M6 iter10 (post-PR250) — resolve the AUTH/human user id from the
 * chat room's participants. Chat memory.userId is the agent's
 * character UUID (e.g. d13ee77f-...), not the auth user's account.id
 * (e.g. 42f8204a-...). The room's participant list contains both
 * the agent and the human; return the first non-agent UUID.
 * Falls back to the original userId on lookup failure or single-
 * participant rooms (test fixtures).
 */
async function resolveAuthUserId(
    runtime: IAgentRuntime,
    memory: Memory,
    fallbackUserId: string,
): Promise<string> {
    const roomId = memory.roomId;
    if (!roomId) return fallbackUserId;
    try {
        const adapter = runtime.databaseAdapter as unknown as {
            getParticipantsForRoom?: (rid: string) => Promise<string[]>;
        };
        if (typeof adapter?.getParticipantsForRoom !== "function") return fallbackUserId;
        const participants = await adapter.getParticipantsForRoom(roomId);
        const human = participants.find((p) => String(p) !== String(runtime.agentId));
        return human ? String(human) : fallbackUserId;
    } catch {
        return fallbackUserId;
    }
}

async function resolveTradingMode(
    runtime: IAgentRuntime,
    userId: string,
    memory?: Memory,
): Promise<{ mode: TradingMode; source: "mongo" | "cache" | "default" }> {
    // Fix-T3 iter2 (post-PR242): the API stores preferences keyed by
    // the JWT-derived userInfo.userId (email-deterministic UUID), but
    // chat actions only see memory.userId (often a room/character-scoped
    // UUID). When the two diverge, the per-userId mongo lookup misses
    // the user's actual prefs row. Try multiple candidate keys:
    //   1. memory.userId (as passed in) — works when both layers agree
    //   2. email-derived userId via runtime.databaseAdapter.getAccountById
    //      (the account row has email → emailToUserId returns the auth
    //      userId space). This makes the chat agent and API agree
    //      regardless of which userId the message came in with.
    // Fix-T3 iter3 (post-PR243): PRIORITY FLIPPED — email-derived userId
    // (the API's source of truth) is now tried FIRST. The original PR243
    // tried memory.userId first, but if memory.userId has a stale local
    // prefs row (e.g. from a prior set_trading_mode action that wrote
    // to the wrong namespace), it shadowed the API-managed live row.
    // Now we always prefer what the user sees in Settings (email-userId)
    // and only fall back to memory.userId if the API row is missing.
    // M6 iter10 (post-PR250): try the room's human participant FIRST.
    // memory.userId is the agent's character UUID (chat sessions are
    // addressed TO the agent); the room participants list has both
    // the agent and the human auth user (account.id). Reading from
    // the human's row hits the same row the REST API writes to via
    // PUT /user/trading/preferences.
    const candidateIds: string[] = [];
    if (memory) {
        try {
            const humanUserId = await resolveAuthUserId(runtime, memory, userId);
            if (humanUserId && humanUserId !== userId) {
                candidateIds.push(humanUserId);
            }
        } catch {
            /* best-effort */
        }
    }
    try {
        const adapter = runtime.databaseAdapter as unknown as {
            getAccountById?: (uid: string) => Promise<{ email?: string | null } | null>;
            getAccountByEmail?: (email: string) => Promise<{ id?: string | null } | null>;
        };
        if (typeof adapter?.getAccountById === "function") {
            const acct = await adapter.getAccountById(userId);
            const email = acct?.email;
            if (typeof email === "string" && email.length > 0) {
                // Primary: authoritative account.id via getAccountByEmail.
                if (typeof adapter.getAccountByEmail === "function") {
                    try {
                        const byEmail = await adapter.getAccountByEmail(email);
                        const authoritativeId = byEmail?.id ? String(byEmail.id) : null;
                        if (authoritativeId && authoritativeId !== userId) {
                            candidateIds.push(authoritativeId);
                        }
                    } catch {
                        /* fall through to formula fallback */
                    }
                }
                // Fallback: formula-derived UUID (legacy path).
                const emailUid = emailToUserId(email);
                if (emailUid && emailUid !== userId && !candidateIds.includes(emailUid)) {
                    candidateIds.push(emailUid);
                }
            }
        }
    } catch {
        /* account lookup is best-effort */
    }
    candidateIds.push(userId);

    for (const candidateId of candidateIds) {
        const cacheKey = `user_trading_preferences:${candidateId}:default_mode`;
        try {
            const adapter = runtime.databaseAdapter as unknown as {
                getUserTradingPreferences?: (
                    uid: string,
                ) => Promise<Record<string, unknown> | null>;
            };
            if (typeof adapter?.getUserTradingPreferences === "function") {
                const prefs = await adapter.getUserTradingPreferences(candidateId);
                const mode = prefs?.default_mode;
                elizaLogger.info(
                    `[plugin-cex] get_trading_mode mongo read: candidateId=${candidateId} default_mode=${typeof mode === "string" ? mode : "(missing)"} prefs_keys=${prefs ? Object.keys(prefs).slice(0, 12).join(",") : "(null)"}`,
                );
                if (typeof mode === "string" && VALID_MODES.has(mode as TradingMode)) {
                    try {
                        await runtime.cacheManager?.set?.(cacheKey, mode);
                    } catch {
                        /* cache write-back is best-effort */
                    }
                    return { mode: mode as TradingMode, source: "mongo" };
                }
            }
        } catch (err) {
            elizaLogger.warn(`[plugin-cex] get_trading_mode mongo read failed for ${candidateId}: ${err}`);
        }
    }

    for (const candidateId of candidateIds) {
        const cacheKey = `user_trading_preferences:${candidateId}:default_mode`;
        try {
            const cached = await runtime.cacheManager?.get?.(cacheKey);
            if (typeof cached === "string" && VALID_MODES.has(cached as TradingMode)) {
                return { mode: cached as TradingMode, source: "cache" };
            }
        } catch (err) {
            elizaLogger.warn(`[plugin-cex] get_trading_mode cache read failed for ${candidateId}: ${err}`);
        }
    }

    // Public-demo default is paper (matches getUserTradingMode in shared.ts):
    // the deployment can't move real money and the seeded paper cache is
    // per-instance, so a cache miss must not report LIVE.
    const fallback =
        process.env.PUBLIC_ACCESS_MODE?.trim() === "1"
            ? ("paper" as TradingMode)
            : (DEFAULT_USER_TRADING_PREFERENCES.default_mode as TradingMode);
    return { mode: fallback, source: "default" };
}

/**
 * Mirror of `client-direct/src/auth/jwtAuth.ts emailToUserId` —
 * deterministic UUID v5 from the lowercase email, same namespace as
 * the auth layer uses to write user_trading_preferences. Kept inline
 * to avoid an import cycle from plugin-cex → client-direct.
 */
function emailToUserId(email: string): string {
    const normalizedEmail = email.toLowerCase().trim();
    return stringToUuid(`email-user-${normalizedEmail}`);
}

export const getTradingModeAction: Action = {
    name: "get_trading_mode",
    description:
        "Read-only: report the user's current trading mode (paper | shadow | live). Reads from runtime cache first, then MongoDB user_trading_preferences, with a final fallback to the system default. Does not change any state and does not require approval.",
    examples: [
        [
            { user: "{{user1}}", content: { text: "what is my current trading mode?" } },
            {
                user: "{{user2}}",
                content: {
                    text: "Your current trading mode is **live**.",
                    action: "get_trading_mode",
                },
            },
        ],
        [
            { user: "{{user1}}", content: { text: "am I in paper or live?" } },
            {
                user: "{{user2}}",
                content: {
                    text: "Your current trading mode is **paper**.",
                    action: "get_trading_mode",
                },
            },
        ],
        [
            { user: "{{user1}}", content: { text: "当前模式" } },
            {
                user: "{{user2}}",
                content: {
                    text: "Your current trading mode is **shadow**.",
                    action: "get_trading_mode",
                },
            },
        ],
    ],
    handler: async (
        runtime: IAgentRuntime,
        memory: Memory,
        _state: State | undefined,
        _options: Record<string, unknown> | undefined,
        callback?: HandlerCallback,
    ): Promise<unknown> => {
        const userId = String(memory.userId);
        const { mode, source } = await resolveTradingMode(runtime, userId, memory);

        elizaLogger.info(
            `[plugin-cex] get_trading_mode: user=${userId} mode=${mode} source=${source}`,
        );

        const responseText = `Your current trading mode is **${mode}**. ${MODE_DESCRIPTIONS[mode]}`;

        if (callback) {
            await callback({
                text: responseText,
                action: "get_trading_mode",
                metadata: { success: true, mode, source },
            });
        }
        return { success: true, mode, source };
    },
};
