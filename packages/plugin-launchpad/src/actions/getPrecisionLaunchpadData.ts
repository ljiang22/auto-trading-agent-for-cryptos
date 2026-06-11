import {
    type Action,
    type ActionExample,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
    elizaLogger,
    createActionResponse,
    generateActionSummary,
    formatTimePeriodFromHours,
    createActionErrorResponse,
} from "@elizaos/core";
import { validateLaunchpadConfig } from "../environment";
import type { LaunchpadMetricsQuery, LaunchpadPhase, LaunchpadTokenWithPhase } from "../types";
import { fetchLaunchpadData } from "../utils/api";
import { buildLaunchpadMetricsQuery } from "../utils/queryBuilder";
import { filterLaunchpadTokens } from "../utils/tokenFilters";
import {
    formatNumber,
    formatSol,
    formatUsd,
    getPhaseLabel,
} from "../utils/format";

const METRIC_LABELS: Record<string, string> = {
    buy1h: "Buy Count (1h)",
    sell1h: "Sell Count (1h)",
    volume1h: "Volume (1h)",
    tx1h: "Trades (1h)",
};

const PHASE_PRIORITY: Record<LaunchpadPhase, number> = {
    new: 0,
    bonding: 1,
    graduated: 2,
};

function formatMetricValue(metric: string, token: LaunchpadTokenWithPhase): string {
    const label = METRIC_LABELS[metric] ?? metric;
    const value = token[metric as keyof LaunchpadTokenWithPhase];
    if (metric === "volume1h") {
        return `• ${label}: ${formatUsd(typeof value === "number" ? value : undefined)}`;
    }
    return `• ${label}: ${formatNumber(typeof value === "number" ? value : undefined)}`;
}

function describeNetFlow(token: LaunchpadTokenWithPhase): string | undefined {
    const buy = typeof token.buy1h === "number" ? token.buy1h : undefined;
    const sell = typeof token.sell1h === "number" ? token.sell1h : undefined;
    if (buy === undefined || sell === undefined) {
        return undefined;
    }
    const net = buy - sell;
    if (net === 0) {
        return "• Order flow is balanced over the past hour";
    }
    const direction = net > 0 ? "net buy" : "net sell";
    return `• ${direction}: ${formatNumber(Math.abs(net))} orders (buy ${formatNumber(buy)} | sell ${formatNumber(sell)})`;
}

function describeTokenPrecision(token: LaunchpadTokenWithPhase, metrics: string[]): string {
    const name = token.symbol
        ? token.name && token.name.toLowerCase() !== token.symbol.toLowerCase()
            ? `${token.symbol} · ${token.name}`
            : token.symbol
        : token.name ?? token.tokenAddress ?? "Unknown";

    const lines = metrics.map((metric) => formatMetricValue(metric, token));
    const netFlowLine = describeNetFlow(token);
    if (netFlowLine) {
        lines.push(netFlowLine);
    }
    lines.push(`• Price: ${formatUsd(token.priceUsd)} (${formatSol(token.priceNative)})`);
    lines.push(`• Holders: ${formatNumber(token.totalHolders)} | Trades logged: ${formatNumber(token.tx1h)}`);

    return `**${name} (${getPhaseLabel(token.phase)})**\n${lines.join("\n")}`;
}

function formatPrecisionResponse(
    tokens: LaunchpadTokenWithPhase[],
    query: LaunchpadMetricsQuery,
): string {
    if (tokens.length === 0) {
        return "No tokens were found for that combination of filters and metrics.";
    }

    const limit = query.limit && query.limit > 0 ? query.limit : 5;
    const selected = [...tokens]
        .sort((a, b) => {
            const aVolume = typeof a.volume1h === "number" ? a.volume1h : 0;
            const bVolume = typeof b.volume1h === "number" ? b.volume1h : 0;
            if (bVolume !== aVolume) {
                return bVolume - aVolume;
            }
            const phaseDiff = PHASE_PRIORITY[a.phase] - PHASE_PRIORITY[b.phase];
            if (phaseDiff !== 0) {
                return phaseDiff;
            }
            const aNet = (typeof a.buy1h === "number" ? a.buy1h : 0) - (typeof a.sell1h === "number" ? a.sell1h : 0);
            const bNet = (typeof b.buy1h === "number" ? b.buy1h : 0) - (typeof b.sell1h === "number" ? b.sell1h : 0);
            return bNet - aNet;
        })
        .slice(0, limit);

    const sections = selected.map((token) => describeTokenPrecision(token, query.metrics ?? ["buy1h", "sell1h", "volume1h", "tx1h"]));

    const requestedRange = query.timeRangeLabel ?? "1h";
    const rangeNote = /1h|hour|hr/i.test(requestedRange)
        ? `Time range: ${requestedRange} (data granularity is 1h)`
        : `Requested time range "${requestedRange}" mapped to available 1h metrics (buy1h, sell1h, volume1h, tx1h).`;

    return `📊 Hourly precision metrics\n${rangeNote}\n\n${sections.join("\n\n")}`;
}

