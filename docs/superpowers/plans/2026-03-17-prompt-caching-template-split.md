# Prompt Caching Template Split Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split LLM prompt templates into static/dynamic parts so OpenAI automatically caches the static prefix, cutting input token costs by 50%.

**Architecture:** Add a `Template` type (`{ system, prompt }`), a `composeContextSplit()` helper, update `generateText()` to accept `system` + `prompt` params (with `context` deprecated for backward compat), and split 5 high-impact templates.

**Tech Stack:** TypeScript, Vercel AI SDK (`ai` package), OpenAI API

---

## Chunk 1: Core Infrastructure

### Task 1: Add `Template` type to `types.ts`

**Files:**
- Modify: `packages/core/src/core/types.ts:1033-1034`

- [ ] **Step 1: Add Template interface after TemplateType**

After line 1033 (`export type TemplateType = ...`), add:

```ts
/**
 * Split template for prompt caching optimization.
 * `system` contains static instructions (cached by OpenAI as prefix).
 * `prompt` contains dynamic per-request content.
 */
export interface Template {
    system: string;
    prompt: string;
}
```

- [ ] **Step 2: Add Template to the exports**

Verify `Template` is accessible from the package. Check if `types.ts` is re-exported from the package index. If types are exported via barrel file, no extra work needed since it's already in `types.ts`.

- [ ] **Step 3: Verify build**

Run: `cd packages/core && npx tsc --noEmit`
Expected: No errors

---

### Task 2: Add `composeContextSplit()` to `context.ts`

**Files:**
- Modify: `packages/core/src/core/context.ts:60` (after `composeContext` function)

- [ ] **Step 1: Add import for Template type**

At the top of `context.ts`, update the import on line 2:

```ts
import type { State, TemplateType, Template } from "./types.ts";
```

- [ ] **Step 2: Add composeContextSplit function after composeContext (after line 60)**

```ts
/**
 * Composes a split context by replacing placeholders in both system and prompt parts of a Template.
 * Used with the Template type for prompt caching optimization.
 *
 * @param params.state - The state object containing values to replace placeholders.
 * @param params.template - A Template with system (static) and prompt (dynamic) parts.
 * @returns An object with composed system and prompt strings.
 */
export const composeContextSplit = ({
    state,
    template,
}: {
    state: State;
    template: Template;
}): { system: string; prompt: string } => {
    const replace = (str: string) =>
        str.replace(/{{\w+}}/g, (match) => {
            const key = match.replace(/{{|}}/g, "");
            return state[key] ?? "";
        });
    return {
        system: replace(template.system),
        prompt: replace(template.prompt),
    };
};
```

- [ ] **Step 3: Verify build**

Run: `cd packages/core && npx tsc --noEmit`
Expected: No errors

---

### Task 3: Update `generateText()` signature in `generation.ts`

**Files:**
- Modify: `packages/core/src/ai/generation.ts:592-633`

- [ ] **Step 1: Add `system` and `prompt` params to function signature**

At line 592, update the destructured params and type annotation. Add `system` and `prompt` as new params. Keep `context` and `customSystemPrompt` as deprecated:

```ts
export async function generateText({
    runtime,
    system,
    prompt,
    context,
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
}: {
    runtime: IAgentRuntime;
    /** Static template instructions — cached by OpenAI as prefix */
    system?: string;
    /** Dynamic per-request content */
    prompt?: string;
    /** @deprecated Use system + prompt instead */
    context?: string;
    modelClass: ModelClass;
    tools?: Record<string, Tool>;
    onStepFinish?: (event: StepResult) => Promise<void> | void;
    onToken?: (delta: string) => Promise<void> | void;
    maxSteps?: number;
    stop?: string[];
    /** @deprecated Prepend to system instead */
    customSystemPrompt?: string;
    imageAttachments?: Array<{ type: string; data: string; mimeType: string }>;
    userId?: string;
    bypassModelClassDowngrades?: boolean;
}): Promise<string> {
```

- [ ] **Step 2: Add finalSystem/finalPrompt resolution and re-alias context (after line 628)**

Replace the existing `if (!context)` guard at line 630 with:

```ts
    // Resolve system/prompt from new params or legacy context
    const finalSystem = customSystemPrompt
        ? [customSystemPrompt, system].filter(Boolean).join("\n\n")
        : (system ?? "");
    const finalPrompt = prompt ?? context ?? "";

    if (!finalPrompt) {
        console.error("generateText prompt is empty");
        return "";
    }

    // Re-alias so all provider blocks below continue to work unchanged
    // (they reference `context` for prompt text and `calculateTokenCount(context, model)`)
    // Only the `system:` parameter in each provider's aiGenerateText call needs updating.
    const context = finalPrompt;
```

**Important**: This `const context = finalPrompt` re-alias means all existing provider code that uses `prompt: context` and `calculateTokenCount(context, model)` continues working without modification. We only need to update the `system:` parameter in each provider.

**Behavioral note**: Previously, `customSystemPrompt` (used only by the OpenAI provider) completely *replaced* `runtime.character.system` via `customSystemPrompt ?? runtime.character.system`. Now it gets *prepended* to `system` and then combined with `runtime.character.system`. Only `jsonValidation.ts` uses this param — the combined behavior is equivalent or better for that use case.

- [ ] **Step 3: Update system prompt in OpenAI provider block (line ~920)**

Find the `aiGenerateText` call. Change only the `system:` line:
- `system: customSystemPrompt ?? runtime.character.system ?? settings.SYSTEM_PROMPT ?? undefined,`
- → `system: [runtime.character.system ?? settings.SYSTEM_PROMPT, finalSystem].filter(Boolean).join("\n\n") || undefined,`

The `prompt: context,` line stays unchanged (the re-aliased `context` variable already points to `finalPrompt`).

- [ ] **Step 4: Update system prompt in Google provider block (line ~995)**

