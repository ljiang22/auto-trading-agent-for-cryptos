import { describe, it, expect } from "vitest";
import { toVenueSymbol } from "../src/exchanges/symbolFormatAdapter";

// H4 — per-venue symbol adapter. The 48 stale orders flagged by QA
// were polling Binance with the canonical "BTC-USDT" form and getting
// HTTP 400 / -1121 "Invalid symbol" because Binance Spot REST wants
// "BTCUSDT". Coinbase is the opposite: it wants the dashed form.

describe("toVenueSymbol — Binance", () => {
    it("strips the dash for canonical BASE-QUOTE input", () => {
        expect(toVenueSymbol("BTC-USDT", "binance")).toBe("BTCUSDT");
        expect(toVenueSymbol("ETH-USDC", "binance")).toBe("ETHUSDC");
    });

    it("is idempotent on already-Binance-formatted input", () => {
        expect(toVenueSymbol("BTCUSDT", "binance")).toBe("BTCUSDT");
        expect(toVenueSymbol("ETHUSDC", "binance")).toBe("ETHUSDC");
    });

    it("uppercases lowercase input", () => {
        expect(toVenueSymbol("btc-usdt", "binance")).toBe("BTCUSDT");
        expect(toVenueSymbol("btcusdt", "binance")).toBe("BTCUSDT");
    });

    it("normalizes slash, underscore, and whitespace variants", () => {
        expect(toVenueSymbol("BTC/USDT", "binance")).toBe("BTCUSDT");
        expect(toVenueSymbol("BTC_USDT", "binance")).toBe("BTCUSDT");
        expect(toVenueSymbol("BTC USDT", "binance")).toBe("BTCUSDT");
    });
});

describe("toVenueSymbol — Coinbase", () => {
    it("passes the canonical BASE-QUOTE form through unchanged", () => {
        expect(toVenueSymbol("BTC-USDT", "coinbase")).toBe("BTC-USDT");
        expect(toVenueSymbol("ETH-USDC", "coinbase")).toBe("ETH-USDC");
    });

    it("uppercases lowercase input", () => {
        expect(toVenueSymbol("btc-usdt", "coinbase")).toBe("BTC-USDT");
    });

    it("normalizes slash and underscore variants to the hyphen form", () => {
        expect(toVenueSymbol("BTC/USDT", "coinbase")).toBe("BTC-USDT");
        expect(toVenueSymbol("BTC_USDT", "coinbase")).toBe("BTC-USDT");
    });
});

describe("toVenueSymbol — edge cases", () => {
    it("returns the empty string unchanged (no-op)", () => {
        expect(toVenueSymbol("", "binance")).toBe("");
        expect(toVenueSymbol("", "coinbase")).toBe("");
    });

    it("trims whitespace", () => {
        expect(toVenueSymbol("  BTC-USDT  ", "binance")).toBe("BTCUSDT");
        expect(toVenueSymbol("  BTC-USDT  ", "coinbase")).toBe("BTC-USDT");
    });
});
