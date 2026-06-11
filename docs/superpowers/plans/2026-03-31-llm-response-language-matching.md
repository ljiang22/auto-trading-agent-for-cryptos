# LLM Response Language Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all LLM-generated content respond in the language selected in the frontend i18n settings (en or zh-CN).

**Architecture:** Pass `language` from frontend i18n setting through the message API to all backend handlers. A single utility function generates a language instruction string. Each template appends `{{languageInstruction}}` at the end of the prompt section. When language is `zh-CN`, the instruction tells the LLM to respond in Chinese; for `en`, it's empty.

**Tech Stack:** TypeScript, React (i18next), LangGraph handlers, Handlebars templates

---

### Task 1: Create `languageUtils.ts` utility

**Files:**
- Create: `packages/core/src/utils/languageUtils.ts`

- [ ] **Step 1: Create the utility file**

```typescript
// packages/core/src/utils/languageUtils.ts

/**
 * Generate a language instruction to append to LLM prompts.
 * When language is zh-CN, returns an instruction forcing Chinese output.
 * For English (default), returns empty string since templates are already in English.
 */
export function getLanguageInstruction(language?: string): string {
    if (language === "zh-CN") {
        return `\n\n**RESPONSE LANGUAGE**: You MUST write your ENTIRE response in Simplified Chinese (简体中文). All headings, analysis, recommendations, conclusions, and any other text content must be in Simplified Chinese. Do not mix English into your response unless referring to proper nouns (e.g., token names like "Bitcoin", "Ethereum"), technical terms that are commonly used in English (e.g., "RSI", "MACD", "ETF"), or direct quotes.`;
    }
    return "";
}
```

- [ ] **Step 2: Verify file created**

Run: `ls packages/core/src/utils/languageUtils.ts`
Expected: File exists

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/utils/languageUtils.ts
git commit -m "feat: add language instruction utility for LLM response language matching"
```

---

### Task 2: Add `language` field to Content interface

**Files:**
- Modify: `packages/core/src/core/types.ts:11-55`

- [ ] **Step 1: Add language field to Content interface**

In `packages/core/src/core/types.ts`, add a `language` field to the `Content` interface, before the catch-all `[key: string]: unknown` line (line 53):

```typescript
    /** Language code for response generation (e.g., 'en', 'zh-CN') */
    language?: string;
```

The interface should look like:

```typescript
export interface Content {
    // ... existing fields ...

    /** Streaming processing steps */
    processingSteps?: ProcessingStep[];

    /** Language code for response generation (e.g., 'en', 'zh-CN') */
    language?: string;

    /** Additional dynamic properties */
    [key: string]: unknown;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/core/types.ts
git commit -m "feat: add language field to Content interface"
```

---

### Task 3: Pass language from frontend to API request

**Files:**
- Modify: `client/src/lib/api.ts:678-765`
- Modify: `client/src/components/chat.tsx:1173-1436`

- [ ] **Step 1: Add `language` parameter to `sendMessageStream` function signature**

In `client/src/lib/api.ts`, add `language?: string` parameter after `messageClassification` at line 691:

Change:
```typescript
        messageClassification?: "TASK_CHAIN_MESSAGE",
        retryCount = 0
```

To:
```typescript
        messageClassification?: "TASK_CHAIN_MESSAGE",
        language?: string,
        retryCount = 0
```

- [ ] **Step 2: Add `language` to FormData payload**

In the same function, after the `messageClassification` append block (after line 737), add:

```typescript
            if (language) {
                formData.append("language", language);
            }
```

- [ ] **Step 3: Add `language` to JSON payload**

After the `messageClassification` block (after line 758), add:

```typescript
            if (language) {
                payload.language = language;
            }
```

- [ ] **Step 4: Pass `language` in the retry call**

Find the recursive `this.sendMessageStream(` call (around line 922). This call passes all parameters. Add `language` to the parameter list in the same position (after `messageClassification`, before `retryCount + 1`).

- [ ] **Step 5: Pass `language` from chat.tsx**

In `client/src/components/chat.tsx`, the call at line 1173 ends with:
```typescript
            favoriteChainPayload,
            filesToUpload,
            messageClassification
        );
```

Change to:
```typescript
            favoriteChainPayload,
            filesToUpload,
            messageClassification,
            i18n.language
        );
