import { createAnthropic } from "@ai-sdk/anthropic";
import { createVertex } from "@ai-sdk/google-vertex";
import { createMistral } from "@ai-sdk/mistral";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { bedrock } from "@ai-sdk/amazon-bedrock";
import { createMem0 } from "@mem0/vercel-ai-provider";
import {
    generateObject as aiGenerateObject,
    generateText as aiGenerateText,
    streamText as aiStreamText,
    type CoreTool,
    type GenerateObjectResult,
    type StepResult as AIStepResult,
} from "ai";
import { Buffer } from "buffer";
import { createOllama } from "ollama-ai-provider";
import OpenAI from "openai";
import { encodingForModel, type TiktokenModel } from "js-tiktoken";
// import { AutoTokenizer } from "@huggingface/transformers";
import Together from "together-ai";
import type { ZodSchema } from "zod";
import { elizaLogger } from "../utils/logger.ts";
import { googleApplicationCredentialsFromSetting } from "../utils/googleVertexCredentials.ts";
import { withUsageTracking, trackGenerationUsage } from "../utils/usage.ts";
import {
    isAnonymousAccount,
    resolveEffectiveSubscriptionTier,
} from "../utils/subscriptionTier.ts";
import {
    models,
    getModelSettings,
    getImageModelSettings,
    getEndpoint,
} from "./models.ts";
import {
    parseBooleanFromText,
    parseJsonArrayFromText,
    parseJSONObjectFromText,
    parseShouldRespondFromText,
    parseActionResponseFromText,
} from "../validation/parsing.ts";
import settings from "../config/settings.ts";
import {
    type Content,
    type IAgentRuntime,
    type IImageDescriptionService,
    type ITextGenerationService,
    ModelClass,
    ModelProviderName,
    ServiceType,
    type ActionResponse,
    // type IVerifiableInferenceAdapter,
    // type VerifiableInferenceOptions,
    // type VerifiableInferenceResult,
    //VerifiableInferenceProvider,
    type TelemetrySettings,
    TokenizerType,
    type UUID,
} from "../core/types.ts";
import { fal } from "@fal-ai/client";

import BigNumber from "bignumber.js";
import { createPublicClient, http } from "viem";
import fs from "fs";
import os from "os";
import path from "path";
function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  ms = 60_000,
  externalSignal?: AbortSignal
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(ms);
  const signal = externalSignal
    ? AbortSignal.any([timeoutSignal, externalSignal])
    : timeoutSignal;
  return fetch(url, { ...options, signal });
}


type Tool = CoreTool<any, any>;
type StepResult = AIStepResult<any>;

// Simplify the types to avoid deep recursion
type GenerationResult = GenerateObjectResult<unknown>;

const FORCE_SMALL_MODEL_SETTING = "FORCE_SMALL_MODEL";
const FORCE_MEDIUM_FOR_LARGE_SETTING = "FORCE_MEDIUM_FOR_LARGE";

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);

function isBooleanSettingEnabled(
    runtime: IAgentRuntime,
    key: string,
    defaultValue = false
): boolean {
    const rawValue = runtime.getSetting(key);
    if (rawValue === null || rawValue === undefined) {
        return defaultValue;
    }

    const normalized = rawValue.trim().toLowerCase();
    if (!normalized) {
        return defaultValue;
    }

    if (TRUE_VALUES.has(normalized)) {
        return true;
    }

    if (FALSE_VALUES.has(normalized)) {
        return false;
    }

    return defaultValue;
}

/** Test account tier values that are treated as paid for model class (no SMALL forcing) */
const TEST_ACCOUNT_PAID_TIERS = new Set([
    "plus",
    "pro",
    "enterprise",
]);

function getTestUserEmail(runtime: IAgentRuntime): string | null {
    const v =
        runtime.getSetting("TEST_USER_EMAIL") ??
        (typeof process !== "undefined" && process.env?.TEST_USER_EMAIL) ??
        (typeof process !== "undefined" && process.env?.VITE_TEST_USER_EMAIL);
    return v && String(v).trim() ? String(v).trim() : null;
}

function getTestUserTier(runtime: IAgentRuntime): string | null {
    const v =
        runtime.getSetting("TEST_USER_TIER") ??
        (typeof process !== "undefined" && process.env?.TEST_USER_TIER) ??
        (typeof process !== "undefined" && process.env?.VITE_TEST_USER_TIER);
    return v && String(v).trim() ? String(v).trim().toLowerCase() : null;
}

export async function resolveModelClass(
    runtime: IAgentRuntime,
    requested: ModelClass,
    userId?: string,
    options: {
        bypassModelClassDowngrades?: boolean;
    } = {}
): Promise<ModelClass> {
    if (options.bypassModelClassDowngrades) {
        elizaLogger.info("Bypassing model class downgrade checks", {
            userId,
            requested,
            resolved: requested,
        });
        return requested;
    }

    // Rule priority:
    // 1) Anonymous users -> SMALL.
    // 2) Logged-in users -> by resolved subscription tier (free -> SMALL).
    if (userId) {
        try {
            const account = await runtime.databaseAdapter.getAccountById(userId as UUID);
            const isAnonymous = isAnonymousAccount(account);

            if (isAnonymous && requested !== ModelClass.SMALL) {
                elizaLogger.info(
                    "Anonymous user detected; forcing SMALL model class",
                    {
                        userId,
                        requested,
                        resolved: ModelClass.SMALL,
                    }
                );
                return ModelClass.SMALL;
            }

            // Test account from env: if email matches and tier is plus/pro/enterprise, allow requested model
            const testUserEmail = getTestUserEmail(runtime);
            const testUserTier = getTestUserTier(runtime);
            if (
                testUserEmail &&
                testUserTier &&
                TEST_ACCOUNT_PAID_TIERS.has(testUserTier) &&
                account?.email === testUserEmail
            ) {
                elizaLogger.info("Test account with paid tier; using requested model class", {
                    userId,
                    requested,
                    resolved: requested,
                });
                return requested;
            }

            const resolvedTier = await resolveEffectiveSubscriptionTier(
                runtime,
                userId as UUID,
                { account }
            );
            const isFreeUser = resolvedTier === "free";

            if (isFreeUser && requested !== ModelClass.SMALL) {
                elizaLogger.info(
                    "Free user detected; forcing SMALL model class",
                    {
                        userId,
                        requested,
                        resolved: ModelClass.SMALL,
                    }
                );
                return ModelClass.SMALL;
            }
        } catch (error) {
            elizaLogger.warn("Error checking user subscription status:", error);
            // On error, continue with normal model resolution
        }
    }

    if (
        isBooleanSettingEnabled(runtime, FORCE_SMALL_MODEL_SETTING) &&
        requested !== ModelClass.SMALL
    ) {
        elizaLogger.debug(
            "FORCE_SMALL_MODEL enabled; overriding requested model class",
            {
                requested,
                resolved: ModelClass.SMALL,
            }
        );
        return ModelClass.SMALL;
    }

    if (
        isBooleanSettingEnabled(runtime, FORCE_MEDIUM_FOR_LARGE_SETTING, true) &&
        requested === ModelClass.LARGE
    ) {
        elizaLogger.debug(
            "FORCE_MEDIUM_FOR_LARGE enabled; overriding requested model class",
            {
                requested,
                resolved: ModelClass.MEDIUM,
            }
        );
        return ModelClass.MEDIUM;
    }

    return requested;
}

interface ProviderOptions {
    runtime: IAgentRuntime;
    provider: ModelProviderName;
    model: string;
    apiKey: string;
    schema?: ZodSchema;
    schemaName?: string;
    schemaDescription?: string;
    mode?: "auto" | "json" | "tool";
    modelOptions: ModelSettings;
    modelClass: ModelClass;
    context: string;
    userId?: string;
    roomId?: string;
}

/**
 * Calculate token count for a given text using tiktoken
 */
export function calculateTokenCount(text: string, model = "gpt-4o"): number {
    if (!text) return 0;
    
    try {
        const encoding = encodingForModel(model as TiktokenModel);
        const tokens = encoding.encode(text);
        return tokens.length;
    } catch (error) {
        elizaLogger.debug("Error calculating token count, using fallback:", error);
        // Fallback: estimate 4 characters per token
        return Math.ceil(text.length / 4);
    }
}

/**
 * Calculate token usage with cost estimation
 */
export function calculateTokenUsage(
    text: string, 
    modelName: string, 
    provider: string, 
    tokenType: 'input' | 'output' = 'input'
): {
    tokenCount: number;
    estimatedCost: number;
} {
    const tokenCount = calculateTokenCount(text, modelName);
    
    // Import cost calculation (avoid circular dependency by importing here)
    const { calculateTokenCost } = require("../utils/pricing.ts");
    const estimatedCost = calculateTokenCost(tokenCount, modelName, provider, tokenType);
    
    return {
        tokenCount,
        estimatedCost
    };
}

/**
 * Enhanced trimTokens that returns both trimmed text and token count
 */
export async function trimTokensWithCount(
    context: string,
    maxTokens: number,
    runtime: IAgentRuntime
): Promise<{ text: string; tokenCount: number }> {
    const trimmedText = await trimTokens(context, maxTokens, runtime);
    const tokenCount = calculateTokenCount(trimmedText);
    
    return {
        text: trimmedText,
        tokenCount
    };
}

/**
 * Trims the provided text context to a specified token limit using a tokenizer model and type.
 *
 * The function dynamically determines the truncation method based on the tokenizer settings
 * provided by the runtime. If no tokenizer settings are defined, it defaults to using the
 * TikToken truncation method with the "gpt-4o" model.
 *
 * @async
 * @function trimTokens
 * @param {string} context - The text to be tokenized and trimmed.
 * @param {number} maxTokens - The maximum number of tokens allowed after truncation.
 * @param {IAgentRuntime} runtime - The runtime interface providing tokenizer settings.
 *
 * @returns {Promise<string>} A promise that resolves to the trimmed text.
 *
 * @throws {Error} Throws an error if the runtime settings are invalid or missing required fields.
 *
 * @example
 * const trimmedText = await trimTokens("This is an example text", 50, runtime);
 * console.log(trimmedText); // Output will be a truncated version of the input text.
 */
export async function trimTokens(
    context: string,
    maxTokens: number,
    runtime: IAgentRuntime
) {
    if (!context) return "";
    if (maxTokens <= 0) throw new Error("maxTokens must be positive");

    const tokenizerModel = runtime.getSetting("TOKENIZER_MODEL");
    const tokenizerType = runtime.getSetting("TOKENIZER_TYPE");

    if (!tokenizerModel || !tokenizerType) {
        // Default to TikToken truncation using the "gpt-4o" model if tokenizer settings are not defined
        return truncateTiktoken("gpt-4o", context, maxTokens);
    }

    // Choose the truncation method based on tokenizer type
    // if (tokenizerType === TokenizerType.Auto) {
    //     return truncateAuto(tokenizerModel, context, maxTokens);
    // }

    if (tokenizerType === TokenizerType.TikToken) {
        return truncateTiktoken(
            tokenizerModel as TiktokenModel,
            context,
            maxTokens
        );
    }

    elizaLogger.warn(`Unsupported tokenizer type: ${tokenizerType}`);
    return truncateTiktoken("gpt-4o", context, maxTokens);
}

// async function truncateAuto(
//     modelPath: string,
//     context: string,
//     maxTokens: number
// ) {
//     try {
//         const tokenizer = await AutoTokenizer.from_pretrained(modelPath);
//         const tokens = tokenizer.encode(context);

//         // If already within limits, return unchanged
//         if (tokens.length <= maxTokens) {
//             return context;
//         }

//         // Keep the most recent tokens by slicing from the end
//         const truncatedTokens = tokens.slice(-maxTokens);

//         // Decode back to text - js-tiktoken decode() returns a string directly
//         return tokenizer.decode(truncatedTokens);
//     } catch (error) {
//         elizaLogger.error("Error in trimTokens:", error);
//         // Return truncated string if tokenization fails
//         return context.slice(-maxTokens * 4); // Rough estimate of 4 chars per token
//     }
// }

async function truncateTiktoken(
    model: TiktokenModel,
    context: string,
    maxTokens: number
) {
    try {
        const encoding = encodingForModel(model);

        // Encode the text into tokens
        const tokens = encoding.encode(context);

        // If already within limits, return unchanged
        if (tokens.length <= maxTokens) {
            return context;
        }

        // Keep the most recent tokens by slicing from the end
        const truncatedTokens = tokens.slice(-maxTokens);

        // Decode back to text - js-tiktoken decode() returns a string directly
        return encoding.decode(truncatedTokens);
    } catch (error) {
        elizaLogger.error("Error in trimTokens:", error);
        // Return truncated string if tokenization fails
        return context.slice(-maxTokens * 4); // Rough estimate of 4 chars per token
    }
}

/**
 * Get OnChain EternalAI System Prompt
 * @returns System Prompt
 */
async function getOnChainEternalAISystemPrompt(
    runtime: IAgentRuntime
): Promise<string> | undefined {
    const agentId = runtime.getSetting("ETERNALAI_AGENT_ID");
    const providerUrl = runtime.getSetting("ETERNALAI_RPC_URL");
    const contractAddress = runtime.getSetting(
        "ETERNALAI_AGENT_CONTRACT_ADDRESS"
    );
    if (agentId && providerUrl && contractAddress) {
        // get on-chain system-prompt
        const contractABI = [
            {
                inputs: [
                    {
                        internalType: "uint256",
                        name: "_agentId",
                        type: "uint256",
                    },
                ],
                name: "getAgentSystemPrompt",
                outputs: [
                    { internalType: "bytes[]", name: "", type: "bytes[]" },
                ],
                stateMutability: "view",
                type: "function",
            },
        ];

        const publicClient = createPublicClient({
            transport: http(providerUrl),
        });

        try {
            const validAddress: `0x${string}` =
                contractAddress as `0x${string}`;
            const result = await publicClient.readContract({
                address: validAddress,
                abi: contractABI,
                functionName: "getAgentSystemPrompt",
                args: [new BigNumber(agentId)],
            });
            if (result) {
                elizaLogger.info("on-chain system-prompt response", result[0]);
                const value = result[0].toString().replace("0x", "");
                const content = Buffer.from(value, "hex").toString("utf-8");
                elizaLogger.info("on-chain system-prompt", content);
                return await fetchEternalAISystemPrompt(runtime, content);
            } else {
                return undefined;
            }
        } catch (error) {
            elizaLogger.error(error);
            elizaLogger.error("err", error);
        }
    }
    return undefined;
}

/**
 * Fetch EternalAI System Prompt
 * @returns System Prompt
 */
async function fetchEternalAISystemPrompt(
    runtime: IAgentRuntime,
    content: string
): Promise<string> | undefined {
    const IPFS = "ipfs://";
    const containsSubstring: boolean = content.includes(IPFS);
    if (containsSubstring) {
        const lightHouse = content.replace(
            IPFS,
            "https://gateway.lighthouse.storage/ipfs/"
        );
        elizaLogger.info("fetch lightHouse", lightHouse);
        const responseLH = await fetchWithTimeout(lightHouse, {
            method: "GET",
        });
        elizaLogger.info("fetch lightHouse resp", responseLH);
        if (responseLH.ok) {
            const data = await responseLH.text();
            return data;
        } else {
            const gcs = content.replace(
                IPFS,
                "https://cdn.eternalai.org/upload/"
            );
            elizaLogger.info("fetch gcs", gcs);
            const responseGCS = await fetchWithTimeout(gcs, {
                method: "GET",
            });
            elizaLogger.info("fetch lightHouse gcs", responseGCS);
            if (responseGCS.ok) {
                const data = await responseGCS.text();
                return data;
            } else {
                throw new Error("invalid on-chain system prompt");
            }
        }
    } else {
        return content;
    }
}

