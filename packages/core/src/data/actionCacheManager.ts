/**
 * ActionCacheManager - Manages public memory cache for action results
 *
 * Stores action results with embeddings for semantic retrieval.
 * Allows similar queries to reuse cached results instead of calling APIs.
 */

import { embed } from "../ai/embedding.ts";
import elizaLogger from "../utils/logger.ts";
import { chunkText, type ChunkOptions } from "../utils/textChunker.ts";
import type {
    CachedActionResult,
    IAgentRuntime,
    UUID,
} from "../core/types.ts";
import { v4 as uuidv4 } from "uuid";

const DEFAULT_SIMILARITY_THRESHOLD = 0.7;
const DEFAULT_MATCH_COUNT = 5;
const DEFAULT_CHUNK_SIZE = 200;

export interface SearchCacheOptions {
    /** Action name to filter by (optional) */
    actionName?: string;
    /** Minimum similarity threshold (0-1) */
    similarityThreshold?: number;
    /** Minimum similarity threshold comparing user query to cached query (0-1) */
    querySimilarityThreshold?: number;
    /** Maximum number of results to return */
    limit?: number;
}

export interface CacheResultOptions {
    /** Action name */
    actionName: string;
    /** Original query/input */
    query: string;
    /** Action result text */
    result: string;
    /** Time-to-live in seconds */
    ttlSeconds: number;
    /** Maximum chunk size */
    maxChunkSize?: number;
}

/**
 * Manages caching and retrieval of action results as public memory
 */
