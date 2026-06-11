/**
 * Regular Message Handler using LangGraph workflow architecture
 * Handles conversational responses with intelligent action calling
 */

import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { elizaLogger } from "../utils/logger.ts";
import { getDataRetentionConfig, DATA_RETENTION_DAYS_BY_TIER } from "../utils/dataRetention.ts";
import { generateText } from "../ai/generation.ts";
import { composeContextSplit } from "../core/context.ts";
import { getRegularMessageTemplate, getFinalResponseTemplate } from "../templates/regularMessageTemplate.ts";
import { parseJSONObjectFromText } from "../validation/parsing.ts";
import { ModelClass, ModelProviderName } from "../core/types.ts";
import { ImageProcessor } from "../utils/imageProcessor.ts";
import { logRegularMessageOutcome } from "../utils/executionLogger.ts";
import { StateGraph, Annotation } from "@langchain/langgraph";
import { buildLangSmithRunnableConfig } from "../utils/langsmith.ts";
import { getNonCEXActions } from "../utils/pluginFilter.ts";
import { getLanguageInstruction } from "../utils/languageUtils.ts";
import { attachResponseSummary } from "../utils/persistResponseSummary.ts";
import { formatPendingTradingPlansContext } from "./pendingPlanContext.ts";
import type {
    IAgentRuntime,
    Memory,
    HandlerCallback,
    StreamingCallback,
    UUID,
    Action
} from "../core/types.ts";

// LangGraph State Definition
export const RegularMessageState = Annotation.Root({
    // Input parameters
    message: Annotation<Memory>(),
    runtime: Annotation<IAgentRuntime>(),
    callback: Annotation<HandlerCallback>(),
    streamingCallback: Annotation<StreamingCallback>(),
    intermediateResponseCallback: Annotation<(response: Memory) => void>(),
    // Raw token-level callback. When provided (e.g. by the SSE streaming
    // endpoint), each Gemini delta is forwarded immediately so the client can
    // render text as it's produced. The existing intermediateResponseCallback
    // still fires at the end.
    onToken: Annotation<((delta: string) => void) | undefined>(),

    // Context data
    recentMessages: Annotation<string>(),
    currentDate: Annotation<string>(),
    availableActions: Annotation<string>(),
    imageAttachments: Annotation<any>(),
    userTraits: Annotation<string>(),
    pendingTradingPlans: Annotation<string>(),
    dataRetentionInfo: Annotation<string>(),
    languageInstruction: Annotation<string>(),

    // Processing state
    iteration: Annotation<number>(),
    maxIterations: Annotation<number>(),
    actionResults: Annotation<any[]>(),

    // Response data
    llmResponse: Annotation<string>(),
    parsedResponse: Annotation<{isAction: boolean, actionCall?: any, text?: string}>(),
    finalResponse: Annotation<Memory>(),
    chartPath: Annotation<string>(),
    forceFinalResponse: Annotation<boolean>(),
    streamingResponseId: Annotation<UUID>(),

    // Control flow
    shouldContinue: Annotation<boolean>(),
    isComplete: Annotation<boolean>(),
    hasError: Annotation<boolean>(),
    errorMessage: Annotation<string>(),

    // Processing metadata
    startTime: Annotation<number>(),
    phase: Annotation<string>()
});

export type RegularMessageStateType = typeof RegularMessageState.State;


function stopIfRequested(
    state: RegularMessageStateType,
    label: string
): Partial<RegularMessageStateType> | null {
    if (!state.runtime.shouldStop?.()) {
        return null;
    }

    const stopText = "Processing stopped as requested.";

    elizaLogger.info(`[RegularMessageWorkflow] Stop requested ${label}`);
    state.streamingCallback?.({
        id: uuidv4(),
        name: "processing_stopped",
        status: "completed",
        message: stopText,
        timestamp: Date.now(),
        data: {
            reason: "user_stop",
            phase: state.phase
        }
    });

    return {
        llmResponse: stopText,
        parsedResponse: { isAction: false, text: stopText },
        shouldContinue: false,
        forceFinalResponse: true,
        hasError: false,
        errorMessage: "",
        phase: "stopped"
    };
}

/**
 * Initialize the workflow with context and setup
 */
