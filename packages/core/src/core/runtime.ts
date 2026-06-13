import { readFile } from "fs/promises";
import { join, relative } from "path";
import { names, uniqueNamesGenerator } from "unique-names-generator";
import { v4 as uuidv4 } from "uuid";

import { processActions as processActionsFunction } from "../handlers/actionprocess.ts";
import { formatPendingTradingPlansContext } from "../handlers/pendingPlanContext.ts";
import { getActivePlan } from "../handlers/cexPlanState.ts";
import { isExecutionStatusQuery } from "../handlers/cexExecutionIntent.ts";
import {
    formatActionNames,
    formatActions,
} from "./actions.ts";
import { addHeader, composeContext } from "./context.ts";
import {
    evaluationTemplate,
    formatEvaluatorExamples,
    formatEvaluatorNames,
    formatEvaluators,
} from "../ai/evaluators.ts";
import { generateText } from "../ai/generation.ts";
import { formatGoalsAsString, getGoals } from "./goals.ts";
import { handleMessageWithTaskChain } from "../handlers/taskChainHandler.ts";
import { DefaultTaskChainPlanner } from "../tasks/taskChainPlanner.ts";
import { evaluateShortCircuit, LangGraphPrecheckService } from "../handlers/langGraphPrecheck.ts";
import { handleRegularMessage } from "../handlers/regularMessageHandler.ts";
import { getCEXAuthRequiredErrorTemplate } from "../templates/cexMessageTemplate.ts";
import { detectLocale } from "../utils/languageUtils.ts";
import { isPublicAccessModeActive } from "../utils/publicAccessMode.ts";
import { seedPublicAccessPaperTrading } from "../utils/publicAccessSeed.ts";
import {
    handleComprehensiveAnalysis,
    isDailySchedulerMessage,
} from "../handlers/comprehensiveAnalysisWorkflowGraph.ts";
import { handleCEXWorkflowMessage } from "../handlers/cexWorkflowMessageHandler.ts";
import {
    handleMantleWorkflowMessage,
    shouldRouteMantleApprovalContinuation,
} from "../handlers/mantleWorkflowMessageHandler.ts";
import { generateComprehensiveAnalysisSnapshot } from "../utils/comprehensiveAnalysisSnapshot.ts";
import { logMemProbe, withMemProbe } from "../utils/memoryProbe.ts";
import { withSpan } from "../utils/tracing.ts";
import { classifyCexIntentClassFromText, detectIntentShift, isCexContinuationMemory, isShortFollowUpText } from "../utils/cexBypassPredicate.ts";
import { isStreamAliveForRoom } from "../utils/activeStreams.ts";
import { elizaLogger } from "../utils/logger.ts";
import knowledge from "../data/knowledge.ts";
import { MemoryManager } from "../data/memory.ts";
import { formatActors, formatMessages, getActorDetails } from "./messages.ts";
import { parseJsonArrayFromText } from "../validation/parsing.ts";
import { formatPosts } from "../data/posts.ts";
import { getProviders } from "./providers.ts";
import { RAGKnowledgeManager } from "../data/ragknowledge.ts";
import settings from "../config/settings.ts";
import { stringToUuid } from "../utils/uuid.ts";
import { UserFeatureManager } from "../data/userFeatureManager.ts";
import fs from "fs";
import path from "path";
import {
    type Character,
    type Content,
    type Goal,
    type HandlerCallback,
    type IAgentRuntime,
    type ICacheManager,
    type IDatabaseAdapter,
    type IMemoryManager,
    type IRAGKnowledgeManager,
    // type IVerifiableInferenceAdapter,
    type KnowledgeItem,
    // RAGKnowledgeItem,
    //Media,
    ModelClass,
    ModelProviderName,
    type Plugin,
    type Provider,
    type Adapter,
    type Service,
    type ServiceType,
    type State,
    type UUID,
    type Action,
    type Actor,
    type Evaluator,
    type Memory,
    type DirectoryItem,
    type ClientInstance,
    type StreamingCallback,
    type ProcessingStep,
    type TaskChainPlanner,
} from "./types.ts";
import { glob } from "glob";
import { existsSync } from "fs";
/**
 * Represents the runtime environment for an agent, handling message processing,
 * action registration, and interaction with external services like OpenAI and Supabase.
 */

function isDirectoryItem(item: any): item is DirectoryItem {
    return (
        typeof item === "object" &&
        item !== null &&
        "directory" in item &&
        typeof item.directory === "string"
    );
}

export class AgentRuntime implements IAgentRuntime {
    /**
     * Default count for recent messages to be kept in memory.
     * @private
     */
    readonly #conversationLength = 10 as number; // Reduced from 32 to prevent token limit issues
    /**
     * The ID of the agent
     */
    agentId: UUID;
    /**
     * The base URL of the server where the agent's requests are processed.
     */
    serverUrl = "http://localhost:7998";

    /**
     * The database adapter used for interacting with the database.
     */
    databaseAdapter: IDatabaseAdapter;

    /**
     * Authentication token used for securing requests.
     */
    token: string | null;

    /**
     * Custom actions that the agent can perform.
     */
    actions: Action[] = [];

    /**
     * Evaluators used to assess and guide the agent's responses.
     */
    evaluators: Evaluator[] = [];

    /**
     * Context providers used to provide context for message generation.
     */
    providers: Provider[] = [];

    /**
     * Database adapters used to interact with the database.
     */
    adapters: Adapter[] = [];

    plugins: Plugin[] = [];

    /**
     * The model to use for generateText.
     */
    modelProvider: ModelProviderName;

    /**
     * The model to use for generateImage.
     */
    imageModelProvider: ModelProviderName;

    /**
     * The model to use for describing images.
     */
    imageVisionModelProvider: ModelProviderName;

    /**
     * Fetch function to use
     * Some environments may not have access to the global fetch function and need a custom fetch override.
     */
    fetch = fetch;

    /**
     * The character to use for the agent
     */
    character: Character;

    /**
     * Store messages that are sent and received by the agent.
     */
    messageManager: IMemoryManager;

    /**
     * Store and recall descriptions of users based on conversations.
     */
    descriptionManager: IMemoryManager;

    /**
     * Manage the creation and recall of static information (documents, historical game lore, etc)
     */
    loreManager: IMemoryManager;

    /**
     * Hold large documents that can be referenced
     */
    documentsManager: IMemoryManager;

    /**
     * Searchable document fragments
     */
    knowledgeManager: IMemoryManager;

    ragKnowledgeManager: IRAGKnowledgeManager;

    /**
     * Store learned task chain rules from user feedback
     */
    ruleLearningMemoryManager: IMemoryManager;

    private readonly knowledgeRoot: string;

    /**
     * Whether to automatically trigger summary action when multiple actions are executed
     */
    private autoSummaryEnabled = false;

    /**
     * Whether to automatically generate comprehensive analysis using the template
     */
    private comprehensiveAnalysisEnabled = false;

    /**
     * Memory manager for user feature profiles
     */
    userFeatureManager: UserFeatureManager;

    /**
     * Load user traits context using UserFeatureManager (memory-based system)
     */
    private async buildUserTraitsContext(userId?: UUID): Promise<string> {
        if (!userId || userId === this.agentId) {
            return "";
        }

        try {
            return await this.userFeatureManager.formatUserTraitsForContext(userId);
        } catch (error) {
            elizaLogger.warn("[Runtime] Failed to load user traits", error);
            return "";
        }
    }

    // Action execution tracking to prevent duplicates
    private actionExecutionTracker = new Map<string, number>();
    private readonly ACTION_EXECUTION_COOLDOWN = 30000; // 30 seconds

    // Add action timeout property (default 5 minutes)
    private readonly ACTION_EXECUTION_TIMEOUT = 5 * 60 * 1000; // 5 minutes in milliseconds
    private actionTimeoutMs: number;
    
    // Processing interruption flag
    private shouldStopProcessing = false;
    /**
     * Lazy-init AbortController for the current processing session. Aborted
     * by stopProcessing() so in-flight `generateText` / `fetch` calls that
     * were passed `getAbortSignal()` cancel mid-stream. Replaced (not reset)
     * by resetStopFlag() at the start of each new session because signals
     * cannot be un-aborted.
     */
    private abortController: AbortController | null = null;

    // Add evaluator rate limiting
    private evaluatorExecutionTracker = new Map<string, number>();
    private readonly EVALUATOR_EXECUTION_COOLDOWN = 60000; // 60 seconds cooldown for evaluators

    services: Map<ServiceType, Service> = new Map();
    memoryManagers: Map<string, IMemoryManager> = new Map();
    cacheManager: ICacheManager;
    clients: ClientInstance[] = [];

    taskChainPlanner: TaskChainPlanner;

    /**
     * LangGraph precheck service for classifying incoming messages
     */
    messagePrecheckService: LangGraphPrecheckService;

    // verifiableInferenceAdapter?: IVerifiableInferenceAdapter;

    registerMemoryManager(manager: IMemoryManager): void {
        if (!manager.tableName) {
            throw new Error("Memory manager must have a tableName");
        }

        if (this.memoryManagers.has(manager.tableName)) {
            elizaLogger.warn(
                `Memory manager ${manager.tableName} is already registered. Skipping registration.`,
            );
            return;
        }

        this.memoryManagers.set(manager.tableName, manager);
    }

    getMemoryManager(tableName: string): IMemoryManager | null {
        return this.memoryManagers.get(tableName) || null;
    }

    getService<T extends Service>(service: ServiceType): T | null {
        const serviceInstance = this.services.get(service);
        if (!serviceInstance) {
            elizaLogger.error(`Service ${service} not found`);
            return null;
        }
        return serviceInstance as T;
    }

    async registerService(service: Service): Promise<void> {
        const serviceType = service.serviceType;
        elizaLogger.log(`${this.character.name}(${this.agentId}) - Registering service:`, serviceType);

        if (this.services.has(serviceType)) {
            elizaLogger.warn(
                `${this.character.name}(${this.agentId}) - Service ${serviceType} is already registered. Skipping registration.`
            );
            return;
        }

        // Add the service to the services map
        this.services.set(serviceType, service);
        elizaLogger.success(`${this.character.name}(${this.agentId}) - Service ${serviceType} registered successfully`);
    }

    /**
     * Creates an instance of AgentRuntime.
     * @param opts - The options for configuring the AgentRuntime.
     * @param opts.conversationLength - The number of messages to hold in the recent message cache.
     * @param opts.token - The JWT token, can be a JWT token if outside worker, or an OpenAI token if inside worker.
     * @param opts.serverUrl - The URL of the worker.
     * @param opts.actions - Optional custom actions.
     * @param opts.evaluators - Optional custom evaluators.
     * @param opts.services - Optional custom services.
     * @param opts.memoryManagers - Optional custom memory managers.
     * @param opts.providers - Optional context providers.
     * @param opts.model - The model to use for generateText.
     * @param opts.embeddingModel - The model to use for embedding.
     * @param opts.agentId - Optional ID of the agent.
     * @param opts.databaseAdapter - The database adapter used for interacting with the database.
     * @param opts.fetch - Custom fetch function to use for making requests.
     */

