/**
 * Task Chain Planner using LangGraph workflow architecture
 * Rebuilds the task chain planning system with workflow-based approach
 */

import { v4 as uuidv4 } from 'uuid';
import { elizaLogger } from "../utils/logger.ts";
import { generateText } from "../ai/generation.ts";
import { composeContextSplit } from "../core/context.ts";
import {
    getTaskChainPlanningTemplate,
    getFavoriteChainUpdateTemplate
} from "../templates/taskChainPlanningTemplates.ts";
import { StateGraph, Annotation, interrupt, Command } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph";
import {
    type TaskChainPlanner,
    type TaskChain,
    type TaskNode,
    type TaskType,
    type TaskStatus,
    type State,
    type Action,
    type UUID,
    type IAgentRuntime,
    ModelClass,
    type StreamingCallback,
    type Memory
} from "../core/types.ts";
import { formatLearnedRulesForPlanning } from "../templates/ruleLearningTemplate.ts";

type ThreadResources = {
    runtime: IAgentRuntime;
    streamingCallback?: StreamingCallback;
};

const threadResources = new Map<string, ThreadResources>();

function registerThreadResources(
    threadId: string,
    runtime: IAgentRuntime,
    streamingCallback?: StreamingCallback
) {
    const existing = threadResources.get(threadId);
    threadResources.set(threadId, {
        runtime,
        streamingCallback: streamingCallback ?? existing?.streamingCallback
    });
}

function getThreadRuntime(threadId?: string): IAgentRuntime {
    if (!threadId) {
        throw new Error("Thread ID is required to resolve runtime");
    }

    const resources = threadResources.get(threadId);
    if (!resources) {
        throw new Error(`Runtime not registered for thread ${threadId}`);
    }

    return resources.runtime;
}

function getThreadStreamingCallback(threadId?: string): StreamingCallback | undefined {
    if (!threadId) {
        return undefined;
    }

    return threadResources.get(threadId)?.streamingCallback;
}

function clearThreadResources(threadId: string) {
    threadResources.delete(threadId);
}

interface NormalizedFavoriteChainTask {
    id: string;
    name: string;
    description: string;
    dependencies: string[];
}

interface NormalizedFavoriteChain {
    id: string;
    name: string;
    description: string;
    originalRequest?: string;
    tasks: NormalizedFavoriteChainTask[];
    source?: string;
}

type PlannerChainData = {
    chain_name: string;
    chain_description: string;
    tasks: {
        id: string;
        name: string;
        description: string;
        dependencies: string[];
    }[];
};

// LangGraph State Definition for Task Chain Planning
export const TaskChainPlanningState = Annotation.Root({
    // Input parameters
    threadId: Annotation<string>(),
    userRequest: Annotation<string>(),
    context: Annotation<State>(),
    availableActions: Annotation<Action[]>(),
    languageInstruction: Annotation<string>(),

    // Context extraction
    currentDate: Annotation<string>(),
    lastFiveQueries: Annotation<string>(),

    // Planning phase
    planningContext: Annotation<string>(),
    llmResponse: Annotation<string>(),
    parsedChainData: Annotation<any>(),

    // Favorite chain handling
    favoriteTaskChain: Annotation<NormalizedFavoriteChain>(),
    favoriteChainUsed: Annotation<boolean>(),

    // Chain construction
    taskNodes: Annotation<TaskNode[]>(),
    chainMetadata: Annotation<any>(),
    chainConfig: Annotation<any>(),

    // Validation
    validationResult: Annotation<{
        isValid: boolean;
        errors: string[];
        warnings: string[];
    }>(),

    // Final result
    taskChain: Annotation<TaskChain>(),

    // Control flow
    phase: Annotation<string>(),
    isComplete: Annotation<boolean>(),
    hasError: Annotation<boolean>(),
    errorMessage: Annotation<string>(),


    // Human approval (for human-in-the-loop workflow)
    awaitingApproval: Annotation<boolean>(),
    approvalDecision: Annotation<'approved' | 'rejected' | 'pending'>(),
    userFeedback: Annotation<string>(),
    approvalRequestSent: Annotation<boolean>(),

    // Chain rule learning support
    rejectedChains: Annotation<TaskChain[]>(),
    wasRegenerated: Annotation<boolean>()
});

export type TaskChainPlanningStateType = typeof TaskChainPlanningState.State;

/**
 * Initialize planning workflow
 */
async function initializePlanning(state: TaskChainPlanningStateType): Promise<Partial<TaskChainPlanningStateType>> {
    elizaLogger.info(`[TaskChainPlanner] Starting planning for: "${state.userRequest}"`);

    try {
        // Validate inputs
        if (!state.userRequest || !state.threadId || !state.context) {
            throw new Error("Missing required inputs for planning");
        }

        return {
            phase: 'context_extraction',
            isComplete: false,
            hasError: false
        };

    } catch (error: any) {
        elizaLogger.error(`[TaskChainPlanner] Initialization failed: ${error.message}`);
        return {
            hasError: true,
            errorMessage: `Planning initialization failed: ${error.message}`,
            phase: 'error'
        };
    }
}

/**
 * Extract context information for planning
 */
async function extractPlanningContext(state: TaskChainPlanningStateType): Promise<Partial<TaskChainPlanningStateType>> {
    elizaLogger.info("[TaskChainPlanner] Extracting planning context");

    try {
        // Extract last 5 user queries from conversation history
        const runtime = getThreadRuntime(state.threadId!);
        const lastFiveQueries = extractLastUserQueries(
            state.context!,
            runtime
        );

        const favoriteTaskChain = extractFavoriteTaskChain(state.context!, runtime);
        if (favoriteTaskChain) {
            elizaLogger.info(
                `[TaskChainPlanner] Favorite task chain detected: ${favoriteTaskChain.name} (${favoriteTaskChain.tasks.length} tasks)`
            );
        }

        // Get current date in a readable format
        const currentDate = new Date().toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });

        return {
            lastFiveQueries,
            currentDate,
            favoriteTaskChain: favoriteTaskChain ?? undefined,
            favoriteChainUsed: false,
            phase: 'favorite_chain_check'
        };

    } catch (error: any) {
        elizaLogger.error(`[TaskChainPlanner] Context extraction failed: ${error.message}`);
        return {
            hasError: true,
            errorMessage: `Context extraction failed: ${error.message}`,
            phase: 'error'
        };
    }
}

/**
 * Handle favorite task chain attachment if present
 */
