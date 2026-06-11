import type React from 'react';
import { useState, useMemo, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';
import { Badge } from "@/components/ui/badge";
import { CheckCircle, XCircle, Loader2, Circle, Clock, Brain, Zap, X, Ban } from "lucide-react";
import type { ChainUpdateData, TaskChainData, TaskUpdateData } from './TaskChainBubble';
import { TaskChainTOC } from './TaskChainTOC';
import { TableOfContents } from './TableOfContents';
import type { ContentWithUser } from './chat/types';
import type { FavoriteTaskChainsApi } from '@/hooks/useFavoriteTaskChains';
import { cn } from "@/lib/utils";
import { getMessageChartPaths } from './chat/message-utils';
import { useTranslation } from 'react-i18next';
import { useTableOfContents } from '@/contexts/TableOfContentsContext';

interface TaskChainTabsProps {
    taskChainData: TaskChainData; // The task chain metadata from the planning message
    messages: ContentWithUser[]; // All AI response messages in this conversation
    renderMessage: (message: ContentWithUser, index: number, isPartOfComprehensiveAnalysis?: boolean) => React.ReactNode; // Function to render individual messages
    chainUpdates?: ChainUpdateData[]; // Array of chain structure updates
    taskUpdates?: TaskUpdateData[]; // Array of task status updates
    selectedTaskId?: string | null;
    onTaskSelect?: (taskId: string | null) => void;
    favoritesApi?: FavoriteTaskChainsApi;
    deletedFiles?: ReadonlySet<string>;
}

export interface TaskChainTabsRef {
    selectTaskForChart: (chartPath: string) => Promise<boolean>;
}

interface TaskGroup {
    taskId: string;
    taskName: string;
    taskType: 'llm' | 'action';
    status: 'pending' | 'running' | 'completed' | 'failed';
    messages: ContentWithUser[];
}

const getTaskStatusIcon = (status: string) => {
    switch (status) {
        case 'completed':
            return <CheckCircle className="size-4 text-green-500" />;
        case 'failed':
            return <XCircle className="size-4 text-red-500" />;
        case 'running':
            return <Loader2 className="size-4 text-blue-500 animate-spin" />;
        case 'cancelled':
            return <Ban className="size-4 text-amber-500" />;
        case 'pending':
            return <Circle className="size-4 text-gray-400" />;
        default:
            return <Circle className="size-4 text-gray-400" />;
    }
};

const getTaskTypeIcon = (type: string) => {
    switch (type) {
        case 'action':
            return <Zap className="size-4 text-amber-500" />;
        case 'llm':
            return <Brain className="size-4 text-purple-500" />;
        default:
            return <Circle className="size-4 text-gray-500" />;
    }
};

export const TaskChainTabs = forwardRef<TaskChainTabsRef, TaskChainTabsProps>(({
    taskChainData,
    messages,
    renderMessage,
    chainUpdates = [],
    taskUpdates = [],
    selectedTaskId: selectedTaskIdProp,
    onTaskSelect,
    favoritesApi: _favoritesApi,
    deletedFiles = new Set()
}, ref) => {
    const { t } = useTranslation();
    const { closeMobile: closeMobileToc, isMobileOpen: isMobileTocOpen } =
        useTableOfContents();
    const [currentTaskChainData, setCurrentTaskChainData] = useState(taskChainData);
    const [uncontrolledSelectedTaskId, setUncontrolledSelectedTaskId] = useState<string | null>(null);
    const isControlled = selectedTaskIdProp !== undefined;
    const selectedTaskId = isControlled ? selectedTaskIdProp ?? null : uncontrolledSelectedTaskId;

    const setSelectedTaskId = useCallback((taskId: string | null) => {
        if (!isControlled) {
            setUncontrolledSelectedTaskId(taskId);
        }
        onTaskSelect?.(taskId);
    }, [isControlled, onTaskSelect]);

    const handleTaskNavClick = useCallback(
        (taskId: string) => {
            setSelectedTaskId(taskId);
            if (isMobileTocOpen) {
                closeMobileToc();
            }
        },
        [closeMobileToc, isMobileTocOpen, setSelectedTaskId],
    );
    // Update current task chain data when prop changes
    useEffect(() => {
        setCurrentTaskChainData(taskChainData);
    }, [taskChainData]);

    // Apply chain updates when they come in
    useEffect(() => {
        if (chainUpdates.length > 0 && taskChainData) {
            const relevantChainUpdates = chainUpdates.filter(update => update.chainId === taskChainData.id);
            
            if (relevantChainUpdates.length > 0) {
                // Apply the most recent chain update
                const latestChainUpdate = relevantChainUpdates[relevantChainUpdates.length - 1];
                console.log(`📋 TaskChainTabs: Applying chain update for chain ${taskChainData.id}:`, latestChainUpdate);
                
                setCurrentTaskChainData(latestChainUpdate.updatedChain);
                
                console.log(`✅ TaskChainTabs: Updated chain data with ${latestChainUpdate.updatedChain.tasks.length} tasks`);
            }
        }
    }, [chainUpdates, taskChainData]);

    const taskIdsSignature = useMemo(() => {
        return currentTaskChainData?.tasks?.map((task) => task.id).join("|") ?? "";
    }, [currentTaskChainData?.tasks]);

    /** Default to first task when nothing valid is selected. Parent passes explicit
     *  `null` to mean the user intentionally collapsed details (do not resurrect). */
    useEffect(() => {
        const tasks = currentTaskChainData?.tasks ?? [];
        if (tasks.length === 0) {
            return;
        }

        const validTaskIds = new Set(tasks.map((task) => task.id));

        // Controlled + explicit cleared (user tapped X): keep placeholder.
        if (isControlled && selectedTaskIdProp === null) {
            return;
        }

        const hasValidSelection =
            typeof selectedTaskId === "string" && validTaskIds.has(selectedTaskId);
        if (hasValidSelection) {
            return;
        }

        const firstTaskId = tasks[0]?.id ?? null;
        if (firstTaskId && selectedTaskId !== firstTaskId) {
            setSelectedTaskId(firstTaskId);
        }
    }, [
        currentTaskChainData?.id,
        taskIdsSignature,
        selectedTaskId,
        selectedTaskIdProp,
        isControlled,
        setSelectedTaskId,
    ]);

    // Apply task updates to keep statuses in sync with streaming events
    useEffect(() => {
        if (!currentTaskChainData || taskUpdates.length === 0) {
            return;
        }

        const relevantUpdates = taskUpdates.filter(update => update.chainId === currentTaskChainData.id);
        if (relevantUpdates.length === 0) {
            return;
        }

        const latestUpdateByTask = new Map<string, TaskUpdateData>();
        relevantUpdates.forEach((update) => {
            const existing = latestUpdateByTask.get(update.taskId);
            if (!existing || update.timestamp >= existing.timestamp) {
                latestUpdateByTask.set(update.taskId, update);
            }
        });

        setCurrentTaskChainData(prev => {
            if (!prev) return prev;

            let didChange = false;
            const updatedTasks = prev.tasks.map(task => {
                const update = latestUpdateByTask.get(task.id);
                if (!update) return task;

                const nextStatus = update.status;
                const nextIsSuccess = update.status === "completed";
                if (task.status === nextStatus && task.isSuccess === nextIsSuccess) {
                    return task;
                }

                didChange = true;
                return {
                    ...task,
                    status: nextStatus,
                    isSuccess: nextIsSuccess
                };
            });

            return didChange ? { ...prev, tasks: updatedTasks } : prev;
        });
    }, [taskUpdates, currentTaskChainData?.id, taskIdsSignature]);

    // Expose methods to parent component via ref
    useImperativeHandle(ref, () => ({
        selectTaskForChart: async (chartPath: string): Promise<boolean> => {
            console.log('🔍 [TaskChainTabs] Searching for chart:', chartPath);

            // Extract filename from chart path for comparison
            const targetFileName = chartPath.split('/').pop()?.split('\\').pop();

            // Search through all messages to find which task contains this chart
            for (const message of messages) {
                // Get chart paths from this message
                const messageCharts = getMessageChartPaths(
                    message as any,
                    deletedFiles
                );

                // Check if this message contains the target chart
                const hasChart = messageCharts.some(msgChart => {
                    if (msgChart === chartPath) return true;

                    // Also check by filename
                    if (targetFileName) {
                        const msgFileName = msgChart.split('/').pop()?.split('\\').pop();
                        return msgFileName === targetFileName;
                    }
                    return false;
                });

                if (hasChart) {
                    // Get the taskId from message metadata
                    const metadata = (message as any)?.content?.metadata ?? (message as any)?.metadata;
                    const taskId = metadata?.taskId;

                    if (taskId) {
                        console.log('✅ [TaskChainTabs] Found chart in task:', taskId);

                        // Set the selection state
                        handleTaskNavClick(taskId);

                        // Wait for React to render the DOM elements
                        await new Promise(resolve => {
                            // Use requestAnimationFrame to wait for the next paint
                            requestAnimationFrame(() => {
                                // Wait one more frame to ensure charts are rendered
                                requestAnimationFrame(() => {
                                    setTimeout(resolve, 100); // Additional small delay for chart iframe loading
                                });
                            });
                        });

                        return true;
                    }
                }
            }

            console.log('❌ [TaskChainTabs] Chart not found in any task');
            return false;
        }
    }), [messages, deletedFiles, handleTaskNavClick]);

    // Group messages by task
    const taskGroups = useMemo(() => {
        if (!currentTaskChainData || !messages) return [];

        const groups = new Map<string, TaskGroup>();
        
        // Initialize groups from task chain data
        currentTaskChainData.tasks?.forEach((task: any) => {
            groups.set(task.id, {
                taskId: task.id,
                taskName: task.name,
                taskType: task.type || 'llm',
                status: task.status || 'pending',
                messages: []
            });
        });

        // Enhanced validation: track which tasks have actual messages
        const tasksWithMessages = new Set<string>();

        // Group messages by their taskId
        messages.forEach((message) => {
            const metadata = (message as any)?.content?.metadata ?? (message as any)?.metadata;
            
            if (metadata?.taskId && groups.has(metadata.taskId)) {
                const group = groups.get(metadata.taskId)!;
                group.messages.push(message);
                tasksWithMessages.add(metadata.taskId);
                
                // Update status based on message content
                if (metadata.success === true) {
                    group.status = 'completed';
                } else if (message.error || metadata.success === false) {
                    group.status = 'failed';
                } else if (message.isLoading) {
                    group.status = 'running';
                }
            }
        });

        // Log validation information about missing task messages
        const allTasks = Array.from(groups.keys());
        const tasksWithoutMessages = allTasks.filter(taskId => !tasksWithMessages.has(taskId));
        
        if (tasksWithoutMessages.length > 0) {
            const tasksWithoutMessagesNames = tasksWithoutMessages.map(taskId => {
                const task = currentTaskChainData.tasks.find((t: any) => t.id === taskId);
                return task ? task.name : taskId;
            });
            
            console.warn('⚠️ [TaskChainTabs] Tasks without messages:', {
                count: tasksWithoutMessages.length,
                taskNames: tasksWithoutMessagesNames,
                totalTasks: allTasks.length
            });
        }

        return Array.from(groups.values());
    }, [currentTaskChainData, messages]);





    if (!taskChainData || taskGroups.length === 0) {
        return null;
    }

    const selectedGroup = selectedTaskId ? taskGroups.find(g => g.taskId === selectedTaskId) : null;

    return (
        <div className="w-full max-w-full min-w-0">
            {/*
              Two-column layout: keep Task Navigation visually fixed while the user
              jumps between headings. TableOfContents uses element.closest(".overflow-
              y-auto") — without an inner scroll region, that matches ChatMessageList
              and scrolling yanks the whole bubble (sidebar included). The right pane
              is therefore the nearest scroll ancestor for in-task heading anchors.
            */}
            <div className="flex flex-col lg:flex-row lg:items-stretch lg:gap-4">
                <div className="lg:flex-[1] lg:min-w-0 shrink-0 lg:max-w-sm lg:self-start">
                    <TableOfContents
                        className="mb-4 lg:mb-0 lg:sticky lg:top-[4.5rem] lg:z-[5] lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto lg:pr-2 lg:overscroll-y-contain"
                        title={t('progress.taskNavigation')}
                        messages={selectedGroup?.messages ?? []}
                        taskNames={
                            currentTaskChainData.tasks
                                ?.flatMap((t: any) => [t.name, t.title, t.displayName].filter(Boolean))
                                ?? []
                        }
                        beforeNavContent={(variant: "desktop" | "mobile") => (
                            <TaskChainTOC
                                chainName={currentTaskChainData.name}
                                tasks={(currentTaskChainData.tasks ?? []).map(
                                    (task: {
                                        id: string;
                                        name: string;
                                        status?: string;
                                    }) => ({
                                        id: task.id,
                                        name: task.name,
                                        status: task.status ?? "pending",
                                    }),
                                )}
                                selectedTaskId={selectedTaskId}
                                onTaskClick={handleTaskNavClick}
                                onSummaryClick={() => {
                                    const firstId = currentTaskChainData.tasks?.[0]?.id;
                                    if (firstId) {
                                        handleTaskNavClick(firstId);
                                    }
                                }}
                                unstyled
                                className={cn(
                                    "space-y-2",
                                    variant === "desktop" &&
                                        "max-h-[calc(100vh-220px)] overflow-y-auto pr-1 custom-scrollbar",
                                )}
                            />
                        )}
                    />
                </div>

                {/* Task Details — inner scroll so TOC clicks do not scroll the whole chat */}
                <div className="w-full min-w-0 lg:flex-[3] lg:min-h-0 lg:border-l lg:pl-4 flex flex-col">
                    {!selectedGroup ? (
                        // No task selected - show placeholder
                        <div className="flex flex-col items-center justify-center min-h-[280px] lg:min-h-[360px] text-center text-muted-foreground py-12">
                            <Circle className="size-16 mx-auto mb-4 opacity-30" />
                            <div className="text-base font-medium mb-2">{t('progress.noTaskSelected')}</div>
                            <div className="text-sm">{t('progress.noTaskSelectedDescription')}</div>
                        </div>
                    ) : (
                        // Task selected — scoped region for Share → image export / copy (current node only)
                        <div
                            className={cn(
                                "flex flex-col min-h-0 flex-1",
                                "lg:max-h-[min(36rem,calc(100vh-11rem))] xl:max-h-[min(42rem,calc(100vh-10rem))]",
                                "lg:overflow-y-auto lg:overscroll-y-contain custom-scrollbar",
                            )}
                            data-share-focused-export="true"
                            data-share-focus-key={selectedGroup.taskId}
                        >
                            {/* Task Header — sticky to this pane’s top on tablet+ only.
                                On mobile (<md) it stays inline so it scrolls away with
                                the task content rather than overlapping the text. */}
                            <div className="pb-4 flex items-center gap-3 p-4 rounded-lg border border-slate-300 dark:border-white/20 bg-white/50 dark:bg-white/10 backdrop-blur-md shadow-sm md:sticky md:top-0 md:z-10">
                                    <div className="flex items-center gap-2">
                                        {getTaskTypeIcon(selectedGroup.taskType)}
                                        {getTaskStatusIcon(selectedGroup.status)}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-lg font-semibold text-foreground">
                                            {selectedGroup.taskName}
                                        </div>
                                        <div className="text-sm text-muted-foreground">
                                            {t('progress.messagesCount', { count: selectedGroup.messages.length })}
                                        </div>
                                    </div>
                                    <Badge
                                        variant={selectedGroup.status === 'completed' ? 'default' : 'secondary'}
                                        className={selectedGroup.status === 'completed'
                                            ? 'backdrop-blur-md bg-white/40 dark:bg-white/20 border border-white/50 dark:border-white/30 text-foreground'
                                            : ''
                                        }
                                    >
                                        {t(`progress.status.${selectedGroup.status}`)}
                                    </Badge>
                                    <button
                                        type="button"
                                        onClick={() => setSelectedTaskId(null)}
                                        className="p-1 hover:bg-muted rounded transition-colors"
                                        aria-label={t('progress.closeTaskDetails')}
                                    >
                                        <X className="size-4" />
                                    </button>
                            </div>

                            {/* Task Messages */}
                            <div className="space-y-3 pb-2">
                                {selectedGroup.messages.length > 0 ? (
                                    selectedGroup.messages.map((message, index) => renderMessage(message, index, false))
                                ) : (
                                    <div className="text-center py-12 text-muted-foreground border rounded-lg">
                                        <Clock className="size-12 mx-auto mb-3 opacity-50" />
                                        <div className="text-base font-medium">{t('progress.noMessagesYet')}</div>
                                        <div className="text-sm">{t('progress.noMessagesYetDescription')}</div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
});

TaskChainTabs.displayName = 'TaskChainTabs';
