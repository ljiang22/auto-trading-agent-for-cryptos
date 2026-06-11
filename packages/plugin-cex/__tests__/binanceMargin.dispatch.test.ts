import { describe, it, expect } from "vitest";
import {
    buildSimulatedMarginOrderResponse,
    marginActionToSideEffect,
} from "../src/exchanges/services/binanceMargin";
import type { CreateOrderParams } from "../src/types";

describe("F9 binance margin helpers", () => {
    it("maps margin_action → sideEffectType per Binance spec", () => {
        expect(marginActionToSideEffect("NORMAL")).toBe("NO_SIDE_EFFECT");
        expect(marginActionToSideEffect("AUTO_BORROW")).toBe("MARGIN_BUY");
        expect(marginActionToSideEffect("AUTO_REPAY")).toBe("AUTO_REPAY");
        expect(marginActionToSideEffect(undefined)).toBe("NO_SIDE_EFFECT");
    });

    it("builds a simulated margin response with CROSS + AUTO_BORROW", () => {
        const params: CreateOrderParams = {
            userId: "u1" as never,
            exchange: "binance" as never,
            client_order_id: "co-margin-1",
            product_id: "BTC-USDT",
            side: "BUY",
            order_configuration: {
                limit_limit_gtc: { base_size: "0.001", limit_price: "60000" },
            },
            margin_type: "CROSS",
            margin_action: "AUTO_BORROW",
            leverage: "2",
        } as never;
        const r = buildSimulatedMarginOrderResponse(params);
        expect(r.margin_type).toBe("CROSS");
        expect(r.margin_action).toBe("AUTO_BORROW");
        expect(r.side_effect_type).toBe("MARGIN_BUY");
        expect(r.simulated).toBe(true);
    });

    it("builds a simulated margin response with ISOLATED + NORMAL", () => {
        const params: CreateOrderParams = {
            userId: "u1" as never,
            exchange: "binance" as never,
            client_order_id: "co-margin-2",
            product_id: "ETH-USDT",
            side: "SELL",
            order_configuration: {
                market_market_ioc: { base_size: "0.1" },
            },
            margin_type: "ISOLATED",
            margin_action: "NORMAL",
        } as never;
        const r = buildSimulatedMarginOrderResponse(params);
        expect(r.margin_type).toBe("ISOLATED");
        expect(r.side_effect_type).toBe("NO_SIDE_EFFECT");
    });

    it("throws when called without margin_type", () => {
        const params: CreateOrderParams = {
            userId: "u1" as never,
            exchange: "binance" as never,
            client_order_id: "co-bad",
            product_id: "BTC-USDT",
            side: "BUY",
            order_configuration: { market_market_ioc: { base_size: "0.001" } },
        } as never;
        expect(() => buildSimulatedMarginOrderResponse(params)).toThrow();
    });
});
