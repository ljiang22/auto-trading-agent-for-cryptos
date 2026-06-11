/**
 * UserFeatureManager - Manages user feature profiles as Memory objects
 *
 * Stores user profiles (personalInfo, investmentPreferences, cautionaryNotes) as memories
 * with vector embeddings for semantic search. Supports version history tracking.
 */

import { generateText } from "../ai/generation.ts";
import { embed, getEmbeddingZeroVector } from "../ai/embedding.ts";
import { parseJSONObjectFromText } from "../validation/parsing.ts";
import elizaLogger from "../utils/logger.ts";
import type {
    IAgentRuntime,
    IUserFeatureManager,
    Memory,
    UserFeatureAspect,
    UUID,
} from "../core/types.ts";
import { ModelClass } from "../core/types.ts";
import { v4 as uuidv4 } from "uuid";
import { classifyPromptInjection } from "../utils/promptInjectionDefense.ts";

const USER_FEATURE_METADATA_FLAG = "userFeatureProfileProcessed";
const SECTION_CHAR_LIMIT = 200;

/**
 * F2 — Safety-bypass phrase blocklist. Applied AFTER aspect derivation
 * (against the derived aspect's name + content), NOT against the source
 * message — that way a benign user saying "I'd like to ignore low-volume
 * hours" isn't punished. If an aspect matches, it is silently skipped
 * from the batch (the rest of the batch still ships).
 */
const ASPECT_SAFETY_BYPASS_PATTERNS: RegExp[] = [
    /\b(?:bypass|ignore|disable|override|skip)\b.*\b(?:risk|safety|gate|engine|check|limit|guard|protection)\b/i,
    /\b(?:forget|disregard|drop)\b.*\b(?:instruction|rule|prompt|directive|policy)\b/i,
    /\b(?:jailbreak|developer\s*mode|sudo|root\s*access)\b/i,
    /\b(?:willing\s+to\s+(?:bypass|ignore|disable|disregard))\b/i,
];

/**
 * F2 — Trading / risk keywords used to mark derived aspects as
 * `consentRequired`. If ANY source message in the batch mentions one of
 * these, ALL aspects derived from that batch are gated behind explicit
 * Settings opt-in. Conservative on purpose; the user can always opt in.
 */
const RISK_KEYWORD_RE =
    /\b(buy|sell|leverage|margin|stop\s*loss|short\s+sell|liquidat|long\s+position|short\s+position|borrow|isolated|cross\s+margin)\b/i;

/**
 * Manages user feature profiles as part of the memory system
 */
export class UserFeatureManager implements IUserFeatureManager {
    runtime: IAgentRuntime;
    tableName: string;
    private readonly batchSize = 5;
    private readonly SECTION_CHAR_LIMIT = SECTION_CHAR_LIMIT;

    constructor(opts: { runtime: IAgentRuntime }) {
        this.runtime = opts.runtime;
        this.tableName = "user_features";
    }

    // ============================================================================
    // IMemoryManager Interface Methods
    // ============================================================================

    /**
     * Add embedding to a user feature memory
     */
    async addEmbeddingToMemory(memory: Memory): Promise<Memory> {
        if (memory.embedding) {
            return memory; // Already has embedding
        }

        // Use text from memory content (already set by createAspectMemory)
        const embeddingText = memory.content.text;

        if (!embeddingText || embeddingText.trim().length === 0) {
            elizaLogger.warn(
                "[UserFeatureManager] Cannot generate embedding: empty text"
            );
            memory.embedding = getEmbeddingZeroVector().slice();
            return memory;
        }

        try {
            memory.embedding = await embed(this.runtime, embeddingText);
        } catch (error) {
            elizaLogger.error(
                "[UserFeatureManager] Failed to generate embedding:",
                error
            );
            memory.embedding = getEmbeddingZeroVector().slice();
        }

        return memory;
    }

    /**
     * Get memories (user feature profiles) with optional filters
     */
    async getMemories(opts: {
        roomId: UUID;
        count?: number;
        unique?: boolean;
        start?: number;
        end?: number;
    }): Promise<Memory[]> {
        return this.runtime.databaseAdapter.getMemories({
            ...opts,
            tableName: this.tableName,
            agentId: this.runtime.agentId,
        });
    }

    async updateMemoryContent(memoryId: UUID, content: Memory["content"]): Promise<void> {
        await this.runtime.databaseAdapter.updateMemoryContent({
            id: memoryId,
            tableName: this.tableName,
            content
        });
    }

    /**
     * Search user feature profiles by embedding similarity
     */
    async searchMemoriesByEmbedding(
        embedding: number[],
        opts: {
            match_threshold?: number;
            count?: number;
            roomId?: UUID;
            unique?: boolean;
            agentId?: UUID;
        }
    ): Promise<Memory[]> {
        const {
            match_threshold = 0.1,
            count = 10,
            roomId,
            unique,
            agentId,
        } = opts;

        return this.runtime.databaseAdapter.searchMemoriesByEmbedding(
            embedding,
            {
                match_threshold,
                count,
                roomId,
                unique,
                tableName: this.tableName,
                agentId: agentId || this.runtime.agentId,
            }
        );
    }

