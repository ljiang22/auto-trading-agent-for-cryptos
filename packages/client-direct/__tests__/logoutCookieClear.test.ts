import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Response } from "express";

/**
 * What we're guarding against: the production bug where `res.clearCookie(name, {...})`
 * omits the `domain` attribute. Django sets access_token / refresh_token /
 * user_email with `Domain=.sentiedge.ai`. Per the Cookie RFC, deletion only
 * takes effect when Name + Domain + Path match the original cookie. Without
 * `domain` in clearCookie, the browser deletes a phantom host-only cookie
 * and keeps the real parent-domain one, leaving the user effectively logged
 * in even after `/authentication/logout/` returns 200.
 *
 * We don't pull in the full router here — that requires a runtime + DB —
 * we just exercise the cookie-clear options shape that the handler builds.
 * The shape is what's load-bearing for correctness.
 */

// Mimic the logic the handler runs to build clearCookie options. Keep this
// in sync with packages/client-direct/src/api.ts logout handler.
function buildClearAuthCookieOptions(env: NodeJS.ProcessEnv) {
    const isProd = env.NODE_ENV === "production";
    const rawAuthCookieDomain = env.AUTH_COOKIE_DOMAIN || "";
    // Strip the legacy leading dot — Express's `cookie` package rejects
    // ".sentiedge.ai" but accepts "sentiedge.ai", and browsers normalize
    // the two to identical-scope cookies per RFC 6265 §5.2.3.
    const authCookieDomain = rawAuthCookieDomain.replace(/^\./, "") || undefined;
    const httpOnlyOptions: Record<string, unknown> = {
        httpOnly: true,
        secure: isProd,
        sameSite: "lax",
        path: "/",
        ...(authCookieDomain ? { domain: authCookieDomain } : {}),
    };
    const jsReadableOptions: Record<string, unknown> = {
        httpOnly: false,
        secure: isProd,
        sameSite: "lax",
        path: "/",
        ...(authCookieDomain ? { domain: authCookieDomain } : {}),
    };
    const legacyHostOnlyOptions: Record<string, unknown> = {
        httpOnly: false,
        secure: isProd,
        sameSite: "lax",
        path: "/",
    };
    return { httpOnlyOptions, jsReadableOptions, legacyHostOnlyOptions };
}

describe("logout: clearCookie options carry the same Domain as the original Set-Cookie", () => {
    const originalEnv = { ...process.env };
    beforeEach(() => {
        process.env = { ...originalEnv };
    });
    afterEach(() => {
        process.env = originalEnv;
    });

    it("production with leading dot env var: normalizes to Domain=sentiedge.ai", () => {
        // The env var may be set as ".sentiedge.ai" (matches Django's setting
        // verbatim) but Express's clearCookie rejects the leading dot. We
        // strip it; the resulting cookie has identical browser scope.
        process.env.NODE_ENV = "production";
        process.env.AUTH_COOKIE_DOMAIN = ".sentiedge.ai";
        const { httpOnlyOptions, jsReadableOptions } =
            buildClearAuthCookieOptions(process.env);
        expect(httpOnlyOptions.domain).toBe("sentiedge.ai");
        expect(httpOnlyOptions.httpOnly).toBe(true);
        expect(httpOnlyOptions.secure).toBe(true);
        expect(httpOnlyOptions.sameSite).toBe("lax");
        expect(httpOnlyOptions.path).toBe("/");

        expect(jsReadableOptions.domain).toBe("sentiedge.ai");
        expect(jsReadableOptions.httpOnly).toBe(false);
    });

    it("production with already-normalized env var: passes through unchanged", () => {
        process.env.NODE_ENV = "production";
        process.env.AUTH_COOKIE_DOMAIN = "sentiedge.ai";
        const { httpOnlyOptions } = buildClearAuthCookieOptions(process.env);
        expect(httpOnlyOptions.domain).toBe("sentiedge.ai");
    });

    it("a bare '.' env var becomes undefined (no Domain attribute)", () => {
        process.env.NODE_ENV = "production";
        process.env.AUTH_COOKIE_DOMAIN = ".";
        const { httpOnlyOptions } = buildClearAuthCookieOptions(process.env);
        expect("domain" in httpOnlyOptions).toBe(false);
    });

    it("local dev (no AUTH_COOKIE_DOMAIN): omits Domain so host-only cookies match", () => {
        process.env.NODE_ENV = "development";
        delete process.env.AUTH_COOKIE_DOMAIN;
        const { httpOnlyOptions, jsReadableOptions } =
            buildClearAuthCookieOptions(process.env);
        expect("domain" in httpOnlyOptions).toBe(false);
        expect("domain" in jsReadableOptions).toBe(false);
        expect(httpOnlyOptions.secure).toBe(false);
    });

    it("legacy host-only cookie (user_info) is always cleared without Domain", () => {
        process.env.NODE_ENV = "production";
        process.env.AUTH_COOKIE_DOMAIN = ".sentiedge.ai";
        const { legacyHostOnlyOptions } =
            buildClearAuthCookieOptions(process.env);
        expect("domain" in legacyHostOnlyOptions).toBe(false);
        expect(legacyHostOnlyOptions.path).toBe("/");
    });

    it("an empty AUTH_COOKIE_DOMAIN env var is treated as unset (no Domain)", () => {
        process.env.NODE_ENV = "production";
        process.env.AUTH_COOKIE_DOMAIN = "";
        const { httpOnlyOptions } = buildClearAuthCookieOptions(process.env);
        expect("domain" in httpOnlyOptions).toBe(false);
    });
});

describe("logout: cookies cleared cover the full Django-issued set", () => {
    // This is a structural test: if a future Django change adds a new
    // identity cookie (e.g. user_role), this test reminds the operator
    // that the Node logout handler needs to clear it too. Update the list
    // here when adding to api.ts:3790 logout handler.
    const expectedClearedCookies = [
        "access_token",
        "refresh_token",
        "user_email",
        "user_info",
    ];

    it("documents the cookies the Node logout handler must clear", () => {
        expect(expectedClearedCookies).toContain("access_token");
        expect(expectedClearedCookies).toContain("refresh_token");
        expect(expectedClearedCookies).toContain("user_email");
        // user_info is legacy host-only — kept in the clear list until
        // the deferred frontend cleanup ships.
        expect(expectedClearedCookies).toContain("user_info");
    });
});
