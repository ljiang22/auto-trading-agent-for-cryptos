import type { Template } from "../core/types.ts";

/**
 * Markdown formatting and summary generation requirements for LLM task templates.
 * This constant provides standardized instructions for:
 * 1. Proper markdown syntax formatting
 * 2. JSON response format with results and summary
 */
export const LLM_TASK_FORMATTING_REQUIREMENTS = `
## CRITICAL RESPONSE FORMAT REQUIREMENTS

You MUST respond with a valid JSON object containing two fields: "results" and "summary".

### Response Structure
\`\`\`json
{
  "results": "Your full analysis content here (markdown formatted)",
  "summary": "A 2-4 sentence summary of the key findings"
}
\`\`\`

### Markdown Formatting Rules (for the "results" field)
- Format the content using proper markdown syntax
- Use headers (# ## ###) for structure - ALWAYS include ONE SPACE after # symbols
- Use **bold** and *italic* for emphasis
- Use bullet points (-) or numbered lists (1.) where appropriate
- Use tables (| header |) for structured data presentation
- Use code blocks (\`\`\`) for technical content if relevant
- Use > blockquotes for important highlights
- Ensure the content will render beautifully in a markdown viewer

### Summary Field Requirements
The "summary" field should:
- Capture the most important takeaways from your analysis
- Focus on actionable insights or key conclusions
- Be concise but informative (2-4 sentences maximum)
- Be a plain text string (not markdown)

### Example Response
\`\`\`json
{
  "results": "# Bitcoin Market Analysis\\n\\n## Price Trend\\nBTC has shown a **bullish pattern** over the past week...\\n\\n## Key Indicators\\n- RSI: 65 (neutral-bullish)\\n- MACD: Positive crossover\\n\\n## Conclusion\\nThe overall market sentiment is cautiously optimistic.",
  "summary": "Bitcoin shows bullish momentum with RSI at 65 and positive MACD crossover. Key support at $42,000 with resistance at $48,000. Short-term outlook is cautiously optimistic."
}
\`\`\`

IMPORTANT: Return ONLY the JSON object. Do not include any text before or after the JSON.

{{languageInstruction}}
`;

/**
 * Get the template for task chain action selection focused on current step
 * @returns Task chain action selection template with system and prompt parts
 */
export function getTaskChainActionTemplate(): Template {
    return {
        system: `You are selecting the best approach for THIS SPECIFIC TASK in the task chain.

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
- Identify cryptocurrency symbols (BTC, ETH, etc.) from the task name and description
- **Always include \`symbol\` in parameters** when the task involves a specific cryptocurrency (e.g., if task mentions Ethereum/ETH, set \`"symbol": "ETH"\`; if it mentions Bitcoin/BTC, set \`"symbol": "BTC"\`)
- **For date/time ranges:** use "from" and "to" only. Format: \`YYYY-MM-DD\` or \`YYYY-MM-DDTHH:mm\` for hour precision. For "last N days" compute from/to; for hour-level needs use hour.
- **For WEB_SEARCH actions:** pass both \`query\` and \`topic\`
- **For CRYPTO_RESEARCH_SEARCH actions:** pass \`query\` only
- For WEB_SEARCH \`topic\`: use \`"news"\` for latest/current/recent/time-sensitive requests, otherwise \`"general"\`
- **ONLY use these parameters**: symbol, query, topic (for web_search), from, to (for date/time ranges)
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
        "query": "search_query",
        "topic": "news or general",
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
- **Use websearch only for topics that have high time sensitivity or images are needed to show to the user**

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

Select the optimal approach for: {{taskName}}
{{languageInstruction}}`
    };
}

/**
 * Get the meta-prompt used to generate a custom LLM task template at runtime.
 * The LLM responds with a template string that uses available template variables.
 * Note: LLM_TASK_FORMATTING_REQUIREMENTS will be appended to the generated template
 * by the caller (taskExecutor.ts) to ensure consistent formatting and summary generation.
 * @param taskName - Current task name
 * @param taskDescription - Current task description
 * @returns Prompt string to send to the model to generate the template
 */
export function getLLMTaskTemplateGenerationPrompt(
    taskName: string,
    taskDescription: string,
    languageInstruction = ""
): string {
    const normalizedLanguageInstruction = languageInstruction.trim();

    return `You are creating an optimal prompt template for an LLM task in a task chain workflow.

Current Task: ${taskName}
Task Description: ${taskDescription}

Available template variables to use:
- {{currentTime}} - Current date and time for temporal context
- {{chainContext}} - Overview of the entire task chain (chain name, total tasks, current task position, dependencies)
- {{taskName}} - Name of the current task
- {{taskDescription}} - Description of what this task needs to accomplish
- {{actionSummary}} - Summary of completed prerequisite tasks and their key results (not raw data, but concise summaries)

Create a prompt template that:
1. Clearly instructs the LLM what to analyze/synthesize based on the task description
2. Uses {{chainContext}} to provide context about where this task fits in the overall workflow
3. Uses {{actionSummary}} to inform the LLM about what has been done and what data is available
4. Is optimized for the specific task purpose

IMPORTANT: DO NOT include any formatting requirements, response format instructions, or output structure guidelines in your template. These will be automatically appended later. Focus ONLY on the task-specific analysis instructions.

The template should be structured and professional, focusing on what analysis or synthesis is needed for this specific task.

Return ONLY the template text with appropriate template variables.
${normalizedLanguageInstruction
        ? `

IMPORTANT: The template text you return must itself be written in the required response language, and it must instruct the downstream model to answer in that same language.
${normalizedLanguageInstruction}`
        : ""}
`;
}