    /**
     * Get user feature memories by IDs
     */
    async getMemoriesByIds(ids: UUID[]): Promise<Memory[]> {
        if (ids.length === 0) return [];

        return this.runtime.databaseAdapter.getMemoriesByIds(ids, this.tableName);
    }

    /**
     * Get a single user feature memory by ID
     */
    async getMemoryById(id: UUID): Promise<Memory | null> {
        const memories = await this.getMemoriesByIds([id]);
        return memories.length > 0 ? memories[0] : null;
    }

    /**
     * Get user feature memories by room IDs
     */
    async getMemoriesByRoomIds(params: {
        roomIds: UUID[];
        limit?: number;
    }): Promise<Memory[]> {
        return this.runtime.databaseAdapter.getMemoriesByRoomIds({
            ...params,
            tableName: this.tableName,
            agentId: this.runtime.agentId,
        });
    }

    /**
     * Create a new user feature memory
     */
    async createMemory(memory: Memory, unique = true): Promise<void> {
        // Check if memory with this ID already exists
        const existing = await this.getMemoryById(memory.id as UUID);
        if (existing) {
            elizaLogger.warn(
                `[UserFeatureManager] Memory with ID ${memory.id} already exists, skipping creation`
            );
            return;
        }

        await this.runtime.databaseAdapter.createMemory(
            memory,
            this.tableName,
            unique
        );

        elizaLogger.info(
            `[UserFeatureManager] Created user feature profile for user ${memory.userId}, version at ${new Date(memory.createdAt!).toISOString()}`
        );
    }

    /**
     * Remove a user feature memory by ID
     */
    async removeMemory(memoryId: UUID): Promise<void> {
        await this.runtime.databaseAdapter.removeMemory(
            memoryId,
            this.tableName
        );
    }

    /**
     * Remove all user feature memories for a room (user)
     */
    async removeAllMemories(roomId: UUID): Promise<void> {
        await this.runtime.databaseAdapter.removeAllMemories(
            roomId,
            this.tableName
        );
    }

    /**
     * Count user feature memories for a room (user)
     */
    async countMemories(roomId: UUID, unique = true): Promise<number> {
        return this.runtime.databaseAdapter.countMemories(
            roomId,
            unique,
            this.tableName
        );
    }

    // ============================================================================
    // User Feature Specific Methods
    // ============================================================================

