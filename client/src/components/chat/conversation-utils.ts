import type { TaskChainData } from "../TaskChainBubble";
import type { ContentWithUser, ConversationPair } from "./types";
import i18n from "@/i18n";

export const hasTaskChainData = (
    message: ContentWithUser,
): message is ContentWithUser & { content: { metadata?: { taskChain?: TaskChainData } } } => {
    if (message?.user === "user") return false;
    const taskChain = (message as unknown as { content?: { metadata?: { taskChain?: TaskChainData } } }).content?.metadata?.taskChain;
    if (!taskChain || typeof taskChain !== "object") {
        return false;
    }

    const hasValidTaskChain = Boolean(
        taskChain.id &&
        taskChain.name &&
        Array.isArray((taskChain as { tasks?: unknown[] }).tasks) &&
        (taskChain as { tasks?: unknown[] }).tasks?.length,
    );

    return hasValidTaskChain;
};

export const hasTaskChainMessages = (conversation: ConversationPair): boolean => {
    return conversation.responses.some((response) =>
        hasTaskChainData(response) ||
        (response as any)?.content?.source === 'task_chain_action' ||
        (response as any)?.content?.source === 'task_chain_planning' ||
        (response as any)?.content?.source === 'comprehensive_analysis'
    );
};

/**
 * Build synthetic task-output messages from a persisted task-chain snapshot (full results or slim summaries).
 * Used after refresh when per-task memories are not shipped on the messages API.
 */
export const messagesFromTaskChainSnapshot = (
    taskChainSnapshot: any,
    summaryAnchor: Pick<ContentWithUser, "userId" | "agentId" | "roomId" | "createdAt"> & { id?: string },
): ContentWithUser[] => {
    if (!taskChainSnapshot || typeof taskChainSnapshot !== "object") {
        return [];
    }

    const fullResults = taskChainSnapshot.executionResults;
    if (Array.isArray(fullResults) && fullResults.some((r: any) => r?.result)) {
        return fullResults
            .filter((result: any) => result.result)
            .map((result: any) => {
                const memory = result.result;
                return {
                    id: memory.id,
                    userId: memory.userId,
                    agentId: memory.agentId,
                    roomId: memory.roomId,
                    createdAt: memory.createdAt,
                    content: memory.content,
                    user: memory.userId === memory.agentId ? "assistant" : "user",
                    text: memory.content?.text || "",
                } as ContentWithUser;
            });
    }

    const summaries = taskChainSnapshot.executionResultSummaries;
    if (!Array.isArray(summaries) || summaries.length === 0) {
        return [];
    }

    const userId = summaryAnchor.userId;
    const agentId = summaryAnchor.agentId;
    const roomId = summaryAnchor.roomId;
    const fallbackCreatedAt = summaryAnchor.createdAt;

    return summaries
        .map((s: any, idx: number) => {
            const text = typeof s.resultText === "string" ? s.resultText.trim() : "";
            if (!text) return null;
            const id =
                typeof s.resultId === "string" && s.resultId.length > 0
                    ? s.resultId
                    : `taskchain-snap-${String(s.taskId)}-${idx}`;
            // Carry chart references through into the synthetic message's
            // metadata. Without this, getMessageChartPaths sees no chart on
            // a summary-only synthetic message, no <ChartEmbed> renders, no
            // [id^="chart-"] anchor exists in the DOM, and the sidebar's
            // jump-to-chart lookup misses even though the chart is listed.
            const chartMetadata: Record<string, unknown> = {};
            if (typeof s.chartPath === "string" && s.chartPath.length > 0) {
                chartMetadata.chartPath = s.chartPath;
            }
            if (Array.isArray(s.chartPaths)) {
                const paths = s.chartPaths.filter(
                    (p: unknown): p is string => typeof p === "string" && p.length > 0,
                );
                if (paths.length > 0) {
                    chartMetadata.chartPaths = paths;
                }
            }
            return {
                id,
                userId,
                agentId,
                roomId,
                createdAt: typeof s.createdAt === "number" ? s.createdAt : fallbackCreatedAt,
                content: {
                    text,
                    source: "task_chain_action",
                    metadata: {
                        taskId: s.taskId,
                        ...(s.taskName ? { taskName: s.taskName } : {}),
                        ...chartMetadata,
                    },
                },
                user: "assistant",
                text,
            } as ContentWithUser;
        })
        .filter(Boolean) as ContentWithUser[];
};

