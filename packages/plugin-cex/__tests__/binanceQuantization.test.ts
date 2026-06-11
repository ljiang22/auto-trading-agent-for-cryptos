import { describe, expect, it } from "vitest";
import {
    extractBinanceSymbolFilters,
    extractBinanceSymbolFiltersFromResponse,
    quantizeBinanceOrderBody,
    type BinanceSymbolFilters,
} from "../src/exchanges/services/binanceQuantization";

// Filters approximating live Binance Spot for these symbols.
const BTCUSDT: BinanceSymbolFilters = {
    stepSize: "0.00001",
    minQty: "0.00001",
    maxQty: "9000",
    marketStepSize: "0.00001",
    marketMinQty: "0.00001",
    marketMaxQty: "100",
    tickSize: "0.01",
    minPrice: "0.01",
    maxPrice: "1000000",
};

const ETHUSDT: BinanceSymbolFilters = {
    stepSize: "0.0001",
    minQty: "0.0001",
    marketStepSize: "0.0001",
    tickSize: "0.01",
};

describe("extractBinanceSymbolFilters", () => {
    it("pulls LOT_SIZE, MARKET_LOT_SIZE, and PRICE_FILTER out of a symbols entry", () => {
        const entry = {
            symbol: "BTCUSDT",
            filters: [
                { filterType: "LOT_SIZE", minQty: "0.00001", maxQty: "9000", stepSize: "0.00001" },
                { filterType: "MARKET_LOT_SIZE", minQty: "0.00001", maxQty: "100", stepSize: "0.00001" },
                { filterType: "PRICE_FILTER", minPrice: "0.01", maxPrice: "1000000", tickSize: "0.01" },
                { filterType: "NOTIONAL", minNotional: "5", applyMinToMarket: true },
            ],
        };
        const out = extractBinanceSymbolFilters(entry);
        expect(out.stepSize).toBe("0.00001");
        expect(out.minQty).toBe("0.00001");
        expect(out.maxQty).toBe("9000");
        expect(out.marketStepSize).toBe("0.00001");
        expect(out.marketMinQty).toBe("0.00001");
        expect(out.tickSize).toBe("0.01");
    });

    it("returns an empty object when filters are missing or malformed", () => {
        expect(extractBinanceSymbolFilters(null)).toEqual({});
        expect(extractBinanceSymbolFilters({})).toEqual({});
        expect(extractBinanceSymbolFilters({ filters: "nope" })).toEqual({});
    });
});

describe("extractBinanceSymbolFiltersFromResponse", () => {
    it("finds the requested symbol (case-insensitive) and returns its filters", () => {
        const response = {
            symbols: [
                {
                    symbol: "ETHUSDT",
                    filters: [{ filterType: "LOT_SIZE", stepSize: "0.0001", minQty: "0.0001" }],
                },
                {
                    symbol: "BTCUSDT",
                    filters: [
                        { filterType: "LOT_SIZE", stepSize: "0.00001", minQty: "0.00001" },
                        { filterType: "PRICE_FILTER", tickSize: "0.01" },
                    ],
                },
            ],
        };
        const out = extractBinanceSymbolFiltersFromResponse(response, "btcusdt");
        expect(out.stepSize).toBe("0.00001");
        expect(out.tickSize).toBe("0.01");
    });

    it("returns an empty object when the symbol is not in the response", () => {
        const response = { symbols: [{ symbol: "ETHUSDT", filters: [] }] };
        expect(extractBinanceSymbolFiltersFromResponse(response, "BTCUSDT")).toEqual({});
    });
});

