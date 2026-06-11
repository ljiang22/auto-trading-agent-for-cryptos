import { describe, expect, it } from "vitest";
import { sanitizeVenueRequest, sanitizeVenueResponse } from "../../src/observability/venueCallLog";

describe("venueCallLog sanitization", () => {
    it("redacts known sensitive top-level keys", () => {
        const out = sanitizeVenueRequest({
            apiKey: "ABCDEFG",
            symbol: "BTCUSDT",
            signature: "deadbeef",
            quantity: "0.1",
        }) as Record<string, unknown>;
        expect(out.apiKey).toBe("<redacted>");
        expect(out.signature).toBe("<redacted>");
        expect(out.symbol).toBe("BTCUSDT");
        expect(out.quantity).toBe("0.1");
    });

    it("redacts case-insensitively (X-MBX-APIKEY etc.)", () => {
        const out = sanitizeVenueRequest({
            headers: { "X-MBX-APIKEY": "ABC", "Content-Type": "json" },
        }) as Record<string, Record<string, unknown>>;
        expect(out.headers["X-MBX-APIKEY"]).toBe("<redacted>");
        expect(out.headers["Content-Type"]).toBe("json");
    });

    it("walks nested structures", () => {
        const out = sanitizeVenueRequest({
            outer: {
                inner: {
                    api_secret: "abcd",
                    public: "ok",
                },
            },
        }) as Record<string, Record<string, Record<string, unknown>>>;
        expect(out.outer.inner.api_secret).toBe("<redacted>");
        expect(out.outer.inner.public).toBe("ok");
    });

    it("handles arrays", () => {
        const out = sanitizeVenueRequest({
            list: [{ token: "a" }, { token: "b" }],
        }) as Record<string, Array<Record<string, unknown>>>;
        expect(out.list[0].token).toBe("<redacted>");
        expect(out.list[1].token).toBe("<redacted>");
    });

    it("response sanitizer applies the same policy", () => {
        const out = sanitizeVenueResponse({ access_token: "x", balance: "100" }) as Record<
            string,
            unknown
        >;
        expect(out.access_token).toBe("<redacted>");
        expect(out.balance).toBe("100");
    });

    it("handles primitives without crashing", () => {
        expect(sanitizeVenueRequest(null)).toBeNull();
        expect(sanitizeVenueRequest("hello")).toBe("hello");
        expect(sanitizeVenueRequest(42)).toBe(42);
    });
});
