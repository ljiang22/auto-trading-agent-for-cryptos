import type {
    Account,
    Actor,
    GoalStatus,
    Goal,
    Memory,
    FavoriteTaskChainRecord,
    FavoriteTaskChainCreateInput,
    SharedTaskChainRecord,
    SharedTaskChainCreateInput,
    SharedChatRecord,
    SharedChatCreateInput,
    Relationship,
    UUID,
    RAGKnowledgeItem,
    Participant,
    IDatabaseAdapter,
    CachedActionResult,
    ExchangeRegistryEntry,
} from "../core/types.ts";
import { CircuitBreaker } from "../database/CircuitBreaker.ts";
import { elizaLogger } from "../utils/logger.ts";

/**
 * An abstract class representing a database adapter for managing various entities
 * like accounts, memories, actors, goals, and rooms.
 */
export abstract class DatabaseAdapter<DB = any> implements IDatabaseAdapter {
    /**
     * The database instance.
     */
    db: DB;

    /**
     * Circuit breaker instance used to handle fault tolerance and prevent cascading failures.
     * Implements the Circuit Breaker pattern to temporarily disable operations when a failure threshold is reached.
     *
     * The circuit breaker has three states:
     * - CLOSED: Normal operation, requests pass through
     * - OPEN: Failure threshold exceeded, requests are blocked
     * - HALF_OPEN: Testing if service has recovered
     *
     * @protected
     */
    protected circuitBreaker: CircuitBreaker;

    /**
     * Creates a new DatabaseAdapter instance with optional circuit breaker configuration.
     *
     * @param circuitBreakerConfig - Configuration options for the circuit breaker
     * @param circuitBreakerConfig.failureThreshold - Number of failures before circuit opens (defaults to 5)
     * @param circuitBreakerConfig.resetTimeout - Time in ms before attempting to close circuit (defaults to 60000)
     * @param circuitBreakerConfig.halfOpenMaxAttempts - Number of successful attempts needed to close circuit (defaults to 3)
     */
    constructor(circuitBreakerConfig?: {
        failureThreshold?: number;
        resetTimeout?: number;
        halfOpenMaxAttempts?: number;
    }) {
        this.circuitBreaker = new CircuitBreaker(circuitBreakerConfig);
    }

    /**
     * Optional initialization method for the database adapter.
     * @returns A Promise that resolves when initialization is complete.
     */
    abstract init(): Promise<void>;

    /**
     * Optional close method for the database adapter.
     * @returns A Promise that resolves when closing is complete.
     */
    abstract close(): Promise<void>;

    /**
     * Retrieves an account by its ID.
     * @param userId The UUID of the user account to retrieve.
     * @returns A Promise that resolves to the Account object or null if not found.
     */
    abstract getAccountById(userId: UUID): Promise<Account | null>;

    /**
     * Retrieves an account by email.
     * @param email The account email to retrieve.
     * @returns A Promise that resolves to the Account object or null if not found.
     */
    abstract getAccountByEmail(email: string): Promise<Account | null>;

    /**
     * Get all configured CEX exchanges from the canonical registry.
     */
    abstract getExchangeRegistry(): Promise<ExchangeRegistryEntry[]>;

    /**
     * Get a single exchange registry entry by id, or null if unsupported.
     */
    abstract getExchangeRegistryEntry(id: string): Promise<ExchangeRegistryEntry | null>;

    /**
     * Merge duplicate accounts for a given email.
     * If provided, adapters may prefer `preferredPrimaryId` as the canonical account id.
     * Default implementation is a no-op for adapters that don't support it.
     */
    async mergeDuplicateAccountsByEmail(
        _email: string,
        _preferredPrimaryId?: UUID
    ): Promise<{
        primaryId: UUID | null;
        mergedIds: UUID[];
    }> {
        return { primaryId: null, mergedIds: [] };
    }

    /**
     * Get or create a referral code for a user.
     */
    abstract getOrCreateReferralCode(userId: UUID): Promise<string>;

    /**
     * Get user ID by referral code.
     */
    abstract getUserIdByReferralCode(code: string): Promise<UUID | null>;

    /**
     * Validate whether a referral code exists.
     */
    abstract validateReferralCode(code: string): Promise<boolean>;

    /**
     * Create a referral relationship.
     */
    abstract createReferral(params: {
        referredUserId: UUID;
        referralCode: string;
    }): Promise<boolean>;

