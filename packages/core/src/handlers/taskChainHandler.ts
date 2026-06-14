/**
 * Task Chain Handler using LangGraph workflow architecture
 * Replaces the existing TaskChain orchestrator with a workflow-based approach
 * Provides full control over task chain planning and execution
 */

import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { elizaLogger } from "../utils/logger.ts";
import { StateGraph, Annotation } from "@langchain/langgraph";
import type {
    IAgentRuntime,
    Memory,
    State,
    UUID,
    StreamingCallback,
    HandlerCallback,
    ProcessingStep,
    Action,
    TaskChain,
    TaskNode,
    TaskStatus,
    TaskType,
    TaskExecutionContext,
    ChainExecutionStatus,
    ChainExecutionResult,
    ChainOrchestratorConfig,
    TaskChainPlanner,
    ActionTaskConfig
} from "../core/types.ts";
import { ModelClass } from "../core/types.ts";
import { DefaultTaskChainPlanner } from "../tasks/taskChainPlanner.ts";
import { DefaultTaskExecutor } from "../tasks/taskExecutor.ts";
import { DefaultDependencyResolver } from "../tasks/dependencyResolver.ts";
import {
    generateTaskChainSnapshot,
    chainToTaskChainData,
    type TaskChainSnapshot
} from "../utils/taskChainSnapshot.ts";
import { attachResponseSummary } from "../utils/persistResponseSummary.ts";
import { logTaskChainOutcome } from "../utils/executionLogger.ts";
import { getOrchestratorConfig } from "../config/taskChainConfig.ts";
import { buildLangSmithRunnableConfig } from "../utils/langsmith.ts";
import { getNonCEXActions } from "../utils/pluginFilter.ts";
import { getLanguageInstruction } from "../utils/languageUtils.ts";
import {
    superviseChain as callSupervisor,
    applySupervisionModifications as applySupervisorMods,
    isSupervisorEnabled,
    findNextPendingLevelIndex
} from "../tasks/taskChainSupervisor.ts";
import { getPendingHumanInputs } from "./humanInputState.ts";

const PENDING_APPROVALS_KEY = "__pendingApprovals";
const TASK_CHAIN_AUTO_APPROVE_TIMEOUT_MS = 60_000;

/**
 * Sentinel error message used by the SSE close handler in client-direct to
 * signal that a user disconnected before deciding on a pending task-chain
 * approval. The handler in this file recognizes it and treats it as a clean
 * cancellation — not a workflow error — because there's nothing to recover
 * from and no UI left to surface a message to.
 *
 * Imported on the client-direct side via the @elizaos/core barrel export so
 * the two ends stay in sync.
 */
export const TASK_CHAIN_APPROVAL_CANCELLED_BY_DISCONNECT =
    "TASK_CHAIN_APPROVAL_CANCELLED_BY_DISCONNECT";

const USER_FACING_TASK_FAILURE_MESSAGE = "This task encountered an internal error and could not complete.";
const USER_FACING_WORKFLOW_FAILURE_MESSAGE = "The task chain encountered an internal error. Please try again.";

/**
 * Trim long chat text WITHOUT cutting mid-sentence. Returns the text
 * unchanged when within `cap`; otherwise backs up from `cap` to the last
 * sentence terminator (`. ! ? 。 ！ ？`), else the last line break, else the
 * last space, and appends `marker`. A digest therefore always ends on a
 * complete thought instead of mid-word ("…trend reversal or cons…"). Caps
 * are kept generous so concise task answers render in full — only genuine
 * walls of raw output get trimmed, and even then on a clean boundary.
 */
function clampToSentenceBoundary(text: string, cap: number, marker: string): string {
    if (!text) return text;
    const trimmed = text.trimEnd();
    if (trimmed.length <= cap) return trimmed;
    const window = trimmed.slice(0, cap);
    let cut = -1;
    const re = /[.!?。！？]["')\]]?(?=\s|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(window)) !== null) {
        cut = m.index + m[0].length;
    }
    if (cut < cap * 0.4) {
        const nl = window.lastIndexOf("\n");
        if (nl >= cap * 0.4) {
            cut = nl;
        } else {
            const sp = window.lastIndexOf(" ");
            cut = sp > 0 ? sp : cap;
        }
    }
    return `${window.slice(0, cut).trimEnd()}\n\n${marker}`;
}
const USER_FACING_GENERIC_ERROR_LABEL = "Internal error";
const FAVORITE_CHAIN_KEYS = [
    "favoriteTaskChain",
    "favorite_task_chain",
    "favoriteChain",
    "attachedTaskChain",
    "taskChain"
];

function coerceRecord(value: unknown): Record<string, any> | undefined {
    if (!value) {
        return undefined;
    }

    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
            return undefined;
        }
        try {
            const parsed = JSON.parse(trimmed);
            return typeof parsed === "object" && parsed !== null ? parsed as Record<string, any> : undefined;
        } catch {
            return undefined;
        }
    }

    if (typeof value === "object" && value !== null) {
        return value as Record<string, any>;
    }

    return undefined;
}

function extractFavoriteTaskChainAttachment(message: Memory): Record<string, any> | undefined {
    const content = (message.content ?? {}) as Record<string, any>;

    for (const key of FAVORITE_CHAIN_KEYS) {
        const candidate = coerceRecord(content[key]);
        if (candidate) {
            return candidate;
        }
    }

    const metadata = content.metadata;
    if (metadata && typeof metadata === "object") {
        for (const key of FAVORITE_CHAIN_KEYS) {
            const candidate = coerceRecord((metadata as Record<string, unknown>)[key]);
            if (candidate) {
                return candidate;
            }
        }
    }

    const attachments = Array.isArray(content.attachments) ? content.attachments : [];
    for (const attachment of attachments) {
        if (!attachment || typeof attachment !== "object") {
            continue;
        }
        for (const key of FAVORITE_CHAIN_KEYS) {
            const candidate = coerceRecord((attachment as Record<string, unknown>)[key]);
            if (candidate) {
                return candidate;
            }
        }
    }

    return undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === "string") {
            const trimmed = value.trim();
            if (trimmed.length > 0) {
                return trimmed;
            }
        }
    }
    return undefined;
}

function buildFavoriteChainLabel(chain: Record<string, any>): string {
    const nested = typeof chain.taskChain === "object" && chain.taskChain !== null
        ? chain.taskChain as Record<string, any>
        : undefined;

    const name = firstNonEmptyString(
        chain.name,
        chain.originalName,
        chain.title,
        chain.displayName,
        nested?.name,
        nested?.originalName
    );

    return name ? `Favorite Task Chain: ${name}` : "Favorite Task Chain";
}

function deriveUserRequestFromMessage(message: Memory): string {
    const content = (message.content ?? {}) as Record<string, any>;
    const existingText = typeof content.text === "string" ? content.text.trim() : "";
    if (existingText.length > 0) {
        return existingText;
    }

    const favoriteChain = extractFavoriteTaskChainAttachment(message);
    if (favoriteChain) {
        const nested = typeof favoriteChain.taskChain === "object" && favoriteChain.taskChain !== null
            ? favoriteChain.taskChain as Record<string, any>
            : undefined;

        const request = firstNonEmptyString(
            favoriteChain.originalRequest,
            favoriteChain.description,
            favoriteChain.summary,
            nested?.originalRequest,
            nested?.description,
            nested?.summary
        );

        if (request) {
            return request;
        }

        return buildFavoriteChainLabel(favoriteChain);
    }

    return "Favorite Task Chain";
}

type PendingApprovalDecision = {
    decision: "approved" | "rejected";
    feedback?: string;
    taskChain: TaskChain;
};

type PendingApprovalEntry = {
    message: Memory;
    state: State;
    agentId: string;
    connectionId?: string;
    fullTaskChain?: TaskChain;
    streamingCallback?: StreamingCallback;
    intermediateResponseCallback?: (response: Memory) => void;
    resolve: (decision: PendingApprovalDecision) => void;
    reject: (error: Error) => void;
    createdAt: number;
};

function getPendingApprovals(runtime: IAgentRuntime): Map<string, PendingApprovalEntry> {
    const runtimeWithApprovals = runtime as IAgentRuntime & {
        [PENDING_APPROVALS_KEY]?: Map<string, PendingApprovalEntry>;
    };

    if (!runtimeWithApprovals[PENDING_APPROVALS_KEY]) {
        runtimeWithApprovals[PENDING_APPROVALS_KEY] = new Map();
    }

    return runtimeWithApprovals[PENDING_APPROVALS_KEY]!;
}

/**
 * Returns the in-flight approval (task chain OR CEX human-input) currently
 * registered for the given room, or null if none.
 *
 * The room-to-approval mapping is:
 *   - Task chain approvals: `__pendingApprovals` keyed by `threadId`,
 *     which the planner sets to `state.roomId`. See `waitForTaskChainApproval`
 *     callers — `threadId = (state as any).roomId` at taskChainHandler.ts:2695.
 *   - CEX approvals: `__pendingHumanInputApprovals` (composite key
 *     `${threadId}:${approvalId}`); `entry.threadId === roomId`.
 *
 * Both share `createdAt` so the UI can render an elapsed-time hint.
 */
export function getPendingApprovalForRoom(
    runtime: IAgentRuntime,
    roomId: UUID
): { kind: "task_chain" | "cex"; threadId: string; startedAt?: number } | null {
    const taskChain = getPendingApprovals(runtime).get(roomId);
    if (taskChain) {
        return { kind: "task_chain", threadId: roomId, startedAt: taskChain.createdAt };
    }

    const humanInputs = getPendingHumanInputs(runtime);
    let cexMatch: { startedAt: number } | null = null;
    for (const entry of humanInputs.values()) {
        if (entry.agentId !== runtime.agentId) continue;
        if (entry.threadId !== roomId) continue;
        // Pick the most-recently-created entry if multiple stack up.
        if (!cexMatch || entry.createdAt > cexMatch.startedAt) {
            cexMatch = { startedAt: entry.createdAt };
        }
    }
    if (cexMatch) {
        return { kind: "cex", threadId: roomId, startedAt: cexMatch.startedAt };
    }
    return null;
}

function waitForTaskChainApproval(
    runtime: IAgentRuntime,
    threadId: string,
    context: Omit<PendingApprovalEntry, "resolve" | "reject" | "createdAt">
): Promise<PendingApprovalDecision> {
    const pendingApprovals = getPendingApprovals(runtime);

    return new Promise((decisionResolve, decisionReject) => {
        const existing = pendingApprovals.get(threadId);
        if (existing) {
            try {
                existing.reject(new Error("Pending approval replaced by a new request"));
            } catch (error) {
                elizaLogger.warn(`Failed to reject existing approval for thread ${threadId}: ${String(error)}`);
            }
        }

        const entry: PendingApprovalEntry = {
            ...context,
            resolve: (decision) => {
                clearTimeout(autoApproveTimer);
                pendingApprovals.delete(threadId);
                decisionResolve(decision);
            },
            reject: (error) => {
                clearTimeout(autoApproveTimer);
                pendingApprovals.delete(threadId);
                decisionReject(error);
            },
            createdAt: Date.now()
        };

        pendingApprovals.set(threadId, entry);
        elizaLogger.info(`[handleMessageWithTaskChain] Stored pending approval context for thread: ${threadId}`);

        const autoApproveTimer = setTimeout(() => {
            const currentEntry = pendingApprovals.get(threadId);
            if (currentEntry?.fullTaskChain) {
                elizaLogger.info(`[waitForTaskChainApproval] Auto-approving thread ${threadId} after ${TASK_CHAIN_AUTO_APPROVE_TIMEOUT_MS}ms timeout`);
                currentEntry.resolve({ decision: 'approved', taskChain: currentEntry.fullTaskChain });
            }
        }, TASK_CHAIN_AUTO_APPROVE_TIMEOUT_MS);
    });
}

function ensureTaskChainPlanner(runtime: IAgentRuntime): DefaultTaskChainPlanner {
    const existing = runtime.taskChainPlanner;

    if (isLangGraphPlanner(existing)) {
        return existing;
    }

    const planner = new DefaultTaskChainPlanner(runtime);
    runtime.taskChainPlanner = planner;
    return planner;
}

function isLangGraphPlanner(
    planner: TaskChainPlanner | undefined
): planner is DefaultTaskChainPlanner {
    return !!planner && typeof (planner as any).resumeWithApproval === "function";
}

