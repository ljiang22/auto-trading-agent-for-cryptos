import {
    type Action,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
    elizaLogger,
} from "@elizaos/core";

/**
 * Fix 8 — user-editable asset allowlist + blocklist actions.
 *
 * The risk-engine rule `assetAllowlist` in
 * `packages/plugin-cex/src/risk/rules/assetAllowlist.ts` already
 * consumes `UserTradingPreferences.asset_allowlist` /
 * `asset_blocklist` (defined in `risk/types.ts`). Before this file,
 * users had NO way to populate those arrays — they were always
 * empty so the rule never fired.
 *
 * Five new actions exposed here:
 *   1. `add_blocked_asset`    — write
 *   2. `remove_blocked_asset` — write
 *   3. `add_allowed_asset`    — write
 *   4. `remove_allowed_asset` — write
 *   5. `list_asset_lists`     — read-only
 *
 * Pattern mirrors `set_trading_mode`:
 *   - Persist to MongoDB `user_trading_preferences` via the adapter
 *     (when present), idempotent on repeat input.
 *   - Cache the full preferences object so the paper-venue / risk
 *     paths can read back without a Mongo round-trip.
 *   - Asset names normalized to uppercase, no symbol / emoji chars.
 *   - Writes route through `requestParameterReview` upstream (the
 *     workflow handler attaches these to `WRITE_ACTIONS`); no
 *     bypass here.
 */

// -------- helpers --------------------------------------------------------

const ASSET_NAME_RE = /^[A-Z0-9]{1,12}$/;

/**
 * Normalize a user-provided asset name. Reject empty strings,
 * whitespace, emoji, and other non-alphanumeric characters. Return
 * `null` on rejection.
 *
 * Symbols are stored uppercase. Length cap of 12 catches obvious
 * garbage (the longest real ticker today is ~7 chars) while leaving
 * headroom for "1000PEPE" / "1000SHIB" style perp tickers.
 */
export function normalizeAsset(input: unknown): string | null {
    if (typeof input !== "string") return null;
    const trimmed = input.trim().toUpperCase();
    if (trimmed.length === 0) return null;
    if (!ASSET_NAME_RE.test(trimmed)) return null;
    return trimmed;
}

type StoredPrefs = Record<string, unknown> & {
    asset_allowlist?: unknown;
    asset_blocklist?: unknown;
};

type RuntimeAdapter = {
    getUserTradingPreferences?: (
        userId: string,
    ) => Promise<Record<string, unknown> | null>;
    setUserTradingPreferences?: (
        userId: string,
        prefs: Record<string, unknown>,
    ) => Promise<void>;
};

function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const entry of value) {
        if (typeof entry !== "string") continue;
        const norm = entry.trim().toUpperCase();
        if (norm.length === 0) continue;
        out.push(norm);
    }
    return out;
}

/**
 * Read current preferences from MongoDB (preferred) with cache
 * fallback. Returns an empty object when nothing is stored — the
 * caller spreads it over defaults / overrides.
 */
