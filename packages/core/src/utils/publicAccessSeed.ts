import type { IAgentRuntime, UUID } from "../core/types.ts";
import { elizaLogger } from "./logger.ts";
import { isPublicAccessModeActive } from "./publicAccessMode.ts";

const PUBLIC_PAPER_VENUE = "binance";
// Must match the authType id seeded in the exchange_registry
// (adapter-sqlite ensureExchangeRegistrySeed). The CEX gate looks up
// authConfig by this exact string, so "apiKey" silently fails validation.
const PUBLIC_PAPER_AUTH_TYPE = "api_key_name_secret";

/**
 * Dummy paper credentials. These are NEVER used to call a real exchange:
 * paper mode routes order writes/reads through the paper ledger and pulls
 * prices from Binance's PUBLIC ticker endpoint. They exist only to satisfy
 * the defaultExchangeAuth gate AND act as a safety backstop — if trading
 * mode ever resolves to "live", a real order with these creds fails at
 * auth instead of executing real money.
 */
const PUBLIC_PAPER_TOKENS = {
    apiKeyName: "public-paper-key",
    apiKeySecret: "public-paper-secret",
} as const;

/**
 * Whether the account details already carry the exact paper-auth shape the
 * CEX defaultExchangeAuth gate (cexWorkflowMessageHandler.initializeWorkflow)
 * requires: trading enabled, default auth pointing at the registry authType,
 * and the tokens nested under exchangeAuths[venue][authType].
 */
function hasValidPaperAuth(details: Record<string, unknown>): boolean {
    if (details.enableTrading !== true) return false;

    const defaultAuth = details.defaultExchangeAuth as
        | { exchangeId?: unknown; authType?: unknown }
        | undefined;
    if (
        !defaultAuth ||
        defaultAuth.exchangeId !== PUBLIC_PAPER_VENUE ||
        defaultAuth.authType !== PUBLIC_PAPER_AUTH_TYPE
    ) {
        return false;
    }

    const exchangeAuths = details.exchangeAuths as
        | Record<string, Record<string, Record<string, unknown>>>
        | undefined;
    const tokens = exchangeAuths?.[PUBLIC_PAPER_VENUE]?.[PUBLIC_PAPER_AUTH_TYPE];
    if (!tokens || typeof tokens !== "object") return false;

    return (
        typeof tokens.apiKeyName === "string" &&
        tokens.apiKeyName.trim().length > 0 &&
        typeof tokens.apiKeySecret === "string" &&
        tokens.apiKeySecret.trim().length > 0
    );
}

/**
 * Auto-enable paper CEX for anonymous/public-access users (sqlite side-env).
 * Mirrors `pnpm dev:auth seed-trading` without requiring MongoDB prefs tables.
 */
export async function seedPublicAccessPaperTrading(
    runtime: IAgentRuntime,
    userId: UUID,
): Promise<void> {
    if (!isPublicAccessModeActive()) {
        return;
    }

    const account = await runtime.databaseAdapter.getAccountById(userId);
    if (!account) {
        return;
    }

    const details =
        account.details && typeof account.details === "object"
            ? ({ ...(account.details as Record<string, unknown>) } as Record<
                  string,
                  unknown
              >)
            : {};

    // Re-seed when the stored shape doesn't satisfy the gate, even if a prior
    // (buggy) seeder set publicAccessSeeded — so already-created accounts heal
    // on their next turn instead of staying permanently rejected.
    if (details.publicAccessSeeded === true && hasValidPaperAuth(details)) {
        return;
    }

    details.enableTrading = true;
    details.publicAccessSeeded = true;
    details.defaultExchangeAuth = {
        exchangeId: PUBLIC_PAPER_VENUE,
        authType: PUBLIC_PAPER_AUTH_TYPE,
    };
    details.exchangeAuths = {
        [PUBLIC_PAPER_VENUE]: {
            [PUBLIC_PAPER_AUTH_TYPE]: { ...PUBLIC_PAPER_TOKENS },
        },
    };

    const adapter = runtime.databaseAdapter as {
        updateAccountDetails?: (params: {
            userId: UUID;
            details: Record<string, unknown>;
        }) => Promise<void>;
    };

    if (typeof adapter.updateAccountDetails === "function") {
        await adapter.updateAccountDetails({ userId, details });
    }

    const cacheKey = `user_trading_preferences:${userId}:default_mode`;
    try {
        await runtime.cacheManager?.set?.(cacheKey, "paper");
    } catch (error) {
        elizaLogger.warn(
            `[publicAccess] Failed to cache paper trading mode for ${userId}: ${error}`,
        );
    }

    elizaLogger.info(
        `[publicAccess] Paper trading seeded for user ${userId} (venue=${PUBLIC_PAPER_VENUE})`,
    );
}
