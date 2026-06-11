import { v4 as uuidv4 } from "uuid";
import { StateGraph, Annotation } from "@langchain/langgraph";
import { elizaLogger } from "../utils/logger.ts";
import { getDataRetentionConfig, DATA_RETENTION_DAYS_BY_TIER } from "../utils/dataRetention.ts";
import { generateText } from "../ai/generation.ts";
import { composeContext, composeContextSplit } from "../core/context.ts";
import {
    getTaskChainActionTemplate,
    getLLMTaskTemplateGenerationPrompt,
    LLM_TASK_FORMATTING_REQUIREMENTS
} from "../templates/taskChainExecutorTemplate.ts";
import { DefaultDependencyResolver } from "./dependencyResolver.ts";
import { ActionCacheManager } from "../data/actionCacheManager.ts";
import { getNonCEXActions } from "../utils/pluginFilter.ts";
import {
    type TaskExecutor,
    type TaskNode,
    type TaskType,
    type TaskExecutionContext,
    type LLMTaskConfig,
    type ActionTaskConfig,
    type Action,
    ModelClass,
    type Memory,
    type UUID,
    type HandlerCallback,
} from "../core/types.ts";


type TaskExecutionMode = "llm" | "action";

type TaskSelectionData = {
    task_type: string;
    selected_actions: Array<{ action: string; parameters: any }>;
    description: string;
};

type TaskExecutionErrorInfo = {
    type: string;
    message: string;
    stack?: string;
};

const USER_FACING_TASK_ERROR_MESSAGE = "Task execution failed due to an internal error.";
const DEFAULT_ACTION_CACHE_TTL_SECONDS = 86400; // 24 hours
const DEFAULT_ACTION_CACHE_CHUNK_SIZE = 200;

export const TaskExecutionState = Annotation.Root({
    runtime: Annotation<any>(),
    task: Annotation<TaskNode>(),
    inputs: Annotation<Record<string, any>>(),
    executionContext: Annotation<TaskExecutionContext>(),
    startTime: Annotation<number>(),
    workingTask: Annotation<TaskNode>(),
    selectionPrompt: Annotation<string>(),
    selectionResponse: Annotation<string>(),
    selectionData: Annotation<TaskSelectionData>(),
    executionMode: Annotation<TaskExecutionMode>(),
    llmTemplate: Annotation<string>(),
    llmContext: Annotation<string>(),
    executionResult: Annotation<any>(),
    configurationMetadata: Annotation<any>(),
    relevantMemories: Annotation<any[]>(),
    hasError: Annotation<boolean>(),
    errorMessage: Annotation<string>(),
    errorInfo: Annotation<TaskExecutionErrorInfo>(),
    phase: Annotation<string>(),
    finalTask: Annotation<TaskNode>(),
    isComplete: Annotation<boolean>()
});

export type TaskExecutionStateType = typeof TaskExecutionState.State;

/**
 * Initialize the task execution by validating inputs and streaming status updates.
 */
async function initializeExecution(state: TaskExecutionStateType): Promise<Partial<TaskExecutionStateType>> {
    elizaLogger.info(`[TaskExecutor] Initializing execution for task: "${state.task?.name ?? "unknown"}"`);

    try {
        if (!state.task) {
            throw new Error("Task not provided to executor");
        }

        if (!state.executionContext) {
            throw new Error("Execution context missing");
        }

        const { executionContext } = state;

        if (executionContext.runtime.shouldStop && executionContext.runtime.shouldStop()) {
            throw new Error("Processing stopped by user request");
        }

        const workingTask: TaskNode = {
            ...state.task,
            status: state.task.status ?? "pending"
        };

        elizaLogger.info(`[TaskExecutor] Starting task: "${workingTask.name}"`);

        const startTime = Date.now();
        const eventTimestamp = startTime;

        if (executionContext.streamingCallback) {
            executionContext.streamingCallback({
                id: uuidv4(),
                name: "task_update",
                status: "completed",
                message: `Task "${workingTask.name}" is now running${workingTask.type ? ` (type: ${workingTask.type})` : ""}`,
                timestamp: eventTimestamp,
                data: {
                    type: "task_update",
                    chainId: executionContext.chain.id,
                    taskId: workingTask.id,
                    taskName: workingTask.name,
                    taskType: workingTask.type,
                    status: "running",
                    timestamp: eventTimestamp
                }
            });
        }

        return {
            workingTask,
            startTime,
            hasError: false,
            phase: "configuring"
        };

    } catch (error: any) {
        elizaLogger.error(`[TaskExecutor] Initialization failed: ${error.message}`);
        return {
            hasError: true,
            errorMessage: error.message,
            errorInfo: {
                type: error.name ?? "InitializationError",
                message: error.message,
                stack: error.stack
            },
            phase: "error"
        };
    }
}

/**
 * Configure the task using the LLM-driven action selection workflow.
 */
