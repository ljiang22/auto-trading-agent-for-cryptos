/**
 * Pre-write decorator: lift the `## Key Findings` (or equivalent) block out
 * of an agent-response body and attach it as `content.metadata.summary` on
 * the Memory before it lands in the database.
 *
 * Why this exists. On follow-up turns the context-builder pulls the last 5
 * memories into `{{recentMessages}}`. Long-form agent answers (especially
 * comprehensive analyses) carry 3–5 KB of prose that crowds the window,
 * inflates token cost, and degrades subsequent classifications. With
 * `metadata.summary` in place, the format-time substitution in
 * `formatMessages` swaps the full body for the 200-token summary on agent
 * turns only — user turns are unchanged.
 *
 * Idempotent: callers can wrap a memory more than once without duplication
 * (existing `metadata.summary` short-circuits). No-op when the body is empty
 * or the model didn't emit a summary section.
 */

import { elizaLogger } from "./logger.ts";
import { extractResponseSummary } from "./executiveSummaryFromMarkdown.ts";
import type { Content, Memory } from "../core/types.ts";

export type ResponseSummaryRoute =
    | "regular"
    | "task_chain"
    | "comprehensive"
    | "cex"
    | "cex_plan";

export interface AttachResponseSummaryOptions {
    /**
     * Route label used for the `[ResponseSummary]` telemetry line. Lets
     * CloudWatch metric filters track compression ratio per route and alarm
     * if a route stops emitting the summary section (ratio → 0).
     */
    route?: ResponseSummaryRoute;
    /**
     * Override the summary text directly. Used by the comprehensive route
     * where the executive-summary extractor already ran and we'd rather
     * not run the regex pipeline a second time.
     */
    summaryOverride?: string;
    /**
     * Max characters for the extracted summary. Defaults to the
     * extractor's own default (800).
     */
    maxChars?: number;
}

/**
 * Attach `content.metadata.summary` to a response Memory if a summary
 * section is present in the body. Returns a new Memory; the input is not
 * mutated.
 */
export function attachResponseSummary(
    memory: Memory,
    options: AttachResponseSummaryOptions = {},
): Memory {
    const existingMetadata = readMetadata(memory.content);
    if (typeof existingMetadata.summary === "string" && existingMetadata.summary.length > 0) {
        // Already attached upstream; do not overwrite.
        return memory;
    }

    const text = typeof memory.content?.text === "string" ? memory.content.text : "";
    if (!text) {
        return memory;
    }

    const trimmedOverride =
        typeof options.summaryOverride === "string"
            ? options.summaryOverride.trim()
            : "";
    const summary = trimmedOverride
        ? trimmedOverride
        : extractResponseSummary(text, options.maxChars);

    if (!summary) {
        // Telemetry: ratio = 0 — model didn't emit the section. Useful as an
        // alarm signal (a route that stops emitting summaries is a regression).
        if (options.route) {
            elizaLogger.info(
                `[ResponseSummary] route=${options.route} bytes_full=${text.length} bytes_summary=0 ratio=0.000`,
            );
        }
        return memory;
    }

    if (options.route) {
        const ratio = text.length > 0 ? summary.length / text.length : 0;
        elizaLogger.info(
            `[ResponseSummary] route=${options.route} bytes_full=${text.length} bytes_summary=${summary.length} ratio=${ratio.toFixed(3)}`,
        );
    }

    return {
        ...memory,
        content: {
            ...memory.content,
            metadata: {
                ...existingMetadata,
                summary,
            },
        },
    };
}

function readMetadata(content: Content | undefined): Record<string, unknown> {
    if (!content) return {};
    const raw = (content as { metadata?: unknown }).metadata;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        return raw as Record<string, unknown>;
    }
    return {};
}
