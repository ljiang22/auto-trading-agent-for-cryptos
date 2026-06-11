/**
 * §7.10 — Geo-gating for live-trading mode. Reads
 * `LIVE_TRADING_RESTRICTED_REGIONS` (comma-separated ISO-3166-1 alpha-2
 * codes) and refuses `default_mode = live` for matching clients.
 *
 * The MaxMind GeoLite2 lookup is intentionally optional — when the binding
 * is absent, `LIVE_TRADING_GEO_FAIL_OPEN` controls fallback policy:
 *  - `false` (default) — refuse live mode (fail-closed for compliance).
 *  - `true`  — allow (use in dev / when geo data unavailable on purpose).
 */

import { elizaLogger } from "./logger";

const ENV_VAR = "LIVE_TRADING_RESTRICTED_REGIONS";
const FAIL_OPEN_VAR = "LIVE_TRADING_GEO_FAIL_OPEN";

let _geoLookupFn:
    | ((ip: string) => { country?: { iso_code?: string } } | null)
    | null = null;

function loadGeoLookup(): typeof _geoLookupFn {
    if (_geoLookupFn !== null) return _geoLookupFn;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const maxmind = require("maxmind");
        const dbPath = process.env.GEOLITE2_COUNTRY_PATH;
        if (!dbPath) {
            _geoLookupFn = null;
            return null;
        }
        const reader = maxmind.openSync(dbPath);
        _geoLookupFn = (ip: string) => reader.get(ip);
        return _geoLookupFn;
    } catch (err) {
        elizaLogger.debug(
            `[geoRestriction] maxmind unavailable: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
        _geoLookupFn = null;
        return null;
    }
}

function restrictedRegions(): Set<string> {
    const raw = (process.env[ENV_VAR] ?? "").trim();
    if (!raw) return new Set();
    return new Set(
        raw
            .split(",")
            .map((s) => s.trim().toUpperCase())
            .filter((s) => /^[A-Z]{2}$/.test(s)),
    );
}

/**
 * Returns the ISO-3166-1 alpha-2 region string that triggered the block, or
 * null when the request is allowed. Treats invalid/missing IP as fail-closed
 * by default; flip with `LIVE_TRADING_GEO_FAIL_OPEN=true` for local dev.
 */
export function isGeoRestrictedForLive(ip: string | null | undefined): string | null {
    const set = restrictedRegions();
    if (set.size === 0) return null;

    if (!ip) {
        return process.env[FAIL_OPEN_VAR] === "true" ? null : "unknown";
    }

    const lookup = loadGeoLookup();
    if (!lookup) {
        return process.env[FAIL_OPEN_VAR] === "true" ? null : "unknown";
    }

    let region: string | undefined;
    try {
        region = lookup(ip)?.country?.iso_code?.toUpperCase();
    } catch (err) {
        elizaLogger.warn(
            `[geoRestriction] lookup threw: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
        return process.env[FAIL_OPEN_VAR] === "true" ? null : "unknown";
    }
    if (!region) {
        return process.env[FAIL_OPEN_VAR] === "true" ? null : "unknown";
    }
    return set.has(region) ? region : null;
}
