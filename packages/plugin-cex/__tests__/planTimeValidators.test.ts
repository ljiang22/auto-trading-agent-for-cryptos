/**
 * Fix 7 — plugin-side verification of the new CEXSpecProvider hooks
 * `validateCanonicalIntent` + the extended `extractBinanceSymbolFilters`
 * (status + NOTIONAL).
 *
 * These tests exercise the REAL `canonicalIntentSchema` (no schema mock)
 * so a future refactor of the schema or `buildCanonicalIntent` surfaces
 * the regression here, not silently in the core's plan-time chain.
 */

import { describe, expect, it } from "vitest";

import { cexPlugin } from "../src/index";
import { extractBinanceSymbolFilters } from "../src/exchanges/services/binanceQuantization";

describe("CEXSpecProvider.validateCanonicalIntent — H-6 schema rejection", () => {
    it("rejects a create_order with base_size=0", () => {
        const provider = cexPlugin.cexSpecProvider!;
        expect(provider.validateCanonicalIntent).toBeDefined();
        const out = provider.validateCanonicalIntent!({
            action: "create_order",
            venue: "binance",
            userId: "u1",
            locale: "en",
            params: {
                product_id: "BTC-USDT",
                side: "BUY",
                order_configuration: {
                    limit_limit_gtc: { base_size: "0", limit_price: "62000" },
                },
            },
        });
        expect(out.ok).toBe(false);
        if (!out.ok) {
            expect(out.error).toMatch(/positive/i);
        }
    });

    it("rejects a create_order with negative base_size", () => {
        const provider = cexPlugin.cexSpecProvider!;
        const out = provider.validateCanonicalIntent!({
            action: "create_order",
            venue: "binance",
            userId: "u1",
            locale: "en",
            params: {
                product_id: "BTC-USDT",
                side: "BUY",
                order_configuration: {
                    limit_limit_gtc: { base_size: "-0.001", limit_price: "62000" },
                },
            },
        });
        expect(out.ok).toBe(false);
    });

    it("accepts a well-formed limit create_order", () => {
        const provider = cexPlugin.cexSpecProvider!;
        const out = provider.validateCanonicalIntent!({
            action: "create_order",
            venue: "binance",
            userId: "u1",
            locale: "en",
            params: {
                product_id: "BTC-USDT",
                side: "BUY",
                order_configuration: {
                    limit_limit_gtc: { base_size: "0.001", limit_price: "62000" },
                },
            },
        });
        expect(out.ok).toBe(true);
    });

    it("accepts a get_balance read action", () => {
        const provider = cexPlugin.cexSpecProvider!;
        const out = provider.validateCanonicalIntent!({
            action: "get_balance",
            venue: "binance",
            userId: "u1",
            locale: "en",
            params: {},
        });
        expect(out.ok).toBe(true);
    });
});

describe("extractBinanceSymbolFilters — Fix 7 fields (status + NOTIONAL)", () => {
    it("extracts symbol-level status", () => {
        const entry = {
            symbol: "BTCUSDT",
            status: "TRADING",
            filters: [],
        };
        const out = extractBinanceSymbolFilters(entry);
        expect(out.status).toBe("TRADING");
    });

    it("extracts a delisted status (BREAK)", () => {
        const entry = {
            symbol: "XYZUSDT",
            status: "BREAK",
            filters: [],
        };
        const out = extractBinanceSymbolFilters(entry);
        expect(out.status).toBe("BREAK");
    });

    it("extracts minNotional from a NOTIONAL filter", () => {
        const entry = {
            symbol: "BTCUSDT",
            status: "TRADING",
            filters: [
                { filterType: "NOTIONAL", minNotional: "5", applyMinToMarket: true },
            ],
        };
        const out = extractBinanceSymbolFilters(entry);
        expect(out.minNotional).toBe("5");
        expect(out.status).toBe("TRADING");
    });

    it("extracts minNotional from a legacy MIN_NOTIONAL filter", () => {
        const entry = {
            symbol: "BTCUSDT",
            status: "TRADING",
            filters: [
                { filterType: "MIN_NOTIONAL", minNotional: "10" },
            ],
        };
        const out = extractBinanceSymbolFilters(entry);
        expect(out.minNotional).toBe("10");
    });

    it("preserves prior fields (LOT_SIZE / PRICE_FILTER) alongside the new ones", () => {
        const entry = {
            symbol: "BTCUSDT",
            status: "TRADING",
            filters: [
                { filterType: "LOT_SIZE", minQty: "0.00001", maxQty: "9000", stepSize: "0.00001" },
                { filterType: "PRICE_FILTER", minPrice: "0.01", maxPrice: "1000000", tickSize: "0.01" },
                { filterType: "NOTIONAL", minNotional: "5" },
            ],
        };
        const out = extractBinanceSymbolFilters(entry);
        expect(out).toEqual({
            status: "TRADING",
            stepSize: "0.00001",
            minQty: "0.00001",
            maxQty: "9000",
            tickSize: "0.01",
            minPrice: "0.01",
            maxPrice: "1000000",
            minNotional: "5",
        });
    });
});