describe("quantizeBinanceOrderBody — LOT_SIZE (limit orders)", () => {
    it("floors quantity to stepSize for LIMIT orders", () => {
        const body = {
            symbol: "BTCUSDT",
            side: "BUY",
            type: "LIMIT",
            timeInForce: "GTC",
            quantity: "0.0001234567",
            price: "65000",
        };
        const out = quantizeBinanceOrderBody(body, BTCUSDT);
        expect(out.quantity).toBe("0.00012");
    });

    it("preserves an already-aligned quantity", () => {
        const body = {
            symbol: "BTCUSDT",
            type: "LIMIT",
            quantity: "0.001",
            price: "65000",
        };
        const out = quantizeBinanceOrderBody(body, BTCUSDT);
        expect(out.quantity).toBe("0.001");
    });

    it("works for a coarser-stepSize pair (ETHUSDT, 0.0001)", () => {
        const body = {
            symbol: "ETHUSDT",
            type: "LIMIT",
            quantity: "0.123456789",
            price: "3500",
        };
        const out = quantizeBinanceOrderBody(body, ETHUSDT);
        expect(out.quantity).toBe("0.1234");
    });
});

describe("quantizeBinanceOrderBody — PRICE_FILTER", () => {
    it("rounds price to tickSize (half-up)", () => {
        const body = {
            symbol: "BTCUSDT",
            type: "LIMIT",
            quantity: "0.001",
            price: "65432.567",
        };
        const out = quantizeBinanceOrderBody(body, BTCUSDT);
        expect(out.price).toBe("65432.57");
    });

    it("rounds price down when the fractional part is below half", () => {
        const body = {
            symbol: "BTCUSDT",
            type: "LIMIT",
            quantity: "0.001",
            price: "65432.564",
        };
        const out = quantizeBinanceOrderBody(body, BTCUSDT);
        expect(out.price).toBe("65432.56");
    });

    it("rounds stopPrice to tickSize for stop orders", () => {
        const body = {
            symbol: "BTCUSDT",
            type: "STOP_LOSS_LIMIT",
            timeInForce: "GTC",
            quantity: "0.001",
            price: "60000.123",
            stopPrice: "60500.555",
        };
        const out = quantizeBinanceOrderBody(body, BTCUSDT);
        expect(out.price).toBe("60000.12");
        expect(out.stopPrice).toBe("60500.56");
    });
});

describe("quantizeBinanceOrderBody — MARKET_LOT_SIZE", () => {
    it("floors quantity to BOTH LOT_SIZE and MARKET_LOT_SIZE for MARKET orders", () => {
        // LOT_SIZE.stepSize = 0.00001, MARKET_LOT_SIZE.stepSize = 0.001 (coarser).
        const filters: BinanceSymbolFilters = {
            stepSize: "0.00001",
            minQty: "0.00001",
            marketStepSize: "0.001",
            marketMinQty: "0.001",
        };
        const body = {
            symbol: "BTCUSDT",
            type: "MARKET",
            quantity: "0.123456789",
        };
        const out = quantizeBinanceOrderBody(body, filters);
        // Floor by 0.00001 -> 0.12345; then floor by 0.001 -> 0.123.
        expect(out.quantity).toBe("0.123");
    });

    it("does NOT apply MARKET_LOT_SIZE to LIMIT orders", () => {
        const filters: BinanceSymbolFilters = {
            stepSize: "0.00001",
            marketStepSize: "0.001",
        };
        const body = {
            symbol: "BTCUSDT",
            type: "LIMIT",
            quantity: "0.123456789",
            price: "65000",
        };
        const out = quantizeBinanceOrderBody(body, filters);
        // LIMIT only sees LOT_SIZE (0.00001) -> 0.12345
        expect(out.quantity).toBe("0.12345");
    });

    it("does not touch quantity when stepSize is 0 (treated as no constraint)", () => {
        const body = { symbol: "X", type: "LIMIT", quantity: "0.123456789" };
        const out = quantizeBinanceOrderBody(body, { stepSize: "0" });
        expect(out.quantity).toBe("0.123456789");
    });
});

