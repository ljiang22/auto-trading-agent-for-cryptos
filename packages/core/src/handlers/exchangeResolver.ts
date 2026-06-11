/**
 * Pure-function exchange resolver — single source of truth for which
 * venue a CEX request is bound to. Per autotrading-uplift plan
 * §Cross-cutting #2, the resolution priority is:
 *
 *   1. Explicit mention in the current message
 *   2. Sticky context (most-recent assistant Memory tagged
 *      `metadata.last_used_exchange`, requires
 *      `metadata.action_was_trade === true`)
 *   3. Per-account `defaultExchangeAuth`
 *   4. Per-user `preferred_exchange` (ultimate fallback)
 *   5. Clarification — only for `write` stake with 2+ configured
 *      venues and no signal at 1–4. Read-only falls through to the
 *      default silently.
 *
 * Injected dependencies (matchToken / findMentionInText) keep this
 * module free of any plugin-cex import.
 */

import type { Memory } from "../core/types";

export type Stake = "read_only" | "write";

export interface ExchangeResolverInput<TVenue extends string = string> {
    messageText: string;
    /**
     * Recent conversation memories (newest at the end). Only the most-
     * recent 10 are scanned per §Risks #7.
     */
    recentMemories: Memory[];
    /**
     * Venues the user has configured. The first entry in this list is
     * the `defaultExchangeAuth.exchangeId` if present; otherwise it is
     * implementation-defined.
     */
    configuredVenues: TVenue[];
    /** Resolution-priority #3. */
    defaultVenue?: TVenue;
    /** Resolution-priority #4. */
    preferredVenue?: TVenue | null;
    stake: Stake;
    /** Pluggable matchers — injected to keep this module pure. */
    matchToken: (token: string) => TVenue | null;
    findMentionInText: (text: string) => TVenue | null;
}

export type ExchangeResolution<TVenue extends string = string> =
    | {
          kind: "resolved";
          venue: TVenue;
          source: "message" | "sticky" | "default" | "preferred";
      }
    | {
          kind: "needs_clarification";
          options: TVenue[];
          reasonText: string;
      };

const STICKY_SCAN_LIMIT = 10;

export function resolveExchange<TVenue extends string>(
    input: ExchangeResolverInput<TVenue>,
): ExchangeResolution<TVenue> {
    const configuredSet = new Set(input.configuredVenues);

    // Priority 1 — explicit mention in current message
    const mention = input.findMentionInText(input.messageText);
    if (mention && configuredSet.has(mention)) {
        return { kind: "resolved", venue: mention, source: "message" };
    }

    // Priority 2 — sticky context
    const sticky = findStickyVenue<TVenue>(
        input.recentMemories,
        input.matchToken,
        configuredSet,
    );
    if (sticky) {
        return { kind: "resolved", venue: sticky, source: "sticky" };
    }

    // Priority 3 — per-account default
    if (input.defaultVenue && configuredSet.has(input.defaultVenue)) {
        // For read stake or single-venue users, default wins silently.
        // For write stake with 2+ venues, the default still wins
        // (clarification only fires when *no* signal exists at 1–3).
        return { kind: "resolved", venue: input.defaultVenue, source: "default" };
    }

    // Priority 4 — user preferred
    if (input.preferredVenue && configuredSet.has(input.preferredVenue)) {
        return { kind: "resolved", venue: input.preferredVenue, source: "preferred" };
    }

    // Priority 5 — clarification
    if (input.stake === "write" && input.configuredVenues.length >= 2) {
        return {
            kind: "needs_clarification",
            options: input.configuredVenues,
            reasonText: "multiple_venues_no_signal",
        };
    }

    // Read-only with no signal: pick the first configured venue as the
    // silent fallback. Better to answer than to demand clarification
    // for a balance query.
    if (input.configuredVenues.length > 0) {
        return {
            kind: "resolved",
            venue: input.configuredVenues[0],
            source: "default",
        };
    }

    // Pathological: zero configured venues. Treat as clarification so
    // the handler can surface a config-required message.
    return {
        kind: "needs_clarification",
        options: [],
        reasonText: "no_configured_venues",
    };
}

function findStickyVenue<TVenue extends string>(
    recent: Memory[],
    matchToken: (token: string) => TVenue | null,
    configured: Set<TVenue>,
): TVenue | null {
    if (!recent || recent.length === 0) return null;
    const window = recent.slice(-STICKY_SCAN_LIMIT);
    for (let i = window.length - 1; i >= 0; i--) {
        const memory = window[i];
        const metadata = (memory.content as { metadata?: Record<string, unknown> })
            .metadata;
        if (!metadata) continue;
        // Per §Risks #7, only memories explicitly tagged as a trade
        // contribute sticky context — avoids stale exchange tags from
        // unrelated turns hijacking a new request.
        if (metadata.action_was_trade !== true) continue;
        const tag = metadata.last_used_exchange;
        if (typeof tag !== "string") continue;
        const candidate = matchToken(tag);
        if (candidate && configured.has(candidate)) return candidate;
    }
    return null;
}