/**
 * Gets the Cloudflare Gateway base URL for a specific provider if enabled
 * @param runtime The runtime environment
 * @param provider The model provider name
 * @returns The Cloudflare Gateway base URL if enabled, undefined otherwise
 */
function getCloudflareGatewayBaseURL(
    runtime: IAgentRuntime,
    provider: string
): string | undefined {
    const isCloudflareEnabled =
        runtime.getSetting("CLOUDFLARE_GW_ENABLED") === "true";
    const cloudflareAccountId = runtime.getSetting("CLOUDFLARE_AI_ACCOUNT_ID");
    const cloudflareGatewayId = runtime.getSetting("CLOUDFLARE_AI_GATEWAY_ID");

    elizaLogger.debug("Cloudflare Gateway Configuration:", {
        isEnabled: isCloudflareEnabled,
        hasAccountId: !!cloudflareAccountId,
        hasGatewayId: !!cloudflareGatewayId,
        provider: provider,
    });

    if (!isCloudflareEnabled) {
        elizaLogger.debug("Cloudflare Gateway is not enabled");
        return undefined;
    }

    if (!cloudflareAccountId) {
        elizaLogger.warn(
            "Cloudflare Gateway is enabled but CLOUDFLARE_AI_ACCOUNT_ID is not set"
        );
        return undefined;
    }

    if (!cloudflareGatewayId) {
        elizaLogger.warn(
            "Cloudflare Gateway is enabled but CLOUDFLARE_AI_GATEWAY_ID is not set"
        );
        return undefined;
    }

    const baseURL = `https://gateway.ai.cloudflare.com/v1/${cloudflareAccountId}/${cloudflareGatewayId}/${provider.toLowerCase()}`;
    elizaLogger.info("Using Cloudflare Gateway:", {
        provider,
        baseURL,
        accountId: cloudflareAccountId,
        gatewayId: cloudflareGatewayId,
    });

    return baseURL;
}

/**
 * Send a message to the model for a text generateText - receive a string back and parse how you'd like
 * @param opts - The options for the generateText request.
 * @param opts.context The context of the message to be completed.
 * @param opts.stop A list of strings to stop the generateText at.
 * @param opts.model The model to use for generateText.
 * @param opts.frequency_penalty The frequency penalty to apply to the generateText.
 * @param opts.presence_penalty The presence penalty to apply to the generateText.
 * @param opts.temperature The temperature to apply to the generateText.
 * @param opts.max_context_length The maximum length of the context to apply to the generateText.
 * @returns The completed message.
 */

