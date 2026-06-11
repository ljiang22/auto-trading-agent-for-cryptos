/**
 * F7 — LLM-first parameter extractor for create_order.
 *
 * Why this exists: the regex extractor in `parameterExtractor.ts` is
 * conservative — it pulls side, symbol, base/quote size, limit_price,
 * stop_price reliably, but it can't tell you whether the user said
 * "GTC", "IOC", "FOK", "post-only", or asked for a "stop-limit"
 * specifically (the regex `order_type` is `market|limit` only).
 *
 * The QA-discovered failure shape: agent receives
 *   "place a limit buy 0.00037 BTC on Binance at 58500 GTC post-only"
 * and replies "Did you mean USDT or USDC instead of GTC?" — i.e., the
 * regex confidently extracted everything else, but the LLM that
 * formats the response misinterpreted the TIF token as a quote currency.
 *
 * Architecture (plan §Step 9, F7):
 *  1. Regex extractor runs first (cheap, deterministic).
 *  2. `assessRegexConfidence` looks for stop-limit / TIF / post-only /
 *     margin tokens in the source text that the regex alone cannot
 *     resolve. If present → call LLM.
 *  3. LLM (Haiku by default, configurable via CEX_LLM_EXTRACTOR_MODEL)
 *     returns a typed `AdkCreateOrderInput`. The merge prefers regex
 *     for order_id / sizes (regex has documented false-positive
 *     guards) and LLM for order_type / TIF / post_only / margin fields.
 *  4. Output is validated against `Adk*Input` zod schema so a
 *     hallucinated value can't reach the venue.
 *  5. 60s in-memory cache keyed by sha256(text + tool) bounds cost on
 *     duplicate submits / retries.
 *
 * This module is plugin-cex internal and never wired automatically;
 * the caller (parameterExtractor.ts) decides when to invoke it.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { elizaLogger, generateObject, ModelClass } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";
import type { AdkCreateOrderInput } from "./types";

// ---------------------------------------------------------------------------
// Confidence assessment — when do we even need the LLM?
// ---------------------------------------------------------------------------

const STOP_LIMIT_TOKENS = /\b(stop[-_\s]?limit|stop[-_\s]?loss\s+limit|止损限价)\b/i;
const TIF_TOKENS = /\b(?:IOC|FOK|GTC|GTD|post[\s-]?only|immediate[\s-]?or[\s-]?cancel|fill[\s-]?or[\s-]?kill|good[\s-]?til[\s-]?cancel(?:l?ed)?|good[\s-]?til[\s-]?date)\b/i;
const POST_ONLY_TOKENS = /\bpost[\s-]?only\b/i;
const MARGIN_TOKENS = /\b(?:margin|leverag(?:e|ed)|cross|isolated|borrow|repay|杠杆|全仓|逐仓)\b/i;

/**
 * Decide whether the regex extractor's output is good enough or the LLM
 * needs to take a swing. Returns a non-empty `reasons` array iff we
 * should invoke the LLM; returns `[]` when the regex alone is enough.
 *
 * The thresholds are intentionally conservative: we'd rather pay a
 * cheap Haiku call on a borderline case than ship the wrong order_type
 * to the venue.
 */
export function assessRegexConfidence(text: string): string[] {
    const reasons: string[] = [];
    if (STOP_LIMIT_TOKENS.test(text)) reasons.push("stop_limit_token");
    if (TIF_TOKENS.test(text) && !/\bGTC\b/i.test(text)) {
        // Plain "GTC" alone is the default and doesn't require LLM
        // disambiguation. Other TIFs (IOC / FOK / GTD / post-only) do.
        reasons.push("non_default_tif");
    }
    if (POST_ONLY_TOKENS.test(text)) reasons.push("post_only_token");
    if (MARGIN_TOKENS.test(text)) reasons.push("margin_token");
    return reasons;
}

// ---------------------------------------------------------------------------
// Schema for LLM output (zod-narrowed)
// ---------------------------------------------------------------------------

