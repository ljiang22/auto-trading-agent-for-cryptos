import { DirectClient } from "@elizaos/client-direct";
import {
    type Adapter,
    AgentRuntime,
    CacheManager,
    CacheStore,
    type Plugin,
    type Character,
    type ClientInstance,
    DbCacheAdapter,
    elizaLogger,
    FsCacheAdapter,
    initTracing,
    type IAgentRuntime,
    type IDatabaseAdapter,
    type IDatabaseCacheAdapter,
    ModelProviderName,
    parseBooleanFromText,
    settings,
    stringToUuid,
    validateCharacterConfig,
    LocalEmbeddingModelManager,
    type UUID,
} from "@elizaos/core";
import { defaultCharacter } from "./defaultCharacter.ts";
import { resolvePreferredDatabaseAdapter } from "./databaseAdapterSelection.ts";

import {
    ReconciliationService,
    createMongoLedger,
    createMongoShadowDecisionWriter,
    resolveExchangeCredentials,
    setRiskAuditSink,
    setApprovalDecisionSink,
    setShadowDecisionWriter,
    setVenueCallSink,
    writeReconciliationRuntimeLock,
} from "@elizaos-plugins/plugin-cex";
import { MongoDatabaseAdapter } from "@elizaos-plugins/adapter-mongodb";
import { coinmarketcapPlugin } from "@elizaos-plugins/plugin-coinmarketcap";
import { GetANewsPlugin } from "@elizaos-plugins/plugin-news";
import { webSearchPlugin } from "@elizaos-plugins/plugin-web-search";
import { ChartsPlugin } from "@elizaos-plugins/plugin-charts";
import { sentiscore_analysis_Plugin } from "@elizaos-plugins/plugin-sentiscore-analysis";
import { cryptoTechnicAnalysisPlugin } from "@elizaos-plugins/plugin-crypto_technic_analysis";
import { cryptoResearchSearchPlugin } from "@elizaos-plugins/plugin-crypto-research-search";
import { crypto_on_chain_dataPlugin } from "@elizaos-plugins/plugin-on_chain_data";
import { predictionPlugin } from "@elizaos-plugins/plugin-prediction";
import { fearAndGreedAnalysisPlugin } from "@elizaos-plugins/plugin-fearandgreedindex_analysis";
import { institutionalCryptoSearchPlugin } from "@elizaos-plugins/plugin-institutional-adoption";
import { launchpadPlugin } from "@elizaos-plugins/plugin-launchpad";
import JSON5 from 'json5';

import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import yargs from "yargs";
import { Worker } from "worker_threads";
import express from "express";

const __filename = fileURLToPath(import.meta.url); // get the resolved path to the file
const __dirname = path.dirname(__filename); // get the name of the directory

// Plugin import allowlist — prevent RCE via arbitrary await import()
const PLUGIN_ALLOWLIST = new Set<string>([
  ...(process.env.ALLOWED_PLUGINS ?? "").split(",").filter(Boolean),
  "@elizaos-plugins/plugin-cex",
  "@elizaos-plugins/plugin-mantle-dex",
  "@elizaos-plugins/plugin-charts",
  "@elizaos-plugins/plugin-coinmarketcap",
  "@elizaos-plugins/plugin-content-analysis",
  "@elizaos-plugins/plugin-crypto-research-search",
  "@elizaos-plugins/plugin-crypto_technic_analysis",
  "@elizaos-plugins/plugin-fearandgreedindex_analysis",
  "@elizaos-plugins/plugin-institutional-adoption",
  "@elizaos-plugins/plugin-launchpad",
  "@elizaos-plugins/plugin-news",
  "@elizaos-plugins/plugin-on_chain_data",
  "@elizaos-plugins/plugin-prediction",
  "@elizaos-plugins/plugin-sentiscore-analysis",
  "@elizaos-plugins/plugin-trade",
  "@elizaos-plugins/plugin-web-search",
  "@elizaos/plugin-bootstrap",
  "@elizaos/plugin-sql",
]);


// const app = express();
// const PORT = Number.parseInt(process.env.SERVER_PORT || "3000", 10);

// // Define the API routes
// app.get("/api/health", (_req, res) => {
//   res.json({ status: "ok" });
// });

// // Serve frontend
// const distPath = path.resolve(__dirname, "../../client/dist");
// app.use(express.static(distPath));

// // Serve index.html for all other routes (for React/Vite frontend)
// app.get("*", (_req, res) => {
//   res.sendFile(path.join(distPath, "index.html"));
// });

// app.listen(PORT, () => {
//   console.log(`Server running at http://localhost:${PORT}`);
// });

export const wait = (minTime = 1000, maxTime = 3000) => {
    const waitTime =
        Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
    return new Promise((resolve) => setTimeout(resolve, waitTime));
};

const logFetch = async (url: string, options: any) => {
    elizaLogger.debug(`Fetching ${url}`);
    // Disabled to avoid disclosure of sensitive information such as API keys
    // elizaLogger.debug(JSON.stringify(options, null, 2));
    return fetch(url, options);
};

export function parseArguments(): {
    character?: string;
    characters?: string;
} {
    try {
        return yargs(process.argv.slice(2))
            .option("character", {
                type: "string",
                description: "Path to the character JSON file",
            })
            .option("characters", {
                type: "string",
                description:
                    "Comma separated list of paths to character JSON files",
            })
            .parseSync();
    } catch (error) {
        console.error("Error parsing arguments:", error);
        return {};
    }
}

