import type { LaunchpadPhase, LaunchpadTokenWithPhase } from "../types";

const USD_FORMAT = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
});

const INT_FORMAT = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
});

export function formatUsd(value?: number): string {
    if (typeof value !== "number" || Number.isNaN(value)) {
        return "--";
    }
    if (value === 0) {
        return "$0";
    }
    if (value < 0.01) {
        return `$${value.toFixed(6)}`;
    }
    return USD_FORMAT.format(value);
}

export function formatSol(value?: number): string {
    if (typeof value !== "number" || Number.isNaN(value)) {
        return "--";
    }
    if (value === 0) {
        return "0 SOL";
    }
    if (Math.abs(value) < 0.000001) {
        return `${value.toExponential(2)} SOL`;
    }
    return `${value.toFixed(6)} SOL`;
}

export function formatNumber(value?: number): string {
    if (typeof value !== "number" || Number.isNaN(value)) {
        return "--";
    }
    if (value >= 1_000_000_000) {
        return `${(value / 1_000_000_000).toFixed(2)}B`;
    }
    if (value >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(2)}M`;
    }
    if (value >= 1_000) {
        return `${(value / 1_000).toFixed(2)}K`;
    }
    return INT_FORMAT.format(value);
}

export function formatPercent(value?: number): string {
    if (typeof value !== "number" || Number.isNaN(value)) {
        return "--";
    }
    return `${(value * 100).toFixed(1)}%`;
}

export function formatUnixSeconds(value?: number): string {
    if (typeof value !== "number" || Number.isNaN(value)) {
        return "--";
    }
    const date = new Date(value * 1000);
    if (Number.isNaN(date.getTime())) {
        return "--";
    }
    return date.toISOString().replace(".000Z", "Z");
}

export function getPhaseLabel(phase: LaunchpadPhase): string {
    switch (phase) {
        case "new":
            return "NEW";
        case "bonding":
            return "BONDING";
        case "graduated":
            return "GRADUATED";
        default:
            return phase.toUpperCase();
    }
}

export function describeBondingProgress(token: LaunchpadTokenWithPhase): string | undefined {
    if (token.phase !== "bonding" || typeof token.bondingCurveProgress !== "number") {
        return undefined;
    }
    return `${(token.bondingCurveProgress * 100).toFixed(1)}% along the bonding curve`;
}
