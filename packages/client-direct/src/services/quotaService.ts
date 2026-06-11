import {
    elizaLogger,
    isAnonymousAccount,
    resolveEffectiveSubscriptionTierFromAdapter,
} from "@elizaos/core";
import type { IAgentRuntime, ResolvedSubscriptionTier, UUID } from "@elizaos/core";

/**
 * Weekly token limits by tier
 */
export interface WeeklyTokenLimits {
    INPUT_TOKENS: number;
    OUTPUT_TOKENS: number;
}

export const WEEKLY_TOKEN_LIMITS_BY_TIER = {
    free: {
        INPUT_TOKENS: 1_250_000,
        OUTPUT_TOKENS: 150_000,
    },
    plus: {
        INPUT_TOKENS: 1_500_000,
        OUTPUT_TOKENS: 200_000,
    },
} as const satisfies Record<string, WeeklyTokenLimits>;

export type LimitedQuotaTier = keyof typeof WEEKLY_TOKEN_LIMITS_BY_TIER; // "free" | "plus"
export type QuotaTier = LimitedQuotaTier | "unlimited";

type QuotaTierResolution = {
    tier: QuotaTier;
    isFreeUser: boolean;
    isUnlimited: boolean;
};

/**
 * Quota warning thresholds (as percentages)
 * 50%开始提醒，每10%提醒一次
 */
export const QUOTA_WARNING_THRESHOLDS = {
    START: 0.50, // 50% - 开始提醒
    CRITICAL: 0.90, // 90% - 常态显示，不能关闭
};

/**
 * Rolling window duration in milliseconds (7 days)
 */
const ROLLING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Quota status for a user
 */
export interface QuotaStatus {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    inputLimit: number;
    outputLimit: number;
    inputPercentage: number;
    outputPercentage: number;
    isQuotaExceeded: boolean;
    warningLevel: "none" | "warning" | "critical" | "exceeded";
    percentageTier: number; // 0, 50, 60, 70, 80-100 (80%以上为精确整数百分比)
    resetDate: string;
    daysUntilReset: number;
}

/**
 * Quota validation result
 */
export interface QuotaValidationResult {
    allowed: boolean;
    quotaStatus?: QuotaStatus;
    error?: string;
}

/**
 * Checks if a user is a free user (no active subscription)
 */
export async function isFreeUser(
    runtime: IAgentRuntime,
    userId: UUID
): Promise<boolean> {
    try {
        const quotaTier = await getUserQuotaTier(runtime, userId);
        return quotaTier.isFreeUser;
    } catch (error) {
        elizaLogger.error("Error checking if user is free:", error);
        // Fail-open: assume paid user to avoid blocking on error
        return false;
    }
}

const quotaResolutionFromResolvedTier = (
    tier: ResolvedSubscriptionTier
): QuotaTierResolution => {
    if (tier === "enterprise" || tier === "pro") {
        return { tier: "unlimited", isFreeUser: false, isUnlimited: true };
    }
    if (tier === "plus") {
        return { tier: "plus", isFreeUser: false, isUnlimited: false };
    }
    return { tier: "free", isFreeUser: true, isUnlimited: false };
};

let _devAgentQuotaBypassLogged = false;

/**
 * Opt-in local only: LOCAL_DEV_MODE=1 and DEV_AGENT_QUOTA_BYPASS=1 treats weekly agent quota as unlimited.
 * Do not set in production.
 */
function isLocalDevAgentQuotaBypassEnabled(): boolean {
    return (
        process.env.LOCAL_DEV_MODE?.trim() === "1" &&
        process.env.DEV_AGENT_QUOTA_BYPASS?.trim() === "1"
    );
}

/**
 * Resolves quota tier from the latest recorded subscription tier history.
 * Anonymous users are always treated as free.
 */
export async function getUserQuotaTier(
    runtime: IAgentRuntime,
    userId: UUID
): Promise<{ tier: QuotaTier; isFreeUser: boolean; isUnlimited: boolean }> {
    try {
        if (isLocalDevAgentQuotaBypassEnabled()) {
            if (!_devAgentQuotaBypassLogged) {
                _devAgentQuotaBypassLogged = true;
                elizaLogger.info(
                    "LOCAL_DEV_MODE: DEV_AGENT_QUOTA_BYPASS active — agent weekly quota uses unlimited tier"
                );
            }
            return {
                tier: "unlimited",
                isFreeUser: false,
                isUnlimited: true,
            };
        }

        const account = await runtime.databaseAdapter.getAccountById(userId);

        if (isAnonymousAccount(account)) {
            return quotaResolutionFromResolvedTier("free");
        }

        const tier = await resolveEffectiveSubscriptionTierFromAdapter(
            runtime.databaseAdapter as any,
            userId,
            { account }
        );
        return quotaResolutionFromResolvedTier(tier);
    } catch (error) {
        elizaLogger.error("Error resolving user quota tier:", error);
        // Fail-open: assume unlimited to avoid blocking on error
        return { tier: "unlimited", isFreeUser: false, isUnlimited: true };
    }
}

/**
 * Calculates the current cycle start and reset date based on rolling window
 */
