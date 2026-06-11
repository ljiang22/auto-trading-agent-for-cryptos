import { describe, it, expect, beforeAll } from "vitest";
import jwt from "jsonwebtoken";
import { generateKeyPairSync } from "crypto";
import { verifyBearerJwt, loadJwtPublicKey } from "../src/auth/verifyJwt";
import { emailToUserId } from "../src/ipUtils";

let publicKey: string;
let privateKey: string;
let wrongPrivateKey: string;

beforeAll(() => {
    const pair = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    publicKey = pair.publicKey;
    privateKey = pair.privateKey;
    const otherPair = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    wrongPrivateKey = otherPair.privateKey;
    process.env.JWT_PUBLIC_KEY_B64 = Buffer.from(publicKey).toString("base64");
    loadJwtPublicKey();
});

function reqWithAuth(token: string | null): any {
    return { headers: token ? { authorization: `Bearer ${token}` } : {} };
}

function reqWithCookie(token: string | null): any {
    return {
        headers: {},
        cookies: token ? { access_token: token } : {},
    };
}

function reqWithHeaderAndCookie(headerToken: string, cookieToken: string): any {
    return {
        headers: { authorization: `Bearer ${headerToken}` },
        cookies: { access_token: cookieToken },
    };
}

describe("verifyBearerJwt", () => {
    it("returns userId + email for valid RS256 token with email claim", () => {
        const token = jwt.sign(
            { email: "alice@example.com", user_id: 1 },
            privateKey,
            { algorithm: "RS256", expiresIn: "1h" },
        );
        const result = verifyBearerJwt(reqWithAuth(token));
        expect(result).not.toBeNull();
        expect(result!.email).toBe("alice@example.com");
        expect(result!.userId).toBe(emailToUserId("alice@example.com"));
    });

    it("normalizes email casing and whitespace", () => {
        const token = jwt.sign(
            { email: "  ALICE@Example.com  " },
            privateKey,
            { algorithm: "RS256", expiresIn: "1h" },
        );
        const result = verifyBearerJwt(reqWithAuth(token));
        expect(result!.email).toBe("alice@example.com");
    });

    it("returns null when email claim is missing", () => {
        const token = jwt.sign({ user_id: 1 }, privateKey, {
            algorithm: "RS256",
            expiresIn: "1h",
        });
        expect(verifyBearerJwt(reqWithAuth(token))).toBeNull();
    });

    it("returns null when token is expired", () => {
        const token = jwt.sign(
            { email: "a@b.com" },
            privateKey,
            { algorithm: "RS256", expiresIn: "-1s" },
        );
        expect(verifyBearerJwt(reqWithAuth(token))).toBeNull();
    });

    it("returns null when signed by a different key", () => {
        const token = jwt.sign(
            { email: "a@b.com" },
            wrongPrivateKey,
            { algorithm: "RS256", expiresIn: "1h" },
        );
        expect(verifyBearerJwt(reqWithAuth(token))).toBeNull();
    });

    it("rejects HS256-signed tokens (algorithm confusion guard)", () => {
        const token = jwt.sign({ email: "a@b.com" }, "shared-secret", {
            algorithm: "HS256",
            expiresIn: "1h",
        });
        expect(verifyBearerJwt(reqWithAuth(token))).toBeNull();
    });

    it("returns null on tampered payload", () => {
        const token = jwt.sign(
            { email: "a@b.com" },
            privateKey,
            { algorithm: "RS256", expiresIn: "1h" },
        );
        const parts = token.split(".");
        const tamperedPayload = Buffer.from(
            JSON.stringify({ email: "evil@b.com", exp: Math.floor(Date.now() / 1000) + 3600 }),
        ).toString("base64url");
        const tampered = [parts[0], tamperedPayload, parts[2]].join(".");
        expect(verifyBearerJwt(reqWithAuth(tampered))).toBeNull();
    });

    it("returns null when Authorization header is missing", () => {
        expect(verifyBearerJwt(reqWithAuth(null))).toBeNull();
    });

    it("returns null for malformed Bearer", () => {
        expect(verifyBearerJwt({ headers: { authorization: "Bearer " } })).toBeNull();
        expect(verifyBearerJwt({ headers: { authorization: "Basic xxx" } })).toBeNull();
        expect(verifyBearerJwt({ headers: { authorization: "Bearer not.a.jwt" } })).toBeNull();
    });

    it("authenticates from access_token cookie when no Authorization header is present", () => {
        // Browser-initiated asset loads (<img>, <iframe>) can't set custom
        // headers but DO send cookies — this path is what keeps charts and
        // report iframes working post-cutover.
        const token = jwt.sign(
            { email: "carol@example.com" },
            privateKey,
            { algorithm: "RS256", expiresIn: "1h" },
        );
        const result = verifyBearerJwt(reqWithCookie(token));
        expect(result).not.toBeNull();
        expect(result!.email).toBe("carol@example.com");
        expect(result!.userId).toBe(emailToUserId("carol@example.com"));
    });

    it("rejects a forged HS256 token in the access_token cookie", () => {
        const forged = jwt.sign({ email: "admin@sentiedge.ai" }, "guessed", {
            algorithm: "HS256", expiresIn: "1h",
        });
        expect(verifyBearerJwt(reqWithCookie(forged))).toBeNull();
    });

    it("rejects a cookie token signed by a different RSA key", () => {
        const token = jwt.sign(
            { email: "carol@example.com" },
            wrongPrivateKey,
            { algorithm: "RS256", expiresIn: "1h" },
        );
        expect(verifyBearerJwt(reqWithCookie(token))).toBeNull();
    });

    it("prefers Authorization header over access_token cookie", () => {
        // Header is the explicit, intentional auth signal; cookie is the
        // fallback. If both are present and they disagree, the header wins.
        const headerToken = jwt.sign(
            { email: "header@example.com" },
            privateKey,
            { algorithm: "RS256", expiresIn: "1h" },
        );
        const cookieToken = jwt.sign(
            { email: "cookie@example.com" },
            privateKey,
            { algorithm: "RS256", expiresIn: "1h" },
        );
        const result = verifyBearerJwt(reqWithHeaderAndCookie(headerToken, cookieToken));
        expect(result!.email).toBe("header@example.com");
    });

    it("falls through to null when neither header nor cookie carries a token", () => {
        expect(verifyBearerJwt({ headers: {}, cookies: {} } as any)).toBeNull();
    });

    it("ignores non-string cookie values", () => {
        const req: any = {
            headers: {},
            cookies: { access_token: 12345 },
        };
        expect(verifyBearerJwt(req)).toBeNull();
    });
});