export async function generateText({
    runtime,
    system,
    prompt,
    modelClass,
    tools = {},
    onStepFinish,
    onToken,
    maxSteps = 1,
    stop,
    customSystemPrompt,
    imageAttachments,
    userId,
    bypassModelClassDowngrades,
    signal,
    temperature: temperatureOverride,
    maxTokens: maxTokensOverride,
    thinkingBudget,
}: {
    runtime: IAgentRuntime;
    /** Static template instructions — cached by OpenAI as prefix */
    system?: string;
    /** Dynamic per-request content */
    prompt: string;
    modelClass: ModelClass;
    tools?: Record<string, Tool>;
    onStepFinish?: (event: StepResult) => Promise<void> | void;
    onToken?: (delta: string) => Promise<void> | void;
    maxSteps?: number;
    stop?: string[];
    /** @deprecated Use only when you need to override the default persona/system prompt entirely. */
    customSystemPrompt?: string;
    imageAttachments?: Array<{ type: string; data: string; mimeType: string }>;
    userId?: string;
    bypassModelClassDowngrades?: boolean;
    /**
     * Propagated to the underlying AI SDK call. When the caller aborts this
     * signal, the in-flight model request is cancelled.
     */
    signal?: AbortSignal;
    /** Per-call override for sampling temperature. Used by deterministic
     * call sites (e.g., the classifier precheck) to pin temperature=0
     * without mutating the agent's character-level modelConfig. */
    temperature?: number;
    /** Per-call override for output token budget. Used to cap small JSON
     * responses (classifier) so a misbehaving model can't run away. */
    maxTokens?: number;
    /**
     * Google Gemini "thinking" budget. Gemini 2.5 Flash/Pro models emit
     * internal reasoning tokens BEFORE the visible response, and those
     * thinking tokens count against `maxTokens`. For deterministic
     * JSON-shape tasks (classifier, JSON extractors) thinking is pure
     * latency + cost overhead and frequently consumes the entire
     * budget, leaving the visible response empty.
     *
     * Pass `0` to disable thinking entirely (recommended for the
     * classifier). Any non-negative integer is forwarded as the
     * Google `thinkingConfig.thinkingBudget`. Currently only honored
     * for the Google Vertex provider; ignored on other providers.
     *
     * Origin: production bug 2026-05-21 — the classifier on
     * gemini-2.5-flash returned empty text (thinking budget consumed
     * all 256 tokens) and the catch-block fallback misrouted a clear
     * "place an order" CEX request to REGULAR_MESSAGE.
     */
    thinkingBudget?: number;
}): Promise<string> {
    if (runtime.shouldStop?.()) {
        const stopError = new Error("Processing stopped by user request");
        stopError.name = "StopRequestedError";
        throw stopError;
    }

    const finalSystem = system ?? "";
    const defaultSystemPrompt =
        [runtime.character.system ?? settings.SYSTEM_PROMPT, finalSystem]
            .filter(Boolean)
            .join("\n\n") || undefined;
    const baseSystemPrompt =
        customSystemPrompt ?? defaultSystemPrompt;

    // Re-alias as `context` so all provider blocks below continue to work unchanged
    // (they reference `context` for prompt text and `calculateTokenCount(context, model)`)
    // Uses `let` because `context` is reassigned by `trimTokens()` later.
    let context = prompt;

    if (!context || !String(context).trim()) {
        elizaLogger.debug("generateText skipped: prompt is empty");
        return "";
    }

    elizaLogger.log("Generating text...");

    const effectiveModelClass = await resolveModelClass(runtime, modelClass, userId, {
        bypassModelClassDowngrades,
    });

    elizaLogger.info("Generating text with options:", {
        modelProvider: runtime.modelProvider,
        requestedModelClass: modelClass,
        effectiveModelClass,
        // verifiableInference,
    });
    elizaLogger.log("Using provider:", runtime.modelProvider);

    const originalProvider = runtime.modelProvider;
    const fallbackProvider = runtime.character.settings?.modelFallback?.provider ?? ModelProviderName.OPENAI;
    const fallbackEnabled = runtime.character.settings?.modelFallback?.enabled ?? true; // Default to enabled
    let currentProvider = originalProvider;
    let hasTriedFallback = false;

    // Check if primary provider is in cooldown period
    if (fallbackEnabled && typeof runtime.getCurrentApiKey === 'function') {
        let providerKeyName: string | null = null;
        switch (originalProvider) {
            case ModelProviderName.GOOGLE:
                providerKeyName = null; // Vertex AI uses service account auth
                break;
            case ModelProviderName.OPENAI:
                providerKeyName = "OPENAI_API_KEY";
                break;
            case ModelProviderName.ANTHROPIC:
                providerKeyName = "ANTHROPIC_API_KEY";
                break;
            case ModelProviderName.GROQ:
                providerKeyName = "GROQ_API_KEY";
                break;
        }

        if (providerKeyName) {
            const keyAvailable = runtime.getCurrentApiKey(providerKeyName);
            if (!keyAvailable) {
                elizaLogger.info(`Primary provider ${originalProvider} is in cooldown period. Using fallback provider ${fallbackProvider} directly.`);
                currentProvider = fallbackProvider;
                hasTriedFallback = true;
            }
        }
    }

    // Function to check if error is recoverable and should trigger fallback
    const shouldFallback = (error: any): boolean => {
        // If already using fallback provider, don't try again
        if (currentProvider === fallbackProvider) {
            return false;
        }
        
        // For provider fallback, try on any error since we already rotated API keys
        return true;
    };

    // Main generation loop with fallback
    while (true) {
        try {
            elizaLogger.log(`Attempting generation with provider: ${currentProvider}`);
            
            const provider = currentProvider;
            elizaLogger.debug("Provider settings:", {
                provider,
                hasRuntime: !!runtime,
                runtimeSettings: {
                    CLOUDFLARE_GW_ENABLED: runtime.getSetting("CLOUDFLARE_GW_ENABLED"),
                    CLOUDFLARE_AI_ACCOUNT_ID: runtime.getSetting(
                        "CLOUDFLARE_AI_ACCOUNT_ID"
                    ),
                    CLOUDFLARE_AI_GATEWAY_ID: runtime.getSetting(
                        "CLOUDFLARE_AI_GATEWAY_ID"
                    ),
                },
            });

            const endpoint =
                runtime.character.modelEndpointOverride || getEndpoint(provider);
            const modelSettings = getModelSettings(currentProvider, effectiveModelClass);
            let model = modelSettings.name;

            // allow character.json settings => secrets to override models
            // FIXME: add MODEL_MEDIUM support
            switch (provider) {
                // if runtime.getSetting("LLAMACLOUD_MODEL_LARGE") is true and modelProvider is LLAMACLOUD, then use the large model
                case ModelProviderName.LLAMACLOUD:
                    {
                        switch (effectiveModelClass) {
                            case ModelClass.LARGE:
                                {
                                    model =
                                        runtime.getSetting("LLAMACLOUD_MODEL_LARGE") ||
                                        model;
                                }
                                break;
                            case ModelClass.SMALL:
                                {
                                    model =
                                        runtime.getSetting("LLAMACLOUD_MODEL_SMALL") ||
                                        model;
                                    }
                                break;
                        }
                    }
                    break;
                case ModelProviderName.TOGETHER:
                    {
                        switch (effectiveModelClass) {
                            case ModelClass.LARGE:
                                {
                                    model =
                                        runtime.getSetting("TOGETHER_MODEL_LARGE") ||
                                        model;
                                }
                                break;
                            case ModelClass.SMALL:
                                {
                                    model =
                                        runtime.getSetting("TOGETHER_MODEL_SMALL") ||
                                        model;
                                }
                                break;
                        }
                    }
                    break;
                case ModelProviderName.OPENROUTER:
                    {
                        switch (effectiveModelClass) {
                            case ModelClass.LARGE:
                                {
                                    model =
                                        runtime.getSetting("LARGE_OPENROUTER_MODEL") ||
                                        model;
                                }
                                break;
                            case ModelClass.SMALL:
                                {
                                    model =
                                        runtime.getSetting("SMALL_OPENROUTER_MODEL") ||
                                        model;
                                }
                                break;
                        }
                    }
                    break;
            }

            elizaLogger.info("Selected model:", model);

            const modelConfiguration = runtime.character?.settings?.modelConfig;
            // Per-call temperature override (e.g., classifier wants 0). `?? `
            // is required here — `0` is falsy and `||` would erase a valid
            // override.
            const temperature =
                temperatureOverride ??
                (modelConfiguration?.temperature || modelSettings.temperature);
            const frequency_penalty =
                modelConfiguration?.frequency_penalty ||
                modelSettings.frequency_penalty;
            const presence_penalty =
                modelConfiguration?.presence_penalty || modelSettings.presence_penalty;
            const max_context_length =
                modelConfiguration?.maxInputTokens || modelSettings.maxInputTokens;
            const max_response_length =
                maxTokensOverride ??
                (modelConfiguration?.maxOutputTokens || modelSettings.maxOutputTokens);
            const experimental_telemetry =
                modelConfiguration?.experimental_telemetry ||
                modelSettings.experimental_telemetry;

                         // Get appropriate API key for current provider
             let apiKey: string;
             if (currentProvider === fallbackProvider && hasTriedFallback) {
                 // Use fallback provider API key
                 switch (fallbackProvider) {
                     case ModelProviderName.OPENAI:
                         apiKey = (runtime.character.settings?.secrets?.OPENAI_API_KEY ??
                                  runtime.getSetting("OPENAI_API_KEY")) ?? "";
                         break;
                     case ModelProviderName.ANTHROPIC:
                         apiKey = (runtime.character.settings?.secrets?.ANTHROPIC_API_KEY ??
                                  runtime.getSetting("ANTHROPIC_API_KEY")) ?? "";
                         break;
                     case ModelProviderName.GROQ:
                         apiKey = (runtime.character.settings?.secrets?.GROQ_API_KEY ??
                                  runtime.getSetting("GROQ_API_KEY")) ?? "";
                         break;
                     case ModelProviderName.DEEPSEEK:
                         apiKey = (runtime.character.settings?.secrets?.DEEPSEEK_API_KEY ??
                                  runtime.getSetting("DEEPSEEK_API_KEY")) ?? "";
                         break;
                     default:
                         apiKey = (runtime.character.settings?.secrets?.OPENAI_API_KEY ??
                                  runtime.getSetting("OPENAI_API_KEY")) ?? "";
                         break;
                 }
                 elizaLogger.info(`Using fallback ${fallbackProvider} provider due to primary provider failure`);
             } else {
                 apiKey = runtime.token;
             }

            let effectiveSystemPrompt = baseSystemPrompt;
            let systemTokenCount = calculateTokenCount(
                effectiveSystemPrompt ?? "",
                model
            );

            if (effectiveSystemPrompt && systemTokenCount >= max_context_length) {
                elizaLogger.warn(
                    `System prompt exceeds model input limit (${systemTokenCount}/${max_context_length} tokens). Trimming system prompt.`
                );
                effectiveSystemPrompt = await trimTokens(
                    effectiveSystemPrompt,
                    max_context_length,
                    runtime
                );
                systemTokenCount = calculateTokenCount(
                    effectiveSystemPrompt,
                    model
                );
            }

            const remainingPromptBudget = Math.max(
                max_context_length - systemTokenCount,
                0
            );

            elizaLogger.debug(
                `Trimming combined input to max length of ${max_context_length} tokens (system: ${systemTokenCount}, prompt budget: ${remainingPromptBudget}).`
            );

            context =
                remainingPromptBudget > 0
                    ? await trimTokens(context, remainingPromptBudget, runtime)
                    : "";

            let response: string;

            const _stop = stop || modelSettings.stop;
            elizaLogger.debug(
                `Using provider: ${provider}, model: ${model}, temperature: ${temperature}, max response length: ${max_response_length}`
            );

            const extractUsageFromResult = (result: unknown) => {
                const usage = (result as any)?.usage;
                if (!usage) {
                    return undefined;
                }

                const inputTokens =
                    usage.promptTokens ??
                    usage.prompt_tokens ??
                    usage.input_tokens ??
                    usage.inputTokens;
                const outputTokens =
                    usage.completionTokens ??
                    usage.completion_tokens ??
                    usage.output_tokens ??
                    usage.outputTokens;
                const totalTokens =
                    usage.totalTokens ??
                    usage.total_tokens ??
                    ((inputTokens || 0) + (outputTokens || 0));

                return { inputTokens, outputTokens, totalTokens };
            };

            switch (provider) {
                // OPENAI & LLAMACLOUD shared same structure.
                case ModelProviderName.OPENAI:
                case ModelProviderName.ALI_BAILIAN:
                case ModelProviderName.VOLENGINE:
                case ModelProviderName.LLAMACLOUD:
                case ModelProviderName.NANOGPT:
                case ModelProviderName.HYPERBOLIC:
                case ModelProviderName.TOGETHER:
                case ModelProviderName.NINETEEN_AI:
                case ModelProviderName.AKASH_CHAT_API:
                case ModelProviderName.LMSTUDIO:
                case ModelProviderName.NEARAI:
                case ModelProviderName.KLUSTERAI: {
                    elizaLogger.debug("Initializing OpenAI-compatible model.");
                    const openai = createOpenAI({
                        apiKey,
                        baseURL:
                            getCloudflareGatewayBaseURL(runtime, "openai") || endpoint,
                        fetch: runtime.fetch,
                    });

                    // Calculate input tokens
                    const inputTokens = calculateTokenCount(
                        [effectiveSystemPrompt, context].filter(Boolean).join("\n\n"),
                        model
                    );

                    // Build messages array — required when attaching images
                    const openaiMessages: any[] = [];
                    if (effectiveSystemPrompt) {
                        openaiMessages.push({ role: 'system', content: effectiveSystemPrompt });
                    }
                    const openaiUserContent: any[] = [{ type: 'text', text: context }];
                    if (imageAttachments && imageAttachments.length > 0) {
                        imageAttachments.forEach(img => {
                            openaiUserContent.push({
                                type: 'image',
                                image: `data:${img.mimeType};base64,${img.data}`,
                            });
                        });
                        elizaLogger.debug(`Including ${imageAttachments.length} image(s) in OpenAI request`);
                    }
                    openaiMessages.push({ role: 'user', content: openaiUserContent });

                    const { text: openaiResponse } = await withUsageTracking(
                        runtime,
                        {
                            modelProvider: provider,
                            modelName: model,
                            modelClass: effectiveModelClass,
                            requestType: 'generateText',
                            userId,
                            inputTokens,
                            getOutputTokens: (result) => calculateTokenCount(result.text, model),
                            extractActualUsage: (result) => {
                                // Extract actual usage from result if available
                                const usage = (result as any)?.usage;
                                if (usage) {
                                    return {
                                        inputTokens: usage.promptTokens,
                                        outputTokens: usage.completionTokens,
                                        totalTokens: usage.totalTokens
                                    };
                                }
                                return undefined;
                            }
                        },
                        () => aiGenerateText({
                            model: openai.languageModel(model),
                            messages: openaiMessages,
                            tools: tools,
                            onStepFinish: onStepFinish,
                            maxSteps: maxSteps,
                            temperature: temperature,
                            maxTokens: max_response_length,
                            frequencyPenalty: frequency_penalty,
                            presencePenalty: presence_penalty,
                            experimental_telemetry: experimental_telemetry, abortSignal: signal,
                        })
                    );

                    response = openaiResponse;
                    elizaLogger.debug("Received response from OpenAI-compatible model.");
                    break;
                }

                case ModelProviderName.ETERNALAI: {
                    elizaLogger.debug("Initializing EternalAI model.");
                    const openai = createOpenAI({
                        apiKey,
                        baseURL: endpoint,
                        fetch: runtime.fetch,
                    });

                    // Calculate input tokens
                    const inputTokens = calculateTokenCount(
                        [effectiveSystemPrompt, context].filter(Boolean).join("\n\n"),
                        model
                    );
                    
                    const { text: openaiResponse } = await withUsageTracking(
                        runtime,
                        {
                            modelProvider: provider,
                            modelName: model,
                            modelClass: effectiveModelClass,
                            requestType: 'generateText',
                            userId,
                            inputTokens,
                            getOutputTokens: (result) => calculateTokenCount(result.text, model),
                            extractActualUsage: (result) => {
                                const usage = (result as any)?.usage;
                                if (usage) {
                                    return {
                                        inputTokens: usage.promptTokens,
                                        outputTokens: usage.completionTokens,
                                        totalTokens: usage.totalTokens
                                    };
                                }
                                return undefined;
                            }
                        },
                        () => aiGenerateText({
                            model: openai.languageModel(model),
                            prompt: context,
                            system: effectiveSystemPrompt,
                            temperature: temperature,
                            maxTokens: max_response_length,
                            frequencyPenalty: frequency_penalty,
                            presencePenalty: presence_penalty,
                        })
                    );

                    response = openaiResponse;
                    elizaLogger.debug("Received response from EternalAI model.");
                    break;
                }

                case ModelProviderName.GOOGLE: {
                    elizaLogger.debug(
                        `Google Vertex generateText: model=${model}`,
                    );
                    const vertexProject = runtime.getSetting("GOOGLE_VERTEX_PROJECT") ?? "";
                    const vertexLocation = runtime.getSetting("GOOGLE_VERTEX_LOCATION") ?? "global";
                    const vertexHost = vertexLocation === "global" ? "aiplatform.googleapis.com" : `${vertexLocation}-aiplatform.googleapis.com`;
                    const google = createVertex({
                        project: vertexProject,
                        location: vertexLocation,
                        baseURL: `https://${vertexHost}/v1/projects/${vertexProject}/locations/${vertexLocation}/publishers/google`,
                        googleAuthOptions: {
                            credentials: googleApplicationCredentialsFromSetting(
                                runtime.getSetting("GOOGLE_APPLICATION_CREDENTIALS_JSON"),
                            ),
                        },
                    });

                    // Calculate input tokens
                    const inputTokens = calculateTokenCount(
                        [effectiveSystemPrompt, context].filter(Boolean).join("\n\n"),
                        model
                    );
                    elizaLogger.debug(`Google Vertex input tokens: ${inputTokens}`);

                    // Prepare messages with image support
                    const messages: any[] = [];

                    // Add system message if available
                    const systemPrompt = effectiveSystemPrompt;
                    if (systemPrompt) {
                        messages.push({
                            role: 'system',
                            content: systemPrompt
                        });
                    }

                    // Prepare user message content
                    const userContent: any[] = [{ type: 'text', text: context }];

                    // Add image attachments if present
                    if (imageAttachments && imageAttachments.length > 0) {
                        imageAttachments.forEach(img => {
                            userContent.push({
                                type: 'image',
                                image: `data:${img.mimeType};base64,${img.data}`
                            });
                        });
                        elizaLogger.debug(
                            `Including ${imageAttachments.length} image(s) in Google LLM request`,
                        );
                    }

                    messages.push({
                        role: 'user',
                        content: userContent
                    });

                    const hasTools = tools && Object.keys(tools).length > 0;
                    const shouldStream = typeof onToken === "function" && !hasTools;
                    elizaLogger.debug(
                        `Google Vertex streaming: hasTools=${hasTools} shouldStream=${shouldStream}`,
                    );

                    // Provider-specific options. Forward `thinkingBudget`
                    // to Gemini when supplied (see generateText doc above).
                    // Empty object when not set so the SDK uses defaults.
                    const googleProviderOptions =
                        typeof thinkingBudget === "number" && thinkingBudget >= 0
                            ? {
                                  google: {
                                      thinkingConfig: { thinkingBudget },
                                  },
                              }
                            : undefined;

                    if (shouldStream) {
                        elizaLogger.debug(`Google Vertex STREAMING model=${model}`);
                        const streamStartTime = Date.now();
                        const streamResult = aiStreamText({
                            model: google(model),
                            messages: messages,
                            onStepFinish: onStepFinish,
                            maxSteps: maxSteps,
                            temperature: temperature,
                            maxTokens: max_response_length,
                            experimental_telemetry: experimental_telemetry, abortSignal: signal,
                            ...(googleProviderOptions ? { providerOptions: googleProviderOptions } : {}),
                        });

                        let streamedText = "";
                        try {
                            for await (const delta of streamResult.textStream) {
                                streamedText += delta;
                                await onToken?.(delta);
                            }

                            const finalText = await streamResult.text;
                            const usage = await streamResult.usage;

                            await trackGenerationUsage(runtime, {
                                modelProvider: provider,
                                modelName: model,
                                modelClass: effectiveModelClass,
                                requestType: "generateText",
                                userId,
                                inputTokens,
                                outputTokens: usage?.completionTokens ?? calculateTokenCount(finalText, model),
                                actualUsage: usage
                                    ? {
                                        inputTokens: usage.promptTokens,
                                        outputTokens: usage.completionTokens,
                                        totalTokens: usage.totalTokens
                                    }
                                    : undefined,
                                responseTimeMs: Date.now() - streamStartTime,
                                success: true
                            });

                            response = finalText || streamedText;
                        } catch (streamError) {
                            await trackGenerationUsage(runtime, {
                                modelProvider: provider,
                                modelName: model,
                                modelClass: effectiveModelClass,
                                requestType: "generateText",
                                userId,
                                inputTokens,
                                outputTokens: calculateTokenCount(streamedText, model),
                                responseTimeMs: Date.now() - streamStartTime,
                                success: false,
                                error: streamError instanceof Error ? streamError.message : String(streamError)
                            });
                            throw streamError;
                        }
                    } else {
                        elizaLogger.debug(`Google Vertex NON-STREAMING model=${model}`);
                        const { text: googleResponse } = await withUsageTracking(
                            runtime,
                            {
                                modelProvider: provider,
                                modelName: model,
                                modelClass: effectiveModelClass,
                                requestType: 'generateText',
                                userId,
                                inputTokens,
                                getOutputTokens: (result) => calculateTokenCount(result.text, model),
                                extractActualUsage: (result) => {
                                    const usage = (result as any)?.usage;
                                    if (usage) {
                                        return {
                                            inputTokens: usage.promptTokens,
                                            outputTokens: usage.completionTokens,
                                            totalTokens: usage.totalTokens
                                        };
                                    }
                                    return undefined;
                                }
                            },
                            () => aiGenerateText({
                                model: google(model),
                                messages: messages,
                                tools: tools,
                                onStepFinish: onStepFinish,
                                maxSteps: maxSteps,
                                temperature: temperature,
                                maxTokens: max_response_length,
                                experimental_telemetry: experimental_telemetry, abortSignal: signal,
                                ...(googleProviderOptions ? { providerOptions: googleProviderOptions } : {}),
                            })
                        );

                        response = googleResponse;
                    }

                    elizaLogger.debug("Received response from Google model.");
                    break;
                }

                case ModelProviderName.ANTHROPIC: {
                    elizaLogger.debug("Initializing Anthropic model.");
                    const anthropic = createAnthropic({
                        apiKey,
                        fetch: runtime.fetch,
                    });

                    // Calculate input tokens
                    const inputTokens = calculateTokenCount(
                        [effectiveSystemPrompt, context].filter(Boolean).join("\n\n"),
                        model
                    );

                    // Build messages array — required when attaching images
                    const anthropicUserContent: any[] = [{ type: 'text', text: context }];
                    if (imageAttachments && imageAttachments.length > 0) {
                        imageAttachments.forEach(img => {
                            anthropicUserContent.push({
                                type: 'image',
                                image: img.data,
                                mimeType: img.mimeType,
                            });
                        });
                        elizaLogger.debug(`Including ${imageAttachments.length} image(s) in Anthropic request`);
                    }
                    const anthropicMessages: any[] = [{ role: 'user', content: anthropicUserContent }];

                    const { text: anthropicResponse } = await withUsageTracking(
                        runtime,
                        {
                            modelProvider: provider,
                            modelName: model,
                            modelClass: effectiveModelClass,
                            requestType: 'generateText',
                            userId,
                            inputTokens,
                            getOutputTokens: (result) => calculateTokenCount(result.text, model),
                            extractActualUsage: (result) => {
                                const usage = (result as any)?.usage;
                                if (usage) {
                                    return {
                                        inputTokens: usage.input_tokens,
                                        outputTokens: usage.output_tokens,
                                        totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0)
                                    };
                                }
                                return undefined;
                            }
                        },
                        () => aiGenerateText({
                            model: anthropic(model),
                            maxSteps: maxSteps,
                            experimental_telemetry: experimental_telemetry, abortSignal: signal,
                            temperature: temperature,
                            maxTokens: max_response_length,
                            messages: anthropicMessages,
                            system: effectiveSystemPrompt,
                            tools: tools,
                            onStepFinish: onStepFinish,
                        })
                    );

                    response = anthropicResponse;
                    elizaLogger.debug("Received response from Anthropic model.");
                    break;
                }

                                 case ModelProviderName.CLAUDE_VERTEX: {
                     elizaLogger.debug("Initializing Claude Vertex model.");
                     const anthropic = createAnthropic({
                         apiKey,
                         fetch: runtime.fetch,
                     });

                    // Calculate input tokens
                    const inputTokens = calculateTokenCount(
                        [effectiveSystemPrompt, context].filter(Boolean).join("\n\n"),
                        model
                    );

                    // Build messages array — required when attaching images
                    const claudeVertexUserContent: any[] = [{ type: 'text', text: context }];
                    if (imageAttachments && imageAttachments.length > 0) {
                        imageAttachments.forEach(img => {
                            claudeVertexUserContent.push({
                                type: 'image',
                                image: img.data,
                                mimeType: img.mimeType,
                            });
                        });
                        elizaLogger.debug(`Including ${imageAttachments.length} image(s) in Claude Vertex request`);
                    }
                    const claudeVertexMessages: any[] = [{ role: 'user', content: claudeVertexUserContent }];

                    const { text: anthropicResponse } = await withUsageTracking(
                        runtime,
                        {
                            modelProvider: provider,
                            modelName: model,
                            modelClass: effectiveModelClass,
                            requestType: 'generateText',
                            userId,
                            inputTokens,
                            getOutputTokens: (result) => calculateTokenCount(result.text, model),
                            extractActualUsage: (result) => {
                                const usage = (result as any)?.usage;
                                if (usage) {
                                    return {
                                        inputTokens: usage.input_tokens,
                                        outputTokens: usage.output_tokens,
                                        totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0)
                                    };
                                }
                                return undefined;
                            }
                        },
                        () => aiGenerateText({
                            model: anthropic(model),
                            maxSteps: maxSteps,
                            experimental_telemetry: experimental_telemetry, abortSignal: signal,
                            temperature: temperature,
                            maxTokens: max_response_length,
                            messages: claudeVertexMessages,
                            system: effectiveSystemPrompt,
                            tools: tools,
                            onStepFinish: onStepFinish,
                        })
                    );

                    response = anthropicResponse;
                    elizaLogger.debug("Received response from Claude Vertex model.");
                    break;
                }

                case ModelProviderName.MEM0: {
                    elizaLogger.debug(
                        "Initializing Mem0 model with Cloudflare check"
                    );
                    const baseURL = endpoint || getCloudflareGatewayBaseURL(runtime, "openai");

                    const mem0 = createMem0({
                        provider: runtime.getSetting("MEM0_PROVIDER") || "openai",
                        apiKey: runtime.getSetting("MEM0_PROVIDER_API_KEY"),
                        fetch: runtime.fetch,
                        mem0ApiKey: runtime.getSetting("MEM0_API_KEY"),
                        mem0Config: {
                            user_id: runtime.getSetting("MEM0_USER_ID") || "eliza-os-user"
                        }
                    });

                    // Calculate input tokens
                    const inputTokens = calculateTokenCount(
                        [effectiveSystemPrompt, context].filter(Boolean).join("\n\n"),
                        model
                    );
                    
                    const mem0Result = await withUsageTracking<any>(
                        runtime,
                        {
                            modelProvider: provider,
                            modelName: model,
                            modelClass: effectiveModelClass,
                            requestType: "generateText",
                            userId,
                            inputTokens,
                            getOutputTokens: (result) => calculateTokenCount(result.text, model),
                            extractActualUsage: extractUsageFromResult,
                        },
                        () => aiGenerateText({
                            model: mem0.languageModel(model),
                            prompt: context,
                            system: effectiveSystemPrompt,
                            tools: tools,
                            onStepFinish: onStepFinish,
                            maxSteps: maxSteps,
                            temperature: temperature,
                            maxTokens: max_response_length,
                            frequencyPenalty: frequency_penalty,
                            presencePenalty: presence_penalty,
                            experimental_telemetry: experimental_telemetry, abortSignal: signal,
                        })
                    );

                    response = mem0Result.text;
                    elizaLogger.debug("Received response from Mem0 Provider.");
                    break;
                }

                case ModelProviderName.GROQ: {
                    elizaLogger.debug(
                        "Initializing Groq model with Cloudflare check"
                    );
                    const baseURL = getCloudflareGatewayBaseURL(runtime, "groq");
                    elizaLogger.debug("Groq baseURL result:", { baseURL });
                    const groq = createGroq({
                        apiKey,
                        fetch: runtime.fetch,
                        baseURL,
                    });

                    // Calculate input tokens
                    const inputTokens = calculateTokenCount(
                        [effectiveSystemPrompt, context].filter(Boolean).join("\n\n"),
                        model
                    );
                    
                    const { text: groqResponse } = await withUsageTracking(
                        runtime,
                        {
                            modelProvider: provider,
                            modelName: model,
                            modelClass: effectiveModelClass,
                            requestType: 'generateText',
                            userId,
                            inputTokens,
                            getOutputTokens: (result) => calculateTokenCount(result.text, model),
                            extractActualUsage: (result) => {
                                const usage = (result as any)?.usage;
                                if (usage) {
                                    return {
                                        inputTokens: usage.prompt_tokens || usage.promptTokens,
                                        outputTokens: usage.completion_tokens || usage.completionTokens,
                                        totalTokens: usage.total_tokens || usage.totalTokens
                                    };
                                }
                                return undefined;
                            }
                        },
                        () => aiGenerateText({
                            model: groq.languageModel(model),
                            prompt: context,
                            temperature,
                            system: effectiveSystemPrompt,
                            tools,
                            onStepFinish: onStepFinish,
                            maxSteps,
                            maxTokens: max_response_length,
                            frequencyPenalty: frequency_penalty,
                            presencePenalty: presence_penalty,
                            experimental_telemetry,
                            abortSignal: signal,
                        })
                    );

                    response = groqResponse;
                    elizaLogger.debug("Received response from Groq model.");
                    break;
                }

                case ModelProviderName.LLAMALOCAL: {
                    elizaLogger.debug(
                        "Using local Llama model for text completion."
                    );
                    const textGenerationService =
                        runtime.getService<ITextGenerationService>(
                            ServiceType.TEXT_GENERATION
                        );

                    if (!textGenerationService) {
                        throw new Error("Text generation service not found");
                    }

                    // Calculate input tokens for tracking (local models have zero cost)
                    const inputTokens = calculateTokenCount(
                        [effectiveSystemPrompt, context].filter(Boolean).join("\n\n"),
                        model
                    );
                    
                    response = await withUsageTracking(
                        runtime,
                        {
                            modelProvider: provider,
                            modelName: model,
                            modelClass: effectiveModelClass,
                            requestType: 'generateText',
                            userId,
                            inputTokens,
                            getOutputTokens: (result) => calculateTokenCount(result, model)
                        },
                        () => textGenerationService.queueTextCompletion(
                            context,
                            temperature,
                            _stop,
                            frequency_penalty,
                            presence_penalty,
                            max_response_length
                        )
                    );
                    elizaLogger.debug("Received response from local Llama model.");
                    break;
                }

                case ModelProviderName.REDPILL: {
                    elizaLogger.debug("Initializing RedPill model.");
                    const serverUrl = getEndpoint(provider);
                    const openai = createOpenAI({
                        apiKey,
                        baseURL: serverUrl,
                        fetch: runtime.fetch,
                    });

                    // Calculate input tokens
                    const inputTokens = calculateTokenCount(
                        [effectiveSystemPrompt, context].filter(Boolean).join("\n\n"),
                        model
                    );
                    
                    const redpillResult = await withUsageTracking<any>(
                        runtime,
                        {
                            modelProvider: provider,
                            modelName: model,
                            modelClass: effectiveModelClass,
                            requestType: "generateText",
                            userId,
                            inputTokens,
                            getOutputTokens: (result) => calculateTokenCount(result.text, model),
                            extractActualUsage: extractUsageFromResult,
                        },
                        () => aiGenerateText({
                            model: openai.languageModel(model),
                            prompt: context,
                            temperature: temperature,
                            system: effectiveSystemPrompt,
                            tools: tools,
                            onStepFinish: onStepFinish,
                            maxSteps: maxSteps,
                            maxTokens: max_response_length,
                            frequencyPenalty: frequency_penalty,
                            presencePenalty: presence_penalty,
                            experimental_telemetry: experimental_telemetry, abortSignal: signal,
                        })
                    );

                    response = redpillResult.text;
                    elizaLogger.debug("Received response from redpill model.");
                    break;
                }

                case ModelProviderName.OPENROUTER: {
                    elizaLogger.debug("Initializing OpenRouter model.");
                    const openrouter = createOpenAI({
                        apiKey,
                        baseURL: getEndpoint(provider),
                        fetch: runtime.fetch,
                    });

                    // Calculate input tokens
                    const inputTokens = calculateTokenCount(
                        [effectiveSystemPrompt, context].filter(Boolean).join("\n\n"),
                        model
                    );
                    
                    const openrouterResult = await withUsageTracking<any>(
                        runtime,
                        {
                            modelProvider: provider,
                            modelName: model,
                            modelClass: effectiveModelClass,
                            requestType: "generateText",
                            userId,
                            inputTokens,
                            getOutputTokens: (result) => calculateTokenCount(result.text, model),
                            extractActualUsage: extractUsageFromResult,
                        },
                        () => aiGenerateText({
                            model: openrouter.languageModel(model),
                            prompt: context,
                            temperature: temperature,
                            system: effectiveSystemPrompt,
                            tools: tools,
                            onStepFinish: onStepFinish,
                            maxSteps: maxSteps,
                            maxTokens: max_response_length,
                            frequencyPenalty: frequency_penalty,
                            presencePenalty: presence_penalty,
                            experimental_telemetry: experimental_telemetry, abortSignal: signal,
                        })
                    );

                    response = openrouterResult.text;
                    elizaLogger.debug("Received response from OpenRouter model.");
                    break;
                }

                case ModelProviderName.OLLAMA:
                    {
                        elizaLogger.debug("Initializing Ollama model.");

                        const ollamaProvider = createOllama({
                            baseURL: getEndpoint(provider) + "/api",
                            fetch: runtime.fetch,
                        });
                        const ollama = ollamaProvider(model);

                        elizaLogger.debug("****** MODEL\n", model);

                        // Calculate input tokens
                        const inputTokens = calculateTokenCount(
                            [effectiveSystemPrompt, context].filter(Boolean).join("\n\n"),
                            model
                        );
                        
                        const ollamaResult = await withUsageTracking<any>(
                            runtime,
                            {
                                modelProvider: provider,
                                modelName: model,
                                modelClass: effectiveModelClass,
                                requestType: "generateText",
                                userId,
                                inputTokens,
                                getOutputTokens: (result) => calculateTokenCount(result.text, model),
                                extractActualUsage: extractUsageFromResult,
                            },
                            () => aiGenerateText({
                                model: ollama,
                                prompt: context,
                                tools: tools,
                                onStepFinish: onStepFinish,
                                temperature: temperature,
                                maxSteps: maxSteps,
                                maxTokens: max_response_length,
                                frequencyPenalty: frequency_penalty,
                                presencePenalty: presence_penalty,
                                experimental_telemetry: experimental_telemetry, abortSignal: signal,
                            })
                        );

                        response = ollamaResult.text.replace(
                            /<think>[\s\S]*?<\/think>\s*\n*/g,
                            ""
                        );
                    }
                    elizaLogger.debug("Received response from Ollama model.");
                    break;

                case ModelProviderName.HEURIST: {
                    elizaLogger.debug("Initializing Heurist model.");

                    const heurist = createOpenAI({
                        apiKey,
                        baseURL: getEndpoint(provider),
                        fetch: runtime.fetch,
                    });

                    // Calculate input tokens
                    const inputTokens = calculateTokenCount(
                        [effectiveSystemPrompt, context].filter(Boolean).join("\n\n"),
                        model
                    );
                    
                    const heuristResult = await withUsageTracking<any>(
                        runtime,
                        {
                            modelProvider: provider,
                            modelName: model,
                            modelClass: effectiveModelClass,
                            requestType: "generateText",
                            userId,
                            inputTokens,
                            getOutputTokens: (result) => calculateTokenCount(result.text, model),
                            extractActualUsage: extractUsageFromResult,
                        },
                        () => aiGenerateText({
                            model: heurist.languageModel(model),
                            prompt: context,
                            temperature: temperature,
                            system: effectiveSystemPrompt,
                            tools: tools,
                            onStepFinish: onStepFinish,
                            maxSteps: maxSteps,
                            maxTokens: max_response_length,
                            frequencyPenalty: frequency_penalty,
                            presencePenalty: presence_penalty,
                            experimental_telemetry: experimental_telemetry, abortSignal: signal,
                        })
                    );

                    response = heuristResult.text;
                    elizaLogger.debug("Received response from Heurist model.");
                    break;
                }

                case ModelProviderName.GALADRIEL: {
                    elizaLogger.debug("Initializing Galadriel model.");
                    const galadriel = createOpenAI({
                        apiKey,
                        baseURL: getEndpoint(provider),
                        fetch: runtime.fetch,
                    });

                    // Calculate input tokens
                    const inputTokens = calculateTokenCount(
                        [effectiveSystemPrompt, context].filter(Boolean).join("\n\n"),
                        model
                    );
                    
                    const galadrielResult = await withUsageTracking<any>(
                        runtime,
                        {
                            modelProvider: provider,
                            modelName: model,
                            modelClass: effectiveModelClass,
                            requestType: "generateText",
                            userId,
                            inputTokens,
                            getOutputTokens: (result) => calculateTokenCount(result.text, model),
                            extractActualUsage: extractUsageFromResult,
                        },
                        () => aiGenerateText({
                            model: galadriel.languageModel(model),
                            prompt: context,
                            temperature: temperature,
                            system: effectiveSystemPrompt,
                            tools: tools,
                            onStepFinish: onStepFinish,
                            maxSteps: maxSteps,
                            maxTokens: max_response_length,
                            frequencyPenalty: frequency_penalty,
                            presencePenalty: presence_penalty,
                            experimental_telemetry: experimental_telemetry, abortSignal: signal,
                        })
                    );

                    response = galadrielResult.text;
                    elizaLogger.debug("Received response from Galadriel model.");
                    break;
                }

                case ModelProviderName.MISTRAL: {
                    elizaLogger.debug("Initializing Mistral model.");
                    const mistral = createMistral({
                        apiKey,
                        fetch: runtime.fetch,
                    });

                    // Calculate input tokens
                    const inputTokens = calculateTokenCount(
                        [effectiveSystemPrompt, context].filter(Boolean).join("\n\n"),
                        model
                    );
                    
                    const mistralResult = await withUsageTracking<any>(
                        runtime,
                        {
                            modelProvider: provider,
                            modelName: model,
                            modelClass: effectiveModelClass,
                            requestType: "generateText",
                            userId,
                            inputTokens,
                            getOutputTokens: (result) => calculateTokenCount(result.text, model),
                            extractActualUsage: extractUsageFromResult,
                        },
                        () => aiGenerateText({
                            model: mistral(model),
                            prompt: context,
                            temperature: temperature,
                            system: effectiveSystemPrompt,
                            tools: tools,
                            onStepFinish: onStepFinish,
                            maxSteps: maxSteps,
                            maxTokens: max_response_length,
                            frequencyPenalty: frequency_penalty,
                            presencePenalty: presence_penalty,
                            experimental_telemetry: experimental_telemetry, abortSignal: signal,
                        })
                    );

                    response = mistralResult.text;
                    elizaLogger.debug("Received response from Mistral model.");
                    break;
                }

                case ModelProviderName.GROK: {
                    elizaLogger.debug(
                        "Initializing Grok model with Cloudflare check"
                    );
                    const baseURL = getCloudflareGatewayBaseURL(runtime, "grok");
                    const grok = createOpenAI({
                        apiKey,
                        baseURL: baseURL || getEndpoint(provider),
                        fetch: runtime.fetch,
                    });

                    // Calculate input tokens
                    const inputTokens = calculateTokenCount(
                        [effectiveSystemPrompt, context].filter(Boolean).join("\n\n"),
                        model
                    );
                    
                    const grokResult = await withUsageTracking<any>(
                        runtime,
                        {
                            modelProvider: provider,
                            modelName: model,
                            modelClass: effectiveModelClass,
                            requestType: "generateText",
                            userId,
                            inputTokens,
                            getOutputTokens: (result) => calculateTokenCount(result.text, model),
                            extractActualUsage: extractUsageFromResult,
                        },
                        () => aiGenerateText({
                            model: grok.languageModel(model),
                            prompt: context,
                            temperature: temperature,
                            system: effectiveSystemPrompt,
                            tools: tools,
                            onStepFinish: onStepFinish,
                            maxSteps: maxSteps,
                            maxTokens: max_response_length,
                            frequencyPenalty: frequency_penalty,
                            presencePenalty: presence_penalty,
                            experimental_telemetry: experimental_telemetry, abortSignal: signal,
                        })
                    );

                    response = grokResult.text;
                    elizaLogger.debug("Received response from Grok model.");
                    break;
                }

                case ModelProviderName.GAIANET: {
                    elizaLogger.debug("Initializing GaiaNet model.");

                    const gaianet = createOpenAI({
                        apiKey,
                        baseURL: getEndpoint(provider),
                        fetch: runtime.fetch,
                    });

                    // Calculate input tokens
                    const inputTokens = calculateTokenCount(
                        [effectiveSystemPrompt, context].filter(Boolean).join("\n\n"),
                        model
                    );
                    
                    const gaianetResult = await withUsageTracking<any>(
                        runtime,
                        {
                            modelProvider: provider,
                            modelName: model,
                            modelClass: effectiveModelClass,
                            requestType: "generateText",
                            userId,
                            inputTokens,
                            getOutputTokens: (result) => calculateTokenCount(result.text, model),
                            extractActualUsage: extractUsageFromResult,
                        },
                        () => aiGenerateText({
                            model: gaianet.languageModel(model),
                            prompt: context,
                            temperature: temperature,
                            system: effectiveSystemPrompt,
                            tools: tools,
                            onStepFinish: onStepFinish,
                            maxSteps: maxSteps,
                            maxTokens: max_response_length,
                            frequencyPenalty: frequency_penalty,
                            presencePenalty: presence_penalty,
                            experimental_telemetry: experimental_telemetry, abortSignal: signal,
                        })
                    );

                    response = gaianetResult.text;
                    elizaLogger.debug("Received response from GaiaNet model.");
                    break;
                }

                case ModelProviderName.LIVEPEER: {
                    elizaLogger.debug("Initializing Livepeer model.");

                    if (!endpoint) {
                        throw new Error("Livepeer Gateway URL is not defined");
                    }

                    // Calculate input tokens
                    const inputTokens = calculateTokenCount(
                        [effectiveSystemPrompt, context].filter(Boolean).join("\n\n"),
                        model
                    );

                    const requestBody = {
                        model: model,
                        messages: [
                            {
                                role: "system",
                                content:
                                    effectiveSystemPrompt ??
                                    "You are a helpful assistant",
                            },
                            {
                                role: "user",
                                content: context,
                            },
                        ],
                        max_tokens: max_response_length,
                        stream: false,
                    };

                    const _liveCtrl = new AbortController();
                    const _liveTimer = setTimeout(() => _liveCtrl.abort(), 60_000);
                    const fetchResponse = await runtime.fetch(endpoint + "/llm", {
                        method: "POST",
                        headers: {
                            accept: "text/event-stream",
                            "Content-Type": "application/json",
                            Authorization: "Bearer eliza-app-llm",
                        },
                        body: JSON.stringify(requestBody),
                        signal: _liveCtrl.signal,
                    }).finally(() => clearTimeout(_liveTimer));

                    if (!fetchResponse.ok) {
                        const errorText = await fetchResponse.text();
                        throw new Error(
                            `Livepeer request failed (${fetchResponse.status}): ${errorText}`
                        );
                    }

                    const json = await fetchResponse.json();

                    if (!json?.choices?.[0]?.message?.content) {
                        throw new Error("Invalid response format from Livepeer");
                    }

                    response = json.choices[0].message.content;

                    await trackGenerationUsage(runtime, {
                        modelProvider: provider,
                        modelName: model,
                        modelClass: effectiveModelClass,
                        requestType: "generateText",
                        userId,
                        inputTokens,
                        outputTokens: calculateTokenCount(response, model),
                        responseTimeMs: undefined,
                        success: true,
                    });

                    elizaLogger.debug("Received response from Livepeer model.");
                    break;
                }

                case ModelProviderName.DEEPSEEK: {
                    elizaLogger.debug("Initializing DeepSeek model.");
                    const deepseek = createOpenAI({
                        apiKey,
                        baseURL: getEndpoint(provider),
                        fetch: runtime.fetch,
                    });

                    // Calculate input tokens
                    const inputTokens = calculateTokenCount(
                        [effectiveSystemPrompt, context].filter(Boolean).join("\n\n"),
                        model
                    );
                    
                    const deepseekResult = await withUsageTracking<any>(
                        runtime,
                        {
                            modelProvider: provider,
                            modelName: model,
                            modelClass: effectiveModelClass,
                            requestType: "generateText",
                            userId,
                            inputTokens,
                            getOutputTokens: (result) => calculateTokenCount(result.text, model),
                            extractActualUsage: extractUsageFromResult,
                        },
                        () => aiGenerateText({
                            model: deepseek.languageModel(model),
                            prompt: context,
                            temperature: temperature,
                            system: effectiveSystemPrompt,
                            tools: tools,
                            onStepFinish: onStepFinish,
                            maxSteps: maxSteps,
                            maxTokens: max_response_length,
                            frequencyPenalty: frequency_penalty,
                            presencePenalty: presence_penalty,
                            experimental_telemetry: experimental_telemetry, abortSignal: signal,
                        })
                    );

                    response = deepseekResult.text;
                    elizaLogger.debug("Received response from DeepSeek model.");
                    break;
                }

                case ModelProviderName.BEDROCK: {
                    elizaLogger.debug("Initializing Bedrock model.");

                    // Calculate input tokens
                    const inputTokens = calculateTokenCount(
                        [effectiveSystemPrompt, context].filter(Boolean).join("\n\n"),
                        model
                    );
                    
                    const bedrockResult = await withUsageTracking<any>(
                        runtime,
                        {
                            modelProvider: provider,
                            modelName: model,
                            modelClass: effectiveModelClass,
                            requestType: "generateText",
                            userId,
                            inputTokens,
                            getOutputTokens: (result) => calculateTokenCount(result.text, model),
                            extractActualUsage: extractUsageFromResult,
                        },
                        () => aiGenerateText({
                            model: bedrock(model),
                            maxSteps: maxSteps,
                            temperature: temperature,
                            maxTokens: max_response_length,
                            frequencyPenalty: frequency_penalty,
                            presencePenalty: presence_penalty,
                            experimental_telemetry: experimental_telemetry, abortSignal: signal,
                            prompt: context
                        })
                    );

                    response = bedrockResult.text;
                    elizaLogger.debug("Received response from Bedrock model.");
                    break;
                }

                default: {
                    const errorMessage = `Unsupported provider: ${provider}`;
                    elizaLogger.error(errorMessage);
                    throw new Error(errorMessage);
                }
            }

            // If we reach here, generation was successful
            if (hasTriedFallback) {
                elizaLogger.info(`Successfully generated text using fallback provider: ${currentProvider}`);
            }
            return response;

        } catch (error) {
            const currentApiKey = runtime.token;
            const maskedApiKey =
                currentProvider === ModelProviderName.GOOGLE
                    ? "(Vertex: GOOGLE_APPLICATION_CREDENTIALS_JSON)"
                    : currentApiKey
                      ? `${currentApiKey.substring(0, 10)}...${currentApiKey.substring(currentApiKey.length - 4)}`
                      : "none";
            elizaLogger.error(`Error in generateText with provider ${currentProvider} using API key ${maskedApiKey}:`, error);

            // First, try to rotate API keys for the current provider before falling back
            if (currentProvider === originalProvider) {
                let providerKeyName: string | null = null;
                
                // Map provider to API key name
                switch (currentProvider) {
                    case ModelProviderName.GOOGLE:
                        providerKeyName = null; // Vertex AI uses service account auth
                        break;
                    case ModelProviderName.OPENAI:
                        providerKeyName = "OPENAI_API_KEY";
                        break;
                    case ModelProviderName.ANTHROPIC:
                        providerKeyName = "ANTHROPIC_API_KEY";
                        break;
                    case ModelProviderName.GROQ:
                        providerKeyName = "GROQ_API_KEY";
                        break;
                    case ModelProviderName.MISTRAL:
                        providerKeyName = "MISTRAL_API_KEY";
                        break;
                }
                
                if (providerKeyName && typeof runtime.markApiKeyAsFailed === 'function') {
                    // Mark current key as failed
                    runtime.markApiKeyAsFailed(providerKeyName, currentApiKey);
                    
                    // Try to get next available key
                    const nextApiKey = runtime.getCurrentApiKey(providerKeyName);
                    
                    if (nextApiKey && nextApiKey !== currentApiKey) {
                        elizaLogger.info(`Rotating to next API key for ${currentProvider}`);
                        continue; // Retry with new API key
                    }
                }
            }

            // If key rotation failed or not available, try provider fallback
            if (shouldFallback(error) && !hasTriedFallback && fallbackEnabled) {
                elizaLogger.warn(`Provider ${originalProvider} failed, attempting fallback to ${fallbackProvider}`);
                
                // Check if fallback provider is available
                let fallbackApiKey: string | undefined;
                switch (fallbackProvider) {
                    case ModelProviderName.OPENAI:
                        fallbackApiKey = (runtime.character.settings?.secrets?.OPENAI_API_KEY) ??
                                       runtime.getSetting("OPENAI_API_KEY");
                        break;
                    case ModelProviderName.ANTHROPIC:
                        fallbackApiKey = (runtime.character.settings?.secrets?.ANTHROPIC_API_KEY) ??
                                       runtime.getSetting("ANTHROPIC_API_KEY");
                        break;
                    case ModelProviderName.GROQ:
                        fallbackApiKey = (runtime.character.settings?.secrets?.GROQ_API_KEY) ??
                                       runtime.getSetting("GROQ_API_KEY");
                        break;
                    case ModelProviderName.DEEPSEEK:
                        fallbackApiKey = (runtime.character.settings?.secrets?.DEEPSEEK_API_KEY) ??
                                       runtime.getSetting("DEEPSEEK_API_KEY");
                        break;
                    default:
                        fallbackApiKey = (runtime.character.settings?.secrets?.OPENAI_API_KEY) ??
                                       runtime.getSetting("OPENAI_API_KEY");
                        break;
                }
                
                if (!fallbackApiKey) {
                    elizaLogger.error(`Fallback to ${fallbackProvider} requested but no API key available`);
                    throw error;
                }

                currentProvider = fallbackProvider;
                hasTriedFallback = true;
                continue; // Retry with fallback provider
            }

            // If we've already tried fallback or error doesn't warrant fallback, throw the error
            throw error;
        }
    }
}

