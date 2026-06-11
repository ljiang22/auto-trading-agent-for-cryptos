import { describe, expect, it } from "vitest";

import { resolveExchange } from "../src/handlers/exchangeResolver.ts";
import {
    findVenueMentionInText,
    matchVenueToken,
} from "../src/handlers/cexVenueAliases.ts";
import type { Memory } from "../src/core/types.ts";

type Venue = "binance" | "coinbase";

const matchers = {
    matchToken: matchVenueToken as (t: string) => Venue | null,
    findMentionInText: findVenueMentionInText as (t: string) => Venue | null,
};

function memory(text: string, metadata: Record<string, unknown>): Memory {
    return {
        id: "00000000-0000-0000-0000-000000000000" as Memory["id"],
        userId: "u" as Memory["userId"],
        agentId: "a" as Memory["agentId"],
        roomId: "r" as Memory["roomId"],
        content: { text, metadata },
        createdAt: 0,
    };
}

describe("exchange resolver", () => {
    it("priority 1: explicit mention in the current message wins over default", () => {
        const out = resolveExchange<Venue>({
            messageText: "show my balance on Binance",
            recentMemories: [],
            configuredVenues: ["binance", "coinbase"],
            defaultVenue: "coinbase",
            stake: "read_only",
            ...matchers,
        });
        expect(out).toEqual({ kind: "resolved", venue: "binance", source: "message" });
    });

    it("priority 1: alias 'cb' resolves to coinbase", () => {
        const out = resolveExchange<Venue>({
            messageText: "what's my eth balance on cb",
            recentMemories: [],
            configuredVenues: ["binance", "coinbase"],
            defaultVenue: "binance",
            stake: "read_only",
            ...matchers,
        });
        expect(out.kind === "resolved" && out.venue).toBe("coinbase");
    });

    it("priority 1: 'bn' resolves to binance via alias", () => {
        const out = resolveExchange<Venue>({
            messageText: "what's my balance on bn",
            recentMemories: [],
            configuredVenues: ["binance", "coinbase"],
            defaultVenue: "coinbase",
            stake: "read_only",
            ...matchers,
        });
        expect(out.kind === "resolved" && out.venue).toBe("binance");
    });

    it("priority 1: a word-boundary keeps 'binance' from matching inside 'binancent'", () => {
        const out = resolveExchange<Venue>({
            messageText: "binancent is not binance",
            recentMemories: [],
            configuredVenues: ["binance"],
            defaultVenue: "binance",
            stake: "write",
            ...matchers,
        });
        expect(out.kind === "resolved" && out.venue).toBe("binance");
    });

    it("priority 2: sticky context wins when no message mention", () => {
        const recent = [
            memory("trade done", {
                action_was_trade: true,
                last_used_exchange: "binance",
            }),
        ];
        const out = resolveExchange<Venue>({
            messageText: "what's the price?",
            recentMemories: recent,
            configuredVenues: ["binance", "coinbase"],
            defaultVenue: "coinbase",
            stake: "read_only",
            ...matchers,
        });
        expect(out).toEqual({ kind: "resolved", venue: "binance", source: "sticky" });
    });

    it("priority 2: sticky only honored when action_was_trade=true (§Risks #7)", () => {
        const recent = [
            memory("balance shown", {
                action_was_trade: false,
                last_used_exchange: "binance",
            }),
        ];
        const out = resolveExchange<Venue>({
            messageText: "what's the price?",
            recentMemories: recent,
            configuredVenues: ["binance", "coinbase"],
            defaultVenue: "coinbase",
            stake: "read_only",
            ...matchers,
        });
        expect(out).toEqual({ kind: "resolved", venue: "coinbase", source: "default" });
    });

    it("priority 3: defaultExchangeAuth wins when no mention or sticky", () => {
        const out = resolveExchange<Venue>({
            messageText: "balance please",
            recentMemories: [],
            configuredVenues: ["binance", "coinbase"],
            defaultVenue: "coinbase",
            stake: "read_only",
            ...matchers,
        });
        expect(out).toEqual({ kind: "resolved", venue: "coinbase", source: "default" });
    });

    it("priority 4: preferredVenue wins when no default", () => {
        const out = resolveExchange<Venue>({
            messageText: "balance please",
            recentMemories: [],
            configuredVenues: ["binance", "coinbase"],
            preferredVenue: "binance",
            stake: "read_only",
            ...matchers,
        });
        expect(out).toEqual({ kind: "resolved", venue: "binance", source: "preferred" });
    });

    it("priority 5: 2+ venues + write + no signal → clarification", () => {
        const out = resolveExchange<Venue>({
            messageText: "buy 0.01 BTC at market",
            recentMemories: [],
            configuredVenues: ["binance", "coinbase"],
            stake: "write",
            ...matchers,
        });
        expect(out.kind).toBe("needs_clarification");
        if (out.kind === "needs_clarification") {
            expect(out.options).toEqual(["binance", "coinbase"]);
        }
    });

    it("read-only 2+ venues no signal → silent default fallback (low friction)", () => {
        const out = resolveExchange<Venue>({
            messageText: "what's my balance?",
            recentMemories: [],
            configuredVenues: ["binance", "coinbase"],
            stake: "read_only",
            ...matchers,
        });
        expect(out.kind).toBe("resolved");
        if (out.kind === "resolved") {
            // Falls through to the silent first-configured-venue path
            expect(out.venue).toBe("binance");
            expect(out.source).toBe("default");
        }
    });

    it("zero configured venues → needs_clarification with reason", () => {
        const out = resolveExchange<Venue>({
            messageText: "buy 0.01 BTC",
            recentMemories: [],
            configuredVenues: [],
            stake: "write",
            ...matchers,
        });
        expect(out.kind).toBe("needs_clarification");
        if (out.kind === "needs_clarification") {
            expect(out.options).toEqual([]);
            expect(out.reasonText).toBe("no_configured_venues");
        }
    });

    it("explicit message wins over sticky context (§Cross-cutting #2 priority order)", () => {
        const recent = [
            memory("trade done", {
                action_was_trade: true,
                last_used_exchange: "binance",
            }),
        ];
        const out = resolveExchange<Venue>({
            messageText: "show ETH balance on Coinbase",
            recentMemories: recent,
            configuredVenues: ["binance", "coinbase"],
            stake: "read_only",
            ...matchers,
        });
        expect(out).toEqual({ kind: "resolved", venue: "coinbase", source: "message" });
    });
});
