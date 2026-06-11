import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";
import type { RunnableConfig } from "@langchain/core/runnables";
import { getEnvVariable } from "../config/settings.ts";
import { elizaLogger } from "./logger.ts";

const DEFAULT_ENDPOINT = "https://api.smith.langchain.com";
const DEFAULT_PROJECT = "senti-agent";

const API_KEY_KEYS = ["LANGCHAIN_API_KEY", "LANGSMITH_API_KEY"] as const;
const ENDPOINT_KEYS = ["LANGCHAIN_ENDPOINT", "LANGSMITH_ENDPOINT"] as const;
const PROJECT_KEYS = ["LANGCHAIN_PROJECT", "LANGSMITH_PROJECT"] as const;
const TRACING_KEYS = ["LANGCHAIN_TRACING_V2", "LANGSMITH_TRACING_V2"] as const;

let cachedTracer: LangChainTracer | null = null;
let cachedProjectName: string | undefined;
let envInitialized = false;
let hasLoggedInitialization = false;

type PrimitiveRecord = Record<string, unknown>;

const SANITIZE_MAX_DEPTH = 4;
const SANITIZE_MAX_ARRAY_LENGTH = 50;
const SANITIZE_MAX_MAP_ENTRIES = 50;

function sanitizeForLangSmith(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: any,
    depth = 0,
    seen: WeakSet<object> = new WeakSet()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
    if (value === null || value === undefined) {
        return value;
    }

    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
        return value;
    }

    if (typeof value === "bigint") {
        return value.toString();
    }

    if (typeof value === "symbol") {
        return value.toString();
    }

    if (typeof value === "function") {
        return `[Function${value.name ? `:${value.name}` : ""}]`;
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: value.stack
        };
    }

    if (typeof Promise !== "undefined" && value instanceof Promise) {
        return "[Promise]";
    }

    if (typeof value === "object") {
        if (seen.has(value as object)) {
            return "[Circular]";
        }

        if (depth >= SANITIZE_MAX_DEPTH) {
            if (Array.isArray(value)) {
                return `[Array depth>${SANITIZE_MAX_DEPTH} length=${value.length}]`;
            }
            return `[Object depth>${SANITIZE_MAX_DEPTH}]`;
        }

        seen.add(value as object);

        try {
            if (Array.isArray(value)) {
                return value
                    .slice(0, SANITIZE_MAX_ARRAY_LENGTH)
                    .map(item => sanitizeForLangSmith(item, depth + 1, seen));
            }

            if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
                return `[Buffer length=${value.length}]`;
            }

            if (value instanceof ArrayBuffer) {
                return `[ArrayBuffer byteLength=${value.byteLength}]`;
            }

            if (ArrayBuffer.isView(value)) {
                const arrayBufferView = value as ArrayBufferView;
                const length = (arrayBufferView as { length?: number }).length ?? arrayBufferView.byteLength;
                return `[TypedArray length=${length}]`;
            }

            if (value instanceof Map) {
                const result: Record<string, unknown> = {};
                let index = 0;
                for (const [key, mapValue] of value.entries()) {
                    if (index >= SANITIZE_MAX_MAP_ENTRIES) {
                        break;
                    }
                    const mapKey = typeof key === "string" ? key : JSON.stringify(sanitizeForLangSmith(key, depth + 1, seen));
                    result[mapKey] = sanitizeForLangSmith(mapValue, depth + 1, seen);
                    index += 1;
                }
                return result;
            }

            if (value instanceof Set) {
                const entries: unknown[] = [];
                let index = 0;
                for (const item of value.values()) {
                    if (index >= SANITIZE_MAX_ARRAY_LENGTH) {
                        break;
                    }
                    entries.push(sanitizeForLangSmith(item, depth + 1, seen));
                    index += 1;
                }
                return entries;
            }

            if (value instanceof RegExp) {
                return value.toString();
            }

            if (typeof (value as { toJSON?: () => unknown }).toJSON === "function") {
                try {
                    const jsonValue = (value as { toJSON: () => unknown }).toJSON();
                    return sanitizeForLangSmith(jsonValue, depth + 1, seen);
                } catch {
                    // Fall through to standard object handling
                }
            }

            const entries = Object.entries(value as Record<string, unknown>);
            const result: Record<string, unknown> = {};
            for (const [key, entryValue] of entries) {
                if (entryValue === undefined) {
                    continue;
                }
                result[key] = sanitizeForLangSmith(entryValue, depth + 1, seen);
            }
            return result;
        } finally {
            seen.delete(value as object);
        }
    }

    return value;
}

