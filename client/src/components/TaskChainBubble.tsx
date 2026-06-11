import { useTranslation } from "react-i18next";
import type React from 'react';
import { useState, useEffect } from 'react';
import { Link, CheckCircle, XCircle, Loader2, Circle, ArrowRight, Star, Ban } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FavoriteTaskChainsApi } from '@/hooks/useFavoriteTaskChains';
import { useToast } from '@/hooks/use-toast';
import { useSubscriptionTier } from '@/hooks/useSubscriptionTier';
import { Badge } from '@/components/ui/badge';

export interface TaskChainData {
    id: string;
    name: string;
    description: string;
    originalRequest?: string;
    tasks: Array<{
        id: string;
        name: string;
        description: string;
        type: 'llm' | 'action';
        status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
        dependencies: string[];
        hasResult: boolean;
        isSuccess: boolean;
    }>;
}

export interface TaskUpdateData {
    type: 'task_update';
    chainId: string;
    taskId: string;
    taskName: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    timestamp: number;
    error?: string;
}

export interface TaskRemovalData {
    type: 'task_removal';
    chainId: string;
    taskId: string;
    taskName: string;
    reason: string;
    timestamp: number;
}

export interface ChainUpdateData {
    type: 'chain_update';
    chainId: string;
    reason: 'refinement' | 'modification' | 'addition' | 'task_removal';
    updatedChain: TaskChainData;
    timestamp: number;
    changedTaskIds?: string[]; // IDs of tasks that were added/modified
    removedTaskId?: string; // ID of task that was removed
    removedTaskName?: string; // Name of task that was removed
}

interface TaskChainBubbleProps {
    favoritesApi?: FavoriteTaskChainsApi;
    taskChain: TaskChainData;
    isComplete: boolean;
    className?: string;
    taskUpdates?: TaskUpdateData[]; // Array of task updates to apply
    chainUpdates?: ChainUpdateData[]; // Array of chain structure updates
    defaultCollapsed?: boolean;
}