// LangGraph State Definition for Task Chain Workflow
export const TaskChainWorkflowState = Annotation.Root({
    // Input parameters
    message: Annotation<Memory>(),
    runtime: Annotation<IAgentRuntime>(),
    state: Annotation<State>(),
    streamingCallback: Annotation<StreamingCallback>(),
    intermediateResultCallback: Annotation<(response: Memory) => void>(),
    /** Per-token streaming callback forwarded into action handlers via TaskExecutionContext. */
    onToken: Annotation<(delta: string) => void | Promise<void>>(),

    // User request and context
    userRequest: Annotation<string>(),
    availableActions: Annotation<Action[]>(),
    originalMessage: Annotation<Memory>(),
    userTraits: Annotation<string>(),
    languageInstruction: Annotation<string>(),

    // Chain planning phase
    plannedChain: Annotation<TaskChain>(),
    optimizedChain: Annotation<TaskChain>(),
    validationResult: Annotation<{
        isValid: boolean;
        errors: string[];
        warnings: string[];
    }>(),

    // Dependency resolution
    dependencyGraph: Annotation<Map<UUID, UUID[]>>(),
    executionLevels: Annotation<UUID[][]>(),

    // Task execution phase
    currentChain: Annotation<TaskChain>(),
    currentLevelIndex: Annotation<number>(),
    currentTaskIndex: Annotation<number>(),
    executingTasks: Annotation<UUID[]>(),
    completedTasks: Annotation<UUID[]>(),
    failedTasks: Annotation<UUID[]>(),
    taskResults: Annotation<Map<UUID, any>>(),
    taskInputs: Annotation<Map<UUID, Record<string, any>>>(),

    // Progress tracking
    executionStatus: Annotation<ChainExecutionStatus>(),
    progress: Annotation<{
        completed: number;
        total: number;
        running: string[];
        estimatedTimeRemaining?: number;
    }>(),
    currentPhase: Annotation<string>(),

    // Execution memories and results
    executionMemories: Annotation<Memory[]>(),
    chainOutputs: Annotation<Record<string, any>>(),
    executionStats: Annotation<{
        totalDuration: number;
        tasksExecuted: number;
        tasksFailed: number;
        totalTokens: number;
        totalCost?: number;
    }>(),

    // Control flow
    phase: Annotation<string>(),
    isComplete: Annotation<boolean>(),
    /** Number of times the supervisor has successfully modified the chain (prevents infinite loops) */
    supervisionModificationCount: Annotation<number>(),
    hasError: Annotation<boolean>(),
    errorMessage: Annotation<string>(),
    shouldStop: Annotation<boolean>(),
    startTime: Annotation<number>(),
    endTime: Annotation<number>(),

    // Configuration
    config: Annotation<ChainOrchestratorConfig>(),

    // Snapshot data
    chainSnapshot: Annotation<TaskChainSnapshot>()
});

export type TaskChainWorkflowStateType = typeof TaskChainWorkflowState.State;

/**
 * Initialize the task chain workflow
 */
async function initializeWorkflow(state: TaskChainWorkflowStateType): Promise<Partial<TaskChainWorkflowStateType>> {
    const startTime = Date.now();
    elizaLogger.info("[TaskChainWorkflow] Initializing task chain workflow");

    try {
        const preExistingChain = state.currentChain || state.optimizedChain || state.plannedChain;

        // Extract user request from message
        const userRequest = preExistingChain?.originalRequest
            || state.userRequest
            || state.message?.content?.text
            || "";
        if (!userRequest) {
            throw new Error("No user request provided");
        }

        // Get user traits from UserFeatureManager (new memory-based system with semantic search)
        let userTraits = "";
        const userId = state.message?.userId;
        if (userId && userId !== state.runtime.agentId) {
            try {
                const formattedTraits = await state.runtime.userFeatureManager.formatUserTraitsForContext(
                    userId,
                    {
                        queryMessage: state.message?.content.text,
                        topN: 3,
                        similarityThreshold: 0.3,
                        fallbackToAll: true
                    }
                );
                if (formattedTraits) {
                    // Convert format from "# User Profile..." to "## User Profile Context"
                    userTraits = formattedTraits.replace(
                        /# User Profile \([^)]+\)/,
                        "## User Profile Context"
                    );
                    elizaLogger.debug(`[TaskChainWorkflow] Loaded user traits for ${userId}`);
                }
            } catch (error) {
                elizaLogger.warn(`[TaskChainWorkflow] Failed to load user traits: ${error}`);
            }
        }

        const languageInstruction = getLanguageInstruction();

        const defaultProgress = {
            completed: preExistingChain?.tasks.filter(task => task.status === 'completed').length ?? 0,
            total: preExistingChain?.tasks.length ?? 0,
            running: [] as string[],
            estimatedTimeRemaining: state.executionStatus?.progress.estimatedTimeRemaining
        };

        // Initialize execution status using existing data when available
        const executionStatus: ChainExecutionStatus = {
            chainId: preExistingChain?.id ?? state.executionStatus?.chainId ?? (uuidv4() as UUID),
            status: state.executionStatus?.status ?? 'pending',
            progress: {
                ...defaultProgress,
                ...state.executionStatus?.progress
            },
            currentPhase: state.executionStatus?.currentPhase ?? 'Initializing workflow',
            lastUpdate: Date.now(),
        };

        // Get default configuration
        const defaultConfig = getOrchestratorConfig(state.config);

        // Stream workflow start notification
        if (state.streamingCallback) {
            state.streamingCallback({
                id: uuidv4(),
                name: 'task_chain_start',
                status: 'completed',
                message: `Starting task chain workflow for: "${userRequest}"`,
                timestamp: startTime,
                data: {
                    type: 'workflow_start',
                    phase: 'initialization',
                    userRequest: userRequest
                }
            });
        }

        return {
            userRequest,
            userTraits,
            languageInstruction,
            originalMessage: state.message ?? state.originalMessage,
            startTime: state.startTime ?? startTime,
            executionStatus,
            config: defaultConfig,
            phase: preExistingChain ? 'dependency_resolution' : 'planning',
            isComplete: false,
            hasError: false,
            shouldStop: false,
            currentPhase: preExistingChain ? 'Validating provided chain' : 'Planning task chain',
            executionMemories: state.executionMemories ?? [],
            taskResults: state.taskResults ?? new Map(),
            taskInputs: state.taskInputs ?? new Map(),
            completedTasks: state.completedTasks ?? [],
            failedTasks: state.failedTasks ?? [],
            executingTasks: state.executingTasks ?? [],
            currentLevelIndex: state.currentLevelIndex ?? 0,
            currentTaskIndex: state.currentTaskIndex ?? 0
        };

    } catch (error: any) {
        elizaLogger.error(`[TaskChainWorkflow] Initialization failed: ${error.message}`);
        return {
            hasError: true,
            errorMessage: `Workflow initialization failed: ${error.message}`,
            phase: 'error'
        };
    }
}

/**
 * Plan the task chain using the TaskChainPlanner
 */
async function planTaskChain(state: TaskChainWorkflowStateType): Promise<Partial<TaskChainWorkflowStateType>> {
    elizaLogger.info("[TaskChainWorkflow] Planning task chain");

    try {
        const initialStopState = checkForStopRequest(state, "Stopped during chain planning");
        if (initialStopState) {
            elizaLogger.info("🛑 [TaskChainWorkflow] Stop request received before planning started");
            return initialStopState;
        }

        if (state.plannedChain) {
            const plannedChain = state.plannedChain;
            const updatedStatus = {
                ...(state.executionStatus ?? {
                    chainId: plannedChain.id,
                    status: 'pending' as const,
                    progress: {
                        completed: 0,
                        total: plannedChain.tasks.length,
                        running: [],
                        estimatedTimeRemaining: plannedChain.metadata?.estimatedDuration
                    },
                    currentPhase: 'Chain provided - optimizing',
                    lastUpdate: Date.now()
                }),
                progress: {
                    ...(state.executionStatus?.progress ?? {
                        completed: 0,
                        running: [] as string[],
                        estimatedTimeRemaining: plannedChain.metadata?.estimatedDuration
                    }),
                    total: plannedChain.tasks.length
                },
                currentPhase: 'Chain provided - optimizing',
                lastUpdate: Date.now()
            };

            return {
                plannedChain,
                executionStatus: updatedStatus,
                phase: 'optimization',
                currentPhase: 'Optimizing chain'
            };
        }

        const planner = ensureTaskChainPlanner(state.runtime);

        // Combine user request with user traits for context-aware planning
        const requestWithContext = state.userTraits
            ? `${state.userRequest}\n\n${state.userTraits}`
            : state.userRequest!;

        // Plan the chain with streaming callback
        const stateWithLanguage = {
            ...state.state!,
            languageInstruction: state.languageInstruction || ""
        };
        const plannedChain = await planner.planChain(
            requestWithContext,
            stateWithLanguage,
            state.availableActions || [],
            state.streamingCallback
        );

        // Update progress
        const updatedStatus = {
            ...state.executionStatus!,
            progress: {
                ...state.executionStatus!.progress,
                total: plannedChain.tasks.length
            },
            currentPhase: 'Chain planned - optimizing',
            lastUpdate: Date.now()
        };

        const plannedStateForStopCheck = {
            ...state,
            executionStatus: updatedStatus,
            progress: updatedStatus.progress
        } as TaskChainWorkflowStateType;
        const postPlanningStopState = checkForStopRequest(plannedStateForStopCheck, "Stopped during chain planning");
        if (postPlanningStopState) {
            elizaLogger.info("🛑 [TaskChainWorkflow] Stop request received after planning completed");
            return {
                ...postPlanningStopState,
                plannedChain,
                executionStatus: {
                    ...(postPlanningStopState.executionStatus ?? updatedStatus),
                    progress: updatedStatus.progress,
                    lastUpdate: Date.now()
                },
                currentPhase: postPlanningStopState.currentPhase ?? "Stopped during chain planning",
                phase: "stopped"
            };
        }

        // Stream planning completion
        if (state.streamingCallback) {
            state.streamingCallback({
                id: uuidv4(),
                name: 'chain_planned',
                status: 'completed',
                message: `Task chain planned: ${plannedChain.tasks.length} tasks created`,
                timestamp: Date.now(),
                data: {
                    type: 'chain_planned',
                    chainId: plannedChain.id,
                    chainName: plannedChain.name,
                    tasksCount: plannedChain.tasks.length,
                    tasks: plannedChain.tasks.map(task => ({
                        id: task.id,
                        name: task.name,
                        description: task.description,
                        type: task.type,
                        dependencies: task.dependencies
                    }))
                }
            });
        }

        return {
            plannedChain,
            executionStatus: updatedStatus,
            phase: 'optimization',
            currentPhase: 'Optimizing chain'
        };

    } catch (error: any) {
        elizaLogger.error(`[TaskChainWorkflow] Chain planning failed: ${error.message}`);
        return {
            hasError: true,
            errorMessage: `Chain planning failed: ${error.message}`,
            phase: 'error'
        };
    }
}

/**
 * Optimize the planned chain
 */
async function optimizeChain(state: TaskChainWorkflowStateType): Promise<Partial<TaskChainWorkflowStateType>> {
    elizaLogger.info("[TaskChainWorkflow] Optimizing task chain");

    try {
        const initialStopState = checkForStopRequest(state, "Stopped during chain optimization");
        if (initialStopState) {
            elizaLogger.info("🛑 [TaskChainWorkflow] Stop request received before optimization started");
            return initialStopState;
        }

        if (state.optimizedChain) {
            return {
                optimizedChain: state.optimizedChain,
                phase: 'validation',
                currentPhase: 'Validating chain'
            };
        }

        const planner = ensureTaskChainPlanner(state.runtime);
        const optimizedChain = await planner.optimizeChain(state.plannedChain!);

        const optimizedStateForStopCheck = {
            ...state,
            optimizedChain
        } as TaskChainWorkflowStateType;
        const postOptimizationStopState = checkForStopRequest(optimizedStateForStopCheck, "Stopped during chain optimization");
        if (postOptimizationStopState) {
            elizaLogger.info("🛑 [TaskChainWorkflow] Stop request received after optimization completed");
            return {
                ...postOptimizationStopState,
                optimizedChain,
                currentPhase: postOptimizationStopState.currentPhase ?? "Stopped during chain optimization",
                phase: "stopped"
            };
        }

        return {
            optimizedChain,
            phase: 'validation',
            currentPhase: 'Validating chain'
        };

    } catch (error: any) {
        elizaLogger.error(`[TaskChainWorkflow] Chain optimization failed: ${error.message}`);
        return {
            hasError: true,
            errorMessage: `Chain optimization failed: ${error.message}`,
            phase: 'error'
        };
    }
}

