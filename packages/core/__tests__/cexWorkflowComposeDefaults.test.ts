/**
 * F10.4 — defaults for free-text orders that omitted fields the
 * canonical schema requires. `applyComposeDefaults` fills in:
 *
 *   • product_id = BTC-USDT when missing on create/preview/amend
 *   • limit_price = 80 % of (bid + ask) / 2 when a limit-variant
 *     order_configuration has an empty price.
 *
 * The helper is skipped when the request came from the compose
 * dialog (composedPreApproved === true) — those users made their
 * choices explicit via the editor and should not be silently
 * overwritten.
 *
 * Coverage:
 *   • missing product_id on each create-style action → BTC-USDT
 *   • non-create_order actions never get product_id filled
 *   • limit-variant missing limit_price → mid * 0.8 (mock ticker)
 *   • non-limit variants (market_market_ioc) untouched
 *   • composedPreApproved=true short-circuits both defaults
 *   • fetchBookTicker null / throws → field stays empty (fail-soft)
 *   • product_id with whitespace counts as missing
 *   • already-populated fields untouched
 */
import { describe, expect, it, vi } from "vitest";
import { applyComposeDefaults } from "../src/handlers/cexWorkflowMessageHandler.ts";

interface BookTickerStub {
    bid: string;
    bidQty: string;
    ask: string;
    askQty: string;
    spread_bps: number;
}

function buildState(opts: {
    composedPreApproved?: boolean;
    fetchBookTickerImpl?: (symbol: string, venue?: string) => Promise<BookTickerStub | null>;
} = {}) {
    const provider = {
        fetchBookTicker: vi.fn(
            opts.fetchBookTickerImpl ??
                (async () =>
                    ({
                        bid: "100",
                        bidQty: "1",
                        ask: "102",
                        askQty: "1",
                        spread_bps: 200,
                    }) satisfies BookTickerStub),
        ),
    };
    return {
        runtime: {
            plugins: [{ cexSpecProvider: provider }],
        },
        message: {
            content: opts.composedPreApproved
                ? { composedPreApproved: true, composedAction: "create_order" }
                : {},
            userId: "user-1",
            roomId: "room-1",
        },
        defaultExchangeId: "binance",
    } as unknown as Parameters<typeof applyComposeDefaults>[0];
}

