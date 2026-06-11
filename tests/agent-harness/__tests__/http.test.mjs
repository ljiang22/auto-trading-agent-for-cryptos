import { describe, expect, it } from "vitest";
import { buildAuthHeaders, normalizeBaseUrl } from "../lib/http.mjs";

describe("normalizeBaseUrl", () => {
    it("strips trailing slash", () => {
        expect(normalizeBaseUrl("https://api.example.com/")).toBe(
            "https://api.example.com",
        );
    });
});

describe("buildAuthHeaders", () => {
    it("sets Bearer and Cookie from session", () => {
        const headers = buildAuthHeaders({
            accessToken: "jwt-abc",
            cookieHeader: "access_token=jwt-abc",
            email: "a@b.com",
        });
        expect(headers.Authorization).toBe("Bearer jwt-abc");
        expect(headers.Cookie).toBe("access_token=jwt-abc");
    });

    it("merges extra headers and cookies", () => {
        const headers = buildAuthHeaders(
            { accessToken: "t", cookieHeader: "access_token=t" },
            { Cookie: "other=1", "X-Test": "1" },
        );
        expect(headers["X-Test"]).toBe("1");
        expect(headers.Cookie).toContain("other=1");
        expect(headers.Cookie).toContain("access_token=t");
    });
});
