import { beforeEach, describe, expect, it, vi } from "vitest";
import { embed } from "../src/ai/embedding.ts";
import type { IAgentRuntime, RAGKnowledgeItem, UUID } from "../src/core/types.ts";
import { RAGKnowledgeManager } from "../src/data/ragknowledge.ts";

vi.mock("../src/ai/embedding.ts", () => ({
    embed: vi.fn(),
}));

const agentId = "test-agent" as UUID;

function createKnowledgeItem(
    id: string,
    text: string,
    similarity: number,
    source: string
): RAGKnowledgeItem {
    return {
        id: id as UUID,
        agentId,
        content: {
            text,
            metadata: {
                source,
            },
        },
        createdAt: Date.now(),
        similarity,
    };
}

function createManager(results: RAGKnowledgeItem[]) {
    const searchKnowledge = vi.fn().mockResolvedValue(results);
    const getKnowledge = vi.fn().mockResolvedValue([]);
    const runtime = {
        agentId,
        databaseAdapter: {
            searchKnowledge,
            getKnowledge,
        },
    } as unknown as IAgentRuntime;

    return {
        manager: new RAGKnowledgeManager({
            tableName: "knowledge",
            runtime,
            knowledgeRoot: "/tmp",
        }),
        searchKnowledge,
    };
}

describe("RAGKnowledgeManager", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(embed).mockResolvedValue([0.12, 0.34, 0.56]);
    });

    it("reranks Chinese same-language matches above vector-only candidates", async () => {
        const { manager, searchKnowledge } = createManager([
            createKnowledgeItem(
                "en-model",
                "The default local embedding model is Xenova bge-m3 for retrieval tasks.",
                0.58,
                "rag/en-model.md"
            ),
            createKnowledgeItem(
                "zh-model",
                "本地RAG默认使用 Xenova bge-m3 嵌入模型，用于知识检索和语义召回。",
                0.54,
                "rag/zh-model.md"
            ),
        ]);

        const results = await manager.getKnowledge({
            query: "本地RAG默认用什么嵌入模型？",
            limit: 2,
        });

        expect(searchKnowledge).toHaveBeenCalledWith(
            expect.objectContaining({
                agentId,
                match_threshold: 0.3,
                match_count: 6,
            })
        );
        expect(results).toHaveLength(2);
        expect(results[0].content.metadata?.source).toBe("rag/zh-model.md");
    });

    it("keeps English phrase matches at the top after reranking", async () => {
        const { manager } = createManager([
            createKnowledgeItem(
                "zh-sqlite",
                "SQLite 适合本地离线向量检索开发，也方便做 RAG 调试。",
                0.56,
                "rag/zh-sqlite.md"
            ),
            createKnowledgeItem(
                "en-sqlite",
                "The adapter-sqlite package is a good choice for local offline vector search development.",
                0.52,
                "rag/en-sqlite.md"
            ),
        ]);

        const results = await manager.getKnowledge({
            query: "Which adapter is suitable for local offline vector search development?",
            limit: 2,
        });

        expect(results[0].content.metadata?.source).toBe("rag/en-sqlite.md");
    });

    it("handles mixed-language queries without dropping the relevant Chinese document", async () => {
        const { manager } = createManager([
            createKnowledgeItem(
                "irrelevant",
                "Streaming responses return partial tokens while tools continue running in the background.",
                0.5,
                "rag/streaming.md"
            ),
            createKnowledgeItem(
                "zh-model",
                "本地RAG默认使用 Xenova bge-m3 embedding model，用于知识检索和语义召回。",
                0.48,
                "rag/zh-model.md"
            ),
        ]);

        const results = await manager.getKnowledge({
            query: "local RAG 默认使用什么 embedding model?",
            limit: 2,
        });

        expect(results[0].content.metadata?.source).toBe("rag/zh-model.md");
    });

    it("filters weak candidates that only pass vector recall", async () => {
        const { manager } = createManager([
            createKnowledgeItem(
                "weak",
                "A generic document about unrelated workflows and deployment notes.",
                0.44,
                "rag/irrelevant.md"
            ),
        ]);

        const results = await manager.getKnowledge({
            query: "Which adapter is suitable for local offline vector search development?",
            limit: 2,
        });

        expect(results).toEqual([]);
    });
});
