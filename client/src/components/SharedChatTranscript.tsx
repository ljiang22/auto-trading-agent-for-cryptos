import { useCallback, useMemo, useState } from "react";
import type { UUID } from "@elizaos/core";
import { cn, moment } from "@/lib/utils";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { SharedChatMessageMedia, hasSharedChatMedia } from "@/components/SharedChatMessageMedia";
import { ChartEmbed } from "@/components/ChartEmbed";
import { apiClient } from "@/lib/api";
import { formatSourceName, getChartId, getMessageChartPaths, resolveMessageId } from "@/components/chat/message-utils";
import {
    getComprehensiveAnalysisData,
    getTaskChainData,
    groupMessagesIntoConversations,
    hasComprehensiveAnalysisMessages,
    isComprehensiveFinalNarrativeMessage,
} from "@/components/chat/conversation-utils";
import type { ContentWithUser, ConversationPair } from "@/components/chat/types";
import { ComprehensiveActionTab } from "@/components/ComprehensiveActionTab";
import { TaskChainBubble } from "@/components/TaskChainBubble";
import { TaskChainTabs } from "@/components/TaskChainTabs";
import { ChatBubble, ChatBubbleMessage, ChatBubbleTimestamp } from "@/components/ui/chat/chat-bubble";
import { Avatar, AvatarImage } from "@/components/ui/avatar";
import CopyButton from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { useTheme } from "@/contexts/ThemeContext";

type SharedChatMemory = {
    id: string;
    userId: string;
    agentId: string;
    createdAt: number;
    content: {
        text: string;
        attachments?: unknown;
        metadata?: unknown;
        actionResults?: unknown;
        source?: unknown;
    };
    roomId: string;
};

type SharedChatTranscriptProps = {
    memories: SharedChatMemory[];
    shareAgentId: string;
};

const getDisplayTextForMemory = (memory: SharedChatMemory): string => {
    const rawText = typeof memory.content?.text === "string" ? memory.content.text : "";
    return rawText && rawText.trim().length > 0 ? rawText : "";
};

const toContentWithUserMessages = (memories: SharedChatMemory[], shareAgentId: string): ContentWithUser[] => {
    return memories.map((memory) => {
        const displayText = getDisplayTextForMemory(memory);
        return {
            id: memory.id,
            text: displayText,
            user: memory.userId === shareAgentId ? "system" : "user",
            createdAt: memory.createdAt,
            userId: memory.userId,
            agentId: memory.agentId,
            roomId: memory.roomId,
            attachments: (memory.content as any)?.attachments,
            source: (memory.content as any)?.source,
            content: {
                ...memory.content,
                text: displayText,
            },
            metadata: (memory.content as any)?.metadata,
        } as unknown as ContentWithUser;
    });
};

