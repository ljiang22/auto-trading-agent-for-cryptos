import { describe, expect, it } from "vitest";
import {
    cancelOrderAction,
    createOrderAction,
    getBalanceAction,
    getFillsAction,
    getOrdersAction,
    tradeActions,
} from "../src/actions/index";

describe("plugin-cex actions index", () => {
    it("exports all trading actions (including Phase 4-5 meta actions)", () => {
        const names = tradeActions.map((action) => action.name);
        expect(names).toEqual([
            "get_balance",
            "get_orders",
            "create_order",
            "cancel_order",
            "get_fills",
            "compile_strategy",
            "run_backtest",
            "set_trading_mode",
            "get_trading_mode",
            // Fix 8 — user-editable asset allowlist + blocklist.
            "add_blocked_asset",
            "remove_blocked_asset",
            "add_allowed_asset",
            "remove_allowed_asset",
            "list_asset_lists",
            // Fix 13 — per-position view + PnL across futures / margin wallets.
            "get_positions",
            "get_pnl",
            // Fix 15 — instant ticker + order-book lookup (public Binance endpoints).
            "get_ticker",
            "get_orderbook",
        ]);
    });

    it("action objects expose expected names", () => {
        expect(getBalanceAction.name).toBe("get_balance");
        expect(getOrdersAction.name).toBe("get_orders");
        expect(createOrderAction.name).toBe("create_order");
        expect(cancelOrderAction.name).toBe("cancel_order");
        expect(getFillsAction.name).toBe("get_fills");
    });
});
