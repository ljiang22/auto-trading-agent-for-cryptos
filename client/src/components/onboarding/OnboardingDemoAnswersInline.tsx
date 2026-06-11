import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { ComprehensiveActionTab } from "@/components/ComprehensiveActionTab";
import { TaskChainTabs } from "@/components/TaskChainTabs";
import { TaskChainBubble, type TaskChainData } from "@/components/TaskChainBubble";
import type { ContentWithUser } from "@/components/chat/types";
import type { UUID } from "@elizaos/core";
import { useTheme } from "@/contexts/ThemeContext";
import { Avatar, AvatarImage } from "@/components/ui/avatar";
import { ChatBubble, ChatBubbleMessage } from "@/components/ui/chat/chat-bubble";
import { ONBOARDING_DEMO_ACTIVE_KEY, ONBOARDING_DEMO_SELECT_TAB_EVENT } from "@/lib/onboarding";

import regularJsonRaw from "@/content/onboarding-demo/regular.json?raw";
import comprehensiveJsonRaw from "@/content/onboarding-demo/comprehensive.json?raw";
import taskChainJsonRaw from "@/content/onboarding-demo/task-chain.json?raw";
import type { TaskGraphEdge, TaskGraphNode } from "@/components/onboarding/TaskChainGraphNav";

export type DemoAnswerType = "regular" | "comprehensive" | "task-chain";

type DemoBlock =
    | { type: "markdown"; markdown: string }
    | { type: "image"; src: string; alt?: string; caption?: string }
    | { type: "chart"; chartPath?: string; src?: string; title?: string }
    | { type: "divider" }
    | {
          type: "task-graph";
          title?: string;
          defaultSelectedId?: string;
          nodes: TaskGraphNode[];
          edges: TaskGraphEdge[];
          detailsMarkdownById?: Record<string, string>;
      };

type DemoAnswerDocument = {
    title?: string;
    question?: string;
    blocks: DemoBlock[];
};

type DemoComprehensiveActionResult = {
    action: string;
    phase: string;
    status: "success" | "failed" | "pending";
    content: string;
    summary?: string;
    message?: {
        id: string;
        text: string;
        createdAt: number;
        source?: string;
        attachments?: any[];
        metadata?: any;
        error?: any;
    };
};

const safeParseDemoJson = (raw: string): DemoAnswerDocument => {
    try {
        const parsed = JSON.parse(raw) as Partial<DemoAnswerDocument>;
        const blocks = Array.isArray(parsed.blocks) ? (parsed.blocks as DemoBlock[]) : [];
        return {
            title: typeof parsed.title === "string" ? parsed.title : undefined,
            question: typeof parsed.question === "string" ? parsed.question : undefined,
            blocks,
        };
    } catch {
        return { blocks: [{ type: "markdown", markdown: raw }] };
    }
};

const isTaskGraphBlock = (block: DemoBlock | undefined | null): block is Extract<DemoBlock, { type: "task-graph" }> => {
    return Boolean(block && typeof block === "object" && "type" in block && block.type === "task-graph");
};

const getMarkdownBlocksText = (blocks: DemoBlock[]): string => {
    const markdownParts = blocks
        .filter((block) => block && typeof block === "object" && "type" in block && block.type === "markdown")
        .map((block) => (block as Extract<DemoBlock, { type: "markdown" }>).markdown ?? "")
        .filter((value) => value.trim().length > 0);

    return markdownParts.join("\n\n");
};

const mapPhaseFromHeading = (heading: string): string | null => {
    const match = /^\s*(\d+)(?:\.\d+)?\b/.exec(heading);
    const major = match ? Number(match[1]) : null;
    switch (major) {
        case 1:
            return "data_gathering";
        case 2:
            return "analysis";
        case 3:
            return "prediction";
        case 4:
            return "writing_report";
        default:
            return null;
    }
};

const stripLeadingNumbering = (text: string): string => {
    return text.replace(/^\s*\d+(?:\.\d+)*\s*/g, "").trim();
};