/**
 * Sends a message to the model to determine if it should respond to the given context.
 * @param opts - The options for the generateText request
 * @param opts.context The context to evaluate for response
 * @param opts.stop A list of strings to stop the generateText at
 * @param opts.model The model to use for generateText
 * @param opts.frequency_penalty The frequency penalty to apply (0.0 to 2.0)
 * @param opts.presence_penalty The presence penalty to apply (0.0 to 2.0)
 * @param opts.temperature The temperature to control randomness (0.0 to 2.0)
 * @param opts.serverUrl The URL of the API server
 * @param opts.max_context_length Maximum allowed context length in tokens
 * @param opts.max_response_length Maximum allowed response length in tokens
 * @returns Promise resolving to "RESPOND", "IGNORE", "STOP" or null
 */
export async function generateShouldRespond({
    runtime,
    context,
    modelClass,
    userId,
}: {
    runtime: IAgentRuntime;
    context: string;
    modelClass: ModelClass;
    userId?: string;
}): Promise<"RESPOND" | "IGNORE" | "STOP" | null> {
    let retryDelay = 1000;
    while (true) {
        try {
            elizaLogger.debug(
                "Attempting to generate text with context:",
                context
            );
            const response = await generateText({
                runtime,
                prompt: context,
                modelClass,
                userId,
            });

            elizaLogger.debug("Received response from generateText:", response);
            const parsedResponse = parseShouldRespondFromText(response.trim());
            if (parsedResponse) {
                elizaLogger.debug("Parsed response:", parsedResponse);
                return parsedResponse;
            } else {
                elizaLogger.debug("generateShouldRespond no response");
            }
        } catch (error) {
            elizaLogger.error("Error in generateShouldRespond:", error);
            if (
                error instanceof TypeError &&
                error.message.includes("queueTextCompletion")
            ) {
                elizaLogger.error(
                    "TypeError: Cannot read properties of null (reading 'queueTextCompletion')"
                );
            }
        }

        elizaLogger.log(`Retrying in ${retryDelay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        retryDelay *= 2;
    }
}

/**
 * Splits content into chunks of specified size with optional overlapping bleed sections
 * @param content - The text content to split into chunks
 * @param chunkSize - The maximum size of each chunk in tokens
 * @param bleed - Number of characters to overlap between chunks (default: 100)
 * @returns Promise resolving to array of text chunks with bleed sections
 */
export async function splitChunks(
    content: string,
    chunkSize = 1500, // in tokens
    bleed = 100 // in tokens
): Promise<string[]> {
    elizaLogger.debug(`[splitChunks] Starting text split`);

    // Validate parameters
    if (chunkSize <= 0) {
        elizaLogger.warn(
            `Invalid chunkSize (${chunkSize}), using default 1500`
        );
        chunkSize = 1500;
    }

    if (bleed >= chunkSize) {
        elizaLogger.warn(
            `Bleed (${bleed}) >= chunkSize (${chunkSize}), adjusting bleed to 1/4 of chunkSize`
        );
        bleed = Math.floor(chunkSize / 4);
    }

    if (bleed < 0) {
        elizaLogger.warn(`Invalid bleed (${bleed}), using default 100`);
        bleed = 100;
    }

    const chunks = splitText(content, chunkSize, bleed);

    elizaLogger.debug(`[splitChunks] Split complete:`, {
        numberOfChunks: chunks.length,
        averageChunkSize:
            chunks.reduce((acc, chunk) => acc + chunk.length, 0) /
            chunks.length,
    });

    return chunks;
}


function estimateTokensFromEnglishLength(stringLength) {
    return Math.round(stringLength / 4); // Rough estimate: 1 token ≈ 4 characters in English
}

function estimateEnglishLengthFromTokens(tokenCount) {
    return tokenCount * 4; // Reverse estimate: 1 token ≈ 4 characters in English
}

export function splitText(content: string, chunkSize: number, bleed: number): string[] {
    // Convert chunk size and bleed from tokens to approximate character length
    const chunkCharSize = estimateEnglishLengthFromTokens(chunkSize);
    const bleedCharSize = estimateEnglishLengthFromTokens(bleed);

    // If content is smaller than estimated chunk size, return it as a single chunk
    if (content.length <= chunkCharSize) {
        return [content];
    }

    const chunks: string[] = [];
    let start = 0;

    while (start < content.length) {
        const end = Math.min(start + chunkCharSize, content.length);
        chunks.push(content.substring(start, end));

        // Move forward by (chunkSize - bleed), converted to character length
        const nextStart = start + (chunkCharSize - bleedCharSize);
        if (nextStart >= content.length || nextStart <= start) {
            break; // Stop if no progress is made
        }
        start = nextStart;
    }

    return chunks;
}

/**
 * Sends a message to the model and parses the response as a boolean value
 * @param opts - The options for the generateText request
 * @param opts.context The context to evaluate for the boolean response
 * @param opts.stop A list of strings to stop the generateText at
 * @param opts.model The model to use for generateText
 * @param opts.frequency_penalty The frequency penalty to apply (0.0 to 2.0)
 * @param opts.presence_penalty The presence penalty to apply (0.0 to 2.0)
 * @param opts.temperature The temperature to control randomness (0.0 to 2.0)
 * @param opts.serverUrl The URL of the API server
 * @param opts.max_context_length Maximum allowed context length in tokens
 * @param opts.max_response_length Maximum allowed response length in tokens
 * @returns Promise resolving to a boolean value parsed from the model's response
 */
export async function generateTrueOrFalse({
    runtime,
    context = "",
    modelClass,
    userId,
}: {
    runtime: IAgentRuntime;
    context: string;
    modelClass: ModelClass;
    userId?: string;
}): Promise<boolean> {
    let retryDelay = 1000;
    const effectiveModelClass = await resolveModelClass(runtime, modelClass, userId);
    const modelSettings = getModelSettings(runtime.modelProvider, effectiveModelClass);
    const stop = Array.from(
        new Set([...(modelSettings.stop || []), ["\n"]])
    ) as string[];

    while (true) {
        try {
            const response = await generateText({
                stop,
                runtime,
                prompt: context,
                modelClass: effectiveModelClass,
                userId,
            });

            const parsedResponse = parseBooleanFromText(response.trim());
            if (parsedResponse !== null) {
                return parsedResponse;
            }
        } catch (error) {
            elizaLogger.error("Error in generateTrueOrFalse:", error);
        }

        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        retryDelay *= 2;
    }
}

/**
 * Send a message to the model and parse the response as a string array
 * @param opts - The options for the generateText request
 * @param opts.context The context/prompt to send to the model
 * @param opts.stop Array of strings that will stop the model's generation if encountered
 * @param opts.model The language model to use
 * @param opts.frequency_penalty The frequency penalty to apply (0.0 to 2.0)
 * @param opts.presence_penalty The presence penalty to apply (0.0 to 2.0)
 * @param opts.temperature The temperature to control randomness (0.0 to 2.0)
 * @param opts.serverUrl The URL of the API server
 * @param opts.token The API token for authentication
 * @param opts.max_context_length Maximum allowed context length in tokens
 * @param opts.max_response_length Maximum allowed response length in tokens
 * @returns Promise resolving to an array of strings parsed from the model's response
 */
export async function generateTextArray({
    runtime,
    context,
    modelClass,
    userId,
}: {
    runtime: IAgentRuntime;
    context: string;
    modelClass: ModelClass;
    userId?: string;
}): Promise<string[]> {
    if (!context) {
        elizaLogger.error("generateTextArray context is empty");
        return [];
    }
    let retryDelay = 1000;

    while (true) {
        try {
            const response = await generateText({
                runtime,
                prompt: context,
                modelClass,
                userId,
            });

            const parsedResponse = parseJsonArrayFromText(response);
            if (parsedResponse) {
                return parsedResponse;
            }
        } catch (error) {
            elizaLogger.error("Error in generateTextArray:", error);
        }

        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        retryDelay *= 2;
    }
}

export async function generateObjectDeprecated({
    runtime,
    context,
    modelClass,
    userId,
}: {
    runtime: IAgentRuntime;
    context: string;
    modelClass: ModelClass;
    userId?: string;
}): Promise<any> {
    if (!context) {
        elizaLogger.error("generateObjectDeprecated context is empty");
        return null;
    }
    let retryDelay = 1000;

    while (true) {
        try {
            // this is slightly different than generateObjectArray, in that we parse object, not object array
            const response = await generateText({
                runtime,
                prompt: context,
                modelClass,
                userId,
            });
            const parsedResponse = parseJSONObjectFromText(response);
            if (parsedResponse) {
                return parsedResponse;
            }
        } catch (error) {
            elizaLogger.error("Error in generateObject:", error);
        }

        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        retryDelay *= 2;
    }
}

export async function generateObjectArray({
    runtime,
    context,
    modelClass,
    userId,
}: {
    runtime: IAgentRuntime;
    context: string;
    modelClass: ModelClass;
    userId?: string;
}): Promise<any[]> {
    if (!context) {
        elizaLogger.error("generateObjectArray context is empty");
        return [];
    }
    let retryDelay = 1000;

    while (true) {
        try {
            const response = await generateText({
                runtime,
                prompt: context,
                modelClass,
                userId,
            });

            const parsedResponse = parseJsonArrayFromText(response);
            if (parsedResponse) {
                return parsedResponse;
            }
        } catch (error) {
            elizaLogger.error("Error in generateTextArray:", error);
        }

        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        retryDelay *= 2;
    }
}

/**
 * Send a message to the model for generateText.
 * @param opts - The options for the generateText request.
 * @param opts.context The context of the message to be completed.
 * @param opts.stop A list of strings to stop the generateText at.
 * @param opts.model The model to use for generateText.
 * @param opts.frequency_penalty The frequency penalty to apply to the generateText.
 * @param opts.presence_penalty The presence penalty to apply to the generateText.
 * @param opts.temperature The temperature to apply to the generateText.
 * @param opts.max_context_length The maximum length of the context to apply to the generateText.
 * @returns The completed message.
 */
export async function generateMessageResponse({
    runtime,
    context,
    modelClass,
    userId,
}: {
    runtime: IAgentRuntime;
    context: string;
    modelClass: ModelClass;
    userId?: string;
}): Promise<Content> {
    const effectiveModelClass = await resolveModelClass(runtime, modelClass, userId);
    const modelSettings = getModelSettings(runtime.modelProvider, effectiveModelClass);
    const max_context_length = modelSettings.maxInputTokens;

    context = await trimTokens(context, max_context_length, runtime);
    elizaLogger.debug("Context:", context);
    let retryLength = 1000; // exponential backoff
    while (true) {
        try {
            elizaLogger.log("Generating message response..");

            const response = await generateText({
                runtime,
                prompt: context,
                modelClass: effectiveModelClass,
                userId,
            });

            // try parsing the response as JSON, if null then try again
            const parsedContent = parseJSONObjectFromText(response) as Content;
            if (!parsedContent) {
                elizaLogger.debug("parsedContent is null, retrying");
                continue;
            }

            return parsedContent;
        } catch (error) {
            elizaLogger.error("ERROR:", error);
            // wait for 2 seconds
            retryLength *= 2;
            await new Promise((resolve) => setTimeout(resolve, retryLength));
            elizaLogger.debug("Retrying...");
        }
    }
}

export const generateImage = async (
    data: {
        prompt: string;
        width: number;
        height: number;
        count?: number;
        negativePrompt?: string;
        numIterations?: number;
        guidanceScale?: number;
        seed?: number;
        modelId?: string;
        jobId?: string;
        stylePreset?: string;
        hideWatermark?: boolean;
        safeMode?: boolean;
        cfgScale?: number;
    },
    runtime: IAgentRuntime
): Promise<{
    success: boolean;
    data?: string[];
    error?: any;
}> => {
    const modelSettings = getImageModelSettings(runtime.imageModelProvider);
    if (!modelSettings) {
        elizaLogger.warn(
            "No model settings found for the image model provider."
        );
        return { success: false, error: "No model settings available" };
    }
    const model = modelSettings.name;
    elizaLogger.info("Generating image with options:", {
        imageModelProvider: model,
    });

    const apiKey =
        runtime.imageModelProvider === runtime.modelProvider
            ? runtime.token
            : (() => {
                  // First try to match the specific provider
                  switch (runtime.imageModelProvider) {
                      case ModelProviderName.HEURIST:
                          return runtime.getSetting("HEURIST_API_KEY");
                      case ModelProviderName.TOGETHER:
                          return runtime.getSetting("TOGETHER_API_KEY");
                      case ModelProviderName.FAL:
                          return runtime.getSetting("FAL_API_KEY");
                      case ModelProviderName.OPENAI:
                          return runtime.getSetting("OPENAI_API_KEY");
                      case ModelProviderName.VENICE:
                          return runtime.getSetting("VENICE_API_KEY");
                      case ModelProviderName.LIVEPEER:
                          return runtime.getSetting("LIVEPEER_GATEWAY_URL");
                      case ModelProviderName.SECRETAI:
                          return runtime.getSetting("SECRET_AI_API_KEY");
                      case ModelProviderName.NEARAI:
                          try {
                              // Read auth config from ~/.nearai/config.json if it exists
                              const config = JSON.parse(
                                  fs.readFileSync(
                                      path.join(
                                          os.homedir(),
                                          ".nearai/config.json"
                                      ),
                                      "utf8"
                                  )
                              );
                              return JSON.stringify(config?.auth);
                          } catch (e) {
                              elizaLogger.warn(
                                  `Error loading NEAR AI config. The environment variable NEARAI_API_KEY will be used. ${e}`
                              );
                          }
                          return runtime.getSetting("NEARAI_API_KEY");
                      default:
                          // If no specific match, try the fallback chain
                          return (
                              runtime.getSetting("HEURIST_API_KEY") ??
                              runtime.getSetting("NINETEEN_AI_API_KEY") ??
                              runtime.getSetting("TOGETHER_API_KEY") ??
                              runtime.getSetting("FAL_API_KEY") ??
                              runtime.getSetting("OPENAI_API_KEY") ??
                              runtime.getSetting("VENICE_API_KEY") ??
                              runtime.getSetting("LIVEPEER_GATEWAY_URL")
                          );
                  }
              })();
    try {
        if (runtime.imageModelProvider === ModelProviderName.HEURIST) {
            const response = await fetchWithTimeout(
                "http://sequencer.heurist.xyz/submit_job",
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        job_id: data.jobId || crypto.randomUUID(),
                        model_input: {
                            SD: {
                                prompt: data.prompt,
                                neg_prompt: data.negativePrompt,
                                num_iterations: data.numIterations || 20,
                                width: data.width || 512,
                                height: data.height || 512,
                                guidance_scale: data.guidanceScale || 3,
                                seed: data.seed || -1,
                            },
                        },
                        model_id: model,
                        deadline: 60,
                        priority: 1,
                    }),
                }
            );

            if (!response.ok) {
                throw new Error(
                    `Heurist image generation failed: ${response.statusText}`
                );
            }

            const imageURL = await response.json();
            return { success: true, data: [imageURL] };
        } else if (
            runtime.imageModelProvider === ModelProviderName.TOGETHER ||
            // for backwards compat
            runtime.imageModelProvider === ModelProviderName.LLAMACLOUD
        ) {
            const together = new Together({ apiKey: apiKey as string });
            const response = await together.images.create({
                model: model,
                prompt: data.prompt,
                width: data.width,
                height: data.height,
                steps: modelSettings?.steps ?? 4,
                n: data.count,
            });

            // Add type assertion to handle the response properly
            const togetherResponse =
                response as unknown as TogetherAIImageResponse;

            if (
                !togetherResponse.data ||
                !Array.isArray(togetherResponse.data)
            ) {
                throw new Error("Invalid response format from Together AI");
            }

            // Rest of the code remains the same...
            const base64s = await Promise.all(
                togetherResponse.data.map(async (image) => {
                    if (!image.url) {
                        elizaLogger.error("Missing URL in image data:", image);
                        throw new Error("Missing URL in Together AI response");
                    }

                    // Fetch the image from the URL
                    const imageResponse = await fetchWithTimeout(image.url);
                    if (!imageResponse.ok) {
                        throw new Error(
                            `Failed to fetch image: ${imageResponse.statusText}`
                        );
                    }

                    // Convert to blob and then to base64
                    const blob = await imageResponse.blob();
                    const arrayBuffer = await blob.arrayBuffer();
                    const base64 = Buffer.from(arrayBuffer).toString("base64");

                    // Return with proper MIME type
                    return `data:image/jpeg;base64,${base64}`;
                })
            );

            if (base64s.length === 0) {
                throw new Error("No images generated by Together AI");
            }

            elizaLogger.debug(`Generated ${base64s.length} images`);
            return { success: true, data: base64s };
        } else if (runtime.imageModelProvider === ModelProviderName.FAL) {
            fal.config({
                credentials: apiKey as string,
            });

            // Prepare the input parameters according to their schema
            const input = {
                prompt: data.prompt,
                image_size: "square" as const,
                num_inference_steps: modelSettings?.steps ?? 50,
                guidance_scale: data.guidanceScale || 3.5,
                num_images: data.count,
                enable_safety_checker:
                    runtime.getSetting("FAL_AI_ENABLE_SAFETY_CHECKER") ===
                    "true",
                safety_tolerance: Number(
                    runtime.getSetting("FAL_AI_SAFETY_TOLERANCE") || "2"
                ),
                output_format: "png" as const,
                seed: data.seed ?? 6252023,
                ...(runtime.getSetting("FAL_AI_LORA_PATH")
                    ? {
                        loras: [
                            {
                                path: runtime.getSetting("FAL_AI_LORA_PATH"),
                                scale: 1,
                            },
                        ],
                    }
                    : {}),
            };

            // Subscribe to the model
            const result = await fal.subscribe(model, {
                input,
                logs: true,
                onQueueUpdate: (update) => {
                    if (update.status === "IN_PROGRESS") {
                        elizaLogger.info(update.logs.map((log) => log.message));
                    }
                },
            });
            // Convert the returned image URLs to base64 to match existing functionality
            const base64Promises = result.data.images.map(async (image) => {
                const response = await fetchWithTimeout(image.url);
                const blob = await response.blob();
                const buffer = await blob.arrayBuffer();
                const base64 = Buffer.from(buffer).toString("base64");
                return `data:${image.content_type};base64,${base64}`;
            });

            const base64s = await Promise.all(base64Promises);
            return { success: true, data: base64s };
        } else if (runtime.imageModelProvider === ModelProviderName.VENICE) {
            const response = await fetchWithTimeout(
                "https://api.venice.ai/api/v1/image/generate",
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        model: model,
                        prompt: data.prompt,
                        cfg_scale: data.guidanceScale,
                        negative_prompt: data.negativePrompt,
                        width: data.width,
                        height: data.height,
                        steps: data.numIterations,
                        safe_mode: data.safeMode,
                        seed: data.seed,
                        style_preset: data.stylePreset,
                        hide_watermark: data.hideWatermark,
                    }),
                }
            );

            const result = await response.json();

            if (!result.images || !Array.isArray(result.images)) {
                throw new Error("Invalid response format from Venice AI");
            }

            const base64s = result.images.map((base64String) => {
                if (!base64String) {
                    throw new Error(
                        "Empty base64 string in Venice AI response"
                    );
                }
                return `data:image/png;base64,${base64String}`;
            });

            return { success: true, data: base64s };
        } else if (
            runtime.imageModelProvider === ModelProviderName.NINETEEN_AI
        ) {
            const response = await fetchWithTimeout(
                "https://api.nineteen.ai/v1/text-to-image",
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        model: model,
                        prompt: data.prompt,
                        negative_prompt: data.negativePrompt,
                        width: data.width,
                        height: data.height,
                        steps: data.numIterations,
                        cfg_scale: data.guidanceScale || 3,
                    }),
                }
            );

            const result = await response.json();

            if (!result.images || !Array.isArray(result.images)) {
                throw new Error("Invalid response format from Nineteen AI");
            }

            const base64s = result.images.map((base64String) => {
                if (!base64String) {
                    throw new Error(
                        "Empty base64 string in Nineteen AI response"
                    );
                }
                return `data:image/png;base64,${base64String}`;
            });

            return { success: true, data: base64s };
        } else if (runtime.imageModelProvider === ModelProviderName.LIVEPEER) {
            if (!apiKey) {
                throw new Error("Livepeer Gateway is not defined");
            }
            try {
                const baseUrl = new URL(apiKey);
                if (!baseUrl.protocol.startsWith("http")) {
                    throw new Error("Invalid Livepeer Gateway URL protocol");
                }

                const response = await fetchWithTimeout(
                    `${baseUrl.toString()}text-to-image`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            Authorization: "Bearer eliza-app-img",
                        },
                        body: JSON.stringify({
                            model_id:
                                data.modelId || "ByteDance/SDXL-Lightning",
                            prompt: data.prompt,
                            width: data.width || 1024,
                            height: data.height || 1024,
                        }),
                    }
                );
                const result = await response.json();
                if (!result.images?.length) {
                    throw new Error("No images generated");
                }
                const base64Images = await Promise.all(
                    result.images.map(async (image) => {
                        let imageUrl;
                        if (image.url.includes("http")) {
                            imageUrl = image.url;
                        } else {
                            imageUrl = `${apiKey}${image.url}`;
                        }
                        const imageResponse = await fetchWithTimeout(imageUrl);
                        if (!imageResponse.ok) {
                            throw new Error(
                                `Failed to fetch image: ${imageResponse.statusText}`
                            );
                        }
                        const blob = await imageResponse.blob();
                        const arrayBuffer = await blob.arrayBuffer();
                        const base64 =
                            Buffer.from(arrayBuffer).toString("base64");
                        return `data:image/jpeg;base64,${base64}`;
                    })
                );
                return {
                    success: true,
                    data: base64Images,
                };
            } catch (error) {
                console.error(error);
                return { success: false, error: error };
            }
        } else if (runtime.imageModelProvider === ModelProviderName.NEARAI) {
            let targetSize = `${data.width}x${data.height}`;
            if (
                targetSize !== "1024x1024" &&
                targetSize !== "1792x1024" &&
                targetSize !== "1024x1792" &&
                targetSize !== "512x512" &&
                targetSize !== "256x256"
            ) {
                targetSize = "1024x1024";
            }
            // NEAR AI uses OpenAI compatible API
            const openai = new OpenAI({
                baseURL: getEndpoint(ModelProviderName.NEARAI),
                apiKey,
            });
            const response = await openai.images.generate({
                model,
                prompt: data.prompt,
                size: targetSize as "1024x1024" | "1792x1024" | "1024x1792" | "512x512" | "256x256",
                n: data.count,
                response_format: "b64_json",
            });
            const base64s = response.data.map(
                (image) => `data:image/png;base64,${image.b64_json}`
            );
            return { success: true, data: base64s };
        } else {
            let targetSize = `${data.width}x${data.height}`;
            if (
                targetSize !== "1024x1024" &&
                targetSize !== "1792x1024" &&
                targetSize !== "1024x1792"
            ) {
                targetSize = "1024x1024";
            }
            const openaiApiKey = runtime.getSetting("OPENAI_API_KEY") as string;
            if (!openaiApiKey) {
                throw new Error("OPENAI_API_KEY is not set");
            }
            const openai = new OpenAI({
                apiKey: openaiApiKey as string,
            });
            const response = await openai.images.generate({
                model,
                prompt: data.prompt,
                size: targetSize as "1024x1024" | "1792x1024" | "1024x1792",
                n: data.count,
                response_format: "b64_json",
            });
            const base64s = response.data.map(
                (image) => `data:image/png;base64,${image.b64_json}`
            );
            return { success: true, data: base64s };
        }
    } catch (error) {
        console.error(error);
        return { success: false, error: error };
    }
};

export const generateCaption = async (
    data: { imageUrl: string },
    runtime: IAgentRuntime
): Promise<{
    title: string;
    description: string;
}> => {
    const { imageUrl } = data;
    const imageDescriptionService =
        runtime.getService<IImageDescriptionService>(
            ServiceType.IMAGE_DESCRIPTION
        );

    if (!imageDescriptionService) {
        throw new Error("Image description service not found");
    }

    const resp = await imageDescriptionService.describeImage(imageUrl);
    return {
        title: resp.title.trim(),
        description: resp.description.trim(),
    };
};

/**
 * Configuration options for generating objects with a model.
 */
export interface GenerationOptions {
    runtime: IAgentRuntime;
    context: string;
    modelClass: ModelClass;
    schema?: ZodSchema;
    schemaName?: string;
    schemaDescription?: string;
    stop?: string[];
    mode?: "auto" | "json" | "tool";
    experimental_providerMetadata?: Record<string, unknown>;
    userId?: string;
    bypassModelClassDowngrades?: boolean;
    // verifiableInference?: boolean;
    // verifiableInferenceAdapter?: IVerifiableInferenceAdapter;
    // verifiableInferenceOptions?: VerifiableInferenceOptions;
}

/**
 * Base settings for model generation.
 */
interface ModelSettings {
    prompt: string;
    temperature: number;
    maxTokens: number;
    frequencyPenalty: number;
    presencePenalty: number;
    stop?: string[];
    experimental_telemetry?: TelemetrySettings;
}

/**
 * Generates structured objects from a prompt using specified AI models and configuration options.
 *
 * @param {GenerationOptions} options - Configuration options for generating objects.
 * @returns {Promise<any[]>} - A promise that resolves to an array of generated objects.
 * @throws {Error} - Throws an error if the provider is unsupported or if generation fails.
 */
export const generateObject = async ({
    runtime,
    context,
    modelClass,
    schema,
    schemaName,
    schemaDescription,
    stop,
    mode = "json",
    userId,
    bypassModelClassDowngrades,
}: // verifiableInference = false,
// verifiableInferenceAdapter,
// verifiableInferenceOptions,
GenerationOptions): Promise<GenerateObjectResult<unknown>> => {
    if (!context) {
        const errorMessage = "generateObject context is empty";
        console.error(errorMessage);
        throw new Error(errorMessage);
    }

    const provider = runtime.modelProvider;
    const effectiveModelClass = await resolveModelClass(runtime, modelClass, userId, {
        bypassModelClassDowngrades,
    });
    const modelSettings = getModelSettings(runtime.modelProvider, effectiveModelClass);
    const model = modelSettings.name;
    const temperature = modelSettings.temperature;
    const frequency_penalty = modelSettings.frequency_penalty;
    const presence_penalty = modelSettings.presence_penalty;
    const max_context_length = modelSettings.maxInputTokens;
    const max_response_length = modelSettings.maxOutputTokens;
    const experimental_telemetry = modelSettings.experimental_telemetry;
    const apiKey = runtime.token;

    try {
        context = await trimTokens(context, max_context_length, runtime);

        const modelOptions: ModelSettings = {
            prompt: context,
            temperature,
            maxTokens: max_response_length,
            frequencyPenalty: frequency_penalty,
            presencePenalty: presence_penalty,
            stop: stop || modelSettings.stop,
            experimental_telemetry: experimental_telemetry,
        };

        const response = await handleProvider({
            provider,
            model,
            apiKey,
            schema,
            schemaName,
            schemaDescription,
            mode,
            modelOptions,
            runtime,
            context,
            modelClass: effectiveModelClass,
            userId,
            // verifiableInference,
            // verifiableInferenceAdapter,
            // verifiableInferenceOptions,
        });

        return response;
    } catch (error) {
        console.error("Error in generateObject:", error);
        throw error;
    }
};

/**
 * Handles AI generation based on the specified provider.
 *
 * @param {ProviderOptions} options - Configuration options specific to the provider.
 * @returns {Promise<any[]>} - A promise that resolves to an array of generated objects.
 */
export async function handleProvider(
    options: ProviderOptions
): Promise<GenerationResult> {
    const {
        provider,
        runtime,
        context,
        modelClass,
        userId,
        //verifiableInference,
        //verifiableInferenceAdapter,
        //verifiableInferenceOptions,
    } = options;
    switch (provider) {
        case ModelProviderName.OPENAI:
        case ModelProviderName.ETERNALAI:
        case ModelProviderName.ALI_BAILIAN:
        case ModelProviderName.VOLENGINE:
        case ModelProviderName.LLAMACLOUD:
        case ModelProviderName.TOGETHER:
        case ModelProviderName.NANOGPT:
        case ModelProviderName.AKASH_CHAT_API:
        case ModelProviderName.LMSTUDIO:
        case ModelProviderName.KLUSTERAI:
            return await handleOpenAI(options);
        case ModelProviderName.ANTHROPIC:
        case ModelProviderName.CLAUDE_VERTEX:
            return await handleAnthropic(options);
        case ModelProviderName.GROK:
            return await handleGrok(options);
        case ModelProviderName.GROQ:
            return await handleGroq(options);
        case ModelProviderName.LLAMALOCAL:
            return await generateObjectDeprecated({
                runtime,
                context,
                modelClass,
                userId,
            });
        case ModelProviderName.GOOGLE:
            return await handleGoogle(options);
        case ModelProviderName.MISTRAL:
            return await handleMistral(options);
        case ModelProviderName.REDPILL:
            return await handleRedPill(options);
        case ModelProviderName.OPENROUTER:
            return await handleOpenRouter(options);
        case ModelProviderName.OLLAMA:
            return await handleOllama(options);
        case ModelProviderName.DEEPSEEK:
            return await handleDeepSeek(options);
        case ModelProviderName.LIVEPEER:
            return await handleLivepeer(options);
        case ModelProviderName.SECRETAI:
            return await handleSecretAi(options);
        case ModelProviderName.NEARAI:
            return await handleNearAi(options);
        case ModelProviderName.BEDROCK:
            return await handleBedrock(options);
        default: {
            const errorMessage = `Unsupported provider: ${provider}`;
            elizaLogger.error(errorMessage);
            throw new Error(errorMessage);
        }
    }
}
/**
 * Handles object generation for OpenAI.
 *
 * @param {ProviderOptions} options - Options specific to OpenAI.
 * @returns {Promise<GenerateObjectResult<unknown>>} - A promise that resolves to generated objects.
 */
async function handleOpenAI({
    model,
    apiKey,
    schema,
    schemaName,
    schemaDescription,
    mode = "json",
    modelOptions,
    provider,
    runtime,
    context,
    modelClass,
    userId,
}: ProviderOptions): Promise<GenerateObjectResult<unknown>> {
    const endpoint = runtime.character.modelEndpointOverride || getEndpoint(provider);
    const baseURL = getCloudflareGatewayBaseURL(runtime, "openai") || endpoint;
    const openai = createOpenAI({
        apiKey,
        baseURL,
        fetch: runtime.fetch
    });
    
    // Calculate input tokens
    const inputTokens = calculateTokenCount(context || modelOptions.prompt, model);
    
    return withUsageTracking(
        runtime,
        {
            modelProvider: provider,
            modelName: model,
            modelClass,
            requestType: 'generateObject',
            userId,
            inputTokens,
            getOutputTokens: (result) => {
                const objectStr = JSON.stringify(result.object);
                return calculateTokenCount(objectStr, model);
            },
            extractActualUsage: (result) => {
                const usage = (result as any)?.usage;
                if (usage) {
                    return {
                        inputTokens: usage.promptTokens,
                        outputTokens: usage.completionTokens,
                        totalTokens: usage.totalTokens
                    };
                }
                return undefined;
            }
        },
        () => aiGenerateObject({
            model: openai.languageModel(model),
            schema,
            schemaName,
            schemaDescription,
            mode,
            ...modelOptions,
        })
    );
}

/**
 * Handles object generation for Anthropic models.
 *
 * @param {ProviderOptions} options - Options specific to Anthropic.
 * @returns {Promise<GenerateObjectResult<unknown>>} - A promise that resolves to generated objects.
 */
async function handleAnthropic({
    model,
    apiKey,
    schema,
    schemaName,
    schemaDescription,
    mode = "auto",
    modelOptions,
    runtime,
    provider,
    context,
    modelClass,
    userId,
}: ProviderOptions): Promise<GenerationResult> {
    elizaLogger.debug("Handling Anthropic request with Cloudflare check");
    if (mode === "json") {
        elizaLogger.warn("Anthropic mode is set to json, changing to auto");
        mode = "auto";
    }
    const baseURL = getCloudflareGatewayBaseURL(runtime, "anthropic");
    elizaLogger.debug("Anthropic handleAnthropic baseURL:", { baseURL });

    const anthropic = createAnthropic({
        apiKey,
        baseURL,
        fetch: runtime.fetch
    });
    
    // Calculate input tokens
    const inputTokens = calculateTokenCount(context || modelOptions.prompt, model);
    
    return await withUsageTracking(
        runtime,
        {
            modelProvider: provider,
            modelName: model,
            modelClass,
            requestType: 'generateObject',
            userId,
            inputTokens,
            getOutputTokens: (result) => {
                const objectStr = JSON.stringify(result.object);
                return calculateTokenCount(objectStr, model);
            },
            extractActualUsage: (result) => {
                const usage = (result as any)?.usage;
                if (usage) {
                    return {
                        inputTokens: usage.input_tokens,
                        outputTokens: usage.output_tokens,
                        totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0)
                    };
                }
                return undefined;
            }
        },
        () => aiGenerateObject({
            model: anthropic.languageModel(model),
            schema,
            schemaName,
            schemaDescription,
            mode,
            ...modelOptions,
        })
    );
}

/**
 * Handles object generation for Grok models.
 *
 * @param {ProviderOptions} options - Options specific to Grok.
 * @returns {Promise<GenerateObjectResult<unknown>>} - A promise that resolves to generated objects.
 */
async function handleGrok({
    model,
    apiKey,
    schema,
    schemaName,
    schemaDescription,
    mode = "json",
    modelOptions,
    runtime,
    provider,
    context,
    modelClass,
    userId,
}: ProviderOptions): Promise<GenerationResult> {
    const grok = createOpenAI({
        apiKey,
        baseURL: models.grok.endpoint,
        fetch: runtime.fetch
    });

    const inputTokens = calculateTokenCount(context || modelOptions.prompt, model);

    return withUsageTracking(
        runtime,
        {
            modelProvider: provider,
            modelName: model,
            modelClass,
            requestType: "generateObject",
            userId,
            inputTokens,
            getOutputTokens: (result) => {
                const objectStr = JSON.stringify(result.object);
                return calculateTokenCount(objectStr, model);
            },
            extractActualUsage: (result) => {
                const usage = (result as any)?.usage;
                if (!usage) {
                    return undefined;
                }
                return {
                    inputTokens: usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens,
                    outputTokens: usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens,
                    totalTokens: usage.totalTokens ?? usage.total_tokens,
                };
            }
        },
        () => aiGenerateObject({
            model: grok.languageModel(model, { parallelToolCalls: false }),
            schema,
            schemaName,
            schemaDescription,
            mode,
            ...modelOptions,
        })
    );
}

/**
 * Handles object generation for Groq models.
 *
 * @param {ProviderOptions} options - Options specific to Groq.
 * @returns {Promise<GenerateObjectResult<unknown>>} - A promise that resolves to generated objects.
 */
async function handleGroq({
    model,
    apiKey,
    schema,
    schemaName,
    schemaDescription,
    mode = "json",
    modelOptions,
    runtime,
    provider,
    context,
    modelClass,
    userId,
}: ProviderOptions): Promise<GenerationResult> {
    elizaLogger.debug("Handling Groq request with Cloudflare check");
    const baseURL = getCloudflareGatewayBaseURL(runtime, "groq");
    elizaLogger.debug("Groq handleGroq baseURL:", { baseURL });

    const groq = createGroq({
        apiKey,
        baseURL,
        fetch: runtime.fetch
    });
    
    // Calculate input tokens
    const inputTokens = calculateTokenCount(context || modelOptions.prompt, model);
    
    return await withUsageTracking(
        runtime,
        {
            modelProvider: provider,
            modelName: model,
            modelClass,
            requestType: 'generateObject',
            userId,
            inputTokens,
            getOutputTokens: (result) => {
                const objectStr = JSON.stringify(result.object);
                return calculateTokenCount(objectStr, model);
            },
            extractActualUsage: (result) => {
                const usage = (result as any)?.usage;
                if (usage) {
                    return {
                        inputTokens: usage.prompt_tokens || usage.promptTokens,
                        outputTokens: usage.completion_tokens || usage.completionTokens,
                        totalTokens: usage.total_tokens || usage.totalTokens
                    };
                }
                return undefined;
            }
        },
        () => aiGenerateObject({
            model: groq.languageModel(model),
            schema,
            schemaName,
            schemaDescription,
            mode,
            ...modelOptions,
        })
    );
}

/**
 * Handles object generation for Google models.
 *
 * @param {ProviderOptions} options - Options specific to Google.
 * @returns {Promise<GenerateObjectResult<unknown>>} - A promise that resolves to generated objects.
 */
async function handleGoogle({
    model,
    apiKey,
    schema,
    schemaName,
    schemaDescription,
    mode = "json",
    modelOptions,
    runtime,
    provider,
    context,
    modelClass,
    userId,
}: ProviderOptions): Promise<GenerateObjectResult<unknown>> {
    const vertexProject = runtime.getSetting("GOOGLE_VERTEX_PROJECT") ?? "";
    const vertexLocation = runtime.getSetting("GOOGLE_VERTEX_LOCATION") ?? "global";
    const vertexHost = vertexLocation === "global" ? "aiplatform.googleapis.com" : `${vertexLocation}-aiplatform.googleapis.com`;
    const google = createVertex({
        project: vertexProject,
        location: vertexLocation,
        baseURL: `https://${vertexHost}/v1/projects/${vertexProject}/locations/${vertexLocation}/publishers/google`,
        googleAuthOptions: {
            credentials: googleApplicationCredentialsFromSetting(
                runtime.getSetting("GOOGLE_APPLICATION_CREDENTIALS_JSON"),
            ),
        },
    });
    
    // Calculate input tokens
    const inputTokens = calculateTokenCount(context || modelOptions.prompt, model);
    
    return withUsageTracking(
        runtime,
        {
            modelProvider: provider,
            modelName: model,
            modelClass,
            requestType: 'generateObject',
            userId,
            inputTokens,
            getOutputTokens: (result) => {
                const objectStr = JSON.stringify(result.object);
                return calculateTokenCount(objectStr, model);
            },
            extractActualUsage: (result) => {
                const usage = (result as any)?.usage;
                if (usage) {
                    return {
                        inputTokens: usage.promptTokens,
                        outputTokens: usage.completionTokens,
                        totalTokens: usage.totalTokens
                    };
                }
                return undefined;
            }
        },
        () => aiGenerateObject({
            model: google(model),
            schema,
            schemaName,
            schemaDescription,
            mode,
            ...modelOptions,
        })
    );
}