/**
 * Extract task action messages from snapshot's executionResults
 * These messages may not be in the database after page refresh,
 * but they are preserved in the snapshot
 */
export const getTaskChainActionMessagesFromSnapshot = (conversation: ConversationPair): ContentWithUser[] => {
    const summaryMessage = conversation.responses.find((response) => {
        const contentSource = (response as any)?.content?.source;
        const directSource = (response as any)?.source;
        return contentSource === "task_chain_summary" || directSource === "task_chain_summary";
    });

    if (!summaryMessage) {
        return [];
    }

    const summaryMetadata = (summaryMessage as any)?.content?.metadata || {};
    const taskChainSnapshot = summaryMetadata.taskChainSnapshot;

    return messagesFromTaskChainSnapshot(taskChainSnapshot, summaryMessage as any);
};

/** Whether message metadata contains a usable comprehensive snapshot (full or slim). */
export const hasComprehensiveSnapshotPayload = (metadata: any): boolean => {
    const snap = metadata?.comprehensiveSnapshot;
    if (!snap || typeof snap !== "object") return false;
    return (
        (Array.isArray(snap.actionResults) && snap.actionResults.length > 0) ||
        (Array.isArray(snap.actionResultSummaries) && snap.actionResultSummaries.length > 0)
    );
};

/**
 * Restore ComprehensiveActionTab rows from a snapshot (full actionResults or slim actionResultSummaries from API).
 */
export const normalizeComprehensiveSnapshotActionResults = (comprehensiveSnapshot: any): any[] => {
    if (!comprehensiveSnapshot || typeof comprehensiveSnapshot !== "object") {
        return [];
    }
    const full = comprehensiveSnapshot.actionResults;
    if (Array.isArray(full) && full.length > 0) {
        return full;
    }
    const summaries = comprehensiveSnapshot.actionResultSummaries;
    if (!Array.isArray(summaries) || summaries.length === 0) {
        return [];
    }
    return summaries.map((s: any, index: number) => {
        const content =
            typeof s.contentText === "string" && s.contentText.trim().length > 0
                ? s.contentText
                : typeof s.summary === "string"
                  ? s.summary
                  : "";
        const summary =
            typeof s.summary === "string" &&
            s.summary.trim().length > 0 &&
            s.summary.trim() !== content.trim()
                ? s.summary
                : undefined;
        const action = typeof s.action === "string" && s.action.length > 0 ? s.action : `action-${index}`;
        const phase = typeof s.phase === "string" && s.phase.length > 0 ? s.phase : "analysis";
        const status =
            s.status === "failed" ? "failed" : s.status === "pending" ? "pending" : "success";
        const mid =
            s.messageId !== undefined && s.messageId !== null && String(s.messageId).length > 0
                ? String(s.messageId)
                : `comp-snap-${phase}-${action}-${index}`;
        const createdAt = typeof s.createdAt === "number" ? s.createdAt : Date.now();
        // Carry chart references from the slim snapshot through into the
        // synthetic message's metadata. Without this, after refresh
        // getMessageChartPaths returns [] for snapshot-derived synthetics,
        // <ChartEmbed> never mounts, and no /s3-files/ request fires.
        // Sibling pattern of executionResultSummaries / messagesFromTaskChainSnapshot.
        const chartMetadata: Record<string, unknown> = {};
        if (typeof s.chartPath === "string" && s.chartPath.length > 0) {
            chartMetadata.chartPath = s.chartPath;
        }
        if (Array.isArray(s.chartPaths)) {
            const paths = s.chartPaths.filter(
                (p: unknown): p is string => typeof p === "string" && p.length > 0,
            );
            if (paths.length > 0) {
                chartMetadata.chartPaths = paths;
            }
        }
        if (typeof s.relativePath === "string" && s.relativePath.trim().length > 0) {
            chartMetadata.relativePath = s.relativePath;
        }
        if (typeof s.reportPath === "string" && s.reportPath.trim().length > 0) {
            chartMetadata.reportPath = s.reportPath;
        }
        if (typeof s.reportUrl === "string" && s.reportUrl.trim().length > 0) {
            chartMetadata.reportUrl = s.reportUrl;
        }
        if (typeof s.executiveSummary === "string" && s.executiveSummary.trim().length > 0) {
            chartMetadata.executiveSummary = s.executiveSummary.trim();
        }
        return {
            action,
            phase,
            status,
            content,
            summary: summary ?? `${action} completed`,
            message: {
                id: mid,
                text: content,
                createdAt,
                source: "comprehensive_analysis",
                metadata: {
                    phase,
                    actionName: action,
                    success: status === "success",
                    ...chartMetadata,
                },
            },
        };
    });
};

