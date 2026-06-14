import { Button } from "@/components/ui/button";
import {
    ChatBubble,
    ChatBubbleMessage,
    ChatBubbleTimestamp,
} from "@/components/ui/chat/chat-bubble";
import { ChatInput } from "@/components/ui/chat/chat-input";
import { ChatMessageList } from "@/components/ui/chat/chat-message-list";

import { ArrowDown, Paperclip, Send, TrendingUp, X, ExternalLink, FileText, Square, BookmarkPlus, Link, Microscope } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent } from "react";
import { flushSync } from "react-dom";
import { useNavigate, useLocation } from "react-router-dom";
import type { UUID } from "@elizaos/core";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { cn, moment } from "@/lib/utils";
import { Avatar, AvatarImage } from "./ui/avatar";
import CopyButton from "./copy-button";
import ChatTtsButton from "./ui/chat/chat-tts-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { MarkdownWithTyping } from "./MarkdownWithTyping";
import type { IAttachment } from "@/types";
import { AudioRecorder } from "./audio-recorder";
import { Badge } from "./ui/badge";
import { useAutoScroll } from "./ui/chat/hooks/useAutoScroll";
import { SidebarTrigger } from "@/components/ui/sidebar";
import OnboardingDemoAnswersInline from "@/components/onboarding/OnboardingDemoAnswersInline";
import { ManualComposeDialog } from "@/components/cex/ManualComposeDialog";
import { StreamingApiClient, type FavoriteTaskChainPayload } from "../lib/api";
import { TaskChainBubble, type TaskChainData, type TaskUpdateData, type ChainUpdateData } from './TaskChainBubble';
import { TaskChainTabs, type TaskChainTabsRef } from './TaskChainTabs';
import { ActionTab } from './ActionTab';
import { ComprehensiveActionTab, type ComprehensiveActionTabRef } from './ComprehensiveActionTab';
import { TaskChainApprovalDialog } from './TaskChainApprovalDialog';
import { Dialog } from "./Dialog/Dialog";
import type { cexParamDef } from "@elizaos/core";
import type { HumanInputDialogData } from "./Dialog/HumanInputDialog";
import { MantleExecutionLinks } from "@/components/mantle/MantleExecutionLinks";
import { detectApprovalSurface } from "@/hooks/useApprovalRouter";
import { ChartSidebar } from './ChartSidebar';
import { ChartEmbed } from './ChartEmbed';
import { useAuth } from "@/contexts/AuthContext";
import { useTheme } from "@/contexts/ThemeContext";
import { LoginPrompt } from "@/components/auth/LoginPrompt";
import { FavoriteTaskChainsDialog } from './FavoriteTaskChainsDialog';
import { useFavoriteTaskChains, type FavoriteTaskChain } from '@/hooks/useFavoriteTaskChains';
import { PublicSharingPromptDialog, type PublicSharingChoice } from "./PublicSharingPromptDialog";
import { useQuotaStatus } from "@/hooks/useQuotaStatus";
import { ONBOARDING_DEMO_COMPARE_SOURCE } from "@/lib/onboarding";
import {
    formatSourceName,
    extractChartPaths,
    getChartId,
    getMessageChartPaths,
    parseMessageWithCharts,
    parseActionResults,
    resolveMessageId,
} from "./chat/message-utils";
import type { ContentWithUser } from "./chat/types";
import {
    getComprehensiveAnalysisData,
    getTaskChainData,
    groupMessagesIntoConversations,
    hasComprehensiveAnalysisMessages,
    hasComprehensiveSnapshotPayload,
    isComprehensiveFinalNarrativeMessage,
} from "./chat/conversation-utils";
import { MobileTocToggleButton } from "./MobileTocToggleButton";
import { useTranslation } from "react-i18next";

// Markdown container class - simplified since styling is now handled by MarkdownRenderer
const MARKDOWN_CONTAINER_CLASSES = "";

const ANON_LIMIT_ERROR_CODE = "ANON_DAILY_MESSAGE_LIMIT";
const ANON_DAILY_MESSAGE_LIMIT = 3;
const SHARE_CODE_REGEX = /^[A-Za-z0-9]{10}$/;
const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif)$/i;

type ClientInterruptBase = {
    type: string;
    threadId: string;
    interruptType?: string;
    createdAtMs: number;
};

type HumanInputInterrupt = ClientInterruptBase & {
    type: "human_input";
    payload: HumanInputDialogData;
};

// CEX post-PR237 cleanup — the `trading_approval` interrupt variant
// (former `CEXApprovalDialog` consumer) was retired. All trading
// approvals now route through `human_input` + the active
// `HumanInputDialog` / `TradingOrderEditor` UI. The union stays a
// union so future surfaces (chain approval, custom write actions)
// can opt in.
type ClientInterrupt = HumanInputInterrupt;

const normalizeChartPath = (path: string): string => path.replace(/\\/g, "/");

const getChartFileName = (chartPath: string): string => {
    const normalized = normalizeChartPath(chartPath);
    return normalized.split("/").pop() ?? chartPath;
};

const isImageAttachment = (attachment: IAttachment): boolean => {
    const contentType = attachment.contentType?.toLowerCase() || "";
    const hasImageContentType = contentType.includes("image");
    const hasImageExtension = IMAGE_EXTENSION_REGEX.test(attachment.url.toLowerCase());

    // Debug logging (commented out for production, uncomment for debugging)
    // console.log('[isImageAttachment]', {
    //     contentType,
    //     hasImageContentType,
    //     hasImageExtension,
    //     url: attachment.url?.substring(0, 50)
    // });

    return hasImageContentType || hasImageExtension;
};