```

`i18n` is already available at line 99: `const { t, i18n } = useTranslation();`

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/api.ts client/src/components/chat.tsx
git commit -m "feat: pass language setting from frontend to message API"
```

---

### Task 4: Extract `language` on server and add to message content

**Files:**
- Modify: `packages/client-direct/src/index.ts:574-740`

- [ ] **Step 1: Extract language from request body**

After line 595 (after the `favoriteTaskChain` extraction block), add:

```typescript
                    const language = typeof (req.body as Record<string, unknown>).language === "string"
                        ? (req.body as Record<string, unknown>).language as string
                        : undefined;
```

- [ ] **Step 2: Add language to content object**

At line 735-740, the `content` object is created:
```typescript
                    const content: Content = {
                        text,
                        attachments: processedAttachments,
                        source: undefined,
                        inReplyTo: undefined,
                    };
```

Change to:
```typescript
                    const content: Content = {
                        text,
                        attachments: processedAttachments,
                        source: undefined,
                        inReplyTo: undefined,
                        language,
                    };
```

- [ ] **Step 3: Commit**

```bash
git add packages/client-direct/src/index.ts
git commit -m "feat: extract language from request and add to message content"
```

---

### Task 5: Add `languageInstruction` to all prompt templates

**Files:**
- Modify: `packages/core/src/templates/regularMessageTemplate.ts`
- Modify: `packages/core/src/templates/comprehensive_analysis_prompt_template.ts`
- Modify: `packages/core/src/templates/taskChainExecutorTemplate.ts`
- Modify: `packages/core/src/templates/taskChainPlanningTemplates.ts`
- Modify: `packages/core/src/templates/tradingMessageTemplate.ts`
- Modify: `packages/core/src/templates/taskChainSupervisorTemplate.ts`
- Modify: `packages/core/src/templates/htmlGenerator.ts`

For every template, append `{{languageInstruction}}` at the **end of the prompt section** (never in system, to preserve prompt caching). When `languageInstruction` is empty string (English), Handlebars renders nothing.

- [ ] **Step 1: regularMessageTemplate.ts — `getRegularMessageTemplate()`**

The prompt section ends at line 113 with:
```
{{actionResults}}`,
```

Change to:
```
{{actionResults}}
{{languageInstruction}}`,
```

- [ ] **Step 2: regularMessageTemplate.ts — `getFinalResponseTemplate()`**

The prompt section ends at line 180 with:
```
{{actionResults}}`,
```

Change to:
```
{{actionResults}}
{{languageInstruction}}`,
```

- [ ] **Step 3: tradingMessageTemplate.ts — `getTradingMessageTemplate()`**

The prompt section ends at line 79 with:
```
{{availableActions}}`
```

Change to:
```
{{availableActions}}
{{languageInstruction}}`
```

- [ ] **Step 4: tradingMessageTemplate.ts — `getTradingFinalResponseTemplate()`**

The prompt section ends at line 112 with:
```
{{userMessage}}`
```

Change to:
```
{{userMessage}}
{{languageInstruction}}`
```

- [ ] **Step 5: tradingMessageTemplate.ts — `getTradingResultFormattingTemplate()`**

The prompt section ends at line 151 with:
```
{{actionOutput}}
\`\`\``
```

Change to:
```
{{actionOutput}}
\`\`\`
{{languageInstruction}}`
```

- [ ] **Step 6: taskChainPlanningTemplates.ts — `getTaskChainPlanningTemplate()`**

The prompt section ends at line 162 with:
```
{{availableActions}}`
```

Change to:
```
{{availableActions}}
{{languageInstruction}}`
```

- [ ] **Step 7: taskChainPlanningTemplates.ts — `getFavoriteChainUpdateTemplate()`**

The prompt section ends at line 210 with:
```
{{favoriteChainJson}}
\`\`\``
```

Change to:
```
{{favoriteChainJson}}
\`\`\`
{{languageInstruction}}`
```

- [ ] **Step 8: taskChainExecutorTemplate.ts — `getTaskChainActionTemplate()`**

The prompt section ends at line 161 with:
```
Select the optimal approach for: {{taskName}}`
```

