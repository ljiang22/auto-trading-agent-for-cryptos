/**
 * Django login → JWT session for agent API calls.
 * Production uses Bearer tokens; user_info cookie forgery is not supported.
 */

import { normalizeBaseUrl, buildAuthHeaders, fetchJson } from "./http.mjs";

/**
 * @typedef {Object} AuthSession
 * @property {string} accessToken
 * @property {string} [cookieHeader] - e.g. access_token=...
 * @property {string} email
 */

/**
 * Parse access_token from Set-Cookie header value(s).
 * @param {Headers} headers
 */
function extractAccessTokenFromHeaders(headers) {
    const getSetCookie = headers.getSetCookie?.bind(headers);
    if (typeof getSetCookie === "function") {
        for (const cookie of getSetCookie()) {
            const match = /^access_token=([^;]+)/i.exec(cookie);
            if (match?.[1]) {
                return decodeURIComponent(match[1].trim());
            }
        }
    }

    const raw = headers.get("set-cookie");
    if (!raw) {
        return null;
    }
    const parts = raw.split(/,(?=\s*[^;,]+=)/);
    for (const part of parts) {
        const match = /access_token=([^;]+)/i.exec(part);
        if (match?.[1]) {
            return decodeURIComponent(match[1].trim());
        }
    }
    return null;
}

/**
 * @param {{ authBaseUrl: string, email: string, password: string }} input
 * @returns {Promise<AuthSession>}
 */
export async function login(input) {
    const authBase = normalizeBaseUrl(input.authBaseUrl);
    const email = input.email?.trim();
    const password = input.password;
    if (!email || password == null || password === "") {
        throw new Error("login requires email and password");
    }

    const loginUrl = `${authBase}/authentication/validation/`;
    const response = await fetch(loginUrl, {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password }),
    });

    const text = await response.text();
    let body = null;
    if (text.trim()) {
        try {
            body = JSON.parse(text);
        } catch {
            body = null;
        }
    }

    if (!response.ok) {
        throw new Error(
            `Login failed HTTP ${response.status}: ${text.slice(0, 500)}`,
        );
    }

    const accessToken =
        extractAccessTokenFromHeaders(response.headers) ||
        (typeof body?.access_token === "string" ? body.access_token : null) ||
        (typeof body?.token === "string" ? body.token : null);

    if (!accessToken) {
        throw new Error(
            "Login succeeded but no access_token found in Set-Cookie or response body",
        );
    }

    return {
        accessToken,
        cookieHeader: `access_token=${accessToken}`,
        email: email.toLowerCase(),
    };
}

/**
 * Sanity-check session against the agent's /authentication/me/.
 * @param {string} agentBaseUrl
 * @param {AuthSession} session
 */
export async function probeAgentAuth(agentBaseUrl, session) {
    const base = normalizeBaseUrl(agentBaseUrl);
    const data = await fetchJson(`${base}/authentication/me/`, {
        method: "GET",
        headers: buildAuthHeaders(session, { Accept: "application/json" }),
    });
    return data;
}
