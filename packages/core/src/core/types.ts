import type { Readable } from "stream";

/**
 * Represents a UUID string in the format "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
 */
export type UUID = `${string}-${string}-${string}-${string}-${string}`;

/**
 * Represents the content of a message or communication
 */
export interface Content {
    /** The main text content */
    text: string;

    /** Optional action associated with the message */
    action?: string | string[];

    /** Optional source/origin of the content */
    source?: string;

    /** URL of the original message/post (e.g. tweet URL, Discord message link) */
    url?: string;

    /** UUID of parent message if this is a reply/thread */
    inReplyTo?: UUID;

    /** Array of media attachments */
    attachments?: Media[];

    /** Optional suggested next step for the user */
    nextStep?: string;

    /** Optional thinking process data from AI */
    thinking?: {
        analysis?: string;
        reasoning?: string;
        alternatives_considered?: string;
        considerations?: string;
    };

    /** Optional error information */
    error?: {
        type: string;
        message: string;
        originalError?: string;
        stack?: string | null;
        [key: string]: unknown;
    };

    /** Streaming processing steps */
    processingSteps?: ProcessingStep[];

    /** Language code for response generation (e.g., 'en', 'zh-CN') */
    language?: string;

    /** Additional dynamic properties */
    [key: string]: unknown;
}

/**
 * Example content with associated user for demonstration purposes
 */
export interface ActionExample {
    /** User associated with the example */
    user: string;

    /** Content of the example */
    content: Content;
}

/**
 * Example conversation content with user ID
 */
export interface ConversationExample {
    /** UUID of user in conversation */
    userId: UUID;

    /** Content of the conversation */
    content: Content;
}

/**
 * Represents an actor/participant in a conversation
 */
export interface Actor {
    /** Display name */
    name: string;

    /** Username/handle */
    username: string;

    /** Additional profile details */
    details: {
        /** Short profile tagline */
        tagline: string;

        /** Longer profile summary */
        summary: string;

        /** Favorite quote */
        quote: string;
    };

    /** Unique identifier */
    id: UUID;
}

/**
 * Represents a single objective within a goal
 */
export interface Objective {
    /** Optional unique identifier */
    id?: string;

    /** Description of what needs to be achieved */
    description: string;

    /** Whether objective is completed */
    completed: boolean;
}

/**
 * Status enum for goals
 */
export enum GoalStatus {
    DONE = "DONE",
    FAILED = "FAILED",
    IN_PROGRESS = "IN_PROGRESS",
}

/**
 * Represents a high-level goal composed of objectives
 */
export interface Goal {
    /** Optional unique identifier */
    id?: UUID;

    /** Room ID where goal exists */
    roomId: UUID;

    /** User ID of goal owner */
    userId: UUID;

    /** Name/title of the goal */
    name: string;

    /** Current status */
    status: GoalStatus;

    /** Component objectives */
    objectives: Objective[];
}

/**
 * Model size/type classification
 */
export enum ModelClass {
    SMALL = "small",
    MEDIUM = "medium",
    LARGE = "large",
    EMBEDDING = "embedding",
    IMAGE = "image",
}

/**
 * Model settings
 */
export type ModelSettings = {
    /** Model name */
    name: string;

    /** Maximum input tokens */
    maxInputTokens: number;

    /** Maximum output tokens */
    maxOutputTokens: number;

    /** Optional frequency penalty */
    frequency_penalty?: number;

    /** Optional presence penalty */
    presence_penalty?: number;

    /** Optional repetition penalty */
    repetition_penalty?: number;

    /** Stop sequences */
    stop: string[];

    /** Temperature setting */
    temperature: number;

    /** Optional telemetry configuration (experimental) */
    experimental_telemetry?: TelemetrySettings;
};

/** Image model settings */
export type ImageModelSettings = {
    name: string;
    steps?: number;
};

/** Embedding model settings */
export type EmbeddingModelSettings = {
    name: string;
    dimensions?: number;
};

/**
 * Configuration for an AI model
 */
export type Model = {
    /** Optional API endpoint */
    endpoint?: string;

    /** Model names by size class */
    model: {
        [ModelClass.SMALL]?: ModelSettings;
        [ModelClass.MEDIUM]?: ModelSettings;
        [ModelClass.LARGE]?: ModelSettings;
        [ModelClass.EMBEDDING]?: EmbeddingModelSettings;
        [ModelClass.IMAGE]?: ImageModelSettings;
    };
};

/**
 * Model configurations by provider
 */
export type Models = {
    [ModelProviderName.OPENAI]: Model;
    [ModelProviderName.ETERNALAI]: Model;
    [ModelProviderName.ANTHROPIC]: Model;
    [ModelProviderName.GROK]: Model;
    [ModelProviderName.GROQ]: Model;
    [ModelProviderName.LLAMACLOUD]: Model;
    [ModelProviderName.TOGETHER]: Model;
    [ModelProviderName.LLAMALOCAL]: Model;
    [ModelProviderName.LMSTUDIO]: Model;
    [ModelProviderName.GOOGLE]: Model;
    [ModelProviderName.MISTRAL]: Model;
    [ModelProviderName.CLAUDE_VERTEX]: Model;
    [ModelProviderName.REDPILL]: Model;
    [ModelProviderName.OPENROUTER]: Model;
    [ModelProviderName.OLLAMA]: Model;
    [ModelProviderName.HEURIST]: Model;
    [ModelProviderName.GALADRIEL]: Model;
    [ModelProviderName.FAL]: Model;
    [ModelProviderName.GAIANET]: Model;
    [ModelProviderName.ALI_BAILIAN]: Model;
    [ModelProviderName.VOLENGINE]: Model;
    [ModelProviderName.NANOGPT]: Model;
    [ModelProviderName.HYPERBOLIC]: Model;
    [ModelProviderName.VENICE]: Model;
    [ModelProviderName.NVIDIA]: Model;
    [ModelProviderName.NINETEEN_AI]: Model;
    [ModelProviderName.AKASH_CHAT_API]: Model;
    [ModelProviderName.LIVEPEER]: Model;
    [ModelProviderName.DEEPSEEK]: Model;
    [ModelProviderName.INFERA]: Model;
    [ModelProviderName.BEDROCK]: Model;
    [ModelProviderName.ATOMA]: Model;
    [ModelProviderName.SECRETAI]: Model;
    [ModelProviderName.NEARAI]: Model;
    [ModelProviderName.KLUSTERAI]: Model;
    [ModelProviderName.MEM0]: Model;
};

/**
 * Available model providers
 */
export enum ModelProviderName {
    OPENAI = "openai",
    ETERNALAI = "eternalai",
    ANTHROPIC = "anthropic",
    GROK = "grok",
    GROQ = "groq",
    LLAMACLOUD = "llama_cloud",
    TOGETHER = "together",
    LLAMALOCAL = "llama_local",
    LMSTUDIO = "lmstudio",
    GOOGLE = "google",
    MISTRAL = "mistral",
    CLAUDE_VERTEX = "claude_vertex",
    REDPILL = "redpill",
    OPENROUTER = "openrouter",
    OLLAMA = "ollama",
    HEURIST = "heurist",
    GALADRIEL = "galadriel",
    FAL = "falai",
    GAIANET = "gaianet",
    ALI_BAILIAN = "ali_bailian",
    VOLENGINE = "volengine",
    NANOGPT = "nanogpt",
    HYPERBOLIC = "hyperbolic",
    VENICE = "venice",
    NVIDIA = "nvidia",
    NINETEEN_AI = "nineteen_ai",
    AKASH_CHAT_API = "akash_chat_api",
    LIVEPEER = "livepeer",
    LETZAI = "letzai",
    DEEPSEEK = "deepseek",
    INFERA = "infera",
    BEDROCK = "bedrock",
    ATOMA = "atoma",
    SECRETAI = "secret_ai",
    NEARAI = "nearai",
    KLUSTERAI = "kluster_ai",
    MEM0 = "mem0",
}

/**
 * Represents the current state/context of a conversation
 */
export interface State {
    /** ID of user who sent current message */
    userId?: UUID;

    /** ID of agent in conversation */
    agentId?: UUID;

    /** Agent's biography */
    bio: string;

    /** Agent's background lore */
    lore: string;

    /** Message handling directions */
    messageDirections: string;

    /** Post handling directions */
    postDirections: string;

    /** Current room/conversation ID */
    roomId: UUID;

    /** Optional agent name */
    agentName?: string;

    /** Optional message sender name */
    senderName?: string;

    /** String representation of conversation actors */
    actors: string;

    /** Optional array of actor objects */
    actorsData?: Actor[];

    /** Optional string representation of goals */
    goals?: string;

    /** Optional array of goal objects */
    goalsData?: Goal[];

    /** Recent message history as string */
    recentMessages: string;
    
    /** Last 5 messages as formatted string */
    lastFiveMessages?: string;

    /** Recent message objects */
    recentMessagesData: Memory[];
    
    /** Last 5 message objects */
    lastFiveMessagesData?: Memory[];

    /** Optional valid action names */
    actionNames?: string;

    /** Optional action descriptions */
    actions?: string;

    /** Optional action objects */
    actionsData?: Action[];

    /** Optional action examples */
    actionExamples?: string;

    /** Optional provider descriptions */
    providers?: string;

    /** Optional response content */
    responseData?: Content;

    /** Optional recent interaction objects */
    recentInteractionsData?: Memory[];

    /** Optional recent interactions string */
    recentInteractions?: string;

    /** Optional formatted conversation */
    formattedConversation?: string;

    /** Optional formatted knowledge */
    knowledge?: string;
    /** Optional knowledge data */
    knowledgeData?: KnowledgeItem[];
    /** Optional knowledge data */
    ragKnowledgeData?: RAGKnowledgeItem[];

    /** Optional formatted user trait summary */
    userTraits?: string;

    /** Whether the current query is crypto-related */
    isCryptoRelated?: boolean;

    /** Cached action results for context injection */
    actionCacheContext?: CachedActionResult[];

    /** Additional dynamic properties */
    [key: string]: unknown;
}

/**
 * Represents a single user feature aspect generated by LLM
 * Used in the dynamic aspect-based user profiling system
 */
export interface UserFeatureAspect {
    /** LLM-generated aspect name (e.g., "Investment Philosophy", "Risk Tolerance") */
    name: string;

    /** LLM-generated aspect content/description (max 200 chars) */
    content: string;

    /** Timestamp when this aspect was generated */
    generatedAt: number;

    /** Profile version number this aspect belongs to */
    version: number;

    /** Index of this aspect within its set (0-9 for max 10 aspects) */
    aspectIndex: number;

    /** Total number of aspects in this set */
    totalAspects: number;

    /**
     * F2 — true when this aspect was derived from a batch that mentioned
     * trading/risk keywords (buy/sell/leverage/margin/stop loss). Such
     * aspects are excluded from `formatUserTraitsForContext` until the
     * user explicitly opts in via Settings → Inferred Traits.
     */
    consentRequired?: boolean;

    /**
     * F2 — set to "approved" once the user opts the aspect into prompt
     * injection. Absent / "pending" means the aspect is stored but not
     * injected. "rejected" means soft-deleted.
     */
    userConsent?: "approved" | "pending" | "rejected";
}

/**
 * Represents a stored memory/message
 */
export interface Memory {
    /** Optional unique identifier */
    id?: UUID;

    /** Associated user ID */
    userId: UUID;

    /** Associated agent ID */
    agentId: UUID;

    /** Optional creation timestamp */
    createdAt?: number;

    /** Memory content */
    content: Content;

    /** Optional embedding vector */
    embedding?: number[];

    /** Associated room ID */
    roomId: UUID;

    /** Whether memory is unique */
    unique?: boolean;

    /** Embedding similarity score */
    similarity?: number;

    /** Client IP for anonymous users (set when identified by IP) */
    clientIP?: string | null;
}

/**
 * Example message for demonstration
 */
export interface MessageExample {
    /** Associated user */
    user: string;

    /** Message content */
    content: Content;
}

/**
 * Handler function type for processing messages
 */
export type Handler = (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback,
) => Promise<unknown>;

/**
 * Callback function type for handlers
 */
export type HandlerCallback = (
    response: Content,
    files?: any,
    streamingCallback?: StreamingCallback,
) => Promise<Memory[]>;

/**
 * Standard Action Response Metadata Schema
 * 
 * All actions should follow this unified format when returning results via callback.
 * This ensures consistent handling and display by the frontend.
 * 
 * @example
 * ```typescript
 * callback({
 *     text: "Analysis completed",
 *     content: {
 *         data: {...},
 *         analysis: "...",
 *         chartPath: "saved_data/Charts/chart.html"
 *     },
 *     metadata: {
 *         type: "analysis_type",
 *         timestamp: Date.now(),
 *         isActionResponse: true,
 *         actionName: "ACTION_NAME",
 *         actionData: {...},
 *         chartPath: "saved_data/Charts/chart.html"
 *     }
 * });
 * ```
 */
export interface ActionResponseMetadata {
    /**
     * Action type identifier (e.g., "get_crypto_price", "onchain_data_analysis", "web_search")
     * Used for categorizing and routing action responses
     */
    type: string;

    /**
     * Timestamp when the action response was generated (Date.now())
     * Used for sorting, filtering, and displaying response timing
     */
    timestamp: number;

    /**
     * Flag indicating this is an action response (always true for action callbacks)
     * Used by frontend to identify and handle action responses consistently
     */
    isActionResponse: true;

    /**
     * Name of the action that generated this response (e.g., "GET_CRYPTO_PRICE", "WEB_SEARCH")
     * Must match the action.name property
     */
    actionName: string;

    /**
     * Structured data returned by the action
     * Contains action-specific data for programmatic access
     */
    actionData?: {
        [key: string]: unknown;
    };

    /**
     * Path to generated chart file (relative to project root, starting with "saved_data/Charts/")
     * Used for displaying interactive charts in the frontend
     */
    chartPath?: string;

    /**
     * Array of chart paths (for actions that generate multiple charts)
     * Alternative to chartPath when multiple charts are generated
     */
    chartPaths?: string[];