/**
 * Handles object generation for Mistral models.
 *
 * @param {ProviderOptions} options - Options specific to Mistral.
 * @returns {Promise<GenerateObjectResult<unknown>>} - A promise that resolves to generated objects.
 */
async function handleMistral({
    model,
    schema,
    schemaName,
    schemaDescription,
    mode,
    modelOptions,
    provider,
    runtime,
    context,
    modelClass,
    userId,
}: ProviderOptions): Promise<GenerationResult> {
    const mistral = createMistral({ fetch: runtime.fetch });

    const inputTokens = calculateTokenCount(context || modelOptions.prompt, model);

    return withUsageTracking(
        runtime,
        {
            modelProvider: provider,
            modelName: model,
            modelClass,
            requestType: "generateObject",
            userId,
            inputTokens,
            getOutputTokens: (result) => {
                const objectStr = JSON.stringify(result.object);
                return calculateTokenCount(objectStr, model);
            },
            extractActualUsage: (result) => {
                const usage = (result as any)?.usage;
                if (!usage) {
                    return undefined;
                }
                return {
                    inputTokens: usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens,
                    outputTokens: usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens,
                    totalTokens: usage.totalTokens ?? usage.total_tokens,
                };
            }
        },
        () => aiGenerateObject({
            model: mistral(model),
            schema,
            schemaName,
            schemaDescription,
            mode,
            ...modelOptions,
        })
    );
}