async function initializeWorkflow(state: RegularMessageStateType): Promise<Partial<RegularMessageStateType>> {
    const startTime = Date.now();
    elizaLogger.info(`[RegularMessageWorkflow] Initializing workflow`);

    try {
        state.runtime.resetStopFlag?.();
        // Get recent messages for context
        const recentMessagesData = await state.runtime.messageManager.getMemories({
            roomId: state.message.roomId,
            count: 5,
            unique: false,
        });

        // Format recent messages for context. Agent turns substitute their
        // persisted `metadata.summary` (the `## Key Findings` block emitted
        // at the bottom of the response) when available — this keeps the
        // recent-conversation window compact on follow-up turns and avoids
        // shoveling 3–5 KB of stale prose into every subsequent LLM call.
        // User turns always use the full text.
        const recentMessages = recentMessagesData
            .slice(-5)
            .map(msg => {
                const isAgent = msg.userId === state.runtime.agentId;
                const name = isAgent ? state.runtime.character.name : "User";
                const summaryRaw = isAgent
                    ? (msg.content?.metadata as { summary?: unknown } | undefined)?.summary
                    : undefined;
                const summary = typeof summaryRaw === "string" && summaryRaw.length > 0
                    ? summaryRaw
                    : "";
                const body = summary || msg.content.text;
                return `${name}: ${body}`;
            })
            .join('\n');

        // Get current date in a readable format
        const currentDate = new Date().toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });

        // Get user traits from UserFeatureManager (new memory-based system with semantic search)
        let userTraits = "";
        const userId = state.message.userId;
        if (userId && userId !== state.runtime.agentId) {
            try {
                userTraits = await state.runtime.userFeatureManager.formatUserTraitsForContext(
                    userId,
                    {
                        queryMessage: state.message.content.text,
                        topN: 3,
                        similarityThreshold: 0,
                        fallbackToAll: true
                    }
                );
                if (userTraits) {
                    elizaLogger.debug(`[RegularMessageWorkflow] Loaded user traits for ${userId}`);
                }
            } catch (error) {
                elizaLogger.warn(`[RegularMessageWorkflow] Failed to load user traits: ${error}`);
            }
        }

        // Format available actions for template (excludes trading-exclusive actions)
        const nonCEXActions = getNonCEXActions(state.runtime);
        const availableActions = nonCEXActions.length > 0 ?
            nonCEXActions.map(action =>
                `**${action.name}**: ${action.description}`
            ).join('\n') : "";

        // Resolve user tier and data retention for template (date-range actions)
        let dataRetentionInfo = "Free. Allowed: last 3 months (90 days).";
        if (userId && userId !== state.runtime.agentId) {
            try {
                const retention = await getDataRetentionConfig(state.runtime, userId);
                if (retention.dataRetentionMinDaysAgo != null && retention.dataRetentionMaxDaysAgo != null) {
                    dataRetentionInfo = "Anonymous. Allowed: data between 1 and 3 months ago (30–90 days ago).";
                } else if (retention.dataRetentionDays === 0) {
                    dataRetentionInfo = "Enterprise. Allowed: no limit.";
                } else if (retention.dataRetentionDays === DATA_RETENTION_DAYS_BY_TIER.pro) {
                    dataRetentionInfo = "Pro. Allowed: last 24 months (730 days).";
                } else if (retention.dataRetentionDays === DATA_RETENTION_DAYS_BY_TIER.plus) {
                    dataRetentionInfo = "Plus. Allowed: last 6 months (180 days).";
                } else if (retention.dataRetentionDays === DATA_RETENTION_DAYS_BY_TIER.free) {
                    dataRetentionInfo = "Free. Allowed: last 3 months (90 days).";
                }
            } catch (err) {
                elizaLogger.warn(`[RegularMessageWorkflow] Data retention resolution failed: ${err}`);
            }
        }

        // Prepare image attachments for LLM if present
        const imageAttachments = state.message.content.attachments
            ? ImageProcessor.createImageContentForLLM(state.message.content.attachments)
            : undefined;

        const languageInstruction = getLanguageInstruction();

        const pendingTradingPlans = formatPendingTradingPlansContext(
            String(userId ?? ""),
            String(state.message.roomId ?? ""),
        );

        elizaLogger.info(`[RegularMessageWorkflow] Initialization complete`);

        return {
            recentMessages,
            currentDate,
            availableActions,
            imageAttachments,
            userTraits,
            pendingTradingPlans,
            dataRetentionInfo,
            languageInstruction,
            streamingResponseId: uuidv4() as UUID,
            iteration: 1,
            maxIterations: 3,
            actionResults: [],
            shouldContinue: true,
            isComplete: false,
            hasError: false,
            forceFinalResponse: false,
            startTime,
            phase: "initialized"
        };

    } catch (error: any) {
        elizaLogger.error(`[RegularMessageWorkflow] Initialization failed: ${error.message}`);
        return {
            hasError: true,
            errorMessage: `Initialization failed: ${error.message}`,
            phase: "error"
        };
    }
}

/**
 * Generate LLM response using the regular message template
 */