async function configureExecution(state: TaskExecutionStateType): Promise<Partial<TaskExecutionStateType>> {
    if (!state.executionContext || !state.workingTask) {
        return {
            hasError: true,
            errorMessage: "Execution context or task missing during configuration",
            errorInfo: {
                type: "ConfigurationError",
                message: "Execution context or task missing during configuration"
            },
            phase: "error"
        };
    }

    const context = state.executionContext;
    const inputs = state.inputs ?? {};
    const task = { ...state.workingTask };

    try {
        elizaLogger.info(`[TaskExecutor] Configuring task: "${task.name}"`);
        elizaLogger.info(`[TaskExecutor] Task description: "${task.description}"`);
        elizaLogger.info(`[TaskExecutor] Task ID: ${task.id}`);

        const relevantMemories: Memory[] = [];

        // Resolve user tier and data retention for template (date-range actions)
        let dataRetentionInfo = "Free. Allowed: last 3 months (90 days).";
        const userId = context.originalMessage?.userId;
        if (userId && context.runtime.agentId && userId !== context.runtime.agentId) {
            try {
                const retention = await getDataRetentionConfig(context.runtime, userId);
                if (retention.dataRetentionMinDaysAgo != null && retention.dataRetentionMaxDaysAgo != null) {
                    dataRetentionInfo = "Anonymous. Allowed: data between 1 and 3 months ago (30–90 days ago).";
                } else if (retention.dataRetentionDays === 0) {
                    dataRetentionInfo = "Enterprise. Allowed: no limit.";
                } else if (retention.dataRetentionDays === DATA_RETENTION_DAYS_BY_TIER.pro) {
                    dataRetentionInfo = "Pro. Allowed: last 24 months (730 days).";
                } else if (retention.dataRetentionDays === DATA_RETENTION_DAYS_BY_TIER.plus) {
                    dataRetentionInfo = "Plus. Allowed: last 6 months (180 days).";
                } else if (retention.dataRetentionDays === DATA_RETENTION_DAYS_BY_TIER.free) {
                    dataRetentionInfo = "Free. Allowed: last 3 months (90 days).";
                }
            } catch (err) {
                elizaLogger.warn(`[TaskExecutor] Data retention resolution failed: ${err}`);
            }
        }

        // Prepare state for template - only fields used by the template
        const currentTime = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
        const templateState: any = {
            currentTime,
            taskName: task.name,
            taskDescription: task.description,
            availableActions: formatAvailableActions(getNonCEXActions(context.runtime)),
            dependencyTasks: formatActionSummaryForLLM(task, context),
            dataRetentionInfo,
            languageInstruction: (context.state as any).languageInstruction || ""
        };

        const actionTemplate = getTaskChainActionTemplate();
        const { system: actionSystem, prompt: actionPrompt } = composeContextSplit({
            state: templateState,
            template: actionTemplate,
        });

        if (context.runtime.shouldStop && context.runtime.shouldStop()) {
            throw new Error("Processing stopped by user request");
        }

        const selectionResponse = await generateText({
            runtime: context.runtime,
            system: actionSystem,
            prompt: actionPrompt,
            modelClass: ModelClass.LARGE,
        });

        elizaLogger.info(`[TaskExecutor] Action selection response for "${task.name}": ${selectionResponse.substring(0, 100)}...`);

        const selection = parseSelectionResponse(selectionResponse);
        if (context.streamingCallback) {
            const message = selection.task_type === "action" && selection.selected_actions.length > 0
                ? `Configured as action task (${selection.selected_actions.length} action${selection.selected_actions.length === 1 ? '' : 's'})`
                : selection.task_type === "llm"
                    ? "Configured as LLM analysis task"
                    : `Configured task type: ${selection.task_type}`;

            context.streamingCallback({
                id: uuidv4(),
                name: `action_selection_${task.name.toLowerCase().replace(/\s+/g, '_')}`,
                status: "completed",
                message: message,
                timestamp: Date.now(),
                data: {
                    taskName: task.name,
                    taskType: selection.task_type,
                    description: selection.description,
                    selectedActionCount: selection.selected_actions.length,
                    selectedActions: selection.selected_actions
                }
            });
        }

        const configuration = await applyTaskConfigurationToTask(task, selection, context);

        return {
            selectionPrompt: `${actionSystem}\n\n${actionPrompt}`,
            selectionResponse,
            selectionData: selection,
            workingTask: configuration.task,
            executionMode: configuration.executionMode,
            configurationMetadata: configuration.metadata,
            relevantMemories: relevantMemories,
            phase: configuration.executionMode === "action" ? "execute_action" : "execute_llm",
            hasError: false
        };

    } catch (error: any) {
        elizaLogger.error(`[TaskExecutor] Task configuration failed: ${error.message}`);
        const fallbackTask = applyFallbackConfiguration(task);

        if (context.streamingCallback) {
            context.streamingCallback({
                id: uuidv4(),
                name: "action_selection_fallback",
                status: "completed",
                message: `Falling back to LLM configuration for task "${task.name}"`,
                timestamp: Date.now(),
                data: {
                    taskName: task.name,
                    taskType: "llm",
                    description: "Fallback configuration applied",
                    error: error.message
                }
            });
        }

        return {
            workingTask: fallbackTask,
            executionMode: "llm",
            configurationMetadata: {
                fallback: true,
                reason: error.message
            },
            phase: "execute_llm",
            hasError: false
        };
    }
}

/**
 * Execute an LLM-based task once configuration is complete.
 */
async function executeLLM(state: TaskExecutionStateType): Promise<Partial<TaskExecutionStateType>> {
    if (!state.executionContext || !state.workingTask) {
        return {
            hasError: true,
            errorMessage: "Missing context or task during LLM execution",
            errorInfo: {
                type: "ExecutionError",
                message: "Missing context or task during LLM execution"
            },
            phase: "error"
        };
    }

    const context = state.executionContext;
    const inputs = state.inputs ?? {};
    const task = { ...state.workingTask };

    try {
        const llmExecution = await runLLMTask(task, inputs, context);

        return {
            llmTemplate: llmExecution.template,
            llmContext: llmExecution.renderedContext,
            executionResult: llmExecution.result,
            hasError: false,
            phase: "finalizing"
        };

    } catch (error: any) {
        elizaLogger.error(`[TaskExecutor] LLM task execution failed: ${error.message}`);
        return {
            hasError: true,
            errorMessage: error.message,
            errorInfo: {
                type: error.name ?? "LLMExecutionError",
                message: error.message,
                stack: error.stack
            },
            executionResult: {},
            phase: "error"
        };
    }
}

/**
 * Execute an action-based task sequence.
 */
