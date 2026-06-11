import type { IAgentRuntime, UUID } from "../core/types.ts";
import { elizaLogger } from "./logger.ts";
import {
    isAnonymousAccount,
    resolveEffectiveSubscriptionTier,
} from "./subscriptionTier.ts";

/**
 * Maximum data retention days by subscription tier.
 * free: 3 months; plus: 6 months; pro: 24 months; enterprise: 0 = no limit.
 */
export const DATA_RETENTION_DAYS_BY_TIER = {
    /** Free / no active subscription: 3 months */
    free: 90,
    plus: 180,   // 6 months
    pro: 730,    // 24 months
    /** Enterprise: 0 means no limit */
    enterprise: 0,
} as const;

/** Anonymous users: only data between 1 month and 3 months ago (min/max days ago from today). */
export const ANONYMOUS_DATA_RETENTION_WINDOW = {
    /** Data must be at least this many days old */
    minDaysAgo: 30,
    /** Data must be at most this many days old */
    maxDaysAgo: 90,
} as const;

/** Conservative default when subscription cannot be determined (fail-safe): free tier. */
export const DEFAULT_DATA_RETENTION_DAYS = DATA_RETENTION_DAYS_BY_TIER.free;

/**
 * Data retention config passed to actions.
 * - dataRetentionDays: max days of history (0 = no limit for enterprise).
 * - dataRetentionMinDaysAgo / dataRetentionMaxDaysAgo: when both set (anonymous), data must fall in [today-maxDaysAgo, today-minDaysAgo].
 */
export interface DataRetentionConfig {
    dataRetentionDays: number;
    dataRetentionMinDaysAgo?: number;
    dataRetentionMaxDaysAgo?: number;
}

let _localDevRetentionLogged = false;

/**
 * Opt-in local development: bypass subscription DB and anonymous retention window.
 * Set LOCAL_DEV_MODE=1 and LOCAL_DEV_SUBSCRIPTION_TIER to free|plus|pro|enterprise.
 * Do not enable LOCAL_DEV_MODE in production.
 *
 * Note: `client-direct` also skips the anonymous **daily message cap** (3/24h) when
 * LOCAL_DEV_MODE=1 so automated / IP-based anonymous sessions can keep chatting locally.
 */
export function getLocalDevDataRetentionOverride(): DataRetentionConfig | null {
    if (process.env.LOCAL_DEV_MODE?.trim() !== "1") {
        return null;
    }
    const raw = process.env.LOCAL_DEV_SUBSCRIPTION_TIER?.trim().toLowerCase();
    if (!raw) {
        elizaLogger.warn(
            "LOCAL_DEV_MODE=1 but LOCAL_DEV_SUBSCRIPTION_TIER is unset; retention override disabled"
        );
        return null;
    }
    let config: DataRetentionConfig | null = null;
    if (raw === "enterprise") {
        config = { dataRetentionDays: DATA_RETENTION_DAYS_BY_TIER.enterprise };
    } else if (raw === "pro") {
        config = { dataRetentionDays: DATA_RETENTION_DAYS_BY_TIER.pro };
    } else if (raw === "plus") {
        config = { dataRetentionDays: DATA_RETENTION_DAYS_BY_TIER.plus };
    } else if (raw === "free") {
        config = { dataRetentionDays: DATA_RETENTION_DAYS_BY_TIER.free };
    } else {
        elizaLogger.warn(
            "LOCAL_DEV_SUBSCRIPTION_TIER invalid; expected free|plus|pro|enterprise",
            { value: process.env.LOCAL_DEV_SUBSCRIPTION_TIER }
        );
        return null;
    }
    if (!_localDevRetentionLogged) {
        elizaLogger.info("LOCAL_DEV_MODE: data retention override active", {
            LOCAL_DEV_SUBSCRIPTION_TIER: raw,
        });
        _localDevRetentionLogged = true;
    }
    return config;
}

/**
 * Date range shape used by plugins (startDate, endDate, totalDays).
 */
export interface DateRangeForClamp {
    startDate: string;
    endDate: string;
    totalDays: number;
}

/**
 * Resolves data retention config for a user based on anonymous flag and subscription.
 * Priority:
 * - LOCAL_DEV_MODE=1 and LOCAL_DEV_SUBSCRIPTION_TIER set: synthetic tier (local only).
 * - Anonymous (not logged in): only data between 1 and 3 months ago.
 * - Logged-in users: tier limits from subscription (plus/pro/enterprise) or free fallback.
 *
 * Limits:
 * - Plus: last 6 months (180 days).
 * - Pro: last 24 months (730 days).
 * - Enterprise: no limit (dataRetentionDays=0).
 * - Free: last 3 months (90 days).
 * - Anonymous: minDaysAgo=30, maxDaysAgo=90.
 *
 * @param runtime - Agent runtime
 * @param userId - Requesting user's UUID (e.g. message.userId)
 * @returns DataRetentionConfig for plugins to clamp date ranges
 */