    /**
     * Cryptocurrency symbol (e.g., "BTC", "ETH")
     * Used for filtering and organizing crypto-related responses
     */
    symbol?: string;

    /**
     * Currency type (e.g., "USD", "EUR")
     * Used for price and financial data responses
     */
    currency?: string;

    /**
     * Metric type (e.g., "Transaction Count", "Active Address Count")
     * Used for on-chain data analysis responses
     */
    metric?: string;

    /**
     * Phase identifier for comprehensive analysis workflows
     * (e.g., "data_gathering", "analysis", "prediction")
     */
    phase?: string;

    /**
     * Success status of the action execution
     * true for successful executions, false for errors
     */
    success?: boolean;

    /**
     * Error information (only present when action fails)
     */
    error?: {
        type?: string;
        message?: string;
        errorType?: string;
        errorMessage?: string;
        [key: string]: unknown;
    };

    /**
     * Additional action-specific metadata fields
     * Actions can extend this interface with custom fields as needed
     */
    [key: string]: unknown;
}

/**
 * Standard Action Response Content Schema
 * 
 * Defines the structure for the content object in action responses.
 * Actions should place their specific data here while following the standard structure.
 */
export interface ActionResponseContent {
    /**
     * Action-specific data fields
     * Each action can define its own structure here
     */
    [key: string]: unknown;

    /**
     * Analysis text or summary (commonly used)
     */
    analysis?: string;

    /**
     * Chart file path (if chart is generated)
     */
    chartPath?: string;

    /**
     * Visualizations object containing chart-related data
     */
    visualizations?: {
        /**
         * Path to interactive chart
         */
        interactive_chart?: string;

        /**
         * Chart data for rendering
         */
        chart_data?: unknown;

        /**
         * Mermaid diagram definition
         */
        mermaidDiagram?: string;

        [key: string]: unknown;
    };
}

/**
 * Standard Action Response Schema
 * 
 * Complete schema for action callback responses.
 * All actions should return responses conforming to this structure.
 */
export interface StandardActionResponse extends Content {
    /**
     * Structured content data
     * Contains action-specific data and analysis
     */
    content?: ActionResponseContent;

    /**
     * Standardized metadata following ActionResponseMetadata schema
     * Must include: type, timestamp, isActionResponse, actionName
     */
    metadata: ActionResponseMetadata;
}

/**
 * Validator function type for actions/evaluators
 */
export type Validator = (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
) => Promise<boolean>;

/**
 * Configuration for caching action results as public memory
 */
export interface ActionCacheConfig {
    /** Whether caching is enabled for this action */
    enabled: boolean;

    /** Time-to-live in seconds for cached results */
    ttlSeconds: number;

    /** Minimum similarity threshold for cache hits (0-1, default 0.7) */
    similarityThreshold?: number;

    /** Maximum chunk size in characters for embedding (default 1000) */
    maxChunkSize?: number;
}

/**
 * Represents a cached action result stored as public memory
 */
export interface CachedActionResult {
    /** Unique identifier */
    id: UUID;

    /** Name of the action that produced this result */
    actionName: string;

    /** Original query/input that triggered the action */
    query: string;

    /** The action result text */
    result: string;

    /** Chunk index if result was split */
    chunkIndex: number;

    /** Total number of chunks */
    totalChunks: number;

    /** When the result was cached */
    createdAt: number;

    /** When the cache expires */
    expiresAt: number;

    /** Number of times this cache was hit */
    hitCount: number;

    /** Similarity score when retrieved (0-1) */
    similarity?: number;

    /** Similarity between current query and cached query (0-1) */
    querySimilarity?: number;
}

/**
 * Represents an action the agent can perform
 */
export interface Action {
    /** Action name */
    name: string;

    /** Detailed description */
    description: string;

    /** Example usages */
    examples: ActionExample[][];

    /** Handler function */
    handler: Handler;

    /** Whether to suppress the initial message when this action is used */
    suppressInitialMessage?: boolean;

    /** Configuration for caching action results as public memory */
    cacheConfig?: ActionCacheConfig;
}

/**
 * Example for evaluating agent behavior
 */
export interface EvaluationExample {
    /** Evaluation context */
    context: string;

    /** Example messages */
    messages: Array<ActionExample>;

    /** Expected outcome */
    outcome: string;
}

/**
 * Evaluator for assessing agent responses
 */
export interface Evaluator {
    /** Whether to always run */
    alwaysRun?: boolean;

    /** Evaluator name */
    name: string;

    /** Detailed description */
    description: string;

    /** Example evaluations */
    examples: EvaluationExample[];

    /** Handler function */
    handler: Handler;

    /** Validation function */
    validate: Validator;
}

/**
 * Provider for external data/services
 */
export interface Provider {
    /** Data retrieval function */
    get: (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
    ) => Promise<any>;
}

/**
 * Represents a relationship between users
 */
export interface Relationship {
    /** Unique identifier */
    id: UUID;

    /** First user ID */
    userA: UUID;

    /** Second user ID */
    userB: UUID;

    /** Primary user ID */
    userId: UUID;

    /** Associated room ID */
    roomId: UUID;

    /** Relationship status */
    status: string;

    /** Optional creation timestamp */
    createdAt?: string;
}

/**
 * Represents a user account
 */
export interface Account {
    /** Unique identifier */
    id: UUID;

    /** Display name */
    name: string;

    /** Username */
    username: string;

    /** Optional additional details */
    details?: { [key: string]: any };

    /** Optional email */
    email?: string;

    /** Optional avatar URL */
    avatarUrl?: string;
}

/**
 * Room participant with account details
 */
export interface Participant {
    /** Unique identifier */
    id: UUID;

    /** Associated account */
    account: Account;
}

/**
 * Represents a conversation room
 */
export interface Room {
    /** Unique identifier */
    id: UUID;

    /** Room participants */
    participants: Participant[];
}

/**
 * Represents a media attachment
 */
export type Media = {
    /** Unique identifier */
    id: string;

    /** Media URL */
    url: string;

    /** Media title */
    title: string;

    /** Media source */
    source: string;

    /** Media description */
    description: string;

    /** Text content */
    text: string;

    /** Content type */
    contentType?: string;

    /** Base64 encoded image data for LLM processing */
    base64Data?: string;

    /** Gemini AI analysis of the image content */
    geminiAnalysis?: string;
};

/**
 * Client instance
 */
export type ClientInstance = {
    /** Client name */
    // name: string;

    /** Stop client connection */
    stop: (runtime: IAgentRuntime) => Promise<unknown>;
};

/**
 * Client interface for platform connections
 */
export type Client = {
    /** Client name */
    name: string;

    /** Client configuration */
    config?: { [key: string]: any };

    /** Start client connection */
    start: (runtime: IAgentRuntime) => Promise<ClientInstance>;
};

/**
 * Database adapter initialization
 */
export type Adapter = {
    /** Initialize the adapter */
    init: (runtime: IAgentRuntime) => IDatabaseAdapter & IDatabaseCacheAdapter;
};

export type cexParamUiConstraints = {
    /** Other parameter key whose parsed instant must be <= this field (ISO datetime). */
    minFromField?: string;
    /** Other parameter key whose parsed instant must be >= this field (ISO datetime). */
    maxFromField?: string;
    /** When true, value must be strictly after current time (validated in UI). */
    minNow?: boolean;
};

export type cexParamDef = {
    type: "string" | "number" | "enum" | "boolean" | "object" | "array";
    required: true | false | string;
    description: string;
    uiLabel?: string;
    uiDescription?: string;
    /** Wire format for string params (e.g. ISO-8601 datetimes). */
    format?: "iso8601" | "date";
    /** Overrides default control in CEX approval UI. */
    uiControl?: "datetime" | "date";
    uiConstraints?: cexParamUiConstraints;
    enum?: string[];
    example?: string;
    properties?: Record<string, cexParamDef>;
    itemsType?: "string" | "number" | "object";
    injected?: boolean;
};

export type CEXActionSchema = {
    description: string;
    parameters: Record<string, cexParamDef>;
};

export type CEXCreateOrderCapabilities = {
    unsupportedOrderConfigurationVariants: string[];
    quoteSizeOnlyForMarketIoc: boolean;
    postOnlyOnlyForLimitGtc: boolean;
};

export type CEXCanonicalExchangeCapabilities = {
    exchange: string;
    actions: {
        get_orders?: { requiresProductIdsWithOrderIds: boolean };
        get_fills?: { requiresProductIds: boolean };
        cancel_order?: { requiresProductIdFallback: boolean };
        create_order?: CEXCreateOrderCapabilities;
    };
};

export type CEXCanonicalSpec = {
    version: string;
    schemas: Record<string, CEXActionSchema>;
    capabilities: Record<string, CEXCanonicalExchangeCapabilities>;
};

/**
 * Output of the autotrading risk engine. Mirrors the structural shape
 * exported by `@elizaos-plugins/plugin-cex` (`RiskDecision`) but kept
 * here as a plain structural type so core does not depend on the
 * plugin module — the plugin registers its implementation via
 * {@link CEXSpecProvider.runRiskPrecheck}.
 */
export interface CEXRiskDecision {
    verdict: "allow" | "block" | "downgrade_read_only";
    rules_fired: string[];
    explanations: string[];
    /**
     * Outcome of the risk-decision audit persistence step (plan §6.1).
     * - `true`  — the row landed in `risk_decisions`.
     * - `false` — the sink threw. Fail-closed policy refuses live writes.
     * - `null`  — no sink wired (legacy or test path).
     */
    audit_wrote_ok?: boolean | null;
    /** Echoed back to the handler for fail-closed bookkeeping. */
    request_id?: string;
    intent_hash?: string;
    /**
     * Mode the handler resolved for this intent — propagates to the
     * dep-health gate so paper bypasses fail-closed. Plan §6.0.2.
     */
    resolved_mode?: "live" | "paper" | "shadow";
}

/**
 * Input the handler passes to {@link CEXSpecProvider.runRiskPrecheck}.
 * Kept intentionally lossy — plugin code is expected to build a full
 * canonical intent + ctx from these primitives.
 */
export interface CEXRiskPrecheckInput {
    action: string;
    venue: string;
    userId: string;
    locale: "en" | "zh-CN" | "mixed-en";
    params: Record<string, unknown>;
    preferences?: Record<string, unknown>;
    /**
     * Mode of the canonical intent driving this evaluation. Defaults to
     * `live` when omitted. Paper mode disables fail-closed bookkeeping in
     * the plugin implementation. Plan §6.0.2.
     */
    mode?: "live" | "paper" | "shadow";
    /**
     * Number of currently-`unknown`-state orders the handler observes on
     * the same `(venue, symbol)`. Surfaces to the
     * `unknownStateBlocker` rule. Plan §6.0.3.
     */
    unknown_state_orders_on_pair?: number;
    /**
     * Optional caller-supplied notional estimate in USD (e.g. when the
     * handler already has a ticker mid-price for market orders). When
     * omitted, the plugin computes from the canonical intent:
     * `quote_size`, else `base_size * limit_price`. If neither path
     * yields a number, `maxOrderSize` / `exposureCap` rules skip with
     * an explanatory note. Plan §6.0 risk-engine.
     */
    estimated_notional_usd?: number;
    /**
     * Current mid-market price for `intent.symbol`, in quote units (USDT
     * for ETH-USDT). Drives the `priceDeviation` rule: limit prices
     * wildly off market (e.g. BTC price on ETH pair) are blocked. The
     * handler best-effort fetches this from the public ticker; omitted
     * means market data unavailable and the rule fail-opens.
     */
    market_mid_usd?: number;
    /**
     * Fix 11 — optional rule-filter list. When set, the risk engine
     * runs ONLY the listed rule ids and skips the rest. Used by the
     * Confirm-time quote-freshness re-check to cheaply re-evaluate
     * `priceDeviation` + `slippageCap` against the fresh quote
     * without re-running expensive rules (cooldown, exposureCap,
     * dailyLossLimit) that depend on slowly-changing state. Undefined
     * = run all rules (default behavior).
     */
    rules_to_run?: string[];
    /**
     * Fix 11 — optional override of `ctx.market_data_age_ms`. The
     * Confirm-time re-check passes 0 here because we just fetched a
     * fresh tick; without this the freshness rule would fire-block
     * based on the stale review-time age stamped on prefs.
     */
    market_data_age_ms?: number;
}