async function executeAction(state: TaskExecutionStateType): Promise<Partial<TaskExecutionStateType>> {
    if (!state.executionContext || !state.workingTask) {
        return {
            hasError: true,
            errorMessage: "Missing context or task during action execution",
            errorInfo: {
                type: "ExecutionError",
                message: "Missing context or task during action execution"
            },
            phase: "error"
        };
    }

    const context = state.executionContext;
    const inputs = state.inputs ?? {};
    const task = { ...state.workingTask };

    try {
        const actionResult = await runActionTask(task, inputs, context);
        return {
            executionResult: actionResult,
            hasError: false,
            phase: "finalizing"
        };

    } catch (error: any) {
        elizaLogger.error(`[TaskExecutor] Action task execution failed: ${error.message}`);
        const errorResult = (error && typeof error === "object" && "results" in error) ? (error as any).results : {};
        return {
            hasError: true,
            errorMessage: error.message,
            errorInfo: {
                type: error.name ?? "ActionExecutionError",
                message: error.message,
                stack: error.stack
            },
            executionResult: errorResult,
            phase: "error"
        };
    }
}

/**
 * Evaluate task execution and proceed to finalization.
 */
async function evaluateExecution(state: TaskExecutionStateType): Promise<Partial<TaskExecutionStateType>> {
    if (!state.workingTask || !state.executionContext) {
        return {
            hasError: true,
            errorMessage: "Missing task or context during evaluation",
            phase: "error"
        };
    }

    elizaLogger.info(`[TaskExecutor] Proceeding to finalization for task: ${state.workingTask.name}`);
    return {
        phase: "finalizing"
    };
}


/**
 * Finalize the task execution by committing results to the task node.
 */
async function finalizeExecution(state: TaskExecutionStateType): Promise<Partial<TaskExecutionStateType>> {
    if (!state.workingTask) {
        return {
            hasError: true,
            errorMessage: "Unable to finalize task - working task missing",
            errorInfo: {
                type: "FinalizationError",
                message: "Unable to finalize task - working task missing"
            },
            phase: "error"
        };
    }

    const startTime = state.startTime ?? Date.now();
    const endTime = Date.now();
    const duration = endTime - startTime;

    const task: TaskNode = {
        ...state.workingTask,
    };

    // Determine final status based on execution result
    let finalStatus: "completed" | "failed" = "completed";
    const finalMetadata: any = {
        startTime,
        endTime,
        duration
    };

    if (state.hasError) {
        finalStatus = "failed";
        finalMetadata.error = {
            type: state.errorInfo?.type ?? "UnknownExecutionError",
            message: USER_FACING_TASK_ERROR_MESSAGE
        };
    }

    if (finalStatus === "failed") {
        task.status = "failed";
        task.result = {
            data: {},
            metadata: finalMetadata
        };

        elizaLogger.error(`[TaskExecutor] Task ${task.name} failed after ${duration}ms: ${state.errorMessage || 'Task execution failed'}`);

    } else {
        const executionData = state.executionResult ?? {};

        // Include memory context sources in the task result
        const enrichedData = {
            ...executionData,
            contextSources: {
                relevantMemories: state.relevantMemories || []
            }
        };

        task.status = "completed";
        task.result = {
            data: enrichedData,
            metadata: finalMetadata
        };

        elizaLogger.success(`[TaskExecutor] Task ${task.name} completed in ${duration}ms`);

        if (executionData?.summary) {
            elizaLogger.info(`[TaskExecutor] Task "${task.name}" summary: ${executionData.summary}`);
        }

        // Cache successful action results for future reuse
        if (task.type === "action" && task.status === "completed" && enrichedData) {
            try {
                const cacheManager = new ActionCacheManager(state.executionContext.runtime);
                const cacheableResults = Array.isArray(enrichedData.results)
                    ? enrichedData.results.filter((r: any) => r?.success)
                    : [];

                for (const actionResult of cacheableResults) {
                    const actionName = actionResult.action || task.name;
                    const actionDefinition = getNonCEXActions(
                        state.executionContext.runtime
                    ).find((a: Action) => a.name === actionName);
                    const cacheConfig = actionDefinition?.cacheConfig;
                    const cacheEnabled = cacheConfig?.enabled === true;

                    if (!cacheEnabled) {
                        elizaLogger.debug(`[TaskExecutor] Skipping cache for action ${actionName}: cacheConfig disabled or missing`);
                        continue;
                    }

                    const cacheText = extractActionResultTextForCache(actionResult);
                    if (!cacheText) {
                        elizaLogger.debug(`[TaskExecutor] Skipping cache for action ${actionName}: no cacheable text`);
                        continue;
                    }

                    await cacheManager.cacheActionResult({
                        actionName,
                        query: task.description,
                        result: cacheText,
                        ttlSeconds: cacheConfig.ttlSeconds ?? DEFAULT_ACTION_CACHE_TTL_SECONDS,
                        maxChunkSize: cacheConfig.maxChunkSize ?? DEFAULT_ACTION_CACHE_CHUNK_SIZE
                    });

                    elizaLogger.debug(`[TaskExecutor] Cached action result for ${actionName} using task description query`);
                }
            } catch (cacheError: any) {
                elizaLogger.warn(`[TaskExecutor] Failed to cache task action results: ${cacheError.message}`);
            }

        }
    }

    return {
        finalTask: task,
        workingTask: task,
        isComplete: true,
        phase: "completed"
    };
}

/**
 * Create and compile the LangGraph workflow for task execution.
 */
export function createTaskExecutionWorkflow() {
    const workflow = new StateGraph(TaskExecutionState)
        .addNode("initialize", initializeExecution)
        .addNode("configure", configureExecution)
        .addNode("executeLLM", executeLLM)
        .addNode("executeAction", executeAction)
        .addNode("evaluate", evaluateExecution)
        .addNode("finalize", finalizeExecution)
        .addEdge("__start__", "initialize")
        .addConditionalEdges("initialize", (state: TaskExecutionStateType) => {
            return state.hasError ? "finalize" : "configure";
        })
        .addConditionalEdges("configure", (state: TaskExecutionStateType) => {
            if (state.hasError) {
                return "finalize";
            }
            return state.executionMode === "action" ? "executeAction" : "executeLLM";
        })
        .addEdge("executeLLM", "evaluate")
        .addEdge("executeAction", "evaluate")
        .addEdge("evaluate", "finalize")
        .addEdge("finalize", "__end__");

    return workflow.compile();
}

