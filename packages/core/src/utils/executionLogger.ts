import { elizaLogger } from "./logger.ts";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import type {
    ChainExecutionResult,
    Memory,
    TaskChain,
    UUID
} from "../core/types.ts";

interface RegularMessageLogParams {
    agentId: string;
    roomId: UUID;
    messageId: UUID;
    userQuestion: string;
    actionResults?: any[];
    finalResponse: Memory;
    classification?: ClassificationLogInfo;
}

interface TaskChainLogParams {
    agentId: string;
    roomId: UUID;
    messageId: UUID;
    userQuestion: string;
    chain: TaskChain;
    success: boolean;
    stats: ChainExecutionResult["stats"];
    taskResults?: Map<UUID, any>;
    classification?: ClassificationLogInfo;
}

const LLM_ACTION_LABEL = "llm action";

const resolvedLogDir = process.env.EXECUTION_LOG_DIR
    ? path.resolve(process.env.EXECUTION_LOG_DIR)
    : path.resolve(process.cwd(), "logs");

const LOG_FILE = process.env.EXECUTION_LOG_FILE
    ? path.resolve(process.env.EXECUTION_LOG_FILE)
    : path.join(resolvedLogDir, "execution-log.jsonl");

function ensureLogDirectory(): void {
    const directory = path.dirname(LOG_FILE);
    if (!existsSync(directory)) {
        mkdirSync(directory, { recursive: true });
    }
}

function writeLogToFile(entry: unknown): void {
    try {
        ensureLogDirectory();
        const line = JSON.stringify(entry);
        appendFileSync(LOG_FILE, `${line}\n`, { encoding: "utf8" });
    } catch (error) {
        elizaLogger.warn("[ExecutionLog] Failed to write execution log to file", {
            error: error instanceof Error ? error.message : String(error)
        });
    }
}

function dedupeActions(actions: string[]): string[] {
    const seen = new Set<string>();
    const ordered: string[] = [];

    for (const action of actions) {
        if (!seen.has(action)) {
            seen.add(action);
            ordered.push(action);
        }
    }

    return ordered;
}

function normalizeActionName(name?: string | null): string {
    if (!name || typeof name !== "string") {
        return LLM_ACTION_LABEL;
    }

    const lowered = name.toLowerCase();
    if (
        lowered.includes("llm") ||
        lowered.includes("language_model") ||
        lowered.includes("model_call") ||
        lowered.includes("generate") ||
        lowered.includes("completion")
    ) {
        return LLM_ACTION_LABEL;
    }

    return name;
}

function extractActionNameFromResult(result: any): string {
    if (!result || typeof result !== "object") {
        return LLM_ACTION_LABEL;
    }

    const name = result.action
        || result.actionName
        || result.metadata?.actionName
        || result.metadata?.action
        || result.name;

    return normalizeActionName(name);
}

function extractRegularActions(actionResults?: any[]): string[] {
    if (!Array.isArray(actionResults) || actionResults.length === 0) {
        return [LLM_ACTION_LABEL];
    }

    const extracted = actionResults.map(extractActionNameFromResult);
    const normalized = extracted.length === 0 ? [LLM_ACTION_LABEL] : extracted;
    return dedupeActions(normalized);
}

function extractTaskActions(taskType: string | undefined, taskResult: any): string[] {
    const output = taskResult?.output;
    const raw = taskResult?.raw;

    const results = Array.isArray(output?.results) ? output.results : [];
    if (results.length > 0) {
        const actions = results.map((entry: any) => extractActionNameFromResult(entry));
        const filtered = actions.length === 0 ? [LLM_ACTION_LABEL] : actions;
        return dedupeActions(filtered);
    }

    if (taskResult?.taskType === "llm" || (typeof taskType === "string" && taskType.toLowerCase() === "llm")) {
        return [LLM_ACTION_LABEL];
    }

    if (output?.text || raw?.text || output?.markdown) {
        return [LLM_ACTION_LABEL];
    }

    return [];
}

export function logRegularMessageOutcome(params: RegularMessageLogParams): void {
    const { agentId, roomId, messageId, userQuestion, actionResults, finalResponse } = params;

    const actions = extractRegularActions(actionResults);
    const preview = typeof finalResponse.content?.text === "string"
        ? finalResponse.content.text.slice(0, 200)
        : undefined;
    const classification = params.classification
        ?? extractClassificationFromMetadata(finalResponse.content?.metadata);
    const precheck = classification
        ? {
            classification: classification.type,
            confidence: classification.confidence,
            reasoning: classification.reasoning,
            isCryptoRelated: classification.isCryptoRelated
        }
        : null;

    const logEntry = {
        type: "regular_message",
        userQuestion,
        actions,
        actionCount: actions.length,
        finalResponsePreview: preview,
        precheck
    };

    elizaLogger.info("[ExecutionLog] Regular message completed", logEntry);
    writeLogToFile(logEntry);
}

export function logTaskChainOutcome(params: TaskChainLogParams): void {
    const {
        agentId,
        roomId,
        messageId,
        userQuestion,
        chain,
        success,
        stats,
        taskResults,
        classification
    } = params;

    const taskResultMap = new Map<string, any>();
    if (taskResults) {
        for (const [taskId, result] of taskResults.entries()) {
            taskResultMap.set(String(taskId), result);
        }
    }

    const taskLogs = chain.tasks.map(task => {
        const key = String(task.id);
        const taskResult = taskResultMap.get(key);
        const actions = extractTaskActions(task.type as string | undefined, taskResult);

        return {
            taskName: task.name,
            taskType: task.type,
            status: task.status,
            dependencies: task.dependencies || [],
            actions
        };
    });

    const flattenedActions = dedupeActions(
        taskLogs.flatMap(log => (log.actions.length > 0 ? log.actions : []))
    );
    const overallActions = flattenedActions.length > 0 ? flattenedActions : [LLM_ACTION_LABEL];

    const classificationInfo = classification
        ?? extractClassificationFromMetadata(chain.metadata as unknown);
    const precheck = classificationInfo
        ? {
            classification: classificationInfo.type,
            confidence: classificationInfo.confidence,
            reasoning: classificationInfo.reasoning,
            isCryptoRelated: classificationInfo.isCryptoRelated
        }
        : null;

    const logEntry = {
        type: "task_chain",
        userQuestion,
        success,
        actions: overallActions,
        actionCount: overallActions.length,
        taskChain: {
            name: chain.name,
            description: chain.description,
            taskCount: chain.tasks.length,
            tasks: taskLogs
        },
        stats,
        precheck
    };

    elizaLogger.info("[ExecutionLog] Task chain completed", logEntry);
    writeLogToFile(logEntry);
}
interface ClassificationLogInfo {
    type?: string;
    confidence?: number;
    reasoning?: string;
    isCryptoRelated?: boolean | null;
}

function extractClassificationFromMetadata(metadata: any): ClassificationLogInfo | undefined {
    if (!metadata || typeof metadata !== "object") {
        return undefined;
    }

    const type = metadata.classification as string | undefined;
    const confidence = typeof metadata.classificationConfidence === "number"
        ? metadata.classificationConfidence
        : undefined;
    const reasoning = typeof metadata.classificationReasoning === "string"
        ? metadata.classificationReasoning
        : undefined;
    const isCryptoRelated = typeof metadata.isCryptoRelated === "boolean"
        ? metadata.isCryptoRelated
        : undefined;

    if (!type && confidence === undefined && !reasoning && isCryptoRelated === undefined) {
        return undefined;
    }

    return {
        type,
        confidence,
        reasoning,
        isCryptoRelated
    };
}
