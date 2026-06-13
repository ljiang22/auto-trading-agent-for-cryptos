/**
 * Comprehensive Analysis Handler using LangGraph workflow architecture
 * Executes 12 mandatory actions across 3 phases with streaming support and real-time progress tracking
 */

import pLimit from "p-limit";
import { v4 as uuidv4 } from 'uuid';
import { elizaLogger } from "../utils/logger.ts";
import { getDataRetentionConfig, DATA_RETENTION_DAYS_BY_TIER, type DataRetentionConfig } from "../utils/dataRetention.ts";
import { logMemProbe, startMemSampler, withMemProbe } from "../utils/memoryProbe.ts";
import { traceNode } from "../utils/tracing.ts";
import {
    sanitizeSymbol,
    sanitizeForPrompt,
    wrapExternalData,
    SymbolValidationError,
} from "../utils/promptSanitizer.ts";
import { generateText } from "../ai/generation.ts";
import { composeContext } from "../core/context.ts";
import { getComprehensiveAnalysisActionsTemplate } from "../templates/comprehensive_analysis_actions.ts";
import { parseJSONObjectFromText } from "../validation/parsing.ts";
import { comprehensive_analysis } from "../templates/comprehensive_analysis_prompt_template.ts";
import { createComprehensiveAnalysisHTML } from "../templates/htmlGenerator.ts";
import { ImageProcessor } from "../utils/imageProcessor.ts";
import { buildLangSmithRunnableConfig } from "../utils/langsmith.ts";
import { StateGraph, Annotation } from "@langchain/langgraph";
import path from "path";
import fs from "fs";
import { getNonCEXActions } from "../utils/pluginFilter.ts";
import { getLanguageInstruction } from "../utils/languageUtils.ts";
import { extractExecutiveSummaryFromMarkdown } from "../utils/executiveSummaryFromMarkdown.ts";
import { attachResponseSummary } from "../utils/persistResponseSummary.ts";
import { extractReportMetadata } from "../utils/reportMetadataExtractor.ts";
import { stringToUuid } from "../utils/uuid.ts";
import type {
    IAgentRuntime,
    Memory,
    State,
    UUID,
    HandlerCallback,
    StreamingCallback,
    Action
} from "../core/types.ts";
import { ModelClass } from "../core/types.ts";

/** True when the workflow was triggered by the daily analysis scheduler (no chat persistence). */
export function isDailySchedulerMessage(message: Memory): boolean {
    return message.content?.source === "scheduler";
}

const DAILY_ANALYSIS_SCHEDULER_USER_ID = stringToUuid(
    "daily-analysis-scheduler",
);

// LangGraph State Definition for Comprehensive Analysis
export const ComprehensiveAnalysisState = Annotation.Root({
    // Input parameters
    message: Annotation<Memory>(),
    runtime: Annotation<IAgentRuntime>(),
    state: Annotation<State>(),
    streamingCallback: Annotation<StreamingCallback>(),
    intermediateResultCallback: Annotation<(response: Memory) => void>(),
    // Raw token-level callback (PR #109 pattern). When provided, every Gemini
    // delta produced by this workflow's generateText calls is forwarded to the
    // SSE endpoint so the client renders text as it streams.
    onToken: Annotation<((delta: string) => void) | undefined>(),
    // Fires once, the moment the user-visible analysis prose is ready. Lets
    // the SSE endpoint emit `[DONE]` and close the response while the
    // workflow finishes its background work (HTML render, S3 upload, report
    // metadata). Without this the client sat on the open stream for ~5 min
    // after the answer was already in hand.
    onAnalysisComplete: Annotation<((analysisContent: string) => void) | undefined>(),

    // Extraction phase
    target: Annotation<string>(),
    parameters: Annotation<any>(),

    // Action execution phase
    currentActionIndex: Annotation<number>(),
    actionResults: Annotation<Memory[]>(),
    actionFailures: Annotation<string[]>(),

    // Analysis generation phase
    synthesizedActionSummary: Annotation<string>(),
    analysisContent: Annotation<string>(),
    htmlReport: Annotation<string>(),
    reportPath: Annotation<string>(),

    // User context
    userTraits: Annotation<string>(),
    languageInstruction: Annotation<string>(),

    // Resolved once per workflow run; used by actions that clamp historical windows.
    dataRetention: Annotation<DataRetentionConfig | undefined>(),

    // Control flow
    phase: Annotation<string>(),
    isComplete: Annotation<boolean>(),
    hasError: Annotation<boolean>(),
    errorMessage: Annotation<string>(),
    shouldStop: Annotation<boolean>(),
    startTime: Annotation<number>()
});

export type ComprehensiveAnalysisStateType = typeof ComprehensiveAnalysisState.State;

/**
 * Snapshot of process memory in MB. We log this at every action boundary so
 * the staging/prod CloudWatch can show *which* action(s) are responsible for
 * the OOM kills observed during PREDICTION / final-summary generation.
 *
 * The split matters:
 *  - heapUsed: V8 heap (capped by --max-old-space-size). JS-side state.
 *  - external + arrayBuffers: native Buffers (e.g. LLM stream chunks, mongo
 *    cursor pages). NOT bounded by V8 cap; sums into RSS but invisible to
 *    process.memoryUsage().heapUsed.
 *  - rss: total resident set size — what the kernel sees and what triggers
 *    OOM kill when it crosses the cgroup limit.
 *
 * If the OOM is in V8: heapUsed climbs near the heap cap (12 GB).
 * If the OOM is in native: external+arrayBuffers climb while heapUsed stays low.
 * Knowing which is which decides whether to optimize JS code or buffer pools.
 */
function memSnapshotMB(): { rss: number; heapUsed: number; heapTotal: number; external: number; arrayBuffers: number } {
    const m = process.memoryUsage();
    const toMB = (b: number) => Math.round(b / 1_048_576);
    return {
        rss: toMB(m.rss),
        heapUsed: toMB(m.heapUsed),
        heapTotal: toMB(m.heapTotal),
        external: toMB(m.external),
        arrayBuffers: toMB(m.arrayBuffers),
    };
}

function logMemAt(label: string, extra: Record<string, string | number | undefined> = {}): void {
    const m = memSnapshotMB();
    const extraStr = Object.entries(extra)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
    elizaLogger.info(
        `[Memory] ${label} rss=${m.rss}MB heapUsed=${m.heapUsed}MB heapTotal=${m.heapTotal}MB external=${m.external}MB arrayBuffers=${m.arrayBuffers}MB${extraStr ? " " + extraStr : ""}`
    );
}

/**
 * Force a V8 major GC at a chosen workflow boundary.
 *
 * Why this exists: local Playwright tracing showed V8 *automatically*
 * reclaimed ~800 MB of heap between the data-gathering and analysis phases,
 * but only after RSS had already climbed to 3.2 GB. On a 16 GB ECS task that
 * spontaneous-GC headroom is much smaller, and the heuristic doesn't always
 * fire before the next allocation pushes us into the kernel OOM range.
 * Forcing GC at known phase boundaries gives us deterministic peak control
 * without depending on V8's internal scheduling.
 *
 * Cost: a major GC on a 1 GB heap takes ~50-200 ms (mostly mark-sweep over
 * old gen). We only call this between phases — never inside an action's
 * hot path — so the wall-clock cost is invisible against the LLM round
 * trips that follow.
 *
 * Requires `--expose-gc` on the node command line. The Dockerfile already
 * sets it (NODE_OPTIONS="--max-old-space-size=12288 --expose-gc"). When run
 * without --expose-gc (e.g. older builds, ad-hoc local runs), this is a
 * silent no-op — the only consequence is that the V8 heuristic schedules
 * the GC instead of us. Safe to call anywhere.
 *
 * The setImmediate yield gives the event loop a tick after GC so any
 * pending stream chunks / I/O callbacks land before the next heavy step.
 */
async function forceGcAt(label: string): Promise<void> {
    const before = memSnapshotMB();
    const gcFn = (globalThis as { gc?: () => void }).gc;
    if (typeof gcFn !== "function") {
        elizaLogger.debug(
            `[Memory] forceGcAt(${label}): global.gc unavailable (run node with --expose-gc); skipping`
        );
        return;
    }
    const t0 = Date.now();
    try {
        gcFn();
    } catch (err) {
        elizaLogger.warn(
            `[Memory] forceGcAt(${label}): gc() threw: ${err instanceof Error ? err.message : String(err)}`
        );
        return;
    }
    await new Promise<void>((r) => setImmediate(r));
    const after = memSnapshotMB();
    const elapsedMs = Date.now() - t0;
    elizaLogger.info(
        `[Memory] gc:${label} elapsed=${elapsedMs}ms rss=${before.rss}->${after.rss}MB (Δ${after.rss - before.rss}MB) heapUsed=${before.heapUsed}->${after.heapUsed}MB (Δ${after.heapUsed - before.heapUsed}MB) external=${before.external}->${after.external}MB`
    );
}

function checkForStopRequest(
    state: ComprehensiveAnalysisStateType,
    stage: string
): Partial<ComprehensiveAnalysisStateType> | null {
    const runtimeStopRequested = Boolean(state.runtime?.shouldStop && state.runtime.shouldStop());
    const alreadyStopped = state.shouldStop === true;

    if (!runtimeStopRequested && !alreadyStopped) {
        return null;
    }

    const timestamp = Date.now();
    const messageSuffix = stage ? `during ${stage}` : "";

    if (!alreadyStopped && runtimeStopRequested && state.streamingCallback) {
        state.streamingCallback({
            id: uuidv4(),
            name: 'comprehensive_analysis_stopped',
            status: 'completed',
            message: `🛑 Comprehensive analysis stopped ${messageSuffix}`.trim(),
            timestamp,
            data: {
                type: 'comprehensive_analysis_stopped',
                stage,
            }
        });
    }

    state.shouldStop = true;

    return {
        shouldStop: true,
        hasError: true,
        errorMessage: 'Processing stopped by user request',
        phase: 'stopped'
    };
}

/**
 * Per-action config fields:
 * - consumesDataRetention: spread dataRetention into actionParams (true) or skip.
 *   Only actions that clamp date ranges or load historical windows need it.
 * - promptPriority: 1 = highest priority (keep first), 12 = lowest (drop first)
 *   when the formatted results prompt exceeds total budget. PREDICTION is 1.
 * - promptMaxChars: per-action char cap inside formatActionResultsForAnalysis.
 *   Sum ≈ 100,500, fits under PROMPT_BUDGET_DEFAULT (150,000) with room for
 *   system prompt, envelope markers, and headers.
 */
export interface ComprehensiveAnalysisActionConfig {
    name: string;
    phase: "data_gathering" | "analysis" | "prediction";
    consumesDataRetention: boolean;
    promptPriority: number;
    promptMaxChars: number;
}

/**
 * Define the 12 mandatory actions for comprehensive analysis.
 * Char budgets chosen for gemini-3-pro-preview / gemini-3.1-pro (1M-token
 * input window). Override per deployment via COMPREHENSIVE_ANALYSIS_PROMPT_BUDGET.
 */
export const COMPREHENSIVE_ANALYSIS_ACTIONS: ComprehensiveAnalysisActionConfig[] = [
    // Phase 1: Data Collection
    { name: "GET_ADDRESS_AND_TRANSACTION_DATA", phase: "data_gathering", consumesDataRetention: false, promptPriority: 11, promptMaxChars: 6000  },
    { name: "GET_CRYPTO_PRICE",                 phase: "data_gathering", consumesDataRetention: true,  promptPriority: 6,  promptMaxChars: 8000  },
    { name: "getnews",                          phase: "data_gathering", consumesDataRetention: false, promptPriority: 8,  promptMaxChars: 10000 },
    { name: "WHALE_ALERT",                      phase: "data_gathering", consumesDataRetention: false, promptPriority: 7,  promptMaxChars: 8000  },
    { name: "web_search",                       phase: "data_gathering", consumesDataRetention: false, promptPriority: 10, promptMaxChars: 5000  },
    { name: "CRYPTO_RESEARCH_SEARCH",           phase: "data_gathering", consumesDataRetention: false, promptPriority: 9,  promptMaxChars: 8000  },
    { name: "plot_price_charts",                phase: "data_gathering", consumesDataRetention: true,  promptPriority: 12, promptMaxChars: 500   },

    // Phase 2: Analysis
    { name: "Sentiment_Analysis",               phase: "analysis",       consumesDataRetention: false, promptPriority: 3,  promptMaxChars: 12000 },
    { name: "TECHNICAL_ANALYSIS",               phase: "analysis",       consumesDataRetention: true,  promptPriority: 2,  promptMaxChars: 15000 },
    { name: "FEAR_GREED_INDEX_ANALYSIS",        phase: "analysis",       consumesDataRetention: false, promptPriority: 4,  promptMaxChars: 6000  },
    { name: "INFLOW_OUTFLOW_ANALYSIS",          phase: "analysis",       consumesDataRetention: true,  promptPriority: 5,  promptMaxChars: 10000 },

    // Phase 3: Prediction
    { name: "PREDICTION",                       phase: "prediction",    consumesDataRetention: false, promptPriority: 1,  promptMaxChars: 12000 },
];

/**
 * Comprehensive analysis cap (independent of subscription tier).
 * Even Pro (730-day max) defaults to 30 days unless the user explicitly requests
 * a longer window in their message. Prevents 730-day price history from being
 * loaded by default on every comprehensive analysis request.
 */