/**
 * LangGraph-based TaskExecutor implementation controlling execution flow through state.
 */
export class LangGraphTaskExecutor implements TaskExecutor {
    private runtime: any;
    private executionWorkflow: ReturnType<typeof createTaskExecutionWorkflow>;

    constructor(runtime: any) {
        this.runtime = runtime;
        this.executionWorkflow = createTaskExecutionWorkflow();
    }

    async executeTask(
        task: TaskNode,
        inputs: Record<string, any>,
        context: TaskExecutionContext
    ): Promise<TaskNode> {
        elizaLogger.info(`[LangGraphTaskExecutor] Executing task: "${task.name}" (${task.type ?? "unconfigured"})`);

        const initialState: Partial<TaskExecutionStateType> = {
            runtime: this.runtime,
            task,
            inputs,
            executionContext: context,
            hasError: false,
            phase: "initialize"
        };

        const result = await this.executionWorkflow.invoke(initialState);

        if (!result.finalTask) {
            elizaLogger.error(`[LangGraphTaskExecutor] Task execution did not produce a final task. Returning original task marked as failed.`);
            return {
                ...task,
                status: "failed",
                result: {
                    data: {},
                    metadata: {
                        startTime: Date.now(),
                        endTime: Date.now(),
                        duration: 0,
                        error: {
                            type: "ExecutionError",
                            message: result.errorMessage ?? "Task execution failed"
                        }
                    }
                }
            };
        }

        return result.finalTask;
    }

    canExecute(taskType: TaskType): boolean {
        return ["llm", "action"].includes(taskType);
    }

    estimateExecutionTime(task: TaskNode): number {
        switch (task.type) {
            case "llm":
                return 10000;
            case "action":
                return 15000;
            default:
                return 5000;
        }
    }
}

/**
 * Default executor alias preserving existing imports.
 */
export class DefaultTaskExecutor extends LangGraphTaskExecutor {
    constructor(runtime: any) {
        super(runtime);
    }
}

/**
 * Format available actions for LLM consumption with required parameters.
 */
function formatAvailableActions(actions: Action[]): string {
    return actions.map(action => `**${action.name}**: ${action.description}`).join("\n");
}

/**
 * Extract "selected_actions": [ ... ] array from response text using bracket matching.
 * Used when only task_type is available (e.g. regex fallback) but response contains action JSON.
 */
