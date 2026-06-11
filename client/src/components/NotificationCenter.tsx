import { useState } from "react";
import { Bell, Check } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";

type Notification = {
    id: string;
    userId: string;
    kind: string;
    request_id?: string;
    title: string;
    body?: string;
    severity?: "info" | "warn" | "error";
    read?: boolean;
    createdAt: string;
};

/**
 * §7.9 — Notification center. Polled-only for v1 (SSE stream landed
 * behind PUBLIC follow-up — the `/user/notifications/stream` endpoint is
 * a planned add; this hook falls back to a 15s poll which is sufficient
 * for the kill-switch / fail-closed / reconciliation events that are the
 * primary consumers).
 *
 * Round-6c — accepts an optional `triggerClassName` so the caller can
 * inject chrome (glassmorphism + h-9 sizing) that matches the
 * neighboring Share / user-menu chips when the bell is mounted inside
 * the `UserButton` flex row. Default styling preserved for any
 * standalone call site.
 */
export interface NotificationCenterProps {
    triggerClassName?: string;
}

export function NotificationCenter({ triggerClassName }: NotificationCenterProps = {}) {
    const [open, setOpen] = useState(false);
    const qc = useQueryClient();
    const query = useQuery({
        queryKey: ["user", "notifications"],
        queryFn: async () => {
            const r = await apiClient.listNotifications({ limit: 50 });
            return r.notifications as unknown as Notification[];
        },
        refetchInterval: 15_000,
    });
    const markRead = useMutation({
        mutationFn: async (id: string) => apiClient.markNotificationRead(id),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["user", "notifications"] });
        },
    });

    const items = query.data ?? [];
    const unread = items.filter((n) => !n.read).length;

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    aria-label="Notifications"
                    data-testid="notification-bell"
                    className={
                        triggerClassName ??
                        "relative inline-flex items-center justify-center size-8 rounded-md hover:bg-muted transition-colors"
                    }
                >
                    <Bell className="size-4" />
                    {unread > 0 && (
                        <span className="absolute -top-1 -right-1 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-[10px] text-white">
                            {unread > 99 ? "99+" : unread}
                        </span>
                    )}
                </button>
            </PopoverTrigger>
            <PopoverContent
                align="end"
                className="w-80 p-0 max-h-[420px] overflow-y-auto"
            >
                <div className="px-3 py-2 border-b border-border flex items-center justify-between">
                    <span className="text-sm font-medium">Notifications</span>
                    {unread > 0 && (
                        <button
                            type="button"
                            onClick={() => {
                                for (const n of items.filter((x) => !x.read)) {
                                    markRead.mutate(n.id);
                                }
                            }}
                            className="text-xs text-muted-foreground hover:text-foreground"
                        >
                            Mark all read
                        </button>
                    )}
                </div>
                {items.length === 0 ? (
                    <div className="p-4 text-sm text-muted-foreground text-center">
                        No notifications.
                    </div>
                ) : (
                    <ul className="divide-y divide-border">
                        {items.map((n) => (
                            <li
                                key={n.id}
                                className={cn(
                                    "p-3 hover:bg-muted/40 transition-colors",
                                    !n.read && "bg-muted/20",
                                )}
                            >
                                <div className="flex items-start justify-between gap-2">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <SeverityDot severity={n.severity} />
                                            <span className="text-sm font-medium truncate">
                                                {n.title}
                                            </span>
                                        </div>
                                        {n.body && (
                                            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                                                {n.body}
                                            </p>
                                        )}
                                        <span className="mt-1 block text-[10px] text-muted-foreground">
                                            {new Date(n.createdAt).toLocaleString()}
                                        </span>
                                    </div>
                                    {!n.read && (
                                        <button
                                            type="button"
                                            onClick={() => markRead.mutate(n.id)}
                                            aria-label="Mark as read"
                                            className="p-1 rounded hover:bg-muted"
                                        >
                                            <Check className="size-3.5" />
                                        </button>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </PopoverContent>
        </Popover>
    );
}

function SeverityDot({ severity }: { severity?: "info" | "warn" | "error" }) {
    const cls =
        severity === "error"
            ? "bg-rose-500"
            : severity === "warn"
              ? "bg-amber-400"
              : "bg-emerald-400";
    return <span className={cn("inline-block size-2 rounded-full", cls)} aria-hidden />;
}