function tryLoadFile(filePath: string): string | null {
    try {
        return fs.readFileSync(filePath, "utf8");
    } catch (e) {
        return null;
    }
}
function mergeCharacters(base: Character, child: Character): Character {
    const mergeObjects = (baseObj: any, childObj: any) => {
        const result: any = {};
        const keys = new Set([
            ...Object.keys(baseObj || {}),
            ...Object.keys(childObj || {}),
        ]);
        keys.forEach((key) => {
            if (
                typeof baseObj[key] === "object" &&
                typeof childObj[key] === "object" &&
                !Array.isArray(baseObj[key]) &&
                !Array.isArray(childObj[key])
            ) {
                result[key] = mergeObjects(baseObj[key], childObj[key]);
            } else if (
                Array.isArray(baseObj[key]) ||
                Array.isArray(childObj[key])
            ) {
                result[key] = [
                    ...(baseObj[key] || []),
                    ...(childObj[key] || []),
                ];
            } else {
                result[key] =
                    childObj[key] !== undefined ? childObj[key] : baseObj[key];
            }
        });
        return result;
    };
    return mergeObjects(base, child);
}
/* function isAllStrings(arr: unknown[]): boolean {
    return Array.isArray(arr) && arr.every((item) => typeof item === "string");
}
export async function loadCharacterFromOnchain(): Promise<Character[]> {
    const jsonText = onchainJson;

    console.log("JSON:", jsonText);
    if (!jsonText) return [];
    const loadedCharacters = [];
    try {
        const character = JSON5.parse(jsonText);
        validateCharacterConfig(character);

        // .id isn't really valid
        const characterId = character.id || character.name;
        const characterPrefix = `CHARACTER.${characterId
            .toUpperCase()
            .replace(/ /g, "_")}.`;

        const characterSettings = Object.entries(process.env)
            .filter(([key]) => key.startsWith(characterPrefix))
            .reduce((settings, [key, value]) => {
                const settingKey = key.slice(characterPrefix.length);
                settings[settingKey] = value;
                return settings;
            }, {});

        if (Object.keys(characterSettings).length > 0) {
            character.settings = character.settings || {};
            character.settings.secrets = {
                ...characterSettings,
                ...character.settings.secrets,
            };
        }

        // Handle plugins
        if (isAllStrings(character.plugins)) {
            elizaLogger.info("Plugins are: ", character.plugins);
            const importedPlugins = await Promise.all(
                character.plugins.map(async (plugin) => {
                    if (!PLUGIN_ALLOWLIST.has(plugin)) {
                        throw new Error(`Plugin "${plugin}" is not in the allowed list. Add it to ALLOWED_PLUGINS env var.`);
                    }
                    const importedPlugin = await import(plugin);
                    return importedPlugin.default;
                })
            );
            character.plugins = importedPlugins;
        }

        loadedCharacters.push(character);
        elizaLogger.info(
            `Successfully loaded character from: ${process.env.IQ_WALLET_ADDRESS}`
        );
        return loadedCharacters;
    } catch (e) {
        elizaLogger.error(
            `Error parsing character from ${process.env.IQ_WALLET_ADDRESS}: ${e}`
        );
        process.exit(1);
    }
} */

async function loadCharactersFromUrl(url: string): Promise<Character[]> {
    try {
        const response = await fetch(url);
        const responseJson = await response.json();

        let characters: Character[] = [];
        if (Array.isArray(responseJson)) {
            characters = await Promise.all(
                responseJson.map((character) => jsonToCharacter(url, character))
            );
        } else {
            const character = await jsonToCharacter(url, responseJson);
            characters.push(character);
        }
        return characters;
    } catch (e) {
        console.error(`Error loading character(s) from ${url}: `, e);
        process.exit(1);
    }
}

async function jsonToCharacter(
    filePath: string,
    character: any
): Promise<Character> {
    validateCharacterConfig(character);

    // .id isn't really valid
    const characterId = character.id || character.name;
    const characterPrefix = `CHARACTER.${characterId
        .toUpperCase()
        .replace(/ /g, "_")}.`;
    const characterSettings = Object.entries(process.env)
        .filter(([key]) => key.startsWith(characterPrefix))
        .reduce((settings, [key, value]) => {
            const settingKey = key.slice(characterPrefix.length);
            return { ...settings, [settingKey]: value };
        }, {});
    if (Object.keys(characterSettings).length > 0) {
        character.settings = character.settings || {};
        character.settings.secrets = {
            ...characterSettings,
            ...character.settings.secrets,
        };
    }
    // Handle plugins
    character.plugins = await handlePluginImporting(character.plugins);
    elizaLogger.info(character.name, 'loaded plugins:', "[\n    " + character.plugins.map(p => `"${p.npmName}"`).join(", \n    ") + "\n]");

    // Handle Post Processors plugins
    if (character.postProcessors?.length > 0) {
        elizaLogger.info(character.name, 'loading postProcessors', character.postProcessors);
        character.postProcessors = await handlePluginImporting(character.postProcessors);
    }

    // Handle extends
    if (character.extends) {
        elizaLogger.info(
            `Merging  ${character.name} character with parent characters`
        );
        for (const extendPath of character.extends) {
            const baseCharacter = await loadCharacter(
                path.resolve(path.dirname(filePath), extendPath)
            );
            character = mergeCharacters(baseCharacter, character);
            elizaLogger.info(
                `Merged ${character.name} with ${baseCharacter.name}`
            );
        }
    }
    return character;
}

async function loadCharacter(filePath: string): Promise<Character> {
    const content = tryLoadFile(filePath);
    if (!content) {
        throw new Error(`Character file not found: ${filePath}`);
    }
    const character = JSON5.parse(content);
    return jsonToCharacter(filePath, character);
}

