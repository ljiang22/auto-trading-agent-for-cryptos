import { describe, expect, it } from "vitest";
import {
    validateApprovedActionParams,
    validateCancelOrderParams,
    validateCreateOrderParams,
    validateGetBalanceParams,
    validateGetFillsParams,
    validateGetOrdersParams,
} from "../src/actions/shared";
import {
    getCEXActionSchemaForApproval,
    getCEXCanonicalSpec,
    preflightValidateForExchange,
} from "../src/spec/canonical";

describe("plugin-cex shared validators", () => {
    it("validates get_balance params", () => {
        const params = validateGetBalanceParams({ userId: "u-1", limit: "5" });
        expect(params.limit).toBe(5);
    });

    it("validates get_orders enum filters", () => {
        const params = validateGetOrdersParams({
            userId: "u-1",
            order_status: ["open", "filled"],
            order_types: ["limit"],
        });
        expect(params.order_status).toEqual(["OPEN", "FILLED"]);
        expect(params.order_types).toEqual(["LIMIT"]);
    });

    it("requires product_ids for binance get_orders when order_ids provided (preflight)", () => {
        expect(() =>
            preflightValidateForExchange("get_orders", {
                userId: "u-1",
                exchange: "binance",
                order_ids: ["123"],
            })
        ).toThrow("product_ids");
    });

    it("validates create_order payload variants", () => {
        const params = validateCreateOrderParams({
            userId: "u-1",
            client_order_id: "cid-1",
            product_id: "BTC-USDT",
            side: "BUY",
            order_configuration: {
                market_market_ioc: {
                    quote_size: "10",
                },
            },
        });
        expect(params.side).toBe("BUY");
    });

    it("rejects unsupported create_order variants for binance (preflight)", () => {
        expect(() =>
            preflightValidateForExchange("create_order", {
                userId: "u-1",
                exchange: "binance",
                client_order_id: "cid-1",
                product_id: "BTC-USDT",
                side: "BUY",
                order_configuration: {
                    market_market_fok: {
                        base_size: "0.01",
                    },
                },
            })
        ).toThrow("not supported");
    });

    it("rejects quote_size on non-market binance create_order variants (preflight)", () => {
        expect(() =>
            preflightValidateForExchange("create_order", {
                userId: "u-1",
                exchange: "binance",
                client_order_id: "cid-1",
                product_id: "BTC-USDT",
                side: "BUY",
                order_configuration: {
                    limit_limit_gtc: {
                        limit_price: "60000",
                        quote_size: "50",
                    },
                },
            })
        ).toThrow("quote_size");
    });

    it("validates cancel_order with optional product_id", () => {
        const params = validateCancelOrderParams({
            userId: "u-1",
            order_ids: ["123"],
            product_id: "BTC-USDT",
        });
        expect(params.product_id).toBe("BTC-USDT");
    });

    it("allows binance get_fills without product_ids (Commit 6 — fan-out path)", () => {
        // CEX post-PR237 Commit 6 — the canonical guard previously
        // threw `"product_ids" is required` BEFORE `BinanceOrdersService.getFills`
        // could trigger its `fanOutFills` path. With the capability
        // flag flipped to `false`, the preflight is now a no-op for
        // get_fills with no product_ids; the venue service handles
        // the fan-out across the user's held base assets.
        expect(() =>
            preflightValidateForExchange("get_fills", {
                userId: "u-1",
                exchange: "binance",
            })
        ).not.toThrow();
    });

    it("exposes canonical schemas and capabilities", () => {
        const spec = getCEXCanonicalSpec();
        expect(spec.schemas.create_order).toBeDefined();
        expect(spec.capabilities.binance.actions.create_order?.unsupportedOrderConfigurationVariants).toContain("market_market_fok");
    });

    it("retains margin_type and leverage on binance create_order preflight (live exec is gated downstream)", () => {
        const params = {
            userId: "u-1",
            exchange: "binance",
            client_order_id: "cid-1",
            product_id: "BTC-USDT",
            side: "BUY",
            margin_type: "CROSS",
            leverage: "5",
            order_configuration: {
                market_market_ioc: {
                    quote_size: "10",
                },
            },
        };
        preflightValidateForExchange("create_order", params);
        // Margin context now flows through preflight unchanged so paper/shadow
        // modes can exercise it; the binance live executor surfaces a clean
        // "margin not yet wired" error via `throwMarginNotImplemented`.
        expect(params.margin_type).toBe("CROSS");
        expect(params.leverage).toBe("5");
    });

    it("rejects margin_action without margin_type", () => {
        const params = {
            userId: "u-1",
            exchange: "binance",
            client_order_id: "cid-1",
            product_id: "BTC-USDT",
            side: "BUY",
            margin_action: "AUTO_BORROW",
            order_configuration: {
                market_market_ioc: { quote_size: "10" },
            },
        };
        expect(() => preflightValidateForExchange("create_order", params)).toThrow(
            /margin_action=AUTO_BORROW.*requires.*margin_type/,
        );
    });

    it("keeps margin and leverage in binance create_order approval schema", () => {
        const schema = getCEXActionSchemaForApproval("create_order", "binance");
        expect(schema?.parameters.margin_type).toBeDefined();
        expect(schema?.parameters.leverage).toBeDefined();
        expect(schema?.parameters.margin_action).toBeDefined();
    });

    it("keeps margin and leverage for coinbase create_order approval schema", () => {
        const schema = getCEXActionSchemaForApproval("create_order", "coinbase");
        expect(schema?.parameters.margin_type).toBeDefined();
        expect(schema?.parameters.leverage).toBeDefined();
    });

    it("validateApprovedActionParams runs create_order + preflight for binance", () => {
        const params = {
            userId: "u-1",
            exchange: "binance",
            client_order_id: "cid-1",
            product_id: "BTC-USDT",
            side: "BUY",
            order_configuration: {
                market_market_ioc: { quote_size: "10" },
            },
        };
        expect(() => validateApprovedActionParams("create_order", params)).not.toThrow();
    });

    // N-1 regression guard: PR #236 added 10 new actions but did NOT update
    // validateApprovedActionParams, so every read-only fast-path call to a
    // PR #236 action threw "Unknown CEX action: X" and surfaced in
    // CloudWatch as "Invalid read-only action parameters: ...". This block
    // pins the case arms so the regression can't return.
    it.each([
        "get_trading_mode",
        "get_positions",
        "get_pnl",
        "get_ticker",
        "get_orderbook",
        "list_asset_lists",
        "add_blocked_asset",
        "remove_blocked_asset",
        "add_allowed_asset",
        "remove_allowed_asset",
    ])("validateApprovedActionParams accepts PR #236 action %s without throwing", (actionName) => {
        const params = { userId: "u-1", exchange: "binance" };
        expect(() => validateApprovedActionParams(actionName, params)).not.toThrow();
    });

    it("validateApprovedActionParams still rejects truly unknown actions", () => {
        expect(() => validateApprovedActionParams("not_a_real_action", { userId: "u-1" })).toThrow(
            /Unknown CEX action: not_a_real_action/,
        );
    });
});