    /**
     * Process a message to potentially generate/update user feature profile
     * Triggers every 5 user messages
     */
    async processMessage(message: Memory): Promise<void> {
        if (!this.shouldProcess(message)) {
            return;
        }

        if (this.isMessageProcessed(message)) {
            return;
        }
        this.markMessageProcessed(message);

        try {
            // Count total messages from this user (across all rooms)
            const totalMessages =
                await this.runtime.databaseAdapter.countUserMessages({
                    userId: message.userId,
                    tableName: this.runtime.messageManager.tableName,
                    agentId: this.runtime.agentId,
                });

            // Trigger batch processing every 5 messages
            if (
                totalMessages === 0 ||
                totalMessages % this.batchSize !== 0
            ) {
                return;
            }

            // Get existing aspects
            const existingAspects = await this.getAllUserAspects(
                message.userId
            );

            // Determine how many messages to fetch
            let messagesToFetch: number;
            if (existingAspects.length > 0) {
                // Aspects exist - only fetch recent batch for refinement (LLM also receives previous aspects)
                messagesToFetch = this.batchSize;
            } else {
                // No aspects yet - fetch all history for initial aspect generation
                // Cap at 50 messages to avoid excessive token usage
                messagesToFetch = Math.min(totalMessages, 50);
                elizaLogger.info(
                    `[UserFeatureManager] First-time aspect generation for user ${message.userId}, fetching ${messagesToFetch} historical messages`
                );
            }

            // Fetch recent messages
            const recentMessagesRaw =
                await this.runtime.databaseAdapter.getRecentUserMessages({
                    userId: message.userId,
                    agentId: this.runtime.agentId,
                    limit: messagesToFetch,
                    tableName: this.runtime.messageManager.tableName,
                });

            // F2 — exclude messages that the prompt-injection classifier
            // flagged (`downgrade` or `refuse` verdicts) or that were
            // already tagged `promptInjectionDowngrade=true` by a handler.
            // Without this filter a single adversarial line could mint a
            // permanent durable trait (QA C2: "Willing to bypass risk
            // engine"). The classifier is the same `classifyPromptInjection`
            // imported from utils/promptInjectionDefense; no second LLM pass.
            const recentMessages = recentMessagesRaw.filter((m) => {
                try {
                    const meta = (m.content?.metadata ?? {}) as Record<string, unknown>;
                    if (meta.promptInjectionDowngrade === true) {
                        return false;
                    }
                    const txt = typeof m.content?.text === "string" ? m.content.text : "";
                    if (!txt) return true;
                    const verdict = classifyPromptInjection(txt).verdict;
                    return verdict === "allow";
                } catch {
                    return true;
                }
            });
            if (recentMessages.length < recentMessagesRaw.length) {
                elizaLogger.info(
                    `[UserFeatureManager] F2 prompt-injection filter dropped ${
                        recentMessagesRaw.length - recentMessages.length
                    } of ${recentMessagesRaw.length} messages before aspect derivation`,
                );
            }

            if (recentMessages.length < this.batchSize && existingAspects.length > 0) {
                // Should be rare but avoid sending partial context for updates
                elizaLogger.debug(
                    `[UserFeatureManager] Skipping aspect update; expected at least ${this.batchSize} user messages but found ${recentMessages.length}`
                );
                return;
            }

            // F2 — if the (post-filter) batch is empty, nothing to derive.
            if (recentMessages.length === 0) {
                elizaLogger.debug(
                    `[UserFeatureManager] F2 skipping derivation: all ${recentMessagesRaw.length} candidate messages were filtered`,
                );
                return;
            }

            // F2 — pre-compute the consentRequired flag from raw message
            // content. If ANY message mentions risk keywords, every aspect
            // derived from this batch is gated until the user opts in via
            // Settings. Conservative; legitimate trading users can approve.
            const consentRequired = recentMessages.some((m) =>
                RISK_KEYWORD_RE.test(typeof m.content?.text === "string" ? m.content.text : ""),
            );

            // Generate aspects via LLM
            const prompt = this.buildDynamicAspectPrompt(
                existingAspects.length > 0 ? existingAspects : null,
                recentMessages
            );

            const llmResponse = await generateText({
                runtime: this.runtime,
                prompt: prompt,
                modelClass: ModelClass.SMALL,
            });

            // Parse LLM response
            const parsed = parseJSONObjectFromText(llmResponse);
            if (!parsed) {
                elizaLogger.warn(
                    "[UserFeatureManager] Failed to parse aspect generation response",
                    { llmResponse }
                );
                return;
            }

            // Validate aspects
            const validation = this.validateAspectResponse(parsed);
            if (!validation.valid || !validation.aspects) {
                elizaLogger.warn(
                    "[UserFeatureManager] Aspect validation failed",
                    { errors: validation.errors }
                );
                return;
            }

            // F2 — propagate the per-batch consentRequired flag onto every
            // derived aspect. The render path (`formatUserTraitsForContext`)
            // filters out aspects whose `consentRequired === true && userConsent !== "approved"`
            // so a single trading-message batch can't silently poison the
            // injected prompt.
            const validAspects = validation.aspects.map((a) => ({
                ...a,
                consentRequired,
                userConsent: consentRequired ? ("pending" as const) : ("approved" as const),
            }));

            if (validAspects.length === 0) {
                elizaLogger.info(
                    `[UserFeatureManager] F2 all aspects rejected by safety-bypass blocklist; batch produced 0 stored aspects`,
                );
                return;
            }

            // Calculate version number
            const currentVersion = existingAspects.length > 0
                ? Math.max(...existingAspects.map(a => a.version))
                : 0;
            const newVersion = currentVersion + 1;

            // Store aspects
            await this.storeAspects(
                message.userId,
                validAspects,
                {
                    messagesAnalyzed: recentMessages.length,
                    updateReason: existingAspects.length > 0 ? "batch_update" : "initial",
                    version: newVersion
                }
            );

            elizaLogger.info(
                `[UserFeatureManager] Stored ${validAspects.length} aspects for ${message.userId} after ${totalMessages} user messages (version ${newVersion})`
            );
        } catch (error) {
            elizaLogger.error(
                "[UserFeatureManager] Failed to build user feature profile",
                error
            );
        }
    }