/**
 * Snapshot `actionResults` are built only from tool memories (runtime passes
 * `result.actionResults`), so the chat summary row (phase `writing_report`) is missing.
 * Without it the tab shows N actions vs N+1 expected. Append that row when reconstructing from
 * snapshot if the anchor message is the completion message.
 */
function attachComprehensiveReportRowIfNeeded(
    snapshotRows: any[],
    summaryMessage: ContentWithUser,
): any[] {
    const summaryMetadata = (summaryMessage as any)?.content?.metadata || {};
    const actionNameLc =
        typeof summaryMetadata.actionName === "string"
            ? summaryMetadata.actionName.toLowerCase()
            : "";
    const anchorEligible =
        summaryMetadata.phase === "writing_report" ||
        (typeof summaryMetadata.reportPath === "string" &&
            summaryMetadata.reportPath.trim().length > 0) ||
        actionNameLc.includes("report generation");

    if (!anchorEligible || snapshotRows.length === 0) {
        return snapshotRows;
    }

    const anchorId = String(summaryMessage.id || "");
    const hasReportRow = snapshotRows.some((row) => {
        if (row.phase === "writing_report") {
            return true;
        }
        if (anchorId && String(row.message?.id ?? "") === anchorId) {
            return true;
        }
        const actionLc = typeof row.action === "string" ? row.action.toLowerCase() : "";
        return (
            actionLc.includes("report generation") ||
            actionLc === "report generation complete"
        );
    });

    if (hasReportRow) {
        return snapshotRows;
    }

    const row = {
        action: summaryMetadata.actionName || "Report Generation",
        phase: summaryMetadata.phase || "writing_report",
        status: summaryMetadata.success ? ("success" as const) : ("pending" as const),
        content: summaryMessage.text || "",
        summary:
            typeof summaryMetadata.summary === "string" && summaryMetadata.summary.trim().length > 0
                ? summaryMetadata.summary.trim()
                : "Comprehensive analysis report successfully generated and saved",
        message: {
            id: String(summaryMessage.id || "summary-msg"),
            text: summaryMessage.text || "",
            createdAt: summaryMessage.createdAt || Date.now(),
            source: (summaryMessage as any)?.content?.source,
            attachments: (summaryMessage as any)?.attachments,
            metadata: summaryMetadata,
            error: (summaryMessage as any)?.error,
        },
    };

    return [...snapshotRows, row];
}

/**
 * Slim snapshot rows for `writing_report` used to omit relativePath/reportPath;
 * ComprehensiveActionTab then hides the whole report panel (`if (!reportPath) return null`).
 * The completion message metadata still carries paths — merge them onto the report row.
 */
