import {
    type Action,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
    elizaLogger,
    stringToUuid,
} from "@elizaos/core";

const VALID_MODES = new Set(["paper", "shadow", "live"]);

function extractModeFromText(text: string): "paper" | "shadow" | "live" | null {
    const lower = text.toLowerCase();
    if (/\b(go|switch|set|use|enable|toggle).*\b(live|real|production)\b/.test(lower)) return "live";
    if (/\b(go|switch|set|use|enable|toggle).*\b(paper|simulate|simulation|practice)\b/.test(lower)) return "paper";
    if (/\b(go|switch|set|use|enable|toggle).*\bshadow\b/.test(lower)) return "shadow";
    if (/\b(live mode|real mode)\b/.test(lower)) return "live";
    if (/\bpaper mode\b/.test(lower)) return "paper";
    if (/\bshadow mode\b/.test(lower)) return "shadow";
    return null;
}

export const setTradingModeAction: Action = {
    name: "set_trading_mode",
    description:
        "Toggle the user's trading mode between paper (simulated fills), shadow (decisions logged but suppressed), and live (real orders). The mode is persisted in user_trading_preferences.default_mode. New orders inherit this mode unless overridden per-message.",
    examples: [
        [
            { user: "{{user1}}", content: { text: "switch to paper mode" } },
            { user: "{{user2}}", content: { text: "Switching to paper", action: "set_trading_mode" } },
        ],
        [
            { user: "{{user1}}", content: { text: "set trading mode to shadow" } },
            { user: "{{user2}}", content: { text: "Switching to shadow", action: "set_trading_mode" } },
        ],
        [
            { user: "{{user1}}", content: { text: "go live with trading" } },
            { user: "{{user2}}", content: { text: "Switching to live", action: "set_trading_mode" } },
        ],
    ],
    handler: async (
        runtime: IAgentRuntime,
        memory: Memory,
        _state: State | undefined,
        options: Record<string, unknown> | undefined,
        callback?: HandlerCallback,
    ): Promise<unknown> => {
        const opts = (options ?? {}) as Record<string, unknown>;
        let mode: "paper" | "shadow" | "live" | null = null;
        if (typeof opts.mode === "string" && VALID_MODES.has(opts.mode)) {
            mode = opts.mode as "paper" | "shadow" | "live";
        } else {
            mode = extractModeFromText(memory.content?.text ?? "");
        }
        if (!mode) {
            const responseText =
                "I couldn't parse the trading mode. Please specify `paper`, `shadow`, or `live`.";
            if (callback) {
                await callback({
                    text: responseText,
                    action: "set_trading_mode",
                    metadata: { success: false, clarification: true },
                });
            }
            return { success: false, clarification: responseText };
        }

        // M6 iter10 (post-PR250): resolve the AUTH/human user via the
        // room's participants — the non-agent UUID. Chat memory.userId
        // is the agent's character UUID; the auth user's account.id
        // (the row the REST API writes to) is the OTHER participant
        // in the chat room. Adding it first to the target_ids ensures
        // the write lands on the row the API reads from.
        const targetIds = new Set<string>([String(memory.userId)]);
        try {
            const adapter = runtime.databaseAdapter as unknown as {
                getParticipantsForRoom?: (rid: string) => Promise<string[]>;
            };
            if (typeof adapter?.getParticipantsForRoom === "function" && memory.roomId) {
                const participants = await adapter.getParticipantsForRoom(memory.roomId);
                const human = participants.find((p) => String(p) !== String(runtime.agentId));
                if (human) targetIds.add(String(human));
            }
        } catch {
            /* best-effort */
        }
        try {
            const adapter = runtime.databaseAdapter as unknown as {
                getAccountById?: (uid: string) => Promise<{ email?: string | null } | null>;
                getAccountByEmail?: (email: string) => Promise<{ id?: string | null } | null>;
            };
            if (typeof adapter?.getAccountById === "function") {
                const acct = await adapter.getAccountById(String(memory.userId));
                const email = acct?.email;
                if (typeof email === "string" && email.length > 0) {
                    // Primary: ask the adapter for the canonical account.id by email.
                    if (typeof adapter.getAccountByEmail === "function") {
                        try {
                            const byEmail = await adapter.getAccountByEmail(email);
                            if (byEmail?.id) targetIds.add(String(byEmail.id));
                        } catch {
                            /* fall through to formula fallback */
                        }
                    }
                    // Fallback (kept for SQLite adapter / legacy formula): stringToUuid
                    // mirror. Will produce a different id from the authoritative
                    // lookup when the user's account row was created before the
                    // mergeDuplicateAccountsByEmail convention adopted this scheme.
                    const emailUid = stringToUuid(`email-user-${email.toLowerCase().trim()}`);
                    if (emailUid) targetIds.add(emailUid);
                }
            }
        } catch {
            /* email lookup is best-effort */
        }

        elizaLogger.info(
            `[plugin-cex] set_trading_mode write: userId=${memory.userId} new_mode=${mode} target_ids=${Array.from(targetIds).join(",")}`,
        );

        // Mirror to the runtime cache for EACH candidate key (defense in
        // depth: invalidate any stale cache from pre-iter4 cexPlanRunner
        // that wrote to runtime.agentId).
        for (const uid of targetIds) {
            const cacheKey = `user_trading_preferences:${uid}:default_mode`;
            try {
                await runtime.cacheManager?.set?.(cacheKey, mode);
            } catch (err) {
                elizaLogger.warn(`[plugin-cex] cache set failed for ${uid}: ${err}`);
            }
        }

        // Persist to MongoDB user_trading_preferences (durable across
        // container restarts). Write to EACH candidate userId so the
        // read path finds the new value on either key.
        try {
            const adapter = runtime.databaseAdapter as unknown as {
                getUserTradingPreferences?: (userId: string) => Promise<Record<string, unknown> | null>;
                setUserTradingPreferences?: (userId: string, prefs: Record<string, unknown>) => Promise<void>;
            };
            if (
                typeof adapter.setUserTradingPreferences === "function" &&
                typeof adapter.getUserTradingPreferences === "function"
            ) {
                for (const uid of targetIds) {
                    const existing = (await adapter.getUserTradingPreferences(uid)) ?? {};
                    await adapter.setUserTradingPreferences(uid, {
                        ...existing,
                        default_mode: mode,
                    });
                    elizaLogger.info(
                        `[plugin-cex] set_trading_mode persisted to MongoDB user_trading_preferences for ${uid}`,
                    );
                }
            } else {
                elizaLogger.warn(
                    "[plugin-cex] set_trading_mode: database adapter lacks user_trading_preferences methods (likely SQLite) — only runtime cache updated",
                );
            }
        } catch (err) {
            elizaLogger.error(
                `[plugin-cex] set_trading_mode persistence failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }

        const description: Record<typeof mode, string> = {
            paper: "**Paper mode** — your orders will simulate against live market data but never submit to the exchange. Useful for testing strategies.",
            shadow: "**Shadow mode** — your orders run the full risk + idempotency pipeline but are suppressed at submission. Decisions are logged for divergence analysis.",
            live: "**Live mode** — your orders submit to the real exchange. Risk + approval gates remain active.",
        };

        const responseText = [
            `Trading mode switched to **${mode}**.`,
            "",
            description[mode],
        ].join("\n");

        if (callback) {
            await callback({
                text: responseText,
                action: "set_trading_mode",
                metadata: { success: true, mode },
            });
        }
        return { success: true, mode };
    },
};
