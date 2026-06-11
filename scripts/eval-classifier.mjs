#!/usr/bin/env node
/**
 * Classifier accuracy harness.
 *
 * Sends each question from tests/questions/classification_questions.json
 * to a running agent, captures only the `[Runtime] Message classified as:`
 * SSE event, compares to `expectedClassification`, then moves on (no full
 * response wait).
 *
 * Outputs:
 *   - stdout: per-category accuracy + overall accuracy + 4×4 + edge confusion matrix
 *   - tests/questions/classification_eval_results.json: machine-readable run record
 *
 * CLI flags mirror tests/questions/run_questions.mjs where it makes sense.
 */

import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
const DEFAULT_QUESTIONS_PATH = "tests/questions/classification_questions.json";
const DEFAULT_RESULTS_PATH = "tests/questions/classification_eval_results.json";
const DEFAULT_CONCURRENCY = 4;

const CLASSIFICATION_TYPES = new Set([
    "REGULAR_MESSAGE",
    "CEX_WORKFLOW_MESSAGE",
    "TASK_CHAIN_MESSAGE",
    "COMPREHENSIVE_ANALYSIS_MESSAGE",
]);

const MATRIX_COLUMNS = [
    "REGULAR_MESSAGE",
    "CEX_WORKFLOW_MESSAGE",
    "TASK_CHAIN_MESSAGE",
    "COMPREHENSIVE_ANALYSIS_MESSAGE",
    "NONE",
];

function parseArgs(argv) {
    const args = {
        baseUrl: DEFAULT_BASE_URL,
        questionsPath: DEFAULT_QUESTIONS_PATH,
        resultsPath: DEFAULT_RESULTS_PATH,
        agentId: null,
        agentName: null,
        userEmail: null,
        levels: null,
        category: null,
        concurrency: DEFAULT_CONCURRENCY,
        planShape: false,
        planQuestions: null,
        stopAfterClassification: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        switch (arg) {
            case "--server":
            case "--base-url":
                args.baseUrl = argv[i + 1]; i += 1; break;
            case "--questions":
                args.questionsPath = argv[i + 1]; i += 1; break;
            case "--results":
                args.resultsPath = argv[i + 1]; i += 1; break;
            case "--agent":
            case "--agent-id":
                args.agentId = argv[i + 1]; i += 1; break;
            case "--agent-name":
                args.agentName = argv[i + 1]; i += 1; break;
            case "--user-email":
                args.userEmail = argv[i + 1]; i += 1; break;
            case "--levels":
                args.levels = argv[i + 1]; i += 1; break;
            case "--category":
                args.category = argv[i + 1]; i += 1; break;
            case "--concurrency":
                args.concurrency = Number.parseInt(argv[i + 1], 10) || DEFAULT_CONCURRENCY;
                i += 1; break;
            case "--plan-shape":
                args.planShape = true; break;
            case "--plan-questions":
                args.planQuestions = argv[i + 1]; i += 1; break;
            case "--stop-after-classification":
                args.stopAfterClassification = true; break;
            case "--help":
            case "-h":
                printHelp(); process.exit(0); break;
        }
    }
    return args;
}

function printHelp() {
    console.log(`Usage:
  node scripts/eval-classifier.mjs [options]

Options:
  --server URL         Agent base URL (default: ${DEFAULT_BASE_URL})
  --questions PATH     Classification fixture (default: ${DEFAULT_QUESTIONS_PATH})
  --results PATH       Write machine-readable run record (default: ${DEFAULT_RESULTS_PATH})
  --agent UUID         Agent UUID to target (default: first /agents result)
  --agent-name NAME    Agent character name to target
  --user-email EMAIL   Auth user email to set user_info cookie
  --levels CSV         Filter by level field (e.g. "1,2,3")
  --category NAME      Filter to a single category
  --concurrency N      Parallel question slots (default: ${DEFAULT_CONCURRENCY})
  --plan-shape         Enable plan-shape verification (D5)
  --plan-questions P   Use this fixture for --plan-shape runs
  --stop-after-classification
                       After capturing the classifier event, hit /stop
                       on the agent so the in-flight handler aborts.
                       Massively reduces cost when the eval is the only
                       caller. Only safe with --concurrency 1 because
                       /stop is agent-wide.
`);
}