    /**
     * Get the referrer for a user.
     */
    abstract getReferrerByUserId(userId: UUID): Promise<UUID | null>;

    /**
     * Get all users referred by a referrer.
     */
    abstract getReferredUsers(referrerId: UUID): Promise<Array<{
        userId: UUID;
        email: string;
        createdAt: number;
    }>>;

    /**
     * Record the referral code used by a user during registration.
     */
    abstract recordUserReferralCode(params: {
        userId: UUID;
        referralCodeUsed: string;
        isMatched: boolean;
    }): Promise<boolean>;

    /**
     * Get the referral code used by a user during registration.
     */
    abstract getUserReferralCode(userId: UUID): Promise<{
        referralCodeUsed: string;
        isMatched: boolean;
        createdAt: number;
    } | null>;

    /**
     * Get referral statistics for a referrer.
     */
    abstract getReferralStats(referrerId: UUID): Promise<{
        totalReferrals: number;
        activeSubscriptions: number;
        totalRevenue: number;
        currency: string;
    }>;

    /**
     * Record a resolved subscription tier snapshot for a user.
     * Writes only when the tier changed from the latest recorded value.
     */
    abstract recordSubscriptionTierChange(params: {
        userId: UUID;
        tier: "free" | "plus" | "pro" | "enterprise";
        source?: string;
        observedAt?: number;
    }): Promise<boolean>;

