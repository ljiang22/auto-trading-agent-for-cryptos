import crypto from "crypto";
import jwt from "jsonwebtoken";

/** HMAC-SHA256 of `message` using `secret`, returned as lowercase hex (common for signed query strings). */
export function signHmacSha256Hex(secret: string, message: string): string {
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(message);
    return hmac.digest("hex");
}

type JwtAlgorithm = "ES256";

/** Env files often store PEM as one line with literal `\n` instead of newlines — breaks `jsonwebtoken` ES256 parsing. */
function normalizePemFromEnv(value: string): string {
    let v = value.trim();
    if (v.includes("\\r\\n")) {
        v = v.replace(/\\r\\n/g, "\r\n");
    }
    if (v.includes("\\n")) {
        v = v.replace(/\\n/g, "\n");
    }
    if (v.includes("\\r")) {
        v = v.replace(/\\r/g, "\r");
    }
    return v;
}

/** Build PEM for ES256: use full PEM if already present, else wrap SEC1 EC body (base64 between headers). */
function buildEs256PrivateKeyPem(privateKey: string): string {
    const normalized = normalizePemFromEnv(privateKey);
    const t = normalized.trim();
    if (/^-----BEGIN[A-Z0-9 ]+-----/m.test(t)) {
        return t;
    }
    return `-----BEGIN EC PRIVATE KEY-----\n${t}\n-----END EC PRIVATE KEY-----`;
}

export interface SignJwtParams {
    privateKey: string;
    keyId: string;
    algorithm: JwtAlgorithm;
    payload: Record<string, unknown>;
    headerExtras?: Record<string, unknown>;
}

export function signJwt(params: SignJwtParams): string {
    const { privateKey, keyId, algorithm, payload } = params;

    if (algorithm !== "ES256") {
        throw new Error(`Unsupported JWT algorithm: ${algorithm}`);
    }

    // `jsonwebtoken` expects `options.header` to match its `JwtHeader` type.
    // Random `nonce` is included for APIs that require a unique header per request.
    const header = {
        alg: algorithm,
        kid: keyId,
        nonce: crypto.randomBytes(16).toString("hex"),
    } as jwt.JwtHeader;

    const keySecret = buildEs256PrivateKeyPem(privateKey);

    return jwt.sign(payload, keySecret, { algorithm, header });
}
