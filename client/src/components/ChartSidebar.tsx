import type React from 'react';
import { useState, useRef, useEffect } from 'react';
import { ExternalLink, BarChart3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';

interface ChartSidebarProps {
    chartPaths: string[];
    showAllCharts: boolean;
    onToggleShowAll: () => void;
    onChartClick?: (chartPath: string) => void;
    className?: string;
}

export const ChartSidebar: React.FC<ChartSidebarProps> = ({
    chartPaths,
    showAllCharts,
    onToggleShowAll,
    onChartClick,
    className
}) => {
    const { t } = useTranslation();
    // Collapse state for hover interaction
    const [isCollapsed, setIsCollapsed] = useState(false);
    const collapseTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    // Cleanup timeout on unmount
    useEffect(() => {
        return () => {
            if (collapseTimeoutRef.current) {
                clearTimeout(collapseTimeoutRef.current);
            }
        };
    }, []);

    // Mouse event handlers
    const handleMouseEnter = () => {
        if (collapseTimeoutRef.current) {
            clearTimeout(collapseTimeoutRef.current);
            collapseTimeoutRef.current = null;
        }
        setIsCollapsed(false);
    };

    const handleMouseLeave = () => {
        collapseTimeoutRef.current = setTimeout(() => {
            setIsCollapsed(true);
        }, 1500); // 1.5 seconds delay
    };

    // Don't render if no charts
    if (chartPaths.length === 0) {
        return null;
    }

    // Collapse logic: show first 2 charts if more than 4 exist
    const shouldCollapseCharts = chartPaths.length > 4 && !showAllCharts;
    const chartsToRender = shouldCollapseCharts
        ? chartPaths.slice(0, 2)
        : chartPaths;
    const isInteractive = typeof onChartClick === "function";

    return (
        <div
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            className={cn(
                "fixed right-12 bottom-4 z-20",
                "rounded-3xl border border-white/30 dark:border-white/20",
                "bg-white/50 dark:bg-slate-900/40",
                "backdrop-blur-md shadow-[0_8px_32px_rgba(15,23,42,0.4)]",
                "overflow-hidden flex flex-col",
                "hidden lg:flex", // Only show on desktop
                "transition-all duration-500 ease-in-out",
                isCollapsed
                    ? "w-14 h-14 items-center justify-center"
                    : "w-80 max-h-[calc(100vh-8rem)]",
                className
            )}
        >
            {/* Collapsed View - Icon + Badge */}
            {isCollapsed ? (
                <div className="flex items-center justify-center p-3 relative">
                    <BarChart3 className="size-6 text-foreground/70" />
                    <span className="absolute -top-0.5 -right-0.5 bg-primary text-primary-foreground text-xs rounded-full min-w-5 h-5 flex items-center justify-center font-semibold px-1.5">
                        {chartPaths.length}
                    </span>
                </div>
            ) : (
                <>
                    {/* Header */}
                    <div className="flex-shrink-0 px-4 py-3 border-b border-white/20 dark:border-white/10">
                        <div className="flex items-center gap-2 text-sm font-medium text-foreground/80">
                            <ExternalLink className="size-4" />
                            <span>{t('charts.generatedCharts')}</span>
                            <span className="ml-auto text-xs text-muted-foreground">
                                {chartPaths.length}
                            </span>
                        </div>
                    </div>

                    {/* Chart List - Scrollable */}
                    <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2 scrollbar-thin scrollbar-thumb-muted-foreground/20 scrollbar-track-transparent">
                        {chartsToRender.map((chartPath, index) => {
                            const fileName = chartPath.split("/").pop() || chartPath.split("\\").pop() || t('charts.chartLabel', { index: index + 1 });
                            const displayName = fileName.replace(/\.(html|png)$/, "").replace(/_/g, " ");

                            return (
                                <div key={chartPath} className="relative">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="w-full text-xs h-9 gap-2 justify-start truncate"
                                        onClick={() => onChartClick?.(chartPath)}
                                        disabled={!isInteractive}
                                    >
                                        <ExternalLink className="size-3 flex-shrink-0" />
                                        <span className="truncate">{displayName}</span>
                                    </Button>
                                </div>
                            );
                        })}

                        {/* Show All / Fold Button */}
                        {shouldCollapseCharts && (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={onToggleShowAll}
                                className="w-full text-xs h-8"
                                aria-label={t('charts.showAllCharts')}
                                title={t('charts.showAllCharts')}
                            >
                                ··· {t('charts.moreChartsButton', { count: chartPaths.length - 2 })}
                            </Button>
                        )}
                        {!shouldCollapseCharts && chartPaths.length > 4 && (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={onToggleShowAll}
                                className="w-full text-xs h-8"
                                aria-label={t('charts.foldCharts')}
                                title={t('charts.foldCharts')}
                            >
                                {t('charts.foldCharts')}
                            </Button>
                        )}
                    </div>
                </>
            )}
        </div>
    );
};
