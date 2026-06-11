/**
 * Model pricing configuration for token usage calculation
 * Prices are per 1M tokens as of January 2025
 */

export interface ModelPricing {
    input: number;  // Cost per 1M input tokens
    output: number; // Cost per 1M output tokens
}

export interface ProviderPricing {
    [modelName: string]: ModelPricing;
}

export const MODEL_PRICING: { [provider: string]: ProviderPricing } = {
    openai: {
        "gpt-4o": {
            input: 0.005,   // $5.00 per 1M tokens
            output: 0.015   // $15.00 per 1M tokens
        },
        "gpt-4o-mini": {
            input: 0.00015, // $0.15 per 1M tokens
            output: 0.0006  // $0.60 per 1M tokens
        },
        "gpt-4-turbo": {
            input: 0.01,    // $10.00 per 1M tokens
            output: 0.03    // $30.00 per 1M tokens
        },
        "gpt-4": {
            input: 0.03,    // $30.00 per 1M tokens
            output: 0.06    // $60.00 per 1M tokens
        },
        "gpt-3.5-turbo": {
            input: 0.0005,  // $0.50 per 1M tokens
            output: 0.0015  // $1.50 per 1M tokens
        },
        "text-embedding-3-small": {
            input: 0.00002, // $0.02 per 1M tokens
            output: 0       // No output tokens for embeddings
        },
        "text-embedding-3-large": {
            input: 0.00013, // $0.13 per 1M tokens
            output: 0
        },
        "dall-e-3": {
            input: 0.04,    // $40.00 per 1M tokens (estimated for image generation)
            output: 0
        }
    },
    anthropic: {
        "claude-3-5-sonnet-20241022": {
            input: 0.003,   // $3.00 per 1M tokens
            output: 0.015   // $15.00 per 1M tokens
        },
        "claude-3-5-haiku-20241022": {
            input: 0.001,   // $1.00 per 1M tokens
            output: 0.005   // $5.00 per 1M tokens
        },
        "claude-3-opus-20240229": {
            input: 0.015,   // $15.00 per 1M tokens
            output: 0.075   // $75.00 per 1M tokens
        },
        "claude-3-sonnet-20240229": {
            input: 0.003,   // $3.00 per 1M tokens
            output: 0.015   // $15.00 per 1M tokens
        },
        "claude-3-haiku-20240307": {
            input: 0.00025, // $0.25 per 1M tokens
            output: 0.00125 // $1.25 per 1M tokens
        }
    },
    google: {
        "gemini-2.5-pro": {
            input: 0.00125, // $1.25 per 1M tokens
            output: 0.005   // $5.00 per 1M tokens
        },
        "gemini-pro": {
            input: 0.00035, // $0.35 per 1M tokens
            output: 0.00105 // $1.05 per 1M tokens
        },
        "gemini-pro-vision": {
            input: 0.00035, // $0.35 per 1M tokens
            output: 0.00105 // $1.05 per 1M tokens
        },
        "gemini-flash": {
            input: 0.000075, // $0.075 per 1M tokens
            output: 0.0003   // $0.30 per 1M tokens
        }
    },
    groq: {
        "llama-3.1-405b-reasoning": {
            input: 0.0,     // Free tier pricing
            output: 0.0
        },
        "llama-3.1-70b-versatile": {
            input: 0.0,     // Free tier pricing
            output: 0.0
        },
        "llama-3.1-8b-instant": {
            input: 0.0,     // Free tier pricing
            output: 0.0
        },
        "mixtral-8x7b-32768": {
            input: 0.0,     // Free tier pricing
            output: 0.0
        }
    },
    mistral: {
        "mistral-large-latest": {
            input: 0.004,   // $4.00 per 1M tokens
            output: 0.012   // $12.00 per 1M tokens
        },
        "mistral-medium-latest": {
            input: 0.002,   // $2.00 per 1M tokens
            output: 0.006   // $6.00 per 1M tokens
        },
        "mistral-small-latest": {
            input: 0.001,   // $1.00 per 1M tokens
            output: 0.003   // $3.00 per 1M tokens
        }
    },
    together: {
        "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo": {
            input: 0.005,   // $5.00 per 1M tokens
            output: 0.005   // $5.00 per 1M tokens
        },
        "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo": {
            input: 0.0009,  // $0.90 per 1M tokens
            output: 0.0009  // $0.90 per 1M tokens
        },
        "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo": {
            input: 0.0002,  // $0.20 per 1M tokens
            output: 0.0002  // $0.20 per 1M tokens
        }
    },
    deepseek: {
        "deepseek-chat": {
            input: 0.00014, // $0.14 per 1M tokens
            output: 0.00028 // $0.28 per 1M tokens
        },
        "deepseek-coder": {
            input: 0.00014, // $0.14 per 1M tokens
            output: 0.00028 // $0.28 per 1M tokens
        }
    },
    ollama: {
        // Local models - no cost
        "*": {
            input: 0.0,
            output: 0.0
        }
    },
    local: {
        // Local models - no cost
        "*": {
            input: 0.0,
            output: 0.0
        }
    }
};

/**
 * Calculate cost for given tokens and model
 */
export function calculateTokenCost(
    tokens: number, 
    modelName: string, 
    provider: string, 
    tokenType: 'input' | 'output'
): number {
    // Normalize provider name
    const normalizedProvider = provider.toLowerCase();
    
    // Get provider pricing
    const providerPricing = MODEL_PRICING[normalizedProvider];
    if (!providerPricing) {
        // Unknown provider, return 0 cost
        return 0;
    }
    
    // Check for wildcard match (e.g., ollama/local models)
    let modelPricing = providerPricing[modelName];
    if (!modelPricing && providerPricing["*"]) {
        modelPricing = providerPricing["*"];
    }
    
    if (!modelPricing) {
        // Unknown model, return 0 cost
        return 0;
    }
    
    // Calculate cost: (tokens * price_per_million) / 1_000_000
    const pricePerToken = modelPricing[tokenType] / 1_000_000;
    return tokens * pricePerToken;
}

/**
 * Get pricing info for a model
 */
export function getModelPricing(modelName: string, provider: string): ModelPricing | null {
    const normalizedProvider = provider.toLowerCase();
    const providerPricing = MODEL_PRICING[normalizedProvider];
    
    if (!providerPricing) {
        return null;
    }
    
    // Check for exact match first
    let modelPricing = providerPricing[modelName];
    if (!modelPricing && providerPricing["*"]) {
        modelPricing = providerPricing["*"];
    }
    
    return modelPricing || null;
}

/**
 * Calculate total cost for input and output tokens
 */
export function calculateTotalCost(
    inputTokens: number,
    outputTokens: number,
    modelName: string,
    provider: string
): {
    inputCost: number;
    outputCost: number;
    totalCost: number;
} {
    const inputCost = calculateTokenCost(inputTokens, modelName, provider, 'input');
    const outputCost = calculateTokenCost(outputTokens, modelName, provider, 'output');
    
    return {
        inputCost,
        outputCost,
        totalCost: inputCost + outputCost
    };
}