export function SharedChatTranscript({ memories, shareAgentId }: SharedChatTranscriptProps) {
    const { theme } = useTheme();
    const deletedFiles = useMemo(() => new Set<string>(), []);
    const [taskSelectionByConversation, setTaskSelectionByConversation] = useState<Record<string, string | null>>({});
    const agentIconSrc = theme === "light" ? "/sentiedge-icon.jpg" : "/sentiedge-icon.png";

    const updateTaskSelectionForConversation = useCallback((conversationId: string, taskId: string | null) => {
        setTaskSelectionByConversation((prev) => {
            const normalized = taskId ?? null;
            const previous =
                conversationId in prev ? prev[conversationId] ?? null : undefined;
            if (previous !== undefined && previous === normalized) {
                return prev;
            }

            const next = { ...prev };
            if (normalized !== null && normalized !== "") {
                next[conversationId] = normalized;
            } else {
                next[conversationId] = null;
            }
            return next;
        });
    }, []);

    const conversations = useMemo(() => {
        const sorted = [...memories].sort((a, b) => a.createdAt - b.createdAt);
        const messages = toContentWithUserMessages(sorted, shareAgentId);
        return groupMessagesIntoConversations(messages);
    }, [memories, shareAgentId]);

    const renderMessage = useCallback(
        (message: ContentWithUser, index: number) => {
            const text = typeof message.text === "string" ? message.text.trim() : "";
            const hasMedia = hasSharedChatMedia((message as any)?.content);
            if (!text && !hasMedia) return null;

            const messageUser = (message as any)?.user;
            const isSystem = messageUser === "system" || messageUser === "assistant";
            const messageKey = String(message.id ?? message.createdAt ?? index);

            const anchorPrefixBase = `msg-${message.createdAt ?? "pending"}-${index}`;
            const sanitizedAnchorPrefixBase = anchorPrefixBase.replace(/[^a-zA-Z0-9_-]/g, "");
            const anchorPrefix = sanitizedAnchorPrefixBase ? `${sanitizedAnchorPrefixBase}-` : "";

            const chartPaths = getMessageChartPaths(message, deletedFiles);

            if (!isSystem) {
                return (
                    <div key={messageKey} className={cn("flex w-full", "justify-end")}>
                        <div className="w-fit max-w-[97%] sm:max-w-[92%] lg:max-w-[88%] xl:max-w-[84%] rounded-2xl px-3 sm:px-4 py-3 shadow-sm bg-blue-600 text-white">
                            <SharedChatMessageMedia content={(message as any)?.content} />
                            {text ? (
                                <div className="text-sm leading-relaxed whitespace-pre-wrap">{text}</div>
                            ) : null}
                        </div>
                    </div>
                );
            }

            const messageId = resolveMessageId(message);

            return (
                <div key={messageKey} className="flex flex-col gap-3 max-w-full min-w-0 overflow-hidden">
                    <div className="md:border md:border-muted/30 md:rounded-lg md:shadow-sm md:bg-gradient-to-br md:from-card/50 md:to-muted/10 max-w-full min-w-0 overflow-hidden">
                        <div className="py-2 md:p-4 max-w-full min-w-0">
                            <ChatBubble variant="received" className="flex flex-row items-center gap-2">
                                <Avatar className="hidden md:flex size-8 p-1 border rounded-full select-none">
                                    <AvatarImage src={agentIconSrc} />
                                </Avatar>
                                <div className="flex flex-col max-w-full min-w-0">
                                    <ChatBubbleMessage>
                                        <SharedChatMessageMedia content={(message as any)?.content} />
                                        {text ? (
                                            <MarkdownRenderer anchorPrefix={anchorPrefix}>
                                                {text}
                                            </MarkdownRenderer>
                                        ) : null}
                                        {chartPaths.length > 0 ? (
                                            <div className="w-full mt-6 space-y-4">
                                                {chartPaths.map((chartPath) => {
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
                                        ) : null}
                                    </ChatBubbleMessage>
                                    <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 sm:justify-between w-full mt-1">
                                        {text ? (
                                            <div className="flex items-center gap-1">
                                                <CopyButton text={text} />
                                            </div>
                                        ) : (
                                            <div />
                                        )}
                                        <div className="flex items-center justify-between gap-2 sm:gap-4 select-none w-full sm:w-auto">
                                            {(message as any)?.source ? (
                                                <Badge variant="outline">
                                                    {formatSourceName(String((message as any).source))}
                                                </Badge>
                                            ) : null}
                                            {typeof message.createdAt === "number" ? (
                                                <ChatBubbleTimestamp timestamp={moment(message.createdAt).format("LT")} />
                                            ) : null}
                                        </div>
                                    </div>
                                </div>
                            </ChatBubble>
                        </div>
                    </div>
                </div>
            );
        },
        [agentIconSrc, deletedFiles]
    );

    const renderConversation = useCallback(
        (conversation: ConversationPair) => {
            const taskChainData = getTaskChainData(conversation);
            const hasComprehensive = hasComprehensiveAnalysisMessages(conversation);

            if (hasComprehensive) {
                const comprehensiveData = getComprehensiveAnalysisData(conversation, {});
                const nonActionMessages = conversation.responses.filter((response) => {
                    if (isComprehensiveFinalNarrativeMessage(response)) {
                        return true;
                    }
                    const contentSource = (response as any)?.content?.source;
                    const directSource = (response as any)?.source;
                    return contentSource !== "comprehensive_analysis" && directSource !== "comprehensive_analysis";
                });

                return (
                    <div key={conversation.conversationId} className="space-y-4">
                        {renderMessage(conversation.userMessage, 0)}
                        {comprehensiveData.length > 0 ? (
                            <ComprehensiveActionTab
                                actionResults={comprehensiveData as any[]}
                                title="Comprehensive Analysis"
                                agentId={shareAgentId as UUID}
                                deletedFiles={deletedFiles}
                            />
                        ) : null}
                        {nonActionMessages.map((message, index) => renderMessage(message, index))}
                    </div>
                );
            }

            if (taskChainData) {
                const isComplete = taskChainData.tasks.every(
                    (task) => task.status === "completed" || task.status === "failed"
                );
                return (
                    <div key={conversation.conversationId} className="space-y-4">
                        {renderMessage(conversation.userMessage, 0)}
                        <TaskChainBubble taskChain={taskChainData} isComplete={isComplete} />
                        <TaskChainTabs
                            taskChainData={taskChainData}
                            messages={conversation.responses}
                            renderMessage={renderMessage}
                            selectedTaskId={taskSelectionByConversation[conversation.conversationId]}
                            onTaskSelect={(taskId) => updateTaskSelectionForConversation(conversation.conversationId, taskId)}
                            deletedFiles={deletedFiles}
                        />
                    </div>
                );
            }

            return (
                <div key={conversation.conversationId} className="space-y-4">
                    {renderMessage(conversation.userMessage, 0)}
                    {conversation.responses.map((message, index) => renderMessage(message, index))}
                </div>
            );
        },
        [deletedFiles, renderMessage, shareAgentId, taskSelectionByConversation, updateTaskSelectionForConversation]
    );

    if (conversations.length === 0) {
        return null;
    }

    return <div className="space-y-6">{conversations.map(renderConversation)}</div>;
}
