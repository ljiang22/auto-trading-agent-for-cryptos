import { describe, expect, it } from "vitest";

import { validateGetOrdersParams } from "../src/actions/shared";

const baseParams = {
    userId: "00000000-0000-0000-0000-000000000001",
    exchange: "binance",
};

describe("validateGetOrdersParams — order_status alias map", () => {
    it("accepts canonical Coinbase values", () => {
        const out = validateGetOrdersParams({ ...baseParams, order_status: ["OPEN"] });
        expect(out.order_status).toEqual(["OPEN"]);
    });

    it("accepts Binance NEW and maps to OPEN", () => {
        const out = validateGetOrdersParams({ ...baseParams, order_status: ["NEW"] });
        expect(out.order_status).toEqual(["OPEN"]);
    });

    it("accepts Binance PARTIALLY_FILLED and maps to OPEN", () => {
        const out = validateGetOrdersParams({ ...baseParams, order_status: ["PARTIALLY_FILLED"] });
        expect(out.order_status).toEqual(["OPEN"]);
    });

    it("accepts LLM-stripped PARTIALLYFILLED (no underscore)", () => {
        const out = validateGetOrdersParams({ ...baseParams, order_status: ["PARTIALLYFILLED"] });
        expect(out.order_status).toEqual(["OPEN"]);
    });

    it("accepts CANCELED (Binance) and maps to CANCELLED", () => {
        const out = validateGetOrdersParams({ ...baseParams, order_status: ["CANCELED"] });
        expect(out.order_status).toEqual(["CANCELLED"]);
    });

    it("accepts REJECTED (Binance) and maps to FAILED", () => {
        const out = validateGetOrdersParams({ ...baseParams, order_status: ["REJECTED"] });
        expect(out.order_status).toEqual(["FAILED"]);
    });

    it("accepts mixed venue terms in a single call", () => {
        const out = validateGetOrdersParams({
            ...baseParams,
            order_status: ["NEW", "FILLED", "PARTIALLY_FILLED"],
        });
        expect(out.order_status).toEqual(["OPEN", "FILLED", "OPEN"]);
    });

    it("still rejects truly invalid values", () => {
        expect(() =>
            validateGetOrdersParams({ ...baseParams, order_status: ["WHATEVER"] }),
        ).toThrow(/Invalid order_status/);
    });

    it("accepts case-insensitive input", () => {
        const out = validateGetOrdersParams({ ...baseParams, order_status: ["new", "filled"] });
        expect(out.order_status).toEqual(["OPEN", "FILLED"]);
    });
});