async function loadCharacterTryPath(characterPath: string): Promise<Character> {
    let content: string | null = null;
    let resolvedPath = "";

    // Try different path resolutions in order
    const pathsToTry = [
        characterPath, // exact path as specified
        path.resolve(process.cwd(), characterPath), // relative to cwd
        path.resolve(process.cwd(), "agent", characterPath), // Add this
        path.resolve(__dirname, characterPath), // relative to current script
        path.resolve(__dirname, "characters", path.basename(characterPath)), // relative to agent/characters
        path.resolve(__dirname, "../characters", path.basename(characterPath)), // relative to characters dir from agent
        path.resolve(
            __dirname,
            "../../characters",
            path.basename(characterPath)
        ), // relative to project root characters dir
    ];

    elizaLogger.debug(
        "Trying paths:",
        pathsToTry.map((p) => ({
            path: p,
            exists: fs.existsSync(p),
        }))
    );

    for (const tryPath of pathsToTry) {
        content = tryLoadFile(tryPath);
        if (content !== null) {
            resolvedPath = tryPath;
            break;
        }
    }

    if (content === null) {
        elizaLogger.error(
            `Error loading character from ${characterPath}: File not found in any of the expected locations`
        );
        elizaLogger.error("Tried the following paths:");
        pathsToTry.forEach((p) => elizaLogger.error(` - ${p}`));
        throw new Error(
            `Error loading character from ${characterPath}: File not found in any of the expected locations`
        );
    }
    try {
        const character: Character = await loadCharacter(resolvedPath);
        elizaLogger.success(`Successfully loaded character from: ${resolvedPath}`);
        return character;
    } catch (e) {
        console.error(`Error parsing character from ${resolvedPath}: `, e);
        throw new Error(`Error parsing character from ${resolvedPath}: ${e}`);
    }
}

function commaSeparatedStringToArray(commaSeparated: string): string[] {
    return commaSeparated?.split(",").map((value) => value.trim());
}

async function readCharactersFromStorage(
    characterPaths: string[]
): Promise<string[]> {
    try {
        const uploadDir = path.join(process.cwd(), "data", "characters");
        await fs.promises.mkdir(uploadDir, { recursive: true });
        const fileNames = await fs.promises.readdir(uploadDir);
        fileNames.forEach((fileName) => {
            characterPaths.push(path.join(uploadDir, fileName));
        });
    } catch (err) {
        elizaLogger.error(`Error reading directory: ${err.message}`);
    }

    return characterPaths;
}

export async function loadCharacters(
    charactersArg: string
): Promise<Character[]> {
    let characterPaths = commaSeparatedStringToArray(charactersArg);

    if (process.env.USE_CHARACTER_STORAGE === "true") {
        characterPaths = await readCharactersFromStorage(characterPaths);
    }

    const loadedCharacters: Character[] = [];

    if (characterPaths?.length > 0) {
        for (const characterPath of characterPaths) {
            try {
                const character: Character = await loadCharacterTryPath(
                    characterPath
                );
                loadedCharacters.push(character);
            } catch (e) {
                process.exit(1);
            }
        }
    }

    if (hasValidRemoteUrls()) {
        elizaLogger.info("Loading characters from remote URLs");
        const characterUrls = commaSeparatedStringToArray(
            process.env.REMOTE_CHARACTER_URLS
        );
        for (const characterUrl of characterUrls) {
            const characters = await loadCharactersFromUrl(characterUrl);
            loadedCharacters.push(...characters);
        }
    }

    if (loadedCharacters.length === 0) {
        elizaLogger.info("No characters found, using default character");
        loadedCharacters.push(defaultCharacter);
    }

    return loadedCharacters;
}

async function handlePluginImporting(plugins: string[]) {
    if (plugins.length > 0) {
        // this logging should happen before calling, so we can include important context
        //elizaLogger.info("Plugins are: ", plugins);
        const importedPlugins = await Promise.all(
            plugins.map(async (plugin) => {
                try {
                    if (!PLUGIN_ALLOWLIST.has(plugin)) {
                        throw new Error(`Plugin "${plugin}" is not in the allowed list. Add it to ALLOWED_PLUGINS env var.`);
                    }
                    const importedModule = await import(plugin);
                    const functionName =
                        plugin
                            .replace("@elizaos/plugin-", "")
                            .replace("@elizaos-plugins/plugin-", "")
                            .replace(/-./g, (x) => x[1].toUpperCase()) +
                        "Plugin"; // Assumes plugin function is camelCased with Plugin suffix
                    if (!importedModule[functionName] && !importedModule.default) {
                      elizaLogger.warn(plugin, 'does not have an default export or', functionName)
                    }
                    return {...(
                        importedModule.default || importedModule[functionName]
                    ), npmName: plugin };
                } catch (importError) {
                    console.error(
                        `Failed to import plugin: ${plugin}`,
                        importError
                    );
                    return false; // Return null for failed imports
                }
            })
        )
        // remove plugins that failed to load, so agent can try to start
        return importedPlugins.filter(p => !!p);
    } else {
        return [];
    }
}