export class ActionCacheManager {
    runtime: IAgentRuntime;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
    }

    /**
     * Search for cached action results similar to the query
     */
    async searchSimilarResults(
        query: string,
        options: SearchCacheOptions = {}
    ): Promise<CachedActionResult[]> {
        const {
            actionName,
            similarityThreshold = DEFAULT_SIMILARITY_THRESHOLD,
            querySimilarityThreshold = similarityThreshold,
            limit = DEFAULT_MATCH_COUNT,
        } = options;

        try {
            // Generate embedding for the query
            const queryEmbedding = await embed(this.runtime, query);

            // Search database for similar cached results
            const results = await this.runtime.databaseAdapter.searchActionCache({
                queryEmbedding,
                actionName,
                similarityThreshold,
                querySimilarityThreshold,
                limit,
            });

            // Increment hit count for returned results
            if (results.length > 0) {
                const ids = results.map(r => r.id);
                await this.incrementHitCount(ids);
            }

            return results;
        } catch (error) {
            elizaLogger.error("Failed to search action cache:", error);
            return [];
        }
    }

    /**
     * Cache an action result with chunking and embedding
     */
    async cacheActionResult(options: CacheResultOptions): Promise<void> {
        const {
            actionName,
            query,
            result,
            ttlSeconds,
            maxChunkSize = DEFAULT_CHUNK_SIZE,
        } = options;

        try {
            // Generate embedding for the query
            const queryEmbedding = await embed(this.runtime, query);

            // Chunk the result if it's large
            const chunkOptions: ChunkOptions = {
                maxChunkSize,
                overlap: Math.floor(maxChunkSize * 0.1), // 10% overlap
                preserveParagraphs: true,
            };
            const chunks = chunkText(result, chunkOptions);

            // Calculate expiration time
            const now = Date.now();
            const expiresAt = now + (ttlSeconds * 1000);

            // Store each chunk with its embedding
            for (const chunk of chunks) {
                const chunkId = uuidv4() as UUID;

                // Skip chunks whose embedding fails — a zero-vector fallback would
                // poison future cosine-similarity lookups by matching any query.
                let chunkEmbedding: number[];
                try {
                    chunkEmbedding = await embed(this.runtime, chunk.text);
                } catch (error) {
                    elizaLogger.warn(`Failed to embed chunk ${chunk.index + 1}/${chunk.total} for "${actionName}"; skipping chunk:`, error);
                    continue;
                }

                await this.runtime.databaseAdapter.createActionCache({
                    id: chunkId,
                    actionName,
                    query,
                    queryEmbedding,
                    result: chunk.text,
                    chunkIndex: chunk.index,
                    totalChunks: chunk.total,
                    embedding: chunkEmbedding,
                    createdAt: now,
                    expiresAt,
                    hitCount: 0,
                });

                const progress = chunks.length > 0
                    ? Math.round(((chunk.index + 1) / chunks.length) * 100)
                    : 100;
                elizaLogger.debug(
                    `[ActionCache] Chunk ${chunk.index + 1}/${chunks.length} stored for ${actionName} (${progress}% complete)`
                );
            }

            elizaLogger.debug(
                `Cached action result: ${actionName} (${chunks.length} chunks, TTL: ${ttlSeconds}s)`
            );
        } catch (error) {
            elizaLogger.error("Failed to cache action result:", error);
            throw error;
        }
    }

    /**
     * Increment hit count for cached results
     */
    async incrementHitCount(ids: UUID[]): Promise<void> {
        try {
            await this.runtime.databaseAdapter.incrementActionCacheHitCount(ids);
        } catch (error) {
            elizaLogger.warn("Failed to increment cache hit count:", error);
        }
    }

    /**
     * Clean up expired cache entries
     */
    async cleanupExpiredCache(): Promise<number> {
        try {
            const deletedCount = await this.runtime.databaseAdapter.cleanupExpiredActionCache();
            if (deletedCount > 0) {
                elizaLogger.info(`Cleaned up ${deletedCount} expired action cache entries`);
            }
            return deletedCount;
        } catch (error) {
            elizaLogger.error("Failed to cleanup expired cache:", error);
            return 0;
        }
    }

    /**
     * Get cache statistics
     */
    async getCacheStats(): Promise<{
        totalEntries: number;
        totalHits: number;
        actionBreakdown: Record<string, number>;
    }> {
        try {
            return await this.runtime.databaseAdapter.getActionCacheStats();
        } catch (error) {
            elizaLogger.error("Failed to get cache stats:", error);
            return {
                totalEntries: 0,
                totalHits: 0,
                actionBreakdown: {},
            };
        }
    }

    /**
     * Check if similar results exist in cache
     * Quick check without full result retrieval
     */
    async hasSimilarCache(
        query: string,
        actionName?: string,
        threshold: number = DEFAULT_SIMILARITY_THRESHOLD
    ): Promise<boolean> {
        const results = await this.searchSimilarResults(query, {
            actionName,
            similarityThreshold: threshold,
            querySimilarityThreshold: threshold,
            limit: 1,
        });
        return results.length > 0;
    }

    /**
     * Format cached results for context injection
     */
    static formatCacheForContext(results: CachedActionResult[]): string {
        if (results.length === 0) {
            return '';
        }

        const sections: string[] = [];

        // Group by action name
        const grouped = results.reduce((acc, result) => {
            const key = result.actionName;
            if (!acc[key]) {
                acc[key] = [];
            }
            acc[key].push(result);
            return acc;
        }, {} as Record<string, CachedActionResult[]>);

        for (const [actionName, actionResults] of Object.entries(grouped)) {
            const sorted = [...actionResults].sort((a, b) => a.chunkIndex - b.chunkIndex);
            const timestamp = sorted[0].createdAt;
            const timeAgo = ActionCacheManager.formatTimeAgo(timestamp);
            const avgSimilarity = Math.round(
                sorted.reduce((sum, r) => sum + (r.similarity || 0), 0) / sorted.length * 100
            );

            const resultText = sorted.map(r => r.result).join('\n\n');

            sections.push(`### ${actionName}\n*Cached: ${timeAgo} | Similarity: ${avgSimilarity}%*\n\n${resultText}`);
        }

        return sections.join('\n\n---\n\n');
    }

    /**
     * Format timestamp as relative time
     */
    private static formatTimeAgo(timestamp: number): string {
        const seconds = Math.floor((Date.now() - timestamp) / 1000);

        if (seconds < 60) return `${seconds}s ago`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
        return `${Math.floor(seconds / 86400)}d ago`;
    }
}