/**
 * Handles object generation for Redpill models.
 *
 * @param {ProviderOptions} options - Options specific to Redpill.
 * @returns {Promise<GenerateObjectResult<unknown>>} - A promise that resolves to generated objects.
 */
async function handleRedPill({
    model,
    apiKey,
    schema,
    schemaName,
    schemaDescription,
    mode = "json",
    modelOptions,
    provider,
    runtime,
    context,
    modelClass,
    userId,
}: ProviderOptions): Promise<GenerationResult> {
    const redPill = createOpenAI({
        apiKey,
        baseURL: models.redpill.endpoint,
        fetch: runtime.fetch
    });

    const inputTokens = calculateTokenCount(context || modelOptions.prompt, model);

    return withUsageTracking(
        runtime,
        {
            modelProvider: provider,
            modelName: model,
            modelClass,
            requestType: "generateObject",
            userId,
            inputTokens,
            getOutputTokens: (result) => {
                const objectStr = JSON.stringify(result.object);
                return calculateTokenCount(objectStr, model);
            },
            extractActualUsage: (result) => {
                const usage = (result as any)?.usage;
                if (!usage) {
                    return undefined;
                }
                return {
                    inputTokens: usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens,
                    outputTokens: usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens,
                    totalTokens: usage.totalTokens ?? usage.total_tokens,
                };
            }
        },
        () => aiGenerateObject({
            model: redPill.languageModel(model),
            schema,
            schemaName,
            schemaDescription,
            mode,
            ...modelOptions,
        })
    );
}