export function getTokenForProvider(
    provider: ModelProviderName,
    character: Character
): string | undefined {
    switch (provider) {
        // no key needed for llama_local, ollama, lmstudio, gaianet or bedrock
        case ModelProviderName.LLAMALOCAL:
            return "";
        case ModelProviderName.OLLAMA:
            return "";
        case ModelProviderName.LMSTUDIO:
            return "";
        case ModelProviderName.GAIANET:
            return (
                character.settings?.secrets?.GAIA_API_KEY ||
                settings.GAIA_API_KEY
            );
        case ModelProviderName.BEDROCK:
            return "";
        case ModelProviderName.OPENAI:
            return (
                character.settings?.secrets?.OPENAI_API_KEY ||
                settings.OPENAI_API_KEY
            );
        case ModelProviderName.ETERNALAI:
            return (
                character.settings?.secrets?.ETERNALAI_API_KEY ||
                settings.ETERNALAI_API_KEY
            );
        case ModelProviderName.NINETEEN_AI:
            return (
                character.settings?.secrets?.NINETEEN_AI_API_KEY ||
                settings.NINETEEN_AI_API_KEY
            );
        case ModelProviderName.LLAMACLOUD:
        case ModelProviderName.TOGETHER:
            return (
                character.settings?.secrets?.LLAMACLOUD_API_KEY ||
                settings.LLAMACLOUD_API_KEY ||
                character.settings?.secrets?.TOGETHER_API_KEY ||
                settings.TOGETHER_API_KEY ||
                character.settings?.secrets?.OPENAI_API_KEY ||
                settings.OPENAI_API_KEY
            );
        case ModelProviderName.CLAUDE_VERTEX:
        case ModelProviderName.ANTHROPIC:
            return (
                character.settings?.secrets?.ANTHROPIC_API_KEY ||
                character.settings?.secrets?.CLAUDE_API_KEY ||
                settings.ANTHROPIC_API_KEY ||
                settings.CLAUDE_API_KEY
            );
        case ModelProviderName.REDPILL:
            return (
                character.settings?.secrets?.REDPILL_API_KEY ||
                settings.REDPILL_API_KEY
            );
        case ModelProviderName.OPENROUTER:
            return (
                character.settings?.secrets?.OPENROUTER_API_KEY ||
                settings.OPENROUTER_API_KEY
            );
        case ModelProviderName.GROK:
            return (
                character.settings?.secrets?.GROK_API_KEY ||
                settings.GROK_API_KEY
            );
        case ModelProviderName.HEURIST:
            return (
                character.settings?.secrets?.HEURIST_API_KEY ||
                settings.HEURIST_API_KEY
            );
        case ModelProviderName.GROQ:
            return (
                character.settings?.secrets?.GROQ_API_KEY ||
                settings.GROQ_API_KEY
            );
        case ModelProviderName.GALADRIEL:
            return (
                character.settings?.secrets?.GALADRIEL_API_KEY ||
                settings.GALADRIEL_API_KEY
            );
        case ModelProviderName.FAL:
            return (
                character.settings?.secrets?.FAL_API_KEY || settings.FAL_API_KEY
            );
        case ModelProviderName.ALI_BAILIAN:
            return (
                character.settings?.secrets?.ALI_BAILIAN_API_KEY ||
                settings.ALI_BAILIAN_API_KEY
            );
        case ModelProviderName.VOLENGINE:
            return (
                character.settings?.secrets?.VOLENGINE_API_KEY ||
                settings.VOLENGINE_API_KEY
            );
        case ModelProviderName.NANOGPT:
            return (
                character.settings?.secrets?.NANOGPT_API_KEY ||
                settings.NANOGPT_API_KEY
            );
        case ModelProviderName.HYPERBOLIC:
            return (
                character.settings?.secrets?.HYPERBOLIC_API_KEY ||
                settings.HYPERBOLIC_API_KEY
            );

        case ModelProviderName.VENICE:
            return (
                character.settings?.secrets?.VENICE_API_KEY ||
                settings.VENICE_API_KEY
            );
        case ModelProviderName.ATOMA:
            return (
                character.settings?.secrets?.ATOMASDK_BEARER_AUTH ||
                settings.ATOMASDK_BEARER_AUTH
            );
        case ModelProviderName.NVIDIA:
            return (
                character.settings?.secrets?.NVIDIA_API_KEY ||
                settings.NVIDIA_API_KEY
            );
        case ModelProviderName.AKASH_CHAT_API:
            return (
                character.settings?.secrets?.AKASH_CHAT_API_KEY ||
                settings.AKASH_CHAT_API_KEY
            );
        case ModelProviderName.GOOGLE:
            // Vertex AI auths via GOOGLE_APPLICATION_CREDENTIALS_JSON in generation.ts
            return "";
        case ModelProviderName.MISTRAL:
            return (
                character.settings?.secrets?.MISTRAL_API_KEY ||
                settings.MISTRAL_API_KEY
            );
        case ModelProviderName.LETZAI:
            return (
                character.settings?.secrets?.LETZAI_API_KEY ||
                settings.LETZAI_API_KEY
            );
        case ModelProviderName.INFERA:
            return (
                character.settings?.secrets?.INFERA_API_KEY ||
                settings.INFERA_API_KEY
            );
        case ModelProviderName.DEEPSEEK:
            return (
                character.settings?.secrets?.DEEPSEEK_API_KEY ||
                settings.DEEPSEEK_API_KEY
            );
        case ModelProviderName.LIVEPEER:
            return (
                character.settings?.secrets?.LIVEPEER_GATEWAY_URL ||
                settings.LIVEPEER_GATEWAY_URL
            );
        case ModelProviderName.SECRETAI:
            return (
                character.settings?.secrets?.SECRET_AI_API_KEY ||
                settings.SECRET_AI_API_KEY
            );
        case ModelProviderName.NEARAI:
            try {
                const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.nearai/config.json'), 'utf8'));
                return JSON.stringify(config?.auth);
            } catch (e) {
                elizaLogger.warn(`Error loading NEAR AI config: ${e}`);
            }
            return (
                character.settings?.secrets?.NEARAI_API_KEY ||
                settings.NEARAI_API_KEY
            );

        default:
            const errorMessage = `Failed to get token - unsupported model provider: ${provider}`;
            elizaLogger.error(errorMessage);
            throw new Error(errorMessage);
    }
}

