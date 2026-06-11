/**
 * Task Chain Language E2E Test
 *
 * Verifies that task chain planning and downstream task chain outputs follow
 * the requested frontend language (`en` or `zh-CN`) across the full stream flow:
 * 1. Send a task chain request through `/:agentId/message/stream`
 * 2. Auto-approve the generated chain through `/agents/:agentId/task-chain/approval`
 * 3. Wait for the stream to finish
 * 4. Fetch persisted room memories and validate the task chain summary/output language
 *
 * Usage:
 *   1. Start the agent server locally
 *   2. Run:
 *      npx tsx scripts/test-taskchain-language-e2e.ts
 *
 * Optional env vars:
 *   SERVER_URL=http://localhost:3000
 *   TEST_USER_EMAIL=test@test.com
 *   TEST_AGENT_ID=<agent-id>
 *   LANGUAGES=en,zh-CN
 *   TASKCHAIN_PROMPT="Get recent Bitcoin market news, analyze the sentiment, and summarize the key risks."
 *   TASKCHAIN_PROMPTS_JSON='["prompt 1", "prompt 2"]'
 *   STREAM_TIMEOUT_MS=600000
 */

type SupportedLanguage = "en" | "zh-CN";

type AgentRecord = {
    id: string;
    name: string;
};

type StreamSampleStage =
    | "planned_chain"
    | "chain_state"
    | "intermediate_response"
    | "action_response"
    | "summary_memory"
    | "task_memory";

type StreamSample = {
    stage: StreamSampleStage;
    label: string;
    text: string;
    required: boolean;
};

type StageCheck = {
    stage: StreamSampleStage;
    label: string;
    required: boolean;
    passed: boolean;
    ratio: number;
    textPreview: string;
};

type CaseResult = {
    language: SupportedLanguage;
    prompt: string;
    requestedRoomId: string;
    resolvedRoomId: string;
    approvalCount: number;
    samples: StreamSample[];
    checks: StageCheck[];
    errors: string[];
    passed: boolean;
};

type ChainApprovalData = {
    chainId?: string;
    taskChain?: {
        id?: string;
        name?: string;
        description?: string;
        tasks?: Array<{
            id?: string;
            name?: string;
            description?: string;
        }>;
    };
    fullTaskChain?: Record<string, unknown>;
};

const BASE_URL = process.env.SERVER_URL || "http://localhost:3000";
const USER_EMAIL = process.env.TEST_USER_EMAIL || "test@test.com";
const AUTH_COOKIE = `user_info=${encodeURIComponent(JSON.stringify({ email: USER_EMAIL }))}`;
const STREAM_TIMEOUT_MS = Number(process.env.STREAM_TIMEOUT_MS || "600000");
const REQUESTED_LANGUAGES = (process.env.LANGUAGES || "en,zh-CN")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean) as SupportedLanguage[];

const DEFAULT_PROMPTS = [
    process.env.TASKCHAIN_PROMPT ||
        "Get recent Bitcoin market news, analyze the sentiment, and summarize the key risks.",
];

