import { elizaLogger } from "../utils/logger.ts";
import type {
    ChainExecutionResult,
    ChainExecutionStatus,
    ChainOrchestrator,
    ChainOrchestratorConfig,
    TaskChain,
    TaskExecutionContext,
    UUID
} from "../core/types.ts";
import { DefaultDependencyResolver } from "./dependencyResolver.ts";
import {
    createTaskChainWorkflow,
    type TaskChainWorkflowStateType
} from "../handlers/taskChainHandler.ts";
import { buildLangSmithRunnableConfig } from "../utils/langsmith.ts";
import { getOrchestratorConfig } from "../config/taskChainConfig.ts";
import { getNonCEXActions } from "../utils/pluginFilter.ts";

/**
 * Default ChainOrchestrator rebuilt on top of the LangGraph workflow.
 * Delegates orchestration to the TaskChainWorkflow graph while exposing
 * the legacy ChainOrchestrator interface.
 */
export class DefaultChainOrchestrator implements ChainOrchestrator {
    private readonly workflow = createTaskChainWorkflow();
    private readonly resolver = new DefaultDependencyResolver();
    private readonly runningChains = new Map<UUID, ChainExecutionStatus>();
    private readonly config: ChainOrchestratorConfig;

    constructor(private readonly runtime: any, config?: Partial<ChainOrchestratorConfig>) {
        this.config = getOrchestratorConfig(config);
    }

    /**
     * Execute the supplied task chain through the LangGraph workflow.
     */
    async executeChain(chain: TaskChain, context: TaskExecutionContext): Promise<ChainExecutionResult> {
        const startTime = Date.now();
        elizaLogger.info(`[ChainOrchestrator] Starting workflow execution for chain: ${chain.name}`);

        try {
            const workingChain: TaskChain = {
                ...chain,
                tasks: chain.tasks.map(task => ({
                    ...task,
                    status: task.status ?? "pending",
                    dependencies: task.dependencies ?? []
                })),
                metadata: {
                    ...chain.metadata,
                    status: "running",
                    startTime: chain.metadata.startTime ?? startTime
                }
            };

            const validation = this.resolver.validateDependencies(workingChain) as {
                isValid: boolean;
                errors: string[];
                warnings?: string[];
            };
            const normalizedValidation = {
                ...validation,
                warnings: validation.warnings ?? []
            };

            if (!normalizedValidation.isValid) {
                throw new Error(`Chain validation failed: ${normalizedValidation.errors.join(", ")}`);
            }

            const executionLevels = this.resolver.getOptimalExecutionOrder(workingChain);

            const initialStatus: ChainExecutionStatus = {
                chainId: workingChain.id,
                status: "pending",
                progress: {
                    completed: workingChain.tasks.filter(task => task.status === "completed").length,
                    total: workingChain.tasks.length,
                    running: [],
                    estimatedTimeRemaining: workingChain.metadata.estimatedDuration
                },
                currentPhase: "Initializing workflow",
                lastUpdate: startTime
            };

            this.runningChains.set(workingChain.id, { ...initialStatus });

            const initialState: Partial<TaskChainWorkflowStateType> = {
                message: context.originalMessage,
                originalMessage: context.originalMessage,
                runtime: context.runtime ?? this.runtime,
                state: context.state,
                streamingCallback: context.streamingCallback,
                intermediateResultCallback: context.intermediateResultCallback,
                availableActions: getNonCEXActions(context.runtime ?? this.runtime),
                userRequest: workingChain.originalRequest || context.originalMessage?.content?.text || "",
                plannedChain: workingChain,
                optimizedChain: workingChain,
                currentChain: workingChain,
                validationResult: normalizedValidation,
                executionLevels,
                executionStatus: initialStatus,
                progress: initialStatus.progress,
                currentLevelIndex: 0,
                currentTaskIndex: 0,
                completedTasks: workingChain.tasks
                    .filter(task => task.status === "completed")
                    .map(task => task.id),
                failedTasks: workingChain.tasks
                    .filter(task => task.status === "failed")
                    .map(task => task.id),
                executingTasks: [],
                executionMemories: [],
                taskResults: new Map(
                    workingChain.tasks
                        .filter(task => task.result)
                        .map(task => [task.id, task.result])
                ),
                taskInputs: new Map(),
                shouldStop: false,
                hasError: false,
                isComplete: false,
                startTime,
                config: this.config,
                phase: "dependency_resolution",
                currentPhase: "Validating provided chain"
            };

            const langSmithMetadataEntries = Object.entries({
                runType: "task_chain_orchestrator",
                agentId: this.runtime?.agentId,
                character: this.runtime?.character?.name,
                chainId: workingChain.id,
                messageId: context?.originalMessage?.id,
                roomId: context?.originalMessage?.roomId
            }).filter(([, value]) => value !== undefined && value !== null && value !== "");

            const langSmithMetadata = Object.fromEntries(langSmithMetadataEntries) as Record<string, unknown>;

            const langSmithConfig = buildLangSmithRunnableConfig({
                apiKey: this.runtime?.getSetting?.("LANGCHAIN_API_KEY")
                    ?? this.runtime?.getSetting?.("LANGSMITH_API_KEY")
                    ?? undefined,
                endpoint: this.runtime?.getSetting?.("LANGCHAIN_ENDPOINT")
                    ?? this.runtime?.getSetting?.("LANGSMITH_ENDPOINT")
                    ?? undefined,
                projectName: this.runtime?.getSetting?.("LANGSMITH_PROJECT")
                    ?? this.runtime?.getSetting?.("LANGCHAIN_PROJECT")
                    ?? this.runtime?.character?.name
                    ?? undefined,
                runName: `task-chain-orchestrator:${workingChain.id}`,
                tags: [
                    "task-chain",
                    "chain-orchestrator",
                    this.runtime?.character?.name ? `agent:${this.runtime.character.name}` : undefined
                ].filter((tag): tag is string => typeof tag === "string" && tag.length > 0),
                metadata: langSmithMetadata
            });

            const workflowResult = langSmithConfig
                ? await this.workflow.invoke(initialState, langSmithConfig)
                : await this.workflow.invoke(initialState);

            const wasStopped = workflowResult.shouldStop === true;
            const finalChain = (workflowResult.currentChain ?? workingChain);
            const normalizedChain = finalChain ? {
                ...finalChain,
                metadata: {
                    ...finalChain.metadata,
                    status: wasStopped ? "cancelled" : finalChain.metadata.status
                }
            } : workingChain;

            const success = workflowResult.isComplete && !workflowResult.hasError && !wasStopped;
            const memories = workflowResult.executionMemories ?? [];
            const outputs = workflowResult.chainOutputs ?? {};
            const stats = workflowResult.executionStats ?? {
                totalDuration: (workflowResult.endTime ?? Date.now()) - (workflowResult.startTime ?? startTime),
                tasksExecuted: normalizedChain.tasks.filter(task => task.status === "completed").length,
                tasksFailed: normalizedChain.tasks.filter(task => task.status === "failed").length,
                totalTokens: 0
            };

            const finalStatus = (workflowResult.executionStatus ?? {
                ...initialStatus,
                chainId: normalizedChain.id,
                status: success ? "completed" : (wasStopped ? "cancelled" : "failed"),
                progress: {
                    ...initialStatus.progress,
                    completed: normalizedChain.tasks.filter(task => task.status === "completed").length
                },
                currentPhase: success ? "Task chain completed" : (wasStopped ? "Task chain stopped" : "Task chain failed"),
                lastUpdate: Date.now()
            });

            if (wasStopped && finalStatus.status !== "cancelled") {
                finalStatus.status = "cancelled";
                finalStatus.currentPhase = finalStatus.currentPhase ?? "Task chain stopped";
            }

            this.runningChains.set(normalizedChain.id, finalStatus);
            this.runningChains.delete(normalizedChain.id);

            const result: ChainExecutionResult = {
                success,
                chain: normalizedChain,
                outputs,
                memories,
                stats
            };

            if (wasStopped) {
                result.error = {
                    type: "WorkflowStopped",
                    message: workflowResult.errorMessage || "Processing stopped by user request"
                };
            } else if (!success) {
                result.error = {
                    type: "TaskChainWorkflowError",
                    message: workflowResult.errorMessage || "Task chain execution failed",
                    stack: undefined
                };
            }

            return result;

        } catch (error: any) {
            elizaLogger.error(`[ChainOrchestrator] Workflow execution failed: ${error.message}`, error);

            const failureStatus = this.runningChains.get(chain.id);
            if (failureStatus) {
                failureStatus.status = "failed";
                failureStatus.currentPhase = "Failed";
                failureStatus.lastUpdate = Date.now();
                this.runningChains.set(chain.id, failureStatus);
                this.runningChains.delete(chain.id);
            }

            return {
                success: false,
                chain,
                outputs: {},
                memories: [],
                stats: {
                    totalDuration: Date.now() - startTime,
                    tasksExecuted: chain.tasks.filter(task => task.status === "completed").length,
                    tasksFailed: chain.tasks.filter(task => task.status === "failed").length,
                    totalTokens: 0
                },
                error: {
                    type: error.name || "ChainExecutionError",
                    message: error.message,
                    stack: error.stack
                }
            };
        }
    }

