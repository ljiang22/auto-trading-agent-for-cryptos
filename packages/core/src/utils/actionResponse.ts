import type {
    ActionResponseMetadata,
    ActionResponseContent,
    StandardActionResponse,
    Content,
} from "../core/types.ts";

/**
 * Creates a standardized action response following the unified schema
 * 
 * @param options - Configuration for the action response
 * @returns A StandardActionResponse object ready for callback
 * 
 * @example
 * ```typescript
 * const response = createActionResponse({
 *     actionName: "GET_CRYPTO_PRICE",
 *     type: "get_crypto_price",
 *     text: "Bitcoin price is $45,000",
 *     content: {
 *         symbol: "BTC",
 *         price: 45000,
 *         currency: "USD"
 *     },
 *     actionData: {
 *         symbol: "BTC",
 *         price: 45000
 *     }
 * });
 * 
 * await callback(response);
 * ```
 */
export function createActionResponse(options: {
    /** Name of the action (must match action.name) */
    actionName: string;
    /** Action type identifier (e.g., "get_crypto_price", "onchain_data_analysis") */
    type: string;
    /** Main text content to display */
    text: string;
    /** Structured content data */
    content?: ActionResponseContent;
    /** Action-specific structured data */
    actionData?: Record<string, unknown>;
    /** Chart file path (relative to project root) */
    chartPath?: string;
    /** Array of chart paths (for multiple charts) */
    chartPaths?: string[];
    /** Cryptocurrency symbol */
    symbol?: string;
    /** Currency type */
    currency?: string;
    /** Metric type */
    metric?: string;
    /** Phase identifier for comprehensive analysis */
    phase?: string;
    /** Success status */
    success?: boolean;
    /** Error information (if action failed) */
    error?: {
        type?: string;
        message?: string;
        errorType?: string;
        errorMessage?: string;
        [key: string]: unknown;
    };
    /** Additional metadata fields */
    additionalMetadata?: Record<string, unknown>;
    /** Additional Content fields */
    additionalContent?: Partial<Content>;
}): StandardActionResponse {
    const {
        actionName,
        type,
        text,
        content,
        actionData,
        chartPath,
        chartPaths,
        symbol,
        currency,
        metric,
        phase,
        success = true,
        error,
        additionalMetadata = {},
        additionalContent = {},
    } = options;

    // Build metadata following the standard schema
    const metadata: ActionResponseMetadata = {
        type,
        timestamp: Date.now(),
        isActionResponse: true,
        actionName,
        ...(actionData && { actionData }),
        ...(chartPath && { chartPath }),
        ...(chartPaths && { chartPaths }),
        ...(symbol && { symbol }),
        ...(currency && { currency }),
        ...(metric && { metric }),
        ...(phase && { phase }),
        ...(success !== undefined && { success }),
        ...(error && { error }),
        ...additionalMetadata,
    };

    // Build content object
    const responseContent: ActionResponseContent | undefined = content
        ? {
              ...content,
              ...(chartPath && { chartPath }),
          }
        : chartPath
          ? { chartPath }
          : undefined;

    // Build the complete response
    return {
        text,
        ...(responseContent && { content: responseContent }),
        metadata,
        ...additionalContent,
    };
}

/**
 * Creates a standardized error response for actions
 * 
 * @param options - Configuration for the error response
 * @returns A StandardActionResponse object with error information
 * 
 * @example
 * ```typescript
 * try {
 *     // action logic
 * } catch (error) {
 *     const errorResponse = createActionErrorResponse({
 *         actionName: "GET_CRYPTO_PRICE",
 *         type: "get_crypto_price_error",
 *         error: error instanceof Error ? error.message : "Unknown error",
 *         text: "Failed to fetch cryptocurrency price"
 *     });
 *     await callback(errorResponse);
 * }
 * ```
 */
export function createActionErrorResponse(options: {
    /** Name of the action (must match action.name) */
    actionName: string;
    /** Action type identifier with "_error" suffix */
    type: string;
    /** Error message or Error object */
    error: string | Error;
    /** User-friendly error text */
    text: string;
    /** Additional error metadata */
    additionalMetadata?: Record<string, unknown>;
    /** Additional Content fields */
    additionalContent?: Partial<Content>;
}): StandardActionResponse {
    const { actionName, type, error, text, additionalMetadata = {}, additionalContent = {} } = options;

    const errorMessage = error instanceof Error ? error.message : error;
    const errorStack = error instanceof Error ? error.stack : undefined;

    return createActionResponse({
        actionName,
        type,
        text,
        success: false,
        error: {
            type: "action_error",
            message: errorMessage,
            ...(errorStack && { stack: errorStack }),
            ...(error instanceof Error && { errorMessage: error.message }),
        },
        additionalMetadata,
        additionalContent,
    });
}

/**
 * Validates that a response conforms to the StandardActionResponse schema
 * 
 * @param response - The response to validate
 * @returns true if valid, false otherwise
 */
export function validateActionResponse(
    response: unknown
): response is StandardActionResponse {
    if (!response || typeof response !== "object") {
        return false;
    }

    const resp = response as Record<string, unknown>;

    // Check required fields
    if (typeof resp.text !== "string") {
        return false;
    }

    if (!resp.metadata || typeof resp.metadata !== "object") {
        return false;
    }

    const metadata = resp.metadata as Record<string, unknown>;

    // Check required metadata fields
    if (typeof metadata.type !== "string") {
        return false;
    }

    if (typeof metadata.timestamp !== "number") {
        return false;
    }

    if (metadata.isActionResponse !== true) {
        return false;
    }

    if (typeof metadata.actionName !== "string") {
        return false;
    }

    return true;
}

/**
 * Type guard to check if a Content object is a StandardActionResponse
 */
export function isStandardActionResponse(
    content: Content
): content is StandardActionResponse {
    return (
        typeof content === "object" &&
        content !== null &&
        "metadata" in content &&
        typeof (content as Record<string, unknown>).metadata === "object" &&
        validateActionResponse(content)
    );
}
