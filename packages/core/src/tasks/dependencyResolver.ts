import { elizaLogger } from "../utils/logger.ts";
import type { 
    DependencyResolver,
    TaskChain,
    TaskNode,
    UUID
} from "../core/types.ts";

/**
 * Default DependencyResolver implementation
 */
export class DefaultDependencyResolver implements DependencyResolver {
    
    /**
     * Get next tasks ready for execution
     */
    getReadyTasks(chain: TaskChain): TaskNode[] {
        const readyTasks: TaskNode[] = [];
        
        for (const task of chain.tasks) {
            if (task.status === 'pending' && this.areDependenciesSatisfied(task, chain)) {
                readyTasks.push(task);
            }
        }
        
        elizaLogger.debug(`[DependencyResolver] Found ${readyTasks.length} ready tasks: ${readyTasks.map(t => t.name).join(', ')}`);
        return readyTasks;
    }

    /**
     * Mark task as completed and update dependent tasks
     */
    markTaskCompleted(taskId: UUID, chain: TaskChain): TaskChain {
        const updatedChain = { ...chain };
        updatedChain.tasks = [...chain.tasks];
        
        // Find and update the completed task
        const taskIndex = updatedChain.tasks.findIndex(t => t.id === taskId);
        if (taskIndex === -1) {
            elizaLogger.warn(`[DependencyResolver] Task not found: ${taskId}`);
            return updatedChain;
        }
        
        updatedChain.tasks[taskIndex] = {
            ...updatedChain.tasks[taskIndex],
            status: 'completed'
        };
        
        elizaLogger.info(`[DependencyResolver] Marked task ${updatedChain.tasks[taskIndex].name} as completed`);
        
        // Log newly ready tasks
        const newlyReady = this.getReadyTasks(updatedChain);
        if (newlyReady.length > 0) {
            elizaLogger.info(`[DependencyResolver] New tasks ready: ${newlyReady.map(t => t.name).join(', ')}`);
        }
        
        return updatedChain;
    }

