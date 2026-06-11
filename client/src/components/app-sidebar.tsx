import { useQuery } from "@tanstack/react-query";
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarMenuSkeleton,
    SidebarTrigger,
    useSidebar,
} from "@/components/ui/sidebar";
import { apiClient } from "@/lib/api";
import { NavLink, useLocation, useNavigate } from "react-router";
import type { UUID } from "@elizaos/core";
import { useTheme } from "@/contexts/ThemeContext";
import { useSubscriptionTier } from "@/hooks/useSubscriptionTier";
import { BarChart3, LayoutGrid } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

import { RoomSelector } from "./room-selector";
import FeedbackButton from "./feedback-button";
import FaqButton from "./faq-button";
import ShareWithFriendsButton from "./share-with-friends-button";
import TakeATourButton from "./take-a-tour-button";
import { ModeBadge } from "./cex/ModeBadge";
import { KillSwitchToggle } from "./cex/KillSwitchToggle";

export function AppSidebar() {
    const location = useLocation();
    const navigate = useNavigate();
    const { theme } = useTheme();
    const { tier } = useSubscriptionTier();
    const { isMobile, setOpenMobile } = useSidebar();
    const { isAdmin } = useAuth();
    const { t } = useTranslation();
    const query = useQuery({
        queryKey: ["agents"],
        queryFn: () => apiClient.getAgents(),
        staleTime: Number.POSITIVE_INFINITY, // Never consider data stale
        refetchOnWindowFocus: false, // Don't refetch when user returns to tab
        refetchOnMount: false, // Don't refetch on component remount
        refetchOnReconnect: false, // Don't refetch on network reconnect
        // Only fetches once on initial page load. User must refresh page (F5) to see changes after server restart.
    });

    const agents = query?.data?.agents;
    const iconSrc = theme === "light" ? "/sentiedge-icon.jpg" : "/sentiedge-icon.png";
    const isHubActive = location.pathname === "/hub";

    // Get gradient class based on tier
    const getGradientClass = () => {
        if (tier === 'pro') return 'pro-gradient-border';
        if (tier === 'plus') return 'plus-gradient-border';
        if (tier === 'enterprise') return 'enterprise-gradient-border';
        return '';
    };

    return (
        <Sidebar collapsible="icon" className={getGradientClass()}>
            <SidebarHeader className="pb-4">
                <div className="flex items-center gap-2 group-data-[collapsible=icon]:justify-center">
                    <SidebarMenu className="flex-1 group-data-[collapsible=icon]:flex-none">
                        <SidebarMenuItem>
                            <SidebarMenuButton size="lg" asChild>
                                <NavLink
                                    to="/"
                                    className="flex items-center py-3 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:py-2"
                                    onClick={(e) => {
                                        if (isMobile) {
                                            e.preventDefault();
                                            navigate("/");
                                            setOpenMobile(false);
                                        }
                                    }}
                                >
                                    <img
                                        alt="SentiEdge"
                                        src={iconSrc}
                                        className="w-8 h-6.5 group-data-[collapsible=icon]:mr-0 mr-3 mt-1 group-data-[collapsible=icon]:mt-0"
                                    />

                                    <div className="flex flex-col leading-tight mt-1 group-data-[collapsible=icon]:hidden">
                                        <div className="flex items-center gap-2">
                                            <span className="font-semibold text-lg">
                                                SentiEdge
                                            </span>
                                            {tier && tier !== 'free' && (
                                                <span
                                                    className="px-2 py-0.5 text-xs font-semibold rounded-full text-white"
                                                    style={{
                                                        background: tier === 'pro'
                                                            ? 'linear-gradient(135deg, #ff9db0 0%, #d89fd8 50%, #a8c5e8 100%)'
                                                            : tier === 'plus'
                                                            ? 'linear-gradient(135deg, #10b981 0%, #14b8a6 50%, #06b6d4 100%)'
                                                            : 'linear-gradient(135deg, #3b82f6 0%, #6366f1 50%, #8b5cf6 100%)'
                                                    }}
                                                >
                                                    {tier.toUpperCase()}
                                                </span>
                                            )}
                                        </div>
                                        <span className="text-sm text-muted-foreground">
                                            v3.1.0
                                        </span>
                                    </div>
                                </NavLink>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    </SidebarMenu>
                    <SidebarTrigger
                        data-tour="sidebar-toggle"
                        className="mr-2 group-data-[collapsible=icon]:mr-0 group-data-[collapsible=icon]:hidden"
                    />
                </div>
                <div className="hidden group-data-[collapsible=icon]:flex justify-center pt-2">
                    <SidebarTrigger data-tour="sidebar-toggle" />
                </div>
                {/* §7.1 + §7.2 — trading mode + kill switch, always visible. */}
                <div className="px-2 mt-2 flex items-center justify-between gap-2 group-data-[collapsible=icon]:hidden">
                    <ModeBadge />
                    <KillSwitchToggle variant="compact" />
                </div>
            </SidebarHeader>
            <SidebarContent>
                <SidebarGroup className="group-data-[collapsible=icon]:hidden">
                    <SidebarGroupLabel className="text-xs font-medium px-2 mb-1">{t("common.navigation")}</SidebarGroupLabel>
                    <SidebarGroupContent>
                        <SidebarMenu className="space-y-0.5 px-1">
                            <SidebarMenuItem>
                                <SidebarMenuButton asChild>
                                    <NavLink
                                        id="tour-hub"
                                        to="/hub"
                                        className={cn(
                                            "flex items-center gap-2 rounded-md px-2 py-1.5 transition-all border",
                                            isHubActive
                                                ? "border-white/40 bg-white/30 text-foreground shadow-[0_4px_6px_-1px_rgba(0,0,0,0.1),0_2px_4px_-1px_rgba(0,0,0,0.06)] supports-[backdrop-filter]:backdrop-blur-md supports-[backdrop-filter]:bg-white/20 dark:border-white/15 dark:bg-white/10 dark:supports-[backdrop-filter]:bg-white/10"
                                                : "border-transparent [@media(hover:hover)]:hover:border-white/20 [@media(hover:hover)]:hover:bg-white/10 supports-[backdrop-filter]:[@media(hover:hover)]:hover:bg-white/10 dark:[@media(hover:hover)]:hover:bg-white/5 active:bg-white/10 dark:active:bg-white/5"
                                        )}
                                        onClick={(e) => {
                                            if (isMobile) {
                                                e.preventDefault();
                                                navigate("/hub");
                                                setOpenMobile(false);
                                            }
                                        }}
                                    >
                                        <LayoutGrid className="h-4 w-4" />
                                        <span>{t("common.hub")}</span>
                                    </NavLink>
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
                <SidebarGroup>
                    <SidebarGroupLabel className="text-xs font-medium px-2 mb-1">{t("common.agents")}</SidebarGroupLabel>
                    <SidebarGroupContent>
                        <SidebarMenu className="space-y-0.5 px-1">
                            {query?.isPending ? (
                                <div className="space-y-1">
                                    {Array.from({ length: 5 }).map(
                                        (_, index) => (
                                            <SidebarMenuItem key={`skeleton-item-${index}`}>
                                                <SidebarMenuSkeleton />
                                            </SidebarMenuItem>
                                        )
                                    )}
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {agents?.map(
                                        (agent: { id: UUID; name: string }, index: number) => (
                                            <SidebarMenuItem key={agent.id} className="list-none">
                                                <RoomSelector
                                                    agentId={agent.id}
                                                    agentName={agent.name}
                                                    isFirstAgent={index === 0}
                                                />
                                            </SidebarMenuItem>
                                        )
                                    )}
                                </div>
                            )}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
            </SidebarContent>
            <SidebarFooter>
                <SidebarMenu>
                    {isAdmin && (
                        <SidebarMenuItem>
                            <SidebarMenuButton asChild>
                                <NavLink
                                    to="/admin/analytics"
                                    className="flex items-center gap-2"
                                    onClick={() => {
                                        if (isMobile) {
                                            setOpenMobile(false);
                                        }
                                    }}
                                >
                                    <BarChart3 className="h-4 w-4" />
                                    <span>{t("common.adminAnalytics")}</span>
                                </NavLink>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    )}
                    <ShareWithFriendsButton />
                    <FeedbackButton />
                    <TakeATourButton />
                    <FaqButton />
                </SidebarMenu>
            </SidebarFooter>
        </Sidebar>
    );
}
