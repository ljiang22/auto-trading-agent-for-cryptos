import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMongoRuntimeConfig } from "./index.ts";

const originalEnv = { ...process.env };

function createRuntime(settings: Record<string, string | undefined>) {
    return {
        getSetting: vi.fn((key: string) => settings[key]),
    } as any;
}

afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
});

describe("resolveMongoRuntimeConfig", () => {
    it("prefers DOCUMENTDB_* settings in documentdb mode", () => {
        process.env.DOCUMENTDB_CONNECTION_STRING = "mongodb://documentdb.example:27017";
        process.env.MONGODB_CONNECTION_STRING = "mongodb://mongodb.example:27017";
        process.env.DOCUMENTDB_DATABASE = "documentdb_db";
        process.env.MONGODB_DATABASE = "mongodb_db";
        process.env.DOCUMENTDB_APP_NAME = "documentdb-app";
        process.env.MONGODB_APP_NAME = "mongodb-app";

        const config = resolveMongoRuntimeConfig(
            createRuntime({ DATABASE_ADAPTER: "documentdb" })
        );

        expect(config.backendKind).toBe("documentdb");
        expect(config.connectionString).toBe("mongodb://documentdb.example:27017");
        expect(config.connectionStringSource).toBe("DOCUMENTDB_CONNECTION_STRING");
        expect(config.databaseName).toBe("documentdb_db");
        expect(config.databaseNameSource).toBe("DOCUMENTDB_DATABASE");
        expect(config.summary.tls).toBe(true);
        expect(config.summary.retryWrites).toBe(false);
        expect(config.summary.appName).toBe("documentdb-app");
    });

    it("prefers MONGODB_* settings in mongodb mode", () => {
        process.env.DOCUMENTDB_CONNECTION_STRING = "mongodb://documentdb.example:27017";
        process.env.MONGODB_CONNECTION_STRING = "mongodb://mongodb.example:27017";
        process.env.DOCUMENTDB_DATABASE = "documentdb_db";
        process.env.MONGODB_DATABASE = "mongodb_db";

        const config = resolveMongoRuntimeConfig(
            createRuntime({ DATABASE_ADAPTER: "mongodb" })
        );

        expect(config.backendKind).toBe("mongodb");
        expect(config.connectionString).toBe("mongodb://mongodb.example:27017");
        expect(config.connectionStringSource).toBe("MONGODB_CONNECTION_STRING");
        expect(config.databaseName).toBe("mongodb_db");
        expect(config.databaseNameSource).toBe("MONGODB_DATABASE");
        expect(config.summary.retryWrites).toBe(true);
    });

    it("fails clearly when documentdb mode is missing a database name", () => {
        process.env.DOCUMENTDB_CONNECTION_STRING = "mongodb://documentdb.example:27017";
        delete process.env.DOCUMENTDB_DATABASE;
        delete process.env.MONGODB_DATABASE;

        expect(() =>
            resolveMongoRuntimeConfig(createRuntime({ DATABASE_ADAPTER: "documentdb" }))
        ).toThrow(
            "Database adapter 'documentdb' requires DOCUMENTDB_DATABASE (preferred) or MONGODB_DATABASE. See docs/documentdb-runtime-contract.md for the supported runtime contract."
        );
    });

    it("fails clearly when mongodb mode is missing a database name", () => {
        process.env.MONGODB_CONNECTION_STRING = "mongodb://mongodb.example:27017";
        delete process.env.DOCUMENTDB_DATABASE;
        delete process.env.MONGODB_DATABASE;

        expect(() =>
            resolveMongoRuntimeConfig(createRuntime({ DATABASE_ADAPTER: "mongodb" }))
        ).toThrow(
            "Database adapter 'mongodb' requires MONGODB_DATABASE. See docs/documentdb-runtime-contract.md for the supported runtime contract."
        );
    });
});
