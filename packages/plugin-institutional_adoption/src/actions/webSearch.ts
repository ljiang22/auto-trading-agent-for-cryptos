import {
    type Action,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
    elizaLogger,
    ModelClass,
    generateText,
    trimTokens,
    createActionResponse,
    createActionErrorResponse,
    generateActionSummary,
} from "@elizaos/core";
import { tavily } from "@tavily/core";
import { tavilyKeyManager } from "@elizaos/core";
import type { SearchResult } from "../types";

const DEFAULT_MAX_WEB_SEARCH_TOKENS = 4000;

const INSTITUTIONAL_ANALYSIS_SYSTEM = `Analyze the web search results to provide a comprehensive, detailed report on what specific institutions are doing in cryptocurrency adoption. Focus on factual information from the search results with maximum detail.

**IMPORTANT: Action Summary Generation**
Before providing your analysis, you MUST generate a brief action summary:

[ACTION_SUMMARY]
Institutional Adoption for <TOPIC> (<DATA_POINTS> data points): <KEY_INSIGHT>
[/ACTION_SUMMARY]
    Example:
[ACTION_SUMMARY]
Institutional Adoption for Bitcoin ETFs (5 articles): strong momentum with 3 new approvals totaling $500M in assets.
[/ACTION_SUMMARY]

Format your response as follows:

🏢 Institutional Cryptocurrency Actions:

For each institution mentioned in the search results, provide a detailed entry:
**[Institution Name]** ([Institution Type - e.g., Corporation, Investment Fund, Bank, etc.]):
  - Action: [Detailed description of what they did],
  - Amount/Scale: [Specific numbers, percentages, or scale indicators],
  - Timeline: [When this happened - dates, quarters, etc.],
  - Purpose/Strategy: [Why they took this action, if mentioned],
  - Current Holdings: [Total crypto holdings if mentioned],
  - Market Impact: [Any mentioned effects on price or market],
  - Source: [News publication name and ideally date],
  - Additional Context: [Any other relevant details like regulatory approval, partnership details, etc.],

Example format:
**MicroStrategy** (Business Intelligence Company):
  - Action: Purchased additional 1,000 Bitcoin for corporate treasury strategy
  - Amount/Scale: $50 million investment, bringing total to 150,000 BTC
  - Timeline: December 15, 2024
  - Purpose/Strategy: Hedge against inflation and store of value
  - Current Holdings: 150,000 Bitcoin worth approximately $6.5 billion
  - Market Impact: Bitcoin price rose 2% following announcement
  - Source: CoinDesk, December 15, 2024
  - Additional Context: CEO Michael Saylor stated this aligns with long-term Bitcoin strategy

If specific details are not available in the search results, clearly state "Not specified in sources" for that field. Prioritize accuracy and only include information explicitly stated in the search results.

Detailed institutional actions report:`;

type TavilyClient = ReturnType<typeof tavily>;

interface InstitutionalSearchOptions extends Record<string, unknown> {
    from?: string;
    query?: string;
    signal?: AbortSignal;
    to?: string;
}