function normalizeBaseUrl(url) {
    return url.endsWith("/") ? url.slice(0, -1) : url;
}

function pickString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function tryParseJsonObject(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch (_e) { /* fall through */ }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
        try {
            const parsed = JSON.parse(trimmed.slice(start, end + 1));
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
        } catch (_e) { return null; }
    }
    return null;
}

// Pull a classification token out of any field that might carry one.
// Real SSE shape (confirmed by /message/stream probe):
//   intermediate_response.response.metadata.classification
//   intermediate_response.response.content.metadata.classification
//   action_response.response.metadata.classification
// Earlier versions of this harness parsed `response.text` as JSON — the
// regular handler does NOT dump JSON into `text` (it sends the natural
// assistant reply), so that path silently returned null for every
// classification.
function normalizeClassificationToken(candidate) {
    if (!candidate || typeof candidate !== "string") return null;
    const normalized = candidate.trim().toUpperCase();
    return CLASSIFICATION_TYPES.has(normalized) ? normalized : null;
}

function extractClassificationFromResponseObj(response) {
    if (!response || typeof response !== "object") return null;
    const r = response;
    // 1) Top-level metadata.
    const topMeta = r.metadata && typeof r.metadata === "object" ? r.metadata : null;
    if (topMeta) {
        const top = normalizeClassificationToken(pickString(topMeta.classification));
        if (top) return top;
    }
    // 2) Nested content.metadata.
    const contentMeta = r.content && typeof r.content === "object" && r.content.metadata && typeof r.content.metadata === "object"
        ? r.content.metadata
        : null;
    if (contentMeta) {
        const nested = normalizeClassificationToken(pickString(contentMeta.classification));
        if (nested) return nested;
    }
    // 3) Fallback for older shapes: JSON dumped into text. Kept so a future
    // change to the regular handler doesn't silently break the harness.
    const textJson = tryParseJsonObject(typeof r.text === "string" ? r.text : "");
    return normalizeClassificationToken(
        pickString(textJson?.classification) ||
        pickString(textJson?.type) ||
        pickString(textJson?.messageType),
    );
}

function extractReasoningFromResponseObj(response) {
    if (!response || typeof response !== "object") return null;
    const r = response;
    const topMeta = r.metadata && typeof r.metadata === "object" ? r.metadata : null;
    if (topMeta && typeof topMeta.classificationReasoning === "string") return topMeta.classificationReasoning;
    const contentMeta = r.content && typeof r.content === "object" && r.content.metadata && typeof r.content.metadata === "object"
        ? r.content.metadata
        : null;
    if (contentMeta && typeof contentMeta.classificationReasoning === "string") return contentMeta.classificationReasoning;
    const textJson = tryParseJsonObject(typeof r.text === "string" ? r.text : "");
    return pickString(textJson?.reasoning);
}

function encodeUserInfoCookie(userInfo) {
    return encodeURIComponent(JSON.stringify(userInfo));
}

function buildHeaders(userInfoCookieValue, extra) {
    const headers = { ...(extra || {}) };
    if (userInfoCookieValue) {
        headers.Cookie = `user_info=${userInfoCookieValue}`;
    }
    return headers;
}