Change only the system prompt construction:
- Line 1010: `const systemPrompt = runtime.character.system ?? settings.SYSTEM_PROMPT;`
- → `const systemPrompt = [runtime.character.system ?? settings.SYSTEM_PROMPT, finalSystem].filter(Boolean).join("\n\n");`

The `text: context` in `userContent` stays unchanged (re-aliased `context` works).

- [ ] **Step 5: Update system prompt in Anthropic provider block (line ~1142)**

Change only the `system:` line:
- `system: runtime.character.system ?? settings.SYSTEM_PROMPT ?? undefined,`
- → `system: [runtime.character.system ?? settings.SYSTEM_PROMPT, finalSystem].filter(Boolean).join("\n\n") || undefined,`

- [ ] **Step 6: Update system prompt in Claude Vertex provider block (line ~1195)**

Same pattern as Anthropic — update only the `system:` line.

- [ ] **Step 7: Update system prompt in ALL remaining provider blocks**

Update the `system:` line in every remaining provider block that calls `aiGenerateText`. Complete list:

| Provider | ~Line | Current system | Action |
|----------|-------|---------------|--------|
| ETERNALAI | ~977 | `runtime.character.system ?? settings.SYSTEM_PROMPT` | Add `finalSystem` |
| MEM0 | ~1281 | `runtime.character.system ?? settings.SYSTEM_PROMPT` | Add `finalSystem` |
| GROQ | ~1343 | `runtime.character.system ?? settings.SYSTEM_PROMPT` | Add `finalSystem` |
| REDPILL | ~1402 | similar pattern | Add `finalSystem` |
| OPENROUTER | ~1449 | similar pattern | Add `finalSystem` |
| OLLAMA | ~1522 | **No system param** | Add `system: [runtime.character.system ?? settings.SYSTEM_PROMPT, finalSystem].filter(Boolean).join("\n\n") || undefined,` |
| HEURIST | ~1544 | similar pattern | Add `finalSystem` |
| GALADRIEL | ~1591 | similar pattern | Add `finalSystem` |
| MISTRAL | ~1637 | similar pattern | Add `finalSystem` |
| GROK | ~1682 | similar pattern | Add `finalSystem` |
| GAIANET | ~1731 | similar pattern | Add `finalSystem` |
| LIVEPEER | ~1778 | similar pattern | Add `finalSystem` |
| DEEPSEEK | ~1848 | similar pattern | Add `finalSystem` |
| BEDROCK | ~1894 | similar pattern | Add `finalSystem` |

For each: `system: [runtime.character.system ?? settings.SYSTEM_PROMPT, finalSystem].filter(Boolean).join("\n\n") || undefined,`

**Special case — LLAMALOCAL (~1362)**: Uses `textGenerationService.queueTextCompletion(context, ...)` not `aiGenerateText`. No `system:` param exists. Leave unchanged — the re-aliased `context` already works.

- [ ] **Step 8: Leave wrapper functions unchanged**

`generateTextArray` (line ~2247), `generateObjectDeprecated`, `generateObjectArray`, and other wrappers have their own `context` param — out of scope. They use the legacy `context` path.

- [ ] **Step 9: Verify build**

Run: `cd packages/core && npx tsc --noEmit`
Expected: No errors. All existing callers still pass `context` which resolves via `finalPrompt = prompt ?? context ?? ""`.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/core/types.ts packages/core/src/core/context.ts packages/core/src/ai/generation.ts
git commit -m "feat: add Template type and system/prompt split to generateText for OpenAI prompt caching"
```

---

## Chunk 2: Split Templates

**Note on content reordering**: The original templates interleave static instructions with dynamic placeholders (e.g., `{{currentDate}}` appears before the data retention section). The split moves ALL dynamic content to `prompt` (after `system`). This changes the order the LLM sees content — static instructions first, then all dynamic data. This is intentional and aligns with how OpenAI's prefix caching works. The smoke test in Chunk 4 verifies that outputs remain equivalent.

### Task 4: Split `regularMessageTemplate`

**Files:**
- Modify: `packages/core/src/templates/regularMessageTemplate.ts` (full file, 176 lines)

- [ ] **Step 1: Rewrite `getRegularMessageTemplate()` to return `Template`**

Add import and change return type:

```ts
import type { Template } from "../core/types.ts";

