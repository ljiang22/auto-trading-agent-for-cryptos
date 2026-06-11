import { describe, expect, it } from "vitest";
import {
    detectOrderVariant,
    formatApprovalInterruptTitle,
    formatOrderNlFromParams,
    formatOrderSummaryShort,
} from "../src/nl/orderNl";

const PRODUCT_ID = "BTC-USDT";

function marketIocParams(quoteSize = "6.00") {
    return {
        exchange: "binance",
        product_id: PRODUCT_ID,
        side: "BUY",
        order_configuration: { market_market_ioc: { quote_size: quoteSize } },
    };
}

function limitGtcParams(baseSize = "0.00006", limitPrice = "100000.00") {
    return {
        exchange: "binance",
        product_id: PRODUCT_ID,
        side: "BUY",
        order_configuration: {
            limit_limit_gtc: { base_size: baseSize, limit_price: limitPrice },
        },
    };
}

describe("orderNl formatter", () => {
    it("detectOrderVariant returns single key", () => {
        expect(
            detectOrderVariant({ limit_limit_gtc: { base_size: "1" } }),
        ).toBe("limit_limit_gtc");
        expect(detectOrderVariant({ a: {}, b: {} })).toBeNull();
    });

    it("formatOrderNlFromParams market IOC uses quote_size from params", () => {
        const nl = formatOrderNlFromParams({
            action: "create_order",
            params: marketIocParams("2000.00"),
        });
        expect(nl).toMatch(/\$2000\.00/);
        expect(nl).not.toMatch(/limit_limit_gtc|market_market_ioc/);
        expect(nl).toMatch(/buy/i);
    });

    it("formatOrderNlFromParams limit GTC uses inner fields from params", () => {
        const nl = formatOrderNlFromParams({
            action: "create_order",
            params: limitGtcParams("0.00006", "62000.00"),
        });
        expect(nl).toContain("62000.00");
        expect(nl).toContain("0.00006");
        expect(nl).toMatch(/limit GTC/i);
    });

    it("formatOrderNlFromParams zero base_size reflects params (risk case)", () => {
        const nl = formatOrderNlFromParams({
            action: "create_order",
            params: {
                product_id: PRODUCT_ID,
                side: "BUY",
                order_configuration: {
                    limit_limit_gtc: { base_size: "0", limit_price: "50000" },
                },
            },
        });
        expect(nl).toMatch(/buy 0 BTC at 50000 limit GTC/i);
    });

    it("formatOrderNlFromParams preview_order prefixes preview", () => {
        const nl = formatOrderNlFromParams({
            action: "preview_order",
            params: marketIocParams(),
        });
        expect(nl).toMatch(/preview buy/i);
        expect(nl).toMatch(/estimate fees/i);
    });

    it("formatOrderNlFromParams cancel all_open", () => {
        const nl = formatOrderNlFromParams({
            action: "cancel_order",
            params: {
                product_id: PRODUCT_ID,
                all_open: true,
                order_ids: [],
            },
        });
        expect(nl).toMatch(/cancel all open/i);
    });

    it("formatOrderNlFromParams cancel by ids", () => {
        const nl = formatOrderNlFromParams({
            action: "cancel_order",
            params: {
                product_id: PRODUCT_ID,
                all_open: false,
                order_ids: ["111", "222"],
            },
        });
        expect(nl).toMatch(/111, 222/);
    });

    it("formatOrderNlFromParams amend_order", () => {
        const nl = formatOrderNlFromParams({
            action: "amend_order",
            params: {
                product_id: PRODUCT_ID,
                orderId: "12345678901",
                price: "51000",
            },
        });
        expect(nl).toMatch(/amend order 12345678901/i);
        expect(nl).toContain("51000");
    });

    it("formatOrderNlFromParams get_orders margin cross", () => {
        const nl = formatOrderNlFromParams({
            action: "get_orders",
            params: { product_id: PRODUCT_ID, margin_type: "CROSS" },
        });
        expect(nl).toMatch(/cross margin/i);
    });

    it("formatOrderSummaryShort includes type and side", () => {
        const summary = formatOrderSummaryShort(
            limitGtcParams(),
            "create_order",
        );
        expect(summary).toMatch(/Limit GTC/i);
        expect(summary).toMatch(/BUY/i);
        expect(summary).toMatch(/BTC-USDT/);
    });

    it("formatApprovalInterruptTitle is specific for create_order", () => {
        const title = formatApprovalInterruptTitle(
            limitGtcParams(),
            "create_order",
        );
        expect(title).toMatch(/Review & Authorize/i);
        expect(title).not.toBe("Review & Authorize Order");
    });

    it("implicit venue mode strips Binance prefix", () => {
        const nl = formatOrderNlFromParams({
            action: "create_order",
            params: marketIocParams(),
            options: { venueMode: "implicit" },
        });
        expect(nl).not.toMatch(/binance/i);
        expect(nl).toMatch(/buy \$6\.00/i);
    });
});
