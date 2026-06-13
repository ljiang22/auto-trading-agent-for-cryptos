import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedPublicAccessPaperTrading } from "../src/utils/publicAccessSeed";

/**
 * Mirrors the defaultExchangeAuth validation in
 * cexWorkflowMessageHandler.initializeWorkflow (the gate that emits
 * getCEXDefaultExchangeRequiredErrorTemplate). If this returns false the
 * public-access user is told to "set up a default exchange". Kept in sync
 * with the handler traversal: exchangeAuths[exchangeId][authType][field.id].
 */
function validateDefaultExchangeAuth(
    details: Record<string, any>,
    registry: Array<{ id: string; authTypes: Array<{ type: string; fields: Array<{ id: string; type: string; required: boolean }> }> }>
): { hasValidDefaultAuth: boolean; defaultExchangeId: string | null } {
    const isNonEmptyString = (v: unknown): v is string =>
        typeof v === "string" && v.trim().length > 0;

    let hasValidDefaultAuth = false;
    let defaultExchangeId: string | null = null;

    const defaultExchangeAuth = details.defaultExchangeAuth;
    const exchangeAuths = details.exchangeAuths ?? {};

    if (defaultExchangeAuth) {
        const { exchangeId, authType } = defaultExchangeAuth;
        const forExchange =
            exchangeAuths[exchangeId] && typeof exchangeAuths[exchangeId] === "object"
                ? exchangeAuths[exchangeId]
                : null;
        if (forExchange) {
            const rawTokensForAuthType =
                forExchange[authType] && typeof forExchange[authType] === "object"
                    ? forExchange[authType]
                    : null;
            if (rawTokensForAuthType) {
                const matchingEntry = registry.find(
                    (e) => e.id === exchangeId && Array.isArray(e.authTypes)
                );
                if (matchingEntry) {
                    const authConfig = matchingEntry.authTypes.find((c) => c.type === authType);
                    if (authConfig) {
                        const requiredFields = (authConfig.fields ?? []).filter((f) => f.required === true);
                        hasValidDefaultAuth = requiredFields.every((field) =>
                            isNonEmptyString(rawTokensForAuthType[field.id])
                        );
                        if (hasValidDefaultAuth && isNonEmptyString(exchangeId)) {
                            defaultExchangeId = exchangeId.trim().toLowerCase();
                        }
                    }
                }
            }
        }
    }

    return { hasValidDefaultAuth, defaultExchangeId };
}

// Binance registry entry exactly as seeded by adapter-sqlite (ensureExchangeRegistrySeed).
const BINANCE_REGISTRY = [
    {
        id: "binance",
        authTypes: [
            {
                type: "api_key_name_secret",
                fields: [
                    { id: "apiKeyName", type: "secret", required: true },
                    { id: "apiKeySecret", type: "secret", required: true },
                ],
            },
        ],
    },
];

function makeRuntime(initialDetails: Record<string, any>) {
    const account = { id: "user-1", details: initialDetails };
    const cache = new Map<string, unknown>();
    let written: Record<string, any> | null = null;
    return {
        runtime: {
            databaseAdapter: {
                getAccountById: async () => account,
                updateAccountDetails: async ({ details }: { details: Record<string, any> }) => {
                    written = details;
                    account.details = details;
                },
            },
            cacheManager: {
                set: async (k: string, v: unknown) => {
                    cache.set(k, v);
                },
            },
        } as any,
        getWritten: () => written,
        cache,
    };
}

describe("seedPublicAccessPaperTrading", () => {
    beforeEach(() => {
        process.env.PUBLIC_ACCESS_MODE = "1";
    });
    afterEach(() => {
        delete process.env.PUBLIC_ACCESS_MODE;
    });

    it("seeds account details that pass the CEX defaultExchangeAuth gate", async () => {
        const { runtime, getWritten } = makeRuntime({});

        await seedPublicAccessPaperTrading(runtime, "user-1");

        const details = getWritten();
        expect(details).not.toBeNull();
        expect(details!.enableTrading).toBe(true);

        const { hasValidDefaultAuth, defaultExchangeId } = validateDefaultExchangeAuth(
            details!,
            BINANCE_REGISTRY
        );
        expect(hasValidDefaultAuth).toBe(true);
        expect(defaultExchangeId).toBe("binance");
    });

    it("sets the paper trading mode in the cache (routes orders to the paper ledger)", async () => {
        const { runtime, cache } = makeRuntime({});

        await seedPublicAccessPaperTrading(runtime, "user-1");

        expect(cache.get("user_trading_preferences:user-1:default_mode")).toBe("paper");
    });

    it("re-seeds an account previously seeded with an invalid auth shape", async () => {
        // An account from the buggy seeder: marked seeded, but the auth shape
        // does not satisfy the gate (wrong authType + flat token nesting).
        const stale = {
            enableTrading: true,
            publicAccessSeeded: true,
            defaultExchangeAuth: { exchangeId: "binance", authType: "apiKey" },
            exchangeAuths: {
                binance: { apiKeyName: "public-paper-key", apiKeySecret: "public-paper-secret" },
            },
        };
        // Confirm the stale shape really does fail the gate (guards the premise).
        expect(validateDefaultExchangeAuth(stale, BINANCE_REGISTRY).hasValidDefaultAuth).toBe(false);

        const { runtime, getWritten } = makeRuntime(stale);
        await seedPublicAccessPaperTrading(runtime, "user-1");

        const details = getWritten();
        expect(details).not.toBeNull();
        expect(validateDefaultExchangeAuth(details!, BINANCE_REGISTRY).hasValidDefaultAuth).toBe(true);
    });

    it("is a no-op when public access mode is off", async () => {
        delete process.env.PUBLIC_ACCESS_MODE;
        const { runtime, getWritten } = makeRuntime({});

        await seedPublicAccessPaperTrading(runtime, "user-1");

        expect(getWritten()).toBeNull();
    });
});
