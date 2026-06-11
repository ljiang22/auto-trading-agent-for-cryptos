import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Keep script output clean: suppress framework logs, deprecation warnings, and LangSmith tracing noise.
process.env.DEFAULT_LOG_LEVEL = "fatal";
process.env.LOG_JSON_FORMAT = "true";
process.env.LANGCHAIN_TRACING_V2 = "false";
process.env.LANGSMITH_TRACING_V2 = "false";
process.env.LANGCHAIN_API_KEY = "";
process.env.LANGSMITH_API_KEY = "";
process.env.LANGCHAIN_ENDPOINT = "";
process.env.LANGSMITH_ENDPOINT = "";
process.env.NODE_NO_WARNINGS = "1";
process.noDeprecation = true;

const CLASSIFICATION_TYPES = [
    "REGULAR_MESSAGE",
    "CEX_WORKFLOW_MESSAGE",
    "TASK_CHAIN_MESSAGE",
    "COMPREHENSIVE_ANALYSIS_MESSAGE",
];

const DEFAULT_CASES_PATH = fileURLToPath(
    new URL("./fixtures/message-classification-cases.json", import.meta.url)
);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
    const args = new Map();
    for (let i = 2; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith("--")) continue;
        const [key, inlineValue] = token.slice(2).split("=", 2);
        if (inlineValue !== undefined) {
            args.set(key, inlineValue);
            continue;
        }
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
            args.set(key, next);
            i += 1;
            continue;
        }
        args.set(key, true);
    }
    return args;
}

function resolveModelProvider(providerArg, modelProviderNameEnum) {
    if (!providerArg) return modelProviderNameEnum.GOOGLE;
    const normalized = String(providerArg).trim().toLowerCase();
    const candidates = Object.values(modelProviderNameEnum);
    const match = candidates.find((value) => String(value).toLowerCase() === normalized);
    if (!match) {
        throw new Error(`Unknown model provider: ${providerArg}. Known: ${candidates.join(", ")}`);
    }
    return match;
}

function printUsage() {
    // eslint-disable-next-line no-console
    console.log([
        "Usage:",
        "  node scripts/test-message-classification.mjs --provider google",
        "  node scripts/test-message-classification.mjs --cases scripts/fixtures/message-classification-cases.json",
        "  node scripts/test-message-classification.mjs --timeoutMs 60000 --verbose",
        "",
        "Flags:",
        "  --provider   Model provider name (default: google)",
        `  --cases      Path to classification cases JSON (default: ${relative(process.cwd(), DEFAULT_CASES_PATH)})`,
        "  --timeoutMs  Per-request timeout in ms (default: 60000)",
        "  --verbose    Print all results, not just failures",
        "  --json       Print failures as JSON and exit with code 1 if any fail",
        "",
        "Notes:",
        "- For Google (Vertex): GOOGLE_VERTEX_PROJECT, GOOGLE_APPLICATION_CREDENTIALS_JSON, etc.",
        "- Tests run sequentially to avoid getMemories mock collision.",
        "- Cases are loaded from an external JSON fixture.",
        "- Outputs per-classification pass rates in addition to the overall total.",
    ].join("\n"));
}

function resolveCasesPath(casesPathArg) {
    if (!casesPathArg) {
        return DEFAULT_CASES_PATH;
    }
    return isAbsolute(casesPathArg)
        ? casesPathArg
        : resolve(process.cwd(), casesPathArg);
}

function assertNonEmptyString(value, fieldName) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`${fieldName} must be a non-empty string`);
    }
    return value.trim();
}

function normalizeContextEntry(entry, caseId, entryIndex, agentId, userId) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`Case ${caseId} context[${entryIndex}] must be an object`);
    }

    const speaker = assertNonEmptyString(entry.speaker, `Case ${caseId} context[${entryIndex}].speaker`);
    if (!["user", "agent"].includes(speaker)) {
        throw new Error(`Case ${caseId} context[${entryIndex}].speaker must be "user" or "agent"`);
    }

    const text = assertNonEmptyString(entry.text, `Case ${caseId} context[${entryIndex}].text`);
    const source = entry.source === undefined
        ? (speaker === "agent" ? "assistant" : "user")
        : assertNonEmptyString(entry.source, `Case ${caseId} context[${entryIndex}].source`);

    return {
        userId: speaker === "agent" ? agentId : userId,
        source,
        text,
    };
}