    /**
     * Format user traits for LLM context with semantic search support
     * Replaces buildUserTraitsContext() from Runtime
     */
    async formatUserTraitsForContext(
        userId?: UUID,
        options: {
            queryMessage?: string;
            topN?: number;
            similarityThreshold?: number;
            fallbackToAll?: boolean;
        } = {}
    ): Promise<string> {
        if (!userId || userId === this.runtime.agentId) {
            return "";
        }

        try {
            let aspects: UserFeatureAspect[];

            // If query message provided, use semantic search
            if (options.queryMessage && options.queryMessage.trim()) {
                aspects = await this.retrieveRelevantAspects(
                    userId,
                    options.queryMessage,
                    {
                        topN: options.topN,
                        similarityThreshold: options.similarityThreshold
                    }
                );

                // Fallback to all aspects if semantic search returns nothing
                if (aspects.length === 0 && options.fallbackToAll !== false) {
                    elizaLogger.debug(
                        `[UserFeatureManager] Semantic search returned no results, falling back to all aspects`
                    );
                    aspects = await this.getAllUserAspects(userId);
                }
            } else {
                // No query - return all aspects
                aspects = await this.getAllUserAspects(userId);
            }

            // F2 — exclude aspects awaiting consent OR explicitly rejected.
            // `consentRequired` aspects only become injectable after the
            // user clicks Approve in Settings → Inferred Traits.
            const aspectsBeforeConsent = aspects.length;
            aspects = aspects.filter((a) => {
                if (a.userConsent === "rejected") return false;
                if (a.consentRequired === true && a.userConsent !== "approved") return false;
                return true;
            });
            if (aspects.length < aspectsBeforeConsent) {
                elizaLogger.debug(
                    `[UserFeatureManager] F2 consent filter hid ${
                        aspectsBeforeConsent - aspects.length
                    } pending aspect(s) for user ${userId}`,
                );
            }

            if (aspects.length === 0) {
                return "";
            }

            const selectedAspectLog = aspects
                .map(a => `${a.name}${typeof a.version === "number" ? ` (v${a.version})` : ""}: ${this.truncate(a.content, 80)}`)
                .join("; ");
            elizaLogger.info(
                `[UserFeatureManager] Injecting ${aspects.length} user feature aspect(s) for user ${userId}: ${selectedAspectLog}`
            );

            // Format aspects as bulleted list
            const aspectLines = aspects.map(aspect =>
                `- **${aspect.name}**: ${aspect.content}`
            ).join('\n');

            // Get version info for timestamp
            const latestVersion = Math.max(...aspects.map(a => a.version));
            const latestAspect = aspects.find(a => a.version === latestVersion);
            const updatedAt = latestAspect?.generatedAt
                ? new Date(latestAspect.generatedAt).toLocaleString("en-US", {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit"
                })
                : "Unknown";

            return `# User Profile (${aspects.length} relevant aspect${aspects.length !== 1 ? 's' : ''})\n${aspectLines}\n*Last updated: ${updatedAt}, Profile version: ${latestVersion}*`;

        } catch (error) {
            elizaLogger.warn(
                "[UserFeatureManager] Failed to format user traits",
                error
            );
            return "";
        }
    }

    // ============================================================================
    // Helper Methods (Private)
    // ============================================================================

    /**
     * Check if message should be processed
     */
    private shouldProcess(message: Memory): boolean {
        return Boolean(
            message?.userId &&
                this.runtime?.agentId &&
                message.userId !== this.runtime.agentId
        );
    }

    /**
     * Get metadata object from message
     */
    private getMetadata(message: Memory): Record<string, unknown> {
        const content = message.content ?? { text: "" };
        if (
            !content.metadata ||
            typeof content.metadata !== "object" ||
            Array.isArray(content.metadata)
        ) {
            content.metadata = {};
        }
        return content.metadata as Record<string, unknown>;
    }

    /**
     * Check if message has already been processed
     */
    private isMessageProcessed(message: Memory): boolean {
        const metadata = this.getMetadata(message);
        return metadata[USER_FEATURE_METADATA_FLAG] === true;
    }

    /**
     * Mark message as processed
     */
    private markMessageProcessed(message: Memory): void {
        const metadata = this.getMetadata(message);
        metadata[USER_FEATURE_METADATA_FLAG] = true;
    }

    /**
     * Truncate text to character limit
     */
    private truncate(text: string, limit: number): string {
        if (!text) {
            return "未知";
        }
        if (text.length <= limit) {
            return text;
        }
        return `${text.slice(0, limit - 1).trim()}…`;
    }

    /**
     * Safe string conversion
     */
    private safeString(value: unknown): string {
        if (typeof value === "string") {
            return value;
        }
        if (value === null || value === undefined) {
            return "";
        }
        return String(value);
    }

    // ============================================================================
    // Dynamic Aspect System Methods
    // ============================================================================