/**
 * Validate the optimized chain
 */
async function validateChain(state: TaskChainWorkflowStateType): Promise<Partial<TaskChainWorkflowStateType>> {
    elizaLogger.info("[TaskChainWorkflow] Validating task chain");

    try {
        const initialStopState = checkForStopRequest(state, "Stopped during chain validation");
        if (initialStopState) {
            elizaLogger.info("🛑 [TaskChainWorkflow] Stop request received before validation started");
            return initialStopState;
        }

        const candidateChain = state.optimizedChain ?? state.currentChain;
        if (!candidateChain) {
            throw new Error("No task chain available for validation");
        }

        const resolver = new DefaultDependencyResolver();
        const validationResult = state.validationResult
            ? {
                ...state.validationResult,
                warnings: state.validationResult.warnings ?? []
            }
            : (() => {
                const result = resolver.validateDependencies(candidateChain) as {
                    isValid: boolean;
                    errors: string[];
                    warnings?: string[];
                };
                return {
                    ...result,
                    warnings: result.warnings ?? []
                };
            })();

        if (!validationResult.isValid) {
            throw new Error(`Chain validation failed: ${validationResult.errors.join(', ')}`);
        }

        const validationStateForStopCheck = {
            ...state,
            validationResult,
            currentChain: state.currentChain ?? state.optimizedChain
        } as TaskChainWorkflowStateType;
        const postValidationStopState = checkForStopRequest(validationStateForStopCheck, "Stopped during chain validation");
        if (postValidationStopState) {
            elizaLogger.info("🛑 [TaskChainWorkflow] Stop request received after validation completed");
            return {
                ...postValidationStopState,
                validationResult,
                currentChain: validationStateForStopCheck.currentChain,
                currentPhase: postValidationStopState.currentPhase ?? "Stopped during chain validation",
                phase: "stopped"
            };
        }

        return {
            validationResult,
            currentChain: state.currentChain ?? state.optimizedChain,
            phase: 'dependency_resolution',
            currentPhase: 'Resolving dependencies'
        };

    } catch (error: any) {
        elizaLogger.error(`[TaskChainWorkflow] Chain validation failed: ${error.message}`);
        return {
            hasError: true,
            errorMessage: `Chain validation failed: ${error.message}`,
            phase: 'error'
        };
    }
}

/**
 * Resolve task dependencies and calculate execution order
 */
async function resolveDependencies(state: TaskChainWorkflowStateType): Promise<Partial<TaskChainWorkflowStateType>> {
    elizaLogger.info("[TaskChainWorkflow] Resolving task dependencies");

    try {
        const initialStopState = checkForStopRequest(state, "Stopped during dependency resolution");
        if (initialStopState) {
            elizaLogger.info("🛑 [TaskChainWorkflow] Stop request received before dependency resolution started");
            return initialStopState;
        }

        const candidateChain = state.currentChain ?? state.optimizedChain ?? state.plannedChain;
        if (!candidateChain) {
            throw new Error("No task chain available for execution");
        }

        const resolver = new DefaultDependencyResolver();
        const executionLevels = state.executionLevels ?? resolver.getOptimalExecutionOrder(candidateChain);

        elizaLogger.info(`[TaskChainWorkflow] Execution plan: ${executionLevels.length} levels`);

        const updatedChain = {
            ...candidateChain,
            metadata: {
                ...candidateChain.metadata,
                status: 'running' as const,
                startTime: candidateChain.metadata.startTime ?? state.startTime ?? Date.now(),
                lastUpdate: Date.now()
            }
        };

        const progress = {
            completed: state.completedTasks?.length ?? 0,
            total: updatedChain.tasks.length,
            running: state.progress?.running ?? [],
            estimatedTimeRemaining: state.progress?.estimatedTimeRemaining ?? updatedChain.metadata.estimatedDuration
        };

        const updatedStatus = {
            ...state.executionStatus!,
            status: 'running' as const,
            progress,
            currentPhase: `Executing level 1/${executionLevels.length}`,
            lastUpdate: Date.now()
        };

        if (state.streamingCallback) {
            state.streamingCallback({
                id: uuidv4(),
                name: 'dependencies_resolved',
                status: 'completed',
                message: `Dependencies resolved: ${executionLevels.length} execution levels`,
                timestamp: Date.now(),
                data: {
                    type: 'dependencies_resolved',
                    executionLevels: executionLevels.length,
                    totalTasks: updatedChain.tasks.length
                }
            });
            state.streamingCallback({
                id: uuidv4(),
                name: 'chain_state',
                status: 'completed',
                message: 'Initial chain state',
                timestamp: Date.now(),
                data: {
                    chainId: updatedChain.id,
                    chain: chainToTaskChainData(updatedChain)
                }
            });
        }

        const dependencyStateForStopCheck = {
            ...state,
            currentChain: updatedChain,
            executionStatus: updatedStatus,
            executionLevels,
            progress
        } as TaskChainWorkflowStateType;
        const postDependencyStopState = checkForStopRequest(dependencyStateForStopCheck, "Stopped during dependency resolution");
        if (postDependencyStopState) {
            elizaLogger.info("🛑 [TaskChainWorkflow] Stop request received after dependency resolution completed");
            return {
                ...postDependencyStopState,
                executionLevels,
                currentChain: updatedChain,
                progress,
                executionStatus: {
                    ...(postDependencyStopState.executionStatus ?? updatedStatus),
                    progress,
                    lastUpdate: Date.now()
                },
                currentPhase: postDependencyStopState.currentPhase ?? "Stopped during dependency resolution",
                phase: "stopped"
            };
        }

        return {
            executionLevels,
            currentChain: updatedChain,
            progress,
            executionStatus: updatedStatus,
            phase: 'execution',
            currentPhase: `Executing level 1/${executionLevels.length}`
        };

    } catch (error: any) {
        elizaLogger.error(`[TaskChainWorkflow] Dependency resolution failed: ${error.message}`);
        return {
            hasError: true,
            errorMessage: `Dependency resolution failed: ${error.message}`,
            phase: 'error',
            currentChain: state.currentChain ?? state.optimizedChain ?? state.plannedChain,
            executionStatus: state.executionStatus ? {
                ...state.executionStatus,
                status: 'failed' as const,
                currentPhase: 'Dependency resolution failed',
                lastUpdate: Date.now()
            } : undefined
        };
    }
}

/**
 * Check if there are more levels to execute
 */
function hasMoreLevels(state: TaskChainWorkflowStateType): boolean {
    if (!state.executionLevels || state.currentLevelIndex === undefined) {
        return false;
    }
    return state.currentLevelIndex < state.executionLevels.length;
}

/**
 * Detect user stop requests and project them into the workflow state.
 */
function checkForStopRequest(
    state: TaskChainWorkflowStateType,
    stopMessage: string
): Partial<TaskChainWorkflowStateType> | null {
    const runtimeStopRequested = Boolean(state.runtime?.shouldStop && state.runtime.shouldStop());
    const stopRequested = state.shouldStop === true || runtimeStopRequested;

    if (!stopRequested) {
        return null;
    }

    const timestamp = Date.now();
    const message = stopMessage || "Processing stopped by user";

    const updatedProgress = state.progress
        ? {
            ...state.progress,
            running: []
        }
        : undefined;

    let updatedStatus: ChainExecutionStatus | undefined = state.executionStatus;
    if (state.executionStatus) {
        updatedStatus = {
            ...state.executionStatus,
            status: "cancelled",
            currentPhase: message,
            progress: state.executionStatus.progress
                ? {
                    ...state.executionStatus.progress,
                    running: []
                }
                : state.executionStatus.progress,
            lastUpdate: timestamp
        };
    }

    // Mark every in-flight task (pending or running) as cancelled so the
    // client can render a clear "Cancelled by user" badge instead of an
    // ambiguous spinner that just stops updating. Also stream a per-task
    // task_update event for each so the live chain state observed by the
    // client reflects the cancellation even before the snapshot lands.
    let updatedChain = state.currentChain;
    const cancelledTaskIds: string[] = [];
    if (state.currentChain) {
        updatedChain = {
            ...state.currentChain,
            tasks: state.currentChain.tasks.map(task => {
                if (task.status === "pending" || task.status === "running") {
                    cancelledTaskIds.push(task.id);
                    return { ...task, status: "cancelled" as TaskStatus };
                }
                return task;
            })
        };
    }

    if (!state.shouldStop && runtimeStopRequested && state.streamingCallback) {
        state.streamingCallback({
            id: uuidv4(),
            name: "task_chain_stopped",
            status: "completed",
            message,
            timestamp,
            data: {
                type: "workflow_stopped",
                reason: message
            }
        });
        if (updatedChain) {
            for (const taskId of cancelledTaskIds) {
                const task = updatedChain.tasks.find(t => t.id === taskId);
                if (!task) continue;
                state.streamingCallback({
                    id: uuidv4(),
                    name: "task_update",
                    status: "completed",
                    message: `Task "${task.name}" cancelled by user`,
                    timestamp,
                    data: {
                        type: "task_update",
                        chainId: updatedChain.id,
                        taskId: task.id,
                        taskName: task.name,
                        status: "cancelled",
                        timestamp
                    }
                });
            }
        }
    }

    const stopState: Partial<TaskChainWorkflowStateType> = {
        shouldStop: true,
        phase: "stopped",
        currentPhase: message,
        executionStatus: updatedStatus,
        hasError: false
    };

    if (updatedChain) {
        stopState.currentChain = updatedChain;
    }
    if (updatedProgress) {
        stopState.progress = updatedProgress;
    }

    return stopState;
}

/**
 * Execute the current level of tasks
 */
