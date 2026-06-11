import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signedMarginOpenOrders } from "../src/exchanges/services/binanceMargin";

/**
 * B4 — verifies the new margin-openOrders helper hits the correct
 * Binance endpoint. We can't fully unit-test `BinanceOrdersService.getOrders`
 * without the SDK ceremony, but the helper is the load-bearing piece
 * (the dispatch is a single-line `if (params.margin_type) → call`).
 */

const realFetch = globalThis.fetch;

beforeEach(() => {
    vi.restoreAllMocks();
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

function mockOk(body: unknown): { ok: boolean; status: number; statusText: string; text: () => Promise<string> } {
    return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify(body),
    };
}

describe("signedMarginOpenOrders — Binance margin open-orders dispatch (B4)", () => {
    it("hits /sapi/v1/margin/openOrders with isIsolated=FALSE for CROSS", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(
            mockOk([{ orderId: 1, symbol: "BTCUSDT", side: "SELL", price: "60000" }]),
        );
        globalThis.fetch = fetchSpy as unknown as typeof fetch;

        const orders = await signedMarginOpenOrders("apikey", "secret", { isIsolated: "FALSE" });

        expect(fetchSpy).toHaveBeenCalledOnce();
        const [url, init] = fetchSpy.mock.calls[0];
        expect(String(url)).toContain("/sapi/v1/margin/openOrders");
        expect(String(url)).toContain("isIsolated=FALSE");
        expect(String(url)).toContain("signature=");
        expect((init as Record<string, unknown>).method).toBe("GET");
        const headers = (init as { headers: Record<string, string> }).headers;
        expect(headers["X-MBX-APIKEY"]).toBe("apikey");
        expect(orders).toHaveLength(1);
    });

    it("forwards isIsolated=TRUE when caller asks for ISOLATED", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(mockOk([]));
        globalThis.fetch = fetchSpy as unknown as typeof fetch;
        await signedMarginOpenOrders("apikey", "secret", { isIsolated: "TRUE", symbol: "BTCUSDT" });

        const [url] = fetchSpy.mock.calls[0];
        expect(String(url)).toContain("isIsolated=TRUE");
        expect(String(url)).toContain("symbol=BTCUSDT");
    });

    it("returns [] when Binance responds with a non-array body (defensive)", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(mockOk({ msg: "no orders" }));
        globalThis.fetch = fetchSpy as unknown as typeof fetch;
        const orders = await signedMarginOpenOrders("apikey", "secret", { isIsolated: "FALSE" });
        expect(orders).toEqual([]);
    });

    it("throws when Binance returns a non-OK status (so caller can surface the error)", async () => {
        const fetchSpy = vi.fn().mockResolvedValue({
            ok: false,
            status: 400,
            statusText: "Bad Request",
            text: async () => JSON.stringify({ code: -2010, msg: "no margin account" }),
        });
        globalThis.fetch = fetchSpy as unknown as typeof fetch;
        await expect(
            signedMarginOpenOrders("apikey", "secret", { isIsolated: "FALSE" }),
        ).rejects.toThrow(/binance-margin.*400.*no margin account/i);
    });
});
