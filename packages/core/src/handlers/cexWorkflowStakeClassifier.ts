/**
 * Allowlist-based stake classifier. Maps an action name to either
 * read-only or write semantics; no LLM call, no runtime dependencies.
 *
 * preview_order is "read" in nature but is routed through the risk
 * pre-check path for parity (so users see the same risk surface
 * whether previewing or submitting). Callers gating UI affordances
 * may treat it as read-only via {@link isReadOnlyStake}.
 */

export type Stake = "read_only" | "write";

const READ_ONLY_ACTIONS = new Set<string>([
    "get_balance",
    "get_orders",
    "get_fills",
    "get_trading_mode",
    // Fix 8 — read-only view of user-editable asset lists.
    "list_asset_lists",
    // Fix 13 — per-position view + PnL across futures / margin wallets.
    "get_positions",
    "get_pnl",
    // Fix 15 — instant ticker + order-book lookup (public Binance endpoints).
    "get_ticker",
    "get_orderbook",
]);

const WRITE_ACTIONS = new Set<string>([
    "create_order",
    "cancel_order",
    "amend_order",
    "preview_order",
    "set_trading_mode",
    // Fix 8 — user-editable asset allowlist + blocklist mutations.
    "add_blocked_asset",
    "remove_blocked_asset",
    "add_allowed_asset",
    "remove_allowed_asset",
]);

/**
 * Returns the stake for a known action name. Unknown actions
 * default to `"write"` to fail closed — the approval flow runs and
 * surfaces the unknown action to the user.
 */
export function classifyStake(action: string): Stake {
    if (READ_ONLY_ACTIONS.has(action)) return "read_only";
    if (WRITE_ACTIONS.has(action)) return "write";
    return "write";
}

export function isReadOnlyStake(stake: Stake): boolean {
    return stake === "read_only";
}

export function knownActionNames(): { read_only: string[]; write: string[] } {
    return {
        read_only: [...READ_ONLY_ACTIONS],
        write: [...WRITE_ACTIONS],
    };
}
