# Prompt Caching Template Split Design

## Goal

Split LLM prompt templates into static (cacheable) and dynamic parts to leverage OpenAI's automatic prompt caching. This reduces input token costs by 50% and latency by up to 80% for repeated template types.

## Background

OpenAI automatically caches prompt prefixes >= 1024 tokens. Cache hits occur when the beginning of a prompt matches a previously seen prefix. The cache persists 5-10 minutes of inactivity.

**Current problem**: All templates use `composeContext()` to merge static instructions + dynamic data into a single `prompt` string. Dynamic variables are scattered throughout, breaking prefix stability. The `system` parameter only gets `runtime.character.system` (short character description). Every request sends a unique prefix — no cache hits.

**Opportunity**: Templates are 80-95% static instructions. Moving static content into the `system` message creates a stable prefix that OpenAI caches automatically across requests of the same template type.

## Scope

**In scope** (5 high-impact templates):
- `regularMessageTemplate` (+ `getFinalResponseTemplate`)
- `taskChainPlanningTemplates` (+ `getFavoriteChainUpdateTemplate`)
- `taskChainExecutorTemplate` (+ `LLM_TASK_FORMATTING_REQUIREMENTS`)
- `comprehensive_analysis_prompt_template`
- `comprehensive_analysis_actions`

**Out of scope** (migrate later):
- `messageClassificationTemplate`
- `tradingMessageTemplate`
- `taskChainSupervisorTemplate`
- `ruleLearningTemplate`
- Plugin-level templates (content-analysis, etc.)
- Non-core callers (twitter client, plugins)

## Design

### 1. New `Template` Type

```ts
// packages/core/src/core/types.ts
interface Template {
  system: string;   // Static instructions — forms cacheable prefix
  prompt: string;   // Dynamic per-request content — appended after cached prefix
}
```

Note: The existing `TemplateType` is `string | ((options: { state: State }) => string)` — a single-string template. `Template` is the new split type with `system` + `prompt`. The names are distinct enough.

### 2. `composeContextSplit()` Function

```ts
// packages/core/src/core/context.ts
export const composeContextSplit = ({
  state,
  template,
}: {
  state: State;
  template: Template;
}): { system: string; prompt: string } => {
  return {
    system: template.system.replace(/{{\w+}}/g, (match) => {
      const key = match.replace(/{{|}}/g, "");
      return state[key] ?? "";
    }),
    prompt: template.prompt.replace(/{{\w+}}/g, (match) => {
      const key = match.replace(/{{|}}/g, "");
      return state[key] ?? "";
    }),
  };
};
```

Note: The `system` part will rarely have variables (most are fully static), but supporting replacement on both sides keeps the API uniform.

### 3. `generateText()` Signature Change

**Before:**
```ts
export async function generateText({
  runtime,
  context,
  modelClass,
  customSystemPrompt,
  tools,
  onStepFinish,
  onToken,
  maxSteps,
  stop,
  imageAttachments,
  userId,
  bypassModelClassDowngrades,
}: {
  runtime: IAgentRuntime;
  context: string;
  modelClass: ModelClass;
  customSystemPrompt?: string;
  tools?: Record<string, Tool>;
  onStepFinish?: (event: StepResult) => Promise<void> | void;
  onToken?: (delta: string) => Promise<void> | void;
  maxSteps?: number;
  stop?: string[];
  imageAttachments?: Array<{ type: string; data: string; mimeType: string }>;
  userId?: string;
  bypassModelClassDowngrades?: boolean;
})
```

**After:**
```ts
export async function generateText({
  runtime,
  system,
  prompt,
  modelClass,
  // Legacy support
  context,
  customSystemPrompt,
  // ... all other params unchanged
  tools,
  onStepFinish,
  onToken,
  maxSteps,
  stop,
  imageAttachments,
  userId,
  bypassModelClassDowngrades,
}: {
  runtime: IAgentRuntime;
  system?: string;
  prompt?: string;
  modelClass: ModelClass;
  context?: string;           // @deprecated — use system + prompt
  customSystemPrompt?: string; // @deprecated — prepend to system instead
  // ... all other params unchanged
})
```

Inside the function:
```ts
// Legacy compatibility: customSystemPrompt prepended to system if provided
const finalSystem = customSystemPrompt
  ? [customSystemPrompt, system].filter(Boolean).join("\n\n")
  : (system ?? "");
const finalPrompt = prompt ?? context ?? "";
```

