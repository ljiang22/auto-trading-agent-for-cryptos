/**
 * Task Chain Supervisor
 * Evaluates and potentially modifies task chains after each level execution
 */

import { v4 as uuidv4 } from 'uuid';
import { elizaLogger } from "../utils/logger.ts";
import { generateText } from "../ai/generation.ts";
import { composeContextSplit } from "../core/context.ts";
import { getTaskChainSupervisorTemplate } from "../templates/taskChainSupervisorTemplate.ts";
import { DefaultDependencyResolver } from "./dependencyResolver.ts";
import { ModelClass } from "../core/types.ts";
import type {
    UUID,
    TaskNode,
    TaskChain,
    TaskStatus,
    TaskType,
    ActionTaskConfig
} from "../core/types.ts";

/**
 * State interface for supervisor (subset of TaskChainWorkflowStateType)
 */
export interface SupervisorState {
    userRequest?: string;
    currentChain?: TaskChain;
    completedTasks?: UUID[];
    executionLevels?: UUID[][];
    currentLevelIndex?: number;
    runtime?: any;
    state?: any;
    streamingCallback?: any;
    config?: any;
    languageInstruction?: string;
}

/**
 * Supervisor modifications structure
 */
export interface SupervisorModifications {
    decision: boolean;
    add_tasks?: Array<{
        name: string;
        description: string;
        dependencies: string[];
    }>;
    add_branch?: {
        enabled: boolean;
        tasks: Array<{
            name: string;
            description: string;
            dependencies: string[];
        }>;
        merge_point?: string;
    };
    remove_task_ids?: string[];
    change_dependencies?: Array<{
        task_id: string;
        new_dependencies: string[];
    }>;
}

/**
 * Build executed actions summary for supervisor
 */
export function buildExecutedActionsSummary(state: SupervisorState): string {
    if (!state.completedTasks || state.completedTasks.length === 0) {
        return 'No tasks completed yet.';
    }

    const completedTaskNodes = state.completedTasks
        .map(taskId => state.currentChain?.tasks.find(t => t.id === taskId))
        .filter((t): t is TaskNode => !!t);

    if (completedTaskNodes.length === 0) {
        return 'No completed task details available.';
    }

    const summaries = completedTaskNodes.map(task => {
        const taskType = task.type === 'action' ? 'Action Task' : 'LLM Task';
        let summary = `**${task.name}** (${taskType})`;

        if (task.type === 'action' && task.config) {
            const config = task.config as ActionTaskConfig;
            // Extract action parameters from config
            if (config.actions && Array.isArray(config.actions)) {
                const actionParams = config.actions.map((a: any) => {
                    const params = Object.entries(a.parameters || {})
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(', ');
                    return params ? `${a.action}(${params})` : a.action;
                }).join(', ');
                summary += `\n  Actions: ${actionParams}`;
            }

            const resultData = task.result?.data;
            if (resultData && (resultData as any).results && Array.isArray((resultData as any).results)) {
                const actionSummaries = (resultData as any).results
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
                summary += '\n  Status: ✓ Completed';
            }
        } else if (task.type === 'llm' && task.result?.data) {
            const resultData = task.result.data as any;
            // Prefer using the LLM-generated summary if available
            if (resultData.summary && typeof resultData.summary === 'string') {
                summary += `\n  Summary: ${resultData.summary}`;
            } else {
                summary += '\n  Status: ✓ Analysis completed';
            }
        }

        return summary;
    });

    return summaries.join('\n\n');
}

/**
 * Build full chain summary for supervisor (all tasks grouped by level)
 */
export function buildFullChainSummary(state: SupervisorState): string {
    if (!state.currentChain || !state.executionLevels) {
        return 'No chain or execution levels available.';
    }

    const chain = state.currentChain;
    const levelSummaries: string[] = [];

    for (let i = 0; i < state.executionLevels!.length; i++) {
        const levelNum = i + 1;
        const taskIds = state.executionLevels![i];
        const tasks = taskIds
            .map(taskId => chain.tasks.find(t => t.id === taskId))
            .filter((t): t is TaskNode => !!t);

        const taskLines = tasks.map(task => {
            const status = task.status || 'pending';
            const deps = task.dependencies.length > 0
                ? task.dependencies.map(depId => {
                    const dep = chain.tasks.find(t => t.id === depId);
                    return dep ? `${dep.name} (ID: ${depId})` : depId.substring(0, 8);
                }).join(', ')
                : 'None';
            return `  - **${task.name}** (ID: ${task.id}) | Status: ${status} | Dependencies: ${deps}\n    Description: ${task.description}`;
        });

        levelSummaries.push(`**Level ${levelNum}**:\n${taskLines.join('\n')}`);
    }

    return levelSummaries.join('\n\n');
}

