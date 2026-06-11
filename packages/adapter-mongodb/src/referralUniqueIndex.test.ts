import { describe, expect, it, vi } from "vitest";
import {
    ensureUniqueIndexOnUserId,
    type IndexManagementCollection,
    type IndexHelperLogger,
} from "./index.ts";

function makeLogger(): {
    logger: IndexHelperLogger;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
} {
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();
    return { logger: { info, warn, error }, info, warn, error };
}

function makeCollection(opts: {
    listIndexes?: () => Promise<Document[]> | Document[];
    dropIndex?: (name: string) => Promise<unknown> | unknown;
    createIndex?: (
        spec: Record<string, 1 | -1>,
        options?: { unique?: boolean; name?: string }
    ) => Promise<string> | string;
}): IndexManagementCollection & {
    listIndexesMock: ReturnType<typeof vi.fn>;
    dropIndexMock: ReturnType<typeof vi.fn>;
    createIndexMock: ReturnType<typeof vi.fn>;
} {
    const listIndexesMock = vi.fn(async () =>
        opts.listIndexes ? await opts.listIndexes() : []
    );
    const dropIndexMock = vi.fn(async (name: string) =>
        opts.dropIndex ? await opts.dropIndex(name) : undefined
    );
    const createIndexMock = vi.fn(
        async (
            spec: Record<string, 1 | -1>,
            options?: { unique?: boolean; name?: string }
        ) =>
            opts.createIndex
                ? ((await opts.createIndex(spec, options)) as string)
                : "ok"
    );
    return {
        listIndexes: () => ({ toArray: () => listIndexesMock() as Promise<Document[]> }),
        dropIndex: dropIndexMock,
        createIndex: createIndexMock,
        listIndexesMock,
        dropIndexMock,
        createIndexMock,
    };
}

// Type alias to match the unused `Document` from mongodb in test helpers above.
type Document = Record<string, unknown>;