export type CEXSpecProvider = {
    getCanonicalSpec: () => CEXCanonicalSpec;
    getActionSchema: (actionName: string) => CEXActionSchema | undefined;
    /** Optional exchange-aware schema for approval UI and sanitization (e.g. omit spot-only fields on Binance). */
    getActionSchemaForApproval?: (
        actionName: string,
        exchange: string | null | undefined
    ) => CEXActionSchema | undefined;
    formatActionForLLM: (actionName: string, runtimeDescription?: string) => string;
    /** Validates merged approval params the same way as action execution (shape + exchange preflight). */
    validateApprovedActionParams?: (actionName: string, params: Record<string, unknown>) => void;
    /**
     * Optional deterministic risk pre-check (autotrading-uplift §1.5).
     * Returns null if the engine is unavailable; the handler treats
     * null as `allow` to preserve pre-Phase 1 behavior.
     */
    runRiskPrecheck?: (input: CEXRiskPrecheckInput) => Promise<CEXRiskDecision | null>;
    /**
     * Deterministic client_order_id derivation (autotrading-uplift §1.4).
     * Given the same canonical-intent inputs, returns the same id —
     * locale, request_id, and timestamps are intentionally excluded.
     */
    deriveClientOrderId?: (input: Omit<CEXRiskPrecheckInput, "preferences">) => string | null;
    /**
     * Structured trading-lifecycle event emitter (autotrading-uplift §1.6).
     * Core handlers call this at each lifecycle point; the plugin
     * implementation writes a `[Trading]` log line with the invariant
     * field set for CloudWatch metric filters. The provider hides the
     * plugin module so core doesn't depend on it directly.
     */
    emitTradingEvent?: (event: CEXTradingEventInput) => void;
    /**
     * ADK-bridge entry point (autotrading-uplift §3.2). Given a
     * preprocess-derived runtime context and a message, returns a
     * canonical-intent classification or a localized clarification.
     * The handler may use the returned intent to skip the legacy LLM
     * call entirely.
     */
    runTradingSubAgent?: (input: CEXTradingSubAgentInput) => CEXTradingSubAgentResult | null;
    /**
     * §8.6 — async variant wrapped by `withAdkTimeout`. Handlers should prefer
     * this over `runTradingSubAgent` so a hung classifier (today's rules-only
     * impl is instant, but a future LLM-backed extraction may not be) is
     * bounded by the 25s watchdog instead of stalling the workflow.
     */
    runTradingSubAgentSafe?: (
        input: CEXTradingSubAgentInput,
    ) => Promise<CEXTradingSubAgentResult | null>;
    /**
     * §6.8 — paired deterministic identity. Returns both the canonical
     * `client_order_id` AND `intent_hash` so the LLM-driven order path
     * can stamp both onto the ledger row (the §6.7 replay tool joins on
     * `intent_hash`). The ADK fast-path bypasses this — it carries both
     * inside the projected canonical intent — so callers should only
     * invoke this hook when going through the LLM path.
     */
    deriveIdempotency?: (
        input: Omit<CEXRiskPrecheckInput, "preferences">,
    ) => { client_order_id: string; intent_hash: string } | null;
    /**
     * Multi-turn order-ID resolver (cancel-order context fix).
     * Given the user's text and recent assistant memories, returns the
     * order ID to cancel when the user uses an anaphoric reference
     * ("that one", "the one you just showed", "cancel it"). Returns
     * null when no unambiguous referent is found.
     */
    resolveAnaphoricOrderId?: (input: CEXAnaphoricOrderIdInput) => CEXAnaphoricOrderIdOutput | null;
    /**
     * Multi-order extraction — returns every order_id + symbol pair
     * visible in the most recent assistant memory containing a
     * recognizable orders table. Used by "cancel all of these"
     * requests where the venue (Binance) needs a per-order symbol.
     */
    resolveAllOrdersFromContext?: (input: CEXAnaphoricOrderIdInput) => {
        orders: Array<{ order_id: string; symbol?: string }>;
        sourceMemoryId: string;
    } | null;
    /**
     * Reverse lookup: given an explicit order id (the user typed it
     * in their message), find the matching trading pair the agent
     * recently displayed for that id. Used by the cancel_order
     * fast-path on Binance, which requires `product_id` alongside
     * `order_ids` — without this, "cancel order <id>" bounces with
     * a clarification request even though the symbol was visible
     * in the previous turn's open-orders table.
     */
    resolveSymbolForOrderId?: (input: CEXSymbolForOrderIdInput) => CEXSymbolForOrderIdOutput | null;
    /**
     * Memory-routing helper (autotrading-uplift §5.2). Returns a
     * locale-aware summary line set the handler can inject into LLM
     * prompt context. The plugin reads user_trading_preferences +
     * recent ledger rows; core stays oblivious to those collections.
     */
    routeMemory?: (input: CEXMemoryRouterInput) => CEXMemoryRouterOutput;
    /**
     * Optional hybrid-retrieval reranker (autotrading-uplift §5.3).
     * `RAGKnowledgeManager` calls this AFTER its own score-based
     * filter when a candidate set is available. The plugin uses
     * BM25 + dense cosine + RRF + MMR + trust/freshness/portfolio
     * reranking. Returns the IDs of the kept documents in the new
     * ranking order; the caller projects back to the source set.
     */
    rerankKnowledgeCandidates?: (input: CEXRerankKnowledgeInput) => CEXRerankKnowledgeOutput;
    /**
     * Optional account-balance snapshot for the approval modal.
     * Used by `requestParameterReview` to fill in Avbl / Max Buy /
     * Est Fee on the `OrderConfigSummaryCard` so the user reviews
     * an order with full account context. Plugin-cex implements
     * this by re-using the existing exchange-service `getBalance`
     * call against the user's resolved credentials.
     *
     * Returns null on any failure (no credentials, rate-limited,
     * timeout) — the modal renders without these fields rather
     * than blocking the approval flow.
     */
    fetchAccountSnapshot?: (
        input: CEXAccountSnapshotInput,
    ) => Promise<CEXAccountSnapshotOutput | null>;

    /**
     * List the user's currently-open orders on `venue` (defaults to
     * their resolved default exchange). Used to pre-populate the
     * cancel_order approval modal with the full id list when the user
     * said "cancel all my orders" — the memory-based resolver only
     * finds ids the agent has recently rendered, which is often a
     * subset of what's actually open.
     *
     * Returns `null` on any failure (no credentials, rate-limited,
     * timeout, parse error) — the caller falls back to the existing
     * `all_open=true` fan-out behavior so a venue outage never blocks
     * the modal from opening.
     */
    fetchUserOpenOrders?: (
        input: CEXUserOpenOrdersInput,
    ) => Promise<CEXUserOpenOrder[] | null>;

    /**
     * Returns the venue's tradable products (USDT/USDC/USD-quoted only)
     * for the Pair combobox in the order editor. Cached in-process for
     * 15 min; pure public endpoint so no user auth is required.
     * Returns null on any failure — the editor falls back to a free-text
     * Pair input.
     */
    fetchTradableProducts?: (
        input: CEXTradableProductsInput,
    ) => Promise<CEXTradableProductsOutput | null>;

    /**
     * Current mid-market price for `symbol` on `venue`, in quote units.
     * Drives the `priceDeviation` risk rule. Best-effort: callers
     * should pass a timeout via `signal` and treat null as "data
     * unavailable" (the risk rule fail-opens). Public endpoint;
     * no user auth required.
     *
     * `bypassCache: true` forces a fresh ticker round-trip — used by
     * Fix 11 (quote-freshness re-check on Confirm) so the post-modal
     * drift check doesn't re-read the cached value the modal was
     * built from.
     */
    fetchMarketMidUsd?: (input: {
        runtime: IAgentRuntime;
        venue: string;
        symbol: string;
        signal?: AbortSignal;
        bypassCache?: boolean;
    }) => Promise<number | null>;

    /**
     * §6.0.2 fail-closed dep-health gate. Pure function. The handler calls
     * this after `runRiskPrecheck` returns and refuses live writes when
     * `healthy=false` (paper / shadow are pass-through). See plan §6.0.2.
     */
    checkTradingHealth?: (input: {
        riskAuditWroteOk: boolean | null;
        reconciliationHealthy: boolean | null;
        marketDataAgeMs: number | null;
        liveFreshnessCapMs: number;
        mode: "live" | "paper" | "shadow";
        /**
         * Canonical action — `create_order` / `cancel_order` / `amend_order`.
         * The dep-health gate skips the market-data-freshness reason for
         * cancels (no price dependency); see `dependencyHealth.ts`.
         */
        action?: string;
    }) =>
        | { healthy: true }
        | { healthy: false; reasons: string[]; bypassed: boolean };

    /**
     * §6.0.1 pre-submit ledger dedup. Returns a discriminated union the
     * handler uses to short-circuit duplicate submits. Pure function;
     * delegates to the ledger surface that the reconciliation service
     * exposes via `ITradingReconciliationService.getLedger()`.
     */
    checkExistingOrder?: (
        ledger: {
            getPendingOrderByClientOrderId(
                client_order_id: string,
            ): Promise<{
                request_id: string;
                client_order_id: string;
                state: string;
                venue: string;
                symbol: string;
                userId: string;
            } | null>;
        },
        client_order_id: string,
    ) => Promise<
        | { kind: "new" }
        | {
              kind: "in_flight" | "unknown_state" | "terminal";
              order: {
                  request_id: string;
                  client_order_id: string;
                  state: string;
                  venue: string;
                  symbol: string;
                  userId: string;
              };
          }
    >;

    /**
     * §6.0.2 — localized fail-closed message. The handler renders this in
     * the chat reply when `checkTradingHealth` refuses.
     */
    renderFailClosedMessage?: (
        reasons: string[],
        locale: "en" | "zh-CN" | "mixed-en",
    ) => string;

    /**
     * §6.2 — append an approval-decision audit row. Wraps the adapter's
     * `writeApprovalDecision` so the handler stays adapter-agnostic.
     */
    writeApprovalDecision?: (record: {
        request_id: string;
        userId: string;
        intent_hash?: string;
        level: 1 | 2;
        decision: "approved" | "rejected" | "expired";
        presented_summary?: Record<string, unknown>;
        consent_text_version?: string;
        approved_fields?: string[];
        clientIp?: string;
        userAgent?: string;
    }) => Promise<void>;

    /**
     * §6.3 — run `work` inside an async-scoped venue-call context. Venue
     * REST clients (binance.ts, coinbase.ts) read this context to attach
     * `request_id` / `intent_hash` / `userId` / `client_order_id` to every
     * `venue_calls` row + `[Trading] venue_call` event without threading
     * them through every action handler signature.
     */
    runWithVenueCallContext?: <T>(
        ctx: {
            request_id?: string;
            intent_hash?: string;
            userId?: string;
            client_order_id?: string;
        },
        work: () => Promise<T>,
    ) => Promise<T>;

    /**
     * §6.0.2 — last market-data sample age (ms) for a given (venue, symbol).
     * Used by the fail-closed dep-health gate to refuse live writes when
     * the reconciliation WS is silent. Returns null when no sample is
     * tracked yet (typically a fresh process).
     */
    getMarketDataAgeMs?: (venue: string, symbol: string) => number | null;

    /**
     * Canonical order NL formatter — projects approval params into
     * harness-style natural language (no variant keys in output).
     */
    formatOrderNl?: (action: string, params: Record<string, unknown>) => string;
    /** Compact order summary for stream copy and approval interrupt titles. */
    formatOrderSummary?: (
        params: Record<string, unknown>,
        action: string,
    ) => string;
    /** Full interrupt modal title from approval params. */
    formatApprovalInterruptTitle?: (
        params: Record<string, unknown>,
        action: string,
    ) => string;

    /**
     * Fix 7 — plan-time canonical-intent validation. Wraps the plugin's
     * `buildCanonicalIntent` + `canonicalIntentSchema` so the planner can
     * surface schema-rejection errors (e.g. non-positive sizes) BEFORE
     * persisting the plan. Returns `{ ok: true }` on success and
     * `{ ok: false, error }` with a one-line zod message on failure.
     *
     * `params` carries the same shape `requestParameterReview` would
     * receive at execute time (e.g. `{ product_id, side, order_configuration }`).
     */
    validateCanonicalIntent?: (input: {
        action: string;
        venue: string;
        userId: string;
        locale: "en" | "zh-CN" | "mixed-en";
        params: Record<string, unknown>;
        mode?: "live" | "paper" | "shadow";
    }) => { ok: true } | { ok: false; error: string };

    /**
     * Fix 7 — fetch per-symbol filters (status + minNotional + LOT_SIZE
     * + PRICE_FILTER) via the public exchangeInfo endpoint. Plan-time
     * validators use this to refuse delisted or sub-minimum orders
     * before the venue is called. Cached 1 h per process. Returns null
     * on any failure (network, parse, unknown symbol) so the validator
     * chain can degrade gracefully — the execute-time path still runs
     * its own checks.
     */
    fetchSymbolFilters?: (input: {
        venue: string;
        symbol: string;
    }) => Promise<CEXSymbolFilters | null>;
    /**
     * Fix 10 — deterministic intent cross-check. Compares the user's
     * biggest detected numeric quantity (paired with an asset or quote
     * token) against the LLM-extracted base/quote size and reports
     * whether they diverge by more than the configured threshold. Used
     * by `requestParameterReview` BEFORE the risk engine; a divergent
     * result short-circuits the approval modal with a clarification.
     * Pure function; safe to call on every request.
     */
    crossCheckUserIntent?: (input: {
        promptText: string;
        llmBaseSize?: number | string | null;
        llmQuoteSize?: number | string | null;
        tickerPrice?: number | null;
        /**
         * CEX post-PR237 Commit 10 (Issue 14) — user-typed limit price.
         * Preferred over `tickerPrice` for cross-unit normalization so
         * a stale ticker does not push the LLM's quantized base_size
         * outside the divergence threshold. See plugin-cex
         * `promptNumericExtractor.ts` for the full rationale.
         */
        executablePrice?: number | null;
        /**
         * CEX post-PR237 Commit 10 (Issue 14) — venue LOT_SIZE step.
         * Allows the comparator to widen its tolerance by one step's
         * worth of base-asset noise (converted to quote via the
         * normalization price), so a legitimate quantization rounding
         * does not look like an LLM hallucination.
         */
        baseStepSize?: number | null;
    }) => {
        divergent: boolean;
        userValue?: number;
        userUnit?: "base" | "quote";
        llmValueNormalized?: number;
        divergenceRatio?: number;
        reason?: string;
    };

    /**
     * Fix 14c — asset-name extractor for the symbol-verification guard.
     * Returns the de-duped, upper-case list of base-asset mentions in
     * the user's prompt (e.g. `["BTC", "ETH"]` for "rotate BTC to ETH").
     * Distinct from `crossCheckUserIntent` — this fires even when no
     * numeric anchor is present. Used to confirm the LLM-extracted
     * `product_id` contains at least one user-mentioned asset before
     * the modal renders.
     */
    extractAssetMentions?: (text: string) => string[];

    /**
     * Fix 14a — public bookTicker (best bid / best ask + spread bps).
     * Drives the modal's "Bid / Ask" rows. Cached 5 s per symbol;
     * single-flight de-dups concurrent callers. Returns null on any
     * failure so the modal renders without the live snapshot rather
     * than blocking the approval flow.
     *
     * CEX post-PR237 Commit 11 — accepts an optional `venue` parameter
     * so the dispatcher can route to the matching exchange API. When
     * omitted, defaults to Binance for backward-compat with the
     * historical hook contract. Symbol form is venue-normalized
     * internally so callers can pass any of `BTCUSDT` / `BTC-USDT` /
     * `BTC/USDT`.
     */
    fetchBookTicker?: (symbol: string, venue?: string) => Promise<{
        bid: string;
        bidQty: string;
        ask: string;
        askQty: string;
        spread_bps: number;
    } | null>;

    /**
     * Fix 14a — public order-book depth (top-N bids/asks). Drives the
     * modal's depth table. Cached 5 s per (symbol, limit); single-flight.
     *
     * CEX post-PR237 Commit 11 — accepts an optional `venue` parameter.
     * See {@link CEXSpecProvider.fetchBookTicker} for the routing rule.
     */
    fetchDepth?: (symbol: string, limit?: number, venue?: string) => Promise<{
        bids: Array<[string, string]>;
        asks: Array<[string, string]>;
        lastUpdateId: number;
    } | null>;

    /**
     * Fix 14a — public 24-hour rolling statistics (priceChangePercent,
     * high/low, volume, quoteVolume). Drives the modal's "24h % change"
     * row. Cached 5 s per symbol; single-flight.
     *
     * CEX post-PR237 Commit 11 — accepts an optional `venue` parameter.
     * See {@link CEXSpecProvider.fetchBookTicker} for the routing rule.
     */
    fetch24hStats?: (symbol: string, venue?: string) => Promise<{
        priceChangePercent: string;
        weightedAvgPrice: string;
        highPrice: string;
        lowPrice: string;
        volume: string;
        quoteVolume: string;
        openTime: number;
        closeTime: number;
    } | null>;
};

