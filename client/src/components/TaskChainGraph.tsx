import type React from 'react';
import { useMemo, useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Star } from 'lucide-react';
import type { TaskChainData } from './TaskChainBubble';
import type { FavoriteTaskChainsApi } from '@/hooks/useFavoriteTaskChains';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from 'react-i18next';

export interface TaskChainGraphProps {
    taskChain: TaskChainData;
    className?: string;
    onTaskClick?: (taskId: string) => void;
    selectedTaskId?: string | null;
    favoritesApi?: FavoriteTaskChainsApi;
    /** Only show favorite icon when chain has fully completed; default false */
    isComplete?: boolean;
}

interface TaskNode {
    id: string;
    name: string;
    type: 'llm' | 'action';
    dependencies: string[];
    level: number;
    x: number;
    y: number;
}

interface MergedEdge {
    sources: Array<{ id: string; x: number; y: number }>;
    target: { id: string; x: number; y: number };
    mergeY: number;
}

// Calculate hierarchical layout
function calculateLayout(tasks: TaskChainData['tasks']): { nodes: TaskNode[]; mergedEdges: MergedEdge[] } {
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const levels: string[][] = [];
    const taskLevels = new Map<string, number>();

    // Calculate level for each task based on dependencies
    function getTaskLevel(taskId: string, visited = new Set<string>()): number {
        if (taskLevels.has(taskId)) {
            return taskLevels.get(taskId)!;
        }

        const task = taskMap.get(taskId);
        if (!task) return 0;

        // Prevent circular dependencies
        if (visited.has(taskId)) return 0;
        visited.add(taskId);

        if (task.dependencies.length === 0) {
            taskLevels.set(taskId, 0);
            return 0;
        }

        const maxDepLevel = Math.max(
            ...task.dependencies.map(depId => getTaskLevel(depId, new Set(visited)))
        );
        const level = maxDepLevel + 1;
        taskLevels.set(taskId, level);
        return level;
    }

    // Calculate levels for all tasks
    tasks.forEach(task => {
        const level = getTaskLevel(task.id);
        if (!levels[level]) {
            levels[level] = [];
        }
        levels[level].push(task.id);
    });

    // Layout parameters (compact sizing for preview)
    const nodeWidth = 80;
    const nodeHeight = 40;
    const horizontalSpacing = 12;
    const verticalSpacing = 32;

    // Calculate positions
    const nodes: TaskNode[] = [];
    const maxWidth = Math.max(...levels.map(level => level.length)) * (nodeWidth + horizontalSpacing);

    levels.forEach((levelTasks, levelIndex) => {
        const levelWidth = levelTasks.length * (nodeWidth + horizontalSpacing) - horizontalSpacing;
        const startX = (maxWidth - levelWidth) / 2;

        levelTasks.forEach((taskId, taskIndex) => {
            const task = taskMap.get(taskId)!;
            nodes.push({
                id: task.id,
                name: task.name,
                type: task.type,
                dependencies: task.dependencies,
                level: levelIndex,
                x: startX + taskIndex * (nodeWidth + horizontalSpacing),
                y: levelIndex * (nodeHeight + verticalSpacing)
            });
        });
    });

    // Create merged edges
    const mergedEdges: MergedEdge[] = [];
    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    nodes.forEach(node => {
        if (node.dependencies.length === 0) return;

        const sources = node.dependencies
            .map(depId => {
                const depNode = nodeMap.get(depId);
                if (!depNode) return null;
                return {
                    id: depId,
                    x: depNode.x + nodeWidth / 2,
                    y: depNode.y + nodeHeight
                };
            })
            .filter(Boolean) as Array<{ id: string; x: number; y: number }>;

        if (sources.length > 0) {
            const targetY = node.y;
            const sourceMaxY = Math.max(...sources.map(s => s.y));
            const mergeY = sourceMaxY + (targetY - sourceMaxY) * 0.6; // Merge point at 60% of the gap

            mergedEdges.push({
                sources,
                target: {
                    id: node.id,
                    x: node.x + nodeWidth / 2,
                    y: targetY
                },
                mergeY
            });
        }
    });

    return { nodes, mergedEdges };
}

