import {
    DatabaseAdapter,
    elizaLogger,
    getEmbeddingConfig,
    stringToUuid,
    type IDatabaseCacheAdapter,
} from "@elizaos/core";
import { randomBytes } from "crypto";
import fs from "fs";
import type {
    Account,
    Actor,
    Adapter,
    CachedActionResult,
    FavoriteTaskChainCreateInput,
    FavoriteTaskChainRecord,
    Goal,
    GoalStatus,
    IAgentRuntime,
    Memory,
    Participant,
    Plugin,
    RAGKnowledgeItem,
    Relationship,
    SharedChatCreateInput,
    SharedChatRecord,
    ExchangeAuthType,
    ExchangeRegistryEntry,
    SharedTaskChainCreateInput,
    SharedTaskChainRecord,
    TaskChainData,
    UUID,
} from "@elizaos/core";
import {
    type Db,
    MongoClient,
    MongoServerError,
    type MongoClientOptions,
    type Collection,
    type Document,
    type Filter,
} from "mongodb";
import { v4 } from "uuid";

const dimensionWarningTracker = new Map<string, number>();
const WARNING_THROTTLE_MS = 60_000;

/**
 * Minimal interface the unique-index helper needs from a Mongo collection,
 * extracted to make the helper unit-testable without a real Mongo connection.
 */
export interface IndexManagementCollection {
    listIndexes(): { toArray(): Promise<Document[]> };
    dropIndex(name: string): Promise<unknown>;
    createIndex(
        spec: Record<string, 1 | -1>,
        options?: { unique?: boolean; name?: string }
    ): Promise<string>;
}

export interface IndexHelperLogger {
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
}

/**
 * Ensure `referral_codes.userId` is enforced as a UNIQUE index.
 *
 * Why: `getOrCreateReferralCode` uses a TOCTOU lookup-then-insert pattern.
 * Two concurrent calls for the same user can both see "no row" and both
 * insert, leaving the user with two rows. The application-level retry loop
 * only protects against duplicate *codes* (which has its own unique index).
 *
 * Behavior:
 *   1. Already unique → no-op, returns 'already-unique'.
 *   2. Legacy non-unique index → drop it, then create the unique version.
 *   3. Existing rows violate the constraint (E11000 / DuplicateKey) → fall
 *      back to a non-unique index so boot completes; log WARN. A follow-up
 *      dedupe script can clean the data and the next deploy will upgrade.
 *   4. listIndexes / dropIndex transient failure → log WARN and bail out
 *      without throwing, so a single Mongo flake can't crash the boot.
 */
export type EnsureUniqueIndexOutcome =
    | "already-unique"
    | "created-unique"
    | "fallback-non-unique"
    | "skipped-list-failed"
    | "skipped-drop-failed"
    | "fallback-also-failed";

export async function ensureUniqueIndexOnUserId(
    collection: IndexManagementCollection,
    logger: IndexHelperLogger
): Promise<EnsureUniqueIndexOutcome> {
    let existing: Document[];
    try {
        existing = await collection.listIndexes().toArray();
    } catch (err) {
        logger.warn(
            "Failed to list referral_codes indexes; skipping userId-unique upgrade",
            err
        );
        return "skipped-list-failed";
    }

    const userIdIdx = existing.find((idx) => {
        const key = idx?.key as Record<string, unknown> | undefined;
        return (
            key !== undefined &&
            Object.keys(key).length === 1 &&
            key.userId === 1
        );
    });

    if (userIdIdx?.unique === true) {
        return "already-unique";
    }

    if (userIdIdx) {
        try {
            await collection.dropIndex(userIdIdx.name as string);
        } catch (err) {
            logger.warn(
                `Failed to drop legacy referral_codes.userId index '${userIdIdx.name}'; leaving as-is`,
                err
            );
            return "skipped-drop-failed";
        }
    }

    try {
        await collection.createIndex(
            { userId: 1 },
            { unique: true, name: "userId_1_unique" }
        );
        logger.info("Ensured UNIQUE index on referral_codes.userId");
        return "created-unique";
    } catch (err) {
        const e = err as { code?: number; codeName?: string };
        if (e?.code === 11000 || e?.codeName === "DuplicateKey") {
            logger.warn(
                "Cannot create UNIQUE index on referral_codes.userId — " +
                "existing rows contain duplicate userIds (likely from a " +
                "TOCTOU race before this constraint shipped). Falling " +
                "back to a non-unique index so boot can complete. Run " +
                "the dedupe script (keep oldest row per userId) and " +
                "redeploy to enforce the constraint.",
                err
            );
            try {
                await collection.createIndex({ userId: 1 });
                return "fallback-non-unique";
            } catch (fallbackErr) {
                logger.error(
                    "Non-unique fallback index also failed on referral_codes.userId",
                    fallbackErr
                );
                return "fallback-also-failed";
            }
        }
        throw err;
    }
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

type MongoCompressor = "none" | "snappy" | "zlib" | "zstd";
const VALID_MONGO_COMPRESSORS = new Set<MongoCompressor>([
    "none",
    "snappy",
    "zlib",
    "zstd",
]);

function parseMongoCompressors(value: string | undefined): MongoCompressor[] | undefined {
    if (!value) {
        return undefined;
    }

    const parsed = value
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry): entry is MongoCompressor =>
            VALID_MONGO_COMPRESSORS.has(entry as MongoCompressor)
        );

    return parsed.length > 0 ? parsed : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
    if (value === undefined) {
        return undefined;
    }

    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) {
        return true;
    }
    if (["0", "false", "no", "n", "off"].includes(normalized)) {
        return false;
    }

    return undefined;
}

type MongoBackendKind = "mongodb" | "documentdb";

type ResolvedConfigValue = {
    key: string;
    value: string;
};

type ResolvedMongoRuntimeConfig = {
    backendKind: MongoBackendKind;
    connectionString: string;
    connectionStringSource: string;
    databaseName: string;
    databaseNameSource: string;
    clientOptions: MongoClientOptions;
    summary: {
        tls: boolean;
        tlsCAFileConfigured: boolean;
        directConnection?: boolean;
        retryWrites: boolean;
        maxPoolSize: number;
        minPoolSize: number;
        connectTimeoutMS: number;
        socketTimeoutMS: number;
        serverSelectionTimeoutMS: number;
        appName?: string;
    };
};

function getRuntimeSetting(runtime: IAgentRuntime, key: string): string | undefined {
    const fromRuntime = runtime.getSetting(key);
    if (typeof fromRuntime === "string" && fromRuntime.trim() !== "") {
        return fromRuntime.trim();
    }

    const fromEnv = process.env[key];
    if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
        return fromEnv.trim();
    }

    return undefined;
}

function normalizeMongoBackendKind(value: string | undefined): MongoBackendKind {
    const normalized = value?.trim().toLowerCase();

    if (normalized === "documentdb" || normalized === "docdb") {
        return "documentdb";
    }

    return "mongodb";
}

function resolveBackendSetting(
    runtime: IAgentRuntime,
    backendKind: MongoBackendKind,
    suffix: string
): ResolvedConfigValue | undefined {
    const candidateKeys =
        backendKind === "documentdb"
            ? [`DOCUMENTDB_${suffix}`, `MONGODB_${suffix}`]
            : [`MONGODB_${suffix}`, `DOCUMENTDB_${suffix}`];

    for (const key of candidateKeys) {
        const value = getRuntimeSetting(runtime, key);
        if (value !== undefined) {
            return { key, value };
        }
    }

    return undefined;
}

export function resolveMongoRuntimeConfig(runtime: IAgentRuntime): ResolvedMongoRuntimeConfig {
    const backendKind = normalizeMongoBackendKind(getRuntimeSetting(runtime, "DATABASE_ADAPTER"));

    const connectionStringConfig = resolveBackendSetting(runtime, backendKind, "CONNECTION_STRING");
    if (!connectionStringConfig) {
        const expectedVars =
            backendKind === "documentdb"
                ? "DOCUMENTDB_CONNECTION_STRING (preferred) or MONGODB_CONNECTION_STRING"
                : "MONGODB_CONNECTION_STRING";
        throw new Error(
            `Database adapter '${backendKind}' requires ${expectedVars}. See docs/documentdb-runtime-contract.md for the supported runtime contract.`
        );
    }

    const databaseNameConfig = resolveBackendSetting(runtime, backendKind, "DATABASE");
    if (!databaseNameConfig) {
        const expectedVars =
            backendKind === "documentdb"
                ? "DOCUMENTDB_DATABASE (preferred) or MONGODB_DATABASE"
                : "MONGODB_DATABASE";
        throw new Error(
            `Database adapter '${backendKind}' requires ${expectedVars}. See docs/documentdb-runtime-contract.md for the supported runtime contract.`
        );
    }

    const databaseName = databaseNameConfig.value;
    const databaseNameSource = databaseNameConfig.key;

    const tlsValue = resolveBackendSetting(runtime, backendKind, "TLS");
    const tls = parseOptionalBoolean(tlsValue?.value) ?? (backendKind === "documentdb");

    const caFileValue = resolveBackendSetting(runtime, backendKind, "CA_FILE");
    if (caFileValue?.value && !fs.existsSync(caFileValue.value)) {
        throw new Error(
            `Configured CA bundle path in ${caFileValue.key} does not exist: ${caFileValue.value}`
        );
    }

    const directConnectionValue = resolveBackendSetting(runtime, backendKind, "DIRECT_CONNECTION");
    const retryWritesValue = resolveBackendSetting(runtime, backendKind, "RETRY_WRITES");
    const appNameValue = resolveBackendSetting(runtime, backendKind, "APP_NAME");
    const compressorsValue = resolveBackendSetting(runtime, backendKind, "COMPRESSORS");
    const maxPoolSizeValue = resolveBackendSetting(runtime, backendKind, "MAX_POOL_SIZE");
    const minPoolSizeValue = resolveBackendSetting(runtime, backendKind, "MIN_POOL_SIZE");
    const connectTimeoutValue = resolveBackendSetting(runtime, backendKind, "CONNECT_TIMEOUT_MS");
    const socketTimeoutValue = resolveBackendSetting(runtime, backendKind, "SOCKET_TIMEOUT_MS");
    const serverSelectionTimeoutValue = resolveBackendSetting(
        runtime,
        backendKind,
        "SERVER_SELECTION_TIMEOUT_MS"
    );

    const maxPoolSize = parsePositiveInt(maxPoolSizeValue?.value, 100);
    const minPoolSize = Math.min(
        parseNonNegativeInt(minPoolSizeValue?.value, 0),
        maxPoolSize
    );
    const connectTimeoutMS = parsePositiveInt(connectTimeoutValue?.value, 10_000);
    const socketTimeoutMS = parsePositiveInt(socketTimeoutValue?.value, 45_000);
    const serverSelectionTimeoutMS = parsePositiveInt(
        serverSelectionTimeoutValue?.value,
        10_000
    );
    const configuredCompressors = parseMongoCompressors(compressorsValue?.value);
    const directConnection =
        parseOptionalBoolean(directConnectionValue?.value) ??
        (backendKind === "documentdb" ? false : undefined);
    const retryWrites =
        parseOptionalBoolean(retryWritesValue?.value) ??
        (backendKind === "documentdb" ? false : true);

    const clientOptions: MongoClientOptions = {
        maxPoolSize,
        minPoolSize,
        connectTimeoutMS,
        socketTimeoutMS,
        serverSelectionTimeoutMS,
        retryReads: true,
        retryWrites,
        compressors: configuredCompressors,
        ignoreUndefined: true,
        tls,
    };

    if (typeof directConnection === "boolean") {
        clientOptions.directConnection = directConnection;
    }

    if (caFileValue?.value) {
        clientOptions.tlsCAFile = caFileValue.value;
    }

    if (appNameValue?.value) {
        clientOptions.appName = appNameValue.value;
    }

    return {
        backendKind,
        connectionString: connectionStringConfig.value,
        connectionStringSource: connectionStringConfig.key,
        databaseName,
        databaseNameSource,
        clientOptions,
        summary: {
            tls,
            tlsCAFileConfigured: Boolean(caFileValue?.value),
            directConnection: clientOptions.directConnection,
            retryWrites,
            maxPoolSize,
            minPoolSize,
            connectTimeoutMS,
            socketTimeoutMS,
            serverSelectionTimeoutMS,
            appName: clientOptions.appName,
        },
    };
}

function logDimensionWarning(type: string, currentDims: number, expectedDims: number, operation: string) {
    const key = `${type}_${operation}`;
    const now = Date.now();
    const lastWarning = dimensionWarningTracker.get(key) || 0;

    if (now - lastWarning > WARNING_THROTTLE_MS) {
        elizaLogger.warn(
            `${operation} embedding ${type} (${currentDims} dimensions), adjusting to ${expectedDims} [throttled - showing once per minute]`
        );
        dimensionWarningTracker.set(key, now);
    } else {
        elizaLogger.debug(
            `${operation} embedding ${type} (${currentDims} dimensions), adjusting to ${expectedDims}`
        );
    }
}

type BaseDoc = {
    id: string;
    createdAt?: number | string;
};

type AccountDoc = BaseDoc & {
    name?: string;
    username?: string;
    email?: string;
    avatarUrl?: string | null;
    details?: Record<string, unknown> | string | null;
};

type MemoryDoc = BaseDoc & {
    type: string;
    content: Memory["content"] | string;
    embedding?: number[];
    userId?: UUID;
    roomId?: UUID;
    agentId?: UUID;
    unique?: boolean | number;
    similarity?: number;
    clientIP?: string | null;
};

type GoalDoc = BaseDoc & {
    roomId: UUID;
    userId: UUID;
    name: string;
    status: GoalStatus;
    objectives: Goal["objectives"] | string;
};

type FavoriteTaskChainDoc = BaseDoc & {
    userId: UUID;
    agentId: UUID;
    chainId: string;
    name: string;
    originalName: string;
    description?: string | null;
    taskChain: TaskChainData | string;
    lastUsedAt?: number | null;
    executionCount?: number;
    isPublic?: boolean | number;
};

type SharedTaskChainDoc = BaseDoc & {
    shareCode: string;
    favoriteId?: UUID | null;
    userId: UUID;
    agentId: UUID;
    chainId: string;
    name: string;
    originalName: string;
    description?: string | null;
    taskChain: TaskChainData | string;
};

type KnowledgeDoc = BaseDoc & {
    agentId?: UUID | null;
    content: RAGKnowledgeItem["content"] | string;
    embedding?: number[];
    isMain?: boolean;
    originalId?: UUID | null;
    chunkIndex?: number | null;
    isShared?: boolean;
};

type CacheDoc = {
    key: string;
    agentId: UUID;
    value: string;
    createdAt: number;
    expiresAt?: number | null;
};

type ActionCacheDoc = BaseDoc & {
    actionName: string;
    query: string;
    queryEmbedding: number[];
    result: string;
    chunkIndex: number;
    totalChunks: number;
    embedding: number[];
    expiresAt: number;
    hitCount: number;
};

type ExchangeRegistryAuthFieldDoc = {
    id?: unknown;
    key?: unknown;
    label?: unknown;
    type?: unknown;
    required?: unknown;
    description?: unknown;
    placeholder?: unknown;
};

type ExchangeRegistryAuthConfigDoc = {
    type?: unknown;
    fields?: unknown;
};

type ExchangeRegistryDoc = BaseDoc & {
    name: string;
    defaultAuthType?: string | null;
    authTypes?: ExchangeRegistryAuthConfigDoc[] | string | null;
    updatedAt?: number;
};

const EXCHANGE_AUTH_TYPES: readonly ExchangeAuthType[] = [
    "oauth_access_refresh_token",
    "api_key_name_secret",
];

const DEFAULT_EXCHANGE_REGISTRY: ExchangeRegistryEntry[] = [
    {
        id: "coinbase",
        name: "Coinbase",
        defaultAuthType: "api_key_name_secret",
        authTypes: [
            {
                type: "api_key_name_secret",
                fields: [
                    {
                        id: "apiKeyName",
                        label: "API key name",
                        type: "secret",
                        required: true,
                        description:
                            "Coinbase Advanced Trade API key name (used for JWT auth).",
                        placeholder: "API key name",
                    },
                    {
                        id: "apiKeySecret",
                        label: "API key secret",
                        type: "secret",
                        required: true,
                        description:
                            "Coinbase Advanced Trade API key secret (used for JWT auth).",
                        placeholder: "API key secret",
                    },
                ],
            },
        ],
    },
    {
        id: "binance",
        name: "Binance",
        defaultAuthType: "api_key_name_secret",
        authTypes: [
            {
                type: "api_key_name_secret",
                fields: [
                    {
                        id: "apiKeyName",
                        label: "API key",
                        type: "secret",
                        required: true,
                        description:
                            "Binance API key (HMAC). Set X-MBX-APIKEY permissions for Spot / Wallet as needed.",
                        placeholder: "Binance API key",
                    },
                    {
                        id: "apiKeySecret",
                        label: "Secret key",
                        type: "secret",
                        required: true,
                        description: "Binance secret key (HMAC signing).",
                        placeholder: "Binance secret key",
                    },
                ],
            },
        ],
    },
];