/**
 * Get completed level information for supervisor
 */
export function getCompletedLevelInfo(state: SupervisorState): { level: number; taskCount: number } {
    if (!state.currentLevelIndex || state.currentLevelIndex === 0) {
        return { level: 0, taskCount: 0 };
    }

    // currentLevelIndex has already been incremented after execution
    const completedLevelIndex = state.currentLevelIndex - 1;
    const completedLevel = completedLevelIndex + 1; // Convert to 1-based for display

    if (!state.executionLevels || completedLevelIndex < 0 || completedLevelIndex >= state.executionLevels.length) {
        return { level: completedLevel, taskCount: 0 };
    }

    const taskCount = state.executionLevels[completedLevelIndex].length;
    return { level: completedLevel, taskCount };
}

/**
 * Find the next level index that contains at least one pending task
 */
export function findNextPendingLevelIndex(
    chain: TaskChain,
    executionLevels: UUID[][],
    startIndex: number
): number {
    for (let i = startIndex; i < executionLevels.length; i++) {
        const hasPendingTask = executionLevels[i].some(taskId => {
            const task = chain.tasks.find(t => t.id === taskId);
            return task && task.status === 'pending';
        });

        if (hasPendingTask) {
            return i;
        }
    }

    return executionLevels.length; // No pending tasks found
}

/**
 * Check if supervisor is enabled
 */
export function isSupervisorEnabled(config?: any): boolean {
    if (!config) return true; // Default enabled
    return (config as any).runSupervisorAfterLevel !== false;
}

function resolveTaskRefByIdOrName(
    chain: TaskChain,
    taskRef: string,
    refType: string
): UUID | null {
    const byId = chain.tasks.find(t => t.id === taskRef);
    if (byId) return byId.id;

    const byName = chain.tasks.find(
        t => t.name.toLowerCase() === taskRef.toLowerCase()
    );
    if (byName) {
        elizaLogger.warn(`[TaskChainSupervisor] Resolved ${refType} by name "${taskRef}" → ${byName.id}`);
        return byName.id;
    }

    return null;
}

function resolveDependencyRefs(
    chain: TaskChain,
    rawDeps: string[],
    options?: {
        branchTaskIds?: Map<number, UUID>;
    }
): { resolvedDeps: UUID[]; invalidDeps: string[] } {
    const resolvedDeps: UUID[] = [];
    const invalidDeps: string[] = [];
    const seen = new Set<UUID>();

    for (const depRef of rawDeps) {
        const branchMatch = options?.branchTaskIds
            ? depRef.match(/^branch-task-(\d+)-id$/)
            : null;
        if (branchMatch) {
            const branchIndex = Number.parseInt(branchMatch[1], 10) - 1;
            const branchTaskId = options?.branchTaskIds?.get(branchIndex);
            if (branchTaskId) {
                if (!seen.has(branchTaskId)) {
                    seen.add(branchTaskId);
                    resolvedDeps.push(branchTaskId);
                }
            } else {
                invalidDeps.push(depRef);
            }
            continue;
        }

        const resolved = resolveTaskRefByIdOrName(chain, depRef, "dependency");
        if (!resolved) {
            invalidDeps.push(depRef);
            continue;
        }

        if (!seen.has(resolved)) {
            seen.add(resolved);
            resolvedDeps.push(resolved);
        }
    }

    return { resolvedDeps, invalidDeps };
}

/**
 * Supervise chain and get LLM decision
 */
