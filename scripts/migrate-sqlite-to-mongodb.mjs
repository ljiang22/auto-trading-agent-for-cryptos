import fs from "fs";
import path from "path";
import process from "process";
import { pathToFileURL } from "url";
import Database from "better-sqlite3";
import { MongoClient } from "mongodb";

const TARGET_LABEL = "Mongo-compatible target (e.g., Amazon DocumentDB)";
const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_SAMPLE_SIZE = 3;
const DEFAULT_MAX_POOL_SIZE = 20;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_SOCKET_TIMEOUT_MS = 45_000;

const JSON_FIELDS = {
    accounts: ["details"],
    memories: ["content"],
    goals: ["objectives"],
    logs: ["body"],
    knowledge: ["content"],
    favorite_taskchains: ["taskChain"],
    shared_taskchains: ["taskChain"],
    subscription_events: ["eventData"],
};

const BOOLEAN_FIELDS = {
    memories: ["unique"],
    user_referral_codes: ["isMatched"],
    user_subscriptions: ["cancelAtPeriodEnd"],
    favorite_taskchains: ["isPublic"],
    web_page_sessions: ["isAuthenticated"],
};

const EMBEDDING_FIELDS = {
    memories: ["embedding"],
    knowledge: ["embedding"],
    action_cache: ["queryEmbedding", "embedding"],
};

const UPSERT_KEYS = {
    cache: ["key", "agentId"],
    analytics_usage_rollup: ["day", "segment"],
    analytics_usage_rollup_users: ["day", "segment", "userId"],
};

function loadEnvFile(filePath) {
    if (!fs.existsSync(filePath)) return;

    const content = fs.readFileSync(filePath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;

        const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) continue;

        const key = match[1];
        if (process.env[key] !== undefined) continue;

        let value = match[2].trim();
        if (
            (value.startsWith("\"") && value.endsWith("\"")) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        value = value.replace(/\\n/g, "\n");
        process.env[key] = value;
    }
}

function parsePositiveInt(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBoolean(value, fallback) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === "boolean") return value;
    const normalized = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
    return fallback;
}

function getTargetConnectionString() {
    return (
        process.env.DOCUMENTDB_CONNECTION_STRING ||
        process.env.MONGODB_CONNECTION_STRING ||
        ""
    ).trim();
}

function getTargetDatabaseName() {
    return (
        process.env.DOCUMENTDB_DATABASE ||
        process.env.MONGODB_DATABASE ||
        ""
    ).trim();
}

function getTargetTlsSetting() {
    const value = process.env.DOCUMENTDB_TLS ?? process.env.MONGODB_TLS;
    return typeof value === "string" ? value.trim() : "";
}

function getTargetCaFile() {
    const value = process.env.DOCUMENTDB_CA_FILE ?? process.env.MONGODB_CA_FILE;
    return typeof value === "string" ? value.trim() : "";
}

function createLogger(verbose) {
    return {
        step(label, message) {
            console.log(`\n[${label}] ${message}`);
        },
        info(message) {
            console.log(`INFO  ${message}`);
        },
        warn(message) {
            console.warn(`WARN  ${message}`);
        },
        error(message) {
            console.error(`ERROR ${message}`);
        },
        verbose(message) {
            if (verbose) {
                console.log(`DEBUG ${message}`);
            }
        },
        table(message) {
            console.log(`  - ${message}`);
        },
    };
}

function redactConnectionString(connectionString) {
    const redactedCredentials = connectionString.replace(
        /^(mongodb(?:\+srv)?:\/\/)([^@]+)@/i,
        "$1<credentials-redacted>@"
    );

    if (redactedCredentials.includes("?")) {
        return `${redactedCredentials.split("?")[0]}?...`;
    }

    return redactedCredentials;
}