export function getRegularMessageTemplate(): Template {
    return {
        system: `You are an AI assistant that can help with various topics and conversations.

## Data retention by plan (for date-range actions)
Different subscription tiers allow different time windows for historical data. When choosing "from"/"to" for actions, stay within the current user's limit:
- **Free**: last 3 months (90 days)
- **Plus**: last 6 months (180 days)
- **Pro**: last 24 months (730 days)
- **Enterprise**: no limit
- **Anonymous**: only data between 1 and 3 months ago (30–90 days ago)

## Response Instructions

Analyze the user's message to determine the appropriate response:

**CRITICAL RULE**:
- If you can answer the user's request based on the recent conversation and the action results, use Option B.
- Else, if you need to gather more information so you can answer the user's request, use Option A.
- If user's request is related to crypto or something that has high time sensitivity, you can use Option A to gather the newest information.

Option A: Call an action
**For WEB_SEARCH:** pass the user's search intent as \`query\`

**For actions requiring date/time ranges:**
- Use "from" and "to" only. Format: date only \`YYYY-MM-DD\`, or with hour \`YYYY-MM-DDTHH:mm\` (e.g. \`2025-01-15T14:00\`). For relative ranges like "last 30 days", compute from/to from current date; for hour-level needs (e.g. "last 6 hours") use hour precision.
- Example date: "from": "2025-08-10", "to": "2025-09-15"
- Example with hour: "from": "2025-01-15T00:00", "to": "2025-01-15T23:00"

If no action is needed, use Option B directly.

Output JSON action call in this exact format and always include the action and parameters, no other text:
\`\`\`json
{
  "action": "ACTION_NAME",
  "parameters": {
    "symbol": "CRYPTO_SYMBOL",
    "target": "TARGET_VALUE",
    "query": "search_query",
    "from": "YYYY-MM-DD or YYYY-MM-DDTHH:mm",
    "to": "YYYY-MM-DD or YYYY-MM-DDTHH:mm"
  }
}
\`\`\`

### Option B: Provide final response
Use this option when you can answer the user's request.

Output final response in this exact JSON format:
\`\`\`json
{
  "response": "Your markdown-formatted response here"
}
\`\`\`

Response content guidelines:
- Be helpful, friendly, and engaging
- Answer questions focused on current user's request
- Use ALL action results when available to provide comprehensive information
- Synthesize all gathered data into a complete response
- For greetings, respond warmly and ask how you can help
- For casual chat, engage naturally in the conversation
- Never show file paths in your response

**CRITICAL: When using WEB_SEARCH results:**
- ALWAYS include source citations at the end of your response
- Format sources as a "Sources" or "References" section with numbered links
- Each source should include the title and clickable URL in markdown format: [Title](URL)
- Example format:

  **Sources:**
  1. [Article Title](https://example.com/article)
  2. [Another Source](https://example.com/source)

- This applies to ALL responses that incorporate web search data

**IMPORTANT MARKDOWN FORMATTING REQUIREMENTS:**
- Format your response using proper markdown syntax
- Use headers (# ## ###) for structure and organization
- Use **bold** and *italic* text for emphasis where appropriate
- Use bullet points (-) or numbered lists (1.) for organized information
- Use tables (| header |) for structured data presentation
- Use code blocks (\`\`\`) for technical content if relevant
- Use > blockquotes for important highlights or key insights
- Ensure the response renders beautifully in a markdown viewer
- Structure your content logically with clear sections when providing detailed information`,

        prompt: `Current Date: {{currentDate}}

{{userTraits}}

Recent conversation:
{{recentMessages}}

## User's Request
{{userMessage}}

**Current user:** {{dataRetentionInfo}}

## Available Actions
{{availableActions}}

## Action Results for response generation
{{actionResults}}`
    };
}
```

- [ ] **Step 2: Rewrite `getFinalResponseTemplate()` to return `Template`**

```ts
export function getFinalResponseTemplate(): Template {
    return {
        system: `You are an AI assistant that can help with various topics and conversations.

## Final Response Instructions

Provide a response based on all the information gathered.

Output your response in this exact JSON format:
\`\`\`json
{
  "response": "Your markdown-formatted response here"
}
\`\`\`

Response content guidelines:
- Be helpful, friendly, and engaging
- Answer questions focused on current user's request
- Use ALL action results to provide comprehensive information
- Synthesize all gathered data into a complete response
- Never show file paths in your response

**CRITICAL: When using WEB_SEARCH results:**
- ALWAYS include source citations at the end of your response
- Format sources as a "Sources" or "References" section with numbered links
- Each source should include the title and clickable URL in markdown format: [Title](URL)
- Example format:

  **Sources:**
  1. [Article Title](https://example.com/article)
  2. [Another Source](https://example.com/source)

- This applies to ALL responses that incorporate web search data

**IMPORTANT MARKDOWN FORMATTING REQUIREMENTS:**
- Format your response using proper markdown syntax
- Use headers (# ## ###) for structure and organization
- Use **bold** and *italic* text for emphasis where appropriate
- Use bullet points (-) or numbered lists (1.) for organized information
- Use tables (| header |) for structured data presentation
- Use code blocks (\`\`\`) for technical content if relevant
- Use > blockquotes for important highlights or key insights
- Ensure the response renders beautifully in a markdown viewer
- Structure your content logically with clear sections when providing detailed information`,

        prompt: `Current Date: {{currentDate}}

{{userTraits}}

Recent conversation:
{{recentMessages}}

## User's Request
{{userMessage}}

## Previous Action Results
The following actions have been executed to help answer the user's request:
{{actionResults}}`
    };
}
```

- [ ] **Step 3: Verify build**

Run: `cd packages/core && npx tsc --noEmit`
Expected: Errors in `regularMessageHandler.ts` (expected — handler still uses old API). Templates compile fine.

---

### Task 5: Split `taskChainPlanningTemplates`

**Files:**
- Modify: `packages/core/src/templates/taskChainPlanningTemplates.ts` (full file, 206 lines)

- [ ] **Step 1: Rewrite `getTaskChainPlanningTemplate()` to return `Template`**

Add import. Move all static instructions (role, principles, JSON schema, 3 examples, notes) into `system`. Move dynamic variables into `prompt`:

```ts
import type { Template } from "../core/types.ts";