async function executeTaskLevel(state: TaskChainWorkflowStateType): Promise<Partial<TaskChainWorkflowStateType>> {
    const levelIndex = state.currentLevelIndex!;
    const level = state.executionLevels![levelIndex];

    elizaLogger.info(`[TaskChainWorkflow] Executing level ${levelIndex + 1}: ${level.length} tasks`);

    try {
        const initialStopState = checkForStopRequest(
            state,
            `Stopped during task execution (level ${levelIndex + 1})`
        );
        if (initialStopState) {
            elizaLogger.info(`🛑 [TaskChainWorkflow] Stop request received before executing level ${levelIndex + 1}`);
            return initialStopState;
        }

        const updatedStatus = {
            ...state.executionStatus!,
            currentPhase: `Executing level ${levelIndex + 1}/${state.executionLevels!.length}`,
            lastUpdate: Date.now()
        };

        const executor = new DefaultTaskExecutor(state.runtime);

        // Create enhanced state with current execution memories for actions to access
        // This allows actions like PREDICTION to see results from previous tasks in this chain
        const enhancedState = {
            ...state.state!,
            taskChainResults: state.executionMemories || [],  // Add current round's action results
            completedTasks: state.completedTasks || [],
            failedTasks: state.failedTasks || [],
            currentPhase: 'task_chain_execution',
            taskChainProgress: {
                currentLevel: levelIndex + 1,
                totalLevels: state.executionLevels?.length || 0,
                completedCount: (state.completedTasks || []).length,
                totalCount: state.currentChain?.tasks.length || 0
            },
            languageInstruction: state.languageInstruction || ""
        };

        const taskContext: TaskExecutionContext = {
            runtime: state.runtime!,
            state: enhancedState,  // Use enhanced state instead of original state
            originalMessage: state.originalMessage!,
            chain: state.currentChain!,
            streamingCallback: state.streamingCallback,
            intermediateResultCallback: state.intermediateResultCallback,
            onToken: state.onToken,
        };

        const levelTasks = level.map(taskId => state.currentChain!.tasks.find(task => task.id === taskId));
        const tasksToExecute = level.filter(taskId => {
            const task = state.currentChain!.tasks.find(t => t.id === taskId);
            return !task || task.status !== "completed";
        });

        if (tasksToExecute.length === 0) {
            elizaLogger.info(`[TaskChainWorkflow] All tasks in level ${levelIndex + 1} already completed; skipping`);
        }

        const levelPromises = tasksToExecute.map(taskId =>
            executeTask(taskId, state.currentChain!, executor, taskContext, state)
        );

        const levelResults = await Promise.allSettled(levelPromises);

        let updatedChain = { ...state.currentChain! };
        const newCompletedTaskIds = new Set(state.completedTasks ?? []);
        const newFailedTaskIds = new Set(state.failedTasks ?? []);
        const newMemories = [...(state.executionMemories ?? [])];
        const newTaskResults = new Map(state.taskResults ?? new Map());

        let abortDueToFailure: string | null = null;

        for (let i = 0; i < levelResults.length; i++) {
            const result = levelResults[i];
            const taskId = tasksToExecute[i];

            if (result.status === "fulfilled") {
                const updatedTask = result.value;

                updatedChain = {
                    ...updatedChain,
                    tasks: updatedChain.tasks.map(task =>
                        task.id === updatedTask.id ? updatedTask : task
                    )
                };

                newCompletedTaskIds.add(taskId);
                newFailedTaskIds.delete(taskId);
                newTaskResults.set(taskId, formatTaskResultForWorkflow(updatedTask));

                if (state.streamingCallback) {
                    state.streamingCallback({
                        id: uuidv4(),
                        name: "task_update",
                        status: "completed",
                        message: `Task "${updatedTask.name}" completed successfully`,
                        timestamp: Date.now(),
                        data: {
                            type: "task_update",
                            chainId: updatedChain.id,
                            taskId: updatedTask.id,
                            taskName: updatedTask.name,
                            status: "completed",
                            timestamp: Date.now()
                        }
                    });
                }

                taskContext.chain = updatedChain;

                if (updatedTask.result?.data) {
                    const memory = await createTaskMemory(updatedTask, taskContext);
                    if (memory) {
                        newMemories.push(memory);
                        const hasBeenStreamed = (updatedTask as any)?.hasBeenStreamed === true;
                        if (!hasBeenStreamed && state.intermediateResultCallback) {
                            state.intermediateResultCallback(memory);
                        }
                    }
                }

            } else {
                elizaLogger.error(`[TaskChainWorkflow] Task ${taskId} failed: ${result.reason}`);

                const failedTaskBeforeUpdate = updatedChain.tasks.find(task => task.id === taskId);
                const failedTask = failedTaskBeforeUpdate
                    ? {
                        ...failedTaskBeforeUpdate,
                        status: "failed" as TaskStatus,
                        result: {
                            ...failedTaskBeforeUpdate.result,
                            error: {
                                message: USER_FACING_TASK_FAILURE_MESSAGE
                            }
                        }
                    }
                    : undefined;

                if (failedTask) {
                    updatedChain = {
                        ...updatedChain,
                        tasks: updatedChain.tasks.map(task =>
                            task.id === taskId ? failedTask : task
                        )
                    };
                    newTaskResults.set(taskId, formatTaskResultForWorkflow(failedTask));
                }

                newFailedTaskIds.add(taskId);
                newCompletedTaskIds.delete(taskId);

                if (!state.currentChain!.config.continueOnFailure) {
                    abortDueToFailure = USER_FACING_TASK_FAILURE_MESSAGE;
                }

                if (state.streamingCallback) {
                    const failedTaskName = failedTask?.name
                        ?? state.currentChain!.tasks.find(task => task.id === taskId)?.name
                        ?? taskId;
                    state.streamingCallback({
                        id: uuidv4(),
                        name: "task_update",
                        status: "completed",
                        message: `Task "${failedTaskName}" failed`,
                        timestamp: Date.now(),
                        data: {
                            type: "task_update",
                            chainId: state.currentChain!.id,
                            taskId,
                            taskName: failedTaskName,
                            status: "failed",
                            timestamp: Date.now(),
                            error: {
                                message: USER_FACING_TASK_FAILURE_MESSAGE
                            }
                        }
                    });
                }

                if (failedTask) {
                    taskContext.chain = updatedChain;
                    const failureMemory = await createTaskMemory(failedTask, taskContext);
                    if (failureMemory) {
                        newMemories.push(failureMemory);
                        const hasBeenStreamed = (failedTask as any)?.hasBeenStreamed === true;
                        if (!hasBeenStreamed && state.intermediateResultCallback) {
                            state.intermediateResultCallback(failureMemory);
                        }
                    }
                }
            }
        }

        for (const task of levelTasks) {
            if (!task) {
                continue;
            }
            if (task.status === "completed") {
                newCompletedTaskIds.add(task.id);
            }
        }

        const completedTasksArray = Array.from(newCompletedTaskIds);
        const failedTasksArray = Array.from(newFailedTaskIds);

        if (abortDueToFailure) {
            return {
                currentChain: updatedChain,
                currentLevelIndex: levelIndex + 1,
                completedTasks: completedTasksArray,
                failedTasks: failedTasksArray,
                executionMemories: newMemories,
                taskResults: newTaskResults,
                hasError: true,
                errorMessage: `Task execution failed: ${abortDueToFailure}`,
                phase: "error"
            };
        }

        const newProgress = {
            completed: completedTasksArray.length,
            total: updatedChain.tasks.length,
            running: [],
            estimatedTimeRemaining: calculateEstimatedTime(
                completedTasksArray.length,
                updatedChain.tasks.length,
                state.startTime!
            )
        };

        const stateForPostExecutionStopCheck = {
            ...state,
            currentChain: updatedChain,
            executionStatus: {
                ...updatedStatus,
                progress: newProgress
            },
            progress: newProgress,
            completedTasks: completedTasksArray,
            failedTasks: failedTasksArray
        } as TaskChainWorkflowStateType;
        const postExecutionStopState = checkForStopRequest(
            stateForPostExecutionStopCheck,
            `Stopped during task execution (level ${levelIndex + 1})`
        );
        if (postExecutionStopState) {
            elizaLogger.info(`🛑 [TaskChainWorkflow] Stop request received after completing level ${levelIndex + 1}`);
            return {
                ...postExecutionStopState,
                currentChain: updatedChain,
                currentLevelIndex: levelIndex + 1,
                completedTasks: completedTasksArray,
                failedTasks: failedTasksArray,
                executionMemories: newMemories,
                taskResults: newTaskResults,
                progress: newProgress,
                executionStatus: {
                    ...(postExecutionStopState.executionStatus ?? {
                        ...updatedStatus,
                        progress: newProgress
                    }),
                    progress: newProgress,
                    lastUpdate: Date.now()
                },
                currentPhase: postExecutionStopState.currentPhase ?? `Stopped during task execution (level ${levelIndex + 1})`,
                phase: "stopped"
            };
        }

        const nextPhaseMessage = hasMoreLevels({ ...state, currentLevelIndex: levelIndex + 1 })
            ? `Completed level ${levelIndex + 1}`
            : "Task execution completed";

        return {
            currentChain: updatedChain,
            currentLevelIndex: levelIndex + 1,
            completedTasks: completedTasksArray,
            failedTasks: failedTasksArray,
            executionMemories: newMemories,
            taskResults: newTaskResults,
            progress: newProgress,
            executionStatus: {
                ...updatedStatus,
                progress: newProgress
            },
            currentPhase: nextPhaseMessage
        };

    } catch (error: any) {
        elizaLogger.error(`[TaskChainWorkflow] Level execution failed: ${error.message}`);
        return {
            hasError: true,
            errorMessage: `Level execution failed: ${error.message}`,
            phase: "error",
            executionStatus: state.executionStatus ? {
                ...state.executionStatus,
                status: 'failed' as const,
                currentPhase: 'Level execution failed',
                lastUpdate: Date.now()
            } : undefined,
            currentChain: state.currentChain,
            progress: state.progress,
            executionMemories: state.executionMemories,
            taskResults: state.taskResults
        };
    }
}

/**
 * Execute a single task.
 */
async function executeTask(
    taskId: UUID,
    chain: TaskChain,
    executor: DefaultTaskExecutor,
    context: TaskExecutionContext,
    state: TaskChainWorkflowStateType
): Promise<TaskNode> {
    const task = chain.tasks.find(t => t.id === taskId);
    if (!task) {
        throw new Error(`Task not found: ${taskId}`);
    }

    elizaLogger.info(`[TaskChainWorkflow] Executing task: ${task.name}`);

    // Collect inputs from dependencies
    const inputs = collectTaskInputs(task, chain, state.taskResults!);

    try {
        const result = await executor.executeTask(task, inputs, context);
        elizaLogger.success(`[TaskChainWorkflow] Task ${task.name} completed`);
        return result;

    } catch (error: any) {
        elizaLogger.error(`[TaskChainWorkflow] Task ${task.name} failed: ${error.message}`);
        throw error;
    }
}

/**
 * Collect inputs for a task from its dependencies
 */
function collectTaskInputs(task: TaskNode, chain: TaskChain, taskResults: Map<UUID, any>): Record<string, any> {
    const inputs: Record<string, any> = {};
    const completedDependencies: string[] = [];

    for (const depId of task.dependencies) {
        const depTask = chain.tasks.find(t => t.id === depId);

        if (!depTask) {
            continue;
        }

        if (depTask.status === 'completed') {
            completedDependencies.push(depTask.name);
        }
    }

    if (completedDependencies.length > 0) {
        inputs.completed_dependencies = completedDependencies;
    }

    return inputs;
}

/**
 * Create memory for task result
 */