    /**
     * Build prompt for LLM to generate dynamic aspects
     */
    private buildDynamicAspectPrompt(
        existingAspects: UserFeatureAspect[] | null,
        messages: Memory[]
    ): string {
        const historicalAspects = existingAspects
            ? JSON.stringify(
                  existingAspects.map(a => ({ name: a.name, content: a.content })),
                  null,
                  2
              )
            : "No existing profile";

        const chronologicalMessages = [...messages].reverse();
        const messageBlock = chronologicalMessages
            .map((memory, index) => {
                const timestamp = memory.createdAt
                    ? new Date(memory.createdAt).toISOString()
                    : "Unknown time";
                const text = this.safeString(memory.content?.text);
                return `${index + 1}. (${timestamp}) ${text}`;
            })
            .join("\n");

        return `
You are an intelligent user profiling system. Analyze the user's messages and generate a comprehensive profile consisting of 1-10 free-form aspects that capture their characteristics, preferences, and important information.

**CRITICAL RULES**:
1. Output a JSON object with ONE key: "aspects" (array of aspect objects)
2. Each aspect MUST have exactly two fields: "name" (string) and "content" (string)
3. Generate between 1 and 10 aspects (MAX 10, no more)
4. Each aspect name should be 2-5 words (e.g., "Investment Philosophy", "Risk Tolerance", "Communication Style")
5. Each aspect content should be a concise sentence ≤200 characters
6. Focus on actionable, meaningful information
7. If information is sparse, generate fewer aspects (minimum 1)
8. Avoid duplicating information across aspects
9. DO NOT invent information - only extract from actual messages
10. Use clear, professional English
11. Start from the previous profile and refine it: keep still-valid traits even if not mentioned recently, update or merge traits when new evidence appears, and only drop traits that are contradicted or obsolete

**Aspect Categories to Consider**:
- Personal Information (name, location, background, occupation)
- Investment Preferences (asset types, strategies, timeframes)
- Risk Profile (tolerance, constraints, concerns)
- Communication Style (preferences, formality, frequency)
- Domain Expertise (areas of knowledge, experience level)
- Goals & Objectives (short-term, long-term aspirations)
- Cautionary Notes (warnings, taboos, restrictions)
- Behavioral Patterns (habits, tendencies, biases)

${existingAspects ? `**Previous Profile (treat as the base draft to refine and improve, not replace):**\n${historicalAspects}\n` : ''}

**User Messages (${messages.length} total)**:
${messageBlock}

**Output Format Example**:
{
    "aspects": [
        {
            "name": "Investment Philosophy",
            "content": "Prefers long-term value investing in blue-chip stocks with dividend yields above 3%"
        },
        {
            "name": "Risk Tolerance",
            "content": "Conservative investor avoiding high volatility assets and derivatives"
        }
    ]
}

Generate the profile now (1-10 aspects maximum):
`.trim();
    }

    /**
     * Validate LLM response for aspect generation
     */
    private validateAspectResponse(parsed: any): {
        valid: boolean;
        aspects?: UserFeatureAspect[];
        errors: string[];
    } {
        const errors: string[] = [];

        if (!parsed || typeof parsed !== 'object') {
            errors.push("Response is not a valid JSON object");
            return { valid: false, errors };
        }

        if (!Array.isArray(parsed.aspects)) {
            errors.push("Missing 'aspects' array in response");
            return { valid: false, errors };
        }

        if (parsed.aspects.length === 0) {
            errors.push("Aspects array is empty (minimum 1 required)");
            return { valid: false, errors };
        }

        if (parsed.aspects.length > 10) {
            elizaLogger.warn(
                `[UserFeatureManager] Too many aspects: ${parsed.aspects.length} (maximum 10 allowed), truncating`
            );
            parsed.aspects = parsed.aspects.slice(0, 10);
        }

        const validAspects: UserFeatureAspect[] = [];
        const seenNames = new Set<string>();

        for (let i = 0; i < parsed.aspects.length; i++) {
            const aspect = parsed.aspects[i];

            if (!aspect.name || typeof aspect.name !== 'string') {
                errors.push(`Aspect ${i}: missing or invalid 'name' field`);
                continue;
            }

            if (!aspect.content || typeof aspect.content !== 'string') {
                errors.push(`Aspect ${i}: missing or invalid 'content' field`);
                continue;
            }

            // Deduplicate aspects with same name
            const normalizedName = aspect.name.toLowerCase().trim();
            if (seenNames.has(normalizedName)) {
                elizaLogger.debug(
                    `[UserFeatureManager] Skipping duplicate aspect: ${aspect.name}`
                );
                continue;
            }
            seenNames.add(normalizedName);

            // F2 — reject aspects whose name OR content trips the
            // safety-bypass blocklist. Skip silently and keep the rest of
            // the batch. This is the second layer of defense: the first
            // is the prompt-injection filter on the source messages.
            const combined = `${aspect.name} ${aspect.content}`;
            const bypassHit = ASPECT_SAFETY_BYPASS_PATTERNS.find((re) => re.test(combined));
            if (bypassHit) {
                elizaLogger.info(
                    `[UserFeatureManager] F2 rejected aspect "${aspect.name}" — matched safety-bypass pattern ${bypassHit.toString()}`,
                );
                continue;
            }

            // Normalize and truncate
            const normalizedAspect: UserFeatureAspect = {
                name: this.truncate(aspect.name.trim(), 50),
                content: this.truncate(aspect.content.trim(), 200),
                generatedAt: Date.now(),
                version: 0,  // Set later
                aspectIndex: validAspects.length,
                totalAspects: 0  // Set later
            };

            validAspects.push(normalizedAspect);
        }

        if (validAspects.length === 0) {
            errors.push("No valid aspects after validation");
            return { valid: false, errors };
        }

        // Update totalAspects for all aspects
        for (const aspect of validAspects) {
            aspect.totalAspects = validAspects.length;
        }

        return { valid: true, aspects: validAspects, errors };
    }