async function generateLLMResponse(state: RegularMessageStateType): Promise<Partial<RegularMessageStateType>> {
    elizaLogger.info(`[RegularMessageWorkflow] Generating LLM response - iteration ${state.iteration}`);

    try {
        // Format action results with structured data priority
        let actionResultsText = "";
        if (state.actionResults.length > 0) {
            actionResultsText = state.actionResults.map((result, index) => {
                let formattedResult = "";

                // Priority 1: actionData (structured data for LLM)
                if (result.actionData && typeof result.actionData === 'object') {
                    elizaLogger.info(`[RegularMessageWorkflow] Formatting actionData for iteration ${state.iteration} - structured data available for LLM`);
                    try {
                        // Filter out UI-only metadata fields that LLM doesn't need
                        const { chartPath, chartPaths, ...cleanActionData } = result.actionData as any;
                        formattedResult = `Action: ${result.action}\nData: ${JSON.stringify(cleanActionData, null, 2)}`;
                        elizaLogger.debug(`[RegularMessageWorkflow] Formatted actionData (filtered):`, cleanActionData);
                    } catch (e) {
                        formattedResult = `Action: ${result.action}\nData: [Failed to serialize actionData]`;
                    }
                }
                // Priority 2: Full result object with metadata
                else if (result.text || result.summary) {
                    formattedResult = `Action: ${result.action}\nResult: ${result.text || result.summary}`;

                    // Include error information if present
                    if (result.error) {
                        formattedResult += `\nError: ${result.error}`;
                    }
                }
                // Priority 3: Fallback to action name
                else {
                    formattedResult = `Action: ${result.action}\nStatus: ${result.metadata?.success ? 'Completed' : 'Failed'}`;
                }

                // Add execution metadata for context
                if (result.metadata?.executionTime) {
                    formattedResult += `\n[Executed at iteration ${result.metadata.iterationNumber || index + 1}]`;
                }

                return formattedResult;
            }).join('\n\n---\n\n');
        } else {
            elizaLogger.info(`[RegularMessageWorkflow] ℹ️ No action results to format for iteration ${state.iteration}`);
        }

        // Choose template based on iteration - code-level control
        const isMaxIteration = state.iteration >= state.maxIterations;
        const template = isMaxIteration
            ? getFinalResponseTemplate()
            : getRegularMessageTemplate();

        elizaLogger.info(`[RegularMessageWorkflow] Using template: ${isMaxIteration ? 'FINAL_RESPONSE' : 'REGULAR'} (iteration ${state.iteration}/${state.maxIterations})`);

        // Prepare context for response generation
        const { system, prompt } = composeContextSplit({
            state: {
                userMessage: state.message.content.text || "",
                agentName: state.runtime.character.name,
                bio: "",
                recentMessages: state.recentMessages,
                messageDirections: "",
                currentDate: state.currentDate,
                actionResults: actionResultsText,
                availableActions: state.availableActions,
                userTraits: state.userTraits || "",
                pendingTradingPlans: state.pendingTradingPlans || "",
                dataRetentionInfo: state.dataRetentionInfo || "Free. Allowed: last 3 months (90 days).",
                languageInstruction: state.languageInstruction || "",
                lore: "",
                postDirections: "",
                actors: "",
                goals: "",
                roomId: state.message.roomId,
                recentMessagesData: []
            },
            template
        });

        elizaLogger.debug(`[RegularMessageWorkflow] Generating response`);

        const stopBeforeCall = stopIfRequested(state, "before model call");
        if (stopBeforeCall) {
            return stopBeforeCall;
        }

        const streamingId = state.streamingResponseId ?? (uuidv4() as UUID);
        let partialText = "";
        let lastSentAt = 0;
        let lastSentLength = 0;
        let streamDecision: "pending" | "allow" | "block" = "pending";
        let pendingBuffer = "";
        const minBufferForDecision = 64;

        const emitPartialResponse = (force = false) => {
            if (!state.intermediateResponseCallback) {
                return;
            }
            if (partialText.length === 0) {
                return;
            }

            const now = Date.now();
            const shouldSend = force ||
                (partialText.length - lastSentLength >= 24) ||
                (now - lastSentAt >= 120);

            if (!shouldSend) {
                return;
            }

            const partialMemory: Memory = {
                id: streamingId,
                userId: state.runtime.agentId,
                agentId: state.runtime.agentId,
                roomId: state.message.roomId,
                createdAt: now,
                content: {
                    text: normalizeResponseNewlines(partialText),
                    action: null,
                    source: "regular_message",
                    inReplyTo: state.message.id,
                    actionResults: state.actionResults,
                    markdown: true,
                    metadata: {
                        responseFormat: "markdown",
                        isMarkdownFormatted: true,
                        streaming: true
                    }
                }
            };

            state.intermediateResponseCallback(partialMemory);
            lastSentAt = now;
            lastSentLength = partialText.length;
        };

        const shouldStreamTokens = state.runtime.modelProvider === ModelProviderName.GOOGLE;
        const isActionJsonPrefix = (text: string): boolean => {
            const trimmed = text.trimStart();
            if (!trimmed) {
                return false;
            }
            const normalized = trimmed.toLowerCase();
            if (normalized.startsWith("```json")) {
                return true;
            }
            if (trimmed.startsWith("{") && /"action"\s*:/i.test(trimmed)) {
                return true;
            }
            return false;
        };

        // Generate response
        const response = await generateText({
            runtime: state.runtime,
            system,
            prompt,
            modelClass: ModelClass.MEDIUM,
            imageAttachments: state.imageAttachments,
            userId: state.message.userId,
            onToken: shouldStreamTokens
                ? async (delta: string) => {
                    // Forward every raw delta to the external SSE listener if
                    // one was wired in (no buffering, no JSON-aware filtering
                    // — the client decides how to render). This is what makes
                    // tokens reach the browser as they arrive instead of
                    // batched at end-of-stream.
                    try {
                        state.onToken?.(delta);
                    } catch (err) {
                        elizaLogger.debug("[RegularMessageWorkflow] external onToken threw", err);
                    }

                    if (streamDecision === "pending") {
                        pendingBuffer += delta;

                        if (isActionJsonPrefix(pendingBuffer)) {
                            streamDecision = "block";
                            return;
                        }

                        if (pendingBuffer.length >= minBufferForDecision) {
                            streamDecision = "allow";
                            partialText = pendingBuffer;
                            pendingBuffer = "";
                            emitPartialResponse(true);
                            return;
                        }

                        return;
                    }

                    if (streamDecision === "block") {
                        return;
                    }

                    partialText += delta;
                    emitPartialResponse(false);
                }
                : undefined,
        });

        emitPartialResponse(true);

        const stopAfterCall = stopIfRequested(state, "after model call");
        if (stopAfterCall) {
            return stopAfterCall;
        }

        elizaLogger.debug(`[RegularMessageWorkflow] Response generated`);

        return {
            llmResponse: response,
            streamingResponseId: streamingId,
            phase: "response_generated"
        };

    } catch (error: any) {
        elizaLogger.error(`[RegularMessageWorkflow] LLM response generation failed: ${error.message}`);
        return {
            hasError: true,
            errorMessage: `LLM response generation failed: ${error.message}`,
            phase: "error"
        };
    }
}

