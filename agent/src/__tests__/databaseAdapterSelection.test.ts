import { describe, expect, it } from "@jest/globals";
import { resolvePreferredDatabaseAdapter } from "../databaseAdapterSelection.ts";

describe("resolvePreferredDatabaseAdapter", () => {
    it("defaults to sqlite when DATABASE_ADAPTER is missing", () => {
        expect(resolvePreferredDatabaseAdapter(undefined)).toEqual({
            preferredAdapter: "sqlite",
            usedDefault: true,
        });
    });

    it("normalizes mongodb and documentdb aliases", () => {
        expect(resolvePreferredDatabaseAdapter("mongo")).toEqual({
            preferredAdapter: "mongodb",
            usedDefault: false,
        });

        expect(resolvePreferredDatabaseAdapter("docdb")).toEqual({
            preferredAdapter: "documentdb",
            usedDefault: false,
        });
    });

    it("throws for unsupported adapter values", () => {
        expect(() => resolvePreferredDatabaseAdapter("postgres")).toThrow(
            "Unsupported DATABASE_ADAPTER 'postgres'. Supported values: sqlite, mongodb, documentdb."
        );
    });
});