/**
 * Handles object generation for OpenRouter models.
 *
 * @param {ProviderOptions} options - Options specific to OpenRouter.
 * @returns {Promise<GenerateObjectResult<unknown>>} - A promise that resolves to generated objects.
 */
async function handleOpenRouter({
    model,
    apiKey,
    schema,
    schemaName,
    schemaDescription,
    mode = "json",
    modelOptions,
    provider,
    runtime,
    context,
    modelClass,
    userId,
}: ProviderOptions): Promise<GenerationResult> {
    const openRouter = createOpenAI({
        apiKey,
        baseURL: models.openrouter.endpoint,
        fetch: runtime.fetch
    });

    const inputTokens = calculateTokenCount(context || modelOptions.prompt, model);

    return withUsageTracking(
        runtime,
        {
            modelProvider: provider,
            modelName: model,
            modelClass,
            requestType: "generateObject",
            userId,
            inputTokens,
            getOutputTokens: (result) => {
                const objectStr = JSON.stringify(result.object);
                return calculateTokenCount(objectStr, model);
            },
            extractActualUsage: (result) => {
                const usage = (result as any)?.usage;
                if (!usage) {
                    return undefined;
                }
                return {
                    inputTokens: usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens,
                    outputTokens: usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens,
                    totalTokens: usage.totalTokens ?? usage.total_tokens,
                };
            }
        },
        () => aiGenerateObject({
            model: openRouter.languageModel(model),
            schema,
            schemaName,
            schemaDescription,
            mode,
            ...modelOptions,
        })
    );
}