**Key decisions:**
- `customSystemPrompt` is kept as `@deprecated` for backward compat. Callers like `jsonValidation.ts` that use it continue to work. It gets prepended to `system` when both are provided.
- `context` is kept as `@deprecated`. Non-migrated callers (~17 files) continue passing `context` unchanged.
- The existing `if (!context)` empty-check guard (line 630) changes to `if (!finalPrompt)`.
- Migrated callers pass `system` + `prompt` directly.

### 4. OpenAI Provider Internal Change

**Before (line ~920 of generation.ts):**
```ts
aiGenerateText({
  model: openai.languageModel(model),
  prompt: context,
  system: customSystemPrompt ?? runtime.character.system ?? settings.SYSTEM_PROMPT ?? undefined,
})
```

**After:**
```ts
aiGenerateText({
  model: openai.languageModel(model),
  prompt: finalPrompt,
  system: [
    runtime.character.system ?? settings.SYSTEM_PROMPT,
    finalSystem,
  ].filter(Boolean).join("\n\n"),
})
```

The system message becomes: `character system prompt` (stable) + `template static instructions` (stable per template type). This forms a cacheable prefix.

**Provider-specific notes:**
- **OpenAI / OpenAI-compatible providers** (OpenAI, Together, LMStudio, etc.): Use `system` and `prompt` top-level params in `aiGenerateText()`. Straightforward change.
- **Google provider**: Currently constructs a `messages` array with explicit `role: 'system'` and `role: 'user'` entries. The `system` message content changes from `runtime.character.system` to `[runtime.character.system, finalSystem].filter(Boolean).join("\n\n")`. The `user` message text changes from `context` to `finalPrompt`.
- **Anthropic provider**: Currently uses `runtime.character.system ?? settings.SYSTEM_PROMPT` directly (ignores `customSystemPrompt`). Update to use `[runtime.character.system, finalSystem].filter(Boolean).join("\n\n")` as the system message.
- **Other providers** (Groq, Mistral, etc.): Follow the same pattern as OpenAI — update `system` and `prompt` params.

### 5. Template Splits

#### 5a. `regularMessageTemplate` → `getRegularMessageTemplate(): Template`

**system (static, ~85 lines):**
```
You are an AI assistant that can help with various topics and conversations.

## Data retention by plan (for date-range actions)
Different subscription tiers allow different time windows for historical data...
- Free: last 3 months (90 days)
- Plus: last 6 months (180 days)
- Pro: last 24 months (730 days)
- Enterprise: no limit
- Anonymous: only data between 1 and 3 months ago (30–90 days ago)

## Response Instructions
[Option A/B decision logic]
[JSON format specs for action calls and responses]

[Web search citation rules]
[Markdown formatting requirements]
```

**prompt (dynamic, ~25 lines):**
```
Current Date: {{currentDate}}
{{userTraits}}
Recent conversation: {{recentMessages}}
## User's Request
{{userMessage}}
**Current user:** {{dataRetentionInfo}}
## Available Actions
{{availableActions}}
## Action Results
{{actionResults}}
```

Same pattern for `getFinalResponseTemplate()`.

#### 5b. `taskChainPlanningTemplates` → `getTaskChainPlanningTemplate(): Template`

**system (static, ~130 lines):**
```
# Task Chain Planning
You are an expert AI task planner...

## INSTRUCTIONS
[Key principles]
[Response JSON schema]

## Examples
[Example 1: Bitcoin Analysis]
[Example 2: BTC vs ETH Comparison]
[Example 3: Solana Research & Chart]

[Important notes about crypto asset naming]
```

**prompt (dynamic, ~25 lines):**
```
## Context
Current Date: {{currentDate}}
User Request: "{{userRequest}}"

## User's previous queries
{{lastFiveQueries}}

## Learned Task Chain Patterns
{{learnedRules}}

## Available Actions
{{availableActions}}
```

#### 5c. `taskChainExecutorTemplate` → `getTaskChainActionTemplate(): Template`

**system (static, ~130 lines):**
```
You are selecting the best approach for a specific task in the task chain.

## Data retention by plan
[Tier table]

# Decision Process
[Step 1-3]

# Response Format
[Action needed JSON / Analysis needed JSON]

# Key Rules
[Rules list]

# Example
[Bitcoin news + ETH chart example]
```

**prompt (dynamic, ~25 lines):**
```
# Current Task: {{taskName}}
## Current Time
{{currentTime}}
## This Task
**Description**: {{taskDescription}}
## What's Already Done
{{dependencyTasks}}
**Current user:** {{dataRetentionInfo}}
## Available Actions
{{availableActions}}
```

