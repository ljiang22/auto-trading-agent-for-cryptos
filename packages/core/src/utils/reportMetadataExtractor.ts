/**
 * Extracts chart paths and search result links from comprehensive analysis action results
 * and produces a sidecar metadata JSON for the daily report frontend.
 */

import path from "path";
import type { Memory } from "../core/types.ts";

export interface ReportChartDatasetSpec {
    label: string;
    data: Array<number | null>;
    borderColor: string;
    backgroundColor: string;
    type?: "line" | "bar";
    yAxisID?: string;
    fill?: boolean;
    tension?: number;
}

export interface ReportChartAxisSpec {
    title: string;
    position?: "left" | "right";
    format?: "number" | "currency" | "percent" | "millions";
}

export interface ReportChartSpec {
    labels: string[];
    datasets: ReportChartDatasetSpec[];
    axes?: Record<string, ReportChartAxisSpec>;
}

export interface ReportChartEntry {
    actionName: string;
    chartFilename: string;
    title: string;
    section: string;
    chartSpec?: ReportChartSpec;
}

export interface ReportSearchLink {
    title: string;
    url: string;
    publishedDate?: string;
}

export interface ReportSearchResult {
    actionName: string;
    query: string;
    links: ReportSearchLink[];
}

export interface ReportMetadata {
    date: string;
    target: string;
    generatedAt: number;
    charts: ReportChartEntry[];
    searchResults: ReportSearchResult[];
}

/**
 * Maps action names to their corresponding report section heading text.
 */
const ACTION_SECTION_MAP: Record<string, string> = {
    plot_price_charts: "Market Data and Current Status",
    Sentiment_Analysis: "Market Sentiment Analysis",
    FEAR_GREED_INDEX_ANALYSIS: "Fear and Greed Index Analysis",
    GET_ADDRESS_AND_TRANSACTION_DATA: "On-Chain Data Analysis",
    INFLOW_OUTFLOW_ANALYSIS: "On-Chain Data Analysis",
};

/**
 * Friendly display titles for chart actions.
 */
const ACTION_TITLE_MAP: Record<string, string> = {
    plot_price_charts: "Price Chart",
    Sentiment_Analysis: "Sentiment Chart",
    FEAR_GREED_INDEX_ANALYSIS: "Fear & Greed Index Chart",
    GET_ADDRESS_AND_TRANSACTION_DATA: "On-Chain Data Chart",
    INFLOW_OUTFLOW_ANALYSIS: "Inflow/Outflow Chart",
};

const CHART_COLORS = {
    cyan: { border: "#14b8a6", fill: "rgba(20, 184, 166, 0.18)" },
    blue: { border: "#3b82f6", fill: "rgba(59, 130, 246, 0.18)" },
    emerald: { border: "#10b981", fill: "rgba(16, 185, 129, 0.18)" },
    amber: { border: "#f59e0b", fill: "rgba(245, 158, 11, 0.18)" },
    rose: { border: "#f43f5e", fill: "rgba(244, 63, 94, 0.18)" },
    violet: { border: "#8b5cf6", fill: "rgba(139, 92, 246, 0.18)" },
} as const;

function asRecord(value: unknown): Record<string, any> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }

    return value as Record<string, any>;
}

function getActionData(content: Record<string, any>): Record<string, any> | null {
    return (
        asRecord(content.metadata?.actionData) ||
        asRecord(content.actionData) ||
        asRecord(content.content?.actionData) ||
        null
    );
}

function getChartPath(
    content: Record<string, any>,
    actionData: Record<string, any> | null
): string | undefined {
    return (
        content.metadata?.chartPath ||
        content.actionData?.metadata?.chartPath ||
        content.actionData?.chartPath ||
        content.content?.chartPath ||
        actionData?.chartPath
    );
}

function getVisualizationChartData(
    content: Record<string, any>,
    actionData: Record<string, any> | null
): Record<string, any> | null {
    return (
        asRecord(content.content?.visualizations?.chart_data) ||
        asRecord(content.visualizations?.chart_data) ||
        asRecord(actionData?.content?.visualizations?.chart_data) ||
        asRecord(content.actionResultData?.result?.content?.visualizations?.chart_data) ||
        null
    );
}

function toNumericSeries(values: unknown): Array<number | null> {
    if (!Array.isArray(values)) {
        return [];
    }

    return values.map((value) => {
        const num = typeof value === "number" ? value : Number(value);
        return Number.isFinite(num) ? num : null;
    });
}