async function processFavoriteTaskChain(state: TaskChainPlanningStateType): Promise<Partial<TaskChainPlanningStateType>> {
    if (!state.favoriteTaskChain) {
        return {
            favoriteChainUsed: false,
            phase: 'llm_planning'
        };
    }

    elizaLogger.info(`[TaskChainPlanner] Personalizing favorite task chain: ${state.favoriteTaskChain.name}`);

    const runtime = getThreadRuntime(state.threadId!);
    const streamingCallback = getStreamingCallback(state.context, state.threadId);

    const announce = (status: "in_progress" | "completed" | "error", message: string) => {
        if (!streamingCallback) {
            return;
        }
        streamingCallback({
            id: uuidv4(),
            name: "favorite_task_chain",
            status,
            message,
            timestamp: Date.now(),
            data: {
                type: "favorite_task_chain",
                chainId: state.favoriteTaskChain!.id,
                chainName: state.favoriteTaskChain!.name,
                status
            }
        });
    };

    try {
        announce("in_progress", `Personalizing favorite task chain "${state.favoriteTaskChain.name}" for the current query`);

        const baseChainData = convertNormalizedChainToPlannerData(state.favoriteTaskChain);

        const userQuery = state.userRequest?.trim() ?? "";
        if (userQuery.length === 0) {
            elizaLogger.info("[TaskChainPlanner] No user query provided; using favorite chain without modification");
            announce("completed", `Using saved task chain "${state.favoriteTaskChain.name}" without changes`);
            return {
                parsedChainData: baseChainData,
                favoriteChainUsed: true,
                phase: 'construction'
            };
        }

        const currentDate = state.currentDate ?? new Date().toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });

        const favoriteChainJson = JSON.stringify(baseChainData, null, 2);
        const updateTemplate = getFavoriteChainUpdateTemplate();
        const languageInstruction = resolvePlannerLanguageInstruction(state);
        const updateState = {
            ...state.context,
            currentDate,
            userRequest: userQuery,
            favoriteChainJson,
            originalChainName: baseChainData.chain_name,
            originalChainDescription: baseChainData.chain_description,
            languageInstruction
        } as State;
        const { system: updateSystem, prompt: updatePrompt } = composeContextSplit({ state: updateState, template: updateTemplate });

        const llmResponse = await generateText({
            runtime,
            system: updateSystem,
            prompt: updatePrompt,
            modelClass: ModelClass.MEDIUM
        });

        const updatedChainData = buildUpdatedPlannerChainData(state.favoriteTaskChain, llmResponse);

        announce("completed", `Personalized favorite task chain "${state.favoriteTaskChain.name}" for this request`);

        return {
            planningContext: [updateSystem, updatePrompt].join("\n\n"),
            llmResponse,
            parsedChainData: updatedChainData,
            favoriteChainUsed: true,
            phase: 'construction'
        };

    } catch (error: any) {
        const message = `[TaskChainPlanner] Failed to personalize favorite task chain: ${error.message}`;
        elizaLogger.error(message);
        announce("error", `Failed to personalize favorite task chain; using saved version as-is.`);

        const fallbackChain = convertNormalizedChainToPlannerData(state.favoriteTaskChain);

        return {
            parsedChainData: fallbackChain,
            favoriteChainUsed: true,
            phase: 'construction'
        };
    }
}

/**
 * Generate task chain using LLM
 */
async function generateTaskChain(state: TaskChainPlanningStateType): Promise<Partial<TaskChainPlanningStateType>> {
    elizaLogger.info("[TaskChainPlanner] Generating task chain with LLM");

    try {
        // Build enhanced user request with previous chain context if this is a regeneration
        let enhancedUserRequest = state.userRequest || '';

        // Check if we have user feedback from a rejection (for regeneration)
        if (state.userFeedback && state.taskChain) {
            // Format the current task chain for the LLM
            const currentChainInfo = JSON.stringify({
                chain_name: state.taskChain.name,
                chain_description: state.taskChain.description,
                tasks: state.taskChain.tasks.map((task: any) => ({
                    id: task.id,
                    name: task.name,
                    description: task.description,
                    dependencies: task.dependencies || []
                }))
            }, null, 2);

            enhancedUserRequest = `${enhancedUserRequest}

REGENERATION CONTEXT:
The user has rejected the previous task chain and provided feedback for improvement.

CURRENT TASK CHAIN THAT WAS REJECTED:
\`\`\`json
${currentChainInfo}
\`\`\`

USER FEEDBACK ON WHY IT WAS REJECTED:
"${state.userFeedback}"

INSTRUCTIONS FOR REGENERATION:
Please create an improved task chain that addresses the user's specific feedback above. Carefully analyze what the user wants changed and adjust the tasks accordingly - you may need to add new tasks, remove existing tasks, reorder tasks, or modify task descriptions. Keep what was good about the previous plan, but fix the issues identified in the feedback.`;

            elizaLogger.info(`[TaskChainPlanner] Added current chain and user feedback for regeneration`);
        }

        // Retrieve learned rules directly in this function
        const learnedRulesText = "No learned patterns available yet.";
        try {
            const runtime = getThreadRuntime(state.threadId!);
        } catch (error: any) {
            elizaLogger.warn(`[TaskChainPlanner] Rule retrieval failed (non-critical): ${error.message}`);
            // Continue with default "No learned patterns" text
        }

        // Prepare context for LLM
        const planningTemplate = getTaskChainPlanningTemplate();
        const languageInstruction = resolvePlannerLanguageInstruction(state);
        const planState = {
            ...state.context,
            userRequest: enhancedUserRequest,
            lastFiveQueries: state.lastFiveQueries,
            currentDate: state.currentDate,
            availableActions: formatActionsForTemplate(state.availableActions || []),
            learnedRules: learnedRulesText,
            languageInstruction
        };
        const { system: planSystem, prompt: planPrompt } = composeContextSplit({ state: planState, template: planningTemplate });

        // Generate the task chain using LLM
        const response = await generateText({
            runtime: getThreadRuntime(state.threadId!),
            system: planSystem,
            prompt: planPrompt,
            modelClass: ModelClass.MEDIUM,
        });

        elizaLogger.debug(`[TaskChainPlanner] LLM response received: ${response.substring(0, 200)}...`);

        return {
            planningContext: [planSystem, planPrompt].join("\n\n"),
            llmResponse: response,
            phase: 'parsing'
        };

    } catch (error: any) {
        elizaLogger.error(`[TaskChainPlanner] LLM generation failed: ${error.message}`);
        return {
            hasError: true,
            errorMessage: `LLM generation failed: ${error.message}`,
            phase: 'error'
        };
    }
}

/**
 * Parse LLM response to extract chain data
 */
