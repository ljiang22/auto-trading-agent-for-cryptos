#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * §6.7 — Replay a trading request's full audit trail by `request_id`.
 *
 * Joins `risk_decisions`, `approval_decisions`, `pending_orders_ledger`,
 * `venue_calls`, and `shadow_decisions` on `request_id` (or
 * `client_order_id` where applicable). Streams a chronological timeline to
 * stdout (Markdown by default; `--json` for machine-readable).
 *
 * Usage:
 *   node scripts/qa/replay-request.mjs --request-id <id> [--json]
 *
 * Env:
 *   DOCUMENTDB_CONNECTION_STRING / MONGODB_CONNECTION_STRING
 *   DOCUMENTDB_DATABASE / MONGODB_DATABASE
 */

import { MongoClient } from "mongodb";
import process from "node:process";

const argv = parseArgs(process.argv.slice(2));
if (!argv.requestId) {
    console.error("usage: replay-request.mjs --request-id <id> [--json] [--client-order-id <id>]");
    process.exit(2);
}

const uri =
    process.env.DOCUMENTDB_CONNECTION_STRING ??
    process.env.MONGODB_CONNECTION_STRING;
const dbName =
    process.env.DOCUMENTDB_DATABASE ??
    process.env.MONGODB_DATABASE ??
    "senti-agent-prod";
if (!uri) {
    console.error("DOCUMENTDB_CONNECTION_STRING or MONGODB_CONNECTION_STRING must be set");
    process.exit(2);
}

const t0 = Date.now();
const client = new MongoClient(uri);
await client.connect();
const db = client.db(dbName);

const requestId = argv.requestId;
const clientOrderId = argv.clientOrderId ?? null;

const [risk, approvals, ledger, venueCalls, shadow] = await Promise.all([
    db.collection("risk_decisions").find({ request_id: requestId }).toArray(),
    db.collection("approval_decisions").find({ request_id: requestId }).toArray(),
    db
        .collection("pending_orders_ledger")
        .find(
            clientOrderId
                ? { $or: [{ request_id: requestId }, { client_order_id: clientOrderId }] }
                : { request_id: requestId },
        )
        .toArray(),
    db
        .collection("venue_calls")
        .find(
            clientOrderId
                ? { $or: [{ request_id: requestId }, { client_order_id: clientOrderId }] }
                : { request_id: requestId },
        )
        .toArray(),
    db.collection("shadow_decisions").find({ request_id: requestId }).toArray(),
]);

const events = [
    ...risk.map((r) => ({ kind: "risk_decision", at: r.createdAt, payload: r })),
    ...approvals.map((a) => ({ kind: `approval_lvl${a.level}`, at: a.createdAt, payload: a })),
    ...ledger.map((l) => ({
        kind: `ledger_${l.state}`,
        at: l.submittedAt ?? l.lastSeenAt,
        payload: l,
    })),
    ...venueCalls.map((v) => ({
        kind: `venue_${v.outcome ?? "call"}`,
        at: v.createdAt,
        payload: v,
    })),
    ...shadow.map((s) => ({ kind: "shadow_decision", at: s.createdAt, payload: s })),
].sort(byTime);

const elapsedMs = Date.now() - t0;

if (argv.json) {
    console.log(
        JSON.stringify(
            { request_id: requestId, client_order_id: clientOrderId, events, elapsedMs },
            null,
            2,
        ),
    );
} else {
    renderMarkdown({ requestId, clientOrderId, events, elapsedMs });
}

await client.close();
process.exit(0);

// ---------------------------------------------------------------------------
function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--request-id" || a === "-r") {
            out.requestId = argv[++i];
        } else if (a === "--client-order-id" || a === "-c") {
            out.clientOrderId = argv[++i];
        } else if (a === "--json") {
            out.json = true;
        }
    }
    return out;
}

function byTime(a, b) {
    const ta = new Date(a.at ?? 0).getTime();
    const tb = new Date(b.at ?? 0).getTime();
    return ta - tb;
}

function renderMarkdown({ requestId, clientOrderId, events, elapsedMs }) {
    console.log(`# Replay — request_id=${requestId}`);
    if (clientOrderId) console.log(`client_order_id=${clientOrderId}`);
    console.log(`Joined ${events.length} events in ${elapsedMs}ms`);
    console.log();
    if (events.length === 0) {
        console.log("_no events found — check connection string, DB name, and request_id_");
        return;
    }
    for (const e of events) {
        const tstr = new Date(e.at).toISOString();
        console.log(`## ${tstr} — \`${e.kind}\``);
        const summary = summarize(e);
        if (summary) console.log(summary);
        console.log("```json");
        console.log(JSON.stringify(redact(e.payload), null, 2));
        console.log("```");
        console.log();
    }
}

function summarize(e) {
    const p = e.payload;
    if (e.kind === "risk_decision") {
        return `**verdict=${p.decision}**, rules_fired=[${(p.rules_fired ?? []).join(", ")}]`;
    }
    if (e.kind.startsWith("approval_lvl")) {
        return `**${p.decision}** (level=${p.level})`;
    }
    if (e.kind.startsWith("ledger_")) {
        return `state=${p.state}, venue=${p.venue}, symbol=${p.symbol}, client_order_id=\`${p.client_order_id}\``;
    }
    if (e.kind.startsWith("venue_")) {
        return `${p.method} ${p.endpoint} → http=${p.http_status} latency=${p.latency_ms}ms outcome=${p.outcome ?? "?"}`;
    }
    if (e.kind === "shadow_decision") {
        return `strategy=${p.strategy_id ?? "?"}, mode=${p.mode ?? "?"}`;
    }
    return "";
}

function redact(obj, depth = 0) {
    if (depth > 5) return "<truncated>";
    if (obj === null || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map((v) => redact(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        const lk = k.toLowerCase();
        if (
            lk === "apikey" ||
            lk === "api_key" ||
            lk === "apisecret" ||
            lk === "api_secret" ||
            lk === "signature" ||
            lk === "private_key" ||
            lk === "privatekey" ||
            lk === "passphrase" ||
            lk === "token"
        ) {
            out[k] = "<redacted>";
            continue;
        }
        out[k] = redact(v, depth + 1);
    }
    return out;
}
