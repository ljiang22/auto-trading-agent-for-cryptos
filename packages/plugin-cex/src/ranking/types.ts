export type TrustTier = "A" | "B" | "C";

export interface KbDocument {
    id: string;
    /** Plain-text content used for keyword retrieval. */
    text: string;
    /** Dense embedding vector (e.g., BGE-M3). Optional — disables dense path if absent. */
    embedding?: number[];
    /** Tier-A: official exchange/protocol docs; B: analyst notes; C: social. */
    trust_tier: TrustTier;
    /** ISO timestamp; used for freshness scoring. */
    publishedAt: string;
    /** Optional source license tag. */
    license?: string;
    /** Optional list of symbols the doc is relevant to. */
    symbols?: string[];
    /** Free-form metadata bag. */
    metadata?: Record<string, unknown>;
}

export interface RetrieveQuery {
    text: string;
    /** Optional dense query embedding. */
    embedding?: number[];
    /** User portfolio symbols — boosts portfolio-relevant docs. */
    portfolio_symbols?: string[];
    /** Number of results to return after re-ranking. */
    topK: number;
    /** Number of candidates fetched from each retriever before merge. */
    candidates_per_retriever?: number;
}

export interface RankedDocument {
    doc: KbDocument;
    /** Final score (post rerank). */
    score: number;
    /** Per-stage scores for explainability. */
    stage_scores: {
        bm25?: number;
        dense?: number;
        rrf?: number;
        mmr?: number;
        trust?: number;
        freshness?: number;
        portfolio?: number;
        final: number;
    };
}
