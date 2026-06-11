import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signedMarginQueryOrder } from "../src/exchanges/services/binanceMargin";

/**
 * B2 — covers the margin order-status helper used by the
 * reconciliation poller to resolve stuck margin orders. Without this
 * dispatch, the poller hits the spot `/api/v3/order` endpoint and
 * Binance returns `code:-2013 "Order does not exist."` for every margin
 * order on every poll, leaving the ledger row stuck forever.
 */

const realFetch = globalThis.fetch;

beforeEach(() => {
    vi.restoreAllMocks();
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

function jsonOk(body: unknown) {
    return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify(body),
    };
}

describe("signedMarginQueryOrder", () => {
    it("hits /sapi/v1/margin/order with the canonical query shape", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(
            jsonOk({ status: "NEW", orderId: 42, origClientOrderId: "co-1" }),
        );
        globalThis.fetch = fetchSpy as unknown as typeof fetch;

        const out = await signedMarginQueryOrder("apikey", "secret", {
            symbol: "BTCUSDT",
            origClientOrderId: "co-1",
            isIsolated: "FALSE",
        });

        expect(fetchSpy).toHaveBeenCalledOnce();
        const [url, init] = fetchSpy.mock.calls[0];
        expect(String(url)).toContain("/sapi/v1/margin/order");
        expect(String(url)).toContain("symbol=BTCUSDT");
        expect(String(url)).toContain("origClientOrderId=co-1");
        expect(String(url)).toContain("isIsolated=FALSE");
        expect(String(url)).toContain("signature=");
        expect((init as { method: string }).method).toBe("GET");
        expect((out as { status?: string }).status).toBe("NEW");
    });

    it("treats Binance -2013 as `not found` (returns null) so the poller can resolve", async () => {
        const fetchSpy = vi.fn().mockResolvedValue({
            ok: false,
            status: 400,
            statusText: "Bad Request",
            text: async () => JSON.stringify({ code: -2013, msg: "Order does not exist." }),
        });
        globalThis.fetch = fetchSpy as unknown as typeof fetch;
        const out = await signedMarginQueryOrder("apikey", "secret", {
            symbol: "BTCUSDT",
            origClientOrderId: "co-2",
        });
        expect(out).toBeNull();
    });

    it("returns null on 404", async () => {
        const fetchSpy = vi.fn().mockResolvedValue({
            ok: false,
            status: 404,
            statusText: "Not Found",
            text: async () => "",
        });
        globalThis.fetch = fetchSpy as unknown as typeof fetch;
        const out = await signedMarginQueryOrder("apikey", "secret", {
            symbol: "BTCUSDT",
            origClientOrderId: "co-3",
        });
        expect(out).toBeNull();
    });

    it("throws on other 4xx (e.g. 401 auth) so the caller can retry", async () => {
        const fetchSpy = vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
            statusText: "Unauthorized",
            text: async () => JSON.stringify({ code: -2014, msg: "API-key format invalid." }),
        });
        globalThis.fetch = fetchSpy as unknown as typeof fetch;
        await expect(
            signedMarginQueryOrder("apikey", "secret", {
                symbol: "BTCUSDT",
                origClientOrderId: "co-4",
            }),
        ).rejects.toThrow(/binance-margin.*401/i);
    });

    it("forwards isIsolated=TRUE when caller specifies ISOLATED", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(
            jsonOk({ status: "FILLED" }),
        );
        globalThis.fetch = fetchSpy as unknown as typeof fetch;
        await signedMarginQueryOrder("apikey", "secret", {
            symbol: "BTCUSDT",
            origClientOrderId: "co-5",
            isIsolated: "TRUE",
        });
        const [url] = fetchSpy.mock.calls[0];
        expect(String(url)).toContain("isIsolated=TRUE");
    });
});