/**
 * Fix 7 — symbol filter shape exposed by
 * {@link CEXSpecProvider.fetchSymbolFilters}. Mirrors the plugin's
 * internal `BinanceSymbolFilters` but kept structural so core stays
 * adapter-agnostic.
 */
export interface CEXSymbolFilters {
    /** Symbol-level status. "TRADING" = live; anything else = dormant. */
    status?: string;
    /** Minimum order value in quote currency (NOTIONAL filter). */
    minNotional?: string;
    /** LOT_SIZE min/step. */
    minQty?: string;
    stepSize?: string;
    /** PRICE_FILTER tick. */
    tickSize?: string;
}

export interface CEXAccountSnapshotInput {
    runtime: IAgentRuntime;
    userId: UUID;
    /** Optional override; defaults to the user's default exchange. */
    venue?: string;
    /** Base asset (e.g., "BTC"). */
    baseAsset: string;
    /** Quote asset (e.g., "USDT"). */
    quoteAsset: string;
}

/** Input for {@link CEXSpecProvider.fetchUserOpenOrders}. */
export interface CEXUserOpenOrdersInput {
    runtime: IAgentRuntime;
    userId: UUID;
    /** Optional override; defaults to the user's default exchange. */
    venue?: string;
}

/** Single row returned by {@link CEXSpecProvider.fetchUserOpenOrders}. */
export interface CEXUserOpenOrder {
    /** Venue-side order id (string for cross-venue uniformity). */
    order_id: string;
    /** Canonical product id (`BTC-USDT`, `ETH-USDT`, …). */
    symbol: string;
}

export interface CEXAccountSnapshotOutput {
    /** Available units of base asset. String to avoid float drift. */
    baseAvailable: string;
    /** Available units of quote asset. */
    quoteAvailable: string;
    baseAsset: string;
    quoteAsset: string;
    /**
     * Maker/taker fee tier expressed in basis points. Default 10 (=
     * 0.10%) matches the value the backtest harness assumes. The
     * plugin may override if it has VIP-tier data for the user.
     */
    feeBps?: number;
}

export interface CEXTradableProductsInput {
    runtime: IAgentRuntime;
    /** Lowercase venue id (e.g. "binance" / "coinbase"). */
    venue: string;
    /**
     * When set, the result is filtered to margin-eligible pairs only
     * (Binance: symbols where `permissions` contains `MARGIN`). Coinbase
     * has no margin trading, so the implementation should return null
     * for any non-undefined value rather than silently returning spot
     * pairs.
     */
    marginType?: "cross" | "isolated";
}

export interface CEXTradableProduct {
    /** Canonical "BASE-QUOTE", e.g. "ETH-USDT". */
    product_id: string;
    base_asset: string;
    quote_asset: string;
}

export interface CEXTradableProductsOutput {
    venue: string;
    /** Subset of products; quote ∈ {USDT, USDC, USD} for the spot order editor. */
    products: CEXTradableProduct[];
    /** When the list was built (epoch ms). Used by the client for cache UX. */
    fetched_at_ms: number;
}

export interface CEXRerankKnowledgeInput {
    /** User-side query text. */
    query: string;
    /** Optional dense query embedding (BGE-M3 dim). */
    queryEmbedding?: number[];
    /** Portfolio symbols, e.g., ["BTC", "ETH"]. */
    portfolioSymbols?: string[];
    /** Top-K to return after reranking. */
    topK: number;
    /** Candidate documents (id + text + metadata). */
    candidates: Array<{
        id: string;
        text: string;
        embedding?: number[];
        trustTier?: "A" | "B" | "C";
        publishedAt?: string;
        symbols?: string[];
    }>;
}

export interface CEXRerankKnowledgeOutput {
    /** Document IDs in rerank order (most relevant first). */
    rankedIds: string[];
    /** Per-id final score (debugging). */
    scores?: Record<string, number>;
}

/**
 * Free-form event input for {@link CEXSpecProvider.emitTradingEvent}.
 * Plugin code interprets `stage` against its internal whitelist.
 */
export interface CEXTradingEventInput {
    stage:
        | "preprocess"
        | "intent_classified"
        | "clarification_request"
        | "stake_check"
        | "risk_check"
        | "idempotency"
        | "lock_acquire"
        | "lock_release"
        | "approval_request"
        | "approval_decision"
        | "order_submit"
        | "order_ack"
        | "order_error"
        | "reconciliation_event";
    request_id?: string;
    intent_hash?: string;
    userId?: string;
    venue?: string;
    symbol?: string;
    side?: "BUY" | "SELL";
    notional_usd?: number;
    locale?: "en" | "zh-CN" | "mixed-en";
    stake?: "read_only" | "write";
    decision?: string;
    rules_fired?: string[];
    latency_ms?: number;
    client_order_id?: string;
    [k: string]: unknown;
}

export interface CEXTradingSubAgentInput {
    message: string;
    userId: string;
    locale: "en" | "zh-CN" | "mixed-en";
    stake: "read_only" | "write";
    venue: string;
    mode?: "live" | "paper" | "shadow";
    killSwitchActive?: boolean;
    /** Hints to bypass NL classification when the action is already known. */
    forcedTool?: string;
    parameterHints?: Record<string, unknown>;
    /**
     * §6.8 — propagate the workflow's stable request_id into the
     * canonical intent the ADK builds. Without this the ADK assigns a
     * fresh request_id, breaking end-to-end replay.
     */
    requestId?: string;
    /**
     * F7-r3 — optional runtime handle. When the caller is async (via
     * `runTradingSubAgentSafe`) AND `message` trips the regex-confidence
     * gate inside `assessRegexConfidence` (stop-limit / non-default TIF /
     * post-only / margin tokens), the ADK runs the LLM extractor
     * (`llmExtractCreateOrderFields`) and merges the advanced fields
     * onto the canonical intent. Sync (`runTradingSubAgent`) callers
     * may omit this and the LLM extractor is skipped.
     *
     * Typed as `unknown` to keep `core/types.ts` free of a back-edge
     * import from itself; the plugin-cex side casts to `IAgentRuntime`.
     */
    runtime?: unknown;
}

export type CEXTradingSubAgentResult =
    | {
          kind: "canonical_intent";
          tool: string;
          action: string;
          /** Lossy view of the canonical intent's params for direct workflow consumption. */
          params: Record<string, unknown>;
          locale: "en" | "zh-CN" | "mixed-en";
      }
    | {
          kind: "clarification_question";
          text: string;
          locale: "en" | "zh-CN" | "mixed-en";
          tool?: string;
      };

export interface CEXAnaphoricOrderIdInput {
    /** User message text. */
    messageText: string;
    /** Locale to interpret anaphoric phrases. */
    locale: "en" | "zh-CN" | "mixed-en";
    /**
     * Recent assistant memories with markdown content. The resolver
     * scans for order tables / single-order detail rows.
     */
    recentAssistantMemories: Array<{ id: string; text: string; createdAt: number }>;
    /** Venue scoping when known; null = any. */
    venue?: string | null;
}

export interface CEXAnaphoricOrderIdOutput {
    order_id: string;
    /** Optional symbol pulled from the same row if visible. */
    symbol?: string;
    /** True when only one candidate was visible (high confidence). */
    unambiguous: boolean;
    /** Memory row id this decision came from. */
    sourceMemoryId: string;
}

export interface CEXSymbolForOrderIdInput {
    /** The order id the user typed (already extracted). */
    orderId: string;
    recentAssistantMemories: Array<{ id: string; text: string; createdAt: number }>;
    venue?: string | null;
}

export interface CEXSymbolForOrderIdOutput {
    symbol: string;
    sourceMemoryId: string;
}

export interface CEXMemoryRouterInput {
    messageText: string;
    locale: "en" | "zh-CN" | "mixed-en";
    userId: string;
    /**
     * Optional pre-fetched ledger rows for episodic recall ("what
     * was my last BTC trade?"). The handler keeps fetching out of
     * the plugin's hot path; pass undefined to skip episodic memory.
     */
    recentTrades?: Array<{
        client_order_id: string;
        venue: string;
        symbol?: string;
        side?: "BUY" | "SELL";
        state: string;
        submittedAt?: string;
    }>;
}

export interface CEXMemoryRouterOutput {
    /** Compact summary suitable for direct prompt injection. */
    summary: string;
    /** Itemized snippet records for debugging / UI surfacing. */
    snippets: Array<{
        id: string;
        source: "preferences" | "recent_trade" | "watchlist" | "thread";
        line: string;
    }>;
}

/**
 * Plugin for extending agent functionality
 */
export type Plugin = {
    /** Plugin name */
    name: string;

    /** Plugin npm name */
    npmName?: string;

    /** Plugin configuration */
    config?: { [key: string]: any };

    /** Plugin description */
    description: string;

    /** Optional actions */
    actions?: Action[];

    /** Optional providers */
    providers?: Provider[];

    /** Optional evaluators */
    evaluators?: Evaluator[];

    /** Optional services */
    services?: Service[];

    /** Optional clients */
    clients?: Client[];

    /** Optional adapters */
    adapters?: Adapter[];

    /** Optional post charactor processor handler */
    handlePostCharacterLoaded?: (char: Character) => Promise<Character>;

    /** Optional provider for CEX canonical action schemas/capabilities. */
    cexSpecProvider?: CEXSpecProvider;
};

export interface IAgentConfig {
    [key: string]: string;
}

export type TelemetrySettings = {
    /**
     * Enable or disable telemetry. Disabled by default while experimental.
     */
    isEnabled?: boolean;
    /**
     * Enable or disable input recording. Enabled by default.
     *
     * You might want to disable input recording to avoid recording sensitive
     * information, to reduce data transfers, or to increase performance.
     */
    recordInputs?: boolean;
    /**
     * Enable or disable output recording. Enabled by default.
     *
     * You might want to disable output recording to avoid recording sensitive
     * information, to reduce data transfers, or to increase performance.
     */
    recordOutputs?: boolean;
    /**
     * Identifier for this function. Used to group telemetry data by function.
     */
    functionId?: string;
};

export interface ModelConfiguration {
    temperature?: number;
    maxOutputTokens?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    maxInputTokens?: number;
    experimental_telemetry?: TelemetrySettings;
}

export type TemplateType = string | ((options: { state: State }) => string);

/** Keys for `Character.settings.specialPlugins` (per–workflow plugin npm/`name` lists). */
export enum PluginType {
    Default = "default",
    Trading = "trading",
    Mantle = "mantle",
}

/**
 * Split template for prompt caching optimization.
 * `system` contains static instructions (cached by OpenAI as prefix).
 * `prompt` contains dynamic per-request content.
 */
export interface Template {
    system: string;
    prompt: string;
}

/**
 * Configuration for an agent character
 */
