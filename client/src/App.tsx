import "./index.css";
import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "./components/app-sidebar";
import { TooltipProvider } from "./components/ui/tooltip";
import { Toaster } from "./components/ui/toaster";
import { BrowserRouter, Route, Routes } from "react-router";
// Route-level code splitting (Fix 6 — mobile-performance audit). Each route
// becomes its own chunk so authenticated users don't pay the bundle cost of
// admin/landing/onboarding/etc. on first load. Static imports above kept
// shipping all 13 routes in the 1.6 MB main chunk.
const Chat = lazy(() => import("./routes/chat"));
const Overview = lazy(() => import("./routes/overview"));
const Home = lazy(() => import("./routes/home"));
const LandingPage = lazy(() => import("./routes/landing"));
const HubPage = lazy(() => import("./routes/hub"));
const FAQ = lazy(() => import("./routes/faq"));
const SharedChatRoute = lazy(() => import("./routes/shared-chat"));
const SharedRoomRoute = lazy(() => import("./routes/shared-room"));
const SignIn = lazy(() => import("./routes/signin"));
const SignUp = lazy(() => import("./routes/signup"));
const Register = lazy(() => import("./routes/register"));
const AdminAnalytics = lazy(() => import("./routes/admin-analytics"));
const DailyReportPage = lazy(() => import("./routes/daily-report"));
const OrdersPage = lazy(() => import("./routes/orders"));
const StrategiesPage = lazy(() => import("./routes/strategies"));
// §7.8 — consent modal must be mounted somewhere a user can see it before
// flipping `default_mode=live`. (§7.9 NotificationCenter moved inside
// UserButton — see comment in the AppShell return below.)
const LiveTradingConsentModal = lazy(() =>
    import("./components/cex/LiveTradingConsentModal").then((m) => ({
        default: m.LiveTradingConsentModal,
    })),
);
// §7.2 — sticky kill-switch banner. Always-mounted (renders null when inactive)
// so the user sees the pause state from anywhere in the app, not only inside
// the trading-prefs tab.
const KillSwitchBanner = lazy(() =>
    import("./components/cex/KillSwitchBanner").then((m) => ({
        default: m.KillSwitchBanner,
    })),
);
import { ThinkingBubbleProvider } from "./contexts/ThinkingBubbleContext";
import { AuthProvider } from "./contexts/AuthContext";
import { Toaster as SonnerToaster } from "sonner";
import { UserButton } from "./components/UserButton";
import { ThemeProvider, useTheme } from "./contexts/ThemeContext";
import { cn } from "./lib/utils";
import { TableOfContentsProvider } from "./contexts/TableOfContentsContext";
import AnalyticsTracker from "./components/AnalyticsTracker";
import { MantleWalletProvider } from "./components/mantle/MantleWalletProvider";
import { LanguageProvider } from "./contexts/LanguageContext";
// OnboardingTour ships ~300 lines + demo PNGs and is only used on first
// visit / when the user explicitly re-runs the tour. Lazy so it doesn't
// pay for itself on every route render for returning users.
const OnboardingTour = lazy(() => import("./components/OnboardingTour"));

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: Number.POSITIVE_INFINITY,
        },
    },
});

function AppShell() {
    const { theme } = useTheme();

    return (
        <div
            className={cn(
                "antialiased transition-colors duration-300",
                "min-h-dvh w-full",
                "bg-background text-foreground",
                theme === "dark" && "dark"
            )}
            style={{ colorScheme: theme }}
        >
            <BrowserRouter>
                <AnalyticsTracker />
                <TooltipProvider delayDuration={0}>
                    <Suspense fallback={<div className="flex h-dvh w-full items-center justify-center text-muted-foreground" />}>
                        <Routes>
                            {/* Authentication routes - no sidebar */}
                            <Route path="/signin" element={<SignIn />} />
                            <Route path="/signup" element={<SignUp />} />
                            <Route path="/signup/:regToken" element={<Register />} />
                            <Route path="/register/:regToken" element={<Register />} />

                            {/* Standalone pages - no sidebar */}
                            <Route path="/faq" element={<FAQ />} />
                            <Route path="/shared/chat/:shareCode" element={<SharedChatRoute />} />
                            <Route path="/shared/room/:agentId/:roomId" element={<SharedRoomRoute />} />

                            {/* Main app routes - with sidebar, publicly accessible */}
                            <Route
                                path="/*"
                                element={
                                    <SidebarProvider>
                                        {/* OnboardingTour is lazy; render nothing while it loads. */}
                                        <Suspense fallback={null}>
                                            <OnboardingTour />
                                        </Suspense>
                                        <TableOfContentsProvider>
                                            <AppSidebar />
                                            <SidebarInset className="pl-[20px]">
                                                <div className="flex flex-1 flex-col h-dvh w-full">
                                                    <div className="flex flex-1 flex-col min-h-0 w-full">
                                                        <Suspense fallback={<div className="flex flex-1 items-center justify-center text-muted-foreground" />}>
                                                            <Routes>
                                                                <Route path="/" element={<LandingPage />} />
                                                                <Route path="/hub" element={<HubPage />} />
                                                                <Route path="/agents" element={<Home />} />
                                                                <Route path="/admin/analytics" element={<AdminAnalytics />} />
                                                                <Route path="/report/daily" element={<DailyReportPage />} />
                                                                <Route path="/orders" element={<OrdersPage />} />
                                                                <Route path="/strategies" element={<StrategiesPage />} />
                                                                <Route path="chat/:agentId/:roomId" element={<Chat />} />
                                                                <Route path="chat/:agentId" element={<Chat />} />
                                                                <Route path="settings/:agentId" element={<Overview />} />
                                                            </Routes>
                                                        </Suspense>
                                                    </div>
                                                </div>
                                            </SidebarInset>
                                        </TableOfContentsProvider>
                                    </SidebarProvider>
                                }
                            />
                        </Routes>
                    </Suspense>
                    <UserButton />
                    <Toaster />
                    <SonnerToaster />
                    <Suspense fallback={null}>
                        {/* §7.8 — Live-trading consent modal. Self-mounts
                            when the user attempts to set default_mode=live
                            without an accepted v1 consent row. */}
                        <LiveTradingConsentModal />
                        {/* §7.2 — sticky kill-switch banner. Self-renders
                            null when kill-switch is off. */}
                        <KillSwitchBanner />
                        {/* §7.9 — Notification bell now renders INSIDE the
                            authenticated `<UserButton />` flex container so
                            it sits side-by-side with the Share button and
                            the user-info chip with a natural `gap-2`. The
                            previous fixed-position mount (top-2 right-16)
                            collided with the user-info chip on long emails
                            — `jiang2015leon@gmail.com` is wide enough to
                            extend past the 4rem offset and the bell
                            overlapped the "@" sign. The bell is auth-only
                            anyway (`/user/notifications` requires auth);
                            moving it into UserButton tracks that lifetime
                            naturally. */}
                    </Suspense>
                </TooltipProvider>
            </BrowserRouter>
        </div>
    );
}

function App() {
    return (
        <QueryClientProvider client={queryClient}>
            <AuthProvider>
                <LanguageProvider>
                    <ThemeProvider>
                        <MantleWalletProvider>
                            <ThinkingBubbleProvider>
                                <AppShell />
                            </ThinkingBubbleProvider>
                        </MantleWalletProvider>
                    </ThemeProvider>
                </LanguageProvider>
            </AuthProvider>
        </QueryClientProvider>
    );
}

export default App;
