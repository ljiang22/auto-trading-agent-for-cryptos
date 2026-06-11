import { elizaLogger, httpClient, type IAgentRuntime } from "@elizaos/core";
import type { LaunchpadConfig } from "../environment";
import type {
    LaunchpadApiEnvelope,
    LaunchpadPhase,
    LaunchpadToken,
    LaunchpadTokenWithPhase,
} from "../types";

const BASE_URL = "https://api.hubble.xyz/launchpad/api/v1";
const CACHE_TTL = 60_000; // 60 seconds cache

const phaseCache = new Map<string, { timestamp: number; data: LaunchpadTokenWithPhase[] }>();
const pendingRequests = new Map<string, Promise<LaunchpadTokenWithPhase[]>>();

const endpointByPhase: Record<LaunchpadPhase, string> = {
    new: "new",
    bonding: "bonding",
    graduated: "graduated",
};

function normalizeTokens(
    payload: LaunchpadToken[] | { data?: LaunchpadToken[] },
    phase: LaunchpadPhase,
): LaunchpadTokenWithPhase[] {
    const tokens: LaunchpadToken[] = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.data)
            ? payload.data ?? []
            : [];

    return tokens.map((item) => ({ ...item, phase }));
}

async function fetchPhase(
    _runtime: IAgentRuntime,
    config: LaunchpadConfig,
    phase: LaunchpadPhase,
): Promise<LaunchpadTokenWithPhase[]> {
    const cacheKey = `${phase}`;
    const cached = phaseCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.data;
    }

    const pending = pendingRequests.get(cacheKey);
    if (pending) {
        return pending;
    }

    const endpoint = endpointByPhase[phase];
    const url = `${BASE_URL}/${endpoint}`;

    const request = (async () => {
        const response = await httpClient.get(url, {
            headers: {
                "HUBBLE-API-KEY": config.HUBBLE_API_KEY,
                "Content-Type": "application/json",
            },
            timeout: 15_000,
        });

        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Launchpad API responded with ${response.status} for ${phase}`);
        }

        const payload = response.data as LaunchpadToken[] | LaunchpadApiEnvelope;
        const tokens = normalizeTokens(payload, phase);
        phaseCache.set(cacheKey, { timestamp: Date.now(), data: tokens });
        return tokens;
    })()
        .finally(() => {
            pendingRequests.delete(cacheKey);
        });

    pendingRequests.set(cacheKey, request);
    return request;
}

export async function fetchLaunchpadData(
    runtime: IAgentRuntime,
    config: LaunchpadConfig,
    phases?: LaunchpadPhase[] | "all",
): Promise<LaunchpadTokenWithPhase[]> {
    const list: LaunchpadPhase[] = Array.isArray(phases) && phases.length > 0
        ? phases
        : phases === "all" || !phases
            ? ["new", "bonding", "graduated"]
            : ["new"];

    const results = await Promise.allSettled(
        list.map((phase) => fetchPhase(runtime, config, phase))
    );

    const tokens: LaunchpadTokenWithPhase[] = [];
    for (const result of results) {
        if (result.status === "fulfilled") {
            tokens.push(...result.value);
        } else {
            elizaLogger.warn("Launchpad phase fetch failed", result.reason);
        }
    }

    return tokens;
}