    /**
     * Create a Memory object for a single aspect
     */
    private createAspectMemory(
        userId: UUID,
        aspect: UserFeatureAspect,
        metadata: {
            messagesAnalyzed: number;
            updateReason: "initial" | "batch_update";
            version: number;
            aspectSetId: string;
        }
    ): Memory {
        const embeddingText = `${aspect.name}: ${aspect.content}`;

        return {
            id: uuidv4() as UUID,
            userId: userId,
            agentId: this.runtime.agentId,
            roomId: userId,  // Use userId as roomId for user's personal profile space
            createdAt: Date.now(),
            content: {
                text: embeddingText,
                type: "user_feature_aspect",
                userFeatureAspect: aspect,
                metadata: {
                    version: metadata.version,
                    updateReason: metadata.updateReason,
                    messagesAnalyzed: metadata.messagesAnalyzed,
                    aspectSetId: metadata.aspectSetId
                }
            },
            embedding: undefined  // Will be added by addEmbeddingToMemory
        };
    }

    /**
     * Store multiple aspects with individual embeddings
     */
    private async storeAspects(
        userId: UUID,
        aspects: UserFeatureAspect[],
        metadata: {
            messagesAnalyzed: number;
            updateReason: "initial" | "batch_update";
            version: number;
        }
    ): Promise<void> {
        const aspectSetId = uuidv4();

        // Update version for each aspect
        const aspectsWithMetadata = aspects.map((aspect) => ({
            ...aspect,
            version: metadata.version
        }));

        // Create Memory objects for each aspect
        const aspectMemories = aspectsWithMetadata.map(aspect =>
            this.createAspectMemory(userId, aspect, {
                ...metadata,
                aspectSetId
            })
        );

        // Generate embeddings for all aspects in parallel
        const memoriesWithEmbeddings = await Promise.all(
            aspectMemories.map(memory => this.addEmbeddingToMemory(memory))
        );

        // Ensure room exists
        await this.runtime.ensureRoomExists(userId);

        // Replace stored aspects with the newest refined set (previous state is preserved via versioning)
        await this.removeAllMemories(userId);

        // Store all new aspects + emit a structured [UserFeature] audit
        // line per aspect. F2-r3 — completes the audit log surface the
        // plan called for: create / approve / reject / delete. Previously
        // only consent + delete were structured; create was a free-form
        // "Stored N aspects" info line.
        for (const memory of memoriesWithEmbeddings) {
            await this.createMemory(memory, true);
            const aspect = memory.content?.userFeatureAspect;
            if (aspect && typeof aspect === "object") {
                const a = aspect as { name: string; version?: number };
                elizaLogger.info(
                    `[UserFeature] aspect_create userId=${userId} memoryId=${memory.id} ` +
                        `aspect="${a.name}" version=${a.version ?? metadata.version} ` +
                        `updateReason=${metadata.updateReason} source=auto`,
                );
            }
        }

        elizaLogger.info(
            `[UserFeatureManager] Stored ${aspects.length} aspects for user ${userId} (version ${metadata.version})`
        );
    }

    /**
     * Retrieve aspects relevant to current query using semantic search
     */
    async retrieveRelevantAspects(
        userId: UUID,
        queryMessage: string,
        options: {
            topN?: number;
            similarityThreshold?: number;
        } = {}
    ): Promise<UserFeatureAspect[]> {
        if (!userId || userId === this.runtime.agentId) {
            return [];
        }

        const { topN = 5, similarityThreshold = 0.3 } = options;

        try {
            const aspects = await this.getAllUserAspects(userId);
            if (aspects.length === 0) {
                return [];
            }

            const maxResults = Math.min(topN, aspects.length, 5);
            if (maxResults === 0) {
                return [];
            }

            const desiredNameMatches = Math.min(3, maxResults);
            const desiredContentMatches = Math.min(
                2,
                Math.max(maxResults - desiredNameMatches, 0)
            );

            const queryEmbedding = await embed(this.runtime, queryMessage);
            const embeddingCache = new Map<string, number[]>();
            const usedKeys = new Set<string>();

            const nameRankings = await this.rankAspectsByField({
                aspects,
                queryEmbedding,
                fieldSelector: (aspect) => aspect.name,
                cache: embeddingCache,
                cachePrefix: "name"
            });
            const selectedAspects: UserFeatureAspect[] = this.collectMatches({
                rankedEntries: nameRankings,
                desiredCount: desiredNameMatches,
                similarityThreshold,
                usedKeys
            });

            const remainingAspects = aspects.filter(
                aspect => !usedKeys.has(this.buildAspectKey(aspect))
            );

            const contentRankings = await this.rankAspectsByField({
                aspects: remainingAspects,
                queryEmbedding,
                fieldSelector: (aspect) => aspect.content,
                cache: embeddingCache,
                cachePrefix: "content"
            });
            const contentMatches = this.collectMatches({
                rankedEntries: contentRankings,
                desiredCount: desiredContentMatches,
                similarityThreshold,
                usedKeys
            });

            const combined = [...selectedAspects, ...contentMatches];

            if (combined.length < maxResults) {
                const fallback = aspects.filter(
                    aspect => !usedKeys.has(this.buildAspectKey(aspect))
                );
                for (const aspect of fallback) {
                    combined.push(aspect);
                    usedKeys.add(this.buildAspectKey(aspect));
                    if (combined.length === maxResults) {
                        break;
                    }
                }
            }

            elizaLogger.debug(
                `[UserFeatureManager] Retrieved ${combined.length}/${maxResults} relevant aspects for user ${userId} (names first, then content)`
            );

            return combined;
        } catch (error) {
            elizaLogger.error(
                "[UserFeatureManager] Failed to retrieve relevant aspects:",
                error
            );
            return [];
        }
    }