// also adds plugins from character file into the runtime
export async function initializeClients(
    character: Character,
    runtime: IAgentRuntime
) {
    // each client can only register once
    // and if we want two we can explicitly support it
    const clients: ClientInstance[] = [];
    // const clientTypes = clients.map((c) => c.name);
    // elizaLogger.log("initializeClients", clientTypes, "for", character.name);

    if (character.plugins?.length > 0) {
        for (const plugin of character.plugins) {
            if (plugin.clients) {
                for (const client of plugin.clients) {
                    const startedClient = await client.start(runtime);
                    elizaLogger.debug(
                        `Initializing client: ${client.name}`
                    );
                    clients.push(startedClient);
                }
            }
        }
    }

    return clients;
}

/** Unique npm/plugin specifiers from `settings.specialPlugins` for dynamic import. */
function collectSpecialPluginImportNames(settings?: Character["settings"]): string[] {
    const sp = settings?.specialPlugins;
    if (!sp || typeof sp !== "object") return [];
    return [
        ...new Set(
            Object.values(sp).flatMap((list) =>
                Array.isArray(list)
                    ? list.filter((n): n is string => typeof n === "string" && n.length > 0)
                    : []
            )
        ),
    ];
}

export async function createAgent(
    character: Character,
    token: string
): Promise<AgentRuntime> {
    elizaLogger.log(`Creating runtime for character ${character.name}`);

    // Dynamically load special plugins from character settings
    const specialPlugins = await handlePluginImporting(
        collectSpecialPluginImportNames(character.settings)
    );
    if (specialPlugins.length > 0) {
        elizaLogger.info(
            character.name,
            "loaded special plugins:",
            specialPlugins.map((p) => `"${p.npmName}"`).join(", ")
        );
    }

    return new AgentRuntime({
        token,
        modelProvider: character.modelProvider,
        evaluators: [],
        character,
        // character.plugins are handled when clients are added
        plugins: [
            GetANewsPlugin,
            webSearchPlugin,
            ChartsPlugin,
            sentiscore_analysis_Plugin,
            coinmarketcapPlugin,
            cryptoTechnicAnalysisPlugin,
            cryptoResearchSearchPlugin,
            crypto_on_chain_dataPlugin,
            predictionPlugin,
            institutionalCryptoSearchPlugin,
            fearAndGreedAnalysisPlugin,
            launchpadPlugin,
            ...specialPlugins,
        ]
            .flat()
            .filter(Boolean),
        providers: [],
        managers: [],
        fetch: logFetch,
        // verifiableInferenceAdapter,
    });
}

function initializeFsCache(baseDir: string, character: Character) {
    if (!character?.id) {
        throw new Error(
            "initializeFsCache requires id to be set in character definition"
        );
    }
    const cacheDir = path.resolve(baseDir, character.id, "cache");

    const cache = new CacheManager(new FsCacheAdapter(cacheDir));
    return cache;
}

function initializeDbCache(character: Character, db: IDatabaseCacheAdapter) {
    if (!character?.id) {
        throw new Error(
            "initializeFsCache requires id to be set in character definition"
        );
    }
    const cache = new CacheManager(new DbCacheAdapter(db, character.id));
    return cache;
}

function initializeCache(
    cacheStore: string,
    character: Character,
    baseDir?: string,
    db?: IDatabaseCacheAdapter
) {
    switch (cacheStore) {
        // case CacheStore.REDIS:
        //     if (process.env.REDIS_URL) {
        //         elizaLogger.info("Connecting to Redis...");
        //         const redisClient = new RedisClient(process.env.REDIS_URL);
        //         if (!character?.id) {
        //             throw new Error(
        //                 "CacheStore.REDIS requires id to be set in character definition"
        //             );
        //         }
        //         return new CacheManager(
        //             new DbCacheAdapter(redisClient, character.id) // Using DbCacheAdapter since RedisClient also implements IDatabaseCacheAdapter
        //         );
        //     } else {
        //         throw new Error("REDIS_URL environment variable is not set.");
        //     }

        case CacheStore.DATABASE:
            if (db) {
                elizaLogger.info("Using Database Cache...");
                return initializeDbCache(character, db);
            } else {
                throw new Error(
                    "Database adapter is not provided for CacheStore.Database."
                );
            }

        case CacheStore.FILESYSTEM:
            elizaLogger.info("Using File System Cache...");
            if (!baseDir) {
                throw new Error(
                    "baseDir must be provided for CacheStore.FILESYSTEM."
                );
            }
            return initializeFsCache(baseDir, character);

        default:
            throw new Error(
                `Invalid cache store: ${cacheStore} or required configuration missing.`
            );
    }
}