function printHelp() {
    console.log(`
SQLite -> ${TARGET_LABEL} migration tool

Usage:
  pnpm migrate:sqlite-to-mongodb -- --source <sqlite-file> --connection <uri> --database <name> [options]

Required inputs:
  --source <path>           Path to source SQLite file
                            Alias: --sqlite-file
  --connection <uri>        ${TARGET_LABEL} connection string
                            Alias: --mongo-uri
  --database <name>         Target database name
                            Alias: --mongo-db

Optional flags:
  --tables <a,b,c>          Comma-separated subset of tables to migrate
  --dry-run                 Read, normalize, inspect target, and verify plan with ZERO writes
  --truncate                Explicitly delete target collection contents before loading data
  --tls                     Enable TLS for the target driver connection
  --no-tls                  Disable TLS for the target driver connection
  --ca-file <path>          Path to a TLS CA bundle for the target driver connection
  --batch-size <n>          Bulk write batch size (default: ${DEFAULT_BATCH_SIZE})
  --limit <n>               Maximum rows to process per table (default: unlimited)
  --sample-size <n>         Verification spot-check sample size per table (default: ${DEFAULT_SAMPLE_SIZE}, 0 disables)
  --verbose                 Print detailed progress logs
  --verify-counts           Verify per-table target counts after migration (default: true)
  --no-verify-counts        Skip post-migration count verification
  --report-file <path>      Write JSON report to file
  --help                    Show this help

Environment fallbacks:
  SQLITE_FILE
  DOCUMENTDB_CONNECTION_STRING or MONGODB_CONNECTION_STRING
  DOCUMENTDB_DATABASE or MONGODB_DATABASE
  DOCUMENTDB_TLS or MONGODB_TLS
  DOCUMENTDB_CA_FILE or MONGODB_CA_FILE
  MIGRATE_TABLES
  MIGRATE_DRY_RUN
  MIGRATE_VERIFY_COUNTS
  MIGRATE_BATCH_SIZE
  MIGRATE_LIMIT
  MIGRATE_SAMPLE_SIZE
  MIGRATE_REPORT_FILE
  MIGRATE_VERBOSE

Notes:
  - --truncate is never enabled by default.
  - The script uses standard MongoDB driver operations only.
  - The target is described as Mongo-compatible so the CTO can later point it at Amazon DocumentDB.
`.trim());
}

export function parseArgs(argv) {
    const options = {
        source: undefined,
        connection: undefined,
        database: undefined,
        tables: undefined,
        truncate: false,
        dryRun: parseBoolean(process.env.MIGRATE_DRY_RUN, false),
        tls: parseBoolean(getTargetTlsSetting(), undefined),
        caFile: getTargetCaFile(),
        verifyCounts: parseBoolean(process.env.MIGRATE_VERIFY_COUNTS, true),
        batchSize: parsePositiveInt(process.env.MIGRATE_BATCH_SIZE, DEFAULT_BATCH_SIZE),
        limit: parseNonNegativeInt(process.env.MIGRATE_LIMIT, 0),
        sampleSize: parseNonNegativeInt(process.env.MIGRATE_SAMPLE_SIZE, DEFAULT_SAMPLE_SIZE),
        reportFile: process.env.MIGRATE_REPORT_FILE || "",
        verbose: parseBoolean(process.env.MIGRATE_VERBOSE, false),
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1];

        switch (arg) {
            case "--":
                break;
            case "--source":
            case "--sqlite-file":
                if (!next) throw new Error(`${arg} requires a value`);
                options.source = next;
                index += 1;
                break;
            case "--connection":
            case "--mongo-uri":
                if (!next) throw new Error(`${arg} requires a value`);
                options.connection = next;
                index += 1;
                break;
            case "--database":
            case "--mongo-db":
                if (!next) throw new Error(`${arg} requires a value`);
                options.database = next;
                index += 1;
                break;
            case "--tables":
                if (!next) throw new Error("--tables requires a value");
                options.tables = next
                    .split(",")
                    .map((item) => item.trim())
                    .filter(Boolean);
                index += 1;
                break;
            case "--dry-run":
                options.dryRun = true;
                break;
            case "--truncate":
                options.truncate = true;
                break;
            case "--no-truncate":
                options.truncate = false;
                break;
            case "--tls":
                options.tls = true;
                break;
            case "--no-tls":
                options.tls = false;
                break;
            case "--ca-file":
                if (!next) throw new Error("--ca-file requires a value");
                options.caFile = next;
                index += 1;
                break;
            case "--batch-size":
                if (!next) throw new Error("--batch-size requires a value");
                options.batchSize = parsePositiveInt(next, DEFAULT_BATCH_SIZE);
                index += 1;
                break;
            case "--limit":
                if (!next) throw new Error("--limit requires a value");
                options.limit = parseNonNegativeInt(next, 0);
                index += 1;
                break;
            case "--sample-size":
                if (!next) throw new Error("--sample-size requires a value");
                options.sampleSize = parseNonNegativeInt(next, DEFAULT_SAMPLE_SIZE);
                index += 1;
                break;
            case "--verbose":
                options.verbose = true;
                break;
            case "--verify-counts":
                options.verifyCounts = true;
                break;
            case "--no-verify-counts":
                options.verifyCounts = false;
                break;
            case "--report-file":
                if (!next) throw new Error("--report-file requires a value");
                options.reportFile = next;
                index += 1;
                break;
            case "--help":
            case "-h":
                printHelp();
                process.exit(0);
                break;
            default:
                throw new Error(`Unknown argument: ${arg}`);
        }
    }

    if (!options.tables && process.env.MIGRATE_TABLES) {
        options.tables = process.env.MIGRATE_TABLES.split(",")
            .map((item) => item.trim())
            .filter(Boolean);
    }

    return options;
}

