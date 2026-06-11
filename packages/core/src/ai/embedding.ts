import { createHash } from "node:crypto";
import { getEmbeddingModelSettings, getEndpoint } from "./models.ts";
import { type IAgentRuntime, ModelProviderName } from "../core/types.ts";
import settings from "../config/settings.ts";
import elizaLogger from "../utils/logger.ts";
import LocalEmbeddingModelManager from "./localembeddingManager.ts";

/**
 * Process-local LRU cache keyed by sha256(input).
 *
 * Replaces the previous DocumentDB-backed Levenshtein lookup
 * (`runtime.messageManager.getCachedEmbeddings`), which was the dominant
 * latency cost in the streaming path: every embed() call fetched up to 2000
 * memory rows with full embedding payloads (~16 MB) just to decide whether to
 * skip ~300 ms of local BGE-M3 inference. Hit rate on chat traffic was
 * effectively 0 because each user message is unique.
 *
 * The hash-keyed cache is the right primitive for the surviving "skip
 * recompute on identical input" use case (evaluators, fact extraction). It
 * never crosses the network, evicts in insertion order when full, and only
 * hits when the input is byte-for-byte the same.
 *
 * Tunable via EMBEDDING_LRU_MAX (default 5000 entries).
 */
const EMBED_LRU_MAX = (() => {
    const raw = Number(process.env.EMBEDDING_LRU_MAX);
    return Number.isFinite(raw) && raw > 0 ? raw : 5000;
})();
const embedLru = new Map<string, number[]>();

function lruGet(key: string): number[] | undefined {
    const hit = embedLru.get(key);
    if (hit === undefined) return undefined;
    // Refresh recency: delete + re-insert moves to most-recent end.
    embedLru.delete(key);
    embedLru.set(key, hit);
    return hit;
}

function lruSet(key: string, value: number[]): void {
    if (embedLru.has(key)) {
        embedLru.delete(key);
    } else if (embedLru.size >= EMBED_LRU_MAX) {
        const oldest = embedLru.keys().next().value;
        if (oldest !== undefined) embedLru.delete(oldest);
    }
    embedLru.set(key, value);
}

interface EmbeddingOptions {
    model: string;
    endpoint: string;
    apiKey?: string;
    length?: number;
    isOllama?: boolean;
    dimensions?: number;
    provider?: string;
}

export const EmbeddingProvider = {
    OpenAI: "OpenAI",
    Ollama: "Ollama",
    GaiaNet: "GaiaNet",
    Heurist: "Heurist",
    BGE: "BGE",
    Custom: "Custom",
} as const;

export type EmbeddingProviderType =
    (typeof EmbeddingProvider)[keyof typeof EmbeddingProvider];

export type EmbeddingConfig = {
    readonly dimensions: number;
    readonly model: string;
    readonly provider: EmbeddingProviderType;
};

export const getEmbeddingConfig = (): EmbeddingConfig => {
    // Check for custom embedding configuration first
    if (settings.USE_CUSTOM_EMBEDDING?.toLowerCase() === "true") {
        // Ensure all custom embedding settings are provided
        if (!settings.CUSTOM_EMBEDDING_DIMENSIONS || !settings.CUSTOM_EMBEDDING_MODEL || 
            !settings.CUSTOM_EMBEDDING_ENDPOINT || !settings.CUSTOM_EMBEDDING_API_KEY) {
            elizaLogger.error("Custom embedding configuration error", {
                dimensions: settings.CUSTOM_EMBEDDING_DIMENSIONS,
                model: settings.CUSTOM_EMBEDDING_MODEL,
                endpoint: settings.CUSTOM_EMBEDDING_ENDPOINT,
                apiKey: settings.CUSTOM_EMBEDDING_API_KEY
            });
            throw new Error('Custom embedding enabled but missing required settings');
        }
        
        return {
            dimensions: Number(settings.CUSTOM_EMBEDDING_DIMENSIONS),
            model: settings.CUSTOM_EMBEDDING_MODEL,
            provider: EmbeddingProvider.Custom,
        };
    }

    return {
        dimensions:
            settings.USE_OPENAI_EMBEDDING?.toLowerCase() === "true"
                ? getEmbeddingModelSettings(ModelProviderName.OPENAI).dimensions
                : settings.USE_OLLAMA_EMBEDDING?.toLowerCase() === "true"
                  ? getEmbeddingModelSettings(ModelProviderName.OLLAMA).dimensions
                  : settings.USE_GAIANET_EMBEDDING?.toLowerCase() === "true"
                    ? getEmbeddingModelSettings(ModelProviderName.GAIANET)
                          .dimensions
                    : settings.USE_HEURIST_EMBEDDING?.toLowerCase() === "true"
                      ? getEmbeddingModelSettings(ModelProviderName.HEURIST)
                            .dimensions
                      : 1024, // local BGE-M3 (Xenova/bge-m3)
        model:
            settings.USE_OPENAI_EMBEDDING?.toLowerCase() === "true"
                ? getEmbeddingModelSettings(ModelProviderName.OPENAI).name
                : settings.USE_OLLAMA_EMBEDDING?.toLowerCase() === "true"
                  ? getEmbeddingModelSettings(ModelProviderName.OLLAMA).name
                  : settings.USE_GAIANET_EMBEDDING?.toLowerCase() === "true"
                    ? getEmbeddingModelSettings(ModelProviderName.GAIANET).name
                    : settings.USE_HEURIST_EMBEDDING?.toLowerCase() === "true"
                      ? getEmbeddingModelSettings(ModelProviderName.HEURIST).name
                      : "Xenova/bge-m3",
        provider:
            settings.USE_OPENAI_EMBEDDING?.toLowerCase() === "true"
                ? "OpenAI"
                : settings.USE_OLLAMA_EMBEDDING?.toLowerCase() === "true"
                  ? "Ollama"
                  : settings.USE_GAIANET_EMBEDDING?.toLowerCase() === "true"
                    ? "GaiaNet"
                    : settings.USE_HEURIST_EMBEDDING?.toLowerCase() === "true"
                      ? "Heurist"
                      : "BGE",
    };
};

