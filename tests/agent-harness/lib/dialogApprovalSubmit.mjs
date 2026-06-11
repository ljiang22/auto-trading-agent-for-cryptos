/**
 * Build human-input approval parameters matching HumanInputDialog Confirm.
 */

import {
    isHumanInputFieldMissing,
    parseHumanInputValue,
    stringifyHumanInputValue,
} from "./humanInputParsing.mjs";

/** Mirrors HumanInputDialog UI_HIDDEN_FIELDS. */
export const UI_HIDDEN_FIELDS = new Set([
    "userId",
    "user_id",
    "exchange",
    "client_order_id",
    "__editor_blocking",
    "all_open",
]);

/**
 * @param {Record<string, unknown>} fields
 */
function fieldsToStringValues(fields) {
    /** @type {Record<string, string>} */
    const values = {};
    for (const [key, value] of Object.entries(fields || {})) {
        values[key] = stringifyHumanInputValue(value);
    }
    return values;
}

/**
 * @param {string} key
 * @param {string} raw
 * @param {string | undefined} schemaType
 */
function resolveFieldType(key, raw, schemaType) {
    if (schemaType) {
        return schemaType;
    }
    if (key === "order_configuration" && raw.trim().startsWith("{")) {
        return "object";
    }
    if (key === "order_ids" && (raw.trim() === "" || raw.includes(","))) {
        return "array";
    }
    return undefined;
}

/**
 * @param {Record<string, unknown>} fields
 * @param {Record<string, { type?: string, required?: boolean, injected?: boolean }>} fieldSchema
 */
function collectDialogEntries(fields, fieldSchema) {
    const schema = fieldSchema || {};
    const values = fieldsToStringValues(fields);
    const schemaKeys = Object.keys(schema);
    if (schemaKeys.length > 0) {
        return schemaKeys
            .filter(
                (key) =>
                    schema[key]?.injected !== true && !UI_HIDDEN_FIELDS.has(key),
            )
            .map((key) => [key, values[key] ?? ""]);
    }
    return Object.entries(values).filter(([key]) => !UI_HIDDEN_FIELDS.has(key));
}

/**
 * Client-side preflight (ported from HumanInputDialog) for create/preview payloads.
 * @param {Record<string, unknown>} payload
 * @returns {string | null}
 */
export function preflightCheckDialogPayload(payload) {
    const oc = payload.order_configuration;
    if (oc && typeof oc === "object") {
        for (const variant of Object.values(oc)) {
            if (!variant || typeof variant !== "object") {
                continue;
            }
            const v = variant;
            const td = v.trailing_delta_bps;
            if (td !== undefined && td !== null && td !== "") {
                const n = typeof td === "number" ? td : Number.parseFloat(String(td));
                if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 2000) {
                    return `trailing_delta_bps must be an integer between 1 and 2000 (got ${String(td)})`;
                }
            }
            const ice = v.iceberg_qty;
            const base = v.base_size;
            if (
                ice !== undefined &&
                ice !== null &&
                ice !== "" &&
                base !== undefined &&
                base !== null &&
                base !== ""
            ) {
                const iceN = Number.parseFloat(String(ice));
                const baseN = Number.parseFloat(String(base));
                if (Number.isFinite(iceN) && Number.isFinite(baseN) && iceN > baseN) {
                    return `iceberg_qty (${String(ice)}) cannot exceed base_size (${String(base)})`;
                }
            }
        }
    }
    const marginAction = payload.margin_action;
    const marginType = payload.margin_type;
    if (
        typeof marginAction === "string" &&
        marginAction.toUpperCase() !== "NORMAL" &&
        marginAction !== "" &&
        (typeof marginType !== "string" || marginType === "")
    ) {
        return `margin_action=${marginAction} requires margin_type (CROSS or ISOLATED)`;
    }
    return null;
}

/**
 * @param {{
 *   fields?: Record<string, unknown>,
 *   fieldSchema?: Record<string, { type?: string, required?: boolean, injected?: boolean }>,
 *   actionName?: string,
 *   skipPreflight?: boolean,
 * }} input
 * @returns {Record<string, unknown>}
 */
export function buildDialogApprovalParameters(input) {
    const fields = input.fields ?? {};
    const fieldSchema = input.fieldSchema ?? {};
    const actionName = input.actionName;
    const values = fieldsToStringValues(fields);
    const entries = collectDialogEntries(fields, fieldSchema);

    const allOpenActive =
        actionName === "cancel_order" &&
        (values.all_open === "true" || values.all_open === true);

    /** @type {Record<string, unknown>} */
    const parsed = {};
    for (const [key, raw] of entries) {
        const fieldType = resolveFieldType(key, raw, fieldSchema[key]?.type);
        if (allOpenActive && key === "order_ids") {
            const value = parseHumanInputValue(raw, fieldType);
            if (value !== undefined) {
                parsed[key] = value;
            }
            continue;
        }
        if (isHumanInputFieldMissing(raw, fieldSchema[key])) {
            throw new Error(`${key} is required for dialog approval submit`);
        }
        const value = parseHumanInputValue(raw, fieldType);
        if (value !== undefined) {
            parsed[key] = value;
        }
    }

    if (
        !input.skipPreflight &&
        (actionName === "create_order" || actionName === "preview_order")
    ) {
        const preflightError = preflightCheckDialogPayload(parsed);
        if (preflightError) {
            throw new Error(`dialog preflight failed: ${preflightError}`);
        }
    }

    return parsed;
}
