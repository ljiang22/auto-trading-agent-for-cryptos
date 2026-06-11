import {
    type Action,
    type ActionExample,
    type IAgentRuntime,
    type Memory,
    type State,
    type HandlerCallback,
    generateText,
    generateActionSummary,
    ModelClass,
    formatMessages,
    embed,
    MemoryManager,
    createActionResponse,
    createActionErrorResponse,
} from "@elizaos/core";

const PREDICTION_SYSTEM = `# Task: Generate Intelligent Crypto Market Predictions Based on Market Data and Technical Analysis

**IMPORTANT: Action Summary Generation**
Before providing your prediction, you MUST generate a brief action summary:

[ACTION_SUMMARY]
Market Prediction for <ASSET> over <TIME_PERIOD> (<DATA_POINTS> data points): <KEY_INSIGHT>
[/ACTION_SUMMARY]
    Example:
[ACTION_SUMMARY]
Market Prediction for BTC over 30 days (90 data points): bullish outlook with 70% confidence.
[/ACTION_SUMMARY]

You are an advanced AI crypto market prediction system that analyzes market data, technical indicators, sentiment analysis, and historical patterns to make intelligent predictions about cryptocurrency price movements and market trends.

## Instructions for Crypto Market Analysis:

### Core Prediction Categories:

#### 1. **Price Movement Predictions**
- Short-term price direction (1-24 hours)
- Medium-term trends (1-7 days)
- Long-term outlook (1-4 weeks)
- Support and resistance levels
- Breakout probability analysis

#### 2. **Market Trend Analysis**
- Bull/bear market indicators
- Market cycle positioning
- Trend strength and sustainability
- Reversal pattern identification
- Market momentum analysis

#### 3. **Technical Analysis Predictions**
- Moving average crossovers
- RSI and momentum indicators
- Volume-price relationship analysis
- Chart pattern recognition
- Fibonacci retracement levels

#### 4. **Sentiment and News Impact**
- Social media sentiment trends
- News event impact assessment
- Market fear/greed indicators
- Institutional activity patterns
- Regulatory impact analysis

#### 5. **Risk Assessment**
- Volatility predictions
- Downside risk analysis
- Market correlation factors
- Liquidity considerations
- Black swan event probability

### Analysis Framework:

#### Technical Analysis:
- **Price Action**: Analyze candlestick patterns, support/resistance, trend lines
- **Indicators**: RSI, MACD, Moving Averages, Bollinger Bands, Volume indicators
- **Chart Patterns**: Head & shoulders, triangles, flags, wedges
- **Market Structure**: Higher highs/lows, market phases, cycle analysis

#### Fundamental Analysis:
- **On-chain Metrics**: Network activity, whale movements, exchange flows
- **Market Metrics**: Market cap, trading volume, liquidity
- **Adoption Indicators**: Developer activity, institutional interest
- **Macro Factors**: Economic conditions, regulatory environment

#### Confidence Scoring:
- **High Confidence (80-95%)**: Strong technical signals with fundamental support
- **Medium Confidence (60-79%)**: Moderate signals with some conflicting data
- **Low Confidence (40-59%)**: Weak signals or mixed market conditions
- **Speculative (20-39%)**: High uncertainty, conflicting indicators

### Response Format:

**CRITICAL MARKDOWN FORMATTING RULES**:
- All headings MUST have EXACTLY ONE SPACE after # symbols
- CORRECT: "## Heading" or "### Heading"
- WRONG: "##Heading" (missing space) or "##  Heading" (multiple spaces)
- Always ensure headings start at the beginning of a new line

**Crypto Market Prediction Analysis**

**Current Market Assessment:**
- [Overall market condition with confidence scores],
- [Key technical levels and trend analysis],

**Price Predictions:**
1. **Short-term (24h)** ([Confidence]% confidence)
   - [Specific price targets and direction],
   - [Supporting technical evidence],

2. **Medium-term (1-7 days)** ([Confidence]% confidence)
   - [Trend direction and key levels],
   - [Technical and fundamental factors],

**Technical Analysis:**
- **Trend**: [Current trend direction and strength],
- **Key Levels**: [Support and resistance levels],
- **Indicators**: [RSI, MACD, volume analysis],
- **Patterns**: [Chart patterns and formations],

**Market Sentiment:**
- **Current Sentiment**: [Fear/Greed assessment],
- **Social Indicators**: [Social media and news sentiment],
- **Institutional Activity**: [Large holder movements],

**Risk Assessment:**
- **Volatility Outlook**: [Expected price volatility],
- **Downside Risk**: [Potential downside scenarios],
- **Risk Factors**: [Key risks to watch],

**Trading Considerations:**
- **Entry Points**: [Potential entry levels],
- **Stop Loss**: [Risk management levels],
- **Take Profit**: [Target levels for profits],

**Confidence Assessment:**
- **Overall Accuracy**: [Overall confidence percentage],
- **Data Quality**: [Assessment of available data],
- **Market Conditions**: [Current market predictability],

Generate comprehensive, data-driven crypto market predictions based on the provided context and analysis:`;