function toStringSeries(values: unknown): string[] {
    if (!Array.isArray(values)) {
        return [];
    }

    return values.map((value) => String(value));
}

function trimChartSpecByIndices(
    chartSpec: ReportChartSpec,
    indices: number[]
): ReportChartSpec {
    return {
        ...chartSpec,
        labels: indices.map((index) => chartSpec.labels[index]),
        datasets: chartSpec.datasets.map((dataset) => ({
            ...dataset,
            data: indices.map((index) => dataset.data[index] ?? null),
        })),
    };
}

function trimChartSpecToLastEntries(
    chartSpec: ReportChartSpec,
    maxEntries: number
): ReportChartSpec {
    if (chartSpec.labels.length <= maxEntries) {
        return chartSpec;
    }

    const startIndex = chartSpec.labels.length - maxEntries;
    const indices = Array.from(
        { length: chartSpec.labels.length - startIndex },
        (_, offset) => startIndex + offset
    );

    return trimChartSpecByIndices(chartSpec, indices);
}

function trimChartSpecToLastUniqueLabels(
    chartSpec: ReportChartSpec,
    maxLabels: number
): ReportChartSpec {
    if (chartSpec.labels.length <= maxLabels) {
        return chartSpec;
    }

    const uniqueLabels: string[] = [];
    for (let index = chartSpec.labels.length - 1; index >= 0; index--) {
        const label = chartSpec.labels[index];
        if (!uniqueLabels.includes(label)) {
            uniqueLabels.unshift(label);
            if (uniqueLabels.length === maxLabels) {
                break;
            }
        }
    }

    const keep = new Set(uniqueLabels);
    const indices = chartSpec.labels
        .map((label, index) => (keep.has(label) ? index : -1))
        .filter((index) => index !== -1);

    return trimChartSpecByIndices(chartSpec, indices);
}

function buildPriceChartSpec(actionData: Record<string, any> | null): ReportChartSpec | undefined {
    const chartData = asRecord(actionData?.chartData);
    if (!chartData) {
        return undefined;
    }

    const labels = toStringSeries(chartData.labels);
    const prices = toNumericSeries(chartData.priceData);
    const volumes = toNumericSeries(chartData.volumeData);
    if (labels.length === 0 || prices.length === 0) {
        return undefined;
    }

    return {
        labels,
        datasets: [
            {
                label: `${actionData?.cryptoSymbol || "Asset"} Price`,
                data: prices,
                borderColor: CHART_COLORS.cyan.border,
                backgroundColor: CHART_COLORS.cyan.fill,
                yAxisID: "y",
                fill: true,
                tension: 0.2,
            },
            {
                label: "Volume (Millions)",
                data: volumes,
                borderColor: CHART_COLORS.violet.border,
                backgroundColor: CHART_COLORS.violet.fill,
                type: "bar",
                yAxisID: "y1",
            },
        ],
        axes: {
            y: { title: "Price", position: "left", format: "currency" },
            y1: { title: "Volume", position: "right", format: "millions" },
        },
    };
}

function normalizeDay(value: unknown): string {
    if (typeof value === "number" && Number.isFinite(value)) {
        const timestampMs = value > 1e12 ? value : value * 1000;
        return new Date(timestampMs).toISOString().slice(0, 10);
    }

    const raw = String(value).trim();
    const numeric = Number(raw);
    if (raw && Number.isFinite(numeric)) {
        const timestampMs = numeric > 1e12 ? numeric : numeric * 1000;
        return new Date(timestampMs).toISOString().slice(0, 10);
    }

    return raw.slice(0, 10);
}

