import type {
    Memory,
    TaskChain,
    TaskChainSnapshot,
    TaskChainTask,
    TaskChainData,
    TaskExecutionResult,
    ChainExecutionStatus,
    UUID
} from "../core/types.ts";

export type {
    TaskChainSnapshot,
    TaskChainData,
    TaskChainTask,
    TaskExecutionResult
} from "../core/types.ts";

export interface TaskChainSnapshotContext {
    chain: TaskChain;
    executionMemories?: Memory[];
    chainOutputs?: Record<string, any>;
    taskResults?: Map<UUID, any>;
    completedTaskIds?: UUID[];
    failedTaskIds?: UUID[];
    progress?: {
        completed: number;
        total: number;
        running?: string[];
        estimatedTimeRemaining?: number;
    };
    executionStatus?: ChainExecutionStatus;
    startedAt?: number;
    finishedAt?: number;
}

/**
 * Convert a TaskChain to TaskChainData for real-time UI updates (e.g. after supervisor modifications).
 * Lightweight conversion without execution memories or full snapshot context.
 */
export function chainToTaskChainData(chain: TaskChain): TaskChainData {
    const tasks: TaskChainTask[] = chain.tasks.map(task => {
        const status = task.status || "pending";
        const hasResult = Boolean(task.result?.data);
        const isSuccess = status === "completed";
        return {
            id: task.id,
            name: task.name,
            description: task.description,
            type: (task.type === "action" ? "action" : "llm") as TaskChainTask["type"],
            status: status as TaskChainTask["status"],
            dependencies: task.dependencies ?? [],
            hasResult,
            isSuccess
        };
    });
    return {
        id: chain.id,
        name: chain.name,
        description: chain.description,
        originalRequest: chain.originalRequest,
        tasks
    };
}

export function generateTaskChainSnapshot(context: TaskChainSnapshotContext): TaskChainSnapshot {
    const {
        chain,
        executionMemories = [],
        chainOutputs = {},
        taskResults,
        completedTaskIds,
        failedTaskIds,
        progress,
        executionStatus,
        startedAt,
        finishedAt
    } = context;

    const memoryByTaskId = new Map<string, Memory>();
    for (const memory of executionMemories) {
        const metadata = (memory.content?.metadata as any) || {};
        if (metadata.taskId) {
            memoryByTaskId.set(metadata.taskId, memory);
        }
    }

    const taskResultById = new Map<string, any>();
    if (taskResults) {
        for (const [taskId, result] of taskResults.entries()) {
            taskResultById.set(String(taskId), result);
        }
    }

    const tasks: TaskChainTask[] = chain.tasks.map(task => {
        const taskId = String(task.id);
        const memory = memoryByTaskId.get(taskId);
        const formatted = taskResultById.get(taskId) || {};
        const chainOutput = chainOutputs[task.name];

        // Prioritize completedTaskIds/failedTaskIds over task.status to handle DB restoration
        const derivedStatus = failedTaskIds?.includes(task.id) ? "failed"
            : completedTaskIds?.includes(task.id) ? "completed"
            : task.status || "pending";

        const hasResult = Boolean(
            task.result?.data
            || formatted?.output
            || formatted?.raw
            || chainOutput
            || memory
        );
        const isSuccess = derivedStatus === "completed" || formatted?.success === true;

        const startTime = task.result?.metadata?.startTime
            ?? formatted?.metadata?.startTime
            ?? (memory?.content?.metadata as any)?.startTime
            ?? undefined;

        const endTime = task.result?.metadata?.endTime
            ?? formatted?.metadata?.endTime
            ?? (memory?.content?.metadata as any)?.endTime
            ?? (isSuccess ? Date.now() : undefined);

        const errorMessage = task.result?.metadata?.error?.message
            ?? formatted?.metadata?.error?.message
            ?? (memory?.content?.error as any)?.message
            ?? (typeof chainOutput?.error === "string" ? chainOutput.error : chainOutput?.error?.message)
            ?? undefined;

        return {
            id: task.id,
            name: task.name,
            description: task.description,
            type: task.type === "action" ? "action" : "llm",
            status: (derivedStatus || "pending") as TaskChainTask["status"],
            dependencies: task.dependencies ?? [],
            hasResult,
            isSuccess,
            executionResult: memory,
            startTime,
            endTime,
            error: errorMessage
        } satisfies TaskChainTask;
    });

    const totalTasks = tasks.length;
    const completedTasks = tasks.filter(task => task.status === "completed").length;
    const failedTasks = tasks.filter(task => task.status === "failed").length;
    const pendingTasks = tasks.filter(task => task.status === "pending").length;
    const runningTasks = tasks.filter(task => task.status === "running").length;

    let overallStatus: TaskChainSnapshot["completionInfo"]["overallStatus"];
    if (runningTasks > 0) {
        overallStatus = "running";
    } else if (completedTasks === totalTasks && totalTasks > 0) {
        overallStatus = "completed";
    } else if (failedTasks > 0 && completedTasks > 0) {
        overallStatus = "partial";
    } else if (failedTasks > 0) {
        overallStatus = "failed";
    } else {
        overallStatus = "running";
    }

    const overallProgress = progress?.total
        ? (progress.total === 0 ? 0 : progress.completed / progress.total)
        : (totalTasks === 0 ? 0 : completedTasks / totalTasks);

    const executionResults: TaskExecutionResult[] = tasks
        .filter(task => task.status === "completed" || task.status === "failed")
        .map(task => ({
            taskId: task.id,
            taskName: task.name,
            type: task.type,
            status: task.status === "failed" ? "failed" : "completed",
            executionTime: task.startTime && task.endTime ? Math.max(task.endTime - task.startTime, 0) : 0,
            result: task.executionResult,
            error: task.error
        }));

    const taskChainData: TaskChainData = {
        id: chain.id,
        name: chain.name,
        description: chain.description,
        originalRequest: chain.originalRequest,
        tasks
    };

    return {
        taskChainData,
        executionResults,
        completionInfo: {
            totalTasks,
            completedTasks,
            failedTasks,
            pendingTasks,
            overallStatus,
            overallProgress
        },
        title: chain.name || "Task Chain",
        createdAt: finishedAt ?? executionStatus?.lastUpdate ?? startedAt ?? Date.now()
    } satisfies TaskChainSnapshot;
}

export function isTaskChainMemory(memory: Memory): boolean {
    const source = memory.content?.source;
    return source === "task_chain_planning"
        || source === "task_chain_action"
        || source === "task_chain_summary";
}

export function extractTaskChainMemories(memories: Memory[]): {
    planningMemory?: Memory;
    actionMemories: Memory[];
    summaryMemory?: Memory;
} {
    const planningMemory = memories.find(m => m.content?.source === "task_chain_planning");
    const actionMemories = memories.filter(m => m.content?.source === "task_chain_action");
    const summaryMemory = memories.find(m => m.content?.source === "task_chain_summary");

    return {
        planningMemory,
        actionMemories,
        summaryMemory
    };
}

export function extractInitialTaskChainData(planningMemory: Memory): TaskChainData | null {
    try {
        const metadata = planningMemory.content?.metadata as any;
        if (!metadata?.taskChain) {
            return null;
        }

        return metadata.taskChain as TaskChainData;
    } catch (error) {
        console.error("[TaskChainSnapshot] Failed to extract initial task chain data:", error);
        return null;
    }
}
