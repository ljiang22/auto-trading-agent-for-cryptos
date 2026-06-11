import type { CanonicalIntent } from "../../intent/canonicalIntent";
import type { RiskEvaluationContext, RiskRuleResult } from "../types";

/**
 * 2026-05-25 hardening (QA H-1). Reject orders whose extracted leverage
 * exceeds the per-user `max_leverage` ceiling. The DEFAULT preference
 * (5x) sits well below the platform hard cap (10x). The rule is the
 * authoritative refusal; the system-prompt update is a soft second
 * layer.
 *
 * Skip conditions:
 *   - read actions / non-create intents (no order to gate)
 *   - intent.margin_context.leverage is absent / unparseable (Spot order)
 *   - max_leverage preference is `Infinity` / non-finite (advanced users
 *     can opt out via the prefs API)
 */
const PLATFORM_HARD_CAP = 10;

export function leverageCap(
    intent: CanonicalIntent,
    ctx: RiskEvaluationContext,
): RiskRuleResult {
    if (intent.action !== "create_order") {
        return { id: "leverageCap", verdict: "allow" };
    }
    // The canonical-intent schema declares `leverage` as a string, but the
    // ADK / LLM extractor sometimes emits it as a JSON number (observed on
    // staging 2026-05-26 for "limit sell ... 20x leverage auto borrow" —
    // intent.margin_context.leverage came through as `20` not `"20"`).
    // Coerce both shapes so the rule fires either way.
    const rawLeverage = intent.margin_context?.leverage as unknown;
    if (rawLeverage === null || rawLeverage === undefined) {
        return { id: "leverageCap", verdict: "allow" };
    }
    const requested =
        typeof rawLeverage === "number"
            ? rawLeverage
            : Number.parseFloat(String(rawLeverage).trim());
    if (!Number.isFinite(requested) || requested <= 1) {
        return { id: "leverageCap", verdict: "allow" };
    }

    const userMax = ctx.preferences.max_leverage;
    const effectiveMax =
        Number.isFinite(userMax) && userMax > 0 ? Math.min(userMax, PLATFORM_HARD_CAP) : PLATFORM_HARD_CAP;

    if (requested > effectiveMax) {
        return {
            id: "leverageCap",
            verdict: "block",
            explanation: `Requested leverage ${requested}x exceeds your configured maximum (${effectiveMax}x). Lower the leverage or raise the cap in Settings → Risk Limits.`,
            metadata: { requested, effectiveMax, userMax, platformHardCap: PLATFORM_HARD_CAP },
        };
    }
    return { id: "leverageCap", verdict: "allow" };
}