function mergeWritingReportMetadataFromAnchor(rows: any[], summaryMessage: ContentWithUser): any[] {
    const anchorMeta =
        (((summaryMessage as unknown as { content?: { metadata?: Record<string, unknown> } }).content
            ?.metadata ?? {}) as Record<string, unknown>) || {};
    const anchorRelative =
        typeof anchorMeta.relativePath === "string" && anchorMeta.relativePath.trim().length > 0
            ? anchorMeta.relativePath
            : "";
    const anchorReportPath =
        typeof anchorMeta.reportPath === "string" && anchorMeta.reportPath.trim().length > 0
            ? anchorMeta.reportPath
            : "";
    const anchorUrl =
        typeof anchorMeta.reportUrl === "string" && anchorMeta.reportUrl.trim().length > 0
            ? anchorMeta.reportUrl
            : "";
    const anchorExec =
        typeof anchorMeta.executiveSummary === "string" && anchorMeta.executiveSummary.trim().length > 0
            ? anchorMeta.executiveSummary.trim()
            : "";
    if (!anchorRelative && !anchorReportPath && !anchorUrl && !anchorExec) {
        return rows;
    }

    return rows.map((row) => {
        const phase = row.phase;
        const actionLc = typeof row.action === "string" ? row.action.toLowerCase() : "";
        const isReportRow = phase === "writing_report" || actionLc.includes("report generation");
        if (!isReportRow) return row;

        const msgMeta = (((row.message as { metadata?: Record<string, unknown> }) ?? {}).metadata ??
            {}) as Record<string, unknown>;
        const hasReportLink =
            (typeof msgMeta.relativePath === "string" && msgMeta.relativePath.trim().length > 0) ||
            (typeof msgMeta.reportPath === "string" && msgMeta.reportPath.trim().length > 0);
        const hasExecSummary =
            typeof msgMeta.executiveSummary === "string" && msgMeta.executiveSummary.trim().length > 0;

        const pathPatches: Record<string, unknown> = {};
        if (!hasReportLink) {
            if (anchorRelative && msgMeta.relativePath === undefined) pathPatches.relativePath = anchorRelative;
            if (anchorReportPath && msgMeta.reportPath === undefined) pathPatches.reportPath = anchorReportPath;
            if (anchorUrl && msgMeta.reportUrl === undefined) pathPatches.reportUrl = anchorUrl;
        }
        const execPatch: Record<string, unknown> =
            anchorExec && !hasExecSummary ? { executiveSummary: anchorExec } : {};

        if (Object.keys(pathPatches).length === 0 && Object.keys(execPatch).length === 0) {
            return row;
        }

        return {
            ...row,
            message: {
                ...row.message,
                metadata: {
                    ...msgMeta,
                    ...pathPatches,
                    ...execPatch,
                },
            },
        };
    });
}

/** Synthetic per-action transcript rows for share export from comprehensive snapshot. */
export const messagesFromComprehensiveSnapshot = (
    comprehensiveSnapshot: any,
    anchor: Pick<ContentWithUser, "userId" | "agentId" | "roomId" | "createdAt">,
): ContentWithUser[] => {
    const rows = normalizeComprehensiveSnapshotActionResults(comprehensiveSnapshot);
    if (rows.length === 0) return [];

    return rows
        .map((item: any, idx: number) => {
            const body = typeof item.content === "string" ? item.content.trim() : "";
            const sum = typeof item.summary === "string" ? item.summary.trim() : "";
            const text = body && sum && sum !== body ? `${body}\n\n${sum}` : body || sum;
            if (!text) return null;
            const phase = typeof item.phase === "string" ? item.phase : "analysis";
            const action = typeof item.action === "string" ? item.action : `action-${idx}`;
            const mid =
                item.message?.id !== undefined && item.message?.id !== null
                    ? String(item.message.id)
                    : `comp-export-${phase}-${action}-${idx}`;
            const createdAt =
                typeof item.message?.createdAt === "number"
                    ? item.message.createdAt
                    : typeof anchor.createdAt === "number"
                      ? anchor.createdAt
                      : Date.now();
            return {
                id: mid,
                userId: anchor.userId,
                agentId: anchor.agentId,
                roomId: anchor.roomId,
                createdAt,
                content: {
                    text,
                    source: "comprehensive_analysis",
                    metadata: {
                        phase,
                        actionName: action,
                        action,
                        success: item.status === "success",
                    },
                },
                user: "assistant",
                text,
            } as ContentWithUser;
        })
        .filter(Boolean) as ContentWithUser[];
};

