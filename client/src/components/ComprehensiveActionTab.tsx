import type React from 'react';
import { useState, useMemo, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';
import { flushSync } from 'react-dom';
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ComprehensiveTOC } from './ComprehensiveTOC';
import { TableOfContents } from "./TableOfContents";
import { CheckCircle, XCircle, Loader2, Circle, Zap, BarChart3, Database, TrendingUp, FileText, ExternalLink } from "lucide-react";
import {
    ChatBubble,
    ChatBubbleMessage,
    ChatBubbleTimestamp,
} from "@/components/ui/chat/chat-bubble";
import { Avatar, AvatarImage } from "./ui/avatar";
import { cn, moment } from "@/lib/utils";
import CopyButton from "./copy-button";
import ChatTtsButton from "./ui/chat/chat-tts-button";
import { MarkdownRenderer } from "./MarkdownRenderer";
import type { UUID } from "@elizaos/core";
import type { IAttachment } from "@/types";
import { useTheme } from "@/contexts/ThemeContext";
import { useSubscriptionTier } from "@/hooks/useSubscriptionTier";
import { useToast } from "@/hooks/use-toast";
import { ChartEmbed } from "./ChartEmbed";
import { apiClient } from "@/lib/api";
import { getChartId, getMessageChartPaths, parseMessageWithCharts } from "./chat/message-utils";
import type { ContentWithUser } from "./chat/types";
import { useTranslation } from "react-i18next";
import { useTableOfContents } from "../contexts/TableOfContentsContext";
import { useNavigate } from "react-router-dom";

// Markdown container class - simplified since styling is now handled by MarkdownRenderer
const MARKDOWN_CONTAINER_CLASSES = "";

interface ComprehensiveActionResult {
    action: string;
    phase: string;
    status: 'success' | 'failed' | 'pending';
    content: string;
    summary?: string;
    message?: {
        id: string;
        text: string;
        createdAt: number;
        source?: string;
        attachments?: IAttachment[];
        metadata?: any;
        error?: any;
    };
}

interface ComprehensiveActionTabProps {
    actionResults: ComprehensiveActionResult[];
    title?: string;
    agentId: UUID;
    deletedFiles: ReadonlySet<string>;
    /** When set, only respond to share-export prep for this room (avoids wrong tab in multi-room UIs). */
    shareExportRoomId?: string;
}

export interface ComprehensiveActionTabRef {
    selectPhaseAndActionForChart: (chartPath: string) => Promise<boolean>;
}

const getPhaseIcon = (phase: string) => {
    switch (phase) {
        case 'data_gathering':
            return <Database className="size-4 text-blue-500" />;
        case 'analysis':
            return <BarChart3 className="size-4 text-purple-500" />;
        case 'prediction':
            return <TrendingUp className="size-4 text-green-500" />;
        default:
            return <Zap className="size-4 text-amber-500" />;
    }
};

const getStatusIcon = (status: string) => {
    switch (status) {
        case 'success':
            return <CheckCircle className="size-4 text-green-500" />;
        case 'failed':
            return <XCircle className="size-4 text-red-500" />;
        case 'pending':
            return <Loader2 className="size-4 text-blue-500 animate-spin" />;
        default:
            return <Circle className="size-4 text-gray-400" />;
    }
};

const formatActionName = (actionName: string): string => {
    return actionName
        .replace(/_/g, ' ')  // Replace underscores with spaces
        .replace(/([a-z])([A-Z])/g, '$1 $2')  // Add space between lowercase and uppercase (camelCase)
        .trim()
        .split(' ')
        .filter(word => word.length > 0)  // Remove empty words
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
};

const getPhaseLabel = (phase: string, t: (key: string) => unknown): string => {
    switch (phase) {
        case 'data_gathering':
            return String(t('progress.phase.dataCollection'));
        case 'analysis':
            return String(t('progress.phase.analysis'));
        case 'prediction':
            return String(t('progress.phase.prediction'));
        case 'writing_report':
            return String(t('progress.phase.writingReport'));
        default:
            return String(t('progress.phase.processing'));
    }
};

const formatSourceName = (source: string | undefined | null, t: (key: string) => unknown): string => {
    if (!source) return '';
    
    switch (source) {
        case 'regular_message':
            return String(t('chat.sources.regularMessage'));
        case 'comprehensive_analysis':
            return String(t('chat.sources.comprehensiveAnalysis'));
        case 'task_chain_action':
            return String(t('chat.sources.taskChain'));
        case 'task_chain_planning':
            return String(t('chat.sources.taskPlanning'));
        case 'direct':
            return ''; // Hide direct source (legacy)
        default:
            // Clean up any remaining handler references and format nicely
            return source
                .replace(/_handler|_action/g, '')
                .replace(/_/g, ' ')
                .replace(/\b\w/g, l => l.toUpperCase());
    }
};