export type Character = {
    /** Optional unique identifier */
    id?: UUID;

    /** Character name */
    name: string;

    /** Optional username */
    username?: string;

    /** Optional email */
    email?: string;

    /** Optional system prompt */
    system?: string;

    /** Model provider to use */
    modelProvider: ModelProviderName;

    /** Image model provider to use, if different from modelProvider */
    imageModelProvider?: ModelProviderName;

    /** Image Vision model provider to use, if different from modelProvider */
    imageVisionModelProvider?: ModelProviderName;

    /** Optional model endpoint override */
    modelEndpointOverride?: string;

    /** Optional prompt templates */
    templates?: {
        goalsTemplate?: TemplateType;
        factsTemplate?: TemplateType;
        messageHandlerTemplate?: TemplateType;
        shouldRespondTemplate?: TemplateType;
        continueMessageHandlerTemplate?: TemplateType;
        evaluationTemplate?: TemplateType;
        twitterSearchTemplate?: TemplateType;
        twitterActionTemplate?: TemplateType;
        twitterPostTemplate?: TemplateType;
        twitterMessageHandlerTemplate?: TemplateType;
        twitterShouldRespondTemplate?: TemplateType;
        twitterVoiceHandlerTemplate?: TemplateType;
        instagramPostTemplate?: TemplateType;
        instagramMessageHandlerTemplate?: TemplateType;
        instagramShouldRespondTemplate?: TemplateType;
        farcasterPostTemplate?: TemplateType;
        lensPostTemplate?: TemplateType;
        farcasterMessageHandlerTemplate?: TemplateType;
        lensMessageHandlerTemplate?: TemplateType;
        farcasterShouldRespondTemplate?: TemplateType;
        lensShouldRespondTemplate?: TemplateType;
        telegramMessageHandlerTemplate?: TemplateType;
        telegramShouldRespondTemplate?: TemplateType;
        telegramAutoPostTemplate?: string;
        telegramPinnedMessageTemplate?: string;
        discordAutoPostTemplate?: string;
        discordAnnouncementHypeTemplate?: string;
        discordVoiceHandlerTemplate?: TemplateType;
        discordShouldRespondTemplate?: TemplateType;
        discordMessageHandlerTemplate?: TemplateType;
        slackMessageHandlerTemplate?: TemplateType;
        slackShouldRespondTemplate?: TemplateType;
        jeeterPostTemplate?: string;
        jeeterSearchTemplate?: string;
        jeeterInteractionTemplate?: string;
        jeeterMessageHandlerTemplate?: string;
        jeeterShouldRespondTemplate?: string;
        devaPostTemplate?: string;
    };

    /** Character biography */
    bio: string | string[];

    /** Character background lore */
    lore: string[];

    /** Example messages */
    messageExamples: MessageExample[][];

    /** Example posts */
    postExamples: string[];

    /** Known topics */
    topics: string[];

    /** Character traits */
    adjectives: string[];

    /** Optional knowledge base */
    knowledge?: (string | { path: string; shared?: boolean } | { directory: string; shared?: boolean })[];

    /** Available plugins */
    plugins: Plugin[];

    /** Character Processor Plugins */
    postProcessors?: Pick<Plugin, 'name' | 'description' | 'handlePostCharacterLoaded'>[];

    /** Optional configuration */
    settings?: {
        secrets?: { [key: string]: string };
        intiface?: boolean;
        imageSettings?: {
            steps?: number;
            width?: number;
            height?: number;
            cfgScale?: number;
            negativePrompt?: string;
            numIterations?: number;
            guidanceScale?: number;
            seed?: number;
            modelId?: string;
            jobId?: string;
            count?: number;
            stylePreset?: string;
            hideWatermark?: boolean;
            safeMode?: boolean;
        };
        voice?: {
            model?: string; // For VITS
            url?: string; // Legacy VITS support
            elevenlabs?: {
                // New structured ElevenLabs config
                voiceId: string;
                model?: string;
                stability?: string;
                similarityBoost?: string;
                style?: string;
                useSpeakerBoost?: string;
            };
        };
        model?: string;
        modelConfig?: ModelConfiguration;
        embeddingModel?: string;
        chains?: {
            evm?: any[];
            solana?: any[];
            [key: string]: any[];
        };
        transcription?: TranscriptionProvider;
        ragKnowledge?: boolean;
        modelFallback?: {
            enabled?: boolean;
            provider?: ModelProviderName;
        };

        /** Per–workflow plugin allowlists (npm names and/or plugin `name`). */
        specialPlugins?: Partial<Record<PluginType, string[]>>;
    };

    /** Optional client-specific config */
    clientConfig?: {
        discord?: {
            shouldIgnoreBotMessages?: boolean;
            shouldIgnoreDirectMessages?: boolean;
            shouldRespondOnlyToMentions?: boolean;
            messageSimilarityThreshold?: number;
            isPartOfTeam?: boolean;
            teamAgentIds?: string[];
            teamLeaderId?: string;
            teamMemberInterestKeywords?: string[];
            allowedChannelIds?: string[];
            autoPost?: {
                enabled?: boolean;
                monitorTime?: number;
                inactivityThreshold?: number;
                mainChannelId?: string;
                announcementChannelIds?: string[];
                minTimeBetweenPosts?: number;
            };
        };
        telegram?: {
            shouldIgnoreBotMessages?: boolean;
            shouldIgnoreDirectMessages?: boolean;
            shouldRespondOnlyToMentions?: boolean;
            shouldOnlyJoinInAllowedGroups?: boolean;
            allowedGroupIds?: string[];
            messageSimilarityThreshold?: number;
            isPartOfTeam?: boolean;
            teamAgentIds?: string[];
            teamLeaderId?: string;
            teamMemberInterestKeywords?: string[];
            autoPost?: {
                enabled?: boolean;
                monitorTime?: number;
                inactivityThreshold?: number;
                mainChannelId?: string;
                pinnedMessagesGroups?: string[];
                minTimeBetweenPosts?: number;
            };
        };
        slack?: {
            shouldIgnoreBotMessages?: boolean;
            shouldIgnoreDirectMessages?: boolean;
        };
        gitbook?: {
            keywords?: {
                projectTerms?: string[];
                generalQueries?: string[];
            };
            documentTriggers?: string[];
        };
    };

    /** Writing style guides */
    style: {
        all: string[];
        chat: string[];
        post: string[];
    };

    /** Optional Twitter profile */
    twitterProfile?: {
        id: string;
        username: string;
        screenName: string;
        bio: string;
        nicknames?: string[];
    };

    /** Optional Instagram profile */
    instagramProfile?: {
        id: string;
        username: string;
        bio: string;
        nicknames?: string[];
    };

    /** Optional SimsAI profile */
    simsaiProfile?: {
        id: string;
        username: string;
        screenName: string;
        bio: string;
    };

    /** Optional NFT prompt */
    nft?: {
        prompt: string;
    };

    /**Optinal Parent characters to inherit information from */
    extends?: string[];

    twitterSpaces?: TwitterSpaceDecisionOptions;
};

export interface TwitterSpaceDecisionOptions {
    maxSpeakers?: number;
    topics?: string[];
    typicalDurationMinutes?: number;
    idleKickTimeoutMs?: number;
    minIntervalBetweenSpacesMinutes?: number;
    businessHoursOnly?: boolean;
    randomChance?: number;
    enableIdleMonitor?: boolean;
    enableSttTts?: boolean;
    enableRecording?: boolean;
    voiceId?: string;
    sttLanguage?: string;
    speakerMaxDurationMs?: number;
}

/**
 * Interface for database operations
 */
export interface IDatabaseAdapter {
    /** Database instance */
    db: any;

    /** Optional initialization */
    init(): Promise<void>;

    /** Close database connection */
    close(): Promise<void>;

    /** Get account by ID */
    getAccountById(userId: UUID): Promise<Account | null>;

    /** Get account by email */
    getAccountByEmail(email: string): Promise<Account | null>;

    /**
     * Merge duplicate accounts that share the same email.
     * Optional `preferredPrimaryId` lets adapters converge to a canonical account id.
     * Optional for adapters that don't support this operation.
     */
    mergeDuplicateAccountsByEmail?: (
        email: string,
        preferredPrimaryId?: UUID
    ) => Promise<{
        primaryId: UUID | null;
        mergedIds: UUID[];
    }>;

    // ========================================
    // Referral & Subscription methods
    // ========================================

    /** Get or create a referral code for a user */
    getOrCreateReferralCode(userId: UUID): Promise<string>;

    /** Get user ID by referral code */
    getUserIdByReferralCode(code: string): Promise<UUID | null>;

    /** Validate whether a referral code exists */
    validateReferralCode(code: string): Promise<boolean>;

    /** Create a referral relationship */
    createReferral(params: {
        referredUserId: UUID;
        referralCode: string;
    }): Promise<boolean>;

    /** Get the referrer for a user */
    getReferrerByUserId(userId: UUID): Promise<UUID | null>;

    /** Get all users referred by a referrer */
    getReferredUsers(referrerId: UUID): Promise<Array<{
        userId: UUID;
        email: string;
        createdAt: number;
    }>>;

    /** Record the referral code used by a user during registration */
    recordUserReferralCode(params: {
        userId: UUID;
        referralCodeUsed: string;
        isMatched: boolean;
    }): Promise<boolean>;

    /** Get the referral code used by a user during registration */
    getUserReferralCode(userId: UUID): Promise<{
        referralCodeUsed: string;
        isMatched: boolean;
        createdAt: number;
    } | null>;

    /** Get referral statistics for a referrer */
    getReferralStats(referrerId: UUID): Promise<{
        totalReferrals: number;
        activeSubscriptions: number;
        totalRevenue: number;
        currency: string;
    }>;

    /** Canonical resolved subscription tier used by billing and quota logic. */
    recordSubscriptionTierChange(params: {
        userId: UUID;
        tier: "free" | "plus" | "pro" | "enterprise";
        source?: string;
        observedAt?: number;
    }): Promise<boolean>;

    /** Record a subscription event from Stripe webhook */
    recordSubscriptionEvent(params: {
        userId: UUID;
        eventType: string;
        stripeEventId: string;
        stripeCustomerId?: string;
        stripeSubscriptionId?: string;
        subscriptionStatus?: string;
        planName?: string;
        amountCents?: number;
        currency?: string;
        eventData: object;
    }): Promise<boolean>;

    /** Update a user's current subscription status */
    updateUserSubscription(params: {
        userId: UUID;
        stripeCustomerId?: string;
        stripeSubscriptionId?: string;
        subscriptionStatus: string;
        planName?: string;
        currentPeriodStart?: number;
        currentPeriodEnd?: number;
        cancelAtPeriodEnd?: boolean;
        lastEventId: string;
    }): Promise<boolean>;

    /** Get a user's current subscription */
    getUserSubscription(userId: UUID): Promise<{
        subscriptionStatus: string;
        planName: string | null;
        currentPeriodEnd: number | null;
    } | null>;

    /** Get subscription events for a user */
    getSubscriptionEvents(
        userId: UUID,
        options?: {
            limit?: number;
            offset?: number;
            eventType?: string;
        }
    ): Promise<Array<{
        eventType: string;
        amountCents: number | null;
        currency: string | null;
        createdAt: number;
    }>>;

    /** Get user by Stripe customer ID */
    getUserByStripeCustomerId(stripeCustomerId: string): Promise<{
        userId: UUID;
    } | null>;

    /** Create new account */
    createAccount(account: Account): Promise<boolean>;

    /** Update the details blob for an account */
    updateAccountDetails(params: {
        userId: UUID;
        details: Record<string, any>;
    }): Promise<void>;

    /** Get memories matching criteria */
    getMemories(params: {
        roomId: UUID;
        count?: number;
        unique?: boolean;
        tableName: string;
        agentId: UUID;
        start?: number;
        end?: number;
    }): Promise<Memory[]>;

    getMemoryById(id: UUID): Promise<Memory | null>;

    getMemoriesByIds(ids: UUID[], tableName?: string): Promise<Memory[]>;

    getMemoriesByRoomIds(params: {
        tableName: string;
        agentId: UUID;
        roomIds: UUID[];
        limit?: number;
    }): Promise<Memory[]>;

    /** Get recent memories for a user regardless of room */
    getRecentUserMessages(params: {
        userId: UUID;
        agentId: UUID;
        limit: number;
        tableName?: string;
    }): Promise<Memory[]>;

    log(params: {
        body: { [key: string]: unknown };
        userId: UUID;
        roomId: UUID;
        type: string;
    }): Promise<void>;

    getActorDetails(params: { roomId: UUID }): Promise<Actor[]>;

    searchMemories(params: {
        tableName: string;
        agentId: UUID;
        roomId: UUID;
        embedding: number[];
        match_threshold: number;
        match_count: number;
        unique: boolean;
    }): Promise<Memory[]>;

    updateGoalStatus(params: {
        goalId: UUID;
        status: GoalStatus;
    }): Promise<void>;

    searchMemoriesByEmbedding(
        embedding: number[],
        params: {
            match_threshold?: number;
            count?: number;
            roomId?: UUID;
            agentId?: UUID;
            unique?: boolean;
            tableName: string;
        },
    ): Promise<Memory[]>;

    createMemory(
        memory: Memory,
        tableName: string,
        unique?: boolean,
    ): Promise<void>;

    updateMemoryContent(params: {
        id: UUID;
        tableName: string;
        content: Content;
    }): Promise<void>;

    removeMemory(memoryId: UUID, tableName: string): Promise<void>;

    removeAllMemories(roomId: UUID, tableName: string): Promise<void>;

    removeAllMemoriesByRoom(roomId: UUID): Promise<void>;

    countMemories(
        roomId: UUID,
        unique?: boolean,
        tableName?: string,
    ): Promise<number>;

    countUserMessages(params: {
        userId: UUID;
        tableName?: string;
        agentId?: UUID;
        since?: number;
    }): Promise<number>;

    getFavoriteTaskChains(params: {
        userId: UUID;
        agentId: UUID;
    }): Promise<FavoriteTaskChainRecord[]>;

