import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "../packages/adapter-sqlite/node_modules/better-sqlite3/lib/index.js";

import {
    AgentRuntime,
    ModelProviderName,
    stringToUuid,
} from "../packages/core/dist/index.js";
import { SqliteDatabaseAdapter } from "../packages/adapter-sqlite/dist/index.js";

const FIXTURES = [
    {
        path: "rag/sqlite-local-dev.md",
        type: "md",
        content:
            "The adapter-sqlite package is a good choice for local RAG development. " +
            "It stores vector embeddings in SQLite, which makes offline testing and local debugging simple.",
    },
    {
        path: "rag/streaming.md",
        type: "md",
        content:
            "Streaming responses send partial tokens to the client while background tools continue running. " +
            "This reduces perceived latency for long workflows.",
    },
    {
        path: "rag/chunking.md",
        type: "md",
        content:
            "Long knowledge documents are split into chunks during ingestion. " +
            "The current chunk size is 512 and the overlap is 20.",
    },
    {
        path: "rag/rerank.md",
        type: "md",
        content:
            "After vector recall, the RAG reranker combines vector similarity, exact phrase matches, " +
            "term coverage, and proximity signals before final filtering.",
    },
    {
        path: "rag/shared-knowledge.md",
        type: "md",
        content:
            "A knowledge row becomes globally shared when isShared is set to 1 and agentId is null. " +
            "Those shared rows can be retrieved by every agent.",
    },
    {
        path: "rag/zh-embedding.md",
        type: "md",
        content:
            "本地RAG默认使用 Xenova bge-m3 嵌入模型。 " +
            "这个 local embedding model 会生成 1024 维向量，用于知识检索和语义召回。",
    },
    {
        path: "rag/zh-streaming.md",
        type: "md",
        content:
            "流式响应会先把部分 tokens 返回给客户端，同时后台工具继续运行。 " +
            "这样可以降低长流程里的感知延迟。",
    },
    {
        path: "rag/zh-chunking.md",
        type: "md",
        content:
            "导入长文知识时，系统会自动切块。 " +
            "当前默认块大小是 512，块之间的重叠是 20。",
    },
    {
        path: "rag/zh-thresholds.md",
        type: "md",
        content:
            "当前RAG会先用较低的候选召回阈值 0.3 找到候选结果，" +
            "再用最终结果阈值 0.45 过滤排序后的答案。",
    },
    {
        path: "rag/zh-cleanup.md",
        type: "md",
        content:
            "测试脚本运行结束后，会自动关闭 SQLite 连接并删除临时数据库目录。 " +
            "这样可以避免留下多余的本地测试数据。",
    },
];

const QUERIES = [
    {
        language: "en",
        query: "Which adapter is suitable for local offline vector search development?",
        expectedSource: "rag/sqlite-local-dev.md",
    },
    {
        language: "en",
        query: "Which database package is used for local offline vector embeddings?",
        expectedSource: "rag/sqlite-local-dev.md",
    },
    {
        language: "en",
        query: "What gets sent back to the client while long-running tools continue?",
        expectedSource: "rag/streaming.md",
    },
    {
        language: "en",
        query: "Why does streaming reduce perceived latency for long workflows?",
        expectedSource: "rag/streaming.md",
    },
    {
        language: "en",
        query: "What chunk size is used when long knowledge documents are split?",
        expectedSource: "rag/chunking.md",
    },
    {
        language: "en",
        query: "How much overlap is used between knowledge chunks?",
        expectedSource: "rag/chunking.md",
    },
    {
        language: "en",
        query: "Which signals does the reranker combine after vector recall?",
        expectedSource: "rag/rerank.md",
    },
    {
        language: "en",
        query: "Does the reranker use exact phrase matches and proximity boosts?",
        expectedSource: "rag/rerank.md",
    },
    {
        language: "en",
        query: "When is shared knowledge visible to every agent?",
        expectedSource: "rag/shared-knowledge.md",
    },
    {
        language: "en",
        query: "How can a knowledge row be globally shared across agents?",
        expectedSource: "rag/shared-knowledge.md",
    },
    {
        language: "zh",
        query: "本地RAG默认用什么嵌入模型？",
        expectedSource: "rag/zh-embedding.md",
    },
    {
        language: "zh",
        query: "本地 embedding model 会生成多少维向量？",
        expectedSource: "rag/zh-embedding.md",
    },
    {
        language: "zh",
        query: "长时间运行的工具继续执行时，客户端会先收到什么？",
        expectedSource: "rag/zh-streaming.md",
    },
    {
        language: "zh",
        query: "流式响应为什么能降低感知延迟？",
        expectedSource: "rag/zh-streaming.md",
    },
    {
        language: "zh",
        query: "导入长文知识时，默认会切成多大的块？",
        expectedSource: "rag/zh-chunking.md",
    },
    {
        language: "zh",
        query: "知识切块默认重叠多少？",
        expectedSource: "rag/zh-chunking.md",
    },
    {
        language: "zh",
        query: "当前RAG候选召回阈值和最终结果阈值分别是多少？",
        expectedSource: "rag/zh-thresholds.md",
    },
    {
        language: "zh",
        query: "中文RAG现在是先低阈值召回再最终过滤吗？",
        expectedSource: "rag/zh-thresholds.md",
    },
    {
        language: "zh",
        query: "测试脚本跑完以后，临时 sqlite 数据库会怎么处理？",
        expectedSource: "rag/zh-cleanup.md",
    },
    {
        language: "zh",
        query: "RAG 测试结束后会自动清理临时目录吗？",
        expectedSource: "rag/zh-cleanup.md",
    },
];

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function formatResult(result) {
    const source = result.content?.metadata?.source ?? "unknown";
    const text = (result.content?.text ?? "").replace(/\s+/g, " ").slice(0, 120);
    const similarity =
        typeof result.similarity === "number"
            ? result.similarity.toFixed(4)
            : "n/a";

    return { source, text, similarity };
}