function normalizeCase(rawCase, index, agentId, userId) {
    if (!rawCase || typeof rawCase !== "object" || Array.isArray(rawCase)) {
        throw new Error(`Case #${index} must be an object`);
    }

    const id = rawCase.id === undefined
        ? `case-${String(index).padStart(3, "0")}`
        : assertNonEmptyString(rawCase.id, `Case #${index} id`);
    const label = assertNonEmptyString(rawCase.label, `Case ${id} label`);
    const text = assertNonEmptyString(rawCase.text, `Case ${id} text`);
    const expected = assertNonEmptyString(rawCase.expected, `Case ${id} expected`);

    if (!CLASSIFICATION_TYPES.includes(expected)) {
        throw new Error(`Case ${id} expected must be one of ${CLASSIFICATION_TYPES.join(", ")}`);
    }

    if (rawCase.context !== undefined && !Array.isArray(rawCase.context)) {
        throw new Error(`Case ${id} context must be an array when provided`);
    }

    const context = (rawCase.context ?? []).map((entry, entryIndex) =>
        normalizeContextEntry(entry, id, entryIndex, agentId, userId)
    );

    return {
        id,
        label,
        text,
        expected,
        context,
        notes: typeof rawCase.notes === "string" ? rawCase.notes : "",
    };
}

async function loadTestCases(casesPathArg, agentId, userId) {
    const casesPath = resolveCasesPath(casesPathArg);
    const fileContents = await readFile(casesPath, "utf8");
    const parsed = JSON.parse(fileContents);
    const rawCases = Array.isArray(parsed) ? parsed : parsed.cases;

    if (!Array.isArray(rawCases)) {
        throw new Error("Classification fixture must be an array or an object with a cases array");
    }

    return {
        description: typeof parsed?.description === "string" ? parsed.description : "",
        path: casesPath,
        tests: rawCases.map((rawCase, index) => normalizeCase(rawCase, index + 1, agentId, userId)),
    };
}

function printResult(r) {
    const icon = r.ok ? "✓" : "✗";
    const conf = `conf=${r.confidence.toFixed(2)}`;
    // eslint-disable-next-line no-console
    console.log(`${icon} #${String(r.index).padStart(3, "0")} [${r.id}] ${conf} got=${r.got} | ${r.label}`);
    if (!r.ok) {
        // eslint-disable-next-line no-console
        console.log(`        expected=${r.expected}${r.error ? ` error=${JSON.stringify(r.error)}` : ""}`);
        if (r.reasoning) {
            // eslint-disable-next-line no-console
            console.log(`        reasoning: ${r.reasoning}`);
        }
        if (r.notes) {
            // eslint-disable-next-line no-console
            console.log(`        notes: ${r.notes}`);
        }
    }
}

function printClassificationSummary(results) {
    // eslint-disable-next-line no-console
    console.log("By expected classification:");

    for (const classificationType of CLASSIFICATION_TYPES) {
        const scopedResults = results.filter((result) => result.expected === classificationType);
        if (scopedResults.length === 0) continue;

        const passed = scopedResults.filter((result) => result.ok).length;
        // eslint-disable-next-line no-console
        console.log(`  ${classificationType}: ${passed}/${scopedResults.length} passed`);
    }
}