describe("ensureUniqueIndexOnUserId", () => {
    it("no-ops when the unique index already exists", async () => {
        const { logger, info, warn, error } = makeLogger();
        const col = makeCollection({
            listIndexes: () => [
                { name: "_id_", key: { _id: 1 } },
                { name: "userId_1_unique", key: { userId: 1 }, unique: true },
            ],
        });
        const outcome = await ensureUniqueIndexOnUserId(col, logger);
        expect(outcome).toBe("already-unique");
        expect(col.dropIndexMock).not.toHaveBeenCalled();
        expect(col.createIndexMock).not.toHaveBeenCalled();
        expect(info).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
    });

    it("on a fresh DB (no existing userId index) creates the unique index", async () => {
        const { logger, info } = makeLogger();
        const col = makeCollection({
            listIndexes: () => [{ name: "_id_", key: { _id: 1 } }],
        });
        const outcome = await ensureUniqueIndexOnUserId(col, logger);
        expect(outcome).toBe("created-unique");
        expect(col.dropIndexMock).not.toHaveBeenCalled();
        expect(col.createIndexMock).toHaveBeenCalledWith(
            { userId: 1 },
            { unique: true, name: "userId_1_unique" }
        );
        expect(info).toHaveBeenCalledOnce();
    });

    it("upgrades a legacy non-unique userId index by dropping and recreating", async () => {
        const { logger, info } = makeLogger();
        const col = makeCollection({
            listIndexes: () => [
                { name: "_id_", key: { _id: 1 } },
                { name: "userId_1", key: { userId: 1 } /* no unique flag */ },
            ],
        });
        const outcome = await ensureUniqueIndexOnUserId(col, logger);
        expect(outcome).toBe("created-unique");
        expect(col.dropIndexMock).toHaveBeenCalledWith("userId_1");
        expect(col.createIndexMock).toHaveBeenCalledWith(
            { userId: 1 },
            { unique: true, name: "userId_1_unique" }
        );
        expect(info).toHaveBeenCalledOnce();
    });

    it("falls back to non-unique when duplicate rows block the unique constraint (E11000)", async () => {
        const { logger, warn, error } = makeLogger();
        const e11000: Error & { code: number } = Object.assign(
            new Error("E11000 duplicate key error"),
            { code: 11000 }
        );
        let createIndexCallCount = 0;
        const col = makeCollection({
            listIndexes: () => [{ name: "_id_", key: { _id: 1 } }],
            createIndex: () => {
                createIndexCallCount += 1;
                if (createIndexCallCount === 1) throw e11000;
                return "ok";
            },
        });
        const outcome = await ensureUniqueIndexOnUserId(col, logger);
        expect(outcome).toBe("fallback-non-unique");
        expect(col.createIndexMock).toHaveBeenCalledTimes(2);
        // First call attempted unique
        expect(col.createIndexMock).toHaveBeenNthCalledWith(
            1,
            { userId: 1 },
            { unique: true, name: "userId_1_unique" }
        );
        // Second call fell back to non-unique
        expect(col.createIndexMock).toHaveBeenNthCalledWith(2, { userId: 1 });
        expect(warn).toHaveBeenCalledOnce();
        expect(error).not.toHaveBeenCalled();
    });

    it("also treats codeName='DuplicateKey' as a fallback trigger", async () => {
        const { logger } = makeLogger();
        const dupCodeName: Error & { codeName: string } = Object.assign(
            new Error("DuplicateKey"),
            { codeName: "DuplicateKey" }
        );
        let attempts = 0;
        const col = makeCollection({
            listIndexes: () => [{ name: "_id_", key: { _id: 1 } }],
            createIndex: () => {
                attempts += 1;
                if (attempts === 1) throw dupCodeName;
                return "ok";
            },
        });
        const outcome = await ensureUniqueIndexOnUserId(col, logger);
        expect(outcome).toBe("fallback-non-unique");
    });

    it("returns 'fallback-also-failed' when both unique and non-unique create throw", async () => {
        const { logger, error } = makeLogger();
        const col = makeCollection({
            listIndexes: () => [{ name: "_id_", key: { _id: 1 } }],
            createIndex: () => {
                const err = Object.assign(new Error("E11000"), { code: 11000 });
                throw err;
            },
        });
        const outcome = await ensureUniqueIndexOnUserId(col, logger);
        expect(outcome).toBe("fallback-also-failed");
        expect(error).toHaveBeenCalledOnce();
    });

    it("propagates non-duplicate-key createIndex errors so deploys surface real bugs", async () => {
        const { logger } = makeLogger();
        const someOtherErr = Object.assign(new Error("Auth failed"), {
            code: 13,
        });
        const col = makeCollection({
            listIndexes: () => [{ name: "_id_", key: { _id: 1 } }],
            createIndex: () => {
                throw someOtherErr;
            },
        });
        await expect(
            ensureUniqueIndexOnUserId(col, logger)
        ).rejects.toThrow("Auth failed");
    });

    it("bails out gracefully when listIndexes itself fails (transient Mongo flake)", async () => {
        const { logger, warn } = makeLogger();
        const col = makeCollection({
            listIndexes: () => {
                throw new Error("connection reset");
            },
        });
        const outcome = await ensureUniqueIndexOnUserId(col, logger);
        expect(outcome).toBe("skipped-list-failed");
        expect(col.dropIndexMock).not.toHaveBeenCalled();
        expect(col.createIndexMock).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledOnce();
    });

    it("bails out when dropIndex fails (avoid leaving the collection indexless)", async () => {
        const { logger, warn } = makeLogger();
        const col = makeCollection({
            listIndexes: () => [
                { name: "userId_1", key: { userId: 1 } /* non-unique */ },
            ],
            dropIndex: () => {
                throw new Error("permission denied");
            },
        });
        const outcome = await ensureUniqueIndexOnUserId(col, logger);
        expect(outcome).toBe("skipped-drop-failed");
        expect(col.createIndexMock).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledOnce();
    });

    it("ignores indexes on other single-field keys", async () => {
        const { logger } = makeLogger();
        const col = makeCollection({
            // referralCode_1 (unique) and id_1 (unique) shouldn't be mistaken
            // for the userId index.
            listIndexes: () => [
                { name: "_id_", key: { _id: 1 } },
                { name: "referralCode_1", key: { referralCode: 1 }, unique: true },
                { name: "id_1", key: { id: 1 }, unique: true },
            ],
        });
        const outcome = await ensureUniqueIndexOnUserId(col, logger);
        // Treat as fresh — no userId index found, so create one.
        expect(outcome).toBe("created-unique");
        expect(col.createIndexMock).toHaveBeenCalledWith(
            { userId: 1 },
            { unique: true, name: "userId_1_unique" }
        );
    });

    it("ignores compound indexes that include userId", async () => {
        const { logger } = makeLogger();
        const col = makeCollection({
            // A compound (userId, agentId) index shouldn't satisfy the
            // single-field uniqueness requirement.
            listIndexes: () => [
                { name: "userId_1_agentId_1", key: { userId: 1, agentId: 1 } },
            ],
        });
        const outcome = await ensureUniqueIndexOnUserId(col, logger);
        expect(outcome).toBe("created-unique");
    });
});