async function createTaskMemory(task: TaskNode, context: TaskExecutionContext): Promise<Memory | null> {
    try {
        const actionName = task.name;
        const isSuccess = task.status === 'completed';
        const resultData = task.result?.data;
        const rawChartPaths = extractChartPathsFromStructuredData(resultData);
        const chartPaths: string[] = await Promise.all(rawChartPaths.map(async (cp) => {
            if (!cp || cp.startsWith('/s3-files/') || cp.startsWith('http')) return cp;
            const storageService = (context.runtime as any).fileStorageService;
            if (!storageService) return cp;
            try {
                const absPath = path.resolve(process.cwd(), cp);
                if (!fs.existsSync(absPath)) return cp;
                const fileContent = fs.readFileSync(absPath);
                const filename = path.basename(cp).replace(/\s+/g, '-').toLowerCase();
                const s3Key = storageService.buildKey({
                    type: 'chart',
                    agentId: context.runtime.agentId,
                    userId: 'system',
                    date: new Date().toISOString().split('T')[0],
                    filename,
                });
                const proxyUrl = await storageService.saveFile({
                    content: fileContent,
                    s3Key,
                    contentType: 'text/html',
                    localCachePath: absPath,
                });
                elizaLogger.info(`[TaskChainWorkflow] Uploaded chart to S3: ${proxyUrl}`);
                return proxyUrl;
            } catch (err) {
                elizaLogger.warn(`[TaskChainWorkflow] Chart S3 upload failed, keeping local path: ${err}`);
                return cp;
            }
        }));
        const primaryChartPath = chartPaths[0];

        const shouldIncludeText = (text: string): boolean => {
            const normalized = text.trim();
            if (!normalized) {
                return false;
            }

            const lower = normalized.toLowerCase();
            if (lower === 'action completed successfully.' || lower === 'action completed successfully') {
                return false;
            }

            if (/^executed\s+\d+\s+actions?/i.test(normalized)) {
                return false;
            }

            return true;
        };

        const toDisplayString = (value: unknown): string => {
            if (value === null || value === undefined) {
                return '';
            }
            if (typeof value === 'string') {
                const trimmed = value.trim();
                return shouldIncludeText(trimmed) ? trimmed : '';
            }
            try {
                const json = JSON.stringify(value, null, 2);
                if (!json) {
                    return '';
                }
                const truncated = json.slice(0, 2000);
                const normalized = truncated.trim();
                if (normalized === '{}' || normalized === '[]') {
                    return '';
                }
                return shouldIncludeText(truncated) ? truncated : '';
            } catch (error) {
                return '';
            }
        };

        const extractTextFromResultEntry = (entry: any): string => {
            if (!entry) {
                return '';
            }

            const candidates = [
                entry.summary,
                entry.notes,
                entry.description,
                entry.text,
                entry.result?.text,
                entry.result?.content?.text,
                entry.result?.message,
                entry.result?.summary
            ];

            for (const candidate of candidates) {
                const text = toDisplayString(candidate);
                if (text) {
                    return text;
                }
            }

            if (entry.result) {
                const serialized = toDisplayString(entry.result);
                if (serialized) {
                    return serialized;
                }
            }

            return toDisplayString(entry);
        };

        const buildSuccessText = (): string => {
            if (!resultData) {
                return `## ✅ ${actionName} Results\n\nAction completed successfully.`;
            }

            const textSections: string[] = [];
            const seenSections = new Set<string>();
            const addSection = (value: unknown) => {
                const text = toDisplayString(value);
                if (!text) {
                    return;
                }
                const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
                if (normalized.length === 0 || seenSections.has(normalized)) {
                    return;
                }
                seenSections.add(normalized);
                textSections.push(text);
            };

            addSection((resultData as any)?.text);
            addSection((resultData as any)?.summary);
            addSection((resultData as any)?.message);
            addSection((resultData as any)?.content?.text);
            addSection((resultData as any)?.output?.text);
            const markdownFlag = (resultData as any)?.markdown;
            if (typeof markdownFlag === 'string') {
                addSection(markdownFlag);
            }

            const rawResults = (resultData as any)?.results;
            if (Array.isArray(rawResults) && rawResults.length > 0) {
                const bullets = rawResults.slice(0, 5).map((entry: any, index: number) => {
                    const text = extractTextFromResultEntry(entry);
                    return text ? `- ${text}` : '';
                }).filter(Boolean);

                if (bullets.length > 0) {
                    addSection(bullets.join('\n'));
                }
            }

            if (textSections.length === 0) {
                const cleaned = cleanTaskResultData(resultData);
                addSection((cleaned as any)?.summary);

                const cleanedResults = (cleaned as any)?.results;
                if (Array.isArray(cleanedResults) && cleanedResults.length > 0) {
                    const bullets = cleanedResults.slice(0, 5).map((entry: any, index: number) => {
                        const label = entry?.action || `Result ${index + 1}`;
                        const text = extractTextFromResultEntry(entry);
                        return text ? `- ${label}: ${text}` : '';
                    }).filter(Boolean);

                    if (bullets.length > 0) {
                        addSection(bullets.join('\n'));
                    }
                } else if (typeof cleaned === 'object') {
                    const serialized = toDisplayString(cleaned);
                    if (serialized) {
                        addSection('```json\n' + serialized + '\n```');
                    }
                }
            }

            if (textSections.length === 0 && typeof resultData === 'string') {
                addSection(resultData);
            }

            if (textSections.length === 0) {
                textSections.push('Action completed successfully.');
            }

            return `## ✅ ${actionName} Results\n\n${textSections.join('\n\n')}`;
        };

        const buildFailureText = (): string => {
            return `## ❌ ${actionName} Failed\n\n${USER_FACING_TASK_FAILURE_MESSAGE}`;
        };

        const rawActionText = isSuccess ? buildSuccessText() : buildFailureText();
        // Show the FULL per-task result in chat — no character cap. Per the
        // user: conciseness is handled at GENERATION time via the action /
        // synthesis prompts (see the "be concise" directives there), not by
        // truncating here into a "full detail in the task panel" digest.
        // Users want complete results (including data tables) visible inline.
        // The full result also remains on metadata (originalResultData /
        // actionData) for the task-panel view.
        const actionText = rawActionText;
        const sanitizedActionData = sanitizeStructuredData((resultData as any)?.actionData);
        const cleanedResultData = cleanTaskResultData(resultData);
        const extractActionDataFromResults = (data: any): Record<string, unknown> | undefined => {
            if (!data?.results || !Array.isArray(data.results)) {
                return undefined;
            }

            const withImages = data.results.find((entry: any) => Array.isArray(entry?.actionData?.images) && entry.actionData.images.length > 0);
            if (withImages?.actionData) {
                return withImages.actionData;
            }

            const firstActionData = data.results.find((entry: any) => entry?.actionData)?.actionData;
            return firstActionData;
        };
        const actionDataForMetadata =
            sanitizedActionData
            ?? (cleanedResultData as any)?.actionData
            ?? extractActionDataFromResults(cleanedResultData);

        const memory: Memory = {
            id: uuidv4() as UUID,
            userId: context.runtime.agentId,
            agentId: context.runtime.agentId,
            roomId: context.originalMessage.roomId,
            createdAt: Date.now(),
            content: {
                text: actionText,
                action: null,
                source: 'task_chain_action',
                ...(actionDataForMetadata ? { actionData: actionDataForMetadata } : {}),
                metadata: {
                    actionName: actionName,
                    isActionResponse: true,
                    // Routing observability: per-task memories are the ONLY response events a
                    // task-chain turn puts on the SSE wire (verified via raw event dump) — SSE
                    // consumers read the turn's classification here, parity with other routes.
                    classification: 'TASK_CHAIN_MESSAGE',
                    taskId: task.id,
                    taskName: task.name,
                    success: isSuccess,
                    ...(isSuccess && resultData ? { originalResultData: resultData } : {}),
                    ...(actionDataForMetadata ? { actionData: actionDataForMetadata } : {}),
                    duplicateOptimization: resultData?.duplicateOptimization === true,
                    duplicatesRemoved: resultData?.duplicatesRemoved,
                    ...(primaryChartPath ? { chartPath: primaryChartPath } : {}),
                    ...(chartPaths.length > 0 ? { chartPaths } : {})
                }
            }
        };

        return memory;

    } catch (error: any) {
        elizaLogger.error(`[TaskChainWorkflow] Failed to create task memory: ${error.message}`);
        return null;
    }
}

/**
 * Calculate estimated time remaining
 */
function calculateEstimatedTime(completed: number, total: number, startTime: number): number {
    if (completed === 0) return 0;

    const elapsed = Date.now() - startTime;
    const avgTimePerTask = elapsed / completed;
    return (total - completed) * avgTimePerTask;
}

/**
 * Supervise chain after level execution and optionally modify remaining tasks
 */
/**
 * Supervise chain after level execution using TaskChainSupervisor module
 */
async function superviseChain(state: TaskChainWorkflowStateType): Promise<Partial<TaskChainWorkflowStateType>> {
    elizaLogger.info("[TaskChainWorkflow] Supervising chain after level execution");

    try {
        // Check for stop request first
        const stopState = checkForStopRequest(state, "Stopped during chain supervision");
        if (stopState) {
            elizaLogger.info("🛑 [TaskChainWorkflow] Stop request received during supervision");
            return stopState;
        }

        // Skip supervisor for favorite task chains – user chose a saved chain as-is
        const messageToCheck = state.message ?? state.originalMessage;
        if (messageToCheck && extractFavoriteTaskChainAttachment(messageToCheck)) {
            elizaLogger.info("[TaskChainWorkflow] Favorite task chain detected; skipping supervisor to preserve chain as-is");
            return { phase: "supervision_skipped" };
        }

        // Check if supervisor is enabled
        const config = state.config || getOrchestratorConfig();
        if (!isSupervisorEnabled(config)) {
            elizaLogger.info("[TaskChainWorkflow] Supervisor disabled, skipping supervision");
            return { phase: "supervision_skipped" };
        }

        // Check if there are any remaining tasks to supervise
        if (!hasMoreLevels(state)) {
            elizaLogger.info("[TaskChainWorkflow] No more levels remaining, skipping supervision");
            return { phase: "supervision_skipped" };
        }

        // Check modification limit to prevent infinite modification loops
        const modificationCount = state.supervisionModificationCount ?? 0;
        const maxModifications = (config as { maxSupervisorModifications?: number }).maxSupervisorModifications ?? 3;
        if (modificationCount >= maxModifications) {
            elizaLogger.info(`[TaskChainWorkflow] Supervision modification limit reached (${modificationCount}/${maxModifications}), skipping further modifications`);
            return { phase: "supervision_complete" };
        }

        // Call supervisor to get LLM decision
        const modifications = await callSupervisor(state);

        if (!modifications) {
            elizaLogger.info("[TaskChainWorkflow] Supervisor returned no modifications");
            return { phase: "supervision_complete" };
        }

        if (!modifications.decision) {
            elizaLogger.info(`[TaskChainWorkflow] Supervisor decision: keep as-is`);
            return { phase: "supervision_complete" };
        }

        // Apply modifications
        elizaLogger.info(`[TaskChainWorkflow] Supervisor decision: modify chain`);

        const result = await applySupervisorMods(
            state.currentChain!,
            modifications,
            state.streamingCallback
        );

        if (!result) {
            elizaLogger.info("[TaskChainWorkflow] No modifications were applied");
            return { phase: "supervision_complete" };
        }

        // Notify frontend so task chain graph updates in real time
        if (state.streamingCallback) {
            const updatedChainData = chainToTaskChainData(result.chain);
            const previousTaskIds = new Set(state.currentChain!.tasks.map(t => t.id));
            const addedTaskIds = result.chain.tasks.filter(t => !previousTaskIds.has(t.id)).map(t => t.id);
            state.streamingCallback({
                id: uuidv4(),
                name: "chain_update",
                status: "completed",
                message: "Task chain was modified by supervisor",
                timestamp: Date.now(),
                data: {
                    type: "chain_update",
                    chainId: result.chain.id,
                    reason: "modification",
                    updatedChain: updatedChainData,
                    timestamp: Date.now(),
                    changedTaskIds: addedTaskIds.length > 0 ? addedTaskIds : undefined,
                    removedTaskId: (modifications.remove_task_ids && modifications.remove_task_ids[0]) ?? undefined,
                    removedTaskName: undefined
                }
            });
            state.streamingCallback({
                id: uuidv4(),
                name: "chain_state",
                status: "completed",
                message: "Chain state updated by supervisor",
                timestamp: Date.now(),
                data: {
                    chainId: result.chain.id,
                    chain: updatedChainData
                }
            });
        }

        // Find next pending level index
        const nextLevelIndex = findNextPendingLevelIndex(result.chain, result.executionLevels, 0);
        elizaLogger.info(`[TaskChainWorkflow] Next pending level index: ${nextLevelIndex}`);

        const newModificationCount = (state.supervisionModificationCount ?? 0) + 1;
        elizaLogger.info(`[TaskChainWorkflow] Supervision modification count: ${newModificationCount}`);

        return {
            currentChain: result.chain,
            executionLevels: result.executionLevels,
            currentLevelIndex: nextLevelIndex,
            supervisionModificationCount: newModificationCount,
            phase: "supervision_complete"
        };

    } catch (error: any) {
        elizaLogger.error(`[TaskChainWorkflow] Supervision failed: ${error.message}`, error);
        elizaLogger.info("[TaskChainWorkflow] Continuing with unmodified chain due to supervision error");
        return { phase: "supervision_failed" };
    }
}

/**
 * Generate task chain snapshot node
 */
async function generateSnapshot(state: TaskChainWorkflowStateType): Promise<Partial<TaskChainWorkflowStateType>> {
    elizaLogger.info("[TaskChainWorkflow] Generating task chain snapshot");

    try {
        if (!state.currentChain) {
            elizaLogger.warn("[TaskChainWorkflow] No current chain available for snapshot generation");
            return { hasError: false };
        }

        // Collect chain outputs
        const chainOutputs = collectChainOutputs(state.currentChain);

        // Generate task chain snapshot directly from workflow state
        const chainSnapshot = generateTaskChainSnapshot({
            chain: state.currentChain,
            executionMemories: state.executionMemories || [],
            chainOutputs,
            taskResults: state.taskResults || new Map(),
            completedTaskIds: state.completedTasks || [],
            failedTaskIds: state.failedTasks || [],
            progress: state.progress,
            executionStatus: state.executionStatus,
            startedAt: state.startTime,
            finishedAt: state.endTime ?? Date.now()
        });

        elizaLogger.info(`[TaskChainWorkflow] Generated snapshot with ${chainSnapshot.taskChainData.tasks.length} tasks`);
        elizaLogger.debug(`[TaskChainWorkflow] Snapshot completion: ${chainSnapshot.completionInfo.completedTasks}/${chainSnapshot.completionInfo.totalTasks} tasks completed`);

        return {
            chainSnapshot,
            hasError: false
        };

    } catch (error: any) {
        elizaLogger.error(`[TaskChainWorkflow] Snapshot generation failed: ${error.message}`);
        // Don't fail the entire workflow for snapshot generation errors
        return {
            hasError: false,
            errorMessage: `Snapshot generation failed: ${error.message}`
        };
    }
}

/**
 * Finalize the workflow execution
 */
