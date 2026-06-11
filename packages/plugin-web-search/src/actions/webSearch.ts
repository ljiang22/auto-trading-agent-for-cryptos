import {
    type Action,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
    createActionErrorResponse,
    createActionResponse,
    elizaLogger,
    generateActionSummary,
    generateText,
    ModelClass,
    trimTokens,
} from "@elizaos/core";
import { tavily } from "@tavily/core";
import { tavilyKeyManager, withMemProbe, logMemProbe } from "@elizaos/core";
import type { SearchImage, SearchResult } from "../types";

const DEFAULT_MAX_WEB_SEARCH_TOKENS = 4000;

const WEB_SEARCH_CONCLUSION_SYSTEM = `Based ONLY on the web search results provided, answer the user's question using only the information found in the search results.

**IMPORTANT: Action Summary Generation**
Before providing your analysis, you MUST generate a brief action summary:

[ACTION_SUMMARY]
Web Search for <TOPIC> (<DATA_POINTS> data points): <KEY_INSIGHT>
[/ACTION_SUMMARY]
    Example:
[ACTION_SUMMARY]
Web Search for iPhone 16 release (5 articles): official launch on September 20, 2024 with new A18 chip and improved camera.
[/ACTION_SUMMARY]

Please provide a well-structured response that:
1. Uses ONLY information from the web search results above
2. Addresses the user's question directly based on the search findings
3. Highlights key insights and important details from the search results
4. Clearly states if the search results don't contain enough information to fully answer the question
5. Provides actionable information when available in the search results
6. Do NOT add information from your training data or existing knowledge

Your conclusion based solely on the search results:`;

const IMAGE_CHECK_TIMEOUT_MS = 5000;
const BLOCK_INDICATORS = [
    "access denied",
    "forbidden",
    "blocked",
    "captcha",
    "cloudflare",
    "rate limit",
    "temporarily unavailable",
    "bot protection",
];

type TavilyClient = ReturnType<typeof tavily>;
type SearchTopic = "general" | "news";

interface WebSearchOptions extends Record<string, unknown> {
    from?: string;
    fromTaskChain?: boolean;
    query?: string;
    signal?: AbortSignal;
    topic?: SearchTopic | string;
    to?: string;
}

interface WebSearchPlan {
    query: string;
    topic: SearchTopic;
}

interface SingleSearchMetadata {
    iterationsExecuted: number;
    terminationReason: string;
    totalQueries: number;
    totalResults: number;
}

