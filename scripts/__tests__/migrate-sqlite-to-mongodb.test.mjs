import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import os from "os";
import path from "path";
import fs from "fs";

import {
    migrateTable,
    parseArgs,
    resolveOptions,
} from "../migrate-sqlite-to-mongodb.mjs";

const originalEnv = { ...process.env };

function resetEnv() {
    process.env = { ...originalEnv };
}

function createTempSqliteFile() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-script-test-"));
    const filePath = path.join(tempDir, "test.sqlite");
    const db = new Database(filePath);
    return { tempDir, filePath, db };
}

function createAccountsSqliteDb() {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE accounts (
            id TEXT PRIMARY KEY,
            email TEXT,
            createdAt INTEGER
        );
        INSERT INTO accounts (id, email, createdAt)
        VALUES ('user-1', 'user@example.com', 1710000000000);
    `);
    return db;
}

afterEach(() => {
    resetEnv();
});

test("parseArgs keeps truncate disabled unless explicitly requested", () => {
    const options = parseArgs([
        "--source",
        "agent/data/db.sqlite",
        "--connection",
        "mongodb://example:27017",
        "--database",
        "senti_agent",
        "--tls",
        "--ca-file",
        "./certs/documentdb-ca.pem",
        "--dry-run",
    ]);

    assert.equal(options.truncate, false);
    assert.equal(options.dryRun, true);
    assert.equal(options.tls, true);
    assert.equal(options.caFile, "./certs/documentdb-ca.pem");
});

test("resolveOptions fails clearly when required CLI inputs are missing", () => {
    assert.throws(
        () => resolveOptions({ source: "", connection: "", database: "" }),
        /Missing source SQLite file/
    );

    const { tempDir, filePath, db } = createTempSqliteFile();
    db.exec("CREATE TABLE accounts (id TEXT PRIMARY KEY);");
    db.close();

    assert.throws(
        () => resolveOptions({ source: filePath, connection: "", database: "target" }),
        /Missing target connection string/
    );

    assert.throws(
        () => resolveOptions({
            source: filePath,
            connection: "mongodb://example:27017",
            database: "",
        }),
        /Missing target database name/
    );

    fs.rmSync(tempDir, { recursive: true, force: true });
});

test("resolveOptions validates CA bundle inputs conservatively", () => {
    const { tempDir, filePath, db } = createTempSqliteFile();
    db.exec("CREATE TABLE accounts (id TEXT PRIMARY KEY);");
    db.close();

    assert.throws(
        () =>
            resolveOptions({
                source: filePath,
                connection: "mongodb://example:27017",
                database: "target",
                caFile: "./missing-ca.pem",
            }),
        /Configured CA bundle file not found/
    );

    const caFilePath = path.join(tempDir, "documentdb-ca.pem");
    fs.writeFileSync(caFilePath, "fake ca");

    assert.throws(
        () =>
            resolveOptions({
                source: filePath,
                connection: "mongodb://example:27017",
                database: "target",
                tls: false,
                caFile: caFilePath,
            }),
        /A CA bundle was provided but TLS is explicitly disabled/
    );

    fs.rmSync(tempDir, { recursive: true, force: true });
});

test("migrateTable dry-run performs zero writes even when truncate is requested", async () => {
    const sqlite = createAccountsSqliteDb();
    let deleteCalled = false;
    let bulkWriteCalled = false;

    const collection = {
        collectionName: "accounts",
        countDocuments: async () => 5,
        deleteMany: async () => {
            deleteCalled = true;
            return { deletedCount: 5 };
        },
        bulkWrite: async () => {
            bulkWriteCalled = true;
            return {
                insertedCount: 0,
                upsertedCount: 1,
                matchedCount: 0,
                modifiedCount: 0,
            };
        },
    };

    const result = await migrateTable({
        sqlite,
        db: { collection: () => collection },
        table: "accounts",
        truncate: true,
        dryRun: true,
        batchSize: 100,
        limit: 0,
        sampleSize: 1,
        verbose: false,
        logger: { verbose() {} },
    });

    assert.equal(deleteCalled, false);
    assert.equal(bulkWriteCalled, false);
    assert.equal(result.truncateApplied, false);
    assert.equal(result.wouldUpsertRows, 1);
    sqlite.close();
});

test("migrateTable only deletes target data when truncate is explicitly enabled", async () => {
    const sqlite = createAccountsSqliteDb();
    let deleteCalled = false;
    let bulkWriteCalled = false;

    const collection = {
        collectionName: "accounts",
        countDocuments: async () => 2,
        deleteMany: async () => {
            deleteCalled = true;
            return { deletedCount: 2 };
        },
        bulkWrite: async () => {
            bulkWriteCalled = true;
            return {
                insertedCount: 0,
                upsertedCount: 1,
                matchedCount: 0,
                modifiedCount: 0,
            };
        },
    };

    const result = await migrateTable({
        sqlite,
        db: { collection: () => collection },
        table: "accounts",
        truncate: true,
        dryRun: false,
        batchSize: 100,
        limit: 0,
        sampleSize: 1,
        verbose: false,
        logger: { verbose() {} },
    });

    assert.equal(deleteCalled, true);
    assert.equal(bulkWriteCalled, true);
    assert.equal(result.truncateApplied, true);
    assert.equal(result.deletedBeforeLoad, 2);
    sqlite.close();
});