async function finalizeExecution(state: TaskChainWorkflowStateType): Promise<Partial<TaskChainWorkflowStateType>> {
    elizaLogger.info("[TaskChainWorkflow] Finalizing execution");

    try {
        const endTime = Date.now();
        const duration = endTime - state.startTime!;
        const wasStopped = state.shouldStop === true;
        const finalPhaseMessage = wasStopped ? "Stopped by user" : "Completed";

        // Update final chain metadata
        const finalChain: TaskChain = {
            ...state.currentChain!,
            metadata: {
                ...state.currentChain!.metadata,
                status: wasStopped ? 'cancelled' : 'completed',
                endTime,
                actualDuration: duration
            }
        };

        // Collect chain outputs
        const chainOutputs = collectChainOutputs(finalChain);

        // Calculate execution stats
        const executionStats = {
            totalDuration: duration,
            tasksExecuted: state.completedTasks!.length,
            tasksFailed: state.failedTasks!.length,
            totalTokens: calculateTotalTokens(finalChain),
            totalCost: 0 // TODO: Calculate cost
        };

        // Update final status
        const finalStatus = {
            ...state.executionStatus!,
            status: wasStopped ? 'cancelled' as const : 'completed' as const,
            currentPhase: finalPhaseMessage,
            progress: {
                ...state.progress!,
                running: [],
                estimatedTimeRemaining: 0
            },
            lastUpdate: endTime
        };

        // Stream completion
        if (state.streamingCallback) {
            if (wasStopped) {
                state.streamingCallback({
                    id: uuidv4(),
                    name: 'task_chain_stopped',
                    status: 'completed',
                    message: `Task chain stopped by user after ${duration}ms`,
                    timestamp: endTime,
                    data: {
                        type: 'workflow_stopped',
                        duration,
                        tasksExecuted: state.completedTasks!.length,
                        tasksFailed: state.failedTasks!.length
                    }
                });
            } else {
                state.streamingCallback({
                    id: uuidv4(),
                    name: 'task_chain_completed',
                    status: 'completed',
                    message: `Task chain completed successfully in ${duration}ms`,
                    timestamp: endTime,
                    data: {
                        type: 'workflow_completed',
                        duration,
                        tasksExecuted: state.completedTasks!.length,
                        tasksFailed: state.failedTasks!.length
                    }
                });
            }
        }

        if (wasStopped) {
            elizaLogger.info(`[TaskChainWorkflow] Workflow stopped by user after ${duration}ms`);
        } else {
            elizaLogger.success(`[TaskChainWorkflow] Workflow completed in ${duration}ms`);
        }

        return {
            currentChain: finalChain,
            chainOutputs,
            executionStats,
            executionStatus: finalStatus,
            endTime,
            phase: wasStopped ? 'stopped' : 'completed',
            isComplete: true,
            currentPhase: finalPhaseMessage,
            shouldStop: wasStopped
        };

    } catch (error: any) {
        elizaLogger.error(`[TaskChainWorkflow] Finalization failed: ${error.message}`);
        return {
            hasError: true,
            errorMessage: `Finalization failed: ${error.message}`,
            phase: 'error',
            currentChain: state.currentChain,
            executionStatus: state.executionStatus ? {
                ...state.executionStatus,
                status: 'failed' as const,
                currentPhase: 'Finalization failed',
                lastUpdate: Date.now()
            } : undefined,
            executionMemories: state.executionMemories,
            chainOutputs: state.chainOutputs,
            endTime: Date.now()
        };
    }
}

/**
 * Collect all outputs from the chain
 */
function collectChainOutputs(chain: TaskChain): Record<string, any> {
    const outputs: Record<string, any> = {};

    for (const task of chain.tasks) {
        if (task.status === 'completed' && task.result?.data) {
            const formatted = formatTaskResultForWorkflow(task);
            outputs[task.name] = {
                ...(formatted.output ?? {}),
                _taskMetadata: {
                    taskId: task.id,
                    taskName: task.name,
                    taskType: task.type,
                    status: task.status,
                    resultMetadata: formatted.metadata,
                    raw: formatted.raw
                }
            };
        }
    }

    return outputs;
}

function formatTaskResultForWorkflow(task: TaskNode) {
    const rawData = task.result?.data;
    const metadata = task.result?.metadata;
    const cleaned = cleanTaskResultData(rawData);

    return {
        taskId: task.id,
        taskName: task.name,
        taskType: task.type,
        status: task.status,
        output: cleaned,
        raw: rawData,
        metadata
    };
}

function sanitizeStructuredData(value: any, seen: WeakSet<object> = new WeakSet()): any {
    if (value === null || value === undefined) {
        return value;
    }

    if (typeof value !== "object") {
        if (typeof value === "function" || typeof value === "symbol") {
            return undefined;
        }
        return value;
    }

    if (seen.has(value as object)) {
        return undefined;
    }
    seen.add(value as object);

    if (Array.isArray(value)) {
        const sanitizedArray = value
            .map(item => sanitizeStructuredData(item, seen))
            .filter(item => item !== undefined);
        return sanitizedArray;
    }

    const sanitized: Record<string, any> = {};

    for (const [key, val] of Object.entries(value)) {
        if (val === undefined || typeof val === "function" || typeof val === "symbol") {
            continue;
        }

        const sanitizedValue = sanitizeStructuredData(val, seen);
        if (sanitizedValue !== undefined) {
            sanitized[key] = sanitizedValue;
        }
    }

    return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function extractChartPathsFromStructuredData(value: any): string[] {
    const results = new Set<string>();
    const seen = new WeakSet<object>();

    const visit = (node: any) => {
        if (!node || typeof node !== "object") {
            return;
        }

        if (seen.has(node as object)) {
            return;
        }

        seen.add(node as object);

        const singlePath = (node as any).chartPath;
        if (typeof singlePath === "string" && singlePath.trim()) {
            results.add(singlePath.trim());
        }

        const multiplePaths = (node as any).chartPaths;
        if (Array.isArray(multiplePaths)) {
            for (const candidate of multiplePaths) {
                if (typeof candidate === "string" && candidate.trim()) {
                    results.add(candidate.trim());
                }
            }
        }

        if (Array.isArray(node)) {
            for (const item of node) {
                visit(item);
            }
        } else {
            for (const child of Object.values(node)) {
                if (child && typeof child === "object") {
                    visit(child);
                }
            }
        }
    };

    visit(value);
    return Array.from(results);
}

function cleanTaskResultData(data: any): any {
    if (data === null || data === undefined) {
        return data;
    }

    if (Array.isArray(data)) {
        return data.map(item => cleanTaskResultData(item));
    }

    if (typeof data !== 'object') {
        return data;
    }

    if (data.results && Array.isArray(data.results)) {
        const simplifiedResults = data.results.map((result: any) => {
            const resultChartPaths = extractChartPathsFromStructuredData(result);
            const resultMetadata = sanitizeStructuredData(result.result?.metadata);
            const resultContentMetadata = sanitizeStructuredData(result.result?.content?.metadata);
            const resultActionData = sanitizeStructuredData(result.result?.actionData);
            const resultAttachments = sanitizeStructuredData(result.result?.attachments);

            return {
                action: result.action,
                success: result.success,
                text: result.result?.text || result.result?.content?.text,
                error: result.error,
                ...(resultChartPaths.length > 0
                    ? {
                        chartPath: resultChartPaths[0],
                        chartPaths: resultChartPaths
                    }
                    : {}),
                ...(resultMetadata ? { metadata: resultMetadata } : {}),
                ...(resultContentMetadata ? { contentMetadata: resultContentMetadata } : {}),
                ...(resultActionData ? { actionData: resultActionData } : {}),
                ...(resultAttachments ? { attachments: resultAttachments } : {})
            };
        });

        const chartPaths = extractChartPathsFromStructuredData(data);
        const metadata = sanitizeStructuredData((data as any).metadata);
        const actionData = sanitizeStructuredData((data as any).actionData);

        return {
            summary: data.summary || `Executed ${data.results.length} actions`,
            actionCount: data.results.length,
            successCount: simplifiedResults.filter(r => r.success).length,
            failureCount: simplifiedResults.filter(r => r.success === false).length,
            duplicateOptimization: data.duplicateOptimization ?? false,
            duplicatesRemoved: data.duplicatesRemoved,
            optimized: data.optimized ?? false,
            text: extractTextFromActionResults(data.results),
            results: simplifiedResults,
            ...(chartPaths.length > 0 ? { chartPath: chartPaths[0], chartPaths } : {}),
            ...(metadata ? { metadata } : {}),
            ...(actionData ? { actionData } : {})
        };
    }

    if (data.text || data.message || data.content?.text) {
        const chartPaths = extractChartPathsFromStructuredData(data);
        return {
            text: data.text || data.message || data.content?.text,
            summary: data.summary,
            markdown: data.markdown,
            duplicateOptimization: data.duplicateOptimization,
            duplicatesRemoved: data.duplicatesRemoved,
            ...(chartPaths.length > 0 ? { chartPath: chartPaths[0], chartPaths } : {}),
            ...(sanitizeStructuredData(data.metadata) ? { metadata: sanitizeStructuredData(data.metadata) } : {}),
            ...(sanitizeStructuredData(data.actionData) ? { actionData: sanitizeStructuredData(data.actionData) } : {})
        };
    }

    const cleaned: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'object') {
            cleaned[key] = cleanTaskResultData(value);
        } else {
            cleaned[key] = value;
        }
    }

    const chartPaths = extractChartPathsFromStructuredData(data);
    if (chartPaths.length > 0) {
        cleaned.chartPath = chartPaths[0];
        cleaned.chartPaths = chartPaths;
    }

    return cleaned;
}

function extractTextFromActionResults(results: any[]): string {
    if (!Array.isArray(results)) {
        return '';
    }

    return results.map((result: any) => {
        if (result.result?.text) {
            return result.result.text;
        }
        if (result.result?.content?.text) {
            return result.result.content.text;
        }
        return result.action || 'Action completed';
    }).join('. ');
}

/**
 * Calculate total tokens used in the chain
 */
function calculateTotalTokens(chain: TaskChain): number {
    let totalTokens = 0;

    for (const task of chain.tasks) {
        if (task.result?.metadata?.tokenUsage) {
            totalTokens += task.result.metadata.tokenUsage.totalTokens || 0;
        }
    }

    return totalTokens;
}

/**
 * Handle workflow errors
 */
async function handleWorkflowError(state: TaskChainWorkflowStateType): Promise<Partial<TaskChainWorkflowStateType>> {
    elizaLogger.error(`[TaskChainWorkflow] Handling workflow error: ${state.errorMessage}`);

    const endTime = Date.now();
    const duration = endTime - state.startTime!;

    // Update chain status to failed
    let finalChain = state.currentChain;
    if (finalChain) {
        finalChain = {
            ...finalChain,
            metadata: {
                ...finalChain.metadata,
                status: 'failed' as const,
                endTime
            }
        };
    }

    // Update execution status
    const errorStatus = {
        ...state.executionStatus!,
        status: 'failed' as const,
        currentPhase: 'Failed',
        lastUpdate: endTime
    };

    // Stream error
    if (state.streamingCallback) {
        state.streamingCallback({
            id: uuidv4(),
            name: 'task_chain_error',
            status: 'completed',
            message: USER_FACING_WORKFLOW_FAILURE_MESSAGE,
            timestamp: endTime,
            data: {
                type: 'workflow_error',
                error: USER_FACING_WORKFLOW_FAILURE_MESSAGE,
                duration,
                phase: state.phase
            }
        });
    }

    return {
        currentChain: finalChain,
        executionStatus: errorStatus,
        endTime,
        phase: 'error',
        isComplete: true
    };
}

/**
 * Create the Task Chain Workflow Graph
 */