export function resolveOptions(rawOptions) {
    const sourceInput = (rawOptions.source || process.env.SQLITE_FILE || "").trim();
    const connection = (rawOptions.connection || getTargetConnectionString()).trim();
    const database = (rawOptions.database || getTargetDatabaseName()).trim();

    if (!sourceInput) {
        throw new Error(
            "Missing source SQLite file. Pass --source <path> or set SQLITE_FILE."
        );
    }

    const source = path.resolve(process.cwd(), sourceInput);

    if (!fs.existsSync(source)) {
        throw new Error(
            `Source SQLite file not found: ${source}. Pass --source <path> to the real SQLite snapshot.`
        );
    }

    if (!connection) {
        throw new Error(
            `Missing target connection string. Pass --connection <uri> or set DOCUMENTDB_CONNECTION_STRING / MONGODB_CONNECTION_STRING.`
        );
    }

    if (!database) {
        throw new Error(
            `Missing target database name. Pass --database <name> or set DOCUMENTDB_DATABASE / MONGODB_DATABASE.`
        );
    }

    const caFileInput = (rawOptions.caFile || "").trim();
    const caFile = caFileInput ? path.resolve(process.cwd(), caFileInput) : "";
    if (caFile && !fs.existsSync(caFile)) {
        throw new Error(
            `Configured CA bundle file not found: ${caFile}. Pass --ca-file <path> or set DOCUMENTDB_CA_FILE / MONGODB_CA_FILE to an existing file.`
        );
    }

    if (caFile && rawOptions.tls === false) {
        throw new Error(
            "A CA bundle was provided but TLS is explicitly disabled. Remove --no-tls / set TLS=true, or omit --ca-file."
        );
    }

    return {
        ...rawOptions,
        source,
        connection,
        database,
        caFile,
        batchSize: parsePositiveInt(rawOptions.batchSize, DEFAULT_BATCH_SIZE),
        limit: parseNonNegativeInt(rawOptions.limit, 0),
        sampleSize: parseNonNegativeInt(rawOptions.sampleSize, DEFAULT_SAMPLE_SIZE),
    };
}

function toTimestamp(value) {
    if (typeof value === "number") return value;
    if (typeof value === "string") {
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? value : parsed;
    }
    return value;
}

