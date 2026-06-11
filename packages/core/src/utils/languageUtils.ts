import type { Memory } from "../core/types";

export type Locale = "en" | "zh-CN" | "mixed-en";

const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
    [0x3400, 0x4dbf],
    [0x4e00, 0x9fff],
    [0xf900, 0xfaff],
    [0x20000, 0x2ffff],
];

function isLatinAlpha(cp: number): boolean {
    return (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
}

function isCjk(cp: number): boolean {
    for (const [lo, hi] of CJK_RANGES) {
        if (cp >= lo && cp <= hi) return true;
    }
    return false;
}

const DOMINANCE_THRESHOLD = 0.75;

/**
 * Deterministic locale detector per the plan §Cross-cutting #1.
 *
 *  - `cjk==0, latin==0`  → fallback ("en" if not supplied)
 *  - `cjk==0`            → "en"
 *  - `latin==0`          → "zh-CN"
 *  - max/(cjk+latin) ≥ 0.75 → dominant wins
 *  - otherwise           → "mixed-en"
 */
export function detectLocale(text: string, fallback: Locale = "en"): Locale {
    if (!text) return fallback;
    let cjk = 0;
    let latin = 0;
    for (let i = 0; i < text.length; ) {
        const cp = text.codePointAt(i);
        if (cp === undefined) break;
        i += cp > 0xffff ? 2 : 1;
        if (isCjk(cp)) cjk++;
        else if (isLatinAlpha(cp)) latin++;
    }
    if (cjk === 0 && latin === 0) return fallback;
    if (cjk === 0) return "en";
    if (latin === 0) return "zh-CN";
    const total = cjk + latin;
    if (cjk / total >= DOMINANCE_THRESHOLD) return "zh-CN";
    if (latin / total >= DOMINANCE_THRESHOLD) return "en";
    return "mixed-en";
}

const INSTRUCTIONS: Record<Locale, string> = {
    en: `\n\n**RESPONSE LANGUAGE**: The user wrote in English. Write your ENTIRE response in English. This applies to ALL text content — headings, analysis, recommendations, conclusions, and any human-readable text fields inside JSON responses. Do not mix languages except for proper nouns (e.g., token names like "Bitcoin", "Ethereum"), technical terms commonly used in English (e.g., "RSI", "MACD", "ETF"), or direct quotes.`,
    "zh-CN": `\n\n**RESPONSE LANGUAGE**: The user wrote in Simplified Chinese. Write your ENTIRE response in Simplified Chinese (简体中文). This applies to ALL text content — headings, analysis, recommendations, conclusions, and any human-readable text fields inside JSON responses (task chain names, task names, task descriptions, summaries, etc.). Do not mix languages except for proper nouns (e.g., "Bitcoin", "Ethereum"), widely-used technical terms (e.g., "RSI", "MACD", "ETF"), or direct quotes.`,
    "mixed-en": `\n\n**RESPONSE LANGUAGE**: The user's message contains a mix of English and Chinese with neither dominant. Respond in English. This applies to ALL text content — headings, analysis, recommendations, conclusions, and any human-readable text fields inside JSON responses. Do not mix languages except for proper nouns (e.g., token names like "Bitcoin", "Ethereum"), technical terms commonly used in English (e.g., "RSI", "MACD", "ETF"), or direct quotes.`,
};

function isLocale(v: unknown): v is Locale {
    return v === "en" || v === "zh-CN" || v === "mixed-en";
}

/**
 * Backwards-compatible signature: zero-arg form returns the generic
 * "mirror the user's language" string preserved from the original
 * implementation. Locale-aware overload returns a deterministic
 * directive based on the detected locale. Unknown string inputs (e.g.,
 * stale `Memory.content.language` from before Phase 1) fall back to
 * the generic instruction.
 */
export function getLanguageInstruction(): string;
export function getLanguageInstruction(locale: Locale): string;
export function getLanguageInstruction(locale: string | undefined | null): string;
export function getLanguageInstruction(locale?: Locale | string | null): string {
    if (isLocale(locale)) {
        return INSTRUCTIONS[locale];
    }
    return `\n\n**RESPONSE LANGUAGE**: Detect the language of the user's latest message and write your ENTIRE response in that SAME language. If the user wrote in Simplified Chinese (简体中文), respond entirely in Simplified Chinese. If the user wrote in English, respond entirely in English. This applies to ALL text content — headings, analysis, recommendations, conclusions, and any human-readable text fields inside JSON responses (task chain names, task names, task descriptions, chain descriptions, summaries, etc.). Do not mix languages except for proper nouns (e.g., token names like "Bitcoin", "Ethereum"), technical terms commonly used in English (e.g., "RSI", "MACD", "ETF"), or direct quotes. If the user's language is ambiguous or mixed, mirror the dominant language of their latest message.`;
}

/**
 * Writes the detected locale into Memory.content.language. The
 * resulting Memory is returned (the function does not mutate in
 * place) so callers can persist the updated copy via their normal
 * write path.
 */
export function tagAssistantMemoryLanguage(
    memory: Memory,
    locale: Locale,
): Memory {
    const content = { ...memory.content, language: locale };
    return { ...memory, content };
}
