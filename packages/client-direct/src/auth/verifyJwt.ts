import type express from "express";
import jwt from "jsonwebtoken";
import { createPublicKey } from "crypto";
import { elizaLogger, type UUID } from "@elizaos/core";
import { emailToUserId } from "../ipUtils";

let publicKeyPem: string | null = null;
let bootChecked = false;

/**
 * Read JWT_PUBLIC_KEY_B64 from env, base64-decode it, and validate it parses
 * as an RSA public key.
 *
 * Why base64: ECS env vars travel through JSON task definitions, Terraform,
 * Secrets Manager, etc. Multi-line PEMs with embedded \n escapes are fragile
 * across that chain ("works locally, fails on ECS"). Single-line base64
 * is safe to paste, diff, and log-redact.
 *
 * Failure modes (missing env var, malformed PEM) do NOT throw. They log an
 * ERROR once and leave publicKeyPem as null. verifyBearerJwt then returns
 * null for every request, which is the correct fail-safe: identity falls
 * through to anonymous-IP via getUserInfo's existing fallback. We avoid
 * process.exit because a missing/bad env var should degrade auth, not
 * crash-loop the container during a rolling deploy.
 */
export function loadJwtPublicKey(): void {
    const rawB64 = process.env.JWT_PUBLIC_KEY_B64;
    if (!rawB64 || rawB64.trim().length === 0) {
        if (!bootChecked) {
            elizaLogger.error(
                "[auth] JWT_PUBLIC_KEY_B64 is not set. Bearer-token auth is disabled; " +
                "all requests will resolve to anonymous IP-based identity until this is fixed.",
            );
        }
        publicKeyPem = null;
        bootChecked = true;
        return;
    }
    const pem = Buffer.from(rawB64.trim(), "base64").toString("utf-8");
    try {
        const keyObject = createPublicKey(pem);
        // jwt.verify({ algorithms: ['RS256'] }) would reject a non-RSA key at
        // request time with only a debug-level log line. Surface that as a
        // boot-time ERROR so a misconfigured EC/ed25519 key doesn't silently
        // disable auth in prod.
        if (keyObject.asymmetricKeyType !== "rsa") {
            elizaLogger.error(
                `[auth] JWT_PUBLIC_KEY_B64 decodes to a ${keyObject.asymmetricKeyType ?? "unknown"} key, but RS256 requires RSA. ` +
                "Bearer-token auth is disabled.",
            );
            publicKeyPem = null;
            bootChecked = true;
            return;
        }
    } catch (err) {
        elizaLogger.error(
            `[auth] JWT_PUBLIC_KEY_B64 does not decode to a valid PEM-encoded public key: ${(err as Error).message}. ` +
            "Bearer-token auth is disabled.",
        );
        publicKeyPem = null;
        bootChecked = true;
        return;
    }
    publicKeyPem = pem;
    bootChecked = true;
}

/**
 * Pull a candidate JWT off the request. Preference order:
 *   1. `Authorization: Bearer <token>` header
 *   2. `access_token` cookie (Django-issued, JS-readable, same-domain)
 *
 * Header wins so explicit clients (e.g. SDK / curl) aren't shadowed by a
 * stale cookie. The cookie path exists because browser-initiated asset
 * loads — `<img src="/s3-files/...">`, `<iframe src="/reports/...">` —
 * cannot attach custom headers but DO send cookies. Without this fallback,
 * every chart image and report iframe 401s post-cutover even though the
 * user is fully authenticated.
 */
function extractCandidateToken(req: express.Request): string | null {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.slice("Bearer ".length).trim();
        if (token) return token;
    }
    const cookieToken = (req as unknown as { cookies?: Record<string, unknown> })
        .cookies?.access_token;
    if (typeof cookieToken === "string" && cookieToken.trim().length > 0) {
        return cookieToken.trim();
    }
    return null;
}

export function verifyBearerJwt(
    req: express.Request,
): { userId: UUID; email: string; role: "user" | "admin" | "support" } | null {
    if (!publicKeyPem) return null;
    const token = extractCandidateToken(req);
    if (!token) return null;

    let payload: jwt.JwtPayload;
    try {
        const verified = jwt.verify(token, publicKeyPem, {
            algorithms: ["RS256"],
        });
        if (typeof verified !== "object" || verified === null) return null;
        payload = verified as jwt.JwtPayload;
    } catch (err) {
        const e = err as Error;
        elizaLogger.debug(`[auth] JWT verify failed: ${e.name}: ${e.message}`);
        return null;
    }

    const emailRaw = typeof payload.email === "string" ? payload.email : null;
    if (!emailRaw) return null;
    const email = emailRaw.toLowerCase().trim();
    if (!email) return null;
    // §8.2 — JWT may carry a role claim ("admin" | "support" | "user"). If
    // absent the request defaults to "user"; RBAC then falls back to the
    // ADMIN_EMAILS bootstrap list.
    let role: "user" | "admin" | "support" = "user";
    if (payload.role === "admin" || payload.role === "support") {
        role = payload.role;
    }
    return { email, userId: emailToUserId(email), role };
}
