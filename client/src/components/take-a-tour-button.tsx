import { Compass } from "lucide-react";
import { SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar";

export default function TakeATourButton() {
    return (
        <SidebarMenuItem>
            <SidebarMenuButton
                data-tour="sidebar-tour"
                onClick={() => {
                    try {
                        window.dispatchEvent(
                            new CustomEvent("sentiedge:onboarding:start", {
                                detail: { tourId: "main" },
                            })
                        );
                    } catch {
                        // ignore
                    }
                }}
            >
                <Compass className="size-4" />
                <span className="text-sm group-data-[collapsible=icon]:hidden">Take a tour</span>
            </SidebarMenuButton>
        </SidebarMenuItem>
    );
}
