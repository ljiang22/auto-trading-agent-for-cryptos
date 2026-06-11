import { useMemo, useState } from "react";

export type TaskGraphNode = {
    id: string;
    label: string;
};

export type TaskGraphEdge = {
    from: string;
    to: string;
};

type PositionedNode = TaskGraphNode & {
    x: number;
    y: number;
};

const wrapLabel = (label: string, maxLineChars: number) => {
    const words = label.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
        return [label];
    }

    const lines: string[] = [];
    let current = "";

    for (const word of words) {
        const next = current ? `${current} ${word}` : word;
        if (next.length <= maxLineChars) {
            current = next;
            continue;
        }

        if (current) {
            lines.push(current);
            current = word;
        } else {
            lines.push(word.slice(0, Math.max(1, maxLineChars - 1)) + "…");
            current = "";
        }

        if (lines.length >= 2) {
            break;
        }
    }

    if (lines.length < 2 && current) {
        lines.push(current);
    }

    if (lines.length > 2) {
        return lines.slice(0, 2);
    }

    if (lines.length === 2 && words.join(" ").length > lines.join(" ").length) {
        const last = lines[1] ?? "";
        lines[1] = last.length >= 1 ? `${last.slice(0, Math.max(1, maxLineChars - 1))}…` : "…";
    }

    return lines;
};

const COLORS = {
    background: "hsl(var(--background))",
    foreground: "hsl(var(--foreground))",
    border: "hsl(var(--border))",
    muted: "hsl(var(--muted))",
    mutedForeground: "hsl(var(--muted-foreground))",
    primary: "hsl(var(--primary))",
    primaryForeground: "hsl(var(--primary-foreground))",
};

export const getTaskGraphLevelById = (nodes: TaskGraphNode[], edges: TaskGraphEdge[]) => {
    const indegree = new Map<string, number>();
    const outgoing = new Map<string, string[]>();

    for (const node of nodes) {
        indegree.set(node.id, 0);
        outgoing.set(node.id, []);
    }

    for (const edge of edges) {
        if (!outgoing.has(edge.from) || !indegree.has(edge.to)) {
            continue;
        }
        outgoing.get(edge.from)?.push(edge.to);
        indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    }

    const queue: string[] = [];
    for (const [id, degree] of indegree.entries()) {
        if (degree === 0) {
            queue.push(id);
        }
    }

    const levelById = new Map<string, number>();
    for (const id of queue) {
        levelById.set(id, 0);
    }

    while (queue.length) {
        const current = queue.shift();
        if (!current) {
            break;
        }
        const currentLevel = levelById.get(current) ?? 0;
        const neighbors = outgoing.get(current) ?? [];

        for (const to of neighbors) {
            const nextLevel = currentLevel + 1;
            const previousLevel = levelById.get(to);
            if (previousLevel === undefined || nextLevel > previousLevel) {
                levelById.set(to, nextLevel);
            }

            indegree.set(to, (indegree.get(to) ?? 0) - 1);
            if ((indegree.get(to) ?? 0) <= 0) {
                queue.push(to);
            }
        }
    }

    return levelById;
};

const buildLevels = (nodes: TaskGraphNode[], edges: TaskGraphEdge[]) => {
    const levelById = getTaskGraphLevelById(nodes, edges);
    const maxLevel = Math.max(0, ...Array.from(levelById.values()));
    const grouped: TaskGraphNode[][] = Array.from({ length: maxLevel + 1 }, () => []);

    for (const node of nodes) {
        const level = levelById.get(node.id) ?? 0;
        grouped[level]?.push(node);
    }

    return grouped.filter((levelNodes) => levelNodes.length > 0);
};

const layoutNodes = (
    levels: TaskGraphNode[][],
    {
        padding = 14,
        nodeWidth = 170,
        nodeHeight = 56,
        horizontalGap = 16,
        verticalGap = 22,
        minWidth = 280,
    }: {
        padding?: number;
        nodeWidth?: number;
        nodeHeight?: number;
        horizontalGap?: number;
        verticalGap?: number;
        minWidth?: number;
    }
) => {
    const levelWidths = levels.map((levelNodes) => {
        if (levelNodes.length === 0) {
            return 0;
        }
        return levelNodes.length * nodeWidth + (levelNodes.length - 1) * horizontalGap;
    });

    const contentWidth = Math.max(minWidth, ...levelWidths) + padding * 2;
    const contentHeight =
        padding * 2 +
        levels.length * nodeHeight +
        Math.max(0, levels.length - 1) * verticalGap;

    const positioned = new Map<string, PositionedNode>();

    levels.forEach((levelNodes, levelIndex) => {
        const levelWidth = levelWidths[levelIndex] ?? 0;
        const startX = (contentWidth - levelWidth) / 2;
        const y = padding + levelIndex * (nodeHeight + verticalGap);

        levelNodes.forEach((node, nodeIndex) => {
            const x = startX + nodeIndex * (nodeWidth + horizontalGap);
            positioned.set(node.id, { ...node, x, y });
        });
    });

    return { positioned, nodeWidth, nodeHeight, contentWidth, contentHeight };
};

