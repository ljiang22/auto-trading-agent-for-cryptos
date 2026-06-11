import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router";
import LineChart from "@/components/admin/line-chart";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useTranslation } from "react-i18next";

function formatDurationSeconds(ms: number) {
    if (!ms || ms <= 0) {
        return 0;
    }
    return Math.round((ms / 1000) * 10) / 10;
}

const SEGMENT_COLORS = {
    anonymous: { border: "rgb(148, 163, 184)", fill: "rgba(148, 163, 184, 0.1)" },
    free: { border: "rgb(99, 102, 241)", fill: "rgba(99, 102, 241, 0.1)" },
    plus: { border: "rgb(34, 197, 94)", fill: "rgba(34, 197, 94, 0.1)" },
    pro: { border: "rgb(234, 179, 8)", fill: "rgba(234, 179, 8, 0.1)" },
};

const CHART_COLORS = {
    dau: { border: "rgb(99, 102, 241)", fill: "rgba(99, 102, 241, 0.1)" },
    messages: { border: "rgb(34, 197, 94)", fill: "rgba(34, 197, 94, 0.1)" },
    mainPageviews: { border: "rgb(56, 189, 248)", fill: "rgba(56, 189, 248, 0.1)" },
    mainVisitors: { border: "rgb(244, 114, 182)", fill: "rgba(244, 114, 182, 0.1)" },
    mainDuration: { border: "rgb(251, 191, 36)", fill: "rgba(251, 191, 36, 0.1)" },
    mainAuthLoggedIn: { border: "rgb(34, 197, 94)", fill: "rgba(34, 197, 94, 0.1)" },
    mainAuthAnonymous: { border: "rgb(148, 163, 184)", fill: "rgba(148, 163, 184, 0.1)" },
    signupVisitors: { border: "rgb(129, 140, 248)", fill: "rgba(129, 140, 248, 0.1)" },
    signupDuration: { border: "rgb(45, 212, 191)", fill: "rgba(45, 212, 191, 0.1)" },
    signupLinkSends: { border: "rgb(14, 116, 144)", fill: "rgba(14, 116, 144, 0.1)" },
    registrations: { border: "rgb(249, 115, 22)", fill: "rgba(249, 115, 22, 0.1)" },
    hourlyPageviews: { border: "rgb(14, 165, 233)", fill: "rgba(14, 165, 233, 0.1)" },
    hourlyDuration: { border: "rgb(250, 204, 21)", fill: "rgba(250, 204, 21, 0.1)" },
};

type ChartCardProps = {
    title: string;
    children: ReactNode;
};

function ChartCard({ title, children }: ChartCardProps) {
    return (
        <div className="rounded-lg border border-border p-4 sm:p-6">
            <h2 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4">{title}</h2>
            <div className="grid gap-4 sm:gap-6 xl:grid-cols-2">{children}</div>
        </div>
    );
}

type ChartBlockProps = {
    title: string;
    children: ReactNode;
};

function ChartBlock({ title, children }: ChartBlockProps) {
    return (
        <div className="flex flex-col gap-2 min-w-0">
            <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
            <div className="h-64 sm:h-72 xl:h-80">
                {children}
            </div>
        </div>
    );
}

type AnalyticsSummary = Awaited<ReturnType<typeof apiClient.getAnalyticsSummary>>;

type ReferralCodesData = Awaited<ReturnType<typeof apiClient.getReferralCodesToday>>;
type ReferralCodesLast30DaysData = Awaited<
    ReturnType<typeof apiClient.getReferralCodesLast30Days>
>;

