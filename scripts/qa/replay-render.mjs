/**
 * Pure rendering helpers for `replay-request.mjs`. Extracted so the
 * byte-stability DoD test in `__tests__/replay.test.mjs` can verify the
 * join + sort + render pipeline produces identical output for identical
 * inputs (a regression hook against any "shuffle" in the renderer).
 */

export function byTime(a, b) {
    const ta = new Date(a.at ?? 0).getTime();
    const tb = new Date(b.at ?? 0).getTime();
    if (ta !== tb) return ta - tb;
    // Stable tie-break to keep output byte-identical across runs.
    return String(a.kind).localeCompare(String(b.kind));
}

export function buildTimeline({ risk = [], approvals = [], ledger = [], venueCalls = [], shadow = [] } = {}) {
    return [
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
}

export function redact(payload) {
    const SENSITIVE = new Set([
        "apikey",
        "api_key",
        "apisecret",
        "api_secret",
        "signature",
        "authorization",
        "x-mbx-apikey",
        "cb-access-key",
        "cb-access-sign",
        "cb-access-passphrase",
        "passphrase",
        "token",
        "access_token",
        "refresh_token",
    ]);
    function walk(value, depth = 0) {
        if (depth > 8 || value === null || typeof value !== "object") return value;
        if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (SENSITIVE.has(k.toLowerCase())) {
                out[k] = "<redacted>";
                continue;
            }
            out[k] = walk(v, depth + 1);
        }
        return out;
    }
    return walk(payload);
}

export function summarize(e) {
    const p = e.payload;
    if (e.kind === "risk_decision") {
        return `**verdict=${p.decision}**, rules_fired=[${(p.rules_fired ?? []).join(", ")}]`;
    }
    if (e.kind?.startsWith?.("venue_")) {
        return `**${p.method ?? "?"} ${p.endpoint ?? "?"}** status=${p.http_status ?? "?"} latency=${p.latency_ms ?? "?"}ms`;
    }
    if (e.kind?.startsWith?.("ledger_")) {
        return `**state=${p.state}** venue=${p.venue} symbol=${p.symbol} client_order_id=${p.client_order_id}`;
    }
    return "";
}

export function renderMarkdown({ requestId, clientOrderId, events, elapsedMs = 0 }) {
    const lines = [];
    lines.push(`# Replay — request_id=${requestId}`);
    if (clientOrderId) lines.push(`client_order_id=${clientOrderId}`);
    lines.push(`Joined ${events.length} events in ${elapsedMs}ms`);
    lines.push("");
    if (events.length === 0) {
        lines.push("_no events found — check connection string, DB name, and request_id_");
        return lines.join("\n");
    }
    for (const e of events) {
        const tstr = new Date(e.at).toISOString();
        lines.push(`## ${tstr} — \`${e.kind}\``);
        const s = summarize(e);
        if (s) lines.push(s);
        lines.push("```json");
        lines.push(JSON.stringify(redact(e.payload), null, 2));
        lines.push("```");
        lines.push("");
    }
    return lines.join("\n");
}
