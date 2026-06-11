import fs from "fs";
import path from "path";
import type {
    Action,
    IAgentRuntime,
    Memory,
    State,
    HandlerCallback,
    ActionExample,
} from "@elizaos/core";
import {
    generateText,
    ModelClass,
    createActionResponse,
    createActionErrorResponse,
    generateActionSummary,
    buildChartProxyUrl,
} from "@elizaos/core";
import { identifyAsset } from "../utils/cryptocurrencies.ts";
import {
    getDateRangeFromRequest,
    SENTIMENT_ANALYSIS_SYSTEM,
    computeSourceMetrics,
    getCryptoData,
    generateSentimentPNG,
    generateChartHTML,
    saveChartToFile,
} from "./combine.ts";

export interface SentiScore {
    time: number;
    value: number;
    total?: number;
}

export type FetchFn = (
    req: Request,
    ctx: { params: { symbol: string } }
) => Promise<Response>;

export function makeSourceAction(config: {
    name: string;
    description: string;
    sourceLabel: string;
    sourceType: string;
    /** CSS rgb() color for chart line, e.g. "rgb(59, 130, 246)" */
    color: string;
    fetchFn: FetchFn;
    examples: ActionExample[][];
}): Action {
    return {
        name: config.name,
        description: config.description,
        handler: async (
            runtime: IAgentRuntime,
            message: Memory,
            _state: State,
            options: any,
            callback: HandlerCallback
        ): Promise<boolean> => {
            const signal = options?.signal as AbortSignal | undefined;
            const text = message.content.text ?? "";
            const symbol = identifyAsset(text);
            const dateRange = getDateRangeFromRequest(text);

            try {
                const resp = await config.fetchFn(
                    new Request(`http://localhost/api/sentiscore/${config.sourceType}/${symbol}`),
                    { params: { symbol } }
                );
                const data = await resp.json();

                if (data.error) {
                    await callback(createActionErrorResponse({
                        actionName: config.name,
                        type: `${config.sourceType}_sentiment_error`,
                        error: new Error(data.error),
                        text: `No ${config.sourceLabel} sentiment data found for ${symbol}.`,
                    }));
                    return true;
                }

                const allScores: SentiScore[] = data.sentiScores ?? [];
                const startTs = new Date(dateRange.startDate).getTime() / 1000;
                const endTs = new Date(dateRange.endDate).getTime() / 1000 + 86400;
                const scores = allScores
                    .filter(s => s.time >= startTs && s.time <= endTs)
                    .sort((a, b) => a.time - b.time);

                if (scores.length === 0) {
                    await callback(createActionErrorResponse({
                        actionName: config.name,
                        type: `${config.sourceType}_sentiment_error`,
                        error: new Error("No data in date range"),
                        text: `No ${config.sourceLabel} sentiment data found for ${symbol} between ${dateRange.startDate} and ${dateRange.endDate}.`,
                    }));
                    return true;
                }

                const metrics = computeSourceMetrics(scores as any)!;
                const values = scores.map(s => s.value);
                const sortedVals = [...values].sort((a, b) => a - b);
                const median = sortedVals.length % 2 === 0
                    ? (sortedVals[sortedVals.length / 2 - 1] + sortedVals[sortedVals.length / 2]) / 2
                    : sortedVals[Math.floor(sortedVals.length / 2)];

                // Recent vs historical momentum
                let recentTrend = "insufficient data";
                let momentumScore = 0;
                if (scores.length >= 10) {
                    const recentPortion = Math.floor(scores.length * 0.3);
                    const recentAvg = values.slice(-recentPortion).reduce((a, b) => a + b, 0) / recentPortion;
                    const histAvg = values.slice(0, -recentPortion).reduce((a, b) => a + b, 0) / (scores.length - recentPortion);
                    momentumScore = ((recentAvg - histAvg) / (Math.abs(histAvg) || 1)) * 100;
                    recentTrend = momentumScore > 5 ? "accelerating positive" :
                        momentumScore > 1 ? "trending positive" :
                        momentumScore < -5 ? "accelerating negative" :
                        momentumScore < -1 ? "trending negative" : "stable";
                }

                const volatilityLevel = metrics.volatility > 0.15 ? "High" :
                    metrics.volatility > 0.08 ? "Moderate" :
                    metrics.volatility > 0.03 ? "Low" : "Minimal";

                const positiveCount = scores.filter(s => s.value > 0.1).length;
                const negativeCount = scores.filter(s => s.value < -0.1).length;
                const neutralCount = scores.length - positiveCount - negativeCount;

                const prompt = `Analyzing ${config.sourceLabel} sentiment data for ${symbol} from ${dateRange.startDate} to ${dateRange.endDate} (${metrics.total} data points).

📊 **SENTIMENT DATA METRICS:**
- Total data points: ${metrics.total}
- Average sentiment score: ${metrics.avg.toFixed(4)}
- Median: ${median.toFixed(4)}
- Distribution: ${((positiveCount / metrics.total) * 100).toFixed(1)}% positive, ${((neutralCount / metrics.total) * 100).toFixed(1)}% neutral, ${((negativeCount / metrics.total) * 100).toFixed(1)}% negative
- Average positive sentiment: ${metrics.positive.toFixed(4)}
- Average negative sentiment: ${metrics.negative.toFixed(4)}
- Sentiment trend: ${metrics.trend} (change: ${metrics.change > 0 ? "+" : ""}${metrics.change.toFixed(4)})
- Volatility level: ${volatilityLevel} (${metrics.volatility.toFixed(4)})
- Recent momentum: ${recentTrend} (${momentumScore.toFixed(2)}%)`;

                if (runtime.shouldStop?.()) {
                    return false;
                }

                // --- PNG chart (for LLM vision) ---
                let pngBuf: Buffer | null = null;
                try {
                    pngBuf = await generateSentimentPNG(scores, `${symbol} — ${config.sourceLabel}`, config.color);
                    const pngDir = path.join(process.cwd(), "saved_data", "Charts");
                    if (!fs.existsSync(pngDir)) fs.mkdirSync(pngDir, { recursive: true });
                    const pngName = `Sentiment Chart ${symbol} ${config.sourceLabel.replace(/[^a-zA-Z0-9 ]/g, "")} ${dateRange.startDate}_${dateRange.endDate}.png`;
                    await fs.promises.writeFile(path.join(pngDir, pngName), pngBuf);
                } catch (err) {
                    console.warn(`[${config.name}] PNG generation failed (non-fatal):`, err);
                }

                const imageAttachments = pngBuf
                    ? [{ type: "image" as const, data: pngBuf.toString("base64"), mimeType: "image/png" as const }]
                    : undefined;

                // --- HTML chart (price + sentiment overlay) ---
                let chartPath = "";
                try {
                    const cryptoData = await getCryptoData(symbol, dateRange.startDate, dateRange.endDate);
                    if (cryptoData.length > 0) {
                        const html = generateChartHTML(cryptoData, scores, symbol);
                        const savedPath = await saveChartToFile(html, symbol, dateRange.startDate, dateRange.endDate);
                        chartPath = buildChartProxyUrl(savedPath, runtime.agentId);
                    }
                } catch (err) {
                    console.warn(`[${config.name}] HTML chart generation failed (non-fatal):`, err);
                }

                if (runtime.shouldStop?.()) {
                    return false;
                }

                // --- LLM analysis ---
                const analysis = await generateText({
                    runtime,
                    system: SENTIMENT_ANALYSIS_SYSTEM,
                    prompt,
                    modelClass: ModelClass.MEDIUM,
                    signal,
                    imageAttachments,
                });

                const actionSummary = generateActionSummary({
                    actionName: config.name,
                    assets: [symbol],
                    timePeriod: `${dateRange.startDate} to ${dateRange.endDate}`,
                    dataPoints: metrics.total,
                    additionalInfo: `${config.sourceLabel}, avg sentiment ${metrics.avg.toFixed(3)}, ${metrics.trend}`,
                });

                const vizMsg = chartPath
                    ? `\n\nI've also created an interactive chart combining ${symbol} price data with ${config.sourceLabel} SentiScore. Click the chart button below to view the visualization.`
                    : "";

                await callback(createActionResponse({
                    actionName: config.name,
                    type: `${config.sourceType}_sentiment`,
                    text: `## ${config.sourceLabel} Sentiment Analysis: ${symbol}\n\n${analysis}${vizMsg}`,
                    actionData: {
                        asset: symbol,
                        source: config.sourceType,
                        dateRange,
                        metrics,
                        summary: actionSummary,
                    },
                    chartPath,
                }));

                return true;
            } catch (error) {
                await callback(createActionErrorResponse({
                    actionName: config.name,
                    type: `${config.sourceType}_sentiment_error`,
                    error: error instanceof Error ? error : new Error(String(error)),
                    text: `Error fetching ${config.sourceLabel} sentiment for ${symbol}.`,
                }));
                return false;
            }
        },
        examples: config.examples,
    };
}
