import type { LaunchpadQuery, LaunchpadTokenWithPhase } from "../types";

export function filterLaunchpadTokens(
    tokens: LaunchpadTokenWithPhase[],
    query: LaunchpadQuery,
): LaunchpadTokenWithPhase[] {
    return tokens.filter((token) => {
        if (query.phase && query.phase !== "all" && token.phase !== query.phase) {
            return false;
        }
        if (query.tokenAddress) {
            if (!token.tokenAddress || token.tokenAddress.toLowerCase() !== query.tokenAddress.toLowerCase()) {
                return false;
            }
        }
        if (query.symbol) {
            const normalizedQuerySymbol = query.symbol.toLowerCase();
            const symbolMatches = token.symbol
                ? token.symbol.toLowerCase() === normalizedQuerySymbol
                : token.name?.toLowerCase().includes(normalizedQuerySymbol);
            if (!symbolMatches) {
                return false;
            }
        }
        if (query.keywords && query.keywords.length > 0) {
            const haystack = `${token.symbol ?? ""} ${token.name ?? ""}`.toLowerCase();
            const keywordMatch = query.keywords.some((keyword) => haystack.includes(keyword));
            if (!keywordMatch) {
                return false;
            }
        }
        return true;
    });
}