const buildEdgePath = (from: PositionedNode, to: PositionedNode, nodeWidth: number, nodeHeight: number) => {
    const startX = from.x + nodeWidth / 2;
    const startY = from.y + nodeHeight;
    const endX = to.x + nodeWidth / 2;
    const endY = to.y;
    const midY = startY + (endY - startY) / 2;

    return `M ${startX} ${startY} V ${midY} H ${endX} V ${endY}`;
};

export function TaskChainGraphNav(props: {
    nodes: TaskGraphNode[];
    edges: TaskGraphEdge[];
    selectedId: string | null;
    onSelect: (id: string) => void;
}) {
    const { nodes, edges, selectedId, onSelect } = props;
    const [hoveredId, setHoveredId] = useState<string | null>(null);

    const { positioned, nodeWidth, nodeHeight, contentWidth, contentHeight } = useMemo(() => {
        const levels = buildLevels(nodes, edges);
        return layoutNodes(levels, {});
    }, [nodes, edges]);

    const highlightedEdgeKeys = useMemo(() => {
        const highlightId = hoveredId ?? selectedId;
        if (!highlightId) {
            return new Set<string>();
        }
        const keys = new Set<string>();
        for (const edge of edges) {
            if (edge.from === highlightId || edge.to === highlightId) {
                keys.add(`${edge.from}->${edge.to}`);
            }
        }
        return keys;
    }, [edges, hoveredId, selectedId]);

    if (!nodes.length) {
        return <div className="text-sm text-muted-foreground">No tasks defined.</div>;
    }

    return (
        <svg
            width="100%"
            viewBox={`0 0 ${contentWidth} ${contentHeight}`}
            className="block max-w-full"
            aria-label="Task graph navigation"
            role="img"
        >
            <rect x={0} y={0} width={contentWidth} height={contentHeight} fill="transparent" />

            {edges.map((edge) => {
                const from = positioned.get(edge.from);
                const to = positioned.get(edge.to);
                if (!from || !to) {
                    return null;
                }
                const isHighlighted = highlightedEdgeKeys.has(`${edge.from}->${edge.to}`);

                return (
                    <path
                        key={`${edge.from}-${edge.to}`}
                        d={buildEdgePath(from, to, nodeWidth, nodeHeight)}
                        fill="none"
                        stroke={isHighlighted ? COLORS.primary : COLORS.border}
                        strokeWidth={isHighlighted ? 2.25 : 1.25}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        opacity={isHighlighted ? 1 : 0.7}
                    />
                );
            })}

            {nodes.map((node) => {
                const positionedNode = positioned.get(node.id);
                if (!positionedNode) {
                    return null;
                }

                const isSelected = selectedId === node.id;
                const isHovered = hoveredId === node.id;
                const fill = isSelected ? COLORS.primary : COLORS.background;
                const stroke = isHovered ? COLORS.primary : COLORS.border;
                const labelColor = isSelected ? COLORS.primaryForeground : COLORS.foreground;
                const wrapped = wrapLabel(node.label, 21);
                const textStartY = wrapped.length === 1 ? positionedNode.y + 33 : positionedNode.y + 22;

                return (
                    <g key={node.id}>
                        <rect
                            x={positionedNode.x}
                            y={positionedNode.y}
                            width={nodeWidth}
                            height={nodeHeight}
                            rx={10}
                            fill={fill}
                            stroke={stroke}
                            strokeWidth={isSelected ? 2 : 1}
                            pointerEvents="all"
                            onMouseEnter={() => setHoveredId(node.id)}
                            onMouseLeave={() => setHoveredId((current) => (current === node.id ? null : current))}
                            onClick={() => onSelect(node.id)}
                            role="button"
                            tabIndex={0}
                            aria-label={`Select task: ${node.label}`}
                            style={{ cursor: "pointer" }}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    onSelect(node.id);
                                }
                            }}
                        />
                        {wrapped.map((line, lineIndex) => (
                            <text
                                // biome-ignore lint/suspicious/noArrayIndexKey: stable for fixed 2-line rendering.
                                key={`${node.id}-line-${lineIndex}`}
                                x={positionedNode.x + 12}
                                y={textStartY + lineIndex * 16}
                                fill={labelColor}
                                fontSize={12.2}
                                fontWeight={600}
                                pointerEvents="none"
                                style={{ userSelect: "none" }}
                            >
                                {line}
                            </text>
                        ))}
                    </g>
                );
            })}
        </svg>
    );
}