    /**
     * Get all user aspects (fallback when semantic search returns nothing)
     */
    async getAllUserAspects(userId: UUID): Promise<UserFeatureAspect[]> {
        if (!userId || userId === this.runtime.agentId) {
            return [];
        }

        try {
            const memories = await this.getMemories({
                roomId: userId,
                count: 10,  // Max 10 aspects
                unique: false
            });

            return memories
                .filter(m => m.content.type === "user_feature_aspect")
                .map(m => m.content.userFeatureAspect as UserFeatureAspect)
                .filter(a => a !== null && a !== undefined)
                .sort((a, b) => a.aspectIndex - b.aspectIndex);  // Maintain order
        } catch (error) {
            elizaLogger.error(
                "[UserFeatureManager] Failed to get all user aspects:",
                error
            );
            return [];
        }
    }

    private async rankAspectsByField(params: {
        aspects: UserFeatureAspect[];
        queryEmbedding: number[];
        fieldSelector: (aspect: UserFeatureAspect) => string;
        cache: Map<string, number[]>;
        cachePrefix: string;
    }): Promise<Array<{ aspect: UserFeatureAspect; score: number }>> {
        if (params.aspects.length === 0) {
            return [];
        }

        const scoredEntries = await Promise.all(
            params.aspects.map(async (aspect) => {
                const fieldValue = params.fieldSelector(aspect)?.trim() ?? "";
                if (!fieldValue) {
                    return { aspect, score: 0 };
                }

                const embedding = await this.getOrCreateTextEmbedding(
                    fieldValue,
                    params.cache,
                    params.cachePrefix
                );

                return {
                    aspect,
                    score: this.cosineSimilarity(
                        params.queryEmbedding,
                        embedding
                    )
                };
            })
        );

        return scoredEntries.sort((a, b) => b.score - a.score);
    }

    private collectMatches(params: {
        rankedEntries: Array<{ aspect: UserFeatureAspect; score: number }>;
        desiredCount: number;
        similarityThreshold: number;
        usedKeys: Set<string>;
    }): UserFeatureAspect[] {
        const { rankedEntries, desiredCount, similarityThreshold, usedKeys } =
            params;

        if (desiredCount <= 0 || rankedEntries.length === 0) {
            return [];
        }

        const aboveThreshold: Array<{ aspect: UserFeatureAspect; score: number }> = [];
        const fallback: Array<{ aspect: UserFeatureAspect; score: number }> = [];

        for (const entry of rankedEntries) {
            const aspectKey = this.buildAspectKey(entry.aspect);
            if (usedKeys.has(aspectKey)) {
                continue;
            }

            if (entry.score >= similarityThreshold) {
                aboveThreshold.push(entry);
            } else {
                fallback.push(entry);
            }
        }

        const selected: UserFeatureAspect[] = [];
        for (const entry of [...aboveThreshold, ...fallback]) {
            const aspectKey = this.buildAspectKey(entry.aspect);
            if (usedKeys.has(aspectKey)) {
                continue;
            }

            selected.push(entry.aspect);
            usedKeys.add(aspectKey);

            if (selected.length === desiredCount) {
                break;
            }
        }

        return selected;
    }

    private buildAspectKey(aspect: UserFeatureAspect): string {
        return `${aspect.name ?? ""}::${aspect.content ?? ""}::${aspect.version ?? 0}`;
    }

    private cosineSimilarity(a: number[], b: number[]): number {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) {
            return 0;
        }