describe("loadJwtPublicKey boot behavior (does NOT throw)", () => {
    it("when JWT_PUBLIC_KEY_B64 is missing: does not throw, verifyBearerJwt returns null", () => {
        const original = process.env.JWT_PUBLIC_KEY_B64;
        delete process.env.JWT_PUBLIC_KEY_B64;
        expect(() => loadJwtPublicKey()).not.toThrow();
        const token = jwt.sign({ email: "x@y.com" }, privateKey, {
            algorithm: "RS256", expiresIn: "1h",
        });
        expect(verifyBearerJwt(reqWithAuth(token))).toBeNull();
        process.env.JWT_PUBLIC_KEY_B64 = original;
        loadJwtPublicKey();
    });

    it("when JWT_PUBLIC_KEY_B64 decodes to non-PEM garbage: does not throw, verifyBearerJwt returns null", () => {
        const original = process.env.JWT_PUBLIC_KEY_B64;
        process.env.JWT_PUBLIC_KEY_B64 = Buffer.from("not a pem").toString("base64");
        expect(() => loadJwtPublicKey()).not.toThrow();
        const token = jwt.sign({ email: "x@y.com" }, privateKey, {
            algorithm: "RS256", expiresIn: "1h",
        });
        expect(verifyBearerJwt(reqWithAuth(token))).toBeNull();
        process.env.JWT_PUBLIC_KEY_B64 = original;
        loadJwtPublicKey();
    });

    it("when JWT_PUBLIC_KEY_B64 is valid base64-encoded PEM: loads and verifies normally", () => {
        expect(() => loadJwtPublicKey()).not.toThrow();
    });

    it("when JWT_PUBLIC_KEY_B64 decodes to a non-RSA public key (EC): does not throw, verifyBearerJwt returns null", () => {
        const original = process.env.JWT_PUBLIC_KEY_B64;
        const ecPair = generateKeyPairSync("ec", {
            namedCurve: "P-256",
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" },
        });
        process.env.JWT_PUBLIC_KEY_B64 = Buffer.from(ecPair.publicKey).toString("base64");
        expect(() => loadJwtPublicKey()).not.toThrow();
        const token = jwt.sign({ email: "x@y.com" }, privateKey, {
            algorithm: "RS256", expiresIn: "1h",
        });
        expect(verifyBearerJwt(reqWithAuth(token))).toBeNull();
        process.env.JWT_PUBLIC_KEY_B64 = original;
        loadJwtPublicKey();
    });
});
