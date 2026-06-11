import { useCallback, useEffect, useState, useMemo } from "react";
import { FileText, Lock } from "lucide-react";
import { apiClient } from "../../lib/api";
import type { ResearchReport } from "../../types";
import { useAuth } from "../../contexts/AuthContext";
import { useSubscriptionTier } from "../../hooks/useSubscriptionTier";
import { UpgradeDialog } from "../UpgradeDialog";
import { useTranslation } from "react-i18next";

export const ReportsSection = () => {
  const { isAuthenticated } = useAuth();
  const { tier } = useSubscriptionTier();
  const { t, i18n } = useTranslation();
  const [allReports, setAllReports] = useState<ResearchReport[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [displayCount, setDisplayCount] = useState<number>(5);
  const [upgradeDialogOpen, setUpgradeDialogOpen] = useState<boolean>(false);

  // Extract date from filename (MMDDYY format - first 6 digits)
  const extractDateFromFilename = (fileName: string): Date | null => {
    const match = fileName.match(/^(\d{6})/);
    if (!match) return null;

    const dateStr = match[1];
    const month = Number.parseInt(dateStr.substring(0, 2), 10);
    const day = Number.parseInt(dateStr.substring(2, 4), 10);
    const year = Number.parseInt(dateStr.substring(4, 6), 10);

    // Convert 2-digit year to 4-digit (assuming 2000s)
    const fullYear = 2000 + year;

    return new Date(fullYear, month - 1, day);
  };

  // Format date for display
  const formatReportDate = (fileName: string): string => {
    const date = extractDateFromFilename(fileName);
    if (!date) return fileName;

    return date.toLocaleDateString(i18n.language, {
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    });
  };

  // Remove date prefix from filename
  const cleanFileName = (fileName: string): string => {
    return fileName.replace(/^\d{6}\s*-?\s*/, '');
  };

  // Compute accessible reports based on user tier
  const accessibleReports = useMemo(() => {
    // Unauthenticated users: No access to any reports
    if (!isAuthenticated) {
      return [];
    }

    if (tier === 'pro' || tier === 'enterprise') {
      // Pro and Enterprise: Access to all reports
      return allReports;
    } else if (tier === 'plus') {
      // Plus: Access to all except the very latest (skip first report)
      return allReports.slice(1);
    } else {
      // Free: Only 5 reports that are at least 1 month (30 days) old
      const now = new Date();
      const oneMonthAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));

      return allReports
        .filter(report => {
          const reportDate = extractDateFromFilename(report.fileName);
          return reportDate && reportDate <= oneMonthAgo;
        })
        .slice(0, 5);
    }
  }, [allReports, tier, isAuthenticated]);

  const fetchReports = useCallback(async () => {
    setLoading(true);
    setError(null);
    setDisplayCount(5); // Reset to show only 5 reports initially
    try {
      const response = await apiClient.getWeeklyReports();

      // Sort reports by date in filename (newest first)
      const sortedReports = (response.reports ?? []).sort((a, b) => {
        const dateA = extractDateFromFilename(a.fileName);
        const dateB = extractDateFromFilename(b.fileName);

        // If both have valid dates, compare them
        if (dateA && dateB) {
          return dateB.getTime() - dateA.getTime(); // Newest first
        }

        // If one doesn't have a date, put it at the end
        if (!dateA && dateB) return 1;
        if (dateA && !dateB) return -1;

        // If neither has a date, maintain original order
        return 0;
      });

      setAllReports(sortedReports);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t("hub.reports.loadError");
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  const loadMore = () => {
    setDisplayCount(prev => prev + 5);
  };

  const hasMore = displayCount < accessibleReports.length;

  const openPDF = (report: ResearchReport) => {
    const url = report.downloadUrl ?? report.downloadPath;
    if (url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <div className="w-full py-8">
      <div className="mb-6">
        <h3 className="text-xl font-semibold text-gray-900 dark:text-white">
          {t("hub.reports.title")}
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t("hub.reports.subtitle")}
        </p>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 text-red-700 p-4 text-sm">
          <p>{error}</p>
        </div>
      )}

      {loading && allReports.length === 0 ? (
        <div className="text-center py-8 text-gray-600 dark:text-gray-400">
          {t("hub.reports.loading")}
        </div>
      ) : accessibleReports.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 px-4">
          <div className="w-20 h-20 mx-auto rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center mb-4">
            {!isAuthenticated ? (
              <Lock className="h-10 w-10 text-gray-400 dark:text-gray-500" />
            ) : (
              <FileText className="h-10 w-10 text-gray-400 dark:text-gray-500" />
            )}
          </div>
          <h4 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
            {!isAuthenticated ? t('hub.reports.loginRequired') : t('hub.reports.noReportsAvailable')}
          </h4>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {!isAuthenticated
              ? t('hub.reports.loginDescription')
              : tier === 'free' && allReports.length > 0
              ? t('hub.reports.freeTierDescription')
              : t('hub.reports.emptyDescription')}
          </p>
        </div>
      ) : (
        <>
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
            <div className="divide-y divide-gray-200 dark:divide-gray-800">
              {accessibleReports.slice(0, displayCount).map((report) => (
                <button
                  key={report.fileName}
                  type="button"
                  onClick={() => openPDF(report)}
                  className="w-full flex items-center gap-3 p-4 hover:bg-gray-50 dark:hover:bg-gray-800 transition text-left"
                >
                  <div className="flex-shrink-0">
                    <div className="w-10 h-10 rounded-full bg-blue-50 dark:bg-blue-900/40 flex items-center justify-center">
                      <FileText className="h-5 w-5 text-blue-600 dark:text-blue-300" />
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900 dark:text-white truncate">
                      {cleanFileName(report.fileName)}
                    </p>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                      {formatReportDate(report.fileName)}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Show locked reports for non-pro users */}
          {tier !== 'pro' && tier !== 'enterprise' && allReports.length > accessibleReports.length && (
            <div className="mt-6">
              <div className="bg-gradient-to-r from-blue-50 to-purple-50 dark:from-blue-900/20 dark:to-purple-900/20 rounded-lg border border-blue-200 dark:border-blue-800 p-6">
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0">
                    <div className="w-12 h-12 rounded-full bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center">
                      <Lock className="h-6 w-6 text-blue-600 dark:text-blue-300" />
                    </div>
                  </div>
                  <div className="flex-1">
                    <h4 className="font-semibold text-gray-900 dark:text-white mb-2">
                      {tier === 'plus'
                        ? t('hub.reports.latestLockedTitle')
                        : t('hub.reports.premiumLockedTitle', { count: allReports.length - accessibleReports.length })}
                    </h4>
                    <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                      {tier === 'plus'
                        ? t('hub.reports.latestLockedDescription')
                        : t('hub.reports.premiumLockedDescription')}
                    </p>
                    <button
                      type="button"
                      onClick={() => setUpgradeDialogOpen(true)}
                      className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-blue-600 to-purple-600 px-4 py-2 text-sm font-medium text-white hover:from-blue-700 hover:to-purple-700 transition"
                    >
                      {t('hub.reports.upgradeTo', { plan: tier === 'plus' ? 'Pro' : 'Plus / Pro' })}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {hasMore && (
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                onClick={loadMore}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-6 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition"
              >
                {t("common.loadMore")}
              </button>
            </div>
          )}
        </>
      )}
      <UpgradeDialog open={upgradeDialogOpen} onOpenChange={setUpgradeDialogOpen} />
    </div>
  );
};
