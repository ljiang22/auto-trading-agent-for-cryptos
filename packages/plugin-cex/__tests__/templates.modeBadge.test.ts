import { describe, it, expect } from "vitest";
import {
    getBalanceOutputTemplate,
    getCancelOrderOutputTemplate,
    getCreateOrderOutputTemplate,
    getFillsOutputTemplate,
    getOrdersOutputTemplate,
} from "../src/templates/output";
import {
    getCancelOrderErrorTemplate,
    getCreateOrderErrorTemplate,
} from "../src/templates/error";

// F1 — assert the plugin-cex template surface forks user-visible copy by
// resolved execution mode. Live should look unchanged; paper should never
// say "on Binance"; shadow should say "hypothetical/logged" and not be
// confused with paper.

const createParams = {
    userId: "u1",
    exchange: "binance",
    product_id: "BTC-USDT",
    side: "BUY",
    order_configuration: { market_market_ioc: { base_size: "0.001" } },
} as never;

const cancelParams = {
    userId: "u1",
    exchange: "binance",
    order_ids: ["paper-ord-abc"],
} as never;

describe("F1 create_order output", () => {
    it("live mode reads as 'on the exchange' with a numeric order id", () => {
        const text = getCreateOrderOutputTemplate(
            createParams,
            { order_id: "12345" },
            "live",
        );
        expect(text).toMatch(/on binance/i);
        expect(text).toMatch(/Order id: 12345/);
        expect(text).not.toMatch(/paper/i);
    });

    it("paper mode says PAPER and does NOT say 'on the exchange'", () => {
        const text = getCreateOrderOutputTemplate(
            createParams,
            { order_id: "paper-ord-abc" },
            "paper",
        );
        expect(text).toMatch(/PAPER/);
        expect(text).toMatch(/Paper order id: paper-ord-abc/);
        expect(text).not.toMatch(/on binance/i);
    });

    it("shadow mode says SHADOW, distinct from paper", () => {
        const text = getCreateOrderOutputTemplate(
            createParams,
            { order_id: "shadow-ord-xyz" },
            "shadow",
        );
        expect(text).toMatch(/SHADOW/);
        expect(text).not.toMatch(/\bPAPER\b/);
    });

    it("defaults to live behavior when mode is omitted", () => {
        const text = getCreateOrderOutputTemplate(createParams, { order_id: "12345" });
        expect(text).toMatch(/Order id: 12345/);
        expect(text).not.toMatch(/PAPER|SHADOW/);
    });
});

describe("F1 cancel_order output", () => {
    it("paper cancel found returns 'Paper order cancelled'", () => {
        const text = getCancelOrderOutputTemplate(
            cancelParams,
            { results: [{ order_id: "paper-ord-abc" }] },
            "paper",
        );
        expect(text).toMatch(/Paper order cancelled/);
    });

    it("paper cancel NOT found returns explicit 'not found in paper ledger'", () => {
        const text = getCancelOrderOutputTemplate(
            cancelParams,
            { results: [] },
            "paper",
        );
        expect(text).toMatch(/No paper order with id paper-ord-abc/);
        expect(text).not.toMatch(/no orders actively cancelled/i);
    });

    it("live cancel keeps existing copy", () => {
        const text = getCancelOrderOutputTemplate(
            cancelParams,
            { results: [{ order_id: "abc" }] },
            "live",
        );
        expect(text).toMatch(/Submitted cancel request/);
        expect(text).not.toMatch(/PAPER|SHADOW/);
    });
});

describe("F1 read-action output (balance / orders / fills)", () => {
    it("paper mode rewrites venue label", () => {
        expect(
            getBalanceOutputTemplate({ exchange: "binance" } as never, { accounts: [{}] }, "paper"),
        ).toMatch(/paper venue/);
        expect(
            getOrdersOutputTemplate({ exchange: "binance" } as never, { orders: [] }, "paper"),
        ).toMatch(/paper venue/);
        expect(
            getFillsOutputTemplate({ exchange: "binance" } as never, { fills: [] }, "paper"),
        ).toMatch(/paper venue/);
    });

    it("live mode keeps the exchange name", () => {
        expect(
            getBalanceOutputTemplate({ exchange: "binance" } as never, { accounts: [{}] }, "live"),
        ).toMatch(/binance/);
        expect(
            getOrdersOutputTemplate({ exchange: "binance" } as never, { orders: [] }, "live"),
        ).toMatch(/binance/);
    });
});

describe("F1 error templates surface mode prefix", () => {
    it("paper create-order error starts with 'Paper '", () => {
        expect(
            getCreateOrderErrorTemplate(
                { product_id: "BTC-USDT" },
                new Error("boom"),
                "paper",
            ),
        ).toMatch(/^Paper /);
    });

    it("live create-order error has no mode prefix", () => {
        expect(
            getCreateOrderErrorTemplate({ product_id: "BTC-USDT" }, new Error("boom"), "live"),
        ).not.toMatch(/^(Paper|Shadow)/);
    });

    it("shadow cancel-order error starts with 'Shadow '", () => {
        expect(
            getCancelOrderErrorTemplate({ order_ids: ["x"] } as never, new Error("boom"), "shadow"),
        ).toMatch(/^Shadow /);
    });
});