async function getRemoteEmbedding(
    input: string,
    options: EmbeddingOptions
): Promise<number[]> {
    // Ensure endpoint ends with /v1 for OpenAI
    const baseEndpoint = options.endpoint.endsWith("/v1")
        ? options.endpoint
        : `${options.endpoint}${options.isOllama ? "/v1" : ""}`;

    // Construct full URL
    const fullUrl = `${baseEndpoint}/embeddings`;

    const requestOptions = {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(options.apiKey
                ? {
                      Authorization: `Bearer ${options.apiKey}`,
                  }
                : {}),
        },
        body: JSON.stringify({
            input,
            model: options.model,
            dimensions:
                options.dimensions ||
                options.length ||
                getEmbeddingConfig().dimensions, // Prefer dimensions, fallback to length
        }),
    };

    try {
        const response = await fetch(fullUrl, requestOptions);

        if (!response.ok) {
            elizaLogger.error("API Response:", await response.text()); // Debug log
            throw new Error(
                `Embedding API Error: ${response.status} ${response.statusText}`
            );
        }

        interface EmbeddingResponse {
            data: Array<{ embedding: number[] }>;
        }

        const data: EmbeddingResponse = await response.json();
        return data?.data?.[0].embedding;
    } catch (e) {
        elizaLogger.error("Full error details:", e);
        throw e;
    }
}

export function getEmbeddingType(runtime: IAgentRuntime): "local" | "remote" {
    const isNode =
        typeof process !== "undefined" &&
        process.versions != null &&
        process.versions.node != null;

    // Use local embedding if:
    // - Running in Node.js
    // - Not using OpenAI provider
    // - Not forcing OpenAI embeddings
    const isLocal =
        isNode &&
        runtime.character.modelProvider !== ModelProviderName.OPENAI &&
        runtime.character.modelProvider !== ModelProviderName.GAIANET &&
        runtime.character.modelProvider !== ModelProviderName.HEURIST &&
        !settings.USE_OPENAI_EMBEDDING;

    return isLocal ? "local" : "remote";
}

export function getEmbeddingZeroVector(): number[] {
    let embeddingDimension = 1024; // Default local BGE-M3 dimension

    if (settings.USE_OPENAI_EMBEDDING?.toLowerCase() === "true") {
        embeddingDimension = getEmbeddingModelSettings(
            ModelProviderName.OPENAI
        ).dimensions; // OpenAI dimension
    } else if (settings.USE_OLLAMA_EMBEDDING?.toLowerCase() === "true") {
        embeddingDimension = getEmbeddingModelSettings(
            ModelProviderName.OLLAMA
        ).dimensions; // Ollama mxbai-embed-large dimension
    } else if (settings.USE_GAIANET_EMBEDDING?.toLowerCase() === "true") {
        embeddingDimension = getEmbeddingModelSettings(
            ModelProviderName.GAIANET
        ).dimensions; // GaiaNet dimension
    } else if (settings.USE_HEURIST_EMBEDDING?.toLowerCase() === "true") {
        embeddingDimension = getEmbeddingModelSettings(
            ModelProviderName.HEURIST
        ).dimensions; // Heurist dimension
    }

    return Array(embeddingDimension).fill(0);
}

/**
 * Default time budget for any single embed() call. Without this, a slow
 * DocumentDB cache lookup or a hung remote provider would block the SSE
 * streaming endpoint for ~30+ seconds before the catch in
 * addEmbeddingToMemory falls back to a zero vector. 5s is well above any
 * healthy local-BGE-M3 inference (~300ms) and gives remote APIs enough time
 * for a normal call but not for indefinite retries.
 *
 * Override via EMBEDDING_TIMEOUT_MS env var if a workload genuinely needs
 * longer (e.g. cold-start a hosted provider).
 */
