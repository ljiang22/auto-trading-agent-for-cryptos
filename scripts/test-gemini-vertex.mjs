/**
 * Smoke test for Gemini on Vertex AI (same wiring as packages/core/src/ai/generation.ts).
 *
 * Prereqs: from repo root, core deps installed (`pnpm install` in workspace).
 *
 * Examples:
 *   node scripts/test-gemini-vertex.mjs --credentials /path/to/sa-key.json
 *   GOOGLE_APPLICATION_CREDENTIALS_JSON="$(cat key.json)" node scripts/test-gemini-vertex.mjs
 *   node --env-file=.env scripts/test-gemini-vertex.mjs
 *
 * Env (matches agent): GOOGLE_VERTEX_PROJECT, GOOGLE_VERTEX_LOCATION, GOOGLE_APPLICATION_CREDENTIALS_JSON,
 * optionally GOOGLE_MODEL / SMALL_GOOGLE_MODEL for model id.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createVertex } from "../packages/core/node_modules/@ai-sdk/google-vertex/dist/index.mjs";
import { generateText } from "../packages/core/node_modules/ai/dist/index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);
const CORE_NODE_MODULES = join(REPO_ROOT, "packages", "core", "node_modules");

function parseArgs(argv) {
    const args = new Map();
    for (let i = 2; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith("--")) continue;
        const [key, inlineValue] = token.slice(2).split("=", 2);
        if (inlineValue !== undefined) {
            args.set(key, inlineValue);
            continue;
        }
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
            args.set(key, next);
            i += 1;
            continue;
        }
        args.set(key, true);
    }
    return args;
}

function printUsage() {
    // eslint-disable-next-line no-console
    console.log(
        [
            "Usage:",
            "  node scripts/test-gemini-vertex.mjs [--credentials PATH] [--project ID] [--location LOC] [--model ID] [--prompt TEXT]",
            "",
            "Reads .env from repo root when present (via dotenv). You can also use `node --env-file=.env ...`.",
            "",
            "Auth (first match wins):",
            "  --credentials PATH              Service account JSON file",
            "  GOOGLE_APPLICATION_CREDENTIALS_JSON   Full JSON string (as in agent .env)",
            "  GOOGLE_APPLICATION_CREDENTIALS        Path to service account JSON file",
            "",
            "Required:",
            "  GOOGLE_VERTEX_PROJECT or --project",
            "",
            "Optional:",
            `  GOOGLE_VERTEX_LOCATION / --location  (default: global)`,
            `  SMALL_GOOGLE_MODEL / GOOGLE_MODEL / --model  (default: gemini-2.5-flash)`,
            "",
        ].join("\n"),
    );
}

async function loadDotEnvIfPresent() {
    const envPath = join(REPO_ROOT, ".env");
    if (!existsSync(envPath)) {
        return;
    }
    const dotenvMain = join(CORE_NODE_MODULES, "dotenv", "lib", "main.js");
    if (!existsSync(dotenvMain)) {
        return;
    }
    const { default: dotenv } = await import(dotenvMain);
    dotenv.config({ path: envPath });
}

/** Same contract as googleApplicationCredentialsFromSetting in core/utils/googleVertexCredentials.ts */
function credentialsFromEnvJson(raw) {
    if (raw === undefined || raw === null) return null;
    const trimmed = String(raw).trim();
    if (!trimmed) return null;
    try {
        const parsed = JSON.parse(trimmed);
        if (
            parsed !== null &&
            typeof parsed === "object" &&
            !Array.isArray(parsed)
        ) {
            return parsed;
        }
    } catch {
        /* handled below */
    }
    throw new Error(
        "GOOGLE_APPLICATION_CREDENTIALS_JSON must contain valid JSON object (Google service account key)",
    );
}

async function resolveCredentials(args) {
    const credFlag = args.get("credentials");
    if (typeof credFlag === "string" && credFlag.trim()) {
        const p = resolve(process.cwd(), credFlag.trim());
        const buf = await readFile(p, "utf8");
        return JSON.parse(buf);
    }

    const fromInline = credentialsFromEnvJson(
        process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
    );
    if (fromInline) return fromInline;

    const gac = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
    if (gac) {
        const pathToKey = resolve(process.cwd(), gac);
        if (existsSync(pathToKey)) {
            const buf = await readFile(pathToKey, "utf8");
            return JSON.parse(buf);
        }
    }

    throw new Error(
        "No credentials: pass --credentials /path/key.json or set GOOGLE_APPLICATION_CREDENTIALS_JSON or GOOGLE_APPLICATION_CREDENTIALS",
    );
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.has("help")) {
        printUsage();
        process.exit(0);
    }

    await loadDotEnvIfPresent();

    const project =
        (typeof args.get("project") === "string" ? args.get("project") : null) ||
        process.env.GOOGLE_VERTEX_PROJECT?.trim() ||
        "";
    if (!project) {
        // eslint-disable-next-line no-console
        console.error("Missing GOOGLE_VERTEX_PROJECT (or --project).");
        printUsage();
        process.exit(1);
    }

    const locationRaw =
        (typeof args.get("location") === "string"
            ? args.get("location")
            : null) ||
        process.env.GOOGLE_VERTEX_LOCATION?.trim() ||
        "global";
    const location = locationRaw;

    const modelId =
        (typeof args.get("model") === "string" ? args.get("model") : null) ||
        process.env.SMALL_GOOGLE_MODEL?.trim() ||
        process.env.GOOGLE_MODEL?.trim() ||
        "gemini-2.5-flash";

    const prompt =
        typeof args.get("prompt") === "string"
            ? args.get("prompt")
            : `Reply with one short sentence confirming you are Gemini on Vertex (${modelId}), project ${project}.`;

    const credentials = await resolveCredentials(args);

    const vertexHost =
        location === "global"
            ? "aiplatform.googleapis.com"
            : `${location}-aiplatform.googleapis.com`;

    const baseURL = `https://${vertexHost}/v1/projects/${project}/locations/${location}/publishers/google`;

    // eslint-disable-next-line no-console
    console.log(
        `Calling Vertex Gemini: model=${modelId} location=${location} project=${project}`,
    );

    const google = createVertex({
        project,
        location,
        baseURL,
        googleAuthOptions: {
            credentials,
        },
    });

    const { text } = await generateText({
        model: google(modelId),
        prompt,
        maxRetries: 1,
    });

    // eslint-disable-next-line no-console
    console.log("--- Response ---");
    // eslint-disable-next-line no-console
    console.log(text?.trim() || "(empty)");
    // eslint-disable-next-line no-console
    console.log("--- OK ---");
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