async function parseChainResponse(state: TaskChainPlanningStateType): Promise<Partial<TaskChainPlanningStateType>> {
    elizaLogger.info("[TaskChainPlanner] Parsing LLM response");

    try {
        const jsonMatch = state.llmResponse!.match(/```json\s*([\s\S]*?)\s*```/);
        if (!jsonMatch) {
            throw new Error("No JSON found in LLM response");
        }

        const chainData = JSON.parse(jsonMatch[1]);
        if (!chainData.chain_name || !chainData.tasks) {
            throw new Error("Invalid chain structure in LLM response");
        }

        elizaLogger.info(`[TaskChainPlanner] Successfully parsed chain: ${chainData.chain_name} with ${chainData.tasks.length} tasks`);

        return {
            parsedChainData: chainData,
            phase: 'construction'
        };

    } catch (error: any) {
        elizaLogger.error(`[TaskChainPlanner] Response parsing failed: ${error.message}`);
        return {
            hasError: true,
            errorMessage: `Response parsing failed: ${error.message}`,
            phase: 'error'
        };
    }
}

/**
 * Construct TaskNode objects from parsed data
 */
async function constructTaskNodes(state: TaskChainPlanningStateType): Promise<Partial<TaskChainPlanningStateType>> {
    elizaLogger.info("[TaskChainPlanner] Constructing task nodes");

    try {
        const chainData = state.parsedChainData!;

        const taskNodes: TaskNode[] = chainData.tasks.map((taskData: any) => ({
            id: taskData.id || uuidv4() as UUID,
            type: undefined as any, // Type will be determined by task executor
            name: taskData.name,
            description: taskData.description,
            status: 'pending' as TaskStatus,
            dependencies: taskData.dependencies || [],
            inputs: [], // Will be populated by action selection
            outputs: [], // Will be populated by action selection
            config: {
                modelClass: ModelClass.MEDIUM,
                template: '',
                contextVariables: {},
                expectJson: false
            } as any
        }));

        const chainMetadata = {
            createdAt: Date.now(),
            status: 'pending',
            estimatedDuration: chainData.tasks.length * 10000 // 10s per task estimate
        };

        const chainConfig = {
            maxParallel: 3,
            timeout: 300000, // 5 minute timeout
            continueOnFailure: false
        };

        return {
            taskNodes,
            chainMetadata,
            chainConfig,
            phase: 'validation'
        };

    } catch (error: any) {
        elizaLogger.error(`[TaskChainPlanner] Task node construction failed: ${error.message}`);
        return {
            hasError: true,
            errorMessage: `Task node construction failed: ${error.message}`,
            phase: 'error'
        };
    }
}

/**
 * Validate the constructed task chain
 */
async function validateTaskChain(state: TaskChainPlanningStateType): Promise<Partial<TaskChainPlanningStateType>> {
    elizaLogger.info("[TaskChainPlanner] Validating task chain");

    try {
        const taskNodes = state.taskNodes!;
        const errors: string[] = [];
        const warnings: string[] = [];

        // Check for circular dependencies
        if (hasCircularDependencies(taskNodes)) {
            errors.push("Circular dependencies detected");
        }

        // Check that dependencies reference valid tasks
        const taskIds = new Set(taskNodes.map(t => t.id));
        for (const task of taskNodes) {
            for (const depId of task.dependencies) {
                if (!taskIds.has(depId)) {
                    errors.push(`Invalid dependency: ${depId}`);
                }
            }
        }

        const validationResult = {
            isValid: errors.length === 0,
            errors,
            warnings
        };

        if (!validationResult.isValid) {
            elizaLogger.error(`[TaskChainPlanner] Validation failed: ${errors.join(', ')}`);
            return {
                validationResult,
                hasError: true,
                errorMessage: `Chain validation failed: ${errors.join(', ')}`,
                phase: 'error'
            };
        }

        return {
            validationResult,
            phase: 'finalization'
        };

    } catch (error: any) {
        elizaLogger.error(`[TaskChainPlanner] Validation failed: ${error.message}`);
        return {
            hasError: true,
            errorMessage: `Validation failed: ${error.message}`,
            phase: 'error'
        };
    }
}

/**
 * Finalize and create the TaskChain object
 */
async function finalizeTaskChain(state: TaskChainPlanningStateType): Promise<Partial<TaskChainPlanningStateType>> {
    elizaLogger.info("[TaskChainPlanner] Finalizing task chain");

    try {
        const chainData = state.parsedChainData!;

        const taskChain: TaskChain = {
            id: uuidv4() as UUID,
            name: chainData.chain_name,
            description: chainData.chain_description,
            tasks: state.taskNodes!,
            originalRequest: state.userRequest!,
            metadata: state.chainMetadata!,
            config: state.chainConfig!
        };

        elizaLogger.success(`[TaskChainPlanner] Created chain "${taskChain.name}" with ${taskChain.tasks.length} tasks`);

        return {
            taskChain,
            phase: 'completed',
            isComplete: true
        };

    } catch (error: any) {
        elizaLogger.error(`[TaskChainPlanner] Finalization failed: ${error.message}`);
        return {
            hasError: true,
            errorMessage: `Finalization failed: ${error.message}`,
            phase: 'error'
        };
    }
}

/**
 * Wait for human approval of the task chain using LangGraph's interrupt()
 */
async function waitForHumanApproval(state: TaskChainPlanningStateType): Promise<Partial<TaskChainPlanningStateType>> {
    elizaLogger.info("[TaskChainPlanner] Waiting for human approval");

    try {
        // Check if user has already made a decision (approved/rejected)
        // This happens when resuming after user clicked approve/reject
        if (state.approvalDecision && state.approvalDecision !== 'pending') {
            elizaLogger.info(`[TaskChainPlanner] Approval decision already made: ${state.approvalDecision}, skipping interrupt`);
            return {
                phase: 'approval_received'
            };
        }

        const streamingCallback = getStreamingCallback(state.context, state.threadId);

        if (!streamingCallback) {
            elizaLogger.warn("[TaskChainPlanner] No streaming callback available, auto-approving chain");
            return {
                approvalDecision: 'approved',
                awaitingApproval: false,
                phase: 'approval_received'
            };
        }

        // Prepare approval data to send to frontend
        const displayTaskChain = {
            id: state.taskChain!.id,
            name: state.taskChain!.name,
            description: state.taskChain!.description,
            originalRequest: state.taskChain!.originalRequest,
            tasks: state.taskChain!.tasks.map(task => ({
                id: task.id,
                name: task.name,
                description: task.description,
                type: task.type,
                status: task.status,
                dependencies: task.dependencies,
                hasResult: !!task.result,
                isSuccess: task.status === 'completed'
            }))
        };

        const fullTaskChain = JSON.parse(JSON.stringify(state.taskChain));

        const approvalData = {
            type: "chain_approval_required",
            chainId: state.taskChain!.id,
            taskChain: displayTaskChain,
            fullTaskChain
        };

        // Send approval request notification to frontend via streaming
        streamingCallback({
            id: uuidv4(),
            name: "chain_approval_required",
            status: "pending",
            message: `Please review and approve the task chain: ${state.taskChain!.name}`,
            timestamp: Date.now(),
            data: approvalData
        });

        elizaLogger.info("[TaskChainPlanner] Interrupting workflow for human approval");

        // Use LangGraph's interrupt() to pause execution and wait for user input
        const resumeData = interrupt(approvalData);

        elizaLogger.info(`[TaskChainPlanner] Received approval data:`, resumeData);

        // Extract decision and feedback from the resume data
        // resumeData will be: { decision: 'approved' | 'rejected', feedback?: string }
        const decision = (resumeData as any)?.decision || 'approved';
        const feedback = (resumeData as any)?.feedback || '';

        elizaLogger.info(`[TaskChainPlanner] Extracted: decision=${decision}, feedback=${feedback}`);

        // Process the approval decision received from interrupt resume
        return {
            approvalDecision: decision as 'approved' | 'rejected',
            userFeedback: feedback,
            awaitingApproval: false,
            approvalRequestSent: true,
            phase: 'approval_received'
        };

    } catch (error: any) {
        if (isLangGraphInterrupt(error)) {
            elizaLogger.info("[TaskChainPlanner] Workflow paused pending human approval");
            throw error;
        }
        elizaLogger.error(`[TaskChainPlanner] Failed to request approval: ${error.message}`);
        // If approval request fails, auto-approve to not block execution
        return {
            approvalDecision: 'approved',
            awaitingApproval: false,
            hasError: false,
            phase: 'approval_received'
        };
    }
}

