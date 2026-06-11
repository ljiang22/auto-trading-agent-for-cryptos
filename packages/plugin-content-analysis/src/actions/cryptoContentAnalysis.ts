import type {
    ActionExample,
    IAgentRuntime,
    Memory,
    Action,
    State,
    HandlerCallback,
    Content
} from "@elizaos/core";
import { generateText, ModelClass, createActionResponse, createActionErrorResponse, generateActionSummary } from "@elizaos/core";
import { getCryptoContentAnalysisTemplate } from "../templates/cryptoContentAnalysisTemplate.ts";

/**
 * Crypto Content Analysis Action
 * Analyzes crypto-related documents, articles, reports, and content using specialized crypto analysis template
 */
export const CryptoContentAnalysis: Action = {
    name: "CRYPTO_CONTENT_ANALYSIS",
    description: "Perform specialized cryptocurrency and blockchain content analysis with deep examination of whitepapers, market reports, DeFi protocols, trading strategies, and crypto news. Delivers comprehensive technical analysis, tokenomics evaluation, market sentiment assessment, regulatory impact analysis, and strategic investment insights with quantitative data interpretation.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ): Promise<boolean> => {
        const signal = options?.signal as AbortSignal | undefined;
        try {
            const userRequest = message.content.text || "";
            
            // Handle from/to date range parameters for analysis period context
            let analysisPeriodContext = "";
            if (options?.from && options?.to) {
                const fromStr = String(options.from).trim().slice(0, 10);
                const toStr = String(options.to).trim().slice(0, 10);
                const fromDate = new Date(fromStr + 'T00:00:00.000Z');
                const toDate = new Date(toStr + 'T23:59:59.999Z');
                
                if (!isNaN(fromDate.getTime()) && !isNaN(toDate.getTime()) && fromDate <= toDate) {
                    analysisPeriodContext = `\n\n**Analysis Period**: ${fromStr} to ${toStr}`;
                    console.log(`📅 Crypto content analysis includes date range: ${fromStr} to ${toStr}`);
                }
            }
            
            // Send initial processing message
            await callback(createActionResponse({
                actionName: "CRYPTO_CONTENT_ANALYSIS",
                type: "crypto_content_analysis",
                text: "🔍 Analyzing crypto content using specialized crypto market analysis...",
            }));
            
            // The content to analyze would be passed from previous tasks or in options
            // For now, use the user request itself as the content
            const contentToAnalyze = (options?.content || userRequest) + analysisPeriodContext;
            
            if (!contentToAnalyze.trim()) {
                await callback(createActionErrorResponse({
                    actionName: "CRYPTO_CONTENT_ANALYSIS",
                    type: "crypto_content_analysis_error",
                    error: new Error("No content provided"),
                    text: "Please provide content to analyze.",
                }));
                return true;
            }
            
            // Use crypto content analysis template with system/prompt split for prompt caching
            const template = getCryptoContentAnalysisTemplate();

            const dynamicPrompt = `## Task Context
**User Request:** ${userRequest}
**Task:** CRYPTO_CONTENT_ANALYSIS
**Task Description:** Analyze cryptocurrency and blockchain related content
**Content to Analyze:** ${contentToAnalyze}`;

            // Generate analysis using the template
            const analysisResult = await generateText({
                runtime,
                system: template.system,
                prompt: dynamicPrompt,
                modelClass: ModelClass.LARGE,
                signal,
            });

            // Extract action summary
            let actionSummary = '';
            const summaryMatch = analysisResult.match(/\[ACTION_SUMMARY\]([\s\S]*?)\[\/ACTION_SUMMARY\]/);
            if (summaryMatch) {
                actionSummary = summaryMatch[1].trim().replace(/^(Crypto Content Analysis|Action):\s*/i, '');
            } else {
                // Fallback to programmatic generation
                const wordCount = contentToAnalyze.split(/\s+/).length;
                actionSummary = generateActionSummary({
                    actionName: 'Crypto Content Analysis',
                    assets: ['crypto document'],
                    timePeriod: 'current',
                    dataPoints: wordCount,
                    additionalInfo: `${wordCount} words analyzed`
                });
            }

            // Remove summary tags from the analysis text
            const cleanedAnalysis = analysisResult.replace(/\[ACTION_SUMMARY\][\s\S]*?\[\/ACTION_SUMMARY\][,\s]*/, '').trim();

            // Create structured data for task chains
            const structuredResult = {
                action: "CRYPTO_CONTENT_ANALYSIS",
                summary: actionSummary,
                userRequest: userRequest,
                contentAnalyzed: {
                    length: contentToAnalyze.length,
                    wordCount: contentToAnalyze.split(/\s+/).length,
                    preview: contentToAnalyze.substring(0, 200) + (contentToAnalyze.length > 200 ? "..." : "")
                },
                analysis: cleanedAnalysis,
                timestamp: Date.now()
            };

            // Send the final analysis result
            await callback(createActionResponse({
                actionName: "CRYPTO_CONTENT_ANALYSIS",
                type: "crypto_content_analysis",
                text: cleanedAnalysis,
                actionData: structuredResult,
            }));
            return true;
            
        } catch (error) {
            console.error("Error in CryptoContentAnalysis:", error);
            
            await callback(createActionErrorResponse({
                actionName: "CRYPTO_CONTENT_ANALYSIS",
                type: "crypto_content_analysis_error",
                error: error instanceof Error ? error : new Error(String(error)),
                text: `Sorry, I encountered an error while analyzing the crypto content: ${error}`,
            }));
            return false;
        }
    },
    examples: [
        [
            {
                user: "user1",
                content: {
                    text: "Analyze this Bitcoin whitepaper for me",
                    action: "CRYPTO_CONTENT_ANALYSIS"
                }
            }
        ],
        [
            {
                user: "user2", 
                content: {
                    text: "Please review this DeFi protocol analysis document",
                    action: "CRYPTO_CONTENT_ANALYSIS"
                }
            }
        ],
        [
            {
                user: "user3",
                content: {
                    text: "Can you analyze this Ethereum market report?",
                    action: "CRYPTO_CONTENT_ANALYSIS"
                }
            }
        ],
    ] as ActionExample[][],
    cacheConfig: {
        enabled: true,
        ttlSeconds: 86400, // 1 day for crypto content analysis
        similarityThreshold: 0.7,
        maxChunkSize: 200,
    },
};