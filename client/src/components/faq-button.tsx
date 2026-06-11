import { HelpCircle } from "lucide-react";
import { SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar";

export default function FaqButton() {
    return (
        <SidebarMenuItem>
            <SidebarMenuButton
                type="button"
                data-tour="sidebar-faq"
                onClick={() => {
                    if (typeof window === "undefined") {
                        return;
                    }
                    try {
                        const opened = window.open("/faq", "_blank", "noopener,noreferrer");
                        if (opened) {
                            opened.opener = null;
                        }
                    } catch {
                        // ignore
                    }
                }}
            >
                <HelpCircle className="size-4" />
                <span className="text-sm group-data-[collapsible=icon]:hidden">FAQ</span>
            </SidebarMenuButton>
        </SidebarMenuItem>
    );
}