`LLM_TASK_FORMATTING_REQUIREMENTS` stays as a separate exported constant (it's appended to dynamically-generated LLM task templates by the executor, not used as a Template type).

#### 5d. `comprehensive_analysis_prompt_template` → `comprehensive_analysis: Template`

**system (static, ~360 lines):**
The entire template as-is. It's almost 100% static — the `[CRYPTOCURRENCY_NAME]`, `[DATE]`, etc. placeholders are documentation, not runtime variables. The actual data is injected by the workflow graph as action results.

**prompt (dynamic, ~10 lines):**
```
Analyze the following cryptocurrency using all available data:
Cryptocurrency: {{cryptoName}}
Symbol: {{symbol}}
Analysis Date: {{currentDate}}
Date Range: {{from}} to {{to}}
```

#### 5e. `comprehensive_analysis_actions` → `getComprehensiveAnalysisActionsTemplate(): Template`

**system (static, ~90 lines):**
```
# Task: Extract Target and Parameters for Comprehensive Analysis
You are a crypto analysis parameter extraction agent...

## Data retention by plan
[Tier table]

**Response Format:**
[JSON schema]

**Parameter Extraction Rules:**
[Rules 1-4]

**Examples:**
[4 examples]
```

**prompt (dynamic, ~10 lines):**
```
# Current Date and Time
Today is {{currentDate}} (timestamp: {{currentTimestamp}})
# Latest User Query
{{latestQuery}}
**Current user:** {{dataRetentionInfo}}

Now extract the target and parameters from the user query.
```

### 6. Handler Migration

Each handler changes from:
```ts
const template = getRegularMessageTemplate();       // was string
const context = composeContext({ state, template });
const response = await generateText({ runtime, context });
```

To:
```ts
const template = getRegularMessageTemplate();       // now Template
const { system, prompt } = composeContextSplit({ state, template });
const response = await generateText({ runtime, system, prompt });
```

**Affected handlers (5 files, ~10 call sites):**
1. `regularMessageHandler.ts` — 2 call sites
2. `taskChainPlanner.ts` — 2 call sites
3. `taskExecutor.ts` — 2-3 call sites
4. `comprehensiveAnalysisWorkflowGraph.ts` — 2 call sites
5. `langGraphPrecheck.ts` — 1 call site (can use `context` legacy path initially)

**Non-migrated callers (~17 remaining files):**
Continue using `context` param unchanged. No breaking changes for them. Includes: plugin actions, twitter client, `jsonValidation.ts` (uses `customSystemPrompt`), `runtime.ts`, `userFeatureManager.ts`, `client-direct/index.ts`.

### 7. Cache Hit Pattern

```
Request 1: system=[character + regularMessage instructions]     → MISS, stored
Request 2: system=[character + regularMessage instructions]     → HIT (50% cheaper)
Request 3: system=[character + taskChainPlanning instructions]  → MISS, stored
Request 4: system=[character + taskChainPlanning instructions]  → HIT
Request 5: system=[character + regularMessage instructions]     → HIT (still cached)
```

Each template type maintains its own cache slot. Within a conversation, the same template type is called repeatedly (e.g., regularMessage iterates up to 3 times), guaranteeing cache hits on iterations 2+.

## Estimated Impact

| Template | Static lines cached | Calls per conversation | Savings |
|----------|-------------------|----------------------|---------|
| regularMessage | ~85 | 1-3 (iterative) | 50% on iterations 2-3 |
| taskChainPlanning | ~130 | 1-2 | 50% on repeat plans |
| taskChainExecutor | ~130 | N per chain (many tasks) | 50% on tasks 2+ |
| comprehensive_analysis | ~360 | 1 | Cache across users |
| comprehensive_analysis_actions | ~90 | 1 | Cache across users |

**Total**: ~750 lines of static instructions cached. Highest impact on task chains where `taskChainExecutor` is called once per task (often 3-8 tasks per chain).

## Migration Order

1. Add `Template` type to `core/types.ts`
2. Add `composeContextSplit()` to `core/context.ts`
3. Update `generateText()` signature with backward-compatible `context` param
4. Split 5 templates (can be done independently per template)
5. Update 5 handlers to use new `composeContextSplit` + `system`/`prompt`
6. Verify caching works by adding a one-time log in `generateText()` that logs `usage.prompt_tokens_details.cached_tokens` from the OpenAI response. Check that cached_tokens > 0 on the second call with the same template type. Remove the log after verification.
7. (Future) Migrate remaining templates and deprecate `context` param
