import { elizaLogger } from "../utils/logger.ts";
import { generateText } from "../ai/generation.ts";
import { composeContext } from "../core/context.ts";
import { ModelClass, type IAgentRuntime } from "../core/types.ts";
import { parseJSONObjectFromText } from "./parsing.ts";

/**
 * Result of JSON validation
 */
export interface ValidationResult {
    isValid: boolean;
    errors: string[];
    missingFields: string[];
    hasActions: boolean;
    hasResponse: boolean;
}

/**
 * Options for JSON retry generation
 */
export interface JsonRetryOptions {
    maxRetries?: number;
    modelClass?: ModelClass;
    /** @deprecated Use customSystemPrompt when the caller must override the default persona. */
    system?: string;
    customSystemPrompt?: string;
}

/**
 * Validate if parsed JSON contains the required action response format
 * @param jsonData The parsed JSON data to validate
 * @returns Validation result with detailed error information
 */
export function validateActionResponseFormat(jsonData: any): ValidationResult {
    const result: ValidationResult = {
        isValid: true,
        errors: [],
        missingFields: [],
        hasActions: false,
        hasResponse: false
    };

    // Check if jsonData exists and is an object
    if (!jsonData || typeof jsonData !== 'object') {
        result.isValid = false;
        result.errors.push("JSON data is null, undefined, or not an object");
        return result;
    }

    // Check for required fields
    const requiredFields = ['response'];
    const optionalButImportantFields = ['action', 'analysis', 'reasoning', 'is_crypto_related'];

    // Validate required fields
    for (const field of requiredFields) {
        if (!(field in jsonData) || jsonData[field] === null || jsonData[field] === undefined) {
            result.missingFields.push(field);
            result.errors.push(`Missing required field: ${field}`);
        }
    }

    // Check if response field has content
    if (jsonData.response !== null && jsonData.response !== undefined) {
        result.hasResponse = true;
        if (typeof jsonData.response !== 'string' || jsonData.response.trim().length === 0) {
            result.errors.push("Response field must be a non-empty string");
        }
    }

    // Check action field format if present
    if (jsonData.action !== null && jsonData.action !== undefined) {
        result.hasActions = true;
        
        // Action can be string, object, or array
        if (Array.isArray(jsonData.action)) {
            // Validate action array
            if (jsonData.action.length === 0) {
                result.errors.push("Action array is empty");
            } else {
                for (let i = 0; i < jsonData.action.length; i++) {
                    const action = jsonData.action[i];
                    if (!action || typeof action !== 'object') {
                        result.errors.push(`Action[${i}] must be an object`);
                        continue;
                    }
                    if (!action.name || typeof action.name !== 'string') {
                        result.errors.push(`Action[${i}] missing required 'name' field`);
                    }
                    // Parameters and target are optional, but if present should be properly formatted
                    if (action.parameters !== undefined && action.parameters !== null && typeof action.parameters !== 'object') {
                        result.errors.push(`Action[${i}] parameters must be an object`);
                    }
                }
            }
        } else if (typeof jsonData.action === 'object') {
            // Single action object
            if (!jsonData.action.name || typeof jsonData.action.name !== 'string') {
                result.errors.push("Action object missing required 'name' field");
            }
        } else if (typeof jsonData.action === 'string') {
            // String action name (legacy format)
            if (jsonData.action.trim().length === 0) {
                result.errors.push("Action string cannot be empty");
            }
        } else {
            result.errors.push("Action field must be a string, object, or array of objects");
        }
    }

    // Validate other important fields if present
    if (jsonData.analysis !== undefined && (typeof jsonData.analysis !== 'string' || jsonData.analysis.trim().length === 0)) {
        result.errors.push("Analysis field must be a non-empty string when present");
    }

    if (jsonData.reasoning !== undefined && (typeof jsonData.reasoning !== 'string' || jsonData.reasoning.trim().length === 0)) {
        result.errors.push("Reasoning field must be a non-empty string when present");
    }

    if (jsonData.is_crypto_related !== undefined && typeof jsonData.is_crypto_related !== 'boolean') {
        result.errors.push("is_crypto_related field must be a boolean when present");
    }

    if (jsonData.next_step !== undefined && jsonData.next_step !== null && 
        (typeof jsonData.next_step !== 'string' || jsonData.next_step.trim().length === 0)) {
        result.errors.push("next_step field must be a non-empty string or null when present");
    }

    // Update validity based on errors
    result.isValid = result.errors.length === 0;

    return result;
}

