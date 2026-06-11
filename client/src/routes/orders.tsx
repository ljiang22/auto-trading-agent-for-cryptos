import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { cn } from "@/lib/utils";
import { displayId } from "@/lib/truncateId";
import { ModeBadge } from "@/components/cex/ModeBadge";

type LedgerRow = {
    request_id: string;
    client_order_id: string;
    venue: string;
    symbol: string;
    state: string;
    submittedAt: string;
    lastSeenAt: string;
    locale?: string;
};

const STATE_BADGE: Record<string, string> = {
    submitted: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
    acked: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
    partially_filled: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    filled: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
    cancelled: "bg-slate-100 text-slate-700 dark:bg-slate-800/40 dark:text-slate-300",
    expired: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800/40 dark:text-zinc-300",
    rejected: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
    reconciliation_failed: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
    unknown: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
};

const STATE_LABEL: Record<string, string> = {
    submitted: "pending",
    acked: "submitted",
    partially_filled: "partially filled",
    filled: "filled",
    cancelled: "canceled",
    expired: "expired",
    rejected: "failed",
    reconciliation_failed: "failed",
    unknown: "unknown",
};

const FILTERS: Array<{ value: string; label: string }> = [
    { value: "", label: "All" },
    { value: "submitted", label: "Pending" },
    { value: "acked", label: "Submitted" },
    { value: "partially_filled", label: "Partial" },
    { value: "filled", label: "Filled" },
    { value: "cancelled", label: "Canceled" },
    { value: "rejected", label: "Failed" },
    { value: "unknown", label: "Unknown" },
];

function StatusBadge({ state }: { state: string }) {
    const cls = STATE_BADGE[state] ?? "bg-muted text-muted-foreground";
    return (
        <span
            className={cn(
                "inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ring-1",
                cls,
            )}
        >
            {STATE_LABEL[state] ?? state}
        </span>
    );
}

function TruncatedId({ value }: { value: string }) {
    const [copied, setCopied] = useState(false);
    const head = displayId(value);
    return (
        <button
            type="button"
            onClick={(e) => {
                e.preventDefault();
                void navigator.clipboard?.writeText(value);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
            }}
            className="font-mono text-xs text-muted-foreground hover:text-foreground transition-colors"
            title={`Copy ${value}`}
        >
            {copied ? "copied" : head}
        </button>
    );
}

function CancelChip({ orderId, venue }: { orderId: string; venue: string | null }) {
    return (
        <button
            type="button"
            data-testid="orders-row-cancel"
            onClick={() => {
                const venueClause = venue ? ` on ${venue}` : "";
                window.dispatchEvent(
                    new CustomEvent("sentiedge:chat-send", {
                        detail: { text: `cancel order ${orderId}${venueClause}`, source: "orders_page" },
                    }),
                );
            }}
            className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-rose-50 text-rose-700 hover:bg-rose-100 dark:bg-rose-900/30 dark:text-rose-300 dark:hover:bg-rose-900/50 ring-1 ring-rose-300/40 transition-colors"
        >
            Cancel
        </button>
    );
}

const OPEN_STATES = new Set(["submitted", "acked", "partially_filled", "unknown"]);

export default function OrdersPage() {
    const [stateFilter, setStateFilter] = useState<string>("");
    const [venueFilter, setVenueFilter] = useState<string>("");

    const query = useQuery({
        queryKey: ["user", "orders", { stateFilter, venueFilter }],
        queryFn: async () => {
            const res = await apiClient.listOrders({
                limit: 200,
                state: stateFilter || undefined,
                venue: venueFilter || undefined,
            });
            return res.orders as unknown as LedgerRow[];
        },
        refetchInterval: 15_000,
    });

    const orders = useMemo(() => query.data ?? [], [query.data]);

    return (
        <div className="p-6 max-w-6xl mx-auto">
            <div className="flex items-center justify-between gap-3 mb-4">
                <h1 className="text-2xl font-semibold">Orders</h1>
                <ModeBadge />
            </div>

            <div className="flex flex-wrap gap-2 mb-3">
                {FILTERS.map((f) => (
                    <button
                        key={f.value}
                        type="button"
                        onClick={() => setStateFilter(f.value)}
                        className={cn(
                            "px-2.5 py-1 rounded-full text-xs ring-1 transition-colors",
                            stateFilter === f.value
                                ? "bg-foreground text-background ring-foreground"
                                : "bg-transparent ring-border text-muted-foreground hover:text-foreground",
                        )}
                    >
                        {f.label}
                    </button>
                ))}
            </div>

            <div className="mb-3">
                <select
                    value={venueFilter}
                    onChange={(e) => setVenueFilter(e.target.value)}
                    className="bg-card border border-border rounded-md text-sm px-2 py-1"
                >
                    <option value="">All venues</option>
                    <option value="binance">Binance</option>
                    <option value="coinbase">Coinbase</option>
                    <option value="paper">Paper</option>
                </select>
            </div>

            {query.isLoading ? (
                <p className="text-muted-foreground text-sm">Loading…</p>
            ) : orders.length === 0 ? (
                <p className="text-muted-foreground text-sm">No orders yet.</p>
            ) : (
                <div className="overflow-x-auto rounded-md border border-border" data-testid="orders-table">
                    <table className="w-full text-sm">
                        <thead className="text-xs uppercase tracking-wider text-muted-foreground bg-muted/30">
                            <tr>
                                <th className="text-left px-3 py-2">State</th>
                                <th className="text-left px-3 py-2">Venue</th>
                                <th className="text-left px-3 py-2">Symbol</th>
                                <th className="text-left px-3 py-2">Client order ID</th>
                                <th className="text-left px-3 py-2">Submitted</th>
                                <th className="text-left px-3 py-2">Last seen</th>
                                <th className="text-right px-3 py-2"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {orders.map((o) => (
                                <tr
                                    key={o.client_order_id}
                                    data-testid="orders-row"
                                    className="border-t border-border hover:bg-muted/20 transition-colors"
                                >
                                    <td className="px-3 py-2">
                                        <StatusBadge state={o.state} />
                                    </td>
                                    <td className="px-3 py-2 text-xs">{o.venue}</td>
                                    <td className="px-3 py-2 font-mono text-xs">{o.symbol}</td>
                                    <td className="px-3 py-2">
                                        <TruncatedId value={o.client_order_id} />
                                    </td>
                                    <td className="px-3 py-2 text-xs text-muted-foreground">
                                        {new Date(o.submittedAt).toLocaleString()}
                                    </td>
                                    <td className="px-3 py-2 text-xs text-muted-foreground">
                                        {new Date(o.lastSeenAt).toLocaleString()}
                                    </td>
                                    <td className="px-3 py-2 text-right">
                                        {OPEN_STATES.has(o.state) && o.state !== "unknown" ? (
                                            <CancelChip orderId={o.client_order_id} venue={o.venue} />
                                        ) : null}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