interface SingleSearchResponse {
    answer: string;
    images: SearchImage[];
    metadata: SingleSearchMetadata;
    query: string;
    responseTime: number;
    results: SearchResult[];
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

function looksBlocked(content: string): boolean {
    const lowerContent = content.toLowerCase();
    return BLOCK_INDICATORS.some((indicator) => lowerContent.includes(indicator));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

async function checkImageUrlAccessible(url: string): Promise<{ ok: boolean; reason?: string }> {
    try {
        const headResponse = await fetchWithTimeout(
            url,
            { method: "HEAD", redirect: "follow" },
            IMAGE_CHECK_TIMEOUT_MS
        );
        // HEAD shouldn't have a body, but cancel defensively.
        void headResponse.body?.cancel();
        const headContentType = headResponse.headers.get("content-type")?.toLowerCase() || "";

        if (headResponse.ok && headContentType.startsWith("image/")) {
            return { ok: true };
        }

        if (!headResponse.ok && headResponse.status !== 405) {
            return { ok: false, reason: `http ${headResponse.status}` };
        }

        const getResponse = await fetchWithTimeout(
            url,
            {
                method: "GET",
                headers: { Range: "bytes=0-2047" },
                redirect: "follow",
            },
            IMAGE_CHECK_TIMEOUT_MS
        );

        if (!getResponse.ok) {
            // Drain & discard so the connection can be reused (don't leak the
            // socket holding a multi-MB response in native memory).
            void getResponse.body?.cancel();
            return { ok: false, reason: `http ${getResponse.status}` };
        }

        const getContentType = getResponse.headers.get("content-type")?.toLowerCase() || "";
        if (getContentType.startsWith("image/")) {
            void getResponse.body?.cancel();
            return { ok: true };
        }

        // If the server ignored Range, content-length can be huge (multi-MB).
        // Refuse to buffer anything larger than ~16 KB — we only need the first
        // few hundred bytes to decide if it's a "blocked" placeholder page.
        const contentLength = Number(getResponse.headers.get("content-length") ?? "0");
        if (contentLength > 16_384) {
            void getResponse.body?.cancel();
            return { ok: false, reason: `non-image content-type: ${getContentType || "unknown"} (oversized ${contentLength}B)` };
        }

        const bodySample = (await getResponse.text()).slice(0, 2000);
        if (looksBlocked(bodySample)) {
            return { ok: false, reason: "blocked or error page" };
        }

        return {
            ok: false,
            reason: `non-image content-type: ${getContentType || "unknown"}`,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        return { ok: false, reason: message };
    }
}

async function filterAccessibleImages(
    images: SearchImage[]
): Promise<{ valid: SearchImage[]; blocked: Array<{ url: string; reason: string }> }> {
    // Cap parallelism so a Tavily search returning 20+ image URLs doesn't open
    // 20+ concurrent HTTP fetches (each potentially buffering response bodies).
    // Empirically, Tavily returns 0–10 images per query — this only matters
    // when an upstream provider returns a long tail.
    const CONCURRENCY = 5;
    const MAX_IMAGES_TO_CHECK = 10;
    const trimmed = images.slice(0, MAX_IMAGES_TO_CHECK);

    const checks: Array<{ image: SearchImage; ok: boolean; reason?: string }> = [];
    for (let i = 0; i < trimmed.length; i += CONCURRENCY) {
        const batch = trimmed.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(
            batch.map(async (image) => {
                const result = await checkImageUrlAccessible(image.url);
                return { image, ok: result.ok, reason: result.reason };
            })
        );
        checks.push(...batchResults);
    }

    return {
        valid: checks.filter((result) => result.ok).map((result) => result.image),
        blocked: checks
            .filter((result) => !result.ok)
            .map((result) => ({
                url: result.image.url,
                reason: result.reason || "unknown error",
            })),
    };
}

function deduplicateImages(images: SearchImage[]): SearchImage[] {
    const unique = new Map<string, SearchImage>();
    for (const image of images) {
        if (image.url && !unique.has(image.url)) {
            unique.set(image.url, image);
        }
    }
    return Array.from(unique.values());
}

function isSearchTopic(value: unknown): value is SearchTopic {
    return value === "general" || value === "news";
}

function computeSearchDays(options: WebSearchOptions | undefined, defaultDays = 7): number {
    let searchDays = defaultDays;

    if (options?.from && options?.to && typeof options.from === "string" && typeof options.to === "string") {
        const fromStr = options.from.trim();
        const toStr = options.to.trim();
        const fromDate = new Date(fromStr.length === 10 ? `${fromStr}T00:00:00.000Z` : fromStr);
        const toDate = new Date(toStr.length === 10 ? `${toStr}T23:59:59.999Z` : toStr);

        if (!Number.isNaN(fromDate.getTime()) && !Number.isNaN(toDate.getTime()) && fromDate <= toDate) {
            searchDays = Math.max(
                1,
                Math.ceil((toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24))
            );
            elizaLogger.log(
                `[WEB_SEARCH] Using date range from/to: ${options.from} to ${options.to} -> ${searchDays} days for news`
            );
        }
    }

    return searchDays;
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

async function executeSingleSearch(
    searchPlan: WebSearchPlan,
    searchOptions: {
        maxResults: number;
        searchDepth: "basic" | "advanced";
        includeImages: boolean;
        includeImageDescriptions?: boolean;
        days?: number;
    }
): Promise<{
    answer: string;
    images: SearchImage[];
    metadata: {
        iterationsExecuted: number;
        terminationReason: string;
        totalQueries: number;
        totalResults: number;
    };
    results: SearchResult[];
}> {
    const result = await _tavilySearchWithRotation(searchPlan.query.trim(), {
        includeAnswer: true,
        maxResults: searchOptions.maxResults,
        topic: searchPlan.topic,
        searchDepth: searchOptions.searchDepth,
        includeImages: searchOptions.includeImages,
        includeImageDescriptions: searchOptions.includeImageDescriptions,
        days: searchPlan.topic === "news" ? searchOptions.days : undefined,
    });

    const results = result.results || [];
    const images = deduplicateImages(result.images || []);
    const answer = typeof result.answer === "string" ? result.answer.trim() : "";

    return {
        answer: answer || `Found information from ${results.length} sources for query "${searchPlan.query.trim()}".`,
        images,
        metadata: {
            totalQueries: 1,
            totalResults: results.length,
            iterationsExecuted: 1,
            terminationReason: "single_search",
        },
        results,
    };
}

export const webSearch: Action = {
    name: "WEB_SEARCH",
    suppressInitialMessage: true,
    description: "Perform a web search to find information related to the message.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state: State,
        options: WebSearchOptions,
        callback: HandlerCallback
    ) => {
        const signal = options?.signal as AbortSignal | undefined;

        elizaLogger.log("=== WEB_SEARCH Handler Debug Info ===");
        elizaLogger.log("Message content:", message.content.text);
        elizaLogger.log("TAVILY_API_KEY available:", !!runtime.getSetting("TAVILY_API_KEY"));
        elizaLogger.log("Options:", options);
        elizaLogger.log("=====================================");

        logMemProbe("webSearch:enter");
        // Previously this called runtime.composeState(message) and the only use
        // of the result was `composedState.searchTopic = searchTopic` (a write
        // to a local variable that was never read again). Local probing showed
        // composeState allocated +3.2 GB of *native* memory (BGE-M3 embedding
        // inference inside ragKnowledgeManager.getKnowledge — see runtime.ts
        // ~line 1928 — plus message-history fanout) that was never released
        // for the rest of the workflow. Drop the call entirely; the search
        // takes its query from `options.query`, never from composed state.
        const cleanedQuery = cleanMessageTextForSearch(options?.query || "").replace(/^\w+:\s*/i, "");
        const resolvedTopic: SearchTopic = isSearchTopic(options?.topic) ? options.topic : "general";

        if (!cleanedQuery || cleanedQuery.length < 2) {
            await callback(
                createActionErrorResponse({
                    actionName: "WEB_SEARCH",
                    type: "web_search_error",
                    error: new Error("WEB_SEARCH requires a valid query parameter"),
                    text: "WEB_SEARCH requires a valid query parameter from the workflow.",
                })
            );
            return;
        }

        if (!isSearchTopic(options?.topic)) {
            elizaLogger.warn('[WEB_SEARCH] Invalid or missing topic, defaulting to general');
        }

        const searchPlan: WebSearchPlan = {
            query: cleanedQuery,
            topic: resolvedTopic,
        };
        const finalSearchQuery = searchPlan.query;
        const searchTopic = searchPlan.topic;
        elizaLogger.log("Final web search query:", finalSearchQuery);
        elizaLogger.log("Final web search topic:", searchTopic);

        if (tavilyKeyManager.keyCount === 0) {
            elizaLogger.error("No Tavily API keys configured");
            await callback(
                createActionErrorResponse({
                    actionName: "WEB_SEARCH",
                    type: "web_search_error",
                    error: new Error("No Tavily API keys configured"),
                    text: "I apologize, but I'm unable to perform web searches right now due to missing API configuration. Please set TAVILY_API_KEY_1 (or TAVILY_API_KEY).",
                })
            );
            return;
        }

        const fromTaskChain = options?.fromTaskChain === true;
        const searchDays = computeSearchDays(options, 7);
        const maxResults = fromTaskChain ? 5 : 3;
        const searchDepth = fromTaskChain ? "advanced" : "basic";

        let searchResponse: SingleSearchResponse | null = null;
        try {
            elizaLogger.info("\n╔════════════════════════════════════════════════════════════╗");
            elizaLogger.info("║              SINGLE SEARCH PHASE                           ║");
            elizaLogger.info("╚════════════════════════════════════════════════════════════╝");

            // Disable image fetching by default — each Tavily image returned
            // costs us a HEAD+GET to validate it (see filterAccessibleImages),
            // and the comprehensive-analysis flow doesn't render them anyway.
            // Flip to true via a future explicit option if a caller actually
            // needs them.
            const singleSearchResult = await withMemProbe(
                "webSearch:tavilySearch",
                () => executeSingleSearch(searchPlan, {
                    maxResults,
                    searchDepth,
                    includeImages: false,
                    includeImageDescriptions: false,
                    days: searchDays,
                }),
                { depth: searchDepth, max: maxResults }
            );

            searchResponse = {
                answer: singleSearchResult.answer,
                results: singleSearchResult.results,
                images: singleSearchResult.images,
                query: finalSearchQuery,
                responseTime: 0,
                metadata: singleSearchResult.metadata,
            };

            elizaLogger.info(
                `✅ Single web search completed: ${searchResponse.results.length} results found`
            );
        } catch (error) {
            elizaLogger.error("Web search API error:", error);

            const errorText = error instanceof Error ? error.message : String(error);
            let errorMessage = "I apologize, but I'm having trouble accessing web search services right now.";

            if (errorText.includes("401") || errorText.toLowerCase().includes("unauthorized")) {
                errorMessage =
                    "I'm unable to perform web searches due to invalid API credentials. Please check the API key configuration.";
            } else if (errorText.includes("429") || errorText.toLowerCase().includes("rate limit")) {
                errorMessage = "I've reached the search rate limit. Please try again in a few moments.";
            } else if (
                errorText.toLowerCase().includes("timeout") ||
                errorText.toLowerCase().includes("econnreset")
            ) {
                errorMessage =
                    "I'm experiencing network connectivity issues with the search service. Please try again later.";
            } else if (/(500|502|503)/.test(errorText)) {
                errorMessage = "The search service is temporarily unavailable. Please try again later.";
            }

            await callback(
                createActionErrorResponse({
                    actionName: "WEB_SEARCH",
                    type: "web_search_error",
                    error: new Error(errorMessage),
                    text: errorMessage,
                })
            );
            return;
        }

        if (searchResponse?.results?.length > 0) {
            elizaLogger.log("✅ Web search successful");

            if (Array.isArray(searchResponse.images) && searchResponse.images.length > 0) {
                const { valid, blocked } = await withMemProbe(
                    "webSearch:filterImages",
                    () => filterAccessibleImages(searchResponse!.images),
                    { count: searchResponse.images.length }
                );
                searchResponse.images = valid;

                if (blocked.length > 0) {
                    for (const image of blocked) {
                        elizaLogger.warn(`Image blocked or failed to load: ${image.url} (${image.reason})`);
                    }
                }
            }

            const structuredSearchData: {
                answer: string;
                images: SearchImage[];
                query: string;
                results: Array<{
                    content: string;
                    index: number;
                    publishedDate?: string;
                    title: string;
                    url: string;
                }>;
                searchTopic: string;
                summary?: string;
                totalResults: number;
            } = {
                query: finalSearchQuery.trim(),
                searchTopic,
                answer: searchResponse.answer || "No direct answer provided",
                results: searchResponse.results.map((result: SearchResult, index: number) => ({
                    index: index + 1,
                    title: result.title,
                    url: result.url,
                    content: result.content || "No content available",
                    publishedDate: result.publishedDate,
                })),
                images: searchResponse.images || [],
                totalResults: searchResponse.results.length,
            };

            elizaLogger.log(`[WEB_SEARCH] Called from task chain: ${fromTaskChain}`);

            if (fromTaskChain) {
                elizaLogger.log("Generating LLM conclusion for task chain");

                const searchResults = searchResponse.results
                    .map(
                        (result: SearchResult, index: number) =>
                            `${index + 1}. Title: ${result.title}\n   URL: ${result.url}\n   Content: ${result.content || "No content available"}`
                    )
                    .join("\n\n");

                const searchAnswer = searchResponse.answer || "No direct answer provided";

                const conclusionPromptDynamic = `User's Original Question: ${message.content.text}

Web Search Query: ${finalSearchQuery}

Web Search Answer: ${searchAnswer}

Web Search Results:
${searchResults}`;

                try {
                    const aiConclusion = await withMemProbe(
                        "webSearch:llmConclusion",
                        () => generateText({
                            runtime,
                            system: WEB_SEARCH_CONCLUSION_SYSTEM,
                            prompt: conclusionPromptDynamic,
                            modelClass: ModelClass.MEDIUM,
                            signal,
                        }),
                        { promptLen: conclusionPromptDynamic.length }
                    );

                    let actionSummary = "";
                    const summaryMatch = aiConclusion.match(/\[ACTION_SUMMARY\]([\s\S]*?)\[\/ACTION_SUMMARY\]/);
                    if (summaryMatch) {
                        actionSummary = summaryMatch[1].trim().replace(/^(Web Search|Action):\s*/i, "");
                    } else {
                        actionSummary = generateActionSummary({
                            actionName: "Web Search",
                            assets: [finalSearchQuery.split(" ").slice(0, 3).join(" ")],
                            timePeriod: searchTopic,
                            dataPoints: searchResponse.results.length,
                            additionalInfo: `${searchResponse.results.length} sources found`,
                        });
                    }

                    const cleanedConclusion = aiConclusion
                        .replace(/\[ACTION_SUMMARY\][\s\S]*?\[\/ACTION_SUMMARY\][,\s]*/, "")
                        .trim();

                    structuredSearchData.summary = actionSummary;

                    if (cleanedConclusion) {
                        const sourcesSection =
                            searchResponse.results.length > 0
                                ? `\n\n**Sources:**\n${searchResponse.results
                                      .map(
                                          (result: SearchResult, index: number) =>
                                              `${index + 1}. [${result.title}](${result.url})`
                                      )
                                      .join("\n")}`
                                : "";

                        const finalResponse = `${cleanedConclusion}${sourcesSection}`;

                        await callback(
                            createActionResponse({
                                actionName: "WEB_SEARCH",
                                type: "web_search",
                                text: await trimTokens(
                                    finalResponse,
                                    DEFAULT_MAX_WEB_SEARCH_TOKENS,
                                    runtime
                                ),
                                actionData: structuredSearchData,
                            })
                        );
                    } else {
                        const responseList = searchResponse.answer
                            ? `${searchResponse.answer}${
                                  Array.isArray(searchResponse.results) && searchResponse.results.length > 0
                                      ? `\n\nFor more details, you can check out these resources:\n${searchResponse.results
                                            .map(
                                                (result: SearchResult, index: number) =>
                                                    `${index + 1}. [${result.title}](${result.url})`
                                            )
                                            .join("\n")}`
                                      : ""
                              }`
                            : "";

                        await callback(
                            createActionResponse({
                                actionName: "WEB_SEARCH",
                                type: "web_search",
                                text: await trimTokens(
                                    responseList,
                                    DEFAULT_MAX_WEB_SEARCH_TOKENS,
                                    runtime
                                ),
                                actionData: structuredSearchData,
                            })
                        );
                    }
                } catch (error) {
                    elizaLogger.error("Error generating AI conclusion:", error);

                    const responseList = searchResponse.answer
                        ? `${searchResponse.answer}${
                              Array.isArray(searchResponse.results) && searchResponse.results.length > 0
                                  ? `\n\nFor more details, you can check out these resources:\n${searchResponse.results
                                        .map(
                                            (result: SearchResult, index: number) =>
                                                `${index + 1}. [${result.title}](${result.url})`
                                        )
                                        .join("\n")}`
                                  : ""
                          }`
                        : "";

                    structuredSearchData.summary = generateActionSummary({
                        actionName: "Web Search",
                        assets: [finalSearchQuery.split(" ").slice(0, 3).join(" ")],
                        timePeriod: searchTopic,
                        dataPoints: searchResponse.results.length,
                        additionalInfo: "analysis generation error",
                    });

                    await callback(
                        createActionResponse({
                            actionName: "WEB_SEARCH",
                            type: "web_search",
                            text: await trimTokens(
                                responseList,
                                DEFAULT_MAX_WEB_SEARCH_TOKENS,
                                runtime
                            ),
                            actionData: structuredSearchData,
                        })
                    );
                }
            } else {
                if (!structuredSearchData.summary) {
                    structuredSearchData.summary = generateActionSummary({
                        actionName: "Web Search",
                        assets: [finalSearchQuery.split(" ").slice(0, 3).join(" ")],
                        timePeriod: searchTopic,
                        dataPoints: searchResponse.results.length,
                        additionalInfo: `${searchResponse.results.length} sources found`,
                    });
                }

                const formattedResults = structuredSearchData.results
                    .map(
                        (result) =>
                            `${result.index}. **${result.title}**\n   URL: ${result.url}\n   ${
                                result.publishedDate ? `Published: ${result.publishedDate}\n   ` : ""
                            }Content: ${result.content}`
                    )
                    .join("\n\n");

                const textSummary =
                    `Web Search Query: "${structuredSearchData.query}"\n\n` +
                    `Search Answer: ${structuredSearchData.answer}\n\n` +
                    `Found ${structuredSearchData.totalResults} results:\n\n${formattedResults}`;

                await callback(
                    createActionResponse({
                        actionName: "WEB_SEARCH",
                        type: "web_search",
                        text: textSummary,
                        actionData: structuredSearchData,
                        additionalMetadata: {
                            isStructuredData: true,
                        },
                    })
                );
            }
        } else {
            elizaLogger.error("search failed or returned no data.");

            const fallbackMessage = searchResponse?.answer
                ? `I found some information, but the search results were limited. Here's what I can tell you: ${searchResponse.answer}`
                : `I'm having trouble finding current information about "${finalSearchQuery}" right now. This could be due to:

• Search service limitations or rate limits
• Network connectivity issues
• The query might need to be more specific

Please try rephrasing your question or try again in a few moments. Alternatively, I can help you with information I already know or assist with other tasks.`;

            const noResultsSummary = generateActionSummary({
                actionName: "Web Search",
                assets: [finalSearchQuery.split(" ").slice(0, 3).join(" ")],
                timePeriod: searchTopic,
                dataPoints: 0,
                additionalInfo: "no search results found",
            });

            await callback(
                createActionResponse({
                    actionName: "WEB_SEARCH",
                    type: "web_search",
                    text: fallbackMessage,
                    actionData: {
                        summary: noResultsSummary,
                        query: finalSearchQuery,
                        searchTopic,
                        totalResults: 0,
                    },
                })
            );
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Can you find details about the iPhone 16 release?",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Here are the details I found about the iPhone 16 release:",
                    action: "WEB_SEARCH",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "What is the schedule for the next FIFA World Cup?",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Here is the schedule for the next FIFA World Cup:",
                    action: "WEB_SEARCH",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "What are the current trending movies in the US?",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Here are the current trending movies in the US:",
                    action: "WEB_SEARCH",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "What is the latest score in the NBA finals?",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Here is the latest score from the NBA finals:",
                    action: "WEB_SEARCH",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "When is the next Apple keynote event?" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Here is the information about the next Apple keynote event:",
                    action: "WEB_SEARCH",
                },
            },
        ],
    ],
    cacheConfig: {
        enabled: true,
        ttlSeconds: 604800,
        similarityThreshold: 0.7,
        maxChunkSize: 200,
    },
} as Action;
