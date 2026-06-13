/**
 * Opt-in public demo mode: no login required, anonymous users get full agent access.
 * Set PUBLIC_ACCESS_MODE=1 only on isolated side-environments (never production AWS).
 */
export function isPublicAccessModeActive(): boolean {
    return process.env.PUBLIC_ACCESS_MODE?.trim() === "1";
}
