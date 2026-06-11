/**
 * Template and types for chain rule learning
 * Extracts abstract patterns from user feedback on task chains
 */

import type { TaskChain, UUID } from "../core/types.ts";

/**
 * Data structure for learning from chain approval after regeneration
 */
export interface ChainApprovalLearningData {
    originalRequest: string;
    rejectedChain: TaskChain;
    userFeedback: string;
    approvedChain: TaskChain;
    userId: UUID;
    roomId: UUID;
}

/**
 * LLM-generated rule extraction result
 */
export interface RuleExtractionResult {
    rule: string;  // The learned rule as a single statement
}

/**
 * Stored chain rule with metadata
 */
export interface ChainRule {
    id: UUID;
    rule: string;
    createdAt: number;
    originalRequest: string;  // For debugging only
}

/**
 * Template for extracting learned rules from user feedback on task chains
 */
export function getChainRuleLearningTemplate(): string {
    return `# Task Chain Rule Learning

You are an expert AI that learns abstract patterns from user feedback on task chains. Your goal is to extract a general, reusable rule from a specific case of user rejection and approval.

## Context

**User's Original Request:**
{{originalRequest}}

**Initial Task Chain (Rejected by User):**
\`\`\`json
{{rejectedChainJson}}
\`\`\`

**User's Feedback on Why They Rejected:**
"{{userFeedback}}"

**Regenerated Task Chain (Approved by User):**
\`\`\`json
{{approvedChainJson}}
\`\`\`

## Your Task

Analyze the difference between the rejected and approved chains, combined with the user's explicit feedback, to extract a single, concise rule that can guide future task chain planning.

## Critical Requirements

1. **Generalize the Pattern**: Remove all specific details (crypto asset names, dates, personal info, specific technical indicators). Extract the underlying structural or strategic pattern.
2. **Focus on Why**: Understand WHY the user rejected the first chain and WHAT made the second chain acceptable.
3. **Make it Actionable**: The rule should clearly state what to do in similar situations.
4. **Privacy-First**: Never include personally identifiable information or specific user preferences.
5. **Keep it Concise**: One clear statement, no more than 2 sentences.

## Examples of Good vs. Bad Rules

**BAD (Too Specific):**
- "When analyzing Bitcoin, always check Ethereum too"
- "User John prefers technical analysis before sentiment"

**GOOD (Abstract & General):**
- "When analyzing a single asset, include comparative context with related assets unless specifically constrained"
- "For market analysis requests involving predictions, include data-gathering tasks before prediction tasks"

## Output Format

Return ONLY a JSON object with this exact structure:

\`\`\`json
{
  "rule": "A single concise statement describing the learned pattern"
}
\`\`\`

## Example Output

\`\`\`json
{
  "rule": "When user requests comprehensive analysis involving multiple data sources, structure tasks with clear sequential dependencies where synthesis tasks depend on all prerequisite data-gathering tasks"
}
\`\`\`

Now analyze the provided chains and extract your rule:`;
}

/**
 * Helper function to format multiple learned rules for planning template
 */
export function formatLearnedRulesForPlanning(rules: ChainRule[]): string {
    if (!rules || rules.length === 0) {
        return "No learned patterns available yet.";
    }

    return rules.map((rule, index) => {
        return `${index + 1}. ${rule.rule}`;
    }).join('\n');
}

/**
 * Template for consolidating a list of rules into a smaller, deduplicated set
 */
export function getRuleConsolidationTemplate(): string {
    return `# Chain Rule Consolidation

You are given a list of learned task-chain rules. Your job is to compress them into a smaller, clearer set without losing important guidance.

## Existing Rules (most recent first)
{{existingRules}}

## Instructions
- Merge overlapping or redundant rules.
- Keep the consolidated set focused, actionable, and globally applicable.
- Avoid repeating the same guidance in different words.
- Keep at most 15 concise rules
- Strip any user-specific details; keep rules general.

## Output Format
Return ONLY a JSON object:
\`\`\`json
{
  "rules": [
    "concise consolidated rule 1",
    "concise consolidated rule 2"
  ]
}
\`\`\`

Generate the consolidated rule list now.`;
}