const PROMPTS = (() => {
    const raw = process.env.TASKCHAIN_PROMPTS_JSON;
    if (!raw) {
        return DEFAULT_PROMPTS;
    }

    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.some(item => typeof item !== "string")) {
            throw new Error("TASKCHAIN_PROMPTS_JSON must be a JSON string array");
        }
        return parsed as string[];
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to parse TASKCHAIN_PROMPTS_JSON: ${message}`);
    }
})();

function printHelp() {
    console.log("Task Chain Language E2E Test");
    console.log();
    console.log("Usage:");
    console.log("  npx tsx scripts/test-taskchain-language-e2e.ts");
    console.log();
    console.log("Optional env vars:");
    console.log("  SERVER_URL=http://localhost:3000");
    console.log("  TEST_USER_EMAIL=test@test.com");
    console.log("  TEST_AGENT_ID=<agent-id>");
    console.log('  LANGUAGES=en,zh-CN');
    console.log('  TASKCHAIN_PROMPT="Get recent Bitcoin market news, analyze the sentiment, and summarize the key risks."');
    console.log('  TASKCHAIN_PROMPTS_JSON=\'["prompt 1", "prompt 2"]\'');
    console.log("  STREAM_TIMEOUT_MS=600000");
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function chineseCharRatio(text: string): number {
    if (!text) {
        return 0;
    }

    const stripped = text.replace(/[\s\p{P}\p{S}\d\n\r]/gu, "");
    if (!stripped.length) {
        return 0;
    }

    const chineseChars = stripped.match(/[\u4e00-\u9fff]/g) || [];
    return chineseChars.length / stripped.length;
}

function checkLanguage(text: string, language: SupportedLanguage): { passed: boolean; ratio: number } {
    const ratio = chineseCharRatio(text);
    if (language === "zh-CN") {
        return { passed: ratio >= 0.25, ratio };
    }

    return { passed: ratio < 0.1, ratio };
}

function preview(text: string, maxLength = 120): string {
    return text.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function buildCookieHeaders(extraHeaders: HeadersInit = {}): HeadersInit {
    return {
        Cookie: AUTH_COOKIE,
        ...extraHeaders,
    };
}

async function getAgentId(): Promise<string> {
    if (process.env.TEST_AGENT_ID) {
        return process.env.TEST_AGENT_ID;
    }

    const response = await fetch(`${BASE_URL}/agents`, {
        headers: buildCookieHeaders(),
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch agents: HTTP ${response.status}`);
    }

    const data = (await response.json()) as { agents: AgentRecord[] };
    if (!Array.isArray(data.agents) || data.agents.length === 0) {
        throw new Error("No agents found");
    }

    return data.agents[0].id;
}

function extractTaskChainText(chainLike: Record<string, unknown> | undefined): string {
    if (!chainLike || typeof chainLike !== "object") {
        return "";
    }

    const textParts: string[] = [];
    const addValue = (value: unknown) => {
        if (typeof value !== "string") {
            return;
        }
        const trimmed = value.trim();
        if (trimmed.length > 0) {
            textParts.push(trimmed);
        }
    };

    addValue(chainLike.name);
    addValue(chainLike.chain_name);
    addValue(chainLike.chainName);
    addValue(chainLike.description);
    addValue(chainLike.chain_description);
    addValue(chainLike.chainDescription);

    const tasks = Array.isArray(chainLike.tasks) ? chainLike.tasks : [];
    for (const task of tasks) {
        if (!task || typeof task !== "object") {
            continue;
        }
        const taskRecord = task as Record<string, unknown>;
        addValue(taskRecord.name);
        addValue(taskRecord.description);
    }

    return textParts.join("\n");
}

function extractResponseText(response: unknown): string {
    if (!response || typeof response !== "object") {
        return "";
    }

    const record = response as Record<string, unknown>;
    const candidates = [
        record.text,
        (record.content as Record<string, unknown> | undefined)?.text,
        (record.response as Record<string, unknown> | undefined)?.text,
        ((record.response as Record<string, unknown> | undefined)?.content as Record<string, unknown> | undefined)?.text,
    ];

    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim().length > 0) {
            return candidate.trim();
        }
    }

    return "";
}