class SafeLangChainTracer extends LangChainTracer {
    private sanitizeRunTree(runTree: any) {
        if (!runTree) {
            return;
        }

        const visited = new Set<string>();

        const sanitizeNode = (node: any) => {
            if (!node) {
                return;
            }

            if (typeof node.id === "string") {
                if (visited.has(node.id)) {
                    return;
                }
                visited.add(node.id);
            }

            node.inputs = sanitizeForLangSmith(node.inputs);
            node.outputs = sanitizeForLangSmith(node.outputs);
            node.error = sanitizeForLangSmith(node.error);
            node.extra = sanitizeForLangSmith(node.extra);
            node.attachments = sanitizeForLangSmith(node.attachments);
            node.serialized = sanitizeForLangSmith(node.serialized);
            node.events = sanitizeForLangSmith(node.events);

            if (Array.isArray(node.child_runs)) {
                for (const child of node.child_runs) {
                    sanitizeNode(child);
                }
            }
        };

        sanitizeNode(runTree);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public override getRunTreeWithTracingConfig(id: string): any {
        const runTree = super.getRunTreeWithTracingConfig(id);
        if (runTree) {
            this.sanitizeRunTree(runTree);
        }
        return runTree;
    }
}

export interface LangSmithRunnableOptions<TConfig extends PrimitiveRecord = PrimitiveRecord> {
    apiKey?: string;
    endpoint?: string;
    projectName?: string;
    runName?: string;
    tags?: string[];
    metadata?: PrimitiveRecord;
    configurable?: TConfig;
}

function readFirstEnvValue(keys: readonly string[]): string | undefined {
    for (const key of keys) {
        const value = getEnvVariable(key);
        if (typeof value === "string" && value.trim().length > 0) {
            return value.trim();
        }
    }
    return undefined;
}

function setEnvIfUnset(key: string, value?: string) {
    if (typeof process === "undefined" || typeof process.env === "undefined") {
        return;
    }
    if (!value || value.length === 0) {
        return;
    }
    if (!process.env[key]) {
        process.env[key] = value;
    }
}

function ensureLangSmithEnvironment(options: {
    apiKey?: string;
    endpoint?: string;
    projectName?: string;
}) {
    if (envInitialized) {
        return;
    }

    const apiKey = options.apiKey ?? readFirstEnvValue(API_KEY_KEYS);
    if (!apiKey) {
        return;
    }

    const endpoint = options.endpoint ?? readFirstEnvValue(ENDPOINT_KEYS) ?? DEFAULT_ENDPOINT;
    const projectName = options.projectName ?? readFirstEnvValue(PROJECT_KEYS);

    for (const key of API_KEY_KEYS) {
        setEnvIfUnset(key, apiKey);
    }

    for (const key of TRACING_KEYS) {
        setEnvIfUnset(key, "true");
    }

    setEnvIfUnset("LANGCHAIN_ENDPOINT", endpoint);
    setEnvIfUnset("LANGSMITH_ENDPOINT", endpoint);

    if (projectName) {
        setEnvIfUnset("LANGCHAIN_PROJECT", projectName);
        setEnvIfUnset("LANGSMITH_PROJECT", projectName);
    }

    envInitialized = true;
}

function resolveProjectName(preferred?: string): string {
    return (
        preferred
        || readFirstEnvValue(PROJECT_KEYS)
        || cachedProjectName
        || DEFAULT_PROJECT
    );
}

function getOrCreateTracer(projectName?: string): LangChainTracer | undefined {
    const apiKey = readFirstEnvValue(API_KEY_KEYS);
    if (!apiKey) {
        return undefined;
    }

    const resolvedProject = resolveProjectName(projectName);

    if (!cachedTracer || (resolvedProject && cachedProjectName !== resolvedProject)) {
        cachedTracer = new SafeLangChainTracer({ projectName: resolvedProject });
        cachedProjectName = resolvedProject;

        if (!hasLoggedInitialization) {
            elizaLogger.info(`LangSmith tracing enabled for project "${resolvedProject}"`);
            hasLoggedInitialization = true;
        }
    }

    return cachedTracer;
}

export function isLangSmithTracingEnabled(): boolean {
    return Boolean(readFirstEnvValue(API_KEY_KEYS));
}

export function getLangSmithProjectName(): string | undefined {
    return cachedProjectName ?? readFirstEnvValue(PROJECT_KEYS);
}

export function buildLangSmithRunnableConfig<TConfig extends PrimitiveRecord = PrimitiveRecord>(
    options?: LangSmithRunnableOptions<TConfig>
): RunnableConfig<TConfig> | undefined {
    const apiKey = options?.apiKey ?? readFirstEnvValue(API_KEY_KEYS);
    if (!apiKey) {
        return undefined;
    }

    ensureLangSmithEnvironment({
        apiKey,
        endpoint: options?.endpoint,
        projectName: options?.projectName
    });

    const tracer = getOrCreateTracer(options?.projectName);
    if (!tracer) {
        return undefined;
    }

    const metadata: PrimitiveRecord = {
        ...(options?.metadata ?? {}),
    };

    if (cachedProjectName && metadata.langsmithProject === undefined) {
        metadata.langsmithProject = cachedProjectName;
    }

    const config: RunnableConfig<TConfig> = {
        callbacks: [tracer],
    };

    if (options?.runName) {
        config.runName = options.runName;
    }

    if (options?.tags && options.tags.length > 0) {
        config.tags = options.tags;
    }

    if (options?.configurable) {
        config.configurable = options.configurable;
    }

    if (Object.keys(metadata).length > 0) {
        config.metadata = metadata;
    }

    return config;
}
