import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stringToUuid, type UUID } from "@elizaos/core";
import { SqliteDatabaseAdapter } from "../src";

vi.mock("../src/sqlite_vec", () => ({
    load: vi.fn(),
}));

describe("SqliteDatabaseAdapter.createAccount safe JSON", () => {
    let db: Database.Database;
    let adapter: SqliteDatabaseAdapter;

    beforeEach(async () => {
        db = new Database(":memory:");
        adapter = new SqliteDatabaseAdapter(db as unknown as Database.Database);
        await adapter.init();
    });

    it("does not throw when account.details contains circular references", async () => {
        const id = stringToUuid("circular-user") as UUID;

        const circular: any = { ok: true };
        circular.self = circular;

        const created = await adapter.createAccount({
            id,
            name: "Circular",
            username: "circular",
            email: "circular@example.com",
            avatarUrl: null,
            details: circular,
        } as any);

        expect(created).toBe(true);

        const row = db.prepare("SELECT details FROM accounts WHERE id = ?").get(id) as
            | { details: string }
            | undefined;
        expect(row?.details).toBeTypeOf("string");
        expect(() => JSON.parse(row?.details ?? "{}")).not.toThrow();
    });
});