/**
 * Handles object generation for Ollama models.
 *
 * @param {ProviderOptions} options - Options specific to Ollama.
 * @returns {Promise<GenerateObjectResult<unknown>>} - A promise that resolves to generated objects.
 */
async function handleOllama({
    model,
    schema,
    schemaName,
    schemaDescription,
    mode = "json",
    modelOptions,
    provider,
    runtime,
    context,
    modelClass,
    userId,
}: ProviderOptions): Promise<GenerationResult> {
    const ollamaProvider = createOllama({
        baseURL: getEndpoint(provider) + "/api",
        fetch: runtime.fetch
    });
    const ollama = ollamaProvider(model);

    const inputTokens = calculateTokenCount(context || modelOptions.prompt, model);

    return withUsageTracking(
        runtime,
        {
            modelProvider: provider,
            modelName: model,
            modelClass,
            requestType: "generateObject",
            userId,
            inputTokens,
            getOutputTokens: (result) => {
                const objectStr = JSON.stringify(result.object);
                return calculateTokenCount(objectStr, model);
            },
            extractActualUsage: (result) => {
                const usage = (result as any)?.usage;
                if (!usage) {
                    return undefined;
                }
                return {
                    inputTokens: usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens,
                    outputTokens: usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens,
                    totalTokens: usage.totalTokens ?? usage.total_tokens,
                };
            }
        },
        () => aiGenerateObject({
            model: ollama,
            schema,
            schemaName,
            schemaDescription,
            mode,
            ...modelOptions,
        })
    );
}

/**
 * Handles object generation for DeepSeek models.
 *
 * @param {ProviderOptions} options - Options specific to DeepSeek.
 * @returns {Promise<GenerateObjectResult<unknown>>} - A promise that resolves to generated objects.
 */
async function handleDeepSeek({
    model,
    apiKey,
    schema,
    schemaName,
    schemaDescription,
    mode,
    modelOptions,
    provider,
    runtime,
    context,
    modelClass,
    userId,
}: ProviderOptions): Promise<GenerationResult> {
    const openai = createOpenAI({
        apiKey,
        baseURL: models.deepseek.endpoint,
        fetch: runtime.fetch
    });

    const inputTokens = calculateTokenCount(context || modelOptions.prompt, model);

    return withUsageTracking(
        runtime,
        {
            modelProvider: provider,
            modelName: model,
            modelClass,
            requestType: "generateObject",
            userId,
            inputTokens,
            getOutputTokens: (result) => {
                const objectStr = JSON.stringify(result.object);
                return calculateTokenCount(objectStr, model);
            },
            extractActualUsage: (result) => {
                const usage = (result as any)?.usage;
                if (!usage) {
                    return undefined;
                }
                return {
                    inputTokens: usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens,
                    outputTokens: usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens,
                    totalTokens: usage.totalTokens ?? usage.total_tokens,
                };
            }
        },
        () => aiGenerateObject({
            model: openai.languageModel(model),
            schema,
            schemaName,
            schemaDescription,
            mode,
            ...modelOptions,
        })
    );
}

/**
 * Handles object generation for Amazon Bedrock models.
 *
 * @param {ProviderOptions} options - Options specific to Amazon Bedrock.
 * @returns {Promise<GenerateObjectResult<unknown>>} - A promise that resolves to generated objects.
 */
async function handleBedrock({
    model,
    schema,
    schemaName,
    schemaDescription,
    mode,
    modelOptions,
    provider,
    runtime,
    context,
    modelClass,
    userId,
}: ProviderOptions): Promise<GenerationResult> {
    const bedrockClient = bedrock(model);

    const inputTokens = calculateTokenCount(context || modelOptions.prompt, model);

    return withUsageTracking(
        runtime,
        {
            modelProvider: provider,
            modelName: model,
            modelClass,
            requestType: "generateObject",
            userId,
            inputTokens,
            getOutputTokens: (result) => {
                const objectStr = JSON.stringify(result.object);
                return calculateTokenCount(objectStr, model);
            },
        },
        () => aiGenerateObject({
            model: bedrockClient,
            schema,
            schemaName,
            schemaDescription,
            mode,
            ...modelOptions,
        })
    );
}

async function handleLivepeer({
    model,
    apiKey,
    schema,
    schemaName,
    schemaDescription,
    mode,
    modelOptions,
    provider,
    runtime,
    context,
    modelClass,
    userId,
}: ProviderOptions): Promise<GenerationResult> {
    // API key intentionally not logged
    if (!apiKey) {
        throw new Error(
            "Livepeer provider requires LIVEPEER_GATEWAY_URL to be configured"
        );
    }

    const livepeerClient = createOpenAI({
        apiKey,
        baseURL: apiKey,
        fetch: runtime.fetch
    });

    const inputTokens = calculateTokenCount(context || modelOptions.prompt, model);

    return withUsageTracking(
        runtime,
        {
            modelProvider: provider,
            modelName: model,
            modelClass,
            requestType: "generateObject",
            userId,
            inputTokens,
            getOutputTokens: (result) => {
                const objectStr = JSON.stringify(result.object);
                return calculateTokenCount(objectStr, model);
            },
            extractActualUsage: (result) => {
                const usage = (result as any)?.usage;
                if (!usage) {
                    return undefined;
                }
                return {
                    inputTokens: usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens,
                    outputTokens: usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens,
                    totalTokens: usage.totalTokens ?? usage.total_tokens,
                };
            }
        },
        () => aiGenerateObject({
            model: livepeerClient.languageModel(model),
            schema,
            schemaName,
            schemaDescription,
            mode,
            ...modelOptions,
        })
    );
}

/**
 * Handles object generation for Secret AI models.
 *
 * @param {ProviderOptions} options - Options specific to Secret AI.
 * @returns {Promise<GenerateObjectResult<unknown>>} - A promise that resolves to generated objects.
 */
async function handleSecretAi({
    model,
    apiKey,
    schema,
    schemaName,
    schemaDescription,
    mode = "json",
    modelOptions,
    provider,
    runtime,
    context,
    modelClass,
    userId,
}: ProviderOptions): Promise<GenerationResult> {
    const secretAiProvider = createOllama({
        baseURL: getEndpoint(provider) + "/api",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        fetch: runtime.fetch
    });
    const secretAi = secretAiProvider(model);

    const inputTokens = calculateTokenCount(context || modelOptions.prompt, model);

    return withUsageTracking(
        runtime,
        {
            modelProvider: provider,
            modelName: model,
            modelClass,
            requestType: "generateObject",
            userId,
            inputTokens,
            getOutputTokens: (result) => {
                const objectStr = JSON.stringify(result.object);
                return calculateTokenCount(objectStr, model);
            },
            extractActualUsage: (result) => {
                const usage = (result as any)?.usage;
                if (!usage) {
                    return undefined;
                }
                return {
                    inputTokens: usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens,
                    outputTokens: usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens,
                    totalTokens: usage.totalTokens ?? usage.total_tokens,
                };
            }
        },
        () => aiGenerateObject({
            model: secretAi,
            schema,
            schemaName,
            schemaDescription,
            mode,
            ...modelOptions,
        })
    );
}

/**
 * Handles object generation for NEAR AI models.
 *
 * @param {ProviderOptions} options - Options specific to NEAR AI.
 * @returns {Promise<GenerateObjectResult<unknown>>} - A promise that resolves to generated objects.
 */
async function handleNearAi({
    model,
    apiKey,
    schema,
    schemaName,
    schemaDescription,
    mode = "json",
    modelOptions,
    provider,
    runtime,
    context,
    modelClass,
    userId,
}: ProviderOptions): Promise<GenerationResult> {
    const nearai = createOpenAI({
        apiKey,
        baseURL: models.nearai.endpoint,
        fetch: runtime.fetch
    });
    const settings = schema ? { structuredOutputs: true } : undefined;

    const inputTokens = calculateTokenCount(context || modelOptions.prompt, model);

    return withUsageTracking(
        runtime,
        {
            modelProvider: provider,
            modelName: model,
            modelClass,
            requestType: "generateObject",
            userId,
            inputTokens,
            getOutputTokens: (result) => {
                const objectStr = JSON.stringify(result.object);
                return calculateTokenCount(objectStr, model);
            },
            extractActualUsage: (result) => {
                const usage = (result as any)?.usage;
                if (!usage) {
                    return undefined;
                }
                return {
                    inputTokens: usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens,
                    outputTokens: usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens,
                    totalTokens: usage.totalTokens ?? usage.total_tokens,
                };
            }
        },
        () => aiGenerateObject({
            model: nearai.languageModel(model, settings),
            schema,
            schemaName,
            schemaDescription,
            mode,
            ...modelOptions,
        })
    );
}

// Add type definition for Together AI response
interface TogetherAIImageResponse {
    data: Array<{
        url: string;
        content_type?: string;
        image_type?: string;
    }>;
}

// doesn't belong here
export async function generateTweetActions({
    runtime,
    context,
    modelClass,
}: {
    runtime: IAgentRuntime;
    context: string;
    modelClass: ModelClass;
}): Promise<ActionResponse | null> {
    let retryDelay = 1000;
    while (true) {
        try {
            const response = await generateText({
                runtime,
                prompt: context,
                modelClass,
            });
            elizaLogger.debug(
                "Received response from generateText for tweet actions:",
                response
            );
            const { actions } = parseActionResponseFromText(response.trim());
            if (actions) {
                elizaLogger.debug("Parsed tweet actions:", actions);
                return actions;
            } else {
                elizaLogger.debug("generateTweetActions no valid response");
            }
        } catch (error) {
            elizaLogger.error("Error in generateTweetActions:", error);
            if (
                error instanceof TypeError &&
                error.message.includes("queueTextCompletion")
            ) {
                elizaLogger.error(
                    "TypeError: Cannot read properties of null (reading 'queueTextCompletion')"
                );
            }
        }
        elizaLogger.log(`Retrying in ${retryDelay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        retryDelay *= 2;
    }
}