const llmCreateOrderSchema = z.object({
    order_type: z.enum(["market", "limit", "stop_limit", "trigger_bracket"]).optional(),
    time_in_force: z.enum(["GTC", "GTD", "IOC", "FOK"]).optional(),
    end_time: z.string().optional(),
    post_only: z.boolean().optional(),
    margin_type: z.enum(["CROSS", "ISOLATED"]).optional(),
    margin_action: z.enum(["NORMAL", "AUTO_BORROW", "AUTO_REPAY"]).optional(),
    // The LLM is instructed to emit `"2"` etc. but routinely emits raw
    // numbers (`20`). Accept both shapes and coerce so downstream
    // consumers (canonical intent, leverageCap rule, approval modal)
    // always see a string. Without this coercion zod was silently
    // stripping the field and `leverageCap` saw undefined, allowing
    // 20x cross-margin orders through (staging 2026-05-26 incident).
    leverage: z
        .union([z.string(), z.number()])
        .optional()
        .transform((v) => (v === undefined || v === null ? undefined : String(v))),
});

type LlmFields = z.infer<typeof llmCreateOrderSchema>;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `
You are a deterministic parameter extractor for a centralized exchange
trading workflow. Given a single user message, extract ONLY the
following advanced order parameters as JSON:

  - order_type: "market" | "limit" | "stop_limit"
  - time_in_force: "GTC" | "GTD" | "IOC" | "FOK"  (optional)
  - end_time: ISO-8601 timestamp  (REQUIRED when time_in_force === "GTD")
  - post_only: boolean  (only valid when order_type === "limit")
  - margin_type: "CROSS" | "ISOLATED"  (optional)
  - margin_action: "NORMAL" | "AUTO_BORROW" | "AUTO_REPAY"  (optional)
  - leverage: numeric string, e.g. "2", "5"  (only with margin)

## Critical rules

1. Output ONLY the JSON, no surrounding text or markdown fences.
2. Omit fields you cannot confidently extract — do NOT guess.
3. "GTC" is the default; emit it only if the user said it explicitly OR
   a non-default TIF was mentioned somewhere (so the caller knows GTC
   was chosen vs default).
4. "post-only", "post only", and "po" all map to post_only: true.
5. "stop-limit", "stop limit", "stop_limit", "止损限价" all map to
   order_type: "stop_limit".
6. "IOC" / "immediate or cancel" → "IOC". "FOK" / "fill or kill" → "FOK".
7. "GTD" / "good til date" requires end_time. If no end_time can be
   parsed, OMIT time_in_force rather than emitting "GTD" without it.
8. Margin keywords ("cross", "isolated", "leverage", "borrow", "repay",
   "杠杆", "全仓", "逐仓") gate margin fields. Spot orders omit them.

## Examples

Input: "place a stop-limit BTC sell at stop 70000 limit 69500 IOC"
Output: {"order_type":"stop_limit","time_in_force":"IOC"}

Input: "buy 0.001 BTC at 60000 GTC post-only"
Output: {"order_type":"limit","time_in_force":"GTC","post_only":true}

Input: "open 0.001 BTC CROSS margin long at 60000 limit GTC 2x leverage on Binance"
Output: {"order_type":"limit","time_in_force":"GTC","margin_type":"CROSS","margin_action":"AUTO_BORROW","leverage":"2"}

Input: "buy 0.01 ETH at 4500"
Output: {"order_type":"limit"}

Input: "sell 0.01 ETH at market"
Output: {"order_type":"market"}
`.trim();

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
    expiresAt: number;
    value: LlmFields;
}

const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 1_000;

function cacheGet(key: string): LlmFields | null {
    const e = CACHE.get(key);
    if (!e) return null;
    if (Date.now() > e.expiresAt) {
        CACHE.delete(key);
        return null;
    }
    return e.value;
}