export function createTaskChainWorkflow() {
    const workflow = new StateGraph(TaskChainWorkflowState)
        .addNode("initialize", initializeWorkflow)
        .addNode("planChain", planTaskChain)
        .addNode("optimizeChain", optimizeChain)
        .addNode("validateChain", validateChain)
        .addNode("resolveDependencies", resolveDependencies)
        .addNode("executeTaskLevel", executeTaskLevel)
        .addNode("superviseChain", superviseChain)
        .addNode("generateSnapshot", generateSnapshot)
        .addNode("finalizeExecution", finalizeExecution)
        .addNode("handleError", handleWorkflowError)

        // Sequential flow with error handling
        .addEdge("__start__", "initialize")
        .addConditionalEdges("initialize", (state: TaskChainWorkflowStateType) => {
            return state.hasError ? "handleError" : "planChain";
        })
        .addConditionalEdges("planChain", (state: TaskChainWorkflowStateType) => {
            return state.hasError ? "handleError" : "optimizeChain";
        })
        .addConditionalEdges("optimizeChain", (state: TaskChainWorkflowStateType) => {
            return state.hasError ? "handleError" : "validateChain";
        })
        .addConditionalEdges("validateChain", (state: TaskChainWorkflowStateType) => {
            return state.hasError ? "handleError" : "resolveDependencies";
        })
        .addConditionalEdges("resolveDependencies", (state: TaskChainWorkflowStateType) => {
            if (state.hasError) return "handleError";
            return "executeTaskLevel";
        })
        // executeTaskLevel now always goes to superviseChain
        .addEdge("executeTaskLevel", "superviseChain")
        // superviseChain decides next step based on state
        .addConditionalEdges("superviseChain", (state: TaskChainWorkflowStateType) => {
            if (state.hasError) return "handleError";
            if (state.shouldStop) return "generateSnapshot";
            if (hasMoreLevels(state)) return "executeTaskLevel";
            return "generateSnapshot";
        })
        .addConditionalEdges("generateSnapshot", (state: TaskChainWorkflowStateType) => {
            return state.hasError ? "handleError" : "finalizeExecution";
        })
        .addEdge("finalizeExecution", "__end__")
        .addEdge("handleError", "__end__");

    return workflow.compile();
}

/**
 * Task Chain Workflow Service
 */
type TaskChainWorkflowOptions = {
    initialChain?: TaskChain;
    validationResult?: {
        isValid: boolean;
        errors: string[];
        warnings?: string[];
    };
    executionLevels?: UUID[][];
};

export class TaskChainWorkflowService {
    private runtime: IAgentRuntime;
    private workflow: ReturnType<typeof createTaskChainWorkflow>;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
        this.workflow = createTaskChainWorkflow();
    }

    /**
     * Execute task chain using LangGraph workflow
     */
    async executeTaskChain(
        message: Memory,
        state: State,
        availableActions: Action[],
        streamingCallback?: StreamingCallback,
        intermediateResultCallback?: (response: Memory) => void,
        config?: Partial<ChainOrchestratorConfig>,
        options?: TaskChainWorkflowOptions,
        onToken?: (delta: string) => void | Promise<void>,
    ): Promise<ChainExecutionResult> {
        elizaLogger.info("[TaskChainWorkflowService] Starting task chain execution");

        try {
            const initialConfig = getOrchestratorConfig(config);

            const initialState: Partial<TaskChainWorkflowStateType> = {
                message,
                runtime: this.runtime,
                state,
                streamingCallback,
                intermediateResultCallback,
                availableActions,
                config: initialConfig,
                onToken,
            };

            if (options?.initialChain) {
                const seededChain: TaskChain = {
                    ...options.initialChain,
                    tasks: options.initialChain.tasks.map(task => ({
                        ...task,
                        status: task.status ?? 'pending',
                        dependencies: task.dependencies ?? []
                    })),
                    metadata: {
                        ...options.initialChain.metadata,
                        status: options.initialChain.metadata.status ?? 'pending'
                    }
                };

                Object.assign(initialState, {
                    userRequest: seededChain.originalRequest || message.content.text || '',
                    plannedChain: seededChain,
                    optimizedChain: seededChain,
                    currentChain: seededChain
                });
            }

            if (options?.validationResult) {
                initialState.validationResult = {
                    ...options.validationResult,
                    warnings: options.validationResult.warnings ?? []
                };
            }

            if (options?.executionLevels) {
                initialState.executionLevels = options.executionLevels;
            }

            const langSmithMetadataEntries = Object.entries({
                runType: "task_chain",
                agentId: this.runtime.agentId,
                character: this.runtime.character?.name,
                messageId: message.id,
                roomId: message.roomId,
                chainId: options?.initialChain?.id
            }).filter(([, value]) => value !== undefined && value !== null && value !== "");

            const langSmithMetadata = Object.fromEntries(langSmithMetadataEntries) as Record<string, unknown>;

            const langSmithConfig = buildLangSmithRunnableConfig({
                apiKey: this.runtime.getSetting("LANGCHAIN_API_KEY")
                    ?? this.runtime.getSetting("LANGSMITH_API_KEY")
                    ?? undefined,
                endpoint: this.runtime.getSetting("LANGCHAIN_ENDPOINT")
                    ?? this.runtime.getSetting("LANGSMITH_ENDPOINT")
                    ?? undefined,
                projectName: this.runtime.getSetting("LANGSMITH_PROJECT")
                    ?? this.runtime.getSetting("LANGCHAIN_PROJECT")
                    ?? this.runtime.character?.name
                    ?? undefined,
                runName: message.id
                    ? `task-chain:${message.id}`
                    : "task-chain-workflow",
                tags: [
                    "task-chain",
                    this.runtime.character?.name ? `agent:${this.runtime.character.name}` : undefined
                ].filter((tag): tag is string => typeof tag === "string" && tag.length > 0),
                metadata: langSmithMetadata
            });

            const result = langSmithConfig
                ? await this.workflow.invoke(initialState, langSmithConfig)
                : await this.workflow.invoke(initialState);

            const wasStopped = result.shouldStop === true;
            const fallbackChain = options?.initialChain;
            const resolvedChain = result.currentChain ?? fallbackChain;
            const finalChain: TaskChain = resolvedChain
                ? {
                    ...resolvedChain,
                    metadata: {
                        ...resolvedChain.metadata,
                        status: wasStopped
                            ? 'cancelled'
                            : (resolvedChain.metadata?.status ?? 'completed')
                    }
                }
                : {
                    id: uuidv4() as UUID,
                    name: 'Task Chain',
                    description: 'Chain generated by workflow execution',
                    tasks: [],
                    originalRequest: message.content.text || '',
                    metadata: {
                        createdAt: Date.now(),
                        status: wasStopped ? 'cancelled' : 'completed',
                        estimatedDuration: 0
                    },
                    config: {
                        maxParallel: 1,
                        timeout: 30000,
                        continueOnFailure: false
                    }
                };

            // Convert to ChainExecutionResult
            const success = result.isComplete && !result.hasError && !wasStopped;
            const executionResult: ChainExecutionResult = {
                success,
                chain: finalChain,
                outputs: result.chainOutputs || {},
                memories: result.executionMemories || [],
                stats: result.executionStats || {
                    totalDuration: 0,
                    tasksExecuted: 0,
                    tasksFailed: 0,
                    totalTokens: 0
                },
                snapshot: result.chainSnapshot
            };

            if (wasStopped) {
                executionResult.error = {
                    type: 'WorkflowStopped',
                    message: result.errorMessage || 'Processing stopped by user request'
                };
            } else if (result.hasError) {
                executionResult.error = {
                    type: 'WorkflowExecutionError',
                    message: USER_FACING_WORKFLOW_FAILURE_MESSAGE,
                    stack: undefined
                };
            }

            const messageMetadata = (message.content?.metadata && typeof message.content.metadata === 'object')
                ? message.content.metadata as Record<string, unknown>
                : {};

            logTaskChainOutcome({
                agentId: this.runtime.agentId,
                roomId: message.roomId,
                messageId: message.id,
                userQuestion: message.content?.text ?? '',
                chain: finalChain,
                success,
                stats: executionResult.stats,
                taskResults: result.taskResults,
                classification: {
                    type: messageMetadata.classification as string | undefined,
                    confidence: typeof messageMetadata.classificationConfidence === 'number'
                        ? messageMetadata.classificationConfidence as number
                        : undefined,
                    reasoning: typeof messageMetadata.classificationReasoning === 'string'
                        ? messageMetadata.classificationReasoning as string
                        : undefined,
                    isCryptoRelated: typeof messageMetadata.isCryptoRelated === 'boolean'
                        ? messageMetadata.isCryptoRelated as boolean
                        : undefined
                }
            });

            return executionResult;

        } catch (error: any) {
            elizaLogger.error(`[TaskChainWorkflowService] Workflow execution failed: ${error.message}`, error);

            return {
                success: false,
                chain: {
                    id: uuidv4() as UUID,
                    name: 'Failed Task Chain',
                    description: 'Task chain that failed during execution',
                    tasks: [],
                    originalRequest: message.content.text || '',
                    metadata: {
                        createdAt: Date.now(),
                        status: 'failed',
                        estimatedDuration: 0
                    },
                    config: {
                        maxParallel: 1,
                        timeout: 30000,
                        continueOnFailure: false
                    }
                },
                outputs: {},
                memories: [],
                stats: {
                    totalDuration: 0,
                    tasksExecuted: 0,
                    tasksFailed: 1,
                    totalTokens: 0
                },
                error: {
                    type: error.name || 'TaskChainWorkflowError',
                    message: error.message,
                    stack: error.stack
                }
            };
        }
    }
}

