import type { ExchangeName, ExchangeRegistryEntry, ExchangeService, ResolvedExchangeCredentials } from "../types";
import { BinanceExchangeService } from "./services/binance";
import { CoinbaseExchangeService } from "./services/coinbase";

export const EXCHANGE_REGISTRY: ExchangeRegistryEntry[] = [
    {
        id: "coinbase",
        name: "Coinbase",
        aliases: ["cb", "coinbase pro", "coinbase advanced trade", "advanced trade"],
    },
    {
        id: "binance",
        name: "Binance",
        aliases: ["bn", "binance.us", "binance us"],
    },
];

/**
 * Lookup helper for the exchange resolver. Returns the `ExchangeName` for
 * a case-insensitive registry-name or alias match, or `null` if nothing
 * matches.
 *
 * Pure function — no side effects, no caching. Callers should match
 * the user's raw token (e.g., "Binance", "BN") directly; this function
 * normalizes case and trims whitespace.
 */
export function matchExchangeToken(token: string): ExchangeName | null {
    const needle = token.trim().toLowerCase();
    if (!needle) return null;
    for (const entry of EXCHANGE_REGISTRY) {
        if (entry.id.toLowerCase() === needle) return entry.id;
        if (entry.name.toLowerCase() === needle) return entry.id;
        if (entry.aliases?.some((a) => a.toLowerCase() === needle)) return entry.id;
    }
    return null;
}

/**
 * Word-boundary-aware search for ANY registry entry name or alias inside
 * a free-text user message. Returns the first match by start-index in
 * the source string so "buy on binance not coinbase" deterministically
 * picks "binance".
 *
 * The matcher splits on non-word characters; alias spans containing
 * whitespace (e.g., "coinbase pro") are checked separately via
 * substring containment with whitespace-trimmed boundaries.
 */
export function findExchangeMentionInText(text: string): ExchangeName | null {
    if (!text) return null;
    const lower = text.toLowerCase();
    const candidates: Array<{ id: ExchangeName; needle: string; isSingleWord: boolean }> = [];
    for (const entry of EXCHANGE_REGISTRY) {
        const idLower = entry.id.toLowerCase();
        candidates.push({ id: entry.id, needle: idLower, isSingleWord: !idLower.includes(" ") });
        if (entry.name.toLowerCase() !== idLower) {
            const n = entry.name.toLowerCase();
            candidates.push({ id: entry.id, needle: n, isSingleWord: !n.includes(" ") });
        }
        for (const alias of entry.aliases ?? []) {
            const a = alias.toLowerCase();
            candidates.push({ id: entry.id, needle: a, isSingleWord: !a.includes(" ") });
        }
    }
    let bestIdx = Number.POSITIVE_INFINITY;
    let bestId: ExchangeName | null = null;
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

const EXCHANGE_FACTORIES: Record<ExchangeName, (credentials: ResolvedExchangeCredentials) => ExchangeService> = {
    coinbase: (credentials) => new CoinbaseExchangeService(credentials),
    binance: (credentials) => new BinanceExchangeService(credentials),
};

export function isExchangeId(exchange: string): exchange is ExchangeName {
    return EXCHANGE_REGISTRY.some((entry) => entry.id === exchange);
}

export function getSupportedExchangeNames(): string[] {
    return EXCHANGE_REGISTRY.map((entry) => entry.id);
}

export function createExchangeService(credentials: ResolvedExchangeCredentials): ExchangeService {
    if (!isExchangeId(credentials.exchange)) {
        throw new Error(
            `Unsupported exchange "${credentials.exchange}". Supported exchanges: ${getSupportedExchangeNames().join(", ")}`
        );
    }

    return EXCHANGE_FACTORIES[credentials.exchange](credentials);
}