function cacheSet(key: string, value: LlmFields): void {
    if (CACHE.size >= CACHE_MAX) {
        const firstKey = CACHE.keys().next().value;
        if (firstKey) CACHE.delete(firstKey);
    }
    CACHE.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function cacheKey(tool: string, text: string): string {
    return createHash("sha256").update(`${tool}${text}`).digest("hex");
}

// ---------------------------------------------------------------------------
// LLM invocation
// ---------------------------------------------------------------------------

/**
 * Run the LLM extractor for create_order. Returns the parsed,
 * zod-validated subset of fields the LLM was able to extract. On any
 * error (network, model output that fails parse, etc.) returns `null`
 * — the caller falls back to the regex-only extraction.
 *
 * `model` defaults to env `CEX_LLM_EXTRACTOR_MODEL` or `claude-haiku-4-5`.
 */
export async function llmExtractCreateOrderFields(
    runtime: IAgentRuntime,
    text: string,
): Promise<LlmFields | null> {
    const key = cacheKey("create_order", text);
    const cached = cacheGet(key);
    if (cached) {
        elizaLogger.debug(`[plugin-cex F7] llmExtractCreateOrder cache hit (${Object.keys(cached).length} fields)`);
        return cached;
    }

    const prompt = `## User message\n${text}\n\nReturn ONLY a JSON object per the rules above.`;
    try {
        const t0 = Date.now();
        const obj = await generateObject({
            runtime,
            context: `${SYSTEM_PROMPT}\n\n${prompt}`,
            modelClass: ModelClass.SMALL,
            schema: llmCreateOrderSchema,
            schemaName: "F7AdvancedOrderFields",
            schemaDescription:
                "Advanced create_order fields (order_type, TIF, post_only, margin) extracted by the F7 LLM extractor.",
        });
        const parsed = llmCreateOrderSchema.safeParse(obj.object);
        if (!parsed.success) {
            elizaLogger.warn(`[plugin-cex F7] llmExtractCreateOrder rejected by zod: ${parsed.error.message}`);
            return null;
        }
        const value = parsed.data;
        cacheSet(key, value);
        elizaLogger.info(
            `[plugin-cex F7] llmExtractCreateOrder ok (latency_ms=${Date.now() - t0}, fields=${Object.keys(value).join(",") || "(none)"})`,
        );
        return value;
    } catch (err) {
        elizaLogger.warn(
            `[plugin-cex F7] llmExtractCreateOrder failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
    }
}

// ---------------------------------------------------------------------------
// Merge — regex result + LLM result → final Adk input
// ---------------------------------------------------------------------------

/**
 * Merge regex-extracted base shape with LLM-extracted advanced fields.
 * Regex wins on order_id, sizes, prices, symbol, side; LLM wins on
 * order_type, time_in_force, post_only, and margin context. Returns a
 * shallow-merged `AdkCreateOrderInput` with extras from the LLM
 * preserved as additional fields (consumer is `createOrder` action
 * mapper).
 */
export function mergeCreateOrderExtraction(
    regexBase: AdkCreateOrderInput,
    llm: LlmFields | null,
): AdkCreateOrderInput {
    if (!llm) return regexBase;
    // Work in an open record shape so we can stash margin fields the
    // ADK type doesn't formally know about (they're carried through to
    // CanonicalIntent via `extractedInput`).
    const merged: Record<string, unknown> = { ...regexBase };
    // LLM authority: order_type when present.
    if (llm.order_type) {
        merged.order_type = llm.order_type;
    }
    if (llm.time_in_force) merged.time_in_force = llm.time_in_force;
    if (llm.end_time) merged.end_time = llm.end_time;
    if (typeof llm.post_only === "boolean") merged.post_only = llm.post_only;
    if (llm.margin_type) merged.margin_type = llm.margin_type;
    if (llm.margin_action) merged.margin_action = llm.margin_action;
    if (llm.leverage) merged.leverage = llm.leverage;
    return merged as unknown as AdkCreateOrderInput;
}