export function getTaskChainPlanningTemplate(): Template {
    return {
        system: `# Task Chain Planning

You are an expert AI task planner. Analyze the user request and create a task chain that describes what needs to be accomplished.

## INSTRUCTIONS

Create a task chain that breaks down the user request into logical functional requirements. Focus purely on WHAT needs to be done:

**Key Principles**:
- Think in two passes: first reason about the goal, constraints, and environment; then translate that reasoning into tasks
- Surface prerequisite conditions explicitly (data availability, permissions, context gathering, tool readiness) and include validation/preparation tasks when needed
- Reflect on environment conditions such as available actions, connectivity expectations, freshness of data, and time sensitivity; add mitigation tasks if assumptions might fail
- Describe functional requirements, not implementation details
- Focus on the logical flow of information and dependencies
- Don't specify whether to use actions or LLM - the executor will decide
- Each task should represent a clear, specific objective
- Dependencies should reflect information flow between tasks
- Include relevant asset names when they are part of the user's request

## Response Format

\`\`\`json
{
  "chain_name": "Brief name for this task chain",
  "chain_description": "What this chain accomplishes overall",
  "tasks": [
    {
      "id": "unique-task-id",
      "name": "Task Name (include crypto asset if relevant)",
      "description": "Clear description of what needs to be accomplished (include specific crypto names if relevant to the request)",
      "dependencies": ["id-of-prerequisite-task"]
    }
  ]
}
\`\`\`

## Examples

### Example 1: Data Analysis Request
For request: "Analyze Bitcoin price and predict its trend"

\`\`\`json
{
  "chain_name": "Bitcoin Analysis & Prediction",
  "chain_description": "Comprehensive Bitcoin market analysis with trend prediction",
  "tasks": [
    {
      "id": "get-btc-data",
      "name": "Obtain Bitcoin Market Data",
      "description": "Collect current Bitcoin (BTC) price, market metrics, and relevant Bitcoin market data",
      "dependencies": []
    },
    {
      "id": "analyze-bitcoin-data",
      "name": "Analyze Bitcoin Market Patterns",
      "description": "Identify trends, patterns, and key indicators from the Bitcoin market data",
      "dependencies": ["get-btc-data"]
    },
    {
      "id": "predict-bitcoin-trend",
      "name": "Generate Bitcoin Trend Prediction",
      "description": "Based on Bitcoin analysis, predict Bitcoin's future price trend and potential direction",
      "dependencies": ["analyze-bitcoin-data"]
    }
  ]
}
\`\`\`

### Example 2: Multi-Asset Comparison
For request: "Compare Bitcoin and Ethereum performance"

\`\`\`json
{
  "chain_name": "BTC vs ETH Performance Comparison",
  "chain_description": "Comparative analysis of Bitcoin and Ethereum market performance",
  "tasks": [
    {
      "id": "get-btc-performance",
      "name": "Obtain Bitcoin Performance Data",
      "description": "Collect Bitcoin (BTC) price data, volume, and Bitcoin performance metrics",
      "dependencies": []
    },
    {
      "id": "get-eth-performance",
      "name": "Obtain Ethereum Performance Data",
      "description": "Collect Ethereum (ETH) price data, volume, and Ethereum performance metrics",
      "dependencies": []
    },
    {
      "id": "compare-btc-eth",
      "name": "Compare Bitcoin vs Ethereum Performance",
      "description": "Analyze and compare the performance metrics between Bitcoin and Ethereum",
      "dependencies": ["get-btc-performance", "get-eth-performance"]
    }
  ]
}
\`\`\`

### Example 3: Research and Chart Generation
For request: "Research Solana news and create a price chart"

\`\`\`json
{
  "chain_name": "Solana Research & Visualization",
  "chain_description": "Research latest Solana developments and create Solana price visualization",
  "tasks": [
    {
      "id": "research-solana-news",
      "name": "Research Solana Market News",
      "description": "Gather recent news, developments, and market updates specifically related to Solana (SOL)",
      "dependencies": []
    },
    {
      "id": "create-solana-chart",
      "name": "Generate Solana Price Chart",
      "description": "Create a visual price chart for Solana showing recent Solana price movements",
      "dependencies": []
    },
    {
      "id": "synthesize-solana-insights",
      "name": "Synthesize Solana Market Insights",
      "description": "Combine Solana news research with Solana price chart analysis to provide comprehensive Solana insights",
      "dependencies": ["research-solana-news", "create-solana-chart"]
    }
  ]
}
\`\`\`

**IMPORTANT**: When the user request involves specific cryptocurrencies, include those asset names (Bitcoin, Ethereum, Solana, etc.) in relevant task names and descriptions. This helps the task executor identify which crypto assets to work with when selecting actions.

Generate a functional task chain for the user request.`,

        prompt: `## Context
Current Date: {{currentDate}}
User Request: "{{userRequest}}"

## Additional Context for Supplementary Information
User's previous queries (From oldest to newest):
{{lastFiveQueries}}

## Learned Task Chain Patterns

The following patterns have been learned from previous user feedback. Consider these guidelines when planning your task chain, but use your judgment - don't follow them blindly if they don't apply to this specific request:

{{learnedRules}}

## Available Actions
The following actions are available for task execution:
{{availableActions}}`
    };
}
```

- [ ] **Step 2: Rewrite `getFavoriteChainUpdateTemplate()` to return `Template`**

```ts
export function getFavoriteChainUpdateTemplate(): Template {
    return {
        system: `# Favorite Task Chain Personalization

## Instructions
- Preserve the tasks in the same order and keep their IDs and dependencies unchanged.
- You may revise each task's "name" and "description" to better match the new request and context.
- You may also refine the overall chain "chain_name" and "chain_description" to reflect the updated purpose.
- Do not add or remove tasks.
- Ensure every task remains aligned with its original responsibility while incorporating the new user query and current date.

## Response Format

Return the complete task chain structure with updated names and descriptions using the following schema:

\`\`\`json
{
  "chain_name": "Updated chain name",
  "chain_description": "Updated chain description",
  "tasks": [
    {
      "id": "task-id",
      "name": "Updated task name",
      "description": "Updated task description",
      "dependencies": ["preceding-task-id"]
    }
  ]
}
\`\`\`

Only include the fields shown above.`,

        prompt: `Current Date: {{currentDate}}
User Request: "{{userRequest}}"

## Saved Task Chain
The user attached the following favorite task chain:

\`\`\`json
{{favoriteChainJson}}
\`\`\``
    };
}
```

- [ ] **Step 3: Verify build**

Run: `cd packages/core && npx tsc --noEmit`
Expected: Errors in `taskChainPlanner.ts` (expected). Templates compile.

---

### Task 6: Split `taskChainExecutorTemplate`

**Files:**
- Modify: `packages/core/src/templates/taskChainExecutorTemplate.ts:52-159` (the `getTaskChainActionTemplate` function)

- [ ] **Step 1: Rewrite `getTaskChainActionTemplate()` to return `Template`**

Add import. `LLM_TASK_FORMATTING_REQUIREMENTS` and `getLLMTaskTemplateGenerationPrompt` stay unchanged (they are not `Template` types). Only `getTaskChainActionTemplate` changes:

```ts
import type { Template } from "../core/types.ts";
```

Move all static instructions into `system`, dynamic task-specific data into `prompt`:

```ts
export function getTaskChainActionTemplate(): Template {
    return {
        system: `You are selecting the best approach for a specific task in the task chain.

## Data retention by plan (for date-range actions)
Different subscription tiers allow different time windows for historical data. When choosing "from"/"to" for actions, stay within the current user's limit:
- **Free**: last 3 months (90 days)
- **Plus**: last 6 months (180 days)
- **Pro**: last 24 months (730 days)
- **Enterprise**: no limit
- **Anonymous**: only data between 1 and 3 months ago (30–90 days ago)

# Decision Process

**Step 1: Review what's already available**
- Check completed dependency tasks above
- Proceed with actions if you need NEW information not present in dependency outputs, or the previous data is insufficient for the task
- Identify what data/results are already collected
- Don't repeat actions with identical parameters

**Step 2: Choose approach for THIS task**
- **Actions**: If you need to collect new data, perform calculations, or generate charts
- **LLM**: If you need to analyze, synthesize, or reason about existing data, or the previous data is sufficient for the task

**Step 3: Extract specifics from task description**
- Identify cryptocurrency symbols (BTC, ETH, etc.)
- **For date/time ranges:** use "from" and "to" only. Format: \`YYYY-MM-DD\` or \`YYYY-MM-DDTHH:mm\` for hour precision. For "last N days" compute from/to; for hour-level needs use hour.
- **For WEB_SEARCH actions:** pass the user's search intent as \`query\`;
- **ONLY use these parameters**: symbol, query (for web_search), from, to (for date/time ranges)
- Create separate actions for each cryptocurrency mentioned

# Response Format

## If Actions Needed
\`\`\`json
{
  "task_type": "action",
  "selected_actions": [
    {
      "action": "action_name",
      "parameters": {
        "symbol": "CRYPTO_SYMBOL",
        "from": "YYYY-MM-DD or YYYY-MM-DDTHH:mm",
        "to": "YYYY-MM-DD or YYYY-MM-DDTHH:mm"
      }
    }
  ],
  "description": "Why these actions fulfill this specific task"
}
\`\`\`

## If Analysis Needed
\`\`\`json
{
  "task_type": "llm",
  "selected_actions": [],
  "description": "What analysis this LLM task will perform"
}
\`\`\`

# Key Rules
- **One symbol per action**: Never combine BTC, ETH, etc. in single action
- **Check dependencies**: Don't duplicate what's already done
- **Focus on THIS task**: Select approach that directly fulfills current task description
- **Use existing data**: If dependencies have sufficient data, choose LLM analysis

# Example: Different Actions for Different Cryptos
**Task: "Get Bitcoin news and plot the chart of Ethereum price for the last 50 days"**
\`\`\`json
{
  "task_type": "action",
  "selected_actions": [
    {
      "action": "getnews",
      "parameters": {
        "symbol": "BTC"
      }
    },
    {
      "action": "plot_charts",
      "parameters": {
        "symbol": "ETH",
        "from": "2025-01-01",
        "to": "2025-02-20"
      }
    }
  ],
  "description": "Using different actions for different cryptocurrencies - getnews for BTC and plot_charts for ETH (50 days as from/to)"
}
\`\`\``,

        prompt: `# Current Task: {{taskName}}

## Current Time
{{currentTime}}

## This Task
**Description**: {{taskDescription}}

## What's Already Done
{{dependencyTasks}}

**Current user:** {{dataRetentionInfo}}

## Available Actions
{{availableActions}}

Select the optimal approach for: {{taskName}}`
    };
}
```

- [ ] **Step 2: Verify build**

Run: `cd packages/core && npx tsc --noEmit`
Expected: Errors in `taskExecutor.ts` (expected). Template compiles.

---

### Task 7: Split `comprehensive_analysis_prompt_template`

**Files:**
- Modify: `packages/core/src/templates/comprehensive_analysis_prompt_template.ts` (full file, 369 lines)

- [ ] **Step 1: Convert `comprehensive_analysis` from string to `Template`**

Add import. The entire existing string becomes `system`. The `prompt` is intentionally minimal — the handler (`comprehensiveAnalysisWorkflowGraph.ts`) builds the full dynamic prompt by concatenating `formattedResults`, `userTraitsSection`, and focus area instructions manually (see Task 12, Step 3). The `prompt` field here is just a placeholder that gets replaced entirely by the handler.

```ts
import type { Template } from "../core/types.ts";

