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
import type { SearchResponse, SearchResult } from "../types";

const DEFAULT_MAX_CRYPTO_RESEARCH_TOKENS = 6000;
type TavilyClient = ReturnType<typeof tavily>;

const CRYPTO_RESEARCH_ANALYSIS_SYSTEM = `You are a cryptocurrency research analyst. Based ONLY on the web search results provided, analyze each article individually and provide a clear summary for the user's question.

**IMPORTANT: Action Summary Generation**
Before providing your analysis, you MUST generate a brief action summary:

[ACTION_SUMMARY]
Crypto Research for <TOPIC> (<DATA_POINTS> data points): <KEY_INSIGHT>
[/ACTION_SUMMARY]
    Example:
[ACTION_SUMMARY]
Crypto Research for Bitcoin institutional adoption (8 articles): strong consensus on increasing institutional investment with $2.5B inflows in Q4.
[/ACTION_SUMMARY]

Please analyze each article using this SIMPLE format:

**Article 1: [Title]**
• **Opinion Summary**: [What this article concludes about the topic in 1-2 sentences],
• **Key Data**: [Important numbers, percentages, dates, or metrics mentioned],
• **Source**: [Author/Publication] ([Date if available])

**Article 2: [Title]**
• **Opinion Summary**: [What this article concludes about the topic in 1-2 sentences],
• **Key Data**: [Important numbers, percentages, dates, or metrics mentioned],
• **Source**: [Author/Publication] ([Date if available])

[Continue for each article...],

**Overall Research Summary**
• **Consensus View**: [What most sources agree on],
• **Key Findings**: [Most important data points across all sources],
• **Conflicting Views**: [Any disagreements between sources],

FORMATTING RULES:
- Analyze each article separately first
- Keep opinion summaries brief and factual
- Include specific numbers, prices, percentages when available
- Use simple citation format: Source Name (Date)
- Only use information from the provided search results
- If data is missing, write "No specific data provided"

Your article-by-article research analysis:`;

interface CryptoResearchSearchOptions extends Record<string, unknown> {
    from?: string;
    query?: string;
    signal?: AbortSignal;
    to?: string;
}

/**
 * Clean workflow-provided search queries before sending them to Tavily.
 */
