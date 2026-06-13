import type {
    KbDocument,
    RankedDocument,
    RetrieveQuery,
    TrustTier,
} from "./types";

const TRUST_WEIGHT: Record<TrustTier, number> = {
    A: 1.0,
    B: 0.7,
    C: 0.4,
};

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]+/gu, " ")
        .split(/\s+/u)
        .filter((t) => t.length > 1);
}

/** BM25-lite: score each doc by (tf * idf) over query tokens. */
function bm25Score(
    query: string[],
    doc: KbDocument,
    avgDocLength: number,
    corpusSize: number,
    docFreq: Map<string, number>,
): number {
    const k1 = 1.2;
    const b = 0.75;
    const docTokens = tokenize(doc.text);
    const dl = docTokens.length;
    let score = 0;
    const tf = new Map<string, number>();
    for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const q of query) {
        const f = tf.get(q) ?? 0;
        if (f === 0) continue;
        const df = docFreq.get(q) ?? 0;
        const idf = Math.log(1 + (corpusSize - df + 0.5) / (df + 0.5));
        const denom = f + k1 * (1 - b + b * (dl / Math.max(avgDocLength, 1)));
        score += idf * ((f * (k1 + 1)) / denom);
    }
    return score;
}

function cosine(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Reciprocal Rank Fusion. k=60 per common practice. */
function rrf(rankings: Array<Map<string, number>>): Map<string, number> {
    const out = new Map<string, number>();
    const k = 60;
    for (const r of rankings) {
        for (const [id, rank] of r.entries()) {
            const inc = 1 / (k + rank);
            out.set(id, (out.get(id) ?? 0) + inc);
        }
    }
    return out;
}

/**
 * Maximum Marginal Relevance. Selects topK while penalizing redundancy.
 * For text-only docs, similarity proxy = jaccard on tokens; for vector-bearing
 * docs we use cosine.
 */
function mmr(
    candidates: Array<{ id: string; doc: KbDocument; baseScore: number }>,
    topK: number,
    lambda = 0.7,
    queryEmbedding?: number[],
): Array<{ id: string; doc: KbDocument; baseScore: number; mmrScore: number }> {
    const selected: Array<{
        id: string;
        doc: KbDocument;
        baseScore: number;
        mmrScore: number;
    }> = [];
    const remaining = [...candidates];

    const tokensCache = new Map<string, Set<string>>();
    const tokens = (id: string, text: string) => {
        let t = tokensCache.get(id);
        if (!t) {
            t = new Set(tokenize(text));
            tokensCache.set(id, t);
        }
        return t;
    };

    const jaccard = (a: Set<string>, b: Set<string>): number => {
        if (a.size === 0 || b.size === 0) return 0;
        let inter = 0;
        for (const v of a) if (b.has(v)) inter++;
        const union = a.size + b.size - inter;
        return union === 0 ? 0 : inter / union;
    };

    while (selected.length < topK && remaining.length > 0) {
        let best = remaining[0];
        let bestMmr = Number.NEGATIVE_INFINITY;
        for (const cand of remaining) {
            let maxSim = 0;
            const candTok = tokens(cand.id, cand.doc.text);
            for (const sel of selected) {
                if (cand.doc.embedding && sel.doc.embedding) {
                    maxSim = Math.max(maxSim, cosine(cand.doc.embedding, sel.doc.embedding));
                } else {
                    const selTok = tokens(sel.id, sel.doc.text);
                    maxSim = Math.max(maxSim, jaccard(candTok, selTok));
                }
            }
            const score = lambda * cand.baseScore - (1 - lambda) * maxSim;
            if (score > bestMmr) {
                bestMmr = score;
                best = cand;
            }
        }
        selected.push({ ...best, mmrScore: bestMmr });
        const idx = remaining.findIndex((r) => r.id === best.id);
        if (idx >= 0) remaining.splice(idx, 1);
        void queryEmbedding;
    }
    return selected;
}

function freshnessScore(publishedAt: string, nowMs: number): number {
    const ts = new Date(publishedAt).getTime();
    if (!Number.isFinite(ts)) return 0.5;
    const ageDays = Math.max(0, (nowMs - ts) / (1000 * 60 * 60 * 24));
    // Half-life ~30 days.
    return Math.exp(-ageDays / 30);
}

function portfolioRelevance(doc: KbDocument, portfolio: string[]): number {
    if (portfolio.length === 0) return 0.5;
    if (!doc.symbols || doc.symbols.length === 0) return 0.5;
    const set = new Set(portfolio.map((s) => s.toUpperCase()));
    const hit = doc.symbols.some((s) => set.has(s.toUpperCase()));
    return hit ? 1.0 : 0.3;
}

export interface HybridRetrieverOptions {
    nowMs?: number;
    mmrLambda?: number;
}

export function hybridRetrieve(
    corpus: KbDocument[],
    query: RetrieveQuery,
    options: HybridRetrieverOptions = {},
): RankedDocument[] {
    if (corpus.length === 0) return [];
    const nowMs = options.nowMs ?? Date.now();
    const candidatesPer = query.candidates_per_retriever ?? Math.max(query.topK * 4, 20);

    // BM25 stats
    const queryTokens = tokenize(query.text);
    const docFreq = new Map<string, number>();
    let totalLen = 0;
    for (const doc of corpus) {
        const tokens = new Set(tokenize(doc.text));
        for (const t of tokens) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
        totalLen += tokens.size;
    }
    const avgDocLength = totalLen / corpus.length;
    const bm25Scored = corpus.map((doc) => ({
        id: doc.id,
        doc,
        score: bm25Score(queryTokens, doc, avgDocLength, corpus.length, docFreq),
    }));
    bm25Scored.sort((a, b) => b.score - a.score);
    const bm25Top = bm25Scored.slice(0, candidatesPer);

    // Dense
    const denseTop: Array<{ id: string; doc: KbDocument; score: number }> = [];
    if (query.embedding && query.embedding.length > 0) {
        for (const doc of corpus) {
            if (!doc.embedding) continue;
            const score = cosine(query.embedding, doc.embedding);
            denseTop.push({ id: doc.id, doc, score });
        }
        denseTop.sort((a, b) => b.score - a.score);
        denseTop.splice(candidatesPer);
    }

    // RRF merge of rank lists
    const bm25Ranks = new Map<string, number>();
    bm25Top.forEach((c, i) => bm25Ranks.set(c.id, i));
    const denseRanks = new Map<string, number>();
    denseTop.forEach((c, i) => denseRanks.set(c.id, i));
    const fused = rrf([bm25Ranks, denseRanks]);

    const fusedDocs: Array<{
        id: string;
        doc: KbDocument;
        baseScore: number;
        bm25?: number;
        dense?: number;
        rrf?: number;
    }> = [];
    const byId = new Map(corpus.map((d) => [d.id, d]));
    for (const [id, fusedScore] of fused.entries()) {
        const doc = byId.get(id);
        if (!doc) continue;
        const bm25Hit = bm25Top.find((c) => c.id === id);
        const denseHit = denseTop.find((c) => c.id === id);
        fusedDocs.push({
            id,
            doc,
            baseScore: fusedScore,
            bm25: bm25Hit?.score,
            dense: denseHit?.score,
            rrf: fusedScore,
        });
    }
    fusedDocs.sort((a, b) => b.baseScore - a.baseScore);

    // MMR diversity pass
    const mmrSelected = mmr(
        fusedDocs.slice(0, candidatesPer),
        Math.min(candidatesPer, fusedDocs.length),
        options.mmrLambda ?? 0.7,
        query.embedding,
    );

    // Final rerank: trust * freshness * portfolio_relevance
    const reranked: RankedDocument[] = mmrSelected.map((cand) => {
        const trust = TRUST_WEIGHT[cand.doc.trust_tier];
        const freshness = freshnessScore(cand.doc.publishedAt, nowMs);
        const portfolio = portfolioRelevance(
            cand.doc,
            query.portfolio_symbols ?? [],
        );
        const final = cand.mmrScore * (1 + trust + freshness + portfolio);
        const fusedHit = fusedDocs.find((f) => f.id === cand.id);
        return {
            doc: cand.doc,
            score: final,
            stage_scores: {
                bm25: fusedHit?.bm25,
                dense: fusedHit?.dense,
                rrf: fusedHit?.rrf,
                mmr: cand.mmrScore,
                trust,
                freshness,
                portfolio,
                final,
            },
        };
    });

    reranked.sort((a, b) => b.score - a.score);
    return reranked.slice(0, query.topK);
}