    getFavoriteTaskChain(params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
    }): Promise<FavoriteTaskChainRecord | null>;
    getFavoriteTaskChainByChain(params: {
        chainId: string;
        userId: UUID;
        agentId: UUID;
    }): Promise<FavoriteTaskChainRecord | null>;

    createFavoriteTaskChain(
        params: FavoriteTaskChainCreateInput,
    ): Promise<FavoriteTaskChainRecord>;

    removeFavoriteTaskChain(params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
    }): Promise<void>;

    updateFavoriteTaskChainName(params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
        name: string;
    }): Promise<void>;

    updateFavoriteTaskChainVisibility(params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
        isPublic: boolean;
    }): Promise<FavoriteTaskChainRecord>;

    markFavoriteTaskChainUsed(params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
        timestamp?: number;
    }): Promise<void>;

    getSharedTaskChainByFavorite(params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
    }): Promise<SharedTaskChainRecord | null>;

    createSharedTaskChain(
        params: SharedTaskChainCreateInput,
    ): Promise<SharedTaskChainRecord>;

    getSharedTaskChainByCode(shareCode: string): Promise<SharedTaskChainRecord | null>;

    getSharedChatByRoom(params: {
        agentId: UUID;
        roomId: UUID;
    }): Promise<SharedChatRecord | null>;

    createSharedChat(
        params: SharedChatCreateInput,
    ): Promise<SharedChatRecord>;

    getSharedChatByCode(shareCode: string): Promise<SharedChatRecord | null>;

    getTrendingTaskChains(params: {
        agentId: UUID;
        limit?: number;
    }): Promise<Array<{
        chainId: string;
        name: string;
        description: string | null;
        totalExecutions: number;
        lastUsedAt: number | null;
        sampleFavoriteId: UUID | null;
        sampleUserId: UUID | null;
    }>>;

    getGoals(params: {
        agentId: UUID;
        roomId: UUID;
        userId?: UUID | null;
        onlyInProgress?: boolean;
        count?: number;
    }): Promise<Goal[]>;

    updateGoal(goal: Goal): Promise<void>;

    createGoal(goal: Goal): Promise<void>;

    removeGoal(goalId: UUID): Promise<void>;

    removeAllGoals(roomId: UUID): Promise<void>;

    removeLogsByRoom(roomId: UUID): Promise<void>;

    getRoom(roomId: UUID): Promise<UUID | null>;

    createRoom(roomId?: UUID, name?: string, agentId?: UUID): Promise<UUID>;

    getRoomById(roomId: UUID): Promise<{ id: UUID; name?: string; createdAt: string } | null>;

    removeRoom(roomId: UUID): Promise<void>;

    updateRoomName(roomId: UUID, name: string): Promise<void>;

    removeParticipantsByRoom(roomId: UUID): Promise<void>;

    getRoomsForParticipant(userId: UUID, agentId?: UUID): Promise<UUID[]>;

    getRoomsForParticipants(userIds: UUID[]): Promise<UUID[]>;

    addParticipant(userId: UUID, roomId: UUID, agentId?: UUID): Promise<boolean>;

    removeParticipant(userId: UUID, roomId: UUID): Promise<boolean>;

    getParticipantsForAccount(userId: UUID): Promise<Participant[]>;

    getParticipantsForRoom(roomId: UUID): Promise<UUID[]>;

    getParticipantUserState(
        roomId: UUID,
        userId: UUID,
    ): Promise<"FOLLOWED" | "MUTED" | null>;

    setParticipantUserState(
        roomId: UUID,
        userId: UUID,
        state: "FOLLOWED" | "MUTED" | null,
    ): Promise<void>;

    createRelationship(params: { userA: UUID; userB: UUID }): Promise<boolean>;

    getRelationship(params: {
        userA: UUID;
        userB: UUID;
    }): Promise<Relationship | null>;

    getRelationships(params: { userId: UUID }): Promise<Relationship[]>;

    getKnowledge(params: {
        id?: UUID;
        agentId: UUID;
        limit?: number;
        query?: string;
        conversationContext?: string;
    }): Promise<RAGKnowledgeItem[]>;

    searchKnowledge(params: {
        agentId: UUID;
        embedding: Float32Array;
        match_threshold: number;
        match_count: number;
        searchText?: string;
    }): Promise<RAGKnowledgeItem[]>;

    createKnowledge(knowledge: RAGKnowledgeItem): Promise<void>;
    removeKnowledge(id: UUID): Promise<void>;
    clearKnowledge(agentId: UUID, shared?: boolean): Promise<void>;

    // Action cache methods for public memory
    searchActionCache(params: {
        queryEmbedding: number[];
        actionName?: string;
        similarityThreshold: number;
        querySimilarityThreshold: number;
        limit: number;
    }): Promise<CachedActionResult[]>;

    createActionCache(params: {
        id: UUID;
        actionName: string;
        query: string;
        queryEmbedding: number[];
        result: string;
        chunkIndex: number;
        totalChunks: number;
        embedding: number[];
        createdAt: number;
        expiresAt: number;
        hitCount: number;
    }): Promise<void>;

    incrementActionCacheHitCount(ids: UUID[]): Promise<void>;

    cleanupExpiredActionCache(): Promise<number>;

    getActionCacheStats(): Promise<{
        totalEntries: number;
        totalHits: number;
        actionBreakdown: Record<string, number>;
    }>;

    // Token usage tracking methods for quota management
    saveTokenUsage(params: {
        id: string;
        userId: string;
        agentId: string;
        roomId?: string;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        modelProvider?: string;
        modelName?: string;
        modelClass?: string;
        timestamp: number;
    }): Promise<void>;

    getUserTokenUsage(params: {
        userId: string;
        since: number;
        until?: number;
    }): Promise<{
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
    }>;

    getUserFirstTokenUsageTimestamp(params: {
        userId: string;
    }): Promise<number | null>;

    cleanupOldTokenUsage(olderThan: number): Promise<number>;

    /** Get all configured CEX exchanges from the canonical registry. */
    getExchangeRegistry(): Promise<ExchangeRegistryEntry[]>;

    /** Get a single exchange registry entry by id, or null if unsupported. */
    getExchangeRegistryEntry(id: string): Promise<ExchangeRegistryEntry | null>;
}

export interface IDatabaseCacheAdapter {
    getCache(params: {
        agentId: UUID;
        key: string;
    }): Promise<string | undefined>;

    setCache(params: {
        agentId: UUID;
        key: string;
        value: string;
    }): Promise<boolean>;

    deleteCache(params: { agentId: UUID; key: string }): Promise<boolean>;
}

export interface IMemoryManager {
    runtime: IAgentRuntime;
    tableName: string;
    constructor: Function;

    addEmbeddingToMemory(memory: Memory): Promise<Memory>;

    getMemories(opts: {
        roomId: UUID;
        count?: number;
        unique?: boolean;
        start?: number;
        end?: number;
    }): Promise<Memory[]>;

    getMemoriesByIds(ids: UUID[]): Promise<Memory[]>;
    getMemoryById(id: UUID): Promise<Memory | null>;
    getMemoriesByRoomIds(params: {
        roomIds: UUID[];
        limit?: number;
    }): Promise<Memory[]>;
    searchMemoriesByEmbedding(
        embedding: number[],
        opts: {
            match_threshold?: number;
            count?: number;
            roomId?: UUID;
            unique?: boolean;
        },
    ): Promise<Memory[]>;

    createMemory(memory: Memory, unique?: boolean): Promise<void>;

    updateMemoryContent(memoryId: UUID, content: Content): Promise<void>;

    removeMemory(memoryId: UUID): Promise<void>;

    removeAllMemories(roomId: UUID): Promise<void>;

    countMemories(roomId: UUID, unique?: boolean): Promise<number>;
}

/**
 * Extended interface for User Feature Manager with dynamic aspect system
 */
export interface IUserFeatureManager extends IMemoryManager {
    /**
     * Process a message to potentially generate/update user feature aspects
     */
    processMessage(message: Memory): Promise<void>;

    /**
     * Retrieve aspects relevant to current query using semantic search
     */
    retrieveRelevantAspects(
        userId: UUID,
        queryMessage: string,
        options?: {
            topN?: number;
            similarityThreshold?: number;
        }
    ): Promise<UserFeatureAspect[]>;

    /**
     * Get all user aspects (fallback when semantic search returns nothing)
     */
    getAllUserAspects(userId: UUID): Promise<UserFeatureAspect[]>;

    /**
     * Format user traits for LLM context with semantic search support
     */
    formatUserTraitsForContext(
        userId?: UUID,
        options?: {
            queryMessage?: string;
            topN?: number;
            similarityThreshold?: number;
            fallbackToAll?: boolean;
        }
    ): Promise<string>;

    /**
     * F2 — list every inferred aspect for a user paired with its
     * `memoryId` so the Settings UI can render + act on individual rows.
     */
    listUserAspectsWithMemoryIds(
        userId: UUID,
    ): Promise<Array<{ memoryId: UUID; aspect: UserFeatureAspect }>>;

    /**
     * F2 — flip the user-consent flag on a single aspect memory.
     */
    setAspectConsent(
        userId: UUID,
        memoryId: UUID,
        consent: "approved" | "rejected" | "pending",
    ): Promise<boolean>;

    /**
     * F2 — hard-delete one inferred aspect.
     */
    deleteAspect(userId: UUID, memoryId: UUID): Promise<boolean>;

    /**
     * F2 — bulk-delete every inferred aspect for a user.
     */
    deleteAllUserAspects(userId: UUID): Promise<number>;
}

export interface IRAGKnowledgeManager {
    runtime: IAgentRuntime;
    tableName: string;

    getKnowledge(params: {
        query?: string;
        id?: UUID;
        limit?: number;
        conversationContext?: string;
        agentId?: UUID;
    }): Promise<RAGKnowledgeItem[]>;
    createKnowledge(item: RAGKnowledgeItem): Promise<void>;
    removeKnowledge(id: UUID): Promise<void>;
    searchKnowledge(params: {
        agentId: UUID;
        embedding: Float32Array | number[];
        match_threshold?: number;
        match_count?: number;
        searchText?: string;
    }): Promise<RAGKnowledgeItem[]>;
    clearKnowledge(shared?: boolean): Promise<void>;
    processFile(file: {
        path: string;
        content: string;
        type: "pdf" | "md" | "txt";
        isShared: boolean;
    }): Promise<void>;
    cleanupDeletedKnowledgeFiles(): Promise<void>;
    generateScopedId(path: string, isShared: boolean): UUID;
}

export type CacheOptions = {
    expires?: number;
};

export enum CacheStore {
    REDIS = "redis",
    DATABASE = "database",
    FILESYSTEM = "filesystem",
}

export interface ICacheManager {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T, options?: CacheOptions): Promise<void>;
    delete(key: string): Promise<void>;
}

export abstract class Service {
    private static instance: Service | null = null;

    static get serviceType(): ServiceType {
        throw new Error("Service must implement static serviceType getter");
    }

    public static getInstance<T extends Service>(): T {
        if (!Service.instance) {
            Service.instance = new (this as any)();
        }
        return Service.instance as T;
    }

    get serviceType(): ServiceType {
        return (this.constructor as typeof Service).serviceType;
    }

    // Add abstract initialize method that must be implemented by derived classes
    abstract initialize(runtime: IAgentRuntime): Promise<void>;
}

export interface IAgentRuntime {
    // Properties
    agentId: UUID;
    serverUrl: string;
    databaseAdapter: IDatabaseAdapter;
    token: string | null;
    modelProvider: ModelProviderName;
    imageModelProvider: ModelProviderName;
    imageVisionModelProvider: ModelProviderName;
    character: Character;
    providers: Provider[];
    actions: Action[];
    evaluators: Evaluator[];
    plugins: Plugin[];

    fetch?: typeof fetch | null;

    messageManager: IMemoryManager;
    descriptionManager: IMemoryManager;
    documentsManager: IMemoryManager;
    knowledgeManager: IMemoryManager;
    ragKnowledgeManager: IRAGKnowledgeManager;
    ruleLearningMemoryManager: IMemoryManager;
    loreManager: IMemoryManager;
    userFeatureManager: IUserFeatureManager;

    cacheManager: ICacheManager;

    services: Map<ServiceType, Service>;
    clients: ClientInstance[];

    taskChainPlanner?: TaskChainPlanner;

    // verifiableInferenceAdapter?: IVerifiableInferenceAdapter | null;

    initialize(): Promise<void>;

    registerMemoryManager(manager: IMemoryManager): void;

    getMemoryManager(name: string): IMemoryManager | null;

    getService<T extends Service>(service: ServiceType): T | null;

    registerService(service: Service): void;

    getSetting(key: string): string | null;

    // API Key Management
    getSettingArray(baseKey: string): string[];
    getNextApiKey(baseKey: string, resetFailuresAfter?: number): string | null;
    markApiKeyAsFailed(baseKey: string, apiKey: string): void;
    getCurrentApiKey(baseKey: string): string | null;

    // Methods
    getConversationLength(): number;

    setActionTimeout(timeoutMs: number): void;
    getActionTimeout(): number;

    handleMessageWithTaskChain(
        message: Memory,
        callback?: HandlerCallback,
        streamingCallback?: StreamingCallback,
        intermediateResponseCallback?: (response: Memory) => void,
    ): Promise<Memory[]>;

    processActions(
        message: Memory,
        responses: Memory[],
        state?: State,
        callback?: HandlerCallback,
        streamingCallback?: StreamingCallback,
        onToken?: (delta: string) => void | Promise<void>,
    ): Promise<{ success: boolean; error?: string; errorDetails?: any }>;

    evaluate(
        message: Memory,
        state?: State,
        didRespond?: boolean,
        callback?: HandlerCallback,
    ): Promise<string[] | null>;

    ensureParticipantExists(userId: UUID, roomId: UUID): Promise<void>;

    ensureUserExists(
        userId: UUID,
        userName: string | null,
        name: string | null,
        source: string | null,
    ): Promise<void>;

    registerAction(action: Action): void;

    ensureConnection(
        userId: UUID,
        roomId: UUID,
        userName?: string,
        userScreenName?: string,
        source?: string,
    ): Promise<void>;

    ensureParticipantInRoom(userId: UUID, roomId: UUID): Promise<void>;

    ensureRoomExists(roomId: UUID): Promise<void>;

    composeState(
        message: Memory,
        additionalKeys?: { [key: string]: unknown },
    ): Promise<State>;

    updateRecentMessageState(state: State): Promise<State>;

    // Stop processing functionality
    stopProcessing?(): void;
    resetStopFlag?(): void;
    shouldStop?(): boolean;
    /**
     * Signal that aborts when the user requests stop. Pass to fetch /
     * generateText / SDK calls so in-flight LLM calls cancel mid-stream
     * (not just between chain levels). Lazily created on first access and
     * replaced inside resetStopFlag() since signals can't be un-aborted.
     */
    getAbortSignal?(): AbortSignal;
    cleanupActionExecutionTracker?(): void;
}

export interface IImageDescriptionService extends Service {
    describeImage(
        imageUrl: string,
    ): Promise<{ title: string; description: string }>;
}

export interface ITranscriptionService extends Service {
    transcribeAttachment(audioBuffer: ArrayBuffer): Promise<string | null>;
    transcribeAttachmentLocally(
        audioBuffer: ArrayBuffer,
    ): Promise<string | null>;
    transcribe(audioBuffer: ArrayBuffer): Promise<string | null>;
    transcribeLocally(audioBuffer: ArrayBuffer): Promise<string | null>;
}

