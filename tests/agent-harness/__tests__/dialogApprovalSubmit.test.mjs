import { describe, expect, it } from "vitest";
import {
    buildDialogApprovalParameters,
    UI_HIDDEN_FIELDS,
} from "../lib/dialogApprovalSubmit.mjs";
import { buildApprovalBody } from "../lib/humanInputInterrupt.mjs";
import { getCatalogEntries } from "../suites/trading-prod/trading-prod-catalog.mjs";

const MARKET_IOC_FIELDS = {
    client_order_id: "bn-nbtbb3kbi7ojo4jfdyxy46q634",
    product_id: "BTC-USDT",
    side: "BUY",
    order_configuration: {
        market_market_ioc: { quote_size: "6.00" },
    },
};

const LIMIT_GTC_FIELDS = {
    client_order_id: "bn-limitgtc7ojo4jfdyxy46q634",
    product_id: "BTC-USDT",
    side: "BUY",
    order_configuration: {
        limit_limit_gtc: {
            base_size: "0.00006",
            limit_price: "50000",
        },
    },
};

describe("dialogApprovalSubmit", () => {
    it("excludes UI hidden fields from create_order submit", () => {
        const params = buildDialogApprovalParameters({
            fields: MARKET_IOC_FIELDS,
            fieldSchema: {},
            actionName: "create_order",
            skipPreflight: true,
        });
        expect(params.product_id).toBe("BTC-USDT");
        expect(params.side).toBe("BUY");
        expect(params.order_configuration).toEqual({
            market_market_ioc: { quote_size: "6.00" },
        });
        expect(params.client_order_id).toBeUndefined();
        expect(params.exchange).toBeUndefined();
        expect(params.userId).toBeUndefined();
    });

    it("excludes injected schema fields", () => {
        const params = buildDialogApprovalParameters({
            fields: {
                ...MARKET_IOC_FIELDS,
                exchange: "binance",
                userId: "user-1",
            },
            fieldSchema: {
                userId: { type: "string", required: true, injected: true },
                exchange: { type: "string", required: true, injected: true },
                product_id: { type: "string", required: true },
                side: { type: "enum", required: true },
                order_configuration: { type: "object", required: true },
            },
            actionName: "create_order",
            skipPreflight: true,
        });
        expect(params.exchange).toBeUndefined();
        expect(params.userId).toBeUndefined();
        expect(params.product_id).toBe("BTC-USDT");
    });

    it("skips order_ids required gate when cancel all_open is active", () => {
        const params = buildDialogApprovalParameters({
            fields: {
                product_id: "BTC-USDT",
                all_open: true,
                order_ids: [],
                mode: "live",
            },
            fieldSchema: {
                product_id: { type: "string", required: true },
                order_ids: { type: "array", required: true },
                mode: { type: "string", required: false },
            },
            actionName: "cancel_order",
        });
        expect(params.product_id).toBe("BTC-USDT");
        expect(params.all_open).toBeUndefined();
        expect(params.order_ids).toEqual([]);
    });

    it("UI_HIDDEN_FIELDS matches HumanInputDialog set", () => {
        expect(UI_HIDDEN_FIELDS.has("client_order_id")).toBe(true);
        expect(UI_HIDDEN_FIELDS.has("all_open")).toBe(true);
    });

    it("buildApprovalBody dialog format does not inject compose client_order_id", () => {
        const interrupt = {
            threadId: "room-1",
            approvalId: "approval-1",
            confirmationLevel: 1,
            actionName: "create_order",
            fields: MARKET_IOC_FIELDS,
            fieldSchema: {},
        };
        const body = buildApprovalBody(
            {
                approvalTemplates: {
                    spot_market_market_ioc_buy: {
                        parameters: {
                            client_order_id: "harness-should-not-appear",
                            exchange: "binance",
                        },
                    },
                },
                caseDef: {
                    approvalFormat: "dialog",
                    approvalTemplateKey: "spot_market_market_ioc_buy",
                    compose: {
                        params: {
                            client_order_id: "harness-compose-id",
                            exchange: "binance",
                        },
                    },
                },
            },
            interrupt,
            "approved",
        );
        expect(body.parameters?.product_id).toBe("BTC-USDT");
        expect(body.parameters?.client_order_id).toBeUndefined();
        expect(body.parameters?.exchange).toBeUndefined();
    });

    it("limit GTC dialog submit matches query (2) SSE fields", () => {
        const params = buildDialogApprovalParameters({
            fields: LIMIT_GTC_FIELDS,
            fieldSchema: {
                product_id: { type: "string", required: true },
                side: { type: "enum", required: true },
                order_configuration: { type: "object", required: true },
                client_order_id: { type: "string", required: true },
            },
            actionName: "create_order",
            skipPreflight: true,
        });
        expect(params.product_id).toBe("BTC-USDT");
        expect(params.side).toBe("BUY");
        expect(params.order_configuration).toEqual({
            limit_limit_gtc: { base_size: "0.00006", limit_price: "50000" },
        });
        expect(params.client_order_id).toBeUndefined();
    });

    it("catalog spot create entries use approvalFormat dialog", () => {
        const spotCreate = getCatalogEntries().find((e) => e.id === "spot-market_market_ioc");
        expect(spotCreate?.approvalFormat).toBe("dialog");
        const cancel = getCatalogEntries().find((e) => e.id === "cancel-nl");
        expect(cancel?.approvalFormat).toBe("dialog");
        const amend = getCatalogEntries().find((e) => e.id === "amend-spot-limit");
        expect(amend?.approvalFormat).toBeUndefined();
    });

    it("stop-limit GTD dialog submit passes preflight", () => {
        const entry = getCatalogEntries().find(
            (e) => e.id === "spot-stop_limit_stop_limit_gtd",
        );
        const oc = entry.compose.params.order_configuration.stop_limit_stop_limit_gtd;
        const params = buildDialogApprovalParameters({
            fields: {
                product_id: "BTC-USDT",
                side: "BUY",
                order_configuration: {
                    stop_limit_stop_limit_gtd: oc,
                },
            },
            fieldSchema: {
                product_id: { type: "string", required: true },
                side: { type: "enum", required: true },
                order_configuration: { type: "object", required: true },
            },
            actionName: "create_order",
        });
        expect(params.order_configuration.stop_limit_stop_limit_gtd.stop_price).toBe(
            oc.stop_price,
        );
    });

    it("trailing SELL dialog submit passes preflight", () => {
        const entry = getCatalogEntries().find(
            (e) => e.id === "spot-trailing_stop_limit_gtc",
        );
        const oc = entry.compose.params.order_configuration.trailing_stop_limit_gtc;
        const params = buildDialogApprovalParameters({
            fields: {
                product_id: "BTC-USDT",
                side: "SELL",
                order_configuration: { trailing_stop_limit_gtc: oc },
            },
            fieldSchema: {
                product_id: { type: "string", required: true },
                side: { type: "enum", required: true },
                order_configuration: { type: "object", required: true },
            },
            actionName: "create_order",
        });
        expect(
            params.order_configuration.trailing_stop_limit_gtc.activation_price,
        ).toBe(oc.activation_price);
    });

    it("market IOC dialog submit from catalog compose", () => {
        const entry = getCatalogEntries().find(
            (e) => e.id === "spot-market_market_ioc",
        );
        const params = buildDialogApprovalParameters({
            fields: {
                product_id: entry.compose.params.product_id,
                side: entry.compose.params.side,
                order_configuration: entry.compose.params.order_configuration,
            },
            fieldSchema: {},
            actionName: "create_order",
            skipPreflight: true,
        });
        expect(params.order_configuration.market_market_ioc.quote_size).toBe("6.00");
    });
});