describe("quantizeBinanceOrderBody — minQty error", () => {
    it("throws when post-floor quantity is below LOT_SIZE.minQty", () => {
        const filters: BinanceSymbolFilters = {
            stepSize: "0.00001",
            minQty: "0.001",
        };
        const body = {
            symbol: "BTCUSDT",
            type: "LIMIT",
            quantity: "0.00009",
            price: "65000",
        };
        expect(() => quantizeBinanceOrderBody(body, filters)).toThrow(/below the minimum/);
    });

    it("uses the larger of LOT_SIZE.minQty and MARKET_LOT_SIZE.minQty for MARKET orders", () => {
        const filters: BinanceSymbolFilters = {
            stepSize: "0.00001",
            minQty: "0.0001",
            marketStepSize: "0.00001",
            marketMinQty: "0.001",
        };
        // 0.0005 passes LOT_SIZE.minQty (0.0001) but fails MARKET_LOT_SIZE.minQty (0.001).
        const body = {
            symbol: "BTCUSDT",
            type: "MARKET",
            quantity: "0.0005",
        };
        expect(() => quantizeBinanceOrderBody(body, filters)).toThrow(/below the minimum 0\.001/);
    });

    it("does not throw when minQty is missing (best-effort fallback)", () => {
        const filters: BinanceSymbolFilters = { stepSize: "0.00001" };
        const body = {
            symbol: "BTCUSDT",
            type: "LIMIT",
            quantity: "0.00009",
            price: "65000",
        };
        expect(() => quantizeBinanceOrderBody(body, filters)).not.toThrow();
    });
});

describe("quantizeBinanceOrderBody — pass-through cases", () => {
    it("returns input unchanged when filters are empty", () => {
        const body = {
            symbol: "BTCUSDT",
            type: "LIMIT",
            quantity: "0.123456789",
            price: "65432.567",
        };
        const out = quantizeBinanceOrderBody(body, {});
        expect(out).toEqual(body);
    });

    it("leaves quoteOrderQty alone (bound by separate filters)", () => {
        const body = {
            symbol: "BTCUSDT",
            type: "MARKET",
            quoteOrderQty: "10.123456",
        };
        const out = quantizeBinanceOrderBody(body, BTCUSDT);
        expect(out.quoteOrderQty).toBe("10.123456");
    });

    it("does not mutate the input body", () => {
        const body = {
            symbol: "BTCUSDT",
            type: "LIMIT",
            quantity: "0.0001234567",
            price: "65432.567",
        };
        const copy = { ...body };
        quantizeBinanceOrderBody(body, BTCUSDT);
        expect(body).toEqual(copy);
    });
});

// Fix 5 (5d) — quantizer hardening: non-positive sizes that slip past
// the schema + risk layers must surface a clear error instead of being
// absorbed into a quantization no-op.
describe("Fix 5 — quantizer rejects non-positive quantities", () => {
    it("throws on a negative quantity", () => {
        const body = {
            symbol: "BTCUSDT",
            side: "SELL",
            type: "LIMIT",
            timeInForce: "GTC",
            quantity: "-0.5",
            price: "65000",
        };
        expect(() => quantizeBinanceOrderBody(body, BTCUSDT)).toThrow(
            /non-positive order quantity rejected/i,
        );
    });

    it("throws on a zero quantity", () => {
        const body = {
            symbol: "BTCUSDT",
            side: "BUY",
            type: "LIMIT",
            timeInForce: "GTC",
            quantity: "0",
            price: "65000",
        };
        expect(() => quantizeBinanceOrderBody(body, BTCUSDT)).toThrow(
            /non-positive order quantity rejected/i,
        );
    });

    it("throws on a negative price", () => {
        const body = {
            symbol: "BTCUSDT",
            side: "BUY",
            type: "LIMIT",
            timeInForce: "GTC",
            quantity: "0.001",
            price: "-100",
        };
        expect(() => quantizeBinanceOrderBody(body, BTCUSDT)).toThrow(
            /non-positive order quantity rejected/i,
        );
    });

    it("still passes a perfectly valid positive order through unchanged shape", () => {
        const body = {
            symbol: "BTCUSDT",
            side: "BUY",
            type: "LIMIT",
            timeInForce: "GTC",
            quantity: "0.001",
            price: "65000",
        };
        const out = quantizeBinanceOrderBody(body, BTCUSDT);
        expect(out.quantity).toBe("0.001");
        expect(out.price).toBe("65000");
    });
});