export interface IVideoService extends Service {
    isVideoUrl(url: string): boolean;
    fetchVideoInfo(url: string): Promise<Media>;
    downloadVideo(videoInfo: Media): Promise<string>;
    processVideo(url: string, runtime: IAgentRuntime): Promise<Media>;
}

export interface ITextGenerationService extends Service {
    initializeModel(): Promise<void>;
    queueMessageCompletion(
        context: string,
        temperature: number,
        stop: string[],
        frequency_penalty: number,
        presence_penalty: number,
        max_tokens: number,
    ): Promise<any>;
    queueTextCompletion(
        context: string,
        temperature: number,
        stop: string[],
        frequency_penalty: number,
        presence_penalty: number,
        max_tokens: number,
    ): Promise<string>;
    getEmbeddingResponse(input: string): Promise<number[] | undefined>;
}

export interface IBrowserService extends Service {
    closeBrowser(): Promise<void>;
    getPageContent(
        url: string,
        runtime: IAgentRuntime,
    ): Promise<{ title: string; description: string; bodyContent: string }>;
}

export interface ISpeechService extends Service {
    getInstance(): ISpeechService;
    generate(runtime: IAgentRuntime, text: string): Promise<Readable>;
}

export interface IPdfService extends Service {
    getInstance(): IPdfService;
    convertPdfToText(pdfBuffer: Buffer): Promise<string>;
}

export interface IAwsS3Service extends Service {
    uploadFile(
        imagePath: string,
        subDirectory: string,
        useSignedUrl: boolean,
        expiresIn: number,
    ): Promise<{
        success: boolean;
        url?: string;
        error?: string;
    }>;
    generateSignedUrl(fileName: string, expiresIn: number): Promise<string>;
}

export interface UploadIrysResult {
    success: boolean;
    url?: string;
    error?: string;
    data?: any;
}

export interface DataIrysFetchedFromGQL {
    success: boolean;
    data: any;
    error?: string;
}

export interface GraphQLTag {
    name: string;
    values: any[];
}

export enum IrysMessageType {
    REQUEST = "REQUEST",
    DATA_STORAGE = "DATA_STORAGE",
    REQUEST_RESPONSE = "REQUEST_RESPONSE",
}

export enum IrysDataType {
    FILE = "FILE",
    IMAGE = "IMAGE",
    OTHER = "OTHER",
}

export interface IrysTimestamp {
    from: number;
    to: number;
}

export interface IIrysService extends Service {
    getDataFromAnAgent(
        agentsWalletPublicKeys: string[],
        tags: GraphQLTag[],
        timestamp: IrysTimestamp,
    ): Promise<DataIrysFetchedFromGQL>;
    workerUploadDataOnIrys(
        data: any,
        dataType: IrysDataType,
        messageType: IrysMessageType,
        serviceCategory: string[],
        protocol: string[],
        validationThreshold: number[],
        minimumProviders: number[],
        testProvider: boolean[],
        reputation: number[],
    ): Promise<UploadIrysResult>;
    providerUploadDataOnIrys(
        data: any,
        dataType: IrysDataType,
        serviceCategory: string[],
        protocol: string[],
    ): Promise<UploadIrysResult>;
}

export interface ITeeLogService extends Service {
    getInstance(): ITeeLogService;
    log(
        agentId: string,
        roomId: string,
        userId: string,
        type: string,
        content: string,
    ): Promise<boolean>;
}

export enum ServiceType {
    IMAGE_DESCRIPTION = "image_description",
    TRANSCRIPTION = "transcription",
    VIDEO = "video",
    TEXT_GENERATION = "text_generation",
    BROWSER = "browser",
    SPEECH_GENERATION = "speech_generation",
    PDF = "pdf",
    INTIFACE = "intiface",
    AWS_S3 = "aws_s3",
    BUTTPLUG = "buttplug",
    SLACK = "slack",
    VERIFIABLE_LOGGING = "verifiable_logging",
    IRYS = "irys",
    TEE_LOG = "tee_log",
    GOPLUS_SECURITY = "goplus_security",
    WEB_SEARCH = "web_search",
    EMAIL_AUTOMATION = "email_automation",
    NKN_CLIENT_SERVICE = "nkn_client_service",
    TRADING_RECONCILIATION = "trading_reconciliation",
    STRATEGY_ENGINE = "strategy_engine",
}

/** Minimal interface used by cexWorkflowMessageHandler to interact with the reconciliation subsystem. */
export interface ITradingReconciliationService extends Service {
    /**
     * Acquire a per-symbol trading lock. Serializes concurrent submits for
     * the same (userId, venue, symbol). Returns a release function that MUST
     * be called in a finally block.
     */
    acquireOrderLock(userId: string, venue: string, symbol: string): Promise<() => void>;

    /**
     * Register a newly submitted order in the pending-orders ledger.
     * Call after REST submit succeeds, passing key fields from the intent.
     */
    trackOrder(row: {
        request_id: string;
        intent_hash: string;
        client_order_id: string;
        venue: string;
        symbol: string;
        userId: string;
        state: string;
        submittedAt: string;
        lastSeenAt: string;
        latest_payload: unknown;
        locale: string;
        /**
         * B2 — set for margin orders so the reconciliation poller
         * dispatches to `/sapi/v1/margin/order` instead of the spot
         * endpoint. Omit for spot orders.
         */
        margin_type?: "CROSS" | "ISOLATED";
    }): Promise<void>;

    /**
     * Whether the reconciliation subsystem is healthy enough to accept a new
     * write for the given venue. Returns `true` when the service is running
     * and at least one transport (WS or REST fallback) is operational. The
     * handler's dep-health gate refuses live writes when this is `false`.
     * See plan §6.0.2.
     */
    isHealthy?(venue?: string): boolean;

    /**
     * Read-only ledger access for pre-submit dedup queries. Returns null when
     * no ledger is configured (SQLite mode). See plan §6.0.1.
     */
    getLedger?(): {
        getPendingOrderByClientOrderId(
            client_order_id: string,
        ): Promise<{
            request_id: string;
            client_order_id: string;
            state: string;
            venue: string;
            symbol: string;
            userId: string;
        } | null>;
    } | null;
}

export enum LoggingLevel {
    DEBUG = "debug",
    VERBOSE = "verbose",
    NONE = "none",
}

export type KnowledgeItem = {
    id: UUID;
    content: Content;
};

export interface RAGKnowledgeItem {
    id: UUID;
    agentId: UUID;
    content: {
        text: string;
        metadata?: {
            isMain?: boolean;
            isChunk?: boolean;
            originalId?: UUID;
            chunkIndex?: number;
            source?: string;
            type?: string;
            isShared?: boolean;
            [key: string]: unknown;
        };
    };
    embedding?: Float32Array;
    createdAt?: number;
    similarity?: number;
    score?: number;
}

export interface ActionResponse {
    like: boolean;
    retweet: boolean;
    quote?: boolean;
    reply?: boolean;
}

export interface ISlackService extends Service {
    client: any;
}

export enum TokenizerType {
    Auto = "auto",
    TikToken = "tiktoken",
}

export enum TranscriptionProvider {
    OpenAI = "openai",
    Deepgram = "deepgram",
    Local = "local",
}

export enum ActionTimelineType {
    ForYou = "foryou",
    Following = "following",
}
export enum KnowledgeScope {
    SHARED = "shared",
    PRIVATE = "private",
}

export enum CacheKeyPrefix {
    KNOWLEDGE = "knowledge",
}

export interface DirectoryItem {
    directory: string;
    shared?: boolean;
}

export interface ChunkRow {
    id: string;
    // Add other properties if needed
}

export interface ProcessingStep {
    id: string;
    name: string;
    status: 'pending' | 'in_progress' | 'completed' | 'error';
    message: string;
    timestamp: number;
    data?: any;
    error?: string;
    tokenUsage?: TokenUsage;
}

export type StreamingCallback = (step: ProcessingStep) => void;

/**
 * Token usage information for a single AI model call
 */
export interface TokenUsage {
    /** Number of input (prompt) tokens */
    inputTokens: number;
    
    /** Number of output (completion) tokens */
    outputTokens: number;
    
    /** Total tokens (input + output) */
    totalTokens: number;
    
    /** Estimated cost for input tokens */
    inputCost: number;
    
    /** Estimated cost for output tokens */
    outputCost: number;
    
    /** Total estimated cost */
    totalCost: number;
    
    /** Actual usage returned by provider (if available) */
    actualUsage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
    };
}

/**
 * API usage metrics for database storage
 */
export interface UsageMetrics {
    /** Unique identifier */
    id?: string;
    
    /** Agent ID that made the request */
    agentId: string;
    
    /** User ID who initiated the request */
    userId?: string;
    
    /** Room ID where request was made */
    roomId?: string;
    
    /** Model provider (openai, anthropic, etc.) */
    modelProvider: string;
    
    /** Specific model name */
    modelName: string;

    /** Model class (small/medium/large) used for the request */
    modelClass?: ModelClass;
    
    /** Token usage information */
    usage: TokenUsage;
    
    /** Type of request (text_generation, object_generation, embedding, etc.) */
    requestType: string;
    
    /** Response time in milliseconds */
    responseTimeMs?: number;
    
    /** Whether the request was successful */
    success: boolean;
    
    /** Error message if request failed */
    error?: string;
    
    /** Timestamp when request was made */
    createdAt: number;
}

/**
 * Aggregated usage statistics
 */
export interface UsageStats {
    /** Total number of requests */
    totalRequests: number;
    
    /** Total input tokens consumed */
    totalInputTokens: number;
    
    /** Total output tokens generated */
    totalOutputTokens: number;
    
    /** Total tokens (input + output) */
    totalTokens: number;
    
    /** Total estimated cost */
    totalCost: number;
    
    /** Breakdown by model provider */
    byProvider: {
        [provider: string]: {
            requests: number;
            inputTokens: number;
            outputTokens: number;
            totalTokens: number;
            cost: number;
        };
    };
    
    /** Breakdown by model */
    byModel: {
        [model: string]: {
            requests: number;
            inputTokens: number;
            outputTokens: number;
            totalTokens: number;
            cost: number;
        };
    };
    
    /** Breakdown by request type */
    byRequestType: {
        [type: string]: {
            requests: number;
            inputTokens: number;
            outputTokens: number;
            totalTokens: number;
            cost: number;
        };
    };
    
    /** Usage over time (daily aggregation) */
    dailyUsage: {
        date: string;
        requests: number;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        cost: number;
    }[];
}

/**
 * Usage summary for a specific time period
 */
export interface UsageSummary {
    /** Period covered by this summary */
    period: {
        startDate: string;
        endDate: string;
    };
    
    /** Usage statistics */
    stats: UsageStats;
    
    /** Top models by usage */
    topModels: {
        model: string;
        provider: string;
        requests: number;
        tokens: number;
        cost: number;
    }[];
    
    /** Most expensive requests */
    expensiveRequests: {
        timestamp: number;
        model: string;
        provider: string;
        tokens: number;
        cost: number;
        requestType: string;
    }[];
}

// ============================================================================
// CHAIN-OF-TASKS TYPES
// ============================================================================

/**
 * Type of task in the chain
 */
export type TaskType = 
    | 'llm'         // Requires LLM call (analysis, reasoning, text generation)
    | 'action'      // Execute plugin action (data fetching, API calls)  
    | 'processing' // Data transformation, validation, formatting
    | 'control';    // Conditional logic, loops, branching

/**
 * Status of task execution
 */
export type TaskStatus =
    | 'pending'     // Not yet started
    | 'running'     // Currently executing
    | 'completed'   // Successfully finished
    | 'failed'      // Failed with error
    | 'skipped'     // Skipped due to conditions
    | 'cancelled';  // Aborted by user via Stop/Cancel

/**
 * Individual task node in the execution chain
 */
export interface TaskNode {
    /** Unique identifier for the task */
    id: UUID;
    
    /** Type of task */
    type: TaskType;
    
    /** Human-readable name/description */
    name: string;
    
    /** Detailed description of what this task does */
    description: string;
    
    /** Current execution status */
    status: TaskStatus;
    
    /** Task dependencies - must complete before this task can run */
    dependencies: UUID[];
    
    /** Expected inputs for this task */
    inputs: {
        /** Input name */
        name: string;
        /** Input type */
        type: string;
        /** Whether input is required */
        required: boolean;
        /** Source of input (dependency task ID or 'user') */
        source?: UUID | 'user';
    }[];
    
    /** Expected outputs from this task */
    outputs: {
        /** Output name */
        name: string;
        /** Output type */
        type: string;
        /** Output description */
        description: string;
    }[];
    
    /** Task configuration based on type */
    config: TaskConfig;
    
    /** Actual execution results */
    result?: {
        /** Output data */
        data: Record<string, any>;
        /** Execution metadata */
        metadata: {
            /** Start time */
            startTime: number;
            /** End time */
            endTime: number;
            /** Duration in ms */
            duration: number;
            /** Token usage if LLM task */
            tokenUsage?: TokenUsage;
            /** Error details if failed */
            error?: {
                type: string;
                message: string;
                stack?: string;
            };
        };
    };
}

/**
 * Configuration for different task types
 */
export type TaskConfig =
    | LLMTaskConfig
    | ActionTaskConfig;

/**
 * Configuration for LLM tasks
 */
export interface LLMTaskConfig {
    /** Model class to use */
    modelClass: ModelClass;
    /** Template for the LLM prompt */
    template: string;
    /** Context variables to inject into template */
    contextVariables?: Record<string, any>;
    /** Whether to expect JSON response */
    expectJson?: boolean;
    /** JSON schema for validation if expectJson is true */
    jsonSchema?: any;
}

/**
 * Configuration for action tasks
 */
export interface ActionTaskConfig {
    /** Array of actions to execute for this task */
    actions: Array<{
        /** Name of action to execute */
        action: string;
        /** Parameters for the action */
        parameters: Record<string, any>;
    }>;
    /** Flag indicating if task was completed via duplicate optimization */
    duplicateOptimization?: boolean;
    /** Flag indicating if task should be removed from chain */
    shouldRemove?: boolean;
    /** Cached actions (duplicates removed by optimization) */
    cachedActions?: Array<{
        /** Name of the cached action */
        action: string;
        /** Parameters that were used */
        parameters: Record<string, any>;
        /** Reason why this action was marked as duplicate */
        reason: string;
    }>;
}

