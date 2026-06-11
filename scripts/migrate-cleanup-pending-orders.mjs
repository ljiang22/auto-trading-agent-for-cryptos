#!/usr/bin/env node
/**
 * One-shot cleanup for the `pending_orders_ledger` collection.
 *
 * QA round-5 H4 finding: 52 stale rows that don't exist at Binance keep
 * polling and logging `code:-2013 "Order does not exist"` once per
 * reconciliation tick (every 5s = 720/hr/row). The rows were written
 * by earlier paper-on-live-ledger writes (paper-mode orders that hit
 * the real Binance ledger) and by orders that never reached the
 * venue (pre-flight failures). They will never resolve to a real
 * order, so the poller can only fail loudly.
 *
 * This script removes pending_orders_ledger rows that match BOTH:
 *   - state ∈ {submitted, unknown}              (non-terminal — still being polled)
 *   - submittedAt < now - --age-days            (older than the threshold)
 *   - AND (optional) latest_payload contains the -2013 error or empty
 *
 * Read-only by default (`--check`); mutates with `--apply`. Use
 * `--age-days N` to scope the operation (default 1 day).
 *
 * The deletion also fires a single `[Trading]` audit-style log line per
 * removed row so the cleanup is auditable.
 *
 * Connection env vars match the agent's MongoDB adapter:
 *   - DOCUMENTDB_CONNECTION_STRING (preferred) or MONGODB_CONNECTION_STRING
 *   - DOCUMENTDB_DATABASE or MONGODB_DATABASE
 *   - DOCUMENTDB_CA_FILE for the TLS CA bundle (when targeting prod)
 *
 * Exit codes: 0 success, 1 usage / config error, 2 mutation failure.
 */
import process from "node:process";
import { MongoClient } from "mongodb";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const VERBOSE = args.includes("--verbose");
const ALSO_PHANTOM_ONLY = args.includes("--only-phantom"); // restrict to rows
                                                            // that *prove* the
                                                            // order isn't at
                                                            // the venue (the
                                                            // poller wrote a
                                                            // -2013 footprint
                                                            // in latest_payload)
let AGE_DAYS = 1;
const ageIdx = args.indexOf("--age-days");
if (ageIdx !== -1 && args[ageIdx + 1]) {
    const parsed = Number.parseInt(args[ageIdx + 1], 10);
    if (Number.isFinite(parsed) && parsed > 0) AGE_DAYS = parsed;
}

const CONNECTION_STRING =
    process.env.DOCUMENTDB_CONNECTION_STRING ||
    process.env.MONGODB_CONNECTION_STRING;
const DATABASE = process.env.DOCUMENTDB_DATABASE || process.env.MONGODB_DATABASE;
const CA_FILE = process.env.DOCUMENTDB_CA_FILE;

function fail(msg, code = 1) {
    console.error(`[migrate-cleanup-pending-orders] ${msg}`);
    process.exit(code);
}

if (!CONNECTION_STRING)
    fail("DOCUMENTDB_CONNECTION_STRING / MONGODB_CONNECTION_STRING required");
if (!DATABASE) fail("DOCUMENTDB_DATABASE / MONGODB_DATABASE required");

const clientOptions = CA_FILE ? { tls: true, tlsCAFile: CA_FILE } : undefined;
const client = new MongoClient(CONNECTION_STRING, clientOptions);

function isoCutoff(daysAgo) {
    return new Date(Date.now() - daysAgo * 86400_000).toISOString();
}

async function findStale(db, cutoff) {
    const coll = db.collection("pending_orders_ledger");
    const baseFilter = {
        state: { $in: ["submitted", "unknown"] },
        submittedAt: { $lt: cutoff },
    };
    if (!ALSO_PHANTOM_ONLY) {
        return coll.find(baseFilter).toArray();
    }
    // Phantom-only: restrict to rows where the poller has *already*
    // recorded the venue's -2013 verdict in latest_payload (proves the
    // order isn't at the venue, vs. just stale).
    const phantomFilter = {
        ...baseFilter,
        $or: [
            { "latest_payload.code": -2013 },
            { "latest_payload.error": { $regex: /-2013|Order does not exist/i } },
            { "latest_payload.message": { $regex: /-2013|Order does not exist/i } },
        ],
    };
    return coll.find(phantomFilter).toArray();
}

async function main() {
    await client.connect();
    const db = client.db(DATABASE);
    const cutoff = isoCutoff(AGE_DAYS);
    console.log(
        `[migrate-cleanup-pending-orders] target db=${DATABASE} mode=${APPLY ? "apply" : "check"} age_days=${AGE_DAYS} cutoff=${cutoff} only_phantom=${ALSO_PHANTOM_ONLY}`,
    );

    const rows = await findStale(db, cutoff);
    console.log(
        `[migrate-cleanup-pending-orders] candidates=${rows.length}`,
    );
    if (rows.length === 0) {
        console.log(`[migrate-cleanup-pending-orders] nothing to clean — exit clean.`);
        return;
    }

    if (VERBOSE) {
        for (const r of rows.slice(0, 20)) {
            console.log(
                `  - client_order_id=${r.client_order_id} venue=${r.venue} symbol=${r.symbol} state=${r.state} submittedAt=${r.submittedAt}`,
            );
        }
        if (rows.length > 20) console.log(`  ... + ${rows.length - 20} more`);
    }

    if (!APPLY) {
        console.log(
            `[migrate-cleanup-pending-orders] dry-run — re-run with --apply to delete ${rows.length} rows.`,
        );
        return;
    }

    const coll = db.collection("pending_orders_ledger");
    // Mark each row as reconciliation_failed (terminal) BEFORE deletion so
    // any concurrent observer sees a consistent transition; then drop.
    const auditLog = [];
    for (const row of rows) {
        try {
            await coll.updateOne(
                { _id: row._id },
                {
                    $set: {
                        state: "reconciliation_failed",
                        lastSeenAt: new Date().toISOString(),
                        latest_payload: {
                            ...(row.latest_payload ?? {}),
                            cleanup_reason: "migrate-cleanup-pending-orders",
                            cleanup_age_days: AGE_DAYS,
                            cleanup_at: new Date().toISOString(),
                        },
                    },
                },
            );
            auditLog.push({
                client_order_id: row.client_order_id,
                venue: row.venue,
                symbol: row.symbol,
                prior_state: row.state,
            });
        } catch (err) {
            console.error(
                `[migrate-cleanup-pending-orders] mark-terminal failed for ${row.client_order_id}: ${String(err?.message ?? err)}`,
            );
        }
    }

    // Emit one structured log line per affected row so CW can confirm.
    for (const entry of auditLog) {
        console.log(
            `[Trading] ${JSON.stringify({ stage: "reconciliation_event", source: "manual_cleanup", ...entry, timestamp: new Date().toISOString() })}`,
        );
    }

    // Finally drop the rows. TTL would have eventually pruned them via
    // ttl_at, but only if ttl_at was populated — old rows from earlier
    // schema versions may lack it. Hard-delete is safer.
    const result = await coll.deleteMany({
        _id: { $in: rows.map((r) => r._id) },
    });
    console.log(
        `[migrate-cleanup-pending-orders] deleted=${result.deletedCount} (audited=${auditLog.length}) ✅`,
    );
}

main()
    .catch((err) => {
        console.error("[migrate-cleanup-pending-orders] fatal:", err);
        process.exitCode = 2;
    })
    .finally(async () => {
        await client.close().catch(() => undefined);
    });