export async function handleMessageWithTaskChain(
    this: IAgentRuntime,
    message: Memory,
    callback?: HandlerCallback,
    streamingCallback?: StreamingCallback,
    intermediateResponseCallback?: (response: Memory) => void,
    preApprovedChain?: TaskChain,
    connectionId?: string,
    onToken?: (delta: string) => void | Promise<void>,
): Promise<Memory[]> {
    const steps: ProcessingStep[] = [];

    const addStep = (
        name: string,
        status: ProcessingStep["status"],
        stepMessage: string,
        data?: Record<string, unknown>,
        error?: string
    ) => {
        const sanitizedError = error ? USER_FACING_GENERIC_ERROR_LABEL : undefined;
        const step: ProcessingStep = {
            id: uuidv4(),
            name,
            status,
            message: stepMessage,
            timestamp: Date.now(),
            data,
            error: sanitizedError
        };
        steps.push(step);
        streamingCallback?.(step);
        return step;
    };

    try {
        // Reset stop flag at the start of new message processing
        this.resetStopFlag?.();
        elizaLogger.info("🔄 Starting task chain processing - system ready");

        // Check early stop request
        if (this.shouldStop?.()) {
            elizaLogger.info("🛑 Task chain processing stopped by user request");
            addStep("processing", "error", "🛑 Processing stopped by user");
            return [];
        }

        addStep("Initialization", "in_progress", "🚀 Initializing task chain workflow...");
        const planner = ensureTaskChainPlanner(this);
        const workflowService = new TaskChainWorkflowService(this);
        addStep("Initialization", "completed", "✅ Workflow ready");

        addStep("Context Analysis", "in_progress", "📚 Analyzing conversation context...");

        const derivedUserRequest = deriveUserRequestFromMessage(message);
        const contentRecord = (message.content ?? {}) as Record<string, any>;
        const originalUserText = typeof contentRecord.text === "string" ? contentRecord.text : "";
        const metadataRecord: Record<string, unknown> = contentRecord.metadata && typeof contentRecord.metadata === "object"
            ? { ...(contentRecord.metadata as Record<string, unknown>) }
            : {};

        if (!originalUserText || originalUserText.trim().length === 0) {
            if (!Object.prototype.hasOwnProperty.call(metadataRecord, "originalUserText")) {
                metadataRecord["originalUserText"] = originalUserText ?? "";
            }
            contentRecord.text = derivedUserRequest;
        }

        metadataRecord["derivedUserRequest"] = derivedUserRequest;
        contentRecord.metadata = metadataRecord;
        message.content = contentRecord as Memory["content"];

        const state = await this.composeState(message);

        // Inject the universal language instruction so the planner mirrors
        // the user's input language in chain names / descriptions.
        (state as Record<string, unknown>).languageInstruction = getLanguageInstruction();

        addStep(
            "Context Analysis",
            "completed",
            `✅ Context analyzed (${state.recentMessagesData.length} recent messages)`
        );

        if (this.shouldStop?.()) {
            elizaLogger.info("🛑 Processing stopped after context analysis");
            addStep("processing", "error", "🛑 Processing stopped by user");
            return [];
        }

        const userRequest = derivedUserRequest;

        let plannedChain: TaskChain | undefined;

        // If we have a pre-approved chain, use it directly
        if (preApprovedChain) {
            elizaLogger.info(`[handleMessageWithTaskChain] Using pre-approved chain: ${preApprovedChain.name}`);
            addStep(
                "Task Planning",
                "completed",
                `✅ Using approved chain "${preApprovedChain.name}" with ${preApprovedChain.tasks.length} tasks`
            );
            plannedChain = preApprovedChain;
        } else {
            addStep("Task Planning", "in_progress", "🧠 Planning optimal task chain for your request...");

            let approvalPayload: PendingApprovalDecision | undefined;
            let threadId: string | undefined;
            let isResuming = false;

            while (!plannedChain) {
                try {
                    const nextChain = isResuming && threadId
                        ? await planner.resumeWithApproval(
                            threadId,
                            {
                                decision: approvalPayload!.decision,
                                feedback: approvalPayload?.feedback ?? ""
                            },
                            approvalPayload?.taskChain
                        )
                        : await planner.planChain(
                            userRequest,
                            state,
                            getNonCEXActions(this),
                            streamingCallback
                        );

                    plannedChain = nextChain;

                    if (approvalPayload) {
                        const completionMessage = approvalPayload.decision === "approved"
                            ? "✅ Human approval received. Continuing workflow."
                            : "✅ New task chain generated after feedback.";
                        addStep("Human Approval", "completed", completionMessage, {
                            decision: approvalPayload.decision,
                            feedback: approvalPayload.feedback ?? ""
                        });
                    }

                    addStep(
                        "Task Planning",
                        "completed",
                        `✅ Planned chain "${plannedChain.name}" with ${plannedChain.tasks.length} tasks`
                    );
                } catch (error: any) {
                    if (error.message === "WORKFLOW_INTERRUPTED_FOR_APPROVAL") {
                        threadId = (error as any).threadId || threadId || (state as any).roomId;

                        elizaLogger.info("[handleMessageWithTaskChain] Planning interrupted for human approval");
                        addStep(
                            "Human Approval",
                            "pending",
                            "⏸️ Please review and approve the proposed task chain..."
                        );

                        try {
                            approvalPayload = await waitForTaskChainApproval(this, threadId, {
                                message,
                                state,
                                agentId: this.agentId,
                                connectionId,
                                fullTaskChain: (error as any).fullTaskChain,
                                streamingCallback,
                                intermediateResponseCallback
                            });
                        } catch (approvalError) {
                            // SSE disconnect: client closed the stream before
                            // approving/rejecting the proposed chain. Not an
                            // error — the user simply walked away. The pending
                            // approval entry is already deleted by the SSE
                            // close handler in client-direct, the LangGraph
                            // thread is left interrupted (LangGraph cleans up
                            // its own checkpoint state on TTL), and there's no
                            // active connection to send a reply to. Bail out
                            // cleanly without persisting a misleading error
                            // memory.
                            if (
                                approvalError instanceof Error &&
                                approvalError.message ===
                                    TASK_CHAIN_APPROVAL_CANCELLED_BY_DISCONNECT
                            ) {
                                elizaLogger.info(
                                    `[handleMessageWithTaskChain] Approval cancelled: client disconnected before approval decision (thread=${threadId})`
                                );
                                addStep(
                                    "Human Approval",
                                    "completed",
                                    "🚪 Approval cancelled — client disconnected before deciding."
                                );
                                return [];
                            }
                            addStep("Human Approval", "error", "❌ Approval flow was interrupted unexpectedly.");
                            throw approvalError;
                        }

                        const resumeMessage = approvalPayload.decision === "approved"
                            ? "✅ Approval received. Resuming execution..."
                            : "♻️ Feedback received. Regenerating task chain...";
                        addStep("Human Approval", "in_progress", resumeMessage, {
                            decision: approvalPayload.decision,
                            feedback: approvalPayload.feedback ?? ""
                        });

                        isResuming = true;
                        continue;
                    }

                    addStep("Task Planning", "error", "❌ Planning failed due to an internal error.");
                    throw error;
                }
            }
        }

        if (!plannedChain) {
            throw new Error("Task chain planning failed without producing a chain");
        }

        if (this.shouldStop?.()) {
            elizaLogger.info("🛑 Processing stopped after task planning");
            addStep("processing", "error", "🛑 Processing stopped by user");
            return [];
        }

        addStep("Workflow Execution", "in_progress", "⚡ Running task chain workflow...");
        const chainResult = await workflowService.executeTaskChain(
            message,
            state,
            getNonCEXActions(this),
            streamingCallback,
            intermediateResponseCallback,
            undefined,
            {
                initialChain: plannedChain
            },
            onToken,
        );

        const finalChain = chainResult.chain;

        if (chainResult.success) {
            addStep(
                "Workflow Execution",
                "completed",
                `🎉 Workflow completed successfully! (${chainResult.stats.tasksExecuted}/${chainResult.stats.tasksExecuted + chainResult.stats.tasksFailed} tasks)`
            );
        } else {
            addStep(
                "Workflow Execution",
                "error",
                "❌ Workflow execution failed due to an internal error.",
                undefined,
                USER_FACING_GENERIC_ERROR_LABEL
            );
        }

        if (this.shouldStop?.()) {
            elizaLogger.info("🛑 Processing stopped after workflow execution");
            addStep("processing", "error", "🛑 Processing stopped by user");
            return chainResult.memories;
        }

        addStep("Response Generation", "in_progress", "📝 Generating final response...");

        const responseMemories: Memory[] = [...chainResult.memories];
        const summaryMemory = await createWorkflowSummaryMemory(
            this,
            message,
            finalChain,
            chainResult,
            steps,
            null,
            message.content?.language
        );
        responseMemories.push(summaryMemory);

        addStep("Response Generation", "completed", "✅ Response ready!");

        addStep("Quality Check", "in_progress", "🎯 Running quality checks...");
        try {
            await this.evaluate(message, state, true, callback);
            addStep("Quality Check", "completed", "✅ Quality check passed!");
        } catch (error) {
            const err = error instanceof Error ? error : new Error("Unknown quality check error");
            elizaLogger.error(`Quality check failed: ${err.message}`, err);
            addStep("Quality Check", "error", "⚠️ Quality check had issues, but continuing...", undefined, err.message);
        }

        addStep("Finalization", "completed", "🎉 Task chain processing complete!");

        elizaLogger.success(
            `[TaskChainHandler] Completed processing with ${responseMemories.length} response memories`
        );
        elizaLogger.info(
            `[TaskChainHandler] Chain stats: ${chainResult.stats.tasksExecuted} executed, ${chainResult.stats.tasksFailed} failed, ${chainResult.stats.totalDuration}ms`
        );

        return responseMemories;

    } catch (error) {
        const err = error instanceof Error ? error : new Error("Unknown task chain error");
        const errorMsg = `Task chain processing failed: ${err.message}`;
        elizaLogger.error(errorMsg, err);
        addStep("error", "error", "💥 Task chain processing encountered an error", undefined, err.message);

        const errorMemory: Memory = {
            id: uuidv4() as UUID,
            userId: this.agentId,
            agentId: this.agentId,
            roomId: message.roomId,
            createdAt: Date.now(),
            content: {
                text: `💥 Task Chain Error\n\n${USER_FACING_WORKFLOW_FAILURE_MESSAGE} If the problem persists, please try again or rephrase your request.`,
                action: null,
                error: {
                    type: "TASK_CHAIN_ERROR",
                    message: USER_FACING_WORKFLOW_FAILURE_MESSAGE
                },
                processingSteps: steps
            }
        };

        try {
            await this.messageManager.createMemory(errorMemory);
            intermediateResponseCallback?.(errorMemory);
        } catch (memoryError) {
            const storageErr = memoryError instanceof Error ? memoryError : new Error("Unknown memory error");
            elizaLogger.error(`Failed to save error memory: ${storageErr.message}`, storageErr);
        }

        return [errorMemory];
    }
}

async function createWorkflowSummaryMemory(
    runtime: IAgentRuntime,
    originalMessage: Memory,
    chain: TaskChain,
    result: ChainExecutionResult,
    steps: ProcessingStep[],
    existingPlanningMemory?: Memory | null,
    language?: string
): Promise<Memory> {
    const tasks = chain.tasks ?? [];
    const completed = tasks.filter(task => task.status === 'completed');
    const failed = tasks.filter(task => task.status === 'failed');
    const remaining = tasks.filter(task => task.status !== 'completed' && task.status !== 'failed');
    const running = tasks.filter(task => task.status === 'running');
    const snapshot = result.snapshot ?? generateTaskChainSnapshot({
        chain,
        executionMemories: result.memories || [],
        chainOutputs: result.outputs || {},
        completedTaskIds: completed.map(task => task.id),
        failedTaskIds: failed.map(task => task.id),
        progress: {
            completed: completed.length,
            total: tasks.length,
            running: running.map(task => task.id)
        },
        finishedAt: chain.metadata?.endTime ?? Date.now()
    });

    const statusLine = language === "zh-CN"
        ? `🎯 **任务链已完成** — ${chain.name ?? "任务链"} (${completed.length}/${tasks.length} 个任务完成)`
        : `🎯 **Taskchain accomplished** — ${chain.name ?? "Task Chain"} (${completed.length}/${tasks.length} tasks completed)`;

    // ANSWER-FIRST: the user's persisted answer must BE the chain's synthesis, not a status
    // one-liner (the per-step eval caught step1 answering "is now a good time?" with only
    // "Taskchain accomplished (5/5)" — the synthesis was buried in the task panels). Lead with the
    // LAST completed task's textual output (the synthesis task in a dependency-ordered chain),
    // trimmed to keep the response concise; the status line follows.
    const extractTaskText = (data: unknown): string => {
        if (typeof data === "string") return data;
        if (data && typeof data === "object") {
            const d = data as Record<string, unknown>;
            for (const k of ["text", "response", "summary", "analysis", "result"]) {
                if (typeof d[k] === "string" && (d[k] as string).trim().length > 0) return d[k] as string;
            }
        }
        return "";
    };
    let synthesisText = "";
    for (let i = tasks.length - 1; i >= 0; i -= 1) {
        const t = tasks[i];
        if (t.status === "completed") {
            synthesisText = extractTaskText(t.result?.data).trim();
            if (synthesisText) break;
        }
    }
    synthesisText = clampToSentenceBoundary(
        synthesisText,
        3800,
        "_(trimmed — ask for any section in detail)_",
    );
    const summaryText = synthesisText ? `${synthesisText}\n\n${statusLine}` : statusLine;

    // One-line status stays the canonical Key Findings for context-replay purposes.
    const summaryOverride = `- ${statusLine.replace(/\*\*/g, "").trim()}`;

    let summaryMemoryId = existingPlanningMemory?.id ?? (uuidv4() as UUID);
    const summaryCreatedAt = existingPlanningMemory?.createdAt ?? Date.now();
    const summaryMemory: Memory = {
        id: summaryMemoryId,
        userId: existingPlanningMemory?.userId ?? runtime.agentId,
        agentId: existingPlanningMemory?.agentId ?? runtime.agentId,
        roomId: existingPlanningMemory?.roomId ?? originalMessage.roomId,
        createdAt: summaryCreatedAt,
        content: {
            text: summaryText,
            action: null,
            source: "task_chain_summary",
            metadata: {
                actionName: 'Task Chain Summary',
                isActionResponse: true,
                // Routing observability: SSE consumers (eval harness, dashboards) read the turn's
                // classification off response metadata — parity with the regular/CEX paths.
                classification: 'TASK_CHAIN_MESSAGE',
                chainId: chain.id,
                chainName: chain.name,
                stats: result.stats,
                success: result.success,
                outputs: result.outputs,
                taskChainSnapshot: snapshot,
                taskChain: snapshot.taskChainData
            },
            processingSteps: steps
        }
    };

    // Attach `metadata.summary` so follow-up turns can use the short Key
    // Findings string in `recentMessages` substitution. The task-chain
    // summary memory text is already a one-line status; using the override
    // path here keeps the regex extractor from doing pointless work and
    // guarantees a non-empty summary even when no `## Key Findings` heading
    // is present.
    const summaryMemoryWithSummary = attachResponseSummary(summaryMemory, {
        route: "task_chain",
        summaryOverride,
    });

    try {
        if (existingPlanningMemory) {
            try {
                await runtime.messageManager.removeMemory(summaryMemoryId);
            } catch (removeError) {
                const removalErr = removeError instanceof Error ? removeError : new Error("Unknown memory removal error");
                elizaLogger.warn(`Failed to remove planning memory ${summaryMemoryId} before summary rewrite: ${removalErr.message}`);
                summaryMemoryId = uuidv4() as UUID;
                summaryMemoryWithSummary.id = summaryMemoryId;
            }
        }
        await runtime.messageManager.createMemory(summaryMemoryWithSummary);
    } catch (error) {
        const err = error instanceof Error ? error : new Error("Unknown summary memory error");
        elizaLogger.error(`Failed to persist task chain summary memory: ${err.message}`);
    }

    return summaryMemoryWithSummary;
}
