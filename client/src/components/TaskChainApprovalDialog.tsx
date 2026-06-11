import type React from 'react';
import { useState, useEffect, useRef } from 'react';
import { CheckCircle, XCircle, AlertCircle, ArrowRight, List, Network, Loader2 } from 'lucide-react';

const TASK_CHAIN_AUTO_APPROVE_TIMEOUT_MS = 60_000;
import { cn } from '@/lib/utils';
import type { TaskChainData } from './TaskChainBubble';
import { TaskChainGraph } from './TaskChainGraph';
import type { FavoriteTaskChainsApi } from '@/hooks/useFavoriteTaskChains';
import { useTranslation } from 'react-i18next';

export interface TaskChainApprovalDialogProps {
    isOpen: boolean;
    taskChain: TaskChainData;
    onApprove: () => void;
    onReject: (feedback: string) => void;
    onClose: () => void;
    /**
     * Fired when the user clicks the Cancel button. Distinct from `onClose`
     * (which only hides the dialog): the parent should use this to abort the
     * in-flight SSE stream and clear pending state, otherwise the auto-approve
     * timer at the server can still fire and the chain will execute.
     */
    onCancel?: () => void;
    isRegenerating?: boolean; // New prop to indicate regeneration in progress
    favoritesApi?: FavoriteTaskChainsApi;
}

