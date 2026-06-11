/**
 * Task Chain Planning Templates
 * Templates for generating and updating task chains using LLM
 */

import type { Template } from "../core/types.ts";

/**
 * Main task chain planning template
 * Used to generate a new task chain from user request
 */
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
{{availableActions}}
{{languageInstruction}}`
    };
}

/**
 * Favorite chain update template
 * Used to personalize a saved task chain for a new query
 */
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
\`\`\`
{{languageInstruction}}`
    };
}
