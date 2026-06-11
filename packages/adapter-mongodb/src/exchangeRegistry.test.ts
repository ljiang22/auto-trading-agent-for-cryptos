import { describe, expect, it, vi } from "vitest";
import { MongoDatabaseAdapter } from "./index.ts";

function createAdapter() {
    return new MongoDatabaseAdapter({
        backendKind: "mongodb",
        connectionString: "mongodb://127.0.0.1:27017",
        connectionStringSource: "test",
        databaseName: "test_db",
        databaseNameSource: "test",
        clientOptions: {},
        summary: {
            tls: false,
            tlsCAFileConfigured: false,
            retryWrites: true,
            maxPoolSize: 1,
            minPoolSize: 0,
            connectTimeoutMS: 1000,
            socketTimeoutMS: 1000,
            serverSelectionTimeoutMS: 1000,
        },
    } as any);
}

describe("Mongo exchange registry parity", () => {
    it("maps exchange registry rows with native array authTypes and legacy key fallback", async () => {
        const adapter = createAdapter();
        const rows = [
            {
                id: "coinbase",
                name: "Coinbase",
                defaultAuthType: "api_key_name_secret",
                authTypes: [
                    {
                        type: "api_key_name_secret",
                        fields: [
                            {
                                key: "apiKeyName",
                                label: "API key name",
                                type: "secret",
                                required: true,
                            },
                        ],
                    },
                ],
            },
        ];

        (adapter as any).collection = vi.fn(() => ({
            find: vi.fn(() => ({
                sort: vi.fn(() => ({
                    toArray: vi.fn(async () => rows),
                })),
            })),
        }));

        const registry = await adapter.getExchangeRegistry();
        expect(registry).toHaveLength(1);
        expect(registry[0].id).toBe("coinbase");
        expect(registry[0].authTypes?.[0]?.fields?.[0]?.id).toBe("apiKeyName");
    });

    it("falls back to empty authTypes when authTypes JSON string is invalid", async () => {
        const adapter = createAdapter();
        const rows = [
            {
                id: "coinbase",
                name: "Coinbase",
                defaultAuthType: "api_key_name_secret",
                authTypes: "{not-valid-json",
            },
        ];

        (adapter as any).collection = vi.fn(() => ({
            find: vi.fn(() => ({
                sort: vi.fn(() => ({
                    toArray: vi.fn(async () => rows),
                })),
            })),
        }));

        const registry = await adapter.getExchangeRegistry();
        expect(registry).toHaveLength(1);
        expect(registry[0].authTypes).toEqual([]);
    });

    it("falls back to empty authTypes when parsed JSON is non-array", async () => {
        const adapter = createAdapter();
        const rows = [
            {
                id: "coinbase",
                name: "Coinbase",
                defaultAuthType: "api_key_name_secret",
                authTypes: JSON.stringify({ type: "api_key_name_secret" }),
            },
        ];

        (adapter as any).collection = vi.fn(() => ({
            find: vi.fn(() => ({
                sort: vi.fn(() => ({
                    toArray: vi.fn(async () => rows),
                })),
            })),
        }));

        const registry = await adapter.getExchangeRegistry();
        expect(registry).toHaveLength(1);
        expect(registry[0].authTypes).toEqual([]);
    });

    it("looks up one exchange by normalized id", async () => {
        const adapter = createAdapter();
        const row = {
            id: "binance",
            name: "Binance",
            defaultAuthType: "api_key_name_secret",
            authTypes: [],
        };

        const findOne = vi.fn(async () => row);
        (adapter as any).collection = vi.fn(() => ({ findOne }));

        const found = await adapter.getExchangeRegistryEntry("  BINANCE ");
        expect(findOne).toHaveBeenCalledWith({ id: "binance" });
        expect(found?.id).toBe("binance");
    });

    it("returns null when exchange lookup id is empty", async () => {
        const adapter = createAdapter();
        const findOne = vi.fn(async () => null);
        (adapter as any).collection = vi.fn(() => ({ findOne }));

        const found = await adapter.getExchangeRegistryEntry("   ");
        expect(found).toBeNull();
        expect(findOne).not.toHaveBeenCalled();
    });

    it("seeds canonical exchange registry entries idempotently", async () => {
        const adapter = createAdapter();
        const bulkWrite = vi.fn(async () => ({
            matchedCount: 2,
            modifiedCount: 2,
            upsertedCount: 0,
        }));
        (adapter as any).collection = vi.fn(() => ({ bulkWrite }));

        await (adapter as any).seedExchangeRegistry();
        await (adapter as any).seedExchangeRegistry();

        expect(bulkWrite).toHaveBeenCalledTimes(2);
        const firstCallOps = bulkWrite.mock.calls[0][0] as Array<{
            updateOne?: { filter?: { id?: string }; upsert?: boolean };
        }>;
        expect(firstCallOps).toHaveLength(2);
        expect(firstCallOps.every((op) => op.updateOne?.upsert === true)).toBe(true);
        expect(firstCallOps.map((op) => op.updateOne?.filter?.id).sort()).toEqual([
            "binance",
            "coinbase",
        ]);
        expect(
            firstCallOps.every((op) => typeof op.updateOne?.update?.$setOnInsert?.id === "string")
        ).toBe(true);
        expect(
            firstCallOps.every((op) => typeof op.updateOne?.update?.$setOnInsert?.createdAt === "number")
        ).toBe(true);
    });
});
