/**
 * Shared HTTP helpers for the agent test harness.
 */

export function normalizeBaseUrl(baseUrl) {
    if (!baseUrl || typeof baseUrl !== "string") {
        throw new Error("baseUrl is required");
    }
    return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

/**
 * @param {import("./auth.mjs").AuthSession} session
 * @param {Record<string, string>} [extra]
 */
export function buildAuthHeaders(session, extra = {}) {
    const headers = { ...extra };
    if (session?.accessToken) {
        headers.Authorization = `Bearer ${session.accessToken}`;
    }
    if (session?.cookieHeader) {
        const existing = headers.Cookie;
        headers.Cookie = existing
            ? `${existing}; ${session.cookieHeader}`
            : session.cookieHeader;
    }
    return headers;
}

/**
 * @param {string} url
 * @param {RequestInit} options
 */
export async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${text}`);
    }
    if (!text.trim()) {
        return null;
    }
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}
