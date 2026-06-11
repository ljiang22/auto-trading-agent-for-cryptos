import type express from "express";
import { stringToUuid, type UUID } from "@elizaos/core";
import { verifyBearerJwt } from "./auth/verifyJwt";

/**
 * Extract client IP address from Express request, handling various proxy scenarios
 * @param req Express request object
 * @returns The client's IP address
 */
export function extractClientIP(req: express.Request): string {
    // Check X-Forwarded-For header (most common for proxies/load balancers)
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
        // X-Forwarded-For can contain multiple IPs, take the first one (original client)
        const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
        const firstIP = ips.split(',')[0].trim();
        if (firstIP) return firstIP;
    }

    // Check X-Real-IP header (common with Nginx)
    const realIP = req.headers['x-real-ip'];
    if (realIP && typeof realIP === 'string') {
        return realIP.trim();
    }

    // Check CF-Connecting-IP header (Cloudflare)
    const cfIP = req.headers['cf-connecting-ip'];
    if (cfIP && typeof cfIP === 'string') {
        return cfIP.trim();
    }

    // Check X-Client-IP header
    const clientIP = req.headers['x-client-ip'];
    if (clientIP && typeof clientIP === 'string') {
        return clientIP.trim();
    }

    // Fallback to connection remote address
    return req.connection?.remoteAddress || req.socket?.remoteAddress || req.ip || '127.0.0.1';
}

/**
 * Normalize IP address for consistent handling
 * @param ip Raw IP address
 * @returns Normalized IP address
 */
export function normalizeIP(ip: string): string {
    let normalizedIP = ip.trim();
    
    // Handle IPv6 localhost
    if (normalizedIP === '::1') {
        normalizedIP = '127.0.0.1';
    }
    
    // Remove IPv6 prefix from IPv4 addresses (::ffff:192.168.1.1 -> 192.168.1.1)
    if (normalizedIP.startsWith('::ffff:')) {
        normalizedIP = normalizedIP.substring(7);
    }
    
    // Handle development environment localhost variants
    if (normalizedIP === '::1' || normalizedIP === 'localhost') {
        normalizedIP = '127.0.0.1';
    }
    
    return normalizedIP;
}

/**
 * Convert IP address to UUID for database storage
 * @param ip Client IP address
 * @returns UUID representation of the IP
 */
export function ipToUserId(ip: string): UUID {
    const normalizedIP = normalizeIP(ip);
    // Use a consistent prefix to identify IP-based user IDs
    const ipUserString = `ip-user-${normalizedIP}`;
    return stringToUuid(ipUserString);
}

/**
 * Get user ID from Express request based on client IP
 * @param req Express request object
 * @returns UUID for the client based on their IP address
 */
export function getUserIdFromIP(req: express.Request): UUID {
    const clientIP = extractClientIP(req);
    return ipToUserId(clientIP);
}

/**
 * Extract user email from a verified RS256 Bearer JWT.
 * Returns null when the request has no Authorization header or the token
 * fails signature/claim validation. Callers fall back to anonymous-IP
 * identity via getUserIdFromIP.
 *
 * The `user_info` cookie is no longer trusted as an identity source — it
 * was forgeable in DevTools and granted impersonation.
 */
export function extractUserEmail(req: express.Request): string | null {
    return verifyBearerJwt(req)?.email ?? null;
}

/**
 * Convert email address to UUID for database storage
 * @param email User email address
 * @returns UUID representation of the email
 */
export function emailToUserId(email: string): UUID {
    const normalizedEmail = email.toLowerCase().trim();
    // Use a consistent prefix to identify email-based user IDs
    const emailUserString = `email-user-${normalizedEmail}`;
    return stringToUuid(emailUserString);
}

/**
 * Get user ID from Express request based on authentication (email primary, IP fallback)
 * @param req Express request object
 * @returns UUID for the user based on email if authenticated, otherwise IP address
 */
export function getUserId(req: express.Request): UUID {
    const userEmail = extractUserEmail(req);
    if (userEmail) {
        return emailToUserId(userEmail);
    }
    // Fallback to IP-based identification for anonymous users
    return getUserIdFromIP(req);
}

/**
 * Get user identification info for logging/debugging.
 * Authenticated requests resolve via verifyBearerJwt; everything else
 * falls back to an IP-based anonymous identity.
 */
export function getUserInfo(req: express.Request) {
    const verified = verifyBearerJwt(req);
    const ipInfo = getIPInfo(req);

    if (verified) {
        return {
            type: "authenticated" as const,
            email: verified.email,
            userId: verified.userId,
            role: verified.role,
            fallbackIP: ipInfo.normalizedIP,
            fallbackUserId: ipInfo.userId,
        };
    }

    return {
        type: "anonymous" as const,
        email: null,
        userId: ipInfo.userId,
        role: "user" as const,
        ip: ipInfo.normalizedIP,
        ipDetails: ipInfo,
    };
}

/**
 * Get readable IP information for logging/debugging
 * @param req Express request object
 * @returns Object with IP details for logging
 */
export function getIPInfo(req: express.Request) {
    const rawIP = extractClientIP(req);
    const normalizedIP = normalizeIP(rawIP);
    const userId = ipToUserId(rawIP);

    return {
        rawIP,
        normalizedIP,
        userId,
        headers: {
            xForwardedFor: req.headers['x-forwarded-for'],
            xRealIP: req.headers['x-real-ip'],
            cfConnectingIP: req.headers['cf-connecting-ip'],
            xClientIP: req.headers['x-client-ip']
        },
        connectionIP: req.connection?.remoteAddress || req.socket?.remoteAddress || req.ip
    };
}