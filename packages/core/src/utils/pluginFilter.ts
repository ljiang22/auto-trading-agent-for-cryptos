/**
 * Groups `runtime.actions` by `PluginType` (via `specialPlugins`) or by explicit
 * plugin id maps, diffs against `runtime.actions` for the `default` group, and
 * filters in list order.
 */

import type { Action, IAgentRuntime } from "../core/types.ts";
import { PluginType } from "../core/types.ts";

/** Actions grouped by `PluginType` (including `Default` for the runtime remainder). */
export type ActionsByPluginType = Record<PluginType, Action[]>;

/**
 * Actions grouped by caller-defined keys (e.g. `"trading"`). Plugin ids are npm
 * names and/or plugin `name`. `default` holds `runtime.actions` not matched by any list.
 */
export type ActionsByPlugin = Record<string, Action[]>;

function readSpecialPluginsMap(
    runtime: IAgentRuntime
): Partial<Record<PluginType, string[]>> | undefined {
    const sp = runtime.character?.settings?.specialPlugins;
    return sp && typeof sp === "object" ? (sp as Partial<Record<PluginType, string[]>>) : undefined;
}

/** Plugin npm / `name` entries configured for `type` under `specialPlugins`, or null if none. */
export function getPluginNamesForSpecialPluginType(
    runtime: IAgentRuntime,
    type: PluginType
): string[] | null {
    const raw = readSpecialPluginsMap(runtime)?.[type];
    if (!Array.isArray(raw) || raw.length === 0) {
        return null;
    }
    const names = raw.filter((n): n is string => typeof n === "string" && n.length > 0);
    return names.length > 0 ? names : null;
}

/** Action names implemented by plugins listed for `type`, or null if none. */
export function getActionNamesForSpecialPluginType(
    runtime: IAgentRuntime,
    type: PluginType
): Set<string> | null {
    const pluginNames = getPluginNamesForSpecialPluginType(runtime, type);
    if (!pluginNames) {
        return null;
    }

    const allowedNpmNames = new Set(pluginNames);
    if (allowedNpmNames.size === 0) return null;

    const exclusiveNames = new Set<string>();

    for (const plugin of runtime.plugins) {
        if (
            (plugin.npmName && allowedNpmNames.has(plugin.npmName)) ||
            allowedNpmNames.has(plugin.name)
        ) {
            for (const action of plugin.actions ?? []) {
                exclusiveNames.add(action.name);
            }
        }
    }

    return exclusiveNames.size > 0 ? exclusiveNames : null;
}

function emptyActionsByPluginType(): ActionsByPluginType {
    const grouped = {} as ActionsByPluginType;
    for (const t of Object.values(PluginType) as PluginType[]) {
        grouped[t] = [];
    }
    return grouped;
}

/** Empty arrays for each key in `plugins`, plus `default` when missing (for the remainder group). */
function emptyActionsByPlugin(
    plugins: Readonly<Record<string, readonly string[]>>
): ActionsByPlugin {
    const result: ActionsByPlugin = {};
    for (const key of Object.keys(plugins)) {
        result[key] = [];
    }
    if (!Object.prototype.hasOwnProperty.call(result, "default")) {
        result.default = [];
    }
    return result;
}

/**
 * For each `PluginType`, collects `Action` instances from `runtime.plugins` that match
 * `specialPlugins[type]`. Then appends every `runtime.actions` entry not in that union
 * to `PluginType.Default`.
 */
export function getActionsGroupedByPluginType(runtime: IAgentRuntime): ActionsByPluginType {
    const grouped = emptyActionsByPluginType();
    const specialActionRefs = new Set<Action>();

    for (const pluginType of Object.values(PluginType) as PluginType[]) {
        const pluginNames = getPluginNamesForSpecialPluginType(runtime, pluginType);
        if (!pluginNames) {
            continue;
        }

        const allowed = new Set(pluginNames);
        for (const plugin of runtime.plugins) {
            if (
                (plugin.npmName && allowed.has(plugin.npmName)) ||
                allowed.has(plugin.name)
            ) {
                for (const action of plugin.actions ?? []) {
                    grouped[pluginType].push(action);
                    specialActionRefs.add(action);
                }
            }
        }
    }

    const all = runtime.actions ?? [];
    for (const action of all) {
        if (!specialActionRefs.has(action)) {
            grouped[PluginType.Default].push(action);
        }
    }

    return grouped;
}