        const length = Math.min(a.length, b.length);
        let dot = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }

        if (normA === 0 || normB === 0) {
            return 0;
        }

        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    private async getOrCreateTextEmbedding(
        text: string,
        cache: Map<string, number[]>,
        cachePrefix: string
    ): Promise<number[]> {
        const normalized = text.trim().toLowerCase();
        const cacheKey = `${cachePrefix}:${normalized}`;

        if (cache.has(cacheKey)) {
            return cache.get(cacheKey)!;
        }

        if (!normalized) {
            const zeroVector = getEmbeddingZeroVector().slice();
            cache.set(cacheKey, zeroVector);
            return zeroVector;
        }

        try {
            const vector = await embed(this.runtime, text);
            cache.set(cacheKey, vector);
            return vector;
        } catch (error) {
            // Log the actual cause so it surfaces in CloudWatch — passing the
            // Error object directly stringifies to "{}" through pino's default
            // serializer.
            const err = error instanceof Error ? error : new Error(String(error));
            elizaLogger.warn(
                "[UserFeatureManager] Failed to create text embedding",
                {
                    message: err.message,
                    name: err.name,
                    stack: err.stack,
                    textLen: text?.length,
                },
            );
            const zeroVector = getEmbeddingZeroVector().slice();
            cache.set(cacheKey, zeroVector);
            return zeroVector;
        }
    }

    // ============================================================================
    // F2 — Settings transparency API
    // ============================================================================

    /**
     * F2 — return every aspect for a user, paired with its `memoryId` so the
     * client can act on individual aspects. Unlike `getAllUserAspects()`
     * this returns ALL aspects regardless of `consentRequired` / `userConsent`
     * state — the Settings tab needs to surface pending ones for approval.
     */
    async listUserAspectsWithMemoryIds(
        userId: UUID,
    ): Promise<Array<{ memoryId: UUID; aspect: UserFeatureAspect }>> {
        if (!userId || userId === this.runtime.agentId) {
            return [];
        }
        try {
            const memories = await this.getMemories({
                roomId: userId,
                count: 50,
                unique: false,
            });
            return memories
                .filter((m) => m.content.type === "user_feature_aspect")
                .map((m) => ({
                    memoryId: m.id as UUID,
                    aspect: m.content.userFeatureAspect as UserFeatureAspect,
                }))
                .filter((entry) => entry.aspect !== null && entry.aspect !== undefined)
                .sort((a, b) => a.aspect.aspectIndex - b.aspect.aspectIndex);
        } catch (err) {
            elizaLogger.error(
                "[UserFeatureManager] Failed to list user aspects with memory ids",
                err,
            );
            return [];
        }
    }

    /**
     * F2 — flip the user-consent flag on a single aspect memory. The
     * `formatUserTraitsForContext` render path consults this flag and
     * skips aspects whose `consentRequired === true && userConsent !== "approved"`.
     * Emits a `[UserFeature]` audit log line for forensic traceability.
     */
    async setAspectConsent(
        userId: UUID,
        memoryId: UUID,
        consent: "approved" | "rejected" | "pending",
    ): Promise<boolean> {
        try {
            const memories = await this.getMemories({
                roomId: userId,
                count: 50,
                unique: false,
            });
            const target = memories.find((m) => m.id === memoryId);
            if (!target || target.content.type !== "user_feature_aspect") {
                return false;
            }
            const aspect = target.content.userFeatureAspect as UserFeatureAspect;
            if (!aspect) return false;
            const updated: UserFeatureAspect = {
                ...aspect,
                userConsent: consent,
            };
            await this.updateMemoryContent(memoryId, {
                ...target.content,
                userFeatureAspect: updated,
            });
            elizaLogger.info(
                `[UserFeature] aspect_consent userId=${userId} memoryId=${memoryId} ` +
                    `aspect="${aspect.name}" decision=${consent} source=user`,
            );
            return true;
        } catch (err) {
            elizaLogger.error(
                `[UserFeatureManager] setAspectConsent failed memoryId=${memoryId}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            return false;
        }
    }

    /**
     * F2 — hard-delete a single inferred aspect. Audited via
     * `[UserFeature]` log line.
     */
    async deleteAspect(userId: UUID, memoryId: UUID): Promise<boolean> {
        try {
            await this.removeMemory(memoryId);
            elizaLogger.info(
                `[UserFeature] aspect_delete userId=${userId} memoryId=${memoryId} source=user`,
            );
            return true;
        } catch (err) {
            elizaLogger.error(
                `[UserFeatureManager] deleteAspect failed memoryId=${memoryId}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            return false;
        }
    }

    /**
     * F2 — bulk-delete every aspect for a user.
     */
    async deleteAllUserAspects(userId: UUID): Promise<number> {
        const aspects = await this.listUserAspectsWithMemoryIds(userId);
        let removed = 0;
        for (const { memoryId } of aspects) {
            try {
                await this.removeMemory(memoryId);
                removed += 1;
            } catch (err) {
                elizaLogger.warn(
                    `[UserFeatureManager] deleteAllUserAspects partial failure on ${memoryId}: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
            }
        }
        elizaLogger.info(
            `[UserFeature] aspect_delete_all userId=${userId} count=${removed} source=user`,
        );
        return removed;
    }
}
