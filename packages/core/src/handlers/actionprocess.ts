import type { Memory, State, HandlerCallback, StreamingCallback, ProcessingStep, UUID, Content, Action } from "../core/types.ts";
import { v4 as uuidv4 } from "uuid";
import { elizaLogger } from "../utils/logger.ts";
import { getDataRetentionConfig } from "../utils/dataRetention.ts";
import { cpus } from "os";
import { ActionCacheManager } from "../data/actionCacheManager.ts";

/** Appended to action result when date range was clamped by subscription tier (dataRetentionApplied). */
const DATA_RETENTION_DISCLAIMER =
    "\n\n*The date range was limited to user's plan's data retention window. Results reflect data within the allowed period only; this is not an action error and there is no need to retry for a different date range.*";

export async function processActions(
    message: Memory,
    responses: Memory[],
    state?: State,
    callback?: HandlerCallback,
    streamingCallback?: StreamingCallback,
    onToken?: (delta: string) => void | Promise<void>,
): Promise<{ success: boolean; error?: string; errorDetails?: any }> {
    // Reset stop flag at the start of new processing
    this.resetStopFlag();
    
    // Clean up old execution tracking entries
    this.cleanupActionExecutionTracker();
    
    const addStep = (name: string, status: ProcessingStep['status'], message: string, data?: any, error?: string) => {
        if (streamingCallback) {
            streamingCallback({
                id: uuidv4(),
                name,
                status,
                message,
                timestamp: Date.now(),
                data,
                error
            });
        }
    };

    try {
        for (const response of responses) {
            // Check if processing should be stopped
            if (this.shouldStop()) {
                elizaLogger.info("🛑 Processing stopped by user request");
                addStep('processing', 'error', '🛑 Processing stopped by user');
                return { 
                    success: false, 
                    error: "Processing stopped by user", 
                    errorDetails: { type: "USER_STOPPED", message: "Processing was stopped by user request" } 
                };
            }
            
            // Handle both single action (string) and multiple actions (array)
            const actionContent = response.content?.action;
            if (!actionContent) {
                elizaLogger.warn("No action found in the response content.");
                continue;
            }

            // Convert to array to support both single action and multiple actions
            let actions = Array.isArray(actionContent) ? actionContent : [actionContent];
            
            // Sort actions to ensure prediction actions execute last
            actions = actions.sort((a, b) => {
                const getActionName = (action: any): string => {
                    return typeof action === 'string' ? action : 
                           (typeof action === 'object' && action !== null && 'name' in action) ? 
                           (action as any).name || '' : '';
                };
                
                const aName = getActionName(a).toLowerCase();
                const bName = getActionName(b).toLowerCase();
                
                const aIsPrediction = aName.includes('prediction') || aName.includes('predict');
                const bIsPrediction = bName.includes('prediction') || bName.includes('predict');
                
                // If one is prediction and other is not, prediction goes last
                if (aIsPrediction && !bIsPrediction) return 1;
                if (!aIsPrediction && bIsPrediction) return -1;
                
                // Otherwise maintain original order
                return 0;
            });
            
            if (actions.length > 1) {
                const actionNames = actions.map(a => 
                    typeof a === 'string' ? a : 
                    (typeof a === 'object' && a !== null && 'name' in a) ? (a as any).name || 'unknown' : 
                    'unknown'
                );
                elizaLogger.info(`Processing multiple actions (${actions.length}): ${actionNames.join(', ')}`);
            }
            
            addStep('action_discovery', 'in_progress', `🎯 Found ${actions.length} thing${actions.length === 1 ? '' : 's'} to do for you!`);
            
            // Track executed actions for potential summary
            const executedActions: string[] = [];
            
            // Process actions with concurrency limit and delays
            const actionPromises = actions.map(async (actionItem, index) => {
                // Add delay between actions to prevent API rate limiting
                if (index > 0) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                
                return executeActionWithRetry(async () => {
                // Check if processing should be stopped before starting action
                if (this.shouldStop()) {
                    elizaLogger.info("🛑 Action processing stopped by user request");
                    throw new Error("Processing stopped by user");
                }
                
                // Handle both simple string actions and complex action objects with parameters and targets
                let actionName: string;
                let actionTarget: string | null = null;
                let actionParameters: any = {};
                
                if (typeof actionItem === 'string') {
                    actionName = actionItem;
                } else if (typeof actionItem === 'object' && actionItem !== null && 'name' in actionItem) {
                    actionName = (actionItem as any).name;
                    actionTarget = (actionItem as any).target || null;
                    actionParameters = (actionItem as any).parameters || {};
                    elizaLogger.info(`Complex action detected: ${actionName} for target: ${actionTarget} with parameters:`, actionParameters);
                } else {
                    elizaLogger.warn(`Invalid action format:`, actionItem);
                    return { success: false, error: 'Invalid action format', actionName: 'unknown' };
                }
                
                const normalizedAction = actionName
                    .toLowerCase()
                    .replaceAll("_", "");

                elizaLogger.success(`Normalized action: ${normalizedAction}${actionTarget ? ` (target: ${actionTarget})` : ''}`);
                addStep('action_lookup', 'in_progress', `🔍 Getting ready to ${actionName.toLowerCase().replace('_', ' ')}${actionTarget ? ` for ${actionTarget}` : ''}...`);

                const action = this.actions.find(
                    (a: { name: string }) =>
                        a.name
                            .toLowerCase()
                            .replaceAll("_", "")
                            .includes(normalizedAction) ||
                        normalizedAction.includes(
                            a.name.toLowerCase().replaceAll("_", ""),
                        ),
                );

                if (!action) {
                    const errorMsg = `No action found for: ${actionName}${actionTarget ? ` (target: ${actionTarget})` : ''}`;
                    elizaLogger.error(errorMsg);
                    addStep('action_lookup', 'error', `❌ Hmm, I don't know how to ${actionName.toLowerCase().replace('_', ' ')} yet`);
                    
                    return {
                        success: false,
                        error: errorMsg,
                        errorDetails: {
                            type: "ACTION_NOT_FOUND",
                            message: errorMsg,
                            requestedAction: actionName,
                            requestedTarget: actionTarget,
                            requestedParameters: actionParameters,
                            availableActions: this.actions.map(a => a.name)
                        },
                        actionName
                    };
                }

                if (!action.handler) {
                    const errorMsg = `Action ${action.name} has no handler`;
                    elizaLogger.error(errorMsg);
                    addStep('action_lookup', 'error', `❌ Found the ${action.name.toLowerCase().replace('_', ' ')} action but it's not working right now`);
                    
                    return {
                        success: false,
                        error: errorMsg,
                        errorDetails: {
                            type: "ACTION_NO_HANDLER",
                            message: errorMsg,
                            actionName: action.name
                        },
                        actionName: action.name
                    };
                }

                try {
                    // Create a unique key for this action execution
                    const executionKey = `${action.name}_${message.id}_${message.userId}`;
                    const lastExecution = this.actionExecutionTracker.get(executionKey);
                    const now = Date.now();

                    // Check if this action was recently executed for this message
                    // Duplicate execution check disabled - allowing all action executions
                    // if (lastExecution && (now - lastExecution) < this.ACTION_EXECUTION_COOLDOWN) {
                    //     elizaLogger.warn(
                    //         `Skipping duplicate execution of action: ${action.name} (executed ${Math.round((now - lastExecution) / 1000)}s ago)`
                    //     );
                    //     addStep('action_execute', 'completed', `Skipped duplicate execution of ${action.name}`);
                    //     return { success: true, actionName: action.name, skipped: true };
                    // }

                    // Search for cached results if action has cacheConfig enabled
                    const typedAction = action as Action;
                    if (typedAction.cacheConfig?.enabled) {
                        try {
                            const cacheManager = new ActionCacheManager(this);
                            const queryText = actionTarget
                                ? `${message.content.text} target:${actionTarget}`
                                : message.content.text;

                            const cachedResults = await cacheManager.searchSimilarResults(queryText, {
                                actionName: action.name,
                                similarityThreshold: typedAction.cacheConfig.similarityThreshold || 0.7,
                                limit: 3,
                            });

                            if (cachedResults.length > 0) {
                                elizaLogger.info(`Found ${cachedResults.length} cached results for action ${action.name}`);

                                // Inject cached results into state for context
                                if (state) {
                                    state.actionCacheContext = [
                                        ...(state.actionCacheContext || []),
                                        ...cachedResults,
                                    ];
                                }
                            }
                        } catch (cacheError) {
                            elizaLogger.warn(`Failed to search action cache: ${cacheError}`);
                        }
                    }

                    elizaLogger.info(
                        `Executing handler for action: ${action.name}${actions.length > 1 ? ` (part of multi-action sequence)` : ''}`,
                    );
                    
                    addStep('action_lookup', 'completed', `✅ Ready to ${action.name.toLowerCase().replace('_', ' ')}!`);
                    addStep('action_execute', 'in_progress', `⚡ ${action.name.toLowerCase().replace('_', ' ')} in progress...`);
                    
                    // Track this execution
                    this.actionExecutionTracker.set(executionKey, now);
                    
                    // Resolve data retention by subscription/anonymous and inject into action context
                    const dataRetention = await getDataRetentionConfig(this, message.userId);
                    const actionContext = {
                        target: actionTarget,
                        parameters: actionParameters,
                        ...dataRetention,
                        ...(Object.keys(actionParameters).length > 0 && { ...actionParameters }),
                        // Forward per-token callback so the action's generateText
                        // calls can stream deltas straight to the SSE endpoint.
                        ...(onToken ? { onToken } : {}),
                    };
                    
                    // Create a wrapped callback that injects action name into responses and caches results
                    const wrappedCallback: HandlerCallback = async (response: Content, files?: any, streamingCallback?: StreamingCallback) => {

                        const dataRetentionApplied =
                            typeof response.metadata === 'object' && response.metadata !== null && (response.metadata as { dataRetentionApplied?: boolean }).dataRetentionApplied === true;
                        // When tier date limit was applied, append disclaimer so user knows it's not an action error and need not retry
                        const textWithDisclaimer =
                            dataRetentionApplied && typeof response.text === 'string' && response.text.trim()
                                ? response.text.trimEnd() + DATA_RETENTION_DISCLAIMER
                                : response.text;
                        // Inject action name into response for proper grouping
                        const enhancedResponse: Content = {
                            ...response,
                            text: textWithDisclaimer,
                            actionName: action.name,
                            metadata: {
                                ...(typeof response.metadata === 'object' && response.metadata !== null ? response.metadata : {}),
                                actionName: action.name,
                                isActionResponse: true,
                                groupType: 'action_result'
                            }
                        };

                        // Cache the result if action has cacheConfig enabled
                        const typedActionForCache = action as Action;
                        if (typedActionForCache.cacheConfig?.enabled && response.text) {
                            try {
                                const cacheManager = new ActionCacheManager(this);
                                const queryText = actionTarget
                                    ? `${message.content.text} target:${actionTarget}`
                                    : message.content.text;

                                elizaLogger.debug(`[ActionCache] Attempting to cache result for action ${action.name} (query length: ${queryText.length}, result length: ${response.text.length})`);

                                await cacheManager.cacheActionResult({
                                    actionName: action.name,
                                    query: queryText,
                                    result: response.text,
                                    ttlSeconds: typedActionForCache.cacheConfig.ttlSeconds,
                                    maxChunkSize: typedActionForCache.cacheConfig.maxChunkSize || 1000,
                                });

                                elizaLogger.info(`[ActionCache] ✅ Successfully cached result for action ${action.name} (TTL: ${typedActionForCache.cacheConfig.ttlSeconds}s)`);
                            } catch (cacheError: any) {
                                elizaLogger.error(`[ActionCache] ❌ Failed to cache action result for ${action.name}:`, {
                                    error: cacheError.message,
                                    stack: cacheError.stack,
                                    actionName: action.name,
                                    queryLength: actionTarget ? `${message.content.text} target:${actionTarget}`.length : message.content.text?.length,
                                    resultLength: response.text?.length,
                                    ttlSeconds: typedActionForCache.cacheConfig.ttlSeconds
                                });
                            }
                        } else if (typedActionForCache.cacheConfig?.enabled && !response.text) {
                            elizaLogger.debug(`[ActionCache] Skipping cache for action ${action.name}: no response.text available`);
                        }

                        // Call the original callback with enhanced response
                        if (callback) {
                            return await callback(enhancedResponse, files, streamingCallback);
                        }
                        return [];
                    };
                    
                    // Execute action with timeout protection
                    const actionOperation = () => action.handler(this, message, state, actionContext, wrappedCallback);
                    await executeWithTimeout.call(this, actionOperation, this.actionTimeoutMs, action.name);
                    addStep('action_execute', 'completed', `🎉 ${action.name.toLowerCase().replace('_', ' ')} completed${actionTarget ? ` for ${actionTarget}` : ''}!`);
                    
                    return { 
                        success: true, 
                        actionName: action.name,
                        actionTarget,
                        executedActionDisplay: `${action.name}${actionTarget ? `(${actionTarget})` : ''}`
                    };
                    
                } catch (error: any) {
                    let errorMsg: string;
                    let errorType: string;
                    let stepMessage: string;
                    
                    if (error.name === 'ActionTimeoutError') {
                        errorMsg = `Action ${action.name} timed out after ${Math.round(this.actionTimeoutMs / 1000)} seconds`;
                        errorType = "ACTION_TIMEOUT_ERROR";
                        stepMessage = `⏰ ${action.name.toLowerCase().replace('_', ' ')} took too long and was stopped`;
                        elizaLogger.warn(errorMsg);
                    } else if (error.name === 'ActionStoppedError') {
                        errorMsg = `Action ${action.name} was stopped by user request`;
                        errorType = "ACTION_STOPPED_ERROR";
                        stepMessage = `🛑 ${action.name.toLowerCase().replace('_', ' ')} was stopped by user`;
                        elizaLogger.info(errorMsg);
                    } else {
                        errorMsg = `Error executing action ${action.name}: ${error.message || error}`;
                        errorType = "ACTION_EXECUTION_ERROR";
                        stepMessage = `❌ ${action.name.toLowerCase().replace('_', ' ')} ran into trouble`;
                        elizaLogger.error(errorMsg, error);
                    }
                    
                    addStep('action_execute', 'error', stepMessage, null, error.message);
                    
                    return {
                        success: false,
                        error: errorMsg,
                        errorDetails: {
                            type: errorType,
                            message: errorMsg,
                            actionName: action.name,
                            originalError: error.message || String(error),
                            stack: error.stack || null,
                            isTimeout: error.name === 'ActionTimeoutError',
                            isStopped: error.name === 'ActionStoppedError',
                            timeoutMs: error.name === 'ActionTimeoutError' ? this.actionTimeoutMs : undefined
                        },
                        actionName: action.name
                    };
                }
                });
            });

            // Process actions with concurrency limit of 8
            const actionResults = await processActionsWithConcurrencyLimit(actionPromises, 8);
            
            // Process results and handle any errors
            let hasErrors = false;
            let firstError = null;
            
            for (const result of actionResults) {
                if (result.status === 'fulfilled') {
                    const actionResult = result.value;
                    if (actionResult.success) {
                        if (actionResult.executedActionDisplay) {
                            executedActions.push(actionResult.executedActionDisplay);
                        }
                    } else {
                        hasErrors = true;
                        if (!firstError) {
                            firstError = actionResult;
                            
                            // Create error response memory for the first error
                            let errorText = `❌ Error: ${actionResult.error}`;
                            
                            if (actionResult.errorDetails?.type === "ACTION_NOT_FOUND") {
                                errorText += `. Available actions: ${this.actions.map(a => a.name).join(', ')}`;
                            } else if (actionResult.errorDetails?.type === "ACTION_TIMEOUT_ERROR") {
                                errorText = `⏰ Action "${actionResult.actionName}" took too long and was stopped after ${Math.round((actionResult.errorDetails?.timeoutMs || 0) / 1000)} seconds. You might want to try a simpler approach or break down the task.`;
                            }
                            
                            const errorMemory: Memory = {
                                id: uuidv4() as UUID,
                                userId: this.agentId,
                                agentId: this.agentId,
                                roomId: message.roomId,
                                createdAt: Date.now(),
                                content: {
                                    text: errorText,
                                    action: null,
                                    error: actionResult.errorDetails
                                },
                            };
                            
                            await this.messageManager.createMemory(errorMemory);
                        }
                    }
                } else {
                    hasErrors = true;
                    const error = result.reason;
                    elizaLogger.error('Action promise rejected:', error);
                    
                    if (!firstError) {
                        firstError = {
                            success: false,
                            error: `Action promise rejected: ${error.message || error}`,
                            errorDetails: {
                                type: "ACTION_PROMISE_REJECTED",
                                originalError: error.message || String(error),
                                stack: error.stack || null
                            }
                        };
                        
                        // Create error response memory
                        const errorMemory: Memory = {
                            id: uuidv4() as UUID,
                            userId: this.agentId,
                            agentId: this.agentId,
                            roomId: message.roomId,
                            createdAt: Date.now(),
                            content: {
                                text: `❌ Error: Action execution failed unexpectedly`,
                                action: null,
                                error: firstError.errorDetails
                            },
                        };
                        
                        await this.messageManager.createMemory(errorMemory);
                    }
                }
            }
            
            // If there were errors, return the first one
            if (hasErrors && firstError) {
                return {
                    success: false,
                    error: firstError.error,
                    errorDetails: firstError.errorDetails
                };
            }
            
            // Auto-summary feature has been disabled
        }
        
        return { success: true };
    } catch (error: any) {
        const errorMsg = `Critical error in processActions: ${error.message || error}`;
        elizaLogger.error(errorMsg, error);
        addStep('action_error', 'error', '💥 Something went wrong while trying to help you', null, error.message);
        
        return {
            success: false,
            error: errorMsg,
            errorDetails: {
                type: "CRITICAL_ACTION_ERROR",
                message: errorMsg,
                originalError: error.message || String(error),
                stack: error.stack || null
            }
        };
    }
}