const getTaskIcon = (status: string) => {
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

const getTaskColor = (status: string) => {
    switch (status) {
        case 'completed':
            return 'text-green-600 dark:text-green-400';
        case 'failed':
            return 'text-red-600 dark:text-red-400';
        case 'running':
            return 'text-blue-600 dark:text-blue-400';
        case 'cancelled':
            return 'text-amber-600 dark:text-amber-400';
        case 'pending':
            return 'text-gray-500 dark:text-gray-400';
        default:
            return 'text-gray-500 dark:text-gray-400';
    }
};

export const TaskChainBubble: React.FC<TaskChainBubbleProps> = ({
    favoritesApi,
    taskChain,
    isComplete,
    className,
    taskUpdates = [],
    chainUpdates = [],
    defaultCollapsed = true
}) => {
    const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
    const [currentTasks, setCurrentTasks] = useState(taskChain?.tasks || []);
    const [currentChainData, setCurrentChainData] = useState(taskChain);

    const { toast } = useToast();
    const { tier } = useSubscriptionTier();
    const { t } = useTranslation();
    const isProUser = tier === 'pro';
    const isCurrentlyFavorite = taskChain && favoritesApi ? favoritesApi.isFavorite(taskChain.id) : false;
    const derivedIsComplete = currentTasks.length > 0 && currentTasks.every(
        task => task.status === "completed" || task.status === "failed"
    );
    const isChainComplete = isComplete || derivedIsComplete;

    const handleToggleFavorite = async (e: React.MouseEvent) => {
        e.stopPropagation();

        if (!taskChain || !favoritesApi) return;

        try {
            if (isCurrentlyFavorite) {
                // Remove from favorites
                const favorite = favoritesApi.getFavoriteByChainId(taskChain.id);
                if (favorite) {
                    await favoritesApi.removeFavorite(favorite.favoriteId);
                    toast({
                        title: t("taskChains.removedTitle"),
                        description: t("taskChains.removedDescription", { name: taskChain.name }),
                    });
                }
            } else {
                // Add to favorites
                const favorite = await favoritesApi.addFavorite(taskChain);
                if (favorite) {
                    toast({
                        title: t("taskChains.addedTitle"),
                        description: t("taskChains.addedDescription", { name: favorite.name }),
                    });
                } else {
                    toast({
                        title: t("taskChains.favoriteFailedTitle"),
                        description: t("taskChains.favoriteFailedDescription"),
                        variant: "destructive",
                    });
                }
            }
        } catch (error) {
            console.error('Failed to toggle favorite task chain:', error);
            toast({
                title: t("taskChains.favoriteUpdateFailedTitle"),
                description: t("taskChains.favoriteUpdateFailedDescription"),
                variant: "destructive",
            });
        }
    };

    // Update local task statuses when taskChain prop changes (initial load)
    useEffect(() => {
        if (taskChain?.tasks) {
            setCurrentTasks(taskChain.tasks);
            setCurrentChainData(taskChain);
        }
    }, [taskChain?.tasks]);

    // Apply chain updates when they come in (chain structure changes)
    useEffect(() => {
        if (chainUpdates.length > 0 && taskChain) {
            const relevantChainUpdates = chainUpdates.filter(update => update.chainId === taskChain.id);
            
            if (relevantChainUpdates.length > 0) {
                // Apply the most recent chain update
                const latestChainUpdate = relevantChainUpdates[relevantChainUpdates.length - 1];
                console.log(`🔗 TaskChainBubble: Applying chain update for chain ${taskChain.id}:`, latestChainUpdate);
                
                if (latestChainUpdate.reason === 'task_removal' && latestChainUpdate.removedTaskId) {
                    console.log(`🗑️ TaskChainBubble: Removing task ${latestChainUpdate.removedTaskName} (${latestChainUpdate.removedTaskId}) from chain`);
                }
                
                setCurrentChainData(latestChainUpdate.updatedChain);
                setCurrentTasks(latestChainUpdate.updatedChain.tasks);
                
                console.log(`✅ TaskChainBubble: Updated chain structure with ${latestChainUpdate.updatedChain.tasks.length} tasks`);
            }
        }
    }, [chainUpdates, taskChain]);

    // Apply task updates when they come in
    useEffect(() => {
        if (taskUpdates.length > 0 && taskChain) {
            // Apply all relevant task updates for this chain
            const relevantUpdates = taskUpdates.filter(update => update.chainId === taskChain.id);
            
            if (relevantUpdates.length > 0) {
                console.log(`🔗 TaskChainBubble: Applying ${relevantUpdates.length} updates for chain ${taskChain.id}:`, relevantUpdates);
                setCurrentTasks(prevTasks => {
                    let updatedTasks = [...prevTasks];
                    
                    relevantUpdates.forEach(update => {
                        console.log(`🔄 TaskChainBubble: Updating task ${update.taskName} from ? to ${update.status}`);
                        updatedTasks = updatedTasks.map(task => 
                            task.id === update.taskId 
                                ? { ...task, status: update.status, isSuccess: update.status === 'completed' }
                                : task
                        );
                    });
                    
                    console.log(`✅ TaskChainBubble: Updated tasks:`, updatedTasks.map(t => `${t.name}: ${t.status}`));
                    return updatedTasks;
                });
            }
        }
    }, [taskUpdates, taskChain]);

    if (!taskChain || !currentTasks || currentTasks.length === 0) {
        return null;
    }

    const completedTasks = currentTasks.filter(t => t.status === 'completed').length;
    const failedTasks = currentTasks.filter(t => t.status === 'failed').length;
    const runningTasks = currentTasks.filter(t => t.status === 'running').length;
    const pendingTasks = currentTasks.filter(t => t.status === 'pending').length;
    const totalTasks = currentTasks.length;
    const progress = totalTasks > 0 ? ((completedTasks + failedTasks) / totalTasks) * 100 : 0;
    const finishedTasks = completedTasks + failedTasks;
    const progressPercentage = Math.round(progress);
    const progressLabel = isChainComplete ? 'Complete' : runningTasks > 0 ? 'Running' : 'Planning';

    // Find dependencies for display
    const taskMap = new Map(currentTasks.map(t => [t.id, t]));
    const getDependencyNames = (dependencies: string[]) => {
        return dependencies.map(depId => taskMap.get(depId)?.name || depId).join(', ');
    };

    const rawChainName = (currentChainData?.name || taskChain.name || "").trim();
    const chainTitle = rawChainName.toLowerCase().startsWith("task chain:")
        ? rawChainName
        : `Task Chain: ${rawChainName}`;

    return (
        <div
            className={cn(
                "rounded-2xl mb-3 max-w-full transition-all duration-300",
                "shadow-md dark:shadow-[0_18px_38px_rgba(15,23,42,0.55)]",
                isCollapsed && "cursor-pointer",
                isProUser ? "p-[2px]" : "border border-slate-200 dark:border-white/10",
                className
            )}
            style={isProUser ? {
                background: 'linear-gradient(135deg, #FF9DB0 0%, #D89FD8 50%, #A8C5E8 100%)',
            } : undefined}
        >
            <div
                className={cn(
                    "backdrop-blur-2xl p-4 overflow-hidden transition-colors duration-200",
                    isProUser ? "rounded-[14px]" : "rounded-2xl",
                    "bg-white/95 dark:bg-slate-900/95",
                    "supports-[backdrop-filter]:bg-white/95 supports-[backdrop-filter]:dark:bg-slate-900/95",
                    isCollapsed && "hover:bg-slate-50/95 dark:hover:bg-slate-800/95"
                )}
	            >
	            {/* Header */}
		            <div className="flex items-center justify-between gap-4 mb-3">
		                <button
		                    type="button"
		                    className="min-w-0 text-left"
		                    onClick={() => setIsCollapsed(!isCollapsed)}
		                >
		                    <div className="flex items-center gap-2 min-w-0">
		                        <Link className="size-4 flex-shrink-0 text-muted-foreground" />
		                        <h3 className="text-lg font-semibold text-foreground truncate">
		                            {chainTitle}
		                        </h3>
		                    </div>
		                    <p className="text-sm text-muted-foreground">
		                        {totalTasks} tasks • {completedTasks}/{totalTasks} tasks completed
		                        {failedTasks > 0 ? ` • ${failedTasks} failed` : ""}
	                    </p>
	                </button>
	                <div className="flex items-center gap-2 flex-shrink-0">
	                    {/* Favorite Button - only show when chain has fully completed */}
		                    {isChainComplete && favoritesApi && (
		                        <button
		                            onClick={handleToggleFavorite}
		                            className="p-1 rounded-md border border-transparent hover:border-white/30 hover:bg-white/10 transition-colors backdrop-blur-sm"
		                            title={isCurrentlyFavorite ? "Remove from favorites" : "Add to favorites"}
		                        >
	                            <Star
	                                className={cn(
	                                    "size-4 transition-colors",
	                                    isCurrentlyFavorite
	                                        ? "fill-yellow-500 text-yellow-500"
	                                        : "text-muted-foreground hover:text-yellow-500"
	                                )}
	                            />
	                        </button>
	                    )}
	                    {(runningTasks + pendingTasks) > 0 && (
	                        <Badge variant="secondary" className="text-xs">
	                            <Loader2 className="size-3 mr-1 animate-spin" />
	                            {runningTasks + pendingTasks} pending
	                        </Badge>
	                    )}
	                    {completedTasks > 0 && (
	                        <Badge variant="default" className="text-xs bg-green-600">
	                            <CheckCircle className="size-3 mr-1" />
	                            {completedTasks} completed
	                        </Badge>
	                    )}
	                    {failedTasks > 0 && (
	                        <Badge variant="destructive" className="text-xs">
	                            <XCircle className="size-3 mr-1" />
	                            {failedTasks} failed
	                        </Badge>
	                    )}
	                </div>
	            </div>

            {/* Description */}
            {!isCollapsed && (currentChainData?.description || taskChain.description) && (
                <div className="text-base text-foreground mb-3 overflow-hidden max-w-full">
                    <div className="break-words" style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                        📝 {currentChainData?.description || taskChain.description}
                    </div>
                </div>
            )}

            {/* Original Request - Hidden per user request */}
            {/* {!isCollapsed && (currentChainData?.originalRequest || taskChain.originalRequest) && (
                <div className="text-xs text-muted-foreground/80 mb-3 p-2 bg-muted/20 rounded border">
                    <span className="font-medium">{t("taskChains.request")}</span> "{currentChainData?.originalRequest || taskChain.originalRequest}"
                </div>
            )} */}

	            {/* Progress bar */}
	            {!isCollapsed && (
	                <div className="mb-4 max-w-full overflow-hidden">
	                    <div className="flex items-center gap-3 max-w-full min-w-0 overflow-x-auto">
	                        <div className="flex items-center gap-2 min-w-0 sm:min-w-[200px] flex-shrink-0">
	                            <div className="flex-1 rounded-full h-2 overflow-hidden bg-slate-200 dark:bg-white/10">
	                                <div
	                                    className={cn(
	                                        "h-full transition-all duration-500",
	                                        !isProUser && "bg-gradient-to-r from-emerald-400 via-sky-400 to-blue-500"
	                                    )}
	                                    style={{
	                                        width: `${progressPercentage}%`,
	                                        ...(isProUser && {
	                                            background: 'linear-gradient(135deg, #FF9DB0 0%, #D89FD8 50%, #A8C5E8 100%)'
	                                        })
	                                    }}
	                                />
	                            </div>
	                            <span className="text-xs font-medium text-foreground/70 whitespace-nowrap">
	                                {progressPercentage}%
	                            </span>
	                        </div>

	                        <div className="flex items-center gap-1 flex-shrink-0">
	                            <div
	                                className={cn(
	                                    "w-2 h-2 rounded-full transition-colors",
	                                    isChainComplete ? "bg-green-500" : "bg-emerald-400 animate-pulse"
	                                )}
	                            />
	                            <span className={cn(
	                                "ml-1 text-xs font-medium whitespace-nowrap",
	                                isChainComplete ? "text-green-600 dark:text-green-400" : "text-emerald-500"
	                            )}>
	                                {progressLabel}
	                            </span>
	                        </div>

	                        <Badge
	                            variant="outline"
	                            className="text-xs flex-shrink-0 border-slate-300 dark:border-white/30 bg-slate-100 dark:bg-white/10 text-foreground/80 backdrop-blur-sm"
	                        >
	                            {finishedTasks}/{totalTasks} tasks
	                        </Badge>
	                    </div>
	                </div>
	            )}

            {/* Tasks List */}
            {!isCollapsed && (
                <div className="space-y-3 max-w-full overflow-hidden">
                    <div className="text-sm font-semibold text-foreground mb-2">
                        Tasks ({totalTasks}):
                    </div>

                    {currentTasks.map((task) => (
                        <div key={task.id} className="flex items-start gap-3 p-3 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 backdrop-blur-md overflow-hidden max-w-full shadow-sm">
                            <div className="mt-0.5 flex-shrink-0">{getTaskIcon(task.status)}</div>

                            <div className="flex-1 min-w-0 overflow-hidden">
                                <div className="flex items-center gap-2 mb-1 overflow-hidden">
                                    <span className={cn("text-lg font-medium truncate", getTaskColor(task.status))}>
                                        {task.name}
                                    </span>
                                </div>

                                <div className="text-base text-foreground mb-1 break-words" style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                                    {task.description}
                                </div>

                                {task.dependencies.length > 0 && (
                                    <div className="text-xs text-muted-foreground/80 flex items-start gap-1 overflow-hidden">
                                        <ArrowRight className="size-3 flex-shrink-0 mt-0.5" />
                                        <span className="break-words" style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}>depends on: {getDependencyNames(task.dependencies)}</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}

	            </div>
	        </div>
	    );
	};