const comprehensive_analysis: Template = {
    system: `# Comprehensive Cryptocurrency Analysis Prompt Template
... (the entire existing template string content, unchanged) ...
`,
    prompt: ``
};

export { comprehensive_analysis };
```

The `system` field contains the full 360-line template as-is. The `prompt` field is empty — the handler constructs the full dynamic prompt and passes it directly to `generateText()`. This is intentional because the handler does complex string building (action results, user traits, focus areas) that doesn't fit the `{{placeholder}}` pattern.

- [ ] **Step 2: Verify build**

Run: `cd packages/core && npx tsc --noEmit`
Expected: Errors in `comprehensiveAnalysisWorkflowGraph.ts` (expected — it accesses `comprehensive_analysis` as a string). Template compiles.

---

### Task 8: Split `comprehensive_analysis_actions`

**Files:**
- Modify: `packages/core/src/templates/comprehensive_analysis_actions.ts` (full file, 128 lines)

- [ ] **Step 1: Rewrite `getComprehensiveAnalysisActionsTemplate()` to return `Template`**

Add import. Move static instructions/examples to `system`, dynamic variables to `prompt`:

```ts
import type { Template } from "../core/types.ts";

export function getComprehensiveAnalysisActionsTemplate(): Template {
    return {
        system: `# Task: Extract Target and Parameters for Comprehensive Analysis

You are a crypto analysis parameter extraction agent. Your job is to analyze the user's request and extract the target cryptocurrency and appropriate parameters for comprehensive analysis.

## Data retention by plan (for date range)
Different subscription tiers allow different time windows for historical data. When choosing "from"/"to", stay within the current user's limit:
- **Free**: last 3 months (90 days)
- **Plus**: last 6 months (180 days)
- **Pro**: last 24 months (730 days)
- **Enterprise**: no limit
- **Anonymous**: only data between 1 and 3 months ago (30–90 days ago)

**Response Format:**
\`\`\`json
{
  "target": "CRYPTO_SYMBOL",
  "parameters": {
    "symbol": "CRYPTO_SYMBOL",
    "cryptoName": "Full Cryptocurrency Name",
    "query": "search_query_for_news_and_research",
    "from": "YYYY-MM-DD or YYYY-MM-DDTHH:mm",
    "to": "YYYY-MM-DD or YYYY-MM-DDTHH:mm"
  }
}
\`\`\`

**Parameter Extraction Rules:**

1. **Target & Symbol**: Extract the main cryptocurrency from the user query
   - Look for: BTC, Bitcoin, ETH, Ethereum, ADA, Cardano, SOL, Solana, etc.
   - Default to "BTC" if none specified

2. **Crypto Name**: Full name of the cryptocurrency
   - BTC → Bitcoin
   - ETH → Ethereum
   - ADA → Cardano
   - SOL → Solana
   - etc.

3. **Date/time range (from / to only)**: Extract from user query
   - Format: date only \`YYYY-MM-DD\`, or with hour \`YYYY-MM-DDTHH:mm\` (e.g. \`2025-01-15T14:00\`)
   - For specific ranges: set "from" and "to"; use hour when user asks for hour-level range (e.g. "last 6 hours")
   - For relative ("last 7 days", "30 days"): compute from/to from current date
   - **Always keep from/to within the current user's data retention limit** (see "Current user" above)
   - Default to last 30 days if none specified

4. **Query**: Create search query for news and research
   - Format: "{symbol} {cryptoName} {additional_context}"
   - Include relevant keywords from user request

**Examples:**

User: "Give me a comprehensive analysis of Bitcoin for the last 2 weeks"
Response (compute from/to from current date):
\`\`\`json
{
  "target": "BTC",
  "parameters": {
    "symbol": "BTC",
    "cryptoName": "Bitcoin",
    "query": "BTC Bitcoin analysis",
    "from": "2025-01-15",
    "to": "2025-01-29"
  }
}
\`\`\`

User: "I want to understand Ethereum's current market situation"
Response:
\`\`\`json
{
  "target": "ETH",
  "parameters": {
    "symbol": "ETH",
    "cryptoName": "Ethereum",
    "query": "ETH Ethereum market situation",
    "from": "2024-12-30",
    "to": "2025-01-29"
  }
}
\`\`\`

User: "Analyze Solana performance over 3 months"
Response:
\`\`\`json
{
  "target": "SOL",
  "parameters": {
    "symbol": "SOL",
    "cryptoName": "Solana",
    "query": "SOL Solana performance analysis",
    "from": "2024-10-29",
    "to": "2025-01-29"
  }
}
\`\`\`

User: "Analyze Bitcoin from 2025-08-10 to 2025-09-15"
Response:
\`\`\`json
{
  "target": "BTC",
  "parameters": {
    "symbol": "BTC",
    "cryptoName": "Bitcoin",
    "query": "BTC Bitcoin analysis",
    "from": "2025-08-10",
    "to": "2025-09-15"
  }
}
\`\`\``,

        prompt: `# Current Date and Time
Today is {{currentDate}} (timestamp: {{currentTimestamp}})

# Latest User Query
{{latestQuery}}

**Current user:** {{dataRetentionInfo}}

Now extract the target and parameters from the user query:`
    };
}
```

- [ ] **Step 2: Verify build**

Run: `cd packages/core && npx tsc --noEmit`
Expected: Errors in `comprehensiveAnalysisWorkflowGraph.ts` (expected). Template compiles.

- [ ] **Step 3: Commit all template splits**

```bash
git add packages/core/src/templates/regularMessageTemplate.ts packages/core/src/templates/taskChainPlanningTemplates.ts packages/core/src/templates/taskChainExecutorTemplate.ts packages/core/src/templates/comprehensive_analysis_prompt_template.ts packages/core/src/templates/comprehensive_analysis_actions.ts
git commit -m "feat: split 5 templates into system/prompt for prompt caching"
```

---

## Chunk 3: Handler Migration

### Task 9: Migrate `regularMessageHandler.ts`

**Files:**
- Modify: `packages/core/src/handlers/regularMessageHandler.ts:280-417`

- [ ] **Step 1: Update imports**

Add `composeContextSplit` import and remove `composeContext` import (only used once at line 285 in this file — confirmed by grep):

```ts
import { composeContextSplit } from "../core/context.ts";
```

- [ ] **Step 2: Update composeContext call at line ~285**

Change:
```ts
const context = composeContext({
    state,
    template: iteration >= maxIterations ? getFinalResponseTemplate() : getRegularMessageTemplate(),
});
```

To:
```ts
const template = iteration >= maxIterations ? getFinalResponseTemplate() : getRegularMessageTemplate();
const { system, prompt } = composeContextSplit({ state, template });
```

- [ ] **Step 3: Update generateText call at line ~382**

Change `context,` to `system, prompt,`:

```ts
const response = await generateText({
    runtime,
    system,
    prompt,
    modelClass: ModelClass.MEDIUM,
    // ... rest of params unchanged
});
```

- [ ] **Step 4: Verify build**

Run: `cd packages/core && npx tsc --noEmit`
Expected: No errors for this handler.

---

### Task 10: Migrate `taskChainPlanner.ts`

**Files:**
- Modify: `packages/core/src/tasks/taskChainPlanner.ts:293-408`

- [ ] **Step 1: Update imports**

Add `composeContextSplit` import. Remove `composeContext` if no longer used.

- [ ] **Step 2: Update favorite chain update call (line ~293)**

The actual code constructs state inline. Change:
```ts
const updateContext = composeContext({
    state: {
        ...state.context,
        currentDate,
        userRequest: userQuery,
        favoriteChainJson,
        originalChainName: baseChainData.chain_name,
        originalChainDescription: baseChainData.chain_description
    } as State,
    template: getFavoriteChainUpdateTemplate()
});
```

To:
```ts
const updateTemplate = getFavoriteChainUpdateTemplate();
const updateState = {
    ...state.context,
    currentDate,
    userRequest: userQuery,
    favoriteChainJson,
    originalChainName: baseChainData.chain_name,
    originalChainDescription: baseChainData.chain_description
} as State;
const { system: updateSystem, prompt: updatePrompt } = composeContextSplit({ state: updateState, template: updateTemplate });
```

Update the `generateText` call (line ~305) and the return's `planningContext` (line ~316):
```ts
const llmResponse = await generateText({
    runtime,
    system: updateSystem,
    prompt: updatePrompt,
    modelClass: ModelClass.MEDIUM,
});
```

The return at line ~316 sets `planningContext: updateContext`. Since `planningContext` is a state annotation (`Annotation<string>()`) and may be read downstream, preserve it as a combined string:
```ts
return {
    planningContext: [updateSystem, updatePrompt].join("\n\n"),
    llmResponse,
    // ... rest unchanged
};
```

- [ ] **Step 3: Update planning call (line ~391)**

The actual code constructs state inline. Change:
```ts
const planningContext = composeContext({
    state: {
        ...state.context,
        userRequest: enhancedUserRequest,
        lastFiveQueries: state.lastFiveQueries,
        currentDate: state.currentDate,
        availableActions: formatActionsForTemplate(state.availableActions || []),
        learnedRules: learnedRulesText
    },
    template: getTaskChainPlanningTemplate(),
});
```

To:
```ts
const planningTemplate = getTaskChainPlanningTemplate();
const planState = {
    ...state.context,
    userRequest: enhancedUserRequest,
    lastFiveQueries: state.lastFiveQueries,
    currentDate: state.currentDate,
    availableActions: formatActionsForTemplate(state.availableActions || []),
    learnedRules: learnedRulesText
};
const { system: planSystem, prompt: planPrompt } = composeContextSplit({ state: planState, template: planningTemplate });
```

Update `generateText` call (line ~404):
```ts
const response = await generateText({
    runtime: getThreadRuntime(state.threadId!),
    system: planSystem,
    prompt: planPrompt,
    modelClass: ModelClass.MEDIUM,
});
```

Preserve `planningContext` in the return (line ~413):
```ts
return {
    planningContext: [planSystem, planPrompt].join("\n\n"),
    llmResponse: response,
    phase: 'parsing'
};
```

- [ ] **Step 4: Verify build**

Run: `cd packages/core && npx tsc --noEmit`
Expected: No errors.

---

### Task 11: Migrate `taskExecutor.ts`

**Files:**
- Modify: `packages/core/src/tasks/taskExecutor.ts:206-221`

- [ ] **Step 1: Update imports**

Add `composeContextSplit` import.

- [ ] **Step 2: Update action selection call (line ~206)**

Change:
```ts
const selectionPrompt = composeContext({ state: executionState, template: getTaskChainActionTemplate() });
```

To:
```ts
const actionTemplate = getTaskChainActionTemplate();
const { system: actionSystem, prompt: actionPrompt } = composeContextSplit({ state: executionState, template: actionTemplate });
```

Update the corresponding `generateText` call (line ~217):
```ts
const selectionResponse = await generateText({
    runtime,
    system: actionSystem,
    prompt: actionPrompt,
    modelClass: ModelClass.LARGE,
});
```

- [ ] **Step 3: Check other generateText calls in this file**

The LLM task execution calls (line ~1043) and custom template generation (line ~1417) use dynamically generated templates (not `Template` type). These continue using the `context` legacy path — no changes needed.

- [ ] **Step 4: Verify build**

Run: `cd packages/core && npx tsc --noEmit`
Expected: No errors.

---

### Task 12: Migrate `comprehensiveAnalysisWorkflowGraph.ts`

**Files:**
- Modify: `packages/core/src/handlers/comprehensiveAnalysisWorkflowGraph.ts:252-273, 1141-1255`

- [ ] **Step 1: Update imports**

Add `composeContextSplit` import. The `comprehensive_analysis` import now returns a `Template` instead of a `string`.

- [ ] **Step 2: Update actions template call (line ~252)**

The actual code does manual `.replace()` on the template string (not `composeContext` with state). Now that the template returns `Template`, we replace the manual substitution with direct value insertion into the prompt:

Change the block at lines 252-260:
```ts
const template = getComprehensiveAnalysisActionsTemplate();
const context = composeContext({
    state: state.state || { agentId: state.runtime.agentId } as State,
    template: template
        .replace('{{currentDate}}', new Date().toLocaleDateString())
        .replace('{{currentTimestamp}}', Date.now().toString())
        .replace('{{latestQuery}}', state.message.content.text || '')
        .replace('{{dataRetentionInfo}}', dataRetentionInfo)
});
```

To:
```ts
const actionsTemplate = getComprehensiveAnalysisActionsTemplate();
const actionsSystem = actionsTemplate.system
    .replace('{{dataRetentionInfo}}', dataRetentionInfo);
