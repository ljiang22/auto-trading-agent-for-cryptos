import { AsyncLocalStorage } from "node:async_hooks";
import { elizaLogger } from "./logger.ts";
import { calculateTotalCost } from "./pricing.ts";
import type { 
    IAgentRuntime, 
    TokenUsage, 
    UsageMetrics, 
    UsageStats, 
    UsageSummary,
    ModelClass
} from "../core/types.ts";

export interface UsageTrackingContext {
    userId?: string;
    roomId?: string;
}

const usageTrackingContextStorage = new AsyncLocalStorage<UsageTrackingContext>();

export function runWithUsageTrackingContext<T>(
    context: UsageTrackingContext,
    fn: () => Promise<T>
): Promise<T>;
export function runWithUsageTrackingContext<T>(
    context: UsageTrackingContext,
    fn: () => T
): T;
export function runWithUsageTrackingContext<T>(
    context: UsageTrackingContext,
    fn: () => T
): T {
    return usageTrackingContextStorage.run(context, fn);
}

export function enterUsageTrackingContext(
    context: UsageTrackingContext
): void {
    usageTrackingContextStorage.enterWith(context);
}

export function getUsageTrackingContext(): UsageTrackingContext | undefined {
    return usageTrackingContextStorage.getStore();
}

/**
 * Save usage metrics to the database
 */
