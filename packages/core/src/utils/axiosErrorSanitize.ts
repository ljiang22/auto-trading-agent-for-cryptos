/**
 * Extract the actionable parts of an AxiosError without dumping the full
 * underlying object.
 *
 * Why this exists: passing a raw AxiosError to elizaLogger.error serializes
 * the entire error including the (very large) `response`, `request`, and
 * `socket` graphs. On 2026-05-05 a single CoinMetrics 403 produced ~6,500
 * lines of TLS/socket internals in CloudWatch (~287 lines/sec for 27 s) for
 * one error. That's noise — the only fields anyone ever reads in triage are
 * the HTTP status, status text, URL, and message. Keep it small.
 */
export function summarizeAxiosError(error: unknown): {
    message: string;
    status?: number;
    statusText?: string;
    url?: string;
    method?: string;
    code?: string;
    apiMessage?: string;
} {
    const e = error as {
        message?: string;
        code?: string;
        config?: { url?: string; method?: string; baseURL?: string };
        response?: {
            status?: number;
            statusText?: string;
            data?: unknown;
        };
    } | undefined;

    if (!e || typeof e !== "object") {
        return { message: String(error) };
    }

    // Best-effort extraction of the API's own error message — for AxiosError
    // the structured server reply is typically at error.response.data.message
    // or .error, depending on the API. Stringify with a length cap so a giant
    // payload can't sneak back in.
    let apiMessage: string | undefined;
    const data = e.response?.data;
    if (data && typeof data === "object") {
        const d = data as Record<string, unknown>;
        if (typeof d.message === "string") apiMessage = d.message;
        else if (typeof d.error === "string") apiMessage = d.error;
        else if (typeof d.detail === "string") apiMessage = d.detail;
    } else if (typeof data === "string") {
        apiMessage = data;
    }
    if (apiMessage && apiMessage.length > 500) {
        apiMessage = apiMessage.slice(0, 500) + "…";
    }

    return {
        message: e.message ?? "Unknown error",
        status: e.response?.status,
        statusText: e.response?.statusText,
        url: e.config?.url,
        method: e.config?.method?.toUpperCase(),
        code: e.code,
        apiMessage,
    };
}

/**
 * Format the summary as a single human-readable line for logs.
 */
export function formatAxiosErrorLine(error: unknown): string {
    const s = summarizeAxiosError(error);
    const parts: string[] = [];
    if (s.method && s.url) parts.push(`${s.method} ${s.url}`);
    else if (s.url) parts.push(s.url);
    if (s.status) parts.push(`status=${s.status}${s.statusText ? ` ${s.statusText}` : ""}`);
    if (s.code) parts.push(`code=${s.code}`);
    if (s.apiMessage) parts.push(`api="${s.apiMessage}"`);
    parts.push(`message="${s.message}"`);
    return parts.join(" ");
}