// Daily total-weighted aggregation matches the in-chat chart in plugin-sentiscore
// (combine.ts generateChartHTML). Hourly simple-mean buckets exposed raw hourly
// values where 1–2 sample hours produced ±1.0 extremes — the report chart looked
// volatile while the chat chart looked smooth, despite the same underlying data.
function aggregateSentimentSeries(
    values: unknown,
    label: string,
    colors: { border: string; fill: string }
): { labels: string[]; dataset?: ReportChartDatasetSpec } {
    if (!Array.isArray(values) || values.length === 0) {
        return { labels: [] };
    }

    const byDay = new Map<string, { weightedSum: number; weightTotal: number }>();
    for (const item of values) {
        const record = asRecord(item);
        if (!record) {
            continue;
        }

        const dayLabel = normalizeDay(record.time);
        const score = Number(record.value);
        if (!dayLabel || !Number.isFinite(score)) {
            continue;
        }

        const totalRaw = Number(record.total);
        const weight = Number.isFinite(totalRaw) && totalRaw > 0 ? totalRaw : 1;

        const current = byDay.get(dayLabel) || { weightedSum: 0, weightTotal: 0 };
        current.weightedSum += score * weight;
        current.weightTotal += weight;
        byDay.set(dayLabel, current);
    }

    const labels = Array.from(byDay.keys()).sort();
    if (labels.length === 0) {
        return { labels: [] };
    }

    return {
        labels,
        dataset: {
            label,
            data: labels.map((dayLabel) => {
                const entry = byDay.get(dayLabel);
                return entry && entry.weightTotal > 0
                    ? Number((entry.weightedSum / entry.weightTotal).toFixed(3))
                    : null;
            }),
            borderColor: colors.border,
            backgroundColor: colors.fill,
            fill: true,
            tension: 0.25,
        },
    };
}

function buildSentimentChartSpec(actionData: Record<string, any> | null): ReportChartSpec | undefined {
    const sentimentData = asRecord(actionData?.sentimentData);
    if (!sentimentData) {
        return undefined;
    }

    const xSeries = aggregateSentimentSeries(
        sentimentData.xScores,
        "X Sentiment",
        CHART_COLORS.blue
    );
    const newsSeries = aggregateSentimentSeries(
        sentimentData.newsScores,
        "News Sentiment",
        CHART_COLORS.emerald
    );

    const labels = Array.from(new Set([...xSeries.labels, ...newsSeries.labels])).sort();
    if (labels.length === 0) {
        return undefined;
    }

    const datasets: ReportChartDatasetSpec[] = [];
    if (xSeries.dataset) {
        const byLabel = new Map(xSeries.labels.map((label, index) => [label, xSeries.dataset!.data[index]]));
        datasets.push({
            ...xSeries.dataset,
            data: labels.map((label) => byLabel.get(label) ?? null),
        });
    }
    if (newsSeries.dataset) {
        const byLabel = new Map(newsSeries.labels.map((label, index) => [label, newsSeries.dataset!.data[index]]));
        datasets.push({
            ...newsSeries.dataset,
            data: labels.map((label) => byLabel.get(label) ?? null),
        });
    }

    if (datasets.length === 0) {
        return undefined;
    }

    return trimChartSpecToLastEntries({
        labels,
        datasets,
        axes: {
            y: { title: "Sentiment Score", position: "left", format: "number" },
        },
    }, 7);
}

function buildFearGreedChartSpec(actionData: Record<string, any> | null): ReportChartSpec | undefined {
    const chartData = asRecord(actionData?.chartData);
    if (!chartData) {
        return undefined;
    }

    const labels = toStringSeries(chartData.labels);
    const values = toNumericSeries(chartData.valueData);
    if (labels.length === 0 || values.length === 0) {
        return undefined;
    }

    return {
        labels,
        datasets: [
            {
                label: "Fear & Greed Index",
                data: values,
                borderColor: CHART_COLORS.amber.border,
                backgroundColor: CHART_COLORS.amber.fill,
                fill: true,
                tension: 0.25,
            },
        ],
        axes: {
            y: { title: "Index Value", position: "left", format: "number" },
        },
    };
}

function buildOnChainChartSpec(content: Record<string, any>): ReportChartSpec | undefined {
    const chartData = getVisualizationChartData(content, getActionData(content));
    if (!chartData) {
        return undefined;
    }

    const labels = toStringSeries(chartData.labels);
    const values = toNumericSeries(chartData.values);
    if (labels.length === 0 || values.length === 0) {
        return undefined;
    }

    return {
        labels,
        datasets: [
            {
                label: "Metric Value",
                data: values,
                borderColor: CHART_COLORS.blue.border,
                backgroundColor: CHART_COLORS.blue.fill,
                fill: true,
                tension: 0.2,
            },
        ],
        axes: {
            y: { title: "Value", position: "left", format: "number" },
        },
    };
}