function toTimestamp(value: unknown, fallback = Date.now()): number {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : fallback;
    }
    if (typeof value === "string") {
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? fallback : parsed;
    }
    return fallback;
}

function parseJson<T>(value: unknown, fallback: T): T {
    if (typeof value !== "string") {
        return (value as T) ?? fallback;
    }

    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}

function isDuplicateKeyError(error: unknown): boolean {
    if (!(error instanceof MongoServerError)) {
        return false;
    }

    return error.code === 11000;
}

function levenshteinDistance(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const prev = new Array<number>(b.length + 1);
    const curr = new Array<number>(b.length + 1);

    for (let j = 0; j <= b.length; j++) prev[j] = j;

    for (let i = 1; i <= a.length; i++) {
        curr[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            curr[j] = Math.min(
                prev[j] + 1,
                curr[j - 1] + 1,
                prev[j - 1] + cost
            );
        }
        for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
    }

    return prev[b.length];
}

function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length === 0 || b.length === 0) return 0;

    const len = Math.min(a.length, b.length);
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < len; i++) {
        const av = a[i] ?? 0;
        const bv = b[i] ?? 0;
        dot += av * bv;
        normA += av * av;
        normB += bv * bv;
    }

    if (normA === 0 || normB === 0) return 0;

    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function vectorNormSquared(vector: number[]): number {
    let norm = 0;
    for (let i = 0; i < vector.length; i++) {
        const value = vector[i] ?? 0;
        norm += value * value;
    }
    return norm;
}

function cosineSimilarityWithQueryNorm(
    queryEmbedding: number[],
    queryNormSquared: number,
    candidateEmbedding: number[]
): number {
    if (queryEmbedding.length === 0 || candidateEmbedding.length === 0) {
        return 0;
    }

    if (queryNormSquared === 0) {
        return 0;
    }

    const len = Math.min(queryEmbedding.length, candidateEmbedding.length);
    let dot = 0;
    let candidateNormSquared = 0;

    for (let i = 0; i < len; i++) {
        const queryValue = queryEmbedding[i] ?? 0;
        const candidateValue = candidateEmbedding[i] ?? 0;
        dot += queryValue * candidateValue;
        candidateNormSquared += candidateValue * candidateValue;
    }

    if (candidateNormSquared === 0) {
        return 0;
    }

    return dot / (Math.sqrt(queryNormSquared) * Math.sqrt(candidateNormSquared));
}

function randomSample<T>(items: T[], count: number): T[] {
    if (items.length <= count) {
        return items;
    }

    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = shuffled[i];
        shuffled[i] = shuffled[j];
        shuffled[j] = tmp;
    }

    return shuffled.slice(0, count);
}