    /**
     * Record a subscription event from Stripe webhook.
     */
    abstract recordSubscriptionEvent(params: {
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

    /**
     * Update a user's current subscription status.
     */
    abstract updateUserSubscription(params: {
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

    /**
     * Get a user's current subscription.
     */
    abstract getUserSubscription(userId: UUID): Promise<{
        subscriptionStatus: string;
        planName: string | null;
        currentPeriodEnd: number | null;
    } | null>;

    /**
     * Get subscription events for a user.
     */
    abstract getSubscriptionEvents(
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

    /**
     * Get user by Stripe customer ID.
     */
    abstract getUserByStripeCustomerId(stripeCustomerId: string): Promise<{
        userId: UUID;
    } | null>;

    /**
     * Creates a new account in the database.
     * @param account The account object to create.
     * @returns A Promise that resolves when the account creation is complete.
     */
    abstract createAccount(account: Account): Promise<boolean>;

    /**
     * Updates the JSON details blob for an account.
     * @param params Object containing the userId and merged details.
     */
    abstract updateAccountDetails(params: {
        userId: UUID;
        details: Record<string, any>;
    }): Promise<void>;

    /**
     * Retrieves memories based on the specified parameters.
     * @param params An object containing parameters for the memory retrieval.
     * @returns A Promise that resolves to an array of Memory objects.
     */
    abstract getMemories(params: {
        agentId: UUID;
        roomId: UUID;
        count?: number;
        unique?: boolean;
        tableName: string;
    }): Promise<Memory[]>;

    abstract getMemoriesByRoomIds(params: {
        agentId: UUID;
        roomIds: UUID[];
        tableName: string;
        limit?: number;
    }): Promise<Memory[]>;

    /**
     * Fetches recent user-authored messages regardless of room.
     * @param params Object containing the userId/agentId filter, table, and limit.
     */
    abstract getRecentUserMessages(params: {
        userId: UUID;
        agentId: UUID;
        limit: number;
        tableName?: string;
    }): Promise<Memory[]>;

    abstract getMemoryById(id: UUID): Promise<Memory | null>;

    /**
     * Retrieves multiple memories by their IDs
     * @param memoryIds Array of UUIDs of the memories to retrieve
     * @param tableName Optional table name to filter memories by type
     * @returns Promise resolving to array of Memory objects
     */
    abstract getMemoriesByIds(
        memoryIds: UUID[],
        tableName?: string
    ): Promise<Memory[]>;

    // getCachedEmbeddings was removed in April 2026 — its DocumentDB-backed
    // Levenshtein scan was the dominant cost in the streaming hot path and
    // its hit rate on chat traffic was effectively zero. embed() now uses an
    // in-process sha256-keyed LRU. See packages/core/src/ai/embedding.ts.

    /**
     * Logs an event or action with the specified details.
     * @param params An object containing parameters for the log entry.
     * @returns A Promise that resolves when the log entry has been saved.
     */
    abstract log(params: {
        body: { [key: string]: unknown };
        userId: UUID;
        roomId: UUID;
        type: string;
    }): Promise<void>;

    /**
     * Retrieves details of actors in a given room.
     * @param params An object containing the roomId to search for actors.
     * @returns A Promise that resolves to an array of Actor objects.
     */
    abstract getActorDetails(params: { roomId: UUID }): Promise<Actor[]>;

    /**
     * Searches for memories based on embeddings and other specified parameters.
     * @param params An object containing parameters for the memory search.
     * @returns A Promise that resolves to an array of Memory objects.
     */
    abstract searchMemories(params: {
        tableName: string;
        agentId: UUID;
        roomId: UUID;
        embedding: number[];
        match_threshold: number;
        match_count: number;
        unique: boolean;
    }): Promise<Memory[]>;

    /**
     * Updates the status of a specific goal.
     * @param params An object containing the goalId and the new status.
     * @returns A Promise that resolves when the goal status has been updated.
     */
    abstract updateGoalStatus(params: {
        goalId: UUID;
        status: GoalStatus;
    }): Promise<void>;

    /**
     * Searches for memories by embedding and other specified parameters.
     * @param embedding The embedding vector to search with.
     * @param params Additional parameters for the search.
     * @returns A Promise that resolves to an array of Memory objects.
     */
    abstract searchMemoriesByEmbedding(
        embedding: number[],
        params: {
            match_threshold?: number;
            count?: number;
            roomId?: UUID;
            agentId?: UUID;
            unique?: boolean;
            tableName: string;
        }
    ): Promise<Memory[]>;

    /**
     * Creates a new memory in the database.
     * @param memory The memory object to create.
     * @param tableName The table where the memory should be stored.
     * @param unique Indicates if the memory should be unique.
     * @returns A Promise that resolves when the memory has been created.
     */
    abstract createMemory(
        memory: Memory,
        tableName: string,
        unique?: boolean
    ): Promise<void>;

    /**
     * Updates the content payload for an existing memory.
     * @param params.id The UUID of the memory to update.
     * @param params.tableName The table where the memory is stored.
     * @param params.content The new content payload to store.
     */
    abstract updateMemoryContent(params: {
        id: UUID;
        tableName: string;
        content: Memory["content"];
    }): Promise<void>;

    /**
     * Removes a specific memory from the database.
     * @param memoryId The UUID of the memory to remove.
     * @param tableName The table from which the memory should be removed.
     * @returns A Promise that resolves when the memory has been removed.
     */
    abstract removeMemory(memoryId: UUID, tableName: string): Promise<void>;

    /**
     * Removes all memories associated with a specific room.
     * @param roomId The UUID of the room whose memories should be removed.
     * @param tableName The table from which the memories should be removed.
     * @returns A Promise that resolves when all memories have been removed.
     */
    abstract removeAllMemories(roomId: UUID, tableName: string): Promise<void>;

    /**
     * Counts the number of memories in a specific room.
     * @param roomId The UUID of the room for which to count memories.
     * @param unique Specifies whether to count only unique memories.
     * @param tableName Optional table name to count memories from.
     * @returns A Promise that resolves to the number of memories.
     */
    abstract countMemories(
        roomId: UUID,
        unique?: boolean,
        tableName?: string
    ): Promise<number>;

    /**
     * Counts messages authored by a user within an optional time window.
     * @param params.userId The UUID of the user to count messages for.
     * @param params.tableName Optional table name (defaults to "messages").
     * @param params.agentId Optional agent scope filter.
     * @param params.since Optional timestamp (ms) for the earliest message to include.
     */
    abstract countUserMessages(params: {
        userId: UUID;
        tableName?: string;
        agentId?: UUID;
        since?: number;
    }): Promise<number>;

    /**
     * Retrieve all favorite task chains for a user scoped to an agent.
     */
    abstract getFavoriteTaskChains(params: {
        userId: UUID;
        agentId: UUID;
    }): Promise<FavoriteTaskChainRecord[]>;

    /**
     * Retrieve a single favorite task chain by identifier.
     */
    abstract getFavoriteTaskChain(params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
    }): Promise<FavoriteTaskChainRecord | null>;

    /**
     * Retrieve a favorite task chain by its source chain identifier.
     */
    abstract getFavoriteTaskChainByChain(params: {
        chainId: string;
        userId: UUID;
        agentId: UUID;
    }): Promise<FavoriteTaskChainRecord | null>;

    /**
     * Persist a new favorite task chain record.
     */
    abstract createFavoriteTaskChain(
        params: FavoriteTaskChainCreateInput
    ): Promise<FavoriteTaskChainRecord>;

    /**
     * Remove a favorite task chain by id for a user.
     */
    abstract removeFavoriteTaskChain(params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
    }): Promise<void>;

    /**
     * Update favorite task chain metadata such as display name.
     */
    abstract updateFavoriteTaskChainName(params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
        name: string;
    }): Promise<void>;

    /**
     * Toggle visibility of a favorite task chain for trending.
     */
    abstract updateFavoriteTaskChainVisibility(params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
        isPublic: boolean;
    }): Promise<FavoriteTaskChainRecord>;

    /**
     * Update the last-used timestamp for a favorite task chain.
     */
    abstract markFavoriteTaskChainUsed(params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
        timestamp?: number;
    }): Promise<void>;

