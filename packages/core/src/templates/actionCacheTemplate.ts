/**
 * Action Cache Utilities
 *
 * Helpers for cache validation.
 */

import type { CachedActionResult } from "../core/types.ts";

/**
 * Check if cache context should be included based on results quality
 */
export function shouldIncludeCacheContext(
    results: CachedActionResult[],
    minSimilarity = 0.6,
    minResults = 1
): boolean {
    if (!results || results.length < minResults) {
        return false;
    }

    // Check if at least one result meets the similarity threshold
    return results.some(r => (r.similarity || 0) >= minSimilarity);
}