function parseJsonIfNeeded(value) {
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function bufferToFloatArray(value) {
    if (!Buffer.isBuffer(value)) return value;
    const view = new Float32Array(value.buffer, value.byteOffset, value.byteLength / 4);
    return Array.from(view);
}

function normalizeRow(table, row) {
    const out = { ...row };

    if (out.createdAt !== undefined) {
        out.createdAt = toTimestamp(out.createdAt);
    }

    if (JSON_FIELDS[table]) {
        for (const field of JSON_FIELDS[table]) {
            if (field in out) {
                out[field] = parseJsonIfNeeded(out[field]);
            }
        }
    }

    if (BOOLEAN_FIELDS[table]) {
        for (const field of BOOLEAN_FIELDS[table]) {
            if (field in out) {
                const value = out[field];
                out[field] = value === true || value === 1 || value === "1";
            }
        }
    }

    if (EMBEDDING_FIELDS[table]) {
        for (const field of EMBEDDING_FIELDS[table]) {
            if (field in out) {
                out[field] = bufferToFloatArray(out[field]);
            }
        }
    }

    if (table === "knowledge" && out.embedding && ArrayBuffer.isView(out.embedding)) {
        out.embedding = Array.from(out.embedding);
    }

    if (table === "user_subscriptions") {
        if (out.updatedAt !== undefined) out.updatedAt = toTimestamp(out.updatedAt);
        if (out.currentPeriodStart !== undefined) out.currentPeriodStart = toTimestamp(out.currentPeriodStart);
        if (out.currentPeriodEnd !== undefined) out.currentPeriodEnd = toTimestamp(out.currentPeriodEnd);
    }

    if (table === "token_usage" && out.timestamp !== undefined) {
        out.timestamp = Number(out.timestamp);
    }

    return out;
}

function buildUpsertFilter(table, row) {
    if (row.id !== undefined && row.id !== null) {
        return { id: row.id };
    }

    const keyFields = UPSERT_KEYS[table];
    if (!keyFields) return null;

    const filter = {};
    for (const key of keyFields) {
        if (row[key] === undefined || row[key] === null) {
            return null;
        }
        filter[key] = row[key];
    }

    return filter;
}

function getTables(sqlite, requestedTables) {
    const discovered = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((row) => row.name)
        .filter((name) => typeof name === "string")
        .sort();

    if (!requestedTables || requestedTables.length === 0) {
        return discovered;
    }

    const discoveredSet = new Set(discovered);
    const missing = requestedTables.filter((table) => !discoveredSet.has(table));
    if (missing.length > 0) {
        throw new Error(`Requested tables not found in SQLite: ${missing.join(", ")}`);
    }

    return requestedTables;
}

function createEmptyEmbeddingSummary(table) {
    const fields = EMBEDDING_FIELDS[table] || [];
    const summary = {};
    for (const field of fields) {
        summary[field] = {
            rowsWithValue: 0,
            arrayRows: 0,
            emptyArrays: 0,
            observedLengths: [],
        };
    }
    return summary;
}

function updateEmbeddingSummary(summary, table, row) {
    const fields = EMBEDDING_FIELDS[table] || [];
    for (const field of fields) {
        if (!(field in row) || row[field] === undefined || row[field] === null) {
            continue;
        }

        summary[field].rowsWithValue += 1;
        if (Array.isArray(row[field])) {
            summary[field].arrayRows += 1;
            if (row[field].length === 0) {
                summary[field].emptyArrays += 1;
            } else {
                summary[field].observedLengths.push(row[field].length);
            }
        }
    }
}

function finalizeEmbeddingSummary(summary) {
    const finalized = {};
    for (const [field, stats] of Object.entries(summary)) {
        const uniqueLengths = [...new Set(stats.observedLengths)].sort((a, b) => a - b);
        finalized[field] = {
            rowsWithValue: stats.rowsWithValue,
            arrayRows: stats.arrayRows,
            emptyArrays: stats.emptyArrays,
            observedLengths: uniqueLengths,
            expectedLength: uniqueLengths.length === 1 ? uniqueLengths[0] : null,
        };
    }
    return finalized;
}

function summarizeFilter(filter) {
    if (!filter) return null;
    return { ...filter };
}

function summarizeSampleRow(table, row) {
    const filter = buildUpsertFilter(table, row);
    const embeddingSummary = {};

    for (const field of EMBEDDING_FIELDS[table] || []) {
        const value = row[field];
        embeddingSummary[field] = {
            exists: value !== undefined && value !== null,
            isArray: Array.isArray(value),
            length: Array.isArray(value) ? value.length : null,
        };
    }

    return {
        filter: summarizeFilter(filter),
        embeddingSummary,
    };
}

async function bulkUpsert(collection, rows) {
    if (rows.length === 0) {
        return {
            insertCandidates: 0,
            inserted: 0,
            upserted: 0,
            matched: 0,
            modified: 0,
        };
    }

    const ops = [];
    let insertCandidates = 0;

    for (const row of rows) {
        const filter = buildUpsertFilter(collection.collectionName, row);
        if (!filter) {
            ops.push({ insertOne: { document: row } });
            insertCandidates += 1;
            continue;
        }

        ops.push({
            updateOne: {
                filter,
                update: { $set: row },
                upsert: true,
            },
        });
    }

    const result = await collection.bulkWrite(ops, { ordered: false });
    return {
        insertCandidates,
        inserted: result.insertedCount || 0,
        upserted: result.upsertedCount || 0,
        matched: result.matchedCount || 0,
        modified: result.modifiedCount || 0,
    };
}

function buildSelectStatement(sqlite, table, limit) {
    if (limit > 0) {
        return {
            statement: sqlite.prepare(`SELECT * FROM "${table}" LIMIT ?`),
            iteratorArgs: [limit],
        };
    }

    return {
        statement: sqlite.prepare(`SELECT * FROM "${table}"`),
        iteratorArgs: [],
    };
}

async function inspectTargetCollections(db, tables) {
    const results = [];
    for (const table of tables) {
        const count = await db.collection(table).countDocuments({});
        results.push({ table, count });
    }
    return results;
}

function buildTargetInspectionSummary(targetCounts) {
    const nonEmpty = targetCounts.filter((row) => row.count > 0);
    return {
        totalCollections: targetCounts.length,
        collectionsWithData: nonEmpty.length,
        totalExistingDocuments: nonEmpty.reduce((sum, row) => sum + row.count, 0),
        nonEmpty,
    };
}

export async function migrateTable({
    sqlite,
    db,
    table,
    truncate,
    dryRun,
    batchSize,
    limit,
    sampleSize,
    verbose,
    logger,
}) {
    const collection = db.collection(table);
    const sqliteCount = sqlite.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c;
    const plannedRows = limit > 0 ? Math.min(sqliteCount, limit) : sqliteCount;
    const targetCountBefore = await collection.countDocuments({});
    const { statement, iteratorArgs } = buildSelectStatement(sqlite, table, limit);
    const embeddingSummary = createEmptyEmbeddingSummary(table);

    let processedRows = 0;
    let wouldUpsertRows = 0;
    let wouldInsertRows = 0;
    let deletedBeforeLoad = 0;
    let inserted = 0;
    let upserted = 0;
    let matched = 0;
    let modified = 0;
    const batch = [];
    const sampleRows = [];

    if (truncate && !dryRun && targetCountBefore > 0) {
        const deleteResult = await collection.deleteMany({});
        deletedBeforeLoad = deleteResult.deletedCount || 0;
    }

    for (const row of statement.iterate(...iteratorArgs)) {
        const normalized = normalizeRow(table, row);
        const filter = buildUpsertFilter(table, normalized);

        updateEmbeddingSummary(embeddingSummary, table, normalized);

        if (filter) {
            wouldUpsertRows += 1;
        } else {
            wouldInsertRows += 1;
        }

        if (sampleRows.length < sampleSize) {
            sampleRows.push(summarizeSampleRow(table, normalized));
        }

        batch.push(normalized);
        processedRows += 1;

        if (verbose && processedRows % batchSize === 0) {
            logger.verbose(`Processed ${processedRows}/${plannedRows} rows for ${table}`);
        }

        if (batch.length >= batchSize) {
            if (!dryRun) {
                const stats = await bulkUpsert(collection, batch);
                inserted += stats.inserted;
                upserted += stats.upserted;
                matched += stats.matched;
                modified += stats.modified;
            }
            batch.length = 0;
        }
    }

    if (batch.length > 0 && !dryRun) {
        const stats = await bulkUpsert(collection, batch);
        inserted += stats.inserted;
        upserted += stats.upserted;
        matched += stats.matched;
        modified += stats.modified;
    }

    const targetCountExpected = dryRun
        ? null
        : (truncate ? 0 : targetCountBefore) + inserted + upserted;

    return {
        table,
        sqliteCount,
        plannedRows,
        processedRows,
        targetCountBefore,
        targetCountExpected,
        targetCountAfter: null,
        truncateApplied: truncate && !dryRun,
        deletedBeforeLoad,
        wouldUpsertRows,
        wouldInsertRows,
        inserted,
        upserted,
        matched,
        modified,
        embeddingSummary: finalizeEmbeddingSummary(embeddingSummary),
        sampleRows,
    };
}

async function runVerification({
    db,
    tableResult,
    dryRun,
    verifyCounts,
    sampleSize,
}) {
    const collection = db.collection(tableResult.table);
    const verification = {
        table: tableResult.table,
        countCheck: {
            status: "SKIP",
            sqliteRows: tableResult.sqliteCount,
            plannedRows: tableResult.plannedRows,
            targetBefore: tableResult.targetCountBefore,
            targetExpected: tableResult.targetCountExpected,
            targetActual: null,
            message: dryRun
                ? "Dry-run mode performs zero writes, so post-write count verification is skipped."
                : "Count verification disabled.",
        },
        sampleCheck: {
            status: sampleSize > 0 && !dryRun ? "PASS" : "SKIP",
            checked: 0,
            matched: 0,
            skipped: 0,
            mismatches: [],
        },
        embeddingCheck: {
            status: "SKIP",
            fields: {},
            mismatches: [],
        },
    };

    if (!dryRun && verifyCounts) {
        const targetActual = await collection.countDocuments({});
        tableResult.targetCountAfter = targetActual;
        verification.countCheck.targetActual = targetActual;
        if (targetActual === tableResult.targetCountExpected) {
            verification.countCheck.status = "PASS";
            verification.countCheck.message = `Expected ${tableResult.targetCountExpected} documents and found ${targetActual}.`;
        } else {
            verification.countCheck.status = "FAIL";
            verification.countCheck.message = `Expected ${tableResult.targetCountExpected} documents but found ${targetActual}.`;
        }
    }

    if (!dryRun && sampleSize > 0 && tableResult.sampleRows.length > 0) {
        const embeddingFieldStatuses = {};
        let embeddingFailure = false;

        for (const [field, stats] of Object.entries(tableResult.embeddingSummary)) {
            embeddingFieldStatuses[field] = {
                sourceRowsWithValue: stats.rowsWithValue,
                expectedLength: stats.expectedLength,
                sampledRowsWithArrays: 0,
            };
        }

        for (const sample of tableResult.sampleRows) {
            if (!sample.filter) {
                verification.sampleCheck.skipped += 1;
                continue;
            }

            verification.sampleCheck.checked += 1;
            const doc = await collection.findOne(sample.filter, { projection: { _id: 0 } });
            if (!doc) {
                verification.sampleCheck.mismatches.push({
                    filter: sample.filter,
                    reason: "Target document not found",
                });
                verification.sampleCheck.status = "FAIL";
                continue;
            }

            verification.sampleCheck.matched += 1;

            for (const [field, fieldSample] of Object.entries(sample.embeddingSummary)) {
                if (!fieldSample.exists) {
                    continue;
                }

                const targetValue = doc[field];
                const targetIsArray = Array.isArray(targetValue);
                const targetLength = targetIsArray ? targetValue.length : null;
                if (targetIsArray) {
                    embeddingFieldStatuses[field].sampledRowsWithArrays += 1;
                }

                if (!targetIsArray) {
                    embeddingFailure = true;
                    verification.embeddingCheck.mismatches.push({
                        filter: sample.filter,
                        field,
                        reason: "Target embedding is missing or not an array",
                    });
                    continue;
                }

                if (fieldSample.length !== null && targetLength !== fieldSample.length) {
                    embeddingFailure = true;
                    verification.embeddingCheck.mismatches.push({
                        filter: sample.filter,
                        field,
                        reason: `Expected length ${fieldSample.length} but found ${targetLength}`,
                    });
                }
            }
        }

        if (verification.sampleCheck.checked === 0 && verification.sampleCheck.skipped > 0) {
            verification.sampleCheck.status = "SKIP";
        }

        verification.embeddingCheck.fields = embeddingFieldStatuses;
        if (Object.keys(embeddingFieldStatuses).length === 0) {
            verification.embeddingCheck.status = "SKIP";
        } else if (embeddingFailure) {
            verification.embeddingCheck.status = "FAIL";
        } else {
            verification.embeddingCheck.status = "PASS";
        }
    }

    return verification;
}

function summarizeVerificationStatus(tableVerification) {
    return [
        tableVerification.countCheck.status,
        tableVerification.sampleCheck.status,
        tableVerification.embeddingCheck.status,
    ].includes("FAIL")
        ? "FAIL"
        : [
              tableVerification.countCheck.status,
              tableVerification.sampleCheck.status,
              tableVerification.embeddingCheck.status,
          ].includes("PASS")
        ? "PASS"
        : "SKIP";
}

function printResolvedPlan(options, logger) {
    logger.info(`Source SQLite: ${options.source}`);
    logger.info(`Target: ${TARGET_LABEL}`);
    logger.info(`Connection: ${redactConnectionString(options.connection)}`);
    logger.info(`Database: ${options.database}`);
    logger.info(`Tables: ${options.tables?.join(", ") || "all"}`);
    logger.info(`Dry run: ${options.dryRun}`);
    logger.info(`Truncate: ${options.truncate}`);
    logger.info(
        `TLS: ${typeof options.tls === "boolean" ? options.tls : "driver/URI default"}`
    );
    logger.info(`CA file: ${options.caFile || "not set"}`);
    logger.info(`Verify counts: ${options.verifyCounts}`);
    logger.info(`Batch size: ${options.batchSize}`);
    logger.info(`Per-table limit: ${options.limit > 0 ? options.limit : "unlimited"}`);
    logger.info(`Spot-check sample size: ${options.sampleSize}`);
}

function printTargetWarnings(targetSummary, options, logger) {
    if (targetSummary.collectionsWithData === 0) {
        logger.info("Target database appears empty for the selected collections.");
        return;
    }

    const formatted = targetSummary.nonEmpty
        .map((row) => `${row.table}=${row.count}`)
        .join(", ");
    logger.warn(
        `Target database already contains data in ${targetSummary.collectionsWithData} collection(s): ${formatted}`
    );

    if (options.truncate && !options.dryRun) {
        logger.warn(
            "--truncate is enabled. Existing target collection contents will be deleted before loading source data."
        );
    } else if (options.dryRun) {
        logger.warn(
            "Dry-run mode will not modify the target. This run only reports what WOULD happen against the existing target state."
        );
    } else {
        logger.warn(
            "Migration will run without --truncate. Existing collections will be updated/upserted in place."
        );
    }
}

function printTableResult(tableResult, options, logger) {
    if (options.dryRun) {
        logger.table(
            `${tableResult.table}: sourceRows=${tableResult.sqliteCount}, plannedRows=${tableResult.plannedRows}, targetBefore=${tableResult.targetCountBefore}, wouldUpsert=${tableResult.wouldUpsertRows}, wouldInsert=${tableResult.wouldInsertRows}${options.truncate ? `, wouldDelete=${tableResult.targetCountBefore}` : ""}`
        );
        return;
    }

    logger.table(
        `${tableResult.table}: sourceRows=${tableResult.sqliteCount}, plannedRows=${tableResult.plannedRows}, targetBefore=${tableResult.targetCountBefore}, inserted=${tableResult.inserted}, upserted=${tableResult.upserted}, matched=${tableResult.matched}, modified=${tableResult.modified}, expectedAfter=${tableResult.targetCountExpected}`
    );
}

function printVerificationResult(tableVerification, logger) {
    const overall = summarizeVerificationStatus(tableVerification);
    logger.table(
        `${tableVerification.table}: ${overall} | count=${tableVerification.countCheck.status} | sample=${tableVerification.sampleCheck.status} | embedding=${tableVerification.embeddingCheck.status}`
    );
    if (tableVerification.countCheck.message) {
        logger.verbose?.(tableVerification.countCheck.message);
    }
}

function buildReport(options, targetSummary, tableResults, verificationResults, startedAt, endedAt) {
    const verificationOk = verificationResults.every(
        (row) => summarizeVerificationStatus(row) !== "FAIL"
    );

    return {
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime(),
        targetLabel: TARGET_LABEL,
        mode: options.dryRun ? "dry-run" : "migrate",
        config: {
            source: options.source,
            database: options.database,
            tables: options.tables || [],
            dryRun: options.dryRun,
            truncate: options.truncate,
            tls: typeof options.tls === "boolean" ? options.tls : null,
            caFile: options.caFile || null,
            batchSize: options.batchSize,
            limit: options.limit,
            sampleSize: options.sampleSize,
            verifyCounts: options.verifyCounts,
            verbose: options.verbose,
        },
        targetInspection: targetSummary,
        totals: {
            tables: tableResults.length,
            sqliteRows: tableResults.reduce((sum, row) => sum + row.sqliteCount, 0),
            plannedRows: tableResults.reduce((sum, row) => sum + row.plannedRows, 0),
            processedRows: tableResults.reduce((sum, row) => sum + row.processedRows, 0),
            inserted: tableResults.reduce((sum, row) => sum + row.inserted, 0),
            upserted: tableResults.reduce((sum, row) => sum + row.upserted, 0),
            matched: tableResults.reduce((sum, row) => sum + row.matched, 0),
            modified: tableResults.reduce((sum, row) => sum + row.modified, 0),
        },
        tableResults: tableResults.map((row) => ({
            table: row.table,
            sqliteCount: row.sqliteCount,
            plannedRows: row.plannedRows,
            processedRows: row.processedRows,
            targetCountBefore: row.targetCountBefore,
            targetCountExpected: row.targetCountExpected,
            targetCountAfter: row.targetCountAfter,
            truncateApplied: row.truncateApplied,
            deletedBeforeLoad: row.deletedBeforeLoad,
            wouldUpsertRows: row.wouldUpsertRows,
            wouldInsertRows: row.wouldInsertRows,
            inserted: row.inserted,
            upserted: row.upserted,
            matched: row.matched,
            modified: row.modified,
            embeddingSummary: row.embeddingSummary,
        })),
        verification: verificationResults,
        verificationOk,
    };
}

function maybeWriteReport(reportFile, report, logger) {
    if (!reportFile) return;
    const absoluteReportPath = path.resolve(process.cwd(), reportFile);
    fs.mkdirSync(path.dirname(absoluteReportPath), { recursive: true });
    fs.writeFileSync(absoluteReportPath, JSON.stringify(report, null, 2));
    logger.info(`Report saved: ${absoluteReportPath}`);
}

export async function main() {
    loadEnvFile(path.resolve(process.cwd(), ".env"));
    loadEnvFile(path.resolve(process.cwd(), ".env.local"));

    const rawOptions = parseArgs(process.argv.slice(2));
    const options = resolveOptions(rawOptions);
    const logger = createLogger(options.verbose);
    const startedAt = new Date();

    logger.step("1/6", "Resolved migration plan");
    printResolvedPlan(options, logger);

    const sqlite = new Database(options.source, { readonly: true });
    const mongoClientOptions = {
        maxPoolSize: DEFAULT_MAX_POOL_SIZE,
        connectTimeoutMS: DEFAULT_CONNECT_TIMEOUT_MS,
        socketTimeoutMS: DEFAULT_SOCKET_TIMEOUT_MS,
    };

    if (typeof options.tls === "boolean") {
        mongoClientOptions.tls = options.tls;
    }

    if (options.caFile) {
        mongoClientOptions.tlsCAFile = options.caFile;
    }

    const mongo = new MongoClient(options.connection, mongoClientOptions);

    let report;

    try {
        logger.step("2/6", `Connecting to ${TARGET_LABEL}`);
        try {
            await mongo.connect();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(
                `Failed to connect to ${TARGET_LABEL}. Check --connection, target reachability, and any required TLS/CA settings. Original error: ${message}`
            );
        }
        const db = mongo.db(options.database);
        logger.info(`Connected to database '${options.database}'.`);

        logger.step("3/6", "Reading SQLite tables and inspecting target state");
        const tables = getTables(sqlite, options.tables);
        logger.info(`Selected ${tables.length} table(s) from the SQLite source.`);
        const targetCounts = await inspectTargetCollections(db, tables);
        const targetSummary = buildTargetInspectionSummary(targetCounts);
        printTargetWarnings(targetSummary, options, logger);

        logger.step("4/6", options.dryRun ? "Planning per-table operations (zero writes)" : "Processing tables");
        const tableResults = [];
        for (const table of tables) {
            logger.verbose(`Starting table ${table}`);
            const result = await migrateTable({
                sqlite,
                db,
                table,
                truncate: options.truncate,
                dryRun: options.dryRun,
                batchSize: options.batchSize,
                limit: options.limit,
                sampleSize: options.sampleSize,
                verbose: options.verbose,
                logger,
            });
            tableResults.push(result);
            printTableResult(result, options, logger);
        }

        logger.step("5/6", "Running verification");
        const verificationResults = [];
        for (const tableResult of tableResults) {
            const verification = await runVerification({
                db,
                tableResult,
                dryRun: options.dryRun,
                verifyCounts: options.verifyCounts,
                sampleSize: options.sampleSize,
            });
            verificationResults.push(verification);
            printVerificationResult(verification, logger);
        }

        const endedAt = new Date();
        report = buildReport(
            options,
            targetSummary,
            tableResults,
            verificationResults,
            startedAt,
            endedAt
        );

        logger.step("6/6", "Final status");
        logger.info(
            `${options.dryRun ? "Dry-run complete" : "Migration complete"}. Tables=${report.totals.tables}, plannedRows=${report.totals.plannedRows}, processedRows=${report.totals.processedRows}`
        );
        logger.info(`Verification overall: ${report.verificationOk ? "PASS" : "FAIL"}`);

        maybeWriteReport(options.reportFile, report, logger);

        if (!options.dryRun && options.verifyCounts && !report.verificationOk) {
            process.exitCode = 2;
        }
    } finally {
        sqlite.close();
        await mongo.close();
    }
}

function isDirectExecution() {
    const entryPath = process.argv[1];
    if (!entryPath) {
        return false;
    }

    return import.meta.url === pathToFileURL(path.resolve(entryPath)).href;
}

if (isDirectExecution()) {
    main().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Migration failed: ${message}`);
        if ((process.argv.includes("--verbose") || parseBoolean(process.env.MIGRATE_VERBOSE, false)) && error?.stack) {
            console.error(error.stack);
        }
        process.exit(1);
    });
}