    /**
     * Check for circular dependencies
     */
    hasCircularDependencies(chain: TaskChain): boolean {
        const taskMap = new Map(chain.tasks.map(t => [t.id, t]));
        const visiting = new Set<UUID>();
        const visited = new Set<UUID>();

        const hasCycle = (taskId: UUID): boolean => {
            if (visiting.has(taskId)) {
                elizaLogger.error(`[DependencyResolver] Circular dependency detected at task: ${taskId}`);
                return true;
            }
            if (visited.has(taskId)) {
                return false;
            }

            visiting.add(taskId);
            const task = taskMap.get(taskId);
            
            if (task) {
                for (const depId of task.dependencies) {
                    if (hasCycle(depId)) {
                        return true;
                    }
                }
            }
            
            visiting.delete(taskId);
            visited.add(taskId);
            return false;
        };

        for (const task of chain.tasks) {
            if (hasCycle(task.id)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Get execution order for optimal performance
     */
    getOptimalExecutionOrder(chain: TaskChain): UUID[][] {
        const levels: UUID[][] = [];
        const taskLevels = this.calculateTaskLevels(chain.tasks);
        const levelMap = new Map<number, UUID[]>();

        // Group tasks by their dependency level
        for (const [taskId, level] of taskLevels) {
            if (!levelMap.has(level)) {
                levelMap.set(level, []);
            }
            levelMap.get(level)!.push(taskId);
        }

        // Sort levels and convert to array
        const sortedLevels = Array.from(levelMap.keys()).sort((a, b) => a - b);
        for (const level of sortedLevels) {
            levels.push(levelMap.get(level)!);
        }

        elizaLogger.info(`[DependencyResolver] Execution order: ${levels.length} levels`);
        levels.forEach((level, index) => {
            const taskNames = level.map(taskId => {
                const task = chain.tasks.find(t => t.id === taskId);
                return task ? task.name : taskId;
            });
            elizaLogger.debug(`[DependencyResolver] Level ${index}: ${taskNames.join(', ')}`);
        });

        return levels;
    }

    /**
     * Check if all dependencies for a task are satisfied
     */
    private areDependenciesSatisfied(task: TaskNode, chain: TaskChain): boolean {
        if (task.dependencies.length === 0) {
            return true; // No dependencies, always ready
        }

        for (const depId of task.dependencies) {
            const depTask = chain.tasks.find(t => t.id === depId);
            if (!depTask) {
                elizaLogger.warn(`[DependencyResolver] Dependency task not found: ${depId} for task ${task.name}`);
                return false;
            }
            
            if (depTask.status !== 'completed') {
                return false;
            }
        }

        return true;
    }

    /**
     * Calculate dependency levels for tasks
     */
    private calculateTaskLevels(tasks: TaskNode[]): Map<UUID, number> {
        const levels = new Map<UUID, number>();
        const taskMap = new Map(tasks.map(t => [t.id, t]));

        const calculateLevel = (taskId: UUID): number => {
            if (levels.has(taskId)) {
                return levels.get(taskId)!;
            }

            const task = taskMap.get(taskId);
            if (!task || task.dependencies.length === 0) {
                levels.set(taskId, 0);
                return 0;
            }

            const maxDepLevel = Math.max(
                ...task.dependencies.map(depId => calculateLevel(depId))
            );
            const level = maxDepLevel + 1;
            levels.set(taskId, level);
            return level;
        };

        for (const task of tasks) {
            calculateLevel(task.id);
        }

        return levels;
    }

    /**
     * Get tasks that depend on a specific task
     */
    getDependentTasks(taskId: UUID, chain: TaskChain): TaskNode[] {
        return chain.tasks.filter(task => 
            task.dependencies.includes(taskId)
        );
    }

    /**
     * Get all dependencies for a task (recursive)
     */
    getAllDependencies(taskId: UUID, chain: TaskChain): UUID[] {
        const allDeps = new Set<UUID>();
        const taskMap = new Map(chain.tasks.map(t => [t.id, t]));

        const collectDeps = (currentTaskId: UUID) => {
            const task = taskMap.get(currentTaskId);
            if (!task) return;

            for (const depId of task.dependencies) {
                if (!allDeps.has(depId)) {
                    allDeps.add(depId);
                    collectDeps(depId); // Recurse
                }
            }
        };

        collectDeps(taskId);
        return Array.from(allDeps);
    }

    /**
     * Check if one task depends on another (directly or indirectly)
     */
    doesTaskDependOn(taskId: UUID, potentialDependency: UUID, chain: TaskChain): boolean {
        const allDeps = this.getAllDependencies(taskId, chain);
        return allDeps.includes(potentialDependency);
    }

    /**
     * Get the critical path through the task chain
     */
    getCriticalPath(chain: TaskChain): UUID[] {
        const levels = this.calculateTaskLevels(chain.tasks);
        const maxLevel = Math.max(...levels.values());
        
        // Find a task at the highest level
        const endTask = chain.tasks.find(task => levels.get(task.id) === maxLevel);
        if (!endTask) return [];

        // Trace back through dependencies to find critical path
        const criticalPath: UUID[] = [];
        const taskMap = new Map(chain.tasks.map(t => [t.id, t]));

        let currentTask = endTask;
        while (currentTask) {
            criticalPath.unshift(currentTask.id);
            
            // Find the dependency with the highest level
            let nextTask: TaskNode | undefined;
            let maxDepLevel = -1;
            
            for (const depId of currentTask.dependencies) {
                const depTask = taskMap.get(depId);
                const depLevel = levels.get(depId) || 0;
                
                if (depTask && depLevel > maxDepLevel) {
                    maxDepLevel = depLevel;
                    nextTask = depTask;
                }
            }
            
            currentTask = nextTask;
        }

        elizaLogger.info(`[DependencyResolver] Critical path: ${criticalPath.length} tasks`);
        return criticalPath;
    }

    /**
     * Validate the dependency structure
     */
    validateDependencies(chain: TaskChain): { isValid: boolean; errors: string[] } {
        const errors: string[] = [];
        const taskIds = new Set(chain.tasks.map(t => t.id));

        // Check for circular dependencies
        if (this.hasCircularDependencies(chain)) {
            errors.push("Circular dependencies detected");
        }

        // Check for invalid dependency references
        for (const task of chain.tasks) {
            for (const depId of task.dependencies) {
                if (!taskIds.has(depId)) {
                    errors.push(`Task "${task.name}" references non-existent dependency: ${depId}`);
                }
            }
        }

        // Check for orphaned tasks (tasks with dependencies but no path from entry points)
        const entryTasks = chain.tasks.filter(t => t.dependencies.length === 0);
        if (entryTasks.length === 0 && chain.tasks.length > 0) {
            errors.push("No entry point tasks found (all tasks have dependencies)");
        }

        const reachableTasks = this.findReachableTasks(chain.tasks);
        for (const task of chain.tasks) {
            if (!reachableTasks.has(task.id)) {
                errors.push(`Task "${task.name}" is not reachable from any entry point`);
            }
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    /**
     * Find all tasks reachable from entry points
     */
    private findReachableTasks(tasks: TaskNode[]): Set<UUID> {
        const reachable = new Set<UUID>();
        const taskMap = new Map(tasks.map(t => [t.id, t]));

        // Start with entry tasks (no dependencies)
        const entryTasks = tasks.filter(t => t.dependencies.length === 0);
        
        const visit = (taskId: UUID) => {
            if (reachable.has(taskId)) return;
            reachable.add(taskId);
            
            // Visit all dependent tasks
            for (const task of tasks) {
                if (task.dependencies.includes(taskId)) {
                    visit(task.id);
                }
            }
        };

        for (const entryTask of entryTasks) {
            visit(entryTask.id);
        }

        return reachable;
    }
}