/**
 * Create a prompt for asking the LLM to fix malformed JSON
 * @param malformedResponse The original malformed response
 * @param validationErrors List of validation errors
 * @param originalPrompt The original prompt that led to malformed JSON
 * @returns Correction prompt string
 */
export function createJsonCorrectionPrompt(
    malformedResponse: string,
    validationErrors: string[],
    originalPrompt: string
): string {
    return `# JSON FORMAT CORRECTION REQUIRED

Your previous response did not follow the required JSON format. Please fix the issues and provide a properly formatted JSON response.

## ORIGINAL PROMPT:
${originalPrompt}

## YOUR PREVIOUS RESPONSE:
${malformedResponse}

## DETECTED ISSUES:
${validationErrors.map(error => `• ${error}`).join('\n')}

## REQUIRED JSON FORMAT:
\`\`\`json
{
  "is_crypto_related": true/false,
  "analysis": "Deep analysis of situation, user needs, and context",
  "reasoning": "Numbered to-do list of steps with clear line breaks:\\n1. First step\\n2. Second step\\n3. Third step",
  "action": [
    {
      "name": "action_name",
      "target": "specific_object_or_null", 
      "parameters": {"key": "value"}
    }
  ],
  "response": "One clear sentence answering the user",
  "next_step": "Specific actionable suggestion or null"
}
\`\`\`

## CRITICAL REQUIREMENTS:
1. **MUST** be valid JSON (no syntax errors)
2. **MUST** include "response" field with meaningful content
3. **MUST** include "is_crypto_related" boolean field
4. If actions are needed, format them as an array of objects with "name" field
5. Use proper escaping for newlines in strings (\\n)
6. No trailing commas
7. All string values must be properly quoted

Please provide ONLY the corrected JSON response, nothing else.`;
}

/**
 * Generate a response using the LLM to fix malformed JSON
 * @param runtime The agent runtime
 * @param malformedResponse The original malformed response
 * @param validationErrors List of validation errors
 * @param originalContext The original context/prompt
 * @returns Promise resolving to corrected response
 */
export async function generateJsonCorrectionResponse(
    runtime: IAgentRuntime,
    malformedResponse: string,
    validationErrors: string[],
    originalContext: string
): Promise<string> {
    elizaLogger.info(`[JSON_RETRY] Attempting to correct malformed JSON response`);
    elizaLogger.debug(`[JSON_RETRY] Validation errors:`, validationErrors);
    
    // Create correction prompt
    const correctionPrompt = createJsonCorrectionPrompt(
        malformedResponse,
        validationErrors,
        originalContext
    );

    try {
        // Generate corrected response using the same model settings
        const correctedResponse = await generateText({
            runtime,
            prompt: correctionPrompt,
            modelClass: ModelClass.MEDIUM, // Use MEDIUM class for correction
            customSystemPrompt: "You are a JSON format correction specialist. Your task is to fix malformed JSON responses while preserving the original intent and content. Always respond with valid, properly formatted JSON."
        });

        elizaLogger.info(`[JSON_RETRY] Generated correction response of length: ${correctedResponse.length}`);
        return correctedResponse;
        
    } catch (error: any) {
        elizaLogger.error(`[JSON_RETRY] Failed to generate correction response:`, error);
        throw new Error(`JSON correction generation failed: ${error.message}`);
    }
}

/**
 * Generate text with automatic JSON validation and retry mechanism
 * @param runtime The agent runtime
 * @param context The context/prompt for generation
 * @param modelClass The model class to use
 * @param options Additional options including retry settings
 * @returns Promise resolving to valid response or throws after max retries
 */
