import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { apiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ModeBadge } from "@/components/cex/ModeBadge";

type StrategyInstance = {
    id: string;
    strategy_id?: string;
    version?: number;
    mode?: "paper" | "shadow" | "live";
    status: "active" | "paused" | "stopped";
    started_at?: string;
    paused_at?: string;
    last_intent_at?: string;
};

const STATUS_BADGE: Record<string, string> = {
    active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
    paused: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    stopped: "bg-slate-100 text-slate-700 dark:bg-slate-800/40 dark:text-slate-300",
};

export default function StrategiesPage() {
    const navigate = useNavigate();
    const qc = useQueryClient();
    const query = useQuery({
        queryKey: ["user", "strategies"],
        queryFn: async () => {
            const r = await apiClient.listStrategies();
            return r.strategies as unknown as StrategyInstance[];
        },
        refetchInterval: 15_000,
    });

    const update = useMutation({
        mutationFn: async (args: { id: string; status: "active" | "paused" | "stopped" }) =>
            apiClient.setStrategyStatus(args.id, args.status),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["user", "strategies"] });
        },
        onError: (err) => {
            toast.error(
                `Failed to update strategy: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        },
    });

    const strategies = query.data ?? [];

    return (
        <div className="p-6 max-w-6xl mx-auto">
            <div className="flex items-center justify-between gap-3 mb-4">
                <h1 className="text-2xl font-semibold">Strategies</h1>
                <ModeBadge />
            </div>
            {query.isLoading ? (
                <p className="text-muted-foreground text-sm">Loading…</p>
            ) : strategies.length === 0 ? (
                <p className="text-muted-foreground text-sm">No strategies running.</p>
            ) : (
                <div className="space-y-2">
                    {strategies.map((s) => (
                        <div
                            key={s.id}
                            className="flex items-center justify-between border border-border rounded-md p-3 hover:bg-muted/20"
                        >
                            <div className="flex flex-col gap-1">
                                <div className="flex items-center gap-2">
                                    <span className="font-mono text-sm">
                                        {s.strategy_id ?? s.id}
                                    </span>
                                    <span
                                        className={cn(
                                            "inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ring-1 ring-border",
                                            STATUS_BADGE[s.status],
                                        )}
                                    >
                                        {s.status}
                                    </span>
                                    {s.mode && <ModeBadge mode={s.mode} />}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                    started {s.started_at ? new Date(s.started_at).toLocaleString() : "—"} ·
                                    last intent {s.last_intent_at ? new Date(s.last_intent_at).toLocaleString() : "—"}
                                </div>
                            </div>
                            <div className="flex gap-2">
                                {s.status === "active" && (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => update.mutate({ id: s.id, status: "paused" })}
                                    >
                                        Pause
                                    </Button>
                                )}
                                {s.status === "paused" && (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => update.mutate({ id: s.id, status: "active" })}
                                    >
                                        Resume
                                    </Button>
                                )}
                                {s.status !== "stopped" && (
                                    <Button
                                        size="sm"
                                        variant="destructive"
                                        onClick={() => update.mutate({ id: s.id, status: "stopped" })}
                                    >
                                        Stop
                                    </Button>
                                )}
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => navigate(`/orders?strategy_id=${encodeURIComponent(s.id)}`)}
                                >
                                    View runs
                                </Button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
