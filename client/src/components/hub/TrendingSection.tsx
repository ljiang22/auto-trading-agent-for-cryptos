import { useCallback, useEffect, useState } from "react";
import { TrendingUp, TrendingDown, Lock } from "lucide-react";
import { apiClient } from "../../lib/api";
import type { TrendingSentiscoreResponse, TrendingCoinScore } from "../../types";
import { useAuth } from "../../contexts/AuthContext";
import { useTranslation } from "react-i18next";

const CoinRankCard = ({ coin }: { coin: TrendingCoinScore }) => {
  const isPositive = coin.weightedScore >= 0;
  const scoreColor = isPositive ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400";
  const bgColor = isPositive ? "bg-green-50 dark:bg-green-900/20" : "bg-red-50 dark:bg-red-900/20";

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 transition">
      <div className={`flex items-center justify-center w-8 h-8 rounded-full ${bgColor} ${scoreColor} font-bold text-sm`}>
        #{coin.rank}
      </div>
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-gray-900 dark:text-white">{coin.symbol}</span>
          {isPositive ? (
            <TrendingUp className="h-4 w-4 text-green-600 dark:text-green-400" />
          ) : (
            <TrendingDown className="h-4 w-4 text-red-600 dark:text-red-400" />
          )}
        </div>
        <div className="flex items-center gap-1 mt-1">
          <span className={`text-sm font-medium ${scoreColor}`}>
            {coin.weightedScore.toFixed(3)}
          </span>
        </div>
      </div>
    </div>
  );
};

export const TrendingSection = () => {
  const { isAuthenticated } = useAuth();
  const { t, i18n } = useTranslation();
  const [trendingData, setTrendingData] = useState<TrendingSentiscoreResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTrendingScores = useCallback(async () => {
    // Only fetch if authenticated
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await apiClient.getTrendingSentiscores();
      setTrendingData(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : t("hub.trending.loadError");
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    fetchTrendingScores();

    // Auto-refresh every hour (only if authenticated)
    if (isAuthenticated) {
      const interval = setInterval(fetchTrendingScores, 60 * 60 * 1000);
      return () => clearInterval(interval);
    }
  }, [fetchTrendingScores, isAuthenticated]);

  if (loading) {
    return (
      <div className="w-full py-8">
        <div className="text-center py-8 text-gray-600 dark:text-gray-400">
          {t("hub.trending.loading")}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full py-8">
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 text-red-700 p-4 text-sm">
          <p>{error}</p>
        </div>
      </div>
    );
  }

  // Show login prompt for unauthenticated users
  if (!isAuthenticated) {
    return (
      <div className="w-full py-8">
        <div className="flex flex-col items-center justify-center py-16 px-4">
          <div className="w-full max-w-md text-center space-y-4">
            <div className="w-20 h-20 mx-auto rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
              <Lock className="h-10 w-10 text-gray-400 dark:text-gray-500" />
            </div>
            <h4 className="text-lg font-semibold text-gray-900 dark:text-white">
              {t("hub.trending.loginRequired")}
            </h4>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t("hub.trending.loginDescription")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!trendingData || (trendingData.news.length === 0 && trendingData.twitter.length === 0)) {
    return (
      <div className="w-full py-8">
        <div className="flex flex-col items-center justify-center py-16 px-4">
          <div className="w-full max-w-md text-center space-y-4">
            <div className="w-20 h-20 mx-auto rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
              <TrendingUp className="h-10 w-10 text-gray-400 dark:text-gray-500" />
            </div>
            <h4 className="text-lg font-semibold text-gray-900 dark:text-white">
              {t("hub.trending.emptyTitle")}
            </h4>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t("hub.trending.emptyDescription")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full py-8">
      <div className="mb-6">
        <h3 className="text-xl font-semibold text-gray-900 dark:text-white">
          {t("hub.trending.title")}
        </h3>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* News Sentiment */}
        <div>
          <div className="mb-4 flex items-center gap-2">
            <h4 className="font-semibold text-gray-900 dark:text-white">{t("hub.trending.news")}</h4>
            <span className="text-xs px-2 py-1 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
              {t("hub.trending.coins", { count: trendingData.news.length })}
            </span>
          </div>
          <div className="space-y-2">
            {trendingData.news.map((coin) => (
              <CoinRankCard key={coin.symbol} coin={coin} />
            ))}
          </div>
        </div>

        {/* X/Twitter Sentiment */}
        <div>
          <div className="mb-4 flex items-center gap-2">
            <h4 className="font-semibold text-gray-900 dark:text-white">{t("hub.trending.twitter")}</h4>
            <span className="text-xs px-2 py-1 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300">
              {t("hub.trending.coins", { count: trendingData.twitter.length })}
            </span>
          </div>
          <div className="space-y-2">
            {trendingData.twitter.map((coin) => (
              <CoinRankCard key={coin.symbol} coin={coin} />
            ))}
          </div>
        </div>
      </div>

      <div className="mt-6 text-center">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t("hub.trending.lastUpdated", {
            value: new Date(trendingData.lastUpdated).toLocaleString(i18n.language),
          })}
        </p>
      </div>
    </div>
  );
};