const EMBEDDING_TIMEOUT_MS = (() => {
    const raw = Number(process.env.EMBEDDING_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 5000;
})();

function describeError(err: unknown): { message: string; name?: string; stack?: string } {
    if (err instanceof Error) {
        return { message: err.message, name: err.name, stack: err.stack };
    }
    return { message: String(err) };
}

/**
 * Race a promise against a timeout. Rejects with a recognisable error when the
 * timeout fires so callers can log it distinctly from provider-side failures.
 */
async function withEmbeddingTimeout<T>(
    work: Promise<T>,
    timeoutMs: number,
    label: string,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race<T>([
            work,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => {
                    reject(
                        new Error(
                            `Embedding ${label} timed out after ${timeoutMs}ms`,
                        ),
                    );
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Gets embeddings from a remote API endpoint.  Falls back to local BGE-M3/1024
 *
 * @param {IAgentRuntime} runtime - The agent runtime context
 * @param {string} input - The text to generate embeddings for
 * @returns {Promise<number[]>} Array of embedding values
 * @throws {Error} If the API request fails
 */
export async function embed(runtime: IAgentRuntime, input: string): Promise<number[]> {
    elizaLogger.debug("Embedding request:", {
        modelProvider: runtime.character.modelProvider,
        useOpenAI: process.env.USE_OPENAI_EMBEDDING,
        input: input?.slice(0, 50) + "...",
        inputType: typeof input,
        inputLength: input?.length,
        isString: typeof input === "string",
        isEmpty: !input,
    });

    // Validate input
    if (!input || typeof input !== "string" || input.trim().length === 0) {
        elizaLogger.warn("Invalid embedding input:", {
            input,
            type: typeof input,
            length: input?.length,
        });
        return []; // Return empty embedding array
    }

    // Process-local LRU cache. Hits skip both local inference and any
    // remote provider call. See EMBED_LRU_MAX comment near the top of this
    // file for why this replaced the previous DB-backed cache.
    const cacheKey = createHash("sha256").update(input).digest("hex");
    const lruHit = lruGet(cacheKey);
    if (lruHit) return lruHit;

    const config = getEmbeddingConfig();
    const isNode = typeof process !== "undefined" && process.versions?.node;

    const generate = async (): Promise<number[]> => {
        if (config.provider === EmbeddingProvider.Custom) {
            return await getRemoteEmbedding(input, {
                model: config.model,
                endpoint: settings.CUSTOM_EMBEDDING_ENDPOINT,
                apiKey: settings.CUSTOM_EMBEDDING_API_KEY,
                dimensions: config.dimensions,
            });
        }

        if (config.provider === EmbeddingProvider.OpenAI) {
            return await getRemoteEmbedding(input, {
                model: config.model,
                endpoint: settings.OPENAI_API_URL || "https://api.openai.com/v1",
                apiKey: settings.OPENAI_API_KEY,
                dimensions: config.dimensions,
            });
        }

        if (config.provider === EmbeddingProvider.Ollama) {
            return await getRemoteEmbedding(input, {
                model: config.model,
                endpoint:
                    runtime.character.modelEndpointOverride ||
                    getEndpoint(ModelProviderName.OLLAMA),
                isOllama: true,
                dimensions: config.dimensions,
            });
        }

        if (config.provider == EmbeddingProvider.GaiaNet) {
            return await getRemoteEmbedding(input, {
                model: config.model,
                endpoint:
                    runtime.character.modelEndpointOverride ||
                    getEndpoint(ModelProviderName.GAIANET) ||
                    settings.SMALL_GAIANET_SERVER_URL ||
                    settings.MEDIUM_GAIANET_SERVER_URL ||
                    settings.LARGE_GAIANET_SERVER_URL,
                apiKey: settings.GAIANET_API_KEY || runtime.token,
                dimensions: config.dimensions,
            });
        }

        if (config.provider === EmbeddingProvider.Heurist) {
            return await getRemoteEmbedding(input, {
                model: config.model,
                endpoint: getEndpoint(ModelProviderName.HEURIST),
                apiKey: runtime.token,
                dimensions: config.dimensions,
            });
        }

        // BGE - try local first if in Node
        if (isNode) {
            try {
                return await getLocalEmbedding(input);
            } catch (error) {
                elizaLogger.warn(
                    "Local embedding failed, falling back to remote",
                    describeError(error),
                );
            }
        }

        // Fallback to remote override
        return await getRemoteEmbedding(input, {
            model: config.model,
            endpoint:
                runtime.character.modelEndpointOverride ||
                getEndpoint(runtime.character.modelProvider),
            apiKey: runtime.token,
            dimensions: config.dimensions,
        });
    };

    const fresh = await withEmbeddingTimeout(
        generate(),
        EMBEDDING_TIMEOUT_MS,
        `provider=${config.provider}`,
    );

    // Only cache real embeddings — never zero / empty vectors that providers
    // sometimes return on edge cases, since those would poison the cache.
    if (Array.isArray(fresh) && fresh.length > 0) {
        lruSet(cacheKey, fresh);
    }

    return fresh;

    async function getLocalEmbedding(input: string): Promise<number[]> {
        elizaLogger.debug("DEBUG - Inside getLocalEmbedding function");

        try {
            const embeddingManager = LocalEmbeddingModelManager.getInstance();
            return await embeddingManager.generateEmbedding(input);
        } catch (error) {
            elizaLogger.error("Local embedding failed:", error);
            throw error;
        }
    }
}