// Identify LangGraph interrupt errors so we can rethrow them without treating as failures.
function isLangGraphInterrupt(error: unknown): boolean {
    if (!error || typeof error !== "object") {
        return false;
    }

    const candidate = error as { name?: string; interrupts?: unknown };
    if (candidate.name === "GraphInterrupt" || candidate.name === "NodeInterrupt") {
        return true;
    }

    return Array.isArray(candidate.interrupts);
}

/**
 * Process the human approval decision
 */
async function processApprovalDecision(state: TaskChainPlanningStateType): Promise<Partial<TaskChainPlanningStateType>> {
    elizaLogger.info(`[TaskChainPlanner] Processing approval decision: ${state.approvalDecision}`);

    try {
        if (state.approvalDecision === 'approved') {
            elizaLogger.success("[TaskChainPlanner] Task chain approved by user");

            const streamingCallback = getStreamingCallback(state.context, state.threadId);
            if (streamingCallback) {
                streamingCallback({
                    id: uuidv4(),
                    name: "chain_approved",
                    status: "completed",
                    message: `Task chain "${state.taskChain!.name}" approved`,
                    timestamp: Date.now(),
                    data: {
                        type: "chain_approved",
                        chainId: state.taskChain!.id,
                        chainName: state.taskChain!.name
                    }
                });
            }

            return {
                phase: 'completed',
                isComplete: true,
                awaitingApproval: false
            };
        } else if (state.approvalDecision === 'rejected') {
            elizaLogger.warn(`[TaskChainPlanner] Task chain rejected, regenerating...`);

            // Track rejected chain for rule learning
            const currentRejectedChains = state.rejectedChains || [];
            currentRejectedChains.push(state.taskChain!);

            // Need to regenerate
            return {
                phase: 'regeneration',
                awaitingApproval: false,
                rejectedChains: currentRejectedChains,
                wasRegenerated: true
            };
        }

        // Still pending - this shouldn't happen in normal flow
        elizaLogger.warn("[TaskChainPlanner] Approval still pending");
        return {
            phase: 'awaiting_approval'
        };

    } catch (error: any) {
        elizaLogger.error(`[TaskChainPlanner] Failed to process approval: ${error.message}`);
        return {
            hasError: true,
            errorMessage: `Approval processing failed: ${error.message}`,
            phase: 'error'
        };
    }
}

/**
 * Regenerate chain with user feedback
 */
async function regenerateWithFeedback(state: TaskChainPlanningStateType): Promise<Partial<TaskChainPlanningStateType>> {
    elizaLogger.info("[TaskChainPlanner] Regenerating chain with user feedback");

    try {
        const streamingCallback = getStreamingCallback(state.context, state.threadId);
        if (streamingCallback) {
            streamingCallback({
                id: uuidv4(),
                name: "chain_regenerating",
                status: "in_progress",
                message: `Regenerating task chain based on your feedback`,
                timestamp: Date.now(),
                data: {
                    type: "chain_regenerating",
                    chainId: state.taskChain!.id,
                    userFeedback: state.userFeedback
                }
            });
        }

        elizaLogger.info(`[TaskChainPlanner] Regenerating task chain based on user feedback`);

        // Return to context extraction phase to regenerate
        // Keep taskChain in state so it can be used as context for regeneration
        return {
            phase: 'context_extraction',
            approvalDecision: 'pending',
            approvalRequestSent: false,
            // Clear parsed data to force regeneration, but keep taskChain for context
            taskNodes: undefined,
            parsedChainData: undefined,
            llmResponse: undefined
        };

    } catch (error: any) {
        elizaLogger.error(`[TaskChainPlanner] Regeneration failed: ${error.message}`);
        return {
            hasError: true,
            errorMessage: `Chain regeneration failed: ${error.message}`,
            phase: 'error'
        };
    }
}

/**
 * Create fallback chain when planning fails
 */
async function createFallbackChain(state: TaskChainPlanningStateType): Promise<Partial<TaskChainPlanningStateType>> {
    elizaLogger.warn("[TaskChainPlanner] Creating fallback chain due to planning failure");

    try {
        const task: TaskNode = {
            id: uuidv4() as UUID,
            type: 'llm',
            name: 'Simple Response',
            description: 'Generate response to user request',
            status: 'pending',
            dependencies: [],
            inputs: [],
            outputs: [],
            config: {
                modelClass: ModelClass.MEDIUM,
                template: 'Respond to this user request: {{userRequest}}',
                contextVariables: { userRequest: state.userRequest },
                expectJson: false
            } as any
        };

        const taskChain: TaskChain = {
            id: uuidv4() as UUID,
            name: 'Simple Response',
            description: 'Basic response to user request',
            tasks: [task],
            originalRequest: state.userRequest!,
            metadata: {
                createdAt: Date.now(),
                status: 'pending',
                estimatedDuration: 10000
            },
            config: {
                maxParallel: 1,
                timeout: 30000,
                continueOnFailure: false
            }
        };

        return {
            taskChain,
            phase: 'completed',
            isComplete: true,
            hasError: false, // Reset error state since we have a fallback
            errorMessage: '' // Clear error message
        };

    } catch (error: any) {
        elizaLogger.error(`[TaskChainPlanner] Fallback creation failed: ${error.message}`);
        return {
            hasError: true,
            errorMessage: `Fallback creation failed: ${error.message}`,
            phase: 'error'
        };
    }
}

/**
 * Handle planning errors
 */