/**
 * Parse LLM response to detect action calls vs final text response
 */
async function parseResponse(state: RegularMessageStateType): Promise<Partial<RegularMessageStateType>> {
    elizaLogger.info(`[RegularMessageWorkflow] Parsing response`);

    try {
        const rawResponse = state.llmResponse || "";

        // Log the raw LLM response for each iteration
        elizaLogger.info(`[RegularMessageWorkflow] 📋 Iteration ${state.iteration} - LLM Raw Response:\n${rawResponse}`);

        // Try to extract JSON from response
        const jsonMatch = rawResponse.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
            const parsed = parseJSONObjectFromText(jsonMatch[1]);

            // Log the parsed JSON object
            if (parsed) {
                elizaLogger.info(`[RegularMessageWorkflow] 🔍 Iteration ${state.iteration} - Parsed JSON:\n${JSON.stringify(parsed, null, 2)}`);
            }

            // Check for Option A: Action call format
            if (parsed && parsed.action && parsed.parameters) {
                // Validation: If at max iterations, force final response instead of action
                if (state.iteration >= state.maxIterations) {
                    elizaLogger.warn(`[RegularMessageWorkflow] LLM returned action at max iterations - forcing final response`);
                    return {
                        parsedResponse: {
                            isAction: false,
                            text: "I've gathered information but reached the iteration limit. Please try asking your question again with more specific details."
                        },
                        llmResponse: "I've gathered information but reached the iteration limit. Please try asking your question again with more specific details.",
                        forceFinalResponse: true,
                        phase: "forced_final_response"
                    };
                }

                elizaLogger.info(`[RegularMessageWorkflow] Action detected: ${parsed.action}`);
                return {
                    parsedResponse: { isAction: true, actionCall: parsed },
                    phase: "action_detected"
                };
            }

            // Check for Option B: Final response format
            if (parsed && parsed.response) {
                elizaLogger.info(`[RegularMessageWorkflow] Final response detected in JSON format`);
                return {
                    parsedResponse: { isAction: false, text: parsed.response },
                    llmResponse: parsed.response,
                    phase: "final_response_detected"
                };
            }
        }

        const parsedJson = parseJSONObjectFromText(rawResponse.trim());

        // Log the parsed JSON object (for responses without code blocks)
        if (parsedJson) {
            elizaLogger.info(`[RegularMessageWorkflow] 🔍 Iteration ${state.iteration} - Parsed JSON (raw):\n${JSON.stringify(parsedJson, null, 2)}`);
        }

        // Check for Option A: Action call format
        if (parsedJson && parsedJson.action && parsedJson.parameters) {
            // Validation: If at max iterations, force final response instead of action
            if (state.iteration >= state.maxIterations) {
                elizaLogger.warn(`[RegularMessageWorkflow] LLM returned action (raw JSON) at max iterations - forcing final response`);
                return {
                    parsedResponse: {
                        isAction: false,
                        text: "I've gathered information but reached the iteration limit. Please try asking your question again with more specific details."
                    },
                    llmResponse: "I've gathered information but reached the iteration limit. Please try asking your question again with more specific details.",
                    forceFinalResponse: true,
                    phase: "forced_final_response"
                };
            }

            elizaLogger.info(`[RegularMessageWorkflow] Action detected from raw JSON response: ${parsedJson.action}`);
            return {
                parsedResponse: { isAction: true, actionCall: parsedJson },
                phase: "action_detected"
            };
        }

        // Check for Option B: Final response format
        if (parsedJson && parsedJson.response) {
            elizaLogger.info(`[RegularMessageWorkflow] Final response detected from raw JSON`);
            return {
                parsedResponse: { isAction: false, text: parsedJson.response },
                llmResponse: parsedJson.response,
                phase: "final_response_detected"
            };
        }

        // If no valid JSON action call found, treat as direct text response
        elizaLogger.info(`[RegularMessageWorkflow] Final text response detected`);
        return {
            parsedResponse: { isAction: false, text: rawResponse },
            llmResponse: rawResponse,
            phase: "final_response_detected"
        };

    } catch (error: any) {
        elizaLogger.debug(`[RegularMessageWorkflow] Failed to parse JSON, treating as text response: ${error.message}`);
        const fallbackText = state.llmResponse || "";
        return {
            parsedResponse: { isAction: false, text: fallbackText },
            llmResponse: fallbackText,
            phase: "fallback_text_response"
        };
    }
}

/**
 * Execute action and capture results
 */