export const getTaskChainData = (conversation: ConversationPair): TaskChainData | null => {
    const summaryMessage = conversation.responses.find((response) => {
        const contentSource = (response as any)?.content?.source;
        const directSource = (response as any)?.source;
        return contentSource === 'task_chain_summary' || directSource === 'task_chain_summary';
    });

    if (summaryMessage) {
        // Use standard format: content.metadata
    const summaryMetadata = (summaryMessage as any)?.content?.metadata || {};
        const taskChainSnapshot = summaryMetadata.taskChainSnapshot;

        if (taskChainSnapshot && taskChainSnapshot.taskChainData) {
            return taskChainSnapshot.taskChainData;
        }
    }

    const hasComprehensiveActions = conversation.responses.some(
        (response) => (response as any)?.content?.source === 'comprehensive_analysis',
    );

    if (hasComprehensiveActions) {
        const comprehensiveActions = conversation.responses.filter(
            (response) => (response as any)?.content?.source === 'comprehensive_analysis',
        );

        const tasks = comprehensiveActions.map((response, index) => ({
            id: (response as any)?.content?.metadata?.taskId || `comprehensive-action-${index}`,
            name: (response as any)?.content?.metadata?.actionName || i18n.t("chat.analysisAction"),
            description: i18n.t("chat.comprehensiveAnalysisActionDescription", {
                actionName: (response as any)?.content?.metadata?.actionName || i18n.t("chat.action"),
            }),
            type: 'action' as const,
            status: (response as any)?.content?.metadata?.success ? 'completed' as const : 'failed' as const,
            dependencies: [],
            hasResult: true,
            isSuccess: (response as any)?.content?.metadata?.success || false,
            parameters: {},
        }));

        return {
            id: 'comprehensive-analysis-chain',
            name: i18n.t("chat.comprehensiveAnalysis"),
            description: i18n.t("chat.comprehensiveAnalysisDescription"),
            tasks,
        };
    }

    return null;
};

export const hasComprehensiveAnalysisMessages = (conversation: ConversationPair): boolean => {
    return conversation.responses.some((response) => {
        const contentSource = (response as any)?.content?.source;
        const directSource = (response as any)?.source;
        return contentSource === 'comprehensive_analysis' || directSource === 'comprehensive_analysis';
    });
};

/** In-chat final LLM narrative for comprehensive analysis (not an action row). */
export const isComprehensiveFinalNarrativeMessage = (response: ContentWithUser): boolean =>
    Boolean((response as unknown as { content?: { metadata?: { comprehensiveFinalNarrative?: unknown } } }).content?.metadata?.comprehensiveFinalNarrative);