export const DEFAULT_ANALYSIS_WINDOW_DAYS = 30;

/** Optional scheduler-only: canonical uppercase ticker set on message.content */
export const SCHEDULER_CANONICAL_SYMBOL_KEY = "schedulerCanonicalSymbol";

/**
 * Human-readable names for scheduled runs when we skip LLM extraction.
 * Unlisted symbols use the uppercase ticker as `cryptoName` (still valid for actions).
 */
const SCHEDULER_CRYPTO_DISPLAY_NAMES: Record<string, string> = {
    BTC: "Bitcoin",
    ETH: "Ethereum",
    SOL: "Solana",
    XRP: "Ripple",
    DOGE: "Dogecoin",
    ADA: "Cardano",
    AVAX: "Avalanche",
    BNB: "BNB",
    MATIC: "Polygon",
    POL: "Polygon",
    LINK: "Chainlink",
    DOT: "Polkadot",
    ATOM: "Cosmos",
    LTC: "Litecoin",
    UNI: "Uniswap",
    ARB: "Arbitrum",
    OP: "Optimism",
};

function buildSchedulerForcedParameters(canonicalUpper: string): Record<string, unknown> {
    const cryptoName =
        SCHEDULER_CRYPTO_DISPLAY_NAMES[canonicalUpper] ?? canonicalUpper;
    const end = new Date();
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 90);
    const to = end.toISOString().split("T")[0];
    const from = start.toISOString().split("T")[0];
    return {
        symbol: canonicalUpper,
        cryptoName,
        query: `${canonicalUpper} ${cryptoName} comprehensive analysis`,
        topic: "general",
        from,
        to,
    };
}

/**
 * Cap dataRetentionDays at DEFAULT_ANALYSIS_WINDOW_DAYS unless the extracted
 * date range shows the user explicitly asked for a longer window. Tier cap
 * still applies as an upper bound for explicit long-window requests.
 */
export function applyDefaultWindowCap(
    retention: DataRetentionConfig,
    parameters: { from?: string; to?: string },
): DataRetentionConfig {
    const requestedDays = extractDaysFromFromTo(parameters.from, parameters.to);
    const userRequestedLong =
        typeof requestedDays === "number" && requestedDays > DEFAULT_ANALYSIS_WINDOW_DAYS;

    const tierCap = retention.dataRetentionDays;
    let effective: number;
    if (!userRequestedLong) {
        effective = DEFAULT_ANALYSIS_WINDOW_DAYS;
    } else {
        // User explicitly wants longer: honor the request but don't exceed tier
        // cap (tierCap=0 means enterprise — no limit).
        effective = tierCap === 0
            ? (requestedDays as number)
            : Math.min(tierCap, requestedDays as number);
    }

    return {
        ...retention,
        dataRetentionDays: effective,
    };
}

export interface BuildActionParamsInput {
    actionConfig: ComprehensiveAnalysisActionConfig;
    target: string;
    parameters: Record<string, any> | undefined;
    dataRetention: DataRetentionConfig;
}

/**
 * Assemble the params passed to a comprehensive-analysis action handler.
 * dataRetention fields (dataRetentionDays, dataRetentionMinDaysAgo, ...) are
 * only spread in for actions that declare consumesDataRetention=true. Other
 * actions would otherwise receive historical-window hints they never use
 * (risk of unintended range expansion and leaky API behaviour).
 */
export function buildActionParams(input: BuildActionParamsInput): Record<string, any> {
    const { actionConfig, target, parameters, dataRetention } = input;
    const base: Record<string, any> = {
        symbol: target,
        target,
        ...(parameters ?? {}),
        query: parameters?.query ?? `${target} ${parameters?.cryptoName ?? target}`,
        days: extractDaysFromFromTo(parameters?.from, parameters?.to),
        disableIterativeSearch: true,
    };
    if (actionConfig.consumesDataRetention) {
        Object.assign(base, dataRetention);
    }
    return base;
}

/**
 * Create a concurrency-limited runner for the comprehensive analysis action waves.
 * Reads COMPREHENSIVE_ANALYSIS_CONCURRENCY env var (default 3). Invalid values
 * fall back to 3. Sized for the 16 GB Fargate task; PR #148 cut peak rss/run
 * from ~8.5 GB → ~2.1 GB, so 3 parallel actions fit comfortably under the
 * 12 GB --max-old-space-size cap.
 */
export function createLimitedRunner(): <T>(fn: () => Promise<T>) => Promise<T> {
    const raw = process.env.COMPREHENSIVE_ANALYSIS_CONCURRENCY;
    const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
    const concurrency = Number.isFinite(parsed) && parsed >= 1 ? parsed : 3;
    const limit = pLimit(concurrency);
    return <T>(fn: () => Promise<T>) => limit(fn);
}

/**
 * Initialize the comprehensive analysis workflow
 */
async function initializeWorkflow(state: ComprehensiveAnalysisStateType): Promise<Partial<ComprehensiveAnalysisStateType>> {
    const startTime = Date.now();
    elizaLogger.info("[ComprehensiveAnalysisWorkflow] Initializing workflow");

    try {
        const stopState = checkForStopRequest(state, 'initialization');
        if (stopState) {
            elizaLogger.info("🛑 [ComprehensiveAnalysisWorkflow] Stop request received before initialization");
            return {
                ...stopState,
                isComplete: true,
                startTime
            };
        }

        // Get user traits from UserFeatureManager (new memory-based system with semantic search)
        let userTraits = "";
        const userId = state.message.userId;
        if (userId && userId !== state.runtime.agentId) {
            try {
                const formattedTraits = await state.runtime.userFeatureManager.formatUserTraitsForContext(
                    userId,
                    {
                        queryMessage: state.message.content.text,
                        topN: 3,
                        similarityThreshold: 0.3,
                        fallbackToAll: true
                    }
                );
                if (formattedTraits) {
                    // Convert format from "# User Profile..." to "## User Investment Profile..."
                    userTraits = formattedTraits.replace(
                        /# User Profile \([^)]+\)/,
                        "## User Investment Profile (Customize recommendations based on this profile)"
                    );
                    elizaLogger.debug(`[ComprehensiveAnalysisWorkflow] Loaded user traits for ${userId}`);
                }
            } catch (error) {
                elizaLogger.warn(`[ComprehensiveAnalysisWorkflow] Failed to load user traits: ${error}`);
            }
        }

        // Stream analysis start notification
        if (state.streamingCallback) {
            state.streamingCallback({
                id: uuidv4(),
                name: 'comprehensive_analysis_start',
                status: 'completed',
                message: `Starting comprehensive analysis - preparing to execute ${COMPREHENSIVE_ANALYSIS_ACTIONS.length} actions`,
                timestamp: Date.now(),
                data: {
                    type: 'comprehensive_analysis_start',
                    totalActions: COMPREHENSIVE_ANALYSIS_ACTIONS.length,
                    phases: ['data_gathering', 'analysis', 'prediction']
                }
            });
        }

        const languageInstruction = getLanguageInstruction();

        elizaLogger.info("[ComprehensiveAnalysisWorkflow] Initialization complete");

        return {
            currentActionIndex: 0,
            actionResults: [],
            actionFailures: [],
            userTraits,
            languageInstruction,
            isComplete: false,
            hasError: false,
            shouldStop: false,
            startTime,
            phase: "initialized"
        };

    } catch (error: any) {
        elizaLogger.error(`[ComprehensiveAnalysisWorkflow] Initialization failed: ${error.message}`);
        return {
            hasError: true,
            errorMessage: `Initialization failed: ${error.message}`,
            phase: "error"
        };
    }
}

/**
 * Extract analysis parameters from user request
 */
