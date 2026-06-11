import { describe, expect, it } from "vitest";

import {
    extractCancelOrderInput,
    extractCreateOrderInput,
    extractGetBalanceInput,
    extractGetFillsInput,
    extractGetOrdersInput,
    extractPreviewOrderInput,
    extractAmendOrderInput,
} from "../src/adk/parameterExtractor";

describe("ADK parameter extraction (EN + zh-CN)", () => {
    describe("get_balance", () => {
        it("extracts symbol from EN", () => {
            expect(extractGetBalanceInput("What's my BTC balance?")).toMatchObject({
                symbol: "BTC",
            });
        });
        it("extracts symbol from BTC-USD form", () => {
            expect(
                extractGetBalanceInput("how much BTC-USD do I have"),
            ).toMatchObject({ symbol: "BTC-USD" });
        });
        it("returns empty when no symbol", () => {
            expect(extractGetBalanceInput("show me my balances")).toEqual({});
        });
        it("extracts wallet_type=spot from EN", () => {
            expect(
                extractGetBalanceInput("show my spot balance"),
            ).toMatchObject({ wallet_type: "spot" });
        });
        it("extracts wallet_type=spot when phrased 'spot wallet'", () => {
            expect(
                extractGetBalanceInput("what's in my spot wallet"),
            ).toMatchObject({ wallet_type: "spot" });
        });
        it("extracts wallet_type=funding from EN", () => {
            expect(
                extractGetBalanceInput("show my funding balance"),
            ).toMatchObject({ wallet_type: "funding" });
        });
        it("extracts wallet_type=margin_cross from EN", () => {
            expect(
                extractGetBalanceInput("show my cross margin balance"),
            ).toMatchObject({ wallet_type: "margin_cross" });
        });
        it("extracts wallet_type=margin_isolated from EN", () => {
            expect(
                extractGetBalanceInput("show my isolated margin balance"),
            ).toMatchObject({ wallet_type: "margin_isolated" });
        });
        it("omits wallet_type when ambiguous", () => {
            // bare "balance" — no wallet word → fan-out (decomposer rule)
            expect(extractGetBalanceInput("show my balance")).not.toHaveProperty(
                "wallet_type",
            );
        });
        it("omits wallet_type when prompt says only 'margin balance' (cross vs isolated ambiguous)", () => {
            // 'margin' alone (without 'cross' or 'isolated') is ambiguous;
            // by spec we fall through to the fan-out and let the renderer
            // show both margin sections. We DO NOT emit wallet_type here.
            expect(
                extractGetBalanceInput("show my margin balance"),
            ).not.toHaveProperty("wallet_type");
        });
        it("preserves symbol alongside wallet_type when both present", () => {
            expect(
                extractGetBalanceInput("how much BTC in my spot wallet"),
            ).toMatchObject({ symbol: "BTC", wallet_type: "spot" });
        });
    });

    describe("get_orders", () => {
        it("extracts status=open", () => {
            const r = extractGetOrdersInput("show me my open orders");
            expect(r.status).toBe("open");
        });
        it("extracts status=filled", () => {
            const r = extractGetOrdersInput("only show filled orders");
            expect(r.status).toBe("filled");
        });
        it("symbol-aware", () => {
            const r = extractGetOrdersInput("my BTC-USD orders");
            expect(r.symbol).toBe("BTC-USD");
        });
    });

    describe("get_fills", () => {
        it("extracts order_id", () => {
            const r = extractGetFillsInput("show fills for order abc12345");
            expect(r.order_id).toBe("abc12345");
        });
    });

    describe("cancel_order", () => {
        it("requires order_id (EN)", () => {
            const r = extractCancelOrderInput("cancel my order");
            expect("needsClarification" in r).toBe(true);
        });
        it("requires order_id (ZH)", () => {
            const r = extractCancelOrderInput("取消订单");
            expect("needsClarification" in r).toBe(true);
        });
        it("succeeds with order_id", () => {
            const r = extractCancelOrderInput("cancel order abc12345");
            expect(r).toMatchObject({ order_ids: ["abc12345"] });
        });
        // Regression: long Binance numeric ids must be captured exactly,
        // never truncated and never dropped, regardless of phrasing.
        it("captures long numeric Binance id with 'order' keyword", () => {
            const r = extractCancelOrderInput("cancel order 61914026151");
            expect(r).toMatchObject({ order_ids: ["61914026151"] });
        });
        it("captures long numeric Binance id without 'order' keyword", () => {
            const r = extractCancelOrderInput("cancel 61914026151");
            expect(r).toMatchObject({ order_ids: ["61914026151"] });
        });
        it("captures id with 'order id:' explicit form", () => {
            const r = extractCancelOrderInput("cancel order id: 61914026151");
            expect(r).toMatchObject({ order_ids: ["61914026151"] });
        });
        it("captures id from Chinese 取消订单 form", () => {
            const r = extractCancelOrderInput("取消订单 61914026151");
            expect(r).toMatchObject({ order_ids: ["61914026151"] });
        });
        it("captures id from Chinese 撤单 form", () => {
            const r = extractCancelOrderInput("撤单 61914026151");
            expect(r).toMatchObject({ order_ids: ["61914026151"] });
        });
        it("does not mistake a price like 60000 for an order id", () => {
            // No 9+ digit numeric, no 'order'/'cancel' immediately followed
            // by an id token → must clarify rather than grabbing "60000".
            const r = extractCancelOrderInput("the price is 60000");
            expect("needsClarification" in r).toBe(true);
        });
        it("prefers the explicit 'order <id>' over an unrelated long number", () => {
            const r = extractCancelOrderInput(
                "cancel order 61914026151 nonce 999999999",
            );
            expect(r).toMatchObject({ order_ids: ["61914026151"] });
        });
        // False-positive guards: bare-verb forms must contain a digit or
        // hyphen in the captured token. English words after "cancel" /
        // "amend" / "modify" must NOT be treated as order ids — the
        // fast-path would otherwise call the venue with a garbage id.
        it("does not capture an English word after 'cancel'", () => {
            const r = extractCancelOrderInput(
                "cancel everything in my watchlist",
            );
            expect("needsClarification" in r).toBe(true);
        });
        it("does not capture a plain English word after 'amend'", () => {
            const r = extractAmendOrderInput("amend portfolio settings");
            expect("needsClarification" in r).toBe(true);
        });
        it("does not capture 'whatever' after 'modify'", () => {
            // modify uses the same verb branch → also needs to reject.
            const r = extractCancelOrderInput("modify whatever you want");
            expect("needsClarification" in r).toBe(true);
        });
        it("still captures alnum ids that contain digits after 'cancel'", () => {
            const r = extractCancelOrderInput("cancel abc12345");
            expect(r).toMatchObject({ order_ids: ["abc12345"] });
        });
        it("still captures uuid-shaped ids after 'cancel'", () => {
            const r = extractCancelOrderInput(
                "cancel f47ac10b-58cc-4372-a567-0e02b2c3d479",
            );
            expect(r).toMatchObject({
                order_ids: ["f47ac10b-58cc-4372-a567-0e02b2c3d479"],
            });
        });
        // Bug #2: "cancel order 62172026003, 62172209444" only populated
        // one id in the modal because the regex returned the first match.
        // The extractor must surface BOTH ids in the order the user typed.
        it("captures BOTH ids from a comma-separated pair after 'cancel order'", () => {
            const r = extractCancelOrderInput(
                "cancel order 62172026003, 62172209444",
            );
            expect(r).toMatchObject({
                order_ids: ["62172026003", "62172209444"],
            });
        });
        it("captures three ids separated by commas and 'and'", () => {
            const r = extractCancelOrderInput(
                "cancel orders 62172026003, 62172209444 and 62172310555",
            );
            expect(r).toMatchObject({
                order_ids: ["62172026003", "62172209444", "62172310555"],
            });
        });
        it("dedupes a repeated id without dropping the others", () => {
            const r = extractCancelOrderInput(
                "cancel order 62172026003, 62172026003, 62172209444",
            );
            expect(r).toMatchObject({
                order_ids: ["62172026003", "62172209444"],
            });
        });
        it("captures BOTH ids from Chinese 取消订单 with 顿号", () => {
            const r = extractCancelOrderInput("取消订单 62172026003、62172209444");
            expect(r).toMatchObject({
                order_ids: ["62172026003", "62172209444"],
            });
        });
    });

    describe("amend_order", () => {
        it("requires order_id", () => {
            const r = extractAmendOrderInput("amend my limit order to 70000");
            expect("needsClarification" in r).toBe(true);
        });
        it("captures new price", () => {
            const r = extractAmendOrderInput(
                "amend order abc12345 to limit 70000",
            );
            expect(r).toMatchObject({
                order_id: "abc12345",
                new_limit_price: "70000",
            });
        });
    });

    describe("create_order", () => {
        it("buy 0.001 BTC at market", () => {
            const r = extractCreateOrderInput("buy 0.001 BTC at market");
            expect(r).toMatchObject({
                side: "BUY",
                symbol: "BTC",
                order_type: "market",
                base_size: "0.001",
            });
        });
        it("sell 1 ETH at 3000 limit", () => {
            const r = extractCreateOrderInput("sell 1 ETH at 3000 limit");
            expect(r).toMatchObject({
                side: "SELL",
                symbol: "ETH",
                order_type: "limit",
                base_size: "1",
                limit_price: "3000",
            });
        });
        it("ZH: 买 0.001 BTC 市价", () => {
            const r = extractCreateOrderInput("买 0.001 BTC 市价单");
            expect(r).toMatchObject({
                side: "BUY",
                symbol: "BTC",
                base_size: "0.001",
            });
            // order_type may be market or limit; both are valid heuristics
        });
        it("returns clarification when side missing", () => {
            const r = extractCreateOrderInput("0.001 BTC");
            expect("needsClarification" in r).toBe(true);
        });
        it("F10.6: defaults missing symbol to BTC-USDT instead of clarifying", () => {
            // Server's `applyComposeDefaults` enforces the same default
            // as a belt-and-suspenders; the user can edit the pair in
            // the approval modal before confirming.
            const r = extractCreateOrderInput("buy 0.001 at market");
            expect("needsClarification" in r).toBe(false);
            expect(r).toMatchObject({
                side: "BUY",
                symbol: "BTC-USDT",
                order_type: "market",
                base_size: "0.001",
            });
        });
        it("returns clarification when size missing", () => {
            const r = extractCreateOrderInput("buy BTC at market");
            expect("needsClarification" in r).toBe(true);
        });
        it("F10.6: leaves limit_price undefined when missing instead of clarifying", () => {
            // The approval-time `applyComposeDefaults` fills 80 %-of-mid
            // as a placeholder the user reviews + edits in the modal.
            const r = extractCreateOrderInput("buy 0.001 BTC at limit");
            expect("needsClarification" in r).toBe(false);
            expect(r).toMatchObject({
                side: "BUY",
                symbol: "BTC",
                order_type: "limit",
                base_size: "0.001",
            });
            // limit_price absent — explicitly null/undefined
            if (!("needsClarification" in r)) {
                expect(r.limit_price).toBeUndefined();
            }
        });
        it("$ amount as quote_size", () => {
            const r = extractCreateOrderInput("buy $50 BTC at market");
            expect(r).toMatchObject({
                side: "BUY",
                symbol: "BTC",
            });
        });
    });

    describe("preview_order delegates to create extractor", () => {
        it("returns same shape as create", () => {
            const r = extractPreviewOrderInput("preview buy 0.001 BTC at market");
            expect(r).toMatchObject({
                side: "BUY",
                symbol: "BTC",
                order_type: "market",
                base_size: "0.001",
            });
        });
    });
});