export class MongoDatabaseAdapter
    extends DatabaseAdapter<Db>
    implements IDatabaseCacheAdapter
{
    private client: MongoClient;

    private databaseName: string;

    private readonly searchOversample: number;

    private readonly searchMaxCandidates: number;

    private readonly dedupeMaxCandidates: number;

    private readonly backendKind: MongoBackendKind;

    private readonly runtimeConfigSummary: ResolvedMongoRuntimeConfig["summary"];

    private readonly memoryProjection = {
        _id: 0,
        id: 1,
        type: 1,
        content: 1,
        embedding: 1,
        userId: 1,
        roomId: 1,
        agentId: 1,
        unique: 1,
        similarity: 1,
        clientIP: 1,
        createdAt: 1,
    } as const;

    constructor(config: ResolvedMongoRuntimeConfig) {
        super();
        this.backendKind = config.backendKind;
        this.databaseName = config.databaseName;
        this.runtimeConfigSummary = config.summary;
        this.searchOversample = parsePositiveInt(process.env.MONGODB_SEARCH_OVERSAMPLE, 10);
        this.searchMaxCandidates = parsePositiveInt(process.env.MONGODB_SEARCH_MAX_CANDIDATES, 2000);
        // Used by createMemory's hasSimilarMemory dedup. Lowered from 400 to
        // 50 because the dedup runs on every message write, fetches full
        // embedding payloads (~8 KB each), and a 0.95 cosine match against the
        // 50 most recent room messages is more than enough to catch duplicates
        // — anything older than that is almost never a true duplicate.
        this.dedupeMaxCandidates = parsePositiveInt(process.env.MONGODB_DEDUPE_MAX_CANDIDATES, 50);
        this.client = new MongoClient(config.connectionString, config.clientOptions);
        // Make db handle immediately available even before async connect completes.
        this.db = this.client.db(this.databaseName);
    }

    private collection<T extends Document>(name: string): Collection<T> {
        return this.db.collection<T>(name);
    }

    private candidateLimit(targetCount: number, maxCap: number): number {
        const safeCount = Math.max(1, targetCount);
        const oversampled = safeCount * this.searchOversample;
        return Math.max(safeCount, Math.min(maxCap, oversampled));
    }

    private async fetchMemoryCandidates(
        filter: Filter<MemoryDoc>,
        limit: number,
        projection: Document = this.memoryProjection
    ): Promise<MemoryDoc[]> {
        return this.collection<MemoryDoc>("memories")
            .find(filter, { projection })
            .sort({ createdAt: -1 })
            .limit(limit)
            .toArray();
    }

    private scoreTopMemories(
        rows: MemoryDoc[],
        queryEmbedding: number[],
        count: number,
        threshold = 0
    ): Array<MemoryDoc & { similarity: number }> {
        if (count <= 0) {
            return [];
        }

        const queryNormSquared = vectorNormSquared(queryEmbedding);
        if (queryNormSquared === 0) {
            return [];
        }

        const top: Array<MemoryDoc & { similarity: number }> = [];
        for (const row of rows) {
            if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
                continue;
            }

            const similarity = cosineSimilarityWithQueryNorm(
                queryEmbedding,
                queryNormSquared,
                row.embedding
            );
            if (similarity < threshold) {
                continue;
            }

            const candidate = {
                ...row,
                similarity,
            };

            if (top.length < count) {
                top.push(candidate);
                top.sort((a, b) => a.similarity - b.similarity);
                continue;
            }

            if (similarity > top[0].similarity) {
                top[0] = candidate;
                top.sort((a, b) => a.similarity - b.similarity);
            }
        }

        return top.sort((a, b) => b.similarity - a.similarity);
    }

    private async hasSimilarMemory(
        queryEmbedding: number[],
        params: {
            tableName: string;
            // agentId and roomId are required: an unscoped `{ type }` query
            // does a partial scan of the entire memories collection (no
            // covering index) and pulls full embedding payloads to the app.
            // Keep this method's contract narrow so a future caller can't
            // regress to that hot-path footgun.
            agentId: UUID;
            roomId: UUID;
            threshold: number;
        }
    ): Promise<boolean> {
        const filter: Filter<MemoryDoc> = {
            type: params.tableName,
            agentId: params.agentId,
            roomId: params.roomId,
            embedding: { $exists: true },
        };

        const dedupeLimit = this.candidateLimit(1, this.dedupeMaxCandidates);
        const rows = await this.fetchMemoryCandidates(
            filter,
            dedupeLimit,
            { _id: 0, embedding: 1 }
        );

        const queryNormSquared = vectorNormSquared(queryEmbedding);
        if (queryNormSquared === 0) {
            return false;
        }

        for (const row of rows) {
            if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
                continue;
            }

            const similarity = cosineSimilarityWithQueryNorm(
                queryEmbedding,
                queryNormSquared,
                row.embedding
            );
            if (similarity >= params.threshold) {
                return true;
            }
        }

        return false;
    }

    private normalizeEmbedding(
        embedding: number[] | Float32Array | undefined,
        kind: string,
        operation: string
    ): number[] {
        const dims = getEmbeddingConfig().dimensions;

        if (!embedding || embedding.length === 0) {
            return new Array<number>(dims).fill(0);
        }

        const source = Array.from(embedding);

        if (source.length > dims) {
            logDimensionWarning(kind, source.length, dims, operation);
            return source.slice(0, dims);
        }

        if (source.length < dims) {
            logDimensionWarning(kind, source.length, dims, operation);
            return [...source, ...new Array<number>(dims - source.length).fill(0)];
        }

        return source;
    }

    private mapMemoryDoc(doc: MemoryDoc): Memory {
        return {
            id: doc.id as UUID,
            userId: doc.userId as UUID,
            roomId: doc.roomId as UUID,
            agentId: doc.agentId as UUID,
            content:
                typeof doc.content === "string"
                    ? parseJson<Memory["content"]>(doc.content, { text: doc.content })
                    : doc.content,
            embedding: Array.isArray(doc.embedding) ? doc.embedding : undefined,
            unique: doc.unique === true || doc.unique === 1,
            createdAt: toTimestamp(doc.createdAt),
            similarity: typeof doc.similarity === "number" ? doc.similarity : undefined,
            clientIP: doc.clientIP ?? null,
        };
    }

    private mapKnowledgeDoc(doc: KnowledgeDoc): RAGKnowledgeItem {
        const content =
            typeof doc.content === "string"
                ? parseJson<RAGKnowledgeItem["content"]>(doc.content, { text: "" })
                : doc.content;

        return {
            id: doc.id as UUID,
            agentId: (doc.agentId ?? "") as UUID,
            content,
            embedding: Array.isArray(doc.embedding)
                ? new Float32Array(doc.embedding)
                : undefined,
            createdAt: toTimestamp(doc.createdAt),
        };
    }

    private mapFavoriteTaskChainDoc(row: FavoriteTaskChainDoc): FavoriteTaskChainRecord {
        let parsedTaskChain: TaskChainData;
        try {
            parsedTaskChain =
                typeof row.taskChain === "string"
                    ? (JSON.parse(row.taskChain) as TaskChainData)
                    : (row.taskChain as TaskChainData);
        } catch (error) {
            elizaLogger.error(
                "Failed to parse favorite task chain payload, falling back to minimal structure",
                error
            );
            parsedTaskChain = {
                id: row.chainId,
                name: row.name,
                description: row.description ?? "",
                tasks: [],
            };
        }

        const lastUsedAt =
            row.lastUsedAt === null || row.lastUsedAt === undefined
                ? undefined
                : toTimestamp(row.lastUsedAt);

        return {
            id: row.id as UUID,
            userId: row.userId,
            agentId: row.agentId,
            chainId: row.chainId,
            name: row.name,
            originalName: row.originalName,
            description: row.description ?? undefined,
            taskChain: parsedTaskChain,
            createdAt: toTimestamp(row.createdAt),
            lastUsedAt,
            isPublic: row.isPublic === true || row.isPublic === 1,
        };
    }

    private mapSharedTaskChainDoc(row: SharedTaskChainDoc): SharedTaskChainRecord {
        let parsedTaskChain: TaskChainData;
        try {
            parsedTaskChain =
                typeof row.taskChain === "string"
                    ? (JSON.parse(row.taskChain) as TaskChainData)
                    : (row.taskChain as TaskChainData);
        } catch (error) {
            elizaLogger.error(
                "Failed to parse shared task chain payload, falling back to minimal structure",
                error
            );
            parsedTaskChain = {
                id: row.chainId,
                name: row.name,
                description: row.description ?? "",
                tasks: [],
            };
        }

        return {
            id: row.id as UUID,
            shareCode: row.shareCode,
            userId: row.userId,
            agentId: row.agentId,
            favoriteId: row.favoriteId ?? null,
            chainId: row.chainId,
            name: row.name,
            originalName: row.originalName,
            description: row.description ?? undefined,
            taskChain: parsedTaskChain,
            createdAt: toTimestamp(row.createdAt),
        };
    }

    private async ensureIndexes() {
        await Promise.all([
            this.collection<AccountDoc>("accounts").createIndex({ id: 1 }, { unique: true }),
            this.collection<AccountDoc>("accounts").createIndex({ email: 1 }),

            this.collection<MemoryDoc>("memories").createIndex({ id: 1 }, { unique: true }),
            this.collection<MemoryDoc>("memories").createIndex({ type: 1, agentId: 1, roomId: 1, createdAt: -1 }),
            this.collection<MemoryDoc>("memories").createIndex({ type: 1, userId: 1, agentId: 1, createdAt: -1 }),
            this.collection<MemoryDoc>("memories").createIndex({ roomId: 1, createdAt: -1 }),
            this.collection<MemoryDoc>("memories").createIndex({ type: 1, roomId: 1, unique: 1, createdAt: -1 }),
            this.collection<MemoryDoc>("memories").createIndex({ type: 1, agentId: 1, roomId: 1, unique: 1, createdAt: -1 }),
            // Defensive: covers any unscoped (type, agentId) candidate fetch
            // (e.g. if a future caller forgets to pass roomId). Cheap to keep.
            this.collection<MemoryDoc>("memories").createIndex({ type: 1, agentId: 1, createdAt: -1 }),

            this.collection<GoalDoc>("goals").createIndex({ id: 1 }, { unique: true }),
            this.collection<GoalDoc>("goals").createIndex({ roomId: 1, createdAt: -1 }),

            this.collection<Document>("logs").createIndex({ id: 1 }, { unique: true }),
            this.collection<Document>("participants").createIndex({ id: 1 }, { unique: true }),
            this.collection<Document>("participants").createIndex({ userId: 1, roomId: 1, agentId: 1 }),
            this.collection<Document>("relationships").createIndex({ id: 1 }, { unique: true }),
            this.collection<Document>("rooms").createIndex({ id: 1 }, { unique: true }),

            this.collection<CacheDoc>("cache").createIndex({ key: 1, agentId: 1 }, { unique: true }),

            this.collection<KnowledgeDoc>("knowledge").createIndex({ id: 1 }, { unique: true }),
            this.collection<KnowledgeDoc>("knowledge").createIndex({ agentId: 1, isMain: 1 }),
            this.collection<KnowledgeDoc>("knowledge").createIndex({ originalId: 1 }),
            this.collection<KnowledgeDoc>("knowledge").createIndex({ createdAt: -1 }),
            this.collection<KnowledgeDoc>("knowledge").createIndex({ isShared: 1 }),

            this.collection<FavoriteTaskChainDoc>("favorite_taskchains").createIndex({ id: 1 }, { unique: true }),
            this.collection<FavoriteTaskChainDoc>("favorite_taskchains").createIndex({ userId: 1, agentId: 1, chainId: 1 }, { unique: true }),
            this.collection<FavoriteTaskChainDoc>("favorite_taskchains").createIndex({ userId: 1, agentId: 1 }),
            this.collection<FavoriteTaskChainDoc>("favorite_taskchains").createIndex({ agentId: 1, chainId: 1 }),

            this.collection<SharedTaskChainDoc>("shared_taskchains").createIndex({ id: 1 }, { unique: true }),
            this.collection<SharedTaskChainDoc>("shared_taskchains").createIndex({ shareCode: 1 }, { unique: true }),
            this.collection<SharedTaskChainDoc>("shared_taskchains").createIndex({ favoriteId: 1 }),
            this.collection<SharedTaskChainDoc>("shared_taskchains").createIndex({ agentId: 1 }),

            this.collection<ActionCacheDoc>("action_cache").createIndex({ id: 1 }, { unique: true }),
            this.collection<ActionCacheDoc>("action_cache").createIndex({ actionName: 1 }),
            this.collection<ActionCacheDoc>("action_cache").createIndex({ expiresAt: 1 }),
            this.collection<ActionCacheDoc>("action_cache").createIndex({ actionName: 1, expiresAt: 1 }),

            this.collection<Document>("referral_codes").createIndex({ id: 1 }, { unique: true }),
            this.collection<Document>("referral_codes").createIndex({ referralCode: 1 }, { unique: true }),
            // referral_codes.userId is enforced as a unique index by
            // ensureUniqueReferralCodeUserIdIndex (called from init() after
            // ensureIndexes). It's not in this batch because it needs
            // duplicate-tolerant fallback handling for older deployments.

            this.collection<Document>("referrals").createIndex({ id: 1 }, { unique: true }),
            this.collection<Document>("referrals").createIndex({ referrerId: 1 }),
            this.collection<Document>("referrals").createIndex({ referredUserId: 1 }, { unique: true }),

            this.collection<Document>("user_referral_codes").createIndex({ id: 1 }, { unique: true }),
            this.collection<Document>("user_referral_codes").createIndex({ userId: 1 }, { unique: true }),
            this.collection<Document>("user_referral_codes").createIndex({ referralCodeUsed: 1 }),

            this.collection<Document>("pending_referrals").createIndex({ email: 1 }),
            this.collection<Document>("signup_link_sends").createIndex({ email: 1 }),
            this.collection<Document>("signup_link_sends").createIndex({ createdAt: -1 }),

            this.collection<Document>("subscription_events").createIndex({ id: 1 }, { unique: true }),
            this.collection<Document>("subscription_events").createIndex({ userId: 1 }),
            this.collection<Document>("subscription_events").createIndex({ stripeEventId: 1 }, { unique: true }),
            this.collection<Document>("subscription_events").createIndex({ eventType: 1 }),
            this.collection<Document>("subscription_events").createIndex({ createdAt: -1 }),

            this.collection<Document>("user_subscriptions").createIndex({ id: 1 }, { unique: true }),
            this.collection<Document>("user_subscriptions").createIndex({ userId: 1 }, { unique: true }),
            this.collection<Document>("user_subscriptions").createIndex({ subscriptionStatus: 1 }),
            this.collection<Document>("user_subscriptions").createIndex({ stripeCustomerId: 1 }),

            this.collection<Document>("user_subscription_tier_history").createIndex({ id: 1 }, { unique: true }),
            this.collection<Document>("user_subscription_tier_history").createIndex({ userId: 1, observedAt: -1, createdAt: -1 }),
            this.collection<Document>("user_subscription_tier_history").createIndex({ tier: 1 }),

            this.collection<Document>("token_usage").createIndex({ id: 1 }, { unique: true }),
            this.collection<Document>("token_usage").createIndex({ userId: 1, timestamp: -1 }),
            this.collection<Document>("token_usage").createIndex({ userId: 1, timestamp: 1, inputTokens: 1, outputTokens: 1 }),

            this.collection<Document>("web_page_sessions").createIndex({ id: 1 }, { unique: true }),
            this.collection<Document>("web_page_sessions").createIndex({ createdAt: -1 }),
            this.collection<Document>("web_page_sessions").createIndex({ path: 1 }),
            this.collection<Document>("web_page_sessions").createIndex({ path: 1, isAuthenticated: 1, createdAt: -1 }),

            this.collection<Document>("analytics_usage_rollup").createIndex({ day: 1, segment: 1 }, { unique: true }),
            this.collection<Document>("analytics_usage_rollup_users").createIndex({ day: 1, segment: 1, userId: 1 }, { unique: true }),
            this.collection<ExchangeRegistryDoc>("exchange_registry").createIndex({ id: 1 }, { unique: true }),

            // Autotrading uplift §1.5 — per-user trading preferences (risk
            // profile, kill switch, language, etc.). One document per user.
            this.collection<Document>("user_trading_preferences").createIndex({ userId: 1 }, { unique: true }),

            // Autotrading uplift §1.5 — append-only audit log of every
            // risk-engine decision (allow + block). Read patterns:
            // per-user history and global rule-fire counts.
            this.collection<Document>("risk_decisions").createIndex({ userId: 1, createdAt: -1 }),
            this.collection<Document>("risk_decisions").createIndex({ intent_hash: 1 }),
            this.collection<Document>("risk_decisions").createIndex({ request_id: 1 }, { unique: true }),

            // Autotrading uplift §2.1 — pending orders ledger: tracks every
            // submitted order from REST submit through WS/REST reconciliation to
            // terminal state. The unique index on client_order_id is the upsert anchor.
            this.collection<Document>("pending_orders_ledger").createIndex({ client_order_id: 1 }, { unique: true }),
            this.collection<Document>("pending_orders_ledger").createIndex({ userId: 1, venue: 1, state: 1 }),
            this.collection<Document>("pending_orders_ledger").createIndex({ submittedAt: 1 }),

            // Autotrading uplift §4.3 — shadow-mode decision log: every
            // hypothetical execution recorded for divergence analysis vs
            // paper mode. Append-only; unique request_id makes retries
            // idempotent. Read patterns: per-user history + per-strategy
            // rollup.
            this.collection<Document>("shadow_decisions").createIndex({ userId: 1, createdAt: -1 }),
            this.collection<Document>("shadow_decisions").createIndex({ request_id: 1 }, { unique: true }),
            this.collection<Document>("shadow_decisions").createIndex({ strategy_id: 1, createdAt: -1 }),

            // §6.2 — approval_decisions: every level-1 / level-2 approval
            // emission writes a row, regardless of outcome. Replay tool joins
            // on `request_id` + `level`.
            this.collection<Document>("approval_decisions").createIndex({ userId: 1, createdAt: -1 }),
            this.collection<Document>("approval_decisions").createIndex(
                { request_id: 1, level: 1 },
                { unique: true },
            ),

            // §7.8 — consent_log: live-trading TOS / risk-disclosure / data
            // processing consent. Unique on `(userId, consent_type, version)`
            // so re-accepts are idempotent.
            this.collection<Document>("consent_log").createIndex(
                { userId: 1, consent_type: 1, version: 1 },
                { unique: true },
            ),
            this.collection<Document>("consent_log").createIndex({ userId: 1, acceptedAt: -1 }),

            // §7.2 — kill_switch_events: append-only history of every toggle.
            this.collection<Document>("kill_switch_events").createIndex(
                { userId: 1, createdAt: -1 },
            ),

            // §7.3 — preferences_audit: every trading-prefs save.
            this.collection<Document>("preferences_audit").createIndex(
                { userId: 1, createdAt: -1 },
            ),

            // §8.3 — credentials_audit: encrypted-CEX-key writes / revocations.
            this.collection<Document>("credentials_audit").createIndex(
                { userId: 1, createdAt: -1 },
            ),
            this.collection<Document>("credentials_audit").createIndex({
                exchange_id: 1,
                createdAt: -1,
            }),

            // §8.2 — rbac_decisions: every denied access (admin endpoints).
            this.collection<Document>("rbac_decisions").createIndex(
                { userId: 1, createdAt: -1 },
            ),

            // §7.9 — notifications: persistent fan-out from trading events.
            this.collection<Document>("notifications").createIndex(
                { userId: 1, createdAt: -1 },
            ),
            this.collection<Document>("notifications").createIndex({
                userId: 1,
                read: 1,
                createdAt: -1,
            }),

            // §7.7 — strategy_instances: per-user strategy runs (paper or live).
            this.collection<Document>("strategy_instances").createIndex(
                { userId: 1, status: 1, started_at: -1 },
            ),
            this.collection<Document>("strategy_instances").createIndex({
                strategy_id: 1,
                userId: 1,
            }),

            // §6.3 — venue_calls: durable request/response payloads for every
            // venue REST call (createOrder, cancelOrder, getOrder). Sanitized
            // before write — API keys redacted by `recordVenueCall`.
            this.collection<Document>("venue_calls").createIndex(
                { request_id: 1, createdAt: 1 },
            ),
            this.collection<Document>("venue_calls").createIndex({
                client_order_id: 1,
                createdAt: 1,
            }),
            this.collection<Document>("venue_calls").createIndex({
                userId: 1,
                createdAt: -1,
            }),

            // F3 — paper_orders ledger: persistent record of orders placed
            // against the paper venue. Mirrors `pending_orders_ledger` for
            // live trading. Indexes:
            //  - `(userId, order_id)` unique: idempotent upsert anchor
            //  - `(userId, status)`: open-orders lookup is the hot path
            //  - `ttl_at` TTL: rows auto-purge after PAPER_ORDER_TTL_SECONDS
            //    (default 86400 = 24h). DocumentDB 5.0 supports TTL.
            this.collection<Document>("paper_orders").createIndex(
                { userId: 1, order_id: 1 },
                { unique: true },
            ),
            this.collection<Document>("paper_orders").createIndex({ userId: 1, status: 1 }),
            this.collection<Document>("paper_orders").createIndex(
                { ttl_at: 1 },
                { expireAfterSeconds: 0 },
            ),

            // F3 — paper_fills mirror (fills are append-only).
            this.collection<Document>("paper_fills").createIndex({
                userId: 1,
                order_id: 1,
            }),
            this.collection<Document>("paper_fills").createIndex(
                { ttl_at: 1 },
                { expireAfterSeconds: 0 },
            ),
        ]);

        // Best-effort upgrade for the userId index on referral_codes. Kept
        // outside the Promise.all batch above because (a) it may need to drop
        // a legacy non-unique index first and (b) it must fall back gracefully
        // if existing rows violate the new constraint, instead of throwing and
        // crash-looping the container.
        await this.ensureUniqueReferralCodeUserIdIndex();
    }

    /**
     * Ensure the unique index on `referral_codes.userId` is in place.
     * Thin wrapper that resolves the collection and delegates to the pure
     * helper so the logic is unit-testable without a real Mongo connection.
     */
    private async ensureUniqueReferralCodeUserIdIndex(): Promise<void> {
        const collection = this.collection<Document>("referral_codes");
        await ensureUniqueIndexOnUserId(collection, elizaLogger);
    }

    private mapExchangeRegistryEntry(row: ExchangeRegistryDoc): ExchangeRegistryEntry {
        let authTypes: ExchangeRegistryEntry["authTypes"] = [];
        let rawAuthTypeConfigs: ExchangeRegistryAuthConfigDoc[] = [];
        const rawAuthTypes = row.authTypes;
        if (Array.isArray(rawAuthTypes)) {
            rawAuthTypeConfigs = rawAuthTypes;
        } else if (typeof rawAuthTypes === "string" && rawAuthTypes.trim().length > 0) {
            try {
                const parsed = JSON.parse(rawAuthTypes) as unknown;
                if (Array.isArray(parsed)) {
                    rawAuthTypeConfigs = parsed as ExchangeRegistryAuthConfigDoc[];
                } else {
                    elizaLogger.warn(
                        "exchange_registry.authTypes parsed to non-array payload; defaulting to empty authTypes",
                        { id: row.id }
                    );
                }
            } catch (error) {
                elizaLogger.warn(
                    "Failed to parse exchange_registry.authTypes JSON string; defaulting to empty authTypes",
                    error,
                    { id: row.id }
                );
            }
        } else if (rawAuthTypes != null) {
            elizaLogger.warn(
                "exchange_registry.authTypes is not an array/string payload; defaulting to empty authTypes",
                { id: row.id, type: typeof rawAuthTypes }
            );
        }

        authTypes = rawAuthTypeConfigs.map((option) => {
            const source = typeof option === "object" && option !== null ? option : {};
            const rawFields = Array.isArray(source.fields) ? source.fields : [];
            const normalizedAuthType =
                typeof source.type === "string" &&
                EXCHANGE_AUTH_TYPES.includes(source.type as ExchangeAuthType)
                    ? (source.type as ExchangeAuthType)
                    : "api_key_name_secret";
            return {
                type: normalizedAuthType,
                fields: rawFields.map((field) => {
                    const fieldSource =
                        typeof field === "object" && field !== null
                            ? (field as ExchangeRegistryAuthFieldDoc)
                            : {};
                    const inferredFieldType =
                        fieldSource.type === "secret" ? "secret" : "string";
                    return {
                        id: String(fieldSource.id ?? fieldSource.key ?? ""),
                        label: String(fieldSource.label ?? ""),
                        type: inferredFieldType,
                        required: Boolean(fieldSource.required),
                        description:
                            typeof fieldSource.description === "string"
                                ? fieldSource.description
                                : undefined,
                        placeholder:
                            typeof fieldSource.placeholder === "string"
                                ? fieldSource.placeholder
                                : undefined,
                    };
                }),
            };
        });

        const mappedDefaultAuthType =
            typeof row.defaultAuthType === "string" &&
            EXCHANGE_AUTH_TYPES.includes(row.defaultAuthType as ExchangeAuthType)
                ? (row.defaultAuthType as ExchangeAuthType)
                : undefined;
        return {
            id: row.id as ExchangeRegistryEntry["id"],
            name: String(row.name ?? ""),
            defaultAuthType: mappedDefaultAuthType,
            authTypes,
        };
    }

    private async seedExchangeRegistry(): Promise<void> {
        const now = Date.now();
        const seededExchangeIds = DEFAULT_EXCHANGE_REGISTRY.map((entry) => entry.id);
        const operations = DEFAULT_EXCHANGE_REGISTRY.map((entry) => ({
            updateOne: {
                filter: { id: entry.id },
                update: {
                    $set: {
                        name: entry.name,
                        defaultAuthType: entry.defaultAuthType ?? null,
                        authTypes: entry.authTypes ?? [],
                        updatedAt: now,
                    },
                    $setOnInsert: {
                        id: entry.id,
                        createdAt: now,
                    },
                },
                upsert: true,
            },
        }));

        if (operations.length === 0) {
            return;
        }

        const result = await this.collection<ExchangeRegistryDoc>("exchange_registry").bulkWrite(operations, {
            ordered: false,
        });
        elizaLogger.debug(
            "Ensured exchange_registry canonical definitions",
            {
                ids: seededExchangeIds,
                matchedCount: result.matchedCount,
                modifiedCount: result.modifiedCount,
                upsertedCount: result.upsertedCount,
            }
        );
    }

    private getCanonicalEmailUserId(email: string): UUID {
        const normalizedEmail = email.trim().toLowerCase();
        return stringToUuid(`email-user-${normalizedEmail}`);
    }

    private async migrateAuthAccountsToCanonicalIds(): Promise<void> {
        const rows = await this.collection<AccountDoc>("accounts")
            .find(
                {
                    email: { $type: "string" },
                    "details.source": "auth",
                },
                { projection: { email: 1 } }
            )
            .toArray();

        const emails = new Set<string>();
        for (const row of rows) {
            const raw = String(row.email ?? "").trim().toLowerCase();
            if (!raw || !raw.includes("@") || raw.endsWith("@anonymous.local")) {
                continue;
            }
            emails.add(raw);
        }

        if (emails.size === 0) {
            return;
        }

        let migratedCount = 0;
        for (const email of emails) {
            const preferredPrimaryId = this.getCanonicalEmailUserId(email);
            const result = await this.mergeDuplicateAccountsByEmail(email, preferredPrimaryId);
            if (result.primaryId === preferredPrimaryId) {
                migratedCount += result.mergedIds.length;
            }
        }

        if (migratedCount > 0) {
            elizaLogger.info(
                `Migrated ${migratedCount} account record(s) to canonical email IDs`
            );
        }
    }

    async init(): Promise<void> {
        await this.client.connect();
        this.db = this.client.db(this.databaseName);

        if (this.backendKind === "documentdb" && this.runtimeConfigSummary.tls && !this.runtimeConfigSummary.tlsCAFileConfigured) {
            elizaLogger.warn(
                "DocumentDB mode is running with TLS enabled but no DOCUMENTDB_CA_FILE/MONGODB_CA_FILE was provided. If your AWS cluster requires the Amazon CA bundle, set DOCUMENTDB_CA_FILE before cutover."
            );
        }

        await this.ensureIndexes();
        try {
            await this.seedExchangeRegistry();
        } catch (error) {
            elizaLogger.warn("Failed to seed exchange_registry collection", error);
        }

        try {
            await this.migrateAuthAccountsToCanonicalIds();
        } catch (error) {
            elizaLogger.warn("Failed to migrate auth accounts to canonical email IDs", error);
        }
    }

    async close(): Promise<void> {
        await this.client.close();
    }

    async getRoom(roomId: UUID): Promise<UUID | null> {
        const room = await this.collection<Document>("rooms").findOne(
            { id: roomId },
            { projection: { id: 1 } }
        );

        return room?.id ? (room.id as UUID) : null;
    }

    async getParticipantsForAccount(userId: UUID): Promise<Participant[]> {
        const rows = await this.collection<Document>("participants")
            .find({ userId })
            .toArray();

        return rows as unknown as Participant[];
    }

    async getParticipantsForRoom(roomId: UUID): Promise<UUID[]> {
        const rows = await this.collection<Document>("participants")
            .find({ roomId }, { projection: { userId: 1 } })
            .toArray();

        return rows
            .map((row) => row.userId)
            .filter((id): id is UUID => typeof id === "string") as UUID[];
    }

    async getParticipantUserState(
        roomId: UUID,
        userId: UUID
    ): Promise<"FOLLOWED" | "MUTED" | null> {
        const row = await this.collection<Document>("participants").findOne(
            { roomId, userId },
            { projection: { userState: 1 } }
        );

        const userState = row?.userState;
        if (userState === "FOLLOWED" || userState === "MUTED") {
            return userState;
        }

        return null;
    }

    async setParticipantUserState(
        roomId: UUID,
        userId: UUID,
        state: "FOLLOWED" | "MUTED" | null
    ): Promise<void> {
        await this.collection<Document>("participants").updateMany(
            { roomId, userId },
            { $set: { userState: state } }
        );
    }

    async getAccountById(userId: UUID): Promise<Account | null> {
        const account = await this.collection<AccountDoc>("accounts").findOne({ id: userId });
        if (!account) return null;

        return {
            id: account.id as UUID,
            name: String(account.name ?? ""),
            username: String(account.username ?? ""),
            email: account.email,
            avatarUrl: account.avatarUrl ?? undefined,
            details:
                typeof account.details === "string"
                    ? parseJson<Record<string, unknown>>(account.details, {})
                    : ((account.details as Record<string, unknown>) ?? {}),
        };
    }

    /**
     * Autotrading uplift §1.5 — fetch per-user trading preferences.
     * Returns null if no preferences are stored; callers should fall
     * back to the plugin-cex defaults.
     */
    async getUserTradingPreferences(userId: string): Promise<Record<string, unknown> | null> {
        const doc = await this.collection<Document>("user_trading_preferences").findOne({ userId });
        if (!doc) return null;
        const out: Record<string, unknown> = { ...(doc as unknown as Record<string, unknown>) };
        delete out._id;
        return out;
    }

    /**
     * Autotrading uplift §1.5 — upsert per-user trading preferences.
     * Optimistic concurrency check on `updatedAt` is left to the
     * caller (Phase 1 has a single writer per user).
     */
    async setUserTradingPreferences(
        userId: string,
        prefs: Record<string, unknown>,
    ): Promise<void> {
        const doc = { ...prefs, userId, updatedAt: new Date().toISOString() };
        await this.collection<Document>("user_trading_preferences").updateOne(
            { userId },
            { $set: doc },
            { upsert: true },
        );
    }

    /**
     * F3 — paper-orders ledger: upsert a paper order keyed on
     * (userId, order_id). The `ttl_at` field is converted to a Date
     * so the TTL index honors it; otherwise it would silently never
     * expire rows.
     */
    async paperOrdersAdd(record: Record<string, unknown>): Promise<void> {
        const userId = String(record.userId ?? "");
        const orderId = String(record.order_id ?? "");
        if (!userId || !orderId) return;
        const ttlMs = typeof record.ttl_at === "number" ? record.ttl_at : Date.now() + 86_400 * 1000;
        const doc = {
            ...record,
            userId,
            order_id: orderId,
            ttl_at: new Date(ttlMs),
        };
        await this.collection<Document>("paper_orders").updateOne(
            { userId, order_id: orderId },
            { $set: doc },
            { upsert: true },
        );
    }

    async paperOrdersGetByUser(
        userId: string,
        opts?: { statuses?: string[] },
    ): Promise<Record<string, unknown>[]> {
        const query: Record<string, unknown> = { userId };
        if (opts?.statuses?.length) {
            query.status = { $in: opts.statuses };
        }
        const rows = await this.collection<Document>("paper_orders")
            .find(query)
            .sort({ created_at: -1 })
            .toArray();
        return rows.map((doc) => {
            const out = { ...(doc as unknown as Record<string, unknown>) };
            delete out._id;
            // Normalize ttl_at back to a number for the in-memory shape.
            if (out.ttl_at instanceof Date) {
                out.ttl_at = out.ttl_at.getTime();
            }
            return out;
        });
    }

    async paperOrdersGetById(
        userId: string,
        orderId: string,
    ): Promise<Record<string, unknown> | null> {
        const doc = await this.collection<Document>("paper_orders").findOne({
            userId,
            order_id: orderId,
        });
        if (!doc) return null;
        const out = { ...(doc as unknown as Record<string, unknown>) };
        delete out._id;
        if (out.ttl_at instanceof Date) {
            out.ttl_at = out.ttl_at.getTime();
        }
        return out;
    }

    async paperOrdersUpdateStatus(
        userId: string,
        orderId: string,
        status: string,
    ): Promise<boolean> {
        const res = await this.collection<Document>("paper_orders").updateOne(
            { userId, order_id: orderId },
            { $set: { status, updated_at: new Date().toISOString() } },
        );
        return res.matchedCount > 0;
    }

    async paperFillsAdd(record: Record<string, unknown>): Promise<void> {
        const userId = String(record.userId ?? "");
        if (!userId) return;
        const ttlMs = typeof record.ttl_at === "number" ? record.ttl_at : Date.now() + 86_400 * 1000;
        await this.collection<Document>("paper_fills").insertOne({
            ...record,
            userId,
            ttl_at: new Date(ttlMs),
        });
    }

    async paperFillsGetByUser(userId: string): Promise<Record<string, unknown>[]> {
        const rows = await this.collection<Document>("paper_fills")
            .find({ userId })
            .sort({ filled_at: -1 })
            .toArray();
        return rows.map((doc) => {
            const out = { ...(doc as unknown as Record<string, unknown>) };
            delete out._id;
            if (out.ttl_at instanceof Date) {
                out.ttl_at = out.ttl_at.getTime();
            }
            return out;
        });
    }

    /**
     * Autotrading uplift §1.5 — append a risk-decision audit row.
     * Append-only; the unique index on request_id makes retries
     * idempotent.
     */
    async writeRiskDecision(record: Record<string, unknown>): Promise<void> {
        try {
            await this.collection<Document>("risk_decisions").insertOne({
                ...record,
                createdAt: record.createdAt ?? new Date(),
            });
        } catch (err) {
            // Duplicate request_id (E11000) is benign — the decision
            // is already recorded; treat as success.
            const code = (err as { code?: number }).code;
            if (code !== 11000) throw err;
        }
    }

    /**
     * Autotrading uplift §4.3 — append a shadow-mode decision row.
     * Append-only; the unique index on request_id makes retries
     * idempotent. Used by the strategy runtime's shadow path to
     * record hypothetical executions alongside paper-mode outcomes
     * for divergence analysis.
     */
    async writeShadowDecision(record: Record<string, unknown>): Promise<void> {
        try {
            await this.collection<Document>("shadow_decisions").insertOne({
                ...record,
                createdAt: record.createdAt ?? new Date(),
            });
        } catch (err) {
            const code = (err as { code?: number }).code;
            if (code !== 11000) throw err;
        }
    }

    /**
     * §6.2 — append an approval-decision audit row. Unique on
     * `(request_id, level)`; re-emits are idempotent.
     */
    async writeApprovalDecision(record: Record<string, unknown>): Promise<void> {
        try {
            await this.collection<Document>("approval_decisions").insertOne({
                ...record,
                createdAt: record.createdAt ?? new Date(),
            });
        } catch (err) {
            const code = (err as { code?: number }).code;
            if (code !== 11000) throw err;
        }
    }

    /** §6.3 — append a sanitized venue-call row. */
    async writeVenueCall(record: Record<string, unknown>): Promise<void> {
        await this.collection<Document>("venue_calls").insertOne({
            ...record,
            createdAt: record.createdAt ?? new Date(),
        });
    }

    /** §7.2 — kill-switch toggle log. */
    async writeKillSwitchEvent(record: Record<string, unknown>): Promise<void> {
        await this.collection<Document>("kill_switch_events").insertOne({
            ...record,
            createdAt: record.createdAt ?? new Date(),
        });
    }

    /** §7.3 — preferences-save audit. */
    async writePreferencesAudit(record: Record<string, unknown>): Promise<void> {
        await this.collection<Document>("preferences_audit").insertOne({
            ...record,
            createdAt: record.createdAt ?? new Date(),
        });
    }

    /** §7.8 — consent acceptance log. Idempotent on (userId, type, version). */
    async writeConsent(record: Record<string, unknown>): Promise<void> {
        try {
            await this.collection<Document>("consent_log").insertOne({
                ...record,
                acceptedAt: record.acceptedAt ?? new Date(),
            });
        } catch (err) {
            const code = (err as { code?: number }).code;
            if (code !== 11000) throw err;
        }
    }

    async getConsent(
        userId: string,
        consent_type: string,
        version: string,
    ): Promise<Record<string, unknown> | null> {
        const doc = await this.collection<Document>("consent_log").findOne({
            userId,
            consent_type,
            version,
        });
        if (!doc) return null;
        const out: Record<string, unknown> = { ...(doc as unknown as Record<string, unknown>) };
        delete out._id;
        return out;
    }

    /** §8.3 — credentials audit (saves + revokes). */
    async writeCredentialsAudit(record: Record<string, unknown>): Promise<void> {
        await this.collection<Document>("credentials_audit").insertOne({
            ...record,
            createdAt: record.createdAt ?? new Date(),
        });
    }

    /** §8.2 — RBAC denial log. */
    async writeRbacDecision(record: Record<string, unknown>): Promise<void> {
        await this.collection<Document>("rbac_decisions").insertOne({
            ...record,
            createdAt: record.createdAt ?? new Date(),
        });
    }

    /** §7.9 — append a notification row. */
    async writeNotification(record: Record<string, unknown>): Promise<void> {
        await this.collection<Document>("notifications").insertOne({
            ...record,
            createdAt: record.createdAt ?? new Date(),
            read: record.read ?? false,
        });
    }

    /**
     * §7.9 — list a user's notifications. Newest first.
     * No cursor pagination yet — Phase 7 UI caps at `limit ≤ 100`.
     */
    async listNotifications(
        userId: string,
        opts: { limit?: number; unreadOnly?: boolean } = {},
    ): Promise<Array<Record<string, unknown>>> {
        const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
        const filter: Record<string, unknown> = { userId };
        if (opts.unreadOnly) filter.read = false;
        const docs = await this.collection<Document>("notifications")
            .find(filter)
            .sort({ createdAt: -1 })
            .limit(limit)
            .toArray();
        return docs.map((d) => {
            const out: Record<string, unknown> = {
                ...(d as unknown as Record<string, unknown>),
            };
            delete out._id;
            return out;
        });
    }

    /** §7.9 — mark a notification read by id. */
    async markNotificationRead(userId: string, id: string): Promise<void> {
        await this.collection<Document>("notifications").updateOne(
            { userId, id },
            { $set: { read: true, readAt: new Date() } },
        );
    }

    /** §7.7 — strategy_instances writer. */
    async upsertStrategyInstance(record: Record<string, unknown>): Promise<void> {
        const id = record.id ?? record._id;
        if (!id) {
            await this.collection<Document>("strategy_instances").insertOne({
                ...record,
                started_at: record.started_at ?? new Date(),
                status: record.status ?? "active",
            });
            return;
        }
        await this.collection<Document>("strategy_instances").updateOne(
            { id },
            { $set: { ...record, updated_at: new Date() } },
            { upsert: true },
        );
    }

    async listStrategyInstances(userId: string): Promise<Array<Record<string, unknown>>> {
        const docs = await this.collection<Document>("strategy_instances")
            .find({ userId })
            .sort({ started_at: -1 })
            .toArray();
        return docs.map((d) => {
            const out: Record<string, unknown> = {
                ...(d as unknown as Record<string, unknown>),
            };
            delete out._id;
            return out;
        });
    }

    /** §7.6 — paginated read of pending_orders_ledger for the /orders route. */
    async listUserOrders(
        userId: string,
        opts: { limit?: number; venue?: string; state?: string } = {},
    ): Promise<Array<Record<string, unknown>>> {
        const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
        const filter: Record<string, unknown> = { userId };
        if (opts.venue) filter.venue = opts.venue;
        if (opts.state) filter.state = opts.state;
        const docs = await this.collection<Document>("pending_orders_ledger")
            .find(filter)
            .sort({ submittedAt: -1 })
            .limit(limit)
            .toArray();
        return docs.map((d) => {
            const out: Record<string, unknown> = {
                ...(d as unknown as Record<string, unknown>),
            };
            delete out._id;
            return out;
        });
    }

    /**
     * §6.0.3 — count of non-terminal `unknown`-state orders for a user on
     * the given `(venue, symbol)` older than `agedMs`. Used by
     * `unknownStateBlocker` to refuse new writes until reconciliation
     * resolves prior unresolved submits.
     */
    async countUnknownStateOrdersOnPair(
        userId: string,
        venue: string,
        symbol: string,
        agedMs = 5_000,
    ): Promise<number> {
        const cutoff = new Date(Date.now() - agedMs).toISOString();
        return this.collection<Document>("pending_orders_ledger").countDocuments({
            userId,
            venue,
            symbol,
            state: "unknown",
            submittedAt: { $lte: cutoff },
        });
    }

    async getAccountByEmail(email: string): Promise<Account | null> {
        const normalizedEmail = email.trim().toLowerCase();
        const account = await this.collection<AccountDoc>("accounts").findOne(
            { email: normalizedEmail },
            { sort: { createdAt: 1 } }
        );

        if (!account) return null;

        return {
            id: account.id as UUID,
            name: String(account.name ?? ""),
            username: String(account.username ?? ""),
            email: account.email,
            avatarUrl: account.avatarUrl ?? undefined,
            details:
                typeof account.details === "string"
                    ? parseJson<Record<string, unknown>>(account.details, {})
                    : ((account.details as Record<string, unknown>) ?? {}),
        };
    }

    async createAccount(account: Account): Promise<boolean> {
        try {
            const normalizedEmail = account.email?.trim().toLowerCase();
            if (normalizedEmail) {
                const existing = await this.collection<AccountDoc>("accounts").findOne(
                    { email: normalizedEmail },
                    { projection: { id: 1 }, sort: { createdAt: 1 } }
                );
                if (existing) {
                    elizaLogger.info(
                        `Account already exists for email ${normalizedEmail}; skipping create`
                    );
                    return true;
                }
            }

            await this.collection<AccountDoc>("accounts").insertOne({
                id: (account.id ?? (v4() as UUID)) as string,
                name: account.name,
                username: account.username,
                email: normalizedEmail ?? account.email,
                avatarUrl: account.avatarUrl ?? null,
                details: account.details ?? {},
                createdAt: Date.now(),
            });

            return true;
        } catch (error) {
            elizaLogger.error("Error creating account", error);
            return false;
        }
    }

    async mergeDuplicateAccountsByEmail(
        email: string,
        preferredPrimaryId?: UUID
    ): Promise<{
        primaryId: UUID | null;
        mergedIds: UUID[];
    }> {
        const normalizedEmail = email.trim().toLowerCase();
        const accounts = await this.collection<AccountDoc>("accounts")
            .find({ email: normalizedEmail })
            .sort({ createdAt: 1 })
            .toArray();

        if (accounts.length === 0) {
            return { primaryId: null, mergedIds: [] };
        }

        const normalizedPreferredPrimaryId = preferredPrimaryId?.trim()
            ? (preferredPrimaryId.trim() as UUID)
            : null;

        let primaryId = accounts[0].id as UUID;

        if (normalizedPreferredPrimaryId) {
            const preferredAccountById = await this.collection<AccountDoc>("accounts").findOne(
                { id: normalizedPreferredPrimaryId },
                { projection: { id: 1, email: 1 } }
            );

            if (
                preferredAccountById &&
                String(preferredAccountById.email ?? "").trim().toLowerCase() !== normalizedEmail
            ) {
                elizaLogger.warn(
                    `Preferred primary account id ${normalizedPreferredPrimaryId} belongs to a different email; skipping preferred id for ${normalizedEmail}`
                );
            } else {
                primaryId = normalizedPreferredPrimaryId;
            }
        }

        const primaryExists = accounts.some((account) => account.id === primaryId);
        if (!primaryExists) {
            const seed = accounts[0];
            await this.collection<AccountDoc>("accounts").insertOne({
                id: primaryId,
                createdAt: seed.createdAt,
                name: seed.name ?? undefined,
                username: seed.username ?? undefined,
                email: normalizedEmail,
                avatarUrl: seed.avatarUrl ?? null,
                details: seed.details ?? {},
            });
        }

        const duplicateIds = accounts
            .filter((account) => account.id !== primaryId)
            .map((account) => account.id as UUID);

        if (duplicateIds.length === 0) {
            return { primaryId, mergedIds: [] };
        }

        const inFilter = { $in: duplicateIds };

        await Promise.all([
            this.collection<Document>("memories").updateMany({ userId: inFilter }, { $set: { userId: primaryId } }),
            this.collection<Document>("goals").updateMany({ userId: inFilter }, { $set: { userId: primaryId } }),
            this.collection<Document>("logs").updateMany({ userId: inFilter }, { $set: { userId: primaryId } }),
            this.collection<Document>("participants").updateMany({ userId: inFilter }, { $set: { userId: primaryId } }),
            this.collection<Document>("relationships").updateMany({ userId: inFilter }, { $set: { userId: primaryId } }),
            this.collection<Document>("relationships").updateMany({ userA: inFilter }, { $set: { userA: primaryId } }),
            this.collection<Document>("relationships").updateMany({ userB: inFilter }, { $set: { userB: primaryId } }),
            this.collection<Document>("shared_taskchains").updateMany({ userId: inFilter }, { $set: { userId: primaryId } }),
            this.collection<Document>("token_usage").updateMany({ userId: inFilter }, { $set: { userId: primaryId } }),
            this.collection<Document>("subscription_events").updateMany({ userId: inFilter }, { $set: { userId: primaryId } }),
            this.collection<Document>("user_subscription_tier_history").updateMany({ userId: inFilter }, { $set: { userId: primaryId } }),
            this.collection<Document>("web_page_sessions").updateMany({ userId: inFilter }, { $set: { userId: primaryId } }),
            this.collection<Document>("referrals").updateMany({ referrerId: inFilter }, { $set: { referrerId: primaryId } }),
            this.collection<Document>("referral_codes").updateMany({ userId: inFilter }, { $set: { userId: primaryId } }),
        ]);

        for (const dupId of duplicateIds) {
            const favorites = await this.collection<FavoriteTaskChainDoc>("favorite_taskchains")
                .find({ userId: dupId })
                .toArray();

            for (const favorite of favorites) {
                const existing = await this.collection<FavoriteTaskChainDoc>("favorite_taskchains").findOne({
                    userId: primaryId,
                    agentId: favorite.agentId,
                    chainId: favorite.chainId,
                });

                if (existing) {
                    await this.collection<FavoriteTaskChainDoc>("favorite_taskchains").deleteOne({ id: favorite.id });
                } else {
                    await this.collection<FavoriteTaskChainDoc>("favorite_taskchains").updateOne(
                        { id: favorite.id },
                        { $set: { userId: primaryId } }
                    );
                }
            }
        }

        const primaryReferral = await this.collection<Document>("referrals").findOne({
            referredUserId: primaryId,
        });
        const duplicateReferrals = await this.collection<Document>("referrals")
            .find({ referredUserId: inFilter })
            .sort({ createdAt: 1 })
            .toArray();

        if (primaryReferral) {
            if (duplicateReferrals.length > 0) {
                await this.collection<Document>("referrals").deleteMany({
                    referredUserId: inFilter,
                });
            }
        } else if (duplicateReferrals.length > 0) {
            const [keep, ...drop] = duplicateReferrals;
            await this.collection<Document>("referrals").updateOne(
                { id: keep.id },
                { $set: { referredUserId: primaryId } }
            );
            if (drop.length > 0) {
                await this.collection<Document>("referrals").deleteMany({
                    id: { $in: drop.map((row) => row.id) },
                });
            }
        }

        const primaryReferralCode = await this.collection<Document>("user_referral_codes").findOne({
            userId: primaryId,
        });
        const duplicateReferralCodes = await this.collection<Document>("user_referral_codes")
            .find({ userId: inFilter })
            .toArray();

        if (primaryReferralCode) {
            if (duplicateReferralCodes.length > 0) {
                await this.collection<Document>("user_referral_codes").deleteMany({
                    id: { $in: duplicateReferralCodes.map((row) => row.id) },
                });
            }
        } else if (duplicateReferralCodes.length > 0) {
            const [keep, ...drop] = duplicateReferralCodes;
            await this.collection<Document>("user_referral_codes").updateOne(
                { id: keep.id },
                { $set: { userId: primaryId } }
            );
            if (drop.length > 0) {
                await this.collection<Document>("user_referral_codes").deleteMany({
                    id: { $in: drop.map((row) => row.id) },
                });
            }
        }

        const primarySubscription = await this.collection<Document>("user_subscriptions").findOne({
            userId: primaryId,
        });
        const duplicateSubscriptions = await this.collection<Document>("user_subscriptions")
            .find({ userId: inFilter })
            .toArray();

        if (primarySubscription) {
            if (duplicateSubscriptions.length > 0) {
                await this.collection<Document>("user_subscriptions").deleteMany({
                    id: { $in: duplicateSubscriptions.map((row) => row.id) },
                });
            }
        } else if (duplicateSubscriptions.length > 0) {
            const [keep, ...drop] = duplicateSubscriptions;
            await this.collection<Document>("user_subscriptions").updateOne(
                { id: keep.id },
                { $set: { userId: primaryId } }
            );
            if (drop.length > 0) {
                await this.collection<Document>("user_subscriptions").deleteMany({
                    id: { $in: drop.map((row) => row.id) },
                });
            }
        }

        await this.collection<AccountDoc>("accounts").deleteMany({ id: inFilter });

        elizaLogger.info(
            `Merged ${duplicateIds.length} duplicate account(s) into ${primaryId} for ${normalizedEmail}`
        );

        return {
            primaryId,
            mergedIds: duplicateIds,
        };
    }

    async updateAccountDetails(params: {
        userId: UUID;
        details: Record<string, any>;
    }): Promise<void> {
        await this.collection<AccountDoc>("accounts").updateOne(
            { id: params.userId },
            { $set: { details: params.details ?? {} } }
        );
    }

    async getActorDetails(params: { roomId: UUID }): Promise<Actor[]> {
        const participants = await this.collection<Document>("participants")
            .find({ roomId: params.roomId }, { projection: { userId: 1 } })
            .toArray();

        const userIds = participants
            .map((participant) => participant.userId)
            .filter((id): id is UUID => typeof id === "string");

        if (userIds.length === 0) {
            return [];
        }

        const accounts = await this.collection<AccountDoc>("accounts")
            .find({ id: { $in: userIds } })
            .toArray();

        return accounts.map((account) => {
            const detailsValue =
                typeof account.details === "string"
                    ? parseJson<Record<string, unknown>>(account.details, {})
                    : ((account.details as Record<string, unknown>) ?? {});

            const details = {
                tagline:
                    typeof detailsValue.tagline === "string" ? detailsValue.tagline : "",
                summary:
                    typeof detailsValue.summary === "string" ? detailsValue.summary : "",
                quote: typeof detailsValue.quote === "string" ? detailsValue.quote : "",
            };

            return {
                id: account.id as UUID,
                name: account.name ?? "",
                username: account.username ?? "",
                details,
            };
        });
    }

    async getMemoriesByRoomIds(params: {
        agentId: UUID;
        roomIds: UUID[];
        tableName: string;
        limit?: number;
    }): Promise<Memory[]> {
        const tableName = params.tableName || "messages";

        const rows = await this.collection<MemoryDoc>("memories")
            .find({
                type: tableName,
                agentId: params.agentId,
                roomId: { $in: params.roomIds },
            })
            .sort({ createdAt: -1 })
            .limit(params.limit ?? 0)
            .toArray();

        return rows.map((row) => this.mapMemoryDoc(row));
    }

    async getMemoryById(memoryId: UUID): Promise<Memory | null> {
        const row = await this.collection<MemoryDoc>("memories").findOne({ id: memoryId });
        return row ? this.mapMemoryDoc(row) : null;
    }

    async getMemoriesByIds(memoryIds: UUID[], tableName?: string): Promise<Memory[]> {
        if (memoryIds.length === 0) return [];

        const filter: Filter<MemoryDoc> = { id: { $in: memoryIds } };
        if (tableName) {
            filter.type = tableName;
        }

        const rows = await this.collection<MemoryDoc>("memories").find(filter).toArray();
        return rows.map((row) => this.mapMemoryDoc(row));
    }

    async getRecentUserMessages(params: {
        userId: UUID;
        agentId: UUID;
        limit: number;
        tableName?: string;
    }): Promise<Memory[]> {
        const tableName = params.tableName ?? "messages";
        const limit = params.limit > 0 ? params.limit : 5;

        const rows = await this.collection<MemoryDoc>("memories")
            .find({
                type: tableName,
                userId: params.userId,
                agentId: params.agentId,
            })
            .sort({ createdAt: -1 })
            .limit(limit)
            .toArray();

        return rows.map((row) => this.mapMemoryDoc(row));
    }

    async createMemory(memory: Memory, tableName: string): Promise<void> {
        let isUnique = true;
        const hasInputEmbedding =
            Array.isArray(memory.embedding) && memory.embedding.length > 0;
        const normalizedEmbedding = hasInputEmbedding
            ? this.normalizeEmbedding(memory.embedding, tableName, "embedding")
            : undefined;

        if (hasInputEmbedding && normalizedEmbedding) {
            const hasSimilar = await this.hasSimilarMemory(normalizedEmbedding, {
                tableName,
                agentId: memory.agentId,
                roomId: memory.roomId,
                threshold: 0.95,
            });

            isUnique = !hasSimilar;
        }

        const id = (memory.id ?? (v4() as UUID)) as UUID;
        const createdAt = memory.createdAt ?? Date.now();
        const payload: MemoryDoc = {
            id,
            type: tableName,
            content: memory.content,
            embedding: normalizedEmbedding,
            userId: memory.userId,
            roomId: memory.roomId,
            agentId: memory.agentId,
            unique: isUnique,
            createdAt,
            clientIP:
                memory.clientIP !== undefined && memory.clientIP !== null
                    ? String(memory.clientIP)
                    : null,
        };

        try {
            await this.collection<MemoryDoc>("memories").insertOne(payload);
        } catch (error) {
            if (!isDuplicateKeyError(error)) {
                throw error;
            }
            await this.collection<MemoryDoc>("memories").updateOne(
                { id },
                { $set: payload }
            );
        }
    }

    async updateMemoryContent(params: {
        id: UUID;
        tableName: string;
        content: Memory["content"];
    }): Promise<void> {
        await this.collection<MemoryDoc>("memories").updateOne(
            { id: params.id, type: params.tableName },
            { $set: { content: params.content } }
        );
    }

    async searchMemories(params: {
        tableName: string;
        roomId: UUID;
        agentId?: UUID;
        embedding: number[];
        match_threshold: number;
        match_count: number;
        unique: boolean;
    }): Promise<Memory[]> {
        const filter: Filter<MemoryDoc> = {
            type: params.tableName,
            roomId: params.roomId,
        };

        if (params.unique) {
            filter.unique = true;
        }

        if (params.agentId) {
            filter.agentId = params.agentId;
        }

        const queryEmbedding = this.normalizeEmbedding(params.embedding, params.tableName, "search");
        const matchCount = params.match_count > 0 ? params.match_count : 10;
        const rows = await this.fetchMemoryCandidates(
            filter,
            this.candidateLimit(matchCount, this.searchMaxCandidates)
        );
        const scored = this.scoreTopMemories(
            rows,
            queryEmbedding,
            matchCount,
            params.match_threshold ?? 0
        );

        return scored.map((row) => this.mapMemoryDoc(row));
    }

    async searchMemoriesByEmbedding(
        embedding: number[],
        params: {
            match_threshold?: number;
            count?: number;
            roomId?: UUID;
            agentId?: UUID;
            unique?: boolean;
            tableName: string;
        }
    ): Promise<Memory[]> {
        const filter: Filter<MemoryDoc> = {
            type: params.tableName,
            embedding: { $exists: true },
        };

        if (params.agentId) {
            filter.agentId = params.agentId;
        }

        if (params.unique) {
            filter.unique = true;
        }

        if (params.roomId) {
            filter.roomId = params.roomId;
        }

        const queryEmbedding = this.normalizeEmbedding(embedding, params.tableName, "search");
        const threshold = params.match_threshold ?? 0;
        const count = params.count ?? 10;
        const candidateCap =
            count === 1 && threshold >= 0.9
                ? this.dedupeMaxCandidates
                : this.searchMaxCandidates;
        const rows = await this.fetchMemoryCandidates(
            filter,
            this.candidateLimit(count, candidateCap)
        );
        const scored = this.scoreTopMemories(rows, queryEmbedding, count, threshold);

        return scored.map((row) => this.mapMemoryDoc(row));
    }

    // getCachedEmbeddings removed — see packages/core/src/data/database.ts.

    async updateGoalStatus(params: {
        goalId: UUID;
        status: GoalStatus;
    }): Promise<void> {
        await this.collection<GoalDoc>("goals").updateOne(
            { id: params.goalId },
            { $set: { status: params.status } }
        );
    }

    async log(params: {
        body: { [key: string]: unknown };
        userId: UUID;
        roomId: UUID;
        type: string;
    }): Promise<void> {
        await this.collection<Document>("logs").insertOne({
            id: v4(),
            body: params.body,
            userId: params.userId,
            roomId: params.roomId,
            type: params.type,
            createdAt: Date.now(),
        });
    }

    async getMemories(params: {
        roomId: UUID;
        count?: number;
        unique?: boolean;
        tableName: string;
        agentId: UUID;
        start?: number;
        end?: number;
    }): Promise<Memory[]> {
        if (!params.tableName) {
            throw new Error("tableName is required");
        }
        if (!params.roomId) {
            throw new Error("roomId is required");
        }

        const filter: Filter<MemoryDoc> = {
            type: params.tableName,
            agentId: params.agentId,
            roomId: params.roomId,
        };

        if (params.unique) {
            filter.unique = true;
        }

        if (params.start || params.end) {
            const createdAtFilter: Record<string, number> = {};
            if (params.start) {
                createdAtFilter.$gte = params.start;
            }
            if (params.end) {
                createdAtFilter.$lte = params.end;
            }
            (filter as Document).createdAt = createdAtFilter;
        }

        const cursor = this.collection<MemoryDoc>("memories")
            .find(filter, { projection: this.memoryProjection })
            .sort({ createdAt: -1 });
        if (params.count) {
            cursor.limit(params.count);
        }

        const rows = await cursor.toArray();
        return rows.map((row) => this.mapMemoryDoc(row));
    }

    async removeMemory(memoryId: UUID, tableName: string): Promise<void> {
        await this.collection<MemoryDoc>("memories").deleteOne({
            type: tableName,
            id: memoryId,
        });
    }

    async removeAllMemories(roomId: UUID, tableName: string): Promise<void> {
        await this.collection<MemoryDoc>("memories").deleteMany({
            type: tableName,
            roomId,
        });
    }

    async countMemories(roomId: UUID, unique = true, tableName = ""): Promise<number> {
        if (!tableName) {
            throw new Error("tableName is required");
        }

        const filter: Filter<MemoryDoc> = {
            type: tableName,
            roomId,
        };

        if (unique) {
            filter.unique = true;
        }

        return this.collection<MemoryDoc>("memories").countDocuments(filter);
    }

    async countUserMessages(params: {
        userId: UUID;
        tableName?: string;
        agentId?: UUID;
        since?: number;
    }): Promise<number> {
        const tableName = params.tableName ?? "messages";

        if (!params.userId) {
            throw new Error("userId is required to count user messages");
        }

        const filter: Filter<MemoryDoc> = {
            type: tableName,
            userId: params.userId,
        };

        if (params.agentId) {
            filter.agentId = params.agentId;
        }

        if (typeof params.since === "number") {
            filter.createdAt = { $gte: params.since };
        }

        return this.collection<MemoryDoc>("memories").countDocuments(filter);
    }

    async getFavoriteTaskChains(params: {
        userId: UUID;
        agentId: UUID;
    }): Promise<FavoriteTaskChainRecord[]> {
        const rows = await this.collection<FavoriteTaskChainDoc>("favorite_taskchains")
            .find({ userId: params.userId, agentId: params.agentId })
            .sort({ createdAt: -1 })
            .toArray();

        return rows.map((row) => this.mapFavoriteTaskChainDoc(row));
    }

    async getFavoriteTaskChain(params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
    }): Promise<FavoriteTaskChainRecord | null> {
        const row = await this.collection<FavoriteTaskChainDoc>("favorite_taskchains").findOne({
            id: params.favoriteId,
            userId: params.userId,
            agentId: params.agentId,
        });

        return row ? this.mapFavoriteTaskChainDoc(row) : null;
    }

    async getFavoriteTaskChainByChain(params: {
        chainId: string;
        userId: UUID;
        agentId: UUID;
    }): Promise<FavoriteTaskChainRecord | null> {
        const row = await this.collection<FavoriteTaskChainDoc>("favorite_taskchains").findOne({
            chainId: params.chainId,
            userId: params.userId,
            agentId: params.agentId,
        });

        return row ? this.mapFavoriteTaskChainDoc(row) : null;
    }

    async createFavoriteTaskChain(
        params: FavoriteTaskChainCreateInput
    ): Promise<FavoriteTaskChainRecord> {
        const favoriteId = v4() as UUID;
        const createdAt = params.createdAt ?? Date.now();

        const doc: FavoriteTaskChainDoc = {
            id: favoriteId,
            userId: params.userId,
            agentId: params.agentId,
            chainId: params.chainId,
            name: params.name,
            originalName: params.originalName,
            description: params.description ?? null,
            taskChain: params.taskChain,
            createdAt,
            isPublic: params.isPublic ?? false,
            executionCount: 0,
        };

        await this.collection<FavoriteTaskChainDoc>("favorite_taskchains").insertOne(doc);

        return this.mapFavoriteTaskChainDoc(doc);
    }

    async removeFavoriteTaskChain(params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
    }): Promise<void> {
        const result = await this.collection<FavoriteTaskChainDoc>("favorite_taskchains").deleteOne({
            id: params.favoriteId,
            userId: params.userId,
            agentId: params.agentId,
        });

        if (result.deletedCount === 0) {
            throw new Error("Favorite task chain not found");
        }
    }

    async updateFavoriteTaskChainName(params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
        name: string;
    }): Promise<void> {
        const result = await this.collection<FavoriteTaskChainDoc>("favorite_taskchains").updateOne(
            {
                id: params.favoriteId,
                userId: params.userId,
                agentId: params.agentId,
            },
            { $set: { name: params.name } }
        );

        if (result.matchedCount === 0) {
            throw new Error("Favorite task chain not found");
        }
    }

    async updateFavoriteTaskChainVisibility(params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
        isPublic: boolean;
    }): Promise<FavoriteTaskChainRecord> {
        const result = await this.collection<FavoriteTaskChainDoc>("favorite_taskchains").findOneAndUpdate(
            {
                id: params.favoriteId,
                userId: params.userId,
                agentId: params.agentId,
            },
            { $set: { isPublic: params.isPublic } },
            { returnDocument: "after" }
        );

        if (!result) {
            throw new Error("Favorite task chain not found");
        }

        return this.mapFavoriteTaskChainDoc(result);
    }

    async markFavoriteTaskChainUsed(params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
        timestamp?: number;
    }): Promise<void> {
        const result = await this.collection<FavoriteTaskChainDoc>("favorite_taskchains").updateOne(
            {
                id: params.favoriteId,
                userId: params.userId,
                agentId: params.agentId,
            },
            {
                $set: { lastUsedAt: params.timestamp ?? Date.now() },
                $inc: { executionCount: 1 },
            }
        );

        if (result.matchedCount === 0) {
            throw new Error("Favorite task chain not found");
        }
    }

    async getSharedTaskChainByFavorite(params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
    }): Promise<SharedTaskChainRecord | null> {
        const row = await this.collection<SharedTaskChainDoc>("shared_taskchains").findOne({
            favoriteId: params.favoriteId,
            userId: params.userId,
            agentId: params.agentId,
        });

        return row ? this.mapSharedTaskChainDoc(row) : null;
    }

    async createSharedTaskChain(
        params: SharedTaskChainCreateInput
    ): Promise<SharedTaskChainRecord> {
        const sharedId = v4() as UUID;
        const createdAt = params.createdAt ?? Date.now();

        const doc: SharedTaskChainDoc = {
            id: sharedId,
            shareCode: params.shareCode,
            favoriteId: params.favoriteId ?? null,
            userId: params.userId,
            agentId: params.agentId,
            chainId: params.chainId,
            name: params.name,
            originalName: params.originalName,
            description: params.description ?? null,
            taskChain: params.taskChain,
            createdAt,
        };

        await this.collection<SharedTaskChainDoc>("shared_taskchains").insertOne(doc);
        return this.mapSharedTaskChainDoc(doc);
    }

    async getSharedTaskChainByCode(shareCode: string): Promise<SharedTaskChainRecord | null> {
        const row = await this.collection<SharedTaskChainDoc>("shared_taskchains").findOne({
            shareCode,
        });

        return row ? this.mapSharedTaskChainDoc(row) : null;
    }

    async getTrendingTaskChains(params: {
        agentId: UUID;
        limit?: number;
    }): Promise<
        Array<{
            chainId: string;
            name: string;
            description: string | null;
            totalExecutions: number;
            lastUsedAt: number | null;
            sampleFavoriteId: UUID | null;
            sampleUserId: UUID | null;
        }>
    > {
        const limit = params.limit ?? 3;

        const rows = await this.collection<FavoriteTaskChainDoc>("favorite_taskchains")
            .aggregate<{
                chainId: string;
                name: string;
                description: string | null;
                totalExecutions: number;
                lastUsedAt: number | null;
                sampleFavoriteId: UUID | null;
                sampleUserId: UUID | null;
            }>([
                {
                    $match: {
                        agentId: params.agentId,
                        executionCount: { $gt: 0 },
                        isPublic: true,
                    },
                },
                {
                    $group: {
                        _id: {
                            chainId: "$chainId",
                            originalName: "$originalName",
                            description: "$description",
                        },
                        totalExecutions: { $sum: "$executionCount" },
                        lastUsedAt: { $max: "$lastUsedAt" },
                        sampleFavoriteId: { $first: "$id" },
                        sampleUserId: { $first: "$userId" },
                    },
                },
                {
                    $sort: {
                        totalExecutions: -1,
                        lastUsedAt: -1,
                    },
                },
                { $limit: limit },
                {
                    $project: {
                        _id: 0,
                        chainId: "$_id.chainId",
                        name: "$_id.originalName",
                        description: "$_id.description",
                        totalExecutions: 1,
                        lastUsedAt: { $ifNull: ["$lastUsedAt", null] },
                        sampleFavoriteId: { $ifNull: ["$sampleFavoriteId", null] },
                        sampleUserId: { $ifNull: ["$sampleUserId", null] },
                    },
                },
            ])
            .toArray();

        return rows;
    }

    async getGoals(params: {
        roomId: UUID;
        userId?: UUID | null;
        onlyInProgress?: boolean;
        count?: number;
    }): Promise<Goal[]> {
        const filter: Filter<GoalDoc> = { roomId: params.roomId };

        if (params.userId) {
            filter.userId = params.userId;
        }

        if (params.onlyInProgress) {
            filter.status = "IN_PROGRESS" as GoalStatus;
        }

        const cursor = this.collection<GoalDoc>("goals").find(filter);
        if (params.count) {
            cursor.limit(params.count);
        }

        const goals = await cursor.toArray();
        return goals.map((goal) => ({
            id: goal.id as UUID,
            roomId: goal.roomId,
            userId: goal.userId,
            name: goal.name,
            status: goal.status,
            objectives:
                typeof goal.objectives === "string"
                    ? parseJson<Goal["objectives"]>(goal.objectives, [])
                    : goal.objectives,
        }));
    }

    async updateGoal(goal: Goal): Promise<void> {
        await this.collection<GoalDoc>("goals").updateOne(
            { id: goal.id as UUID },
            {
                $set: {
                    name: goal.name,
                    status: goal.status,
                    objectives: goal.objectives,
                },
            }
        );
    }

    async createGoal(goal: Goal): Promise<void> {
        await this.collection<GoalDoc>("goals").insertOne({
            id: (goal.id ?? (v4() as UUID)) as string,
            roomId: goal.roomId,
            userId: goal.userId,
            name: goal.name,
            status: goal.status,
            objectives: goal.objectives,
            createdAt: Date.now(),
        });
    }

    async removeGoal(goalId: UUID): Promise<void> {
        await this.collection<GoalDoc>("goals").deleteOne({ id: goalId });
    }

    async removeAllGoals(roomId: UUID): Promise<void> {
        await this.collection<GoalDoc>("goals").deleteMany({ roomId });
    }

    async createRoom(roomId?: UUID, name?: string, agentId?: UUID): Promise<UUID> {
        const id = roomId || (v4() as UUID);
        try {
            await this.collection<Document>("rooms").insertOne({
                id,
                name: name ?? null,
                agentId: agentId ?? null,
                createdAt: Date.now(),
            });
        } catch (error) {
            elizaLogger.error("Error creating room", error);
        }

        return id as UUID;
    }

    async getRoomById(roomId: UUID): Promise<{ id: UUID; name?: string; createdAt: string } | null> {
        try {
            const room = await this.collection<Document>("rooms").findOne(
                { id: roomId },
                { projection: { id: 1, name: 1, createdAt: 1 } }
            );

            if (!room) return null;

            return {
                id: room.id as UUID,
                name: typeof room.name === "string" ? room.name : undefined,
                createdAt: new Date(toTimestamp(room.createdAt)).toISOString(),
            };
        } catch (error) {
            elizaLogger.error("Error getting room", error);
            return null;
        }
    }

    async removeAllMemoriesByRoom(roomId: UUID): Promise<void> {
        await this.collection<Document>("memories").deleteMany({ roomId });
    }

    async removeLogsByRoom(roomId: UUID): Promise<void> {
        await this.collection<Document>("logs").deleteMany({ roomId });
    }

    async removeRoom(roomId: UUID): Promise<void> {
        await this.collection<Document>("rooms").deleteOne({ id: roomId });
    }

    async updateRoomName(roomId: UUID, name: string): Promise<void> {
        await this.collection<Document>("rooms").updateOne(
            { id: roomId },
            { $set: { name } }
        );
    }

    async removeParticipantsByRoom(roomId: UUID): Promise<void> {
        await this.collection<Document>("participants").deleteMany({ roomId });
    }
    async getSharedChatByRoom(params: {
        agentId: UUID;
        roomId: UUID;
    }): Promise<SharedChatRecord | null> {
        const row = await this.collection<Document>("shared_chats").findOne({
            agentId: params.agentId,
            roomId: params.roomId,
        });
        if (!row) return null;
        return {
            id: String(row._id) as UUID,
            shareCode: row.shareCode as string,
            userId: row.userId as UUID,
            agentId: row.agentId as UUID,
            roomId: row.roomId as UUID,
            createdAt: typeof row.createdAt === "number" ? row.createdAt : new Date(row.createdAt).getTime(),
        };
    }

    async createSharedChat(params: SharedChatCreateInput): Promise<SharedChatRecord> {
        const sharedId = v4() as UUID;
        const createdAt = params.createdAt ?? Date.now();
        await this.collection<Document>("shared_chats").insertOne({
            _id: sharedId as any,
            shareCode: params.shareCode,
            userId: params.userId,
            agentId: params.agentId,
            roomId: params.roomId,
            createdAt,
        });
        return { id: sharedId, shareCode: params.shareCode, userId: params.userId, agentId: params.agentId, roomId: params.roomId, createdAt };
    }

    async getSharedChatByCode(shareCode: string): Promise<SharedChatRecord | null> {
        const row = await this.collection<Document>("shared_chats").findOne({ shareCode });
        if (!row) return null;
        return {
            id: String(row._id) as UUID,
            shareCode: row.shareCode as string,
            userId: row.userId as UUID,
            agentId: row.agentId as UUID,
            roomId: row.roomId as UUID,
            createdAt: typeof row.createdAt === "number" ? row.createdAt : new Date(row.createdAt).getTime(),
        };
    }


    async getRoomsForParticipant(userId: UUID, agentId?: UUID): Promise<UUID[]> {
        const filter: Filter<Document> = { userId };
        if (agentId) {
            filter.agentId = agentId;
        }

        const rows = await this.collection<Document>("participants")
            .find(filter, { projection: { roomId: 1 } })
            .toArray();

        return rows
            .map((row) => row.roomId)
            .filter((roomId): roomId is UUID => typeof roomId === "string");
    }

    async getRoomsForParticipants(userIds: UUID[]): Promise<UUID[]> {
        const rows = await this.collection<Document>("participants")
            .find({ userId: { $in: userIds } }, { projection: { roomId: 1 } })
            .toArray();

        return Array.from(
            new Set(
                rows
                    .map((row) => row.roomId)
                    .filter((roomId): roomId is UUID => typeof roomId === "string")
            )
        );
    }

    async addParticipant(userId: UUID, roomId: UUID, agentId?: UUID): Promise<boolean> {
        try {
            await this.collection<Document>("participants").insertOne({
                id: v4(),
                userId,
                roomId,
                agentId: agentId ?? null,
                createdAt: Date.now(),
            });
            return true;
        } catch (error) {
            elizaLogger.error("Error adding participant", error);
            return false;
        }
    }

    async removeParticipant(userId: UUID, roomId: UUID): Promise<boolean> {
        try {
            await this.collection<Document>("participants").deleteMany({ userId, roomId });
            return true;
        } catch (error) {
            elizaLogger.error("Error removing participant", error);
            return false;
        }
    }

    async createRelationship(params: {
        userA: UUID;
        userB: UUID;
    }): Promise<boolean> {
        if (!params.userA || !params.userB) {
            throw new Error("userA and userB are required");
        }

        await this.collection<Document>("relationships").insertOne({
            id: v4(),
            userA: params.userA,
            userB: params.userB,
            userId: params.userA,
            createdAt: Date.now(),
        });

        return true;
    }

    async getRelationship(params: {
        userA: UUID;
        userB: UUID;
    }): Promise<Relationship | null> {
        const row = await this.collection<Document>("relationships").findOne({
            $or: [
                { userA: params.userA, userB: params.userB },
                { userA: params.userB, userB: params.userA },
            ],
        });

        return (row as Relationship | null) ?? null;
    }

    async getRelationships(params: { userId: UUID }): Promise<Relationship[]> {
        const rows = await this.collection<Document>("relationships")
            .find({
                $or: [{ userA: params.userId }, { userB: params.userId }],
            })
            .toArray();

        return rows as unknown as Relationship[];
    }

    async getCache(params: {
        key: string;
        agentId: UUID;
    }): Promise<string | undefined> {
        const row = await this.collection<CacheDoc>("cache").findOne(
            { key: params.key, agentId: params.agentId },
            { projection: { value: 1 } }
        );

        return row?.value ?? undefined;
    }

    async setCache(params: {
        key: string;
        agentId: UUID;
        value: string;
    }): Promise<boolean> {
        await this.collection<CacheDoc>("cache").updateOne(
            { key: params.key, agentId: params.agentId },
            {
                $set: {
                    key: params.key,
                    agentId: params.agentId,
                    value: params.value,
                    createdAt: Date.now(),
                },
            },
            { upsert: true }
        );

        return true;
    }

    async deleteCache(params: {
        key: string;
        agentId: UUID;
    }): Promise<boolean> {
        try {
            await this.collection<CacheDoc>("cache").deleteOne({
                key: params.key,
                agentId: params.agentId,
            });
            return true;
        } catch (error) {
            elizaLogger.error("Error removing cache", error);
            return false;
        }
    }

    async getKnowledge(params: {
        id?: UUID;
        agentId: UUID;
        limit?: number;
        query?: string;
    }): Promise<RAGKnowledgeItem[]> {
        const filter: Filter<KnowledgeDoc> = {
            $or: [{ agentId: params.agentId }, { isShared: true }],
        };

        if (params.id) {
            filter.id = params.id;
        }

        const cursor = this.collection<KnowledgeDoc>("knowledge").find(filter);
        if (params.limit) {
            cursor.limit(params.limit);
        }

        const rows = await cursor.toArray();
        return rows.map((row) => this.mapKnowledgeDoc(row));
    }

    async searchKnowledge(params: {
        agentId: UUID;
        embedding: Float32Array;
        match_threshold: number;
        match_count: number;
        searchText?: string;
    }): Promise<RAGKnowledgeItem[]> {
        const cacheKey = `embedding_${params.agentId}_${params.searchText ?? ""}`;
        const cachedResult = await this.getCache({
            key: cacheKey,
            agentId: params.agentId,
        });

        if (cachedResult) {
            return parseJson<RAGKnowledgeItem[]>(cachedResult, []);
        }

        const queryEmbedding = this.normalizeEmbedding(
            params.embedding,
            "knowledge",
            "search"
        );

        const rows = await this.collection<KnowledgeDoc>("knowledge")
            .find({
                $or: [{ agentId: params.agentId }, { isShared: true }],
                embedding: { $exists: true },
            })
            .toArray();

        const searchText = (params.searchText ?? "").toLowerCase();

        const results = rows
            .map((row) => {
                const embedding = Array.isArray(row.embedding) ? row.embedding : [];
                const vectorScore = cosineSimilarity(queryEmbedding, embedding);

                const content =
                    typeof row.content === "string"
                        ? parseJson<RAGKnowledgeItem["content"]>(row.content, { text: "" })
                        : row.content;

                const text = String(content?.text ?? "").toLowerCase();
                const metadata = content?.metadata ?? {};

                let keywordScore = text.includes(searchText) && searchText.length > 0 ? 3.0 : 1.0;

                if (metadata.isChunk === true) {
                    keywordScore *= 1.5;
                } else if (metadata.isMain === true) {
                    keywordScore *= 1.2;
                }

                const combinedScore = vectorScore * keywordScore;

                return {
                    row,
                    vectorScore,
                    keywordScore,
                    combinedScore,
                };
            })
            .filter(
                (item) =>
                    item.vectorScore >= params.match_threshold ||
                    (item.keywordScore > 1.0 && item.vectorScore >= 0.3)
            )
            .sort((a, b) => b.combinedScore - a.combinedScore)
            .slice(0, params.match_count)
            .map((item) => ({
                ...this.mapKnowledgeDoc(item.row),
                similarity: item.combinedScore,
            }));

        await this.setCache({
            key: cacheKey,
            agentId: params.agentId,
            value: JSON.stringify(results),
        });

        return results;
    }

    async createKnowledge(knowledge: RAGKnowledgeItem): Promise<void> {
        const metadata = knowledge.content.metadata || {};
        const normalizedEmbedding =
            knowledge.embedding && knowledge.embedding.length > 0
                ? this.normalizeEmbedding(
                      knowledge.embedding,
                      metadata.isShared ? "knowledge" : "embedding",
                      "knowledge"
                  )
                : undefined;

        const doc: KnowledgeDoc = {
            id: knowledge.id,
            agentId: metadata.isShared ? null : knowledge.agentId,
            content: knowledge.content,
            embedding: normalizedEmbedding,
            createdAt: knowledge.createdAt ?? Date.now(),
            isMain: metadata.isMain ? true : false,
            originalId: metadata.originalId ?? null,
            chunkIndex: metadata.chunkIndex ?? null,
            isShared: metadata.isShared ? true : false,
        };

        try {
            await this.collection<KnowledgeDoc>("knowledge").insertOne(doc);
        } catch (error) {
            if (metadata.isShared && isDuplicateKeyError(error)) {
                elizaLogger.info(`Shared knowledge ${knowledge.id} already exists, skipping`);
                return;
            }

            if (!isDuplicateKeyError(error)) {
                elizaLogger.error(`Error creating knowledge ${knowledge.id}:`, {
                    error,
                    embeddingLength: knowledge.embedding?.length,
                    content: knowledge.content,
                });
                throw error;
            }

            elizaLogger.debug(`Knowledge ${knowledge.id} already exists, skipping`);
        }
    }

    async removeKnowledge(id: UUID): Promise<void> {
        if (typeof id !== "string") {
            throw new Error("Knowledge ID must be a string");
        }

        if (id.includes("*")) {
            const regex = new RegExp(`^${id.replace(/\*/g, ".*")}$`);
            await this.collection<KnowledgeDoc>("knowledge").deleteMany({ id: regex as any });
            return;
        }

        await this.collection<KnowledgeDoc>("knowledge").deleteMany({
            $or: [
                { id },
                { originalId: id },
                { "content.metadata.originalId": id },
            ],
        });
    }

    async clearKnowledge(agentId: UUID, shared?: boolean): Promise<void> {
        if (shared) {
            await this.collection<KnowledgeDoc>("knowledge").deleteMany({
                $or: [{ agentId }, { isShared: true }],
            });
            return;
        }

        await this.collection<KnowledgeDoc>("knowledge").deleteMany({ agentId });
    }

    async searchActionCache(params: {
        queryEmbedding: number[];
        actionName?: string;
        similarityThreshold: number;
        querySimilarityThreshold: number;
        limit: number;
    }): Promise<CachedActionResult[]> {
        const {
            queryEmbedding,
            actionName,
            similarityThreshold,
            querySimilarityThreshold,
            limit,
        } = params;

        try {
            const normalizedEmbedding = this.normalizeEmbedding(
                queryEmbedding,
                "action_cache",
                "search"
            );

            const now = Date.now();

            const filter: Filter<ActionCacheDoc> = {
                expiresAt: { $gt: now },
            };

            if (actionName) {
                filter.actionName = actionName;
            }

            const rows = await this.collection<ActionCacheDoc>("action_cache")
                .find(filter)
                .toArray();

            if (rows.length === 0) {
                elizaLogger.debug("No matching queries found in action cache");
                return [];
            }

            const queryGrouped = new Map<string, { minQueryDistance: number; chunkCount: number }>();
            for (const row of rows) {
                const querySimilarity = cosineSimilarity(
                    normalizedEmbedding,
                    row.queryEmbedding ?? []
                );
                const queryDistance = 1 - querySimilarity;
                const existing = queryGrouped.get(row.query);
                if (!existing || queryDistance < existing.minQueryDistance) {
                    queryGrouped.set(row.query, {
                        minQueryDistance: queryDistance,
                        chunkCount: existing ? existing.chunkCount + 1 : 1,
                    });
                } else {
                    existing.chunkCount += 1;
                }
            }

            const bestQueryEntry = Array.from(queryGrouped.entries()).sort(
                (a, b) => a[1].minQueryDistance - b[1].minQueryDistance
            )[0];

            if (!bestQueryEntry) {
                return [];
            }

            const bestQuery = bestQueryEntry[0];
            elizaLogger.debug(
                `Best matching query: "${bestQuery}" (distance: ${bestQueryEntry[1].minQueryDistance}, chunks: ${bestQueryEntry[1].chunkCount})`
            );

            const scoredRows = rows.map((row) => {
                const resultSimilarity = cosineSimilarity(normalizedEmbedding, row.embedding ?? []);
                const querySimilarity = cosineSimilarity(
                    normalizedEmbedding,
                    row.queryEmbedding ?? []
                );
                return {
                    row,
                    resultSimilarity,
                    querySimilarity,
                };
            });

            const queryBasedRows = scoredRows
                .filter((item) => item.row.query === bestQuery)
                .sort((a, b) => b.resultSimilarity - a.resultSimilarity);

            const chunkBasedRows = scoredRows
                .sort((a, b) => b.resultSimilarity - a.resultSimilarity)
                .slice(0, 50);

            const toCachedActionResult = (
                item: (typeof scoredRows)[number]
            ): CachedActionResult => ({
                id: item.row.id as UUID,
                actionName: item.row.actionName,
                query: item.row.query,
                result: item.row.result,
                chunkIndex: item.row.chunkIndex,
                totalChunks: item.row.totalChunks,
                createdAt: toTimestamp(item.row.createdAt),
                expiresAt: item.row.expiresAt,
                hitCount: item.row.hitCount,
                similarity: item.resultSimilarity,
                querySimilarity: item.querySimilarity,
            });

            const selectedQueryBased = queryBasedRows.slice(0, 3).map(toCachedActionResult);

            const top7Chunks = chunkBasedRows.slice(0, 7);
            const random2FromTop7 = randomSample(top7Chunks, 2);

            const percentileIndex = Math.floor(chunkBasedRows.length * 0.4);
            const top40PercentChunks = chunkBasedRows.slice(
                0,
                Math.max(percentileIndex, 7)
            );
            const random2FromTop40 = randomSample(top40PercentChunks, 2);

            const selectedChunkBased = [...random2FromTop7, ...random2FromTop40].map(
                toCachedActionResult
            );

            const allSelected = [...selectedQueryBased, ...selectedChunkBased];
            const seenIds = new Set<string>();
            const deduplicated: CachedActionResult[] = [];

            for (const chunk of allSelected) {
                if (!seenIds.has(chunk.id)) {
                    seenIds.add(chunk.id);
                    deduplicated.push(chunk);
                }
            }

            if (deduplicated.length < 7) {
                const remaining = chunkBasedRows
                    .map(toCachedActionResult)
                    .filter((chunk) => !seenIds.has(chunk.id));
                deduplicated.push(...remaining.slice(0, 7 - deduplicated.length));
            }

            const finalResults = deduplicated
                .slice(0, 7)
                .filter((chunk) => {
                    const querySimilarityValue = chunk.querySimilarity ?? 0;
                    const resultSimilarityValue = chunk.similarity ?? 0;

                    const passesQueryThreshold =
                        querySimilarityValue >= querySimilarityThreshold;
                    const averageSimilarity =
                        (resultSimilarityValue + querySimilarityValue) / 2;
                    const passesAverageThreshold =
                        querySimilarityValue < querySimilarityThreshold &&
                        averageSimilarity >= similarityThreshold;

                    return passesQueryThreshold || passesAverageThreshold;
                })
                .slice(0, Math.max(limit, 1));

            elizaLogger.debug(
                `Final results: ${finalResults.length} chunks after similarity filtering`
            );

            return finalResults;
        } catch (error) {
            elizaLogger.error("Error searching action cache:", error);
            return [];
        }
    }

    async createActionCache(params: {
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
    }): Promise<void> {
        const queryEmbedding = this.normalizeEmbedding(
            params.queryEmbedding,
            "action_cache_query",
            "embedding"
        );
        const embedding = this.normalizeEmbedding(
            params.embedding,
            "action_cache_result",
            "embedding"
        );

        await this.collection<ActionCacheDoc>("action_cache").updateOne(
            { id: params.id },
            {
                $set: {
                    id: params.id,
                    actionName: params.actionName,
                    query: params.query,
                    queryEmbedding,
                    result: params.result,
                    chunkIndex: params.chunkIndex,
                    totalChunks: params.totalChunks,
                    embedding,
                    createdAt: params.createdAt,
                    expiresAt: params.expiresAt,
                    hitCount: params.hitCount,
                },
            },
            { upsert: true }
        );
    }

    async incrementActionCacheHitCount(ids: UUID[]): Promise<void> {
        if (ids.length === 0) return;

        await this.collection<ActionCacheDoc>("action_cache").updateMany(
            { id: { $in: ids } },
            { $inc: { hitCount: 1 } }
        );
    }

    async cleanupExpiredActionCache(): Promise<number> {
        const result = await this.collection<ActionCacheDoc>("action_cache").deleteMany({
            expiresAt: { $lte: Date.now() },
        });

        return result.deletedCount;
    }

    async getActionCacheStats(): Promise<{
        totalEntries: number;
        totalHits: number;
        actionBreakdown: Record<string, number>;
    }> {
        const [totalEntries, hitsRows, breakdownRows] = await Promise.all([
            this.collection<ActionCacheDoc>("action_cache").countDocuments({}),
            this.collection<ActionCacheDoc>("action_cache")
                .aggregate<{ totalHits: number }>([
                    { $group: { _id: null, totalHits: { $sum: "$hitCount" } } },
                ])
                .toArray(),
            this.collection<ActionCacheDoc>("action_cache")
                .aggregate<{ actionName: string; count: number }>([
                    { $group: { _id: "$actionName", count: { $sum: 1 } } },
                    { $project: { _id: 0, actionName: "$_id", count: 1 } },
                ])
                .toArray(),
        ]);

        const actionBreakdown: Record<string, number> = {};
        for (const row of breakdownRows) {
            actionBreakdown[row.actionName] = row.count;
        }

        return {
            totalEntries,
            totalHits: hitsRows[0]?.totalHits ?? 0,
            actionBreakdown,
        };
    }

    async getOrCreateReferralCode(userId: UUID): Promise<string> {
        const existing = await this.collection<Document>("referral_codes").findOne(
            { userId },
            { sort: { createdAt: 1 }, projection: { referralCode: 1 } }
        );

        if (existing?.referralCode) {
            return String(existing.referralCode);
        }

        const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let code = "";
        let attempts = 0;
        const maxAttempts = 100;

        while (attempts < maxAttempts) {
            // M11: Use crypto.randomBytes for unpredictable referral codes.
            // Use the top-level ESM import — `require("crypto")` is fatal here
            // because tsup builds this package as ESM and esbuild's runtime
            // stub for dynamic require throws "Dynamic require of "crypto" is
            // not supported", which surfaced as every call to
            // /authentication/referral-code/ returning a generic 500.
            const buf = randomBytes(5);
            code = "";
            for (let i = 0; i < 5; i++) {
                code += characters.charAt(buf[i] % characters.length);
            }

            const duplicate = await this.collection<Document>("referral_codes").findOne(
                { referralCode: code },
                { projection: { id: 1 } }
            );
            if (!duplicate) {
                break;
            }

            attempts += 1;
        }

        if (attempts >= maxAttempts) {
            throw new Error("Failed to generate unique referral code");
        }

        await this.collection<Document>("referral_codes").insertOne({
            id: v4(),
            userId,
            referralCode: code,
            createdAt: Date.now(),
        });

        return code;
    }

    async getUserIdByReferralCode(code: string): Promise<UUID | null> {
        const result = await this.collection<Document>("referral_codes").findOne(
            { referralCode: code },
            { projection: { userId: 1 } }
        );

        return result?.userId ? (result.userId as UUID) : null;
    }

    async validateReferralCode(code: string): Promise<boolean> {
        const count = await this.collection<Document>("referral_codes").countDocuments({
            referralCode: code,
        });

        return count > 0;
    }

    async createReferral(params: {
        referredUserId: UUID;
        referralCode: string;
    }): Promise<boolean> {
        try {
            const referrerId = await this.getUserIdByReferralCode(params.referralCode);
            if (!referrerId) {
                elizaLogger.warn(`Invalid referral code: ${params.referralCode}`);
                return false;
            }

            const existing = await this.collection<Document>("referrals").findOne(
                { referredUserId: params.referredUserId },
                { projection: { id: 1 } }
            );

            if (existing) {
                elizaLogger.warn(`User ${params.referredUserId} already has a referrer`);
                return false;
            }

            if (referrerId === params.referredUserId) {
                elizaLogger.warn(`User ${params.referredUserId} attempted self-referral`);
                return false;
            }

            await this.collection<Document>("referrals").insertOne({
                id: v4(),
                referrerId,
                referredUserId: params.referredUserId,
                referralCode: params.referralCode,
                createdAt: Date.now(),
            });

            return true;
        } catch (error) {
            elizaLogger.error("Error creating referral:", error);
            return false;
        }
    }

    async getReferrerByUserId(userId: UUID): Promise<UUID | null> {
        const result = await this.collection<Document>("referrals").findOne(
            { referredUserId: userId },
            { projection: { referrerId: 1 } }
        );

        return result?.referrerId ? (result.referrerId as UUID) : null;
    }

    async getReferredUsers(referrerId: UUID): Promise<
        Array<{
            userId: UUID;
            email: string;
            createdAt: number;
        }>
    > {
        const referrals = await this.collection<Document>("referrals")
            .find({ referrerId })
            .sort({ createdAt: -1 })
            .toArray();

        if (referrals.length === 0) {
            return [];
        }

        const userIds = referrals
            .map((ref) => ref.referredUserId)
            .filter((id): id is UUID => typeof id === "string");

        const accounts = await this.collection<AccountDoc>("accounts")
            .find({ id: { $in: userIds } }, { projection: { id: 1, email: 1 } })
            .toArray();

        const emailByUserId = new Map(accounts.map((acc) => [acc.id, acc.email ?? ""]));

        return referrals.map((row) => ({
            userId: row.referredUserId as UUID,
            email: String(emailByUserId.get(row.referredUserId as UUID) ?? ""),
            createdAt: toTimestamp(row.createdAt),
        }));
    }

    async recordUserReferralCode(params: {
        userId: UUID;
        referralCodeUsed: string;
        isMatched: boolean;
    }): Promise<boolean> {
        try {
            const existing = await this.collection<Document>("user_referral_codes").findOne(
                { userId: params.userId },
                { projection: { id: 1 } }
            );

            if (existing) {
                elizaLogger.debug(`User ${params.userId} referral code already recorded`);
                return true;
            }

            await this.collection<Document>("user_referral_codes").insertOne({
                id: v4(),
                userId: params.userId,
                referralCodeUsed: params.referralCodeUsed,
                isMatched: params.isMatched,
                createdAt: Date.now(),
            });

            return true;
        } catch (error) {
            elizaLogger.error("Error recording user referral code:", error);
            return false;
        }
    }

    async getUserReferralCode(userId: UUID): Promise<{
        referralCodeUsed: string;
        isMatched: boolean;
        createdAt: number;
    } | null> {
        const result = await this.collection<Document>("user_referral_codes").findOne(
            { userId },
            { projection: { referralCodeUsed: 1, isMatched: 1, createdAt: 1 } }
        );

        if (!result) {
            return null;
        }

        return {
            referralCodeUsed: String(result.referralCodeUsed ?? ""),
            isMatched: result.isMatched === true || result.isMatched === 1,
            createdAt: toTimestamp(result.createdAt),
        };
    }

    async recordSubscriptionTierChange(params: {
        userId: UUID;
        tier: "free" | "plus" | "pro" | "enterprise";
        source?: string;
        observedAt?: number;
    }): Promise<boolean> {
        const observedAt =
            typeof params.observedAt === "number" && Number.isFinite(params.observedAt)
                ? Math.floor(params.observedAt)
                : Date.now();

        const source =
            typeof params.source === "string" && params.source.trim().length > 0
                ? params.source.trim()
                : "stripe_api";

        try {
            const accountRow = await this.collection<AccountDoc>("accounts").findOne(
                { id: params.userId },
                { projection: { details: 1 } }
            );

            if (!accountRow) {
                elizaLogger.warn(
                    `recordSubscriptionTierChange skipped: account not found for ${params.userId}`
                );
                return false;
            }

            const latestRow = await this.collection<Document>("user_subscription_tier_history").findOne(
                { userId: params.userId },
                {
                    projection: { tier: 1, observedAt: 1 },
                    sort: { observedAt: -1, createdAt: -1, id: -1 },
                }
            );

            if (latestRow?.tier === params.tier) {
                return false;
            }

            let details: Record<string, any> = {};
            const currentDetails = accountRow.details;
            if (typeof currentDetails === "string") {
                details = parseJson<Record<string, any>>(currentDetails, {});
            } else if (currentDetails && typeof currentDetails === "object") {
                details = currentDetails as Record<string, any>;
            }

            const updatedDetails = {
                ...details,
                subscriptionTier: {
                    currentTier: params.tier,
                    previousTier: (latestRow?.tier as string | undefined) ?? null,
                    changedAt: observedAt,
                    source,
                },
            };

            await this.collection<Document>("user_subscription_tier_history").insertOne({
                id: v4(),
                userId: params.userId,
                tier: params.tier,
                source,
                observedAt,
                createdAt: Date.now(),
            });

            await this.collection<AccountDoc>("accounts").updateOne(
                { id: params.userId },
                { $set: { details: updatedDetails } }
            );

            return true;
        } catch (error) {
            elizaLogger.error("Error recording subscription tier change:", error);
            return false;
        }
    }

    async recordSubscriptionEvent(params: {
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
    }): Promise<boolean> {
        try {
            await this.collection<Document>("subscription_events").insertOne({
                id: v4(),
                userId: params.userId,
                eventType: params.eventType,
                stripeEventId: params.stripeEventId,
                stripeCustomerId: params.stripeCustomerId ?? null,
                stripeSubscriptionId: params.stripeSubscriptionId ?? null,
                subscriptionStatus: params.subscriptionStatus ?? null,
                planName: params.planName ?? null,
                amountCents: params.amountCents ?? null,
                currency: params.currency ?? null,
                eventData: params.eventData,
                createdAt: Date.now(),
            });

            return true;
        } catch (error) {
            if (isDuplicateKeyError(error)) {
                elizaLogger.debug(`Duplicate Stripe event ignored: ${params.stripeEventId}`);
                return false;
            }

            elizaLogger.error("Error recording subscription event:", error);
            return false;
        }
    }

    async updateUserSubscription(params: {
        userId: UUID;
        stripeCustomerId?: string;
        stripeSubscriptionId?: string;
        subscriptionStatus: string;
        planName?: string;
        currentPeriodStart?: number;
        currentPeriodEnd?: number;
        cancelAtPeriodEnd?: boolean;
        lastEventId: string;
    }): Promise<boolean> {
        try {
            const existing = await this.collection<Document>("user_subscriptions").findOne(
                { userId: params.userId },
                { projection: { id: 1 } }
            );

            if (existing) {
                await this.collection<Document>("user_subscriptions").updateOne(
                    { userId: params.userId },
                    {
                        $set: {
                            stripeCustomerId: params.stripeCustomerId ?? null,
                            stripeSubscriptionId: params.stripeSubscriptionId ?? null,
                            subscriptionStatus: params.subscriptionStatus,
                            planName: params.planName ?? null,
                            currentPeriodStart: params.currentPeriodStart ?? null,
                            currentPeriodEnd: params.currentPeriodEnd ?? null,
                            cancelAtPeriodEnd: Boolean(params.cancelAtPeriodEnd),
                            lastEventId: params.lastEventId,
                            updatedAt: Date.now(),
                        },
                    }
                );
            } else {
                await this.collection<Document>("user_subscriptions").insertOne({
                    id: v4(),
                    userId: params.userId,
                    stripeCustomerId: params.stripeCustomerId ?? null,
                    stripeSubscriptionId: params.stripeSubscriptionId ?? null,
                    subscriptionStatus: params.subscriptionStatus,
                    planName: params.planName ?? null,
                    currentPeriodStart: params.currentPeriodStart ?? null,
                    currentPeriodEnd: params.currentPeriodEnd ?? null,
                    cancelAtPeriodEnd: Boolean(params.cancelAtPeriodEnd),
                    lastEventId: params.lastEventId,
                    updatedAt: Date.now(),
                    createdAt: Date.now(),
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error("Error updating user subscription:", error);
            return false;
        }
    }

    async getUserSubscription(userId: UUID): Promise<{
        subscriptionStatus: string;
        planName: string | null;
        currentPeriodEnd: number | null;
    } | null> {
        const row = await this.collection<Document>("user_subscriptions").findOne(
            { userId },
            {
                projection: {
                    subscriptionStatus: 1,
                    planName: 1,
                    currentPeriodEnd: 1,
                },
            }
        );

        if (!row) {
            return null;
        }

        return {
            subscriptionStatus: String(row.subscriptionStatus ?? ""),
            planName:
                row.planName === null || row.planName === undefined
                    ? null
                    : String(row.planName),
            currentPeriodEnd:
                row.currentPeriodEnd === null || row.currentPeriodEnd === undefined
                    ? null
                    : Number(row.currentPeriodEnd),
        };
    }

    async getSubscriptionEvents(
        userId: UUID,
        options?: {
            limit?: number;
            offset?: number;
            eventType?: string;
        }
    ): Promise<
        Array<{
            eventType: string;
            amountCents: number | null;
            currency: string | null;
            createdAt: number;
        }>
    > {
        const filter: Filter<Document> = { userId };

        if (options?.eventType) {
            filter.eventType = options.eventType;
        }

        const cursor = this.collection<Document>("subscription_events")
            .find(filter, {
                projection: {
                    eventType: 1,
                    amountCents: 1,
                    currency: 1,
                    createdAt: 1,
                },
            })
            .sort({ createdAt: -1 });

        if (options?.offset) {
            cursor.skip(options.offset);
        }

        if (options?.limit) {
            cursor.limit(options.limit);
        }

        const rows = await cursor.toArray();

        return rows.map((row) => ({
            eventType: String(row.eventType ?? ""),
            amountCents:
                row.amountCents === null || row.amountCents === undefined
                    ? null
                    : Number(row.amountCents),
            currency:
                row.currency === null || row.currency === undefined
                    ? null
                    : String(row.currency),
            createdAt: toTimestamp(row.createdAt),
        }));
    }

    async getUserByStripeCustomerId(stripeCustomerId: string): Promise<{
        userId: UUID;
    } | null> {
        const row = await this.collection<Document>("user_subscriptions").findOne(
            { stripeCustomerId },
            { projection: { userId: 1 } }
        );

        if (!row?.userId) {
            return null;
        }

        return { userId: row.userId as UUID };
    }

    async getReferralStats(referrerId: UUID): Promise<{
        totalReferrals: number;
        activeSubscriptions: number;
        totalRevenue: number;
        currency: string;
    }> {
        try {
            const codes = await this.collection<Document>("referral_codes")
                .find({ userId: referrerId }, { projection: { referralCode: 1 } })
                .toArray();

            const codeValues = codes
                .map((row) => row.referralCode)
                .filter((value): value is string => typeof value === "string");

            let totalReferrals = 0;
            if (codeValues.length > 0) {
                totalReferrals = await this.collection<Document>("user_referral_codes").countDocuments(
                    {
                        referralCodeUsed: { $in: codeValues },
                        isMatched: true,
                    }
                );
            }

            const referrals = await this.collection<Document>("referrals")
                .find({ referrerId }, { projection: { referredUserId: 1 } })
                .toArray();
            const referredUserIds = referrals
                .map((row) => row.referredUserId)
                .filter((id): id is UUID => typeof id === "string");

            if (referredUserIds.length === 0) {
                return {
                    totalReferrals,
                    activeSubscriptions: 0,
                    totalRevenue: 0,
                    currency: "usd",
                };
            }

            const activeSubscriptions = await this.collection<Document>("user_subscriptions").countDocuments({
                userId: { $in: referredUserIds },
                subscriptionStatus: { $in: ["active", "trialing", "past_due"] },
            });

            const eventRows = await this.collection<Document>("subscription_events")
                .find(
                    {
                        userId: { $in: referredUserIds },
                        eventType: "invoice.payment_succeeded",
                        amountCents: { $ne: null },
                    },
                    {
                        projection: {
                            amountCents: 1,
                            currency: 1,
                        },
                    }
                )
                .toArray();

            const revenueByCurrency = new Map<string, number>();
            for (const row of eventRows) {
                const amount = Number(row.amountCents ?? 0);
                if (!Number.isFinite(amount)) {
                    continue;
                }
                const currency = String(row.currency ?? "usd").toLowerCase();
                revenueByCurrency.set(currency, (revenueByCurrency.get(currency) ?? 0) + amount);
            }

            let topCurrency = "usd";
            let topRevenue = 0;
            for (const [currency, revenue] of revenueByCurrency.entries()) {
                if (revenue > topRevenue) {
                    topRevenue = revenue;
                    topCurrency = currency;
                }
            }

            return {
                totalReferrals,
                activeSubscriptions,
                totalRevenue: topRevenue,
                currency: topCurrency,
            };
        } catch (error) {
            elizaLogger.error("Error getting referral stats:", error);
            return {
                totalReferrals: 0,
                activeSubscriptions: 0,
                totalRevenue: 0,
                currency: "usd",
            };
        }
    }

    async saveTokenUsage(params: {
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
    }): Promise<void> {
        return this.withCircuitBreaker(async () => {
            const userExists = await this.collection<AccountDoc>("accounts").findOne(
                { id: params.userId as UUID },
                { projection: { id: 1 } }
            );

            if (!userExists) {
                elizaLogger.debug(
                    `Skipping token usage save for anonymous user: ${params.userId}`
                );
                return;
            }

            await this.collection<Document>("token_usage").insertOne({
                id: params.id,
                userId: params.userId,
                agentId: params.agentId,
                roomId: params.roomId ?? null,
                inputTokens: params.inputTokens,
                outputTokens: params.outputTokens,
                totalTokens: params.totalTokens,
                modelProvider: params.modelProvider ?? null,
                modelName: params.modelName ?? null,
                modelClass: params.modelClass ?? null,
                timestamp: params.timestamp,
                createdAt: Date.now(),
            });
        }, "saveTokenUsage");
    }

    async getUserTokenUsage(params: {
        userId: string;
        since: number;
        until?: number;
    }): Promise<{
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
    }> {
        return this.withCircuitBreaker(async () => {
            const timeFilter: Document = { $gte: params.since };
            if (typeof params.until === "number") {
                timeFilter.$lt = params.until;
            }

            const rows = await this.collection<Document>("token_usage")
                .aggregate<{
                    inputTokens: number;
                    outputTokens: number;
                    totalTokens: number;
                }>([
                    {
                        $match: {
                            userId: params.userId,
                            timestamp: timeFilter,
                        },
                    },
                    {
                        $group: {
                            _id: null,
                            inputTokens: { $sum: "$inputTokens" },
                            outputTokens: { $sum: "$outputTokens" },
                            totalTokens: { $sum: "$totalTokens" },
                        },
                    },
                    {
                        $project: {
                            _id: 0,
                            inputTokens: 1,
                            outputTokens: 1,
                            totalTokens: 1,
                        },
                    },
                ])
                .toArray();

            return {
                inputTokens: rows[0]?.inputTokens ?? 0,
                outputTokens: rows[0]?.outputTokens ?? 0,
                totalTokens: rows[0]?.totalTokens ?? 0,
            };
        }, "getUserTokenUsage");
    }

    async getUserFirstTokenUsageTimestamp(params: {
        userId: string;
    }): Promise<number | null> {
        return this.withCircuitBreaker(async () => {
            const row = await this.collection<Document>("token_usage")
                .find({ userId: params.userId }, { projection: { timestamp: 1 } })
                .sort({ timestamp: 1 })
                .limit(1)
                .toArray();

            if (!row[0]?.timestamp) {
                return null;
            }

            return Number(row[0].timestamp);
        }, "getUserFirstTokenUsageTimestamp");
    }

    async cleanupOldTokenUsage(olderThan: number): Promise<number> {
        return this.withCircuitBreaker(async () => {
            const result = await this.collection<Document>("token_usage").deleteMany({
                timestamp: { $lt: olderThan },
            });

            elizaLogger.info(`Cleaned up ${result.deletedCount} old token usage records`);
            return result.deletedCount;
        }, "cleanupOldTokenUsage");
    }

    async getExchangeRegistry(): Promise<ExchangeRegistryEntry[]> {
        const rows = await this.collection<ExchangeRegistryDoc>("exchange_registry")
            .find({})
            .sort({ name: 1 })
            .toArray();
        return rows.map((row) => this.mapExchangeRegistryEntry(row));
    }

    async getExchangeRegistryEntry(id: string): Promise<ExchangeRegistryEntry | null> {
        const normalizedId = id.trim().toLowerCase();
        if (!normalizedId) {
            return null;
        }
        const row = await this.collection<ExchangeRegistryDoc>("exchange_registry").findOne({
            id: normalizedId,
        });
        if (!row) return null;
        return this.mapExchangeRegistryEntry(row);
    }
}

const mongodbDatabaseAdapter: Adapter = {
    init: (runtime: IAgentRuntime) => {
        const config = resolveMongoRuntimeConfig(runtime);
        const backendLabel =
            config.backendKind === "documentdb"
                ? "DocumentDB-compatible"
                : "Mongo-compatible";

        elizaLogger.info(
            `Initializing ${backendLabel} database '${config.databaseName}' using ${config.connectionStringSource} and ${config.databaseNameSource}.`
        );
        elizaLogger.info(
            `${backendLabel} runtime config: tls=${config.summary.tls}, tlsCAFileConfigured=${config.summary.tlsCAFileConfigured}, retryWrites=${config.summary.retryWrites}, directConnection=${config.summary.directConnection ?? "auto"}, maxPoolSize=${config.summary.maxPoolSize}, minPoolSize=${config.summary.minPoolSize}, serverSelectionTimeoutMS=${config.summary.serverSelectionTimeoutMS}.`
        );

        const db = new MongoDatabaseAdapter(config);

        db.init()
            .then(() => {
                elizaLogger.success(`Successfully connected to ${backendLabel} database`);
            })
            .catch((error) => {
                elizaLogger.error(`Failed to connect to ${backendLabel} database:`, error);
            });

        return db as any;
    },
};

const mongodbPlugin: Plugin = {
    name: "mongodb",
    description: "MongoDB database adapter plugin",
    adapters: [mongodbDatabaseAdapter],
};

export default mongodbPlugin;