export default function AdminAnalytics() {
    const { isAdmin, isLoading } = useAuth();
    const { t, i18n } = useTranslation();
    const query = useQuery<AnalyticsSummary>({
        queryKey: ["analytics-summary"],
        queryFn: () => apiClient.getAnalyticsSummary(),
        enabled: isAdmin,
        refetchOnWindowFocus: true,
    });

    const referralQuery = useQuery<ReferralCodesData>({
        queryKey: ["referral-codes-today"],
        queryFn: () => apiClient.getReferralCodesToday(),
        enabled: isAdmin,
        refetchOnWindowFocus: true,
    });
    const referralLast30DaysQuery = useQuery<ReferralCodesLast30DaysData>({
        queryKey: ["referral-codes-last-30-days"],
        queryFn: () => apiClient.getReferralCodesLast30Days(),
        enabled: isAdmin,
        refetchOnWindowFocus: true,
    });

    if (!isLoading && !isAdmin) {
        return <Navigate to="/" replace />;
    }

    if (!isAdmin) {
        return null;
    }

    const data = query.data;
    const referralData = referralQuery.data;
    const referralLast30DaysData = referralLast30DaysQuery.data;
    const metricLabel = (key: string): string => String(t(`adminAnalytics.metrics.${key}`));
    const chartLabel = (key: string): string => String(t(`adminAnalytics.charts.${key}`));
    const tableLabel = (key: string): string => String(t(`adminAnalytics.tables.${key}`));
    const formatNumber = (value: number): string => value.toLocaleString(i18n.language);
    const formatDurationDisplay = (ms: number): string =>
        new Intl.NumberFormat(i18n.language, {
            style: "unit",
            unit: "second",
            unitDisplay: "narrow",
            maximumFractionDigits: 1,
        }).format(formatDurationSeconds(ms));
    const mainDailyCumulative = data
        ? data.main.reduce(
              (acc, row) => {
                  const sessionsTotal = acc.lastSessions + row.sessions;
                  const visitorsTotal = acc.lastVisitors + row.visitors;
                  acc.rows.push({
                      day: row.day,
                      sessions: sessionsTotal,
                      visitors: visitorsTotal,
                  });
                  acc.lastSessions = sessionsTotal;
                  acc.lastVisitors = visitorsTotal;
                  return acc;
              },
              {
                  rows: [] as Array<{ day: string; sessions: number; visitors: number }>,
                  lastSessions: 0,
                  lastVisitors: 0,
              }
          ).rows
        : [];
    const registrationsDailyCumulative = data
        ? data.registrations.reduce(
              (acc, row) => {
                  const registrationsTotal = acc.lastRegistrations + row.registrations;
                  acc.rows.push({
                      day: row.day,
                      registrations: registrationsTotal,
                  });
                  acc.lastRegistrations = registrationsTotal;
                  return acc;
              },
              {
                  rows: [] as Array<{ day: string; registrations: number }>,
                  lastRegistrations: 0,
              }
          ).rows
        : [];
    const usageDailyCumulative = data
        ? data.usage.reduce(
              (acc, row) => {
                  const activeUsersTotal = acc.lastActiveUsers + row.activeUsers;
                  const messagesTotal = acc.lastMessages + row.messageCount;
                  acc.rows.push({
                      day: row.day,
                      activeUsers: activeUsersTotal,
                      messageCount: messagesTotal,
                  });
                  acc.lastActiveUsers = activeUsersTotal;
                  acc.lastMessages = messagesTotal;
                  return acc;
              },
              {
                  rows: [] as Array<{
                      day: string;
                      activeUsers: number;
                      messageCount: number;
                  }>,
                  lastActiveUsers: 0,
                  lastMessages: 0,
              }
          ).rows
        : [];

    return (
        <div className="flex flex-col gap-4 sm:gap-6 p-4 sm:p-6 lg:p-8 mx-auto w-full max-w-[1920px]">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl sm:text-2xl font-semibold">{t("adminAnalytics.title")}</h1>
                    <p className="text-sm text-muted-foreground">
                        {data?.generatedAt
                            ? t("adminAnalytics.generatedAt", {
                                value: new Date(data.generatedAt).toLocaleString(i18n.language),
                            })
                            : t("adminAnalytics.loadingLatestData")}
                    </p>
                </div>
            </div>

            {query.isLoading && (
                <div className="rounded-lg border border-border p-6 text-sm text-muted-foreground">
                    {t("adminAnalytics.loading")}
                </div>
            )}

            {query.isError && (
                <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6 text-sm text-destructive">
                    {t("adminAnalytics.loadFailed")}
                </div>
            )}

            {data && (
                <Tabs defaultValue="website" className="w-full">
                    <TabsList className="w-full justify-start overflow-x-auto">
                        <TabsTrigger value="website">{t("adminAnalytics.tabs.website")}</TabsTrigger>
                        <TabsTrigger value="users">{t("adminAnalytics.tabs.users")}</TabsTrigger>
                        <TabsTrigger value="referrals">{t("adminAnalytics.tabs.referrals")}</TabsTrigger>
                    </TabsList>
                    <TabsContent value="website" className="mt-4">
                        <div className="grid gap-4 sm:gap-6">
                            <ChartCard title={t("adminAnalytics.cards.mainPageDaily")}>
                                <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm xl:col-span-2">
                                    <span><span className="text-muted-foreground">{metricLabel("sessions")}:</span> <span className="font-semibold">{formatNumber(data.totals.main.sessions)}</span></span>
                                    <span><span className="text-muted-foreground">{metricLabel("visitors")}:</span> <span className="font-semibold">{formatNumber(data.totals.main.visitors)}</span></span>
                                    <span><span className="text-muted-foreground">{metricLabel("averageDuration")}:</span> <span className="font-semibold">{formatDurationDisplay(data.totals.main.avgDurationMs)}</span></span>
                                </div>
                                <ChartBlock title={chartLabel("dailyPageviewsMain")}>
                                    <LineChart
                                        labels={data.main.map((row) => row.day)}
                                        datasets={[
                                            {
                                                label: metricLabel("pageviews"),
                                                data: data.main.map((row) => row.sessions),
                                                borderColor: CHART_COLORS.mainPageviews.border,
                                                backgroundColor: CHART_COLORS.mainPageviews.fill,
                                            },
                                        ]}
                                    />
                                </ChartBlock>
                                <ChartBlock title={chartLabel("dailyVisitorsMain")}>
                                    <LineChart
                                        labels={data.main.map((row) => row.day)}
                                        datasets={[
                                            {
                                                label: metricLabel("visitors"),
                                                data: data.main.map((row) => row.visitors),
                                                borderColor: CHART_COLORS.mainVisitors.border,
                                                backgroundColor: CHART_COLORS.mainVisitors.fill,
                                            },
                                        ]}
                                    />
                                </ChartBlock>
                                <ChartBlock title={chartLabel("averageDurationMainSeconds")}>
                                    <LineChart
                                        labels={data.main.map((row) => row.day)}
                                        datasets={[
                                            {
                                                label: metricLabel("averageDurationSeconds"),
                                                data: data.main.map((row) => formatDurationSeconds(row.avgDurationMs)),
                                                borderColor: CHART_COLORS.mainDuration.border,
                                                backgroundColor: CHART_COLORS.mainDuration.fill,
                                            },
                                        ]}
                                    />
                                </ChartBlock>
                                <ChartBlock title={chartLabel("cumulativeSessionsVisitors")}>
                                    <LineChart
                                        labels={mainDailyCumulative.map((row) => row.day)}
                                        datasets={[
                                            {
                                                label: chartLabel("cumulativeSessions"),
                                                data: mainDailyCumulative.map((row) => row.sessions),
                                                borderColor: CHART_COLORS.mainPageviews.border,
                                                backgroundColor: CHART_COLORS.mainPageviews.fill,
                                            },
                                            {
                                                label: chartLabel("cumulativeVisitors"),
                                                data: mainDailyCumulative.map((row) => row.visitors),
                                                borderColor: CHART_COLORS.mainVisitors.border,
                                                backgroundColor: CHART_COLORS.mainVisitors.fill,
                                            },
                                        ]}
                                        showLegend
                                    />
                                </ChartBlock>
                            </ChartCard>

                            <ChartCard title={t("adminAnalytics.cards.mainPageAuthDaily")}>
                                <ChartBlock title={chartLabel("anonymousVsRegisteredVisitors")}>
                                    <LineChart
                                        labels={data.mainAuth.map((row) => row.day)}
                                        datasets={[
                                            {
                                                label: chartLabel("anonymousVisitors"),
                                                data: data.mainAuth.map((row) => row.anonymousVisitors),
                                                borderColor: CHART_COLORS.mainAuthAnonymous.border,
                                                backgroundColor: CHART_COLORS.mainAuthAnonymous.fill,
                                            },
                                            {
                                                label: chartLabel("registeredVisitors"),
                                                data: data.loggedInVisitors.map((row) => row.visitors),
                                                borderColor: CHART_COLORS.mainAuthLoggedIn.border,
                                                backgroundColor: CHART_COLORS.mainAuthLoggedIn.fill,
                                            },
                                        ]}
                                        showLegend
                                    />
                                </ChartBlock>
                                <ChartBlock title={metricLabel("averageDuration")}>
                                    <LineChart
                                        labels={data.mainAuth.map((row) => row.day)}
                                        datasets={[
                                            {
                                                label: chartLabel("anonymousVisitors"),
                                                data: data.mainAuth.map((row) => formatDurationSeconds(row.anonymousAvgDurationMs)),
                                                borderColor: CHART_COLORS.mainAuthAnonymous.border,
                                                backgroundColor: CHART_COLORS.mainAuthAnonymous.fill,
                                            },
                                            {
                                                label: chartLabel("registeredVisitors"),
                                                data: data.mainAuth.map((row) => formatDurationSeconds(row.loggedInAvgDurationMs)),
                                                borderColor: CHART_COLORS.mainAuthLoggedIn.border,
                                                backgroundColor: CHART_COLORS.mainAuthLoggedIn.fill,
                                            },
                                        ]}
                                        showLegend
                                    />
                                </ChartBlock>
                            </ChartCard>

                            <ChartCard title={t("adminAnalytics.cards.mainPageHourly")}>
                                <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm xl:col-span-2">
                                    <span><span className="text-muted-foreground">{metricLabel("sessions")}:</span> <span className="font-semibold">{formatNumber(data.hourlyMain.reduce((sum, r) => sum + r.sessions, 0))}</span></span>
                                    <span><span className="text-muted-foreground">{metricLabel("visitors")}:</span> <span className="font-semibold">{formatNumber(data.hourlyMain.reduce((sum, r) => sum + r.visitors, 0))}</span></span>
                                    <span><span className="text-muted-foreground">{metricLabel("averageDuration")}:</span> <span className="font-semibold">{formatDurationDisplay(data.hourlyMain.length > 0 ? data.hourlyMain.reduce((sum, r) => sum + r.avgDurationMs, 0) / data.hourlyMain.length : 0)}</span></span>
                                </div>
                                <ChartBlock title={chartLabel("hourlyPageviewsMain")}>
                                    <LineChart
                                        labels={data.hourlyMain.map((row) => row.hour)}
                                        datasets={[
                                            {
                                                label: chartLabel("hourlyPageviews"),
                                                data: data.hourlyMain.map((row) => row.sessions),
                                                borderColor: CHART_COLORS.hourlyPageviews.border,
                                                backgroundColor: CHART_COLORS.hourlyPageviews.fill,
                                            },
                                        ]}
                                    />
                                </ChartBlock>
                                <ChartBlock title={chartLabel("hourlyAverageDurationMain")}>
                                    <LineChart
                                        labels={data.hourlyMain.map((row) => row.hour)}
                                        datasets={[
                                            {
                                                label: metricLabel("averageDurationSeconds"),
                                                data: data.hourlyMain.map((row) => formatDurationSeconds(row.avgDurationMs)),
                                                borderColor: CHART_COLORS.hourlyDuration.border,
                                                backgroundColor: CHART_COLORS.hourlyDuration.fill,
                                            },
                                        ]}
                                    />
                                </ChartBlock>
                            </ChartCard>

                            <ChartCard title={t("adminAnalytics.cards.signupPageDaily")}>
                                <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm xl:col-span-2">
                                    <span><span className="text-muted-foreground">{metricLabel("pageviews")}:</span> <span className="font-semibold">{formatNumber(data.totals.signup.sessions)}</span></span>
                                    <span><span className="text-muted-foreground">{metricLabel("signupLinkSends")}:</span> <span className="font-semibold">{formatNumber(data.totals.signupLinkSends.linkSends)}</span></span>
                                </div>
                                <ChartBlock title={chartLabel("pageviewsVsSignupLinkSends")}>
                                    <LineChart
                                        labels={data.signup.map((row) => row.day)}
                                        datasets={[
                                            {
                                                label: metricLabel("pageviews"),
                                                data: data.signup.map((row) => row.sessions),
                                                borderColor: CHART_COLORS.signupVisitors.border,
                                                backgroundColor: CHART_COLORS.signupVisitors.fill,
                                            },
                                            {
                                                label: metricLabel("signupLinkSends"),
                                                data: data.signupLinkSends.map((row) => row.linkSends),
                                                borderColor: CHART_COLORS.signupLinkSends.border,
                                                backgroundColor: CHART_COLORS.signupLinkSends.fill,
                                            },
                                        ]}
                                        showLegend
                                    />
                                </ChartBlock>
                            </ChartCard>

                            <ChartCard title={t("adminAnalytics.cards.registerPageDaily")}>
                                <ChartBlock title={chartLabel("anonymousVsRegistrations")}>
                                    <LineChart
                                        labels={data.mainAuth.map((row) => row.day)}
                                        datasets={[
                                            {
                                                label: chartLabel("anonymousVisitors"),
                                                data: data.registerAnonymousVisitors.map((row) => row.visitors),
                                                borderColor: CHART_COLORS.mainAuthAnonymous.border,
                                                backgroundColor: CHART_COLORS.mainAuthAnonymous.fill,
                                            },
                                            {
                                                label: metricLabel("registrations"),
                                                data: data.registrations.map((row) => row.registrations),
                                                borderColor: CHART_COLORS.registrations.border,
                                                backgroundColor: CHART_COLORS.registrations.fill,
                                            },
                                        ]}
                                        showLegend
                                    />
                                </ChartBlock>
                                <ChartBlock title={chartLabel("signupLinkSendsVsRegistrations")}>
                                    <LineChart
                                        labels={data.registrations.map((row) => row.day)}
                                        datasets={[
                                            {
                                                label: metricLabel("signupLinkSends"),
                                                data: data.signupLinkSends.map((row) => row.linkSends),
                                                borderColor: CHART_COLORS.signupLinkSends.border,
                                                backgroundColor: CHART_COLORS.signupLinkSends.fill,
                                            },
                                            {
                                                label: metricLabel("registrations"),
                                                data: data.registrations.map((row) => row.registrations),
                                                borderColor: CHART_COLORS.registrations.border,
                                                backgroundColor: CHART_COLORS.registrations.fill,
                                            },
                                        ]}
                                        showLegend
                                    />
                                </ChartBlock>
                                <ChartBlock title={chartLabel("cumulativeRegistrations")}>
                                    <LineChart
                                        labels={registrationsDailyCumulative.map((row) => row.day)}
                                        datasets={[
                                            {
                                                label: chartLabel("cumulativeRegistrationsLabel"),
                                                data: registrationsDailyCumulative.map((row) => row.registrations),
                                                borderColor: CHART_COLORS.registrations.border,
                                                backgroundColor: CHART_COLORS.registrations.fill,
                                            },
                                        ]}
                                    />
                                </ChartBlock>
                            </ChartCard>
                        </div>
                    </TabsContent>
                    <TabsContent value="users" className="mt-4">
                        <div className="grid gap-4 sm:gap-6">
                            <ChartCard title={t("adminAnalytics.cards.allUsersDaily")}>
                                <ChartBlock title={chartLabel("cumulativeActiveUsersMessages")}>
                                    <LineChart
                                        labels={usageDailyCumulative.map((row) => row.day)}
                                        datasets={[
                                            {
                                                label: chartLabel("cumulativeActiveUsers"),
                                                data: usageDailyCumulative.map((row) => row.activeUsers),
                                                borderColor: CHART_COLORS.dau.border,
                                                backgroundColor: CHART_COLORS.dau.fill,
                                            },
                                            {
                                                label: chartLabel("cumulativeMessages"),
                                                data: usageDailyCumulative.map((row) => row.messageCount),
                                                borderColor: CHART_COLORS.messages.border,
                                                backgroundColor: CHART_COLORS.messages.fill,
                                            },
                                        ]}
                                        showLegend
                                    />
                                </ChartBlock>
                                <ChartBlock title={chartLabel("dailyActiveUsers")}>
                                    <LineChart
                                        labels={data.usage.map((row) => row.day)}
                                        datasets={[
                                            {
                                                label: metricLabel("activeUsers"),
                                                data: data.usage.map((row) => row.activeUsers),
                                                borderColor: CHART_COLORS.dau.border,
                                                backgroundColor: CHART_COLORS.dau.fill,
                                            },
                                        ]}
                                    />
                                </ChartBlock>
                                <ChartBlock title={chartLabel("dailyMessageCount")}>
                                    <LineChart
                                        labels={data.usage.map((row) => row.day)}
                                        datasets={[
                                            {
                                                label: metricLabel("messages"),
                                                data: data.usage.map((row) => row.messageCount),
                                                borderColor: CHART_COLORS.messages.border,
                                                backgroundColor: CHART_COLORS.messages.fill,
                                            },
                                        ]}
                                    />
                                </ChartBlock>
                            </ChartCard>

                            <ChartCard title={t("adminAnalytics.cards.anonymousUsersDaily")}>
                                <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm xl:col-span-2">
                                    <span><span className="text-muted-foreground">{metricLabel("activeUsers")}:</span> <span className="font-semibold">{formatNumber(data.totals.usageSegments.anonymous.activeUsers)}</span></span>
                                    <span><span className="text-muted-foreground">{metricLabel("messages")}:</span> <span className="font-semibold">{formatNumber(data.totals.usageSegments.anonymous.messageCount)}</span></span>
                                </div>
                                <ChartBlock title={chartLabel("dailyActiveUsers")}>
                                    <LineChart
                                        labels={data.usageSegments.anonymous.map((row) => row.day)}
                                        datasets={[
                                            {
                                                label: metricLabel("activeUsers"),
                                                data: data.usageSegments.anonymous.map((row) => row.activeUsers),
                                                borderColor: SEGMENT_COLORS.anonymous.border,
                                                backgroundColor: SEGMENT_COLORS.anonymous.fill,
                                            },
                                        ]}
                                    />
                                </ChartBlock>
                                <ChartBlock title={chartLabel("dailyMessageCount")}>
                                    <LineChart
                                        labels={data.usageSegments.anonymous.map((row) => row.day)}
                                        datasets={[
                                            {
                                                label: metricLabel("messages"),
                                                data: data.usageSegments.anonymous.map((row) => row.messageCount),
                                                borderColor: SEGMENT_COLORS.anonymous.border,
                                                backgroundColor: SEGMENT_COLORS.anonymous.fill,
                                            },
                                        ]}
                                    />
                                </ChartBlock>
                            </ChartCard>

                            <ChartCard title={t("adminAnalytics.cards.freeUsersDaily")}>
                                <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm xl:col-span-2">
                                    <span><span className="text-muted-foreground">{metricLabel("activeUsers")}:</span> <span className="font-semibold">{formatNumber(data.totals.usageSegments.free.activeUsers)}</span></span>
                                    <span><span className="text-muted-foreground">{metricLabel("messages")}:</span> <span className="font-semibold">{formatNumber(data.totals.usageSegments.free.messageCount)}</span></span>
                                </div>
                                <ChartBlock title={chartLabel("dailyActiveUsers")}>
                                    <LineChart
                                        labels={data.usageSegments.free.map((row) => row.day)}
                                        datasets={[
                                            {
                                                label: metricLabel("activeUsers"),
                                                data: data.usageSegments.free.map((row) => row.activeUsers),
                                                borderColor: SEGMENT_COLORS.free.border,
                                                backgroundColor: SEGMENT_COLORS.free.fill,
                                            },
                                        ]}
                                    />
                                </ChartBlock>
                                <ChartBlock title={chartLabel("dailyMessageCount")}>
                                    <LineChart
                                        labels={data.usageSegments.free.map((row) => row.day)}
                                        datasets={[
                                            {
                                                label: metricLabel("messages"),
                                                data: data.usageSegments.free.map((row) => row.messageCount),
                                                borderColor: SEGMENT_COLORS.free.border,
                                                backgroundColor: SEGMENT_COLORS.free.fill,
                                            },
                                        ]}
                                    />
                                </ChartBlock>
                            </ChartCard>

                            <ChartCard title={t("adminAnalytics.cards.plusUsersDaily")}>
                                <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm xl:col-span-2">
                                    <span><span className="text-muted-foreground">{metricLabel("activeUsers")}:</span> <span className="font-semibold">{formatNumber(data.totals.usageSegments.plus.activeUsers)}</span></span>
                                    <span><span className="text-muted-foreground">{metricLabel("messages")}:</span> <span className="font-semibold">{formatNumber(data.totals.usageSegments.plus.messageCount)}</span></span>
                                </div>
                                <ChartBlock title={chartLabel("dailyActiveUsers")}>
                                    <LineChart
                                        labels={data.usageSegments.plus.map((row) => row.day)}
                                        datasets={[
                                            {
                                                label: metricLabel("activeUsers"),
                                                data: data.usageSegments.plus.map((row) => row.activeUsers),
                                                borderColor: SEGMENT_COLORS.plus.border,
                                                backgroundColor: SEGMENT_COLORS.plus.fill,
                                            },
                                        ]}
                                    />
                                </ChartBlock>
                                <ChartBlock title={chartLabel("dailyMessageCount")}>
                                    <LineChart
                                        labels={data.usageSegments.plus.map((row) => row.day)}
                                        datasets={[
                                            {
                                                label: metricLabel("messages"),
                                                data: data.usageSegments.plus.map((row) => row.messageCount),
                                                borderColor: SEGMENT_COLORS.plus.border,
                                                backgroundColor: SEGMENT_COLORS.plus.fill,
                                            },
                                        ]}
                                    />
                                </ChartBlock>
                            </ChartCard>

                            <ChartCard title={t("adminAnalytics.cards.proUsersDaily")}>
                                <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm xl:col-span-2">
                                    <span><span className="text-muted-foreground">{metricLabel("activeUsers")}:</span> <span className="font-semibold">{formatNumber(data.totals.usageSegments.pro.activeUsers)}</span></span>
                                    <span><span className="text-muted-foreground">{metricLabel("messages")}:</span> <span className="font-semibold">{formatNumber(data.totals.usageSegments.pro.messageCount)}</span></span>
                                </div>
                                <ChartBlock title={chartLabel("dailyActiveUsers")}>
                                    <LineChart
                                        labels={data.usageSegments.pro.map((row) => row.day)}
                                        datasets={[
                                            {
                                                label: metricLabel("activeUsers"),
                                                data: data.usageSegments.pro.map((row) => row.activeUsers),
                                                borderColor: SEGMENT_COLORS.pro.border,
                                                backgroundColor: SEGMENT_COLORS.pro.fill,
                                            },
                                        ]}
                                    />
                                </ChartBlock>
                                <ChartBlock title={chartLabel("dailyMessageCount")}>
                                    <LineChart
                                        labels={data.usageSegments.pro.map((row) => row.day)}
                                        datasets={[
                                            {
                                                label: metricLabel("messages"),
                                                data: data.usageSegments.pro.map((row) => row.messageCount),
                                                borderColor: SEGMENT_COLORS.pro.border,
                                                backgroundColor: SEGMENT_COLORS.pro.fill,
                                            },
                                        ]}
                                    />
                                </ChartBlock>
                            </ChartCard>
                        </div>
                    </TabsContent>
                    <TabsContent value="referrals" className="mt-4">
                        <div className="grid gap-4 sm:gap-6">
                            <ChartCard title={t("adminAnalytics.cards.todayReferralUsage")}>
                                {referralQuery.isLoading && (
                                    <div className="text-sm text-muted-foreground xl:col-span-2">
                                        {t("adminAnalytics.referrals.loadingToday")}
                                    </div>
                                )}
                                {referralQuery.isError && (
                                    <div className="text-sm text-destructive xl:col-span-2">
                                        {t("adminAnalytics.referrals.loadTodayFailed")}
                                    </div>
                                )}
                                {referralData && (
                                    <>
                                        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm mb-4 xl:col-span-2">
                                            <span><span className="text-muted-foreground">{metricLabel("date")}:</span> <span className="font-semibold">{referralData.date}</span></span>
                                            <span><span className="text-muted-foreground">{metricLabel("totalCodes")}:</span> <span className="font-semibold">{referralData.summary.totalCodes}</span></span>
                                            <span><span className="text-muted-foreground">{metricLabel("sentPending")}:</span> <span className="font-semibold">{referralData.summary.totalPending}</span></span>
                                            <span><span className="text-muted-foreground">{metricLabel("sentCompleted")}:</span> <span className="font-semibold">{referralData.summary.totalCompleted}</span></span>
                                        </div>
                                        <div className="border rounded-lg overflow-x-auto xl:col-span-2">
                                            <table className="w-full">
                                                <thead className="bg-muted">
                                                    <tr>
                                                        <th className="px-4 py-3 text-left text-sm font-semibold">{tableLabel("referralCode")}</th>
                                                        <th className="px-4 py-3 text-center text-sm font-semibold">{tableLabel("sentPending")}</th>
                                                        <th className="px-4 py-3 text-center text-sm font-semibold">{tableLabel("sentCompleted")}</th>
                                                    </tr>
                                                </thead>
                                                <tbody className="divide-y divide-border">
                                                    {referralData.data.length === 0 ? (
                                                        <tr>
                                                            <td colSpan={3} className="px-4 py-8 text-center text-sm text-muted-foreground">
                                                                {t("adminAnalytics.referrals.noData")}
                                                            </td>
                                                        </tr>
                                                    ) : (
                                                        referralData.data.map((row, index) => (
                                                            <tr key={row.referralCode} className={index % 2 === 0 ? "bg-background" : "bg-muted/30"}>
                                                                <td className="px-4 py-3 text-sm font-mono">{row.referralCode}</td>
                                                                <td className="px-4 py-3 text-sm text-center">{row.pendingCount}</td>
                                                                <td className="px-4 py-3 text-sm text-center">{row.completedCount}</td>
                                                            </tr>
                                                        ))
                                                    )}
                                                </tbody>
                                            </table>
                                        </div>
                                    </>
                                )}
                            </ChartCard>
                            <ChartCard title={t("adminAnalytics.cards.referralUsageLast30Days")}>
                                {referralLast30DaysQuery.isLoading && (
                                    <div className="text-sm text-muted-foreground xl:col-span-2">
                                        {t("adminAnalytics.referrals.loadingLast30Days")}
                                    </div>
                                )}
                                {referralLast30DaysQuery.isError && (
                                    <div className="text-sm text-destructive xl:col-span-2">
                                        {t("adminAnalytics.referrals.loadLast30DaysFailed")}
                                    </div>
                                )}
                                {referralLast30DaysData && (
                                    <>
                                        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm mb-4 xl:col-span-2">
                                            <span><span className="text-muted-foreground">{metricLabel("range")}:</span> <span className="font-semibold">{referralLast30DaysData.range.from} ~ {referralLast30DaysData.range.to}</span></span>
                                            <span><span className="text-muted-foreground">{metricLabel("totalCodes")}:</span> <span className="font-semibold">{referralLast30DaysData.summary.totalCodes}</span></span>
                                            <span><span className="text-muted-foreground">{metricLabel("sentPending")}:</span> <span className="font-semibold">{referralLast30DaysData.summary.totalPending}</span></span>
                                            <span><span className="text-muted-foreground">{metricLabel("sentCompleted")}:</span> <span className="font-semibold">{referralLast30DaysData.summary.totalCompleted}</span></span>
                                        </div>
                                        <div className="border rounded-lg overflow-x-auto xl:col-span-2">
                                            <table className="w-full">
                                                <thead className="bg-muted">
                                                    <tr>
                                                        <th className="px-4 py-3 text-left text-sm font-semibold">{tableLabel("referralCode")}</th>
                                                        <th className="px-4 py-3 text-center text-sm font-semibold">{tableLabel("sentPending")}</th>
                                                        <th className="px-4 py-3 text-center text-sm font-semibold">{tableLabel("sentCompleted")}</th>
                                                    </tr>
                                                </thead>
                                                <tbody className="divide-y divide-border">
                                                    {referralLast30DaysData.data.length === 0 ? (
                                                        <tr>
                                                            <td colSpan={3} className="px-4 py-8 text-center text-sm text-muted-foreground">
                                                                {t("adminAnalytics.referrals.noData")}
                                                            </td>
                                                        </tr>
                                                    ) : (
                                                        referralLast30DaysData.data.map((row, index) => (
                                                            <tr key={row.referralCode} className={index % 2 === 0 ? "bg-background" : "bg-muted/30"}>
                                                                <td className="px-4 py-3 text-sm font-mono">{row.referralCode}</td>
                                                                <td className="px-4 py-3 text-sm text-center">{row.pendingCount}</td>
                                                                <td className="px-4 py-3 text-sm text-center">{row.completedCount}</td>
                                                            </tr>
                                                        ))
                                                    )}
                                                </tbody>
                                            </table>
                                        </div>
                                    </>
                                )}
                            </ChartCard>
                        </div>
                    </TabsContent>
                </Tabs>
            )}
        </div>
    );
}