describe("F10.4 — applyComposeDefaults", () => {
    it("fills product_id with BTC-USDT when missing on create_order", async () => {
        const state = buildState();
        const out = await applyComposeDefaults(state, {
            action: "create_order",
            userParams: {
                side: "BUY",
                order_configuration: {
                    market_market_ioc: { quote_size: "10" },
                },
            },
        });
        expect(out.product_id).toBe("BTC-USDT");
    });

    it("fills product_id with BTC-USDT on preview_order and amend_order", async () => {
        for (const action of ["preview_order", "amend_order"]) {
            const state = buildState();
            const out = await applyComposeDefaults(state, {
                action,
                userParams: {},
            });
            expect(out.product_id, action).toBe("BTC-USDT");
        }
    });

    it("does NOT fill product_id on non-create actions", async () => {
        for (const action of ["get_balance", "get_orders", "cancel_order", "set_trading_mode"]) {
            const state = buildState();
            const out = await applyComposeDefaults(state, {
                action,
                userParams: {},
            });
            expect(out.product_id, action).toBeUndefined();
        }
    });

    it("treats whitespace-only product_id as missing", async () => {
        const state = buildState();
        const out = await applyComposeDefaults(state, {
            action: "create_order",
            userParams: { product_id: "   " },
        });
        expect(out.product_id).toBe("BTC-USDT");
    });

    it("leaves a populated product_id untouched", async () => {
        const state = buildState();
        const out = await applyComposeDefaults(state, {
            action: "create_order",
            userParams: { product_id: "ETH-USDT" },
        });
        expect(out.product_id).toBe("ETH-USDT");
    });

    it("fills limit_price as mid * 0.8 when missing on limit_limit_gtc", async () => {
        // bid=100, ask=102 → mid=101 → 80 % → 80.80
        const state = buildState();
        const out = await applyComposeDefaults(state, {
            action: "create_order",
            userParams: {
                product_id: "BTC-USDT",
                side: "BUY",
                order_configuration: {
                    limit_limit_gtc: { base_size: "0.001", limit_price: "" },
                },
            },
        });
        const oc = out.order_configuration as Record<string, Record<string, unknown>>;
        expect(oc.limit_limit_gtc.limit_price).toBe("80.80");
    });

    it("applies the same 80 % placeholder for SELL (symmetric, per plan)", async () => {
        const state = buildState();
        const out = await applyComposeDefaults(state, {
            action: "create_order",
            userParams: {
                product_id: "BTC-USDT",
                side: "SELL",
                order_configuration: {
                    limit_limit_gtc: { base_size: "0.001", limit_price: "" },
                },
            },
        });
        const oc = out.order_configuration as Record<string, Record<string, unknown>>;
        expect(oc.limit_limit_gtc.limit_price).toBe("80.80");
    });

    it("does NOT touch limit_price on market variants", async () => {
        const state = buildState();
        const out = await applyComposeDefaults(state, {
            action: "create_order",
            userParams: {
                product_id: "BTC-USDT",
                side: "BUY",
                order_configuration: {
                    market_market_ioc: { quote_size: "10" },
                },
            },
        });
        const oc = out.order_configuration as Record<string, Record<string, unknown>>;
        expect(oc.market_market_ioc.limit_price).toBeUndefined();
    });

    it("leaves a populated limit_price untouched", async () => {
        const state = buildState();
        const out = await applyComposeDefaults(state, {
            action: "create_order",
            userParams: {
                product_id: "BTC-USDT",
                side: "BUY",
                order_configuration: {
                    limit_limit_gtc: { base_size: "0.001", limit_price: "75000" },
                },
            },
        });
        const oc = out.order_configuration as Record<string, Record<string, unknown>>;
        expect(oc.limit_limit_gtc.limit_price).toBe("75000");
    });

    it("short-circuits BOTH defaults when composedPreApproved=true", async () => {
        const state = buildState({ composedPreApproved: true });
        const out = await applyComposeDefaults(state, {
            action: "create_order",
            userParams: {
                // both deliberately empty
                order_configuration: {
                    limit_limit_gtc: { base_size: "0.001", limit_price: "" },
                },
            },
        });
        expect(out.product_id).toBeUndefined();
        const oc = out.order_configuration as Record<string, Record<string, unknown>>;
        expect(oc.limit_limit_gtc.limit_price).toBe("");
    });

    it("fail-soft when fetchBookTicker returns null", async () => {
        const state = buildState({ fetchBookTickerImpl: async () => null });
        const out = await applyComposeDefaults(state, {
            action: "create_order",
            userParams: {
                product_id: "BTC-USDT",
                order_configuration: {
                    limit_limit_gtc: { base_size: "0.001", limit_price: "" },
                },
            },
        });
        const oc = out.order_configuration as Record<string, Record<string, unknown>>;
        expect(oc.limit_limit_gtc.limit_price).toBe("");
    });

    it("fail-soft when fetchBookTicker throws", async () => {
        const state = buildState({
            fetchBookTickerImpl: async () => {
                throw new Error("ticker timeout");
            },
        });
        const out = await applyComposeDefaults(state, {
            action: "create_order",
            userParams: {
                product_id: "BTC-USDT",
                order_configuration: {
                    limit_limit_gtc: { base_size: "0.001", limit_price: "" },
                },
            },
        });
        const oc = out.order_configuration as Record<string, Record<string, unknown>>;
        expect(oc.limit_limit_gtc.limit_price).toBe("");
    });

    it("applies BOTH defaults in one pass (missing pair + missing price)", async () => {
        const state = buildState();
        const out = await applyComposeDefaults(state, {
            action: "create_order",
            userParams: {
                side: "BUY",
                order_configuration: {
                    limit_limit_gtc: { base_size: "0.001", limit_price: "" },
                },
            },
        });
        expect(out.product_id).toBe("BTC-USDT");
        const oc = out.order_configuration as Record<string, Record<string, unknown>>;
        expect(oc.limit_limit_gtc.limit_price).toBe("80.80");
    });

    it("handles trigger_bracket_gtc and stop_limit_stop_limit_gtc variants", async () => {
        for (const variantKey of ["trigger_bracket_gtc", "stop_limit_stop_limit_gtc"]) {
            const state = buildState();
            const out = await applyComposeDefaults(state, {
                action: "create_order",
                userParams: {
                    product_id: "BTC-USDT",
                    side: "BUY",
                    order_configuration: {
                        [variantKey]: { base_size: "0.001", limit_price: "" },
                    },
                },
            });
            const oc = out.order_configuration as Record<string, Record<string, unknown>>;
            expect(oc[variantKey].limit_price, variantKey).toBe("80.80");
        }
    });
});
