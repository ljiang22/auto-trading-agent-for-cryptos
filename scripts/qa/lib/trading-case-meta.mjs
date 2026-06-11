/**
 * Shared case titles and latency phase metadata for trading-prod analysis.
 */

import { getCatalogEntries } from "../../../tests/agent-harness/suites/trading-prod/trading-prod-catalog.mjs";

/** @type {Array<{ key: string, label: string, shortLabel: string, description: string, color: string, chartKey?: string }>} */
export const PHASE_DEFINITIONS = [
    {
        key: "durationMs",
        label: "Total duration",
        shortLabel: "Total",
        description:
            "Full harness wall-clock time for the case, from message send to stream end.",
        color: "#5f6368",
    },
    {
        key: "messageToApprovalPromptMs",
        label: "Pre-approval",
        shortLabel: "Pre-approval",
        description:
            "SSE time from message start until the approval dialog or parameter review step appears (planning, risk check, NL→compose).",
        color: "#4285f4",
        chartKey: "messageToApprovalPromptMs",
    },
    {
        key: "approvalSubmitApiMs",
        label: "Approval API",
        shortLabel: "Approval API",
        description:
            "Wall-clock duration of the harness approval HTTP call (cex_approval / human_input_approval).",
        color: "#34a853",
        chartKey: "approvalSubmitApiMs",
    },
    {
        key: "approvalSubmitToFinalResponseMs",
        label: "Post-approval",
        shortLabel: "Post-approval",
        description:
            "Time from approval submit completion until the final assistant response (execution + remaining stream).",
        color: "#fbbc04",
        chartKey: "approvalSubmitToFinalResponseMs",
    },
    {
        key: "actionExecutionMs",
        label: "Action execution",
        shortLabel: "Action",
        description:
            "Duration of the cex_workflow_execute_action / trading_execute_action SSE step.",
        color: "#a142f4",
        chartKey: "actionExecutionMs",
    },
    {
        key: "venueCallMaxMs",
        label: "Venue max",
        shortLabel: "Venue max",
        description:
            "Slowest single venue_call latency from CloudWatch [Trading] audit events.",
        color: "#ea4335",
        chartKey: "venueCallMaxMs",
    },
];

/** Phases shown in charts and per-case latency columns (excludes total). */
export const TABLE_PHASE_DEFINITIONS = PHASE_DEFINITIONS.filter(
    (p) => p.key !== "durationMs",
);

/**
 * @returns {Map<string, { title: string, section: string }>}
 */
export function buildCaseTitleMap() {
    const map = new Map();
    for (const entry of getCatalogEntries()) {
        if (entry.id && entry.title) {
            map.set(String(entry.id), {
                title: entry.title,
                section: entry.section ?? "",
            });
        }
    }
    return map;
}

/**
 * @param {string} id
 * @param {Map<string, { title: string, section: string }>} [titleMap]
 */
export function resolveCaseTitle(id, titleMap) {
    const fromCatalog = titleMap?.get(String(id));
    if (fromCatalog?.title) {
        return fromCatalog;
    }
    return {
        title: formatCaseIdHeuristic(id),
        section: "",
    };
}

/**
 * @param {string} id
 */
export function formatCaseIdHeuristic(id) {
    const raw = String(id);
    const parts = raw.split("-");
    const prefix = parts[0];
    const rest = parts.slice(1).join(" ");

    const prefixLabels = {
        spot: "Spot",
        margin: "Margin",
        ro: "Read-only",
        preview: "Preview",
        amend: "Amend",
        cancel: "Cancel",
        risk: "Risk",
    };

    const label = prefixLabels[prefix] ?? prefix;
    const body = rest
        .replace(/_/g, " ")
        .replace(/\b(gtc|gtd|fok|ioc|oco|sor|l1)\b/gi, (m) => m.toUpperCase())
        .replace(/\b\w/g, (c) => c.toUpperCase());

    if (!body) {
        return label;
    }
    return `${label} · ${body}`;
}

/**
 * @param {number | null | undefined} value
 * @param {{ empty?: string }} [opts]
 */
export function formatMs(value, opts = {}) {
    const empty = opts.empty ?? "-";
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return empty;
    }
    if (value >= 10_000) {
        return `${(value / 1000).toFixed(1)}s`;
    }
    if (value >= 1000) {
        return `${(value / 1000).toFixed(1)}s`;
    }
    return `${Math.round(value)} ms`;
}

/**
 * @param {object} c
 */
export function getCaseLatencyValues(c) {
    return {
        preApproval: c.latencyPhases?.messageToApprovalPromptMs,
        approvalApi: c.latencyPhases?.approvalSubmitApiMs,
        postApproval: c.latencyPhases?.approvalSubmitToFinalResponseMs,
        actionExec: c.latencyPhases?.actionExecutionMs,
        venueMax: c.venueCallMaxMs,
    };
}

/**
 * Build inline stacked-bar segments for a case row.
 * @param {object} c
 */
export function buildLatencyBarSegments(c) {
    const values = getCaseLatencyValues(c);
    const segments = [
        { key: "preApproval", ms: values.preApproval, color: "#4285f4" },
        { key: "approvalApi", ms: values.approvalApi, color: "#34a853" },
        { key: "postApproval", ms: values.postApproval, color: "#fbbc04" },
        { key: "actionExec", ms: values.actionExec, color: "#a142f4" },
        { key: "venueMax", ms: values.venueMax, color: "#ea4335" },
    ].filter((s) => typeof s.ms === "number" && s.ms > 0);

    const total = segments.reduce((sum, s) => sum + s.ms, 0);
    if (total === 0) {
        return null;
    }
    return segments.map((s) => ({
        ...s,
        pct: (s.ms / total) * 100,
    }));
}