export async function generateTextWithJsonRetry(
    runtime: IAgentRuntime,
    context: string,
    modelClass: ModelClass = ModelClass.MEDIUM,
    options: JsonRetryOptions = {}
): Promise<string> {
    const maxRetries = options.maxRetries ?? 2;
    const useModelClass = options.modelClass ?? modelClass;
    
    elizaLogger.info(`[JSON_RETRY] Starting text generation with JSON validation (max retries: ${maxRetries})`);
    
    let lastResponse = "";
    let lastErrors: string[] = [];
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            elizaLogger.info(`[JSON_RETRY] Attempt ${attempt + 1}/${maxRetries + 1}`);
            
            let response: string;
            
            if (attempt === 0) {
                // First attempt: use original context
                response = await generateText({
                    runtime,
                    prompt: context,
                    modelClass: useModelClass,
                    customSystemPrompt:
                        options.customSystemPrompt ?? options.system
                });
                elizaLogger.info(`[JSON_RETRY] First attempt generated response of length: ${response.length}`);
            } else {
                // Retry attempt: use correction prompt
                response = await generateJsonCorrectionResponse(
                    runtime,
                    lastResponse,
                    lastErrors,
                    context
                );
                elizaLogger.info(`[JSON_RETRY] Retry attempt ${attempt} generated response of length: ${response.length}`);
            }
            
            lastResponse = response;
            
            // Try to extract and validate JSON from the response
            const jsonData = parseJSONObjectFromText(response);

            if (!jsonData) {
                lastErrors = ["No JSON structure found in response"];
                elizaLogger.warn(`[JSON_RETRY] Attempt ${attempt + 1}: No JSON found in response`);

                if (attempt === maxRetries) {
                    elizaLogger.warn(`[JSON_RETRY] Max retries reached, returning original response without JSON`);
                    return response; // Return original response as fallback
                }
                continue;
            }
            
            try {
                // Validate the parsed JSON
                const validation = validateActionResponseFormat(jsonData);
                
                if (validation.isValid) {
                    elizaLogger.success(`[JSON_RETRY] Valid JSON response generated on attempt ${attempt + 1}`);
                    elizaLogger.debug(`[JSON_RETRY] Validation details:`, {
                        hasActions: validation.hasActions,
                        hasResponse: validation.hasResponse,
                        errorsCount: validation.errors.length
                    });
                    return response; // Success!
                } else {
                    lastErrors = validation.errors;
                    elizaLogger.warn(`[JSON_RETRY] Attempt ${attempt + 1}: JSON validation failed`, {
                        errors: validation.errors,
                        missingFields: validation.missingFields
                    });
                    
                    if (attempt === maxRetries) {
                        elizaLogger.warn(`[JSON_RETRY] Max retries reached with validation errors:`, validation.errors);
                        return response; // Return last response as fallback
                    }
                }
                
            } catch (parseError: any) {
                lastErrors = [`JSON parsing error: ${parseError.message}`];
                elizaLogger.warn(`[JSON_RETRY] Attempt ${attempt + 1}: JSON parsing failed:`, parseError.message);
                
                if (attempt === maxRetries) {
                    elizaLogger.warn(`[JSON_RETRY] Max retries reached with parse error: ${parseError.message}`);
                    return response; // Return original response as fallback
                }
            }
            
        } catch (generationError: any) {
            elizaLogger.error(`[JSON_RETRY] Generation failed on attempt ${attempt + 1}:`, generationError);
            
            if (attempt === maxRetries) {
                elizaLogger.error(`[JSON_RETRY] All retry attempts failed`);
                throw generationError; // Re-throw the generation error
            }
            
            lastErrors = [`Generation error: ${generationError.message}`];
        }
    }
    
    // This should never be reached, but just in case
    elizaLogger.error(`[JSON_RETRY] Unexpected end of retry loop`);
    return lastResponse || "";
}

/**
 * Helper function to check if a response contains potentially malformed JSON
 * @param response The response text to check
 * @returns True if response looks like it was intended to be JSON but is malformed
 */
export function detectsMalformedJsonIntent(response: string): boolean {
    // Look for JSON-like patterns that suggest intent but might be malformed
    const jsonIndicators = [
        /```json/i,
        /^\s*{/,
        /"response"\s*:/i,
        /"action"\s*:/i,
        /"analysis"\s*:/i,
        /"reasoning"\s*:/i,
        /"is_crypto_related"\s*:/i
    ];
    
    return jsonIndicators.some(pattern => pattern.test(response));
}
