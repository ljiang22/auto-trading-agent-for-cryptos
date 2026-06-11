import "./config/config.ts"; // Add this line first

// Core functionality
export * from "./core/actions.ts";
export * from "./core/context.ts";
export * from "./core/goals.ts";
export * from "./core/messages.ts";
export * from "./core/providers.ts";
export * from "./core/runtime.ts";
export * from "./core/types.ts";

// Data management
export * from "./data/cache.ts";
export * from "./data/database.ts";
export { default as knowledge } from "./data/knowledge.ts";
export * from "./data/memory.ts";
export * from "./data/posts.ts";
export * from "./data/ragknowledge.ts";
export * from "./data/relationships.ts";

// AI functionality
export * from "./ai/embedding.ts";
export { default as LocalEmbeddingModelManager } from "./ai/localembeddingManager.ts";
export * from "./ai/evaluators.ts";
export * from "./ai/generation.ts";
export * from "./ai/models.ts";

// Configuration
export * from "./config/environment.ts";
export * from "./config/settings.ts";
export * from "./config/taskChainConfig.ts";

// Utilities
export * from "./utils/http.ts";
export * from "./utils/imageProcessor.ts";
export * from "./utils/logger.ts";
export * from "./utils/uuid.ts";
export * from "./utils/taskChainSnapshot.ts";
export * from "./utils/comprehensiveAnalysisSnapshot.ts";
export * from "./utils/langsmith.ts";
export * from "./utils/tracing.ts";
export * from "./utils/actionResponse.ts";
export * from "./utils/actionSummaryHelper.ts";
export * from "./utils/chartProxy.ts";
export * from "./utils/dataRetention.ts";
export * from "./utils/memoryProbe.ts";
export * from "./utils/subscriptionTier.ts";
export * from "./utils/usage.ts";
export * from "./utils/userFacingError.ts";
export * from "./utils/geoRestriction.ts";
export * from "./utils/promptInjectionDefense.ts";
// Note: Not exporting utils.ts to avoid conflicts since it re-exports items already exported above

// Security
export * from "./security/tokensCrypto.ts";

// Validation
export * from "./validation/parsing.ts";

// Handlers
export * from "./handlers/langGraphPrecheck.ts";
export * from "./handlers/regularMessageHandler.ts";
export {
    SCHEDULER_CANONICAL_SYMBOL_KEY,
    isComprehensiveAnalysisInProgress,
} from "./handlers/comprehensiveAnalysisWorkflowGraph.ts";
export {
    TASK_CHAIN_APPROVAL_CANCELLED_BY_DISCONNECT,
    getPendingApprovalForRoom,
} from "./handlers/taskChainHandler.ts";
// Re-exported so external tooling (e.g. scripts/eval-classifier-static.mjs)
// can validate the CEX-bypass intent-shift behavior against the fixtures
// without booting the agent.
export {
    detectIntentShift,
    isShortFollowUpText,
    shouldBypassToCexWorkflow,
    classifyCexIntentClassFromText,
    intentClassForAction,
    isCexContinuationMemory,
} from "./utils/cexBypassPredicate.ts";

// Pre-LLM short-circuit patterns + helper. Exported so the static-eval
// harness (`scripts/eval-classifier-static.mjs`) and unit tests can
// validate routing decisions against the SAME regex set the runtime
// uses, eliminating the previous "mirror that drifts" failure mode.
export {
    SHORT_CIRCUIT_PATTERNS,
    evaluateShortCircuit,
    type ShortCircuitPattern,
} from "./handlers/langGraphPrecheck.ts";

// Logging helpers
export {
    summarizeAxiosError,
    formatAxiosErrorLine,
} from "./utils/axiosErrorSanitize.ts";

// Response-summary mechanism: extractor + pre-write decorator. The two are
// the public surface for any new route handler that wants to participate
// in the compact `recentMessages` substitution.
export {
    extractExecutiveSummaryFromMarkdown,
    extractResponseSummary,
} from "./utils/executiveSummaryFromMarkdown.ts";
export {
    attachResponseSummary,
    type AttachResponseSummaryOptions,
    type ResponseSummaryRoute,
} from "./utils/persistResponseSummary.ts";

// Active SSE stream registry (used by runtime + client-direct to detect
// whether a workflow's final response can reach a live UI).
export {
    markStreamOpen,
    markStreamClosed,
    isStreamAliveForRoom,
    emitEventToUser,
} from "./utils/activeStreams.ts";

// Fix 12 — centralized revoker for pending human-input approvals.
// Exported so the kill-switch endpoint in client-direct can drop every
// open approval modal owned by the user without going through the
// per-handler resolve/reject paths.
export { revokePendingApprovalsForUser } from "./handlers/humanInputState.ts";

// F10.3 — market snapshot builder used by the `/cex/market-snapshot`
// route in client-direct so the compose dialog + approval modal can
// poll for live bid / ask / spread / 24 h stats / depth / est-fill /
// slippage data while open. Only the builder + its types are exposed;
// the surrounding handler internals stay private.
export {
    buildMarketSnapshot,
    type MarketSnapshotInput,
    type MarketSnapshot,
    type MarketSnapshotResult,
    type MarketDepthRow,
    type SymbolVerification,
} from "./handlers/cexMarketSnapshot.ts";

// Templates
export * from "./templates/messageClassificationTemplate.ts";
export * from "./templates/regularMessageTemplate.ts";

// Services
export { tavilyKeyManager } from "./services/tavilyKeyManager.ts";
