import { describe, it, expect, beforeAll } from "vitest";
import jwt from "jsonwebtoken";
import { generateKeyPairSync } from "crypto";
import { loadJwtPublicKey } from "../src/auth/verifyJwt";
import { extractUserEmail, getUserInfo, emailToUserId } from "../src/ipUtils";

let privateKey: string;

beforeAll(() => {
    const pair = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    privateKey = pair.privateKey;
    process.env.JWT_PUBLIC_KEY_B64 = Buffer.from(pair.publicKey).toString("base64");
    loadJwtPublicKey();
});

function req(token?: string, ip = "203.0.113.7"): any {
    return {
        headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            "x-forwarded-for": ip,
        },
        connection: {},
        socket: {},
    };
}

describe("auth integration", () => {
    it("authenticated request resolves to email-user UUID", () => {
        const token = jwt.sign({ email: "alice@example.com" }, privateKey, {
            algorithm: "RS256",
            expiresIn: "1h",
        });
        const info = getUserInfo(req(token));
        expect(info.type).toBe("authenticated");
        expect(info.email).toBe("alice@example.com");
        expect(info.userId).toBe(emailToUserId("alice@example.com"));
    });

    it("two requests for the same user produce identical UUIDs", () => {
        const t1 = jwt.sign({ email: "bob@example.com" }, privateKey, {
            algorithm: "RS256",
            expiresIn: "1h",
        });
        const t2 = jwt.sign({ email: "BOB@example.com" }, privateKey, {
            algorithm: "RS256",
            expiresIn: "2h",
        });
        expect(getUserInfo(req(t1)).userId).toBe(getUserInfo(req(t2)).userId);
    });

    it("missing token falls back to anonymous IP-based identity", () => {
        const info = getUserInfo(req(undefined, "198.51.100.4"));
        expect(info.type).toBe("anonymous");
        expect(info.email).toBeNull();
    });

    it("forged HS256 token does NOT grant authenticated identity", () => {
        const forged = jwt.sign(
            { email: "admin@sentiedge.ai" },
            "guessed-secret",
            { algorithm: "HS256", expiresIn: "1h" },
        );
        const info = getUserInfo(req(forged));
        expect(info.type).toBe("anonymous");
    });

    it("extractUserEmail returns null for unauthenticated requests", () => {
        expect(extractUserEmail(req())).toBeNull();
    });

    it("forged user_info cookie is ignored — server attributes anonymous identity", () => {
        // Pre-fix regression: a forged cookie like this granted impersonation
        // because extractUserEmail read req.cookies.user_info and trusted the
        // JSON contents. Post-fix the cookie path is gone; this request must
        // resolve to anonymous-IP identity, NOT the forged email.
        const forgedPayload = JSON.stringify({
            email: "admin@sentiedge.ai",
            userId: "00000000-0000-0000-0000-000000000000",
        });
        const reqWithForgedCookie: any = {
            headers: { "x-forwarded-for": "203.0.113.99" },
            connection: {},
            socket: {},
            cookies: { user_info: forgedPayload },
            signedCookies: { user_info: forgedPayload },
        };
        const info = getUserInfo(reqWithForgedCookie);
        expect(info.type).toBe("anonymous");
        expect(info.email).toBeNull();
        expect(info.userId).not.toBe(emailToUserId("admin@sentiedge.ai"));
    });
});