/**
 * Execution plan for task chain
 */
export interface TaskChain {
    /** Unique identifier for the chain */
    id: UUID;
    
    /** Human-readable name for the chain */
    name: string;
    
    /** Description of what this chain accomplishes */
    description: string;
    
    /** All tasks in the chain */
    tasks: TaskNode[];
    
    /** Original user request that generated this chain */
    originalRequest: string;
    
    /** Execution metadata */
    metadata: {
        /** When chain was created */
        createdAt: number;
        /** When execution started */
        startTime?: number;
        /** When execution completed */
        endTime?: number;
        /** Overall status */
        status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
        /** Total estimated duration */
        estimatedDuration?: number;
        /** Actual duration */
        actualDuration?: number;
    };
    
    /** Execution configuration */
    config: {
        /** Maximum parallel task execution */
        maxParallel: number;
        /** Overall timeout for chain execution */
        timeout: number;
        /** Whether to continue on task failures */
        continueOnFailure: boolean;
    };
}

/**
 * Flattened representation of a task for UI snapshots
 */
export interface TaskChainTask {
    id: string;
    name: string;
    description: string;
    type: "llm" | "action";
    status: "pending" | "running" | "completed" | "failed" | "cancelled";
    dependencies: string[];
    hasResult: boolean;
    isSuccess: boolean;
    executionResult?: Memory;
    startTime?: number;
    endTime?: number;
    error?: string;
}

/**
 * Task chain metadata consumed by frontend components
 */
export interface TaskChainData {
    id: string;
    name: string;
    description: string;
    originalRequest?: string;
    tasks: TaskChainTask[];
}

/**
 * Persisted favorite task chain metadata scoped to a user and agent.
 */
export interface FavoriteTaskChainRecord {
    id: UUID;
    userId: UUID;
    agentId: UUID;
    chainId: string;
    name: string;
    originalName: string;
    description?: string;
    taskChain: TaskChainData;
    createdAt: number;
    lastUsedAt?: number;
    isPublic: boolean;
}

/**
 * Attributes required to create a favorite task chain record.
 */
export interface FavoriteTaskChainCreateInput {
    userId: UUID;
    agentId: UUID;
    chainId: string;
    name: string;
    originalName: string;
    description?: string;
    taskChain: TaskChainData;
    createdAt?: number;
    isPublic?: boolean;
}

/**
 * Persisted shared task chain metadata, retrievable via public share codes.
 */
export interface SharedTaskChainRecord {
    id: UUID;
    shareCode: string;
    userId: UUID;
    agentId: UUID;
    favoriteId?: UUID | null;
    chainId: string;
    name: string;
    originalName: string;
    description?: string;
    taskChain: TaskChainData;
    createdAt: number;
}

/**
 * Attributes required to create a shared task chain record.
 */
export interface SharedTaskChainCreateInput {
    userId: UUID;
    agentId: UUID;
    chainId: string;
    name: string;
    originalName: string;
    description?: string;
    taskChain: TaskChainData;
    shareCode: string;
    favoriteId?: UUID | null;
    createdAt?: number;
}

/**
 * Persisted shared chat metadata, retrievable via public share codes.
 * This enables unauthenticated viewers to open a read-only transcript page.
 */
export interface SharedChatRecord {
    id: UUID;
    shareCode: string;
    userId: UUID;
    agentId: UUID;
    roomId: UUID;
    createdAt: number;
}

/**
 * Attributes required to create a shared chat record.
 */
export interface SharedChatCreateInput {
    userId: UUID;
    agentId: UUID;
    roomId: UUID;
    shareCode: string;
    createdAt?: number;
}

/**
 * Execution details for a single task
 */
export interface TaskExecutionResult {
    taskId: string;
    taskName: string;
    type: "llm" | "action";
    status: "completed" | "failed";
    executionTime: number;
    result?: Memory;
    error?: string;
}

/**
 * Serialized snapshot of a task chain run
 */
export interface TaskChainSnapshot {
    taskChainData: TaskChainData;
    executionResults: TaskExecutionResult[];
    completionInfo: {
        totalTasks: number;
        completedTasks: number;
        failedTasks: number;
        pendingTasks: number;
        overallStatus: "completed" | "partial" | "failed" | "running";
        overallProgress: number;
    };
    title: string;
    createdAt: number;
}

/**
 * Interface for planning task chains from user requests
 */
export interface TaskChainPlanner {
    /**
     * Analyze user request and generate optimal task chain
     */
    planChain(
        request: string,
        context: State,
        availableActions: Action[],
        streamingCallback?: StreamingCallback
    ): Promise<TaskChain>;
    
    /**
     * Optimize existing chain for better performance
     */
    optimizeChain(chain: TaskChain): Promise<TaskChain>;
    
    /**
     * Validate that a chain is properly constructed
     */
    validateChain(chain: TaskChain): {
        isValid: boolean;
        errors: string[];
        warnings: string[];
    };
    

    resumeWithApproval?(
        threadId: string,
        approvalDecision: { decision: 'approved' | 'rejected'; feedback?: string },
        existingTaskChain?: TaskChain
    ): Promise<TaskChain>;
}

/**
 * Interface for executing individual tasks
 */
export interface TaskExecutor {
    /**
     * Execute a single task
     */
    executeTask(
        task: TaskNode,
        inputs: Record<string, any>,
        context: TaskExecutionContext
    ): Promise<TaskNode>;
    
    /**
     * Check if executor can handle given task type
     */
    canExecute(taskType: TaskType): boolean;
    
    /**
     * Estimate execution time for a task
     */
    estimateExecutionTime(task: TaskNode): number;
}

/**
 * Context for task execution
 */
export interface TaskExecutionContext {
    /** Current runtime instance */
    runtime: IAgentRuntime;
    /** Current state */
    state: State;
    /** Original message that started the chain */
    originalMessage: Memory;
    /** Chain being executed */
    chain: TaskChain;
    /** Callback for streaming updates */
    streamingCallback?: StreamingCallback;
    /** Callback for intermediate results */
    intermediateResultCallback?: (result: any) => void;
    /**
     * Per-token streaming callback forwarded into action handlers via the
     * options object so generateText calls can stream LLM deltas back to
     * the SSE endpoint. Optional — handlers ignore it when undefined.
     */
    onToken?: (delta: string) => void | Promise<void>;
}

/**
 * Interface for resolving task dependencies
 */
export interface DependencyResolver {
    /**
     * Get next tasks ready for execution
     */
    getReadyTasks(chain: TaskChain): TaskNode[];
    
    /**
     * Mark task as completed and update dependent tasks
     */
    markTaskCompleted(taskId: UUID, chain: TaskChain): TaskChain;
    
    /**
     * Check for circular dependencies
     */
    hasCircularDependencies(chain: TaskChain): boolean;
    
    /**
     * Get execution order for optimal performance
     */
    getOptimalExecutionOrder(chain: TaskChain): UUID[][];
    
    /**
     * Validate the dependency structure of a chain
     */
    validateDependencies(chain: TaskChain): { isValid: boolean; errors: string[] };
}

/**
 * Interface for orchestrating entire chain execution
 */
export interface ChainOrchestrator {
    /**
     * Execute an entire task chain
     */
    executeChain(
        chain: TaskChain,
        context: TaskExecutionContext
    ): Promise<ChainExecutionResult>;
    
    /**
     * Pause chain execution
     */
    pauseChain(chainId: UUID): Promise<void>;
    
    /**
     * Resume paused chain execution
     */
    resumeChain(chainId: UUID): Promise<void>;
    
    /**
     * Cancel chain execution
     */
    cancelChain(chainId: UUID): Promise<void>;
    
    /**
     * Get current execution status
     */
    getChainStatus(chainId: UUID): ChainExecutionStatus;
}

/**
 * Result of chain execution
 */
export interface ChainExecutionResult {
    /** Whether chain completed successfully */
    success: boolean;

    /** Final chain state */
    chain: TaskChain;

    /** All outputs from completed tasks */
    outputs: Record<string, any>;

    /** Generated memories from the execution */
    memories: Memory[];

    /** Execution statistics */
    stats: {
        /** Total execution time */
        totalDuration: number;
        /** Number of tasks executed */
        tasksExecuted: number;
        /** Number of failed tasks */
        tasksFailed: number;
        /** Total token usage */
        totalTokens?: number;
        /** Total cost */
        totalCost?: number;
    };

    /** Snapshot of the chain for historical display */
    snapshot?: TaskChainSnapshot;

    /** Error details if failed */
    error?: {
        type: string;
        message: string;
        failedTaskId?: UUID;
        stack?: string;
    };
}

/**
 * Current status of chain execution
 */
export interface ChainExecutionStatus {
    /** Chain being executed */
    chainId: UUID;
    
    /** Current status */
    status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
    
    /** Progress information */
    progress: {
        /** Completed tasks */
        completed: number;
        /** Total tasks */
        total: number;
        /** Currently running tasks */
        running: string[];
        /** Estimated time remaining */
        estimatedTimeRemaining?: number;
    };
    
    /** Current execution phase */
    currentPhase?: string;
    
    /** Last update timestamp */
    lastUpdate: number;
}

/**
 * Task quality assessment levels
 */
export type TaskQualityLevel = 'excellent' | 'good' | 'acceptable' | 'poor' | 'failed';

/**
 * Task accomplishment evaluation result
 */
export interface TaskEvaluation {
    /** Unique evaluation ID */
    id: UUID;
    
    /** Task being evaluated */
    taskId: UUID;
    
    /** Whether task accomplished its intended goal */
    accomplished: boolean;
    
    /** Quality assessment of task execution */
    quality: TaskQualityLevel;
    
    /** Confidence score (0-1) in the evaluation */
    confidence: number;
    
    /** Detailed evaluation reasoning */
    reasoning: string;
    
    /** Specific issues identified */
    issues: string[];
    
    /** Strengths identified */
    strengths: string[];
    
    /** Whether task outputs satisfy dependencies */
    satisfiesDependencies: boolean;
    
    /** Alignment with original user request */
    userIntentAlignment: number; // 0-1 score
    
    /** Evaluation timestamp */
    timestamp: number;
}


/**
 * Chain orchestrator configuration
 */
export interface ChainOrchestratorConfig {
    /** Enable parallel task execution */
    enableParallelExecution: boolean;

    /** Timeout for individual tasks in milliseconds */
    taskTimeoutMs?: number;
}

/**
 * Message classification types for precheck system
 */
export type MessageClassificationType = 
    | "REGULAR_MESSAGE" 
    | "TASK_CHAIN_MESSAGE" 
    | "COMPREHENSIVE_ANALYSIS_MESSAGE"
    | "CEX_WORKFLOW_MESSAGE"
    | "MANTLE_WORKFLOW_MESSAGE";

/**
 * Result of message classification
 */
export interface MessageClassification {
    /** Classification type determined by LLM */
    classification: MessageClassificationType;
    /** Confidence score from 0 to 1 */
    confidence: number;
    /** Reasoning provided by LLM */
    reasoning: string;
    /** Whether the message is primarily about crypto topics */
    isCryptoRelated: boolean;
}

/**
 * Log entry for classification decisions (for future reinforcement learning)
 */
export interface ClassificationLog {
    /** Timestamp of classification */
    timestamp: number;
    /** Message ID */
    messageId: string;
    /** User ID who sent the message */
    userId: string;
    /** Room/conversation ID */
    roomId: string;
    /** Original message text */
    messageText: string;
    /** Classification result */
    classification: string;
    /** Confidence score */
    confidence: number;
    /** LLM reasoning */
    reasoning: string;
    /** Model used for classification */
    modelUsed: string;
    /** Time taken to classify in milliseconds */
    processingTime: number;
}

/**
 * Configuration for exchange registry
 */
export type ExchangeId = "coinbase" | "binance";

export type ExchangeAuthType =
    | "oauth_access_refresh_token"
    | "api_key_name_secret";

export type ExchangeAuthFieldType = "string" | "secret";

export type ExchangeAuthField = {
    id: string;
    label: string;
    type: ExchangeAuthFieldType;
    required: boolean;
    description?: string;
    placeholder?: string;
};

export type ExchangeAuthConfig = {
    type: ExchangeAuthType;
    fields: ExchangeAuthField[];
};

export type ExchangeRegistryEntry = {
    id: ExchangeId;
    name: string;
    /**
     * Exchanges can support multiple auth modes (for example OAuth tokens vs API keys).
     * Consumers persist tokens under `details.exchangeAuths[exchange.id]`.
     */
    authTypes: ExchangeAuthConfig[];
    defaultAuthType?: ExchangeAuthType;
};

/**
 * Stored values for exchange auth fields (field id -> value).
 * Used in details.exchangeAuths.
 *
 * - Fields with ExchangeAuthField.type === "string" are stored as plain strings.
 * - Fields with ExchangeAuthField.type === "secret" are stored as encrypted
 *   payloads compatible with EncryptedSecret from the client-direct crypto
 *   utilities (shape: { v, alg, iv, tag, ciphertext }).
 */
export type ExchangeAuthFieldValues = Record<
    string,
    string | { v: number; alg: string; iv: string; tag: string; ciphertext: string }
>;

/**
 * Auth data for a single exchange: auth type -> field values.
 */
export type AuthsForExchange = Partial<
    Record<ExchangeAuthType, ExchangeAuthFieldValues>
>;

/**
 * details.exchangeAuths: exchange id -> auth type -> field values.
 */
export type ExchangeAuths = Record<ExchangeId, AuthsForExchange>;

/**
 * Reference to the user's default exchange authentication configuration.
 * Stored in details.defaultExchangeAuth as just the ids, not the full auth object.
 */
export interface DefaultExchangeAuth {
    exchangeId: ExchangeId;
    authType: ExchangeAuthType;
}