export async function saveUsageToDatabase(
    runtime: IAgentRuntime,
    metrics: Omit<UsageMetrics, 'id' | 'createdAt'>
): Promise<void> {
    try {
        const usageData: UsageMetrics = {
            ...metrics,
            id: `usage_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            createdAt: Date.now()
        };

        if (!usageData.userId) {
            elizaLogger.debug("Skipping usage metrics save because userId is missing", {
                requestType: usageData.requestType,
                modelProvider: usageData.modelProvider,
                modelName: usageData.modelName
            });
            return;
        }

        // Store usage data in the database
        elizaLogger.info("Usage metrics:", {
            agentId: usageData.agentId,
            modelProvider: usageData.modelProvider,
            modelName: usageData.modelName,
            modelClass: usageData.modelClass,
            requestType: usageData.requestType,
            inputTokens: usageData.usage.inputTokens,
            outputTokens: usageData.usage.outputTokens,
            totalTokens: usageData.usage.totalTokens,
            totalCost: usageData.usage.totalCost,
            success: usageData.success,
            responseTime: usageData.responseTimeMs
        });

        // Save token usage to database for quota tracking
        await runtime.databaseAdapter.saveTokenUsage({
            id: usageData.id,
            userId: usageData.userId || '',
            agentId: usageData.agentId,
            roomId: usageData.roomId,
            inputTokens: usageData.usage.inputTokens,
            outputTokens: usageData.usage.outputTokens,
            totalTokens: usageData.usage.totalTokens,
            modelProvider: usageData.modelProvider,
            modelName: usageData.modelName,
            modelClass: usageData.modelClass,
            timestamp: usageData.createdAt
        });
        
    } catch (error) {
        elizaLogger.error("Failed to save usage metrics:", error);
        // Don't throw error to avoid breaking the main generation flow
    }
}

/**
 * Create TokenUsage object from token counts and model info
 */
export function createTokenUsage(
    inputTokens: number,
    outputTokens: number,
    modelName: string,
    provider: string,
    actualUsage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
    }
): TokenUsage {
    // Use actual usage if provided, otherwise use calculated values
    const finalInputTokens = actualUsage?.inputTokens ?? inputTokens;
    const finalOutputTokens = actualUsage?.outputTokens ?? outputTokens;
    const finalTotalTokens = actualUsage?.totalTokens ?? (finalInputTokens + finalOutputTokens);

    // Calculate costs
    const costs = calculateTotalCost(finalInputTokens, finalOutputTokens, modelName, provider);

    return {
        inputTokens: finalInputTokens,
        outputTokens: finalOutputTokens,
        totalTokens: finalTotalTokens,
        inputCost: costs.inputCost,
        outputCost: costs.outputCost,
        totalCost: costs.totalCost,
        actualUsage: actualUsage ? {
            inputTokens: actualUsage.inputTokens,
            outputTokens: actualUsage.outputTokens,
            totalTokens: actualUsage.totalTokens
        } : undefined
    };
}

/**
 * Track a generation request with timing and usage
 */
export async function trackGenerationUsage(
    runtime: IAgentRuntime,
    options: {
        modelProvider: string;
        modelName: string;
        modelClass?: ModelClass;
        requestType: string;
        userId?: string;
        roomId?: string;
        inputTokens: number;
        outputTokens: number;
        actualUsage?: {
            inputTokens?: number;
            outputTokens?: number;
            totalTokens?: number;
        };
        responseTimeMs?: number;
        success: boolean;
        error?: string;
    }
): Promise<void> {
    const context = getUsageTrackingContext();
    const resolvedUserId = options.userId ?? context?.userId;
    const resolvedRoomId = options.roomId ?? context?.roomId;

    const tokenUsage = createTokenUsage(
        options.inputTokens,
        options.outputTokens,
        options.modelName,
        options.modelProvider,
        options.actualUsage
    );

    const metrics: Omit<UsageMetrics, 'id' | 'createdAt'> = {
        agentId: runtime.agentId,
        userId: resolvedUserId,
        roomId: resolvedRoomId,
        modelProvider: options.modelProvider,
        modelName: options.modelName,
        modelClass: options.modelClass,
        usage: tokenUsage,
        requestType: options.requestType,
        responseTimeMs: options.responseTimeMs,
        success: options.success,
        error: options.error
    };

    await saveUsageToDatabase(runtime, metrics);
}

/**
 * Get usage statistics for an agent (placeholder - to be implemented with database)
 */
export async function getUsageStats(
    runtime: IAgentRuntime,
    startDate?: string,
    endDate?: string
): Promise<UsageStats> {
    elizaLogger.info("Getting usage stats for agent:", runtime.agentId);
    
    // TODO: Implement actual database query
    // This is a placeholder that returns empty stats
    return {
        totalRequests: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        totalCost: 0,
        byProvider: {},
        byModel: {},
        byRequestType: {},
        dailyUsage: []
    };
}

/**
 * Get usage summary for an agent (placeholder - to be implemented with database)
 */
export async function getUsageSummary(
    runtime: IAgentRuntime,
    startDate: string,
    endDate: string
): Promise<UsageSummary> {
    elizaLogger.info("Getting usage summary for agent:", runtime.agentId);
    
    const stats = await getUsageStats(runtime, startDate, endDate);
    
    // TODO: Implement actual database queries for top models and expensive requests
    return {
        period: {
            startDate,
            endDate
        },
        stats,
        topModels: [],
        expensiveRequests: []
    };
}

/**
 * Helper function to measure execution time
 */
export function measureExecutionTime<T>(
    fn: () => Promise<T>
): Promise<{ result: T; timeMs: number }> {
    const startTime = Date.now();
    
    return fn().then(result => ({
        result,
        timeMs: Date.now() - startTime
    }));
}

/**
 * Wrapper for generation functions that automatically tracks usage
 */
export async function withUsageTracking<T>(
    runtime: IAgentRuntime,
    options: {
        modelProvider: string;
        modelName: string;
        modelClass?: ModelClass;
        requestType: string;
        userId?: string;
        roomId?: string;
        inputTokens: number;
        getOutputTokens: (result: T) => number;
        extractActualUsage?: (result: T) => {
            inputTokens?: number;
            outputTokens?: number;
            totalTokens?: number;
        } | undefined;
    },
    fn: () => Promise<T>
): Promise<T> {
    const startTime = Date.now();
    
    try {
        const result = await fn();
        const responseTimeMs = Date.now() - startTime;
        const outputTokens = options.getOutputTokens(result);
        const actualUsage = options.extractActualUsage?.(result);

        // Track successful usage
        await trackGenerationUsage(runtime, {
            modelProvider: options.modelProvider,
            modelName: options.modelName,
            modelClass: options.modelClass,
            requestType: options.requestType,
            userId: options.userId,
            roomId: options.roomId,
            inputTokens: options.inputTokens,
            outputTokens,
            actualUsage,
            responseTimeMs,
            success: true
        });

        return result;
        
    } catch (error) {
        const responseTimeMs = Date.now() - startTime;
        
        // Track failed usage
        await trackGenerationUsage(runtime, {
            modelProvider: options.modelProvider,
            modelName: options.modelName,
            modelClass: options.modelClass,
            requestType: options.requestType,
            userId: options.userId,
            roomId: options.roomId,
            inputTokens: options.inputTokens,
            outputTokens: 0, // No output tokens on failure
            responseTimeMs,
            success: false,
            error: error instanceof Error ? error.message : String(error)
        });

        throw error;
    }
}
