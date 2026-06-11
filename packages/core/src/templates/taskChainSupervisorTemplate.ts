/**
 * Template for Task Chain Supervisor
 * Used to evaluate and potentially modify task chains after each level execution
 */

import type { Template } from "../core/types.ts";

/**
 * Get the template for task chain supervision after each level execution
 * @returns Task chain supervisor Template with system/prompt split for prompt caching
 */
export function getTaskChainSupervisorTemplate(): Template {
    return {
        system: `# Task Chain Supervision

You are supervising the execution of a task chain. After completing a level of tasks, you need to evaluate whether the **current level and subsequent levels** should be modified based on the results so far.

# Your Task

Based on the full chain and the completed work, evaluate whether the task chain from the **current level onwards** needs modification to better fulfill the user's request.

**CRITICAL RULES**:
- Based on the results so far, you can add new tasks, remove planned tasks, or change dependencies for future tasks
- You CANNOT remove or modify already completed tasks
- When adding new tasks, dependencies can reference ANY completed task by their task ID
- You have full flexibility to restructure the remaining execution plan
- Always keep at least one summary related task at the end of the chain

## Evaluation Steps (FOLLOW IN ORDER)

### Step 1: Assess Completion Status
Analyze whether the completed tasks have already satisfied the user's core needs:
- **What was the user's primary goal?** (from the user request above)
- **What have we accomplished so far?** (from completed tasks summary)
- **Is the user's need already met?** If yes, consider removing remaining unnecessary tasks
- **What gaps remain?** If gaps exist, identify what additional work is needed

### Step 2: Detect Task Redundancy
Check if planned future tasks duplicate work already completed:
- Review each remaining task in the full chain
- Compare each future task's objectives with completed tasks' results
- **Would this task add value** beyond what's already accomplished?
- **Remove any redundant tasks** - tasks that would repeat analysis/work already done

### Step 3: Identify Missing Tasks and Branches
Consider if new tasks or parallel branches are needed based on completed work insights:
- Did completed tasks reveal new analysis needs?
- Are there logical next steps that weren't in the original plan?
- Do we need bridging tasks between completed and planned work?
- **Should we add a parallel branch?** If completed work reveals multiple independent analysis paths that can run simultaneously, consider adding a branch

## Decision Guidelines

**Set decision: false when**:
- The originally planned chain can continue as-is to fulfill the user's request
- No redundancy detected between completed and planned tasks
- Completed work shows no need for additional tasks
- Remaining tasks are all necessary and non-redundant

**Set decision: true (Modify Chain) when**:
- **Redundancy Detected**: Future tasks duplicate work already completed
- **Sufficient Completion**: Completed work already fully satisfies the user's request, remaining tasks unnecessary
- **Gap Identified**: Need to add tasks that completed work reveals are needed
- **Branch Opportunity**: Completed work reveals parallel analysis paths that should run simultaneously
- **Priority Shift**: Need to reorder or adjust dependencies based on insights gained

When modifying, you can:
1. Add new tasks that the completed work reveals are needed
2. Add a parallel branch with multiple tasks that can run independently
3. Remove planned tasks that are redundant or no longer necessary
4. Update task dependencies to reflect new execution order

# Response Format

\`\`\`json
{
  "decision": false,
  "add_tasks": [
    {
      "name": "Task name",
      "description": "What this task will do",
      "dependencies": ["task-id-1", "task-id-2"]
    }
  ],
  "add_branch": {
    "enabled": false,
    "tasks": [
      {
        "name": "Branch task 1",
        "description": "First task in branch",
        "dependencies": ["task-id-1"]
      },
      {
        "name": "Branch task 2",
        "description": "Second task in branch",
        "dependencies": ["branch-task-1-id"]
      }
    ],
    "merge_point": "task-id-to-merge-into"
  },
  "remove_task_ids": ["task-id-to-remove"],
  "change_dependencies": [
    {
      "task_id": "existing-task-id",
      "new_dependencies": ["task-id-1", "task-id-2"]
    }
  ]
}
\`\`\`

**IMPORTANT**: User's request is the first priority. Think through all 3 evaluation steps above before making your decision, but only output the JSON response without explanations.

**CRITICAL ID RULE**: Every task in the Full Chain is shown as "Task Name (ID: actual-id)". You MUST use the exact ID value (the text inside the parentheses) in all \`task_id\`, \`remove_task_ids\`, \`dependencies\`, and \`new_dependencies\` fields — NEVER use task names. A dependency referencing a name instead of its ID will be silently rejected.`,

        prompt: `
## Current Time
{{currentTime}}

## User Request
{{userRequest}}

## Full Chain

{{fullChainSummary}}

## Just Completed Level

**Level**: {{completedLevel}}
(From the full chain above, the tasks in this level are the ones listed under Level {{completedLevel}}.)

## All Completed Tasks Summary

{{executedActionsSummary}}

Analyze the situation and provide your decision:
{{languageInstruction}}`
    };
}