function summarizeCases() {
    const counts = QUERIES.reduce(
        (summary, item) => {
            summary.total += 1;
            summary[item.language] += 1;
            return summary;
        },
        { total: 0, en: 0, zh: 0 }
    );

    console.log(
        `[RAG Test 20] Loaded ${FIXTURES.length} fixtures and ${counts.total} queries (${counts.en} EN, ${counts.zh} ZH)`
    );
}

async function main() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sentiedge-rag-20-"));
    const dbPath = path.join(tempDir, "rag-test-20.sqlite");

    console.log(`[RAG Test 20] Temp DB: ${dbPath}`);
    summarizeCases();

    const sqlite = new Database(dbPath);
    const adapter = new SqliteDatabaseAdapter(sqlite);

    try {
        await adapter.init();

        const runtime = new AgentRuntime({
            token: "local-rag-test-20-token",
            character: {
                id: stringToUuid("rag-test-agent-20"),
                name: "RAG Test Agent 20",
                username: "rag-test-agent-20",
                modelProvider: ModelProviderName.OLLAMA,
                plugins: [],
                settings: {
                    secrets: {},
                },
                system: "Test character for bilingual RAG validation.",
                bio: ["Bilingual RAG validation agent"],
                lore: ["Used for 20-case retrieval checks"],
                messageExamples: [],
                postExamples: [],
                topics: [],
                adjectives: [],
                style: {
                    all: [],
                    chat: [],
                    post: [],
                },
            },
            databaseAdapter: adapter,
            modelProvider: ModelProviderName.OLLAMA,
        });

        await adapter.createAccount({
            id: runtime.agentId,
            name: runtime.character.name,
            username: runtime.character.username,
            email: "rag-test-agent-20@example.com",
            details: {
                source: "rag-test-script-20",
            },
        });

        console.log("[RAG Test 20] Ingesting fixture knowledge...");
        for (const fixture of FIXTURES) {
            await runtime.ragKnowledgeManager.processFile(fixture);
            console.log(`  stored ${fixture.path}`);
        }

        const allKnowledge = await runtime.ragKnowledgeManager.listAllKnowledge(
            runtime.agentId
        );
        const mainDocuments = allKnowledge.filter(
            (item) => item.content?.metadata?.isChunk !== true
        );

        assert(
            mainDocuments.length === FIXTURES.length,
            `Expected ${FIXTURES.length} main knowledge documents, got ${mainDocuments.length}`
        );

        console.log(
            `[RAG Test 20] Stored ${allKnowledge.length} total rows (${mainDocuments.length} main documents)`
        );

        let passed = 0;
        const summary = { en: 0, zh: 0 };

        for (const testCase of QUERIES) {
            const results = await runtime.ragKnowledgeManager.getKnowledge({
                query: testCase.query,
                limit: 3,
            });

            assert(results.length > 0, `No RAG results for query: ${testCase.query}`);

            const top = formatResult(results[0]);
            console.log(`\n[RAG Query ${testCase.language.toUpperCase()}] ${testCase.query}`);
            console.log(
                `  top source=${top.source} similarity=${top.similarity} snippet="${top.text}"`
            );

            assert(
                top.source === testCase.expectedSource,
                `Expected top source ${testCase.expectedSource}, got ${top.source}`
            );

            passed += 1;
            summary[testCase.language] += 1;
        }

        console.log(
            `\n[RAG Test 20] Passed ${passed}/${QUERIES.length} retrieval checks (${summary.en} EN, ${summary.zh} ZH).`
        );
    } finally {
        await adapter.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error("\n[RAG Test 20] Failed.");
    console.error(error);
    process.exitCode = 1;
});