export const launchpadPrecisionDataAction: Action = {
    name: "TOKEN_HOURLY_METRICS",
    description: "Returns Solana early-stage hourly trade metrics (buy1h, sell1h, volume1h, tx1h) and net order flow for the specified token or phase.",
    examples: [
        [
            {
                user: "{{user}}",
                content: {
                    text: "For the last hour, show me buy and sell pressure for the newest bonding tokens",
                },
            },
            {
                user: "{{assistant}}",
                content: {
                    text: "I'll inspect the bonding-phase feed and report buy1h vs sell1h plus net flow for the requested tokens.",
                },
            },
        ],
        [
            {
                user: "{{user}}",
                content: {
                    text: "Need precise data (volume, buy1h, sell1h) for Grokipedia",
                },
            },
            {
                user: "{{assistant}}",
                content: {
                    text: "Let me pull the hourly metrics for Grokipedia and summarize the trade counts and volume.",
                },
            },
        ],
    ] as ActionExample[][],
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: Record<string, unknown> = {},
        callback?: HandlerCallback,
    ): Promise<boolean> => {
        try {
            const config = await validateLaunchpadConfig(runtime);
            const query = buildLaunchpadMetricsQuery(message, state, options) as LaunchpadMetricsQuery;

            // Handle from/to date range parameters for filtering by creation date
            let dateRangeFilter: { from: Date; to: Date } | undefined;
            if (options?.from && options?.to) {
                const fromStr = String(options.from).trim().slice(0, 10);
                const toStr = String(options.to).trim().slice(0, 10);
                const fromDate = new Date(fromStr + 'T00:00:00.000Z');
                const toDate = new Date(toStr + 'T23:59:59.999Z');
                
                if (!isNaN(fromDate.getTime()) && !isNaN(toDate.getTime()) && fromDate <= toDate) {
                    dateRangeFilter = { from: fromDate, to: toDate };
                    elizaLogger.log(`📅 Precision launchpad data filtered by creation date: ${fromStr} to ${toStr}`);
                }
            }

            const phases = query.phase === "all" || !query.phase
                ? "all"
                : [query.phase];

            let tokens = await fetchLaunchpadData(runtime, config, phases);
            
            // Apply date range filter if specified
            if (dateRangeFilter) {
                tokens = tokens.filter(token => {
                    if (token.createdAt) {
                        const createdDate = new Date(token.createdAt * 1000); // Convert Unix timestamp to Date
                        return createdDate >= dateRangeFilter!.from && createdDate <= dateRangeFilter!.to;
                    }
                    return true; // Keep tokens without createdAt
                });
            }
            
            const filtered = filterLaunchpadTokens(tokens, query);

            const hasMatches = filtered.length > 0;
            const tokensForResponse = hasMatches ? filtered : tokens;
            const formattingQuery = hasMatches ? query : { ...query, keywords: [], symbol: undefined, tokenAddress: undefined };

            let responseText = formatPrecisionResponse(tokensForResponse, formattingQuery);
            if (!hasMatches) {
                responseText = `No tokens matched the requested filters; showing the most liquid entries instead:\n\n${responseText}`;
            }

            if (callback) {
                const matches = filtered.slice(0, query.limit ?? 5);
                const actionData = {
                    type: "launchpad_precision_data",
                    phase: query.phase ?? "all",
                    metrics: query.metrics,
                    timeRange: query.timeRangeLabel ?? "1h",
                    matches: matches,
                };

                // Generate action summary
                const tokenSymbols = matches.map(m => m.symbol || 'Unknown').slice(0, 3);
                const timeRange = query.timeRangeLabel ?? "1h";
                const actionSummary = generateActionSummary({
                    actionName: 'Precision Launchpad Metrics',
                    assets: tokenSymbols.length > 0 ? tokenSymbols : ['Solana Tokens'],
                    timePeriod: timeRange,
                    dataPoints: matches.length,
                    additionalInfo: 'hourly trading data'
                });

                await callback(createActionResponse({
                    actionName: "TOKEN_HOURLY_METRICS",
                    type: "launchpad_precision_data",
                    text: responseText,
                    content: actionData,
                    actionData: {
                        ...actionData,
                        summary: actionSummary,
                    },
                }));
            }

            return true;
        } catch (error) {
            const messageText = error instanceof Error ? error.message : "Unknown hourly metrics error";
            elizaLogger.error("Token hourly metrics action error", error);
            if (callback) {
                await callback(createActionErrorResponse({
                    actionName: "TOKEN_HOURLY_METRICS",
                    type: "launchpad_precision_data_error",
                    error: error instanceof Error ? error : new Error(messageText),
                    text: `Failed to load token hourly metrics: ${messageText}`,
                }));
            }
            return false;
        }
    },
    cacheConfig: {
        enabled: true,
        ttlSeconds: 300, // 5 minutes for hourly metrics
        similarityThreshold: 0.7,
        maxChunkSize: 200,
    },
};