Change to:
```
Select the optimal approach for: {{taskName}}
{{languageInstruction}}`
```

- [ ] **Step 9: taskChainExecutorTemplate.ts — `LLM_TASK_FORMATTING_REQUIREMENTS`**

This constant is appended to every dynamically generated LLM task template. Add `{{languageInstruction}}` at the very end (after line 47, before the closing backtick):

The constant ends with:
```
IMPORTANT: Return ONLY the JSON object. Do not include any text before or after the JSON.
`;
```

Change to:
```
IMPORTANT: Return ONLY the JSON object. Do not include any text before or after the JSON.

{{languageInstruction}}
`;
```

- [ ] **Step 10: taskChainSupervisorTemplate.ts — `getTaskChainSupervisorTemplate()`**

The prompt section ends at line 133 with:
```
Analyze the situation and provide your decision:`
```

Change to:
```
Analyze the situation and provide your decision:
{{languageInstruction}}`
```

- [ ] **Step 11: Commit**

```bash
git add packages/core/src/templates/regularMessageTemplate.ts \
       packages/core/src/templates/comprehensive_analysis_prompt_template.ts \
       packages/core/src/templates/taskChainExecutorTemplate.ts \
       packages/core/src/templates/taskChainPlanningTemplates.ts \
       packages/core/src/templates/tradingMessageTemplate.ts \
       packages/core/src/templates/taskChainSupervisorTemplate.ts
git commit -m "feat: add languageInstruction placeholder to all prompt templates"
```

---

### Task 6: Inject `languageInstruction` in `regularMessageHandler.ts`

**Files:**
- Modify: `packages/core/src/handlers/regularMessageHandler.ts`

- [ ] **Step 1: Add import**

At the top of the file, add:
```typescript
import { getLanguageInstruction } from "../utils/languageUtils.ts";
```

- [ ] **Step 2: Add `languageInstruction` to state annotation**

In the `RegularMessageState` annotation (line 29-67), add after line 41 (`userTraits`... line or near the context data section):

```typescript
    languageInstruction: Annotation<string>(),
```

- [ ] **Step 3: Generate language instruction in `initializeWorkflow`**

In `initializeWorkflow` (line 109), before the return statement (line 197), add:

```typescript
        const languageInstruction = getLanguageInstruction(state.message?.content?.language);
```

And add `languageInstruction` to the return object (after `dataRetentionInfo` at line 203):

```typescript
            languageInstruction,
```

- [ ] **Step 4: Add `languageInstruction` to `composeContextSplit` state**

In `generateLLMResponse` (around line 285-305), add `languageInstruction` to the state object passed to `composeContextSplit`:

After line 296 (`dataRetentionInfo`), add:
```typescript
                languageInstruction: state.languageInstruction || "",
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/handlers/regularMessageHandler.ts
git commit -m "feat: inject language instruction in regular message handler"
```

---

### Task 7: Inject `languageInstruction` in `comprehensiveAnalysisWorkflowGraph.ts`

**Files:**
- Modify: `packages/core/src/handlers/comprehensiveAnalysisWorkflowGraph.ts`

The comprehensive analysis handler does NOT use `composeContextSplit` for the main analysis — it builds the prompt string directly in `generateAnalysis()`. The `comprehensive_analysis` template's system section is used as-is, and the prompt is constructed manually.

- [ ] **Step 1: Add import**

At the top of the file, add:
```typescript
import { getLanguageInstruction } from "../utils/languageUtils.ts";
```

- [ ] **Step 2: Add `languageInstruction` to state annotation**

In `ComprehensiveAnalysisState` (lines 34-66), add in the user context section (after `userTraits` at line 57):

```typescript
    languageInstruction: Annotation<string>(),
```

- [ ] **Step 3: Generate in `initializeWorkflow`**

In `initializeWorkflow` (line 134), before the return at line 194, add:

```typescript
        const languageInstruction = getLanguageInstruction(state.message?.content?.language);
```

Add to the return object (after `userTraits` at line 198):
```typescript
            languageInstruction,