export async function superviseChain(state: SupervisorState): Promise<SupervisorModifications | null> {
    try {
        // Build context for supervisor
        const executedSummary = buildExecutedActionsSummary(state);
        const levelInfo = getCompletedLevelInfo(state);
        const fullChainSummary = buildFullChainSummary(state);
        const currentTime = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';

        const { system, prompt } = composeContextSplit({
            state: {
                ...state.state,
                currentTime,
                userRequest: state.userRequest || "User request not available",
                completedLevel: levelInfo.level,
                fullChainSummary,
                executedActionsSummary: executedSummary,
                languageInstruction: state.languageInstruction || ""
            } as any,
            template: getTaskChainSupervisorTemplate()
        });

        elizaLogger.debug("[TaskChainSupervisor] Calling supervisor LLM");

        // Call LLM for supervision decision. Pass the runtime's abort signal
        // so a user-fired Stop/Cancel mid-call aborts this LLM call
        // immediately instead of letting it run to completion. Without this,
        // the only stop check is between chain levels — so when Cancel fires
        // during the supervisor call (often the longest single LLM call in a
        // chain), the user sees activity continue for many seconds.
        const llmResponse = await generateText({
            runtime: state.runtime!,
            system,
            prompt,
            modelClass: ModelClass.MEDIUM,
            signal: state.runtime?.getAbortSignal?.()
        });

        elizaLogger.debug(`[TaskChainSupervisor] LLM response: ${llmResponse.substring(0, 200)}...`);

        // Parse JSON response
        const jsonMatch = llmResponse.match(/```json\s*([\s\S]*?)\s*```/);
        if (!jsonMatch) {
            elizaLogger.warn("[TaskChainSupervisor] No JSON found in response, keeping chain as-is");
            return null;
        }

        const parsed = JSON.parse(jsonMatch[1]) as SupervisorModifications;
        
        if (typeof parsed.decision !== 'boolean') {
            elizaLogger.warn(`[TaskChainSupervisor] Invalid decision type: ${typeof parsed.decision}, keeping chain as-is`);
            return null;
        }

        elizaLogger.info(`[TaskChainSupervisor] Decision: ${parsed.decision ? 'MODIFY' : 'CONTINUE'}`);

        return parsed;

    } catch (error: any) {
        elizaLogger.error(`[TaskChainSupervisor] Supervision failed: ${error.message}`, error);
        return null;
    }
}

/**
 * Apply supervisor modifications to the task chain
 */
