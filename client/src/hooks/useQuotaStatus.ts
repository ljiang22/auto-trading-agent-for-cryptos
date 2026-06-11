import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { apiClient } from "@/lib/api";

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

export interface QuotaStatusResponse {
    success: boolean;
    isUnlimited: boolean;
    isFreeUser: boolean;
    isLimitedUser?: boolean;
    quotaTier?: "free" | "plus" | "unlimited";
    quotaStatus?: QuotaStatus;
    error?: string;
}

/**
 * React hook for fetching and managing user quota status
 * Automatically refreshes every 60 seconds and refetches when authentication changes
 */
export const useQuotaStatus = (agentId: string) => {
    const { isAuthenticated } = useAuth();

    const { data, isLoading, error, refetch } = useQuery<QuotaStatusResponse>({
        queryKey: ["quotaStatus", agentId, isAuthenticated],
        queryFn: () => apiClient.getQuotaStatus(agentId),
        refetchInterval: 60000, // Refresh every 60 seconds
        // Server requires auth on /quota/status; firing it for anonymous
        // users floods the console with 401s every refetch interval.
        enabled: !!agentId && isAuthenticated,
        staleTime: 30000, // Consider data stale after 30 seconds
    });

    return {
        quotaStatus: data?.quotaStatus,
        isFreeUser: data?.isFreeUser ?? false,
        isLimitedUser:
            data?.isLimitedUser ?? (data?.isUnlimited === false && !!data?.quotaStatus),
        quotaTier: data?.quotaTier ?? (data?.isUnlimited ? "unlimited" : undefined),
        hasUnlimitedQuota: data?.isUnlimited ?? false,
        isLoading,
        error,
        refetch,
    };
};
