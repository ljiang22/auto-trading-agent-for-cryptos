import { describe, expect, it } from "vitest";
import { validateAndSanitizePrompt } from "../src/handlers/comprehensiveAnalysisWorkflowGraph.ts";

/**
 * Covers PR #158 fix: replace the blunt `includes('undefined') || includes('null')`
 * check that fired on any prompt containing the string "null" (extremely common
 * in serialized action-data JSON) with targeted detection that:
 *   - flags unresolved {{handlebars}} placeholders (the actual signal)
 *   - flags bare `undefined` tokens with a count
 *   - suppresses bare `null` entirely (valid in JSON payloads)
 */

describe("validateAndSanitizePrompt — placeholder/undefined/null detection (PR #158)", () => {
    it("flags unresolved handlebars placeholders by key", () => {
        const { sanitizedPrompt, warnings } = validateAndSanitizePrompt(
            "User asked about {{symbol}} on {{date}}."
        );

        const placeholderWarn = warnings.find((w) =>
            w.startsWith("Prompt contains unresolved template placeholders:")
        );
        expect(placeholderWarn).toBeDefined();
        expect(placeholderWarn).toContain("{{symbol}}");
        expect(placeholderWarn).toContain("{{date}}");

        // Tokens are rewritten to a diagnostic form so downstream LLM output
        // doesn't see raw {{...}} but the human reader can still trace the key.
        expect(sanitizedPrompt).toContain("[unresolved:symbol]");
        expect(sanitizedPrompt).toContain("[unresolved:date]");
        expect(sanitizedPrompt).not.toMatch(/\{\{symbol\}\}/);
    });

    it("does NOT warn on bare `null` tokens in action-data JSON (the noisy false positive this PR removed)", () => {
        // Realistic snippet shape: action-data envelopes routinely contain `null`.
        const prompt = `## Available Data from Analysis Actions
{"price": 65000, "error": null, "metadata": {"source": null}}`;

        const { warnings, sanitizedPrompt } = validateAndSanitizePrompt(prompt);

        const anyUndefinedNullWarn = warnings.some(
            (w) =>
                /undefined\/null/.test(w) ||
                /Prompt contains literal undefined/.test(w)
        );
        expect(anyUndefinedNullWarn).toBe(false);

        // `null` is preserved verbatim — it's valid JSON content.
        expect(sanitizedPrompt).toContain('"error": null');
        expect(sanitizedPrompt).not.toContain("[null]");
    });

    it("still warns on bare `undefined` tokens and reports the count", () => {
        const prompt = "value=undefined; other=undefined; safe='this is undefined as a word'";
        const { warnings, sanitizedPrompt } = validateAndSanitizePrompt(prompt);

        const undefinedWarn = warnings.find((w) =>
            /Prompt contains literal undefined values/.test(w)
        );
        expect(undefinedWarn).toBeDefined();
        // Count must reflect every word-boundary match (here: 3).
        expect(undefinedWarn).toMatch(/\(3\)/);

        // Bare `undefined` is rewritten to `[undefined]` so it can't confuse the LLM.
        // (Note: `\b` is a word boundary, and `[`/`]` are non-word chars, so the
        // bracketed form still matches `\bundefined\b` — we check for the absence
        // of any *un-bracketed* `undefined` instead.)
        expect(sanitizedPrompt).not.toMatch(/(?<!\[)undefined(?!\])/);
        expect(sanitizedPrompt.match(/\[undefined\]/g)?.length).toBe(3);
    });

    it("emits no warnings for a clean prompt", () => {
        const { warnings } = validateAndSanitizePrompt(
            "Analyze the price action on BTC over the past 24 hours."
        );
        // Clean prompts should produce zero diagnostic warnings.
        expect(warnings.filter((w) => /placeholder|undefined/.test(w))).toEqual([]);
    });

    it("dedupes repeated placeholders in the warning preview", () => {
        const { warnings } = validateAndSanitizePrompt(
            "{{symbol}} {{symbol}} {{symbol}} {{date}}"
        );
        const placeholderWarn = warnings.find((w) =>
            w.startsWith("Prompt contains unresolved template placeholders:")
        );
        // The preview is built from a Set so each key appears once.
        const symbolHits = (placeholderWarn!.match(/\{\{symbol\}\}/g) ?? []).length;
        expect(symbolHits).toBe(1);
    });

    it("placeholder substitution runs before the undefined pass (documented edge case)", () => {
        // A placeholder literally named `{{undefined}}` is rewritten to
        // `[unresolved:undefined]` by the placeholder pass; the undefined pass
        // then matches the word `undefined` inside the diagnostic and wraps it
        // again, yielding `[unresolved:[undefined]]`. This pins current
        // behavior so a future "fix" doesn't accidentally silence the placeholder
        // warning (which is the *primary* signal here).
        const { warnings, sanitizedPrompt } = validateAndSanitizePrompt("{{undefined}}");
        expect(sanitizedPrompt).toBe("[unresolved:[undefined]]");
        expect(warnings.some((w) => /unresolved template placeholders/.test(w))).toBe(true);
        expect(warnings.some((w) => /literal undefined values/.test(w))).toBe(true);
    });
});
