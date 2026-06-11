import { useMemo } from "react";
import { useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/contexts/ThemeContext";
import { cn } from "@/lib/utils";
import { TableOfContentsProvider } from "@/contexts/TableOfContentsContext";
import { MobileTocToggleButton } from "@/components/MobileTocToggleButton";
import { SharedChatTranscript } from "@/components/SharedChatTranscript";

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
    };
    roomId: string;
};

export default function SharedChatRoute() {
    const { shareCode } = useParams<{ shareCode: string }>();
    const { theme } = useTheme();

    const query = useQuery({
        queryKey: ["shared-chat", shareCode],
        queryFn: () => apiClient.getSharedChatByCode(String(shareCode)),
        enabled: Boolean(shareCode && shareCode.trim().length > 0),
        retry: false,
    });

    const title = "Shared chat";
    const shareAgentId = query.data?.share?.agentId ?? "";

    const memories = useMemo(() => {
        const items = (query.data?.memories ?? []) as SharedChatMemory[];
        return [...items].sort((a, b) => a.createdAt - b.createdAt);
    }, [query.data?.memories]);

    return (
        <TableOfContentsProvider>
            <div
                className={cn(
                    "min-h-screen w-full",
                    "bg-background text-foreground",
                    theme === "dark" && "dark"
                )}
                style={{ colorScheme: theme }}
            >
                <div className="mx-auto w-full max-w-6xl px-3 sm:px-6 lg:px-10 xl:px-12 pt-5 sm:pt-8 lg:pt-10 pb-32 sm:pb-28">
                    <header className="mb-5 sm:mb-6">
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                            <div className="flex items-center gap-3 min-w-0">
                                <img
                                    alt="SentiEdge"
                                    src={theme === "light" ? "/sentiedge-icon.jpg" : "/sentiedge-icon.png"}
                                    className="h-9 w-9 rounded-xl border border-slate-200/70 dark:border-white/15"
                                />
                                <div className="min-w-0">
                                    <h1 className="text-lg sm:text-xl font-semibold leading-tight truncate">{title}</h1>
                                </div>
                            </div>
                            <div className="self-end sm:self-auto">
                                <MobileTocToggleButton />
                            </div>
                        </div>
                    </header>

                    {query.isLoading ? (
                        <div className="space-y-3">
                            <div className="h-16 rounded-2xl bg-white/40 dark:bg-white/5 border border-slate-200/60 dark:border-white/10 animate-pulse" />
                            <div className="h-16 rounded-2xl bg-white/40 dark:bg-white/5 border border-slate-200/60 dark:border-white/10 animate-pulse" />
                            <div className="h-16 rounded-2xl bg-white/40 dark:bg-white/5 border border-slate-200/60 dark:border-white/10 animate-pulse" />
                        </div>
                    ) : query.isError ? (
                        <div className="rounded-2xl border border-slate-200/70 dark:border-white/15 bg-white/40 dark:bg-white/5 p-6">
                            <div className="text-base font-medium">Couldn&apos;t load this shared chat.</div>
                            <div className="mt-2 text-sm text-muted-foreground">
                                The link may be invalid or expired.
                            </div>
                        </div>
                    ) : (
                        <SharedChatTranscript memories={memories} shareAgentId={shareAgentId} />
                    )}
                </div>

            <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-slate-200/70 dark:border-white/15 bg-background/90 supports-[backdrop-filter]:backdrop-blur-md">
                <div className="mx-auto w-full max-w-6xl px-3 sm:px-6 lg:px-10 xl:px-12 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3">
                    <div className="text-sm text-center sm:text-left">
                        Want to try SentiEdge?
                    </div>
                        <Button asChild className="shadow-sm w-full sm:w-auto">
                            <a href="https://www.sentiedge.ai/" target="_blank" rel="noreferrer">
                                Try SentiEdge
                            </a>
                        </Button>
                    </div>
                </div>
            </div>
        </TableOfContentsProvider>
    );
}