async function handlePlanningError(state: TaskChainPlanningStateType): Promise<Partial<TaskChainPlanningStateType>> {
    elizaLogger.error(`[TaskChainPlanner] Handling planning error: ${state.errorMessage}`);

    // Try to create a fallback chain instead of completely failing
    return createFallbackChain(state);
}

/**
 * Format available actions for template display
 */
function formatActionsForTemplate(actions: Action[]): string {
    if (!actions || actions.length === 0) {
        return "No specific actions available.";
    }

    return actions.map(action => {
        return `- **${action.name}**: ${action.description}`;
    }).join('\n');
}

function getStreamingCallback(context?: State, threadId?: string): StreamingCallback | undefined {
    const registered = getThreadStreamingCallback(threadId);
    if (registered) {
        return registered;
    }

    if (!context || typeof context !== "object") {
        return undefined;
    }

    const possible = (context as { streamingCallback?: unknown }).streamingCallback;
    return typeof possible === "function" ? possible as StreamingCallback : undefined;
}

function sanitizeContextForWorkflow(context: State): State {
    if (!context || typeof context !== "object") {
        return context;
    }

    if (!Object.prototype.hasOwnProperty.call(context, "streamingCallback")) {
        return context;
    }

    const cloned = { ...(context as Record<string, unknown>) };
    delete cloned.streamingCallback;
    return cloned as State;
}

function resolvePlannerLanguageInstruction(
    state: Pick<TaskChainPlanningStateType, "context" | "languageInstruction">
): string {
    if (typeof state.languageInstruction === "string" && state.languageInstruction.length > 0) {
        return state.languageInstruction;
    }

    const contextualLanguageInstruction = (state.context as Record<string, unknown> | undefined)?.languageInstruction;
    return typeof contextualLanguageInstruction === "string" ? contextualLanguageInstruction : "";
}

/**
 * Extract last 5 user queries from conversation history
 */
function extractLastUserQueries(context: State, runtime: IAgentRuntime): string {
    if (!context.lastFiveMessagesData || context.lastFiveMessagesData.length === 0) {
        return "No previous queries available.";
    }

    // Filter for user messages only (exclude agent responses)
    const userMessages = context.lastFiveMessagesData.filter(msg =>
        msg.userId !== runtime.agentId && msg.content.text
    );

    if (userMessages.length === 0) {
        return "No previous user queries found.";
    }

    // Exclude the current/most recent message and get the previous 5 user queries
    const previousUserQueries = userMessages.slice(0, -1);

    if (previousUserQueries.length === 0) {
        return "No previous queries available.";
    }

    // Format the previous user queries
    const formattedQueries = previousUserQueries
        .slice(-5) // Get last 5 previous user messages
        .map((msg, index) => `${index + 1}. ${msg.content.text}`)
        .join('\n');

    return formattedQueries || "No previous queries available.";
}

function tryNormalizeFavoriteChainCandidate(candidate: unknown, source: string): NormalizedFavoriteChain | undefined {
    if (!candidate) {
        return undefined;
    }

    let value: unknown = candidate;

    if (typeof candidate === "string") {
        const trimmed = candidate.trim();
        if (!trimmed) {
            return undefined;
        }

        try {
            value = JSON.parse(trimmed);
        } catch {
            elizaLogger.debug(`[TaskChainPlanner] Failed to parse favorite chain JSON from ${source}`);
            return undefined;
        }
    }

    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    return normalizeFavoriteChain(value, source);
}

function normalizeFavoriteChain(raw: unknown, source?: string): NormalizedFavoriteChain | undefined {
    if (!raw || typeof raw !== "object") {
        return undefined;
    }

    const candidate = (raw as Record<string, unknown>).taskChain && typeof (raw as Record<string, unknown>).taskChain === "object"
        ? (raw as Record<string, unknown>).taskChain as Record<string, unknown>
        : raw as Record<string, unknown>;

    const tasksValue = candidate.tasks;
    if (!Array.isArray(tasksValue) || tasksValue.length === 0) {
        return undefined;
    }

    const normalizedTasks: NormalizedFavoriteChainTask[] = [];
    for (let index = 0; index < tasksValue.length; index++) {
        const task = tasksValue[index];
        if (!task || typeof task !== "object") {
            return undefined;
        }

        const taskRecord = task as Record<string, unknown>;
        const id = typeof taskRecord.id === "string" && taskRecord.id.trim().length > 0
            ? taskRecord.id.trim()
            : undefined;

        if (!id) {
            elizaLogger.warn("[TaskChainPlanner] Favorite chain task missing id; skipping favorite chain");
            return undefined;
        }

        const name = typeof taskRecord.name === "string" && taskRecord.name.trim().length > 0
            ? taskRecord.name.trim()
            : `Task ${index + 1}`;

        const description = typeof taskRecord.description === "string"
            ? taskRecord.description
            : "";

        const rawDependencies = Array.isArray(taskRecord.dependencies)
            ? taskRecord.dependencies
            : [];

        const dependencies = rawDependencies
            .filter((dep): dep is string => typeof dep === "string" && dep.trim().length > 0)
            .map(dep => dep.trim());

        normalizedTasks.push({
            id,
            name,
            description,
            dependencies
        });
    }

    const idCandidates = [candidate.id, candidate.chain_id, (raw as Record<string, unknown>).id, (raw as Record<string, unknown>).chainId];
    const rawId = idCandidates.find(value => typeof value === "string" && value.trim().length > 0) as string | undefined;

    const chainNameCandidates = [candidate.chain_name, candidate.name];
    const rawName = chainNameCandidates.find(value => typeof value === "string" && value.trim().length > 0) as string | undefined;

    const chainDescriptionCandidates = [candidate.chain_description, candidate.description];
    const rawDescription = chainDescriptionCandidates.find(value => typeof value === "string") as string | undefined;

    const originalRequest = typeof candidate.originalRequest === "string"
        ? candidate.originalRequest
        : typeof (raw as Record<string, unknown>).originalRequest === "string"
            ? (raw as Record<string, unknown>).originalRequest as string
            : undefined;

    return {
        id: rawId ?? (uuidv4() as UUID),
        name: rawName ?? "Favorite Task Chain",
        description: rawDescription ?? "",
        originalRequest,
        tasks: normalizedTasks,
        source
    };
}

