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
    createActionErrorResponse,
} from "@elizaos/core";
import { validateLaunchpadConfig } from "../environment";
import type { LaunchpadPhase, LaunchpadQuery, LaunchpadTokenWithPhase } from "../types";
import { fetchLaunchpadData } from "../utils/api";
import { buildLaunchpadQuery } from "../utils/queryBuilder";
import { filterLaunchpadTokens } from "../utils/tokenFilters";
import {
    describeBondingProgress,
    formatNumber,
    formatSol,
    formatUsd,
    formatUnixSeconds,
    getPhaseLabel,
} from "../utils/format";

const PHASE_PRIORITY: Record<LaunchpadPhase, number> = {
    new: 0,
    bonding: 1,
    graduated: 2,
};

function describeToken(token: LaunchpadTokenWithPhase): string {
    const displayName = token.symbol
        ? token.name && token.name.toLowerCase() !== token.symbol.toLowerCase()
            ? `${token.symbol} · ${token.name}`
            : token.symbol
        : token.name ?? token.tokenAddress ?? "Unknown";

    const lines: string[] = [];

    lines.push(`• Price: ${formatUsd(token.priceUsd)} (${formatSol(token.priceNative)})`);
    lines.push(`• FDV: ${formatUsd(token.mktCapUsd)} · Supply: ${formatNumber(token.totalSupply)} · Holders: ${formatNumber(token.totalHolders)}`);
    lines.push(`• 1h Volume: ${formatUsd(token.volume1h)} · Trades: ${formatNumber(token.tx1h)}`);

    if (token.phase === "new") {
        lines.push(`• Created: ${formatUnixSeconds(token.createdAt)}`);
    } else if (token.phase === "graduated") {
        lines.push(`• Graduated: ${formatUnixSeconds(token.graduationAt)}`);
    } else {
        const bondingSummary = describeBondingProgress(token);
        if (bondingSummary) {
            lines.push(`• ${bondingSummary}`);
        }
    }

    return `**${displayName}**\n${lines.join("\n")}`;
}

function formatResponse(tokens: LaunchpadTokenWithPhase[], query: LaunchpadQuery): string {
    if (tokens.length === 0) {
        return "No matching Launchpad tokens were found for the requested filters. Try specifying a different phase or token name.";
    }

    const limit = query.limit && query.limit > 0 ? query.limit : 5;
    const sorted = [...tokens]
        .sort((a, b) => {
            const phaseDiff = PHASE_PRIORITY[a.phase] - PHASE_PRIORITY[b.phase];
            if (phaseDiff !== 0) {
                return phaseDiff;
            }
            const aMkt = typeof a.mktCapUsd === "number" ? a.mktCapUsd : 0;
            const bMkt = typeof b.mktCapUsd === "number" ? b.mktCapUsd : 0;
            return bMkt - aMkt;
        })
        .slice(0, limit);

    const grouped = sorted.reduce<Map<LaunchpadPhase, LaunchpadTokenWithPhase[]>>((map, token) => {
        const list = map.get(token.phase) ?? [];
        list.push(token);
        map.set(token.phase, list);
        return map;
    }, new Map());

    const sections = Array.from(grouped.entries())
        .sort((a, b) => PHASE_PRIORITY[a[0]] - PHASE_PRIORITY[b[0]])
        .map(([phase, bucket]) => `**${getPhaseLabel(phase)}**\n${bucket.map(describeToken).join("\n\n")}`);

    const heading = query.phase && query.phase !== "all"
        ? `${getPhaseLabel(query.phase)} tokens`
        : "Token overview";

    return `🚀 ${heading}\n\n${sections.join("\n\n")}`;
}

export const launchpadGeneralDataAction: Action = {
    name: "TOKEN_METADATA_OVERVIEW",
    description: "Returns Solana early-stage token metadata (price, FDV, supply, holders, 1h volume, created/graduated timestamps) for the requested phase, symbol, or address.",
    examples: [
        [
            {
                user: "{{user}}",
                content: {
                    text: "Show me the latest new tokens with their price and FDV",
                },
            },
            {
                user: "{{assistant}}",
                content: {
                    text: "I'll pull general data for the NEW phase, including price, FDV, supply, and key timestamps.",
                },
            },
        ],
        [
            {
                user: "{{user}}",
                content: {
                    text: "Give me bonding curve tokens about grokipedia",
                },
            },
            {
                user: "{{assistant}}",
                content: {
                    text: "Let me locate the bonding-phase entry for Grokipedia and summarize its FDV, holders, and bonding progress.",
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
            const query = buildLaunchpadQuery(message, state, options);

            // Handle from/to date range parameters for filtering by creation date
            let dateRangeFilter: { from: Date; to: Date } | undefined;
            if (options?.from && options?.to) {
                const fromStr = String(options.from).trim().slice(0, 10);
                const toStr = String(options.to).trim().slice(0, 10);
                const fromDate = new Date(fromStr + 'T00:00:00.000Z');
                const toDate = new Date(toStr + 'T23:59:59.999Z');
                
                if (!isNaN(fromDate.getTime()) && !isNaN(toDate.getTime()) && fromDate <= toDate) {
                    dateRangeFilter = { from: fromDate, to: toDate };
                    elizaLogger.log(`📅 Launchpad data filtered by creation date: ${fromStr} to ${toStr}`);
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
            let responseText = formatResponse(tokensForResponse, formattingQuery);
            if (!hasMatches) {
                responseText = `No tokens matched the requested filters; showing a broader snapshot instead.\\n\\n${responseText}`;
            }

            if (callback) {
                const matches = filtered.slice(0, query.limit ?? 5);
                const actionData = {
                    type: "launchpad_general_data",
                    phase: query.phase ?? "all",
                    appliedFilters: {
                        address: query.tokenAddress,
                        symbol: query.symbol,
                        keywords: query.keywords ?? [],
                        limit: query.limit ?? 5,
                    },
                    matches: matches,
                };

                // Generate action summary
                const tokenSymbols = matches.map(m => m.symbol || 'Unknown').slice(0, 3);
                const phase = query.phase ?? "all phases";
                const actionSummary = generateActionSummary({
                    actionName: 'Token Launchpad Data',
                    assets: tokenSymbols.length > 0 ? tokenSymbols : ['Solana Tokens'],
                    timePeriod: 'real-time',
                    dataPoints: matches.length,
                    additionalInfo: `${phase}, metadata overview`
                });

                await callback(createActionResponse({
                    actionName: "TOKEN_METADATA_OVERVIEW",
                    type: "launchpad_general_data",
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
            const messageText = error instanceof Error ? error.message : "Unknown metadata error";
            elizaLogger.error("Token metadata action error", error);
            if (callback) {
                await callback(createActionErrorResponse({
                    actionName: "TOKEN_METADATA_OVERVIEW",
                    type: "launchpad_general_data_error",
                    error: error instanceof Error ? error : new Error(messageText),
                    text: `Failed to load token metadata: ${messageText}`,
                }));
            }
            return false;
        }
    },
    cacheConfig: {
        enabled: true,
        ttlSeconds: 300, // 5 minutes for new token data
        similarityThreshold: 0.7,
        maxChunkSize: 200,
    },
};