```

- [ ] **Step 4: Append to dynamic prompt in `generateAnalysis`**

In `generateAnalysis()` (line 1119), the `dynamicPrompt` string is built (lines 1145-1170). Before the closing backtick at line 1170, append:

Change line 1169-1170 from:
```typescript
Generate the analysis now:
`;
```

To:
```typescript
Generate the analysis now:
${state.languageInstruction || ""}
`;
```

- [ ] **Step 5: Append to fallback prompt in `generateAnalysis`**

In the fallback prompt (lines 1219-1235), before the closing backtick:

Change:
```typescript
Generate a detailed analysis now:
`;
```

To:
```typescript
Generate a detailed analysis now:
${state.languageInstruction || ""}
`;
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/handlers/comprehensiveAnalysisWorkflowGraph.ts
git commit -m "feat: inject language instruction in comprehensive analysis handler"
```

---

### Task 8: Inject `languageInstruction` in `taskChainHandler.ts`

**Files:**
- Modify: `packages/core/src/handlers/taskChainHandler.ts`

The task chain handler passes context to `taskChainPlanner.ts` and `taskExecutor.ts` via `state` and `TaskExecutionContext`. The language needs to flow through to those sub-components.

- [ ] **Step 1: Add import**

At the top of the file, add:
```typescript
import { getLanguageInstruction } from "../utils/languageUtils.ts";
```

- [ ] **Step 2: Add `languageInstruction` to state annotation**

In `TaskChainWorkflowState` (lines 268-342), add after `userTraits` (line 280):

```typescript
    languageInstruction: Annotation<string>(),
```

- [ ] **Step 3: Generate in `initializeWorkflow`**

In `initializeWorkflow` (line 349), before the return at line 430, add:

```typescript
        const languageInstruction = getLanguageInstruction(state.message?.content?.language);
```

Add to the return object (after `userTraits` at line 432):
```typescript
            languageInstruction,
```

- [ ] **Step 4: Pass `languageInstruction` through `enhancedState` to `TaskExecutionContext`**

In `executeTaskLevel` (line 934), the `enhancedState` is built at line 960. Add `languageInstruction`:

After line 971 (the `taskChainProgress` block), add:
```typescript
            languageInstruction: state.languageInstruction || ""
```

- [ ] **Step 5: Pass `languageInstruction` to planner state**

In `planTaskChain` (line 465), the planner is called at line 518:
```typescript
        const plannedChain = await planner.planChain(
            requestWithContext,
            state.state!,
            state.availableActions || [],
            state.streamingCallback
        );
```

The `state.state!` here is the LangGraph `State`. Since the planner accesses `state.context` internally and builds its own `planState` for `composeContextSplit`, we need to pass `languageInstruction` through the state. Add it to `enhancedState` in the planning context.

Before line 518, ensure the state passed to `planner.planChain` includes language instruction:

```typescript
        const stateWithLanguage = {
            ...state.state!,
            languageInstruction: state.languageInstruction || ""
        };
        const plannedChain = await planner.planChain(
            requestWithContext,
            stateWithLanguage,
            state.availableActions || [],
            state.streamingCallback
        );
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/handlers/taskChainHandler.ts
git commit -m "feat: inject language instruction in task chain handler"
```

---

### Task 9: Add `languageInstruction` to `taskChainPlanner.ts`

**Files:**
- Modify: `packages/core/src/tasks/taskChainPlanner.ts`

- [ ] **Step 1: Add `languageInstruction` to `planState`**

In the `planChain` method (around line 392), the `planState` is built:
```typescript
        const planState = {
            ...state.context,
            userRequest: enhancedUserRequest,
            lastFiveQueries: state.lastFiveQueries,
            currentDate: state.currentDate,
            availableActions: formatActionsForTemplate(state.availableActions || []),
            learnedRules: learnedRulesText
        };
```

Add `languageInstruction`:
```typescript
        const planState = {
            ...state.context,
            userRequest: enhancedUserRequest,
            lastFiveQueries: state.lastFiveQueries,
            currentDate: state.currentDate,
            availableActions: formatActionsForTemplate(state.availableActions || []),
            learnedRules: learnedRulesText,
            languageInstruction: (state as any).languageInstruction || ""
        };