function cleanMessageTextForSearch(text: string): string {
    let cleanText = text;
    
    // Remove JSON blocks and code formatting
    cleanText = cleanText.replace(/```json[\s\S]*?```/g, '');
    cleanText = cleanText.replace(/```[\s\S]*?```/g, '');
    cleanText = cleanText.replace(/\{[\s\S]*?\}/g, '');
    
    // Remove action indicators and structured response markers
    cleanText = cleanText.replace(/ACTION:\s*\w+/gi, '');
    cleanText = cleanText.replace(/NEXT STEP:\s*.+/gi, '');
    cleanText = cleanText.replace(/\*\*💡.*?\*\*/g, '');
    cleanText = cleanText.replace(/\*Would you like me to proceed.*?\*/g, '');
    
    // Clean up quotes and special characters
    cleanText = cleanText.replace(/["'`]/g, '');
    cleanText = cleanText.replace(/[{}[\]]/g, '');
    
    // Normalize whitespace
    cleanText = cleanText
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\s{2,}/g, ' ')
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

export const cryptoResearchSearch: Action = {
    name: "CRYPTO_RESEARCH_SEARCH",
    suppressInitialMessage: true,
    description: "Perform specialized web searches focused exclusively on cryptocurrency research analysis, blockchain studies, digital asset research reports, and comprehensive crypto market analysis with academic and professional research emphasis.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state: State,
        options: CryptoResearchSearchOptions,
        callback: HandlerCallback
    ) => {
        const signal = options?.signal as AbortSignal | undefined;
        elizaLogger.log("=== CRYPTO RESEARCH SEARCH Handler Started ===");
        elizaLogger.log("Research Query:", message.content.text);
        elizaLogger.log("TAVILY_API_KEY available:", !!runtime.getSetting("TAVILY_API_KEY"));
        elizaLogger.log("Options:", options);
        elizaLogger.log("===============================================");

        let finalSearchQuery = cleanMessageTextForSearch(options?.query || "").replace(/^\w+:\s*/i, "");
        if (!finalSearchQuery || finalSearchQuery.length < 2) {
            // Resilient fallback: a workflow step that didn't thread `query`
            // should still run using the task/message text (then a domain
            // default) rather than hard-fail the whole task.
            const fromMessage = cleanMessageTextForSearch(message?.content?.text || "").replace(/^\w+:\s*/i, "");
            finalSearchQuery =
                fromMessage && fromMessage.length >= 2
                    ? fromMessage
                    : "cryptocurrency research analysis and market outlook";
            elizaLogger.warn(
                `[CRYPTO_RESEARCH_SEARCH] no valid options.query; derived fallback query: "${finalSearchQuery}"`,
            );
        }

        elizaLogger.log("Final crypto research query:", finalSearchQuery);

        if (tavilyKeyManager.keyCount === 0) {
            elizaLogger.error("No Tavily API keys configured");
            await callback(createActionErrorResponse({
                actionName: "CRYPTO_RESEARCH_SEARCH",
                type: "crypto_research_search_error",
                error: new Error("No Tavily API keys configured"),
                text: "Unable to perform crypto research search: no Tavily API keys configured.",
            }));
            return;
        }

        // Compute search days from from/to when both present; default 30
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

        let searchResponse: SearchResponse | null = null;
        try {
            searchResponse = await _tavilySearchWithRotation(finalSearchQuery.trim(), {
                includeAnswer: true,
                maxResults: 5,
                topic: "general",
                searchDepth: "advanced",
                includeRawContent: true,
                days: searchDays,
            });
        } catch (error) {
            elizaLogger.error("Crypto research search API error:", error);
            
            let errorMessage = "I'm having trouble accessing crypto research data right now.";
            
            if (error.message?.includes('401')) {
                errorMessage = "Unable to access crypto research databases due to invalid API credentials.";
            } else if (error.message?.includes('429')) {
                errorMessage = "I've reached the research search rate limit. Please try again in a few moments.";
            } else if (error.message?.includes('timeout')) {
                errorMessage = "Experiencing network issues while fetching crypto research data. Please try again.";
            }
            
            await callback(createActionErrorResponse({
                actionName: "CRYPTO_RESEARCH_SEARCH",
                type: "crypto_research_search_error",
                error: new Error(errorMessage),
                text: errorMessage,
            }));
            return;
        }

        if (searchResponse?.results?.length > 0) {
            const uniqueResults = searchResponse.results
                .filter((result, index, self) =>
                    index === self.findIndex(r => r.url === result.url)
                )
                .slice(0, 10);
            
            const combinedResearchResults = uniqueResults
                .map((result: SearchResult, index: number) => 
                    `${index + 1}. **${result.title}**\n   URL: ${result.url}\n   Research Content: ${result.content || 'No content available'}\n   Published: ${result.publishedDate || 'Date not available'}`
                )
                .join('\n\n');

            const combinedAnswers =
                typeof searchResponse.answer === "string" && searchResponse.answer.trim().length > 10
                    ? searchResponse.answer.trim()
                    : "";

            const cryptoResearchPromptDynamic = `User's Research Question: ${message.content.text}

Research Results:
${combinedResearchResults}`;

            try {
                const cryptoResearchAnalysis = await generateText({
                    runtime: runtime,
                    system: CRYPTO_RESEARCH_ANALYSIS_SYSTEM,
                    prompt: cryptoResearchPromptDynamic,
                    modelClass: ModelClass.MEDIUM, // Use medium model for comprehensive research analysis
                    signal,
                });

                // Extract action summary
                let actionSummary = '';
                const summaryMatch = cryptoResearchAnalysis.match(/\[ACTION_SUMMARY\]([\s\S]*?)\[\/ACTION_SUMMARY\]/);
                if (summaryMatch) {
                    actionSummary = summaryMatch[1].trim().replace(/^(Crypto Research|Action):\s*/i, '');
                } else {
                    // Fallback to programmatic generation
                    actionSummary = generateActionSummary({
                        actionName: 'Crypto Research',
                        assets: [finalSearchQuery.split(' ').slice(0, 3).join(' ')],
                        timePeriod: '30 days',
                        dataPoints: uniqueResults.length,
                        additionalInfo: `${uniqueResults.length} research articles analyzed`
                    });
                }

                // Remove summary tags from the analysis text
                const cleanedAnalysis = cryptoResearchAnalysis.replace(/\[ACTION_SUMMARY\][\s\S]*?\[\/ACTION_SUMMARY\][,\s]*/, '').trim();

                if (cleanedAnalysis?.trim()) {
                    // Enhanced research sources section
                    const researchSourcesSection = uniqueResults.length > 0
                        ? `\n\n**📚 Research Sources & References:**\n${uniqueResults
                            .map((result: SearchResult, index: number) => {
                                const publishedDate = result.publishedDate ? ` (${result.publishedDate})` : '';
                                return `${index + 1}. [${result.title}](${result.url})${publishedDate}`;
                            })
                            .join("\n")}`
                        : "";

                    const finalResponse = `🔬 **Cryptocurrency Research Analysis**\n\n${cleanedAnalysis.trim()}${researchSourcesSection}`;

                    await callback(createActionResponse({
                        actionName: "CRYPTO_RESEARCH_SEARCH",
                        type: "crypto_research_search",
                        text: await trimTokens(finalResponse, DEFAULT_MAX_CRYPTO_RESEARCH_TOKENS, runtime),
                        actionData: {
                            summary: actionSummary,
                            searchQuery: finalSearchQuery,
                            articleCount: uniqueResults.length,
                            sources: uniqueResults.map(r => ({ title: r.title, url: r.url, date: r.publishedDate })),
                        },
                    }));
                } else {
                    // Research-focused fallback response
                    const fallbackResponse = combinedAnswers
                        ? `📊 **Crypto Research Summary**\n\n${combinedAnswers}${
                              uniqueResults.length > 0
                                  ? `\n\n**📚 Research Sources:**\n${uniqueResults
                                        .map((result: SearchResult, index: number) =>
                                            `${index + 1}. [${result.title}](${result.url})`
                                        )
                                        .join("\n")}`
                                  : ""
                          }`
                        : "Unable to generate comprehensive crypto research analysis from current sources.";

                    // Generate summary for fallback
                    const fallbackSummary = generateActionSummary({
                        actionName: 'Crypto Research',
                        assets: [finalSearchQuery.split(' ').slice(0, 3).join(' ')],
                        timePeriod: '30 days',
                        dataPoints: uniqueResults.length,
                        additionalInfo: `${uniqueResults.length} research articles found`
                    });

                    await callback(createActionResponse({
                        actionName: "CRYPTO_RESEARCH_SEARCH",
                        type: "crypto_research_search",
                        text: await trimTokens(fallbackResponse, DEFAULT_MAX_CRYPTO_RESEARCH_TOKENS, runtime),
                        actionData: {
                            summary: fallbackSummary,
                            searchQuery: finalSearchQuery,
                            articleCount: uniqueResults.length,
                            sources: uniqueResults.map(r => ({ title: r.title, url: r.url, date: r.publishedDate })),
                        },
                    }));
                }
            } catch (error) {
                elizaLogger.error("Error generating crypto research analysis:", error);

                // Simple research fallback
                const simpleResponse = combinedAnswers || "Research search completed but unable to generate detailed analysis.";

                // Generate summary for error fallback
                const errorSummary = generateActionSummary({
                    actionName: 'Crypto Research',
                    assets: [finalSearchQuery.split(' ').slice(0, 3).join(' ')],
                    timePeriod: '30 days',
                    dataPoints: uniqueResults.length,
                    additionalInfo: 'analysis generation error'
                });

                await callback(createActionResponse({
                    actionName: "CRYPTO_RESEARCH_SEARCH",
                    type: "crypto_research_search",
                    text: await trimTokens(simpleResponse, DEFAULT_MAX_CRYPTO_RESEARCH_TOKENS, runtime),
                    actionData: {
                        summary: errorSummary,
                        searchQuery: finalSearchQuery,
                        articleCount: uniqueResults.length,
                    },
                }));
            }
        } else {
            elizaLogger.error("Crypto research search failed or returned no data");
            
            const fallbackMessage = `🔬 **Crypto Research Search Results**\n\nI'm having trouble finding current research about "${finalSearchQuery}" in cryptocurrency and blockchain databases. This could be due to:

• **Research Availability**: The specific crypto topic might not have recent academic or professional research
• **Search Database Limitations**: Temporary access issues to research databases
• **Query Specificity**: The research query might need more specific academic terminology

**Research Suggestions:**
- Try searching for specific cryptocurrencies with "research analysis" (e.g., "Bitcoin research analysis")
- Include terms like "study", "report", "analysis", or "research paper"
- Ask about specific research areas: "DeFi research", "blockchain technology analysis"
- Request institutional research: "crypto investment research", "regulatory analysis"
- Look for sector-specific research: "NFT market research", "stablecoin analysis"

I can help you refine your research query or try a different research approach focused on academic and professional crypto analysis.`;

            // Generate summary for no results scenario
            const noResultsSummary = generateActionSummary({
                actionName: 'Crypto Research',
                assets: [finalSearchQuery.split(' ').slice(0, 3).join(' ')],
                timePeriod: '30 days',
                dataPoints: 0,
                additionalInfo: 'no research articles found'
            });

            await callback(createActionResponse({
                actionName: "CRYPTO_RESEARCH_SEARCH",
                type: "crypto_research_search",
                text: fallbackMessage,
                actionData: {
                    summary: noResultsSummary,
                    searchQuery: finalSearchQuery,
                    articleCount: 0,
                },
            }));
        }
    },
    
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Find research analysis on Bitcoin's long-term value proposition and institutional adoption trends",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "🔬 **Cryptocurrency Research Analysis**\n\nHere's my comprehensive research analysis on Bitcoin's long-term value proposition and institutional adoption trends:",
                    action: "CRYPTO_RESEARCH_SEARCH",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Research the latest academic studies on Ethereum's scalability solutions and Layer 2 analysis",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "📚 **Blockchain Research Analysis**\n\nHere's my analysis of the latest academic research on Ethereum scalability and Layer 2 solutions:",
                    action: "CRYPTO_RESEARCH_SEARCH",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Find comprehensive research on DeFi market analysis and risk assessment studies",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "🔬 **DeFi Research Analysis**\n\nHere's my comprehensive analysis of DeFi market research and risk assessment studies:",
                    action: "CRYPTO_RESEARCH_SEARCH",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Research analysis on cryptocurrency regulatory impact studies and compliance research",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "⚖️ **Crypto Regulatory Research Analysis**\n\nHere's my analysis of cryptocurrency regulatory impact studies and compliance research:",
                    action: "CRYPTO_RESEARCH_SEARCH",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { 
                    text: "Find research on NFT market analysis and digital asset valuation methodologies" 
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "🎨 **NFT & Digital Asset Research Analysis**\n\nHere's my research analysis on NFT markets and digital asset valuation methodologies:",
                    action: "CRYPTO_RESEARCH_SEARCH",
                },
            },
        ],
    ],
    cacheConfig: {
        enabled: true,
        ttlSeconds: 2592000, // 1 month for crypto research
        similarityThreshold: 0.7,
        maxChunkSize: 200,
    },
} as Action;