async function fetchJson(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${text}`);
    }
    return response.json();
}

async function resolveAgentId(baseUrl, agentId, agentName) {
    if (agentId) return agentId;
    const data = await fetchJson(`${baseUrl}/agents`);
    const agents = Array.isArray(data.agents) ? data.agents : [];
    if (agents.length === 0) throw new Error("No agents found at /agents");
    if (agentName) {
        const match = agents.find((a) => a.name.toLowerCase() === agentName.toLowerCase());
        if (!match) throw new Error(`Agent name not found: ${agentName}`);
        return match.id;
    }
    if (agents.length === 1) return agents[0].id;
    const summary = agents.map((a) => `${a.name} (${a.id})`).join(", ");
    throw new Error(`Multiple agents found. Use --agent. Available: ${summary}`);
}

async function createRoom(baseUrl, agentId, name, userInfoCookieValue) {
    const data = await fetchJson(`${baseUrl}/agents/${agentId}/rooms`, {
        method: "POST",
        headers: buildHeaders(userInfoCookieValue, { "Content-Type": "application/json" }),
        body: JSON.stringify({ name }),
    });
    if (!data.room?.id) throw new Error(`Failed to create room for "${name}"`);
    return data.room.id;
}

async function loadQuestions(filePath) {
    const absolute = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    const raw = await fs.readFile(absolute, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data.questions)) throw new Error("questions field missing or invalid");
    return data.questions;
}

/**
 * Submit one question. Resolves with the first classification we see — we
 * don't wait for the full assistant turn because per-question runtime cost
 * is dominated by the downstream handler, not the classifier.
 */
async function stopAgent(baseUrl, agentId, userInfoCookieValue) {
    try {
        await fetch(`${baseUrl}/agents/${agentId}/stop`, {
            method: "POST",
            headers: buildHeaders(userInfoCookieValue, { "Content-Type": "application/json" }),
            body: JSON.stringify({}),
        });
    } catch (_e) { /* ignore — best-effort */ }
}

async function classifyOne({ baseUrl, agentId, question, roomId, userInfoCookieValue, planShape, stopAfterClassification }) {
    const url = `${baseUrl}/${agentId}/message/stream`;
    const payload = {
        text: question.question,
        roomId,
        userName: "ClassifierEval",
        name: "ClassifierEval",
    };

    let detectedClassification = null;
    let detectedReasoning = null;
    let assistantText = "";
    let errorMessage = null;
    const abortController = new AbortController();

    const response = await fetch(url, {
        method: "POST",
        headers: buildHeaders(userInfoCookieValue, { "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
        signal: abortController.signal,
    });
    if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${text}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    while (!done) {
        const { value, done: readerDone } = await reader.read();
        if (readerDone) break;
        buffer += decoder.decode(value, { stream: true });
        let splitIndex = buffer.indexOf("\n\n");
        while (splitIndex !== -1) {
            const chunk = buffer.slice(0, splitIndex);
            buffer = buffer.slice(splitIndex + 2);
            for (const line of chunk.split("\n")) {
                if (!line.startsWith("data:")) continue;
                const data = line.slice(5).trim();
                if (!data) continue;
                if (data === "[DONE]") { done = true; break; }
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (_e) { parsed = null; }
                if (!parsed) continue;

                if (parsed.type === "intermediate_response" || parsed.type === "action_response") {
                    const candidate = extractClassificationFromResponseObj(parsed.response);
                    if (candidate) {
                        detectedClassification = candidate;
                        const reasoning = extractReasoningFromResponseObj(parsed.response);
                        if (reasoning) detectedReasoning = reasoning;
                        // Cost gate: hit /stop on the agent so the
                        // in-flight handler aborts before incurring full
                        // task-chain / comprehensive cost. Fired BEFORE
                        // we close the client stream so the server side
                        // sees the stop signal first.
                        if (stopAfterClassification) {
                            await stopAgent(baseUrl, agentId, userInfoCookieValue);
                        }
                        // Done as soon as classification is seen — unless we
                        // need the assistant text for plan-shape checks.
                        if (!planShape) {
                            done = true;
                            try { abortController.abort(); } catch (_) { /* ignore */ }
                            break;
                        }
                    } else if (planShape && parsed.response?.user === "assistant") {
                        assistantText += typeof parsed.response.text === "string" ? parsed.response.text : "";
                    }
                } else if (parsed.type === "error") {
                    errorMessage = parsed.error || "Unknown error";
                    done = true;
                    break;
                }
            }
            if (done) break;
            splitIndex = buffer.indexOf("\n\n");
        }
    }
    try { await reader.cancel(); } catch (_) { /* ignore */ }
    return { detectedClassification, detectedReasoning, assistantText, errorMessage };
}

function checkPlanShape(text, shape) {
    if (!shape || !text) return { ok: !shape, missing: shape ? Object.keys(shape) : [] };
    const failures = [];
    if (typeof shape.minSteps === "number") {
        const stepLines = (text.match(/^\s*\d+\.\s+/gm) || []).length;
        if (stepLines < shape.minSteps) failures.push(`minSteps: expected >=${shape.minSteps}, got ${stepLines}`);
    }
    if (Array.isArray(shape.containsKeywords)) {
        for (const kw of shape.containsKeywords) {
            if (!text.toLowerCase().includes(String(kw).toLowerCase())) {
                failures.push(`missing keyword: ${kw}`);
            }
        }
    }
    return { ok: failures.length === 0, failures };
}

function buildMatrix() {
    const m = {};
    for (const r of MATRIX_COLUMNS) {
        m[r] = {};
        for (const c of MATRIX_COLUMNS) m[r][c] = 0;
    }
    return m;
}

function recordMatrix(matrix, expected, actual) {
    const row = MATRIX_COLUMNS.includes(expected) ? expected : "NONE";
    const col = MATRIX_COLUMNS.includes(actual) ? actual : "NONE";
    matrix[row][col] += 1;
}

function formatMatrix(matrix) {
    const colWidth = 22;
    const rowWidth = 26;
    const lines = [];
    const header = ["expected \\ actual".padEnd(rowWidth)]
        .concat(MATRIX_COLUMNS.map((c) => c.padEnd(colWidth)));
    lines.push(header.join(""));
    for (const r of MATRIX_COLUMNS) {
        const row = [r.padEnd(rowWidth)];
        for (const c of MATRIX_COLUMNS) {
            row.push(String(matrix[r][c]).padEnd(colWidth));
        }
        lines.push(row.join(""));
    }
    return lines.join("\n");
}

async function runWithConcurrency(items, concurrency, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;
    async function loop() {
        while (true) {
            const i = nextIndex++;
            if (i >= items.length) return;
            results[i] = await worker(items[i], i);
        }
    }
    const loops = [];
    for (let n = 0; n < Math.max(1, concurrency); n += 1) loops.push(loop());
    await Promise.all(loops);
    return results;
}

async function run() {
    const args = parseArgs(process.argv.slice(2));
    const baseUrl = normalizeBaseUrl(args.baseUrl);
    const agentId = await resolveAgentId(baseUrl, args.agentId, args.agentName);
    const userInfoCookieValue = args.userEmail ? encodeUserInfoCookie({ email: args.userEmail }) : null;

    let questions = await loadQuestions(args.questionsPath);
    if (args.levels) {
        const set = new Set(args.levels.split(",").map((s) => Number.parseInt(s.trim(), 10)).filter(Number.isFinite));
        questions = questions.filter((q) => set.has(q.level));
    }
    if (args.category) {
        questions = questions.filter((q) => q.category === args.category);
    }
    if (questions.length === 0) {
        throw new Error("No questions matched the filters");
    }

    let planQuestions = null;
    if (args.planShape && args.planQuestions) {
        planQuestions = await loadQuestions(args.planQuestions);
    }

    console.log(`Agent: ${agentId}`);
    console.log(`Questions: ${questions.length}`);
    console.log(`Concurrency: ${args.concurrency}`);

    // One room per level to keep recent-conversation context coherent.
    const levels = Array.from(new Set(questions.map((q) => q.level))).sort((a, b) => a - b);
    const roomByLevel = new Map();
    for (const level of levels) {
        const id = await createRoom(baseUrl, agentId, `Classifier Eval L${level}`, userInfoCookieValue);
        roomByLevel.set(level, id);
    }

    const startedAt = new Date().toISOString();
    const matrix = buildMatrix();
    const perCategory = new Map();
    const records = [];

    const results = await runWithConcurrency(questions, args.concurrency, async (q) => {
        const roomId = roomByLevel.get(q.level);
        let outcome;
        try {
            outcome = await classifyOne({
                baseUrl,
                agentId,
                question: q,
                roomId,
                userInfoCookieValue,
                planShape: Boolean(args.planShape && planQuestions),
                stopAfterClassification: args.stopAfterClassification,
            });
        } catch (err) {
            outcome = { detectedClassification: null, detectedReasoning: null, assistantText: "", errorMessage: err.message };
        }
        const expected = q.expectedClassification ? String(q.expectedClassification).toUpperCase() : null;
        const actual = outcome.detectedClassification || null;
        const passed = expected ? actual === expected : actual !== null;
        recordMatrix(matrix, expected ?? "NONE", actual ?? "NONE");
        const cat = q.category || "uncategorized";
        const bucket = perCategory.get(cat) || { total: 0, pass: 0 };
        bucket.total += 1;
        if (passed) bucket.pass += 1;
        perCategory.set(cat, bucket);

        const record = {
            id: q.id,
            category: cat,
            question: q.question,
            expected,
            actual,
            passed,
            reasoning: outcome.detectedReasoning || null,
            error: outcome.errorMessage || null,
        };
        records.push(record);

        const status = passed ? "PASS" : "FAIL";
        const reasonSuffix = !passed && outcome.detectedReasoning ? ` :: ${outcome.detectedReasoning}` : "";
        console.log(`[${status}] Q${q.id} [${cat}] expected=${expected} actual=${actual}${reasonSuffix}`);
        return record;
    });

    // Optional plan-shape pass — gate behind --plan-shape so the routing
    // eval never depends on the (longer) plan generation.
    const planRecords = [];
    if (planQuestions && args.planShape) {
        for (const q of planQuestions) {
            const roomId = await createRoom(baseUrl, agentId, `Plan Shape ${q.id}`, userInfoCookieValue);
            const outcome = await classifyOne({
                baseUrl,
                agentId,
                question: q,
                roomId,
                userInfoCookieValue,
                planShape: true,
                stopAfterClassification: false,
            }).catch((err) => ({ detectedClassification: null, assistantText: "", errorMessage: err.message }));
            const shapeResult = checkPlanShape(outcome.assistantText, q.expectedPlanShape);
            const ok = shapeResult.ok;
            console.log(`[PLAN ${ok ? "PASS" : "FAIL"}] Q${q.id} ${q.question}${ok ? "" : ` :: ${shapeResult.failures.join("; ")}`}`);
            planRecords.push({ id: q.id, question: q.question, ok, failures: shapeResult.failures || [] });
        }
    }

    const totals = results.reduce((a, r) => { a.total += 1; if (r.passed) a.pass += 1; return a; }, { total: 0, pass: 0 });
    const accuracy = totals.total === 0 ? 0 : (totals.pass / totals.total);
    console.log(`\n=== Summary ===`);
    console.log(`Overall: ${totals.pass}/${totals.total} = ${(accuracy * 100).toFixed(1)}%`);
    for (const [cat, b] of Array.from(perCategory.entries()).sort()) {
        console.log(`  ${cat}: ${b.pass}/${b.total} = ${((b.pass / b.total) * 100).toFixed(1)}%`);
    }
    console.log(`\n=== Confusion Matrix ===`);
    console.log(formatMatrix(matrix));

    const out = {
        startedAt,
        completedAt: new Date().toISOString(),
        agentId,
        baseUrl,
        questionsPath: args.questionsPath,
        overall: { total: totals.total, pass: totals.pass, accuracy },
        perCategory: Object.fromEntries(perCategory.entries()),
        confusionMatrix: matrix,
        records,
        planRecords,
    };
    const outAbs = path.isAbsolute(args.resultsPath) ? args.resultsPath : path.join(process.cwd(), args.resultsPath);
    await fs.writeFile(outAbs, JSON.stringify(out, null, 2));
    console.log(`\nWrote: ${args.resultsPath}`);

    // Exit non-zero if any FAIL, so CI can gate on it if needed.
    if (totals.pass < totals.total) process.exit(1);
}

run().catch((err) => {
    console.error(`eval-classifier failed: ${err.stack || err.message || err}`);
    process.exit(1);
});