export const getComprehensiveAnalysisData = (
    conversation: ConversationPair,
    realtimeActionResults: Record<string, any[]>,
) => {
    const summaryMessage = conversation.responses.find((response) => {
        const metadata = (response as any)?.content?.metadata || {};
        return hasComprehensiveSnapshotPayload(metadata);
    });

    if (summaryMessage) {
        const summaryMetadata = (summaryMessage as any)?.content?.metadata || {};
        const comprehensiveSnapshot = summaryMetadata.comprehensiveSnapshot;
        const normalized = normalizeComprehensiveSnapshotActionResults(comprehensiveSnapshot);
        if (normalized.length > 0) {
            const withReportRow = attachComprehensiveReportRowIfNeeded(normalized, summaryMessage);
            return mergeWritingReportMetadataFromAnchor(withReportRow, summaryMessage);
        }
    }

    const actionMessages = conversation.responses.filter((response) => {
        const contentSource = (response as any)?.content?.source;
        const directSource = (response as any)?.source;
        const metadata = (response as any)?.content?.metadata || {};
        if (metadata.excludeFromComprehensiveActionTab) return false;
        return contentSource === 'comprehensive_analysis' || directSource === 'comprehensive_analysis';
    });

    const realtimeResults = realtimeActionResults[conversation.conversationId] || [];

    const getActionNameFromMessage = (message: any, index: number): string => {
        // Use standard format: content.metadata
        const metadata = (message as any)?.content?.metadata || {};
        const text = message.text || '';

        if (metadata.actionName) return metadata.actionName;
        if (text.includes('CRYPTOCURRENCY SENTIMENT ANALYSIS')) return 'Sentiment Analysis';
        if (text.includes('Fear & Greed Index')) return 'Fear & Greed Analysis';
        if (text.includes('Cryptocurrency Research Analysis')) return 'Research Analysis';
        if (text.includes('Transaction Count Chart')) return 'Transaction Analysis';
        if (text.includes('Inflow/Outflow')) return 'Flow Analysis';
        if (text.includes('Technic Analysis') || text.includes('Technical Analysis')) return 'Technical Analysis';
        if (text.includes('Price Chart')) return 'Price Analysis';
        if (text.includes('Crypto Market Prediction')) return 'Prediction Analysis';
        if (text.includes('Latest') && text.includes('data')) return 'Data Collection';

        return `Analysis ${index + 1}`;
    };

    const getPhaseFromMessage = (message: any): string => {
        // Use standard format: content.metadata
        const metadata = (message as any)?.content?.metadata || {};
        const text = message.text || '';

        if (metadata.phase) return metadata.phase;
        if (text.includes('Downloaded') || text.includes('Latest') || text.includes('data is from')) return 'data_gathering';
        if (text.includes('Analysis') || text.includes('ANALYSIS')) return 'analysis';
        if (text.includes('Chart') || text.includes('generated')) return 'chart_generation';
        if (text.includes('Prediction') || text.includes('Market')) return 'prediction';

        return 'analysis';
    };

    const actionMessagePairs = actionMessages.map((message, index) => {
        // Use standard format: content.metadata
        const metadata = (message as any)?.content?.metadata || {};
        const realtimeData = realtimeResults[index] || {};

        const mergedMetadata = { ...metadata };
        const rtExec = realtimeData.executiveSummary;
        if (typeof rtExec === "string" && rtExec.trim().length > 0) {
            mergedMetadata.executiveSummary = rtExec.trim();
        }

        const actionName =
            mergedMetadata.actionName ||
            realtimeData.action ||
            getActionNameFromMessage(message, index);
        const phase = mergedMetadata.phase || realtimeData.phase || getPhaseFromMessage(message);

        let status: 'success' | 'failed' | 'pending' = 'success';
        if (mergedMetadata.success !== undefined) {
            status = mergedMetadata.success ? 'success' : 'failed';
        } else if (realtimeData.status) {
            status = realtimeData.status;
        } else if (message.text && (
            message.text.includes('successfully') ||
            message.text.includes('generated') ||
            message.text.includes('complete')
        )) {
            status = 'success';
        }

        return {
            action: actionName,
            phase,
            status,
            content: message.text || '',
            summary:
                mergedMetadata.summary ||
                realtimeData.summary ||
                `${actionName} completed successfully`,
            message: {
                id: String(message.id || `msg-${index}`),
                text: message.text || '',
                createdAt: message.createdAt || Date.now(),
                source: (message as any)?.content?.source || undefined,
                attachments: (message as any)?.attachments || undefined,
                metadata: mergedMetadata,
                error: (message as any)?.error || undefined,
            },
        };
    });

    const realSummaryMessage = conversation.responses.find((response) => {
        const metadata = (response as any)?.content?.metadata || {};
        return hasComprehensiveSnapshotPayload(metadata);
    });

    if (realSummaryMessage && !actionMessages.includes(realSummaryMessage)) {
        // Use standard format: content.metadata
        const summaryMetadata = (realSummaryMessage as any)?.content?.metadata || {};

        actionMessagePairs.push({
            action: summaryMetadata.actionName || 'Report Generation',
            phase: summaryMetadata.phase || 'writing_report',
            status: summaryMetadata.success ? 'success' as const : 'pending' as const,
            content: realSummaryMessage.text || '',
            summary:
                typeof summaryMetadata.summary === 'string' && summaryMetadata.summary.trim().length > 0
                    ? summaryMetadata.summary.trim()
                    : 'Comprehensive analysis report successfully generated and saved',
            message: {
                id: String(realSummaryMessage.id || 'summary-msg'),
                text: realSummaryMessage.text || '',
                createdAt: realSummaryMessage.createdAt || Date.now(),
                source: (realSummaryMessage as any)?.content?.source || undefined,
                attachments: (realSummaryMessage as any)?.attachments || undefined,
                metadata: summaryMetadata,
                error: (realSummaryMessage as any)?.error || undefined,
            },
        });
    }

    const remainingRealtimeResults = realtimeResults.slice(actionMessages.length);
    const additionalPairs = remainingRealtimeResults.map((realtimeData: any, index: number) => {
        const exec =
            typeof realtimeData.executiveSummary === 'string'
                ? realtimeData.executiveSummary.trim()
                : '';
        return {
            action: realtimeData.action || `Pending Action ${index + 1}`,
            phase: realtimeData.phase || 'other',
            status: 'pending' as const,
            content: realtimeData.content || '',
            summary: realtimeData.summary || undefined,
            ...(exec ? { executiveSummary: exec } : {}),
            message: undefined,
        };
    });

    return [...actionMessagePairs, ...additionalPairs];
};