function extractFavoriteTaskChainFromMemory(memory: Memory): NormalizedFavoriteChain | undefined {
    if (!memory || !memory.content || typeof memory.content !== "object") {
        return undefined;
    }

    const content = memory.content as Record<string, unknown>;
    const candidateKeys = [
        "favoriteTaskChain",
        "favorite_task_chain",
        "favoriteTaskchain",
        "favorite_chain",
        "attachedTaskChain",
        "taskChain"
    ];

    for (const key of candidateKeys) {
        if (key in content) {
            const normalized = tryNormalizeFavoriteChainCandidate(content[key], `content.${key}`);
            if (normalized) {
                return normalized;
            }
        }
    }

    const metadata = content.metadata;
    if (metadata && typeof metadata === "object") {
        for (const key of candidateKeys) {
            if (key in (metadata as Record<string, unknown>)) {
                const normalized = tryNormalizeFavoriteChainCandidate(
                    (metadata as Record<string, unknown>)[key],
                    `metadata.${key}`
                );
                if (normalized) {
                    return normalized;
                }
            }
        }
    }

    const attachments = Array.isArray(content.attachments) ? content.attachments : [];
    for (const attachment of attachments) {
        if (!attachment || typeof attachment !== "object") {
            continue;
        }

        const attachmentRecord = attachment as Record<string, unknown>;
        const source = typeof attachmentRecord.source === "string"
            ? attachmentRecord.source.toLowerCase()
            : typeof attachmentRecord.contentType === "string"
                ? attachmentRecord.contentType.toLowerCase()
                : "";

        const isFavoriteSource = source.includes("favorite") && source.includes("task");

        if (attachmentRecord.taskChain) {
            const normalized = tryNormalizeFavoriteChainCandidate(
                attachmentRecord.taskChain,
                "attachment.taskChain"
            );
            if (normalized) {
                return normalized;
            }
        }

        if (attachmentRecord.metadata) {
            const normalized = tryNormalizeFavoriteChainCandidate(
                attachmentRecord.metadata,
                "attachment.metadata"
            );
            if (normalized) {
                return normalized;
            }
        }

        const textCandidate = typeof attachmentRecord.text === "string"
            ? attachmentRecord.text
            : typeof attachmentRecord.description === "string"
                ? attachmentRecord.description
                : undefined;

        if (textCandidate) {
            const normalized = tryNormalizeFavoriteChainCandidate(textCandidate, "attachment.text");
            if (normalized) {
                return normalized;
            }
        }

        if (isFavoriteSource) {
            const normalized = tryNormalizeFavoriteChainCandidate(attachment, "attachment");
            if (normalized) {
                return normalized;
            }
        }
    }

    return undefined;
}

function extractFavoriteTaskChain(context: State, runtime: IAgentRuntime): NormalizedFavoriteChain | undefined {
    if (!context || typeof context !== "object") {
        return undefined;
    }

    const messages = Array.isArray(context.lastFiveMessagesData) && context.lastFiveMessagesData.length > 0
        ? context.lastFiveMessagesData
        : Array.isArray(context.recentMessagesData)
            ? context.recentMessagesData
            : [];

    if (!messages || messages.length === 0) {
        return undefined;
    }

    const agentId = runtime.agentId;

    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (!message) {
            continue;
        }

        if (agentId && message.userId === agentId) {
            continue;
        }

        const favoriteChain = extractFavoriteTaskChainFromMemory(message);
        if (favoriteChain) {
            return favoriteChain;
        }
    }

    return undefined;
}

function convertNormalizedChainToPlannerData(chain: NormalizedFavoriteChain): PlannerChainData {
    return {
        chain_name: chain.name,
        chain_description: chain.description,
        tasks: chain.tasks.map(task => ({
            id: task.id,
            name: task.name,
            description: task.description,
            dependencies: [...task.dependencies]
        }))
    };
}

function parseFavoriteChainUpdateResponse(response?: string): Map<string, string> {
    if (!response || typeof response !== "string") {
        return new Map();
    }

    const jsonMatch = response.match(/```json\s*([\s\S]*?)```/i);
    const jsonText = jsonMatch ? jsonMatch[1] : response;

    try {
        const parsed = JSON.parse(jsonText);
        const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
        const map = new Map<string, { name?: string; description?: string }>();

        for (const task of tasks) {
            if (!task || typeof task !== "object") {
                continue;
            }

            const record = task as Record<string, unknown>;
            const id = typeof record.id === "string" && record.id.trim().length > 0
                ? record.id.trim()
                : undefined;

            if (!id) {
                continue;
            }

            const entry: { name?: string; description?: string } = {};
            if (typeof record.name === "string") {
                entry.name = record.name;
            }
            if (typeof record.description === "string") {
                entry.description = record.description;
            }

            if (entry.name || entry.description) {
                map.set(id, entry);
            }
        }

        const result = new Map<string, string>();
        for (const [taskId, overrides] of map.entries()) {
            result.set(`${taskId}::name`, overrides.name ?? "");
            result.set(`${taskId}::description`, overrides.description ?? "");
        }

        if (typeof parsed?.chain_name === "string") {
            result.set("__chain_name__", parsed.chain_name);
        }
        if (typeof parsed?.chain_description === "string") {
            result.set("__chain_description__", parsed.chain_description);
        }

        return result;

    } catch (error) {
        elizaLogger.warn(`[TaskChainPlanner] Failed to parse favorite chain update response: ${(error as Error).message}`);
        return new Map();
    }
}

function buildUpdatedPlannerChainData(
    chain: NormalizedFavoriteChain,
    response?: string
): PlannerChainData {
    const overrides = parseFavoriteChainUpdateResponse(response);

    return {
        chain_name: overrides.get("__chain_name__")?.trim() || chain.name,
        chain_description: overrides.get("__chain_description__")?.trim() || chain.description,
        tasks: chain.tasks.map(task => {
            const nameOverride = overrides.get(`${task.id}::name`);
            const descriptionOverride = overrides.get(`${task.id}::description`);

            return {
                id: task.id,
                name: nameOverride && nameOverride.trim().length > 0 ? nameOverride : task.name,
                description:
                    descriptionOverride && descriptionOverride.trim().length > 0
                        ? descriptionOverride
                        : task.description,
                dependencies: [...task.dependencies]
            };
        })
    };
}

/**
 * Check for circular dependencies in task nodes
 */
function hasCircularDependencies(taskNodes: TaskNode[]): boolean {
    const taskMap = new Map(taskNodes.map(t => [t.id, t]));
    const visiting = new Set<UUID>();
    const visited = new Set<UUID>();

    const hasCycle = (taskId: UUID): boolean => {
        if (visiting.has(taskId)) return true;
        if (visited.has(taskId)) return false;

        visiting.add(taskId);
        const task = taskMap.get(taskId);
        if (task) {
            for (const depId of task.dependencies) {
                if (hasCycle(depId)) return true;
            }
        }
        visiting.delete(taskId);
        visited.add(taskId);
        return false;
    };

    return taskNodes.some(task => hasCycle(task.id));
}

/**
 * Create the Task Chain Planning Workflow Graph
 */
