import { useState } from "react";
import { Share2 } from "lucide-react";
import { SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar";
import { ReferralDialog } from "./ReferralDialog";
import { useAuth } from "@/contexts/AuthContext";
import { useTranslation } from "react-i18next";

export default function ShareWithFriendsButton() {
    const [open, setOpen] = useState(false);
    const { isAuthenticated } = useAuth();
    const { t } = useTranslation();

    // Only show share button for authenticated users
    if (!isAuthenticated) {
        return null;
    }

    return (
        <SidebarMenuItem>
            <SidebarMenuButton data-tour="sidebar-share" onClick={() => setOpen(true)}>
                <Share2 className="size-4" />
                <span className="text-sm group-data-[collapsible=icon]:hidden">{t("sidebar.shareWithFriends")}</span>
            </SidebarMenuButton>
            <ReferralDialog open={open} onOpenChange={setOpen} />
        </SidebarMenuItem>
    );
}