async function executeAction(state: RegularMessageStateType): Promise<Partial<RegularMessageStateType>> {
    const actionCall = state.parsedResponse.actionCall;
    elizaLogger.info(`[RegularMessageWorkflow] Executing action: ${actionCall.action}`);

    try {
        // Find the action in non-trading actions
        const action = getNonCEXActions(state.runtime).find(
            (a: Action) => a.name === actionCall.action
        );
        if (!action) {
            throw new Error(`Action not found: ${actionCall.action}`);
        }

        // Resolve data retention by subscription/anonymous for date-range actions
        const dataRetention = await getDataRetentionConfig(state.runtime, state.message.userId);

        // Create memory for action execution
        const actionMemory: Memory = {
            id: uuidv4() as UUID,
            userId: state.runtime.agentId,
            agentId: state.runtime.agentId,
            content: {
                text: state.message.content.text || `Execute ${actionCall.action}`,
                action: actionCall.action,
                ...actionCall.parameters
            },
            roomId: state.message.roomId,
            createdAt: Date.now()
        };

        const controller = new AbortController();

        const result = await new Promise((resolve, reject) => {
            let callbackResult: any = null;
            let callbackCalled = false;

            // Create callback function for actions that use callbacks
            const callback: HandlerCallback = async (content: any) => {
                elizaLogger.info(`[RegularMessageWorkflow] Action callback received for ${actionCall.action}`);

                // Enhance content with action metadata
                const enhancedContent = {
                    ...content,
                    metadata: {
                        ...content.metadata,
                        isActionResponse: true,
                        actionName: actionCall.action,
                        success: true
                    }
                };

                // Store the enhanced result
                callbackResult = enhancedContent;
                callbackCalled = true;

                // Capture actionData from metadata if present
                if (enhancedContent.metadata?.actionData) {
                    elizaLogger.info(`[RegularMessageWorkflow] Captured actionData from callback metadata for ${actionCall.action}`);
                    callbackResult.actionData = enhancedContent.metadata.actionData;
                }

                resolve(callbackResult);
                return [];
            };

            // Execute the action handler
            const actionParameters = { ...actionCall.parameters, ...dataRetention, signal: controller.signal };

            const handlerPromise = action.handler(state.runtime, actionMemory, {
                roomId: state.message.roomId,
                agentId: state.runtime.agentId,
                bio: "",
                lore: "",
                messageDirections: "",
                postDirections: "",
                actors: "",
                goals: "",
                recentMessages: "",
                recentMessagesData: []
            }, actionParameters, callback);

            handlerPromise
                .then((handlerResult) => {
                    // Capture structured data from action return
                    if (handlerResult && typeof handlerResult === 'object') {
                        elizaLogger.info(`[RegularMessageWorkflow] Action ${actionCall.action} returned structured data`);

                        // Store the data in callback result for subsequent use
                        if (callbackResult) {
                            callbackResult.actionData = handlerResult;
                        }

                        // If it has display content, use it directly
                        if ((handlerResult as any).text || (handlerResult as any).content) {
                            const enhancedResult = {
                                ...handlerResult,
                                actionData: handlerResult,
                                metadata: {
                                    // Merge callback metadata first (contains UI data like chartPath)
                                    ...(callbackResult?.metadata || {}),
                                    // Then merge action return metadata
                                    ...((handlerResult as any).metadata || {}),
                                    isActionResponse: true,
                                    actionName: actionCall.action,
                                    success: true
                                }
                            };
                            resolve(enhancedResult);
                            return;
                        }
                    }

                    // If callback wasn't called, use handler result (legacy pattern)
                    if (!callbackCalled) {
                        elizaLogger.info(`[RegularMessageWorkflow] Using handler result for ${actionCall.action}`);
                        const result = (typeof handlerResult === 'object' && handlerResult !== null ? handlerResult : {}) as any;

                        const enhancedResult = {
                            ...result,
                            actionData: handlerResult,
                            text: result.text || `Action ${actionCall.action} completed`,
                            metadata: {
                                // Merge callback metadata first
                                ...(callbackResult?.metadata || {}),
                                // Then merge action return metadata
                                ...(result.metadata || {}),
                                isActionResponse: true,
                                actionName: actionCall.action,
                                success: !!handlerResult
                            }
                        };
                        resolve(enhancedResult);
                    }
                    // Callback was already called and resolved, no additional action needed
                })
                .catch(reject);

            // Timeout fallback
            setTimeout(() => {
                if (!callbackCalled) {
                    elizaLogger.warn(`[RegularMessageWorkflow] Action ${actionCall.action} timed out after 5 minutes`);
                    controller.abort();
                    reject(new Error(`Action ${actionCall.action} timed out`));
                }
            }, 300000); // 5 minutes (5 * 60 * 1000)
        });

        // Store enhanced action result with full metadata for next iteration
        const enhancedActionResult = {
            action: actionCall.action,
            parameters: actionCall.parameters,
            ...(result && typeof result === 'object' ? result : {}),
            // Ensure we preserve actionData and metadata for LLM consumption
            actionData: (result as any)?.actionData,
            metadata: {
                ...((result as any)?.metadata || {}),
                // Track execution context for better LLM understanding
                executionTime: Date.now(),
                iterationNumber: state.iteration,
                success: true
            }
        };

        const updatedActionResults = [...state.actionResults, enhancedActionResult];

        elizaLogger.success(`[RegularMessageWorkflow] Action completed`);

        const directResponseText =
            actionCall.action === "Sentiment_Analysis"
                ? (result as any)?.text
                : undefined;

        if (directResponseText) {
            return {
                actionResults: updatedActionResults,
                parsedResponse: { isAction: false, text: directResponseText },
                llmResponse: directResponseText,
                shouldContinue: false,
                forceFinalResponse: true,
                phase: "action_completed"
            };
        }

        return {
            actionResults: updatedActionResults,
            phase: "action_completed"
        };

    } catch (actionError: any) {
        elizaLogger.error(`[RegularMessageWorkflow] Action failed: ${actionError.message}`);

        // Store enhanced error result with metadata
        const errorResult = {
            action: actionCall.action,
            parameters: actionCall.parameters,
            text: `Action failed: ${actionError.message}`,
            error: actionError.message,
            actionData: null,
            metadata: {
                isActionResponse: true,
                actionName: actionCall.action,
                success: false,
                executionTime: Date.now(),
                iterationNumber: state.iteration,
                errorType: actionError.name || 'ActionExecutionError'
            }
        };

        const updatedActionResults = [...state.actionResults, errorResult];

        return {
            actionResults: updatedActionResults,
            phase: "action_failed"
        };
    }
}