export async function readPrefs(
    runtime: IAgentRuntime,
    userId: string,
): Promise<StoredPrefs> {
    const adapter = (runtime.databaseAdapter ?? {}) as RuntimeAdapter;
    if (typeof adapter.getUserTradingPreferences === "function") {
        try {
            const existing = await adapter.getUserTradingPreferences(userId);
            if (existing && typeof existing === "object") {
                return existing as StoredPrefs;
            }
        } catch (err) {
            elizaLogger.warn(
                `[plugin-cex] readPrefs mongo read failed: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }
    }
    // Cache fallback — only the full object cache key, not the per-field
    // `:default_mode` mirror that `set_trading_mode` writes.
    const cacheKey = `user_trading_preferences:${userId}`;
    try {
        const cached = await runtime.cacheManager?.get?.(cacheKey);
        if (cached && typeof cached === "object") {
            return cached as StoredPrefs;
        }
    } catch {
        // ignore — empty is fine
    }
    return {};
}

/**
 * Persist preferences to MongoDB (when adapter supports it) AND
 * mirror to the whole-object cache so a follow-up read in the same
 * process is hot. Cache write failures are logged but do not fail
 * the action.
 */
export async function writePrefs(
    runtime: IAgentRuntime,
    userId: string,
    prefs: StoredPrefs,
): Promise<void> {
    const adapter = (runtime.databaseAdapter ?? {}) as RuntimeAdapter;
    if (
        typeof adapter.setUserTradingPreferences === "function" &&
        typeof adapter.getUserTradingPreferences === "function"
    ) {
        try {
            await adapter.setUserTradingPreferences(userId, prefs);
        } catch (err) {
            elizaLogger.error(
                `[plugin-cex] writePrefs mongo write failed: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }
    } else {
        elizaLogger.warn(
            "[plugin-cex] writePrefs: database adapter lacks user_trading_preferences methods — cache only",
        );
    }
    const cacheKey = `user_trading_preferences:${userId}`;
    try {
        await runtime.cacheManager?.set?.(cacheKey, prefs);
    } catch (err) {
        elizaLogger.warn(`[plugin-cex] writePrefs cache set failed: ${err}`);
    }
}

/**
 * Extract the asset argument from action options, falling back to a
 * naive token-scan of the message text (uppercase ticker-shaped run).
 * Returns the normalized asset name or `null` when nothing usable
 * is present.
 */
function extractAssetFromOptionsOrText(
    options: Record<string, unknown> | undefined,
    memory: Memory,
): string | null {
    const optAsset = (options ?? {}).asset;
    const fromOpts = normalizeAsset(optAsset);
    if (fromOpts) return fromOpts;
    const text = memory.content?.text ?? "";
    // Pull the first plausible ticker-shaped run from the text.
    const match = text.match(/\b([A-Za-z0-9]{2,12})\b/g);
    if (!match) return null;
    for (const candidate of match) {
        // Skip common english words and verbs that pollute the scan.
        if (/^(?:add|remove|block|allow|to|the|my|asset|list|blocklist|allowlist|please|can|you)$/i.test(candidate)) continue;
        const norm = normalizeAsset(candidate);
        if (norm) return norm;
    }
    return null;
}

function buildClarification(name: string, listKind: "block" | "allow") {
    return `I couldn't parse the asset symbol. Please specify the ticker to ${
        name.startsWith("add") ? "add" : "remove"
    } (e.g. \`${name}({asset: "DOGE"})\` for your ${listKind} list).`;
}

type ListMutator = "add" | "remove";

async function mutateList(
    runtime: IAgentRuntime,
    userId: string,
    listKey: "asset_blocklist" | "asset_allowlist",
    asset: string,
    mode: ListMutator,
): Promise<{ before: string[]; after: string[]; changed: boolean }> {
    const existing = await readPrefs(runtime, userId);
    const beforeRaw = asStringArray(existing[listKey]);
    const beforeSet = new Set(beforeRaw);
    let after: string[];
    let changed: boolean;
    if (mode === "add") {
        if (beforeSet.has(asset)) {
            after = beforeRaw;
            changed = false;
        } else {
            after = [...beforeRaw, asset];
            changed = true;
        }
    } else {
        if (!beforeSet.has(asset)) {
            after = beforeRaw;
            changed = false;
        } else {
            after = beforeRaw.filter((entry) => entry !== asset);
            changed = true;
        }
    }
    if (changed) {
        const merged: StoredPrefs = { ...existing, [listKey]: after };
        await writePrefs(runtime, userId, merged);
    }
    return { before: beforeRaw, after, changed };
}

/**
 * Best-effort idempotency stamp. We don't gate the mutation on the
 * derived id (the operation is already idempotent at the
 * data-structure level — Sets dedupe), but the stamp is logged and
 * also threaded onto the action result so upstream replay/audit can
 * join on it like other CEX write actions do.
 */
function deriveIdempotencyStamp(
    runtime: IAgentRuntime,
    userId: string,
    actionName: string,
    asset: string,
): { client_order_id: string | null; intent_hash: string | null } {
    try {
        const provider = (runtime as unknown as {
            plugins?: Array<{ cexSpecProvider?: { deriveIdempotency?: Function } }>;
        }).plugins;
        if (!Array.isArray(provider)) {
            return { client_order_id: null, intent_hash: null };
        }
        for (const plugin of provider) {
            const derive = plugin?.cexSpecProvider?.deriveIdempotency;
            if (typeof derive === "function") {
                const out = derive({
                    action: actionName,
                    venue: "binance", // venue is structurally required; meta-action so value is irrelevant
                    userId,
                    locale: "en",
                    params: { asset },
                });
                if (out && typeof out === "object") {
                    return {
                        client_order_id:
                            typeof (out as { client_order_id?: unknown }).client_order_id === "string"
                                ? ((out as { client_order_id: string }).client_order_id)
                                : null,
                        intent_hash:
                            typeof (out as { intent_hash?: unknown }).intent_hash === "string"
                                ? ((out as { intent_hash: string }).intent_hash)
                                : null,
                    };
                }
            }
        }
    } catch (err) {
        elizaLogger.debug(`[plugin-cex] deriveIdempotencyStamp failed: ${err}`);
    }
    return { client_order_id: null, intent_hash: null };
}

// -------- action factories ----------------------------------------------

type ListKey = "asset_blocklist" | "asset_allowlist";

function buildWriteAction(spec: {
    name: "add_blocked_asset" | "remove_blocked_asset" | "add_allowed_asset" | "remove_allowed_asset";
    description: string;
    listKey: ListKey;
    mutator: ListMutator;
    listLabel: "block" | "allow";
    examples: Action["examples"];
}): Action {
    return {
        name: spec.name,
        description: spec.description,
        examples: spec.examples,
        handler: async (
            runtime: IAgentRuntime,
            memory: Memory,
            _state: State | undefined,
            options: Record<string, unknown> | undefined,
            callback?: HandlerCallback,
        ): Promise<unknown> => {
            const asset = extractAssetFromOptionsOrText(options, memory);
            if (!asset) {
                const responseText = buildClarification(spec.name, spec.listLabel);
                if (callback) {
                    await callback({
                        text: responseText,
                        action: spec.name,
                        metadata: { success: false, clarification: true },
                    });
                }
                return { success: false, clarification: responseText };
            }

            const userId = String(memory.userId);
            elizaLogger.info(
                `[plugin-cex] ${spec.name}: user=${userId} asset=${asset}`,
            );

            const { client_order_id, intent_hash } = deriveIdempotencyStamp(
                runtime,
                userId,
                spec.name,
                asset,
            );

            const result = await mutateList(
                runtime,
                userId,
                spec.listKey,
                asset,
                spec.mutator,
            );

            const verb =
                spec.mutator === "add"
                    ? spec.listLabel === "block"
                        ? "Added"
                        : "Added"
                    : spec.listLabel === "block"
                      ? "Removed"
                      : "Removed";
            const listName = spec.listLabel === "block" ? "block list" : "allow list";
            const noopHint = result.changed ? "" : " (no change — already at the target state)";
            const responseText = `${verb} ${asset} ${
                spec.mutator === "add" ? "to" : "from"
            } your ${listName} (now ${result.after.length} entries).${noopHint}`;

            if (callback) {
                await callback({
                    text: responseText,
                    action: spec.name,
                    metadata: {
                        success: true,
                        asset,
                        list: spec.listKey,
                        before: result.before,
                        after: result.after,
                        changed: result.changed,
                        client_order_id,
                        intent_hash,
                    },
                });
            }
            return {
                success: true,
                asset,
                list: spec.listKey,
                before: result.before,
                after: result.after,
                changed: result.changed,
                client_order_id,
                intent_hash,
            };
        },
    };
}

export const addBlockedAssetAction = buildWriteAction({
    name: "add_blocked_asset",
    description:
        "Add a crypto asset to the user's block list. Future create_order intents for that asset are rejected by the risk engine's assetAllowlist rule. Persisted in user_trading_preferences.asset_blocklist.",
    listKey: "asset_blocklist",
    mutator: "add",
    listLabel: "block",
    examples: [
        [
            { user: "{{user1}}", content: { text: "block DOGE" } },
            { user: "{{user2}}", content: { text: "Added DOGE to your block list", action: "add_blocked_asset" } },
        ],
        [
            { user: "{{user1}}", content: { text: "add SHIB to my blocklist" } },
            { user: "{{user2}}", content: { text: "Added SHIB to your block list", action: "add_blocked_asset" } },
        ],
    ],
});

export const removeBlockedAssetAction = buildWriteAction({
    name: "remove_blocked_asset",
    description:
        "Remove a crypto asset from the user's block list, allowing future create_order intents for it to pass the assetAllowlist risk rule again.",
    listKey: "asset_blocklist",
    mutator: "remove",
    listLabel: "block",
    examples: [
        [
            { user: "{{user1}}", content: { text: "unblock DOGE" } },
            { user: "{{user2}}", content: { text: "Removed DOGE from your block list", action: "remove_blocked_asset" } },
        ],
        [
            { user: "{{user1}}", content: { text: "remove SHIB from my blocklist" } },
            { user: "{{user2}}", content: { text: "Removed SHIB from your block list", action: "remove_blocked_asset" } },
        ],
    ],
});

export const addAllowedAssetAction = buildWriteAction({
    name: "add_allowed_asset",
    description:
        "Add a crypto asset to the user's allow list. When the allow list is non-empty, the risk engine's assetAllowlist rule blocks any create_order intent whose base asset is NOT on the list.",
    listKey: "asset_allowlist",
    mutator: "add",
    listLabel: "allow",
    examples: [
        [
            { user: "{{user1}}", content: { text: "add BTC to my allowlist" } },
            { user: "{{user2}}", content: { text: "Added BTC to your allow list", action: "add_allowed_asset" } },
        ],
    ],
});

export const removeAllowedAssetAction = buildWriteAction({
    name: "remove_allowed_asset",
    description:
        "Remove a crypto asset from the user's allow list. Once the allow list goes back to empty, the assetAllowlist rule becomes a no-op for missing entries.",
    listKey: "asset_allowlist",
    mutator: "remove",
    listLabel: "allow",
    examples: [
        [
            { user: "{{user1}}", content: { text: "remove BTC from my allowlist" } },
            { user: "{{user2}}", content: { text: "Removed BTC from your allow list", action: "remove_allowed_asset" } },
        ],
    ],
});

export const listAssetListsAction: Action = {
    name: "list_asset_lists",
    description:
        "Read-only: return the user's current asset allow list and block list (from user_trading_preferences). No approval required.",
    examples: [
        [
            { user: "{{user1}}", content: { text: "show my asset lists" } },
            { user: "{{user2}}", content: { text: "Your allow list: [...]. Your block list: [...]", action: "list_asset_lists" } },
        ],
        [
            { user: "{{user1}}", content: { text: "what assets have I blocked?" } },
            { user: "{{user2}}", content: { text: "Your block list: [DOGE].", action: "list_asset_lists" } },
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
        const prefs = await readPrefs(runtime, userId);
        const allowlist = asStringArray(prefs.asset_allowlist);
        const blocklist = asStringArray(prefs.asset_blocklist);
        const responseText = [
            `Asset allow list (${allowlist.length}): ${allowlist.length === 0 ? "—" : allowlist.join(", ")}`,
            `Asset block list (${blocklist.length}): ${blocklist.length === 0 ? "—" : blocklist.join(", ")}`,
        ].join("\n");

        if (callback) {
            await callback({
                text: responseText,
                action: "list_asset_lists",
                metadata: {
                    success: true,
                    asset_allowlist: allowlist,
                    asset_blocklist: blocklist,
                },
            });
        }
        return {
            success: true,
            asset_allowlist: allowlist,
            asset_blocklist: blocklist,
        };
    },
};

export const assetListActions: Action[] = [
    addBlockedAssetAction,
    removeBlockedAssetAction,
    addAllowedAssetAction,
    removeAllowedAssetAction,
    listAssetListsAction,
];