/**
 * Like {@link getActionsGroupedByPluginType}, but group keys and npm/plugin `name` lists
 * are supplied directly (e.g. `{ trading: ["@scope/pkg"], ops: ["foo"] }`).
 * Unmatched `runtime.actions` references are appended to `default`.
 */
export function getActionsGroupedByPlugin(
    runtime: IAgentRuntime,
    plugins: Readonly<Record<string, readonly string[]>>
): ActionsByPlugin {
    const result = emptyActionsByPlugin(plugins);
    const specialActionRefs = new Set<Action>();

    for (const key of Object.keys(plugins)) {
        const list = plugins[key];
        if (!Array.isArray(list) || list.length === 0) {
            continue;
        }
        const allowed = new Set(list.filter((n): n is string => typeof n === "string" && n.length > 0));
        if (allowed.size === 0) {
            continue;
        }
        for (const plugin of runtime.plugins) {
            if (
                (plugin.npmName && allowed.has(plugin.npmName)) ||
                allowed.has(plugin.name)
            ) {
                for (const action of plugin.actions ?? []) {
                    result[key].push(action);
                    specialActionRefs.add(action);
                }
            }
        }
    }

    const all = runtime.actions ?? [];
    for (const action of all) {
        if (!specialActionRefs.has(action)) {
            result.default.push(action);
        }
    }

    return result;
}

export type PluginTypeFilter = (type: PluginType) => boolean;

/**
 * Groups via {@link getActionsGroupedByPluginType}, then filters `runtime.actions`
 * in order with `predicate` on each action's `PluginType`.
 */
export function filterActionsByPluginType(
    runtime: IAgentRuntime,
    predicate: PluginTypeFilter
): Action[] {
    const actions = runtime.actions ?? [];
    const grouped = getActionsGroupedByPluginType(runtime);
    const typeByAction = new Map<Action, PluginType>();

    for (const t of Object.values(PluginType) as PluginType[]) {
        for (const a of grouped[t]) {
            if (!typeByAction.has(a)) {
                typeByAction.set(a, t);
            }
        }
    }

    return actions.filter(action =>
        predicate(typeByAction.get(action) ?? PluginType.Default)
    );
}

export type PluginFilter = (pluginName: string) => boolean;

/**
 * Groups via {@link getActionsGroupedByPlugin}, then filters `runtime.actions` in order
 * with `predicate` on each action's `pluginName` group (`"default"` if unknown).
 */
export function filterActionsByPlugin(
    runtime: IAgentRuntime,
    plugins: Readonly<Record<string, readonly string[]>>,
    predicate: PluginFilter
): Action[] {
    const actions = runtime.actions ?? [];
    const grouped = getActionsGroupedByPlugin(runtime, plugins);
    const keyByAction = new Map<Action, string>();

    for (const [key, arr] of Object.entries(grouped)) {
        for (const a of arr) {
            if (!keyByAction.has(a)) {
                keyByAction.set(a, key);
            }
        }
    }

    return actions.filter(action =>
        predicate(keyByAction.get(action) ?? "default")
    );
}

/** Actions from plugins listed under `specialPlugins.mantle`, in `runtime.actions` order. */
export function getMantleActions(runtime: IAgentRuntime): Action[] {
    return filterActionsByPluginType(runtime, (t) => t === PluginType.Mantle);
}

/** Actions from plugins listed under `specialPlugins.trading`, in `runtime.actions` order. */
export function getCEXActions(runtime: IAgentRuntime): Action[] {
    return filterActionsByPluginType(runtime, t => t === PluginType.Trading);
}

/** All other `runtime.actions` (not grouped as trading), in original order. */
export function getNonCEXActions(runtime: IAgentRuntime): Action[] {
    return filterActionsByPluginType(runtime, t => t !== PluginType.Trading);
}