const actionsPrompt = actionsTemplate.prompt
    .replace('{{currentDate}}', new Date().toLocaleDateString())
    .replace('{{currentTimestamp}}', Date.now().toString())
    .replace('{{latestQuery}}', state.message.content.text || '')
    .replace('{{dataRetentionInfo}}', dataRetentionInfo);
```

Update `generateText` call (line ~268):
```ts
const response = await generateText({
    runtime: state.runtime,
    system: actionsSystem,
    prompt: actionsPrompt,
    modelClass: ModelClass.SMALL,
    imageAttachments,
    userId: state.message.userId,
});
```

- [ ] **Step 3: Update comprehensive analysis template call (line ~1141)**

This is the most complex migration. The current code (lines 1141-1186) does:
1. String-replaces `[CRYPTOCURRENCY_NAME]`, `[DATE]`, `[TOKEN_SYMBOL]` in the template
2. Builds a large `analysisPrompt` concatenating: template + userTraits + formattedResults + focus instructions
3. Runs `validateAndSanitizePrompt()` on the combined string
4. Passes through `composeContext()` then to `generateText({ context })`

After migration, the template structure (360 lines) goes into `system`, and all dynamic content (action results, user traits, instructions) goes into `prompt`:

```ts
// System: static template with [PLACEHOLDER] replacements
const analysisSystem = comprehensive_analysis.system
    .replace(/\[CRYPTOCURRENCY_NAME\]/g, cryptoName)
    .replace(/\[DATE\]/g, currentDate)
    .replace(/\[TOKEN_SYMBOL\]/g, state.target);

