/**
 * Utility functions for generating standardized action result summaries
 * Used across all plugin actions to create consistent, brief summaries in actionData.summary
 */

/**
 * Generate a standardized action summary
 * @param actionName - Name of the action (e.g., "Technical Analysis", "Whale Alert")
 * @param assets - Array of assets analyzed (e.g., ["BTC", "ETH"])
 * @param timePeriod - Time period or date range (e.g., "30 days", "2025-01-01 to 2025-01-31")
 * @param dataPoints - Number of data points analyzed
 * @param additionalInfo - Optional additional context
 * @returns A brief 1-2 sentence summary
 *
 * @example
 * ```typescript
 * const summary = generateActionSummary({
 *     actionName: 'Technical Analysis',
 *     assets: ['BTC'],
 *     timePeriod: '30 days',
 *     dataPoints: 90,
 *     additionalInfo: 'bullish momentum with RSI at 68'
 * });
 * // Returns: "Technical Analysis for BTC over 30 days (90 data points): bullish momentum with RSI at 68."
 * ```
 */
export function generateActionSummary({
    actionName,
    assets,
    timePeriod,
    dataPoints,
    additionalInfo
}: {
    actionName: string;
    assets: string[];
    timePeriod: string;
    dataPoints: number;
    additionalInfo?: string;
}): string {
    // Format asset text
    const assetText = formatAssetList(assets);

    // Format data points
    const dataPointText = `${dataPoints.toLocaleString()} data point${dataPoints !== 1 ? 's' : ''}`;

    // Build summary
    const baseSummary = `${actionName} for ${assetText} over ${timePeriod} (${dataPointText})`;
    const summary = additionalInfo ? `${baseSummary}: ${additionalInfo}.` : `${baseSummary}.`;

    return summary;
}

/**
 * Format a list of assets for display
 * @param assets - Array of asset symbols
 * @returns Formatted asset string
 *
 * @example
 * ```typescript
 * formatAssetList(['BTC']) // "BTC"
 * formatAssetList(['BTC', 'ETH', 'SOL']) // "BTC, ETH, SOL"
 * formatAssetList(['BTC', 'ETH', 'SOL', 'ADA', 'MATIC']) // "BTC, ETH, SOL and 2 more"
 * ```
 */
export function formatAssetList(assets: string[]): string {
    if (assets.length === 0) {
        return 'Unknown';
    }

    if (assets.length === 1) {
        return assets[0];
    }

    if (assets.length <= 3) {
        return assets.join(', ');
    }

    // For more than 3 assets, show first 3 and count the rest
    const visibleAssets = assets.slice(0, 3).join(', ');
    const remainingCount = assets.length - 3;
    return `${visibleAssets} and ${remainingCount} more`;
}

/**
 * Format a date range into a human-readable string
 * @param startDate - Start date (YYYY-MM-DD or timestamp)
 * @param endDate - End date (YYYY-MM-DD or timestamp)
 * @returns Human-readable date range string
 *
 * @example
 * ```typescript
 * formatDateRange('2025-01-01', '2025-01-01') // "2025-01-01"
 * formatDateRange('2025-01-01', '2025-01-08') // "7 days"
 * formatDateRange('2025-01-01', '2025-01-31') // "30 days"
 * ```
 */
export function formatDateRange(startDate: string | number, endDate: string | number): string {
    // Convert to Date objects
    const start = typeof startDate === 'number' ? new Date(startDate) : new Date(startDate);
    const end = typeof endDate === 'number' ? new Date(endDate) : new Date(endDate);

    // Calculate difference in days
    const diffMs = end.getTime() - start.getTime();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    // Handle same day
    if (diffDays === 0) {
        return formatDate(start);
    }

    // Handle 24 hours
    if (diffDays === 1) {
        return '24 hours';
    }

    // Handle weeks
    if (diffDays === 7) {
        return '1 week';
    }

    if (diffDays % 7 === 0 && diffDays <= 28) {
        return `${diffDays / 7} weeks`;
    }

    // Handle months
    if (diffDays === 30 || diffDays === 31) {
        return '1 month';
    }

    if (diffDays >= 28 && diffDays <= 93) {
        const months = Math.round(diffDays / 30);
        if (months > 1) {
            return `${months} months`;
        }
    }

    // Handle years
    if (diffDays >= 365 && diffDays <= 400) {
        return '1 year';
    }

    // Default to days
    return `${diffDays} days`;
}

/**
 * Format a date object to YYYY-MM-DD
 * @param date - Date object
 * @returns Formatted date string
 */
function formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Extract asset symbols from various input formats
 * @param input - String, array, or undefined input
 * @param defaultAsset - Default asset if input is empty
 * @returns Array of asset symbols
 *
 * @example
 * ```typescript
 * normalizeAssets('BTC') // ['BTC']
 * normalizeAssets(['BTC', 'ETH']) // ['BTC', 'ETH']
 * normalizeAssets(undefined, 'SOL') // ['SOL']
 * normalizeAssets('') // ['BTC']
 * ```
 */
export function normalizeAssets(
    input: string | string[] | undefined,
    defaultAsset = 'BTC'
): string[] {
    if (!input) {
        return [defaultAsset];
    }

    if (Array.isArray(input)) {
        return input.length > 0 ? input : [defaultAsset];
    }

    if (typeof input === 'string') {
        const trimmed = input.trim();
        return trimmed ? [trimmed] : [defaultAsset];
    }

    return [defaultAsset];
}

/**
 * Format time period from hours
 * @param hours - Number of hours
 * @returns Formatted time period string
 *
 * @example
 * ```typescript
 * formatTimePeriodFromHours(1) // "1 hour"
 * formatTimePeriodFromHours(24) // "24 hours"
 * formatTimePeriodFromHours(48) // "2 days"
 * formatTimePeriodFromHours(168) // "1 week"
 * ```
 */
export function formatTimePeriodFromHours(hours: number): string {
    if (hours === 1) {
        return '1 hour';
    }

    if (hours < 24) {
        return `${hours} hours`;
    }

    const days = hours / 24;

    if (days === 1) {
        return '24 hours';
    }

    if (days === 7) {
        return '1 week';
    }

    if (days % 7 === 0 && days <= 28) {
        return `${days / 7} weeks`;
    }

    if (Math.round(days) === 30) {
        return '1 month';
    }

    return `${Math.round(days)} days`;
}

/**
 * Format large numbers with K, M, B suffixes
 * @param num - Number to format
 * @param decimals - Number of decimal places (default: 2)
 * @returns Formatted number string
 *
 * @example
 * ```typescript
 * formatLargeNumber(1234) // "1.23K"
 * formatLargeNumber(1234567) // "1.23M"
 * formatLargeNumber(1234567890) // "1.23B"
 * ```
 */
export function formatLargeNumber(num: number, decimals = 2): string {
    if (num >= 1e9) {
        return (num / 1e9).toFixed(decimals) + 'B';
    }
    if (num >= 1e6) {
        return (num / 1e6).toFixed(decimals) + 'M';
    }
    if (num >= 1e3) {
        return (num / 1e3).toFixed(decimals) + 'K';
    }
    return num.toFixed(decimals);
}