    constructor(opts: {
        conversationLength?: number; // number of messages to hold in the recent message cache
        agentId?: UUID; // ID of the agent
        character?: Character; // The character to use for the agent
        token: string; // JWT token, can be a JWT token if outside worker, or an OpenAI token if inside worker
        serverUrl?: string; // The URL of the worker
        actions?: Action[]; // Optional custom actions
        evaluators?: Evaluator[]; // Optional custom evaluators
        plugins?: Plugin[];
        providers?: Provider[];
        modelProvider: ModelProviderName;

        services?: Service[]; // Map of service name to service instance
        managers?: IMemoryManager[]; // Map of table name to memory manager
        databaseAdapter?: IDatabaseAdapter; // The database adapter used for interacting with the database
        fetch?: typeof fetch | unknown;
        speechModelPath?: string;
        cacheManager?: ICacheManager;
        logging?: boolean;
        autoSummaryEnabled?: boolean; // Whether to automatically trigger summary action when multiple actions are executed
        comprehensiveAnalysisEnabled?: boolean; // Whether to automatically generate comprehensive analysis using the template
        actionTimeoutMs?: number; // Timeout for action execution in milliseconds (default: 3 minutes)
        // verifiableInferenceAdapter?: IVerifiableInferenceAdapter;
    }) {
        // use the character id if it exists, otherwise use the agentId if it is passed in, otherwise use the character name
        this.agentId =
            opts.character?.id ??
            opts?.agentId ??
            stringToUuid(opts.character?.name ?? uuidv4());
        this.character = opts.character;

        if(!this.character) {
            throw new Error("Character input is required");
        }

        elizaLogger.info(`${this.character.name}(${this.agentId}) - Initializing AgentRuntime with options:`, {
            character: opts.character?.name,
            modelProvider: opts.modelProvider,
            characterModelProvider: opts.character?.modelProvider,
        });

        elizaLogger.debug(
            `[AgentRuntime] Process working directory: ${process.cwd()}`,
        );

        // Define the root path once
        this.knowledgeRoot = join(
            process.cwd(),
            "..",
            "characters",
            "knowledge",
        );

        elizaLogger.debug(
            `[AgentRuntime] Process knowledgeRoot: ${this.knowledgeRoot}`,
        );

        this.#conversationLength =
            opts.conversationLength ?? this.#conversationLength;

        this.databaseAdapter = opts.databaseAdapter;

        elizaLogger.success(`Agent ID: ${this.agentId}`);

        this.fetch = (opts.fetch as typeof fetch) ?? this.fetch;

        this.cacheManager = opts.cacheManager;

        // Initialize auto-summary feature
        this.autoSummaryEnabled = opts.autoSummaryEnabled ?? false;

        // Initialize comprehensive analysis feature
        this.comprehensiveAnalysisEnabled = opts.comprehensiveAnalysisEnabled ?? false;

        // Initialize action timeout (default 3 minutes)
        this.actionTimeoutMs = opts.actionTimeoutMs ?? this.ACTION_EXECUTION_TIMEOUT;

        this.messageManager = new MemoryManager({
            runtime: this,
            tableName: "messages",
        });

        this.descriptionManager = new MemoryManager({
            runtime: this,
            tableName: "descriptions",
        });

        this.loreManager = new MemoryManager({
            runtime: this,
            tableName: "lore",
        });

        this.documentsManager = new MemoryManager({
            runtime: this,
            tableName: "documents",
        });

        this.knowledgeManager = new MemoryManager({
            runtime: this,
            tableName: "fragments",
        });

        this.ragKnowledgeManager = new RAGKnowledgeManager({
            runtime: this,
            tableName: "knowledge",
            knowledgeRoot: this.knowledgeRoot,
        });

        // Chain Rules Memory Manager for learned task chain patterns
        this.ruleLearningMemoryManager = new MemoryManager({
            runtime: this,
            tableName: "chain_rules",
        });

        // Initialize LangGraph precheck service
        this.messagePrecheckService = new LangGraphPrecheckService(this);
        this.userFeatureManager = new UserFeatureManager({ runtime: this });
        this.taskChainPlanner = new DefaultTaskChainPlanner(this);

        (opts.managers ?? []).forEach((manager: IMemoryManager) => {
            this.registerMemoryManager(manager);
        });

        (opts.services ?? []).forEach((service: Service) => {
            this.registerService(service);
        });

        this.serverUrl = opts.serverUrl ?? this.serverUrl;

        elizaLogger.info(`${this.character.name}(${this.agentId}) - Setting Model Provider:`, {
            characterModelProvider: this.character.modelProvider,
            optsModelProvider: opts.modelProvider,
            currentModelProvider: this.modelProvider,
            finalSelection:
                this.character.modelProvider ??
                opts.modelProvider ??
                this.modelProvider,
        });

        this.modelProvider =
            this.character.modelProvider ??
            opts.modelProvider ??
            this.modelProvider;

        this.imageModelProvider =
            this.character.imageModelProvider ?? this.modelProvider;

        this.imageVisionModelProvider =
            this.character.imageVisionModelProvider ?? this.modelProvider;

        elizaLogger.info(
          `${this.character.name}(${this.agentId}) - Selected model provider:`,
          this.modelProvider
        );

        elizaLogger.info(
          `${this.character.name}(${this.agentId}) - Selected image model provider:`,
          this.imageModelProvider
        );

        elizaLogger.info(
            `${this.character.name}(${this.agentId}) - Selected image vision model provider:`,
            this.imageVisionModelProvider
        );

        // Validate model provider
        if (!Object.values(ModelProviderName).includes(this.modelProvider)) {
            elizaLogger.error("Invalid model provider:", this.modelProvider);
            elizaLogger.error(
                "Available providers:",
                Object.values(ModelProviderName),
            );
            throw new Error(`Invalid model provider: ${this.modelProvider}`);
        }

        if (!this.serverUrl) {
            elizaLogger.warn("No serverUrl provided, defaulting to localhost");
        }

        this.token = opts.token;

        this.plugins = [
            ...(opts.character?.plugins ?? []),
            ...(opts.plugins ?? []),
        ];

        this.plugins.forEach((plugin) => {
            plugin.actions?.forEach((action) => {
                this.registerAction(action);
            });

            plugin.evaluators?.forEach((evaluator) => {
                this.registerEvaluator(evaluator);
            });

            plugin.services?.forEach((service) => {
                this.registerService(service);
            });

            plugin.providers?.forEach((provider) => {
                this.registerContextProvider(provider);
            });

            plugin.adapters?.forEach((adapter) => {
                this.registerAdapter(adapter);
            });
        });

        (opts.actions ?? []).forEach((action) => {
            this.registerAction(action);
        });

        (opts.providers ?? []).forEach((provider) => {
            this.registerContextProvider(provider);
        });

        (opts.evaluators ?? []).forEach((evaluator: Evaluator) => {
            this.registerEvaluator(evaluator);
        });

        // Add a test action for debugging next step functionality
        this.registerAction({
            name: "TEST_ACTION",
            description: "A simple test action for debugging next step functionality",
            handler: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
                elizaLogger.success(`[TEST_ACTION] Test action executed successfully!`);
                
                // Create a test response
                const testResponse: Memory = {
                    id: uuidv4() as UUID,
                    userId: runtime.agentId,
                    agentId: runtime.agentId,
                    roomId: message.roomId,
                    createdAt: Date.now(),
                    content: {
                        text: "✅ Test action completed successfully! This demonstrates that next step execution is working.",
                    },
                };
                
                await runtime.messageManager.createMemory(testResponse);
                return true;
            },
            examples: [
                [
                    {
                        user: "user1",
                        content: { text: "Can you test something?" },
                    },
                    {
                        user: "agent",
                        content: { text: "Sure, I'll run a test for you", action: "TEST_ACTION" },
                    },
                ],
            ],
        });

