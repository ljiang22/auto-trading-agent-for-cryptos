import { z } from "zod";
import { ModelProviderName } from "../core/types.ts";
import elizaLogger from "../utils/logger.ts";

// TODO: TO COMPLETE
export const envSchema = z.object({
    // API Keys with specific formats
    OPENAI_API_KEY: z
        .string()
        .startsWith("sk-", "OpenAI API key must start with 'sk-'"),
    REDPILL_API_KEY: z.string().min(1, "REDPILL API key is required"),
    GROK_API_KEY: z.string().min(1, "GROK API key is required"),
    GROQ_API_KEY: z
        .string()
        .startsWith("gsk_", "GROQ API key must start with 'gsk_'"),
    OPENROUTER_API_KEY: z.string().min(1, "OpenRouter API key is required"),
    ELEVENLABS_XI_API_KEY: z.string().min(1, "ElevenLabs API key is required"),
});

/**
 * Autotrading uplift (plan §1 + §Phase 2). Optional vars that tune
 * the deterministic trading subsystem. Parsed permissively — every
 * field is optional so a default deploy doesn't fail validation.
 */
export const autotradingEnvSchema = z.object({
    PAPER_TRADING_ENABLED: z
        .enum(["true", "false"])
        .optional()
        .describe("Gate for paper-trading venue (Phase 4)."),
    RECONCILIATION_WS_RECONNECT_BACKOFF_MS: z
        .string()
        .regex(/^\d+$/u, "Must be a positive integer (milliseconds).")
        .optional()
        .describe("Initial backoff for venue user-data WS reconnect."),
    LISTEN_KEY_REFRESH_INTERVAL_MS: z
        .string()
        .regex(/^\d+$/u, "Must be a positive integer (milliseconds).")
        .optional()
        .describe(
            "Binance listenKey keepAlive interval (must be < 30 min).",
        ),
    TRADING_GLOBAL_CONCURRENCY: z
        .string()
        .regex(/^\d+$/u, "Must be a positive integer.")
        .optional()
        .describe("Max concurrent in-flight trading workflows (default 3)."),
    TRADING_PER_USER_CONCURRENCY: z
        .string()
        .regex(/^\d+$/u, "Must be a positive integer.")
        .optional()
        .describe("Max concurrent in-flight trading workflows per user (default 1)."),
    TRADING_LOCK_STALE_MS: z
        .string()
        .regex(/^\d+$/u, "Must be a positive integer (milliseconds).")
        .optional()
        .describe("Per-symbol trading-lock TTL before reaping."),
    // Wave 1+2 autotrading safety. All optional with sane defaults in code;
    // schema entries exist so misformatted operator values fail validation
    // instead of being silently parsed as NaN (which then degrades to the
    // default and confuses operators expecting their config to bite).
    PAPER_ORDER_TTL_SECONDS: z
        .string()
        .regex(/^\d+$/u, "Must be a positive integer (seconds).")
        .optional()
        .describe("F3: paper_orders TTL in seconds (default 86400 = 24h)."),
    RECONCILIATION_UNRESOLVED_DOWNGRADE_AFTER: z
        .string()
        .regex(/^\d+$/u, "Must be a positive integer (poll cycles).")
        .optional()
        .describe(
            "F5: consecutive cred-unresolved poll cycles before runtime_lock fires (default 60 ≈ 5 min @ 5s tick).",
        ),
    CEX_DETERMINISTIC_BYPASS: z
        .enum(["true", "false"])
        .optional()
        .describe(
            "F6: enable requestId-anchored CEX continuation bypass; set 'false' to roll back the deterministic precheck bypass.",
        ),
});

// Type inference
export type EnvConfig = z.infer<typeof envSchema>;