export const TaskChainApprovalDialog: React.FC<TaskChainApprovalDialogProps> = ({
    isOpen,
    taskChain,
    onApprove,
    onReject,
    onClose,
    onCancel,
    isRegenerating = false,
    favoritesApi,
}) => {
    const { t } = useTranslation();
    const [feedback, setFeedback] = useState('');
    const [showFeedbackInput, setShowFeedbackInput] = useState(false);
    const [viewMode, setViewMode] = useState<'list' | 'graph'>('graph'); // Default to graph view
    const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
    const [countdown, setCountdown] = useState(TASK_CHAIN_AUTO_APPROVE_TIMEOUT_MS / 1000);
    const onApproveRef = useRef(onApprove);
    useEffect(() => { onApproveRef.current = onApprove; }, [onApprove]);

    useEffect(() => {
        if (!isOpen || isRegenerating) {
            setCountdown(TASK_CHAIN_AUTO_APPROVE_TIMEOUT_MS / 1000);
            return;
        }
        setCountdown(TASK_CHAIN_AUTO_APPROVE_TIMEOUT_MS / 1000);
        const interval = setInterval(() => {
            setCountdown(prev => Math.max(0, prev - 1));
        }, 1000);
        return () => clearInterval(interval);
    }, [isOpen, isRegenerating]);

    useEffect(() => {
        if (countdown === 0 && isOpen && !isRegenerating) {
            onApproveRef.current();
        }
    }, [countdown, isOpen, isRegenerating]);

    if (!isOpen) return null;

    const handleApprove = () => {
        onApprove();
        setFeedback('');
        setShowFeedbackInput(false);
    };

    const handleReject = () => {
        if (!showFeedbackInput) {
            setShowFeedbackInput(true);
            return;
        }

        if (!feedback.trim()) {
            window.alert(t('taskChains.approvalFeedbackRequired'));
            return;
        }

        onReject(feedback);
        setFeedback('');
        setShowFeedbackInput(false);
    };

    const handleCancel = () => {
        setFeedback('');
        setShowFeedbackInput(false);
        // Tell the parent to abort the in-flight SSE stream and clear pending
        // state. Without this the dialog merely hides while the server
        // auto-approves after 60s and the chain runs anyway.
        onCancel?.();
        onClose();
    };

    const getDependencyNames = (dependencies: string[]) => {
        return dependencies
            .map(depId => taskChain.tasks.find(t => t.id === depId)?.name || depId)
            .join(', ');
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Backdrop - Click disabled to force explicit user decision */}
            <div
                className="absolute inset-0 bg-black/50 backdrop-blur-sm pointer-events-none"
            />

            {/* Dialog */}
            <div className="relative z-10 w-full max-w-3xl max-h-[90vh] bg-background rounded-lg shadow-2xl border border-border overflow-hidden flex flex-col pointer-events-auto">
                {/* Header */}
                <div className="p-6 border-b border-border bg-gradient-to-r from-blue-50 to-purple-50 dark:from-blue-950/20 dark:to-purple-950/20">
                    <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
                        <AlertCircle className="size-5 text-blue-500" />
                        {t('taskChains.reviewTitle')}
                    </h2>
                    <p className="text-xs text-muted-foreground mt-1">
                        {t('taskChains.reviewDescription')}
                    </p>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                    {/* Regenerating State */}
                    {isRegenerating ? (
                        <div className="flex flex-col items-center justify-center py-12 space-y-4">
                            <Loader2 className="size-12 text-primary animate-spin" />
                            <div className="text-center space-y-2">
                                <h3 className="text-lg font-semibold text-foreground">
                                    {t('taskChains.regeneratingTitle')}
                                </h3>
                                <p className="text-sm text-muted-foreground max-w-md">
                                    {t('taskChains.regeneratingDescription')}
                                </p>
                            </div>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground mt-4">
                                <div className="flex gap-1">
                                    <div className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                                    <div className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                                    <div className="w-2 h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                                </div>
                            </div>
                        </div>
                    ) : (
                        <>
                            {/* Chain Info */}
                            <div>
                                <h3 className="text-base font-semibold text-foreground mb-2">
                                    {taskChain.name}
                                </h3>
                        {taskChain.description && (
                            <p className="text-xs text-muted-foreground italic">
                                {taskChain.description}
                            </p>
                        )}
                        {taskChain.originalRequest && (
                            <div className="mt-3 p-3 bg-muted/30 rounded-md border border-muted">
                                <p className="text-xs font-medium text-muted-foreground mb-1">
                                    {t('taskChains.originalRequest')}
                                </p>
                                <p className="text-sm text-foreground">
                                    "{taskChain.originalRequest}"
                                </p>
                            </div>
                        )}
                    </div>

                    {/* View Mode Toggle */}
                    <div className="flex items-center justify-between border-b border-border pb-3">
                        <h4 className="text-sm font-semibold text-foreground">
                            {t('taskChains.plannedTasks', { count: taskChain.tasks.length })}
                        </h4>
                        <div className="flex gap-1 bg-muted/30 rounded-md p-1">
                            <button
                                onClick={() => setViewMode('graph')}
                                className={cn(
                                    "px-3 py-1.5 rounded text-sm font-medium transition-all flex items-center gap-1.5",
                                    viewMode === 'graph'
                                        ? "bg-primary text-primary-foreground shadow-sm"
                                        : "text-muted-foreground hover:text-foreground"
                                )}
                            >
                                <Network className="size-4" />
                                {t('taskChains.graph')}
                            </button>
                            <button
                                onClick={() => setViewMode('list')}
                                className={cn(
                                    "px-3 py-1.5 rounded text-sm font-medium transition-all flex items-center gap-1.5",
                                    viewMode === 'list'
                                        ? "bg-primary text-primary-foreground shadow-sm"
                                        : "text-muted-foreground hover:text-foreground"
                                )}
                            >
                                <List className="size-4" />
                                {t('taskChains.list')}
                            </button>
                        </div>
                    </div>

                    {/* Graph View */}
                    {viewMode === 'graph' && (
                        <>
                            {!selectedTaskId ? (
                                <TaskChainGraph
                                    taskChain={taskChain}
                                    favoritesApi={favoritesApi}
                                    onTaskClick={(taskId) => setSelectedTaskId(taskId)}
                                />
                            ) : (() => {
                                const selectedTask = taskChain.tasks.find(t => t.id === selectedTaskId);
                                if (!selectedTask) return null;

                                return (
                                    <div className="space-y-4">
                                        {/* Header with back button */}
                                        <div className="flex items-center gap-3 pb-3 border-b">
                                            <button
                                                onClick={() => setSelectedTaskId(null)}
                                                className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                                            >
                                                <ArrowRight className="size-4 rotate-180" />
                                                {t('taskChains.backToGraph')}
                                            </button>
                                        </div>

                                        {/* Task Details */}
                                        <div className="border rounded-lg overflow-hidden">
                                            <div className="flex items-center justify-between p-4 bg-muted/20 border-b">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-base font-semibold text-foreground">
                                                        {selectedTask.name}
                                                    </span>
                                                    {selectedTask.type && (
                                                        <span className="text-xs px-2 py-1 rounded bg-primary/10 text-primary font-medium">
                                                            {selectedTask.type.toUpperCase()}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="p-4 space-y-4">
                                                <div>
                                                    <div className="text-xs font-medium text-muted-foreground mb-2">
                                                        {t('taskChains.descriptionLabel')}
                                                    </div>
                                                    <p className="text-xs text-foreground">{selectedTask.description}</p>
                                                </div>

                                                {selectedTask.dependencies.length > 0 && (
                                                    <div>
                                                        <div className="text-xs font-medium text-muted-foreground mb-2">
                                                            {t('taskChains.dependenciesLabel')}
                                                        </div>
                                                        <div className="flex flex-wrap gap-2">
                                                            {selectedTask.dependencies.map(depId => {
                                                                const depTask = taskChain.tasks.find(t => t.id === depId);
                                                                return (
                                                                    <span key={depId} className="px-2 py-1 bg-muted rounded-md text-xs border">
                                                                        {depTask?.name || depId}
                                                                    </span>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })()}
                        </>
                    )}

                    {/* List View */}
                    {viewMode === 'list' && (
                        <div className="space-y-3">
                            {taskChain.tasks.map((task, index) => (
                                <div
                                    key={task.id}
                                    className="p-3 bg-card rounded-md border border-border hover:border-primary/50 transition-colors"
                                >
                                    <div className="flex items-start gap-3">
                                        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-primary font-semibold text-xs">
                                            {index + 1}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <h5 className="text-sm font-medium text-foreground mb-1">
                                                {task.name}
                                            </h5>
                                            <p className="text-xs text-muted-foreground mb-2">
                                                {task.description}
                                            </p>
                                            {task.dependencies.length > 0 && (
                                                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                                    <ArrowRight className="size-3 flex-shrink-0" />
                                                    <span>
                                                        {t('taskChains.dependsOn', { dependencies: getDependencyNames(task.dependencies) })}
                                                    </span>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                            {/* Feedback Input */}
                            {showFeedbackInput && (
                                <div className="mt-6 p-4 bg-red-50 dark:bg-red-950/20 rounded-md border border-red-200 dark:border-red-800">
                                    <label className="block text-sm font-medium text-foreground mb-2">
                                        {t('taskChains.feedbackLabel')}
                                    </label>
                                    <textarea
                                        value={feedback}
                                        onChange={(e) => setFeedback(e.target.value)}
                                        className="w-full min-h-[100px] p-3 bg-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary text-foreground resize-y"
                                        placeholder={t('taskChains.approvalPlaceholder')}
                                        autoFocus
                                    />
                                    <p className="text-xs text-muted-foreground mt-2">
                                        {t('taskChains.feedbackHint')}
                                    </p>
                                </div>
                            )}
                        </>
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between gap-3 p-6 border-t border-border bg-muted/30">
                    <div className="text-sm text-muted-foreground">
                        {isRegenerating ? (
                            <span className="flex items-center gap-2">
                                <Loader2 className="size-4 animate-spin" />
                                {t('taskChains.regeneratingFooter')}
                            </span>
                        ) : countdown > 0 ? (
                            <span className="text-xs">Auto-approving in {countdown}s...</span>
                        ) : null}
                    </div>
                    <div className="flex gap-3">
                        <button
                            onClick={handleCancel}
                            disabled={isRegenerating}
                            className={cn(
                                "px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground border border-border rounded-md hover:bg-muted transition-colors",
                                isRegenerating && "opacity-50 cursor-not-allowed"
                            )}
                        >
                            {t('common.cancel')}
                        </button>
                        <button
                            onClick={handleReject}
                            disabled={isRegenerating}
                            className={cn(
                                "px-4 py-2 text-sm font-medium rounded-md transition-colors flex items-center gap-2",
                                "bg-red-600 text-white hover:bg-red-700",
                                isRegenerating && "opacity-50 cursor-not-allowed"
                            )}
                        >
                            <XCircle className="size-4" />
                            {showFeedbackInput ? t('taskChains.submitFeedbackAndRegenerate') : t('taskChains.rejectAndProvideFeedback')}
                        </button>
                        <button
                            onClick={handleApprove}
                            disabled={isRegenerating}
                            className={cn(
                                "px-4 py-2 text-sm font-medium bg-green-600 text-white hover:bg-green-700 rounded-md transition-colors flex items-center gap-2",
                                isRegenerating && "opacity-50 cursor-not-allowed"
                            )}
                        >
                            <CheckCircle className="size-4" />
                            {t('taskChains.approve')}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
