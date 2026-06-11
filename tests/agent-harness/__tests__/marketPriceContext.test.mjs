import { describe, expect, it, vi } from "vitest";
import {
    LEG_SPREAD_PCT,
    applyMarketContextToCase,
    caseNeedsMarketPrices,
    fetchBinanceMidPrice,
    loadMarketPriceContext,
    productIdToBinanceSymbol,
} from "../lib/marketPriceContext.mjs";
import {
    buildPriceLadderFromMid,
    deriveRestingPriceLadder,
    formatUsdtPrice,
} from "../lib/tradingFixtures.mjs";

describe("marketPriceContext", () => {
    it("deriveRestingPriceLadder anchors limits on mid with leg spread for stop-limit", () => {
        const mid = 60_000;
        const ladder = deriveRestingPriceLadder(mid);
        const midPrice = formatUsdtPrice(mid);

        expect(ladder.buyLimit).toBe(midPrice);
        expect(ladder.sellLimit).toBe(midPrice);
        expect(ladder.buyActivation).toBe(midPrice);
        expect(ladder.sellActivation).toBe(midPrice);
        expect(ladder.amendPrice).toBe(midPrice);
        expect(ladder.buyStop).toBe(midPrice);
        expect(ladder.sellStop).toBe(midPrice);
        expect(Number.parseFloat(ladder.buyStopLimit)).toBeCloseTo(mid * (1 + LEG_SPREAD_PCT), 2);
        expect(Number.parseFloat(ladder.sellStopLimit)).toBeCloseTo(
            mid * (1 - LEG_SPREAD_PCT),
            2,
        );
    });

    it("productIdToBinanceSymbol normalizes BTC-USDT", () => {
        expect(productIdToBinanceSymbol("BTC-USDT")).toBe("BTCUSDT");
    });

    it("fetchBinanceMidPrice parses ticker response from first host", async () => {
        const fetchFn = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ symbol: "BTCUSDT", price: "60812.50" }),
        });
        const result = await fetchBinanceMidPrice("BTC-USDT", { fetchFn });
        expect(result.mid).toBe(60812.5);
        expect(result.source).toBe("binance:com");
    });

    it("fetchBinanceMidPrice falls back to vision when com returns 451", async () => {
        const fetchFn = vi.fn().mockImplementation((url) => {
            if (String(url).includes("api.binance.com")) {
                return Promise.resolve({ ok: false, status: 451 });
            }
            if (String(url).includes("data-api.binance.vision")) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ symbol: "BTCUSDT", price: "60359.80" }),
                });
            }
            return Promise.resolve({ ok: false, status: 500 });
        });
        const result = await fetchBinanceMidPrice("BTC-USDT", { fetchFn });
        expect(result.mid).toBe(60359.8);
        expect(result.source).toBe("binance:vision");
    });

    it("fetchBinanceMidPrice uses bookTicker mid when price endpoints fail", async () => {
        const fetchFn = vi.fn().mockImplementation((url) => {
            const u = String(url);
            if (u.includes("/ticker/price")) {
                return Promise.resolve({ ok: false, status: 451 });
            }
            if (u.includes("/ticker/bookTicker") && u.includes("api.binance.com")) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({
                        symbol: "BTCUSDT",
                        bidPrice: "60000.00",
                        askPrice: "60200.00",
                    }),
                });
            }
            return Promise.resolve({ ok: false, status: 500 });
        });
        const result = await fetchBinanceMidPrice("BTC-USDT", { fetchFn });
        expect(result.mid).toBe(60100);
        expect(result.source).toBe("binance:com:bookTicker");
    });

    it("loadMarketPriceContext falls back when all hosts fail", async () => {
        const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 451 });
        const ctx = await loadMarketPriceContext({ fetchFn });
        expect(ctx.source).toBe("fallback");
        expect(ctx.mid).toBe(100_000);
        expect(ctx.priceLadder.buyLimit).toBeTruthy();
    });

    it("loadMarketPriceContext honors midOverride", async () => {
        const ctx = await loadMarketPriceContext({ midOverride: 60_500 });
        expect(ctx.source).toBe("override");
        expect(ctx.mid).toBe(60_500);
        expect(ctx.priceLadder.buyLimit).toBe(
            buildPriceLadderFromMid(60_500).buyLimit,
        );
    });

    it("caseNeedsMarketPrices detects limit create but not market IOC", () => {
        expect(
            caseNeedsMarketPrices({
                compose: {
                    action: "create_order",
                    params: {
                        order_configuration: {
                            market_market_ioc: { quote_size: "6.00" },
                        },
                    },
                },
            }),
        ).toBe(false);
        expect(
            caseNeedsMarketPrices({
                compose: {
                    action: "create_order",
                    params: {
                        order_configuration: {
                            limit_limit_gtc: {
                                base_size: "0.00006",
                                limit_price: "50000",
                            },
                        },
                    },
                },
            }),
        ).toBe(true);
    });

    it("applyMarketContextToCase hydrates limit GTC NL and compose", () => {
        const mid = 60_000;
        const ladder = buildPriceLadderFromMid(mid);
        const caseDef = {
            id: "spot-limit_limit_gtc",
            tags: ["explicit_venue"],
            message: {
                text: "Using Binance, buy 0.00006 BTC at limit price 50000 on BTC-USDT (GTC).",
            },
            compose: {
                action: "create_order",
                previewText:
                    "Using Binance, buy 0.00006 BTC at limit price 50000 on BTC-USDT (GTC).",
                params: {
                    exchange: "binance",
                    product_id: "BTC-USDT",
                    side: "BUY",
                    mode: "live",
                    order_configuration: {
                        limit_limit_gtc: {
                            base_size: "0.00006",
                            limit_price: "50000",
                        },
                    },
                    client_order_id: "harness-spot-limit_limit_gtc-1",
                },
            },
        };
        const hydrated = applyMarketContextToCase(caseDef, { mid, priceLadder: ladder });
        expect(hydrated.message.text).toContain(ladder.buyLimit);
        expect(
            hydrated.compose.params.order_configuration.limit_limit_gtc.limit_price,
        ).toBe(ladder.buyLimit);
        expect(hydrated.compose.params.client_order_id).toBe(
            "harness-spot-limit_limit_gtc-1",
        );
    });

    it("applyMarketContextToCase hydrates stop-limit GTD and preserves end_time", () => {
        const mid = 60_000;
        const ladder = buildPriceLadderFromMid(mid);
        const endTime = "2026-06-12T18:07:50.053Z";
        const caseDef = {
            id: "spot-stop_limit_stop_limit_gtd",
            tags: ["implicit_venue"],
            message: {
                text: "buy 0.00006 BTC with a stop-limit order (GTD) on BTC-USDT: stop at 40000 and limit at 40500.",
            },
            compose: {
                action: "create_order",
                params: {
                    exchange: "binance",
                    product_id: "BTC-USDT",
                    side: "BUY",
                    mode: "live",
                    order_configuration: {
                        stop_limit_stop_limit_gtd: {
                            base_size: "0.00006",
                            stop_price: "40000",
                            limit_price: "40500",
                            end_time: endTime,
                        },
                    },
                },
            },
        };
        const hydrated = applyMarketContextToCase(caseDef, { mid, priceLadder: ladder });
        const oc = hydrated.compose.params.order_configuration.stop_limit_stop_limit_gtd;

        expect(hydrated.message.text).toContain(ladder.buyStop);
        expect(hydrated.message.text).toContain(ladder.buyStopLimit);
        expect(oc.stop_price).toBe(ladder.buyStop);
        expect(oc.limit_price).toBe(ladder.buyStopLimit);
        expect(oc.end_time).toBe(endTime);

        const limit = Number.parseFloat(oc.limit_price);
        expect(Math.abs(limit - mid) / mid).toBeCloseTo(LEG_SPREAD_PCT, 3);
    });

    it("applyMarketContextToCase hydrates risk-min-order-size NL with mid price", () => {
        const mid = 60_359.5;
        const ladder = buildPriceLadderFromMid(mid);
        const caseDef = {
            id: "risk-min-order-size",
            tags: ["explicit_venue"],
            message: {
                text: "Using Binance, buy 0 BTC at 50000 limit GTC on BTC-USDT.",
            },
            compose: {
                action: "create_order",
                previewText: "Using Binance, buy 0 BTC at 50000 limit GTC on BTC-USDT.",
                params: {
                    exchange: "binance",
                    product_id: "BTC-USDT",
                    side: "BUY",
                    mode: "live",
                    order_configuration: {
                        limit_limit_gtc: { base_size: "0", limit_price: "50000" },
                    },
                },
            },
        };
        const hydrated = applyMarketContextToCase(caseDef, { mid, priceLadder: ladder });
        expect(hydrated.message.text).toContain(ladder.buyLimit);
        expect(hydrated.message.text).not.toContain("50000");
        expect(
            hydrated.compose.params.order_configuration.limit_limit_gtc.limit_price,
        ).toBe(ladder.buyLimit);
    });

    it("applyMarketContextToCase hydrates trailing SELL activation at mid", () => {
        const mid = 60_000;
        const ladder = buildPriceLadderFromMid(mid);
        const caseDef = {
            id: "spot-trailing_stop_limit_gtc",
            tags: ["explicit_venue"],
            message: {
                text: "Using Binance, sell 0.00006 BTC with a trailing stop limit order on BTC-USDT, 100 bps trail, activation at 120000.",
            },
            compose: {
                action: "create_order",
                params: {
                    exchange: "binance",
                    product_id: "BTC-USDT",
                    side: "SELL",
                    mode: "live",
                    order_configuration: {
                        trailing_stop_limit_gtc: {
                            base_size: "0.00006",
                            trailing_delta_bps: 100,
                            activation_price: "120000",
                        },
                    },
                },
            },
        };
        const hydrated = applyMarketContextToCase(caseDef, { mid, priceLadder: ladder });
        const activation =
            hydrated.compose.params.order_configuration.trailing_stop_limit_gtc
                .activation_price;

        expect(hydrated.message.text).toContain(ladder.sellActivation);
        expect(activation).toBe(ladder.sellActivation);
        expect(activation).toBe(formatUsdtPrice(mid));
    });
});