export async function getDataRetentionConfig(
    runtime: IAgentRuntime,
    userId: UUID
): Promise<DataRetentionConfig> {
    const localOverride = getLocalDevDataRetentionOverride();
    if (localOverride) {
        return localOverride;
    }
    if (!userId) {
        return { dataRetentionDays: DEFAULT_DATA_RETENTION_DAYS };
    }
    try {
        // Rule priority:
        // 1) Not logged in (anonymous) => anonymous window.
        // 2) Logged in => resolve subscription tier.
        const account = await runtime.databaseAdapter.getAccountById(userId);
        const isAnonymous = isAnonymousAccount(account);
        if (isAnonymous) {
            return {
                dataRetentionDays:
                    ANONYMOUS_DATA_RETENTION_WINDOW.maxDaysAgo -
                    ANONYMOUS_DATA_RETENTION_WINDOW.minDaysAgo,
                dataRetentionMinDaysAgo: ANONYMOUS_DATA_RETENTION_WINDOW.minDaysAgo,
                dataRetentionMaxDaysAgo: ANONYMOUS_DATA_RETENTION_WINDOW.maxDaysAgo,
            };
        }

        const tier = await resolveEffectiveSubscriptionTier(runtime, userId, {
            account,
        });
        if (tier === "enterprise") {
            return { dataRetentionDays: DATA_RETENTION_DAYS_BY_TIER.enterprise };
        }
        if (tier === "pro") {
            return { dataRetentionDays: DATA_RETENTION_DAYS_BY_TIER.pro };
        }
        if (tier === "plus") {
            return { dataRetentionDays: DATA_RETENTION_DAYS_BY_TIER.plus };
        }

        return { dataRetentionDays: DATA_RETENTION_DAYS_BY_TIER.free };
    } catch (error) {
        elizaLogger.warn("Data retention: failed to resolve subscription, using default", {
            userId,
            error: error instanceof Error ? error.message : String(error),
        });
        return { dataRetentionDays: DEFAULT_DATA_RETENTION_DAYS };
    }
}

/**
 * @deprecated Use getDataRetentionConfig and clampDateRangeToRetention instead.
 * Resolves the maximum data retention days for a user (backward compatibility).
 */
export async function getDataRetentionDays(
    runtime: IAgentRuntime,
    userId: UUID
): Promise<number> {
    const config = await getDataRetentionConfig(runtime, userId);
    return config.dataRetentionDays;
}

/**
 * Clamps a date range according to retention config.
 * - If dataRetentionDays === 0: no clamp (enterprise).
 * - If dataRetentionMinDaysAgo and dataRetentionMaxDaysAgo are set (anonymous): clamp to [today-maxDaysAgo, today-minDaysAgo].
 * - Else if dataRetentionDays > 0: clamp so totalDays <= dataRetentionDays (keep endDate, move startDate forward).
 *
 * @param dateRange - Object with startDate, endDate, totalDays (YYYY-MM-DD strings)
 * @param config - DataRetentionConfig from getDataRetentionConfig (or options from action)
 * @returns Clamped date range or the same object if no change
 */
export function clampDateRangeToRetention(
    dateRange: DateRangeForClamp,
    config: DataRetentionConfig
): DateRangeForClamp {
    const maxDays = config.dataRetentionDays;
    const minDaysAgo = config.dataRetentionMinDaysAgo;
    const maxDaysAgo = config.dataRetentionMaxDaysAgo;

    if (typeof maxDays === "number" && maxDays === 0) {
        return dateRange;
    }

    if (
        typeof minDaysAgo === "number" &&
        minDaysAgo >= 0 &&
        typeof maxDaysAgo === "number" &&
        maxDaysAgo > minDaysAgo
    ) {
        const today = new Date();
        const end = new Date(today);
        end.setUTCDate(end.getUTCDate() - minDaysAgo);
        const start = new Date(today);
        start.setUTCDate(start.getUTCDate() - maxDaysAgo);
        const startDate = start.toISOString().split("T")[0];
        const endDate = end.toISOString().split("T")[0];
        const totalDays = maxDaysAgo - minDaysAgo;
        return { startDate, endDate, totalDays };
    }

    if (typeof maxDays !== "number" || maxDays < 1) {
        return dateRange;
    }
    return clampDateRangeToMaxDays(dateRange, maxDays);
}

/**
 * Clamps a date range so that totalDays does not exceed maxDays.
 * Keeps endDate fixed and moves startDate forward when needed.
 * If maxDays is not a positive number or totalDays <= maxDays, returns the original range.
 *
 * @param dateRange - Object with startDate, endDate, totalDays (YYYY-MM-DD strings)
 * @param maxDays - Maximum allowed span (e.g. from getDataRetentionDays)
 * @returns Clamped date range or the same object if no change
 */
export function clampDateRangeToMaxDays(
    dateRange: DateRangeForClamp,
    maxDays: number
): DateRangeForClamp {
    if (typeof maxDays !== "number" || maxDays < 1) {
        return dateRange;
    }
    if (dateRange.totalDays <= maxDays) {
        return dateRange;
    }
    const end = new Date(dateRange.endDate + "T23:59:59Z");
    const start = new Date(end.getTime());
    start.setUTCDate(start.getUTCDate() - (maxDays - 1));
    const startDate = start.toISOString().split("T")[0];
    return {
        startDate,
        endDate: dateRange.endDate,
        totalDays: maxDays,
    };
}
