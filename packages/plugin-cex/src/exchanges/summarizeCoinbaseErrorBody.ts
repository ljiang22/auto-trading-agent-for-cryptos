/**
 * Extracts a short, human-readable summary from a Coinbase error response body.
 *
 * Coinbase Advanced Trade error payloads vary by endpoint: some return
 * `{ message, error }`, some nest under `error_response`, some surface a
 * `preview_failure_reason` for order previews. This helper flattens those
 * shapes into a single string suitable for an outer Error message; unknown
 * shapes fall back to a capped JSON dump.
 */

const KNOWN_KEYS = [
    "message",
    "error",
    "error_response",
    "error_details",
    "details",
    "preview_failure_reason",
    "failure_reason",
] as const;

const MAX_FALLBACK_LENGTH = 500;
const SEPARATOR = " — ";

function safeJsonStringify(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return "";
    }
}

function formatValue(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (typeof value === "bigint") return value.toString();
    if (Array.isArray(value)) return summarizeCoinbaseErrorBody(value);
    if (typeof value === "object") {
        const obj = value as Record<string, unknown>;
        const hasKnown = KNOWN_KEYS.some((k) => k in obj);
        if (hasKnown) return summarizeCoinbaseErrorBody(obj);
        return safeJsonStringify(obj);
    }
    return "";
}

export function summarizeCoinbaseErrorBody(body: unknown): string {
    if (body === null || body === undefined) return "";
    if (typeof body === "string") return body.trim();
    if (typeof body === "number" || typeof body === "boolean") return String(body);
    if (typeof body === "bigint") return body.toString();

    if (Array.isArray(body)) {
        return body
            .map((item) => summarizeCoinbaseErrorBody(item))
            .filter((s) => s !== "")
            .join(SEPARATOR);
    }

    if (typeof body === "object") {
        const obj = body as Record<string, unknown>;
        const parts: string[] = [];
        for (const key of KNOWN_KEYS) {
            if (key in obj) {
                const piece = formatValue(obj[key]);
                if (piece !== "") parts.push(piece);
            }
        }
        if (parts.length > 0) return parts.join(SEPARATOR);
        return safeJsonStringify(obj).slice(0, MAX_FALLBACK_LENGTH);
    }

    return "";
}