function buildInflowOutflowChartSpec(content: Record<string, any>): ReportChartSpec | undefined {
    const chartData = getVisualizationChartData(content, getActionData(content));
    if (!chartData) {
        return undefined;
    }

    const labels = toStringSeries(chartData.labels);
    if (labels.length === 0) {
        return undefined;
    }

    const inflow = toNumericSeries(chartData.inflowData);
    const outflow = toNumericSeries(chartData.outflowData);
    const liquidity = toNumericSeries(chartData.liquidityData);
    if (inflow.length === 0 && outflow.length === 0 && liquidity.length === 0) {
        return undefined;
    }

    return trimChartSpecToLastUniqueLabels({
        labels,
        datasets: [
            {
                label: "Inflow (Millions)",
                data: inflow,
                borderColor: CHART_COLORS.emerald.border,
                backgroundColor: CHART_COLORS.emerald.fill,
                fill: true,
                tension: 0.2,
                yAxisID: "y",
            },
            {
                label: "Outflow (Millions)",
                data: outflow,
                borderColor: CHART_COLORS.rose.border,
                backgroundColor: CHART_COLORS.rose.fill,
                fill: true,
                tension: 0.2,
                yAxisID: "y",
            },
            {
                label: "Liquidity (Millions)",
                data: liquidity,
                borderColor: CHART_COLORS.violet.border,
                backgroundColor: CHART_COLORS.violet.fill,
                tension: 0.2,
                yAxisID: "y1",
            },
        ],
        axes: {
            y: { title: "Flow", position: "left", format: "millions" },
            y1: { title: "Liquidity", position: "right", format: "millions" },
        },
    }, 7);
}

function buildChartSpec(
    actionName: string,
    content: Record<string, any>,
    actionData: Record<string, any> | null
): ReportChartSpec | undefined {
    switch (actionName) {
        case "plot_price_charts":
            return buildPriceChartSpec(actionData);
        case "Sentiment_Analysis":
            return buildSentimentChartSpec(actionData);
        case "FEAR_GREED_INDEX_ANALYSIS":
            return buildFearGreedChartSpec(actionData);
        case "GET_ADDRESS_AND_TRANSACTION_DATA":
            return buildOnChainChartSpec(content);
        case "INFLOW_OUTFLOW_ANALYSIS":
            return buildInflowOutflowChartSpec(content);
        default:
            return undefined;
    }
}

export function extractReportMetadata(
    actionResults: Memory[],
    target: string,
    date: string
): ReportMetadata {
    const charts: ReportChartEntry[] = [];
    const searchResults: ReportSearchResult[] = [];

    for (const mem of actionResults) {
        const content = asRecord(mem.content);
        if (!content) continue;

        const actionName: string =
            content.metadata?.actionName || content.action || "";

        const actionData = getActionData(content);

        // ── Extract chart paths ──
        const chartPath = getChartPath(content, actionData);
        const chartSpec = buildChartSpec(actionName, content, actionData);

        if ((chartPath || chartSpec) && ACTION_SECTION_MAP[actionName]) {
            charts.push({
                actionName,
                chartFilename: chartPath ? path.basename(chartPath) : `${actionName}.chart`,
                title: ACTION_TITLE_MAP[actionName] || actionName,
                section: ACTION_SECTION_MAP[actionName],
                ...(chartSpec ? { chartSpec } : {}),
            });
        }

        // ── Extract search results ──
        if (actionName === "web_search" || actionName === "WEB_SEARCH") {
            const ad = content.metadata?.actionData || content.actionData?.metadata?.actionData;
            const results: any[] = ad?.results;
            if (Array.isArray(results) && results.length > 0) {
                searchResults.push({
                    actionName: "web_search",
                    query: ad?.query || ad?.searchQuery || "",
                    links: results
                        .filter((r: any) => r?.url)
                        .map((r: any) => ({
                            title: r.title || "Untitled",
                            url: r.url,
                            ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
                        })),
                });
            }
        }

        if (actionName === "CRYPTO_RESEARCH_SEARCH") {
            const ad = content.metadata?.actionData || content.actionData?.metadata?.actionData;
            const sources: any[] = ad?.sources;
            if (Array.isArray(sources) && sources.length > 0) {
                searchResults.push({
                    actionName: "CRYPTO_RESEARCH_SEARCH",
                    query: ad?.searchQuery || "",
                    links: sources
                        .filter((s: any) => s?.url)
                        .map((s: any) => ({
                            title: s.title || "Untitled",
                            url: s.url,
                            ...(s.date ? { publishedDate: s.date } : {}),
                            ...(s.publishedDate ? { publishedDate: s.publishedDate } : {}),
                        })),
                });
            }
        }
    }

    return {
        date,
        target,
        generatedAt: Date.now(),
        charts,
        searchResults,
    };
}