/**
 * Check if workflow should continue with another iteration
 */
async function checkContinuation(state: RegularMessageStateType): Promise<Partial<RegularMessageStateType>> {
    elizaLogger.info(`[RegularMessageWorkflow] Checking continuation - iteration ${state.iteration} of ${state.maxIterations}`);

    const shouldContinue = !state.forceFinalResponse && state.iteration < state.maxIterations;

    if (shouldContinue) {
        elizaLogger.info(`[RegularMessageWorkflow] Continuing to iteration ${state.iteration + 1}`);
        return {
            iteration: state.iteration + 1,
            shouldContinue: true,
            phase: "continuing"
        };
    } else {
        elizaLogger.info(`[RegularMessageWorkflow] Reached max iterations, proceeding to final response`);
        return {
            shouldContinue: false,
            phase: "max_iterations_reached"
        };
    }
}

/**
 * Normalize literal escape sequences in LLM response text.
 * Some models output double-escaped \\n in JSON (e.g. "line1\\nline2"), so after parse we get
 * the two characters \ and n instead of a real newline. This converts them for correct markdown rendering.
 */
function normalizeResponseNewlines(text: string): string {
    if (typeof text !== "string" || !text.length) return text;
    return text
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t");
}

/**
 * Create final response memory object
 */
async function createFinalResponse(state: RegularMessageStateType): Promise<Partial<RegularMessageStateType>> {
    elizaLogger.info(`[RegularMessageWorkflow] Creating final response`);

    try {
        const rawFinalText = state.parsedResponse?.text || state.llmResponse?.trim() || "Hello! How can I help you today?";
        const finalText = normalizeResponseNewlines(rawFinalText);
        const responseId = state.streamingResponseId ?? (uuidv4() as UUID);

        // Extract chart path from action results for frontend display
        let extractedChartPath: string | undefined;
        if (state.actionResults.length > 0) {
            // Look for the most recent successful action with a chart path
            for (let i = state.actionResults.length - 1; i >= 0; i--) {
                const result = state.actionResults[i];

                // Check metadata.chartPath first
                if (result.metadata?.chartPath) {
                    extractedChartPath = result.metadata.chartPath;
                    elizaLogger.info(`[RegularMessageWorkflow] Found chartPath in metadata: ${extractedChartPath}`);
                    break;
                }

                // Check actionData.chartPath as fallback
                if (result.actionData?.chartPath) {
                    extractedChartPath = result.actionData.chartPath;
                    elizaLogger.info(`[RegularMessageWorkflow] Found chartPath in actionData: ${extractedChartPath}`);
                    break;
                }
            }
        }

        // Upload local chart to S3 so the URL survives ECS redeploys
        if (extractedChartPath && !extractedChartPath.startsWith('/s3-files/') && !extractedChartPath.startsWith('http')) {
            const storageService = (state.runtime as any).fileStorageService;
            if (storageService) {
                try {
                    const absPath = path.resolve(process.cwd(), extractedChartPath);
                    if (fs.existsSync(absPath)) {
                        const content = fs.readFileSync(absPath);
                        const filename = path.basename(extractedChartPath).replace(/\s+/g, '-').toLowerCase();
                        const s3Key = storageService.buildKey({
                            type: 'chart',
                            agentId: state.runtime.agentId,
                            userId: 'system',
                            date: new Date().toISOString().split('T')[0],
                            filename,
                        });
                        extractedChartPath = await storageService.saveFile({
                            content,
                            s3Key,
                            contentType: 'text/html',
                            localCachePath: absPath,
                        });
                        elizaLogger.info(`[RegularMessageWorkflow] Uploaded chart to S3: ${extractedChartPath}`);
                    }
                } catch (err) {
                    elizaLogger.warn(`[RegularMessageWorkflow] Chart S3 upload failed, keeping local path: ${err}`);
                }
            }
        }

        const messageMetadata = (state.message.content?.metadata && typeof state.message.content.metadata === 'object')
            ? state.message.content.metadata as Record<string, unknown>
            : {};

        const classificationMetadata = {
            classification: messageMetadata.classification,
            classificationConfidence: messageMetadata.classificationConfidence,
            classificationReasoning: messageMetadata.classificationReasoning,
            isCryptoRelated: messageMetadata.isCryptoRelated
        };

        // Create response memory with chart metadata
        const responseMemory: Memory = {
            id: responseId,
            userId: state.runtime.agentId,
            agentId: state.runtime.agentId,
            roomId: state.message.roomId,
            createdAt: Date.now(),
            content: {
                text: finalText,
                action: null,
                source: "regular_message",
                inReplyTo: state.message.id,
                actionResults: state.actionResults,
                markdown: true,
                metadata: {
                    responseFormat: 'markdown',
                    isMarkdownFormatted: true,
                    success: true,
                    hasActionResults: state.actionResults.length > 0,
                    iterationCount: state.iteration,
                    ...(extractedChartPath && { chartPath: extractedChartPath }),
                    ...(classificationMetadata.classification ? classificationMetadata : {})
                }
            }
        };

        // Lift the agent-emitted `## Key Findings` section onto
        // `content.metadata.summary` so follow-up turns can use the compact
        // form instead of the full body. No-op when the model didn't emit a
        // section (e.g. trivial greeting replies).
        const responseMemoryWithSummary = attachResponseSummary(responseMemory, {
            route: "regular",
        });

        // Store the response in database
        await state.runtime.messageManager.createMemory(responseMemoryWithSummary);

        elizaLogger.info(`[RegularMessageWorkflow] Response completed`);

        return {
            finalResponse: responseMemoryWithSummary,
            chartPath: extractedChartPath,
            isComplete: true,
            phase: "completed"
        };

    } catch (error: any) {
        elizaLogger.error(`[RegularMessageWorkflow] Failed to create final response: ${error.message}`);
        return {
            hasError: true,
            errorMessage: `Failed to create final response: ${error.message}`,
            phase: "error"
        };
    }
}

