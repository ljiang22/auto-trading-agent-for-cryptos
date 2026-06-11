/**
 * Parse [Trading] JSON lines from CloudWatch log messages.
 */

const TRADING_PREFIX = "[Trading]";

/** Strip terminal ANSI color codes from ECS/Winston log lines. */
function stripAnsiEscapes(text) {
    return text.replace(/\u001b\[[0-9;]*m/g, "");
}

const RISK_DECISION_ALIASES = {
    block: "deny",
    deny: "deny",
    allow: "allow",
    downgrade_read_only: "downgrade_read_only",
};

/**
 * @param {string | null | undefined} decision
 * @returns {string | null}
 */
export function normalizeRiskDecision(decision) {
    if (!decision) {
        return null;
    }
    const normalized = String(decision).trim().toLowerCase();
    return RISK_DECISION_ALIASES[normalized] ?? normalized;
}

/**
 * @param {string | null | undefined} actual
 * @param {string | null | undefined} expected
 */
export function riskDecisionsMatch(actual, expected) {
    const a = normalizeRiskDecision(actual);
    const e = normalizeRiskDecision(expected);
    if (!a || !e) {
        return false;
    }
    return a === e || a.includes(e) || e.includes(a);
}

/**
 * @param {string} message
 * @returns {object | null}
 */
export function parseTradingLogLine(message) {
    if (!message || typeof message !== "string") {
        return null;
    }
    const cleaned = stripAnsiEscapes(message);
    const idx = cleaned.indexOf(TRADING_PREFIX);
    if (idx === -1) {
        return null;
    }
    const jsonPart = cleaned.slice(idx + TRADING_PREFIX.length).trim();
    const start = jsonPart.indexOf("{");
    const end = jsonPart.lastIndexOf("}");
    if (start === -1 || end <= start) {
        return null;
    }
    try {
        const parsed = JSON.parse(jsonPart.slice(start, end + 1));
        if (parsed && typeof parsed === "object") {
            return parsed;
        }
    } catch {
        return null;
    }
    return null;
}

/**
 * @param {object} event
 * @param {Set<string>} [requestIds]
 */
export function matchesRequestFilter(event, requestIds) {
    if (!requestIds || requestIds.size === 0) {
        return true;
    }
    const rid = event?.request_id || event?.requestId;
    if (!rid) {
        return true;
    }
    return requestIds.has(String(rid));
}

/**
 * Extract risk decision from trading events array.
 * @param {object[]} events
 */
export function extractRiskDecision(events) {
    const risk = events.find((e) => e.stage === "risk_check");
    if (!risk) {
        return null;
    }
    const d = risk.decision || risk.verdict;
    return normalizeRiskDecision(d);
}

/**
 * @param {object[]} events
 * @param {{ startedAtMs?: number, endedAtMs?: number, bufferBeforeMs?: number, bufferAfterMs?: number }} window
 */
export function filterEventsByTimeWindow(events, window) {
    const { startedAtMs, endedAtMs, bufferBeforeMs = 0, bufferAfterMs = 0 } = window;
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
        return [];
    }
    const start = startedAtMs - bufferBeforeMs;
    const end = endedAtMs + bufferAfterMs;
    return events.filter((ev) => {
        const ts = ev._cwTimestamp;
        return Number.isFinite(ts) && ts >= start && ts <= end;
    });
}

/**
 * @param {object[]} orphanEvents
 * @param {Map<string, object[]>} perCase
 * @param {object[]} summaries
 * @param {{ bufferBeforeMs?: number, bufferAfterMs?: number }} options
 */
export function assignOrphanEventsByTimestamp(
    orphanEvents,
    perCase,
    summaries,
    options = {},
) {
    const bufferBeforeMs = options.bufferBeforeMs ?? 30_000;
    const bufferAfterMs = options.bufferAfterMs ?? 60_000;
    for (const summary of summaries) {
        const caseId = String(summary.id);
        const existing = perCase.get(caseId) ?? [];
        if (existing.length > 0) {
            continue;
        }
        const startedAtMs = summary.startedAtMs;
        const endedAtMs = summary.endedAtMs ?? startedAtMs;
        if (!Number.isFinite(startedAtMs)) {
            continue;
        }
        const matched = filterEventsByTimeWindow(orphanEvents, {
            startedAtMs,
            endedAtMs,
            bufferBeforeMs,
            bufferAfterMs,
        });
        if (matched.length > 0) {
            perCase.set(caseId, matched);
        }
    }
}