        // this.verifiableInferenceAdapter = opts.verifiableInferenceAdapter;
    }

    private async initializeDatabase() {
        // By convention, we create a user and room using the agent id.
        // Memories related to it are considered global context for the agent.
        this.ensureRoomExists(this.agentId);
        this.ensureUserExists(
            this.agentId,
            this.character.username || this.character.name,
            this.character.name,
        ).then(() => {
            // postgres needs the user to exist before you can add a participant
            this.ensureParticipantExists(this.agentId, this.agentId);
        });
    }

    async initialize() {
        this.initializeDatabase();

        for (const [serviceType, service] of this.services.entries()) {
            try {
                await service.initialize(this);
                this.services.set(serviceType, service);
                elizaLogger.success(
                    `${this.character.name}(${this.agentId}) - Service ${serviceType} initialized successfully`
                );
            } catch (error) {
                elizaLogger.error(
                    `${this.character.name}(${this.agentId}) - Failed to initialize service ${serviceType}:`,
                    error
                );
                throw error;
            }
        }

        // should already be initiailized
        /*
        for (const plugin of this.plugins) {
            if (plugin.services)
                await Promise.all(
                    plugin.services?.map((service) => service.initialize(this)),
                );
        }
        */

        if (
            this.character &&
            this.character.knowledge &&
            this.character.knowledge.length > 0
        ) {
            elizaLogger.info(
                `[RAG Check] RAG Knowledge enabled: ${this.character.settings.ragKnowledge ? true : false}`,
            );
            elizaLogger.debug(
                `[RAG Check] Knowledge items:`,
                this.character.knowledge,
            );

            if (this.character.settings.ragKnowledge) {
                // Type guards with logging for each knowledge type
                const [directoryKnowledge, pathKnowledge, stringKnowledge] =
                    this.character.knowledge.reduce(
                        (acc, item) => {
                            if (typeof item === "object") {
                                if (isDirectoryItem(item)) {
                                    elizaLogger.debug(
                                        `[RAG Filter] Found directory item: ${JSON.stringify(item)}`,
                                    );
                                    acc[0].push(item);
                                } else if ("path" in item) {
                                    elizaLogger.debug(
                                        `[RAG Filter] Found path item: ${JSON.stringify(item)}`,
                                    );
                                    acc[1].push(item);
                                }
                            } else if (typeof item === "string") {
                                elizaLogger.debug(
                                    `[RAG Filter] Found string item: ${item.slice(0, 100)}...`,
                                );
                                acc[2].push(item);
                            }
                            return acc;
                        },
                        [[], [], []] as [
                            Array<{ directory: string; shared?: boolean }>,
                            Array<{ path: string; shared?: boolean }>,
                            Array<string>,
                        ],
                    );

                elizaLogger.info(
                    `[RAG Summary] Found ${directoryKnowledge.length} directories, ${pathKnowledge.length} paths, and ${stringKnowledge.length} strings`,
                );

                // Process each type of knowledge
                if (directoryKnowledge.length > 0) {
                    elizaLogger.info(
                        `[RAG Process] Processing directory knowledge sources:`,
                    );
                    for (const dir of directoryKnowledge) {
                        elizaLogger.info(
                            `  - Directory: ${dir.directory} (shared: ${!!dir.shared})`,
                        );
                        await this.processCharacterRAGDirectory(dir);
                    }
                }

                if (pathKnowledge.length > 0) {
                    elizaLogger.info(
                        `[RAG Process] Processing individual file knowledge sources`,
                    );
                    await this.processCharacterRAGKnowledge(pathKnowledge);
                }

                if (stringKnowledge.length > 0) {
                    elizaLogger.info(
                        `[RAG Process] Processing direct string knowledge`,
                    );
                    await this.processCharacterRAGKnowledge(stringKnowledge);
                }
            } else {
                // Non-RAG mode: only process string knowledge
                const stringKnowledge = this.character.knowledge.filter(
                    (item): item is string => typeof item === "string",
                );
                await this.processCharacterKnowledge(stringKnowledge);
            }

            // After all new knowledge is processed, clean up any deleted files
            elizaLogger.info(
                `[RAG Cleanup] Starting cleanup of deleted knowledge files`,
            );
            await this.ragKnowledgeManager.cleanupDeletedKnowledgeFiles();
            elizaLogger.info(`[RAG Cleanup] Cleanup complete`);
        }
    }

    async stop() {
        elizaLogger.debug("runtime::stop - character", this.character.name);
        // stop services, they don't have a stop function
        // just initialize

        // plugins
        // have actions, providers, evaluators (no start/stop)
        // services (just initialized), clients

        // client have a start
        for (const c of this.clients) {
            elizaLogger.log(
                "runtime::stop - requesting",
                c,
                "client stop for",
                this.character.name,
            );
            c.stop(this);
        }
        // we don't need to unregister with directClient
        // don't need to worry about knowledge
    }

    /**
     * Immediately interrupt ongoing processing. Sets the polled stop flag
     * AND aborts the shared AbortController so any in-flight call that was
     * passed `getAbortSignal()` (e.g. supervisor `generateText`) cancels
     * mid-stream instead of running to completion.
     */
    stopProcessing() {
        elizaLogger.info("🛑 Processing stop requested for", this.character.name, "- Setting stop flag to TRUE");
        this.shouldStopProcessing = true;
        if (this.abortController && !this.abortController.signal.aborted) {
            this.abortController.abort();
        }
        elizaLogger.debug("🛑 Stop flag set, current state:", this.shouldStopProcessing);
    }

    /**
     * Reset the stop flag (called at the start of new processing). Replaces
     * the AbortController with a fresh one — an aborted signal cannot be
     * reused, so each session needs its own controller.
     */
    resetStopFlag() {
        elizaLogger.debug("🔄 Resetting stop flag from", this.shouldStopProcessing, "to FALSE");
        this.shouldStopProcessing = false;
        this.abortController = new AbortController();
    }

    /**
     * Check if processing should be stopped
     */
    shouldStop(): boolean {
        const shouldStop = this.shouldStopProcessing;
        if (shouldStop) {
            elizaLogger.debug("⚡ Stop check: TRUE - processing should be stopped");
        }
        return shouldStop;
    }

    /**
     * Returns an AbortSignal tied to the current processing session. Pass
     * to `generateText({ ... signal: runtime.getAbortSignal() })` or to
     * `fetch({ signal })` so the call aborts the moment `stopProcessing()`
     * is fired. Lazily creates the controller on first access if processing
     * started without `resetStopFlag()` being called first.
     */
    getAbortSignal(): AbortSignal {
        if (!this.abortController) {
            this.abortController = new AbortController();
        }
        return this.abortController.signal;
    }

    /**
     * Processes character knowledge by creating document memories and fragment memories.
     * This function takes an array of knowledge items, creates a document memory for each item if it doesn't exist,
     * then chunks the content into fragments, embeds each fragment, and creates fragment memories.
     * @param knowledge An array of knowledge items containing id, path, and content.
     */
    private async processCharacterKnowledge(items: string[]) {
        const ids = items.map(i => stringToUuid(i));
        const exists = await this.documentsManager.getMemoriesByIds(ids);
        const toAdd = [];
        for(const i in items) {
          const exist = exists[i];
          if (!exist) {
            toAdd.push([items[i], ids[i]]);
          }
        }
        if (!toAdd.length) return;
        elizaLogger.info('discovered ' + toAdd.length + ' new knowledge items')
        const chunkSize = 512;
        const ps = [];
        for (const a of toAdd) {
            const item = a[0];
            const knowledgeId = a[1];

            if (item.length > chunkSize) {
              // these are just slower
              elizaLogger.info(
                  this.character.name,
                  " knowledge item over 512 characters, splitting - ",
                  item.slice(0, 100),
              );
            }

            ps.push(knowledge.set(this, {
                id: knowledgeId,
                content: {
                    text: item,
                },
            }));
        }
        // wait for it all to be added
        await Promise.all(ps);
        elizaLogger.success(this.character.name, 'knowledge is synchronized');
    }

    /**
     * Processes character knowledge by creating document memories and fragment memories.
     * This function takes an array of knowledge items, creates a document knowledge for each item if it doesn't exist,
     * then chunks the content into fragments, embeds each fragment, and creates fragment knowledge.
     * An array of knowledge items or objects containing id, path, and content.
     */
    private async processCharacterRAGKnowledge(
        items: (string | { path: string; shared?: boolean })[],
    ) {
        let hasError = false;

        for (const item of items) {
            if (!item) continue;

            try {
                // Check if item is marked as shared
                let isShared = false;
                let contentItem = item;

                // Only treat as shared if explicitly marked
                if (typeof item === "object" && "path" in item) {
                    isShared = item.shared === true;
                    contentItem = item.path;
                } else {
                    contentItem = item;
                }

                // const knowledgeId = stringToUuid(contentItem);
                const knowledgeId = this.ragKnowledgeManager.generateScopedId(
                    contentItem,
                    isShared,
                );
                const fileExtension = contentItem
                    .split(".")
                    .pop()
                    ?.toLowerCase();

                // Check if it's a file or direct knowledge
                if (
                    fileExtension &&
                    ["md", "txt", "pdf"].includes(fileExtension)
                ) {
                    try {
                        const filePath = join(this.knowledgeRoot, contentItem);
                        // Get existing knowledge first with more detailed logging
                        elizaLogger.debug("[RAG Query]", {
                            knowledgeId,
                            agentId: this.agentId,
                            relativePath: contentItem,
                            fullPath: filePath,
                            isShared,
                            knowledgeRoot: this.knowledgeRoot,
                        });

                        // Get existing knowledge first
                        const existingKnowledge =
                            await this.ragKnowledgeManager.getKnowledge({
                                id: knowledgeId,
                                agentId: this.agentId, // Keep agentId as it's used in OR query
                            });

                        elizaLogger.debug("[RAG Query Result]", {
                            relativePath: contentItem,
                            fullPath: filePath,
                            knowledgeId,
                            isShared,
                            exists: existingKnowledge.length > 0,
                            knowledgeCount: existingKnowledge.length,
                            firstResult: existingKnowledge[0]
                                ? {
                                      id: existingKnowledge[0].id,
                                      agentId: existingKnowledge[0].agentId,
                                      contentLength:
                                          existingKnowledge[0].content.text
                                              .length,
                                  }
                                : null,
                            results: existingKnowledge.map((k) => ({
                                id: k.id,
                                agentId: k.agentId,
                                isBaseKnowledge: !k.id.includes("chunk"),
                            })),
                        });

                        // Read file content
                        const content: string = await readFile(
                            filePath,
                            "utf8",
                        );
                        if (!content) {
                            hasError = true;
                            continue;
                        }

                        if (existingKnowledge.length > 0) {
                            const existingContent =
                                existingKnowledge[0].content.text;

                            elizaLogger.debug("[RAG Compare]", {
                                path: contentItem,
                                knowledgeId,
                                isShared,
                                existingContentLength: existingContent.length,
                                newContentLength: content.length,
                                contentSample: content.slice(0, 100),
                                existingContentSample: existingContent.slice(
                                    0,
                                    100,
                                ),
                                matches: existingContent === content,
                            });

                            if (existingContent === content) {
                                elizaLogger.info(
                                    `${isShared ? "Shared knowledge" : "Knowledge"} ${contentItem} unchanged, skipping`,
                                );
                                continue;
                            }

                            // Content changed, remove old knowledge before adding new
                            elizaLogger.info(
                                `${isShared ? "Shared knowledge" : "Knowledge"} ${contentItem} changed, updating...`,
                            );
                            await this.ragKnowledgeManager.removeKnowledge(
                                knowledgeId,
                            );
                            await this.ragKnowledgeManager.removeKnowledge(
                                `${knowledgeId}-chunk-*` as UUID,
                            );
                        }

                        elizaLogger.info(
                            `Processing ${fileExtension.toUpperCase()} file content for`,
                            this.character.name,
                            "-",
                            contentItem,
                        );

                        await this.ragKnowledgeManager.processFile({
                            path: contentItem,
                            content: content,
                            type: fileExtension as "pdf" | "md" | "txt",
                            isShared: isShared,
                        });
                    } catch (error: any) {
                        hasError = true;
                        elizaLogger.error(
                            `Failed to read knowledge file ${contentItem}. Error details:`,
                            error?.message || error || "Unknown error",
                        );
                        continue;
                    }
                } else {
                    // Handle direct knowledge string
                    elizaLogger.info(
                        "Processing direct knowledge for",
                        this.character.name,
                        "-",
                        contentItem.slice(0, 100),
                    );

                    const existingKnowledge =
                        await this.ragKnowledgeManager.getKnowledge({
                            id: knowledgeId,
                            agentId: this.agentId,
                        });

                    if (existingKnowledge.length > 0) {
                        elizaLogger.info(
                            `Direct knowledge ${knowledgeId} already exists, skipping`,
                        );
                        continue;
                    }

                    await this.ragKnowledgeManager.createKnowledge({
                        id: knowledgeId,
                        agentId: this.agentId,
                        content: {
                            text: contentItem,
                            metadata: {
                                type: "direct",
                            },
                        },
                    });
                }
            } catch (error: any) {
                hasError = true;
                elizaLogger.error(
                    `Error processing knowledge item ${item}:`,
                    error?.message || error || "Unknown error",
                );
                continue;
            }
        }

        if (hasError) {
            elizaLogger.warn(
                "Some knowledge items failed to process, but continuing with available knowledge",
            );
        }
    }

    /**
     * Processes directory-based RAG knowledge by recursively loading and processing files.
     * @param dirConfig The directory configuration containing path and shared flag
     */
    private async processCharacterRAGDirectory(dirConfig: {
        directory: string;
        shared?: boolean;
    }) {
        if (!dirConfig.directory) {
            elizaLogger.error("[RAG Directory] No directory specified");
            return;
        }

        // Sanitize directory path to prevent traversal attacks and normalize leading slashes
        const sanitizedDir = dirConfig.directory
            .replace(/\.\./g, "")           // Remove parent directory references
            .replace(/^\/+/, "");           // Remove leading slashes to ensure relative path
        const dirPath = join(this.knowledgeRoot, sanitizedDir);

        try {
            // Check if directory exists, create if it doesn't
            const dirExists = existsSync(dirPath);
            if (!dirExists) {
                elizaLogger.info(
                    `[RAG Directory] Creating knowledge directory: ${sanitizedDir}`,
                );
                fs.mkdirSync(dirPath, { recursive: true });
                elizaLogger.success(
                    `[RAG Directory] Successfully created directory: ${dirPath}`,
                );
            }

            elizaLogger.debug(`[RAG Directory] Searching in: ${dirPath}`);
            // Use glob to find all matching files in directory
            const files = await glob("**/*.{md,txt,pdf}", {
                cwd: dirPath,
                nodir: true,
                absolute: false,
            });

            if (files.length === 0) {
                elizaLogger.warn(
                    `No matching files found in directory: ${dirConfig.directory}`,
                );
                return;
            }

            elizaLogger.info(
                `[RAG Directory] Found ${files.length} files in ${dirConfig.directory}`,
            );

            // Process files in batches to avoid memory issues
            const BATCH_SIZE = 5;
            for (let i = 0; i < files.length; i += BATCH_SIZE) {
                const batch = files.slice(i, i + BATCH_SIZE);

                await Promise.all(
                    batch.map(async (file) => {
                        try {
                            const relativePath = join(sanitizedDir, file);

                            elizaLogger.debug(
                                `[RAG Directory] Processing file ${i + 1}/${files.length}:`,
                                {
                                    file,
                                    relativePath,
                                    shared: dirConfig.shared,
                                },
                            );

                            await this.processCharacterRAGKnowledge([
                                {
                                    path: relativePath,
                                    shared: dirConfig.shared,
                                },
                            ]);
                        } catch (error) {
                            elizaLogger.error(
                                `[RAG Directory] Failed to process file: ${file}`,
                                error instanceof Error
                                    ? {
                                          name: error.name,
                                          message: error.message,
                                          stack: error.stack,
                                      }
                                    : error,
                            );
                        }
                    }),
                );

                elizaLogger.debug(
                    `[RAG Directory] Completed batch ${Math.min(i + BATCH_SIZE, files.length)}/${files.length} files`,
                );
            }

            elizaLogger.success(
                `[RAG Directory] Successfully processed directory: ${sanitizedDir}`,
            );
        } catch (error) {
            elizaLogger.error(
                `[RAG Directory] Failed to process directory: ${sanitizedDir}`,
                error instanceof Error
                    ? {
                          name: error.name,
                          message: error.message,
                          stack: error.stack,
                      }
                    : error,
            );
            throw error; // Re-throw to let caller handle it
        }
    }

    getSetting(key: string) {
        // check if the key is in the character.settings.secrets object
        if (this.character.settings?.secrets?.[key]) {
            return this.character.settings.secrets[key];
        }
        // if not, check if it's in the settings object
        if (this.character.settings?.[key]) {
            return this.character.settings[key];
        }

        // if not, check if it's in the settings object
        if (settings[key]) {
            return settings[key];
        }

        return null;
    }

    /**
     * Get an array of all numbered API key variants for a base key
     * e.g., getSettingArray("OPENAI_API_KEY") returns all values for
     * OPENAI_API_KEY, OPENAI_API_KEY_1, OPENAI_API_KEY_2, etc.
     */
    getSettingArray(baseKey: string): string[] {
        const keys: string[] = [];
        
        // Check base key first
        const baseValue = this.getSetting(baseKey);
        if (baseValue) {
            keys.push(baseValue);
        }
        
        // Check numbered variants
        for (let i = 1; i <= 10; i++) { // Limit to 10 keys for safety
            const numberedKey = `${baseKey}_${i}`;
            const value = this.getSetting(numberedKey);
            if (value) {
                keys.push(value);
            }
        }
        
        return keys;
    }

    /**
     * API key management for tracking failed keys and rotation
     */
    private failedApiKeys: Map<string, { keys: Set<string>, lastReset: number }> = new Map();
    private currentApiKeyIndex: Map<string, number> = new Map();
    private apiKeyRetryRounds: Map<string, number> = new Map();
    private providerCooldowns: Map<string, number> = new Map(); // Track cooldown periods for providers
    
    /**
     * Get the next available API key from an array, avoiding recently failed keys
     * This implements simple round-robin selection with failure tracking
     */
    getNextApiKey(baseKey: string, resetFailuresAfter = 300000): string | null { // 5 minutes default
        const availableKeys = this.getSettingArray(baseKey);

        if (availableKeys.length === 0) {
            return null;
        }

        // Check if provider is in cooldown period (30 minutes after all retries failed)
        const cooldownUntil = this.providerCooldowns.get(baseKey);
        if (cooldownUntil && Date.now() < cooldownUntil) {
            const remainingMinutes = Math.ceil((cooldownUntil - Date.now()) / 60000);
            elizaLogger.info(`Provider ${baseKey} is in cooldown period. ${remainingMinutes} minutes remaining before retry.`);
            return null;
        } else if (cooldownUntil && Date.now() >= cooldownUntil) {
            // Cooldown period ended, clear it and reset retry rounds
            elizaLogger.info(`Cooldown period ended for ${baseKey}. Retrying provider.`);
            this.providerCooldowns.delete(baseKey);
            this.apiKeyRetryRounds.set(baseKey, 0);
            // Also clear failed keys to start fresh
            if (this.failedApiKeys.has(baseKey)) {
                this.failedApiKeys.get(baseKey)!.keys.clear();
                this.failedApiKeys.get(baseKey)!.lastReset = Date.now();
            }
        }
        
        // Get or create failed key tracking for this provider
        if (!this.failedApiKeys.has(baseKey)) {
            this.failedApiKeys.set(baseKey, { keys: new Set(), lastReset: Date.now() });
        }
        
        const failedInfo = this.failedApiKeys.get(baseKey)!;
        
        // Reset failed keys if enough time has passed
        if (Date.now() - failedInfo.lastReset > resetFailuresAfter) {
            failedInfo.keys.clear();
            failedInfo.lastReset = Date.now();
            elizaLogger.info(`Reset failed API keys for ${baseKey} after ${resetFailuresAfter}ms`);
        }
        
        // Filter out failed keys
        const workingKeys = availableKeys.filter(key => !failedInfo.keys.has(key));

        if (workingKeys.length === 0) {
            // All keys have failed - check retry rounds
            const currentRound = this.apiKeyRetryRounds.get(baseKey) || 0;
            const maxRounds = 3;

            if (currentRound < maxRounds - 1) {
                // Haven't reached max rounds yet, reset and retry
                this.apiKeyRetryRounds.set(baseKey, currentRound + 1);
                elizaLogger.warn(`All API keys for ${baseKey} have failed. Starting retry round ${currentRound + 2}/${maxRounds}...`);
                failedInfo.keys.clear();
                failedInfo.lastReset = Date.now();
                this.currentApiKeyIndex.set(baseKey, 0);
                return availableKeys[0];
            } else {
                // Reached max rounds, set 30-minute cooldown and trigger provider fallback
                const cooldownDuration = 30 * 60 * 1000; // 30 minutes in milliseconds
                const cooldownUntil = Date.now() + cooldownDuration;
                this.providerCooldowns.set(baseKey, cooldownUntil);
                elizaLogger.warn(`All API keys for ${baseKey} have failed after ${maxRounds} rounds. Setting 30-minute cooldown. Provider will be retried after cooldown period.`);
                this.apiKeyRetryRounds.set(baseKey, 0); // Reset for future attempts
                return null;
            }
        }

        // Implement round-robin selection
        const currentIndex = this.currentApiKeyIndex.get(baseKey) || 0;
        const selectedKey = workingKeys[currentIndex % workingKeys.length];
        this.currentApiKeyIndex.set(baseKey, currentIndex + 1);

        // Only reset retry rounds when ALL keys are working (no failures)
        // This prevents resetting during retry rounds when we've temporarily cleared failures
        if (this.apiKeyRetryRounds.has(baseKey) && workingKeys.length === availableKeys.length) {
            this.apiKeyRetryRounds.set(baseKey, 0);
        }

        return selectedKey;
    }
    
    /**
     * Mark an API key as failed for a specific provider
     */
    markApiKeyAsFailed(baseKey: string, apiKey: string): void {
        if (!this.failedApiKeys.has(baseKey)) {
            this.failedApiKeys.set(baseKey, { keys: new Set(), lastReset: Date.now() });
        }
        
        const failedInfo = this.failedApiKeys.get(baseKey)!;
        const wasAlreadyFailed = failedInfo.keys.has(apiKey);
        failedInfo.keys.add(apiKey);
        
        const maskedKey = apiKey ? `${apiKey.substring(0, 10)}...${apiKey.substring(apiKey.length - 4)}` : 'none';
        if (!wasAlreadyFailed) {
            elizaLogger.warn(`Marked API key as failed for ${baseKey}: ${maskedKey} (${failedInfo.keys.size} total failed)`);
        }
    }
    
    /**
     * Get the current API key for a provider with automatic rotation
     */
    getCurrentApiKey(baseKey: string): string | null {
        // Try to get the next working key
        const nextKey = this.getNextApiKey(baseKey);
        
        if (nextKey && nextKey !== this.token) {
            // Update runtime token if we're switching keys for the primary provider
            const providerName = this.getProviderNameFromKey(baseKey);
            if (providerName === this.modelProvider) {
                const maskedOldKey = this.token ? `${this.token.substring(0, 10)}...${this.token.substring(this.token.length - 4)}` : 'none';
                const maskedNewKey = `${nextKey.substring(0, 10)}...${nextKey.substring(nextKey.length - 4)}`;
                elizaLogger.info(`Rotating API key for ${baseKey}: ${maskedOldKey} → ${maskedNewKey}`);
                this.token = nextKey;
            }
        }
        
        return nextKey;
    }
    
    /**
     * Helper to map API key base names to provider names
     */
    private getProviderNameFromKey(baseKey: string): ModelProviderName | null {
        const keyToProviderMap: Record<string, ModelProviderName> = {
            'OPENAI_API_KEY': ModelProviderName.OPENAI,
            'ANTHROPIC_API_KEY': ModelProviderName.ANTHROPIC,
            'CLAUDE_API_KEY': ModelProviderName.ANTHROPIC,
            'GROQ_API_KEY': ModelProviderName.GROQ,
            'MISTRAL_API_KEY': ModelProviderName.MISTRAL,
        };
        
        return keyToProviderMap[baseKey] || null;
    }

    /**
     * Get the number of messages that are kept in the conversation buffer.
     * @returns The number of recent messages to be kept in memory.
     */
    getConversationLength() {
        return this.#conversationLength;
    }

    /**
     * Register an action for the agent to perform.
     * @param action The action to register.
     */
    registerAction(action: Action) {
        elizaLogger.success(`${this.character.name}(${this.agentId}) - Registering action: ${action.name}`);
        this.actions.push(action);
    }

    /**
     * Register an evaluator to assess and guide the agent's responses.
     * @param evaluator The evaluator to register.
     */
    registerEvaluator(evaluator: Evaluator) {
        // Check if an evaluator with the same name already exists
        const existingEvaluator = this.evaluators.find(e => e.name === evaluator.name);
        if (existingEvaluator) {
            elizaLogger.warn(`Evaluator with name "${evaluator.name}" already registered. Skipping duplicate registration.`);
            return;
        }
        
        elizaLogger.success(`${this.character.name}(${this.agentId}) - Registering evaluator: ${evaluator.name}`);
        this.evaluators.push(evaluator);
    }

    /**
     * Register a context provider to provide context for message generation.
     * @param provider The context provider to register.
     */
    registerContextProvider(provider: Provider) {
        this.providers.push(provider);
    }

    /**
     * Register an adapter for the agent to use.
     * @param adapter The adapter to register.
     */
    registerAdapter(adapter: Adapter) {
        this.adapters.push(adapter);
    }

    /**
     * Enable or disable comprehensive analysis
     * @param enabled Whether to enable comprehensive analysis
     */
    setComprehensiveAnalysisEnabled(enabled: boolean): void {
        this.comprehensiveAnalysisEnabled = enabled;
        elizaLogger.info(`🔄 Comprehensive analysis ${enabled ? 'enabled' : 'disabled'} - will ${enabled ? 'use 12 mandatory actions' : 'use standard template'}`);
    }

    /**
     * Check if comprehensive analysis is enabled
     * @returns boolean indicating if comprehensive analysis is enabled
     */
    isComprehensiveAnalysisEnabled(): boolean {
        return this.comprehensiveAnalysisEnabled;
    }

    /**
     * Set the action execution timeout
     * @param timeoutMs Timeout in milliseconds (must be positive)
     */
    setActionTimeout(timeoutMs: number): void {
        if (timeoutMs <= 0) {
            throw new Error("Action timeout must be a positive number");
        }
        this.actionTimeoutMs = timeoutMs;
        elizaLogger.info(`Action timeout set to ${timeoutMs}ms (${Math.round(timeoutMs / 1000)}s) for ${this.character.name}(${this.agentId})`);
    }

    /**
     * Get the current action execution timeout
     * @returns Timeout in milliseconds
     */
    getActionTimeout(): number {
        return this.actionTimeoutMs;
    }

    cleanupActionExecutionTracker(): void {
        const now = Date.now();
        for (const [key, timestamp] of this.actionExecutionTracker.entries()) {
            if (now - timestamp > this.ACTION_EXECUTION_COOLDOWN) {
                this.actionExecutionTracker.delete(key);
            }
        }
    }


    /**
     * Get LangGraph precheck service for direct access
     * @returns LangGraphPrecheckService instance
     */
    getMessagePrecheckService(): LangGraphPrecheckService {
        return this.messagePrecheckService;
    }

    /**
     * Process the actions of a message.
     * @param message The message to process.
     * @param content The content of the message to process actions from.
     */
    async processActions(
        message: Memory,
        responses: Memory[],
        state?: State,
        callback?: HandlerCallback,
        streamingCallback?: StreamingCallback,
        onToken?: (delta: string) => void | Promise<void>,
    ): Promise<{ success: boolean; error?: string; errorDetails?: any }> {
        return await processActionsFunction.call(this, message, responses, state, callback, streamingCallback, onToken);
    }

    /**
     * Evaluate the message and state using the registered evaluators.
     * @param message The message to evaluate.
     * @param state The state of the agent.
     * @param didRespond Whether the agent responded to the message.~
     * @param callback The handler callback
     * @returns The results of the evaluation.
     */
    async evaluate(
        message: Memory,
        state: State,
        didRespond?: boolean,
        callback?: HandlerCallback,
    ) {
        const evaluatorPromises = this.evaluators.map(
            async (evaluator: Evaluator) => {
                elizaLogger.log("Evaluating", evaluator.name);
                if (!evaluator.handler) {
                    return null;
                }
                if (!didRespond && !evaluator.alwaysRun) {
                    return null;
                }
                
                // Check rate limiting for this evaluator
                const now = Date.now();
                const lastExecution = this.evaluatorExecutionTracker.get(evaluator.name);
                if (lastExecution && (now - lastExecution) < this.EVALUATOR_EXECUTION_COOLDOWN) {
                    elizaLogger.log(`Evaluator ${evaluator.name} is on cooldown. Skipping execution.`);
                    return null;
                }
                
                const result = await evaluator.validate(this, message, state);
                if (result) {
                    return evaluator;
                }
                return null;
            },
        );

        const resolvedEvaluators = await Promise.all(evaluatorPromises);
        const evaluatorsData = resolvedEvaluators.filter(
            (evaluator): evaluator is Evaluator => evaluator !== null,
        );

        // if there are no evaluators this frame, return
        if (!evaluatorsData || evaluatorsData.length === 0) {
            return [];
        }

        const context = composeContext({
            state: {
                ...state,
                evaluators: formatEvaluators(evaluatorsData),
                evaluatorNames: formatEvaluatorNames(evaluatorsData),
            },
            template:
                this.character.templates?.evaluationTemplate ||
                evaluationTemplate,
        });

        const result = await generateText({
            runtime: this,
            prompt: context,
            modelClass: ModelClass.SMALL,
            // verifiableInferenceAdapter: this.verifiableInferenceAdapter,
        });

        const evaluators = parseJsonArrayFromText(
            result,
        ) as unknown as string[];

        for (const evaluator of this.evaluators) {
            if (!evaluators?.includes(evaluator.name)) continue;

            // Update execution tracker before running the handler
            this.evaluatorExecutionTracker.set(evaluator.name, Date.now());
            
            if (evaluator.handler)
                await evaluator.handler(this, message, state, {}, callback);
        }

        return evaluators;
    }

    /**
     * Ensure the existence of a participant in the room. If the participant does not exist, they are added to the room.
     * @param userId - The user ID to ensure the existence of.
     * @throws An error if the participant cannot be added.
     */
    async ensureParticipantExists(userId: UUID, roomId: UUID) {
        const participants =
            await this.databaseAdapter.getParticipantsForAccount(userId);

        if (participants?.length === 0) {
            await this.databaseAdapter.addParticipant(userId, roomId);
        }
    }

    /**
     * Ensure the existence of a user in the database. If the user does not exist, they are added to the database.
     * @param userId - The user ID to ensure the existence of.
     * @param userName - The user name to ensure the existence of.
     * @returns
     */

    async ensureUserExists(
        userId: UUID,
        userName: string | null,
        name: string | null,
        email?: string | null,
        source?: string | null,
    ) {
        const account = await this.databaseAdapter.getAccountById(userId);
        if (!account) {
            await this.databaseAdapter.createAccount({
                id: userId,
                name: name || this.character.name || "Unknown User",
                username: userName || this.character.username || "Unknown",
                // TODO: We might not need these account pieces
                email: email || this.character.email || userId,
                // When invoke ensureUserExists and saving account.details
                // Performing a complete JSON.stringify on character will cause a TypeError: Converting circular structure to JSON error in some more complex plugins.
                details: this.character ? Object.assign({}, this.character, {
                    source,
                    plugins: this.character?.plugins?.map((plugin) => plugin.name),
                }) : { summary: "" },
            });
            elizaLogger.success(`User ${userName} created successfully.`);
        }

        if (isPublicAccessModeActive()) {
            await seedPublicAccessPaperTrading(this, userId);
        }
    }

    async ensureParticipantInRoom(userId: UUID, roomId: UUID) {
        const participants =
            await this.databaseAdapter.getParticipantsForRoom(roomId);
        if (!participants.includes(userId)) {
            await this.databaseAdapter.addParticipant(userId, roomId);
            if (userId === this.agentId) {
                elizaLogger.log(
                    `Agent ${this.character.name} linked to room ${roomId} successfully.`,
                );
            } else {
                elizaLogger.log(
                    `User ${userId} linked to room ${roomId} successfully.`,
                );
            }
        }
    }

    async ensureConnection(
        userId: UUID,
        roomId: UUID,
        userName?: string,
        userScreenName?: string,
        source?: string,
    ) {
        await Promise.all([
            this.ensureUserExists(
                this.agentId,
                this.character.username ?? "Agent",
                this.character.name ?? "Agent",
                source,
            ),
            this.ensureUserExists(
                userId,
                userName ?? "User" + userId,
                userScreenName ?? "User" + userId,
                source,
            ),
            this.ensureRoomExists(roomId),
        ]);

        await Promise.all([
            this.ensureParticipantInRoom(userId, roomId),
            this.ensureParticipantInRoom(this.agentId, roomId),
        ]);
    }

    /**
     * Ensure the existence of a room between the agent and a user. If no room exists, a new room is created and the user
     * and agent are added as participants. The room ID is returned.
     * @param userId - The user ID to create a room with.
     * @returns The room ID of the room between the agent and the user.
     * @throws An error if the room cannot be created.
     */
    async ensureRoomExists(roomId: UUID) {
        const room = await this.databaseAdapter.getRoom(roomId);
        if (!room) {
            await this.databaseAdapter.createRoom(roomId);
            elizaLogger.log(`Room ${roomId} created successfully.`);
        }
    }

    /**
     * Compose the state of the agent into an object that can be passed or used for response generation.
     * @param message The message to compose the state from.
     * @returns The state of the agent.
     */
    async composeState(
        message: Memory,
        additionalKeys: { [key: string]: unknown } = {},
    ) {
        const { userId, roomId } = message;

        const metadata = (message.content.metadata && typeof message.content.metadata === "object")
            ? message.content.metadata as Record<string, unknown>
            : {};
        const includeCharacterContext = metadata.isCryptoRelated !== false;

        const conversationLength = this.getConversationLength();

        const [
            actorsData,
            recentMessagesData,
            goalsData,
            userTraits,
        ]: [Actor[], Memory[], Goal[], string] = await Promise.all([
            getActorDetails({ runtime: this, roomId }),
            this.messageManager.getMemories({
                roomId,
                count: conversationLength,
                unique: false,
            }),
            getGoals({
                runtime: this,
                count: 10,
                onlyInProgress: false,
                roomId,
            }),
            this.buildUserTraitsContext(userId),
        ]);

        const goals = formatGoalsAsString({ goals: goalsData });

        const actors = formatActors({ actors: actorsData ?? [] });

        // Get the 5 most recent messages for context
        const lastFiveMessages = recentMessagesData.slice(-5);
        
        // Clean message data to remove any action execution markers for context use
        const cleanedMessagesForContext = recentMessagesData.map(msg => ({
            ...msg,
            content: {
                ...msg.content,
                // Remove action-related fields to prevent re-execution
                action: null,
                nextStepExecution: undefined,
                actionExecuted: undefined
            }
        }));
        
        const cleanedLastFiveForContext = lastFiveMessages.map(msg => ({
            ...msg,
            content: {
                ...msg.content,
                // Remove action-related fields to prevent re-execution
                action: null,
                nextStepExecution: undefined,
                actionExecuted: undefined
            }
        }));
        
        // Format full conversation history (for context only)
        const recentMessages = formatMessages({
            messages: cleanedMessagesForContext,
            actors: actorsData,
        });
        
        // Format a detailed view of the last 5 messages (for context only)
        const lastFiveMessagesFormatted = formatMessages({
            messages: cleanedLastFiveForContext,
            actors: actorsData,
        });
        
        // Format posts view (for context only)
        const recentPosts = formatPosts({
            messages: cleanedMessagesForContext,
            actors: actorsData,
            conversationHeader: false,
        });

        // const lore = formatLore(loreData);

        const senderName = actorsData?.find(
            (actor: Actor) => actor.id === userId,
        )?.name;

        // TODO: We may wish to consolidate and just accept character.name here instead of the actor name
        const agentName =
            actorsData?.find((actor: Actor) => actor.id === this.agentId)
                ?.name || this.character.name;

        let allAttachments = message.content.attachments || [];

        if (recentMessagesData && Array.isArray(recentMessagesData)) {
            const lastMessageWithAttachment = recentMessagesData.find(
                (msg) =>
                    msg.content.attachments &&
                    msg.content.attachments.length > 0,
            );

            if (lastMessageWithAttachment) {
                const lastMessageTime =
                    lastMessageWithAttachment?.createdAt ?? Date.now();
                const oneHourBeforeLastMessage =
                    lastMessageTime - 60 * 60 * 1000; // 1 hour before last message

                allAttachments = recentMessagesData.reverse().flatMap((msg) => {
                    const msgTime = msg.createdAt ?? Date.now();
                    const isWithinTime = msgTime >= oneHourBeforeLastMessage;
                    const attachments = msg.content.attachments || [];
                    if (!isWithinTime) {
                        attachments.forEach((attachment) => {
                            attachment.text = "[Hidden]";
                        });
                    }
                    return attachments;
                });
            }
        }

        const formattedAttachments = allAttachments
            .map(
                (attachment) =>
                    `ID: ${attachment.id}
Name: ${attachment.title}
URL: ${attachment.url}
Type: ${attachment.source}
Description: ${attachment.description}
Text: ${attachment.text}
  `,
            )
            .join("\n");

        // Lore removed to reduce token usage
        const lore = "";

        const pendingTradingPlansRaw = userId && roomId
            ? formatPendingTradingPlansContext(String(userId), String(roomId))
            : "";
        const pendingTradingPlans =
            pendingTradingPlansRaw.length > 0
                ? addHeader("# Pending / Active Trading Plans", pendingTradingPlansRaw)
                : "";

        let formattedCharacterPostExamples = "";
        if (includeCharacterContext && Array.isArray(this.character.postExamples) && this.character.postExamples.length > 0) {
            formattedCharacterPostExamples = this.character.postExamples
                .sort(() => 0.5 - Math.random())
                .map((post) => {
                    const messageString = `${post}`;
                    return messageString;
                })
                .slice(0, 50)
                .join("\n");
        }

        let formattedCharacterMessageExamples = "";
        if (includeCharacterContext && Array.isArray(this.character.messageExamples) && this.character.messageExamples.length > 0) {
            formattedCharacterMessageExamples = this.character.messageExamples
                .sort(() => 0.5 - Math.random())
                .slice(0, 5)
                .map((example) => {
                    const exampleNames = Array.from({ length: 5 }, () =>
                        uniqueNamesGenerator({ dictionaries: [names] }),
                    );

                    return example
                        .map((message) => {
                            let messageString = `${message.user}: ${message.content.text}`;
                            exampleNames.forEach((name, index) => {
                                const placeholder = `{{user${index + 1}}}`;
                                messageString = messageString.replaceAll(
                                    placeholder,
                                    name,
                                );
                            });
                            return messageString;
                        })
                        .join("\n");
                })
                .join("\n\n");
        }

        const getRecentInteractions = async (
            userA: UUID,
            userB: UUID,
        ): Promise<Memory[]> => {
            // Find all rooms where userA and userB are participants
            const rooms = await this.databaseAdapter.getRoomsForParticipants([
                userA,
                userB,
            ]);

            // Check the existing memories in the database
            return this.messageManager.getMemoriesByRoomIds({
                // filter out the current room id from rooms
                roomIds: rooms.filter((room) => room !== roomId),
                limit: 20,
            });
        };

        const recentInteractions =
            userId !== this.agentId
                ? await getRecentInteractions(userId, this.agentId)
                : [];

        const getRecentMessageInteractions = async (
            recentInteractionsData: Memory[],
        ): Promise<string> => {
            // Format the recent messages
            const formattedInteractions = await Promise.all(
                recentInteractionsData.map(async (message) => {
                    const isSelf = message.userId === this.agentId;
                    let sender: string;
                    if (isSelf) {
                        sender = this.character.name;
                    } else {
                        const accountId =
                            await this.databaseAdapter.getAccountById(
                                message.userId,
                            );
                        sender = accountId?.username || "unknown";
                    }
                    return `${sender}: ${message.content.text}`;
                }),
            );

            return formattedInteractions.join("\n");
        };

        const formattedMessageInteractions =
            await getRecentMessageInteractions(recentInteractions);

        const getRecentPostInteractions = async (
            recentInteractionsData: Memory[],
            actors: Actor[],
        ): Promise<string> => {
            const formattedInteractions = formatPosts({
                messages: recentInteractionsData,
                actors,
                conversationHeader: true,
            });

            return formattedInteractions;
        };

        const formattedPostInteractions = await getRecentPostInteractions(
            recentInteractions,
            actorsData,
        );

        // Bio removed to reduce token usage
        const bio = "";

        let knowledgeData: any[] = [];
        let formattedKnowledge = "";

        let ragKnowledgePayload: any[] = [];
        if (includeCharacterContext) {
            if (this.character.settings?.ragKnowledge) {
                const recentContext = recentMessagesData
                    .sort((a, b) => b.createdAt - a.createdAt) // Sort by timestamp descending (newest first)
                    .slice(0, 3) // Get the 3 most recent messages
                    .reverse() // Reverse to get chronological order
                    .map((msg) => msg.content.text)
                    .join(" ");

                knowledgeData = await this.ragKnowledgeManager.getKnowledge({
                    query: message.content.text,
                    conversationContext: recentContext,
                    limit: 8,
                });

                formattedKnowledge = this.formatKnowledge(knowledgeData as KnowledgeItem[]);
                ragKnowledgePayload = knowledgeData;
            } else {
                knowledgeData = await knowledge.get(this, message);

                formattedKnowledge = this.formatKnowledge(knowledgeData as KnowledgeItem[]);
            }
        }

        const initialState = {
            agentId: this.agentId,
            roomId,        // Essential: Include roomId from message to ensure proper room context
            userId,        // Essential: Include userId from message for state completeness
            agentName,
            bio,
            lore,
            currentDate: new Date().toISOString(),
            currentTimestamp: Date.now(),
            latestQuery: message.content.text || "",
            adjective:
                includeCharacterContext && this.character.adjectives &&
                this.character.adjectives.length > 0
                    ? this.character.adjectives[
                          Math.floor(
                              Math.random() * this.character.adjectives.length,
                          )
                      ]
                    : "",
            knowledge: includeCharacterContext ? formattedKnowledge : "",
            knowledgeData: includeCharacterContext ? knowledgeData : [],
            ragKnowledgeData: includeCharacterContext ? ragKnowledgePayload : [],
            // Recent interactions between the sender and receiver, formatted as messages
            recentMessageInteractions: formattedMessageInteractions,
            // Recent interactions between the sender and receiver, formatted as posts
            recentPostInteractions: formattedPostInteractions,
            // Raw memory[] array of interactions
            recentInteractionsData: recentInteractions,
            // randomly pick one topic
            topic:
                includeCharacterContext && this.character.topics && this.character.topics.length > 0
                    ? this.character.topics[
                          Math.floor(
                              Math.random() * this.character.topics.length,
                          )
                      ]
                    : null,
            topics:
                includeCharacterContext && this.character.topics && this.character.topics.length > 0
                    ? `${this.character.name} is interested in ` +
                      this.character.topics
                          .sort(() => 0.5 - Math.random())
                          .slice(0, 5)
                          .map((topic, index, array) => {
                              if (index === array.length - 2) {
                                  return topic + " and ";
                              }
                              // if last topic, don't add a comma
                              if (index === array.length - 1) {
                                  return topic;
                              }
                              return topic + ", ";
                          })
                          .join("")
                    : "",
            characterPostExamples:
                includeCharacterContext &&
                formattedCharacterPostExamples &&
                formattedCharacterPostExamples.replaceAll("\n", "").length > 0
                    ? addHeader(
                          `# Example Posts for ${this.character.name}`,
                          formattedCharacterPostExamples,
                      )
                    : "",
            characterMessageExamples:
                includeCharacterContext &&
                formattedCharacterMessageExamples &&
                formattedCharacterMessageExamples.replaceAll("\n", "").length > 0
                    ? addHeader(
                          `# Example Conversations for ${this.character.name}`,
                          formattedCharacterMessageExamples,
                      )
                    : "",
            messageDirections:
                includeCharacterContext &&
                (this.character?.style?.all?.length > 0 ||
                this.character?.style?.chat.length > 0)
                    ? addHeader(
                          "# Message Directions for " + this.character.name,
                          (() => {
                              const all = this.character?.style?.all || [];
                              const chat = this.character?.style?.chat || [];
                              return [...all, ...chat].join("\n");
                          })(),
                      )
                    : "",

            postDirections:
                includeCharacterContext &&
                (this.character?.style?.all?.length > 0 ||
                this.character?.style?.post.length > 0)
                    ? addHeader(
                          "# Post Directions for " + this.character.name,
                          (() => {
                              const all = this.character?.style?.all || [];
                              const post = this.character?.style?.post || [];
                              return [...all, ...post].join("\n");
                          })(),
                      )
                    : "",

            //old logic left in for reference
            //food for thought. how could we dynamically decide what parts of the character to add to the prompt other than random? rag? prompt the llm to decide?
            /*
            postDirections:
                this.character?.style?.all?.length > 0 ||
                this.character?.style?.post.length > 0
                    ? addHeader(
                            "# Post Directions for " + this.character.name,
                            (() => {
                                const all = this.character?.style?.all || [];
                                const post = this.character?.style?.post || [];
                                const shuffled = [...all, ...post].sort(
                                    () => 0.5 - Math.random()
                                );
                                return shuffled
                                    .slice(0, conversationLength / 2)
                                    .join("\n");
                            })()
                        )
                    : "",*/
            // Agent runtime stuff
            senderName,
            actors:
                actors && actors.length > 0
                    ? addHeader("# Actors", actors)
                    : "",
            actorsData,
            goals:
                goals && goals.length > 0
                    ? addHeader(
                          "# Goals\n{{agentName}} should prioritize accomplishing the objectives that are in progress.",
                          goals,
                      )
                    : "",
            goalsData,
            userTraits,
            pendingTradingPlans,
            recentMessages:
                recentMessages && recentMessages.length > 0
                    ? addHeader("# Conversation Messages", recentMessages)
                    : "",
            lastFiveMessages:
                lastFiveMessagesFormatted && lastFiveMessagesFormatted.length > 0
                    ? addHeader("# Last 5 Messages (Review Carefully)", lastFiveMessagesFormatted)
                    : "",
            recentPosts:
                recentPosts && recentPosts.length > 0
                    ? addHeader("# Posts in Thread", recentPosts)
                    : "",
            recentMessagesData,
            lastFiveMessagesData: lastFiveMessages,
            attachments:
                formattedAttachments && formattedAttachments.length > 0
                    ? addHeader("# Attachments", formattedAttachments)
                    : "",
            isCryptoRelated: includeCharacterContext,
            ...additionalKeys,
        } as State;

        // Evaluator validation
        const evaluatorPromises = this.evaluators.map(async (evaluator) => {
            const result = await evaluator.validate(
                this,
                message,
                initialState,
            );
            if (result) {
                return evaluator;
            }
            return null;
        });

        const [resolvedEvaluators, providers] =
            await Promise.all([
                Promise.all(evaluatorPromises),
                getProviders(this, message, initialState),
            ]);

        const evaluatorsData = resolvedEvaluators.filter(
            Boolean,
        ) as Evaluator[];

        // Use all actions directly - no validation needed
        const actionsData = this.actions;

        const actionState = {
            actionNames: formatActionNames(actionsData),
            actions: formatActions(actionsData),
            actionExamples: "", // Examples removed to reduce token usage - action descriptions are sufficient
            evaluatorsData,
            evaluators:
                evaluatorsData.length > 0
                    ? formatEvaluators(evaluatorsData)
                    : "",
            evaluatorNames:
                evaluatorsData.length > 0
                    ? formatEvaluatorNames(evaluatorsData)
                    : "",
            evaluatorExamples:
                evaluatorsData.length > 0
                    ? formatEvaluatorExamples(evaluatorsData)
                    : "",
            providers: addHeader(
                `# Additional Information About ${this.character.name} and The World`,
                providers,
            ),
        };

        return { ...initialState, ...actionState } as State;
    }

    async updateRecentMessageState(state: State): Promise<State> {
        const conversationLength = this.getConversationLength();
        const recentMessagesData = await this.messageManager.getMemories({
            roomId: state.roomId,
            count: conversationLength,
            unique: false,
        });

        // Prepare memory objects for formatting (remove embeddings and action execution data)
        const cleanedMessages = recentMessagesData.map((memory: Memory) => {
            const newMemory = { ...memory };
            delete newMemory.embedding;
            // Remove action-related fields to prevent re-execution when used as context
            newMemory.content = {
                ...newMemory.content,
                action: null,
                nextStepExecution: undefined,
                actionExecuted: undefined
            };
            return newMemory;
        });
        
        // Get last 5 messages for context
        const lastFiveMessages = cleanedMessages.slice(-5);
        
        // Format full conversation (for context only)
        const recentMessages = formatMessages({
            actors: state.actorsData ?? [],
            messages: cleanedMessages,
        });
        
        // Format last 5 messages (for context only)
        const lastFiveMessagesFormatted = formatMessages({
            actors: state.actorsData ?? [],
            messages: lastFiveMessages,
        });

        let allAttachments = [];

        if (recentMessagesData && Array.isArray(recentMessagesData)) {
            const lastMessageWithAttachment = recentMessagesData.find(
                (msg) =>
                    msg.content.attachments &&
                    msg.content.attachments.length > 0,
            );

            if (lastMessageWithAttachment) {
                const lastMessageTime =
                    lastMessageWithAttachment?.createdAt ?? Date.now();
                const oneHourBeforeLastMessage =
                    lastMessageTime - 60 * 60 * 1000; // 1 hour before last message

                allAttachments = recentMessagesData
                    .filter((msg) => {
                        const msgTime = msg.createdAt ?? Date.now();
                        return msgTime >= oneHourBeforeLastMessage;
                    })
                    .flatMap((msg) => msg.content.attachments || []);
            }
        }

        const formattedAttachments = allAttachments
            .map(
                (attachment) =>
                    `ID: ${attachment.id}
Name: ${attachment.title}
URL: ${attachment.url}
Type: ${attachment.source}
Description: ${attachment.description}
Text: ${attachment.text}
    `,
            )
            .join("\n");

        return {
            ...state,
            recentMessages: addHeader(
                "# Conversation Messages",
                recentMessages,
            ),
            requestMessage: addHeader(
                "# Request Message",
                recentMessages.slice(-1),
            ),
            recentMessagesData,
            lastFiveMessagesData: lastFiveMessages,
            attachments: formattedAttachments,
        } as State;
    }
    /**
     * Route message to appropriate handler based on classification
     */
    // §4 Observability: per-turn handler root span. routeMessage is the classification-routing
    // dispatch that hands off to every handler, so one root span here parents all node/LLM
    // child spans for the turn. Transparent when OTEL_TRACING_ENABLED is unset.
    async routeMessage(
        message: Memory,
        callback?: HandlerCallback,
        streamingCallback?: StreamingCallback,
        intermediateResponseCallback?: (response: Memory) => void,
        connectionId?: string,
        onToken?: (delta: string) => void,
        onAnalysisComplete?: (analysisContent: string) => void,
    ): Promise<Memory[]> {
        return withSpan(
            "handler:routeMessage",
            {
                "agent.id": this.agentId,
                "message.id": message?.id ?? "",
                "room.id": message?.roomId ?? "",
                // §7 evolution: correlate a sim/A/B run's traces in Cloud Trace. Undefined (the
                // normal case) is skipped by applyAttributes, so this is inert outside the loop.
                "sim.run_id": process.env.SIM_RUN_ID,
            },
            () =>
                this.routeMessageImpl(
                    message,
                    callback,
                    streamingCallback,
                    intermediateResponseCallback,
                    connectionId,
                    onToken,
                    onAnalysisComplete,
                ),
        );
    }

    private async routeMessageImpl(
        message: Memory,
        callback?: HandlerCallback,
        streamingCallback?: StreamingCallback,
        intermediateResponseCallback?: (response: Memory) => void,
        connectionId?: string,
        onToken?: (delta: string) => void,
        onAnalysisComplete?: (analysisContent: string) => void,
    ): Promise<Memory[]> {
        // Process user feature profile in background (non-blocking)
        this.userFeatureManager.processMessage(message).catch((error) => {
            elizaLogger.warn(
                "[Runtime] User feature profile processing failed in background",
                error
            );
        });

        try {
            // Anonymous users: route directly to regular message handler only (no classification, no task chain / comprehensive)
            const contentMeta = message.content?.metadata && typeof message.content.metadata === "object"
                ? (message.content.metadata as Record<string, unknown>)
                : {};
            if (contentMeta.isAnonymous === true && !isPublicAccessModeActive()) {
                // Fix 9 — honest auth-required reply for CEX intent.
                //
                // Before this guard ran, every anonymous message was force-
                // routed to `handleRegularMessage`. CEX-intent messages
                // ("show my balance", "买 BTC", etc.) then got a generic
                // "I don't have access to your accounts" decline from the
                // REGULAR handler — which reads like a bug, not a
                // permissions issue. Now we run the SAME deterministic
                // short-circuit cascade the LangGraph precheck uses
                // (`cex_account_intent` / `cex_trade_intent`) and, on a
                // CEX hit, persist a synthetic "please sign in" memory
                // matching the exact text the CEX handler would have
                // shown if it could run. Non-CEX anonymous messages
                // keep the existing REGULAR-only behavior.
                const rawText = typeof message.content?.text === "string"
                    ? message.content.text
                    : "";
                const shortCircuit = evaluateShortCircuit(rawText);
                if (
                    shortCircuit !== null &&
                    shortCircuit.classification === "CEX_WORKFLOW_MESSAGE"
                ) {
                    elizaLogger.info(
                        `[Runtime] Anonymous user – CEX intent detected (${shortCircuit.name}); returning auth-required reply.`,
                    );

                    const locale = detectLocale(rawText, "en");
                    const authText = getCEXAuthRequiredErrorTemplate(locale);

                    const authMemory: Memory = {
                        id: uuidv4() as UUID,
                        userId: this.agentId,
                        agentId: this.agentId,
                        roomId: message.roomId,
                        createdAt: Date.now(),
                        content: {
                            text: authText,
                            language: locale,
                            metadata: {
                                classification: "CEX_WORKFLOW_MESSAGE",
                                classificationConfidence: 1,
                                classificationReasoning: `Anonymous user matched short-circuit pattern "${shortCircuit.name}"; CEX requires sign-in.`,
                                isCryptoRelated: true,
                                anonymousCexAuthRequired: true,
                                shortCircuitPattern: shortCircuit.name,
                            },
                        },
                    };

                    await this.messageManager.createMemory(authMemory);

                    if (callback) {
                        await callback(authMemory.content);
                    }

                    if (intermediateResponseCallback) {
                        intermediateResponseCallback(authMemory);
                    }

                    return [authMemory];
                }

                elizaLogger.info("[Runtime] Anonymous user – routing directly to regular message handler");
                const existingMetadata = (message.content.metadata && typeof message.content.metadata === "object")
                    ? { ...(message.content.metadata as Record<string, unknown>) }
                    : {};
                existingMetadata.classification = "REGULAR_MESSAGE";
                existingMetadata.classificationConfidence = 1;
                existingMetadata.classificationReasoning = "Anonymous users are limited to regular questions only.";
                existingMetadata.isCryptoRelated = true;
                message.content.metadata = existingMetadata;
                return await this.handleRegularMessage(
                    message,
                    callback,
                    streamingCallback,
                    intermediateResponseCallback,
                    onToken,
                );
            }

            if (this.isComprehensiveAnalysisEnabled()) {
                const now = Date.now();
                const overrideStepId = `comprehensive-analysis-override-${now}`;

                elizaLogger.info(`[Runtime] Comprehensive analysis override active - bypassing LangGraph precheck`);

                const overrideMetadata =
                    message.content.metadata && typeof message.content.metadata === "object"
                        ? { ...(message.content.metadata as Record<string, unknown>) }
                        : {};
                overrideMetadata.isCryptoRelated = true;
                overrideMetadata.classification = "COMPREHENSIVE_ANALYSIS_MESSAGE";
                overrideMetadata.comprehensiveOverride = true;
                message.content.metadata = overrideMetadata;

                if (streamingCallback) {
                    streamingCallback({
                        id: overrideStepId,
                        name: "Comprehensive Analysis Override",
                        status: "in_progress",
                        message: "Comprehensive analysis override enabled – skipping precheck and executing full workflow.",
                        timestamp: now,
                    });
                }

                try {
                    const responses = await this.handleComprehensiveAnalysis(
                        message,
                        callback,
                        streamingCallback,
                        intermediateResponseCallback,
                        onToken,
                        onAnalysisComplete,
                    );

                    if (streamingCallback) {
                        streamingCallback({
                            id: overrideStepId,
                            name: "Comprehensive Analysis Override",
                            status: "completed",
                            message: "Comprehensive analysis override complete.",
                            timestamp: Date.now(),
                        });
                    }

                    return responses;
                } catch (overrideError) {
                    if (streamingCallback) {
                        streamingCallback({
                            id: overrideStepId,
                            name: "Comprehensive Analysis Override",
                            status: "error",
                            message: "Comprehensive analysis override failed.",
                            timestamp: Date.now(),
                            error: overrideError instanceof Error ? overrideError.message : String(overrideError),
                        });
                    }

                    throw overrideError;
                }
            }

            // Active CEX plan + status query → CEX handler (plan runner reports state).
            try {
                const statusText =
                    typeof message.content?.text === "string"
                        ? message.content.text.trim()
                        : "";
                if (
                    statusText
                    && message.userId
                    && isExecutionStatusQuery(statusText)
                ) {
                    const activePlan = getActivePlan(
                        String(message.userId),
                        String(message.roomId),
                    );
                    if (activePlan) {
                        elizaLogger.info(
                            "[Runtime] Active plan + execution status query → CEX workflow",
                        );
                        const statusMetadata =
                            message.content.metadata
                            && typeof message.content.metadata === "object"
                                ? { ...(message.content.metadata as Record<string, unknown>) }
                                : {};
                        statusMetadata.classification = "CEX_WORKFLOW_MESSAGE";
                        statusMetadata.classificationConfidence = 1;
                        statusMetadata.classificationReasoning =
                            "Active CEX plan status query";
                        statusMetadata.isCryptoRelated = true;
                        message.content.metadata = statusMetadata;
                        return await this.handleCEXWorkflowMessage(
                            message,
                            callback,
                            streamingCallback,
                            intermediateResponseCallback,
                            onToken,
                        );
                    }
                }
            } catch (err) {
                elizaLogger.warn(
                    `[Runtime] Active-plan status routing failed (fail-open): ${err instanceof Error ? err.message : String(err)}`,
                );
            }

            // F6 — deterministic CEX-continuation precheck bypass.
            // Short follow-up turns (≤120 chars OR pure number/yes/no)
            // that arrive while a CEX workflow was awaiting clarification
            // or has a pending approval get routed straight to the CEX
            // handler, skipping the LangGraph precheck classifier. Gated
            // by `CEX_DETERMINISTIC_BYPASS=true` so we can roll back via
            // env without a deploy.
            const cexBypassEnabled =
                (settings.CEX_DETERMINISTIC_BYPASS ??
                    process.env.CEX_DETERMINISTIC_BYPASS ??
                    "true").toLowerCase() !== "false";
            if (cexBypassEnabled) {
                try {
                    const userText = typeof message.content?.text === "string"
                        ? message.content.text.trim()
                        : "";
                    // F6-r3 — intent-shift guard. If the message looks like
                    // a fresh trading request ("I want to buy BTC") or a
                    // topic shift ("what is the price?") we must NOT bypass
                    // even when a recent CEX clarification memo is present.
                    // The stale clarification context would otherwise hijack
                    // the LLM into replying as if the new message were an
                    // answer to the old question.
                    const intentShift = detectIntentShift(userText);
                    if (intentShift !== null) {
                        elizaLogger.debug(
                            `[Routing] {"stage":"cex_bypass","hit":false,"reason":"intent_shift:${intentShift}","userId":"${message.userId}"}`,
                        );
                    } else if (isShortFollowUpText(userText)) {
                        const recents = await this.messageManager.getMemories({
                            roomId: message.roomId,
                            count: 5,
                            unique: false,
                        });
                        const nowMs = Date.now();
                        const continuation = recents.find((m) =>
                            isCexContinuationMemory(m, {
                                agentId: this.agentId,
                                nowMs,
                            }),
                        );
                        if (continuation) {
                            const meta = (continuation.content?.metadata ?? {}) as Record<string, unknown>;
                            const cexRequestId = typeof meta.cexRequestId === "string"
                                ? meta.cexRequestId
                                : null;
                            // F6-r4 — intent-class match guard. The CEX
                            // workflow stamps `cexIntentClass` on each
                            // clarification memo (`cancel` / `create` /
                            // `modify`). If the user's NEW message
                            // implies a different class via its verb,
                            // the bypass declines — the new request is
                            // not a follow-up.
                            const prevClass = typeof meta.cexIntentClass === "string"
                                ? meta.cexIntentClass
                                : null;
                            const newClass = classifyCexIntentClassFromText(userText);
                            if (prevClass && newClass && prevClass !== newClass) {
                                elizaLogger.info(
                                    `[Routing] {"stage":"cex_bypass","hit":false,"reason":"intent_class_mismatch","userId":"${message.userId}","prevClass":"${prevClass}","newClass":"${newClass}","cexRequestId":"${cexRequestId ?? "n/a"}"}`,
                                );
                            } else {
                                elizaLogger.info(
                                    `[Routing] {"stage":"cex_bypass","hit":true,"reason":"continuation","userId":"${message.userId}","cexRequestId":"${cexRequestId ?? "n/a"}","prevClass":"${prevClass ?? "n/a"}","newClass":"${newClass ?? "n/a"}"}`,
                                );
                                const continuationMetadata =
                                    message.content.metadata && typeof message.content.metadata === "object"
                                        ? { ...(message.content.metadata as Record<string, unknown>) }
                                        : {};
                                continuationMetadata.classification = "CEX_WORKFLOW_MESSAGE";
                                continuationMetadata.classificationConfidence = 1;
                                continuationMetadata.classificationReasoning =
                                    "F6: short follow-up after CEX clarification — bypassing precheck";
                                continuationMetadata.cexContinuationRequestId = cexRequestId;
                                continuationMetadata.isCryptoRelated = true;
                                message.content.metadata = continuationMetadata;
                                return await this.handleCEXWorkflowMessage(
                                    message,
                                    callback,
                                    streamingCallback,
                                    intermediateResponseCallback,
                                    onToken,
                                );
                            }
                        }
                        // info (not debug) + per-memory diagnostics: a missed continuation here
                        // silently misroutes the user's "yes" to the REGULAR handler, which is
                        // exactly the failure mode F6 exists to prevent — it must be observable.
                        const recentsDiag = recents
                            .map((m) => {
                                const md = (m.content?.metadata ?? {}) as Record<string, unknown>;
                                return `{agentAuthored:${m.userId === this.agentId},source:${m.content?.source ?? "?"},awaiting:${md.cexAwaitingClarification === true},reqId:${typeof md.cexRequestId === "string"},ageMs:${Date.now() - (m.createdAt ?? 0)}}`;
                            })
                            .join(",");
                        elizaLogger.info(
                            `[Routing] {"stage":"cex_bypass","hit":false,"reason":"no_continuation","userId":"${message.userId}","recents":[${recentsDiag}]}`,
                        );
                    }
                } catch (err) {
                    elizaLogger.warn(
                        `[Routing] F6 CEX bypass detector failed (fail-open): ${err instanceof Error ? err.message : String(err)}`,
                    );
                }
            }

            const favoriteChainAttachment = this.extractFavoriteTaskChainFromMessage(message);

            // Mantle two-turn approval: approve/cancel must reach the Mantle handler
            // when a pending swap exists for this room+user (in-memory, 15 min TTL).
            try {
                const mantleFollowUpText =
                    typeof message.content?.text === "string"
                        ? message.content.text.trim()
                        : "";
                if (
                    mantleFollowUpText
                    && message.userId
                    && message.roomId
                    && shouldRouteMantleApprovalContinuation(
                        mantleFollowUpText,
                        message.roomId,
                        message.userId,
                    )
                ) {
                    elizaLogger.info(
                        "[Runtime] Mantle approval follow-up → Mantle workflow",
                    );
                    const mantleMetadata =
                        message.content.metadata
                        && typeof message.content.metadata === "object"
                            ? { ...(message.content.metadata as Record<string, unknown>) }
                            : {};
                    mantleMetadata.classification = "MANTLE_WORKFLOW_MESSAGE";
                    mantleMetadata.classificationConfidence = 1;
                    mantleMetadata.classificationReasoning =
                        "Mantle approval continuation with pending swap";
                    mantleMetadata.isCryptoRelated = true;
                    message.content.metadata = mantleMetadata;
                    return await this.handleMantleWorkflowMessage(
                        message,
                        callback,
                        streamingCallback,
                        intermediateResponseCallback,
                        onToken,
                    );
                }
            } catch (err) {
                elizaLogger.warn(
                    `[Runtime] Mantle approval continuation routing failed (fail-open): ${err instanceof Error ? err.message : String(err)}`,
                );
            }

            if (favoriteChainAttachment) {
                elizaLogger.info("[Runtime] Favorite task chain attachment detected – bypassing precheck classifier");

                const overrideMetadata =
                    message.content.metadata && typeof message.content.metadata === "object"
                        ? { ...(message.content.metadata as Record<string, unknown>) }
                        : {};

                overrideMetadata.favoriteTaskChain = favoriteChainAttachment;
                overrideMetadata.favoriteChainAttachment = true;
                overrideMetadata.classification = "TASK_CHAIN_MESSAGE";
                overrideMetadata.classificationConfidence = 1;
                overrideMetadata.classificationReasoning = "User supplied favorite task chain attachment";
                overrideMetadata.isCryptoRelated = true;
                message.content.metadata = overrideMetadata;

                if (streamingCallback) {
                    streamingCallback({
                        id: `favorite-task-chain-${Date.now()}`,
                        name: "Favorite Task Chain",
                        status: "in_progress",
                        message: "Using attached favorite task chain without additional planning precheck.",
                        timestamp: Date.now(),
                        data: {
                            type: "favorite_task_chain",
                            favoriteId: (favoriteChainAttachment as Record<string, unknown>)?.favoriteId ?? undefined,
                        },
                    });
                }

                return await this.handleMessageWithTaskChain(message, callback, streamingCallback, intermediateResponseCallback, connectionId);
            }

            // Classify the message first
            const classification = await this.messagePrecheckService.classifyMessage(message);

            elizaLogger.info(`[Runtime] Message classified as: ${classification.classification} (confidence: ${classification.confidence})`);
            elizaLogger.debug(`[Runtime] Classification reasoning: ${classification.reasoning}`);
            elizaLogger.debug(`[Runtime] Crypto relevance: ${classification.isCryptoRelated}`);

            // Persist crypto relevance on the message for downstream handlers
            const existingMetadata = (message.content.metadata && typeof message.content.metadata === 'object')
                ? { ...message.content.metadata as Record<string, unknown> }
                : {};
            existingMetadata.isCryptoRelated = classification.isCryptoRelated !== false;
            existingMetadata.classification = classification.classification;
            existingMetadata.classificationConfidence = classification.confidence;
            existingMetadata.classificationReasoning = classification.reasoning;
            message.content.metadata = existingMetadata;

            // Route to appropriate handler based on classification
            switch (classification.classification) {
                case 'REGULAR_MESSAGE':
                    elizaLogger.info(`[Runtime] Routing to regular message handler`);
                    // Forward onToken so the regular workflow's Google streaming
                    // branch can fire SSE token events. The anonymous fast-path
                    // above already passes it; missing it here meant authenticated
                    // users whose messages classified as REGULAR_MESSAGE silently
                    // fell back to non-streaming output (see staging logs
                    // 2026-04-26T19:13: shouldStream=true but state.onToken
                    // ended up undefined, so the inner wrapper's
                    // state.onToken?.(delta) was a no-op).
                    return await this.handleRegularMessage(message, callback, streamingCallback, intermediateResponseCallback, onToken);

                case 'CEX_WORKFLOW_MESSAGE':
                    elizaLogger.info(`[Runtime] Routing to CEX workflow handler`);
                    // D3 — onToken is now plumbed through so the plan-as-text
                    // path can stream markdown to the SSE consumer as it
                    // generates. Other CEX branches (single-order, balance,
                    // etc.) ignore it.
                    return await this.handleCEXWorkflowMessage(message, callback, streamingCallback, intermediateResponseCallback, onToken);

                case 'MANTLE_WORKFLOW_MESSAGE':
                    elizaLogger.info(`[Runtime] Routing to Mantle workflow handler`);
                    return await this.handleMantleWorkflowMessage(message, callback, streamingCallback, intermediateResponseCallback, onToken);

                case 'COMPREHENSIVE_ANALYSIS_MESSAGE':
                    elizaLogger.info(`[Runtime] Routing to comprehensive analysis handler`);
                    return await this.handleComprehensiveAnalysis(message, callback, streamingCallback, intermediateResponseCallback, onToken, onAnalysisComplete);

                case 'TASK_CHAIN_MESSAGE':
                default:
                    elizaLogger.info(`[Runtime] Routing to task chain handler`);
                    return await this.handleMessageWithTaskChain(message, callback, streamingCallback, intermediateResponseCallback, connectionId, onToken);
            }
        } catch (error: any) {
            elizaLogger.error(`[Runtime] Message routing failed: ${error.message}`);
            // Fallback to task chain processing on error
            elizaLogger.info(`[Runtime] Falling back to task chain processing`);
            return await this.handleMessageWithTaskChain(message, callback, streamingCallback, intermediateResponseCallback, connectionId, onToken);
        }
    }

    async handleMessageWithTaskChain(
        message: Memory,
        callback?: HandlerCallback,
        streamingCallback?: StreamingCallback,
        intermediateResponseCallback?: (response: Memory) => void,
        connectionId?: string,
        onToken?: (delta: string) => void | Promise<void>,
    ): Promise<Memory[]> {
        // Process user feature profile in background (non-blocking)
        this.userFeatureManager.processMessage(message).catch((error) => {
            elizaLogger.warn(
                "[Runtime] User feature profile processing failed in background",
                error
            );
        });
        // Use the task chain handler with proper this binding
        return handleMessageWithTaskChain.call(this, message, callback, streamingCallback, intermediateResponseCallback, undefined, connectionId, onToken);
    }

    private extractFavoriteTaskChainFromMessage(message: Memory): unknown {
        const content = message.content as Record<string, unknown> | undefined;
        if (!content) {
            return undefined;
        }

        const candidateKeys = [
            "favoriteTaskChain",
            "favorite_task_chain",
            "favoriteChain",
        ];

        for (const key of candidateKeys) {
            if (key in content) {
                const value = content[key];
                const normalized = this.normalizeFavoriteChainValue(value);
                if (normalized) {
                    return normalized;
                }
            }
        }

        const metadata = content.metadata;
        if (metadata && typeof metadata === "object") {
            for (const key of candidateKeys) {
                if (key in (metadata as Record<string, unknown>)) {
                    const value = (metadata as Record<string, unknown>)[key];
                    const normalized = this.normalizeFavoriteChainValue(value);
                    if (normalized) {
                        return normalized;
                    }
                }
            }
        }

        const attachments = Array.isArray(content.attachments) ? content.attachments : [];
        for (const attachment of attachments) {
            if (!attachment || typeof attachment !== "object") {
                continue;
            }

            for (const key of candidateKeys) {
                if (key in (attachment as Record<string, unknown>)) {
                    const value = (attachment as Record<string, unknown>)[key];
                    const normalized = this.normalizeFavoriteChainValue(value);
                    if (normalized) {
                        return normalized;
                    }
                }
            }
        }

        return undefined;
    }

    private normalizeFavoriteChainValue(value: unknown): unknown {
        if (!value) {
            return undefined;
        }

        if (typeof value === "string") {
            const trimmed = value.trim();
            if (!trimmed) {
                return undefined;
            }

            try {
                return JSON.parse(trimmed);
            } catch {
                return undefined;
            }
        }

        if (typeof value === "object") {
            return value;
        }

        return undefined;
    }

    /**
     * Handle regular messages (simple responses)
     * Uses dedicated regular message handler for fast, simple responses
     */
    async handleRegularMessage(
        message: Memory,
        callback?: HandlerCallback,
        streamingCallback?: StreamingCallback,
        intermediateResponseCallback?: (response: Memory) => void,
        onToken?: (delta: string) => void,
    ): Promise<Memory[]> {
        elizaLogger.info(`[Runtime] Processing regular message`);
        return await handleRegularMessage(this, message, callback, streamingCallback, intermediateResponseCallback, onToken);
    }

    /**
     * Handle trading info messages (CEX trading: orders/fills/positions/fees/PnL/funding)
     * Uses a Regular-like workflow with human-in-the-loop parameter confirmation.
     */
    async handleCEXWorkflowMessage(
        message: Memory,
        callback?: HandlerCallback,
        streamingCallback?: StreamingCallback,
        intermediateResponseCallback?: (response: Memory) => void,
        onToken?: (delta: string) => Promise<void> | void
    ): Promise<Memory[]> {
        elizaLogger.info(`[Runtime] Processing CEX workflow message`);
        return await handleCEXWorkflowMessage(this, message, callback, streamingCallback, intermediateResponseCallback, onToken);
    }

    async handleMantleWorkflowMessage(
        message: Memory,
        callback?: HandlerCallback,
        streamingCallback?: StreamingCallback,
        intermediateResponseCallback?: (response: Memory) => void,
        onToken?: (delta: string) => Promise<void> | void,
    ): Promise<Memory[]> {
        elizaLogger.info(`[Runtime] Processing Mantle workflow message`);
        return await handleMantleWorkflowMessage(
            this,
            message,
            callback,
            streamingCallback,
            intermediateResponseCallback,
            onToken,
        );
    }

    /**
     * Handle comprehensive analysis messages
     * Uses the dedicated comprehensive analysis handler to execute all 12 mandatory actions
     * and generate professional HTML reports
     */
    async handleComprehensiveAnalysis(
        message: Memory,
        callback?: HandlerCallback,
        streamingCallback?: StreamingCallback,
        intermediateResponseCallback?: (response: Memory) => void,
        onToken?: (delta: string) => void,
        onAnalysisComplete?: (analysisContent: string) => void,
    ): Promise<Memory[]> {
        elizaLogger.info(`[Runtime] Starting comprehensive analysis process`);
        // [debug-leak] Probe immediately after the existing entry log so we can
        // measure the gap between the scheduler trigger and composeState start.
        logMemProbe("runtime.handleComprehensiveAnalysis:enter", {
            source: (message?.content?.source as string | undefined) ?? "unknown",
        });

        try {
            // Compose state first to ensure proper roomId and context.
            // [debug-leak] composeState pulls recent memories, RAG hits, and
            // provider context from DocumentDB — strong candidate for the
            // silent +3 GB jump (cursor pages held as `external` Buffers).
            const state = await withMemProbe(
                "runtime.composeState",
                () => this.composeState(message),
                {
                    source:
                        (message?.content?.source as string | undefined) ??
                        "unknown",
                }
            );

            // Call the comprehensive analysis handler with streaming support
            const result = await withMemProbe(
                "runtime.workflowHandler",
                () =>
                    handleComprehensiveAnalysis(
                        this,
                        message,
                        state,
                        streamingCallback,
                        intermediateResponseCallback,
                        onToken,
                        onAnalysisComplete
                    )
            );

            const schedulerRun = isDailySchedulerMessage(message);

            if (result.success && result.reportPath) {
                // Deliver the actual analysis content in-chat. Prior versions only
                // surfaced a boilerplate "report generated" notice, hiding the
                // generated content inside the HTML file and leaving the chat
                // visibly silent after the final phase completed.
                const reportFilename = result.reportPath?.split('/').pop();
                const responseText = result.analysisContent
                    ? `${result.analysisContent}\n\n---\n\n📄 **Full report:** \`${reportFilename}\` (saved to \`saved_data/Reports/\`).`
                    : `🎉 **Comprehensive Analysis Complete!**\n\n**Professional HTML Report Generated:**\n- File: \`${reportFilename}\`\n- Location: \`saved_data/Reports/\`\n- Full analysis with charts, data, and investment recommendations`;

                let executiveSummaryForUi: string | undefined;
                for (const r of [...(result.actionResults || [])].reverse()) {
                    const md = (r.content as { metadata?: { phase?: string; executiveSummary?: unknown } })
                        ?.metadata;
                    if (
                        md?.phase === "writing_report" &&
                        typeof md.executiveSummary === "string" &&
                        md.executiveSummary.trim().length > 0
                    ) {
                        executiveSummaryForUi = md.executiveSummary.trim();
                        break;
                    }
                }

                // Did the user's SSE pipe survive long enough to receive the
                // final response? If not, the persisted memory is the only
                // path the result can reach them — tag it so the frontend can
                // surface an "unread" badge on chat history reload.
                // Skipped for scheduler runs (no UI to deliver to anyway).
                const sseAlive = !schedulerRun &&
                    isStreamAliveForRoom(this, String(message.roomId));
                const deliveryStatus: "sse-streamed" | "persisted-only" =
                    sseAlive ? "sse-streamed" : "persisted-only";
                if (!schedulerRun && !sseAlive) {
                    elizaLogger.info(
                        `[Recovery] Comprehensive analysis completed but no live SSE listener for room ${message.roomId}. ` +
                        `Report persisted to DB and S3 — frontend should surface on next chat load. ` +
                        `reportPath=${result.reportPath}`
                    );
                }

                const responseMemory: Memory = {
                    id: uuidv4() as UUID,
                    userId: this.agentId,
                    agentId: this.agentId,
                    roomId: message.roomId,
                    createdAt: Date.now(),
                    content: {
                        text: responseText,
                        source: 'comprehensive_analysis',
                        metadata: {
                            reportPath: result.reportPath,
                            relativePath: relative(process.cwd(), result.reportPath),
                            actionResults: result.actionResults,
                            chartPaths: result.actionResults?.filter(r => (r.content as any).metadata?.chartPath).map(r => (r.content as any).metadata.chartPath) || [],
                            target: (result as any).metadata?.target,
                            cryptoName: (result as any).metadata?.cryptoName,
                            phase: 'writing_report',
                            success: true,
                            actionName: 'Report Generation Complete',
                            // Add comprehensive analysis snapshot for historical tab display
                            comprehensiveSnapshot: generateComprehensiveAnalysisSnapshot(result.actionResults || []),
                            // Delivery hint for the frontend: when the SSE was
                            // alive at completion this is "sse-streamed"; when
                            // the user already disconnected, "persisted-only".
                            // Frontends should render an unread indicator in
                            // the latter case so finished reports don't go
                            // unnoticed.
                            deliveryStatus,
                            completedAt: Date.now(),
                            ...(executiveSummaryForUi ? { executiveSummary: executiveSummaryForUi } : {}),
                        }
                    }
                };

                if (!schedulerRun) {
                    await this.messageManager.createMemory(responseMemory);

                    if (callback) {
                        await callback(responseMemory.content);
                    }

                    if (intermediateResponseCallback) {
                        intermediateResponseCallback(responseMemory);
                    }
                }

                elizaLogger.success(`[Runtime] Comprehensive analysis completed successfully: ${result.reportPath}`);
                return [responseMemory];
                
            } else {
                // Handle failure case
                const errorMemory: Memory = {
                    id: uuidv4() as UUID,
                    userId: this.agentId,
                    agentId: this.agentId,
                    roomId: message.roomId,
                    createdAt: Date.now(),
                    content: {
                        text: result.error === 'Analysis already in progress'
                            ? `⏳ **Analysis In Progress**

A comprehensive analysis is already running. Please wait for it to complete before starting a new one (usually a few minutes).`
                            : `❌ **Comprehensive Analysis Failed**

I encountered an error: ${result.error}

Please try again later.`,
                        error: {
                            type: "comprehensive_analysis_error",
                            message: result.error || "Unknown error occurred",
                            originalError: result.error
                        }
                    }
                };

                if (!schedulerRun) {
                    await this.messageManager.createMemory(errorMemory);

                    if (callback) {
                        await callback(errorMemory.content);
                    }
                }

                elizaLogger.error(`[Runtime] Comprehensive analysis failed: ${result.error}`);
                
                return [errorMemory];
            }
            
        } catch (error: any) {
            elizaLogger.error(`[Runtime] Comprehensive analysis handler threw exception:`, error);
            
            const errorMemory: Memory = {
                id: uuidv4() as UUID,
                userId: this.agentId,
                agentId: this.agentId,
                roomId: message.roomId,
                createdAt: Date.now(),
                content: {
                    text: `❌ **Critical Error in Comprehensive Analysis**

An unexpected error occurred during comprehensive analysis: ${error.message}

Please try again later or contact support if this issue persists. The comprehensive analysis system encountered an internal error.`,
                    error: {
                        type: "comprehensive_analysis_exception",
                        message: error.message,
                        originalError: error.toString(),
                        stack: error.stack
                    }
                }
            };

            if (!isDailySchedulerMessage(message)) {
                await this.messageManager.createMemory(errorMemory);

                if (callback) {
                    await callback(errorMemory.content);
                }
            }

            elizaLogger.error(`[Runtime] Comprehensive analysis encountered critical error: ${error.message}`);
            return [errorMemory];
        }
    }

    /**
     * Utility method to create and send a message to the AI for processing
     * @param text The text content to send
     * @param userId The ID of the user sending the message
     * @param roomId The ID of the room (conversation)
     * @param callback Optional callback for handling actions
     * @returns The responses generated
     */
    async sendMessage(
        text: string, 
        userId: UUID, 
        roomId: UUID = this.agentId, 
        callback?: HandlerCallback
    ): Promise<Memory[]> {
        // Create the message memory
        const message: Memory = {
            id: uuidv4() as UUID,
            userId,
            agentId: this.agentId,
            roomId,
            createdAt: Date.now(),
            content: {
                text,
            },
        };
        
        // Store the message in the database
        await this.messageManager.createMemory(message);
        
        // Process the message and get AI responses
        return this.handleMessageWithTaskChain(message, callback);
    }


    private formatKnowledge(knowledge: KnowledgeItem[]) {
    // Filter out comprehensive analysis content which is too large for knowledge formatting
    const filteredKnowledge = knowledge.filter(item => {
        const text = item.content.text;
        // Skip other large HTML content
        if (text.includes('<!DOCTYPE html>') || text.length > 10000) {
            return false;
        }
        
        return true;
    });

    // Group related content in a more natural way
    return filteredKnowledge.map(item => {
        // Get the main content text
        const text = item.content.text;

        // Clean up formatting but maintain natural text flow
        const cleanedText = text
            .trim()
            .replace(/\n{3,}/g, '\n\n'); // Replace excessive newlines

        return cleanedText;
    }).join('\n\n'); // Separate distinct pieces with double newlines
  }
}