/**
 * Handle workflow errors and create fallback response
 */
async function handleWorkflowError(state: RegularMessageStateType): Promise<Partial<RegularMessageStateType>> {
    elizaLogger.error(`[RegularMessageWorkflow] Handling workflow error: ${state.errorMessage}`);

    try {
        const errorText = state.iteration >= state.maxIterations
            ? "I've gathered some information but reached my processing limit. How else can I help you?"
            : "I'm having a moment of technical difficulty. Please try again!";

        // Create error response
        const errorMemory: Memory = {
            id: uuidv4() as UUID,
            userId: state.runtime.agentId,
            agentId: state.runtime.agentId,
            roomId: state.message.roomId,
            createdAt: Date.now(),
            content: {
                text: errorText,
                action: null,
                source: "regular_message",
                inReplyTo: state.message.id,
                actionResults: state.actionResults || [],
                markdown: true,
                error: {
                    type: "REGULAR_MESSAGE_WORKFLOW_ERROR",
                    message: "Regular message workflow processing failed",
                    originalError: state.errorMessage,
                    phase: state.phase
                },
                metadata: {
                    responseFormat: 'markdown',
                    isMarkdownFormatted: true,
                    success: false,
                    hasActionResults: (state.actionResults || []).length > 0,
                    iterationCount: state.iteration || 0,
                    fallbackReason: state.iteration >= state.maxIterations ? 'max_iterations_reached' : 'workflow_error'
                }
            }
        };

        await state.runtime.messageManager.createMemory(errorMemory);

        return {
            finalResponse: errorMemory,
            isComplete: true,
            phase: "error_handled"
        };

    } catch (memoryError: any) {
        elizaLogger.error(`[RegularMessageWorkflow] Failed to save error memory: ${memoryError.message}`);

        // Return minimal error state if we can't even save to database
        return {
            finalResponse: {
                id: uuidv4() as UUID,
                userId: state.runtime.agentId,
                agentId: state.runtime.agentId,
                roomId: state.message.roomId,
                createdAt: Date.now(),
                content: {
                    text: "I'm experiencing technical difficulties. Please try again.",
                    action: null,
                    source: "regular_message",
                    error: {
                        type: "CRITICAL_WORKFLOW_ERROR",
                        message: "Critical workflow failure"
                    }
                }
            } as Memory,
            isComplete: true,
            phase: "critical_error"
        };
    }
}

/**
 * Create the LangGraph workflow
 */
function createRegularMessageWorkflow() {
    const workflow = new StateGraph(RegularMessageState)
        .addNode("initialize", initializeWorkflow)
        .addNode("generateResponse", generateLLMResponse)
        .addNode("parseResponse", parseResponse)
        .addNode("executeAction", executeAction)
        .addNode("checkContinuation", checkContinuation)
        .addNode("createFinalResponse", createFinalResponse)
        .addNode("handleError", handleWorkflowError)

        // Flow: Start -> Initialize -> Generate Response -> Parse Response
        .addEdge("__start__", "initialize")
        .addConditionalEdges("initialize", (state: RegularMessageStateType) => {
            return state.hasError ? "handleError" : "generateResponse";
        })
        .addConditionalEdges("generateResponse", (state: RegularMessageStateType) => {
            return state.hasError ? "handleError" : "parseResponse";
        })

        // Parse Response -> Execute Action OR Create Final Response
        .addConditionalEdges("parseResponse", (state: RegularMessageStateType) => {
            if (state.hasError) return "handleError";
            if (state.parsedResponse?.isAction && state.iteration < state.maxIterations) {
                return "executeAction";
            }
            return "createFinalResponse";
        })

        // Execute Action -> Check Continuation
        .addConditionalEdges("executeAction", (state: RegularMessageStateType) => {
            return state.hasError ? "handleError" : "checkContinuation";
        })

        // Check Continuation -> Generate Response OR Create Final Response
        .addConditionalEdges("checkContinuation", (state: RegularMessageStateType) => {
            if (state.hasError) return "handleError";
            if (state.shouldContinue) return "generateResponse";
            return "createFinalResponse";
        })

        // End states
        .addEdge("createFinalResponse", "__end__")
        .addEdge("handleError", "__end__");

    return workflow.compile();
}

/**
 * Regular Message Workflow Service
 */
