/**
 * Prompt variable sanitizer.
 *
 * Central trust boundary for values interpolated into LLM prompts. All user- or
 * API-sourced strings must go through one of these helpers before string
 * concatenation into a prompt template.
 *
 * Scope: sanitizing LLM INPUTS. Output markdown cleanup (e.g. heading format
 * normalization) is a separate concern.
 */

export class SymbolValidationError extends Error {
    constructor(reason: string, public readonly input: unknown) {
        super(`Invalid symbol: ${reason}`);
        this.name = "SymbolValidationError";
    }
}

const SYMBOL_RE = /^[A-Za-z0-9._-]{1,20}$/;

/**
 * Strict whitelist for cryptocurrency symbols / targets / action names that enter
 * prompt templates. On violation, throws — caller decides how to surface the
 * error (the comprehensive analysis workflow short-circuits with an error state).
 */
export function sanitizeSymbol(raw: unknown): string {
    if (typeof raw !== "string") {
        throw new SymbolValidationError("must be a string", raw);
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
        throw new SymbolValidationError("empty after trim", raw);
    }
    if (trimmed.length > 20) {
        throw new SymbolValidationError("over 20 chars", raw);
    }
    if (!SYMBOL_RE.test(trimmed)) {
        throw new SymbolValidationError("non-whitelisted chars", raw);
    }
    return trimmed;
}

export interface SanitizeForPromptOptions {
    /** Hard length cap. Default 10_000. */
    maxLen?: number;
}

/**
 * Defensive cleanup for free-form text going into prompt templates.
 * - Drops control chars (NUL).
 * - Defangs markdown heading markers at start of lines so adversaries can't
 *   start new prompt sections.
 * - Breaks triple-backtick code fences.
 * - Strips common LLM meta-tags (<system>, <instruction>).
 * - Caps length.
 */
export function sanitizeForPrompt(
    raw: unknown,
    options: SanitizeForPromptOptions = {},
): string {
    if (raw === null || raw === undefined) return "";
    const input = typeof raw === "string" ? raw : String(raw);
    const maxLen = options.maxLen ?? 10_000;

    let out = input
        .replace(/\u0000/g, "")
        .replace(/^#{1,6}\s/gm, "")
        .replace(/```/g, "` ` `")
        .replace(/<\/?system>/gi, "")
        .replace(/<\/?instruction>/gi, "");

    if (out.length > maxLen) {
        out = out.slice(0, maxLen) + "\n...[truncated]";
    }
    return out;
}

/**
 * Wrap external (API-sourced) data in sentinel markers so the LLM can be told
 * (via system prompt) to treat enclosed content as reference material only,
 * not instructions. Both `actionName` and `payload` are sanitized.
 */
export function wrapExternalData(actionName: string, payload: string): string {
    // Action names may contain underscores/dots (see COMPREHENSIVE_ANALYSIS_ACTIONS);
    // use sanitizeForPrompt to scrub while allowing those chars — sanitizeSymbol
    // would reject valid action names like "plot_price_charts".
    const safeAction = sanitizeForPrompt(actionName, { maxLen: 64 });
    const safePayload = sanitizeForPrompt(payload, { maxLen: 50_000 });
    return `<<EXTERNAL_DATA action="${safeAction}">>\n${safePayload}\n<<END_EXTERNAL_DATA>>`;
}