export function createTaskChainPlanningWorkflow(checkpointer?: MemorySaver) {
    const workflow = new StateGraph(TaskChainPlanningState)
        .addNode("initialize", initializePlanning)
        .addNode("extractContext", extractPlanningContext)
        .addNode("processFavoriteChain", processFavoriteTaskChain)
        .addNode("generateChain", generateTaskChain)
        .addNode("parseResponse", parseChainResponse)
        .addNode("constructNodes", constructTaskNodes)
        .addNode("validateChain", validateTaskChain)
        .addNode("finalizeChain", finalizeTaskChain)
        .addNode("waitForApproval", waitForHumanApproval)
        .addNode("processApproval", processApprovalDecision)
        .addNode("regenerateChain", regenerateWithFeedback)
        .addNode("createFallback", createFallbackChain)
        .addNode("handleError", handlePlanningError)

        // Sequential flow with error handling
        .addEdge("__start__", "initialize")
        .addConditionalEdges("initialize", (state: TaskChainPlanningStateType) => {
            return state.hasError ? "handleError" : "extractContext";
        })
        .addConditionalEdges("extractContext", (state: TaskChainPlanningStateType) => {
            return state.hasError ? "handleError" : "processFavoriteChain";
        })
        .addConditionalEdges("processFavoriteChain", (state: TaskChainPlanningStateType) => {
            if (state.hasError) {
                return "handleError";
            }

            return state.favoriteChainUsed ? "constructNodes" : "generateChain";
        })
        .addConditionalEdges("generateChain", (state: TaskChainPlanningStateType) => {
            return state.hasError ? "handleError" : "parseResponse";
        })
        .addConditionalEdges("parseResponse", (state: TaskChainPlanningStateType) => {
            return state.hasError ? "handleError" : "constructNodes";
        })
        .addConditionalEdges("constructNodes", (state: TaskChainPlanningStateType) => {
            return state.hasError ? "handleError" : "validateChain";
        })
        .addConditionalEdges("validateChain", (state: TaskChainPlanningStateType) => {
            return state.hasError ? "handleError" : "finalizeChain";
        })
        // After finalizing the chain, request human approval
        .addEdge("finalizeChain", "waitForApproval")
        // After waiting for approval, process the decision
        .addEdge("waitForApproval", "processApproval")
        // Based on approval decision, either complete or regenerate
        .addConditionalEdges("processApproval", (state: TaskChainPlanningStateType) => {
            if (state.hasError) return "handleError";
            if (state.phase === 'regeneration') return "regenerateChain";
            return "__end__"; // Approved or max attempts reached
        })
        // After regeneration, go back to extract context with new feedback
        .addEdge("regenerateChain", "extractContext")
        .addEdge("createFallback", "__end__")
        .addEdge("handleError", "__end__");

    // Compile with checkpointer if provided (required for interrupt() to work)
    return checkpointer ? workflow.compile({ checkpointer }) : workflow.compile();
}

/**
 * LangGraph-based TaskChainPlanner implementation
 */
