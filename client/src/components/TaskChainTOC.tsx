import type React from "react";
import { cn } from "@/lib/utils";
import {
    Ban,
    CheckCircle,
    Circle,
    Link,
    Loader2,
    XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";

export interface TaskChainTocTask {
    id: string;
    name: string;
    status: string;
}

interface TaskChainTOCProps {
    chainName: string;
    tasks: TaskChainTocTask[];
    selectedTaskId: string | null;
    onTaskClick: (taskId: string) => void;
    /** Summary row jumps to the first task (optional; parent stays visually neutral when a step is selected). */
    onSummaryClick?: () => void;
    className?: string;
    unstyled?: boolean;
}

const getTaskStatusIcon = (status: string) => {
    switch (status) {
        case "completed":
            return <CheckCircle className="size-3 text-green-500" />;
        case "failed":
            return <XCircle className="size-3 text-red-500" />;
        case "running":
            return <Loader2 className="size-3 text-blue-500 animate-spin" />;
        case "cancelled":
            return <Ban className="size-3 text-amber-500" />;
        case "pending":
            return <Circle className="size-3 text-gray-400" />;
        default:
            return <Circle className="size-3 text-gray-400" />;
    }
};

/**
 * Sidebar navigation for task chains, styled like ComprehensiveTOC (phase + steps).
 */
export const TaskChainTOC: React.FC<TaskChainTOCProps> = ({
    chainName,
    tasks,
    selectedTaskId,
    onTaskClick,
    onSummaryClick,
    className,
    unstyled = false,
}) => {
    const { t } = useTranslation();
    const resolvedChainTitle =
        typeof chainName === "string" && chainName.trim().length > 0
            ? chainName.trim()
            : String(t("progress.chainTasks"));

    const completedCount = tasks.filter((task) => task.status === "completed")
        .length;

    const navInner = (
        <div className="space-y-2">
            <div className="space-y-1">
                <button
                    type="button"
                    onClick={() => {
                        if (tasks.length === 0) {
                            return;
                        }
                        onSummaryClick?.();
                    }}
                    disabled={tasks.length === 0}
                    className={cn(
                        "relative w-full text-left text-sm md:text-xs transition-colors duration-200 rounded-lg px-2.5 py-2.5 md:py-2 border min-h-[44px] md:min-h-0",
                        "flex items-center gap-2 backdrop-blur-sm",
                        "border-transparent text-slate-700 dark:text-foreground/70 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-slate-100 dark:hover:bg-white/10 hover:border-slate-200 dark:hover:border-white/25",
                        tasks.length === 0 && "opacity-50 pointer-events-none",
                    )}
                >
                    <span className="flex size-5 items-center justify-center rounded-full border border-transparent">
                        <Link className="size-4 text-sky-500" />
                    </span>
                    <span className="text-slate-600 dark:text-foreground/60">1</span>
                    <span className="flex-1 min-w-0 truncate">
                        {resolvedChainTitle}
                    </span>
                    <span className="text-slate-500 dark:text-foreground/40 text-[10px] shrink-0 tabular-nums">
                        {completedCount}/{tasks.length}
                    </span>
                </button>

                {tasks.map((task, actionIndex) => {
                    const stepLabel = `1.${actionIndex + 1}`;
                    const isSelected = selectedTaskId === task.id;

                    return (
                        <button
                            key={task.id}
                            type="button"
                            onClick={() => onTaskClick(task.id)}
                            className={cn(
                                "relative w-full text-left text-sm md:text-xs transition-colors duration-200 rounded-lg px-2.5 py-2 md:py-1.5 border min-h-[40px] md:min-h-0",
                                "flex items-center gap-2 backdrop-blur-sm pl-8",
                                isSelected
                                    ? "backdrop-blur-md bg-emerald-50 dark:bg-white/20 border-emerald-200 dark:border-white/30 text-emerald-600 dark:text-emerald-500/90 font-semibold shadow"
                                    : "border-transparent text-slate-600 dark:text-foreground/60 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-slate-100 dark:hover:bg-white/10 hover:border-slate-200 dark:hover:border-white/25",
                            )}
                        >
                            <span
                                className={cn(
                                    "flex size-4 items-center justify-center shrink-0",
                                    isSelected &&
                                        "text-emerald-600 dark:text-emerald-500",
                                )}
                            >
                                {getTaskStatusIcon(task.status)}
                            </span>
                            <span
                                className={cn(
                                    "text-slate-500 dark:text-foreground/50 text-[10px] shrink-0 tabular-nums",
                                    isSelected &&
                                        "text-emerald-600 dark:text-emerald-500",
                                )}
                            >
                                {stepLabel}
                            </span>
                            <span
                                className={cn(
                                    "flex-1 line-clamp-1 leading-relaxed min-w-0",
                                    isSelected &&
                                        "text-emerald-600 dark:text-emerald-500",
                                )}
                            >
                                {task.name}
                            </span>
                        </button>
                    );
                })}
            </div>
        </div>
    );

    if (unstyled) {
        return (
            <nav
                className={cn("space-y-2", className)}
                aria-label={t("progress.chainTasks")}
            >
                {navInner}
            </nav>
        );
    }

    return (
        <div
            className={cn(
                "rounded-xl border border-slate-200 dark:border-white/10",
                "bg-white/20 dark:bg-white/5 backdrop-blur-xl",
                "shadow-[0_12px_30px_rgba(15,23,42,0.15)] dark:shadow-[0_12px_30px_rgba(15,23,42,0.45)]",
                "supports-[backdrop-filter]:bg-white/15 supports-[backdrop-filter]:dark:bg-white/5",
                "flex flex-col max-h-full",
                className,
            )}
        >
            <div className="flex-shrink-0 p-3 pb-2 border-b border-slate-200 dark:border-white/10">
                <h3 className="text-sm font-medium text-foreground/80">
                    {t("progress.chainTasks")}
                </h3>
            </div>
            <nav
                className="flex-1 overflow-y-auto px-3 py-2 space-y-2 scrollbar-thin scrollbar-thumb-muted-foreground/20 scrollbar-track-transparent"
                aria-label={t("progress.chainTasks")}
            >
                {navInner}
            </nav>
        </div>
    );
};
