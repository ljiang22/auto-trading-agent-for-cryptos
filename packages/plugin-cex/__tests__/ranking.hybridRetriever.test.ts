import { describe, expect, it } from "vitest";

import { hybridRetrieve } from "../src/ranking/hybridRetriever";
import type { KbDocument } from "../src/ranking/types";

function doc(
    id: string,
    text: string,
    tier: "A" | "B" | "C",
    publishedAt: string,
    symbols?: string[],
    embedding?: number[],
): KbDocument {
    return { id, text, trust_tier: tier, publishedAt, symbols, embedding };
}

const NOW = new Date("2026-05-17T00:00:00Z").getTime();
const FRESH = "2026-05-15T00:00:00Z";
const STALE = "2024-01-01T00:00:00Z";

describe("Hybrid retriever", () => {
    it("returns empty on empty corpus", () => {
        const r = hybridRetrieve([], { text: "bitcoin", topK: 5 });
        expect(r).toEqual([]);
    });

    it("BM25-only path retrieves keyword-matching docs", () => {
        const corpus: KbDocument[] = [
            doc("1", "Bitcoin halving 2024 supply", "A", FRESH),
            doc("2", "Ethereum upgrade roadmap", "A", FRESH),
            doc("3", "Cat memes are cool", "C", FRESH),
        ];
        const r = hybridRetrieve(
            corpus,
            { text: "bitcoin halving", topK: 2 },
            { nowMs: NOW },
        );
        expect(r[0].doc.id).toBe("1");
    });

    it("Tier A outranks Tier C on equal text match", () => {
        const corpus: KbDocument[] = [
            doc("a", "Bitcoin protocol fundamentals", "A", FRESH),
            doc("c", "Bitcoin protocol fundamentals", "C", FRESH),
        ];
        const r = hybridRetrieve(
            corpus,
            { text: "Bitcoin protocol fundamentals", topK: 2 },
            { nowMs: NOW },
        );
        expect(r[0].doc.id).toBe("a");
        expect(r[0].stage_scores.trust).toBeGreaterThan(r[1].stage_scores.trust ?? 0);
    });

    it("Freshness boosts recent docs", () => {
        const corpus: KbDocument[] = [
            doc("new", "Bitcoin update", "A", FRESH),
            doc("old", "Bitcoin update", "A", STALE),
        ];
        const r = hybridRetrieve(
            corpus,
            { text: "Bitcoin update", topK: 2 },
            { nowMs: NOW },
        );
        expect(r[0].doc.id).toBe("new");
    });

    it("Portfolio relevance boosts matched symbols", () => {
        const corpus: KbDocument[] = [
            doc("btc", "Bitcoin news", "B", FRESH, ["BTC"]),
            doc("eth", "Ethereum news", "B", FRESH, ["ETH"]),
        ];
        const r = hybridRetrieve(
            corpus,
            { text: "news", topK: 2, portfolio_symbols: ["BTC"] },
            { nowMs: NOW },
        );
        expect(r[0].doc.id).toBe("btc");
    });

    it("Dense fusion uses cosine when embeddings present", () => {
        const corpus: KbDocument[] = [
            doc("a", "alpha", "B", FRESH, [], [1, 0, 0]),
            doc("b", "beta", "B", FRESH, [], [0, 1, 0]),
        ];
        const r = hybridRetrieve(
            corpus,
            { text: "alpha", topK: 2, embedding: [1, 0, 0] },
            { nowMs: NOW },
        );
        expect(r[0].doc.id).toBe("a");
    });

    it("MMR de-duplicates near-duplicate text", () => {
        const corpus: KbDocument[] = [
            doc("1", "Bitcoin halving 2024 details", "A", FRESH),
            doc("2", "Bitcoin halving 2024 details copy", "A", FRESH),
            doc("3", "Ethereum staking yields update", "A", FRESH),
        ];
        const r = hybridRetrieve(
            corpus,
            { text: "Bitcoin halving 2024 details", topK: 2, candidates_per_retriever: 3 },
            { nowMs: NOW, mmrLambda: 0.5 },
        );
        const ids = r.map((d) => d.doc.id);
        expect(ids).toContain("1");
        // MMR should not pick the duplicate at top-2 (penalized for redundancy).
        expect(ids.includes("3") || !ids.includes("2")).toBe(true);
    });
});