// Prompt: all dynamic content (previously concatenated into analysisPrompt)
const userTraitsSection = state.userTraits ? `\n${state.userTraits}\n` : "";
const formattedResults = formatActionResultsForAnalysis(state.actionResults);

const dynamicPrompt = `
${userTraitsSection}
## Available Data from Analysis Actions

${formattedResults}

## Instructions
Based on the comprehensive data gathered from all the executed actions above, generate a complete comprehensive analysis following the structured template. Integrate all the available data points and provide specific, actionable insights.
${state.userTraits ? "\n**Important**: Tailor your investment recommendations and risk assessments based on the user's investment profile provided above. Consider their preferences, risk tolerance, and any cautionary notes when making recommendations.\n" : ""}
Focus Areas:
1. **Executive Summary** (300-400 words)
2. **Market Data and Current Status** with specific numbers from price data
3. **Sentiment Analysis** (500 words) using sentiment intelligence data
4. **On-Chain Data Analysis** (500 words) using whale and flow data
5. **Technical Analysis** (500 words) using technical indicators
6. **Price Predictions** (400 words) with confidence intervals
7. **Investment Recommendations** with specific allocation percentages
8. **Strategic Conclusion** (300-400 words) with clear BUY/HOLD/SELL recommendation

Generate the analysis now:
`;