// Validation function
export function validateEnv(): EnvConfig {
    try {
        return envSchema.parse(process.env);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path}: ${err.message}`)
                .join("\n");
            throw new Error(`Environment validation failed:\n${errorMessages}`);
        }
        throw error;
    }
}

// Helper schemas for nested types
const MessageExampleSchema = z.object({
    user: z.string(),
    content: z
        .object({
            text: z.string(),
            action: z.string().optional(),
            source: z.string().optional(),
            url: z.string().optional(),
            inReplyTo: z.string().uuid().optional(),
            attachments: z.array(z.any()).optional(),
        })
        .and(z.record(z.string(), z.unknown())), // For additional properties
});

const PluginSchema = z.object({
    name: z.string(),
    description: z.string(),
    actions: z.array(z.any()).optional(),
    providers: z.array(z.any()).optional(),
    evaluators: z.array(z.any()).optional(),
    services: z.array(z.any()).optional(),
    clients: z.array(z.any()).optional(),
});

// Main Character schema
export const CharacterSchema = z.object({
    id: z.string().uuid().optional(),
    name: z.string(),
    system: z.string().optional(),
    modelProvider: z.nativeEnum(ModelProviderName),
    modelEndpointOverride: z.string().optional(),
    templates: z.record(z.string()).optional(),
    bio: z.union([z.string(), z.array(z.string())]),
    lore: z.array(z.string()),
    messageExamples: z.array(z.array(MessageExampleSchema)),
    postExamples: z.array(z.string()),
    topics: z.array(z.string()),
    adjectives: z.array(z.string()),
    knowledge: z
        .array(
            z.union([
                z.string(), // Direct knowledge strings
                z.object({
                    // Individual file config
                    path: z.string(),
                    shared: z.boolean().optional(),
                }),
                z.object({
                    // Directory config
                    directory: z.string(),
                    shared: z.boolean().optional(),
                }),
            ])
        )
        .optional(),
    plugins: z.union([z.array(z.string()), z.array(PluginSchema)]),
    settings: z
        .object({
            secrets: z.record(z.string()).optional(),
            voice: z
                .object({
                    model: z.string().optional(),
                    url: z.string().optional(),
                })
                .optional(),
            model: z.string().optional(),
            modelConfig: z.object({
                maxInputTokens: z.number().optional(),
                maxOutputTokens: z.number().optional(),
                temperature: z.number().optional(),
                frequency_penalty: z.number().optional(),
                presence_penalty:z.number().optional()
            })
            .optional(),
            embeddingModel: z.string().optional(),
        })
        .optional(),
    clientConfig: z
        .object({
            discord: z
                .object({
                    shouldIgnoreBotMessages: z.boolean().optional(),
                    shouldIgnoreDirectMessages: z.boolean().optional(),
                })
                .optional(),
            telegram: z
                .object({
                    shouldIgnoreBotMessages: z.boolean().optional(),
                    shouldIgnoreDirectMessages: z.boolean().optional(),
                })
                .optional(),
        })
        .optional(),
    style: z.object({
        all: z.array(z.string()),
        chat: z.array(z.string()),
        post: z.array(z.string()),
    }),
    twitterProfile: z
        .object({
            username: z.string(),
            screenName: z.string(),
            bio: z.string(),
            nicknames: z.array(z.string()).optional(),
        })
        .optional(),
    nft: z
        .object({
            prompt: z.string().optional(),
        })
        .optional(),
    extends: z.array(z.string()).optional(),
});

// Type inference
export type CharacterConfig = z.infer<typeof CharacterSchema>;

// Validation function
export function validateCharacterConfig(json: unknown): CharacterConfig {
    try {
        return CharacterSchema.parse(json);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const groupedErrors = error.errors.reduce(
                (acc, err) => {
                    const path = err.path.join(".");
                    if (!acc[path]) {
                        acc[path] = [];
                    }
                    acc[path].push(err.message);
                    return acc;
                },
                {} as Record<string, string[]>
            );

            Object.entries(groupedErrors).forEach(([field, messages]) => {
                elizaLogger.error(
                    `Validation errors in ${field}: ${messages.join(" - ")}`
                );
            });

            throw new Error(
                "Character configuration validation failed. Check logs for details."
            );
        }
        throw error;
    }
}
