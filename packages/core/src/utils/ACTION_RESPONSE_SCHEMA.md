# Action Response Schema

## Overview

All actions in the system should follow a unified response format when returning results via the `HandlerCallback`. This ensures consistent handling and display by the frontend, and makes it easier to process action responses programmatically.

## Schema Definition

The standard action response follows this structure:

```typescript
interface StandardActionResponse {
    text: string;                    // Main text content
    content?: ActionResponseContent;  // Structured data
    metadata: ActionResponseMetadata; // Standardized metadata
    // ... other Content fields
}
```

### Required Metadata Fields

All action responses **must** include these fields in `metadata`:

- `type: string` - Action type identifier (e.g., "get_crypto_price", "onchain_data_analysis")
- `timestamp: number` - Timestamp when response was generated (Date.now())
- `isActionResponse: true` - Always true for action responses
- `actionName: string` - Name of the action (must match `action.name`)

### Optional Metadata Fields

- `actionData?: object` - Structured data for programmatic access
- `chartPath?: string` - Path to generated chart file
- `chartPaths?: string[]` - Array of chart paths (for multiple charts)
- `symbol?: string` - Cryptocurrency symbol
- `currency?: string` - Currency type
- `metric?: string` - Metric type
- `phase?: string` - Phase identifier for comprehensive analysis
- `success?: boolean` - Success status
- `error?: object` - Error information (for failed actions)

## Usage

### Method 1: Using Helper Functions (Recommended)

```typescript
import { createActionResponse, createActionErrorResponse } from "@elizaos/core";

// Success response
const response = createActionResponse({
    actionName: "GET_CRYPTO_PRICE",
    type: "get_crypto_price",
    text: "Bitcoin price is $45,000",
    content: {
        symbol: "BTC",
        price: 45000,
        currency: "USD"
    },
    actionData: {
        symbol: "BTC",
        price: 45000,
        currency: "USD"
    },
    symbol: "BTC",
    currency: "USD"
});

await callback(response);

// Error response
try {
    // action logic
} catch (error) {
    const errorResponse = createActionErrorResponse({
        actionName: "GET_CRYPTO_PRICE",
        type: "get_crypto_price_error",
        error: error instanceof Error ? error : new Error(String(error)),
        text: "Failed to fetch cryptocurrency price"
    });
    await callback(errorResponse);
}
```

### Method 2: Manual Construction

```typescript
await callback({
    text: "Analysis completed",
    content: {
        onChainData: analysisResult.data,
        analysis: formattedAnalysis,
        chartPath: chartPath,
        visualizations: {
            interactive_chart: chartPath,
            chart_data: analysisResult.data.chartData
        }
    },
    metadata: {
        type: "onchain_data_analysis",
        timestamp: Date.now(),
        isActionResponse: true,
        actionName: "GET_ADDRESS_AND_TRANSACTION_DATA",
        symbol: analysisResult.data.symbol,
        metric: analysisResult.data.metric,
        chartPath: chartPath,
        actionData: {
            summary: formattedAnalysis,
            symbol: analysisResult.data.symbol,
            // ... other action-specific data
        }
    }
});
```

## Examples

### Example 1: Simple Price Action

```typescript
export const GetPriceAction: Action = {
    name: "GET_CRYPTO_PRICE",
    handler: async (runtime, message, state, options, callback) => {
        const price = await fetchPrice("BTC");
        
        if (callback) {
            await callback(createActionResponse({
                actionName: "GET_CRYPTO_PRICE",
                type: "get_crypto_price",
                text: `Bitcoin price is $${price}`,
                content: {
                    symbol: "BTC",
                    price: price,
                    currency: "USD"
                },
                actionData: {
                    symbol: "BTC",
                    price: price,
                    currency: "USD"
                },
                symbol: "BTC",
                currency: "USD"
            }));
        }
        return true;
    }
};
```

### Example 2: Action with Chart

```typescript
export const ChartAction: Action = {
    name: "PLOT_CHART",
    handler: async (runtime, message, state, options, callback) => {
        const chartPath = await generateChart(data);
        
        if (callback) {
            await callback(createActionResponse({
                actionName: "PLOT_CHART",
                type: "plot_chart",
                text: "Chart generated successfully",
                content: {
                    chartPath: chartPath,
                    visualizations: {
                        interactive_chart: chartPath,
                        chart_data: data
                    }
                },
                actionData: {
                    chartPath: chartPath,
                    dataPoints: data.length
                },
                chartPath: chartPath
            }));
        }
        return true;
    }
};
```

### Example 3: Error Handling

```typescript
export const SomeAction: Action = {
    name: "SOME_ACTION",
    handler: async (runtime, message, state, options, callback) => {
        try {
            // action logic
            const result = await doSomething();
            
            if (callback) {
                await callback(createActionResponse({
                    actionName: "SOME_ACTION",
                    type: "some_action",
                    text: "Action completed successfully",
                    actionData: result
                }));
            }
            return true;
        } catch (error) {
            if (callback) {
                await callback(createActionErrorResponse({
                    actionName: "SOME_ACTION",
                    type: "some_action_error",
                    error: error instanceof Error ? error : new Error(String(error)),
                    text: "Action failed to execute"
                }));
            }
            return false;
        }
    }
};
```

## Validation

You can validate that a response conforms to the schema:

```typescript
import { validateActionResponse, isStandardActionResponse } from "@elizaos/core";

// Type guard
if (isStandardActionResponse(response)) {
    // TypeScript knows response is StandardActionResponse
    console.log(response.metadata.actionName);
}

// Validation function
if (validateActionResponse(response)) {
    console.log("Response is valid");
} else {
    console.error("Response does not conform to schema");
}
```

## Benefits

1. **Consistency**: All actions return data in the same format
2. **Type Safety**: TypeScript types ensure correct usage
3. **Frontend Compatibility**: Frontend can reliably parse and display all action responses
4. **Debugging**: Standardized format makes debugging easier
5. **Extensibility**: Easy to add new fields without breaking existing code

## Migration Guide

If you have existing actions that don't follow this schema:

1. Import the helper functions: `import { createActionResponse } from "@elizaos/core"`
2. Replace manual callback construction with `createActionResponse()`
3. Ensure all required metadata fields are included
4. Test that frontend still displays responses correctly

## Type Definitions

All types are exported from `@elizaos/core`:

- `ActionResponseMetadata` - Metadata schema
- `ActionResponseContent` - Content schema
- `StandardActionResponse` - Complete response schema
- `createActionResponse()` - Helper function
- `createActionErrorResponse()` - Error helper function
- `validateActionResponse()` - Validation function
- `isStandardActionResponse()` - Type guard