```

- [ ] **Step 2: Add `languageInstruction` to the favorite chain update state**

Find where `getFavoriteChainUpdateTemplate()` is used (around line 302) and ensure `languageInstruction` is in the `updateState`:

```typescript
            languageInstruction: (state as any).languageInstruction || ""
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/tasks/taskChainPlanner.ts
git commit -m "feat: pass language instruction through task chain planner"
```

---

### Task 10: Add `languageInstruction` to `taskExecutor.ts`

**Files:**
- Modify: `packages/core/src/tasks/taskExecutor.ts`

- [ ] **Step 1: Add `languageInstruction` to action selection template state**

In the `executeTask` method (around line 197), the `templateState` is built:
```typescript
        const templateState: any = {
            currentTime,
            taskName: task.name,
            taskDescription: task.description,
            availableActions: formatAvailableActions(getNonTradingActions(context.runtime)),
            dependencyTasks: formatActionSummaryForLLM(task, context),
            dataRetentionInfo
        };
```

Add `languageInstruction`:
```typescript
        const templateState: any = {
            currentTime,
            taskName: task.name,
            taskDescription: task.description,
            availableActions: formatAvailableActions(getNonTradingActions(context.runtime)),
            dependencyTasks: formatActionSummaryForLLM(task, context),
            dataRetentionInfo,
            languageInstruction: (context.state as any).languageInstruction || ""
        };
```

- [ ] **Step 2: Add `languageInstruction` to LLM task execution state**

Find where the LLM task template is rendered with `composeContext` (around line 1038). The `mergedState` is built around line 1015. Add:

```typescript
        languageInstruction: (context.state as any).languageInstruction || ""
```

to the `mergedState` object.

- [ ] **Step 3: Handle `languageInstruction` in `LLM_TASK_FORMATTING_REQUIREMENTS`**

Since `LLM_TASK_FORMATTING_REQUIREMENTS` is appended to generated templates (line 1426), and it now contains `{{languageInstruction}}`, the variable will be replaced by Handlebars when `composeContext` is called with the `mergedState` that includes `languageInstruction`.

No additional code change needed here — the Handlebars replacement in `composeContext` will handle it automatically since `languageInstruction` is in `mergedState`.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/tasks/taskExecutor.ts
git commit -m "feat: pass language instruction through task executor"
```

---

### Task 11: Add `languageInstruction` to `taskChainSupervisor.ts`

**Files:**
- Modify: `packages/core/src/tasks/taskChainSupervisor.ts`

- [ ] **Step 1: Add `languageInstruction` to supervisor template state**

In the `superviseChain` function (around line 224), the `composeContextSplit` call is:
```typescript
        const { system, prompt } = composeContextSplit({
            state: {
                ...state.state,
                currentTime,
                userRequest: state.userRequest || "User request not available",
                completedLevel: levelInfo.level,
                fullChainSummary,
                executedActionsSummary: executedSummary
            } as any,
            template: getTaskChainSupervisorTemplate()
        });
```

Add `languageInstruction` to the state object:
```typescript
        const { system, prompt } = composeContextSplit({
            state: {
                ...state.state,
                currentTime,
                userRequest: state.userRequest || "User request not available",
                completedLevel: levelInfo.level,
                fullChainSummary,
                executedActionsSummary: executedSummary,
                languageInstruction: state.languageInstruction || ""
            } as any,
            template: getTaskChainSupervisorTemplate()
        });
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/tasks/taskChainSupervisor.ts
git commit -m "feat: pass language instruction through task chain supervisor"
```

---

### Task 12: Inject `languageInstruction` in `tradingInfoMessageHandler.ts`

**Files:**
- Modify: `packages/core/src/handlers/tradingInfoMessageHandler.ts`

- [ ] **Step 1: Add import**

At the top of the file, add:
```typescript
import { getLanguageInstruction } from "../utils/languageUtils.ts";
```

- [ ] **Step 2: Add `languageInstruction` to state annotation**

In `TradingInfoState` (lines 133-165), add after `dataRetentionInfo` (line 144):

```typescript
    languageInstruction: Annotation<string>(),
```

