import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stringToUuid, type UUID } from "@elizaos/core";
import { SqliteDatabaseAdapter } from "../src";

vi.mock("../src/sqlite_vec", () => ({
    load: vi.fn(),
}));

describe("SqliteDatabaseAdapter.createAccount", () => {
    let db: Database.Database;
    let adapter: SqliteDatabaseAdapter;

    beforeEach(async () => {
        db = new Database(":memory:");
        adapter = new SqliteDatabaseAdapter(db as unknown as Database.Database);
        await adapter.init();
    });

    it("creates an account row for a provided id even when the email already exists under a different id", async () => {
        const email = "test@example.com";
        const firstId = stringToUuid("first-account") as UUID;
        const secondId = stringToUuid("second-account") as UUID;

        const createdFirst = await adapter.createAccount({
            id: firstId,
            name: "Test User",
            username: "test-user",
            email,
            avatarUrl: null,
            details: { source: "test" },
        } as any);
        expect(createdFirst).toBe(true);

        const createdSecond = await adapter.createAccount({
            id: secondId,
            name: "Test User 2",
            username: "test-user-2",
            email,
            avatarUrl: null,
            details: { source: "test" },
        } as any);
        expect(createdSecond).toBe(true);

        const rows = db
            .prepare("SELECT id FROM accounts WHERE lower(email) = lower(?) ORDER BY createdAt ASC")
            .all(email) as Array<{ id: string }>;

        expect(rows.map((row) => row.id)).toEqual(expect.arrayContaining([firstId, secondId]));
        expect(rows).toHaveLength(2);
    });
});