export const TaskChainGraph: React.FC<TaskChainGraphProps> = ({ taskChain, className, onTaskClick, selectedTaskId = null, favoritesApi, isComplete = false }) => {
    const { nodes, mergedEdges } = useMemo(() => calculateLayout(taskChain.tasks), [taskChain.tasks]);
    const [favoritePending, setFavoritePending] = useState(false);
    const [hoveredNode, setHoveredNode] = useState<string | null>(null);
    const [clickedNode, setClickedNode] = useState<string | null>(null);
    const { toast } = useToast();
    const { t } = useTranslation();

    useEffect(() => {
        setClickedNode(selectedTaskId);
    }, [selectedTaskId]);

    const isFavorite = favoritesApi ? favoritesApi.isFavorite(taskChain.id) : false;

    const handleToggleFavorite = async (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        if (!favoritesApi || favoritePending) {
            return;
        }

        try {
            setFavoritePending(true);
            if (isFavorite) {
                const existing = favoritesApi.getFavoriteByChainId(taskChain.id);
                if (existing) {
                    await favoritesApi.removeFavorite(existing.favoriteId);
                    toast({
                        title: t("taskChains.removedTitle"),
                        description: t("taskChains.removedDescription", { name: taskChain.name }),
                    });
                }
            } else {
                const favorite = await favoritesApi.addFavorite(taskChain);
                if (favorite) {
                    toast({
                        title: t("taskChains.addedTitle"),
                        description: t("taskChains.addedDescription", { name: favorite.name }),
                    });
                } else {
                    toast({
                        title: t("taskChains.favoriteFailedTitle"),
                        description: t("taskChains.favoriteFailedDescription"),
                        variant: "destructive",
                    });
                }
            }
        } catch (error) {
            console.error("Failed to toggle favorite from graph view:", error);
            toast({
                title: t("taskChains.favoriteUpdateFailedTitle"),
                description: t("taskChains.favoriteUpdateFailedDescription"),
                variant: "destructive",
            });
        } finally {
            setFavoritePending(false);
        }
    };

    if (nodes.length === 0) {
        return (
            <div className={cn("flex items-center justify-center p-8 text-muted-foreground", className)}>
                No tasks to display
            </div>
        );
    }

    const nodeWidth = 80;
    const nodeHeight = 40;
    const padding = 16;
    const svgWidth = Math.max(...nodes.map(n => n.x)) + nodeWidth + padding * 2;
    const svgHeight = Math.max(...nodes.map(n => n.y)) + nodeHeight + padding * 2;

    return (
        <div className={cn("relative w-full overflow-auto bg-muted/10 rounded-lg border border-border p-2 text-[11px]", className)}>
            {favoritesApi && isComplete && (
                <button
                    type="button"
                    onClick={handleToggleFavorite}
                    disabled={favoritePending}
                    className={cn(
                        "absolute top-2 right-2 p-1 rounded-md border transition-colors shadow-sm",
                        isFavorite
                            ? "border-yellow-400 bg-yellow-50 text-yellow-600 dark:bg-yellow-500/20 dark:border-yellow-400"
                            : "border-transparent bg-background/60 text-muted-foreground hover:border-white/30 hover:bg-white/20"
                    )}
                    title={isFavorite ? t("taskChains.removeFavorite") : t("taskChains.addFavorite")}
                    aria-label={isFavorite ? t("taskChains.removeFavorite") : t("taskChains.addFavorite")}
                >
                    <Star
                        className={cn(
                            "size-4 transition-colors",
                            isFavorite ? "fill-yellow-500 text-yellow-500" : "text-current"
                        )}
                    />
                </button>
            )}
            <svg
                viewBox={`0 0 ${svgWidth} ${svgHeight}`}
                className="w-full h-auto max-h-[25vh]"
                preserveAspectRatio="xMidYMid meet"
            >
                <defs>
                    {/* Arrow marker for edges - smaller size */}
                    <marker
                        id="arrowhead"
                        markerWidth="6"
                        markerHeight="6"
                        refX="5"
                        refY="2"
                        orient="auto"
                        className="fill-muted-foreground"
                    >
                        <polygon points="0 0, 6 2, 0 4" />
                    </marker>

                    {/* Default shadow filter - matches shadow-sm (0 1px 2px 0 rgb(0 0 0 / 0.05)) */}
                    <filter id="defaultShadow" x="-20%" y="-20%" width="140%" height="140%">
                        <feGaussianBlur in="SourceAlpha" stdDeviation="1" />
                        <feOffset dx="0" dy="1" result="offsetblur" />
                        <feComponentTransfer>
                            <feFuncA type="linear" slope="0.05" />
                        </feComponentTransfer>
                        <feMerge>
                            <feMergeNode />
                            <feMergeNode in="SourceGraphic" />
                        </feMerge>
                    </filter>

                    {/* Hover shadow filter - slightly enhanced shadow-sm */}
                    <filter id="hoverShadow" x="-30%" y="-30%" width="160%" height="160%">
                        <feGaussianBlur in="SourceAlpha" stdDeviation="2" />
                        <feOffset dx="0" dy="2" result="offsetblur" />
                        <feComponentTransfer>
                            <feFuncA type="linear" slope="0.15" />
                        </feComponentTransfer>
                        <feMerge>
                            <feMergeNode />
                            <feMergeNode in="SourceGraphic" />
                        </feMerge>
                    </filter>

                    {/* Clicked/Active shadow filter - bottom/sides only, no top shadow */}
                    <filter id="clickedShadow" x="-50%" y="-5%" width="200%" height="200%">
                        <feGaussianBlur in="SourceAlpha" stdDeviation="3" />
                        <feOffset dx="0" dy="2" result="offsetblur" />
                        <feComponentTransfer>
                            <feFuncA type="linear" slope="0.2" />
                        </feComponentTransfer>
                        <feMerge>
                            <feMergeNode />
                            <feMergeNode in="SourceGraphic" />
                        </feMerge>
                    </filter>
                </defs>

                {/* Draw merged edges */}
                <g className="edges">
                    {mergedEdges.map((edge, edgeIndex) => {
                        const targetX = edge.target.x + padding;
                        const targetY = edge.target.y + padding;
                        const mergeY = edge.mergeY + padding;

                        return (
                            <g key={`merged-edge-${edgeIndex}`}>
                                {/* Draw lines from each source to merge point */}
                                {edge.sources.map((source, sourceIndex) => {
                                    const sourceX = source.x + padding;
                                    const sourceY = source.y + padding;

                                    // Calculate control points for smooth curve to merge point
                                    const midY1 = sourceY + (mergeY - sourceY) * 0.4;
                                    const midY2 = sourceY + (mergeY - sourceY) * 0.6;

                                    const path = `M ${sourceX} ${sourceY}
                                                 C ${sourceX} ${midY1},
                                                   ${targetX} ${midY2},
                                                   ${targetX} ${mergeY}`;

                                    return (
                                        <path
                                            key={`source-${edgeIndex}-${sourceIndex}`}
                                            d={path}
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="1.5"
                                            className="text-muted-foreground/50 hover:text-primary transition-colors"
                                        />
                                    );
                                })}

                                {/* Draw single line from merge point to target with arrow */}
                                <line
                                    x1={targetX}
                                    y1={mergeY}
                                    x2={targetX}
                                    y2={targetY}
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                    markerEnd="url(#arrowhead)"
                                    className="text-muted-foreground/50 hover:text-primary transition-colors"
                                />
                            </g>
                        );
                    })}
                </g>

                {/* Draw nodes */}
                <g className="nodes">
                    {nodes.map(node => {
                        const isClicked = clickedNode === node.id;
                        const isHovered = hoveredNode === node.id;

                        return (
                            <g
                                key={node.id}
                                transform={
                                    isClicked
                                        ? `translate(${node.x + padding}, ${node.y + padding}) translate(${nodeWidth / 2}, ${nodeHeight / 2}) scale(1.1) translate(${-nodeWidth / 2}, ${-nodeHeight / 2})`
                                        : isHovered
                                        ? `translate(${node.x + padding}, ${node.y + padding}) translate(${nodeWidth / 2}, ${nodeHeight / 2}) scale(1.3) translate(${-nodeWidth / 2}, ${-nodeHeight / 2})`
                                        : `translate(${node.x + padding}, ${node.y + padding})`
                                }
                                className="group cursor-pointer"
                                onClick={() => {
                                    setClickedNode(node.id);
                                    onTaskClick?.(node.id);
                                }}
                                onMouseEnter={() => setHoveredNode(node.id)}
                                onMouseLeave={() => setHoveredNode(null)}
                                filter={isClicked ? 'url(#clickedShadow)' : (isHovered ? 'url(#hoverShadow)' : 'url(#defaultShadow)')}
                                style={{ transition: 'all 0.4s ease-in-out' }}
                            >
                {/* Node rectangle */}
                <rect
                    width={nodeWidth}
                    height={nodeHeight}
                    rx="8"
                    className="fill-green-100 dark:fill-green-950 stroke-green-500/80 dark:stroke-green-400/80"
                    strokeWidth="1"
                />

                                {/* Task name */}
                                <foreignObject
                                    x="4"
                                    y="4"
                                    width={nodeWidth - 8}
                                    height={nodeHeight - 8}
                                >
                                    <div className="flex items-center justify-center h-full px-1">
                                        <p className="text-[8px] font-medium text-foreground text-center line-clamp-3 select-none leading-snug">
                                            {node.name}
                                        </p>
                                    </div>
                                </foreignObject>
                            </g>
                        );
                    })}
                </g>
            </svg>
        </div>
    );
};
