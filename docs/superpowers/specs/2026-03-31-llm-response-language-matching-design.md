# LLM Response Language Matching Design

## Goal

Make all LLM-generated content (conversations, comprehensive analysis reports, task chain results, trading info) respond in the language the user has selected in the frontend i18n settings (en or zh-CN).

## Current State

- Frontend i18n fully implemented: en / zh-CN, stored in `localStorage` key `sentiedge:language`
- All LLM prompt templates are English-only
- No `language` parameter passed from client to server
- LLM always generates responses in English

## Design Decisions

| Decision | Choice |
|----------|--------|
| Scope | All LLM output (regular, comprehensive, task chain, trading) |
| Language source | Frontend i18n setting only (no auto-detection) |
| Supported languages | en, zh-CN only |
| Control method | Templates stay in English; inject language instruction at prompt end |

## Architecture

### Three-Layer Change

```
Client (language setting) → API (language param) → Handler (inject instruction) → LLM (responds in target language)
```

### Layer 1: Client — Pass Language in API Request

**File:** `client/src/lib/api.ts`

Add `language` field to the message stream request payload. Read from the i18n context or `localStorage` (`sentiedge:language`).

```typescript
// In sendMessageStream or equivalent
payload: {
  text: string,
  roomId: string,
  language: string,  // "en" | "zh-CN"
  // ... existing fields
}
```

### Layer 2: Server — Language Instruction Generator

**New file:** `packages/core/src/utils/languageUtils.ts`

A single utility function that takes a language code and returns an instruction string:

```typescript
export function getLanguageInstruction(language?: string): string {
  if (language === "zh-CN") {
    return `\n\n**RESPONSE LANGUAGE**: You MUST write your ENTIRE response in Simplified Chinese (简体中文). All headings, analysis, recommendations, conclusions, and any other text content must be in Simplified Chinese. Do not mix English into your response unless referring to proper nouns (e.g., token names like "Bitcoin", "Ethereum"), technical terms that are commonly used in English (e.g., "RSI", "MACD"), or direct quotes.`;
  }
  // English is the default template language, no instruction needed
  return "";
}
```

No auto-detection. No fallback logic. If `language` is undefined or `"en"`, return empty string.

### Layer 3: Handlers — Inject Instruction into State

Each handler reads `language` from the incoming message and adds `{{languageInstruction}}` to the template state.

**Handlers to modify:**

1. **`regularMessageHandler.ts`** — Add `languageInstruction` to `RegularMessageState`, populate in `initializeRegularState`
2. **`comprehensiveAnalysisWorkflowGraph.ts`** — Add to workflow state, inject in analysis prompt and HTML generation prompt
3. **`taskChainHandler.ts`** — Add to task chain state, inject in planning and executor templates
4. **`tradingInfoMessageHandler.ts`** — Add to trading state, inject in trading template

**State addition pattern (same for all handlers):**

```typescript
// In state initialization
const languageInstruction = getLanguageInstruction(message.language);

// Add to state
state.languageInstruction = languageInstruction;
```

### Layer 3b: Templates — Add Placeholder

Each template adds `{{languageInstruction}}` at the **end of the prompt section** (not system section, since system is cached and language may vary per request).

**Templates to modify:**

1. **`regularMessageTemplate.ts`** — Append to prompt in both `getRegularMessageTemplate()` and `getFinalResponseTemplate()`
2. **`comprehensive_analysis_prompt_template.ts`** — Append to prompt section
3. **`taskChainExecutorTemplate.ts`** — Append to prompt section
4. **`taskChainPlanningTemplates.ts`** — Append to prompt section
5. **`tradingMessageTemplate.ts`** — Append to prompt section
6. **`htmlGenerator.ts`** — Inject language instruction in the HTML generation prompt
7. **`supervisorTemplates.ts`** — Append to prompt section
8. **`messageClassificationTemplate.ts`** — This template classifies intent, should remain English (no change needed)

**Placement:** Always at the very end of the prompt string, after all other content:

```typescript
const prompt = `
... existing prompt content ...

{{languageInstruction}}
`;
```

### HTML Report Language

The comprehensive analysis generates HTML reports via `htmlGenerator.ts`. The language instruction must be included in the prompt that generates the HTML content so that report headings, analysis text, and recommendations are all in the target language.

Section titles in `htmlGenerator.ts` that are hardcoded strings (e.g., "Executive Summary", "Technical Analysis") need to be parameterized or included in the language instruction to ensure the LLM generates them in the correct language.

## What Does NOT Change

- **Templates stay in English** — We do not maintain translated template copies
- **Frontend i18n** — No changes to existing UI translation system
- **Character configuration** — No language field added to character JSON
- **Message classification** — Classification logic stays in English (internal system use)
- **System prompt section** — Language instruction goes in prompt section only (for prompt caching compatibility)

## Message API Contract Change

### Before

```typescript
POST /${agentId}/message/stream
{
  text: string,
  roomId: string,
  favoriteTaskChain?: object,
  messageClassification?: string
}
```

### After

```typescript
POST /${agentId}/message/stream
{
  text: string,
  roomId: string,
  language?: string,        // "en" | "zh-CN", optional for backward compat
  favoriteTaskChain?: object,
  messageClassification?: string
}
```

## File Change Summary

| File | Change |
|------|--------|
| `client/src/lib/api.ts` | Add `language` to message payload |
| `packages/core/src/utils/languageUtils.ts` | **New file** — `getLanguageInstruction()` |
| `packages/core/src/handlers/regularMessageHandler.ts` | Read `language`, add `languageInstruction` to state |
| `packages/core/src/handlers/comprehensiveAnalysisWorkflowGraph.ts` | Read `language`, add `languageInstruction` to state |
| `packages/core/src/handlers/taskChainHandler.ts` | Read `language`, add `languageInstruction` to state |
| `packages/core/src/handlers/tradingInfoMessageHandler.ts` | Read `language`, add `languageInstruction` to state |
| `packages/core/src/templates/regularMessageTemplate.ts` | Add `{{languageInstruction}}` to prompt end |
| `packages/core/src/templates/comprehensive_analysis_prompt_template.ts` | Add `{{languageInstruction}}` to prompt end |
| `packages/core/src/templates/taskChainExecutorTemplate.ts` | Add `{{languageInstruction}}` to prompt end |
| `packages/core/src/templates/taskChainPlanningTemplates.ts` | Add `{{languageInstruction}}` to prompt end |
| `packages/core/src/templates/tradingMessageTemplate.ts` | Add `{{languageInstruction}}` to prompt end |
| `packages/core/src/templates/supervisorTemplates.ts` | Add `{{languageInstruction}}` to prompt end |
| `packages/core/src/templates/htmlGenerator.ts` | Add language instruction to HTML generation prompt |
| Server route handler (message endpoint) | Extract `language` from request body, pass to handler |

## Testing Plan

1. Set language to zh-CN in frontend → send a message → verify LLM response is in Chinese
2. Set language to en → send a message → verify LLM response is in English
3. Trigger comprehensive analysis in zh-CN → verify HTML report is in Chinese
4. Trigger task chain in zh-CN → verify task results are in Chinese
5. Verify proper nouns (BTC, ETH, RSI, MACD) remain in English even in Chinese responses
6. Verify message classification still works correctly (stays English internally)
7. Verify prompt caching is not broken (language instruction is in prompt section, not system)