export class LangGraphTaskChainPlanner implements TaskChainPlanner {
    private runtime: IAgentRuntime;
    private planningWorkflow: ReturnType<typeof createTaskChainPlanningWorkflow>;
    private checkpointer: MemorySaver;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
        this.checkpointer = new MemorySaver();
        this.planningWorkflow = createTaskChainPlanningWorkflow(this.checkpointer);
    }

    /**
     * Plan a task chain using LangGraph workflow
     */
    async planChain(
        request: string,
        context: State,
        availableActions: Action[],
        streamingCallback?: StreamingCallback
    ): Promise<TaskChain> {
        elizaLogger.info(`[LangGraphTaskChainPlanner] Planning chain for: "${request}"`);

        const threadId = (context as any).roomId || uuidv4();
        const threadConfig = { configurable: { thread_id: threadId } };

        registerThreadResources(threadId, this.runtime, streamingCallback);

        const sanitizedContext = sanitizeContextForWorkflow(context);

        const resolvedLanguageInstruction =
            typeof (sanitizedContext as Record<string, unknown>)?.languageInstruction === "string"
                ? ((sanitizedContext as Record<string, unknown>).languageInstruction as string)
                : "";

        const initialState: Partial<TaskChainPlanningStateType> = {
            threadId,
            userRequest: request,
            context: sanitizedContext,
            availableActions,
            languageInstruction: resolvedLanguageInstruction
        };

        let keepResources = false;

        try {
            elizaLogger.info(`[LangGraphTaskChainPlanner] Streaming callback ${streamingCallback ? 'registered' : 'not provided'}`);
            elizaLogger.info(`[LangGraphTaskChainPlanner] languageInstruction resolved: "${resolvedLanguageInstruction.substring(0, 60)}${resolvedLanguageInstruction.length > 60 ? '...' : ''}" (length=${resolvedLanguageInstruction.length})`);
            elizaLogger.info(`[LangGraphTaskChainPlanner] Using thread_id: ${threadId} for checkpointing`);

            // Use stream() instead of invoke() to properly detect interrupts
            let lastState: any = null;
            let isInterrupted = false;
            let interruptData: any = null;

            for await (const chunk of await this.planningWorkflow.stream(initialState, threadConfig)) {
                elizaLogger.debug(`[LangGraphTaskChainPlanner] Stream chunk keys:`, Object.keys(chunk));

                // Check if this chunk contains an interrupt
                if ((chunk as any).__interrupt__) {
                    elizaLogger.info(`[LangGraphTaskChainPlanner] Workflow interrupted for human approval`);
                    elizaLogger.info(`[LangGraphTaskChainPlanner] Interrupt data:`, (chunk as any).__interrupt__);
                    interruptData = (chunk as any).__interrupt__?.[0]?.value;
                    isInterrupted = true;
                    break;
                }

                // Store the latest state - stream returns {nodeName: state} format
                // We want to accumulate the state updates
                const nodeNames = Object.keys(chunk);
                for (const nodeName of nodeNames) {
                    if (nodeName !== '__end__') {
                        const stateUpdate = chunk[nodeName];
                        lastState = lastState ? { ...lastState, ...stateUpdate } : stateUpdate;
                        elizaLogger.debug(`[LangGraphTaskChainPlanner] Updated state from node: ${nodeName}`);
                    }
                }
            }

            // If interrupted, throw special error
            if (isInterrupted) {
                const interruptError = new Error('WORKFLOW_INTERRUPTED_FOR_APPROVAL');
                (interruptError as any).threadId = threadId;
                (interruptError as any).fullTaskChain = interruptData?.fullTaskChain;
                keepResources = true;
                throw interruptError;
            }

            // Check if we have a valid final state with taskChain
            if (!lastState) {
                throw new Error("Planning workflow did not produce any state");
            }

            elizaLogger.debug(`[LangGraphTaskChainPlanner] Final state keys:`, Object.keys(lastState));
            elizaLogger.debug(`[LangGraphTaskChainPlanner] Has taskChain:`, !!lastState.taskChain);

            if (lastState.hasError && !lastState.taskChain) {
                throw new Error(lastState.errorMessage || "Planning failed with unknown error");
            }

            if (!lastState.taskChain) {
                throw new Error("Planning workflow completed but did not produce a task chain");
            }

            return lastState.taskChain;

        } catch (error: any) {
            // Re-throw interrupt errors as-is
            if (error.message === 'WORKFLOW_INTERRUPTED_FOR_APPROVAL') {
                throw error;
            }

            elizaLogger.error(`[LangGraphTaskChainPlanner] Planning failed: ${error.message}`);
            throw error;
        } finally {
            if (!keepResources) {
                clearThreadResources(threadId);
            }
        }
    }

    /**
     * Resume a paused workflow with approval decision
     * Used for human-in-the-loop approval
     */
    async resumeWithApproval(
        threadId: string,
        approvalDecision: { decision: 'approved' | 'rejected', feedback?: string },
        existingTaskChain?: TaskChain
    ): Promise<TaskChain> {
        elizaLogger.info(`[LangGraphTaskChainPlanner] Resuming workflow ${threadId} with decision: ${approvalDecision.decision}`);

        if (!threadResources.has(threadId)) {
            registerThreadResources(threadId, this.runtime);
        }

        try {
            const threadConfig = { configurable: { thread_id: threadId } };

            // Resume the workflow with the approval decision using stream()
            let lastState: any = existingTaskChain ? { taskChain: existingTaskChain } : null;
            let isInterrupted = false;
            let interruptData: any = null;

            for await (const chunk of await this.planningWorkflow.stream(
                new Command({ resume: approvalDecision }),
                threadConfig
            )) {
                elizaLogger.debug(`[LangGraphTaskChainPlanner] Resume stream chunk keys:`, Object.keys(chunk));

                // Check if workflow is interrupted again (e.g., for another regeneration)
                if ((chunk as any).__interrupt__) {
                    elizaLogger.info(`[LangGraphTaskChainPlanner] Workflow interrupted again (regeneration)`);
                    interruptData = (chunk as any).__interrupt__?.[0]?.value;
                    isInterrupted = true;
                    break;
                }

                // Store the latest state - stream returns {nodeName: state} format
                const nodeNames = Object.keys(chunk);
                for (const nodeName of nodeNames) {
                    if (nodeName !== '__end__') {
                        const stateUpdate = chunk[nodeName];
                        lastState = lastState ? { ...lastState, ...stateUpdate } : stateUpdate;
                        elizaLogger.debug(`[LangGraphTaskChainPlanner] Updated state from node: ${nodeName}`);
                    }
                }
            }

            // If interrupted again (for regeneration), throw special error
            if (isInterrupted) {
                const interruptError = new Error('WORKFLOW_INTERRUPTED_FOR_APPROVAL');
                (interruptError as any).threadId = threadId;
                (interruptError as any).fullTaskChain = interruptData?.fullTaskChain;
                throw interruptError;
            }

            // Check if we have a valid final state with taskChain
            if (!lastState) {
                throw new Error("Resume workflow did not produce any state");
            }

            elizaLogger.debug(`[LangGraphTaskChainPlanner] Final resume state keys:`, Object.keys(lastState));
            elizaLogger.debug(`[LangGraphTaskChainPlanner] Has taskChain:`, !!lastState.taskChain);

            if (lastState.hasError && !lastState.taskChain) {
                throw new Error(lastState.errorMessage || "Workflow resume failed");
            }

            if (!lastState.taskChain) {
                throw new Error("Resume workflow completed but did not produce a task chain");
            }

            clearThreadResources(threadId);
            return lastState.taskChain;

        } catch (error: any) {
            // Re-throw interrupt errors as-is
            if (error.message === 'WORKFLOW_INTERRUPTED_FOR_APPROVAL') {
                throw error;
            }

            elizaLogger.error(`[LangGraphTaskChainPlanner] Resume failed: ${error.message}`);
            clearThreadResources(threadId);
            throw error;
        }
    }

    /**
     * Optimize existing chain (simplified - just find parallel opportunities)
     */
    async optimizeChain(chain: TaskChain): Promise<TaskChain> {
        // Clone and find tasks that can run in parallel
        const optimized = JSON.parse(JSON.stringify(chain)) as TaskChain;

        // Calculate parallel opportunities
        const parallelGroups = this.findParallelTasks(optimized.tasks);
        optimized.config.maxParallel = Math.max(2, Math.max(...parallelGroups.map(g => g.length)));

        return optimized;
    }

    /**
     * Validate task chain structure
     */
    validateChain(chain: TaskChain): { isValid: boolean; errors: string[]; warnings: string[] } {
        const errors: string[] = [];
        const warnings: string[] = [];

        // Check for circular dependencies
        if (hasCircularDependencies(chain.tasks)) {
            errors.push("Circular dependencies detected");
        }

        // Check that dependencies reference valid tasks
        const taskIds = new Set(chain.tasks.map(t => t.id));
        for (const task of chain.tasks) {
            for (const depId of task.dependencies) {
                if (!taskIds.has(depId)) {
                    errors.push(`Invalid dependency: ${depId}`);
                }
            }
        }

        return { isValid: errors.length === 0, errors, warnings };
    }

    /**
     * Find tasks that can run in parallel
     */
    private findParallelTasks(tasks: TaskNode[]): UUID[][] {
        const groups: UUID[][] = [];
        const levels = this.calculateTaskLevels(tasks);
        const levelGroups = new Map<number, UUID[]>();

        for (const [taskId, level] of levels) {
            if (!levelGroups.has(level)) {
                levelGroups.set(level, []);
            }
            levelGroups.get(level)!.push(taskId);
        }

        for (const [level, taskIds] of levelGroups) {
            if (taskIds.length > 1) {
                groups.push(taskIds);
            }
        }

        return groups;
    }

    /**
     * Calculate task dependency levels
     */
    private calculateTaskLevels(tasks: TaskNode[]): Map<UUID, number> {
        const levels = new Map<UUID, number>();
        const taskMap = new Map(tasks.map(t => [t.id, t]));

        const getLevel = (taskId: UUID): number => {
            if (levels.has(taskId)) return levels.get(taskId)!;

            const task = taskMap.get(taskId);
            if (!task || task.dependencies.length === 0) {
                levels.set(taskId, 0);
                return 0;
            }

            const maxDepLevel = Math.max(...task.dependencies.map(depId => getLevel(depId)));
            const level = maxDepLevel + 1;
            levels.set(taskId, level);
            return level;
        };

        for (const task of tasks) {
            getLevel(task.id);
        }

        return levels;
    }
 
}
/**
 * Default implementation - maintains backward compatibility
 */
export class DefaultTaskChainPlanner extends LangGraphTaskChainPlanner {
    constructor(runtime: IAgentRuntime) {
        super(runtime);
    }
}