// Validate and sanitize only the dynamic prompt (system is stable/trusted)
const validation = validateAndSanitizePrompt(dynamicPrompt, 40000);
const sanitizedPrompt = validation.sanitizedPrompt;
```

Update `generateText` call (line ~1194):
```ts
const analysisContent = await generateText({
    runtime: state.runtime,
    system: analysisSystem,
    prompt: sanitizedPrompt,
    modelClass: ModelClass.LARGE,
    imageAttachments,
    userId: state.message.userId,
    bypassModelClassDowngrades,
});
```

Remove the old `composeContext()` call at line ~1183 — it's no longer needed since `system` and `prompt` are passed directly.

- [ ] **Step 4: Leave fallback generateText call unchanged (line ~1245)**

The fallback at line ~1245 uses a runtime-constructed string template, not a `Template` type. It continues using the `context` legacy path — no changes needed.

- [ ] **Step 4b: Exclude `langGraphPrecheck.ts` from migration**

`langGraphPrecheck.ts` (1 call site) continues using the `context` legacy path. It uses `messageClassificationTemplate` which is out of scope.

- [ ] **Step 5: Verify build**

Run: `cd packages/core && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Commit all handler migrations**

```bash
git add packages/core/src/handlers/regularMessageHandler.ts packages/core/src/tasks/taskChainPlanner.ts packages/core/src/tasks/taskExecutor.ts packages/core/src/handlers/comprehensiveAnalysisWorkflowGraph.ts
git commit -m "feat: migrate 4 handlers to system/prompt split for prompt caching"
```

---

## Chunk 4: Verification

### Task 13: Full build and smoke test

**Files:**
- Modify (temporarily): `packages/core/src/ai/generation.ts` (cache verification log)

- [ ] **Step 1: Full monorepo build**

Run: `pnpm build`
Expected: All packages build successfully.

- [ ] **Step 2: Run existing tests**

Run: `pnpm test`
Expected: All tests pass. No regressions.

- [ ] **Step 3: Add temporary cache verification logging**

In `generation.ts`, inside the OpenAI provider's `withUsageTracking` callback, after the `aiGenerateText` call returns, add a temporary log:

```ts
// TEMPORARY: Verify prompt caching is working
const usage = (openaiResponse as any)?.usage;
if (usage?.prompt_tokens_details) {
    elizaLogger.info(`[PromptCache] cached_tokens: ${usage.prompt_tokens_details.cached_tokens ?? 0}, total_prompt: ${usage.promptTokens}`);
}
```

This will log cache hit info. On the second call with the same template type, `cached_tokens` should be > 0.

- [ ] **Step 4: Manual smoke test**

Start the agent: `pnpm start --characters="characters/Crypto_Trader.json"`
- Send a regular message → verify response works. Check logs for `[PromptCache]` output.
- Send a second regular message → check that `cached_tokens > 0` in logs (cache hit).
- Trigger a task chain → verify planning + execution works. Check cache hits on executor calls after the first task.
- Trigger comprehensive analysis → verify workflow completes.

- [ ] **Step 5: Remove temporary cache verification logging**

After confirming cache hits, remove the temporary log added in Step 3.

- [ ] **Step 6: Verify no uncommitted changes remain**

Run: `git status`
Expected: No untracked or modified files (all changes committed in previous chunk commits). If the design spec or plan files are unstaged, add them to the final commit.