    async pauseChain(chainId: UUID): Promise<void> {
        const status = this.runningChains.get(chainId);
        if (!status) {
            throw new Error(`Chain not found or not running: ${chainId}`);
        }

        status.status = "paused";
        status.lastUpdate = Date.now();
        this.runningChains.set(chainId, status);
        elizaLogger.info(`[ChainOrchestrator] Marked chain as paused: ${chainId}`);
    }

    async resumeChain(chainId: UUID): Promise<void> {
        const status = this.runningChains.get(chainId);
        if (!status || status.status !== "paused") {
            throw new Error(`Chain not found or not paused: ${chainId}`);
        }

        status.status = "running";
        status.lastUpdate = Date.now();
        this.runningChains.set(chainId, status);
        elizaLogger.info(`[ChainOrchestrator] Marked chain as resumed: ${chainId}`);
    }

    async cancelChain(chainId: UUID): Promise<void> {
        const status = this.runningChains.get(chainId);
        if (!status) {
            throw new Error(`Chain not found: ${chainId}`);
        }

        status.status = "cancelled";
        status.lastUpdate = Date.now();
        this.runningChains.delete(chainId);
        elizaLogger.info(`[ChainOrchestrator] Marked chain as cancelled: ${chainId}`);
    }

    getChainStatus(chainId: UUID): ChainExecutionStatus {
        const status = this.runningChains.get(chainId);
        if (!status) {
            throw new Error(`Chain not found: ${chainId}`);
        }
        return { ...status, progress: { ...status.progress } };
    }
}