async function submitTaskChainApproval(
    agentId: string,
    threadId: string,
    taskChain: Record<string, unknown>
): Promise<void> {
    const response = await fetch(`${BASE_URL}/agents/${agentId}/task-chain/approval`, {
        method: "POST",
        headers: buildCookieHeaders({
            "Content-Type": "application/json",
        }),
        body: JSON.stringify({
            threadId,
            decision: "approved",
            feedback: "",
            taskChain,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to approve task chain: HTTP ${response.status} ${errorText}`);
    }
}

async function fetchRoomMemories(agentId: string, roomId: string): Promise<any[]> {
    for (let attempt = 1; attempt <= 5; attempt++) {
        const response = await fetch(`${BASE_URL}/agents/${agentId}/${roomId}/memories`, {
            headers: buildCookieHeaders(),
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch memories: HTTP ${response.status}`);
        }

        const data = (await response.json()) as { memories?: any[] };
        const memories = Array.isArray(data.memories) ? data.memories : [];

        const hasSummaryMemory = memories.some(
            memory => memory?.content?.source === "task_chain_summary"
        );
        if (hasSummaryMemory || attempt === 5) {
            return memories;
        }

        await sleep(500);
    }

    return [];
}

function evaluateSamples(samples: StreamSample[], language: SupportedLanguage): StageCheck[] {
    return samples.map(sample => {
        const { passed, ratio } = checkLanguage(sample.text, language);
        return {
            stage: sample.stage,
            label: sample.label,
            required: sample.required,
            passed,
            ratio,
            textPreview: preview(sample.text),
        };
    });
}

async function runSingleCase(
    agentId: string,
    language: SupportedLanguage,
    prompt: string
): Promise<CaseResult> {
    const requestedRoomId = globalThis.crypto.randomUUID();
    let resolvedRoomId: string = requestedRoomId;
    const samples: StreamSample[] = [];
    const errors: string[] = [];
    let approvalCount = 0;
    const approvedChainIds = new Set<string>();

    const response = await fetch(`${BASE_URL}/${agentId}/message/stream`, {
        method: "POST",
        headers: buildCookieHeaders({
            "Content-Type": "application/json",
        }),
        body: JSON.stringify({
            text: prompt,
            roomId: requestedRoomId,
            language,
            messageClassification: "TASK_CHAIN_MESSAGE",
        }),
        signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
    });

    if (!response.ok) {
        throw new Error(`Stream request failed: HTTP ${response.status} ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
        throw new Error("No response body returned from stream endpoint");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;

    const processEvent = async (payload: string) => {
        if (!payload || payload === "[DONE]") {
            done = payload === "[DONE]";
            return;
        }

        const event = JSON.parse(payload) as Record<string, any>;

        if (event.type === "room_created" && typeof event.roomId === "string") {
            resolvedRoomId = event.roomId;
            return;
        }

        if (event.type === "step" && event.step?.name === "chain_approval_required" && event.step?.data) {
            const approvalData = event.step.data as ChainApprovalData;
            const chainObject = (approvalData.fullTaskChain || approvalData.taskChain) as Record<string, unknown> | undefined;
            const chainText = extractTaskChainText(chainObject);
            if (chainText) {
                samples.push({
                    stage: "planned_chain",
                    label: "planned chain from approval dialog",
                    text: chainText,
                    required: true,
                });
            }

            const chainId =
                approvalData.taskChain?.id ||
                approvalData.chainId ||
                String(approvalData.fullTaskChain?.["id"] || "");

            if (chainObject && chainId && !approvedChainIds.has(chainId)) {
                approvedChainIds.add(chainId);
                approvalCount += 1;
                await submitTaskChainApproval(agentId, resolvedRoomId, chainObject);
            }
            return;
        }

        if (event.type === "step" && event.step?.name === "chain_state" && event.step?.data?.chain) {
            const chainText = extractTaskChainText(event.step.data.chain as Record<string, unknown>);
            if (chainText) {
                samples.push({
                    stage: "chain_state",
                    label: "live chain state",
                    text: chainText,
                    required: false,
                });
            }
            return;
        }

        if (event.type === "intermediate_response" && event.response) {
            const text = extractResponseText(event.response);
            if (text) {
                samples.push({
                    stage: "intermediate_response",
                    label: "streamed intermediate response",
                    text,
                    required: false,
                });
            }
            return;
        }

        if (event.type === "action_response" && event.response) {
            const text = extractResponseText(event.response);
            if (text) {
                samples.push({
                    stage: "action_response",
                    label: "streamed action response",
                    text,
                    required: false,
                });
            }
            return;
        }

        if (event.type === "error") {
            errors.push(typeof event.error === "string" ? event.error : JSON.stringify(event.error));
        }
    };

    while (!done) {
        const readResult = await reader.read();
        if (readResult.done) {
            break;
        }

        buffer += decoder.decode(readResult.value, { stream: true });

        let separatorIndex = buffer.indexOf("\n\n");
        while (separatorIndex !== -1) {
            const rawEvent = buffer.slice(0, separatorIndex);
            buffer = buffer.slice(separatorIndex + 2);

            const payload = rawEvent
                .split("\n")
                .filter(line => line.startsWith("data:"))
                .map(line => line.slice(5).trimStart())
                .join("\n")
                .trim();

            await processEvent(payload);
            separatorIndex = buffer.indexOf("\n\n");
        }
    }

    const memories = await fetchRoomMemories(agentId, resolvedRoomId);
    const assistantMemories = memories.filter(memory => memory?.userId === agentId);

    for (const memory of assistantMemories) {
        const source = memory?.content?.source;
        const text = extractResponseText(memory);
        if (!text) {
            continue;
        }

        if (source === "task_chain_summary") {
            samples.push({
                stage: "summary_memory",
                label: "persisted task chain summary memory",
                text,
                required: true,
            });
            continue;
        }

        if (source === "task_chain_action") {
            samples.push({
                stage: "task_memory",
                label: `persisted task memory: ${memory?.content?.metadata?.taskName || "unknown"}`,
                text,
                required: false,
            });
        }
    }

    const checks = evaluateSamples(samples, language);
    const requiredStages = new Set<StreamSampleStage>(["planned_chain", "summary_memory"]);
    const seenRequiredStages = new Set(
        checks.filter(check => check.required).map(check => check.stage)
    );

    for (const requiredStage of Array.from(requiredStages)) {
        if (!seenRequiredStages.has(requiredStage)) {
            errors.push(`Missing required stage output: ${requiredStage}`);
        }
    }

    const requiredChecksPassed = checks
        .filter(check => check.required)
        .every(check => check.passed);

    return {
        language,
        prompt,
        requestedRoomId,
        resolvedRoomId,
        approvalCount,
        samples,
        checks,
        errors,
        passed: requiredChecksPassed && errors.length === 0,
    };
}

function printCaseResult(result: CaseResult) {
    console.log(`\n[${result.language}] ${result.prompt}`);
    console.log(`  Requested room: ${result.requestedRoomId}`);
    console.log(`  Resolved room:  ${result.resolvedRoomId}`);
    console.log(`  Approvals:      ${result.approvalCount}`);

    if (result.checks.length === 0) {
        console.log("  No checkable outputs captured.");
    } else {
        for (const check of result.checks) {
            const requirement = check.required ? "required" : "optional";
            const icon = check.passed ? "PASS" : "FAIL";
            console.log(
                `  ${icon} [${requirement}] ${check.stage} (${(check.ratio * 100).toFixed(0)}% zh) ${check.label}`
            );
            if (check.textPreview) {
                console.log(`    ${check.textPreview}`);
            }
        }
    }

    if (result.errors.length > 0) {
        console.log("  Errors:");
        for (const error of result.errors) {
            console.log(`    - ${error}`);
        }
    }
}

async function main() {
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
        printHelp();
        process.exit(0);
    }

    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║         Task Chain Language End-to-End Test                 ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");
    console.log(`Server:    ${BASE_URL}`);
    console.log(`User:      ${USER_EMAIL}`);
    console.log(`Languages: ${REQUESTED_LANGUAGES.join(", ")}`);
    console.log(`Prompts:   ${PROMPTS.length}`);

    let agentId: string;
    try {
        agentId = await getAgentId();
        console.log(`Agent:     ${agentId}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`\nFailed to resolve agent: ${message}`);
        process.exit(1);
        return;
    }

    const results: CaseResult[] = [];

    for (const language of REQUESTED_LANGUAGES) {
        for (const prompt of PROMPTS) {
            try {
                const result = await runSingleCase(agentId, language, prompt);
                results.push(result);
                printCaseResult(result);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const failedResult: CaseResult = {
                    language,
                    prompt,
                    requestedRoomId: "(not created)",
                    resolvedRoomId: "(not created)",
                    approvalCount: 0,
                    samples: [],
                    checks: [],
                    errors: [message],
                    passed: false,
                };
                results.push(failedResult);
                printCaseResult(failedResult);
            }
        }
    }

    const passedCount = results.filter(result => result.passed).length;
    console.log("\nSummary");
    console.log(`  Passed: ${passedCount}/${results.length}`);

    if (passedCount !== results.length) {
        console.log("  Failed cases:");
        for (const result of results.filter(item => !item.passed)) {
            console.log(`    - [${result.language}] ${preview(result.prompt, 80)}`);
        }
    }

    process.exit(passedCount === results.length ? 0 : 1);
}

main().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Fatal error: ${message}`);
    process.exit(1);
});