const buildComprehensiveActionResultsFromMarkdown = (markdown: string): DemoComprehensiveActionResult[] => {
    const lines = markdown.split("\n");
    const results: DemoComprehensiveActionResult[] = [];
    let inCodeBlock = false;
    let currentPhase = "analysis";
    const preambleLines: string[] = [];

    let currentHeading: string | null = null;
    let currentLines: string[] = [];
    let currentHeadingLine = "";

    const pushResult = (actionLabel: string, phase: string, sectionMarkdown: string) => {
        const createdAt = Date.now() + results.length * 1000;
        results.push({
            action: actionLabel,
            phase,
            status: "success",
            content: sectionMarkdown,
            summary: `${actionLabel} completed.`,
            message: {
                id: `onboarding-comp-${results.length + 1}`,
                text: sectionMarkdown,
                createdAt,
                source: "comprehensive_analysis",
                metadata: {
                    actionName: actionLabel,
                    phase,
                    success: true,
                },
            },
        });
    };

    const flush = () => {
        if (!currentHeading) {
            return;
        }
        const actionName = stripLeadingNumbering(currentHeading);
        const sectionMarkdown = [currentHeadingLine, ...currentLines].join("\n").trim();
        pushResult(actionName || currentHeading, currentPhase, sectionMarkdown);

        currentHeading = null;
        currentHeadingLine = "";
        currentLines = [];
    };

    for (const rawLine of lines) {
        const line = rawLine;
        const trimmed = line.trim();

        if (trimmed.startsWith("```")) {
            inCodeBlock = !inCodeBlock;
        }

        if (!inCodeBlock) {
            const phaseHeadingMatch = /^(#{2})\s+(.*)$/.exec(trimmed);
            if (phaseHeadingMatch) {
                const maybePhase = mapPhaseFromHeading(phaseHeadingMatch[2] ?? "");
                if (maybePhase) {
                    currentPhase = maybePhase;
                }
            }

            const actionHeadingMatch = /^(#{3})\s+(.*)$/.exec(trimmed);
            if (actionHeadingMatch) {
                if (!results.length) {
                    const preambleText = preambleLines.join("\n").trim();
                    if (preambleText.length > 0) {
                        pushResult("Overview", currentPhase, preambleText);
                    }
                    preambleLines.length = 0;
                }
                flush();
                currentHeading = (actionHeadingMatch[2] ?? "").trim();
                currentHeadingLine = line;
                continue;
            }
        }

        if (currentHeading) {
            currentLines.push(line);
        } else {
            preambleLines.push(line);
        }
    }

    flush();
    if (results.length === 0) {
        const preambleText = preambleLines.join("\n").trim();
        if (preambleText.length > 0) {
            pushResult("Overview", currentPhase, preambleText);
        }
    }
    return results;
};

const buildTaskChainDataFromGraphBlock = (block: Extract<DemoBlock, { type: "task-graph" }>): TaskChainData => {
    const tasks = block.nodes.map((node) => {
        const dependencies = block.edges.filter((edge) => edge.to === node.id).map((edge) => edge.from);
        return {
            id: node.id,
            name: node.label,
            description: "",
            type: "action" as const,
            status: "completed" as const,
            dependencies,
            hasResult: true,
            isSuccess: true,
        };
    });

    return {
        id: "onboarding-demo-task-chain",
        name: block.title ?? "Task Chain",
        description: "Saved onboarding example",
        originalRequest: "What is the price of BTC?",
        tasks,
    };
};

const buildTaskChainMessagesFromGraphBlock = (block: Extract<DemoBlock, { type: "task-graph" }>): ContentWithUser[] => {
    const byId = block.detailsMarkdownById ?? {};
    const baseTime = Date.now();

    return block.nodes
        .map((node, index) => {
            const text = byId[node.id] ?? "";
            if (!text.trim()) {
                return null;
            }

            const createdAt = baseTime + index * 1200;
            return {
                id: `onboarding-task-${node.id}`,
                user: "assistant",
                createdAt,
                text,
                content: {
                    text,
                    source: "task_chain_action",
                    metadata: {
                        taskId: node.id,
                        success: true,
                    },
                },
                metadata: {
                    taskId: node.id,
                    success: true,
                },
            } as unknown as ContentWithUser;
        })
        .filter(Boolean) as ContentWithUser[];
};

export default function OnboardingDemoAnswersInline(props: {
    defaultTab?: DemoAnswerType;
    anchorPrefixBase?: string;
}) {
    const { defaultTab = "regular", anchorPrefixBase = "" } = props;
    const [tab, setTab] = useState<DemoAnswerType>(defaultTab);
    const [mode, setMode] = useState<"tabs" | "all">("tabs");
    const [guided, setGuided] = useState(false);
    const { theme } = useTheme();
    const agentIconSrc = theme === "light" ? "/sentiedge-icon.jpg" : "/sentiedge-icon.png";
    const demoAgentId = "00000000-0000-0000-0000-000000000000" as UUID;

    const contentByType = useMemo(
        () => ({
            regular: safeParseDemoJson(regularJsonRaw),
            comprehensive: safeParseDemoJson(comprehensiveJsonRaw),
            "task-chain": safeParseDemoJson(taskChainJsonRaw),
        }),
        []
    );

    const taskChainGraphBlock = useMemo(() => {
        const blocks = contentByType["task-chain"].blocks;
        const maybeGraphBlock = blocks.find((block) => isTaskGraphBlock(block));
        return isTaskGraphBlock(maybeGraphBlock) ? maybeGraphBlock : null;
    }, [contentByType]);

    const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

    useEffect(() => {
        if (!taskChainGraphBlock) {
            setSelectedTaskId(null);
            return;
        }
        const fallbackId = taskChainGraphBlock.nodes[0]?.id ?? null;
        setSelectedTaskId(taskChainGraphBlock.defaultSelectedId ?? fallbackId);
    }, [taskChainGraphBlock]);

    const normalizedAnchorPrefixBase = useMemo(() => {
        if (!anchorPrefixBase) {
            return "";
        }
        return anchorPrefixBase.endsWith("-") ? anchorPrefixBase : `${anchorPrefixBase}-`;
    }, [anchorPrefixBase]);

    const anchorPrefixByType = useMemo(
        () => ({
            regular: `${normalizedAnchorPrefixBase}onboarding-demo-regular-`,
            comprehensive: `${normalizedAnchorPrefixBase}onboarding-demo-comprehensive-`,
            "task-chain": `${normalizedAnchorPrefixBase}onboarding-demo-task-chain-`,
        }),
        [normalizedAnchorPrefixBase]
    );

    useEffect(() => {
        setTab(defaultTab);
    }, [defaultTab]);

    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }
        try {
            setGuided(window.localStorage.getItem(ONBOARDING_DEMO_ACTIVE_KEY) === "1");
        } catch {
            setGuided(false);
        }
    }, []);

    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }

        const handler = (event: Event) => {
            const detail = (event as CustomEvent<{ tab?: DemoAnswerType }>).detail;
            const nextTab = detail?.tab;
            if (nextTab === "regular" || nextTab === "comprehensive" || nextTab === "task-chain") {
                setTab(nextTab);
            }
        };

        window.addEventListener(ONBOARDING_DEMO_SELECT_TAB_EVENT, handler as EventListener);
        return () => {
            window.removeEventListener(ONBOARDING_DEMO_SELECT_TAB_EVENT, handler as EventListener);
        };
    }, []);

    const regularMarkdown = useMemo(() => getMarkdownBlocksText(contentByType.regular.blocks), [contentByType]);
    const comprehensiveMarkdown = useMemo(
        () => getMarkdownBlocksText(contentByType.comprehensive.blocks),
        [contentByType]
    );

    const comprehensiveActionResults = useMemo(
        () => buildComprehensiveActionResultsFromMarkdown(comprehensiveMarkdown),
        [comprehensiveMarkdown]
    );

    const taskChainData = useMemo(() => {
        if (!taskChainGraphBlock) return null;
        return buildTaskChainDataFromGraphBlock(taskChainGraphBlock);
    }, [taskChainGraphBlock]);

    const taskChainMessages = useMemo(() => {
        if (!taskChainGraphBlock) return [];
        return buildTaskChainMessagesFromGraphBlock(taskChainGraphBlock);
    }, [taskChainGraphBlock]);

    const taskChainExtraMarkdown = useMemo(() => {
        const blocks = contentByType["task-chain"].blocks;
        const withoutGraph = taskChainGraphBlock ? blocks.filter((block) => block !== taskChainGraphBlock) : blocks;
        return getMarkdownBlocksText(withoutGraph);
    }, [contentByType, taskChainGraphBlock]);

    const renderOnboardingMessage = (message: ContentWithUser, index: number) => {
        const messageId = (message as any)?.id ?? `${message.createdAt}-${index}`;
        const anchorPrefix = `${anchorPrefixByType["task-chain"]}${String(messageId)}-`;

        return (
            <div key={`${messageId}`} className="flex flex-col gap-3 max-w-full min-w-0">
                <div className="md:border md:border-muted/30 md:rounded-lg md:shadow-sm md:bg-gradient-to-br md:from-card/50 md:to-muted/10 max-w-full min-w-0">
                    <div className="py-2 md:p-4 max-w-full min-w-0">
                        <ChatBubble variant="received" className="flex flex-row items-center gap-2">
                            <Avatar className="hidden md:flex size-8 p-1 border rounded-full select-none">
                                <AvatarImage src={agentIconSrc} />
                            </Avatar>
                            <div className="flex flex-col max-w-full min-w-0">
                                <ChatBubbleMessage>
                                    <MarkdownRenderer className="" anchorPrefix={anchorPrefix}>
                                        {message.text ?? ""}
                                    </MarkdownRenderer>
                                </ChatBubbleMessage>
                            </div>
                        </ChatBubble>
                    </div>
                </div>
            </div>
        );
    };

    const guidedContent = useMemo(() => {
        if (tab === "regular") {
            return (
                <div className="flex flex-col gap-3 max-w-full min-w-0">
                    <div className="md:border md:border-muted/30 md:rounded-lg md:shadow-sm md:bg-gradient-to-br md:from-card/50 md:to-muted/10 max-w-full min-w-0">
                        <div className="py-2 md:p-4 max-w-full min-w-0">
                            <ChatBubble variant="received" className="flex flex-row items-center gap-2">
                                <Avatar className="hidden md:flex size-8 p-1 border rounded-full select-none">
                                    <AvatarImage src={agentIconSrc} />
                                </Avatar>
                                <div className="flex flex-col max-w-full min-w-0">
                                    <ChatBubbleMessage>
                                        <MarkdownRenderer
                                            className=""
                                            anchorPrefix={`${anchorPrefixByType.regular}regular-guided-`}
                                        >
                                            {regularMarkdown}
                                        </MarkdownRenderer>
                                    </ChatBubbleMessage>
                                </div>
                            </ChatBubble>
                        </div>
                    </div>
                </div>
            );
        }

        if (tab === "comprehensive") {
            return (
                <ComprehensiveActionTab
                    title={contentByType.comprehensive.title ?? "Comprehensive (Saved Example)"}
                    actionResults={comprehensiveActionResults}
                    agentId={demoAgentId}
                    deletedFiles={new Set()}
                />
            );
        }

	        if (tab === "task-chain") {
	            if (!taskChainGraphBlock || !taskChainData) {
	                return null;
	            }
	            return (
	                <div className="space-y-4">
	                    <TaskChainBubble taskChain={taskChainData} isComplete />
	                    {taskChainExtraMarkdown.trim().length > 0 ? (
	                        <div className="md:border md:border-muted/30 md:rounded-lg md:shadow-sm md:bg-gradient-to-br md:from-card/50 md:to-muted/10 max-w-full min-w-0">
	                            <div className="py-2 md:p-4 max-w-full min-w-0">
	                                <ChatBubble variant="received" className="flex flex-row items-center gap-2">
	                                    <Avatar className="hidden md:flex size-8 p-1 border rounded-full select-none">
                                        <AvatarImage src={agentIconSrc} />
                                    </Avatar>
                                    <div className="flex flex-col max-w-full min-w-0">
                                        <ChatBubbleMessage>
                                            <MarkdownRenderer
                                                className=""
                                                anchorPrefix={`${anchorPrefixByType["task-chain"]}extra-guided-`}
                                            >
                                                {taskChainExtraMarkdown}
                                            </MarkdownRenderer>
                                        </ChatBubbleMessage>
                                    </div>
                                </ChatBubble>
                            </div>
                        </div>
                    ) : null}
                    <TaskChainTabs
                        taskChainData={taskChainData}
                        messages={taskChainMessages}
                        renderMessage={renderOnboardingMessage}
                        selectedTaskId={selectedTaskId}
                        onTaskSelect={setSelectedTaskId}
                        deletedFiles={new Set()}
                    />
                </div>
            );
        }

        return null;
    }, [
        agentIconSrc,
        anchorPrefixByType,
        comprehensiveActionResults,
        contentByType.comprehensive.title,
        demoAgentId,
        regularMarkdown,
        renderOnboardingMessage,
        selectedTaskId,
        tab,
        taskChainData,
        taskChainExtraMarkdown,
        taskChainGraphBlock,
        taskChainMessages,
    ]);

    if (guided) {
        return (
            <div className="w-full max-w-full min-w-0 space-y-4" data-tour="demo-compare">
                {guidedContent}
            </div>
        );
    }

    return (
        <div className="w-full max-w-full min-w-0 space-y-3" data-tour="demo-compare">
            <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold">Compare 3 answer styles</div>
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setMode((value) => (value === "tabs" ? "all" : "tabs"))}
                >
                    {mode === "tabs" ? "Show all" : "Show tabs"}
                </Button>
            </div>

            {mode === "tabs" ? (
                <Tabs value={tab} onValueChange={(value) => setTab(value as DemoAnswerType)}>
                    <TabsList className="w-full justify-start">
                        <TabsTrigger value="regular" data-tour="demo-tab-regular">
                            Regular
                        </TabsTrigger>
                        <TabsTrigger value="comprehensive" data-tour="demo-tab-comprehensive">
                            Comprehensive
                        </TabsTrigger>
                        <TabsTrigger value="task-chain" data-tour="demo-tab-task-chain">
                            Task Chain
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="regular">
                        <div className="flex flex-col gap-3 max-w-full min-w-0">
                            <div className="md:border md:border-muted/30 md:rounded-lg md:shadow-sm md:bg-gradient-to-br md:from-card/50 md:to-muted/10 max-w-full min-w-0">
                                <div className="py-2 md:p-4 max-w-full min-w-0">
                                    <ChatBubble variant="received" className="flex flex-row items-center gap-2">
                                        <Avatar className="hidden md:flex size-8 p-1 border rounded-full select-none">
                                            <AvatarImage src={agentIconSrc} />
                                        </Avatar>
                                        <div className="flex flex-col max-w-full min-w-0">
                                            <ChatBubbleMessage>
                                                <MarkdownRenderer
                                                    className=""
                                                    anchorPrefix={`${anchorPrefixByType.regular}regular-`}
                                                >
                                                    {regularMarkdown}
                                                </MarkdownRenderer>
                                            </ChatBubbleMessage>
                                        </div>
                                    </ChatBubble>
                                </div>
                            </div>
                        </div>
                    </TabsContent>

                    <TabsContent value="comprehensive">
                        <ComprehensiveActionTab
                            title={contentByType.comprehensive.title ?? "Comprehensive (Saved Example)"}
                            actionResults={comprehensiveActionResults}
                            agentId={demoAgentId}
                            deletedFiles={new Set()}
                        />
                    </TabsContent>

	                    <TabsContent value="task-chain">
	                        {taskChainGraphBlock && taskChainData ? (
	                            <div className="space-y-4">
	                                <TaskChainBubble taskChain={taskChainData} isComplete />
	                                {taskChainExtraMarkdown.trim().length > 0 ? (
	                                    <div className="md:border md:border-muted/30 md:rounded-lg md:shadow-sm md:bg-gradient-to-br md:from-card/50 md:to-muted/10 max-w-full min-w-0">
	                                        <div className="py-2 md:p-4 max-w-full min-w-0">
	                                            <ChatBubble variant="received" className="flex flex-row items-center gap-2">
	                                                <Avatar className="hidden md:flex size-8 p-1 border rounded-full select-none">
                                                    <AvatarImage src={agentIconSrc} />
                                                </Avatar>
                                                <div className="flex flex-col max-w-full min-w-0">
                                                    <ChatBubbleMessage>
                                                        <MarkdownRenderer
                                                            className=""
                                                            anchorPrefix={`${anchorPrefixByType["task-chain"]}extra-`}
                                                        >
                                                            {taskChainExtraMarkdown}
                                                        </MarkdownRenderer>
                                                    </ChatBubbleMessage>
                                                </div>
                                            </ChatBubble>
                                        </div>
                                    </div>
                                ) : null}
                                <TaskChainTabs
                                    taskChainData={taskChainData}
                                    messages={taskChainMessages}
                                    renderMessage={renderOnboardingMessage}
                                    selectedTaskId={selectedTaskId}
                                    onTaskSelect={setSelectedTaskId}
                                    deletedFiles={new Set()}
                                />
                            </div>
                        ) : null}
                    </TabsContent>
                </Tabs>
            ) : (
                <div className="space-y-8">
                    <div>
                        <div className="text-sm font-semibold mb-2">Regular</div>
                        <div className="md:border md:border-muted/30 md:rounded-lg md:shadow-sm md:bg-gradient-to-br md:from-card/50 md:to-muted/10 max-w-full min-w-0">
                            <div className="py-2 md:p-4 max-w-full min-w-0">
                                <ChatBubble variant="received" className="flex flex-row items-center gap-2">
                                    <Avatar className="hidden md:flex size-8 p-1 border rounded-full select-none">
                                        <AvatarImage src={agentIconSrc} />
                                    </Avatar>
                                    <div className="flex flex-col max-w-full min-w-0">
                                        <ChatBubbleMessage>
                                            <MarkdownRenderer
                                                className=""
                                                anchorPrefix={`${anchorPrefixByType.regular}regular-all-`}
                                            >
                                                {regularMarkdown}
                                            </MarkdownRenderer>
                                        </ChatBubbleMessage>
                                    </div>
                                </ChatBubble>
                            </div>
                        </div>
                    </div>
                    <div>
                        <div className="text-sm font-semibold mb-2">Comprehensive</div>
                        <ComprehensiveActionTab
                            title={contentByType.comprehensive.title ?? "Comprehensive (Saved Example)"}
                            actionResults={comprehensiveActionResults}
                            agentId={demoAgentId}
                            deletedFiles={new Set()}
                        />
                    </div>
	                    <div>
	                        <div className="text-sm font-semibold mb-2">Task Chain</div>
	                        {taskChainGraphBlock && taskChainData ? (
	                            <div className="space-y-4">
	                                <TaskChainBubble taskChain={taskChainData} isComplete />
	                                {taskChainExtraMarkdown.trim().length > 0 ? (
	                                    <div className="md:border md:border-muted/30 md:rounded-lg md:shadow-sm md:bg-gradient-to-br md:from-card/50 md:to-muted/10 max-w-full min-w-0">
	                                        <div className="py-2 md:p-4 max-w-full min-w-0">
	                                            <ChatBubble variant="received" className="flex flex-row items-center gap-2">
	                                                <Avatar className="hidden md:flex size-8 p-1 border rounded-full select-none">
                                                    <AvatarImage src={agentIconSrc} />
                                                </Avatar>
                                                <div className="flex flex-col max-w-full min-w-0">
                                                    <ChatBubbleMessage>
                                                        <MarkdownRenderer
                                                            className=""
                                                            anchorPrefix={`${anchorPrefixByType["task-chain"]}extra-all-`}
                                                        >
                                                            {taskChainExtraMarkdown}
                                                        </MarkdownRenderer>
                                                    </ChatBubbleMessage>
                                                </div>
                                            </ChatBubble>
                                        </div>
                                    </div>
                                ) : null}
                                <TaskChainTabs
                                    taskChainData={taskChainData}
                                    messages={taskChainMessages}
                                    renderMessage={renderOnboardingMessage}
                                    selectedTaskId={selectedTaskId}
                                    onTaskSelect={setSelectedTaskId}
                                    deletedFiles={new Set()}
                                />
                            </div>
                        ) : null}
                    </div>
                </div>
            )}
        </div>
    );
}