function extractSelectedActionsFromText(response: string): Array<{ action: string; parameters: any }> {
    const startMarker = /"selected_actions"\s*:\s*\[/;
    const startMatch = response.match(startMarker);
    if (!startMatch || startMatch.index == null) return [];

    const arrayStart = startMatch.index + startMatch[0].length;
    let depth = 1;
    let i = arrayStart;
    while (i < response.length && depth > 0) {
        const c = response[i];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        i++;
    }
    if (depth !== 0) return [];

    const arrayStr = response.slice(arrayStart, i - 1);
    try {
        const arr = JSON.parse("[" + arrayStr + "]") as unknown;
        if (!Array.isArray(arr)) return [];
        const result: Array<{ action: string; parameters: any }> = [];
        for (const item of arr) {
            if (item && typeof item === "object" && typeof (item as any).action === "string" && (item as any).parameters != null) {
                result.push({
                    action: (item as any).action,
                    parameters: typeof (item as any).parameters === "object" ? (item as any).parameters : {}
                });
            }
        }
        return result;
    } catch {
        return [];
    }
}

/**
 * Parse the LLM response for task configuration selection.
 * Tries, in order: (1) ```json ... ``` code block, (2) raw JSON object, (3) regex extraction of task_type.
 */
function parseSelectionResponse(response: string): TaskSelectionData {
    elizaLogger.debug(`[TaskExecutor] Parsing LLM response: ${response.substring(0, 200)}...`);

    let parsed: Record<string, any> | null = null;

    // 1) Prefer ```json ... ``` code block
    const jsonBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonBlockMatch) {
        try {
            parsed = JSON.parse(jsonBlockMatch[1].trim());
        } catch {
            parsed = null;
        }
    }

    // 2) No code block or parse failed: try raw JSON object (first { ... })
    if (!parsed) {
        const rawObjectMatch = response.match(/\{[\s\S]*\}/);
        if (rawObjectMatch) {
            try {
                parsed = JSON.parse(rawObjectMatch[0]);
            } catch {
                parsed = null;
            }
        }
    }

    // 3) Fallback: extract task_type (and optionally description, selected_actions) by regex
    if (!parsed) {
        const taskTypeMatch = response.match(/"task_type"\s*:\s*"(llm|action)"/);
        if (taskTypeMatch) {
            const task_type = taskTypeMatch[1];
            const descriptionMatch = response.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
            const description = descriptionMatch
                ? descriptionMatch[1].replace(/\\"/g, '"')
                : "No description provided";
            let selected_actions: Array<{ action: string; parameters: any }> = [];
            if (task_type === "action") {
                const extracted = extractSelectedActionsFromText(response);
                if (extracted.length > 0) {
                    selected_actions = extracted;
                    elizaLogger.debug(`[TaskExecutor] Parsed selected_actions from text (${selected_actions.length} action(s))`);
                }
            }
            parsed = {
                task_type,
                selected_actions,
                description
            };
            elizaLogger.debug(`[TaskExecutor] Parsed from regex fallback (task_type=${task_type})`);
        }
    }

    if (!parsed) {
        throw new Error("No JSON code block or task_type found in LLM response");
    }

    elizaLogger.debug(`[TaskExecutor] Parsed JSON:`, parsed);

    if (!parsed.task_type) {
        throw new Error("Missing 'task_type' field in response");
    }

    if (!parsed.selected_actions) {
        throw new Error("Missing 'selected_actions' field in response");
    }

    if (!Array.isArray(parsed.selected_actions)) {
        throw new Error("'selected_actions' must be an array");
    }

    if (parsed.task_type === "action" && parsed.selected_actions.length === 0) {
        throw new Error("'selected_actions' array cannot be empty for action tasks");
    }

    if (parsed.task_type === "llm" && parsed.selected_actions.length > 0) {
        elizaLogger.warn(`[TaskExecutor] LLM task has actions specified, ignoring actions`);
        parsed.selected_actions = [];
    }

    if (parsed.task_type === "action") {
        for (let i = 0; i < parsed.selected_actions.length; i++) {
            const actionItem = parsed.selected_actions[i];

            if (!actionItem.action) {
                throw new Error(`Action ${i + 1} missing 'action' field`);
            }

            if (typeof actionItem.action !== "string") {
                throw new Error(`Action ${i + 1} 'action' field must be a string`);
            }

            if (!actionItem.parameters) {
                throw new Error(`Action ${i + 1} missing 'parameters' field`);
            }

            if (typeof actionItem.parameters !== "object") {
                throw new Error(`Action ${i + 1} 'parameters' field must be an object`);
            }
        }
    }

    elizaLogger.success(`[TaskExecutor] Successfully parsed task_type: ${parsed.task_type} with ${parsed.selected_actions.length} actions`);

    return {
        task_type: parsed.task_type,
        selected_actions: parsed.selected_actions,
        description: parsed.description || "No description provided"
    };
}

/**
 * Apply configuration to a task node based on LLM selection data.
 */
async function applyTaskConfigurationToTask(
    task: TaskNode,
    selection: TaskSelectionData,
    context: TaskExecutionContext
): Promise<{ task: TaskNode; executionMode: TaskExecutionMode; metadata: Record<string, any> }> {
    const configuredTask: TaskNode = { ...task };

    configuredTask.type = selection.task_type as any;

    switch (selection.task_type) {
        case "llm": {
            configuredTask.config = {
                modelClass: ModelClass.LARGE,
                template: "",
                expectJson: false
            } as LLMTaskConfig;
            elizaLogger.info(`[TaskExecutor] Configured LLM task: ${configuredTask.name}`);
            return {
                task: configuredTask,
                executionMode: "llm",
                metadata: {
                    description: selection.description
                }
            };
        }

        case "action": {
            // Deduplicate actions using local deduplication
            const localResult = deduplicateActions(selection.selected_actions);
            const deduplicated = localResult.deduplicated;
            const removed = localResult.removed;
            const allDuplicates = false;

            if (removed.length > 0) {
                elizaLogger.warn(`[TaskExecutor] Removed ${removed.length} duplicate actions for task: ${configuredTask.name}`);
                removed.forEach(r => elizaLogger.warn(`  - ${r.reason}`));
            }

            if (allDuplicates || deduplicated.length === 0) {
                elizaLogger.info(`[TaskExecutor] All actions were duplicates - summarizing instead of executing`);
                if (context.streamingCallback) {
                    context.streamingCallback({
                        id: uuidv4(),
                        name: "task_update",
                        status: "completed",
                        message: `Task "${configuredTask.name}" has only duplicate actions; skipping execution and recording summary`,
                        timestamp: Date.now(),
                        data: {
                            type: "task_update",
                            chainId: context.chain.id,
                            taskId: configuredTask.id,
                            taskName: configuredTask.name,
                            taskType: "action",
                            status: "running",
                            duplicateOptimization: true,
                            removedDuplicates: removed.map(item => item.action),
                            timestamp: Date.now()
                        }
                    });
                }
                configuredTask.config = {
                    actions: [],
                    duplicateOptimization: true,
                    duplicatesRemoved: removed,
                    originalActionCount: selection.selected_actions.length,
                    summary: `All ${selection.selected_actions.length} proposed actions were duplicates of previous executions`
                } as ActionTaskConfig;
            } else {
                // Mixed mode or all new actions
                configuredTask.config = {
                    actions: deduplicated,
                } as ActionTaskConfig;

                if (removed.length > 0) {
                    elizaLogger.info(`[TaskExecutor] Deduplication: ${deduplicated.length} to execute, ${removed.length} removed`);
                }
            }

            return {
                task: configuredTask,
                executionMode: "action",
                metadata: {
                    description: selection.description,
                    deduplicated: deduplicated.length,
                    removed,
                    allDuplicates
                }
            };
        }

        default:
            throw new Error(`Unsupported task type: ${selection.task_type}`);
    }
}

/**
 * Apply fallback configuration when the selection workflow fails.
 */
function applyFallbackConfiguration(task: TaskNode): TaskNode {
    const fallbackTask: TaskNode = {
        ...task,
        type: "llm",
        config: {
            modelClass: ModelClass.LARGE,
            expectJson: false
        } as LLMTaskConfig
    };

    elizaLogger.warn(`[TaskExecutor] Applied fallback LLM configuration for task: ${fallbackTask.name}`);
    return fallbackTask;
}

/**
 * Format chain context for LLM task - provides overview of the task chain.
 */
function formatChainContextForLLM(task: TaskNode, context: TaskExecutionContext): string {
    const chain = context.chain;
    const totalTasks = chain.tasks.length;
    const currentIndex = chain.tasks.findIndex(t => t.id === task.id);
    const completedTasks = chain.tasks.filter(t => t.status === 'completed').length;
    
    const dependencyCount = task.dependencies?.length || 0;
    const dependencyNames = task.dependencies
        ?.map(depId => chain.tasks.find(t => t.id === depId)?.name)
        .filter(Boolean)
        .join(', ') || 'None';

    return `Chain: ${chain.name}
Total Tasks: ${totalTasks}
Current Task: ${currentIndex + 1}/${totalTasks}
Completed: ${completedTasks}/${totalTasks}
Dependencies: ${dependencyNames} (${dependencyCount} task${dependencyCount === 1 ? '' : 's'})`;
}

/**
 * Format action summary for tasks - provides concise summary of prerequisite tasks with parameters.
 * Used for both action selection and LLM task execution.
 */
function formatActionSummaryForLLM(task: TaskNode, context: TaskExecutionContext): string {
    const resolver = new DefaultDependencyResolver();
    const dependencyTaskIds = resolver.getAllDependencies(task.id, context.chain);
    
    const dependencyTasks = dependencyTaskIds
        .map(depId => context.chain.tasks.find(t => t.id === depId))
        .filter((t): t is TaskNode => !!t && t.status === 'completed');

    if (dependencyTasks.length === 0) {
        return 'No prerequisite tasks completed yet.';
    }

    const summaries = dependencyTasks.map(depTask => {
        const taskType = depTask.type === 'action' ? 'Action Task' : 'LLM Task';
        let summary = `- **${depTask.name}** (${taskType})`;
        
        const resultData = depTask.result?.data;
        const config = depTask.config as ActionTaskConfig;
        
        if (depTask.type === 'action' && resultData) {
            // Show action parameters first (from config)
            if (config?.actions && Array.isArray(config.actions)) {
                const actionParams = config.actions.map(a => {
                    const params = Object.entries(a.parameters)
                        .map(([k, v]) => `${k}:${v}`)
                        .join(', ');
                    return params ? `${a.action}(${params})` : a.action;
                }).join(', ');
                summary += `\n  Executed: ${actionParams}`;
            }
            
            if (resultData.results && Array.isArray(resultData.results)) {
                const actionSummaries = resultData.results
                    .map((actionResult: any) => {
                        const actionName = actionResult.action || 'unknown';
                        const actionSum = actionResult.result?.actionData?.summary;
                        if (actionSum && typeof actionSum === 'string') {
                            return `    • ${actionName}: ${actionSum}`;
                        }
                        return `    • ${actionName}: ✓ completed`;
                    })
                    .join('\n');
                summary += `\n  Results:\n${actionSummaries}`;
            } else {
                summary += '\n  Status: ✓ Data available';
            }
        } else if (depTask.type === 'llm' && resultData) {
            // Prefer using the LLM-generated summary if available
            if (resultData.summary && typeof resultData.summary === 'string') {
                summary += `\n  Summary: ${resultData.summary}`;
            } else {
                summary += '\n  Status: ✓ Analysis completed';
            }
        }
        
        return summary;
    });

    return `Completed prerequisite tasks (${dependencyTasks.length}):\n\n${summaries.join('\n\n')}`;
}

/**
 * Execute an LLM task and capture rendered context and template.
 */
async function runLLMTask(
    task: TaskNode,
    inputs: Record<string, any>,
    context: TaskExecutionContext
): Promise<{ result: any; template: string; renderedContext: string }> {
    elizaLogger.info(`[TaskExecutor] Executing LLM task "${task.name}"`);
    elizaLogger.info(`[TaskExecutor] LLM task inputs: ${JSON.stringify(inputs, null, 2)}`);

    const config = task.config as LLMTaskConfig;
    const template = await generateCustomTemplate(task, context);
    const chainContext = formatChainContextForLLM(task, context);
    const actionSummary = formatActionSummaryForLLM(task, context);
    const currentTime = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';

    // Only include essential context - no conversation history
    // Required State fields are set to empty strings to satisfy type constraints
    const mergedState = {
        // Required State fields (empty values - not needed for task execution)
        bio: "",
        lore: "",
        messageDirections: "",
        postDirections: "",
        actors: "",
        recentMessages: "",
        recentMessagesData: [],
        // Essential task context
        roomId: context.state.roomId,
        currentTime,
        chainContext,
        taskName: task.name,
        taskDescription: task.description,
        actionSummary,
        languageInstruction: (context.state as any).languageInstruction || ""
    };

    elizaLogger.info(`[TaskExecutor] Using custom generated template for LLM task "${task.name}"`);

    const renderedContext = composeContext({
        state: mergedState,
        template
    });

    const response = await generateText({
        runtime: context.runtime,
        prompt: renderedContext,
        modelClass: config.modelClass
    });

    elizaLogger.info(`[TaskExecutor] LLM task "${task.name}" completed`);

    // Parse JSON response with results and summary
    let parsedResponse: { results: string; summary: string } | null = null;
    let resultText = response.trim();
    let summaryText = '';

    try {
        // Try to extract JSON from the response
        const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
        const jsonContent = jsonMatch ? jsonMatch[1] : response;
        
        // Try parsing as JSON
        const parsed = JSON.parse(jsonContent.trim());
        if (parsed.results && typeof parsed.results === 'string') {
            parsedResponse = parsed;
            resultText = parsed.results;
            summaryText = parsed.summary || '';
            elizaLogger.info(`[TaskExecutor] LLM task "${task.name}" parsed JSON response with summary`);
        }
    } catch {
        // Not valid JSON, use raw response as text
        elizaLogger.debug(`[TaskExecutor] LLM task "${task.name}" response is not JSON, using raw text`);
    }

    return {
        template,
        renderedContext,
        result: {
            text: resultText,
            summary: summaryText,
            markdown: true,
            metadata: {
                taskName: task.name,
                taskType: "llm",
                responseFormat: "markdown",
                isMarkdownFormatted: true,
                taskId: task.id,
                chainId: context.chain?.id,
                isActionResponse: true,
                actionName: `llm_analysis_${task.name.toLowerCase().replace(/\s+/g, '_')}`,
                success: true,
                hasSummary: !!summaryText
            }
        }
    };
}

/**
 * Extract cacheable text from an action result for action cache storage.
 */
function extractActionResultTextForCache(actionResult: any): string | null {
    if (!actionResult) {
        return null;
    }

    const result = actionResult.result ?? actionResult;

    if (typeof result === "string") {
        return result;
    }

    if (typeof result?.text === "string") {
        return result.text;
    }

    if (typeof result?.actionData === "string") {
        return result.actionData;
    }

    if (result?.actionData && typeof result.actionData === "object") {
        try {
            return JSON.stringify(result.actionData);
        } catch {
            return null;
        }
    }

    if (typeof result === "object") {
        try {
            return JSON.stringify(result);
        } catch {
            return null;
        }
    }

    return null;
}

/**
 * Execute an action task sequence.
 */
async function runActionTask(
    task: TaskNode,
    inputs: Record<string, any>,
    context: TaskExecutionContext
): Promise<any> {
    const config = task.config as ActionTaskConfig;

    if (!config.actions || !Array.isArray(config.actions)) {
        throw new Error(`Invalid action configuration for task: ${task.name}`);
    }

    if (config.actions.length === 0 && (config as any).duplicateOptimization) {
        const removed = (config as any).duplicatesRemoved ?? [];
        const summary = (config as any).summary
            ?? `All actions were previously executed; no duplicate actions run for task ${task.name}.`;

        elizaLogger.success(`[TaskExecutor] Task "${task.name}" detected duplicate actions only; generating summary without execution`);
        return {
            summary,
            duplicatesRemoved: removed,
            results: [],
            optimized: true,
            actionCount: 0,
            reason: "All actions were duplicates - no execution performed",
            duplicateOptimization: true,
            shouldRemove: false,
            skipMemoryCreation: false,
            text: summary
        };
    }

    // NOW execute new actions
    const actionsToExecute = config.actions;
    elizaLogger.info(`[TaskExecutor] Executing ${actionsToExecute.length} action(s) for task: ${task.name}`);

    const results: any[] = [];

    for (let i = 0; i < actionsToExecute.length; i++) {
        if (context.runtime.shouldStop && context.runtime.shouldStop()) {
            throw new Error("Processing stopped by user request");
        }

        const actionItem = actionsToExecute[i];
        const action = getNonCEXActions(context.runtime).find(
            (a: Action) => a.name === actionItem.action
        );
        if (!action) {
            throw new Error(`Action not found: ${actionItem.action}`);
        }

        elizaLogger.info(`[TaskExecutor] Executing action ${i + 1}/${actionsToExecute.length}: ${action.name}`);
        elizaLogger.info(`[TaskExecutor] Action parameters: ${JSON.stringify(actionItem.parameters)}`);

        const dataRetention = await getDataRetentionConfig(context.runtime, context.originalMessage.userId);
        const actionParams = {
            ...actionItem.parameters,
            ...inputs,
            fromTaskChain: true,  // Flag to indicate this action is called from task chain
            ...dataRetention
        };

        elizaLogger.info(`[TaskExecutor] Final action parameters (with inputs): ${JSON.stringify(actionParams)}`);

        try {
            const actionResult = await executeActionWithCallback(
                action,
                context.runtime,
                context.originalMessage,
                context.state,
                actionParams,
                context,
                task
            );

            if (actionResult?.actionData) {
                elizaLogger.info(`[TaskExecutor] Action ${action.name} returned structured data for task chain`);
            }

            results.push({
                action: action.name,
                parameters: actionParams,
                result: actionResult,
                success: true
            });

            elizaLogger.success(`[TaskExecutor] Action ${action.name} completed successfully`);

            if (i < actionsToExecute.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }

        } catch (error: any) {
            elizaLogger.error(`[TaskExecutor] Action ${action.name} failed: ${error.message}`);
            results.push({
                action: action.name,
                parameters: actionParams,
                error: error.message,
                success: false
            });
        }
    }

    const successfulResults = results.filter(r => r.success);
    const failedResults = results.filter(r => !r.success);

    if (successfulResults.length === 0) {
        const error = new Error(`All actions failed for task: ${task.name}`);
        (error as any).results = results;
        throw error;
    }

    elizaLogger.info(`[TaskExecutor] Task ${task.name} completed: ${successfulResults.length} successful, ${failedResults.length} failed`);

    const summary = `Executed ${actionsToExecute.length} actions: ${successfulResults.length} successful, ${failedResults.length} failed`;

    return {
        results,
        successful: successfulResults,
        failed: failedResults,
        summary
    };
}

/**
 * Execute a single action with callback support for streaming.
 */
function executeActionWithCallback(
    action: Action,
    runtime: any,
    message: Memory,
    state: any,
    params: any,
    context?: TaskExecutionContext,
    currentTask?: TaskNode
): Promise<any> {
    return new Promise((resolve, reject) => {
        let callbackResult: any = null;
        let callbackCalled = false;

        const callback: HandlerCallback = async (content: any, loadingId?: string) => {
            elizaLogger.info(`[TaskExecutor] Callback received for ${action.name}`);

            const enhancedContent = {
                ...content,
                metadata: {
                    ...content.metadata,
                    isActionResponse: true,
                    actionName: action.name,
                    success: true,
                    noStreaming: content.metadata?.noStreaming ?? true
                }
            };

            if (context?.intermediateResultCallback && enhancedContent.metadata?.noStreaming !== true) {
                try {
                    const enhancedContentWithTask = {
                        ...enhancedContent,
                        metadata: {
                            ...enhancedContent.metadata,
                            taskId: currentTask?.id,
                            taskName: currentTask?.name,
                            chainId: context.chain?.id
                        }
                    };

                    const streamMemory = {
                        id: uuidv4() as UUID,
                        userId: context.runtime.agentId,
                        agentId: context.runtime.agentId,
                        roomId: context.originalMessage.roomId,
                        createdAt: Date.now(),
                        content: enhancedContentWithTask
                    };

                    elizaLogger.info(`[TaskExecutor] Streaming action result for ${action.name} (task: ${currentTask?.name}, taskId: ${currentTask?.id})`);
                    context.intermediateResultCallback(streamMemory);

                    if (currentTask) {
                        (currentTask as any).hasBeenStreamed = true;
                    }
                } catch (error: any) {
                    elizaLogger.error(`[TaskExecutor] Failed to stream intermediate result: ${error.message}`);
                }
            }

            callbackResult = enhancedContent;
            callbackCalled = true;

            if (enhancedContent.metadata?.actionData) {
                elizaLogger.info(`[TaskExecutor] Captured actionData from callback metadata for ${action.name}`);
                callbackResult.actionData = enhancedContent.metadata.actionData;
            }

            elizaLogger.info(`[TaskExecutor] Callback received for ${action.name}, resolving`);
            resolve(callbackResult);
            return [];
        };

        elizaLogger.info(`[TaskExecutor] Executing action ${action.name} with hybrid callback/return pattern`);

        // Inject the chain-level onToken (if any) so the action's internal
        // generateText calls can stream LLM deltas straight to the SSE
        // endpoint. Actions that don't read options.onToken simply ignore it.
        const paramsWithOnToken = context?.onToken
            ? { ...params, onToken: context.onToken }
            : params;
        const handlerPromise = action.handler(runtime, message, state, paramsWithOnToken, callback);

        handlerPromise
            .then((handlerResult) => {
                if (handlerResult && typeof handlerResult === "object") {
                    elizaLogger.info(`[TaskExecutor] Action ${action.name} returned structured data`);

                    if (callbackResult) {
                        callbackResult.actionData = handlerResult;
                    }

                    if ((handlerResult as any).text || (handlerResult as any).content) {
                        const enhancedResult = {
                            ...handlerResult,
                            actionData: handlerResult,
                            metadata: {
                                ...(callbackResult?.metadata || {}),
                                ...((handlerResult as any).metadata || {}),
                                isActionResponse: true,
                                actionName: action.name,
                                success: true,
                                taskId: currentTask?.id,
                                taskName: currentTask?.name,
                                chainId: context?.chain?.id
                            }
                        };
                        resolve(enhancedResult);
                        return;
                    }
                }

                if (!callbackCalled) {
                    elizaLogger.debug(`[TaskExecutor] No callback for ${action.name}, using handler result`, handlerResult);
                    const result = (typeof handlerResult === "object" && handlerResult !== null ? handlerResult : {}) as any;

                    const enhancedResult = {
                        ...result,
                        actionData: handlerResult,
                        text: result.text || `Action ${action.name} completed`,
                        metadata: {
                            ...(callbackResult?.metadata || {}),
                            ...(result.metadata || {}),
                            isActionResponse: true,
                            actionName: action.name,
                            success: !!handlerResult,
                            taskId: currentTask?.id,
                            taskName: currentTask?.name,
                            chainId: context?.chain?.id
                        }
                    };
                    resolve(enhancedResult);
                }
            })
            .catch((error) => {
                if (!callbackCalled) {
                    reject(error);
                }
            });

        setTimeout(() => {
            if (!callbackCalled) {
                elizaLogger.warn(`[TaskExecutor] Action ${action.name} timed out after 300 seconds`);
                reject(new Error(`Action ${action.name} timed out`));
            }
        }, 300000);
    });
}

/**
 * Generate a custom template for LLM tasks.
 * Appends LLM_TASK_FORMATTING_REQUIREMENTS to ensure consistent markdown formatting and summary generation.
 */
async function generateCustomTemplate(
    task: TaskNode,
    context: TaskExecutionContext
): Promise<string> {
    const languageInstruction = (context.state as any).languageInstruction || "";
    const templateGenerationPrompt = getLLMTaskTemplateGenerationPrompt(
        task.name,
        task.description,
        languageInstruction
    );

    const customTemplate = await generateText({
        runtime: context.runtime,
        prompt: templateGenerationPrompt,
        modelClass: ModelClass.LARGE
    });

    // Append formatting requirements, summary generation instructions, and language instruction
    const finalTemplate = `${customTemplate.trim()}

${LLM_TASK_FORMATTING_REQUIREMENTS}
${languageInstruction}`;

    elizaLogger.debug(`[TaskExecutor] Successfully generated custom template for "${task.name}" with formatting requirements`);
    return finalTemplate;
}

/**
 * Deduplicate actions using crypto-aware heuristics.
 */
function deduplicateActions(actions: Array<{ action: string; parameters: any }>): {
    deduplicated: Array<{ action: string; parameters: any }>;
    removed: Array<{ action: string; parameters: any; reason: string }>;
} {
    const deduplicated: Array<{ action: string; parameters: any }> = [];
    const removed: Array<{ action: string; parameters: any; reason: string }> = [];
    const seen = new Set<string>();

    for (const actionItem of actions) {
        const key = createActionKey(actionItem.action, actionItem.parameters);

        if (seen.has(key)) {
            removed.push({
                ...actionItem,
                reason: `Duplicate action: ${actionItem.action} with same parameters`
            });
            elizaLogger.warn(`[TaskExecutor] Removing duplicate action: ${actionItem.action} with parameters: ${JSON.stringify(actionItem.parameters)}`);
        } else {
            seen.add(key);
            deduplicated.push(actionItem);
        }
    }

    if (removed.length > 0) {
        elizaLogger.info(`[TaskExecutor] Deduplication: kept ${deduplicated.length}, removed ${removed.length} duplicates`);
    }

    return { deduplicated, removed };
}

/**
 * Create a unique key for action deduplication.
 */
function createActionKey(actionName: string, parameters: any): string {
    const criticalParams: string[] = [];

    if (parameters.symbol) {
        criticalParams.push(`symbol:${parameters.symbol}`);
    }

    if (parameters.target) {
        criticalParams.push(`target:${parameters.target}`);
    }

    if (parameters.from) {
        criticalParams.push(`from:${parameters.from}`);
    }
    if (parameters.to) {
        criticalParams.push(`to:${parameters.to}`);
    }

    if (parameters.data_type) {
        criticalParams.push(`data_type:${parameters.data_type}`);
    }

    return `${actionName}|${criticalParams.sort().join("|")}`;
}


/**
 * Format public memories for context injection
 */
function formatMemoriesForContext(memories: Memory[]): string {
    if (memories.length === 0) {
        return '';
    }

    return memories.map((memory, index) => {
        const timestamp = memory.createdAt || Date.now();
        const timeAgo = formatTimeAgo(timestamp);
        const content = memory.content?.text || JSON.stringify(memory.content);

        return `${index + 1}. **${timeAgo}**: ${content.slice(0, 300)}${content.length > 300 ? '...' : ''}`;
    }).join('\n\n');
}

/**
 * Format timestamp as relative time
 */
function formatTimeAgo(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);

    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}