async function findDatabaseAdapter(runtime: AgentRuntime) {
    const { adapters } = runtime;
    let adapter: Adapter | undefined;

    const rawPreferredAdapter =
        runtime.getSetting("DATABASE_ADAPTER") ??
        process.env.DATABASE_ADAPTER ??
        "";
    const { preferredAdapter, usedDefault } =
        resolvePreferredDatabaseAdapter(rawPreferredAdapter);

    if (usedDefault) {
        elizaLogger.warn(
            "DATABASE_ADAPTER is not set. Defaulting to 'sqlite'. For CTO handoff or DocumentDB cutover, set DATABASE_ADAPTER explicitly."
        );
    }

    const useMongoCompatibleAdapter =
        preferredAdapter === "mongodb" || preferredAdapter === "documentdb";

    if (adapters.length === 0) {
        if (useMongoCompatibleAdapter) {
            elizaLogger.info(
                `DATABASE_ADAPTER=${preferredAdapter} selected. Loading the Mongo-compatible database adapter.`
            );
            const mongoAdapterPlugin = await import("@elizaos-plugins/adapter-mongodb");
            const mongoAdapterPluginDefault = mongoAdapterPlugin.default;
            adapter = mongoAdapterPluginDefault.adapters[0];
            if (!adapter) {
                throw new Error(
                    "Internal error: No database adapter found for default adapter-mongodb"
                );
            }
        } else {
            elizaLogger.info("DATABASE_ADAPTER=sqlite selected. Loading the SQLite adapter.");
            const sqliteAdapterPlugin = await import("@elizaos-plugins/adapter-sqlite");
            const sqliteAdapterPluginDefault = sqliteAdapterPlugin.default;
            adapter = sqliteAdapterPluginDefault.adapters[0];
            if (!adapter) {
                throw new Error(
                    "Internal error: No database adapter found for default adapter-sqlite"
                );
            }
        }
    } else if (adapters.length === 1) {
        if (!usedDefault) {
            elizaLogger.info(
                `A database adapter plugin is already configured, so DATABASE_ADAPTER=${preferredAdapter} will not override it.`
            );
        }
        adapter = adapters[0];
    } else {
        throw new Error(
            `Multiple database adapters found. DATABASE_ADAPTER=${preferredAdapter} does not select between explicit adapter plugins. Keep at most one configured database adapter plugin.`
        );
    }

    const adapterInterface = adapter?.init(runtime);
    return adapterInterface;
}

async function startAgent(
    character: Character,
    directClient: DirectClient
): Promise<AgentRuntime> {
    let db: IDatabaseAdapter & IDatabaseCacheAdapter;
    try {
        character.id ??= stringToUuid(character.name);
        character.username ??= character.name;

        const token = getTokenForProvider(character.modelProvider, character);

        const runtime: AgentRuntime = await createAgent(
            character,
            token
        );

        // initialize database
        // find a db from the plugins
        db = await findDatabaseAdapter(runtime);
        runtime.databaseAdapter = db;

        // initialize cache
        const cache = initializeCache(
            process.env.CACHE_STORE ?? CacheStore.DATABASE,
            character,
            process.env.CACHE_DIR ?? "",
            db
        ); // "" should be replaced with dir for file system caching. THOUGHTS: might probably make this into an env
        runtime.cacheManager = cache;

        // Phase 2 — Register ReconciliationService (pending-order ledger + per-symbol trading lock).
        // Must be registered BEFORE runtime.initialize() so initialize() is called automatically.
        // Only available with a MongoDB-compatible adapter; silently skipped for SQLite.
        let reconciliationService: ReconciliationService | null = null;
        if (db instanceof MongoDatabaseAdapter) {
            const ledger = createMongoLedger(db.db);
            // F5 — resolveCredentials is invoked per (userId, venue) at
            // poll time so the REST fallback uses the latest persisted
            // CEX keys. The legacy `credentials: []` startup list is
            // kept so WS streams can pre-warm if any creds existed at
            // boot (today none are warm-loaded, so this stays empty).
            // On streak=60 (~5 min at 5 s tick) the auto-downgrade
            // writes `user_trading_preferences.runtime_lock = "read_only_until=…"`
            // so subsequent live writes are blocked until the user
            // updates their CEX credentials.
            reconciliationService = new ReconciliationService({
                ledger,
                credentials: [],
                resolveCredentials: async (userId, venue) => {
                    try {
                        return await resolveExchangeCredentials(runtime, userId as UUID, {
                            preferExchangeId: (venue as string).toLowerCase() as never,
                        });
                    } catch (err) {
                        elizaLogger.warn(
                            `[ReconciliationService] resolveCredentials failed for user=${userId} venue=${venue}: ${String(err)}`,
                        );
                        return null;
                    }
                },
                onUnresolvedDowngrade: async ({ userId, venue, streak }) => {
                    try {
                        const next = await writeReconciliationRuntimeLock(
                            db as never,
                            { userId, venue, streak },
                        );
                        if (next) {
                            elizaLogger.warn(
                                `[ReconciliationService] auto-downgrade: user=${userId} venue=${venue} streak=${streak} runtime_lock=${String(next.runtime_lock ?? "")}`,
                            );
                        }
                    } catch (err) {
                        elizaLogger.error(
                            `[ReconciliationService] auto-downgrade persistence failed: ${String(err)}`,
                        );
                    }
                },
            });
            await runtime.registerService(reconciliationService);
            elizaLogger.info("[Startup] ReconciliationService registered (pending-order ledger + trading lock)");

            // §6.1 — wire the risk-audit sink so every `runRiskPrecheck`
            // call persists its verdict. Without this the dep-health gate
            // refuses live trades.
            const adapterWithAudit = db as unknown as {
                writeRiskDecision?: (record: Record<string, unknown>) => Promise<void>;
            };
            if (typeof adapterWithAudit.writeRiskDecision === "function") {
                setRiskAuditSink({
                    async writeDecision(record) {
                        await adapterWithAudit.writeRiskDecision!(
                            record as unknown as Record<string, unknown>,
                        );
                    },
                });
                elizaLogger.info(
                    "[Startup] Risk-audit sink wired → adapter.writeRiskDecision",
                );
            } else {
                elizaLogger.warn(
                    "[Startup] Risk-audit sink NOT wired — adapter lacks writeRiskDecision. Live trades will fail-closed.",
                );
            }

            // §6.2 — approval-decision sink. Best-effort writes (the row
            // exists for replay; the audit-failure fail-closed lives on
            // risk_decisions).
            const adapterWithApproval = db as unknown as {
                writeApprovalDecision?: (record: Record<string, unknown>) => Promise<void>;
            };
            if (typeof adapterWithApproval.writeApprovalDecision === "function") {
                setApprovalDecisionSink({
                    async writeApprovalDecision(record) {
                        await adapterWithApproval.writeApprovalDecision!(
                            record as unknown as Record<string, unknown>,
                        );
                    },
                });
                elizaLogger.info(
                    "[Startup] Approval-decision sink wired → adapter.writeApprovalDecision",
                );
            }

            // §6.3 — venue-call sink. Sanitized request/response payloads are
            // persisted to `venue_calls`. Critical for replay tooling.
            const adapterWithVenueCall = db as unknown as {
                writeVenueCall?: (record: Record<string, unknown>) => Promise<void>;
            };
            if (typeof adapterWithVenueCall.writeVenueCall === "function") {
                setVenueCallSink({
                    async writeVenueCall(record) {
                        await adapterWithVenueCall.writeVenueCall!(
                            record as unknown as Record<string, unknown>,
                        );
                    },
                });
                elizaLogger.info(
                    "[Startup] Venue-call sink wired → adapter.writeVenueCall",
                );
            }

            // §8.10 — shadow-decision writer. Persists Phase-4 shadow rows
            // (paper vs shadow divergence aggregation). Plugin falls back
            // to in-memory when this sink is not wired.
            const adapterWithShadow = db as unknown as {
                writeShadowDecision?: (record: Record<string, unknown>) => Promise<void>;
            };
            if (typeof adapterWithShadow.writeShadowDecision === "function") {
                setShadowDecisionWriter(
                    createMongoShadowDecisionWriter({
                        writeShadowDecision: adapterWithShadow.writeShadowDecision,
                    }),
                );
                elizaLogger.info(
                    "[Startup] Shadow-decision writer wired → adapter.writeShadowDecision",
                );
            }
        } else {
            elizaLogger.warn("[Startup] ReconciliationService not registered — DATABASE_ADAPTER is not MongoDB/DocumentDB. Trading lock and ledger unavailable.");
        }

        // Preload BGE-M3 embedding model BEFORE runtime initialization so the model
        // is fully in memory before RAG processing or any service starts. This prevents
        // the model load from racing with the comprehensive analysis workflow (OOM fix).
        // warmup() runs a real dummy inference; otherwise @huggingface/transformers
        // pipeline() only parses files lazily and the ~4 GB native commit + multi-second
        // CPU burn is deferred to the first user-driven embed (cold-start stall).
        elizaLogger.info("Warming up BGE-M3 embedding model...");
        const embeddingManager = LocalEmbeddingModelManager.getInstance();
        await embeddingManager.warmup();
        elizaLogger.success("BGE-M3 embedding model warmed up successfully");

        // start services/plugins/process knowledge
        await runtime.initialize();

        // Start WS streams + REST fallback poller for order reconciliation (Phase 2).
        // Credentials are empty at startup; streams start when users configure exchange keys.
        if (reconciliationService) {
            reconciliationService.start();
        }

        // start assigned clients
        runtime.clients = await initializeClients(character, runtime);

        // add to container
        directClient.registerAgent(runtime);

        // report to console
        elizaLogger.debug(`Started ${character.name} as ${runtime.agentId}`);

        return runtime;
    } catch (error) {
        elizaLogger.error(
            `Error starting agent for character ${character.name}:`,
            error
        );
        elizaLogger.error(error);
        if (db) {
            await db.close();
        }
        throw error;
    }
}

