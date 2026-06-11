/**
 * Bridge to plugin-cex canonical order NL formatter.
 * Requires `pnpm build` (plugin-cex dist) before harness generate scripts run.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const distPath = path.join(ROOT, "packages/plugin-cex/dist/index.js");

let cached = null;

function loadFormatter() {
    if (cached) return cached;
    try {
        cached = require(distPath);
    } catch (err) {
        throw new Error(
            `orderNlBridge: failed to load ${distPath}. Run pnpm build first. ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    return cached;
}

/**
 * @param {string} action
 * @param {Record<string, unknown>} params
 * @param {{ venueMode?: 'explicit' | 'implicit', includeVenuePrefix?: boolean }} [options]
 */
export function formatOrderNlFromParams(action, params, options) {
    const mod = loadFormatter();
    return mod.formatOrderNlFromParams({ action, params, options });
}

/**
 * @param {Record<string, unknown>} params
 * @param {string} action
 */
export function formatOrderSummaryShort(params, action) {
    const mod = loadFormatter();
    return mod.formatOrderSummaryShort(params, action);
}

export function detectOrderVariant(orderConfiguration) {
    const mod = loadFormatter();
    return mod.detectOrderVariant(orderConfiguration);
}
