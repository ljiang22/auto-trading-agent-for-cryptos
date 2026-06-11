import { embed } from "../ai/embedding.ts";
import { splitChunks } from "../ai/generation.ts";
import elizaLogger from "../utils/logger.ts";
import {
    type IAgentRuntime,
    type IRAGKnowledgeManager,
    type RAGKnowledgeItem,
    type UUID,
    KnowledgeScope,
} from "../core/types.ts";
import { stringToUuid } from "../utils/uuid.ts";
import { existsSync } from "fs";
import { join } from "path";

/**
 * Manage knowledge in the database.
 */
export class RAGKnowledgeManager implements IRAGKnowledgeManager {
    private readonly defaultRAGCandidateThreshold = 0.3;
    private readonly defaultRAGResultThreshold = 0.45;
    private readonly defaultRAGMatchCount = 8;
    private readonly defaultRAGCandidateMultiplier = 3;
    private readonly exactPhraseBoost = 0.2;
    private readonly termCoverageWeight = 0.25;
    private readonly proximityBoost = 0.1;
    private readonly proximityWindow = 5;
    private readonly multilingualTokenPattern =
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{Letter}\p{Number}]+/gu;

    /**
     * The AgentRuntime instance associated with this manager.
     */
    runtime: IAgentRuntime;

    /**
     * The name of the database table this manager operates on.
     */
    tableName: string;

    /**
     * The root directory where RAG knowledge files are located (internal)
     */
    knowledgeRoot: string;

    /**
     * Constructs a new KnowledgeManager instance.
     * @param opts Options for the manager.
     * @param opts.tableName The name of the table this manager will operate on.
     * @param opts.runtime The AgentRuntime instance associated with this manager.
     */
    constructor(opts: {
        tableName: string;
        runtime: IAgentRuntime;
        knowledgeRoot: string;
    }) {
        this.runtime = opts.runtime;
        this.tableName = opts.tableName;
        this.knowledgeRoot = opts.knowledgeRoot;
    }

    /**
     * Common English stop words to filter out from query analysis
     */
    private readonly stopWords = new Set([
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "by",
        "does",
        "for",
        "from",
        "had",
        "has",
        "have",
        "he",
        "her",
        "his",
        "how",
        "hey",
        "i",
        "in",
        "is",
        "it",
        "its",
        "of",
        "on",
        "or",
        "that",
        "the",
        "this",
        "to",
        "was",
        "what",
        "when",
        "where",
        "which",
        "who",
        "will",
        "with",
        "would",
        "there",
        "their",
        "they",
        "your",
        "you",
    ]);

    private containsCjk(text: string): boolean {
        return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
            text
        );
    }

    private expandCjkSegment(segment: string): string[] {
        const chars = Array.from(segment);

        if (chars.length === 1) {
            return chars;
        }

        const terms: string[] = [];

        for (let i = 0; i < chars.length - 1; i++) {
            terms.push(chars.slice(i, i + 2).join(""));
        }

        if (chars.length <= 6) {
            terms.push(segment);
        }

        return terms;
    }

    private tokenizeMultilingualText(
        text: string,
        dedupe = false
    ): string[] {
        const tokens: string[] = [];
        const matches = text.toLowerCase().match(this.multilingualTokenPattern);

        for (const match of matches ?? []) {
            if (this.containsCjk(match)) {
                tokens.push(...this.expandCjkSegment(match));
                continue;
            }

            if (match.length <= 2 || this.stopWords.has(match)) {
                continue;
            }

            tokens.push(match);
        }

        return dedupe ? Array.from(new Set(tokens)) : tokens;
    }

    private getQueryTerms(query: string): string[] {
        return this.tokenizeMultilingualText(query, true);
    }

    private getCandidateMatchCount(limit?: number): number {
        return (limit || this.defaultRAGMatchCount) * this.defaultRAGCandidateMultiplier;
    }

    /**
     * Preprocesses text content for better RAG performance.
     * @param content The text content to preprocess.
     * @returns The preprocessed text.
     */

    private preprocess(content: string): string {
        if (!content || typeof content !== "string") {
            elizaLogger.warn("Invalid input for preprocessing");
            return "";
        }

        return (
            content
                .replace(/```[\s\S]*?```/g, "")
                .replace(/`.*?`/g, "")
                .replace(/#{1,6}\s*(.*)/g, "$1")
                .replace(/!\[(.*?)\]\(.*?\)/g, "$1")
                .replace(/\[(.*?)\]\(.*?\)/g, "$1")
                .replace(/(https?:\/\/)?(www\.)?([^\s]+\.[^\s]+)/g, "$3")
                .replace(/<@[!&]?\d+>/g, "")
                .replace(/<[^>]*>/g, "")
                .replace(/^\s*[-*_]{3,}\s*$/gm, "")
                .replace(/\/\*[\s\S]*?\*\//g, "")
                .replace(/\/\/.*/g, "")
                .replace(/\s+/g, " ")
                .replace(/\n{3,}/g, "\n\n")
                // .replace(/[^a-zA-Z0-9\s\-_./:?=&]/g, "") --this strips out CJK characters
                .trim()
                .toLowerCase()
        );
    }

    private hasTermMatch(resultTerms: string[], term: string): boolean {
        const isCjkTerm = this.containsCjk(term);

        return resultTerms.some((resultTerm) => {
            if (isCjkTerm || this.containsCjk(resultTerm)) {
                return resultTerm.includes(term) || term.includes(resultTerm);
            }

            return resultTerm === term;
        });
    }

    private hasProximityMatch(resultTerms: string[], terms: string[]): boolean {
        if (!resultTerms.length || terms.length < 2) {
            return false;
        }

        const allPositions = terms
            .flatMap((term) =>
                resultTerms.reduce((positions, resultTerm, idx) => {
                    if (this.hasTermMatch([resultTerm], term)) {
                        positions.push(idx);
                    }
                    return positions;
                }, [] as number[])
            )
            .sort((a, b) => a - b);

        if (allPositions.length < 2) {
            return false;
        }

        for (let i = 0; i < allPositions.length - 1; i++) {
            if (
                Math.abs(allPositions[i] - allPositions[i + 1]) <=
                this.proximityWindow
            ) {
                elizaLogger.debug("[Proximity Match]", {
                    terms,
                    positions: allPositions,
                    matchFound: `${allPositions[i]} - ${allPositions[i + 1]}`,
                });
                return true;
            }
        }

        return false;
    }

    private rerankKnowledgeResults(
        processedQuery: string,
        results: RAGKnowledgeItem[]
    ): RAGKnowledgeItem[] {
        const queryTerms = this.getQueryTerms(processedQuery);
        const rerankedResults: Array<
            RAGKnowledgeItem & { score: number; matchedTerms: string[] }
        > = results.map((result) => {
            let score = result.similarity;
            const normalizedResultText = this.preprocess(result.content.text);
            const resultTerms = this.tokenizeMultilingualText(
                normalizedResultText
            );
            const matchingTerms = queryTerms.filter((term) =>
                this.hasTermMatch(resultTerms, term)
            );
            const termCoverage =
                queryTerms.length > 0
                    ? matchingTerms.length / queryTerms.length
                    : 0;
            const hasExactPhraseMatch =
                processedQuery.length > 0 &&
                normalizedResultText.includes(processedQuery);

            if (hasExactPhraseMatch) {
                score += this.exactPhraseBoost;
            }

            if (termCoverage > 0) {
                score += termCoverage * this.termCoverageWeight;
            }

            if (
                matchingTerms.length > 1 &&
                this.hasProximityMatch(resultTerms, matchingTerms)
            ) {
                score += this.proximityBoost;
            }

            return {
                ...result,
                score,
                matchedTerms: matchingTerms,
            };
        });

        return rerankedResults
            .sort((a, b) => b.score - a.score)
            .filter(
                (result) => result.score >= this.defaultRAGResultThreshold
            );
    }

    async getKnowledge(params: {
        query?: string;
        id?: UUID;
        conversationContext?: string;
        limit?: number;
        agentId?: UUID;
    }): Promise<RAGKnowledgeItem[]> {
        const agentId = params.agentId || this.runtime.agentId;

        // If id is provided, do direct lookup first
        if (params.id) {
            const directResults =
                await this.runtime.databaseAdapter.getKnowledge({
                    id: params.id,
                    agentId: agentId,
                });

            if (directResults.length > 0) {
                return directResults;
            }
        }

        // If no id or no direct results, perform semantic search
        if (params.query) {
            try {
                const processedQuery = this.preprocess(params.query);

                // Build search text with optional context
                let searchText = processedQuery;
                if (params.conversationContext) {
                    const relevantContext = this.preprocess(
                        params.conversationContext
                    );
                    searchText = `${relevantContext} ${processedQuery}`;
                }

                const embeddingArray = await embed(this.runtime, searchText);

                const embedding = new Float32Array(embeddingArray);

                const results =
                    await this.runtime.databaseAdapter.searchKnowledge({
                        agentId,
                        embedding,
                        match_threshold: this.defaultRAGCandidateThreshold,
                        match_count: this.getCandidateMatchCount(params.limit),
                        searchText: processedQuery,
                    });

                const reranked = this.rerankKnowledgeResults(processedQuery, results);
                // §5.3 — plugin-supplied hybrid retriever override.
                // When a plugin (currently plugin-cex) exposes
                // rerankKnowledgeCandidates on its cexSpecProvider,
                // delegate to it; the local term-coverage rerank above
                // produces the candidate set this works against.
                const provider = this.runtime.plugins?.find((p) => p.cexSpecProvider?.rerankKnowledgeCandidates)?.cexSpecProvider;
                if (provider?.rerankKnowledgeCandidates) {
                    try {
                        const candidates = reranked.map((r) => ({
                            id: String(r.id),
                            text: r.content?.text ?? "",
                            embedding: undefined as number[] | undefined,
                            trustTier: (r.content?.metadata as Record<string, unknown> | undefined)?.trustTier as "A" | "B" | "C" | undefined,
                            publishedAt: (r.content?.metadata as Record<string, unknown> | undefined)?.publishedAt as string | undefined,
                            symbols: (r.content?.metadata as Record<string, unknown> | undefined)?.symbols as string[] | undefined,
                        }));
                        const limit = params.limit || this.defaultRAGMatchCount;
                        const out = provider.rerankKnowledgeCandidates({
                            query: processedQuery,
                            topK: limit,
                            candidates,
                        });
                        const byId = new Map(reranked.map((r) => [String(r.id), r]));
                        const ordered = out.rankedIds
                            .map((id) => byId.get(id))
                            .filter((x): x is RAGKnowledgeItem & { score: number; matchedTerms: string[] } => !!x);
                        if (ordered.length > 0) return ordered.slice(0, limit);
                    } catch (err) {
                        console.log(`[RAG Hybrid Rerank Error] ${err}`);
                    }
                }
                return reranked.slice(0, params.limit || this.defaultRAGMatchCount);
            } catch (error) {
                console.log(`[RAG Search Error] ${error}`);
                return [];
            }
        }

        // If neither id nor query provided, return empty array
        return [];
    }

    async createKnowledge(item: RAGKnowledgeItem): Promise<void> {
        if (!item.content.text) {
            elizaLogger.warn("Empty content in knowledge item");
            return;
        }

        try {
            // Process main document
            const processedContent = this.preprocess(item.content.text);
            const mainEmbeddingArray = await embed(
                this.runtime,
                processedContent
            );

            const mainEmbedding = new Float32Array(mainEmbeddingArray);

            // Create main document
            await this.runtime.databaseAdapter.createKnowledge({
                id: item.id,
                agentId: this.runtime.agentId,
                content: {
                    text: item.content.text,
                    metadata: {
                        ...item.content.metadata,
                        isMain: true,
                    },
                },
                embedding: mainEmbedding,
                createdAt: Date.now(),
            });

            // Generate and store chunks
            const chunks = await splitChunks(processedContent, 512, 20);

            for (const [index, chunk] of chunks.entries()) {
                const chunkEmbeddingArray = await embed(this.runtime, chunk);
                const chunkEmbedding = new Float32Array(chunkEmbeddingArray);
                const chunkId = `${item.id}-chunk-${index}` as UUID;

                await this.runtime.databaseAdapter.createKnowledge({
                    id: chunkId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: chunk,
                        metadata: {
                            ...item.content.metadata,
                            isChunk: true,
                            originalId: item.id,
                            chunkIndex: index,
                        },
                    },
                    embedding: chunkEmbedding,
                    createdAt: Date.now(),
                });
            }
        } catch (error) {
            elizaLogger.error(`Error processing knowledge ${item.id}:`, error);
            throw error;
        }
    }

    async searchKnowledge(params: {
        agentId: UUID;
        embedding: Float32Array | number[];
        match_threshold?: number;
        match_count?: number;
        searchText?: string;
    }): Promise<RAGKnowledgeItem[]> {
        const {
            match_threshold = this.defaultRAGCandidateThreshold,
            match_count = this.defaultRAGMatchCount,
            embedding,
            searchText,
        } = params;

        const float32Embedding = Array.isArray(embedding)
            ? new Float32Array(embedding)
            : embedding;

        return await this.runtime.databaseAdapter.searchKnowledge({
            agentId: params.agentId || this.runtime.agentId,
            embedding: float32Embedding,
            match_threshold,
            match_count,
            searchText,
        });
    }

    async removeKnowledge(id: UUID): Promise<void> {
        await this.runtime.databaseAdapter.removeKnowledge(id);
    }

    async clearKnowledge(shared?: boolean): Promise<void> {
        await this.runtime.databaseAdapter.clearKnowledge(
            this.runtime.agentId,
            shared ? shared : false
        );
    }

    /**
     * Lists all knowledge entries for an agent without semantic search or reranking.
     * Used primarily for administrative tasks like cleanup.
     *
     * @param agentId The agent ID to fetch knowledge entries for
     * @returns Array of RAGKnowledgeItem entries
     */
    async listAllKnowledge(agentId: UUID): Promise<RAGKnowledgeItem[]> {
        elizaLogger.debug(
            `[Knowledge List] Fetching all entries for agent: ${agentId}`
        );

        try {
            // Only pass the required agentId parameter
            const results = await this.runtime.databaseAdapter.getKnowledge({
                agentId: agentId,
            });

            elizaLogger.debug(
                `[Knowledge List] Found ${results.length} entries`
            );
            return results;
        } catch (error) {
            elizaLogger.error(
                "[Knowledge List] Error fetching knowledge entries:",
                error
            );
            throw error;
        }
    }

    async cleanupDeletedKnowledgeFiles() {
        try {
            elizaLogger.debug(
                "[Cleanup] Starting knowledge cleanup process, agent: ",
                this.runtime.agentId
            );

            elizaLogger.debug(
                `[Cleanup] Knowledge root path: ${this.knowledgeRoot}`
            );

            const existingKnowledge = await this.listAllKnowledge(
                this.runtime.agentId
            );
            // Only process parent documents, ignore chunks
            const parentDocuments = existingKnowledge.filter(
                (item) =>
                    !item.id.includes("chunk") && item.content.metadata?.source // Must have a source path
            );

            elizaLogger.debug(
                `[Cleanup] Found ${parentDocuments.length} parent documents to check`
            );

            for (const item of parentDocuments) {
                const relativePath = item.content.metadata?.source;
                const filePath = join(this.knowledgeRoot, relativePath);

                elizaLogger.debug(
                    `[Cleanup] Checking joined file path: ${filePath}`
                );

                if (!existsSync(filePath)) {
                    elizaLogger.warn(
                        `[Cleanup] File not found, starting removal process: ${filePath}`
                    );

                    const idToRemove = item.id;
                    elizaLogger.debug(
                        `[Cleanup] Using ID for removal: ${idToRemove}`
                    );

                    try {
                        // Just remove the parent document - this will cascade to chunks
                        await this.removeKnowledge(idToRemove);

                        // // Clean up the cache
                        // const baseCacheKeyWithWildcard = `${this.generateKnowledgeCacheKeyBase(
                        //     idToRemove,
                        //     item.content.metadata?.isShared || false
                        // )}*`;
                        // await this.cacheManager.deleteByPattern({
                        //     keyPattern: baseCacheKeyWithWildcard,
                        // });

                        elizaLogger.success(
                            `[Cleanup] Successfully removed knowledge for file: ${filePath}`
                        );
                    } catch (deleteError) {
                        elizaLogger.error(
                            `[Cleanup] Error during deletion process for ${filePath}:`,
                            deleteError instanceof Error
                                ? {
                                      message: deleteError.message,
                                      stack: deleteError.stack,
                                      name: deleteError.name,
                                  }
                                : deleteError
                        );
                    }
                }
            }

            elizaLogger.debug("[Cleanup] Finished knowledge cleanup process");
        } catch (error) {
            elizaLogger.error(
                "[Cleanup] Error cleaning up deleted knowledge files:",
                error
            );
        }
    }

    public generateScopedId(path: string, isShared: boolean): UUID {
        // Prefix the path with scope before generating UUID to ensure different IDs for shared vs private
        const scope = isShared ? KnowledgeScope.SHARED : KnowledgeScope.PRIVATE;
        const scopedPath = `${scope}-${path}`;
        return stringToUuid(scopedPath);
    }

    async processFile(file: {
        path: string;
        content: string;
        type: "pdf" | "md" | "txt";
        isShared?: boolean;
    }): Promise<void> {
        const timeMarker = (label: string) => {
            const time = (Date.now() - startTime) / 1000;
            elizaLogger.info(`[Timing] ${label}: ${time.toFixed(2)}s`);
        };

        const startTime = Date.now();
        const content = file.content;

        try {
            const fileSizeKB = new TextEncoder().encode(content).length / 1024;
            elizaLogger.info(
                `[File Progress] Starting ${file.path} (${fileSizeKB.toFixed(2)} KB)`
            );

            // Generate scoped ID for the file
            const scopedId = this.generateScopedId(
                file.path,
                file.isShared || false
            );

            // Step 1: Preprocessing
            //const preprocessStart = Date.now();
            const processedContent = this.preprocess(content);
            timeMarker("Preprocessing");

            // Step 2: Main document embedding
            const mainEmbeddingArray = await embed(
                this.runtime,
                processedContent
            );
            const mainEmbedding = new Float32Array(mainEmbeddingArray);
            timeMarker("Main embedding");

            // Step 3: Create main document
            await this.runtime.databaseAdapter.createKnowledge({
                id: scopedId,
                agentId: this.runtime.agentId,
                content: {
                    text: content,
                    metadata: {
                        source: file.path,
                        type: file.type,
                        isShared: file.isShared || false,
                    },
                },
                embedding: mainEmbedding,
                createdAt: Date.now(),
            });
            timeMarker("Main document storage");

            // Step 4: Generate chunks
            const chunks = await splitChunks(processedContent, 512, 20);
            const totalChunks = chunks.length;
            elizaLogger.info(`Generated ${totalChunks} chunks`);
            timeMarker("Chunk generation");

            // Step 5: Process chunks with larger batches
            const BATCH_SIZE = 10; // Increased batch size
            let processedChunks = 0;

            for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
                const batchStart = Date.now();
                const batch = chunks.slice(
                    i,
                    Math.min(i + BATCH_SIZE, chunks.length)
                );

                // Process embeddings in parallel
                const embeddings = await Promise.all(
                    batch.map((chunk) => embed(this.runtime, chunk))
                );

                // Batch database operations
                await Promise.all(
                    embeddings.map(async (embeddingArray, index) => {
                        const chunkId =
                            `${scopedId}-chunk-${i + index}` as UUID;
                        const chunkEmbedding = new Float32Array(embeddingArray);

                        await this.runtime.databaseAdapter.createKnowledge({
                            id: chunkId,
                            agentId: this.runtime.agentId,
                            content: {
                                text: batch[index],
                                metadata: {
                                    source: file.path,
                                    type: file.type,
                                    isShared: file.isShared || false,
                                    isChunk: true,
                                    originalId: scopedId,
                                    chunkIndex: i + index,
                                    originalPath: file.path,
                                },
                            },
                            embedding: chunkEmbedding,
                            createdAt: Date.now(),
                        });
                    })
                );

                processedChunks += batch.length;
                const batchTime = (Date.now() - batchStart) / 1000;
                elizaLogger.info(
                    `[Batch Progress] ${file.path}: Processed ${processedChunks}/${totalChunks} chunks (${batchTime.toFixed(2)}s for batch)`
                );
            }

            const totalTime = (Date.now() - startTime) / 1000;
            elizaLogger.info(
                `[Complete] Processed ${file.path} in ${totalTime.toFixed(2)}s`
            );
        } catch (error) {
            if (
                file.isShared &&
                error?.code === "SQLITE_CONSTRAINT_PRIMARYKEY"
            ) {
                elizaLogger.info(
                    `Shared knowledge ${file.path} already exists in database, skipping creation`
                );
                return;
            }
            elizaLogger.error(`Error processing file ${file.path}:`, error);
            throw error;
        }
    }
}
