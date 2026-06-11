import { describe, expect, it } from "vitest";
import {
    quantizeCoinbaseOrderConfiguration,
    type CoinbaseProductMeta,
} from "../src/exchanges/services/coinbaseQuantization";
import type { OrderConfiguration } from "../src/types";

const BTC_USDC: CoinbaseProductMeta = {
    base_increment: "0.00000001",
    quote_increment: "0.01",
    price_increment: "0.01",
};

const ETH_USDC: CoinbaseProductMeta = {
    base_increment: "0.0001",
    quote_increment: "0.01",
    price_increment: "0.01",
};

const XRP_USD: CoinbaseProductMeta = {
    base_increment: "0.1",
    quote_increment: "0.0001",
    price_increment: "0.0001",
};

describe("quantizeCoinbaseOrderConfiguration", () => {
    describe("market_market_ioc", () => {
        it("floors quote_size to quote_increment for BUY in BTC-USDC", () => {
            const input: OrderConfiguration = {
                market_market_ioc: { quote_size: "100.123456" },
            };
            const out = quantizeCoinbaseOrderConfiguration(input, BTC_USDC);
            expect(out.market_market_ioc?.quote_size).toBe("100.12");
        });

        it("floors base_size to base_increment in BTC-USDC", () => {
            const input: OrderConfiguration = {
                market_market_ioc: { base_size: "0.0010234567891" },
            };
            const out = quantizeCoinbaseOrderConfiguration(input, BTC_USDC);
            expect(out.market_market_ioc?.base_size).toBe("0.00102345");
        });

        it("preserves base_size that is already aligned", () => {
            const input: OrderConfiguration = {
                market_market_ioc: { base_size: "0.001" },
            };
            const out = quantizeCoinbaseOrderConfiguration(input, BTC_USDC);
            expect(out.market_market_ioc?.base_size).toBe("0.001");
        });

        it("floors base_size for a coarser-increment pair (XRP-USD, 0.1 BTC-increment)", () => {
            const input: OrderConfiguration = {
                market_market_ioc: { base_size: "12.789" },
            };
            const out = quantizeCoinbaseOrderConfiguration(input, XRP_USD);
            expect(out.market_market_ioc?.base_size).toBe("12.7");
        });

        it("does not invent fields that were not present", () => {
            const input: OrderConfiguration = {
                market_market_ioc: { quote_size: "50.99" },
            };
            const out = quantizeCoinbaseOrderConfiguration(input, BTC_USDC);
            expect(out.market_market_ioc?.base_size).toBeUndefined();
            expect(out.market_market_ioc?.quote_size).toBe("50.99");
        });
    });

    describe("limit_limit_gtc", () => {
        it("floors base_size and rounds limit_price to nearest price_increment", () => {
            const input: OrderConfiguration = {
                limit_limit_gtc: {
                    base_size: "0.0123456789012",
                    limit_price: "65432.567",
                },
            };
            const out = quantizeCoinbaseOrderConfiguration(input, BTC_USDC);
            expect(out.limit_limit_gtc?.base_size).toBe("0.01234567");
            expect(out.limit_limit_gtc?.limit_price).toBe("65432.57");
        });

        it("rounds limit_price down when the fractional part is below half", () => {
            const input: OrderConfiguration = {
                limit_limit_gtc: { base_size: "0.01", limit_price: "65432.564" },
            };
            const out = quantizeCoinbaseOrderConfiguration(input, BTC_USDC);
            expect(out.limit_limit_gtc?.limit_price).toBe("65432.56");
        });

        it("preserves post_only boolean", () => {
            const input: OrderConfiguration = {
                limit_limit_gtc: { base_size: "0.01", limit_price: "1000", post_only: true },
            };
            const out = quantizeCoinbaseOrderConfiguration(input, ETH_USDC);
            expect(out.limit_limit_gtc?.post_only).toBe(true);
        });
    });

    describe("stop_limit_stop_limit_gtc", () => {
        it("rounds both stop_price and limit_price to price_increment, floors base_size", () => {
            const input: OrderConfiguration = {
                stop_limit_stop_limit_gtc: {
                    base_size: "0.500001",
                    stop_price: "1999.999",
                    limit_price: "2000.005",
                    stop_direction: "STOP_DIRECTION_STOP_DOWN",
                },
            };
            const out = quantizeCoinbaseOrderConfiguration(input, ETH_USDC);
            expect(out.stop_limit_stop_limit_gtc?.base_size).toBe("0.5");
            expect(out.stop_limit_stop_limit_gtc?.stop_price).toBe("2000");
            expect(out.stop_limit_stop_limit_gtc?.limit_price).toBe("2000.01");
            expect(out.stop_limit_stop_limit_gtc?.stop_direction).toBe("STOP_DIRECTION_STOP_DOWN");
        });
    });

    describe("trigger_bracket_gtc", () => {
        it("rounds both prices, leaves size alone (variant has no size field)", () => {
            const input: OrderConfiguration = {
                trigger_bracket_gtc: {
                    limit_price: "65432.999",
                    stop_trigger_price: "60000.001",
                },
            };
            const out = quantizeCoinbaseOrderConfiguration(input, BTC_USDC);
            expect(out.trigger_bracket_gtc?.limit_price).toBe("65433");
            expect(out.trigger_bracket_gtc?.stop_trigger_price).toBe("60000");
        });
    });

    describe("edge cases", () => {
        it("returns input unchanged when increments are missing", () => {
            const input: OrderConfiguration = {
                market_market_ioc: { quote_size: "100.123456" },
            };
            const out = quantizeCoinbaseOrderConfiguration(input, {});
            expect(out.market_market_ioc?.quote_size).toBe("100.123456");
        });

        it("returns input unchanged when increment is malformed", () => {
            const input: OrderConfiguration = {
                market_market_ioc: { quote_size: "100.123456" },
            };
            const out = quantizeCoinbaseOrderConfiguration(input, {
                quote_increment: "not-a-number",
            });
            expect(out.market_market_ioc?.quote_size).toBe("100.123456");
        });

        it("returns input unchanged when increment is zero or negative", () => {
            const input: OrderConfiguration = {
                market_market_ioc: { quote_size: "100.123456" },
            };
            expect(
                quantizeCoinbaseOrderConfiguration(input, { quote_increment: "0" })
                    .market_market_ioc?.quote_size
            ).toBe("100.123456");
            expect(
                quantizeCoinbaseOrderConfiguration(input, { quote_increment: "-0.01" })
                    .market_market_ioc?.quote_size
            ).toBe("100.123456");
        });

        it("skips fields that are not strings", () => {
            const input = {
                market_market_ioc: { quote_size: 100.5 as unknown as string },
            } as OrderConfiguration;
            const out = quantizeCoinbaseOrderConfiguration(input, BTC_USDC);
            // Non-string size left untouched (the upstream validator will catch it).
            expect(out.market_market_ioc?.quote_size).toBe(100.5 as unknown as string);
        });

        it("skips empty-string sizes", () => {
            const input: OrderConfiguration = {
                market_market_ioc: { quote_size: "" },
            };
            const out = quantizeCoinbaseOrderConfiguration(input, BTC_USDC);
            expect(out.market_market_ioc?.quote_size).toBe("");
        });

        it("falls back to quote_increment when price_increment is missing", () => {
            const input: OrderConfiguration = {
                limit_limit_gtc: { base_size: "0.01", limit_price: "65432.567" },
            };
            const out = quantizeCoinbaseOrderConfiguration(input, {
                base_increment: "0.00000001",
                quote_increment: "0.01",
            });
            expect(out.limit_limit_gtc?.limit_price).toBe("65432.57");
        });

        it("does not introduce floating-point artefacts when flooring", () => {
            // 0.1 + 0.2 territory: this validates we're not using naive float division.
            const input: OrderConfiguration = {
                market_market_ioc: { base_size: "0.30000000001" },
            };
            const out = quantizeCoinbaseOrderConfiguration(input, BTC_USDC);
            expect(out.market_market_ioc?.base_size).toBe("0.3");
        });

        it("returns the same shape (does not strip variants or mutate input)", () => {
            const input: OrderConfiguration = {
                market_market_ioc: { quote_size: "100.123456" },
            };
            const snapshot = JSON.parse(JSON.stringify(input));
            const out = quantizeCoinbaseOrderConfiguration(input, BTC_USDC);
            expect(input).toEqual(snapshot); // input was not mutated
            expect(Object.keys(out)).toEqual(["market_market_ioc"]);
        });
    });

    // Fix 5 (5d) — quantizer hardening: non-positive sizes that slip past
    // the schema + risk layers must surface a clear error instead of being
    // absorbed into a quantization no-op.
    describe("Fix 5 — rejects non-positive quantities", () => {
        it("throws on a negative base_size", () => {
            const input: OrderConfiguration = {
                market_market_ioc: { base_size: "-0.5" },
            };
            expect(() => quantizeCoinbaseOrderConfiguration(input, BTC_USDC)).toThrow(
                /non-positive order quantity rejected/i,
            );
        });

        it("throws on a zero base_size", () => {
            const input: OrderConfiguration = {
                market_market_ioc: { base_size: "0" },
            };
            expect(() => quantizeCoinbaseOrderConfiguration(input, BTC_USDC)).toThrow(
                /non-positive order quantity rejected/i,
            );
        });

        it("throws on a negative quote_size", () => {
            const input: OrderConfiguration = {
                market_market_ioc: { quote_size: "-100" },
            };
            expect(() => quantizeCoinbaseOrderConfiguration(input, BTC_USDC)).toThrow(
                /non-positive order quantity rejected/i,
            );
        });

        it("throws on a negative limit_price", () => {
            const input: OrderConfiguration = {
                limit_limit_gtc: { base_size: "0.001", limit_price: "-65000" },
            };
            expect(() => quantizeCoinbaseOrderConfiguration(input, BTC_USDC)).toThrow(
                /non-positive order quantity rejected/i,
            );
        });

        it("still passes a perfectly valid positive order through unchanged", () => {
            const input: OrderConfiguration = {
                limit_limit_gtc: { base_size: "0.001", limit_price: "65000" },
            };
            const out = quantizeCoinbaseOrderConfiguration(input, BTC_USDC);
            expect(out.limit_limit_gtc?.base_size).toBe("0.001");
            expect(out.limit_limit_gtc?.limit_price).toBe("65000");
        });
    });
});