- [ ] **Step 3: Generate in `initializeWorkflow`**

In `initializeWorkflow` (line 178), before the return at line 253, add:

```typescript
        const languageInstruction = getLanguageInstruction(state.message?.content?.language);
```

Add to the return object (after `dataRetentionInfo` at line 258):
```typescript
            languageInstruction,
```

- [ ] **Step 4: Add to `stateData` in `generateLLMResponse`**

In `generateLLMResponse` (line 281), the `stateData` is built at line 292:
```typescript
        const stateData = {
            userMessage: state.message.content.text,
            currentDate: state.currentDate,
            recentMessages: state.recentMessages,
            availableActions: state.availableActions,
            userTraits: state.userTraits,
            dataRetentionInfo: state.dataRetentionInfo,
            roomId: state.message.roomId,
            recentMessagesData: [],
        } as unknown as State;
```

Add `languageInstruction`:
```typescript
        const stateData = {
            userMessage: state.message.content.text,
            currentDate: state.currentDate,
            recentMessages: state.recentMessages,
            availableActions: state.availableActions,
            userTraits: state.userTraits,
            dataRetentionInfo: state.dataRetentionInfo,
            languageInstruction: state.languageInstruction || "",
            roomId: state.message.roomId,
            recentMessagesData: [],
        } as unknown as State;
```

- [ ] **Step 5: Also check if there's a separate `formatActionResult` call that uses a template**

Find where `getTradingResultFormattingTemplate()` is used in the handler and ensure `languageInstruction` is included in its state. Search for `getTradingResultFormattingTemplate` in the file and add `languageInstruction` to whatever state object is passed to `composeContextSplit` there.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/handlers/tradingInfoMessageHandler.ts
git commit -m "feat: inject language instruction in trading info handler"
```

---

### Task 13: Handle language in HTML report generation

**Files:**
- Modify: `packages/core/src/templates/htmlGenerator.ts`

The HTML report is generated from the `analysisContent` markdown (which is already generated in the target language by Task 7). The `createComprehensiveAnalysisHTML` function converts markdown to HTML. The content will already be in the correct language.

However, the HTML `lang` attribute is hardcoded to `"en"`.

- [ ] **Step 1: Add `language` parameter to `createComprehensiveAnalysisHTML`**

Change the function signature from:
```typescript
export function createComprehensiveAnalysisHTML(
    cryptoName: string,
    cryptoSymbol: string,
    currentDate: string,
    analysisContent: string,
    originalQuery: string,
    actionResults: Memory[]
): string {
```

To:
```typescript
export function createComprehensiveAnalysisHTML(
    cryptoName: string,
    cryptoSymbol: string,
    currentDate: string,
    analysisContent: string,
    originalQuery: string,
    actionResults: Memory[],
    language?: string
): string {
```

- [ ] **Step 2: Update HTML lang attribute**

Change:
```html
<html lang="en">
```

To:
```typescript
<html lang="${language === "zh-CN" ? "zh-CN" : "en"}">
```

- [ ] **Step 3: Update caller in `comprehensiveAnalysisWorkflowGraph.ts`**

In `createHTMLReport` (line 1293), the call is:
```typescript
        const htmlReport = createComprehensiveAnalysisHTML(
            state.parameters.cryptoName || state.target,
            state.target,
            currentDate,
            state.analysisContent,
            state.message.content.text || '',
            state.actionResults
        );
```

Add language parameter:
```typescript
        const htmlReport = createComprehensiveAnalysisHTML(
            state.parameters.cryptoName || state.target,
            state.target,
            currentDate,
            state.analysisContent,
            state.message.content.text || '',
            state.actionResults,
            state.message?.content?.language
        );
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/templates/htmlGenerator.ts packages/core/src/handlers/comprehensiveAnalysisWorkflowGraph.ts
git commit -m "feat: pass language to HTML report for correct lang attribute"
```

---

### Task 14: Build and verify

- [ ] **Step 1: Build the project**

Run: `pnpm build`
Expected: Build succeeds with no TypeScript errors

- [ ] **Step 2: Fix any build errors**

If there are build errors, fix them and rebuild.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve build errors from language matching implementation"
```
