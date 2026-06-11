import type { RequestHandler } from "express";

/**
 * §8.2 — Minimal role-based access control. The `User` schema is not yet
 * extended with a `role` column; until it is, the check reads from
 * `userInfo.role` if present (set by an upstream auth shim) and falls
 * back to `userInfo.email`-based bootstrap (env `ADMIN_EMAILS`).
 *
 * Every denied access is logged to `rbac_decisions` if the adapter
 * supports `writeRbacDecision`.
 */

export type Role = "user" | "admin" | "support";

function userRole(userInfo: { email?: string; role?: string } | undefined): Role {
    if (!userInfo) return "user";
    if (userInfo.role === "admin" || userInfo.role === "support") {
        return userInfo.role;
    }
    const adminEmails = (process.env.ADMIN_EMAILS ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0);
    if (userInfo.email && adminEmails.includes(userInfo.email.toLowerCase())) {
        return "admin";
    }
    return "user";
}

export function requireRole(...roles: Role[]): RequestHandler {
    const allowed = new Set(roles);
    return (req, res, next) => {
        const userInfo = (req as unknown as { userInfo?: { email?: string; role?: string; userId?: string } }).userInfo;
        const actualRole = userRole(userInfo);
        if (allowed.has(actualRole)) {
            next();
            return;
        }
        // Best-effort audit log.
        try {
            const db = (req.app as unknown as { locals?: { databaseAdapter?: { writeRbacDecision?: (r: Record<string, unknown>) => Promise<void> } } })?.locals?.databaseAdapter;
            if (db && typeof db.writeRbacDecision === "function") {
                void db.writeRbacDecision({
                    userId: userInfo?.userId ?? null,
                    actualRole,
                    requiredRoles: Array.from(allowed),
                    path: req.path,
                    method: req.method,
                    clientIp:
                        (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0] ??
                        req.socket.remoteAddress ??
                        null,
                });
            }
        } catch {
            /* never block on audit failure */
        }
        res.status(403).json({
            success: false,
            code: "forbidden",
            message: "This endpoint requires elevated privileges.",
        });
    };
}