async function runContextualTests({ runtime, precheck, userId, roomId, tests, timeoutMs }) {
    const results = [];

    for (let i = 0; i < tests.length; i++) {
        const test = tests[i];

        // Build fake Memory objects from context spec
        const contextMemories = (test.context ?? []).map((msg, j) => ({
            id: crypto.randomUUID(),
            userId: msg.userId,
            agentId: runtime.agentId,
            roomId,
            createdAt: Date.now() - (test.context.length - j) * 1000,
            content: {
                text: msg.text,
                source: msg.source,
            },
        }));

        // Temporarily override getMemories on the messageManager
        const originalGetMemories = runtime.messageManager.getMemories.bind(runtime.messageManager);
        runtime.messageManager.getMemories = async ({ roomId: _roomId, count }) => {
            return contextMemories.slice(-count);
        };

        const message = {
            id: crypto.randomUUID(),
            userId,
            agentId: runtime.agentId,
            roomId,
            createdAt: Date.now(),
            content: { text: test.text },
        };

        try {
            const classification = await Promise.race([
                precheck.classifyMessage(message),
                sleep(timeoutMs).then(() => { throw new Error(`Timeout after ${timeoutMs}ms`); }),
            ]);
            results.push({
                index: i + 1,
                id: test.id,
                label: test.label,
                text: test.text,
                expected: test.expected,
                got: classification.classification,
                confidence: classification.confidence,
                reasoning: classification.reasoning,
                isCryptoRelated: classification.isCryptoRelated,
                notes: test.notes,
                ok: classification.classification === test.expected,
            });
        } catch (error) {
            results.push({
                index: i + 1,
                id: test.id,
                label: test.label,
                text: test.text,
                expected: test.expected,
                got: "ERROR",
                confidence: 0,
                isCryptoRelated: false,
                notes: test.notes,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        } finally {
            // Restore original
            runtime.messageManager.getMemories = originalGetMemories;
        }
    }

    return results;
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.has("help")) {
        printUsage();
        process.exit(0);
    }

    const { AgentRuntime, ModelProviderName } = await import("../packages/core/dist/index.js");

    const provider = resolveModelProvider(args.get("provider") ?? process.env.MODEL_PROVIDER, ModelProviderName);
    const casesPathArg = args.get("cases");
    const timeoutMs = Number(args.get("timeoutMs") ?? process.env.CLASSIFICATION_TIMEOUT_MS ?? 60000);
    const verbose = args.has("verbose");
    const jsonMode = args.has("json");

    const databaseAdapter = {
        getAccountById: async () => null,
        saveTokenUsage: async () => {},
    };

    const character = {
        name: "ClassificationTester",
        username: "classification-tester",
        system: "You are a helpful assistant.",
        modelProvider: provider,
        bio: "Test character for message classification.",
        lore: [],
        messageExamples: [],
        postExamples: [],
        topics: [],
        adjectives: [],
        plugins: [],
        settings: { secrets: {} },
    };

    const runtime = new AgentRuntime({ character, modelProvider: provider, databaseAdapter });

    const placeholderActions = [
        { name: "GET_CEX_ORDER", description: "Lookup a CEX order by exchange + orderId." },
        { name: "GET_CEX_FILLS", description: "Fetch CEX fills/trades by exchange + symbol + time range." },
        { name: "GET_CEX_POSITION", description: "Fetch CEX position details (PnL, funding, leverage)." },
        { name: "GET_CEX_FUNDING", description: "Fetch funding payments by exchange + symbol + time range." },
    ];
    for (const { name, description } of placeholderActions) {
        runtime.registerAction({
            name,
            description,
            handler: async () => { throw new Error(`${name} is a placeholder action for classification tests.`); },
            examples: [],
        });
    }

    const precheck = runtime.getMessagePrecheckService();
    const roomId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const { description, path: casesPath, tests } = await loadTestCases(casesPathArg, runtime.agentId, userId);
    const displayPath = relative(process.cwd(), casesPath) || casesPath;

    // eslint-disable-next-line no-console
    console.log("\n═══════════════════════════════════════════════════");
    // eslint-disable-next-line no-console
    console.log("  Message classification workflow tests");
    // eslint-disable-next-line no-console
    console.log("═══════════════════════════════════════════════════\n");
    // eslint-disable-next-line no-console
    console.log(`Loaded ${tests.length} cases from ${displayPath}`);
    if (description) {
        // eslint-disable-next-line no-console
        console.log(description);
    }

    const results = await runContextualTests({ runtime, precheck, userId, roomId, tests, timeoutMs });

    const failures = results.filter((r) => !r.ok);
    if (verbose) {
        for (const r of results) printResult(r);
    } else {
        for (const r of failures) printResult(r);
    }

    // eslint-disable-next-line no-console
    console.log(`\n──────────────────────────────────────────────────`);
    printClassificationSummary(results);
    // eslint-disable-next-line no-console
    console.log("──────────────────────────────────────────────────");
    // eslint-disable-next-line no-console
    console.log(`Total: ${results.length - failures.length}/${results.length} passed`);

    if (jsonMode) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(failures, null, 2));
    }

    process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
});
