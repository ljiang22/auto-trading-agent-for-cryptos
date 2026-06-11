import { describe, expect, it } from "vitest";
import { canonicalSpotProductId } from "../src/exchanges/canonicalSpotProductId";
import { productIdToCoinbaseProductId } from "../src/exchanges/services/coinbaseProductId";
import { productIdToBinanceSymbol } from "../src/exchanges/services/binanceSymbol";

describe("canonicalSpotProductId", () => {
    it("normalizes slash and underscore separators", () => {
        expect(canonicalSpotProductId("btc/usdc")).toBe("BTC-USDC");
        expect(canonicalSpotProductId("BTC_USDC")).toBe("BTC-USDC");
    });

    it("preserves hyphenated ids", () => {
        expect(canonicalSpotProductId("ETH-USD")).toBe("ETH-USD");
    });

    it("splits concatenated BASEQUOTE when quote suffix matches", () => {
        expect(canonicalSpotProductId("BTCUSDC")).toBe("BTC-USDC");
        expect(canonicalSpotProductId("btcusdt")).toBe("BTC-USDT");
        expect(canonicalSpotProductId("BTCPYUSD")).toBe("BTC-PYUSD");
        expect(canonicalSpotProductId("ETHUSDE")).toBe("ETH-USDE");
    });

    it("passes through unknown shapes uppercased", () => {
        expect(canonicalSpotProductId("UNKNOWNPAIR")).toBe("UNKNOWNPAIR");
    });
});

describe("productIdToCoinbaseProductId", () => {
    it("matches canonical hyphen form", () => {
        expect(productIdToCoinbaseProductId("BTC/USDC")).toBe("BTC-USDC");
    });
});

describe("productIdToBinanceSymbol", () => {
    it("maps slash form to Binance symbol", () => {
        expect(productIdToBinanceSymbol("BTC/USDT")).toBe("BTCUSDT");
    });

    it("maps hyphenated id to Binance symbol", () => {
        expect(productIdToBinanceSymbol("BTC-USDT")).toBe("BTCUSDT");
    });
});