// Helper function to process actions with concurrency limit
async function processActionsWithConcurrencyLimit<T>(
    promises: Promise<T>[],
    concurrencyLimit: number
): Promise<PromiseSettledResult<T>[]> {
    const results: PromiseSettledResult<T>[] = [];
    
    for (let i = 0; i < promises.length; i += concurrencyLimit) {
        const batch = promises.slice(i, i + concurrencyLimit);
        const batchResults = await Promise.allSettled(batch);
        results.push(...batchResults);
    }
    
    return results;
}

// Helper function to execute action with timeout and stop checking
async function executeWithTimeout<T>(
    this: any,
    operation: () => Promise<T>,
    timeoutMs: number,
    actionName: string
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        // Create timeout promise
        const timeoutHandle = setTimeout(() => {
            const timeoutError = new Error(`Action "${actionName}" timed out after ${Math.round(timeoutMs / 1000)} seconds`);
            timeoutError.name = 'ActionTimeoutError';
            reject(timeoutError);
        }, timeoutMs);

        // Create stop checking interval (check every 100ms)
        const stopCheckInterval = setInterval(() => {
            if (this.shouldStop && this.shouldStop()) {
                elizaLogger.info(`🛑 Stop detected during action "${actionName}" execution - interrupting`);
                clearTimeout(timeoutHandle);
                clearInterval(stopCheckInterval);
                const stopError = new Error(`Action "${actionName}" was stopped by user`);
                stopError.name = 'ActionStoppedError';
                reject(stopError);
            }
        }, 100);

        // Execute the operation
        operation()
            .then((result) => {
                clearTimeout(timeoutHandle);
                clearInterval(stopCheckInterval);
                resolve(result);
            })
            .catch((error) => {
                clearTimeout(timeoutHandle);
                clearInterval(stopCheckInterval);
                reject(error);
            });
    });
}

// Helper function to execute action with retry logic
async function executeActionWithRetry<T>(
    operation: () => Promise<T>,
    maxRetries = 2,
    baseDelay = 1000
): Promise<T> {
    let lastError: Error;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error as Error;
            
            // Don't retry timeout errors or stopped actions - they indicate a fundamental issue or user choice
            if (lastError.name === 'ActionTimeoutError' || lastError.name === 'ActionStoppedError') {
                break;
            }
            
            // Don't retry on the last attempt
            if (attempt === maxRetries) {
                break;
            }
            
            // Exponential backoff with jitter
            const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
            elizaLogger.warn(`Action attempt ${attempt + 1} failed, retrying in ${Math.round(delay)}ms:`, error);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    throw lastError;
}