const checkPortAvailable = (port: number): Promise<boolean> => {
    return new Promise((resolve) => {
        const server = net.createServer();

        server.once("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE") {
                resolve(false);
            }
        });

        server.once("listening", () => {
            server.close();
            resolve(true);
        });

        server.listen(port);
    });
};

const hasValidRemoteUrls = () =>
    process.env.REMOTE_CHARACTER_URLS &&
    process.env.REMOTE_CHARACTER_URLS !== "" &&
    process.env.REMOTE_CHARACTER_URLS.startsWith("http");

/**
 * Post processing of character after loading
 * @param character
 */
const handlePostCharacterLoaded = async (character: Character): Promise<Character> => {
    let processedCharacter = character;
    // Filtering the plugins with the method of handlePostCharacterLoaded
    const processors = character?.postProcessors?.filter(p => typeof p.handlePostCharacterLoaded === 'function');
    if (processors?.length > 0) {
        processedCharacter = Object.assign({}, character, { postProcessors: undefined });
        // process the character with each processor
        // the order is important, so we loop through the processors
        for (let i = 0; i < processors.length; i++) {
            const processor = processors[i];
            processedCharacter = await processor.handlePostCharacterLoaded(processedCharacter);
        }
    }
    return processedCharacter;
}

const startAgents = async () => {
    // §4 GEAP Observability: register the OpenTelemetry SDK before the HTTP server starts so
    // per-turn handler/node spans are captured. Hard no-op unless OTEL_TRACING_ENABLED=true
    // (the AWS production/staging task defs leave it unset). For full HTTP auto-instrumentation
    // a preload (NODE_OPTIONS=--import) is required; the custom decision.outcome/node-span DAG
    // works regardless since the provider registers before any message is routed.
    await initTracing();

    // Standalone health check server — runs in a worker thread independent of the main event loop.
    // ELB health checks hit port 3099 so heavy computation on the main thread never causes health failures.
    // /health is liveness (always 200 if worker is up); /ready is readiness gated on a main-thread heartbeat.
    const healthWorker = new Worker(
        `
        const http = require('http');
        const { parentPort } = require('worker_threads');
        let lastBeat = Date.now();
        parentPort.on('message', (msg) => { if (msg && msg.type === 'beat') lastBeat = msg.t; });
        http.createServer((req, res) => {
            if (req.url === '/ready') {
                const stale = Date.now() - lastBeat > 15000;
                res.writeHead(stale ? 503 : 200, { 'Content-Type': 'text/plain' });
                res.end(stale ? 'STALE' : 'READY');
            } else {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('OK');
            }
        }).listen(3099, '0.0.0.0', () => { console.log('[HealthCheck] standalone server on :3099'); });
        `,
        { eval: true }
    );
    healthWorker.on('error', (err) => console.error('[HealthCheck] Worker error:', err));
    setInterval(() => {
        healthWorker.postMessage({ type: 'beat', t: Date.now() });
    }, 5000).unref();

    // Change working directory to agent folder so that process.cwd() points to agent/
    // This ensures saved_data is created at agent/saved_data/ as specified in CLAUDE.md
    const agentDir = path.resolve(__dirname, '..');
    process.chdir(agentDir);
    elizaLogger.info(`Working directory set to: ${process.cwd()}`);
    
    const directClient = new DirectClient();
    let serverPort = Number.parseInt(settings.SERVER_PORT || "3000");
    const args = parseArguments();
    const charactersArg = args.characters || args.character;
    let characters = [defaultCharacter];

    if ((charactersArg) || hasValidRemoteUrls()) {
        characters = await loadCharacters(charactersArg);
    } else {
        // Auto-load all character files from characters directory
        try {
            const charactersDir = path.resolve(process.cwd(), "../characters");
            const characterFiles = fs.readdirSync(charactersDir)
                .filter(file => file.endsWith('.json'))
                .map(file => path.join(charactersDir, file));
            
            if (characterFiles.length > 0) {
                elizaLogger.info(`Auto-loading ${characterFiles.length} character files: ${characterFiles.map(f => path.basename(f)).join(', ')}`);
                characters = await loadCharacters(characterFiles.join(','));
            }
        } catch (error) {
            elizaLogger.warn('Could not auto-load characters from characters directory:', error.message);
            elizaLogger.info('Using default character');
        }
    }

    // Find available port and start HTTP server BEFORE agent init so health checks pass immediately
    while (!(await checkPortAvailable(serverPort))) {
        elizaLogger.warn(
            `Port ${serverPort} is in use, trying ${serverPort + 1}`
        );
        serverPort++;
    }

    // upload some agent functionality into directClient
    // This is used in client-direct/api.ts at "/agents/:agentId/set" route to restart an agent
    directClient.startAgent = async (character) => {
        // Handle plugins
        character.plugins = await handlePluginImporting(character.plugins);
        elizaLogger.info(character.name, 'loaded plugins:', '[' + character.plugins.map(p => `"${p.npmName}"`).join(', ') + ']');

        // Handle Post Processors plugins
        if (character.postProcessors?.length > 0) {
            elizaLogger.info(character.name, 'loading postProcessors', character.postProcessors);
            character.postProcessors = await handlePluginImporting(character.postProcessors);
        }
        // character's post processing
        const processedCharacter = await handlePostCharacterLoaded(character);

        // wrap it so we don't have to inject directClient later
        return startAgent(processedCharacter, directClient);
    };

    directClient.loadCharacterTryPath = loadCharacterTryPath;
    directClient.jsonToCharacter = jsonToCharacter;

    // Start HTTP server first — Node.js event loop will handle health check requests
    // during async agent initialization (which yields on I/O awaits)
    directClient.start(serverPort);

    if (serverPort !== Number.parseInt(settings.SERVER_PORT || "3000")) {
        elizaLogger.warn(`Server started on alternate port ${serverPort}`);
    }

    elizaLogger.info(
        "Run `pnpm start:client` to start the client and visit the outputted URL (http://localhost:5173) to chat with your agents. When running multiple agents, use client with different port `SERVER_PORT=3001 pnpm start:client`"
    );

    try {
        for (const character of characters) {
            const processedCharacter = await handlePostCharacterLoaded(character);
            await startAgent(processedCharacter, directClient);
        }

        // Explicit readiness signal: all characters finished their awaited startup
        // (BGE-M3 preload, runtime.initialize, client starts). Safe to run heavy
        // background jobs like the daily comprehensive analysis after this point.
        elizaLogger.success("All agents fully initialized — agent system is ready");
        directClient.startDailyAnalysisScheduler();
    } catch (error) {
        elizaLogger.error("Error starting agents:", error);
    }
};

startAgents().catch((error) => {
    elizaLogger.error("Unhandled error in startAgents:", error);
    process.exit(1);
});

// Graceful shutdown: stop accepting new connections, drain in-flight up to 30s
const shutdown = (code: number) => {
    elizaLogger.info('Shutting down gracefully...');
    const timer = setTimeout(() => process.exit(code), 30_000);
    timer.unref();
    try {
        const srv = (globalThis as any).__server;
        if (srv?.close) {
            srv.close(() => { clearTimeout(timer); process.exit(code); });
            return;
        }
    } catch (_) {}
    // No server reference available — exit after drain window
    setTimeout(() => process.exit(code), 100).unref();
};
process.on('uncaughtException', (err: Error) => { elizaLogger.error('Uncaught exception:', err); shutdown(1); });
process.on('unhandledRejection', (reason: unknown) => { elizaLogger.error('Unhandled rejection:', reason); shutdown(1); });
process.on('SIGTERM', () => { elizaLogger.info('Received SIGTERM'); shutdown(0); });
process.on('SIGINT', () => { elizaLogger.info('Received SIGINT'); shutdown(0); });