export async function applySupervisionModifications(
    chain: TaskChain,
    modifications: SupervisorModifications,
    streamingCallback?: any
): Promise<{ chain: TaskChain; executionLevels: UUID[][] } | null> {
    const updatedChain = { ...chain };
    let modified = false;

    try {
        const resolver = new DefaultDependencyResolver();
        
        // Log initial state
        const initialTaskCount = chain.tasks.length;
        const initialPendingCount = chain.tasks.filter(t => t.status === 'pending').length;
        elizaLogger.info(`[TaskChainSupervisor] Before modifications: ${initialTaskCount} total tasks, ${initialPendingCount} pending`);

        // 1. Remove tasks (only pending ones)
        if (modifications.remove_task_ids && Array.isArray(modifications.remove_task_ids)) {
            const beforeCount = updatedChain.tasks.length;
            updatedChain.tasks = updatedChain.tasks.filter(task => {
                const shouldRemove = modifications.remove_task_ids!.includes(task.id) && task.status === 'pending';
                if (shouldRemove) {
                    elizaLogger.info(`[TaskChainSupervisor] Removing task: ${task.name} (${task.id.substring(0, 8)})`);
                }
                return !shouldRemove;
            });
            const removed = beforeCount - updatedChain.tasks.length;
            if (removed > 0) {
                elizaLogger.info(`[TaskChainSupervisor] Removed ${removed} pending task(s)`);
                modified = true;
            }
        }

        // 2. Add new tasks
        if (modifications.add_tasks && Array.isArray(modifications.add_tasks)) {
            for (const newTask of modifications.add_tasks) {
                const taskId = uuidv4() as UUID;
                const rawDeps = Array.isArray(newTask.dependencies) ? newTask.dependencies as string[] : [];
                const { resolvedDeps, invalidDeps } = resolveDependencyRefs(updatedChain, rawDeps);
                const taskNode: TaskNode = {
                    id: taskId,
                    name: newTask.name || "Unnamed Task",
                    description: newTask.description || "",
                    type: "action" as TaskType,
                    dependencies: resolvedDeps,
                    status: "pending" as TaskStatus,
                    inputs: [],
                    outputs: [],
                    config: {
                        actions: []
                    },
                    result: {
                        data: null,
                        metadata: {
                            startTime: Date.now(),
                            endTime: Date.now(),
                            duration: 0
                        }
                    }
                };

                if (invalidDeps.length > 0) {
                    elizaLogger.warn(`[TaskChainSupervisor] Skipping task "${newTask.name}" - invalid dependencies: ${invalidDeps.join(', ')}`);
                    continue;
                }

                updatedChain.tasks.push(taskNode);
                elizaLogger.info(`[TaskChainSupervisor] Added task: ${taskNode.name} (${taskId.substring(0, 8)})`);
                modified = true;
            }
        }

        // 2.5. Add branch (parallel tasks)
        if (modifications.add_branch && modifications.add_branch.enabled && Array.isArray(modifications.add_branch.tasks)) {
            elizaLogger.info(`[TaskChainSupervisor] Adding branch with ${modifications.add_branch.tasks.length} tasks`);
            
            const branchTaskIds = new Map<number, UUID>(); // Map index to generated task ID
            
            // First pass: create all branch tasks
            for (let i = 0; i < modifications.add_branch.tasks.length; i++) {
                const branchTask = modifications.add_branch.tasks[i];
                const taskId = uuidv4() as UUID;
                branchTaskIds.set(i, taskId);
                
                const taskNode: TaskNode = {
                    id: taskId,
                    name: branchTask.name || `Branch Task ${i + 1}`,
                    description: branchTask.description || "",
                    type: "action" as TaskType,
                    dependencies: [], // Will be set in second pass
                    status: "pending" as TaskStatus,
                    inputs: [],
                    outputs: [],
                    config: {
                        actions: []
                    },
                    result: {
                        data: null,
                        metadata: {
                            startTime: Date.now(),
                            endTime: Date.now(),
                            duration: 0
                        }
                    }
                };
                
                updatedChain.tasks.push(taskNode);
            }
            
            // Second pass: resolve dependencies
            for (let i = 0; i < modifications.add_branch.tasks.length; i++) {
                const branchTask = modifications.add_branch.tasks[i];
                const taskId = branchTaskIds.get(i)!;
                const taskIndex = updatedChain.tasks.findIndex(t => t.id === taskId);
                
                if (taskIndex === -1) continue;
                
                const rawDeps = Array.isArray(branchTask.dependencies) ? branchTask.dependencies : [];
                const { resolvedDeps, invalidDeps } = resolveDependencyRefs(updatedChain, rawDeps, { branchTaskIds });
                if (invalidDeps.length > 0) {
                    elizaLogger.warn(`[TaskChainSupervisor] Branch task "${branchTask.name}" has invalid dependencies: ${invalidDeps.join(', ')}`);
                }
                
                updatedChain.tasks[taskIndex].dependencies = resolvedDeps;
            }
            
            // Handle merge point if specified
            if (modifications.add_branch.merge_point) {
                const mergeTaskId = resolveTaskRefByIdOrName(updatedChain, modifications.add_branch.merge_point, "merge point");
                const mergeTaskIndex = mergeTaskId
                    ? updatedChain.tasks.findIndex(t => t.id === mergeTaskId)
                    : -1;
                if (mergeTaskIndex !== -1) {
                    const mergeTask = updatedChain.tasks[mergeTaskIndex];
                    // Add all branch task IDs as dependencies of the merge point
                    const allBranchTaskIds = Array.from(branchTaskIds.values());
                    updatedChain.tasks[mergeTaskIndex] = {
                        ...mergeTask,
                        dependencies: [...new Set([...mergeTask.dependencies, ...allBranchTaskIds])]
                    };
                    elizaLogger.info(`[TaskChainSupervisor] Branch will merge into task: ${mergeTask.name}`);
                } else {
                    elizaLogger.warn(`[TaskChainSupervisor] Merge point not found: ${modifications.add_branch.merge_point}`);
                }
            }
            
            elizaLogger.info(`[TaskChainSupervisor] Successfully added branch with ${branchTaskIds.size} tasks`);
            modified = true;
        }

        // 3. Change dependencies
        if (modifications.change_dependencies && Array.isArray(modifications.change_dependencies)) {
            for (const change of modifications.change_dependencies) {
                const resolvedTaskId = resolveTaskRefByIdOrName(updatedChain, change.task_id, "task_id");
                const taskIndex = resolvedTaskId
                    ? updatedChain.tasks.findIndex(t => t.id === resolvedTaskId)
                    : -1;
                if (taskIndex === -1) {
                    elizaLogger.warn(`[TaskChainSupervisor] Task not found for dependency change: ${change.task_id}`);
                    continue;
                }

                const task = updatedChain.tasks[taskIndex];
                if (task.status !== 'pending') {
                    elizaLogger.warn(`[TaskChainSupervisor] Cannot change dependencies for non-pending task: ${task.name}`);
                    continue;
                }

                const rawDeps = Array.isArray(change.new_dependencies) ? change.new_dependencies as string[] : [];
                const { resolvedDeps, invalidDeps } = resolveDependencyRefs(updatedChain, rawDeps);

                if (invalidDeps.length > 0) {
                    elizaLogger.warn(`[TaskChainSupervisor] Invalid dependencies for task "${task.name}": ${invalidDeps.join(', ')}`);
                    continue;
                }

                updatedChain.tasks[taskIndex] = {
                    ...task,
                    dependencies: resolvedDeps
                };

                elizaLogger.info(`[TaskChainSupervisor] Updated dependencies for task: ${task.name}`);
                modified = true;
            }
        }

        if (!modified) {
            elizaLogger.info("[TaskChainSupervisor] No modifications were actually applied");
            return null;
        }

        // 4. Validate the modified chain
        const validation = resolver.validateDependencies(updatedChain) as {
            isValid: boolean;
            errors: string[];
            warnings?: string[];
        };
        if (!validation.isValid) {
            elizaLogger.error(`[TaskChainSupervisor] Modified chain validation failed: ${validation.errors.join(', ')}`);
            elizaLogger.info("[TaskChainSupervisor] Discarding modifications, keeping original chain");
            return null;
        }

        if (validation.warnings && validation.warnings.length > 0) {
            elizaLogger.warn(`[TaskChainSupervisor] Chain warnings: ${validation.warnings.join(', ')}`);
        }

        // 5. Recompute execution levels
        const newExecutionLevels = resolver.getOptimalExecutionOrder(updatedChain);
        elizaLogger.info(`[TaskChainSupervisor] Recomputed execution levels: ${newExecutionLevels.length} levels`);
        
        // Log summary of modifications
        const summary: string[] = [];
        if (modifications.add_tasks && modifications.add_tasks.length > 0) {
            summary.push(`${modifications.add_tasks.length} individual task(s) added`);
        }
        if (modifications.add_branch?.enabled) {
            summary.push(`1 branch with ${modifications.add_branch.tasks.length} task(s) added`);
            if (modifications.add_branch.merge_point) {
                summary.push(`branch merges into task ${modifications.add_branch.merge_point.substring(0, 8)}`);
            }
        }
        if (modifications.remove_task_ids && modifications.remove_task_ids.length > 0) {
            summary.push(`${modifications.remove_task_ids.length} task(s) removed`);
        }
        if (modifications.change_dependencies && modifications.change_dependencies.length > 0) {
            summary.push(`${modifications.change_dependencies.length} dependency change(s)`);
        }
        if (summary.length > 0) {
            elizaLogger.info(`[TaskChainSupervisor] Modifications applied: ${summary.join(', ')}`);
        }
        
        // Log final state
        const finalTaskCount = updatedChain.tasks.length;
        const finalPendingCount = updatedChain.tasks.filter(t => t.status === 'pending').length;
        elizaLogger.info(`[TaskChainSupervisor] After modifications: ${finalTaskCount} total tasks, ${finalPendingCount} pending (${newExecutionLevels.length} execution levels)`);

        // Stream update notification if callback available
        if (streamingCallback) {
            const addedCount = (modifications.add_tasks?.length || 0) + 
                              (modifications.add_branch?.enabled ? modifications.add_branch.tasks.length : 0);
            
            streamingCallback({
                id: uuidv4(),
                name: "chain_supervision",
                status: "completed",
                message: "Task chain was modified by supervisor",
                timestamp: Date.now(),
                data: {
                    type: "chain_update",
                    modifications: {
                        added: addedCount,
                        branch_added: modifications.add_branch?.enabled || false,
                        removed: modifications.remove_task_ids?.length || 0,
                        changed: modifications.change_dependencies?.length || 0
                    }
                }
            });
        }

        return {
            chain: updatedChain,
            executionLevels: newExecutionLevels
        };

    } catch (error: any) {
        elizaLogger.error(`[TaskChainSupervisor] Error applying modifications: ${error.message}`, error);
        return null;
    }
}