    /**
     * Retrieve the shared task chain associated with a favorite, if any.
     */
    abstract getSharedTaskChainByFavorite(params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
    }): Promise<SharedTaskChainRecord | null>;

    /**
     * Persist a new shared task chain record.
     */
    abstract createSharedTaskChain(
        params: SharedTaskChainCreateInput
    ): Promise<SharedTaskChainRecord>;

    /**
     * Retrieve a shared task chain by its public share code.
     */
    abstract getSharedTaskChainByCode(
        shareCode: string
    ): Promise<SharedTaskChainRecord | null>;

    /**
     * Retrieve the shared chat associated with a room, if any.
     */
    abstract getSharedChatByRoom(params: {
        agentId: UUID;
        roomId: UUID;
    }): Promise<SharedChatRecord | null>;

    /**
     * Persist a new shared chat record.
     */
    abstract createSharedChat(
        params: SharedChatCreateInput
    ): Promise<SharedChatRecord>;

    /**
     * Retrieve a shared chat by its public share code.
     */
    abstract getSharedChatByCode(
        shareCode: string
    ): Promise<SharedChatRecord | null>;

    /**
     * Get trending task chains by total execution count.
     * Returns the most executed task chains across all users for a given agent.
     */
    abstract getTrendingTaskChains(params: {
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

    /**
     * Retrieves goals based on specified parameters.
     * @param params An object containing parameters for goal retrieval.
     * @returns A Promise that resolves to an array of Goal objects.
     */
    abstract getGoals(params: {
        agentId: UUID;
        roomId: UUID;
        userId?: UUID | null;
        onlyInProgress?: boolean;
        count?: number;
    }): Promise<Goal[]>;

    /**
     * Updates a specific goal in the database.
     * @param goal The goal object with updated properties.
     * @returns A Promise that resolves when the goal has been updated.
     */
    abstract updateGoal(goal: Goal): Promise<void>;

    /**
     * Creates a new goal in the database.
     * @param goal The goal object to create.
     * @returns A Promise that resolves when the goal has been created.
     */
    abstract createGoal(goal: Goal): Promise<void>;

    /**
     * Removes a specific goal from the database.
     * @param goalId The UUID of the goal to remove.
     * @returns A Promise that resolves when the goal has been removed.
     */
    abstract removeGoal(goalId: UUID): Promise<void>;

    /**
     * Removes all goals associated with a specific room.
     * @param roomId The UUID of the room whose goals should be removed.
     * @returns A Promise that resolves when all goals have been removed.
     */
    abstract removeAllGoals(roomId: UUID): Promise<void>;

    /**
     * Retrieves the room ID for a given room, if it exists.
     * @param roomId The UUID of the room to retrieve.
     * @returns A Promise that resolves to the room ID or null if not found.
     */
    abstract getRoom(roomId: UUID): Promise<UUID | null>;

    /**
     * Creates a new room with an optional specified ID and name.
     * @param roomId Optional UUID to assign to the new room.
     * @param name Optional name for the room.
     * @returns A Promise that resolves to the UUID of the created room.
     */
    abstract createRoom(roomId?: UUID, name?: string): Promise<UUID>;

    /**
     * Retrieves room details by room ID.
     * @param roomId The UUID of the room to retrieve.
     * @returns A Promise that resolves to room details or null if not found.
     */
    abstract getRoomById(roomId: UUID): Promise<{ id: UUID; name?: string; createdAt: string } | null>;

    /**
     * Removes all memories associated with a specific room, regardless of memory type.
     * @param roomId The UUID of the room whose memories should be removed.
     * @returns A Promise that resolves when all memories have been removed.
     */
    abstract removeAllMemoriesByRoom(roomId: UUID): Promise<void>;

    /**
     * Removes all logs associated with a specific room.
     * @param roomId The UUID of the room whose logs should be removed.
     * @returns A Promise that resolves when all logs have been removed.
     */
    abstract removeLogsByRoom(roomId: UUID): Promise<void>;

    /**
     * Removes a specific room from the database.
     * @param roomId The UUID of the room to remove.
     * @returns A Promise that resolves when the room has been removed.
     */
    abstract removeRoom(roomId: UUID): Promise<void>;

    /**
     * Updates the name of a specific room.
     * @param roomId The UUID of the room to update.
     * @param name The new name for the room.
     * @returns A Promise that resolves when the room name has been updated.
     */
    abstract updateRoomName(roomId: UUID, name: string): Promise<void>;

    /**
     * Removes all participants from a specific room.
     * @param roomId The UUID of the room whose participants should be removed.
     * @returns A Promise that resolves when all participants have been removed.
     */
    abstract removeParticipantsByRoom(roomId: UUID): Promise<void>;

    /**
     * Retrieves room IDs for which a specific user is a participant.
     * @param userId The UUID of the user.
     * @returns A Promise that resolves to an array of room IDs.
     */
    abstract getRoomsForParticipant(userId: UUID): Promise<UUID[]>;

    /**
     * Retrieves room IDs for which specific users are participants.
     * @param userIds An array of UUIDs of the users.
     * @returns A Promise that resolves to an array of room IDs.
     */
    abstract getRoomsForParticipants(userIds: UUID[]): Promise<UUID[]>;

    /**
     * Adds a user as a participant to a specific room.
     * @param userId The UUID of the user to add as a participant.
     * @param roomId The UUID of the room to which the user will be added.
     * @returns A Promise that resolves to a boolean indicating success or failure.
     */
    abstract addParticipant(userId: UUID, roomId: UUID): Promise<boolean>;

    /**
     * Removes a user as a participant from a specific room.
     * @param userId The UUID of the user to remove as a participant.
     * @param roomId The UUID of the room from which the user will be removed.
     * @returns A Promise that resolves to a boolean indicating success or failure.
     */
    abstract removeParticipant(userId: UUID, roomId: UUID): Promise<boolean>;

    /**
     * Retrieves participants associated with a specific account.
     * @param userId The UUID of the account.
     * @returns A Promise that resolves to an array of Participant objects.
     */
    abstract getParticipantsForAccount(userId: UUID): Promise<Participant[]>;

    /**
     * Retrieves participants associated with a specific account.
     * @param userId The UUID of the account.
     * @returns A Promise that resolves to an array of Participant objects.
     */
    abstract getParticipantsForAccount(userId: UUID): Promise<Participant[]>;

    /**
     * Retrieves participants for a specific room.
     * @param roomId The UUID of the room for which to retrieve participants.
     * @returns A Promise that resolves to an array of UUIDs representing the participants.
     */
    abstract getParticipantsForRoom(roomId: UUID): Promise<UUID[]>;

    abstract getParticipantUserState(
        roomId: UUID,
        userId: UUID
    ): Promise<"FOLLOWED" | "MUTED" | null>;
    abstract setParticipantUserState(
        roomId: UUID,
        userId: UUID,
        state: "FOLLOWED" | "MUTED" | null
    ): Promise<void>;

    /**
     * Creates a new relationship between two users.
     * @param params An object containing the UUIDs of the two users (userA and userB).
     * @returns A Promise that resolves to a boolean indicating success or failure of the creation.
     */
    abstract createRelationship(params: {
        userA: UUID;
        userB: UUID;
    }): Promise<boolean>;

    /**
     * Retrieves a relationship between two users if it exists.
     * @param params An object containing the UUIDs of the two users (userA and userB).
     * @returns A Promise that resolves to the Relationship object or null if not found.
     */
    abstract getRelationship(params: {
        userA: UUID;
        userB: UUID;
    }): Promise<Relationship | null>;

    /**
     * Retrieves all relationships for a specific user.
     * @param params An object containing the UUID of the user.
     * @returns A Promise that resolves to an array of Relationship objects.
     */
    abstract getRelationships(params: {
        userId: UUID;
    }): Promise<Relationship[]>;

    /**
     * Retrieves knowledge items based on specified parameters.
     * @param params Object containing search parameters
     * @returns Promise resolving to array of knowledge items
     */
    abstract getKnowledge(params: {
        id?: UUID;
        agentId: UUID;
        limit?: number;
        query?: string;
        conversationContext?: string;
    }): Promise<RAGKnowledgeItem[]>;

    abstract searchKnowledge(params: {
        agentId: UUID;
        embedding: Float32Array;
        match_threshold: number;
        match_count: number;
        searchText?: string;
    }): Promise<RAGKnowledgeItem[]>;

    /**
     * Creates a new knowledge item in the database.
     * @param knowledge The knowledge item to create
     * @returns Promise resolving when creation is complete
     */
    abstract createKnowledge(knowledge: RAGKnowledgeItem): Promise<void>;

    /**
     * Removes a knowledge item and its associated chunks from the database.
     * @param id The ID of the knowledge item to remove
     * @returns Promise resolving when removal is complete
     */
    abstract removeKnowledge(id: UUID): Promise<void>;

    /**
     * Removes an agents full knowledge database and its associated chunks from the database.
     * @param agentId The Agent ID of the knowledge items to remove
     * @returns Promise resolving when removal is complete
     */
    abstract clearKnowledge(agentId: UUID, shared?: boolean): Promise<void>;

    /**
     * Searches for cached action results based on embedding similarity.
     * @param params Search parameters including embedding, action name, similarity threshold, and limit
     * @returns Promise resolving to array of cached action results
     */
    abstract searchActionCache(params: {
        queryEmbedding: number[];
        actionName?: string;
        similarityThreshold: number;
        querySimilarityThreshold: number;
        limit: number;
    }): Promise<CachedActionResult[]>;

    /**
     * Creates a new action cache entry.
     * @param params Cache entry parameters
     * @returns Promise resolving when creation is complete
     */
    abstract createActionCache(params: {
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

    /**
     * Increments the hit count for cached action results.
     * @param ids Array of cache entry IDs to increment
     * @returns Promise resolving when increment is complete
     */
    abstract incrementActionCacheHitCount(ids: UUID[]): Promise<void>;

    /**
     * Removes expired action cache entries.
     * @returns Promise resolving to the number of entries removed
     */
    abstract cleanupExpiredActionCache(): Promise<number>;

    /**
     * Retrieves statistics about the action cache.
     * @returns Promise resolving to cache statistics
     */
    abstract getActionCacheStats(): Promise<{
        totalEntries: number;
        totalHits: number;
        actionBreakdown: Record<string, number>;
    }>;

    /**
     * Executes an operation with circuit breaker protection.
     * @param operation A function that returns a Promise to be executed with circuit breaker protection
     * @param context A string describing the context/operation being performed for logging purposes
     * @returns A Promise that resolves to the result of the operation
     * @throws Will throw an error if the circuit breaker is open or if the operation fails
     * @protected
     */
    protected async withCircuitBreaker<T>(
        operation: () => Promise<T>,
        context: string
    ): Promise<T> {
        try {
            return await this.circuitBreaker.execute(operation);
        } catch (error) {
            elizaLogger.error(`Circuit breaker error in ${context}:`, {
                error: error instanceof Error ? error.message : String(error),
                state: this.circuitBreaker.getState(),
            });
            throw error;
        }
    }

    /**
     * Saves token usage data to the database for quota tracking.
     * @param params Token usage parameters including userId, tokens, and metadata
     * @returns A Promise that resolves when the save is complete
     */
    abstract saveTokenUsage(params: {
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

    /**
     * Retrieves aggregated token usage for a user within a time window.
     * @param params Parameters including userId and time range
     * @returns A Promise resolving to aggregated token counts
     */
    abstract getUserTokenUsage(params: {
        userId: string;
        since: number;
        until?: number;
    }): Promise<{
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
    }>;

    /**
     * Gets the timestamp of the user's first token usage.
     * Used to calculate rolling window start dates.
     * @param params Parameters including userId
     * @returns A Promise resolving to the timestamp or null if no usage exists
     */
    abstract getUserFirstTokenUsageTimestamp(params: {
        userId: string;
    }): Promise<number | null>;

    /**
     * Cleans up old token usage records older than the specified timestamp.
     * @param olderThan Timestamp threshold - records older than this will be deleted
     * @returns A Promise resolving to the number of deleted records
     */
    abstract cleanupOldTokenUsage(olderThan: number): Promise<number>;
}