export const groupMessagesIntoConversations = (messages: ContentWithUser[]): ConversationPair[] => {
    const conversations: ConversationPair[] = [];
    let currentConversation: ConversationPair | null = null;

    messages.forEach((message) => {
        const isComprehensiveMessage = (msg: ContentWithUser): boolean => {
            const contentSource = (msg as any)?.content?.source;
            const directSource = (msg as any)?.source;
            return contentSource === 'comprehensive_analysis' || directSource === 'comprehensive_analysis';
        };

        const isTaskChainMessage = (msg: ContentWithUser): boolean => {
            const contentSource = (msg as any)?.content?.source;
            const directSource = (msg as any)?.source;
            return (
                contentSource === 'task_chain_planning' ||
                contentSource === 'task_chain_action' ||
                contentSource === 'task_chain_summary' ||
                directSource === 'task_chain_planning' ||
                directSource === 'task_chain_action' ||
                directSource === 'task_chain_summary'
            );
        };

        if (message.user === 'user') {
            if (currentConversation) {
                conversations.push(currentConversation);
            }
            const conversationId = `conv-${message.createdAt}`;
            currentConversation = {
                userMessage: message,
                responses: [],
                conversationId,
            };
        } else if (currentConversation && message.user !== 'user') {
            currentConversation.responses.push(message);
        } else if (message.user === 'system' && isComprehensiveMessage(message)) {
            if (!currentConversation) {
                const conversationId = `comprehensive-${message.createdAt}`;
                currentConversation = {
                    userMessage: {
                        id: `synthetic-user-${message.createdAt}`,
                        user: 'user',
                        text: 'Analyze BTC',
                        createdAt: message.createdAt - 1000,
                        attachments: [],
                    } as ContentWithUser,
                    responses: [],
                    conversationId,
                };
            }
            currentConversation.responses.push(message);
        } else if (message.user === 'system' && isTaskChainMessage(message)) {
            if (!currentConversation) {
                const conversationId = `task-chain-${message.createdAt}`;
                currentConversation = {
                    userMessage: {
                        id: `synthetic-user-${message.createdAt}`,
                        user: 'user',
                        text: 'Execute task chain',
                        createdAt: message.createdAt - 1000,
                        attachments: [],
                    } as ContentWithUser,
                    responses: [],
                    conversationId,
                };
            }
            currentConversation.responses.push(message);
        }
    });

    if (currentConversation) {
        conversations.push(currentConversation);
    }

    // POST-PROCESS: Inject task action messages from snapshot's executionResults
    // This ensures messages are visible even after page refresh when they're not in the database
    conversations.forEach((conversation) => {
        const snapshotActionMessages = getTaskChainActionMessagesFromSnapshot(conversation);

        if (snapshotActionMessages.length > 0) {
            // Find the index of the summary message
            const summaryIndex = conversation.responses.findIndex((response) => {
                const contentSource = (response as any)?.content?.source;
                const directSource = (response as any)?.source;
                return contentSource === 'task_chain_summary' || directSource === 'task_chain_summary';
            });

            if (summaryIndex !== -1) {
                // Check if these messages already exist in responses (to avoid duplicates)
                const existingMessageIds = new Set(conversation.responses.map(r => r.id));
                const newMessages = snapshotActionMessages.filter(msg => !existingMessageIds.has(msg.id));

                if (newMessages.length > 0) {
                    // Insert the action messages before the summary message
                    conversation.responses.splice(summaryIndex, 0, ...newMessages);
                }
            }
        }
    });

    return conversations;
};