function cleanMessageTextForSearch(text: string): string {
    let cleanText = text;
    cleanText = cleanText.replace(/```json[\s\S]*?```/g, "");
    cleanText = cleanText.replace(/\{[\s\S]*?\}/g, "");
    cleanText = cleanText.replace(/```[\s\S]*?```/g, "");
    cleanText = cleanText.replace(/ACTION:\s*\w+/gi, "");
    cleanText = cleanText.replace(/NEXT STEP:\s*.+/gi, "");
    cleanText = cleanText.replace(/\*\*💡.*?\*\*/g, "");
    cleanText = cleanText.replace(/\*Would you like me to proceed.*?\*/g, "");
    cleanText = cleanText.replace(/["'`]/g, "");
    cleanText = cleanText.replace(/[{}[\]]/g, "");
    cleanText = cleanText
        .replace(/\n{3,}/g, "\n\n")
        .replace(/\s{2,}/g, " ")
        .trim();
    return cleanText;
}

async function _tavilySearchWithRotation(query: string, opts: any): Promise<any> {
    const maxAttempts = tavilyKeyManager.keyCount + 1;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const key = tavilyKeyManager.getActiveKey();
        if (!key) throw new Error("[Tavily] All API keys exhausted or rate-limited");
        try {
            return await tavily({ apiKey: key }).search(query, opts);
        } catch (err: any) {
            const status = err?.status ?? err?.response?.status ?? err?.statusCode;
            if (status === 432) { tavilyKeyManager.markExhausted(key); lastError = err; continue; }
            if (status === 429) { tavilyKeyManager.markRateLimited(key); lastError = err; continue; }
            throw err;
        }
    }
    throw lastError ?? new Error("[Tavily] Search failed after key rotation");
}

export const institutionalCryptoSearch: Action = {
    name: "INSTITUTIONAL_CRYPTO_SEARCH",
    suppressInitialMessage: true,
    description:
        "Search for information about institutional adoption of cryptocurrency, including corporate treasuries, ETFs, fund investments, and regulatory developments.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state: State,
        options: InstitutionalSearchOptions,
        callback: HandlerCallback
    ) => {
        const signal = options?.signal as AbortSignal | undefined;
        elizaLogger.log("=== INSTITUTIONAL CRYPTO SEARCH Handler ===");
        elizaLogger.log("Message content:", message.content.text);
        elizaLogger.log("Options:", options);
        elizaLogger.log("==========================================");

        const finalSearchQuery = cleanMessageTextForSearch(options?.query || "").replace(/^\w+:\s*/i, "");
        if (!finalSearchQuery || finalSearchQuery.length < 2) {
            await callback(createActionErrorResponse({
                actionName: "INSTITUTIONAL_CRYPTO_SEARCH",
                type: "institutional_crypto_search_error",
                error: new Error("INSTITUTIONAL_CRYPTO_SEARCH requires a valid query parameter"),
                text: "INSTITUTIONAL_CRYPTO_SEARCH requires a valid query parameter from the workflow.",
            }));
            return;
        }

        elizaLogger.log("Final institutional search query:", finalSearchQuery);

        let searchDays = 30;
        if (options?.from && options?.to && typeof options.from === "string" && typeof options.to === "string") {
            const fromStr = options.from.trim();
            const toStr = options.to.trim();
            const fromDate = new Date(fromStr.length === 10 ? `${fromStr}T00:00:00.000Z` : fromStr);
            const toDate = new Date(toStr.length === 10 ? `${toStr}T23:59:59.999Z` : toStr);
            if (!Number.isNaN(fromDate.getTime()) && !Number.isNaN(toDate.getTime()) && fromDate <= toDate) {
                searchDays = Math.max(1, Math.ceil((toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24)));
            }
        }

        if (tavilyKeyManager.keyCount === 0) {
            elizaLogger.error("No Tavily API keys configured");
            await callback(createActionErrorResponse({
                actionName: "INSTITUTIONAL_CRYPTO_SEARCH",
                type: "institutional_crypto_search_error",
                error: new Error("No Tavily API keys configured"),
                text: "I'm unable to search for institutional crypto adoption information: no Tavily API keys configured.",
            }));
            return;
        }

        let searchResponse: Awaited<ReturnType<TavilyClient["search"]>> | null = null;
        try {
            searchResponse = await _tavilySearchWithRotation(finalSearchQuery.trim(), {
                includeAnswer: true,
                includeRawContent: true,
                maxResults: 5,
                topic: "news",
                searchDepth: "advanced",
                days: searchDays,
            });
        } catch (error) {
            elizaLogger.error("Institutional crypto search API error:", error);

            const errorText = error instanceof Error ? error.message : String(error);
            let errorMessage = "I'm having trouble accessing institutional crypto adoption data right now.";
            if (errorText.includes("401") || errorText.toLowerCase().includes("unauthorized")) {
                errorMessage = "Unable to search for crypto adoption data due to invalid API credentials.";
            } else if (errorText.includes("429") || errorText.toLowerCase().includes("rate limit")) {
                errorMessage = "I've reached the search rate limit. Please try again in a few moments.";
            }

            await callback(createActionErrorResponse({
                actionName: "INSTITUTIONAL_CRYPTO_SEARCH",
                type: "institutional_crypto_search_error",
                error: new Error(errorMessage),
                text: errorMessage,
            }));
            return;
        }

        if (searchResponse?.results?.length > 0) {
            const searchResults = searchResponse.results
                .map((result: SearchResult, index: number) =>
                    `${index + 1}. Title: ${result.title}\n   URL: ${result.url}\n   Content: ${result.content || "No content available"}`
                )
                .join("\n\n");

            const searchAnswer =
                typeof searchResponse.answer === "string" && searchResponse.answer.trim().length > 10
                    ? searchResponse.answer.trim()
                    : "No direct answer provided";

            const institutionalPromptDynamic = `User's Question: ${message.content.text}

Search Summary: ${searchAnswer}

Search Results:
${searchResults}`;

            try {
                const cryptoAnalysis = await generateText({
                    runtime,
                    system: INSTITUTIONAL_ANALYSIS_SYSTEM,
                    prompt: institutionalPromptDynamic,
                    modelClass: ModelClass.MEDIUM,
                    signal,
                });

                let actionSummary = "";
                const summaryMatch = cryptoAnalysis.match(/\[ACTION_SUMMARY\]([\s\S]*?)\[\/ACTION_SUMMARY\]/);
                if (summaryMatch) {
                    actionSummary = summaryMatch[1].trim().replace(/^(Institutional Adoption|Action):\s*/i, "");
                } else {
                    actionSummary = generateActionSummary({
                        actionName: "Institutional Adoption",
                        assets: [finalSearchQuery.split(" ").slice(0, 3).join(" ")],
                        timePeriod: "30 days",
                        dataPoints: searchResponse.results.length,
                        additionalInfo: `${searchResponse.results.length} institutional developments found`,
                    });
                }

                const cleanedAnalysis = cryptoAnalysis
                    .replace(/\[ACTION_SUMMARY\][\s\S]*?\[\/ACTION_SUMMARY\][,\s]*/, "")
                    .trim();

                if (cleanedAnalysis) {
                    const sourcesSection = searchResponse.results.length > 0
                        ? `\n\n**📚 Sources:**\n${searchResponse.results
                            .map((result: SearchResult, index: number) =>
                                `${index + 1}. [${result.title}](${result.url})`
                            )
                            .join("\n")}`
                        : "";

                    await callback(createActionResponse({
                        actionName: "INSTITUTIONAL_CRYPTO_SEARCH",
                        type: "institutional_crypto_search",
                        text: await trimTokens(`${cleanedAnalysis}${sourcesSection}`, DEFAULT_MAX_WEB_SEARCH_TOKENS, runtime),
                        actionData: {
                            summary: actionSummary,
                            searchQuery: finalSearchQuery,
                            articleCount: searchResponse.results.length,
                            sources: searchResponse.results.map(r => ({ title: r.title, url: r.url })),
                        },
                    }));
                } else {
                    const responseList = searchResponse.answer
                        ? `🔍 **Institutional Crypto Adoption Update:**\n\n${searchResponse.answer}${
                              Array.isArray(searchResponse.results) && searchResponse.results.length > 0
                                  ? `\n\n**Sources:**\n${searchResponse.results
                                        .map((result: SearchResult, index: number) =>
                                            `${index + 1}. [${result.title}](${result.url})`
                                        )
                                        .join("\n")}`
                                  : ""
                          }`
                        : "No specific institutional crypto adoption data found.";

                    await callback(createActionResponse({
                        actionName: "INSTITUTIONAL_CRYPTO_SEARCH",
                        type: "institutional_crypto_search",
                        text: await trimTokens(responseList, DEFAULT_MAX_WEB_SEARCH_TOKENS, runtime),
                        actionData: {
                            summary: generateActionSummary({
                                actionName: "Institutional Adoption",
                                assets: [finalSearchQuery.split(" ").slice(0, 3).join(" ")],
                                timePeriod: "30 days",
                                dataPoints: searchResponse.results.length,
                                additionalInfo: `${searchResponse.results.length} sources found`,
                            }),
                            searchQuery: finalSearchQuery,
                            articleCount: searchResponse.results.length,
                            sources: searchResponse.results.map(r => ({ title: r.title, url: r.url })),
                        },
                    }));
                }
            } catch (error) {
                elizaLogger.error("Error generating institutional analysis:", error);
                const responseList = `🔍 **Institutional Crypto Adoption:**\n\n${searchResponse.answer || "Limited data available"}${
                    Array.isArray(searchResponse.results) && searchResponse.results.length > 0
                        ? `\n\n**Sources:**\n${searchResponse.results
                              .map((result: SearchResult, index: number) => `${index + 1}. [${result.title}](${result.url})`)
                              .join("\n")}`
                        : ""
                }`;

                await callback(createActionResponse({
                    actionName: "INSTITUTIONAL_CRYPTO_SEARCH",
                    type: "institutional_crypto_search",
                    text: await trimTokens(responseList, DEFAULT_MAX_WEB_SEARCH_TOKENS, runtime),
                    actionData: {
                        summary: generateActionSummary({
                            actionName: "Institutional Adoption",
                            assets: [finalSearchQuery.split(" ").slice(0, 3).join(" ")],
                            timePeriod: "30 days",
                            dataPoints: searchResponse.results.length,
                            additionalInfo: "analysis generation error",
                        }),
                        searchQuery: finalSearchQuery,
                        articleCount: searchResponse.results.length,
                    },
                }));
            }
        } else {
            const fallbackMessage = `I couldn't find current institutional crypto adoption data for "${finalSearchQuery}". This could be due to:

• Limited recent institutional announcements
• Search service limitations
• The query might need to be more specific

Try asking about:
- Specific companies (e.g., "MicroStrategy Bitcoin holdings")
- ETF developments (e.g., "Bitcoin ETF approvals")
- Recent corporate announcements
- Regulatory updates affecting institutions`;

            await callback(createActionResponse({
                actionName: "INSTITUTIONAL_CRYPTO_SEARCH",
                type: "institutional_crypto_search",
                text: fallbackMessage,
                actionData: {
                    summary: generateActionSummary({
                        actionName: "Institutional Adoption",
                        assets: [finalSearchQuery.split(" ").slice(0, 3).join(" ")],
                        timePeriod: "30 days",
                        dataPoints: 0,
                        additionalInfo: "no institutional developments found",
                    }),
                    searchQuery: finalSearchQuery,
                    articleCount: 0,
                },
            }));
        }
    },
    examples: [
        [
            { user: "{{user1}}", content: { text: "What companies have added Bitcoin to their treasury recently?" } },
            { user: "{{agentName}}", content: { text: "Let me search for recent corporate Bitcoin treasury adoptions:", action: "INSTITUTIONAL_CRYPTO_SEARCH" } },
        ],
        [
            { user: "{{user1}}", content: { text: "Are there any new Bitcoin ETF approvals this month?" } },
            { user: "{{agentName}}", content: { text: "I'll check for the latest Bitcoin ETF approval news:", action: "INSTITUTIONAL_CRYPTO_SEARCH" } },
        ],
        [
            { user: "{{user1}}", content: { text: "How much Bitcoin does MicroStrategy hold currently?" } },
            { user: "{{agentName}}", content: { text: "Let me find the latest information on MicroStrategy's Bitcoin holdings:", action: "INSTITUTIONAL_CRYPTO_SEARCH" } },
        ],
        [
            { user: "{{user1}}", content: { text: "What's the latest on institutional crypto adoption trends?" } },
            { user: "{{agentName}}", content: { text: "I'll search for current institutional cryptocurrency adoption trends:", action: "INSTITUTIONAL_CRYPTO_SEARCH" } },
        ],
        [
            { user: "{{user1}}", content: { text: "Have any pension funds invested in cryptocurrency recently?" } },
            { user: "{{agentName}}", content: { text: "Let me check for recent pension fund cryptocurrency investments:", action: "INSTITUTIONAL_CRYPTO_SEARCH" } },
        ],
    ],
    cacheConfig: {
        enabled: true,
        ttlSeconds: 86400,
        similarityThreshold: 0.7,
        maxChunkSize: 200,
    },
} as Action;
