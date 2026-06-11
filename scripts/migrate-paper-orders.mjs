#!/usr/bin/env node
/**
 * Plan §6 — `paper_orders` / `paper_fills` schema migration helper.
 *
 * Two responsibilities:
 *
 *   1. Ensure the production indexes match the spec the agent code
 *      relies on (unique `(userId, order_id)`, `(userId, status)`, TTL
 *      on `ttl_at`). If a deploy ran before PR #212 the rows exist but
 *      the TTL never purges them.
 *   2. Backfill `ttl_at` on legacy rows that have a `created_at` or
 *      `filled_at` but no `ttl_at` field (default horizon =
 *      PAPER_ORDER_TTL_SECONDS, falls back to 24 h). Without this the
 *      TTL index won't prune the legacy backlog.
 *
 * Read-only by default (`--check`); mutates with `--apply`. The MongoDB
 * connection string and database name come from the same env vars the
 * adapter consumes:
 *
 *   - `DOCUMENTDB_CONNECTION_STRING` (preferred) or
 *     `MONGODB_CONNECTION_STRING`
 *   - `DOCUMENTDB_DATABASE` or `MONGODB_DATABASE`
 *   - `DOCUMENTDB_CA_FILE` for the TLS CA bundle (when targeting prod)
 *   - `PAPER_ORDER_TTL_SECONDS` (default 86400)
 *
 * Exit codes: 0 success, 1 usage / config error, 2 mutation failure.
 */
import process from "node:process";
import { MongoClient } from "mongodb";

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const VERBOSE = args.has("--verbose");

const CONNECTION_STRING =
    process.env.DOCUMENTDB_CONNECTION_STRING ||
    process.env.MONGODB_CONNECTION_STRING;
const DATABASE = process.env.DOCUMENTDB_DATABASE || process.env.MONGODB_DATABASE;
const CA_FILE = process.env.DOCUMENTDB_CA_FILE;
const TTL_SECONDS = Number(process.env.PAPER_ORDER_TTL_SECONDS ?? "86400");

function fail(msg, code = 1) {
    console.error(`[migrate-paper-orders] ${msg}`);
    process.exit(code);
}

if (!CONNECTION_STRING) fail("DOCUMENTDB_CONNECTION_STRING / MONGODB_CONNECTION_STRING required");
if (!DATABASE) fail("DOCUMENTDB_DATABASE / MONGODB_DATABASE required");
if (!Number.isFinite(TTL_SECONDS) || TTL_SECONDS <= 0) {
    fail(`PAPER_ORDER_TTL_SECONDS must be a positive integer, got ${TTL_SECONDS}`);
}

const SPEC_INDEXES = {
    paper_orders: [
        { name: "userId_1_order_id_1", key: { userId: 1, order_id: 1 }, options: { unique: true } },
        { name: "userId_1_status_1", key: { userId: 1, status: 1 }, options: {} },
        { name: "ttl_at_1", key: { ttl_at: 1 }, options: { expireAfterSeconds: 0 } },
    ],
    paper_fills: [
        { name: "userId_1_order_id_1", key: { userId: 1, order_id: 1 }, options: {} },
        { name: "ttl_at_1", key: { ttl_at: 1 }, options: { expireAfterSeconds: 0 } },
    ],
};

const clientOptions = CA_FILE ? { tls: true, tlsCAFile: CA_FILE } : undefined;
const client = new MongoClient(CONNECTION_STRING, clientOptions);

async function ensureIndexes(db, collectionName, want) {
    const coll = db.collection(collectionName);
    const existing = await coll.indexes();
    const existingByName = new Map(existing.map((idx) => [idx.name, idx]));
    const actions = [];

    for (const spec of want) {
        const found = existingByName.get(spec.name);
        if (!found) {
            actions.push({ kind: "create", spec });
            continue;
        }
        const keyMatches = JSON.stringify(found.key) === JSON.stringify(spec.key);
        const ttlMatches = spec.options.expireAfterSeconds === undefined
            ? found.expireAfterSeconds === undefined
            : found.expireAfterSeconds === 0;
        const uniqueMatches = Boolean(spec.options.unique) === Boolean(found.unique);
        if (!keyMatches || !ttlMatches || !uniqueMatches) {
            actions.push({ kind: "recreate", spec });
        }
    }

    for (const action of actions) {
        if (!APPLY) {
            console.log(`[plan] ${action.kind} ${collectionName}.${action.spec.name}`);
            continue;
        }
        if (action.kind === "recreate") {
            console.log(`[apply] dropping ${collectionName}.${action.spec.name} before recreate`);
            try {
                await coll.dropIndex(action.spec.name);
            } catch (err) {
                console.warn(`[apply] dropIndex skipped: ${String(err?.message ?? err)}`);
            }
        }
        await coll.createIndex(action.spec.key, { name: action.spec.name, ...action.spec.options });
        console.log(`[apply] ${action.kind} ${collectionName}.${action.spec.name} OK`);
    }

    return actions.length;
}

async function backfillTtl(db, collectionName) {
    const coll = db.collection(collectionName);
    const filter = { $or: [{ ttl_at: { $exists: false } }, { ttl_at: null }] };
    const count = await coll.countDocuments(filter);
    if (count === 0) {
        if (VERBOSE) console.log(`[backfill] ${collectionName}: no rows missing ttl_at`);
        return 0;
    }
    if (!APPLY) {
        console.log(`[plan] backfill ${count} ${collectionName} rows with ttl_at = now + ${TTL_SECONDS}s`);
        return count;
    }

    const cursor = coll.find(filter, { projection: { _id: 1, created_at: 1, filled_at: 1 } });
    let updated = 0;
    while (await cursor.hasNext()) {
        const row = await cursor.next();
        const anchorRaw = row?.filled_at ?? row?.created_at;
        const anchor = anchorRaw ? new Date(anchorRaw) : new Date();
        const ttlAt = new Date(anchor.getTime() + TTL_SECONDS * 1000);
        await coll.updateOne({ _id: row._id }, { $set: { ttl_at: ttlAt } });
        updated++;
    }
    console.log(`[apply] backfilled ttl_at on ${updated}/${count} ${collectionName} rows`);
    return updated;
}

async function main() {
    await client.connect();
    const db = client.db(DATABASE);
    console.log(`[migrate-paper-orders] target db=${DATABASE} mode=${APPLY ? "apply" : "check"} ttl=${TTL_SECONDS}s`);

    let totalIndexActions = 0;
    for (const [collectionName, want] of Object.entries(SPEC_INDEXES)) {
        totalIndexActions += await ensureIndexes(db, collectionName, want);
    }
    let totalBackfilled = 0;
    for (const collectionName of ["paper_orders", "paper_fills"]) {
        totalBackfilled += await backfillTtl(db, collectionName);
    }

    console.log(
        `[migrate-paper-orders] done. index_actions=${totalIndexActions} ttl_backfills=${totalBackfilled} apply=${APPLY}`,
    );
    if (!APPLY && totalIndexActions + totalBackfilled > 0) {
        console.log("[migrate-paper-orders] re-run with --apply to mutate.");
    }
}

main()
    .catch((err) => {
        console.error("[migrate-paper-orders] fatal:", err);
        process.exitCode = 2;
    })
    .finally(async () => {
        await client.close().catch(() => undefined);
    });
