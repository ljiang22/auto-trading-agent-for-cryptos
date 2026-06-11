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
        path: "rag/zh-embedding.md",
        type: "md",
        content:
            "本地RAG默认使用 Xenova bge-m3 嵌入模型，也就是 local embedding model。 " +
            "这个模型会生成 1024 维向量，用于知识检索和语义召回。",
    },
    {
        path: "rag/streaming.md",
        type: "md",
        content:
            "Streaming responses send partial tokens to the client while background tools continue running. " +
            "This reduces perceived latency for long workflows.",
    },
    {
        path: "rag/zh-streaming.md",
        type: "md",
        content:
            "流式响应会先把部分 tokens 返回给客户端，同时后台工具继续运行。 " +
            "这样可以降低长流程里的感知延迟。",
    },
];

const QUERIES = [
    {
        query: "本地RAG默认用什么嵌入模型？",
        expectedSource: "rag/zh-embedding.md",
    },
    {
        query: "Which adapter is suitable for local offline vector search development?",
        expectedSource: "rag/sqlite-local-dev.md",
    },
    {
        query: "What gets sent back to the client while long-running tools continue?",
        expectedSource: "rag/streaming.md",
    },
    {
        query: "长时间运行的工具继续执行时，客户端会先收到什么？",
        expectedSource: "rag/zh-streaming.md",
    },
    {
        query: "local RAG 默认使用什么 embedding model?",
        expectedSource: "rag/zh-embedding.md",
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

async function main() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sentiedge-rag-"));
    const dbPath = path.join(tempDir, "rag-test.sqlite");

    console.log(`[RAG Test] Temp DB: ${dbPath}`);

    const sqlite = new Database(dbPath);
    const adapter = new SqliteDatabaseAdapter(sqlite);

    try {
        await adapter.init();

        const runtime = new AgentRuntime({
            token: "local-rag-test-token",
            character: {
                id: stringToUuid("rag-test-agent"),
                name: "RAG Test Agent",
                username: "rag-test-agent",
                modelProvider: ModelProviderName.OLLAMA,
                plugins: [],
                settings: {
                    secrets: {},
                },
                system: "Test character for local RAG validation.",
                bio: ["RAG validation agent"],
                lore: ["Used for end-to-end retrieval checks"],
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
            email: "rag-test-agent@example.com",
            details: {
                source: "rag-test-script",
            },
        });

        console.log("[RAG Test] Ingesting fixture knowledge...");
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
            `[RAG Test] Stored ${allKnowledge.length} total rows (${mainDocuments.length} main documents)`
        );

        let passed = 0;
        for (const testCase of QUERIES) {
            const results = await runtime.ragKnowledgeManager.getKnowledge({
                query: testCase.query,
                limit: 3,
            });

            assert(results.length > 0, `No RAG results for query: ${testCase.query}`);

            const top = formatResult(results[0]);
            console.log(`\n[RAG Query] ${testCase.query}`);
            console.log(
                `  top source=${top.source} similarity=${top.similarity} snippet="${top.text}"`
            );

            assert(
                top.source === testCase.expectedSource,
                `Expected top source ${testCase.expectedSource}, got ${top.source}`
            );

            passed += 1;
        }

        console.log(`\n[RAG Test] Passed ${passed}/${QUERIES.length} retrieval checks.`);
    } finally {
        await adapter.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error("\n[RAG Test] Failed.");
    console.error(error);
    process.exitCode = 1;
});
