import type { Memory, State } from "@elizaos/core";
import type { LaunchpadMetricsQuery, LaunchpadPhase, LaunchpadQuery } from "../types";

const DEFAULT_METRICS = ["buy1h", "sell1h", "volume1h", "tx1h"];

const PHASE_ALIASES: Record<string, LaunchpadPhase | "all"> = {
    new: "new",
    fresh: "new",
    bonding: "bonding",
    bond: "bonding",
    curve: "bonding",
    graduated: "graduated",
    graduate: "graduated",
    launched: "graduated",
    live: "graduated",
    all: "all",
    any: "all",
};

function readString(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function readNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string") {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isNaN(parsed)) {
            return parsed;
        }
    }
    return undefined;
}

function readStringArray(value: unknown): string[] | undefined {
    if (Array.isArray(value)) {
        const normalized = value
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);
        return normalized.length > 0 ? normalized : undefined;
    }
    if (typeof value === "string" && value.trim().length > 0) {
        return [value.trim()];
    }
    return undefined;
}

function readPhase(value: unknown): LaunchpadPhase | "all" | undefined {
    const raw = readString(value);
    if (!raw) {
        return undefined;
    }
    const normalized = raw.toLowerCase();
    return PHASE_ALIASES[normalized];
}

export function buildLaunchpadQuery(
    _message: Memory,
    _state: State,
    options?: Record<string, unknown>,
): LaunchpadQuery {
    const phase = readPhase(options?.phase);
    const symbol = readString(options?.symbol ?? options?.token)?.toUpperCase();
    const tokenAddress = readString(options?.tokenAddress ?? options?.address);
    const keywords = readStringArray(options?.keywords)?.map((keyword) => keyword.toLowerCase());
    const limit = readNumber(options?.limit);

    return {
        phase,
        symbol,
        tokenAddress,
        keywords,
        limit,
    };
}

export function buildLaunchpadMetricsQuery(
    message: Memory,
    state: State,
    options?: Record<string, unknown>,
): LaunchpadMetricsQuery {
    const base = buildLaunchpadQuery(message, state, options);
    const metrics = readStringArray(options?.metrics) ?? DEFAULT_METRICS;
    const timeRange = readString(options?.timeRange ?? options?.timeRangeLabel) ?? "1h";

    return {
        ...base,
        metrics,
        timeRangeLabel: timeRange,
    };
}