async function extractParameters(state: ComprehensiveAnalysisStateType): Promise<Partial<ComprehensiveAnalysisStateType>> {
    elizaLogger.info("[ComprehensiveAnalysisWorkflow] Extracting analysis parameters");

    try {
        const stopState = checkForStopRequest(state, 'parameter extraction');
        if (stopState) {
            elizaLogger.info("🛑 [ComprehensiveAnalysisWorkflow] Stop request received before parameter extraction");
            return stopState;
        }

        // Resolve user tier and data retention for parameter extraction (date range).
        // Resolved once here, then passed forward via state so executeActions
        // doesn't re-query per action.
        let dataRetentionInfo = "Free. Allowed: last 3 months (90 days).";
        let resolvedRetention: DataRetentionConfig | undefined;
        const userId = state.message?.userId;
        if (userId && state.runtime.agentId && userId !== state.runtime.agentId) {
            try {
                resolvedRetention = await getDataRetentionConfig(state.runtime, userId);
                if (resolvedRetention.dataRetentionMinDaysAgo != null && resolvedRetention.dataRetentionMaxDaysAgo != null) {
                    dataRetentionInfo = "Anonymous. Allowed: data between 1 and 3 months ago (30–90 days ago).";
                } else if (resolvedRetention.dataRetentionDays === 0) {
                    dataRetentionInfo = "Enterprise. Allowed: no limit.";
                } else if (resolvedRetention.dataRetentionDays === DATA_RETENTION_DAYS_BY_TIER.pro) {
                    dataRetentionInfo = "Pro. Allowed: last 24 months (730 days).";
                } else if (resolvedRetention.dataRetentionDays === DATA_RETENTION_DAYS_BY_TIER.plus) {
                    dataRetentionInfo = "Plus. Allowed: last 6 months (180 days).";
                } else if (resolvedRetention.dataRetentionDays === DATA_RETENTION_DAYS_BY_TIER.free) {
                    dataRetentionInfo = "Free. Allowed: last 3 months (90 days).";
                }
            } catch (err) {
                elizaLogger.warn(`[ComprehensiveAnalysisWorkflow] Data retention resolution failed: ${err}`);
            }
        }

        // Daily scheduler: canonical symbol is authoritative — never re-parse via LLM.
        // Only honored when source === "scheduler" so chat users cannot inject a fake symbol.
        const contentRecord = state.message?.content as Record<string, unknown> | undefined;
        const isSchedulerSource = state.message?.content?.source === "scheduler";
        const forcedRaw =
            isSchedulerSource &&
            typeof contentRecord?.[SCHEDULER_CANONICAL_SYMBOL_KEY] === "string"
                ? (contentRecord[SCHEDULER_CANONICAL_SYMBOL_KEY] as string)
                : undefined;

        if (forcedRaw !== undefined) {
            try {
                const canonical = sanitizeSymbol(forcedRaw).toUpperCase();
                elizaLogger.info(
                    `[ComprehensiveAnalysisWorkflow] Using scheduler canonical symbol (LLM extraction skipped): ${canonical}`,
                );
                return {
                    target: canonical,
                    parameters: buildSchedulerForcedParameters(canonical),
                    dataRetention: resolvedRetention,
                    phase: "parameters_extracted",
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                elizaLogger.error(
                    `[ComprehensiveAnalysisWorkflow] Invalid ${SCHEDULER_CANONICAL_SYMBOL_KEY}: ${msg}`,
                );
                return {
                    hasError: true,
                    errorMessage: `Invalid scheduler canonical symbol: ${forcedRaw}`,
                    phase: "error",
                };
            }
        }

        // Use the refined template to extract target and parameters
        const actionsTemplate = getComprehensiveAnalysisActionsTemplate();
        const actionsSystem = actionsTemplate.system;
        const actionsPrompt = actionsTemplate.prompt
            .replace('{{currentDate}}', new Date().toLocaleDateString())
            .replace('{{currentTimestamp}}', Date.now().toString())
            .replace('{{latestQuery}}', state.message.content.text || '')
            .replace('{{dataRetentionInfo}}', dataRetentionInfo);

        // Prepare image attachments for parameter extraction
        const imageAttachments = state.message.content.attachments
            ? ImageProcessor.createImageContentForLLM(state.message.content.attachments)
            : undefined;

        // Generate response to extract parameters
        const response = await generateText({
            runtime: state.runtime,
            system: actionsSystem,
            prompt: actionsPrompt,
            modelClass: ModelClass.SMALL,
            imageAttachments,
            userId: state.message.userId,
        });

        elizaLogger.info('Raw extraction response:', response);

        // Parse the JSON response
        const parsedResponse = parseJSONObjectFromText(response);

        if (parsedResponse && parsedResponse.target && parsedResponse.parameters) {
            elizaLogger.success(`Successfully extracted parameters for ${parsedResponse.target}:`, parsedResponse.parameters);
            return {
                target: parsedResponse.target,
                parameters: parsedResponse.parameters,
                dataRetention: resolvedRetention,
                phase: "parameters_extracted"
            };
        }

        throw new Error('Failed to parse JSON response from template');

    } catch (error: any) {
        elizaLogger.error(`[ComprehensiveAnalysisWorkflow] Parameter extraction failed: ${error.message}`);
        return {
            hasError: true,
            errorMessage: `Parameter extraction failed: ${error.message}`,
            phase: "error"
        };
    }
}

/**
 * Build a Memory entry for a failed action so it can be carried in
 * `state.actionResults` and surfaced in the comprehensive snapshot. Without
 * this, silently-failing tools (returning null/throwing) leave a hole in the
 * persisted snapshot — the UI ends up rendering "12/13" with no signal about
 * which step failed.
 *
 * The memory is intentionally NOT written to the message store: it only lives
 * in the workflow state so the snapshot can include it. We don't want a
 * "Sentiment_Analysis returned no result" row showing up in the chat
 * transcript itself.
 */
function buildFailedActionMemory(args: {
    actionConfig: ComprehensiveAnalysisActionConfig;
    state: ComprehensiveAnalysisStateType;
    actionParams: Record<string, unknown>;
    errorMessage: string;
}): Memory {
    const { actionConfig, state, actionParams, errorMessage } = args;
    return {
        id: uuidv4() as UUID,
        userId: state.runtime.agentId,
        agentId: state.runtime.agentId,
        content: {
            text: errorMessage,
            action: actionConfig.name,
            phase: actionConfig.phase,
            target: state.target,
            source: 'comprehensive_analysis',
            actionResultData: {
                action: actionConfig.name,
                parameters: actionParams,
                result: null,
                success: false,
                error: errorMessage,
            },
            metadata: {
                success: false,
                actionName: actionConfig.name,
                phase: actionConfig.phase,
                analysisType: 'comprehensive_analysis',
                isActionResponse: true,
                error: errorMessage,
            },
        },
        roomId: state.state?.roomId || state.runtime.agentId,
        createdAt: Date.now(),
    };
}

/**
 * Execute mandatory actions with staged parallelism (analysis phase runs concurrently)
 */
async function executeActions(state: ComprehensiveAnalysisStateType): Promise<Partial<ComprehensiveAnalysisStateType>> {
    elizaLogger.info(`[ComprehensiveAnalysisWorkflow] Starting action execution for ${state.target}`);

    // Early gate: reject invalid/adversarial symbols before burning any API quota.
    try {
        sanitizeSymbol(state.target);
    } catch (err) {
        if (err instanceof SymbolValidationError) {
            elizaLogger.error(`[ComprehensiveAnalysisWorkflow] Rejecting invalid symbol at execution start: ${err.message}`);
            return {
                hasError: true,
                errorMessage: `Invalid cryptocurrency symbol: ${String(state.target)}`,
                phase: "error",
            };
        }
        throw err;
    }

    const totalActions = COMPREHENSIVE_ANALYSIS_ACTIONS.length;
    const results: Memory[] = [...(state.actionResults || [])];
    const failures: string[] = [...(state.actionFailures || [])];
    const startIndex = state.currentActionIndex ?? 0;
    let latestCompletedIndex = startIndex;

    // Resolve data-retention config once per workflow run instead of 12 times
    // (once per action). Then apply the 30-day default cap so long windows
    // only kick in when the user explicitly asked for them.
    const rawRetention: DataRetentionConfig = state.dataRetention
        ?? await getDataRetentionConfig(state.runtime, state.message.userId);
    const dataRetention = applyDefaultWindowCap(rawRetention, state.parameters ?? {});

    const actionsWithIndex = COMPREHENSIVE_ANALYSIS_ACTIONS.map((action, index) => ({
        ...action,
        index
    }));

    type IndexedActionConfig = ComprehensiveAnalysisActionConfig & { index: number };

    const runAction = async (actionConfig: IndexedActionConfig) => {
        const actionIndex = actionConfig.index;
        const completedActions = actionIndex + 1;

        const stopBefore = checkForStopRequest(state, `action execution: ${actionConfig.name}`);
        if (stopBefore) {
            return { stopState: stopBefore };
        }

        elizaLogger.info(`🔄 Executing ${actionConfig.name} (${actionConfig.phase} phase) - ${completedActions}/${totalActions}`);
        logMemAt(`pre-action ${actionConfig.name}`, { idx: completedActions, of: totalActions });

        if (state.streamingCallback) {
            state.streamingCallback({
                id: uuidv4(),
                name: `action_start_${actionConfig.name.toLowerCase()}`,
                status: 'completed',
                message: `Starting ${actionConfig.name} (${completedActions}/${totalActions})`,
                timestamp: Date.now(),
                data: {
                    type: 'action_start',
                    actionName: actionConfig.name,
                    phase: actionConfig.phase,
                    progress: {
                        current: completedActions,
                        total: totalActions
                    }
                }
            });
        }

        const nonCEXActions = getNonCEXActions(state.runtime);
        const runtimeAction = nonCEXActions.find((a: Action) =>
            a.name === actionConfig.name ||
            a.name.toLowerCase().replace(/_/g, '') === actionConfig.name.toLowerCase().replace(/_/g, '')
        );

        if (!runtimeAction) {
            const failureMessage = `Action not found: ${actionConfig.name}`;
            elizaLogger.warn(`⚠️ ${failureMessage}`);
            failures.push(failureMessage);

            // Persist a failed-status row in actionResults so the snapshot
            // surfaces all 13 expected entries (otherwise a missing/failing
            // action makes the UI render "12/13 completed" with no signal
            // about which step failed).
            results.push(buildFailedActionMemory({
                actionConfig,
                state,
                actionParams: { target: state.target },
                errorMessage: failureMessage,
            }));

            if (state.streamingCallback) {
                state.streamingCallback({
                    id: uuidv4(),
                    name: `action_failed_${actionConfig.name.toLowerCase()}`,
                    status: 'completed',
                    message: `❌ ${failureMessage}`,
                    timestamp: Date.now(),
                    data: {
                        type: 'action_failed',
                        actionName: actionConfig.name,
                        phase: actionConfig.phase,
                        error: failureMessage,
                        progress: {
                            current: completedActions,
                            total: totalActions
                        }
                    }
                });
            }

            latestCompletedIndex = Math.max(latestCompletedIndex, completedActions);
            return {};
        }

        // dataRetention is resolved once per workflow in executeActions and only
        // spread into params for actions that declare consumesDataRetention.
        const actionParams = buildActionParams({
            actionConfig,
            target: state.target,
            parameters: state.parameters,
            dataRetention,
        });

        try {
            const memory: Memory = {
                id: uuidv4() as UUID,
                userId: state.runtime.agentId,
                agentId: state.runtime.agentId,
                content: {
                    text: `Execute ${actionConfig.name} for ${state.target}`,
                    action: actionConfig.name,
                    ...actionParams
                },
                roomId: state.state?.roomId || state.runtime.agentId,
                createdAt: Date.now()
            };

            const enhancedState = {
                ...state.state,
                comprehensiveAnalysisResults: [...results],
                currentPhase: actionConfig.phase,
                completedActions: completedActions - 1,
                totalActions
            };

            const actionResult = await executeActionWithCallback(
                runtimeAction,
                state.runtime,
                memory,
                enhancedState,
                actionParams,
                actionConfig,
                completedActions,
                totalActions,
                state.intermediateResultCallback,
                state.onToken
            );

            if (actionResult) {
                const displayText = actionResult.text
                    || (typeof actionResult.content === 'string' ? actionResult.content
                    : (actionResult.summary || `${actionConfig.name} completed successfully`));

                const actionResultData = {
                    action: actionConfig.name,
                    parameters: actionParams,
                    result: actionResult,
                    success: true
                };

                const resultMemory: Memory = {
                    id: uuidv4() as UUID,
                    userId: state.runtime.agentId,
                    agentId: state.runtime.agentId,
                    content: {
                        text: displayText,
                        action: actionConfig.name,
                        phase: actionConfig.phase,
                        target: state.target,
                        source: 'comprehensive_analysis',
                        actionResultData,
                        actionData: actionResult,
                        metadata: {
                            ...actionResult.metadata,
                            success: true,
                            actionName: actionConfig.name,
                            phase: actionConfig.phase,
                            analysisType: 'comprehensive_analysis',
                            isActionResponse: true
                        }
                    },
                    roomId: state.state?.roomId || state.runtime.agentId,
                    createdAt: Date.now()
                };

                results.push(resultMemory);
                logMemAt(`post-action ${actionConfig.name}`, {
                    idx: completedActions,
                    of: totalActions,
                    resultTextLen: typeof displayText === "string" ? displayText.length : 0,
                });

                const persistToChat = !isDailySchedulerMessage(state.message);
                try {
                    if (persistToChat) {
                        await state.runtime.messageManager.createMemory(resultMemory);
                        elizaLogger.success(`✅ ${actionConfig.name} completed successfully and stored in database`);
                    } else {
                        elizaLogger.success(
                            `✅ ${actionConfig.name} completed successfully (scheduler run; action memory not persisted)`,
                        );
                    }
                } catch (error: any) {
                    elizaLogger.error(`⚠️ ${actionConfig.name} completed but failed to store in database: ${error.message}`);
                }

                if (state.streamingCallback) {
                    const realtimeActionResult = {
                        action: actionConfig.name,
                        phase: actionConfig.phase,
                        status: 'success' as const,
                        content: displayText,
                        summary: (actionResult as any)?.summary || `${actionConfig.name} execution completed`
                    };

                    state.streamingCallback({
                        id: uuidv4(),
                        name: 'comprehensive_action_result',
                        status: 'completed',
                        message: `✅ ${actionConfig.name} completed successfully`,
                        timestamp: Date.now(),
                        data: {
                            type: 'comprehensive_action_result',
                            actionName: actionConfig.name,
                            phase: actionConfig.phase,
                            success: true,
                            progress: {
                                current: completedActions,
                                total: totalActions
                            },
                            actionResult: realtimeActionResult,
                            actionResultData
                        }
                    });
                }
            } else {
                const failureMessage = `${actionConfig.name} returned no result`;
                elizaLogger.warn(`⚠️ ${failureMessage}`);
                failures.push(failureMessage);

                // Mirror the failure into actionResults so the persisted
                // comprehensive snapshot still has an entry for this action.
                // Without this, a silently-failing tool (returning null) shows
                // up as a hole in the count: e.g. 12/13 instead of 12/13 with
                // a clearly failed Sentiment_Analysis row.
                results.push(buildFailedActionMemory({
                    actionConfig,
                    state,
                    actionParams,
                    errorMessage: failureMessage,
                }));

                if (state.streamingCallback) {
                    const failedActionResult = {
                        action: actionConfig.name,
                        phase: actionConfig.phase,
                        status: 'failed' as const,
                        content: failureMessage,
                        summary: `${actionConfig.name} execution failed - no result returned`
                    };

                    state.streamingCallback({
                        id: uuidv4(),
                        name: 'comprehensive_action_result',
                        status: 'completed',
                        message: `⚠️ ${failureMessage}`,
                        timestamp: Date.now(),
                        data: {
                            type: 'comprehensive_action_result',
                            actionName: actionConfig.name,
                            phase: actionConfig.phase,
                            success: false,
                            progress: {
                                current: completedActions,
                                total: totalActions
                            },
                            actionResult: failedActionResult
                        }
                    });
                }
            }
        } catch (error: any) {
            const failureMessage = `${actionConfig.name}: ${error.message}`;
            elizaLogger.error(`❌ Error executing ${actionConfig.name}:`, error);
            failures.push(failureMessage);

            // Same as the no-result branch above: keep failed actions visible
            // in the snapshot so the UI can render "12/13 - 1 failed" instead
            // of dropping the row entirely.
            results.push(buildFailedActionMemory({
                actionConfig,
                state,
                actionParams,
                errorMessage: error?.message
                    ? `${actionConfig.name}: ${error.message}`
                    : failureMessage,
            }));

            if (state.streamingCallback) {
                const errorActionResult = {
                    action: actionConfig.name,
                    phase: actionConfig.phase,
                    status: 'failed' as const,
                    content: `Error: ${error.message}`,
                    summary: `${actionConfig.name} execution failed - ${error.message}`
                };

                state.streamingCallback({
                    id: uuidv4(),
                    name: 'comprehensive_action_result',
                    status: 'completed',
                    message: `❌ Error in ${actionConfig.name}: ${error.message}`,
                    timestamp: Date.now(),
                    data: {
                        type: 'comprehensive_action_result',
                        actionName: actionConfig.name,
                        phase: actionConfig.phase,
                        success: false,
                        progress: {
                            current: completedActions,
                            total: totalActions
                        },
                        actionResult: errorActionResult
                    }
                });
            }
        }

        latestCompletedIndex = Math.max(latestCompletedIndex, completedActions);

        const stopAfter = checkForStopRequest(state, `action execution: ${actionConfig.name}`);
        if (stopAfter) {
            return { stopState: stopAfter };
        }

        return {};
    };

    const runSequential = async (group: IndexedActionConfig[], gcBetween = false) => {
        for (const action of group) {
            if (action.index < startIndex) {
                latestCompletedIndex = Math.max(latestCompletedIndex, action.index + 1);
                continue;
            }
            const outcome = await runAction(action);
            if (outcome.stopState) {
                return outcome;
            }
            // Optionally release native memory between actions. Phase 1 is the
            // heaviest allocator (HTTP fetches, news payloads, Tavily image
            // buffers); without an inter-action GC, RSS climbs cumulatively
            // even under serial execution because V8 won't trigger a major GC
            // until heap pressure builds — and the leak is in *native* memory
            // that doesn't show up as heap pressure.
            if (gcBetween) {
                await forceGcAt(`post-action.${action.name}`);
            }
        }
        return {};
    };

    const runParallel = async (group: IndexedActionConfig[], limit = 2) => {
        for (const action of group) {
            if (action.index < startIndex) {
                latestCompletedIndex = Math.max(latestCompletedIndex, action.index + 1);
            }
        }

        const actionsToRun = group.filter(action => action.index >= startIndex);
        if (actionsToRun.length === 0) {
            return {};
        }
        const runner = pLimit(limit);
        const outcomes = await Promise.all(
            actionsToRun.map(action => runner(() => runAction(action)))
        );
        const stopOutcome = outcomes.find(outcome => outcome.stopState);
        return stopOutcome || {};
    };

    const dataActions = actionsWithIndex.filter(action => action.phase === 'data_gathering');
    const analysisActions = actionsWithIndex.filter(action => action.phase === 'analysis');
    const predictionActions = actionsWithIndex.filter(action => action.phase !== 'data_gathering' && action.phase !== 'analysis');

    // Phase 1 was previously parallel-2 for user runs and serial for scheduler.
    // CloudWatch from staging (RSS 2.2 GB → 8.7 GB during a single XRP run, all
    // in *native* memory while heap stayed at 300–500 MB) showed concurrent
    // GET_ADDRESS + web_search overlapping for ~100 s caused the spike.
    // Two Tavily-backed actions (web_search, CRYPTO_RESEARCH_SEARCH) running
    // alongside other native HTTPS-heavy calls is what stacked the payloads —
    // exactly what the prior comment warned about. Serialize Phase 1 for all
    // callers and force GC between actions; the +30–60 s of latency is a
    // better tradeoff than OOM kills.
    const dataResult = await runSequential(dataActions, true);
    if (dataResult.stopState) {
        return {
            ...dataResult.stopState,
            actionResults: results,
            actionFailures: failures,
            currentActionIndex: latestCompletedIndex,
            dataRetention
        };
    }

    const analysisResult = await runParallel(analysisActions, 1);
    if (analysisResult.stopState) {
        return {
            ...analysisResult.stopState,
            actionResults: results,
            actionFailures: failures,
            currentActionIndex: latestCompletedIndex,
            dataRetention
        };
    }

    const predictionResult = await runSequential(predictionActions);
    if (predictionResult.stopState) {
        return {
            ...predictionResult.stopState,
            actionResults: results,
            actionFailures: failures,
            currentActionIndex: latestCompletedIndex,
            dataRetention
        };
    }

    elizaLogger.info(`📊 Analysis actions completed. Success: ${results.length}, Failures: ${failures.length}`);
    if (failures.length > 0) {
        elizaLogger.warn(`Failed actions: ${failures.join(', ')}`);
    }

    const postLoopStop = checkForStopRequest(state, 'action execution summary');
    if (postLoopStop) {
        return {
            ...postLoopStop,
            actionResults: results,
            actionFailures: failures,
            currentActionIndex: latestCompletedIndex
        };
    }

    if (state.streamingCallback) {
        const phaseStats = COMPREHENSIVE_ANALYSIS_ACTIONS.reduce((stats, action) => {
            const success = results.some(r => r.content.action === action.name);
            if (!stats[action.phase]) {
                stats[action.phase] = { total: 0, completed: 0, failed: 0 };
            }
            stats[action.phase].total++;
            if (success) {
                stats[action.phase].completed++;
            } else {
                stats[action.phase].failed++;
            }
            return stats;
        }, {} as Record<string, { total: number; completed: number; failed: number }>);

        const actionResults = results.map(result => ({
            action: result.content.action,
            phase: result.content.phase,
            status: 'success' as const,
            content: result.content.text || '',
            summary: (result.content.actionData as any)?.summary || `${result.content.action} execution completed`
        }));

        state.streamingCallback({
            id: uuidv4(),
            name: 'comprehensive_analysis_complete',
            status: 'completed',
            message: `🎉 Action execution completed: ${results.length}/${totalActions} actions successful`,
            timestamp: Date.now(),
            data: {
                type: 'comprehensive_analysis_complete',
                target: state.target,
                totalActions,
                successfulActions: results.length,
                failedActions: failures.length,
                phaseStats,
                failures,
                actionResults
            }
        });
    }

    // Force a major GC at the action/analysis boundary. The data-gathering
    // phase is the heaviest allocator (parallel HTTP fetches, getnews
    // payloads, intermediate LLM-rerank state). Local Playwright tracing
    // showed V8 reclaimed ~800 MB here on its own, but only after RSS hit
    // 3.2 GB. Forcing it deterministically caps the peak before
    // generateAnalysis builds the giant final-summary prompt and fires the
    // LARGE LLM call.
    await forceGcAt("post-executeActions");

    return {
        actionResults: results,
        actionFailures: failures,
        currentActionIndex: latestCompletedIndex,
        dataRetention,
        phase: "actions_completed"
    };
}


/**
 * Execute single action with hybrid callback/return pattern support
 */
async function executeActionWithCallback(
    action: Action,
    runtime: IAgentRuntime,
    memory: Memory,
    state: any,
    params: any,
    actionConfig: { name: string; phase: string },
    currentAction: number,
    totalActions: number,
    intermediateResultCallback?: (response: Memory) => void,
    onToken?: (delta: string) => void | Promise<void>,
): Promise<any> {
    return new Promise((resolve, reject) => {
        let callbackResult: any = null;
        let callbackCalled = false;
        let promiseResolved = false;

        // Create callback function for actions that use callbacks
        const callback: HandlerCallback = async (content: any, loadingId?: string) => {
            elizaLogger.info(`[ComprehensiveAnalysisWorkflow] Callback received for ${actionConfig.name}`);

            // Enhance content with action metadata
            const enhancedContent = {
                ...content,
                metadata: {
                    ...content.metadata,
                    isActionResponse: true,
                    actionName: actionConfig.name,
                    phase: actionConfig.phase,
                    success: true,
                    analysisType: 'comprehensive_analysis',
                    progress: {
                        current: currentAction,
                        total: totalActions
                    }
                }
            };

            // Stream all action results in real-time for comprehensive analysis
            if (intermediateResultCallback) {
                try {
                    const comprehensiveStreamContent = {
                        ...enhancedContent,
                        source: "comprehensive_analysis",
                        metadata: {
                            ...enhancedContent.metadata,
                            isComprehensiveAction: true,
                            actionName: actionConfig.name,
                            phase: actionConfig.phase,
                            progress: {
                                current: currentAction,
                                total: totalActions
                            }
                        }
                    };

                    const streamMemory: Memory = {
                        id: uuidv4() as UUID,
                        userId: runtime.agentId,
                        agentId: runtime.agentId,
                        roomId: state?.roomId || runtime.agentId,
                        createdAt: Date.now(),
                        content: comprehensiveStreamContent
                    };

                    elizaLogger.info(`[ComprehensiveAnalysisWorkflow] Streaming real-time action result for ${actionConfig.name} (${currentAction}/${totalActions})`);
                    intermediateResultCallback(streamMemory);
                } catch (error: any) {
                    elizaLogger.error(`[ComprehensiveAnalysisWorkflow] Failed to stream real-time action result: ${error.message}`);
                }
            }

            // Store the result
            callbackResult = enhancedContent;
            callbackCalled = true;

            // Capture actionData from metadata if present
            if (enhancedContent.metadata?.actionData) {
                elizaLogger.info(`[ComprehensiveAnalysisWorkflow] Captured actionData from callback metadata for ${actionConfig.name}`);
                callbackResult.actionData = enhancedContent.metadata.actionData;
            }

            // Resolve immediately for all callbacks
            elizaLogger.info(`[ComprehensiveAnalysisWorkflow] Callback received for ${actionConfig.name}, resolving`);
            if (!promiseResolved) {
                promiseResolved = true;
                resolve(callbackResult);
            }

            return [];
        };

        elizaLogger.info(`[ComprehensiveAnalysisWorkflow] Executing action ${actionConfig.name} with hybrid callback/return pattern`);

        // AbortController so the 300s timeout below can actually cancel
        // in-flight fetch / LLM calls that read options.signal.
        const controller = new AbortController();
        const paramsWithSignal = {
            ...params,
            signal: controller.signal,
            // Forward per-token streaming into the action so its internal
            // generateText calls can fire SSE deltas live. Actions that
            // don't read options.onToken simply ignore it.
            ...(onToken ? { onToken } : {}),
        };

        // Execute the action handler with callback
        const handlerPromise = action.handler(runtime, memory, state, paramsWithSignal, callback);

        handlerPromise
            .then((handlerResult) => {
                // Capture structured data from action return
                if (handlerResult && typeof handlerResult === 'object') {
                    elizaLogger.info(`[ComprehensiveAnalysisWorkflow] Action ${actionConfig.name} returned structured data`);

                    // Store the data in callback result for comprehensive analysis usage
                    if (callbackResult) {
                        callbackResult.actionData = handlerResult;
                    }

                    // If it has display content, use it directly
                    if ((handlerResult as any).text || (handlerResult as any).content) {
                        const enhancedResult = {
                            ...handlerResult,
                            actionData: handlerResult,
                            metadata: {
                                // Merge callback metadata first (contains UI data like chartPath)
                                ...(callbackResult?.metadata || {}),
                                // Then merge action return metadata
                                ...((handlerResult as any).metadata || {}),
                                isActionResponse: true,
                                actionName: actionConfig.name,
                                phase: actionConfig.phase,
                                success: true,
                                analysisType: 'comprehensive_analysis',
                                progress: {
                                    current: currentAction,
                                    total: totalActions
                                }
                            }
                        };
                        if (!promiseResolved) {
                            promiseResolved = true;
                            resolve(enhancedResult);
                        }
                        return;
                    }
                }

                // If callback wasn't called, use handler result (legacy pattern)
                if (!callbackCalled) {
                    elizaLogger.info(`[ComprehensiveAnalysisWorkflow] No callback for ${actionConfig.name}, using handler result - resolving immediately`);
                    const result = (typeof handlerResult === 'object' && handlerResult !== null ? handlerResult : {}) as any;

                    const enhancedResult = {
                        ...result,
                        actionData: handlerResult,
                        text: result.text || `Action ${actionConfig.name} completed`,
                        metadata: {
                            // Merge callback metadata first (contains UI data like chartPath)
                            ...(callbackResult?.metadata || {}),
                            // Then merge action return metadata
                            ...(result.metadata || {}),
                            isActionResponse: true,
                            actionName: actionConfig.name,
                            phase: actionConfig.phase,
                            success: !!handlerResult,
                            analysisType: 'comprehensive_analysis',
                            progress: {
                                current: currentAction,
                                total: totalActions
                            }
                        }
                    };

                    // Stream legacy pattern results in real-time as well.
                    // Skip PREDICTION: its content is extracted and emitted from generateAnalysis() below.
                    if (intermediateResultCallback && actionConfig.name !== 'PREDICTION') {
                        try {
                            const legacyStreamContent = {
                                ...enhancedResult,
                                source: "comprehensive_analysis",
                                metadata: {
                                    ...enhancedResult.metadata,
                                    isComprehensiveAction: true
                                }
                            };

                            const legacyStreamMemory: Memory = {
                                id: uuidv4() as UUID,
                                userId: runtime.agentId,
                                agentId: runtime.agentId,
                                roomId: memory.roomId,
                                createdAt: Date.now(),
                                content: legacyStreamContent
                            };

                            elizaLogger.info(`[ComprehensiveAnalysisWorkflow] Streaming legacy action result for ${actionConfig.name} (${currentAction}/${totalActions})`);
                            intermediateResultCallback(legacyStreamMemory);
                        } catch (error: any) {
                            elizaLogger.error(`[ComprehensiveAnalysisWorkflow] Failed to stream legacy action result: ${error.message}`);
                        }
                    }

                    elizaLogger.info(`[ComprehensiveAnalysisWorkflow] Resolving ${actionConfig.name} with enhanced result`);
                    if (!promiseResolved) {
                        promiseResolved = true;
                        resolve(enhancedResult);
                    }
                    return;
                }
                // Callback was already called and resolved, no additional action needed
            })
            .catch((error) => {
                if (!promiseResolved) {
                    promiseResolved = true;
                    reject(error);
                }
            });

        // Timeout: abort the controller so any fetch/LLM call reading
        // options.signal terminates, freeing memory instead of orphaning.
        const timeoutHandle = setTimeout(() => {
            if (!promiseResolved) {
                elizaLogger.warn(`[ComprehensiveAnalysisWorkflow] Action ${actionConfig.name} timed out after 300 seconds`);
                controller.abort();
                promiseResolved = true;
                reject(new Error(`Action ${actionConfig.name} timed out`));
            }
        }, 300000);

        handlerPromise.finally(() => clearTimeout(timeoutHandle));
    });
}

/**
 * Extract number of days from from/to date range. Accepts YYYY-MM-DD or YYYY-MM-DDTHH:mm. Returns 30 if either is missing or invalid.
 */
function extractDaysFromFromTo(from?: string, to?: string): number {
    if (!from || !to || typeof from !== 'string' || typeof to !== 'string') return 30;
    const fromNorm = from.trim();
    const toNorm = to.trim();
    const fromDate = new Date(fromNorm.length === 10 ? fromNorm + 'T00:00:00.000Z' : fromNorm);
    const toDate = new Date(toNorm.length === 10 ? toNorm + 'T23:59:59.999Z' : toNorm);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate > toDate) return 30;
    const diffTime = toDate.getTime() - fromDate.getTime();
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * Clean and validate text content for LLM processing
 */
function cleanTextForLLM(text: string): string {
    if (!text || typeof text !== 'string') {
        return '';
    }

    // Remove or replace problematic characters that might cause API issues
    return text
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remove control characters
        .replace(/[\u2000-\u206F\u2E00-\u2E7F\uFFF0-\uFFFF]/g, '') // Remove problematic Unicode
        .replace(/\s+/g, ' ') // Normalize whitespace
        .trim();
}

/**
 * Validate and sanitize the final prompt before sending to LLM
 */
export function validateAndSanitizePrompt(prompt: string, maxLength = 40000): {
    sanitizedPrompt: string;
    warnings: string[];
    stats: {
        originalLength: number;
        finalLength: number;
        truncated: boolean;
    };
} {
    const warnings: string[] = [];
    let sanitizedPrompt = prompt;
    const originalLength = prompt.length;

    // Clean the prompt
    sanitizedPrompt = cleanTextForLLM(sanitizedPrompt);

    // Detect unresolved handlebars-style placeholders separately from literal
    // `undefined` content so logs point to the real source of the issue.
    const unresolvedPlaceholders = Array.from(
        new Set(sanitizedPrompt.match(/\{\{[^{}]+\}\}/g) ?? [])
    );
    if (unresolvedPlaceholders.length > 0) {
        const preview = unresolvedPlaceholders.slice(0, 5).join(", ");
        warnings.push(
            `Prompt contains unresolved template placeholders: ${preview}${unresolvedPlaceholders.length > 5 ? ", ..." : ""}`
        );
        sanitizedPrompt = sanitizedPrompt.replace(
            /\{\{([^{}]+)\}\}/g,
            (_match, key: string) => `[unresolved:${key.trim()}]`
        );
    }

    // Only flag bare `undefined` tokens. `null` is valid JSON and appears
    // constantly in action-data payloads, so suppress it here.
    const undefinedMatches = sanitizedPrompt.match(/\bundefined\b/g);
    if (undefinedMatches) {
        warnings.push(`Prompt contains literal undefined values (${undefinedMatches.length})`);
        sanitizedPrompt = sanitizedPrompt.replace(/\bundefined\b/g, '[undefined]');
    }

    // Check for excessive repetition
    const lines = sanitizedPrompt.split('\n');
    const duplicateLines = lines.filter((line, index) =>
        line.trim() && lines.indexOf(line) !== index && line.length > 20
    );
    if (duplicateLines.length > 5) {
        warnings.push(`Detected ${duplicateLines.length} duplicate lines in prompt`);
    }

    // Handle length truncation more intelligently
    let truncated = false;
    if (sanitizedPrompt.length > maxLength) {
        truncated = true;
        warnings.push(`Prompt length (${sanitizedPrompt.length}) exceeds limit (${maxLength})`);

        // Try to preserve the template and instructions while truncating data
        const parts = sanitizedPrompt.split('## Available Data from Analysis Actions');
        if (parts.length === 2) {
            const templatePart = parts[0];
            const dataPart = parts[1];

            const maxDataLength = maxLength - templatePart.length - 500; // Reserve space for instructions
            if (maxDataLength > 1000) {
                const truncatedData = dataPart.substring(0, maxDataLength);
                sanitizedPrompt = templatePart + '## Available Data from Analysis Actions' + truncatedData + '\n\n[Data truncated to fit API limits...]';
            } else {
                // Fallback: simple truncation
                sanitizedPrompt = sanitizedPrompt.substring(0, maxLength) + '\n\n[Prompt truncated to fit API limits...]';
            }
        } else {
            // Simple truncation if structure is unexpected
            sanitizedPrompt = sanitizedPrompt.substring(0, maxLength) + '\n\n[Prompt truncated to fit API limits...]';
        }
    }

    return {
        sanitizedPrompt,
        warnings,
        stats: {
            originalLength,
            finalLength: sanitizedPrompt.length,
            truncated
        }
    };
}

export interface FormatOptions {
    totalBudget?: number;
}

/**
 * Default prompt budget for formatted action results. Sized for
 * gemini-3-pro-preview / gemini-3.1-pro (1M-token input window).
 * 150,000 chars ≈ 40K tokens ≈ <5% of model capacity. Override via
 * COMPREHENSIVE_ANALYSIS_PROMPT_BUDGET env var for other models / cost tuning.
 */
export const PROMPT_BUDGET_DEFAULT = 150_000;

function resolvePromptBudget(): number {
    const raw = process.env.COMPREHENSIVE_ANALYSIS_PROMPT_BUDGET;
    const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : PROMPT_BUDGET_DEFAULT;
}

/**
 * Format action results into a single string for the analysis-generation LLM.
 *
 * Per-action payloads are capped by `promptMaxChars` from COMPREHENSIVE_ANALYSIS_ACTIONS
 * and truncated at the nearest newline so JSON structures aren't chopped mid-token.
 * Each payload is wrapped in <<EXTERNAL_DATA>> sentinel markers so the model
 * (instructed via system prompt) treats it as reference material, not commands.
 *
 * When the aggregate exceeds the total budget, **lowest-priority actions are
 * dropped whole** rather than substring-truncating the tail. This preserves
 * PREDICTION (priority 1) even under tight budgets — previously the
 * substring-from-head approach would silently chop the final prediction phase.
 */
export function formatActionResultsForAnalysis(
    results: Memory[],
    actionConfigs: ComprehensiveAnalysisActionConfig[] = COMPREHENSIVE_ANALYSIS_ACTIONS,
    options: FormatOptions = {},
): string {
    elizaLogger.info("📋 Formatting action results for comprehensive analysis");

    if (results.length === 0) {
        return "No action results available.";
    }

    const totalBudget = options.totalBudget ?? resolvePromptBudget();
    const configByName = new Map(actionConfigs.map(c => [c.name, c]));

    interface Formatted {
        actionName: string;
        phase: string;
        priority: number;
        text: string;
    }

    const formatted: Formatted[] = results.map(result => {
        const content = result.content as any;
        const actionName = content.action ?? "UNKNOWN";
        const cfg = configByName.get(actionName);
        const perCap = cfg?.promptMaxChars ?? 2000;
        const priority = cfg?.promptPriority ?? 99;
        const phase = content.phase ?? "unknown";

        const actionData = content.actionData || (content.actionResultData as any)?.result;
        let payload: string;
        if (actionData && typeof actionData === "object") {
            try {
                const { chartPath, chartPaths, ...cleanActionData } = actionData as any;
                payload = JSON.stringify(cleanActionData, null, 2);
            } catch {
                payload = "[Failed to serialize actionData]";
            }
        } else if (content.text) {
            payload = String(content.text);
        } else {
            const metadata = content.metadata as any;
            payload = `Status: ${metadata?.success ? "Completed" : "Failed"}`;
        }

        // Nearest-newline truncation: prefer cutting at a line boundary to avoid
        // breaking a JSON key/value pair mid-token. Only fall back to hard cut
        // if no reasonable boundary exists in the tail portion.
        if (payload.length > perCap) {
            const slice = payload.slice(0, perCap);
            const lastNewline = slice.lastIndexOf("\n");
            const cutAt = lastNewline > perCap * 0.6 ? lastNewline : perCap;
            payload = slice.slice(0, cutAt) + "\n[truncated]";
        }

        const wrapped = wrapExternalData(actionName, payload);
        return { actionName, phase, priority, text: wrapped };
    });

    // Drop lowest-priority (highest number) first when over budget.
    const sortedByPriority = [...formatted].sort((a, b) => a.priority - b.priority);
    const kept: Formatted[] = [];
    let runningLen = 0;
    const overheadPerAction = 50;

    for (const item of sortedByPriority) {
        const proposed = runningLen + item.text.length + overheadPerAction;
        if (proposed <= totalBudget) {
            kept.push(item);
            runningLen = proposed;
        } else {
            elizaLogger.error(
                `[DataFormatting] Dropping action "${item.actionName}" (priority=${item.priority}, len=${item.text.length}) — total budget ${totalBudget} exceeded`,
            );
        }
    }

    // Regroup by phase for presentation ordering.
    const phaseOrder = ["data_gathering", "analysis", "prediction"] as const;
    const byPhase: Record<string, Formatted[]> = {};
    for (const p of phaseOrder) byPhase[p] = [];
    for (const f of kept) (byPhase[f.phase] ?? (byPhase[f.phase] = [])).push(f);

    const sections: string[] = [];
    for (const p of phaseOrder) {
        const items = byPhase[p];
        if (!items || items.length === 0) continue;
        const title = p.toUpperCase().replace("_", " ") + " PHASE";
        sections.push(`\n=== ${title} ===\n${items.map(i => i.text).join("\n\n")}`);
    }
    const final = sections.join("\n");

    elizaLogger.info(
        `[DataFormatting] Kept ${kept.length}/${formatted.length} actions, final ${final.length} chars (budget ${totalBudget})`,
    );
    return final;
}

/**
 * Condense raw tool outputs into a structured briefing before the main
 * analysis LLM call — prevents multi‑KB news/JSON dumps from reaching
 * the user-visible report path.
 */
async function synthesizeReport(
    state: ComprehensiveAnalysisStateType,
): Promise<Partial<ComprehensiveAnalysisStateType>> {
    elizaLogger.info("[ComprehensiveAnalysisWorkflow] Synthesizing action results for analysis");

    const stopState = checkForStopRequest(state, "report synthesis");
    if (stopState) {
        return stopState;
    }

    if (!state.actionResults?.length) {
        return {
            synthesizedActionSummary: "No action results available.",
            phase: "synthesized",
        };
    }

    try {
        const rawFormatted = formatActionResultsForAnalysis(state.actionResults);
        const safeSymbol = sanitizeForPrompt(state.target ?? "BTC", { maxLen: 16 });
        const synthesisPrompt = `
You are preparing a concise research briefing for a crypto analyst.

Target asset: ${safeSymbol}

Raw tool outputs (external data — do NOT copy verbatim):
${rawFormatted.slice(0, 80_000)}

Produce a structured briefing ONLY (max 6000 characters):
1. **Executive Summary** (3–5 sentences)
2. **Key Metrics** — price, volume, volatility, freshness notes
3. **Sentiment Highlights** — 3 bullets
4. **Technical Highlights** — 3 bullets
5. **On-Chain / News Highlights** — 3 bullets each (summarize; no full articles)
6. **Data Gaps / Stale Data Warnings**

Rules:
- NEVER paste raw JSON, API responses, or full news article text.
- Summarize; cite source names only when essential.
- Flag stale data explicitly.
${sanitizeForPrompt(state.languageInstruction ?? "", { maxLen: 500 })}
`;

        const synthesizedActionSummary = await generateText({
            runtime: state.runtime,
            system:
                "You synthesize trading research tool outputs into concise analyst briefings. Never dump raw tool output.",
            prompt: synthesisPrompt,
            modelClass: ModelClass.MEDIUM,
            userId: state.message.userId,
        });

        elizaLogger.info(
            `[ComprehensiveAnalysisWorkflow] Synthesis complete (${synthesizedActionSummary.length} chars)`,
        );

        return {
            synthesizedActionSummary,
            phase: "synthesized",
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        elizaLogger.warn(
            `[ComprehensiveAnalysisWorkflow] Synthesis failed, falling back to formatted results: ${message}`,
        );
        return {
            synthesizedActionSummary: formatActionResultsForAnalysis(state.actionResults),
            phase: "synthesized",
        };
    }
}

/**
 * Generate comprehensive analysis content using LLM template (same approach as original handler)
 */
async function generateAnalysis(state: ComprehensiveAnalysisStateType): Promise<Partial<ComprehensiveAnalysisStateType>> {
    elizaLogger.info(`[ComprehensiveAnalysisWorkflow] Generating comprehensive analysis content for ${state.target}`);

    const bypassModelClassDowngrades =
        state.message?.content?.source === "scheduler";

    try {
        const stopState = checkForStopRequest(state, 'analysis generation');
        if (stopState) {
            elizaLogger.info("🛑 [ComprehensiveAnalysisWorkflow] Stop request received before analysis generation");
            return stopState;
        }

        // Create context with all available data (same approach as original)
        const currentDate = new Date().toLocaleDateString();
        const cryptoName = state.parameters.cryptoName || state.target;

        // Sanitize all dynamic variables entering the prompt template.
        // Invalid symbols are rejected here and surfaced as an error state —
        // callers see "Invalid cryptocurrency symbol" rather than letting a
        // prompt-injection payload reach the model.
        let safeSymbol: string;
        let safeCryptoName: string;
        try {
            safeSymbol = sanitizeSymbol(state.target);
            // cryptoName allows spaces ("Bitcoin"); sanitizeForPrompt rather than sanitizeSymbol.
            safeCryptoName = sanitizeForPrompt(cryptoName, { maxLen: 64 }) || safeSymbol;
        } catch (err) {
            if (err instanceof SymbolValidationError) {
                elizaLogger.error(`[ComprehensiveAnalysisWorkflow] Symbol validation failed: ${err.message}`);
                return {
                    hasError: true,
                    errorMessage: `Invalid cryptocurrency symbol: ${String(state.target)}`,
                    phase: "error",
                };
            }
            throw err;
        }

        // Prefer pre-synthesized briefing over raw tool payloads
        const formattedResults =
            state.synthesizedActionSummary?.trim()
            || formatActionResultsForAnalysis(state.actionResults);

        // System: static template (no per-request replacements to preserve prompt caching)
        const analysisSystem = comprehensive_analysis.system;

        // Prompt: all dynamic content (including crypto-specific context)
        const safeUserTraits = state.userTraits
            ? sanitizeForPrompt(state.userTraits, { maxLen: 4000 })
            : "";
        const userTraitsSection = safeUserTraits ? `\n${safeUserTraits}\n` : "";
        const safeLanguageInstruction = sanitizeForPrompt(state.languageInstruction ?? "", { maxLen: 500 });
        const safeUserRequest = sanitizeForPrompt(state.message?.content?.text ?? "", { maxLen: 2000 });

        const dynamicPrompt = `
## User Request
${safeUserRequest}

## Analysis Target
- **Cryptocurrency**: ${safeCryptoName}
- **Token Symbol**: ${safeSymbol}
- **Analysis Date**: ${currentDate}

${userTraitsSection}
## Available Data from Analysis Actions

${formattedResults}

## Instructions
Based on the synthesized research briefing above (NOT raw tool dumps), generate a complete comprehensive analysis following the structured template. Integrate all available data points and provide specific, actionable insights.
NEVER output raw JSON, unformatted news feeds, or verbatim API responses. Always synthesize into readable prose with clear sections.
${safeUserTraits ? "\n**Important**: Tailor your investment recommendations and risk assessments based on the user's investment profile provided above. Consider their preferences, risk tolerance, and any cautionary notes when making recommendations.\n" : ""}
Focus Areas:
1. **Executive Summary** (300-400 words)
2. **Market Data and Current Status** with specific numbers from price data
3. **Sentiment Analysis** (500 words) using sentiment intelligence data
4. **On-Chain Data Analysis** (500 words) using whale and flow data
5. **Technical Analysis** (500 words) using technical indicators
6. **Price Predictions and Forecasting Analysis** (400-500 words) with confidence intervals, bull/base/bear scenarios, and the structured format defined in the template
7. **Investment Recommendations** with specific allocation percentages
8. **Strategic Conclusion** (300-400 words) with clear BUY/HOLD/SELL recommendation

Generate the analysis now:
${safeLanguageInstruction}
`;

        // Validate and sanitize the prompt. Cap raised from 40K (Gemini 1.5 era)
        // to 200K to suit gemini-3-pro-preview's 1M-token context; still <6% of
        // model capacity.
        const validation = validateAndSanitizePrompt(dynamicPrompt, 200_000);

        // Log validation results
        elizaLogger.info(`[PromptValidation] Original: ${validation.stats.originalLength}, Final: ${validation.stats.finalLength}, Truncated: ${validation.stats.truncated}`);
        if (validation.warnings.length > 0) {
            elizaLogger.warn(`[PromptValidation] Warnings: ${validation.warnings.join(', ')}`);
        }

        const sanitizedPrompt = validation.sanitizedPrompt;

        // Prepare image attachments for analysis generation
        const imageAttachments = state.message?.content.attachments
            ? ImageProcessor.createImageContentForLLM(state.message.content.attachments)
            : undefined;

        // GC before the LARGE LLM call: validateAndSanitizePrompt + the
        // template-string concatenation that built `dynamicPrompt` left
        // intermediate string allocations (the un-sanitized 200K-char
        // version, the formattedResults concat, etc.) on the heap. Reclaim
        // them before opening the streaming response Buffer pool.
        await forceGcAt("pre-finalSummary");

        logMemAt(`pre-finalSummary`, { promptLen: sanitizedPrompt.length, modelClass: "LARGE" });

        // Generate comprehensive analysis content
        const analysisContent = await generateText({
            runtime: state.runtime,
            system: analysisSystem,
            prompt: sanitizedPrompt,
            modelClass: ModelClass.LARGE, // Use large model for comprehensive analysis
            imageAttachments,
            userId: state.message.userId,
            bypassModelClassDowngrades,
        });

        logMemAt(`post-finalSummary`, { responseLen: analysisContent.length });

        // GC after the LARGE LLM call: the streaming response landed as a
        // chain of native arrayBuffers (we measured +49 MB on a small flash
        // model; production's pro-preview returns ~4-8x more text → ~200-400
        // MB of native Buffers). Releasing them before HTML rendering /
        // S3 upload prevents stacking with the next phase's allocations.
        await forceGcAt("post-finalSummary");
        elizaLogger.success(`✅ Generated comprehensive analysis content (${analysisContent.length} characters)`);

        const postGenerationStop = checkForStopRequest(state, 'analysis generation');
        if (postGenerationStop) {
            elizaLogger.info("🛑 [ComprehensiveAnalysisWorkflow] Stop request received after analysis generation");
            return postGenerationStop;
        }

        // ── Extract Section 11 (Price Predictions) and emit as PREDICTION card ──
        // The PREDICTION plugin skips its own LLM call in comprehensive mode.
        // We merge its prompt into this generateAnalysis call and back-fill the
        // PREDICTION action result with the actual extracted prediction text so
        // the 3.1 Prediction card shows real content, not a stub.
        let predictionActionResult: Memory | null = null;
        try {
            // Match by section name so it works regardless of the section number
            // the LLM assigns (could be "6." or "11." depending on LLM context).
            const predMatch = analysisContent.match(
                /#{0,3}\s*(?:[0-9]+[.\s]+)?Price Predictions?[^\n]*\n([\s\S]*?)(?=#{1,3}|$)/i
            );
            const predictionText = predMatch ? predMatch[1].trim() : "";

            if (predictionText) {
                predictionActionResult = {
                    id: uuidv4() as UUID,
                    userId: state.runtime.agentId,
                    agentId: state.runtime.agentId,
                    roomId: state.message.roomId || (state.state as any)?.roomId || state.runtime.agentId,
                    createdAt: Date.now(),
                    content: {
                        text: predictionText,
                        action: "PREDICTION",
                        type: "prediction",
                        target: state.target,
                        source: "crypto_prediction_action",
                        metadata: {
                            actionName: "PREDICTION",
                            type: "prediction",
                            predictionType: "crypto_market_analysis",
                            mode: "comprehensive",
                            analysisDepth: "comprehensive",
                            isActionResponse: true,
                            mergedFromFinalSummary: true,
                        },
                    },
                } as Memory;

                state.intermediateResultCallback?.(predictionActionResult);
                elizaLogger.info(
                    `[ComprehensiveAnalysisWorkflow] PREDICTION result extracted (${predictionText.length} chars) and emitted`
                );
            } else {
                elizaLogger.warn("[ComprehensiveAnalysisWorkflow] Section 11 not found in analysis content — PREDICTION card will be empty");
            }
        } catch (predErr: any) {
            elizaLogger.warn(`[ComprehensiveAnalysisWorkflow] Failed to extract prediction section: ${predErr.message}`);
        }
        // ─────────────────────────────────────────────────────────────────────

        // Tell the SSE endpoint the user-visible answer is ready. The endpoint
        // closes the stream now; everything that follows (HTML render, S3
        // upload, report metadata, snapshot generation) keeps running in this
        // worker but no longer holds the client connection open.
        try {
            state.onAnalysisComplete?.(analysisContent);
        } catch (err) {
            elizaLogger.debug("[ComprehensiveAnalysisWorkflow] onAnalysisComplete threw", err);
        }

        return {
            analysisContent,
            phase: "analysis_generated",
            ...(predictionActionResult
                ? {
                    // Replace the empty default PREDICTION action result with the
                    // extracted-from-final-summary one. Without this filter, the
                    // navigation panel ends up showing both 3.1 (empty stub) and
                    // 3.2 (real content).
                    actionResults: [
                        ...(state.actionResults || []).filter(
                            (r: any) =>
                                r?.content?.action !== "PREDICTION" &&
                                r?.content?.metadata?.actionName !== "PREDICTION"
                        ),
                        predictionActionResult,
                    ],
                }
                : {}),
        };

    } catch (error: any) {
        elizaLogger.error(`[ComprehensiveAnalysisWorkflow] Analysis generation failed: ${error.message}`);

        // Fallback with simpler prompt if the main one fails
        try {
            elizaLogger.warn('[ComprehensiveAnalysisWorkflow] Trying fallback minimal analysis prompt');

            const minimalTemplate = `
Analyze ${state.parameters.cryptoName || state.target} (${state.target}) cryptocurrency.

## User Request
${state.message?.content?.text ?? ""}

## Basic Information
Date: ${new Date().toLocaleDateString()}
Target: ${state.target}
Data Available: ${state.actionResults.length} analysis actions completed

## Task
Provide a comprehensive investment analysis covering:
1. Executive Summary
2. Market Overview
3. Risk Assessment
4. Investment Recommendation

Generate a detailed analysis now:
${state.languageInstruction || ""}
`;

            // Validate fallback prompt as well
            const fallbackValidation = validateAndSanitizePrompt(minimalTemplate, 40000);
            elizaLogger.info(`[FallbackValidation] Original: ${fallbackValidation.stats.originalLength}, Final: ${fallbackValidation.stats.finalLength}`);

            const minimalContext = composeContext({
                state: state.state || { agentId: state.runtime.agentId } as State,
                template: fallbackValidation.sanitizedPrompt
            });

            const fallbackContent = await generateText({
                runtime: state.runtime,
                prompt: minimalContext,
                modelClass: ModelClass.LARGE,
                userId: state.message.userId,
                bypassModelClassDowngrades,
            });

            elizaLogger.success(`✅ Generated fallback analysis content (${fallbackContent.length} characters)`);

            const fallbackStop = checkForStopRequest(state, 'analysis generation');
            if (fallbackStop) {
                elizaLogger.info("🛑 [ComprehensiveAnalysisWorkflow] Stop request received after fallback analysis generation");
                return fallbackStop;
            }

            try {
                state.onAnalysisComplete?.(fallbackContent);
            } catch (err) {
                elizaLogger.debug("[ComprehensiveAnalysisWorkflow] onAnalysisComplete threw (fallback)", err);
            }

            return {
                analysisContent: fallbackContent,
                phase: "analysis_generated"
            };

        } catch (fallbackError: any) {
            elizaLogger.error(`[ComprehensiveAnalysisWorkflow] Fallback analysis also failed: ${fallbackError.message}`);
            return {
                hasError: true,
                errorMessage: `Analysis generation failed: ${error.message}. Fallback also failed: ${fallbackError.message}`,
                phase: "error"
            };
        }
    }
}

/**
 * Create HTML report using existing function
 */
async function createHTMLReport(state: ComprehensiveAnalysisStateType): Promise<Partial<ComprehensiveAnalysisStateType>> {
    elizaLogger.info(`[ComprehensiveAnalysisWorkflow] Creating HTML report for ${state.target}`);

    try {
        const stopState = checkForStopRequest(state, 'html report creation');
        if (stopState) {
            elizaLogger.info("🛑 [ComprehensiveAnalysisWorkflow] Stop request received before HTML report creation");
            return stopState;
        }

        const currentDate = new Date().toLocaleDateString();

        const htmlReport = createComprehensiveAnalysisHTML(
            state.parameters.cryptoName || state.target,
            state.target,
            currentDate,
            state.analysisContent,
            state.message.content.text || '',
            state.actionResults,
            state.message?.content?.language
        );

        elizaLogger.success(`✅ HTML report created (${htmlReport.length} characters)`);

        const postHtmlStop = checkForStopRequest(state, 'html report creation');
        if (postHtmlStop) {
            elizaLogger.info("🛑 [ComprehensiveAnalysisWorkflow] Stop request received after HTML report creation");
            return postHtmlStop;
        }

        return {
            htmlReport,
            phase: "html_created"
        };

    } catch (error: any) {
        elizaLogger.error(`[ComprehensiveAnalysisWorkflow] HTML report creation failed: ${error.message}`);
        return {
            hasError: true,
            errorMessage: `HTML report creation failed: ${error.message}`,
            phase: "error"
        };
    }
}

/**
 * Save report to saved_data/Reports directory
 */
async function saveReport(state: ComprehensiveAnalysisStateType): Promise<Partial<ComprehensiveAnalysisStateType>> {
    elizaLogger.info(`[ComprehensiveAnalysisWorkflow] Saving comprehensive analysis report for ${state.target}`);

    try {
        const stopState = checkForStopRequest(state, 'report saving');
        if (stopState) {
            elizaLogger.info("🛑 [ComprehensiveAnalysisWorkflow] Stop request received before saving report");
            return stopState;
        }

        // Create saved_data and Reports directories
        const savedDataDir = path.join(process.cwd(), 'saved_data');
        const reportsDir = path.join(savedDataDir, 'Reports');

        if (!fs.existsSync(savedDataDir)) {
            fs.mkdirSync(savedDataDir, { recursive: true });
            elizaLogger.info(`📁 Created directory: ${savedDataDir}`);
        }

        if (!fs.existsSync(reportsDir)) {
            fs.mkdirSync(reportsDir, { recursive: true });
            elizaLogger.info(`📁 Created directory: ${reportsDir}`);
        }

        // Note: Report cleanup disabled to preserve historical data
        // Old reports are kept for reference in chat history
        const files = fs.readdirSync(reportsDir);
        const previousReports = files.filter(file =>
            file.includes(`comprehensive analysis ${state.target}`) && file.endsWith('.html')
        );

        if (previousReports.length > 0) {
            elizaLogger.info(`📊 Found ${previousReports.length} existing report(s) for ${state.target} (keeping for history)`);
        }

        // Clean up previous reports for this symbol
        // for (const file of previousReports) {
        //     const filePath = path.join(reportsDir, file);
        //     fs.unlinkSync(filePath);
        //     elizaLogger.info(`🗑️ Deleted previous report: ${file}`);
        // }

        // Generate filename with current date
        const currentDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
        const filename = `comprehensive analysis ${state.target} ${currentDate}.html`;
        const filepath = path.join(reportsDir, filename);

        const isSchedulerDailyReport =
            state.message.userId === DAILY_ANALYSIS_SCHEDULER_USER_ID;
        const symbolUpper = state.target?.toUpperCase() ?? "UNKNOWN";
        const symbolLower = (state.target ?? "unknown").toLowerCase();

        // Save the HTML report — upload to S3 if fileStorageService is attached to runtime
        const fileSvc = (state.runtime as any).fileStorageService as {
            buildKey: (p: Record<string, unknown>) => string;
            saveFile: (o: Record<string, unknown>) => Promise<string>;
        } | undefined;

        let reportUrl: string;
        if (fileSvc?.saveFile && fileSvc?.buildKey) {
            const htmlRemoteName = `comprehensive-analysis-${symbolLower}-${currentDate}.html`;
            const s3Key = isSchedulerDailyReport
                ? `auto-daily-reports-agent/${currentDate}/${symbolUpper}/${htmlRemoteName}`
                : fileSvc.buildKey({
                type: "report",
                agentId: state.runtime.agentId,
                userId: state.message.userId,
                roomId: state.message.roomId,
                date: currentDate,
                symbol: symbolUpper,
                filename: htmlRemoteName,
            });
            reportUrl = await fileSvc.saveFile({
                content: state.htmlReport,
                s3Key,
                contentType: "text/html",
                metadata: {
                    "agent-id": state.runtime.agentId,
                    "user-id": state.message.userId,
                    "room-id": state.message.roomId ?? "",
                    "symbol": state.target ?? "",
                    "file-type": "report",
                },
                localCachePath: filepath,
            });
        } else {
            fs.writeFileSync(filepath, state.htmlReport, 'utf8');
            reportUrl = filepath;
        }

        // Save metadata sidecar (charts + search links) for frontend rendering
        try {
            const metadata = extractReportMetadata(state.actionResults || [], state.target, currentDate);
            const metaFilename = filename.replace('.html', '.meta.json');
            const metaLocalPath = path.join(reportsDir, metaFilename);
            if (fileSvc?.saveFile && fileSvc?.buildKey) {
                const metaRemoteName = `comprehensive-analysis-${symbolLower}-${currentDate}.meta.json`;
                const metaS3Key = isSchedulerDailyReport
                    ? `auto-daily-reports-agent/${currentDate}/${symbolUpper}/${metaRemoteName}`
                    : fileSvc.buildKey({
                    type: "report",
                    agentId: state.runtime.agentId,
                    userId: state.message.userId,
                    roomId: state.message.roomId,
                    date: currentDate,
                    symbol: symbolUpper,
                    filename: metaRemoteName,
                });
                await (fileSvc.saveFile as any)({
                    content: JSON.stringify(metadata, null, 2),
                    s3Key: metaS3Key,
                    contentType: "application/json",
                    metadata: { "file-type": "report-meta" },
                    localCachePath: metaLocalPath,
                }).catch((e: any) => elizaLogger.warn(`Failed to save metadata sidecar to S3: ${e.message}`));
            } else {
                fs.writeFileSync(metaLocalPath, JSON.stringify(metadata, null, 2), 'utf8');
            }
            elizaLogger.info(`📋 Saved report metadata sidecar: ${metaFilename}`);
        } catch (e: any) {
            elizaLogger.warn(`Failed to save metadata sidecar: ${e.message}`);
        }

        const totalActions = COMPREHENSIVE_ANALYSIS_ACTIONS.length + 1;
        const completedActions = totalActions;

        const relativeReportPath = filepath.includes(process.cwd())
            ? filepath.replace(process.cwd(), '').replace(/^\//, '')
            : filepath;

        const executiveSummaryPlain = extractExecutiveSummaryFromMarkdown(state.analysisContent || "");

        // When extraction yields nothing, emit the first heading we saw so the
        // next debug round doesn't have to guess at LLM output shape (e.g.
        // localized headings under getLanguageInstruction or unexpected styles).
        if (!executiveSummaryPlain) {
            const md = state.analysisContent ?? "";
            const firstHeading = md.match(/^\s*#{1,4}\s+[^\r\n]+/m)?.[0]?.slice(0, 200) ?? "<no ATX heading>";
            elizaLogger.warn(
                `[ComprehensiveAnalysisWorkflow] Executive summary extraction empty (analysisContent=${md.length} chars, firstHeading=${JSON.stringify(firstHeading)})`,
            );
        } else {
            elizaLogger.info(
                `[ComprehensiveAnalysisWorkflow] Executive summary extracted (${executiveSummaryPlain.length} chars)`,
            );
        }

        const realtimeActionResult = {
            action: "Report Generation",
            phase: "writing_report",
            status: 'success' as const,
            content: `Comprehensive analysis report successfully generated!`,
            summary: `Comprehensive analysis report successfully generated and saved`,
            ...(executiveSummaryPlain ? { executiveSummary: executiveSummaryPlain } : {}),
        };

        const actionResultData = {
            action: "Report Generation",
            phase: "writing_report",
            success: true,
            result: {
                reportPath: filepath,
                relativePath: relativeReportPath,
                reportUrl,
            }
        };

        // Create report generation action result.
        //
        // The existing `metadata.summary` slot here is the short report
        // generation success message ("Comprehensive analysis report
        // successfully generated and saved") — fine for UI but useless as
        // follow-up-turn context. We therefore prefer the extracted
        // `executiveSummary` (the body of `### N. Executive Summary` from
        // the long-form report) when present, falling back to the static
        // success string only when extraction failed. Both keys are kept
        // for back-compat with code that reads either one.
        const summaryForContext = executiveSummaryPlain || realtimeActionResult.summary;

        const reportActionResult: Memory = {
            id: uuidv4() as UUID,
            userId: state.runtime.agentId,
            agentId: state.runtime.agentId,
            roomId: state.message.roomId || state.state?.roomId || state.runtime.agentId,
            createdAt: Date.now(),
            content: {
                text: realtimeActionResult.content,
                action: "Report Generation",
                phase: "writing_report",
                target: state.target,
                source: 'comprehensive_analysis',
                actionResultData,
                metadata: {
                    actionName: "Report Generation",
                    phase: "writing_report",
                    success: true,
                    reportPath: filepath,
                    relativePath: relativeReportPath,
                    reportUrl,
                    summary: summaryForContext,
                    ...(executiveSummaryPlain ? { executiveSummary: executiveSummaryPlain } : {}),
                    analysisType: 'comprehensive_analysis',
                    isActionResponse: true
                }
            }
        };

        // Run the standard summary attacher for telemetry. `metadata.summary`
        // is already populated above so the helper is a no-op on the data,
        // but it still emits the `[ResponseSummary]` log line for parity
        // with the other routes.
        const reportActionResultWithSummary = attachResponseSummary(reportActionResult, {
            route: "comprehensive",
            summaryOverride: summaryForContext,
        });

        // Persist the report generation result for historical views (skip for scheduler)
        if (!isSchedulerDailyReport) {
            try {
                await state.runtime.messageManager.createMemory(reportActionResultWithSummary);
                elizaLogger.success("✅ Report generation memory stored successfully");
            } catch (error: any) {
                elizaLogger.error(`⚠️ Failed to store report generation memory: ${error.message}`);
            }
        } else {
            elizaLogger.info(
                "[ComprehensiveAnalysisWorkflow] Scheduler run: skipping report generation memory persist",
            );
        }

        const updatedResults = [...(state.actionResults || []), reportActionResultWithSummary];

        // Stream final report completion notification with progress
        if (state.streamingCallback) {
            state.streamingCallback({
                id: uuidv4(),
                name: 'comprehensive_action_result',
                status: 'completed',
                message: `Report generation completed: ${filepath.split('/').pop()}`,
                timestamp: Date.now(),
                data: {
                    type: 'comprehensive_action_result',
                    actionName: "Report Generation",
                    phase: "writing_report",
                    success: true,
                    progress: {
                        current: completedActions,
                        total: totalActions
                    },
                    actionResult: realtimeActionResult,
                    actionResultData
                }
            });
        }

        elizaLogger.success(`✅ Comprehensive analysis report saved: ${filepath}`);

        const postSaveStop = checkForStopRequest(state, 'report saving');
        if (postSaveStop) {
            elizaLogger.info("🛑 [ComprehensiveAnalysisWorkflow] Stop request received after saving report");
            return {
                ...postSaveStop,
                reportPath: filepath,
                actionResults: updatedResults
            };
        }

        return {
            reportPath: filepath,
            actionResults: updatedResults,
            isComplete: true,
            phase: "completed"
        };

    } catch (error: any) {
        elizaLogger.error(`[ComprehensiveAnalysisWorkflow] Report saving failed: ${error.message}`);
        return {
            hasError: true,
            errorMessage: `Report saving failed: ${error.message}`,
            phase: "error"
        };
    }
}

/**
 * Handle workflow errors and create fallback response
 */
async function handleWorkflowError(state: ComprehensiveAnalysisStateType): Promise<Partial<ComprehensiveAnalysisStateType>> {
    elizaLogger.error(`[ComprehensiveAnalysisWorkflow] Handling workflow error: ${state.errorMessage}`);

    try {
        if (state.shouldStop) {
            elizaLogger.info("🛑 [ComprehensiveAnalysisWorkflow] Workflow stopped by user request");
            return {
                shouldStop: true,
                isComplete: true,
                errorMessage: state.errorMessage ?? 'Processing stopped by user request',
                phase: 'stopped'
            };
        }

        const errorText = `Comprehensive analysis failed during ${state.phase}: ${state.errorMessage}`;

        elizaLogger.error(`❌ Comprehensive analysis failed: ${state.errorMessage}`);

        if (state.streamingCallback) {
            state.streamingCallback({
                id: uuidv4(),
                name: 'comprehensive_analysis_failed',
                status: 'completed',
                message: errorText,
                timestamp: Date.now(),
                data: {
                    type: 'comprehensive_analysis_failed',
                    phase: state.phase,
                    error: state.errorMessage
                }
            });
        }

        return {
            hasError: true,
            errorMessage: state.errorMessage ?? errorText,
            isComplete: true,
            phase: "error_handled"
        };

    } catch (error: any) {
        elizaLogger.error(
            `[ComprehensiveAnalysisWorkflow] Error handling failed (original=${state.errorMessage}): ${error.message}`
        );
        return {
            hasError: true,
            errorMessage: state.errorMessage ?? error.message,
            isComplete: true,
            phase: "critical_error"
        };
    }
}

/**
 * Create the LangGraph workflow
 */
function createComprehensiveAnalysisWorkflow() {
    // §4 Observability: wrap each node in traceNode so the 13-step pipeline becomes a
    // `node:<name>` span DAG under the per-turn handler root (no-op when tracing is disabled).
    const workflow = new StateGraph(ComprehensiveAnalysisState)
        .addNode("initialize", traceNode("initialize", initializeWorkflow))
        .addNode("extractParameters", traceNode("extractParameters", extractParameters))
        .addNode("executeActions", traceNode("executeActions", executeActions))
        .addNode("synthesizeReport", traceNode("synthesizeReport", synthesizeReport))
        .addNode("generateAnalysis", traceNode("generateAnalysis", generateAnalysis))
        .addNode("createHTMLReport", traceNode("createHTMLReport", createHTMLReport))
        .addNode("saveReport", traceNode("saveReport", saveReport))
        .addNode("handleError", traceNode("handleError", handleWorkflowError))

        // Sequential flow with error handling
        .addEdge("__start__", "initialize")
        .addConditionalEdges("initialize", (state: ComprehensiveAnalysisStateType) => {
            return state.hasError ? "handleError" : "extractParameters";
        })
        .addConditionalEdges("extractParameters", (state: ComprehensiveAnalysisStateType) => {
            return state.hasError ? "handleError" : "executeActions";
        })
        .addConditionalEdges("executeActions", (state: ComprehensiveAnalysisStateType) => {
            return state.hasError ? "handleError" : "synthesizeReport";
        })
        .addConditionalEdges("synthesizeReport", (state: ComprehensiveAnalysisStateType) => {
            return state.hasError ? "handleError" : "generateAnalysis";
        })
        .addConditionalEdges("generateAnalysis", (state: ComprehensiveAnalysisStateType) => {
            return state.hasError ? "handleError" : "createHTMLReport";
        })
        .addConditionalEdges("createHTMLReport", (state: ComprehensiveAnalysisStateType) => {
            return state.hasError ? "handleError" : "saveReport";
        })
        .addEdge("saveReport", "__end__")
        .addEdge("handleError", "__end__");

    return workflow.compile();
}

/**
 * Comprehensive Analysis Workflow Service
 */
export class ComprehensiveAnalysisWorkflowService {
    private runtime: IAgentRuntime;
    private workflow: ReturnType<typeof createComprehensiveAnalysisWorkflow>;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
        this.workflow = createComprehensiveAnalysisWorkflow();
        elizaLogger.info(`[ComprehensiveAnalysisWorkflow] Service initialized`);
    }

    /**
     * Handle comprehensive analysis using LangGraph workflow
     */
    async handleComprehensiveAnalysis(
        message: Memory,
        state?: State,
        streamingCallback?: StreamingCallback,
        intermediateResultCallback?: (response: Memory) => void,
        onToken?: (delta: string) => void,
        onAnalysisComplete?: (analysisContent: string) => void,
    ): Promise<{
        success: boolean;
        reportPath?: string;
        error?: string;
        actionResults?: Memory[];
        analysisContent?: string;
    }> {
        try {
            elizaLogger.info(`[ComprehensiveAnalysisWorkflow] Processing comprehensive analysis with LangGraph workflow`);

            this.runtime.resetStopFlag?.();

            // Execute workflow
            const langSmithMetadataEntries = Object.entries({
                runType: "comprehensive_analysis",
                agentId: this.runtime.agentId,
                character: this.runtime.character?.name,
                messageId: message.id,
                roomId: message.roomId
            }).filter(([, value]) => value !== undefined && value !== null && value !== "");

            const langSmithMetadata = Object.fromEntries(langSmithMetadataEntries) as Record<string, unknown>;

            const langSmithConfig = buildLangSmithRunnableConfig({
                apiKey: this.runtime.getSetting("LANGCHAIN_API_KEY")
                    ?? this.runtime.getSetting("LANGSMITH_API_KEY")
                    ?? undefined,
                endpoint: this.runtime.getSetting("LANGCHAIN_ENDPOINT")
                    ?? this.runtime.getSetting("LANGSMITH_ENDPOINT")
                    ?? undefined,
                projectName: this.runtime.getSetting("LANGSMITH_PROJECT")
                    ?? this.runtime.getSetting("LANGCHAIN_PROJECT")
                    ?? this.runtime.character?.name
                    ?? undefined,
                runName: message.id
                    ? `comprehensive-analysis:${message.id}`
                    : "comprehensive-analysis-workflow",
                tags: [
                    "comprehensive-analysis",
                    this.runtime.character?.name ? `agent:${this.runtime.character.name}` : undefined
                ].filter((tag): tag is string => typeof tag === "string" && tag.length > 0),
                metadata: langSmithMetadata
            });

            const workflowInput = {
                message,
                runtime: this.runtime,
                state,
                streamingCallback,
                intermediateResultCallback,
                onToken,
                onAnalysisComplete,
                shouldStop: false
            };

            const result = langSmithConfig
                ? await this.workflow.invoke(workflowInput, langSmithConfig)
                : await this.workflow.invoke(workflowInput);

            elizaLogger.info(`[ComprehensiveAnalysisWorkflow] Workflow completed in ${Date.now() - result.startTime}ms`);

            if (result.shouldStop) {
                return {
                    success: false,
                    error: result.errorMessage || 'Processing stopped by user request',
                    actionResults: result.actionResults,
                    reportPath: result.reportPath,
                    analysisContent: result.analysisContent
                };
            }

            if (result.hasError) {
                return {
                    success: false,
                    error: result.errorMessage
                };
            }

            return {
                success: true,
                reportPath: result.reportPath,
                actionResults: result.actionResults,
                analysisContent: result.analysisContent
            };

        } catch (error: any) {
            elizaLogger.error(`[ComprehensiveAnalysisWorkflow] Workflow execution failed:`, error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Get workflow for debugging
     */
    public getWorkflow() {
        return this.workflow;
    }
}

// Global workflow service instance
let workflowService: ComprehensiveAnalysisWorkflowService | null = null;

// Concurrency model for comprehensive analysis: two gates in series.
//
//   1. Per-user (max 1 in flight): a user's second invocation queues until
//      their first finishes. Avoids self-DoS where a misclicked second run
//      doubles the user's memory footprint and slows their first via
//      shared-CPU contention.
//   2. Global (max GLOBAL_CONCURRENCY in flight across all users): the
//      (N+1)th caller queues until a slot frees.
//
// History:
//   - Originally per-user only. Production CloudWatch on 2026-05-04 showed
//     two different users running in parallel hitting 89.65% (prod) and
//     95.9% (staging) memory with task replacements right after, both at
//     the PREDICTION action / final summary step.
//   - Replaced with a single global slot (max 1 concurrent), rejecting the
//     2nd-Nth caller with a "busy" error.
//   - PR #148 (May 2026) cut peak rss/run from ~8.5 GB → ~2.1 GB by
//     removing a stale composeState call in webSearch and serializing
//     Phase 1. With per-run cost down by ~6 GB, we now allow 3 concurrent
//     runs (~2.5 GB total above idle on a 16 GB ECS task — well under the
//     12 GB --max-old-space-size cap) and queue the (N+1)th rather than
//     reject.
//
// Queueing: callers wait via Promise instead of getting an immediate "busy"
// error. There's no timeout on the wait — the stale-slot fail-safe below
// guarantees forward progress even if a held slot never releases.
//
// Stuck-slot fail-safe: STALE_LOCK_MS lets a new acquire force-release any
// slot held longer than any plausible successful run (workflow takes ~5-15
// min; we use 25 min as the cutoff). Without this, an exception that
// bypasses the finally block (e.g. signal handler killed mid-flight) would
// brick a slot until process restart.
const GLOBAL_CONCURRENCY = 3;
const STALE_LOCK_MS = 25 * 60 * 1000;

interface InFlightSlot {
    userId: string;
    source: string;
    startedAt: number;
}

// slotId -> InFlightSlot. Size capped at GLOBAL_CONCURRENCY by tryAcquireSlot.
const inFlightSlots = new Map<string, InFlightSlot>();
// userId -> slotId. Enforces the per-user max-1 gate.
const userInFlight = new Map<string, string>();
// FIFO queue of callers waiting for a slot.
const waitQueue: Array<{
    userId: string;
    source: string;
    resolve: (slotId: string) => void;
}> = [];

let nextSlotId = 0;

// Re-exported under the legacy name so external readers (e.g. the scheduler)
// can still introspect which users currently have a run in flight.
export const analysisInProgressByUser = new Map<string, boolean>();

/**
 * Returns whether the given user currently has an in-flight comprehensive
 * analysis slot, and the `startedAt` timestamp of that slot if so.
 *
 * Used by the active-workflow HTTP endpoint to rehydrate the client-side
 * Stop button across page refresh — `analysisInProgressByUser` only
 * carries a boolean, while the slot map carries the start time we need to
 * surface to the UI.
 */
export function isComprehensiveAnalysisInProgress(userId: string): {
    active: boolean;
    startedAt?: number;
} {
    const slotId = userInFlight.get(userId);
    if (!slotId) return { active: false };
    const slot = inFlightSlots.get(slotId);
    return slot ? { active: true, startedAt: slot.startedAt } : { active: false };
}

function reapStaleSlots(): void {
    const now = Date.now();
    for (const [slotId, slot] of inFlightSlots) {
        if (now - slot.startedAt > STALE_LOCK_MS) {
            elizaLogger.warn(
                `[ComprehensiveAnalysisWorkflow] Stale slot detected (held ${Math.round((now - slot.startedAt) / 1000)}s by user ${slot.userId}, source=${slot.source}). Forcing release.`
            );
            inFlightSlots.delete(slotId);
            userInFlight.delete(slot.userId);
            analysisInProgressByUser.delete(slot.userId);
        }
    }
}

function tryAcquireSlot(userId: string, source: string): string | null {
    reapStaleSlots();
    if (userInFlight.has(userId)) return null;
    if (inFlightSlots.size >= GLOBAL_CONCURRENCY) return null;
    const slotId = `slot-${++nextSlotId}`;
    inFlightSlots.set(slotId, { userId, source, startedAt: Date.now() });
    userInFlight.set(userId, slotId);
    analysisInProgressByUser.set(userId, true);
    return slotId;
}

/**
 * Information passed to `onQueued` so callers can surface queue state to the
 * UI. `position` is 1-indexed (the caller is the Nth job currently waiting).
 */
export type QueueWaitInfo = {
    position: number;
    inFlight: number;
    capacity: number;
};

async function acquireLock(
    userId: string,
    source: string,
    onQueued?: (info: QueueWaitInfo) => void
): Promise<string> {
    const slotId = tryAcquireSlot(userId, source);
    if (slotId) return slotId;

    const position = waitQueue.length + 1;
    const inFlight = inFlightSlots.size;
    elizaLogger.info(
        `[ComprehensiveAnalysisWorkflow] Queueing run: userId=${userId}, source=${source}, queueLen=${position}, inFlight=${inFlight}/${GLOBAL_CONCURRENCY}`
    );
    // Notify the caller (e.g. so it can stream a "Queued" status to the UI)
    // BEFORE blocking on the wait promise. Failures here must not break
    // queueing; the streaming pipe might already be torn down.
    if (onQueued) {
        try {
            onQueued({ position, inFlight, capacity: GLOBAL_CONCURRENCY });
        } catch (err) {
            elizaLogger.warn(
                `[ComprehensiveAnalysisWorkflow] onQueued callback threw: ${String(err)}`
            );
        }
    }
    return new Promise<string>((resolve) => {
        waitQueue.push({ userId, source, resolve });
    });
}

function releaseLock(slotId: string): void {
    const slot = inFlightSlots.get(slotId);
    if (slot) {
        inFlightSlots.delete(slotId);
        userInFlight.delete(slot.userId);
        analysisInProgressByUser.delete(slot.userId);
    }
    // Drain queue: walk waiters and admit any that fit. Skip blocked ones
    // (e.g. their user already has another slot held) so a later waiter for
    // a different user can still proceed.
    for (let i = 0; i < waitQueue.length; ) {
        const candidate = waitQueue[i];
        const newSlotId = tryAcquireSlot(candidate.userId, candidate.source);
        if (newSlotId) {
            waitQueue.splice(i, 1);
            candidate.resolve(newSlotId);
        } else {
            i++;
        }
    }
}

/**
 * Main export function - maintains the same interface as the original handler
 */
export async function handleComprehensiveAnalysis(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    streamingCallback?: StreamingCallback,
    intermediateResultCallback?: (response: Memory) => void,
    onToken?: (delta: string) => void,
    onAnalysisComplete?: (analysisContent: string) => void,
): Promise<{
    success: boolean;
    reportPath?: string;
    error?: string;
    actionResults?: Memory[];
    analysisContent?: string;
}> {
    const userId = (message?.userId ?? runtime.agentId) as string;
    const source = (message?.content?.source as string | undefined) ?? "unknown";

    // [debug-leak] Probe before acquiring the concurrency slot. If RSS here is
    // already inflated (vs. runtime.composeState entry), the leak is in
    // composeState itself. If RSS here is normal, the leak is downstream
    // (workflowService.handleComprehensiveAnalysis).
    logMemProbe("workflow.handler:enter", {
        user: userId.slice(0, 8),
        source,
    });

    // When the slot can't be acquired immediately, surface a "Queued" step to
    // the UI so the user knows their job is waiting (per-user concurrency = 1
    // means submitting a 2nd analysis blocks until the 1st finishes — without
    // this, the chat looks frozen for several minutes). The frontend can read
    // `data.queue.position` / `inFlight` / `capacity` to render the wait
    // state. Skipped for scheduler runs since there's no UI to display in.
    const queuedAt = Date.now();
    const slotId = await withMemProbe(
        "workflow.acquireLock",
        () =>
            acquireLock(userId, source, (info) => {
                if (source === "scheduler" || !streamingCallback) return;
                streamingCallback({
                    id: `queue-wait-${userId.slice(0, 8)}`,
                    name: "Queue Wait",
                    status: "in_progress",
                    message: `🕒 Queued (position ${info.position}). ${info.inFlight} of ${info.capacity} comprehensive analyses in flight — your run will start as soon as a slot frees.`,
                    timestamp: Date.now(),
                    data: {
                        queue: {
                            position: info.position,
                            inFlight: info.inFlight,
                            capacity: info.capacity,
                        },
                    },
                });
            }),
        { user: userId.slice(0, 8), source }
    );

    // If we waited at all, mark the queue step complete so the UI clears the
    // spinner before the actual analysis kicks off. 50ms is well below the
    // shortest acquireLock fast-path so this won't fire spuriously.
    const waitedMs = Date.now() - queuedAt;
    if (waitedMs > 50 && source !== "scheduler" && streamingCallback) {
        streamingCallback({
            id: `queue-wait-${userId.slice(0, 8)}`,
            name: "Queue Wait",
            status: "completed",
            message: `✅ Slot acquired after ${(waitedMs / 1000).toFixed(0)}s — starting analysis.`,
            timestamp: Date.now(),
            data: { queue: { waitedMs } },
        });
    }

    logMemAt(`workflow:start`, { user: userId.slice(0, 8), source });
    // Sample RSS every 10s for the lifetime of this workflow. Pairs with the
    // per-action [Memory] lines and per-substep [MemoryProbe] lines so we can
    // see growth that happens *during* an action (not just at boundaries).
    const stopSampler = startMemSampler(`workflow.${userId.slice(0, 8)}`, 10_000);
    try {
        // Initialize workflow service if not already done
        if (!workflowService) {
            workflowService = new ComprehensiveAnalysisWorkflowService(runtime);
        }

        // Delegate to workflow service
        return await workflowService.handleComprehensiveAnalysis(message, state, streamingCallback, intermediateResultCallback, onToken, onAnalysisComplete);
    } finally {
        stopSampler();
        logMemAt(`workflow:end`, { user: userId.slice(0, 8), source });
        // Always release — otherwise any thrown error leaves a slot stuck and
        // queued callers wait for the stale-slot fail-safe (25 min) instead of
        // proceeding immediately.
        releaseLock(slotId);
    }
}
