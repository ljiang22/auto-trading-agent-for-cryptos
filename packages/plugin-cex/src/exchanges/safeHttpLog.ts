/** Normalized key names that are identifiers, not secrets (never redact). */
const KEY_NAME_ALLOWLIST = new Set([
    "apikeyname",
    "keyid",
    "kid",
    "keyname",
]);

/** Substrings (normalized: no underscores) that mark a sensitive field. */
const SENSITIVE_KEY_FRAGMENTS = [
    "signature",
    "apisecret",
    "apikeysecret",
    "password",
    "accesstoken",
    "refreshtoken",
    "authorization",
    "privatekey",
    "mnemonic",
    "passphrase",
    "clientsecret",
    "credential",
    "bearer",
    "cookie",
    "jwt",
    "seed",
    "totp",
    "otp",
] as const;

const REDACTED = "[REDACTED]";

function isSensitiveKey(key: string): boolean {
    const norm = key.toLowerCase().replace(/_/g, "");
    if (KEY_NAME_ALLOWLIST.has(norm)) return false;
    if (norm === "apikey") return true;
    if (norm === "secret" || norm.endsWith("secret")) return true;
    if (norm.includes("token") && (norm.includes("access") || norm.includes("refresh") || norm === "token"))
        return true;
    for (const frag of SENSITIVE_KEY_FRAGMENTS) {
        if (norm.includes(frag.replace(/_/g, ""))) return true;
    }
    return false;
}

export type SanitizeForLogOptions = {
    /** Max object/array nesting depth; deeper nodes replaced with a placeholder. */
    maxDepth?: number;
};

/**
 * Deep-clone plain JSON-like values for debug logs, redacting sensitive keys.
 */
export function sanitizeForLog(value: unknown, options: SanitizeForLogOptions = {}): unknown {
    const maxDepth = options.maxDepth ?? 6;

    function walk(v: unknown, depth: number): unknown {
        if (depth > maxDepth) return "[TRUNCATED_DEPTH]";

        if (v === null || v === undefined) return v;

        if (typeof v === "bigint") return v.toString();

        if (Array.isArray(v)) {
            return v.map((item) => walk(item, depth + 1));
        }

        if (typeof v === "object") {
            const rec = v as Record<string, unknown>;
            const out: Record<string, unknown> = {};
            for (const [k, val] of Object.entries(rec)) {
                if (isSensitiveKey(k)) {
                    out[k] = REDACTED;
                } else {
                    out[k] = walk(val, depth + 1);
                }
            }
            return out;
        }

        return v;
    }

    return walk(value, 0);
}

const MAX_SUMMARY_KEYS = 24;

export type ResponseSummary =
    | { kind: "null" }
    | { kind: "undefined" }
    | { kind: "array"; length: number }
    | { kind: "object"; keys: string[]; totalKeys: number }
    | { kind: "string"; length: number }
    | { kind: "number" | "boolean" | "bigint" };

/**
 * Non-identifying summary for info-level logs (no array elements, no object values).
 */
export function summarizeResponseForLog(data: unknown): ResponseSummary {
    if (data === null) return { kind: "null" };
    if (data === undefined) return { kind: "undefined" };

    if (Array.isArray(data)) {
        return { kind: "array", length: data.length };
    }

    if (typeof data === "object") {
        const keys = Object.keys(data as Record<string, unknown>);
        return {
            kind: "object",
            keys: keys.slice(0, MAX_SUMMARY_KEYS),
            totalKeys: keys.length,
        };
    }

    if (typeof data === "string") {
        return { kind: "string", length: data.length };
    }

    if (typeof data === "number" || typeof data === "boolean") {
        return { kind: typeof data };
    }

    if (typeof data === "bigint") {
        return { kind: "bigint" };
    }

    return { kind: "string", length: String(data).length };
}
