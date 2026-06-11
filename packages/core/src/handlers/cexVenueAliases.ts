/**
 * Curated venue-name + alias registry, in core so the exchange
 * resolver stays free of any plugin-cex import.
 *
 * Mirror copy of the plugin-cex registry's aliases (see
 * `packages/plugin-cex/src/exchanges/registry.ts`). When updating one,
 * update both. Adding an alias requires PR + dashboard review per
 * plan §Risks #6.
 */

import type { ExchangeId } from "../core/types";

const ALIASES: ReadonlyArray<{ id: ExchangeId; aliases: readonly string[] }> = [
    {
        id: "binance",
        aliases: ["binance", "bn", "binance.us", "binance us"],
    },
    {
        id: "coinbase",
        aliases: [
            "coinbase",
            "cb",
            "coinbase pro",
            "coinbase advanced trade",
            "advanced trade",
        ],
    },
];

export function matchVenueToken(token: string): ExchangeId | null {
    const needle = token.trim().toLowerCase();
    if (!needle) return null;
    for (const entry of ALIASES) {
        if (entry.aliases.some((a) => a === needle)) return entry.id;
    }
    return null;
}

export function findVenueMentionInText(text: string): ExchangeId | null {
    if (!text) return null;
    const lower = text.toLowerCase();
    type Candidate = { id: ExchangeId; needle: string; isSingleWord: boolean };
    const candidates: Candidate[] = [];
    for (const entry of ALIASES) {
        for (const alias of entry.aliases) {
            candidates.push({
                id: entry.id,
                needle: alias,
                isSingleWord: !alias.includes(" "),
            });
        }
    }
    let bestIdx = Number.POSITIVE_INFINITY;
    let bestId: ExchangeId | null = null;
    for (const c of candidates) {
        const idx = c.isSingleWord
            ? indexOfWord(lower, c.needle)
            : lower.indexOf(c.needle);
        if (idx >= 0 && idx < bestIdx) {
            bestIdx = idx;
            bestId = c.id;
        }
    }
    return bestId;
}

function indexOfWord(haystack: string, needle: string): number {
    let from = 0;
    while (from <= haystack.length - needle.length) {
        const idx = haystack.indexOf(needle, from);
        if (idx < 0) return -1;
        const prev = idx > 0 ? haystack[idx - 1] : "";
        const next = idx + needle.length < haystack.length ? haystack[idx + needle.length] : "";
        if (!isWordChar(prev) && !isWordChar(next)) return idx;
        from = idx + 1;
    }
    return -1;
}

function isWordChar(c: string): boolean {
    return /[a-z0-9_]/.test(c);
}
