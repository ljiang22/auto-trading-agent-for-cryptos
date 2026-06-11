import { existsSync, readFileSync } from "node:fs";

/**
 * Runtime-only module paths (deep into packages/core/node_modules), resolved at call time.
 * Kept as a single source of truth so a regression test can verify they all load.
 */
export const CORE_PKG = {
  ai: "../../packages/core/node_modules/ai/dist/index.mjs",
  vertex: "../../packages/core/node_modules/@ai-sdk/google-vertex/dist/index.mjs",
  zod: "../../packages/core/node_modules/zod/index.js",
};

/** Parse GOOGLE_APPLICATION_CREDENTIALS_JSON (matches googleApplicationCredentialsFromSetting). */
function credentialsFromEnv() {
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (raw?.trim()) {
    try {
      const parsed = JSON.parse(raw.trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through */
    }
  }
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (path && existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      /* fall through */
    }
  }
  return null;
}

export function hasVertexCreds() {
  return credentialsFromEnv() !== null && Boolean(process.env.GOOGLE_VERTEX_PROJECT?.trim());
}

/** Lazily build the Vertex provider (deps live in packages/core/node_modules). */
async function getVertexModel(modelId) {
  const project = process.env.GOOGLE_VERTEX_PROJECT?.trim() ?? "";
  const location = process.env.GOOGLE_VERTEX_LOCATION?.trim() || "global";
  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  const baseURL = `https://${host}/v1/projects/${project}/locations/${location}/publishers/google`;
  const { createVertex } = await import(CORE_PKG.vertex);
  const google = createVertex({ project, location, baseURL, googleAuthOptions: { credentials: credentialsFromEnv() } });
  return google(modelId);
}

/**
 * Returns a generate(text) fn, or a fallback that throws a clear error if creds are absent.
 * @param {string} modelId
 * @param {{ thinkingBudget?: number }} [opts]
 */
export function makeVertexGenerateText(modelId, { thinkingBudget } = {}) {
  return async ({ system, prompt }) => {
    if (!hasVertexCreds()) throw new Error("Vertex creds missing (set GOOGLE_VERTEX_PROJECT + GOOGLE_APPLICATION_CREDENTIALS_JSON)");
    const model = await getVertexModel(modelId);
    const { generateText } = await import(CORE_PKG.ai);
    const opts = { model, system, prompt, maxRetries: 1 };
    if (typeof thinkingBudget === "number") opts.providerOptions = { google: { thinkingConfig: { thinkingBudget } } };
    const { text } = await generateText(opts);
    return text;
  };
}

export { credentialsFromEnv, getVertexModel };