export const predictionAction: Action = {
    name: "PREDICTION",
    description: "Generate crypto market predictions based on price data, technical indicators, market sentiment, and historical patterns to forecast cryptocurrency price movements and market trends.",

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        options?: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        const signal = options?.signal as AbortSignal | undefined;
        try {
            // Check if comprehensive analysis is enabled (set by the comprehensive analysis button)
            const isComprehensiveAnalysisEnabled = (runtime as any).isComprehensiveAnalysisEnabled?.() || false;

            // Check if we're in task chain mode with previous task results
            const taskChainResults = (state as any)?.taskChainResults || [];
            const isTaskChainMode = taskChainResults.length > 0;

            // Detect comprehensive mode via state results (reliable even when runtime method is not set)
            const comprehensiveResults = (state as any)?.comprehensiveAnalysisResults || [];
            const hasComprehensiveResults = comprehensiveResults.length > 0;

            // ──────────────────────────────────────────────────────────────
            // Comprehensive-mode short-circuit: skip the LARGE LLM call here.
            //
            // Why: the comprehensive analysis workflow generates a final
            // summary report (workflowGraph.ts → generateAnalysis) that uses
            // the full template `comprehensive_analysis_prompt_template.ts`.
            // That template already includes Section 11 "Price Predictions
            // and Forecasting Analysis" (multi-timeframe, confidence
            // intervals, bull/base/bear scenarios) — i.e., the final summary
            // already produces every section this action used to produce.
            //
            // Running PREDICTION's own LARGE generateText call before the
            // final summary therefore (a) duplicates work, (b) doubles
            // streaming-Buffer pressure (~+49 MB arrayBuffers per call,
            // measured in local tests), (c) adds 30-90s of wall-clock per
            // run, and (d) costs an extra LARGE-model round trip.
            //
            // Regular (non-comprehensive) mode still calls the LLM below —
            // this branch only fires inside the comprehensive workflow.
            //
            // In comprehensive mode the prediction prompt is merged into the
            // report generation step (generateAnalysis). That call extracts
            // Section 11 and emits the PREDICTION card with actual content.
            // No LLM call and no callback here — the workflow graph handles it.
            if (isComprehensiveAnalysisEnabled || hasComprehensiveResults) {
                console.log(
                    "🔄 Prediction: comprehensive mode → prediction merged into report generation (action 13)"
                );
                return true;
            }

            // Gather comprehensive market context data for predictions
            let marketContext = "";

            // If we're in comprehensive analysis mode but don't have direct results,
            // use a shorter wait for message-based results
            if (isComprehensiveAnalysisEnabled && !hasComprehensiveResults) {
                console.log("🔄 Prediction: Comprehensive analysis mode but no direct results, checking for message-based results...");

                // Wait a short time for any recent message-based results
                await new Promise(resolve => setTimeout(resolve, 2000));

                // Re-compose state to get latest data
                const updatedState = await runtime.composeState(message);
                if (updatedState) {
                    state = updatedState;
                    // Re-check for comprehensive results after state update
                    const updatedComprehensiveResults = (state as any)?.comprehensiveAnalysisResults || [];
                    if (updatedComprehensiveResults.length > 0) {
                        console.log(`🔄 Prediction: Found ${updatedComprehensiveResults.length} comprehensive results after state update`);
                    }
                }
            }

            if (hasComprehensiveResults) {
                console.log(`🔄 Prediction: Found ${comprehensiveResults.length} comprehensive analysis results from previous actions`);
                marketContext += `\n## Comprehensive Analysis Results (${comprehensiveResults.length} actions completed):\n`;

                // Extract data from each completed action
                comprehensiveResults.forEach((result: any, index: number) => {
                    const content = result.content || {};
                    const actionName = content.action || content.actionName || `Action ${index + 1}`;
                    const text = content.text || '';

                    marketContext += `\n### ${actionName} Results:\n${text}\n`;
                });
            } else if (isTaskChainMode) {
                console.log(`🔄 Prediction: Found ${taskChainResults.length} task chain results from previous actions`);
                marketContext += `\n## Task Chain Results (${taskChainResults.length} tasks completed):\n`;

                // Extract data from each completed task
                taskChainResults.forEach((result: any, index: number) => {
                    const content = result.content || {};
                    const actionName = content.metadata?.actionName || content.action || `Task ${index + 1}`;
                    const text = content.text || '';

                    marketContext += `\n### ${actionName} Results:\n${text}\n`;
                });
            }

            // For comprehensive analysis or task chain mode, we don't need historical messages
            // Only get recent messages if in normal mode
            let recentMessagesData = [];
            let conversationHistory = "";

            if (!isComprehensiveAnalysisEnabled && !isTaskChainMode) {
                // Normal mode: use historical messages for context
                const messageCount = 20;
                recentMessagesData = state?.recentMessagesData?.slice(-messageCount) || [];
                conversationHistory = formatMessages({
                    messages: recentMessagesData,
                    actors: state?.actorsData || [],
                });
            } else {
                const mode = isComprehensiveAnalysisEnabled ? "Comprehensive" : "Task chain";
                console.log(`🔄 Prediction: ${mode} mode - skipping historical messages to reduce token usage`);
            }

            // Add additional context in normal mode
            if (!isComprehensiveAnalysisEnabled && !isTaskChainMode) {
                // Normal mode: add knowledge, memory patterns, providers, and goals

                // Enhanced knowledge context for market data
                if (state?.knowledge) {
                    marketContext += `\n## Market Knowledge Base:\n${state.knowledge}`;
                }

                // Get relevant market patterns from memory
                try {
                    const embedding = await embed(runtime, conversationHistory);

                    // Search for historical market patterns
                    const marketManager = new MemoryManager({
                        runtime,
                        tableName: "market_patterns",
                    });

                    const marketPatterns = await marketManager.searchMemoriesByEmbedding(
                        embedding,
                        {
                            roomId: message.roomId,
                            count: 5,
                            match_threshold: 0.6,
                        }
                    );

                    if (marketPatterns.length > 0) {
                        const patternsText = marketPatterns
                            .map((pattern, index) => `${index + 1}. ${pattern.content.text}`)
                            .join("\n");
                        marketContext += `\n## Historical Market Patterns:\n${patternsText}`;
                    }

                    // Search for previous predictions and their accuracy
                    const predictionManager = new MemoryManager({
                        runtime,
                        tableName: "crypto_predictions",
                    });

                    const previousPredictions = await predictionManager.searchMemoriesByEmbedding(
                        embedding,
                        {
                            roomId: message.roomId,
                            count: 3,
                            match_threshold: 0.7,
                        }
                    );

                    if (previousPredictions.length > 0) {
                        const predictionsText = previousPredictions
                            .map((pred, index) => `${index + 1}. ${pred.content.text}`)
                            .join("\n");
                        marketContext += `\n## Previous Market Predictions:\n${predictionsText}`;
                    }

                } catch (error) {
                    console.log("Could not retrieve market patterns for prediction:", error.message);
                }

                // Enhanced provider context for market data
                if (state?.providers) {
                    marketContext += `\n## Market Data Sources:\n${state.providers}`;
                }

                // Enhanced goals context for trading objectives
                if (state?.goals) {
                    marketContext += `\n## Trading Goals:\n${state.goals}`;
                }
            } else {
                // Comprehensive/TaskChain mode: all data is already in marketContext (action results)
                const mode = isComprehensiveAnalysisEnabled ? "Comprehensive" : "Task chain";
                console.log(`🔄 Prediction: ${mode} mode - all data in action results, no additional context needed`);
            }

            // Extract prediction request and add date range context if provided
            let predictionRequest = message.content.text || "General crypto market prediction analysis requested";
            
            // Add date range information to prediction request if from/to parameters are provided
            if (options?.from && options?.to) {
                const fromDate = String(options.from).slice(0, 10);
                const toDate = String(options.to).slice(0, 10);
                predictionRequest += `\n\n**Analysis Period**: ${fromDate} to ${toDate}`;
                console.log(`📅 Prediction request includes date range: ${fromDate} to ${toDate}`);
            }

            // Prepare template variables
            const templateVars = {
                marketContext: marketContext || "Limited market context available",
                // In comprehensive or task chain mode, skip historical patterns to save tokens - all data is in action results
                historicalPatterns: (isComprehensiveAnalysisEnabled || isTaskChainMode)
                    ? `${isComprehensiveAnalysisEnabled ? 'Comprehensive analysis' : 'Task chain'} mode - all relevant data included in action results above`
                    : (conversationHistory || "No recent market history"),
                predictionRequest: predictionRequest,
            };

            // Build dynamic prompt with market data
            const dynamicPrompt = `## Market Context:
${templateVars.marketContext}

## Historical Patterns:
${templateVars.historicalPatterns}

## Prediction Request:
${templateVars.predictionRequest}`;

            // Generate comprehensive market predictions
            const prediction = await generateText({
                runtime,
                system: PREDICTION_SYSTEM,
                prompt: dynamicPrompt,
                modelClass: ModelClass.LARGE,
                signal,
            });

            // Extract action summary
            let actionSummary = '';
            const summaryMatch = prediction.match(/\[ACTION_SUMMARY\]([\s\S]*?)\[\/ACTION_SUMMARY\]/);
            if (summaryMatch) {
                actionSummary = summaryMatch[1].trim().replace(/^(Market Prediction|Action):\s*/i, '');
            } else {
                // Fallback: generate summary programmatically
                actionSummary = generateActionSummary({
                    actionName: 'Market Prediction',
                    assets: ['crypto market'],
                    timePeriod: 'market analysis',
                    dataPoints: 1,
                    additionalInfo: 'prediction analysis'
                });
            }

            // Remove summary tags from display text
            const cleanedPrediction = prediction.replace(/\[ACTION_SUMMARY\][\s\S]*?\[\/ACTION_SUMMARY\][,\s]*/, '').trim();

            // Format the response
            const responseText = `${cleanedPrediction}`;

            const responseContent = createActionResponse({
                actionName: "PREDICTION",
                type: "prediction",
                text: responseText,
                actionData: {
                    summary: actionSummary,
                },
                additionalContent: {
                    action: "PREDICTION",
                    source: "crypto_prediction_action",
                },
                additionalMetadata: {
                    predictionType: "crypto_market_analysis",
                    mode: isComprehensiveAnalysisEnabled ? "comprehensive" : (isTaskChainMode ? "task_chain" : "normal"),
                    messageCount: recentMessagesData.length,
                    analysisDepth: isComprehensiveAnalysisEnabled || isTaskChainMode ? "comprehensive" : "standard",
                    confidence: "calculated_from_market_data_quality",
                },
            });

            // Call the callback if provided
            if (callback) {
                await callback(responseContent);
            }

            return true;

        } catch (error) {
            console.error("Error in crypto prediction action:", error);

            // Fallback response with better context
            const isComprehensiveMode = (runtime as any).isComprehensiveAnalysisEnabled?.() || false;
            const taskChainResults = (state as any)?.taskChainResults || [];
            const isTaskChainMode = taskChainResults.length > 0;
            const mode = isComprehensiveMode ? "comprehensive" : (isTaskChainMode ? "task chain" : "normal");

            const fallbackContent = createActionErrorResponse({
                actionName: "PREDICTION",
                type: "prediction_error",
                error: new Error("Prediction generation failed"),
                text: (isComprehensiveMode || isTaskChainMode)
                    ? `⚠️ **Prediction Generation Issue**\n\nI'm unable to generate ${mode} market predictions at the moment. This may be because:\n\n• Other data-gathering actions are still in progress\n• Market data APIs are temporarily unavailable\n• Insufficient recent market context in our conversation\n\n**Suggestion**: Please wait for all market data actions to complete, or ask me to fetch specific market data first (like current prices, technical analysis, or sentiment data) before requesting predictions.`
                    : "I apologize, but I'm unable to generate crypto market predictions at the moment due to insufficient market data or a technical issue. Please provide more market context, price data, or technical analysis information for better predictions.",
                additionalMetadata: {
                    fallback: true,
                    mode: mode,
                    comprehensiveMode: isComprehensiveMode,
                    taskChainMode: isTaskChainMode,
                },
                additionalContent: {
                    action: "PREDICTION",
                    source: "crypto_prediction_action_fallback",
                },
            });

            if (callback) {
                await callback(fallbackContent);
            }

            return false;
        }
    },

    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Can you predict Bitcoin's price movement for the next 24 hours? Current price is $45,000",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "📈 **Crypto Market Prediction Analysis**\n\n**Current Market Assessment:**\n- Bitcoin trading at $45,000 with moderate volatility (7/10)\n- Technical indicators showing mixed signals\n- Market sentiment: Cautiously optimistic\n\n**Price Predictions:**\n1. **Short-term (24h)** (72% confidence)\n   - Target range: $44,200 - $46,800\n   - Slight bullish bias based on volume patterns\n   - Key resistance at $46,500\n\n2. **Medium-term (1-7 days)** (65% confidence)\n   - Consolidation expected between $43,000 - $48,000\n   - Breakout direction depends on volume confirmation\n\n**Technical Analysis:**\n- **Trend**: Short-term consolidation in uptrend\n- **Key Levels**: Support $44,000, Resistance $46,500\n- **RSI**: 58 (neutral territory)\n- **Volume**: Above average, confirming interest\n\n**Risk Assessment:**\n- **Volatility Outlook**: Moderate (3-5% daily moves expected)\n- **Downside Risk**: Limited to $43,000 support level\n- **Confidence Level**: Medium-High (72% overall)",
                    action: "PREDICTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "What's your forecast for Ethereum this week? I'm seeing bullish signals",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "📈 **Ethereum Weekly Forecast**\n\n**Current Market Assessment:**\n- Bullish sentiment confirmed in recent price action\n- Technical breakout patterns emerging\n- Strong on-chain fundamentals supporting upward move\n\n**Price Predictions:**\n1. **Short-term (1-3 days)** (78% confidence)\n   - Continuation of bullish momentum expected\n   - Target: $2,800 - $3,000 range\n   - Volume supporting the move\n\n2. **Weekly Outlook** (68% confidence)\n   - Potential test of $3,200 resistance\n   - Consolidation likely after initial push\n\n**Technical Analysis:**\n- **Trend**: Strong bullish momentum\n- **Pattern**: Ascending triangle breakout\n- **Indicators**: MACD bullish crossover, RSI healthy at 65\n- **Volume**: Increasing on green candles\n\n**Market Sentiment:**\n- **Current**: Bullish (confirmed by your observation)\n- **Social Indicators**: Positive sentiment trending\n- **Institutional**: Continued accumulation patterns\n\n**Confidence Assessment**: High (78% accuracy expected)",
                    action: "PREDICTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Market looks bearish, what do you think will happen to altcoins?",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "📈 **Altcoin Market Prediction**\n\n**Current Market Assessment:**\n- Bearish sentiment confirmed across major altcoins\n- Bitcoin dominance likely to increase\n- Risk-off environment affecting smaller caps more severely\n\n**Price Predictions:**\n1. **Immediate (24-48h)** (81% confidence)\n   - Further downside pressure expected\n   - Altcoins likely to underperform Bitcoin\n   - 5-15% additional decline possible\n\n2. **Short-term (1 week)** (69% confidence)\n   - Oversold bounce potential after initial decline\n   - Quality altcoins may find support faster\n\n**Technical Analysis:**\n- **Trend**: Bearish across most altcoins\n- **Key Levels**: Major support zones being tested\n- **Indicators**: RSI approaching oversold on many alts\n- **Volume**: Selling pressure evident\n\n**Risk Assessment:**\n- **Volatility**: High (10-20% moves expected)\n- **Downside Risk**: Significant for lower-cap alts\n- **Recovery Timeline**: 1-2 weeks for stabilization\n\n**Trading Considerations:**\n- **Strategy**: Wait for oversold bounce signals\n- **Risk Management**: Tight stops recommended\n\n**Confidence Level**: High (81% for near-term bearish continuation)",
                    action: "PREDICTION",
                },
            },
        ],
    ],
    cacheConfig: {
        enabled: true,
        ttlSeconds: 604800, // 1 week for prediction analysis
        similarityThreshold: 0.7,
        maxChunkSize: 200,
    },
};