export class RegularMessageWorkflowService {
    private runtime: IAgentRuntime;
    private workflow: ReturnType<typeof createRegularMessageWorkflow>;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
        this.workflow = createRegularMessageWorkflow();
        elizaLogger.info(`[RegularMessageWorkflow] Service initialized`);
    }

    /**
     * Handle regular message using LangGraph workflow
     */
    async handleMessage(
        message: Memory,
        callback?: HandlerCallback,
        streamingCallback?: StreamingCallback,
        intermediateResponseCallback?: (response: Memory) => void,
        onToken?: (delta: string) => void,
    ): Promise<Memory[]> {
        try {
            elizaLogger.info(`[RegularMessageWorkflow] Processing message with LangGraph workflow`);

            // Execute workflow
            const langSmithMetadataEntries = Object.entries({
                runType: "regular_message",
                agentId: this.runtime.agentId,
                character: this.runtime.character?.name,
                messageId: message.id,
                roomId: message.roomId
            }).filter(([, value]) => value !== undefined && value !== null && value !== "");

            const langSmithMetadata = Object.fromEntries(langSmithMetadataEntries) as Record<string, unknown>;

            const langSmithConfig = buildLangSmithRunnableConfig({
                apiKey: this.runtime.getSetting("LANGCHAIN_API_KEY")
                    ?? this.runtime.getSetting("LANGSMITH_API_KEY")
                    ?? undefined,
                endpoint: this.runtime.getSetting("LANGCHAIN_ENDPOINT")
                    ?? this.runtime.getSetting("LANGSMITH_ENDPOINT")
                    ?? undefined,
                projectName: this.runtime.getSetting("LANGSMITH_PROJECT")
                    ?? this.runtime.getSetting("LANGCHAIN_PROJECT")
                    ?? this.runtime.character?.name
                    ?? undefined,
                runName: message.id
                    ? `regular-message:${message.id}`
                    : "regular-message-workflow",
                tags: [
                    "regular-message",
                    this.runtime.character?.name ? `agent:${this.runtime.character.name}` : undefined
                ].filter((tag): tag is string => typeof tag === "string" && tag.length > 0),
                metadata: langSmithMetadata
            });

            const workflowInput = {
                message,
                runtime: this.runtime,
                callback,
                streamingCallback,
                intermediateResponseCallback,
                onToken,
            };

            const result = langSmithConfig
                ? await this.workflow.invoke(workflowInput, langSmithConfig)
                : await this.workflow.invoke(workflowInput);

            elizaLogger.info(`[RegularMessageWorkflow] Workflow completed in ${Date.now() - result.startTime}ms`);

            if (result.finalResponse) {
                const messageMetadata = (message.content?.metadata && typeof message.content.metadata === 'object')
                    ? message.content.metadata as Record<string, unknown>
                    : {};

                const actionResultsArray = Array.isArray(result.finalResponse.content?.actionResults)
                    ? result.finalResponse.content.actionResults
                    : undefined;

                logRegularMessageOutcome({
                    agentId: this.runtime.agentId,
                    roomId: message.roomId,
                    messageId: message.id,
                    userQuestion: message.content?.text ?? "",
                    actionResults: actionResultsArray,
                    finalResponse: result.finalResponse,
                    classification: {
                        type: messageMetadata.classification as string | undefined,
                        confidence: typeof messageMetadata.classificationConfidence === 'number'
                            ? messageMetadata.classificationConfidence as number
                            : undefined,
                        reasoning: typeof messageMetadata.classificationReasoning === 'string'
                            ? messageMetadata.classificationReasoning as string
                            : undefined,
                        isCryptoRelated: typeof messageMetadata.isCryptoRelated === 'boolean'
                            ? messageMetadata.isCryptoRelated as boolean
                            : undefined
                    }
                });
            }

            // Handle callbacks
            if (intermediateResponseCallback && result.finalResponse) {
                intermediateResponseCallback(result.finalResponse);
            }

            if (callback && result.finalResponse) {
                await callback({
                    text: result.finalResponse.content.text,
                    action: result.finalResponse.content.action,
                    source: result.finalResponse.content.source,
                    actionResults: result.finalResponse.content.actionResults || [],
                    markdown: result.finalResponse.content.markdown,
                    metadata: result.finalResponse.content.metadata
                });
            }

            return [result.finalResponse];

        } catch (error: any) {
            elizaLogger.error(`[RegularMessageWorkflow] Workflow execution failed:`, error);

            // Create fallback error response
            const errorMemory: Memory = {
                id: uuidv4() as UUID,
                userId: this.runtime.agentId,
                agentId: this.runtime.agentId,
                roomId: message.roomId,
                createdAt: Date.now(),
                content: {
                    text: "I'm experiencing technical difficulties. Please try again.",
                    action: null,
                    source: "regular_message",
                    inReplyTo: message.id,
                    error: {
                        type: "WORKFLOW_EXECUTION_ERROR",
                        message: "LangGraph workflow execution failed",
                        originalError: error.message,
                        stack: error.stack
                    }
                }
            };

            try {
                await this.runtime.messageManager.createMemory(errorMemory);

                if (intermediateResponseCallback) {
                    intermediateResponseCallback(errorMemory);
                }
            } catch (memoryError: any) {
                elizaLogger.error(`[RegularMessageWorkflow] Failed to save error memory: ${memoryError.message}`);
            }

            return [errorMemory];
        }
    }

    /**
     * Get workflow for debugging
     */
    public getWorkflow() {
        return this.workflow;
    }
}

// Global workflow service instance
let workflowService: RegularMessageWorkflowService | null = null;

/**
 * Main export function - maintains the same interface as the original handler
 */
export async function handleRegularMessage(
    runtime: IAgentRuntime,
    message: Memory,
    callback?: HandlerCallback,
    streamingCallback?: StreamingCallback,
    intermediateResponseCallback?: (response: Memory) => void,
    onToken?: (delta: string) => void,
): Promise<Memory[]> {
    // Initialize workflow service if not already done
    if (!workflowService) {
        workflowService = new RegularMessageWorkflowService(runtime);
    }

    // Delegate to workflow service
    return workflowService.handleMessage(message, callback, streamingCallback, intermediateResponseCallback, onToken);
}