export default function Page({ agentId, roomId }: { agentId: UUID; roomId: UUID }) {
    const navigate = useNavigate();
    const location = useLocation();
    const { toast } = useToast();
    const { t, i18n } = useTranslation();
    const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
    const [input, setInput] = useState("");
    const [isDeepResearchMode, setIsDeepResearchMode] = useState(false);
    // F10 — manual Trade compose dialog. When `composeOpen` is true the
    // user can fill in the order form without typing natural language;
    // submitting prefills `input` with a deterministic NL prompt that
    // goes through the existing CEX workflow. The `composedPayloadRef`
    // carries the structured `create_order` parameters alongside the NL
    // prompt so the server-side handler can short-circuit the LLM.
    const [composeOpen, setComposeOpen] = useState(false);
    // F10.2 — `preApproved` rides along when the compose dialog already
    // collected the "I confirm…" gate; the server skips emitting a
    // redundant human_input_required modal.
    const composedPayloadRef = useRef<{
        action: string;
        parameters: Record<string, unknown>;
        preApproved?: boolean;
    } | null>(null);
    const initialMessageHandledRef = useRef(false);
    const onboardingDemoHandledRef = useRef(false);
    const [localChartPaths, setLocalChartPaths] = useState<string[]>([]);
    const [showAllCharts, setShowAllCharts] = useState(false);
    // Report links are now rendered inline in the comprehensive analysis
    // "Report Generation" step (see ComprehensiveActionTab.tsx). The legacy
    // "Generated Reports" pill row that lived above the composer has been
    // retired, so no top-level state is needed here anymore.
    const [deletedFiles, setDeletedFiles] = useState<Set<string>>(new Set());

    const [finishedTyping, setFinishedTyping] = useState<Set<string>>(new Set()); // Track which messages have finished typing
    /** While true, render full message bodies (incl. charts) for DOM share export — fixes task-tab index vs conversation index key mismatch. */
    const [shareExportLayout, setShareExportLayout] = useState(false);
    const [taskUpdates, setTaskUpdates] = useState<TaskUpdateData[]>([]); // Store task updates for real-time bubbles
    const [chainUpdates, setChainUpdates] = useState<ChainUpdateData[]>([]); // Store chain updates for real-time structure changes
    const [liveChainByChainId, setLiveChainByChainId] = useState<Record<string, TaskChainData>>({}); // Current chain state from streaming (chain_state)
    const [conversationIdToChainId, setConversationIdToChainId] = useState<Record<string, string>>({}); // Map conversation to chainId for in-progress chains
    const [realtimeActionResults, setRealtimeActionResults] = useState<{[key: string]: any[]}>({}); // Store real-time action results by conversation
    const [taskSelectionByConversation, setTaskSelectionByConversation] = useState<Record<string, string | null>>({});

    // Trading approval state
    const [pendingInterrupt, setPendingInterrupt] = useState<ClientInterrupt | null>(null);

    // Task chain approval state
    const [showApprovalDialog, setShowApprovalDialog] = useState(false);
    const [pendingApproval, setPendingApproval] = useState<{
        threadId: string;
        taskChain: TaskChainData;
        fullTaskChain: unknown;
    } | null>(null);
    const [isRegeneratingChain, setIsRegeneratingChain] = useState(false);
    const isRegeneratingChainRef = useRef<boolean>(false); // Use ref to track latest value in callbacks
    const previousTaskChainIdRef = useRef<string | null>(null); // Track previous task chain ID to detect changes
    const approvedChainIdsRef = useRef<Set<string>>(new Set());

    const [hasMore, setHasMore] = useState(false);
    const [oldestId, setOldestId] = useState<string | undefined>();
    const [isLoadingMore, setIsLoadingMore] = useState(false);

    const inputRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const formRef = useRef<HTMLFormElement>(null);
    const shareLookupInProgressRef = useRef(false);
    const comprehensiveActionTabRefs = useRef<Map<string, ComprehensiveActionTabRef>>(new Map());
    const taskChainTabsRefs = useRef<Map<string, TaskChainTabsRef>>(new Map());
    const conversationRefs = useRef<Record<string, HTMLDivElement | null>>({});
    const userMessageRefs = useRef<Record<string, HTMLDivElement | null>>({});
    const lastScrolledRoomRef = useRef<string | null>(null);
    const pendingScrollRoomRef = useRef<string | null>(null);
    /** When server sends room_created (e.g. after sending to a deleted room), stream callbacks use this for cache key. */
    const effectiveRoomIdRef = useRef(roomId);

    const setConversationRef = useCallback(
        (conversationId: string, element: HTMLDivElement | null) => {
            if (element) {
                conversationRefs.current[conversationId] = element;
            } else {
                delete conversationRefs.current[conversationId];
            }
        },
        [],
    );

    const setUserMessageRef = useCallback((messageKey: string, element: HTMLDivElement | null) => {
        if (element) {
            userMessageRefs.current[messageKey] = element;
        } else {
            delete userMessageRefs.current[messageKey];
        }
    }, []);

    // Collapsible input area state
    const [isInputCollapsed, setIsInputCollapsed] = useState(false);
    const collapseTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    /** Deferred history sync after SSE `[DONE]` (comprehensive closes stream before DB has final snapshot). */
    const postStreamHistorySyncTimeoutsRef = useRef<number[]>([]);
    const lastShareCodeRef = useRef<string | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [showDailyLimitPrompt, setShowDailyLimitPrompt] = useState(false);

    // Favorite task chains state
    const [selectedFavoriteChain, setSelectedFavoriteChain] = useState<FavoriteTaskChain | null>(null);
    const [showFavoritesDialog, setShowFavoritesDialog] = useState(false);
    const favoriteTaskChains = useFavoriteTaskChains(agentId);
    const baseAddFavorite = favoriteTaskChains.addFavorite;
    const [isPublicSharingPromptOpen, setIsPublicSharingPromptOpen] = useState(false);
    const pendingSharingResolverRef = useRef<((choice: PublicSharingChoice) => void) | null>(null);

    // Quota status tracking
    const { quotaStatus, isLimitedUser, refetch: refetchQuota } = useQuotaStatus(agentId);

    const requestPublicSharingDecision = useCallback(
        () =>
            new Promise<PublicSharingChoice>((resolve) => {
                pendingSharingResolverRef.current = resolve;
                setIsPublicSharingPromptOpen(true);
            }),
        []
    );

    const handlePublicSharingDecision = useCallback((choice: PublicSharingChoice) => {
        const resolver = pendingSharingResolverRef.current;
        pendingSharingResolverRef.current = null;
        setIsPublicSharingPromptOpen(false);
        resolver?.(choice);
    }, []);

    const handleAddFavoriteWithPrompt = useCallback(
        async (taskChain: TaskChainData, customName?: string) => {
            const choice = await requestPublicSharingDecision();
            const isPublic = choice === "public";

            return baseAddFavorite(taskChain, customName, {
                isPublic,
            });
        },
        [baseAddFavorite, requestPublicSharingDecision]
    );

    useEffect(() => {
        return () => {
            if (pendingSharingResolverRef.current) {
                pendingSharingResolverRef.current("private");
                pendingSharingResolverRef.current = null;
            }
        };
    }, []);


    const favoriteTaskChainsWithSharingPrompt = useMemo(
        () => ({
            ...favoriteTaskChains,
            addFavorite: handleAddFavoriteWithPrompt,
        }),
        [favoriteTaskChains, handleAddFavoriteWithPrompt]
    );

    const { markAsUsed, fetchSharedChainByCode } =
        favoriteTaskChainsWithSharingPrompt;

    const handleShareCodeAttachment = useCallback(
        async (code: string) => {
            const normalizedCode = code.trim().toUpperCase();
            if (!SHARE_CODE_REGEX.test(normalizedCode)) {
                toast({
                    title: t("chat.invalidShareCodeTitle"),
                    description: t("chat.invalidShareCodeDescription"),
                    variant: "destructive",
                });
                return;
            }

            if (shareLookupInProgressRef.current) {
                toast({
                    title: t("chat.pleaseWaitTitle"),
                    description: t("chat.pleaseWaitDescription"),
                });
                return;
            }

            if (lastShareCodeRef.current === normalizedCode) {
                toast({
                    title: t("chat.alreadyAttachedTitle"),
                    description: t("chat.alreadyAttachedDescription"),
                });
                return;
            }

            shareLookupInProgressRef.current = true;

            try {
                const sharedChain = await fetchSharedChainByCode(normalizedCode);

                if (!sharedChain) {
                    toast({
                        title: t("chat.shareCodeNotFoundTitle"),
                        description: t("chat.shareCodeNotFoundDescription"),
                        variant: "destructive",
                    });
                    return;
                }

                const isDifferentAgent =
                    Boolean(sharedChain.agentId) &&
                    Boolean(agentId) &&
                    sharedChain.agentId !== agentId;

                const favoriteFromShare: FavoriteTaskChain = {
                    favoriteId: sharedChain.favoriteId ?? sharedChain.shareId,
                    id: sharedChain.chainId,
                    name: sharedChain.name,
                    originalName: sharedChain.originalName,
                    description: sharedChain.description,
                    taskChain: sharedChain.taskChain,
                    createdAt: sharedChain.createdAt,
                    source: "shared",
                    shareCode: sharedChain.shareCode,
                    sharedAgentId: sharedChain.agentId,
                    isPublic: false,
                };

                setSelectedFavoriteChain(favoriteFromShare);
                setInput("");
                lastShareCodeRef.current = normalizedCode;

                toast({
                    title: t("chat.sharedChainAttachedTitle"),
                    description: isDifferentAgent
                        ? t("chat.sharedChainDifferentAgentDescription", { name: sharedChain.name })
                        : t("chat.sharedChainDescription", { name: sharedChain.name }),
                });
            } catch (error) {
                console.error("Failed to fetch shared task chain:", error);
                toast({
                    title: t("chat.shareLookupFailedTitle"),
                    description: t("chat.shareLookupFailedDescription"),
                    variant: "destructive",
                });
            } finally {
                shareLookupInProgressRef.current = false;
            }
        },
        [agentId, fetchSharedChainByCode, toast]
    );

    const queryClient = useQueryClient();

    // Handle initial message from landing page
    useEffect(() => {
        const state = location.state as {
            initialMessage?: string;
            initialFiles?: File[];
            initialShareCode?: string;
            initialFavoriteTaskChain?: FavoriteTaskChain;
            onboardingDemo?: { question?: string };
        } | null;

        if (!state) {
            return;
        }

        let shouldClearState = false;

        if (state.onboardingDemo && !onboardingDemoHandledRef.current) {
            const question = state.onboardingDemo.question?.trim() ?? "";
            if (question) {
                const now = Date.now();
                const demoMessages: ContentWithUser[] = [
                    {
                        id: `onboarding-demo-user-${now}`,
                        user: "user",
                        text: question,
                        createdAt: now,
                        attachments: [],
                    } as ContentWithUser,
                    {
                        id: `onboarding-demo-compare-${now + 1}`,
                        user: "system",
                        text: "",
                        createdAt: now + 1,
                        content: { source: ONBOARDING_DEMO_COMPARE_SOURCE } as any,
                        source: ONBOARDING_DEMO_COMPARE_SOURCE as any,
                    } as ContentWithUser,
                ];

                queryClient.setQueryData<ContentWithUser[]>(["messages", agentId, roomId], (previous) => {
                    const existing = Array.isArray(previous) ? previous : [];
                    return existing.length ? [...existing, ...demoMessages] : demoMessages;
                });

                onboardingDemoHandledRef.current = true;
                shouldClearState = true;
            }
        }

        if (state.initialMessage && !initialMessageHandledRef.current && !isProcessing) {
            setInput(state.initialMessage);
            if (state.initialFiles) {
                setSelectedFiles(state.initialFiles);
            }

            initialMessageHandledRef.current = true;
            shouldClearState = true;

            setTimeout(() => {
                if (formRef.current) {
                    formRef.current.requestSubmit();
                }
            }, 500);
        }

        if (state.initialShareCode) {
            void handleShareCodeAttachment(state.initialShareCode);
            shouldClearState = true;
        }

        if (state.initialFavoriteTaskChain) {
            setSelectedFavoriteChain(state.initialFavoriteTaskChain);
            shouldClearState = true;
        }

        if (shouldClearState) {
            navigate(location.pathname, { replace: true, state: {} });
        }
    }, [
        location.pathname,
        location.state,
        isProcessing,
        navigate,
        handleShareCodeAttachment,
        setSelectedFavoriteChain,
        agentId,
        roomId,
        queryClient,
    ]);

    useEffect(() => {
        conversationRefs.current = {};
        userMessageRefs.current = {};

        if (!roomId) {
            pendingScrollRoomRef.current = null;
            lastScrolledRoomRef.current = null;
            return;
        }

        if (lastScrolledRoomRef.current !== roomId) {
            pendingScrollRoomRef.current = roomId;
            lastScrolledRoomRef.current = null;
        }
    }, [roomId]);

    useEffect(() => {
        effectiveRoomIdRef.current = roomId;
    }, [roomId]);

    const handleRoomUpdate = useCallback(
        (updatedRoom: { id: string; name: string }) => {
            const targetRoomId = effectiveRoomIdRef.current ?? roomId;
            const isNewRoomFromServer = updatedRoom.id !== targetRoomId;

            if (isNewRoomFromServer) {
                effectiveRoomIdRef.current = updatedRoom.id as UUID;
                const existingMessages = queryClient.getQueryData<ContentWithUser[]>([
                    "messages",
                    agentId,
                    roomId,
                ]);
                if (existingMessages?.length) {
                    queryClient.setQueryData(
                        ["messages", agentId, updatedRoom.id],
                        existingMessages
                    );
                }
                queryClient.invalidateQueries({ queryKey: ["rooms", agentId] });
                navigate(`/chat/${agentId}/${updatedRoom.id}`, { replace: true });
                return;
            }

            queryClient.setQueryData(
                ["rooms", agentId],
                (
                    previous:
                        | {
                              success: boolean;
                              rooms: Array<{
                                  id: string;
                                  name: string;
                                  lastMessage: { text: string; createdAt: number } | null;
                                  messageCount: number;
                              }>;
                          }
                        | undefined,
                ) => {
                    if (!previous || !Array.isArray(previous.rooms)) {
                        return previous;
                    }

                    let hasChange = false;
                    const updatedRooms = previous.rooms.map((room) => {
                        if (room.id === updatedRoom.id && room.name !== updatedRoom.name) {
                            hasChange = true;
                            return {
                                ...room,
                                name: updatedRoom.name,
                            };
                        }
                        return room;
                    });

                    if (!hasChange) {
                        return previous;
                    }

                    return {
                        ...previous,
                        rooms: updatedRooms,
                    };
                },
            );
        },
        [agentId, queryClient, navigate, roomId],
    );

    const streamingApiClient = useMemo(() => new StreamingApiClient(), []);

    const { isAuthenticated } = useAuth();
    const { theme } = useTheme();
    const agentIconSrc = theme === "light" ? "/sentiedge-icon.jpg" : "/sentiedge-icon.png";
    const prevAuthStatusRef = useRef<boolean | null>(isAuthenticated);
    const skipReloadAfterLogoutRef = useRef(false);

    useEffect(() => {
        if (prevAuthStatusRef.current && !isAuthenticated) {
            queryClient.setQueryData(["messages", agentId, roomId], []);
            setTaskUpdates([]);
            setChainUpdates([]);
            setLiveChainByChainId({});
            setConversationIdToChainId({});
            setRealtimeActionResults({});
            setFinishedTyping(new Set());
            setLocalChartPaths([]);
            setDeletedFiles(new Set());
            setTaskSelectionByConversation({});
            isRegeneratingChainRef.current = false;
            previousTaskChainIdRef.current = null;
            setIsRegeneratingChain(false);
            setShowApprovalDialog(false);
            setPendingApproval(null);
            setSelectedFavoriteChain(null);
            setShowFavoritesDialog(false);
            setIsDeepResearchMode(false);
        }
        prevAuthStatusRef.current = isAuthenticated;
    }, [agentId, roomId, isAuthenticated, queryClient]);

    useEffect(() => {
        setIsDeepResearchMode(false);
    }, [agentId, roomId]);

    // Reset processing state when switching rooms — Chat component is not remounted on room navigation
    useEffect(() => {
        setIsProcessing(false);
        setPendingApproval(null);
        setShowApprovalDialog(false);
        isRegeneratingChainRef.current = false;
        setIsRegeneratingChain(false);
        setTaskUpdates([]);
        setChainUpdates([]);
        setLiveChainByChainId({});
        setConversationIdToChainId({});
        setRealtimeActionResults({});
        setTaskSelectionByConversation({});
        setHasMore(false);
        setOldestId(undefined);
        setIsLoadingMore(false);
    }, [roomId]);

    // After resetting room state, probe the server for any in-flight
    // workflow (comprehensive analysis, task-chain approval, CEX approval).
    // If one is running we rehydrate `isProcessing` so the Stop button
    // reappears across page refresh / room navigation. The /stop endpoint
    // is agent-wide today, so clicking Stop will terminate the active job
    // regardless of which client originally launched it. Live SSE token
    // replay is intentionally NOT attempted (SSE is request-scoped) — the
    // final result lands via the persisted-only delivery path.
    useEffect(() => {
        if (!agentId || !roomId) return;
        let cancelled = false;
        apiClient.getActiveWorkflow(agentId, roomId)
            .then((result) => {
                if (cancelled) return;
                if (result.active) {
                    setIsProcessing(true);
                    toast({
                        title: t("chat.workflowInProgressTitle"),
                        description: t("chat.workflowInProgressDescription"),
                    });
                }
            })
            .catch((err) => {
                // Silent fail — Stop button just won't appear; matches the
                // pre-rehydration behavior so this never makes things worse.
                console.warn("[chat] active-workflow check failed", err);
            });
        return () => { cancelled = true; };
    }, [agentId, roomId, t, toast]);

    useEffect(() => {
        if (!selectedFavoriteChain) {
            lastShareCodeRef.current = null;
        }
    }, [selectedFavoriteChain]);

    useEffect(() => {
        if (localChartPaths.length <= 4 && showAllCharts) {
            setShowAllCharts(false);
        }
    }, [localChartPaths.length, showAllCharts]);

    // Cleanup collapse timeout on unmount
    useEffect(() => {
        return () => {
            if (collapseTimeoutRef.current) {
                clearTimeout(collapseTimeoutRef.current);
            }
        };
    }, []);

    // Handle regenerating state update after new task chain data is loaded
    useEffect(() => {
        if (!isRegeneratingChain || !pendingApproval || !pendingApproval.taskChain) {
            return;
        }

        const currentTaskChainId = pendingApproval.taskChain.id;
        const previousTaskChainId = previousTaskChainIdRef.current;

        // Only close regenerating state if we have a NEW task chain (different ID)
        if (previousTaskChainId && currentTaskChainId !== previousTaskChainId) {
            // Use requestAnimationFrame to ensure DOM has updated before closing loading state
            requestAnimationFrame(() => {
                isRegeneratingChainRef.current = false;
                setIsRegeneratingChain(false);

                toast({
                    title: t("chat.taskChainRegeneratedTitle"),
                    description: t("chat.taskChainRegeneratedDescription"),
                });
            });
        }

        // Update the tracked ID
        previousTaskChainIdRef.current = currentTaskChainId;
    }, [pendingApproval, isRegeneratingChain, toast]);

    const {
        scrollRef,
        isAtBottom,
        scrollToBottom,
        disableAutoScroll,
        enableAutoScroll,
    } = useAutoScroll({
        smooth: true,
        // Start with auto-scroll enabled so the message list snaps to the
        // bottom on initial mount (showing the most recent assistant
        // response) and continues to follow each new token / message
        // until the user manually scrolls up. The hook flips this back
        // off via disableAutoScroll on user-initiated scroll-up, so
        // pagination "load more older" still preserves position.
        initialEnabled: true,
    });

    // Report-link buttons used to live in this file (handleOpenReport /
    // handleDeleteReport powered the "Generated Reports" pill row above the
    // composer). They moved into ComprehensiveActionTab.tsx alongside the
    // Report Generation step's summary card; deleting reports from the chat
    // surface is no longer a user-facing action.

    const getFavoriteTaskChainLabel = (chain: FavoriteTaskChainPayload | Record<string, unknown> | null | undefined): string => {
        if (!chain || typeof chain !== "object") {
            return "";
        }

        const extractName = (candidate: unknown): string | undefined => {
            if (typeof candidate === "string" && candidate.trim().length > 0) {
                return candidate.trim();
            }
            return undefined;
        };

        const chainRecord = chain as Record<string, any>;
        const nestedTaskChain = chainRecord?.taskChain;
        const candidateNames = [
            extractName(chainRecord?.name),
            extractName(chainRecord?.originalName),
            extractName(nestedTaskChain?.name),
            extractName(nestedTaskChain?.originalName),
        ];

        const resolvedName = candidateNames.find((name): name is string => typeof name === "string" && name.length > 0);
        return resolvedName
            ? t("chat.favoriteTaskChainLabel", { name: resolvedName })
            : t("chat.favoriteTaskChain");
    };
   
    const messagesQuery = useQuery({
        queryKey: ["messages", agentId, roomId],
        queryFn: async () => {
            // Return the existing data if we have it - this is a cache-only query
            // since message updates come through streaming
            const existing = queryClient.getQueryData<ContentWithUser[]>(["messages", agentId, roomId]) || [];
            return existing;
        },
        staleTime: Number.POSITIVE_INFINITY, // Never mark as stale since updates come via streaming
        gcTime: Number.POSITIVE_INFINITY,
        initialData: [],
        refetchInterval: false, // Disable automatic refetch since updates come via streaming
    });

    const chatMessages = messagesQuery.data || [];

    // Transform backend Memory objects to frontend ContentWithUser format
    const transformMemoriesToMessages = (memories: any[]): ContentWithUser[] => {
        return memories.map((memory) => {
            const rawContent = memory.content?.text;
            const rawText: string = (() => {
                if (typeof rawContent === 'string') {
                    try {
                        const parsed = JSON.parse(rawContent);
                        if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') {
                            return parsed.text;
                        }
                    } catch {}
                    return rawContent;
                }
                if (rawContent && typeof rawContent === 'object' && typeof (rawContent as any).text === 'string') {
                    return (rawContent as any).text;
                }
                return String(rawContent ?? "");
            })();
            const favoriteTaskChainAttachment =
                memory.content?.favoriteTaskChain ??
                memory.content?.metadata?.favoriteTaskChain;

            const displayText =
                rawText && rawText.trim().length > 0
                    ? rawText
                    : favoriteTaskChainAttachment
                        ? getFavoriteTaskChainLabel(favoriteTaskChainAttachment as Record<string, unknown>)
                        : "";

            return {
                id: memory.id,
                text: displayText,
                user: memory.userId === agentId ? "system" : "user",
                createdAt: memory.createdAt,
                attachments: memory.content?.attachments,
                source: memory.content?.source,
                content: {
                    ...memory.content,
                    text: displayText
                },
                metadata: memory.content?.metadata,
                ...memory
            };
        });
    };

    const loadMessageHistory = useCallback(
        async (forceFetch = false, mergeProvisionalNarrative = false) => {
            if (!agentId || !roomId) {
                return;
            }

            if (skipReloadAfterLogoutRef.current && !forceFetch) {
                skipReloadAfterLogoutRef.current = false;
                return;
            }

            skipReloadAfterLogoutRef.current = false;

            const existingMessages = queryClient.getQueryData<ContentWithUser[]>([
                "messages",
                agentId,
                roomId,
            ]);

            if (!forceFetch && existingMessages && existingMessages.length > 0) {
                return;
            }

            try {
                const response = await apiClient.getMessages(agentId, roomId, { limit: 50 });

                const historicalMessages = transformMemoriesToMessages(response.messages || response.memories || []);

                historicalMessages.sort((a, b) => a.createdAt - b.createdAt);

                let nextMessages = historicalMessages;

                if (mergeProvisionalNarrative && existingMessages?.length) {
                    const serverHasCanonicalSnapshot = historicalMessages.some((m) =>
                        hasComprehensiveSnapshotPayload(
                            (m as unknown as { content?: { metadata?: unknown } }).content?.metadata,
                        ),
                    );
                    const provisional = existingMessages.filter((m) => {
                        const meta = (m as unknown as { content?: { metadata?: Record<string, unknown> } }).content
                            ?.metadata as { comprehensiveFinalNarrative?: unknown } | undefined;
                        return Boolean(meta?.comprehensiveFinalNarrative);
                    });
                    const serverIds = new Set(historicalMessages.map((m) => m.id));
                    const append = provisional.filter((p) => !serverIds.has(p.id));
                    nextMessages = serverHasCanonicalSnapshot
                        ? historicalMessages
                        : [...historicalMessages, ...append];
                    nextMessages.sort((a, b) => a.createdAt - b.createdAt);
                }

                queryClient.setQueryData(["messages", agentId, roomId], nextMessages);
                setHasMore(response.hasMore ?? false);
                setOldestId(response.oldestId);
            } catch (error) {
                console.error('Failed to load message history:', error);

                const errorWithStatus = error as { status?: number } | undefined;
                const statusCode = errorWithStatus?.status;

                if (statusCode === 401) {
                    queryClient.setQueryData(["messages", agentId, roomId], []);
                    setTaskUpdates([]);
                    setChainUpdates([]);
                    setLiveChainByChainId({});
                    setConversationIdToChainId({});
                    setRealtimeActionResults({});
                    setFinishedTyping(new Set());
                    setLocalChartPaths([]);
                    setDeletedFiles(new Set());
                    isRegeneratingChainRef.current = false;
                    previousTaskChainIdRef.current = null;
                    setIsRegeneratingChain(false);
                    setShowApprovalDialog(false);
                    setPendingApproval(null);

                    toast({
                        title: t("chat.signInRequiredTitle"),
                        description: t("chat.signInRequiredDescription"),
                    });

                    navigate("/signin");
                    return;
                }

                if (statusCode === 403) {
                    queryClient.setQueryData(["messages", agentId, roomId], []);

                    // Anonymous visitor on a room they don't own (e.g. shared
                    // URL or stale session): treat like 401 — clear local
                    // state and bounce to signin. Authenticated users stay
                    // put with a toast (the room may belong to another
                    // account they're aware of, or re-assignment is pending).
                    if (!isAuthenticated) {
                        setTaskUpdates([]);
                        setChainUpdates([]);
                        setLiveChainByChainId({});
                        setConversationIdToChainId({});
                        setRealtimeActionResults({});
                        setFinishedTyping(new Set());
                        setLocalChartPaths([]);
                        setDeletedFiles(new Set());
                        isRegeneratingChainRef.current = false;
                        previousTaskChainIdRef.current = null;
                        setIsRegeneratingChain(false);
                        setShowApprovalDialog(false);
                        setPendingApproval(null);

                        toast({
                            title: t("chat.signInRequiredTitle"),
                            description: t("chat.signInRequiredDescription"),
                        });

                        navigate("/signin");
                        return;
                    }

                    toast({
                        title: t("chat.historyUnavailableTitle"),
                        description: t("chat.historyUnavailableDescription"),
                        variant: "destructive",
                    });
                    return;
                }
            }
        },
        [agentId, roomId, queryClient, navigate, toast, isAuthenticated],
    );

    useEffect(() => {
        return () => {
            postStreamHistorySyncTimeoutsRef.current.forEach((id) => clearTimeout(id));
            postStreamHistorySyncTimeoutsRef.current = [];
        };
    }, [agentId, roomId]);

    const loadMoreMessages = useCallback(async () => {
        if (!hasMore || isLoadingMore || !oldestId || !agentId || !roomId) return;
        setIsLoadingMore(true);
        const container = scrollRef.current;
        const prevScrollHeight = container?.scrollHeight ?? 0;
        try {
            const response = await apiClient.getMessages(agentId, roomId, { limit: 50, before: oldestId });
            const olderMessages = transformMemoriesToMessages(response.messages || []);
            olderMessages.sort((a, b) => a.createdAt - b.createdAt);
            queryClient.setQueryData(["messages", agentId, roomId], (prev: ContentWithUser[] | undefined) =>
                [...olderMessages, ...(prev ?? [])]
            );
            setHasMore(response.hasMore ?? false);
            setOldestId(response.oldestId);
            requestAnimationFrame(() => {
                if (container) {
                    container.scrollTop += container.scrollHeight - prevScrollHeight;
                }
            });
        } catch (error) {
            console.error('Failed to load older messages:', error);
        } finally {
            setIsLoadingMore(false);
        }
    }, [hasMore, isLoadingMore, oldestId, agentId, roomId, queryClient, scrollRef, transformMemoriesToMessages]);

    useEffect(() => {
        const container = scrollRef.current;
        if (!container) return;
        const handleScroll = () => {
            if (container.scrollTop < 100 && hasMore && !isLoadingMore) {
                loadMoreMessages();
            }
        };
        container.addEventListener('scroll', handleScroll, { passive: true });
        return () => container.removeEventListener('scroll', handleScroll);
    }, [hasMore, isLoadingMore, loadMoreMessages, scrollRef]);

    useEffect(() => {
        loadMessageHistory();
    }, [loadMessageHistory]);

    useEffect(() => {
        const handleHistoryCleared = (event: Event) => {
            const detail = (event as CustomEvent<{ isAuthenticated?: boolean }>).detail;
            const shouldReload = detail?.isAuthenticated === true;

            queryClient.removeQueries({ queryKey: ["messages", agentId, roomId] });
            queryClient.removeQueries({ queryKey: ["messages", agentId] });
            queryClient.removeQueries({ queryKey: ["messages"] });

            queryClient.setQueryData(["messages", agentId, roomId], []);
            setTaskUpdates([]);
            setChainUpdates([]);
            setLiveChainByChainId({});
            setConversationIdToChainId({});
            setRealtimeActionResults({});
            setFinishedTyping(new Set());
            setLocalChartPaths([]);
            setDeletedFiles(new Set());
            isRegeneratingChainRef.current = false;
            previousTaskChainIdRef.current = null;
            setIsRegeneratingChain(false);
            setShowApprovalDialog(false);
            setPendingApproval(null);
            skipReloadAfterLogoutRef.current = !shouldReload;
            if (shouldReload) {
                loadMessageHistory(true);
            } else {
                navigate(`/chat/${agentId}`);
            }
        };

        if (typeof window !== "undefined") {
            window.addEventListener("sentiedge:history-cleared", handleHistoryCleared);
        }

        return () => {
            if (typeof window !== "undefined") {
                window.removeEventListener("sentiedge:history-cleared", handleHistoryCleared);
            }
        };
    }, [agentId, roomId, queryClient, loadMessageHistory, navigate]);


    // Update chart paths when messages change. Report paths used to be
    // collected here too to feed the legacy "Generated Reports" pill row above
    // the composer; now report links live inside the comprehensive analysis
    // Report Generation step (see ComprehensiveActionTab.tsx) and don't need
    // a chat-wide aggregate here.
    useEffect(() => {
        const allChartPaths: string[] = [];
        const addChartPath = (path: string) => {
            let relativePath = path;
            if (path.includes("saved_data")) {
                const savedDataIndex = path.indexOf("saved_data");
                relativePath = path.substring(savedDataIndex);
            }
            if (!allChartPaths.includes(relativePath) && !deletedFiles.has(relativePath)) {
                allChartPaths.push(relativePath);
            }
        };

        chatMessages.forEach((message) => {
            if (message.user !== "user") {
                // Use standard format: content.metadata
                const metadata = (message as any).content?.metadata;

                // Check for chartPath in metadata
                let chartPathFromMetadata = false;
                const content = (message as { content?: Record<string, unknown> }).content;
                
                if (metadata) {
                    // Check for single chartPath in metadata
                    if (metadata.chartPath) {
                        const chartPath = metadata.chartPath as string;
                        addChartPath(chartPath);
                        chartPathFromMetadata = true;
                    }

                    // Check for chartPaths array (from task chain summaries)
                    if (metadata.chartPaths && Array.isArray(metadata.chartPaths)) {
                        metadata.chartPaths.forEach((chartPath: string) => {
                            addChartPath(chartPath);
                            chartPathFromMetadata = true;
                        });
                    }

                    // Extract chart paths from task chain snapshot execution results (for refresh)
                    const taskChainSnapshot = (metadata as Record<string, any>).taskChainSnapshot;
                    if (taskChainSnapshot?.executionResults && Array.isArray(taskChainSnapshot.executionResults)) {
                        taskChainSnapshot.executionResults.forEach((result: any) => {
                            const resultMetadata = result?.result?.content?.metadata;
                            if (!resultMetadata) return;
                            if (typeof resultMetadata.chartPath === "string") {
                                addChartPath(resultMetadata.chartPath);
                                chartPathFromMetadata = true;
                            }
                            if (Array.isArray(resultMetadata.chartPaths)) {
                                resultMetadata.chartPaths.forEach((chartPath: string) => {
                                    addChartPath(chartPath);
                                    chartPathFromMetadata = true;
                                });
                            }
                        });
                    }

                    // Slim snapshot path: after refresh the API drops full
                    // executionResults and ships executionResultSummaries with
                    // chartPath / chartPaths hoisted to the top of each entry.
                    if (Array.isArray(taskChainSnapshot?.executionResultSummaries)) {
                        taskChainSnapshot.executionResultSummaries.forEach((entry: any) => {
                            if (!entry) return;
                            if (typeof entry.chartPath === "string") {
                                addChartPath(entry.chartPath);
                                chartPathFromMetadata = true;
                            }
                            if (Array.isArray(entry.chartPaths)) {
                                entry.chartPaths.forEach((chartPath: string) => {
                                    if (typeof chartPath === "string") {
                                        addChartPath(chartPath);
                                        chartPathFromMetadata = true;
                                    }
                                });
                            }
                        });
                    }
                }

                // Also check content.chartPath and content.visualizations (StandardActionResponse format)
                if (content) {
                    if (typeof content.chartPath === "string") {
                        addChartPath(content.chartPath);
                        chartPathFromMetadata = true;
                    }

                    // Extract from content.visualizations
                    if (content.visualizations && typeof content.visualizations === "object") {
                        const visualizations = content.visualizations as Record<string, unknown>;
                        if (typeof visualizations.interactive_chart === "string") {
                            addChartPath(visualizations.interactive_chart);
                            chartPathFromMetadata = true;
                        }
                        // Check for other chart-related fields in visualizations
                        for (const [key, value] of Object.entries(visualizations)) {
                            if (key.includes("chart") && typeof value === "string") {
                                addChartPath(value);
                                chartPathFromMetadata = true;
                            }
                        }
                    }
                }
                
                // Extract paths from message text only if not found in metadata (to avoid duplicates)
                if (message.text) {
                    if (!chartPathFromMetadata) {
                        const chartPaths = extractChartPaths(message.text);
                        chartPaths.forEach(path => {
                            if (!allChartPaths.includes(path) && !deletedFiles.has(path)) {
                                allChartPaths.push(path);
                            }
                        });
                    }
                }
            }
        });

        setLocalChartPaths(allChartPaths);
    }, [chatMessages, deletedFiles]);

    useEffect(() => {
        scrollToBottom();
    }, [queryClient.getQueryData(["messages", agentId, roomId])]);

    useEffect(() => {
        scrollToBottom();
    }, []);

    const findChartAnchorId = useCallback((chartPath: string): string | null => {
        const targetFileName = getChartFileName(chartPath);
        const normalizedTarget = normalizeChartPath(chartPath);

        for (let index = chatMessages.length - 1; index >= 0; index -= 1) {
            const message = chatMessages[index];
            const messageCharts = getMessageChartPaths(message, deletedFiles);
            const hasMatch = messageCharts.some((messageChart) => {
                const normalizedMessageChart = normalizeChartPath(messageChart);
                if (normalizedMessageChart === normalizedTarget) {
                    return true;
                }
                const messageFileName = getChartFileName(normalizedMessageChart);
                return messageFileName === targetFileName;
            });

            if (hasMatch) {
                const messageId = resolveMessageId(message);
                if (messageId !== undefined) {
                    return getChartId(messageId, chartPath);
                }
            }
        }

        return null;
    }, [chatMessages, deletedFiles]);

    const findChartElementByFileName = useCallback((chartPath: string): Element | null => {
        if (typeof document === "undefined") return null;

        const fullFileName = getChartFileName(chartPath);
        const fileName = fullFileName.replace(/\.(html|png)$/i, "");
        if (!fileName) {
            // [DIAG chart-jump] Remove once "Chart not visible here" toast issue is resolved.
            console.log("[chart-jump] empty fileName", { chartPath, fullFileName });
            return null;
        }

        // Walk every chart anchor in the DOM and match by basename in JS.
        // Going through `[id$="…"]` drags us into CSS attribute-selector
        // string-escape territory, which has bitten this lookup before on
        // names with `&` and `~`. Plain string `endsWith` sidesteps it.
        const suffix = `-${fileName}`;
        const idCandidates = document.querySelectorAll('[id^="chart-"]');
        const renderedChartIds: string[] = [];
        for (const el of idCandidates) {
            renderedChartIds.push(el.id);
            if (el.id.endsWith(suffix)) {
                // [DIAG chart-jump] Remove once "Chart not visible here" toast issue is resolved.
                console.log("[chart-jump] match via chart-anchor id", { chartPath, fullFileName, fileName, suffix, matchedId: el.id });
                return el;
            }
        }

        // Fallback: chart may be rendered as a markdown <img> or a plain
        // <iframe> outside a ChartEmbed wrapper (e.g., when its source is
        // a summary-only synthetic message whose metadata does not carry
        // the chart path, or any other path that bypasses ChartEmbed).
        // Match by src filename, anchored on a path separator so
        // `bar-foo.png` doesn't false-match a search for `foo.png`.
        const endsWithName = (path: string, name: string): boolean =>
            path === name || path.endsWith("/" + name) || path.endsWith("\\" + name);

        const mediaCandidates = document.querySelectorAll("img[src], iframe[src]");
        const mediaSrcs: string[] = [];
        for (const el of mediaCandidates) {
            const src = el.getAttribute("src") ?? "";
            const srcPath = src.split(/[?#]/)[0];
            mediaSrcs.push(srcPath);
            if (
                endsWithName(srcPath, fullFileName) ||
                endsWithName(srcPath, fileName)
            ) {
                // [DIAG chart-jump] Remove once "Chart not visible here" toast issue is resolved.
                console.log("[chart-jump] match via media fallback", { chartPath, fullFileName, fileName, matchedSrc: srcPath });
                return el;
            }
        }

        // [DIAG chart-jump] Nothing matched. Remove once "Chart not visible here" toast issue is resolved.
        console.log("[chart-jump] NO MATCH", {
            chartPath,
            fullFileName,
            fileName,
            suffix,
            renderedChartIdsCount: renderedChartIds.length,
            renderedChartIds: renderedChartIds.slice(0, 30),
            mediaSrcsCount: mediaSrcs.length,
            mediaSrcs: mediaSrcs.slice(0, 30),
        });

        return null;
    }, []);

    const scrollToChart = useCallback((chartPath: string): boolean => {
        if (typeof document === "undefined") return false;

        const chartId = findChartAnchorId(chartPath);
        const element = chartId ? document.getElementById(chartId) : null;
        const target = element ?? findChartElementByFileName(chartPath);

        if (!target) {
            return false;
        }

        target.scrollIntoView({ behavior: "smooth", block: "center" });
        return true;
    }, [findChartAnchorId, findChartElementByFileName]);

    const scrollToChartWithRetry = useCallback(async (chartPath: string, timeoutMs: number): Promise<boolean> => {
        const deadline = performance.now() + timeoutMs;
        do {
            if (scrollToChart(chartPath)) {
                return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        } while (performance.now() < deadline);
        return scrollToChart(chartPath);
    }, [scrollToChart]);

    const handleChartJump = useCallback(async (chartPath: string) => {
        // First-pass poll handles the case where the chart is in a message
        // that's just been mounted (virtualized list, animated card) but not
        // yet in the DOM at the moment of click.
        if (await scrollToChartWithRetry(chartPath, 250)) {
            return;
        }

        let foundInTabs = false;
        for (const ref of comprehensiveActionTabRefs.current.values()) {
            const found = await ref.selectPhaseAndActionForChart(chartPath);
            if (found) {
                foundInTabs = true;
                break;
            }
        }

        if (!foundInTabs) {
            for (const ref of taskChainTabsRefs.current.values()) {
                const found = await ref.selectTaskForChart(chartPath);
                if (found) {
                    foundInTabs = true;
                    break;
                }
            }
        }

        const collectRenderedChartIds = (): string[] => {
            if (typeof document === "undefined") return [];
            return Array.from(document.querySelectorAll('[id^="chart-"]'))
                .map((el) => el.id)
                .slice(0, 30);
        };

        if (foundInTabs) {
            // Tab expanded; React may still be committing and the chart
            // iframe may still be mounting. Poll up to 2s for the anchor
            // div to appear, then scroll.
            if (await scrollToChartWithRetry(chartPath, 2000)) {
                return;
            }
            console.warn("[handleChartJump] tab expanded but chart not in DOM after 2s polling", {
                chartPath,
                expectedId: findChartAnchorId(chartPath),
                renderedChartIds: collectRenderedChartIds(),
            });
            toast({
                title: t("chat.chartNotFoundTitle"),
                description: t("chat.chartNotFoundDescription"),
            });
            return;
        }

        console.warn("[handleChartJump] chart not found in any rendered message or tab", {
            chartPath,
            expectedId: findChartAnchorId(chartPath),
            renderedChartIds: collectRenderedChartIds(),
        });
        toast({
            title: t("chat.chartNotFoundTitle"),
            description: t("chat.chartNotFoundDescription"),
        });
    }, [scrollToChartWithRetry, findChartAnchorId, t, toast]);


    const handleInputChange = useCallback(
        (event: ChangeEvent<HTMLTextAreaElement>) => {
            const value = event.target.value;
            setInput(value);

            const trimmed = value.trim();
            if (SHARE_CODE_REGEX.test(trimmed)) {
                void handleShareCodeAttachment(trimmed);
            }
        },
        [handleShareCodeAttachment]
    );

    const handleInputPaste = useCallback(
        (event: ClipboardEvent<HTMLTextAreaElement>) => {
            const pasted = event.clipboardData.getData("text").trim();
            if (SHARE_CODE_REGEX.test(pasted)) {
                event.preventDefault();
                void handleShareCodeAttachment(pasted);
            }
        },
        [handleShareCodeAttachment]
    );

    // Collapsible input area handlers
    const handleInputAreaMouseEnter = () => {
        // Clear any pending collapse timeout
        if (collapseTimeoutRef.current) {
            clearTimeout(collapseTimeoutRef.current);
            collapseTimeoutRef.current = null;
        }
        // Expand the input area
        setIsInputCollapsed(false);
    };

    const handleInputAreaMouseLeave = () => {
        // Do not collapse when there is text in the input (user may be composing)
        if (input.trim().length > 0) return;
        collapseTimeoutRef.current = setTimeout(() => {
            setIsInputCollapsed(true);
        }, 1000);
    };

    // Mobile: auto-collapse the composer when the user scrolls down to read
    // and re-expand on scroll up. Mouse-enter/leave doesn't fire on touch, so
    // without this the composer + generated-charts panel can eat ~45% of the
    // viewport in landscape, leaving very little room for the message list.
    // Threshold prevents flicker on inertial-scroll micro-deltas.
    const composerValueRef = useRef(input);
    composerValueRef.current = input;
    useEffect(() => {
        const container = scrollRef.current;
        if (!container) return;
        const MOBILE_BREAKPOINT = 768; // Tailwind md:
        const SCROLL_DELTA_THRESHOLD = 24;
        let lastScrollTop = container.scrollTop;
        let frame: number | null = null;
        // Same offset useAutoScroll uses for "is at bottom" — keep in sync.
        const AT_BOTTOM_OFFSET = 20;
        const handleScroll = () => {
            if (frame != null) return;
            frame = requestAnimationFrame(() => {
                frame = null;
                if (window.innerWidth >= MOBILE_BREAKPOINT) return;
                const top = container.scrollTop;
                // Skip toggling when pinned to the bottom. useAutoScroll's
                // ResizeObserver re-pins to the bottom on every container
                // resize, so toggling the composer here causes a feedback loop:
                // collapse → message-list resize → re-pin → opposite-direction
                // delta → expand → resize → re-pin → … visible as the composer
                // flashing on mobile. There is also nothing below the bottom
                // message to expose, so collapsing here serves no UX purpose.
                const distanceToBottom = container.scrollHeight - top - container.clientHeight;
                if (distanceToBottom <= AT_BOTTOM_OFFSET) {
                    lastScrollTop = top;
                    return;
                }
                const delta = top - lastScrollTop;
                if (Math.abs(delta) < SCROLL_DELTA_THRESHOLD) return;
                if (delta > 0 && !composerValueRef.current.trim()) {
                    setIsInputCollapsed(true);
                } else if (delta < 0) {
                    setIsInputCollapsed(false);
                }
                lastScrollTop = top;
            });
        };
        container.addEventListener('scroll', handleScroll, { passive: true });
        return () => {
            container.removeEventListener('scroll', handleScroll);
            if (frame != null) cancelAnimationFrame(frame);
        };
    }, [scrollRef]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (e.nativeEvent.isComposing) return;
            handleSendMessage(e as unknown as React.FormEvent<HTMLFormElement>);
        }
    };

    const handleSendMessage = async (
        e: React.FormEvent<HTMLFormElement>,
        overrideText?: string,
    ) => {
        e.preventDefault();
        const filesToUpload = selectedFiles;
        const messageClassification = isDeepResearchMode ? "TASK_CHAIN_MESSAGE" : undefined;
        // External submission path — when an injection (e.g., the inline
        // Cancel chip on order tables) provides text directly, we treat
        // it as the input for this submission only. Preserves the user's
        // typed-but-unsent input.
        const effectiveInput = overrideText ?? input;

        const favoriteChainPayload: FavoriteTaskChainPayload | undefined = selectedFavoriteChain
            ? {
                  favoriteId: selectedFavoriteChain.favoriteId,
                  id: selectedFavoriteChain.id,
                  name: selectedFavoriteChain.name,
                  originalName: selectedFavoriteChain.originalName,
                  description: selectedFavoriteChain.description,
                  taskChain: selectedFavoriteChain.taskChain,
                  createdAt: selectedFavoriteChain.createdAt,
                  lastUsedAt: selectedFavoriteChain.lastUsedAt,
              }
            : undefined;

        if (!effectiveInput && !favoriteChainPayload && filesToUpload.length === 0) {
            return;
        }

        /** Room this stream must update; frozen against sidebar navigation. */
        let streamRoomId = effectiveRoomIdRef.current ?? roomId;

        const handleRoomUpdateForStream = (updatedRoom: { id: string; name: string }) => {
            if (updatedRoom.id !== streamRoomId) {
                streamRoomId = updatedRoom.id as UUID;
            }
            handleRoomUpdate(updatedRoom);
        };

        const attachments: IAttachment[] | undefined = filesToUpload.length > 0
            ? filesToUpload.map(file => ({
                      url: URL.createObjectURL(file),
                      contentType: file.type,
                      title: file.name,
                  }))
            : undefined;
        const favoriteChainLabel = favoriteChainPayload
            ? getFavoriteTaskChainLabel(favoriteChainPayload)
            : "";

        const fallbackLabel = favoriteChainPayload
            ? favoriteChainLabel
            : filesToUpload.length > 0
                ? `${filesToUpload.length} file${filesToUpload.length === 1 ? "" : "s"} attached`
                : "";

        // For display, always show either the original input or a descriptive fallback
        const displayText = effectiveInput || fallbackLabel;

        // Use the same text for backend processing
        const backendMessage = effectiveInput || (favoriteChainPayload ? "" : fallbackLabel);

        // Use consistent conversationId: must match groupMessagesIntoConversations which uses conv-${userMessage.createdAt}
        const userMessageCreatedAt = Date.now();
        const newMessages = [
            {
                id: `user-${userMessageCreatedAt}`,
                text: displayText,
                user: "user",
                createdAt: userMessageCreatedAt,
                attachments,
                content: {
                    text: displayText,
                    attachments,
                    favoriteTaskChain: favoriteChainPayload,
                }
            },
            {
                id: `system-loading-${userMessageCreatedAt}`,
                text: displayText,
                user: "system",
                isLoading: true,
                createdAt: userMessageCreatedAt,
                content: {
                    text: displayText
                }
            },
        ];

        queryClient.setQueryData(
            ["messages", agentId, streamRoomId],
            (old: ContentWithUser[] = []) => [...old, ...newMessages]
        );

        // Clear input immediately after adding message to UI.
        // If the message came from an external override (e.g., Cancel
        // chip in an order table), keep the user's typed-but-unsent
        // input intact.
        setSelectedFiles([]);
        if (overrideText === undefined) {
            setInput("");
        }
        setSelectedFavoriteChain(null);

        formRef.current?.reset();

        setIsProcessing(true);

        // Clear only ephemeral state for the new run; keep completed chain state so other conversations in this room still show their TaskChain graph (keyed by permanent chainId)
        setTaskUpdates([]);
        setChainUpdates([]);
        setRealtimeActionResults({});
        approvedChainIdsRef.current.clear();

        const accumulatedResponses: any[] = []; // Accumulate responses from multiple final_response events
        // Must match groupMessagesIntoConversations: conv-${userMessage.createdAt}
        const currentConversationId = `conv-${userMessageCreatedAt}`;

        // Use streaming for all messages (text and files)
        await streamingApiClient.sendMessageStream(
            agentId,
            backendMessage,
            roomId,
            (step) => {
                // Processing step received - handle task updates for real-time TaskChainBubble updates
                if (step?.name === 'task_update' && step?.data) {
                    const taskUpdate = step.data as TaskUpdateData;
                    setTaskUpdates(prev => [...prev, taskUpdate]);
                }

                // Handle task removal events
                if (step?.name === 'task_removal' && step?.data) {
                    // Task removal is handled via chain_update events with updated chain structure
                }

                // Handle chain state (initial and after supervisor) - single source for current chain
                if (step?.name === 'chain_state' && step?.data?.chainId && step?.data?.chain) {
                    const { chainId, chain } = step.data as { chainId: string; chain: TaskChainData };
                    setLiveChainByChainId(prev => ({ ...prev, [chainId]: chain }));
                    setConversationIdToChainId(prev => ({ ...prev, [currentConversationId]: chainId }));
                }

                // Handle chain structure updates for real-time chain refinements and task removals
                if (step?.name === 'chain_update' && step?.data) {
                    const chainUpdate = step.data as ChainUpdateData;
                    setChainUpdates(prev => [...prev, chainUpdate]);
                    if (chainUpdate.chainId && chainUpdate.updatedChain) {
                        setLiveChainByChainId(prev => ({ ...prev, [chainUpdate.chainId]: chainUpdate.updatedChain }));
                    }
                }

                // Handle real-time comprehensive action results for ActionTab
                if (step?.name === 'comprehensive_action_result' && step?.data?.actionResult) {
                    setRealtimeActionResults((prev: {[key: string]: any[]}) => ({
                        ...prev,
                        [currentConversationId]: [
                            ...(prev[currentConversationId] || []),
                            step.data.actionResult
                        ]
                    }));
                }

                // Handle generic human-input review / final confirm
                if (
                    (step?.name === "human_input_required" || step?.name === "human_input_confirm_required") &&
                    step?.data
                ) {
                    const d = step.data as {
                        type: string;
                        threadId: string;
                        approvalId?: string;
                        interruptType?: string;
                        title: string;
                        description?: string;
                        confirmationsRequired?: number;
                        confirmationLevel?: 1 | 2;
                        fields: Record<string, unknown>;
                        fieldSchema?: Record<string, cexParamDef> | null;
                        summary?: Record<string, unknown>;
                        actionName?: string;
                        accountSnapshot?: {
                            baseAvailable: string;
                            quoteAvailable: string;
                            baseAsset: string;
                            quoteAsset: string;
                            feeBps?: number;
                        } | null;
                        // CEX post-PR237 Commit 3 — modal-enrichment
                        // payload threaded through to the dialog so the
                        // migrated MarketSnapshotPanel can render bid /
                        // ask / depth / 24h stats and the symbol
                        // mismatch banner.
                        market_snapshot?: HumanInputDialogData["market_snapshot"];
                        symbol_verification?: HumanInputDialogData["symbol_verification"];
                        // CEX post-PR237 Commit 4 — multi-step plan
                        // context. Commit 3 just plumbs the field
                        // through; Commit 4 lights up the UI.
                        plan_context?: HumanInputDialogData["plan_context"];
                        dedup_context?: HumanInputDialogData["dedup_context"];
                    };
                    const interruptTypeForRouting = d.interruptType ?? d.type;
                    // Classify the interrupt for observability — the §7.4
                    // detection function still distinguishes trading vs
                    // generic approvals so future surfaces can opt in.
                    // Today both surfaces render through HumanInputDialog,
                    // which uses TradingOrderEditor for create_order /
                    // preview_order. Other actions fall back to the
                    // generic schema renderer in HumanInputDialog.
                    detectApprovalSurface({
                        interruptType: interruptTypeForRouting,
                        actionName: d.actionName,
                    });
                    const humanInputData: HumanInputDialogData = {
                        threadId: d.threadId ?? roomId,
                        approvalId: d.approvalId,
                        interruptType: interruptTypeForRouting,
                        title: d.title ?? "Review required",
                        description: d.description,
                        confirmationsRequired: d.confirmationsRequired ?? 2,
                        confirmationLevel: d.confirmationLevel ?? 1,
                        fields: d.fields ?? {},
                        fieldSchema: d.fieldSchema ?? null,
                        summary: d.summary,
                        actionName: d.actionName,
                        accountSnapshot: d.accountSnapshot ?? null,
                        market_snapshot: d.market_snapshot,
                        symbol_verification: d.symbol_verification,
                        plan_context: d.plan_context,
                        dedup_context: d.dedup_context,
                    };
                    setPendingInterrupt({
                        type: "human_input",
                        threadId: humanInputData.threadId,
                        interruptType: humanInputData.interruptType,
                        createdAtMs: Date.now(),
                        payload: humanInputData,
                    });
                }

                // Handle task chain approval requests
                if (step?.name === 'chain_approval_required' && step?.data) {
                    const approvalData = step.data;
                    const chainId = approvalData.taskChain?.id;

                    if (chainId && approvedChainIdsRef.current.has(chainId)) {
                        approvedChainIdsRef.current.delete(chainId);
                        return;
                    }

                    // Update the pending approval with new task chain data
                    // The useEffect below will handle closing the regenerating state
                    setPendingApproval({
                        threadId: roomId, // Use roomId as thread_id for workflow tracking
                        taskChain: approvalData.taskChain,
                        fullTaskChain: approvalData.fullTaskChain || approvalData.taskChain
                    });
                    setShowApprovalDialog(true);
                }
            },
            (actionResponse) => {
                // Mantle / CEX action handlers emit action_response (not
                // intermediate_response). Mirror the intermediate path so
                // workflow replies appear in the chat stream.
                queryClient.setQueryData(
                    ["messages", agentId, streamRoomId],
                    (old: ContentWithUser[] = []) => {
                        const preserved = old.filter((msg) => {
                            if (msg.user === "user") return true;
                            if (msg.user === "system" && (msg.isLoading || msg.isStreaming)) {
                                return false;
                            }
                            return true;
                        });

                        const text =
                            actionResponse?.text ??
                            actionResponse?.content?.text ??
                            "";
                        const mappedResponse = {
                            ...actionResponse,
                            text,
                            createdAt: actionResponse.createdAt ?? Date.now(),
                            user:
                                actionResponse.userId === agentId
                                    ? "system"
                                    : "user",
                            conversationId: currentConversationId,
                            metadata:
                                actionResponse.content?.metadata ??
                                actionResponse.metadata,
                            content: {
                                ...(actionResponse.content ?? {}),
                                text,
                            },
                        };

                        const existingIndex = preserved.findIndex(
                            (msg) => msg.id === mappedResponse.id,
                        );

                        if (existingIndex >= 0) {
                            const existing = preserved[existingIndex];
                            const updated = [...preserved];
                            updated[existingIndex] = {
                                ...existing,
                                ...mappedResponse,
                                createdAt:
                                    existing.createdAt ?? mappedResponse.createdAt,
                                conversationId:
                                    existing.conversationId ?? currentConversationId,
                                text: mappedResponse.text ?? existing.text,
                                content: {
                                    ...(existing.content || {}),
                                    ...(mappedResponse.content || {}),
                                    text: mappedResponse.text ?? existing.text,
                                },
                                metadata:
                                    mappedResponse.metadata ?? existing.metadata,
                            };
                            return updated;
                        }

                        return [...preserved, mappedResponse];
                    },
                );

                const existingIndex = accumulatedResponses.findIndex(
                    (response) => response.id === actionResponse.id,
                );
                if (existingIndex >= 0) {
                    accumulatedResponses[existingIndex] = actionResponse;
                } else {
                    accumulatedResponses.push(actionResponse);
                }
            },
            (intermediateResponse) => {
                // Handle intermediate responses - show them immediately

                queryClient.setQueryData(
                    ["messages", agentId, streamRoomId],
                    (old: ContentWithUser[] = []) => {
                        // Preserve user messages and completed system messages, remove only loading system messages
                        const preserved = old.filter((msg) => {
                            if (msg.user === "user") return true; // Always preserve user messages
                            if (msg.user === "system" && (msg.isLoading || msg.isStreaming)) return false; // Remove loading + streaming-ghost system messages
                            return true; // Keep everything else
                        });
                        
                        const mappedResponse = {
                            ...intermediateResponse,
                            createdAt: Date.now(),
                            user: intermediateResponse.userId === agentId ? "system" : "user", // Assign user field for proper categorization
                            conversationId: currentConversationId // Add conversationId for real-time ActionTab
                        };

                        const existingIndex = preserved.findIndex(
                            (msg) => msg.id === mappedResponse.id
                        );

                        if (existingIndex >= 0) {
                            const existing = preserved[existingIndex];
                            const updated = [...preserved];
                            updated[existingIndex] = {
                                ...existing,
                                ...mappedResponse,
                                createdAt: existing.createdAt ?? mappedResponse.createdAt,
                                conversationId: existing.conversationId ?? currentConversationId,
                                text: mappedResponse.text ?? existing.text,
                                content: {
                                    ...(existing.content || {}),
                                    ...(mappedResponse.content || {}),
                                    text: mappedResponse.text ?? existing.text
                                },
                                metadata: mappedResponse.metadata ?? existing.metadata
                            };
                            return updated;
                        }
                        
                        return [...preserved, mappedResponse];
                    }
                );

                // setQueryData already notifies all subscribers of this key.
                // The previous invalidateQueries call was redundant (the global
                // staleTime is Infinity so it can't trigger a refetch) and
                // doubled the listener notifications per intermediate event.

                // Keep track of intermediate responses for final processing
                const existingIndex = accumulatedResponses.findIndex(
                    (response) => response.id === intermediateResponse.id
                );
                if (existingIndex >= 0) {
                    accumulatedResponses[existingIndex] = intermediateResponse;
                } else {
                    accumulatedResponses.push(intermediateResponse);
                }
            },
            async (responses) => {
                // NOTE: Most responses should already be shown via intermediate responses
                // This final response handler now mainly handles any remaining responses that weren't streamed
                const newResponses = responses.filter((response: any) => {
                    // Check if this response was already added via intermediate streaming
                    return !accumulatedResponses.some(accumulated => accumulated.id === response.id);
                });

                if (newResponses.length > 0) {
                    queryClient.setQueryData(
                        ["messages", agentId, streamRoomId],
                        (old: ContentWithUser[] = []) => {
                            // Preserve user messages and completed system messages, remove only loading system messages
                            const preserved = old.filter((msg) => {
                                if (msg.user === "user") return true; // Always preserve user messages
                                if (msg.user === "system" && (msg.isLoading || msg.isStreaming)) return false; // Remove loading + streaming-ghost system messages
                                return true; // Keep everything else
                            });
                            
                            const mappedNewResponses = newResponses.map((msg: any) => {
                                return {
                                    ...msg,
                                    createdAt: Date.now(),
                                    user: msg.userId === agentId ? "system" : "user", // Assign user field for proper categorization
                                    conversationId: currentConversationId // Add conversationId for real-time ActionTab
                                };
                            });
                            
                            return [...preserved, ...mappedNewResponses];
                        }
                    );

                    // setQueryData already notifies subscribers; the prior
                    // invalidateQueries was a no-op churn (staleTime: Infinity).
                }

                // Add all responses to accumulated list for final processing
                accumulatedResponses.push(...responses);
            },
            handleRoomUpdateForStream,
            (error) => {
                console.error('Streaming error:', error);
                setIsProcessing(false);

                // If the stream died while a task chain approval dialog was open, close it.
                // Without this, the dialog stays orphaned on screen with no way for the user
                // to dismiss and retry (isProcessing=false means input is re-enabled, but the
                // modal backdrop blocks interaction until it's cleared).
                setPendingApproval(null);
                setShowApprovalDialog(false);
                isRegeneratingChainRef.current = false;
                setIsRegeneratingChain(false);

                // Clear task updates on error
                setTaskUpdates([]);

                // Remove pending loading + streaming-ghost messages from the conversation log
                queryClient.setQueryData(
                    ["messages", agentId, streamRoomId],
                    (old: ContentWithUser[] = []) =>
                        old.filter(
                            (msg) => !(msg.user === "system" && (msg.isLoading || msg.isStreaming))
                        )
                );

                const errorObject =
                    typeof error === "object" && error !== null
                        ? (error as { code?: string; message?: string })
                        : null;
                const errorCode = errorObject?.code;
                const errorMessage =
                    typeof error === "string"
                        ? error
                        : errorObject?.message ?? "Unknown error";

                // Suppress the error toast when the user intentionally
                // stopped processing. The streaming client surfaces this as
                // onError("Processing was stopped as requested") so that
                // downstream state (ghost bubbles, taskUpdates, etc.) can
                // still be cleared via this onError handler, but we should
                // NOT show an "Analysis Error" toast in that case — the
                // stop handler already showed a "Processing stopped" toast.
                if (errorMessage.includes("stopped as requested")) {
                    return;
                }

                if (!isAuthenticated && errorCode === ANON_LIMIT_ERROR_CODE) {
                    setShowDailyLimitPrompt(true);
                    toast({
                        title: t("chat.dailyLimitTitle"),
                        description: t("chat.dailyLimitDescription", {
                            limit: ANON_DAILY_MESSAGE_LIMIT,
                        }),
                        variant: "destructive",
                        duration: 10000,
                    });
                    return;
                }

                // Handle quota exceeded error
                if (errorCode === "QUOTA_EXCEEDED") {
                    toast({
                        title: t("chat.weeklyQuotaTitle"),
                        description: errorMessage,
                        variant: "destructive",
                        duration: 10000,
                    });
                    refetchQuota();
                    return;
                }

                // Show user-friendly error messages
                if (errorMessage.includes('Network connection lost')) {
                    toast({
                        title: t("chat.connectionLostTitle"),
                        description: t("chat.connectionLostDescription"),
                        variant: "destructive",
                        duration: 10000,
                    });
                } else if (errorMessage.includes('timed out')) {
                    toast({
                        title: t("chat.timeoutTitle"),
                        description: t("chat.timeoutDescription"),
                        variant: "destructive",
                        duration: 10000,
                    });
                } else if (
                    errorMessage.includes('aborted') ||
                    errorMessage.includes('cancelled')
                ) {
                    toast({
                        title: t("chat.processingStoppedTitle"),
                        description: t("chat.processingStoppedDescription"),
                        duration: 5000,
                    });
                } else if (
                    // Soft "Streaming error: ..." path from sendMessageStream
                    // (HTTP/2 reset, generic "network error", proxy
                    // teardown). The server keeps running, so tell the user
                    // their work isn't lost — just refresh.
                    errorMessage.startsWith("Streaming error:") ||
                    errorMessage.toLowerCase().includes("err_http2") ||
                    errorMessage.toLowerCase().includes("http2") ||
                    errorCode === "STREAM_ENDED"
                ) {
                    toast({
                        title: t("chat.streamInterruptedTitle"),
                        description: t("chat.streamInterruptedDescription"),
                        duration: 12000,
                    });
                } else {
                    toast({
                        title: t("chat.analysisErrorTitle"),
                        description: t("chat.analysisErrorDescription", { message: errorMessage }),
                        variant: "destructive",
                        duration: 8000,
                    });
                }
            },
            () => {
                // onComplete callback - called when [DONE] is received
                setIsProcessing(false);
                refetchQuota();

                // Comprehensive path closes SSE early; clear loading/streaming
                // ghosts so the transcript does not look stuck "in progress".
                queryClient.setQueryData(
                    ["messages", agentId, streamRoomId],
                    (old: ContentWithUser[] = []) =>
                        old
                            .filter(
                                (msg) => !(msg.user === "system" && msg.isLoading),
                            )
                            .map((msg) =>
                                msg.user === "system" && msg.isStreaming
                                    ? {
                                          ...msg,
                                          isStreaming: false,
                                          isLoading: false,
                                      }
                                    : msg,
                            ),
                );

                postStreamHistorySyncTimeoutsRef.current.forEach((id) => clearTimeout(id));
                postStreamHistorySyncTimeoutsRef.current = [];
                // Background HTML/S3 persist runs after [DONE]; merge provisional
                // narrative into API results until the canonical snapshot exists.
                const delaysMs = [1500, 6000, 20000];
                delaysMs.forEach((delayMs) => {
                    const tid = window.setTimeout(() => {
                        void loadMessageHistory(true, true);
                    }, delayMs);
                    postStreamHistorySyncTimeoutsRef.current.push(tid);
                });
            },
            // onStreamingUpdate — paint a ghost assistant bubble that grows
            // as the server streams LLM tokens during long-running actions.
            // The ghost is auto-cleared the moment a real intermediate /
            // final response arrives (the existing isStreaming filter).
            ({ key, text }) => {
                if (!text) return;
                const ghostId = `streaming-${currentConversationId}-${key}`;
                queryClient.setQueryData(
                    ["messages", agentId, streamRoomId],
                    (old: ContentWithUser[] = []) => {
                        const idx = old.findIndex((m) => m.id === ghostId);
                        const ghost = {
                            id: ghostId,
                            text,
                            user: "system",
                            userId: agentId,
                            isStreaming: true,
                            createdAt: idx >= 0 ? old[idx].createdAt : Date.now(),
                            conversationId: currentConversationId,
                            content: { text },
                        } as unknown as ContentWithUser;
                        if (idx >= 0) {
                            const next = [...old];
                            next[idx] = { ...old[idx], ...ghost };
                            return next;
                        }
                        return [...old, ghost];
                    },
                );
            },
            favoriteChainPayload,
            filesToUpload, // Pass the selected files to the streaming endpoint
            messageClassification,
            i18n.language,
            (() => {
                const composed = composedPayloadRef.current;
                composedPayloadRef.current = null;
                return composed ?? undefined;
            })(),
        );

    };

    useEffect(() => {
        if (inputRef.current) {
            inputRef.current.focus();
        }
    }, []);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        if (files.length > 0) {
            // Accept both document types and images
            const supportedFileTypes = [
                // Document types
                'application/pdf',
                'text/plain',
                'text/markdown',
                'application/msword',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'application/vnd.ms-excel',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'application/vnd.ms-powerpoint',
                'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                // Image types
                'image/png',
                'image/jpeg',
                'image/jpg',
                'image/webp',
                'image/heic',
                'image/heif'
            ];
            
            // Filter valid files and reject invalid ones
            const validFiles: File[] = [];
            const invalidFiles: File[] = [];
            
            files.forEach(file => {
                if (supportedFileTypes.includes(file.type)) {
                    validFiles.push(file);
                } else {
                    invalidFiles.push(file);
                }
            });
            
            if (validFiles.length > 0) {
                setSelectedFiles(prev => [...prev, ...validFiles]);
                
                const hasImages = validFiles.some(file => file.type.startsWith('image/'));
                const hasDocuments = validFiles.some(file => !file.type.startsWith('image/'));
                
                let description = "";
                if (hasImages && hasDocuments) {
                    description = t("chat.mixedFilesDescription");
                } else if (hasImages) {
                    description = validFiles.length === 1 
                        ? t("chat.singleImageDescription")
                        : t("chat.multipleImagesDescription", { count: validFiles.length });
                } else {
                    description = validFiles.length === 1
                        ? t("chat.singleDocumentDescription")
                        : t("chat.multipleDocumentsDescription", { count: validFiles.length });
                }
                
                toast({
                    title: t("chat.filesUploaded", { count: validFiles.length }),
                    description,
                });
            }
            
            if (invalidFiles.length > 0) {
                toast({
                    variant: "destructive",
                    title: t("chat.unsupportedFiles", { count: invalidFiles.length }),
                    description: t("chat.unsupportedFilesDescription"),
                });
            }
        }
    };

    // Reusable function to render individual messages
    const renderIndividualMessage = (response: ContentWithUser, responseIndex: number, isPartOfComprehensiveAnalysis = false) => {
        return (
            <div key={`${response.createdAt}-${responseIndex}`} className="flex flex-col gap-3 max-w-full min-w-0">
                {/* AI Response Content */}
                <div className="md:border md:border-muted/30 md:rounded-lg md:shadow-sm md:bg-gradient-to-br md:from-card/50 md:to-muted/10 max-w-full min-w-0">
                    <div className="py-2 md:p-4 max-w-full min-w-0">
                        <ChatBubble
                            variant="received"
                            className="flex flex-row items-center gap-2"
                        >
                            <Avatar className="hidden md:flex size-8 p-1 border rounded-full select-none">
                                <AvatarImage src={agentIconSrc} />
                            </Avatar>
                            <div className="flex flex-col max-w-full min-w-0">
                                <ChatBubbleMessage
                                    isLoading={response?.isLoading}
                                >
                                    {/* Error Messages */}
                                    {response?.error && (
                                        <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-md">
                                            <div className="flex items-start gap-2">
                                                <div className="text-red-600 text-sm font-medium">
                                                    {t("progress.errorWithType", { type: response.error.type })}
                                                </div>
                                            </div>
                                            <div className="text-red-800 text-sm mt-1">
                                                {response.error.message}
                                            </div>
                                            {response.error.originalError && response.error.originalError !== response.error.message && (
                                                <div className="text-red-600 text-xs mt-2 font-mono">
                                                    {t("progress.originalError", { message: response.error.originalError })}
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {/* File attachments (uploaded files) - Rendered BEFORE text */}
                                    {(() => {
                                        const imageAttachments = response?.attachments?.filter(isImageAttachment) || [];
                                        const nonImageAttachments = response?.attachments?.filter((att: IAttachment) => !isImageAttachment(att)) || [];

                                        return (
                                            <div className="w-full">
                                                {/* Image attachments - Horizontal scroll */}
                                                {imageAttachments.length > 0 && (
                                                    <div className="max-w-full min-w-0 mb-4 overflow-x-auto">
                                                        <div className="flex flex-row gap-4 pb-2">
                                                            {imageAttachments.map((attachment: IAttachment, index: number) => (
                                                                <div
                                                                    key={`${attachment.url}-${attachment.title || index}`}
                                                                    className="flex flex-col gap-1 flex-shrink-0 w-80"
                                                                >
                                                                    <a
                                                                        href={attachment.url}
                                                                        target="_blank"
                                                                        rel="noreferrer"
                                                                        className="block rounded-lg overflow-hidden border bg-muted/40 hover:opacity-90 transition-opacity"
                                                                    >
                                                                        <img
                                                                            src={attachment.url}
                                                                            alt={attachment.description || attachment.title || "Image attachment"}
                                                                            className="w-full h-60 object-cover"
                                                                            loading="lazy"
                                                                            decoding="async"
                                                                        />
                                                                    </a>
                                                                    {(attachment.title || attachment.description) && (
                                                                        <div className="text-sm text-muted-foreground line-clamp-2">
                                                                            {attachment.title || ""}
                                                                            {attachment.title && attachment.description ? " — " : ""}
                                                                            {attachment.description || ""}
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                                {/* Non-image attachments - Normal list */}
                                                {nonImageAttachments.map((attachment: IAttachment, index: number) => (
                                                    <div
                                                        key={`${attachment.url}-${attachment.title || index}`}
                                                        className="mb-2"
                                                    >
                                                        <a
                                                            href={attachment.url}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                            className="text-sm font-medium text-primary hover:underline inline-flex items-center gap-2"
                                                        >
                                                            <FileText className="size-4" />
                                                            {attachment.title || attachment.url}
                                                        </a>
                                                    </div>
                                                ))}
                                            </div>
                                        );
                                    })()}
                                    {/* Images from web search - Rendered BEFORE text */}
                                    {(() => {
                                        const metadata = (response as any)?.content?.metadata;
                                        const directImages = metadata?.actionData?.images || [];
                                        const actionResults = Array.isArray((response as any)?.content?.actionResults)
                                            ? (response as any)?.content?.actionResults
                                            : [];
                                        const actionImages = actionResults.flatMap(
                                            (result: any) =>
                                                result?.actionData?.images ||
                                                result?.metadata?.actionData?.images ||
                                                [],
                                        );
                                        const imagesMap = new Map<string, any>();
                                        [...directImages, ...actionImages].forEach((img: any) => {
                                            if (img?.url && !imagesMap.has(img.url)) {
                                                imagesMap.set(img.url, img);
                                            }
                                        });
                                        const images = Array.from(imagesMap.values());
                                        const maxImages = 10;

                                        const selectImagesForDisplay = (allImages: any[], limit: number): any[] => {
                                            if (allImages.length <= limit) {
                                                return allImages;
                                            }

                                            const withIteration = allImages.filter(img => typeof img?.iterationFound === "number");
                                            const withoutIteration = allImages.filter(img => typeof img?.iterationFound !== "number");

                                            if (withIteration.length === 0) {
                                                return allImages.slice(0, limit);
                                            }

                                            const iterationsMap = new Map<number, any[]>();
                                            withIteration.forEach(img => {
                                                const iteration = img.iterationFound as number;
                                                const list = iterationsMap.get(iteration) || [];
                                                list.push(img);
                                                iterationsMap.set(iteration, list);
                                            });

                                            const iterationIds = Array.from(iterationsMap.keys()).sort((a, b) => b - a);
                                            const cursors = new Map<number, number>();
                                            iterationIds.forEach(id => cursors.set(id, 0));

                                            const selected: any[] = [];
                                            let progressMade = true;

                                            while (selected.length < limit && progressMade) {
                                                progressMade = false;

                                                for (const iterationId of iterationIds) {
                                                    const list = iterationsMap.get(iterationId) || [];
                                                    const startIndex = cursors.get(iterationId) || 0;
                                                    if (startIndex >= list.length) {
                                                        continue;
                                                    }

                                                    const quota = iterationId;
                                                    const takeCount = Math.min(quota, list.length - startIndex, limit - selected.length);
                                                    if (takeCount <= 0) {
                                                        continue;
                                                    }

                                                    selected.push(...list.slice(startIndex, startIndex + takeCount));
                                                    cursors.set(iterationId, startIndex + takeCount);
                                                    progressMade = true;

                                                    if (selected.length >= limit) {
                                                        break;
                                                    }
                                                }
                                            }

                                            if (selected.length < limit && withoutIteration.length > 0) {
                                                selected.push(...withoutIteration.slice(0, limit - selected.length));
                                            }

                                            return selected.slice(0, limit);
                                        };

                                        const selectedImages = selectImagesForDisplay(images, maxImages);

                                        return selectedImages.length > 0 ? (
                                            <div className="max-w-full min-w-0 mb-4 overflow-x-auto">
                                                <div className="flex flex-row gap-4 pb-2">
                                                    {selectedImages.map((img: any, index: number) => (
                                                        <div key={`${img.url}-${index}`} className="flex flex-col gap-2 flex-shrink-0 w-80">
                                                            <a
                                                                href={img.url}
                                                                target="_blank"
                                                                rel="noreferrer"
                                                                className="block rounded-lg overflow-hidden border bg-muted/40 hover:opacity-90 transition-opacity"
                                                            >
                                                                <img
                                                                    src={img.url}
                                                                    alt={img.description || `Image ${index + 1}`}
                                                                    className="w-full h-60 object-cover"
                                                                    loading="lazy"
                                                                />
                                                            </a>
                                                            {img.description && (
                                                                <p className="text-xs text-muted-foreground line-clamp-2">
                                                                    {img.description}
                                                                </p>
                                                            )}
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        ) : null;
                                    })()}

                                    {/* Regular Message Content */}
                                    {(() => {
                                        const isOnboardingDemoCompare =
                                            (response as any)?.content?.source === ONBOARDING_DEMO_COMPARE_SOURCE ||
                                            (response as any)?.source === ONBOARDING_DEMO_COMPARE_SOURCE;

                                        if (isOnboardingDemoCompare) {
                                            const anchorPrefixBase = `msg-${response.createdAt ?? "pending"}-${responseIndex}`;
                                            const sanitizedAnchorPrefixBase = anchorPrefixBase.replace(/[^a-zA-Z0-9_-]/g, "");
                                            const anchorPrefix = sanitizedAnchorPrefixBase ? `${sanitizedAnchorPrefixBase}-` : "";

                                            return (
                                                <div className="max-w-full min-w-0">
                                                    <OnboardingDemoAnswersInline anchorPrefixBase={anchorPrefix} />
                                                </div>
                                            );
                                        }

                                        // Get real-time action results for this conversation (available outside function scope)
                                        const realtimeResults = realtimeActionResults[(response as any).conversationId] || [];
                                        const hasRealtimeResults = realtimeResults.length > 0;
                                        
                                        // Create a unique key for this message that won't change on re-renders
                                        const messageKey = response.id
                                            ? `${response.id}`
                                            : `${response.createdAt}-${response.text?.slice(0, 50)}-${responseIndex}`;
                                        const hasFinished =
                                            finishedTyping.has(messageKey) || shareExportLayout;

                                        const anchorPrefixBase = `msg-${response.createdAt ?? "pending"}-${responseIndex}`;
                                        const sanitizedAnchorPrefixBase = anchorPrefixBase.replace(/[^a-zA-Z0-9_-]/g, "");
                                        const anchorPrefix = sanitizedAnchorPrefixBase ? `${sanitizedAnchorPrefixBase}-` : "";

                                        // Check if this message contains action results
                                        const actionResults = response?.text ? parseActionResults(response.text) : null;
                                        const hasTraditionalActionResults = !!(actionResults && actionResults.length > 0);

                                        // Only show real-time ActionTab for non-comprehensive analysis and when traditional action results are not present
                                        const shouldShowRealtimeActionTab = hasRealtimeResults && !isPartOfComprehensiveAnalysis && !hasTraditionalActionResults;

                                        // Get charts for this message
                                        const messageCharts = getMessageChartPaths(response, deletedFiles);
                                        const parsedContent = parseMessageWithCharts(response, messageCharts);

                                        return (
                                            <div className={response?.error ? "opacity-75" : ""}>
                                                {hasFinished ? (
                                                    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
                                                        <div className="flex-1 min-w-0 space-y-6">
                                                            {/* Render content with inline charts */}
                                                            {parsedContent.hasInlineCharts ? (
                                                                <>
                                                                    {parsedContent.segments.map((segment, segIndex) => (
                                                                        <div key={segIndex}>
                                                                            {segment.text && (
                                                                                <MarkdownRenderer className={MARKDOWN_CONTAINER_CLASSES} anchorPrefix={anchorPrefix}>
                                                                                    {segment.text}
                                                                                </MarkdownRenderer>
                                                                            )}
                                                                            {segment.charts.length > 0 && (
                                                                                <div className="w-full mt-4 space-y-4">
                                                                                    {segment.charts.map((chartPath) => {
                                                                                        const chartUrl = apiClient.getChartUrl(chartPath);
                                                                                        const messageId = resolveMessageId(response);
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
                                                                    {/* Render any remaining charts not found in text */}
                                                                    {parsedContent.chartsAtEnd && parsedContent.chartsAtEnd.length > 0 && (
                                                                        <div className="w-full mt-6 space-y-4">
                                                                            {parsedContent.chartsAtEnd.map((chartPath) => {
                                                                                const chartUrl = apiClient.getChartUrl(chartPath);
                                                                                const messageId = resolveMessageId(response);
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
                                                                    <MarkdownRenderer className={MARKDOWN_CONTAINER_CLASSES} anchorPrefix={anchorPrefix}>
                                                                        {response?.text || ""}
                                                                    </MarkdownRenderer>
                                                                    {/* Charts at the end if no inline placement */}
                                                                    {messageCharts.length > 0 && (
                                                                        <div className="w-full mt-6 space-y-4">
                                                                            {messageCharts.map((chartPath) => {
                                                                                const chartUrl = apiClient.getChartUrl(chartPath);
                                                                                const messageId = resolveMessageId(response);
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

                                                            <MantleExecutionLinks
                                                                metadata={
                                                                    (response as { metadata?: Record<string, unknown> })
                                                                        ?.metadata ??
                                                                    (response as { content?: { metadata?: Record<string, unknown> } })
                                                                        ?.content?.metadata
                                                                }
                                                            />

                                                            {/* Show ActionTab for regular action results */}
                                                            {hasTraditionalActionResults && (
                                                                <div className="border-t pt-6 max-w-full min-w-0">
                                                                    <ActionTab
                                                                        actionResults={actionResults}
                                                                        title={t("chat.analysisActions")}
                                                                    />
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                ) : (
                                                    <MarkdownWithTyping
                                                        delay={0.1}
                                                        anchorPrefix={anchorPrefix}
                                                        onFinish={() => {
                                                            setFinishedTyping(prev => new Set(prev).add(messageKey));
                                                        }}
                                                    >
                                                        {response?.text || ""}
                                                    </MarkdownWithTyping>
                                                )}

                                                {/* Show real-time ActionTab only if traditional ActionTab is not shown */}
                                                {shouldShowRealtimeActionTab && (
                                                    <div className="mt-6 border-t pt-6 max-w-full min-w-0">
                                                        <ActionTab
                                                            actionResults={realtimeResults}
                                                            title={t("chat.liveComprehensiveAnalysis")}
                                                        />
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })()}
                                </ChatBubbleMessage>
                                <div className="flex items-center gap-4 justify-between w-full mt-1">
                                    {response?.text &&
                                    !response?.isLoading ? (
                                        <div className="flex items-center gap-1">
                                            <CopyButton
                                                text={response?.text}
                                            />
                                            <ChatTtsButton
                                                agentId={agentId}
                                                text={response?.text}
                                            />
                                        </div>
                                    ) : null}
                                    <div
                                        className={cn([
                                            response?.isLoading
                                                ? "mt-2"
                                                : "",
                                            "flex items-center justify-between gap-4 select-none",
                                        ])}
                                    >
                                        {response?.source ? (
                                            <Badge variant="outline">
                                                {formatSourceName(response.source)}
                                            </Badge>
                                        ) : null}
                                        {response?.createdAt ? (
                                            <ChatBubbleTimestamp
                                                timestamp={moment(
                                                    response?.createdAt
                                                ).format("LT")}
                                            />
                                        ) : null}
                                    </div>
                                </div>
                            </div>
                        </ChatBubble>
                    </div>
                </div>
            </div>
        );
    };

    // Helper function to detect and parse action results from message content

    // Helper function to check if message has task chain data

    // Memoize the conversation grouping. Without this, every state update
    // (each intermediate_response, each task update) triggers an O(n)
    // re-grouping of every message in the room. The result feeds the
    // renderer and `messageToConversationMap` below; keeping a stable
    // reference also lets dependent useMemo/useEffect skip work.
    const conversations = useMemo(
        () => groupMessagesIntoConversations(chatMessages),
        [chatMessages]
    );

    const messageToConversationMap = useMemo(() => {
        const map = new Map<string, string>();
        conversations.forEach((conversation) => {
            conversation.responses.forEach((response) => {
                const responseId = response.id;
                if (responseId !== undefined && responseId !== null) {
                    map.set(`id-${String(responseId)}`, conversation.conversationId);
                }
                if (response.createdAt !== undefined && response.createdAt !== null) {
                    map.set(`created-${String(response.createdAt)}`, conversation.conversationId);
                }
                // Use standard format: content.metadata
                const metadata = (response as any)?.content?.metadata;
                const taskId = metadata?.taskId;
                if (taskId) {
                    map.set(`task-${String(taskId)}`, conversation.conversationId);
                }
            });
        });
        return map;
    }, [conversations]);

    // Hydrate conversationIdToChainId and liveChainByChainId from snapshot (permanent chain id) so completed chains stay visible and new chains are not affected
    useEffect(() => {
        const convs = groupMessagesIntoConversations(chatMessages);
        setConversationIdToChainId((prev) => {
            const next = { ...prev };
            convs.forEach((conv) => {
                const data = getTaskChainData(conv);
                if (data?.id) next[conv.conversationId] = data.id;
            });
            return next;
        });
        setLiveChainByChainId((prev) => {
            const next = { ...prev };
            convs.forEach((conv) => {
                const data = getTaskChainData(conv);
                if (data?.id) next[data.id] = data;
            });
            return next;
        });
    }, [chatMessages]);

    const latestUserMessage = useMemo(() => {
        const userMessages = chatMessages.filter((message) => message.user === "user");
        if (userMessages.length === 0) {
            return null;
        }

        return userMessages.reduce<ContentWithUser | null>((latest, current) => {
            if (!latest) return current;
            return current.createdAt > latest.createdAt ? current : latest;
        }, null);
    }, [chatMessages]);

    const latestUserConversation = useMemo(() => {
        if (!latestUserMessage) {
            return null;
        }

        const latestId = latestUserMessage.id !== undefined && latestUserMessage.id !== null
            ? String(latestUserMessage.id)
            : null;

        return (
            conversations.find((conversation) => {
                const conversationUserId = conversation.userMessage.id;
                if (conversationUserId !== undefined && conversationUserId !== null && latestId) {
                    return String(conversationUserId) === latestId;
                }
                return conversation.userMessage.createdAt === latestUserMessage.createdAt;
            }) || null
        );
    }, [latestUserMessage, conversations]);

    useEffect(() => {
        if (!roomId) {
            return;
        }

        if (pendingScrollRoomRef.current !== roomId) {
            return;
        }

        if (!latestUserMessage) {
            pendingScrollRoomRef.current = null;
            return;
        }

        const latestMessageId =
            latestUserMessage.id !== undefined && latestUserMessage.id !== null
                ? String(latestUserMessage.id)
                : null;

        const fallbackConversationId =
            latestUserConversation?.conversationId ||
            (latestMessageId ? messageToConversationMap.get(`id-${latestMessageId}`) : undefined) ||
            messageToConversationMap.get(`created-${String(latestUserMessage.createdAt)}`);

        let frameId: number | null = null;
        let attemptCount = 0;
        const maxAttempts = 10;

        const attemptScrollToLatestUserMessage = () => {
            const container = scrollRef.current;
            const targetElement =
                (latestMessageId ? userMessageRefs.current[latestMessageId] : undefined) ||
                (fallbackConversationId ? conversationRefs.current[fallbackConversationId] : undefined);

            if (!container || !targetElement) {
                attemptCount += 1;
                if (attemptCount < maxAttempts) {
                    frameId = requestAnimationFrame(attemptScrollToLatestUserMessage);
                }
                return;
            }

            const offset = Math.max(targetElement.offsetTop - 24, 0);
            container.scrollTo({
                top: offset,
                behavior: "smooth",
            });

            lastScrolledRoomRef.current = roomId;
            pendingScrollRoomRef.current = null;

            enableAutoScroll();
        };

        frameId = requestAnimationFrame(attemptScrollToLatestUserMessage);

        return () => {
            if (frameId !== null) {
                cancelAnimationFrame(frameId);
            }
        };
    }, [roomId, latestUserMessage, latestUserConversation, enableAutoScroll, messageToConversationMap]);

    useEffect(() => {
        const validConversationIds = new Set(conversations.map(conversation => conversation.conversationId));
        setTaskSelectionByConversation((prev) => {
            const entries = Object.entries(prev).filter(([conversationId]) => validConversationIds.has(conversationId));
            if (entries.length === Object.keys(prev).length) {
                return prev;
            }
            return Object.fromEntries(entries);
        });
    }, [conversations, setTaskSelectionByConversation]);

    /** Share image export reads live DOM; task-tab message indices differ from conversation indices — expand keys so full markdown renders. SVG foreignObject runs after React commits. */
    useEffect(() => {
        const onPrepareShareExport = (): void => {
            flushSync(() => {
                setShareExportLayout(true);
                setFinishedTyping((prev) => {
                    const next = new Set(prev);
                    for (const conv of conversations) {
                        for (let ri = 0; ri < conv.responses.length; ri++) {
                            const response = conv.responses[ri];
                            if (response.id) {
                                next.add(String(response.id));
                                continue;
                            }
                            const base = `${response.createdAt}-${(response.text ?? "").slice(0, 50)}`;
                            next.add(`${base}-${ri}`);
                            for (let ti = 0; ti < 40; ti++) {
                                next.add(`${base}-${ti}`);
                            }
                        }
                    }
                    return next;
                });
            });
        };
        const onShareExportDone = (): void => {
            setShareExportLayout(false);
        };
        window.addEventListener("sentiedge:prepare-share-export", onPrepareShareExport);
        window.addEventListener("sentiedge:share-export-done", onShareExportDone);

        // Inline-action injections (e.g., the Cancel chip in order
        // tables) dispatch `sentiedge:chat-send` with a pre-filled
        // text. We treat it as a normal submission via the override
        // path of handleSendMessage so the user's currently-typed input
        // is preserved.
        const onChatSend = (e: Event): void => {
            const detail = (e as CustomEvent<{ text?: string }>).detail;
            const text = typeof detail?.text === "string" ? detail.text.trim() : "";
            if (!text) return;
            const synthetic = {
                preventDefault: () => {},
            } as unknown as React.FormEvent<HTMLFormElement>;
            void handleSendMessage(synthetic, text);
        };
        window.addEventListener("sentiedge:chat-send", onChatSend);

        return () => {
            window.removeEventListener("sentiedge:prepare-share-export", onPrepareShareExport);
            window.removeEventListener("sentiedge:share-export-done", onShareExportDone);
            window.removeEventListener("sentiedge:chat-send", onChatSend);
        };
    }, [conversations]);

    const updateTaskSelectionForConversation = useCallback((conversationId: string, taskId: string | null) => {
        setTaskSelectionByConversation((prev) => {
            const normalized = taskId ?? null;
            const previous = conversationId in prev ? prev[conversationId] ?? null : undefined;
            if (previous !== undefined && previous === normalized) {
                return prev;
            }
            const next = { ...prev };
            // Store explicit null when the user closes task details — TaskChainTabs
            // respects controlled null vs missing key ("never interacted" → undefined prop).
            if (normalized !== null && normalized !== "") {
                next[conversationId] = normalized;
            } else {
                next[conversationId] = null;
            }
            return next;
        });
    }, [setTaskSelectionByConversation]);

    const handleHumanInputApprove = async (parameters: Record<string, unknown>) => {
        if (!pendingInterrupt || pendingInterrupt.type !== "human_input") return;
        const submitted = pendingInterrupt.payload;

        // CEX post-PR237 Commit 4 — multi-step plan modal. The backend
        // plan runner emits this modal as a visual affordance; it does
        // NOT block on `submitHumanInputApproval` because the plan
        // continuation flows through the chat input pipeline. Routing
        // the Confirm click through a continuation message ("yes")
        // keeps the existing plan-runner contract intact and avoids
        // duplicating idempotency / risk-engine machinery.
        if (submitted.plan_context) {
            setPendingInterrupt((current) =>
                current?.type === "human_input" &&
                current.payload.threadId === submitted.threadId
                    ? null
                    : current,
            );
            // #6d — persist the user's in-modal edits to the plan step BEFORE
            // sending the "yes" continuation, so the order that executes (and
            // the result/plan card) reflects their changes. Whitelist-merged
            // server-side; a no-op when nothing changed. Awaited so "yes"
            // can't race the plan runner into executing the un-edited step.
            // Non-fatal: on failure we still confirm the (un-edited) step.
            const planId = submitted.plan_context.plan_id;
            const stepIndex = submitted.plan_context.step_index;
            if (
                typeof planId === "string" &&
                Number.isInteger(stepIndex) &&
                parameters &&
                Object.keys(parameters).length > 0
            ) {
                try {
                    await apiClient.editPlanStep(agentId, {
                        planId,
                        stepIndex,
                        parameters,
                    });
                } catch (err) {
                    console.warn(
                        "[plan-step] editPlanStep failed (non-fatal); confirming un-edited step",
                        err,
                    );
                }
            }
            window.dispatchEvent(
                new CustomEvent("sentiedge:chat-send", {
                    detail: { text: "yes" },
                }),
            );
            return;
        }

        try {
            await apiClient.submitHumanInputApproval(
                agentId,
                submitted.threadId,
                "approved",
                submitted.confirmationLevel ?? 1,
                parameters,
                submitted.approvalId
            );
            setPendingInterrupt((current) => {
                if (!current || current.type !== "human_input") return current;
                const payload = current.payload;
                const approvalIdMatch =
                    !payload.approvalId || !submitted.approvalId
                        ? true
                        : payload.approvalId === submitted.approvalId;
                const isSameInterrupt =
                    payload.threadId === submitted.threadId &&
                    (payload.confirmationLevel ?? 1) === (submitted.confirmationLevel ?? 1) &&
                    approvalIdMatch;
                return isSameInterrupt ? null : current;
            });
        } catch (error: any) {
            toast({
                title: "Approval Failed",
                description: error.message || "Failed to submit human input approval",
                variant: "destructive",
            });
        }
    };

    /**
     * CEX post-PR237 Commit 4 — Approve All Remaining handler for
     * multi-step plan modals. Dismisses the interrupt and sends an
     * APPROVE_BATCH continuation message so the plan runner flips its
     * approval_mode flag and runs all remaining writes without
     * further prompts. The continuation parser matches "approve all"
     * / "approve all remaining" / etc.
     */
    const handleHumanInputApproveAllRemaining = () => {
        if (!pendingInterrupt || pendingInterrupt.type !== "human_input") return;
        const submitted = pendingInterrupt.payload;
        if (!submitted.plan_context) return;
        setPendingInterrupt((current) =>
            current?.type === "human_input" &&
            current.payload.threadId === submitted.threadId
                ? null
                : current,
        );
        window.dispatchEvent(
            new CustomEvent("sentiedge:chat-send", {
                detail: { text: "approve all remaining steps" },
            }),
        );
    };

    const handleHumanInputReject = async () => {
        if (!pendingInterrupt || pendingInterrupt.type !== "human_input") return;
        const submitted = pendingInterrupt.payload;
        try {
            await apiClient.submitHumanInputApproval(
                agentId,
                submitted.threadId,
                "rejected",
                submitted.confirmationLevel ?? 1,
                undefined,
                submitted.approvalId
            );
        } catch (err) {
            console.error("[handleHumanInputReject] rejection failed", err);
            toast({
                title: t("chat.approvalFailedTitle"),
                description: (err as Error)?.message || t("chat.approvalFailedFallback"),
                variant: "destructive",
            });
        } finally {
            setPendingInterrupt((current) => {
                if (!current || current.type !== "human_input") return current;
                const payload = current.payload;
                const approvalIdMatch =
                    !payload.approvalId || !submitted.approvalId
                        ? true
                        : payload.approvalId === submitted.approvalId;
                const isSameInterrupt =
                    payload.threadId === submitted.threadId &&
                    (payload.confirmationLevel ?? 1) === (submitted.confirmationLevel ?? 1) &&
                    approvalIdMatch;
                return isSameInterrupt ? null : current;
            });
        }
    };

    // Handle task chain approval
    const handleApproveChain = async () => {
        if (!pendingApproval) return;

        try {
            await apiClient.submitChainApproval(
                agentId,
                pendingApproval.threadId,
                'approved',
                pendingApproval.fullTaskChain
            );

            if (pendingApproval.taskChain?.id) {
                approvedChainIdsRef.current.add(pendingApproval.taskChain.id);
            }

            toast({
                title: t("chat.taskChainApprovedTitle"),
                description: t("chat.taskChainApprovedDescription", {
                    name: pendingApproval.taskChain.name,
                }),
            });

            setShowApprovalDialog(false);
            setPendingApproval(null);
        } catch (error: any) {
            console.error('Failed to approve task chain:', error);
            toast({
                title: t("chat.approvalFailedTitle"),
                description: error.message || t("chat.approvalFailedFallback"),
                variant: "destructive",
            });
        }
    };

    // Handle task chain rejection with feedback
    const handleRejectChain = async (feedback: string) => {
        if (!pendingApproval) return;

        try {
            // Save the current task chain ID to detect when new one arrives
            const currentChainId = pendingApproval.taskChain.id;
            previousTaskChainIdRef.current = currentChainId;

            // Set regenerating state BEFORE closing the dialog
            // Update both ref and state to ensure callbacks can access the latest value
            isRegeneratingChainRef.current = true;
            setIsRegeneratingChain(true);

            await apiClient.submitChainApproval(
                agentId,
                pendingApproval.threadId,
                'rejected',
                pendingApproval.fullTaskChain,
                feedback
            );

            // Don't close the dialog or clear pending approval yet
            // The dialog will remain open in "regenerating" state
            // When the new chain_approval_required event arrives, we'll update the dialog
        } catch (error: any) {
            console.error('Failed to reject task chain:', error);

            // Reset regenerating state on error
            isRegeneratingChainRef.current = false;
            setIsRegeneratingChain(false);
            previousTaskChainIdRef.current = null;

            toast({
                title: t("chat.rejectionFailedTitle"),
                description: error.message || t("chat.rejectionFailedFallback"),
                variant: "destructive",
            });
        }
    };

    const handleStopProcessing = async () => {
        if (!agentId) {
            console.error("Cannot stop processing: agentId is not available");
            return;
        }

        try {
            // Immediately show stop feedback to user
            toast({
                title: t("chat.stoppingProcessingTitle"),
                description: t("chat.stoppingProcessingDescription"),
            });

            // Mark intent first so any immediate stream errors classify as user stop
            // (HTTP/2 reset, net::ERR_HTTP2_PROTOCOL_ERROR, etc.).
            streamingApiClient.registerUserStopIntent(agentId);
            // Tell the server to stop before tearing down the client fetch so the
            // runtime stop flag is set even if the stream dies messily.
            const stopServerPromise = apiClient.stopProcessing(agentId);
            streamingApiClient.cancelStreamForAgent(agentId);

            // Immediately reset frontend state for better UX. We keep
            // liveChainByChainId + conversationIdToChainId populated and
            // instead mark each in-flight task as 'cancelled' so the
            // TaskChainBubble stays visible with a "Cancelled by user"
            // indicator on whichever step was running. Clearing them would
            // make the chain vanish — the prior UX gave the user no proof
            // the action took effect.
            setIsProcessing(false);
            setTaskUpdates([]);
            setChainUpdates([]);
            setLiveChainByChainId(prev => {
                const next: Record<string, TaskChainData> = {};
                for (const [chainId, chain] of Object.entries(prev)) {
                    next[chainId] = {
                        ...chain,
                        tasks: chain.tasks.map(task =>
                            task.status === 'pending' || task.status === 'running'
                                ? { ...task, status: 'cancelled' as const }
                                : task
                        )
                    };
                }
                return next;
            });
            // Dismiss any pending task-chain approval and stop its
            // auto-approve countdown — otherwise a user who hits Stop while
            // the approval dialog is open would still see the chain execute
            // 60s later when the timer fires.
            setPendingApproval(null);
            setShowApprovalDialog(false);
            setIsRegeneratingChain(false);

            // Call the stop API (may already be in flight above)
            const result = await stopServerPromise;

            if (result.success) {
                toast({
                    title: t("chat.processingStoppedSuccessTitle"),
                    description: result.message || t("chat.processingStoppedSuccessFallback"),
                });
            } else {
                toast({
                    title: t("chat.stopSignalSentTitle"),
                    description: t("chat.stopSignalSentDescription"),
                });
            }
        } catch (error) {
            console.error("Failed to stop processing:", error);

            // Even if API call fails, reset local state for better UX.
            // Same pattern as the success path — mark in-flight tasks as
            // cancelled rather than clearing the chain, so the user can see
            // their Cancel took effect.
            setIsProcessing(false);
            setTaskUpdates([]);
            setChainUpdates([]);
            setLiveChainByChainId(prev => {
                const next: Record<string, TaskChainData> = {};
                for (const [chainId, chain] of Object.entries(prev)) {
                    next[chainId] = {
                        ...chain,
                        tasks: chain.tasks.map(task =>
                            task.status === 'pending' || task.status === 'running'
                                ? { ...task, status: 'cancelled' as const }
                                : task
                        )
                    };
                }
                return next;
            });
            setPendingApproval(null);
            setShowApprovalDialog(false);
            setIsRegeneratingChain(false);

            toast({
                title: t("chat.stopRequestedTitle"),
                description: t("chat.stopRequestedDescription"),
                variant: "default", // Changed from destructive to default for better UX
            });
        }
    };

    // Mobile: collapse if > 1 chart, show first 1
    const shouldCollapseChartsMobile = localChartPaths.length > 1 && !showAllCharts;

    const chartsToRenderMobile = shouldCollapseChartsMobile
        ? localChartPaths.slice(0, 1)
        : localChartPaths;

    return (
        // Three-row flex column for the whole chat surface:
        //   1. mobile header  (flex-shrink-0, natural height)
        //   2. message list   (flex-1 min-h-0, internal overflow-y-auto)
        //   3. input bar      (flex-shrink-0, natural height + safe-area)
        // h-[100dvh] tracks the *visual* viewport on iOS Safari so the whole
        // surface follows the address-bar / keyboard. We avoid any
        // position:absolute / position:fixed for the input because both relied
        // on the parent's h-full cascading correctly, which breaks on mobile.
        <div className="flex flex-col w-full h-full max-h-[100dvh] min-h-0 touch-pan-y overflow-hidden">
            {/* Header with Sidebar Trigger (mobile only) */}
            <div className="flex-shrink-0 flex items-center gap-2 px-4 py-3 border-b border-slate-300 dark:border-white/20 backdrop-blur-md bg-background/80 md:hidden">
                <SidebarTrigger data-tour="sidebar-toggle" />
                <MobileTocToggleButton />
            </div>
            {/* Scrollable messages area */}
            <div className="relative flex-1 min-h-0 w-full">
                <ChatMessageList
                    scrollRef={scrollRef}
                    isAtBottom={isAtBottom}
                    scrollToBottom={scrollToBottom}
                    disableAutoScroll={disableAutoScroll}
                    className="h-full max-w-full"
                    data-share-chat-export="true"
                >
                            {isLoadingMore && (
                                <div className="flex justify-center py-3 text-sm text-muted-foreground">
                                    Loading older messages…
                                </div>
                            )}
                            {!hasMore && !isLoadingMore && conversations.length > 0 && (
                                <div className="flex justify-center py-3 text-xs text-muted-foreground">
                                    Beginning of conversation
                                </div>
                            )}
                            {conversations.map((conversation) => (
                                <div
                                    key={conversation.conversationId}
                                    ref={(element) => {
                                        setConversationRef(conversation.conversationId, element);
                                        const userMessageId = conversation.userMessage.id;
                                        const messageKey =
                                            userMessageId !== undefined && userMessageId !== null
                                                ? String(userMessageId)
                                                : conversation.conversationId;
                                        setUserMessageRef(messageKey, element);
                                    }}
                                    className="mb-6 md:pl-4 max-w-full min-w-0"
                                >
                                    {/* User Message */}
                                    <div className="flex flex-col gap-2 py-2 md:p-4 md:bg-muted/10 md:rounded-lg mb-4 mt-6 max-w-full min-w-0">
                                        <ChatBubble
                                            variant="sent"
                                            className="flex flex-row items-center gap-2"
                                        >
                                            <div className="flex flex-col">
                                                <ChatBubbleMessage>
                                                    {/* User message attachments - Rendered BEFORE text */}
                                                    <div className="w-full">
                                                        {(() => {
                                                            // Debug: Log user message attachments
                                                            if (conversation.userMessage.attachments && conversation.userMessage.attachments.length > 0) {
                                                                console.log('📎 [DEBUG] User message attachments:', conversation.userMessage.attachments.length);
                                                                conversation.userMessage.attachments.forEach((att, idx) => {
                                                                    console.log(`  [${idx + 1}] contentType:`, att.contentType);
                                                                    console.log(`      URL:`, att.url?.substring(0, 80));
                                                                    console.log(`      isImage:`, isImageAttachment(att));
                                                                });
                                                            }
                                                            return null;
                                                        })()}
                                                        {(() => {
                                                            const imageAttachments = conversation.userMessage.attachments?.filter(isImageAttachment) || [];
                                                            const nonImageAttachments =
                                                                conversation.userMessage.attachments?.filter((att: IAttachment) => !isImageAttachment(att)) || [];

                                                            return (
                                                                <>
                                                                    {imageAttachments.length > 0 && (
                                                                        <div className="max-w-full min-w-0 mb-4 overflow-x-auto">
                                                                            <div className="flex flex-row gap-4 pb-2">
                                                                                {imageAttachments.map((attachment: IAttachment, index: number) => (
                                                                                    <div
                                                                                        className="flex flex-col gap-1 flex-shrink-0 w-72"
                                                                                        key={`${attachment.url}-${attachment.title || index}`}
                                                                                    >
                                                                                        <a
                                                                                            href={attachment.url}
                                                                                            target="_blank"
                                                                                            rel="noreferrer"
                                                                                            className="block rounded-lg overflow-hidden border bg-muted/40"
                                                                                        >
                                                                                            <img
                                                                                                src={attachment.url}
                                                                                                alt={attachment.description || attachment.title || "Image attachment"}
                                                                                                className="w-full h-52 object-cover"
                                                                                                loading="lazy"
                                                                                                decoding="async"
                                                                                            />
                                                                                        </a>
                                                                                        {(attachment.title || attachment.description) && (
                                                                                            <div className="text-sm text-muted-foreground line-clamp-2">
                                                                                                {attachment.title || ""}
                                                                                                {attachment.title && attachment.description ? " — " : ""}
                                                                                                {attachment.description || ""}
                                                                                            </div>
                                                                                        )}
                                                                                    </div>
                                                                                ))}
                                                                            </div>
                                                                        </div>
                                                                    )}
                                                                    {nonImageAttachments.map((attachment: IAttachment, index: number) => (
                                                                        <div
                                                                            className="flex flex-col gap-1 mb-4 w-full"
                                                                            key={`${attachment.url}-${attachment.title || index}`}
                                                                        >
                                                                            <a
                                                                                href={attachment.url}
                                                                                target="_blank"
                                                                                rel="noreferrer"
                                                                                className="text-sm font-medium text-primary hover:underline"
                                                                            >
                                                                                {attachment.title || attachment.url}
                                                                            </a>
                                                                            {(attachment.title || attachment.description) && (
                                                                                <div className="text-sm text-muted-foreground">
                                                                                    {attachment.title || ""}
                                                                                    {attachment.title && attachment.description ? " — " : ""}
                                                                                    {attachment.description || ""}
                                                                                </div>
                                                                            )}
                                                                        </div>
                                                                    ))}
                                                                </>
                                                            );
                                                        })()}
                                                    </div>
                                                    {conversation.userMessage.text}
                                                </ChatBubbleMessage>
                                                <div className="flex items-center gap-4 justify-between w-full mt-1">
                                                    <div className="flex items-center gap-1">
                                                        <CopyButton text={conversation.userMessage.text} />
                                                    </div>
                                                    <div className="flex items-center justify-between gap-4 select-none">
                                                        {conversation.userMessage.source && (
                                                            <Badge variant="outline">
                                                                {conversation.userMessage.source}
                                                            </Badge>
                                                        )}
                                                        <ChatBubbleTimestamp
                                                            timestamp={moment(conversation.userMessage.createdAt).format("LT")}
                                                        />
                                                    </div>
                                                </div>
                                            </div>
                                        </ChatBubble>
                                    </div>

                                    {/* AI Responses */}
                                    {conversation.responses.length > 0 && (
                                <div className="md:ml-4 space-y-4 max-w-full min-w-0">
                                    {hasComprehensiveAnalysisMessages(conversation) ? (
                                        /* Comprehensive Analysis with Action-First UI */
                                        <>
                                            {(() => {
                                                const comprehensiveData = getComprehensiveAnalysisData(conversation, realtimeActionResults);
                                                
                                                // Show non-action messages (like final summary) separately
                                                const nonActionMessages = conversation.responses.filter((response) => {
                                                    if (isComprehensiveFinalNarrativeMessage(response)) {
                                                        return true;
                                                    }
                                                    const contentSource = (response as any)?.content?.source;
                                                    const directSource = (response as any)?.source;
                                                    return contentSource !== 'comprehensive_analysis' &&
                                                           directSource !== 'comprehensive_analysis';
                                                });
                                                
                                                return (
                                                    <>
                                                        {/* Comprehensive Action Tab Container */}
                                                        {comprehensiveData.length > 0 && (
                                                            <ComprehensiveActionTab
                                                                ref={(ref) => {
                                                                    if (ref) {
                                                                        comprehensiveActionTabRefs.current.set(conversation.conversationId, ref);
                                                                    } else {
                                                                        comprehensiveActionTabRefs.current.delete(conversation.conversationId);
                                                                    }
                                                                }}
                                                                actionResults={comprehensiveData}
                                                                title={t("chat.comprehensiveAnalysis")}
                                                                agentId={agentId}
                                                                deletedFiles={deletedFiles}
                                                                shareExportRoomId={String(roomId)}
                                                            />
                                                        )}
                                                        
                                                        {/* Non-action messages (like final summary) */}
                                                        {nonActionMessages.map((response, responseIndex) => 
                                                            renderIndividualMessage(response, responseIndex, true)
                                                        )}
                                                    </>
                                                );
                                            })()}
                                        </>
                                    ) : (() => {
                                        const baseTaskChainData = getTaskChainData(conversation);
                                        const chainId = conversationIdToChainId[conversation.conversationId] ?? baseTaskChainData?.id;
                                        const taskChainData = chainId ? (liveChainByChainId[chainId] ?? baseTaskChainData) : baseTaskChainData;
                                        if (!taskChainData) return null;
                                        return (
                                            <>
                                                {/* Task Chain Bubble - show when we have chain state (from chain_state or summary) */}
                                                <TaskChainBubble
                                                    favoritesApi={favoriteTaskChainsWithSharingPrompt}
                                                    taskChain={taskChainData}
                                                    isComplete={!conversation.responses.some(response => response.isLoading)}
                                                    taskUpdates={taskUpdates}
                                                    chainUpdates={chainUpdates}
                                                />
                                                {/* Task Chain Tabs */}
                                                <TaskChainTabs
                                                    ref={(ref) => {
                                                        if (ref) {
                                                            taskChainTabsRefs.current.set(conversation.conversationId, ref);
                                                        } else {
                                                            taskChainTabsRefs.current.delete(conversation.conversationId);
                                                        }
                                                    }}
                                                    taskChainData={taskChainData}
                                                    messages={conversation.responses}
                                                    renderMessage={renderIndividualMessage}
                                                    chainUpdates={chainUpdates}
                                                    taskUpdates={taskUpdates}
                                                    selectedTaskId={taskSelectionByConversation[conversation.conversationId]}
                                                    onTaskSelect={(taskId) => updateTaskSelectionForConversation(conversation.conversationId, taskId)}
                                                    favoritesApi={favoriteTaskChainsWithSharingPrompt}
                                                    deletedFiles={deletedFiles}
                                                />
                                            </>
                                        );
                                    })() ?? (
                                        /* Regular Messages without Task Chain */
                                        conversation.responses.map((response, responseIndex) => 
                                            renderIndividualMessage(response, responseIndex, false)
                                        )
                                    )}
                                </div>
                            )}
                        </div>
                    ))}
                </ChatMessageList>
                {/* Desktop chart sidebar — uses position:fixed internally
                    and is hidden on mobile (lg:flex), so it doesn't compete
                    with the message-list flex sizing. */}
                <ChartSidebar
                    chartPaths={localChartPaths}
                    showAllCharts={showAllCharts}
                    onToggleShowAll={() => setShowAllCharts(!showAllCharts)}
                    onChartClick={handleChartJump}
                />
            </div>

            {/* Message tools: charts, reports, input.
                Now a normal flex child with flex-shrink-0 so it always sits
                at the bottom of the chat surface — no absolute/fixed
                positioning, no need to reserve bottom padding on the message
                list. Honors the iOS safe-area inset under the home
                indicator. */}
            <div className="flex-shrink-0 z-30 px-2 sm:px-0 pb-[env(safe-area-inset-bottom,0px)] w-full">
                <div
                    onMouseEnter={handleInputAreaMouseEnter}
                    onMouseLeave={handleInputAreaMouseLeave}
                    className={cn(
                        "mx-auto w-full px-4 sm:px-0 pointer-events-auto rounded-3xl border border-white/30 dark:border-white/20 backdrop-blur-md shadow-[0_5px_13px_rgba(15,23,42,0.55)]",
                        "ease-in-out",
                        isInputCollapsed
                            ? "max-w-[160px] max-h-6 overflow-hidden mb-3 [transition:max-height_0.5s_ease-in-out,max-width_1s_ease-in-out_0.5s]"
                            : "max-w-2xl md:max-w-3xl xl:max-w-4xl max-h-[80vh] mb-2 [transition:max-width_1s_ease-in-out,max-height_0.5s_ease-in-out]"
                    )}
                >
                    {/* Use `inert` instead of `aria-hidden`: when the input collapses,
                        the textarea inside may still hold focus from a recent click. The
                        browser then logs "Blocked aria-hidden on an element because its
                        descendant retained focus." `inert` removes the subtree from the
                        accessibility tree AND prevents focus, so it is the correct API per
                        https://w3c.github.io/aria/#aria-hidden. */}
                    <div
                        className={cn(
                            "flex flex-col transition-opacity duration-300",
                            isInputCollapsed
                                ? "space-y-0 opacity-0 pointer-events-none invisible"
                                : "space-y-1 opacity-100 visible"
                        )}
                        inert={isInputCollapsed ? true : undefined}
                    >
                            {/* Chart Links Section - Mobile Only */}
                            {localChartPaths.length > 0 && (
                        <div className="px-2 py-1 bg-muted/20 lg:hidden">
                            <div className="flex items-center gap-1 text-sm text-muted-foreground">
                                <ExternalLink className="size-4" />
                                <span>{t("charts.generatedCharts")}:</span>
                            </div>
                            <div className="flex flex-wrap gap-1 mt-1">
                                {chartsToRenderMobile.map((chartPath, index) => {
                                    const fileName = chartPath.split("/").pop() || chartPath.split("\\").pop() || t("charts.chartLabel", { index: index + 1 });
                                    const displayName = fileName.replace(/\.(html|png)$/, "").replace(/_/g, " ");

                                    return (
                                        <div key={chartPath} className="relative">
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="text-xs h-7 gap-0.5 pr-2 max-w-[240px]"
                                                onClick={() => handleChartJump(chartPath)}
                                            >
                                                <ExternalLink className="size-3 flex-shrink-0" />
                                                <span className="truncate">{displayName}</span>
                                            </Button>
                                        </div>
                                    );
                                })}
                                {shouldCollapseChartsMobile && (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setShowAllCharts(true)}
                                        className="text-xs h-7"
                                        aria-label={t("charts.showAllCharts")}
                                        title={t("charts.showAllCharts")}
                                    >
                                        {t("charts.moreCharts", { count: localChartPaths.length - 1 })}
                                    </Button>
                                )}
                                {!shouldCollapseChartsMobile && localChartPaths.length > 1 && (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setShowAllCharts(false)}
                                        className="text-xs h-7"
                                        aria-label={t("charts.foldCharts")}
                                        title={t("charts.foldCharts")}
                                    >
                                        {t("charts.foldCharts")}
                                    </Button>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Input Form */}
                    <div className="px-2 pb-3 pt-2">
                        <div className="relative">
                            <div
                                aria-hidden
                                className="pointer-events-none absolute inset-x-6 bottom-[-40px] h-24 rounded-full bg-slate-500/10 blur-3xl dark:bg-slate-900/60"
                            />
                            {!isAtBottom && (
                                <Button
                                    type="button"
                                    size="icon"
                                    variant="outline"
                                    onClick={() => scrollToBottom()}
                                    className="absolute -top-14 left-1/2 z-20 -translate-x-1/2 rounded-full border-white/70 bg-white/90 text-muted-foreground shadow-[0_18px_40px_rgba(15,23,42,0.25)] backdrop-blur-xl transition-transform duration-300 hover:-translate-y-0.5 hover:text-foreground dark:border-white/10 dark:bg-slate-900/80 dark:text-slate-200"
                                >
                                    <ArrowDown className="size-4" />
                                    <span className="sr-only">{t("common.scrollToLatestMessage")}</span>
                                </Button>
                            )}
                            <form
                                ref={formRef}
                                onSubmit={handleSendMessage}
                                className={cn(
                                    "relative z-10 overflow-hidden rounded-2xl border border-white/50 shadow-[0_6px_15px_rgba(15,23,42,0.25)] transition-all duration-300 ease-in-out",
                                    "bg-white/80 dark:bg-slate-950/60 supports-[backdrop-filter]:bg-white/55 supports-[backdrop-filter]:backdrop-blur-2xl dark:supports-[backdrop-filter]:bg-slate-900/40"
                                )}
                            >
                                {selectedFiles.length > 0 ? (
                                    <div className="p-1.5 flex flex-wrap gap-1">
                                        {selectedFiles.map((file, index) => (
                                            <div key={`${file.name}-${index}`} className="relative rounded-md border p-1">
                                                <Button
                                                    onClick={() => {
                                                        setSelectedFiles(prevFiles =>
                                                            prevFiles.filter((_, i) => i !== index)
                                                        );
                                                    }}
                                                    className="absolute -right-2 -top-2 size-[22px] ring-2 ring-background"
                                                    variant="outline"
                                                    size="icon"
                                                >
                                                    <X />
                                                </Button>
                                                <div className="w-16 h-16 flex flex-col items-center justify-center text-center">
                                                    <FileText className="size-8 text-muted-foreground mb-0.5" />
                                                    <span className="text-xs text-muted-foreground truncate w-full" title={file.name}>
                                                        {file.name}
                                                    </span>
                                                </div>
                                            </div>
                                        ))}
                                            <div className="text-xs text-muted-foreground p-1 flex items-center">
                                            {t("chat.selectedFiles", { count: selectedFiles.length })}
                                        </div>
                                    </div>
                                ) : null}
                                {selectedFavoriteChain ? (
                                    <div className="p-1.5 flex flex-wrap gap-1 border-b border-muted/30">
                                        <div className="relative rounded-md border border-dashed border-yellow-500/30 bg-yellow-50/50 dark:bg-yellow-950/20 p-1.5 pr-5 flex-1 min-w-[200px]">
                                            <Button
                                                onClick={() => {
                                                    setSelectedFavoriteChain(null);
                                                }}
                                                className="absolute -right-2 -top-2 size-[22px] ring-2 ring-background"
                                                variant="outline"
                                                size="icon"
                                            >
                                                <X />
                                            </Button>
                                            <div className="flex items-start gap-1">
                                                <Link className="size-4 text-yellow-600 dark:text-yellow-500 flex-shrink-0 mt-0" />
                                                <div className="flex-1 min-w-0">
                                                    <div className="font-medium text-sm truncate">
                                                        {selectedFavoriteChain.name}
                                                    </div>
                                                    <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-0.5 gap-y-0.5">
                                                        <span>{t("chat.tasks", { count: selectedFavoriteChain.taskChain.tasks.length })}</span>
                                                        <span>•</span>
                                                        <span>
                                                            {selectedFavoriteChain.source === "shared"
                                                                ? t("chat.sharedTaskChain")
                                                                : t("chat.favoriteTaskChain")}
                                                        </span>
                                                        {selectedFavoriteChain.source === "shared" && selectedFavoriteChain.shareCode ? (
                                                            <>
                                                                <span>•</span>
                                                                <span>{t("chat.codeLabel", { code: selectedFavoriteChain.shareCode })}</span>
                                                            </>
                                                        ) : null}
                                                    </div>
                                                    {selectedFavoriteChain.source === "shared" &&
                                                        selectedFavoriteChain.sharedAgentId &&
                                                        agentId &&
                                                        selectedFavoriteChain.sharedAgentId !== agentId && (
                                                            <div className="mt-0.5 text-[11px] text-yellow-600 dark:text-yellow-500">
                                                                {t("chat.differentAgentWarning")}
                                                            </div>
                                                        )}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                ) : null}
                                <ChatInput
                                    data-tour="chat-input"
                                    data-testid="chat-input"
                                    ref={inputRef}
                                    onKeyDown={handleKeyDown}
                                    value={input}
                                    onChange={handleInputChange}
                                    onPaste={handleInputPaste}
                                    placeholder={
                                        isLimitedUser && quotaStatus?.isQuotaExceeded
                                            ? t("chat.quotaExceededPlaceholder")
                                            : t("chat.inputPlaceholder")
                                    }
                                    disabled={isLimitedUser && quotaStatus?.isQuotaExceeded}
                                    className="min-h-10 resize-none rounded-md bg-transparent border-0 py-1 pl-2 pr-0.5 mt-2 shadow-none focus-visible:ring-0"
                                />
                                <div className="flex items-center p-1.5 pt-0">
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <div>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    data-tour="chat-attach"
                                                    onClick={() => {
                                                        if (fileInputRef.current) {
                                                            fileInputRef.current.click();
                                                        }
                                                    }}
                                                >
                                                    <Paperclip className="size-4" />
                                                    <span className="sr-only">
                                                        {t("common.attachFile")}
                                                    </span>
                                                </Button>
                                                <input
                                                    type="file"
                                                    ref={fileInputRef}
                                                    onChange={handleFileChange}
                                                    accept=".png,.jpg,.jpeg,.webp,.heic,.heif,.pdf,.txt,.md,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
                                                    multiple
                                                    className="hidden"
                                                />
                                            </div>
                                        </TooltipTrigger>
                                        <TooltipContent side="left">
                                            <p>{t("common.attachFile")}</p>
                                        </TooltipContent>
                                    </Tooltip>

                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Button
                                                variant={selectedFavoriteChain ? "default" : "ghost"}
                                                size="icon"
                                                data-tour="chat-favorites"
                                                onClick={() => setShowFavoritesDialog(true)}
                                                className={selectedFavoriteChain ? "bg-yellow-600 hover:bg-yellow-700 text-white" : ""}
                                            >
                                                <BookmarkPlus className="size-4" />
                                                <span className="sr-only">
                                                    {t("common.favoriteTaskChains")}
                                                </span>
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent side="bottom">
                                            <p>{t("common.favoriteTaskChains")}</p>
                                        </TooltipContent>
                                    </Tooltip>

                                    {isAuthenticated && (
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <Button
                                                    type="button"
                                                    variant={isDeepResearchMode ? "default" : "ghost"}
                                                    size="icon"
                                                    disabled={isProcessing}
                                                    onClick={() => setIsDeepResearchMode((prev) => !prev)}
                                                    className={cn(
                                                        isDeepResearchMode && "bg-purple-600 hover:bg-purple-700 text-white"
                                                    )}
                                                    aria-pressed={isDeepResearchMode}
                                                >
                                                    <Microscope className="size-4" />
                                                    <span className="sr-only">{t("common.deepSearch")}</span>
                                                </Button>
                                            </TooltipTrigger>
                                            <TooltipContent side="bottom">
                                                <p>{t("common.deepSearch")}</p>
                                            </TooltipContent>
                                        </Tooltip>
                                    )}

                                    <AudioRecorder
                                        agentId={agentId}
                                        onChange={(newInput: string) => setInput(newInput)}
                                    />
                                    {isProcessing && (
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <Button
                                                    variant="destructive"
                                                    size="sm"
                                                    onClick={handleStopProcessing}
                                                    className="gap-0.5 h-[30px]"
                                                >
                                                    <Square className="size-3.5" />
                                                    {t("common.stop")}
                                                </Button>
                                            </TooltipTrigger>
                                            <TooltipContent side="top">
                                                <p>{t("common.stopProcessingImmediately")}</p>
                                            </TooltipContent>
                                        </Tooltip>
                                    )}
                                    {isLimitedUser && quotaStatus && quotaStatus.warningLevel !== "none" && (() => {
                                        const { warningLevel, percentageTier, inputPercentage, outputPercentage, resetDate } = quotaStatus;
                                        const pct = percentageTier >= 80
                                            ? percentageTier
                                            : Math.round(Math.max(inputPercentage, outputPercentage) * 100);
                                        const resetShort = new Date(resetDate).toLocaleDateString(i18n.language, { month: "short", day: "numeric" });
                                        const colorClass = warningLevel === "exceeded"
                                            ? "text-red-500 dark:text-red-400"
                                            : warningLevel === "critical"
                                                ? "text-orange-500 dark:text-orange-400"
                                                : "text-blue-500 dark:text-blue-400";
                                        const label = warningLevel === "exceeded"
                                            ? t("chat.quotaExceededLabel", { date: resetShort })
                                            : t("chat.quotaWarningLabel", { percent: pct, date: resetShort });
                                        return (
                                            <span className={cn("ml-auto mr-2 text-[11px] leading-none whitespace-nowrap", colorClass)}>
                                                {label}
                                            </span>
                                        );
                                    })()}
                                    {/* F10 — manual Trade compose entry.
                                        Prefills the chat input with a
                                        templated NL trade prompt so the
                                        existing CEX workflow opens the
                                        order editor with accountSnapshot
                                        pre-fetched. The user reviews +
                                        edits the line, then presses Send.
                                        Lightweight scaffold; a richer
                                        in-place form is tracked as F10
                                        follow-up. */}
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        disabled={isProcessing}
                                        title="Compose a trade — opens the order editor; one click places the order"
                                        onClick={() => setComposeOpen(true)}
                                        className={cn("gap-0.5 h-[30px]")}
                                        data-tour="chat-trade"
                                        data-testid="chat-trade-compose"
                                    >
                                        <TrendingUp className="size-3.5" />
                                        Trade
                                    </Button>
                                    <Button
                                        disabled={
                                            isProcessing ||
                                            (!input && !selectedFavoriteChain && selectedFiles.length === 0)
                                        }
                                        type="submit"
                                        size="sm"
                                        data-tour="chat-send"
                                        className={cn("gap-0.5 h-[30px]", !(isLimitedUser && quotaStatus && quotaStatus.warningLevel !== "none") && "ml-auto")}
                                    >
                                        {isProcessing
                                            ? t("common.processing")
                                            : t("common.sendMessage")}
                                        <Send className="size-3.5" />
                                    </Button>
                                </div>
                            </form>
                        </div>
                    </div>
                </div>
            </div>

        {/* F10.2 — Manual Trade compose dialog. Confirming inside the
            dialog stages the pre-approved composed payload on the ref
            and immediately fires the standard send path with the NL
            summary as the transcript message. The server honors
            `preApproved` and skips the redundant human_input_required
            modal while keeping every risk gate in place. */}
        <ManualComposeDialog
            open={composeOpen}
            onOpenChange={setComposeOpen}
            agentId={agentId}
            onConfirm={(prompt, composed) => {
                composedPayloadRef.current = composed;
                const synthetic = {
                    preventDefault: () => {},
                } as unknown as React.FormEvent<HTMLFormElement>;
                void handleSendMessage(synthetic, prompt);
            }}
        />

        {/* CEX post-PR237 cleanup — `trading_approval` was retired
            (the former `CEXApprovalDialog` was dormant for ~the last
            two releases). All trading approvals now route through
            `human_input` + `HumanInputDialog`, which embeds
            `TradingOrderEditor` and `MarketSnapshotPanel`. */}
        {pendingInterrupt?.type === "human_input" && (
            <Dialog
                id="human_input"
                props={{
                    isOpen: true,
                    data: pendingInterrupt.payload,
                    onApprove: handleHumanInputApprove,
                    onReject: handleHumanInputReject,
                    onApproveAllRemaining: handleHumanInputApproveAllRemaining,
                    agentId,
                }}
            />
        )}

        {/* Task Chain Approval Dialog */}
        {pendingApproval && (
            <TaskChainApprovalDialog
                isOpen={showApprovalDialog}
                taskChain={pendingApproval.taskChain}
                onApprove={handleApproveChain}
                onReject={handleRejectChain}
                onClose={() => setShowApprovalDialog(false)}
                onCancel={handleStopProcessing}
                isRegenerating={isRegeneratingChain}
                favoritesApi={favoriteTaskChainsWithSharingPrompt}
            />
        )}

        {showDailyLimitPrompt && (
            <LoginPrompt
                onClose={() => setShowDailyLimitPrompt(false)}
                onAnonymous={() => setShowDailyLimitPrompt(false)}
            />
        )}

        <PublicSharingPromptDialog
            open={isPublicSharingPromptOpen}
            onDecision={handlePublicSharingDecision}
        />

        {/* Favorite Task Chains Dialog */}
        <FavoriteTaskChainsDialog
            favoritesApi={favoriteTaskChainsWithSharingPrompt}
            open={showFavoritesDialog}
            onOpenChange={setShowFavoritesDialog}
            onSelect={(favorite) => {
                setSelectedFavoriteChain(favorite);
                markAsUsed(favorite.favoriteId);
            }}
        />
            </div>
        </div>
    );
}
