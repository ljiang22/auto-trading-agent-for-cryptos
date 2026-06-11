/**
 * Extract a response summary section from markdown.
 *
 * Two callers:
 *   1. The comprehensive-analysis pipeline, which renders a long report with a
 *      visible `### N. Executive Summary` heading. The original
 *      `extractExecutiveSummaryFromMarkdown(...)` API (4000-char cap) is kept
 *      as an alias for that route.
 *   2. The generic response-summary mechanism (regular / task chain / CEX),
 *      which asks the model to emit a short `## Key Findings` (or `## Summary`
 *      / `## TL;DR` / zh-CN equivalents) block at the bottom of the response.
 *      `extractResponseSummary(...)` (800-char cap by default) is the entry
 *      point for that route.
 *
 * Resolution order (same for both APIs):
 *   1. ATX heading match — `# … Key Findings` / `执行摘要` / etc.
 *      Takes the body until the next ATX heading.
 *   2. Bold pseudo-heading match — `**Key Findings**` paragraphs for runs
 *      where the model omitted ATX headings.
 *   3. Marker-block fallback — `<!-- KEY_FINDINGS_START -->…<!-- _END -->`
 *      or the historical `<!-- EXEC_SUMMARY_START -->…<!-- _END -->` block.
 *
 * The result is the *raw markdown* of the section body (cleaned of trailing
 * whitespace and the marker block if it appears inside). The caller is
 * expected to render it through MarkdownRenderer when displaying, or feed it
 * straight back into a prompt as compact context — both work.
 */

const EXEC_SUMMARY_DEFAULT_MAX_CHARS = 4000;
const RESPONSE_SUMMARY_DEFAULT_MAX_CHARS = 800;

const EXEC_SUMMARY_MARKER_RE =
    /<!--\s*EXEC_SUMMARY_START\s*-->([\s\S]*?)<!--\s*EXEC_SUMMARY_END\s*-->/i;

const KEY_FINDINGS_MARKER_RE =
    /<!--\s*KEY_FINDINGS_START\s*-->([\s\S]*?)<!--\s*KEY_FINDINGS_END\s*-->/i;

const EXECUTIVE_SUMMARY_SYNONYMS: readonly string[] = [
    "Executive\\s+Summary",
    "执行摘要",
    "执行总结",
    "概要",
];

/**
 * Broader set of heading synonyms used by the generic response-summary
 * extractor. Order matters only for readability — the synonyms are merged
 * into a single non-capturing alternation.
 *
 * `Key Findings` is the canonical heading we instruct each route's prompt
 * to emit. The remaining entries are resilience: if the model substitutes
 * `Summary` / `TL;DR` / a Simplified-Chinese variant we still pick it up.
 */
const SUMMARY_SYNONYMS: readonly string[] = [
    "Key\\s+Findings",
    "Summary",
    "TL;DR",
    "TLDR",
    "关键发现",
    "总结",
    "摘要",
    // Back-compat: the comprehensive route already emits Executive Summary.
    "Executive\\s+Summary",
    "执行摘要",
    "执行总结",
    "概要",
];

const EXEC_SUMMARY_SYNONYM_GROUP = `(?:${EXECUTIVE_SUMMARY_SYNONYMS.join("|")})`;
const RESPONSE_SUMMARY_SYNONYM_GROUP = `(?:${SUMMARY_SYNONYMS.join("|")})`;

function extractWithSynonyms(
    markdown: string,
    synonymGroup: string,
    markerRes: readonly RegExp[],
    maxChars: number,
): string {
    const rawInput = markdown?.trim() ?? "";
    if (!rawInput) {
        return "";
    }

    const source = markerRes.reduce(
        (acc, re) => acc.replace(re, ""),
        rawInput,
    ).trim();

    if (source) {
        const atx = new RegExp(
            `(?:^|\\r?\\n)\\s*#{1,4}\\s*(?:[\\d.]+\\s+)?[^\\n\\r]*${synonymGroup}[^\\n\\r]*[\\r\\n]+([\\s\\S]*?)(?=\\r?\\n\\s*#{1,4}\\s|$)`,
            "i",
        );
        const atxBody = atx.exec(source)?.[1] ?? "";
        if (atxBody.trim()) {
            return finalize(atxBody, maxChars);
        }

        const bold = new RegExp(
            `(?:^|\\r?\\n)\\s*\\*{1,2}[^*\\r\\n]*${synonymGroup}[^*\\r\\n]*\\*{1,2}\\s*[\\r\\n]+([\\s\\S]*?)(?=\\r?\\n\\s*(?:#{1,4}\\s|\\*{2})|$)`,
            "i",
        );
        const boldBody = bold.exec(source)?.[1] ?? "";
        if (boldBody.trim()) {
            return finalize(boldBody, maxChars);
        }
    }

    for (const re of markerRes) {
        const markerBody = re.exec(markdown ?? "")?.[1] ?? "";
        if (markerBody.trim()) {
            return finalize(markerBody, maxChars);
        }
    }

    return "";
}

/**
 * Comprehensive-analysis extractor. Kept as the original API so existing
 * callers (`ComprehensiveActionTab.tsx`, `comprehensiveAnalysisWorkflowGraph.ts`)
 * don't need to change. Same resolution order, same 4000-char cap.
 */
export function extractExecutiveSummaryFromMarkdown(
    markdown: string,
    maxChars: number = EXEC_SUMMARY_DEFAULT_MAX_CHARS,
): string {
    return extractWithSynonyms(
        markdown,
        EXEC_SUMMARY_SYNONYM_GROUP,
        [EXEC_SUMMARY_MARKER_RE],
        maxChars,
    );
}

/**
 * Generic response-summary extractor. Used by the regular / task-chain / CEX
 * routes to lift a short `## Key Findings` (or equivalent) block out of the
 * agent's final response. The 800-char cap is tuned for 3–4 bullet summaries
 * — small enough that a 5-turn window of recent agent turns stays well
 * under 1 K tokens.
 */
export function extractResponseSummary(
    markdown: string,
    maxChars: number = RESPONSE_SUMMARY_DEFAULT_MAX_CHARS,
): string {
    return extractWithSynonyms(
        markdown,
        RESPONSE_SUMMARY_SYNONYM_GROUP,
        [KEY_FINDINGS_MARKER_RE, EXEC_SUMMARY_MARKER_RE],
        maxChars,
    );
}

/**
 * Trim and length-cap while preserving markdown. We do **not** strip bullets,
 * bold, or other formatting — the caller renders this through MarkdownRenderer.
 * Truncation breaks at a paragraph boundary when possible to keep the cap from
 * cutting a sentence mid-word.
 */
function finalize(body: string, maxChars: number): string {
    let out = body
        .replace(/^[\r\n]+/, "")
        .replace(/[\r\n]+$/, "")
        .trim();

    if (!out) return "";

    if (out.length > maxChars) {
        const cut = out.lastIndexOf("\n\n", maxChars - 3);
        const sliceTo = cut > maxChars * 0.5 ? cut : maxChars - 3;
        out = `${out.slice(0, sliceTo).trimEnd()}…`;
    }
    return out;
}
