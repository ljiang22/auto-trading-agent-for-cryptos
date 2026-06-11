/**
 * Single barrel for canonical trading types so handler code outside
 * plugin-cex imports from one path.
 */

export type {
    CanonicalAction,
    CanonicalIntent,
    CanonicalIntentDraft,
    CanonicalOrderType,
    HashableIntentSubset,
    IntentMode,
    Locale,
    OrderSide,
    Stake,
} from "../intent/canonicalIntent";
export {
    canonicalIntentSchema,
    LOCALE_VALUES,
    parseCanonicalIntent,
    projectHashableSubset,
} from "../intent/canonicalIntent";
export {
    buildCanonicalIntent,
    type ApprovalPayloadShape,
    type BuildCanonicalIntentInput,
} from "../intent/intentBuilder";
export {
    canonicalJSON,
    computeIntentHash,
    deriveClientOrderId,
} from "../idempotency/intentHash";
export type {
    RiskDecision,
    RiskRuleResult,
    RiskRuleId,
    RiskVerdict,
    RiskEvaluationContext,
} from "../risk/types";
export type {
    UserTradingPreferences,
    RiskDecisionRecord,
} from "../risk/types";
export type {
    TradingEvent,
    TradingEventStage,
    TradingEventEnvelope,
} from "../observability/tradingEvents";
