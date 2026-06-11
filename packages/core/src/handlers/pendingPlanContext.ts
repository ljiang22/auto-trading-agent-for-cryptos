/**
 * Injects active / awaiting_approval CEX execution plans into LLM context so
 * follow-up turns (e.g. "check status") do not lose pending plan state.
 */

import { renderPlanCard } from "./cexPlanExecutor.ts";
import { getActivePlan } from "./cexPlanState.ts";

/**
 * Build a markdown block describing the user's active trading plan, if any.
 *
 * @param userId - Authenticated user id
 * @param roomId - Conversation room id
 * @returns Empty string when no non-terminal plan exists for the pair
 */
export function formatPendingTradingPlansContext(
    userId: string,
    roomId: string,
): string {
    const plan = getActivePlan(userId, roomId);
    if (!plan) {
        return "";
    }

    const card = renderPlanCard(plan, {
        include_next_prompt: plan.status === "awaiting_approval",
    });

    return [
        "# [PENDING/ACTIVE TRADING PLANS]",
        "A trading execution plan exists for this conversation. You MUST NOT claim",
        "there are no active tasks or background processes if this section is present.",
        "When the user asks about status, execution, or monitoring:",
        "- Report the plan status and steps accurately from the card below.",
        "- If status is `awaiting_approval`, remind them to reply `yes` to proceed",
        "  (or `yes, all` for batch) or `cancel` to stop — do NOT abandon the plan.",
        "- Do NOT imply continuous background price monitoring; plans run only after",
        "  explicit user approval and step execution.",
        "",
        card,
    ].join("\n");
}