// Progress Bar Component
const ProgressBar: React.FC<{
    currentPhase: string;
    overallProgress: number;
    completedActions: number;
    totalExpectedActions: number;
    isProUser: boolean;
    t: (key: string, options?: Record<string, unknown>) => unknown;
}> = ({ currentPhase, overallProgress, completedActions, totalExpectedActions, isProUser, t }) => {
    const progressPercentage = Math.round(overallProgress * 100);

    const getPhaseSteps = () => {
        return [
            { key: 'data_gathering', label: String(t('progress.phase.dataCollection')), active: currentPhase === 'data_gathering' },
            { key: 'analysis', label: String(t('progress.phase.analysis')), active: currentPhase === 'analysis' },
            { key: 'prediction', label: String(t('progress.phase.prediction')), active: currentPhase === 'prediction' },
            { key: 'writing_report', label: String(t('progress.phase.writingReport')), active: currentPhase === 'writing_report' }
        ];
    };

    return (
        <div className="flex items-center gap-3 max-w-full min-w-0 overflow-x-auto">
            {/* Progress bar */}
            <div className="flex items-center gap-2 min-w-0 sm:min-w-[200px] flex-shrink-0">
                <div className="flex-1 rounded-full h-2 overflow-hidden bg-slate-200 dark:bg-white/10">
                    <div
                        className={cn(
                            "h-full transition-all duration-500",
                            !isProUser && "bg-gradient-to-r from-blue-500 via-purple-500 to-green-500"
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

            {/* Current phase indicator */}
            <div className="flex items-center gap-1 flex-shrink-0">
                {getPhaseSteps().map((step) => (
                    <div key={step.key} className="flex items-center">
                        <div className={`w-2 h-2 rounded-full transition-colors ${
                            step.active ? 'bg-emerald-400 animate-pulse' : 'bg-slate-300 dark:bg-white/25'
                        }`} />
                        {step.active && (
                            <span className="ml-1 text-xs font-medium text-emerald-500 whitespace-nowrap">
                                {step.label}
                            </span>
                        )}
                    </div>
                ))}
            </div>

            {/* Action count */}
            <Badge
                variant="outline"
                className="text-xs flex-shrink-0 border-slate-300 dark:border-white/30 bg-slate-100 dark:bg-white/10 text-foreground/80 backdrop-blur-sm"
            >
                {t('progress.completedActionsCount', { completed: completedActions, total: totalExpectedActions }) as string}
            </Badge>
        </div>
    );
};

export const ComprehensiveActionTab = forwardRef<ComprehensiveActionTabRef, ComprehensiveActionTabProps>(({
    actionResults,
    title,
    agentId,
    deletedFiles,
    shareExportRoomId,
}, ref) => {
    const { t } = useTranslation();
    const { theme } = useTheme();
    const { tier } = useSubscriptionTier();
    const { toast } = useToast();
    const navigate = useNavigate();
    const isProUser = tier === 'pro';
    const agentIconSrc = theme === "light" ? "/sentiedge-icon.jpg" : "/sentiedge-icon.png";
    const [selectedPhase, setSelectedPhase] = useState<string | null>(null);
    const [selectedAction, setSelectedAction] = useState<string | null>(null);
    const resolvedTitle = title ?? String(t('chat.comprehensiveAnalysis'));
    const { closeMobile: closeMobileToc, isMobileOpen: isMobileTocOpen } = useTableOfContents();

    // Always open the comprehensive-analysis report through the same
    // sectioned/TOC viewer the daily scheduler uses
    // (`/report/daily?source=ondemand&...`). The viewer fetches the HTML from
    // `/reports/Reports/<fileName>`, which is served from local `saved_data`.
    // saveReport writes a `localCachePath` copy even when the report is also
    // uploaded to S3, so the local fetch is always authoritative. We
    // intentionally ignore any S3 `reportUrl` here — sending users to the raw
    // S3 file would skip the TOC/section layout and look inconsistent with
    // the daily reports.
    const openReport = useCallback(async (reportPath: string, reportUrl?: string) => {
        const fileName = reportPath.split(/[\\/]/).pop() || '';
        if (!fileName) {
            toast({
                variant: 'destructive',
                title: t('chat.openReportFailedTitle'),
                description: t('chat.reportUnavailableDescription'),
            });
            return;
        }

        // Check if local file is available first. If not, fall back to the S3
        // proxy URL stored at report-generation time so the viewer still works
        // after a container redeploy (local saved_data is ephemeral, S3 is not).
        const localHeadUrl = apiClient.getReportUrl(reportPath);
        let localAvailable = false;
        try {
            const resp = await fetch(localHeadUrl, { method: 'HEAD' });
            localAvailable = resp.ok;
        } catch {
            localAvailable = false;
        }

        // reportUrl is the S3 proxy path (e.g. /s3-files/reports/…/file.html).
        const s3Available = !localAvailable && typeof reportUrl === 'string' && reportUrl.startsWith('/s3-files/');

        if (!localAvailable && !s3Available) {
            toast({
                variant: 'destructive',
                title: t('chat.openReportFailedTitle'),
                description: t('chat.reportUnavailableDescription'),
            });
            return;
        }

        const params = new URLSearchParams({ source: 'ondemand', fileName });
        if (s3Available && reportUrl) {
            params.set('reportUrl', reportUrl);
        }
        const viewerPath = `/report/daily?${params.toString()}`;
        // Capture the chat URL we're navigating from so the report's back button
        // can return to this chat instead of falling through to the landing page.
        const origin = `${window.location.pathname}${window.location.search}`;
        navigate(viewerPath, { state: { fromPath: origin } });
    }, [t, toast, navigate]);

    // Group actions by phase for better organization
    const actionsByPhase = useMemo(() => {
        const phases = new Map<string, ComprehensiveActionResult[]>();

        actionResults.forEach(action => {
            const phase = action.phase || 'other';
            if (!phases.has(phase)) {
                phases.set(phase, []);
            }
            phases.get(phase)?.push(action);
        });

        return phases;
    }, [actionResults]);

    // Expose methods to parent component via ref
    useImperativeHandle(ref, () => ({
        selectPhaseAndActionForChart: async (chartPath: string): Promise<boolean> => {
            console.log('🔍 [ComprehensiveActionTab] Searching for chart:', chartPath);

            // Extract filename from chart path for comparison
            const targetFileName = chartPath.split('/').pop()?.split('\\').pop();

            // Search through all actions to find which one contains this chart
            for (const action of actionResults) {
                const message = action.message;
                if (!message) continue;

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
                    console.log('✅ [ComprehensiveActionTab] Found chart in action:', {
                        phase: action.phase,
                        action: action.action
                    });

                    // Set the selection state
                    setSelectedPhase(action.phase);
                    setSelectedAction(action.action);

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

            console.log('❌ [ComprehensiveActionTab] Chart not found in any action');
            return false;
        }
    }), [actionResults, deletedFiles]);

    // Bootstrap first phase + action so opening a conversation never lands on empty content.
    // Skips once the user selects anything (handles phase clicks that clear action intentionally).
    useEffect(() => {
        if (
            actionResults.length === 0 ||
            selectedPhase != null ||
            selectedAction != null
        ) {
            return;
        }
        const pick =
            actionResults.find((r) => r.phase != null && r.action != null && r.action !== "") ??
            actionResults[0];
        if (!pick?.phase || !pick?.action) {
            return;
        }
        setSelectedPhase(pick.phase);
        setSelectedAction(pick.action);
    }, [actionResults, selectedPhase, selectedAction]);

    // Calculate progress based on comprehensive analysis phases
    const progressInfo = useMemo(() => {
        // Define the expected action counts per phase (based on comprehensiveAnalysisHandler.ts)
        const EXPECTED_ACTIONS = {
            // Must match COMPREHENSIVE_ANALYSIS_ACTIONS phases in
            // packages/core/src/handlers/comprehensiveAnalysisWorkflowGraph.ts
            data_gathering: 7,
            analysis: 4,
            prediction: 1,
            writing_report: 1,
        };
        
        const totalExpectedActions = Object.values(EXPECTED_ACTIONS).reduce((sum, count) => sum + count, 0); // Total includes the writing_report phase
        const rawCompletedActions = actionResults.filter(a => a.status === 'success').length;
        const hasFailedOrPending = actionResults.some(
            a => a.status === 'failed' || a.status === 'pending'
        );
        const reportSuccess = actionResults.some(
            a => a.phase === 'writing_report' && a.status === 'success'
        );
        // When the writing_report row is present and successful and nothing else failed,
        // the analysis is fully done. Legacy snapshots can be short of `totalExpectedActions`
        // because empty-content rows used to be filtered server-side; surface the configured
        // total so the "X/Y" badge does not appear stuck at "12/13" on a successful run.
        const completedActions =
            reportSuccess && !hasFailedOrPending
                ? Math.max(rawCompletedActions, totalExpectedActions)
                : rawCompletedActions;
        
        // Calculate current phase and progress
        let currentPhase = 'data_gathering';
        let phaseProgress = 0;
        let overallProgress = 0;
        
        const dataGatheringCompleted = actionResults.filter(a => a.phase === 'data_gathering' && a.status === 'success').length;
        const analysisCompleted = actionResults.filter(a => a.phase === 'analysis' && a.status === 'success').length;
        const predictionCompleted = actionResults.filter(a => a.phase === 'prediction' && a.status === 'success').length;
        const reportCompleted = actionResults.filter(a => a.phase === 'writing_report' && a.status === 'success').length;
        
        // Debug logging for report generation progress
        if (actionResults.some(a => a.phase === 'writing_report')) {
            console.log('📊 [Progress] Writing report phase actions:', {
                total: actionResults.filter(a => a.phase === 'writing_report').length,
                completed: reportCompleted,
                actions: actionResults.filter(a => a.phase === 'writing_report').map(a => ({ 
                    action: a.action, 
                    status: a.status,
                    phase: a.phase
                }))
            });
        }
        
        if (reportCompleted > 0) {
            // Report has been generated - comprehensive analysis is 100% complete
            currentPhase = 'writing_report';
            phaseProgress = 1.0; // Report generation completed
            overallProgress = 1.0; // 100% only when report is actually generated
            console.log('🎉 [Progress] Report completed! Progress: 100%', { reportCompleted, totalActions: actionResults.length });
        } else if (dataGatheringCompleted >= EXPECTED_ACTIONS.data_gathering && 
                   analysisCompleted >= EXPECTED_ACTIONS.analysis && 
                   predictionCompleted >= EXPECTED_ACTIONS.prediction) {
            // All tool actions completed, now in "writing report" phase but not finished yet
            currentPhase = 'writing_report';
            phaseProgress = 0.0; // Report generation in progress but not completed
            overallProgress = (EXPECTED_ACTIONS.data_gathering + EXPECTED_ACTIONS.analysis + EXPECTED_ACTIONS.prediction) / totalExpectedActions; // ~92%
            console.log('📝 [Progress] In writing_report phase, waiting for report completion', { overallProgress: Math.round(overallProgress * 100) + '%' });
        } else if (predictionCompleted > 0 || (dataGatheringCompleted >= EXPECTED_ACTIONS.data_gathering && analysisCompleted >= EXPECTED_ACTIONS.analysis)) {
            // In prediction phase
            currentPhase = 'prediction';
            phaseProgress = predictionCompleted / EXPECTED_ACTIONS.prediction;
            overallProgress = (EXPECTED_ACTIONS.data_gathering + EXPECTED_ACTIONS.analysis + predictionCompleted) / totalExpectedActions;
        } else if (analysisCompleted > 0 || dataGatheringCompleted >= EXPECTED_ACTIONS.data_gathering) {
            // In analysis phase
            currentPhase = 'analysis';
            phaseProgress = analysisCompleted / EXPECTED_ACTIONS.analysis;
            overallProgress = (EXPECTED_ACTIONS.data_gathering + analysisCompleted) / totalExpectedActions;
        } else {
            // In data gathering phase
            currentPhase = 'data_gathering';
            phaseProgress = dataGatheringCompleted / EXPECTED_ACTIONS.data_gathering;
            overallProgress = dataGatheringCompleted / totalExpectedActions;
        }
        
        return {
            currentPhase,
            phaseProgress,
            overallProgress: Math.min(overallProgress, 1), // Cap at 100%
            completedActions,
            totalExpectedActions,
            phaseStats: {
                data_gathering: { completed: dataGatheringCompleted, total: EXPECTED_ACTIONS.data_gathering },
                analysis: { completed: analysisCompleted, total: EXPECTED_ACTIONS.analysis },
                prediction: { completed: predictionCompleted, total: EXPECTED_ACTIONS.prediction },
                writing_report: { completed: reportCompleted, total: EXPECTED_ACTIONS.writing_report }
            }
        };
    }, [actionResults]);

    // Calculate statistics
    const completedActions = actionResults.filter(a => a.status === 'success').length;
    const failedActions = actionResults.filter(a => a.status === 'failed').length;
    const pendingActions = actionResults.filter(a => a.status === 'pending').length;

    // Handle phase click. On mobile the TOC is rendered inside a drawer
    // overlay; close it on selection so the user can see the rendered content
    // (otherwise the overlay stays on top and the new content is invisible).
    const handlePhaseClick = (phase: string) => {
        setSelectedPhase(phase);
        setSelectedAction(null);
        if (isMobileTocOpen) closeMobileToc();
    };

    // Handle action click
    const handleActionClick = (phase: string, action: string) => {
        setSelectedPhase(phase);
        setSelectedAction(action);
        if (isMobileTocOpen) closeMobileToc();
    };

    // Get selected content
    const selectedContent = useMemo(() => {
        if (!selectedPhase) {
            return null;
        }

        if (selectedAction) {
            // Show specific action
            return actionResults.filter(a => a.phase === selectedPhase && a.action === selectedAction);
        } else {
            // Show all actions in phase
            return actionResults.filter(a => a.phase === selectedPhase);
        }
    }, [selectedPhase, selectedAction, actionResults]);

    // Capture phase runs before chat.tsx so we select phase/action (and mount ChartEmbed) before the DOM snapshot.
    useEffect(() => {
        const onPrepareShareExport = (ev: Event): void => {
            const ce = ev as CustomEvent<{ roomId?: string }>;
            const targetRoom = ce.detail?.roomId;
            if (
                targetRoom !== undefined &&
                shareExportRoomId !== undefined &&
                String(targetRoom) !== String(shareExportRoomId)
            ) {
                return;
            }
            if (actionResults.length === 0) return;
            flushSync(() => {
                const withChart = actionResults.find((ar) => {
                    if (!ar.message) return false;
                    const paths = getMessageChartPaths(ar.message as unknown as ContentWithUser, deletedFiles);
                    return paths.length > 0;
                });
                const pick = withChart ?? actionResults[0];
                if (!pick) return;
                setSelectedPhase(pick.phase);
                setSelectedAction(pick.action);
            });
        };
        window.addEventListener("sentiedge:prepare-share-export", onPrepareShareExport, true);
        return () =>
            window.removeEventListener("sentiedge:prepare-share-export", onPrepareShareExport, true);
    }, [actionResults, deletedFiles, shareExportRoomId]);

    if (actionResults.length === 0) {
        return null;
    }

    return (
        <div className="w-full max-w-full min-w-0 space-y-5">
            {/* Header Section with glassmorphism */}
            <div
                className={cn(
                    "rounded-2xl backdrop-blur-2xl max-w-full transition-all duration-300",
                    "shadow-md dark:shadow-[0_18px_40px_rgba(15,23,42,0.6)]",
                    isProUser ? "p-[2px]" : "border border-slate-200 dark:border-white/10"
                )}
                style={isProUser ? {
                    background: 'linear-gradient(135deg, #FF9DB0 0%, #D89FD8 50%, #A8C5E8 100%)',
                } : undefined}
            >
            <div className={cn(
                "backdrop-blur-2xl p-5 min-w-0",
                isProUser ? "rounded-[14px]" : "rounded-2xl",
                "bg-white/95 dark:bg-slate-900/95",
                "supports-[backdrop-filter]:bg-white/95 supports-[backdrop-filter]:dark:bg-slate-900/95"
            )}>
                <div className="flex items-center justify-between mb-3">
                    <div>
                        <h3 className="text-lg font-semibold text-foreground">{resolvedTitle}</h3>
                        <p className="text-sm text-muted-foreground">
                            {t('progress.analysisSummary', {
                                actionCount: actionResults.length,
                                phaseCount: actionsByPhase.size,
                                completedCount: completedActions,
                            })}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        {pendingActions > 0 && (
                            <Badge variant="secondary" className="text-xs">
                                <Loader2 className="size-3 mr-1 animate-spin" />
                                {t('progress.pendingCount', { count: pendingActions })}
                            </Badge>
                        )}
                        {completedActions > 0 && (
                            <Badge variant="default" className="text-xs bg-green-600">
                                <CheckCircle className="size-3 mr-1" />
                                {t('progress.completedCount', { count: completedActions })}
                            </Badge>
                        )}
                        {failedActions > 0 && (
                            <Badge variant="destructive" className="text-xs">
                                <XCircle className="size-3 mr-1" />
                                {t('progress.failedCount', { count: failedActions })}
                            </Badge>
                        )}
                    </div>
                </div>

                {/* Progress Bar Section */}
                {actionResults.length > 0 && (
                    <div className="mt-4 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 backdrop-blur-md p-4">
                        <ProgressBar
                            currentPhase={progressInfo.currentPhase}
                            overallProgress={progressInfo.overallProgress}
                            completedActions={progressInfo.completedActions}
                            totalExpectedActions={progressInfo.totalExpectedActions}
                            isProUser={isProUser}
                            t={t}
                        />
                    </div>
                )}
            </div>
            </div>

            <div className="flex flex-col lg:flex-row lg:items-stretch gap-4">
                    <div className="lg:flex-[1] lg:min-w-0 shrink-0 lg:max-w-sm lg:self-start">
                        <TableOfContents
                            className="mb-2 lg:mb-0 lg:sticky lg:top-[4.5rem] lg:z-[5] lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto lg:pr-2 lg:overscroll-y-contain"
                            title={t('progress.analysisNavigation')}
                            messages={[]}
                            beforeNavContent={(variant) => (
                                <ComprehensiveTOC
                                    actionResults={actionResults}
                                    selectedPhase={selectedPhase}
                                    selectedAction={selectedAction}
                                    onPhaseClick={handlePhaseClick}
                                    onActionClick={handleActionClick}
                                    unstyled
                                    className={cn(
                                        "space-y-2",
                                        variant === "desktop" && "max-h-[calc(100vh-220px)] overflow-y-auto pr-1 custom-scrollbar"
                                    )}
                                />
                            )}
                        />
                    </div>

                    {/* Content Details — inner scroll keeps left nav fixed when jumping headings */}
                    <div className="w-full min-w-0 lg:flex-[3] lg:min-h-0 lg:border-l lg:pl-4 flex flex-col">
                        {!selectedContent || selectedContent.length === 0 ? (
                            // No selection - show placeholder
                            <div className="flex flex-col items-center justify-center min-h-[280px] lg:min-h-[360px] text-center text-muted-foreground py-12">
                                <Circle className="size-16 mx-auto mb-4 opacity-30" />
                                <div className="text-base font-medium mb-2">{t('progress.noPhaseSelected')}</div>
                                <div className="text-sm">{t('progress.noPhaseSelectedDescription')}</div>
                            </div>
                        ) : (
                            // Selected phase/action — scoped for Share → export only this section
                            <div
                                className={cn(
                                    "flex flex-col min-h-0 flex-1 space-y-4 max-w-full min-w-0",
                                    "lg:max-h-[min(36rem,calc(100vh-11rem))] xl:max-h-[min(42rem,calc(100vh-10rem))]",
                                    "lg:overflow-y-auto lg:overscroll-y-contain custom-scrollbar pb-2",
                                )}
                                data-share-focused-export="true"
                                data-share-focus-key={`${selectedPhase ?? ""}:${selectedAction ?? "__phase_all__"}`}
                            >
                                {selectedContent.map((action, index) => {
                                    const messageLike = action.message
                                        ? ({
                                            ...(action.message as Record<string, unknown>),
                                            user: (action.message as Record<string, unknown>)?.user ?? "system",
                                            createdAt: action.message.createdAt ?? Date.now(),
                                            text: action.message.text ?? "",
                                        } as unknown as ContentWithUser)
                                        : null;
                                    const rawMetadata = (action.message?.metadata ?? {}) as Record<string, unknown>;
                                    const metadataPhaseValue = rawMetadata["phase"];
                                    const metadataPhase = typeof metadataPhaseValue === "string" ? metadataPhaseValue : undefined;
                                    const metadataChartPaths = (rawMetadata as { chartPaths?: unknown[] }).chartPaths;
                                    const hasMetadataArray = Array.isArray(metadataChartPaths);
                                    const allowMultipleChartsFlag = rawMetadata["allowMultipleCharts"] === true;
                                    const hasSingleChartPath = typeof rawMetadata["chartPath"] === "string";
                                    const allowMetadataArray =
                                        hasMetadataArray &&
                                        (metadataPhase === "writing_report" || allowMultipleChartsFlag || !hasSingleChartPath);

                                    const messageCharts = action.message && messageLike
                                        ? getMessageChartPaths(messageLike, deletedFiles, {
                                            includeMetadataArray: allowMetadataArray,
                                            requireTextReference: allowMetadataArray
                                        })
                                        : [];
                                    const parsedContent = action.message && messageLike
                                        ? parseMessageWithCharts(messageLike, messageCharts)
                                        : null;
                                    const messageId = action.message?.id ?? action.message?.createdAt;
                                    const anchorPrefix = messageId ? `comp-${messageId}-` : "";

                                    return (
                                        <div key={`${action.action}-${index}`} className="space-y-4">
                                            {/* Action Header - sticky with glassmorphism on lg+.
                                                On mobile/tablet it's inline so it scrolls away
                                                with the action content rather than overlapping
                                                the text. */}
                                            <div className={cn(
                                                "pb-4 flex items-center gap-3 p-4 rounded-lg max-w-full min-w-0",
                                                "border border-slate-300/60 dark:border-white/20 bg-white/20 dark:bg-white/5 shadow-sm",
                                                "backdrop-blur-md",
                                                "lg:sticky lg:top-0 lg:z-10"
                                            )}>
                                                    <div className="flex items-center gap-2">
                                                        {getPhaseIcon(action.phase)}
                                                        {getStatusIcon(action.status)}
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="text-sm font-medium text-foreground">
                                                            {formatActionName(action.action)}
                                                        </div>
                                                        <div className="text-xs text-muted-foreground">
                                                            {getPhaseLabel(action.phase, t)} • {action.action}
                                                        </div>
                                                    </div>
                                                    <Badge
                                                        variant={action.status === 'success' ? 'default' : 'secondary'}
                                                        className={action.status === 'success'
                                                            ? 'backdrop-blur-md bg-white/40 dark:bg-white/20 border border-white/50 dark:border-white/30 text-foreground'
                                                            : ''
                                                        }
                                                    >
                                                        {t(`progress.status.${action.status}`)}
                                                    </Badge>
                                            </div>

                                            {/* Generated Report panel (writing_report phase only).
                                                Surfaces the report download right inside the
                                                Report Generation step so users no longer have to
                                                hunt for it in the composer area. Summary text
                                                comes straight from the snapshot row's `summary`
                                                field, with the open-report button right below it
                                                per the agreed layout. */}
                                            {action.phase === 'writing_report' && action.status === 'success' && (() => {
                                                const reportMetadata = (action.message?.metadata ?? {}) as Record<string, unknown>;
                                                const execFromMeta =
                                                    typeof reportMetadata.executiveSummary === "string"
                                                        ? reportMetadata.executiveSummary.trim()
                                                        : "";
                                                const rowExec = (
                                                    action as unknown as {
                                                        executiveSummary?: unknown;
                                                    }
                                                ).executiveSummary;
                                                const execFromRow =
                                                    typeof rowExec === "string"
                                                        ? rowExec.trim()
                                                        : "";
                                                const executivePlain = execFromMeta || execFromRow;
                                                const reportPath =
                                                    (typeof reportMetadata.relativePath === 'string' && reportMetadata.relativePath) ||
                                                    (typeof reportMetadata.reportPath === 'string' && reportMetadata.reportPath) ||
                                                    '';
                                                const reportUrl = typeof reportMetadata.reportUrl === 'string'
                                                    ? reportMetadata.reportUrl
                                                    : undefined;
                                                if (!reportPath) {
                                                    return null;
                                                }

                                                const fileName =
                                                    reportPath.split('/').pop() ||
                                                    reportPath.split('\\').pop() ||
                                                    String(t('chat.reportLabel', { index: 1 }));
                                                const displayName = fileName
                                                    .replace(/\.(html)$/i, '')
                                                    .replace(/_/g, ' ')
                                                    .replace(/comprehensive analysis/i, String(t('chat.analysisReportLabel')));

                                                return (
                                                    <div className="rounded-lg border border-slate-300/60 dark:border-white/20 bg-white/40 dark:bg-white/5 backdrop-blur-md p-4 space-y-3">
                                                        <div className="flex items-center gap-2">
                                                            <FileText className="size-4 shrink-0 text-amber-500" />
                                                            <h4 className="text-base font-semibold tracking-tight text-foreground">
                                                                {t('progress.reportSection.title')}
                                                            </h4>
                                                        </div>
                                                        {executivePlain ? (
                                                            <div className="space-y-3 pt-0.5 border-t border-slate-200/80 dark:border-white/10 pt-3">
                                                                <p
                                                                    className="text-xl font-semibold leading-snug tracking-tight text-foreground mb-1"
                                                                    role="heading"
                                                                    aria-level={2}
                                                                >
                                                                    {t('progress.reportSection.executiveSummaryLabel')}
                                                                </p>
                                                                <MarkdownRenderer
                                                                    className={MARKDOWN_CONTAINER_CLASSES}
                                                                    anchorPrefix={`${anchorPrefix}exec-`}
                                                                >
                                                                    {executivePlain}
                                                                </MarkdownRenderer>
                                                            </div>
                                                        ) : null}
                                                        {action.summary && (
                                                            <p className="text-sm text-muted-foreground leading-relaxed">
                                                                {action.summary}
                                                            </p>
                                                        )}
                                                        <Button
                                                            variant="outline"
                                                            size="sm"
                                                            onClick={() => openReport(reportPath, reportUrl)}
                                                            className="gap-1.5 max-w-full"
                                                        >
                                                            <FileText className="size-4 flex-shrink-0" />
                                                            <span className="truncate">{displayName}</span>
                                                            <ExternalLink className="size-3 flex-shrink-0" />
                                                        </Button>
                                                    </div>
                                                );
                                            })()}

                                            {/* Message Content */}
                                        {action.message && (
                                            <div className="space-y-4">
                                                <ChatBubble variant="received" className="flex flex-row items-center gap-2">
                                                    <Avatar className="size-8 p-1 border rounded-full select-none">
                                                        <AvatarImage src={agentIconSrc} />
                                                    </Avatar>
                                                    <div className="flex flex-col">
                                                        <ChatBubbleMessage>
                                                            {/* Error Messages */}
                                                            {action.message.error && (
                                                                <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-md">
                                                                    <div className="flex items-start gap-2">
                                                                        <div className="text-red-600 text-sm font-medium">
                                                                            {t('progress.errorWithType', { type: action.message.error.type })}
                                                                        </div>
                                                                    </div>
                                                                    <div className="text-red-800 text-sm mt-1">
                                                                        {action.message.error.message}
                                                                    </div>
                                                                    {action.message.error.originalError && action.message.error.originalError !== action.message.error.message && (
                                                                        <div className="text-red-600 text-xs mt-2 font-mono">
                                                                            {t('progress.originalError', { message: action.message.error.originalError })}
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            )}

                                                            {/* Message Content */}
                                                            <div className={action.message.error ? "opacity-75" : ""}>
                                                                {parsedContent && parsedContent.hasInlineCharts ? (
                                                                    <>
                                                                        {parsedContent.segments.map((segment, segIndex) => (
                                                                            <div key={segIndex}>
                                                                                {segment.text && (
                                                                                    <MarkdownRenderer
                                                                                        className={MARKDOWN_CONTAINER_CLASSES}
                                                                                        anchorPrefix={anchorPrefix}
                                                                                    >
                                                                                        {segment.text}
                                                                                    </MarkdownRenderer>
                                                                                )}
                                                                                {segment.charts.length > 0 && (
                                                                                    <div className="w-full mt-4 space-y-4">
                                                                                        {segment.charts.map((chartPath) => {
                                                                                            const chartUrl = apiClient.getChartUrl(chartPath);
                                                                                            const chartId = getChartId(messageId, chartPath);

                                                                                            return (
                                                                                                <ChartEmbed
                                                                                                    key={chartPath}
                                                                                                    id={chartId}
                                                                                                    chartUrl={chartUrl}
                                                                                                    chartPath={chartPath}
                                                                                                    showHeader={false}
                                                                                                />
                                                                                            );
                                                                                        })}
                                                                                    </div>
                                                                                )}
                                                                            </div>
                                                                        ))}
                                                                        {parsedContent.chartsAtEnd && parsedContent.chartsAtEnd.length > 0 && (
                                                                            <div className="w-full mt-6 space-y-4">
                                                                                {parsedContent.chartsAtEnd.map((chartPath) => {
                                                                                    const chartUrl = apiClient.getChartUrl(chartPath);
                                                                                    const chartId = getChartId(messageId, chartPath);

                                                                                    return (
                                                                                        <ChartEmbed
                                                                                            key={chartPath}
                                                                                            id={chartId}
                                                                                            chartUrl={chartUrl}
                                                                                            chartPath={chartPath}
                                                                                            showHeader={false}
                                                                                        />
                                                                                    );
                                                                                })}
                                                                            </div>
                                                                        )}
                                                                    </>
                                                                ) : (
                                                                    <>
                                                                        <MarkdownRenderer
                                                                            className={MARKDOWN_CONTAINER_CLASSES}
                                                                            anchorPrefix={anchorPrefix}
                                                                        >
                                                                            {action.message.text || ''}
                                                                        </MarkdownRenderer>
                                                                        {messageCharts.length > 0 && (
                                                                            <div className="w-full mt-6 space-y-4">
                                                                                {messageCharts.map((chartPath) => {
                                                                                    const chartUrl = apiClient.getChartUrl(chartPath);
                                                                                    const chartId = getChartId(messageId, chartPath);

                                                                                    return (
                                                                                        <ChartEmbed
                                                                                            key={chartPath}
                                                                                            id={chartId}
                                                                                            chartUrl={chartUrl}
                                                                                            chartPath={chartPath}
                                                                                            showHeader={false}
                                                                                        />
                                                                                    );
                                                                                })}
                                                                            </div>
                                                                        )}
                                                                    </>
                                                                )}
                                                            </div>

                                                            {/* Attachments */}
                                                            <div className="w-full">
                                                                {action.message.attachments?.map((attachment: IAttachment) => (
                                                                    <div
                                                                        className="flex flex-col gap-1 mt-4 w-full"
                                                                        key={`${attachment.url}-${attachment.title}`}
                                                                    >
                                                                        <img
                                                                            alt={t("common.attachment")}
                                                                            src={attachment.url}
                                                                            className="w-full max-w-full md:max-w-3xl rounded-md"
                                                                            loading="lazy"
                                                                            decoding="async"
                                                                        />
                                                                        {attachment.description && (
                                                                            <div className="mt-2 text-sm text-muted-foreground">
                                                                                {attachment.description}
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        </ChatBubbleMessage>

                                                        <div className="flex items-center gap-4 justify-between w-full mt-1">
                                                            {action.message.text && (
                                                                <div className="flex items-center gap-1">
                                                                    <CopyButton text={action.message.text} />
                                                                    <ChatTtsButton agentId={agentId} text={action.message.text} />
                                                                </div>
                                                            )}
                                                            <div
                                                                className={cn([
                                                                    "flex items-center justify-between gap-4 select-none",
                                                                ])}
                                                            >
                                                                {action.message.source ? (
                                                                    <Badge variant="outline">
                                                                        {formatSourceName(action.message.source, t)}
                                                                    </Badge>
                                                                ) : null}
                                                                {action.message.createdAt ? (
                                                                    <ChatBubbleTimestamp
                                                                        timestamp={moment(action.message.createdAt).format("LT")}
                                                                    />
                                                                ) : null}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </ChatBubble>
                                            </div>
                                        )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
        </div>
    );
});

ComprehensiveActionTab.displayName = 'ComprehensiveActionTab';