function calculateCycleDates(firstUsageTimestamp: number | null): {
    cycleStart: number;
    resetDate: Date;
} {
    const now = Date.now();

    if (!firstUsageTimestamp) {
        // If no usage yet, cycle starts now
        return {
            cycleStart: now,
            resetDate: new Date(now + ROLLING_WINDOW_MS),
        };
    }

    // Calculate how many complete cycles have passed since first usage
    const timeSinceFirst = now - firstUsageTimestamp;
    const completedCycles = Math.floor(timeSinceFirst / ROLLING_WINDOW_MS);

    // Current cycle starts at: firstUsage + (completedCycles * 7 days)
    const cycleStart = firstUsageTimestamp + completedCycles * ROLLING_WINDOW_MS;

    // Reset date is at the end of the current cycle
    const resetDate = new Date(cycleStart + ROLLING_WINDOW_MS);

    return { cycleStart, resetDate };
}

/**
 * Calculates the display tier:
 * - <50%: 0
 * - 50-79%: 50/60/70 buckets
 * - >=80%: exact integer percentage (80-100)
 */
function calculatePercentageTier(percentage: number): number {
    if (percentage >= 1.0) return 100;
    if (percentage >= 0.80) {
        // Use floor to avoid overstating usage before crossing hard thresholds.
        return Math.max(80, Math.min(99, Math.floor(percentage * 100)));
    }
    if (percentage >= 0.70) return 70;
    if (percentage >= 0.60) return 60;
    if (percentage >= 0.50) return 50;
    return 0;
}

/**
 * Determines warning level based on usage percentages
 * 50%开始提醒，90%以后常态显示
 */
function determineWarningLevel(
    inputPercentage: number,
    outputPercentage: number
): "none" | "warning" | "critical" | "exceeded" {
    const maxPercentage = Math.max(inputPercentage, outputPercentage);

    if (maxPercentage >= 1.0) {
        return "exceeded";
    }
    if (maxPercentage >= QUOTA_WARNING_THRESHOLDS.CRITICAL) {
        return "critical"; // 90%+ 常态显示
    }
    if (maxPercentage >= QUOTA_WARNING_THRESHOLDS.START) {
        return "warning"; // 50%+ 提醒
    }
    return "none";
}

/**
 * Gets the current quota status for a user
 */
export async function getUserQuotaStatus(
    runtime: IAgentRuntime,
    userId: UUID,
    limits: WeeklyTokenLimits = WEEKLY_TOKEN_LIMITS_BY_TIER.free
): Promise<QuotaStatus> {
    try {
        // Get first usage timestamp to calculate rolling window
        const firstTimestamp =
            await runtime.databaseAdapter.getUserFirstTokenUsageTimestamp({
                userId,
            });

        const { cycleStart, resetDate } = calculateCycleDates(firstTimestamp);

        // Get usage for current cycle
        const usage = await runtime.databaseAdapter.getUserTokenUsage({
            userId,
            since: cycleStart,
        });

        // Calculate percentages
        const inputPercentage = usage.inputTokens / limits.INPUT_TOKENS;
        const outputPercentage = usage.outputTokens / limits.OUTPUT_TOKENS;

        // Check if quota exceeded (either limit)
        const isQuotaExceeded =
            usage.inputTokens >= limits.INPUT_TOKENS ||
            usage.outputTokens >= limits.OUTPUT_TOKENS;

        // Determine warning level
        const warningLevel = determineWarningLevel(
            inputPercentage,
            outputPercentage
        );

        // Calculate days until reset
        const daysUntilReset = Math.ceil(
            (resetDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
        );

        // Calculate percentage tier
        const maxPercentage = Math.max(inputPercentage, outputPercentage);
        const percentageTier = calculatePercentageTier(maxPercentage);

        return {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
            inputLimit: limits.INPUT_TOKENS,
            outputLimit: limits.OUTPUT_TOKENS,
            inputPercentage,
            outputPercentage,
            isQuotaExceeded,
            warningLevel,
            percentageTier,
            resetDate: resetDate.toISOString(),
            daysUntilReset,
        };
    } catch (error) {
        elizaLogger.error("Error getting user quota status:", error);
        throw error;
    }
}

/**
 * Validates if a user can send a message based on quota
 * Pre-flight check before processing message
 */
export async function validateQuotaBeforeMessage(
    runtime: IAgentRuntime,
    userId: UUID
): Promise<QuotaValidationResult> {
    try {
        const quotaTier = await getUserQuotaTier(runtime, userId);

        if (quotaTier.tier === "unlimited") {
            // Paid users with unlimited quota
            return { allowed: true };
        }

        const limits = WEEKLY_TOKEN_LIMITS_BY_TIER[quotaTier.tier];
        const quotaStatus = await getUserQuotaStatus(runtime, userId, limits);

        if (quotaStatus.isQuotaExceeded) {
            // Quota exceeded - block message
            const resetDateFormatted = new Date(
                quotaStatus.resetDate
            ).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
            });

            return {
                allowed: false,
                quotaStatus,
                error: `Weekly quota exceeded. Your quota will reset on ${resetDateFormatted}. Upgrade to continue using SentiEdge.`,
            };
        }

        // Quota OK - allow message
        return { allowed: true, quotaStatus };
    } catch (error) {
        elizaLogger.error("Error validating quota:", error);
        // Fail-open: allow message on error to avoid blocking users
        return { allowed: true };
    }
}
